import type { ToolConfig } from "../config/config.ts";
import type { Catalog, Policy, Relation } from "../discover/catalog.ts";
import { isBaseTable, type Ownership, type TenancyModel } from "../discover/tenancy.ts";
import { clientCallable } from "../probe/rpc.ts";

export type WarningRule =
  | "rls_disabled"
  | "policies_without_rls"
  | "policy_always_true"
  | "policy_ignores_owner"
  | "update_without_with_check"
  | "view_bypasses_rls"
  | "materialized_view_exposed"
  | "security_definer_callable"
  | "public_bucket";

/** A catalog finding that supports the probes. Warnings never turn a passed probe into a leak (DESIGN.md 7.5). */
export interface Warning {
  rule: WarningRule;
  /** The table, view, function, policy or bucket concerned. */
  object: string;
  message: string;
}

const CLIENT_ROLES = new Set(["anon", "authenticated", "public"]);

function appliesToClients(policy: Policy): boolean {
  return policy.roles.some((role) => CLIENT_ROLES.has(role));
}

function clientsHaveAccess(relation: Relation): boolean {
  const { anon, authenticated } = relation.privileges;
  return [anon, authenticated].some((p) => p.select || p.insert || p.update || p.delete);
}

function isLiteralTrue(expression: string | undefined): boolean {
  return expression !== undefined && /^\(*\s*true\s*\)*$/i.test(expression.trim());
}

function mentions(expression: string, word: string): boolean {
  return new RegExp(`(?<![\\w$])"?${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?(?![\\w$])`, "i").test(expression);
}

/**
 * The columns a policy can look at to tell owners apart, for each ownership rule. On a
 * tenant table, limiting rows to the signed-in user's own (a user column) also isolates tenants.
 */
export function ownerColumns(ownership: Ownership): string[] {
  switch (ownership.kind) {
    case "tenant":
      return [ownership.tenantColumn, ...ownership.userColumns];
    case "user":
      return [ownership.userColumn];
    case "inherited":
      return ownership.columns;
    case "tenant_root":
      return [ownership.keyColumn];
    default:
      return [];
  }
}

function policyLabel(policy: Policy): string {
  return `policy "${policy.name}" on ${policy.schema}.${policy.table}`;
}

/** Applies the static rules of DESIGN.md section 7.5 to the catalog. */
export function staticWarnings(catalog: Catalog, tenancy: TenancyModel, config: ToolConfig): Warning[] {
  const warnings: Warning[] = [];
  for (const relation of catalog.relations) {
    const ownership = tenancy.tables.get(relation.qualified)?.ownership;
    if (ownership?.kind === "skipped") continue;
    if (isBaseTable(relation)) {
      if (!relation.rlsEnabled && clientsHaveAccess(relation)) {
        warnings.push({
          rule: "rls_disabled",
          object: relation.qualified,
          message: `Row level security is switched off for ${relation.qualified}, and clients have access to it, so every row is open to them.`,
        });
      }
      if (!relation.rlsEnabled && relation.policies.length > 0) {
        warnings.push({
          rule: "policies_without_rls",
          object: relation.qualified,
          message: `${relation.qualified} has ${relation.policies.length} polic${relation.policies.length === 1 ? "y" : "ies"}, but row level security is not enabled, so Postgres ignores them.`,
        });
      }
      for (const policy of relation.policies.filter(appliesToClients)) {
        const sharedRead = ownership?.kind === "shared" && policy.command === "select";
        if (!sharedRead && (isLiteralTrue(policy.using) || isLiteralTrue(policy.withCheck))) {
          warnings.push({
            rule: "policy_always_true",
            object: policyLabel(policy),
            message: `The ${policyLabel(policy)} allows every row (${isLiteralTrue(policy.using) ? "USING (true)" : "WITH CHECK (true)"}) for ${policy.roles.join(", ")}.`,
          });
          continue;
        }
        const columns = ownership ? ownerColumns(ownership) : [];
        if (columns.length > 0) {
          const expressions = [policy.using, policy.withCheck].filter((e): e is string => e !== undefined);
          const ignores = expressions.some((expression) => !columns.some((column) => mentions(expression, column)));
          if (ignores) {
            warnings.push({
              rule: "policy_ignores_owner",
              object: policyLabel(policy),
              message: `The ${policyLabel(policy)} does not look at ${columns.join(" or ")}, the column${columns.length === 1 ? "" : "s"} that say${columns.length === 1 ? "s" : ""} who a row belongs to.`,
            });
          }
        }
        if ((policy.command === "update" || policy.command === "all") && policy.withCheck === undefined && columns.length > 0) {
          warnings.push({
            rule: "update_without_with_check",
            object: policyLabel(policy),
            message: `The ${policyLabel(policy)} has no WITH CHECK, so Postgres reuses its USING rule for changed rows. Add an explicit WITH CHECK that pins the owner.`,
          });
        }
      }
    }
    const readable = relation.privileges.anon.select || relation.privileges.authenticated.select;
    if (relation.kind === "view" && !relation.securityInvoker && relation.ownerBypassesRls && readable) {
      warnings.push({
        rule: "view_bypasses_rls",
        object: relation.qualified,
        message: `The view ${relation.qualified} runs with its owner's rights (${relation.owner}), which skip row level security on the tables it reads. Set security_invoker = true.`,
      });
    }
    if (relation.kind === "materialized_view" && readable) {
      warnings.push({
        rule: "materialized_view_exposed",
        object: relation.qualified,
        message: `The materialized view ${relation.qualified} is readable by clients. Materialized views cannot have row level security, so every row in it is visible.`,
      });
    }
  }
  for (const policy of catalog.storagePolicies.filter(appliesToClients)) {
    if (isLiteralTrue(policy.using) || isLiteralTrue(policy.withCheck)) {
      warnings.push({
        rule: "policy_always_true",
        object: policyLabel(policy),
        message: `The storage ${policyLabel(policy)} allows every file (${isLiteralTrue(policy.using) ? "USING (true)" : "WITH CHECK (true)"}).`,
      });
    }
  }
  for (const fn of clientCallable(catalog.functions)) {
    if (!fn.securityDefiner) continue;
    const roles = [fn.executable.anon ? "anon" : "", fn.executable.authenticated ? "authenticated" : ""].filter(Boolean).join(" and ");
    warnings.push({
      rule: "security_definer_callable",
      object: `${fn.qualified}(${fn.signature})`,
      message: `${fn.qualified} runs with its owner's rights (SECURITY DEFINER) and ${roles} can call it, so row level security does not protect the data it touches.`,
    });
  }
  for (const bucket of catalog.buckets.filter((b) => b.public)) {
    const allowed = config.storage.allowPublic.includes(bucket.id);
    warnings.push({
      rule: "public_bucket",
      object: bucket.id,
      message: allowed
        ? `The bucket ${bucket.id} is public: anyone with a link can download its files. The config marks this as intended.`
        : `The bucket ${bucket.id} is public: anyone with a link can download any file in it, whichever customer it belongs to.`,
    });
  }
  return warnings;
}
