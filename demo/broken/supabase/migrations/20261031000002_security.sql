-- Demo "agency" app, BROKEN version: row level security and policies.
-- Each planted leak is marked with its id from demo/leaks.json (L01, L02, ...).

alter table public.organizations enable row level security;
create policy "Members read their organisation" on public.organizations
  for select to authenticated
  using (id in (select org_id from public.org_members where user_id = (select auth.uid())));

alter table public.org_members enable row level security;
create policy "Users read their own memberships" on public.org_members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- L09: every profile (phone numbers included) is readable by anyone, even without signing in.
alter table public.profiles enable row level security;
create policy "Profiles are public" on public.profiles
  for select to anon, authenticated
  using (true);
create policy "Users update their own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- L03: any signed-in user reads every organisation's projects.
alter table public.projects enable row level security;
create policy "Signed-in users read projects" on public.projects
  for select to authenticated
  using (true);
-- L05: any signed-in user can create a project inside another organisation.
create policy "Signed-in users create projects" on public.projects
  for insert to authenticated
  with check ((select auth.uid()) is not null);
-- L07: the update policy checks the row before the change, but WITH CHECK (true) accepts any
-- new value, so a member can hand their project to another organisation.
create policy "Members update their projects" on public.projects
  for update to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (true);
create policy "Members delete their projects" on public.projects
  for delete to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- L08: tasks belong to an organisation only through their project. Both the read and
-- the delete policy forget that, so anyone signed in can see and delete every task.
alter table public.tasks enable row level security;
create policy "Signed-in users read tasks" on public.tasks
  for select to authenticated
  using (true);
create policy "Members add tasks to their projects" on public.tasks
  for insert to authenticated
  with check (project_id in (
    select p.id from public.projects p
    where p.org_id in (select org_id from public.org_members where user_id = (select auth.uid()))
  ));
create policy "Members update their tasks" on public.tasks
  for update to authenticated
  using (project_id in (
    select p.id from public.projects p
    where p.org_id in (select org_id from public.org_members where user_id = (select auth.uid()))
  ))
  with check (project_id in (
    select p.id from public.projects p
    where p.org_id in (select org_id from public.org_members where user_id = (select auth.uid()))
  ));
create policy "Signed-in users delete tasks" on public.tasks
  for delete to authenticated
  using (true);

alter table public.clients enable row level security;
create policy "Members manage their clients" on public.clients
  for all to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- L04: the read policy checks that the user belongs to SOME organisation, not to this one.
alter table public.invoices enable row level security;
create policy "Members read invoices" on public.invoices
  for select to authenticated
  using (exists (select 1 from public.org_members where user_id = (select auth.uid())));
create policy "Members create invoices" on public.invoices
  for insert to authenticated
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
-- L06: any signed-in user can change any invoice. With no WITH CHECK, Postgres reuses the
-- USING expression for the new row, so a user can also move their own invoice to another organisation.
create policy "Signed-in users update invoices" on public.invoices
  for update to authenticated
  using ((select auth.uid()) is not null);
create policy "Members delete invoices" on public.invoices
  for delete to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- L18: payments belong to an organisation only through their invoice; the read policy ignores that.
alter table public.payments enable row level security;
create policy "Signed-in users read payments" on public.payments
  for select to authenticated
  using (true);
create policy "Members record payments" on public.payments
  for insert to authenticated
  with check (invoice_id in (
    select i.id from public.invoices i
    where i.org_id in (select org_id from public.org_members where user_id = (select auth.uid()))
  ));

-- Correct: personal notes are limited to their author for every operation.
alter table public.notes enable row level security;
create policy "Users read their notes" on public.notes
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Users write their notes" on public.notes
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "Users update their notes" on public.notes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "Users delete their notes" on public.notes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- L01: row level security was never switched on for contacts. Everyone, even visitors who
-- are not signed in, can read and change every organisation's contacts.

-- L02: the expense policies are correct, but row level security was never enabled on the
-- table, so Postgres ignores them.
create policy "Members manage their expenses" on public.expenses
  for all to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- L10: the public quote form lets visitors who are not signed in file requests into any organisation.
alter table public.quote_requests enable row level security;
create policy "Members read their quote requests" on public.quote_requests
  for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Visitors submit quote requests" on public.quote_requests
  for insert to anon
  with check (true);

-- Correct: row level security on, and no policies at all, so clients cannot touch the log.
alter table public.activity_log enable row level security;

-- L19: plans are shared reference data, but any signed-in user can add, change or delete them.
alter table public.plans enable row level security;
create policy "Everyone reads plans" on public.plans
  for select to anon, authenticated
  using (true);
create policy "Signed-in users add plans" on public.plans
  for insert to authenticated
  with check (true);
create policy "Signed-in users change plans" on public.plans
  for update to authenticated
  using (true)
  with check (true);
create policy "Signed-in users delete plans" on public.plans
  for delete to authenticated
  using (true);
