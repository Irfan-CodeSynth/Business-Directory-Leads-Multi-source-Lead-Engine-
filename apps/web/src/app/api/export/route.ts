import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { exportCsv } from "@/lib/exportCsv";
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

  const idsParam = url.searchParams.get("ids");
  const onlyIds = idsParam
    ? idsParam
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n))
    : undefined;

  const rows = await getLeadsForJob(jobId, onlyIds);

  return new Response(exportCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${jobId}.csv"`,
      "cache-control": "no-store",
    },
  });
}
