export const PAGE_SIZE = 10;

export type PageSlot = number | "…";

export function totalPages(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function normalizePage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.floor(page), 1), Math.max(pageCount, 1));
}

export function slicePage<T>(items: readonly T[], page: number, pageSize = PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * First, last and the current page's neighbours, with "…" marking any gap — so a
 * thousand jobs still fits on one line. Short lists need no collapsing.
 */
export function pageWindow(page: number, pageCount: number): PageSlot[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);

  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);

  const slots: PageSlot[] = [];
  for (const [i, p] of pages.entries()) {
    if (i > 0 && p - pages[i - 1]! > 1) slots.push("…");
    slots.push(p);
  }
  return slots;
}

export function rangeText(total: number, page: number, pageSize = PAGE_SIZE): string {
  if (total <= 0) return "Showing 0 of 0";
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(from + pageSize - 1, total);
  return `Showing ${from}–${to} of ${total}`;
}
