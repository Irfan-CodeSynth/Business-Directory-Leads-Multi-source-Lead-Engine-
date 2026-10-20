import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  jobSourceStats,
  jobs,
  leadContacts,
  leads,
  type Db,
  type Job,
  type Source,
} from "@dleads/db";
import {
  BlockedError,
  type RawLead,
  type ResultSpend,
  type SearchArgs,
  type SearchHooks,
  type SearchOutcome,
  type SourceAdapter,
} from "../src/adapters/types.js";
import { claimJob, closeOrphanedSourceStats, processJob, requeueRunningJobs, workUnits } from "../src/job.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5500);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

const quiet = () => {};

async function newJob(over: Partial<typeof jobs.$inferInsert> = {}): Promise<Job> {
  const [job] = await db
    .insert(jobs)
    .values({ keywords: ["plumber"], locations: ["Austin, TX"], sources: ["osm"], maxItems: 25, ...over })
    .returning();
  return job!;
}

/** Distinctive name + a phone, so it lands in the ledger on the `p:` tier. */
const listing = (over: Partial<RawLead> = {}): RawLead => ({
  externalId: "n1",
  name: "Acme Plumbing",
  phone: "(512) 555-0142",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  website: "https://acmeplumbing.com",
  ...over,
});

/**
 * One charged request per work unit, so `requestsUsed` proves the write path adds no
 * network cost of its own. `failOn` throws once a unit starts, like a real 429.
 */
class Scripted implements SourceAdapter {
  readonly source: Source;
  private unit = 0;
  requests = 0;
  /** What each work unit was asked for, so a clamp can be seen rather than trusted. */
  asks: number[] = [];
  /** The structured spec and location line each unit carried, for the search_spec tests. */
  specs: (SearchArgs["spec"] | undefined)[] = [];
  locations: string[] = [];

  constructor(
    source: Source,
    private readonly units: RawLead[][],
    private readonly failOn?: (unit: number) => Error,
  ) {
    this.source = source;
  }

  async search(args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
    const index = this.unit++;
    this.asks.push(args.maxItems);
    this.specs.push(args.spec);
    this.locations.push(args.location);
    hooks.budget.charge(1);
    this.requests++;
    const fail = this.failOn?.(index);
    if (fail) throw fail;
    const leads = this.units[index] ?? [];
    let emitted = 0;
    for (const raw of leads) {
      if (hooks.shouldStop()) return { emitted, requestsUsed: 1, stopped: true };
      await hooks.emit(raw);
      emitted++;
    }
    return { emitted, requestsUsed: 1, stopped: false };
  }
}

/**
 * `n` listings the dedup tiers will keep apart — a run of them is `n` new leads, not
 * one lead `n` times. `offset` separates batches that a job sees together.
 */
function batch(n: number, offset = 0): RawLead[] {
  return Array.from({ length: n }, (_, i) => {
    const id = offset + i;
    return listing({
      externalId: `b${id}`,
      name: `Business ${id}`,
      phone: `(512) 555-${1000 + id}`,
      website: `https://b${id}.example.com`,
    });
  });
}

function harness(scripts: Partial<Record<Source, Scripted>>) {
  return (source: Source) => scripts[source] ?? new Scripted(source, []);
}

/**
 * A source that bills: it charges the month's meter for the results it returned, which
 * is more than the leads it kept, because dedup discards rows the invoice still counts.
 */
class Paid implements SourceAdapter {
  readonly source: Source;
  readonly pulled: number[] = [];

  constructor(
    source: Source,
    private readonly spend: ResultSpend,
    private readonly results: number,
    private readonly emits: RawLead[],
    private readonly fail?: Error,
  ) {
    this.source = source;
  }

  async search(_args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
    const pulled = Math.min(this.results, this.spend.remaining());
    this.pulled.push(pulled);
    if (pulled === 0) return { emitted: 0, requestsUsed: 0, stopped: false };
    this.spend.charge(pulled);
    hooks.budget.charge(2);
    if (this.fail) throw this.fail;
    for (const raw of this.emits) await hooks.emit(raw);
    return { emitted: this.emits.length, requestsUsed: 2, stopped: false };
  }
}

