import { locationLine, parseSearchSpec, type SearchSpec } from "@dleads/db/search";
import { applyMapping, isMappingUsable, type MappableField } from "./csv";
import { cents, estimateCost, sourceLabel, sourcePrice } from "./sourceMeta";

/** Everything the New run form knows, before any of it becomes a request. */
export interface JobFormState {
  tab: "discover" | "import";
  sources: string[];
  /** Single structured search — exactly one keyword in exactly one place. */
  keyword: string;
  category: string;
  country: string;
  state: string;
  city: string;
  cap: number;
  /** New leads one source should add before the run stops itself. */
  target: number;
  rows: Record<string, string>[];
  mapping: Partial<Record<MappableField, string>>;
  label: string;
}

export interface JobRequestBody {
  /** Display arrays for the Runs pages; the worker searches `searchSpec`. */
  keywords: string[];
  locations: string[];
  searchSpec: SearchSpec | null;
  sources: string[];
  maxItems: number;
  leadTarget: number;
  importRows?: Record<string, string>[];
  importLabel: string | null;
}

export type JobRequest = { ok: true; body: JobRequestBody } | { ok: false; error: string };

/**
 * The Import tab owns its own source, so which tab is showing decides the payload:
 * a pasted list must never go out as `sources: ["osm"]` with an empty search spec.
 */
export function buildJobRequest(state: JobFormState): JobRequest {
  if (state.tab === "import") {
    if (!state.rows.length) return { ok: false, error: "The CSV import has no rows yet" };
    if (!isMappingUsable(state.mapping)) return { ok: false, error: "Pick which column holds the business name" };
    const importRows = applyMapping(state.rows, state.mapping);
    if (!importRows.length) return { ok: false, error: "No row in that list has a business name" };
    return {
      ok: true,
      body: {
        keywords: [],
        locations: [],
        searchSpec: null,
        sources: ["csv"],
        maxItems: state.cap,
        // Inert for an import — the worker takes the whole list whatever this says —
        // but the run row still records what was asked for.
        leadTarget: state.target,
        importRows,
        importLabel: state.label.trim() || "pasted list",
      },
    };
  }

  if (!state.sources.length) return { ok: false, error: "Pick at least one source" };
  const parsed = parseSearchSpec({
    keyword: state.keyword,
    category: state.category,
    country: state.country,
    state: state.state,
    city: state.city,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  return {
    ok: true,
    body: {
      keywords: [parsed.spec.keyword],
      locations: [locationLine(parsed.spec, "full")],
      searchSpec: parsed.spec,
      sources: state.sources,
      maxItems: state.cap,
      leadTarget: state.target,
      importRows: undefined,
      importLabel: null,
    },
  };
}

export interface RunEstimateItem {
  source: string;
  label: string;
  results: number;
  usd: number;
}

export interface RunEstimate {
  items: RunEstimateItem[];
  usd: number;
  over: number;
}

/**
 * One structured search asks each source for at most `cap` listings and the run
 * ends at the target, so the ceiling is a single min() — a promise about reach,
 * not a count of what the directories actually hold.
 */
export function leadCapacity(state: JobFormState): { ceiling: number; short: number } {
  if (state.tab === "import") return { ceiling: 0, short: 0 };
  if (!state.keyword.trim() || !state.city.trim() || !state.country) {
    return { ceiling: 0, short: state.target };
  }
  const ceiling = Math.min(state.target, state.cap);
  return { ceiling, short: Math.max(0, state.target - ceiling) };
}

/**
 * Every paid source is asked the one structured query once, so the invoice is
 * knowable before any money goes out. The worker enforces the monthly cap; this
 * only warns that part of the run will never be sent.
 */
export function estimateRun(state: JobFormState, monthRemaining = Number.POSITIVE_INFINITY): RunEstimate {
  if (state.tab === "import") return { items: [], usd: 0, over: 0 };
  const items = state.sources
    .filter((source) => sourcePrice(source) != null)
    .map((source) => {
      // Past the target, rows are bought and thrown away.
      const results = Math.min(state.cap, state.target);
      return { source, label: sourceLabel(source), results, usd: estimateCost(source, results) };
    });
  const wanted = items.reduce((total, item) => total + item.results, 0);
  return {
    items,
    usd: cents(items.reduce((total, item) => total + item.usd, 0)),
    over: Number.isFinite(monthRemaining) ? Math.max(0, wanted - monthRemaining) : 0,
  };
}
