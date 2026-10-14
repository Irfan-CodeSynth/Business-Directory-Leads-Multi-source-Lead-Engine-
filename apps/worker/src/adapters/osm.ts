import type {
  RawLead,
  RequestBudget,
  SearchArgs,
  SearchHooks,
  SearchOutcome,
  SourceAdapter,
} from "./types.js";
import { BlockedError, BudgetExhaustedError } from "./types.js";

/**
 * OpenStreetMap driver: Nominatim turns a location into a bounding box, Overpass
 * collects the businesses inside it. Both are free public services with a fair-use
 * policy of about one request per second, so every request goes through
 * `politeRequest`, which spaces requests out per host and backs off.
 *
 * The search is bounded by a box rather than an Overpass `area()`: measured against
 * the live instance, an `area()`-scoped query returned HTTP 504 after 8-15 s while
 * the identical clause as a box query answered in about 3 s. A box over-collects at
 * the edges of a concave region, so `placeName` filters results that carry an
 * explicit `addr:city` for somewhere else.
 *
 * Everything above the "Network" section is pure and unit-tested against the
 * fixtures in `test/fixtures/osm/` — `npm test` makes no request.
 */

const OVERPASS_TIMEOUT_S = 45;

/** A place *node* has no extent of its own, so the box is grown to cover the settlement. */
const PLACE_RADIUS_DEG: Record<string, number> = {
  county: 0.45,
  state: 0.35,
  region: 0.35,
  city: 0.14,
  borough: 0.1,
  municipality: 0.1,
  town: 0.07,
  village: 0.035,
  suburb: 0.02,
  neighbourhood: 0.02,
  quarter: 0.02,
  hamlet: 0.02,
};
const DEFAULT_RADIUS_DEG = 0.02;

/**
 * Settlement-level matches: their `addr:city` can be checked against the name the
 * user typed. County/state matches are deliberately excluded — a county contains
 * many cities, and filtering them away would empty the result set.
 */
const SETTLEMENT_TYPES = new Set([
  "borough",
  "city",
  "city_district",
  "hamlet",
  "municipality",
  "neighbourhood",
  "quarter",
  "suburb",
  "town",
  "village",
]);

/** Beyond this a single query would sweep a whole state, so only the centre is searched. */
const MAX_SPAN = { lat: 0.9, lon: 1.2 };

/** OSM keys whose value names the business type, in priority order for `category`. */
const TYPE_KEYS = [
  "healthcare",
  "amenity",
  "shop",
  "craft",
  "office",
  "tourism",
  "leisure",
  "emergency",
] as const;

/**
 * Keyword → OSM tag filters. Service trades are tagged inconsistently (an "HVAC
 * contractor" is usually only findable by name), so `selectorsForKeyword` always
 * adds a name pattern on top of these.
 */
