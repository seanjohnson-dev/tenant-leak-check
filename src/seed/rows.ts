import { randomUUID } from "node:crypto";
import { PLACEHOLDER_PATTERN, type ConfigValue, type ToolConfig } from "../config/config.ts";
import type { Catalog, Constraint, Relation } from "../discover/catalog.ts";
import { isBaseTable, primaryKey, type Ownership, type TenancyModel } from "../discover/tenancy.ts";
import { type Database, describePgError, ident, qualifiedIdent } from "../stack/db.ts";
import type { TestUser } from "./users.ts";
import { generateValue, hintsForColumn, randomTag, type TenantLabel } from "./values.ts";
import { foreignKeyOrder } from "./world.ts";

export const ROWS_PER_TENANT = 2;

export interface SeededRow {
  table: string;
  tenant: TenantLabel;
  /** 1 = read, update and RPC target; 2 = delete target (DESIGN.md section 7.1). */
  index: number;
  data: Record<string, unknown>;
  /** True if the row already existed (for example created by a sign-up trigger) and was reused. */
  adopted: boolean;
  /** True if the row could only be inserted with triggers switched off. */
  triggersOff: boolean;
}

export interface TableSeed {
  table: string;
  rows: SeededRow[];
  /** Plain-English reason why no usable test data exists, if seeding failed. */
  failure?: string;
  notes: string[];
}

export interface Tenant {
  label: "A" | "B";
  user: TestUser;
  /** The tenant's id as stored in tenant columns: the tenant-root row's key, or a synthetic value. */
  tenantId: unknown;
}

export interface SeedResult {
  tenants: { A: Tenant; B: Tenant };
  tables: Map<string, TableSeed>;
  /** Values that only appear in one tenant's data. Seeing one of B's in a response proves B's data leaked. */
  markers: { A: Set<string>; B: Set<string> };
  notes: string[];
}

export function rowsOf(seed: SeedResult, table: string, tenant: TenantLabel): SeededRow[] {
  return (seed.tables.get(table)?.rows ?? []).filter((row) => row.tenant === tenant).sort((a, b) => a.index - b.index);
}

