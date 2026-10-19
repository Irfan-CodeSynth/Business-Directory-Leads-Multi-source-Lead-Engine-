import type { Source } from "@dleads/db";

/**
 * One business exactly as a source published it, before the dedup tiers run.
 * Everything optional stays optional: directories are uneven, and inventing a
 * value here would corrupt the ledger keys downstream.
 */
export interface RawLead {
  /** Stable id within the source, e.g. `n368053310` for an OSM node. */
  externalId: string;
  name: string;
  phone?: string | null;
  website?: string | null;
  profileUrl?: string | null;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** Contact details the source itself published (OSM `email` tag, CSV column). */
  emails?: string[];
  /** Social profile urls the source itself published. */
  socials?: Record<string, string>;
  /** Raw source payload, kept on `leads.extra` for debugging and exports. */
  extra?: Record<string, unknown>;
}

export interface SearchArgs {
  keyword: string;
  location: string;
  maxItems: number;
}

/** Caps requests so a misbehaving source cannot hammer a service all night. */
export interface RequestBudget {
  charge(count?: number): void;
  spent(): number;
  exhausted(): boolean;
}

export function makeBudget(maxRequests: number): RequestBudget {
  let used = 0;
  return {
    charge(count = 1) {
      used += count;
    },
    spent: () => used,
    // `Infinity` means "no cap", used by the CLI smoke test.
    exhausted: () => Number.isFinite(maxRequests) && used >= maxRequests,
  };
}

/**
 * How many results a paid source may still return this calendar month. A per-request
 * budget cannot guard money: one request buys a whole page of listings, so the meter
 * that matters is results, and it is shared by every paid source and every job the
 * worker starts before the month turns over.
 */
export interface ResultSpend {
  remaining(): number;
  charge(count: number): void;
  /** Results charged by this job, not the lifetime total. */
  spent(): number;
}

export function makeSpend(monthlyCap: number, alreadySpent = 0): ResultSpend {
  let used = alreadySpent;
  return {
    remaining: () =>
      Number.isFinite(monthlyCap) ? Math.max(0, monthlyCap - used) : Number.POSITIVE_INFINITY,
    charge(count = 1) {
      used += count;
    },
    spent: () => used - alreadySpent,
  };
}

export interface SearchHooks {
  /** Called as each business is parsed, so the ledger can be written incrementally. */
  emit(lead: RawLead): void | Promise<void>;
  budget: RequestBudget;
  log(message: string): void;
  /**
   * Checked between emits and between requests, so a run can end on the next listing
   * rather than the next page. True once the source has added its lead target.
   */
  shouldStop(): boolean;
}

export interface SearchOutcome {
  emitted: number;
  requestsUsed: number;
  /** True when `shouldStop()` ended the search early — the target, not a cancel. */
  stopped: boolean;
}

/**
 * A source refused us even after its backoff. The job is *not* failed: the worker
 * marks this source `blocked` in `job_source_stats`, finishes the job `done`, and
 * "Re-run blocked sources" picks it up later.
 */
export class BlockedError extends Error {
  readonly source: Source;
  /** The HTTP status that refused us, when a status did. A directory can also just stop
   *  serving the page, which is a block with no code to show for it. */
  readonly status?: number;

  constructor(source: Source, message: string, status?: number) {
    super(message);
    this.name = "BlockedError";
    this.source = source;
    this.status = status;
  }
}

/** The job asked for more requests than the source is allowed to make. */
export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export function isBlockedError(err: unknown): err is BlockedError {
  return err instanceof BlockedError;
}

export interface SourceAdapter {
  readonly source: Source;
  search(args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome>;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
