import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyConfig, validateConfig } from "../../src/config/config.ts";
import { ToolError } from "../../src/core/errors.ts";
import { buildTenancyModel, detectTenantRoot } from "../../src/discover/tenancy.ts";
import { agencyCatalog, catalogOf, col, fk, pk, table } from "./fixtures.ts";

function kindOf(model: ReturnType<typeof buildTenancyModel>, name: string): string | undefined {
  return model.tables.get(name)?.ownership.kind;
}

describe("tenancy model", () => {
  const model = buildTenancyModel(agencyCatalog(), emptyConfig());

  it("picks the table most tenant columns point at as the tenant root", () => {
    assert.equal(detectTenantRoot(agencyCatalog().relations), "public.organizations");
    assert.deepEqual(model.tenantRoot, { table: "public.organizations", keyColumn: "id" });
    assert.equal(kindOf(model, "public.organizations"), "tenant_root");
  });

  it("prefers the foreign key to the tenant root over other tenant-like names (client_id)", () => {
    const invoices = model.tables.get("public.invoices")?.ownership;
    assert.equal(invoices?.kind, "tenant");
    assert.equal(invoices?.kind === "tenant" ? invoices.tenantColumn : undefined, "org_id");
  });

  it("finds the membership table and records it", () => {
    assert.deepEqual(model.membership, { table: "public.org_members", userColumn: "user_id", tenantColumn: "org_id", values: {} });
    assert.equal(model.tables.get("public.org_members")?.membership, true);
    assert.match(model.tables.get("public.org_members")?.explanation ?? "", /membership table/);
  });

  it("detects user ownership through a foreign key and through a primary key", () => {
    const notes = model.tables.get("public.notes")?.ownership;
    assert.deepEqual(notes, { kind: "user", userColumn: "user_id", source: "foreign_key" });
    const profiles = model.tables.get("public.profiles")?.ownership;
    assert.deepEqual(profiles, { kind: "user", userColumn: "id", source: "primary_key" });
  });

  it("inherits ownership through a foreign key path", () => {
    const payments = model.tables.get("public.payments")?.ownership;
    assert.equal(payments?.kind, "inherited");
    if (payments?.kind === "inherited") {
      assert.deepEqual(payments.columns, ["invoice_id"]);
      assert.equal(payments.parent, "public.invoices");
      assert.deepEqual(payments.path, ["public.payments", "public.invoices"]);
    }
  });

  it("marks tables with no link to a tenant or user as shared", () => {
    assert.equal(kindOf(model, "public.plans"), "shared");
  });

  it("follows inheritance over several hops, shortest path first", () => {
    const catalog = agencyCatalog();
    catalog.relations.push(
      table("public.refunds", [col("id", "uuid", { notNull: true }), col("payment_id", "uuid", { notNull: true })], [pk("id"), fk("payment_id", "payments")]),
    );
    const deep = buildTenancyModel(catalog, emptyConfig()).tables.get("public.refunds")?.ownership;
    assert.equal(deep?.kind, "inherited");
    if (deep?.kind === "inherited") {
      assert.equal(deep.parent, "public.payments");
      assert.deepEqual(deep.path, ["public.refunds", "public.payments", "public.invoices"]);
    }
  });

  it("accepts tenant and user columns detected by name only, and says so", () => {
    const catalog = catalogOf([
      table("public.docs", [col("id", "uuid"), col("workspace_id", "uuid")], [pk("id")]),
      table("public.drafts", [col("id", "uuid"), col("owner_id", "uuid")], [pk("id")]),
    ]);
    const named = buildTenancyModel(catalog, emptyConfig());
    assert.deepEqual(named.tables.get("public.docs")?.ownership, { kind: "tenant", tenantColumn: "workspace_id", userColumns: [], source: "name" });
    assert.match(named.tables.get("public.docs")?.explanation ?? "", /please confirm/);
    assert.deepEqual(named.tables.get("public.drafts")?.ownership, { kind: "user", userColumn: "owner_id", source: "name" });
    assert.equal(named.tenantRoot, undefined);
  });

  it("with tenantRoot: null, treats each user as one customer even when tables have tenant_id columns", () => {
    // A landlord app: "tenants" are renters, and every row belongs to a landlord (a user).
    const catalog = catalogOf([
      table("public.profiles", [col("id", "uuid", { notNull: true })], [pk("id"), fk("id", "auth.users")]),
      table("public.tenants", [col("id", "uuid"), col("landlord_id", "uuid")], [pk("id"), fk("landlord_id", "profiles")]),
      table("public.invoices", [col("id", "uuid"), col("landlord_id", "uuid"), col("tenant_id", "uuid")], [pk("id"), fk("landlord_id", "profiles"), fk("tenant_id", "tenants")]),
      table("public.drafts", [col("id", "uuid"), col("user_id", "uuid"), col("tenant_id", "text")], [pk("id"), fk("user_id", "auth.users")]),
    ]);
    const detected = buildTenancyModel(catalog, emptyConfig());
    assert.equal(detected.tenantRoot?.table, "public.tenants");
    const model = buildTenancyModel(catalog, validateConfig({ tenantRoot: null }));
    assert.equal(model.tenantRoot, undefined);
    assert.equal(model.membership, undefined);
    assert.match(model.notes.join(" "), /no separate tenant table/);
    const invoices = model.tables.get("public.invoices")?.ownership;
    assert.equal(invoices?.kind, "inherited");
    if (invoices?.kind === "inherited") assert.deepEqual(invoices.path, ["public.invoices", "public.profiles"]);
    assert.equal(kindOf(model, "public.tenants"), "inherited");
    assert.deepEqual(model.tables.get("public.drafts")?.ownership, { kind: "user", userColumn: "user_id", source: "foreign_key" });
  });

  it("lets the config override every rule", () => {
    const config = validateConfig({
      tables: {
        "public.plans": { tenantColumn: "code" },
        "public.notes": { skip: "Written only by a server job." },
        "public.payments": { ownedVia: { column: "invoice_id", references: "public.invoices" } },
        "public.clients": { shared: true },
      },
    });
    const custom = buildTenancyModel(agencyCatalog(), config);
    assert.equal(custom.tables.get("public.plans")?.ownership.kind, "tenant");
    assert.deepEqual(custom.tables.get("public.notes")?.ownership, { kind: "skipped", reason: "Written only by a server job." });
    assert.equal(custom.tables.get("public.payments")?.ownership.kind, "inherited");
    assert.equal(custom.tables.get("public.clients")?.ownership.kind, "shared");
  });

  it("rejects config that names missing tables or columns", () => {
    assert.throws(() => buildTenancyModel(agencyCatalog(), validateConfig({ tables: { "public.nope": { shared: true } } })), ToolError);
    assert.throws(
      () => buildTenancyModel(agencyCatalog(), validateConfig({ tables: { "public.invoices": { tenantColumn: "team" } } })),
      (error: unknown) => error instanceof ToolError && /no such column/.test(error.message),
    );
    assert.throws(() => buildTenancyModel(agencyCatalog(), validateConfig({ tenantRoot: "public.teams" })), ToolError);
  });

  it("notes when no table belongs to a tenant or user", () => {
    const empty = buildTenancyModel(catalogOf([table("public.plans", [col("code", "text")], [pk("code")])]), emptyConfig());
    assert.match(empty.notes.join(" "), /No table could be linked/);
  });
});
