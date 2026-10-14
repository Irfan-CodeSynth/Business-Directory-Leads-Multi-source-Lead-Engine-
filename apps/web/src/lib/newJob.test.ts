import { describe, expect, it } from "vitest";
import { buildJobRequest, estimateRun, leadCapacity, type JobFormState } from "./newJob";

/** The state the Discover tab starts with: one source chip picked, nothing pasted. */
function discover(over: Partial<JobFormState> = {}): JobFormState {
  return {
    tab: "discover",
    sources: ["osm"],
    keywords: ["plumber"],
    locations: ["Austin, TX"],
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
  it("sends the csv source and only the named rows for an import", () => {
    const res = buildJobRequest(imported(LIST));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.sources).toEqual(["csv"]);
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

  it("sends keywords and locations for a discovery run without any import rows", () => {
    const res = buildJobRequest(discover({ sources: ["osm"], cap: 40 }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body).toEqual({
      keywords: ["plumber"],
      locations: ["Austin, TX"],
      sources: ["osm"],
      maxItems: 40,
      leadTarget: 100,
      importRows: undefined,
      importLabel: null,
    });
  });

  it("sends how many new leads each source is asked for", () => {
    const res = buildJobRequest(discover({ target: 60 }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.leadTarget).toBe(60);
  });

  it("still sends the target for an import, where the worker ignores it", () => {
    const res = buildJobRequest(imported(LIST, { target: 30 }));
    if (!res.ok) throw new Error(res.error);
    expect(res.body.leadTarget).toBe(30);
  });

  it("refuses a discovery run with no source picked", () => {
    expect(buildJobRequest(discover({ sources: [] }))).toEqual({ ok: false, error: "Pick at least one source" });
  });

  it("refuses a discovery run that is missing keywords or locations", () => {
    expect(buildJobRequest(discover({ locations: [] }))).toEqual({
      ok: false,
      error: "Discovery needs at least one keyword and one location",
    });
    // The paid sources ask the same question of the same matrix, so they need it too.
    expect(buildJobRequest(discover({ sources: ["yelp"], keywords: [] }))).toEqual({
      ok: false,
      error: "Discovery needs at least one keyword and one location",
    });
  });

  it("refuses more keywords or locations than the API accepts", () => {
    const many = Array.from({ length: 21 }, (_, i) => `term ${i}`);
    expect(buildJobRequest(discover({ keywords: many }))).toEqual({
      ok: false,
      error: "Too many keywords or locations (max 20 each)",
    });
  });
});

describe("estimateRun", () => {
  it("prices a paid run at the Actor's published rate", () => {
    const state = discover({
      sources: ["yelp"],
      keywords: ["plumber", "dentist"],
      locations: ["Austin, TX", "Dallas, TX"],
      cap: 25,
    });
    expect(estimateRun(state, Number.POSITIVE_INFINITY)).toEqual({
      items: [{ source: "yelp", label: "Yelp", results: 100, usd: 0.28 }],
      usd: 0.28,
      over: 0,
    });
  });

  it("costs nothing when only free sources are picked", () => {
    expect(estimateRun(discover({ sources: ["osm", "csv"] }), 0)).toEqual({ items: [], usd: 0, over: 0 });
  });

  it("shares one monthly allowance between the paid sources of a run", () => {
    const state = discover({ sources: ["yelp", "hotfrog"], keywords: ["plumber"], locations: ["Austin, TX"], cap: 25 });
    const estimate = estimateRun(state, 30);
    expect(estimate.items.map((item) => item.results)).toEqual([25, 25]);
    // Yelp 25 x $2.75/1k = $0.07; HotFrog 25 is under its 500-result tier: 25 x $3.00/1k = $0.08.
    expect(estimate.usd).toBe(0.15);
    // 50 results wanted against 30 left in the month: the worker will stop at the cap.
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
  it("says how far short of the target a thin plan is", () => {
    const state = discover({ keywords: ["plumber"], locations: ["Austin, TX"], cap: 25, target: 100 });
    expect(leadCapacity(state)).toEqual({ ceiling: 25, short: 75 });
  });

  it("counts the queries a plan actually makes", () => {
    const state = discover({ keywords: ["plumber", "dentist"], locations: ["Austin, TX", "Dallas, TX"], cap: 25, target: 100 });
    expect(leadCapacity(state)).toEqual({ ceiling: 100, short: 0 });
  });

  it("stops counting at the target, because the run ends there", () => {
    const state = discover({ keywords: ["a", "b", "c", "d", "e"], cap: 200, target: 100 });
    expect(leadCapacity(state)).toEqual({ ceiling: 100, short: 0 });
  });

  it("is honest about a source with no listings to offer", () => {
    expect(leadCapacity(discover({ keywords: [], locations: [] }))).toEqual({ ceiling: 0, short: 100 });
  });

  it("says nothing about the import tab, which already has its rows", () => {
    expect(leadCapacity(imported(LIST))).toEqual({ ceiling: 0, short: 0 });
  });
});
