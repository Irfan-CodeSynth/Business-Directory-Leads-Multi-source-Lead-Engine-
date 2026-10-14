import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { jobs, knownBusinesses, leads, makeDb, workerStatus, type Db } from "@dleads/db";
import { ingestLead } from "../src/ingest.js";
import type { RawLead } from "../src/adapters/types.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite";

/**
 * A dashboard page load fires a dozen different queries at once. `pglite-socket` runs
 * every connection against one Postgres instance and cross-wires their bind parameters,
 * so a pool wider than one connection returns the wrong rows or dies with
 * `bind message supplies 2 parameters, but prepared statement "" requires 1`.
 * The connection limit is part of the schema's safety, not a tuning knob — and it is the
 * one that has to hold when nothing is configured at all.
 */

let test: TestDb;
const savedPoolMax = process.env.POOL_MAX;

beforeAll(async () => {
  test = await startTestDb(5530);
  delete process.env.POOL_MAX;
});

afterAll(async () => {
  if (savedPoolMax === undefined) delete process.env.POOL_MAX;
  else process.env.POOL_MAX = savedPoolMax;
  await test.close();
});

describe("makeDb", () => {
  it("serves a page load of mixed concurrent queries with no pool configuration set", async () => {
    await truncateAll(test.db);
    const db = makeDb(test.url);
    await db.insert(jobs).values({ keywords: ["plumber"], locations: ["Belfast"], sources: ["osm"] });
    await db
      .insert(knownBusinesses)
      .values({
        dedupKey: "p:connection-probe",
        kind: "name_phone",
        name: "Acme Plumbing",
        source: "osm",
        leadId: 1,
        jobId: 1,
      });

    const rows = await Promise.all([
      db.select({ id: leads.id }).from(leads).limit(5),
      db.select({ n: count() }).from(jobs),
      db
        .select({ name: knownBusinesses.name })
        .from(knownBusinesses)
        .where(eq(knownBusinesses.name, "Acme Plumbing")),
      db.select().from(workerStatus).where(eq(workerStatus.id, 1)),
      db.select({ keywords: jobs.keywords }).from(jobs).where(eq(jobs.status, "pending")),
      db.execute(sql`select 1::int as n`),
    ]);
    await db.$client.end();

    expect(rows[1]).toEqual([{ n: 1 }]);
    expect(rows[2]).toEqual([{ name: "Acme Plumbing" }]);
    expect(rows[4]).toEqual([{ keywords: ["plumber"] }]);
  });
});

/**
 * The dashboard and the worker are separate processes, so the dev database carries two
 * connections over one Postgres session — and `pglite-socket` queues protocol messages one
 * at a time, so a six-parameter select can be bound against the eight-parameter statement
 * the other process parsed a moment earlier. That does not only error (`bind message
 * supplies 6 parameters, but prepared statement "" requires 8`); it also answers a query
 * with the other connection's row, which is worse. Each connection under its own statement
 * name keeps the two apart.
 */
