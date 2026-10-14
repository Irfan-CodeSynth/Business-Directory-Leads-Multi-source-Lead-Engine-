/** Display names and tones per source id. Adding a source needs one line here. */
export const SOURCE_LABELS: Record<string, string> = {
  osm: "OpenStreetMap",
  csv: "CSV import",
  yelp: "Yelp",
  hotfrog: "HotFrog",
};

const SOURCE_TONES: Record<string, string> = {
  osm: "bg-info-bg text-info-fg",
  csv: "bg-idle-bg text-idle-fg",
};

/**
 * What the paid Actors publish per 1,000 results. Apify sends the bill, not this app:
 * these are estimates read off the Actor pages, worth re-checking before a budget
 * depends on them. A source missing here costs nothing.
 */
const PRICE_PER_1000: Record<string, number> = {
  yelp: 2.75,
};

/**
 * Some Actors publish volume tiers instead of one price — HotFrog charges $3.00/1k
 * under 500 results, $2.00/1k to 1,499, then $1.00/1k. The tier is chosen by the run's
 * own result count, so a small job is quoted at the rate it will actually pay.
 */
const PRICE_TIERS: Record<string, { over: number; per1000: number }[]> = {
  hotfrog: [
    { over: 1500, per1000: 1 },
    { over: 500, per1000: 2 },
    { over: 0, per1000: 3 },
  ],
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Dollars per 1,000 results, or null for a source that does not bill. */
export function sourcePrice(source: string): number | null {
  return PRICE_PER_1000[source] ?? PRICE_TIERS[source]?.[PRICE_TIERS[source].length - 1].per1000 ?? null;
}

export function isPaidSource(source: string): boolean {
  return sourcePrice(source) != null;
}

/** One line under the source's name: what it costs and who charges it. */
export function priceNote(source: string): string {
  const price = sourcePrice(source);
  if (price == null) return "Free";
  const tiers = PRICE_TIERS[source];
  // A tiered source is quoted at its cheapest rate, because that is the floor the
  // invoice can reach — the run's own count picks the real one.
  const shown = tiers ? Math.min(...tiers.map((t) => t.per1000)) : price;
  return `${tiers ? "from " : ""}$${shown.toFixed(2)} per 1,000 results · billed by Apify`;
}

export const cents = (value: number): number => Math.round(value * 100) / 100;

/** A price for humans: two decimals always, so a column of them lines up. */
export const usd = (value: number): string => `$${value.toFixed(2)}`;

/**
 * What stopped a source. A blocked free source waits for a courtesy window; a blocked
 * paid source waits for money or a cap, and re-running it any sooner sends no request
 * either way — saying "rate-limited" for both invites a pointless retry loop.
 */
export function blockedHint(source: string): string {
  if (!isPaidSource(source)) {
    return "Rate-limited by the source. Nothing else failed — re-run just this source once the courtesy window clears.";
  }
  return "Stopped before any request went out, so this attempt billed nothing. Check the Apify account's credit and APIFY_MONTHLY_RESULT_CAP, then re-run just this source.";
}

/** What `results` results cost on this source, to the cent. */
export function estimateCost(source: string, results: number): number {
  if (results <= 0) return 0;
  const price = PRICE_PER_1000[source];
  if (price != null) return cents((results / 1000) * price);
  const tiers = PRICE_TIERS[source];
  if (tiers == null) return 0;
  const tier = tiers.find((t) => results >= t.over) ?? tiers[tiers.length - 1];
  return cents((results / 1000) * tier.per1000);
}

export function sourceChip(source: string): string {
  return SOURCE_TONES[source] ?? "bg-accent-soft text-accent";
}

export function sourceBadge(status: string): string {
  switch (status) {
    case "done":
      return "bg-ok-bg text-ok-fg";
    case "running":
      return "bg-info-bg text-info-fg";
    case "blocked":
      return "bg-warn-bg text-warn-fg";
    case "error":
      return "bg-bad-bg text-bad-fg";
    default:
      return "bg-idle-bg text-idle-fg";
  }
}
