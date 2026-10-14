"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAPPABLE_FIELDS, applyMapping, autoMap, toTable, type MappableField } from "@/lib/csv";
import { buildJobRequest, estimateRun, leadCapacity } from "@/lib/newJob";
import { isPaidSource, priceNote, usd } from "@/lib/sourceMeta";
import type { ApifyBudget } from "@/lib/types";
import {
  Play,
  Sparkles,
  AlertCircle,
  RotateCcw,
  Building2,
  MapPin,
  Check,
  Globe,
  Upload,
  Table2,
  Receipt,
} from "lucide-react";

const MAX = 20;

const SOURCE_OPTIONS = [
  {
    id: "osm",
    label: "OpenStreetMap",
    hint: "Name, phone, address and website from the open map, then emails from each business's own site.",
  },
  {
    id: "yelp",
    label: "Yelp",
    hint: "Phone, address, category and rating from a listing you are licensed to use. Review text is never stored.",
  },
  {
    id: "hotfrog",
    label: "HotFrog",
    hint: "B2B listings that arrive with emails and social links already attached. Review text is never stored.",
  },
  {
    id: "csv",
    label: "CSV import",
    hint: "Any list you already hold — a HotFrog export, a trade-association directory, your own spreadsheet.",
  },
] as const;

const PRESETS = [
  {
    name: "Home Services",
    keywords: ["plumber", "electrician", "hvac contractor", "roofing company"],
    locations: ["Austin, TX", "Dallas, TX"],
  },
  {
    name: "Healthcare",
    keywords: ["dental clinic", "orthodontist", "chiropractor", "dermatologist"],
    locations: ["Miami, FL", "Tampa, FL"],
  },
  {
    name: "Real Estate & Legal",
    keywords: ["real estate agency", "property management", "personal injury lawyer"],
    locations: ["Phoenix, AZ", "Scottsdale, AZ"],
  },
];

function parseLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/** Both number fields allow 1–200, which is exactly what the API clamps to. */
const clampCount = (value: string) => Math.min(Math.max(Number(value) || 1, 1), 200);

