import assert from "node:assert/strict";
import { mkdir, mkdtemp as makeTemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { MigrationsFailed, ToolError } from "../../src/core/errors.ts";
import {
  EXCLUDED_SERVICES,
  generateConfigToml,
  parseTargetSettings,
  prepareSandbox,
  SANDBOX_PORTS,
  sandboxMigrationName,
  sandboxSlug,
  selectMigrationFiles,
} from "../../src/stack/sandbox.ts";
import { type CliResult, migrationErrorText, parseOwnStackIds, parseStatus, StackManager, summarizeCliFailure } from "../../src/stack/supabase.ts";

const scratch = fileURLToPath(new URL("../../.tlc-work/", import.meta.url));

/** Every temporary folder these tests create, removed again when the file's tests finish. */
const created: string[] = [];
async function mkdtemp(prefix: string): Promise<string> {
  const dir = await makeTemp(prefix);
  created.push(dir);
  return dir;
}
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

const ok = (stdout = ""): CliResult => ({ ok: true, missing: false, timedOut: false, stdout, stderr: "" });
const failed = (stderr: string): CliResult => ({ ok: false, missing: false, timedOut: false, stdout: "", stderr });
const STATUS = JSON.stringify({
  API_URL: "http://127.0.0.1:55421",
  DB_URL: "postgresql://postgres:postgres@127.0.0.1:55422/postgres",
  ANON_KEY: "anon-key",
  SERVICE_ROLE_KEY: "service-key",
});

async function makeProject(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "unit-project-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe("sandbox", () => {
  it("derives a container-safe slug with a hash of the absolute path", () => {
    const slug = sandboxSlug("/home/me/My App!");
    assert.match(slug, /^my-app-[0-9a-f]{6}$/);
    assert.notEqual(sandboxSlug("/a/app"), sandboxSlug("/b/app"));
  });

  it("copies only allow-listed settings and ignores env() values", () => {
    const settings = parseTargetSettings(`
      project_id = "real-project"
      [api]
      schemas = ["public", "api"]
      max_rows = 500
      [db]
      major_version = 15
      [auth]
      site_url = "https://example.com"
      [storage.buckets.avatars]
      public = true
      allowed_mime_types = ["image/png"]
      objects_path = "./avatars"
      [storage.buckets.secret]
      file_size_limit = "env(SIZE)"
      [api.tls]
      enabled = "env(TLS)"
    `);
    assert.deepEqual(settings.schemas, ["public", "api"]);
    assert.equal(settings.maxRows, 500);
    assert.equal(settings.majorVersion, 15);
    assert.deepEqual(settings.buckets, [
      { name: "avatars", public: true, allowedMimeTypes: ["image/png"] },
      { name: "secret", public: false },
    ]);
  });

  it("uses the Supabase defaults without a config.toml, and notes env() references", () => {
    const none = parseTargetSettings(undefined);
    assert.deepEqual(none.schemas, ["public", "graphql_public"]);
    assert.match(none.notes.join(" "), /no supabase\/config\.toml/);
    const env = parseTargetSettings('[api]\nschemas = "env(SCHEMAS)"\n');
    assert.deepEqual(env.schemas, ["public", "graphql_public"]);
    assert.match(env.notes.join(" "), /environment variable/);
    assert.throws(() => parseTargetSettings("[api\nbroken"), ToolError);
  });

  it("generates a config with its own ports, seed off and unneeded services off", () => {
    const text = generateConfigToml("tlc-demo-abc123", { ...parseTargetSettings(undefined), buckets: [{ name: "docs", public: false }] });
    const parsed = parseToml(text) as Record<string, Record<string, unknown>>;
    assert.equal(parsed.project_id as unknown, "tlc-demo-abc123");
    assert.equal(parsed.api?.port, SANDBOX_PORTS.api);
    assert.equal(parsed.db?.port, SANDBOX_PORTS.db);
    assert.equal((parsed.db?.seed as Record<string, unknown>).enabled, false);
    for (const section of ["realtime", "studio", "local_smtp", "edge_runtime", "analytics"]) {
      assert.equal(parsed[section]?.enabled, false, section);
    }
    assert.equal(((parsed.auth?.email as Record<string, unknown>) ?? {}).enable_confirmations, false);
    assert.equal(((parsed.storage?.buckets as Record<string, Record<string, unknown>>).docs ?? {}).public, false);
    assert.ok(EXCLUDED_SERVICES.includes("studio"));
  });

  it("selects migration files the way the CLI does", () => {
    assert.deepEqual(selectMigrationFiles(["20240102_b.sql", "seed.sql", "20240101_a.sql", "notes.md", "x_1.sql"]), ["20240101_a.sql", "20240102_b.sql"]);
  });

  it("copies migrations into the sandbox and never seed files, .env or functions", async () => {
    const project = await makeProject({
      "supabase/migrations/20240101000000_init.sql": "create table t (id int);",
      "supabase/migrations/20240102000000_more.sql": "create table u (id int);",
      "supabase/seed.sql": "insert into t values (1);",
      "supabase/.env": "SECRET=1",
      "supabase/functions/hello/index.ts": "export {}",
    });
    const workdir = await mkdtemp(join(scratch, "unit-work-"));
    const sandbox = await prepareSandbox({ projectDir: project, workdir, excludeMigrations: ["20240102000000_more.sql"] });
    assert.deepEqual(sandbox.migrations, ["20240101000000_init.sql"]);
    assert.deepEqual(await readdir(join(sandbox.dir, "supabase")), ["config.toml", "migrations"]);
    assert.deepEqual(await readdir(join(sandbox.dir, "supabase", "migrations")), ["20240101000000_init.sql"]);
    assert.match(await readFile(join(sandbox.dir, "supabase", "config.toml"), "utf8"), /project_id = "tlc-/);
    assert.equal(sandbox.projectId, `tlc-${sandbox.slug}`);
    const again = await prepareSandbox({ projectDir: project, workdir, excludeMigrations: ["20240102000000_more.sql"] });
    assert.equal(again.fingerprint, sandbox.fingerprint);
    const full = await prepareSandbox({ projectDir: project, workdir });
    assert.notEqual(full.fingerprint, sandbox.fingerprint);
  });

  it("explains a missing supabase folder or missing migrations", async () => {
    const empty = await makeProject({ "README.md": "x" });
    await assert.rejects(prepareSandbox({ projectDir: empty, workdir: scratch }), /No supabase folder/);
    const noMigrations = await makeProject({ "supabase/config.toml": "" });
    await assert.rejects(prepareSandbox({ projectDir: noMigrations, workdir: scratch }), /No migration files/);
  });

  it("slots build files into the migration order and can give a project migration a new version", async () => {
    const project = await makeProject({
      "supabase/schema.sql": "create table base (id int);",
      "supabase/migrations/add_extra.sql": "alter table base add column x int;",
      "supabase/migrations/20240101000000_init.sql": "create table t (id int);",
      "supabase/migrations/20240102000000_a.sql": "select 1;",
      "supabase/migrations/20240102000000_b.sql": "select 2;",
    });
    const workdir = await mkdtemp(join(scratch, "unit-work-"));
    await assert.rejects(
      prepareSandbox({ projectDir: project, workdir }),
      (error: unknown) =>
        error instanceof ToolError &&
        /Two migrations share the version 20240102000000: 20240102000000_a\.sql and 20240102000000_b\.sql/.test(error.message) &&
        /build\.files/.test(error.hint ?? ""),
    );
    const migrations = join(project, "supabase", "migrations");
    const sandbox = await prepareSandbox({
      projectDir: project,
      workdir,
      buildFiles: [
        { path: join(project, "supabase", "schema.sql"), version: "20230101000000" },
        { path: join(migrations, "add_extra.sql"), version: "20240101000001" },
        { path: join(migrations, "20240102000000_b.sql"), version: "20240102000001" },
      ],
    });
    assert.deepEqual(sandbox.migrations, [
      "20230101000000_schema.sql",
      "20240101000000_init.sql",
      "20240101000001_add_extra.sql",
      "20240102000000_a.sql",
      "20240102000001_b.sql",
    ]);
    assert.deepEqual((await readdir(join(sandbox.dir, "supabase", "migrations"))).sort(), sandbox.migrations);
    assert.equal(await readFile(join(sandbox.dir, "supabase", "migrations", "20230101000000_schema.sql"), "utf8"), "create table base (id int);");
    assert.match(sandbox.settings.notes.join(" "), /Applied the migration 20240102000000_b\.sql as 20240102000001_b\.sql/);
    assert.match(sandbox.settings.notes.join(" "), /schema\.sql to the build as 20230101000000_schema\.sql/);
    // The project folder itself is never written to.
    assert.deepEqual((await readdir(migrations)).sort(), ["20240101000000_init.sql", "20240102000000_a.sql", "20240102000000_b.sql", "add_extra.sql"]);
  });

  it("in migration mode, applies a re-versioned migration under test once, under its build name", async () => {
    const project = await makeProject({
      "supabase/migrations/20240101000000_init.sql": "create table t (id int);",
      "supabase/migrations/20240102000000_a.sql": "select 1;",
      "supabase/migrations/20240102000000_b.sql": "alter table t add column x int;",
    });
    const workdir = await mkdtemp(join(scratch, "unit-work-"));
    const underTest = join(project, "supabase", "migrations", "20240102000000_b.sql");
    const buildFiles = [{ path: underTest, version: "20240102000001" }];
    assert.equal(sandboxMigrationName(underTest, buildFiles), "20240102000001_b.sql");
    assert.equal(sandboxMigrationName(join(project, "other.sql"), buildFiles), "other.sql");
    const before = await prepareSandbox({ projectDir: project, workdir, excludeMigrations: ["20240102000000_b.sql"], buildFiles });
    assert.deepEqual(before.migrations, ["20240101000000_init.sql", "20240102000000_a.sql"]);
    const after = await prepareSandbox({
      projectDir: project,
      workdir,
      excludeMigrations: ["20240102000000_b.sql"],
      extraMigrations: [underTest],
      buildFiles,
    });
    assert.deepEqual(after.migrations, ["20240101000000_init.sql", "20240102000000_a.sql", "20240102000001_b.sql"]);
    assert.deepEqual((await readdir(join(after.dir, "supabase", "migrations"))).sort(), after.migrations);
  });

  it("explains a missing build file and a build file that clashes with a migration", async () => {
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;", "supabase/init.sql": "select 2;" });
    const workdir = await mkdtemp(join(scratch, "unit-work-"));
    await assert.rejects(
      prepareSandbox({ projectDir: project, workdir, buildFiles: [{ path: join(project, "nope.sql"), version: "1" }] }),
      /build file .*nope\.sql .*does not exist/,
    );
    await assert.rejects(
      prepareSandbox({ projectDir: project, workdir, buildFiles: [{ path: join(project, "supabase", "init.sql"), version: "20240101000000" }] }),
      /clashes with a migration of the same name/,
    );
  });
});

describe("supabase CLI wrapper", () => {
  it("reads local credentials from status and refuses non-local URLs", () => {
    const creds = parseStatus(STATUS);
    assert.equal(creds.apiUrl, "http://127.0.0.1:55421");
    assert.throws(() => parseStatus(JSON.stringify({ ...JSON.parse(STATUS), API_URL: "https://abc.supabase.co" })), /Refusing to connect/);
    assert.throws(() => parseStatus(JSON.stringify({ API_URL: "http://127.0.0.1:1" })), /did not report its DB_URL/);
    assert.throws(() => parseStatus("not json"), ToolError);
  });

  it("finds only tool-owned stacks", () => {
    assert.deepEqual(parseOwnStackIds("supabase_db_tlc-demo-abc123\nsupabase_db_myapp\nsupabase_db_tlc-x-1\n"), ["tlc-demo-abc123", "tlc-x-1"]);
  });

  it("removes keys and connection strings from CLI errors", () => {
    const text = summarizeCliFailure(failed("error: eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc sb_secret_123 postgresql://postgres:pw@127.0.0.1:5432/db"));
    assert.doesNotMatch(text, /eyJ|sb_secret|pw@/);
    const quoted = summarizeCliFailure(failed("failed to connect to postgres://postgres:it's\"a secret@127.0.0.1:55422/postgres"));
    assert.doesNotMatch(quoted, /it's|a secret/);
    assert.match(quoted, /postgres:\/\/\[redacted\]@127\.0\.0\.1:55422\/postgres/);
  });

  function fakes(running: string[], responses: Record<string, CliResult>) {
    const calls: string[] = [];
    const manager = new StackManager({
      cli: async (args) => {
        const command = args.join(" ");
        calls.push(command);
        const key = Object.keys(responses).find((prefix) => command.startsWith(prefix));
        return key ? (responses[key] as CliResult) : ok();
      },
      docker: async () => ok(running.map((id) => `supabase_db_${id}`).join("\n")),
    });
    return { manager, calls };
  }

  it("stops other tool stacks, starts with the reduced service list and reads status", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const { manager, calls } = fakes(["tlc-other-111111"], { status: ok(STATUS) });
    const creds = await manager.ensureFresh(sandbox);
    assert.equal(creds.dbUrl, "postgresql://postgres:postgres@127.0.0.1:55422/postgres");
    assert.equal(calls[0], "stop --project-id tlc-other-111111 --no-backup");
    assert.match(calls[1] ?? "", new RegExp(`^start -x ${EXCLUDED_SERVICES.join(",")} --workdir `));
    assert.ok(calls.every((call) => !/link|push|login|--linked/.test(call)), "never runs remote commands");
  });

  it("resets a running stack for the same sandbox instead of restarting it", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const { manager, calls } = fakes([sandbox.projectId], { status: ok(STATUS) });
    await manager.ensureFresh(sandbox);
    assert.match(calls[0] ?? "", /^db reset --local --no-seed --workdir /);
    assert.ok(!calls.some((call) => call.startsWith("start")));
  });

  it("reports a failed start in plain words and cleans up", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const { manager, calls } = fakes([], { start: failed('ERROR: relation "missing" does not exist (SQLSTATE 42P01)') });
    await assert.rejects(manager.ensureFresh(sandbox), (error: unknown) => error instanceof ToolError && /migrations could not be applied/.test(error.message));
    assert.ok(calls.some((call) => call.startsWith(`stop --project-id ${sandbox.projectId}`)));
  });

  it("applies new migrations with migration up --local and returns a readable failure", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const { manager, calls } = fakes([], {});
    assert.deepEqual(await manager.migrationUp(sandbox), { ok: true });
    assert.equal(calls[0], `migration up --local --workdir ${sandbox.dir}`);
    const cliError = JSON.stringify({ _tag: "Error", error: { message: 'ERROR: column "code" contains null values (SQLSTATE 23502)\nAt statement: 1\nalter table t add column code text not null' } });
    const failing = fakes([], { "migration up": failed(`Applying migration 20240101000000_init.sql...\n${cliError}`) });
    assert.deepEqual(await failing.manager.migrationUp(sandbox), {
      ok: false,
      detail: 'ERROR: column "code" contains null values (SQLSTATE 23502). Failing statement: alter table t add column code text not null',
    });
  });

  it("throws MigrationsFailed when the migrations themselves fail on a fresh database", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const { manager } = fakes([], { start: failed('Applying migration 20240101000000_init.sql...\nERROR: relation "missing" does not exist (SQLSTATE 42P01)\nAt statement 0: select * from missing') });
    await assert.rejects(manager.ensureFresh(sandbox), (error: unknown) => {
      assert.ok(error instanceof MigrationsFailed);
      assert.equal(error.detail, 'ERROR: relation "missing" does not exist (SQLSTATE 42P01). Failing statement: select * from missing');
      return true;
    });
    const timedOut = fakes([], { start: { ...failed("migration step"), timedOut: true } });
    await assert.rejects(timedOut.manager.ensureFresh(sandbox), (error: unknown) => error instanceof ToolError && !(error instanceof MigrationsFailed));
  });

  it("keeps the migration error readable whatever form the CLI prints it in", () => {
    assert.equal(migrationErrorText('ERROR: syntax error at or near "tabel" (SQLSTATE 42601)'), 'ERROR: syntax error at or near "tabel" (SQLSTATE 42601)');
    assert.equal(migrationErrorText("something odd\nhappened"), "something odd / happened");
  });

  it("says so when the CLI is missing", async () => {
    const workdir = await mkdtemp(join(scratch, "unit-stack-"));
    const project = await makeProject({ "supabase/migrations/20240101000000_init.sql": "select 1;" });
    const sandbox = await prepareSandbox({ projectDir: project, workdir });
    const manager = new StackManager({
      cli: async () => ({ ok: false, missing: true, timedOut: false, stdout: "", stderr: "" }),
      docker: async () => ok(""),
    });
    await assert.rejects(manager.ensureFresh(sandbox), /supabase command is not installed/);
  });
});
