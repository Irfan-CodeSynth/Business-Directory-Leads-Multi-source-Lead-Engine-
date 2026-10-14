import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getJobDetail, getLeadsForJob } from "@/lib/queries";
import { currentUserId } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { dedupKpi, statusBadge } from "@/lib/jobStatus";
import { sourceLabel } from "@/lib/sourceMeta";
import LeadsTable from "@/components/LeadsTable";
import SourceBreakdown from "@/components/SourceBreakdown";
import {
  Users,
  ShieldCheck,
  Layers,
  MailCheck,
  ChevronLeft,
  Download,
  AlertCircle,
  MapPin,
  Calendar,
  Globe,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function JobResultsPage({ params }: { params: { id: string } }) {
  const uid = currentUserId();
  if (!uid) redirect("/login");

  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();

  const job = await getJobDetail(id);
  if (!job) notFound();

  const leads = await getLeadsForJob(id);
  const leadsWithEmail = leads.filter((l) => l.emails && l.emails.length > 0).length;
  const leadsWithPhone = leads.filter((l) => Boolean(l.phone)).length;
  const usesOsm = job.sources.includes("osm");
  const dedup = dedupKpi({
    leadsSkipped: job.leadsSkipped,
    leadsMerged: job.leadsMerged,
    requestsUsed: job.sourceStats.reduce((n, s) => n + s.requestsUsed, 0),
  });

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link
              href="/jobs"
              className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-accent transition"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              All Jobs
            </Link>
            <span className="text-soft">/</span>
            <span className="text-xs font-semibold text-ink">Job #{job.id}</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              Job #{job.id} leads
            </h1>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadge(job.status)}`}>
              {job.status}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-soft" />
              {job.sources.map(sourceLabel).join(" + ")}
            </span>
            {job.keywords.length > 0 && (
              <>
                <span>&middot;</span>
                <span className="font-medium text-ink">{job.keywords.join(", ")}</span>
              </>
            )}
            {job.locations.length > 0 && (
              <>
                <span>&middot;</span>
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 text-soft" />
                  {job.locations.join(", ")}
                </span>
              </>
            )}
            {job.importRows > 0 && (
              <>
                <span>&middot;</span>
                <span className="flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5 text-soft" />
                  {job.importRows} imported rows{job.importLabel ? ` (${job.importLabel})` : ""}
                </span>
              </>
            )}
            <span>&middot;</span>
            <span className="flex items-center gap-1 text-soft">
              <Calendar className="h-3.5 w-3.5" />
              {formatDate(job.createdAt)} UTC
            </span>
          </div>

          {job.errorMsg && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-bad-bg bg-bad-bg/30 p-3 text-xs text-bad-fg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{job.errorMsg}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={`/api/export?jobId=${job.id}`}
            className="inline-flex items-center gap-2 rounded-2xl bg-accent-strong px-4 py-2.5 text-xs font-semibold text-white shadow-accent transition hover:bg-accent-dark active:scale-95"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV ({leads.length})
          </a>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">New leads</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-ink tabular-nums">{leads.length.toLocaleString()}</div>
          <div className="mt-1 text-xs text-muted">Collected by this run</div>
        </div>

        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Emails found</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-ok-fg/10 text-ok-fg">
              <MailCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-ok-fg tabular-nums">{leadsWithEmail.toLocaleString()}</div>
          <div className="mt-1 text-xs text-muted">
            {leads.length > 0 ? Math.round((leadsWithEmail / leads.length) * 100) : 0}% of this run has an
            email
          </div>
        </div>

        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Phone numbers</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-info-fg/10 text-info-fg">
              <Globe className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-ink tabular-nums">{leadsWithPhone.toLocaleString()}</div>
          <div className="mt-1 text-xs text-muted">
            {leads.length > 0 ? Math.round((leadsWithPhone / leads.length) * 100) : 0}% callable
          </div>
        </div>

        <div className="glass-card glass-card-hover rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-soft">Ledger deduped</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <ShieldCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-ink tabular-nums">{dedup.value.toLocaleString()}</div>
          <div className="mt-1 text-xs text-muted">{dedup.caption}</div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Sources</h2>
          {usesOsm && (
            <span className="text-[11px] text-soft">
              Map data &copy; OpenStreetMap contributors (ODbL)
            </span>
          )}
        </div>
        <SourceBreakdown job={job} />
      </section>

      <LeadsTable leads={leads} jobId={job.id} skipped={job.leadsSkipped} />
    </div>
  );
}
