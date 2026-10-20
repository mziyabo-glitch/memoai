# MemoAI

Android-first personal meeting recorder. Phase 1 records on the phone with a native microphone foreground service, keeps the file in app-specific storage, and does not need an account. It does not transcribe, summarize, upload, or implement iOS.

## Layout

- `apps/mobile` — React Native + Expo development build (`expo-dev-client`). Expo Go is not supported.
- `apps/mobile/modules/memoai-recorder` — autolinked Kotlin Expo module. This is the recorder.
- `apps/web` — Next.js page for Vercel. It does not record.
- `packages/shared` — session states and the rule that a recording label is shown only when the service confirms it.
- `supabase/migrations` — SQL only. CI does not apply it and does not call Supabase.

## Keys stay out of git

API keys, `.env` files, keystores, and credentials are gitignored. The only env file in git is `.env.example`. Paste the Supabase URL and anon key into a local env file or into the host dashboard. Do not commit a service-role key, a keystore, or an EAS token.

Recording works with Supabase unset.

## Connect Supabase

The phone records without a Supabase project. Use the dashboard when you want the tables:

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) and create a project.
2. Open **Project Settings → API**.
3. Copy the project URL and the anon public key.
4. Put them in `apps/mobile/.env` and `apps/web/.env.local` using the names in `.env.example`.
5. When you want the cloud tables, paste `supabase/migrations/20261020225528_phase1_personal_schema.sql` into the dashboard SQL editor and run it yourself. This repo does not apply that migration and does not connect with a real key.

Row level security is enabled. Each row is scoped by `user_id` to `auth.users`, and the policies allow select, insert, update, and delete only for that user. There is no transcription job in this phase.

## Connect EAS and build the development APK

The Android app is a development build. Expo Go does not contain the microphone foreground service.

1. Sign in at [expo.dev](https://expo.dev).
2. From `apps/mobile`:

   ```bash
   npx eas-cli login
   npx eas-cli init
   ```

   `eas init` links this app and prints the project page on expo.dev (typically `https://expo.dev/accounts/<account>/projects/memoai`). The project id it writes into the Expo config is not a secret. The login token stays on your machine.

3. Build an internal Android APK:

   ```bash
   npx eas-cli build --platform android --profile development
   ```

   `apps/mobile/eas.json` profile `development` sets `developmentClient`, `distribution: internal`, and `android.buildType: apk`.

4. Install that APK. Do not install Expo Go for this.
5. From `apps/mobile`, start the bundler and open the project in the development build on the same network:

   ```bash
   npm run start
   ```

Package name: `com.memoai.app`.

Android permissions: `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`. The service is not exported, uses `foregroundServiceType="microphone"`, and calls `startForeground` with type `MICROPHONE` (API 34+) before `MediaRecorder` starts. The ongoing notification says “MemoAI is recording” and has a Stop action. The system microphone indicator is left visible. The service does not hold a screen wake lock. Audio is AAC in an MPEG-4 `.m4a` under the app’s own files directory.

Capture starts only after you tap Start or Resume while the app is in the foreground. If Android stops the service, or audio focus or capture ends, the partial file is kept and the session becomes interrupted. On the next launch, a saved recording or paused session whose service is gone is recovered as interrupted and is not deleted.

## Connect Vercel

1. Import this GitHub repository at [vercel.com/new](https://vercel.com/new).
2. Set the root directory to `apps/web`. Framework preset: Next.js.
3. Optional: add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the Vercel project’s environment settings. Do not commit them. The current page does not read them.
4. Deploy. The page is a dark introduction. It is not a web recorder.

## Checks

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

GitHub Actions runs lint, TypeScript, and the shared session tests on `push` and `pull_request`.

`npm test` covers the session states `idle`, `recording`, `paused`, `interrupted`, and `stopped`, including the invariant that recording is shown only when the service confirms it.

## Hardware acceptance (not run)

This change has **not** been verified on a phone. No Android emulator run and no physical device run are claimed. The Samsung test below is required before calling phase 1 accepted.

1. Install the EAS development APK (not Expo Go) on a Samsung phone.
2. Grant mic and notification permissions after the in-app explanation.
3. Start a recording from the button. Confirm the ongoing notification and the system microphone indicator.
4. Lock the screen and place the phone face down for 30 minutes. Switch apps before locking as well, in a shorter extra pass.
5. Unlock. The timer/duration should be about 30 minutes and the UI may say recording only if the service is actually still recording. If Android stopped it, the UI must say interrupted, not recording.
6. Stop, then play the file. Audio should be continuous and the saved duration should match.

Shorter device checks, also not run:

- Pause and resume. Paused time is excluded from the duration.
- Switch apps during a recording and confirm the notification remains and the UI matches the service.
- Kill the app mid-recording, reopen it, and confirm the partial file is still there and the session is interrupted, not recording.
- Deny microphone or notification permission and confirm recording does not start.

A force-stop from the system can kill the process before `MediaRecorder.stop()` finalizes the MPEG-4 file. The file is still kept, and the next launch must show interrupted rather than recording. The 30-minute locked, face-down test is the one that has to show a continuous file after a normal Stop.

## Phase 1 does not include

- AI transcription, summary generation, or action-item generation
- Cloud upload
- iOS
- An account requirement for recording