const KEYWORD_TAGS: Record<string, string[]> = {
  plumber: ['["craft"="plumber"]', '["service"="plumber"]'],
  electrician: ['["craft"="electrician"]', '["service"="electrician"]'],
  carpenter: ['["craft"="carpenter"]', '["shop"="carpenter"]'],
  roofer: ['["craft"="roofer"]'],
  roofing: ['["craft"="roofer"]'],
  painter: ['["craft"="painter"]', '["shop"="painter"]'],
  handyman: ['["craft"="handyman"]'],
  locksmith: ['["craft"="locksmith"]', '["shop"="locksmith"]'],
  cleaning: ['["craft"="cleaning"]', '["service"="cleaning"]'],
  landscaping: ['["craft"="landscaping"]', '["shop"="garden_centre"]'],
  "tree service": ['["craft"="tree_surgeon"]'],
  moving: ['["office"="moving_company"]'],
  contractor: ['["craft"="construction"]'],
  construction: ['["craft"="construction"]'],
  windows: ['["shop"="glaziery"]', '["craft"="glaziery"]'],
  dentist: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
  dental: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
  orthodontist: ['["healthcare:speciality"="orthodontics"]', '["amenity"="dentist"]'],
  chiropractor: ['["healthcare"="chiropractic"]', '["amenity"="doctors"]'],
  dermatologist: ['["healthcare:speciality"="dermatology"]', '["amenity"="doctors"]'],
  doctor: ['["amenity"="doctors"]', '["healthcare"="doctor"]'],
  physiotherapist: ['["healthcare"="physiotherapist"]'],
  optician: ['["shop"="optician"]', '["healthcare"="optician"]'],
  pharmacy: ['["amenity"="pharmacy"]', '["shop"="pharmacy"]'],
  veterinary: ['["amenity"="veterinary"]'],
  vet: ['["amenity"="veterinary"]'],
  lawyer: ['["office"="lawyer"]'],
  attorney: ['["office"="lawyer"]'],
  "real estate": ['["office"="estate_agent"]', '["amenity"="estate_agent"]'],
  "property management": ['["office"="property_management"]'],
  accounting: ['["office"="accountant"]'],
  insurance: ['["office"="insurance_agent"]'],
  salon: ['["shop"="beauty"]', '["shop"="hairdresser"]', '["leisure"="spa"]'],
  barber: ['["shop"="barber"]', '["shop"="hairdresser"]'],
  spa: ['["leisure"="spa"]', '["tourism"="spa"]'],
  gym: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]'],
  "car repair": ['["shop"="car_repair"]', '["amenity"="car_repair"]'],
  mechanic: ['["shop"="car_repair"]'],
  "car wash": ['["shop"="car_wash"]', '["amenity"="car_wash"]'],
  "gas station": ['["amenity"="fuel"]'],
  tyre: ['["shop"="tyres"]'],
  tire: ['["shop"="tyres"]'],
  restaurant: ['["amenity"="restaurant"]', '["amenity"="fast_food"]'],
  cafe: ['["amenity"="cafe"]'],
  coffee: ['["amenity"="cafe"]', '["shop"="coffee"]'],
  bakery: ['["shop"="bakery"]'],
  bar: ['["amenity"="bar"]', '["amenity"="pub"]'],
  hotel: ['["tourism"="hotel"]', '["tourism"="guest_house"]'],
  grocery: ['["shop"="supermarket"]', '["shop"="grocery"]', '["shop"="convenience"]'],
  florist: ['["shop"="florist"]'],
  "pet store": ['["shop"="pet"]'],
  groomer: ['["shop"="pet_grooming"]'],
  laundry: ['["amenity"="laundry"]', '["shop"="laundry"]', '["craft"="laundry"]'],
  printing: ['["shop"="print"]', '["craft"="printing"]'],
  printer: ['["shop"="print"]', '["craft"="printing"]'],
  "web design": ['["office"="it"]', '["shop"="computer"]'],
  marketing: ['["office"="advertising_agency"]'],
  agency: ['["office"="advertising_agency"]'],
  bank: ['["amenity"="bank"]'],
  storage: ['["shop"="storage_rental"]'],
  "self storage": ['["shop"="storage_rental"]'],
  wedding: ['["shop"="wedding"]'],
  photography: ['["shop"="photo"]', '["craft"="photographer"]'],
  school: ['["amenity"="school"]', '["amenity"="language_school"]'],
  daycare: ['["amenity"="childcare"]', '["amenity"="kindergarten"]'],
};

