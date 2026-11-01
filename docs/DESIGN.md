# tenant-leak-check: design

Status: design for v1, updated as built (November 2026). This document is the reference for the code. If the code and this document disagree, fix one of them in the same commit.

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
- **Supabase CLI 2.122+ and Docker Engine.** The stack runs with only the services the tool needs: Postgres, GoTrue (auth), PostgREST, Storage API and Kong. Studio, imgproxy, edge-runtime, logflare, vector, realtime, supavisor, mailpit and postgres-meta are switched off in the generated config and also excluded with `-x`. Measured on the build machine: the reduced stack uses about 390 MB of RAM.

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
| `src/commands/` | `doctor`, `run` (CLI summary), `diff` |
| `src/engine.ts` | One full run: sandbox, stack, discovery, seeding, probes, analysis, in that order; returns the result object every report is rendered from |
| `src/stack/` | Sandbox creation, generated `config.toml`, Supabase CLI wrapper, reading `status`, the `postgres` connection (`db.ts`) |
| `src/config/` | Loading and validating the optional `tenant-leak-check.json` |
| `src/discover/` | Catalog queries (tables, columns, constraints, policies, grants, functions, views, buckets) and the tenancy model |
| `src/seed/` | Synthetic users, tenants, rows and files; value generation; snapshot and restore |
| `src/probe/` | HTTP client and the probe matrix for tables and views, storage and RPCs |
| `src/analyze/` | Static rules (catalog-based warnings) and plain-English fix text with SQL snippets |
| `src/migrate/` | Migration SQL scanner, catalog diff, result diff, `runDiff` |
| `src/report/` | JSON (with schema), Markdown and HTML renderers |
| `demo/` | Deliberately broken app, fixed app, leak manifest, demo migrations |
| `test/unit/`, `test/integration/` | Unit tests (no Docker) and integration tests (real local stack) |
| `.claude/`, `integrations/claude-code/` | Claude Code command and skill ("run the leak check") |

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
- Only one stack runs at a time, to keep memory use low on small machines. Before starting, the tool stops any other `tlc-*` stack it owns.
- Running a second target or the "after" half of migration mode reuses the running stack with `supabase db reset --local` when the generated config is identical, and restarts it when it differs.

### 4.3 Host note: Docker networking

