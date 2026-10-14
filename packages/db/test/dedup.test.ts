import { describe, expect, it } from "vitest";
import {
  cityKey,
  dedupKeyFor,
  formatAddress,
  isGenericName,
  nameKey,
  phoneE164,
  websiteHost,
  zip5,
} from "../src/dedup.js";

describe("phoneE164", () => {
  it("collapses every US formatting variant onto one key", () => {
    const forms = [
      "(512) 555-0123",
      "512.555.0123",
      "512-555-0123",
      "1-512-555-0123",
      "+15125550123",
      "+1 (512) 555 0123",
      "  5125550123  ",
    ];
    const keys = new Set(forms.map(phoneE164));
    expect(keys).toEqual(new Set(["+15125550123"]));
  });

  it("drops extensions instead of corrupting the number", () => {
    expect(phoneE164("(512) 555-0123 x45")).toBe("+15125550123");
    expect(phoneE164("512-555-0123 ext. 45")).toBe("+15125550123");
  });

  it("keeps international numbers it is confident about", () => {
    expect(phoneE164("+44 20 7183 8750")).toBe("+442071838750");
    expect(phoneE164("+61 2 9374 4000")).toBe("+61293744000");
    // Without the plus there is no way to tell a country code from a local trunk
    // prefix, so the address/host tiers have to carry the match instead.
    expect(phoneE164("020 7183 8750")).toBeNull();
  });

  it("returns null rather than guessing", () => {
    expect(phoneE164(null)).toBeNull();
    expect(phoneE164("")).toBeNull();
    expect(phoneE164("call us")).toBeNull();
    expect(phoneE164("555-0123")).toBeNull(); // local number, no area code
    expect(phoneE164("1234567890")).toBeNull(); // area code starting at 1
    expect(phoneE164("+1 512 555")).toBeNull(); // too short to be a NANP number
  });

  it("treats a directory and a website listing of the same shop as identical", () => {
    const a = dedupKeyFor({ name: "Acme Plumbing", phone: "(512) 555-0123", source: "osm" });
    const b = dedupKeyFor({ name: "Acme Plumbing Co", phone: "+15125550123", source: "csv" });
    expect(a.key).toBe(b.key);
    expect(a.kind).toBe("p");
  });
});

describe("nameKey", () => {
  it("strips legal suffixes and punctuation", () => {
    expect(nameKey("Acme Plumbing, Inc.")).toBe("acme plumbing");
    expect(nameKey("Acme Plumbing LLC")).toBe("acme plumbing");
    expect(nameKey("Acme's Plumbing & Sons")).toBe("acme s plumbing and sons");
    expect(nameKey("THE acme plumbing co")).toBe("acme plumbing");
  });

  it("ignores a branch qualifier in parentheses", () => {
    expect(nameKey("Barnes & Noble (Downtown)")).toBe(nameKey("Barnes and Noble"));
  });

  it("keeps at least one token even when the tail looks corporate", () => {
    expect(nameKey("Kroger Co")).toBe("kroger");
    expect(nameKey("Inc")).toBe("inc");
  });

  it("tolerates empty input", () => {
    expect(nameKey("")).toBe("");
  });
});

describe("tier selection", () => {
  it("prefers phone, then zip+city, then website host, then source id", () => {
    expect(
      dedupKeyFor({
        name: "Joe's Locksmith",
        phone: "512-555-0123",
        postalCode: "78701",
        city: "Austin",
        website: "joeslocks.com",
        source: "osm",
        externalId: "n1",
      }).kind,
    ).toBe("p");

    expect(
      dedupKeyFor({
        name: "Joe's Locksmith",
        postalCode: "78701",
        city: "Austin",
        region: "TX",
        website: "joeslocks.com",
        source: "osm",
        externalId: "n1",
      }).kind,
    ).toBe("z");

    expect(
      dedupKeyFor({
        name: "Joe's Locksmith",
        city: "Austin",
        website: "https://www.joeslocks.com/contact",
        source: "osm",
        externalId: "n1",
      }).kind,
    ).toBe("w");

    expect(
      dedupKeyFor({ name: "Joe's Locksmith", source: "osm", externalId: "node/368053310" }).kind,
    ).toBe("x");

    expect(dedupKeyFor({ name: "Joe's Locksmith", city: "Austin", source: "csv" }).kind).toBe("n");
  });

  it("matches a cross-source pair on zip alone", () => {
    const osm = dedupKeyFor({
      name: "Hill Country Roofing",
      postalCode: "78745-1234",
      city: "Austin",
      region: "Texas",
      source: "osm",
      externalId: "w123",
    });
    const csv = dedupKeyFor({
      name: "Hill Country Roofing LLC",
      postalCode: "78745",
      city: "Austin",
      region: "TX",
      source: "csv",
    });
    expect(osm.kind).toBe("z");
    expect(osm.key).toBe(csv.key);
  });

  it("never keys name+city across sources", () => {
    const osm = dedupKeyFor({ name: "Corner Cafe", city: "Austin", source: "osm" });
    const csv = dedupKeyFor({ name: "Corner Cafe", city: "Austin", source: "csv" });
    expect(osm.kind).toBe("n");
    expect(csv.kind).toBe("n");
    expect(osm.key).not.toBe(csv.key);
    expect(osm.key).toContain(":osm:");
  });

  it("is stable, so re-running a job recognises the same business", () => {
    const input = {
      name: "Rapid Rooter Plumbing",
      phone: "(512) 555-0123",
      source: "osm",
      externalId: "n9",
    };
    expect(dedupKeyFor(input).key).toBe(dedupKeyFor(input).key);
  });

  it("produces short prefixed keys that stay readable in the database", () => {
    const nameOnly = dedupKeyFor({ name: "Any Name", city: "Austin", source: "osm" });
    expect(nameOnly.kind).toBe("n");
    expect(nameOnly.key.startsWith("n:")).toBe(true);
    expect(nameOnly.key.length).toBeLessThan(70);

    const longId = dedupKeyFor({ name: "Any Name", source: "osm", externalId: `node/${"9".repeat(80)}` });
    expect(longId.kind).toBe("x");
    expect(longId.key.length).toBeLessThan(70);
  });
});

