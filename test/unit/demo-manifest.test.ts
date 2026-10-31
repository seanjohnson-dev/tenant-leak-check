import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../../demo/", import.meta.url));

interface Leak {
  id: string;
  category: string;
  object: string;
  description: string;
  fix: string;
  checks: string[];
  warnings: { rule: string; object: string }[];
}

const manifest = JSON.parse(readFileSync(`${demo}leaks.json`, "utf8")) as { leaks: Leak[] };
const leaksMd = readFileSync(`${demo}LEAKS.md`, "utf8");

/** Every leak category the tool claims to detect (brief, PROOF (b); DESIGN.md section 12). */
const CATEGORIES = [
  /row level security disabled/i,
  /row level security not enabled|missing protection/i,
  /using \(true\)/i,
  /ignores the tenant/i,
  /insert with another tenant/i,
  /update across tenants/i,
  /re-assigning/i,
  /delete across tenants/i,
  /anonymous read/i,
  /anonymous write/i,
  /public storage bucket/i,
  /storage read policy/i,
  /storage write polic/i,
  /security definer function reads/i,
  /security definer function deletes/i,
  /view that bypasses/i,
  /materialized view/i,
  /child table/i,
  /shared table/i,
];

describe("demo leak manifest", () => {
  it("numbers leaks L01, L02, ... without gaps", () => {
    manifest.leaks.forEach((leak, i) => assert.equal(leak.id, `L${String(i + 1).padStart(2, "0")}`));
  });

  it("covers every category the tool claims to detect", () => {
    for (const category of CATEGORIES) {
      assert.ok(manifest.leaks.some((leak) => category.test(leak.category)), `no planted leak for ${category}`);
    }
  });

  it("lists well-formed, unique check ids for every leak", () => {
    const all = manifest.leaks.flatMap((leak) => leak.checks);
    assert.equal(new Set(all).size, all.length, "a check id is listed twice");
    for (const leak of manifest.leaks) {
      assert.ok(leak.checks.length > 0, `${leak.id} lists no checks`);
      assert.ok(leak.description && leak.fix && leak.object, `${leak.id} is missing text`);
      for (const id of leak.checks) {
        assert.match(id, /^(table|view|storage|rpc):[a-z0-9_.-]+:(select|insert|update|update_reassign|delete|list|download|upload|overwrite|execute):(tenant_a|anon)$/, id);
      }
    }
  });

  it("is documented in LEAKS.md, leak by leak", () => {
    for (const leak of manifest.leaks) assert.match(leaksMd, new RegExp(`^\\| ${leak.id} \\|`, "m"), `${leak.id} missing from LEAKS.md`);
    const total = manifest.leaks.reduce((sum, leak) => sum + leak.checks.length, 0);
    const warnings = manifest.leaks.reduce((sum, leak) => sum + leak.warnings.length, 0);
    assert.ok(leaksMd.includes(`${total} leak checks`), `LEAKS.md should state ${total} leak checks`);
    assert.ok(leaksMd.includes(`${warnings} schema warnings`), `LEAKS.md should state ${warnings} schema warnings`);
  });

  it("marks each planted leak in the broken migrations and its fix in the fixed ones", () => {
    const read = (app: string) =>
      readdirSync(`${demo}${app}/supabase/migrations`)
        .map((name) => readFileSync(`${demo}${app}/supabase/migrations/${name}`, "utf8"))
        .join("\n");
    const broken = read("broken");
    const fixed = read("fixed");
    for (const leak of manifest.leaks) {
      assert.match(broken, new RegExp(`\\b${leak.id}\\b`), `${leak.id} is not marked in demo/broken`);
      assert.match(fixed, new RegExp(`Fixes [^\\n]*\\b${leak.id}\\b`), `no "Fixes ${leak.id}" comment in demo/fixed`);
    }
  });

  it("keeps the schema identical between the broken and fixed apps", () => {
    const schema = (app: string) => readFileSync(`${demo}${app}/supabase/migrations/20261031000001_schema.sql`, "utf8");
    assert.equal(schema("broken"), schema("fixed"));
  });
});
