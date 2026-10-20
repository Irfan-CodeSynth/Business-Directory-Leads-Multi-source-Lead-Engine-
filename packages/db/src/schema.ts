import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  real,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import type { SearchSpec } from "./search.js";

/**
 * Source ids are plain text columns with TS-only enum typing, so adding a source
 * later (a licensed Yelp driver) needs no migration.
 */
export const sources = ["osm", "csv", "yelp", "hotfrog"] as const;
export type Source = (typeof sources)[number];

/**
 * Sources that bill for every result they hand back, so they share one monthly
 * spend cap (`APIFY_MONTHLY_RESULT_CAP`). `job_source_stats.results_pulled` counts
 * them; `osm` and `csv` cost nothing and are not in this list.
 */
export const paidSources = ["yelp", "hotfrog"] as const;
export type PaidSource = (typeof paidSources)[number];

export const jobStatus = ["pending", "running", "done", "error", "cancelled"] as const;
export const jobPhase = ["collecting", "enriching"] as const;
/** `blocked` is a normal outcome for a rate-limited source and never fails the job. */
export const sourceStatus = ["pending", "running", "done", "blocked", "error", "cancelled"] as const;
export const leadStatus = ["new", "contacted", "replied", "won", "lost"] as const;
export const emailSources = ["profile", "website", "import", "both"] as const;
export type EmailSource = (typeof emailSources)[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    keywords: text("keywords").array().notNull(),
    locations: text("locations").array().notNull(),
    /**
     * Structured single-search spec written by the New run form (one keyword,
     * category, country, state, city). When set, the worker runs one structured
     * search per source and ignores the keyword x location matrix; when null the
     * legacy matrix path runs, so old queued jobs are untouched.
     */
    searchSpec: jsonb("search_spec").$type<SearchSpec | null>(),
    sources: text("sources", { enum: sources }).array().notNull(),
    /** Cap per keyword x location x source. Keeps free-tier runs modest by design. */
    maxItems: integer("max_items").notNull().default(25),
    /**
     * New leads one source should add before the run stops. Counted as leads this run
     * actually created, so a listing already in the ledger does not eat the target.
     */
    leadTarget: integer("lead_target").notNull().default(100),
    /** Rows for a `csv` job, kept on the job so the run is replayable. */
    importRows: jsonb("import_rows").$type<Record<string, string>[] | null>(),
    importLabel: text("import_label"),
    status: text("status", { enum: jobStatus }).notNull().default("pending"),
    phase: text("phase", { enum: jobPhase }),
    phaseTotal: integer("phase_total"),
    phaseDone: integer("phase_done"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    errorMsg: text("error_msg"),
    leadsFound: integer("leads_found").notNull().default(0),
    leadsSkipped: integer("leads_skipped").notNull().default(0),
    leadsMerged: integer("leads_merged").notNull().default(0),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_status_idx").on(t.status)],
);

/**
 * One row per (job, source). A source that gets rate-limited is marked `blocked`
 * here while the job still finishes `done`, which is what makes "Re-run blocked
 * sources only" possible instead of re-running everything.
 */
export const jobSourceStats = pgTable(
  "job_source_stats",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    source: text("source", { enum: sources }).notNull(),
    status: text("status", { enum: sourceStatus }).notNull().default("pending"),
    found: integer("found").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    merged: integer("merged").notNull().default(0),
    enriched: integer("enriched").notNull().default(0),
    requestsUsed: integer("requests_used").notNull().default(0),
    /**
     * Results the source returned, including the ones dedup skipped or merged. For a
     * paid source that is what the invoice is calculated from, so the monthly cap
     * counts it — and unlike the per-run counters above it is never zeroed, because a
     * re-run that pulls the same listings again really does cost again.
     */
    resultsPulled: integer("results_pulled").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("job_source_stats_uniq").on(t.jobId, t.source)],
);

