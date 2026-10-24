# Notes processing

MemoAI stores finished audio in sections of at most 20 MiB. That is the private `memoai-audio` bucket limit and the `audio_sections` limit. OpenAI accepts up to 25 MB per transcription request, so a stored section fits in one request. A 90-minute recording is still many sections, not one upload.

An older file larger than 20 MiB is not cut. The phone explains that the original stays where it is. A copy is made only for ranges the caller has already marked as independently decodable. This app does not invent those ranges for an m4a file.

## What is implemented

- Sign-in is required before upload. Recording still works with no account.
- `POST /api/notes/step` accepts the signed-in user's Supabase access token. It checks that the job belongs to that user. The phone has no worker secret and no service-role key.
- The same route accepts `Authorization: Bearer <MEMOAI_WORKER_SECRET>` for a scheduler. That secret stays in the host dashboard.
- Each section is one OpenAI call. The route stops before starting another section when less than 90 seconds remain of a 240 second budget (`MEMOAI_STEP_BUDGET_MS`). A call that already left and then times out is marked uncertain and is not repeated.
- Deleting a job no longer has to null `summaries.user_id`. Migration `20261024151532_fix_summary_job_delete.sql` nulls only `job_id`. It is in git and was not applied to MemoAi by this change.
- Paid processing stays off unless `MEMOAI_ALLOW_PROVIDER=1`.

## What is deployed

The MemoAi database and private bucket are already live. See `docs/SUPABASE_SETUP_STATUS.md`. No worker host was deployed. No server secrets were configured.

## What was verified live

The project host answers at `https://zgnzdjrnaznbpcrwsdai.supabase.co` (auth health without a key returns 401). This session could not run SQL there: the connected Supabase account can see a different project, and that project was not used. No audio was uploaded and no OpenAI request was made. Mobile sign-in is still unverified.

Job deletion with a linked summary was executed in Postgres (PGlite), including the ownership check and the new `ON DELETE SET NULL (job_id)` statement.

## Secrets

Do not commit these. Do not put a service-role key, an OpenAI key, or `MEMOAI_WORKER_SECRET` in `EXPO_PUBLIC_` or `NEXT_PUBLIC_` variables, in the app, or in logs.

Phone, untracked `apps/mobile/.env`:

- `EXPO_PUBLIC_SUPABASE_URL=https://zgnzdjrnaznbpcrwsdai.supabase.co`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` from Project Settings → API → anon public
- `EXPO_PUBLIC_NOTES_API_URL` only after the web app is deployed, for example `https://<your-host>`

Worker host dashboard (the machine or Vercel project that runs `apps/web`, not the phone):

- `SUPABASE_URL=https://zgnzdjrnaznbpcrwsdai.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` from Project Settings → API → service_role
- `OPENAI_API_KEY` from the OpenAI dashboard, when a paid run is intended
- `MEMOAI_WORKER_SECRET` a long random string you choose
- `MEMOAI_STEP_BUDGET_MS` optional, default 240000
- `OPENAI_TRANSCRIBE_MODEL` optional, default `gpt-transcribe`
- `OPENAI_NOTES_MODEL` optional, default `gpt-4.1-mini`

Leave `MEMOAI_ALLOW_PROVIDER` unset until you intend to pay for transcription. The route then returns 409 and does not call OpenAI.

## Database

Remote history already includes the phase 1 schema, the notes foundation, and the search-path hardening. Apply only `supabase/migrations/20261024151532_fix_summary_job_delete.sql`. Stop if a push wants to recreate the earlier files. Details are in `docs/SUPABASE_SETUP_STATUS.md`.

## Worker host

A long recording does not fit in one hosting invocation. Use a Node host for `apps/web` (Vercel or similar). The route's `maxDuration` is 300 seconds. The worker budget is 240 seconds so it can finish the section it already sent and leave the rest queued.

The phone starts a job by posting its access token after a consented upload. A scheduler continues a queued job by posting the worker secret and `{ "jobId": "<processing_jobs.id>" }`. Put that scheduler in the host dashboard. Do not put the secret on the phone.

Nothing in this repo deploys that host or creates the scheduler.
