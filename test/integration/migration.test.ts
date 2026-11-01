import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { toolVersion } from "../../src/cli.ts";
import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT } from "../../src/core/exit-codes.ts";
import { isFailureToTest } from "../../src/core/results.ts";
import { type DiffResult, runDiff } from "../../src/migrate/diff.ts";
import { esc } from "../../src/report/html.ts";
import { renderJson } from "../../src/report/json.ts";
import { PROJECT_ID_PREFIX, sandboxSlug } from "../../src/stack/sandbox.ts";
import { StackManager } from "../../src/stack/supabase.ts";
import { validate } from "../unit/schema-validator.ts";

/*
 * Needs Docker and the Supabase CLI (run with: npm run test:integration).
 * Proves demo/migrations/expected.json: migration mode catches every planted regression in the
 * bad migration (new leaks, policy removed, RLS disabled, column and table dropped, table emptied),
 * passes the good one, and asks for a review on the one that only fails on existing data.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const workdir = `${repo}.tlc-work`;
const fixedDir = `${repo}demo/fixed`;
const scratch = `${workdir}/it-migration`;
const schema = JSON.parse(readFileSync(`${repo}docs/report.schema.json`, "utf8")) as Record<string, unknown>;

interface Case {
  id: string;
  migration: string;
  exitCode: number;
  verdict: string;
  applyOnSeededData: boolean;
  newLeaks: string[];
  removedChecks: string[];
  addedChecks: string[];
  statements: { line: number; rule: string; severity: string; object: string }[];
  review: string[];
  catalogChanges: { kind: string; object: string }[];
}

const expected = JSON.parse(readFileSync(`${repo}demo/migrations/expected.json`, "utf8")) as { cases: Case[] };

function diff(migration: string): Promise<DiffResult> {
  return runDiff({ projectDir: fixedDir, migrations: [migration], workdir, keepRunning: true, toolVersion: toolVersion() });
}

function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      resolve({ code, stdout });
    });
  });
}

function assertNoSecrets(text: string): void {
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JWT appeared in the output");
  assert.doesNotMatch(text, /sb_secret_|sb_publishable_/, "an API key appeared in the output");
  assert.doesNotMatch(text, /postgres:postgres@/, "the database password appeared in the output");
}

const TIMEOUT = 20 * 60_000;

for (const c of expected.cases) {
  describe(`migration mode: demo/migrations/${c.id}`, { timeout: TIMEOUT }, () => {
    let result: DiffResult;
    before(async () => {
      result = await diff(`${repo}${c.migration}`);
    }, { timeout: TIMEOUT });

    it(`exits with code ${c.exitCode} (${c.verdict})`, () => {
      assert.equal(result.summary.verdict, c.verdict, result.migration.headline);
      assert.equal(result.summary.exitCode, c.exitCode);
      assert.equal(result.migration.apply.onFreshDatabase.ok, true);
      assert.equal(result.migration.apply.onSeededData.ok, c.applyOnSeededData, result.migration.apply.onSeededData.error);
    });

    it("reports exactly the expected new leaks, each with evidence and a fix", () => {
      assert.deepEqual(result.migration.results.newLeaks.map((ch) => ch.id).sort(), [...c.newLeaks].sort());
      for (const id of c.newLeaks) {
        const check = result.checks.find((ch) => ch.id === id);
        assert.ok(check?.evidence && check.evidence.requests.length > 0 && check.evidence.after, `${id} has no evidence`);
        assert.ok(result.findings.find((f) => f.checkId === id)?.fix, `${id} has no fix`);
        assert.equal(result.migration.before.checks.find((ch) => ch.id === id)?.status, "pass", `${id} should have passed before the migration`);
      }
      assert.deepEqual(result.migration.results.fixedLeaks, []);
      assert.deepEqual(result.migration.results.stillLeaking, []);
    });

    it("flags exactly the expected statements with their line numbers, and the expected review items", () => {
      assert.deepEqual(
        result.migration.statements.map(({ line, rule, severity, object }) => ({ line, rule, severity, object })),
        c.statements.map(({ line, rule, severity, object }) => ({ line, rule, severity, object })),
      );
      assert.deepEqual(result.migration.review.map((item) => item.topic), c.review);
    });

    it("finds exactly the expected changes in the database structure", () => {
      assert.deepEqual(
        result.migration.catalogChanges.map((ch) => `${ch.kind} ${ch.object}`).sort(),
        c.catalogChanges.map((ch) => `${ch.kind} ${ch.object}`).sort(),
      );
    });

    it("tracks the checks of removed and added objects", () => {
      assert.deepEqual(result.migration.results.removed.map((ch) => ch.id).sort(), [...c.removedChecks].sort());
      assert.deepEqual(result.migration.results.added.map((ch) => ch.id).sort(), [...c.addedChecks].sort());
      for (const id of c.addedChecks) assert.equal(result.checks.find((ch) => ch.id === id)?.status, "pass", `${id} should pass`);
    });

    it("tested everything before and after: nothing unclear or untested for a failure reason", () => {
      assert.deepEqual(result.checks.filter(isFailureToTest).map((ch) => `${ch.id}: ${ch.reason}`), []);
      assert.deepEqual(result.migration.before.checks.filter(isFailureToTest).map((ch) => ch.id), []);
      assert.deepEqual(result.migration.results.noLongerTested, []);
      assert.equal(result.migration.before.summary.verdict, "clean", "demo/fixed is clean before every demo migration");
    });

    it("carries the disclaimer and never leaks keys, tokens or passwords", () => {
      assert.equal(result.disclaimer, DISCLAIMER_FULL);
      assertNoSecrets(JSON.stringify(result));
    });
  });
}

describe("migration mode through the CLI, with the written reports", { timeout: TIMEOUT }, () => {
  const bad = expected.cases.find((c) => c.id === "bad") as Case;
  const out = `${scratch}/bad-report`;

  it("exits with code 1, prints every new leak and review item, and writes valid reports", async () => {
    const { code, stdout } = await runCli(["diff", "--project", fixedDir, "--migration", `${repo}${bad.migration}`, "--workdir", workdir, "--out", out, "--keep-running"]);
    assert.equal(code, EXIT.leaks, stdout);
    for (const id of bad.newLeaks) assert.ok(stdout.includes(`NEW LEAK  ${id}`), `${id} missing from the CLI output`);
    for (const statement of bad.statements) assert.ok(stdout.includes(`line ${statement.line}: `), `review line ${statement.line} missing`);
    assert.ok(stdout.includes(DISCLAIMER_SHORT));
    assertNoSecrets(stdout);

    const json = JSON.parse(await readFile(`${out}/report.json`, "utf8")) as Record<string, unknown>;
    assert.deepEqual(validate(schema, json), []);
    assert.equal(json.mode, "diff");
    const markdown = await readFile(`${out}/report.md`, "utf8");
    const html = await readFile(`${out}/report.html`, "utf8");
    for (const [text, disclaimer] of [[markdown, DISCLAIMER_FULL], [html, esc(DISCLAIMER_FULL)]] as const) {
      assert.ok(text.includes(disclaimer));
      assert.ok(text.includes("What this migration changes"));
      for (const id of bad.newLeaks) assert.ok(text.includes(id), `${id} missing from a report`);
      assertNoSecrets(text);
    }
    assert.doesNotMatch(html, /<script/i);
  });
});

describe("a migration that cannot be applied at all", { timeout: TIMEOUT }, () => {
  let result: DiffResult;
  before(async () => {
    await mkdir(scratch, { recursive: true });
    const path = `${scratch}/20261101090000_typo.sql`;
    await writeFile(path, "-- Synthetic test migration with a mistake in it.\nalter table public.no_such_table add column note text;\n");
    result = await diff(path);
  }, { timeout: TIMEOUT });

  it("needs a review (exit code 4) and says nothing could be tested after it", () => {
    assert.equal(result.summary.exitCode, EXIT.migrationReview);
    assert.equal(result.summary.verdict, "review_needed");
    assert.equal(result.migration.apply.onSeededData.ok, false);
    assert.equal(result.migration.apply.onFreshDatabase.ok, false);
    assert.match(result.migration.apply.onFreshDatabase.error ?? "", /no_such_table/);
    assert.deepEqual(result.migration.review.map((item) => item.topic), ["fails_to_apply"]);
    assert.deepEqual(result.checks, []);
    assert.match(result.migration.headline, /could not be applied/);
    assert.equal(result.migration.before.summary.verdict, "clean");
    assert.deepEqual(validate(schema, JSON.parse(renderJson(result))), []);
  });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  const stack = new StackManager();
  const ours = `${PROJECT_ID_PREFIX}${sandboxSlug(fixedDir)}`;
  for (const id of await stack.runningOwnStacks()) if (id === ours) await stack.stopProject(id);
});
