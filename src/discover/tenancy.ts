import type { ConfigValue, ToolConfig } from "../config/config.ts";
import { ToolError } from "../core/errors.ts";
import type { Catalog, Constraint, Relation } from "./catalog.ts";

/** Column names that usually hold the tenant's id (DESIGN.md section 6), in order of preference. */
export const TENANT_COLUMN_NAMES = [
  "tenant_id",
  "org_id",
  "organization_id",
  "organisation_id",
  "account_id",
  "team_id",
  "workspace_id",
  "company_id",
  "agency_id",
  "store_id",
  "shop_id",
  "client_id",
] as const;

/** Column names that usually hold the owning user's id when there is no foreign key to auth.users. */
export const USER_COLUMN_NAMES = ["user_id", "owner_id", "created_by", "author_id", "profile_id", "member_id"] as const;

export const MAX_INHERIT_HOPS = 4;

export type Ownership =
  | { kind: "tenant_root"; keyColumn: string }
  | { kind: "tenant"; tenantColumn: string; userColumns: string[]; source: "config" | "foreign_key" | "name" }
  | { kind: "user"; userColumn: string; source: "config" | "foreign_key" | "primary_key" | "name" }
  | { kind: "inherited"; columns: string[]; parent: string; parentColumns: string[]; path: string[]; source: "config" | "foreign_key" }
  | { kind: "shared"; source: "config" | "detected" }
  | { kind: "skipped"; reason: string };

export interface TableTenancy {
  table: string;
  ownership: Ownership;
  /** True for the one table that links users to tenants (for example org_members). */
  membership: boolean;
  /** Plain-English explanation for the report ("How we decided who owns each table"). */
  explanation: string;
}

export interface MembershipModel {
  table: string;
  userColumn: string;
  tenantColumn: string;
  values: Record<string, ConfigValue>;
}

export interface TenancyModel {
  tenantRoot?: { table: string; keyColumn: string };
  membership?: MembershipModel;
  tables: Map<string, TableTenancy>;
  notes: string[];
}

export function isBaseTable(relation: Relation): boolean {
  return relation.kind === "table" || relation.kind === "partitioned_table";
}

function foreignKeys(relation: Relation): (Constraint & { references: NonNullable<Constraint["references"]> })[] {
  return relation.constraints.filter(
    (c): c is Constraint & { references: NonNullable<Constraint["references"]> } => c.type === "foreign" && c.references !== undefined,
  );
}

function refName(c: { references: { schema: string; table: string } }): string {
  return `${c.references.schema}.${c.references.table}`;
}

function isAuthUsersKey(c: Constraint): boolean {
  return c.references?.schema === "auth" && c.references.table === "users" && c.columns.length === 1;
}

export function primaryKey(relation: Relation): string[] {
  return relation.constraints.find((c) => c.type === "primary")?.columns ?? [];
}

function hasColumn(relation: Relation, column: string): boolean {
  return relation.columns.some((c) => c.name === column);
}

function requireColumn(relation: Relation, column: string, setting: string): void {
  if (!hasColumn(relation, column)) {
    throw new ToolError(
      `The config sets ${setting} to "${column}", but ${relation.qualified} has no such column.`,
      `Columns of ${relation.qualified}: ${relation.columns.map((c) => c.name).join(", ")}.`,
    );
  }
}

