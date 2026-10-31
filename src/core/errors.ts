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
