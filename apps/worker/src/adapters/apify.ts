import type { PaidSource } from "@dleads/db";
import {
  BlockedError,
  BudgetExhaustedError,
  sleep,
  type RawLead,
  type RequestBudget,
  type ResultSpend,
  type SearchArgs,
  type SearchHooks,
  type SearchOutcome,
  type SourceAdapter,
} from "./types.js";

/**
 * Paid directories, through one driver.
 *
 * Both sources are Apify Actors — a licensed third party does the collecting, we pay
 * per result and never touch Yelp's or HotFrog's login walls or robots.txt ourselves:
 *
 *   Yelp     `memo23/yelp-scraper`    $2.75 per 1,000 results
 *   HotFrog  `solidcode/hotfrog-scraper` $2.50 per 1,000 results
 *
 * One work unit is one Actor run plus one read of the dataset it wrote. The run is
 * started with `POST /v2/acts/<slug>/runs`, which can hold the connection open for up to
 * 60 s (`waitForFinish`) and otherwise leaves us polling `GET /v2/acts/<slug>/runs/<id>`
 * until it reaches a terminal state; only then is `GET /v2/datasets/<id>/items?clean=true`
 * worth asking. Slugs are spelled `user~actor` in the API path, so the `/` an env override
 * is written with is translated here.
 *
 * Two things this driver promises, and the tests hold it to both:
 * - **No review text, ever.** Every review-shaped field is dropped before a lead is
 *   built, so customer words cannot reach the database or an export. Ratings and review
 *   *counts* stay: they describe the business, not a person.
 * - **No surprise bill.** The Actor is asked for no more results than the month allows,
 *   and the month is charged for every result it returned — including the ones dedup
 *   discarded, because those were billed too.
 *
 * Field names come from the two Actors' published output examples; the first live run
 * is what confirms them.
 */

export interface ApifyConfig {
  token: string;
  baseUrl: string;
  yelpActor: string;
  hotfrogActor: string;
  country: string;
  runTimeoutS: number;
  pollIntervalMs: number;
}

function positiveInt(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function apifyConfig(): ApifyConfig {
  return {
    token: (process.env.APIFY_API_TOKEN ?? "").trim(),
    baseUrl: (process.env.APIFY_BASE_URL ?? "https://api.apify.com/v2").trim().replace(/\/+$/, ""),
    yelpActor: (process.env.APIFY_YELP_ACTOR ?? "memo23/yelp-scraper").trim(),
    hotfrogActor: (process.env.APIFY_HOTFROG_ACTOR ?? "solidcode/hotfrog-scraper").trim(),
    country: (process.env.APIFY_COUNTRY ?? "us").trim(),
    runTimeoutS: positiveInt("APIFY_RUN_TIMEOUT_S", 300),
    pollIntervalMs: positiveInt("APIFY_POLL_INTERVAL_MS", 5000),
  };
}

/** One dataset row, in whatever names this month's Actor version chose. */
export interface ApifyItem {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure: item -> RawLead
// ---------------------------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function firstStr(item: ApifyItem, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = str(item[key]);
    if (value) return value;
  }
  return null;
}

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** `"1,204 reviews"` is what the Yelp Actor publishes; the column wants a number. */
export function countValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const digits = (typeof value === "string" ? value : "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/** `["Plumbing", {title: "Hydro Jetting"}]` or `"Plumbing"`. */
function firstCategory(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = typeof entry === "string" ? entry : (entry as { title?: unknown })?.title;
      const text = str(name);
      if (text) return text;
    }
    return null;
  }
  return str(value);
}

const EMAIL = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function emailsFrom(value: unknown): string[] {
  const raw = str(value) ?? "";
  const out = new Set<string>();
  for (const part of raw.split(/[;,\s]+/)) {
    const email = part.trim().replace(/^mailto:/i, "").toLowerCase();
    if (EMAIL.test(email)) out.add(email);
  }
  return [...out];
}

const NETWORKS: Record<string, string> = {
  facebook: "facebook",
  fb: "facebook",
  instagram: "instagram",
  linkedin: "linkedin",
  pinterest: "pinterest",
  tiktok: "tiktok",
  twitter: "twitter",
  x: "twitter",
  youtube: "youtube",
};

/** Which network a url belongs to, by host: `https://x.com/acme` is Twitter/X. */
function networkOf(url: string): string | null {
  for (const [needle, name] of [
    ["facebook.com", "facebook"],
    ["fb.com", "facebook"],
    ["instagram.com", "instagram"],
    ["linkedin.com", "linkedin"],
    ["pinterest.com", "pinterest"],
    ["tiktok.com", "tiktok"],
    ["twitter.com", "twitter"],
    ["x.com", "twitter"],
    ["youtu.be", "youtube"],
    ["youtube.com", "youtube"],
  ] as const) {
    if (url.toLowerCase().includes(needle)) return name;
  }
  return null;
}

