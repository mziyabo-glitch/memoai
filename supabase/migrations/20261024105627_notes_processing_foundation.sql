-- Additive notes-processing schema. Do not apply this from CI or from an agent.
-- The owner applies it later with the Supabase SQL editor or `supabase db push`.
-- No API key belongs in this file. The service role is not granted to the phone.

alter table public.recordings
  add column local_recording_id text;

create unique index recordings_owner_local_id_idx
  on public.recordings (user_id, local_recording_id)
  where local_recording_id is not null;

alter table public.summaries
  add column origin text not null default 'user',
  add column job_id uuid,
  add column model text,
  add constraint summaries_origin_known check (origin in ('user', 'worker')),
  add constraint summaries_worker_link check (origin = 'worker' or job_id is null);

alter table public.action_items
  add column origin text not null default 'user',
  add column owner_name text,
  add column deadline_text text,
  add constraint action_items_origin_known check (origin in ('user', 'worker'));

alter table public.transcript_segments
  add column origin text not null default 'user',
  add column section_sequence integer,
  add constraint transcript_segments_origin_known check (origin in ('user', 'worker'));

create table public.processing_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recording_id uuid not null,
  explanation_version integer not null,
  agreed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint processing_consents_id_user_unique unique (id, user_id),
  constraint processing_consents_recording_owner_fk
    foreign key (recording_id, user_id)
    references public.recordings (id, user_id)
    on delete cascade,
  constraint processing_consents_version_positive check (explanation_version >= 1)
);

create table public.audio_sections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recording_id uuid not null,
  sequence integer not null,
  sha256 text not null,
  size_bytes bigint not null,
  duration_ms integer not null,
  storage_path text not null,
  upload_status text not null default 'needed',
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audio_sections_recording_owner_fk
    foreign key (recording_id, user_id)
    references public.recordings (id, user_id)
    on delete cascade,
  constraint audio_sections_sequence_unique unique (recording_id, sequence),
  constraint audio_sections_hash_unique unique (recording_id, sha256),
  constraint audio_sections_status_known check (upload_status in ('needed', 'uploading', 'acknowledged')),
  constraint audio_sections_size_limit check (size_bytes > 0 and size_bytes <= 20971520),
  constraint audio_sections_duration_nonnegative check (duration_ms >= 0),
  constraint audio_sections_hash_shape check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint audio_sections_ack check (
    (upload_status = 'acknowledged' and acknowledged_at is not null)
    or (upload_status <> 'acknowledged' and acknowledged_at is null)
  )
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recording_id uuid not null,
  consent_id uuid not null,
  idempotency_key text not null,
  transcribe_model text not null,
  notes_model text not null,
  total_duration_ms integer not null,
  status text not null default 'queued',
  lease_owner text,
  lease_until timestamptz,
  provider_request_sent_at timestamptz,
  cancel_requested_at timestamptz,
  deleted_at timestamptz,
  publish_blocked boolean not null default false,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint processing_jobs_id_user_unique unique (id, user_id),
  constraint processing_jobs_key_unique unique (user_id, idempotency_key),
  constraint processing_jobs_recording_owner_fk
    foreign key (recording_id, user_id)
    references public.recordings (id, user_id)
    on delete cascade,
  constraint processing_jobs_consent_owner_fk
    foreign key (consent_id, user_id)
    references public.processing_consents (id, user_id),
  constraint processing_jobs_duration_limit check (
    total_duration_ms >= 0 and total_duration_ms <= 5400000
  ),
  constraint processing_jobs_status_known check (status in (
    'queued', 'leased', 'awaiting_provider', 'processing', 'completed',
    'failed_retryable', 'uncertain', 'cancelled', 'deleted'
  ))
);

alter table public.summaries
  add constraint summaries_job_owner_fk
    foreign key (job_id, user_id)
    references public.processing_jobs (id, user_id)
    on delete set null;

create table public.processing_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id uuid not null,
  recording_id uuid not null,
  sequence integer,
  operation text not null,
  sha256 text,
  idempotency_key text not null,
  status text not null default 'queued',
  lease_owner text,
  lease_until timestamptz,
  request_sent_at timestamptz,
  attempt_count integer not null default 0,
  result_text text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint processing_steps_job_owner_fk
    foreign key (job_id, user_id)
    references public.processing_jobs (id, user_id)
    on delete cascade,
  constraint processing_steps_key_unique unique (job_id, idempotency_key),
  constraint processing_steps_operation_known check (operation in ('transcribe', 'notes')),
  constraint processing_steps_status_known check (status in (
    'queued', 'leased', 'awaiting_provider', 'succeeded',
    'failed_retryable', 'uncertain', 'unusable'
  )),
  constraint processing_steps_attempts_nonnegative check (attempt_count >= 0)
);

create index audio_sections_recording_idx
  on public.audio_sections (recording_id, sequence);

create index processing_jobs_owner_idx
  on public.processing_jobs (user_id, created_at desc);

create index processing_steps_claim_idx
  on public.processing_steps (status, sequence);

create trigger audio_sections_set_updated_at
  before update on public.audio_sections
  for each row execute function public.set_updated_at();

create trigger processing_jobs_set_updated_at
  before update on public.processing_jobs
  for each row execute function public.set_updated_at();

