/**
 * Notes processing rules. This module does not call a network or read a key.
 * A 90-minute recording is transcribed one finished section at a time.
 * Each section must fit in one provider request. The whole recording is not
 * sent as one audio file.
 */

import {
  MAX_NOTES_AUDIO_MS,
  groundNotes,
  type GroundedNotes,
  type NotesDraft,
  type NotesPassage,
} from "./notes";

/** OpenAI transcription requests accept files up to 25 MB. */
export const OPENAI_MAX_AUDIO_BYTES = 25_000_000;
/** Matches the recorder's per-section cap. */
export const MAX_SECTION_BYTES = 20 * 1024 * 1024;
export const TRANSCRIBE_MODEL = "gpt-transcribe";
export const NOTES_MODEL = "gpt-4.1-mini";
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;
export const MAX_DEFINITE_ATTEMPTS = 3;

const HASH = /^[a-f0-9]{64}$/;

export type SectionInput = {
  sequence: number;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  /** False for an unfinished recovery file. Those files are not uploaded. */
  finished: boolean;
};

export type AcknowledgedSection = {
  sequence: number;
  sha256: string;
};

export type UploadBlockReason =
  | "sample"
  | "no-account"
  | "no-consent"
  | "too-long"
  | "no-finished-audio"
  | "missing-hash"
  | "section-too-large"
  | "over-provider-bytes";

export type UploadPlan =
  | { ok: false; reason: UploadBlockReason }
  | {
      ok: true;
      toSend: SectionInput[];
      acknowledged: AcknowledgedSection[];
      totalFinished: number;
    };

export type StepPhase =
  | "queued"
  | "leased"
  | "awaiting_provider"
  | "succeeded"
  | "failed_retryable"
  | "uncertain"
  | "unusable";

/** Times are relative to the start of one audio section. */
export type TimedSnippet = {
  text: string;
  startMs: number;
  endMs: number;
};

export type ProcessStep = {
  operation: "transcribe" | "notes";
  sequence: number | null;
  sha256: string | null;
  durationMs: number;
  idempotencyKey: string;
  phase: StepPhase;
  leaseOwner: string | null;
  leaseUntil: number | null;
  requestSent: boolean;
  attempts: number;
  transcript: string | null;
  segments: TimedSnippet[] | null;
};

export type AudioSlice = {
  offset: number;
  length: number;
  /** True only when this range is a complete, independently decodable audio file. */
  independentlyDecodable: boolean;
};

/** Matches the private memoai-audio bucket and audio_sections.size_bytes. */
export const STORED_AUDIO_LIMIT_DETAIL =
  "This finished audio is larger than 20 MiB, which is the most MemoAI stores for one section. The original file was not changed or deleted. New recordings are already saved as smaller sections and can be uploaded. This file stays on the phone.";

export type ProcessJob = {
  id: string;
  ownerId: string;
  recordingId: string;
  consentAt: string;
  transcribeModel: string;
  notesModel: string;
  idempotencyKey: string;
  cancelled: boolean;
  deleted: boolean;
  publishBlocked: boolean;
  steps: ProcessStep[];
  notes: GroundedNotes | null;
  failureReason: string | null;
};

export type CloudPhase =
  | "needs-account"
  | "needs-consent"
  | "ready"
  | "uploading"
  | "processing"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "deleted";

