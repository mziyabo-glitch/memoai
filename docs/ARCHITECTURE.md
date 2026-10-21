# MemoAI foundation

## Current repository state

At the initial inspection the repository was empty. During setup, main received its initial README and Cursor opened PR #1, Phase 1: Android microphone recording foundation, on cursor/phase-1-android-recording-cf54. This foundation follow-up is based on that branch, preserving its implementation. It does not replace or merge PR #1.

The current stack is Expo SDK 58 / React Native 0.88 with a local Kotlin Expo recorder module, Next.js web shell, shared session logic and a Supabase SQL schema. Use Node 22.13 or later, matching Expo SDK 58. The recorder uses a microphone foreground service, app-private M4A files and JSON metadata. These are implemented but physical-device acceptance remains pending. There are no implemented cloud uploads, authentication or AI processing. Database SQL alone does not configure private audio Storage.

## Capture and recovery

Explicit Start in a visible activity -> microphone/notification permissions and recording consent -> native foreground service -> local audio and metadata. Native acknowledgements determine UI state. The ongoing notification with Stop and platform microphone indicator must remain visible. Face-down means physical placement after Start, never automatic activation. Existing transient audio-focus recovery is limited to the same live service/session; process death must never restart the microphone.

Background and locked-screen recording require the installed Android app, not a phone browser. A browser can manage GitHub, Cursor, Expo builds and the later dashboard. Use the existing EAS preview APK for phone-only acceptance because it embeds JavaScript and needs no Metro server. Force-stop, revoked permissions and manufacturer battery restrictions can interrupt capture; no absolute continuity guarantee is justified.

The current single M4A can be undecodable if the process dies before finalization. JSON rename alone does not guarantee power-loss durability, and malformed metadata must not silently make audio disappear. The next milestone is a native journal with short independently playable segments, checked finalization, atomic rename, synced bytes and startup reconciliation. Preserve partial/orphan files and show uncertainty honestly. Segmentation is a planned improvement, not implemented by this follow-up.

Disable Android cloud backup for private audio (allowBackup=false). Some manufacturers' device-to-device transfer behavior differs; verify backup/data-extraction rules against the generated manifest and supported devices before claiming data never leaves the device through OS transfer. App-private storage does not imply application-level encryption. Avoid promising end-to-end encryption when server AI processing needs readable audio.

## Private cloud and AI plan

Supabase Auth establishes identity; secure device storage holds refresh tokens. Local recording must remain available without an account. Ask separately before upload and AI processing. Account changes cannot reassign or upload another user's pending notes.

Extend the existing meetings/recordings schema through additive migrations. Do not introduce a second incompatible recordings table. Add segment metadata, explicit consent records, durable processing jobs and a private audio bucket. RLS must bind every object to the authenticated owner and its recording. Reject forged owner IDs and cross-account paths. Test anonymous, owner A and owner B access before deployment. Schema owner policies do not by themselves protect an unconfigured bucket.

Upload finalized segments only. Use immutable object paths, hashes, size limits and idempotent retry. Persist upload acknowledgement and keep local audio until explicit deletion. Cloud deletion must remove Storage objects as well as rows; SQL cascades do not remove object bytes. Document backup retention and account-deletion cleanup.

An authenticated server endpoint verifies JWT, ownership, explicit processing consent, size, MIME/decoder validity, quota and rate limits, then enqueues durable work. Never accept arbitrary audio URLs. A worker uses server-only OpenAI credentials to transcribe bounded audio files in order, then validates a structured summary and proposed actions. Use leases, retry limits, idempotency and prompt/model versioning. Keep audio, transcripts, signed URLs and tokens out of logs. The existing client-writable summaries are not yet trusted AI provenance; distinguish user edits from worker output when adding processing.

Transcripts are untrusted content. Suggested dates/owners can be unknown; do not invent them or execute email/calendar/payment instructions embedded in recordings. External actions need a later explicit user confirmation.

Vercel hosts the later authenticated Next.js dashboard for search, playback, export and deletion. It does not own recording. Long transcription requests belong in a durable worker appropriate to runtime limits, not a synchronous dashboard request.

## Sources checked

- [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Expo native development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo SDK/runtime compatibility](https://docs.expo.dev/versions/latest/)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
