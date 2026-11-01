import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT } from "../../src/core/exit-codes.ts";
import { inconclusive, leaked, notTested, passed, summarize } from "../../src/core/results.ts";
import type { Catalog } from "../../src/discover/catalog.ts";
import { diffCatalogs } from "../../src/migrate/catalog-diff.ts";
import { assertAppliedLast, diffSummary, migrationHeadline, readMigrationFiles, reviewItems } from "../../src/migrate/diff.ts";
import { diffResults } from "../../src/migrate/result-diff.ts";
import { scanMigrations } from "../../src/migrate/scan.ts";
import { agencyCatalog, col, fn, policy, table } from "./fixtures.ts";
import { sampleDiff } from "./report-fixtures.ts";

const scratch = fileURLToPath(new URL("../../.tlc-work/", import.meta.url));
const created: string[] = [];
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

function changed(mutate: (catalog: Catalog) => void): Catalog {
  const catalog = agencyCatalog();
  mutate(catalog);
  return catalog;
}

function relation(catalog: Catalog, name: string) {
  const found = catalog.relations.find((r) => r.qualified === name);
  assert.ok(found, name);
  return found;
}

const kinds = (before: Catalog, after: Catalog): string[] => diffCatalogs(before, after).map((c) => `${c.kind} ${c.severity} ${c.object}`);

describe("catalog diff", () => {
  it("reports nothing when nothing changed", () => {
    assert.deepEqual(diffCatalogs(agencyCatalog(), agencyCatalog()), []);
  });

  it("flags removed tables and columns as destructive, without listing the table's policies again", () => {
    const before = changed((c) => relation(c, "public.notes").policies.push(policy("public.notes", "own notes", "select")));
    const after = changed((c) => {
      c.relations = c.relations.filter((r) => r.qualified !== "public.notes");
      relation(c, "public.clients").columns.pop();
    });
    assert.deepEqual(kinds(before, after).sort(), ["column_removed destructive public.clients.name", "relation_removed destructive public.notes"]);
  });

  it("flags type changes, RLS switched off or no longer forced, and removed policies", () => {
    const before = changed((c) => {
      relation(c, "public.invoices").rlsForced = true;
      relation(c, "public.invoices").policies.push(policy("public.invoices", "read", "select", { using: "(org_id = x)" }));
    });
    const after = changed((c) => {
      const invoices = relation(c, "public.invoices");
      invoices.rlsEnabled = false;
      const amount = invoices.columns.find((column) => column.name === "amount");
      if (amount) amount.type = { ...amount.type, display: "integer" };
    });
    const changes = diffCatalogs(before, after);
    assert.deepEqual(changes.map((c) => `${c.kind} ${c.severity}`).sort(), [
      "column_type_changed destructive",
      "policy_removed security",
      "rls_disabled security",
      "rls_no_longer_forced security",
    ]);
    const removed = changes.find((c) => c.kind === "policy_removed");
    assert.equal(removed?.object, "public.invoices: read");
    assert.equal(removed?.before, "permissive select to authenticated using ((org_id = x))");
  });

  it("shows changed policies with before and after, on one line", () => {
    const before = changed((c) => relation(c, "public.clients").policies.push(policy("public.clients", "p", "select", { using: "(org_id IN ( SELECT 1\n   FROM m))" })));
    const after = changed((c) => relation(c, "public.clients").policies.push(policy("public.clients", "p", "select", { using: "true" })));
    const [change] = diffCatalogs(before, after);
    assert.equal(change?.kind, "policy_changed");
    assert.equal(change?.before, "permissive select to authenticated using ((org_id IN ( SELECT 1 FROM m)))");
    assert.equal(change?.after, "permissive select to authenticated using (true)");
  });

  it("lists new tables and their policies; a new table without RLS that clients can use is a security change", () => {
    const after = changed((c) => {
      const safe = table("public.time_entries", [col("id", "uuid")]);
      safe.policies.push(policy("public.time_entries", "own", "select"));
      const open = table("public.exports", [col("id", "uuid")], [], { rlsEnabled: false });
      c.relations.push(safe, open);
    });
    assert.deepEqual(kinds(agencyCatalog(), after).sort(), [
      "policy_added info public.time_entries: own",
      "relation_added info public.time_entries",
      "relation_added security public.exports",
    ]);
  });

  it("tracks grants, view rights, functions and buckets", () => {
    const before = changed((c) => {
      relation(c, "public.plans").privileges.anon = { select: true, insert: false, update: false, delete: false };
      c.relations.push(table("public.directory", [], [], { kind: "view", securityInvoker: true }));
      c.functions.push(fn("public.report", { signature: "p_org uuid" }));
      c.buckets.push({ id: "docs", name: "docs", public: false, allowedMimeTypes: [] }, { id: "old", name: "old", public: false, allowedMimeTypes: [] });
    });
    const after = changed((c) => {
      relation(c, "public.plans").privileges.anon = { select: true, insert: true, update: false, delete: false };
      c.relations.push(table("public.directory", [], [], { kind: "view", securityInvoker: false }));
      c.functions.push(fn("public.report", { signature: "p_org uuid", securityDefiner: true }), fn("public.export_all", { securityDefiner: true }));
      c.buckets.push({ id: "docs", name: "docs", public: true, allowedMimeTypes: [] });
    });
    assert.deepEqual(kinds(before, after).sort(), [
      "bucket_made_public security docs",
      "bucket_removed destructive old",
      "function_added attention public.export_all()",
      "function_security_definer_added attention public.report(p_org uuid)",
      "grant_added attention public.plans (anon)",
      "view_security_invoker_removed security public.directory",
    ]);
  });
});

