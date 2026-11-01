import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findingsFor, ownerCondition, SQL_LABEL } from "../../src/analyze/fixes.ts";
import { staticWarnings } from "../../src/analyze/rules.ts";
import { emptyConfig, validateConfig } from "../../src/config/config.ts";
import { leaked } from "../../src/core/results.ts";
import { buildTenancyModel } from "../../src/discover/tenancy.ts";
import { agencyCatalog, fn, policy } from "./fixtures.ts";

const MEMBER = "org_id in (select org_id from org_members where user_id = (select auth.uid()))";

function catalogWith(changes: (catalog: ReturnType<typeof agencyCatalog>) => void) {
  const catalog = agencyCatalog();
  changes(catalog);
  return catalog;
}

const relation = (catalog: ReturnType<typeof agencyCatalog>, name: string) => {
  const found = catalog.relations.find((r) => r.qualified === name);
  assert.ok(found);
  return found;
};

describe("static rules", () => {
  it("flags disabled RLS and policies that are ignored because of it", () => {
    const catalog = catalogWith((c) => {
      const invoices = relation(c, "public.invoices");
      invoices.rlsEnabled = false;
      invoices.policies = [policy("public.invoices", "Members", "all", { using: MEMBER, withCheck: MEMBER })];
    });
    const rules = staticWarnings(catalog, buildTenancyModel(catalog, emptyConfig()), emptyConfig()).map((w) => `${w.rule} ${w.object}`);
    assert.ok(rules.includes("rls_disabled public.invoices"));
    assert.ok(rules.includes("policies_without_rls public.invoices"));
  });

  it("flags USING (true), policies that ignore the owner, and missing WITH CHECK", () => {
    const catalog = catalogWith((c) => {
      relation(c, "public.invoices").policies = [
        policy("public.invoices", "Open", "select", { using: "true" }),
        policy("public.invoices", "Any member", "select", { using: "(EXISTS ( SELECT 1 FROM org_members WHERE (org_members.user_id = auth.uid())))" }),
        policy("public.invoices", "Update", "update", { using: MEMBER }),
      ];
      relation(c, "public.org_members").policies = [policy("public.org_members", "Own", "select", { using: "(user_id = auth.uid())" })];
      relation(c, "public.plans").policies = [policy("public.plans", "Read plans", "select", { using: "true", roles: ["anon", "authenticated"] })];
    });
    const warnings = staticWarnings(catalog, buildTenancyModel(catalog, emptyConfig()), emptyConfig());
    const rules = warnings.map((w) => `${w.rule} ${w.object}`);
    assert.ok(rules.includes('policy_always_true policy "Open" on public.invoices'));
    assert.ok(rules.includes('policy_ignores_owner policy "Any member" on public.invoices'));
    assert.ok(rules.includes('update_without_with_check policy "Update" on public.invoices'));
    assert.ok(!rules.some((r) => r.includes("org_members")), "reading your own membership rows is fine");
    assert.ok(!rules.some((r) => r.includes("Read plans")), "reading shared reference data is fine");
  });

  it("does not flag RESTRICTIVE policies, which can only narrow access", () => {
    const catalog = catalogWith((c) => {
      relation(c, "public.invoices").policies = [
        policy("public.invoices", "Members", "all", { using: MEMBER, withCheck: MEMBER }),
        policy("public.invoices", "Maintenance mode", "all", { using: "app_open()", permissive: false }),
        policy("public.invoices", "Always", "select", { using: "true", permissive: false }),
      ];
    });
    const rules = staticWarnings(catalog, buildTenancyModel(catalog, emptyConfig()), emptyConfig()).map((w) => `${w.rule} ${w.object}`);
    assert.ok(!rules.some((r) => r.includes("Maintenance mode") || r.includes('"Always"')), rules.join("\n"));
  });

  it("flags views that bypass RLS, exposed materialized views, SECURITY DEFINER functions and public buckets", () => {
    const catalog = catalogWith((c) => {
      const view = relation(c, "public.clients");
      c.relations.push({ ...view, name: "client_list", qualified: "public.client_list", kind: "view", policies: [] });
      c.relations.push({ ...view, name: "revenue", qualified: "public.revenue", kind: "materialized_view", policies: [] });
      c.functions.push(fn("public.get_all", { securityDefiner: true, signature: "p_org uuid" }));
      c.functions.push(fn("public.safe", { securityDefiner: true, executable: { anon: false, authenticated: false } }));
      c.buckets.push({ id: "media", name: "media", public: true, allowedMimeTypes: [] });
    });
    const config = validateConfig({ storage: { allowPublic: ["media"] } });
    const warnings = staticWarnings(catalog, buildTenancyModel(catalog, config), config);
    const rules = warnings.map((w) => `${w.rule} ${w.object}`);
    assert.ok(rules.includes("view_bypasses_rls public.client_list"));
    assert.ok(rules.includes("materialized_view_exposed public.revenue"));
    assert.ok(rules.includes("security_definer_callable public.get_all(p_org uuid)"));
    assert.ok(!rules.some((r) => r.includes("public.safe")), "functions clients cannot call are not flagged");
    assert.match(warnings.find((w) => w.rule === "public_bucket")?.message ?? "", /marks this as intended/);
  });
});