/** Words that describe the search rather than the business. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "co",
  "companies",
  "company",
  "in",
  "me",
  "near",
  "of",
  "services",
  "service",
  "shop",
  "shops",
  "solutions",
  "store",
  "stores",
  "the",
]);

const SOCIAL_KEYS: Record<string, string> = {
  facebook: "facebook",
  instagram: "instagram",
  linkedin: "linkedin",
  pinterest: "pinterest",
  tiktok: "tiktok",
  twitter: "twitter",
  x: "twitter",
  youtube: "youtube",
};

// ---------------------------------------------------------------------------
// Pure: location → search plan
// ---------------------------------------------------------------------------

export interface NominatimHit {
  osm_id?: number;
  osm_type?: string;
  /** jsonv2 calls this `class`; `category` appears in some deployments. */
  category?: string;
  class?: string;
  type?: string;
  /** For boundaries Nominatim reports the settlement class here, not in `type`. */
  addresstype?: string;
  lat?: string;
  lon?: string;
  /** jsonv2 order is [south, north, west, east], as strings. */
  boundingbox?: string[];
  display_name?: string;
  address?: { city?: string; town?: string; village?: string; suburb?: string };
}

export interface Box {
  s: number;
  w: number;
  n: number;
  e: number;
}

export interface ResolvedArea {
  box: Box;
  label: string;
  /** Settlement name to trust `addr:city` against, or null when it would mislead. */
  placeName: string | null;
  /** Set when the matched area was too large to search in one courtesy query. */
  note?: string;
}

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

function squareBox(lat: number, lon: number, radius: number): Box {
  return { s: lat - radius, n: lat + radius, w: lon - radius, e: lon + radius };
}

function rawBox(hit: NominatimHit, fallbackRadius: number): Box | null {
  const bb = hit.boundingbox;
  if (Array.isArray(bb) && bb.length === 4) {
    const [s, n, w, e] = bb.map(num);
    if (s != null && n != null && w != null && e != null && n >= s && e >= w) return { s, w, n, e };
  }
  const lat = num(hit.lat);
  const lon = num(hit.lon);
  return lat != null && lon != null ? squareBox(lat, lon, fallbackRadius) : null;
}

/** A box this small is a point, not the extent of the place the user typed. */
function isThin(box: Box): boolean {
  return box.n - box.s < 0.01 || box.e - box.w < 0.01;
}

function clampBox(box: Box): { box: Box; clamped: boolean } {
  const latSpan = Math.min(box.n - box.s, MAX_SPAN.lat);
  const lonSpan = Math.min(box.e - box.w, MAX_SPAN.lon);
  const clamped = latSpan < box.n - box.s || lonSpan < box.e - box.w;
  const lat = (box.s + box.n) / 2;
  const lon = (box.w + box.e) / 2;
  return {
    box: {
      s: lat - latSpan / 2,
      n: lat + latSpan / 2,
      w: lon - lonSpan / 2,
      e: lon + lonSpan / 2,
    },
    clamped,
  };
}

const round6 = (box: Box): Box => ({
  s: Number(box.s.toFixed(6)),
  w: Number(box.w.toFixed(6)),
  n: Number(box.n.toFixed(6)),
  e: Number(box.e.toFixed(6)),
});

/**
 * Restrict an Overpass query to a geocoded location. Nominatim's bounding box is
 * used for every match type, grown to a plausible radius when it only returned a
 * point for a named settlement.
 */
export function planFromNominatim(hit: NominatimHit): ResolvedArea | null {
  const label = (hit.display_name ?? "").trim();
  const type = (hit.type ?? "").toLowerCase();
  // An Austin *boundary* is typed "administrative"; its settlement class is only
  // in `addresstype`, so trust that first when naming the place to filter by.
  const placeKind = ((hit.addresstype ?? hit.type) ?? "").toLowerCase();
  const radius = PLACE_RADIUS_DEG[type] ?? PLACE_RADIUS_DEG[placeKind] ?? DEFAULT_RADIUS_DEG;
  const box = rawBox(hit, radius);
  if (box == null) return null;

  const klass = (hit.category ?? hit.class ?? "").toLowerCase();
  const areaLike = klass === "place" || klass === "postal_code";
  const grown =
    areaLike && isThin(box)
      ? squareBox((box.s + box.n) / 2, (box.w + box.e) / 2, radius)
      : box;
  const { box: final, clamped } = clampBox(grown);

  return {
    box: round6(final),
    label,
    placeName: SETTLEMENT_TYPES.has(placeKind) ? settlementName(hit) : null,
    ...(clamped
      ? {
          note: `matched area exceeds the courtesy cap; searched its centre (${MAX_SPAN.lat}x${MAX_SPAN.lon} deg) instead`,
        }
      : {}),
  };
}

