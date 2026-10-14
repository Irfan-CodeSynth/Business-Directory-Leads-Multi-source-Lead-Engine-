import type { RawLead, SearchArgs, SearchHooks, SearchOutcome, SourceAdapter } from "./types.js";

/**
 * Lists the user already legitimately holds: a job's `import_rows` are pasted or
 * uploaded in the UI, mapped to these column names, and stored on the job so the
 * run is replayable. This adapter makes no network requests — its "budget" is the
 * row count, and dedup against the ledger is what keeps a re-paste cheap.
 */
export interface CsvRow extends Record<string, string> {}

const value = (row: Record<string, string>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const cell = row[key]?.trim();
    if (cell) return cell;
  }
  return null;
};

/** A header is whatever the spreadsheet said: `Phone`, `PHONE` and `phone` are one column. */
function normalize(row: CsvRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(row)) out[key.toLowerCase().trim()] = cell;
  return out;
}

function socialsFrom(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const network of ["instagram", "facebook", "linkedin", "twitter", "youtube", "tiktok"]) {
    const url = value(row, network, `${network}_url`, `social:${network}`);
    if (url) out[network] = url;
  }
  return out;
}

/** `null` for a row with no name: there is nothing to key on and nobody to call. */
export function rowToLead(row: CsvRow, externalId: string): RawLead | null {
  const cells = normalize(row);
  const name = value(cells, "name", "business", "business_name", "company");
  if (!name) return null;
  const email = value(cells, "email", "emails");
  return {
    externalId,
    name,
    phone: value(cells, "phone", "telephone", "phone1"),
    website: value(cells, "website", "url", "site"),
    profileUrl: value(cells, "profile_url", "listing_url", "profile"),
    address: value(cells, "address", "street", "address1"),
    city: value(cells, "city"),
    region: value(cells, "region", "state", "province"),
    postalCode: value(cells, "postal_code", "postcode", "zip"),
    category: value(cells, "category", "type", "industry"),
    rating: null,
    reviewCount: null,
    emails: email ? email.split(/[;,\s]+/).filter(Boolean) : [],
    socials: socialsFrom(cells),
    extra: { row: { ...row } },
  };
}

/**
 * `jobId` prefixes the positional id on purpose: row 1 of two different lists are
 * two different businesses, and an unscoped `r0` would merge them through the `x:`
 * tier. Cross-job duplicates are meant to be caught by the phone/zip/host tiers.
 */
export function createCsvAdapter(rows: CsvRow[], jobId: number): SourceAdapter {
  return {
    source: "csv",

    async search(args: SearchArgs, hooks: SearchHooks): Promise<SearchOutcome> {
      let emitted = 0;
      let stopped = false;
      for (let index = 0; index < rows.length; index++) {
        if (emitted >= args.maxItems) break;
        if (hooks.shouldStop()) {
          stopped = true;
          break;
        }
        const lead = rowToLead(rows[index]!, `j${jobId}r${index}`);
        if (!lead) {
          hooks.log(`csv: row ${index + 1} has no name; skipped`);
          continue;
        }
        await hooks.emit(lead);
        emitted++;
      }
      return { emitted, requestsUsed: 0, stopped };
    },
  };
}
