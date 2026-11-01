---
name: tenant-leak-check
description: Run the tenant isolation check ("run the leak check") on a Supabase project's migrations, or check a new migration before it ships, then explain the report in plain English. Use when someone asks to run the leak check, test tenant isolation, check whether customers can see each other's data, or check a migration for new leaks or destructive changes.
---

# Run the tenant leak check

`tenant-leak-check` builds a disposable LOCAL Supabase copy of a project from its migrations, creates two synthetic tenants, and tries to read, add, change and delete tenant B's data as tenant A and as an anonymous visitor. It is an isolation test, not a security certification.

## Safety rules (always)

- Local only. Never point the tool, or anything else, at a hosted Supabase project or a live URL. The tool refuses non-local URLs; do not look for a way around that.
- Never open `.env` files, secrets, `~/.claude` settings or service-role keys. The tool needs no keys.
- Never modify the target project. The tool copies its migrations into its own sandbox; you only read the reports.
- Synthetic data only. Never seed or copy real customer data.
- Never describe the result as "secure", "certified", "compliant" or "safe". Say what was tested and what was found.

## Steps

1. Work from the root of the tenant-leak-check repository (the folder that holds this `.claude` folder). If `node_modules` is missing, run `npm install`.
2. Check the machine: `node src/cli.ts doctor`. If it reports a Docker permission problem and the user is in the `docker` group, run every command below as `sg docker -c "<command>"`. If doctor fails for another reason, explain its fix in plain words and stop.
3. Work out what to check:
   - The **project folder** is the one that contains `supabase/migrations` (usually the app's repository root). If it is not clear which project is meant, ask. For the built-in demo, use `demo/broken` (has planted leaks) or `demo/fixed` (clean).
   - If the user mentions a **new migration file**, use migration mode (`diff`). Otherwise use `run`.
4. Run it, writing the reports to a folder named after the project:
   - Full check: `node src/cli.ts run --project <project folder> --out tlc-report/<project name>`
   - Migration check: `node src/cli.ts diff --project <project folder> --migration <file.sql> --out tlc-report/<project name>-migration`
   A run takes one to three minutes (a migration check runs twice). Let it finish; progress lines go to stderr.
5. Read the exit code:
   - `0` no leaks, and everything in scope was tested
   - `1` leaks found
   - `2` no leaks found, but some checks could not be completed, so the result is not clean
   - `3` the tool could not run (read the error and its hint; fix the setup or the input and try again)
   - `4` migration mode only: no leaks, but the migration needs a human review
6. Read `<out>/report.json` (format: `docs/REPORT-FORMAT.md`) and summarise for the user in plain English:
   - the verdict in one sentence;
   - for migration mode, `migration.headline` and every item in `migration.review` (with file and line);
   - every leak: the finding's `title`, what was tried and what came back (from the check's `evidence.summary`), the `problem` and the `fix`;
   - every check in `notTested` whose `kind` is `could_not_test` or whose status is `inconclusive`, with its reason;
   - where the full reports are: `<out>/report.html` for clients, `<out>/report.md` for developers.
7. End the summary with this sentence, word for word: "This is an automated tenant-isolation test, not a security certification, audit or penetration test."

## Afterwards

- Do not change the target project's policies or migrations unless the user asks. The SQL in each finding is a starting point to review, not a patch to apply blindly.
- If the tenancy model in the report is wrong (a table is linked to the wrong owner, or "tenant" means something else in this app, such as a renter), suggest a `tenant-leak-check.json` override (see `docs/DESIGN.md` section 10) and run the check again. Keep the file outside the target project and pass it with `--config <file>` unless the user asks you to add it to the project.
- If the build fails because the project's history is not a plain `supabase/migrations` folder (a separate `schema.sql`, migrations without a timestamp, two migrations with the same version), explain it and suggest `build.files` in that config file. Never rename or edit the project's own files.
- The tool stops its local stack when it finishes. If a run was interrupted, the next run cleans up its own `tlc-*` stacks.
