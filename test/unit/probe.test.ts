import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyConfig } from "../../src/config/config.ts";
import { buildTenancyModel } from "../../src/discover/tenancy.ts";
import { classifyResponse, findMarkers, firstLeakedItem, type ProbeContext, restTarget } from "../../src/probe/common.ts";
import { ApiClient, evidenceOf, excerpt, redact } from "../../src/probe/http.ts";
import { fillArg, normalizeArgName, quietCallOutcome, tableForArg } from "../../src/probe/rpc.ts";
import { rowFilter } from "../../src/probe/tables.ts";
import { canaryPaths, pickContentType } from "../../src/seed/files.ts";
import type { SeedResult } from "../../src/seed/rows.ts";
import { agencyCatalog, col, fn, pk, table, type } from "./fixtures.ts";

describe("http helpers", () => {
  it("redacts tokens, keys and password fields", () => {
    const text = redact('{"access_token":"abc","apikey":"k","x":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig sb_publishable_abc"}');
    assert.doesNotMatch(text, /abc"|eyJ|sb_publishable/);
    assert.match(text, /\[redacted/);
  });

  it("keeps evidence short and free of hosts and keys", () => {
    assert.match(excerpt("x".repeat(700)), /… \(100 more characters\)$/);
    const evidence = evidenceOf(
      { method: "GET", path: "/rest/v1/invoices?id=eq.1", caller: { kind: "anon" } },
      { status: 200, json: [], text: "[]" },
    );
    assert.deepEqual(evidence, { method: "GET", path: "/rest/v1/invoices?id=eq.1", status: 200, response: "[]" });
  });

  it("refuses to talk to anything but this machine", () => {
    assert.throws(() => new ApiClient({ apiUrl: "https://abc.supabase.co", anonKey: "a", serviceRoleKey: "s" }), /Refusing to connect/);
  });

  it("reads PostgREST answers without deciding the verdict", () => {
    assert.deepEqual(classifyResponse({ status: 204, json: undefined, text: "" }), { kind: "ok" });
    assert.deepEqual(classifyResponse({ status: 401, json: {}, text: "", errorCode: "42501", errorMessage: "permission denied for table x" }), {
      kind: "denied",
      note: "Blocked by permissions.",
    });
    assert.deepEqual(classifyResponse({ status: 403, json: {}, text: "", errorCode: "42501", errorMessage: "new row violates row-level security policy" }), {
      kind: "denied",
      note: "Blocked by row level security.",
    });
    assert.equal(classifyResponse({ status: 400, json: {}, text: "", errorCode: "23505" }).kind, "error");
    assert.equal(classifyResponse({ status: 503, json: {}, text: "" }).kind, "server_error");
    assert.equal(classifyResponse({ status: 0, json: undefined, text: "", networkError: "timeout" }).kind, "server_error");
  });

  it("targets other schemas with profile headers", () => {
    assert.deepEqual(restTarget("api", "my table", "id=eq.1", true), { path: "/rest/v1/my%20table?id=eq.1", headers: { "Content-Profile": "api" } });
    assert.deepEqual(restTarget("public", "t", "", false), { path: "/rest/v1/t", headers: { "Accept-Profile": "public" } });
  });
});

describe("markers", () => {
  const markers = new Set(["tlc-B-invoices-1-abc123", "6c03c784-1142-4271-958c-b6fc1733002a"]);

  it("finds another tenant's markers in a response", () => {
    const body = '[{"id":"6c03c784-1142-4271-958c-b6fc1733002a","number":"tlc-B-invoices-1-abc123"}]';
    assert.equal(findMarkers(body, markers).length, 2);
    assert.deepEqual(findMarkers('[{"number":"tlc-A-invoices-1-zzz"}]', markers), []);
    assert.equal(firstLeakedItem({ status: 200, json: JSON.parse(body), text: body }, ["tlc-B-invoices-1-abc123"]), JSON.stringify(JSON.parse(body)[0]));
  });
});

describe("row targeting", () => {
  const relation = table("public.t", [col("id", "uuid"), col("code", "text"), col("note", "text")], [pk("id")]);

  it("uses the primary key, then a unique key, then a unique marker", () => {
    assert.equal(rowFilter(relation, { id: "a b" }, new Set(["id"])), "id=eq.a%20b");
    const unique = table("public.u", [col("code", "text")], [{ name: "u", type: "unique", columns: ["code"], definition: "UNIQUE (code)" }]);
    assert.equal(rowFilter(unique, { code: "x" }, new Set(["code"])), "code=eq.x");
    const bare = table("public.b", [col("note", "text")]);
    assert.equal(rowFilter(bare, { note: "tlc-B-b-1-abcdef" }, new Set(["note"])), "note=eq.tlc-B-b-1-abcdef");
    assert.equal(rowFilter(bare, { note: "plain" }, new Set(["note"])), undefined);
  });

  it("only uses key columns the API relation shows", () => {
    assert.equal(rowFilter(relation, { id: "1", note: "tlc-B-t-1-abcdef" }, new Set(["note"])), "note=eq.tlc-B-t-1-abcdef");
  });
});

describe("storage canaries", () => {
  const tenant = { label: "B" as const, tenantId: "org-b", user: { label: "B" as const, id: "user-b", email: "b@example.com", accessToken: "t" } };

  it("builds one path per folder convention", () => {
    assert.deepEqual(canaryPaths(["{tenant}/{file}", "{user}/{file}"], tenant, true, "c.txt"), ["org-b/c.txt", "user-b/c.txt"]);
    assert.deepEqual(canaryPaths(["{tenant}/{file}", "{user}/{file}"], tenant, false, "c.txt"), ["user-b/c.txt"]);
    assert.deepEqual(canaryPaths(["private/{user}/{file}"], tenant, true, "c.txt"), ["private/user-b/c.txt"]);
  });

  it("picks a content type the bucket accepts", () => {
    assert.equal(pickContentType([]), "text/plain");
    assert.equal(pickContentType(["text/*"]), "text/plain");
    assert.equal(pickContentType(["image/*"]), "image/png");
    assert.equal(pickContentType(["application/pdf"]), "application/pdf");
  });
});

describe("rpc verdict when no other tenant's data was reached", () => {
  it("passes successful calls, refusals and permission denials", () => {
    assert.deepEqual(quietCallOutcome({ status: 200 }), { pass: true, notes: [] });
    assert.deepEqual(quietCallOutcome({ status: 400, errorCode: "P0001", errorMessage: "Not your invoice" }), {
      pass: true,
      notes: ["The function refused the call: Not your invoice."],
    });
    assert.deepEqual(quietCallOutcome({ status: 403, errorCode: "42501" }), { pass: true, notes: ["Blocked by permissions."] });
  });

  it("treats a RAISE that PostgREST answers with HTTP 500 (SQLSTATE P0002) as the function refusing", () => {
    assert.deepEqual(quietCallOutcome({ status: 500, errorCode: "P0002", errorMessage: "Invoice not found on this account." }), {
      pass: true,
      notes: ["The function refused the call: Invoice not found on this account."],
    });
  });

  it("stays unclear for crashes, missing answers and PostgREST errors", () => {
    assert.deepEqual(quietCallOutcome({ status: 500, errorCode: "XX000" }), { pass: false, reason: "The function failed with a server error (HTTP 500)." });
    // SELECT ... INTO STRICT finding several rows, and a failed ASSERT, are crashes rather than refusals.
    assert.equal(quietCallOutcome({ status: 500, errorCode: "P0003", errorMessage: "query returned more than one row" }).pass, false);
    assert.equal(quietCallOutcome({ status: 500, errorCode: "P0004", errorMessage: "assertion failed" }).pass, false);
    assert.deepEqual(quietCallOutcome({ status: 500 }), { pass: false, reason: "The function failed with a server error (HTTP 500)." });
    assert.equal(quietCallOutcome({ status: 0, networkError: "timeout" }).pass, false);
    assert.deepEqual(quietCallOutcome({ status: 404, errorCode: "PGRST202", errorMessage: "not found" }), {
      pass: false,
      reason: "The API could not run the function (PGRST202: not found).",
    });
  });
});

describe("rpc argument filling", () => {
  const catalog = agencyCatalog();
  const tenancy = buildTenancyModel(catalog, emptyConfig());
  const seed = {
    tenants: {
      A: { label: "A", tenantId: "org-a", user: { id: "user-a" } },
      B: { label: "B", tenantId: "org-b", user: { id: "user-b" } },
    },
    tables: new Map([["public.invoices", { table: "public.invoices", notes: [], rows: [{ table: "public.invoices", tenant: "B", index: 1, data: { id: "inv-b" }, adopted: false, triggersOff: false }] }]]),
    markers: { A: new Set(), B: new Set() },
    notes: [],
  } as unknown as SeedResult;
  const ctx = { catalog, tenancy, seed } as unknown as ProbeContext;
  const arg = (name: string, typeName = "uuid", hasDefault = false) => ({ name, type: type(typeName, { category: typeName === "text" ? "S" : "U" }), hasDefault });

  it("strips common prefixes from argument names", () => {
    assert.equal(normalizeArgName("p_org_id"), "org_id");
    assert.equal(normalizeArgName("_user_id"), "user_id");
    assert.equal(normalizeArgName("in_invoice_id"), "invoice_id");
  });

  it("gives tenant-like arguments tenant B's id and user-like ones tenant B's user", () => {
    const f = fn("public.get_org_invoices");
    assert.deepEqual(fillArg(ctx, f, arg("p_org_id")), { ok: true, value: "org-b" });
    assert.deepEqual(fillArg(ctx, f, arg("target_user", "uuid")), { ok: true, value: "org-b" });
    assert.deepEqual(fillArg(ctx, f, arg("p_user_id")), { ok: true, value: "user-b" });
  });

  it("matches <table>_id and id arguments to tenant B's rows", () => {
    assert.equal(tableForArg(ctx, fn("public.x"), "invoice_id"), "public.invoices");
    assert.equal(tableForArg(ctx, fn("public.get_invoice"), "id"), "public.invoices");
    assert.deepEqual(fillArg(ctx, fn("public.x"), arg("p_invoice_id")), { ok: true, value: "inv-b" });
    assert.deepEqual(fillArg(ctx, fn("public.get_invoice"), arg("id")), { ok: true, value: "inv-b" });
  });

  it("leaves optional arguments to their defaults and explains unknown types", () => {
    assert.deepEqual(fillArg(ctx, fn("public.x"), arg("limit_rows", "int4", true)), { ok: true, omit: true });
    const odd = fillArg(ctx, fn("public.x"), arg("shape", "geometry"));
    assert.equal(odd.ok, false);
  });
});
