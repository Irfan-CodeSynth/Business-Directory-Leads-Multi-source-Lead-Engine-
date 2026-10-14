"use client";

import { useEffect, useMemo, useState } from "react";
import type { LeadRow } from "@/lib/types";
import { PAGE_SIZE, rangeText, slicePage, totalPages } from "@/lib/pagination";
import { sourceChip, sourceLabel } from "@/lib/sourceMeta";
import Pagination from "@/components/Pagination";
import {
  Search,
  Download,
  Star,
  ExternalLink,
  Phone,
  Copy,
  Check,
  Globe,
  MapPin,
  CheckCircle2,
  X,
  FileText,
  Trash2,
} from "lucide-react";

const LEAD_STATUSES = ["new", "contacted", "replied", "won", "lost"];

const STATUS_CONFIG: Record<
  string,
  { label: string; badge: string; dot: string }
> = {
  new: { label: "New", badge: "bg-surface2 text-muted border-line", dot: "bg-muted" },
  contacted: { label: "Contacted", badge: "bg-info-fg/10 text-info-fg border-info-fg/20", dot: "bg-info-fg" },
  replied: { label: "Replied", badge: "bg-accent/10 text-accent border-accent/20", dot: "bg-accent" },
  won: { label: "Won", badge: "bg-ok-fg/10 text-ok-fg border-ok-fg/25", dot: "bg-ok-fg" },
  lost: { label: "Lost", badge: "bg-bad-fg/10 text-bad-fg border-bad-fg/20", dot: "bg-bad-fg" },
};

const SOCIAL_KEYS: Array<[keyof LeadRow, string, string]> = [
  ["instagram", "Instagram", "IG"],
  ["facebook", "Facebook", "FB"],
  ["linkedin", "LinkedIn", "IN"],
  ["twitter", "X", "X"],
  ["youtube", "YouTube", "YT"],
  ["tiktok", "TikTok", "TT"],
];

/**
 * Where an email came from, in the words a user trusts before sending it. `profile`
 * is the listing we collected (an OSM tag, a licensed directory row), not the web.
 */
const EMAIL_SOURCE_LABEL: Record<string, string> = {
  profile: "from the listing",
  website: "from their site",
  import: "from your imported list",
  both: "listing + their site",
};

function locationText(lead: LeadRow): string {
  const tail = [lead.city, [lead.region, lead.postalCode].filter(Boolean).join(" ")]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return [lead.address, tail].filter(Boolean).join(", ");
}

