import {
  NOTES_MODEL,
  TRANSCRIBE_MODEL,
  type NotesDraft,
  type StepSettlement,
  type TimedSnippet,
} from "@memoai/shared";
import { providerCallAllowed } from "./env";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const NOTES_URL = "https://api.openai.com/v1/chat/completions";

const NOTES_INSTRUCTIONS =
  "Write notes only from the transcript. Do not invent facts, speakers, decisions, or tasks. A decision or task must be an exact quote. Set owner and deadline only when that name or date is in the quote. Return JSON with overview, keyPoints, decisions, and actions. Each item's passageId must be one of the ids in the transcript.";

export function transcriptionHeaders(input: {
  apiKey: string;
  idempotencyKey: string;
}): { url: string; headers: Record<string, string> } {
  return {
    url: TRANSCRIPTIONS_URL,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Idempotency-Key": input.idempotencyKey,
    },
  };
}

export function notesRequestBody(input: {
  model: string;
  transcript: string;
}): { url: string; body: string } {
  return {
    url: NOTES_URL,
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: NOTES_INSTRUCTIONS },
        { role: "user", content: input.transcript },
      ],
    }),
  };
}

export function classifyProviderStatus(status: number): "rejected" | "uncertain" {
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return "uncertain";
  }
  return "rejected";
}

export function interpretTranscriptionHttp(status: number, raw: string): StepSettlement {
  if (status < 200 || status >= 300) {
    const kind = classifyProviderStatus(status);
    if (kind === "uncertain") {
      return { kind: "uncertain" };
    }
    return {
      kind: "rejected",
      reason: `The provider refused the audio before accepting it (HTTP ${status}). The original recording was not changed.`,
    };
  }
  let payload: { text?: unknown; segments?: unknown };
  try {
    payload = JSON.parse(raw) as { text?: unknown; segments?: unknown };
  } catch {
    return { kind: "unusable", reason: "The provider returned a transcript that was not JSON." };
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return { kind: "unusable", reason: "The provider returned an empty transcript." };
  }
  const segments = readSegments(payload.segments);
  return segments ? { kind: "text", text, segments } : { kind: "text", text };
}

export function interpretNotesHttp(status: number, raw: string, jobId: string): StepSettlement {
  if (status < 200 || status >= 300) {
    const kind = classifyProviderStatus(status);
    if (kind === "uncertain") {
      return { kind: "uncertain" };
    }
    return { kind: "rejected", reason: `The notes request was refused (HTTP ${status}).` };
  }
  let payload: { choices?: { message?: { content?: unknown } }[] };
  try {
    payload = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] };
  } catch {
    return { kind: "unusable", reason: "The notes response was not JSON." };
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { kind: "unusable", reason: "The notes response had no content." };
  }
  let draftJson: unknown;
  try {
    draftJson = JSON.parse(content);
  } catch {
    return { kind: "unusable", reason: "The notes content was not JSON." };
  }
  return { kind: "notes", draft: draftFromModel(draftJson, jobId) };
}

/** Refuses to call the network unless the server explicitly allows it. */
export async function transcribeAudio(input: {
  env: Record<string, string | undefined>;
  apiKey: string;
  model: string;
  idempotencyKey: string;
  filename: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<StepSettlement> {
  if (!providerCallAllowed(input.env)) {
    throw new Error("Live provider calls are disabled.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = transcriptionHeaders({
    apiKey: input.apiKey,
    idempotencyKey: input.idempotencyKey,
  });
  const body = new FormData();
  body.set("model", input.model || TRANSCRIBE_MODEL);
  body.set("response_format", "verbose_json");
  body.append("timestamp_granularities[]", "segment");
  const copy = new ArrayBuffer(input.bytes.byteLength);
  new Uint8Array(copy).set(input.bytes);
  body.set("file", new Blob([copy], { type: "audio/mp4" }), input.filename);
  let response: Response;
  try {
    response = await fetchImpl(headers.url, {
      method: "POST",
      headers: headers.headers,
      body,
    });
  } catch {
    return { kind: "uncertain" };
  }
  return interpretTranscriptionHttp(response.status, await response.text());
}

export async function requestNotes(input: {
  env: Record<string, string | undefined>;
  apiKey: string;
  model: string;
  idempotencyKey: string;
  transcript: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<StepSettlement> {
  if (!providerCallAllowed(input.env)) {
    throw new Error("Live provider calls are disabled.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const notes = notesRequestBody({
    model: input.model || NOTES_MODEL,
    transcript: input.transcript,
  });
  let response: Response;
  try {
    response = await fetchImpl(notes.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: notes.body,
    });
  } catch {
    return { kind: "uncertain" };
  }
  return interpretNotesHttp(response.status, await response.text(), input.jobId);
}

function readSegments(value: unknown): TimedSnippet[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const segments: TimedSnippet[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { text?: unknown; start?: unknown; end?: unknown };
    if (typeof record.text !== "string" || typeof record.start !== "number" || typeof record.end !== "number") {
      continue;
    }
    segments.push({
      text: record.text,
      startMs: Math.round(record.start * 1000),
      endMs: Math.round(record.end * 1000),
    });
  }
  return segments.length > 0 ? segments : null;
}

function draftFromModel(value: unknown, jobId: string): NotesDraft {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const overview = readOverview(record.overview);
  return {
    id: jobId,
    source: "recording",
    defaultTitle: overview[0]?.text.slice(0, 80) || "Notes",
    status: "ready",
    failureReason: null,
    missing: null,
    sectionDurationMs: [],
    passages: [],
    overview,
    keyPoints: readPoints(record.keyPoints),
    decisions: readPoints(record.decisions),
    actions: readActions(record.actions),
  };
}

function readOverview(value: unknown): NotesDraft["overview"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { text?: unknown; passageId?: unknown; quote?: unknown };
    if (typeof record.text !== "string" || typeof record.passageId !== "string" || typeof record.quote !== "string") {
      return [];
    }
    return [{ text: record.text, passageId: record.passageId, quote: record.quote }];
  });
}

function readPoints(value: unknown): NotesDraft["keyPoints"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { id?: unknown; text?: unknown; passageId?: unknown };
    if (typeof record.text !== "string" || typeof record.passageId !== "string") {
      return [];
    }
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `point-${index}`,
      text: record.text,
      passageId: record.passageId,
    }];
  });
}

function readActions(value: unknown): NotesDraft["actions"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as {
      id?: unknown;
      text?: unknown;
      passageId?: unknown;
      owner?: unknown;
      deadline?: unknown;
    };
    if (typeof record.text !== "string" || typeof record.passageId !== "string") {
      return [];
    }
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `action-${index}`,
      text: record.text,
      passageId: record.passageId,
      owner: typeof record.owner === "string" ? record.owner : null,
      deadline: typeof record.deadline === "string" ? record.deadline : null,
    }];
  });
}
