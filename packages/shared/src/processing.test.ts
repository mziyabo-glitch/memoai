import { describe, expect, it } from "vitest";
import { MAX_NOTES_AUDIO_MS } from "./notes";
import {
  MAX_SECTION_BYTES,
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
  runSectionUploads,
  settleStep,
  shouldPublish,
  splitWithoutTouchingSource,
  transcriptTimeline,
  type ProcessJob,
  type SectionInput,
} from "./processing";

const hash = (n: number) => n.toString(16).padStart(64, "a");

function section(sequence: number, overrides: Partial<SectionInput> = {}): SectionInput {
  return {
    sequence,
    sha256: hash(sequence + 1),
    sizeBytes: 1_000,
    durationMs: 45_000,
    finished: true,
    ...overrides,
  };
}

function jobFor(sections: SectionInput[] = [section(0), section(1)]): ProcessJob {
  const created = createJob({
    id: "job-1",
    ownerId: "owner-a",
    recordingId: "rec-1",
    consentAt: "2026-10-24T00:00:00.000Z",
    sections,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.job;
}

describe("planUpload", () => {
  it("requires an account and the existing consent, and refuses sample notes", () => {
    const sections = [section(0)];
    expect(planUpload({ recordingId: "rec", ownerId: null, consentAt: "t", sections, acknowledged: [] }).ok).toBe(false);
    expect(planUpload({ recordingId: "rec", ownerId: "a", consentAt: null, sections, acknowledged: [] })).toMatchObject({ reason: "no-consent" });
    expect(planUpload({ recordingId: "sample-ready", ownerId: "a", consentAt: "t", sections, acknowledged: [] })).toMatchObject({ reason: "sample" });
  });

  it("uploads finished sections only and stops at 90 minutes", () => {
    const unfinished = section(1, { finished: false, sha256: "" });
    const plan = planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [section(0), unfinished],
      acknowledged: [],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.toSend.map((item) => item.sequence)).toEqual([0]);
    }
    expect(planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [unfinished],
      acknowledged: [],
    })).toMatchObject({ reason: "no-finished-audio" });
    const tooLong = section(0, { durationMs: MAX_NOTES_AUDIO_MS + 1 });
    expect(planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [tooLong],
      acknowledged: [],
    })).toMatchObject({ reason: "too-long" });
    expect(planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [section(0, { durationMs: MAX_NOTES_AUDIO_MS })],
      acknowledged: [],
    }).ok).toBe(true);
    expect(planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [section(0, { sizeBytes: MAX_SECTION_BYTES + 1 })],
      acknowledged: [],
    })).toMatchObject({ reason: "section-too-large" });
  });

  it("does not resend a section whose hash was already acknowledged", async () => {
    const first = section(0);
    const second = section(1);
    const plan = planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [first, second],
      acknowledged: [{ sequence: 0, sha256: first.sha256 }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.toSend.map((item) => item.sequence)).toEqual([1]);
    const sent: number[] = [];
    const firstRun = await runSectionUploads({
      plan,
      cancelled: () => false,
      send: async (item) => {
        sent.push(item.sequence);
        return item.sequence === 1 ? "interrupted" : "acknowledged";
      },
    });
    expect(sent).toEqual([1]);
    expect(firstRun.status).toBe("interrupted");
    const retry = planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [first, second],
      acknowledged: firstRun.acknowledged,
    });
    expect(retry.ok && retry.toSend.map((item) => item.sequence)).toEqual([1]);
  });

  it("stops when the upload is cancelled and treats a duplicate object as acknowledged", async () => {
    const plan = planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [section(0), section(1)],
      acknowledged: [],
    });
    if (!plan.ok) throw new Error("plan");
    let calls = 0;
    const result = await runSectionUploads({
      plan,
      cancelled: () => calls > 0,
      send: async () => {
        calls += 1;
        return "acknowledged";
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.acknowledged).toHaveLength(1);
    expect(interpretUploadError("The resource already exists")).toBe("acknowledged");
    expect(interpretUploadError("network down")).toBe("interrupted");
  });
});