export const leads = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Normalised name used by the dedup tiers; also handy for search. */
    nameKey: text("name_key").notNull(),
    source: text("source", { enum: sources }).notNull(),
    externalId: text("external_id").notNull(),
    profileUrl: text("profile_url"),
    dedupKey: text("dedup_key").notNull(),
    dedupKind: text("dedup_kind").notNull(),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    address: text("address"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    website: text("website"),
    category: text("category"),
    rating: real("rating"),
    reviewCount: integer("review_count"),
    /** Emails published by the directory itself, before any website crawl. */
    emailsFromProfile: text("emails_from_profile").array(),
    /** Raw source payload (OSM tags for `osm`, mapped row for `csv`). */
    extra: jsonb("extra").$type<Record<string, unknown>>(),
    status: text("status", { enum: leadStatus }).notNull().default("new"),
    notes: text("notes"),
    enriched: boolean("enriched").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("leads_job_source_external_uniq").on(t.jobId, t.source, t.externalId),
    index("leads_job_idx").on(t.jobId),
    index("leads_status_idx").on(t.status),
    index("leads_source_idx").on(t.source),
    index("leads_dedup_key_idx").on(t.dedupKey),
    index("leads_phone_e164_idx").on(t.phoneE164),
  ],
);

/**
 * The cross-source, cross-job ledger. Deliberately no FKs: a business stays known
 * after its job is deleted, and pruning cross-job duplicates would otherwise
 * cascade into CRM status/notes.
 *
 * The primary key is whichever tier this row could produce for itself; the alias
 * columns are how a *different* source recognises the same business.
 */
export const knownBusinesses = pgTable(
  "known_businesses",
  {
    dedupKey: text("dedup_key").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key"),
    source: text("source", { enum: sources }).notNull(),
    /** Every source-specific id ever seen for this business. */
    externalIds: jsonb("external_ids").$type<Record<string, string>>().notNull().default({}),
    profileUrl: text("profile_url"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    postalCode: text("postal_code"),
    cityKey: text("city_key"),
    websiteHost: text("website_host"),
    /** False for short/chain-style names: those must not join across sources. */
    ledgerEligible: boolean("ledger_eligible").notNull().default(true),
    leadId: integer("lead_id").notNull(),
    jobId: integer("job_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("known_phone_idx").on(t.phoneE164),
    index("known_name_zip_idx").on(t.nameKey, t.postalCode),
    index("known_host_idx").on(t.websiteHost),
    index("known_city_idx").on(t.cityKey),
  ],
);

/** Which sources a lead appeared on: backs the "found on 2 sources" badge. */
export const leadSources = pgTable(
  "lead_sources",
  {
    leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    source: text("source", { enum: sources }).notNull(),
    externalId: text("external_id").notNull(),
    profileUrl: text("profile_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lead_sources_uniq").on(t.leadId, t.source)],
);

export const leadContacts = pgTable("lead_contacts", {
  leadId: integer("lead_id").primaryKey().references(() => leads.id, { onDelete: "cascade" }),
  emails: text("emails").array(),
  /** Where the emails came from, so the UI can mark how trustworthy they are. */
  emailSource: text("email_source", { enum: emailSources }),
  instagram: text("instagram"),
  facebook: text("facebook"),
  linkedin: text("linkedin"),
  twitter: text("twitter"),
  youtube: text("youtube"),
  tiktok: text("tiktok"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Host-level crawl cache. Chains post many listings sharing one domain, and the
 * contact details live on the domain, not per listing — so one crawl serves them all.
 */
export const websiteObservations = pgTable("website_observations", {
  host: text("host").primaryKey(),
  emails: text("emails").array(),
  socials: jsonb("socials").$type<Record<string, string>>(),
  /** The number the site published in its own markup, so a replay matches a re-crawl. */
  phone: text("phone"),
  pagesFetched: integer("pages_fetched").notNull().default(0),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-row heartbeat. Replaces the Maps Leads `wakeWorker()` ping: the worker runs
 * on the user's machine, so there is no sleeping service to wake — the dashboard just
 * shows whether a worker is currently polling this database.
 */
export const workerStatus = pgTable("worker_status", {
  id: integer("id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  currentJobId: integer("current_job_id"),
  version: text("version"),
});

export type Job = typeof jobs.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type LeadContact = typeof leadContacts.$inferSelect;
export type LeadSourceRow = typeof leadSources.$inferSelect;
export type User = typeof users.$inferSelect;
export type KnownBusiness = typeof knownBusinesses.$inferSelect;
export type JobSourceStat = typeof jobSourceStats.$inferSelect;
export type WebsiteObservation = typeof websiteObservations.$inferSelect;