describe("fix suggestions", () => {
  const catalog = agencyCatalog();
  const tenancy = buildTenancyModel(catalog, emptyConfig());

  it("builds the owner condition from the tenancy model", () => {
    const own = (name: string) => tenancy.tables.get(name)?.ownership ?? { kind: "shared" as const, source: "detected" as const };
    assert.equal(
      ownerCondition(own("public.invoices"), tenancy),
      '"org_id" in (select "org_id" from "public"."org_members" where "user_id" = (select auth.uid()))',
    );
    assert.equal(ownerCondition(own("public.notes"), tenancy), '"user_id" = (select auth.uid())');
    assert.equal(ownerCondition(own("public.payments"), tenancy), '"invoice_id" in (select "id" from "public"."invoices")');
    assert.equal(ownerCondition(own("public.plans"), tenancy), undefined);
  });

  it("gives every leak a plain-English problem, fix and labelled SQL", () => {
    const evidence = { actor: "tenant_a" as const, requests: [], summary: "x" };
    const checks = [
      leaked({ kind: "table", target: "public.invoices", operation: "update_reassign", actor: "tenant_a" }, evidence),
      leaked({ kind: "table", target: "public.notes", operation: "select", actor: "anon" }, { ...evidence, actor: "anon" }),
      leaked({ kind: "table", target: "public.plans", operation: "delete", actor: "tenant_a" }, evidence),
      leaked({ kind: "rpc", target: "public.get_all", operation: "execute", actor: "tenant_a" }, evidence),
    ];
    const withFn = { ...catalog, functions: [fn("public.get_all", { securityDefiner: true, signature: "p_org uuid" })] };
    const findings = findingsFor(checks, withFn, tenancy);
    assert.equal(findings.length, 4);
    for (const finding of findings) {
      assert.ok(finding.title && finding.problem && finding.fix);
      if (finding.sql) assert.ok(finding.sql.startsWith(SQL_LABEL));
    }
    assert.match(findings[0]?.sql ?? "", /with check \("org_id" in/);
    assert.match(findings[1]?.sql ?? "", /revoke all on "public"."notes" from anon;/);
    assert.match(findings[2]?.sql ?? "", /revoke insert, update, delete on "public"."plans"/);
    assert.match(findings[3]?.sql ?? "", /alter function "public"."get_all"\(p_org uuid\) security invoker;/);
  });

  it("replaces only the leaking operation's policies and never drops a FOR ALL policy that guards the others", () => {
    const withPolicies = agencyCatalog();
    const clients = withPolicies.relations.find((r) => r.qualified === "public.clients");
    assert.ok(clients);
    clients.policies.push(
      policy("public.clients", "Members manage their clients", "all", { using: "(org_id = x)", withCheck: "(org_id = x)" }),
      policy("public.clients", "Anyone reads", "select", { using: "true" }),
    );
    const evidence = { actor: "tenant_a" as const, requests: [], summary: "x" };
    const [finding] = findingsFor([leaked({ kind: "table", target: "public.clients", operation: "select", actor: "tenant_a" }, evidence)], withPolicies, buildTenancyModel(withPolicies, emptyConfig()));
    const sql = finding?.sql ?? "";
    assert.match(sql, /^drop policy "Anyone reads" on "public"."clients";$/m);
    assert.doesNotMatch(sql, /^drop policy "Members manage their clients"/m);
    assert.match(sql, /^-- Also check the policy "Members manage their clients" \(FOR ALL\)/m);
    assert.match(sql, /create policy "Tenant members can select their own rows"/);
  });
});
