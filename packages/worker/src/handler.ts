import { shouldPublish } from "@memoai/shared";
import { providerCallAllowed, readServerEnv } from "./env";
import { requestNotes, transcribeAudio } from "./openai";
import { runRecording } from "./run";
import { createRestStore, sha256Hex } from "./store";

const SECTION_LEASE_MS = 10 * 60 * 1000;

/**
 * One request walks the recording section by section. Each OpenAI audio call is
 * one finished section. The route calls OpenAI only when the server env allows it.
 */
export async function handleNotesRequest(
  request: Request,
  deps: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number },
): Promise<Response> {
  const env = deps.env;
  const secret = env.MEMOAI_WORKER_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!providerCallAllowed(env)) {
    return json(
      {
        error: "provider-disabled",
        detail:
          "Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MEMOAI_WORKER_SECRET on the server. Set MEMOAI_ALLOW_PROVIDER=1 only when a paid run is intended. This response did not call OpenAI.",
      },
      409,
    );
  }
  const server = readServerEnv(env);
  if (!server) {
    return json(
      {
        error: "server-env-incomplete",
        detail: "The service-role key must stay in SUPABASE_SERVICE_ROLE_KEY, not a public env name.",
      },
      409,
    );
  }
  let body: { jobId?: unknown; ownerId?: unknown };
  try {
    body = (await request.json()) as { jobId?: unknown; ownerId?: unknown };
  } catch {
    return json({ error: "bad-request", detail: "Send JSON with a jobId." }, 400);
  }
  if (typeof body.jobId !== "string" || body.jobId.length === 0) {
    return json({ error: "bad-request", detail: "jobId is required." }, 400);
  }
  const store = createRestStore({
    supabaseUrl: server.supabaseUrl,
    serviceRoleKey: server.supabaseServiceRoleKey,
    fetchImpl: deps.fetchImpl,
  });
  let loaded: Awaited<ReturnType<typeof store.load>>;
  try {
    loaded = await store.load(body.jobId, typeof body.ownerId === "string" ? body.ownerId : undefined);
  } catch {
    return json({ error: "store-failed", detail: "The processing job could not be read. OpenAI was not called." }, 502);
  }
  if (!loaded.ok) {
    const status = loaded.reason === "not-found" ? 404 : loaded.reason === "not-owner" ? 403 : loaded.reason === "deleted" ? 200 : 409;
    return json({ error: loaded.reason, detail: loaded.detail, stopped: loaded.reason }, status);
  }
  const ready = loaded;
  let result: Awaited<ReturnType<typeof runRecording>>;
  try {
    result = await runRecording({
      job: ready.job,
      workerId: "memoai-web",
      now: deps.now ?? Date.now(),
      leaseMs: SECTION_LEASE_MS,
      reload: () => store.reload(),
      save: (job) => store.save(job),
      readAudio: (sha256) => store.readAudio(sha256),
      sha256: sha256Hex,
      transcribe: (step) => transcribeAudio({
        env,
        apiKey: server.openaiApiKey,
        model: server.transcribeModel,
        idempotencyKey: step.idempotencyKey,
        filename: "section.m4a",
        bytes: step.bytes,
        fetchImpl: deps.fetchImpl,
      }),
      writeNotes: (step) => requestNotes({
        env,
        apiKey: server.openaiApiKey,
        model: server.notesModel,
        idempotencyKey: step.idempotencyKey,
        transcript: step.transcript,
        jobId: ready.job.id,
        fetchImpl: deps.fetchImpl,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = message && !/bearer |service.role|api[_-]?key|sk-/i.test(message)
      ? message
      : "Processing stopped before a result was published.";
    return json({ error: "store-failed", detail: safe }, 502);
  }
  return json(
    {
      stopped: result.stopped,
      stepsRun: result.stepsRun,
      published: shouldPublish(result.job),
      failureReason: result.job.failureReason,
    },
    200,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
