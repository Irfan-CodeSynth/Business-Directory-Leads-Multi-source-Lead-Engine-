import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { jobSourceStats, jobs, type Db, type Source } from "@dleads/db";
import { isPaid, monthStart, monthlyResultCap, openSpend, resultsPulledSince } from "../src/spend.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5540);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  delete process.env.APIFY_MONTHLY_RESULT_CAP;
});

async function newJob(over: Partial<typeof jobs.$inferInsert> = {}): Promise<number> {
  const [job] = await db.insert(jobs).values({ keywords: ["plumber"], locations: ["Austin"], sources: ["yelp"], ...over }).returning();
  return job!.id;
}

async function pull(source: Source, results: number, jobId?: number): Promise<void> {
  await db
    .insert(jobSourceStats)
    .values({ jobId: jobId ?? (await newJob()), source, status: "done", resultsPulled: results });
}

const DAY = 86_400_000;

describe("monthStart", () => {
  it("is midnight on the first, whatever time of day the pull happened", () => {
    expect(monthStart(new Date(2026, 9, 17, 8, 30)).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(monthStart(new Date(2026, 9, 1, 0, 0, 0, 1)).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(monthStart(new Date(2026, 0, 1)).getTime()).toBe(new Date(2026, 0, 1).getTime());
  });
});

describe("monthlyResultCap", () => {
  it("reads the cap from the environment", () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "500";
    expect(monthlyResultCap()).toBe(500);
  });

  it("falls back to the free-plan number when the setting is missing or nonsense", () => {
    for (const value of [undefined, "", "abc", "0", "-40"]) {
      if (value === undefined) delete process.env.APIFY_MONTHLY_RESULT_CAP;
      else process.env.APIFY_MONTHLY_RESULT_CAP = value;
      expect(monthlyResultCap()).toBe(1500);
    }
  });
});

describe("resultsPulledSince", () => {
  it("adds the paid results only, for the jobs only this month has", async () => {
    await truncateAll(db);
    const now = new Date();
    await pull("yelp", 10);
    await pull("hotfrog", 5);
    // Neither of these is this month's spend: a free source, and a paid one from
    // before the month turned over.
    await pull("osm", 999);
    await pull("yelp", 100, await newJob({ createdAt: new Date(now.getTime() - 45 * DAY) }));

    expect(await resultsPulledSince(db, monthStart(now))).toBe(15);
  });

  it("counts the results a blocked attempt already paid for", async () => {
    await truncateAll(db);
    const jobId = await newJob();
    await db.insert(jobSourceStats).values({ jobId, source: "yelp", status: "blocked", resultsPulled: 4 });
    expect(await resultsPulledSince(db, monthStart(new Date()))).toBe(4);
  });
});

describe("openSpend", () => {
  it("hands the job what is left of the month, and shrinks as it is used", async () => {
    await truncateAll(db);
    process.env.APIFY_MONTHLY_RESULT_CAP = "20";
    await pull("yelp", 15);

    const spend = await openSpend(db, new Date());
    expect(spend.remaining()).toBe(5);
    spend.charge(3);
    expect(spend.remaining()).toBe(2);
    // What the job itself paid, not the lifetime total: that is the number the
    // runner writes to `results_pulled`.
    expect(spend.spent()).toBe(3);
  });

  it("opens a month that is already spent with nothing left", async () => {
    await truncateAll(db);
    process.env.APIFY_MONTHLY_RESULT_CAP = "10";
    await pull("hotfrog", 10);
    expect((await openSpend(db, new Date())).remaining()).toBe(0);
  });
});

describe("isPaid", () => {
  it("caps only the sources that bill per result", () => {
    expect((["osm", "csv", "yelp", "hotfrog"] as Source[]).filter(isPaid)).toEqual(["yelp", "hotfrog"]);
  });
});
