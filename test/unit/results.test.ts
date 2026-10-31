import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRunSummary } from "../../src/commands/run.ts";
import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT } from "../../src/core/exit-codes.ts";
import { checkId, inconclusive, isFailureToTest, leaked, notTested, passed, summarize, type CheckSpec } from "../../src/core/results.ts";
import type { RunResult } from "../../src/engine.ts";

const spec = (operation: string, actor: "tenant_a" | "anon" = "tenant_a"): CheckSpec => ({ kind: "table", target: "public.invoices", operation, actor });
const evidence = { actor: "tenant_a" as const, requests: [], summary: "Tenant A read tenant B's data from public.invoices." };

describe("check results", () => {
  it("builds stable check ids", () => {
    assert.equal(checkId("table", "public.invoices", "select", "tenant_a"), "table:public.invoices:select:tenant_a");
    assert.equal(passed(spec("select"), undefined).id, "table:public.invoices:select:tenant_a");
  });

  it("only failure-type gaps stop a clean result", () => {
    assert.equal(isFailureToTest(notTested(spec("select"), "not_applicable", "shared")), false);
    assert.equal(isFailureToTest(notTested(spec("select"), "excluded", "config")), false);
    assert.equal(isFailureToTest(notTested(spec("select"), "could_not_test", "seed failed")), true);
    assert.equal(isFailureToTest(inconclusive(spec("select"), "server error")), true);
  });

  it("applies the exit-code rules", () => {
    const pass = passed(spec("select"), undefined);
    assert.equal(summarize([pass, notTested(spec("insert"), "not_applicable", "n/a")]).exitCode, EXIT.clean);
    assert.equal(summarize([pass, leaked(spec("update"), evidence), inconclusive(spec("delete"), "x")]).exitCode, EXIT.leaks);
    assert.equal(summarize([pass, notTested(spec("insert"), "could_not_test", "x")]).exitCode, EXIT.inconclusive);
    assert.equal(summarize([pass], ["Tenant A could not read anything."]).exitCode, EXIT.inconclusive);
    const empty = summarize([]);
    assert.equal(empty.exitCode, EXIT.inconclusive);
    assert.match(empty.runProblems.join(" "), /nothing was proven/);
  });

  it("counts every status", () => {
    const summary = summarize([passed(spec("select"), undefined), leaked(spec("update"), evidence), inconclusive(spec("delete"), "x")]);
    assert.deepEqual(summary.counts, { pass: 1, leak: 1, not_tested: 0, inconclusive: 1 });
    assert.equal(summary.failuresToTest, 1);
    assert.equal(summary.verdict, "leaks_found");
  });
});

describe("CLI run summary", () => {
  function result(checks: RunResult["checks"], problems: string[] = []): RunResult {
    return {
      tool: { name: "tenant-leak-check", version: "0.1.0" },
      disclaimer: DISCLAIMER_FULL,
      generatedAt: "2026-10-31T00:00:00.000Z",
      target: { name: "demo", projectDir: "/x/demo", migrations: ["1_a.sql"], fingerprint: "f" },
      scope: { schemas: ["public"], tables: ["public.invoices"], views: [], functions: [], buckets: [], extensionObjects: [], notes: [] },
      tenancy: { tables: [], notes: [] },
      seeding: { tables: [], buckets: [], notes: [] },
      checks,
      findings: [],
      warnings: [],
      positiveControls: [],
      summary: summarize(checks, problems),
    };
  }

  it("lists leaks with their summaries, plus the disclaimer and exit code", () => {
    const text = formatRunSummary(result([leaked(spec("select"), evidence)]));
    assert.match(text, /LEAKS FOUND/);
    assert.match(text, /LEAK {2}table:public\.invoices:select:tenant_a/);
    assert.match(text, /Tenant A read tenant B's data/);
    assert.ok(text.includes(DISCLAIMER_SHORT));
    assert.match(text, /Exit code 1: /);
  });

  it("lists what could not be tested and why", () => {
    const text = formatRunSummary(result([passed(spec("select"), undefined), notTested(spec("insert"), "could_not_test", "The seed failed.")], ["Setup looks wrong."]));
    assert.match(text, /not a clean result/);
    assert.match(text, /NOT TESTED {2}table:public\.invoices:insert:tenant_a/);
    assert.match(text, /The seed failed\./);
    assert.match(text, /Setup looks wrong\./);
    assert.match(text, /Exit code 2: /);
  });

  it("never calls a clean result secure or certified", () => {
    const text = formatRunSummary(result([passed(spec("select"), undefined)]));
    assert.match(text, /No leaks found/);
    assert.doesNotMatch(text.replace(DISCLAIMER_SHORT, ""), /\b(secure|certified|compliant)\b/i);
  });
});
