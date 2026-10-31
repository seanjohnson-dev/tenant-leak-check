import {
  type Actor,
  type CheckResult,
  type CheckSpec,
  type Evidence,
  type HttpEvidence,
  inconclusive,
  leaked,
  notTested,
  passed,
} from "../core/results.ts";
import type { Column, Relation } from "../discover/catalog.ts";
import { isBaseTable, primaryKey, type Ownership, type TableTenancy } from "../discover/tenancy.ts";
import { buildRow, ownerOf, rowsOf, type SeededRow } from "../seed/rows.ts";
import { generateValue, hintsForColumn } from "../seed/values.ts";
import { rowKey, type RowState } from "../seed/world.ts";
import {
  ACTORS,
  actorName,
  callerFor,
  classifyResponse,
  findMarkers,
  firstLeakedItem,
  foreignMarkers,
  type ProbeContext,
  restTarget,
} from "./common.ts";
import { evidenceOf, excerpt, type RequestOptions } from "./http.ts";

export const WRITE_OPERATIONS = ["insert", "update", "update_reassign", "delete"] as const;
export const TABLE_OPERATIONS = ["select", ...WRITE_OPERATIONS] as const;
export type TableOperation = (typeof TABLE_OPERATIONS)[number];

/** Rows asked for by the unfiltered read. The synthetic world is far smaller than this. */
export const UNFILTERED_LIMIT = 1000;

/** Whether tenant A could read its own row in a table: the positive control of DESIGN.md section 7.2. */
export interface PositiveControl {
  table: string;
  ownRowVisible: boolean;
}

export interface RelationProbeResult {
  checks: CheckResult[];
  control?: PositiveControl;
}

/** Where requests go (`api`), where rows are checked (`base`), and which columns the API relation shows. */
interface Route {
  api: Relation;
  base: Relation;
  tenancy: TableTenancy;
  columns: Set<string>;
}

function operationsFor(actor: Actor): TableOperation[] {
  return actor === "tenant_a" ? [...TABLE_OPERATIONS] : TABLE_OPERATIONS.filter((op) => op !== "update_reassign");
}

function specOf(relation: Relation, operation: string, actor: Actor): CheckSpec {
  return { kind: isBaseTable(relation) ? "table" : "view", target: relation.qualified, operation, actor };
}

function formatFilterValue(value: unknown): string {
  if (value === null || value === undefined) return "is.null";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `eq.${encodeURIComponent(text)}`;
}

/** A PostgREST filter that matches exactly one row: by primary key, a unique key, or a unique marker value. */
export function rowFilter(relation: Relation, data: Record<string, unknown>, visible: ReadonlySet<string>): string | undefined {
  const pk = primaryKey(relation);
  const candidates: string[][] = [pk, ...relation.constraints.filter((c) => c.type === "unique").map((c) => c.columns)];
  for (const columns of candidates) {
    if (columns.length === 0 || !columns.every((column) => visible.has(column))) continue;
    if (columns.some((column) => data[column] === null || data[column] === undefined)) continue;
    return columns.map((column) => `${encodeURIComponent(column)}=${formatFilterValue(data[column])}`).join("&");
  }
  const marker = Object.entries(data).find(
    ([column, value]) => visible.has(column) && typeof value === "string" && value.length >= 12 && value.startsWith("tlc-"),
  );
  return marker ? `${encodeURIComponent(marker[0])}=${formatFilterValue(marker[1])}` : undefined;
}

async function currentRow(ctx: ProbeContext, base: Relation, data: Record<string, unknown>): Promise<RowState | undefined> {
  const state = await ctx.world.readTable(base);
  return state.get(rowKey(base, data));
}

function describeRow(relation: Relation, data: Record<string, unknown>): string {
  const pk = primaryKey(relation);
  const key = pk.length > 0 ? pk.map((c) => `${c}=${String(data[c])}`).join(", ") : excerpt(JSON.stringify(data), 160);
  return `${relation.qualified} row (${key})`;
}

function ownershipValues(ctx: ProbeContext, ownership: Ownership, tenant: "A" | "B"): Record<string, unknown> | undefined {
  const t = ctx.seed.tenants[tenant];
  switch (ownership.kind) {
    case "tenant":
      return { [ownership.tenantColumn]: t.tenantId };
    case "user":
      return { [ownership.userColumn]: t.user.id };
    case "inherited": {
      const parent = rowsOf(ctx.seed, ownership.parent, tenant)[0];
      if (!parent) return undefined;
      return Object.fromEntries(ownership.columns.map((column, i) => [column, parent.data[ownership.parentColumns[i] ?? ""]]));
    }
    default:
      return undefined;
  }
}

