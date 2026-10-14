import { createHash } from "node:crypto";

/**
 * Pure, browser-free dedup helpers.
 *
 * Two jobs, deliberately kept apart:
 *  - `dedupKeyFor` picks ONE identity key per business (the ledger's primary key).
 *  - the alias fields (`nameKey`, `phoneE164`, ...) are what let a *different*
 *    source recognise that same business.
 * Identity by source id is checked before any of this, so tiers only have to be
 * consistent for a given business, not globally unique.
 */

export type DedupKind = "p" | "z" | "w" | "x" | "n";

export interface DedupInput {
  name: string;
  phone?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  website?: string | null;
  source: string;
  externalId?: string | null;
}

export interface DedupFields {
  nameKey: string;
  phoneE164: string | null;
  postalCode: string | null;
  cityKey: string | null;
  websiteHost: string | null;
  kind: DedupKind;
  key: string;
  /** False for generic/chain-ish names, which must never join across sources. */
  ledgerEligible: boolean;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "co",
  "corp",
  "corporation",
  "company",
  "group",
  "holdings",
  "enterprises",
  "associates",
]);

/**
 * Words that describe a trade rather than a business. "Plumbing Repair" and
 * "Auto Cleaning" appear as the *name* of many unrelated listings, so keying on
 * them would merge different businesses into one ledger row.
 */
const GENERIC_WORDS = new Set([
  "plumbing",
  "plumber",
  "plumbers",
  "hvac",
  "electrician",
  "electric",
  "roofing",
  "roofer",
  "painting",
  "painters",
  "landscaping",
  "cleaning",
  "movers",
  "moving",
  "auto",
  "repair",
  "repairs",
  "services",
  "service",
  "solutions",
  "express",
  "expert",
  "pros",
  "pro",
  "shop",
  "store",
  "market",
  "grocery",
  "cafe",
  "restaurant",
  "bakery",
  "salon",
  "barber",
  "barbershop",
  "clinic",
  "dental",
  "dentist",
  "gym",
  "hotel",
  "motel",
  "inn",
  "spa",
  "salon",
  "bar",
  "pub",
  "llc",
]);

export function nameKey(raw: string): string {
  let value = (raw ?? "").toLowerCase();
  // "Acme Plumbing (Downtown Branch)" is the same business as "Acme Plumbing".
  value = value.replace(/\([^)]*\)/g, " ");
  value = value.replace(/&\s/g, " and ");
  value = value.replace(/[^a-z0-9 ]+/g, " ");
  let tokens = value.split(/\s+/).filter(Boolean);
  while (tokens.length && tokens[0] === "the") tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);
  return tokens.join(" ").trim();
}

/**
 * North-American numbers get strict E.164 so "(512) 555-0123", "1-512-555-0123"
 * and "+15125550123" collapse to one key. Anything we cannot classify confidently
 * returns null and falls through to the address/host tiers.
 */
export function phoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withoutExt = raw.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, "");
  const hadPlus = withoutExt.trim().startsWith("+");
  let digits = withoutExt.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);

  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  // Anything else that still starts with 1 is a US number that arrived truncated or
  // malformed; guessing a country code here would merge unrelated businesses.
  if (digits.startsWith("1")) return null;
  if (hadPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** US ZIP-5 only; other countries keep the alphanumeric code verbatim. */
export function zip5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const us = value.match(/^(\d{5})/);
  if (us) return us[1]!;
  const other = value.toUpperCase().replace(/\s+/g, "");
  // A digit is mandatory: foreign postcodes always carry one, which stops a city
  // name pasted into the ZIP column from becoming a fake postal key.
  if (/^[A-Z0-9-]{3,10}$/.test(other) && /\d/.test(other)) return other;
  return null;
}

const US_STATES: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  newhampshire: "nh",
  newjersey: "nj",
  newmexico: "nm",
  newyork: "ny",
  northcarolina: "nc",
  northdakota: "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  rhodeisland: "ri",
  southcarolina: "sc",
  southdakota: "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  westvirginia: "wv",
  wisconsin: "wi",
  wyoming: "wy",
  districtofcolumbia: "dc",
  puertorico: "pr",
};

/**
 * Directory rows spell states ("Texas") and CSV exports abbreviate them ("TX"),
 * so both collapse to the 2-letter form before they can join.
 */
function regionKey(raw: string): string {
  const value = raw.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, "");
  return US_STATES[value] ?? value;
}

export function cityKey(city: string | null | undefined, region: string | null | undefined): string | null {
  const c = (city ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const r = regionKey(region ?? "");
  if (!c) return null;
  return r ? `${c}|${r}` : c;
}

export function websiteHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || !/[a-z0-9]/i.test(value)) return null;
  // Directory rows sometimes carry mailto:/tel:/javascript: links or a bare email
  // in the website column; none of those identify a site to crawl.
  if (value.includes("@")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** Single-token names, and names that are only trade words, are not distinctive. */
export function isGenericName(key: string): boolean {
  const tokens = key.split(" ").filter(Boolean);
  if (tokens.length <= 1) return true;
  return tokens.every((t) => GENERIC_WORDS.has(t));
}

/**
 * Tier priority. A stable source id (`x`) outranks name+city (`n`) because it is
 * exact; `n` exists only as a last resort and is never allowed cross-source.
 */
export function dedupKeyFor(input: DedupInput): DedupFields {
  const nk = nameKey(input.name);
  const phone = phoneE164(input.phone);
  const zip = zip5(input.postalCode);
  const city = cityKey(input.city, input.region);
  const host = websiteHost(input.website);
  const external = (input.externalId ?? "").trim();

  let kind: DedupKind;
  let key: string;
  if (phone) {
    kind = "p";
    key = `p:${hash(`${nk}|${phone}`)}`;
  } else if (zip && city) {
    kind = "z";
    key = `z:${hash(`${nk}|${zip}|${city}`)}`;
  } else if (host) {
    kind = "w";
    key = `w:${hash(`${nk}|${host}`)}`;
  } else if (external) {
    kind = "x";
    key = `x:${input.source}:${external.length > 48 ? hash(external) : external}`;
  } else {
    kind = "n";
    key = `n:${input.source}:${hash(`${nk}|${city ?? ""}`)}`;
  }

  return {
    nameKey: nk,
    phoneE164: phone,
    postalCode: zip,
    cityKey: city,
    websiteHost: host,
    kind,
    key,
    ledgerEligible: kind === "n" ? !isGenericName(nk) : true,
  };
}

/** Address line assembled from parts, normalised for display and CSV. */
export function formatAddress(
  address: string | null | undefined,
  city: string | null | undefined,
  region: string | null | undefined,
  postalCode: string | null | undefined,
): string | null {
  const tail = [city, [region, postalCode].filter(Boolean).join(" ")]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const head = (address ?? "").trim();
  const full = [head, tail].filter(Boolean).join(", ");
  return full || null;
}
