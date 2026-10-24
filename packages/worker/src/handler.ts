import { shouldPublish, type ProcessJob } from "@memoai/shared";
import { providerCallAllowed, publicSecret, readServerEnv, type ServerEnv } from "./env";
import { requestNotes, transcribeAudio } from "./openai";
import { runRecording } from "./run";
import { createRestStore, sha256Hex, type ProcessingStore } from "./store";

const SECTION_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_BUDGET_MS = 240_000;
const RESERVE_MS = 90_000;

/**
 * A signed-in phone calls this with its Supabase access token. A scheduler
 * calls it with the worker secret. The phone never receives that secret.
 * OpenAI is called only when the server env explicitly allows a paid run.
 */
export async function handleNotesRequest(
  request: Request,
  deps: {
    env: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: number;
    clock?: () => number;
  },
): Promise<Response> {
  const env = deps.env;
  const bearer = bearerToken(request);
  if (!bearer) {
    return json({ error: "unauthorized" }, 401);
  }
  const secret = env.MEMOAI_WORKER_SECRET;
  if (secret && bearer === secret) {
    if (!providerCallAllowed(env)) {
      return json(providerDisabled(), 409);
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
    return runOwnedJob(request, deps, server, undefined);
  }
  const supabase = readSupabaseServer(env);
  if (!supabase) {
    return json({ error: "unauthorized" }, 401);
  }
  const userId = await userIdFromAccessToken({
    supabaseUrl: supabase.supabaseUrl,
    apiKey: supabase.supabaseServiceRoleKey,
    accessToken: bearer,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (!userId) {
    return json({ error: "unauthorized" }, 401);
  }
  return runOwnedJob(request, deps, supabase, userId);
}

async function runOwnedJob(
  request: Request,
  deps: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; clock?: () => number },
  server: { supabaseUrl: string; supabaseServiceRoleKey: string },
  requiredOwnerId: string | undefined,
): Promise<Response> {
  let body: { jobId?: unknown; ownerId?: unknown };
  try {
    body = (await request.json()) as { jobId?: unknown; ownerId?: unknown };
  } catch {
    return json({ error: "bad-request", detail: "Send JSON with a jobId." }, 400);
  }
  if (typeof body.jobId !== "string" || body.jobId.length === 0) {
    return json({ error: "bad-request", detail: "jobId is required." }, 400);
  }
  if (typeof body.ownerId === "string" && requiredOwnerId && body.ownerId !== requiredOwnerId) {
    return json({ error: "not-owner", detail: "That job belongs to a different account." }, 403);
  }
  const store = createRestStore({
    supabaseUrl: server.supabaseUrl,
    serviceRoleKey: server.supabaseServiceRoleKey,
    fetchImpl: deps.fetchImpl,
  });
  let loaded: Awaited<ReturnType<ProcessingStore["load"]>>;
  try {
    loaded = await store.load(body.jobId, requiredOwnerId ?? (typeof body.ownerId === "string" ? body.ownerId : undefined));
  } catch {
    return json({ error: "store-failed", detail: "The processing job could not be read. OpenAI was not called." }, 502);
  }
  if (!loaded.ok) {
    const status = loaded.reason === "not-found" ? 404 : loaded.reason === "not-owner" ? 403 : loaded.reason === "deleted" ? 200 : 409;
    return json({ error: loaded.reason, detail: loaded.detail, stopped: loaded.reason }, status);
  }
  if (!providerCallAllowed(deps.env)) {
    return json(providerDisabled(), 409);
  }
  const paid = readServerEnv(deps.env);
  if (!paid) {
    return json(
      {
        error: "server-env-incomplete",
        detail: "The service-role key must stay in SUPABASE_SERVICE_ROLE_KEY, not a public env name.",
      },
      409,
    );
  }
  return transcribeLoadedJob(loaded.job, store, paid, deps);
}

async function transcribeLoadedJob(
  job: ProcessJob,
  store: ProcessingStore,
  server: ServerEnv,
  deps: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; clock?: () => number },
): Promise<Response> {
  const start = deps.now ?? Date.now();
  const budget = numberEnv(deps.env.MEMOAI_STEP_BUDGET_MS, DEFAULT_BUDGET_MS);
  const clock = deps.clock ?? (() => deps.now ?? Date.now());
  let result: Awaited<ReturnType<typeof runRecording>>;
  try {
    result = await runRecording({
      job,
      workerId: "memoai-web",
      now: start,
      leaseMs: SECTION_LEASE_MS,
      deadlineMs: start + budget,
      reserveMs: RESERVE_MS,
      clock,
      reload: () => store.reload(),
      save: (next) => store.save(next),
      readAudio: (sha256) => store.readAudio(sha256),
      sha256: sha256Hex,
      transcribe: (step) => transcribeAudio({
        env: deps.env,
        apiKey: server.openaiApiKey,
        model: server.transcribeModel,
        idempotencyKey: step.idempotencyKey,
        filename: "section.m4a",
        bytes: step.bytes,
        fetchImpl: deps.fetchImpl,
      }),
      writeNotes: (step) => requestNotes({
        env: deps.env,
        apiKey: server.openaiApiKey,
        model: server.notesModel,
        idempotencyKey: step.idempotencyKey,
        transcript: step.transcript,
        jobId: job.id,
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
      jobId: job.id,
    },
    200,
  );
}

export async function userIdFromAccessToken(input: {
  supabaseUrl: string;
  apiKey: string;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const response = await input.fetchImpl(`${input.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: input.apiKey,
      Authorization: `Bearer ${input.accessToken}`,
    },
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { id?: unknown };
  return typeof body.id === "string" && body.id.length > 0 ? body.id : null;
}

function readSupabaseServer(env: Record<string, string | undefined>): { supabaseUrl: string; supabaseServiceRoleKey: string } | null {
  if (publicSecret(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return { supabaseUrl: env.SUPABASE_URL, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : "";
}

function providerDisabled(): { error: string; detail: string } {
  return {
    error: "provider-disabled",
    detail:
      "Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MEMOAI_WORKER_SECRET on the server. Set MEMOAI_ALLOW_PROVIDER=1 only when a paid run is intended. This response did not call OpenAI.",
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