/** Prefer Nominatim's structured address; fall back to the first display segment. */
function settlementName(hit: NominatimHit): string | null {
  const structured =
    hit.address?.city || hit.address?.town || hit.address?.village || hit.address?.suburb;
  const name = (structured || (hit.display_name ?? "").split(",")[0] || "").trim();
  return name.length > 2 ? name : null;
}

/** "St. Louis" vs "st louis"; either name containing the other counts as the same city. */
export function cityMatches(found: string, target: string): boolean {
  const norm = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const a = norm(found);
  const b = norm(target);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * A bounding box spills past concave borders, so a business that tags itself into
 * another city is dropped. Most OSM businesses carry no `addr:city` at all, so
 * only a contradiction counts — silence never filters.
 */
export function outsidePlace(city: string | null | undefined, placeName: string | null): boolean {
  if (placeName == null || city == null || city.length === 0) return false;
  return !cityMatches(city, placeName);
}

// ---------------------------------------------------------------------------
// Pure: keyword → Overpass query
// ---------------------------------------------------------------------------

const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** "plumbers" → plumber/plumb, "dentist" → dentists/dentist… so names match too. */
function wordVariants(word: string): string[] {
  const out = new Set<string>();
  const push = (w: string) => {
    if (w.length >= 4) out.add(w);
  };
  push(word);
  if (word.endsWith("ies")) push(word.slice(0, -3) + "y");
  if (word.endsWith("es") && word.length > 4) push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) push(word.slice(0, -1));
  for (const suffix of ["ists", "ist", "ers", "er", "ors", "or", "ings", "ing", "ery"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      push(word.slice(0, -suffix.length));
      break;
    }
  }
  return [...out];
}

/**
 * Tag filters plus a `name` pattern. OSM tagging alone misses most service
 * businesses, because a plumbing van is usually only tagged by its name.
 */
export function selectorsForKeyword(keyword: string): string[] {
  const normalised = keyword
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return [];

  const selectors = new Set<string>();
  // Look up the whole phrase, then each word: "dental clinic" should still hit
  // the dentist tags even though the phrase itself is not in the table.
  const words = normalised.split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  for (const lookup of [normalised, ...words]) {
    for (const filter of KEYWORD_TAGS[lookup] ?? []) selectors.add(filter);
  }

  // A single word may be an OSM value verbatim ("dentist", "bakery"): let the
  // server match it on every type key. Overpass unions these in one request.
  if (words.length === 1) {
    for (const key of TYPE_KEYS) selectors.add(`[${quote(key)}=${quote(words[0])}]`);
  }

  const patterns = new Set<string>();
  for (const word of words) for (const variant of wordVariants(word)) patterns.add(variant);
  // The literal phrase only when every word described the business: searching
  // names for "plumber services" would match nothing, while "plumb" matches plenty.
  if (words.length > 1 && words.join(" ") === normalised) patterns.add(normalised);

  if (patterns.size > 0) {
    const alternation = [...patterns]
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length)
      .join("|");
    selectors.add(`["name"~${quote(alternation)},i]`);
  }

  return [...selectors];
}

/** Ask for more raw elements than needed: unnamed and abandoned ones get dropped. */
export function overpassCap(maxItems: number): number {
  const cap = Number.isFinite(maxItems) ? Math.trunc(maxItems) : 25;
  return Math.min(Math.max(cap * 3, 30), 500);
}

