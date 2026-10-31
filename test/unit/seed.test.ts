import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyConfig, validateConfig } from "../../src/config/config.ts";
import { buildTenancyModel } from "../../src/discover/tenancy.ts";
import { buildRow, collectMarkers, isDistinctive, ownerOf, resolvePlaceholder, type SeededRow, type SeedResult } from "../../src/seed/rows.ts";
import { foreignKeyOrder, rowKey } from "../../src/seed/world.ts";
import { agencyCatalog, col, fk, pk, table } from "./fixtures.ts";

const ORG_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ORG_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const USER_A = "1a1a1a1a-0000-4000-8000-00000000000a";
const USER_B = "1b1b1b1b-0000-4000-8000-00000000000b";

function row(table: string, tenant: "A" | "B" | "S", index: number, data: Record<string, unknown>): SeededRow {
  return { table, tenant, index, data, adopted: false, triggersOff: false };
}

function world(): Pick<SeedResult, "tenants" | "tables"> {
  const tables = new Map<string, { table: string; rows: SeededRow[]; notes: string[] }>();
  const add = (r: SeededRow) => {
    const entry = tables.get(r.table) ?? { table: r.table, rows: [], notes: [] };
    entry.rows.push(r);
    tables.set(r.table, entry);
  };
  add(row("public.organizations", "A", 1, { id: ORG_A, name: "tlc-A-org-1-aaaaaa" }));
  add(row("public.organizations", "B", 1, { id: ORG_B, name: "tlc-B-org-1-bbbbbb" }));
  add(row("public.invoices", "A", 1, { id: "2a2a2a2a-0000-4000-8000-00000000000a", org_id: ORG_A, number: "tlc-A-inv-1-aaaaaa", plan: "tlc-S-plans-1-ssssss" }));
  add(row("public.invoices", "B", 1, { id: "2b2b2b2b-0000-4000-8000-00000000000b", org_id: ORG_B, number: "tlc-B-inv-1-bbbbbb", plan: "tlc-S-plans-1-ssssss" }));
  add(row("public.plans", "S", 1, { code: "tlc-S-plans-1-ssssss", name: "Shared" }));
  return {
    tenants: {
      A: { label: "A", tenantId: ORG_A, user: { label: "A", id: USER_A, email: "a@example.com", accessToken: "x" } },
      B: { label: "B", tenantId: ORG_B, user: { label: "B", id: USER_B, email: "b@example.com", accessToken: "x" } },
    },
    tables: tables as SeedResult["tables"],
  };
}

describe("ownership of rows", () => {
  const tenancy = buildTenancyModel(agencyCatalog(), emptyConfig());
  const own = (name: string) => tenancy.tables.get(name)?.ownership ?? { kind: "shared" as const, source: "detected" as const };

  it("judges tenant, user, root and inherited rows", () => {
    const seed = world();
    assert.equal(ownerOf(own("public.invoices"), { org_id: ORG_B }, seed), "B");
    assert.equal(ownerOf(own("public.invoices"), { org_id: "someone-else" }, seed), undefined);
    assert.equal(ownerOf(own("public.notes"), { user_id: USER_A }, seed), "A");
    assert.equal(ownerOf(own("public.organizations"), { id: ORG_B }, seed), "B");
    assert.equal(ownerOf(own("public.payments"), { invoice_id: "2b2b2b2b-0000-4000-8000-00000000000b" }, seed), "B");
    assert.equal(ownerOf(own("public.plans"), { code: "x" }, seed), "S");
  });
});

describe("markers", () => {
  it("keeps only values unique to one tenant and drops shared references", () => {
    const markers = collectMarkers(world());
    assert.ok(markers.B.has("tlc-B-inv-1-bbbbbb"));
    assert.ok(markers.B.has(ORG_B) && markers.B.has(USER_B));
    assert.ok(!markers.B.has("tlc-S-plans-1-ssssss"), "a shared value must never count as tenant B's data");
    assert.ok(!markers.A.has("tlc-B-inv-1-bbbbbb"));
  });

  it("treats only synthetic markers and ids as distinctive", () => {
    assert.equal(isDistinctive("tlc-B-x-1-abcdef"), true);
    assert.equal(isDistinctive(ORG_B), true);
    assert.equal(isDistinctive("Starter plan"), false);
  });
});