describe("generic-name (chain) guard", () => {
  it("flags names that are only trade words", () => {
    expect(isGenericName("plumbing repair")).toBe(true);
    expect(isGenericName("auto cleaning")).toBe(true);
    expect(isGenericName("hvac")).toBe(true);
    expect(isGenericName("acme plumbing")).toBe(false);
  });

  it("keeps a weak last-resort key out of the shared ledger", () => {
    const weak = dedupKeyFor({ name: "Plumbing Repair", city: "Austin", source: "osm" });
    expect(weak.kind).toBe("n");
    expect(weak.ledgerEligible).toBe(false);
  });

  it("keeps a distinctive last-resort key eligible", () => {
    const strong = dedupKeyFor({ name: "Bluish Heron Boutique", city: "Austin", source: "osm" });
    expect(strong.kind).toBe("n");
    expect(strong.ledgerEligible).toBe(true);
  });

  it("trusts stronger tiers even for a generic-sounding name", () => {
    const withPhone = dedupKeyFor({ name: "Plumbing Repair", phone: "512-555-0123", source: "osm" });
    expect(withPhone.kind).toBe("p");
    expect(withPhone.ledgerEligible).toBe(true);
  });
});

describe("alias helpers", () => {
  it("normalises zip codes for the US and keeps international codes", () => {
    expect(zip5("78701-1234")).toBe("78701");
    expect(zip5(" SW1A 1AA ")).toBe("SW1A1AA");
    expect(zip5("unknown")).toBeNull();
  });

  it("builds a comparable city|region key, spelling states the same way", () => {
    expect(cityKey("Austin", "TX")).toBe("austin|tx");
    expect(cityKey("Austin ", "Texas")).toBe("austin|tx");
    expect(cityKey("Austin", "texas.")).toBe("austin|tx");
    expect(cityKey("Austin", null)).toBe("austin");
    expect(cityKey("Toronto", "Ontario")).toBe("toronto|ontario");
    expect(cityKey("", "TX")).toBeNull();
  });

  it("reduces a website to its host", () => {
    expect(websiteHost("https://www.Acme-Plumbing.com/contact?x=1")).toBe("acme-plumbing.com");
    expect(websiteHost("acme.com")).toBe("acme.com");
    expect(websiteHost("http://acme.com")).toBe("acme.com");
    expect(websiteHost(null)).toBeNull();
    expect(websiteHost("")).toBeNull();
    expect(websiteHost("n/a")).toBeNull();
  });

  it("refuses to treat a contact link as a website", () => {
    expect(websiteHost("mailto:sales@acme.com")).toBeNull();
    expect(websiteHost("sales@acme.com")).toBeNull();
    expect(websiteHost("tel:+15125550123")).toBeNull();
    expect(websiteHost("javascript:void(0)")).toBeNull();
  });

  it("formats an address line for display and CSV", () => {
    expect(formatAddress("1200 S Congress Ave", "Austin", "TX", "78704")).toBe(
      "1200 S Congress Ave, Austin, TX 78704",
    );
    expect(formatAddress(null, "Austin", "TX", null)).toBe("Austin, TX");
    expect(formatAddress(null, null, null, null)).toBeNull();
  });
});
