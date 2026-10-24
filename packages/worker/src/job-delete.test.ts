import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const fix = readFileSync(
  new URL("../../../supabase/migrations/20261024152412_fix_summary_job_delete.sql", import.meta.url),
  "utf8",
);

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const summary = "44444444-4444-4444-8444-444444444444";

describe("summary job deletion", () => {
  it("keeps the owner on a linked summary when the job row is deleted", async () => {
    const db = new PGlite();
    await db.exec(`
      create table public.processing_jobs (
        id uuid primary key,
        user_id uuid not null,
        unique (id, user_id)
      );
      create table public.summaries (
        id uuid primary key,
        user_id uuid not null,
        body text not null,
        origin text not null,
        job_id uuid,
        constraint summaries_worker_link check (origin = 'worker' or job_id is null),
        constraint summaries_job_owner_fk
          foreign key (job_id, user_id)
          references public.processing_jobs (id, user_id)
          on delete set null
      );
    `);
    await db.query("insert into public.processing_jobs (id, user_id) values ($1, $2)", [job, owner]);
    await db.query(
      "insert into public.summaries (id, user_id, body, origin, job_id) values ($1, $2, $3, 'worker', $4)",
      [summary, owner, "Mina will send the note.", job],
    );
    await expect(
      db.query(
        "insert into public.summaries (id, user_id, body, origin, job_id) values ($1, $2, 'no', 'worker', $3)",
        ["55555555-5555-4555-8555-555555555555", other, job],
      ),
    ).rejects.toThrow(/summaries_job_owner_fk|foreign key/i);
    await expect(db.query("delete from public.processing_jobs where id = $1", [job])).rejects.toThrow(/null/i);

    await db.exec(fix);
    await db.query("delete from public.processing_jobs where id = $1", [job]);
    const kept = await db.query<{ user_id: string; job_id: string | null; body: string }>(
      "select user_id, job_id, body from public.summaries where id = $1",
      [summary],
    );
    expect(kept.rows).toEqual([{ user_id: owner, job_id: null, body: "Mina will send the note." }]);
    await db.close();
  });
});
