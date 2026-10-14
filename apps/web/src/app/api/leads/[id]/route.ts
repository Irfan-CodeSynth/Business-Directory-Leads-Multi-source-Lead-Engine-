import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { leadStatus, leads } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: { status?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: { status?: (typeof leadStatus)[number]; notes?: string | null } = {};

  if (body.status !== undefined) {
    if (!(leadStatus as readonly string[]).includes(String(body.status))) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    patch.status = body.status as (typeof leadStatus)[number];
  }

  if (body.notes !== undefined) {
    patch.notes = body.notes === null ? null : String(body.notes);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const [updated] = await getDb().update(leads).set(patch).where(eq(leads.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, id: updated.id, status: updated.status, notes: updated.notes });
}
