import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadConfig } from "../config/config.ts";
import { MigrationsFailed, ToolError } from "../core/errors.ts";
import { combineExitCodes, EXIT, type ExitCode } from "../core/exit-codes.ts";
import { type CheckResult, summarize, type Summary, type Verdict } from "../core/results.ts";
import { checkSandbox, type RunResult, type SandboxCheck, stopUnlessKept } from "../engine.ts";
import { prepareSandbox, type Sandbox } from "../stack/sandbox.ts";
import { StackManager } from "../stack/supabase.ts";
import { type CatalogChange, type CatalogChangeKind, diffCatalogs } from "./catalog-diff.ts";
import { diffResults, type ResultDiff } from "./result-diff.ts";
import { type MigrationFile, needsReview, scanMigrations, type StatementFinding, type StatementRule } from "./scan.ts";

export interface DiffOptions {
  projectDir: string;
  /** Paths of the new migration files, in any order (they are applied in file-name order). */
  migrations: readonly string[];
  workdir: string;
  configPath?: string;
  keepRunning: boolean;
  toolVersion: string;
  log?: (line: string) => void;
  stack?: StackManager;
}

export interface ApplyOutcome {
  ok: boolean;
  /** The redacted Postgres or CLI error when the migration could not be applied. */
  error?: string;
}

/** What a review item is about. Several statements or changes with the same topic are counted together in the headline. */
export type ReviewTopic =
  | "deletes_table"
  | "deletes_column"
  | "empties_table"
  | "rewrites_table"
  | "changes_column_type"
  | "deletes_view"
  | "deletes_function"
  | "deletes_schema"
  | "deletes_trigger"
  | "deletes_bucket"
  | "removes_policy"
  | "disables_rls"
  | "stops_forcing_rls"
  | "policy_matches_everything"
  | "grants_anonymous_access"
  | "view_skips_rls"
  | "makes_bucket_public"
  | "adds_unprotected_table"
  | "fails_on_existing_data"
  | "fails_to_apply";

/** One reason a person has to review the migration before it ships (exit code 4). */
export interface ReviewItem {
  topic: ReviewTopic;
  source: "statement" | "catalog" | "apply";
  message: string;
  file?: string;
  line?: number;
}

export interface MigrationReport {
  /** Base names of the new migration files, in the order they were applied. */
  files: string[];
  /** The project's own migrations that made up the "before" database. */
  baseline: string[];
  apply: { onSeededData: ApplyOutcome; onFreshDatabase: ApplyOutcome };
  statements: StatementFinding[];
  catalogChanges: CatalogChange[];
  results: ResultDiff;
  review: ReviewItem[];
  /** One plain-English paragraph that sums up the migration, for the top of every report. */
  headline: string;
  before: { summary: Summary; checks: CheckResult[] };
}

/** The "after" run, plus everything migration mode found. Its summary already includes the review outcome. */
export interface DiffResult extends RunResult {
  migration: MigrationReport;
}

const STATEMENT_TOPIC: Readonly<Partial<Record<StatementRule, ReviewTopic>>> = {
  drop_table: "deletes_table",
  drop_view: "deletes_view",
  drop_function: "deletes_function",
  drop_policy: "removes_policy",
  drop_schema: "deletes_schema",
  drop_trigger: "deletes_trigger",
  truncate: "empties_table",
  drop_column: "deletes_column",
  alter_column_type: "changes_column_type",
  delete_without_where: "empties_table",
  update_without_where: "rewrites_table",
  disable_rls: "disables_rls",
  no_force_rls: "stops_forcing_rls",
  grant_to_clients: "grants_anonymous_access",
  policy_always_true: "policy_matches_everything",
};

const CATALOG_TOPIC: Readonly<Partial<Record<CatalogChangeKind, ReviewTopic>>> = {
  relation_removed: "deletes_table",
  relation_added: "adds_unprotected_table",
  column_removed: "deletes_column",
  column_type_changed: "changes_column_type",
  rls_disabled: "disables_rls",
  rls_no_longer_forced: "stops_forcing_rls",
  policy_removed: "removes_policy",
  view_security_invoker_removed: "view_skips_rls",
  bucket_removed: "deletes_bucket",
  bucket_added: "makes_bucket_public",
  bucket_made_public: "makes_bucket_public",
};