export default function LeadsTable({
  leads,
  jobId,
  skipped = 0,
}: {
  leads: LeadRow[];
  jobId: number;
  skipped?: number;
}) {
  const [data, setData] = useState<LeadRow[]>(leads);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [page, setPage] = useState(1);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const availableSources = useMemo(() => {
    const seen = new Set<string>();
    for (const lead of data) for (const s of lead.sources) seen.add(s);
    return [...seen].sort();
  }, [data]);

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: data.length };
    for (const s of LEAD_STATUSES) counts[s] = 0;
    for (const l of data) {
      if (counts[l.status] !== undefined) counts[l.status]++;
    }
    return counts;
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.filter((l) => {
      if (statusFilter && l.status !== statusFilter) return false;
      if (sourceFilter && !l.sources.includes(sourceFilter)) return false;
      if (!q) return true;
      return (
        l.name.toLowerCase().includes(q) ||
        (l.phone ?? "").toLowerCase().includes(q) ||
        (l.category ?? "").toLowerCase().includes(q) ||
        (l.emails ?? []).some((e) => e.toLowerCase().includes(q))
      );
    });
  }, [data, query, statusFilter, sourceFilter]);

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, sourceFilter]);

  const pageCount = totalPages(filtered.length);
  const visible = slicePage(filtered, page, PAGE_SIZE);

  function patchLocal(id: number, patch: Partial<LeadRow>) {
    setData((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  async function updateStatus(id: number, status: string) {
    const original = leads.find((l) => l.id === id)?.status ?? "new";
    patchLocal(id, { status });
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => null);
    if (!res || !res.ok) patchLocal(id, { status: original });
  }

  async function batchUpdateStatus(status: string) {
    const ids = [...selected];
    for (const id of ids) {
      patchLocal(id, { status });
      void fetch(`/api/leads/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      }).catch(() => {});
    }
  }

  async function saveNotes(id: number, notes: string) {
    patchLocal(id, { notes });
    await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    }).catch(() => {});
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setConfirmDelete(false);
    setDeleteNote(null);
  }

  function toggleAll() {
    setSelected((prev) => {
      const matching = filtered.map((l) => l.id);
      const allOn = matching.length > 0 && matching.every((id) => prev.has(id));
      return allOn ? new Set() : new Set(matching);
    });
    setConfirmDelete(false);
    setDeleteNote(null);
  }

  async function deleteSelected() {
    setDeleting(true);
    setDeleteNote(null);
    try {
      const res = await fetch("/api/leads/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteNote((json as { error?: string }).error ?? "Could not delete these leads");
      } else {
        const gone = new Set(selected);
        setData((prev) => prev.filter((l) => !gone.has(l.id)));
        setSelected(new Set());
        setConfirmDelete(false);
        setPage(1);
      }
    } catch {
      setDeleteNote("Network error while deleting");
    } finally {
      setDeleting(false);
    }
  }

  function exportCsv(ids: number[]) {
    const params = new URLSearchParams({ jobId: String(jobId) });
    if (ids.length) params.set("ids", ids.join(","));
    window.location.href = `/api/export?${params.toString()}`;
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopiedEmail(text);
    setTimeout(() => setCopiedEmail(null), 2000);
  }

  const allMatchingSelected =
    filtered.length > 0 && filtered.every((l) => selected.has(l.id));

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Status Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setStatusFilter("")}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${
              statusFilter === ""
                ? "bg-accent text-white shadow-accent"
                : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
            }`}
          >
            All Leads <span className="ml-1 opacity-75">({statusCounts.all})</span>
          </button>
          {LEAD_STATUSES.map((s) => {
            const isCurrent = statusFilter === s;
            const cfg = STATUS_CONFIG[s];
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${
                  isCurrent
                    ? "bg-accent text-white shadow-accent"
                    : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    isCurrent ? "bg-white" : cfg?.dot || "bg-muted"
                  }`}
                />
                <span className="capitalize">{s}</span>
                <span className="opacity-75">({statusCounts[s] || 0})</span>
              </button>
            );
          })}
        </div>

        {availableSources.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-soft">Source</span>
            <button
              onClick={() => setSourceFilter("")}
              className={`rounded-xl px-2.5 py-1 text-[11px] font-semibold transition active:scale-95 ${
                sourceFilter === ""
                  ? "bg-ink text-page"
                  : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
              }`}
            >
              All
            </button>
            {availableSources.map((s) => (
              <button
                key={s}
                onClick={() => setSourceFilter(s)}
                className={`rounded-xl px-2.5 py-1 text-[11px] font-semibold transition active:scale-95 ${
                  sourceFilter === s ? "bg-ink text-page" : sourceChip(s)
                }`}
              >
                {sourceLabel(s)}
              </button>
            ))}
          </div>
        )}

        {/* Search & Actions */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px]">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-soft" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, phone, email…"
              className="w-full rounded-xl border border-line bg-surface py-2 pl-9 pr-8 text-xs text-ink outline-none transition placeholder:text-soft focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-2.5 text-soft hover:text-ink transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            onClick={() => exportCsv([])}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent active:scale-95"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Floating Selected Banner */}
      {selected.size > 0 && (
        <div className="animate-fade-in flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/25 bg-accent-soft/60 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2 font-semibold text-accent">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {selected.size} lead{selected.size === 1 ? "" : "s"} selected
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {deleteNote && <span className="text-bad-fg">{deleteNote}</span>}
            <span className="text-muted">Batch Status:</span>
            {LEAD_STATUSES.map((st) => (
              <button
                key={st}
                onClick={() => batchUpdateStatus(st)}
                className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] font-medium capitalize text-ink transition hover:border-accent hover:text-accent"
              >
                Mark {st}
              </button>
            ))}
            <button
              onClick={() => exportCsv([...selected])}
              className="inline-flex items-center gap-1 rounded-lg bg-accent-strong px-3 py-1 font-semibold text-white shadow-accent transition hover:bg-accent-dark active:scale-95"
            >
              <Download className="h-3 w-3" />
              Export Selected
            </button>
            {confirmDelete ? (
              <>
                <button
                  onClick={deleteSelected}
                  disabled={deleting}
                  className="inline-flex items-center gap-1 rounded-lg bg-bad-fg px-3 py-1 font-semibold text-white transition hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {deleting ? "Deleting…" : `Confirm delete ${selected.size}`}
                </button>
                <button
                  onClick={() => {
                    setConfirmDelete(false);
                    setDeleteNote(null);
                  }}
                  className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete these leads and their notes. Their businesses become collectable again."
                className="inline-flex items-center gap-1 rounded-lg border border-bad-fg/40 bg-surface px-3 py-1 font-semibold text-bad-fg transition hover:bg-bad-bg/50 active:scale-95"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table Data State */}
      {data.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center rounded-3xl p-12 text-center shadow-card">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface2 text-muted mb-3">
            <MapPin className="h-6 w-6" />
          </div>
          <p className="text-sm font-semibold text-ink">
            {leads.length === 0 && skipped > 0
              ? `All ${skipped} businesses found were already in the ledger from an earlier run.`
              : "No leads collected yet — the worker may still be running."}
          </p>
          <p className="mt-1 text-xs text-muted max-w-sm">
            Open the jobs list to watch collection and website enrichment progress live.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card rounded-2xl p-10 text-center text-sm text-muted">
          No leads match your current query or filter.
        </div>
      ) : (
        <>
          {/* Responsive Full-Width Table - Zero Horizontal Scroll */}
          <div
            key={page}
            className="glass-card overflow-hidden rounded-3xl border border-line shadow-card"
          >
            <table className="w-full text-left text-xs table-fixed">
              <thead className="border-b border-line bg-surface2/70 text-[11px] font-semibold uppercase tracking-wider text-soft">
                <tr>
                  <th className="py-3 px-3 w-9 text-center">
                    <input
                      type="checkbox"
                      checked={allMatchingSelected}
                      onChange={toggleAll}
                      aria-label="Select all matching leads"
                    />
                  </th>
                  <th className="py-3 px-3.5 w-[30%]">Business</th>
                  <th className="py-3 px-3.5 w-[18%]">Contact & Web</th>
                  <th className="py-3 px-3 w-[12%]">Rating</th>
                  <th className="py-3 px-3.5 w-[16%]">Verified Outreach</th>
                  <th className="py-3 px-3 w-[11%]">CRM Status</th>
                  <th className="py-3 px-3.5 w-[13%]">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {visible.map((l, i) => {
                  const cfg = STATUS_CONFIG[l.status] || STATUS_CONFIG.new!;
                  return (
                    <tr
                      key={l.id}
                      className="row-in align-middle transition-colors hover:bg-surface2/50"
                      style={{ animationDelay: `${Math.min(i, 9) * 15}ms` }}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={selected.has(l.id)}
                          onChange={() => toggle(l.id)}
                          aria-label={`Select ${l.name}`}
                        />
                      </td>

                      {/* Business & Category & Address */}
                      <td className="py-3 px-3.5">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {l.profileUrl ? (
                              <a
                                href={l.profileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="group inline-flex items-center gap-1 font-bold text-ink hover:text-accent transition truncate max-w-[240px]"
                                title={l.name}
                              >
                                <span className="truncate">{l.name}</span>
                                <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100 transition text-accent" />
                              </a>
                            ) : (
                              <span className="font-bold text-ink truncate max-w-[240px]" title={l.name}>
                                {l.name}
                              </span>
                            )}
                            {l.sources.length > 1 && (
                              <span
                                className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent shrink-0"
                                title={`Found on: ${l.sources.map(sourceLabel).join(", ")}`}
                              >
                                {l.sources.length} sources
                              </span>
                            )}
                            {l.category && (
                              <span className="rounded-md bg-surface2 px-1.5 py-0.5 text-[10px] font-medium text-muted shrink-0">
                                {l.category}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="text-[10px] font-semibold text-muted">{sourceLabel(l.source)}</span>
                            {l.enriched && (
                              <span className="rounded bg-ok-fg/10 px-1 py-0.5 text-[9px] font-bold text-ok-fg">
                                site crawled
                              </span>
                            )}
                          </div>
                          {locationText(l) && (
                            <span
                              className="mt-0.5 text-[11px] text-soft truncate max-w-xs"
                              title={locationText(l)}
                            >
                              {locationText(l)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Phone & Website */}
                      <td className="py-3 px-3.5">
                        <div className="flex flex-col gap-1">
                          {l.phone ? (
                            <a
                              href={`tel:${l.phone}`}
                              className="inline-flex items-center gap-1 font-mono text-[11px] text-muted hover:text-accent transition truncate"
                            >
                              <Phone className="h-3 w-3 text-soft shrink-0" />
                              <span className="truncate">{l.phone}</span>
                            </a>
                          ) : (
                            <span className="text-soft text-[11px]">—</span>
                          )}
                          {l.website ? (
                            <a
                              href={l.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-[11px] text-accent hover:underline truncate"
                            >
                              <Globe className="h-3 w-3 shrink-0" />
                              <span className="truncate">Website</span>
                            </a>
                          ) : null}
                        </div>
                      </td>

                      {/* Rating */}
                      <td className="py-3 px-3 tabular-nums">
                        {l.rating != null ? (
                          <div className="flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                            <Star className="h-3.5 w-3.5 fill-current shrink-0" />
                            <span>{l.rating.toFixed(1)}</span>
                            <span className="text-[10px] font-normal text-soft">({l.reviewCount ?? 0})</span>
                          </div>
                        ) : (
                          <span className="text-soft">—</span>
                        )}
                      </td>

                      {/* Verified Emails & Socials */}
                      <td className="py-3 px-3.5">
                        <div className="flex flex-col gap-1.5">
                          {l.emails && l.emails.length > 0 ? (
                            <div className="flex items-center justify-between gap-1 rounded-md bg-ok-fg/10 px-2 py-0.5 text-[11px] font-medium text-ok-fg max-w-[170px]">
                              <span className="truncate" title={l.emails[0]}>{l.emails[0]}</span>
                              <button
                                onClick={() => copyToClipboard(l.emails![0]!)}
                                title="Copy email"
                                className="p-0.5 text-ok-fg/80 hover:text-ok-fg transition shrink-0"
                              >
                                {copiedEmail === l.emails[0] ? (
                                  <Check className="h-3 w-3" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                            </div>
                          ) : null}

                          {l.emailSource && (
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-soft">
                              {EMAIL_SOURCE_LABEL[l.emailSource] ?? l.emailSource}
                            </span>
                          )}

                          <div className="flex gap-1 flex-wrap">
                            {SOCIAL_KEYS.map(([key, title, label]) => {
                              const url = l[key] as string | null;
                              return url ? (
                                <a
                                  key={key}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={title}
                                  className="rounded border border-line bg-surface px-1 py-0.2 text-[9px] font-bold text-muted transition hover:border-accent hover:text-accent"
                                >
                                  {label}
                                </a>
                              ) : null;
                            })}
                            {!l.emails?.length && SOCIAL_KEYS.every(([key]) => !l[key]) && (
                              <span className="text-soft text-[11px]">—</span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-3">
                        <select
                          value={l.status}
                          onChange={(e) => updateStatus(l.id, e.target.value)}
                          className={`w-full rounded-xl border px-2 py-1 text-[11px] font-semibold outline-none transition focus:border-accent cursor-pointer ${cfg.badge}`}
                        >
                          {LEAD_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.toUpperCase()}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Notes */}
                      <td className="py-3 px-3.5">
                        <div className="relative">
                          <input
                            type="text"
                            defaultValue={l.notes ?? ""}
                            onBlur={(e) => {
                              if (e.target.value !== (l.notes ?? "")) saveNotes(l.id, e.target.value);
                            }}
                            placeholder="Add note…"
                            className="w-full rounded-xl border border-line bg-surface py-1 pl-2 pr-2 text-[11px] text-ink outline-none transition placeholder:text-soft focus:border-accent focus:ring-1 focus:ring-accent/20"
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-col items-center gap-1.5">
            <span className="text-xs text-soft">
              {rangeText(filtered.length, page, PAGE_SIZE)} · {filtered.length} leads matching
            </span>
            <Pagination page={page} pageCount={pageCount} onChange={setPage} noun="pages" />
          </div>
        </>
      )}
    </div>
  );
}