describe("synthetic rows", () => {
  const catalog = agencyCatalog();
  const tenancy = buildTenancyModel(catalog, emptyConfig());
  const relation = (name: string) => catalog.relations.find((r) => r.qualified === name) as NonNullable<ReturnType<typeof catalog.relations.find>>;

  it("points tenant and foreign keys at the same tenant's rows", () => {
    const built = buildRow(relation("public.invoices"), tenancy, world(), emptyConfig(), catalog, { tenant: "B", index: 1, mode: "full" });
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.equal(built.values.org_id, ORG_B);
    assert.equal(built.values.client_id, null, "a nullable link to a table without test data is left empty");
    assert.match(String(built.values.number), /^tlc-B-invoices-1-/);
    assert.ok(Number(built.values.amount) > 0, "the CHECK (amount > 0) rule is respected");
    assert.match(String(built.values.id), /^[0-9a-f-]{36}$/);
  });

  it("uses the acting user for user links on tenant tables, but the owner for user-owned tables", () => {
    const member = buildRow(relation("public.org_members"), tenancy, world(), emptyConfig(), catalog, { tenant: "B", index: 9, mode: "full", actingUserId: USER_A });
    assert.ok(member.ok && member.values.org_id === ORG_B && member.values.user_id === USER_A);
    const note = buildRow(relation("public.notes"), tenancy, world(), emptyConfig(), catalog, { tenant: "B", index: 9, mode: "full", actingUserId: USER_A });
    assert.ok(note.ok && note.values.user_id === USER_B);
  });

  it("explains when a required parent has no test data", () => {
    const built = buildRow(relation("public.payments"), tenancy, world(), emptyConfig(), catalog, { tenant: "B", index: 1, mode: "minimal" });
    assert.ok(built.ok, "payments link to tenant B's invoice");
    const orphan = table("public.lines", [col("id", "uuid", { notNull: true }), col("order_id", "uuid", { notNull: true })], [pk("id"), fk("order_id", "orders")]);
    const result = buildRow(orphan, tenancy, world(), emptyConfig(), catalog, { tenant: "B", index: 1, mode: "minimal" });
    assert.deepEqual(result, { ok: false, reason: "it needs a row in public.orders, which has no test data" });
  });

  it("applies seed values and placeholders from the config", () => {
    const config = validateConfig({ seed: { values: { "public.invoices.number": "INV-{x}", "public.invoices.client_id": "{tenantB.tenant}" } } });
    const built = buildRow(relation("public.invoices"), tenancy, world(), config, catalog, { tenant: "B", index: 1, mode: "minimal" });
    assert.ok(built.ok && built.values.number === "INV-{x}" && built.values.client_id === ORG_B, "config values win over detected ones");
    assert.equal(resolvePlaceholder("{tenantB.user}", world(), catalog), USER_B);
    assert.equal(resolvePlaceholder("{tenantA.row:public.invoices}", world(), catalog), "2a2a2a2a-0000-4000-8000-00000000000a");
    assert.equal(resolvePlaceholder("plain", world(), catalog), "plain");
  });
});

describe("world bookkeeping", () => {
  it("orders tables parents first", () => {
    const names = foreignKeyOrder(agencyCatalog().relations).map((r) => r.qualified);
    assert.ok(names.indexOf("public.organizations") < names.indexOf("public.invoices"));
    assert.ok(names.indexOf("public.clients") < names.indexOf("public.invoices"));
    assert.ok(names.indexOf("public.invoices") < names.indexOf("public.payments"));
  });

  it("keys rows by primary key, or by the whole row without one", () => {
    const withKey = table("public.k", [col("a", "int4"), col("b", "int4")], [pk("a", "b")]);
    assert.equal(rowKey(withKey, { a: 1, b: 2, c: 3 }), "[1,2]");
    const without = table("public.n", [col("a", "int4")]);
    assert.equal(rowKey(without, { a: 1 }), '{"a":1}');
  });
});
