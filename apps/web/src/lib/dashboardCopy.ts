/**
 * The dashboard's cross-source line: a business that turned up in more than one place
 * is the strongest signal in the list, so it gets its own number instead of hiding in
 * the per-source split.
 */
export function overlapNote(businesses: number): string | null {
  if (!businesses) return null;
  return `${businesses} ${businesses === 1 ? "business" : "businesses"} also found on another source`;
}
