import { DISCLAIMER_SHORT } from "../core/disclaimer.ts";
import { EXIT_MEANING } from "../core/exit-codes.ts";
import { isFailureToTest } from "../core/results.ts";
import type { RunResult } from "../engine.ts";

const VERDICT_TEXT: Readonly<Record<RunResult["summary"]["verdict"], string>> = {
  clean: "No leaks found. Every in-scope check was tested and blocked.",
  leaks_found: "LEAKS FOUND: another tenant's data (or an anonymous visitor) got through.",
  inconclusive: "No leaks found, but some checks could not be completed, so this is not a clean result.",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The short CLI summary of DESIGN.md section 11: counts, verdict, leaks, gaps, disclaimer and exit code. */
export function formatRunSummary(result: RunResult): string {
  const { summary } = result;
  const lines = [
    `tenant-leak-check ${result.tool.version}: ${result.target.name}`,
    "",
    VERDICT_TEXT[summary.verdict],
    "",
    `Checks: ${summary.total} (${summary.counts.pass} pass, ${summary.counts.leak} leak, ${summary.counts.not_tested} not tested, ${summary.counts.inconclusive} inconclusive)`,
    `Scope: ${plural(result.scope.tables.length, "table")}, ${plural(result.scope.views.length, "view")}, ${plural(result.scope.buckets.length, "storage bucket")}, ${plural(result.scope.functions.length, "client-callable function")}`,
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
  if (result.warnings.length > 0) lines.push("", `Warnings from the schema review: ${result.warnings.length} (see the report).`);
  lines.push("", DISCLAIMER_SHORT, `Exit code ${summary.exitCode}: ${EXIT_MEANING[summary.exitCode]}`);
  return lines.join("\n");
}