/** Records which sources the runner actually built an adapter for. */
function track(factory: (source: Source) => SourceAdapter) {
  const built: Source[] = [];
  return {
    built,
    adapter: (source: Source) => {
      built.push(source);
      return factory(source);
    },
  };
}

const yelpLead = listing({ externalId: "yelp:1", name: "Yelp Only Co", phone: "(512) 555-0142" });
const hotfrogLead = listing({ externalId: "hotfrog:1", name: "HotFrog Only Co", phone: "(512) 555-0188" });

/** No test that does not care about enrichment is allowed to reach the internet. */
const noEnrich = { enrich: { maxHosts: 0 } };

function site(pages: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: async (url: string) => {
      asked.push(url);
      return pages[url] ?? null;
    },
  };
}

const jobRow = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;const statRow = async (jobId: number, source: Source) =>
  (await db.select().from(jobSourceStats).where(and(eq(jobSourceStats.jobId, jobId), eq(jobSourceStats.source, source))))[0]!;
const leadCount = async (jobId?: number) =>
  (await db.select({ id: leads.id }).from(leads).where(jobId == null ? undefined : eq(leads.jobId, jobId))).length;

/**
 * What the UI's re-run buttons do: POST /api/jobs/[id]/rerun writes exactly these
 * rows, and which sources it re-queues is what decides what the worker runs next.
 * The counters stay alone here — the worker zeroes the sources it starts.
 */
async function requeue(jobId: number, mode: "all" | "blocked"): Promise<void> {
  const statSet = { status: "pending" as const, lastError: null, startedAt: null, finishedAt: null };
  const where =
    mode === "all"
      ? eq(jobSourceStats.jobId, jobId)
      : and(
          eq(jobSourceStats.jobId, jobId),
          inArray(jobSourceStats.status, ["blocked", "error", "cancelled"]),
        );
  await db.update(jobSourceStats).set(statSet).where(where);
  await db
    .update(jobs)
    .set({
      status: "pending",
      errorMsg: null,
      startedAt: null,
      finishedAt: null,
      leadsSkipped: 0,
      leadsMerged: 0,
      cancelRequested: false,
      phase: null,
      phaseTotal: null,
      phaseDone: null,
    })
    .where(eq(jobs.id, jobId));
}

describe("claimJob", () => {
  it("hands each pending job to exactly one worker and requeues a killed one", async () => {
    const a = await newJob();
    const b = await newJob();

    expect((await claimJob(db))?.id).toBe(a.id);
    expect((await claimJob(db))?.id).toBe(b.id);
    expect(await claimJob(db)).toBeNull();
    expect((await jobRow(a.id)).startedAt).toBeInstanceOf(Date);

    expect(await requeueRunningJobs(db)).toBe(2);
    expect((await claimJob(db))?.id).toBe(a.id);
  });

  it("closes source rows left running by an interrupted worker, and spares live ones", async () => {
    // Job #136's debris pattern: the job is closed, one source row still says `running`,
    // and no re-run button can see it.
    const orphan = await newJob();
    await db.update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, orphan.id));
    await db
      .insert(jobSourceStats)
      .values({ jobId: orphan.id, source: "osm", status: "running", startedAt: new Date() });
    // A second worker's live run: the job is claimed, so its row belongs to someone.
    const live = await newJob();
    await db.update(jobs).set({ status: "running", startedAt: new Date() }).where(eq(jobs.id, live.id));
    await db
      .insert(jobSourceStats)
      .values({ jobId: live.id, source: "osm", status: "running", startedAt: new Date() });

    const closed = await closeOrphanedSourceStats(db);

    expect(closed).toBe(1);
    const healed = await statRow(orphan.id, "osm");
    expect(healed.status).toBe("cancelled");
    expect(healed.finishedAt).toBeInstanceOf(Date);
    expect((await statRow(live.id, "osm")).status).toBe("running");
  });

  it("hands the worker the whole job row, not just the columns it happens to read", async () => {
    const job = await newJob({ sources: ["csv"], importRows: [{ name: "Claimed Co" }], maxItems: 7 });
    const claimed = await claimJob(db);
    // A raw `RETURNING *` would give back `max_items`/`import_rows` and the run would
    // collect nothing while still reporting success.
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.maxItems).toBe(7);
    expect(claimed?.importRows).toEqual([{ name: "Claimed Co" }]);
    expect(claimed?.sources).toEqual(["csv"]);
  });
});

