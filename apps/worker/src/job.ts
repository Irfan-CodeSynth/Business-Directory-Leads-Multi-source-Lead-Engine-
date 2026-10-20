import { and, eq, ne, sql } from "drizzle-orm";
import {
  isSearchSpec,
  jobSourceStats,
  jobs,
  locationLine,
  sourceStatus,
  type Db,
  type Job,
  type SearchSpec,
  type Source,
} from "@dleads/db";
import { createOsmAdapter, osmConfig } from "./adapters/osm.js";
import { createCsvAdapter, type CsvRow } from "./adapters/csv.js";
import { apifyConfig, createApifyAdapter } from "./adapters/apify.js";
import { CAP_REACHED, isPaid, openSpend } from "./spend.js";
import {
  isBlockedError,
  makeBudget,
  makeSpend,
  type RawLead,
  type ResultSpend,
  type SearchHooks,
  type SourceAdapter,
} from "./adapters/types.js";
import { ingestLead } from "./ingest.js";
import { enrichLeads } from "./enrichment.js";
import type { EnrichConfig, PageFetcher } from "./enrich.js";

/**
 * Atomically claims the oldest pending job. `FOR UPDATE SKIP LOCKED` keeps two
 * worker processes (or a stray second laptop) from collecting the same job twice.
 *
 * This is a typed `update().returning()` rather than `execute(sql`UPDATE … RETURNING *`)`
 * on purpose: raw SQL hands back the database's snake_case names, so `job.maxItems`
 * and `job.importRows` would silently be `undefined` — a job that "succeeds" with
 * zero leads. Only the `WHERE` subquery is raw.
 */
export async function claimJob(db: Db): Promise<Job | null> {
  const [job] = await db
    .update(jobs)
    .set({
      status: "running",
      startedAt: sql`coalesce(started_at, now())`,
    })
    .where(sql`id = (
      SELECT id FROM jobs WHERE status = 'pending'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )`)
    .returning();
  return job ?? null;
}

/** A worker killed mid-job leaves a `running` row nobody owns; put it back in line. */
export async function requeueRunningJobs(db: Db): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "pending" })
    .where(eq(jobs.status, "running"))
    .returning({ id: jobs.id });
  return rows.length;
}

/**
 * Crash debris: a source row can be left `running` on a job that no longer is — the
 * worker died mid-write, or a stop closed the job around a source that never saw it.
 * Boot is the one moment no run belongs to this worker, so it is where the lie is
 * corrected; a job that is itself `running` is another worker's and is left alone.
 */
export async function closeOrphanedSourceStats(db: Db): Promise<number> {
  const rows = await db
    .update(jobSourceStats)
    .set({ status: "cancelled", lastError: "left running by an interrupted worker", finishedAt: new Date() })
    .where(
      and(
        eq(jobSourceStats.status, "running"),
        sql`job_id IN (SELECT id FROM jobs WHERE status <> 'running')`,
      ),
    )
    .returning({ jobId: jobSourceStats.jobId });
  return rows.length;
}

/** Thrown by the cooperative Stop check and turned into a `cancelled` job. */
export class JobCancelled extends Error {}

/** One indexed single-row read, so a Stop click lands within a lead or two. */
export async function isCancelRequested(db: Db, jobId: number): Promise<boolean> {
  const [row] = await db
    .select({ v: jobs.cancelRequested })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return Boolean(row?.v);
}

/** Keyed by `ingestLead`'s outcomes; `created` is what the columns call `found`. */
interface Tally {
  created: number;
  skipped: number;
  merged: number;
}

const zero = (): Tally => ({ created: 0, skipped: 0, merged: 0 });
type StatStatus = (typeof sourceStatus)[number];

async function declareSourceStat(
  db: Db,
  jobId: number,
  source: Source,
  set: Partial<
    Pick<
      typeof jobSourceStats.$inferInsert,
      "status" | "startedAt" | "finishedAt" | "lastError" | "skipped" | "merged" | "enriched" | "requestsUsed"
    >
  >,
): Promise<void> {
  await db
    .insert(jobSourceStats)
    .values({ jobId, source, ...set })
    .onConflictDoUpdate({ target: [jobSourceStats.jobId, jobSourceStats.source], set });
}