export function planUpload(input: {
  recordingId: string;
  ownerId: string | null;
  consentAt: string | null;
  sections: readonly SectionInput[];
  acknowledged: readonly AcknowledgedSection[];
}): UploadPlan {
  if (input.recordingId.startsWith("sample-")) {
    return { ok: false, reason: "sample" };
  }
  if (!input.ownerId) {
    return { ok: false, reason: "no-account" };
  }
  if (!input.consentAt) {
    return { ok: false, reason: "no-consent" };
  }
  const finished = input.sections
    .filter((section) => section.finished)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);
  if (finished.length === 0) {
    return { ok: false, reason: "no-finished-audio" };
  }
  if (finished.some((section) => !HASH.test(section.sha256))) {
    return { ok: false, reason: "missing-hash" };
  }
  if (finished.some((section) => section.sizeBytes > MAX_SECTION_BYTES || section.sizeBytes > OPENAI_MAX_AUDIO_BYTES)) {
    return { ok: false, reason: "section-too-large" };
  }
  if (finished.some((section) => section.sizeBytes <= 0)) {
    return { ok: false, reason: "over-provider-bytes" };
  }
  const durationMs = finished.reduce((sum, section) => sum + section.durationMs, 0);
  if (
    finished.some((section) => !Number.isFinite(section.durationMs) || section.durationMs < 0) ||
    !Number.isFinite(durationMs) ||
    durationMs > MAX_NOTES_AUDIO_MS
  ) {
    return { ok: false, reason: "too-long" };
  }
  const acknowledged = new Set(
    input.acknowledged.map((section) => `${section.sequence}:${section.sha256}`),
  );
  const toSend = finished.filter(
    (section) => !acknowledged.has(`${section.sequence}:${section.sha256}`),
  );
  return {
    ok: true,
    toSend,
    acknowledged: input.acknowledged.filter((section) =>
      finished.some(
        (item) => item.sequence === section.sequence && item.sha256 === section.sha256,
      ),
    ),
    totalFinished: finished.length,
  };
}

export async function runSectionUploads(input: {
  plan: Extract<UploadPlan, { ok: true }>;
  send: (section: SectionInput) => Promise<"acknowledged" | "interrupted">;
  cancelled: () => boolean;
}): Promise<{
  acknowledged: AcknowledgedSection[];
  status: "complete" | "interrupted" | "cancelled";
}> {
  const acknowledged = input.plan.acknowledged.map((section) => ({ ...section }));
  for (const section of input.plan.toSend) {
    if (input.cancelled()) {
      return { acknowledged, status: "cancelled" };
    }
    const result = await input.send(section);
    if (result !== "acknowledged") {
      return { acknowledged, status: "interrupted" };
    }
    acknowledged.push({ sequence: section.sequence, sha256: section.sha256 });
  }
  return { acknowledged, status: "complete" };
}

/**
 * Copies only ranges the caller has already marked as independently decodable.
 * A single m4a/mp4 file has no such ranges here, so it is blocked.
 * The returned plan never includes a path to write, and it does not mutate `source`.
 */
export function splitWithoutTouchingSource(input: {
  source: Uint8Array;
  sourcePath: string;
  slices: readonly AudioSlice[] | null;
}):
  | { action: "blocked"; detail: string; sourcePath: string; writes: readonly [] }
  | { action: "split"; copies: Uint8Array[]; sourcePath: string; writes: readonly [] } {
  const blocked = {
    action: "blocked" as const,
    detail: STORED_AUDIO_LIMIT_DETAIL,
    sourcePath: input.sourcePath,
    writes: [] as const,
  };
  if (!input.slices || input.slices.length === 0 || input.slices.some((slice) => !slice.independentlyDecodable)) {
    return blocked;
  }
  const ordered = input.slices.map((slice) => ({ ...slice })).sort((left, right) => left.offset - right.offset);
  let cursor = 0;
  for (const slice of ordered) {
    if (
      !Number.isInteger(slice.offset) ||
      !Number.isInteger(slice.length) ||
      slice.offset < 0 ||
      slice.length <= 0 ||
      slice.length > MAX_SECTION_BYTES ||
      slice.length > OPENAI_MAX_AUDIO_BYTES ||
      slice.offset < cursor ||
      slice.offset + slice.length > input.source.byteLength
    ) {
      return blocked;
    }
    cursor = slice.offset + slice.length;
  }
  return {
    action: "split",
    copies: ordered.map((slice) => {
      const copy = new Uint8Array(slice.length);
      copy.set(input.source.subarray(slice.offset, slice.offset + slice.length));
      return copy;
    }),
    sourcePath: input.sourcePath,
    writes: [],
  };
}

