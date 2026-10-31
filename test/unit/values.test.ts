import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateValue, hintsForColumn, normalizeCheck, parseCheckHints } from "../../src/seed/values.ts";
import { col, type } from "./fixtures.ts";

describe("check constraint reading", () => {
  it("strips casts and redundant parentheses", () => {
    assert.equal(normalizeCheck("CHECK ((amount > (0)::numeric))"), "amount > 0");
    assert.equal(
      normalizeCheck("CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))"),
      "status = ANY ((ARRAY['a', 'b']))",
    );
    assert.equal(normalizeCheck("CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))"), "(char_length(name) >= 1) AND (char_length(name) <= 120)");
  });

  it("reads allowed values from IN lists and = ANY(ARRAY[...])", () => {
    assert.deepEqual(parseCheckHints("status", ["CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'paid'::text])))"]).allowed, ["draft", "sent", "paid"]);
    assert.deepEqual(
      parseCheckHints("status", ["CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying])::text[])))"]).allowed,
      ["open", "closed"],
    );
    assert.deepEqual(parseCheckHints("level",["CHECK ((level = ANY (ARRAY[1, 2, 3])))"]).allowed, [1, 2, 3]);
    assert.deepEqual(parseCheckHints("kind", ["CHECK (kind IN ('a', 'it''s'))"]).allowed, ["a", "it's"]);
  });

  it("reads numeric bounds in either direction", () => {
    assert.deepEqual(parseCheckHints("amount", ["CHECK ((amount > (0)::numeric))"]), { min: 0, minInclusive: false });
    assert.deepEqual(parseCheckHints("score", ["CHECK (((score >= 1) AND (score <= 5)))"]), { min: 1, minInclusive: true, max: 5, maxInclusive: true });
    assert.deepEqual(parseCheckHints("pct", ["CHECK ((100 >= pct))"]), { max: 100, maxInclusive: true });
  });

  it("reads length rules and does not confuse similar column names", () => {
    assert.deepEqual(parseCheckHints("name", ["CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))"]), { minLength: 1, maxLength: 120 });
    assert.deepEqual(parseCheckHints("code", ["CHECK ((length(code) = 2))"]), { minLength: 2, maxLength: 2 });
    assert.deepEqual(parseCheckHints("amount", ["CHECK ((max_amount > 0))"]), {});
    assert.deepEqual(parseCheckHints("title", ["CHECK ((title <> ''::text))"]), { minLength: 1 });
  });

  it("combines table checks with domain checks", () => {
    const column = col("rating", "int4", { type: type("int4", { domainChecks: ["CHECK ((VALUE >= 1))"] }) });
    assert.deepEqual(hintsForColumn(column, [{ columns: ["rating"], definition: "CHECK ((rating <= 5))" }]), {
      min: 1,
      minInclusive: true,
      max: 5,
      maxInclusive: true,
    });
  });
});

describe("value generation", () => {
  const request = (column: ReturnType<typeof col>, hints = {}) => ({ column, hints, tenant: "B" as const, table: "invoices", index: 1 });

  it("makes unique, recognisable text markers", () => {
    const a = generateValue(request(col("title", "text")));
    const b = generateValue(request(col("title", "text")));
    assert.ok(a.ok && b.ok);
    assert.match(String(a.value), /^tlc-B-invoices-1-[a-z0-9]{6}$/);
    assert.notEqual(a.value, b.value);
  });

  it("respects allowed values, enums and numeric bounds", () => {
    assert.deepEqual(generateValue(request(col("status", "text"), { allowed: ["draft", "sent"] })), { ok: true, value: "draft" });
    const enumColumn = col("mood", "mood", { type: type("mood", { category: "E", enumLabels: ["happy", "sad"] }) });
    assert.deepEqual(generateValue(request(enumColumn)), { ok: true, value: "happy" });
    for (let i = 0; i < 20; i++) {
      const value = generateValue(request(col("amount", "numeric"), { min: 0, minInclusive: false, max: 10, maxInclusive: true }));
      assert.ok(value.ok && Number(value.value) > 0 && Number(value.value) <= 10);
      const int = generateValue(request(col("qty", "int4"), { min: 3, minInclusive: true, max: 3, maxInclusive: true }));
      assert.deepEqual(int, { ok: true, value: 3 });
    }
  });

  it("fits text into length limits and email-like columns", () => {
    const short = generateValue(request(col("code", "varchar", { maxLength: 6 })));
    assert.ok(short.ok && String(short.value).length <= 6);
    const exact = generateValue(request(col("code", "text"), { minLength: 2, maxLength: 2 }));
    assert.ok(exact.ok && String(exact.value).length === 2);
    const email = generateValue(request(col("contact_email", "text")));
    assert.ok(email.ok);
    assert.match(String(email.value), /^tlc-b-[a-z0-9]+@example\.com$/);
  });

  it("produces a different value when asked (update probes)", () => {
    assert.deepEqual(generateValue({ ...request(col("status", "text"), { allowed: ["draft", "sent"] }), differentFrom: "draft" }), { ok: true, value: "sent" });
    assert.deepEqual(generateValue({ ...request(col("done", "bool")), differentFrom: true }), { ok: true, value: false });
    const only = generateValue({ ...request(col("status", "text"), { allowed: ["draft"] }), differentFrom: "draft" });
    assert.equal(only.ok, false);
  });

  it("fills the common Postgres types and explains the ones it cannot", () => {
    for (const name of ["uuid", "date", "timestamptz", "jsonb", "bool", "int8", "inet", "bytea"]) {
      assert.equal(generateValue(request(col("x", name, { type: type(name, { category: name === "int8" ? "N" : "U" }) }))).ok, true, name);
    }
    assert.deepEqual(generateValue(request(col("tags", "_text"))), { ok: true, value: [] });
    const odd = generateValue(request(col("shape", "geometry")));
    assert.equal(odd.ok, false);
    if (!odd.ok) assert.match(odd.reason, /cannot fill in/);
  });
});
