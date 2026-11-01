import { DISCLAIMER_SHORT } from "../core/disclaimer.ts";
import { isFailureToTest } from "../core/results.ts";
import type { ReportPaths } from "../report/write.ts";
import { type AnyResult, countsLine, exitLine, isDiff, plural, scopeLine, VERDICT_TEXT } from "../report/text.ts";

function migrationLines(result: AnyResult): string[] {
  if (!isDiff(result)) return [];
  const { migration } = result;
  const lines = ["", `Migration: ${migration.files.join(", ")}`, migration.headline];
  if (migration.results.newLeaks.length > 0) {
    lines.push("", "New leaks introduced by the migration:");
    for (const change of migration.results.newLeaks) lines.push(`  NEW LEAK  ${change.id}`);
  }
  if (migration.results.fixedLeaks.length > 0) {
    lines.push("", "Leaks the migration fixes:");
    for (const change of migration.results.fixedLeaks) lines.push(`  FIXED  ${change.id}`);
  }
  if (migration.review.length > 0) {
    lines.push("", "Needs a human review:");
    for (const item of migration.review) {
      const where = item.file ? `${item.file} line ${item.line}: ` : "";
      lines.push(`  REVIEW  ${where}${item.message}`);
    }
  }
  return lines;
}

/** The short CLI summary of DESIGN.md section 11: counts, verdict, leaks, gaps, disclaimer and exit code. */
export function formatRunSummary(result: AnyResult, reports?: ReportPaths): string {
  const { summary } = result;
  const lines = [
    `tenant-leak-check ${result.tool.version}: ${result.target.name}${isDiff(result) ? " (migration mode)" : ""}`,
    "",
    VERDICT_TEXT[summary.verdict],
    ...migrationLines(result),
    "",
    `${isDiff(result) ? "After the migration: " : ""}${countsLine(result)}`,
    `Scope: ${scopeLine(result)}`,
  ];
  const leaks = result.checks.filter((check) => check.status === "leak");
  if (leaks.length > 0) {
    lines.push("", "Leaks:");
    for (const leak of leaks) lines.push(`  LEAK  ${leak.id}`, `        ${leak.evidence?.summary ?? ""}`);
  }
  const gaps = result.checks.filter(isFailureToTest);
  if (gaps.length > 0) {
    lines.push("", "Could not be tested:");
    for (const gap of gaps) lines.push(`  ${gap.status === "inconclusive" ? "UNCLEAR" : "NOT TESTED"}  ${gap.id}`, `        ${gap.reason ?? ""}`);
  }
  if (summary.runProblems.length > 0) {
    lines.push("", "Problems with this run:");
    for (const problem of summary.runProblems) lines.push(`  - ${problem}`);
  }
  if (result.warnings.length > 0) lines.push("", `Warnings from the schema review: ${plural(result.warnings.length, "warning")} (see the report).`);
  if (reports) lines.push("", "Reports:", `  ${reports.html}`, `  ${reports.markdown}`, `  ${reports.json}`);
  lines.push("", DISCLAIMER_SHORT, exitLine(result));
  return lines.join("\n");
}
