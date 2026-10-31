# tenant-leak-check: design

Status: agreed design for v1 (31 Oct 2026). This document is the reference for every later build session. If the code and this document disagree, fix one of them in the same commit.

## 1. Purpose and promise

`tenant-leak-check` answers one question about a Supabase project:

> Can one customer (tenant A) read, add, change or delete another customer's (tenant B's) data through the Supabase APIs, and can an anonymous visitor do so?

It answers this by **trying it**. It builds a disposable local copy of the project from the project's own migrations, creates two synthetic tenants with synthetic rows, files and users, then makes real API requests as tenant A and as an anonymous visitor against tenant B's data. Every result comes from an attempt the tool actually made and then checked in the database.

It also has a **migration mode**: run the suite, apply a new migration, run it again, and report what changed (new leaks, removed policies, RLS switched off, destructive statements).

### What it is not

It is an isolation test, not a security certification, audit opinion or penetration test. This sentence, or the longer version in `src/core/disclaimer.ts`, appears in the README and in every output: CLI, Markdown, HTML and the JSON `disclaimer` field. The tool must never print "secure", "certified", "compliant" or similar words about a target.

Explicitly out of scope for v1 (stated in every report's "Not covered" section):

- Application code, edge functions, server routes, anything using the service-role key.
- Production or hosted projects, real data, live configuration such as dashboard-only settings.
- Realtime channels, GraphQL (`pg_graphql` uses the same RLS as REST, but it is not probed separately), the S3 protocol endpoint, and Auth admin endpoints.
- Denial of service, rate limits, password policy, JWT forgery, SQL injection.
- Access by a third tenant, by users with special roles inside a tenant, or by time-based rules (only "tenant A member" and "anonymous" are tested).

## 2. Hard safety rules (enforced in code, covered by tests)

1. **Local only.** The tool talks only to a Supabase stack it started (or found running) through the Supabase CLI on this machine. Before any network call or DB connection, `assertLocalUrl()` checks that the host is a loopback address (`127.0.0.1`, `::1`, `localhost`). Anything else stops the run with exit code 3 and a clear message. There is no flag to turn this off.
2. **Never touches the target repo.** The target's `supabase/` folder is read, never written. The tool copies an allowlist into its own sandbox folder: `supabase/migrations/*.sql` and the parsed values it needs from `supabase/config.toml` (section 4.2). It never copies or reads `seed.sql`, `.env*`, `supabase/.temp`, `supabase/functions`, or any secrets file.
3. **No user keys.** The only keys used are the throwaway keys the local CLI generates (read from `supabase status -o json` for the sandbox). They are kept in memory, never written to disk, and redacted from logs and evidence.
4. **No remote CLI commands.** The tool only calls `supabase start`, `stop`, `status`, `db reset` and `migration up`, always with `--workdir <sandbox>` and `--local` where the command accepts it. It never calls `link`, `db push`, `login` or anything with `--linked`.
5. **Synthetic data only.** Users are `tlc-tenant-a@example.com` and `tlc-tenant-b@example.com` (plus generated passwords held in memory). Every seeded value is generated and carries a `tlc` marker.
6. **Never claim a pass without a test.** A check is `pass` only if the attempt was made, tenant B's target really existed at the time (verified in the database), and the database shows the attempt had no effect. Everything else is `not_tested` or `inconclusive`, with a reason written for a non-technical reader.

## 3. Technology

- **TypeScript on Node 24**, run directly with Node's built-in type stripping (`node src/cli.ts`). There is no build step. The code therefore uses erasable syntax only (no `enum`, no `namespace`, no parameter properties) and imports with explicit `.ts` extensions. `tsc --noEmit` type-checks the code.
- **Runtime dependencies (2):** `pg` (direct Postgres access to the local database for discovery, seeding and verification) and `smol-toml` (reading the target's `config.toml`). HTTP uses Node's built-in `fetch`. CLI parsing uses `node:util` `parseArgs`. Tests use `node:test`.
- **Dev dependencies:** `typescript`, `@types/node`, `@types/pg`.
- **Supabase CLI 2.122+ and Docker Engine.** The stack runs with only the services the tool needs: Postgres, GoTrue (auth), PostgREST, Storage API and Kong. Studio, imgproxy, edge-runtime, logflare, vector, realtime, supavisor, mailpit and postgres-meta are switched off in the generated config and also excluded with `-x`. Measured on the build box: the reduced stack uses about 390 MB of RAM.

## 4. Architecture

```
target repo (read-only)          tool sandbox (.tlc-work/<slug>/)              local Supabase stack
supabase/migrations/*.sql  --->  supabase/config.toml (generated)  --start-->  db / auth / rest / storage / kong
supabase/config.toml (parsed)    supabase/migrations/*.sql (copied)

        discover (SQL catalog)  ->  tenancy model  ->  seed (SQL + Auth admin API)
        -> probe (REST / Storage / RPC as tenant A and anon)  ->  verify (SQL)
        -> results  ->  reports (JSON, Markdown, HTML) + exit code
```

Planned source layout (built across sessions 1 to 3):

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Entry point, sub-commands, argument parsing, exit codes |
| `src/core/` | Exit codes, the disclaimer text, error types, shared result types |
| `src/safety/local-only.ts` | Loopback-only URL guard |
| `src/commands/` | `doctor`, `run`, `diff` |
| `src/stack/` | Sandbox creation, generated `config.toml`, Supabase CLI wrapper, reading `status` |
| `src/config/` | Loading and validating the optional `tenant-leak-check.json` |
| `src/discover/` | Catalog queries (tables, columns, constraints, policies, grants, functions, views, buckets) and the tenancy model |
| `src/seed/` | Synthetic users, tenants, rows and files; value generation; snapshot and restore |
| `src/probe/` | HTTP client and the probe matrix for tables and views, storage and RPCs |
| `src/analyze/` | Static rules (catalog-based warnings) and plain-English fix text with SQL snippets |
| `src/migrate/` | Migration SQL scanner, catalog diff, result diff |
| `src/report/` | JSON (with schema), Markdown and HTML renderers |
| `demo/` | Deliberately broken app, fixed app, leak manifest, demo migrations |
| `test/unit/`, `test/integration/` | Unit tests (no Docker) and integration tests (real local stack) |
| `.claude/` | Claude Code command and skill ("run the leak check") |

### 4.1 Commands

```
tenant-leak-check doctor
tenant-leak-check run  --project <dir> [--config <file>] [--out <dir>] [--keep-running] [--workdir <dir>]
tenant-leak-check diff --project <dir> --migration <file.sql> [--migration <file.sql> ...] [same options as run]
tenant-leak-check --help | --version
```

- `doctor` checks Docker is reachable, the Supabase CLI version, free RAM against the measured need, and that the work folder is writable. It prints plain-English fixes for anything missing.
- `run` performs a full check of the project at `--project` (the folder that contains `supabase/`).
- `diff` is migration mode (section 9).
- Reports go to `--out` (default `./tlc-report/`): `report.json`, `report.md`, `report.html`.
- The stack is stopped at the end (`supabase stop --no-backup` for the sandbox) unless `--keep-running` is given.

### 4.2 Sandbox and stack

- Sandbox folder: `<workdir>/<slug>/` where `workdir` defaults to `./.tlc-work` (git-ignored) and `slug` comes from the target folder name plus a short hash of its absolute path.
- The generated `config.toml` sets `project_id = "tlc-<slug>"`, disables unneeded services, turns off `db.seed` (the target's seed file is never run), keeps email sign-up on with confirmations off, and uses a dedicated port block (API 55421, DB 55422, shadow 55420, other unused ports in 554xx) so it never collides with a developer's own stack on 543xx.
- Values copied from the target's `config.toml` when present: `api.schemas`, `api.extra_search_path`, `api.max_rows`, `db.major_version`, and `[storage.buckets.*]` (`public`, `file_size_limit`, `allowed_mime_types`; never `objects_path`). Any value written as `env(...)` is ignored and noted, because it refers to a secret.
- Only one stack runs at a time (the box has about 2 to 4 GB of free RAM). Before starting, the tool stops any other `tlc-*` stack it owns.
- Running a second target or the "after" half of migration mode reuses the running stack with `supabase db reset --local` when the generated config is identical, and restarts it when it differs.

### 4.3 Box-specific note: Docker networking

On the build box (a pod with no systemd and pre-existing legacy iptables rules), containers on the same Docker bridge could not reach each other until bridged traffic was taken out of iptables (`sysctl net.bridge.bridge-nf-call-iptables=0`, same for ip6tables). Symptom: `supabase start` fails at "Initialising schema" with a realtime `DBConnection.ConnectionError`. `doctor` reports this symptom and its fix in plain English. The setting does not survive a reboot, and `dockerd` has to be started by hand on this box (`sudo dockerd`).

## 5. Discovery

All discovery is plain SQL against the local database as the `postgres` superuser.

- **Exposed schemas**: the PostgREST schemas from the generated config (default `public`, `graphql_public`). Supabase-internal schemas are never treated as targets. `storage` is probed through the Storage API (section 7.3), not REST.
- **Relations** (`pg_class` kinds `r`, `p`, `v`, `m`, `f`) in exposed schemas, recording: RLS enabled, RLS forced, owner, whether the owner bypasses RLS, view `security_invoker` and `security_barrier` options, and table privileges for `anon` and `authenticated` (`has_table_privilege`, `has_column_privilege`).
- **Columns**: type (resolved through domains to the base type), nullability, default, identity or generated status, enum labels, array element type.
- **Constraints**: primary keys, unique keys, foreign keys (including references into `auth.users`), check constraints (expression text kept for value generation).
- **Policies** from `pg_policy`/`pg_policies`: command, roles, permissive or restrictive, `USING` and `WITH CHECK` expressions.
- **Triggers** on exposed tables (they can block or rewrite seeded rows).
- **Functions** in exposed schemas that `anon` or `authenticated` can execute: arguments, return type, `SECURITY DEFINER`, volatility and language. Excluded: trigger and event-trigger functions, functions that belong to extensions (`pg_depend` type `e`), aggregates, and `graphql_public.graphql`.
- **Storage**: `storage.buckets` (public flag, limits) and the policies on `storage.objects` and `storage.buckets`.

## 6. Tenancy model

For each exposed table the tool decides how a row belongs to a tenant, in this order:

1. **Config override** in `tenant-leak-check.json` (section 10). This always wins.
2. **Tenant column**: a column whose name is one of `tenant_id`, `org_id`, `organization_id`, `organisation_id`, `account_id`, `team_id`, `workspace_id`, `company_id`, `agency_id`, `store_id`, `shop_id`, `client_id`, or any foreign key to a table already identified as the tenant root. The referenced table is the **tenant root** (for example `organizations`).
3. **User column**: a foreign key to `auth.users(id)` (for example `user_id`, `owner_id`, `created_by`), or a primary key that is itself a foreign key to `auth.users(id)` (a `profiles`-style table). Name-only matches with no foreign key (`user_id uuid` without a constraint) are accepted with lower confidence, and the report says so.
4. **Inherited**: a foreign key path (up to 4 hops) to a table whose ownership is known, for example `invoice_lines.invoice_id -> invoices.org_id`. The shortest path wins. Ties prefer tenant over user ownership.
5. **Tenant root**: the tenant table itself. Its rows belong to the tenant whose id they hold.
6. **Membership table**: a table with a foreign key to `auth.users` and a foreign key to the tenant root (for example `org_members`). It is used to make each synthetic user a member of its own tenant, and is itself probed like any other tenant table.
7. **Shared**: no path found. Cross-tenant reading is not applicable (the table has no owner), so `select` is reported as `not_tested` with the reason "this table does not belong to any customer". Writes are still probed: if tenant A or anon can insert, change or delete shared rows that every tenant relies on, that is reported as a leak (one customer can change what other customers see).

When a table has both a tenant column and a user column, both are filled consistently: tenant B's rows hold tenant B's id and tenant B's user.

The detected model is printed in every report ("How we decided who owns each table"), so a reviewer can spot a wrong guess and correct it in config.

## 7. Seeding and probing

### 7.1 Synthetic world

- **Users**: created through the Auth admin API (`POST /auth/v1/admin/users`, `email_confirm: true`) so that `auth.users`, `auth.identities` and any sign-up triggers (such as `handle_new_user`) run exactly as in the app. Sessions come from the normal password sign-in (`/auth/v1/token?grant_type=password`). A run cannot start if tenant A cannot sign in. The report shows the Auth error and the run exits 2.
- **Tenants**: one tenant-root row per tenant, and one membership row linking each user to its own tenant (both only when a tenant root exists).
- **Rows**: two rows per tenant in every tenant-scoped table, inserted in foreign-key order. Row 1 is the read, update and RPC target. Row 2 is the delete target, so a successful delete does not spoil later probes.
- **Inserts run as the tenant**: each insert runs as `postgres`, but inside a transaction that sets `request.jwt.claims` to the tenant user's claims, so defaults such as `owner_id default auth.uid()` and triggers see the right user. If a trigger still blocks the insert, the tool retries once with `session_replication_role = replica` (triggers and foreign-key triggers off) and records this in the evidence ("seeded with triggers switched off").
- **Values** come from the column type and constraints: unique `tlc` marker strings for text (for example `tlc-B-invoices-1-k3f9q2`), random UUIDs, small positive numbers, today's date and time, `true`, the first enum label, `{}` for JSON and arrays, and foreign keys pointing at the same tenant's parent rows. For check constraints the generator reads simple shapes from the expression (`IN (...)`, `= ANY (ARRAY[...])`, `>`, `>=`, `<`, `<=`, `BETWEEN`, `length(...)`, `char_length(...)`) and picks a value that satisfies them. If an insert still fails, the Postgres error is kept as the reason and every probe on that table becomes `not_tested`: "could not create test data because: <error in plain words>".
- **Files**: in every bucket the tool uploads, with the service key, one canary file per tenant under the common folder conventions (`<user id>/tlc-canary.txt` and `<tenant id>/tlc-canary.txt`, or the configured path template).
- **Snapshot**: after seeding, the tool takes a snapshot of every seeded row (by primary key) and every seeded object. The snapshot is used for verification and to restore anything a probe changed.

### 7.2 Probe matrix for tables and views

Actors: **tenant A** (signed-in member of tenant A) and **anon** (only the anon key, no session). For anon, both tenants' rows count as "someone else's data".

| Operation | Attempt (REST through Kong) | Leak if (checked in the database) |
| --- | --- | --- |
| select | `GET /rest/v1/<t>?<pk>=eq.<B row>` and an unfiltered `GET` | Any response row carries a tenant-B marker (primary key, marker text or tenant id) |
| insert | `POST /rest/v1/<t>` with a new row whose tenant/user key is tenant B's, `Prefer: return=minimal` | The row exists afterwards |
| update | `PATCH /rest/v1/<t>?<pk>=eq.<B row>` changing one marker column | Tenant B's row changed |
| update (re-assign) | `PATCH` tenant A's own row to tenant B's tenant key | The row now belongs to tenant B (missing `WITH CHECK`) |
| delete | `DELETE /rest/v1/<t>?<pk>=eq.<B row 2>` | Tenant B's row is gone |

Rules that keep results honest:

- HTTP status codes are recorded as evidence but never decide the result on their own. PostgREST answers RLS-filtered updates and deletes with success and zero rows, and Storage answers RLS-denied reads with `400`, the same as "not found". The verdict always comes from the database check.
- A probe is `pass` only if tenant B's target existed immediately before the attempt (checked in the database) and was unchanged afterwards.
- A response blocked by a missing grant (`42501`) is a `pass`, with the note "blocked by permissions".
- **Positive control**: for each table the tool also reads tenant A's own row as tenant A. If A cannot see its own data in any table at all, the whole run is marked inconclusive ("the signed-in test user could not read anything, so the setup is probably wrong"). For a single table, the result is still a pass, with the note "tenant A cannot read its own rows here either".
- Rows are targeted by primary key. Tables without a primary key are targeted by a unique marker column. If neither exists, the probe is `inconclusive`.
- After each write probe, anything that changed is restored from the snapshot, so later probes start from a known state.
- Views: `select` is probed exactly like a table, using tenant B's markers from the underlying tables. Writes are probed only on views Postgres reports as updatable. Materialized views are probed for `select` only (they cannot have RLS).
- Requests have a 10-second timeout. `statement_timeout` is set to 5 seconds for `anon` and `authenticated` in the sandbox database.

### 7.3 Storage probes

For each bucket, as tenant A and as anon:

| Operation | Attempt | Leak if |
| --- | --- | --- |
| list | `POST /storage/v1/object/list/<bucket>` with tenant B's folder as prefix | Tenant B's canary appears |
| download | `GET /storage/v1/object/authenticated/<bucket>/<B path>`, and for public buckets also `/object/public/...` | The body equals tenant B's canary |
| upload | `POST /storage/v1/object/<bucket>/<B folder>/tlc-intruder.txt` | The object exists in `storage.objects` afterwards |
| overwrite | `PUT` to tenant B's canary path | The stored object changed (checked with the service key) |
| delete | `DELETE /storage/v1/object/<bucket>/<B path>` | The object is gone |

A public bucket is reported as a leak for anonymous download, because anyone with the link can fetch every customer's files, unless the config lists the bucket as intentionally public (for example product images). In that case the report shows `pass (allowed public)` and the reason.

### 7.4 RPC probes

For each function `anon` or `authenticated` can execute in an exposed schema:

- **Arguments** are filled by name and type: tenant-like names (`org_id`, `tenant_id` and the other names in section 6) get tenant B's id; user-like names get tenant B's user id; `id` or `<table>_id` get tenant B's row id in the matching table; other UUIDs get tenant B's tenant id; text gets a marker; numbers get 1; booleans get true; JSON gets `{}`. The config can supply exact arguments. A function whose arguments cannot be filled is `not_tested`, with the reason.
- **Call** `POST /rest/v1/rpc/<fn>` as tenant A and as anon.
- **Read leak**: the response contains any tenant-B marker.
- **Write leak**: the snapshot of tenant B's rows differs after the call (changed, deleted, or new rows carrying tenant B's key). The rows are then restored.
- An error response (for example "not allowed") is a `pass` if tenant B's data is unchanged. An unexpected server error (`5xx`) is `inconclusive`.
- `SECURITY DEFINER` functions callable by clients are listed in the report with a warning even when no leak was proven, because they run with the owner's rights and skip RLS.

### 7.5 Static rules (warnings, not leaks)

These come from the catalog and support the probes. They never turn a probe `pass` into a leak:

- RLS disabled on an exposed table that clients have grants on.
- Policies defined but RLS not enabled (the policies have no effect).
- A policy whose `USING` or `WITH CHECK` is literally `true`.
- A policy that does not mention `auth.uid()`, `auth.jwt()`, the tenant column or the membership table.
- An `UPDATE` or `INSERT` policy without a `WITH CHECK` where one is needed.
- A view without `security_invoker = true` whose owner bypasses RLS.
- A materialized view readable by `anon` or `authenticated`.
- A `SECURITY DEFINER` function executable by `anon` or `authenticated`.
- A public bucket.

## 8. Results, statuses and exit codes

Each check has a stable id such as `table:public.invoices:select:tenant_a`, `storage:documents:download:anon` or `rpc:public.get_invoices:execute:tenant_a`, so runs can be compared.

| Status | Meaning (as written in the reports) |
| --- | --- |
| `pass` | We tried it and it was blocked. Tenant B's data was there and untouched. |
| `leak` | We tried it and it worked. Evidence shows what we sent and what came back or changed. |
| `not_tested` | We could not run this test, and here is why (for example "could not create test data because a required column has a rule we could not satisfy", or "excluded in config: <reason>"). |
| `inconclusive` | We ran it, but the answer was unclear (for example a server error, or the row could not be targeted). |

Every leak carries:

- **Evidence**: actor, request method and path (keys and tokens never shown), the relevant part of the response, and the database check before and after.
- **Fix**: a plain-English explanation and an optional SQL snippet built from the detected tenancy model, for example:

```sql
alter table public.invoices enable row level security;
create policy "Members can read their organisation's invoices"
  on public.invoices for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
```

SQL snippets are labelled "starting point: review before applying".

**Exit codes** (precedence from highest: 3, 1, 4, 2, 0):

| Code | Meaning |
| --- | --- |
| 0 | No leaks, and every in-scope check was actually tested. `not_tested` checks that are not applicable by nature (shared-table reads) or excluded in config do not block 0. |
| 1 | At least one leak (in `diff`: at least one leak in the "after" run). |
| 2 | No leaks found, but at least one check was `inconclusive` or `not_tested` for a failure reason (seeding failed, setup problem). |
| 3 | Tool error: bad arguments or config, non-local URL refused, Docker or the Supabase CLI missing, stack failed to start, unexpected crash. |
| 4 | Migration mode only: no leaks, but the migration needs human review (destructive statements, a policy removed, RLS disabled or no longer forced, or the migration failed to apply on top of seeded data). |

## 9. Migration mode (`diff`)

1. **Baseline**: the project's migrations, excluding any file passed with `--migration` (matched by file name). Start or reset the stack, then discover, seed and probe. This gives the "before" result.
2. **Static scan** of each new migration. The scanner strips comments and string literals, splits statements, and flags: `DROP TABLE/VIEW/MATERIALIZED VIEW/FUNCTION/POLICY/SCHEMA/TRIGGER`, `TRUNCATE`, `ALTER TABLE ... DROP COLUMN`, `ALTER COLUMN ... TYPE`, `DELETE` or `UPDATE` without `WHERE`, `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL SECURITY`, `GRANT ... TO anon|public|authenticated`, `SECURITY DEFINER`, and policies with `USING (true)` or `WITH CHECK (true)`.
3. **Apply on top of seeded data** with `supabase migration up --local`. This catches migrations that only fail when rows exist (for example adding a `NOT NULL` column without a default). A failure is reported with the Postgres error and gives exit code 4.
4. **Catalog diff** of before and after: tables, columns, RLS enabled and forced flags, policies (added, removed, changed), grants to `anon` and `authenticated`, client-callable functions, `SECURITY DEFINER` changes, view options and buckets.
5. **After run**: `supabase db reset --local` with baseline plus the new migrations, then a fresh seed and probe. This gives the "after" result.
6. **Result diff** by check id: new leaks (pass to leak), fixed leaks (leak to pass), checks that stopped being testable, and checks for objects that appeared or disappeared.
7. **Report**: summary first ("this migration introduces 2 new leaks and drops 1 column"), then new leaks with evidence and fixes, then security-relevant catalog changes, destructive statements with line numbers, and finally the full before and after matrices.

## 10. Config file (optional)

`tenant-leak-check.json` in the target folder, or given with `--config`. JSON keeps the tool dependency-free. Unknown keys are an error (exit 3) with the path of the offending key, so typos are not silently ignored.

```json
{
  "tables": {
    "public.invoices": { "tenantColumn": "org_id" },
    "public.notes": { "userColumn": "author_id" },
    "public.invoice_lines": { "ownedVia": { "column": "invoice_id", "references": "public.invoices" } },
    "public.countries": { "shared": true },
    "public.audit_log": { "skip": "Written only by triggers; not client-facing." }
  },
  "tenantRoot": "public.organizations",
  "membership": { "table": "public.org_members", "userColumn": "user_id", "tenantColumn": "org_id", "values": { "role": "owner" } },
  "seed": { "values": { "public.invoices.status": "draft" } },
  "storage": { "allowPublic": ["product-images"], "pathTemplates": ["{tenant}/{file}", "{user}/{file}"] },
  "rpc": {
    "skip": { "public.send_email": "Has side effects outside the database." },
    "args": { "public.get_invoice": { "invoice_id": "{tenantB.row:public.invoices}" } }
  }
}
```

## 11. Reports

All three formats come from one in-memory result object.

- **JSON** (`report.json`): `schemaVersion` (semver, starting at `1.0.0`), `tool`, `disclaimer`, `generatedAt`, `target` (name, migrations fingerprint, CLI and Postgres versions), `scope` (schemas, counts), `tenancy` (the detected model), `summary` (verdict `clean`, `leaks_found` or `inconclusive`, counts by status, exit code), `checks[]`, `findings[]` (leaks with evidence and fix), `warnings[]` (static rules), `notTested[]`, `notCovered[]`, and in migration mode `migration` (statements, catalog diff, result diff). The schema is published as `docs/report.schema.json` (JSON Schema 2020-12) and explained in `docs/REPORT-FORMAT.md`. Breaking changes bump the major version.
- **Markdown** (`report.md`): the same content as the HTML report, readable in GitHub or a text editor.
- **HTML** (`report.html`): one self-contained file (inline CSS, no scripts, no external assets) that is safe to email and prints cleanly. Order: verdict banner and disclaimer; "What we tested"; a grid of each table against each operation and actor (pass, leak, not tested, inconclusive, using colour plus a text label, never colour alone); one card per leak with evidence and fix; warnings; "Not tested, and why"; "Not covered by this check"; the detected tenancy model; a glossary of RLS, policy, anon, tenant and RPC in one line each.
- **CLI output**: a short summary with counts, the verdict, where the reports are, the disclaimer, and the exit code meaning.
- Reports never contain keys, JWTs, passwords, or real data. Only schema names and synthetic values appear.

## 12. Demo apps and proof

- `demo/broken/`: a small multi-tenant "agency" app (organisations, members, projects, tasks, invoices, payments, notes, files) with **planted leaks** covering every category the tool claims to detect: RLS disabled; policies written but RLS never enabled; `USING (true)`; a policy that ignores the tenant (any member of any organisation); insert with another tenant's id (missing `WITH CHECK`); update across tenants; re-assigning a row to another tenant; delete across tenants; anon read; anon write; a public bucket; a storage read policy that ignores the folder; a storage write policy that ignores the folder; a `SECURITY DEFINER` RPC that reads another tenant's data; a `SECURITY DEFINER` RPC that deletes another tenant's data; a view that bypasses RLS; a materialized view exposed to clients; a child table owned only through its parent; and a shared table that clients can write.
- `demo/fixed/`: the same schema with every leak fixed the recommended way.
- `demo/leaks.json`: a machine-readable manifest. Each planted leak has an id (`L01`, `L02` and so on), a description, and the check ids that must report `leak`. `demo/LEAKS.md` is the human-readable version.
- `demo/migrations/bad/` and `demo/migrations/good/`: migrations on top of the fixed app. The bad one introduces a leak, disables RLS, drops a policy, drops a column and drops a table. The good one adds a new tenant table with correct RLS and policies.
- **Integration tests** (`npm run test:integration`, needs Docker): broken app gives exit 1 and every manifest leak is reported; fixed app gives exit 0 with zero leaks and zero failure-type `not_tested` or `inconclusive`; the bad migration gives exit 1 and flags each planted regression; the good migration gives exit 0.
- **Unit tests** (`npm test`, no Docker): URL guard, exit-code precedence, config validation, tenancy inference on fixture catalogs, value generation for check constraints, the migration SQL scanner, catalog and result diffs, and report rendering (including that the disclaimer is present and secrets are redacted).

## 13. Claude Code integration

The repo includes `.claude/commands/leak-check.md` and `.claude/skills/tenant-leak-check/SKILL.md`, so that saying "run the leak check on <project>" in Claude Code runs `doctor`, then `run` (or `diff` for a migration), then summarises the report in plain English with the disclaimer. Nothing is installed into `~/.claude`.

## 14. Build plan

| Session | Work |
| --- | --- |
| 1 | Install Docker and the Supabase CLI, verify the reduced stack, write this design, scaffold (CLI, `doctor`, URL guard, exit codes, disclaimer, unit tests), create the private repo, first push. |
| 2 | Sandbox and stack manager, discovery, tenancy model, seeding, the probe matrix (tables, views, storage, RPCs) for tenant A and anon, the broken and fixed demos with the leak manifest, unit and integration tests. |
| 3 | Migration mode, JSON, Markdown and HTML reports with the schema doc, exit codes wired end to end, the Claude Code command and skill. |
| 4 | A run against a real-world SaaS project (synthetic data only), README for non-coders, final tests. |