/** Adds one flush to the job's and the source's counters. Counters only ever grow. */
async function addCounters(
  db: Db,
  jobId: number,
  source: Source,
  delta: Tally,
  requests: number,
  results: number,
): Promise<void> {
  if (delta.created + delta.skipped + delta.merged + requests + results === 0) return;
  await db
    .update(jobs)
    .set({
      leadsFound: sql`${jobs.leadsFound} + ${delta.created}`,
      leadsSkipped: sql`${jobs.leadsSkipped} + ${delta.skipped}`,
      leadsMerged: sql`${jobs.leadsMerged} + ${delta.merged}`,
    })
    .where(eq(jobs.id, jobId));
  await db
    .update(jobSourceStats)
    .set({
      found: sql`${jobSourceStats.found} + ${delta.created}`,
      skipped: sql`${jobSourceStats.skipped} + ${delta.skipped}`,
      merged: sql`${jobSourceStats.merged} + ${delta.merged}`,
      requestsUsed: sql`${jobSourceStats.requestsUsed} + ${requests}`,
      // Cumulative by design: this column is what a paid source cost, and a re-run
      // that pulls the same listings again costs again.
      resultsPulled: sql`${jobSourceStats.resultsPulled} + ${results}`,
    })
    .where(and(eq(jobSourceStats.jobId, jobId), eq(jobSourceStats.source, source)));
}

/** What the write path talks to for each source; tests inject a scripted adapter. */
export type AdapterFactory = (source: Source, job: Job, spend: ResultSpend) => SourceAdapter;

function adapterFor(source: Source, job: Job, spend: ResultSpend): SourceAdapter {
  if (source === "csv") return createCsvAdapter((job.importRows ?? []) as CsvRow[], job.id);
  if (isPaid(source)) return createApifyAdapter({ source, config: apifyConfig(), spend });
  return createOsmAdapter({ config: osmConfig() });
}

/** A file import is one pass over the list; a directory source is one search. */
export function workUnits(
  source: Source,
  job: Job,
): { keyword: string; location: string; maxItems: number; spec?: SearchSpec }[] {
  if (source === "csv") {
    return [{ keyword: job.importLabel ?? "import", location: "", maxItems: Number.MAX_SAFE_INTEGER }];
  }
  // The structured spec is one focused question — one keyword in one city — and it
  // says where the country and category go, which is what a free-text location
  // cannot. A job row without one is the old matrix, and runs exactly as before.
  if (isSearchSpec(job.searchSpec)) {
    return [{ keyword: job.searchSpec.keyword, location: locationLine(job.searchSpec, "full"), maxItems: job.maxItems, spec: job.searchSpec }];
  }
  return job.locations.flatMap((location) =>
    job.keywords.map((keyword) => ({ keyword, location, maxItems: job.maxItems })),
  );
}

/**
 * Runs one source over its whole work list. Counters are flushed per work unit (and
 * every 10 leads), so a blocked or cancelled run keeps everything it paid for.
 */
