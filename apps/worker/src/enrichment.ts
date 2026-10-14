/**
 * The enrichment pass: take the websites the collect phase found, read each domain
 * once, and write what it publishes onto every lead that shares it.
 *
 * The domain — not the listing — owns the details, so a chain of five stores costs one
 * crawl, and `website_observations` makes that crawl cost nothing for the next job.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import {
  jobSourceStats,
  leads,
  websiteObservations,
  type Db,
  type EmailSource,
  type Lead,
  type Source,
  type WebsiteObservation,
} from "@dleads/db";
import {
  crawlSite,
  detailsFromPages,
  enrichConfig,
  hostOf,
  makeFetchPage,
  type EnrichConfig,
  type PageFetcher,
  type SiteDetails,
} from "./enrich.js";
import { upsertContacts } from "./ingest.js";
import { classifySocial, socialNetworks, type SocialNetwork } from "./socials.js";

/**
 * A directory's page *about* the business is not the business's website: crawling it
 * would visit a site whose terms forbid it instead of the lead's own pages.
 */
const NOT_A_BUSINESS_SITE = ["yelp.com", "yellowpages.com", "hotfrog.com", "google.com", "maps.google.com"];

export interface EnrichDeps {
  fetchPage?: PageFetcher;
  config?: Partial<EnrichConfig>;
  log?: (message: string) => void;
  /** Called after each host is finished; throws to stop the pass at a checkpoint. */
  checkpoint?: () => Promise<void>;
  progress?: (done: number, total: number) => Promise<void>;
}

export interface EnrichStats {
  hostsCrawled: number;
  hostsReused: number;
  leadsEnriched: number;
}

export async function enrichLeads(db: Db, jobId: number, deps: EnrichDeps = {}): Promise<EnrichStats> {
  const config = enrichConfig(deps.config);
  const fetchPage = deps.fetchPage ?? makeFetchPage(config);
  const log = deps.log ?? ((message: string) => console.log(`[enrich ${jobId}] ${message}`));

  const rows = await db.select().from(leads).where(and(eq(leads.jobId, jobId), eq(leads.enriched, false)));
  const byHost = groupByHost(rows);
  const total = byHost.size;

  const stats: EnrichStats = { hostsCrawled: 0, hostsReused: 0, leadsEnriched: 0 };
  const perSource = new Map<Source, number>();
  let done = 0;

  for (const [host, group] of byHost) {
    if (stats.hostsCrawled >= config.maxHosts) {
      log(`enrichment stopped at ${config.maxHosts} domains; ${total - done} not visited this run`);
      break;
    }

    const cached = await freshObservation(db, host, config.cacheDays);
    let details: SiteDetails;
    if (cached) {
      stats.hostsReused++;
      details = detailsFromObservation(cached);
    } else {
      const pages = await crawlSite(group[0]!.website!, fetchPage, config);
      details = detailsFromPages(pages);
      await recordObservation(db, host, details, pages.length);
      stats.hostsCrawled++;
    }

    for (const lead of group) {
      await applyDetails(db, lead, details);
      stats.leadsEnriched++;
      perSource.set(lead.source, (perSource.get(lead.source) ?? 0) + 1);
    }

    done++;
    await deps.progress?.(done, total);
    if (deps.checkpoint) await deps.checkpoint();
  }

  for (const [source, count] of perSource) await addEnriched(db, jobId, source, count);
  if (total) log(`${stats.leadsEnriched} leads from ${total} domains (${stats.hostsCrawled} crawled, ${stats.hostsReused} reused)`);
  return stats;
}

/** Leads that have a website worth crawling, in the order they were collected. */
function groupByHost(rows: Lead[]): Map<string, Lead[]> {
  const byHost = new Map<string, Lead[]>();
  for (const lead of rows) {
    const website = lead.website;
    if (!website || !isBusinessSite(website)) continue;
    const host = hostOf(website);
    if (!host) continue;
    const group = byHost.get(host);
    if (group) group.push(lead);
    else byHost.set(host, [lead]);
  }
  return byHost;
}

function isBusinessSite(website: string): boolean {
  if (classifySocial(website)) return false;
  const host = hostOf(website);
  if (!host) return false;
  return !NOT_A_BUSINESS_SITE.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

async function freshObservation(db: Db, host: string, cacheDays: number): Promise<WebsiteObservation | null> {
  const notBefore = new Date(Date.now() - cacheDays * 86_400_000);
  const [row] = await db
    .select()
    .from(websiteObservations)
    .where(and(eq(websiteObservations.host, host), gte(websiteObservations.checkedAt, notBefore)));
  return row ?? null;
}

function detailsFromObservation(row: WebsiteObservation): SiteDetails {
  const socials: Partial<Record<SocialNetwork, string>> = {};
  for (const network of socialNetworks) {
    const value = row.socials?.[network];
    if (typeof value === "string") socials[network] = value;
  }
  return { emails: row.emails ?? [], socials, phone: row.phone };
}

/** Even a site that answered nothing is recorded: the next job must not pay for it twice. */
async function recordObservation(db: Db, host: string, details: SiteDetails, pagesFetched: number): Promise<void> {
  const values = {
    host,
    emails: details.emails.length ? details.emails : null,
    socials: Object.keys(details.socials).length ? details.socials : null,
    phone: details.phone,
    pagesFetched,
    checkedAt: new Date(),
  };
  await db
    .insert(websiteObservations)
    .values(values)
    .onConflictDoUpdate({
      target: websiteObservations.host,
      // `excluded` is the row we just tried to insert, so a re-crawl overwrites the
      // stale observation with the fresh one instead of keeping the old details.
      set: {
        emails: sql`excluded.emails`,
        socials: sql`excluded.socials`,
        phone: sql`excluded.phone`,
        pagesFetched: sql`excluded.pages_fetched`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}

async function applyDetails(db: Db, lead: Lead, details: SiteDetails): Promise<void> {
  const fromProfile = lead.emailsFromProfile ?? [];
  const emails = [...new Set([...fromProfile, ...details.emails])];
  const source: EmailSource =
    fromProfile.length && details.emails.length ? "both" : fromProfile.length ? "profile" : "website";

  if (emails.length || Object.keys(details.socials).length) {
    await upsertContacts(db, lead.id, emails, details.socials, source);
  }
  // The listing's own number stays authoritative; the site's fills only a gap.
  if (!lead.phone && details.phone) {
    await db.update(leads).set({ phone: details.phone }).where(and(eq(leads.id, lead.id), sql`phone is null`));
  }
  await db.update(leads).set({ enriched: true }).where(eq(leads.id, lead.id));
}

async function addEnriched(db: Db, jobId: number, source: Source, count: number): Promise<void> {
  await db
    .insert(jobSourceStats)
    .values({ jobId, source, enriched: count })
    .onConflictDoUpdate({
      target: [jobSourceStats.jobId, jobSourceStats.source],
      set: { enriched: sql`${jobSourceStats.enriched} + ${count}` },
    });
}
