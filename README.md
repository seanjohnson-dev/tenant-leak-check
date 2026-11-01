# tenant-leak-check

Checks whether one customer of a Supabase app can see or change another customer's data.

It builds a throwaway copy of your project **on your own machine**, from your migrations, fills it with made-up customers and data, and then really tries to reach customer B's rows, files and functions while signed in as customer A, and again as an anonymous visitor. It reports what got through, with evidence and a suggested fix.

> **Not a certification.** This is an automated tenant-isolation test, not a security certification, audit or penetration test. It only covers what its report lists as tested.

## Status

Build in progress (v0.1.0). What works today:

- `tenant-leak-check doctor` checks that Docker, the Supabase CLI and enough free memory are in place, and explains how to fix anything missing.
- `tenant-leak-check run --project <folder>` runs the full check: it builds a local stack from the project's migrations, works out who owns each table, creates two synthetic tenants with users, rows and files, then probes every table, view, storage bucket and client-callable database function as tenant A and as an anonymous visitor.
- `tenant-leak-check diff --project <folder> --migration <file.sql>` is migration mode: it tests the project before the new migration, applies the migration on top of the test data (catching migrations that only fail on a database with rows in it), tests again, and reports new leaks, fixed leaks, removed policies, row level security switched off, and destructive statements such as dropped tables and columns or `TRUNCATE`, with file and line.
- Every run writes `report.html` (for clients: one self-contained page), `report.md` and `report.json` (stable format: [docs/REPORT-FORMAT.md](docs/REPORT-FORMAT.md), schema: [docs/report.schema.json](docs/report.schema.json)) into `--out` (default `./tlc-report`).
- Exit codes for CI: 0 clean, 1 leaks found, 2 could not test everything, 3 tool error, 4 migration needs a human review. Details in [docs/REPORT-FORMAT.md](docs/REPORT-FORMAT.md#exit-codes).
- A safety guard that refuses to connect to anything that is not on this machine.
- A demo app with 19 planted leaks ([demo/LEAKS.md](demo/LEAKS.md)) and its fixed twin, plus bad, good and needs-review demo migrations ([demo/migrations/](demo/migrations/README.md)). The integration tests use them to prove every planted problem is caught.
- A Claude Code command and skill ("run the leak check"): see [integrations/claude-code/](integrations/claude-code/README.md) for the one-line step that switches them on.

The full plain-English guide, a real-world project run and sample reports come next. [docs/DESIGN.md](docs/DESIGN.md) describes exactly how everything works.

## Try it

You need Node.js 24 or newer, Docker, and the Supabase CLI.

```sh
npm install
node src/cli.ts doctor
node src/cli.ts run --project demo/broken     # exits 1: the planted leaks are found
node src/cli.ts run --project demo/fixed      # exits 0: clean
node src/cli.ts diff --project demo/fixed --migration demo/migrations/bad/20261101090000_housekeeping.sql   # exits 1
```

Reports land in `./tlc-report/` (open `report.html` in a browser).

## For developers

```sh
npm run check              # type-check and unit tests (no Docker needed)
npm run test:integration   # runs the demo apps and demo migrations against a real local stack (needs Docker)
```