async function runSource(
  db: Db,
  job: Job,
  source: Source,
  onUnitDone: () => Promise<void>,
  log: (message: string) => void,
  adapter: SourceAdapter,
  spend: ResultSpend,
): Promise<Tally> {
  const budget = makeBudget(
    source === "csv" ? Number.POSITIVE_INFINITY : Number(process.env.JOB_MAX_REQUESTS ?? 400),
  );
  const total = zero();
  let pending = zero();
  let requestsFlushed = 0;
  // The meter is the job's, shared with the paid sources that already ran, so this
  // source's bill is what it added on top of the reading it started with.
  let resultsFlushed = spend.spent();

  const flush = async () => {
    const delta = pending;
    pending = zero();
    const requests = budget.spent() - requestsFlushed;
    requestsFlushed = budget.spent();
    const results = spend.spent() - resultsFlushed;
    resultsFlushed = spend.spent();
    for (const key of ["created", "skipped", "merged"] as const) total[key] += delta[key];
    await addCounters(db, job.id, source, delta, requests, results);
  };

  // A file import is exempt: its rows are already in hand and already paid for, and
  // dropping part of the list the owner pasted would lose their data silently.
  const target = source === "csv" ? Number.POSITIVE_INFINITY : job.leadTarget;
  const stillNeeded = () => Math.max(0, target - (total.created + pending.created));

  const hooks: SearchHooks = {
    emit: async (raw: RawLead) => {
      pending[await ingestLead(db, { jobId: job.id, source, raw })]++;
      if (pending.created + pending.skipped + pending.merged >= 10) await flush();
      if (await isCancelRequested(db, job.id)) throw new JobCancelled();
    },
    budget,
    log,
    // The awaited poll in `emit` is authoritative for a stop request; this is the same
    // seam reading the other thing that ends a search: enough new leads to satisfy the
    // job's target.
    shouldStop: () => stillNeeded() <= 0,
  };

  let reachedTarget = false;
  try {
    for (const unit of workUnits(source, job)) {
      const needed = stillNeeded();
      if (needed <= 0) {
        reachedTarget = true;
        break;
      }
      // A source is asked for at most what the target still needs. Rows past it would
      // be ingested and thrown away, and on a paid Actor thrown-away rows are billed.
      const outcome = await adapter.search({ ...unit, maxItems: Math.min(unit.maxItems, needed) }, hooks);
      await flush();
      await onUnitDone();
      if (outcome.stopped) {
        reachedTarget = true;
        break;
      }
    }
  } finally {
    await flush().catch(() => {});
  }
  if (reachedTarget) log(`${source}: reached its target of ${job.leadTarget} new leads`);
  return total;
}

/**
 * Collects every source for one job and records its own outcome — the caller never
 * has to clean up a failed job. `deps` is the test seam: a scripted adapter lets the
 * write path be proven without a socket.
 */
export interface JobDeps {
  adapter?: AdapterFactory;
  log?: (message: string) => void;
  fetchPage?: PageFetcher;
  enrich?: Partial<EnrichConfig>;
  /**
   * Touched at every yield point. A run spends most of its time waiting on other
   * people's servers, and the dashboard's "worker online" banner would otherwise go
   * stale — and claim no worker is running — exactly while one is busy.
   */
  heartbeat?: () => Promise<void>;
}

