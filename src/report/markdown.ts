import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../core/disclaimer.ts";
import type { CheckResult } from "../core/results.ts";
import type { Finding } from "../analyze/fixes.ts";
import type { CheckChange } from "../migrate/result-diff.ts";
import type { DiffResult } from "../migrate/diff.ts";
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
  statusLabel,
  VERDICT_TEXT,
  VERDICT_TITLE,
  WARNING_TITLE,
} from "./text.ts";

/** Escapes text so Markdown renders it literally (no links, emphasis, HTML or broken tables). */
export function md(text: string): string {
  return text.replace(/[\\`*[\]<>|]/g, (ch) => `\\${ch}`).replace(/\n+/g, " ");
}

/** Inline code on one line (a line break would end a table row). */
function code(raw: string): string {
  const text = raw.replace(/\s*\n\s*/g, " ");
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function block(text: string, language = ""): string[] {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, text, fence];
}

/** A GitHub table. A `|` inside a cell (even inside code) must be escaped, or it splits the cell. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.map((c) => c.replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`;
  return [line(headers), `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(line)];
}

function cell(check: CheckResult | undefined): string {
  const label = statusLabel(check);
  return check?.status === "leak" ? `**${label}**` : label;
}

function matrixLines(matrix: Matrix, level = "###"): string[] {
  const headers = [matrix.subject, ...matrix.columns.map((c) => `${operationLabel(c.operation)} (${ACTOR_SHORT[c.actor]})`)];
  return [`${level} ${matrix.title}`, "", ...table(headers, matrix.rows.map((row) => [code(row.target), ...row.cells.map(cell)])), ""];
}

function changeTable(changes: readonly CheckChange[]): string[] {
  return table(["Check", "Before", "After"], changes.map((c) => [code(c.id), c.before ?? "did not exist", c.after ?? "no longer exists"]));
}

function migrationSection(result: DiffResult): string[] {
  const { migration } = result;
  const lines = ["## What this migration changes", "", md(migration.headline), ""];
  lines.push(
    `- Migration ${migration.files.length === 1 ? "file" : "files"}: ${migration.files.map(code).join(", ")}`,
    `- Tested on top of ${plural(migration.baseline.length, "existing migration")} of the project.`,
    `- Applied to a database that already holds test data: ${migration.apply.onSeededData.ok ? "worked." : `**failed**: ${md(migration.apply.onSeededData.error ?? "")}`}`,
    `- Applied to a fresh database: ${migration.apply.onFreshDatabase.ok ? "worked." : `**failed**: ${md(migration.apply.onFreshDatabase.error ?? "")}`}`,
    "",
  );
  if (migration.review.length > 0) {
    lines.push("### Needs a human review", "");
    for (const item of migration.review) lines.push(`- ${item.file ? `${code(item.file)} line ${item.line}: ` : ""}${md(item.message)}`);
    lines.push("");
  }
  const { results } = migration;
  if (results.newLeaks.length > 0) lines.push(`### New leaks (${results.newLeaks.length})`, "", "Each one is explained with its evidence and fix under \"Leaks found\" below.", "", ...changeTable(results.newLeaks), "");
  if (results.fixedLeaks.length > 0) lines.push(`### Leaks this migration fixes (${results.fixedLeaks.length})`, "", ...changeTable(results.fixedLeaks), "");
  if (results.stillLeaking.length > 0) lines.push(`### Leaks that were already there (${results.stillLeaking.length})`, "", ...changeTable(results.stillLeaking), "");
  if (results.noLongerTested.length > 0) lines.push(`### Checks that could no longer be completed (${results.noLongerTested.length})`, "", ...changeTable(results.noLongerTested), "");
  if (migration.statements.length > 0) {
    lines.push("### What the migration's statements do", "");
    lines.push(...table(["File", "Line", "Kind", "What it does", "Statement"], migration.statements.map((s) => [code(s.file), String(s.line), SEVERITY_LABEL[s.severity], md(s.message), code(s.statement)])), "");
  } else {
    lines.push("### What the migration's statements do", "", "No destructive or security-relevant statements were found in the migration text.", "");
  }
  if (migration.catalogChanges.length > 0) {
    lines.push("### Changes to the database structure", "");
    lines.push(
      ...table(
        ["Kind", "What changed", "Before", "After"],
        migration.catalogChanges.map((c) => [SEVERITY_LABEL[c.severity], md(c.message), c.before ? code(c.before) : "", c.after ? code(c.after) : ""]),
      ),
      "",
    );
  }
  if (results.added.length > 0) lines.push(`### New checks (objects the migration added): ${results.added.length}`, "", ...changeTable(results.added), "");
  if (results.removed.length > 0) lines.push(`### Checks that no longer apply (objects the migration removed): ${results.removed.length}`, "", ...changeTable(results.removed), "");
  return lines;
}

function testedSection(result: AnyResult): string[] {
  const lines = ["## What we tested", ""];
  lines.push(
    `- Project: ${code(result.target.name)}, rebuilt locally from ${plural(result.target.migrations.length, "migration file")} (Postgres ${result.target.postgresVersion ?? "unknown"}).`,
    `- In scope: ${scopeLine(result)}.`,
    `- Who we tested as: a signed-in member of test tenant A trying to read, add, change and delete test tenant B's data, and an anonymous visitor (the app's public key, not signed in) trying the same on either tenant's data.`,
    `- Test data: two synthetic tenants, each with a test user, rows in every table and a file in every bucket. No real data was used.`,
    `- Result: ${countsLine(result)}.`,
  );
  for (const note of result.scope.notes) lines.push(`- Note: ${md(note)}`);
  const failedSeeds = result.seeding.tables.filter((t) => t.failure);
  for (const seed of failedSeeds) lines.push(`- Could not create test data in ${code(seed.table)}: ${md(seed.failure ?? "")}`);
  for (const bucket of result.seeding.buckets.filter((b) => b.failure)) lines.push(`- Could not upload test files to the bucket ${code(bucket.bucket)}: ${md(bucket.failure ?? "")}`);
  if (result.summary.runProblems.length > 0) {
    lines.push("", "**Problems with this run:**", "");
    for (const problem of result.summary.runProblems) lines.push(`- ${md(problem)}`);
  }
  lines.push("");
  return lines;
}

function resultsSection(result: AnyResult): string[] {
  const lines = ["## Results", "", ...table(["Label", "Meaning"], STATUS_LEGEND.map(([, label, meaning]) => [label, md(meaning)])), ""];
  const matrices = buildMatrices(result.checks);
  if (matrices.length === 0) lines.push("No checks were run.", "");
  for (const matrix of matrices) lines.push(...matrixLines(matrix));
  return lines;
}

function leakCard(check: CheckResult, finding: Finding | undefined, index: number): string[] {
  const lines = [`### ${index}. ${md(finding?.title ?? check.id)}`, ""];
  lines.push(`- Check: ${code(check.id)}`, `- Who tried: ${ACTOR_LABEL[check.actor]}`);
  const evidence = check.evidence;
  if (evidence) {
    lines.push(`- What happened: ${md(evidence.summary)}`, "", "**What we tried**", "");
    for (const request of evidence.requests) {
      const parts = [`${request.method} ${request.path}`];
      if (request.body !== undefined) parts.push(bodyText(request.body));
      parts.push(`-> HTTP ${request.status}`, request.response);
      lines.push(...block(parts.join("\n")), "");
    }
    if (evidence.before) lines.push("**In the database before the attempt**", "", ...block(evidence.before), "");
    if (evidence.after) lines.push("**What came back or changed**", "", ...block(evidence.after), "");
  }
  for (const note of check.notes) lines.push(`- Note: ${md(note)}`);
  if (finding) {
    lines.push(`**Problem:** ${md(finding.problem)}`, "", `**Fix:** ${md(finding.fix)}`, "");
    if (finding.sql) lines.push(...block(finding.sql, "sql"), "");
  }
  return lines;
}

function leaksSection(result: AnyResult): string[] {
  const leaks = result.checks.filter((check) => check.status === "leak");
  if (leaks.length === 0) return ["## Leaks found", "", "None. No attempt to reach another tenant's data got through.", ""];
  const lines = [`## Leaks found (${leaks.length})`, ""];
  leaks.forEach((check, i) => lines.push(...leakCard(check, result.findings.find((f) => f.checkId === check.id), i + 1)));
  return lines;
}

function warningsSection(result: AnyResult): string[] {
  if (result.warnings.length === 0) return ["## Warnings from the schema review", "", "None.", ""];
  return [
    `## Warnings from the schema review (${result.warnings.length})`,
    "",
    "These come from reading the database structure. They are not proven leaks; they point at rules worth a second look.",
    "",
    ...table(["Warning", "Object", "Details"], result.warnings.map((w) => [WARNING_TITLE[w.rule], code(w.object), md(w.message)])),
    "",
  ];
}

function notTestedSection(result: AnyResult): string[] {
  const all = notTestedChecks(result.checks);
  const lines = ["## Not tested, and why", ""];
  if (all.length === 0) return [...lines, "Every check in scope was run.", ""];
  const failures = all.filter((c) => c.status === "inconclusive" || c.notTestedKind === "could_not_test");
  const excluded = all.filter((c) => c.notTestedKind === "excluded");
  const notApplicable = all.filter((c) => c.notTestedKind === "not_applicable");
  if (failures.length > 0) {
    lines.push(`### Could not be completed (${failures.length}): these stop the result from being clean`, "");
    for (const check of failures) lines.push(`- ${code(check.id)} (${statusLabel(check)}): ${md(check.reason ?? "")}`);
    lines.push("");
  }
  if (excluded.length > 0) {
    lines.push(`### Skipped in the config (${excluded.length})`, "");
    for (const group of groupByReason(excluded)) lines.push(`- ${md(group.reason)} Checks: ${group.ids.map(code).join(", ")}`);
    lines.push("");
  }
  if (notApplicable.length > 0) {
    lines.push(`### Nothing to test by nature (${notApplicable.length})`, "");
    for (const group of groupByReason(notApplicable)) lines.push(`- ${md(group.reason)} Checks: ${group.ids.map(code).join(", ")}`);
    lines.push("");
  }
  return lines;
}

function tenancySection(result: AnyResult): string[] {
  const { tenancy } = result;
  const lines = ["## How we decided who owns each table", ""];
  lines.push(`- Tenant table: ${tenancy.tenantRoot ? code(tenancy.tenantRoot) : "none found"}`);
  lines.push(`- Membership table (links users to tenants): ${tenancy.membership ? `${code(tenancy.membership.table)} (${code(tenancy.membership.userColumn)} to ${code(tenancy.membership.tenantColumn)})` : "none found"}`);
  for (const note of tenancy.notes) lines.push(`- Note: ${md(note)}`);
  lines.push("", "If a guess below is wrong, set it in tenant-leak-check.json and run the check again.", "");
  if (tenancy.tables.length > 0) {
    lines.push(...table(["Table", "Owner", "How we know"], tenancy.tables.map((t) => [code(t.table), md(ownershipLabel(t.ownership)), md(t.explanation)])), "");
  }
  return lines;
}

function beforeSection(result: DiffResult): string[] {
  const { before } = result.migration;
  const lines = ["## Before the migration", "", `For comparison: the results of the same checks on the project without the new migration. ${VERDICT_TEXT[before.summary.verdict]}`, ""];
  for (const matrix of buildMatrices(before.checks)) lines.push(...matrixLines(matrix));
  return lines;
}

/** The Markdown report: the same content as the HTML report, readable on GitHub or in a text editor. */
export function renderMarkdown(result: AnyResult): string {
  const diff = isDiff(result);
  const lines = [
    `# Tenant isolation report: ${md(result.target.name)}${diff ? " (migration check)" : ""}`,
    "",
    `Generated ${readableDate(result.generatedAt)} by tenant-leak-check ${result.tool.version}.`,
    "",
    `> **${VERDICT_TITLE[result.summary.verdict]}**`,
    `> ${VERDICT_TEXT[result.summary.verdict]}`,
    `> ${countsLine(result)}${diff ? " (after the migration)" : ""}.`,
    "",
    `**Please read:** ${DISCLAIMER_FULL}`,
    "",
    ...(diff ? migrationSection(result) : []),
    ...testedSection(result),
    ...resultsSection(result),
    ...leaksSection(result),
    ...warningsSection(result),
    ...notTestedSection(result),
    "## Not covered by this check",
    "",
    ...NOT_COVERED.map((item) => `- ${md(item)}`),
    "",
    ...tenancySection(result),
    ...(diff ? beforeSection(result) : []),
    "## Glossary",
    "",
    ...GLOSSARY.map(([term, meaning]) => `- **${md(term)}**: ${md(meaning)}`),
    "",
    "---",
    "",
    `${DISCLAIMER_SHORT} ${exitLine(result)}`,
    "",
  ];
  return lines.join("\n");
}