describe("result diff", () => {
  const spec = (target: string, operation = "select") => ({ kind: "table" as const, target, operation, actor: "tenant_a" as const });
  const evidence = { actor: "tenant_a" as const, requests: [], summary: "x" };

  it("sorts checks into new, fixed, remaining, untestable, added and removed", () => {
    const before = [
      passed(spec("public.a"), evidence),
      leaked(spec("public.b"), evidence),
      leaked(spec("public.c"), evidence),
      passed(spec("public.d"), evidence),
      passed(spec("public.gone"), evidence),
    ];
    const after = [
      leaked(spec("public.a"), evidence),
      passed(spec("public.b"), evidence),
      leaked(spec("public.c"), evidence),
      inconclusive(spec("public.d"), "server error"),
      leaked(spec("public.new"), evidence),
      notTested(spec("public.new2"), "not_applicable", "shared"),
    ];
    const diff = diffResults(before, after);
    const ids = (list: { id: string }[]) => list.map((c) => c.id.split(":")[1]);
    assert.deepEqual(ids(diff.newLeaks), ["public.a", "public.new"]);
    assert.deepEqual(ids(diff.fixedLeaks), ["public.b"]);
    assert.deepEqual(ids(diff.stillLeaking), ["public.c"]);
    assert.deepEqual(ids(diff.noLongerTested), ["public.d"]);
    assert.deepEqual(ids(diff.added), ["public.new", "public.new2"]);
    assert.deepEqual(diff.removed, [{ id: "table:public.gone:select:tenant_a", before: "pass" }]);
    assert.deepEqual(diff.newLeaks[1], { id: "table:public.new:select:tenant_a", after: "leak" });
  });
});

describe("review items, headline and exit code", () => {
  const ok = { onSeededData: { ok: true }, onFreshDatabase: { ok: true } };

  it("lists each fact once, even when the scan and the catalog diff both see it", () => {
    const statements = scanMigrations([{ name: "20261101000000_x.sql", sql: "alter table public.clients drop column name;\ntruncate public.plans;" }]);
    const before = agencyCatalog();
    const after = changed((c) => relation(c, "public.clients").columns.pop());
    const items = reviewItems(statements, diffCatalogs(before, after), ok);
    assert.deepEqual(items.map((i) => `${i.topic} ${i.source} ${i.line ?? ""}`), ["deletes_column statement 1", "empties_table statement 2"]);
  });

  it("keeps catalog-only facts, and ignores attention and info findings", () => {
    const statements = scanMigrations([{ name: "20261101000000_x.sql", sql: "grant select on public.t to authenticated;" }]);
    const after = changed((c) => {
      relation(c, "public.invoices").rlsEnabled = false;
    });
    const items = reviewItems(statements, diffCatalogs(agencyCatalog(), after), ok);
    assert.deepEqual(items.map((i) => `${i.topic} ${i.source}`), ["disables_rls catalog"]);
  });

  it("explains a migration that fails on existing data, or cannot be applied at all", () => {
    const seeded = reviewItems([], [], { onSeededData: { ok: false, error: "ERROR: null values" }, onFreshDatabase: { ok: true } });
    assert.deepEqual(seeded.map((i) => i.topic), ["fails_on_existing_data"]);
    assert.match(seeded[0]?.message ?? "", /empty database but failed on one that already holds data.*null values/);
    const fresh = reviewItems([], [], { onSeededData: { ok: false, error: "x" }, onFreshDatabase: { ok: false, error: "ERROR: no such table" } });
    assert.deepEqual(fresh.map((i) => i.topic), ["fails_to_apply"]);
  });

  it("writes a plain-English headline", () => {
    const empty = diffResults([], []);
    const clean = summarize([passed({ kind: "table", target: "public.a", operation: "select", actor: "anon" }, undefined)]);
    assert.equal(migrationHeadline(empty, [], clean), "This migration introduces no new leaks. Nothing in it needs a human review.");
    const statements = scanMigrations([{ name: "20261101000000_x.sql", sql: "drop table a; drop table b; alter table c disable row level security;" }]);
    const review = reviewItems(statements, [], ok);
    const withLeak = { ...empty, newLeaks: [{ id: "x", after: "leak" as const }] };
    assert.equal(
      migrationHeadline(withLeak, review, clean),
      "This migration introduces 1 new leak. It needs a human review before it ships: it deletes 2 tables and switches row level security off on a table.",
    );
  });

  it("combines the after run's exit code with the review: 1 beats 4, 4 beats 2 and 0", () => {
    const review = reviewItems(scanMigrations([{ name: "20261101000000_x.sql", sql: "drop table a;" }]), [], ok);
    const evidence = { actor: "tenant_a" as const, requests: [], summary: "x" };
    const spec = { kind: "table" as const, target: "public.a", operation: "select", actor: "tenant_a" as const };
    const leaky = summarize([leaked(spec, evidence)]);
    const unclear = summarize([inconclusive(spec, "x")]);
    const clean = summarize([passed(spec, evidence)]);
    assert.deepEqual([diffSummary(leaky, review).exitCode, diffSummary(leaky, review).verdict], [EXIT.leaks, "leaks_found"]);
    assert.deepEqual([diffSummary(unclear, review).exitCode, diffSummary(unclear, review).verdict], [EXIT.migrationReview, "review_needed"]);
    assert.deepEqual([diffSummary(clean, review).exitCode, diffSummary(clean, review).verdict], [EXIT.migrationReview, "review_needed"]);
    assert.deepEqual([diffSummary(clean, []).exitCode, diffSummary(clean, []).verdict], [EXIT.clean, "clean"]);
    assert.deepEqual([diffSummary(unclear, []).exitCode, diffSummary(unclear, []).verdict], [EXIT.inconclusive, "inconclusive"]);
  });
});