On some Linux hosts (seen on a container host with no systemd and pre-existing legacy iptables rules), containers on the same Docker bridge cannot reach each other until bridged traffic is taken out of iptables (`sysctl net.bridge.bridge-nf-call-iptables=0`, same for ip6tables). Symptom: `supabase start` fails at "Initialising schema" with a realtime `DBConnection.ConnectionError`. `doctor` reports this symptom and its fix in plain English. The setting does not survive a reboot. On hosts without systemd, `dockerd` may also need to be started by hand (`sudo dockerd`).

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
- **Rows the app creates itself**: before inserting, the tool looks for rows that already belong to the tenant (for example a `profiles` row made by a sign-up trigger, or a membership made by a trigger on the tenant table) and reuses them. Tables where a second row per tenant cannot exist (the tenant table, the membership table, tables keyed by the user's id) get one row per tenant.
- **Fallbacks**: each row is tried with every fillable column first, then with only the required columns, each first with triggers on and then off. Values given in `seed.values` in the config always win.
- **Materialized views** are refreshed after seeding, so they contain the test data (otherwise they would be empty and look safe).
- **Markers**: a value counts as tenant B's only if it is distinctive (a UUID or a `tlc` marker) and appears in none of tenant A's rows and no shared row, so a shared reference (such as a plan code both tenants use) can never be mistaken for a leak.
- **Snapshot**: after seeding, the tool takes a snapshot of every row in every probed table (by primary key, or by the whole row without one) and every seeded object. The snapshot is used for verification and to restore anything a probe changed. Restores run with triggers and foreign-key actions off, so rows removed by cascades come back exactly, and the tool checks that the restore matched the snapshot before the next probe.

CHECK constraints the value generator reads: `col IN (...)`, `col = ANY (ARRAY[...])`, a constraint that is exactly `col = 'literal'`, numeric bounds, and text-length bounds. Constraints that tie several columns together (for example `after = before + amount`) need `seed.values` in the config.

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
- The re-assign probe is run as tenant A only (an anonymous visitor owns no rows). It is not applicable to the tenant table and to shared tables.
- In insert probes on tenant tables, links to `auth.users` that are not the owner key carry tenant A's own user id (the attacker's best chance: a policy that only checks `user_id = auth.uid()` lets such a row into tenant B's data). On user-owned tables the owner column carries tenant B's user.
- What Postgres really does decides the result, not what a policy seems to say. Two behaviours matter, and the demo app shows both: `UPDATE` and `DELETE` only reach rows that the caller's `SELECT` policies also show, and PostgREST's `UPDATE` returns the new row, so the new row must pass the `SELECT` policy too. A `WITH CHECK (true)` therefore only leaks where the read policy is also open.
- Writes through views: a view Postgres can write through (one table, no joins or grouping) is probed on that table's rows, with only the columns the view shows. Views Postgres cannot write through, and materialized views, get `not_tested` (not applicable) for writes.

### 7.3 Storage probes

For each bucket, as tenant A and as anon:

| Operation | Attempt | Leak if |
| --- | --- | --- |
| list | `POST /storage/v1/object/list/<bucket>` with tenant B's folder as prefix | Tenant B's canary appears |
| download | `GET /storage/v1/object/authenticated/<bucket>/<B path>`, and for public buckets also `/object/public/...` | The body equals tenant B's canary |
| upload | `POST /storage/v1/object/<bucket>/<B folder>/tlc-intruder.txt` | The object exists in `storage.objects` afterwards |
| overwrite | `PUT` to tenant B's canary path | The stored object changed (checked with the service key) |
| delete | `DELETE /storage/v1/object/<bucket>/<B path>` | The object is gone |

A public bucket is reported as a leak for anonymous download, because anyone with the link can fetch every customer's files, unless the config lists the bucket as intentionally public (for example product images). In that case the report shows `pass (allowed public)` and the reason. Measured on Storage in CLI 2.122: a public bucket also serves every file on the `/object/authenticated/` endpoint without checking policies, so tenant A's download is a leak as well.

The Storage API answers blocked requests with `4xx` codes that look like "not found" or "unauthorized". These are recorded as notes; the verdict comes from `storage.objects` (and, for downloads, from whether the exact canary content came back). Only `5xx` answers and timeouts make a storage check inconclusive.

### 7.4 RPC probes

For each function `anon` or `authenticated` can execute in an exposed schema:

- **Arguments** are filled by name and type, after removing the common prefixes `p_`, `in_`, `arg_`, `v_` and `_`: tenant-like names (`org_id`, `tenant_id` and the other names in section 6) get tenant B's id; user-like names get tenant B's user id; `id` or `<table>_id` get tenant B's row id in the matching table; other UUIDs get tenant B's tenant id; text gets a marker; numbers get 1; booleans get true; JSON gets `{}`. The config can supply exact arguments. A function whose arguments cannot be filled is `not_tested`, with the reason.
- **Call** `POST /rest/v1/rpc/<fn>` as tenant A and as anon.
- **Read leak**: the response contains any tenant-B marker.
- **Write leak**: the snapshot of tenant B's rows differs after the call (changed, deleted, or new rows carrying tenant B's key). The rows are then restored.
- An error response (for example "not allowed") is a `pass` if tenant B's data is unchanged. An unexpected server error (`5xx`), or a PostgREST error that means the function was never run (`PGRST...` codes), is `inconclusive`. An error the function raised itself (`P0001` raise_exception, or `P0002` no_data_found such as "not found on this account") is the function refusing and counts as a `pass` with the same proviso, even though PostgREST answers `P0002` with HTTP 500; `P0003` (too many rows) and `P0004` (failed assert) are crashes and stay `inconclusive`. Error answers are searched for tenant-B markers too, so an error message that quotes another tenant's data is a read leak.
- Values the tool itself passed as arguments do not count as read leaks when they come back, so a function that echoes its input is not reported. For the anonymous visitor, both tenants' data counts.
- A function name shared by several functions (overloads) is `not_tested` unless the config gives its arguments, because the tool cannot tell which one the API would run. A function whose arguments have no names cannot be called through the API at all (unless it takes a single JSON, text or bytea value) and is `not_tested` as not applicable.
- `SECURITY DEFINER` functions callable by clients are listed in the report with a warning even when no leak was proven, because they run with the owner's rights and skip RLS.

### 7.5 Static rules (warnings, not leaks)

These come from the catalog and support the probes. They never turn a probe `pass` into a leak. Each has a stable rule id:

