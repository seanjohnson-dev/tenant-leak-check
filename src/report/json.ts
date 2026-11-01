import { EXIT_MEANING } from "../core/exit-codes.ts";
import type { CheckStatus, NotTestedKind } from "../core/results.ts";
import type { RunResult } from "../engine.ts";
import type { MigrationReport } from "../migrate/diff.ts";
import { type AnyResult, isDiff, NOT_COVERED, notTestedChecks } from "./text.ts";

/**
 * Version of the JSON report format (docs/report.schema.json, docs/REPORT-FORMAT.md).
 * Adding optional fields bumps the minor version; anything that can break a reader bumps the major.
 */
export const SCHEMA_VERSION = "1.0.0";

export interface NotTestedEntry {
  checkId: string;
  status: Extract<CheckStatus, "not_tested" | "inconclusive">;
  kind?: NotTestedKind;
  reason: string;
}

type JsonSummary = RunResult["summary"] & { exitMeaning: string };

export type JsonReport = Omit<RunResult, "summary"> & {
  schemaVersion: string;
  mode: "run" | "diff";
  summary: JsonSummary;
  notTested: NotTestedEntry[];
  notCovered: string[];
  migration?: Omit<MigrationReport, "before"> & { before: { summary: JsonSummary; checks: MigrationReport["before"]["checks"] } };
};

function withMeaning(summary: RunResult["summary"]): JsonSummary {
  return { ...summary, exitMeaning: EXIT_MEANING[summary.exitCode] };
}

/** The JSON report: the result object plus the fields readers need without re-deriving them (DESIGN.md section 11). */
export function buildJsonReport(result: AnyResult): JsonReport {
  const notTested = notTestedChecks(result.checks).map((check) => {
    const entry: NotTestedEntry = {
      checkId: check.id,
      status: check.status as NotTestedEntry["status"],
      reason: check.reason ?? "No reason was recorded.",
    };
    if (check.notTestedKind) entry.kind = check.notTestedKind;
    return entry;
  });
  const report: JsonReport = {
    schemaVersion: SCHEMA_VERSION,
    mode: isDiff(result) ? "diff" : "run",
    tool: result.tool,
    disclaimer: result.disclaimer,
    generatedAt: result.generatedAt,
    target: result.target,
    scope: result.scope,
    tenancy: result.tenancy,
    seeding: result.seeding,
    summary: withMeaning(result.summary),
    checks: result.checks,
    findings: result.findings,
    warnings: result.warnings,
    positiveControls: result.positiveControls,
    notTested,
    notCovered: [...NOT_COVERED],
  };
  if (isDiff(result)) {
    const { before, ...migration } = result.migration;
    report.migration = { ...migration, before: { summary: withMeaning(before.summary), checks: before.checks } };
  }
  return report;
}

export function renderJson(result: AnyResult): string {
  return `${JSON.stringify(buildJsonReport(result), null, 2)}\n`;
}
