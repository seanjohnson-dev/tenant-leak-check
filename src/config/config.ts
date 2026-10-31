import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ToolError } from "../core/errors.ts";

export const CONFIG_FILE_NAME = "tenant-leak-check.json";

export type Scalar = string | number | boolean | null;
/** A seed or argument value: plain JSON, or a placeholder string such as `{tenantB.row:public.invoices}`. */
export type ConfigValue = Scalar | ConfigValue[] | { [key: string]: ConfigValue };

export interface TableConfig {
  tenantColumn?: string;
  userColumn?: string;
  ownedVia?: { column: string; references: string };
  shared?: true;
  skip?: string;
}

export interface MembershipConfig {
  table: string;
  userColumn: string;
  tenantColumn: string;
  values?: Record<string, ConfigValue>;
}

export interface ToolConfig {
  tables: Record<string, TableConfig>;
  tenantRoot?: string;
  membership?: MembershipConfig;
  seed: { values: Record<string, ConfigValue> };
  storage: { allowPublic: string[]; pathTemplates?: string[] };
  rpc: { skip: Record<string, string>; args: Record<string, Record<string, ConfigValue>> };
  /** Where the config came from, for the report. Undefined when no file was used. */
  source?: string;
}

/** The config used when the project has no config file: everything is detected automatically. */
export function emptyConfig(): ToolConfig {
  return { tables: {}, seed: { values: {} }, storage: { allowPublic: [] }, rpc: { skip: {}, args: {} } };
}

/** Placeholders accepted in `rpc.args` and `seed.values`. */
export const PLACEHOLDER_PATTERN = /^\{tenant(A|B)\.(tenant|user|row:[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+)\}$/;

class ConfigProblem extends Error {}

function fail(path: string, message: string): never {
  throw new ConfigProblem(`${path}: ${message}`);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, path: string, allowed: readonly string[]): Json {
  if (!isObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `unknown setting (allowed here: ${allowed.join(", ")})`);
    }
  }
  return value;
}

function record(value: unknown, path: string): Json {
  if (!isObject(value)) fail(path, "must be an object");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be a non-empty text value");
  return value;
}

function identifier(value: unknown, path: string): string {
  const name = text(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) fail(path, `"${name}" is not a plain column name`);
  return name;
}

/** A `schema.name` reference. A bare name means the `public` schema. */
export function qualifiedName(value: unknown, path: string): string {
  const name = text(value, path);
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(part))) {
    fail(path, `"${name}" must look like schema.table (for example public.invoices)`);
  }
  return parts.length === 1 ? `public.${name}` : name;
}

function textList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be a list of text values");
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function configValue(value: unknown, path: string): ConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be a finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => configValue(item, `${path}[${index}]`));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, configValue(item, `${path}.${key}`)]));
  }
  fail(path, "must be a JSON value");
}

function placeholderCheck(value: ConfigValue, path: string): void {
  if (typeof value === "string" && value.startsWith("{tenant") && !PLACEHOLDER_PATTERN.test(value)) {
    fail(path, `"${value}" is not a known placeholder (use {tenantB.tenant}, {tenantB.user} or {tenantB.row:schema.table})`);
  }
}

function tableConfig(value: unknown, path: string): TableConfig {
  const raw = object(value, path, ["tenantColumn", "userColumn", "ownedVia", "shared", "skip"]);
  const config: TableConfig = {};
  if (raw.tenantColumn !== undefined) config.tenantColumn = identifier(raw.tenantColumn, `${path}.tenantColumn`);
  if (raw.userColumn !== undefined) config.userColumn = identifier(raw.userColumn, `${path}.userColumn`);
  if (raw.ownedVia !== undefined) {
    const via = object(raw.ownedVia, `${path}.ownedVia`, ["column", "references"]);
    config.ownedVia = {
      column: identifier(via.column, `${path}.ownedVia.column`),
      references: qualifiedName(via.references, `${path}.ownedVia.references`),
    };
  }
  if (raw.shared !== undefined) {
    if (raw.shared !== true) fail(`${path}.shared`, "can only be true (leave it out otherwise)");
    config.shared = true;
  }
  if (raw.skip !== undefined) config.skip = text(raw.skip, `${path}.skip`);
  const ownership = [config.tenantColumn ?? config.userColumn, config.ownedVia, config.shared, config.skip].filter(
    (item) => item !== undefined,
  );
  if (ownership.length === 0) {
    fail(path, "needs one of tenantColumn, userColumn, ownedVia, shared or skip");
  }
  if (ownership.length > 1) {
    fail(path, "use only one of: tenantColumn/userColumn, ownedVia, shared, skip");
  }
  return config;
}