- `rls_disabled`: RLS disabled on an exposed table that clients have grants on.
- `policies_without_rls`: policies defined but RLS not enabled (the policies have no effect).
- `policy_always_true`: a client policy whose `USING` or `WITH CHECK` is literally `true` (also on `storage.objects`). Reading a shared table with `USING (true)` is normal and not flagged.
- `policy_ignores_owner`: a client policy on an owned table that does not look at the owner column (the tenant column or a user column; for child tables, the link to the parent). This catches "any member of any organisation" policies that do check `auth.uid()`.
- `update_without_with_check`: an `UPDATE` (or `ALL`) policy without an explicit `WITH CHECK`, so Postgres reuses `USING` for the new row.
- The three policy rules above look at permissive policies only. A `RESTRICTIVE` policy is ANDed with the others and can only take rows away (an app-wide "owner-only" switch is a typical example), so it never needs to mention the owner.
- `view_bypasses_rls`: a client-readable view without `security_invoker = true` whose owner bypasses RLS.
- `materialized_view_exposed`: a materialized view readable by `anon` or `authenticated`.
- `security_definer_callable`: a `SECURITY DEFINER` function executable by `anon` or `authenticated`.
- `public_bucket`: a public bucket (with a note when the config marks it as intended).

## 8. Results, statuses and exit codes

Each check has a stable id `kind:object:operation:actor`, such as `table:public.invoices:select:tenant_a`, `view:public.client_directory:select:anon`, `storage:documents:download:anon` or `rpc:public.get_invoices:execute:tenant_a`, so runs can be compared. Kinds: `table`, `view` (views and materialized views), `storage`, `rpc`. Operations: `select`, `insert`, `update`, `update_reassign`, `delete` for tables and views; `list`, `download`, `upload`, `overwrite`, `delete` for storage; `execute` for functions. Actors: `tenant_a`, `anon`.

A `not_tested` check also carries its kind of reason: `not_applicable` (nothing to test by nature, for example reading a shared table), `excluded` (switched off in the config) or `could_not_test` (the tool tried and failed, for example seeding). Only `could_not_test` and `inconclusive` stop a clean result.

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
| 2 | No leaks found, but at least one check was `inconclusive` or `not_tested` for a failure reason (seeding failed, setup problem), or the run itself is unreliable: the test users could not be created or signed in (for example a sign-up trigger in the migrations fails), no table belongs to a tenant or user, or tenant A could not read its own rows anywhere. |
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

### 9.1 As built

- Code: `src/migrate/scan.ts` (scanner), `catalog-diff.ts`, `result-diff.ts` and `diff.ts` (`runDiff`, review items, headline, exit code). `runDiff` reuses `checkSandbox` from `src/engine.ts` for both runs, so "before" and "after" are tested exactly like `run`.
- New migrations must sort after every existing migration (the CLI applies files in name order); otherwise the tool stops with exit 3 and asks for a later timestamp.
- **Severities.** Each scanner finding and catalog change is `destructive` (data or objects lost), `security` (an access rule weakened), `attention` (worth a look, common in healthy migrations) or `info`. Only `destructive` and `security` become review items (exit 4 when there is no leak). `attention` covers `SECURITY DEFINER` functions (the probes test them anyway), grants to `authenticated`, `GRANT USAGE ON SCHEMA`, `DO` blocks (their contents cannot be scanned), new policies being changed, and a view, function, policy or trigger that is dropped and created again later in the same migrations (a replacement). A dropped and re-created **table** stays destructive: its rows do not come back.
- The scanner blanks comments, string literals and dollar-quoted bodies (so statements inside function bodies are not flagged), keeps the case of quoted identifiers, and qualifies unqualified names with `public`.
- **Review items are de-duplicated**: a fact found both by the scanner and by the catalog diff (for example `DROP TABLE` and "table removed") is listed once, from the scanner, because it has a file and line.
- Catalog-only review items: a new table with RLS off that clients can use, a view that loses `security_invoker`, a bucket made public or removed. Policies of removed tables are not listed separately.
- **Apply outcomes.** If `migration up` fails on the seeded data, the "after" run still happens on a fresh database, and the failure is a review item ("fails on a database that already holds data"). If the migration cannot be applied even to a fresh database, there is no "after" run: no checks, a run problem, review item `fails_to_apply`, exit 4. The Postgres error is reduced to one line: the error plus the failing statement.
- **Exit code** = `combineExitCodes([after run's code, 4 if any review item])`. Verdict `review_needed` exists only in migration mode.

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

Two settings for projects whose history is not a clean `supabase/migrations` folder, or whose words differ from the usual model:

```json
{
  "tenantRoot": null,
  "build": {
    "files": [
      { "path": "../app/supabase/schema.sql", "version": "20240101000000" },
      { "path": "../app/supabase/migrations/add_feature.sql", "version": "20240301000001" },
      { "path": "../app/supabase/migrations/20240401000000_second.sql", "version": "20240401000001" }
    ]
  }
}
```

