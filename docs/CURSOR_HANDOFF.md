# Notes worker

`POST /api/notes/step` runs the section-by-section OpenAI worker. A 90-minute recording is still not one audio request. An older file over 25 MB is blocked and the original is not changed. Nothing here is deployed, and no live provider call has been made. Setup is in docs/NOTES_PROCESSING.md. Do not apply SQL from CI.

# Notes processing foundation

Branched from the sample-notes tip `cursor/ai-notes-sample-flow-2f69` (`7e9b06a`, draft PR #6). The worker transcribes one finished audio section per step because OpenAI accepts about 25 MB per request and a 90-minute recording does not fit in one call. Ordered sections from PR #5 are the chunks. A notes call uses the transcript text only after every section has a result. No live paid run is included. See docs/NOTES_PROCESSING.md. Do not apply the new SQL from CI.

# Notes screens on the segmented recorder

The notes branch starts at the tip of `feat/android-segmented-recovery` (draft PR #5, `0a169fe`). That tip already contains the phase 1 recorder, crash-safe metadata, and ordered audio sections. PR #1 and PR #5 are not retargeted or merged.

Development builds add a library search, editable titles, and labelled sample notes with Summary, Transcript, and Actions. Real recordings stay on the phone. Create notes explains an upload and stores explicit permission locally. No provider is called and no audio is uploaded. Release UI does not show the samples.

Do not claim a phone test for the notes screens. The Samsung checks below are still pending for segmented capture. Do not connect a live provider until the processing plan in the notes pull request is accepted.

# Segmented local recording: next acceptance task

The active work is feat/android-segmented-recovery, stacked on PR #4. It includes
PR #2's privacy/backup commit without merging either existing PR. PR #4's preview
at 38e8537 passed the user's Samsung update, playback, long-recording preservation,
new recording, storage display, and force-stop/reopen checks. Those results do
not apply to this new segmented implementation.

## Implemented for review

New sessions use independently finalized AAC/M4A sections with a native
45-second duration limit and a 19 MiB recorder size guard. Actual committed files
must be no larger than 20 MiB. A native limit callback closes/releases the old
recorder, validates its audio track/sample and duration, syncs bytes, renames the
file, hashes it and commits the journal before starting the next section.
Each section's intent is journaled before capture. No automatic capture begins
on launch, process death or reboot. Stop and rotation share the controller lock;
a queued callback after Stop cannot create another section. User Pause keeps
ownership when audio focus returns.

One Library entry exposes the ordered saved sections. Playback advances through
those sections; incomplete or missing sections are identified. Corrupt metadata
and orphan/unfinished files are retained with explicit Recover, Export and
confirmed Delete choices. Export opens the Android chooser only after a tap.
Existing single-file JSON/M4A recordings remain in their original format and are
read alongside the journal, without copying or deleting originals.

## Known limits

Stop/start rotation can introduce gaps. rotationGapMs records callback processing
and restart time; it is not a measurement of all lost audio, hardware latency or
notification delay. Measure actual gaps with continuous spoken/counting audio.
A crash can lose the current unfinished section. Delayed callbacks or OS kills
mean no absolute 45-second loss guarantee. Demux validation is not a guarantee
of successful decoding on every device. File sync/atomic replacement is not a
power-loss guarantee for every filesystem/controller. No upload or AI is added.
Android backup is disabled; OEM transfer behavior still requires device checks.

## Validation to run

Local validation on 2026-10-24: lint and TypeScript checks passed; all 19 shared
tests passed; git diff --check passed. The new native recovery tests have not
run yet. Android compilation, manifest checks and a new APK remain pending.
The owner explicitly authorized uploading this feature branch to
mziyabo-glitch/memoai and opening a draft PR. Merge approval remains separate.

Use Node 22.13+. Run npm ci, npm run lint, npm run typecheck and npm test.
Clean Expo Android prebuild; compile the recorder, merge/check the manifest,
and run :memoai-recorder:testDebugUnitTest. The native tests inject filesystem
crash points and recorder events; they do not record or decode real microphone
audio. Keep the PR draft until hardware acceptance.

## Samsung acceptance (all pending for this phase)

- Install the preview over the current app; never uninstall or clear data.
- Verify the existing 1.5-hour recording and other old items still play.
- Make a 3-minute recording: check ordered sections, total duration, storage,
  automatic playback through all sections, Stop play, and repeat playback.
- Record offline, locked and face down for 30 minutes. Use a continuous audible
  counter to measure gaps at section boundaries. Record phone/OS/build SHA.
- Pause/resume around 45 seconds; test transient audio focus and user Pause.
- Stop in-app and from the notification at a boundary; repeat Stop quickly.
- Force-stop after at least two sections, then reopen twice. Saved sections must
  play; unfinished files must remain available with honest labels.
- Reboot, revoke microphone/notification permissions, toggle mic privacy, and
  test low/full disk using disposable recordings. Report loss and failure state.
- Try Recover/Export/Delete on a disposable incomplete file; cancellation keeps it.
- Verify backup and device-transfer behavior separately. Do not publish private audio.

Build from a clean clone outside OneDrive to avoid read-only directory attributes
in the upload archive. From apps/mobile use the existing linked Expo project and
signing key: npx eas-cli build --platform android --profile preview.
Inspect the archive first with eas build:inspect --stage archive. The preview
includes JavaScript and does not need Metro. Do not change signing credentials.

After acceptance: review remaining recovery issues, then plan separate upload
consent, private owner-isolated storage and authenticated processing. Do not
merge PRs or add cloud behavior without the owner's instruction.
