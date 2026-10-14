import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  dedupKeyFor,
  knownBusinesses,
  leadContacts,
  leadSources,
  leads,
  type Db,
  type DedupFields,
  type Source,
} from "@dleads/db";
import type { RawLead } from "./adapters/types.js";

/**
 * The write path. One `leads` row per business per job, plus a cross-job ledger so
 * the same business found from another source joins the row we already have rather
 * than becoming a second lead.
 *
 * `created` — new to this job and new to the ledger.
 * `merged`  — the ledger already knew it: attach the source, fill blanks, no new row.
 * `skipped` — this exact (job, source, external id) was already collected.
 */
export type IngestOutcome = "created" | "merged" | "skipped";

/** The pool or an open transaction: everything here is query-shaped, not connection-shaped. */
export type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface LedgerLookup {
  /** Which identity tier produced this query; `id` is exact, the rest are aliases. */
  tier: "id" | "key" | DedupFields["kind"];
  where: SQL;
}

/**
 * Identity is settled by the source's own id first, because that one is exact. Only
 * then the tiers this lead could have produced for itself — the same order
 * `dedupKeyFor` uses, so a lead keyed by phone is recognised by phone.
 *
 * `x:` and `n:` keys embed their source, so the exact-key lookup already stops them
 * matching across sources; they need no alias query.
 */
export function ledgerLookups(
  source: string,
  externalId: string | null | undefined,
  f: DedupFields,
): LedgerLookup[] {
  const lookups: LedgerLookup[] = [];
  const id = (externalId ?? "").trim();
  if (id) {
    lookups.push({ tier: "id", where: sql`${knownBusinesses.externalIds} ->> ${source} = ${id}` });
  }
  lookups.push({ tier: "key", where: eq(knownBusinesses.dedupKey, f.key) });
  if (f.phoneE164) {
    lookups.push({
      tier: "p",
      where: and(
        eq(knownBusinesses.phoneE164, f.phoneE164),
        eq(knownBusinesses.nameKey, f.nameKey),
      ) as SQL,
    });
  }
  if (f.postalCode) {
    lookups.push({
      tier: "z",
      where: and(eq(knownBusinesses.nameKey, f.nameKey), eq(knownBusinesses.postalCode, f.postalCode)) as SQL,
    });
  }
  if (f.websiteHost) {
    lookups.push({
      tier: "w",
      where: and(eq(knownBusinesses.nameKey, f.nameKey), eq(knownBusinesses.websiteHost, f.websiteHost)) as SQL,
    });
  }
  return lookups;
}

export interface LedgerMatch {
  leadId: number;
  jobId: number;
  tier: LedgerLookup["tier"];
}

/** The first ledger row that recognises this business, in tier order. */
export async function findLedgerMatch(
  store: Store,
  source: string,
  externalId: string | null | undefined,
  fields: DedupFields,
): Promise<LedgerMatch | null> {
  for (const lookup of ledgerLookups(source, externalId, fields)) {
    // The join is what makes job deletion safe: the ledger has no FK on purpose, so
    // a row whose lead was deleted must never be matched — otherwise the merge would
    // write a source link against a lead that no longer exists.
    const [row] = await store
      .select({ leadId: knownBusinesses.leadId, jobId: knownBusinesses.jobId })
      .from(knownBusinesses)
      .innerJoin(leads, eq(leads.id, knownBusinesses.leadId))
      .where(lookup.where)
      .limit(1);
    if (row) return { leadId: row.leadId, jobId: row.jobId, tier: lookup.tier };
  }
  return null;
}

export function identityOf(raw: RawLead, source: string): DedupFields {
  return dedupKeyFor({
    name: raw.name,
    phone: raw.phone,
    postalCode: raw.postalCode,
    city: raw.city,
    region: raw.region,
    website: raw.website,
    source,
    externalId: raw.externalId,
  });
}

/**
 * Only ever fills what is still blank: a lead edited in the CRM (status, notes) or
 * enriched from its website must not be overwritten by a second, thinner record of
 * the same business.
 */
