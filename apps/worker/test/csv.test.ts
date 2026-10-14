import { describe, expect, it } from "vitest";
import { createCsvAdapter, rowToLead, type CsvRow } from "../src/adapters/csv.js";
import { makeBudget, type RawLead, type SearchArgs, type SearchHooks } from "../src/adapters/types.js";

const args = (over: Partial<SearchArgs> = {}): SearchArgs => ({
  keyword: "import",
  location: "",
  maxItems: 500,
  ...over,
});

/** Collects what the adapter emits, and lets a test stop it after N leads. */
function collector(stopAfter?: number) {
  const emitted: RawLead[] = [];
  const logs: string[] = [];
  let seen = 0;
  const hooks: SearchHooks = {
    emit: async (raw) => {
      emitted.push(raw);
      seen++;
    },
    budget: makeBudget(Number.POSITIVE_INFINITY),
    log: (message) => logs.push(message),
    shouldStop: () => stopAfter != null && seen >= stopAfter,
  };
  return { hooks, emitted, logs, spent: () => hooks.budget.spent() };
}

describe("rowToLead", () => {
  it("accepts the column spellings and header case a real export uses", () => {
    const lead = rowToLead(
      {
        Business: "Acme Plumbing ",
        Telephone: "(512) 555-0142",
        site: "acmeplumbing.com",
        address1: "1 Main St",
        State: "TX",
        ZIP: "78701",
        industry: "Plumber",
      },
      "j1r0",
    );
    expect(lead).toMatchObject({
      externalId: "j1r0",
      name: "Acme Plumbing",
      phone: "(512) 555-0142",
      website: "acmeplumbing.com",
      address: "1 Main St",
      region: "TX",
      postalCode: "78701",
      category: "Plumber",
    });
  });

  it("splits several emails from one cell and keeps the social columns", () => {
    const lead = rowToLead(
      {
        name: "Acme Plumbing",
        emails: "dispatch@acmeplumbing.com, owner@acmeplumbing.com",
        instagram: "https://instagram.com/acmeplumb",
        tiktok_url: "https://tiktok.com/@acmeplumb",
      },
      "j1r0",
    );
    expect(lead?.emails).toEqual(["dispatch@acmeplumbing.com", "owner@acmeplumbing.com"]);
    expect(lead?.socials).toEqual({
      instagram: "https://instagram.com/acmeplumb",
      tiktok: "https://tiktok.com/@acmeplumb",
    });
  });

  it("drops a row with no name and keeps the original cells for debugging", () => {
    expect(rowToLead({ phone: "(512) 555-0142" }, "j1r0")).toBeNull();
    const lead = rowToLead({ name: "Acme Plumbing", weird_column: "kept" }, "j1r0");
    expect(lead?.extra).toEqual({ row: { name: "Acme Plumbing", weird_column: "kept" } });
  });
});

describe("createCsvAdapter", () => {
  const rows: CsvRow[] = [
    { name: "One Co", phone: "(512) 555-0101" },
    { phone: "(512) 555-0102" },
    { name: "Three Co", phone: "(512) 555-0103" },
    { name: "Four Co", phone: "(512) 555-0104" },
  ];

  it("numbers rows within their job, and logs the row it could not use", async () => {
    const { hooks, emitted, logs } = collector();
    const outcome = await createCsvAdapter(rows, 7).search(args(), hooks);

    expect(outcome).toMatchObject({ emitted: 3, requestsUsed: 0, stopped: false });
    expect(emitted.map((l) => l.externalId)).toEqual(["j7r0", "j7r2", "j7r3"]);
    expect(logs).toEqual(["csv: row 2 has no name; skipped"]);
  });

  it("respects the cap and a stop request", async () => {
    const capped = collector();
    expect(await createCsvAdapter(rows, 1).search(args({ maxItems: 2 }), capped.hooks)).toMatchObject({
      emitted: 2,
      stopped: false,
    });

    const stopped = collector(1);
    const outcome = await createCsvAdapter(rows, 1).search(args(), stopped.hooks);
    expect(outcome).toMatchObject({ emitted: 1, stopped: true });
  });

  it("makes no requests at all", async () => {
    const { hooks, spent } = collector();
    await createCsvAdapter(rows, 1).search(args(), hooks);
    expect(spent()).toBe(0);
  });
});
