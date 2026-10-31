# Planted leaks in the demo app

`demo/broken` is a small multi-tenant "agency" app (organisations, members, projects, tasks, clients, invoices, payments, notes, contacts, expenses, quote requests, shared plans, two storage buckets, two views and two database functions) with **19 deliberately planted leaks**. `demo/fixed` is the same app with every leak fixed the recommended way. All data is synthetic.

The machine-readable version of this list is [`leaks.json`](leaks.json). The integration tests (`npm run test:integration`) use it to prove that:

- on `demo/broken` the tool exits with code 1, reports **exactly** these 48 leak checks (none missed, none extra) and **exactly** these 22 schema warnings;
- on `demo/fixed` the tool exits with code 0, every one of the 48 checks was actually run and **passed**, and nothing is left untested or unclear.

"Tenant A" is a signed-in member of one organisation; "anon" is a visitor who is not signed in. Each check id reads `kind:object:operation:actor`.

| Id | Category | Where | What goes wrong | Checks that must report a leak |
| --- | --- | --- | --- | --- |
| L01 | Row level security disabled | `public.contacts` | RLS was never switched on, so everyone, signed in or not, can read and change every organisation's contacts. | select, insert, update, update_reassign and delete as tenant A; select, insert, update and delete as anon |
| L02 | Policies written but RLS not enabled | `public.expenses` | The policy is correct, but RLS is not enabled, so Postgres ignores it. | the same nine checks as L01, on `public.expenses` |
| L03 | Over-broad policy `USING (true)` | `public.projects` | Any signed-in user reads every organisation's projects. | `table:public.projects:select:tenant_a` |
| L04 | Policy ignores the tenant | `public.invoices` | The read policy checks that the user belongs to *some* organisation, not to the invoice's. | `table:public.invoices:select:tenant_a` |
| L05 | Insert with another tenant's id | `public.projects` | The insert policy only checks that the user is signed in. | `table:public.projects:insert:tenant_a` |
| L06 | Update across tenants | `public.invoices` | The update policy only checks that the user is signed in; with no `WITH CHECK`, the same rule lets a user move their own invoice to another organisation. | `table:public.invoices:update:tenant_a`, `table:public.invoices:update_reassign:tenant_a` |
| L07 | Re-assigning a row to another tenant | `public.projects` | `WITH CHECK (true)` accepts any new `org_id`, so a member can hand a project to another organisation. | `table:public.projects:update_reassign:tenant_a` |
| L08 | Delete across tenants | `public.tasks` | The read and delete policies are `USING (true)`. (Postgres only deletes rows the user can also see, so both have to be open for the delete to work.) | `table:public.tasks:select:tenant_a`, `table:public.tasks:delete:tenant_a` |
| L09 | Anonymous read | `public.profiles` | Every profile, phone numbers included, is readable by anyone. | `table:public.profiles:select:tenant_a`, `table:public.profiles:select:anon` |
| L10 | Anonymous write | `public.quote_requests` | Visitors who are not signed in can file requests into any organisation. | `table:public.quote_requests:insert:anon` |
| L11 | Public storage bucket | bucket `receipts` | Anyone with a link can download every user's receipts. | `storage:receipts:download:tenant_a`, `storage:receipts:download:anon` |
| L12 | Storage read policy ignores the folder | bucket `documents` | The read policy only checks the bucket, not the organisation folder. | `storage:documents:list:tenant_a`, `storage:documents:download:tenant_a` |
| L13 | Storage write policies ignore the folder | bucket `documents` | Upload, replace and delete policies only check the bucket. | `storage:documents:upload:tenant_a`, `storage:documents:overwrite:tenant_a`, `storage:documents:delete:tenant_a` |
| L14 | `SECURITY DEFINER` function reads another tenant's data | `public.get_org_invoices` | Runs as its owner (no RLS) and never checks membership. | `rpc:public.get_org_invoices:execute:tenant_a`, `rpc:public.get_org_invoices:execute:anon` |
| L15 | `SECURITY DEFINER` function deletes another tenant's data | `public.delete_project` | The same mistake in a function that deletes a project and its tasks. | `rpc:public.delete_project:execute:tenant_a`, `rpc:public.delete_project:execute:anon` |
| L16 | View that bypasses RLS | `public.client_directory` | No `security_invoker`, so the view runs with its owner's rights. | `view:public.client_directory:select:tenant_a`, `view:public.client_directory:select:anon` |
| L17 | Materialized view exposed to clients | `public.org_revenue` | Materialized views cannot have RLS, and this one is readable by every client. | `view:public.org_revenue:select:tenant_a`, `view:public.org_revenue:select:anon` |
| L18 | Child table owned only through its parent | `public.payments` | Payments belong to an organisation only through their invoice; the read policy ignores that. | `table:public.payments:select:tenant_a` |
| L19 | Shared table that clients can write | `public.plans` | Any signed-in user can add, change or delete the reference data every organisation relies on. | `table:public.plans:insert:tenant_a`, `table:public.plans:update:tenant_a`, `table:public.plans:delete:tenant_a` |

## What the broken app gets right

Not everything in `demo/broken` is broken, so the tests also show that the tool does not cry wolf:

- `organizations`, `org_members`, `clients` and `notes` have correct policies, and every check on them passes.
- `activity_log` has RLS on and no policies at all, so clients cannot touch it. The tool reports a pass and notes that tenant A cannot read its own rows there either.
- Plans can be read by everyone on purpose. Reading a shared table is reported as "not tested: not applicable", not as a leak.

## Schema warnings

Besides the probes, the tool reviews the schema and raises warnings (they never turn a pass into a leak). The broken app must raise exactly the 22 warnings listed in `leaks.json`; the fixed app must raise none.
