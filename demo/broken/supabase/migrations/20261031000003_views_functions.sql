-- Demo "agency" app, BROKEN version: views and database functions (RPCs).

-- L16: a view without security_invoker runs with its owner's rights (postgres), which skip
-- row level security, so every organisation's clients show up for every caller.
create view public.client_directory as
  select c.id, c.name, c.email, o.name as organisation
  from public.clients c
  join public.organizations o on o.id = c.org_id;

grant select on public.client_directory to anon, authenticated;

-- L17: a materialized view cannot have row level security, and this one is readable by every client.
create materialized view public.org_revenue as
  select org_id, count(*) as invoice_count, sum(amount) as total_amount
  from public.invoices
  group by org_id;

grant select on public.org_revenue to anon, authenticated;

-- L14: SECURITY DEFINER skips row level security and the function never checks membership,
-- so anyone can read any organisation's invoices by passing its id.
create function public.get_org_invoices(p_org_id uuid)
returns setof public.invoices
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.invoices where org_id = p_org_id;
$$;

-- L15: same mistake, but it deletes: anyone can delete any organisation's project.
create function public.delete_project(p_project_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.projects where id = p_project_id;
$$;
