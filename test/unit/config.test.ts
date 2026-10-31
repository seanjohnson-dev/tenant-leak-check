import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE_NAME, emptyConfig, loadConfig, qualifiedName, validateConfig } from "../../src/config/config.ts";
import { ToolError } from "../../src/core/errors.ts";

const scratch = fileURLToPath(new URL("../../.tlc-work/", import.meta.url));

function problem(raw: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateConfig(raw, "tenant-leak-check.json"),
    (error: unknown) => error instanceof ToolError && pattern.test(error.message),
  );
}

describe("config validation", () => {
  it("accepts the full example from the design", () => {
    const config = validateConfig({
      tables: {
        "public.invoices": { tenantColumn: "org_id" },
        "public.notes": { userColumn: "author_id" },
        "public.invoice_lines": { ownedVia: { column: "invoice_id", references: "public.invoices" } },
        "public.countries": { shared: true },
        "public.audit_log": { skip: "Written only by triggers; not client-facing." },
      },
      tenantRoot: "public.organizations",
      membership: { table: "public.org_members", userColumn: "user_id", tenantColumn: "org_id", values: { role: "owner" } },
      seed: { values: { "public.invoices.status": "draft" } },
      storage: { allowPublic: ["product-images"], pathTemplates: ["{tenant}/{file}", "{user}/{file}"] },
      rpc: {
        skip: { "public.send_email": "Has side effects outside the database." },
        args: { "public.get_invoice": { invoice_id: "{tenantB.row:public.invoices}" } },
      },
    });
    assert.equal(config.tables["public.invoices"]?.tenantColumn, "org_id");
    assert.equal(config.membership?.values?.role, "owner");
    assert.deepEqual(config.storage.pathTemplates, ["{tenant}/{file}", "{user}/{file}"]);
    assert.equal(config.rpc.args["public.get_invoice"]?.invoice_id, "{tenantB.row:public.invoices}");
  });

  it("treats bare table names as the public schema", () => {
    assert.equal(qualifiedName("invoices", "x"), "public.invoices");
    assert.equal(validateConfig({ tables: { invoices: { shared: true } } }).tables["public.invoices"]?.shared, true);
  });

  it("rejects unknown keys and names the path, so typos are never ignored", () => {
    problem({ tabels: {} }, /config\.tabels: unknown setting/);
    problem({ tables: { "public.invoices": { tenantColum: "org_id" } } }, /config\.tables\["public\.invoices"\]\.tenantColum: unknown setting/);
    problem({ storage: { allowpublic: [] } }, /config\.storage\.allowpublic/);
  });

  it("rejects contradictory or empty table rules", () => {
    problem({ tables: { "public.a": {} } }, /needs one of/);
    problem({ tables: { "public.a": { shared: true, skip: "x" } } }, /use only one of/);
    problem({ tables: { "public.a": { shared: false } } }, /can only be true/);
    problem({ tables: { "public.a": { tenantColumn: "org id" } } }, /not a plain column name/);
  });

  it("checks placeholders, path templates and seed keys", () => {
    problem({ rpc: { args: { "public.f": { id: "{tenantC.user}" } } } }, /not a known placeholder/);
    problem({ storage: { pathTemplates: ["{tenant}/"] } }, /must contain \{file\}/);
    problem({ storage: { pathTemplates: ["{org}/{file}"] } }, /unknown placeholder \{org\}/);
    problem({ seed: { values: { "invoices.status": "draft" } } }, /schema\.table\.column/);
  });

  it("loads the project's config file, an explicit file, or nothing", async () => {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "unit-config-"));
    assert.deepEqual(await loadConfig(dir), emptyConfig());
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ tables: { "public.x": { shared: true } } }));
    const loaded = await loadConfig(dir);
    assert.equal(loaded.tables["public.x"]?.shared, true);
    assert.equal(loaded.source, join(dir, CONFIG_FILE_NAME));
    await assert.rejects(loadConfig(dir, join(dir, "missing.json")), /does not exist/);
    await writeFile(join(dir, "bad.json"), "{ nope");
    await assert.rejects(loadConfig(dir, join(dir, "bad.json")), /not valid JSON/);
  });
});
