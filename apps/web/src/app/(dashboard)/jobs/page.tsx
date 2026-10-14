import { desc, sql } from "drizzle-orm";
import { jobs } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { redirect } from "next/navigation";
import JobsList from "@/components/JobsList";
import { getJobSummaries } from "@/lib/queries";
import { PAGE_SIZE, normalizePage, totalPages } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: { page?: string | string[] };
}) {
  const uid = currentUserId();
  if (!uid) redirect("/login");

  const db = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs);
  const pageCount = totalPages(n);
  const raw = Array.isArray(searchParams.page) ? searchParams.page[0] : searchParams.page;
  const page = normalizePage(Number(raw), pageCount);

  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const initialJobs = await getJobSummaries(rows.map((r) => r.id));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Jobs</h1>
        <p className="mt-1 text-sm text-muted">
          Status refreshes automatically every 5 seconds. Each source is tracked separately, so a
          rate-limited one never fails the run.
        </p>
      </div>
      <JobsList initialJobs={initialJobs} page={page} pageCount={pageCount} total={n} />
    </div>
  );
}