/** Bare `instagram.com/acme` is still a profile; "not a url" is not. */
function profileUrl(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, "");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(value)) return `https://${value}`;
  return null;
}

/** `socialLinks` is an object in some listings and a list of urls in others. */
export function socialsFrom(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: string | null, url: string | null) => {
    if (name && url) out[name] = url;
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = typeof entry === "string" ? entry : (entry as { url?: unknown })?.url;
      const text = typeof url === "string" ? profileUrl(url) : null;
      add(text ? networkOf(text) : null, text);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const url = typeof raw === "string" ? profileUrl(raw) : null;
      const named = NETWORKS[key.toLowerCase().replace(/[^a-z]/g, "")];
      add(named ?? (url ? networkOf(url) : null), url);
    }
  }
  return out;
}

/**
 * Anything that could carry a customer's words. `reviewCount` deliberately does not
 * match: a number is not a review.
 */
const REVIEW_KEY = /^(reviews?|reviewhighlights?|review_?insights?|review_?(text|body|content)|pain_?points?|painpointanalysis)$/i;

export function stripReviews(item: ApifyItem): ApifyItem {
  const out: ApifyItem = {};
  for (const [key, value] of Object.entries(item)) {
    if (!REVIEW_KEY.test(key)) out[key] = value;
  }
  return out;
}

/** Yelp publishes an id, HotFrog does not; the listing url is the next best thing. */
function externalIdOf(source: PaidSource, item: ApifyItem, name: string, phone: string | null): string {
  const id = firstStr(item, "yelp_biz_id", "business_id", "businessId", "place_id");
  const url = firstStr(item, "url", "profile_url", "link");
  return `${source}:${id ?? url ?? `${name.toLowerCase()}|${phone ?? ""}`}`;
}

/** `null` for a row that is not a business: nothing to key on and nobody to call. */
export function itemToLead(source: PaidSource, item: ApifyItem): RawLead | null {
  const name = firstStr(item, "title", "name", "business_name", "company");
  if (!name) return null;

  const phone = firstStr(item, "phone", "phoneNumber", "phone1", "telephone");
  const emails = emailsFrom(
    source === "hotfrog"
      ? firstStr(item, "email", "emails") ?? undefined
      : firstStr(item, "contactEmail", "email", "emails") ?? undefined,
  );

  return {
    externalId: externalIdOf(source, item, name, phone),
    name,
    phone,
    website: firstStr(item, "website", "url_website", "webSite"),
    profileUrl: firstStr(item, "url", "profile_url", "link"),
    address: firstStr(item, "streetAddress", "fullAddress", "address", "street", "address1"),
    city: firstStr(item, "city"),
    region: firstStr(item, "state", "region", "province"),
    postalCode: firstStr(item, "zipcode", "zip", "postalCode", "postal_code"),
    category: firstCategory(item.categories) ?? firstStr(item, "category", "type", "industry"),
    rating: num(item.rating ?? item.stars),
    reviewCount: countValue(item.reviewCount ?? item.review_count ?? item.numReviews),
    emails,
    socials: socialsFrom(item.socialLinks ?? item.socials),
    extra: stripReviews(item),
  };
}

// ---------------------------------------------------------------------------
// Pure: work unit -> Actor input
// ---------------------------------------------------------------------------

const actorFor = (source: PaidSource, cfg: ApifyConfig) =>
  source === "yelp" ? cfg.yelpActor : cfg.hotfrogActor;

/** Ask for no more than the month still allows; `remaining` is `Infinity` when uncapped. */
const bounded = (maxItems: number, remaining: number) =>
  Math.max(1, Math.min(maxItems, Number.isFinite(remaining) ? Math.floor(remaining) : maxItems));

/**
 * Names worth translating, in lower case, to the ISO 3166-1 alpha-2 codes HotFrog's Actor
 * accepts. Anything already two letters goes through untouched, so a code this table has
 * never heard of is still the Actor's to reject — but a name that is not listed here stops
 * the run, because guessing a country would bill for the wrong one's businesses.
 */
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "us",
  usa: "us",
  america: "us",
  "united kingdom": "gb",
  uk: "gb",
  england: "gb",
  australia: "au",
  canada: "ca",
  ireland: "ie",
  "new zealand": "nz",
  germany: "de",
  france: "fr",
  spain: "es",
  italy: "it",
  netherlands: "nl",
  austria: "at",
  switzerland: "ch",
  denmark: "dk",
  norway: "no",
  poland: "pl",
  portugal: "pt",
  india: "in",
  singapore: "sg",
  malaysia: "my",
  "south africa": "za",
  brazil: "br",
  mexico: "mx",
  argentina: "ar",
  japan: "jp",
  philippines: "ph",
};

