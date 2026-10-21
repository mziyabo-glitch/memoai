# Local recovery: atomic metadata milestone

This branch starts from the recording foundation after PR #3. It does not include
the separate PR #2 privacy/configuration follow-up.

RecordingStore now uses Android AtomicFile rather than falling back to directly
overwriting committed JSON. Reads and writes share the store monitor, including
orphan reconciliation. Existing JSON remains readable, backup-only records are
restored through AtomicFile, and unreadable JSON/legacy temporary files stay on disk.

Native Robolectric tests cover an interrupted replacement, backup-only recovery,
legacy metadata, preservation of corrupt files, concurrent readers/writers, and
idempotent orphan reconciliation. CI runs these after Android compilation and
the merged-manifest checks.

This protects metadata replacement; it does not make an unfinished M4A playable.
Unreadable metadata remains preserved but is not yet exposed in the Library.
No new physical-device test or power-loss durability guarantee is claimed.

## Next bounded task

Reconcile preserved corrupt metadata and orphan audio into explicit recovery
entries with export/delete choices, without claiming undecodable audio is saved.
Then implement short independently finalized audio segments, a durable journal,
rotation/Stop race tests, and legacy migration before cloud upload or AI work.
Coordinate PR #2's backup settings and architecture agreement before that stage.

## Phone acceptance for this change (pending)

- Install an EAS preview APK over Build 003; confirm old Library items still play.
- Record, pause/resume and stop; check labels, sizes and duration.
- Kill the process while recording, reopen twice; confirm the session is
  interrupted and files are retained. A partial M4A may remain undecodable.
- Repeat the locked-screen and notification Stop checks.

Preview build from apps/mobile: `npx eas-cli build --platform android --profile preview`.
