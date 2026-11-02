# Report format

Every `run` and `diff` writes three files into the `--out` folder (default `./tlc-report/`):

| File | For whom | What it is |
| --- | --- | --- |
| `report.html` | Clients and anyone non-technical | One self-contained page: inline styles, no scripts, no external files. Safe to email, opens in any browser, prints cleanly. |
| `report.md` | Developers, GitHub, pull requests | The same content as the HTML report, in Markdown. |
| `report.json` | Machines (CI, dashboards, later tooling) | The full result in a stable, versioned format, described below and in [`report.schema.json`](report.schema.json) (JSON Schema 2020-12). |

All three come from the same in-memory result, so they never disagree. None of them contains keys, tokens, passwords or real data: evidence is redacted when it is recorded, and every file is redacted again just before it is written. Only schema names and synthetic test values appear.

Every report says, in full: **this is an automated tenant-isolation test, not a security certification, audit or penetration test** (the JSON carries it in `disclaimer`).

## Exit codes

The process exit code tells CI what happened without reading any file. It is also in `summary.exitCode`, with its meaning in `summary.exitMeaning`.

| Code | Meaning | Verdict (`summary.verdict`) |
| --- | --- | --- |
| 0 | No leaks found, and every in-scope check was actually tested. Checks that are "not applicable" by nature (for example reading a table that belongs to no customer) or excluded in the config do not block 0. | `clean` |
| 1 | At least one leak: tenant A (or an anonymous visitor) reached tenant B's data. In `diff`: at least one leak after the migration. | `leaks_found` |
| 2 | No leaks found, but some checks could not be completed (`inconclusive`, or `not_tested` because something failed), or the run itself is unreliable (for example the test users could not sign in, or tenant A could not read its own rows anywhere). Not a clean result. | `inconclusive` |
| 3 | The tool could not run: bad arguments or config, a non-local URL refused, Docker or the Supabase CLI missing, the stack failed to start, or the project's existing migrations fail. No report is written. | (none) |
| 4 | `diff` only: no leaks after the migration, but it needs a human review (destructive statements, a policy removed, row level security switched off or no longer forced, or the migration fails on a database that holds data). | `review_needed` |

When several apply, the highest-priority code wins: 3, then 1, then 4, then 2, then 0. A migration that adds a leak *and* drops a column exits with 1; the review items are still listed in the report.

## Reading the HTML and Markdown reports

1. **Verdict banner**: one line saying whether anything leaked, with the counts.
2. **Please read**: what the check proves and what it does not.
3. **What this migration changes** (`diff` only): a one-paragraph summary, everything that needs a human review (with file and line), new leaks, fixed leaks, every flagged statement, and the changes to the database structure.
4. **What we tested**: the project, the scope (tables, views, buckets, functions), who we acted as, the test data, and any problem with the run.
5. **Results**: one grid per kind of object. Each cell is one attempt by one actor, labelled in words (never colour alone):
   - **Pass**: we tried it and it was blocked; tenant B's data was there and untouched.
   - **LEAK**: we tried it and it worked.
   - **Not tested**: we could not run it (the reason is listed); this stops the result from being clean.
   - **Unclear**: we ran it but the answer was unclear (for example a server error); also stops a clean result. For database functions this includes a failed control call (reason "Control call failed: ...") and an input refusal (reason "Refused the input, not the tenant: ..."); neither is ever a Pass.
   - **n/a / Skipped**: nothing to test by nature, or switched off in the config.
6. **Leaks found**: one card per leak with what we sent, what the database held before, what came back or changed, the problem in plain English, the fix, and an SQL starting point (always labelled "review before applying").
7. **Warnings from the schema review**: rules that look risky when reading the structure. They are not proven leaks.
8. **Not tested, and why**: every gap, failures first.
9. **Not covered by this check**: what the tool never looks at.
10. **How we decided who owns each table**: the detected tenancy model. If a guess is wrong, correct it in `tenant-leak-check.json` and run again.
11. **Before the migration** (`diff` only): the grids from the run before the migration, for comparison.
12. **Glossary**.

