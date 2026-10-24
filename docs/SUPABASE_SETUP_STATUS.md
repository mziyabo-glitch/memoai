# Supabase setup status

Project MemoAi (`zgnzdjrnaznbpcrwsdai`, eu-west-1) is the live database. This file records what was applied there and what is still only in git.

## Applied remotely

Do not run these again. `supabase db push` is safe only when the local filenames match these versions. Replaying the old filenames would try to create tables that already exist.

| Remote version | Repository file | What it is |
| --- | --- | --- |
| `20261024150056` | `supabase/migrations/20261024150056_phase1_personal_schema.sql` | Phase 1 tables. Previously named `20261020225528_phase1_personal_schema.sql`. |
| `20261024150753` | `supabase/migrations/20261024150753_notes_processing_foundation.sql` | Notes jobs, private `memoai-audio` bucket, owner policies. Previously named `20261024105627_notes_processing_foundation.sql`. |
| `20261024150809` | `supabase/migrations/20261024150809_harden_trigger_search_paths.sql` | `search_path` cleared on `set_updated_at` and `protect_processing_job`. |

Nine app tables have row-level security. Anonymous SELECT is denied. The audio bucket is private, limited to 20 MiB, with owner-folder SELECT, INSERT, and DELETE. Security advisors reported no findings after the search-path change. That was configuration review, not an end-to-end test.

## Not applied yet

`supabase/migrations/20261024151532_fix_summary_job_delete.sql`

The original summaries foreign key is `(job_id, user_id) ON DELETE SET NULL`. Postgres then tries to null `user_id` as well. `user_id` is required, so deleting a job that has a summary fails, and deleting that account can fail too. The new migration nulls only `job_id`. A summary still has to name the same owner when it points at a job.

This agent could not apply it. The Supabase connection available here can see a different project, not MemoAi. Nothing was changed on that other project. Paste the new file into the MemoAi SQL editor, or link this repo to `zgnzdjrnaznbpcrwsdai` and run `supabase db push`. That push should list only `20261024151532` as pending. If it wants to run `20261024150056` or `20261024150753`, stop. Those are already applied under those version numbers.

## Not configured

No worker host is deployed. No server secrets are set. No audio has been uploaded and no OpenAI request has been made. The anon key is not in git. Put it only in `apps/mobile/.env`.
