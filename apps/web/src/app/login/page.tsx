"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import { Compass, Mail, Lock, AlertCircle, ArrowRight } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError("Invalid email or password");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  function fillDemo() {
    setEmail("team@example.com");
    setPassword("devpassword");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-12">
      {/* Background ambient lighting */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-1/4 -top-1/4 h-96 w-96 rounded-full bg-accent/15 blur-3xl" />
        <div className="absolute -bottom-1/4 -right-1/4 h-96 w-96 rounded-full bg-info-fg/10 blur-3xl" />
      </div>

      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-md">
        <form
          onSubmit={submit}
          className="glass-card animate-scale-in relative rounded-3xl p-8 shadow-lift sm:p-10"
        >
          {/* Brand Icon */}
          <div className="mb-6 flex items-center justify-between">
            <span className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent to-accent-dark text-white shadow-accent">
              <Compass className="h-6 w-6" />
              <span className="absolute -right-1 -top-1 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
              </span>
            </span>
            <span className="rounded-full bg-surface2 px-3 py-1 text-xs font-semibold text-muted">
              v1.0 Ready
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Directory Leads
          </h1>
          <p className="mt-1 text-sm text-muted">
            Sign in to run lead searches, import lists and work your pipeline.
          </p>

          <div className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-semibold text-ink">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-3 h-4 w-4 text-soft" />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="team@example.com"
                  className="w-full rounded-2xl border border-line bg-surface2/60 py-2.5 pl-10 pr-4 text-sm text-ink outline-none transition placeholder:text-soft focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15"
                  required
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="password" className="text-xs font-semibold text-ink">
                  Password
                </label>
                <button
                  type="button"
                  onClick={fillDemo}
                  className="text-[11px] font-medium text-accent hover:underline"
                >
                  Fill dev credentials
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-3 h-4 w-4 text-soft" />
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-2xl border border-line bg-surface2/60 py-2.5 pl-10 pr-4 text-sm text-ink outline-none transition placeholder:text-soft focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15"
                  required
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="animate-fade-in mt-4 flex items-center gap-2 rounded-xl border border-bad-bg bg-bad-bg/30 p-3 text-xs font-medium text-bad-fg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent-strong py-3 text-sm font-semibold text-white shadow-accent transition hover:bg-accent-dark hover:shadow-lift active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? (
              <>
                <Spinner /> Signing in…
              </>
            ) : (
              <>
                Sign in to Dashboard <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin-slow" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
