import { sql } from "drizzle-orm";
import { workerStatus, type Db } from "@dleads/db";

export const WORKER_VERSION = "0.0.1";

/**
 * The single-row heartbeat that replaced the inherited `wakeWorker()` ping. There is
 * no cloud worker to wake — this process runs on the user's machine — so the only
 * honest signal is "a worker polled this database N seconds ago", which is what the
 * dashboard banner renders.
 */
export async function heartbeat(db: Db, currentJobId: number | null): Promise<void> {
  await db
    .insert(workerStatus)
    .values({ id: 1, lastSeenAt: new Date(), currentJobId, version: WORKER_VERSION })
    .onConflictDoUpdate({
      target: workerStatus.id,
      set: {
        lastSeenAt: sql`now()`,
        currentJobId,
        version: WORKER_VERSION,
      },
    });
}