export function buildOverpassQuery(box: Box, selectors: string[], cap: number): string {
  if (selectors.length === 0) throw new Error("no selectors");
  const where = `(${box.s},${box.w},${box.n},${box.e})`;
  const body = selectors.map((selector) => `  nwr${selector}${where};`).join("\n");
  return (
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n` +
    `(\n${body}\n);\n` +
    `out tags center ${Math.trunc(cap)};`
  );
}

// ---------------------------------------------------------------------------
// Pure: Overpass elements → RawLead
// ---------------------------------------------------------------------------

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
  error?: string;
}

export function isRateLimitedText(body: string): boolean {
  return /rate.?limit|too many requests|retry after|blocked for|quota exceeded/i.test(body);
}

export type Failure =
  | { ok: true }
  | { ok: false; kind: "rate_limited" | "transient" | "fatal"; status: number };

/** `ok: true` means the body is usable JSON, even at an unexpected status. */
export function classifyFailure(status: number, body: string): Failure {
  if (status >= 200 && status < 300 && !isRateLimitedText(body)) return { ok: true };
  // 403 is how Nominatim throttles; 429/503 are Overpass. All recoverable later.
  if (status === 429 || status === 403 || status === 503 || isRateLimitedText(body)) {
    return { ok: false, kind: "rate_limited", status };
  }
  if (status >= 500 || status === 0 || /timed out|internal server error|bad gateway|service unavailable/i.test(body)) {
    // status 0 is politeRequest's marker for "no response at all".
    return { ok: false, kind: "transient", status };
  }
  // 400 = our query text is wrong; retrying it cannot help.
  return { ok: false, kind: "fatal", status };
}

/** `Retry-After` as seconds or an HTTP date; null when absent or unparseable. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function firstTag(tags: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** `shop=car_repair` reads better as a lead category than as a tag value. */
function humaniseTag(value: string): string {
  return value.replace(/[_:]+/g, " ").replace(/\s+/g, " ").trim();
}

/** OSM social tags are occasionally bare domains ("instagram.com/acme"). */
export function normaliseProfileUrl(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, "");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(value)) return `https://${value}`;
  return null;
}

function socialsFrom(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const bare = key.replace(/^(contact|social_media):/i, "").toLowerCase();
    const name = SOCIAL_KEYS[bare];
    if (!name) continue;
    const urlish = normaliseProfileUrl(value);
    if (urlish) out[name] = urlish;
  }
  return out;
}

/** `email` tags carry `mailto:` prefixes and sometimes several addresses. */
export function emailsFrom(tags: Record<string, string>): string[] {
  const raw = firstTag(tags, ["email", "contact:email"]) ?? "";
  const out = new Set<string>();
  for (const part of raw.split(/[;,\s]+/)) {
    const value = part.trim().replace(/^mailto:/i, "").toLowerCase();
    if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) out.add(value);
  }
  return [...out];
}

/** Street line only; city/state/postcode are stored in their own columns. */
function streetLine(tags: Record<string, string>): string | null {
  const full = tags["addr:full"]?.trim();
  if (full) return full;
  const line = [tags["addr:housenumber"], tags["addr:street"]]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return line || null;
}

/**
 * Named geography, not a company: a name-pattern search for "plumb" also returns
 * Plumbago Drive. These keys only appear on features nobody can call.
 */
export function isFeature(tags: Record<string, string>): boolean {
  return (
    tags.highway != null ||
    tags.waterway != null ||
    tags.railway != null ||
    tags.aeroway != null ||
    tags.natural != null ||
    tags.place != null
  );
}

