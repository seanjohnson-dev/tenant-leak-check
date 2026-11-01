import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { reviewItems } from "../../src/migrate/diff.ts";
import { scanMigrations } from "../../src/migrate/scan.ts";
import { selectMigrationFiles } from "../../src/stack/sandbox.ts";

/* Checks demo/migrations/expected.json against the demo files without Docker. The integration tests check the rest. */

const repo = fileURLToPath(new URL("../../", import.meta.url));

interface Case {
  id: string;
  migration: string;
  exitCode: number;
  statements: { marker: string; line: number; rule: string; severity: string; object: string }[];
  review: string[];
}

const expected = JSON.parse(readFileSync(`${repo}demo/migrations/expected.json`, "utf8")) as { project: string; cases: Case[] };

describe("demo migrations manifest", () => {
  it("covers a bad, a good and a needs-review migration with exit codes 1, 0 and 4", () => {
    assert.deepEqual(expected.cases.map((c) => [c.id, c.exitCode]), [["bad", 1], ["good", 0], ["review", 4]]);
  });

  it("every demo migration sorts after the fixed app's own migrations", () => {
    const own = selectMigrationFiles(["20261031000001_schema.sql", "20261031000002_security.sql", "20261031000003_views_functions.sql", "20261031000004_storage.sql"]);
    for (const c of expected.cases) assert.ok(basename(c.migration) > (own.at(-1) as string), c.migration);
  });

  for (const c of expected.cases) {
    it(`${c.id}: the scanner finds exactly the expected statements, on the lines marked in the file`, () => {
      const sql = readFileSync(`${repo}${c.migration}`, "utf8");
      const findings = scanMigrations([{ name: basename(c.migration), sql }]);
      assert.deepEqual(
        findings.map((f) => ({ line: f.line, rule: f.rule, severity: f.severity, object: f.object })),
        c.statements.map(({ line, rule, severity, object }) => ({ line, rule, severity, object })),
      );
      const lines = sql.split("\n");
      for (const statement of c.statements) {
        const marker = lines.slice(0, statement.line).reverse().find((line) => /^-- [RV]\d/.test(line));
        assert.ok(marker?.startsWith(`-- ${statement.marker}`), `line ${statement.line} should follow the ${statement.marker} comment`);
      }
      const fromStatements = reviewItems(findings, [], { onSeededData: { ok: true }, onFreshDatabase: { ok: true } }).map((r) => r.topic);
      assert.deepEqual(fromStatements, c.review.filter((topic) => topic !== "fails_on_existing_data"));
    });
  }
});
