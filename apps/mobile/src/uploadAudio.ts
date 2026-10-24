import {
  NOTES_UPLOAD_EXPLANATION,
  OVERSIZED_SINGLE_FILE_DETAIL,
  audioObjectPath,
  createJob,
  interpretUploadError,
  planUpload,
  runSectionUploads,
  splitWithoutTouchingSource,
  type AcknowledgedSection,
  type ProcessJob,
  type SectionInput,
} from "@memoai/shared";
import { getSupabase } from "./account";

export type UploadOutcome =
  | { ok: false; uploaded: false; reason: string; acknowledged: AcknowledgedSection[] }
  | { ok: true; uploaded: true; job: ProcessJob; acknowledged: AcknowledgedSection[] };

/**
 * Uploads finished sections after consent. Unfinished files are not in the plan.
 * A configured Supabase project is required; otherwise nothing is sent.
 */
export async function uploadFinishedAudio(input: {
  recordingId: string;
  title: string;
  consentAt: string | null;
  sections: readonly SectionInput[];
  acknowledged: readonly AcknowledgedSection[];
  cancelled: () => boolean;
  onProgress: (done: number, total: number) => void;
  readFile: (section: SectionInput) => Promise<Uint8Array>;
}): Promise<UploadOutcome> {
  const supabase = getSupabase();
  const session = supabase ? await supabase.auth.getSession() : null;
  const ownerId = session?.data.session?.user.id ?? null;
  const plan = planUpload({
    recordingId: input.recordingId,
    ownerId,
    consentAt: input.consentAt,
    sections: input.sections,
    acknowledged: input.acknowledged,
  });
  if (!plan.ok) {
    return { ok: false, uploaded: false, reason: reasonText(plan.reason), acknowledged: [] };
  }
  if (!supabase || !ownerId) {
    return {
      ok: false,
      uploaded: false,
      reason: "Supabase is not configured on this phone. No audio was uploaded.",
      acknowledged: plan.acknowledged,
    };
  }
  input.onProgress(plan.acknowledged.length, plan.totalFinished);
  const uploaded = await runSectionUploads({
    plan,
    cancelled: input.cancelled,
    send: async (section) => {
      try {
        const bytes = await input.readFile(section);
        const path = audioObjectPath(ownerId, input.recordingId, section.sequence, section.sha256);
        const { error } = await supabase.storage.from("memoai-audio").upload(path, audioBlob(bytes), {
          contentType: "audio/mp4",
          upsert: false,
        });
        if (error) {
          return interpretUploadError(error.message);
        }
        return "acknowledged";
      } catch (error) {
        const message = error instanceof Error ? error.message : "upload failed";
        return interpretUploadError(message);
      }
    },
  });
  input.onProgress(uploaded.acknowledged.length, plan.totalFinished);
  if (uploaded.status !== "complete") {
    return {
      ok: false,
      uploaded: false,
      reason: uploaded.status === "cancelled" ? "Upload cancelled." : "Upload interrupted. Retry sends only the remaining sections.",
      acknowledged: uploaded.acknowledged,
    };
  }
  const created = createJob({
    id: input.recordingId,
    ownerId,
    recordingId: input.recordingId,
    consentAt: input.consentAt,
    sections: input.sections,
  });
  if (!created.ok) {
    return { ok: false, uploaded: false, reason: reasonText(created.reason), acknowledged: uploaded.acknowledged };
  }
  const recorded = await recordJob(
    supabase,
    ownerId,
    input.title,
    input.consentAt ?? "",
    created.job,
    input.sections,
  );
  if (!recorded.ok) {
    return { ok: false, uploaded: false, reason: recorded.reason, acknowledged: uploaded.acknowledged };
  }
  return { ok: true, uploaded: true, job: created.job, acknowledged: uploaded.acknowledged };
}

