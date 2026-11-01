-- Demo "good" migration, applied on top of demo/fixed: time tracking for projects.
-- A new tenant table with row level security and one membership policy per operation,
-- plus a new column with a default, so existing rows stay valid. Migration mode must
-- report no new leaks and nothing to review (exit code 0). All data in this demo is synthetic.

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  minutes integer not null check (minutes > 0),
  note text,
  logged_at timestamptz not null default now()
);

create index time_entries_org_id_idx on public.time_entries (org_id);
create index time_entries_project_id_idx on public.time_entries (project_id);

alter table public.time_entries enable row level security;

create policy "Members read their time entries" on public.time_entries
  for select to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members log time in their organisation" on public.time_entries
  for insert to authenticated
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members correct their time entries" on public.time_entries
  for update to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())))
  with check (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));
create policy "Members delete their time entries" on public.time_entries
  for delete to authenticated
  using (org_id in (select org_id from public.org_members where user_id = (select auth.uid())));

-- Existing projects get a budget of zero, so the new required column is safe on live data.
alter table public.projects add column budget_minutes integer not null default 0;
