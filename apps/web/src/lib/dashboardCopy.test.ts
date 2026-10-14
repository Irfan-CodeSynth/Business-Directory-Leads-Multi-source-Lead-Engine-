import { describe, expect, it } from "vitest";
import { overlapNote } from "./dashboardCopy";

describe("overlapNote", () => {
  it("says nothing when every business came from a single source", () => {
    expect(overlapNote(0)).toBeNull();
  });

  it("uses the singular for one business", () => {
    expect(overlapNote(1)).toBe("1 business also found on another source");
  });

  it("uses the plural, and counts businesses rather than listings", () => {
    expect(overlapNote(4)).toBe("4 businesses also found on another source");
  });
});
