import { findingsFor, type Finding } from "./analyze/fixes.ts";
import { staticWarnings, type Warning } from "./analyze/rules.ts";
import { loadConfig, type ToolConfig } from "./config/config.ts";
import { DISCLAIMER_FULL } from "./core/disclaimer.ts";
import { SetupProblem, ToolError } from "./core/errors.ts";
import { type CheckResult, summarize, type Summary } from "./core/results.ts";
import { type Catalog, discoverCatalog } from "./discover/catalog.ts";
import { buildTenancyModel, isBaseTable, type TableTenancy, type TenancyModel } from "./discover/tenancy.ts";
import type { ProbeContext } from "./probe/common.ts";
import { ApiClient } from "./probe/http.ts";
import { clientCallable, probeFunction } from "./probe/rpc.ts";
import { probeBucket } from "./probe/storage.ts";
import { type PositiveControl, probeTable, probeView } from "./probe/tables.ts";
import { type BucketSeed, seedFiles } from "./seed/files.ts";
import { seedRows, type SeedResult } from "./seed/rows.ts";
import { createTestUser } from "./seed/users.ts";
import { World } from "./seed/world.ts";
import { Database } from "./stack/db.ts";
import { prepareSandbox, type Sandbox } from "./stack/sandbox.ts";
import { StackManager, type StackCredentials } from "./stack/supabase.ts";

export interface RunOptions {
  projectDir: string;
  workdir: string;
  configPath?: string;
  keepRunning: boolean;
  toolVersion: string;
  log?: (line: string) => void;
  stack?: StackManager;
}

export interface SeedingSummary {
  tables: { table: string; rows: number; failure?: string; notes: string[] }[];
  buckets: { bucket: string; files: number; failure?: string }[];
  notes: string[];
}

/** Everything one run found. Reports (JSON, Markdown, HTML, CLI) are all rendered from this object. */
export interface RunResult {
  tool: { name: "tenant-leak-check"; version: string };
  disclaimer: string;
  generatedAt: string;
  target: { name: string; projectDir: string; migrations: string[]; fingerprint: string; postgresVersion?: string };
  scope: {
    schemas: string[];
    tables: string[];
    views: string[];
    functions: string[];
    buckets: string[];
    extensionObjects: string[];
    notes: string[];
  };
  tenancy: {
    tenantRoot?: string;
    membership?: { table: string; userColumn: string; tenantColumn: string };
    tables: TableTenancy[];
    notes: string[];
  };
  seeding: SeedingSummary;
  checks: CheckResult[];
  findings: Finding[];
  warnings: Warning[];
  positiveControls: PositiveControl[];
  summary: Summary;
}

export const READY_TIMEOUT_MS = 90_000;

