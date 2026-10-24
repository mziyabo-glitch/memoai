import { createHash } from "node:crypto";

import {
  MAX_NOTES_AUDIO_MS,
  MAX_SECTION_BYTES,
  OPENAI_MAX_AUDIO_BYTES,
  STORED_AUDIO_LIMIT_DETAIL,
  pathOwnedBy,
  shouldPublish,
  transcriptTimeline,
  type ProcessJob,
  type ProcessStep,
  type StepPhase,
  type TimedSnippet,
} from "@memoai/shared";

export type LoadedJob =
  | { ok: true; job: ProcessJob; meetingId: string }
  | { ok: false; reason: "not-found" | "not-owner" | "no-consent" | "too-long" | "section-too-large" | "over-provider-bytes" | "deleted"; detail: string };

type JobRow = {
  id: string;
  user_id: string;
  recording_id: string;
  consent_id: string;
  idempotency_key: string;
  transcribe_model: string;
  notes_model: string;
  total_duration_ms: number;
  status: string;
  deleted_at: string | null;
  publish_blocked: boolean;
  cancel_requested_at: string | null;
  failure_reason: string | null;
};

type StepRow = {
  id: string;
  user_id: string;
  job_id: string;
  recording_id: string;
  sequence: number | null;
  operation: "transcribe" | "notes";
  sha256: string | null;
  idempotency_key: string;
  status: StepPhase;
  lease_owner: string | null;
  lease_until: string | null;
  request_sent_at: string | null;
  attempt_count: number;
  result_text: string | null;
};

type SectionRow = {
  user_id: string;
  recording_id: string;
  sequence: number;
  sha256: string;
  size_bytes: number;
  duration_ms: number;
  storage_path: string;
  upload_status: string;
};

type ConsentRow = {
  id: string;
  user_id: string;
  recording_id: string;
  agreed_at: string;
};

type RecordingRow = {
  id: string;
  user_id: string;
  meeting_id: string;
  local_recording_id: string | null;
  duration_ms: number | null;
};