/** `United States` -> `us`; `Wakanda` -> null. Case and spacing do not matter. */
export function toCountryCode(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(text)) return text;
  return COUNTRY_NAMES[text] ?? null;
}

export function buildActorInput(
  source: PaidSource,
  args: SearchArgs,
  remaining: number,
  cfg: ApifyConfig,
): Record<string, unknown> {
  const maxItems = bounded(args.maxItems, remaining);
  if (source === "yelp") {
    return {
      searchTerms: [args.keyword],
      searchLocation: args.location,
      maxItems,
      // Every paid extra that is not a contact detail stays off: reviews are the
      // expensive ones and the only ones we may not keep.
      scrapeReviews: false,
      reviewInsights: false,
      painPointAnalysis: false,
      enrichEmails: false,
      fetchBusinessDetails: true,
    };
  }
  const country = toCountryCode(cfg.country);
  if (!country) {
    throw new Error(
      `${source}: APIFY_COUNTRY "${cfg.country}" is not a country this Actor accepts — use its two-letter code (us, gb, in, au, ca, …)`,
    );
  }
  return {
    searchTerms: [args.keyword],
    locations: [args.location],
    country,
    maxResults: maxItems,
    includeDetails: true,
  };
}

// ---------------------------------------------------------------------------
// Pure: API envelopes
// ---------------------------------------------------------------------------

/** The dataset endpoint answers with an array, or with `{data: [...]}` when paginated. */
export function parseDatasetItems(payload: unknown): ApifyItem[] {
  const value = typeof payload === "string" ? tryJson(payload) : payload;
  const list = Array.isArray(value) ? value : (value as { data?: unknown } | null)?.data;
  return Array.isArray(list) ? list.filter((entry): entry is ApifyItem => Boolean(entry) && typeof entry === "object") : [];
}

