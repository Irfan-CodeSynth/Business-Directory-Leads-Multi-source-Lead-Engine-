export interface SourceStat {
  source: string;
  status: string;
  found: number;
  skipped: number;
  merged: number;
  enriched: number;
  requestsUsed: number;
  /** Results the source handed back, billed ones included — dedup skips still cost money. */
  resultsPulled: number;
  lastError: string | null;
}

/**
 * What the paid sources may still spend, read on the server: the form cannot query
 * the ledger or the environment, so the New run page hands these down as props.
 */
export interface ApifyBudget {
  configured: boolean;
  monthlyCap: number;
  monthRemaining: number;
}

export interface JobSummary {
  id: number;
  status: string;
  phase: string | null;
  phaseTotal: number | null;
  phaseDone: number | null;
  cancelRequested: boolean;
  keywords: string[];
  locations: string[];
  sources: string[];
  maxItems: number;
  leadTarget: number;
  importLabel: string | null;
  importRows: number;
  leadsFound: number;
  leadsSkipped: number;
  leadsMerged: number;
  errorMsg: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceStats: SourceStat[];
}

export interface LeadRow {
  id: number;
  jobId: number;
  name: string;
  source: string;
  /** Which dedup tier keyed this business (`p`/`z`/`w`/`n`/`x`) — how it was matched. */
  dedupKind: string;
  /** Every source this business was found on, including ones from other jobs. */
  sources: string[];
  profileUrl: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  website: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  status: string;
  notes: string | null;
  emails: string[] | null;
  /** profile|website|import|both — how much to trust the address. */
  emailSource: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  twitter: string | null;
  youtube: string | null;
  tiktok: string | null;
  enriched: boolean;
  createdAt: string;
}

export interface WorkerStatus {
  lastSeenAt: string | null;
  currentJobId: number | null;
  version: string | null;
  /** A worker is polling this database right now, so jobs will actually run. */
  online: boolean;
}

export interface DashboardStats {
  totalLeads: number;
  totalKnownBusinesses: number;
  totalJobs: number;
  activeJobs: number;
  blockedSources: number;
  enrichedCount: number;
  emailsCount: number;
  /** Businesses collected by more than one source — the strongest signal in the list. */
  overlapCount: number;
  enrichmentRate: number;
  sourceBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  topCategories: Array<{ category: string; count: number }>;
  recentJobs: JobSummary[];
  recentLeads: Array<{
    id: number;
    jobId: number;
    name: string;
    source: string;
    category: string | null;
    website: string | null;
    phone: string | null;
    status: string;
    createdAt: string;
    emails: string[] | null;
  }>;
  worker: WorkerStatus;
}
