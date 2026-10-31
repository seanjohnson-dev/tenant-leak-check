/**
 * Process exit codes. Kept distinct so CI can tell "leaks found" apart from
 * "could not test" and from "the tool itself failed". See docs/DESIGN.md, section 8.
 */
export const EXIT = {
  clean: 0,
  leaks: 1,
  inconclusive: 2,
  toolError: 3,
  migrationReview: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_MEANING: Readonly<Record<ExitCode, string>> = {
  0: "No leaks found, and every in-scope check was actually tested.",
  1: "At least one leak was found: one tenant (or an anonymous visitor) reached another tenant's data.",
  2: "No leaks found, but some checks could not be completed, so this is not a clean result.",
  3: "The tool could not run (setup problem, bad input, or an unexpected error).",
  4: "No leaks found, but the migration needs a human review (destructive or security-relevant changes).",
};

/** Highest priority first: a tool error outranks leaks, leaks outrank review, review outranks inconclusive. */
const PRECEDENCE: readonly ExitCode[] = [
  EXIT.toolError,
  EXIT.leaks,
  EXIT.migrationReview,
  EXIT.inconclusive,
  EXIT.clean,
];

/** Combines the exit codes of several parts of a run into the one the process should return. */
export function combineExitCodes(codes: readonly ExitCode[]): ExitCode {
  for (const code of PRECEDENCE) {
    if (codes.includes(code)) return code;
  }
  return EXIT.clean;
}
