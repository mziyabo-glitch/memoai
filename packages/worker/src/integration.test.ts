import { createJob, type SectionInput } from "@memoai/shared";
import { describe, expect, it } from "vitest";
import { handleNotesRequest } from "./handler";
import {
  interpretNotesHttp,
  interpretTranscriptionHttp,
  requestNotes,
  transcribeAudio,
} from "./openai";
import { sha256Hex } from "./store";

const allowed = {
  OPENAI_API_KEY: "test-openai-key",
  MEMOAI_ALLOW_PROVIDER: "1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  MEMOAI_WORKER_SECRET: "worker-secret",
};

describe("openai adapter", () => {
  it("posts one section and reads timestamped segments from the response", async () => {
    let model = "";
    let format = "";
    let granularity = "";
    let idempotency = "";
    let authorization = "";
    const outcome = await transcribeAudio({
      env: allowed,
      apiKey: allowed.OPENAI_API_KEY,
      model: "gpt-transcribe",
      idempotencyKey: "section-key",
      filename: "section.m4a",
      bytes: new Uint8Array([1, 2, 3, 4]),
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        authorization = headers.Authorization;
        idempotency = headers["Idempotency-Key"];
        const form = init?.body as FormData;
        model = String(form.get("model"));
        format = String(form.get("response_format"));
        granularity = String(form.get("timestamp_granularities[]"));
        const file = form.get("file") as Blob;
        expect(file.size).toBe(4);
        return new Response(JSON.stringify({
          text: "Hello there",
          segments: [{ text: "Hello there", start: 1.5, end: 3 }],
        }), { status: 200 });
      },
    });
    expect(authorization).toBe("Bearer test-openai-key");
    expect(idempotency).toBe("section-key");
    expect(model).toBe("gpt-transcribe");
    expect(format).toBe("verbose_json");
    expect(granularity).toBe("segment");
    expect(outcome).toEqual({
      kind: "text",
      text: "Hello there",
      segments: [{ text: "Hello there", startMs: 1500, endMs: 3000 }],
    });
  });

  it("treats a timeout as uncertain and a refusal as rejected", async () => {
    expect(interpretTranscriptionHttp(504, "upstream")).toEqual({ kind: "uncertain" });
    expect(interpretTranscriptionHttp(400, "bad file").kind).toBe("rejected");
    expect(interpretNotesHttp(500, "", "job").kind).toBe("uncertain");
    const calls: string[] = [];
    const outcome = await transcribeAudio({
      env: allowed,
      apiKey: allowed.OPENAI_API_KEY,
      model: "gpt-transcribe",
      idempotencyKey: "section-key",
      filename: "section.m4a",
      bytes: new Uint8Array([1]),
      fetchImpl: async () => {
        calls.push("sent");
        throw new Error("timed out");
      },
    });
    expect(outcome.kind).toBe("uncertain");
    expect(calls).toEqual(["sent"]);
    const notes = await requestNotes({
      env: allowed,
      apiKey: allowed.OPENAI_API_KEY,
      model: "gpt-4.1-mini",
      idempotencyKey: "notes-key",
      transcript: "[section-0 0ms-1000ms] Mina will send the note.",
      jobId: "job-1",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        expect(body.messages[0].content).toContain("Do not invent");
        expect(body.messages[1].content).toContain("Mina will send the note.");
        expect(String(init?.body)).not.toContain("audio/transcriptions");
        const headers = init?.headers as Record<string, string>;
        expect(headers["Idempotency-Key"]).toBe("notes-key");
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                overview: [{ text: "Mina will send the note.", passageId: "section-0", quote: "Mina will send the note." }],
                keyPoints: [],
                decisions: [],
                actions: [],
              }),
            },
          }],
        }), { status: 200 });
      },
    });
    expect(notes.kind).toBe("notes");
  });
});

