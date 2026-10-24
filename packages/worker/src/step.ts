import {
  claimStep,
  markRequestSent,
  settleStep,
  type ProcessJob,
  type StepSettlement,
} from "@memoai/shared";

export type ProviderOutcome = StepSettlement;

/**
 * One worker invocation handles one section, or the notes step after every
 * section transcript exists. It does not send a whole recording at once.
 */
export async function runOneStep(input: {
  job: ProcessJob;
  workerId: string;
  now: number;
  leaseMs: number;
  reload: () => ProcessJob;
  save: (job: ProcessJob) => void;
  readAudio: (sha256: string) => Promise<Uint8Array | null>;
  sha256: (bytes: Uint8Array) => string;
  transcribe: (step: { idempotencyKey: string; model: string; bytes: Uint8Array }) => Promise<ProviderOutcome>;
  writeNotes: (step: { idempotencyKey: string; model: string; transcript: string }) => Promise<ProviderOutcome>;
}): Promise<{ job: ProcessJob; action: string }> {
  const claimed = claimStep(input.job, {
    actorOwnerId: input.job.ownerId,
    workerId: input.workerId,
    now: input.now,
    leaseMs: input.leaseMs,
  });
  if (!claimed.ok) {
    input.save(claimed.job);
    return { job: claimed.job, action: claimed.reason };
  }
  const sent = markRequestSent(claimed.job, claimed.step.idempotencyKey, input.now);
  input.save(sent);
  let outcome: ProviderOutcome;
  if (claimed.step.operation === "transcribe") {
    const bytes = await input.readAudio(claimed.step.sha256 ?? "");
    const digest = bytes ? input.sha256(bytes) : "";
    if (!bytes || digest !== claimed.step.sha256) {
      outcome = { kind: "rejected", reason: "Audio hash did not match the acknowledged section." };
    } else {
      outcome = await input.transcribe({
        idempotencyKey: claimed.step.idempotencyKey,
        model: input.job.transcribeModel,
        bytes,
      });
    }
  } else {
    const transcript = sent.steps
      .filter((step) => step.operation === "transcribe" && step.transcript)
      .map((step) => step.transcript)
      .join("\n");
    outcome = await input.writeNotes({
      idempotencyKey: claimed.step.idempotencyKey,
      model: input.job.notesModel,
      transcript,
    });
  }
  const latest = input.reload();
  const settled = settleStep(latest, claimed.step.idempotencyKey, outcome);
  input.save(settled.job);
  return { job: settled.job, action: settled.published ? "published" : "withheld" };
}