export function elementToLead(el: OverpassElement): RawLead | null {
  const tags = el.tags;
  if (!tags || typeof tags !== "object") return null;
  // A closed premise is not a lead.
  if (tags.abandoned || tags.disused) return null;
  if (isFeature(tags)) return null;

  const name = tags.name?.trim();
  // No name means nothing to key on and nobody to call.
  if (name == null || name.length < 2) return null;

  const categoryKey = TYPE_KEYS.find((key) => tags[key]?.trim());
  const lat = num(el.lat ?? el.center?.lat);
  const lon = num(el.lon ?? el.center?.lon);

  return {
    externalId: `${el.type.slice(0, 1)}${el.id}`,
    name,
    phone: firstTag(tags, ["phone", "contact:phone", "phone:mobile", "contact:mobile"]),
    website: firstTag(tags, ["website", "contact:website", "url"]),
    profileUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    address: streetLine(tags),
    city: firstTag(tags, ["addr:city", "addr:place"]),
    region: firstTag(tags, ["addr:state", "addr:province", "addr:region"]),
    postalCode: firstTag(tags, ["addr:postcode", "addr:postal_code"]),
    category: categoryKey ? humaniseTag(tags[categoryKey] as string) : null,
    rating: null,
    reviewCount: null,
    emails: emailsFrom(tags),
    socials: socialsFrom(tags),
    extra: {
      osmType: el.type,
      osmId: el.id,
      ...(lat != null && lon != null ? { lat, lon } : {}),
      tags,
    },
  };
}

export function parseOverpassLeads(payload: unknown): {
  leads: RawLead[];
  droppedUnnamed: number;
  droppedClosed: number;
  droppedFeature: number;
} {
  const elements = Array.isArray((payload as OverpassResponse)?.elements)
    ? ((payload as OverpassResponse).elements as OverpassElement[])
    : [];
  const leads: RawLead[] = [];
  let droppedUnnamed = 0;
  let droppedClosed = 0;
  let droppedFeature = 0;

  for (const el of elements) {
    if (!el || typeof el.id !== "number" || typeof el.type !== "string") continue;
    const lead = elementToLead(el);
    if (lead) {
      leads.push(lead);
      continue;
    }
    const tags = el.tags;
    if (tags && (tags.abandoned || tags.disused)) droppedClosed++;
    else if (tags && isFeature(tags)) droppedFeature++;
    else droppedUnnamed++;
  }
  return { leads, droppedUnnamed, droppedClosed, droppedFeature };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface OsmConfig {
  userAgent: string;
  overpassEndpoint: string;
  nominatimEndpoint: string;
  delayMinMs: number;
  delayMaxMs: number;
  rateLimitRetryMs: number;
  transientRetryMs: number;
  maxRetries: number;
  geocacheTtlMs: number;
}

function positiveInt(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function osmConfig(): OsmConfig {
  return {
    userAgent:
      process.env.OSM_USER_AGENT?.trim() ||
      "DirectoryLeads/0.1 (business-lead tool; set OSM_USER_AGENT to a URL or email)",
    overpassEndpoint: (process.env.OVERPASS_ENDPOINT ?? "https://overpass-api.de/api/interpreter").trim(),
    nominatimEndpoint: (process.env.NOMINATIM_ENDPOINT ?? "https://nominatim.openstreetmap.org/search").trim(),
    delayMinMs: positiveInt("OSM_DELAY_MIN_MS", 4000),
    delayMaxMs: positiveInt("OSM_DELAY_MAX_MS", 8000),
    rateLimitRetryMs: positiveInt("OSM_RETRY_BACKOFF_MS", 30000),
    // The public instance answers a heavy box query with 504 while it is busy, then
    // serves the same query seconds later; a 10 s retry was measurably too soon.
    transientRetryMs: positiveInt("OSM_TRANSIENT_RETRY_MS", 20000),
    maxRetries: positiveInt("OSM_MAX_RETRIES", 2),
    geocacheTtlMs: positiveInt("OSM_GEOCACHE_TTL_MS", 604800000),
  };
}

export interface HttpResponse {
  status: number;
  body: string;
  retryAfterMs: number | null;
}

export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultGates = new Map<string, number>();

/**
 * One courtesy-capped request: wait our turn on this host, then retry
 * `maxRetries` times — 30 s after a rate limit, 20 s after a transient failure —
 * before giving up as `blocked`. `send` and `sleep` are injected so the ladder is
 * tested without a socket.
 */
export async function politeRequest(
  host: string,
  send: () => Promise<HttpResponse>,
  cfg: OsmConfig,
  hooks: { budget: RequestBudget; log(message: string): void },
  label: string,
  sleepFn: Sleeper = realSleep,
  gates: Map<string, number> = defaultGates,
): Promise<HttpResponse> {
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (hooks.budget.exhausted()) {
      throw new BudgetExhaustedError(`${label}: request budget exhausted`);
    }
    await waitForTurn(host, cfg, sleepFn, gates);
    hooks.budget.charge();

    let res: HttpResponse;
    try {
      res = await send();
    } catch (err) {
      // No HTTP response at all (DNS, TLS, connect timeout). That is the service
      // being unreachable, not a bad query, so it takes the same backoff.
      res = { status: 0, body: transportReason(err), retryAfterMs: null };
    }
    const failure = classifyFailure(res.status, res.body);
    if (failure.ok) return res;

    if (failure.kind === "fatal") {
      throw new Error(`${label}: ${describe(res)}${userAgentHint(res.status, res.body)}`);
    }
    if (attempt === cfg.maxRetries) {
      const why = failure.kind === "rate_limited" ? "rate limited" : "unavailable";
      throw new BlockedError(
        "osm",
        `${label}: ${why} after ${attempt + 1} attempt(s) — ${describe(res)}${userAgentHint(res.status, res.body)}`,
        res.status,
      );
    }
    const wait = Math.max(
      failure.kind === "rate_limited" ? cfg.rateLimitRetryMs : cfg.transientRetryMs,
      res.retryAfterMs ?? 0,
    );
    hooks.log(`${label}: ${failure.kind} (${describe(res)}); waiting ${Math.round(wait / 1000)} s`);
    await sleepFn(wait);
  }
  throw new Error(`${label}: unreachable`);
}

/** Node buries the real reason for a failed fetch in `error.cause`. */
function transportReason(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } } | null;
  const cause = e?.cause?.code ?? e?.cause?.message;
  const message = e?.message ?? String(err);
  return [message, cause].filter(Boolean).join(": ");
}

