-- Demo "agency" app, BROKEN version: file storage.
-- documents: one folder per organisation, named after the organisation id.
-- receipts:  one folder per user, named after the user id.

insert into storage.buckets (id, name, public) values
  ('documents', 'documents', false),
  ('receipts', 'receipts', true); -- L11: a public bucket, so anyone with a link can download every receipt.

-- L12: the read policy only checks the bucket, not the organisation folder.
create policy "Signed-in users read documents" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents');

-- L13: the write policies only check the bucket, so users can add, replace and delete
-- files in other organisations' folders.
create policy "Signed-in users upload documents" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents');
create policy "Signed-in users replace documents" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents');
create policy "Signed-in users delete documents" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents');

create policy "Users read their own receipts" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload their own receipts" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
