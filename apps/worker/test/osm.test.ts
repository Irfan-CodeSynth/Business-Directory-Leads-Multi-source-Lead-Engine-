import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { dedupKeyFor } from "@dleads/db";
import {
  BlockedError,
  BudgetExhaustedError,
  makeBudget,
  type RawLead,
  type SearchHooks,
} from "../src/adapters/types.js";
import {
  buildOverpassQuery,
  cityMatches,
  classifyFailure,
  createOsmAdapter,
  elementToLead,
  invalidateGeoCache,
  isRateLimitedText,
  osmConfig,
  outsidePlace,
  overpassCap,
  parseOverpassLeads,
  planFromNominatim,
  politeRequest,
  retryAfterMs,
  selectorsForKeyword,
  type HttpResponse,
  type OsmConfig,
} from "../src/adapters/osm.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/osm/${name}`, import.meta.url), "utf8");

const jsonFixture = (name: string) => JSON.parse(fixture(name));

const hit = (name: string) => jsonFixture(name)[0];

const ok: HttpResponse = { status: 200, body: "{}", retryAfterMs: null };
const noSleep = async () => {};

/** Zero-delay config: the ladder is tested on its decisions, not its waiting. */
function testConfig(overrides: Partial<OsmConfig> = {}): OsmConfig {
  return {
    ...osmConfig(),
    userAgent: "DirectoryLeadsTest/0.1 (fixture)",
    delayMinMs: 0,
    delayMaxMs: 0,
    rateLimitRetryMs: 30000,
    transientRetryMs: 10000,
    maxRetries: 1,
    geocacheTtlMs: 600000,
    ...overrides,
  };
}

beforeEach(() => {
  invalidateGeoCache();
});

describe("planFromNominatim", () => {
  it("searches a boundary relation inside its own box", () => {
    const resolved = planFromNominatim(hit("nominatim-austin-relation.json"));
    expect(resolved?.box).toEqual({ s: 30.1, w: -97.99, n: 30.55, e: -97.55 });
    expect(resolved?.label).toContain("Austin");
    // Nominatim types the relation "administrative"; `addresstype` names the place.
    expect(resolved?.placeName).toBe("Austin");
    expect(resolved?.note).toBeUndefined();
  });

  it("grows a place node's point into the settlement's extent", () => {
    const resolved = planFromNominatim(hit("nominatim-city-node.json"));
    expect(resolved?.box).toEqual({ s: 30.8625, w: -97.844, n: 31.1425, e: -97.564 });
    expect(resolved?.placeName).toBe("Harker Heights");
  });

  it("keeps a postcode's own box and no place name", () => {
    const resolved = planFromNominatim(hit("nominatim-postcode-node.json"));
    expect(resolved?.box).toEqual({ s: 30.22, w: -97.79, n: 30.31, e: -97.69 });
    expect(resolved?.placeName).toBeNull();
  });

  it("clamps an oversized area and says so", () => {
    const resolved = planFromNominatim(hit("nominatim-wide-state.json"));
    expect(resolved?.box).toEqual({ s: 30.75, w: -100.65, n: 31.65, e: -99.45 });
    expect(resolved?.note).toMatch(/courtesy cap/);
    // A county or state holds many cities, so its name must not filter results.
    expect(resolved?.placeName).toBeNull();
  });

  it("uses the box for a linear relation", () => {
    const resolved = planFromNominatim({
      osm_type: "relation",
      osm_id: 99,
      class: "highway",
      boundingbox: ["10", "10.2", "20", "20.3"],
    });
    expect(resolved?.box).toEqual({ s: 10, w: 20, n: 10.2, e: 20.3 });
    expect(resolved?.placeName).toBeNull();
  });

  it("rounds the box so the query stays short", () => {
    const resolved = planFromNominatim({
      class: "place",
      type: "city",
      lat: "31.00254417",
      lon: "-97.70400001",
    });
    expect(resolved?.box.n).toBe(31.142544);
    expect(resolved?.box.e).toBe(-97.564000);
  });

  it("returns null when there is nothing to search around", () => {
    expect(planFromNominatim({ osm_type: "node", class: "place" })).toBeNull();
  });
});

