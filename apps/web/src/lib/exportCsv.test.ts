import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { EXPORT_ATTRIBUTION, exportCsv, exportHeaders, type ExportLead } from "./exportCsv";

const base: ExportLead = {
  name: "Acme Plumbing",
  phone: "512-555-0142",
  emails: ["office@acme.com"],
  emailSource: "website",
  address: "1 Main St",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  website: "https://acme.com",
  sources: ["osm"],
  dedupKind: "p",
  instagram: null,
  facebook: "https://www.facebook.com/acme",
  linkedin: null,
  twitter: null,
  youtube: null,
  tiktok: null,
  category: "Plumber",
  rating: 4.6,
  reviewCount: 120,
  profileUrl: "https://osm.org/node/1",
  status: "new",
  notes: null,
};

const lead = (over: Partial<typeof base> = {}) => ({ ...base, ...over });

/** The file as a spreadsheet would read it: attribution line, header, one line per lead. */
const table = (rows: Parameters<typeof exportCsv>[0]) => parseCsv(exportCsv(rows));
const column = (headers: string[], name: string) => headers.indexOf(name);

describe("exportCsv", () => {
  it("puts the ODbL attribution above the header, because the licence asks for it on exports", () => {
    const lines = table([lead()]);
    expect(lines[0]).toEqual([EXPORT_ATTRIBUTION]);
    expect(EXPORT_ATTRIBUTION).toContain("OpenStreetMap");
  });

  it("writes one cell per header, in the order the headers name", () => {
    const [attribution, headers, row] = table([lead()]);
    expect(headers).toEqual(exportHeaders);
    expect(row).toHaveLength(exportHeaders.length);
    expect(row[column(headers, "Name")]).toBe("Acme Plumbing");
    expect(row[column(headers, "Email(s)")]).toBe("office@acme.com");
    expect(row[column(headers, "Email source")]).toBe("website");
    expect(row[column(headers, "Found on sources")]).toBe("osm");
    expect(row[column(headers, "Dedup tier")]).toBe("p");
  });

  it("escapes the quote and comma a spreadsheet puts in a business name", () => {
    const [, headers, row] = table([lead({ name: 'Acme, "Rapid" Plumbing' })]);
    expect(row[column(headers, "Name")]).toBe('Acme, "Rapid" Plumbing');
  });

  it("keeps a note that spans lines inside its cell", () => {
    const [, headers, row] = table([lead({ notes: "called twice\nno answer" })]);
    expect(row[column(headers, "Notes")]).toBe("called twice\nno answer");
  });

  it("leaves an absent value as an empty cell rather than the word null", () => {
    const [, headers, row] = table([lead({ emails: null, emailSource: null, rating: null, notes: null })]);
    expect(row.join("|")).not.toContain("null");
    expect(row[column(headers, "Email(s)")]).toBe("");
    expect(row[column(headers, "Email source")]).toBe("");
    expect(row[column(headers, "Rating")]).toBe("");
  });

  it("joins every email and every source, so a cross-source business is one honest row", () => {
    const [, headers, row] = table([lead({ emails: ["a@b.co", "c@d.co"], sources: ["osm", "csv"] })]);
    expect(row[column(headers, "Email(s)")]).toBe("a@b.co; c@d.co");
    expect(row[column(headers, "Found on sources")]).toBe("osm; csv");
  });

  it("ends every line with CRLF, which is what Excel expects", () => {
    const text = exportCsv([lead(), lead({ name: "Blue Ridge Pipes" })]);
    // attribution + header + two leads, then a final newline so the last row is not
    // glued to the end of the file. Joining with "\n" alone collapses this to 1.
    expect(text.split("\r\n")).toHaveLength(5);
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("still produces a readable file for a job with no leads", () => {
    expect(table([])).toHaveLength(2);
  });
});
