"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PlusCircle, Layers, MapPin } from "lucide-react";

export default function Nav({ resultsHref }: { resultsHref: string }) {
  const path = usePathname();

  const items = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, active: path === "/" },
    { href: "/new", label: "New Job", icon: PlusCircle, active: path === "/new" },
    { href: "/jobs", label: "All Jobs", icon: Layers, active: path === "/jobs" },
    { href: resultsHref, label: "Map & CRM", icon: MapPin, active: path.startsWith("/jobs/") },
  ];

  return (
    <nav className="flex items-center gap-1 rounded-2xl border border-line/70 bg-surface2/80 p-1 backdrop-blur-md">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`relative flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 active:scale-95 sm:text-sm ${
              item.active
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:bg-surface/50 hover:text-ink"
            }`}
          >
            <Icon className={`h-4 w-4 ${item.active ? "text-accent" : "text-soft"}`} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
