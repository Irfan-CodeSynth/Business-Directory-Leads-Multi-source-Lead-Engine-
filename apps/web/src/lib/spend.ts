/**
 * The web half of the Apify spend guardrail. The worker is what enforces the monthly
 * cap; these readers only let the New run form say how much room is left. They live
 * here rather than in `@dleads/worker` because the web package must not depend on the
 * worker — that would pull the adapters and their test harness into a Next build.
 */

/** Keep in step with `DEFAULT_MONTHLY_RESULT_CAP` in `apps/worker/src/spend.ts`. */
export const DEFAULT_MONTHLY_RESULT_CAP = 1500;

export function monthlyResultCap(): number {
  const value = Number(process.env.APIFY_MONTHLY_RESULT_CAP);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MONTHLY_RESULT_CAP;
}

/** Apify bills per calendar month, so usage resets on the 1st at local midnight. */
export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** An unfilled `.env` line leaves whitespace behind, which is not a token. */
export function isApifyConfigured(): boolean {
  return Boolean(process.env.APIFY_API_TOKEN?.trim());
}
