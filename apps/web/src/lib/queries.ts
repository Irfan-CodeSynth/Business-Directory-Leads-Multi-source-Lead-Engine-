import "server-only";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  jobs,
  jobSourceStats,
  knownBusinesses,
  leadContacts,
  leads,
  leadSources,
  paidSources,
  workerStatus,
} from "@dleads/db";
import { getDb } from "./db";
import { isApifyConfigured, monthStart, monthlyResultCap } from "./spend";
import type { ApifyBudget, DashboardStats, JobSummary, LeadRow, SourceStat, WorkerStatus } from "./types";

/** A worker polls every few seconds; two minutes of silence means it is not running. */
const HEARTBEAT_STALE_MS = Number(process.env.WORKER_HEARTBEAT_STALE_MS ?? 120000);

type JobRow = typeof jobs.$inferSelect;
type StatRow = typeof jobSourceStats.$inferSelect;

function toSourceStat(row: StatRow): SourceStat {
  return {
    source: row.source,
    status: row.status,
    found: row.found,
    skipped: row.skipped,
    merged: row.merged,
    enriched: row.enriched,
    requestsUsed: row.requestsUsed,
    resultsPulled: row.resultsPulled,
    lastError: row.lastError,
  };
}

function toJobSummary(job: JobRow, stats: StatRow[]): JobSummary {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    phaseTotal: job.phaseTotal,
    phaseDone: job.phaseDone,
    cancelRequested: job.cancelRequested,
    keywords: job.keywords,
    locations: job.locations,
    sources: job.sources,
    maxItems: job.maxItems,
    leadTarget: job.leadTarget,
    importLabel: job.importLabel,
    importRows: job.importRows?.length ?? 0,
    leadsFound: job.leadsFound,
    leadsSkipped: job.leadsSkipped,
    leadsMerged: job.leadsMerged,
    errorMsg: job.errorMsg,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    sourceStats: stats.map(toSourceStat),
  };
}

async function statsForJobIds(db: ReturnType<typeof getDb>, jobIds: number[]): Promise<Map<number, StatRow[]>> {
  const map = new Map<number, StatRow[]>();
  if (!jobIds.length) return map;
  const rows = await db
    .select()
    .from(jobSourceStats)
    .where(inArray(jobSourceStats.jobId, jobIds))
    .orderBy(asc(jobSourceStats.source));
  for (const row of rows) {
    const bucket = map.get(row.jobId) ?? [];
    bucket.push(row);
    map.set(row.jobId, bucket);
  }
  return map;
}

export async function getJobSummaries(jobIds: number[]): Promise<JobSummary[]> {
  if (!jobIds.length) return [];
  const db = getDb();
  const [jobRows, stats] = await Promise.all([
    db.select().from(jobs).where(inArray(jobs.id, jobIds)),
    statsForJobIds(db, jobIds),
  ]);
  const byId = new Map(jobRows.map((j) => [j.id, j]));
  return jobIds
    .map((id) => byId.get(id))
    .filter((j): j is JobRow => Boolean(j))
    .map((j) => toJobSummary(j, stats.get(j.id) ?? []));
}

export async function getJobDetail(jobId: number): Promise<JobSummary | null> {
  const [detail] = await getJobSummaries([jobId]);
  return detail ?? null;
}

/** Every (job, source) pair is listed here, so an interrupted run resumes one query. */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const db = getDb();
  const [row] = await db
    .select({
      lastSeenAt: workerStatus.lastSeenAt,
      currentJobId: workerStatus.currentJobId,
      version: workerStatus.version,
    })
    .from(workerStatus)
    .where(eq(workerStatus.id, 1))
    .limit(1);

  if (!row) return { lastSeenAt: null, currentJobId: null, version: null, online: false };
  const seen = row.lastSeenAt.getTime();
  return {
    lastSeenAt: row.lastSeenAt.toISOString(),
    currentJobId: row.currentJobId,
    version: row.version,
    online: Date.now() - seen < HEARTBEAT_STALE_MS,
  };
}

/**
 * Results the paid sources have pulled since the 1st — the same sum the worker makes
 * before it spends money, read here so a form can say what room is left. A blocked
 * attempt counts: the listings came back, so Apify charged for them.
 */
