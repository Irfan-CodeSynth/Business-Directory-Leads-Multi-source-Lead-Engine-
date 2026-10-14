import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, knownBusinesses, leadContacts, leads, leadSources, type Db, type Job } from "@dleads/db";
import { ingestLead, upsertContacts, type IngestOutcome } from "../src/ingest.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";
import type { RawLead } from "../src/adapters/types.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5490);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function newJob(overrides: Partial<typeof jobs.$inferInsert> = {}): Promise<Job> {
  const [job] = await db
    .insert(jobs)
    .values({
      keywords: ["plumber"],
      locations: ["Austin, TX"],
      sources: ["osm"],
      maxItems: 25,
      ...overrides,
    })
    .returning();
  return job!;
}

const lead = (over: Partial<RawLead> = {}): RawLead => ({
  externalId: "n1",
  name: "Acme Plumbing",
  phone: "(512) 555-0142",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  website: "https://acmeplumbing.com",
  ...over,
});

async function rows<T extends typeof leads | typeof knownBusinesses>(table: T) {
  return db.select().from(table);
}

async function ingest(jobId: number, source: "osm" | "csv", raw: RawLead): Promise<IngestOutcome> {
  return ingestLead(db, { jobId, source, raw });
}

describe("ingestLead", () => {
  it("writes the lead, its ledger row and its source link", async () => {
    const job = await newJob();
    expect(await ingest(job.id, "osm", lead())).toBe("created");

    const [saved] = await db.select().from(leads);
    expect(saved).toMatchObject({
      jobId: job.id,
      source: "osm",
      name: "Acme Plumbing",
      nameKey: "acme plumbing",
      phone: "(512) 555-0142",
      phoneE164: "+15125550142",
      dedupKind: "p",
    });
    expect(saved?.dedupKey.startsWith("p:")).toBe(true);

    const [ledger] = await db.select().from(knownBusinesses);
    expect(ledger).toMatchObject({ kind: "p", leadId: saved?.id, jobId: job.id, websiteHost: "acmeplumbing.com" });
    expect(ledger?.externalIds).toEqual({ osm: "n1" });

    const links = await db.select().from(leadSources);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ leadId: saved?.id, source: "osm", externalId: "n1" });
  });

  it("skips a listing this job already collected", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead());
    expect(await ingest(job.id, "osm", lead({ name: "Acme Plumbing Renamed" }))).toBe("skipped");
    expect(await rows(leads)).toHaveLength(1);
    // The first spelling is the one on file, not the later payload.
    expect((await rows(leads))[0]?.name).toBe("Acme Plumbing");
  });

  it("joins a second source that shares the phone, and records both sources", async () => {
    const job = await newJob({ sources: ["osm", "csv"] });
    await ingest(job.id, "osm", lead());
    const outcome = await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r0", name: "Acme Plumbing LLC", phone: "1-512-555-0142", postalCode: null, website: null }),
    );
    expect(outcome).toBe("merged");

    const saved = await rows(leads);
    expect(saved).toHaveLength(1);
    const links = await db.select().from(leadSources);
    expect(links.map((l) => l.source).sort()).toEqual(["csv", "osm"]);
  });

  it("recognises the same business by name and postcode when the phone is missing", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead());
    const outcome = await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r0", phone: null, website: null, city: "AUSTIN" }),
    );
    expect(outcome).toBe("merged");
    expect(await rows(leads)).toHaveLength(1);
  });

  it("recognises it by website host when there is neither phone nor postcode", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead({ phone: null, postalCode: null }));
    const outcome = await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r0", phone: null, postalCode: null, city: null, region: null }),
    );
    // Both records key on name+host, so the exact key matches — the host alias is
    // what fires when only one of them published a phone.
    expect(outcome).toBe("merged");

    const other = await newJob();
    await ingest(other.id, "osm", lead({ phone: "+1 512 555 9999" }));
    expect(
      await ingest(other.id, "csv", lead({ externalId: "j2r0", phone: null, postalCode: null })),
    ).toBe("merged");
  });

  it("recognises a listing by its source id even when its details changed", async () => {
    const first = await newJob();
    await ingest(first.id, "osm", lead());
    const second = await newJob();
    const moved = lead({ phone: "+1 737 555 0100", website: "https://acme-plumbing-new-site.com" });
    expect(await ingest(second.id, "osm", moved)).toBe("merged");
    // Two jobs, one business: the ledger's `id` tier is exact and beats the tiers.
    expect(await rows(leads)).toHaveLength(1);
    expect(await rows(knownBusinesses)).toHaveLength(1);
  });

  it("never lets an `n:` key match across sources", async () => {
    const job = await newJob({ sources: ["osm", "csv"] });
    const bare = { externalId: "", phone: null, postalCode: null, website: null };
    expect(await ingest(job.id, "osm", lead(bare))).toBe("created");
    expect(await ingest(job.id, "csv", lead({ ...bare, externalId: "" }))).toBe("created");

    const saved = await rows(leads);
    expect(saved).toHaveLength(2);
    expect(saved.every((l) => l.dedupKind === "n")).toBe(true);
    // Two ledger rows, because the name is distinctive; the keys still differ by source.
    const ledger = await rows(knownBusinesses);
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((l) => l.dedupKey)).size).toBe(2);
  });

  it("keeps a generic name out of the ledger so it cannot join unrelated businesses", async () => {
    const generic = { externalId: "", name: "Plumbing Repair", phone: null, postalCode: null, website: null, city: "Austin", region: "TX" };
    const first = await newJob();
    expect(await ingest(first.id, "osm", generic)).toBe("created");
    const second = await newJob();
    expect(await ingest(second.id, "osm", generic)).toBe("created");

    expect(await rows(leads)).toHaveLength(2);
    expect(await rows(knownBusinesses)).toHaveLength(0);
  });

  it("fills blanks on a merge without overwriting what the user edited", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead({ website: null }));
    const [canonical] = await db.select().from(leads);
    await db
      .update(leads)
      .set({ status: "contacted", notes: "called, wants a quote in March" })
      .where(eq(leads.id, canonical!.id));

    const outcome = await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r0", name: "Acme Plumbing", phone: "+1 (512) 555-0142", website: "acmeplumbing.com" }),
    );
    expect(outcome).toBe("merged");

    const [after] = await db.select().from(leads);
    expect(after?.website).toBe("acmeplumbing.com");
    // The first record's spelling of the phone is the one on file, and the CRM's own
    // edits survive either way.
    expect(after?.phone).toBe("(512) 555-0142");
    expect(after?.status).toBe("contacted");
    expect(after?.notes).toBe("called, wants a quote in March");
    // The identity key stays whatever the first record established, so the ledger
    // never points at two rows for one business.
    expect(after?.dedupKind).toBe("p");
  });

  it("carries the directory's own emails into contacts and keeps them there", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead({ emails: ["dispatch@acmeplumbing.com"], socials: { instagram: "https://instagram.com/acmeplumb" } }));
    const [saved] = await db.select().from(leads);
    const stored = await db.select().from(leadContacts).where(eq(leadContacts.leadId, saved!.id));
    expect(stored[0]).toMatchObject({
      emails: ["dispatch@acmeplumbing.com"],
      emailSource: "profile",
      instagram: "https://instagram.com/acmeplumb",
    });

    // A later crawl that finds a different address must not replace the published one.
    await upsertContacts(db, saved!.id, ["webmaster@acmeplumbing.com"], { facebook: "https://facebook.com/acmeplumb" }, "website");
    const [after] = await db.select().from(leadContacts).where(eq(leadContacts.leadId, saved!.id));
    expect(after?.emails).toEqual(["dispatch@acmeplumbing.com"]);
    expect(after?.emailSource).toBe("profile");
    expect(after?.facebook).toBe("https://facebook.com/acmeplumb");
  });

  it("says an imported address came from your list, not from the directory", async () => {
    const job = await newJob({ sources: ["csv"] });
    await ingest(job.id, "csv", lead({ externalId: "j1r0", emails: ["bob@listed.com"] }));

    const [saved] = await db.select().from(leads);
    const [contacts] = await db
      .select()
      .from(leadContacts)
      .where(eq(leadContacts.leadId, saved!.id));
    expect(contacts?.emails).toEqual(["bob@listed.com"]);
    expect(contacts?.emailSource).toBe("import");
  });

  it("makes the email a merge brought in visible in contacts", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead({ emails: undefined }));
    await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r0", phone: "512-555-0142", emails: ["dispatch@acmeplumbing.com"] }),
    );

    const [saved] = await db.select().from(leads);
    const [contacts] = await db
      .select()
      .from(leadContacts)
      .where(eq(leadContacts.leadId, saved!.id));
    // The lead row keeps what each listing published, but contacts are what the
    // table and the CSV export read — an email that only reached the lead is an
    // email you cannot actually use.
    expect(contacts?.emails).toEqual(["dispatch@acmeplumbing.com"]);
    expect(contacts?.emailSource).toBe("import");
  });

  it("brings a second source's emails and details onto the lead it joins", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead({ emails: undefined }));
    expect(
      await ingest(
        job.id,
        "csv",
        lead({ externalId: "j1r0", phone: "512-555-0142", emails: ["dispatch@acmeplumbing.com"], address: "1 Main St" }),
      ),
    ).toBe("merged");

    const [after] = await db.select().from(leads);
    expect(after?.emailsFromProfile).toEqual(["dispatch@acmeplumbing.com"]);
    expect(after?.address).toBe("1 Main St");
    // An array cannot ride in a `coalesce`, so this is the guarded second statement
    // doing its job — and the first source's spelling of the phone is still on file.
    expect(after?.phone).toBe("(512) 555-0142");

    // A later merge must not replace the emails already on record.
    await ingest(
      job.id,
      "csv",
      lead({ externalId: "j1r5", phone: "512-555-0142", emails: ["someone-else@acmeplumbing.com"] }),
    );
    expect((await db.select().from(leads))[0]?.emailsFromProfile).toEqual(["dispatch@acmeplumbing.com"]);
  });

  it("reclaims its ledger row after the job that found it is deleted", async () => {
    const first = await newJob();
    await ingest(first.id, "osm", lead());
    const [original] = await db.select().from(knownBusinesses);
    // Deleting a job cascades to its leads; the ledger deliberately survives, so it
    // now points at a row that is gone.
    await db.delete(leads).where(eq(leads.jobId, first.id));

    const second = await newJob();
    expect(await ingest(second.id, "osm", lead())).toBe("created");

    const ledger = await db.select().from(knownBusinesses);
    expect(ledger).toHaveLength(1);
    const [reborn] = await db.select().from(leads);
    expect(ledger[0]?.leadId).toBe(reborn?.id);
    expect(ledger[0]?.jobId).toBe(second.id);
    // Same row, not a re-insert: `createdAt` was written when the business was known
    // only to the deleted job.
    expect(ledger[0]?.createdAt.getTime()).toBe(original?.createdAt.getTime());
  });

  it("leaves the ledger alone when a duplicate id arrives inside one job", async () => {
    const job = await newJob();
    await ingest(job.id, "osm", lead());
    expect(await ingest(job.id, "osm", lead())).toBe("skipped");
    expect(await rows(leads)).toHaveLength(1);
    expect(await rows(knownBusinesses)).toHaveLength(1);
    expect(await db.select().from(leadSources)).toHaveLength(1);
  });
});
