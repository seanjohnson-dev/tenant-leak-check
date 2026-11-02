import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT } from "../../src/core/exit-codes.ts";
import type { CheckResult } from "../../src/core/results.ts";
import { PROJECT_ID_PREFIX, sandboxSlug } from "../../src/stack/sandbox.ts";
import { StackManager } from "../../src/stack/supabase.ts";
import { validate } from "../unit/schema-validator.ts";

/*
 * Needs Docker and the Supabase CLI (run with: npm run test:integration).
 * demo/fixed plus three test-only functions, through the CLI: an RPC check never passes on
 * an input refusal or a failed control call, and the written reports give the reason.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const workdir = `${repo}.tlc-work`;
const base = `${workdir}/it-rpc-control`;
const projectDir = `${base}/project`;
const out = `${base}/report`;
const schema = JSON.parse(readFileSync(`${repo}docs/report.schema.json`, "utf8")) as Record<string, unknown>;
const TIMEOUT = 20 * 60_000;

const FUNCTIONS_SQL = `-- Test-only functions for the RPC control check (not part of the demo).

-- Refuses every input it does not know, even for the owner: the control call fails.
create function public.tlc_run_action(p_action text, p_org_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_action not in ('archive', 'restore') then
    raise exception 'unknown action: %', p_action;
  end if;
end;
$$;

-- Works for the owner, but answers another tenant with an input-style message.
create function public.invoice_number_checked(p_invoice_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_number text;
begin
  select i.number into found_number from public.invoices i
  where i.id = p_invoice_id
    and i.org_id in (select m.org_id from public.org_members m where m.user_id = (select auth.uid()));
  if found_number is null then
    raise exception 'invalid invoice id';
  end if;
  return found_number;
end;
$$;

-- Works for the owner and refuses another tenant for who they are.
create function public.invoice_number_guarded(p_invoice_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_number text;
begin
  select i.number into found_number from public.invoices i
  where i.id = p_invoice_id
    and i.org_id in (select m.org_id from public.org_members m where m.user_id = (select auth.uid()));
  if found_number is null then
    raise exception 'Not your invoice';
  end if;
  return found_number;
end;
$$;

revoke execute on function public.invoice_number_checked(uuid) from public, anon;
revoke execute on function public.invoice_number_guarded(uuid) from public, anon;
grant execute on function public.invoice_number_checked(uuid) to authenticated;
grant execute on function public.invoice_number_guarded(uuid) to authenticated;
`;

function runCli(): Promise<{ code: number; stdout: string }> {
  const args = [cli, "run", "--project", projectDir, "--workdir", workdir, "--out", out];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      resolve({ code, stdout });
    });
  });
}

describe("RPC control call on a real stack (demo/fixed plus test functions)", { timeout: TIMEOUT }, () => {
  let code: number;
  let stdout: string;
  let report: { summary: { verdict: string; exitCode: number; counts: Record<string, number> }; checks: CheckResult[]; notTested: { checkId: string; reason: string }[] };
  const check = (id: string): CheckResult => {
    const found = report.checks.find((c) => c.id === id);
    assert.ok(found, `${id} was not run`);
    return found;
  };

  before(async () => {
    await rm(base, { recursive: true, force: true });
    const migrations = `${projectDir}/supabase/migrations`;
    await mkdir(migrations, { recursive: true });
    for (const file of await readdir(`${repo}demo/fixed/supabase/migrations`)) {
      await copyFile(`${repo}demo/fixed/supabase/migrations/${file}`, `${migrations}/${file}`);
    }
    await writeFile(`${migrations}/20261102000001_rpc_control_functions.sql`, FUNCTIONS_SQL);
    ({ code, stdout } = await runCli());
    report = JSON.parse(await readFile(`${out}/report.json`, "utf8"));
  }, { timeout: TIMEOUT });

  it("no leaks, but unclear checks: exit code 2, not 0", () => {
    assert.equal(code, EXIT.inconclusive, stdout);
    assert.equal(report.summary.verdict, "inconclusive");
    assert.equal(report.summary.counts.leak, 0);
    assert.deepEqual(validate(schema, report), []);
  });

  it("a failed control call is unclear for both callers, and only the owner was called", () => {
    for (const actor of ["tenant_a", "anon"]) {
      const result = check(`rpc:public.tlc_run_action:execute:${actor}`);
      assert.equal(result.status, "inconclusive");
      assert.match(result.reason ?? "", /^Control call failed: .*unknown action/);
      assert.equal(result.evidence?.requests.length, 1);
    }
  });

  it("an input refusal after a working control is unclear; a permission denial passes", () => {
    const forA = check("rpc:public.invoice_number_checked:execute:tenant_a");
    assert.equal(forA.status, "inconclusive", forA.notes.join(" "));
    assert.match(forA.reason ?? "", /^Refused the input, not the tenant: .*invalid invoice id/);
    assert.equal(forA.evidence?.requests[0]?.status, 200, "the owner's control call worked");
    assert.equal(check("rpc:public.invoice_number_checked:execute:anon").status, "pass");
  });

  it("a real refusal of the other tenant after a working control passes", () => {
    const forA = check("rpc:public.invoice_number_guarded:execute:tenant_a");
    assert.equal(forA.status, "pass", forA.reason);
    assert.deepEqual(forA.notes, ["The function refused the call: Not your invoice."]);
    assert.equal(forA.evidence?.requests.length, 2);
    assert.equal(check("rpc:public.invoice_number_guarded:execute:anon").status, "pass");
  });

  it("the demo's own functions still pass, after a working control call", () => {
    for (const id of ["rpc:public.get_org_invoices:execute:tenant_a", "rpc:public.get_org_invoices:execute:anon", "rpc:public.delete_project:execute:tenant_a", "rpc:public.delete_project:execute:anon"]) {
      const result = check(id);
      assert.equal(result.status, "pass", `${id}: ${result.reason ?? ""}`);
      assert.ok((result.evidence?.requests[0]?.status ?? 0) < 300, `${id}: control call failed`);
    }
  });

  it("only the three expected checks are unclear", () => {
    const unclear = report.checks.filter((c) => c.status === "inconclusive").map((c) => c.id).sort();
    assert.deepEqual(unclear, ["rpc:public.invoice_number_checked:execute:tenant_a", "rpc:public.tlc_run_action:execute:anon", "rpc:public.tlc_run_action:execute:tenant_a"]);
  });

  it("the CLI summary, JSON, Markdown and HTML reports show the reasons", async () => {
    const markdown = await readFile(`${out}/report.md`, "utf8");
    const html = await readFile(`${out}/report.html`, "utf8");
    for (const text of [stdout, markdown, html]) {
      assert.match(text, /Control call failed: /);
      assert.match(text, /Refused the input, not the tenant: /);
    }
    assert.match(stdout, /UNCLEAR {2}rpc:public\.tlc_run_action:execute:tenant_a/);
    assert.ok(report.notTested.some((n) => n.checkId === "rpc:public.invoice_number_checked:execute:tenant_a" && n.reason.startsWith("Refused the input, not the tenant: ")));
  });
});

after(async () => {
  await rm(base, { recursive: true, force: true });
  const stack = new StackManager();
  const ours = `${PROJECT_ID_PREFIX}${sandboxSlug(projectDir)}`;
  for (const id of await stack.runningOwnStacks()) if (id === ours) await stack.stopProject(id);
});
