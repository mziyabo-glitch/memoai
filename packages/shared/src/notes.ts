/**
 * Local notes model. This module does not call a network, read a key, or
 * upload audio. A transcription provider is intentionally absent.
 */

export const MAX_NOTES_AUDIO_MS = 90 * 60 * 1000;
export const TITLE_MAX_LENGTH = 80;

const OVERVIEW_SKIP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "is",
  "are",
  "was",
  "were",
  "be",
  "it",
  "we",
  "you",
  "they",
  "from",
  "by",
  "as",
  "at",
  "if",
  "so",
  "but",
  "about",
  "into",
  "than",
  "then",
  "when",
]);

export const NOTES_UPLOAD_EXPLANATION = {
  version: 1 as const,
  title: "Create notes",
  intro:
    "MemoAI can write a transcript, a short summary, and action items from this recording. A transcription service outside this phone would do the writing.",
  leavesTitle: "What would leave this phone",
  leaves:
    "Only the finished audio for this recording. Ordered sections are sent in order. A single-file recording sends that one file. Unfinished recovery files stay on the phone and are not included. Finished audio longer than 90 minutes is not included.",
  whyTitle: "Why",
  why:
    "The service needs the spoken audio to write down the words. The summary, decisions, and tasks come from that transcript. MemoAI does not add decisions or tasks the words do not state.",
  staysTitle: "What stays here",
  stays:
    "The recording remains in your library. Agreeing does not delete it and does not start recording.",
  notYetTitle: "Nothing is sent now",
  notYet:
    "No transcription service is connected. MemoAI will not upload this audio. Agreeing saves your permission on this phone only. You can say no and keep the audio here.",
  agree: "Agree — keep the audio on this phone",
  decline: "Don't upload",
  saved:
    "Permission is saved on this phone. No audio was uploaded. Notes are not available because no transcription service is connected.",
};

export type NotesPassage = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type NotesOverviewLine = {
  text: string;
  passageId: string;
  quote: string;
};

export type NotesPoint = {
  id: string;
  text: string;
  passageId: string;
};

export type NotesAction = {
  id: string;
  text: string;
  passageId: string;
  owner: string | null;
  deadline: string | null;
};

export type NotesDraft = {
  id: string;
  source: "sample" | "recording";
  defaultTitle: string;
  status: "ready" | "partial" | "failed";
  failureReason: string | null;
  missing: string | null;
  /** Section lengths used to map a timestamp. Samples have no audio files. */
  sectionDurationMs: number[];
  passages: NotesPassage[];
  overview: NotesOverviewLine[];
  keyPoints: NotesPoint[];
  decisions: NotesPoint[];
  actions: NotesAction[];
};

export type GroundedNotes = {
  source: "sample" | "recording";
  status: "ready" | "partial" | "failed";
  failureReason: string | null;
  missing: string | null;
  passages: NotesPassage[];
  overview: string[];
  keyPoints: NotesPoint[];
  decisions: NotesPoint[];
  actions: NotesAction[];
};

export type AudioPart = {
  durationMs: number;
};

export type NotesConsentRecord = {
  version: 1;
  recordingId: string;
  agreedAt: string;
  explanationVersion: 1;
  uploaded: false;
  providerCalled: false;
};

export type RecordingNotesPhase =
  | "live"
  | "no-audio"
  | "too-long"
  | "none"
  | "not-processed";

const FAILED_WITHOUT_REASON = "Notes could not be created.";
const INCOMPLETE = "These notes are incomplete.";
const WITHHELD =
  "Some notes were left out because the transcript does not support them.";
const NO_TRANSCRIPT = "There is no transcript to summarize.";

export function groundNotes(draft: NotesDraft): GroundedNotes {
  const passages = uniquePassages(draft.passages);
  if (draft.status === "failed") {
    return {
      source: draft.source,
      status: "failed",
      failureReason: cleanSentence(draft.failureReason) ?? FAILED_WITHOUT_REASON,
      missing: null,
      passages,
      overview: [],
      keyPoints: [],
      decisions: [],
      actions: [],
    };
  }

  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  let withheld = false;
  const overview = draft.overview.flatMap((line) => {
    const kept = groundOverviewLine(line, byId);
    if (!kept) {
      withheld = true;
      return [];
    }
    return [kept];
  });
  const keyPoints = draft.keyPoints.flatMap((point) => {
    const kept = groundPoint(point, byId);
    if (!kept) {
      withheld = true;
      return [];
    }
    return [kept];
  });
  const decisions = draft.decisions.flatMap((point) => {
    const kept = groundPoint(point, byId);
    if (!kept) {
      withheld = true;
      return [];
    }
    return [kept];
  });
  const actions = draft.actions.flatMap((action) => {
    const kept = groundAction(action, byId);
    if (!kept) {
      withheld = true;
      return [];
    }
    return [kept];
  });

  if (passages.length === 0) {
    return {
      source: draft.source,
      status: "failed",
      failureReason: NO_TRANSCRIPT,
      missing: null,
      passages,
      overview: [],
      keyPoints: [],
      decisions: [],
      actions: [],
    };
  }

  const missing =
    cleanSentence(draft.missing) ??
    (withheld ? WITHHELD : draft.status === "partial" ? INCOMPLETE : null);
  const status: GroundedNotes["status"] =
    draft.status === "partial" || withheld || missing != null ? "partial" : "ready";

  return {
    source: draft.source,
    status,
    failureReason: null,
    missing: status === "partial" ? (missing ?? INCOMPLETE) : null,
    passages,
    overview,
    keyPoints,
    decisions,
    actions,
  };
}