async function resultsPulledThisMonth(db: ReturnType<typeof getDb>): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${jobSourceStats.resultsPulled}), 0)::int` })
    .from(jobSourceStats)
    .innerJoin(jobs, eq(jobs.id, jobSourceStats.jobId))
    .where(and(gte(jobs.createdAt, monthStart()), inArray(jobSourceStats.source, [...paidSources])));
  return row?.total ?? 0;
}

/** What the paid sources may still buy this month, for the forms that quote a price. */
export async function getApifyBudget(): Promise<ApifyBudget> {
  const monthlyCap = monthlyResultCap();
  const db = getDb();
  const used = await resultsPulledThisMonth(db);
  return {
    configured: isApifyConfigured(),
    monthlyCap,
    monthRemaining: Math.max(0, monthlyCap - used),
  };
}

async function attachSources(db: ReturnType<typeof getDb>, rows: LeadRow[]): Promise<LeadRow[]> {
  if (!rows.length) return rows;
  const links = await db
    .select({ leadId: leadSources.leadId, source: leadSources.source })
    .from(leadSources)
    .where(inArray(leadSources.leadId, rows.map((r) => r.id)));
  const byLead = new Map<number, string[]>();
  for (const link of links) {
    const bucket = byLead.get(link.leadId) ?? [];
    if (!bucket.includes(link.source)) bucket.push(link.source);
    byLead.set(link.leadId, bucket);
  }
  for (const row of rows) {
    row.sources = byLead.get(row.id) ?? [row.source];
  }
  return rows;
}

export async function getLeadsForJob(jobId: number, onlyIds?: number[]): Promise<LeadRow[]> {
  const db = getDb();
  const base = eq(leads.jobId, jobId);
  const where = onlyIds && onlyIds.length ? and(base, inArray(leads.id, onlyIds)) : base;

  const rows = await db
    .select({
      id: leads.id,
      jobId: leads.jobId,
      name: leads.name,
      source: leads.source,
      /** Which dedup tier produced this business's key: how trustworthy the merge was. */
      dedupKind: leads.dedupKind,
      profileUrl: leads.profileUrl,
      phone: leads.phone,
      address: leads.address,
      city: leads.city,
      region: leads.region,
      postalCode: leads.postalCode,
      website: leads.website,
      category: leads.category,
      rating: leads.rating,
      reviewCount: leads.reviewCount,
      status: leads.status,
      notes: leads.notes,
      enriched: leads.enriched,
      createdAt: leads.createdAt,
      emails: leadContacts.emails,
      emailSource: leadContacts.emailSource,
      instagram: leadContacts.instagram,
      facebook: leadContacts.facebook,
      linkedin: leadContacts.linkedin,
      twitter: leadContacts.twitter,
      youtube: leadContacts.youtube,
      tiktok: leadContacts.tiktok,
    })
    .from(leads)
    .leftJoin(leadContacts, eq(leadContacts.leadId, leads.id))
    .where(where)
    .orderBy(asc(leads.name));

  const shaped = rows.map((r) => ({ ...r, sources: [r.source], createdAt: r.createdAt.toISOString() }));
  return attachSources(db, shaped);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const db = getDb();

  const [
    leadsCountRow,
    knownCountRow,
    jobsCountRow,
    activeJobsRow,
    blockedRow,
    enrichedCountRow,
    emailsCountRow,
    overlapRows,
    sourceRows,
    statusRows,
    categoryRows,
    recentJobRows,
    recentLeadRows,
    worker,
  ] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(leads),
    db.select({ n: sql<number>`count(*)::int` }).from(knownBusinesses),
    db.select({ n: sql<number>`count(*)::int` }).from(jobs),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.status, ["pending", "running"])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobSourceStats)
      .where(inArray(jobSourceStats.status, ["blocked", "error"])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(eq(leads.enriched, true)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leadContacts)
      .where(sql`cardinality(emails) > 0`),
    // A business linked to more than one source is one row here per overlapping lead.
    db
      .select({ leadId: leadSources.leadId })
      .from(leadSources)
      .groupBy(leadSources.leadId)
      .having(sql`count(distinct ${leadSources.source}) > 1`),
    db
      .select({ source: leads.source, n: sql<number>`count(*)::int` })
      .from(leads)
      .groupBy(leads.source),
    db
      .select({ status: leads.status, n: sql<number>`count(*)::int` })
      .from(leads)
      .groupBy(leads.status),
    db
      .select({ category: leads.category, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(sql`${leads.category} IS NOT NULL AND ${leads.category} != ''`)
      .groupBy(leads.category)
      .orderBy(desc(sql`count(*)::int`))
      .limit(6),
    db.select().from(jobs).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(5),
    db
      .select({
        id: leads.id,
        jobId: leads.jobId,
        name: leads.name,
        source: leads.source,
        category: leads.category,
        website: leads.website,
        phone: leads.phone,
        status: leads.status,
        createdAt: leads.createdAt,
        emails: leadContacts.emails,
      })
      .from(leads)
      .leftJoin(leadContacts, eq(leadContacts.leadId, leads.id))
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(6),
    getWorkerStatus(),
  ]);

  const totalLeads = leadsCountRow[0]?.n ?? 0;
  const enrichedCount = enrichedCountRow[0]?.n ?? 0;

  const statusBreakdown: Record<string, number> = { new: 0, contacted: 0, replied: 0, won: 0, lost: 0 };
  for (const row of statusRows) {
    if (row.status) statusBreakdown[row.status] = row.n;
  }

  const sourceBreakdown: Record<string, number> = {};
  for (const row of sourceRows) sourceBreakdown[row.source] = row.n;

  const jobStats = await statsForJobIds(db, recentJobRows.map((j) => j.id));

  return {
    totalLeads,
    totalKnownBusinesses: knownCountRow[0]?.n ?? 0,
    totalJobs: jobsCountRow[0]?.n ?? 0,
    activeJobs: activeJobsRow[0]?.n ?? 0,
    blockedSources: blockedRow[0]?.n ?? 0,
    enrichedCount,
    emailsCount: emailsCountRow[0]?.n ?? 0,
    overlapCount: overlapRows.length,
    enrichmentRate: totalLeads > 0 ? Math.round((enrichedCount / totalLeads) * 100) : 0,
    sourceBreakdown,
    statusBreakdown,
    topCategories: categoryRows
      .filter((r) => Boolean(r.category))
      .map((r) => ({ category: r.category as string, count: r.n })),
    recentJobs: recentJobRows.map((j) => toJobSummary(j, jobStats.get(j.id) ?? [])),
    recentLeads: recentLeadRows.map((l) => ({
      id: l.id,
      jobId: l.jobId,
      name: l.name,
      source: l.source,
      category: l.category,
      website: l.website,
      phone: l.phone,
      status: l.status,
      createdAt: l.createdAt.toISOString(),
      emails: l.emails,
    })),
    worker,
  };
}
