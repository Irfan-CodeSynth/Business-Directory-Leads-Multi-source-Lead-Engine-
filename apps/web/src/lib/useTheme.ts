"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_EVENT = "dleads-theme-change";

function read(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The blocking script in layout.tsx owns the first paint; this only mirrors that
 * state into React afterwards, so nothing here decides the initial theme.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(read());
    const sync = () => setTheme(read());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  const apply = useCallback((next: Theme) => {
    const root = document.documentElement;
    // Transition only during a deliberate flip, never while the page settles.
    root.classList.add("theme-transition");
    root.classList.toggle("dark", next === "dark");
    root.dataset.theme = next;
    window.setTimeout(() => root.classList.remove("theme-transition"), 320);
    try {
      localStorage.setItem("dleads-theme", next);
    } catch {
      // Private mode can block storage; the theme still applies for this visit.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return [theme, apply];
}
