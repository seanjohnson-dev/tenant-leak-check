import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../core/disclaimer.ts";
import type { CheckResult } from "../core/results.ts";
import type { Finding } from "../analyze/fixes.ts";
import type { DiffResult } from "../migrate/diff.ts";
import type { CheckChange } from "../migrate/result-diff.ts";
import {
  ACTOR_LABEL,
  ACTOR_SHORT,
  type AnyResult,
  bodyText,
  buildMatrices,
  countsLine,
  exitLine,
  GLOSSARY,
  groupByReason,
  isDiff,
  type Matrix,
  NOT_COVERED,
  notTestedChecks,
  operationLabel,
  ownershipLabel,
  plural,
  readableDate,
  scopeLine,
  SEVERITY_LABEL,
  STATUS_LEGEND,
  statusClass,
  statusLabel,
  VERDICT_TEXT,
  VERDICT_TITLE,
  WARNING_TITLE,
} from "./text.ts";

/** Escapes text for HTML element content and attribute values. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

const c = (text: string): string => `<code>${esc(text)}</code>`;
const pre = (text: string, className = ""): string => `<pre${className ? ` class="${className}"` : ""}>${esc(text)}</pre>`;

/**
 * Self-contained styles: no web fonts, scripts or external assets, so the file is safe to email
 * and prints cleanly. Status colours always come with a text label.
 */