describe("processJob", () => {
  it("keeps its counters and its rows in step", async () => {
    const job = await newJob({ keywords: ["plumber", "drain"], locations: ["Austin"] });
    const osm = new Scripted("osm", [
      [
        listing(),
        listing({ externalId: "n2", name: "Blue Ridge Pipes", phone: "(512) 555-0188" }),
        listing({ externalId: "n3", name: "Colorado Drains", phone: "(720) 555-0104" }),
      ],
      // Same listing twice, plus the same business published under another id with
      // a differently spelled phone.
      [
        listing({ externalId: "n2" }),
        listing({ externalId: "n9", name: "Blue Ridge Pipes", phone: "1-512-555-0188", postalCode: null }),
      ],
    ]);

    await processJob(db, job, { adapter: harness({ osm }), log: quiet, ...noEnrich });

    const after = await jobRow(job.id);
    expect(after).toMatchObject({ status: "done", leadsFound: 3, leadsSkipped: 1, leadsMerged: 1 });
    expect(after.phase).toBeNull();
    expect(after.finishedAt).toBeInstanceOf(Date);

    // One row per business in this job: the skip and the merge added none.
    expect(await leadCount(job.id)).toBe(3);

    const stat = await statRow(job.id, "osm");
    expect(stat).toMatchObject({ status: "done", found: 3, skipped: 1, merged: 1, requestsUsed: 2 });
    // The job's totals are the sum of its sources' — that is what the UI prints.
    expect(stat.found + stat.skipped + stat.merged).toBe(5);

    expect(await db.select({ id: leads.id }).from(leads).where(eq(leads.jobId, job.id))).toHaveLength(3);
  });

  it("collects nothing twice when the same job runs again", async () => {
    const job = await newJob();
    const units = [[listing(), listing({ externalId: "n2", name: "Blue Ridge Pipes", phone: "(512) 555-0188" })]];
    // A fresh adapter per run: the same query answered again next week.
    const run = () => processJob(db, job, { adapter: harness({ osm: new Scripted("osm", units) }), log: quiet, ...noEnrich });

    await run();
    await requeue(job.id, "all");
    await run();

    expect(await leadCount(job.id)).toBe(2);
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ leadsFound: 2, leadsSkipped: 2, leadsMerged: 0 });
    // `found` is ownership and persists; the rest describes the run just made, and the
    // job's totals stay the sum of its sources after any re-run.
    const stat = await statRow(job.id, "osm");
    expect(stat).toMatchObject({ status: "done", found: 2, skipped: 2, merged: 0, requestsUsed: 1 });
    expect(stat.found).toBe(after.leadsFound);
  });

  it("joins a listing a previous job already knows instead of duplicating it, at no extra request cost", async () => {
    const first = await newJob();
    const osm1 = new Scripted("osm", [[listing()]]);
    await processJob(db, first, { adapter: harness({ osm: osm1 }), log: quiet, ...noEnrich });

    const second = await newJob({ keywords: ["emergency plumber"] });
    const osm2 = new Scripted("osm", [[listing({ phone: "1 512 555 0142" })]]);
    await processJob(db, second, { adapter: harness({ osm: osm2 }), log: quiet, ...noEnrich });

    // Found once, recognised the second time: the whole ledger holds one row for it.
    expect(await leadCount()).toBe(1);
    const after = await jobRow(second.id);
    expect(after).toMatchObject({ leadsFound: 0, leadsMerged: 1, status: "done" });
    // Recognising it cost no request — only the search itself does, one per unit here.
    expect(osm2.requests).toBe(1);
    expect((await statRow(second.id, "osm")).requestsUsed).toBe(1);
  });

  it("marks a throttled source blocked and still finishes the job", async () => {
    const job = await newJob({ sources: ["osm", "csv"] });
    const osm = new Scripted(
      "osm",
      [[listing()]],
      (unit) =>
        unit === 0
          ? new BlockedError("osm", "Overpass interpreter: HTTP 429 rate limited after 3 attempt(s)", 429)
          : new Error("unexpected"),
    );
    const csv = new Scripted("csv", [
      [
        listing({ externalId: "j1r0", name: "Imported Co", phone: "(512) 555-0177" }),
        listing({ externalId: "j1r1", name: "Another Import", phone: "(512) 555-0166" }),
      ],
    ]);

    await processJob(db, job, { adapter: harness({ osm, csv }), log: quiet, ...noEnrich });

    const after = await jobRow(job.id);
    expect(after.status).toBe("done");
    expect(after.errorMsg).toBeNull();

    const blocked = await statRow(job.id, "osm");
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toContain("429");
    // It was throttled before it emitted anything, so it counts nothing.
    expect(blocked.found).toBe(0);
    // The other source ran untouched, and the job's totals are only its rows.
    expect((await statRow(job.id, "csv")).status).toBe("done");
    expect(after.leadsFound).toBe(2);
    expect(await leadCount(job.id)).toBe(2);
  });

  it("re-runs only the throttled source when blocked sources are re-queued", async () => {
    const job = await newJob({ sources: ["osm", "csv"] });
    const osm = new Scripted(
      "osm",
      [[listing()]],
      () => new BlockedError("osm", "Overpass returned HTTP 429 after 2 attempt(s)", 429),
    );
    const csv = new Scripted("csv", [[listing({ externalId: "j1r0", name: "Imported Co", phone: "(512) 555-0177" })]]);
    await processJob(db, job, { adapter: harness({ osm, csv }), log: quiet, ...noEnrich });
    expect((await statRow(job.id, "osm")).status).toBe("blocked");
    expect(csv.requests).toBe(1);

    await requeue(job.id, "blocked");

    let phaseTotal: number | null = null;
    const cooledOff: SourceAdapter = {
      source: "osm",
      async search(_args, hooks) {
        phaseTotal = (await jobRow(job.id)).phaseTotal;
        hooks.budget.charge(1);
        await hooks.emit(listing());
        return { emitted: 1, requestsUsed: 1, stopped: false };
      },
    };
    await processJob(db, job, { adapter: (source) => (source === "osm" ? cooledOff : csv), log: quiet, ...noEnrich });

    const retry = await statRow(job.id, "osm");
    expect(retry).toMatchObject({ status: "done", found: 1, lastError: null });
    // The cost the panel shows is this attempt's, not the sum of every attempt: the
    // first one spent a request before it was throttled, and that number is history.
    expect(retry.requestsUsed).toBe(1);
    // The source that already finished is left alone: no second pass over the list,
    // and its own counters still describe the run that produced them.
    expect(csv.requests).toBe(1);
    expect(await statRow(job.id, "csv")).toMatchObject({ status: "done", found: 1, requestsUsed: 1 });
    // The progress bar counts only the work this run actually does.
    expect(phaseTotal).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 2 });
    expect(await leadCount(job.id)).toBe(2);
  });

  it("keeps collected leads when the job is stopped at a checkpoint", async () => {
    const job = await newJob();
    const stopping: SourceAdapter = {
      source: "osm",
      async search(_args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
        await hooks.emit(listing());
        await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, job.id));
        hooks.budget.charge(1);
        await hooks.emit(listing({ externalId: "n2", name: "Blue Ridge Pipes", phone: "(512) 555-0188" }));
        return { emitted: 2, requestsUsed: 1, stopped: false };
      },
    };

    await processJob(db, job, { adapter: () => stopping, log: quiet, ...noEnrich });

    const after = await jobRow(job.id);
    expect(after).toMatchObject({ status: "cancelled", cancelRequested: false });
    expect(after.phase).toBeNull();
    // Both were ingested before the poll noticed — a stop lands on a lead boundary,
    // and the counters were flushed on the way out rather than lost.
    expect(await leadCount(job.id)).toBe(2);
    expect(after.leadsFound).toBe(2);
    expect((await statRow(job.id, "osm")).found).toBe(2);
    // The source's row must close with the job: a `running` stat on a cancelled job is
    // invisible to the blocked re-run button, which is how a paid source gets orphaned.
    expect((await statRow(job.id, "osm")).status).toBe("cancelled");
  });

  it("re-runs a source cancelled mid-run when blocked sources are re-queued", async () => {
    const job = await newJob();
    const stopping: SourceAdapter = {
      source: "osm",
      async search(_args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
        await hooks.emit(listing());
        // The next emit's poll sees the flag and throws, so this source dies mid-run.
        await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, job.id));
        await hooks.emit(listing({ externalId: "n2", name: "Blue Ridge Pipes", phone: "(512) 555-0188" }));
        return { emitted: 2, requestsUsed: 1, stopped: false };
      },
    };
    await processJob(db, job, { adapter: () => stopping, log: quiet, ...noEnrich });
    expect((await statRow(job.id, "osm")).status).toBe("cancelled");
    expect(await jobRow(job.id)).toMatchObject({ status: "cancelled" });
    // Both were ingested before the poll noticed — a stop lands on a lead boundary.
    expect(await leadCount(job.id)).toBe(2);

    await requeue(job.id, "blocked");

    const finisher = new Scripted("osm", [
      [listing({ externalId: "n3", name: "Cedar Valley Drains", phone: "(512) 555-0199" })],
    ]);
    await processJob(db, job, { adapter: () => finisher, log: quiet, ...noEnrich });
    const retried = await statRow(job.id, "osm");
    expect(retried).toMatchObject({ status: "done", lastError: null });
    expect(await jobRow(job.id)).toMatchObject({ status: "done" });
    // The cancelled run kept its leads; the re-run added the one it was stopped before.
    expect(await leadCount(job.id)).toBe(3);
  });

  it("enriches the collected websites once per domain during the enriching phase", async () => {
    const job = await newJob();
    const osm = new Scripted("osm", [
      [
        listing(),
        listing({
          externalId: "n2",
          name: "Acme Plumbing North",
          phone: "(512) 555-0188",
          website: "https://www.acmeplumbing.com/contact",
        }),
      ],
    ]);
    const { fetchPage, asked } = site({ "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>" });

    await processJob(db, job, {
      adapter: harness({ osm }),
      log: quiet,
      fetchPage,
      enrich: { delayMinMs: 0, delayMaxMs: 0 },
    });

    // Two listings, one business website: the domain is visited once, on the spelling
    // the first lead carried.
    expect(asked).toEqual([
      "https://acmeplumbing.com",
      "https://acmeplumbing.com/contact",
      "https://acmeplumbing.com/about",
    ]);
    const rows = await db.select().from(leads).where(eq(leads.jobId, job.id));
    expect(rows.every((r) => r.enriched)).toBe(true);
    const contacts = await db
      .select()
      .from(leadContacts)
      .where(inArray(leadContacts.leadId, rows.map((r) => r.id)));
    expect(contacts).toHaveLength(2);
    expect(contacts.every((c) => (c.emails ?? []).includes("office@acmeplumbing.com"))).toBe(true);
    expect((await statRow(job.id, "osm")).enriched).toBe(2);
    expect(await jobRow(job.id)).toMatchObject({ status: "done", phase: null });
  });

  it("reports it is still alive while it works, not only between jobs", async () => {
    const job = await newJob({ keywords: ["plumber", "electrician"] });
    const osm = new Scripted("osm", [
      [listing()],
      [listing({ externalId: "n2", name: "Blue Ridge Pipes", phone: "(512) 555-0188" })],
    ]);
    const { fetchPage } = site({ "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>" });

    let beats = 0;
    await processJob(db, job, {
      adapter: harness({ osm }),
      log: quiet,
      fetchPage,
      enrich: { delayMinMs: 0, delayMaxMs: 0 },
      heartbeat: async () => {
        beats++;
      },
    });

    // Two collection units plus the one domain it crawled. A run can take minutes on
    // network waits alone, and a banner that says "no worker running" during them is a lie.
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(await jobRow(job.id).then((r) => r.status)).toBe("done");
  });

  it("does not let two imports that share a row number be the same business", async () => {
    const listingRows = (name: string) => [{ name, city: "Austin" }];
    const monday = await newJob({ sources: ["csv"], importRows: listingRows("Bob's Pumps") });
    const tuesday = await newJob({ sources: ["csv"], importRows: listingRows("Sue's Lighting") });

    // The real csv adapter keys on `j<jobId>r<index>`; positional ids alone would
    // have matched row 0 of one list to row 0 of the other.
    await processJob(db, monday, { log: quiet, ...noEnrich });
    await processJob(db, tuesday, { log: quiet, ...noEnrich });

    expect(await leadCount()).toBe(2);
    expect((await jobRow(tuesday.id)).leadsMerged).toBe(0);
    expect((await statRow(monday.id, "csv")).requestsUsed).toBe(0);
  });
});

