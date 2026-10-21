# Exact next Cursor Cloud Agent task

From your phone browser, open Cursor Cloud Agents, select mziyabo-glitch/memoai and the branch containing this follow-up. Paste the task below. Run one agent per branch. Review its draft PR in GitHub and bring that link to ChatGPT for review. The owner approves merges; agents do not merge. Do not paste secrets or private recordings into prompts or public PRs.

## Paste into Cursor

Continue MemoAI from feat/foundation-recovery-contracts. If that branch and PR #1 have already been merged, start from main instead. Read AGENTS.md, README.md and docs/ARCHITECTURE.md. Create feat/android-durable-recovery. Open a draft PR against feat/foundation-recovery-contracts, or main if already merged. Do not push to main, merge PRs, replace the existing scaffold or add cloud features.

Implement durable local segmented recording and recovery in the existing Kotlin Expo module. Keep the public UI honest and preserve Pause/Resume, notification Stop, explicit foreground Start, current consent flow, system microphone indicators and START_NOT_STICKY. No automatic face-down starts or process-death microphone restart. Preserve existing transient audio-focus behavior for the live session and ensure a user pause never auto-resumes.

Replace the fragile single-file recovery path with a native journal and short independently playable AAC/M4A segments, targeting 30–60 seconds and a maximum upload size of 20 MiB per segment. Measure rotation gaps; do not promise seamless capture without device evidence. Journal session intent before capture. Finalize each segment, validate playability, sync bytes, atomically rename, then commit its UUID, sequence, byte count and SHA-256. Use one authoritative journal with concurrency control and crash-safe writes. Migrate existing JSON/session files without deleting originals until verified.

On launch reconcile metadata, finalized files, partial files and orphan files. Preserve corrupt metadata and undecodable partial audio and show an explicit recovery/export/delete choice. Never report saved/recovered without validation. Repeated reconciliation must be idempotent. Wire the UI to native status on foreground/reconnect. Handle duplicate Start/Stop, storage-full failures, permission loss and Stop racing segment rotation. Keep Android backup disabled and inspect generated data-extraction/backup behavior; do not claim OEM transfer protection without evidence.

Use Node 22.13+. Run npm ci, npm run lint, npm run typecheck, npm test, clean Expo Android prebuild, the existing merged-manifest check and Android Gradle compilation. Add meaningful native tests for crash points (before/after finalize, rename, journal commit), rotation/Stop races and legacy migration. Do not treat TypeScript state tests as native durability proof. Provide the exact EAS preview APK build command; it must contain the JavaScript bundle and work without Metro after installation. Do not invent EAS project IDs or signing credentials.

Run hardware checks on a physical Android 14+ device, including Samsung if available: offline 30-minute face-down locked-screen recording, notification Stop, playback/duration/rotation-gap checks, incoming calls, pause/resume, process death, reboot, mic privacy toggle, permission revocation and full disk. Record build SHA, phone/OS, actual results and any data loss; do not attach private audio publicly. If no phone is available, leave hardware checks explicitly pending and the PR draft. Summarize changes, checks, limitations and the next step in language readable from a phone.

## After local recovery acceptance

1. Supabase Auth, secure token storage, separate upload/AI consent and private audio bucket with owner-isolation tests; resumable/idempotent uploads and object deletion.
2. Authenticated enqueue endpoint and durable worker with server-only OpenAI transcription, validated summaries/actions, quotas, leases and safe retries.
3. Authenticated Vercel dashboard for search, playback, export and deletion. Keep recording native.

For phone acceptance use apps/mobile's existing EAS preview profile (`npx eas-cli build --platform android --profile preview`) after an authorized operator links the Expo project. A cloud-agent Metro server is unnecessary for the preview APK. Account linking/signing setup and physical testing still require the owner's environment.
