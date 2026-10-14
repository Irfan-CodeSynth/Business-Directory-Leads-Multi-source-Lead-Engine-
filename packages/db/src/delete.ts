import { and, eq, inArray, sql } from "drizzle-orm";
import { jobs, knownBusinesses, leads } from "./schema.js";
import type { Db } from "./index.js";

/** The pool or an open transaction: everything here is query-shaped, not connection-shaped. */
type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DeleteOutcome {
  /** Rows actually removed. */
  deleted: number;
  /**
   * Ids the worker still owns — a queued or running job, or a lead of one. Nothing is
   * deleted in that case: a half delete would leave the run's counters describing rows
   * that no longer exist.
   */
  rejected: number[];
}

const OWNED_BY_WORKER = ["pending", "running"] as const;

/**
 * The ledger says a business is known so a future run joins the row it already has
 * instead of collecting it twice. Deleting a run is the owner saying "forget them", so
 * its businesses become collectable again — except one another lead still owns, whose
 * ledger row must stay or that business would be duplicated by the next run.
 */
async function pruneLedger(store: Store, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await store
    .delete(knownBusinesses)
    .where(
      and(
        inArray(knownBusinesses.dedupKey, keys),
        sql`not exists (select 1 from ${leads} where ${leads.dedupKey} = ${knownBusinesses.dedupKey})`,
      ),
    );
}

/** Deletes finished runs with everything they collected, forgetting their businesses. */
export async function deleteJobsByIds(db: Db, ids: number[]): Promise<DeleteOutcome> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { deleted: 0, rejected: [] };

  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.id, wanted), inArray(jobs.status, [...OWNED_BY_WORKER])));
    if (owned.length) return { deleted: 0, rejected: owned.map((row) => row.id) };

    const keys = await tx
      .selectDistinct({ key: leads.dedupKey })
      .from(leads)
      .where(inArray(leads.jobId, wanted));
    const gone = await tx.delete(jobs).where(inArray(jobs.id, wanted)).returning({ id: jobs.id });
    await pruneLedger(tx, keys.map((row) => row.key));
    return { deleted: gone.length, rejected: [] };
  });
}

/** Deletes single leads — their job stays, their businesses become collectable again. */
export async function deleteLeadsByIds(db: Db, ids: number[]): Promise<DeleteOutcome> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { deleted: 0, rejected: [] };

  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(jobs, eq(jobs.id, leads.jobId))
      .where(and(inArray(leads.id, wanted), inArray(jobs.status, [...OWNED_BY_WORKER])));
    if (owned.length) return { deleted: 0, rejected: owned.map((row) => row.id) };

    const keys = await tx
      .selectDistinct({ key: leads.dedupKey })
      .from(leads)
      .where(inArray(leads.id, wanted));
    const gone = await tx.delete(leads).where(inArray(leads.id, wanted)).returning({ id: leads.id });
    await pruneLedger(tx, keys.map((row) => row.key));
    return { deleted: gone.length, rejected: [] };
  });
}