/** The phone calls this with the signed-in user's access token. It has no place for a worker secret. */
export function notesStartRequest(input: {
  apiUrl: string;
  accessToken: string;
  jobId: string;
}): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  return {
    url: `${input.apiUrl.replace(/\/$/, "")}/api/notes/step`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jobId: input.jobId }),
  };
}

export function interpretUploadError(message: string): "acknowledged" | "interrupted" {
  if (/already exists|duplicate|409/i.test(message)) {
    return "acknowledged";
  }
  return "interrupted";
}

export function audioObjectPath(
  ownerId: string,
  recordingId: string,
  sequence: number,
  sha256: string,
): string {
  return `${ownerId}/${recordingId}/${sequence}-${sha256}.m4a`;
}

export function pathOwnedBy(path: string, ownerId: string): boolean {
  const [owner] = path.split("/");
  return owner === ownerId && ownerId.length > 0;
}

export function processingKey(input: {
  ownerId: string;
  recordingId: string;
  transcribeModel: string;
  notesModel: string;
  hashes: readonly string[];
}): string {
  return [
    "v1",
    input.ownerId,
    input.recordingId,
    input.transcribeModel,
    input.notesModel,
    ...input.hashes,
  ].join(":");
}

export function createJob(input: {
  id: string;
  ownerId: string | null;
  recordingId: string;
  consentAt: string | null;
  sections: readonly SectionInput[];
  transcribeModel?: string;
  notesModel?: string;
}): { ok: true; job: ProcessJob } | { ok: false; reason: UploadBlockReason } {
  const transcribeModel = input.transcribeModel ?? TRANSCRIBE_MODEL;
  const notesModel = input.notesModel ?? NOTES_MODEL;
  const plan = planUpload({
    recordingId: input.recordingId,
    ownerId: input.ownerId,
    consentAt: input.consentAt,
    sections: input.sections,
    acknowledged: [],
  });
  if (!plan.ok || !input.ownerId || !input.consentAt) {
    return { ok: false, reason: plan.ok ? "no-consent" : plan.reason };
  }
  const finished = input.sections
    .filter((section) => section.finished)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);
  const hashes = finished.map((section) => section.sha256);
  const root = processingKey({
    ownerId: input.ownerId,
    recordingId: input.recordingId,
    transcribeModel,
    notesModel,
    hashes,
  });
  const steps: ProcessStep[] = finished.map((section) => ({
    operation: "transcribe",
    sequence: section.sequence,
    sha256: section.sha256,
    durationMs: section.durationMs,
    idempotencyKey: `${root}:transcribe:${section.sequence}:${section.sha256}`,
    phase: "queued",
    leaseOwner: null,
    leaseUntil: null,
    requestSent: false,
    attempts: 0,
    transcript: null,
    segments: null,
  }));
  steps.push({
    operation: "notes",
    sequence: null,
    sha256: null,
    durationMs: 0,
    idempotencyKey: `${root}:notes`,
    phase: "queued",
    leaseOwner: null,
    leaseUntil: null,
    requestSent: false,
    attempts: 0,
    transcript: null,
    segments: null,
  });
  return {
    ok: true,
    job: {
      id: input.id,
      ownerId: input.ownerId,
      recordingId: input.recordingId,
      consentAt: input.consentAt,
      transcribeModel,
      notesModel,
      idempotencyKey: root,
      cancelled: false,
      deleted: false,
      publishBlocked: false,
      steps,
      notes: null,
      failureReason: null,
    },
  };
}

export function findReusableJob(
  jobs: readonly ProcessJob[],
  ownerId: string,
  idempotencyKey: string,
): ProcessJob | null {
  return (
    jobs.find(
      (job) =>
        job.ownerId === ownerId &&
        job.idempotencyKey === idempotencyKey &&
        !job.deleted &&
        !job.publishBlocked &&
        job.notes != null &&
        job.steps.every((step) => step.phase === "succeeded"),
    ) ?? null
  );
}