describe("lead target", () => {
  it("marks a source done as soon as it has added the target's worth of new leads", async () => {
    const job = await newJob({ keywords: ["plumber", "drain", "gas"], locations: ["Austin"], leadTarget: 4 });
    const osm = new Scripted("osm", [batch(3), batch(3, 100), batch(3, 200)]);

    await processJob(db, job, { adapter: harness({ osm }), log: quiet, ...noEnrich });

    // Four new rows is the deal: the second query got halfway and the third is never
    // asked, so the listings past the target cost nothing.
    expect(osm.requests).toBe(2);
    expect(await leadCount(job.id)).toBe(4);
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 4, errorMsg: null });
    // Reaching the target is finishing, not being stopped: the source reads `done`.
    expect(await statRow(job.id, "osm")).toMatchObject({ status: "done", found: 4 });
  });

  it("asks each query only for the new leads the source still needs", async () => {
    const job = await newJob({
      keywords: ["plumber", "drain", "gas"],
      locations: ["Austin"],
      maxItems: 25,
      leadTarget: 8,
    });
    const osm = new Scripted("osm", [batch(5), batch(5, 100), batch(5, 200)]);

    await processJob(db, job, { adapter: harness({ osm }), log: quiet, ...noEnrich });

    // The first query can use the whole 25-row cap, but only 8 leads are still wanted;
    // after five of them, the second query asks for the three that remain.
    expect(osm.asks).toEqual([8, 3]);
  });

  it("counts only leads it has never seen toward the target", async () => {
    const earlier = await newJob();
    await processJob(db, earlier, { adapter: harness({ osm: new Scripted("osm", [batch(2)]) }), log: quiet, ...noEnrich });

    const job = await newJob({ keywords: ["plumber", "drain"], locations: ["Austin"], leadTarget: 2 });
    const osm = new Scripted("osm", [[...batch(2), ...batch(3, 100)], batch(3, 200)]);
    await processJob(db, job, { adapter: harness({ osm }), log: quiet, ...noEnrich });

    // Two of the five listings were already in the ledger, so two more were needed —
    // a target counted in rows returned would have stopped after the second one.
    const stat = await statRow(job.id, "osm");
    expect(stat).toMatchObject({ status: "done", found: 2, merged: 2 });
    expect(osm.requests).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 2 });
  });

  it("aims for the target once per source, not once per run", async () => {
    const job = await newJob({ sources: ["osm", "yelp"], leadTarget: 2 });
    const osm = new Scripted("osm", [batch(3)]);
    const yelp = new Scripted("yelp", [batch(3, 100)]);

    await processJob(db, job, { adapter: harness({ osm, yelp }), log: quiet, ...noEnrich });

    expect(await statRow(job.id, "osm")).toMatchObject({ status: "done", found: 2 });
    expect(await statRow(job.id, "yelp")).toMatchObject({ status: "done", found: 2 });
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 4 });
  });

  it("finishes normally when the source runs out of listings before the target", async () => {
    const job = await newJob({ leadTarget: 50 });
    const osm = new Scripted("osm", [batch(3)]);

    await processJob(db, job, { adapter: harness({ osm }), log: quiet, ...noEnrich });

    // A small city has forty plumbers, not a hundred: falling short is a full list,
    // not an error, and the job still says done.
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ status: "done", leadsFound: 3, errorMsg: null });
    expect(await statRow(job.id, "osm")).toMatchObject({ status: "done", found: 3 });
  });

  it("imports every row of a pasted list even when the list is longer than the target", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ name: `Imported ${i}`, city: "Austin" }));
    const job = await newJob({ sources: ["csv"], importRows: rows, leadTarget: 2 });

    await processJob(db, job, { log: quiet, ...noEnrich });

    // The target exists to stop scraping that costs money and time. A file already in
    // hand costs nothing, and dropping the owner's own rows would lose data silently.
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 4 });
  });
});

