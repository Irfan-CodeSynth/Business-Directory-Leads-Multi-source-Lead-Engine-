import { describe, expect, it } from "vitest";
import { buildJobRequest, estimateRun, leadCapacity, type JobFormState } from "./newJob";

/** The state the Discover tab starts with: one source chip picked, nothing typed yet. */
function discover(over: Partial<JobFormState> = {}): JobFormState {
  return {
    tab: "discover",
    sources: ["osm"],
    keyword: "plumber",
    category: "home-services",
    country: "US",
    state: "TX",
    city: "Austin",
    cap: 25,
    target: 100,
    rows: [],
    mapping: {},
    label: "",
    ...over,
  };
}

function imported(rows: Record<string, string>[], over: Partial<JobFormState> = {}): JobFormState {
  return discover({
    tab: "import",
    rows,
    mapping: { name: "Business Name", phone: "Phone", email: "Email", city: "City" },
    ...over,
  });
}

const LIST: Record<string, string>[] = [
  { "Business Name": "Acme Plumbing", Phone: "512-555-0123", Email: "jobs@acme.example", City: "Austin" },
  { Phone: "512-555-0199", Email: "nobody@example.example" },
  { "Business Name": "Bowie Roofing", Phone: "512-555-0144", Email: "roof@bowie.example", City: "Austin" },
];

