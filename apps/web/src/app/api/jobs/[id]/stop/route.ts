import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { jobs } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const [job] = await getDb()
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Never claimed, so there is nothing for the worker to notice.
  if (job.status === "pending") {
    await getDb()
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(jobs.id, id));
    return NextResponse.json({ ok: true, mode: "cancelled" });
  }

  if (job.status !== "running") {
    return NextResponse.json({ error: `Job is ${job.status}, nothing to stop` }, { status: 409 });
  }

  // Cooperative: the worker polls this at each yield point and stops after the
  // lead it is already saving, so no scraped lead is ever thrown away.
  await getDb().update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id));
  return NextResponse.json({ ok: true, mode: "stopping" });
}
