import type { Catalog, Column, Constraint, FunctionInfo, Policy, Relation, TypeInfo } from "../../src/discover/catalog.ts";

/** Small builders for catalog objects, so unit tests can describe a schema in a few lines. */

const TYPES: Record<string, Omit<TypeInfo, "display" | "domainChecks">> = {
  uuid: { base: "uuid", category: "U", enumLabels: [] },
  text: { base: "text", category: "S", enumLabels: [] },
  int8: { base: "int8", category: "N", enumLabels: [] },
  int4: { base: "int4", category: "N", enumLabels: [] },
  numeric: { base: "numeric", category: "N", enumLabels: [] },
  bool: { base: "bool", category: "B", enumLabels: [] },
  timestamptz: { base: "timestamptz", category: "D", enumLabels: [] },
  jsonb: { base: "jsonb", category: "U", enumLabels: [] },
  _text: { base: "_text", category: "A", enumLabels: [], element: "text" },
};

export function type(name: keyof typeof TYPES | string, extra: Partial<TypeInfo> = {}): TypeInfo {
  const known = TYPES[name] ?? { base: name, category: "X", enumLabels: [] };
  return { display: name, domainChecks: [], ...known, ...extra };
}

export function col(name: string, typeName: string, options: Partial<Column> = {}): Column {
  return { name, type: type(typeName), notNull: false, identity: "", generated: false, ...options };
}

export function pk(...columns: string[]): Constraint {
  return { name: `pk_${columns.join("_")}`, type: "primary", columns, definition: `PRIMARY KEY (${columns.join(", ")})` };
}

export function fk(columns: string | string[], table: string, refColumns: string | string[] = "id"): Constraint {
  const list = Array.isArray(columns) ? columns : [columns];
  const refs = Array.isArray(refColumns) ? refColumns : [refColumns];
  const [schema, name] = table.includes(".") ? (table.split(".") as [string, string]) : ["public", table];
  return {
    name: `fk_${list.join("_")}`,
    type: "foreign",
    columns: list,
    definition: `FOREIGN KEY (${list.join(", ")}) REFERENCES ${schema}.${name}(${refs.join(", ")})`,
    references: { schema, table: name, columns: refs },
  };
}

export function check(columns: string[], definition: string): Constraint {
  return { name: `check_${columns.join("_")}`, type: "check", columns, definition };
}

export function policy(table: string, name: string, command: Policy["command"], options: Partial<Policy> = {}): Policy {
  const [schema, tableName] = table.split(".") as [string, string];
  return { schema, table: tableName, name, command, permissive: true, roles: ["authenticated"], ...options };
}

const ALL = { select: true, insert: true, update: true, delete: true };

export function table(qualified: string, columns: Column[], constraints: Constraint[] = [], options: Partial<Relation> = {}): Relation {
  const [schema, name] = qualified.split(".") as [string, string];
  return {
    schema,
    name,
    qualified,
    kind: "table",
    rlsEnabled: true,
    rlsForced: false,
    owner: "postgres",
    ownerBypassesRls: true,
    securityInvoker: false,
    privileges: { anon: { ...ALL }, authenticated: { ...ALL } },
    updatable: { insert: true, update: true, delete: true },
    columns,
    constraints,
    policies: [],
    triggers: [],
    dependsOn: [],
    ...options,
  };
}

export function fn(qualified: string, options: Partial<FunctionInfo> = {}): FunctionInfo {
  const [schema, name] = qualified.split(".") as [string, string];
  return {
    schema,
    name,
    qualified,
    signature: "",
    args: [],
    hasUnnamedArgs: false,
    returns: "void",
    returnsSet: false,
    securityDefiner: false,
    volatility: "volatile",
    language: "sql",
    executable: { anon: true, authenticated: true },
    overloaded: false,
    ...options,
  };
}

export function catalogOf(relations: Relation[], extra: Partial<Catalog> = {}): Catalog {
  return {
    schemas: ["public"],
    relations,
    functions: [],
    buckets: [],
    storagePolicies: [],
    extensionObjects: [],
    postgresVersion: "17.6",
    ...extra,
  };
}

/** The demo agency schema in miniature: a tenant table, members, a tenant table, a child, a personal table and a shared table. */
export function agencyCatalog(): Catalog {
  return catalogOf([
    table("public.organizations", [col("id", "uuid", { notNull: true, default: "gen_random_uuid()" }), col("name", "text", { notNull: true })], [pk("id")]),
    table(
      "public.org_members",
      [col("org_id", "uuid", { notNull: true }), col("user_id", "uuid", { notNull: true }), col("role", "text", { notNull: true, default: "'member'::text" })],
      [pk("org_id", "user_id"), fk("org_id", "organizations"), fk("user_id", "auth.users")],
    ),
    table(
      "public.invoices",
      [
        col("id", "uuid", { notNull: true, default: "gen_random_uuid()" }),
        col("org_id", "uuid", { notNull: true }),
        col("client_id", "uuid"),
        col("number", "text", { notNull: true }),
        col("amount", "numeric", { notNull: true }),
      ],
      [pk("id"), fk("org_id", "organizations"), fk("client_id", "clients"), check(["amount"], "CHECK ((amount > (0)::numeric))")],
    ),
    table(
      "public.clients",
      [col("id", "uuid", { notNull: true, default: "gen_random_uuid()" }), col("org_id", "uuid", { notNull: true }), col("name", "text", { notNull: true })],
      [pk("id"), fk("org_id", "organizations")],
    ),
    table(
      "public.payments",
      [col("id", "uuid", { notNull: true, default: "gen_random_uuid()" }), col("invoice_id", "uuid", { notNull: true }), col("amount", "numeric", { notNull: true })],
      [pk("id"), fk("invoice_id", "invoices")],
    ),
    table(
      "public.notes",
      [col("id", "uuid", { notNull: true, default: "gen_random_uuid()" }), col("user_id", "uuid", { notNull: true, default: "auth.uid()" }), col("body", "text", { notNull: true })],
      [pk("id"), fk("user_id", "auth.users")],
    ),
    table("public.profiles", [col("id", "uuid", { notNull: true }), col("display_name", "text")], [pk("id"), fk("id", "auth.users")]),
    table("public.plans", [col("code", "text", { notNull: true }), col("name", "text", { notNull: true })], [pk("code")]),
  ]);
}
