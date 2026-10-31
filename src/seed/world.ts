import type { Relation } from "../discover/catalog.ts";
import { primaryKey } from "../discover/tenancy.ts";
import { type Database, ident, qualifiedIdent } from "../stack/db.ts";

export interface RowState {
  /** Stable identity: the primary key values, or the whole row when the table has no primary key. */
  key: string;
  data: Record<string, unknown>;
  json: string;
  /** Postgres' row version. It changes on every successful UPDATE, even one that writes the same values. */
  xmin: string;
  ctid: string;
}

export type TableState = Map<string, RowState>;
export type WorldState = Map<string, TableState>;

export interface TableDiff {
  table: string;
  missing: RowState[];
  added: RowState[];
  changed: { before: RowState; after: RowState }[];
}

/** Orders tables so that every table comes after the tables it references (parents first). */
export function foreignKeyOrder(relations: readonly Relation[]): Relation[] {
  const byName = new Map(relations.map((relation) => [relation.qualified, relation]));
  const ordered: Relation[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (relation: Relation): void => {
    const mark = state.get(relation.qualified);
    if (mark === "done" || mark === "visiting") return;
    state.set(relation.qualified, "visiting");
    for (const constraint of relation.constraints) {
      if (constraint.type !== "foreign" || !constraint.references) continue;
      const parent = byName.get(`${constraint.references.schema}.${constraint.references.table}`);
      if (parent && parent !== relation) visit(parent);
    }
    state.set(relation.qualified, "done");
    ordered.push(relation);
  };
  [...relations].sort((a, b) => a.qualified.localeCompare(b.qualified)).forEach(visit);
  return ordered;
}

export function rowKey(relation: Relation, data: Record<string, unknown>): string {
  const pk = primaryKey(relation);
  return pk.length > 0 ? JSON.stringify(pk.map((column) => data[column] ?? null)) : JSON.stringify(data);
}

export function writableColumns(relation: Relation): string[] {
  return relation.columns.filter((column) => !column.generated).map((column) => column.name);
}

/**
 * Snapshots, compares and restores the rows of every probed table. Probes are judged
 * by comparing the database before and after, and every change a probe made is put
 * back before the next probe runs (DESIGN.md section 7.2).
 */
export class World {
  readonly #db: Database;
  readonly #tables: Relation[];
  readonly #byName: Map<string, Relation>;
  #baseline: WorldState = new Map();

  constructor(db: Database, tables: readonly Relation[]) {
    this.#db = db;
    this.#tables = foreignKeyOrder(tables);
    this.#byName = new Map(this.#tables.map((relation) => [relation.qualified, relation]));
  }

  get baseline(): WorldState {
    return this.#baseline;
  }

  relation(name: string): Relation | undefined {
    return this.#byName.get(name);
  }

  async readTable(relation: Relation): Promise<TableState> {
    const rows = await this.#db.query<{ ctid: string; xmin: string; json: string }>(
      `select t.ctid::text as ctid, t.xmin::text as xmin, to_jsonb(t.*)::text as json from ${qualifiedIdent(relation.schema, relation.name)} t`,
    );
    const state: TableState = new Map();
    for (const row of rows) {
      const data = JSON.parse(row.json) as Record<string, unknown>;
      const key = rowKey(relation, data);
      state.set(state.has(key) ? `${key}#${row.ctid}` : key, { key, data, json: row.json, xmin: row.xmin, ctid: row.ctid });
    }
    return state;
  }

  async read(): Promise<WorldState> {
    const world: WorldState = new Map();
    for (const relation of this.#tables) world.set(relation.qualified, await this.readTable(relation));
    return world;
  }

  /** Records the current state as the one every probe must leave behind. */
  async captureBaseline(): Promise<void> {
    this.#baseline = await this.read();
  }

  diff(after: WorldState, before: WorldState = this.#baseline): TableDiff[] {
    const diffs: TableDiff[] = [];
    for (const [table, beforeRows] of before) {
      const afterRows = after.get(table) ?? new Map<string, RowState>();
      const diff: TableDiff = { table, missing: [], added: [], changed: [] };
      for (const [key, row] of beforeRows) {
        const now = afterRows.get(key);
        if (!now) diff.missing.push(row);
        else if (now.json !== row.json || now.xmin !== row.xmin) diff.changed.push({ before: row, after: now });
      }
      for (const [key, row] of afterRows) if (!beforeRows.has(key)) diff.added.push(row);
      if (diff.missing.length + diff.added.length + diff.changed.length > 0) diffs.push(diff);
    }
    return diffs;
  }

  /**
   * Puts the database back to the baseline: deletes rows a probe added, re-inserts rows it
   * deleted (including rows removed by cascades) and reverts changed values. Triggers and
   * foreign-key actions are switched off while restoring, so the restore itself has no side effects.
   */
  async restore(): Promise<void> {
    const diffs = this.diff(await this.read()).filter(
      (diff) => diff.missing.length > 0 || diff.added.length > 0 || diff.changed.some((c) => c.before.json !== c.after.json),
    );
    if (diffs.length === 0) return;
    const byTable = new Map(diffs.map((diff) => [diff.table, diff]));
    await this.#db.transaction(async () => {
      await this.#db.query("set local session_replication_role = replica");
      for (const relation of [...this.#tables].reverse()) {
        const diff = byTable.get(relation.qualified);
        for (const row of diff?.added ?? []) {
          await this.#db.query(`delete from ${qualifiedIdent(relation.schema, relation.name)} where ctid = $1::tid`, [row.ctid]);
        }
      }
      for (const relation of this.#tables) {
        const diff = byTable.get(relation.qualified);
        if (!diff) continue;
        const target = qualifiedIdent(relation.schema, relation.name);
        const columns = writableColumns(relation);
        const list = columns.map(ident).join(", ");
        for (const row of diff.missing) {
          await this.#db.query(
            `insert into ${target} (${list}) overriding system value select ${list} from jsonb_populate_record(null::${target}, $1::jsonb)`,
            [row.json],
          );
        }
        const pk = primaryKey(relation);
        const settable = relation.columns.filter((c) => !c.generated && c.identity === "" && !pk.includes(c.name)).map((c) => c.name);
        for (const change of diff.changed) {
          if (change.before.json === change.after.json || settable.length === 0) continue;
          await this.#db.query(
            `update ${target} as x set ${settable.map((c) => `${ident(c)} = r.${ident(c)}`).join(", ")}
             from jsonb_populate_record(null::${target}, $1::jsonb) as r where x.ctid = $2::tid`,
            [change.before.json, change.after.ctid],
          );
        }
      }
    });
    const remaining = this.diff(await this.read()).filter(
      (diff) => diff.missing.length > 0 || diff.added.length > 0 || diff.changed.some((c) => c.before.json !== c.after.json),
    );
    if (remaining.length > 0) {
      throw new Error(`could not restore the test data in ${remaining.map((diff) => diff.table).join(", ")}`);
    }
    // Restoring rewrites rows, which gives them new row versions. Re-read so later probes compare like with like.
    await this.captureBaseline();
  }
}