describe("processing jobs", () => {
  it("rejects another owner and an uncertain provider result", () => {
    const job = jobFor();
    const denied = claimStep(job, { actorOwnerId: "owner-b", workerId: "w", now: 0, leaseMs: 1_000 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("not-owner");
    const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 0, leaseMs: 1_000 });
    if (!claimed.ok) throw new Error(claimed.reason);
    const sent = markRequestSent(claimed.job, claimed.step.idempotencyKey, 10);
    const uncertain = settleStep(sent, claimed.step.idempotencyKey, { kind: "uncertain" });
    const again = claimStep(uncertain.job, { actorOwnerId: "owner-a", workerId: "w2", now: 20, leaseMs: 1_000 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("uncertain");
    expect(again.job.steps[0]?.phase).toBe("uncertain");
  });

  it("reclaims a lease that expired before the provider was called", () => {
    const job = jobFor([section(0)]);
    const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 0, leaseMs: 1_000 });
    if (!claimed.ok) throw new Error("claim");
    expect(claimed.step.requestSent).toBe(false);
    const reclaimed = claimStep(claimed.job, { actorOwnerId: "owner-a", workerId: "w2", now: 1_000, leaseMs: 1_000 });
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.step.leaseOwner).toBe("w2");
  });

  it("retries a definite rejection and then stops", () => {
    let job = jobFor([section(0)]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: attempt, leaseMs: 50 });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) return;
      const sent = markRequestSent(claimed.job, claimed.step.idempotencyKey, attempt);
      job = settleStep(sent, claimed.step.idempotencyKey, { kind: "rejected", reason: "file rejected" }).job;
    }
    const stopped = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 10, leaseMs: 50 });
    expect(stopped.ok).toBe(false);
  });

  it("reuses a finished result for the same owner, hashes, and model", () => {
    let job = jobFor([section(0)]);
    const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 0, leaseMs: 1_000 });
    if (!claimed.ok) throw new Error("claim");
    job = settleStep(markRequestSent(claimed.job, claimed.step.idempotencyKey, 1), claimed.step.idempotencyKey, {
      kind: "text",
      text: "Mina will write the consent screen by Friday.",
    }).job;
    const notes = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 2, leaseMs: 1_000 });
    if (!notes.ok) throw new Error(notes.reason);
    job = settleStep(markRequestSent(notes.job, notes.step.idempotencyKey, 3), notes.step.idempotencyKey, {
      kind: "notes",
      draft: {
        id: "job-1",
        source: "recording",
        defaultTitle: "Notes",
        status: "ready",
        failureReason: null,
        missing: null,
        sectionDurationMs: [45_000],
        passages: [],
        overview: [{
          text: "Mina will write the consent screen by Friday.",
          passageId: "section-0",
          quote: "Mina will write the consent screen by Friday.",
        }],
        keyPoints: [],
        decisions: [{ id: "invented", text: "Ship the iOS app.", passageId: "section-0" }],
        actions: [{
          id: "task",
          text: "Mina will write the consent screen by Friday.",
          passageId: "section-0",
          owner: "Mina",
          deadline: "Monday",
        }],
      },
    }).job;
    expect(job.notes?.decisions).toEqual([]);
    expect(job.notes?.actions[0]).toMatchObject({ owner: "Mina", deadline: null });
    expect(findReusableJob([job], "owner-a", job.idempotencyKey)?.id).toBe(job.id);
    expect(findReusableJob([job], "owner-b", job.idempotencyKey)).toBeNull();
    expect(shouldPublish(job)).toBe(true);
  });

  it("stops a deleted job from publishing a later result", () => {
    const job = jobFor([section(0)]);
    const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: 0, leaseMs: 1_000 });
    if (!claimed.ok) throw new Error("claim");
    const sent = markRequestSent(claimed.job, claimed.step.idempotencyKey, 1);
    const removed = deleteJob(sent);
    expect(removed.paths[0]).toBe(audioObjectPath("owner-a", "rec-1", 0, section(0).sha256));
    expect(pathOwnedBy(removed.paths[0], "owner-a")).toBe(true);
    expect(pathOwnedBy(removed.paths[0], "owner-b")).toBe(false);
    const settled = settleStep(removed.job, claimed.step.idempotencyKey, { kind: "text", text: "secret transcript" });
    expect(settled.published).toBe(false);
    expect(settled.job.notes).toBeNull();
    expect(JSON.stringify(settled.job)).not.toContain("secret transcript");
    expect(shouldPublish(settled.job)).toBe(false);
    expect(describeCloud({ signedIn: true, consented: true, upload: null, job: settled.job }).phase).toBe("deleted");
  });

  it("describes upload, processing, and failure for a real recording", () => {
    expect(describeCloud({ signedIn: false, consented: false, upload: null, job: null })).toMatchObject({ phase: "needs-account" });
    expect(describeCloud({ signedIn: true, consented: false, upload: null, job: null })).toMatchObject({ phase: "needs-consent" });
    expect(describeCloud({
      signedIn: true,
      consented: true,
      upload: { done: 1, total: 4, status: "uploading" },
      job: null,
    }).phase).toBe("uploading");
    const processing = describeCloud({ signedIn: true, consented: true, upload: null, job: jobFor() });
    expect(processing.phase).toBe("processing");
    const cancelled = describeCloud({ signedIn: true, consented: true, upload: null, job: cancelJob(jobFor()) });
    expect(cancelled.phase).toBe("cancelled");
  });
});

