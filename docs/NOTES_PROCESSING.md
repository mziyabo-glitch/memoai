# Notes processing

The worker transcribes one finished audio section per OpenAI request, then writes notes from the transcript text. A 90-minute recording is not sent as one audio file. This repository does not deploy the worker and does not call OpenAI.

## What is implemented

- `POST /api/notes/step` loads the owner's job with the service role, checks consent, the 90-minute cap, and storage paths, then runs the section loop.
- Each transcription request uses an `Idempotency-Key`. A timeout or HTTP 408, 409, 429, or 5xx is stored as uncertain and is not repeated.
- A definite refusal (for example HTTP 400) can be retried up to three times.
- Notes are grounded against the transcript. Owners and deadlines are kept only when those words are in the cited passage.
- Deleting the job sets `deleted_at`. A result that arrives after that is not published.
- An older single file larger than 25 MB is not cut. The phone explains that the original stays put. A copy is made only for ranges the caller has already marked as independently decodable audio. This app does not invent those ranges for an m4a file.

## What is deployed

Nothing in this change is deployed. CI does not apply SQL, start a worker, or set secrets.

## What was verified live

Nothing. Tests use mocked HTTP. No project was contacted and no audio was sent to OpenAI.

## Secrets

Do not commit these values. Do not put a service-role key or an OpenAI key in `EXPO_PUBLIC_` or `NEXT_PUBLIC_` variables.

Phone, in an untracked `apps/mobile/.env`:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Worker host (Vercel project environment, or the machine that will call the route). Set them in that dashboard, not in git:

- `SUPABASE_URL` — Project Settings → API → Project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → service_role secret
- `OPENAI_API_KEY` — OpenAI dashboard API keys
- `MEMOAI_WORKER_SECRET` — a long random string you choose. The phone does not get this.
- `OPENAI_TRANSCRIBE_MODEL` — optional, default `gpt-transcribe`
- `OPENAI_NOTES_MODEL` — optional, default `gpt-4.1-mini`

Leave `MEMOAI_ALLOW_PROVIDER` unset. Set it to `1` only for a paid run you intend to make. Without it, the route returns 409 and does not call OpenAI.

## Database

Apply these yourself, in order, in the Supabase SQL editor (or `supabase db push` when you choose). CI does not run them.

1. `supabase/migrations/20261020225528_phase1_personal_schema.sql`
2. `supabase/migrations/20261024105627_notes_processing_foundation.sql`

The second file creates the private `memoai-audio` bucket, processing tables, and owner RLS. Authenticated users can queue, cancel, and delete their own jobs. They cannot write rows as the worker. The service role does that.

## Run the worker

Deploy the web app yourself when you want it reachable. This repo does not deploy it.

The route is `POST /api/notes/step` with `Authorization: Bearer <MEMOAI_WORKER_SECRET>` and JSON `{ "jobId": "<processing_jobs.id>", "ownerId": "<auth user id>" }`. `ownerId` must match the job. The handler then transcribes each finished section and, after those transcripts exist, asks for notes. `maxDuration` is 300 seconds for hosts that honor it. If the host stops the process after a request was sent and the outcome is unknown, the next call pauses instead of sending that section again. Sections that were not sent can continue.

Recording on the phone still works with no account. Upload still requires the existing consent screen and still skips recovery files.
