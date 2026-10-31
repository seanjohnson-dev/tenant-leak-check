-- Demo "agency" app, FIXED version: file storage.
-- documents: one folder per organisation, named after the organisation id.
-- receipts:  one folder per user, named after the user id.

-- Fixes L11: both buckets are private; the app shows files through signed URLs.
insert into storage.buckets (id, name, public) values
  ('documents', 'documents', false),
  ('receipts', 'receipts', false);

-- Fixes L12 and L13: every documents policy checks that the first folder of the path is
-- an organisation the user belongs to.
create policy "Members read their organisation's documents" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select org_id::text from public.org_members where user_id = (select auth.uid()))
  );
create policy "Members upload their organisation's documents" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select org_id::text from public.org_members where user_id = (select auth.uid()))
  );
create policy "Members replace their organisation's documents" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select org_id::text from public.org_members where user_id = (select auth.uid()))
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select org_id::text from public.org_members where user_id = (select auth.uid()))
  );
create policy "Members delete their organisation's documents" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select org_id::text from public.org_members where user_id = (select auth.uid()))
  );

create policy "Users read their own receipts" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload their own receipts" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
