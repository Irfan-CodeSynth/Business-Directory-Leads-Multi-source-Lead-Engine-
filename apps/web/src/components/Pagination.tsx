"use client";

import { pageWindow } from "@/lib/pagination";

export default function Pagination({
  page,
  pageCount,
  onChange,
  noun = "items",
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  noun?: string;
}) {
  if (pageCount <= 1) return null;

  const arrow =
    "grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface text-muted transition hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-40";

  return (
    <nav
      aria-label={`Pagination, page ${page} of ${pageCount}`}
      className="flex flex-wrap items-center justify-center gap-1.5 pt-1"
    >
      <button
        type="button"
        className={arrow}
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {pageWindow(page, pageCount).map((slot, i) =>
        slot === "…" ? (
          <span key={`gap-${i}`} className="px-1 text-sm text-soft" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            onClick={() => onChange(slot)}
            aria-current={slot === page ? "page" : undefined}
            className={`h-9 min-w-9 rounded-lg px-3 text-sm font-medium transition active:scale-95 ${
              slot === page
                ? "bg-accent-strong text-white shadow-accent"
                : "border border-line bg-surface text-muted hover:border-accent hover:text-accent"
            }`}
          >
            {slot}
          </button>
        ),
      )}

      <button
        type="button"
        className={arrow}
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label="Next page"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <span className="ml-1 text-xs text-soft">
        page {page} of {pageCount} {noun}
      </span>
    </nav>
  );
}