describe("migration mode inputs and assembly", () => {
  async function folder(files: Record<string, string>): Promise<string> {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "unit-diff-"));
    created.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  }

  it("reads the given migrations in file-name order and checks their names", async () => {
    const dir = await folder({ "20261101000002_b.sql": "select 2;", "20261101000001_a.sql": "select 1;", "notes.sql": "x" });
    const files = await readMigrationFiles([join(dir, "20261101000002_b.sql"), join(dir, "20261101000001_a.sql")]);
    assert.deepEqual(files.map((f) => f.name), ["20261101000001_a.sql", "20261101000002_b.sql"]);
    await assert.rejects(readMigrationFiles([]), /Missing --migration/);
    await assert.rejects(readMigrationFiles([join(dir, "notes.sql")]), /not named like a Supabase migration/);
    await assert.rejects(readMigrationFiles([join(dir, "20261101000009_missing.sql")]), /does not exist/);
    await assert.rejects(readMigrationFiles([join(dir, "20261101000001_a.sql"), join(dir, "20261101000001_a.sql")]), /given twice/);
  });

  it("refuses new migrations that would run before existing ones", () => {
    assert.doesNotThrow(() => assertAppliedLast(["20261031000001_a.sql"], ["20261101000000_new.sql"]));
    assert.throws(() => assertAppliedLast(["20261031000001_a.sql", "20261102000000_b.sql"], ["20261101000000_new.sql"]), /would run before 20261102000000_b\.sql/);
  });

  it("assembles a diff with new leaks, catalog changes, statements and review", () => {
    const diff = sampleDiff();
    assert.deepEqual(diff.migration.results.newLeaks.map((c) => c.id), ["table:public.invoices:select:tenant_a"]);
    assert.deepEqual(diff.migration.statements.map((s) => `${s.line} ${s.rule}`), ["2 drop_column", "3 drop_policy"]);
    assert.ok(diff.migration.catalogChanges.some((c) => c.kind === "column_removed" && c.object === "public.invoices.number"));
    assert.deepEqual(diff.migration.review.map((r) => r.topic), ["deletes_column", "removes_policy"]);
    assert.equal(diff.summary.exitCode, EXIT.leaks);
    assert.equal(diff.migration.before.summary.verdict, "inconclusive");
    assert.match(diff.migration.headline, /^This migration introduces 1 new leak\. It needs a human review/);
  });

  it("reports a migration that cannot be applied at all as needing review, with nothing tested after it", () => {
    const diff = sampleDiff({ freshFails: true });
    assert.equal(diff.summary.exitCode, EXIT.migrationReview);
    assert.equal(diff.summary.verdict, "review_needed");
    assert.deepEqual(diff.checks, []);
    assert.deepEqual(diff.migration.results.removed, [], "nothing is compared without an after run");
    assert.match(diff.summary.runProblems.join(" "), /could not be applied/);
    assert.match(diff.migration.headline, /^This migration could not be applied/);
    assert.equal(diff.migration.review.at(-1)?.topic, "fails_to_apply");
  });
});
