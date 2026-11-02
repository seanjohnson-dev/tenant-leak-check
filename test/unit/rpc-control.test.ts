import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { formatRunSummary } from "../../src/commands/run.ts";
import { emptyConfig } from "../../src/config/config.ts";
import { summarize } from "../../src/core/results.ts";
import { EXIT } from "../../src/core/exit-codes.ts";
import { buildTenancyModel } from "../../src/discover/tenancy.ts";
import type { ProbeContext } from "../../src/probe/common.ts";
import type { HttpResponse, RequestOptions } from "../../src/probe/http.ts";
import { controlOutcome, inputRefusal, probeFunction, quietCallOutcome } from "../../src/probe/rpc.ts";
import { renderHtml } from "../../src/report/html.ts";
import { buildJsonReport } from "../../src/report/json.ts";
import { renderMarkdown } from "../../src/report/markdown.ts";
import type { SeedResult } from "../../src/seed/rows.ts";
import { agencyCatalog, fn, type } from "./fixtures.ts";
import { sampleRun } from "./report-fixtures.ts";
import { validate } from "./schema-validator.ts";

/*
 * RPC checks never pass on an input refusal: tenant B (the owner of the data the request
 * points at) first sends the identical request as a control. Only if that works are tenant A
 * and the anonymous visitor tried, and an input refusal for them is unclear, not a pass.
 */

const B_MARKER = "tlc-B-invoices-1-abc123";
const answer = (status: number, json: unknown, error?: { code: string; message: string }): HttpResponse => ({
  status,
  json,
  text: JSON.stringify(json),
  ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
});
const OK_WITH_B = answer(200, [{ id: "inv-b", number: B_MARKER }]);
const EMPTY = answer(200, []);
const DENIED = answer(401, { code: "42501", message: "permission denied for function get_invoice" }, { code: "42501", message: "permission denied for function get_invoice" });
const NOT_YOURS = answer(400, { code: "P0001", message: "Not your invoice" }, { code: "P0001", message: "Not your invoice" });
const UNKNOWN_ACTION = answer(400, { code: "P0001", message: "unknown action" }, { code: "P0001", message: "unknown action" });

type Who = "owner" | "tenant_a" | "anon";

function whoCalled(options: RequestOptions): Who {
  if (options.caller.kind === "anon") return "anon";
  if (options.caller.kind === "user" && options.caller.accessToken === "token-b") return "owner";
  if (options.caller.kind === "user" && options.caller.accessToken === "token-a") return "tenant_a";
  throw new Error(`unexpected caller ${options.caller.kind}`);
}

/** A probe context with a fake API that answers per caller, and a world that never changes. */
function fakeContext(answers: Record<Who, HttpResponse>): { ctx: ProbeContext; calls: Who[]; restores: () => number } {
  const catalog = agencyCatalog();
  const seed = {
    tenants: {
      A: { label: "A", tenantId: "org-a", user: { label: "A", id: "user-a", email: "a@example.com", accessToken: "token-a" } },
      B: { label: "B", tenantId: "org-b", user: { label: "B", id: "user-b", email: "b@example.com", accessToken: "token-b" } },
    },
    tables: new Map([["public.invoices", { table: "public.invoices", notes: [], rows: [{ table: "public.invoices", tenant: "B", index: 1, data: { id: "inv-b" }, adopted: false, triggersOff: false }] }]]),
    markers: { A: new Set(["tlc-A-invoices-1-zzz999"]), B: new Set([B_MARKER]) },
    notes: [],
  } as unknown as SeedResult;
  const calls: Who[] = [];
  let restored = 0;
  const ctx = {
    catalog,
    tenancy: buildTenancyModel(catalog, emptyConfig()),
    config: emptyConfig(),
    seed,
    userA: seed.tenants.A.user,
    api: {
      send: async (options: RequestOptions) => {
        const who = whoCalled(options);
        calls.push(who);
        return answers[who];
      },
    },
    world: {
      read: async () => ({}),
      diff: () => [],
      restore: async () => {
        restored += 1;
      },
    },
  } as unknown as ProbeContext;
  return { ctx, calls, restores: () => restored };
}

const getInvoice = fn("public.get_invoice", { args: [{ name: "p_invoice_id", type: type("uuid"), hasDefault: false }] });