async function fillBlanks(store: Store, leadId: number, raw: RawLead, fields: DedupFields): Promise<void> {
  await store
    .update(leads)
    .set({
      phone: sql`coalesce(${leads.phone}, ${raw.phone ?? null})`,
      phoneE164: sql`coalesce(${leads.phoneE164}, ${fields.phoneE164})`,
      profileUrl: sql`coalesce(${leads.profileUrl}, ${raw.profileUrl ?? null})`,
      address: sql`coalesce(${leads.address}, ${raw.address ?? null})`,
      city: sql`coalesce(${leads.city}, ${raw.city ?? null})`,
      region: sql`coalesce(${leads.region}, ${raw.region ?? null})`,
      postalCode: sql`coalesce(${leads.postalCode}, ${raw.postalCode ?? null})`,
      website: sql`coalesce(${leads.website}, ${raw.website ?? null})`,
      category: sql`coalesce(${leads.category}, ${raw.category ?? null})`,
      rating: sql`coalesce(${leads.rating}, ${raw.rating ?? null})`,
      reviewCount: sql`coalesce(${leads.reviewCount}, ${raw.reviewCount ?? null})`,
    })
    .where(eq(leads.id, leadId));

  // An array cannot be a `coalesce` parameter — the driver binds a JS list as a
  // record, and Postgres rejects it with "COALESCE types text[] and record cannot be
  // matched". A second, guarded statement fills it instead.
  if (raw.emails?.length) {
    await store
      .update(leads)
      .set({ emailsFromProfile: raw.emails })
      .where(and(eq(leads.id, leadId), isNull(leads.emailsFromProfile)));
  }
}

/** Contacts live beside the lead, never inside it, so enrichment can improve them freely. */
export async function upsertContacts(
  store: Store,
  leadId: number,
  emails: string[],
  socials: Record<string, string>,
  emailSource: "profile" | "website" | "import" | "both",
): Promise<void> {
  const values = {
    leadId,
    emails: emails.length ? emails : null,
    emailSource: emails.length ? emailSource : null,
    instagram: socials.instagram ?? null,
    facebook: socials.facebook ?? null,
    linkedin: socials.linkedin ?? null,
    twitter: socials.twitter ?? null,
    youtube: socials.youtube ?? null,
    tiktok: socials.tiktok ?? null,
  };
  const hasEmail = sql`${leadContacts.emails} is not null and cardinality(${leadContacts.emails}) > 0`;
  await store
    .insert(leadContacts)
    .values(values)
    .onConflictDoUpdate({
      target: leadContacts.leadId,
      set: {
        // Whichever side published an email first keeps it; the directory's own
        // address outranks a crawl, so a later crawl must not replace it.
        emails: sql`case when ${hasEmail} then ${leadContacts.emails} else excluded.emails end`,
        emailSource: sql`case when ${hasEmail} then ${leadContacts.emailSource} else excluded.email_source end`,
        instagram: sql`coalesce(${leadContacts.instagram}, excluded.instagram)`,
        facebook: sql`coalesce(${leadContacts.facebook}, excluded.facebook)`,
        linkedin: sql`coalesce(${leadContacts.linkedin}, excluded.linkedin)`,
        twitter: sql`coalesce(${leadContacts.twitter}, excluded.twitter)`,
        youtube: sql`coalesce(${leadContacts.youtube}, excluded.youtube)`,
        tiktok: sql`coalesce(${leadContacts.tiktok}, excluded.tiktok)`,
        updatedAt: sql`now()`,
      },
    });
}

/** `lead_sources` is what the UI's "found on 2 sources" badge reads. */
export async function attachSource(store: Store, leadId: number, source: Source, raw: RawLead): Promise<void> {
  await store
    .insert(leadSources)
    .values({ leadId, source, externalId: raw.externalId, profileUrl: raw.profileUrl ?? null })
    .onConflictDoUpdate({
      target: [leadSources.leadId, leadSources.source],
      set: {
        externalId: raw.externalId,
        profileUrl: sql`coalesce(${leadSources.profileUrl}, excluded.profile_url)`,
      },
    });
}

/**
 * A merge must teach the ledger this source's id too, so the next run recognises
 * the listing by id instead of falling through to the alias tiers again.
 */
