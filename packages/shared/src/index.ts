export {
  SESSION_STATES,
  formatDuration,
  isRecordingLabelAllowed,
  parseSessionState,
  projectVisibleState,
  recordingElapsedMs,
  reconcileSession,
  reduceSession,
} from "./session";

export { formatFileSize, totalRecordingBytes } from "./storage";

export {
  MAX_NOTES_AUDIO_MS,
  NOTES_UPLOAD_EXPLANATION,
  TITLE_MAX_LENGTH,
  acceptNotesConsent,
  audioPartLabel,
  cleanTitle,
  formatClock,
  formatNotesForShare,
  groundNotes,
  locateAudioSection,
  matchesTitleQuery,
  notesConsentRecord,
  recordingNotesLabel,
  recordingNotesPhase,
  sampleNotesLabel,
  sectionStartMs,
} from "./notes";

export {
  DEFAULT_LEASE_MS,
  MAX_DEFINITE_ATTEMPTS,
  MAX_SECTION_BYTES,
  NOTES_MODEL,
  OPENAI_MAX_AUDIO_BYTES,
  TRANSCRIBE_MODEL,
  audioObjectPath,
  cancelJob,
  claimStep,
  createJob,
  deleteJob,
  describeCloud,
  findReusableJob,
  interpretUploadError,
  markRequestSent,
  pathOwnedBy,
  planUpload,
  processingKey,
  runSectionUploads,
  settleStep,
  shouldPublish,
  storagePaths,
} from "./processing";

export { SAMPLE_NOTE_DRAFTS } from "./sampleNotes";

export type {
  AcknowledgedSection,
  CloudPhase,
  ProcessJob,
  ProcessStep,
  SectionInput,
  StepPhase,
  StepSettlement,
  UploadBlockReason,
  UploadPlan,
} from "./processing";

export type {
  AudioPart,
  GroundedNotes,
  NotesAction,
  NotesConsentRecord,
  NotesDraft,
  NotesOverviewLine,
  NotesPassage,
  NotesPoint,
  RecordingNotesPhase,
} from "./notes";

export type {
  CommandResult,
  ServicePhase,
  ServiceSnapshot,
  SessionCommand,
  SessionSnapshot,
  SessionState,
  VisibleSession,
} from "./session";