describe("paid sources", () => {
  afterEach(() => {
    delete process.env.APIFY_MONTHLY_RESULT_CAP;
  });

  const alreadyPulled = async (source: Source, results: number, jobId: number) => {
    await db.insert(jobSourceStats).values({ jobId, source, status: "done", resultsPulled: results });
  };

  it("blocks a paid source whose monthly cap is spent, and runs the others anyway", async () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "100";
    const prior = await newJob();
    await alreadyPulled("yelp", 100, prior.id);

    const job = await newJob({ sources: ["osm", "yelp"] });
    const osm = new Scripted("osm", [[listing()]]);
    const seen = track(() => osm);
    await processJob(db, job, { adapter: seen.adapter, log: quiet, ...noEnrich });

    // Capped before it was built: an Apify run costs money, and this one was not spent.
    expect(seen.built).toEqual(["osm"]);
    const blocked = await statRow(job.id, "yelp");
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toContain("APIFY_MONTHLY_RESULT_CAP");
    expect((await statRow(job.id, "osm")).status).toBe("done");
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 1 });
  });

  it("counts only this month's pulls against the cap", async () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "100";
    const lastMonth = await newJob({ createdAt: new Date(Date.now() - 45 * 86_400_000) });
    await alreadyPulled("yelp", 100, lastMonth.id);

    const job = await newJob({ sources: ["yelp"] });
    const meters: ResultSpend[] = [];
    await processJob(db, job, {
      adapter: (source, _job, meter) => {
        meters.push(meter);
        return new Paid(source, meter, 3, [yelpLead]);
      },
      log: quiet,
      ...noEnrich,
    });

    expect(meters).toHaveLength(1);
    expect(meters[0]!.remaining()).toBe(97);
    expect(await statRow(job.id, "yelp")).toMatchObject({ status: "done", resultsPulled: 3, found: 1 });
  });

  it("shares one monthly allowance between the paid sources of a job", async () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "10";
    const job = await newJob({ sources: ["yelp", "hotfrog"] });
    const paid: Paid[] = [];
    await processJob(db, job, {
      adapter: (source, _job, meter) => {
        const unit = new Paid(source, meter, source === "yelp" ? 8 : 6, [source === "yelp" ? yelpLead : hotfrogLead]);
        paid.push(unit);
        return unit;
      },
      log: quiet,
      ...noEnrich,
    });

    expect(paid.map((p) => p.pulled)).toEqual([[8], [2]]);
    expect(await statRow(job.id, "yelp")).toMatchObject({ status: "done", resultsPulled: 8 });
    expect(await statRow(job.id, "hotfrog")).toMatchObject({ status: "done", resultsPulled: 2 });
  });

  it("keeps what a blocked attempt already paid for", async () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "100";
    const job = await newJob({ sources: ["yelp"] });
    const refused = new BlockedError("yelp", "this Apify account has no credit left", 402);
    await processJob(db, job, {
      adapter: (source, _job, meter) => new Paid(source, meter, 4, [yelpLead], refused),
      log: quiet,
      ...noEnrich,
    });
    expect(await statRow(job.id, "yelp")).toMatchObject({
      status: "blocked",
      resultsPulled: 4,
      lastError: expect.stringContaining("credit"),
    });

    await requeue(job.id, "blocked");
    await processJob(db, job, {
      adapter: (source, _job, meter) => new Paid(source, meter, 4, [yelpLead]),
      log: quiet,
      ...noEnrich,
    });

    // Eight results billed across the two attempts. `requestsUsed` describes the run
    // that just happened; the money never does.
    expect(await statRow(job.id, "yelp")).toMatchObject({
      status: "done",
      resultsPulled: 8,
      requestsUsed: 2,
      found: 1,
    });
  });
});

