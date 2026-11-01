import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { BuildFile } from "../config/config.ts";
import { ToolError } from "../core/errors.ts";

/**
 * The dedicated port block for sandbox stacks (DESIGN.md section 4.2). It sits in
 * 554xx so it never collides with a developer's own stack on the default 543xx ports.
 */
export const SANDBOX_PORTS = {
  shadow: 55420,
  api: 55421,
  db: 55422,
  studio: 55423,
  smtp: 55424,
  analytics: 55427,
  pooler: 55429,
} as const;

/** Services the tool does not need. Passed to `supabase start -x` and switched off in the generated config. */
export const EXCLUDED_SERVICES = [
  "studio",
  "imgproxy",
  "edge-runtime",
  "logflare",
  "vector",
  "realtime",
  "supavisor",
  "mailpit",
  "postgres-meta",
] as const;

export const PROJECT_ID_PREFIX = "tlc-";

/** Settings copied from the target's config.toml. Everything else in the target's config is ignored. */
export interface TargetSettings {
  schemas: string[];
  extraSearchPath: string[];
  maxRows: number;
  majorVersion: number;
  buckets: BucketSetting[];
  /** Plain-English notes about values that were ignored (for example `env(...)` references). */
  notes: string[];
}

export interface BucketSetting {
  name: string;
  public: boolean;
  fileSizeLimit?: string;
  allowedMimeTypes?: string[];
}

export const DEFAULT_SETTINGS: Readonly<Omit<TargetSettings, "buckets" | "notes">> = {
  schemas: ["public", "graphql_public"],
  extraSearchPath: ["public", "extensions"],
  maxRows: 1000,
  majorVersion: 17,
};

export interface Sandbox {
  /** Absolute path of the target project folder (the one that contains `supabase/`). */
  projectDir: string;
  /** Absolute path of the sandbox folder handed to the Supabase CLI as `--workdir`. */
  dir: string;
  slug: string;
  projectId: string;
  settings: TargetSettings;
  /** Migration file names in the order the CLI applies them. */
  migrations: string[];
  /** SHA-256 over the generated config and every migration, used to decide whether a running stack can be reused. */
  fingerprint: string;
}

function isEnvReference(value: unknown): boolean {
  return typeof value === "string" && /^\s*env\(.*\)\s*$/.test(value);
}

