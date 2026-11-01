import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MigrationsFailed, ToolError } from "../core/errors.ts";
import { assertLocalUrl } from "../safety/local-only.ts";
import { redactDatabaseUrls } from "../safety/redact.ts";
import { EXCLUDED_SERVICES, PROJECT_ID_PREFIX, type Sandbox } from "./sandbox.ts";

export const START_TIMEOUT_MS = 15 * 60_000;
export const RESET_TIMEOUT_MS = 10 * 60_000;
export const SHORT_TIMEOUT_MS = 2 * 60_000;

/** The throwaway credentials of a local stack. Held in memory only; never printed or written to disk. */
export interface StackCredentials {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface CliResult {
  ok: boolean;
  missing: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type CliRunner = (args: readonly string[], timeoutMs: number) => Promise<CliResult>;

/** Runs the Supabase CLI. Only the local sub-commands listed in DESIGN.md section 2 rule 4 are ever passed. */
export const runSupabaseCli: CliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "supabase",
      [...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" } },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          ok: error === null,
          missing: code === "ENOENT",
          timedOut: error !== null && error.killed === true,
          stdout,
          stderr,
        });
      },
    );
  });

const ALLOWED_SUBCOMMANDS = new Set(["start", "status", "db reset", "migration up"]);

/** Keeps the last lines of CLI output that explain a failure, with anything that looks like a key removed. */
export function summarizeCliFailure(result: CliResult): string {
  const text = redactDatabaseUrls(`${result.stderr}\n${result.stdout}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted]");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(Try rerunning|Run supabase|https:\/\/github\.com\/supabase)/.test(line));
  return lines.slice(-6).join("\n");
}

function tidyPostgresError(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const error = lines[0] ?? message.trim();
  const at = lines.findIndex((line) => /^At statement\b/i.test(line));
  // "At statement: 1" is followed by the statement on the next lines; "At statement 0: <sql>" carries it inline.
  const inline = at >= 0 ? (/^At statement:?\s*\d*\s*:?\s*(.*)$/i.exec(lines[at] as string)?.[1] ?? "") : "";
  const statement = at >= 0 ? [inline, ...lines.slice(at + 1)].filter((line) => line && !line.startsWith("--")).join(" ").replace(/\s+/g, " ") : "";
  if (!statement) return error;
  return `${error}. Failing statement: ${statement.length > 200 ? `${statement.slice(0, 199)}…` : statement}`;
}

/**
 * Turns the CLI's report of a failed migration into one readable line: the Postgres error and
 * the statement that caused it. The CLI prints it either as plain text or as a JSON error line.
 */
export function migrationErrorText(detail: string): string {
  for (const line of detail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const message = (JSON.parse(trimmed) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === "string") return tidyPostgresError(message);
    } catch {
      // Not JSON after all; fall through to the plain-text form.
    }
  }
  const start = detail.search(/ERROR:/);
  return start >= 0 ? tidyPostgresError(detail.slice(start)) : detail.replace(/\s*\n\s*/g, " / ");
}

/** Reads the fields the tool needs from `supabase status -o json` and checks that every URL is local. */
export function parseStatus(json: string): StackCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new ToolError("The Supabase CLI returned a status the tool could not read.");
  }
  const field = (name: string): string => {
    const value = parsed[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new ToolError(
        `The local Supabase stack did not report its ${name}.`,
        "Check that the stack started fully (supabase status), then run the check again.",
      );
    }
    return value;
  };
  const apiUrl = field("API_URL");
  const dbUrl = field("DB_URL");
  assertLocalUrl(apiUrl, "Supabase API URL");
  assertLocalUrl(dbUrl, "database URL");
  return { apiUrl, dbUrl, anonKey: field("ANON_KEY"), serviceRoleKey: field("SERVICE_ROLE_KEY") };
}

/** Project ids of running tool-owned stacks, read from the names of their database containers. */
export function parseOwnStackIds(dockerNames: string): string[] {
  const ids = new Set<string>();
  for (const name of dockerNames.split("\n")) {
    const match = /^supabase_db_(tlc-[a-z0-9-]+)$/.exec(name.trim());
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

export interface StackManagerOptions {
  cli?: CliRunner;
  docker?: (args: readonly string[]) => Promise<CliResult>;
  log?: (line: string) => void;
}

const runDocker = (args: readonly string[]): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile("docker", [...args], { timeout: SHORT_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({ ok: error === null, missing: code === "ENOENT", timedOut: error !== null && error.killed === true, stdout, stderr });
    });
  });

const FINGERPRINT_FILE = ".tlc-fingerprint";

/**
 * Starts, reuses, resets and stops the sandbox stack. Only one tool-owned stack
 * runs at a time, because the build machine has little free memory (DESIGN.md 4.2).
 */
export class StackManager {
  readonly #cli: CliRunner;
  readonly #docker: (args: readonly string[]) => Promise<CliResult>;
  readonly #log: (line: string) => void;

  constructor(options: StackManagerOptions = {}) {
    this.#cli = options.cli ?? runSupabaseCli;
    this.#docker = options.docker ?? runDocker;
    this.#log = options.log ?? (() => {});
  }

  async #run(sandbox: Sandbox, subcommand: string, extra: readonly string[], timeoutMs: number): Promise<CliResult> {
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      throw new ToolError(`Internal error: the Supabase CLI command "${subcommand}" is not allowed.`);
    }
    const result = await this.#cli([...subcommand.split(" "), ...extra, "--workdir", sandbox.dir], timeoutMs);
    if (result.missing) {
      throw new ToolError(
        "The supabase command is not installed.",
        "Install the Supabase CLI (run tenant-leak-check doctor for details).",
      );
    }
    return result;
  }

  async runningOwnStacks(): Promise<string[]> {
    const result = await this.#docker(["ps", "--filter", `name=supabase_db_${PROJECT_ID_PREFIX}`, "--format", "{{.Names}}"]);
    if (result.missing) {
      throw new ToolError("The docker command is not installed.", "Run tenant-leak-check doctor to see what is missing.");
    }
    if (!result.ok) {
      throw new ToolError(
        "Docker is not reachable.",
        "Start Docker (or check that this user may use it), then run tenant-leak-check doctor.",
      );
    }
    return parseOwnStackIds(result.stdout);
  }

  async stopProject(projectId: string): Promise<void> {
    const result = await this.#cli(["stop", "--project-id", projectId, "--no-backup"], SHORT_TIMEOUT_MS);
    if (!result.ok) {
      throw new ToolError(`Could not stop the local stack ${projectId}.`, summarizeCliFailure(result));
    }
  }

  async credentials(sandbox: Sandbox): Promise<StackCredentials> {
    const result = await this.#run(sandbox, "status", ["-o", "json"], SHORT_TIMEOUT_MS);
    if (!result.ok) {
      throw new ToolError("Could not read the status of the local Supabase stack.", summarizeCliFailure(result));
    }
    return parseStatus(result.stdout);
  }

  async #storedFingerprint(sandbox: Sandbox): Promise<string | undefined> {
    try {
      return (await readFile(join(sandbox.dir, FINGERPRINT_FILE), "utf8")).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Makes the sandbox stack run with exactly the sandbox's migrations applied and no data.
   * A running stack for the same sandbox is reset (fast); any other tool-owned stack is stopped first.
   */
  async ensureFresh(sandbox: Sandbox): Promise<StackCredentials> {
    const running = await this.runningOwnStacks();
    for (const id of running.filter((id) => id !== sandbox.projectId)) {
      this.#log(`Stopping another tenant-leak-check stack (${id}) to free memory.`);
      await this.stopProject(id);
    }
    if (running.includes(sandbox.projectId)) {
      const sameConfig = (await this.#storedFingerprint(sandbox)) === sandbox.fingerprint;
      this.#log(
        sameConfig
          ? "Resetting the running local stack to a clean database."
          : "Rebuilding the running local stack's database from the migrations.",
      );
      const reset = await this.#run(sandbox, "db reset", ["--local", "--no-seed"], RESET_TIMEOUT_MS);
      if (reset.ok) {
        await writeFile(join(sandbox.dir, FINGERPRINT_FILE), sandbox.fingerprint);
        return this.credentials(sandbox);
      }
      this.#log("The reset failed; restarting the stack from scratch.");
      await this.stopProject(sandbox.projectId);
    }
    this.#log("Starting a local Supabase stack from the project's migrations (this can take a few minutes).");
    const start = await this.#run(sandbox, "start", ["-x", EXCLUDED_SERVICES.join(",")], START_TIMEOUT_MS);
    if (!start.ok) {
      const detail = summarizeCliFailure(start);
      await this.stopProject(sandbox.projectId).catch(() => {});
      if (!start.timedOut && /migration|ERROR:|SQLSTATE/i.test(detail)) {
        throw new MigrationsFailed(migrationErrorText(detail), "Fix the failing statement (the Supabase CLI would fail the same way), then run the check again.");
      }
      throw new ToolError(
        `The local Supabase stack did not start:\n${detail}`,
        start.timedOut
          ? `The start did not finish within ${START_TIMEOUT_MS / 60_000} minutes. Check Docker (docker ps) and try again.`
          : "Run tenant-leak-check doctor to check Docker, memory and networking.",
      );
    }
    await writeFile(join(sandbox.dir, FINGERPRINT_FILE), sandbox.fingerprint);
    return this.credentials(sandbox);
  }

  /**
   * Applies the sandbox's pending migrations to the running stack, on top of the data it
   * holds (migration mode, DESIGN.md section 9 step 3). A failure is returned, not thrown:
   * a migration that fails here is a finding about the migration, not a tool error.
   */
  async migrationUp(sandbox: Sandbox): Promise<{ ok: true } | { ok: false; detail: string }> {
    const result = await this.#run(sandbox, "migration up", ["--local"], RESET_TIMEOUT_MS);
    if (result.ok) return { ok: true };
    if (result.timedOut) {
      throw new ToolError(
        `Applying the new migration did not finish within ${RESET_TIMEOUT_MS / 60_000} minutes.`,
        "Check Docker (docker ps) and try again.",
      );
    }
    return { ok: false, detail: migrationErrorText(summarizeCliFailure(result)) };
  }

  async stop(sandbox: Sandbox): Promise<void> {
    await this.stopProject(sandbox.projectId);
  }
}
