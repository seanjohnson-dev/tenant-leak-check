import type { CheckResult } from "../core/results.ts";
import type { Catalog, FunctionInfo, Relation } from "../discover/catalog.ts";
import type { MembershipModel, Ownership, TenancyModel } from "../discover/tenancy.ts";
import { ident } from "../stack/db.ts";

export const SQL_LABEL = "-- Starting point: review before applying.";

/** A leak with a plain-English explanation and fix (DESIGN.md section 8). */
export interface Finding {
  checkId: string;
  title: string;
  /** What is wrong, in plain words. */
  problem: string;
  /** What to change, in plain words. */
  fix: string;
  /** Optional SQL starting point, always labelled "review before applying". */
  sql?: string;
}

function qualified(name: string): string {
  const [schema, table] = name.split(".");
  return `${ident(schema ?? "public")}.${ident(table ?? name)}`;
}

function memberSubquery(membership: MembershipModel): string {
  return `select ${ident(membership.tenantColumn)} from ${qualified(membership.table)} where ${ident(membership.userColumn)} = (select auth.uid())`;
}

/** The condition that limits rows to the signed-in user's own tenant, built from the detected tenancy model. */
export function ownerCondition(ownership: Ownership, tenancy: TenancyModel): string | undefined {
  switch (ownership.kind) {
    case "tenant":
      return tenancy.membership ? `${ident(ownership.tenantColumn)} in (${memberSubquery(tenancy.membership)})` : undefined;
    case "tenant_root":
      return tenancy.membership ? `${ident(ownership.keyColumn)} in (${memberSubquery(tenancy.membership)})` : undefined;
    case "user":
      return `${ident(ownership.userColumn)} = (select auth.uid())`;
    case "inherited": {
      const columns = ownership.columns.map(ident).join(", ");
      const parentColumns = ownership.parentColumns.map(ident).join(", ");
      const list = ownership.columns.length > 1 ? `(${columns})` : columns;
      return `${list} in (select ${parentColumns} from ${qualified(ownership.parent)})`;
    }
    default:
      return undefined;
  }
}

const COMMAND_OF: Readonly<Record<string, "select" | "insert" | "update" | "delete">> = {
  select: "select",
  insert: "insert",
  update: "update",
  update_reassign: "update",
  delete: "delete",
};

function dropPolicies(relation: Relation, command: string): string[] {
  return relation.policies
    .filter((p) => p.command === command || p.command === "all")
    .map((p) => `drop policy ${ident(p.name)} on ${qualified(relation.qualified)};`);
}

/** A tenant-scoped policy for one command, for the authenticated role only. */
function createPolicy(target: string, command: "select" | "insert" | "update" | "delete", condition: string): string[] {
  const head = [`create policy "Tenant members can ${command} their own rows" on ${target}`, `  for ${command} to authenticated`];
  if (command === "insert") return [...head, `  with check (${condition});`];
  if (command === "update") return [...head, `  using (${condition})`, `  with check (${condition});`];
  return [...head, `  using (${condition});`];
}

function tableTitle(check: CheckResult, relation: Relation, ownership: Ownership): string {
  const name = relation.qualified;
  if (ownership.kind === "shared") {
    const verbs: Record<string, string> = { insert: "add rows to", update: "change rows in", delete: "delete rows in" };
    const who = check.actor === "anon" ? "Visitors who are not signed in" : "Any signed-in user";
    return `${who} can ${verbs[check.operation] ?? "change"} the shared table ${name}`;
  }
  if (check.actor === "anon") {
    const verbs: Record<string, string> = { select: "read", insert: "add", update: "change", delete: "delete" };
    return `Visitors who are not signed in can ${verbs[check.operation] ?? "reach"} customers' rows in ${name}`;
  }
  const verbs: Record<string, string> = {
    select: `A signed-in user can read another tenant's rows in ${name}`,
    insert: `A signed-in user can add rows to another tenant's data in ${name}`,
    update: `A signed-in user can change another tenant's rows in ${name}`,
    update_reassign: `A signed-in user can move their own rows in ${name} into another tenant`,
    delete: `A signed-in user can delete another tenant's rows in ${name}`,
  };
  return verbs[check.operation] ?? `A signed-in user can reach another tenant's rows in ${name}`;
}

