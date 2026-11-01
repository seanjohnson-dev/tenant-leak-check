import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { toolVersion } from "../../src/cli.ts";
import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT } from "../../src/core/exit-codes.ts";
import { isFailureToTest } from "../../src/core/results.ts";
import { runCheck, type RunResult } from "../../src/engine.ts";
import { PROJECT_ID_PREFIX, sandboxSlug } from "../../src/stack/sandbox.ts";
import { StackManager } from "../../src/stack/supabase.ts";
import { esc } from "../../src/report/html.ts";
import { validate } from "../unit/schema-validator.ts";

/*
 * Needs Docker and the Supabase CLI (run with: npm run test:integration).
 * Proves the promise of demo/leaks.json: every planted leak is caught on demo/broken,
 * nothing else is reported, and demo/fixed is clean with every one of those checks run.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const workdir = `${repo}.tlc-work`;
const brokenDir = `${repo}demo/broken`;
const fixedDir = `${repo}demo/fixed`;

interface ManifestLeak {
  id: string;
  category: string;
  checks: string[];
  warnings: { rule: string; object: string }[];
}

const manifest = JSON.parse(readFileSync(`${repo}demo/leaks.json`, "utf8")) as { leaks: ManifestLeak[] };
const expectedLeaks = manifest.leaks.flatMap((leak) => leak.checks);
const expectedWarnings = manifest.leaks.flatMap((leak) => leak.warnings.map((w) => `${w.rule} | ${w.object}`));

function run(projectDir: string): Promise<RunResult> {
  return runCheck({ projectDir, workdir, keepRunning: true, toolVersion: toolVersion() });
}

const reportsDir = `${workdir}/it-demo-reports`;
const schema = JSON.parse(readFileSync(`${repo}docs/report.schema.json`, "utf8")) as Record<string, unknown>;

function runCli(projectDir: string, keepRunning: boolean, out: string): Promise<{ code: number; stdout: string }> {
  const args = [cli, "run", "--project", projectDir, "--workdir", workdir, "--out", out, ...(keepRunning ? ["--keep-running"] : [])];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 }, (error, stdout) => {
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

describe("demo/broken: every planted leak is caught", { timeout: TIMEOUT }, () => {
  let result: RunResult;
  before(async () => {
    result = await run(brokenDir);
  }, { timeout: TIMEOUT });

  it("finds leaks, so the exit code is 1", () => {
    assert.equal(result.summary.verdict, "leaks_found");
    assert.equal(result.summary.exitCode, EXIT.leaks);
    assert.deepEqual(result.summary.runProblems, []);
  });

  for (const leak of manifest.leaks) {
    it(`${leak.id} (${leak.category}) is reported as a leak with evidence and a fix`, () => {
      for (const id of leak.checks) {
        const check = result.checks.find((c) => c.id === id);
        assert.ok(check, `${id} was not run`);
        assert.equal(check.status, "leak", `${id} should be a leak but was ${check.status}: ${check.reason ?? check.notes.join(" ")}`);
        assert.ok(check.evidence && check.evidence.requests.length > 0, `${id} has no request evidence`);
        assert.ok(check.evidence.summary.length > 0 && check.evidence.after, `${id} has no evidence of what came back or changed`);
        const finding = result.findings.find((f) => f.checkId === id);
        assert.ok(finding && finding.problem && finding.fix, `${id} has no plain-English fix`);
      }
      for (const warning of leak.warnings) {
        assert.ok(
          result.warnings.some((w) => w.rule === warning.rule && w.object === warning.object),
          `warning ${warning.rule} on ${warning.object} is missing`,
        );
      }
    });
  }

  it("reports no leaks beyond the planted ones", () => {
    const reported = result.checks.filter((c) => c.status === "leak").map((c) => c.id).sort();
    assert.deepEqual(reported, [...expectedLeaks].sort());
  });

  it("raises exactly the expected schema warnings", () => {
    assert.deepEqual(result.warnings.map((w) => `${w.rule} | ${w.object}`).sort(), [...expectedWarnings].sort());
  });

  it("tested everything else: nothing inconclusive or untested for a failure reason", () => {
    const gaps = result.checks.filter(isFailureToTest).map((c) => `${c.id}: ${c.reason}`);
    assert.deepEqual(gaps, []);
  });

  it("passes the correctly protected tables", () => {
    for (const table of ["public.organizations", "public.org_members", "public.clients", "public.notes", "public.activity_log"]) {
      const checks = result.checks.filter((c) => c.target === table && c.status !== "not_tested");
      assert.ok(checks.length >= 5, `${table} was not probed`);
      for (const check of checks) assert.equal(check.status, "pass", `${check.id} should pass`);
    }
  });

  it("detects the tenancy model of the demo", () => {
    const kind = (table: string): string | undefined => result.tenancy.tables.find((t) => t.table === table)?.ownership.kind;
    assert.equal(result.tenancy.tenantRoot, "public.organizations");
    assert.equal(result.tenancy.membership?.table, "public.org_members");
    assert.equal(kind("public.invoices"), "tenant");
    assert.equal(kind("public.notes"), "user");
    assert.equal(kind("public.profiles"), "user");
    assert.equal(kind("public.payments"), "inherited");
    assert.equal(kind("public.tasks"), "inherited");
    assert.equal(kind("public.plans"), "shared");
    assert.ok(result.seeding.tables.every((t) => !t.failure && t.rows > 0), "every table was seeded");
    assert.ok(result.seeding.buckets.every((b) => !b.failure && b.files > 0), "every bucket was seeded");
  });

  it("carries the disclaimer and never leaks keys, tokens or passwords", () => {
    assert.equal(result.disclaimer, DISCLAIMER_FULL);
    assertNoSecrets(JSON.stringify(result));
  });
});

describe("demo/broken through the CLI", { timeout: TIMEOUT }, () => {
  it("exits with code 1 and lists every planted leak", async () => {
    const { code, stdout } = await runCli(brokenDir, true, `${reportsDir}/broken`);
    assert.equal(code, EXIT.leaks, stdout);
    for (const id of expectedLeaks) assert.ok(stdout.includes(`LEAK  ${id}`), `${id} missing from the CLI output`);
    assert.ok(stdout.includes(DISCLAIMER_SHORT));
    assert.match(stdout, /Exit code 1: /);
    assertNoSecrets(stdout);
  });

  it("writes JSON, Markdown and HTML reports with every planted leak, its evidence and fix", async () => {
    const json = JSON.parse(await readFile(`${reportsDir}/broken/report.json`, "utf8")) as { mode: string; summary: { exitCode: number }; findings: { checkId: string }[] };
    assert.deepEqual(validate(schema, json), []);
    assert.equal(json.mode, "run");
    assert.equal(json.summary.exitCode, EXIT.leaks);
    assert.deepEqual(json.findings.map((f) => f.checkId).sort(), [...expectedLeaks].sort());
    const markdown = await readFile(`${reportsDir}/broken/report.md`, "utf8");
    const html = await readFile(`${reportsDir}/broken/report.html`, "utf8");
    assert.ok(markdown.includes(DISCLAIMER_FULL));
    assert.ok(html.includes(esc(DISCLAIMER_FULL)));
    for (const text of [markdown, html]) {
      assert.ok(text.includes(`Leaks found (${expectedLeaks.length})`));
      for (const id of expectedLeaks) assert.ok(text.includes(id), `${id} missing from a report`);
      assertNoSecrets(text);
    }
    assert.doesNotMatch(html, /<script/i);
  });
});

describe("demo/fixed: clean, with every check actually run", { timeout: TIMEOUT }, () => {
  let result: RunResult;
  before(async () => {
    result = await run(fixedDir);
  }, { timeout: TIMEOUT });

  it("finds no leaks and nothing unclear, so the exit code is 0", () => {
    assert.equal(result.summary.counts.leak, 0, result.checks.filter((c) => c.status === "leak").map((c) => c.id).join(", "));
    assert.deepEqual(result.checks.filter(isFailureToTest).map((c) => `${c.id}: ${c.reason}`), []);
    assert.deepEqual(result.summary.runProblems, []);
    assert.equal(result.summary.verdict, "clean");
    assert.equal(result.summary.exitCode, EXIT.clean);
  });

  for (const leak of manifest.leaks) {
    it(`${leak.id} is fixed: each of its checks ran and passed`, () => {
      for (const id of leak.checks) {
        const check = result.checks.find((c) => c.id === id);
        assert.ok(check, `${id} was not run on the fixed app`);
        assert.equal(check.status, "pass", `${id} should pass on the fixed app but was ${check.status}`);
        assert.ok(check.evidence && check.evidence.requests.length > 0, `${id} has no evidence that it was tried`);
      }
    });
  }

  it("raises no schema warnings", () => {
    assert.deepEqual(result.warnings, []);
  });

  it("tenant A could read its own data (the positive control)", () => {
    assert.ok(result.positiveControls.some((c) => c.ownRowVisible));
    const own = result.positiveControls.filter((c) => c.table !== "public.activity_log");
    assert.ok(own.every((c) => c.ownRowVisible), JSON.stringify(own));
  });
});

describe("demo/fixed through the CLI", { timeout: TIMEOUT }, () => {
  it("exits with code 0 and writes a clean, valid report", async () => {
    const { code, stdout } = await runCli(fixedDir, false, `${reportsDir}/fixed`);
    assert.equal(code, EXIT.clean, stdout);
    const json = JSON.parse(await readFile(`${reportsDir}/fixed/report.json`, "utf8")) as { summary: { verdict: string } };
    assert.deepEqual(validate(schema, json), []);
    assert.equal(json.summary.verdict, "clean");
    assert.match(await readFile(`${reportsDir}/fixed/report.html`, "utf8"), /No leaks found/);
    assert.match(stdout, /No leaks found\. Every in-scope check was tested and blocked\./);
    assert.ok(stdout.includes(DISCLAIMER_SHORT));
    assertNoSecrets(stdout);
  });
});

after(async () => {
  await rm(reportsDir, { recursive: true, force: true });
  const stack = new StackManager();
  const ours = new Set([brokenDir, fixedDir].map((dir) => `${PROJECT_ID_PREFIX}${sandboxSlug(dir)}`));
  for (const id of await stack.runningOwnStacks()) if (ours.has(id)) await stack.stopProject(id);
});