describe("cityMatches / outsidePlace", () => {
  it("forgives punctuation and case", () => {
    expect(cityMatches("St. Louis", "st louis")).toBe(true);
    expect(cityMatches("AUSTIN", "Austin, TX")).toBe(true);
    expect(cityMatches("Georgetown", "Austin")).toBe(false);
    expect(cityMatches("", "Austin")).toBe(false);
  });

  it("only drops a business that tags itself into another city", () => {
    expect(outsidePlace("Round Rock", "Austin")).toBe(true);
    expect(outsidePlace("Austin", "Austin")).toBe(false);
    // Most OSM businesses carry no addr:city; silence is never a contradiction.
    expect(outsidePlace(null, "Austin")).toBe(false);
    expect(outsidePlace("", "Austin")).toBe(false);
    expect(outsidePlace("Round Rock", null)).toBe(false);
  });
});

describe("selectorsForKeyword", () => {
  it("maps a trade onto its OSM tags and adds a name pattern", () => {
    const selectors = selectorsForKeyword("plumber");
    expect(selectors).toContain('["craft"="plumber"]');
    const name = selectors.find((s) => s.startsWith('["name"'));
    expect(name).toContain("plumb");
    expect(name).toMatch(/,i\]$/);
  });

  it("is case and whitespace insensitive", () => {
    expect(selectorsForKeyword("  DenTIST ")).toContain('["amenity"="dentist"]');
    expect(selectorsForKeyword("   ")).toEqual([]);
  });

  it("matches a phrase on both the phrase and its words", () => {
    const selectors = selectorsForKeyword("dental clinic");
    // "dental" is in the tag table even though the full phrase is not.
    expect(selectors).toContain('["amenity"="dentist"]');
    const name = selectors.find((s) => s.startsWith('["name"'));
    expect(name).toContain("dental clinic");
    expect(name).toContain("clinic");
  });

  it("drops words that describe the search, not the business", () => {
    const name = selectorsForKeyword("plumber services").find((s) => s.startsWith('["name"'));
    expect(name).toContain("plumb");
    expect(name).not.toContain("service");
  });

  it("never lets a keyword break out of a quoted selector", () => {
    const selectors = selectorsForKeyword('plumb"er]~"[a-z');
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect((selector.match(/"/g) ?? []).length % 2).toBe(0);
      expect(selector).not.toContain("\\");
      expect(selector.startsWith('["')).toBe(true);
      expect(selector.endsWith("]")).toBe(true);
    }
  });
});

describe("overpassCap", () => {
  it("asks for headroom but never for a sweep", () => {
    expect(overpassCap(25)).toBe(75);
    expect(overpassCap(1)).toBe(30);
    expect(overpassCap(1000)).toBe(500);
    expect(overpassCap(Number.NaN)).toBe(75);
  });
});

describe("buildOverpassQuery", () => {
  it("scopes every selector to the box and caps the output", () => {
    const query = buildOverpassQuery(
      { s: 30.1, w: -97.99, n: 30.55, e: -97.55 },
      ['["craft"="plumber"]', '["name"~"plumb",i]'],
      75,
    );
    expect(query).toContain("[out:json][timeout:45];");
    expect(query).toContain('  nwr["craft"="plumber"](30.1,-97.99,30.55,-97.55);');
    expect(query).toContain('  nwr["name"~"plumb",i](30.1,-97.99,30.55,-97.55);');
    expect(query).toMatch(/out tags center 75;$/);
    // area() scoping timed out on the live instance; a box never did.
    expect(query).not.toContain("area(");
  });

  it("refuses to build an unscoped query", () => {
    expect(() => buildOverpassQuery({ s: 1, w: 2, n: 3, e: 4 }, [], 30)).toThrow(/no selectors/);
  });
});

describe("classifyFailure", () => {
  it("accepts a JSON body", () => {
    expect(classifyFailure(200, '{"elements":[]}')).toEqual({ ok: true });
  });

  it("treats 429, 403, 503 and a rate-limit remark as throttling", () => {
    const remark = fixture("overpass-rate-limited.xml");
    expect(isRateLimitedText(remark)).toBe(true);
    expect(classifyFailure(429, "")).toMatchObject({ kind: "rate_limited", status: 429 });
    expect(classifyFailure(403, "HTTP Request forbidden")).toMatchObject({ kind: "rate_limited" });
    expect(classifyFailure(200, remark)).toMatchObject({ kind: "rate_limited" });
  });

  it("treats a gateway timeout as transient", () => {
    expect(classifyFailure(504, "upstream timed out")).toMatchObject({ kind: "transient" });
  });

  it("treats a request that never got a response as transient", () => {
    expect(classifyFailure(0, "fetch failed: UND_ERR_CONNECT_TIMEOUT")).toMatchObject({
      kind: "transient",
      status: 0,
    });
  });

  it("treats a query error as fatal", () => {
    expect(classifyFailure(400, "runtime error: Query invalid")).toMatchObject({ kind: "fatal" });
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("41")).toBe(41000);
    expect(retryAfterMs(null)).toBeNull();
    const wait = retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now());
    expect(wait).toBeGreaterThan(3000);
    expect(wait).toBeLessThanOrEqual(5000);
  });
});

