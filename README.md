# Directory Leads

Business-directory lead generation: collect **name, phone, email and social profile links** for
local businesses from **OpenStreetMap**, **CSV lists you already hold**, and optionally the paid
**Yelp** / **HotFrog** directories through Apify Actors, deduplicate them across runs with a
cross-job ledger, enrich from the businesses' own websites, and export CSV.

No n8n, no Chromium: the Postgres `jobs` table is the queue and every v1 data path is plain HTTP.
Runs for **$0/month** (free Postgres + free web hosting + the worker on your own machine). The two
paid sources are the only part that can cost money, they are off until you paste an Apify token,
and a monthly result cap bounds them — see [Paid directory sources](#paid-directory-sources-apify).

## What it does

| Source | How | Notes |
|---|---|---|
| `osm` | Nominatim geocodes the location, Overpass QL collects businesses | Courtesy-capped (~1 req/s). Rate-limited sources are marked `blocked`, never failed |
| `csv` | Rows you paste or drop in the Import tab | No network, so it can never be blocked |
| `yelp` | `memo23/yelp-scraper` through Apify | **Paid**: $2.75 per 1,000 results. Counts as blocked-and-stops when the token is missing or the monthly cap is spent |
| `hotfrog` | `solidcode/hotfrog-scraper` through Apify | **Paid**: $2.50 per 1,000 results. Same cap; arrives with emails and social links |

After collection, each lead with a website is crawled once per **host** (`website_observations`):
`mailto:` and free-text emails, Instagram / Facebook / LinkedIn / X / YouTube / TikTok links, plus
`application/ld+json` `LocalBusiness` data. A chain of 40 stores on one domain costs one crawl.

Leads are deduplicated with tiered keys (`packages/db/src/dedup.ts`): phone → name+postcode →
name+website host → source external id → name+city (never cross-source). Names are normalised
("Acme Plumbing, Inc." ≡ "acme plumbing"), and generic or single-token names are excluded from the
cross-source ledger so they cannot swallow unrelated businesses.

### What one collected business becomes

Each listing the worker ingests ends up as exactly one of three outcomes, counted per job *and* per
source (`job_source_stats`), so the numbers on a job page are always the sum of its sources:

- **new** — a `leads` row for this job, plus a `known_businesses` ledger row pointing at it.
- **known** — the ledger already recognised it (by source id, or by phone / postcode / website host):
  the existing row gains a `lead_sources` link, blanks are filled, and CRM fields you edited are left
  alone. No new row, and recognising it costs no request.
- **already collected** — this exact `(job, source, listing id)` was in the previous run of *this*
  job, so the job resumes without re-writing anything.

Because the ledger is cross-job, a second job over the same ground reports "0 new, 6 already known"
rather than handing you a fresh copy of businesses you already have. That is deliberate — one
business, one phone-call state — and it is why a job's counts are split three ways instead of one
"leads found" number.

Deleting a job removes its leads but not the ledger (a business stays known); the next run that finds
it again re-points the existing ledger row at the new lead instead of writing a source link against a
row that is gone.

### How many leads a run brings

A run carries two numbers, and they answer different questions:

- **cap per query** (`jobs.max_items`, default 100) — how many listings one keyword × location may
  bring back. It is the ask, not a promise.
- **new leads wanted per source** (`jobs.lead_target`, default 100) — how many businesses a source
  should *add* before the run stops it. It counts `new` only: listings the ledger already knows are
  merged or skipped and do not eat into the target, so 100 wanted really means 100 businesses you
  did not have before.

When a source reaches its target it is marked `done` like any finished source — not blocked, not
cancelled — and the queries it did not need are never sent. On a paid source that is money kept:
each work unit asks the Actor for `min(cap, what is still missing)`, and a Stop that arrives
mid-query lands between listings rather than mid-request.

Two consequences worth knowing. **A target is a ceiling, not a floor.** One keyword in one city may
hold forty mapped plumbers; the run then ends `done` with forty, and the way to reach a hundred is
more keywords or nearby cities, not a bigger number — the New run form says which of your plan's
queries can never add up to the target. **Reaching 100 new can cost more than 100 results.** Apify
bills everything an Actor returns, including rows the ledger discards, so the monthly cap — not the
target — is what guards the money.

A CSV import ignores the target deliberately: its rows are already in your hands and already paid
for, and dropping the tail of a list you pasted would lose your data silently.

### Importing a list

The Import tab reads pasted text or a dropped file with a small RFC-4180 reader (`apps/web/src/lib/csv.ts`):
quotes, doubled quotes, embedded newlines, CRLF, a BOM, and a sniffed `,` / tab / `;` / `|` delimiter.
Headers are matched case- and punctuation-insensitively (`Business Name`, `business_name`, `COMPANY` →
`name`), and the guess is shown so you can correct it — a column is only ever used once you've mapped it,
and **name** is the only required one. Rows with no name are dropped in the UI and reported rather than
imported as blank businesses.

Mapped rows are stored on the job (`jobs.import_rows`) in the canonical vocabulary the worker reads
(`apps/worker/src/adapters/csv.ts`: `name`, `phone`, `email`, `website`, `address`, `city`, `state`, `zip`,
`category`, `instagram`…`tiktok`), so a re-run replays the same list without the file. Because those rows
go through the same ingest path as `osm`, an imported list dedupes against your map leads by phone,
postcode and website host — pasting the same businesses a discovery job already found reports them as
*known*, not as new.

### Paid directory sources (Apify)

`yelp` and `hotfrog` are collected by third-party Apify Actors — a licensed data provider does the
scraping under its own arrangements, we pay per result, and this app never logs into a directory,
defeats a bot check, or reads anything behind a paywall. One driver serves both
(`apps/worker/src/adapters/apify.ts`), and it sits in the same `SourceAdapter` seam as the free ones,
so the schema, the dedup tiers and the ingest path are unchanged.

**Money.** A work unit is one Actor run plus one dataset read. The run is started over HTTP, which
Apify keeps open for up to 60 seconds; a slower one is polled every `APIFY_POLL_INTERVAL_MS` until it
finishes, so a job's request count goes up but its bill does not (Apify charges results, not calls).
The Actor is asked for no more rows than the lead target still needs
([How many leads a run brings](#how-many-leads-a-run-brings)), and for no more results than
`APIFY_MONTHLY_RESULT_CAP` leaves across the whole calendar month, shared by both paid
sources (default 1,500 — roughly the $5 of Apify free-plan credit at these prices). Every result an
Actor returns is charged to that cap, *including* the ones the ledger recognised as already known,
because Apify billed those too: the counter is `job_source_stats.results_pulled`, and unlike the
per-run counters it is never zeroed, so a re-run pays again rather than looking free.

**What is kept, and what is thrown away.** Name, phone, website, profile URL, address, city/region/
postcode, category, star rating and review *count*. `stripReviews()` drops every review-shaped field
(`reviews`, `reviewHighlights`, `reviewInsights`, `painPoints`…) before a lead is built, and the
Actors are asked not to fetch them in the first place (`scrapeReviews: false`, `enrichEmails: false`,
`includeDetails: true` only for HotFrog's own contact fields). Customer words therefore cannot reach
the database or an export. Nothing is re-published to a directory page.

**When it stops.** A missing `APIFY_API_TOKEN`, an exhausted monthly cap, or an Apify refusal (401,
402, 403, 429) marks the source `blocked` with the reason — no request is sent once the cap is spent,
and **Re-run blocked sources** picks it up later. An Actor run that itself fails, times out or is
still going when `APIFY_RUN_TIMEOUT_S` runs out is an `error`, which is a real fault rather than a
bill we chose not to pay. Meeting the lead target is neither: the source simply runs out of queries
to make and finishes `done`.
The New run form prices the keyword × location matrix before you submit and shows what is left of the
monthly cap; a job page shows results pulled and the cost they imply.

Start any new month with a small job (5 results per query) before a wide one: the Actors' output
shapes are documented, but a live run is what proves this month's version still matches them.

### Re-running a job

Both buttons on a job page (`POST /api/jobs/:id/rerun`) re-queue the job; which sources run differs:

- **Re-run blocked sources** queue only the sources whose `job_source_stats.status` is `blocked` or
  `error`. Sources that already finished are left completely alone — the worker skips them rather than
  re-querying a service that just throttled us, which would spend the courtesy budget we are waiting out.
- **Re-run everything** queues all of the job's sources, and each one resumes: listings it already wrote
  for this job come back as *already collected*, so re-running costs requests but not duplicates.

Per-source counters split by meaning, and the same rule holds at job level so the two always agree:

| Counter | On a re-run |
|---|---|
| `found` / `leads_found` | **persists** — how many businesses this job owns from that source |
| `skipped`, `merged`, `enriched`, `requests_used` | re-zeroed by the worker as that source starts, so they describe the run you just asked for — a source that is not re-run keeps the numbers of the run that produced them |
| `results_pulled` | **persists** — on a paid source this is the billed count, so zeroing it would hand a re-run a free pass through the monthly cap |

The dashboard's "worker online" badge reads `worker_status`, which the worker rewrites on every poll
*and* at every yield inside a running job (each collected listing, each enrichment page). A long crawl
therefore still reads "worker online · job #7", instead of "no worker running" at exactly the moment one
is busiest. `WORKER_HEARTBEAT_STALE_MS` (120 s) sets how late a heartbeat may be.


## Requirements

- Node.js 20+
- npm workspaces are used as-is: one `npm install` at the repo root.

## Local setup

```bash
cp .env.example .env
cp .env apps/web/.env.local
npm install
```

Start the bundled Postgres-compatible dev database (PGlite, no install needed, port **5434**):

```bash
npm run db:dev
```

In a second terminal, create the tables and the sign-in user:

```bash
npm run db:migrate
npm run db:seed
```

Then run the two processes that do the work:

```bash
npm run worker   # polls the jobs table, collects, enriches, writes the ledger
npm run web      # dashboard on http://localhost:3111
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (default `team@example.com` /
`devpassword`). Keep the worker running while a job is active — it is what drains the queue.

`yelp` and `hotfrog` stay inert until `APIFY_API_TOKEN` has a value, so a fresh clone costs nothing.
With the token empty, picking one of them on the New run form says so and the worker marks the source
`blocked` instead of sending a request.

Do **not** point `DATABASE_URL` at port 5432 or 5433: those belong to other projects on this
machine. This tool owns 5434.

`.env` carries `DB_NAMED_STATEMENTS=true` for one reason: the bundled database serves every connection
from a single Postgres session, and that session's *unnamed* prepared statement is shared, so the
dashboard and the worker polling at the same moment answer each other's queries
(`bind message supplies 8 parameters, but prepared statement "" requires 6`) — a job dies mid-run and
leads are left behind. Prepared statements with names are private to each connection, which is what the
flag turns on. Against Neon or any pooled managed Postgres, leave the variable unset: there the statement
prepared on one backend is simply missing from the next.

If the dev database stops answering (`read ECONNRESET`) after a worker or script is killed abruptly,
restart it with `npm run db:dev`. The data in `data/pgdata` is untouched; production Postgres/Neon
does not have this property.

## Scripts

| Command | Purpose |
|---|---|
| `npm run db:dev` | bundled PGlite server on 5434 |
| `npm run db:generate` | emit a Drizzle migration from schema changes |
| `npm run db:migrate` | apply migrations |
| `npm run db:seed` | upsert the admin user + the worker heartbeat row |
| `npm run worker` | local worker (`tsx watch`) |
| `npm run web` | Next.js dashboard |
| `npm test` | db + worker + web unit tests |

Direct adapter smoke test, no job needed:

```bash
cd apps/worker
npx tsx src/cli.ts osm "plumber" "Austin, TX" 15
```

## Rate limits & etiquette

Overpass and Nominatim are free public services with a fair-use policy of roughly one request per
second. This worker honours that by default:

- queries run **sequentially**, with a randomised `OSM_DELAY_MIN_MS`–`OSM_DELAY_MAX_MS` gap
  (4–8 s) between them;
- a throttled reply waits `OSM_RETRY_BACKOFF_MS` (30 s), a reply that merely timed out or a socket
  that never opened waits `OSM_TRANSIENT_RETRY_MS` (20 s). After `OSM_MAX_RETRIES` attempts the
  source is flagged `blocked` and the job still finishes `done` — use **Re-run blocked sources**
  later;
- geocoded areas are cached (`OSM_GEOCACHE_TTL_MS`) because areas rarely move;
- `OSM_USER_AGENT` must identify you and a contact address — Nominatim's policy requires it.

### What the live services actually do

Measured against `nominatim.openstreetmap.org` and `overpass-api.de` while building this driver:

- **A placeholder User-Agent is refused.** A string containing `@example.com` gets HTTP 403 from
  Nominatim and HTTP 406 from Overpass — it looks like a ban, but the same request from the same IP
  with a real contact succeeds. Hence `userAgentHint()` in every denial message.
- **Overpass `area()` scoping is not viable on the free instance.** An area-scoped query timed out
  (HTTP 504) after 8–15 s, while the identical clause as a bounding box answered in ~3 s with real
  data. The driver therefore searches boxes, and because a box over-collects at the edges it drops
  businesses whose own `addr:city` contradicts the place searched.
- **Boxes also catch geography.** A name-pattern search for "plumb" returns *Plumbago Drive*, so
  elements tagged `highway`/`waterway`/`railway`/`aeroway`/`natural`/`place` are never leads.
- **`overpass-api.de` still 504s under load** even for a box query (observed on both the first and
  the retry). The 20 s transient backoff is what turns "blocked" into "5 leads" on a second attempt.
  The mirror `overpass.kumi.systems` took 200–230 s for the same query and is not worth waiting on.
- Node's `fetch` reports every socket failure as `fetch failed`; the real reason lives in
  `error.cause` (`UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`), so `politeRequest` unfolds it into the
  retry log and the blocked message.

### Crawling the leads' own websites

Enrichment visits the business's *own* domain and nothing else, under the same kind of budget:

- `ENRICH_MAX_PAGES_PER_HOST` pages (homepage, `/contact`, `/about`, then the hyphenated
  spellings), `ENRICH_MAX_PAGE_BYTES` per page, `ENRICH_TIMEOUT_MS` per request, and a randomised
  `ENRICH_DELAY_MIN_MS`–`ENRICH_DELAY_MAX_MS` gap (1.5–3.5 s) between them;
- `ENRICH_MAX_HOSTS` domains per run (80), so a job with 500 leads cannot become an open-ended crawl.
  Leads it did not reach keep `enriched = false` and are picked up by the next run;
- `website_observations` caches one domain's findings — emails, socials, the phone its own markup
  published — for `ENRICH_CACHE_DAYS` (180). A second job over the same businesses costs **zero**
  requests, and a site that answered nothing is recorded too, so it is not re-visited either;
- a lead whose `website` is actually its Facebook/Yelp/Google page is **not** crawled: that is a
  third-party site's page about the business, not the business's own site;
- `ENRICH_ENABLED=false` skips the phase entirely (collection still runs).

Only pages a site serves to an anonymous visitor are read. There is no login, no paywall and no
bot-detection bypass anywhere in this path. That rule is also why the two paid directories go through
Apify rather than through this crawler: Yelp and HotFrog keep their listings behind terms this app
does not attempt to satisfy on its own.

What is taken from a page: `mailto:` and free-text emails (asset filenames and template
placeholders filtered), one profile link per social network (share widgets, hashtag pages, `/p/`
posts and the platform's own footer accounts filtered), and `application/ld+json` `LocalBusiness`
data. Phones come **only** from that structured markup — a free-text phone regex over arbitrary HTML
turns order numbers and dates into "contact details".

## Deployment ($0/month)

1. **Database** — create a Neon free project. Set
   `DATABASE_URL=postgres://user:pass@ep-xxx-pooler.neon.tech/neondb?sslmode=require` (use the
   pooled endpoint). `POOL_MAX=1` is the default and is fine to keep. Run
   `npm run db:migrate && npm run db:seed` once against it.
2. **Dashboard** — a Render **free web service**, described by `render.yaml` at the repo root.
   `SESSION_SECRET` must be a long random string. The built server reads its environment from
   Render only — the repo's `.env` is not part of the artifact — so every variable it needs has
   to be set in the blueprint or the dashboard. For the paid sources that means
   `APIFY_MONTHLY_RESULT_CAP` (so the quoted remaining budget is the real one) and
   `APIFY_API_TOKEN` if you want the "token not set" notice to be accurate: the web only checks
   whether a token exists, it never calls Apify, and the worker on your machine holds the one that
   spends money. Leave both unset and the dashboard simply treats the paid sources as switched off.
3. **Worker** — runs locally with `npm run worker`, pointed at Neon over SSL. An always-on cloud
   worker polls constantly and would exhaust Neon's 100 CU-hours/month free compute (and Render's
   750 instance hours) within days; running it on your machine keeps the bill at zero and lets the
   database sleep in between.

`render.yaml` deliberately contains **only** the web service.

## Compliance

- **© OpenStreetMap contributors** — collected data is ODbL-licensed. The attribution is rendered in
  the dashboard footer and is written into the first line of every CSV export **for runs that include
  `osm` rows**. Keep it if you republish or share such an export. A paid directory's rows carry that
  source's name instead, so the export states where each row came from.
- **Outreach is your responsibility.** These are business contacts, not opt-in marketing lists.
  Follow CAN-SPAM / GDPR / PECR rules for your region (identity, working opt-out, and a lawful
  basis for cold email in the EU/UK).
- **No login walls, and no review text.** This tool never logs in to a directory, never bypasses a
  paywall, bot check or robots rule, and never stores a customer's review words — not from a paid
  Actor, not from a page. Ratings and review *counts* describe a business; the sentences its
  customers wrote describe people, so `stripReviews()` discards them before anything is written.
- **The paid sources are bought, not taken.** `yelp` and `hotfrog` are served by Apify Actors under
  that platform's terms and your Apify subscription. Which listings a scraper may gather, and
  whether that is permitted for your use, is the licence you are paying for — keep Apify's invoice
  and the Actor's terms with your records, and do not re-publish a directory's listings as your own.
  A differently-licensed collector can replace this driver (`apps/worker/src/adapters/`) without a
  migration or a UI change; `source` is an open value throughout.
- **Spend is capped, and visible.** `APIFY_MONTHLY_RESULT_CAP` bounds a calendar month across both
  paid sources, the New run form quotes a price before you submit, and a job page shows what its
  results cost. A run cannot bill silently: with no token, or with the cap spent, the source stops
  as `blocked` and no request goes out.

## Layout

```
packages/db      schema, migrations, dedup engine, seed, makeDb
apps/worker      queue poller, source adapters, enrichment, ledger writes
apps/web         Next.js 14 dashboard (App Router, standalone output)
scripts/devdb.ts     PGlite dev database, on the patched socket server below
scripts/pgliteSocket.ts  hands each connection's protocol messages over as one group
render.yaml      free web service for the dashboard
```
