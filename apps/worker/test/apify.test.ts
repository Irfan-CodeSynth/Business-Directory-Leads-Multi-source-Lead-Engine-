import { describe, expect, it } from "vitest";
import { BlockedError, makeBudget, makeSpend, type RawLead, type SearchArgs, type SearchHooks } from "../src/adapters/types.js";
import {
  buildActorInput,
  createApifyAdapter,
  itemToLead,
  parseDatasetItems,
  toCountryCode,
  type ApifyConfig,
  type ApifyItem,
} from "../src/adapters/apify.js";

/**
 * Item shapes are the ones the two Actors publish in their output examples
 * (`memo23/yelp-scraper`, `solidcode/hotfrog-scraper`). Nothing here touches the
 * network: every request is answered by the injected fetcher below.
 */
const yelpItem = (over: ApifyItem = {}): ApifyItem => ({
  title: "Joe's Plumbing",
  yelp_biz_id: "joes-plumbing-austin",
  phoneNumber: "(512) 555-0142",
  website: "https://joesplumbing.com",
  url: "https://www.yelp.com/biz/joes-plumbing-austin",
  fullAddress: "1200 E 6th St",
  city: "Austin",
  state: "TX",
  zipcode: "78702",
  categories: ["Plumbing", "Hydro Jetting"],
  rating: 4.5,
  reviewCount: "509 reviews",
  isClaimed: true,
  ...over,
});

const hotfrogItem = (over: ApifyItem = {}): ApifyItem => ({
  name: "Acme Roofing",
  phone: "+1 512-555-0188",
  email: "office@acmeroofing.com",
  website: "https://acmeroofing.com",
  url: "https://www.hotfrog.com/profile/acme-roofing-austin",
  streetAddress: "4400 Burnet Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78756",
  category: "Roofing Contractors",
  socialLinks: { facebook: "https://www.facebook.com/acmeroofing" },
  ...over,
});

const testConfig: ApifyConfig = {
  token: "apify-token",
  baseUrl: "https://api.apify.com/v2",
  yelpActor: "memo23/yelp-scraper",
  hotfrogActor: "solidcode/hotfrog-scraper",
  country: "United States",
  runTimeoutS: 300,
  pollIntervalMs: 5000,
};

/** An unanswered step repeats the last entry, so one value means "always this". */
type Steps = unknown | unknown[];

