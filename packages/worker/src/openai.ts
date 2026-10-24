import { providerCallAllowed } from "./env";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const NOTES_URL = "https://api.openai.com/v1/chat/completions";

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
      messages: [
        {
          role: "system",
          content:
            "Write notes only from the transcript. Do not invent facts, speakers, decisions, or tasks. A decision or task must be an exact quote. Set owner and deadline only when that name or date is in the quote. Return JSON with overview, keyPoints, decisions, and actions.",
        },
        { role: "user", content: input.transcript },
      ],
    }),
  };
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
}): Promise<{ text: string }> {
  if (!providerCallAllowed(input.env)) {
    throw new Error("Live provider calls are disabled.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = transcriptionHeaders({
    apiKey: input.apiKey,
    idempotencyKey: input.idempotencyKey,
  });
  const body = new FormData();
  body.set("model", input.model);
  const copy = new ArrayBuffer(input.bytes.byteLength);
  new Uint8Array(copy).set(input.bytes);
  body.set("file", new Blob([copy], { type: "audio/mp4" }), input.filename);
  const response = await fetchImpl(headers.url, {
    method: "POST",
    headers: headers.headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { text?: string };
  return { text: payload.text ?? "" };
}
