import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        page: v("page"),
        surface: v("surface"),
        surface2: v("surface-2"),
        line: v("line"),
        "line-strong": v("line-strong"),
        ink: v("ink"),
        muted: v("muted"),
        soft: v("soft"),
        accent: {
          DEFAULT: v("accent"),
          dark: v("accent-dark"),
          strong: v("accent-strong"),
          soft: v("accent-soft"),
        },
        ok: { bg: v("ok-bg"), fg: v("ok-fg") },
        info: { bg: v("info-bg"), fg: v("info-fg") },
        warn: { bg: v("warn-bg"), fg: v("warn-fg") },
        bad: { bg: v("bad-bg"), fg: v("bad-fg") },
        idle: { bg: v("idle-bg"), fg: v("idle-fg") },
      },
      boxShadow: {
        card: "var(--shadow-card)",
        lift: "var(--shadow-lift)",
        accent: "var(--shadow-accent)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.25rem",
      },
    },
  },
  plugins: [],
};

export default config;
