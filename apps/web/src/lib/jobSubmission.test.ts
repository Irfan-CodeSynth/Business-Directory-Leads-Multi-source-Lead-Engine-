import { describe, expect, it } from "vitest";
import { parseJobSubmission } from "./jobSubmission";

const SPEC = { keyword: "plumber", category: "home-services", country: "US", state: "TX", city: "Austin" };

describe("parseJobSubmission", () => {
  it("accepts a structured search and derives the display arrays from it", () => {
    const res = parseJobSubmission({
      sources: ["osm", "yelp"],
      searchSpec: SPEC,
      maxItems: 40,
      leadTarget: 60,
    });
    expect(res).toEqual({
      ok: true,
      value: {
        keywords: ["plumber"],
        locations: ["Austin, TX, United States"],
        searchSpec: { keyword: "plumber", category: "home-services", country: "US", state: "TX", city: "Austin" },
        sources: ["osm", "yelp"],
        maxItems: 40,
        leadTarget: 60,
        importRows: null,
        importLabel: null,
      },
    });
  });

  it("rejects a structured search that fails validation, before a job row exists", () => {
    const res = parseJobSubmission({ sources: ["osm"], searchSpec: { ...SPEC, city: "" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error).toContain("city");
    }
  });

  it("still accepts the legacy keyword x location matrix, minus a spec", () => {
    const res = parseJobSubmission({
      sources: ["hotfrog"],
      keywords: ["plumber", "dentist"],
      locations: ["Austin, TX"],
      maxItems: 25,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.searchSpec).toBeNull();
    expect(res.value.keywords).toEqual(["plumber", "dentist"]);
    expect(res.value.locations).toEqual(["Austin, TX"]);
  });

  it("needs a real place to search when a directory source is picked", () => {
    const noSpec = parseJobSubmission({ sources: ["yelp"] });
    expect(noSpec.ok).toBe(false);
    if (!noSpec.ok) expect(noSpec.error).toContain("keyword");

    const noMatrix = parseJobSubmission({ sources: ["osm"], keywords: [], locations: [] });
    expect(noMatrix.ok).toBe(false);
    if (!noMatrix.ok) expect(noMatrix.error).toContain("keyword");
  });

  it("treats searchSpec as authoritative when both shapes arrive together", () => {
    const res = parseJobSubmission({
      sources: ["osm"],
      searchSpec: SPEC,
      keywords: ["lies"],
      locations: ["Nowhere"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.keywords).toEqual(["plumber"]);
    expect(res.value.locations).toEqual(["Austin, TX, United States"]);
  });

  it("clamps cap and target into the worker's sane range", () => {
    const res = parseJobSubmission({ sources: ["osm"], searchSpec: SPEC, maxItems: 99999, leadTarget: -5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.maxItems).toBe(200);
    expect(res.value.leadTarget).toBe(1);
  });

  it("keeps the import path: csv needs rows, other sources are not required to", () => {
    const good = parseJobSubmission({
      sources: ["csv"],
      importRows: [{ name: "Acme Plumbing" }],
      importLabel: "pasted list",
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.sources).toEqual(["csv"]);
    expect(good.value.importRows).toEqual([{ name: "Acme Plumbing" }]);
    expect(good.value.keywords).toEqual([]);

    const noRows = parseJobSubmission({ sources: ["csv"] });
    expect(noRows.ok).toBe(false);
    if (!noRows.ok) expect(noRows.error).toContain("row");
  });

  it("rejects unknown sources and empty source lists", () => {
    const none = parseJobSubmission({ sources: [] });
    expect(none.ok).toBe(false);

    const bogus = parseJobSubmission({ sources: ["osm", "google"], searchSpec: SPEC });
    expect(bogus.ok).toBe(false);
  });
});