/** A run object, with or without the `data` envelope that wraps most API responses. */
export function parseRun(payload: unknown): { runId: string | null; datasetId: string | null; status: string | null } {
  const value = typeof payload === "string" ? tryJson(payload) : payload;
  const run = (value as { data?: unknown } | null)?.data ?? value;
  const record = (run ?? {}) as Record<string, unknown>;
  return {
    runId: str(record.id ?? record.runId),
    datasetId: str(record.defaultDatasetId ?? record.datasetId),
    status: str(record.status),
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Apify's own words about a failure, which are always better than ours. */
function apiReason(body: string): string {
  const parsed = tryJson(body) as { error?: { message?: unknown; type?: unknown } } | null;
  const reason = str(parsed?.error?.message) ?? str(parsed?.error?.type);
  return reason ?? body.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Only these four are a "come back later" refusal. Everything else is a mistake we
 * made — a wrong actor slug, no token in the URL, a run that failed — and an `error`
 * badge is more honest than a `blocked` one that promises a retry will help.
 */
const REFUSALS: Record<number, string> = {
  401: "Apify rejected this token",
  402: "this Apify account has no credit left (top it up, or wait for the 1st)",
  403: "this Apify account may not run this actor",
  429: "Apify rate limited this account",
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

interface HttpResponse {
  status: number;
  body: string;
}

export interface ApifyAdapterOptions {
  source: PaidSource;
  config?: ApifyConfig;
  /** Results still allowed this month, shared by every paid source in the job. */
  spend: ResultSpend;
  fetch?: typeof fetch;
  /** Overridable so a test can watch a long run without waiting through it. */
  sleep?: (ms: number) => Promise<void>;
}

/** A run in one of these is going to answer again. Anything else is final. */
const PENDING = new Set(["NEW", "READY", "RUNNING"]);

export function createApifyAdapter(options: ApifyAdapterOptions): SourceAdapter {
  const source = options.source;
  const fetchFn = options.fetch ?? fetch;
  const nap = options.sleep ?? sleep;

  async function send(url: string, init: Parameters<typeof fetch>[1], budget: RequestBudget): Promise<HttpResponse> {
    if (budget.exhausted()) throw new BudgetExhaustedError(`${source}: request budget exhausted`);
    budget.charge();
    const res = await fetchFn(url, init);
    return { status: res.status, body: await res.text() };
  }

  async function request(cfg: ApifyConfig, url: string, init: Parameters<typeof fetch>[1], budget: RequestBudget, label: string) {
    const headers = { authorization: `Bearer ${cfg.token}`, accept: "application/json" };
    const res = await send(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }, budget);
    const refusal = REFUSALS[res.status];
    if (refusal) {
      throw new BlockedError(source, `${source} ${label}: ${refusal} — ${apiReason(res.body)}`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${source} ${label}: HTTP ${res.status} — ${apiReason(res.body)}`);
    }
    return res;
  }

  return {
    source,

    async search(args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
      const cfg = options.config ?? apifyConfig();
      const spend = options.spend;
      let emitted = 0;
      let stopped = false;

      // Whitespace is what an unfilled `.env` line leaves behind.
      if (!cfg.token.trim()) {
        throw new Error(`${source}: APIFY_API_TOKEN is not set — add it to .env (Apify console, Settings > API tokens)`);
      }
      const allowed = spend.remaining();
      if (allowed <= 0) {
        hooks.log(`${source}: monthly Apify result cap already reached; no request sent`);
        return { emitted, requestsUsed: hooks.budget.spent(), stopped };
      }

      const slug = actorFor(source, cfg).replace("/", "~");
      const actorPath = `${cfg.baseUrl}/acts/${encodeURIComponent(slug)}`;
      const label = `${slug} "${args.keyword}" in ${args.location}`;
      // `timeout` is how long Apify lets the run take before killing it; `waitForFinish`
      // is how long it will hold *this* connection open to answer us, and 60 s is its
      // ceiling. A slower run is polled for afterwards.
      const waitS = Math.max(1, Math.min(60, Math.floor(cfg.runTimeoutS)));
      const run = await request(
        cfg,
        `${actorPath}/runs?timeout=${cfg.runTimeoutS}&waitForFinish=${waitS}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildActorInput(source, args, allowed, cfg)),
        },
        hooks.budget,
        `run ${label}`,
      );

      let { runId, datasetId, status } = parseRun(run.body);
      // Every answer costs a request, so the wait is capped at APIFY_RUN_TIMEOUT_S worth
      // of them. Past that the Actor is still running on Apify's clock and a re-run of the
      // source is cheaper than an idle worker.
      let pollsLeft = Math.ceil((cfg.runTimeoutS * 1000) / cfg.pollIntervalMs);
      while (runId && status && PENDING.has(status) && pollsLeft-- > 0) {
        if (hooks.shouldStop()) {
          stopped = true;
          break;
        }
        await nap(cfg.pollIntervalMs);
        const answered = await request(
          cfg,
          `${actorPath}/runs/${encodeURIComponent(runId)}`,
          { method: "GET" },
          hooks.budget,
          `run ${label}`,
        );
        const next = parseRun(answered.body);
        runId = next.runId ?? runId;
        datasetId = next.datasetId ?? datasetId;
        status = next.status ?? status;
      }
      if (stopped) return { emitted, requestsUsed: hooks.budget.spent(), stopped };
      if (status && status !== "SUCCEEDED") {
        const why =
          status === "TIMED-OUT"
            ? " (raise APIFY_RUN_TIMEOUT_S or lower max items)"
            : PENDING.has(status)
              ? ` — still running after ${cfg.runTimeoutS}s; re-run this source, or raise APIFY_RUN_TIMEOUT_S`
              : "";
        throw new Error(`${source} ${label}: run ${status}${why}`);
      }
      if (!datasetId) throw new Error(`${source} ${label}: the run returned no dataset`);

      const items = await request(
        cfg,
        `${cfg.baseUrl}/datasets/${encodeURIComponent(datasetId)}/items?clean=true`,
        { method: "GET" },
        hooks.budget,
        `dataset ${datasetId}`,
      );

      const results = parseDatasetItems(items.body);
      // Billed for everything the Actor returned, even the rows it oversupplied past
      // the cap or that turned out not to be businesses.
      spend.charge(results.length);

      let dropped = 0;
      for (const item of results) {
        if (emitted >= args.maxItems || emitted >= allowed) break;
        if (hooks.shouldStop()) {
          stopped = true;
          break;
        }
        const lead = itemToLead(source, item);
        if (!lead) {
          dropped++;
          continue;
        }
        await hooks.emit(lead);
        emitted++;
      }
      if (dropped > 0) hooks.log(`${source}: ignored ${dropped} row(s) that were not businesses`);
      if (results.length > allowed) {
        hooks.log(`${source}: returned ${results.length} results with ${allowed} left in the monthly cap; kept ${emitted}`);
      }
      return { emitted, requestsUsed: hooks.budget.spent(), stopped };
    },
  };
}