- `tenantRoot: null` says the app has no separate tenant table: each signed-in user is one customer (for example a landlord). Tenant-table detection is switched off, and a column merely *named* `tenant_id` is no longer treated as a tenant key (in a landlord app it points at a renter). Ownership then comes from user links: foreign keys to `auth.users`, or inherited through a profile table whose key is the user's id.
- `build.files` adds SQL files the Supabase CLI would skip (a base `schema.sql`, migrations without a timestamp) to the sandbox, each copied as `<version>_<name>.sql` so it runs at that point in the order. Listing one of the project's own migrations gives it a new version instead (the fix for two migrations sharing a version, which the CLI cannot apply; the tool now names both files up front instead of failing deep inside `supabase start`). Paths are relative to the config file's folder; only `.sql` files are accepted; the target folder is still only read. Each added file is listed in the report's scope notes.

Placeholders accepted in `rpc.args`, `seed.values` and `membership.values`: `{tenantA.tenant}`, `{tenantB.tenant}` (the tenant's id), `{tenantA.user}`, `{tenantB.user}` (the test user's id) and `{tenantA.row:schema.table}`, `{tenantB.row:schema.table}` (the primary key of that tenant's first test row in the table). `storage.pathTemplates` accepts `{tenant}`, `{user}` and `{file}`.

## 11. Reports

All three formats come from one in-memory result object.

- **JSON** (`report.json`): `schemaVersion` (semver, starting at `1.0.0`), `tool`, `disclaimer`, `generatedAt`, `target` (name, migrations fingerprint, CLI and Postgres versions), `scope` (schemas, counts), `tenancy` (the detected model), `summary` (verdict `clean`, `leaks_found` or `inconclusive`, counts by status, exit code), `checks[]`, `findings[]` (leaks with evidence and fix), `warnings[]` (static rules), `notTested[]`, `notCovered[]`, and in migration mode `migration` (statements, catalog diff, result diff). The schema is published as `docs/report.schema.json` (JSON Schema 2020-12) and explained in `docs/REPORT-FORMAT.md`. Breaking changes bump the major version.
- **Markdown** (`report.md`): the same content as the HTML report, readable in GitHub or a text editor.
- **HTML** (`report.html`): one self-contained file (inline CSS, no scripts, no external assets) that is safe to email and prints cleanly. Order: verdict banner and disclaimer; "What we tested"; a grid of each table against each operation and actor (pass, leak, not tested, inconclusive, using colour plus a text label, never colour alone); one card per leak with evidence and fix; warnings; "Not tested, and why"; "Not covered by this check"; the detected tenancy model; a glossary of RLS, policy, anon, tenant and RPC in one line each.
- **CLI output**: a short summary with counts, the verdict, where the reports are, the disclaimer, and the exit code meaning.
- Reports never contain keys, JWTs, passwords, or real data. Only schema names and synthetic values appear.

As built: renderers live in `src/report/` (`text.ts` shared wording, grids and labels; `json.ts`, `markdown.ts`, `html.ts`; `write.ts`). `writeReports` redacts every string of the result before rendering and every rendered file again after it, because escaping (JSON `\"`, HTML `&quot;`) can hide a secret from a single text pass. The summary verdict also has `review_needed` (migration mode), and the JSON adds `mode`, `summary.exitMeaning` and `migration.before`. The HTML carries a Content-Security-Policy meta tag that allows inline styles only. Markdown escapes database-provided text so it cannot add links, HTML or table columns. In the fix SQL, a `FOR ALL` policy is never dropped (that would remove its rules for the other operations); it is named in a comment instead. Writing to `--out` happens only after a successful run; on exit code 3 no report is written.

## 12. Demo apps and proof

- `demo/broken/`: a small multi-tenant "agency" app (organisations, members, projects, tasks, invoices, payments, notes, files) with **planted leaks** covering every category the tool claims to detect: RLS disabled; policies written but RLS never enabled; `USING (true)`; a policy that ignores the tenant (any member of any organisation); insert with another tenant's id (missing `WITH CHECK`); update across tenants; re-assigning a row to another tenant; delete across tenants; anon read; anon write; a public bucket; a storage read policy that ignores the folder; a storage write policy that ignores the folder; a `SECURITY DEFINER` RPC that reads another tenant's data; a `SECURITY DEFINER` RPC that deletes another tenant's data; a view that bypasses RLS; a materialized view exposed to clients; a child table owned only through its parent; and a shared table that clients can write.
- `demo/fixed/`: the same schema with every leak fixed the recommended way.
- `demo/leaks.json`: a machine-readable manifest. Each planted leak has an id (`L01` to `L19`), a category, a description, the check ids that must report `leak` (48 in all) and the schema warnings it must raise (22 in all). `demo/LEAKS.md` is the human-readable version. The integration tests compare both lists exactly, in both directions: nothing missed on the broken app, nothing extra reported, and on the fixed app every one of the 48 checks ran and passed.
- `demo/migrations/bad/`, `good/` and `review/`: migrations on top of the fixed app, with `demo/migrations/expected.json` listing exactly what must be reported. The bad one adds a `USING (true)` policy (new leak), disables RLS (nine new leaks), drops a policy, drops a column, drops a table and truncates a table: exit 1. The good one adds a new tenant table with correct RLS and policies plus a column with a default: exit 0. The review one drops a column and adds a required column without a default (fails on seeded data only): exit 4.
- **Integration tests** (`npm run test:integration`, needs Docker): broken app gives exit 1 and every manifest leak is reported; fixed app gives exit 0 with zero leaks and zero failure-type `not_tested` or `inconclusive`; each demo migration gives its expected exit code, new leaks, statements (with lines), review items, catalog changes and added/removed checks, compared exactly; a migration that cannot be applied at all gives exit 4; the CLI writes reports that validate against `docs/report.schema.json`.
- **Unit tests** (`npm test`, no Docker): URL guard, exit-code precedence, config validation, tenancy inference on fixture catalogs, value generation for check constraints, the migration SQL scanner, catalog and result diffs, and report rendering (including that the disclaimer is present and secrets are redacted).

## 13. Claude Code integration

The repo includes `.claude/commands/leak-check.md` and `.claude/skills/tenant-leak-check/SKILL.md`, so that saying "run the leak check on <project>" in Claude Code runs `doctor`, then `run` (or `diff` for a migration), then summarises the report in plain English with the disclaimer. Nothing is installed into `~/.claude`.

As built: the source of both files is `integrations/claude-code/`. Copying them into `.claude/` is a one-line step for the user (`integrations/claude-code/README.md`). The unit tests check that both files only name real CLI commands and options, explain every exit code, keep the safety rules and the disclaimer, and that any `.claude/` copy is identical to the source.

## 14. Build plan

| Stage | Work |
| --- | --- |
| 1 | Install Docker and the Supabase CLI, verify the reduced stack, write this design, scaffold (CLI, `doctor`, URL guard, exit codes, disclaimer, unit tests). |
| 2 | Sandbox and stack manager, discovery, tenancy model, seeding, the probe matrix (tables, views, storage, RPCs) for tenant A and anon, the broken and fixed demos with the leak manifest, unit and integration tests. |
| 3 | Migration mode, JSON, Markdown and HTML reports with the schema doc, exit codes wired end to end, the Claude Code command and skill. |
| 4 | A run against a real-world SaaS project (synthetic data only), README for non-coders, final tests. |

### 14.1 What a real-world project taught

A real product's history is messier than the demos, and each lesson became a generic feature or fix rather than a special case for one project:

- **History not in CLI form.** A base schema kept in `supabase/schema.sql` outside the migrations folder, migrations without a timestamp, and two migrations sharing a version mean `supabase db reset` cannot rebuild the database. Added `build.files` (section 10) and an up-front duplicate-version check that names both files.
- **"Tenant" means renter.** In a property-management app, auto-detection picked `public.tenants` (renters) as the customer table and produced false leaks. Added `tenantRoot: null` (section 10): each signed-in user (landlord) is one customer, and a column merely named `tenant_id` is not a tenant key.
- **Restrictive policies.** An app-wide switch written as a `RESTRICTIVE` policy on every table made the policy rules flag every table. The rules now skip restrictive policies (section 7.5).
- **Refusals raised as P0002.** PostgREST answers `P0002` with HTTP 500, which made deliberate refusals look like crashes. `P0001` and `P0002` now count as the function refusing; error answers are also searched for leaked data (section 7.4).
- **CHECKs that are exactly `col = 'literal'`** are now read by the value generator (section 7.1).
- A review of these changes found five issues, all fixed with tests: a re-versioned migration under test in migration mode, `P0003`/`P0004` counted as refusals and error bodies not scanned, equality read inside larger CHECK expressions, `.SQL` accepted, and a misleading path in the duplicate-version hint.
