import type { WorkerStatus } from "@/lib/types";

function since(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * The worker runs on your own machine, so there is no cloud service to wake: the
 * honest signal is whether it is polling this database right now.
 */
export default function WorkerBadge({ worker }: { worker: WorkerStatus }) {
  if (!worker.online) {
    return (
      <span
        className="flex items-center gap-2 rounded-full border border-warn-bg bg-warn-bg px-3 py-1 text-xs font-semibold text-warn-fg"
        title={`Last heartbeat ${since(worker.lastSeenAt)}`}
      >
        <span className="h-2 w-2 rounded-full bg-warn-fg" />
        No worker running — start `npm run worker`
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-2 rounded-full border border-line bg-surface2/60 px-3 py-1 text-xs font-semibold text-muted"
      title={worker.version ? `Worker ${worker.version}` : undefined}
    >
      <span className="h-2 w-2 rounded-full bg-ok-fg animate-pulse-dot" />
      Worker online{worker.currentJobId ? ` · job #${worker.currentJobId}` : ""} ·{" "}
      {since(worker.lastSeenAt)}
    </span>
  );
}
