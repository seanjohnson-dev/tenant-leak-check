import { EXIT_MEANING } from "../core/exit-codes.ts";
import type { Actor, CheckResult, TargetKind, Verdict } from "../core/results.ts";
import type { RunResult } from "../engine.ts";
import type { DiffResult } from "../migrate/diff.ts";
import type { Ownership } from "../discover/tenancy.ts";
import type { WarningRule } from "../analyze/rules.ts";
import type { ChangeSeverity } from "../migrate/catalog-diff.ts";

/** Plain-English building blocks shared by the CLI, Markdown and HTML reports (DESIGN.md section 11). */

export type AnyResult = RunResult | DiffResult;

export function isDiff(result: AnyResult): result is DiffResult {
  return "migration" in result;
}

export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  clean: "No leaks found. Every in-scope check was tested and blocked.",
  leaks_found: "LEAKS FOUND: another tenant's data (or an anonymous visitor) got through.",
  inconclusive: "No leaks found, but some checks could not be completed, so this is not a clean result.",
  review_needed: "No leaks found, but the migration needs a human review before it ships.",
};

export const VERDICT_TITLE: Readonly<Record<Verdict, string>> = {
  clean: "No leaks found",
  leaks_found: "Leaks found",
  inconclusive: "Not a clean result: some checks could not be completed",
  review_needed: "No leaks found, but the migration needs a review",
};

/** Section 1 of DESIGN.md: what this check never looks at. Listed in every report. */
export const NOT_COVERED: readonly string[] = [
  "Application code, edge functions, server routes, and anything that uses the service-role key (it skips row level security by design).",
  "The live or hosted project: its real data, dashboard-only settings and anything not written in the migrations.",
  "Realtime channels, GraphQL, the S3-compatible storage endpoint and the Auth admin endpoints.",
  "Denial of service, rate limits, password policy, token forgery and SQL injection.",
  "A third tenant, users with special roles inside a tenant, and rules that depend on time or other state: only a signed-in member of tenant A and an anonymous visitor were tested.",
];

export const GLOSSARY: readonly (readonly [string, string])[] = [
  ["Tenant", "One customer of the app (for example one company or one household) whose data must stay separate from every other customer's."],
  ["Row level security (RLS)", "The Postgres feature that decides, row by row, which rows a user may see or change. Without it, every client sees every row."],
  ["Policy", "One rule of row level security, for example \"members may read their own organisation's invoices\"."],
  ["Anonymous visitor (anon)", "Someone using the app's public key without signing in, which anyone can do from the browser."],
  ["RPC", "A database function the app can call directly through the API."],
  ["Storage bucket", "A folder-like container for uploaded files, protected by its own policies."],
];

const OPERATION_LABEL: Readonly<Record<string, string>> = {
  select: "Read",
  insert: "Add",
  update: "Change",
  update_reassign: "Move to another tenant",
  delete: "Delete",
  list: "List",
  download: "Download",
  upload: "Upload",
  overwrite: "Replace",
  execute: "Call",
};

export function operationLabel(operation: string): string {
  return OPERATION_LABEL[operation] ?? operation;
}

export const ACTOR_LABEL: Readonly<Record<Actor, string>> = {
  tenant_a: "Tenant A user",
  anon: "Anonymous visitor",
};

export const ACTOR_SHORT: Readonly<Record<Actor, string>> = {
  tenant_a: "Tenant A",
  anon: "Anon",
};

/** The text label of one result, never colour alone. */
export function statusLabel(check: CheckResult | undefined): string {
  if (!check) return "-";
  switch (check.status) {
    case "pass":
      return "Pass";
    case "leak":
      return "LEAK";
    case "inconclusive":
      return "Unclear";
    case "not_tested":
      return check.notTestedKind === "not_applicable" ? "n/a" : check.notTestedKind === "excluded" ? "Skipped" : "Not tested";
  }
}

/** A CSS-friendly class for a result. */
export function statusClass(check: CheckResult | undefined): string {
  if (!check) return "none";
  if (check.status === "not_tested") return check.notTestedKind === "could_not_test" ? "untested" : "na";
  return check.status;
}

export const STATUS_LEGEND: readonly (readonly [string, string, string])[] = [
  ["pass", "Pass", "We tried it and it was blocked. Tenant B's data was there and untouched."],
  ["leak", "LEAK", "We tried it and it worked. The evidence shows what we sent and what came back or changed."],
  ["untested", "Not tested", "We could not run this test; the reason is listed under \"Not tested, and why\"."],
  ["inconclusive", "Unclear", "We ran it, but the answer was unclear (for example a server error)."],
  ["na", "n/a / Skipped", "Nothing to test by nature (for example reading a table that belongs to no customer), or switched off in the config."],
];

export interface MatrixColumn {
  operation: string;
  actor: Actor;
}

export interface MatrixRow {
  target: string;
  kind: TargetKind;
  cells: (CheckResult | undefined)[];
}