/** Lower-case, dash-separated, safe for Docker container names, plus a short hash of the absolute path. */
export function sandboxSlug(projectDir: string): string {
  const absolute = resolve(projectDir);
  const base =
    basename(absolute)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "project";
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

function stringArray(value: unknown, key: string, notes: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (isEnvReference(value)) {
    notes.push(`Ignored ${key} in config.toml because it refers to an environment variable.`);
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ToolError(`The target's config.toml has an invalid ${key}: expected a list of names.`);
  }
  const kept = value.filter((item) => {
    if (isEnvReference(item)) {
      notes.push(`Ignored one entry of ${key} in config.toml because it refers to an environment variable.`);
      return false;
    }
    return true;
  });
  return kept;
}

function positiveInteger(value: unknown, key: string, notes: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (isEnvReference(value)) {
    notes.push(`Ignored ${key} in config.toml because it refers to an environment variable.`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolError(`The target's config.toml has an invalid ${key}: expected a whole number.`);
  }
  return value;
}

function table(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads only the allow-listed settings from the text of a target's config.toml
 * (DESIGN.md section 4.2). Values written as env(...) are ignored and noted.
 */
export function parseTargetSettings(text: string | undefined): TargetSettings {
  const notes: string[] = [];
  const settings: TargetSettings = { ...DEFAULT_SETTINGS, schemas: [...DEFAULT_SETTINGS.schemas], extraSearchPath: [...DEFAULT_SETTINGS.extraSearchPath], buckets: [], notes };
  if (text === undefined) {
    notes.push("The project has no supabase/config.toml, so the Supabase defaults were used.");
    return settings;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ToolError(
      `The target's supabase/config.toml could not be read: ${(error as Error).message.split("\n")[0]}`,
      "Fix the file (the Supabase CLI would reject it too) and run the check again.",
    );
  }
  const api = table(parsed.api);
  const db = table(parsed.db);
  const storage = table(parsed.storage);
  settings.schemas = stringArray(api?.schemas, "api.schemas", notes) ?? settings.schemas;
  settings.extraSearchPath = stringArray(api?.extra_search_path, "api.extra_search_path", notes) ?? settings.extraSearchPath;
  settings.maxRows = positiveInteger(api?.max_rows, "api.max_rows", notes) ?? settings.maxRows;
  settings.majorVersion = positiveInteger(db?.major_version, "db.major_version", notes) ?? settings.majorVersion;
  const buckets = table(storage?.buckets) ?? {};
  for (const [name, raw] of Object.entries(buckets)) {
    const bucket = table(raw);
    if (!bucket) continue;
    const setting: BucketSetting = { name, public: bucket.public === true };
    if (typeof bucket.file_size_limit === "string" && !isEnvReference(bucket.file_size_limit)) {
      setting.fileSizeLimit = bucket.file_size_limit;
    }
    const mimes = stringArray(bucket.allowed_mime_types, `storage.buckets.${name}.allowed_mime_types`, notes);
    if (mimes) setting.allowedMimeTypes = mimes;
    settings.buckets.push(setting);
  }
  return settings;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStrings(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function bucketKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/** The config.toml the tool writes into its sandbox. Only the services the tool needs are switched on. */
export function generateConfigToml(projectId: string, settings: TargetSettings): string {
  const lines = [
    "# Generated by tenant-leak-check. Do not edit: it is rewritten on every run.",
    `project_id = ${tomlString(projectId)}`,
    "",
    "[api]",
    "enabled = true",
    `port = ${SANDBOX_PORTS.api}`,
    `schemas = ${tomlStrings(settings.schemas)}`,
    `extra_search_path = ${tomlStrings(settings.extraSearchPath)}`,
    `max_rows = ${settings.maxRows}`,
    "",
    "[db]",
    `port = ${SANDBOX_PORTS.db}`,
    `shadow_port = ${SANDBOX_PORTS.shadow}`,
    `major_version = ${settings.majorVersion}`,
    "",
    "[db.pooler]",
    "enabled = false",
    `port = ${SANDBOX_PORTS.pooler}`,
    "",
    "[db.migrations]",
    "enabled = true",
    "",
    "[db.seed]",
    "enabled = false",
    "",
    "[realtime]",
    "enabled = false",
    "",
    "[studio]",
    "enabled = false",
    `port = ${SANDBOX_PORTS.studio}`,
    "",
    "[local_smtp]",
    "enabled = false",
    `port = ${SANDBOX_PORTS.smtp}`,
    "",
    "[storage]",
    "enabled = true",
    'file_size_limit = "50MiB"',
    "",
    "[storage.s3_protocol]",
    "enabled = false",
    "",
    "[storage.vector]",
    "enabled = false",
  ];
  for (const bucket of settings.buckets) {
    lines.push("", `[storage.buckets.${bucketKey(bucket.name)}]`, `public = ${bucket.public}`);
    if (bucket.fileSizeLimit) lines.push(`file_size_limit = ${tomlString(bucket.fileSizeLimit)}`);
    if (bucket.allowedMimeTypes) lines.push(`allowed_mime_types = ${tomlStrings(bucket.allowedMimeTypes)}`);
  }
  lines.push(
    "",
    "[auth]",
    "enabled = true",
    'site_url = "http://127.0.0.1:3000"',
    "enable_signup = true",
    "enable_anonymous_sign_ins = false",
    "minimum_password_length = 6",
    "",
    "[auth.rate_limit]",
    "sign_in_sign_ups = 1000",
    "token_refresh = 1000",
    "",
    "[auth.email]",
    "enable_signup = true",
    "enable_confirmations = false",
    "",
    "[edge_runtime]",
    "enabled = false",
    "",
    "[analytics]",
    "enabled = false",
    `port = ${SANDBOX_PORTS.analytics}`,
    "",
  );
  return lines.join("\n");
}

/** Migration files the CLI would apply: `<timestamp>_<name>.sql` directly inside `supabase/migrations`. */
export function selectMigrationFiles(names: readonly string[]): string[] {
  return names.filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
}

export interface SandboxOptions {
  projectDir: string;
  workdir: string;
  /** Migration file names (base names) to leave out, used by migration mode for the "before" run. */
  excludeMigrations?: readonly string[];
  /** Extra migration files (absolute paths) appended after the project's own, used by migration mode. */
  extraMigrations?: readonly string[];
  /** SQL files from the config's `build.files`, slotted into the migration order by their version. */
  buildFiles?: readonly BuildFile[];
}

/** The sandbox file name for a `build.files` entry: its version, then its own name without any leading timestamp. */
export function buildFileName(file: BuildFile): string {
  const name = basename(file.path).replace(/^\d+_/, "");
  return `${file.version}_${name}`;
}

async function copyBuildFiles(
  files: readonly BuildFile[],
  migrationsDir: string,
  sandboxMigrations: string,
  migrations: string[],
  notes: string[],
): Promise<void> {
  for (const file of files) {
    if (!existsSync(file.path) || !(await stat(file.path)).isFile()) {
      throw new ToolError(
        `The build file ${file.path} (from build.files in the config) does not exist.`,
        "Paths in build.files are relative to the config file's folder. Fix the path and run the check again.",
      );
    }
    const name = buildFileName(file);
    // A project migration listed here is moved to its new version instead of running twice.
    const own = resolve(dirname(file.path)) === migrationsDir ? migrations.indexOf(basename(file.path)) : -1;
    if (own >= 0) migrations.splice(own, 1);
    if (migrations.includes(name)) {
      throw new ToolError(`The build file ${name} clashes with a migration of the same name.`, "Give it a different version in build.files.");
    }
    if (own >= 0) await rm(join(sandboxMigrations, basename(file.path)));
    await copyFile(file.path, join(sandboxMigrations, name));
    migrations.push(name);
    notes.push(
      own >= 0
        ? `Applied the migration ${basename(file.path)} as ${name} instead (build.files in the config).`
        : `Added ${file.path} to the build as ${name} (build.files in the config).`,
    );
  }
}

/** The version part of a migration file name (`20240101000000_name.sql` → `20240101000000`). */
function migrationVersion(name: string): string {
  return name.split("_", 1)[0] ?? name;
}

/** The Supabase CLI records each version once, so two migrations with one version stop the build. */
function assertUniqueVersions(migrations: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of migrations) {
    const version = migrationVersion(name);
    const earlier = seen.get(version);
    if (earlier) {
      throw new ToolError(
        `Two migrations share the version ${version}: ${earlier} and ${name}. The Supabase CLI cannot apply both to a fresh database.`,
        `Rename one of them in the project, or give one of them an unused version for this check with build.files in the config: { "path": "supabase/migrations/${name}", "version": "<unused version>" }.`,
      );
    }
    seen.set(version, name);
  }
}

/**
 * Builds the sandbox folder: a generated config.toml plus copies of the target's
 * migrations. The target folder is only read, never written (DESIGN.md section 2).
 */
export async function prepareSandbox(options: SandboxOptions): Promise<Sandbox> {
  const projectDir = resolve(options.projectDir);
  const supabaseDir = join(projectDir, "supabase");
  if (!existsSync(supabaseDir)) {
    throw new ToolError(
      `No supabase folder was found in ${projectDir}.`,
      "Point --project at the folder that contains supabase/migrations (usually the root of the app's repository).",
    );
  }
  const migrationsDir = join(supabaseDir, "migrations");
  const available = existsSync(migrationsDir) ? selectMigrationFiles(await readdir(migrationsDir)) : [];
  const excluded = new Set(options.excludeMigrations ?? []);
  const own = available.filter((name) => !excluded.has(name));
  const extras = (options.extraMigrations ?? []).map((path) => resolve(path));
  const buildFiles = options.buildFiles ?? [];
  if (own.length === 0 && extras.length === 0 && buildFiles.length === 0) {
    throw new ToolError(
      `No migration files were found in ${migrationsDir}.`,
      "The check builds the database from the project's migrations (files named like 20240101000000_name.sql).",
    );
  }
  const configPath = join(supabaseDir, "config.toml");
  const settings = parseTargetSettings(existsSync(configPath) ? await readFile(configPath, "utf8") : undefined);
  const slug = sandboxSlug(projectDir);
  const projectId = `${PROJECT_ID_PREFIX}${slug}`;
  const dir = join(resolve(options.workdir), slug);
  const sandboxMigrations = join(dir, "supabase", "migrations");
  await rm(join(dir, "supabase"), { recursive: true, force: true });
  await mkdir(sandboxMigrations, { recursive: true });
  const config = generateConfigToml(projectId, settings);
  await writeFile(join(dir, "supabase", "config.toml"), config);
  const hash = createHash("sha256").update(config);
  const migrations: string[] = [];
  for (const name of own) {
    await copyFile(join(migrationsDir, name), join(sandboxMigrations, name));
    migrations.push(name);
  }
  await copyBuildFiles(buildFiles, migrationsDir, sandboxMigrations, migrations, settings.notes);
  for (const path of extras) {
    const name = basename(path);
    if (!/^\d+_.*\.sql$/.test(name)) {
      throw new ToolError(
        `The migration ${name} is not named like a Supabase migration.`,
        "Migration files must be named <timestamp>_<name>.sql, for example 20261031120000_add_reports.sql.",
      );
    }
    if (migrations.includes(name)) {
      throw new ToolError(`The migration ${name} is already part of the project.`);
    }
    await copyFile(path, join(sandboxMigrations, name));
    migrations.push(name);
  }
  migrations.sort();
  assertUniqueVersions(migrations);
  for (const name of migrations) {
    hash.update(name).update(await readFile(join(sandboxMigrations, name)));
  }
  return { projectDir, dir, slug, projectId, settings, migrations, fingerprint: hash.digest("hex") };
}