export function claimStep(
  job: ProcessJob,
  input: { actorOwnerId: string; workerId: string; now: number; leaseMs: number },
): { ok: true; job: ProcessJob; step: ProcessStep } | { ok: false; reason: string; job: ProcessJob } {
  if (input.actorOwnerId !== job.ownerId) {
    return { ok: false, reason: "not-owner", job };
  }
  if (job.deleted || job.publishBlocked) {
    return { ok: false, reason: "deleted", job };
  }
  if (job.cancelled) {
    return { ok: false, reason: "cancelled", job };
  }
  const swept = sweepExpiredLeases(job, input.now);
  if (swept.steps.some((step) => step.phase === "uncertain")) {
    return { ok: false, reason: "uncertain", job: swept };
  }
  const transcribeOpen = swept.steps.some(
    (step) => step.operation === "transcribe" && step.phase !== "succeeded",
  );
  const candidate = swept.steps.find((step) => {
    if (step.operation === "notes" && transcribeOpen) {
      return false;
    }
    if (step.phase === "uncertain" || step.phase === "unusable" || step.phase === "succeeded") {
      return false;
    }
    if (step.phase === "awaiting_provider" || step.requestSent) {
      return false;
    }
    if (step.phase === "failed_retryable" && step.attempts >= MAX_DEFINITE_ATTEMPTS) {
      return false;
    }
    if (step.phase === "queued" || step.phase === "failed_retryable") {
      return true;
    }
    return step.phase === "leased" && (step.leaseUntil ?? 0) <= input.now && !step.requestSent;
  });
  if (!candidate) {
    const uncertain = swept.steps.some((step) => step.phase === "uncertain");
    return { ok: false, reason: uncertain ? "uncertain" : "idle", job: swept };
  }
  const step: ProcessStep = {
    ...candidate,
    phase: "leased",
    leaseOwner: input.workerId,
    leaseUntil: input.now + input.leaseMs,
    attempts: candidate.attempts + 1,
  };
  return { ok: true, job: replaceStep(swept, step), step };
}

export function markRequestSent(job: ProcessJob, idempotencyKey: string, now: number): ProcessJob {
  return replaceStep(job, {
    ...requireStep(job, idempotencyKey),
    phase: "awaiting_provider",
    requestSent: true,
    leaseUntil: Math.max(requireStep(job, idempotencyKey).leaseUntil ?? 0, now),
  });
}

export type StepSettlement =
  | { kind: "text"; text: string; segments?: TimedSnippet[] }
  | { kind: "notes"; draft: NotesDraft }
  | { kind: "rejected"; reason: string }
  | { kind: "uncertain" }
  | { kind: "unusable"; reason: string };

export function settleStep(
  job: ProcessJob,
  idempotencyKey: string,
  outcome: StepSettlement,
): { job: ProcessJob; published: boolean } {
  const current = requireStep(job, idempotencyKey);
  if (job.deleted || job.publishBlocked || job.cancelled) {
    return {
      published: false,
      job: {
        ...job,
        publishBlocked: job.deleted || job.publishBlocked,
        failureReason: job.deleted ? "Deleted before the result could be saved." : job.failureReason,
      },
    };
  }
  if (outcome.kind === "rejected") {
    const step: ProcessStep = {
      ...current,
      phase: "failed_retryable",
      leaseOwner: null,
      leaseUntil: null,
      requestSent: false,
    };
    return { published: false, job: { ...replaceStep(job, step), failureReason: outcome.reason } };
  }
  if (outcome.kind === "uncertain") {
    const step: ProcessStep = { ...current, phase: "uncertain", requestSent: true };
    return {
      published: false,
      job: {
        ...replaceStep(job, step),
        failureReason: "The provider did not answer. The call was not repeated.",
      },
    };
  }
  if (outcome.kind === "unusable") {
    const step: ProcessStep = { ...current, phase: "unusable", requestSent: true };
    return { published: false, job: { ...replaceStep(job, step), failureReason: outcome.reason } };
  }
  if (outcome.kind === "text") {
    const step: ProcessStep = {
      ...current,
      phase: "succeeded",
      transcript: outcome.text,
      segments: outcome.segments ?? null,
      leaseOwner: null,
      leaseUntil: null,
      requestSent: true,
    };
    return { published: true, job: replaceStep(job, step) };
  }
  const passages = transcriptTimeline(job);
  const grounded = groundNotes({ ...outcome.draft, passages, source: "recording" });
  const step: ProcessStep = {
    ...current,
    phase: "succeeded",
    leaseOwner: null,
    leaseUntil: null,
    requestSent: true,
  };
  return {
    published: true,
    job: { ...replaceStep(job, step), notes: grounded, failureReason: null },
  };
}

