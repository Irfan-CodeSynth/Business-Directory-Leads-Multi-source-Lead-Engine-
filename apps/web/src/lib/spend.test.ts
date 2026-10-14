import { afterEach, describe, expect, it } from "vitest";
import { isApifyConfigured, monthStart, monthlyResultCap } from "./spend";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("monthlyResultCap", () => {
  it("falls back to the default when the env is missing or nonsense", () => {
    delete process.env.APIFY_MONTHLY_RESULT_CAP;
    expect(monthlyResultCap()).toBe(1500);
    process.env.APIFY_MONTHLY_RESULT_CAP = "not a number";
    expect(monthlyResultCap()).toBe(1500);
    process.env.APIFY_MONTHLY_RESULT_CAP = "0";
    expect(monthlyResultCap()).toBe(1500);
    process.env.APIFY_MONTHLY_RESULT_CAP = "-5";
    expect(monthlyResultCap()).toBe(1500);
  });

  it("uses a positive whole number from the env", () => {
    process.env.APIFY_MONTHLY_RESULT_CAP = "400";
    expect(monthlyResultCap()).toBe(400);
  });
});

describe("monthStart", () => {
  it("is the 1st at midnight, not the day", () => {
    expect(monthStart(new Date(2026, 9, 17, 14, 30, 45))).toEqual(new Date(2026, 9, 1));
  });

  it("stays inside its own month on the 1st", () => {
    expect(monthStart(new Date(2026, 9, 1, 0, 0, 1))).toEqual(new Date(2026, 9, 1));
  });
});

describe("isApifyConfigured", () => {
  it("counts a blank .env line as missing", () => {
    delete process.env.APIFY_API_TOKEN;
    expect(isApifyConfigured()).toBe(false);
    process.env.APIFY_API_TOKEN = "   ";
    expect(isApifyConfigured()).toBe(false);
  });

  it("is configured once a token is present", () => {
    process.env.APIFY_API_TOKEN = "apify_api_dummy";
    expect(isApifyConfigured()).toBe(true);
  });
});
