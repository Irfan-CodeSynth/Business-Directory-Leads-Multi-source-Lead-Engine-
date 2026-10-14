import { applyMapping, isMappingUsable, type MappableField } from "./csv";
import { cents, estimateCost, sourceLabel, sourcePrice } from "./sourceMeta";

/** Everything the New run form knows, before any of it becomes a request. */
export interface JobFormState {
  tab: "discover" | "import";
  sources: string[];
  keywords: string[];
  locations: string[];
  cap: number;
  /** New leads one source should add before the run stops itself. */
  target: number;
  rows: Record<string, string>[];
  mapping: Partial<Record<MappableField, string>>;
  label: string;
}

export interface JobRequestBody {
  keywords: string[];
  locations: string[];
  sources: string[];
  maxItems: number;
  leadTarget: number;
  importRows?: Record<string, string>[];
  importLabel: string | null;
}

export type JobRequest = { ok: true; body: JobRequestBody } | { ok: false; error: string };

/** `apps/api/jobs` route rejects longer lists, so say so here instead of failing on submit. */
const MAX_LIST_ITEMS = 20;

/**
 * The Import tab owns its own source, so which tab is showing decides the payload:
 * a pasted list must never go out as `sources: ["osm"]` with empty keywords.
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
        keywords: state.keywords,
        locations: state.locations,
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
  // Every directory source — free or paid — asks its question of the keyword x location
  // matrix, so one message covers all of them.
  if (state.sources.some((source) => source !== "csv") && (!state.keywords.length || !state.locations.length)) {
    return { ok: false, error: "Discovery needs at least one keyword and one location" };
  }
  if (state.keywords.length > MAX_LIST_ITEMS || state.locations.length > MAX_LIST_ITEMS) {
    return { ok: false, error: `Too many keywords or locations (max ${MAX_LIST_ITEMS} each)` };
  }

  return {
    ok: true,
    body: {
      keywords: state.keywords,
      locations: state.locations,
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
 * The same question the worker will ask — one query per keyword x location pair — but
 * answered about reach rather than money: how many new leads the plan can possibly add.
 * Each query brings at most `cap` listings and the run ends at the target, so neither
 * number is a promise; together they are the ceiling.
 */
export function leadCapacity(state: JobFormState): { ceiling: number; short: number } {
  if (state.tab === "import") return { ceiling: 0, short: 0 };
  const queries = state.keywords.length * state.locations.length;
  const perSource = Math.min(state.cap, state.target);
  const ceiling = Math.min(state.target, queries * perSource);
  return { ceiling, short: Math.max(0, state.target - ceiling) };
}

/**
 * Every paid source is asked the same question once per keyword x location pair, so
 * the invoice is knowable before any money goes out. The worker is what enforces the
 * monthly cap; this only warns that part of the run will never be sent.
 */
export function estimateRun(state: JobFormState, monthRemaining = Number.POSITIVE_INFINITY): RunEstimate {
  if (state.tab === "import") return { items: [], usd: 0, over: 0 };
  const queries = state.keywords.length * state.locations.length;
  const items = state.sources
    .filter((source) => sourcePrice(source) != null)
    .map((source) => {
      // Past the target, rows are bought and thrown away.
      const results = queries * Math.min(state.cap, state.target);
      return { source, label: sourceLabel(source), results, usd: estimateCost(source, results) };
    });
  const wanted = items.reduce((total, item) => total + item.results, 0);
  return {
    items,
    usd: cents(items.reduce((total, item) => total + item.usd, 0)),
    over: Number.isFinite(monthRemaining) ? Math.max(0, wanted - monthRemaining) : 0,
  };
}