function isKeyColumn(route: Route, column: Column): boolean {
  const pk = primaryKey(route.base);
  const fkColumns = route.base.constraints.filter((c) => c.type === "foreign").flatMap((c) => c.columns);
  const ownership = route.tenancy.ownership;
  const owner = ownership.kind === "tenant" ? [ownership.tenantColumn, ...ownership.userColumns] : ownership.kind === "user" ? [ownership.userColumn] : [];
  return pk.includes(column.name) || fkColumns.includes(column.name) || owner.includes(column.name);
}

/** Picks one column to change and the new value. Falls back to writing a value unchanged (still a real UPDATE). */
function chooseUpdate(route: Route, row: Record<string, unknown>): { column: string; value: unknown; sameValue: boolean } | undefined {
  const checks = route.base.constraints.filter((c) => c.type === "check");
  const candidates = route.base.columns.filter(
    (c) => route.columns.has(c.name) && !c.generated && c.identity === "" && !isKeyColumn(route, c),
  );
  const ranked = [...candidates].sort((a, b) => Number(b.type.category === "S") - Number(a.type.category === "S"));
  for (const column of ranked) {
    const generated = generateValue({
      column,
      hints: hintsForColumn(column, checks),
      tenant: "A",
      table: "intrude",
      index: 9,
      differentFrom: row[column.name],
    });
    if (generated.ok) return { column: column.name, value: generated.value, sameValue: false };
  }
  const fallback = route.base.columns.find((c) => route.columns.has(c.name) && !c.generated && c.identity !== "a");
  return fallback ? { column: fallback.name, value: row[fallback.name] ?? null, sameValue: true } : undefined;
}

async function send(ctx: ProbeContext, options: RequestOptions): Promise<{ response: Awaited<ReturnType<ProbeContext["api"]["send"]>>; evidence: HttpEvidence }> {
  const response = await ctx.api.send(options);
  return { response, evidence: evidenceOf(options, response) };
}

async function probeSelect(ctx: ProbeContext, route: Route, actor: Actor, target: SeededRow | undefined): Promise<CheckResult> {
  const spec = specOf(route.api, "select", actor);
  const markers = foreignMarkers(ctx, actor);
  const queries: string[] = [];
  if (target) {
    const filter = rowFilter(route.base, target.data, route.columns);
    if (filter) queries.push(`select=*&${filter}`);
  }
  queries.push(`select=*&limit=${UNFILTERED_LIMIT}`);
  const requests: HttpEvidence[] = [];
  const outcomes = [];
  let before: string | undefined;
  if (target && isBaseTable(route.base)) {
    const state = await currentRow(ctx, route.base, target.data);
    if (!state) return inconclusive(spec, "Tenant B's test row was missing before the attempt, so the result would not mean anything.");
    before = `${describeRow(route.base, target.data)} belongs to tenant B and exists.`;
  }
  for (const query of queries) {
    const { path, headers } = restTarget(route.api.schema, route.api.name, query, false);
    const { response, evidence } = await send(ctx, { method: "GET", path, headers, caller: callerFor(ctx, actor) });
    requests.push(evidence);
    const found = response.status >= 200 && response.status < 300 ? findMarkers(response.text, markers) : [];
    if (found.length > 0) {
      const item = firstLeakedItem(response, found);
      const evidence: Evidence = {
        actor,
        requests,
        after: `The response contained ${actor === "anon" ? "the tenants'" : "tenant B's"} data${item ? `: ${excerpt(item, 300)}` : "."}`,
        summary: `${actorName(actor)} read ${actor === "anon" ? "customer" : "tenant B's"} data from ${route.api.qualified}.`,
      };
      if (before) evidence.before = before;
      return leaked(spec, evidence);
    }
    outcomes.push(classifyResponse(response));
  }
  const evidence: Evidence = {
    actor,
    requests,
    after: `No ${actor === "anon" ? "customer" : "tenant B"} data came back.`,
    summary: `${actorName(actor)} could not read ${actor === "anon" ? "customer" : "tenant B's"} data from ${route.api.qualified}.`,
  };
  if (before) evidence.before = before;
  const serverError = outcomes.find((o) => o.kind === "server_error");
  if (serverError?.kind === "server_error") return inconclusive(spec, serverError.reason, evidence);
  const otherError = outcomes.find((o) => o.kind === "error");
  if (otherError?.kind === "error") return inconclusive(spec, otherError.reason, evidence);
  const denied = outcomes.find((o) => o.kind === "denied");
  return passed(spec, evidence, denied?.kind === "denied" ? [denied.note] : []);
}

