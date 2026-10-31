# tenant-leak-check

Checks whether one customer of a Supabase app can see or change another customer's data.

It builds a throwaway copy of your project **on your own machine**, from your migrations, fills it with made-up customers and data, and then really tries to reach customer B's rows, files and functions while signed in as customer A, and again as an anonymous visitor. It reports what got through, with evidence and a suggested fix.

> **Not a certification.** This is an automated tenant-isolation test, not a security certification, audit or penetration test. It only covers what its report lists as tested.

## Status

Early build (v0.1.0). What works today:

- `tenant-leak-check doctor` checks that Docker, the Supabase CLI and enough free memory are in place, and explains how to fix anything missing.
- A safety guard that refuses to connect to anything that is not on this machine.

The checking engine, migration mode, reports and Claude Code command are being built next. [docs/DESIGN.md](docs/DESIGN.md) describes exactly how they will work.

## Try it

You need Node.js 24 or newer, Docker, and the Supabase CLI.

```sh
npm install
node src/cli.ts doctor
```

## For developers

```sh
npm run check   # type-check and unit tests
```