describe("notes worker over mocked HTTP", () => {
  it("offsets timestamps across sections and does not call a live host", async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);
    const world = worldFor([
      { bytes: first, durationMs: 45_000, text: "Mina will send the note.", start: 1.5, end: 2.5 },
      { bytes: second, durationMs: 30_000, text: "Rivers were the example.", start: 2, end: 3 },
    ]);
    const response = await handleNotesRequest(requestFor("job-1"), { env: allowed, fetchImpl: world.fetch, now: 1_000 });
    expect(response.status).toBe(200);
    const payload = await response.json() as { stopped: string; published: boolean };
    expect(payload.stopped).toBe("done");
    expect(payload.published).toBe(true);
    expect(world.openaiUrls).toEqual([
      "https://api.openai.com/v1/audio/transcriptions",
      "https://api.openai.com/v1/audio/transcriptions",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(world.notesPrompt).toContain("section-1-0 47000ms-48000ms");
    expect(world.notesPrompt).toContain("Do not invent");
    const segments = world.tables.transcript_segments as { start_ms: number; text: string; origin: string }[];
    expect(segments.map((segment) => ({ start_ms: segment.start_ms, text: segment.text, origin: segment.origin }))).toEqual([
      { start_ms: 1_500, text: "Mina will send the note.", origin: "worker" },
      { start_ms: 47_000, text: "Rivers were the example.", origin: "worker" },
    ]);
    expect(world.serviceRoleOnOpenAi).toBe(false);
  });

  it("stops after a failure midway and does not repeat the uncertain call", async () => {
    const world = worldFor([
      { bytes: new Uint8Array([1]), durationMs: 10_000, text: "First section stays.", start: 0.2, end: 0.8 },
      { bytes: new Uint8Array([2]), durationMs: 10_000, text: "Second section", start: 0.1, end: 0.4, fail: true },
      { bytes: new Uint8Array([3]), durationMs: 10_000, text: "Third section", start: 0.1, end: 0.4 },
    ]);
    const first = await handleNotesRequest(requestFor("job-1"), { env: allowed, fetchImpl: world.fetch, now: 1_000 });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { stopped: string; published: boolean };
    expect(firstBody.stopped).toBe("uncertain");
    expect(firstBody.published).toBe(false);
    expect(world.openaiUrls).toEqual([
      "https://api.openai.com/v1/audio/transcriptions",
      "https://api.openai.com/v1/audio/transcriptions",
    ]);
    const steps = world.tables.processing_steps as { sequence: number | null; status: string; result_text: string | null; request_sent_at: string | null }[];
    const section0 = steps.find((step) => step.sequence === 0);
    const section1 = steps.find((step) => step.sequence === 1);
    const section2 = steps.find((step) => step.sequence === 2);
    expect(section0?.result_text).toContain("First section stays.");
    expect(section1?.status).toBe("uncertain");
    expect(section2?.request_sent_at).toBeNull();
    expect(world.tables.transcript_segments).toEqual([]);
    const again = await handleNotesRequest(requestFor("job-1"), { env: allowed, fetchImpl: world.fetch, now: 1_000_000 });
    expect((await again.json() as { stopped: string }).stopped).toBe("uncertain");
    expect(world.openaiUrls).toHaveLength(2);
  });

  it("checks ownership, consent, and the 90-minute cap before any provider call", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      seen.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const disabled = await handleNotesRequest(requestFor("job-1"), {
      env: { MEMOAI_WORKER_SECRET: "worker-secret" },
      fetchImpl,
    });
    expect(disabled.status).toBe(409);
    expect(seen).toEqual([]);

    const otherOwner = worldFor([
      { bytes: new Uint8Array([1]), durationMs: 1_000, text: "Hello", start: 0, end: 1 },
    ]);
    const forbidden = await handleNotesRequest(requestFor("job-1", "someone-else"), {
      env: allowed,
      fetchImpl: otherOwner.fetch,
      now: 1_000,
    });
    expect(forbidden.status).toBe(403);
    expect(otherOwner.openaiUrls).toEqual([]);

    const missingConsent = worldFor([
      { bytes: new Uint8Array([1]), durationMs: 1_000, text: "Hello", start: 0, end: 1 },
    ], { consent: false });
    const noConsent = await handleNotesRequest(requestFor("job-1"), {
      env: allowed,
      fetchImpl: missingConsent.fetch,
      now: 1_000,
    });
    expect(noConsent.status).toBe(409);
    expect(missingConsent.openaiUrls).toEqual([]);

    const tooLong = worldFor([
      { bytes: new Uint8Array([1]), durationMs: 1_000, text: "Hello", start: 0, end: 1 },
    ]);
    tooLong.tables.processing_jobs[0].total_duration_ms = 5_400_001;
    (tooLong.tables.audio_sections[0] as { duration_ms: number }).duration_ms = 5_400_001;
    const capped = await handleNotesRequest(requestFor("job-1"), {
      env: allowed,
      fetchImpl: tooLong.fetch,
      now: 1_000,
    });
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ error: "too-long" });
    expect(tooLong.openaiUrls).toEqual([]);
  });

  it("does not publish a transcript that returns after deletion", async () => {
    const world = worldFor([
      { bytes: new Uint8Array([9, 9]), durationMs: 1_000, text: "late transcript", start: 0.1, end: 0.2 },
    ]);
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).includes("api.openai.com")) {
        world.tables.processing_jobs[0].deleted_at = "2026-10-24T00:01:00.000Z";
        world.tables.processing_jobs[0].publish_blocked = true;
      }
      return world.fetch(url, init);
    };
    const response = await handleNotesRequest(requestFor("job-1"), { env: allowed, fetchImpl, now: 1_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stopped: "deleted", published: false });
    expect(world.tables.transcript_segments).toEqual([]);
    expect(JSON.stringify(world.tables.processing_steps)).not.toContain("late transcript");
  });

  it("lets a signed-in owner reach a disabled provider and refuses the other account", async () => {
    const world = worldFor([
      { bytes: new Uint8Array([4]), durationMs: 1_000, text: "Hello there", start: 0, end: 1 },
    ]);
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      MEMOAI_WORKER_SECRET: "worker-secret",
    };
    const owner = await handleNotesRequest(requestFor("job-1", undefined, "user-a"), {
      env,
      fetchImpl: withAuth(world),
      now: 1_000,
    });
    expect(owner.status).toBe(409);
    expect(await owner.json()).toMatchObject({ error: "provider-disabled" });
    expect(world.openaiUrls).toEqual([]);
    const other = await handleNotesRequest(requestFor("job-1", undefined, "user-b"), {
      env,
      fetchImpl: withAuth(world),
      now: 1_000,
    });
    expect(other.status).toBe(403);
    expect(world.openaiUrls).toEqual([]);
  });

  it("does not start a provider call when the hosting budget is already spent", async () => {
    const world = worldFor([
      { bytes: new Uint8Array([4]), durationMs: 1_000, text: "Hello there", start: 0, end: 1 },
    ]);
    const response = await handleNotesRequest(requestFor("job-1"), {
      env: { ...allowed, MEMOAI_STEP_BUDGET_MS: "0" },
      fetchImpl: world.fetch,
      now: 1_000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stopped: "budget", stepsRun: 0 });
    expect(world.openaiUrls).toEqual([]);
  });
});