async function positiveControl(ctx: ProbeContext, route: Route): Promise<PositiveControl | undefined> {
  const own = rowsOf(ctx.seed, route.base.qualified, "A")[0];
  if (!own) return undefined;
  const filter = rowFilter(route.base, own.data, route.columns);
  if (!filter) return undefined;
  const { path, headers } = restTarget(route.api.schema, route.api.name, `select=*&${filter}`, false);
  const response = await ctx.api.send({ method: "GET", path, headers, caller: callerFor(ctx, "tenant_a") });
  const visible = Array.isArray(response.json) && response.json.length > 0;
  return { table: route.api.qualified, ownRowVisible: visible };
}

/** Runs one write attempt and judges it from the database, then restores everything the attempt changed. */
async function attemptWrite(
  ctx: ProbeContext,
  spec: CheckSpec,
  options: RequestOptions,
  judge: (diffs: ReturnType<ProbeContext["world"]["diff"]>) => { leak: false } | { leak: true; after: string },
  texts: { before: string; leakSummary: string; passSummary: string; acceptedNote?: string },
): Promise<CheckResult> {
  const { response, evidence: request } = await send(ctx, options);
  const after = await ctx.world.read();
  const verdict = judge(ctx.world.diff(after));
  await ctx.world.restore();
  const evidence: Evidence = { actor: spec.actor, requests: [request], before: texts.before, summary: texts.leakSummary };
  if (verdict.leak) {
    evidence.after = verdict.after;
    return leaked(spec, evidence);
  }
  evidence.after = "The database shows tenant B's data was not changed.";
  evidence.summary = texts.passSummary;
  const outcome = classifyResponse(response);
  if (outcome.kind === "server_error") return inconclusive(spec, outcome.reason, evidence);
  if (outcome.kind === "error") return inconclusive(spec, outcome.reason, evidence);
  if (outcome.kind === "denied") return passed(spec, evidence, [outcome.note]);
  return passed(spec, evidence, texts.acceptedNote ? [texts.acceptedNote] : ["The API accepted the request, but row level security filtered out the target, so nothing changed."]);
}

async function probeInsert(ctx: ProbeContext, route: Route, actor: Actor): Promise<CheckResult> {
  const spec = specOf(route.api, "insert", actor);
  const ownership = route.tenancy.ownership;
  const shared = ownership.kind === "shared";
  const built = buildRow(route.base, ctx.tenancy, ctx.seed, ctx.config, ctx.catalog, {
    tenant: shared ? "S" : "B",
    index: 9,
    mode: "full",
    ...(actor === "tenant_a" && ownership.kind !== "user" ? { actingUserId: ctx.userA.id } : {}),
  });
  if (!built.ok) return notTested(spec, "could_not_test", `Could not build a test row for this table because ${built.reason}.`);
  const body = Object.fromEntries(Object.entries(built.values).filter(([column]) => route.columns.has(column)));
  const ownerValues = shared ? {} : ownershipValues(ctx, ownership, "B") ?? {};
  const missing = Object.keys(ownerValues).filter((column) => !(column in body));
  if (missing.length > 0) {
    return notTested(spec, "not_applicable", `This ${route.api.kind === "table" ? "table" : "view"} does not show the owner column (${missing.join(", ")}), so a row for another tenant cannot be sent through it.`);
  }
  const { path, headers } = restTarget(route.api.schema, route.api.name, "", true);
  return attemptWrite(
    ctx,
    spec,
    { method: "POST", path, headers: { ...headers, Prefer: "return=minimal" }, caller: callerFor(ctx, actor), json: body },
    (diffs) => {
      const added = diffs.find((d) => d.table === route.base.qualified)?.added ?? [];
      const intruding = shared ? added : added.filter((row) => ownerOf(ownership, row.data, ctx.seed) === "B");
      if (intruding.length === 0) return { leak: false };
      return {
        leak: true,
        after: `A new ${shared ? "shared " : "tenant B "}row now exists in ${route.base.qualified}: ${excerpt(intruding[0]?.json ?? "", 300)}`,
      };
    },
    {
      before: shared
        ? `${route.base.qualified} holds data every tenant relies on.`
        : `The new row was marked as belonging to tenant B (${Object.entries(ownerValues).map(([c, v]) => `${c}=${String(v)}`).join(", ")}).`,
      leakSummary: shared
        ? `${actorName(actor)} added a row to the shared table ${route.base.qualified}.`
        : `${actorName(actor)} created a row inside tenant B's data in ${route.base.qualified}.`,
      passSummary: shared
        ? `${actorName(actor)} could not add rows to the shared table ${route.base.qualified}.`
        : `${actorName(actor)} could not create rows inside tenant B's data in ${route.base.qualified}.`,
      acceptedNote: "The API accepted the request, but no row belonging to tenant B was stored (a trigger or default kept it with the caller).",
    },
  );
}

