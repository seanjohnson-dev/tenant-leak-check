import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { needsReview, qualifiedName, scanMigrations, splitStatements, type StatementRule } from "../../src/migrate/scan.ts";

const scan = (sql: string) => scanMigrations([{ name: "20261101000000_x.sql", sql }]);
const rules = (sql: string): string[] => scan(sql).map((f) => `${f.rule} ${f.severity} ${f.object}`);

describe("migration scanner: reading SQL", () => {
  it("splits statements and keeps the line each one starts on", () => {
    const statements = splitStatements("select 1;\n\n-- note; with a semicolon\nselect\n  2;\n/* multi\nline; */ select 3;");
    assert.deepEqual(statements.map((s) => [s.line, s.text]), [[1, "select 1"], [4, "select 2"], [7, "select 3"]]);
  });

  it("ignores keywords and semicolons inside strings, comments and function bodies", () => {
    const sql = [
      "insert into notes (body) values ('drop table x; truncate y');",
      "-- drop table commented_out;",
      "/* alter table t disable row level security; /* nested */ still a comment */",
      "create function f() returns void language plpgsql as $body$ begin delete from t; truncate t; end $body$;",
      "select E'it\\'s; fine', $$ drop table z $$;",
    ].join("\n");
    assert.deepEqual(rules(sql), []);
    assert.equal(splitStatements(sql).length, 3);
  });

  it("keeps the case of quoted names and qualifies unqualified ones with public", () => {
    assert.equal(qualifiedName('"Billing"."Invoices"'), "Billing.Invoices");
    assert.equal(qualifiedName("invoices"), "public.invoices");
    assert.deepEqual(rules('drop policy "Members Read" on "Sales".deals;'), ['drop_policy security Sales.deals: Members Read']);
  });

  it("keeps the original statement text, shortened for the report", () => {
    const [finding] = scan(`DROP   TABLE public.big_table_${"x".repeat(300)};`);
    assert.ok(finding);
    assert.match(finding.statement, /^DROP TABLE public\.big_table_x+…$/);
    assert.equal(finding.statement.length, 200);
  });
});