async function recordJob(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  ownerId: string,
  title: string,
  consentAt: string,
  job: ProcessJob,
  sections: readonly SectionInput[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await supabase
    .from("recordings")
    .select("id")
    .eq("user_id", ownerId)
    .eq("local_recording_id", job.recordingId)
    .maybeSingle();
  if (existing.error) return { ok: false, reason: existing.error.message };
  let recordingId = existing.data?.id as string | undefined;
  if (!recordingId) {
    const meeting = await supabase.from("meetings").insert({ user_id: ownerId, title }).select("id").single();
    if (meeting.error) return { ok: false, reason: meeting.error.message };
    const recording = await supabase
      .from("recordings")
      .insert({
        user_id: ownerId,
        meeting_id: meeting.data.id,
        local_recording_id: job.recordingId,
        duration_ms: job.steps.reduce((sum, step) => sum + step.durationMs, 0),
        status: "complete",
      })
      .select("id")
      .single();
    if (recording.error) return { ok: false, reason: recording.error.message };
    recordingId = recording.data.id as string;
  }
  const consent = await supabase
    .from("processing_consents")
    .insert({
      user_id: ownerId,
      recording_id: recordingId,
      explanation_version: NOTES_UPLOAD_EXPLANATION.version,
      agreed_at: consentAt,
    })
    .select("id")
    .single();
  if (consent.error) return { ok: false, reason: consent.error.message };
  const rows = job.steps
    .filter((step) => step.operation === "transcribe" && step.sha256 != null && step.sequence != null)
    .map((step) => ({
      user_id: ownerId,
      recording_id: recordingId,
      sequence: step.sequence,
      sha256: step.sha256,
      size_bytes: sections.find((item) => item.sha256 === step.sha256)?.sizeBytes ?? 1,
      duration_ms: step.durationMs,
      storage_path: audioObjectPath(ownerId, job.recordingId, step.sequence as number, step.sha256 as string),
      upload_status: "acknowledged",
      acknowledged_at: new Date().toISOString(),
    }));
  const savedSections = await supabase.from("audio_sections").insert(rows);
  if (savedSections.error && !/duplicate|already exists/i.test(savedSections.error.message)) {
    return { ok: false, reason: savedSections.error.message };
  }
  const savedJob = await supabase
    .from("processing_jobs")
    .insert({
      user_id: ownerId,
      recording_id: recordingId,
      consent_id: consent.data.id,
      idempotency_key: job.idempotencyKey,
      transcribe_model: job.transcribeModel,
      notes_model: job.notesModel,
      total_duration_ms: job.steps.reduce((sum, step) => sum + step.durationMs, 0),
      status: "queued",
    })
    .select("id")
    .single();
  if (savedJob.error) return { ok: false, reason: savedJob.error.message };
  const steps = job.steps.map((step) => ({
    user_id: ownerId,
    job_id: savedJob.data.id,
    recording_id: recordingId,
    sequence: step.sequence,
    operation: step.operation,
    sha256: step.sha256,
    idempotency_key: step.idempotencyKey,
    status: "queued",
    attempt_count: 0,
  }));
  const savedSteps = await supabase.from("processing_steps").insert(steps);
  if (savedSteps.error) return { ok: false, reason: savedSteps.error.message };
  return { ok: true };
}

export async function deleteUploadedAudio(input: {
  ownerId: string;
  paths: string[];
  localRecordingId: string;
}): Promise<{ ok: boolean; reason: string | null }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, reason: "Supabase is not configured. Nothing was deleted in the cloud." };
  const owned = input.paths.filter((path) => path.startsWith(`${input.ownerId}/`));
  if (owned.length > 0) {
    const removed = await supabase.storage.from("memoai-audio").remove(owned);
    if (removed.error) return { ok: false, reason: removed.error.message };
  }
  const recording = await supabase
    .from("recordings")
    .select("id")
    .eq("user_id", input.ownerId)
    .eq("local_recording_id", input.localRecordingId)
    .maybeSingle();
  if (recording.error || !recording.data?.id) {
    return { ok: false, reason: recording.error?.message ?? "No uploaded recording was found." };
  }
  const job = await supabase
    .from("processing_jobs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", input.ownerId)
    .eq("recording_id", recording.data.id);
  if (job.error) return { ok: false, reason: job.error.message };
  return { ok: true, reason: null };
}

function audioBlob(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: "audio/mp4" });
}

function reasonText(reason: string): string {
  switch (reason) {
    case "sample":
      return "Sample notes are not uploaded.";
    case "no-account":
      return "Sign in before audio leaves this phone.";
    case "no-consent":
      return "Agree before any audio is uploaded.";
    case "too-long":
      return "Finished audio is longer than 90 minutes, so it was not uploaded.";
    case "no-finished-audio":
      return "There is no finished audio to upload. Recovery files stay on this phone.";
    case "missing-hash":
      return "This recording has no section hash yet, so it was not uploaded.";
    case "section-too-large":
      return "A finished section is larger than 20 MiB. The original file was not changed or deleted, and it was not uploaded.";
    case "over-provider-bytes": {
      const decision = splitWithoutTouchingSource({
        source: new Uint8Array(),
        sourcePath: "recording",
        slices: null,
      });
      return decision.action === "blocked" ? decision.detail : OVERSIZED_SINGLE_FILE_DETAIL;
    }
    default:
      return "The upload did not start.";
  }
}