export function cancelJob(job: ProcessJob): ProcessJob {
  return { ...job, cancelled: true };
}

export function deleteJob(job: ProcessJob): { job: ProcessJob; paths: string[] } {
  return {
    job: {
      ...job,
      deleted: true,
      publishBlocked: true,
      cancelled: true,
      notes: null,
      failureReason: "Uploaded audio was deleted.",
    },
    paths: storagePaths(job),
  };
}

export function shouldPublish(job: ProcessJob): boolean {
  return (
    !job.deleted &&
    !job.publishBlocked &&
    !job.cancelled &&
    job.notes != null &&
    job.steps.filter((step) => step.operation === "transcribe").every((step) => step.phase === "succeeded")
  );
}

export function storagePaths(job: ProcessJob): string[] {
  return job.steps
    .filter((step) => step.operation === "transcribe" && step.sha256 && step.sequence != null)
    .map((step) => audioObjectPath(job.ownerId, job.recordingId, step.sequence as number, step.sha256 as string));
}

export function describeCloud(input: {
  signedIn: boolean;
  consented: boolean;
  upload: { done: number; total: number; status: "uploading" | "interrupted" | "cancelled" | "complete" } | null;
  job: ProcessJob | null;
}): { phase: CloudPhase; label: string; detail: string } {
  if (input.job?.deleted || input.job?.publishBlocked) {
    return {
      phase: "deleted",
      label: "Uploaded audio deleted",
      detail: "The uploaded audio is marked for deletion. A pending result will not be saved.",
    };
  }
  if (input.job?.cancelled) {
    return {
      phase: "cancelled",
      label: "Cancelled",
      detail: "Notes were cancelled. Audio on this phone was kept.",
    };
  }
  if (input.job && input.job.steps.some((step) => step.phase === "uncertain")) {
    return {
      phase: "uncertain",
      label: "Notes paused",
      detail: "The provider did not answer. MemoAI did not retry, because that request may already have been billed.",
    };
  }
  if (input.job && shouldPublish(input.job) && input.job.notes) {
    if (input.job.notes.status === "failed") {
      return {
        phase: "failed",
        label: "Notes failed",
        detail: input.job.notes.failureReason ?? "Notes could not be created.",
      };
    }
    if (input.job.notes.status === "partial") {
      return {
        phase: "completed",
        label: "Partial notes",
        detail: input.job.notes.missing ?? "Some of the transcript was not turned into notes.",
      };
    }
    return {
      phase: "completed",
      label: "Notes ready",
      detail: "Notes were written from this recording's transcript.",
    };
  }
  if (input.job && input.job.steps.some((step) => step.phase === "unusable" || (step.phase === "failed_retryable" && step.attempts >= MAX_DEFINITE_ATTEMPTS))) {
    return {
      phase: "failed",
      label: "Notes failed",
      detail: input.job.failureReason ?? "Notes could not be created.",
    };
  }
  if (input.upload?.status === "uploading") {
    return {
      phase: "uploading",
      label: "Uploading",
      detail: `Uploading finished section ${input.upload.done + 1} of ${input.upload.total}. Acknowledged sections are not sent again.`,
    };
  }
  if (input.upload?.status === "interrupted") {
    return {
      phase: "failed",
      label: "Upload interrupted",
      detail: `${input.upload.done} of ${input.upload.total} finished sections were acknowledged. Retry sends only the rest.`,
    };
  }
  if (input.upload?.status === "cancelled") {
    return {
      phase: "cancelled",
      label: "Cancelled",
      detail: "The upload stopped. Acknowledged sections stay uploaded until you delete them.",
    };
  }
  if (input.job) {
    const done = input.job.steps.filter((step) => step.operation === "transcribe" && step.phase === "succeeded").length;
    const total = input.job.steps.filter((step) => step.operation === "transcribe").length;
    const notes = input.job.steps.find((step) => step.operation === "notes");
    const writing = notes && done === total && notes.phase !== "queued";
    return {
      phase: "processing",
      label: "Processing",
      detail: writing
        ? "Writing notes from the transcript."
        : `Transcribing finished section ${Math.min(done + 1, total)} of ${total}.`,
    };
  }
  if (!input.signedIn) {
    return {
      phase: "needs-account",
      label: "Sign in to create notes",
      detail: "Recording stays on this phone without an account. An account is required before audio leaves the phone.",
    };
  }
  if (!input.consented) {
    return {
      phase: "needs-consent",
      label: "No notes",
      detail: "Agree before any finished audio is uploaded.",
    };
  }
  return {
    phase: "ready",
    label: "Ready to upload",
    detail: "Only finished sections are uploaded, one at a time. Unfinished recovery files stay on this phone.",
  };
}

