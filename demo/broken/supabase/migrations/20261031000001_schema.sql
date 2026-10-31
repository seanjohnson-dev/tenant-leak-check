-- Demo "agency" app: the schema. Identical in demo/broken and demo/fixed.
-- Every table belongs to an organisation (the tenant), to a user, or to nobody (shared).
-- All data in this demo is synthetic.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  primary key (org_id, user_id)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  phone text
);

-- Every new sign-up gets a profile row, as in most Supabase starter apps.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name) values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived'))
);

create table public.tasks (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  done boolean not null default false
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  email text
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  number text not null unique,
  amount numeric(12, 2) not null check (amount > 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid')),
  due_date date
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  paid_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  full_name text not null,
  email text
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  description text not null,
  amount numeric(10, 2) not null check (amount >= 0)
);

create table public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  contact_email text not null,
  message text not null
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

-- Reference data shared by every organisation.
create table public.plans (
  code text primary key,
  name text not null,
  monthly_price numeric(8, 2) not null check (monthly_price >= 0)
);

insert into public.plans (code, name, monthly_price) values
  ('starter', 'Starter', 9),
  ('growth', 'Growth', 29);
