import { NextResponse } from "next/server";
import { deleteJobsByIds } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** A page of runs is the most anyone can see at once; more per call is a runaway client. */
const MAX_IDS = 1000;

export async function POST(req: Request) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))] : [];
  if (!ids.length || ids.some((id) => !Number.isInteger(id))) {
    return NextResponse.json({ error: "No valid run ids given" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `At most ${MAX_IDS} runs per delete` }, { status: 400 });
  }

  const outcome = await deleteJobsByIds(getDb(), ids);
  if (outcome.rejected.length) {
    return NextResponse.json(
      {
        error: `Still queued or running (stop them first): runs ${outcome.rejected.join(", ")}`,
        rejected: outcome.rejected,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, deleted: outcome.deleted });
}
