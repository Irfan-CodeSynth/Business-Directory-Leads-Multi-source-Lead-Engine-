"use client";

import Link from "next/link";
import { useState } from "react";
import type { ApifyBudget, DashboardStats } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { statusBadge } from "@/lib/jobStatus";
import { overlapNote } from "@/lib/dashboardCopy";
import { sourceChip, sourceLabel } from "@/lib/sourceMeta";
import NewJobForm from "@/components/NewJobForm";
import {
  Users,
  Sparkles,
  ShieldCheck,
  Layers,
  MailCheck,
  TrendingUp,
  ArrowUpRight,
  Plus,
  Building2,
  Phone,
  Globe,
  Star,
  Activity,
  ChevronRight,
  Clock,
  X,
} from "lucide-react";

export default function DashboardOverview({ stats, apify }: { stats: DashboardStats; apify: ApifyBudget }) {
  const [quickLaunchOpen, setQuickLaunchOpen] = useState(false);

  // Conversion calculations
  const totalLeads = stats.totalLeads;
  const overlap = overlapNote(stats.overlapCount);
  const contactedOrBeyond =
    (stats.statusBreakdown.contacted || 0) +
    (stats.statusBreakdown.replied || 0) +
    (stats.statusBreakdown.won || 0) +
    (stats.statusBreakdown.lost || 0);

  const winRate =
    contactedOrBeyond > 0
      ? Math.round(((stats.statusBreakdown.won || 0) / contactedOrBeyond) * 100)
      : 0;

  const PIPELINE_STAGES = [
    { key: "new", label: "New Leads", color: "bg-muted", text: "text-muted", count: stats.statusBreakdown.new || 0 },
    { key: "contacted", label: "Contacted", color: "bg-info-fg", text: "text-info-fg", count: stats.statusBreakdown.contacted || 0 },
    { key: "replied", label: "Replied", color: "bg-accent", text: "text-accent", count: stats.statusBreakdown.replied || 0 },
    { key: "won", label: "Won Deals", color: "bg-ok-fg", text: "text-ok-fg", count: stats.statusBreakdown.won || 0 },
    { key: "lost", label: "Lost", color: "bg-bad-fg", text: "text-bad-fg", count: stats.statusBreakdown.lost || 0 },
  ];

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Top Banner / Hero */}
      <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-surface via-surface to-accent-soft/30 p-6 sm:p-8 shadow-card">
        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
              <span className="flex h-2 w-2 rounded-full bg-accent animate-pulse-dot" />
              Automated Intelligence Engine
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              Lead Generation & CRM Command Center
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted sm:text-base">
              Monitor live lead runs across OpenStreetMap and your own lists, with website contact
              enrichment and pipeline tracking in one place.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setQuickLaunchOpen(!quickLaunchOpen)}
              className="inline-flex items-center gap-2 rounded-2xl bg-accent-strong px-5 py-2.5 text-sm font-semibold text-white shadow-accent transition hover:bg-accent-dark hover:shadow-lift active:scale-95"
            >
              <Plus className="h-4 w-4" />
              {quickLaunchOpen ? "Close quick setup" : "New lead run"}
            </button>
            <Link
              href="/jobs"
              className="inline-flex items-center gap-2 rounded-2xl border border-line bg-surface/80 px-4 py-2.5 text-sm font-semibold text-ink backdrop-blur-md transition hover:border-accent hover:text-accent active:scale-95"
            >
              <Activity className="h-4 w-4 text-muted" />
              Job queue ({stats.activeJobs} queued)
            </Link>
          </div>
        </div>

        {/* Quick Launch Panel */}
        {quickLaunchOpen && (
          <div className="animate-fade-up mt-8 border-t border-line/60 pt-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink">Quick setup</h3>
              <button
                onClick={() => setQuickLaunchOpen(false)}
                className="rounded-lg p-1 text-muted hover:bg-surface2 hover:text-ink transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <NewJobForm apify={apify} onSuccess={() => setQuickLaunchOpen(false)} />
          </div>
        )}
      </div>

      {/* KPI Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {/* KPI 1: Total Leads */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Total Leads</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-ink tabular-nums">
            {totalLeads.toLocaleString()}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
            {Object.keys(stats.sourceBreakdown).length === 0 ? (
              <span>No leads collected yet</span>
            ) : (
              Object.entries(stats.sourceBreakdown).map(([source, count]) => (
                <span
                  key={source}
                  className={`rounded-md px-1.5 py-0.5 font-semibold ${sourceChip(source)}`}
                >
                  {sourceLabel(source)} {count.toLocaleString()}
                </span>
              ))
            )}
          </div>
          {overlap && <div className="mt-1 text-[11px] font-semibold text-accent">{overlap}</div>}
        </div>

        {/* KPI 2: Verified Emails */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Verified Emails</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ok-fg/10 text-ok-fg">
              <MailCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-ok-fg tabular-nums">
            {stats.emailsCount.toLocaleString()}
          </div>
          <div className="mt-1 text-xs text-muted">
            Direct outreach contacts
          </div>
        </div>

        {/* KPI 3: Enrichment Rate */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Enrichment</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-dark/10 text-accent-dark">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-ink tabular-nums">
              {stats.enrichmentRate}%
            </span>
            <span className="text-xs text-muted">({stats.enrichedCount} leads)</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface2">
            <div
              className="h-full rounded-full bg-accent transition-all duration-700"
              style={{ width: `${stats.enrichmentRate}%` }}
            />
          </div>
        </div>

        {/* KPI 4: Deduplication Ledger */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Known businesses</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <ShieldCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-ink tabular-nums">
            {stats.totalKnownBusinesses.toLocaleString()}
          </div>
          <div className="mt-1 text-xs text-muted">
            Already-known listings, skipped for free
          </div>
        </div>

        {/* KPI 5: Total Jobs */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Lead runs</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-info-fg/10 text-info-fg">
              <Layers className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-ink tabular-nums">
              {stats.totalJobs}
            </span>
            {stats.activeJobs > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent animate-pulse">
                {stats.activeJobs} running
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted">
            Runs queued, running and finished
          </div>
        </div>

        {/* KPI 6: Pipeline Win Rate */}
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">CRM Win Rate</span>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 tabular-nums">
              {winRate}%
            </span>
            <span className="text-xs text-muted">({stats.statusBreakdown.won || 0} deals)</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            Deals won vs contacted
          </div>
        </div>
      </div>

      {/* Analytics: Pipeline Stage Funnel & Top Niches */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pipeline Stage Funnel */}
        <div className="glass-card rounded-3xl p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-ink">CRM Pipeline Stage Funnel</h2>
              <p className="text-xs text-muted">Distribution of leads across CRM workflow</p>
            </div>
            <span className="text-xs font-medium text-muted">
              {totalLeads} total tracked
            </span>
          </div>

          <div className="space-y-3.5">
            {PIPELINE_STAGES.map((stage) => {
              const pct = totalLeads > 0 ? Math.round((stage.count / totalLeads) * 100) : 0;
              return (
                <div key={stage.key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-ink flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${stage.color}`} />
                      {stage.label}
                    </span>
                    <span className="text-muted tabular-nums font-semibold">
                      {stage.count.toLocaleString()} <span className="font-normal text-soft">({pct}%)</span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface2">
                    <div
                      className={`h-full rounded-full ${stage.color} transition-all duration-700`}
                      style={{ width: `${Math.max(pct, stage.count > 0 ? 3 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top Business Niches */}
        <div className="glass-card rounded-3xl p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-ink">Top Business Niches</h2>
              <p className="text-xs text-muted">Most common business categories</p>
            </div>
            <span className="text-xs font-medium text-muted">
              {stats.topCategories.length} categories
            </span>
          </div>

          {stats.topCategories.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center">
              <Building2 className="h-8 w-8 text-soft mb-2" />
              <p className="text-sm font-medium text-ink">No categories captured yet</p>
              <p className="text-xs text-muted mt-0.5">Run your first scrape job to analyze business niches.</p>
            </div>
          ) : (
            <div className="space-y-3.5">
              {stats.topCategories.map((cat, idx) => {
                const max = stats.topCategories[0]?.count || 1;
                const pct = Math.round((cat.count / max) * 100);
                return (
                  <div key={cat.category} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-ink flex items-center gap-2 truncate max-w-[200px] sm:max-w-xs">
                        <span className="flex h-4 w-4 items-center justify-center rounded-md bg-accent-soft text-[10px] font-bold text-accent">
                          {idx + 1}
                        </span>
                        {cat.category}
                      </span>
                      <span className="text-muted tabular-nums font-semibold">
                        {cat.count.toLocaleString()} leads
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface2">
                      <div
                        className="h-full rounded-full bg-accent-strong transition-all duration-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Two Column Layout: Recent Scrapes & Discovered High-Value Leads */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Scraping Runs */}
        <div className="glass-card rounded-3xl p-6 flex flex-col justify-between">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-ink">Recent Scraping Runs</h2>
                <p className="text-xs text-muted">Most recent runs</p>
              </div>
              <Link
                href="/jobs"
                className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
              >
                View all <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {stats.recentJobs.length === 0 ? (
              <div className="flex h-44 flex-col items-center justify-center text-center">
                <Clock className="h-8 w-8 text-soft mb-2" />
                <p className="text-sm font-medium text-ink">No jobs recorded yet</p>
                <Link
                  href="/new"
                  className="mt-2 text-xs font-semibold text-accent hover:underline"
                >
                  Create your first job →
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.recentJobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:border-accent hover:shadow-card active:scale-[0.99]"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-ink group-hover:text-accent transition">
                          Job #{job.id}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadge(job.status)}`}>
                          {job.status}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        {job.sources.map((source) => (
                          <span key={source} className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${sourceChip(source)}`}>
                            {sourceLabel(source)}
                          </span>
                        ))}
                        <span className="truncate max-w-[220px]">
                          {job.keywords.length
                            ? `${job.keywords.slice(0, 2).join(", ")} · ${job.locations.slice(0, 2).join(", ")}`
                            : `${job.importLabel ?? "imported list"} (${job.importRows} rows)`}
                        </span>
                      </div>
                      {job.sourceStats.some((s) => s.status === "blocked") && (
                        <div className="text-[11px] font-semibold text-warn-fg">
                          A source was rate-limited — re-run it from the job page
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4 text-xs">
                      <div className="text-right">
                        <div className="font-semibold text-ink tabular-nums">
                          {job.leadsFound} leads
                        </div>
                        <div className="text-[11px] text-soft">
                          {job.leadsSkipped} deduped
                        </div>
                      </div>
                      <ArrowUpRight className="h-4 w-4 text-soft group-hover:text-accent transition" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between text-xs text-muted">
            <span>A worker on your machine polls the queue</span>
            <Link href="/new" className="font-semibold text-accent hover:underline">
              + New lead run
            </Link>
          </div>
        </div>

        {/* Recently Discovered High-Value Leads */}
        <div className="glass-card rounded-3xl p-6 flex flex-col justify-between">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-ink">Recently Discovered Leads</h2>
                <p className="text-xs text-muted">Latest businesses saved to the database</p>
              </div>
              <span className="text-xs text-muted">Live feed</span>
            </div>

            {stats.recentLeads.length === 0 ? (
              <div className="flex h-44 flex-col items-center justify-center text-center">
                <Users className="h-8 w-8 text-soft mb-2" />
                <p className="text-sm font-medium text-ink">No leads collected yet</p>
                <p className="text-xs text-muted mt-0.5">Start a lead run to populate your pipeline.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.recentLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:border-accent/40 hover:shadow-card"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink truncate max-w-[200px]">
                          {lead.name}
                        </span>
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${sourceChip(lead.source)}`}>
                          {sourceLabel(lead.source)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>{lead.category || "Business"}</span>
                        {lead.phone && (
                          <>
                            <span>&middot;</span>
                            <span className="inline-flex items-center gap-1 font-mono text-soft">
                              <Phone className="h-3 w-3" />
                              {lead.phone}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      {lead.emails && lead.emails.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-ok-fg/10 px-2 py-0.5 text-[11px] font-semibold text-ok-fg">
                          <MailCheck className="h-3 w-3" /> Email verified
                        </span>
                      )}
                      {lead.website && (
                        <a
                          href={lead.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-lg p-1 text-soft hover:bg-surface2 hover:text-accent transition"
                          title="Visit website"
                        >
                          <Globe className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between text-xs text-muted">
            <span>Enrichment visits websites for emails & socials</span>
            <span className="text-soft">Auto-deduplicated</span>
          </div>
        </div>
      </div>
    </div>
  );
}