export function locateAudioSection(
  parts: readonly AudioPart[],
  startMs: number,
): { partIndex: number; offsetMs: number } | null {
  if (!Number.isFinite(startMs) || startMs < 0 || parts.length === 0) {
    return null;
  }
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const duration = parts[index].durationMs;
    if (!Number.isFinite(duration) || duration < 0) {
      return null;
    }
    const next = cursor + duration;
    if (startMs < next) {
      return { partIndex: index, offsetMs: startMs - cursor };
    }
    cursor = next;
  }
  return null;
}

export function sectionStartMs(
  parts: readonly AudioPart[],
  index: number,
): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) {
    return null;
  }
  let cursor = 0;
  for (let partIndex = 0; partIndex < index; partIndex += 1) {
    const duration = parts[partIndex].durationMs;
    if (!Number.isFinite(duration) || duration < 0) {
      return null;
    }
    cursor += duration;
  }
  return cursor;
}

export function audioPartLabel(partCount: number, index: number): string {
  if (partCount <= 1) {
    return "Play audio";
  }
  return `Play section ${index + 1}`;
}

export function sampleNotesLabel(
  status: GroundedNotes["status"],
): string {
  if (status === "ready") {
    return "Sample · notes";
  }
  if (status === "partial") {
    return "Sample · partial notes";
  }
  return "Sample · failed";
}

export function recordingNotesPhase(input: {
  live: boolean;
  playableParts: number;
  elapsedMs: number;
  consented: boolean;
}): RecordingNotesPhase {
  if (input.live) {
    return "live";
  }
  if (input.playableParts < 1) {
    return "no-audio";
  }
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs > MAX_NOTES_AUDIO_MS) {
    return "too-long";
  }
  if (input.consented) {
    return "not-processed";
  }
  return "none";
}

