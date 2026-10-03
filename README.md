# Daily Emails

Daily 09:00-UTC email brief for markets, tech people, catalysts, web trends, Reddit tops, and GA4 site overviews.

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
14. Collects and appends **usage** (AI Gateway credits, Blob storage, Resend usage) and a **usage watch** for capped readings ≥50% of their limit
15. Emails `EMAIL_TO` via **Resend** as an HTML + plain-text digest with a CTA to the full hosted markets page
16. After confirmed delivery, saves a slim snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`)

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

## What’s in the email (data + AI)

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
| **Google Analytics**                                      | GA4 Data API — yesterday KPIs (vs prior day), 7-day users bar chart, and month-to-date totals for `uwhmap.com`, `greetingcardfun.com`, `tvroulette.app`            | **No LLM** — skipped when `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` are unset                                                |
| **Google Cloud Billing**                                  | Costs: month-to-date (through yesterday UTC) for billing account `016802-8E2106-038F4F` covering **AI Greeting Card** and **Restaurant Roulette** — daily stacked bars by service vs the same days last month. If this month’s costs are still being priced, last 30 days instead. **API calls** are always counted from the **1st of this month** (including $0 rows) so monthly free caps (1,000 for Places Enterprise / Photos) stay on a calendar clock. | **No LLM** — BigQuery Standard usage cost export. Shows a setup card until `GCP_BILLING_BQ_TABLE` is set                         |
| **Usage watch**                                           | AI Gateway, Fast Data Transfer, Edge Requests, Blob size/ops, function invocations, Resend                                                                         | **No LLM** — flags capped usage ≥50%; Resend limits come from its usage API                                                                        |
| **Delivery**                                              | —                                                                                                                                                                  | **Resend API** sends HTML + plain-text email                                                                                    |

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

Optional. Without these env vars the brief still sends — the analytics block is omitted.

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project
2. Enable **Google Analytics Data API** and **Google Analytics Admin API**
3. Create a **service account**, download a JSON key, and copy `client_email` + `private_key` into `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`
4. In Google Analytics (as the property owner), open each account under `GA_ACCOUNTS` → **Admin → Account access management** → add the service account email as **Viewer**
5. Redeploy / restart so the env vars are available

Account IDs and email labels live in `src/lib/config.ts` (`GA_ACCOUNTS`). Each account is expected to have a single GA4 property; the Admin API resolves the property id at runtime.

### Google Cloud Billing

The email shows **month to date through yesterday UTC** (includes today on the 1st) for billing account `016802-8E2106-038F4F` (`GCP_BILLING_ACCOUNT` in `src/lib/config.ts`), which covers both **AI Greeting Card App** and **Restaurant Roulette**, compared with the same days last month. At month start, Cloud Billing often prices one service (e.g. Gemini) before another (e.g. Places). When that happens the chart uses the **last 30 days** so both projects stay visible.

**API call counts are always month to date from the 1st**, even when the cost chart is on a trailing window. That matches how Maps/Places free tiers work: Enterprise SKUs such as Nearby Search and Place Photos include **1,000 free calls per month**, then Google bills overage after month end. $0 export rows still count toward the cap.

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

`CRON_SECRET` is optional only outside production; if set, its bearer header is required in development too. This GET fetches live data, spends AI credits, saves the markets payload, and sends email. HEAD returns 405 without running the job.

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

## Validation and operations

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Tests are offline and mock provider responses. The production build needs network access for Google fonts. The scripts `scripts/send-test-email.ts` and `scripts/send-live-test-email.ts` send real email and can update shared Blob data; use them only for intentional live sends.

- News feed failures are isolated per ticker/person and labeled as unavailable, rather than a verified quiet session.
- Reddit batches, fallback windows, rate-limit waits, and retries share a 60-second budget; completed feeds survive a timeout.
- Missing Resend configuration fails before research or AI spending. A send counts as successful only when Resend returns an email ID.
- Identical email payloads share a Resend idempotency key, protecting retries within [Resend's 24-hour window](https://resend.com/docs/dashboard/emails/idempotency-keys). Regenerating a new brief changes the payload; this is not a distributed lock or a guarantee of one run per calendar day.
- Markets persistence is best-effort before sending, so the CTA can load immediately. History is updated only after delivery. Missing Blob on Vercel leaves the markets page empty and history unavailable.
- GA4 always reports property-local yesterday, including zero activity, with a provisional-data note. Recent values can change during processing; zero activity is not treated as proof of a delay.
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
- Platform usage requires `VERCEL_TOKEN` on Vercel; local runs may use the authenticated Vercel CLI. Without live access, the email can use the last successful Blob cache.
- Blob storage size comes from `list()`; operation counts come from platform usage. `BLOB_ACCESS` applies consistently to markets, history, and usage caches. See [private storage setup](https://vercel.com/docs/vercel-blob/private-storage).
- Resend `GET /usage` supports sending-only keys. Validated responses are cached with their observation and provider reset times; fallback readings are visibly dated. Daily and monthly readings expire independently at `resets_at` and then show unavailable until refreshed. Old last-send caches lack reset times and are ignored until a successful usage fetch replaces them. Usage is collected before sending this digest, so it excludes that delivery. Cache failures cannot invalidate live readings or email delivery.
