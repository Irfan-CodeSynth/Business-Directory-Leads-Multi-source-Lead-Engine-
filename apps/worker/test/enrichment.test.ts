import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  jobSourceStats,
  jobs,
  leadContacts,
  leads,
  websiteObservations,
  type Db,
  type Job,
  type Lead,
} from "@dleads/db";
import type { PageFetcher } from "../src/enrich.js";
import { enrichLeads } from "../src/enrichment.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5510);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** No waiting between pages in tests: the pacing is proved by the delay config itself. */
const fast = { delayMinMs: 0, delayMaxMs: 0 };

async function newJob(over: Partial<typeof jobs.$inferInsert> = {}): Promise<Job> {
  const [job] = await db
    .insert(jobs)
    .values({ keywords: ["plumber"], locations: ["Austin, TX"], sources: ["osm"], maxItems: 25, ...over })
    .returning();
  return job!;
}

async function newLead(jobId: number, over: Partial<typeof leads.$inferInsert> = {}): Promise<Lead> {
  const [lead] = await db
    .insert(leads)
    .values({
      jobId,
      name: "Acme Plumbing",
      nameKey: "acme plumbing",
      source: "osm",
      externalId: "n1",
      dedupKey: "n:osm:n1",
      dedupKind: "name",
      website: "https://acmeplumbing.com",
      ...over,
    })
    .returning();
  return lead!;
}

function site(pages: Record<string, string>) {
  const asked: string[] = [];
  const fetchPage: PageFetcher = async (url) => {
    asked.push(url);
    return pages[url] ?? null;
  };
  return { fetchPage, asked };
}

const contactsOf = async (leadId: number) => {
  const [row] = await db.select().from(leadContacts).where(eq(leadContacts.leadId, leadId));
  return row ?? null;
};

const observations = async () => db.select().from(websiteObservations);