function stubFetch(api: {
  run: Steps;
  items: unknown;
  poll?: Steps;
  statuses?: { run?: number; poll?: number; items?: number };
}) {
  const calls: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const taken = { run: 0, poll: 0 };
  const at = (steps: Steps, key: "run" | "poll"): { body: unknown } => {
    const list = Array.isArray(steps) ? steps : [steps];
    const index = Math.min(taken[key]++, list.length - 1);
    return { body: list[index] };
  };
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    // A POST to `/runs` starts the Actor, a GET on `/runs/<id>` asks how it went, and a
    // GET on `/datasets/<id>/items` reads what it wrote.
    const kind = method === "POST" ? "run" : url.includes("/datasets/") ? "items" : "poll";
    const step =
      kind === "run" ? at(api.run, "run") : kind === "poll" ? at(api.poll ?? api.run, "poll") : { body: api.items };
    const status = api.statuses?.[kind] ?? 200;
    return { status, ok: status < 400, headers: new Headers(), text: async () => JSON.stringify(step.body) } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function harness(options: {
  source: "yelp" | "hotfrog";
  items?: ApifyItem[];
  runBody?: unknown;
  pollBody?: unknown;
  statuses?: { run?: number; poll?: number; items?: number };
  spend?: ReturnType<typeof makeSpend>;
  config?: ApifyConfig;
}) {
  const run = options.runBody ?? { id: "run1", defaultDatasetId: "ds1", status: "SUCCEEDED" };
  const { fetchFn, calls } = stubFetch({
    run,
    poll: options.pollBody,
    items: options.items ?? [],
    statuses: options.statuses,
  });
  const leads: RawLead[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const hooks: SearchHooks = {
    emit: (lead) => void leads.push(lead),
    budget: makeBudget(50),
    log: (message) => void logs.push(message),
    shouldStop: () => false,
  };
  const adapter = createApifyAdapter({
    source: options.source,
    config: options.config ?? testConfig,
    fetch: fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    spend: options.spend ?? makeSpend(Number.POSITIVE_INFINITY, 0),
  });
  return { adapter, leads, logs, calls, hooks, sleeps };
}

const unit = { keyword: "plumber", location: "Austin, TX", maxItems: 25 };

describe("itemToLead: yelp", () => {
  it("maps a published listing onto the lead columns", () => {
    const lead = itemToLead("yelp", yelpItem())!;
    expect(lead).toMatchObject({
      externalId: "yelp:joes-plumbing-austin",
      name: "Joe's Plumbing",
      phone: "(512) 555-0142",
      website: "https://joesplumbing.com",
      profileUrl: "https://www.yelp.com/biz/joes-plumbing-austin",
      address: "1200 E 6th St",
      city: "Austin",
      region: "TX",
      postalCode: "78702",
      category: "Plumbing",
      rating: 4.5,
      reviewCount: 509,
      emails: [],
    });
  });

  it("numbers a review count the actor published as prose", () => {
    expect(itemToLead("yelp", yelpItem({ reviewCount: "1,204 reviews" }))!.reviewCount).toBe(1204);
    expect(itemToLead("yelp", yelpItem({ reviewCount: 37 }))!.reviewCount).toBe(37);
    expect(itemToLead("yelp", yelpItem({ reviewCount: null }))!.reviewCount).toBeNull();
  });

  it("drops a row that is not a business", () => {
    expect(itemToLead("yelp", { review_insights: { themes: ["slow"] } })).toBeNull();
    expect(itemToLead("yelp", { title: "   " })).toBeNull();
  });

  it("keys a listing on something a re-run would recognise", () => {
    // A positional id would make the same business new again on every re-run, so the
    // fallbacks have to be content: the listing url, then the name and phone.
    expect(itemToLead("yelp", yelpItem({ yelp_biz_id: undefined }))!.externalId).toBe(
      "yelp:https://www.yelp.com/biz/joes-plumbing-austin",
    );
    const idless = yelpItem({ yelp_biz_id: undefined, url: undefined });
    expect(itemToLead("yelp", idless)!.externalId).toBe("yelp:joe's plumbing|(512) 555-0142");
  });
});

describe("itemToLead: hotfrog", () => {
  it("keeps the contact details HotFrog itself publishes", () => {
    const lead = itemToLead("hotfrog", hotfrogItem())!;
    expect(lead).toMatchObject({
      externalId: "hotfrog:https://www.hotfrog.com/profile/acme-roofing-austin",
      name: "Acme Roofing",
      phone: "+1 512-555-0188",
      address: "4400 Burnet Rd",
      city: "Austin",
      region: "TX",
      postalCode: "78756",
      category: "Roofing Contractors",
      emails: ["office@acmeroofing.com"],
    });
    expect(lead.rating).toBeNull();
  });

  it("splits a cell that holds several emails", () => {
    const lead = itemToLead("hotfrog", hotfrogItem({ email: "a@acme.com; b@acme.com" }))!;
    expect(lead.emails).toEqual(["a@acme.com", "b@acme.com"]);
  });

  it("names each social link whatever shape the listing published it in", () => {
    const mapped = itemToLead("hotfrog", hotfrogItem())!;
    expect(mapped.socials).toEqual({ facebook: "https://www.facebook.com/acmeroofing" });

    const asArray = itemToLead(
      "hotfrog",
      hotfrogItem({
        socialLinks: ["https://www.instagram.com/acmeroofing", "https://x.com/acmeroofing", "not a url"],
      }))!;
    expect(asArray.socials).toEqual({
      instagram: "https://www.instagram.com/acmeroofing",
      twitter: "https://x.com/acmeroofing",
    });
  });

  it("unwraps the Python-repr phone array HotFrog actually publishes", () => {
    const lead = itemToLead("hotfrog", hotfrogItem({ phone: "['+12014510049']" }))!;
    expect(lead.phone).toBe("+12014510049");
  });

  it("takes the first of several published numbers, whatever carries them", () => {
    const repr = itemToLead("hotfrog", hotfrogItem({ phone: "['+1868300931', '+18685550123']" }))!;
    expect(repr.phone).toBe("+1868300931");
    const asArray = itemToLead("hotfrog", hotfrogItem({ phone: ["+1868300931", "+18685550123"] }))!;
    expect(asArray.phone).toBe("+1868300931");
    const asJson = itemToLead("hotfrog", hotfrogItem({ phone: '["+1868300931"]' }))!;
    expect(asJson.phone).toBe("+1868300931");
  });

  it("keeps a plain phone string untouched and a missing one null", () => {
    expect(itemToLead("yelp", yelpItem({ phoneNumber: "(512) 555-0142" }))!.phone).toBe("(512) 555-0142");
    expect(itemToLead("hotfrog", hotfrogItem({ phone: null }))!.phone).toBeNull();
    expect(itemToLead("hotfrog", hotfrogItem({ phone: "[]" }))!.phone).toBeNull();
  });
});

describe("itemToLead: what may never be stored", () => {
  it("strips review text even when the actor returns it", () => {
    const lead = itemToLead(
      "yelp",
      yelpItem({
        reviews: [{ reviewId: "r1", text: "Worst service ever", user: { name: "Bob" } }],
        reviewhighlights: ["Worst service ever"],
        review_insights: { themes: ["slow"] },
        painPointAnalysis: { pains: ["no same-day service"] },
      }))!;
    expect(Object.keys(lead.extra!).sort()).toEqual(
      ["categories", "city", "fullAddress", "isClaimed", "phoneNumber", "rating", "reviewCount", "state", "title", "url", "website", "yelp_biz_id", "zipcode"].sort(),
    );
    expect(JSON.stringify(lead.extra)).not.toContain("Worst service ever");
    // The rating and its count are kept: they describe the business, not its customers.
    expect(lead.extra).toMatchObject({ rating: 4.5, reviewCount: "509 reviews" });
  });

  it("strips review text from a HotFrog listing too", () => {
    const lead = itemToLead(
      "hotfrog",
      hotfrogItem({ reviews: [{ text: "Never called back" }], description: "Family owned since 1988" }))!;
    expect(JSON.stringify(lead.extra)).not.toContain("Never called back");
    expect(lead.extra).toMatchObject({ description: "Family owned since 1988" });
  });
});

describe("toCountryCode", () => {
  it("passes a two-letter code through, however it was typed", () => {
    expect(toCountryCode("us")).toBe("us");
    expect(toCountryCode("  IN ")).toBe("in");
  });

  it("translates the names people actually write", () => {
    expect(toCountryCode("United States")).toBe("us");
    expect(toCountryCode("united kingdom")).toBe("gb");
    expect(toCountryCode("India")).toBe("in");
    expect(toCountryCode("South Africa")).toBe("za");
  });

  it("refuses a country it cannot name rather than searching another one", () => {
    expect(toCountryCode("Wakanda")).toBeNull();
    expect(toCountryCode("")).toBeNull();
  });
});

describe("buildActorInput", () => {
  it("asks Yelp for the unit, capped, with every review feature off", () => {
    expect(buildActorInput("yelp", unit, Number.POSITIVE_INFINITY, testConfig)).toMatchObject({
      searchTerms: ["plumber"],
      searchLocation: "Austin, TX",
      maxItems: 25,
      scrapeReviews: false,
      reviewInsights: false,
      painPointAnalysis: false,
      enrichEmails: false,
    });
  });

  it("asks HotFrog the same question in its own field names", () => {
    expect(buildActorInput("hotfrog", unit, Number.POSITIVE_INFINITY, testConfig)).toMatchObject({
      searchTerms: ["plumber"],
      locations: ["Austin, TX"],
      maxResults: 25,
    });
  });

  it("sends HotFrog the two-letter country code its schema allows", () => {
    // Live evidence: `country: "United States"` comes back as HTTP 400 listing the values it
    // does take (`"us", "gb", "au", …`), so a name written in `.env` is translated first.
    expect(buildActorInput("hotfrog", unit, 25, testConfig)).toMatchObject({ country: "us" });
  });

  it("refuses to build a HotFrog search for a country it cannot name", () => {
    expect(() => buildActorInput("hotfrog", unit, 25, { ...testConfig, country: "Wakanda" })).toThrow(
      /APIFY_COUNTRY/,
    );
  });

  it("bounds the request by the results still allowed this month", () => {
    expect(buildActorInput("yelp", unit, 4, testConfig)).toMatchObject({ maxItems: 4 });
    expect(buildActorInput("hotfrog", unit, 4, testConfig)).toMatchObject({ maxResults: 4 });
  });
});

describe("parseDatasetItems", () => {
  it("reads a bare array and a wrapped one alike", () => {
    expect(parseDatasetItems([{ name: "A" }])).toEqual([{ name: "A" }]);
    expect(parseDatasetItems({ data: [{ name: "A" }, { name: "B" }], total: 2 })).toEqual([
      { name: "A" },
      { name: "B" },
    ]);
    expect(parseDatasetItems("not json")).toEqual([]);
  });
});

describe("createApifyAdapter().search", () => {
  it("spends one run plus one dataset read per unit", async () => {
    const { adapter, leads, calls, hooks } = harness({ source: "yelp", items: [yelpItem()] });
    const outcome = await adapter.search(unit, hooks);

    expect(outcome).toEqual({ emitted: 1, requestsUsed: 2, stopped: false });
    expect(leads).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/acts/memo23~yelp-scraper/runs") });
    expect(calls[1].url).toContain("/datasets/ds1/items");
    expect(JSON.parse(calls[0].body!)).toMatchObject({ searchTerms: ["plumber"], searchLocation: "Austin, TX" });
  });

  it("starts a run through the endpoint Apify actually serves", async () => {
    const { adapter, calls, hooks } = harness({ source: "yelp", items: [yelpItem()] });
    await adapter.search(unit, hooks);
    // There is no `/runs/sync`: Apify reads it as the GET-only `/runs/{runId}` resource and
    // answers 405. `waitForFinish` is how you ask for the run inline, and 60 s is its ceiling.
    expect(calls[0].url).toBe("https://api.apify.com/v2/acts/memo23~yelp-scraper/runs?timeout=300&waitForFinish=60");
    expect(calls[0].url).not.toContain("sync");
  });

  it("asks for the run no longer than one poll would wait", async () => {
    const made = harness({ source: "yelp", items: [], config: { ...testConfig, runTimeoutS: 40 } });
    await made.adapter.search(unit, made.hooks);
    expect(made.calls[0].url).toContain("timeout=40&waitForFinish=40");
  });

  it("polls a run that is still going, and only then reads the dataset", async () => {
    const made = harness({
      source: "yelp",
      items: [yelpItem()],
      runBody: { id: "run1", status: "RUNNING" },
      pollBody: [
        { data: { id: "run1", status: "RUNNING" } },
        { data: { id: "run1", defaultDatasetId: "ds1", status: "SUCCEEDED" } },
      ],
    });
    const outcome = await made.adapter.search(unit, made.hooks);

    expect(made.calls.map((call) => call.url.replace("https://api.apify.com/v2", ""))).toEqual([
      "/acts/memo23~yelp-scraper/runs?timeout=300&waitForFinish=60",
      "/acts/memo23~yelp-scraper/runs/run1",
      "/acts/memo23~yelp-scraper/runs/run1",
      "/datasets/ds1/items?clean=true",
    ]);
    expect(outcome).toEqual({ emitted: 1, requestsUsed: 4, stopped: false });
    expect(made.sleeps).toEqual([5000, 5000]);
  });

  it("gives up on a run that never finishes, without reading an empty dataset", async () => {
    const made = harness({
      source: "yelp",
      items: [],
      runBody: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" },
      pollBody: { data: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" } },
      config: { ...testConfig, runTimeoutS: 2, pollIntervalMs: 1000 },
    });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/still running/i);
    // The run itself costs one request, and APIFY_RUN_TIMEOUT_S / APIFY_POLL_INTERVAL_MS
    // decides how many answers we will wait for: 2 here.
    expect(made.calls.map((call) => call.url)).toEqual([
      expect.stringContaining("/runs?"),
      expect.stringContaining("/runs/run1"),
      expect.stringContaining("/runs/run1"),
    ]);
  });

  it("stops polling once the job asks to stop", async () => {
    const made = harness({
      source: "yelp",
      items: [yelpItem()],
      runBody: { id: "run1", status: "RUNNING" },
      pollBody: { data: { id: "run1", status: "RUNNING" } },
    });
    made.hooks.shouldStop = () => true;
    const outcome = await made.adapter.search(unit, made.hooks);
    expect(outcome).toEqual({ emitted: 0, requestsUsed: 1, stopped: true });
    expect(made.calls).toHaveLength(1);
  });

  it("sends the token as a header and never in a url", async () => {
    const made = harness({ source: "hotfrog", items: [hotfrogItem()] });
    await made.adapter.search(unit, made.hooks);
    expect(made.calls[0].headers.authorization).toBe("Bearer apify-token");
    expect(made.calls.map((c) => c.url).join()).not.toContain("apify-token");
  });

  it("reads the run object whether or not the API wrapped it in data", async () => {
    const wrapped = harness({
      source: "yelp",
      runBody: { data: { id: "run1", defaultDatasetId: "ds2", status: "SUCCEEDED" } },
      items: [yelpItem()],
    });
    await wrapped.adapter.search(unit, wrapped.hooks);
    expect(wrapped.calls[1].url).toContain("/datasets/ds2/items");
  });

  it("blocks the source when Apify refuses, and says why", async () => {
    for (const [status, why] of [
      [401, "token"],
      [402, "credit"],
      [403, "access"],
      [429, "rate"],
    ] as const) {
      const body = { error: { type: "some-type", message: `${why} problem` } };
      const made = harness({ source: "yelp", statuses: { run: status }, runBody: body, items: [] });
      const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BlockedError);
      expect((err as BlockedError).source).toBe("yelp");
      expect((err as BlockedError).message).toContain(why);
    }
  });

  it("blocks the source when the site served the Actor nothing, and says its reason", async () => {
    // Both Actors exit `SUCCEEDED` with an empty dataset when the directory refuses them,
    // and put the reason in `statusMessage`. Read it or a blocked run looks exactly like a
    // search that has no businesses, and the only fix — re-run later — is invisible.
    const made = harness({
      source: "yelp",
      items: [],
      runBody: {
        id: "run1",
        defaultDatasetId: "ds1",
        status: "SUCCEEDED",
        statusMessage:
          "No data: Yelp did not serve the search pages for this run (temporary block or rate limit). Re-run — the next attempt usually succeeds.",
      },
    });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect((err as BlockedError).source).toBe("yelp");
    expect((err as BlockedError).message).toMatch(/did not serve the search pages/i);
  });

  it("reads the reason from the poll that finished the run", async () => {
    const made = harness({
      source: "yelp",
      items: [],
      runBody: { id: "run1", defaultDatasetId: "ds1", status: "RUNNING" },
      pollBody: {
        id: "run1",
        defaultDatasetId: "ds1",
        status: "SUCCEEDED",
        statusMessage: "No data: HotFrog returned no listings.",
      },
    });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect((err as BlockedError).message).toMatch(/returned no listings/i);
  });

  it("leaves a search that genuinely has no businesses a clean zero", async () => {
    const made = harness({ source: "yelp", items: [] });
    const outcome = await made.adapter.search(unit, made.hooks);
    expect(outcome).toMatchObject({ emitted: 0, stopped: false });
  });

  it("reports a bad actor slug as an error, not a block", async () => {
    const made = harness({
      source: "yelp",
      statuses: { run: 404 },
      runBody: { error: { message: "Actor not found" } },
      items: [],
    });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlockedError);
    expect((err as Error).message).toContain("not found");
  });

  it("fails when the run did not succeed", async () => {
    const made = harness({
      source: "yelp",
      runBody: { id: "run1", defaultDatasetId: "ds1", status: "TIMED-OUT" },
      items: [],
    });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect((err as Error).message).toContain("TIMED-OUT");
  });

  it("refuses to start without a token, at no request cost", async () => {
    const made = harness({ source: "yelp", items: [], config: { ...testConfig, token: "  " } });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect((err as Error).message).toContain("APIFY_API_TOKEN");
    expect(made.calls).toHaveLength(0);
  });

  it("makes no request when the month is already spent", async () => {
    const spend = makeSpend(100, 100);
    const made = harness({ source: "yelp", items: [yelpItem()], spend });
    const outcome = await made.adapter.search(unit, made.hooks);
    expect(made.calls).toHaveLength(0);
    expect(outcome.emitted).toBe(0);
    expect(made.logs.join(" ")).toMatch(/cap/i);
  });

  it("charges the monthly cap for every result returned, and keeps only what it allows", async () => {
    const spend = makeSpend(10, 8);
    const made = harness({ source: "yelp", items: [yelpItem(), yelpItem({ yelp_biz_id: "b" }), yelpItem({ yelp_biz_id: "c" })], spend });
    const outcome = await made.adapter.search(unit, made.hooks);

    // Two were allowed, three came back: all three are billed, only two are kept.
    expect(spend.spent()).toBe(3);
    expect(spend.remaining()).toBe(0);
    expect(outcome.emitted).toBe(2);
    expect(made.leads).toHaveLength(2);
    expect(made.logs.join(" ")).toMatch(/cap/i);
  });

  it("asks the actor for no more than the month allows", async () => {
    const spend = makeSpend(10, 6);
    const made = harness({ source: "hotfrog", items: [], spend });
    await made.adapter.search(unit, made.hooks);
    expect(JSON.parse(made.calls[0].body!)).toMatchObject({ maxResults: 4 });
  });

  it("honours a stop request between leads", async () => {
    const made = harness({ source: "yelp", items: [yelpItem(), yelpItem({ yelp_biz_id: "b" })] });
    made.hooks.shouldStop = () => true;
    const outcome = await made.adapter.search(unit, made.hooks);
    expect(outcome).toMatchObject({ emitted: 0, stopped: true });
  });

  it("spends no request on a country HotFrog does not recognise", async () => {
    const made = harness({ source: "hotfrog", items: [], config: { ...testConfig, country: "Wakanda" } });
    const err = await made.adapter.search(unit, made.hooks).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/APIFY_COUNTRY/);
    expect(made.calls).toHaveLength(0);
  });

  it("leaves Yelp alone, which is asked for a place rather than a country", async () => {
    const made = harness({ source: "yelp", items: [yelpItem()], config: { ...testConfig, country: "Wakanda" } });
    expect((await made.adapter.search(unit, made.hooks)).emitted).toBe(1);
  });
});