type Piece = {
  bytes: Uint8Array;
  durationMs: number;
  text: string;
  start: number;
  end: number;
  fail?: boolean;
};

function requestFor(jobId: string, ownerId?: string, token = "worker-secret"): Request {
  return new Request("https://memoai.local/api/notes/step", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId, ownerId }),
  });
}

function withAuth(world: ReturnType<typeof worldFor>): typeof fetch {
  return async (url, init) => {
    if (String(url).includes("/auth/v1/user")) {
      const headers = init?.headers as Record<string, string>;
      const token = headers.Authorization ?? "";
      if (token.endsWith("user-a")) {
        return Response.json({ id: "owner-a" });
      }
      if (token.endsWith("user-b")) {
        return Response.json({ id: "owner-b" });
      }
      return new Response("no", { status: 401 });
    }
    return world.fetch(url, init);
  };
}

function worldFor(pieces: Piece[], options: { consent?: boolean } = {}) {
  const sections: SectionInput[] = pieces.map((piece, sequence) => ({
    sequence,
    sha256: sha256Hex(piece.bytes),
    sizeBytes: piece.bytes.byteLength,
    durationMs: piece.durationMs,
    finished: true,
  }));
  const created = createJob({
    id: "job-1",
    ownerId: "owner-a",
    recordingId: "rec-local",
    consentAt: "2026-10-24T00:00:00.000Z",
    sections,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const job = created.job;
  const tables: Record<string, Record<string, unknown>[]> = {
    processing_jobs: [{
      id: job.id,
      user_id: job.ownerId,
      recording_id: "rec-cloud",
      consent_id: "consent-1",
      idempotency_key: job.idempotencyKey,
      transcribe_model: job.transcribeModel,
      notes_model: job.notesModel,
      total_duration_ms: sections.reduce((sum, section) => sum + section.durationMs, 0),
      status: "queued",
      deleted_at: null,
      publish_blocked: false,
      cancel_requested_at: null,
      failure_reason: null,
    }],
    processing_steps: job.steps.map((step, index) => ({
      id: `step-${index}`,
      user_id: job.ownerId,
      job_id: job.id,
      recording_id: "rec-cloud",
      sequence: step.sequence,
      operation: step.operation,
      sha256: step.sha256,
      idempotency_key: step.idempotencyKey,
      status: "queued",
      lease_owner: null,
      lease_until: null,
      request_sent_at: null,
      attempt_count: 0,
      result_text: null,
    })),
    processing_consents: options.consent === false ? [] : [{
      id: "consent-1",
      user_id: job.ownerId,
      recording_id: "rec-cloud",
      agreed_at: job.consentAt,
    }],
    audio_sections: sections.map((section) => ({
      user_id: job.ownerId,
      recording_id: "rec-cloud",
      sequence: section.sequence,
      sha256: section.sha256,
      size_bytes: section.sizeBytes,
      duration_ms: section.durationMs,
      storage_path: `${job.ownerId}/${job.recordingId}/${section.sequence}-${section.sha256}.m4a`,
      upload_status: "acknowledged",
    })),
    recordings: [{
      id: "rec-cloud",
      user_id: job.ownerId,
      meeting_id: "meeting-1",
      local_recording_id: job.recordingId,
      duration_ms: sections.reduce((sum, section) => sum + section.durationMs, 0),
    }],
    transcript_segments: [],
    summaries: [],
    action_items: [],
  };
  const audio = new Map(sections.map((section, index) => [
    `${job.ownerId}/${job.recordingId}/${section.sequence}-${section.sha256}.m4a`,
    pieces[index].bytes,
  ]));
  const openaiUrls: string[] = [];
  let notesPrompt = "";
  let serviceRoleOnOpenAi = false;
  const bySequence = new Map(pieces.map((piece, sequence) => [sequence, piece]));

  const fetchImpl: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === "api.openai.com") {
      openaiUrls.push(target.origin + target.pathname);
      const headers = init?.headers as Record<string, string>;
      if (headers.Authorization?.includes("service-role")) {
        serviceRoleOnOpenAi = true;
      }
      if (target.pathname.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        notesPrompt = body.messages.map((message) => message.content).join("\n");
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                overview: pieces.map((piece, sequence) => ({
                  text: piece.text,
                  passageId: `section-${sequence}-0`,
                  quote: piece.text,
                })),
                keyPoints: [],
                decisions: [],
                actions: [{
                  id: "task",
                  text: pieces[0].text,
                  passageId: "section-0-0",
                  owner: pieces[0].text.includes("Mina") ? "Mina" : null,
                  deadline: null,
                }],
              }),
            },
          }],
        }), { status: 200 });
      }
      const key = headers["Idempotency-Key"] ?? "";
      const sequence = Number(key.split(":transcribe:")[1]?.split(":")[0] ?? "0");
      const piece = bySequence.get(sequence);
      if (piece?.fail) {
        return new Response("timeout", { status: 504 });
      }
      return new Response(JSON.stringify({
        text: piece?.text ?? "",
        segments: [{ text: piece?.text ?? "", start: piece?.start ?? 0, end: piece?.end ?? 0 }],
      }), { status: 200 });
    }
    return supabaseResponse(tables, audio, target, init);
  };

  return { fetch: fetchImpl, tables, openaiUrls, get notesPrompt() { return notesPrompt; }, get serviceRoleOnOpenAi() { return serviceRoleOnOpenAi; } };
}

