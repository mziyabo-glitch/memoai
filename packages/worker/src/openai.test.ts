import { describe, expect, it } from "vitest";
import { providerCallAllowed, publicSecret, readServerEnv } from "./env";
import { notesRequestBody, transcribeAudio, transcriptionHeaders } from "./openai";

describe("provider guard", () => {
  it("stays off unless the server explicitly allows a live call", async () => {
    expect(providerCallAllowed({})).toBe(false);
    expect(providerCallAllowed({ OPENAI_API_KEY: "sk-test", MEMOAI_ALLOW_PROVIDER: "0" })).toBe(false);
    expect(publicSecret({ NEXT_PUBLIC_OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(readServerEnv({
      OPENAI_API_KEY: "sk-test",
      MEMOAI_ALLOW_PROVIDER: "1",
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "service",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      MEMOAI_WORKER_SECRET: "secret",
    })).toBeNull();
    let fetched = false;
    await expect(transcribeAudio({
      env: {},
      apiKey: "sk-test",
      model: "gpt-transcribe",
      idempotencyKey: "key",
      filename: "section.m4a",
      bytes: new Uint8Array([1]),
      fetchImpl: async () => {
        fetched = true;
        throw new Error("network");
      },
    })).rejects.toThrow(/disabled/);
    expect(fetched).toBe(false);
  });

  it("sends one section with an idempotency key and a grounded notes prompt", () => {
    const headers = transcriptionHeaders({ apiKey: "sk-test", idempotencyKey: "section-key" });
    expect(headers.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headers.headers["Idempotency-Key"]).toBe("section-key");
    expect(headers.headers.Authorization).toBe("Bearer sk-test");
    const notes = notesRequestBody({ model: "gpt-4.1-mini", transcript: "Mina will write the note." });
    expect(notes.url).not.toContain("audio");
    expect(notes.body).toContain("Do not invent");
    expect(notes.body).toContain("Mina will write the note.");
  });
});
