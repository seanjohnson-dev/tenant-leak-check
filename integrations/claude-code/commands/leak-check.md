---
description: Run the tenant leak check on a Supabase project (or a new migration) and explain the report
argument-hint: <project folder> [new-migration.sql]
---

Run the tenant leak check on: $ARGUMENTS

Follow the `tenant-leak-check` skill in `.claude/skills/tenant-leak-check/SKILL.md` exactly:

1. Run `node src/cli.ts doctor` from the root of this repository (wrap commands in `sg docker -c "..."` if Docker needs it).
2. The first argument is the project folder (the one that contains `supabase/migrations`). If no folder was given, ask which project to check; for a demo, use `demo/broken`.
3. If a migration file was given as well, run migration mode: `node src/cli.ts diff --project <folder> --migration <file> --out tlc-report/<name>-migration`. Otherwise run `node src/cli.ts run --project <folder> --out tlc-report/<name>`.
4. Read the exit code and `report.json`, then summarise in plain English: the verdict, every leak with its evidence and fix, every check that could not be completed, and (for a migration) the headline and every review item.
5. Say where `report.html` and `report.md` are, and end with: "This is an automated tenant-isolation test, not a security certification, audit or penetration test."

Local projects only: never point it at a hosted project, never open `.env` files or keys, and never modify the target project.
