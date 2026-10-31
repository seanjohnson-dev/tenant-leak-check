import pg from "pg";
import { ToolError } from "../core/errors.ts";
import { assertLocalUrl } from "../safety/local-only.ts";

export type Row = Record<string, unknown>;

/**
 * A single connection to the sandbox database as the `postgres` superuser. Used for
 * discovery, seeding and verification only; probes always go through the HTTP APIs.
 */
export class Database {
  readonly #client: pg.Client;

  private constructor(client: pg.Client) {
    this.#client = client;
  }

  static async connect(url: string): Promise<Database> {
    assertLocalUrl(url, "database URL");
    const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, connectionTimeoutMillis: 15_000 });
    try {
      await client.connect();
    } catch (error) {
      throw new ToolError(
        `Could not connect to the local database: ${(error as Error).message}`,
        "Check that the local stack is running (supabase status) and try again.",
      );
    }
    return new Database(client);
  }

  async query<T extends object = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.#client.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  /** Runs `work` in a transaction and rolls back if it throws. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.#client.query("begin");
    try {
      const value = await work();
      await this.#client.query("commit");
      return value;
    } catch (error) {
      await this.#client.query("rollback");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#client.end();
  }
}

/** Double-quotes an SQL identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `"schema"."name"` for a `schema.name` string. */
export function qualifiedIdent(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/** The plain message and code of a Postgres error, for evidence and "could not test" reasons. */
export function describePgError(error: unknown): { code: string | undefined; message: string } {
  const e = error as { code?: unknown; message?: unknown; detail?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(error);
  const detail = typeof e.detail === "string" && e.detail.length > 0 ? ` (${e.detail})` : "";
  return { code, message: `${message}${detail}` };
}
