# tenant-leak-check

Checks whether one customer of a Supabase app can see or change another customer's data.

It builds a throwaway copy of your project **on your own machine**, from your migrations, fills it with made-up customers and data, and then really tries to reach customer B's rows, files and functions while signed in as customer A, and again as an anonymous visitor. It reports what got through, with evidence and a suggested fix.

> **Not a certification.** This is an automated tenant-isolation test, not a security certification, audit or penetration test. It only covers what its report lists as tested.

## Status

Early build (v0.1.0). What works today:

- `tenant-leak-check doctor` checks that Docker, the Supabase CLI and enough free memory are in place, and explains how to fix anything missing.
- `tenant-leak-check run --project <folder>` runs the full check: it builds a local stack from the project's migrations, works out who owns each table, creates two synthetic tenants with users, rows and files, then probes every table, view, storage bucket and client-callable database function as tenant A and as an anonymous visitor. It prints a summary and exits with 0 (clean), 1 (leaks), 2 (could not test everything) or 3 (tool error).
- A safety guard that refuses to connect to anything that is not on this machine.
- A demo app with 19 planted leaks ([demo/LEAKS.md](demo/LEAKS.md)) and its fixed twin, which the integration tests use to prove every leak is caught.

Migration mode, the HTML, Markdown and JSON reports, and the Claude Code command are being built next. [docs/DESIGN.md](docs/DESIGN.md) describes exactly how everything works.

## Try it

You need Node.js 24 or newer, Docker, and the Supabase CLI.

```sh
npm install
node src/cli.ts doctor
node src/cli.ts run --project demo/broken     # exits 1: the planted leaks are found
node src/cli.ts run --project demo/fixed      # exits 0: clean
```

## For developers

```sh
npm run check              # type-check and unit tests (no Docker needed)
npm run test:integration   # runs both demo apps against real local stacks (needs Docker)
```