describe("legacy single files", () => {
  it("blocks a file over the provider limit and does not change the original bytes", () => {
    const source = new Uint8Array([9, 8, 7, 6, 5]);
    const before = source.slice();
    const blocked = splitWithoutTouchingSource({
      source,
      sourcePath: "/data/recording.m4a",
      slices: null,
    });
    expect(blocked.action).toBe("blocked");
    if (blocked.action === "blocked") {
      expect(blocked.detail).toMatch(/25 MB/);
      expect(blocked.detail).toMatch(/not cut, replace, or delete/);
      expect(blocked.writes).toEqual([]);
      expect(blocked.sourcePath).toBe("/data/recording.m4a");
    }
    expect(Array.from(source)).toEqual(Array.from(before));
    expect(planUpload({
      recordingId: "rec",
      ownerId: "a",
      consentAt: "t",
      sections: [section(0, { sizeBytes: 25_000_001 })],
      acknowledged: [],
    })).toMatchObject({ reason: "over-provider-bytes" });
  });

  it("copies only independently decodable ranges into new buffers", () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const split = splitWithoutTouchingSource({
      source,
      sourcePath: "/data/recording.m4a",
      slices: [
        { offset: 0, length: 2, independentlyDecodable: true },
        { offset: 3, length: 2, independentlyDecodable: true },
      ],
    });
    expect(split.action).toBe("split");
    if (split.action !== "split") return;
    expect(split.writes).toEqual([]);
    expect(Array.from(split.copies[0])).toEqual([1, 2]);
    expect(Array.from(split.copies[1])).toEqual([4, 5]);
    split.copies[0][0] = 99;
    expect(source[0]).toBe(1);
    const unsafe = splitWithoutTouchingSource({
      source,
      sourcePath: "/data/recording.m4a",
      slices: [{ offset: 0, length: 2, independentlyDecodable: false }],
    });
    expect(unsafe.action).toBe("blocked");
  });
});

describe("transcript timeline", () => {
  it("offsets the second section by the first section's duration", () => {
    let job = jobFor([
      section(0, { durationMs: 45_000 }),
      section(1, { durationMs: 30_000 }),
    ]);
    for (const [sequence, text, startMs] of [
      [0, "Hello there", 1_500],
      [1, "Next point", 2_000],
    ] as const) {
      const claimed = claimStep(job, { actorOwnerId: "owner-a", workerId: "w", now: sequence, leaseMs: 1_000 });
      if (!claimed.ok) throw new Error(claimed.reason);
      job = settleStep(markRequestSent(claimed.job, claimed.step.idempotencyKey, sequence), claimed.step.idempotencyKey, {
        kind: "text",
        text,
        segments: [{ text, startMs, endMs: startMs + 1_000 }],
      }).job;
    }
    expect(transcriptTimeline(job).map((passage) => ({ id: passage.id, startMs: passage.startMs, text: passage.text }))).toEqual([
      { id: "section-0-0", startMs: 1_500, text: "Hello there" },
      { id: "section-1-0", startMs: 47_000, text: "Next point" },
    ]);
  });
});
