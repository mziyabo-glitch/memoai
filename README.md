# MemoAI

Android-first personal meeting recorder. Phase 1 records on the phone with a native microphone foreground service, keeps the file in app-specific storage, and does not need an account. A development build can show labelled sample notes. A saved recording can store permission for a later transcript on this phone. MemoAI does not upload audio, call a transcription service, or implement iOS.

## Layout

Development coordination: read [the architecture and privacy boundaries](docs/ARCHITECTURE.md) and [the exact next Cursor Cloud Agent task](docs/CURSOR_HANDOFF.md). Use feature branches and PRs; physical-device recording acceptance remains pending.

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

## Connect EAS and install an APK

Expo Go does not contain the microphone foreground service. Install an EAS APK. There are two profiles in `apps/mobile/eas.json`.

1. Sign in at [expo.dev](https://expo.dev).
2. From `apps/mobile`:

   ```bash
   npx eas-cli login
   npx eas-cli init
   ```

   `eas init` links this app and prints the project page on expo.dev (typically `https://expo.dev/accounts/<account>/projects/memoai`). The project id it writes into the Expo config is not a secret. The login token stays on your machine.

### Development APK, with a JavaScript server

Profile `development` sets `developmentClient`, `distribution: internal`, and `android.buildType: apk`. The installed app is a dev client. It does not contain the JavaScript bundle. It loads the bundle from Metro, and recording does not run until that server is connected.

```bash
cd apps/mobile
npx eas-cli build --platform android --profile development
```

Install the APK from the Expo build page. Do not install Expo Go.

On a computer that is on the same LAN as the phone, start Metro and open the project in the dev client:

```bash
cd apps/mobile
npm run start
```

`npm run start` runs `expo start --dev-client`.

A Cursor cloud agent is not on the phone’s LAN, so the phone cannot open a Metro server bound to that VM. From the agent, start Metro through Expo’s tunnel instead. The tunnel is the cloud-hosted bundle server. It uses the Expo account and `@expo/ngrok`. Leave the process running while the phone is open:

```bash
cd apps/mobile
npx expo start --dev-client --tunnel
```

Open the URL that command prints in the development build.

### Preview APK, phone only

Profile `preview` sets `distribution: internal` and `android.buildType: apk`. It does not set `developmentClient`, so EAS embeds the JavaScript bundle. After you install it, the phone records with no computer and no Metro.

```bash
cd apps/mobile
npx eas-cli build --platform android --profile preview
```

Install that APK and open MemoAI. Use this build when you only have the phone. Use the development build when you want to reload JavaScript while working.

Package name: `com.memoai.app`.

Android permissions: `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`. The service and the stop receiver are registered with fully qualified class names (`expo.modules.memoairecorder.MemoAiRecorderService` and `expo.modules.memoairecorder.StopRecordingReceiver`). The service is not exported, uses `foregroundServiceType="microphone"`, and calls `startForeground` with type `MICROPHONE` (API 34+) before `MediaRecorder` starts. The ongoing notification says “MemoAI is recording” and has a Stop action. While capture is paused, including a short audio interruption, the notification says the recording is paused. The system microphone indicator is left visible. The service does not hold a screen wake lock. Audio is AAC in an MPEG-4 `.m4a` under the app’s own files directory.

The notification Stop action is a `PendingIntent.getForegroundService` (API 26+) aimed at the service. `handleStop` calls `startForeground` with the microphone type on API 34+ before it stops capture, then removes the notification. That is the user-initiated foreground-service path, so Stop does not depend on a background `startService` from a broadcast. The receiver is still registered and calls `startForegroundService` if a broadcast arrives. This path is checked from the source and from the merged manifest. It has not been tried on a phone.

Capture starts only after you tap Start or Resume while the app is in the foreground. A notification, navigation prompt, or other short audio loss pauses the same session, keeps the foreground service, and resumes when focus returns. The screen says Paused during that gap. A pause you requested yourself does not resume on its own. A permanent audio-focus loss, a capture failure, or Android stopping the service ends the session as interrupted and keeps the partial file. If `MediaRecorder.stop()` fails, the file is still kept, marked incomplete, and is not offered as a saved playable recording. On the next launch, a saved recording or paused session whose service is gone is recovered as interrupted and is not deleted. Returning to the app with the microphone or notification permission turned off leaves the ready screen and shows the explanation again. A rejected Start, including one that happens while a previous session is already interrupted, returns the error to the app instead of looking successful.

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

GitHub Actions runs lint, TypeScript, and the shared session tests on `push` and `pull_request`. A second job installs Java 21 and the Android SDK, runs `npx expo prebuild --platform android --no-install`, compiles the Kotlin recorder module, merges the app manifest, and checks that the service and receiver class names are fully qualified.

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

- A connected transcription or summary provider. Sample notes are labelled and shown in development only. They are not results from a recording.
- Cloud upload. Create notes explains what finished audio would leave the phone, then saves a yes on the phone. Nothing is sent.
- iOS
- An account requirement for recording
