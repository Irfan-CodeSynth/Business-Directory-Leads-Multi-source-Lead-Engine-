"use client";

import { useState } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import type { JobSummary, SourceStat } from "@/lib/types";
import { SOURCE_LABELS, blockedHint, estimateCost, isPaidSource, sourceBadge, usd } from "@/lib/sourceMeta";

const STATUS_TONE: Record<string, string> = {
  pending: "bg-idle-bg text-idle-fg",
  running: "bg-info-bg text-info-fg",
  done: "bg-ok-bg text-ok-fg",
  blocked: "bg-warn-bg text-warn-fg",
  error: "bg-bad-bg text-bad-fg",
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface2/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-soft">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

export default function SourceBreakdown({ job }: { job: JobSummary }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const blocked = job.sourceStats.filter(
    (s) => s.status === "blocked" || s.status === "error" || s.status === "cancelled",
  );

  async function rerun(mode: "all" | "blocked") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/rerun`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage((json as { error?: string }).error ?? "Could not re-run this job");
      } else {
        setMessage("Re-queued — the run starts as soon as a worker picks it up");
      }
    } catch {
      setMessage("Network error while re-queuing");
    } finally {
      setBusy(false);
    }
  }

  if (!job.sourceStats.length) {
    return (
      <div className="glass-card rounded-2xl p-4 text-xs text-muted">
        No source has started yet. A queued job begins the moment the worker claims it.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {job.sourceStats.map((stat: SourceStat) => (
          <div key={stat.source} className="glass-card glass-card-hover rounded-2xl p-4 animate-fade-up">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink">{SOURCE_LABELS[stat.source] ?? stat.source}</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                  STATUS_TONE[stat.status] ?? sourceBadge(stat.status)
                }`}
              >
                {stat.status}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="New" value={stat.found} />
              <Stat label="Known" value={stat.skipped} />
              <Stat label="Merged" value={stat.merged} />
              {/* A paid source is metered in results, not in requests — the invoice follows the listings. */}
              {isPaidSource(stat.source) ? (
                <Stat label="Results" value={stat.resultsPulled} />
              ) : (
                <Stat label="Requests" value={stat.requestsUsed} />
              )}
            </div>

            {isPaidSource(stat.source) && stat.resultsPulled > 0 && (
              <p className="mt-2 text-[11px] text-muted">
                Billed by Apify · about {usd(estimateCost(stat.source, stat.resultsPulled))} at the published rate.
              </p>
            )}

            {stat.status === "blocked" && (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-warn-bg px-3 py-2 text-[11px] text-warn-fg">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{blockedHint(stat.source)}</span>
              </p>
            )}
            {stat.lastError && (
              <p className="mt-2 truncate text-[11px] text-bad-fg" title={stat.lastError}>
                {stat.lastError}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {blocked.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => rerun("blocked")}
            className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3.5 py-2 text-xs font-semibold text-accent transition hover:border-accent active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin-slow" : ""}`} />
            Re-run blocked sources
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => rerun("all")}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin-slow" : ""}`} />
          Re-run everything
        </button>
        {message && <span className="text-xs text-muted">{message}</span>}
      </div>
    </div>
  );
}
