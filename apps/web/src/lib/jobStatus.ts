export const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warn-bg text-warn-fg",
  running: "bg-info-bg text-info-fg",
  done: "bg-ok-bg text-ok-fg",
  error: "bg-bad-bg text-bad-fg",
  cancelled: "bg-idle-bg text-idle-fg",
};

export function statusBadge(status: string): string {
  return STATUS_STYLES[status] ?? "bg-idle-bg text-idle-fg";
}

/**
 * The job's "nothing new" KPI. `skipped` listings were already collected by this very
 * job; `merged` ones were recognised as a business you had elsewhere and filled in
 * there. Both produced no new row, but they are not the same sentence.
 */
export function dedupKpi(job: { leadsSkipped: number; leadsMerged: number; requestsUsed: number }): {
  value: number;
  caption: string;
} {
  const requests = `${job.requestsUsed} request${job.requestsUsed === 1 ? "" : "s"} used`;
  if (!job.leadsMerged) return { value: job.leadsSkipped, caption: `Already known — skipped at ${requests}` };

  const parts = [
    ...(job.leadsSkipped ? [`${job.leadsSkipped} already known`] : []),
    `${job.leadsMerged} joined to a lead you had`,
  ];
  return { value: job.leadsSkipped + job.leadsMerged, caption: `${parts.join(" · ")} · ${requests}` };
}

/**
 * Scraping and enrichment differ hugely in runtime, so a bare "running" reads as a
 * job that ignored the cap. Name the phase and, where there is a total, the progress.
 */
export function statusLabel(job: {
  status: string;
  cancelRequested: boolean;
  phase: string | null;
  phaseTotal: number | null;
  phaseDone: number | null;
}): string {
  if (job.status !== "running") return job.status;
  if (job.cancelRequested) return "stopping…";
  if (!job.phase) return "running";
  return job.phaseTotal ? `${job.phase} ${job.phaseDone ?? 0}/${job.phaseTotal}` : job.phase;
}