async function probeUpdate(ctx: ProbeContext, route: Route, actor: Actor, target: SeededRow): Promise<CheckResult> {
  const spec = specOf(route.api, "update", actor);
  const filter = rowFilter(route.base, target.data, route.columns);
  if (!filter) return inconclusive(spec, "Tenant B's row could not be targeted: the table has no primary key, unique key or unique test value.");
  const before = await currentRow(ctx, route.base, target.data);
  if (!before) return inconclusive(spec, "Tenant B's test row was missing before the attempt, so the result would not mean anything.");
  const change = chooseUpdate(route, before.data);
  if (!change) return notTested(spec, "could_not_test", "No column of this table could be changed through the API.");
  const owner = target.tenant === "S" ? "the shared" : "tenant B's";
  const { path, headers } = restTarget(route.api.schema, route.api.name, filter, true);
  return attemptWrite(
    ctx,
    spec,
    { method: "PATCH", path, headers: { ...headers, Prefer: "return=minimal" }, caller: callerFor(ctx, actor), json: { [change.column]: change.value } },
    (diffs) => {
      const diff = diffs.find((d) => d.table === route.base.qualified);
      const changed = diff?.changed.find((c) => c.before.key === before.key);
      const gone = diff?.missing.find((m) => m.key === before.key);
      if (!changed && !gone) return { leak: false };
      return {
        leak: true,
        after: changed
          ? change.sameValue
            ? `Postgres rewrote ${owner} row (its row version changed from ${changed.before.xmin} to ${changed.after.xmin}).`
            : `${change.column} of ${owner} row changed from ${JSON.stringify(changed.before.data[change.column])} to ${JSON.stringify(changed.after.data[change.column])}.`
          : `${owner[0]?.toUpperCase()}${owner.slice(1)} row was replaced.`,
      };
    },
    {
      before: `${describeRow(route.base, before.data)} belongs to ${target.tenant === "S" ? "no single tenant (shared)" : "tenant B"} and exists.`,
      leakSummary: `${actorName(actor)} changed ${owner} row in ${route.base.qualified}.`,
      passSummary: `${actorName(actor)} could not change ${owner} row in ${route.base.qualified}.`,
    },
  );
}

async function probeReassign(ctx: ProbeContext, route: Route, own: SeededRow): Promise<CheckResult> {
  const spec = specOf(route.api, "update_reassign", "tenant_a");
  const ownership = route.tenancy.ownership;
  const values = ownershipValues(ctx, ownership, "B");
  if (!values) return notTested(spec, "could_not_test", "Tenant B's owner value is not known, so a row could not be moved to tenant B.");
  const hidden = Object.keys(values).filter((column) => !route.columns.has(column));
  if (hidden.length > 0) {
    return notTested(spec, "not_applicable", `This view does not show the owner column (${hidden.join(", ")}), so a row cannot be moved through it.`);
  }
  const filter = rowFilter(route.base, own.data, route.columns);
  if (!filter) return inconclusive(spec, "Tenant A's row could not be targeted: the table has no primary key, unique key or unique test value.");
  const before = await currentRow(ctx, route.base, own.data);
  if (!before) return inconclusive(spec, "Tenant A's test row was missing before the attempt.");
  const ownedByB = new Set(
    [...(ctx.world.baseline.get(route.base.qualified)?.values() ?? [])].filter((row) => ownerOf(ownership, row.data, ctx.seed) === "B").map((row) => row.json),
  );
  const { path, headers } = restTarget(route.api.schema, route.api.name, filter, true);
  return attemptWrite(
    ctx,
    spec,
    { method: "PATCH", path, headers: { ...headers, Prefer: "return=minimal" }, caller: callerFor(ctx, "tenant_a"), json: values },
    (diffs) => {
      const diff = diffs.find((d) => d.table === route.base.qualified);
      const moved = [...(diff?.added ?? []), ...(diff?.changed.map((c) => c.after) ?? [])].find(
        (row) => ownerOf(ownership, row.data, ctx.seed) === "B" && !ownedByB.has(row.json),
      );
      return moved ? { leak: true, after: `Tenant A's row now belongs to tenant B: ${excerpt(moved.json, 300)}` } : { leak: false };
    },
    {
      before: `${describeRow(route.base, before.data)} belongs to tenant A. The request tried to set ${Object.entries(values).map(([c, v]) => `${c}=${String(v)}`).join(", ")} (tenant B).`,
      leakSummary: `Tenant A moved one of its own rows in ${route.base.qualified} into tenant B's data.`,
      passSummary: `Tenant A could not move its rows in ${route.base.qualified} into tenant B's data.`,
      acceptedNote: "The API accepted the request, but the row still belongs to tenant A.",
    },
  );
}

