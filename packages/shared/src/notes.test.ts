import { describe, expect, it } from "vitest";
import {
  MAX_NOTES_AUDIO_MS,
  NOTES_UPLOAD_EXPLANATION,
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
  type NotesDraft,
} from "./notes";
import { SAMPLE_NOTE_DRAFTS } from "./sampleNotes";

const ready = SAMPLE_NOTE_DRAFTS[0];
const partial = SAMPLE_NOTE_DRAFTS[1];
const failed = SAMPLE_NOTE_DRAFTS[2];

function draft(overrides: Partial<NotesDraft>): NotesDraft {
  return {
    id: "draft",
    source: "recording",
    defaultTitle: "Notes",
    status: "ready",
    failureReason: null,
    missing: null,
    sectionDurationMs: [45_000],
    passages: [
      {
        id: "one",
        startMs: 0,
        endMs: 1_000,
        text: "Mina will send the note by Friday.",
      },
    ],
    overview: [],
    keyPoints: [],
    decisions: [],
    actions: [],
    ...overrides,
  };
}

describe("sample notes", () => {
  it("keeps the finished sample grounded and labelled as a sample", () => {
    const notes = groundNotes(ready);
    expect(notes.source).toBe("sample");
    expect(notes.status).toBe("ready");
    expect(notes.decisions.map((item) => item.text)).toEqual([
      "We decided to keep audio on the phone until the user agrees to upload.",
    ]);
    expect(notes.actions[0]).toMatchObject({ owner: "Mina", deadline: "Friday" });
    expect(notes.actions[1]).toMatchObject({ owner: null, deadline: null });
    expect(sampleNotesLabel(notes.status)).toBe("Sample · notes");
    expect(ready.defaultTitle.startsWith("Sample")).toBe(true);
  });

  it("shows a partial sample without the task the transcript does not say", () => {
    const notes = groundNotes(partial);
    expect(notes.status).toBe("partial");
    expect(notes.missing).toBe("Later sample lines were not produced.");
    expect(notes.decisions).toHaveLength(1);
    expect(notes.actions).toEqual([]);
    expect(JSON.stringify(notes)).not.toContain("Alex");
    expect(JSON.stringify(notes)).not.toContain("budget");
    expect(sampleNotesLabel(notes.status)).toBe("Sample · partial notes");
  });

  it("shows a failed sample transcript and drops the invented summary", () => {
    const notes = groundNotes(failed);
    expect(notes.status).toBe("failed");
    expect(notes.failureReason).toBe("Sample failure: notes were not created.");
    expect(notes.passages).toHaveLength(1);
    expect(notes.overview).toEqual([]);
    expect(notes.keyPoints).toEqual([]);
    expect(notes.decisions).toEqual([]);
    expect(notes.actions).toEqual([]);
    expect(JSON.stringify(notes)).not.toContain("iOS");
    expect(sampleNotesLabel(notes.status)).toBe("Sample · failed");
  });
});

describe("groundNotes", () => {
  it("drops a decision that the cited passage does not say", () => {
    const notes = groundNotes(
      draft({
        decisions: [
          {
            id: "invented",
            text: "Ship the iOS app.",
            passageId: "one",
          },
        ],
      }),
    );
    expect(notes.status).toBe("partial");
    expect(notes.decisions).toEqual([]);
    expect(notes.missing).toMatch(/transcript does not support/);
  });

  it("clears an owner and deadline the passage does not state", () => {
    const notes = groundNotes(
      draft({
        actions: [
          {
            id: "task",
            text: "Mina will send the note by Friday.",
            passageId: "one",
            owner: "Alex",
            deadline: "Monday",
          },
        ],
      }),
    );
    expect(notes.status).toBe("ready");
    expect(notes.actions).toEqual([
      {
        id: "task",
        text: "Mina will send the note by Friday.",
        passageId: "one",
        owner: null,
        deadline: null,
      },
    ]);
  });

  it("does not treat a match inside another word as a name or date", () => {
    const notes = groundNotes(
      draft({
        passages: [
          {
            id: "one",
            startMs: 0,
            endMs: 1_000,
            text: "Minasota will send the note by Friday.",
          },
        ],
        actions: [
          {
            id: "task",
            text: "Minasota will send the note by Friday.",
            passageId: "one",
            owner: "Mina",
            deadline: "day",
          },
        ],
      }),
    );
    expect(notes.actions[0]).toMatchObject({ owner: null, deadline: null });
  });

  it("drops an overview line that adds a word the passage does not contain", () => {
    const notes = groundNotes(
      draft({
        overview: [
          {
            text: "We decided not to upload.",
            passageId: "one",
            quote: "Mina will send",
          },
        ],
      }),
    );
    expect(notes.overview).toEqual([]);
    expect(notes.status).toBe("partial");
  });

  it("does not keep summary fields when creation failed", () => {
    const notes = groundNotes(
      draft({
        status: "failed",
        failureReason: "  ",
        overview: [
          { text: "Mina will send the note by Friday.", passageId: "one", quote: "Friday" },
        ],
        decisions: [
          { id: "d", text: "Mina will send the note by Friday.", passageId: "one" },
        ],
      }),
    );
    expect(notes.failureReason).toBe("Notes could not be created.");
    expect(notes.overview).toEqual([]);
    expect(notes.decisions).toEqual([]);
  });

  it("does not summarize an empty transcript", () => {
    const notes = groundNotes(
      draft({
        passages: [],
        overview: [
          { text: "Anything.", passageId: "one", quote: "Anything." },
        ],
      }),
    );
    expect(notes.status).toBe("failed");
    expect(notes.failureReason).toBe("There is no transcript to summarize.");
  });

  it("copies passage words only and drops a speaker label", () => {
    const notes = groundNotes(
      draft({
        passages: [
          {
            id: "one",
            startMs: 0,
            endMs: 1_000,
            text: "Hello there.",
            speaker: "Alex",
          } as NotesDraft["passages"][number],
        ],
      }),
    );
    expect(notes.passages[0]).toEqual({
      id: "one",
      startMs: 0,
      endMs: 1_000,
      text: "Hello there.",
    });
  });
});

