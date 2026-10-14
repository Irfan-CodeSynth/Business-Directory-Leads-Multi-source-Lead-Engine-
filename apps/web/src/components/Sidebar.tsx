"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import LogoutButton from "@/components/LogoutButton";
import {
  Compass,
  LayoutDashboard,
  PlusCircle,
  Layers,
  MapPin,
  Download,
  X,
  Menu,
  Activity,
  ShieldCheck,
  ChevronRight,
  Sparkles,
} from "lucide-react";

interface SidebarProps {
  resultsHref: string;
  latestJobId?: number | null;
  activeJobsCount?: number;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  badge?: string;
  badgeColor?: string;
  external?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export default function Sidebar({
  resultsHref,
  latestJobId,
  activeJobsCount = 0,
}: SidebarProps) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  // Close mobile sidebar on route change
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  const navGroups: NavGroup[] = [
    {
      title: "Core Platform",
      items: [
        {
          href: "/",
          label: "Dashboard",
          icon: LayoutDashboard,
          active: pathname === "/",
        },
        {
          href: "/new",
          label: "New Lead Run",
          icon: PlusCircle,
          active: pathname === "/new",
          badge: "Build",
          badgeColor: "bg-accent-soft text-accent border border-accent/20",
        },
        {
          href: "/jobs",
          label: "Runs",
          icon: Layers,
          active: pathname === "/jobs",
          badge: activeJobsCount > 0 ? `${activeJobsCount} queued` : undefined,
          badgeColor: "bg-accent text-white animate-pulse",
        },
        {
          href: resultsHref,
          label: "Leads & CRM",
          icon: MapPin,
          active: pathname.startsWith("/jobs/"),
        },
      ],
    },
    {
      title: "Data & Actions",
      items: [
        ...(latestJobId
          ? [
              {
                href: `/api/export?jobId=${latestJobId}`,
                label: "Export Latest CSV",
                icon: Download,
                active: false,
                external: true,
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <>
      {/* Mobile Top Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line/70 bg-surface/85 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setIsOpen(true)}
            className="rounded-xl border border-line bg-surface p-2 text-muted hover:text-ink transition"
            aria-label="Open sidebar menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-strong text-white shadow-accent">
              <Compass className="h-4 w-4" />
            </span>
            <span className="text-sm font-bold tracking-tight text-ink">Directory Leads</span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </div>

      {/* Backdrop for Mobile */}
      {isOpen && (
        <div
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity lg:hidden"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line/70 bg-surface/90 backdrop-blur-2xl transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand Header */}
        <div className="flex h-18 items-center justify-between border-b border-line/60 px-6 py-5">
          <Link href="/" className="group flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent to-accent-dark text-white shadow-accent transition group-hover:scale-105">
              <Compass className="h-5 w-5" />
              <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
              </span>
            </span>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-tight text-ink">Directory Leads</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                Multi-source Lead Engine
              </span>
            </div>
          </Link>

          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-1 text-muted hover:bg-surface2 hover:text-ink lg:hidden transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation Items */}
        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-6">
          {navGroups.map((group) => (
            <div key={group.title} className="space-y-1.5">
              <div className="px-3 text-[11px] font-bold uppercase tracking-wider text-soft">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isLink = !item.external;
                  const content = (
                    <div
                      className={`group flex items-center justify-between rounded-2xl px-3.5 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-[0.98] ${
                        item.active
                          ? "bg-accent-strong text-white shadow-accent"
                          : "text-muted hover:bg-surface2 hover:text-ink"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Icon
                          className={`h-4 w-4 transition-colors ${
                            item.active ? "text-white" : "text-soft group-hover:text-accent"
                          }`}
                        />
                        <span>{item.label}</span>
                      </div>
                      {item.badge && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ${
                            item.badgeColor || "bg-surface2 text-muted"
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                      {!item.badge && item.active && (
                        <ChevronRight className="h-3.5 w-3.5 opacity-80" />
                      )}
                    </div>
                  );

                  return isLink ? (
                    <Link key={item.label} href={item.href}>
                      {content}
                    </Link>
                  ) : (
                    <a key={item.label} href={item.href} download>
                      {content}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Engine Status Card */}
          <div className="rounded-2xl border border-line bg-surface2/50 p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-info-fg animate-pulse-dot" />
              <span className="text-xs font-bold text-ink">Queue-driven worker</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Runs on your machine with <code className="text-accent">npm run worker</code>. It polls the
              jobs table, then crawls business websites for emails and socials.
            </p>
            <div className="mt-2.5 flex items-center gap-1.5 text-[10px] font-semibold text-soft">
              <ShieldCheck className="h-3.5 w-3.5 text-accent" />
              Cross-source dedup ledger active
            </div>
          </div>
        </div>

        {/* Footer / User Profile & Controls */}
        <div className="border-t border-line/60 bg-surface/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-accent to-accent-dark text-[11px] font-bold text-white shadow-sm">
                DL
              </div>
              <div className="flex flex-col truncate">
                <span className="truncate text-xs font-bold text-ink">Team Account</span>
                <span className="truncate text-[11px] text-muted">team@example.com</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeToggle />
              <LogoutButton />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
