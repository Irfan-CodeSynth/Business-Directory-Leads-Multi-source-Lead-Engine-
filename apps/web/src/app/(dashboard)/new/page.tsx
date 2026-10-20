import NewJobForm from "@/components/NewJobForm";
import { Sparkles, Shield, Zap, Search } from "lucide-react";
import { getApifyBudget } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const apify = await getApifyBudget();

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
            <Zap className="h-3.5 w-3.5" />
            Free and paid sources, one ledger
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Start a lead run
          </h1>
          <p className="mt-1 text-sm text-muted">
            Collect name, phone, email and social links from OpenStreetMap, from a paid directory source billed through Apify, or import any list you are already entitled to use.
          </p>
        </div>
      </div>

      {/* Feature Highlights Grid */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-2xl p-4">
          <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Search className="h-4 w-4" />
          </div>
          <div className="text-sm font-semibold text-ink">One focused search</div>
          <div className="mt-1 text-xs text-muted">
            Keyword, category and a city inside a country — a question every source can answer, from the free map to a paid directory Actor.
          </div>
        </div>

        <div className="glass-card rounded-2xl p-4">
          <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-ok-fg/10 text-ok-fg">
            <Shield className="h-4 w-4" />
          </div>
          <div className="text-sm font-semibold text-ink">Cross-source deduplication</div>
          <div className="mt-1 text-xs text-muted">
            Businesses already in the ledger are skipped before a request is spent, even across sources.
          </div>
        </div>

        <div className="glass-card rounded-2xl p-4">
          <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-info-fg/10 text-info-fg">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="text-sm font-semibold text-ink">Website contact enrichment</div>
          <div className="mt-1 text-xs text-muted">
            Crawls each business's own site for emails and Instagram, Facebook, LinkedIn, X, YouTube and TikTok links.
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="glass-card rounded-3xl p-6 sm:p-8">
        <NewJobForm apify={apify} />
      </div>
    </div>
  );
}
