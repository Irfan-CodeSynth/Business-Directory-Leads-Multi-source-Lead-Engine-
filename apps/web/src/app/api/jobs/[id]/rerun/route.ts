import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { jobs, jobSourceStats } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

const RESTART_FIELDS = {
  errorMsg: null,
  startedAt: null,
  finishedAt: null,
  // leads_found tracks the leads this job owns, so it persists; leads_skipped
  // describes the run you just asked for, so it resets.
  leadsSkipped: 0,
  leadsMerged: 0,
  // A stale flag would make the worker cancel this run on its first yield point.
  cancelRequested: false,
  phase: null,
  phaseTotal: null,
  phaseDone: null,
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let mode: "all" | "blocked" = "all";
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
    if (body.mode === "blocked") mode = "blocked";
  } catch {
    mode = "all";
  }

  const db = getDb();
  const [existing] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Which sources go back to `pending` is the whole difference between the two
  // buttons. A source that already finished is left alone, and the counters are not
  // touched here: the worker zeroes the counters of every source it starts, so a
  // number that survives describes the run that produced it. `found` is what this job
  // owns from a source and is never reset by either side.
  const requeueWhere =
    mode === "all"
      ? eq(jobSourceStats.jobId, id)
      : and(
          eq(jobSourceStats.jobId, id),
          inArray(jobSourceStats.status, ["blocked", "error", "cancelled"]),
        );
  const statSet = { status: "pending" as const, lastError: null, startedAt: null, finishedAt: null };

  if (mode === "blocked") {
    const blocked = await db
      .update(jobSourceStats)
      .set(statSet)
      .where(requeueWhere)
      .returning({ source: jobSourceStats.source });

    if (!blocked.length) {
      return NextResponse.json({ error: "No blocked sources on this job" }, { status: 409 });
    }
    await db.update(jobs).set({ ...RESTART_FIELDS, status: "pending" }).where(eq(jobs.id, id));
    return NextResponse.json({ ok: true, sources: blocked.map((b) => b.source) });
  }

  await db.update(jobSourceStats).set(statSet).where(requeueWhere);
  await db.update(jobs).set({ ...RESTART_FIELDS, status: "pending" }).where(eq(jobs.id, id));

  return NextResponse.json({ ok: true });
}