/** Validates parsed JSON and returns a complete config. Throws a ToolError naming the offending key. */
export function validateConfig(raw: unknown, source?: string): ToolConfig {
  try {
    const top = object(raw, "config", ["$schema", "tables", "tenantRoot", "membership", "seed", "storage", "rpc"]);
    const config = emptyConfig();
    if (source) config.source = source;
    if (top.tables !== undefined) {
      for (const [name, value] of Object.entries(record(top.tables, "config.tables"))) {
        const key = qualifiedName(name, `config.tables["${name}"]`);
        config.tables[key] = tableConfig(value, `config.tables["${name}"]`);
      }
    }
    if (top.tenantRoot !== undefined) config.tenantRoot = qualifiedName(top.tenantRoot, "config.tenantRoot");
    if (top.membership !== undefined) {
      const m = object(top.membership, "config.membership", ["table", "userColumn", "tenantColumn", "values"]);
      const membership: MembershipConfig = {
        table: qualifiedName(m.table, "config.membership.table"),
        userColumn: identifier(m.userColumn, "config.membership.userColumn"),
        tenantColumn: identifier(m.tenantColumn, "config.membership.tenantColumn"),
      };
      if (m.values !== undefined) {
        membership.values = {};
        for (const [column, value] of Object.entries(record(m.values, "config.membership.values"))) {
          membership.values[identifier(column, `config.membership.values.${column}`)] = configValue(
            value,
            `config.membership.values.${column}`,
          );
        }
      }
      config.membership = membership;
    }
    if (top.seed !== undefined) {
      const seed = object(top.seed, "config.seed", ["values"]);
      if (seed.values !== undefined) {
        for (const [key, value] of Object.entries(record(seed.values, "config.seed.values"))) {
          const path = `config.seed.values["${key}"]`;
          const parts = key.split(".");
          if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
            fail(path, "keys must look like schema.table.column (for example public.invoices.status)");
          }
          const parsed = configValue(value, path);
          placeholderCheck(parsed, path);
          config.seed.values[key] = parsed;
        }
      }
    }
    if (top.storage !== undefined) {
      const storage = object(top.storage, "config.storage", ["allowPublic", "pathTemplates"]);
      if (storage.allowPublic !== undefined) config.storage.allowPublic = textList(storage.allowPublic, "config.storage.allowPublic");
      if (storage.pathTemplates !== undefined) {
        const templates = textList(storage.pathTemplates, "config.storage.pathTemplates");
        templates.forEach((template, index) => {
          const path = `config.storage.pathTemplates[${index}]`;
          if (!template.includes("{file}")) fail(path, 'must contain {file}, for example "{tenant}/{file}"');
          const unknown = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((n) => !["tenant", "user", "file"].includes(n ?? ""));
          if (unknown.length > 0) fail(path, `unknown placeholder {${unknown[0]}} (use {tenant}, {user} and {file})`);
        });
        config.storage.pathTemplates = templates;
      }
    }
    if (top.rpc !== undefined) {
      const rpc = object(top.rpc, "config.rpc", ["skip", "args"]);
      if (rpc.skip !== undefined) {
        for (const [name, reason] of Object.entries(record(rpc.skip, "config.rpc.skip"))) {
          config.rpc.skip[qualifiedName(name, `config.rpc.skip["${name}"]`)] = text(reason, `config.rpc.skip["${name}"]`);
        }
      }
      if (rpc.args !== undefined) {
        for (const [name, args] of Object.entries(record(rpc.args, "config.rpc.args"))) {
          const fn = qualifiedName(name, `config.rpc.args["${name}"]`);
          const values: Record<string, ConfigValue> = {};
          for (const [arg, value] of Object.entries(record(args, `config.rpc.args["${name}"]`))) {
            const path = `config.rpc.args["${name}"].${arg}`;
            const parsed = configValue(value, path);
            placeholderCheck(parsed, path);
            values[arg] = parsed;
          }
          config.rpc.args[fn] = values;
        }
      }
    }
    return config;
  } catch (error) {
    if (error instanceof ConfigProblem) {
      throw new ToolError(
        `The config file${source ? ` ${source}` : ""} has a problem at ${error.message}`,
        "Fix the setting (see docs/DESIGN.md section 10 for the format) and run the check again.",
      );
    }
    throw error;
  }
}

/**
 * Loads the config: the file given with --config, else `tenant-leak-check.json` in the
 * project folder, else the empty config. A missing --config file is an error.
 */
export async function loadConfig(projectDir: string, explicitPath?: string): Promise<ToolConfig> {
  const path = explicitPath ? resolve(explicitPath) : join(resolve(projectDir), CONFIG_FILE_NAME);
  if (!existsSync(path)) {
    if (explicitPath) {
      throw new ToolError(`The config file ${path} does not exist.`, "Check the path given with --config.");
    }
    return emptyConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ToolError(
      `The config file ${path} is not valid JSON: ${(error as Error).message}`,
      "Fix the JSON syntax and run the check again.",
    );
  }
  return validateConfig(parsed, path);
}
