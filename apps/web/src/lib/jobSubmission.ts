import { locationLine, parseSearchSpec, sources, type SearchSpec, type Source } from "@dleads/db";

const MAX_LIST_ITEMS = 20;
const MAX_IMPORT_ROWS = 5000;
const MAX_CELL_CHARS = 300;

export interface JobSubmission {
  keywords: string[];
  locations: string[];
  searchSpec: SearchSpec | null;
  sources: Source[];
  maxItems: number;
  leadTarget: number;
  importRows: Record<string, string>[] | null;
  importLabel: string | null;
}

export type SubmissionResult =
  | { ok: true; value: JobSubmission }
  | { ok: false; error: string; status: number };

function cleanList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST_ITEMS);
}

function cleanSources(input: unknown): Source[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  // Every entry must be a known source, with no repeats: a list padded with junk
  // or duplicates should not get a job out of it.
  if (input.length !== new Set(input).size) return null;
  const picked = input.filter((v): v is Source => typeof v === "string" && (sources as readonly string[]).includes(v));
  return picked.length === input.length ? picked : null;
}

/** Paste/upload lands as an array of flat header→value objects; cells are strings. */
function cleanRows(input: unknown): Record<string, string>[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_IMPORT_ROWS) return null;
  const rows: Record<string, string>[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim().slice(0, MAX_CELL_CHARS);
      if (text) row[key.trim().slice(0, 80)] = text;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows.length ? rows : null;
}

/**
 * Turns a raw POST body into an insert-ready job, or a 400. The structured
 * searchSpec is authoritative when present; the keyword x location matrix is
 * the legacy shape old clients still send, so both stay accepted here and the
 * worker is what decides per job row which path runs.
 */
export function parseJobSubmission(body: unknown): SubmissionResult {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const picked = cleanSources(raw.sources);
  if (!picked) return { ok: false, error: "Pick at least one source", status: 400 };

  const requested = Number(raw.maxItems);
  const maxItems = Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1), 200) : 25;
  const wanted = Number(raw.leadTarget);
  const leadTarget = Number.isFinite(wanted) ? Math.min(Math.max(Math.round(wanted), 1), 200) : 100;
  const importLabel = typeof raw.importLabel === "string" ? raw.importLabel.trim().slice(0, 120) : null;

  const importRows = picked.includes("csv") ? cleanRows(raw.importRows) : null;
  if (picked.includes("csv") && !importRows) {
    return { ok: false, error: "A CSV import needs at least one mapped row", status: 400 };
  }

  const parsed = parseSearchSpec(raw.searchSpec);
  if (parsed.ok) {
    return {
      ok: true,
      value: {
        keywords: [parsed.spec.keyword],
        locations: [locationLine(parsed.spec, "full")],
        searchSpec: parsed.spec,
        sources: picked,
        maxItems,
        leadTarget,
        importRows,
        importLabel: importLabel || (importRows ? "pasted list" : null),
      },
    };
  }

  // Legacy matrix shape — older dashboards and curl. The worker still runs these.
  const keywords = cleanList(raw.keywords);
  const locations = cleanList(raw.locations);
  if (picked.some((source) => source !== "csv") && (!keywords.length || !locations.length)) {
    return { ok: false, error: `Discovery needs a keyword, country, and city (${parsed.error})`, status: 400 };
  }
  return {
    ok: true,
    value: {
      keywords,
      locations,
      searchSpec: null,
      sources: picked,
      maxItems,
      leadTarget,
      importRows,
      importLabel: importLabel || (importRows ? "pasted list" : null),
    },
  };
}