## The JSON report

`schemaVersion` follows semantic versioning. Adding optional fields bumps the minor version (`1.1.0`); removing or renaming a field, or changing its meaning, bumps the major version. Readers should check that the major version is `1`.

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | `1.0.0` for this format. |
| `mode` | `"run"` or `"diff"` | `diff` reports also carry `migration`. |
| `tool` | object | `name` (`tenant-leak-check`) and `version`. |
| `disclaimer` | string | The full "not a security certification" text. Always present. |
| `generatedAt` | string | ISO 8601 time in UTC. |
| `target` | object | `name` (folder name), `projectDir`, `migrations` (file names applied, in order), `fingerprint` (SHA-256 of the generated config and every migration; equal fingerprints mean the same database), `postgresVersion`. In `diff`, this describes the database *after* the migration. |
| `scope` | object | Names of what was in scope: `schemas`, `tables`, `views` (including materialized views), `functions` (callable by clients), `buckets`, `extensionObjects` (left alone), and `notes` (for example config values that were ignored). |
| `tenancy` | object | The detected ownership model: `tenantRoot`, `membership` (`table`, `userColumn`, `tenantColumn`), `tables[]` (see below) and `notes`. |
| `seeding` | object | Test data created: `tables[]` (`table`, `rows`, optional `failure`, `notes`), `buckets[]` (`bucket`, `files`, optional `failure`) and `notes`. |
| `summary` | object | See "Summary". |
| `checks` | array | Every attempt, see "Checks". |
| `findings` | array | One per leak: `checkId`, `title`, `problem`, `fix`, optional `sql` (always starts with `-- Starting point: review before applying.`). |
| `warnings` | array | Static schema warnings: `rule`, `object`, `message`. Rules: `rls_disabled`, `policies_without_rls`, `policy_always_true`, `policy_ignores_owner`, `update_without_with_check`, `view_bypasses_rls`, `materialized_view_exposed`, `security_definer_callable`, `public_bucket`. |
| `positiveControls` | array | `table`, `ownRowVisible`: whether tenant A could read its own row in each table (proves the setup works). |
| `notTested` | array | Every check that is `not_tested` or `inconclusive`: `checkId`, `status`, `kind` (for `not_tested`), `reason`. Failures first. |
| `notCovered` | array of strings | What this tool never tests. |
| `migration` | object | `diff` only, see "Migration". |

### Summary

| Field | Meaning |
| --- | --- |
| `verdict` | `clean`, `leaks_found`, `inconclusive` or `review_needed` (`diff` only). |
| `exitCode`, `exitMeaning` | The process exit code and its plain-English meaning. |
| `total`, `counts` | Number of checks, and how many are `pass`, `leak`, `not_tested`, `inconclusive`. |
| `failuresToTest` | Checks that could not be completed for a failure reason (they block exit 0). |
| `runProblems` | Problems that make the whole run unreliable, in plain English. |

### Checks

Each check is one actor attempting one operation on one object.