describe("enrichLeads host cache", () => {
  it("crawls one domain once for three listings that share it", async () => {
    const job = await newJob();
    const a = await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a", website: "https://acmeplumbing.com" });
    const b = await newLead(job.id, {
      externalId: "b",
      dedupKey: "n:osm:b",
      website: "https://www.acmeplumbing.com/contact",
    });
    const c = await newLead(job.id, {
      externalId: "c",
      dedupKey: "n:osm:c",
      website: "https://acmeplumbing.com/services/plumbing",
    });
    const { fetchPage, asked } = site({
      "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>",
      "https://acmeplumbing.com/contact":
        '<a href="https://www.instagram.com/acmeplumbing/?igsh=tracking">ig</a>',
    });

    const stats = await enrichLeads(db, job.id, { fetchPage, config: fast });

    // Three leads, one website: three pages asked for, not nine.
    expect(asked).toEqual([
      "https://acmeplumbing.com",
      "https://acmeplumbing.com/contact",
      "https://acmeplumbing.com/about",
    ]);
    expect(stats).toMatchObject({ hostsCrawled: 1, hostsReused: 0, leadsEnriched: 3 });

    for (const lead of [a, b, c]) {
      const row = await contactsOf(lead.id);
      expect(row?.emails).toEqual(["office@acmeplumbing.com"]);
      expect(row?.emailSource).toBe("website");
      expect(row?.instagram).toBe("https://www.instagram.com/acmeplumbing");
    }

    const cached = await observations();
    expect(cached).toHaveLength(1);
    expect(cached[0]!.host).toBe("acmeplumbing.com");
    expect(cached[0]!.pagesFetched).toBe(2); // three pages asked for, two of them existed
  });

  it("gives the next job the same details without asking the site again", async () => {
    const first = await newJob();
    await newLead(first.id, { website: "https://acmeplumbing.com" });
    const crawl = site({
      "https://acmeplumbing.com": `<a href="mailto:office@acmeplumbing.com">o</a><script type="application/ld+json">${JSON.stringify(
        { "@type": "LocalBusiness", telephone: "+1 512 555 0142" },
      )}</script>`,
    });
    await enrichLeads(db, first.id, { fetchPage: crawl.fetchPage, config: fast });

    const second = await newJob();
    const lead = await newLead(second.id, { externalId: "b", dedupKey: "n:osm:b" });
    const rerun = site({});

    const stats = await enrichLeads(db, second.id, { fetchPage: rerun.fetchPage, config: fast });

    expect(rerun.asked).toEqual([]);
    expect(stats).toMatchObject({ hostsCrawled: 0, hostsReused: 1, leadsEnriched: 1 });
    expect((await contactsOf(lead.id))?.emails).toEqual(["office@acmeplumbing.com"]);
    // A replayed cache row must be as good as the crawl it replaced.
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0]!.phone).toBe("+1 512 555 0142");
  });

  it("does not treat a social profile as the business's own website", async () => {
    const job = await newJob();
    const lead = await newLead(job.id, { website: "https://www.facebook.com/acmeplumbing" });
    const { fetchPage, asked } = site({ "https://www.facebook.com/acmeplumbing": "<p>no</p>" });

    const stats = await enrichLeads(db, job.id, { fetchPage, config: fast });

    expect(asked).toEqual([]);
    expect(stats.hostsCrawled).toBe(0);
    expect((await contactsOf(lead.id))).toBeNull();
    expect(await observations()).toHaveLength(0);
  });

  it("remembers a site that answered nothing, so the next job spends nothing on it", async () => {
    const job = await newJob();
    const lead = await newLead(job.id);
    const dead = site({});

    const stats = await enrichLeads(db, job.id, { fetchPage: dead.fetchPage, config: fast });
    expect(stats.hostsCrawled).toBe(1);
    const [row] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.enriched).toBe(true);
    expect(await contactsOf(lead.id)).toBeNull();

    const rerun = await newJob();
    await newLead(rerun.id, { externalId: "b", dedupKey: "n:osm:b" });
    const second = site({});
    expect((await enrichLeads(db, rerun.id, { fetchPage: second.fetchPage, config: fast })).hostsReused).toBe(1);
    expect(second.asked).toEqual([]);
  });

  it("looks again once a cached observation is older than the cache window", async () => {
    const job = await newJob();
    await newLead(job.id);
    const crawl = site({ "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>" });
    await enrichLeads(db, job.id, { fetchPage: crawl.fetchPage, config: fast });

    const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await db.update(websiteObservations).set({ checkedAt: stale }).where(eq(websiteObservations.host, "acmeplumbing.com"));

    const next = await newJob();
    await newLead(next.id, { externalId: "b", dedupKey: "n:osm:b" });
    const rerun = site({ "https://acmeplumbing.com": "<p>new@acmeplumbing.com</p>" });
    const stats = await enrichLeads(db, next.id, { fetchPage: rerun.fetchPage, config: fast });

    expect(stats.hostsCrawled).toBe(1);
    expect(rerun.asked[0]).toBe("https://acmeplumbing.com");
    const [cached] = await observations();
    expect(cached!.emails).toEqual(["new@acmeplumbing.com"]);
  });

  it("crawls at most maxHosts domains for one job", async () => {
    const job = await newJob();
    await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a", website: "https://one.com" });
    await newLead(job.id, { externalId: "b", dedupKey: "n:osm:b", website: "https://two.com" });
    const { fetchPage, asked } = site({
      "https://one.com": "<p>hi@one.com</p>",
      "https://two.com": "<p>hi@two.com</p>",
    });

    const stats = await enrichLeads(db, job.id, { fetchPage, config: { ...fast, maxHosts: 1 } });

    expect(asked).toEqual(["https://one.com", "https://one.com/contact", "https://one.com/about"]);
    expect(stats).toMatchObject({ hostsCrawled: 1, leadsEnriched: 1 });
    const rows = await db.select().from(leads).where(eq(leads.jobId, job.id));
    expect(rows.find((r) => r.externalId === "b")!.enriched).toBe(false);
  });

  it("keeps the profile's own email first and labels the pair as both", async () => {
    const job = await newJob();
    const lead = await newLead(job.id);
    await db.update(leads).set({ emailsFromProfile: ["listing@directory.example"] }).where(eq(leads.id, lead.id));
    const { fetchPage } = site({ "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>" });

    await enrichLeads(db, job.id, { fetchPage, config: fast });

    const row = await contactsOf(lead.id);
    expect(row?.emails).toEqual(["listing@directory.example", "office@acmeplumbing.com"]);
    expect(row?.emailSource).toBe("both");
  });

  it("records how many leads it enriched under the lead's own source", async () => {
    const job = await newJob({ sources: ["osm", "csv"] });
    await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a", website: "https://one.com" });
    await newLead(job.id, { externalId: "b", dedupKey: "n:osm:b", source: "csv", website: "https://two.com" });
    const { fetchPage } = site({ "https://one.com": "<p>hi@one.com</p>", "https://two.com": "<p>hi@two.com</p>" });

    await enrichLeads(db, job.id, { fetchPage, config: fast });

    const rows = await db.select().from(jobSourceStats).where(eq(jobSourceStats.jobId, job.id));
    expect(rows.find((r) => r.source === "osm")!.enriched).toBe(1);
    expect(rows.find((r) => r.source === "csv")!.enriched).toBe(1);
  });

  it("stops at a checkpoint with the hosts it already paid for kept", async () => {
    const job = await newJob();
    await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a", website: "https://one.com" });
    await newLead(job.id, { externalId: "b", dedupKey: "n:osm:b", website: "https://two.com" });
    const { fetchPage, asked } = site({ "https://one.com": "<p>hi@one.com</p>", "https://two.com": "<p>hi@two.com</p>" });
    let checkpoints = 0;

    await expect(
      enrichLeads(db, job.id, {
        fetchPage,
        config: fast,
        checkpoint: async () => {
          if (++checkpoints === 1) throw new Error("stop here");
        },
      }),
    ).rejects.toThrow("stop here");

    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => url.startsWith("https://one.com"))).toBe(true);
    const rows = await db.select().from(leads).where(eq(leads.jobId, job.id));
    expect(rows.find((r) => r.externalId === "a")!.enriched).toBe(true);
    expect(rows.find((r) => r.externalId === "b")!.enriched).toBe(false);
  });

  it("fills a missing phone from the site's own markup and leaves a listing's number alone", async () => {
    const job = await newJob();
    const blank = await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a" });
    const taken = await newLead(job.id, { externalId: "b", dedupKey: "n:osm:b", phone: "(512) 555-0199" });
    const { fetchPage } = site({
      "https://acmeplumbing.com": `<script type="application/ld+json">${JSON.stringify({
        "@type": "LocalBusiness",
        telephone: "+1 512 555 0142",
      })}</script>`,
    });

    await enrichLeads(db, job.id, { fetchPage, config: fast });

    const rows = await db.select().from(leads).where(eq(leads.jobId, job.id));
    expect(rows.find((r) => r.id === blank.id)!.phone).toBe("+1 512 555 0142");
    expect(rows.find((r) => r.id === taken.id)!.phone).toBe("(512) 555-0199");
  });

  it("does nothing at all when enrichment is switched off", async () => {
    const job = await newJob();
    await newLead(job.id);
    const { fetchPage, asked } = site({ "https://acmeplumbing.com": "<p>office@acmeplumbing.com</p>" });
    process.env.ENRICH_ENABLED = "false";

    try {
      const stats = await enrichLeads(db, job.id, { fetchPage, config: fast });
      expect(stats).toMatchObject({ hostsCrawled: 0, hostsReused: 0, leadsEnriched: 0 });
      expect(asked).toEqual([]);
      expect(await observations()).toHaveLength(0);
    } finally {
      delete process.env.ENRICH_ENABLED;
    }

    const [row] = await db.select().from(leads).where(eq(leads.jobId, job.id));
    expect(row!.enriched).toBe(false);
  });

  it("reports progress once per host, against the number of hosts it found", async () => {
    const job = await newJob();
    await newLead(job.id, { externalId: "a", dedupKey: "n:osm:a", website: "https://one.com" });
    await newLead(job.id, { externalId: "b", dedupKey: "n:osm:b", website: "https://two.com" });
    const { fetchPage } = site({ "https://one.com": "<p>hi@one.com</p>", "https://two.com": "<p>hi@two.com</p>" });
    const seen: [number, number][] = [];

    await enrichLeads(db, job.id, {
      fetchPage,
      config: fast,
      progress: async (done, total) => {
        seen.push([done, total]);
      },
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
