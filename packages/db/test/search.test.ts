import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  COUNTRIES,
  categoryById,
  countryName,
  isSearchSpec,
  locationLine,
  parseSearchSpec,
} from "../src/search.js";

describe("COUNTRIES", () => {
  it("covers the countries the paid sources serve", () => {
    const codes = new Set(COUNTRIES.map((c) => c.code));
    for (const expected of ["US", "CA", "GB", "AU", "DE", "FR", "PK", "IN", "AE", "NL"]) {
      expect(codes.has(expected)).toBe(true);
    }
  });

  it("uses well-known display names Nominatim also understands", () => {
    expect(countryName("US")).toBe("United States");
    expect(countryName("GB")).toBe("United Kingdom");
    expect(countryName("AU")).toBe("Australia");
  });

  it("normalises the lookup to uppercase", () => {
    expect(countryName("us")).toBe("United States");
    expect(countryName("gb")).toBe("United Kingdom");
  });

  it("returns null for an unknown code instead of guessing", () => {
    expect(countryName("XX")).toBeNull();
    expect(countryName("")).toBeNull();
  });

  it("has no duplicate codes and every code is ISO alpha-2 shape", () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe("CATEGORIES", () => {
  it("offers the curated groups plus an explicit any", () => {
    const ids = CATEGORIES.map((c) => c.id);
    for (const expected of [
      "home-services",
      "health-medical",
      "legal-financial",
      "real-estate",
      "beauty-wellness",
      "automotive",
      "food-restaurants",
      "retail",
      "any",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("every category carries OSM tag clauses in Overpass shape", () => {
    for (const cat of CATEGORIES) {
      expect(Array.isArray(cat.osmTags)).toBe(true);
      for (const tag of cat.osmTags) {
        expect(tag.startsWith('["')).toBe(true);
        expect(tag.endsWith('"]')).toBe(true);
        expect(tag).toContain("=");
      }
    }
  });

  it("any is the empty selector — it adds no clauses of its own", () => {
    expect(categoryById("any")?.osmTags).toEqual([]);
  });

  it("looks categories up by id, unknown ids give null", () => {
    expect(categoryById("home-services")?.label).toBe("Home Services");
    expect(categoryById("nope")).toBeNull();
  });
});

describe("parseSearchSpec", () => {
  it("accepts a complete spec and trims whitespace", () => {
    const parsed = parseSearchSpec({
      keyword: "  plumber ",
      category: "home-services",
      country: "us",
      state: " TX ",
      city: " Austin ",
    });
    expect(parsed).toEqual({
      ok: true,
      spec: {
        keyword: "plumber",
        category: "home-services",
        country: "US",
        state: "TX",
        city: "Austin",
      },
    });
  });

  it("treats state as optional and defaults category to any", () => {
    const parsed = parseSearchSpec({ keyword: "bakery", country: "GB", city: "Leeds" });
    expect(parsed).toEqual({
      ok: true,
      spec: { keyword: "bakery", category: "any", country: "GB", state: null, city: "Leeds" },
    });
  });

  it("rejects a spec with no keyword, city, or country", () => {
    for (const missing of [
      { keyword: "", country: "US", city: "Austin" },
      { keyword: "plumber", country: "", city: "Austin" },
      { keyword: "plumber", country: "US", city: "  " },
    ]) {
      const parsed = parseSearchSpec(missing);
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects a country code the directory sources cannot place", () => {
    const parsed = parseSearchSpec({ keyword: "plumber", country: "XX", city: "Austin" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("country");
  });

  it("rejects a category outside the curated list", () => {
    const parsed = parseSearchSpec({ keyword: "plumber", country: "US", city: "Austin", category: "crypto" });
    expect(parsed.ok).toBe(false);
  });
});

describe("isSearchSpec", () => {
  it("accepts a spec produced by parseSearchSpec", () => {
    const parsed = parseSearchSpec({ keyword: "bakery", country: "GB", city: "Leeds" });
    if (parsed.ok) expect(isSearchSpec(parsed.spec)).toBe(true);
  });

  it("rejects partial or wrongly typed shapes", () => {
    expect(isSearchSpec(null)).toBe(false);
    expect(isSearchSpec({ keyword: "x", country: "US" })).toBe(false);
    expect(isSearchSpec({ keyword: 1, category: "any", country: "US", state: null, city: "Leeds" })).toBe(false);
  });
});

describe("locationLine", () => {
  it("joins city, state, and country name for geocoders", () => {
    expect(locationLine({ keyword: "x", category: "any", country: "US", state: "TX", city: "Austin" }, "full")).toBe(
      "Austin, TX, United States",
    );
    expect(locationLine({ keyword: "x", category: "any", country: "GB", state: null, city: "Leeds" }, "full")).toBe(
      "Leeds, United Kingdom",
    );
  });

  it("short form drops the country, which paid actors take as a separate field", () => {
    expect(
      locationLine({ keyword: "x", category: "any", country: "US", state: "TX", city: "Austin" }, "short"),
    ).toBe("Austin, TX");
    expect(locationLine({ keyword: "x", category: "any", country: "AU", state: null, city: "Perth" }, "short")).toBe(
      "Perth",
    );
  });
});