/** Headline phrases: [singular, plural] with `#` standing for the count. */
const TOPIC_PHRASE: Readonly<Record<ReviewTopic, readonly [string, string]>> = {
  deletes_table: ["deletes a table", "deletes # tables"],
  deletes_column: ["deletes a column", "deletes # columns"],
  empties_table: ["deletes every row of a table", "deletes every row of # tables"],
  rewrites_table: ["changes every row of a table", "changes every row of # tables"],
  changes_column_type: ["changes the type of a column", "changes the type of # columns"],
  deletes_view: ["deletes a view", "deletes # views"],
  deletes_function: ["deletes a function", "deletes # functions"],
  deletes_schema: ["deletes a schema", "deletes # schemas"],
  deletes_trigger: ["deletes a trigger", "deletes # triggers"],
  deletes_bucket: ["deletes a storage bucket", "deletes # storage buckets"],
  removes_policy: ["removes an access rule (policy)", "removes # access rules (policies)"],
  disables_rls: ["switches row level security off on a table", "switches row level security off on # tables"],
  stops_forcing_rls: ["stops forcing row level security on a table", "stops forcing row level security on # tables"],
  policy_matches_everything: ["adds an access rule that matches every row", "adds # access rules that match every row"],
  grants_anonymous_access: ["gives visitors who are not signed in new rights", "gives visitors who are not signed in new rights # times"],
  view_skips_rls: ["makes a view skip row level security", "makes # views skip row level security"],
  makes_bucket_public: ["makes a storage bucket public", "makes # storage buckets public"],
  adds_unprotected_table: ["adds a table without row level security", "adds # tables without row level security"],
  fails_on_existing_data: ["fails on a database that already holds data", "fails on a database that already holds data"],
  fails_to_apply: ["cannot be applied at all", "cannot be applied at all"],
};

/** The scan rule a catalog change corresponds to, so the same fact is not listed twice for review. */
const SAME_FACT: Readonly<Partial<Record<CatalogChangeKind, readonly StatementRule[]>>> = {
  relation_removed: ["drop_table", "drop_view"],
  column_removed: ["drop_column"],
  column_type_changed: ["alter_column_type"],
  rls_disabled: ["disable_rls"],
  rls_no_longer_forced: ["no_force_rls"],
  policy_removed: ["drop_policy"],
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/** Everything a person must look at before the migration ships, without listing the same fact twice. */
export function reviewItems(statements: readonly StatementFinding[], changes: readonly CatalogChange[], apply: MigrationReport["apply"]): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const finding of statements) {
    const topic = STATEMENT_TOPIC[finding.rule];
    if (!topic || !needsReview(finding.severity)) continue;
    items.push({ topic, source: "statement", message: finding.message, file: finding.file, line: finding.line });
  }
  for (const change of changes) {
    const topic = CATALOG_TOPIC[change.kind];
    if (!topic || !needsReview(change.severity)) continue;
    const rules = SAME_FACT[change.kind] ?? [];
    const alreadyListed = statements.some((s) => rules.includes(s.rule) && needsReview(s.severity) && s.object === change.object);
    if (!alreadyListed) items.push({ topic, source: "catalog", message: change.message });
  }
  if (!apply.onFreshDatabase.ok) {
    items.push({ topic: "fails_to_apply", source: "apply", message: `The migration could not be applied, even to an empty database, so the database after the migration could not be tested: ${apply.onFreshDatabase.error ?? "unknown error"}` });
  } else if (!apply.onSeededData.ok) {
    items.push({
      topic: "fails_on_existing_data",
      source: "apply",
      message: `The migration works on an empty database but failed on one that already holds data, as a live database does: ${apply.onSeededData.error ?? "unknown error"}`,
    });
  }
  return items;
}