| Field | Meaning |
| --- | --- |
| `id` | Stable id `kind:object:operation:actor`, for example `table:public.invoices:select:tenant_a`. The same check has the same id in every run, which is how `diff` compares runs. |
| `kind` | `table`, `view` (views and materialized views), `storage` (a bucket) or `rpc` (a database function). |
| `target` | `schema.table`, a bucket id, or `schema.function`. |
| `operation` | Tables and views: `select`, `insert`, `update`, `update_reassign` (moving one's own row into another tenant), `delete`. Storage: `list`, `download`, `upload`, `overwrite`, `delete`. Functions: `execute`. |
| `actor` | `tenant_a` (a signed-in member of tenant A acting on tenant B's data) or `anon` (not signed in, acting on either tenant's data). |
| `status` | `pass`, `leak`, `not_tested` or `inconclusive`. |
| `reason` | Why a check is `not_tested` or `inconclusive`. |
| `notTestedKind` | `not_applicable` (nothing to test by nature), `excluded` (switched off in the config) or `could_not_test` (the tool tried and failed; blocks a clean result). |
| `notes` | Extra remarks, for example "blocked by permissions". |
| `evidence` | `actor`, `requests[]` (`method`, `path`, optional synthetic `body`, `status`, a redacted `response` excerpt), `before` (what the database held right before), `after` (what came back or changed), `summary` (one sentence). Present on every leak and on most passes. For `rpc` checks, `requests[0]` is the control call made by tenant B (the owner of the data) and `requests[1]`, if present, is the attempt; a failed control has only the control call. |

### Tenancy entries

`tenancy.tables[]` has `table`, `membership` (true for the table that links users to tenants), `explanation` (plain English), and `ownership` with a `kind` plus fields that depend on it:

| `ownership.kind` | Extra fields |
| --- | --- |
| `tenant_root` | `keyColumn` |
| `tenant` | `tenantColumn`, `userColumns`, `source` (`config`, `foreign_key` or `name`) |
| `user` | `userColumn`, `source` (`config`, `foreign_key`, `primary_key` or `name`) |
| `inherited` | `columns`, `parent`, `parentColumns`, `path`, `source` |
| `shared` | `source` (`config` or `detected`) |
| `skipped` | `reason` |

### Migration

Present when `mode` is `diff`. The top-level `checks`, `findings`, `warnings` and `summary` describe the database **after** the migration; `migration.before` holds the run before it.

| Field | Meaning |
| --- | --- |
| `files` | The new migration files, in the order they were applied. |
| `baseline` | The project's existing migrations that made up the "before" database. |
| `apply.onSeededData` | `ok`, and `error` if the migration failed when applied on top of the seeded test data (as it would on a live database). |
| `apply.onFreshDatabase` | `ok`, and `error` if the migration could not be applied even to an empty database. Then there is no "after" run: `checks` is empty and the exit code is 4. |
| `statements[]` | What the static scan found in the migration text: `file`, `line`, `rule`, `severity`, `object`, `message`, `statement` (one line, at most 200 characters). Rules: `drop_table`, `drop_view`, `drop_function`, `drop_policy`, `drop_schema`, `drop_trigger`, `truncate`, `drop_column`, `alter_column_type`, `delete_without_where`, `update_without_where`, `disable_rls`, `no_force_rls`, `grant_to_clients`, `security_definer`, `policy_always_true`, `do_block`. Severities: `destructive` and `security` need a review; `attention` is worth a look but common in healthy migrations (for example a view that is dropped and re-created). |
| `catalogChanges[]` | Differences in the database structure: `kind`, `severity` (`destructive`, `security`, `attention` or `info`), `object`, `message`, optional `before` and `after`. Kinds cover tables and views added or removed, columns added, removed or retyped, row level security switched on or off and forced or not, policies added, removed or changed, grants to `anon` and `authenticated`, client-callable functions and their `SECURITY DEFINER` setting, `security_invoker` on views, and buckets added, removed, made public or private. |
| `results` | Check ids that moved: `newLeaks`, `fixedLeaks`, `stillLeaking`, `noLongerTested`, `added` (new objects), `removed` (objects that are gone). Each entry has `id` and the `before` and `after` status where they exist. |
| `review[]` | Every reason a person must review the migration (exit code 4 when there is no leak): `topic`, `source` (`statement`, `catalog` or `apply`), `message`, and `file`/`line` for statements. A fact found by both the scan and the catalog diff is listed once. |
| `headline` | The one-paragraph summary shown at the top of every report. |
| `before` | `summary` and `checks` of the run before the migration. |

### Compatibility promise

Within major version 1: fields listed here keep their name, type and meaning; enum values are only added, never removed or renamed; new optional fields may appear. A reader that ignores unknown fields and unknown enum values keeps working.
