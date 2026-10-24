-- A summary linked to a job blocked deletion. The foreign key is
-- (job_id, user_id), and ON DELETE SET NULL tried to null both columns.
-- user_id is not null, so Postgres rejected the delete.
-- Null only job_id. When job_id is set, it must still belong to the same owner.

alter table public.summaries
  drop constraint summaries_job_owner_fk;

alter table public.summaries
  add constraint summaries_job_owner_fk
  foreign key (job_id, user_id)
  references public.processing_jobs (id, user_id)
  on delete set null (job_id);