async function probeDelete(ctx: ProbeContext, route: Route, actor: Actor, target: SeededRow): Promise<CheckResult> {
  const spec = specOf(route.api, "delete", actor);
  const filter = rowFilter(route.base, target.data, route.columns);
  if (!filter) return inconclusive(spec, "Tenant B's row could not be targeted: the table has no primary key, unique key or unique test value.");
  const before = await currentRow(ctx, route.base, target.data);
  if (!before) return inconclusive(spec, "Tenant B's test row was missing before the attempt, so the result would not mean anything.");
  const owner = target.tenant === "S" ? "the shared" : "tenant B's";
  const { path, headers } = restTarget(route.api.schema, route.api.name, filter, true);
  return attemptWrite(
    ctx,
    spec,
    { method: "DELETE", path, headers: { ...headers, Prefer: "return=minimal" }, caller: callerFor(ctx, actor) },
    (diffs) => {
      const gone = diffs.find((d) => d.table === route.base.qualified)?.missing.find((m) => m.key === before.key);
      return gone ? { leak: true, after: `${owner[0]?.toUpperCase()}${owner.slice(1)} row is gone from ${route.base.qualified}.` } : { leak: false };
    },
    {
      before: `${describeRow(route.base, before.data)} belongs to ${target.tenant === "S" ? "no single tenant (shared)" : "tenant B"} and exists.`,
      leakSummary: `${actorName(actor)} deleted ${owner} row in ${route.base.qualified}.`,
      passSummary: `${actorName(actor)} could not delete ${owner} row in ${route.base.qualified}.`,
    },
  );
}

function allNotTested(relation: Relation, kind: "excluded" | "could_not_test" | "not_applicable", reason: string): CheckResult[] {
  return ACTORS.flatMap((actor) => operationsFor(actor).map((op) => notTested(specOf(relation, op, actor), kind, reason)));
}

/** Runs the probe matrix of DESIGN.md section 7.2 on one exposed base table. */
export async function probeTable(ctx: ProbeContext, relation: Relation): Promise<RelationProbeResult> {
  const tenancy = ctx.tenancy.tables.get(relation.qualified);
  if (!tenancy) return { checks: allNotTested(relation, "could_not_test", "The table was not part of the tenancy model.") };
  const ownership = tenancy.ownership;
  if (ownership.kind === "skipped") return { checks: allNotTested(relation, "excluded", `Excluded in the config: ${ownership.reason}`) };
  const seed = ctx.seed.tables.get(relation.qualified);
  if (!seed || seed.failure) {
    return { checks: allNotTested(relation, "could_not_test", `The tool ${seed?.failure ?? "could not create test data for this table"}.`) };
  }
  const route: Route = { api: relation, base: relation, tenancy, columns: new Set(relation.columns.map((c) => c.name)) };
  return probeRoute(ctx, route);
}

