import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { jobSourceStats, jobs, paidSources, type Db, type PaidSource, type Source } from "@dleads/db";
import { makeSpend, type ResultSpend } from "./adapters/types.js";

/**
 * What the paid sources may cost in a calendar month.
 *
 * Apify bills per result, not per request, so the guardrail that matters is a count of
 * results, shared by `yelp` and `hotfrog` and by every job the worker starts before the
 * month turns over. The default is the free plan's roughly $5 of credit at the dearer of
 * the two Actors' rates; exceeding it is never automatic, so the source is marked
 * `blocked` and the dashboard says what to do about it.
 *
 * `job_source_stats.results_pulled` is what this counts. It is deliberately not zeroed by
 * a re-run, because a second attempt that pulls the same listings is billed again.
 */

export const DEFAULT_MONTHLY_RESULT_CAP = 1500;

export const CAP_REACHED = "monthly Apify cap reached — raise `APIFY_MONTHLY_RESULT_CAP` or wait for the 1st";

export function isPaid(source: Source): source is PaidSource {
  return (paidSources as readonly string[]).includes(source);
}

/** Midnight on the first of `now`'s month, in the machine's own time zone. */
export function monthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function monthlyResultCap(): number {
  const value = Number(process.env.APIFY_MONTHLY_RESULT_CAP);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MONTHLY_RESULT_CAP;
}

/** Results the paid sources returned for jobs created since the month began. */
export async function resultsPulledSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${jobSourceStats.resultsPulled}), 0)::int` })
    .from(jobSourceStats)
    .innerJoin(jobs, eq(jobs.id, jobSourceStats.jobId))
    .where(and(gte(jobs.createdAt, since), inArray(jobSourceStats.source, [...paidSources])));
  return row?.total ?? 0;
}

/** The month's remaining allowance, as the runner and the paid adapters will see it. */
export async function openSpend(db: Db, now = new Date()): Promise<ResultSpend> {
  return makeSpend(monthlyResultCap(), await resultsPulledSince(db, monthStart(now)));
}