describe("migration scanner: rules", () => {
  const cases: [string, StatementRule, string, string][] = [
    ["drop table if exists public.a, b cascade;", "drop_table", "destructive", "public.a"],
    ["drop view public.v;", "drop_view", "destructive", "public.v"],
    ["drop materialized view if exists public.mv;", "drop_view", "destructive", "public.mv"],
    ["drop function public.f(uuid, text);", "drop_function", "destructive", "public.f"],
    ['drop policy "p" on public.t;', "drop_policy", "security", "public.t: p"],
    ["drop schema reporting cascade;", "drop_schema", "destructive", "public.reporting"],
    ["drop trigger set_org on public.t;", "drop_trigger", "destructive", "public.t: set_org"],
    ["truncate table only public.t restart identity;", "truncate", "destructive", "public.t"],
    ["alter table public.t drop column email;", "drop_column", "destructive", "public.t.email"],
    ["alter table if exists only public.t drop if exists email cascade;", "drop_column", "destructive", "public.t.email"],
    ["alter table public.t alter column amount type numeric(8,2) using amount::numeric;", "alter_column_type", "destructive", "public.t.amount"],
    ["delete from public.t;", "delete_without_where", "destructive", "public.t"],
    ["update public.t set status = 'x';", "update_without_where", "destructive", "public.t"],
    ["alter table public.t disable row level security;", "disable_rls", "security", "public.t"],
    ["alter table public.t no force row level security;", "no_force_rls", "security", "public.t"],
    ["grant select, insert on public.t to anon;", "grant_to_clients", "security", "public.t"],
    ["grant all on table public.t to public;", "grant_to_clients", "security", "table public.t"],
    ["alter default privileges in schema public grant all on tables to anon;", "grant_to_clients", "security", "tables"],
    ["grant select on public.t to authenticated;", "grant_to_clients", "attention", "public.t"],
    ["grant usage on schema public to anon;", "grant_to_clients", "attention", "schema public"],
    ["create or replace function public.f() returns int language sql security definer as $$ select 1 $$;", "security_definer", "attention", "public.f"],
    ['create policy "all" on public.t for select to authenticated using (true);', "policy_always_true", "security", "public.t: all"],
    ['create policy "w" on public.t for insert with check ((true));', "policy_always_true", "security", "public.t: w"],
    ["do $$ begin perform 1; end $$;", "do_block", "attention", "DO block"],
  ];
  for (const [sql, rule, severity, object] of cases) {
    it(`flags ${rule}: ${sql}`, () => {
      const found = scan(sql).find((f) => f.rule === rule);
      assert.ok(found, `${rule} not found in ${JSON.stringify(scan(sql))}`);
      assert.equal(found.severity, severity);
      assert.equal(found.object, object);
      assert.ok(found.message.length > 20);
    });
  }

  it("lists every name of a multi-table statement", () => {
    assert.deepEqual(rules("truncate a, public.b;"), ["truncate destructive public.a", "truncate destructive public.b"]);
    assert.deepEqual(rules("alter table t drop column a, drop column b, alter c type int;"), [
      "drop_column destructive public.t.a",
      "drop_column destructive public.t.b",
      "alter_column_type destructive public.t.c",
    ]);
  });

  it("does not flag healthy statements", () => {
    const healthy = [
      "create table public.t (id uuid primary key, org_id uuid not null);",
      "alter table public.t enable row level security;",
      "alter table public.t force row level security;",
      "alter table public.t drop constraint t_fk, add column note text;",
      "alter table public.t alter column note set default '';",
      "delete from public.t where id = 1;",
      "update public.t set note = '' where org_id is null;",
      "insert into public.t (id) values (gen_random_uuid()) on conflict (id) do update set note = excluded.note;",
      'create policy "own" on public.t for select to authenticated using (org_id = (select auth.uid()));',
      "grant anon to authenticator;",
      "create function public.f() returns int language sql security invoker as $$ select 1 $$;",
    ];
    assert.deepEqual(rules(healthy.join("\n")), []);
  });

  it("downgrades a policy, view, function or trigger that is dropped and created again", () => {
    const findings = scan([
      'drop policy "read" on public.t;',
      'create policy "read" on t for select to authenticated using (org_id is not null);',
      "drop view public.v;",
      "create view public.v as select 1;",
      "drop function public.f(int);",
      "create or replace function public.f(int) returns int language sql as $$ select 1 $$;",
      "drop trigger trg on public.t;",
      "create trigger trg after insert on public.t for each row execute function public.f();",
      'drop policy "gone" on public.t;',
      "drop table public.t;",
      "create table public.t (id int);",
    ].join("\n"));
    const severity = Object.fromEntries(findings.map((f) => [`${f.rule} ${f.object}`, f.severity]));
    assert.equal(severity["drop_policy public.t: read"], "attention");
    assert.equal(severity["drop_view public.v"], "attention");
    assert.equal(severity["drop_function public.f"], "attention");
    assert.equal(severity["drop_trigger public.t: trg"], "attention");
    assert.equal(severity["drop_policy public.t: gone"], "security", "a policy that is not re-created stays a security finding");
    assert.equal(severity["drop_table public.t"], "destructive", "re-creating a table does not bring its rows back");
    assert.match(findings.find((f) => f.rule === "drop_view")?.message ?? "", /created again/);
  });

  it("reports the file and line of each finding across several migrations", () => {
    const findings = scanMigrations([
      { name: "20261101000000_a.sql", sql: "select 1;\n\ndrop table public.a;" },
      { name: "20261101000001_b.sql", sql: "\n\n\ntruncate public.b;" },
    ]);
    assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.rule}`), ["20261101000000_a.sql:3 drop_table", "20261101000001_b.sql:4 truncate"]);
  });

  it("only destructive and security findings need a review", () => {
    assert.equal(needsReview("destructive"), true);
    assert.equal(needsReview("security"), true);
    assert.equal(needsReview("attention"), false);
    assert.equal(needsReview("info"), false);
  });
});
