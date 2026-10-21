# MemoAI working agreement

- Use feature branches and PRs. Never push to main or merge your own PR. Coordinate with the existing Cursor PR instead of rebuilding its scaffold.
- Read README.md and docs/ARCHITECTURE.md. Keep PRs small enough to review from a phone.
- Android native service owns capture. Start only after an explicit user action in a visible activity with permissions and consent. Face-down placement never starts recording. No boot starts, sticky service restarts, JS background timers or browser guarantees.
- Preserve Android microphone indicators and a visible recording notification with Stop. Never hide or circumvent platform privacy controls.
- Local recording works without an account. Upload and AI processing require separate explicit consent. Never commit real audio, transcripts, keys, tokens, signing credentials or private identifiers.
- OpenAI and Supabase service-role keys stay server-side. Cloud data and audio require owner isolation and private Storage policies.
- Service acknowledgement controls UI labels. Preserve interrupted files; never label undecodable files recovered or saved. Do not silently restart capture after process death.
- Run npm run lint, npm run typecheck and npm test. Native/config changes need a clean Expo prebuild, merged-manifest checks and Android compile. Clearly distinguish source checks, builds, emulator tests and physical-device evidence.
- Keep docs/CURSOR_HANDOFF.md updated with the next bounded task and exact acceptance checks. No device success claims without evidence.
