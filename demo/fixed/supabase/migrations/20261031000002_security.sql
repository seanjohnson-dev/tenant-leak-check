-- Demo "agency" app, FIXED version: row level security and policies.
-- Every table has row level security on, and every policy limits rows to the signed-in
-- user's own organisation (or, for personal data, to the user). Comments name the leak
-- from demo/leaks.json that each part fixes.

alter table public.organizations enable row level security;
create policy "Members read their organisation" on public.organizations
  for select to authenticated
  using (id in (select org_id from public.org_members where user_id = (select auth.uid())));

alter table public.org_members enable row level security;
create policy "Users read their own memberships" on public.org_members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Fixes L09: profiles are private to their user.
alter table public.profiles enable row level security;
create policy "Users read their own profile" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));
create policy "Users update their own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Fixes L03, L05 and L07: every project policy checks membership, before and after a change.
alter table public.projects enable row level security;
create policy "Members read their projects" on public.projects
  for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members create projects in their organisation" on public.projects
  for insert to authenticated
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members update their projects" on public.projects
  for update to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members delete their projects" on public.projects
  for delete to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Fixes L08: tasks are reached through their project, whose own policy checks membership.
alter table public.tasks enable row level security;
create policy "Members read their tasks" on public.tasks
  for select to authenticated
  using (project_id in (select id from public.projects));
create policy "Members add tasks to their projects" on public.tasks
  for insert to authenticated
  with check (project_id in (select id from public.projects));
create policy "Members update their tasks" on public.tasks
  for update to authenticated
  using (project_id in (select id from public.projects))
  with check (project_id in (select id from public.projects));
create policy "Members delete their tasks" on public.tasks
  for delete to authenticated
  using (project_id in (select id from public.projects));

alter table public.clients enable row level security;
create policy "Members manage their clients" on public.clients
  for all to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Fixes L04 and L06: invoices are limited to the member's own organisation, with an explicit WITH CHECK.
alter table public.invoices enable row level security;
create policy "Members read their invoices" on public.invoices
  for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members create invoices" on public.invoices
  for insert to authenticated
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members update their invoices" on public.invoices
  for update to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members delete invoices" on public.invoices
  for delete to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Fixes L18: payments are reached through their invoice, whose own policy checks membership.
alter table public.payments enable row level security;
create policy "Members read their payments" on public.payments
  for select to authenticated
  using (invoice_id in (select id from public.invoices));
create policy "Members record payments" on public.payments
  for insert to authenticated
  with check (invoice_id in (select id from public.invoices));

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

-- Fixes L01: row level security is on, with membership policies.
alter table public.contacts enable row level security;
create policy "Members manage their contacts" on public.contacts
  for all to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Fixes L02: the same policy as before, now that row level security is actually enabled.
alter table public.expenses enable row level security;
create policy "Members manage their expenses" on public.expenses
  for all to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Fixes L10: quote requests come in through the members' own app (or a server route
-- using the service role), never straight from anonymous visitors.
alter table public.quote_requests enable row level security;
create policy "Members read their quote requests" on public.quote_requests
  for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members file quote requests" on public.quote_requests
  for insert to authenticated
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

alter table public.activity_log enable row level security;

-- Fixes L19: everyone may read the shared plans, but only the service role can change them.
alter table public.plans enable row level security;
create policy "Everyone reads plans" on public.plans
  for select to anon, authenticated
  using (true);
