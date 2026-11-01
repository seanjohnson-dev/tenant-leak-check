-- Demo "needs review" migration, applied on top of demo/fixed. It opens no leak, but a
-- person must look at it before it ships (exit code 4):
-- V1 (column dropped): the contacts' e-mail addresses are deleted.
-- V2 (fails on live data): a required column without a default works on an empty database
--    but fails on any database that already has projects, as a live one does.
-- All data in this demo is synthetic.

-- V1
alter table public.contacts drop column email;

-- V2
alter table public.projects add column code text not null;