async function probeRoute(ctx: ProbeContext, route: Route): Promise<RelationProbeResult> {
  const ownership = route.tenancy.ownership;
  const shared = ownership.kind === "shared";
  const targetLabel = shared ? "S" : "B";
  const targets = rowsOf(ctx.seed, route.base.qualified, targetLabel);
  const readTarget = targets[0];
  const deleteTarget = targets[1] ?? targets[0];
  const own = rowsOf(ctx.seed, route.base.qualified, "A")[0];
  const checks: CheckResult[] = [];
  const control = shared ? undefined : await positiveControl(ctx, route);
  for (const actor of ACTORS) {
    for (const op of operationsFor(actor)) {
      const spec = specOf(route.api, op, actor);
      if (op === "select") {
        if (shared) {
          checks.push(notTested(spec, "not_applicable", "This table does not belong to any customer, so there is nothing private to read."));
          continue;
        }
        const result = await probeSelect(ctx, route, actor, readTarget);
        if (actor === "tenant_a" && control && !control.ownRowVisible && result.status === "pass") {
          result.notes.push("Tenant A cannot read its own rows here either.");
        }
        checks.push(result);
        continue;
      }
      if (op === "insert" && ownership.kind === "tenant_root") {
        checks.push(notTested(spec, "not_applicable", "Creating a new tenant does not touch another tenant's data."));
        continue;
      }
      if (op === "update_reassign") {
        if (shared || ownership.kind === "tenant_root") {
          checks.push(notTested(spec, "not_applicable", shared ? "Shared rows have no owner to change." : "A tenant row cannot be moved to another tenant."));
          continue;
        }
        checks.push(own ? await probeReassign(ctx, route, own) : notTested(spec, "could_not_test", "Tenant A has no test row in this table."));
        continue;
      }
      if (op === "insert") {
        checks.push(await probeInsert(ctx, route, actor));
        continue;
      }
      const target = op === "delete" ? deleteTarget : readTarget;
      if (!target) {
        checks.push(notTested(spec, "could_not_test", `There is no ${shared ? "shared" : "tenant B"} test row in this table.`));
        continue;
      }
      checks.push(op === "update" ? await probeUpdate(ctx, route, actor, target) : await probeDelete(ctx, route, actor, target));
    }
  }
  const result: RelationProbeResult = { checks };
  if (control) result.control = control;
  return result;
}

/**
 * Views and materialized views: `select` is probed with tenant B's markers. Writes are
 * probed only through views Postgres can write through, and are checked on the one
 * table behind the view (DESIGN.md section 7.2).
 */
export async function probeView(ctx: ProbeContext, relation: Relation): Promise<RelationProbeResult> {
  const checks: CheckResult[] = [];
  const route = viewRoute(ctx, relation);
  // A view has no rows of its own to target, so its read is judged only by the markers that come back.
  const readRoute: Route = route ?? {
    api: relation,
    base: relation,
    tenancy: { table: relation.qualified, ownership: { kind: "shared", source: "detected" }, membership: false, explanation: "" },
    columns: new Set(relation.columns.map((c) => c.name)),
  };
  for (const actor of ACTORS) checks.push(await probeSelect(ctx, readRoute, actor, undefined));
  const writable = relation.kind === "view" && (relation.updatable.insert || relation.updatable.update || relation.updatable.delete);
  if (!writable) {
    const reason =
      relation.kind === "materialized_view"
        ? "A materialized view is a stored copy; it cannot be written to through the API."
        : "Postgres cannot write through this view (it joins or groups data), so writes are not possible.";
    for (const actor of ACTORS) {
      for (const op of operationsFor(actor).filter((o) => o !== "select")) checks.push(notTested(specOf(relation, op, actor), "not_applicable", reason));
    }
    return { checks };
  }
  if (!route || route.tenancy.ownership.kind === "skipped") {
    for (const actor of ACTORS) {
      for (const op of operationsFor(actor).filter((o) => o !== "select")) {
        checks.push(
          notTested(
            specOf(relation, op, actor),
            "could_not_test",
            "Postgres can write through this view, but the tool could not match its rows to a single table with test data.",
          ),
        );
      }
    }
    return { checks };
  }
  const writes = await probeRoute(ctx, route);
  for (const check of writes.checks) if (check.operation !== "select") checks.push(check);
  return { checks };
}

function viewRoute(ctx: ProbeContext, view: Relation): Route | undefined {
  const bases = view.dependsOn
    .map((name) => ctx.catalog.relations.find((r) => r.qualified === name))
    .filter((r): r is Relation => r !== undefined && isBaseTable(r));
  if (bases.length !== 1) return undefined;
  const base = bases[0] as Relation;
  const tenancy = ctx.tenancy.tables.get(base.qualified);
  const seed = ctx.seed.tables.get(base.qualified);
  if (!tenancy || !seed || seed.failure) return undefined;
  const columns = new Set(view.columns.map((c) => c.name).filter((name) => base.columns.some((c) => c.name === name)));
  if (!primaryKey(base).every((column) => columns.has(column))) return undefined;
  return { api: view, base, tenancy, columns };
}
