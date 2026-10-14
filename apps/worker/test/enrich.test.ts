import { describe, expect, it } from "vitest";
import {
  candidateUrls,
  crawlSite,
  detailsFromPages,
  extractEmails,
  extractSocials,
  hostOf,
  type PageFetcher,
} from "../src/enrich.js";
import { parseLocalBusiness } from "../src/jsonld.js";

/** A fake web: answers by url, counts every url it was asked for. */
function fakeSite(pages: Record<string, string>) {
  const asked: string[] = [];
  const fetchPage: PageFetcher = async (url) => {
    asked.push(url);
    return pages[url] ?? null;
  };
  return { fetchPage, asked };
}

describe("extractEmails", () => {
  it("reads mailto links and plaintext emails, deduped", () => {
    const html = `
      <a href="mailto:Info@Acme.com?subject=hi">mail us</a>
      <p>or write to sales@acme.com</p>
      <p>info@acme.com again</p>
      <img src="logo@2x.png">
    `;
    expect(extractEmails(html).sort()).toEqual(["info@acme.com", "sales@acme.com"]);
  });

  it("filters asset-like and example addresses", () => {
    const html = "<p>sprite-1x.png contact@example.com ok@host.co.uk</p>";
    expect(extractEmails(html)).toEqual(["ok@host.co.uk"]);
  });

  it("decodes a percent-encoded mailto", () => {
    expect(extractEmails('<a href="mailto:help%40acme.com">mail</a>')).toEqual(["help@acme.com"]);
  });
});

describe("extractSocials", () => {
  it("finds one URL per platform and strips tracking", () => {
    const html = `
      <a href="https://www.instagram.com/acme.plumbing/?utm_source=ig_embed">ig</a>
      <a href="https://facebook.com/acme-123">fb</a>
      <a href="https://www.linkedin.com/company/acme-plumbing/">li</a>
    `;
    const s = extractSocials(html);
    expect(s.instagram).toBe("https://www.instagram.com/acme.plumbing");
    expect(s.facebook).toBe("https://facebook.com/acme-123");
    expect(s.linkedin).toBe("https://www.linkedin.com/company/acme-plumbing");
    expect(s.twitter).toBeUndefined();
  });

  it("reads tiktok, which the reference app never needed", () => {
    const html = '<a href="https://www.tiktok.com/@acmeplumbing?sec=xyz">tt</a>';
    expect(extractSocials(html).tiktok).toBe("https://www.tiktok.com/@acmeplumbing");
  });
});

describe("junk filtering (learned from live scrape)", () => {
  it("skips fbml namespace URL, post links and placeholder emails", () => {
    const html = `
      <html xmlns:fb="http://www.facebook.com/2008/fbml">
      <a href="https://www.facebook.com/realbiz">fb</a>
      <p>user@domain.com or hi@real.io</p>
      <a href="https://www.instagram.com/p/Ddl0QE8Fj0z">ig post (not a profile)</a>
      <a href="https://www.instagram.com/realbiz">ig profile</a>
    `;
    expect(extractSocials(html).facebook).toBe("https://www.facebook.com/realbiz");
    expect(extractSocials(html).instagram).toBe("https://www.instagram.com/realbiz");
    expect(extractEmails(html)).toEqual(["hi@real.io"]);
  });

  it("skips footer cross-links to the platform's own account", () => {
    const html = `<a href="https://twitter.com/facebook">share</a><a href="https://twitter.com/realbrand">me</a>`;
    expect(extractSocials(html).twitter).toBe("https://twitter.com/realbrand");
  });

  it("skips a tiktok share widget and a hashtag page", () => {
    const html = `
      <a href="https://www.tiktok.com/embed/v2/7300000000000000000">widget</a>
      <a href="https://www.tiktok.com/@acme">profile</a>
      <a href="https://www.tiktok.com/tag/plumbing">hashtag</a>
    `;
    expect(extractSocials(html).tiktok).toBe("https://www.tiktok.com/@acme");
  });
});

describe("candidateUrls", () => {
  it("builds origin-level contact/about guesses", () => {
    const urls = candidateUrls("https://acme.com/services/plumbing?utm=x");
    expect(urls[0]).toBe("https://acme.com/services/plumbing?utm=x");
    expect(urls).toContain("https://acme.com/contact");
    expect(urls).toContain("https://acme.com/about");
  });

  it("leaves a malformed url alone instead of guessing", () => {
    expect(candidateUrls("acme plumbing")).toEqual(["acme plumbing"]);
  });
});

