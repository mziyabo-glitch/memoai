import { createJob, type SectionInput } from "@memoai/shared";
import { describe, expect, it } from "vitest";
import { runRecording } from "./run";

function section(sequence: number): SectionInput {
  return {
    sequence,
    sha256: sequence.toString(16).padStart(64, "a"),
    sizeBytes: 10,
    durationMs: 1_000,
    finished: true,
  };
}

describe("runRecording budget", () => {
  it("does not start the next section once the reserve passes the deadline", async () => {
    const created = createJob({
      id: "job",
      ownerId: "owner",
      recordingId: "rec",
      consentAt: "2026-10-24T00:00:00.000Z",
      sections: [section(0), section(1)],
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    let calls = 0;
    let now = 0;
    const result = await runRecording({
      job: created.job,
      workerId: "worker",
      now,
      leaseMs: 1_000,
      deadlineMs: 1_500,
      reserveMs: 1_000,
      clock: () => now,
      reload: () => created.job,
      save: () => undefined,
      readAudio: async () => new Uint8Array([1]),
      sha256: () => section(0).sha256,
      transcribe: async () => {
        calls += 1;
        now = 1_000;
        return { kind: "text", text: "kept" };
      },
      writeNotes: async () => {
        throw new Error("notes should wait");
      },
    });
    expect(calls).toBe(1);
    expect(result.stopped).toBe("budget");
    expect(result.job.steps.find((step) => step.sequence === 1)?.phase).toBe("queued");
    expect(result.job.steps.find((step) => step.sequence === 0)?.transcript).toBe("kept");
  });
});
