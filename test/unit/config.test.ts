import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE_NAME, emptyConfig, loadConfig, qualifiedName, validateConfig } from "../../src/config/config.ts";
import { ToolError } from "../../src/core/errors.ts";

const scratch = fileURLToPath(new URL("../../.tlc-work/", import.meta.url));
const created: string[] = [];
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

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
    created.push(dir);
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

describe("config: build files and tenantRoot null", () => {
  it("resolves build.files paths against the config file's folder and keeps their order", () => {
    const config = validateConfig(
      {
        build: {
          files: [
            { path: "../app/supabase/schema.sql", version: "20240101000000" },
            { path: "/abs/shim.sql", version: "20240102000000" },
          ],
        },
      },
      "/work/configs/tenant-leak-check.json",
    );
    assert.deepEqual(config.build.files, [
      { path: "/work/app/supabase/schema.sql", version: "20240101000000" },
      { path: "/abs/shim.sql", version: "20240102000000" },
    ]);
    assert.deepEqual(emptyConfig().build.files, []);
  });

  it("rejects build files that are not .sql, have a non-numeric version, or are not a list", () => {
    problem({ build: { files: [{ path: "supabase/.env", version: "1" }] } }, /build\.files\[0\]\.path: .*must be a \.sql file/);
    problem({ build: { files: [{ path: "schema.sql", version: "v1" }] } }, /build\.files\[0\]\.version: .*digits only/);
    problem({ build: { files: [{ path: "schema.sql" }] } }, /build\.files\[0\]\.version: must be a non-empty text value/);
    problem({ build: { files: [{ path: "schema.sql", version: "1", extra: true }] } }, /build\.files\[0\]\.extra: unknown setting/);
    problem({ build: { files: "schema.sql" } }, /config\.build\.files: must be a list/);
    problem({ build: { order: [] } }, /config\.build\.order: unknown setting/);
  });

  it("accepts tenantRoot: null (no tenant table) and still checks a named one", () => {
    assert.equal(validateConfig({ tenantRoot: null }).tenantRoot, null);
    assert.equal(validateConfig({}).tenantRoot, undefined);
    problem({ tenantRoot: "not a table!" }, /config\.tenantRoot/);
  });
});