export default function NewJobForm({ apify, onSuccess }: { apify: ApifyBudget; onSuccess?: () => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<"discover" | "import">("discover");
  const [sources, setSources] = useState<string[]>(["osm"]);
  const [keywords, setKeywords] = useState("");
  const [locations, setLocations] = useState("");
  const [cap, setCap] = useState(100);
  const [target, setTarget] = useState(100);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<MappableField, string>>>({});
  const [parseError, setParseError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kw = useMemo(() => parseLines(keywords), [keywords]);
  const loc = useMemo(() => parseLines(locations), [locations]);
  const wantsOsm = sources.includes("osm");
  const paid = sources.filter(isPaidSource);
  const importing = tab === "import";
  const searches = kw.length * loc.length;
  const estimate = useMemo(
    () => estimateRun({ tab, sources, keywords: kw, locations: loc, cap, target, rows, mapping, label }, apify.monthRemaining),
    [tab, sources, kw, loc, cap, target, rows, mapping, label, apify.monthRemaining],
  );
  /** What the plan can honestly reach before the worker stops it at the target. */
  const capacity = leadCapacity({ tab, sources, keywords: kw, locations: loc, cap, target, rows, mapping, label });
  /** Exactly the rows that will be sent: unmappable columns are gone, nameless rows too. */
  const mappedRows = useMemo(() => (importing ? applyMapping(rows, mapping) : []), [importing, rows, mapping]);

  function toggleSource(id: string) {
    setSources((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));
    setError(null);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setKeywords(preset.keywords.join("\n"));
    setLocations(preset.locations.join("\n"));
    setActivePreset(preset.name);
    setError(null);
  }

  function handleReset() {
    setKeywords("");
    setLocations("");
    setActivePreset(null);
    setError(null);
  }

  function ingest(text: string, sourceLabel?: string) {
    if (!text.trim()) {
      setHeaders([]);
      setRows([]);
      setMapping({});
      setParseError(null);
      return;
    }
    const table = toTable(text);
    if (!table.rows.length) {
      setParseError("No data rows found — a header line plus at least one row is required.");
      setHeaders([]);
      setRows([]);
      setMapping({});
      return;
    }
    setParseError(null);
    setHeaders(table.headers);
    setRows(table.rows);
    setMapping(autoMap(table.headers));
    if (sourceLabel) setLabel(sourceLabel);
  }

  async function readFile(file: File) {
    const text = await file.text();
    setRaw("");
    ingest(text, file.name);
  }

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const request = buildJobRequest({ tab, sources, keywords: kw, locations: loc, cap, target, rows, mapping, label });
    if (!request.ok) return setError(request.error);

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not create the job");
        setBusy(false);
        return;
      }

      if (onSuccess) onSuccess();
      else {
        router.push(`/jobs/${data.id}`);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server. Is `npm run web` still running?");
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-2xl border border-line bg-surface2/60 p-4 font-mono text-sm text-ink outline-none transition placeholder:text-soft focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15";
  const card =
    "flex flex-col rounded-3xl border border-line bg-surface p-5 shadow-card transition-all focus-within:border-accent/50 focus-within:shadow-lift";

  return (
    <form onSubmit={submit} className="space-y-6">
      {/* Source tabs */}
      <div className="inline-flex rounded-2xl border border-line bg-surface2/60 p-1">
        {(
          [
            { id: "discover", label: "Discover", icon: MapPin },
            { id: "import", label: "Import a list", icon: Upload },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition active:scale-95 ${
                tab === t.id ? "bg-accent-strong text-white shadow-accent" : "text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Source chips */}
      <div>
        <div className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted">Sources</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {SOURCE_OPTIONS.map((option) => {
            const picked = importing ? option.id === "csv" : sources.includes(option.id);
            const disabled = importing ? option.id !== "csv" : option.id === "csv";
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => toggleSource(option.id)}
                className={`rounded-2xl border p-4 text-left transition active:scale-[0.99] disabled:opacity-40 ${
                  picked && !disabled
                    ? "border-accent bg-accent-soft/50 shadow-card"
                    : "border-line bg-surface hover:border-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">{option.label}</span>
                  {picked && !disabled && <Check className="h-4 w-4 text-accent" />}
                </div>
                <div
                  className={`mt-1 text-[10px] font-semibold uppercase tracking-wider ${
                    isPaidSource(option.id) ? "text-warn-fg" : "text-ok-fg"
                  }`}
                >
                  {priceNote(option.id)}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  {disabled && option.id === "csv" ? "Paste or drop a list in the Import a list tab." : option.hint}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {tab === "discover" ? (
        <>
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                Industry presets
              </span>
              {(keywords || locations) && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center gap-1 text-xs text-soft hover:text-bad-fg transition"
                >
                  <RotateCcw className="h-3 w-3" /> Clear fields
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => {
                const isSelected = activePreset === p.name;
                return (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-medium transition active:scale-95 ${
                      isSelected
                        ? "bg-accent text-white shadow-accent"
                        : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
                    }`}
                  >
                    {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className={card}>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="keywords" className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Building2 className="h-4 w-4 text-accent" />
                  Keywords / trades
                </label>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums transition ${
                    kw.length > 0 ? "bg-accent/15 text-accent" : "bg-surface2 text-soft"
                  }`}
                >
                  {kw.length} / {MAX}
                </span>
              </div>
              <p className="mb-3 text-xs text-muted">
                One per line. Free-text terms are matched against business names as well as map
                categories, so plain words work.
              </p>
              <textarea
                id="keywords"
                value={keywords}
                onChange={(e) => {
                  setKeywords(e.target.value);
                  setActivePreset(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
                }}
                rows={6}
                placeholder={"plumber\ndentist\nlandscaper"}
                className={field}
              />
            </div>

            <div className={card}>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="locations" className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <MapPin className="h-4 w-4 text-info-fg" />
                  Locations
                </label>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums transition ${
                    loc.length > 0 ? "bg-info-fg/15 text-info-fg" : "bg-surface2 text-soft"
                  }`}
                >
                  {loc.length} / {MAX}
                </span>
              </div>
              <p className="mb-3 text-xs text-muted">
                City and state, or a postcode. Each one is geocoded once and cached.
              </p>
              <textarea
                id="locations"
                value={locations}
                onChange={(e) => {
                  setLocations(e.target.value);
                  setActivePreset(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
                }}
                rows={6}
                placeholder={"Austin, TX\nRound Rock, TX\n78704"}
                className={field}
              />
            </div>
          </div>

          {searches > 0 && (wantsOsm || paid.length > 0) && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface2/40 px-4 py-3">
                <p className="text-xs text-muted">
                  Each source stops at <span className="font-semibold text-ink tabular-nums">{target}</span> new leads,
                  whichever query reaches it first — this plan can bring at most{" "}
                  <span className="font-semibold text-ink tabular-nums">{capacity.ceiling.toLocaleString()}</span>.
                  Businesses already in the ledger are skipped and do not count toward the target.
                </p>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-xs font-medium text-muted">
                    Cap per query
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={cap}
                      onChange={(e) => setCap(clampCount(e.target.value))}
                      className="w-20 rounded-xl border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs font-medium text-muted">
                    New leads wanted per source
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={target}
                      onChange={(e) => setTarget(clampCount(e.target.value))}
                      className="w-20 rounded-xl border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                    />
                  </label>
                </div>
              </div>

              {capacity.short > 0 && (
                <div className="animate-fade-in flex items-start gap-2.5 rounded-xl border border-warn-fg/25 bg-warn-bg/40 p-3.5 text-xs text-warn-fg">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {searches} quer{searches === 1 ? "y" : "ies"} at cap {cap} cannot reach {target}: this run will
                    stop at {capacity.ceiling.toLocaleString()} new leads per source. Add keywords or nearby cities,
                    raise the cap, or lower the number you want.
                  </span>
                </div>
              )}
            </>
          )}

          {wantsOsm && searches > 0 && (
            <div className="animate-fade-in flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-accent/20 bg-accent-soft/40 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-accent">
                  <Globe className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-ink">OpenStreetMap costs nothing per result</div>
                  <div className="text-xs text-muted">
                    Queries run about one every {Math.round(cap / 10)} seconds to stay inside the free-tier
                    courtesy limits.
                  </div>
                </div>
              </div>
            </div>
          )}

          {estimate.items.length > 0 && searches > 0 && (
            <div className="animate-fade-in space-y-2 rounded-2xl border border-warn-fg/25 bg-warn-bg/50 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warn-fg text-white">
                  <Receipt className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-ink">
                    {usd(estimate.usd)} for this run, billed by Apify
                  </div>
                  <div className="text-xs text-muted">
                    {estimate.items.map((item) => `${item.label}: ${item.results.toLocaleString()} results · ${usd(item.usd)}`).join(" · ")}
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted">
                {apify.monthRemaining.toLocaleString()} of {apify.monthlyCap.toLocaleString()} paid results left in
                this month's cap. Apify charges for everything an Actor returns, including listings the ledger
                already knows — so the cap counts those too.
              </div>
              {estimate.over > 0 && (
                <p className="text-xs font-semibold text-warn-fg">
                  {estimate.over.toLocaleString()} of the results this run wants do not fit the cap, so they will not
                  be requested. Raise APIFY_MONTHLY_RESULT_CAP or wait for the 1st.
                </p>
              )}
              {!apify.configured && (
                <p className="flex items-start gap-2 text-xs font-semibold text-bad-fg">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>APIFY_API_TOKEN is not set. The worker will stop this source as blocked, before spending.</span>
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <div className={card}>
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Upload className="h-4 w-4 text-accent" />
                  File or paste
                </span>
                {rows.length > 0 && (
                  <span className="rounded-full bg-ok-fg/10 px-2.5 py-0.5 text-xs font-semibold text-ok-fg tabular-nums">
                    {mappedRows.length} rows
                    {mappedRows.length < rows.length ? ` · ${rows.length - mappedRows.length} without a name skipped` : ""}
                  </span>
                )}
              </div>
              <p className="mb-3 text-xs text-muted">
                A header line plus data rows. Commas, tabs and semicolons are all detected. Only lists you
                are entitled to use.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                }}
                className="mb-3 w-full rounded-xl border border-dashed border-line bg-surface2/40 p-3 text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-accent"
              />
              <textarea
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  ingest(e.target.value);
                }}
                rows={7}
                placeholder={"Business,Phone,Email,Website,City\nAcme Plumbing,512-555-0123,jobs@acme.example,Austin"}
                className={field}
              />
            </div>

            <div className={card}>
              <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <Table2 className="h-4 w-4 text-info-fg" />
                Column mapping
              </span>
              {!headers.length ? (
                <p className="text-xs text-muted">
                  Load a list and each column gets matched automatically — adjust anything odd here.
                </p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {MAPPABLE_FIELDS.map((target) => (
                    <label key={target} className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-muted">{target}</span>
                      <select
                        value={mapping[target] ?? ""}
                        onChange={(e) =>
                          setMapping((current) => {
                            const next = { ...current };
                            if (e.target.value) next[target] = e.target.value;
                            else delete next[target];
                            return next;
                          })
                        }
                        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                      >
                        <option value="">— not mapped —</option>
                        {headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label this list (e.g. HotFrog Austin plumbers)"
                    className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-accent"
                  />
                </div>
              )}
            </div>
          </div>

          {parseError && (
            <div className="animate-fade-in flex items-center gap-2.5 rounded-xl border border-bad-bg bg-bad-bg/30 p-3.5 text-sm font-medium text-bad-fg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{parseError}</span>
            </div>
          )}

          {mappedRows.length > 0 && (
            <div className="glass-card overflow-hidden rounded-2xl">
              <div className="border-b border-line px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-soft">
                Preview · first 3 of {mappedRows.length} rows that will import
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface2/60 text-soft">
                    <tr>
                      {MAPPABLE_FIELDS.filter((f) => mapping[f]).map((f) => (
                        <th key={f} className="px-3 py-2 font-semibold">
                          {f}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mappedRows.slice(0, 3).map((row, i) => (
                      <tr key={i} className="row-in border-t border-line/60" style={{ animationDelay: `${i * 60}ms` }}>
                        {MAPPABLE_FIELDS.filter((f) => mapping[f]).map((f) => (
                          <td key={f} className="max-w-[220px] truncate px-3 py-2 text-muted">
                            {row[f] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="animate-fade-in flex items-center gap-2.5 rounded-xl border border-bad-bg bg-bad-bg/30 p-3.5 text-sm font-medium text-bad-fg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-2xl bg-accent-strong px-7 py-3 text-sm font-semibold text-white shadow-accent transition hover:bg-accent-dark hover:shadow-lift active:scale-95 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? (
            <>
              <Spinner /> Queuing…
            </>
          ) : (
            <>
              <Play className="h-4 w-4 fill-current" />
              {tab === "import" ? "Import leads" : "Start lead run"}
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin-slow" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
