/**
 * The CSV a lead run is worth for: one row per business, with everything the user has
 * to decide whether to call. Kept away from the route so the file's shape is testable.
 */

// The ODbL requires attribution wherever OSM data is republished, exports included.
export const EXPORT_ATTRIBUTION =
  "Business details, phone numbers and addresses for rows whose source is OpenStreetMap are (c) OpenStreetMap contributors, https://www.openstreetmap.org/copyright";

export const exportHeaders = [
  "Name",
  "Phone",
  "Email(s)",
  "Email source",
  "Address",
  "City",
  "Region",
  "Postal code",
  "Website",
  "Found on sources",
  "Dedup tier",
  "Instagram",
  "Facebook",
  "LinkedIn",
  "Twitter",
  "YouTube",
  "TikTok",
  "Category",
  "Rating",
  "Reviews",
  "Profile URL",
  "CRM status",
  "Notes",
];

export interface ExportLead {
  name: string;
  phone: string | null;
  emails: string[] | null;
  emailSource: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  website: string | null;
  sources: string[];
  dedupKind: string;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  twitter: string | null;
  youtube: string | null;
  tiktok: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  profileUrl: string | null;
  status: string;
  notes: string | null;
}

function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportCsv(rows: readonly ExportLead[]): string {
  const lines = [
    cell(EXPORT_ATTRIBUTION),
    exportHeaders.map(cell).join(","),
    ...rows.map((r) =>
      [
        r.name,
        r.phone,
        r.emails?.length ? r.emails.join("; ") : null,
        r.emailSource,
        r.address,
        r.city,
        r.region,
        r.postalCode,
        r.website,
        r.sources.join("; "),
        r.dedupKind,
        r.instagram,
        r.facebook,
        r.linkedin,
        r.twitter,
        r.youtube,
        r.tiktok,
        r.category,
        r.rating,
        r.reviewCount,
        r.profileUrl,
        r.status,
        r.notes,
      ]
        .map(cell)
        .join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
