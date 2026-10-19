import { describe, expect, it } from "vitest";
import { blockedHint, estimateCost, isPaidSource, priceNote, sourceLabel, sourcePrice, usd } from "./sourceMeta";

describe("source labels", () => {
  it("names every source the schema allows", () => {
    expect(["osm", "csv", "yelp", "hotfrog"].map(sourceLabel)).toEqual([
      "OpenStreetMap",
      "CSV import",
      "Yelp",
      "HotFrog",
    ]);
  });

  it("says the source id rather than crashing on an unknown one", () => {
    expect(sourceLabel("google")).toBe("google");
  });
});

describe("estimateCost", () => {
  it("prices a flat-rate paid source per thousand results, to the cent", () => {
    expect(sourcePrice("yelp")).toBe(2.75);
    expect(estimateCost("yelp", 100)).toBe(0.28);
    expect(estimateCost("yelp", 1000)).toBe(2.75);
  });

  it("prices HotFrog by its published tiers, not the cheapest one", () => {
    expect(estimateCost("hotfrog", 100)).toBe(0.3);
    expect(estimateCost("hotfrog", 499)).toBe(1.5);
    // 500 crosses into the $2.00/1k tier.
    expect(estimateCost("hotfrog", 500)).toBe(1);
    expect(estimateCost("hotfrog", 1000)).toBe(2);
    // 1,500 crosses into the $1.00/1k tier.
    expect(estimateCost("hotfrog", 1500)).toBe(1.5);
    expect(estimateCost("hotfrog", 3000)).toBe(3);
  });

  it("costs nothing for a source that does not bill", () => {
    expect(sourcePrice("osm")).toBeNull();
    expect(sourcePrice("csv")).toBeNull();
    expect(estimateCost("osm", 500)).toBe(0);
  });

  it("prices no results at nothing", () => {
    expect(estimateCost("yelp", 0)).toBe(0);
    expect(estimateCost("hotfrog", 0)).toBe(0);
  });
});

describe("priceNote", () => {
  it("names the price and who sends the bill", () => {
    expect(priceNote("yelp")).toBe("$2.75 per 1,000 results · billed by Apify");
    expect(priceNote("hotfrog")).toBe("from $1.00 per 1,000 results · billed by Apify");
  });

  it("says free for a source that does not bill", () => {
    expect(priceNote("osm")).toBe("Free");
    expect(priceNote("csv")).toBe("Free");
  });
});

describe("isPaidSource", () => {
  it("matches the sources the worker meters", () => {
    expect(["osm", "csv", "yelp", "hotfrog"].map(isPaidSource)).toEqual([false, false, true, true]);
  });
});

describe("blockedHint", () => {
  it("blames courtesy for a free source", () => {
    expect(blockedHint("osm")).toMatch(/courtesy window/);
  });

  it("blames the account rather than courtesy for a paid one", () => {
    const note = blockedHint("yelp");
    expect(note).toMatch(/Apify/);
    expect(note).toMatch(/cap/i);
    expect(note).not.toMatch(/courtesy/);
    // A paid source is also blocked when the directory refuses the Actor mid-run, so the
    // hint must not promise that nothing was sent, and must not point only at credit.
    expect(note).not.toMatch(/before any request/);
    expect(note).toMatch(/re-run/i);
  });
});

describe("usd", () => {
  it("always shows two decimals so a column of prices lines up", () => {
    expect(usd(0.28)).toBe("$0.28");
    expect(usd(2)).toBe("$2.00");
    expect(usd(0)).toBe("$0.00");
  });
});