create trigger processing_steps_set_updated_at
  before update on public.processing_steps
  for each row execute function public.set_updated_at();

create or replace function public.protect_processing_job()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.recording_id is distinct from old.recording_id
     or new.consent_id is distinct from old.consent_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.transcribe_model is distinct from old.transcribe_model
     or new.notes_model is distinct from old.notes_model
     or new.total_duration_ms is distinct from old.total_duration_ms
     or new.lease_owner is distinct from old.lease_owner
     or new.lease_until is distinct from old.lease_until
     or new.provider_request_sent_at is distinct from old.provider_request_sent_at
     or new.failure_reason is distinct from old.failure_reason
  then
    raise exception 'only the worker can change processing state';
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    new.publish_blocked := true;
    new.status := 'deleted';
    return new;
  end if;
  if new.cancel_requested_at is not null and old.cancel_requested_at is null then
    new.status := 'cancelled';
    return new;
  end if;
  if new.status is distinct from old.status
     or new.publish_blocked is distinct from old.publish_blocked
  then
    raise exception 'only the worker can advance a job';
  end if;
  return new;
end;
$$;

create trigger processing_jobs_protect
  before update on public.processing_jobs
  for each row execute function public.protect_processing_job();

revoke all on function public.protect_processing_job() from public, anon, authenticated;

alter table public.processing_consents enable row level security;
alter table public.audio_sections enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.processing_steps enable row level security;

revoke all on table public.processing_consents from public, anon, authenticated;
revoke all on table public.audio_sections from public, anon, authenticated;
revoke all on table public.processing_jobs from public, anon, authenticated;
revoke all on table public.processing_steps from public, anon, authenticated;

grant select, insert, delete on table public.processing_consents to authenticated;
grant select, insert, update, delete on table public.audio_sections to authenticated;
grant select, insert, update, delete on table public.processing_jobs to authenticated;
grant select, insert on table public.processing_steps to authenticated;
grant select, insert, update, delete on table public.processing_consents to service_role;
grant select, insert, update, delete on table public.audio_sections to service_role;
grant select, insert, update, delete on table public.processing_jobs to service_role;
grant select, insert, update, delete on table public.processing_steps to service_role;

create policy processing_consents_select_own
  on public.processing_consents for select to authenticated
  using ((select auth.uid()) = user_id);

create policy processing_consents_insert_own
  on public.processing_consents for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy processing_consents_delete_own
  on public.processing_consents for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy audio_sections_select_own
  on public.audio_sections for select to authenticated
  using ((select auth.uid()) = user_id);

create policy audio_sections_insert_own
  on public.audio_sections for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy audio_sections_update_own
  on public.audio_sections for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy audio_sections_delete_own
  on public.audio_sections for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy processing_jobs_select_own
  on public.processing_jobs for select to authenticated
  using ((select auth.uid()) = user_id);

create policy processing_jobs_insert_own
  on public.processing_jobs for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'queued'
    and lease_owner is null
    and lease_until is null
    and provider_request_sent_at is null
    and deleted_at is null
    and publish_blocked = false
    and cancel_requested_at is null
  );

create policy processing_jobs_update_own
  on public.processing_jobs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy processing_jobs_delete_own
  on public.processing_jobs for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy processing_steps_select_own
  on public.processing_steps for select to authenticated
  using ((select auth.uid()) = user_id);

create policy processing_steps_insert_own
  on public.processing_steps for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'queued'
    and lease_owner is null
    and request_sent_at is null
    and result_text is null
    and attempt_count = 0
  );

-- Authenticated clients can only store user-written notes. Worker rows use the service role.
drop policy summaries_insert_own on public.summaries;
create policy summaries_insert_own
  on public.summaries for insert to authenticated
  with check ((select auth.uid()) = user_id and origin = 'user' and job_id is null);

drop policy summaries_update_own on public.summaries;
create policy summaries_update_own
  on public.summaries for update to authenticated
  using ((select auth.uid()) = user_id and origin = 'user')
  with check ((select auth.uid()) = user_id and origin = 'user' and job_id is null);

drop policy action_items_insert_own on public.action_items;
create policy action_items_insert_own
  on public.action_items for insert to authenticated
  with check ((select auth.uid()) = user_id and origin = 'user');

drop policy action_items_update_own on public.action_items;
create policy action_items_update_own
  on public.action_items for update to authenticated
  using ((select auth.uid()) = user_id and origin = 'user')
  with check ((select auth.uid()) = user_id and origin = 'user');

drop policy transcript_segments_insert_own on public.transcript_segments;
create policy transcript_segments_insert_own
  on public.transcript_segments for insert to authenticated
  with check ((select auth.uid()) = user_id and origin = 'user');

drop policy transcript_segments_update_own on public.transcript_segments;
create policy transcript_segments_update_own
  on public.transcript_segments for update to authenticated
  using ((select auth.uid()) = user_id and origin = 'user')
  with check ((select auth.uid()) = user_id and origin = 'user');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'memoai-audio',
  'memoai-audio',
  false,
  20971520,
  array['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy memoai_audio_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'memoai-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy memoai_audio_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'memoai-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy memoai_audio_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'memoai-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
