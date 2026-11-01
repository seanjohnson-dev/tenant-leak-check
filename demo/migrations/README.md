# Demo migrations for migration mode

Each folder holds one new migration to test **on top of `demo/fixed`** with:

```sh
node src/cli.ts diff --project demo/fixed --migration demo/migrations/<folder>/<file>.sql
```

What the tool must report for each is listed exactly in [`expected.json`](expected.json); the integration tests (`npm run test:integration`) check it. All data is synthetic.

| Folder | What the migration does | Expected result |
| --- | --- | --- |
| `bad/` | Looks like housekeeping, but plants one regression of each kind: R1 a policy `USING (true)` that opens every organisation's clients (a new leak), R2 row level security switched off on expenses (nine new leaks), R3 a read policy dropped, R4 a column dropped, R5 a table dropped, R6 a table emptied with `TRUNCATE`. | Exit **1**: 10 new leaks, each with evidence and a fix, and six review items with their line numbers. |
| `good/` | Adds a time-tracking table with row level security and one membership policy per operation, plus a new required column with a default. | Exit **0**: no new leaks, nothing to review, and the new table's nine checks all ran and passed. |
| `review/` | V1 drops a column; V2 adds a required column without a default, which works on an empty database but fails on one that already holds rows. | Exit **4**: no leaks, but two review items: the dropped column and the failure on existing data. |

Migration mode also flags `DROP VIEW/FUNCTION/SCHEMA/TRIGGER`, `ALTER COLUMN ... TYPE`, `DELETE` or `UPDATE` without `WHERE`, `NO FORCE ROW LEVEL SECURITY`, grants to `anon`, `SECURITY DEFINER` functions, public buckets and views that lose `security_invoker`. The unit tests cover each of those.
