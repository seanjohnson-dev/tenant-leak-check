# tenant-leak-check

**Can one of your customers see, or change, another customer's data?** This tool answers that question for apps built on Supabase, with proof.

It builds a throwaway copy of the app's database **on your own computer**, from the app's migration files. It fills that copy with two made-up customers ("tenant A" and "tenant B") and their made-up data. Then, signed in as tenant A, it really tries to read, add, change and delete tenant B's rows, files and database functions, and tries again as an anonymous visitor who is not signed in. It writes a report saying what got through, with the evidence and a suggested fix for each problem.

> **This is an automated tenant-isolation test, not a security certification, audit or penetration test.** It proves what it tested, and the report lists exactly what that was. It says nothing about anything it did not test.

It is free and open source under the [MIT licence](LICENSE). Version 0.1.0: young software, so read its reports with care, and see [the limits](#8-questions-and-limits).

---

## Contents

1. [What it proves, and what it does not](#1-what-it-proves-and-what-it-does-not)
2. [What you need (one-time setup)](#2-what-you-need-one-time-setup)
3. [Run it, step by step](#3-run-it-step-by-step)
4. [Check a new migration before it ships](#4-check-a-new-migration-before-it-ships)
5. [How to read the report](#5-how-to-read-the-report)
6. [When the app needs a little help (the config file)](#6-when-the-app-needs-a-little-help-the-config-file)
7. [Use it from Claude Code](#7-use-it-from-claude-code)
8. [Questions and limits](#8-questions-and-limits)
9. [What is in this folder](#9-what-is-in-this-folder)
10. [Licence and reporting problems](#10-licence-and-reporting-problems)

---

## 1. What it proves, and what it does not

**What a clean result proves.** For every table, storage bucket and database function listed in the report as tested: a signed-in customer could not read another customer's data, could not add rows into another customer's account, could not change or delete another customer's rows, and could not move their own rows into another customer's account. An anonymous visitor could not do any of that to anyone's data. Each of those was an actual attempt against a real Supabase stack (database, login, API and file storage), not a guess from reading the code.

**What it does not prove.**

- It does not test your **live** app. It tests a fresh local copy built from the migration files, so if the live database was changed by hand and the files do not show it, the test cannot see it.
- It does not test your **app's own code** (web pages, phone apps, server functions such as Vercel or Edge Functions, anything using the service-role key). It tests the database rules that protect data when someone talks to Supabase directly, which is what an attacker with a normal login can do.
- It does not look for other kinds of security problems: weak passwords, leaked keys, email spoofing, denial of service, payment fraud and so on.
- It uses two test customers with a few rows each. A rule that only misbehaves with particular data (for example a specific date or status) may not show up.
- When it cannot test something, it says so: a check is never reported as passed unless it was really carried out. Those items are listed in the report under "Not tested, and why", each with the reason.

## 2. What you need (one-time setup)

- **Node.js 24 or newer** ([nodejs.org](https://nodejs.org/)).
- **Docker**, running ([Docker Engine](https://docs.docker.com/engine/install/) or Docker Desktop). Supabase's local stack runs inside it.
- **The Supabase CLI**, version 2.x ([install guide](https://supabase.com/docs/guides/local-development/cli/getting-started)). Built and tested with 2.122.
- About **1.5 GB of free memory** while a check runs (the local stack itself uses about 400 MB; the tool switches off the Supabase parts it does not need).
- **git**, to download the tool.

It was built and tested on Linux. It should work wherever Docker and the Supabase CLI run, but other systems have not been tested yet.

Download the tool and install its two small dependencies:

```sh
git clone https://github.com/seanjohnson-dev/tenant-leak-check.git
cd tenant-leak-check
npm install
node src/cli.ts doctor
```

All the commands below are run from this `tenant-leak-check` folder.

`doctor` checks all of the above and explains, in plain words, how to fix anything that is missing. If it says Docker refuses permission and your user was just added to the `docker` group, put `sg docker -c "..."` around each command (or log out and in again).

**No keys or passwords are needed.** The tool never connects to a hosted Supabase project; it refuses any address that is not on your own computer.

## 3. Run it, step by step

1. Find the app's project folder: the one that contains `supabase/migrations` (usually the root of the app's code).
2. Run the check:

   ```sh
   node src/cli.ts run --project ../my-app --out tlc-report/my-app
   ```

3. Wait. The first run downloads Supabase's software and can take several minutes; later runs take one to five minutes, depending on the size of the app. Progress lines tell you what it is doing.
4. Open `tlc-report/my-app/report.html` in a web browser. That page is written for a non-technical reader and can be sent to a client as it is.

**Try it on the built-in demo first.** `demo/broken` is a small app with 19 deliberately planted leaks, and `demo/fixed` is the same app done right:

```sh
node src/cli.ts run --project demo/broken --out tlc-report/broken   # finds every planted leak (ends with code 1)
node src/cli.ts run --project demo/fixed  --out tlc-report/fixed    # clean (ends with code 0)
```

The tool never changes the app's folder. It copies only the migration files (plus a few harmless settings) into its own work folder, `.tlc-work/`, and never reads `.env` files or other secrets. It shuts down its local stack when it finishes (add `--keep-running` to leave it up).

## 4. Check a new migration before it ships

Migration mode tests the app as it is, applies the new migration on top of the test data, tests again, and tells you what changed:

```sh
node src/cli.ts diff --project ../my-app --migration ../my-app/supabase/migrations/20261101090000_new_feature.sql --out tlc-report/new-feature
```

The report starts with a one-line headline, then lists:

- **new leaks** the migration introduces, and leaks it fixes;
- **items that need a person to look**, each with its file and line: an access rule removed, a rule that lets everyone in (`USING (true)`), row level security switched off, a table or column deleted, a table emptied (`TRUNCATE`), and a migration that only fails on a database that already holds data (the kind that works in development and breaks in production).

Try it on the demos:

```sh
node src/cli.ts diff --project demo/fixed --migration demo/migrations/bad/20261101090000_housekeeping.sql --out tlc-report/bad     # code 1
node src/cli.ts diff --project demo/fixed --migration demo/migrations/good/20261101090000_time_tracking.sql --out tlc-report/good # code 0
```

## 5. How to read the report

Every run writes the same result three ways into the `--out` folder:

| File | For whom |
| --- | --- |
| `report.html` | Clients and non-technical readers. One self-contained page, prints well. |
| `report.md` | Developers, pull requests, chat. |
| `report.json` | Other programs and CI. The format is fixed and documented in [docs/REPORT-FORMAT.md](docs/REPORT-FORMAT.md). |

**The verdict** at the top is one of:

| Verdict | Meaning |
| --- | --- |
| No leaks found | Every check in scope was carried out, and none got through. |
| Leaks found | At least once, a customer (or an anonymous visitor) reached another customer's data. Each leak is listed. |
| Not a clean result: some checks could not be completed | No leaks were found, but nothing can be promised about the checks that could not be completed. |
| No leaks found, but the migration needs a review | Migration mode only: the migration does something a person should look at (for example it deletes a column). |

**The table of results** shows each table and storage bucket with one cell per action (read, add, change, move to another customer, delete) for tenant A and for an anonymous visitor. Each cell says **Pass** (the attempt was blocked), **LEAK**, **Not tested**, **Unclear**, **n/a** (the action does not apply, for example reading a table every customer shares) or **Skipped** (excluded in the config), in words as well as colour.

**Each leak** comes with:

- what was tried, in plain words ("Tenant A asked for tenant B's invoices");
- what came back (an excerpt of the answer, with any keys removed);
- what the problem is and how to fix it, in plain English, plus a suggested SQL change for the developer to review (a starting point, not a patch to apply blindly).

**"Not tested, and why"** lists everything that was not checked and the reason, with the ones that stop the result from being clean first: for example "the tool could not create test data because of a rule in the database", or "this table is shared by all customers, so there is nothing private to read". Shared tables are expected here; anything in the "could not be completed" group is worth a look.

**Warnings** come from reading the database's rules rather than from attacks. They point at risky patterns (for example a database function that runs with full rights). A warning is not a leak; it is a place where a future change could more easily create one.

**Exit codes** (for scripts and CI):

| Code | Meaning |
| --- | --- |
| 0 | No leaks, and everything in scope was tested. |
| 1 | Leaks found. |
| 2 | No leaks found, but some checks could not be completed. |
| 3 | The tool itself could not run (the message says why and what to do). No report is written. |
| 4 | Migration mode: no leaks, but the migration needs a human review. |

## 6. When the app needs a little help (the config file)

The tool works out who owns each table by itself: it looks for columns such as `tenant_id`, `org_id`, `account_id` or `user_id`, and for links to the logged-in user. The report shows its reasoning for every table under "How we decided who owns each table". If something there is wrong, a small file called `tenant-leak-check.json` corrects it. Keep it in the app's folder, or anywhere else and pass it with `--config <file>`.

The most common corrections:

```json
{
  "tables": {
    "public.invoices": { "tenantColumn": "org_id" },
    "public.notes": { "userColumn": "author_id" },
    "public.countries": { "shared": true },
    "public.audit_log": { "skip": "Written only by the server; customers never touch it." }
  },
  "seed": { "values": { "public.invoices.status": "draft" } }
}
```

Two settings help with apps whose words or history are unusual:

- **"Tenant" means something else in this app.** In a property app, a "tenant" is a renter, and each *landlord* is one customer. `"tenantRoot": null` tells the tool there is no separate customer table: each signed-in user is one customer.
- **The migration folder does not rebuild the database on its own.** For example, the starting schema lives in `supabase/schema.sql`, some migration files have no timestamp in their name, or two files share a timestamp. `build.files` adds files to the build at a chosen point in the order, without changing the app's folder:

  ```json
  { "build": { "files": [ { "path": "../my-app/supabase/schema.sql", "version": "20240101000000" } ] } }
  ```

A database function reported as **Unclear** usually needs a realistic request (section 8 explains why). Give its arguments with `rpc.args`; placeholders such as `{tenantB.row:public.invoices}` (tenant B's row id) or `{tenantB.tenant}` point the request at tenant B's data:

```json
{ "rpc": { "args": { "public.archive_invoice": { "p_invoice_id": "{tenantB.row:public.invoices}", "p_reason": "duplicate" } } } }
```

Every setting is described in [docs/DESIGN.md, section 10](docs/DESIGN.md#10-config-file-optional). A typo in the file is reported with the exact setting at fault rather than being ignored.

## 7. Use it from Claude Code

The repository includes a Claude Code command and skill, so you can open Claude Code in this folder and say **"run the leak check on ../my-app"**, or type `/leak-check ../my-app`. Claude runs `doctor`, then the check (or migration mode if you name a migration file), then explains the report in plain English: the verdict, every leak with its evidence and fix, anything that could not be tested, and where the full reports are.

To switch this on, run once in this folder (it copies two files into the repository's own `.claude/` folder; nothing goes into your home folder):

```sh
mkdir -p .claude && cp -R integrations/claude-code/commands integrations/claude-code/skills .claude/
```

## 8. Questions and limits

**Does it touch my live app or real customer data?** No. It only ever talks to a stack on your own computer, built from the migration files, filled with made-up data. It refuses any other address, and it needs no keys.

**Does it change my app's code?** No. It reads the migration files and copies them into its own work folder. The SQL fixes in the report are suggestions for you to review.

**The report says "Leaks found". Is my app broken?** It means a customer could reach another customer's data in the local copy. Read the evidence for each leak. If the live database has rules that are not in the migration files, the live app may behave differently; that gap is itself worth fixing, because the next rebuild from the files would bring the leak back.

**A table I expected to be tested shows "n/a".** The tool decided every customer shares that table. Check "How we decided who owns each table" in the report; if it is wrong, add the table to the config with its owner column.

**Why are some things "Not tested" or "Unclear"?** Usually because the tool could not create believable test data for a table (a database rule refused it), or because a database function failed or refused the request for a reason that had nothing to do with access (see "How database functions are checked" below). The reason is always shown. A config entry (section 6) often fixes it.

**Can I run it in CI on every pull request?** Yes: use the exit codes above. Migration mode (`diff`) is designed for "check this one new migration".

**How database functions are checked, and why some say "Unclear".** A refusal only proves something if the request itself was valid. So each function is first called by tenant B, the owner of the data, with the exact request the test will use (tenant B's identifiers and simple placeholder values filled in automatically). This is the **control call**. Only if it works do tenant A and the anonymous visitor send the same request.
- If the control call fails, the request itself does not work (for example the function needs a detailed JSON payload). The check is **Unclear** with the reason "Control call failed: ...", and tenant A and the visitor are not tried at all.
- If the control call works but tenant A or the visitor get an **input refusal** (for example "unknown action", "invalid value", "missing field", a wrong type or shape), the function refused the request, not the person. The check is **Unclear** with the reason "Refused the input, not the tenant: ...".
- Neither is ever counted as a Pass. A Pass means a real refusal of the other person (for example "permission denied", "not found on this account", or nothing of tenant B's came back and nothing changed). If tenant B's data comes back or changes, it is a LEAK.
- Unclear works like every other unclear result: if there are no leaks, the run ends with exit code 2 ("not a clean result"), never 0.
- **What to do about Unclear:** give that function realistic arguments in the config (`rpc.args`, section 6), using the `{tenantB...}` placeholders so the request points at tenant B's data, and run again. If the function is never meant to be called by customers, take away its execute permission from `anon` and `authenticated`, or exclude it in the config (`rpc.skip`) with a note saying why. Until then, check that function by hand.

**Limits worth knowing.** Two test customers, each with one test user and a couple of rows per table. Ownership comes from columns and links: data protected in other ways (for example by values inside the user's login token) may need a config entry. Views are tested for reading, and for writing when the view accepts writes; functions are tested with one request each, as described above. Only the database, login, API and storage parts of Supabase run; Edge Functions, Realtime and webhooks are not tested.

## 9. What is in this folder

| Path | What it is |
| --- | --- |
| `src/` | The tool (TypeScript, run directly by Node; no build step). |
| `demo/broken`, `demo/fixed` | The demo app with 19 planted leaks, and its fixed twin. [demo/LEAKS.md](demo/LEAKS.md) lists every planted leak. |
| `demo/migrations/` | Bad, good and needs-review demo migrations ([README](demo/migrations/README.md)). |
| `docs/DESIGN.md` | How everything works, in detail. |
| `docs/REPORT-FORMAT.md`, `docs/report.schema.json` | The JSON report format, field by field, and its schema. |
| `integrations/claude-code/` | The Claude Code command and skill. |
| `test/` | Unit tests (no Docker) and integration tests (real local stacks). |

**For developers:**

```sh
npm run check              # type-check and unit tests (no Docker needed)
npm run test:integration   # demo apps and demo migrations against a real local stack (needs Docker)
```

Runtime dependencies: `pg` and `smol-toml`. Everything else is built into Node.

## 10. Licence and reporting problems

[MIT licence](LICENSE): free to use, change and share, including for paid work, with no warranty.

Found a bug, a false result or a leak the tool missed? Please open a GitHub issue with the steps to reproduce it, ideally a small set of migration files. Never include real customer data, keys or `.env` contents: the tool does not need them, and neither does the issue.

## No warranty

tenant-leak-check is a testing aid, not a guarantee that an app is secure or that customer data cannot leak. A clean result covers only what it tested, and it can miss things. It is free under the [MIT licence](LICENSE), provided as is, with no warranty. You use it at your own risk.


