/**
 * Social profile recognition, shared by the HTML scan and by schema.org `sameAs`.
 * The patterns are the ones the reference app learned against live small-business
 * sites: each platform has a handful of chrome/link URLs that are not the business's
 * own page, and those are filtered, not stored.
 */

export const socialNetworks = ["instagram", "facebook", "linkedin", "twitter", "youtube", "tiktok"] as const;
export type SocialNetwork = (typeof socialNetworks)[number];

const SOCIAL_PATTERNS: Record<SocialNetwork, RegExp> = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._@/\-]+/i,
  facebook: /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[A-Za-z0-9._\-/?=@%]+/i,
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company|business)\/[A-Za-z0-9._%\-/]+/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9._]+/i,
  youtube:
    /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:@|channel\/|c\/|user\/)[A-Za-z0-9.%\-]+|youtu\.be\/[A-Za-z0-9\-_]+)/i,
  // A tiktok handle is the only form that identifies a business; `embed` and `tag`
  // are widget and hashtag URLs.
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._\-]+/i,
};

const HOSTS: Record<string, SocialNetwork> = {
  "instagram.com": "instagram",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "linkedin.com": "linkedin",
  "twitter.com": "twitter",
  "x.com": "twitter",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "tiktok.com": "tiktok",
};

/** Which network a url belongs to, or null if it is not a profile link we want. */
export function classifySocial(url: string): SocialNetwork | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const network = Object.entries(HOSTS).find(([name]) => host === name || host.endsWith(`.${name}`))?.[1];
  if (!network) return null;
  if (!new RegExp(SOCIAL_PATTERNS[network].source, "i").test(url)) return null;
  if (isJunkSocial(url)) return null;
  return network;
}

/**
 * XML namespace declarations, embed/config endpoints, share widgets, hashtag pages
 * and the platform's own footer accounts are all links *about* the network rather
 * than the business's page on it.
 */
function isJunkSocial(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  if (/^\/2008\/fbml/.test(path)) return true;
  if (/^\/20\d\d\/(og|twitter|schema)/.test(path)) return true;
  if (/^\/(widgets|sharer|share|plugins|dialog|tr|following|following_frame|embed|tag)/.test(path)) return true;
  if (/^\/(p|post)\//.test(path)) return true;
  if (/^\/(squarespace|intent|hashtag|search)/.test(path)) return true;
  const first = path.split("/").filter(Boolean)[0]?.toLowerCase();
  if (["p", "sharer", "tr", "widgets", "intent", "2008", "embed", "tag"].includes(first ?? "")) return true;
  if (["facebook", "twitter", "instagram", "youtube", "google", "t.co", "x", "tiktok"].includes(first ?? "")) return true;
  return false;
}

/** Drop the hash and tracking query params; the handle is the whole point. */
export function normalizeSocialUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** First real profile link per platform. */
export function extractSocials(html: string): Partial<Record<SocialNetwork, string>> {
  const out: Partial<Record<SocialNetwork, string>> = {};
  for (const network of socialNetworks) {
    for (const candidate of html.match(new RegExp(SOCIAL_PATTERNS[network].source, "gi")) ?? []) {
      const classified = classifySocial(candidate);
      if (classified === network) {
        out[network] = normalizeSocialUrl(candidate);
        break;
      }
    }
  }
  return out;
}
