import type { Bucket, Catalog, Column, FunctionInfo, Policy, Privileges, Relation } from "../discover/catalog.ts";
import { clientCallable } from "../probe/rpc.ts";
import type { Severity } from "./scan.ts";

/** `info` changes are listed for completeness; they never need a review on their own. */
export type ChangeSeverity = Severity | "info";

export type CatalogChangeKind =
  | "relation_added"
  | "relation_removed"
  | "column_added"
  | "column_removed"
  | "column_type_changed"
  | "rls_enabled"
  | "rls_disabled"
  | "rls_forced"
  | "rls_no_longer_forced"
  | "policy_added"
  | "policy_removed"
  | "policy_changed"
  | "grant_added"
  | "grant_removed"
  | "view_security_invoker_added"
  | "view_security_invoker_removed"
  | "function_added"
  | "function_removed"
  | "function_security_definer_added"
  | "function_security_definer_removed"
  | "bucket_added"
  | "bucket_removed"
  | "bucket_made_public"
  | "bucket_made_private";

/** One security-relevant difference between the database before and after the migration. */
export interface CatalogChange {
  kind: CatalogChangeKind;
  severity: ChangeSeverity;
  /** The table, column, policy, function or bucket concerned. */
  object: string;
  message: string;
  before?: string;
  after?: string;
}

const KIND_NAME: Readonly<Record<Relation["kind"], string>> = {
  table: "table",
  partitioned_table: "table",
  view: "view",
  materialized_view: "materialized view",
  foreign_table: "foreign table",
};

function byKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

function clientsHaveAccess(relation: Relation): boolean {
  return (["anon", "authenticated"] as const).some((role) => grantList(relation.privileges[role]).length > 0);
}

function isTable(relation: Relation): boolean {
  return relation.kind === "table" || relation.kind === "partitioned_table";
}

/** A policy written out the way Postgres stores it, for before/after comparison. */
export function describePolicy(policy: Policy): string {
  const parts = [`${policy.permissive ? "permissive" : "restrictive"} ${policy.command} to ${policy.roles.join(", ")}`];
  if (policy.using !== undefined) parts.push(`using (${policy.using})`);
  if (policy.withCheck !== undefined) parts.push(`with check (${policy.withCheck})`);
  return parts.join(" ").replace(/\s+/g, " ");
}

function policyChanges(before: readonly Policy[], after: readonly Policy[], skipTables: ReadonlySet<string>): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const key = (p: Policy): string => `${p.schema}.${p.table}: ${p.name}`;
  const old = byKey(before, key);
  const now = byKey(after, key);
  for (const [name, policy] of now) {
    if (skipTables.has(`${policy.schema}.${policy.table}`)) continue;
    const previous = old.get(name);
    if (!previous) {
      changes.push({ kind: "policy_added", severity: "info", object: name, message: `New access rule "${policy.name}" on ${policy.schema}.${policy.table}.`, after: describePolicy(policy) });
    } else if (describePolicy(previous) !== describePolicy(policy)) {
      changes.push({
        kind: "policy_changed",
        severity: "attention",
        object: name,
        message: `The access rule "${policy.name}" on ${policy.schema}.${policy.table} was changed. Check that it still limits each tenant to its own rows.`,
        before: describePolicy(previous),
        after: describePolicy(policy),
      });
    }
  }
  for (const [name, policy] of old) {
    if (now.has(name) || skipTables.has(`${policy.schema}.${policy.table}`)) continue;
    changes.push({
      kind: "policy_removed",
      severity: "security",
      object: name,
      message: `The access rule "${policy.name}" on ${policy.schema}.${policy.table} was removed. Check that the table is still limited to each tenant's own rows.`,
      before: describePolicy(policy),
    });
  }
  return changes;
}

function columnChanges(before: Relation, after: Relation): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const old = byKey(before.columns, (c) => c.name);
  const now = byKey(after.columns, (c) => c.name);
  const type = (c: Column): string => c.type.display;
  for (const [name, column] of now) {
    const previous = old.get(name);
    if (!previous) {
      changes.push({ kind: "column_added", severity: "info", object: `${after.qualified}.${name}`, message: `New column ${name} (${type(column)}) on ${after.qualified}.`, after: type(column) });
    } else if (type(previous) !== type(column)) {
      changes.push({
        kind: "column_type_changed",
        severity: "destructive",
        object: `${after.qualified}.${name}`,
        message: `The type of ${after.qualified}.${name} changed from ${type(previous)} to ${type(column)}; existing values were converted.`,
        before: type(previous),
        after: type(column),
      });
    }
  }
  for (const [name, column] of old) {
    if (now.has(name)) continue;
    changes.push({ kind: "column_removed", severity: "destructive", object: `${before.qualified}.${name}`, message: `The column ${name} was removed from ${before.qualified}, with every value in it.`, before: type(column) });
  }
  return changes;
}

