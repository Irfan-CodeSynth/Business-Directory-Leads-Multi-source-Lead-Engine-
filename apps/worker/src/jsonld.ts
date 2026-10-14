import { classifySocial, normalizeSocialUrl, type SocialNetwork } from "./socials.js";

/** What a site's own structured data says about it. */
export interface StructuredDetails {
  emails: string[];
  socials: Partial<Record<SocialNetwork, string>>;
  phone: string | null;
  name: string | null;
}

/**
 * Types whose `email`/`telephone` are the business's own contact details. A `Person`
 * inside a Recipe or a Review posts its personal address, which is not what we are
 * looking for, so it is excluded by construction rather than by a blocklist.
 */
const BUSINESS_TYPES = new Set([
  "localbusiness",
  "organization",
  "business",
  "corporateorganization",
  "governmentorganization",
  "civicorganization",
  "nongovernmentorganization",
  "customerservice",
  "autorestaurant",
  "store",
  "foodestablishment",
  "physician",
  "medicalclinic",
  "webpage",
  "website",
]);

const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function parseLocalBusiness(html: string): StructuredDetails {
  const out: StructuredDetails = { emails: [], socials: {}, phone: null, name: null };
  for (const block of html.matchAll(JSONLD_RE)) {
    let data: unknown;
    try {
      data = JSON.parse((block[1] ?? "").trim());
    } catch {
      // Malformed JSON-LD is extremely common; a broken block must not lose the rest.
      continue;
    }
    for (const node of nodes(data)) {
      const types = node["@type"];
      const isBusiness =
        typeof types === "string" || Array.isArray(types)
          ? asArray(types).some((t) => BUSINESS_TYPES.has(String(t).toLowerCase()))
          : false;
      if (!isBusiness) continue;

      out.name ??= typeof node["name"] === "string" ? node["name"] : null;
      const email = node["email"];
      if (typeof email === "string") pushEmail(out, email);
      else if (Array.isArray(email)) for (const e of email) if (typeof e === "string") pushEmail(out, e);

      out.phone ??= telephoneOf(node);
      for (const url of asArray(node["sameAs"])) {
        if (typeof url !== "string") continue;
        const network = classifySocial(url);
        if (network && !out.socials[network]) out.socials[network] = normalizeSocialUrl(url);
      }
    }
  }
  return out;
}

function pushEmail(out: StructuredDetails, value: string): void {
  const email = value.replace(/^mailto:/i, "").trim().toLowerCase();
  if (email.includes("@") && !out.emails.includes(email)) out.emails.push(email);
}

/** `telephone`, or the first telephone in any `contactPoint`. */
function telephoneOf(node: Record<string, unknown>): string | null {
  const direct = node["telephone"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const point of asArray(node["contactPoint"])) {
    if (point && typeof point === "object") {
      const phone = (point as Record<string, unknown>)["telephone"];
      if (typeof phone === "string" && phone.trim()) return phone.trim();
    }
  }
  return null;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

/** Walks `@graph`, `@list`, and bare arrays down to the candidate nodes. */
function * nodes(data: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(data)) {
    for (const item of data) yield * nodes(item);
    return;
  }
  if (!data || typeof data !== "object") return;
  const node = data as Record<string, unknown>;
  for (const key of ["@graph", "@list"]) {
    if (node[key] != null) yield * nodes(node[key]);
  }
  if (node["@type"] != null || node["@graph"] == null) yield node;
}