describe("buildActorInput with a structured spec", () => {
  const specUnit: SearchArgs = {
    keyword: "plumber",
    location: "Austin, TX, United States",
    maxItems: 25,
    spec: { keyword: "plumber", category: "home-services", country: "US", state: "TX", city: "Austin" },
  };

  it("routes HotFrog to the job's country, not the global env, and drops the country from its location", () => {
    expect(buildActorInput("hotfrog", specUnit, 25, { ...testConfig, country: "gb" })).toMatchObject({
      country: "us",
      locations: ["Austin, TX"],
    });
  });

  it("asks Yelp for the city line, which is what it answers", () => {
    expect(buildActorInput("yelp", specUnit, Number.POSITIVE_INFINITY, testConfig)).toMatchObject({
      searchTerms: ["plumber"],
      searchLocation: "Austin, TX",
    });
  });

  it("keeps the env country as the fallback when the job has no spec", () => {
    expect(buildActorInput("hotfrog", unit, 25, { ...testConfig, country: "gb" })).toMatchObject({
      country: "gb",
      locations: ["Austin, TX"],
    });
  });

  it("still refuses a HotFrog search for a country no form could have produced", () => {
    expect(() =>
      buildActorInput("hotfrog", { ...specUnit, spec: { ...specUnit.spec!, country: "ZZ" as never } }, 25, testConfig),
    ).toThrow(/country/i);
  });
});
