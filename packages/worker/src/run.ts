import { runOneStep } from "./step";

type StepInput = Parameters<typeof runOneStep>[0];

export type RecordingStop = "done" | "uncertain" | "deleted" | "cancelled" | "blocked" | "limit" | "budget";

/**
 * Walks a recording one finished section at a time, then writes notes from the
 * transcript. It does not send the whole recording in one audio request.
 * An uncertain step stops the loop so that call is not repeated.
 * When a deadline is set, the next section is not started once the reserve
 * would run past it. A section already sent is not repeated.
 */
export async function runRecording(
  input: StepInput & { maxSteps?: number; deadlineMs?: number; reserveMs?: number; clock?: () => number },
): Promise<{ job: StepInput["job"]; stepsRun: number; stopped: RecordingStop }> {
  let job = input.job;
  let stepsRun = 0;
  const maxSteps = input.maxSteps ?? 500;
  const reserveMs = input.reserveMs ?? 0;
  while (stepsRun < maxSteps) {
    const now = input.clock?.() ?? input.now;
    if (input.deadlineMs != null && now + reserveMs > input.deadlineMs) {
      return { job, stepsRun, stopped: "budget" };
    }
    const result = await runOneStep({ ...input, job, now });
    job = result.job;
    stepsRun += 1;
    if (job.steps.some((step) => step.phase === "uncertain") || result.action === "uncertain") {
      return { job, stepsRun, stopped: "uncertain" };
    }
    if (job.deleted || job.publishBlocked || result.action === "deleted") {
      return { job, stepsRun, stopped: "deleted" };
    }
    if (job.cancelled || result.action === "cancelled") {
      return { job, stepsRun, stopped: "cancelled" };
    }
    if (result.action === "not-owner") {
      return { job, stepsRun, stopped: "blocked" };
    }
    if (result.action === "idle") {
      return { job, stepsRun, stopped: "done" };
    }
  }
  return { job, stepsRun, stopped: "limit" };
}
