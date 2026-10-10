# Daily Emails

Two daily emails at 09:00 UTC: a market and tech digest, and a separate analytics, billing, and usage report.

## What it does

Every day at **09:00 UTC** (Hobby timing may land anytime in the 09:00–09:59 window), Vercel Cron hits `/api/daily-brief`, which:

1. Pulls the last 24 hours of Google News headlines for **TSLA, MU, META, BTC, AVGO, CRCL, SPCX, MSFT**
2. Checks for speeches/announcements by **Andrej Karpathy, Jensen Huang, Alex Karp, Sam Altman, Elon Musk, Donald Trump** — only names with a market-moving remark are included. Musk/Trump use their own last-24h posts (X / Truth Social) and can include **two** items each
3. Pulls previous + next earnings report dates for public tickers on the watchlist
4. Pulls **Fear & greed** meters (CNN equities, Crypto Alternative.me, VIX) plus a per-ticker greed proxy (52-week range + RSI)
5. Pulls **open-market Form 4 buys and sells** from [OpenInsider](http://openinsider.com/) filed in the last 24 hours (officer-weighted, watchlist hits, clustered buys), filtered to the S&P 500 and $10B+ large caps
6. Pulls **superinvestor 13F activity** from [Dataroma](https://www.dataroma.com/m/home.php) (clustered buys, notable adds, recent Form 4) and writes a short whale briefing
7. Pulls Google Trends top searches (Trending Now) for:
   - **United States** — top 10 (with traffic + related news; non-English titles translated)
   - **Thailand** — a pool of rising searches, then the **3 most important** items with English titles and 1–2 sentence descriptions (no local-language text)
   - Fetches **2×** each region’s limit, drops **Sports**-category rows, then keeps the configured top N
8. Flags topics rising in **2+ regions**
9. Pulls top Reddit posts (title, link, thumbnail when available) for configured subreddits
10. Pulls **GA4** yesterday + 7-day trend + month-to-date overviews for configured sites (when a service account is set), plus **Google Cloud Billing** month-to-date (through yesterday UTC, including today on the 1st)
11. Loads the last successfully delivered slim snapshot (when available); currently records availability, without generating day-over-day movers
12. Summarizes news, trends, whale activity, and valuation multiples with **Vercel AI Gateway** (`openai/gpt-5-mini` by default)
13. Saves a **markets brief** payload for the secret hosted page (Blob when configured, otherwise `.data/markets-latest.json`)
14. Collects **usage** after AI generation and before either email is sent (AI Gateway credits, Vercel platform usage, Blob storage/operations, Resend usage, and TV Roulette's recorded unogsNG requests), with a **quota watch** for capped readings ≥50% of their limit
15. Emails `EMAIL_TO` via **Resend** twice, each with HTML + plain text: the main digest with its hosted markets CTA, and a separate analytics, billing, and usage report
16. After confirmed main-digest delivery, saves a slim snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`). Both deliveries are attempted even if one fails

Configurable lists live in `src/lib/config.ts` (`TICKERS`, `PEOPLE`, `TREND_REGIONS`, `REDDIT_SUBREDDITS`, `GA_ACCOUNTS`, `GCP_BILLING_ACCOUNT`, `DEFAULT_MODEL`).

## Hosted markets page

Fear & greed, insider trades, whale watch, watchlist notes with session context, greed proxies, **TradingView** charts, and earnings render at a **secret URL**:

```
https://your-app.vercel.app/markets/<MARKETS_PAGE_SECRET>
```

- Set `MARKETS_PAGE_SECRET` to a long random string (`openssl rand -hex 24`)
- Set `APP_BASE_URL` to your public origin so the email CTA links correctly (on Vercel, `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` are used as fallbacks)
- Local/dev without a secret uses `dev-markets-secret` → `http://localhost:3000/markets/dev-markets-secret`
- Wrong token → 404; page is `noindex`
- Requires the daily brief to have saved once (Blob or local `.data/markets-latest.json`)
- Reads the saved daily brief only; page visits do not fetch live server data, call AI, or overwrite storage. TradingView charts still load in the browser
- Sends a `no-referrer` policy to avoid passing the token URL to external links
- **Storage privacy:** the URL token protects the Next.js page only. JSON in a public Blob store remains accessible directly to anyone who knows its Blob URL. Use a private Blob store with `BLOB_ACCESS=private` to protect stored payloads. This does not convert an existing public store or remove previously published files

## The two daily emails

Both use the existing `EMAIL_FROM`, `EMAIL_TO`, and cron schedule; no new environment variables or second cron job are needed.

- **Markets, News & Trends · date**: markets-page CTA, speeches and announcements, web trends, and Reddit. Market details remain on the saved hosted page.
- **Analytics, Billing & Usage · date**: a dedicated operations layout with reporting-site count, cloud-spend overview (with its actual date range), quota watch near the top, GA4 site cards, Cloud Billing costs and monthly API/SKU usage, and Vercel/AI Gateway/Blob/Resend usage with progress bars. GA4 daily metrics share a compact three-column panel on desktop and mobile, with each value and its change vs prior day on the same line and a slim bounce-rate/duration row. Missing reports are labeled unavailable; billing and usage retain their freshness notes.

Each email has its own payload-derived Resend idempotency key. The cron response preserves `emailId` for the main digest and adds `emailIds` and `deliveries` for both emails. It returns HTTP 500 on a partial failure with the accepted email's ID and the failed email's error; `ok: true` requires both IDs. History follows acceptance of the main digest, even if the operations delivery fails. Generating a different payload on a later run can still send another email; this does not guarantee one pair per calendar day.

Vercel platform usage uses a compact metric / used-limit / percentage table. Live readings share their date range and scope once; cached readings and failures retain their individual dated details. CDN-only transfer and average storage definitions appear in a short footer. Plain text retains the full usage details.

## What’s in the emails (data + AI)

All LLM calls go through **Vercel AI Gateway** using the [AI SDK](https://ai-sdk.dev) `generateText` helper with `Output.object`. Default model: **`openai/gpt-5-mini` with explicit low reasoning** (override the model with `AI_MODEL`). No provider SDKs are wired directly — the Gateway routes the request.

| Email / page section                                      | Data source (no AI)                                                                                                                                                | LLM / API used                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Session context** _(hosted watchlist)_                  | Google News RSS — last 24h per ticker                                                                                                                              | Same core brief call — one pre-market / after-hours / crypto-session line inside each related ticker card                       |
| **Full markets brief CTA** _(email → hosted page)_        | Link built from `APP_BASE_URL` + `MARKETS_PAGE_SECRET`                                                                                                             | **No LLM**                                                                                                                      |
| **Fear & greed** _(hosted page)_                          | CNN F&G, Alternative.me Crypto F&G, VIX via feargreedchart; equities via Stock Analysis (52w + RSI14); BTC via CoinGecko                                           | **No LLM** — value dial + Lean buy / Neutral / Patience stance per ticker (symbols follow config; unavailable quotes are labeled)                              |
| **Insider trades** _(hosted page)_                        | [OpenInsider](http://openinsider.com/) SEC Form 4 open-market P/S filed in the last 24 hours (buys $25k+, sells $100k+; clusters + watchlist)                      | **No LLM** — tables stay data-backed. Falls back to the latest filing day on weekends / Monday 09:00 UTC.                       |
| **Whale watch** _(hosted page)_                           | [Dataroma](https://www.dataroma.com/m/home.php) superinvestor 13Fs (clustered buys, manager adds) + Form 4 realtime buys                                           | AI Gateway — briefing, sector themes, watchlist overlap. Tables stay data-backed. 13Fs lag up to 45 days.                       |
| **Markets + TradingView** _(hosted page)_                 | Google News RSS — last 24h; charts via TradingView embeds (`tradingViewSymbol` in config)                                                                          | Core brief: 3–5 bullets with **Watch / Noise / Actionable** flags, **source links**, **why it matters**                         |
| **Earnings & catalysts** _(hosted page)_                  | Stock Analysis earnings calendar (prev + next report dates)                                                                                                        | **No LLM** — skips tickers without an `earningsSymbol`                                                                                                   |
| **Speeches & announcements** _(email)_                    | Google News RSS — last 24h per person; **Elon Musk** via FxTwitter timeline, **Donald Trump** via trumpstruth.org RSS (own posts, last 24h)                         | Core brief: reviews all items; Musk/Trump keep **up to two** market/crypto-moving posts with original-post links; others keep **one** or are omitted |
| **Web trends · United States**                            | Google Trends Trending Now (`geo=US`); Sports filtered                                                                                                             | Optional translation when non-English                                                                                           |
| **Web trends · Thailand**                                 | Google Trends Trending Now (`geo=TH`); Sports filtered                                                                                                             | English title + 1–2 sentence description for the **3 most important** items (no local-language text)                            |
| **Also rising in 2+ regions**                             | —                                                                                                                                                                  | **No LLM** — string match on English titles                                                                                     |
| **Reddit**                                                | Reddit Atom RSS — top 6 per sub (`pics`, `generativeAI`, `CursedAI`, `aiArt`); day → week → hot fallback | **No LLM** — subreddits in 2 columns; posts in a 3-column grid with larger thumbnails                                           |
| **Google Analytics** _(operations email)_                                      | GA4 Data API — yesterday KPIs (vs prior day), 7-day users bar chart, and month-to-date totals for `uwhmap.com`, `greetingcardfun.com`, `tvroulette.app`, `restaurantroulette.app`            | **No LLM** — shows unavailable when Google credentials are unset                                                |
| **Google Cloud Billing** _(operations email)_                                  | Costs: month-to-date (through yesterday UTC) for billing account `016802-8E2106-038F4F` covering **AI Greeting Card** and **Restaurant Roulette** — labeled daily net-cost bars (seven-day groups for windows over 14 days) and a separate service breakdown. The MTD window stays fixed, including $0 rows; missing export dates are unreported. **Billed usage** starts on the **1st of this month**: Gemini input/output quantities are tokens, Maps/Places quantities are billed SKU events, which can differ from request counts. | **No LLM** — BigQuery Standard usage cost export. Shows a setup card until `GCP_BILLING_BQ_TABLE` is set                         |
| **Usage watch** _(operations email)_                                           | AI Gateway, Fast Data Transfer, Edge Requests, Blob size/ops, function invocations, Resend                                                                         | **No LLM** — flags capped usage ≥50%; Resend limits come from its usage API                                                                        |
| **Delivery**                                              | —                                                                                                                                                                  | **Resend API** sends two HTML + plain-text emails                                                                                    |

In practice that means **up to five** Gateway model calls per daily run:

1. One structured core brief (markets, people, overnight, flags, quotes)
2. One optional US translation pass if non-English strings appear
3. One Thailand English pass (pick 3 most important items + descriptions)
4. One whale-watch briefing (superinvestor 13F / Form 4 themes)
5. One batched value-investor note pass when equity multiples are available

Trend fetches, snapshot I/O, page visits, and email sending do not use AI credits. All generation calls have a 60-second deadline. If the core model call fails, the brief keeps source headlines and links; unsupported person summaries are omitted.

## Setup

Use **Node.js 22 or later** (required by AI SDK 7); this repo is checked locally on Node.js 24.

1. Copy env template:

```bash
cp .env.example .env.local
```

2. Fill in:

| Variable                    | Required | Notes                                                                                                        |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `RESEND_API_KEY`            | Yes      | From [Resend](https://resend.com)                                                                            |
| `EMAIL_FROM`                | Yes      | Verified Resend domain (sent as `Daily Emails <EMAIL_FROM>`)                                                 |
| `EMAIL_TO`                  | No       | Defaults to `streethouse4@gmail.com`                                                                         |
| `CRON_SECRET`               | Prod     | Random string; same value in Vercel env                                                                      |
| `MARKETS_PAGE_SECRET`       | Prod     | Long random string for `/markets/<secret>`; local/dev falls back to `dev-markets-secret`                     |
| `APP_BASE_URL`              | Prod\*   | Public origin for the email markets CTA (e.g. `https://your-app.vercel.app`); Vercel URL envs used if unset  |
| `AI_GATEWAY_API_KEY`        | Local    | From the [AI Gateway](https://vercel.com/docs/ai-gateway) dashboard; on Vercel, OIDC can work without this   |
| `AI_MODEL`                  | No       | Defaults to `openai/gpt-5-mini`                                                                        |
| `AI_GATEWAY_MONTHLY_BUDGET` | No       | USD free-credit budget for usage watch (default `5`)                                                         |
| `BLOB_ACCESS`               | No       | `public` (existing-store default) or `private`; must match the connected Blob store |
| `BLOB_READ_WRITE_TOKEN`     | Prod\*   | From a [Vercel Blob](https://vercel.com/docs/vercel-blob) store — enables durable snapshots, markets payloads, and usage caches |
| `VERCEL_TOKEN`              | Prod\*   | [Account token](https://vercel.com/account/tokens) for Fast Data Transfer / platform usage via `/v2/usage` |
| `VERCEL_TEAM_ID`            | No       | Team id (defaults to `orgId` in `.vercel/project.json` when linked)                                          |
| `GOOGLE_CLIENT_EMAIL`       | No       | GCP service account email for the **Google Analytics** and **Cloud Billing** sections                        |
| `GOOGLE_PRIVATE_KEY`        | No       | Service account private key (PEM; literal `\n` newlines are fine)                                            |
| `GCP_BILLING_ACCOUNT_ID`    | No       | Cloud Billing account id (default `016802-8E2106-038F4F`)                                                    |
| `GCP_BILLING_BQ_TABLE`      | Billing* | BigQuery export table `project.dataset.gcp_billing_export_v1_016802_8E2106_038F4F` (jobs run in the table’s project) |
| `GOOGLE_CLOUD_PROJECT`      | No       | Fallback GCP project for table discovery if `GCP_BILLING_BQ_TABLE` is unset                                 |
| `GCP_BILLING_BQ_JOB_PROJECT`| No       | Project that runs the billing query job (defaults to the table’s project)                                    |

\*Without Blob, local runs still persist to `.data/previous-brief.json` and `.data/markets-latest.json`. On Vercel without Blob, history is unavailable and the hosted markets page stays empty until a store is connected. `APP_BASE_URL` is recommended in production so the email CTA always points at your canonical domain.

### Google Analytics

Optional. Without these env vars both emails still send — the operations email labels Google Analytics data as unavailable.

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project
2. Enable **Google Analytics Data API** and **Google Analytics Admin API**
3. Create a **service account**, download a JSON key, and copy `client_email` + `private_key` into `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`
4. In Google Analytics (as the property owner), open each account under `GA_ACCOUNTS` → **Admin → Account access management** → add the service account email as **Viewer**
5. Redeploy / restart so the env vars are available

Account IDs, exact GA4 property IDs, and email labels live in `src/lib/config.ts` (`GA_ACCOUNTS`). The Admin API reads each configured property's timezone and verifies its account; the collector does not select an arbitrary first property.

The operations report includes `uwhmap.com`, `greetingcardfun.com`, `tvroulette.app`, and `restaurantroulette.app`. Restaurant Roulette uses account `344920077`, property `477168801`. Give the existing reporting service account (`GOOGLE_CLIENT_EMAIL`) **Viewer** access in **Admin → Property access management** for that property. Until access is granted, its card shows a permission error and the other sites continue reporting normally.

### Google Cloud Billing

The email shows **month to date through yesterday UTC** (includes today on the 1st) for billing account `016802-8E2106-038F4F` (`GCP_BILLING_ACCOUNT` in `src/lib/config.ts`), which covers both **AI Greeting Card App** and **Restaurant Roulette**, compared with the same days last month. The date window stays fixed even when costs are zero. The report shows provisional net costs after credits by **UTC usage date**, not an invoice total. Google Console daily reports use **Pacific time**, so day boundaries can differ. Latest export append time and latest usage date are shown separately; missing days are unreported, not verified zero activity. Prior-period comparisons are suppressed when the export does not extend back to the comparison start.

**Billed SKU quantities are month to date from the 1st**, including $0 rows. Gemini input/output quantities are tokens, not API requests. Maps/Places quantities are billed events; summing multiple SKUs does not necessarily count unique API calls. Recognized Places free-event allowances are standard pricing references, not verified account quotas. Costs and credits are converted to USD using each row’s export conversion rate when necessary. Late corrections are included without an artificial upper export-date cutoff; daily values are summed at full precision before formatting.

Restaurant Roulette billing and the daily-emails service account are on **different Google accounts**. The export must land in a project **linked to billing account `016802-8E2106-038F4F`**, then that dataset is shared with `GOOGLE_CLIENT_EMAIL`.

1. On the Restaurant Roulette login, pick a project already billed to that account (or create `billing-export` and link it)
2. In [BigQuery](https://console.cloud.google.com/bigquery), create dataset `billing_export` with location **US** (multi-region, so current + previous month backfill). Leave table expiration off
3. [Billing export](https://console.cloud.google.com/billing/016802-8E2106-038F4F) → **BigQuery export** → enable **Standard usage cost** → that project + `billing_export`
4. Dataset **Sharing** → add `GOOGLE_CLIENT_EMAIL` as **BigQuery Data Viewer**
5. On the export project (AI Greeting Card App), grant that same email **BigQuery Job User**
6. Set `GCP_BILLING_BQ_TABLE=YOUR_PROJECT.billing_export.gcp_billing_export_v1_016802_8E2106_038F4F` locally and on Vercel

Until the table is readable, the email shows a short setup card instead of the chart. First US-region backfill can take up to five days.

### Run locally

Install and run:

```bash
npm install
npm run dev
```

Trigger a real send (replace `YOUR_CRON_SECRET` with the value in `.env.local`):

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/daily-brief
```

`CRON_SECRET` is optional only outside production; if set, its bearer header is required in development too. This GET fetches live data, spends AI credits, saves the markets payload, and sends both daily emails. HEAD returns 405 without running the job.

In production, call with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/daily-brief
```

## Deploy on Vercel (Hobby / free)

1. Push to GitHub and import the project in Vercel
2. Set env vars: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `CRON_SECRET`, `MARKETS_PAGE_SECRET`, and preferably `APP_BASE_URL`
3. (Recommended) Create a **private** Blob store, set `BLOB_ACCESS=private` and `BLOB_READ_WRITE_TOKEN` for durable snapshots, markets payloads, and usage caches
4. Deploy to **Production** (crons only run on production)
5. Cron schedule is defined in `vercel.json`: `0 9 * * *` → `/api/daily-brief`
6. After the first successful run, open `/markets/<MARKETS_PAGE_SECRET>`

Optional: override `AI_MODEL` after checking current Gateway availability and pricing.

## RapidAPI unogsNG usage (TV Roulette)

The operations email includes subscription billing start/end timestamps and every 24-hour quota day in the current cycle. It shows recorded outgoing request attempts, the configured daily allowance, and estimated daily/cycle overage costs. The previous cycle is also shown when tracking covers any of its days. The current day's recorded usage joins quota watch at 50% of the configured daily allowance. Costs are calculated per day, never by averaging requests across the month.

The RapidAPI transaction inspected on 10 October 2026 charged **$36.10 for 361 excess requests** during **9 September–9 October 2026, 10:51 UTC**. The existing Basic plan has **100 requests per subscription day**, with **$0.10 per additional request**. Billing is request-based; that bill was not a byte-transfer charge. The invoice displays times to the minute; confirm the precise reset time if RapidAPI provides seconds. RapidAPI's [pricing documentation](https://docs.rapidapi.com/v2/docs/api-pricing) explains subscription-time daily resets, and its [billing export API](https://docs.rapidapi.com/docs/exporting-api-consumer-billing-data) is for enterprise hubs, not rapidapi.com accounts.

Setup after reviewing both repositories' changes:

1. On TV Roulette's Netlify project, set a dedicated random `UNOGS_USAGE_SECRET` and `UNOGS_BILLING_ANCHOR=2026-01-09T10:51:00Z`. Ensure the existing Netlify Blobs credentials are available to the title functions (`NETLIFY_SITE_ID`/`SITE_ID` and `NETLIFY_AUTH_TOKEN`). The tracker uses a separate `unogs-usage-v1` store; it does not clear the response cache. Set `UNOGS_DAILY_REQUEST_LIMIT=100` to enforce a shared daily cap. `UNOGS_OVERAGE_PRICE_USD=0.10` reflects the inspected plan; update them if the plan changes.
2. On Daily Emails, set `TV_ROULETTE_USAGE_URL=https://tvroulette.app/api/unogs-usage` and `TV_ROULETTE_USAGE_SECRET` to the same reporting secret. Never use the RapidAPI key as the reporting secret.
3. Deploy both apps to production after configuration. Daily Emails makes one bounded, authenticated, no-store read of the report; it never calls unogsNG, spends RapidAPI credits, or needs a browser session.

Tracking begins with the first recorded request after the TV Roulette change goes live. Earlier days are **untracked**, not zero; first/current windows are partial and future days are upcoming. Calendar midnight is not the quota boundary: 10:51 UTC is 18:51 in Manila. These are **recorded attempts from TV Roulette**, not an authoritative RapidAPI invoice: failed requests, other apps/keys, configured pricing, and best-effort storage failures can differ from provider billing. Estimated cost over an incomplete cycle covers only recorded attempts. TV Roulette atomically reserves requests across instances before calling RapidAPI. Quota/storage failures use cached/local results. The initial partial day is blocked until the next reset because earlier usage is unknown; fresh calls pause within one minute either side of resets to allow for minute-only invoice timestamps. Immutable per-attempt records avoid lost concurrent increments; the source reads every storage page before returning counts. Missing configuration, timeouts, invalid dates/coverage, stale reports, or failed pages produce an unavailable card without blocking either email. No historic backfill, browser credentials, API keys, or private response bodies are included in the email.

## Validation and operations

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Generate local previews with synthetic data, without provider requests or delivery:

```bash
node --import tsx scripts/preview-emails.ts
# Open .data/email-preview/brief.html and operations.html.
# Matching .txt previews are saved alongside them.
```

Tests are offline and mock provider responses. The production build needs network access for Google fonts. The scripts `scripts/send-test-email.ts` and `scripts/send-live-test-email.ts` send both real emails and can update shared Blob data; use them only for intentional live sends.

- News feed failures are isolated per ticker/person and labeled as unavailable, rather than a verified quiet session.
- Reddit batches, fallback windows, rate-limit waits, and retries share a 60-second budget; completed feeds survive a timeout.
- Missing Resend configuration fails before research or AI spending. A send counts as successful only when Resend returns an email ID.
- Identical email payloads share a Resend idempotency key, protecting retries within [Resend's 24-hour window](https://resend.com/docs/dashboard/emails/idempotency-keys). Regenerating a new brief changes the payload; this is not a distributed lock or a guarantee of one run per calendar day.
- Markets persistence is best-effort before sending, so the CTA can load immediately. History is updated only after confirmed main-digest delivery. Missing Blob on Vercel leaves the markets page empty and history unavailable.
- GA4 always reports property-local yesterday, including zero activity. Recent values remain provisional in collected data, but the repeated processing notice is omitted from both email formats. Zero activity is not treated as proof of a delay.
- Billing discovery selects only the configured account's export, and queries filter by billing account. Dataset/table discovery and query results follow every page within a shared 60-second budget. Later-page failures, repeated tokens, and row-count mismatches produce an unavailable report instead of incomplete totals. Set `GCP_BILLING_BQ_TABLE` to skip discovery.
- Saved snapshots currently record `hasPreviousBrief`; no day-over-day news-mover comparison is generated.

## Quotas and models

`DEFAULT_MODEL` is `openai/gpt-5-mini`; override with `AI_MODEL`. All five calls use explicit `reasoning: "low"` with this model. Google model overrides retain the previous disabled-thinking setting; other overrides use provider defaults. The 60-second deadlines, output-token caps, and source-backed fallbacks remain in place. Reasoning tokens count toward the output-token caps, so high reasoning requires a separate latency and truncation check before enabling it.

As checked on 2026-10-03, [GPT-5 mini](https://vercel.com/ai-gateway/models/gpt-5-mini) is eligible for free AI Gateway credits, at $0.25 per million input tokens and $2 per million output tokens (including reasoning). [Gateway's free tier](https://vercel.com/docs/ai-gateway/pricing) includes $5 monthly; purchasing credits moves the account to the paid tier and ends the recurring free allowance. Hobby hosting does not make model calls unlimited. At these rates, a daily digest averaging 50,000 input tokens and 20,000 total output tokens across all calls costs about $1.58 over 30 runs, before retries or other projects' usage. This is an illustrative budget, not a measured digest cost.

Update any existing `AI_MODEL` in local `.env*` files and Vercel's deployment environments to `openai/gpt-5-mini`, or remove it to use the new default. An existing Gemini override takes precedence over the code default. Check the [live Gateway model catalog](https://vercel.com/ai-gateway/models) for model availability, free-credit eligibility, and prices. Model rankings, prices, and plan allowances change; this README does not guarantee a monthly cost.

The core brief and US translation schemas use required nullable fields for [OpenAI structured-output compatibility](https://developers.openai.com/api/docs/guides/structured-outputs). Core null values normalize to the existing undefined representation, so missing quotes and source indexes retain their previous behavior.

For generation-only timing and cost measurements (spends Gateway credits; no email, live source collection, history writes, or Blob writes):

```bash
node --import tsx scripts/evaluate-ai-model.ts
# Allow at least a minute between evaluations on the free tier.
node --import tsx scripts/evaluate-ai-model.ts --sparse
# Optional: supply a saved ResearchBundle JSON instead of the synthetic fixture.
node --import tsx scripts/evaluate-ai-model.ts /absolute/path/to/research.json
```

Reports are local under `.data/ai-model-evaluation-full.json` and `.data/ai-model-evaluation-sparse.json`. The full synthetic fixture covers all eight tickers, all six people, non-English US trends, Thailand trend selection, superinvestor activity, and seven valuation notes. One successful low-reasoning run on 2026-10-03 completed all five calls in **17.7 seconds**, with 5,848 input tokens and 4,643 output tokens including 960 reasoning tokens. Estimated standard-rate cost: **$0.01075/run, or $0.32 for 30 similar runs**; cache discounts are excluded. All calls finished normally, all seven valuation notes were present, and selected trend text was English. This checks schema compatibility and workload timing; synthetic inputs and a single sample do not establish real-news editorial quality or worst-case latency. The evaluated free-tier account also returned a five-requests-per-minute provider limit during rapid reruns; retain the existing deadlines and fallbacks for rate limits and outages.

The sparse-input check completed its single core call in **12.2 seconds** at an estimated **$0.00297**. Its unavailable Micron feed stayed labeled unavailable, and the brief retained all eight ticker sections without triggering an AI fallback.

Vercel usage-watch defaults in `src/lib/config.ts` reflect the intended Hobby setup. Confirm actual limits against your account and use `AI_GATEWAY_MONTHLY_BUDGET` for your AI budget. Resend counts and plan limits come from its [read-only usage API](https://resend.com/docs/api-reference/usage/retrieve-usage), including sent and received emails. A null limit is displayed as “No cap” and is excluded from percentage alerts. `RESEND_DAILY_LIMIT` and `RESEND_MONTHLY_LIMIT` are no longer used.

- Cron configuration is `0 9 * * *` (09:00 UTC). Hosting-plan timing and limits are documented in [Vercel Cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Platform usage requires `VERCEL_TOKEN` on Vercel; local runs may use the authenticated Vercel CLI. Hobby uses an exact **rolling 30-day window ending at collection time**, including today, with no fixed monthly reset. The report uses the dashboard’s read-only `POST /v1/usage-metrics/query` scalar meters for transfer, requests, invocations, and Blob usage. It no longer sums legacy `/v2/usage` Blob request counters, which differed from the dashboard’s billable operations. This dashboard API is not in Vercel’s public OpenAPI catalog; validate its response and report unavailable if its shape or scope changes. Each meter fails independently. The email shows the returned range, team scope, and query time. Only a confirmed Hobby plan receives documented Hobby allowances; other or unverified plans show “Cap unverified” without percentage alerts. Validated fallback observations for the same team are dated and expire after 24 hours. Old counter-source caches are invalidated; failed syncs never refresh the observation date.
- Team Blob storage uses the provider’s `blob_storage_size` scalar average across the rolling window, compared with the 1 GB Hobby allowance. It is explicitly labeled “rolling team average”; the dashboard’s **Latest value** is a different storage measurement. Blob transfer uses `blob_data_transfer` and the 10 GB Hobby allowance. Simple/advanced operations use `blob_simple_operations` / `blob_advanced_operations` with 10,000 / 2,000 Hobby allowances. A separate connected-store size comes from `list()` and is labeled “Snapshot only”; it excludes other stores and has no quota percentage. Listing has a shared deadline and rejects incomplete pagination. `BLOB_ACCESS` applies consistently to markets, history, and usage caches. See [private storage setup](https://vercel.com/docs/vercel-blob/private-storage).
- Resend `GET /usage` requires a **full-access API key** ([provider announcement](https://resend.com/changelog/account-usage-api)). Set `RESEND_USAGE_API_KEY` to a full-access key from the same Resend account so `RESEND_API_KEY` can remain sending-only. If the usage key is omitted, reporting falls back to `RESEND_API_KEY`, which must then have full access. A 401/403 explains this requirement in the email; send authentication is unchanged. Validated responses are cached with their observation and provider reset times; fallback readings are visibly dated. Daily and monthly readings expire independently at `resets_at` and then show unavailable until refreshed. Old last-send caches lack reset times and are ignored until a successful usage fetch replaces them. Usage is collected before sending either daily email, so it excludes both deliveries. Normal daily delivery now uses two Resend sends per run. Cache failures cannot invalidate live readings or email delivery.

AI Gateway’s configured `AI_GATEWAY_MONTHLY_BUDGET` is compared with actual calendar-month spend from `getSpendReport()`, including today’s provisional usage. Credit balance and lifetime spend remain context; purchased credits never imply zero monthly spend. The configured budget is not a provider cap or guaranteed free allowance. The spend-report API requires a paid Gateway plan: on a free plan, the report retains available credit balance and lifetime spend but marks monthly spend unavailable, without a guessed percentage.

Email dates, reporting ranges, provider update times, cache observations, reset times, and Cloud Billing freshness notes use readable dates such as “6 Oct 2026, 10:00 UTC”. Stored timestamps and API parameters remain ISO strings. Older cached notes are formatted when rendered.
