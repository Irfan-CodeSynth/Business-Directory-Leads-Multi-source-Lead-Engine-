/**
 * Website enrichment: fetch a handful of pages from the business's own site over
 * plain HTTP (no browser) and take its published emails, social links and phone.
 * Nothing here bypasses a login or a paywall — pages the site serves anonymously are
 * the pages we read.
 */
import { parseLocalBusiness } from "./jsonld.js";
import { extractSocials, socialNetworks, type SocialNetwork } from "./socials.js";

export type PageFetcher = (url: string) => Promise<string | null>;

export interface EnrichConfig {
  maxPages: number;
  maxPageBytes: number;
  timeoutMs: number;
  delayMinMs: number;
  delayMaxMs: number;
  /** Hosts one job will visit, so a large run cannot turn into an open-ended crawl. */
  maxHosts: number;
  /** How long a cached observation stays trustworthy. */
  cacheDays: number;
  userAgent: string;
}

export function enrichConfig(overrides: Partial<EnrichConfig> = {}): EnrichConfig {
  const off = /^(false|0|no|off)$/i.test(process.env.ENRICH_ENABLED?.trim() ?? "");
  return {
    maxPages: Number(process.env.ENRICH_MAX_PAGES_PER_HOST ?? 3),
    maxPageBytes: Number(process.env.ENRICH_MAX_PAGE_BYTES ?? 400_000),
    timeoutMs: Number(process.env.ENRICH_TIMEOUT_MS ?? 12_000),
    delayMinMs: Number(process.env.ENRICH_DELAY_MIN_MS ?? 1500),
    delayMaxMs: Number(process.env.ENRICH_DELAY_MAX_MS ?? 3500),
    // Switching enrichment off is a request budget of zero hosts, so the one loop in
    // the pass is the only place that has to know about it.
    maxHosts: off ? 0 : Number(process.env.ENRICH_MAX_HOSTS ?? 80),
    cacheDays: Number(process.env.ENRICH_CACHE_DAYS ?? 180),
    userAgent: process.env.ENRICH_USER_AGENT?.trim() || "Mozilla/5.0 (compatible; DirectoryLeads/0.1)",
    ...overrides,
  };
}

export interface FetchedPage {
  url: string;
  html: string;
}

/** What one host publishes about itself. */
export interface SiteDetails {
  emails: string[];
  socials: Partial<Record<SocialNetwork, string>>;
  phone: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const BAD_EMAIL_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|bmp|mp4|webm)$/i;
// Template placeholders that ship inside page boilerplate.
const PLACEHOLDER_EMAIL_RE =
  /^(?:user|name|email|yourname|someone|admin|info|webmaster)@(?:domain|example|company|email|site)\.(?:com|org|net)$/i;

/** Emails from `mailto:` links and free text, lowercased, deduped, junk-filtered. */
export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) addEmail(found, safeDecode(match[1] ?? ""));
  for (const candidate of html.match(EMAIL_RE) ?? []) addEmail(found, candidate);

  return [...found].filter((e) => !BAD_EMAIL_EXT.test(e) && !PLACEHOLDER_EMAIL_RE.test(e)).slice(0, 10);
}

function addEmail(set: Set<string>, email: string): void {
  const clean = email.trim().toLowerCase().replace(/[.,;:]+$/, "");
  if (clean.includes("@") && clean.length >= 6 && clean.length <= 100 && !clean.includes("@example.")) {
    set.add(clean);
  }
}

/**
 * The cache key. `www.acme.com` and `acme.com` are one business's one website, and
 * keying on the literal host would make a chain crawl the same pages twice.
 */
export function hostOf(website: string): string | null {
  try {
    const url = new URL(website.includes("://") ? website : `https://${website}`);
    const host = url.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host || null;
  } catch {
    return null;
  }
}

export function candidateUrls(website: string): string[] {
  const urls = [website];
  try {
    const u = new URL(website);
    // Spends the page cap on the two pages that actually carry details before their
    // hyphenated spellings, which many sites do not serve at all.
    for (const path of ["/contact", "/about", "/contact-us", "/about-us", "/contactus"]) {
      urls.push(`${u.origin}${path}`);
    }
  } catch {
    /* not a url we can extend */
  }
  return urls;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches up to `maxPages` candidate pages, pacing itself so a chain of stores on one
 * domain cannot look like an attack. A page that fails is simply skipped: a dead
 * contact page must not lose the homepage.
 */
export async function crawlSite(
  website: string,
  fetchPage: PageFetcher,
  config: Partial<EnrichConfig> = {},
): Promise<FetchedPage[]> {
  const { maxPages, delayMinMs, delayMaxMs } = enrichConfig(config);
  const pages: FetchedPage[] = [];
  let asked = 0;

  for (const url of candidateUrls(website)) {
    if (asked >= maxPages) break;
    if (asked > 0) await sleep(delayMinMs + Math.random() * Math.max(0, delayMaxMs - delayMinMs));
    asked++;
    const html = await fetchPage(url);
    if (html) pages.push({ url, html });
  }
  return pages;
}

/** Merges everything the crawled pages publish about the business. */
export function detailsFromPages(pages: FetchedPage[]): SiteDetails {
  const html = pages.map((p) => p.html).join("\n");
  const emails = new Set(extractEmails(html));
  const socials: Partial<Record<SocialNetwork, string>> = { ...extractSocials(html) };
  let phone: string | null = null;

  for (const page of pages) {
    const structured = parseLocalBusiness(page.html);
    for (const email of structured.emails) emails.add(email);
    for (const network of socialNetworks) {
      if (structured.socials[network] && !socials[network]) socials[network] = structured.socials[network];
    }
    // Only the number the site itself published in its markup. A free-text phone
    // regex over arbitrary HTML turns order numbers and dates into "contact details".
    phone ??= structured.phone;
  }

  return { emails: [...emails], socials, phone };
}

/** The real fetcher: browser-ish headers, `maxPageBytes` cap, `timeoutMs` abort. */
export function makeFetchPage(config: Partial<EnrichConfig> = {}): PageFetcher {
  const { maxPageBytes, timeoutMs, userAgent } = enrichConfig(config);
  return async (url: string) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      if (!(res.headers.get("content-type") ?? "").includes("html")) return null;

      const reader = res.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder();
      let html = "";
      let received = 0;
      while (received < maxPageBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
        html += decoder.decode(value ?? new Uint8Array(), { stream: true });
      }
      await reader.cancel().catch(() => {});
      return html;
    } catch {
      return null;
    }
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export { extractSocials };
