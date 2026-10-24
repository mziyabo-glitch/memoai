# Supabase setup status

Project MemoAi (`zgnzdjrnaznbpcrwsdai`, eu-west-1) is the live database. This file records what was applied there and what is still only in git.

## Applied remotely

Do not run these again. `supabase db push` is safe only when the local filenames match these versions. Replaying the old filenames would try to create tables that already exist.

| Remote version | Repository file | What it is |
| --- | --- | --- |
| `20261024150056` | `supabase/migrations/20261024150056_phase1_personal_schema.sql` | Phase 1 tables. Previously named `20261020225528_phase1_personal_schema.sql`. |
| `20261024150753` | `supabase/migrations/20261024150753_notes_processing_foundation.sql` | Notes jobs, private `memoai-audio` bucket, owner policies. Previously named `20261024105627_notes_processing_foundation.sql`. |
| `20261024150809` | `supabase/migrations/20261024150809_harden_trigger_search_paths.sql` | `search_path` cleared on `set_updated_at` and `protect_processing_job`. |
| `20261024152412` | `supabase/migrations/20261024152412_fix_summary_job_delete.sql` | Summary deletion nulls only `job_id`. Applied remotely under this version. The earlier local name `20261024151532` must not be pushed. |

Nine app tables have row-level security. Anonymous SELECT is denied. The audio bucket is private, limited to 20 MiB, with owner-folder SELECT, INSERT, and DELETE. Security advisors reported no findings after the search-path change. That was configuration review, not an end-to-end test.

The summary foreign key was `(job_id, user_id) ON DELETE SET NULL`, which tried to null `user_id`. `20261024152412` nulls only `job_id`. Do not apply that file again. A `db push` that wants to run `20261024150056`, `20261024150753`, `20261024150809`, or `20261024152412` should be stopped. Those versions are already on MemoAi.

## Not configured

No worker host is deployed. No server secrets are set. No audio has been uploaded and no OpenAI request has been made. The anon key is not in git. Put it only in `apps/mobile/.env`.
