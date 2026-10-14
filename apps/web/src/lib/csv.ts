/**
 * Minimal RFC-4180 CSV reader for pasted/uploaded lists. Deliberately small: it
 * handles quotes, doubled quotes, CRLF and a sniffed delimiter, which is all a
 * spreadsheet export needs. Anything more exotic should be re-exported as CSV.
 */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

const DELIMITERS = [",", "\t", ";", "|"];

function sniffDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = -1;
  for (const candidate of DELIMITERS) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string): string[][] {
  const value = text.replace(/^\uFEFF/, "");
  const firstLineEnd = value.search(/[\r\n]/);
  const firstLine = firstLineEnd === -1 ? value : value.slice(0, firstLineEnd);
  const delimiter = sniffDelimiter(firstLine);

  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (quoted) {
      if (ch === '"') {
        if (value[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(cell.trim());
      cell = "";
      if (row.some((v) => v !== "")) table.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }

  row.push(cell.trim());
  if (row.some((v) => v !== "")) table.push(row);
  return table;
}

/** Header → column index, de-duplicated so repeated blanks don't clobber each other. */
function uniqueHeaders(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, index) => {
    const base = raw || `column_${index + 1}`;
    const used = seen.get(base) ?? 0;
    seen.set(base, used + 1);
    return used === 0 ? base : `${base} (${used + 1})`;
  });
}

export function toTable(text: string, maxRows = 5000): CsvTable {
  const table = parseCsv(text);
  if (!table.length) return { headers: [], rows: [] };

  const headers = uniqueHeaders(table[0]!);
  const rows: Record<string, string>[] = [];
  for (const line of table.slice(1, maxRows + 1)) {
    if (!line.some((v) => v !== "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      const cell = line[index] ?? "";
      if (cell) row[header] = cell;
    });
    // A row of nothing but the header echo is what "name,name" pastes look like.
    if (Object.values(row).some((v) => v.trim() !== "")) rows.push(row);
  }
  return { headers, rows };
}

/** Fields a mapping can target. `name` is the only mandatory one. */
export const MAPPABLE_FIELDS = [
  "name",
  "phone",
  "email",
  "website",
  "address",
  "city",
  "state",
  "zip",
  "category",
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "youtube",
  "tiktok",
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

const FIELD_PATTERNS: Record<MappableField, RegExp> = {
  name: /^(business|company|firm|name|business name|company name|outlet|establishment)$/,
  phone: /^(phone|tel|telephone|contact number|phone number|mobile|cell|\+?phone)$/,
  email: /^(email|e-mail|mail|email address|contact email)$/,
  website: /^(website|web|url|site|company website|web site)$/,
  address: /^(address|street|address1|address line 1|addr)$/,
  city: /^(city|town|locality|suburb)$/,
  state: /^(state|province|region|st|state code)$/,
  zip: /^(zip|zipcode|zip code|postal|postcode|postal code|pin)$/,
  category: /^(category|industry|type|niche|business type)$/,
  instagram: /^(instagram|insta|ig)$/,
  facebook: /^(facebook|fb|facebook url|fb page)$/,
  linkedin: /^(linkedin|linkedin url|li)$/,
  twitter: /^(twitter|tweet|x url|twitter handle)$/,
  youtube: /^(youtube|yt|channel)$/,
  tiktok: /^(tiktok|tik tok)$/,
};

/**
 * Best-guess header mapping so a normal export needs no clicks. Ambiguous headers
 * (like "contact") are left unmapped rather than guessed wrong.
 */
export function autoMap(headers: string[]): Partial<Record<MappableField, string>> {
  const mapping: Partial<Record<MappableField, string>> = {};
  for (const header of headers) {
    const key = header.toLowerCase().trim().replace(/[\s_.-]+/g, " ").replace(/\s+/g, " ");
    const flat = key.replace(/\s/g, "");
    for (const field of MAPPABLE_FIELDS) {
      if (mapping[field]) continue;
      if (FIELD_PATTERNS[field].test(key) || FIELD_PATTERNS[field].test(flat)) {
        mapping[field] = header;
        break;
      }
    }
  }
  return mapping;
}

export function isMappingUsable(mapping: Partial<Record<MappableField, string>>): boolean {
  return Boolean(mapping.name);
}

/** Rows in the shape the API and worker expect: mapped field name → value. */
export function applyMapping(
  rows: Record<string, string>[],
  mapping: Partial<Record<MappableField, string>>,
): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const row of rows) {
    const mapped: Record<string, string> = {};
    for (const field of MAPPABLE_FIELDS) {
      const header = mapping[field];
      if (!header) continue;
      const value = (row[header] ?? "").trim();
      if (value) mapped[field] = value;
    }
    if (mapped.name) out.push(mapped);
  }
  return out;
}
