import { describe, expect, it } from "vitest";
import { createJob, type ProcessJob, type SectionInput } from "@memoai/shared";
import { runOneStep } from "./step";

const hash = "a".repeat(64);

function section(): SectionInput {
  return { sequence: 0, sha256: hash, sizeBytes: 100, durationMs: 1_000, finished: true };
}

function job(): ProcessJob {
  const created = createJob({
    id: "job",
    ownerId: "owner",
    recordingId: "rec",
    consentAt: "2026-10-24T00:00:00.000Z",
    sections: [section()],
  });
  if (!created.ok) throw new Error(created.reason);
  return created.job;
}

describe("runOneStep", () => {
  it("does not repeat a provider call after an uncertain timeout", async () => {
    let stored = job();
    let calls = 0;
    const once = await runOneStep({
      job: stored,
      workerId: "worker",
      now: 0,
      leaseMs: 1_000,
      reload: () => stored,
      save: (next) => {
        stored = next;
      },
      readAudio: async () => new Uint8Array([1, 2, 3]),
      sha256: () => hash,
      transcribe: async () => {
        calls += 1;
        return { kind: "uncertain" };
      },
      writeNotes: async () => {
        throw new Error("notes should wait");
      },
    });
    expect(calls).toBe(1);
    expect(once.action).toBe("withheld");
    const again = await runOneStep({
      job: stored,
      workerId: "worker",
      now: 2_000,
      leaseMs: 1_000,
      reload: () => stored,
      save: (next) => {
        stored = next;
      },
      readAudio: async () => new Uint8Array([1, 2, 3]),
      sha256: () => hash,
      transcribe: async () => {
        calls += 1;
        return { kind: "text", text: "again" };
      },
      writeNotes: async () => {
        throw new Error("notes should wait");
      },
    });
    expect(calls).toBe(1);
    expect(again.action).toBe("uncertain");
    expect(JSON.stringify(stored)).not.toContain("again");
  });

  it("does not call the provider when the audio hash does not match", async () => {
    let stored = job();
    let calls = 0;
    await runOneStep({
      job: stored,
      workerId: "worker",
      now: 0,
      leaseMs: 1_000,
      reload: () => stored,
      save: (next) => {
        stored = next;
      },
      readAudio: async () => new Uint8Array([1]),
      sha256: () => "b".repeat(64),
      transcribe: async () => {
        calls += 1;
        return { kind: "text", text: "nope" };
      },
      writeNotes: async () => ({ kind: "unusable", reason: "no" }),
    });
    expect(calls).toBe(0);
    expect(stored.failureReason).toMatch(/hash/);
  });

  it("drops a transcript that arrives after deletion", async () => {
    let stored = job();
    const result = await runOneStep({
      job: stored,
      workerId: "worker",
      now: 0,
      leaseMs: 1_000,
      reload: () => stored,
      save: (next) => {
        stored = next;
      },
      readAudio: async () => new Uint8Array([1]),
      sha256: () => hash,
      transcribe: async () => {
        stored = { ...stored, deleted: true, publishBlocked: true, notes: null };
        return { kind: "text", text: "late transcript" };
      },
      writeNotes: async () => ({ kind: "unusable", reason: "no" }),
    });
    expect(result.action).toBe("withheld");
    expect(JSON.stringify(result.job)).not.toContain("late transcript");
  });
});