describe("rpc control call", () => {
  it("control works, then the other tenant and the visitor get tenant B's data: leak", async () => {
    const { ctx, calls } = fakeContext({ owner: OK_WITH_B, tenant_a: OK_WITH_B, anon: OK_WITH_B });
    const checks = await probeFunction(ctx, getInvoice);
    assert.deepEqual(calls, ["owner", "tenant_a", "anon"], "the owner's control call comes first");
    assert.deepEqual(checks.map((c) => `${c.actor} ${c.status}`), ["tenant_a leak", "anon leak"]);
    for (const check of checks) {
      assert.equal(check.evidence?.requests.length, 2, "evidence shows the control call and the attempt");
      assert.match(check.evidence?.before ?? "", /Control call: tenant B/);
    }
  });

  it("control works, then the other tenant and the visitor are refused: pass", async () => {
    const { ctx, calls } = fakeContext({ owner: OK_WITH_B, tenant_a: NOT_YOURS, anon: DENIED });
    const checks = await probeFunction(ctx, getInvoice);
    assert.deepEqual(calls, ["owner", "tenant_a", "anon"]);
    assert.deepEqual(checks.map((c) => `${c.actor} ${c.status}`), ["tenant_a pass", "anon pass"]);
    assert.deepEqual(checks[0]?.notes, ["The function refused the call: Not your invoice."]);
    assert.deepEqual(checks[1]?.notes, ["Blocked by permissions."]);
  });

  it("control works, then an empty answer for another tenant's row: pass", async () => {
    const { ctx } = fakeContext({ owner: OK_WITH_B, tenant_a: EMPTY, anon: EMPTY });
    const checks = await probeFunction(ctx, getInvoice);
    assert.deepEqual(checks.map((c) => c.status), ["pass", "pass"]);
  });

  it("control works, then an input refusal for the other tenant: unclear, with the reason", async () => {
    const { ctx } = fakeContext({ owner: OK_WITH_B, tenant_a: UNKNOWN_ACTION, anon: DENIED });
    const [forA, forAnon] = await probeFunction(ctx, getInvoice);
    assert.equal(forA?.status, "inconclusive");
    assert.match(forA?.reason ?? "", /^Refused the input, not the tenant: /);
    assert.match(forA?.reason ?? "", /unknown action/);
    assert.equal(forA?.evidence?.requests.length, 2);
    assert.equal(forAnon?.status, "pass", "a real denial still passes");
  });

  it("control fails: unclear for both, and nobody else is called", async () => {
    const { ctx, calls, restores } = fakeContext({ owner: UNKNOWN_ACTION, tenant_a: EMPTY, anon: EMPTY });
    const checks = await probeFunction(ctx, getInvoice);
    assert.deepEqual(calls, ["owner"], "tenant A and the visitor must not be called after a failed control");
    assert.ok(restores() >= 1, "the world is restored after the control call");
    assert.deepEqual(checks.map((c) => `${c.actor} ${c.status}`), ["tenant_a inconclusive", "anon inconclusive"]);
    for (const check of checks) {
      assert.match(check.reason ?? "", /^Control call failed: /);
      assert.match(check.reason ?? "", /HTTP 400/);
      assert.match(check.reason ?? "", /unknown action/);
      assert.equal(check.evidence?.requests.length, 1, "only the control call was made");
    }
  });

  it("control fails with a permission error or no answer: still unclear, never pass", async () => {
    for (const owner of [DENIED, answer(500, {}), { status: 0, json: undefined, text: "", networkError: "timeout" }]) {
      const { ctx, calls } = fakeContext({ owner, tenant_a: EMPTY, anon: EMPTY });
      const checks = await probeFunction(ctx, getInvoice);
      assert.deepEqual(calls, ["owner"]);
      assert.deepEqual(checks.map((c) => c.status), ["inconclusive", "inconclusive"]);
    }
  });

  it("anonymous path: the visitor uses no login and its input refusal is unclear", async () => {
    const { ctx } = fakeContext({ owner: OK_WITH_B, tenant_a: DENIED, anon: UNKNOWN_ACTION });
    const [forA, forAnon] = await probeFunction(ctx, getInvoice);
    assert.equal(forA?.status, "pass");
    assert.equal(forAnon?.actor, "anon");
    assert.equal(forAnon?.status, "inconclusive");
    assert.match(forAnon?.reason ?? "", /^Refused the input, not the tenant: /);
  });

  it("the visitor reading tenant A's data is a leak too", async () => {
    const withA = answer(200, [{ number: "tlc-A-invoices-1-zzz999" }]);
    const { ctx } = fakeContext({ owner: OK_WITH_B, tenant_a: EMPTY, anon: withA });
    const checks = await probeFunction(ctx, getInvoice);
    assert.deepEqual(checks.map((c) => c.status), ["pass", "leak"]);
  });

  it("excluded, overloaded and unfillable functions are not called at all", async () => {
    const { ctx, calls } = fakeContext({ owner: OK_WITH_B, tenant_a: EMPTY, anon: EMPTY });
    const checks = await probeFunction(ctx, fn("public.f", { overloaded: true }));
    assert.deepEqual(calls, []);
    assert.deepEqual(checks.map((c) => c.status), ["not_tested", "not_tested"]);
  });
});