function supabaseResponse(
  tables: Record<string, Record<string, unknown>[]>,
  audio: Map<string, Uint8Array>,
  target: URL,
  init: RequestInit | undefined,
): Response {
  if (target.pathname.startsWith("/storage/v1/object/memoai-audio/")) {
    const path = decodeURIComponent(target.pathname.replace("/storage/v1/object/memoai-audio/", ""));
    const bytes = audio.get(path);
    if (!bytes) {
      return new Response("missing", { status: 404 });
    }
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Response(copy, { status: 200 });
  }
  const [, table] = target.pathname.split("/rest/v1/");
  const rows = tables[table];
  if (!rows) {
    return new Response("missing table", { status: 404 });
  }
  const method = init?.method ?? "GET";
  if (method === "GET") {
    const found = rows.filter((row) => matches(row, target.searchParams));
    return Response.json(found);
  }
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> | Record<string, unknown>[] : {};
  if (method === "PATCH") {
    for (const row of rows) {
      if (matches(row, target.searchParams)) {
        Object.assign(row, body);
      }
    }
    return new Response(null, { status: 204 });
  }
  if (method === "POST") {
    const incoming = Array.isArray(body) ? body : [body];
    const stored = incoming.map((row, index) => ({ id: `${table}-${rows.length + index}`, ...row }));
    rows.push(...stored);
    const prefer = headerValue(init?.headers, "prefer");
    if (prefer?.includes("return=representation")) {
      return Response.json(stored);
    }
    return new Response(null, { status: 201 });
  }
  return new Response("unsupported", { status: 405 });
}

function matches(row: Record<string, unknown>, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (key === "select" || key === "order") {
      continue;
    }
    if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) {
      return false;
    }
  }
  return true;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  const found = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}