describe("two processes on one database", () => {
  const savedNamedStatements = process.env.DB_NAMED_STATEMENTS;

  beforeAll(() => {
    process.env.DB_NAMED_STATEMENTS = "true";
  });

  afterAll(() => {
    if (savedNamedStatements === undefined) delete process.env.DB_NAMED_STATEMENTS;
    else process.env.DB_NAMED_STATEMENTS = savedNamedStatements;
  });

  /** A dead connection stops answering rather than reporting it, so bound every wait. */
  const answer = async <T,>(query: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout>;
    const outcome = await Promise.race([
      query,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
    clearTimeout(timer!);
    return outcome;
  };

  it("answers each connection with its own parameters, not the other one's", async () => {
    const dashboard = makeDb(test.url);
    const worker = makeDb(test.url);

    /** `select $1::int as c1, … $N::int as cN`, so both the arity and the values check out. */
    const ask = (db: Db, columns: number, base: number) =>
      db.execute(sql`select ${sql.join(
        Array.from(
          { length: columns },
          (_, k) => sql`${base + k}::int ${sql.raw(`as c${k + 1}`)}`,
        ),
        sql`, `,
      )}`) as unknown as Promise<Record<string, number>[]>;

    const wrong: string[] = [];
    const run = async (db: Db, columns: number) => {
      for (let round = 0; round < 25 && wrong.length === 0; round++) {
        const wanted = JSON.stringify(
          Object.fromEntries(
            Array.from({ length: columns }, (_, k) => [`c${k + 1}`, String(round + k)]),
          ),
        );
        // Values are stringified so an `int`/`bigint` choice can't decide the assertion.
        const rows = await answer(ask(db, columns, round), 3000).catch((error: Error) => {
          wrong.push(`${columns} params -> ${error.message}`);
          return undefined;
        });
        if (wrong.length) break;
        if (rows === undefined) {
          wrong.push(`${columns} params -> never answered`);
        } else if (JSON.stringify(rows[0], (_, v) => (typeof v === "number" ? String(v) : v)) !== wanted) {
          wrong.push(`${columns} params -> ${JSON.stringify(rows[0])}, wanted ${wanted}`);
        }
      }
    };

    try {
      await Promise.all([run(dashboard, 6), run(worker, 8)]);
    } finally {
      await dashboard.$client.end({ timeout: 1 });
      await worker.$client.end({ timeout: 1 });
    }

    expect(wrong).toEqual([]);
  });

  /**
   * The exact shape that failed on job #168: the worker writing collected leads through
   * its transaction, while the dashboard keeps polling the same tables from its own
   * process. The write path is twenty-odd parameters and the polling is two, which is
   * precisely the combination that used to collide.
   */
  it("writes leads in a transaction while the other connection polls", async () => {
    await truncateAll(test.db);
    const [job] = await test.db
      .insert(jobs)
      .values({ keywords: ["roofing"], locations: ["Austin, TX"], sources: ["hotfrog"] })
      .returning({ id: jobs.id });
    const jobId = job!.id;

    const dashboard = makeDb(test.url);
    const worker = makeDb(test.url);
    const wrong: string[] = [];

    const collect = async () => {
      for (let n = 0; n < 12 && wrong.length === 0; n++) {
        const raw: RawLead = {
          externalId: `hf${n}`,
          name: `Roofing Co ${n}`,
          phone: `(512) 555-${1000 + n}`,
          city: "Austin",
          region: "TX",
          website: `https://roofing${n}.example.com`,
        };
        const outcome = await answer(
          ingestLead(worker, { jobId, source: "hotfrog", raw }),
          3000,
        ).catch((error: Error) => error);
        if (outcome instanceof Error) wrong.push(`ingest ${n} -> ${outcome.message}`);
        else if (outcome !== "created") wrong.push(`ingest ${n} -> ${outcome}`);
      }
    };

    const poll = async () => {
      for (let round = 0; round < 24 && wrong.length === 0; round++) {
        const query =
          round % 2 === 0
            ? dashboard
                .select({ id: leads.id, name: leads.name })
                .from(leads)
                .where(and(eq(leads.jobId, jobId), eq(leads.source, "hotfrog")))
            : dashboard
                .select({ id: leads.id })
                .from(leads)
                .where(eq(leads.source, "hotfrog"));
        const error = await answer(query, 3000)
          .then((rows) => (rows === undefined ? new Error("never answered") : null))
          .catch((e: Error) => e);
        if (error) wrong.push(`poll ${round} -> ${error.message}`);
      }
    };

    try {
      await Promise.all([collect(), poll()]);
    } finally {
      await dashboard.$client.end({ timeout: 1 });
      await worker.$client.end({ timeout: 1 });
    }

    expect(wrong).toEqual([]);
    const written = await test.db.select({ id: leads.id }).from(leads);
    expect(written).toHaveLength(12);
  });
});
