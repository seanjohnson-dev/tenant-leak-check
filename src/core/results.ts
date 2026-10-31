import { EXIT, type ExitCode } from "./exit-codes.ts";

/** See DESIGN.md section 8 for the plain-English meaning of each status. */
export type CheckStatus = "pass" | "leak" | "not_tested" | "inconclusive";

/**
 * Why a check was not tested. Only `could_not_test` stops a clean result (exit 0):
 * `not_applicable` checks have nothing to test by nature (for example reading a shared
 * table that belongs to no customer) and `excluded` checks were switched off in config.
 */
export type NotTestedKind = "not_applicable" | "excluded" | "could_not_test";

export type Actor = "tenant_a" | "anon";

export type TargetKind = "table" | "view" | "storage" | "rpc";

export interface HttpEvidence {
  method: string;
  /** Path and query only. Hosts, keys and tokens are never recorded. */
  path: string;
  /** The synthetic request body, if any. */
  body?: unknown;
  status: number;
  /** A short, redacted excerpt of the response. */
  response: string;
}

export interface Evidence {
  actor: Actor;
  requests: HttpEvidence[];
  /** What the database showed immediately before the attempt. */
  before?: string;
  /** What the database showed afterwards, or what came back that belongs to tenant B. */
  after?: string;
  /** One plain-English sentence summing up what happened. */
  summary: string;
}

export interface CheckResult {
  /** Stable id such as `table:public.invoices:select:tenant_a`, so runs can be compared. */
  id: string;
  kind: TargetKind;
  /** `public.invoices`, a bucket name, or `public.get_invoices`. */
  target: string;
  operation: string;
  actor: Actor;
  status: CheckStatus;
  /** Plain-English reason for `not_tested` and `inconclusive`, written for a non-technical reader. */
  reason?: string;
  notTestedKind?: NotTestedKind;
  /** Extra plain-English remarks, for example "blocked by permissions". */
  notes: string[];
  evidence?: Evidence;
}

export function checkId(kind: TargetKind, target: string, operation: string, actor: Actor): string {
  return `${kind}:${target}:${operation}:${actor}`;
}

export interface CheckSpec {
  kind: TargetKind;
  target: string;
  operation: string;
  actor: Actor;
}

function base(spec: CheckSpec): Omit<CheckResult, "status"> {
  return { id: checkId(spec.kind, spec.target, spec.operation, spec.actor), ...spec, notes: [] };
}

export function passed(spec: CheckSpec, evidence: Evidence | undefined, notes: string[] = []): CheckResult {
  const result: CheckResult = { ...base(spec), status: "pass", notes };
  if (evidence) result.evidence = evidence;
  return result;
}

export function leaked(spec: CheckSpec, evidence: Evidence, notes: string[] = []): CheckResult {
  return { ...base(spec), status: "leak", notes, evidence };
}

export function notTested(spec: CheckSpec, kind: NotTestedKind, reason: string): CheckResult {
  return { ...base(spec), status: "not_tested", notTestedKind: kind, reason };
}

export function inconclusive(spec: CheckSpec, reason: string, evidence?: Evidence): CheckResult {
  const result: CheckResult = { ...base(spec), status: "inconclusive", reason };
  if (evidence) result.evidence = evidence;
  return result;
}

/** True for results that stop a run from being reported as clean. */
export function isFailureToTest(result: CheckResult): boolean {
  return result.status === "inconclusive" || (result.status === "not_tested" && result.notTestedKind === "could_not_test");
}

export type Verdict = "clean" | "leaks_found" | "inconclusive";

export interface Summary {
  verdict: Verdict;
  exitCode: ExitCode;
  total: number;
  counts: Record<CheckStatus, number>;
  /** Checks that could not be completed for a failure reason (they block exit code 0). */
  failuresToTest: number;
  /** Problems that make the whole run unreliable, for example "tenant A could not read anything". */
  runProblems: string[];
}

/** Applies the exit-code rules of DESIGN.md section 8 to a list of check results. */
export function summarize(checks: readonly CheckResult[], runProblems: readonly string[] = []): Summary {
  const counts: Record<CheckStatus, number> = { pass: 0, leak: 0, not_tested: 0, inconclusive: 0 };
  for (const check of checks) counts[check.status] += 1;
  const failuresToTest = checks.filter(isFailureToTest).length;
  let verdict: Verdict = "clean";
  let exitCode: ExitCode = EXIT.clean;
  if (counts.leak > 0) {
    verdict = "leaks_found";
    exitCode = EXIT.leaks;
  } else if (failuresToTest > 0 || runProblems.length > 0 || checks.length === 0) {
    verdict = "inconclusive";
    exitCode = EXIT.inconclusive;
  }
  const problems = [...runProblems];
  if (checks.length === 0 && problems.length === 0) {
    problems.push("No checks could be run, so nothing was proven.");
  }
  return { verdict, exitCode, total: checks.length, counts, failuresToTest, runProblems: problems };
}