const STYLE = `
:root { --ink: #1d2433; --muted: #5b6475; --line: #d9dee7; --bg: #ffffff; --soft: #f5f7fa;
  --pass: #1f7a3d; --pass-bg: #e6f4ea; --leak: #b3261e; --leak-bg: #fde8e7; --untested: #8a5300; --untested-bg: #fff3dc;
  --na: #5b6475; --na-bg: #eef0f4; --review: #6b3fa0; --review-bg: #f1eafb; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--soft); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 48px; background: var(--bg); }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--line); }
h3 { font-size: 16px; margin: 24px 0 8px; }
p, li { max-width: 78ch; }
.meta { color: var(--muted); margin: 0 0 20px; }
.banner { border-radius: 10px; padding: 18px 20px; margin: 16px 0; border: 2px solid; }
.banner strong { display: block; font-size: 20px; margin-bottom: 4px; }
.banner.clean { background: var(--pass-bg); border-color: var(--pass); }
.banner.leaks_found { background: var(--leak-bg); border-color: var(--leak); }
.banner.inconclusive { background: var(--untested-bg); border-color: var(--untested); }
.banner.review_needed { background: var(--review-bg); border-color: var(--review); }
.disclaimer { border-left: 4px solid var(--ink); background: var(--soft); padding: 12px 16px; margin: 16px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 600; }
td.status { text-align: center; font-weight: 600; white-space: nowrap; }
td.pass { color: var(--pass); background: var(--pass-bg); }
td.leak { color: var(--leak); background: var(--leak-bg); }
td.untested, td.inconclusive { color: var(--untested); background: var(--untested-bg); }
td.na, td.none { color: var(--na); background: var(--na-bg); font-weight: 400; }
.grid { overflow-x: auto; }
.grid th { font-size: 12px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: var(--soft); padding: 1px 4px; border-radius: 4px; word-break: break-word; }
pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 12px; }
pre.sql { background: #f3f6ff; }
.card { border: 1px solid var(--line); border-left: 6px solid var(--leak); border-radius: 8px; padding: 4px 18px 10px; margin: 16px 0; break-inside: avoid; }
.card h3 { margin-top: 14px; }
.label { display: inline-block; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
.label.leak { color: var(--leak); background: var(--leak-bg); }
.label.destructive, .label.security { color: var(--leak); background: var(--leak-bg); }
.label.attention { color: var(--untested); background: var(--untested-bg); }
.label.info { color: var(--na); background: var(--na-bg); }
.kv { color: var(--muted); }
dl.glossary dt { font-weight: 600; margin-top: 8px; }
dl.glossary dd { margin: 0 0 4px 0; }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media print {
  body { background: #fff; }
  main { max-width: none; padding: 0; }
  .card, table, pre { break-inside: avoid; }
  td.pass, td.leak, td.untested, td.inconclusive, td.na, td.none, .banner, .label { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function statusCell(check: CheckResult | undefined): string {
  const title = check ? ` title="${esc(check.reason ?? check.evidence?.summary ?? check.id)}"` : "";
  return `<td class="status ${statusClass(check)}"${title}>${esc(statusLabel(check))}</td>`;
}

function htmlTable(headers: readonly string[], rows: readonly (readonly string[])[], className = ""): string {
  const head = `<tr>${headers.map((h) => `<th scope="col">${h}</th>`).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${row.join("")}</tr>`).join("\n");
  return `<table${className ? ` class="${className}"` : ""}><thead>${head}</thead><tbody>\n${body}\n</tbody></table>`;
}

const td = (html: string): string => `<td>${html}</td>`;

function matrixHtml(matrix: Matrix): string {
  const headers = [esc(matrix.subject), ...matrix.columns.map((col) => `${esc(operationLabel(col.operation))}<br>${esc(ACTOR_SHORT[col.actor])}`)];
  const rows = matrix.rows.map((row) => [`<th scope="row">${c(row.target)}</th>`, ...row.cells.map(statusCell)]);
  return `<h3>${esc(matrix.title)}</h3>\n<div class="grid">${htmlTable(headers, rows)}</div>`;
}

function changeTable(changes: readonly CheckChange[]): string {
  return htmlTable(["Check", "Before", "After"], changes.map((ch) => [td(c(ch.id)), td(esc(ch.before ?? "did not exist")), td(esc(ch.after ?? "no longer exists"))]));
}

function migrationSection(result: DiffResult): string {
  const { migration } = result;
  const { results } = migration;
  const parts = [`<h2>What this migration changes</h2>`, `<p><strong>${esc(migration.headline)}</strong></p>`];
  const outcome = (ok: boolean, error?: string): string => (ok ? "worked." : `<strong>failed</strong>: ${esc(error ?? "")}`);
  parts.push(
    "<ul>",
    `<li>Migration ${migration.files.length === 1 ? "file" : "files"}: ${migration.files.map(c).join(", ")}</li>`,
    `<li>Tested on top of ${esc(plural(migration.baseline.length, "existing migration"))} of the project.</li>`,
    `<li>Applied to a database that already holds test data: ${outcome(migration.apply.onSeededData.ok, migration.apply.onSeededData.error)}</li>`,
    `<li>Applied to a fresh database: ${outcome(migration.apply.onFreshDatabase.ok, migration.apply.onFreshDatabase.error)}</li>`,
    "</ul>",
  );
  if (migration.review.length > 0) {
    parts.push("<h3>Needs a human review</h3>", "<ul>");
    for (const item of migration.review) parts.push(`<li>${item.file ? `${c(item.file)} line ${item.line}: ` : ""}${esc(item.message)}</li>`);
    parts.push("</ul>");
  }
  if (results.newLeaks.length > 0) parts.push(`<h3>New leaks (${results.newLeaks.length})</h3>`, "<p>Each one is explained with its evidence and fix under \"Leaks found\" below.</p>", changeTable(results.newLeaks));
  if (results.fixedLeaks.length > 0) parts.push(`<h3>Leaks this migration fixes (${results.fixedLeaks.length})</h3>`, changeTable(results.fixedLeaks));
  if (results.stillLeaking.length > 0) parts.push(`<h3>Leaks that were already there (${results.stillLeaking.length})</h3>`, changeTable(results.stillLeaking));
  if (results.noLongerTested.length > 0) parts.push(`<h3>Checks that could no longer be completed (${results.noLongerTested.length})</h3>`, changeTable(results.noLongerTested));
  parts.push("<h3>What the migration's statements do</h3>");
  if (migration.statements.length > 0) {
    parts.push(
      htmlTable(
        ["File", "Line", "Kind", "What it does", "Statement"],
        migration.statements.map((s) => [td(c(s.file)), td(String(s.line)), td(`<span class="label ${s.severity}">${esc(SEVERITY_LABEL[s.severity])}</span>`), td(esc(s.message)), td(c(s.statement))]),
      ),
    );
  } else {
    parts.push("<p>No destructive or security-relevant statements were found in the migration text.</p>");
  }
  if (migration.catalogChanges.length > 0) {
    parts.push(
      "<h3>Changes to the database structure</h3>",
      htmlTable(
        ["Kind", "What changed", "Before", "After"],
        migration.catalogChanges.map((ch) => [td(`<span class="label ${ch.severity}">${esc(SEVERITY_LABEL[ch.severity])}</span>`), td(esc(ch.message)), td(ch.before ? c(ch.before) : ""), td(ch.after ? c(ch.after) : "")]),
      ),
    );
  }
  if (results.added.length > 0) parts.push(`<h3>New checks (objects the migration added): ${results.added.length}</h3>`, changeTable(results.added));
  if (results.removed.length > 0) parts.push(`<h3>Checks that no longer apply (objects the migration removed): ${results.removed.length}</h3>`, changeTable(results.removed));
  return parts.join("\n");
}

function testedSection(result: AnyResult): string {
  const items = [
    `Project: ${c(result.target.name)}, rebuilt locally from ${esc(plural(result.target.migrations.length, "migration file"))} (Postgres ${esc(result.target.postgresVersion ?? "unknown")}).`,
    `In scope: ${esc(scopeLine(result))}.`,
    "Who we tested as: a signed-in member of test tenant A trying to read, add, change and delete test tenant B's data, and an anonymous visitor (the app's public key, not signed in) trying the same on either tenant's data.",
    "Test data: two synthetic tenants, each with a test user, rows in every table and a file in every bucket. No real data was used.",
    `Result: ${esc(countsLine(result))}.`,
    ...result.scope.notes.map((note) => `Note: ${esc(note)}`),
    ...result.seeding.tables.filter((t) => t.failure).map((t) => `Could not create test data in ${c(t.table)}: ${esc(t.failure ?? "")}`),
    ...result.seeding.buckets.filter((b) => b.failure).map((b) => `Could not upload test files to the bucket ${c(b.bucket)}: ${esc(b.failure ?? "")}`),
  ];
  const parts = ["<h2>What we tested</h2>", `<ul>${items.map((item) => `<li>${item}</li>`).join("\n")}</ul>`];
  if (result.summary.runProblems.length > 0) {
    parts.push("<p><strong>Problems with this run:</strong></p>", `<ul>${result.summary.runProblems.map((p) => `<li>${esc(p)}</li>`).join("\n")}</ul>`);
  }
  return parts.join("\n");
}

function resultsSection(result: AnyResult): string {
  const legend = htmlTable(["Label", "Meaning"], STATUS_LEGEND.map(([cls, label, meaning]) => [`<td class="status ${cls}">${esc(label)}</td>`, td(esc(meaning))]));
  const matrices = buildMatrices(result.checks);
  return ["<h2>Results</h2>", legend, ...(matrices.length === 0 ? ["<p>No checks were run.</p>"] : matrices.map(matrixHtml))].join("\n");
}

function leakCard(check: CheckResult, finding: Finding | undefined, index: number): string {
  const parts = [`<section class="card">`, `<h3>${index}. ${esc(finding?.title ?? check.id)}</h3>`];
  parts.push(`<p><span class="label leak">LEAK</span> <span class="kv">Check</span> ${c(check.id)} · <span class="kv">Who tried</span> ${esc(ACTOR_LABEL[check.actor])}</p>`);
  const evidence = check.evidence;
  if (evidence) {
    parts.push(`<p><strong>What happened:</strong> ${esc(evidence.summary)}</p>`, "<p><strong>What we tried</strong></p>");
    for (const request of evidence.requests) {
      const lines = [`${request.method} ${request.path}`];
      if (request.body !== undefined) lines.push(bodyText(request.body));
      lines.push(`-> HTTP ${request.status}`, request.response);
      parts.push(pre(lines.join("\n")));
    }
    if (evidence.before) parts.push("<p><strong>In the database before the attempt</strong></p>", pre(evidence.before));
    if (evidence.after) parts.push("<p><strong>What came back or changed</strong></p>", pre(evidence.after));
  }
  for (const note of check.notes) parts.push(`<p class="kv">Note: ${esc(note)}</p>`);
  if (finding) {
    parts.push(`<p><strong>Problem:</strong> ${esc(finding.problem)}</p>`, `<p><strong>Fix:</strong> ${esc(finding.fix)}</p>`);
    if (finding.sql) parts.push(pre(finding.sql, "sql"));
  }
  parts.push("</section>");
  return parts.join("\n");
}

function leaksSection(result: AnyResult): string {
  const leaks = result.checks.filter((check) => check.status === "leak");
  if (leaks.length === 0) return "<h2>Leaks found</h2>\n<p>None. No attempt to reach another tenant's data got through.</p>";
  return [`<h2>Leaks found (${leaks.length})</h2>`, ...leaks.map((check, i) => leakCard(check, result.findings.find((f) => f.checkId === check.id), i + 1))].join("\n");
}

function warningsSection(result: AnyResult): string {
  if (result.warnings.length === 0) return "<h2>Warnings from the schema review</h2>\n<p>None.</p>";
  return [
    `<h2>Warnings from the schema review (${result.warnings.length})</h2>`,
    "<p>These come from reading the database structure. They are not proven leaks; they point at rules worth a second look.</p>",
    htmlTable(["Warning", "Object", "Details"], result.warnings.map((w) => [td(esc(WARNING_TITLE[w.rule])), td(c(w.object)), td(esc(w.message))])),
  ].join("\n");
}

function notTestedSection(result: AnyResult): string {
  const all = notTestedChecks(result.checks);
  const parts = ["<h2>Not tested, and why</h2>"];
  if (all.length === 0) return [...parts, "<p>Every check in scope was run.</p>"].join("\n");
  const failures = all.filter((ch) => ch.status === "inconclusive" || ch.notTestedKind === "could_not_test");
  const excluded = all.filter((ch) => ch.notTestedKind === "excluded");
  const notApplicable = all.filter((ch) => ch.notTestedKind === "not_applicable");
  if (failures.length > 0) {
    parts.push(`<h3>Could not be completed (${failures.length}): these stop the result from being clean</h3>`, "<ul>");
    for (const check of failures) parts.push(`<li>${c(check.id)} (${esc(statusLabel(check))}): ${esc(check.reason ?? "")}</li>`);
    parts.push("</ul>");
  }
  const grouped = (title: string, checks: readonly CheckResult[]): void => {
    if (checks.length === 0) return;
    parts.push(`<h3>${esc(title)} (${checks.length})</h3>`, "<ul>");
    for (const group of groupByReason(checks)) parts.push(`<li>${esc(group.reason)} Checks: ${group.ids.map(c).join(", ")}</li>`);
    parts.push("</ul>");
  };
  grouped("Skipped in the config", excluded);
  grouped("Nothing to test by nature", notApplicable);
  return parts.join("\n");
}

function tenancySection(result: AnyResult): string {
  const { tenancy } = result;
  const items = [
    `Tenant table: ${tenancy.tenantRoot ? c(tenancy.tenantRoot) : "none found"}`,
    `Membership table (links users to tenants): ${tenancy.membership ? `${c(tenancy.membership.table)} (${c(tenancy.membership.userColumn)} to ${c(tenancy.membership.tenantColumn)})` : "none found"}`,
    ...tenancy.notes.map((note) => `Note: ${esc(note)}`),
  ];
  const parts = [
    "<h2>How we decided who owns each table</h2>",
    `<ul>${items.map((item) => `<li>${item}</li>`).join("\n")}</ul>`,
    "<p>If a guess below is wrong, set it in <code>tenant-leak-check.json</code> and run the check again.</p>",
  ];
  if (tenancy.tables.length > 0) {
    parts.push(htmlTable(["Table", "Owner", "How we know"], tenancy.tables.map((t) => [td(c(t.table)), td(esc(ownershipLabel(t.ownership))), td(esc(t.explanation))])));
  }
  return parts.join("\n");
}

function beforeSection(result: DiffResult): string {
  const { before } = result.migration;
  return [
    "<h2>Before the migration</h2>",
    `<p>For comparison: the results of the same checks on the project without the new migration. ${esc(VERDICT_TEXT[before.summary.verdict])}</p>`,
    ...buildMatrices(before.checks).map(matrixHtml),
  ].join("\n");
}

/** The HTML report: one self-contained file with inline CSS, no scripts and no external assets (DESIGN.md section 11). */
export function renderHtml(result: AnyResult): string {
  const diff = isDiff(result);
  const title = `Tenant isolation report: ${result.target.name}${diff ? " (migration check)" : ""}`;
  const { verdict } = result.summary;
  const body = [
    `<h1>${esc(title)}</h1>`,
    `<p class="meta">Generated ${esc(readableDate(result.generatedAt))} by tenant-leak-check ${esc(result.tool.version)}.</p>`,
    `<div class="banner ${verdict}" role="status"><strong>${esc(VERDICT_TITLE[verdict])}</strong>${esc(VERDICT_TEXT[verdict])}<br>${esc(countsLine(result))}${diff ? " (after the migration)" : ""}.</div>`,
    `<p class="disclaimer"><strong>Please read:</strong> ${esc(DISCLAIMER_FULL)}</p>`,
    ...(diff ? [migrationSection(result)] : []),
    testedSection(result),
    resultsSection(result),
    leaksSection(result),
    warningsSection(result),
    notTestedSection(result),
    "<h2>Not covered by this check</h2>",
    `<ul>${NOT_COVERED.map((item) => `<li>${esc(item)}</li>`).join("\n")}</ul>`,
    tenancySection(result),
    ...(diff ? [beforeSection(result)] : []),
    "<h2>Glossary</h2>",
    `<dl class="glossary">${GLOSSARY.map(([term, meaning]) => `<dt>${esc(term)}</dt><dd>${esc(meaning)}</dd>`).join("\n")}</dl>`,
    `<footer>${esc(DISCLAIMER_SHORT)} ${esc(exitLine(result))}</footer>`,
  ];
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    ...body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
