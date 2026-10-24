import type { NotesDraft } from "./notes";

/**
 * Development fixtures only. These words were written for the sample screens.
 * They are not the result of a recording on the phone.
 */

const SECTION_MS = 45_000;

const LIBRARY =
  "This sample is about the library. Titles stay editable and search uses the title.";
const DECISION =
  "We decided to keep audio on the phone until the user agrees to upload.";
const MINA = "Mina will write the consent screen by Friday.";
const LISTEN = "Someone needs to listen to the section boundaries.";
const END = "The lecture example ends here with no further decision.";

const readyPassages = [
  { id: "library", startMs: 0, endMs: 14_000, text: LIBRARY },
  { id: "decision", startMs: 14_000, endMs: 30_000, text: DECISION },
  { id: "mina", startMs: 30_000, endMs: 48_000, text: MINA },
  { id: "listen", startMs: 48_000, endMs: 64_000, text: LISTEN },
  { id: "end", startMs: 64_000, endMs: 80_000, text: END },
];

export const SAMPLE_NOTE_DRAFTS: readonly NotesDraft[] = [
  {
    id: "sample-ready",
    source: "sample",
    defaultTitle: "Sample · Tuesday product check-in",
    status: "ready",
    failureReason: null,
    missing: null,
    sectionDurationMs: [SECTION_MS, SECTION_MS],
    passages: readyPassages,
    overview: [
      {
        text: "This sample is about the library.",
        passageId: "library",
        quote: "This sample is about the library.",
      },
      {
        text: "Titles stay editable and search uses the title.",
        passageId: "library",
        quote: "Titles stay editable and search uses the title.",
      },
      {
        text: DECISION,
        passageId: "decision",
        quote: DECISION,
      },
    ],
    keyPoints: [
      {
        id: "point-library",
        text: "Titles stay editable and search uses the title.",
        passageId: "library",
      },
      { id: "point-decision", text: DECISION, passageId: "decision" },
      { id: "point-mina", text: MINA, passageId: "mina" },
    ],
    decisions: [{ id: "decision-upload", text: DECISION, passageId: "decision" }],
    actions: [
      {
        id: "action-mina",
        text: MINA,
        passageId: "mina",
        owner: "Mina",
        deadline: "Friday",
      },
      {
        id: "action-listen",
        text: LISTEN,
        passageId: "listen",
        owner: null,
        deadline: null,
      },
    ],
  },
  {
    id: "sample-partial",
    source: "sample",
    defaultTitle: "Sample · partial lecture",
    status: "partial",
    failureReason: null,
    missing: "Later sample lines were not produced.",
    sectionDurationMs: [SECTION_MS, SECTION_MS],
    passages: readyPassages.slice(0, 2),
    overview: [
      {
        text: "This sample is about the library.",
        passageId: "library",
        quote: "This sample is about the library.",
      },
    ],
    keyPoints: [
      {
        id: "partial-library",
        text: "Titles stay editable and search uses the title.",
        passageId: "library",
      },
    ],
    decisions: [{ id: "partial-decision", text: DECISION, passageId: "decision" }],
    actions: [
      {
        id: "partial-invented",
        text: "Email the board the budget.",
        passageId: "library",
        owner: "Alex",
        deadline: "Monday",
      },
    ],
  },
  {
    id: "sample-failed",
    source: "sample",
    defaultTitle: "Sample · failed notes",
    status: "failed",
    failureReason: "Sample failure: notes were not created.",
    missing: null,
    sectionDurationMs: [SECTION_MS],
    passages: [readyPassages[0]],
    overview: [
      {
        text: "Ship the iOS app next Monday.",
        passageId: "library",
        quote: "Ship the iOS app next Monday.",
      },
    ],
    keyPoints: [
      {
        id: "failed-point",
        text: "Ship the iOS app next Monday.",
        passageId: "library",
      },
    ],
    decisions: [
      {
        id: "failed-decision",
        text: "Ship the iOS app next Monday.",
        passageId: "library",
      },
    ],
    actions: [
      {
        id: "failed-action",
        text: "Email the board the budget.",
        passageId: "library",
        owner: "Alex",
        deadline: "Monday",
      },
    ],
  },
];
