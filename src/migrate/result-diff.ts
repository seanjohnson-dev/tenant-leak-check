import { type CheckResult, type CheckStatus, isFailureToTest } from "../core/results.ts";

export interface CheckChange {
  id: string;
  before?: CheckStatus;
  after?: CheckStatus;
}

/** How the check results moved between the run before and the run after the migration (DESIGN.md section 9, step 6). */
export interface ResultDiff {
  /** Leaks after the migration that were not leaks before, including leaks on new objects. */
  newLeaks: CheckChange[];
  /** Leaks before the migration that pass afterwards. */
  fixedLeaks: CheckChange[];
  /** Leaks before and after. */
  stillLeaking: CheckChange[];
  /** Checks that ran before but could not be completed afterwards. */
  noLongerTested: CheckChange[];
  /** Checks that exist only after the migration (new tables, functions, buckets), with their status. */
  added: CheckChange[];
  /** Checks that exist only before the migration (removed objects). */
  removed: CheckChange[];
}

function ran(check: CheckResult): boolean {
  return check.status === "pass" || check.status === "leak";
}

export function diffResults(before: readonly CheckResult[], after: readonly CheckResult[]): ResultDiff {
  const old = new Map(before.map((check) => [check.id, check]));
  const now = new Map(after.map((check) => [check.id, check]));
  const diff: ResultDiff = { newLeaks: [], fixedLeaks: [], stillLeaking: [], noLongerTested: [], added: [], removed: [] };
  for (const [id, check] of now) {
    const previous = old.get(id);
    const change: CheckChange = previous ? { id, before: previous.status, after: check.status } : { id, after: check.status };
    if (!previous) diff.added.push(change);
    if (check.status === "leak") (previous?.status === "leak" ? diff.stillLeaking : diff.newLeaks).push(change);
    if (previous?.status === "leak" && check.status === "pass") diff.fixedLeaks.push(change);
    if (previous && ran(previous) && isFailureToTest(check)) diff.noLongerTested.push(change);
  }
  for (const [id, check] of old) {
    if (!now.has(id)) diff.removed.push({ id, before: check.status });
  }
  return diff;
}
