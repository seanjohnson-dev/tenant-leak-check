import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatRunSummary } from "../../src/commands/run.ts";
import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT_MEANING } from "../../src/core/exit-codes.ts";
import { esc, renderHtml } from "../../src/report/html.ts";
import { buildJsonReport, renderJson, SCHEMA_VERSION } from "../../src/report/json.ts";
import { md, renderMarkdown } from "../../src/report/markdown.ts";
import { buildMatrices, NOT_COVERED, notTestedChecks, statusLabel } from "../../src/report/text.ts";
import { redactReport, writeReports } from "../../src/report/write.ts";
import { HOSTILE, sampleDiff, sampleRun } from "./report-fixtures.ts";
import { validate } from "./schema-validator.ts";

const schema = JSON.parse(await readFile(new URL("../../docs/report.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const scratch = fileURLToPath(new URL("../../.tlc-work/", import.meta.url));
const created: string[] = [];
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

const FORBIDDEN_CLAIMS = /\b(is secure|are secure|certified|compliant|guaranteed safe)\b/i;

describe("JSON report", () => {
  it("matches the published schema for run and diff reports", () => {
    for (const result of [sampleRun(), sampleDiff(), sampleDiff({ seededFails: true }), sampleDiff({ freshFails: true })]) {
      assert.deepEqual(validate(schema, buildJsonReport(result)), []);
    }
  });

  it("the schema rejects reports that break the format", () => {
    const report = buildJsonReport(sampleDiff()) as unknown as Record<string, unknown>;
    assert.ok(validate(schema, { ...report, disclaimer: "All good." }).length > 0, "a report without the disclaimer must not validate");
    assert.ok(validate(schema, { ...report, extra: 1 }).some((e) => /unexpected property "extra"/.test(e)));
    const { migration: _migration, ...withoutMigration } = report;
    assert.ok(validate(schema, withoutMigration).some((e) => /missing required "migration"/.test(e)));
    assert.ok(validate(schema, { ...report, summary: { ...(report.summary as object), exitCode: 7 } }).length > 0);
  });

  it("carries the version, mode, disclaimer, exit meaning, gaps and what is not covered", () => {
    const report = buildJsonReport(sampleRun());
    assert.equal(report.schemaVersion, SCHEMA_VERSION);
    assert.equal(report.mode, "run");
    assert.equal(report.disclaimer, DISCLAIMER_FULL);
    assert.equal(report.summary.exitMeaning, EXIT_MEANING[report.summary.exitCode]);
    assert.deepEqual(report.notCovered, [...NOT_COVERED]);
    assert.deepEqual(report.notTested.map((n) => `${n.status} ${n.kind ?? ""}`), ["inconclusive ", "not_tested could_not_test", "not_tested excluded", "not_tested not_applicable"]);
    assert.equal(buildJsonReport(sampleDiff()).mode, "diff");
    assert.equal(buildJsonReport(sampleDiff()).migration?.before.summary.exitMeaning, EXIT_MEANING[2]);
  });

  it("is stable JSON that parses back", () => {
    const text = renderJson(sampleDiff());
    assert.ok(text.endsWith("\n"));
    assert.equal(JSON.parse(text).migration.files[0], "20261101090000_cleanup.sql");
  });
});

describe("Markdown and HTML reports", () => {
  for (const [name, render] of [["Markdown", renderMarkdown], ["HTML", renderHtml]] as const) {
    it(`${name}: carries the full disclaimer, the verdict and every required section`, () => {
      const text = render(sampleRun());
      assert.ok(text.includes(name === "HTML" ? esc(DISCLAIMER_FULL) : DISCLAIMER_FULL));
      assert.ok(text.includes(name === "HTML" ? esc(DISCLAIMER_SHORT) : DISCLAIMER_SHORT));
      for (const section of ["What we tested", "Results", "Leaks found (1)", "Warnings from the schema review", "Not tested, and why", "Not covered by this check", "How we decided who owns each table", "Glossary"]) {
        assert.ok(text.includes(section), `${section} missing`);
      }
      assert.doesNotMatch(text, FORBIDDEN_CLAIMS);
      assert.match(text, /Exit code 1: /);
    });

    it(`${name}: every leak has its evidence, problem, fix and labelled SQL`, () => {
      const text = render(sampleRun());
      for (const part of ["table:public.invoices:select:tenant_a", "GET /rest/v1/invoices?select=*&amp;id=eq.b-1", "belongs to tenant B and exists", "A read policy on public.invoices matches rows of other tenants.", "Limit the read policy", "-- Starting point: review before applying."]) {
        const expected = name === "HTML" ? part : part.replace("&amp;", "&");
        assert.ok(text.includes(expected), `${expected} missing`);
      }
    });

    it(`${name}: migration reports lead with the headline, review items and statements`, () => {
      const text = render(sampleDiff());
      const headline = text.indexOf("What this migration changes");
      assert.ok(headline > 0 && headline < text.indexOf("What we tested"));
      for (const part of ["This migration introduces 1 new leak", "Needs a human review", "20261101090000_cleanup.sql", "line 2", "Deletes the column number from public.invoices", "Changes to the database structure", "Before the migration"]) {
        assert.ok(text.includes(part), `${part} missing`);
      }
      assert.ok(render(sampleDiff({ freshFails: true })).includes("could not be applied"));
    });
  }

  it("HTML: self-contained, no scripts, no external assets, and every value escaped", () => {
    const html = renderHtml(sampleRun());
    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<link\b|src=|@import|url\(/i);
    assert.match(html, /Content-Security-Policy/);
    assert.ok(!html.includes(HOSTILE), "hostile text must be escaped");
    assert.ok(html.includes(esc(HOSTILE)));
  });

  it("HTML: result cells always carry a text label, not colour alone", () => {
    const html = renderHtml(sampleRun());
    for (const match of html.matchAll(/<td class="status [a-z]+"[^>]*>([^<]*)<\/td>/g)) assert.ok((match[1] ?? "").trim().length > 0);
    assert.match(html, /<td class="status leak"[^>]*>LEAK<\/td>/);
  });

  it("Markdown: text from the database cannot inject links, HTML or table columns", () => {
    const text = renderMarkdown(sampleRun());
    assert.ok(!text.includes(HOSTILE));
    assert.ok(text.includes(md(HOSTILE)));
    assert.equal(md("a|b <i> [x](y) *z*"), "a\\|b \\<i\\> \\[x\\](y) \\*z\\*");
    for (const line of text.split("\n").filter((l) => l.startsWith("| `table:public.invoices"))) {
      assert.equal(line.split(/(?<!\\)\|/).length - 2, 3, `table row has the wrong number of cells: ${line}`);
    }
  });
});

describe("shared report building blocks", () => {
  it("builds one grid per kind of object with a label in every cell", () => {
    const matrices = buildMatrices(sampleRun().checks);
    assert.deepEqual(matrices.map((m) => m.title), ["Tables and views", "Storage buckets", "Database functions (RPCs)"]);
    const tables = matrices[0];
    assert.ok(tables);
    assert.deepEqual(tables.columns.map((c) => `${c.operation}:${c.actor}`), ["select:tenant_a", "select:anon", "insert:tenant_a", "update:tenant_a"]);
    assert.deepEqual(tables.rows.map((r) => r.target), ["public.invoices", "public.plans", "public.notes", "public.audit"]);
    assert.deepEqual(tables.rows[0]?.cells.map(statusLabel), ["LEAK", "Pass", "Pass", "-"]);
  });

  it("lists failures first among the checks that were not tested", () => {
    assert.deepEqual(notTestedChecks(sampleRun().checks).map((c) => c.status === "inconclusive" ? "inconclusive" : c.notTestedKind), ["inconclusive", "could_not_test", "excluded", "not_applicable"]);
  });

  it("the CLI summary shows the verdict, migration review, report paths, disclaimer and exit code", () => {
    const text = formatRunSummary(sampleDiff(), { json: "/r/report.json", markdown: "/r/report.md", html: "/r/report.html" });
    for (const part of ["(migration mode)", "NEW LEAK  table:public.invoices:select:tenant_a", "REVIEW  20261101090000_cleanup.sql line 2:", "/r/report.html", DISCLAIMER_SHORT, "Exit code 1: "]) {
      assert.ok(text.includes(part), `${part} missing`);
    }
    assert.doesNotMatch(formatRunSummary(sampleRun()), /migration/i);
  });
});

describe("writing reports", () => {
  it("writes all three files and redacts anything that looks like a secret", async () => {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "unit-report-"));
    created.push(dir);
    const result = sampleRun();
    const leak = result.checks[0];
    assert.ok(leak?.evidence?.requests[0]);
    // Made-up values shaped like secrets: the token decodes to {"alg":"HS256"}.{"role":"anon"}.signature.
    leak.evidence.requests[0].response = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl sb_secret_abc123 postgresql://postgres:hunter2@127.0.0.1:55422/postgres {"password":"pw1"}'; // gitleaks:allow
    const paths = await writeReports(result, join(dir, "out"));
    for (const path of [paths.json, paths.markdown, paths.html]) {
      const text = await readFile(path, "utf8");
      assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9\.|sb_secret_abc123|hunter2|pw1/, `${path} contains a secret`);
      assert.ok(text.length > 1000);
    }
    assert.deepEqual(validate(schema, JSON.parse(await readFile(paths.json, "utf8"))), []);
  });

  it("redaction leaves ordinary text alone", () => {
    assert.equal(redactReport("public.invoices row (id=b-1) belongs to tenant B"), "public.invoices row (id=b-1) belongs to tenant B");
    assert.equal(redactReport("postgresql://postgres:secret@127.0.0.1/db"), "postgresql://[redacted]@127.0.0.1/db");
    assert.equal(redactReport("url postgres://user:p@ss@127.0.0.1:5432/db here"), "url postgres://[redacted]@127.0.0.1:5432/db here");
    assert.equal(redactReport('"postgres://user:pa/ss@localhost/db"'), '"postgres://[redacted]@localhost/db"');
  });

  it("redacts database passwords whatever characters they hold, in every rendered format", async () => {
    const passwords = ["it's", 'pa"ss', "a<b>c", "two words", "p@ss/w:rd", "back\\slash", "amp&semi;"];
    for (const password of passwords) {
      const url = `postgresql://postgres:${password}@127.0.0.1:55422/postgres`;
      assert.doesNotMatch(redactReport(`error: ${url} failed`), new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), password);
      assert.match(redactReport(url), /^postgresql:\/\/\[redacted\]@127\.0\.0\.1:55422\/postgres$/, password);
    }
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "unit-report-"));
    created.push(dir);
    const result = sampleRun();
    const request = result.checks[0]?.evidence?.requests[0];
    assert.ok(request);
    request.response = passwords.map((password) => `postgres://u:${password}@localhost/db`).join(" ");
    const paths = await writeReports(result, join(dir, "out"));
    for (const path of [paths.json, paths.markdown, paths.html]) {
      const text = await readFile(path, "utf8");
      for (const word of ["it's", "it&#39;s", 'pa\\"ss', "pa&quot;ss", "two words", "p@ss", "slash", "amp&semi"]) assert.ok(!text.includes(word), `${path} still contains ${word}`);
    }
  });

  it("explains a folder it cannot write to", async () => {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, "unit-report-"));
    created.push(dir);
    const file = join(dir, "a-file");
    await writeFile(file, "not a folder");
    await assert.rejects(writeReports(sampleRun(), join(file, "out")), /reports could not be written/);
  });
});