export interface Matrix {
  title: string;
  /** What the rows are, for the first column's heading. */
  subject: string;
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

const MATRICES: readonly { title: string; subject: string; kinds: readonly TargetKind[]; operations: readonly string[] }[] = [
  { title: "Tables and views", subject: "Table or view", kinds: ["table", "view"], operations: ["select", "insert", "update", "update_reassign", "delete"] },
  { title: "Storage buckets", subject: "Bucket", kinds: ["storage"], operations: ["list", "download", "upload", "overwrite", "delete"] },
  { title: "Database functions (RPCs)", subject: "Function", kinds: ["rpc"], operations: ["execute"] },
];

/** The result grids: each object against each operation and actor. Empty grids are left out. */
export function buildMatrices(checks: readonly CheckResult[]): Matrix[] {
  const matrices: Matrix[] = [];
  for (const spec of MATRICES) {
    const relevant = checks.filter((check) => spec.kinds.includes(check.kind));
    if (relevant.length === 0) continue;
    const columns: MatrixColumn[] = [];
    for (const operation of spec.operations) {
      for (const actor of ["tenant_a", "anon"] as const) {
        if (relevant.some((check) => check.operation === operation && check.actor === actor)) columns.push({ operation, actor });
      }
    }
    const targets = [...new Set(relevant.map((check) => check.target))];
    const rows = targets.map((target) => {
      const own = relevant.filter((check) => check.target === target);
      return {
        target,
        kind: (own[0] as CheckResult).kind,
        cells: columns.map((column) => own.find((check) => check.operation === column.operation && check.actor === column.actor)),
      };
    });
    matrices.push({ title: spec.title, subject: spec.subject, columns, rows });
  }
  return matrices;
}

/** Checks that were not tested or were unclear, failures first, then exclusions, then "not applicable". */
export function notTestedChecks(checks: readonly CheckResult[]): CheckResult[] {
  const rank = (check: CheckResult): number =>
    check.status === "inconclusive" ? 0 : check.notTestedKind === "could_not_test" ? 1 : check.notTestedKind === "excluded" ? 2 : 3;
  return checks.filter((check) => check.status === "not_tested" || check.status === "inconclusive").sort((a, b) => rank(a) - rank(b));
}

/** "not applicable" reasons repeat for every operation; grouping them keeps the report short. */
export function groupByReason(checks: readonly CheckResult[]): { reason: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const check of checks) {
    const given = check.reason ?? "No reason was recorded.";
    const reason = /[.!?]$/.test(given) ? given : `${given}.`;
    groups.set(reason, [...(groups.get(reason) ?? []), check.id]);
  }
  return [...groups].map(([reason, ids]) => ({ reason, ids }));
}

export const WARNING_TITLE: Readonly<Record<WarningRule, string>> = {
  rls_disabled: "Row level security is off",
  policies_without_rls: "Policies that have no effect (row level security is off)",
  policy_always_true: "An access rule matches every row",
  policy_ignores_owner: "An access rule ignores who owns the row",
  update_without_with_check: "A change rule has no WITH CHECK",
  view_bypasses_rls: "A view skips row level security",
  materialized_view_exposed: "A materialized view is readable by clients",
  security_definer_callable: "A function runs with its owner's rights",
  public_bucket: "A storage bucket is public",
};

export const SEVERITY_LABEL: Readonly<Record<ChangeSeverity, string>> = {
  destructive: "Destructive",
  security: "Security change",
  attention: "Worth a look",
  info: "For information",
};

export function ownershipLabel(ownership: Ownership): string {
  switch (ownership.kind) {
    case "tenant_root":
      return "The tenant table itself";
    case "tenant":
      return `Belongs to a tenant (column ${ownership.tenantColumn})`;
    case "user":
      return `Belongs to a user (column ${ownership.userColumn})`;
    case "inherited":
      return `Belongs to whoever owns the linked row in ${ownership.parent}`;
    case "shared":
      return "Shared by every tenant";
    case "skipped":
      return "Skipped";
  }
}

export function exitLine(result: AnyResult): string {
  return `Exit code ${result.summary.exitCode}: ${EXIT_MEANING[result.summary.exitCode]}`;
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** "31 Oct 2026, 19:48 UTC": readable for a client, without depending on the reader's time zone. */
export function readableDate(iso: string): string {
  const date = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function scopeLine(result: AnyResult): string {
  const { scope } = result;
  return [
    plural(scope.tables.length, "table"),
    plural(scope.views.length, "view"),
    plural(scope.buckets.length, "storage bucket"),
    plural(scope.functions.length, "client-callable function"),
  ].join(", ");
}

export function countsLine(result: AnyResult): string {
  const { summary } = result;
  return `${summary.total} checks: ${summary.counts.pass} pass, ${summary.counts.leak} leak, ${summary.counts.not_tested} not tested, ${summary.counts.inconclusive} unclear`;
}

/** Pretty JSON for request bodies in evidence, cut to a readable length. */
export function bodyText(body: unknown, limit = 1200): string {
  const text = JSON.stringify(body, null, 2) ?? "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