describe("rpc input refusals", () => {
  it("recognises refusals of the request's shape or values", () => {
    for (const message of ["unknown action", "Unsupported operation: archive", "invalid status value", "p_payload is required", "amount must be positive", "Validation failed", "missing field: kind"]) {
      assert.ok(inputRefusal({ status: 400, errorCode: "P0001", errorMessage: message }), message);
    }
    assert.ok(inputRefusal({ status: 400, errorCode: "22P02", errorMessage: 'invalid input syntax for type uuid: "x"' }));
    assert.ok(inputRefusal({ status: 400, errorCode: "23514", errorMessage: "new row violates check constraint" }));
    assert.ok(inputRefusal({ status: 404, errorCode: "42883", errorMessage: "operator does not exist" }));
  });

  it("does not treat a denial of the tenant as an input refusal", () => {
    for (const message of ["Not your invoice", "Invoice not found on this account.", "access denied", "You are not a member of this organisation"]) {
      assert.equal(inputRefusal({ status: 400, errorCode: "P0001", errorMessage: message }), undefined, message);
    }
    assert.equal(inputRefusal({ status: 403, errorCode: "42501", errorMessage: "permission denied for function f" }), undefined);
  });

  it("an input refusal is never a pass", () => {
    const outcome = quietCallOutcome({ status: 400, errorCode: "P0001", errorMessage: "unknown action" });
    assert.equal(outcome.pass, false);
    assert.match(outcome.pass ? "" : outcome.reason, /^Refused the input, not the tenant: .*unknown action/);
    assert.equal(quietCallOutcome({ status: 400, errorCode: "22P02", errorMessage: "invalid input syntax for type integer" }).pass, false);
  });

  it("a control call works only on a successful answer", () => {
    assert.deepEqual(controlOutcome({ status: 200 }), { ok: true });
    assert.deepEqual(controlOutcome({ status: 204 }), { ok: true });
    for (const response of [{ status: 400, errorCode: "P0001", errorMessage: "unknown action" }, { status: 401, errorCode: "42501" }, { status: 500 }, { status: 0, networkError: "timeout" }]) {
      const outcome = controlOutcome(response);
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? "" : outcome.reason, /^Control call failed: /);
    }
  });
});

describe("rpc control reasons in the reports", () => {
  async function probedRun() {
    const failed = await probeFunction(fakeContext({ owner: UNKNOWN_ACTION, tenant_a: EMPTY, anon: EMPTY }).ctx, getInvoice);
    const refused = await probeFunction(fakeContext({ owner: OK_WITH_B, tenant_a: UNKNOWN_ACTION, anon: DENIED }).ctx, fn("public.get_invoice_v2", { args: getInvoice.args }));
    return sampleRun([...failed, ...refused]);
  }

  it("unclear RPC checks make the run unclear (exit code 2), not clean", async () => {
    const run = await probedRun();
    assert.equal(run.summary.counts.inconclusive, 3);
    assert.equal(run.summary.counts.pass, 1);
    assert.equal(run.summary.verdict, "inconclusive");
    assert.equal(run.summary.exitCode, EXIT.inconclusive);
    assert.deepEqual(summarize(run.checks), run.summary);
  });

  it("JSON, Markdown, HTML and the CLI summary all show the reason", async () => {
    const run = await probedRun();
    const json = buildJsonReport(run);
    const schema = JSON.parse(await readFile(new URL("../../docs/report.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    assert.deepEqual(validate(schema, json), []);
    const reasons = json.notTested.filter((n) => n.status === "inconclusive").map((n) => n.reason);
    assert.equal(reasons.filter((r) => r.startsWith("Control call failed: ")).length, 2);
    assert.equal(reasons.filter((r) => r.startsWith("Refused the input, not the tenant: ")).length, 1);
    const jsonChecks = json.checks.filter((c) => c.status === "inconclusive");
    assert.ok(jsonChecks.every((c) => typeof c.reason === "string" && c.reason.length > 0));
    for (const text of [renderMarkdown(run), renderHtml(run), formatRunSummary(run)]) {
      assert.match(text, /Control call failed: /);
      assert.match(text, /Refused the input, not the tenant: /);
    }
    assert.match(formatRunSummary(run), /UNCLEAR {2}rpc:public\.get_invoice:execute:tenant_a/);
  });
});