export async function processJob(db: Db, job: Job, deps: JobDeps = {}): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(`[job ${job.id}] ${message}`));
  const makeAdapter: AdapterFactory = deps.adapter ?? adapterFor;

  // A re-run of blocked sources re-queues only the sources that did not finish, so the
  // ones already `done` are not asked again: their listings are known, and re-querying
  // them spends the courtesy budget of a service that already throttled us.
  const statRows = await db
    .select({ source: jobSourceStats.source, status: jobSourceStats.status })
    .from(jobSourceStats)
    .where(eq(jobSourceStats.jobId, job.id));
  const finished = new Set(statRows.filter((s) => s.status === "done").map((s) => s.source));
  const toRun = job.sources.filter((source) => !finished.has(source));
  for (const source of job.sources.filter((s) => finished.has(s))) {
    log(`${source}: already finished, left as it is`);
  }

  // Only a job that asks for a paid source reads the month's bill. A free one must not
  // pay for the query, and a paid job starts from what the paid sources already cost.
  const spend = toRun.some(isPaid) ? await openSpend(db) : makeSpend(Number.POSITIVE_INFINITY, 0);

  const units = toRun.reduce((sum, source) => sum + workUnits(source, job).length, 0);
  const beat = deps.heartbeat ?? (async () => {});
  let done = 0;
  const onUnitDone = async () => {
    done++;
    await db.update(jobs).set({ phaseDone: done }).where(eq(jobs.id, job.id));
    await beat();
  };

  await db
    .update(jobs)
    .set({ phase: "collecting", phaseTotal: units, phaseDone: 0, errorMsg: null })
    .where(eq(jobs.id, job.id));

  try {
    for (const source of toRun) {
      // A capped source is not even built: asking an Actor for one result costs money,
      // and the month's allowance is gone. Blocked, not failed — the cap lifts itself on
      // the 1st, and "Re-run blocked sources" is the button for it.
      if (isPaid(source) && spend.remaining() <= 0) {
        await declareSourceStat(db, job.id, source, {
          status: "blocked",
          lastError: CAP_REACHED,
          finishedAt: new Date(),
          skipped: 0,
          merged: 0,
          enriched: 0,
          requestsUsed: 0,
        });
        log(`${source}: ${CAP_REACHED}`);
        continue;
      }
      // A source starts a fresh run here, so its counters describe this run — the rule
      // the job panel states. `found` is what the job owns and is never zeroed.
      await declareSourceStat(db, job.id, source, {
        status: "running",
        startedAt: new Date(),
        skipped: 0,
        merged: 0,
        enriched: 0,
        requestsUsed: 0,
      });
      try {
        const tally = await runSource(
          db,
          job,
          source,
          onUnitDone,
          log,
          makeAdapter(source, job, spend),
          spend,
        );
        await declareSourceStat(db, job.id, source, { status: "done", finishedAt: new Date() });
        log(
          `${source}: ${tally.created} new, ${tally.merged} joined to known businesses, ${tally.skipped} already collected`,
        );
      } catch (err) {
        if (err instanceof JobCancelled) {
          // The stop closed the job, so the source's row must close with it — a `running`
          // stat on a job no worker owns is invisible to the blocked re-run button.
          await declareSourceStat(db, job.id, source, {
            status: "cancelled",
            finishedAt: new Date(),
          });
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        const status: StatStatus = isBlockedError(err) ? "blocked" : "error";
        // A throttled source is a normal outcome, not a failed job: it is marked
        // `blocked` here, the job still finishes `done`, and "Re-run blocked
        // sources" retries only this source once the service has cooled off.
        await declareSourceStat(db, job.id, source, {
          status,
          lastError: message.slice(0, 500),
          finishedAt: new Date(),
        });
        log(`${source}: ${status} — ${message}`);
      }
    }

    // Enrichment is a second phase over whatever was collected, so a source that was
    // blocked still gets its leads' websites read, and a re-run only visits new hosts.
    await db
      .update(jobs)
      .set({ phase: "enriching", phaseTotal: null, phaseDone: 0 })
      .where(eq(jobs.id, job.id));
    await enrichLeads(db, job.id, {
      fetchPage: deps.fetchPage,
      config: deps.enrich,
      log,
      checkpoint: async () => {
        await beat();
        if (await isCancelRequested(db, job.id)) throw new JobCancelled();
      },
      progress: async (done, total) => {
        await db
          .update(jobs)
          .set({ phaseTotal: total, phaseDone: done })
          .where(eq(jobs.id, job.id));
      },
    });

    await db
      .update(jobs)
      .set({
        status: "done",
        phase: null,
        phaseTotal: null,
        phaseDone: null,
        cancelRequested: false,
        finishedAt: new Date(),
        errorMsg: null,
      })
      .where(eq(jobs.id, job.id));
  } catch (err) {
    if (err instanceof JobCancelled) {
      // What was collected stays collected, so a re-run resumes without spending a
      // request on leads we already have.
      await db
        .update(jobs)
        .set({
          status: "cancelled",
          phase: null,
          phaseTotal: null,
          phaseDone: null,
          cancelRequested: false,
          finishedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      log("cancelled at a checkpoint; collected leads kept");
      return;
    }
    const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
    await db
      .update(jobs)
      .set({ status: "error", errorMsg: message, finishedAt: new Date(), phase: null })
      .where(and(eq(jobs.id, job.id), ne(jobs.status, "cancelled")));
    console.error(`[job ${job.id}] failed: ${message}`);
  }
}