const OPERATIONS = ["select", "insert", "update", "delete"] as const;

function grantList(privileges: Privileges): string[] {
  return OPERATIONS.filter((op) => privileges[op]);
}

function grantChanges(before: Relation, after: Relation): CatalogChange[] {
  const changes: CatalogChange[] = [];
  for (const role of ["anon", "authenticated"] as const) {
    const old = new Set(grantList(before.privileges[role]));
    const now = new Set(grantList(after.privileges[role]));
    const added = [...now].filter((op) => !old.has(op));
    const removed = [...old].filter((op) => !now.has(op));
    const who = role === "anon" ? "Visitors who are not signed in (anon)" : "Signed-in users (authenticated)";
    if (added.length > 0) {
      changes.push({
        kind: "grant_added",
        severity: "attention",
        object: `${after.qualified} (${role})`,
        message: `${who} may now ${added.join(", ")} on ${after.qualified}. Only row level security stands between them and other tenants' rows.`,
        before: [...old].join(", ") || "none",
        after: [...now].join(", ") || "none",
      });
    }
    if (removed.length > 0) {
      changes.push({
        kind: "grant_removed",
        severity: "info",
        object: `${after.qualified} (${role})`,
        message: `${who} may no longer ${removed.join(", ")} on ${after.qualified}.`,
        before: [...old].join(", ") || "none",
        after: [...now].join(", ") || "none",
      });
    }
  }
  return changes;
}

function relationChanges(before: Relation, after: Relation): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const name = after.qualified;
  if (isTable(before) && isTable(after)) {
    if (before.rlsEnabled && !after.rlsEnabled) {
      changes.push({ kind: "rls_disabled", severity: "security", object: name, message: `Row level security was switched off on ${name}, so its policies no longer apply.`, before: "enabled", after: "disabled" });
    } else if (!before.rlsEnabled && after.rlsEnabled) {
      changes.push({ kind: "rls_enabled", severity: "info", object: name, message: `Row level security was switched on for ${name}.`, before: "disabled", after: "enabled" });
    }
    if (before.rlsForced && !after.rlsForced) {
      changes.push({ kind: "rls_no_longer_forced", severity: "security", object: name, message: `Row level security is no longer forced on ${name}, so the table owner skips its policies again.`, before: "forced", after: "not forced" });
    } else if (!before.rlsForced && after.rlsForced) {
      changes.push({ kind: "rls_forced", severity: "info", object: name, message: `Row level security is now forced on ${name}, even for the table owner.`, before: "not forced", after: "forced" });
    }
  }
  if (before.kind === "view" && after.kind === "view" && before.securityInvoker !== after.securityInvoker) {
    changes.push(
      after.securityInvoker
        ? { kind: "view_security_invoker_added", severity: "info", object: name, message: `The view ${name} now runs with the caller's rights, so table policies apply through it.`, before: "owner's rights", after: "caller's rights" }
        : { kind: "view_security_invoker_removed", severity: "security", object: name, message: `The view ${name} now runs with its owner's rights, which can skip the row level security of the tables behind it.`, before: "caller's rights", after: "owner's rights" },
    );
  }
  return [...changes, ...columnChanges(before, after), ...grantChanges(before, after)];
}