/** Waits until the REST, Auth and Storage APIs answer, since they restart after a database reset. */
export async function waitForServices(api: ApiClient, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probes = [
    { path: "/rest/v1/", caller: { kind: "anon" as const } },
    { path: "/auth/v1/health", caller: { kind: "anon" as const } },
    { path: "/storage/v1/bucket", caller: { kind: "service" as const } },
  ];
  for (const probe of probes) {
    for (;;) {
      const response = await api.send({ method: "GET", path: probe.path, caller: probe.caller });
      if (!response.networkError && response.status < 500) break;
      if (Date.now() > deadline) {
        throw new ToolError(
          `The local ${probe.path.split("/")[1]} service did not become ready within ${timeoutMs / 1000} seconds.`,
          "Check the containers with docker ps, then run the check again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function tenancyView(tenancy: TenancyModel): RunResult["tenancy"] {
  const view: RunResult["tenancy"] = { tables: [...tenancy.tables.values()], notes: tenancy.notes };
  if (tenancy.tenantRoot) view.tenantRoot = tenancy.tenantRoot.table;
  if (tenancy.membership) {
    const { table, userColumn, tenantColumn } = tenancy.membership;
    view.membership = { table, userColumn, tenantColumn };
  }
  return view;
}

function seedingView(seed: SeedResult | undefined, files: BucketSeed[]): SeedingSummary {
  const tables = [...(seed?.tables.values() ?? [])].map((t) => {
    const entry: SeedingSummary["tables"][number] = { table: t.table, rows: t.rows.length, notes: t.notes };
    if (t.failure) entry.failure = t.failure;
    return entry;
  });
  const buckets = files.map((f) => {
    const entry: SeedingSummary["buckets"][number] = { bucket: f.bucket.id, files: f.canaries.length };
    if (f.failure) entry.failure = f.failure;
    return entry;
  });
  return { tables, buckets, notes: seed?.notes ?? [] };
}

interface Probed {
  checks: CheckResult[];
  controls: PositiveControl[];
}

async function probeEverything(ctx: ProbeContext, files: readonly BucketSeed[], log: (line: string) => void): Promise<Probed> {
  const checks: CheckResult[] = [];
  const controls: PositiveControl[] = [];
  const tables = ctx.catalog.relations.filter(isBaseTable);
  const views = ctx.catalog.relations.filter((r) => r.kind === "view" || r.kind === "materialized_view");
  log(`Probing ${tables.length} tables and ${views.length} views as tenant A and as an anonymous visitor.`);
  for (const relation of tables) {
    const result = await probeTable(ctx, relation);
    checks.push(...result.checks);
    if (result.control) controls.push(result.control);
  }
  for (const relation of views) checks.push(...(await probeView(ctx, relation)).checks);
  if (files.length > 0) log(`Probing ${files.length} storage bucket${files.length === 1 ? "" : "s"}.`);
  for (const bucket of files) checks.push(...(await probeBucket(ctx, bucket)));
  const functions = clientCallable(ctx.catalog.functions);
  if (functions.length > 0) log(`Calling ${functions.length} database function${functions.length === 1 ? "" : "s"} (RPCs).`);
  for (const fn of functions) checks.push(...(await probeFunction(ctx, fn)));
  return { checks, controls };
}

/** Problems that make the whole run unreliable (DESIGN.md section 7.2, positive control). */
export function runLevelProblems(tenancy: TenancyModel, controls: readonly PositiveControl[]): string[] {
  const problems: string[] = [];
  const owned = [...tenancy.tables.values()].filter((t) => ["tenant", "user", "inherited", "tenant_root"].includes(t.ownership.kind));
  if (owned.length === 0) {
    problems.push("No table could be linked to a tenant or a user, so there was no customer data to test isolation on.");
  } else if (controls.length > 0 && !controls.some((c) => c.ownRowVisible)) {
    problems.push(
      "The signed-in test user could not read its own rows in any table, so the setup is probably wrong (for example, membership is stored somewhere the tool did not detect). Check the tenancy model and set it in the config.",
    );
  }
  return problems;
}

async function setRoleTimeouts(db: Database): Promise<void> {
  await db.query("alter role anon set statement_timeout = '5s'");
  await db.query("alter role authenticated set statement_timeout = '5s'");
}

function baseResult(toolVersion: string, sandbox: Sandbox, catalog: Catalog): Omit<RunResult, "tenancy" | "seeding" | "checks" | "findings" | "warnings" | "positiveControls" | "summary"> {
  const target: RunResult["target"] = {
    name: sandbox.projectDir.split("/").filter(Boolean).pop() ?? sandbox.slug,
    projectDir: sandbox.projectDir,
    migrations: sandbox.migrations,
    fingerprint: sandbox.fingerprint,
  };
  target.postgresVersion = catalog.postgresVersion;
  return {
    tool: { name: "tenant-leak-check", version: toolVersion },
    disclaimer: DISCLAIMER_FULL,
    generatedAt: new Date().toISOString(),
    target,
    scope: {
      schemas: catalog.schemas,
      tables: catalog.relations.filter(isBaseTable).map((r) => r.qualified),
      views: catalog.relations.filter((r) => r.kind === "view" || r.kind === "materialized_view").map((r) => r.qualified),
      functions: clientCallable(catalog.functions).map((fn) => fn.qualified),
      buckets: catalog.buckets.map((b) => b.id),
      extensionObjects: catalog.extensionObjects,
      notes: sandbox.settings.notes,
    },
  };
}

/** One run's result plus the catalog it was based on (migration mode compares the catalogs). */
export interface SandboxCheck {
  result: RunResult;
  catalog: Catalog;
}

export interface SandboxCheckOptions {
  config: ToolConfig;
  toolVersion: string;
  log: (line: string) => void;
}

/**
 * Checks a sandbox whose stack was just made fresh (StackManager.ensureFresh): discovery,
 * seeding, probes and analysis. Leaves the stack running with the seeded data in place.
 */
export async function checkSandbox(sandbox: Sandbox, credentials: StackCredentials, options: SandboxCheckOptions): Promise<SandboxCheck> {
  const { config, log } = options;
  const api = new ApiClient(credentials);
  await waitForServices(api);
  const db = await Database.connect(credentials.dbUrl);
  try {
    await setRoleTimeouts(db);
    log("Reading the database catalog.");
    const catalog = await discoverCatalog(db, sandbox.settings.schemas);
    const tenancy = buildTenancyModel(catalog, config);
    const warnings = staticWarnings(catalog, tenancy, config);
    const base = baseResult(options.toolVersion, sandbox, catalog);
    log("Creating two synthetic tenants with test users, rows and files.");
    let users;
    try {
      users = { A: await createTestUser(api, "A"), B: await createTestUser(api, "B") };
    } catch (error) {
      if (!(error instanceof SetupProblem)) throw error;
      const problem = `${error.message}${error.hint ? ` ${error.hint}` : ""}`;
      const result: RunResult = {
        ...base,
        tenancy: tenancyView(tenancy),
        seeding: seedingView(undefined, []),
        checks: [],
        findings: [],
        warnings,
        positiveControls: [],
        summary: summarize([], [problem]),
      };
      return { result, catalog };
    }
    const seed = await seedRows(db, catalog, tenancy, config, users);
    const files = await seedFiles(api, catalog.buckets, seed.tenants, tenancy.tenantRoot !== undefined || [...tenancy.tables.values()].some((t) => t.ownership.kind === "tenant"), config);
    const world = new World(
      db,
      catalog.relations.filter((r) => isBaseTable(r) && seed.tables.has(r.qualified)),
    );
    await world.captureBaseline();
    const ctx: ProbeContext = { db, api, catalog, tenancy, config, seed, world, userA: users.A };
    const { checks, controls } = await probeEverything(ctx, files, log);
    const problems = [...runLevelProblems(tenancy, controls)];
    const result: RunResult = {
      ...base,
      tenancy: tenancyView(tenancy),
      seeding: seedingView(seed, files),
      checks,
      findings: findingsFor(checks, catalog, tenancy),
      warnings,
      positiveControls: controls,
      summary: summarize(checks, problems),
    };
    return { result, catalog };
  } finally {
    await db.close().catch(() => {});
  }
}

/** Stops the sandbox stack unless the user asked to keep it, and never lets a failed stop hide the real result. */
export async function stopUnlessKept(stack: StackManager, sandbox: Sandbox, keepRunning: boolean, log: (line: string) => void): Promise<void> {
  if (keepRunning) return;
  log("Stopping the local stack.");
  await stack.stop(sandbox).catch((error: unknown) => log(`Could not stop the local stack: ${(error as Error).message}`));
}

/** Runs one full check: sandbox, stack, discovery, seeding, probes, analysis (DESIGN.md section 4). */
export async function runCheck(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const config: ToolConfig = await loadConfig(options.projectDir, options.configPath);
  const sandbox = await prepareSandbox({ projectDir: options.projectDir, workdir: options.workdir });
  const stack = options.stack ?? new StackManager({ log });
  log(`Building a local copy of ${sandbox.projectDir} from ${sandbox.migrations.length} migration file${sandbox.migrations.length === 1 ? "" : "s"}.`);
  const credentials = await stack.ensureFresh(sandbox);
  try {
    return (await checkSandbox(sandbox, credentials, { config, toolVersion: options.toolVersion, log })).result;
  } finally {
    await stopUnlessKept(stack, sandbox, options.keepRunning, log);
  }
}