export type ProcessingStore = {
  load: (jobId: string, expectedOwnerId?: string) => Promise<LoadedJob>;
  reload: () => Promise<ProcessJob>;
  save: (job: ProcessJob) => Promise<void>;
  readAudio: (sha256: string) => Promise<Uint8Array | null>;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRestStore(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): ProcessingStore {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.supabaseUrl.replace(/\/$/, "");
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const stepIds = new Map<string, string>();
  const sentAt = new Map<string, string>();
  const audioPaths = new Map<string, string>();
  const audioCache = new Map<string, Uint8Array>();
  let ownerId = "";
  let meetingId = "";
  let recordingId = "";
  let loadedJobId = "";
  let consentAt = "";
  let localRecordingId: string | null = null;
  let published = false;

  async function rest<T>(path: string, init?: { method?: string; body?: unknown; prefer?: string }): Promise<T> {
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      method: init?.method ?? "GET",
      headers: {
        ...headers,
        ...(init?.prefer ? { Prefer: init.prefer } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      throw new Error(`Supabase request failed with status ${response.status}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async load(jobId, expectedOwnerId) {
      const jobs = await rest<JobRow[]>(`processing_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`);
      const job = jobs[0];
      if (!job) {
        return { ok: false, reason: "not-found", detail: "No processing job was found." };
      }
      if (expectedOwnerId && expectedOwnerId !== job.user_id) {
        return { ok: false, reason: "not-owner", detail: "That job belongs to a different account." };
      }
      if (job.deleted_at || job.publish_blocked || job.status === "deleted") {
        return { ok: false, reason: "deleted", detail: "Uploaded audio was deleted. A later result will not be saved." };
      }
      const [steps, consents, sections, recordings] = await Promise.all([
        rest<StepRow[]>(`processing_steps?job_id=eq.${encodeURIComponent(job.id)}&select=*&order=sequence.asc`),
        rest<ConsentRow[]>(`processing_consents?id=eq.${encodeURIComponent(job.consent_id)}&select=*`),
        rest<SectionRow[]>(`audio_sections?recording_id=eq.${encodeURIComponent(job.recording_id)}&select=*&order=sequence.asc`),
        rest<RecordingRow[]>(`recordings?id=eq.${encodeURIComponent(job.recording_id)}&select=*`),
      ]);
      const consent = consents[0];
      const recording = recordings[0];
      if (!consent || consent.user_id !== job.user_id || consent.recording_id !== job.recording_id || !consent.agreed_at) {
        return { ok: false, reason: "no-consent", detail: "This recording has no upload consent for its owner." };
      }
      if (!recording || recording.user_id !== job.user_id || !recording.meeting_id) {
        return { ok: false, reason: "not-owner", detail: "The recording row does not belong to this job's owner." };
      }
      if (sections.some((section) => section.user_id !== job.user_id) || steps.some((step) => step.user_id !== job.user_id)) {
        return { ok: false, reason: "not-owner", detail: "A section on this job belongs to a different account." };
      }
      const durationMs = sections.reduce((sum, section) => sum + section.duration_ms, 0);
      if (job.total_duration_ms > MAX_NOTES_AUDIO_MS || durationMs > MAX_NOTES_AUDIO_MS) {
        return { ok: false, reason: "too-long", detail: "Finished audio is longer than 90 minutes, so it was not sent." };
      }
      if (sections.some((section) => section.size_bytes > MAX_SECTION_BYTES || section.size_bytes > OPENAI_MAX_AUDIO_BYTES || section.size_bytes <= 0)) {
        return { ok: false, reason: "section-too-large", detail: STORED_AUDIO_LIMIT_DETAIL };
      }
      ownerId = job.user_id;
      meetingId = recording.meeting_id;
      recordingId = recording.id;
      loadedJobId = job.id;
      consentAt = consent.agreed_at;
      localRecordingId = recording.local_recording_id;
      audioPaths.clear();
      for (const section of sections) {
        if (!pathOwnedBy(section.storage_path, job.user_id)) {
          return { ok: false, reason: "not-owner", detail: "An audio object is outside the owner's folder." };
        }
        audioPaths.set(section.sha256, section.storage_path);
      }
      const durations = new Map(sections.map((section) => [section.sequence, section.duration_ms]));
      const mapped = mapJob(job, steps, consent.agreed_at, recording.local_recording_id, durations);
      for (const step of steps) {
        stepIds.set(step.idempotency_key, step.id);
        if (step.request_sent_at) {
          sentAt.set(step.idempotency_key, step.request_sent_at);
        }
      }
      return { ok: true, job: mapped, meetingId };
    },
    async reload() {
      if (!loadedJobId) {
        throw new Error("No processing job is loaded.");
      }
      const jobs = await rest<JobRow[]>(`processing_jobs?id=eq.${encodeURIComponent(loadedJobId)}&select=*`);
      const row = jobs[0];
      if (!row || row.user_id !== ownerId) {
        throw new Error("The processing job no longer belongs to its owner.");
      }
      const [steps, sections] = await Promise.all([
        rest<StepRow[]>(`processing_steps?job_id=eq.${encodeURIComponent(row.id)}&select=*&order=sequence.asc`),
        rest<SectionRow[]>(`audio_sections?recording_id=eq.${encodeURIComponent(row.recording_id)}&select=*&order=sequence.asc`),
      ]);
      const durations = new Map(sections.map((section) => [section.sequence, section.duration_ms]));
      const mapped = mapJob(row, steps, consentAt, localRecordingId, durations);
      if (row.deleted_at || row.publish_blocked || row.status === "deleted") {
        return { ...mapped, deleted: true, publishBlocked: true, notes: null, cancelled: true };
      }
      if (row.cancel_requested_at || row.status === "cancelled") {
        return { ...mapped, cancelled: true };
      }
      return mapped;
    },
    async save(job) {
      if (!ownerId || job.ownerId !== ownerId) {
        throw new Error("Refusing to save a job for a different owner.");
      }
      const nowIso = new Date().toISOString();
      for (const step of job.steps) {
        const id = stepIds.get(step.idempotencyKey);
        if (!id) {
          continue;
        }
        if (step.requestSent && !sentAt.has(step.idempotencyKey)) {
          sentAt.set(step.idempotencyKey, nowIso);
        }
        await rest(`processing_steps?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: {
            status: step.phase,
            lease_owner: step.leaseOwner,
            lease_until: step.leaseUntil == null ? null : new Date(step.leaseUntil).toISOString(),
            request_sent_at: step.requestSent ? sentAt.get(step.idempotencyKey) ?? nowIso : null,
            attempt_count: step.attempts,
            result_text: encodeResult(step),
            failure_reason: step.phase === "succeeded" ? null : job.failureReason,
          },
        });
      }
      const active = job.steps.find((step) => step.phase === "leased" || step.phase === "awaiting_provider");
      await rest(`processing_jobs?id=eq.${encodeURIComponent(job.id)}&user_id=eq.${encodeURIComponent(job.ownerId)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          status: persistedStatus(job),
          lease_owner: active?.leaseOwner ?? null,
          lease_until: active?.leaseUntil == null ? null : new Date(active.leaseUntil).toISOString(),
          provider_request_sent_at: job.steps.some((step) => step.requestSent) ? nowIso : null,
          publish_blocked: job.publishBlocked,
          failure_reason: job.failureReason,
          deleted_at: job.deleted ? nowIso : null,
        },
      });
      if (!shouldPublish(job) || !job.notes || published) {
        return;
      }
      const passages = transcriptTimeline(job);
      if (passages.length > 0) {
        await rest("transcript_segments", {
          method: "POST",
          prefer: "return=minimal",
          body: passages.map((passage) => ({
            user_id: job.ownerId,
            meeting_id: meetingId,
            recording_id: recordingId,
            start_ms: passage.startMs,
            end_ms: passage.endMs,
            text: passage.text,
            origin: "worker",
            section_sequence: sectionSequence(passage.id),
          })),
        });
      }
      const summaries = await rest<{ id: string }[]>("summaries", {
        method: "POST",
        prefer: "return=representation",
        body: {
          user_id: job.ownerId,
          meeting_id: meetingId,
          body: job.notes.overview.join("\n") || job.notes.failureReason || "Notes could not be created.",
          origin: "worker",
          job_id: job.id,
          model: job.notesModel,
        },
      });
      const summaryId = summaries[0]?.id ?? null;
      if (job.notes.actions.length > 0) {
        await rest("action_items", {
          method: "POST",
          prefer: "return=minimal",
          body: job.notes.actions.map((action) => ({
            user_id: job.ownerId,
            meeting_id: meetingId,
            summary_id: summaryId,
            text: action.text,
            done: false,
            origin: "worker",
            owner_name: action.owner,
            deadline_text: action.deadline,
          })),
        });
      }
      published = true;
    },
    async readAudio(sha256) {
      const cached = audioCache.get(sha256);
      if (cached) {
        return cached;
      }
      const path = audioPaths.get(sha256);
      if (!path || !pathOwnedBy(path, ownerId)) {
        return null;
      }
      const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
      const response = await fetchImpl(`${base}/storage/v1/object/memoai-audio/${encoded}`, { headers });
      if (!response.ok) {
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      audioCache.set(sha256, bytes);
      return bytes;
    },
  };
}

export function persistedStatus(job: ProcessJob): string {
  if (job.deleted || job.publishBlocked) {
    return "deleted";
  }
  if (job.cancelled) {
    return "cancelled";
  }
  if (job.steps.some((step) => step.phase === "uncertain")) {
    return "uncertain";
  }
  if (shouldPublish(job)) {
    return "completed";
  }
  if (job.steps.some((step) => step.phase === "unusable" || (step.phase === "failed_retryable" && step.attempts >= 3))) {
    return "failed_retryable";
  }
  if (job.steps.some((step) => step.phase === "awaiting_provider")) {
    return "awaiting_provider";
  }
  if (job.steps.some((step) => step.phase === "leased")) {
    return "leased";
  }
  return "processing";
}

function mapJob(
  job: JobRow,
  steps: StepRow[],
  consentAt: string,
  localRecordingId: string | null,
  durations: Map<number, number>,
): ProcessJob {
  return {
    id: job.id,
    ownerId: job.user_id,
    recordingId: localRecordingId ?? job.recording_id,
    consentAt,
    transcribeModel: job.transcribe_model,
    notesModel: job.notes_model,
    idempotencyKey: job.idempotency_key,
    cancelled: job.cancel_requested_at != null || job.status === "cancelled",
    deleted: false,
    publishBlocked: false,
    failureReason: job.failure_reason,
    notes: null,
    steps: steps.map((step) => mapStep(step, durations)),
  };
}

function mapStep(step: StepRow, durations: Map<number, number>): ProcessStep {
  const stored = decodeResult(step.result_text);
  return {
    operation: step.operation,
    sequence: step.sequence,
    sha256: step.sha256,
    durationMs: step.sequence == null ? 0 : durations.get(step.sequence) ?? 0,
    idempotencyKey: step.idempotency_key,
    phase: step.status,
    leaseOwner: step.lease_owner,
    leaseUntil: step.lease_until ? Date.parse(step.lease_until) : null,
    requestSent: step.request_sent_at != null,
    attempts: step.attempt_count,
    transcript: stored.text,
    segments: stored.segments,
  };
}

function encodeResult(step: ProcessStep): string | null {
  if (step.operation === "transcribe") {
    if (!step.transcript && !step.segments) {
      return null;
    }
    return JSON.stringify({ v: 1, text: step.transcript ?? "", segments: step.segments ?? [] });
  }
  return null;
}

function decodeResult(value: string | null): { text: string | null; segments: TimedSnippet[] | null } {
  if (!value) {
    return { text: null, segments: null };
  }
  try {
    const parsed = JSON.parse(value) as { v?: number; text?: unknown; segments?: TimedSnippet[] };
    if (parsed.v === 1 && typeof parsed.text === "string") {
      return { text: parsed.text, segments: Array.isArray(parsed.segments) ? parsed.segments : null };
    }
  } catch {
    return { text: value, segments: null };
  }
  return { text: value, segments: null };
}

function sectionSequence(passageId: string): number | null {
  const match = /^section-(\d+)/.exec(passageId);
  return match ? Number(match[1]) : null;
}