function same(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

function fkOf(relation: Relation): (Constraint & { references: NonNullable<Constraint["references"]> })[] {
  return relation.constraints.filter(
    (c): c is Constraint & { references: NonNullable<Constraint["references"]> } => c.type === "foreign" && c.references !== undefined,
  );
}

/** Which tenant a row belongs to under the table's ownership rule, judged from its values. */
export function ownerOf(
  ownership: Ownership,
  data: Record<string, unknown>,
  seed: Pick<SeedResult, "tenants" | "tables">,
): TenantLabel | undefined {
  const { A, B } = seed.tenants;
  switch (ownership.kind) {
    case "tenant_root":
      return same(data[ownership.keyColumn], A.tenantId) ? "A" : same(data[ownership.keyColumn], B.tenantId) ? "B" : undefined;
    case "tenant": {
      const value = data[ownership.tenantColumn];
      return same(value, A.tenantId) ? "A" : same(value, B.tenantId) ? "B" : undefined;
    }
    case "user": {
      const value = data[ownership.userColumn];
      return same(value, A.user.id) ? "A" : same(value, B.user.id) ? "B" : undefined;
    }
    case "inherited": {
      const parentRows = seed.tables.get(ownership.parent)?.rows ?? [];
      const parent = parentRows.find((row) =>
        ownership.columns.every((column, i) => same(data[column], row.data[ownership.parentColumns[i] ?? ""])),
      );
      return parent && parent.tenant !== "S" ? parent.tenant : undefined;
    }
    case "shared":
      return "S";
    case "skipped":
      return undefined;
  }
}

/** Resolves a config placeholder such as `{tenantB.row:public.invoices}` to a value from the seeded data. */
export function resolvePlaceholder(value: ConfigValue, seed: Pick<SeedResult, "tenants" | "tables">, catalog: Catalog): unknown {
  if (typeof value !== "string") return value;
  const match = PLACEHOLDER_PATTERN.exec(value);
  if (!match) return value;
  const tenant = seed.tenants[match[1] as "A" | "B"];
  const what = match[2] as string;
  if (what === "tenant") return tenant.tenantId;
  if (what === "user") return tenant.user.id;
  const table = what.slice("row:".length);
  const relation = catalog.relations.find((r) => r.qualified === table);
  const row = (seed.tables.get(table)?.rows ?? []).find((r) => r.tenant === tenant.label);
  const pk = relation ? primaryKey(relation) : [];
  return row && pk[0] ? row.data[pk[0]] : undefined;
}

export interface BuildOptions {
  tenant: TenantLabel;
  index: number;
  /** "full" also fills optional columns (more markers); "minimal" fills only what the table requires. */
  mode: "full" | "minimal";
  /** User id for links to auth.users that are not the ownership key (the acting user in insert probes). */
  actingUserId?: string;
}

export type BuiltRow = { ok: true; values: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Builds the values for one synthetic row of `relation` that belongs to `tenant`:
 * ownership keys and foreign keys point at the same tenant's rows, other columns get
 * generated values that respect their type and CHECK rules (DESIGN.md section 7.1).
 */
export function buildRow(
  relation: Relation,
  tenancy: TenancyModel,
  seed: Pick<SeedResult, "tenants" | "tables">,
  config: ToolConfig,
  catalog: Catalog,
  options: BuildOptions,
): BuiltRow {
  const ownership = tenancy.tables.get(relation.qualified)?.ownership ?? { kind: "shared", source: "detected" };
  const tenant = options.tenant === "S" ? undefined : seed.tenants[options.tenant];
  const values: Record<string, unknown> = {};
  const decided = new Set<string>();
  const shortName = relation.name.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "t";

  const ownershipUser = ownership.kind === "user" ? ownership.userColumn : undefined;
  const userFor = (column: string): string | undefined => {
    if (!tenant) return options.actingUserId ?? seed.tenants.A.user.id;
    if (column === ownershipUser) return tenant.user.id;
    return options.actingUserId ?? tenant.user.id;
  };

  for (const fk of fkOf(relation)) {
    const refTable = `${fk.references.schema}.${fk.references.table}`;
    const nullable = fk.columns.every((column) => !relation.columns.find((c) => c.name === column)?.notNull);
    if (refTable === "auth.users") {
      const column = fk.columns[0];
      if (column && fk.columns.length === 1) {
        values[column] = userFor(column);
        decided.add(column);
      }
      continue;
    }
    if (refTable === relation.qualified) {
      if (!nullable) return { ok: false, reason: `it links to itself through ${fk.columns.join(", ")}, which cannot be left empty` };
      fk.columns.forEach((column) => {
        values[column] = null;
        decided.add(column);
      });
      continue;
    }
    const parentRows = seed.tables.get(refTable)?.rows ?? [];
    const parent =
      parentRows.find((row) => row.tenant === options.tenant && row.index === 1) ??
      parentRows.find((row) => row.tenant === options.tenant) ??
      parentRows.find((row) => row.tenant === "S") ??
      (options.tenant === "S" ? parentRows.find((row) => row.tenant === "A") : undefined);
    if (!parent) {
      if (!nullable) return { ok: false, reason: `it needs a row in ${refTable}, which has no test data` };
      fk.columns.forEach((column) => {
        values[column] = null;
        decided.add(column);
      });
      continue;
    }
    fk.columns.forEach((column, i) => {
      values[column] = parent.data[fk.references.columns[i] ?? ""];
      decided.add(column);
    });
  }

  if (tenant && ownership.kind === "tenant" && !decided.has(ownership.tenantColumn)) {
    values[ownership.tenantColumn] = tenant.tenantId;
    decided.add(ownership.tenantColumn);
  }
  if (ownership.kind === "user" && !decided.has(ownership.userColumn)) {
    values[ownership.userColumn] = tenant ? tenant.user.id : seed.tenants.A.user.id;
    decided.add(ownership.userColumn);
  }
  if (ownership.kind === "tenant") {
    for (const column of ownership.userColumns) {
      if (!decided.has(column)) {
        values[column] = userFor(column);
        decided.add(column);
      }
    }
  }
  if (tenancy.membership?.table === relation.qualified) {
    for (const [column, value] of Object.entries(tenancy.membership.values)) {
      values[column] = resolvePlaceholder(value, seed, catalog);
      decided.add(column);
    }
  }
  // Values from the config are an explicit instruction, so they win over everything detected above.
  for (const [key, value] of Object.entries(config.seed.values)) {
    const prefix = `${relation.qualified}.`;
    if (key.startsWith(prefix)) {
      const column = key.slice(prefix.length);
      values[column] = resolvePlaceholder(value, seed, catalog);
      decided.add(column);
    }
  }

  const checks = relation.constraints.filter((c) => c.type === "check");
  const pk = primaryKey(relation);
  for (const column of relation.columns) {
    if (decided.has(column.name) || column.generated || column.identity === "a") continue;
    if (column.identity === "d") continue;
    const required = column.notNull && column.default === undefined;
    const isUuidKey = pk.length === 1 && pk[0] === column.name && column.type.base === "uuid";
    if (column.default !== undefined && !isUuidKey) continue;
    if (!required && options.mode === "minimal" && !isUuidKey) continue;
    const generated = generateValue({
      column,
      hints: hintsForColumn(column, checks),
      tenant: options.tenant,
      table: shortName,
      index: options.index,
    });
    if (generated.ok) values[column.name] = generated.value;
    else if (required) return { ok: false, reason: generated.reason };
  }
  return { ok: true, values };
}

/** Postgres settings that make auth.uid() and auth.jwt() return the given user inside a transaction. */
export async function actAs(db: Database, userId: string | undefined): Promise<void> {
  if (!userId) return;
  const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
  await db.query(
    "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)",
    [claims, userId],
  );
}

type InsertOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; code: string | undefined };

export async function insertRow(
  db: Database,
  relation: Relation,
  values: Record<string, unknown>,
  userId: string | undefined,
  triggersOff: boolean,
): Promise<InsertOutcome> {
  const columns = Object.keys(values);
  const target = qualifiedIdent(relation.schema, relation.name);
  const sql =
    columns.length === 0
      ? `insert into ${target} default values returning to_jsonb(${target}.*)::text as json`
      : `insert into ${target} (${columns.map(ident).join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning to_jsonb(${target}.*)::text as json`;
  try {
    const rows = await db.transaction(async () => {
      await actAs(db, userId);
      if (triggersOff) await db.query("set local session_replication_role = replica");
      return db.query<{ json: string }>(sql, columns.map((column) => toParam(values[column])));
    });
    return { ok: true, data: JSON.parse(rows[0]?.json ?? "{}") as Record<string, unknown> };
  } catch (error) {
    const { code, message } = describePgError(error);
    return { ok: false, error: message, code };
  }
}

function toParam(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Tries the gentlest insert first and falls back step by step: all columns, then only the
 * required ones, each first with triggers on and then with triggers off (DESIGN.md 7.1).
 */
async function seedOneRow(
  db: Database,
  relation: Relation,
  context: { tenancy: TenancyModel; seed: SeedResult; config: ToolConfig; catalog: Catalog },
  tenant: TenantLabel,
  index: number,
): Promise<{ row?: SeededRow; error?: string }> {
  let firstError: string | undefined;
  for (const mode of ["full", "minimal"] as const) {
    const built = buildRow(relation, context.tenancy, context.seed, context.config, context.catalog, { tenant, index, mode });
    if (!built.ok) {
      firstError ??= built.reason;
      continue;
    }
    const userId = tenant === "S" ? undefined : context.seed.tenants[tenant].user.id;
    for (const triggersOff of [false, true]) {
      const outcome = await insertRow(db, relation, built.values, userId, triggersOff);
      if (outcome.ok) {
        return { row: { table: relation.qualified, tenant, index, data: outcome.data, adopted: false, triggersOff } };
      }
      firstError ??= outcome.error;
    }
  }
  return { error: firstError ?? "the insert failed" };
}

async function existingRows(db: Database, relation: Relation): Promise<Record<string, unknown>[]> {
  const rows = await db.query<{ json: string }>(
    `select to_jsonb(t.*)::text as json from ${qualifiedIdent(relation.schema, relation.name)} t limit 5000`,
  );
  return rows.map((row) => JSON.parse(row.json) as Record<string, unknown>);
}

/**
 * A tenant id for apps whose tenant columns have no tenant table to point at. It takes the
 * type of the first tenant column found. With a tenant table, the seeded row's key replaces it.
 */
function syntheticTenantId(byName: ReadonlyMap<string, Relation>, tenancy: TenancyModel, label: "A" | "B"): unknown {
  for (const entry of tenancy.tables.values()) {
    const ownership = entry.ownership;
    if (ownership.kind !== "tenant") continue;
    const column = byName.get(entry.table)?.columns.find((c) => c.name === ownership.tenantColumn);
    if (!column) continue;
    if (column.type.base === "uuid") return randomUUID();
    if (column.type.category === "N") return label === "A" ? 910_001 : 910_002;
    return `tlc-tenant-${label.toLowerCase()}-${randomTag()}`;
  }
  return randomUUID();
}

/** Creates the synthetic world: tenant rows, memberships and two rows per tenant in every tenant table. */
export async function seedRows(
  db: Database,
  catalog: Catalog,
  tenancy: TenancyModel,
  config: ToolConfig,
  users: { A: TestUser; B: TestUser },
): Promise<SeedResult> {
  const tables = catalog.relations.filter(isBaseTable);
  const byName = new Map(tables.map((relation) => [relation.qualified, relation]));
  const seed: SeedResult = {
    tenants: {
      A: { label: "A", user: users.A, tenantId: syntheticTenantId(byName, tenancy, "A") },
      B: { label: "B", user: users.B, tenantId: syntheticTenantId(byName, tenancy, "B") },
    },
    tables: new Map(),
    markers: { A: new Set(), B: new Set() },
    notes: [],
  };
  const context = { tenancy, seed, config, catalog };

  for (const relation of foreignKeyOrder(tables)) {
    const entry = tenancy.tables.get(relation.qualified);
    if (!entry || entry.ownership.kind === "skipped") continue;
    const tableSeed: TableSeed = { table: relation.qualified, rows: [], notes: [] };
    seed.tables.set(relation.qualified, tableSeed);
    const ownership = entry.ownership;
    const labels: TenantLabel[] = ownership.kind === "shared" ? ["S"] : ["A", "B"];
    // One row where a second cannot exist: the tenant itself, memberships, and tables keyed by the user's id.
    const keyedByUser = ownership.kind === "user" && primaryKey(relation).join() === ownership.userColumn;
    const perTenant =
      ownership.kind === "shared" || ownership.kind === "tenant_root" || entry.membership || keyedByUser ? 1 : ROWS_PER_TENANT;
    const existing = ownership.kind === "shared" ? [] : await existingRows(db, relation);
    for (const label of labels) {
      const adopted = existing.filter((data) => ownerOf(ownership, data, seed) === label).slice(0, perTenant);
      adopted.forEach((data, i) => tableSeed.rows.push({ table: relation.qualified, tenant: label, index: i + 1, data, adopted: true, triggersOff: false }));
      if (adopted.length > 0) {
        tableSeed.notes.push(`Reused ${adopted.length} row(s) for tenant ${label} that the app's own triggers had already created.`);
      }
      for (let index = adopted.length + 1; index <= perTenant; index++) {
        const result = await seedOneRow(db, relation, context, label, index);
        if (result.row) {
          tableSeed.rows.push(result.row);
          if (ownership.kind === "tenant_root" && label !== "S") seed.tenants[label].tenantId = result.row.data[ownership.keyColumn];
          if (result.row.triggersOff) tableSeed.notes.push(`Row ${index} for tenant ${label} was seeded with triggers switched off.`);
        } else if (index === 1 || label === "S") {
          tableSeed.failure = `could not create test data because: ${result.error ?? "the insert failed"}`;
        } else {
          tableSeed.notes.push(`Only one row could be created for tenant ${label} (${result.error ?? "the insert failed"}); delete probes use row 1 and restore it.`);
        }
        if (tableSeed.failure) break;
      }
      if (tableSeed.failure) break;
    }
    if (ownership.kind === "shared" && tableSeed.failure) {
      const fallback = (await existingRows(db, relation))[0];
      if (fallback) {
        tableSeed.rows = [{ table: relation.qualified, tenant: "S", index: 1, data: fallback, adopted: true, triggersOff: false }];
        tableSeed.notes.push(`A new shared row could not be created (${tableSeed.failure}); an existing row is used as the target instead.`);
        delete tableSeed.failure;
      }
    }
    if (tableSeed.failure) tableSeed.rows = [];
  }

  for (const relation of catalog.relations.filter((r) => r.kind === "materialized_view")) {
    try {
      await db.query(`refresh materialized view ${qualifiedIdent(relation.schema, relation.name)}`);
      seed.notes.push(`Refreshed the materialized view ${relation.qualified} so it contains the test data.`);
    } catch (error) {
      seed.notes.push(`Could not refresh the materialized view ${relation.qualified}: ${describePgError(error).message}`);
    }
  }

  seed.markers = collectMarkers(seed);
  return seed;
}

function markerCandidates(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= 8) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => markerCandidates(item, out));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => markerCandidates(item, out));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for values distinctive enough to prove where data came from: synthetic markers and ids. */
export function isDistinctive(value: string): boolean {
  return UUID.test(value) || /tlc/i.test(value);
}

/**
 * Values that appear only in one tenant's rows (or are that tenant's ids). Anything that
 * also appears in the other tenant's rows or in shared rows is dropped, so a shared
 * reference never counts as a leak.
 */
export function collectMarkers(seed: Pick<SeedResult, "tenants" | "tables">): { A: Set<string>; B: Set<string> } {
  const own = { A: new Set<string>(), B: new Set<string>(), S: new Set<string>() };
  for (const table of seed.tables.values()) {
    for (const row of table.rows) markerCandidates(row.data, own[row.tenant]);
  }
  for (const label of ["A", "B"] as const) {
    const tenant = seed.tenants[label];
    own[label].add(tenant.user.id);
    if (typeof tenant.tenantId === "string") own[label].add(tenant.tenantId);
  }
  const keep = (label: "A" | "B"): Set<string> => {
    const other = label === "A" ? own.B : own.A;
    return new Set([...own[label]].filter((value) => isDistinctive(value) && !other.has(value) && !own.S.has(value)));
  };
  return { A: keep("A"), B: keep("B") };
}
