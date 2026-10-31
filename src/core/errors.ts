/**
 * An error the user can act on. `message` says what went wrong in plain words;
 * `hint` (optional) says what to do about it. The CLI prints both and exits with code 3.
 */
export class ToolError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

/**
 * The target project itself stopped the test setup (for example a sign-up trigger
 * rejects new users). Unlike a ToolError, this is a finding about the target: the run
 * still produces a report, marked inconclusive, and exits with code 2.
 */
export class SetupProblem extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "SetupProblem";
    this.hint = hint;
  }
}