function describe(res: HttpResponse): string {
  if (res.status === 0) return snippet(res.body) || "connection failed";
  return `HTTP ${res.status} ${snippet(res.body)}`;
}

async function waitForTurn(
  host: string,
  cfg: OsmConfig,
  sleepFn: Sleeper,
  gates: Map<string, number>,
): Promise<void> {
  const nextAt = gates.get(host) ?? 0;
  const wait = nextAt - Date.now();
  if (wait > 0) await sleepFn(wait);
  const jitter = cfg.delayMaxMs > cfg.delayMinMs ? Math.random() * (cfg.delayMaxMs - cfg.delayMinMs) : 0;
  gates.set(host, Date.now() + cfg.delayMinMs + jitter);
}

function snippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Verified behaviour: both gateways answer 403/406 for a placeholder User-Agent —
 * literally "@example.com" in the string is enough — which looks like a ban.
 */
function userAgentHint(status: number, body: string): string {
  if (status !== 403 && status !== 406) return "";
  if (!/access denied|not acceptable/i.test(body)) return "";
  return ' — the OSM gateways reject this User-Agent; set OSM_USER_AGENT to your own contact (a "example.com" placeholder is refused)';
}

/** Geocoded areas are cached in-process: areas rarely move and Nominatim is the strictest limit. */
const geoCache = new Map<string, { at: number; value: ResolvedArea }>();

export function invalidateGeoCache(): void {
  geoCache.clear();
}

