# Notes processing

This is the server-side foundation. It does not call OpenAI during tests or CI.

## Why one section at a time

OpenAI's transcription endpoint accepts a file up to 25 MB. A 90-minute recording is larger than that and is already stored as ordered AAC sections of about 45 seconds, each at most 20 MiB. The worker transcribes one finished section per invocation, then writes the summary from the transcript text. It does not send the whole recording in one audio request. A section step fits a short serverless invocation. The recording is finished by repeating the step, not by holding one long request open.

Uncertain provider timeouts are not retried automatically. A definite rejection, such as a file the provider refused before accepting it, can be retried up to three times. A completed result for the same owner, section hashes, and models is reused.

## What you set, and where

Do not commit these values.

Phone or dev client, in `apps/mobile/.env`:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Web, in `apps/web/.env.local`, only if the site needs the anon key:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Worker host dashboard (Vercel project env, or the machine that runs the step). These must not use an `EXPO_PUBLIC_` or `NEXT_PUBLIC_` name:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `MEMOAI_WORKER_SECRET`
- `OPENAI_TRANSCRIBE_MODEL` optional, default `gpt-transcribe`
- `OPENAI_NOTES_MODEL` optional, default `gpt-4.1-mini`

Leave `MEMOAI_ALLOW_PROVIDER` unset. Set it to `1` only when you intend a paid call. The step route still refuses to start that call from this deployment.

## Database

Run the phase 1 migration first, then `supabase/migrations/20261024105627_notes_processing_foundation.sql`, in the Supabase SQL editor or with `supabase db push` when you choose. Nothing in this repo applies it for you.

The `memoai-audio` bucket is private. Object paths start with the owner's user id. Authenticated users can upload and delete only their prefix. They can queue a job and cancel or delete it. They cannot mark a job completed or store a row as worker output. The service role does that.

## Phone flow

Recording still works signed out. Create notes explains the upload. Agreeing stores permission on the phone. Upload finished audio is available after sign-in and that agreement. Recovery files are not uploaded. Acknowledged sections are not sent again. Delete uploaded audio removes the objects and blocks a later result from being saved.

Sample notes stay in the development Samples section and are refused by the upload planner.

## Checked here

Unit tests cover ownership, consent, the 90-minute cap, section retries, uncertain timeouts, reuse, and deletion. They use a fake provider. No audio was sent to OpenAI.
