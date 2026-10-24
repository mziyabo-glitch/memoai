import { providerCallAllowed, readServerEnv } from "@memoai/worker";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * One invocation is one finished audio section, or the later notes step.
 * A 90-minute recording is not sent in one request. This route does not call
 * OpenAI unless the server env explicitly allows it, and CI does not set that.
 */
export async function POST(request: Request) {
  const secret = process.env.MEMOAI_WORKER_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!providerCallAllowed(process.env)) {
    return NextResponse.json(
      {
        error: "provider-disabled",
        detail:
          "Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MEMOAI_WORKER_SECRET on the server. Set MEMOAI_ALLOW_PROVIDER=1 only when a paid run is intended. This response did not call OpenAI.",
      },
      { status: 409 },
    );
  }
  if (!readServerEnv(process.env)) {
    return NextResponse.json(
      {
        error: "server-env-incomplete",
        detail: "The service-role key must stay in SUPABASE_SERVICE_ROLE_KEY, not a public env name.",
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    {
      error: "worker-not-started",
      detail:
        "The one-section step runner is implemented and covered by unit tests. This deployment does not start a paid provider call.",
    },
    { status: 501 },
  );
}