describe("structured search (search_spec)", () => {
  const SPEC = { keyword: "plumber", category: "home-services", country: "US", state: "TX", city: "Austin" };

  it("replaces the keyword x location matrix with one spec-carrying unit", async () => {
    const job = await newJob({ searchSpec: SPEC });
    expect(workUnits("osm", job)).toEqual([
      { keyword: "plumber", location: "Austin, TX, United States", maxItems: 25, spec: SPEC },
    ]);
  });

  it("runs the legacy matrix when no spec is stored", async () => {
    const job = await newJob({ keywords: ["plumber", "dentist"], locations: ["Austin, TX", "Dallas, TX"] });
    expect(workUnits("osm", job).map((u) => `${u.keyword} @ ${u.location}`)).toEqual([
      "plumber @ Austin, TX",
      "dentist @ Austin, TX",
      "plumber @ Dallas, TX",
      "dentist @ Dallas, TX",
    ]);
  });

  it("ignores the spec for a csv import, which takes its rows from the job", async () => {
    const job = await newJob({ searchSpec: SPEC, importRows: [{ name: "Acme Plumbing" }], importLabel: "pasted list" });
    const units = workUnits("csv", job);
    expect(units).toHaveLength(1);
    expect(units[0]!.keyword).toBe("pasted list");
    expect(units[0]!.spec).toBeUndefined();
  });

  it("hands the spec and the geocodable location line to the adapter", async () => {
    const job = await newJob({ sources: ["osm"], searchSpec: SPEC });
    const osm = new Scripted("osm", [[listing()]]);
    await processJob(db, job, { adapter: () => osm, log: quiet, ...noEnrich });
    expect(osm.specs).toEqual([SPEC]);
    expect(osm.locations).toEqual(["Austin, TX, United States"]);
    expect(await jobRow(job.id)).toMatchObject({ status: "done", leadsFound: 1 });
  });

  it("counts one structured unit per source, where a matrix job counts each pair", async () => {
    const job = await newJob({ sources: ["osm", "yelp"], searchSpec: SPEC });
    await processJob(db, job, {
      adapter: (source) => new Scripted(source, []),
      log: quiet,
      ...noEnrich,
    });
    // The display arrays carry the same values a two-row matrix would, but the spec
    // path asks each source exactly once — and a Scripted unit charges one request.
    expect(workUnits("osm", job)).toHaveLength(1);
    expect(workUnits("yelp", job)).toHaveLength(1);
    expect(await statRow(job.id, "osm")).toMatchObject({ status: "done", requestsUsed: 1 });
    expect(await statRow(job.id, "yelp")).toMatchObject({ status: "done", requestsUsed: 1 });
  });
});