/** The summary paragraph at the top of every migration report (DESIGN.md section 9, step 7). */
export function migrationHeadline(results: ResultDiff, review: readonly ReviewItem[], after: Summary): string {
  const sentences: string[] = [];
  const failedToApply = review.some((item) => item.topic === "fails_to_apply");
  if (failedToApply) {
    sentences.push("This migration could not be applied, so its effect on tenant isolation could not be tested.");
  } else if (results.newLeaks.length > 0) {
    sentences.push(`This migration introduces ${plural(results.newLeaks.length, "new leak")}.`);
  } else {
    sentences.push("This migration introduces no new leaks.");
  }
  if (results.fixedLeaks.length > 0) sentences.push(`It fixes ${plural(results.fixedLeaks.length, "leak")} that existed before.`);
  if (results.stillLeaking.length > 0) sentences.push(`${plural(results.stillLeaking.length, "leak")} from before ${results.stillLeaking.length === 1 ? "is" : "are"} still there.`);
  const counts = new Map<ReviewTopic, number>();
  for (const item of review) if (item.topic !== "fails_to_apply") counts.set(item.topic, (counts.get(item.topic) ?? 0) + 1);
  if (counts.size > 0) {
    const phrases = [...counts].map(([topic, count]) => {
      const [one, many] = TOPIC_PHRASE[topic];
      return count === 1 ? one : many.replace("#", String(count));
    });
    sentences.push(`It needs a human review before it ships: it ${joinPhrases(phrases)}.`);
  } else if (!failedToApply) {
    sentences.push("Nothing in it needs a human review.");
  }
  if (!failedToApply && after.verdict === "inconclusive") {
    sentences.push("Some checks after the migration could not be completed, so the result is not clean.");
  }
  if (results.noLongerTested.length > 0) {
    sentences.push(`${plural(results.noLongerTested.length, "check")} that ran before the migration could not be completed after it.`);
  }
  return sentences.join(" ");
}

/** Applies the exit-code rules of DESIGN.md section 8 to migration mode. */
export function diffSummary(after: Summary, review: readonly ReviewItem[]): Summary {
  const exitCode: ExitCode = combineExitCodes([after.exitCode, review.length > 0 ? EXIT.migrationReview : EXIT.clean]);
  const verdicts: Record<number, Verdict> = {
    [EXIT.leaks]: "leaks_found",
    [EXIT.migrationReview]: "review_needed",
    [EXIT.inconclusive]: "inconclusive",
    [EXIT.clean]: "clean",
  };
  return { ...after, exitCode, verdict: verdicts[exitCode] ?? after.verdict };
}

const MIGRATION_NAME = /^\d+_.*\.sql$/;

