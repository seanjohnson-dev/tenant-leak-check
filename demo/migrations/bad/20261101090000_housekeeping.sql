-- Demo "bad" migration, applied on top of demo/fixed. It reads like routine housekeeping,
-- but it plants one regression of every kind migration mode must catch. Each part is
-- named R1 to R6; demo/migrations/expected.json lists what the tool must report for it.
-- All data in this demo is synthetic.

-- R1 (new leak: a policy that matches every row): a "let everyone see the client list" shortcut.
-- Policies are combined with OR, so this one opens every organisation's clients to any signed-in user.
create policy "Signed-in users read all clients" on public.clients
  for select to authenticated
  using (true);

-- R2 (row level security disabled): switched off "for now" while debugging an import.
alter table public.expenses disable row level security;

-- R3 (policy removed): the read policy on quote requests is dropped and never re-created.
drop policy "Members read their quote requests" on public.quote_requests;

-- R4 (column dropped): contact e-mail addresses are deleted.
alter table public.contacts drop column email;

-- R5 (table dropped): the activity log is deleted with every row in it.
drop table public.activity_log;

-- R6 (table emptied): the shared price plans are wiped.
truncate table public.plans;