/** Picks the tenant root: the table most tenant-named foreign keys point at (DESIGN.md section 6, rule 2). */
export function detectTenantRoot(tables: readonly Relation[]): string | undefined {
  const votes = new Map<string, number>();
  for (const relation of tables) {
    for (const fk of foreignKeys(relation)) {
      const column = fk.columns[0];
      if (fk.columns.length !== 1 || column === undefined) continue;
      if (!(TENANT_COLUMN_NAMES as readonly string[]).includes(column)) continue;
      if (fk.references.schema === "auth") continue;
      const target = refName(fk);
      if (target === relation.qualified) continue;
      votes.set(target, (votes.get(target) ?? 0) + 1);
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0];
}

interface Direct {
  ownership: Ownership;
  explanation: string;
}

function directOwnership(relation: Relation, root: string | undefined, config: ToolConfig): Direct | undefined {
  const override = config.tables[relation.qualified];
  if (override) {
    if (override.skip) return { ownership: { kind: "skipped", reason: override.skip }, explanation: `Excluded in the config: ${override.skip}` };
    if (override.shared) {
      return {
        ownership: { kind: "shared", source: "config" },
        explanation: "Marked as shared in the config: it belongs to no single customer.",
      };
    }
    if (override.tenantColumn) {
      requireColumn(relation, override.tenantColumn, `tables["${relation.qualified}"].tenantColumn`);
      const userColumns = override.userColumn ? [override.userColumn] : authUserColumns(relation);
      if (override.userColumn) requireColumn(relation, override.userColumn, `tables["${relation.qualified}"].userColumn`);
      return {
        ownership: { kind: "tenant", tenantColumn: override.tenantColumn, userColumns, source: "config" },
        explanation: `Belongs to a tenant through its ${override.tenantColumn} column (set in the config).`,
      };
    }
    if (override.userColumn) {
      requireColumn(relation, override.userColumn, `tables["${relation.qualified}"].userColumn`);
      return {
        ownership: { kind: "user", userColumn: override.userColumn, source: "config" },
        explanation: `Belongs to a user through its ${override.userColumn} column (set in the config).`,
      };
    }
    // ownedVia is resolved together with the inherited rules, because it needs the parent's ownership.
    return undefined;
  }
  if (relation.qualified === root) {
    const key = primaryKey(relation);
    return {
      ownership: { kind: "tenant_root", keyColumn: key[0] ?? "id" },
      explanation: "This is the tenant table itself: each row is one customer.",
    };
  }
  const fks = foreignKeys(relation);
  const rootFk = fks.find((fk) => fk.columns.length === 1 && root !== undefined && refName(fk) === root);
  const userColumns = authUserColumns(relation);
  if (rootFk?.columns[0]) {
    const column = rootFk.columns[0];
    return {
      ownership: { kind: "tenant", tenantColumn: column, userColumns, source: "foreign_key" },
      explanation: `Belongs to a tenant through its ${column} column (a link to ${root}).`,
    };
  }
  const fkColumns = new Set(fks.flatMap((fk) => fk.columns));
  // With no tenant table (tenantRoot: null) a column merely named tenant_id cannot hold a tenant's id.
  const named =
    config.tenantRoot === null ? undefined : TENANT_COLUMN_NAMES.find((name) => hasColumn(relation, name) && !fkColumns.has(name));
  if (named) {
    return {
      ownership: { kind: "tenant", tenantColumn: named, userColumns, source: "name" },
      explanation: `Belongs to a tenant through its ${named} column (detected by its name; it has no foreign key, so please confirm).`,
    };
  }
  const pk = primaryKey(relation);
  const authFks = fks.filter(isAuthUsersKey);
  const pkFk = authFks.find((fk) => pk.length === 1 && fk.columns[0] === pk[0]);
  if (pkFk?.columns[0]) {
    return {
      ownership: { kind: "user", userColumn: pkFk.columns[0], source: "primary_key" },
      explanation: `Belongs to a user: its primary key ${pkFk.columns[0]} is the user's id (a link to auth.users).`,
    };
  }
  if (authFks.length > 0) {
    const preferred =
      USER_COLUMN_NAMES.map((name) => authFks.find((fk) => fk.columns[0] === name)).find((fk) => fk !== undefined) ?? authFks[0];
    const column = preferred?.columns[0];
    if (column) {
      return {
        ownership: { kind: "user", userColumn: column, source: "foreign_key" },
        explanation: `Belongs to a user through its ${column} column (a link to auth.users).`,
      };
    }
  }
  const nameOnly = USER_COLUMN_NAMES.find((name) => {
    const column = relation.columns.find((c) => c.name === name);
    return column !== undefined && column.type.base === "uuid" && !fkColumns.has(name);
  });
  if (nameOnly) {
    return {
      ownership: { kind: "user", userColumn: nameOnly, source: "name" },
      explanation: `Belongs to a user through its ${nameOnly} column (detected by its name only; it has no foreign key, so please confirm).`,
    };
  }
  return undefined;
}

function authUserColumns(relation: Relation): string[] {
  return foreignKeys(relation)
    .filter(isAuthUsersKey)
    .map((fk) => fk.columns[0])
    .filter((column): column is string => column !== undefined);
}

function ownershipRank(ownership: Ownership): number {
  return ownership.kind === "tenant" || ownership.kind === "tenant_root" ? 0 : 1;
}

/** Builds the tenancy model for every base table in the exposed schemas (DESIGN.md section 6). */
export function buildTenancyModel(catalog: Catalog, config: ToolConfig): TenancyModel {
  const tables = catalog.relations.filter(isBaseTable);
  const byName = new Map(tables.map((relation) => [relation.qualified, relation]));
  const notes: string[] = [];

  for (const name of Object.keys(config.tables)) {
    if (!byName.has(name)) {
      throw new ToolError(
        `The config mentions the table ${name}, but no such table exists in the exposed schemas (${catalog.schemas.join(", ")}).`,
        "Check the table name in the config (schema.table).",
      );
    }
  }

  let root: string | undefined;
  if (config.tenantRoot === null) {
    notes.push("The config says there is no separate tenant table: each signed-in user is one customer.");
  } else if (config.tenantRoot !== undefined) {
    root = config.tenantRoot;
    if (!byName.has(root)) {
      throw new ToolError(`The config sets tenantRoot to ${root}, but no such table exists in the exposed schemas.`);
    }
  } else {
    root = detectTenantRoot(tables);
  }
  let tenantRoot: TenancyModel["tenantRoot"];
  if (root) {
    const relation = byName.get(root) as Relation;
    const key = primaryKey(relation);
    if (key.length === 1 && key[0]) {
      tenantRoot = { table: root, keyColumn: key[0] };
    } else {
      notes.push(`${root} looks like the tenant table but has no single-column primary key, so it was not used as one.`);
      root = undefined;
    }
  }

  const result = new Map<string, TableTenancy>();
  for (const relation of tables) {
    const direct = directOwnership(relation, root, config);
    if (direct) result.set(relation.qualified, { table: relation.qualified, ...direct, membership: false });
  }

  // Inherited ownership: the shortest foreign-key path to a table whose owner is known.
  for (const relation of tables) {
    if (result.has(relation.qualified)) continue;
    const via = config.tables[relation.qualified]?.ownedVia;
    if (via) {
      requireColumn(relation, via.column, `tables["${relation.qualified}"].ownedVia.column`);
      const parent = byName.get(via.references);
      if (!parent) {
        throw new ToolError(`The config says ${relation.qualified} is owned via ${via.references}, but that table does not exist.`);
      }
      const fk = foreignKeys(relation).find((c) => c.columns.length === 1 && c.columns[0] === via.column && refName(c) === via.references);
      const parentColumns = fk ? fk.references.columns : primaryKey(parent);
      result.set(relation.qualified, {
        table: relation.qualified,
        ownership: { kind: "inherited", columns: [via.column], parent: via.references, parentColumns, path: [relation.qualified, via.references], source: "config" },
        membership: false,
        explanation: `Belongs to whoever owns the linked row in ${via.references}, through ${via.column} (set in the config).`,
      });
    }
  }
  const resolved = (name: string): Ownership | undefined => result.get(name)?.ownership;
  for (const relation of tables) {
    if (result.has(relation.qualified)) continue;
    type Step = { table: string; path: string[]; firstHop?: { columns: string[]; parent: string; parentColumns: string[] } };
    const queue: Step[] = [{ table: relation.qualified, path: [relation.qualified] }];
    const seen = new Set([relation.qualified]);
    let best: { step: Step; ownership: Ownership } | undefined;
    while (queue.length > 0) {
      const step = queue.shift() as Step;
      if (best && step.path.length > best.step.path.length) break;
      const current = byName.get(step.table);
      if (!current) continue;
      for (const fk of foreignKeys(current)) {
        const target = refName(fk);
        if (fk.references.schema === "auth" || seen.has(target) || !byName.has(target)) continue;
        const firstHop = step.firstHop ?? { columns: fk.columns, parent: target, parentColumns: fk.references.columns };
        const next: Step = { table: target, path: [...step.path, target], firstHop };
        // Paths end at a directly owned table (or a config override), so the result never depends on table order.
        const owner = resolved(target);
        const terminal = owner && owner.kind !== "shared" && owner.kind !== "skipped" && (owner.kind !== "inherited" || owner.source === "config");
        if (owner && terminal) {
          if (!best || next.path.length < best.step.path.length || (next.path.length === best.step.path.length && ownershipRank(owner) < ownershipRank(best.ownership))) {
            best = { step: next, ownership: owner };
          }
          continue;
        }
        if (next.path.length <= MAX_INHERIT_HOPS) {
          seen.add(target);
          queue.push(next);
        }
      }
    }
    if (best?.step.firstHop) {
      const hop = best.step.firstHop;
      const chain = best.step.path.join(" → ");
      result.set(relation.qualified, {
        table: relation.qualified,
        ownership: { kind: "inherited", columns: hop.columns, parent: hop.parent, parentColumns: hop.parentColumns, path: best.step.path, source: "foreign_key" },
        membership: false,
        explanation: `Belongs to whoever owns the linked row, through ${hop.columns.join(", ")} (${chain}).`,
      });
    }
  }

  for (const relation of tables) {
    if (result.has(relation.qualified)) continue;
    result.set(relation.qualified, {
      table: relation.qualified,
      ownership: { kind: "shared", source: "detected" },
      membership: false,
      explanation: "Shared: no link to a tenant or a user was found, so it belongs to no single customer.",
    });
  }

  let membership: MembershipModel | undefined;
  if (config.membership) {
    const relation = byName.get(config.membership.table);
    if (!relation) throw new ToolError(`The config's membership table ${config.membership.table} does not exist.`);
    requireColumn(relation, config.membership.userColumn, "membership.userColumn");
    requireColumn(relation, config.membership.tenantColumn, "membership.tenantColumn");
    membership = { ...config.membership, values: config.membership.values ?? {} };
  } else if (tenantRoot) {
    const candidates = tables
      .map((relation) => ({ relation, tenancy: result.get(relation.qualified) }))
      .filter(({ tenancy }) => tenancy?.ownership.kind === "tenant" && tenancy.ownership.userColumns.length > 0)
      .sort(
        (a, b) =>
          Number(/member/i.test(b.relation.name)) - Number(/member/i.test(a.relation.name)) ||
          a.relation.columns.length - b.relation.columns.length ||
          a.relation.qualified.localeCompare(b.relation.qualified),
      );
    const chosen = candidates[0];
    if (chosen?.tenancy?.ownership.kind === "tenant") {
      membership = {
        table: chosen.relation.qualified,
        userColumn: chosen.tenancy.ownership.userColumns[0] as string,
        tenantColumn: chosen.tenancy.ownership.tenantColumn,
        values: {},
      };
    } else {
      notes.push(
        `No table links users to ${tenantRoot.table}, so the test users could not be made members of their tenants. ` +
          "If membership is stored elsewhere (for example in the user's JWT claims), set it in the config.",
      );
    }
  }
  if (membership) {
    const entry = result.get(membership.table);
    if (entry) {
      entry.membership = true;
      entry.explanation += " It is also the membership table: it says which user belongs to which tenant.";
    }
  }
  if (!tenantRoot && ![...result.values()].some((t) => t.ownership.kind === "tenant" || t.ownership.kind === "user")) {
    notes.push("No table could be linked to a tenant or a user, so there was no customer data to test isolation on.");
  }
  const model: TenancyModel = { tables: result, notes };
  if (tenantRoot) model.tenantRoot = tenantRoot;
  if (membership) model.membership = membership;
  return model;
}