/** Reads and checks the new migration files given with --migration. */
export async function readMigrationFiles(paths: readonly string[]): Promise<(MigrationFile & { path: string })[]> {
  if (paths.length === 0) {
    throw new ToolError("Missing --migration.", "Give the new migration file to test, for example: tenant-leak-check diff --project ../my-app --migration ../my-app/supabase/migrations/20261101000000_add_reports.sql");
  }
  const files: (MigrationFile & { path: string })[] = [];
  for (const given of paths) {
    const path = resolve(given);
    const name = basename(path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new ToolError(`The migration file ${path} does not exist.`, "Check the path given with --migration.");
    }
    if (!MIGRATION_NAME.test(name)) {
      throw new ToolError(
        `The migration ${name} is not named like a Supabase migration.`,
        "Migration files must be named <timestamp>_<name>.sql, for example 20261031120000_add_reports.sql.",
      );
    }
    if (files.some((file) => file.name === name)) throw new ToolError(`The migration ${name} was given twice.`);
    files.push({ name, path, sql: await readFile(path, "utf8") });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** The CLI applies migrations in file-name order, so new ones must come after every existing one. */
export function assertAppliedLast(baseline: readonly string[], added: readonly string[]): void {
  const last = [...baseline].sort().at(-1);
  if (last === undefined) return;
  const early = added.filter((name) => name <= last);
  if (early.length > 0) {
    throw new ToolError(
      `The migration ${early.join(", ")} would run before ${last}, which is already part of the project.`,
      "Migration mode tests new migrations on top of the existing ones, so their timestamps must be later than every existing migration. Rename the file with a later timestamp.",
    );
  }
}

function untestedAfter(before: RunResult, sandbox: Sandbox, error: string): RunResult {
  const problem = `The new migration could not be applied, so the database after the migration could not be tested. The error was: ${error}`;
  return {
    ...before,
    generatedAt: new Date().toISOString(),
    target: { ...before.target, migrations: sandbox.migrations, fingerprint: sandbox.fingerprint },
    scope: { ...before.scope, tables: [], views: [], functions: [], buckets: [], extensionObjects: [] },
    tenancy: { tables: [], notes: [] },
    seeding: { tables: [], buckets: [], notes: [] },
    checks: [],
    findings: [],
    warnings: [],
    positiveControls: [],
    summary: summarize([], [problem]),
  };
}

/** Builds the migration report from the two runs. Exported for unit tests; runDiff is the entry point. */
export function assembleDiff(input: {
  files: readonly MigrationFile[];
  baseline: Sandbox;
  afterSandbox: Sandbox;
  before: SandboxCheck;
  after: SandboxCheck | undefined;
  apply: MigrationReport["apply"];
}): DiffResult {
  const { before, after, apply } = input;
  const statements = scanMigrations(input.files);
  const catalogChanges = after ? diffCatalogs(before.catalog, after.catalog) : [];
  const afterResult = after?.result ?? untestedAfter(before.result, input.afterSandbox, apply.onFreshDatabase.error ?? "unknown error");
  // Without an "after" run there is nothing to compare: every check would look removed.
  const results = after ? diffResults(before.result.checks, after.result.checks) : diffResults([], []);
  const review = reviewItems(statements, catalogChanges, apply);
  const migration: MigrationReport = {
    files: input.files.map((file) => file.name),
    baseline: input.baseline.migrations,
    apply,
    statements,
    catalogChanges,
    results,
    review,
    headline: migrationHeadline(results, review, afterResult.summary),
    before: { summary: before.result.summary, checks: before.result.checks },
  };
  return { ...afterResult, summary: diffSummary(afterResult.summary, review), migration };
}

/**
 * Migration mode (DESIGN.md section 9): test the project without the new migrations, apply them
 * on top of the seeded data, then test again on a fresh database and compare.
 */
export async function runDiff(options: DiffOptions): Promise<DiffResult> {
  const log = options.log ?? (() => {});
  const config = await loadConfig(options.projectDir, options.configPath);
  const files = await readMigrationFiles(options.migrations);
  const names = files.map((file) => file.name);
  const baseline = await prepareSandbox({
    projectDir: options.projectDir,
    workdir: options.workdir,
    excludeMigrations: names,
    buildFiles: config.build.files,
  });
  assertAppliedLast(baseline.migrations, names);
  const stack = options.stack ?? new StackManager({ log });
  const shared = { config, toolVersion: options.toolVersion, log };
  log(`Step 1 of 3: testing ${baseline.projectDir} before the migration (${plural(baseline.migrations.length, "existing migration file")}).`);
  const credentials = await stack.ensureFresh(baseline);
  let running = true;
  let current: Sandbox = baseline;
  try {
    const before = await checkSandbox(baseline, credentials, shared);
    const afterSandbox = await prepareSandbox({
      projectDir: options.projectDir,
      workdir: options.workdir,
      excludeMigrations: names,
      extraMigrations: files.map((file) => file.path),
      buildFiles: config.build.files,
    });
    current = afterSandbox;
    log(`Step 2 of 3: applying ${names.join(", ")} on top of the test data.`);
    const seeded = await stack.migrationUp(afterSandbox);
    const onSeededData: ApplyOutcome = seeded.ok ? { ok: true } : { ok: false, error: seeded.detail };
    if (!seeded.ok) log("The migration failed on a database that holds data; trying it on a fresh database next.");
    log("Step 3 of 3: testing the project after the migration, on a fresh database.");
    let after: SandboxCheck | undefined;
    let onFreshDatabase: ApplyOutcome = { ok: true };
    try {
      after = await checkSandbox(afterSandbox, await stack.ensureFresh(afterSandbox), shared);
    } catch (error) {
      if (!(error instanceof MigrationsFailed)) throw error;
      running = false;
      onFreshDatabase = { ok: false, error: error.detail };
    }
    return assembleDiff({ files, baseline, afterSandbox, before, after, apply: { onSeededData, onFreshDatabase } });
  } finally {
    if (running) await stopUnlessKept(stack, current, options.keepRunning, log);
  }
}
