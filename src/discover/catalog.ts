import type { Database } from "../stack/db.ts";

/** Schemas that belong to Supabase or Postgres itself. They are never treated as the app's own data. */
export const INTERNAL_SCHEMAS = new Set([
  "auth",
  "storage",
  "extensions",
  "graphql",
  "realtime",
  "supabase_functions",
  "supabase_migrations",
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "pgbouncer",
  "_realtime",
  "_analytics",
]);

export type RelationKind = "table" | "partitioned_table" | "view" | "materialized_view" | "foreign_table";

export interface Privileges {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

/** A column type with domains resolved to their base type. */
export interface TypeInfo {
  /** The declared type as Postgres prints it, for example `character varying(40)` or `public.status`. */
  display: string;
  /** Name of the base type after resolving domains, for example `varchar`, `uuid`, `_text`. */
  base: string;
  /** Postgres type category of the base type (`S` string, `N` numeric, `A` array, `E` enum, ...). */
  category: string;
  enumLabels: string[];
  /** For arrays: the element's base type name. */
  element?: string;
  /** Check constraints of any domains on the way, with `VALUE` standing for the column. */
  domainChecks: string[];
}

export interface Column {
  name: string;
  type: TypeInfo;
  notNull: boolean;
  default?: string;
  /** `a` = GENERATED ALWAYS AS IDENTITY, `d` = BY DEFAULT, empty = not an identity column. */
  identity: "" | "a" | "d";
  generated: boolean;
  /** Character limit for varchar(n) and char(n). */
  maxLength?: number;
}

export interface Constraint {
  name: string;
  type: "primary" | "unique" | "foreign" | "check";
  columns: string[];
  definition: string;
  references?: { schema: string; table: string; columns: string[] };
}

export type PolicyCommand = "select" | "insert" | "update" | "delete" | "all";

export interface Policy {
  schema: string;
  table: string;
  name: string;
  command: PolicyCommand;
  permissive: boolean;
  roles: string[];
  using?: string;
  withCheck?: string;
}

export interface Relation {
  schema: string;
  name: string;
  /** `schema.name` */
  qualified: string;
  kind: RelationKind;
  rlsEnabled: boolean;
  rlsForced: boolean;
  owner: string;
  ownerBypassesRls: boolean;
  /** Views only: `security_invoker = true` (the view runs with the caller's rights). */
  securityInvoker: boolean;
  privileges: { anon: Privileges; authenticated: Privileges };
  /** What Postgres can do through this relation (always all three for plain tables). */
  updatable: { insert: boolean; update: boolean; delete: boolean };
  columns: Column[];
  constraints: Constraint[];
  policies: Policy[];
  triggers: string[];
  /** Views only: the tables and views the definition reads from. */
  dependsOn: string[];
}

export interface FunctionArg {
  name: string;
  type: TypeInfo;
  hasDefault: boolean;
}

export interface FunctionInfo {
  schema: string;
  name: string;
  qualified: string;
  /** Argument list as Postgres prints it, for the report. */
  signature: string;
  args: FunctionArg[];
  /** True if an input argument has no name, which PostgREST cannot call (except a single json/text/bytea argument). */
  hasUnnamedArgs: boolean;
  returns: string;
  returnsSet: boolean;
  securityDefiner: boolean;
  volatility: "immutable" | "stable" | "volatile";
  language: string;
  executable: { anon: boolean; authenticated: boolean };
  /** True if another function in the same schema has the same name. */
  overloaded: boolean;
}

export interface Bucket {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes: string[];
}

export interface Catalog {
  schemas: string[];
  relations: Relation[];
  functions: FunctionInfo[];
  buckets: Bucket[];
  /** Policies on storage.objects and storage.buckets. */
  storagePolicies: Policy[];
  /** Objects in exposed schemas that belong to an extension (for example PostGIS tables); not probed. */
  extensionObjects: string[];
  postgresVersion: string;
}

const KIND: Readonly<Record<string, RelationKind>> = {
  r: "table",
  p: "partitioned_table",
  v: "view",
  m: "materialized_view",
  f: "foreign_table",
};

const COMMAND: Readonly<Record<string, PolicyCommand>> = { r: "select", a: "insert", w: "update", d: "delete", "*": "all" };

const CONSTRAINT: Readonly<Record<string, Constraint["type"]>> = { p: "primary", u: "unique", f: "foreign", c: "check" };

const VOLATILITY: Readonly<Record<string, FunctionInfo["volatility"]>> = { i: "immutable", s: "stable", v: "volatile" };

/** Which schemas the tool treats as the app's API: the PostgREST schemas minus Supabase-internal ones. */
export function exposedSchemas(apiSchemas: readonly string[]): string[] {
  return [...new Set(apiSchemas)].filter((schema) => !INTERNAL_SCHEMAS.has(schema));
}

interface TypeRow {
  oid: number;
  typname: string;
  typtype: string;
  typcategory: string;
  typbasetype: number;
  typelem: number;
  display: string;
  labels: string[];
  checks: string[];
}

/** Resolves a type oid through any domains to a TypeInfo. */
export function resolveType(types: ReadonlyMap<number, TypeRow>, oid: number, display: string): TypeInfo {
  const domainChecks: string[] = [];
  let current = types.get(oid);
  let guard = 0;
  while (current && current.typtype === "d" && guard++ < 10) {
    domainChecks.push(...current.checks);
    current = types.get(current.typbasetype);
  }
  if (!current) return { display, base: "unknown", category: "X", enumLabels: [], domainChecks };
  const info: TypeInfo = {
    display,
    base: current.typname,
    category: current.typcategory,
    enumLabels: current.typtype === "e" ? current.labels : [],
    domainChecks,
  };
  if (current.typcategory === "A" && current.typelem !== 0) {
    const element = resolveType(types, current.typelem, display);
    info.element = element.base;
    if (element.enumLabels.length > 0) info.enumLabels = element.enumLabels;
  }
  return info;
}

function varcharLimit(base: string, typmod: number): number | undefined {
  return (base === "varchar" || base === "bpchar") && typmod > 4 ? typmod - 4 : undefined;
}

async function loadTypes(db: Database): Promise<Map<number, TypeRow>> {
  const rows = await db.query<TypeRow>(`
    select t.oid::int as oid, t.typname, t.typtype::text as typtype, t.typcategory::text as typcategory,
           t.typbasetype::int as typbasetype, t.typelem::int as typelem, format_type(t.oid, null) as display,
           coalesce(array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder), '{}') as labels,
           coalesce(array(select pg_get_constraintdef(c.oid) from pg_constraint c where c.contypid = t.oid and c.contype = 'c'), '{}') as checks
    from pg_type t`);
  return new Map(rows.map((row) => [row.oid, row]));
}

/** Reads everything the tool needs from the system catalogs. Runs as the postgres superuser. */
export async function discoverCatalog(db: Database, apiSchemas: readonly string[]): Promise<Catalog> {
  const schemas = exposedSchemas(apiSchemas);
  const types = await loadTypes(db);
  const [{ version }] = (await db.query<{ version: string }>("select current_setting('server_version') as version")) as [
    { version: string },
  ];

  const relationRows = await db.query<{
    oid: number;
    schema: string;
    name: string;
    kind: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    is_partition: boolean;
    from_extension: boolean;
    owner: string;
    owner_bypasses_rls: boolean;
    options: string[];
    updatable: number;
    privs: boolean[];
  }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind::text as kind,
            c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced, c.relispartition as is_partition,
            exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') as from_extension,
            pg_get_userbyid(c.relowner) as owner,
            coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r where r.oid = c.relowner), false) as owner_bypasses_rls,
            coalesce(c.reloptions, '{}') as options,
            case when c.relkind in ('r', 'p', 'v', 'f') then pg_relation_is_updatable(c.oid, false) else 0 end as updatable,
            array[
              has_any_column_privilege('anon', c.oid, 'SELECT'), has_any_column_privilege('anon', c.oid, 'INSERT'),
              has_any_column_privilege('anon', c.oid, 'UPDATE'), has_table_privilege('anon', c.oid, 'DELETE'),
              has_any_column_privilege('authenticated', c.oid, 'SELECT'), has_any_column_privilege('authenticated', c.oid, 'INSERT'),
              has_any_column_privilege('authenticated', c.oid, 'UPDATE'), has_table_privilege('authenticated', c.oid, 'DELETE')
            ] as privs
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'f')
     order by n.nspname, c.relname`,
    [schemas],
  );
  const extensionObjects = relationRows.filter((row) => row.from_extension).map((row) => `${row.schema}.${row.name}`);
  const kept = relationRows.filter((row) => !row.from_extension && !row.is_partition);
  const oids = kept.map((row) => row.oid);

  const columnRows = await db.query<{
    relid: number;
    name: string;
    type_oid: number;
    typmod: number;
    display: string;
    not_null: boolean;
    default: string | null;
    identity: string;
    generated: string;
  }>(
    `select a.attrelid::int as relid, a.attname as name, a.atttypid::int as type_oid, a.atttypmod as typmod,
            format_type(a.atttypid, a.atttypmod) as display, a.attnotnull as not_null,
            pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity::text as identity, a.attgenerated::text as generated
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
     order by a.attrelid, a.attnum`,
    [oids],
  );

  const constraintRows = await db.query<{
    relid: number;
    name: string;
    type: string;
    definition: string;
    columns: string[];
    ref_schema: string | null;
    ref_table: string | null;
    ref_columns: string[];
  }>(
    `select co.conrelid::int as relid, co.conname as name, co.contype::text as type, pg_get_constraintdef(co.oid) as definition,
            array(select a.attname::text from unnest(co.conkey) with ordinality k(num, ord)
                  join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.num order by k.ord) as columns,
            fn.nspname as ref_schema, fc.relname as ref_table,
            coalesce(array(select a.attname::text from unnest(co.confkey) with ordinality k(num, ord)
                  join pg_attribute a on a.attrelid = co.confrelid and a.attnum = k.num order by k.ord), '{}') as ref_columns
     from pg_constraint co
     left join pg_class fc on fc.oid = co.confrelid
     left join pg_namespace fn on fn.oid = fc.relnamespace
     where co.conrelid = any($1::oid[]) and co.contype in ('p', 'u', 'f', 'c')
     order by co.conrelid, co.conname`,
    [oids],
  );

  const policyRows = await db.query<{
    relid: number;
    schema: string;
    table: string;
    name: string;
    cmd: string;
    permissive: boolean;
    roles: string[];
    using: string | null;
    with_check: string | null;
  }>(
    `select pol.polrelid::int as relid, n.nspname as schema, c.relname as table, pol.polname as name, pol.polcmd::text as cmd,
            pol.polpermissive as permissive,
            case when pol.polroles = '{0}'::oid[] then array['public']
                 else array(select r.rolname::text from pg_roles r where r.oid = any(pol.polroles) order by r.rolname) end as roles,
            pg_get_expr(pol.polqual, pol.polrelid) as using, pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
     from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
     where pol.polrelid = any($1::oid[]) or (n.nspname = 'storage' and c.relname in ('objects', 'buckets'))
     order by n.nspname, c.relname, pol.polname`,
    [oids],
  );

  const triggerRows = await db.query<{ relid: number; name: string }>(
    `select tgrelid::int as relid, tgname as name from pg_trigger
     where tgrelid = any($1::oid[]) and not tgisinternal order by tgname`,
    [oids],
  );

  const dependencyRows = await db.query<{ view_oid: number; schema: string; name: string }>(
    `select distinct r.ev_class::int as view_oid, n.nspname as schema, c.relname as name
     from pg_rewrite r
     join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid and d.refclassid = 'pg_class'::regclass
     join pg_class c on c.oid = d.refobjid
     join pg_namespace n on n.oid = c.relnamespace
     where r.ev_class = any($1::oid[]) and d.refobjid <> r.ev_class
     order by 1, 2, 3`,
    [oids],
  );

  const toPolicy = (row: (typeof policyRows)[number]): Policy => {
    const policy: Policy = {
      schema: row.schema,
      table: row.table,
      name: row.name,
      command: COMMAND[row.cmd] ?? "all",
      permissive: row.permissive,
      roles: row.roles,
    };
    if (row.using !== null) policy.using = row.using;
    if (row.with_check !== null) policy.withCheck = row.with_check;
    return policy;
  };

  const relations: Relation[] = kept.map((row) => {
    const p = row.privs;
    const columns: Column[] = columnRows
      .filter((column) => column.relid === row.oid)
      .map((column) => {
        const type = resolveType(types, column.type_oid, column.display);
        const result: Column = {
          name: column.name,
          type,
          notNull: column.not_null,
          identity: column.identity === "a" || column.identity === "d" ? column.identity : "",
          generated: column.generated !== "",
        };
        if (column.default !== null) result.default = column.default;
        const limit = varcharLimit(type.base, column.typmod);
        if (limit !== undefined) result.maxLength = limit;
        return result;
      });
    const constraints: Constraint[] = constraintRows
      .filter((constraint) => constraint.relid === row.oid)
      .map((constraint) => {
        const result: Constraint = {
          name: constraint.name,
          type: CONSTRAINT[constraint.type] ?? "check",
          columns: constraint.columns,
          definition: constraint.definition,
        };
        if (constraint.ref_schema && constraint.ref_table) {
          result.references = { schema: constraint.ref_schema, table: constraint.ref_table, columns: constraint.ref_columns };
        }
        return result;
      });
    return {
      schema: row.schema,
      name: row.name,
      qualified: `${row.schema}.${row.name}`,
      kind: KIND[row.kind] ?? "table",
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
      owner: row.owner,
      ownerBypassesRls: row.owner_bypasses_rls,
      securityInvoker: row.options.some((option) => /^security_invoker=(true|on|1|yes)$/i.test(option)),
      privileges: {
        anon: { select: p[0] === true, insert: p[1] === true, update: p[2] === true, delete: p[3] === true },
        authenticated: { select: p[4] === true, insert: p[5] === true, update: p[6] === true, delete: p[7] === true },
      },
      // pg_relation_is_updatable bits: 4 = UPDATE, 8 = INSERT, 16 = DELETE.
      updatable: { insert: (row.updatable & 8) !== 0, update: (row.updatable & 4) !== 0, delete: (row.updatable & 16) !== 0 },
      columns,
      constraints,
      policies: policyRows.filter((policy) => policy.relid === row.oid).map(toPolicy),
      triggers: triggerRows.filter((trigger) => trigger.relid === row.oid).map((trigger) => trigger.name),
      dependsOn: dependencyRows.filter((dep) => dep.view_oid === row.oid).map((dep) => `${dep.schema}.${dep.name}`),
    };
  });

  const functionRows = await db.query<{
    schema: string;
    name: string;
    signature: string;
    arg_names: string[];
    arg_modes: string[];
    arg_types: number[];
    all_types: number[];
    nargs: number;
    ndefaults: number;
    returns: string;
    returns_set: boolean;
    security_definer: boolean;
    volatility: string;
    language: string;
    anon_exec: boolean;
    auth_exec: boolean;
  }>(
    `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as signature,
            coalesce(p.proargnames, '{}') as arg_names, coalesce(p.proargmodes::text[], '{}') as arg_modes,
            coalesce(p.proargtypes::oid[]::int[], '{}') as arg_types, coalesce(p.proallargtypes::int[], '{}') as all_types,
            p.pronargs::int as nargs, p.pronargdefaults::int as ndefaults,
            pg_get_function_result(p.oid) as returns, p.proretset as returns_set, p.prosecdef as security_definer,
            p.provolatile::text as volatility, l.lanname as language,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_language l on l.oid = p.prolang
     where n.nspname = any($1::text[])
       and p.prokind = 'f'
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and not (n.nspname = 'graphql_public' and p.proname = 'graphql')
     order by n.nspname, p.proname, 3`,
    [schemas],
  );
  const nameCounts = new Map<string, number>();
  for (const row of functionRows) {
    const key = `${row.schema}.${row.name}`;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const functions: FunctionInfo[] = functionRows.map((row) => {
    // With argument modes, proallargtypes/proargnames cover every argument including OUT and TABLE columns.
    const inputs: { name: string; oid: number }[] = [];
    if (row.arg_modes.length > 0) {
      row.arg_modes.forEach((mode, index) => {
        if (mode === "i" || mode === "b" || mode === "v") {
          inputs.push({ name: row.arg_names[index] ?? "", oid: row.all_types[index] ?? 0 });
        }
      });
    } else {
      row.arg_types.forEach((oid, index) => inputs.push({ name: row.arg_names[index] ?? "", oid }));
    }
    const firstDefault = inputs.length - row.ndefaults;
    const args: FunctionArg[] = inputs.map((input, index) => ({
      name: input.name,
      type: resolveType(types, input.oid, types.get(input.oid)?.display ?? "unknown"),
      hasDefault: index >= firstDefault,
    }));
    return {
      schema: row.schema,
      name: row.name,
      qualified: `${row.schema}.${row.name}`,
      signature: row.signature,
      args,
      hasUnnamedArgs: args.some((arg) => arg.name === ""),
      returns: row.returns,
      returnsSet: row.returns_set,
      securityDefiner: row.security_definer,
      volatility: VOLATILITY[row.volatility] ?? "volatile",
      language: row.language,
      executable: { anon: row.anon_exec, authenticated: row.auth_exec },
      overloaded: (nameCounts.get(`${row.schema}.${row.name}`) ?? 0) > 1,
    };
  });

  let buckets: Bucket[] = [];
  const hasStorage = await db.query<{ present: boolean }>("select to_regclass('storage.buckets') is not null as present");
  if (hasStorage[0]?.present) {
    const bucketRows = await db.query<{
      id: string;
      name: string;
      public: boolean;
      file_size_limit: string | null;
      allowed_mime_types: string[] | null;
    }>("select id, name, coalesce(public, false) as public, file_size_limit, allowed_mime_types from storage.buckets order by id");
    buckets = bucketRows.map((row) => {
      const bucket: Bucket = { id: row.id, name: row.name, public: row.public, allowedMimeTypes: row.allowed_mime_types ?? [] };
      if (row.file_size_limit !== null) bucket.fileSizeLimit = Number(row.file_size_limit);
      return bucket;
    });
  }

  return {
    schemas,
    relations,
    functions,
    buckets,
    storagePolicies: policyRows.filter((row) => row.schema === "storage").map(toPolicy),
    extensionObjects,
    postgresVersion: version,
  };
}
