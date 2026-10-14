"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobSummary } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { PAGE_SIZE, rangeText } from "@/lib/pagination";
import { statusBadge } from "@/lib/jobStatus";
import { sourceChip, sourceLabel } from "@/lib/sourceMeta";
import Pagination from "@/components/Pagination";
import {
  Layers,
  MapPin,
  Search,
  RotateCcw,
  Square,
  ArrowUpRight,
  Sparkles,
  AlertCircle,
  Plus,
  Table2,
  CheckCircle2,
  Trash2,
} from "lucide-react";

const ACTIVE = new Set(["pending", "running"]);

function statusLabel(j: JobSummary): string {
  if (j.status !== "running") return j.status;
  if (j.cancelRequested) return "stopping…";
  if (!j.phase) return "running";
  return j.phaseTotal ? `${j.phase} ${j.phaseDone ?? 0}/${j.phaseTotal}` : j.phase;
}

function Badge({ job }: { job: JobSummary }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(
        job.status,
      )}`}
    >
      {ACTIVE.has(job.status) && (
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-current" aria-hidden />
      )}
      {statusLabel(job)}
    </span>
  );
}

function ProgressBar({ job }: { job: JobSummary }) {
  const total = job.phase === "enriching" ? job.phaseTotal ?? 0 : 0;
  const pct = total ? Math.round(((job.phaseDone ?? 0) / total) * 100) : 0;

  return (
    <div className="mt-2 h-1.5 w-44 overflow-hidden rounded-full bg-surface2">
      {total ? (
        <div
          className="bar-fill h-full rounded-full bg-gradient-to-r from-accent to-accent-dark transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="bar-indeterminate h-full w-full rounded-full bg-accent/70" />
      )}
    </div>
  );
}

export default function JobsList({
  initialJobs,
  page: initialPage,
  pageCount: initialPageCount,
  total: initialTotal,
}: {
  initialJobs: JobSummary[];
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<JobSummary[]>(initialJobs);
  const [page, setPage] = useState(initialPage);
  const [pageCount, setPageCount] = useState(initialPageCount);
  const [total, setTotal] = useState(initialTotal);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pageRef = useRef(page);
  pageRef.current = page;

  const refresh = useCallback(async (target = pageRef.current) => {
    try {
      const res = await fetch(`/api/jobs/list?page=${target}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        jobs: JobSummary[];
        total: number;
        page: number;
        pageCount: number;
      };
      setRows(data.jobs);
      setTotal(data.total);
      setPageCount(data.pageCount);
      setPage(data.page);
      setError(null);
    } catch {
      setError("Live updates paused: cannot reach the server");
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  function go(next: number) {
    setPage(next);
    void refresh(next);
    router.push(next === 1 ? "/jobs" : `/jobs?page=${next}`, { scroll: false });
  }

  async function stop(id: number) {
    await fetch(`/api/jobs/${id}/stop`, { method: "POST" }).catch(() => {});
    await refresh();
  }

  async function rerun(id: number, mode: "all" | "blocked" = "all") {
    await fetch(`/api/jobs/${id}/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
    await refresh();
  }

  const filteredRows = useMemo(() => {
    return rows.filter((j) => {
      if (filterStatus === "active" && !ACTIVE.has(j.status)) return false;
      if (filterStatus === "done" && j.status !== "done") return false;
      if (filterStatus === "error" && j.status !== "error" && j.status !== "cancelled") return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        j.keywords.some((k) => k.toLowerCase().includes(q)) ||
        j.locations.some((l) => l.toLowerCase().includes(q)) ||
        j.sources.some((s) => s.toLowerCase().includes(q)) ||
        (j.importLabel ?? "").toLowerCase().includes(q) ||
        String(j.id).includes(q)
      );
    });
  }, [rows, filterStatus, search]);

  const deletableRows = useMemo(
    () => filteredRows.filter((j) => !ACTIVE.has(j.status)),
    [filteredRows],
  );
  const allSelected = deletableRows.length > 0 && deletableRows.every((j) => selected.has(j.id));

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setConfirmDelete(false);
    setDeleteNote(null);
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const j of deletableRows) allSelected ? next.delete(j.id) : next.add(j.id);
      return next;
    });
    setConfirmDelete(false);
    setDeleteNote(null);
  }

  async function deleteSelected() {
    setDeleting(true);
    setDeleteNote(null);
    try {
      const res = await fetch("/api/jobs/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteNote((json as { error?: string }).error ?? "Could not delete these runs");
      } else {
        setSelected(new Set());
        setConfirmDelete(false);
        await refresh();
      }
    } catch {
      setDeleteNote("Network error while deleting");
    } finally {
      setDeleting(false);
    }
  }

  if (total === 0) {
    return (
      <div className="glass-card flex flex-col items-center justify-center rounded-3xl p-12 text-center shadow-card">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent mb-4">
          <Layers className="h-7 w-7" />
        </div>
        <h3 className="text-lg font-bold text-ink">No lead runs yet</h3>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Start with OpenStreetMap plus website enrichment, or import a list you already hold. Both feed
          the same deduplicated ledger.
        </p>
        <Link
          href="/new"
          className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-accent-strong px-5 py-2.5 text-sm font-semibold text-white shadow-accent transition hover:bg-accent-dark active:scale-95"
        >
          <Plus className="h-4 w-4" />
          Create First Job
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Search & Filter Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { id: "all", label: "All Runs" },
            { id: "active", label: "Active / Running" },
            { id: "done", label: "Completed" },
            { id: "error", label: "Failed / Stopped" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterStatus(tab.id)}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${
                filterStatus === tab.id
                  ? "bg-accent text-white shadow-accent"
                  : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-soft" />
          <input
            type="text"
            placeholder="Search keywords or cities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-surface py-2 pl-9 pr-3 text-xs text-ink outline-none transition placeholder:text-soft focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-warn-bg bg-warn-bg/40 p-3 text-xs text-warn-fg">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Floating Selected Banner */}
      {selected.size > 0 && (
        <div className="animate-fade-in flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/25 bg-accent-soft/60 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2 font-semibold text-accent">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {selected.size} run{selected.size === 1 ? "" : "s"} selected
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {deleteNote && <span className="text-bad-fg">{deleteNote}</span>}
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
                title="Delete these runs with their leads. Their businesses become collectable again."
                className="inline-flex items-center gap-1 rounded-lg border border-bad-fg/40 bg-surface px-3 py-1 font-semibold text-bad-fg transition hover:bg-bad-bg/50 active:scale-95"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            )}
          </div>
        </div>
      )}

      {/* Modern Table Container */}
      <div
        key={page}
        className="glass-card overflow-hidden rounded-3xl border border-line shadow-card"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line bg-surface2/70 text-[11px] font-semibold uppercase tracking-wider text-soft">
              <tr>
                <th className="w-10 px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={deletableRows.length === 0}
                    aria-label="Select all deletable runs on this page"
                  />
                </th>
                <th className="px-5 py-3.5">Job ID</th>
                <th className="px-5 py-3.5">Sources &amp; targets</th>
                <th className="px-5 py-3.5">Status &amp; phase</th>
                <th className="px-5 py-3.5 text-right">New leads</th>
                <th className="px-5 py-3.5 text-right">Already known</th>
                <th className="px-5 py-3.5">Created</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-sm text-muted">
                    No jobs match your search or filter.
                  </td>
                </tr>
              ) : (
                filteredRows.map((j, i) => (
                  <tr
                    key={j.id}
                    className="row-in transition-colors hover:bg-surface2/50"
                    style={{ animationDelay: `${Math.min(i, 9) * 25}ms` }}
                  >
                    <td className="px-4 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={selected.has(j.id)}
                        onChange={() => toggleSelect(j.id)}
                        disabled={ACTIVE.has(j.status)}
                        aria-label={`Select run ${j.id}`}
                        {...(ACTIVE.has(j.status) ? { title: "Stop it first" } : {})}
                      />
                    </td>
                    <td className="px-5 py-4 font-mono text-xs font-semibold text-soft">
                      #{j.id}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {j.sources.map((source) => (
                          <span
                            key={source}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${sourceChip(source)}`}
                          >
                            {sourceLabel(source)}
                          </span>
                        ))}
                        {j.sources.includes("osm") && (
                          <span className="text-xs font-semibold text-ink tabular-nums">
                            {j.keywords.length} &times; {j.locations.length} · cap {j.maxItems} ·{" "}
                            {j.leadTarget} new per source
                          </span>
                        )}
                        {j.importRows > 0 && (
                          <span className="text-xs font-semibold text-ink tabular-nums">
                            {j.importRows} rows
                          </span>
                        )}
                      </div>
                      {j.keywords.length > 0 && (
                        <div className="mt-0.5 max-w-sm truncate text-xs text-muted">{j.keywords.join(", ")}</div>
                      )}
                      {j.locations.length > 0 && (
                        <div className="max-w-sm truncate text-[11px] text-soft">
                          <MapPin className="mr-1 inline h-3 w-3" />
                          {j.locations.join(", ")}
                        </div>
                      )}
                      {j.importLabel && (
                        <div className="max-w-sm truncate text-[11px] text-soft">
                          <Table2 className="mr-1 inline h-3 w-3" />
                          {j.importLabel}
                        </div>
                      )}
                      {j.errorMsg && (
                        <div className="mt-1.5 max-w-sm truncate text-xs text-bad-fg" title={j.errorMsg}>
                          {j.errorMsg}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <Badge job={j} />
                      {ACTIVE.has(j.status) && <ProgressBar job={j} />}
                      {j.sourceStats.some((s) => s.status === "blocked") && (
                        <div className="mt-1.5 text-[11px] font-semibold text-warn-fg">
                          A source was rate-limited
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums font-bold text-ink">
                      {j.leadsFound.toLocaleString()}
                    </td>
                    <td
                      className="px-5 py-4 text-right tabular-nums text-muted"
                      title="Skipped at zero cost because an earlier job already captured them"
                    >
                      {j.leadsSkipped > 0 ? j.leadsSkipped.toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      {formatDate(j.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/jobs/${j.id}`}
                          className="inline-flex items-center gap-1 rounded-xl bg-accent-strong px-3 py-1.5 text-xs font-semibold text-white shadow-accent transition hover:bg-accent-dark active:scale-95"
                        >
                          Results
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                        {ACTIVE.has(j.status) ? (
                          <button
                            onClick={() => stop(j.id)}
                            disabled={j.cancelRequested}
                            title="Stop after the lead currently being saved. Already collected leads stay in the database."
                            className="inline-flex items-center gap-1 rounded-xl border border-bad-fg/40 px-3 py-1.5 text-xs font-medium text-bad-fg transition hover:bg-bad-bg/50 active:scale-95 disabled:opacity-50"
                          >
                            <Square className="h-3 w-3 fill-current" />
                            {j.cancelRequested ? "Stopping…" : "Stop"}
                          </button>
                        ) : (
                          <>
                            {j.sourceStats.some(
                              (s) =>
                                s.status === "blocked" ||
                                s.status === "error" ||
                                s.status === "cancelled",
                            ) && (
                              <button
                                onClick={() => rerun(j.id, "blocked")}
                                title="Re-queue only the sources that were rate-limited"
                                className="inline-flex items-center gap-1 rounded-xl border border-warn-fg/40 px-3 py-1.5 text-xs font-medium text-warn-fg transition hover:bg-warn-bg/50 active:scale-95"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Blocked only
                              </button>
                            )}
                            <button
                              onClick={() => rerun(j.id, "all")}
                              className="inline-flex items-center gap-1 rounded-xl border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:border-accent hover:text-accent active:scale-95"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Re-run
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination Footer */}
      <div className="mt-6 flex flex-col items-center gap-2">
        <p className="text-xs text-soft">
          {rangeText(total, page, PAGE_SIZE)} · {total} job{total === 1 ? "" : "s"} total
        </p>
        <Pagination page={page} pageCount={pageCount} onChange={go} noun="pages" />
      </div>
    </div>
  );
}
