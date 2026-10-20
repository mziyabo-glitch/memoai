-- Phase 1 schema for MemoAI personal meetings.
-- Recording works offline without this database. Nothing here generates
-- transcripts, summaries, or uploads.
-- Each row is owned by auth.users. Policies use (select auth.uid()) so the
-- check is planned once per statement. user_metadata is not used.

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled meeting',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meetings_id_user_unique unique (id, user_id),
  constraint meetings_time_order check (
    ended_at is null or started_at is null or ended_at >= started_at
  )
);

create table public.recordings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meeting_id uuid not null,
  storage_path text,
  duration_ms integer,
  status text not null default 'stored',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recordings_id_user_unique unique (id, user_id),
  constraint recordings_id_meeting_user_unique unique (id, meeting_id, user_id),
  constraint recordings_meeting_owner_fk
    foreign key (meeting_id, user_id)
    references public.meetings (id, user_id)
    on delete cascade,
  constraint recordings_duration_nonnegative check (duration_ms is null or duration_ms >= 0),
  constraint recordings_status_known check (status in ('stored', 'interrupted', 'complete'))
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meeting_id uuid not null,
  recording_id uuid not null,
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transcript_segments_meeting_owner_fk
    foreign key (meeting_id, user_id)
    references public.meetings (id, user_id)
    on delete cascade,
  -- meeting_id must be the meeting that owns recording_id. Separate
  -- foreign keys would allow meeting B with a recording from meeting A.
  constraint transcript_segments_recording_meeting_fk
    foreign key (recording_id, meeting_id, user_id)
    references public.recordings (id, meeting_id, user_id)
    on delete cascade,
  constraint transcript_segments_range check (start_ms >= 0 and end_ms >= start_ms)
);

create table public.summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meeting_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint summaries_id_user_unique unique (id, user_id),
  constraint summaries_meeting_owner_fk
    foreign key (meeting_id, user_id)
    references public.meetings (id, user_id)
    on delete cascade
);

create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meeting_id uuid not null,
  summary_id uuid,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_items_meeting_owner_fk
    foreign key (meeting_id, user_id)
    references public.meetings (id, user_id)
    on delete cascade,
  constraint action_items_summary_owner_fk
    foreign key (summary_id, user_id)
    references public.summaries (id, user_id)
    on delete cascade
);

comment on table public.transcript_segments is
  'Schema only in phase 1. The app does not generate transcripts.';

comment on table public.summaries is
  'Schema only in phase 1. The app does not generate summaries.';

create index meetings_user_created_idx
  on public.meetings (user_id, created_at desc);

create index recordings_user_created_idx
  on public.recordings (user_id, created_at desc);

create index recordings_meeting_idx
  on public.recordings (meeting_id);

create index transcript_segments_recording_idx
  on public.transcript_segments (recording_id, start_ms);

create index transcript_segments_meeting_idx
  on public.transcript_segments (meeting_id);

create index summaries_meeting_idx
  on public.summaries (meeting_id);

create index action_items_meeting_idx
  on public.action_items (meeting_id);

create index action_items_user_open_idx
  on public.action_items (user_id, created_at desc)
  where done = false;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

create trigger recordings_set_updated_at
  before update on public.recordings
  for each row execute function public.set_updated_at();

create trigger transcript_segments_set_updated_at
  before update on public.transcript_segments
  for each row execute function public.set_updated_at();

create trigger summaries_set_updated_at
  before update on public.summaries
  for each row execute function public.set_updated_at();

create trigger action_items_set_updated_at
  before update on public.action_items
  for each row execute function public.set_updated_at();

alter table public.meetings enable row level security;
alter table public.recordings enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.summaries enable row level security;
alter table public.action_items enable row level security;

-- Default privileges on some projects grant every operation to anon and
-- authenticated. Take those back, then grant only the signed-in role.
revoke all on table public.meetings from public, anon, authenticated;
revoke all on table public.recordings from public, anon, authenticated;
revoke all on table public.transcript_segments from public, anon, authenticated;
revoke all on table public.summaries from public, anon, authenticated;
revoke all on table public.action_items from public, anon, authenticated;

grant select, insert, update, delete on table public.meetings to authenticated, service_role;
grant select, insert, update, delete on table public.recordings to authenticated, service_role;
grant select, insert, update, delete on table public.transcript_segments to authenticated, service_role;
grant select, insert, update, delete on table public.summaries to authenticated, service_role;
grant select, insert, update, delete on table public.action_items to authenticated, service_role;

create policy meetings_select_own
  on public.meetings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy meetings_insert_own
  on public.meetings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy meetings_update_own
  on public.meetings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy meetings_delete_own
  on public.meetings for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy recordings_select_own
  on public.recordings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy recordings_insert_own
  on public.recordings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy recordings_update_own
  on public.recordings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy recordings_delete_own
  on public.recordings for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy transcript_segments_select_own
  on public.transcript_segments for select to authenticated
  using ((select auth.uid()) = user_id);

create policy transcript_segments_insert_own
  on public.transcript_segments for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy transcript_segments_update_own
  on public.transcript_segments for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy transcript_segments_delete_own
  on public.transcript_segments for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy summaries_select_own
  on public.summaries for select to authenticated
  using ((select auth.uid()) = user_id);

create policy summaries_insert_own
  on public.summaries for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy summaries_update_own
  on public.summaries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy summaries_delete_own
  on public.summaries for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy action_items_select_own
  on public.action_items for select to authenticated
  using ((select auth.uid()) = user_id);

create policy action_items_insert_own
  on public.action_items for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy action_items_update_own
  on public.action_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy action_items_delete_own
  on public.action_items for delete to authenticated
  using ((select auth.uid()) = user_id);
