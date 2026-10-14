"use client";

import { useTheme } from "@/lib/useTheme";

export default function ThemeToggle() {
  const [theme, apply] = useTheme();
  const dark = theme === "dark";

  return (
    <button
      type="button"
      onClick={() => apply(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className="relative grid h-9 w-9 place-items-center rounded-full border border-line bg-surface2 text-muted transition hover:border-accent hover:text-accent active:scale-95"
    >
      <span
        className="absolute transition-all duration-300"
        style={{
          opacity: dark ? 0 : 1,
          transform: dark ? "rotate(-90deg) scale(0.6)" : "rotate(0deg) scale(1)",
        }}
      >
        <SunIcon />
      </span>
      <span
        className="absolute transition-all duration-300"
        style={{
          opacity: dark ? 1 : 0,
          transform: dark ? "rotate(0deg) scale(1)" : "rotate(90deg) scale(0.6)",
        }}
      >
        <MoonIcon />
      </span>
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" strokeLinejoin="round" />
    </svg>
  );
}