async function httpSend(
  fetchFn: typeof fetch,
  init: Parameters<typeof fetch>,
): Promise<HttpResponse> {
  const res = await fetchFn(init[0], init[1]);
  const body = await res.text();
  return { status: res.status, body, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
}

export async function resolveArea(
  location: string,
  cfg: OsmConfig,
  hooks: { budget: RequestBudget; log(message: string): void },
  fetchFn: typeof fetch = fetch,
  sleepFn: Sleeper = realSleep,
): Promise<ResolvedArea> {
  const key = location.trim().toLowerCase();
  const cached = geoCache.get(key);
  if (cached && Date.now() - cached.at < cfg.geocacheTtlMs) return cached.value;

  const url = `${cfg.nominatimEndpoint}?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(location)}`;
  const res = await politeRequest(
    new URL(cfg.nominatimEndpoint).host,
    () =>
      httpSend(fetchFn, [
        url,
        { headers: { "user-agent": cfg.userAgent, accept: "application/json" } },
      ]),
    cfg,
    hooks,
    `nominatim "${location}"`,
    sleepFn,
  );

  const hits = (JSON.parse(res.body) as NominatimHit[]) ?? [];
  const hit = Array.isArray(hits) ? hits[0] : undefined;
  if (!hit) throw new Error(`nominatim: nothing matched "${location}"`);

  const plan = planFromNominatim(hit);
  if (!plan) throw new Error(`nominatim: no usable search area for "${location}"`);
  if (plan.note) hooks.log(`nominatim "${location}": ${plan.note}`);

  geoCache.set(key, { at: Date.now(), value: plan });
  return plan;
}

export interface OsmAdapterOptions {
  fetch?: typeof fetch;
  sleep?: Sleeper;
  config?: OsmConfig;
  gates?: Map<string, number>;
}

export function createOsmAdapter(options: OsmAdapterOptions = {}): SourceAdapter {
  const fetchFn = options.fetch ?? fetch;
  const sleepFn = options.sleep ?? realSleep;

  return {
    source: "osm",

    async search(args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
      const cfg = options.config ?? osmConfig();
      const gates = options.gates ?? defaultGates;
      let emitted = 0;
      let stopped = false;

      const area = await resolveArea(args.location, cfg, hooks, fetchFn, sleepFn);
      const selectors = selectorsForKeyword(args.keyword);
      if (selectors.length === 0) {
        hooks.log(`osm: keyword "${args.keyword}" produced no usable selectors`);
        return { emitted, requestsUsed: hooks.budget.spent(), stopped };
      }

      const query = buildOverpassQuery(area.box, selectors, overpassCap(args.maxItems));
      const label = `overpass "${args.keyword}" near ${area.label || args.location}`;
      const res = await politeRequest(
        new URL(cfg.overpassEndpoint).host,
        () =>
          httpSend(fetchFn, [
            cfg.overpassEndpoint,
            {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": cfg.userAgent,
              },
              body: `data=${encodeURIComponent(query)}`,
            },
          ]),
        cfg,
        hooks,
        label,
        sleepFn,
        gates,
      );

      const payload = JSON.parse(res.body) as OverpassResponse;
      if (payload.error || payload.remark) hooks.log(`${label}: ${snippet(payload.error ?? payload.remark ?? "")}`);

      const { leads, droppedUnnamed, droppedClosed, droppedFeature } = parseOverpassLeads(payload);
      if (droppedUnnamed > 0) hooks.log(`${label}: skipped ${droppedUnnamed} unnamed element(s)`);
      if (droppedClosed > 0) hooks.log(`${label}: skipped ${droppedClosed} abandoned/disused element(s)`);
      if (droppedFeature > 0) {
        hooks.log(`${label}: skipped ${droppedFeature} street/natural feature(s) caught by the name search`);
      }

      const nearby = leads.filter((lead) => !outsidePlace(lead.city, area.placeName));
      const elsewhere = leads.length - nearby.length;
      if (elsewhere > 0) {
        hooks.log(`${label}: skipped ${elsewhere} element(s) tagged to another city`);
      }

      for (const lead of nearby) {
        if (emitted >= args.maxItems) break;
        if (hooks.shouldStop()) {
          stopped = true;
          break;
        }
        await hooks.emit(lead);
        emitted++;
      }
      return { emitted, requestsUsed: hooks.budget.spent(), stopped };
    },
  };
}
