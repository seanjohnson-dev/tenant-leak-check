import { DISCLAIMER_FULL } from "../../src/core/disclaimer.ts";
import { type CheckResult, inconclusive, leaked, notTested, passed, summarize } from "../../src/core/results.ts";
import type { RunResult } from "../../src/engine.ts";
import { assembleDiff, type DiffResult } from "../../src/migrate/diff.ts";
import type { Sandbox } from "../../src/stack/sandbox.ts";
import { agencyCatalog } from "./fixtures.ts";

/** A small but complete run result, with one of every status, for the report tests. */

const spec = (kind: CheckResult["kind"], target: string, operation: string, actor: CheckResult["actor"] = "tenant_a") => ({ kind, target, operation, actor });

export const HOSTILE = `<script>alert("x")</script> | **bold** [link](http://evil.example)`;

export function sampleChecks(): CheckResult[] {
  return [
    leaked(spec("table", "public.invoices", "select"), {
      actor: "tenant_a",
      requests: [{ method: "GET", path: "/rest/v1/invoices?select=*&id=eq.b-1", status: 200, response: '[{"id":"b-1","number":"tlc-B-invoices-1"}]' }],
      before: "public.invoices row (id=b-1) belongs to tenant B and exists.",
      after: 'The response contained tenant B\'s data: {"id":"b-1"}',
      summary: "Tenant A read tenant B's data from public.invoices.",
    }),
    passed(spec("table", "public.invoices", "insert"), {
      actor: "tenant_a",
      requests: [{ method: "POST", path: "/rest/v1/invoices", body: { org_id: "org-b", number: HOSTILE }, status: 403, response: "new row violates row-level security policy" }],
      summary: "Blocked.",
    }),
    passed(spec("table", "public.invoices", "select", "anon"), undefined, ["blocked by permissions"]),
    notTested(spec("table", "public.plans", "select"), "not_applicable", "This table does not belong to any customer, so there is nothing private to read"),
    notTested(spec("table", "public.notes", "update"), "could_not_test", `could not create test data because: ${HOSTILE}`),
    notTested(spec("table", "public.audit", "select"), "excluded", "Excluded in config: written only by triggers."),
    inconclusive(spec("storage", "documents", "download"), "The storage API answered with a server error (500)."),
    passed(spec("rpc", "public.get_org_invoices", "execute", "anon"), {
      actor: "anon",
      requests: [{ method: "POST", path: "/rest/v1/rpc/get_org_invoices", body: { p_org_id: "org-b" }, status: 401, response: "permission denied" }],
      summary: "Blocked.",
    }),
  ];
}

export function sampleRun(checks: CheckResult[] = sampleChecks()): RunResult {
  return {
    tool: { name: "tenant-leak-check", version: "0.1.0" },
    disclaimer: DISCLAIMER_FULL,
    generatedAt: "2026-10-31T19:48:00.000Z",
    target: { name: "agency", projectDir: "/work/agency", migrations: ["20261031000001_schema.sql"], fingerprint: "a".repeat(64), postgresVersion: "17.6" },
    scope: { schemas: ["public"], tables: ["public.invoices", "public.notes", "public.plans"], views: [], functions: ["public.get_org_invoices"], buckets: ["documents"], extensionObjects: [], notes: [] },
    tenancy: {
      tenantRoot: "public.organizations",
      membership: { table: "public.org_members", userColumn: "user_id", tenantColumn: "org_id" },
      tables: [{ table: "public.invoices", ownership: { kind: "tenant", tenantColumn: "org_id", userColumns: [], source: "foreign_key" }, membership: false, explanation: "org_id references the tenant table." }],
      notes: [],
    },
    seeding: { tables: [{ table: "public.invoices", rows: 4, notes: [] }, { table: "public.notes", rows: 0, failure: HOSTILE, notes: [] }], buckets: [{ bucket: "documents", files: 2 }], notes: [] },
    checks,
    findings: [
      {
        checkId: "table:public.invoices:select:tenant_a",
        title: "A signed-in user can read another tenant's rows in public.invoices",
        problem: "A read policy on public.invoices matches rows of other tenants.",
        fix: "Limit the read policy to rows of the signed-in user's own tenant.",
        sql: "-- Starting point: review before applying.\nalter table public.invoices enable row level security;",
      },
    ],
    warnings: [{ rule: "policy_always_true", object: "public.invoices: Anyone reads", message: "The policy is USING (true)." }],
    positiveControls: [{ table: "public.invoices", ownRowVisible: true }],
    summary: summarize(checks),
  };
}

function sandbox(migrations: string[]): Sandbox {
  return {
    projectDir: "/work/agency",
    dir: "/work/.tlc-work/agency-abc123",
    slug: "agency-abc123",
    projectId: "tlc-agency-abc123",
    settings: { schemas: ["public"], extraSearchPath: ["public"], maxRows: 1000, majorVersion: 17, buckets: [], notes: [] },
    migrations,
    fingerprint: "b".repeat(64),
  };
}

export const BAD_MIGRATION = {
  name: "20261101090000_cleanup.sql",
  sql: [
    "-- remove old stuff",
    "alter table public.invoices drop column number;",
    'drop policy "Members read their invoices" on public.invoices;',
  ].join("\n"),
};

/** A migration result: before has a pass that becomes a leak afterwards, and the migration drops a column and a policy. */
export function sampleDiff(options: { freshFails?: boolean; seededFails?: boolean } = {}): DiffResult {
  const beforeChecks = sampleChecks().map((check) =>
    check.status === "leak" ? passed(spec(check.kind, check.target, check.operation, check.actor), { ...(check.evidence as NonNullable<CheckResult["evidence"]>), summary: "Blocked." }) : check,
  );
  const before = { result: sampleRun(beforeChecks), catalog: agencyCatalog() };
  const afterCatalog = agencyCatalog();
  const invoices = afterCatalog.relations.find((r) => r.qualified === "public.invoices");
  if (invoices) invoices.columns = invoices.columns.filter((c) => c.name !== "number");
  const after = options.freshFails ? undefined : { result: sampleRun(), catalog: afterCatalog };
  const apply = {
    onSeededData: options.seededFails || options.freshFails ? { ok: false, error: "ERROR: column \"code\" contains null values (SQLSTATE 23502)" } : { ok: true },
    onFreshDatabase: options.freshFails ? { ok: false, error: "ERROR: relation \"public.nope\" does not exist (SQLSTATE 42P01)" } : { ok: true },
  };
  return assembleDiff({
    files: [BAD_MIGRATION],
    baseline: sandbox(["20261031000001_schema.sql"]),
    afterSandbox: sandbox(["20261031000001_schema.sql", BAD_MIGRATION.name]),
    before,
    after,
    apply,
  });
}