describe("elementToLead", () => {
  const parsed = parseOverpassLeads(jsonFixture("overpass-plumbers.json"));
  const byName = (name: string) => parsed.leads.find((l) => l.name === name)!;

  it("keeps named businesses and reports what it dropped", () => {
    expect(parsed.leads.map((l) => l.externalId)).toEqual([
      "n440000001",
      "w880000002",
      "r550000005",
      "n440000007",
      "n440000008",
      "n440000009",
    ]);
    // One unnamed element and one one-character name; one abandoned business.
    expect(parsed.droppedUnnamed).toBe(2);
    expect(parsed.droppedClosed).toBe(1);
    // A named street and a suburb caught by the "plumb" name pattern.
    expect(parsed.droppedFeature).toBe(2);
  });

  it("maps the full tag set, preferring `phone` over `contact:phone`", () => {
    const lead = byName("Lone Star Plumbers, Inc.");
    expect(lead).toMatchObject({
      phone: "+1 512-555-0142",
      website: "https://lonestarplumbing.example.com",
      address: "1104 E Cesar Chavez St",
      city: "Austin",
      region: "TX",
      postalCode: "78702-5304",
      category: "plumber",
      profileUrl: "https://www.openstreetmap.org/node/440000001",
    });
    expect(lead.emails).toEqual(["dispatch@lonestarplumbing.example.com"]);
    expect(lead.socials).toEqual({
      instagram: "https://instagram.com/lonestarplumb",
      facebook: "https://www.facebook.com/lonestarplumbing",
      linkedin: "https://www.linkedin.com/company/lonestarplumbing",
    });
    expect(lead.extra).toMatchObject({ osmType: "node", osmId: 440000001, lat: 30.2672 });
  });

  it("humanises the category and takes a way's centroid", () => {
    const lead = byName("Hill Country Auto Repair");
    expect(lead.category).toBe("car repair");
    expect(lead.extra).toMatchObject({ lat: 30.31, lon: -97.79 });
    // Kept verbatim; the dedup tier and the exporter add the scheme.
    expect(lead.website).toBe("hillcountryauto.example.com");
  });

  it("uses addr:full and survives having no category tag", () => {
    const lead = byName("Brazmos Plumbing LLC");
    expect(lead.address).toBe("PO Box 12, Austin, TX 78701");
    expect(lead.category).toBeNull();
    expect(lead.extra).not.toHaveProperty("lat");
  });

  it("rejects social values that are handles or prose", () => {
    expect(byName("Sketchy Signs").socials).toEqual({});
  });

  it("strips a mailto: prefix and keeps a phone extension verbatim", () => {
    const lead = byName("Pecos Pipe Works");
    expect(lead.emails).toEqual(["pipeline@example.org"]);
    expect(lead.phone).toBe("512 555 0177 x 4");
  });

  it("keeps a business that only has a name and a trade", () => {
    const lead = byName("Deep Flow Drainage");
    expect(lead.phone).toBeNull();
    expect(lead.website).toBeNull();
    expect(lead.emails).toEqual([]);
    expect(lead.socials).toEqual({});
    expect(lead.category).toBe("plumber");
  });

  it("lands on the per-source `x` tier when nothing else identifies it", () => {
    const lead = byName("Deep Flow Drainage");
    const input = {
      name: lead.name,
      source: "osm",
      externalId: lead.externalId,
      phone: lead.phone,
      website: lead.website,
      postalCode: lead.postalCode,
      city: lead.city,
      region: lead.region,
    };
    const dedup = dedupKeyFor(input);
    expect(dedup.kind).toBe("x");
    expect(dedup.key.startsWith("x:")).toBe(true);
    expect(dedupKeyFor(input).key).toBe(dedup.key);
    expect(dedupKeyFor({ ...input, externalId: "n111111111" }).key).not.toBe(dedup.key);
  });

  it("returns null for an element with no tags", () => {
    expect(elementToLead({ type: "node", id: 1 })).toBeNull();
  });

  it("tolerates a malformed payload", () => {
    expect(parseOverpassLeads({ elements: [{ id: 1 }, null, { type: "node" }] })).toEqual({
      leads: [],
      droppedUnnamed: 0,
      droppedClosed: 0,
      droppedFeature: 0,
    });
    expect(parseOverpassLeads(null).leads).toEqual([]);
  });
});