describe("hostOf", () => {
  it("keys the cache on the site, not the www spelling", () => {
    expect(hostOf("https://www.Acme.com/services")).toBe("acme.com");
    expect(hostOf("acme.com")).toBe("acme.com");
    expect(hostOf("http://sub.acme.com:8080/x")).toBe("sub.acme.com");
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("crawlSite", () => {
  it("tries the homepage, then contact, then about, and stops at the cap", async () => {
    const { fetchPage, asked } = fakeSite({
      "https://acme.com": "<p>hi@acme.com</p>",
      "https://acme.com/contact": "<p>hi@acme.com</p>",
      "https://acme.com/about": "<p>about</p>",
      "https://acme.com/pricing": "<p>no</p>",
    });
    const pages = await crawlSite("https://acme.com", fetchPage, { maxPages: 3, delayMinMs: 0, delayMaxMs: 0 });

    expect(pages.map((p) => p.url)).toEqual(["https://acme.com", "https://acme.com/contact", "https://acme.com/about"]);
    expect(asked).toHaveLength(3);
  });

  it("keeps going past a page that 404s", async () => {
    const { fetchPage, asked } = fakeSite({ "https://acme.com": "<p>top</p>", "https://acme.com/about": "<p>hi@acme.com</p>" });
    const pages = await crawlSite("https://acme.com", fetchPage, { maxPages: 3, delayMinMs: 0, delayMaxMs: 0 });

    expect(pages.map((p) => p.url)).toEqual(["https://acme.com", "https://acme.com/about"]);
    expect(asked).toEqual(["https://acme.com", "https://acme.com/contact", "https://acme.com/about"]);
  });
});

describe("detailsFromPages", () => {
  it("merges emails and socials across pages", () => {
    const out = detailsFromPages([
      { url: "https://acme.com", html: '<a href="mailto:hi@acme.com">hi</a>' },
      { url: "https://acme.com/contact", html: '<a href="https://x.com/acme">tw</a>' },
    ]);
    expect(out.emails).toEqual(["hi@acme.com"]);
    expect(out.socials.twitter).toBe("https://x.com/acme");
    expect(out.phone).toBeNull();
  });

  it("takes the phone from structured data when the page writes it as text", () => {
    const out = detailsFromPages([
      {
        url: "https://acme.com",
        html: `<script type="application/ld+json">{"@type":"LocalBusiness","telephone":"+1-512-555-0142"}</script>
               <p>Call us at 512 555 0142</p>`,
      },
    ]);
    expect(out.phone).toBe("+1-512-555-0142");
  });

  it("prefers the number the site published in its markup over a scraped phone-looking string", () => {
    const out = detailsFromPages([{ url: "https://acme.com", html: "<p>Order 1 800 555 0000 before 2024</p>" }]);
    expect(out.phone).toBeNull();
  });
});

describe("parseLocalBusiness", () => {
  it("reads email, phone and sameAs from a graph of schema.org objects", () => {
    const html = `
      <script type="application/ld+json">
      {"@graph":[
        {"@type":"WebSite","name":"Acme"},
        {"@type":["LocalBusiness","Plumber"],"telephone":"(512) 555-0142","email":"dispatch@acme.com",
         "sameAs":["https://www.facebook.com/acmeplumbing","https://www.instagram.com/acmeplumbing"]}
      ]}
      </script>`;
    const out = parseLocalBusiness(html);
    expect(out.emails).toEqual(["dispatch@acme.com"]);
    expect(out.phone).toBe("(512) 555-0142");
    expect(out.socials).toEqual({
      facebook: "https://www.facebook.com/acmeplumbing",
      instagram: "https://www.instagram.com/acmeplumbing",
    });
    expect(out.name).toBe("Acme");
  });

  it("unwraps @list and ignores unrelated JSON-LD", () => {
    const html = `
      <script type="application/ld+json">{"@list":[
        {"@type":"Recipe","author":{"@type":"Person","email":"chef@notacme.com"}},
        {"@type":"Organization","url":"https://acme.com","contactPoint":[{"telephone":"+15125550188"}]}
      ]}</script>
      <script type="application/ld+json">not json{</script>`;
    const out = parseLocalBusiness(html);
    expect(out.phone).toBe("+15125550188");
    // A person's email inside a Recipe is not the business's contact address.
    expect(out.emails).toEqual([]);
  });

  it("returns nothing for a page with no structured data", () => {
    expect(parseLocalBusiness("<p>plain page</p>")).toEqual({ emails: [], socials: {}, phone: null, name: null });
  });
});
