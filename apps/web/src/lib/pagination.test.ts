import { describe, it, expect } from "vitest";
import { PAGE_SIZE, normalizePage, slicePage, totalPages, pageWindow, rangeText } from "./pagination";

describe("totalPages", () => {
  it("is never zero, so an empty collection still has one page", () => {
    expect(totalPages(0)).toBe(1);
  });

  it("rounds up", () => {
    expect(totalPages(PAGE_SIZE)).toBe(1);
    expect(totalPages(11)).toBe(2);
    expect(totalPages(108)).toBe(11);
  });
});

describe("normalizePage", () => {
  it("clamps garbage and out-of-range values into a real page", () => {
    expect(normalizePage(NaN, 5)).toBe(1);
    expect(normalizePage(0, 5)).toBe(1);
    expect(normalizePage(-3, 5)).toBe(1);
    expect(normalizePage(9, 5)).toBe(5);
    expect(normalizePage(3, 5)).toBe(3);
  });

  it("returns 1 when there are no pages at all", () => {
    expect(normalizePage(4, 0)).toBe(1);
  });
});

describe("slicePage", () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);

  it("takes exactly one page, from the right offset", () => {
    expect(slicePage(items, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(slicePage(items, 3)).toEqual([21, 22, 23, 24, 25]);
  });

  it("returns nothing for a page past the end instead of wrapping", () => {
    expect(slicePage(items, 4)).toEqual([]);
    expect(slicePage([], 1)).toEqual([]);
  });
});

describe("pageWindow", () => {
  it("lists every page while the list is short enough", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses long lists to first, current neighbours and last", () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, "…", 12]);
    expect(pageWindow(6, 12)).toEqual([1, "…", 5, 6, 7, "…", 12]);
    expect(pageWindow(12, 12)).toEqual([1, "…", 11, 12]);
  });

  it("never repeats a page number when the window touches an edge", () => {
    expect(pageWindow(2, 12)).toEqual([1, 2, 3, "…", 12]);
    expect(pageWindow(11, 12)).toEqual([1, "…", 10, 11, 12]);
  });
});

describe("rangeText", () => {
  it("names the visible slice out of the whole", () => {
    expect(rangeText(108, 1)).toBe("Showing 1–10 of 108");
    expect(rangeText(108, 2)).toBe("Showing 11–20 of 108");
    expect(rangeText(108, 11)).toBe("Showing 101–108 of 108");
  });

  it("says none when a filter leaves the page empty", () => {
    expect(rangeText(0, 1)).toBe("Showing 0 of 0");
  });
});