describe("politeRequest", () => {
  const hooks = (budget = makeBudget(50)) => ({ budget, log: () => {} });

  it("sends once when the service answers", async () => {
    const slept: number[] = [];
    const res = await politeRequest(
      "overpass.test",
      async () => ok,
      testConfig(),
      hooks(),
      "overpass",
      async (ms) => void slept.push(ms),
      new Map(),
    );
    expect(res.status).toBe(200);
    expect(slept).toEqual([]);
  });

  it("retries a rate limit once with the documented backoff", async () => {
    const slept: number[] = [];
    let calls = 0;
    const res = await politeRequest(
      "overpass.test",
      async () => {
        calls++;
        return calls === 1
          ? { status: 429, body: fixture("overpass-rate-limited.xml"), retryAfterMs: null }
          : ok;
      },
      testConfig(),
      hooks(),
      "overpass",
      async (ms) => void slept.push(ms),
      new Map(),
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(slept).toEqual([30000]);
  });

  it("honours a Retry-After longer than the default backoff", async () => {
    const slept: number[] = [];
    let calls = 0;
    await politeRequest(
      "overpass.test",
      async () => {
        calls++;
        return calls === 1 ? { status: 429, body: "", retryAfterMs: 90000 } : ok;
      },
      testConfig(),
      hooks(),
      "overpass",
      async (ms) => void slept.push(ms),
      new Map(),
    );
    expect(slept).toEqual([90000]);
  });

  it("uses a shorter backoff for a transient failure", async () => {
    const slept: number[] = [];
    let calls = 0;
    await politeRequest(
      "overpass.test",
      async () => {
        calls++;
        return calls === 1 ? { status: 504, body: "upstream timed out", retryAfterMs: null } : ok;
      },
      testConfig(),
      hooks(),
      "overpass",
      async (ms) => void slept.push(ms),
      new Map(),
    );
    expect(slept).toEqual([10000]);
  });

  it("gives up as blocked when the throttle holds", async () => {
    const budget = makeBudget(50);
    const send = async (): Promise<HttpResponse> => ({
      status: 429,
      body: "Too many requests",
      retryAfterMs: null,
    });
    const err = await politeRequest(
      "overpass.test",
      send,
      testConfig(),
      hooks(budget),
      "overpass",
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err).toMatchObject({ source: "osm", status: 429 });
    expect(err.message).toMatch(/rate limited after 2 attempt/);
    // Initial attempt plus one retry, each charged.
    expect(budget.spent()).toBe(2);
  });

  it("reports a bad query as an error, not a block", async () => {
    const err = await politeRequest(
      "overpass.test",
      async () => ({ status: 400, body: "Query error", retryAfterMs: null }),
      testConfig(),
      hooks(),
      'overpass "bad"',
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlockedError);
    expect(err.message).toContain('HTTP 400');
  });

  it("names the User-Agent when a gateway denies us outright", async () => {
    const denied = await politeRequest(
      "nominatim.test",
      async () => ({ status: 403, body: "Access denied. See https://operations.osmfoundation.org", retryAfterMs: null }),
      testConfig(),
      hooks(),
      'nominatim "Austin"',
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(denied).toBeInstanceOf(BlockedError);
    expect(denied.message).toMatch(/OSM_USER_AGENT/);

    const notAcceptable = await politeRequest(
      "overpass.test",
      async () => ({ status: 406, body: "406 Not Acceptable", retryAfterMs: null }),
      testConfig(),
      hooks(),
      "overpass",
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(notAcceptable.message).toMatch(/OSM_USER_AGENT/);
  });

  it("retries a socket failure and names the reason it hides", async () => {
    const failed = Object.assign(new Error("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const slept: number[] = [];
    let calls = 0;
    const res = await politeRequest(
      "overpass.test",
      async () => {
        calls++;
        if (calls === 1) throw failed;
        return ok;
      },
      testConfig(),
      hooks(),
      "overpass",
      async (ms) => void slept.push(ms),
      new Map(),
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // A busy connection is transient, so it uses the shorter backoff.
    expect(slept).toEqual([10000]);
  });

  it("blocks with the connection reason, not a phantom HTTP 0", async () => {
    const err = await politeRequest(
      "nominatim.test",
      async () => {
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
      },
      testConfig(),
      hooks(),
      'nominatim "Austin"',
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain("fetch failed: ENOTFOUND");
    expect(err.message).not.toMatch(/HTTP 0/);
  });

  it("waits its turn per host", async () => {
    const slept: number[] = [];
    const gates = new Map<string, number>();
    const cfg = testConfig({ delayMinMs: 5000, delayMaxMs: 5000 });
    const record = async (ms: number) => void slept.push(ms);
    await politeRequest("h", async () => ok, cfg, hooks(), "a", record, gates);
    await politeRequest("h", async () => ok, cfg, hooks(), "b", record, gates);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(4000);
    // A different service has its own courtesy clock.
    await politeRequest("other", async () => ok, cfg, hooks(), "c", record, gates);
    expect(slept).toHaveLength(1);
  });

  it("stops before sending when the budget is gone", async () => {
    const budget = makeBudget(1);
    budget.charge();
    let sent = 0;
    const err = await politeRequest(
      "h",
      async () => {
        sent++;
        return ok;
      },
      testConfig(),
      hooks(budget),
      "overpass",
      noSleep,
      new Map(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(sent).toBe(0);
  });
});

describe("createOsmAdapter().search", () => {
  function stubFetch(handler: (url: string) => Promise<HttpResponse>) {
    const calls: { url: string; body?: string; headers?: unknown }[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined, headers: init?.headers });
      const res = await handler(url);
      return {
        status: res.status,
        ok: res.status < 400,
        headers: new Headers(),
        text: async () => res.body,
      } as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  function makeAdapter(handler: (url: string) => Promise<HttpResponse>) {
    const { fetchFn, calls } = stubFetch(handler);
    const leads: RawLead[] = [];
    const logs: string[] = [];
    const hooks: SearchHooks = {
      emit: (lead) => void leads.push(lead),
      budget: makeBudget(50),
      log: (message) => void logs.push(message),
      shouldStop: () => false,
    };
    const adapter = createOsmAdapter({
      fetch: fetchFn,
      sleep: noSleep,
      config: testConfig(),
      gates: new Map(),
    });
    return { adapter, leads, logs, calls, hooks };
  }

  const serve: (url: string) => Promise<HttpResponse> = async (url) =>
    url.includes("nominatim")
      ? { status: 200, body: fixture("nominatim-austin-relation.json"), retryAfterMs: null }
      : { status: 200, body: fixture("overpass-plumbers.json"), retryAfterMs: null };

  it("collects leads from one geocode plus one query", async () => {
    const { adapter, leads, calls, hooks } = makeAdapter(serve);
    const outcome = await adapter.search(
      { keyword: "plumber", location: "Austin, TX", maxItems: 25 },
      hooks,
    );

    expect(outcome).toEqual({ emitted: 6, requestsUsed: 2, stopped: false });
    expect(leads.map((l) => l.externalId)).toContain("w880000002");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("nominatim");
    expect(calls[0].url).toContain("q=Austin%2C%20TX");
    expect(calls[0].url).toContain("format=jsonv2");
    const query = decodeURIComponent(calls[1].body!.replace("data=", ""));
    expect(query).toContain("(30.1,-97.99,30.55,-97.55)");
    expect(query).toContain('nwr["craft"="plumber"](30.1,-97.99,30.55,-97.55)');
  });

  it("drops a business that tags itself into a neighbouring city", async () => {
    const elsewhere = JSON.stringify({
      elements: [
        {
          type: "node",
          id: 440000010,
          lat: 30.5,
          lon: -97.6,
          tags: { name: "Georgetown Plumbing Co", craft: "plumber", "addr:city": "Georgetown" },
        },
        {
          type: "node",
          id: 440000011,
          lat: 30.27,
          lon: -97.74,
          tags: { name: "Austin Drain Service", craft: "plumber" },
        },
      ],
    });
    const { adapter, hooks, leads, logs } = makeAdapter(async (url) => ({
      status: 200,
      body: url.includes("nominatim") ? fixture("nominatim-austin-relation.json") : elsewhere,
      retryAfterMs: null,
    }));
    const outcome = await adapter.search(
      { keyword: "plumber", location: "Austin, TX", maxItems: 25 },
      hooks,
    );
    expect(outcome.emitted).toBe(1);
    expect(leads.map((l) => l.name)).toEqual(["Austin Drain Service"]);
    expect(logs.join("\n")).toMatch(/1 element\(s\) tagged to another city/);
  });

  it("does not filter by city when the match is a county or postcode", async () => {
    const { adapter, hooks, leads } = makeAdapter(async (url) => ({
      status: 200,
      body: url.includes("nominatim") ? fixture("nominatim-postcode-node.json") : fixture("overpass-plumbers.json"),
      retryAfterMs: null,
    }));
    const outcome = await adapter.search(
      { keyword: "plumber", location: "78701", maxItems: 25 },
      hooks,
    );
    expect(outcome.emitted).toBe(6);
    expect(leads).toHaveLength(6);
  });

  it("sends the identifying user agent both services require", async () => {
    const { adapter, hooks, calls } = makeAdapter(serve);
    await adapter.search({ keyword: "plumber", location: "Austin, TX", maxItems: 25 }, hooks);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = call.headers as Record<string, string>;
      expect(headers["user-agent"]).toContain("DirectoryLeadsTest");
    }
  });

  it("respects the per-pair cap", async () => {
    const { adapter, hooks, leads } = makeAdapter(serve);
    const outcome = await adapter.search(
      { keyword: "plumber", location: "Austin, TX", maxItems: 2 },
      hooks,
    );
    expect(outcome.emitted).toBe(2);
    expect(leads).toHaveLength(2);
  });

  it("stops between leads when asked", async () => {
    const { adapter, leads } = makeAdapter(serve);
    const hooks: SearchHooks = {
      emit: (lead) => void leads.push(lead),
      budget: makeBudget(50),
      log: () => {},
      shouldStop: () => leads.length >= 1,
    };
    const outcome = await adapter.search(
      { keyword: "plumber", location: "Austin, TX", maxItems: 25 },
      hooks,
    );
    expect(outcome.emitted).toBe(1);
    expect(outcome.stopped).toBe(true);
  });

  it("caches the geocoded area across searches", async () => {
    const { adapter, hooks, calls } = makeAdapter(serve);
    await adapter.search({ keyword: "plumber", location: "Austin, TX", maxItems: 5 }, hooks);
    await adapter.search({ keyword: "roofer", location: " austin, TX ", maxItems: 5 }, hooks);
    expect(calls.filter((c) => c.url.includes("nominatim"))).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("surfaces a persistent throttle as BlockedError", async () => {
    const { adapter, hooks } = makeAdapter(async () => ({
      status: 503,
      body: "Too many requests",
      retryAfterMs: null,
    }));
    await expect(
      adapter.search({ keyword: "plumber", location: "Austin, TX", maxItems: 25 }, hooks),
    ).rejects.toBeInstanceOf(BlockedError);
  });

  it("says nothing matched instead of inventing an area", async () => {
    const { adapter, hooks } = makeAdapter(async () => ({
      status: 200,
      body: "[]",
      retryAfterMs: null,
    }));
    await expect(
      adapter.search({ keyword: "plumber", location: "Nowhereville", maxItems: 25 }, hooks),
    ).rejects.toThrow(/nothing matched/);
  });

  it("logs an Overpass remark without failing the search", async () => {
    const { adapter, hooks, logs } = makeAdapter(async (url) => ({
      status: 200,
      body: url.includes("nominatim")
        ? fixture("nominatim-austin-relation.json")
        : JSON.stringify({ remark: "We have an error, but elements below are fine", elements: [] }),
      retryAfterMs: null,
    }));
    // "error" in a remark must not be mistaken for a crash.
    const outcome = await adapter.search(
      { keyword: "plumber", location: "Austin, TX", maxItems: 25 },
      hooks,
    );
    expect(outcome.emitted).toBe(0);
    expect(logs.join("\n")).toMatch(/error, but elements below are fine/);
  });
});