function sweepExpiredLeases(job: ProcessJob, now: number): ProcessJob {
  return {
    ...job,
    steps: job.steps.map((step) => {
      const leaseOver = (step.leaseUntil ?? 0) <= now;
      if (step.phase === "awaiting_provider" && step.requestSent && leaseOver) {
        return { ...step, phase: "uncertain", leaseOwner: null };
      }
      if (step.phase === "leased" && leaseOver) {
        if (step.requestSent) {
          return { ...step, phase: "uncertain", leaseOwner: null };
        }
        return { ...step, phase: "queued", leaseOwner: null, leaseUntil: null };
      }
      return step;
    }),
  };
}

/** Places each section's snippets on one timeline. Later sections start after earlier section durations. */
export function transcriptTimeline(job: ProcessJob): NotesPassage[] {
  const steps = job.steps
    .filter((step) => step.operation === "transcribe")
    .slice()
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  let cursor = 0;
  const passages: NotesPassage[] = [];
  for (const step of steps) {
    const duration = Number.isFinite(step.durationMs) && step.durationMs > 0 ? step.durationMs : 0;
    if (step.phase === "succeeded" && step.segments && step.segments.length > 0) {
      step.segments.forEach((segment, index) => {
        const text = segment.text.trim();
        if (!text) {
          return;
        }
        const start = clampMs(segment.startMs, 0, duration);
        const end = clampMs(segment.endMs, start, duration);
        passages.push({
          id: `section-${step.sequence}-${index}`,
          startMs: cursor + start,
          endMs: cursor + end,
          text,
        });
      });
    } else if (step.phase === "succeeded" && step.transcript && step.transcript.trim()) {
      passages.push({
        id: `section-${step.sequence}`,
        startMs: cursor,
        endMs: cursor + duration,
        text: step.transcript,
      });
    }
    cursor += duration;
  }
  return passages;
}

export function formatTranscriptForNotes(job: ProcessJob): string {
  return transcriptTimeline(job)
    .map((passage) => `[${passage.id} ${passage.startMs}ms-${passage.endMs}ms] ${passage.text}`)
    .join("\n");
}

function clampMs(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function replaceStep(job: ProcessJob, step: ProcessStep): ProcessJob {
  return {
    ...job,
    steps: job.steps.map((item) => (item.idempotencyKey === step.idempotencyKey ? step : item)),
  };
}

function requireStep(job: ProcessJob, idempotencyKey: string): ProcessStep {
  const step = job.steps.find((item) => item.idempotencyKey === idempotencyKey);
  if (!step) {
    throw new Error("Unknown processing step");
  }
  return step;
}
