import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { getLeadsForJob } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const jobId = Number(url.searchParams.get("jobId"));
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const leads = await getLeadsForJob(jobId);
  return NextResponse.json({ leads });
}
