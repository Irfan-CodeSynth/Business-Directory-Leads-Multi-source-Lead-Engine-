import { NextResponse } from "next/server";
import { sources, jobs, type Source } from "@dleads/db";
import { getDb } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_LIST_ITEMS = 20;
const MAX_IMPORT_ROWS = 5000;
const MAX_CELL_CHARS = 300;

function cleanList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST_ITEMS);
}

function cleanSources(input: unknown): Source[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const picked = input.filter((v): v is Source => typeof v === "string" && (sources as readonly string[]).includes(v));
  return picked.length ? [...new Set(picked)] : null;
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

export async function POST(req: Request) {
  const uid = currentUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    keywords?: unknown;
    locations?: unknown;
    sources?: unknown;
    maxItems?: unknown;
    leadTarget?: unknown;
    importRows?: unknown;
    importLabel?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const picked = cleanSources(body.sources);
  if (!picked) return NextResponse.json({ error: "Pick at least one source" }, { status: 400 });

  const keywords = cleanList(body.keywords);
  const locations = cleanList(body.locations);
  const importRows = picked.includes("csv") ? cleanRows(body.importRows) : null;

  if (picked.includes("csv") && !importRows) {
    return NextResponse.json({ error: "A CSV import needs at least one mapped row" }, { status: 400 });
  }
  // Every directory source — free or paid — works through the keyword x location matrix.
  // A paid source with an empty term would bill for whatever the Actor decides to return.
  if (picked.some((source) => source !== "csv") && (!keywords.length || !locations.length)) {
    return NextResponse.json({ error: `Discovery needs keywords and locations (1-${MAX_LIST_ITEMS} each)` }, { status: 400 });
  }

  const requested = Number(body.maxItems);
  const maxItems = Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1), 200) : 25;
  const wanted = Number(body.leadTarget);
  const leadTarget = Number.isFinite(wanted) ? Math.min(Math.max(Math.round(wanted), 1), 200) : 100;

  const [created] = await getDb()
    .insert(jobs)
    .values({
      keywords,
      locations,
      sources: picked,
      maxItems,
      leadTarget,
      importRows,
      importLabel: typeof body.importLabel === "string" ? body.importLabel.trim().slice(0, 120) : null,
      status: "pending",
      createdBy: uid,
    })
    .returning({ id: jobs.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
