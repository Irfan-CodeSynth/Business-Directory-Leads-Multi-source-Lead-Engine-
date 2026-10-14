// Pinned locale AND zone: toLocaleString() with defaults renders differently on
// Vercel (UTC) than in the viewer's browser, which React reports as a hydration error.
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDate(iso: string | Date): string {
  return DATE_FMT.format(new Date(iso));
}
