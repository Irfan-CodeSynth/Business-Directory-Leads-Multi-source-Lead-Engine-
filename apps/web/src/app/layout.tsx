import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Directory Leads",
  description: "Business lead collection from OpenStreetMap and your own lists, with website contact enrichment",
};

export const viewport: Viewport = { themeColor: "#4f46e5" };

// Runs before first paint, so a dark-preferring visitor never sees a white flash.
const INIT_THEME = `(function(){try{var t=localStorage.getItem('dleads-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: INIT_THEME }} />
      </head>
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}