function relationsDiff(before: readonly Relation[], after: readonly Relation[]): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const old = byKey(before, (r) => r.qualified);
  const now = byKey(after, (r) => r.qualified);
  for (const [name, relation] of now) {
    const previous = old.get(name);
    if (previous && KIND_NAME[previous.kind] === KIND_NAME[relation.kind]) {
      changes.push(...relationChanges(previous, relation));
      continue;
    }
    if (previous) {
      changes.push({ kind: "relation_removed", severity: isTable(previous) ? "destructive" : "attention", object: name, message: `The ${KIND_NAME[previous.kind]} ${name} was replaced by a ${KIND_NAME[relation.kind]} of the same name.`, before: KIND_NAME[previous.kind], after: KIND_NAME[relation.kind] });
    }
    const unprotected = isTable(relation) && !relation.rlsEnabled && clientsHaveAccess(relation);
    const rls = isTable(relation) ? (relation.rlsEnabled ? ", with row level security on" : ", with row level security OFF") : "";
    changes.push({
      kind: "relation_added",
      severity: unprotected ? "security" : "info",
      object: name,
      message: unprotected
        ? `New table ${name} with row level security OFF, and clients may use it: every client reaches every row.`
        : `New ${KIND_NAME[relation.kind]} ${name}${rls}.`,
      after: KIND_NAME[relation.kind],
    });
  }
  for (const [name, relation] of old) {
    if (now.has(name)) continue;
    changes.push({
      kind: "relation_removed",
      severity: isTable(relation) ? "destructive" : "attention",
      object: name,
      message: isTable(relation)
        ? `The table ${name} was removed, with every row in it.`
        : `The ${KIND_NAME[relation.kind]} ${name} was removed; anything that reads it stops working.`,
      before: KIND_NAME[relation.kind],
    });
  }
  return changes;
}

function functionsDiff(before: readonly FunctionInfo[], after: readonly FunctionInfo[]): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const key = (fn: FunctionInfo): string => `${fn.qualified}(${fn.signature})`;
  const old = byKey(clientCallable(before), key);
  const now = byKey(clientCallable(after), key);
  for (const [name, fn] of now) {
    const previous = old.get(name);
    if (!previous) {
      changes.push({
        kind: "function_added",
        severity: fn.securityDefiner ? "attention" : "info",
        object: name,
        message: fn.securityDefiner
          ? `New client-callable function ${name} that runs with its owner's rights (SECURITY DEFINER), skipping row level security.`
          : `New client-callable function ${name}.`,
      });
    } else if (!previous.securityDefiner && fn.securityDefiner) {
      changes.push({ kind: "function_security_definer_added", severity: "attention", object: name, message: `${name} now runs with its owner's rights (SECURITY DEFINER), skipping row level security.`, before: "security invoker", after: "security definer" });
    } else if (previous.securityDefiner && !fn.securityDefiner) {
      changes.push({ kind: "function_security_definer_removed", severity: "info", object: name, message: `${name} now runs with the caller's rights, so table policies apply inside it.`, before: "security definer", after: "security invoker" });
    }
  }
  for (const name of old.keys()) {
    if (!now.has(name)) changes.push({ kind: "function_removed", severity: "info", object: name, message: `${name} can no longer be called by clients (removed, or execute rights taken away).` });
  }
  return changes;
}

function bucketsDiff(before: readonly Bucket[], after: readonly Bucket[]): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const old = byKey(before, (b) => b.id);
  const now = byKey(after, (b) => b.id);
  for (const [id, bucket] of now) {
    const previous = old.get(id);
    if (!previous) {
      changes.push({ kind: "bucket_added", severity: bucket.public ? "security" : "info", object: id, message: bucket.public ? `New PUBLIC storage bucket ${id}: anyone with a file's link can download it.` : `New private storage bucket ${id}.` });
    } else if (!previous.public && bucket.public) {
      changes.push({ kind: "bucket_made_public", severity: "security", object: id, message: `The storage bucket ${id} was made public: anyone with a file's link can download it, whichever tenant it belongs to.`, before: "private", after: "public" });
    } else if (previous.public && !bucket.public) {
      changes.push({ kind: "bucket_made_private", severity: "info", object: id, message: `The storage bucket ${id} was made private.`, before: "public", after: "private" });
    }
  }
  for (const id of old.keys()) {
    if (!now.has(id)) changes.push({ kind: "bucket_removed", severity: "destructive", object: id, message: `The storage bucket ${id} was removed.` });
  }
  return changes;
}

/** Compares the catalog before and after the migration (DESIGN.md section 9, step 4). */
export function diffCatalogs(before: Catalog, after: Catalog): CatalogChange[] {
  const afterNames = new Set(after.relations.map((r) => r.qualified));
  // The policies of a removed table are covered by the removal itself.
  const removed = new Set(before.relations.map((r) => r.qualified).filter((name) => !afterNames.has(name)));
  const tablePolicies = (catalog: Catalog): Policy[] => catalog.relations.flatMap((r) => r.policies);
  return [
    ...relationsDiff(before.relations, after.relations),
    ...policyChanges(tablePolicies(before), tablePolicies(after), removed),
    ...policyChanges(before.storagePolicies, after.storagePolicies, new Set()),
    ...functionsDiff(before.functions, after.functions),
    ...bucketsDiff(before.buckets, after.buckets),
  ];
}
