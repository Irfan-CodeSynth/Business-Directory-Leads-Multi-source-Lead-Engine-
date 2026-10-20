import { NextResponse } from "next/server";
import { jobs } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { parseJobSubmission } from "@/lib/jobSubmission";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const parsed = parseJobSubmission(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const [created] = await getDb()
    .insert(jobs)
    .values({
      ...parsed.value,
      status: "pending",
      createdBy: uid,
    })
    .returning({ id: jobs.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
