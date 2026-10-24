import { handleNotesRequest } from "@memoai/worker";

export const runtime = "nodejs";
/** Hosts that honor this can keep the section loop running. A kill mid-call is not retried when the outcome is uncertain. */
export const maxDuration = 300;

/**
 * Walks one recording, one finished audio section per OpenAI request, then
 * writes notes from the transcript. OpenAI is not called unless the server
 * env explicitly allows a paid run.
 */
export async function POST(request: Request) {
  return handleNotesRequest(request, { env: process.env });
}
