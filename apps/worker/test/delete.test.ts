import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  deleteJobsByIds,
  deleteLeadsByIds,
  jobSourceStats,
  jobs,
  knownBusinesses,
  leadContacts,
  leadSources,
  leads,
  type Db,
} from "@dleads/db";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5550);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function insertJob(over: Partial<typeof jobs.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobs)
    .values({ keywords: ["plumber"], locations: ["Austin, TX"], sources: ["osm"], status: "done", ...over })
    .returning();
  return job!;
}

async function insertLead(jobId: number, over: Partial<typeof leads.$inferInsert> = {}) {
  const [lead] = await db
    .insert(leads)
    .values({
      jobId,
      source: "osm",
      externalId: `x-${jobId}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Acme Plumbing",
      nameKey: "acme plumbing",
      dedupKey: "p:+15125550142",
      dedupKind: "p",
      phone: "(512) 555-0142",
      ...over,
    })
    .returning();
  return lead!;
}

/** The full debris a real collection leaves behind: stat row, source link, contact, ledger. */
async function insertDebris(leadId: number, jobId: number, dedupKey: string) {
  await db.insert(leadSources).values({ leadId, source: "osm", externalId: "x-1" });
  await db.insert(leadContacts).values({ leadId, emails: ["office@acme.example"] });
  await db.insert(knownBusinesses).values({
    dedupKey,
    kind: "p",
    name: "Acme Plumbing",
    nameKey: "acme plumbing",
    source: "osm",
    externalIds: { osm: "x-1" },
    phone: "(512) 555-0142",
    phoneE164: "+15125550142",
    leadId,
    jobId,
  });
}

async function countRows(table: PgTable, where?: SQL) {
  const [row] = where
    ? await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where)
    : await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row!.n;
}

describe("deleteJobsByIds", () => {
  it("removes a job with its stats, leads and links, and forgets the business", async () => {
    const job = await insertJob();
    await db.insert(jobSourceStats).values({ jobId: job.id, source: "osm", status: "done", found: 1 });
    const lead = await insertLead(job.id);
    await insertDebris(lead.id, job.id, lead.dedupKey);

    const outcome = await deleteJobsByIds(db, [job.id]);

    expect(outcome).toEqual({ deleted: 1, rejected: [] });
    expect(await countRows(jobs)).toBe(0);
    expect(await countRows(jobSourceStats)).toBe(0);
    expect(await countRows(leads)).toBe(0);
    expect(await countRows(leadSources)).toBe(0);
    expect(await countRows(leadContacts)).toBe(0);
    expect(await countRows(knownBusinesses)).toBe(0);
  });

  it("keeps the ledger entry a surviving lead still owns", async () => {
    const jobA = await insertJob();
    const jobB = await insertJob();
    // Two leads of different jobs keyed identically — the fallible-tier world where the
    // ledger row points at the first, and the second job's lead shares its key.
    const shared = { dedupKey: "z:acme-plumbing:78701", dedupKind: "z" };
    const leadA = await insertLead(jobA.id, { ...shared, externalId: "a-1" });
    const leadB = await insertLead(jobB.id, { ...shared, externalId: "b-1" });
    await insertDebris(leadA.id, jobA.id, shared.dedupKey);

    const outcome = await deleteJobsByIds(db, [jobA.id]);

    expect(outcome.deleted).toBe(1);
    // The survivor keeps its lead and its ledger row: forgetting the business here
    // would let a future run collect it twice.
    const [survivor] = await db.select().from(knownBusinesses).where(eq(knownBusinesses.dedupKey, shared.dedupKey));
    expect(survivor).toBeDefined();
    expect(await countRows(leads, eq(leads.id, leadB.id))).toBe(1);
    expect(await countRows(jobs)).toBe(1);
  });

  it("refuses jobs the worker still owns, and deletes nothing", async () => {
    const queued = await insertJob({ status: "pending" });
    const running = await insertJob({ status: "running" });
    const finished = await insertJob();

    const outcome = await deleteJobsByIds(db, [queued.id, running.id, finished.id]);

    expect(outcome).toEqual({ deleted: 0, rejected: expect.arrayContaining([queued.id, running.id]) });
    expect(outcome.rejected).toHaveLength(2);
    expect(await countRows(jobs)).toBe(3);
  });

  it("deletes nothing when asked for unknown ids", async () => {
    const outcome = await deleteJobsByIds(db, [99999]);
    expect(outcome).toEqual({ deleted: 0, rejected: [] });
  });
});

describe("deleteLeadsByIds", () => {
  it("removes the lead with its links and contacts, and forgets the business", async () => {
    const job = await insertJob();
    const lead = await insertLead(job.id);
    const keeper = await insertLead(job.id, {
      externalId: "keep-1",
      dedupKey: "z:keeper:78701",
      dedupKind: "z",
      phone: "(512) 555-0199",
    });
    await insertDebris(lead.id, job.id, lead.dedupKey);

    const outcome = await deleteLeadsByIds(db, [lead.id]);

    expect(outcome).toEqual({ deleted: 1, rejected: [] });
    expect(await countRows(leads, eq(leads.id, keeper.id))).toBe(1);
    expect(await countRows(leadSources, eq(leadSources.leadId, keeper.id))).toBe(0);
    expect(await countRows(knownBusinesses, eq(knownBusinesses.dedupKey, lead.dedupKey))).toBe(0);
    expect(await countRows(leads, eq(leads.id, lead.id))).toBe(0);
    expect(await countRows(leadContacts, eq(leadContacts.leadId, lead.id))).toBe(0);
    expect(await countRows(leadSources, eq(leadSources.leadId, lead.id))).toBe(0);
  });

  it("refuses leads whose job is still queued or running", async () => {
    const activeJob = await insertJob({ status: "running" });
    const lead = await insertLead(activeJob.id);
    const otherJob = await insertJob();
    const otherLead = await insertLead(otherJob.id);

    const outcome = await deleteLeadsByIds(db, [lead.id, otherLead.id]);

    expect(outcome).toEqual({ deleted: 0, rejected: [lead.id] });
    expect(await countRows(leads)).toBe(2);
  });
});