describe("audio sections", () => {
  it("maps a timestamp onto one file or the ordered section", () => {
    expect(locateAudioSection([{ durationMs: 60_000 }], 0)).toEqual({
      partIndex: 0,
      offsetMs: 0,
    });
    expect(locateAudioSection([{ durationMs: 60_000 }], 59_999)).toEqual({
      partIndex: 0,
      offsetMs: 59_999,
    });
    expect(locateAudioSection([{ durationMs: 60_000 }], 60_000)).toBeNull();
    const sections = [{ durationMs: 45_000 }, { durationMs: 45_000 }];
    expect(locateAudioSection(sections, 45_000)).toEqual({
      partIndex: 1,
      offsetMs: 0,
    });
    expect(locateAudioSection(sections, 48_000)).toEqual({
      partIndex: 1,
      offsetMs: 3_000,
    });
    expect(sectionStartMs(sections, 1)).toBe(45_000);
    expect(locateAudioSection([], 0)).toBeNull();
    expect(locateAudioSection(sections, -1)).toBeNull();
    expect(audioPartLabel(1, 0)).toBe("Play audio");
    expect(audioPartLabel(2, 1)).toBe("Play section 2");
  });
});

describe("consent and library", () => {
  it("records permission without upload or a provider call", () => {
    expect(acceptNotesConsent()).toEqual({
      uploaded: false,
      providerCalled: false,
      status: "not-processed",
    });
    expect(notesConsentRecord("rec-1", "2026-10-24T00:00:00.000Z")).toMatchObject({
      uploaded: false,
      providerCalled: false,
      explanationVersion: 1,
    });
    expect(NOTES_UPLOAD_EXPLANATION.leaves).toMatch(/Ordered sections/);
    expect(NOTES_UPLOAD_EXPLANATION.leaves).toMatch(/single-file/);
    expect(NOTES_UPLOAD_EXPLANATION.why).toMatch(/transcript/);
    expect(NOTES_UPLOAD_EXPLANATION.notYet).toMatch(/will not upload/);
    expect(NOTES_UPLOAD_EXPLANATION.leaves).toMatch(/90 minutes/);
  });

  it("labels processing before any notes exist", () => {
    expect(
      recordingNotesPhase({
        live: true,
        playableParts: 1,
        elapsedMs: 1,
        consented: false,
      }),
    ).toBe("live");
    expect(
      recordingNotesPhase({
        live: false,
        playableParts: 0,
        elapsedMs: 1,
        consented: true,
      }),
    ).toBe("no-audio");
    expect(
      recordingNotesPhase({
        live: false,
        playableParts: 2,
        elapsedMs: MAX_NOTES_AUDIO_MS,
        consented: false,
      }),
    ).toBe("none");
    expect(
      recordingNotesPhase({
        live: false,
        playableParts: 2,
        elapsedMs: MAX_NOTES_AUDIO_MS + 1,
        consented: true,
      }),
    ).toBe("too-long");
    expect(
      recordingNotesLabel(
        recordingNotesPhase({
          live: false,
          playableParts: 1,
          elapsedMs: 1_000,
          consented: true,
        }),
      ),
    ).toBe("Not processed · audio stayed on this phone");
    expect(recordingNotesLabel("none")).toBe("No notes");
  });

  it("searches and stores a readable title", () => {
    expect(matchesTitleQuery("Tuesday product check-in", "  PRODUCT ")).toBe(true);
    expect(matchesTitleQuery("Tuesday", "lecture")).toBe(false);
    expect(matchesTitleQuery("Tuesday", " ")).toBe(true);
    expect(cleanTitle("  Tuesday   sync  ")).toBe("Tuesday sync");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("a".repeat(90))?.length).toBe(80);
  });
});

describe("formatNotesForShare", () => {
  it("shares finished sample notes and withholds unfinished notes", () => {
    const text = formatNotesForShare(groundNotes(ready), ready.defaultTitle, [
      "action-mina",
    ]);
    expect(text).toContain("SAMPLE");
    expect(text).toContain("were not created from a recording");
    expect(text).toContain("[x] Mina will write the consent screen by Friday.");
    expect(text).toContain("Owner: Mina.");
    expect(text).toContain("Deadline: Friday.");
    expect(text).toContain("[ ] Someone needs to listen to the section boundaries.");
    expect(text).toContain("Owner not set.");
    expect(text).toContain("Deadline not set.");
    expect(text).not.toContain("iOS");
    expect(formatNotesForShare(groundNotes(partial), partial.defaultTitle)).toBeNull();
    expect(formatNotesForShare(groundNotes(failed), failed.defaultTitle)).toBeNull();
    expect(formatClock(65_000)).toBe("1:05");
  });
});
