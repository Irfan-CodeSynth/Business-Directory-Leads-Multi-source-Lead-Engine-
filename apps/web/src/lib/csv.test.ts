import { describe, expect, it } from "vitest";
import { MAPPABLE_FIELDS, applyMapping, autoMap, isMappingUsable, parseCsv, toTable } from "./csv";

describe("parseCsv", () => {
  it("keeps a quoted comma inside the cell and unfolds a doubled quote", () => {
    expect(parseCsv('name,address\n"Acme, Inc.","1 Main St ""East"""\n')).toEqual([
      ["name", "address"],
      ["Acme, Inc.", '1 Main St "East"'],
    ]);
  });

  it("keeps a newline inside a quoted cell on the same row", () => {
    expect(parseCsv('name,notes\nAcme,"line one\nline two"\n')).toEqual([["name", "notes"], ["Acme", "line one\nline two"]]);
  });

  it("reads a CRLF export from Excel and drops the byte-order mark", () => {
    expect(parseCsv("﻿name,phone\r\nAcme,512-555-0142\r\n")).toEqual([["name", "phone"], ["Acme", "512-555-0142"]]);
  });

  it("sniffs the delimiter the spreadsheet actually used", () => {
    expect(parseCsv("name;phone\nAcme;512\n")).toEqual([["name", "phone"], ["Acme", "512"]]);
    expect(parseCsv("name\tphone\nAcme\t512\n")).toEqual([["name", "phone"], ["Acme", "512"]]);
  });

  it("skips blank lines instead of importing empty leads", () => {
    expect(parseCsv("name\nAcme\n\n\nBlue Ridge\n")).toEqual([["name"], ["Acme"], ["Blue Ridge"]]);
  });

  it("reads a one-column paste that has no delimiter at all", () => {
    expect(parseCsv("Acme Plumbing\nBlue Ridge Pipes\n")).toEqual([["Acme Plumbing"], ["Blue Ridge Pipes"]]);
  });
});

describe("toTable", () => {
  it("keys each row by its header", () => {
    const { headers, rows } = toTable("name,phone\nAcme,512-555-0142\n");
    expect(headers).toEqual(["name", "phone"]);
    expect(rows).toEqual([{ name: "Acme", phone: "512-555-0142" }]);
  });

  it("omits empty cells so a short row does not become an empty string column", () => {
    expect(toTable("name,phone,email\nAcme,,a@b.co\n").rows).toEqual([{ name: "Acme", email: "a@b.co" }]);
  });

  it("names unnamed columns apart instead of letting them overwrite each other", () => {
    const { headers } = toTable("name,,\nAcme,1,2\n");
    expect(headers).toEqual(["name", "column_2", "column_3"]);
    expect(toTable("name,,\nAcme,1,2\n").rows).toEqual([{ name: "Acme", column_2: "1", column_3: "2" }]);
  });

  it("stops at maxRows so a huge upload cannot be mapped whole", () => {
    expect(toTable("name\na\nb\nc\nd", 2).rows).toHaveLength(2);
  });

  it("gives an empty table for empty input rather than throwing", () => {
    expect(toTable("   \n")).toEqual({ headers: [], rows: [] });
  });
});

describe("autoMap", () => {
  it("maps a typical spreadsheet export without any clicks", () => {
    expect(
      autoMap(["Business Name", "Phone Number", "Email", "Website", "City", "State", "Zip", "Category"]),
    ).toEqual({
      name: "Business Name",
      phone: "Phone Number",
      email: "Email",
      website: "Website",
      city: "City",
      state: "State",
      zip: "Zip",
      category: "Category",
    });
  });

  it("reads the punctuation and spacing spellings of the same header", () => {
    const mapping = autoMap(["company_name", "TEL", "e-mail", "Instagram"]);
    expect(mapping.name).toBe("company_name");
    expect(mapping.phone).toBe("TEL");
    expect(mapping.email).toBe("e-mail");
    expect(mapping.instagram).toBe("Instagram");
  });

  it("leaves an ambiguous header for the user to place", () => {
    expect(autoMap(["Contact", "Details"])).toEqual({});
  });

  it("never maps one field twice", () => {
    const mapping = autoMap(["phone", "mobile"]);
    expect(mapping.phone).toBe("phone");
  });
});

describe("applyMapping", () => {
  const mapping = autoMap(["Business Name", "Phone", "Email", "Zip"]);

  it("emits the canonical column names the csv worker reads", () => {
    const [row] = applyMapping([{ "Business Name": "Acme", Phone: "512-555-0142", Email: "a@b.co", Zip: "78701" }], mapping);
    // apps/worker/src/adapters/csv.ts looks up exactly name/phone/email/zip (plus
    // region|state, postal_code|postcode); renaming one of these silently loses data.
    expect(row).toEqual({ name: "Acme", phone: "512-555-0142", email: "a@b.co", zip: "78701" });
  });

  it("drops unmapped columns instead of shipping the whole spreadsheet to the job", () => {
    const [row] = applyMapping([{ "Business Name": "Acme", Phone: "512", InternalNotes: "called twice" }], mapping);
    expect(Object.keys(row)).not.toContain("InternalNotes");
    expect(Object.keys(row).every((key) => (MAPPABLE_FIELDS as readonly string[]).includes(key))).toBe(true);
  });

  it("skips a row with no name, because there is nobody to call", () => {
    expect(applyMapping([{ "Business Name": "Acme" }, { Phone: "512-555-0142" }], mapping)).toHaveLength(1);
  });

  it("leaves a blank cell out rather than writing an empty value over the lead", () => {
    const [row] = applyMapping([{ "Business Name": "Acme", Email: "   " }], mapping);
    expect(row).toEqual({ name: "Acme" });
  });

  it("needs a name column before the mapping is worth running", () => {
    expect(isMappingUsable(autoMap(["Phone", "Email"]))).toBe(false);
    expect(isMappingUsable(autoMap(["Business Name"]))).toBe(true);
  });
});
