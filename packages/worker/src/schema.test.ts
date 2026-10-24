import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20261024150753_notes_processing_foundation.sql", import.meta.url),
  "utf8",
);
const fix = readFileSync(
  new URL("../../../supabase/migrations/20261024152412_fix_summary_job_delete.sql", import.meta.url),
  "utf8",
);

describe("processing migration", () => {
  it("keeps audio private to the owner and does not embed a key", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("memoai-audio");
    expect(sql).toContain("public = false");
    expect(sql).toContain("auth.uid()");
    expect(sql).not.toContain("user_metadata");
    expect(sql).not.toMatch(/service_role_key|sk-|eyJ/);
    expect(sql).toContain("publish_blocked");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("request_sent_at");
    expect(sql).toContain("origin = 'user'");
    expect(sql).toContain("20971520");
    expect(fix).toMatch(/on delete set null \(job_id\)/i);
    expect(fix).not.toMatch(/user_id\)\s+on delete set null\s*;/i);
  });

  it("does not put the worker secret in the phone app", () => {
    const account = readFileSync(new URL("../../../apps/mobile/src/account.ts", import.meta.url), "utf8");
    const upload = readFileSync(new URL("../../../apps/mobile/src/uploadAudio.ts", import.meta.url), "utf8");
    expect(`${account}\n${upload}`).not.toMatch(/MEMOAI_WORKER_SECRET|SERVICE_ROLE|OPENAI_API_KEY/);
  });
});