export function recordingNotesLabel(phase: RecordingNotesPhase): string {
  switch (phase) {
    case "live":
      return "Notes after saving";
    case "no-audio":
      return "No notes · audio incomplete";
    case "too-long":
      return "No notes · longer than 90 minutes";
    case "not-processed":
      return "Not processed · audio stayed on this phone";
    case "none":
      return "No notes";
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function notesConsentRecord(
  recordingId: string,
  agreedAt: string,
): NotesConsentRecord {
  return {
    version: 1,
    recordingId,
    agreedAt,
    explanationVersion: NOTES_UPLOAD_EXPLANATION.version,
    uploaded: false,
    providerCalled: false,
  };
}

/** Agreeing records permission only. It does not upload or call a provider. */
export function acceptNotesConsent(): {
  uploaded: false;
  providerCalled: false;
  status: "not-processed";
} {
  return { uploaded: false, providerCalled: false, status: "not-processed" };
}

export function cleanTitle(input: string): string | null {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, TITLE_MAX_LENGTH);
}

export function matchesTitleQuery(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return title.toLowerCase().includes(needle);
}

export function formatNotesForShare(
  notes: GroundedNotes,
  title: string,
  doneIds: readonly string[] = [],
): string | null {
  if (notes.status !== "ready") {
    return null;
  }
  const done = new Set(doneIds);
  const lines: string[] = [];
  if (notes.source === "sample") {
    lines.push("SAMPLE");
    lines.push("These notes were not created from a recording.");
    lines.push("");
  }
  lines.push(title.trim() || "Notes");
  lines.push("");
  lines.push("Overview");
  if (notes.overview.length === 0) {
    lines.push("No overview was stated.");
  } else {
    lines.push(...notes.overview);
  }
  lines.push("");
  lines.push("Key points");
  if (notes.keyPoints.length === 0) {
    lines.push("None.");
  } else {
    for (const point of notes.keyPoints) {
      lines.push(`- ${point.text}`);
    }
  }
  lines.push("");
  lines.push("Decisions");
  if (notes.decisions.length === 0) {
    lines.push("No decision was stated in the transcript.");
  } else {
    for (const decision of notes.decisions) {
      lines.push(`- ${decision.text}`);
    }
  }
  lines.push("");
  lines.push("Actions");
  if (notes.actions.length === 0) {
    lines.push("No task was stated in the transcript.");
  } else {
    for (const action of notes.actions) {
      const mark = done.has(action.id) ? "[x]" : "[ ]";
      lines.push(`- ${mark} ${action.text}${assignment(action)}`);
    }
  }
  lines.push("");
  lines.push("Transcript");
  for (const passage of notes.passages) {
    lines.push(`${formatClock(passage.startMs)} ${passage.text}`);
  }
  return lines.join("\n");
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function assignment(action: NotesAction): string {
  const owner = action.owner ? `Owner: ${action.owner}.` : "Owner not set.";
  const deadline = action.deadline
    ? `Deadline: ${action.deadline}.`
    : "Deadline not set.";
  return ` ${owner} ${deadline}`;
}

function uniquePassages(passages: readonly NotesPassage[]): NotesPassage[] {
  const seen = new Set<string>();
  const kept: NotesPassage[] = [];
  for (const passage of passages) {
    if (!isPassage(passage) || seen.has(passage.id)) {
      continue;
    }
    seen.add(passage.id);
    kept.push({
      id: passage.id,
      startMs: passage.startMs,
      endMs: passage.endMs,
      text: normalizeSpace(passage.text),
    });
  }
  kept.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  return kept;
}

function isPassage(value: NotesPassage): boolean {
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    Number.isFinite(value.startMs) &&
    Number.isFinite(value.endMs) &&
    value.startMs >= 0 &&
    value.endMs >= value.startMs &&
    typeof value.text === "string" &&
    normalizeSpace(value.text).length > 0
  );
}

function groundOverviewLine(
  line: NotesOverviewLine,
  passages: ReadonlyMap<string, NotesPassage>,
): string | null {
  const passage = passages.get(line.passageId);
  const text = normalizeSpace(line.text);
  const quote = normalizeSpace(line.quote);
  if (!passage || !text || !quote) {
    return null;
  }
  if (!containsQuote(passage.text, quote) || !wordsSupported(text, passage.text)) {
    return null;
  }
  return text;
}

function groundPoint(
  point: NotesPoint,
  passages: ReadonlyMap<string, NotesPassage>,
): NotesPoint | null {
  const passage = passages.get(point.passageId);
  const text = normalizeSpace(point.text);
  if (!passage || !text || !containsQuote(passage.text, text)) {
    return null;
  }
  return { id: point.id, text, passageId: point.passageId };
}

function groundAction(
  action: NotesAction,
  passages: ReadonlyMap<string, NotesPassage>,
): NotesAction | null {
  const passage = passages.get(action.passageId);
  const text = normalizeSpace(action.text);
  if (!passage || !text || !containsQuote(passage.text, text) || !action.id) {
    return null;
  }
  return {
    id: action.id,
    text,
    passageId: action.passageId,
    owner: explicitPhrase(passage.text, action.owner),
    deadline: explicitPhrase(passage.text, action.deadline),
  };
}

function wordsSupported(sentence: string, passage: string): boolean {
  const haystack = passage.toLowerCase();
  const words = sentence.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.every((word) => OVERVIEW_SKIP.has(word) || haystack.includes(word));
}

function containsQuote(passage: string, quote: string): boolean {
  const needle = normalizeSpace(quote);
  if (!needle) {
    return false;
  }
  return normalizeSpace(passage).includes(needle);
}

function explicitPhrase(passage: string, phrase: string | null): string | null {
  if (phrase == null) {
    return null;
  }
  const needle = normalizeSpace(phrase);
  if (!needle || needle.length > 40 || needle.split(" ").length > 4) {
    return null;
  }
  let from = 0;
  while (from <= passage.length) {
    const at = passage.indexOf(needle, from);
    if (at < 0) {
      return null;
    }
    const before = at === 0 ? "" : passage.charAt(at - 1);
    const after = passage.charAt(at + needle.length);
    if (!isWordChar(before) && !isWordChar(after)) {
      return needle;
    }
    from = at + 1;
  }
  return null;
}

function isWordChar(char: string): boolean {
  return char !== "" && /[0-9A-Za-z]/.test(char);
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanSentence(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const cleaned = normalizeSpace(value);
  return cleaned.length > 0 ? cleaned : null;
}
