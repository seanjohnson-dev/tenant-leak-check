-- Demo "agency" app, FIXED version: views and database functions (RPCs).

-- Fixes L16: security_invoker makes the view run with the caller's rights, so the
-- policies on clients and organizations apply. Visitors who are not signed in get no access.
create view public.client_directory
  with (security_invoker = true) as
  select c.id, c.name, c.email, o.name as organisation
  from public.clients c
  join public.organizations o on o.id = c.org_id;

revoke all on public.client_directory from anon;
grant select on public.client_directory to authenticated;

-- Fixes L17: a materialized view cannot have row level security, so clients get no access
-- to it at all. The app reads revenue through the invoices table (or a server route).
create materialized view public.org_revenue as
  select org_id, count(*) as invoice_count, sum(amount) as total_amount
  from public.invoices
  group by org_id;

revoke all on public.org_revenue from anon, authenticated;

-- Fixes L14: SECURITY INVOKER, so the invoices policies decide what comes back.
create function public.get_org_invoices(p_org_id uuid)
returns setof public.invoices
language sql
stable
security invoker
set search_path = ''
as $$
  select * from public.invoices where org_id = p_org_id;
$$;

-- Fixes L15: SECURITY INVOKER, so the projects delete policy decides what can be deleted.
create function public.delete_project(p_project_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.projects where id = p_project_id;
$$;

revoke execute on function public.get_org_invoices(uuid) from public, anon;
revoke execute on function public.delete_project(uuid) from public, anon;
grant execute on function public.get_org_invoices(uuid) to authenticated;
grant execute on function public.delete_project(uuid) to authenticated;