function tableFinding(check: CheckResult, relation: Relation, tenancy: TenancyModel): Finding {
  const entry = tenancy.tables.get(relation.qualified);
  const ownership: Ownership = entry?.ownership ?? { kind: "shared", source: "detected" };
  const command = COMMAND_OF[check.operation] ?? "select";
  const target = qualified(relation.qualified);
  const title = tableTitle(check, relation, ownership);
  const condition = ownerCondition(ownership, tenancy);
  if (!relation.rlsEnabled) {
    const sql = [SQL_LABEL, `alter table ${target} enable row level security;`];
    if (condition && ownership.kind !== "shared") sql.push(...createPolicy(target, command, condition));
    if (check.actor === "anon") sql.push(`revoke all on ${target} from anon;`);
    return {
      checkId: check.id,
      title,
      problem:
        relation.policies.length > 0
          ? `Row level security is not enabled on ${relation.qualified}, so its policies are ignored and every client can reach every row.`
          : `Row level security is switched off on ${relation.qualified}, so every client can reach every row.`,
      fix: "Enable row level security on the table, then add one policy per operation that only matches the signed-in user's own rows.",
      sql: sql.join("\n"),
    };
  }
  if (ownership.kind === "shared") {
    return {
      checkId: check.id,
      title,
      problem: `${relation.qualified} holds data that every tenant relies on, and clients are allowed to ${command} it.`,
      fix: "Only trusted server code (the service role) should change shared reference data. Remove the client write policies and revoke write access.",
      sql: [SQL_LABEL, ...dropPolicies(relation, command), `revoke insert, update, delete on ${target} from anon, authenticated;`].join("\n"),
    };
  }
  const sql = [SQL_LABEL, ...dropPolicies(relation, command)];
  if (check.actor === "anon") sql.push(`revoke all on ${target} from anon;`);
  if (condition) sql.push(...createPolicy(target, command, condition));
  const problems: Record<string, string> = {
    select: `A read policy on ${relation.qualified} matches rows of other tenants.`,
    insert: `The insert policy on ${relation.qualified} does not check that a new row belongs to the user's own tenant.`,
    update: `The update policy on ${relation.qualified} matches rows of other tenants.`,
    update_reassign: `The update policy on ${relation.qualified} checks the row before the change but not after it, so a user can hand a row to another tenant.`,
    delete: `The delete policy on ${relation.qualified} matches rows of other tenants.`,
  };
  const fixes: Record<string, string> = {
    select: "Limit the read policy to rows of the signed-in user's own tenant.",
    insert: "Add a WITH CHECK rule that only accepts rows for the signed-in user's own tenant.",
    update: "Limit the update policy (USING and WITH CHECK) to rows of the signed-in user's own tenant.",
    update_reassign: "Give the update policy a WITH CHECK rule that pins the row to the signed-in user's own tenant.",
    delete: "Limit the delete policy to rows of the signed-in user's own tenant.",
  };
  const anonNote = check.actor === "anon" ? " Visitors who are not signed in should not reach tenant data at all: apply policies to the authenticated role only." : "";
  const finding: Finding = {
    checkId: check.id,
    title,
    problem: problems[check.operation] ?? `Access to ${relation.qualified} is not limited to the user's own tenant.`,
    fix: `${fixes[check.operation] ?? "Limit the policy to the user's own tenant."}${anonNote}`,
  };
  if (condition || check.actor === "anon") finding.sql = sql.join("\n");
  return finding;
}

function viewFinding(check: CheckResult, relation: Relation): Finding {
  const target = qualified(relation.qualified);
  if (relation.kind === "materialized_view") {
    return {
      checkId: check.id,
      title: `${check.actor === "anon" ? "Visitors who are not signed in" : "A signed-in user"} can read the materialized view ${relation.qualified}`,
      problem: "Materialized views cannot have row level security, so every client that may read it sees every tenant's rows.",
      fix: "Remove client access to the materialized view, and serve the data through a function or view that checks the tenant.",
      sql: [SQL_LABEL, `revoke select on ${target} from anon, authenticated;`].join("\n"),
    };
  }
  return {
    checkId: check.id,
    title: `${check.actor === "anon" ? "Visitors who are not signed in" : "A signed-in user"} can ${check.operation === "select" ? "read" : "change"} data through the view ${relation.qualified}`,
    problem: relation.securityInvoker
      ? `The view ${relation.qualified} exposes rows of other tenants; the policies of the tables behind it let them through.`
      : `The view ${relation.qualified} runs with its owner's rights, which skip row level security on the tables behind it.`,
    fix: "Make the view use the caller's rights, so the policies of the tables behind it apply.",
    sql: [SQL_LABEL, `alter view ${target} set (security_invoker = true);`, ...(check.actor === "anon" ? [`revoke all on ${target} from anon;`] : [])].join("\n"),
  };
}