async function extendLedger(
  store: Store,
  leadId: number,
  source: Source,
  raw: RawLead,
  fields: DedupFields,
): Promise<void> {
  await store
    .update(knownBusinesses)
    .set({
      // `jsonb_build_object` is variadic "any", so an untyped parameter cannot be
      // resolved — the casts are required, not cosmetic.
      externalIds: sql`${knownBusinesses.externalIds} || jsonb_build_object(${source}::text, ${raw.externalId}::text)`,
      phone: sql`coalesce(${knownBusinesses.phone}, ${raw.phone ?? null})`,
      phoneE164: sql`coalesce(${knownBusinesses.phoneE164}, ${fields.phoneE164})`,
      postalCode: sql`coalesce(${knownBusinesses.postalCode}, ${fields.postalCode})`,
      cityKey: sql`coalesce(${knownBusinesses.cityKey}, ${fields.cityKey})`,
      websiteHost: sql`coalesce(${knownBusinesses.websiteHost}, ${fields.websiteHost})`,
      profileUrl: sql`coalesce(${knownBusinesses.profileUrl}, ${raw.profileUrl ?? null})`,
    })
    .where(eq(knownBusinesses.leadId, leadId));
}

/** How the UI should credit an address the listing itself carried. */
function emailSourceOf(source: Source): "import" | "profile" {
  return source === "csv" ? "import" : "profile";
}

/** Records one collected business. Returns what happened so the caller can count it. */
export async function ingestLead(
  db: Db,
  args: { jobId: number; source: Source; raw: RawLead },
): Promise<IngestOutcome> {
  const { jobId, source, raw } = args;
  const fields = identityOf(raw, source);

  return db.transaction(async (tx) => {
    const [alreadyCollected] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.jobId, jobId), eq(leads.source, source), eq(leads.externalId, raw.externalId)))
      .limit(1);
    if (alreadyCollected) return "skipped";

    const match = await findLedgerMatch(tx, source, raw.externalId, fields);
    if (match) {
      await fillBlanks(tx, match.leadId, raw, fields);
      await attachSource(tx, match.leadId, source, raw);
      await extendLedger(tx, match.leadId, source, raw, fields);
      // The lead it joins may have no contact row yet, and the table + export read
      // contacts, so this listing's emails have to land there too.
      if (raw.emails?.length || raw.socials) {
        await upsertContacts(tx, match.leadId, raw.emails ?? [], raw.socials ?? {}, emailSourceOf(source));
      }
      return "merged";
    }

    const [created] = await tx
      .insert(leads)
      .values({
        jobId,
        source,
        externalId: raw.externalId,
        name: raw.name,
        nameKey: fields.nameKey,
        dedupKey: fields.key,
        dedupKind: fields.kind,
        profileUrl: raw.profileUrl ?? null,
        phone: raw.phone ?? null,
        phoneE164: fields.phoneE164,
        address: raw.address ?? null,
        city: raw.city ?? null,
        region: raw.region ?? null,
        postalCode: raw.postalCode ?? null,
        website: raw.website ?? null,
        category: raw.category ?? null,
        rating: raw.rating ?? null,
        reviewCount: raw.reviewCount ?? null,
        emailsFromProfile: raw.emails?.length ? raw.emails : null,
        extra: raw.extra ?? null,
      })
      // The unique index is the last guard against two runs of one job racing.
      .onConflictDoNothing({ target: [leads.jobId, leads.source, leads.externalId] })
      .returning({ id: leads.id });
    if (!created) return "skipped";

    await attachSource(tx, created.id, source, raw);
    if (raw.emails?.length || raw.socials) {
      await upsertContacts(tx, created.id, raw.emails ?? [], raw.socials ?? {}, emailSourceOf(source));
    }
    // A generic or single-token name is not distinctive enough to join across
    // sources, so it never enters the ledger: it stays a lead of this job only.
    if (fields.ledgerEligible) {
      const identity = {
        name: raw.name,
        nameKey: fields.nameKey,
        profileUrl: raw.profileUrl ?? null,
        phone: raw.phone ?? null,
        phoneE164: fields.phoneE164,
        postalCode: fields.postalCode,
        cityKey: fields.cityKey,
        websiteHost: fields.websiteHost,
      };
      await tx
        .insert(knownBusinesses)
        .values({
          dedupKey: fields.key,
          kind: fields.kind,
          ...identity,
          source,
          externalIds: { [source]: raw.externalId },
          ledgerEligible: true,
          leadId: created.id,
          jobId,
        })
        // The ledger row is only as good as the lead it points at, so a business
        // whose job was deleted reclaims its own row here and starts following the
        // new lead instead.
        .onConflictDoUpdate({
          target: knownBusinesses.dedupKey,
          set: { ...identity, leadId: created.id, jobId },
        });
    }
    return "created";
  });
}