describe("buildJobRequest", () => {
  it("sends the structured spec plus display arrays a run row renders", () => {
    const res = buildJobRequest(discover({ sources: ["osm", "yelp"], cap: 40 }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.searchSpec).toEqual({
      keyword: "plumber",
      category: "home-services",
      country: "US",
      state: "TX",
      city: "Austin",
    });
    // keywords/locations stay filled so the Runs pages read like the one-query run this is.
    expect(res.body.keywords).toEqual(["plumber"]);
    expect(res.body.locations).toEqual(["Austin, TX, United States"]);
    expect(res.body.sources).toEqual(["osm", "yelp"]);
    expect(res.body.maxItems).toBe(40);
    expect(res.body.leadTarget).toBe(100);
    expect(res.body.importRows).toBeUndefined();
    expect(res.body.importLabel).toBeNull();
  });

  it("normalises a lowercase country code and a blank category", () => {
    const res = buildJobRequest(discover({ country: "gb", state: "", city: "Leeds", category: "" }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.searchSpec).toEqual({
      keyword: "plumber",
      category: "any",
      country: "GB",
      state: null,
      city: "Leeds",
    });
    expect(res.body.locations).toEqual(["Leeds, United Kingdom"]);
  });

  it("refuses a discovery run with no source picked", () => {
    expect(buildJobRequest(discover({ sources: [] }))).toEqual({ ok: false, error: "Pick at least one source" });
  });

  it("refuses a discovery run missing the keyword, city, or country", () => {
    const noKeyword = buildJobRequest(discover({ keyword: "  " }));
    expect(noKeyword.ok).toBe(false);
    if (!noKeyword.ok) expect(noKeyword.error).toContain("keyword");

    const noCity = buildJobRequest(discover({ city: "" }));
    expect(noCity.ok).toBe(false);
    if (!noCity.ok) expect(noCity.error).toContain("city");

    const noCountry = buildJobRequest(discover({ country: "" }));
    expect(noCountry.ok).toBe(false);
    if (!noCountry.ok) expect(noCountry.error).toContain("country");
  });

  it("refuses a country or category the directories cannot place", () => {
    const badCountry = buildJobRequest(discover({ country: "XX" }));
    expect(badCountry.ok).toBe(false);
    if (!badCountry.ok) expect(badCountry.error).toContain("country");

    const badCategory = buildJobRequest(discover({ category: "crypto" }));
    expect(badCategory.ok).toBe(false);
    if (!badCategory.ok) expect(badCategory.error).toContain("category");
  });

  it("sends the csv source and only the named rows for an import", () => {
    const res = buildJobRequest(imported(LIST));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.sources).toEqual(["csv"]);
    expect(res.body.searchSpec).toBeNull();
    expect(res.body.keywords).toEqual([]);
    expect(res.body.locations).toEqual([]);
    expect(res.body.importRows).toEqual([
      { name: "Acme Plumbing", phone: "512-555-0123", email: "jobs@acme.example", city: "Austin" },
      { name: "Bowie Roofing", phone: "512-555-0144", email: "roof@bowie.example", city: "Austin" },
    ]);
  });

  // The Import tab does not touch the source chips, so `sources` can still hold ["osm"].
  it("ignores the discover chips when the Import tab is showing", () => {
    const res = buildJobRequest(imported(LIST, { sources: ["osm"] }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.sources).toEqual(["csv"]);
  });

  it("labels a pasted list so the run says where it came from", () => {
    const res = buildJobRequest(imported(LIST, { label: "HotFrog Austin plumbers" }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.importLabel).toBe("HotFrog Austin plumbers");
  });

  it("falls back to 'pasted list' when the label is blank", () => {
    const res = buildJobRequest(imported(LIST, { label: "  " }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.importLabel).toBe("pasted list");
  });

  it("refuses an import whose name column is not mapped", () => {
    const res = buildJobRequest(imported(LIST, { mapping: { phone: "Phone" } }));
    expect(res).toEqual({ ok: false, error: "Pick which column holds the business name" });
  });

  it("refuses an import where every row is nameless", () => {
    const res = buildJobRequest(imported([{ Phone: "512-555-0199" }]));
    expect(res).toEqual({ ok: false, error: "No row in that list has a business name" });
  });

  it("refuses an import before anything is pasted", () => {
    const res = buildJobRequest(imported([]));
    expect(res).toEqual({ ok: false, error: "The CSV import has no rows yet" });
  });

  it("sends how many new leads each source is asked for", () => {
    const res = buildJobRequest(discover({ target: 60 }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.leadTarget).toBe(60);
  });
});

describe("estimateRun", () => {
  it("prices one paid query at the Actor's published rate", () => {
    const state = discover({ sources: ["yelp"], cap: 25, target: 100 });
    expect(estimateRun(state, Number.POSITIVE_INFINITY)).toEqual({
      items: [{ source: "yelp", label: "Yelp", results: 25, usd: 0.07 }],
      usd: 0.07,
      over: 0,
    });
  });

  it("costs nothing when only free sources are picked", () => {
    expect(estimateRun(discover({ sources: ["osm", "csv"] }), 0)).toEqual({ items: [], usd: 0, over: 0 });
  });

  it("shares one monthly allowance between the paid sources of a run", () => {
    const state = discover({ sources: ["yelp", "hotfrog"], cap: 25, target: 100 });
    const estimate = estimateRun(state, 30);
    expect(estimate.items.map((item) => item.results)).toEqual([25, 25]);
    // Yelp 25 x $2.75/1k = $0.07; HotFrog 25 x $3.00/1k = $0.08.
    expect(estimate.usd).toBe(0.15);
    // 50 results wanted against 30 left in the month: the worker stops at the cap.
    expect(estimate.over).toBe(20);
  });

  it("ignores the import tab, which cannot spend anything", () => {
    expect(estimateRun(imported(LIST, { sources: ["yelp"] }), 10)).toEqual({ items: [], usd: 0, over: 0 });
  });

  it("never prices results the lead target would throw away", () => {
    const state = discover({ sources: ["yelp"], cap: 200, target: 30 });
    // One query asking for 200 rows, for a run that stops after 30 new leads: the extra
    // 170 would be billed by Apify and discarded, so they are not part of the plan.
    expect(estimateRun(state).items.map((item) => item.results)).toEqual([30]);
  });
});

describe("leadCapacity", () => {
  it("says how far short of the target one query can land", () => {
    const state = discover({ cap: 25, target: 100 });
    expect(leadCapacity(state)).toEqual({ ceiling: 25, short: 75 });
  });

  it("stops counting at the target, because the run ends there", () => {
    const state = discover({ cap: 200, target: 100 });
    expect(leadCapacity(state)).toEqual({ ceiling: 100, short: 0 });
  });

  it("is zero until the run has a place to look", () => {
    expect(leadCapacity(discover({ city: "" }))).toEqual({ ceiling: 0, short: 100 });
  });

  it("says nothing about the import tab, which already has its rows", () => {
    expect(leadCapacity(imported(LIST))).toEqual({ ceiling: 0, short: 0 });
  });
});