function storageFinding(check: CheckResult, catalog: Catalog, tenancy: TenancyModel): Finding {
  const bucket = catalog.buckets.find((b) => b.id === check.target);
  const literal = `'${check.target.replaceAll("'", "''")}'`;
  const folderRule = tenancy.membership
    ? `(storage.foldername(name))[1] in (select ${ident(tenancy.membership.tenantColumn)}::text from ${qualified(tenancy.membership.table)} where ${ident(tenancy.membership.userColumn)} = (select auth.uid()))`
    : "(storage.foldername(name))[1] = (select auth.uid())::text";
  const who = check.actor === "anon" ? "Visitors who are not signed in" : "A signed-in user";
  const verbs: Record<string, string> = {
    list: "list other tenants' files",
    download: "download other tenants' files",
    upload: "upload files into other tenants' folders",
    overwrite: "replace other tenants' files",
    delete: "delete other tenants' files",
  };
  const title = `${who} can ${verbs[check.operation] ?? "reach other tenants' files"} in the bucket ${check.target}`;
  if (check.operation === "download" && bucket?.public) {
    return {
      checkId: check.id,
      title,
      problem: `The bucket ${check.target} is public, so anyone who has or guesses a file's link can download it, whichever tenant it belongs to.`,
      fix: "Make the bucket private and hand out signed URLs, or move genuinely public files (such as product images) to a separate public bucket and list it under storage.allowPublic in the config.",
      sql: [SQL_LABEL, `update storage.buckets set public = false where id = ${literal};`].join("\n"),
    };
  }
  const command = { list: "select", download: "select", upload: "insert", overwrite: "update", delete: "delete" }[check.operation] ?? "select";
  const name = `Tenant members can ${command} their own files in ${check.target}`;
  const clause =
    command === "insert"
      ? `  with check (bucket_id = ${literal} and ${folderRule});`
      : command === "update"
        ? `  using (bucket_id = ${literal} and ${folderRule})\n  with check (bucket_id = ${literal} and ${folderRule});`
        : `  using (bucket_id = ${literal} and ${folderRule});`;
  const drops = catalog.storagePolicies
    .filter((p) => p.table === "objects" && (p.command === command || p.command === "all") && `${p.using ?? ""} ${p.withCheck ?? ""}`.includes(literal))
    .map((p) => `drop policy ${ident(p.name)} on storage.objects;`);
  return {
    checkId: check.id,
    title,
    problem: `A storage policy for ${check.target} only checks the bucket, not the folder that says which tenant a file belongs to.`,
    fix: "Limit the storage policy to the signed-in user's own folder (the first part of the file path).",
    sql: [SQL_LABEL, ...drops, `create policy "${name}" on storage.objects`, `  for ${command} to authenticated`, clause].join("\n"),
  };
}

function rpcFinding(check: CheckResult, fn: FunctionInfo | undefined): Finding {
  const name = fn ? `${qualified(fn.qualified)}(${fn.signature})` : check.target;
  const who = check.actor === "anon" ? "Visitors who are not signed in" : "A signed-in user";
  const sql = [SQL_LABEL];
  if (fn?.securityDefiner) sql.push(`alter function ${name} security invoker;`);
  if (check.actor === "anon" && fn) sql.push(`revoke execute on function ${name} from anon, public;`);
  const finding: Finding = {
    checkId: check.id,
    title: `${who} can reach other tenants' data through the function ${check.target}`,
    problem: fn?.securityDefiner
      ? `${check.target} runs with its owner's rights (SECURITY DEFINER), so row level security does not apply inside it, and it does not check that the caller belongs to the tenant whose data it touches.`
      : `${check.target} returns or changes other tenants' data for this caller.`,
    fix: fn?.securityDefiner
      ? "Make the function run with the caller's rights (SECURITY INVOKER) so the table policies apply, or check inside the function that auth.uid() is a member of the tenant it works on."
      : "Check inside the function that the caller belongs to the tenant whose data it reads or changes.",
  };
  if (sql.length > 1) finding.sql = sql.join("\n");
  return finding;
}

/** Turns every leak into a finding with a plain-English problem, fix and optional SQL. */
export function findingsFor(checks: readonly CheckResult[], catalog: Catalog, tenancy: TenancyModel): Finding[] {
  return checks
    .filter((check) => check.status === "leak")
    .map((check) => {
      if (check.kind === "storage") return storageFinding(check, catalog, tenancy);
      if (check.kind === "rpc") return rpcFinding(check, catalog.functions.find((fn) => fn.qualified === check.target));
      const relation = catalog.relations.find((r) => r.qualified === check.target);
      if (!relation) return { checkId: check.id, title: `Leak in ${check.target}`, problem: "Another tenant's data was reachable.", fix: "Review the access rules for this object." };
      return check.kind === "view" ? viewFinding(check, relation) : tableFinding(check, relation, tenancy);
    });
}
