# Daily Emails

Daily 09:00-UTC email brief for markets, tech people, catalysts, web trends, Reddit tops, and GA4 site overviews.

## What it does

Every day at **09:00 UTC** (Hobby timing may land anytime in the 09:00–09:59 window), Vercel Cron hits `/api/daily-brief`, which:

1. Pulls the last 24 hours of Google News headlines for **TSLA, MU, META, BTC, AVGO, CRCL, SPCX, MSFT**
2. Checks for speeches/announcements by **Andrej Karpathy, Jensen Huang, Alex Karp, Sam Altman, Elon Musk, Donald Trump** — only names with a market-moving remark are included. Musk/Trump use their own last-24h posts (X / Truth Social) and can include **two** items each
3. Pulls previous + next earnings report dates for public tickers on the watchlist
4. Pulls **Fear & greed** meters (CNN equities, Crypto Alternative.me, VIX) plus a per-ticker greed proxy (52-week range + RSI)
5. Pulls **open-market Form 4 buys and sells** from [OpenInsider](http://openinsider.com/) filed in the last 24 hours (officer-weighted, watchlist hits, clustered buys)
6. Pulls **superinvestor 13F activity** from [Dataroma](https://www.dataroma.com/m/home.php) (clustered buys, notable adds, recent Form 4) and writes a short whale briefing
7. Pulls Google Trends top searches (Trending Now) for:
   - **United States** — top 10 (with traffic + related news; non-English titles translated)
   - **Thailand** — a pool of rising searches, then the **3 most important** items with English titles and 1–2 sentence descriptions (no local-language text)
   - Fetches **2×** each region’s limit, drops **Sports**-category rows, then keeps the configured top N
8. Flags topics rising in **2+ regions**
9. Pulls top Reddit posts (title, link, thumbnail when available) for configured subreddits
10. Pulls **GA4** yesterday + 7-day trend + month-to-date overviews for configured sites (when a service account is set), plus **Google Cloud Billing** month-to-date (through yesterday UTC)
11. Loads yesterday’s slim snapshot (when available) for day-over-day history
12. Summarizes with **Vercel AI Gateway** (`google/gemini-2.5-flash` by default)
13. Saves a **markets brief** payload for the secret hosted page (Blob when configured, otherwise `.data/markets-latest.json`)
14. Emails `EMAIL_TO` via **Resend** as an HTML + plain-text digest with a CTA to the full hosted markets page
15. Appends a **usage** section (AI Gateway credits, Blob storage, Resend quotas) and a **usage watch** for anything ≥50% of its limit
16. Saves a slim day-over-day snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`)

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

## What’s in the email (data + AI)

All LLM calls go through **Vercel AI Gateway** using the [AI SDK](https://ai-sdk.dev) `generateObject` helper. Default model: **`google/gemini-2.5-flash`** (override with `AI_MODEL`). No provider SDKs are wired directly — the Gateway routes the request.

| Email / page section                                      | Data source (no AI)                                                                                                                                                | LLM / API used                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Session context** _(hosted watchlist)_                  | Google News RSS — last 24h per ticker                                                                                                                              | Same core brief call — one pre-market / after-hours / crypto-session line inside each related ticker card                       |
| **Full markets brief CTA** _(email → hosted page)_        | Link built from `APP_BASE_URL` + `MARKETS_PAGE_SECRET`                                                                                                             | **No LLM**                                                                                                                      |
| **Fear & greed** _(hosted page)_                          | CNN F&G, Alternative.me Crypto F&G, VIX via feargreedchart; equities via Stock Analysis (52w + RSI14); BTC via CoinGecko                                           | **No LLM** — value dial + Lean buy / Neutral / Patience stance per ticker (SPCX skipped — private)                              |
| **Insider trades** _(hosted page)_                        | [OpenInsider](http://openinsider.com/) SEC Form 4 open-market P/S filed in the last 24 hours (buys $25k+, sells $100k+; clusters + watchlist)                      | **No LLM** — tables stay data-backed. Falls back to the latest filing day on weekends / Monday 09:00 UTC.                       |
| **Whale watch** _(hosted page)_                           | [Dataroma](https://www.dataroma.com/m/home.php) superinvestor 13Fs (clustered buys, manager adds) + Form 4 realtime buys                                           | AI Gateway — briefing, sector themes, watchlist overlap. Tables stay data-backed. 13Fs lag up to 45 days.                       |
| **Markets + TradingView** _(hosted page)_                 | Google News RSS — last 24h; charts via TradingView embeds (`tradingViewSymbol` in config)                                                                          | Core brief: 3–5 bullets with **Watch / Noise / Actionable** flags, **source links**, **why it matters**                         |
| **Earnings & catalysts** _(hosted page)_                  | Stock Analysis earnings calendar (prev + next report dates)                                                                                                        | **No LLM** — skips BTC / SPCX                                                                                                   |
| **Speeches & announcements** _(email)_                    | Google News RSS — last 24h per person; **Elon Musk** via FxTwitter timeline, **Donald Trump** via trumpstruth.org RSS (own posts, last 24h)                         | Core brief: reviews all items; Musk/Trump keep **up to two** market/crypto-moving posts with original-post links; others keep **one** or are omitted |
| **Web trends · United States**                            | Google Trends Trending Now (`geo=US`); Sports filtered                                                                                                             | Optional translation when non-English                                                                                           |
| **Web trends · Thailand**                                 | Google Trends Trending Now (`geo=TH`); Sports filtered                                                                                                             | English title + 1–2 sentence description for the **3 most important** items (no local-language text)                            |
| **Also rising in 2+ regions**                             | —                                                                                                                                                                  | **No LLM** — string match on English titles                                                                                     |
| **Reddit**                                                | Reddit Atom RSS — top 6 per sub (`pics`, `generativeAI`, `CursedAI`, `aiArt`); day → week → hot fallback | **No LLM** — subreddits in 2 columns; posts in a 3-column grid with larger thumbnails                                           |
| **Google Analytics**                                      | GA4 Data API — yesterday KPIs (vs prior day), 7-day users bar chart, and month-to-date totals for `uwhmap.com`, `greetingcardfun.com`, `tvroulette.app`            | **No LLM** — skipped when `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` are unset                                                |
| **Google Cloud Billing**                                  | Costs: month-to-date (through yesterday UTC) for billing account `016802-8E2106-038F4F` covering **AI Greeting Card** and **Restaurant Roulette** — daily stacked bars by service vs the same days last month. If this month’s costs are still being priced, last 30 days instead. **API calls** are always counted from the **1st of this month** (including $0 rows) so monthly free caps (1,000 for Places Enterprise / Photos) stay on a calendar clock. | **No LLM** — BigQuery Standard usage cost export. Shows a setup card until `GCP_BILLING_BQ_TABLE` is set                         |
| **Usage watch**                                           | AI Gateway, Fast Data Transfer, Edge Requests, Blob size/ops, function invocations, Resend                                                                         | **No LLM** — flags anything ≥50% of its Hobby/free limit                                                                        |
| **Delivery**                                              | —                                                                                                                                                                  | **Resend API** sends HTML + plain-text email                                                                                    |

In practice that means **up to four** Gateway model calls per daily run:

1. One structured core brief (markets, people, overnight, flags, quotes)
2. One optional US translation pass if non-English strings appear
3. One Thailand English pass (pick 3 most important items + descriptions)
4. One whale-watch briefing (superinvestor 13F / Form 4 themes)

Trend fetches, snapshot I/O, and email sending do not use AI credits.

## Setup

1. Copy env template:

```bash
cp .env.example .env
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
| `AI_MODEL`                  | No       | Defaults to `google/gemini-2.5-flash`                                                                        |
| `AI_GATEWAY_MONTHLY_BUDGET` | No       | USD free-credit budget for usage watch (default `5`)                                                         |
| `RESEND_DAILY_LIMIT`        | No       | Daily email quota for usage watch (default `100`)                                                            |
| `RESEND_MONTHLY_LIMIT`      | No       | Monthly email quota for usage watch (default `3000`)                                                         |
| `BLOB_READ_WRITE_TOKEN`     | Prod\*   | From a [Vercel Blob](https://vercel.com/docs/vercel-blob) store — enables durable day-over-day history       |
| `VERCEL_TOKEN`              | Prod\*   | [Account token](https://vercel.com/account/tokens) for Fast Data Transfer / platform usage via `/v2/usage` |
| `VERCEL_TEAM_ID`            | No       | Team id (defaults to `orgId` in `.vercel/project.json` when linked)                                          |
| `GOOGLE_CLIENT_EMAIL`       | No       | GCP service account email for the **Google Analytics** and **Cloud Billing** sections                        |
| `GOOGLE_PRIVATE_KEY`        | No       | Service account private key (PEM; literal `\n` newlines are fine)                                            |
| `GCP_BILLING_ACCOUNT_ID`    | No       | Cloud Billing account id (default `016802-8E2106-038F4F`)                                                    |
| `GCP_BILLING_BQ_TABLE`      | Billing* | BigQuery export table `project.dataset.gcp_billing_export_v1_016802_8E2106_038F4F` (jobs run in the table’s project) |
| `GOOGLE_CLOUD_PROJECT`      | No       | Fallback GCP project for table discovery if `GCP_BILLING_BQ_TABLE` is unset                                 |
| `GCP_BILLING_BQ_JOB_PROJECT`| No       | Project that runs the billing query job (defaults to the table’s project)                                    |

\*Without Blob, local runs still persist to `.data/previous-brief.json` and `.data/markets-latest.json`. On Vercel without Blob, day-over-day sections and the hosted markets page stay empty until a store is connected. `APP_BASE_URL` is recommended in production so the email CTA always points at your canonical domain.

### Google Analytics

Optional. Without these env vars the brief still sends — the analytics block is omitted.

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project
2. Enable **Google Analytics Data API** and **Google Analytics Admin API**
3. Create a **service account**, download a JSON key, and copy `client_email` + `private_key` into `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`
4. In Google Analytics (as the property owner), open each account under `GA_ACCOUNTS` → **Admin → Account access management** → add the service account email as **Viewer**
5. Redeploy / restart so the env vars are available

Account IDs and email labels live in `src/lib/config.ts` (`GA_ACCOUNTS`). Each account is expected to have a single GA4 property; the Admin API resolves the property id at runtime.

### Google Cloud Billing

The email shows **month to date through yesterday UTC** for billing account `016802-8E2106-038F4F` (`GCP_BILLING_ACCOUNT` in `src/lib/config.ts`), which covers both **AI Greeting Card App** and **Restaurant Roulette**, compared with the same days last month. At month start, Cloud Billing often prices one service (e.g. Gemini) before another (e.g. Places). When that happens the chart uses the **last 30 days** so both projects stay visible.

**API call counts are always month to date from the 1st**, even when the cost chart is on a trailing window. That matches how Maps/Places free tiers work: Enterprise SKUs such as Nearby Search and Place Photos include **1,000 free calls per month**, then Google bills overage after month end. $0 export rows still count toward the cap.

Restaurant Roulette billing and the daily-emails service account are on **different Google accounts**. The export must land in a project **linked to billing account `016802-8E2106-038F4F`**, then that dataset is shared with `GOOGLE_CLIENT_EMAIL`.

1. On the Restaurant Roulette login, pick a project already billed to that account (or create `billing-export` and link it)
2. In [BigQuery](https://console.cloud.google.com/bigquery), create dataset `billing_export` with location **US** (multi-region, so current + previous month backfill). Leave table expiration off
3. [Billing export](https://console.cloud.google.com/billing/016802-8E2106-038F4F) → **BigQuery export** → enable **Standard usage cost** → that project + `billing_export`
4. Dataset **Sharing** → add `GOOGLE_CLIENT_EMAIL` as **BigQuery Data Viewer**
5. On the export project (AI Greeting Card App), grant that same email **BigQuery Job User**
6. Set `GCP_BILLING_BQ_TABLE=YOUR_PROJECT.billing_export.gcp_billing_export_v1_016802_8E2106_038F4F` locally and on Vercel

Until the table is readable, the email shows a short setup card instead of the chart. First US-region backfill can take up to five days.

3. Install and run locally:

```bash
npm install
npm run dev
```

4. Trigger once (dev, no cron secret required):

```bash
curl http://localhost:3000/api/daily-brief
```

In production, call with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/daily-brief
```

## Deploy on Vercel (Hobby / free)

1. Push to GitHub and import the project in Vercel
2. Set env vars: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `CRON_SECRET`, `MARKETS_PAGE_SECRET`, and preferably `APP_BASE_URL`
3. (Recommended) Create a Blob store and set `BLOB_READ_WRITE_TOKEN` for durable day-over-day + markets-page history
4. Deploy to **Production** (crons only run on production)
5. Cron schedule is defined in `vercel.json`: `0 9 * * *` → `/api/daily-brief`
6. After the first successful run, open `/markets/<MARKETS_PAGE_SECRET>`

Optional: set `AI_MODEL` to a free-tier Gateway model slug (see below).

## Free-tier notes

- **Vercel Hobby**: up to **100 cron jobs** per project, but each may run **only once per day** (no hourly/minute schedules). Timing has a flexible **1-hour** window (e.g. `0 9 * * *` may fire anytime 09:00–09:59 UTC). This project’s 09:00 UTC schedule qualifies.
- **AI Gateway**: every Vercel team gets **$5 of monthly free credits**. Once-daily briefs on a flash/lite model usually stay well under $1/month. Credits start on the first Gateway request. Free credits only work with [Free Tier models](https://vercel.com/ai-gateway/models?freeTier=true); newer flagships (Gemini 3.x, Claude Sonnet/Opus 4+, GPT-5.4/5.5/5.6 full, Grok 4.3/4.5) are paid-only. Free-tier requests also have lower rate limits (429s are possible). **Buying AI Gateway credits ends the monthly free allowance** for that team. The daily email reports remaining balance and flags usage ≥50% of `AI_GATEWAY_MONTHLY_BUDGET` (default `$5`).
- **Fast Data Transfer**: Hobby includes **100 GB** (rolling ~30 days). The daily email reads this from Vercel’s `/v2/usage` `bandwidth_*` fields when `VERCEL_TOKEN` is set (CLI auth works locally). That API does **not** expose Fast Origin Transfer on Hobby — the dashboard 10 GB FOT line is a different metric. Without a token on Vercel, the email falls back to the last successful sync cached in Blob.
- **Vercel Blob**: Hobby includes **1 GB** storage, **10k** simple ops, and **2k** advanced ops. Storage size comes from `list()`; ops come from `/v2/usage`. Day-over-day snapshots and usage caches use `access: "public"` (required for public Blob stores).
- **Resend free**: 100 emails/day and 3,000/month — one daily digest is fine. Send-only API keys cannot read live quotas; the daily email caches send-response headers in Blob for the next run.

### Strongest free-tier model alternatives

Default: **`google/gemini-2.5-flash`** (also Google’s strongest free-tier chat model — Gemini 3.x is paid-only). Override with `AI_MODEL`. One strong free-tier option per maker:

| Maker                  | Model slug                    | Approx. price (in / out per 1M tokens) | Why consider it                                                         |
| ---------------------- | ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| **Google** _(default)_ | `google/gemini-2.5-flash`     | $0.30 / $2.50                          | Best free Google option; reliable structured JSON for this brief        |
| **OpenAI**             | `openai/gpt-5.2`              | $1.75 / $14.00                         | Strongest free OpenAI general model; pricier — still fine for 1 run/day |
| **xAI**                | `xai/grok-4.1-fast-reasoning` | $0.20 / $0.50                          | Strongest free Grok; cheap with reasoning                               |
| **Anthropic**          | `anthropic/claude-3-haiku`    | $0.25 / $1.25                          | Only Claude on free credits (newer Haiku/Sonnet/Opus are paid-only)     |
| **Meta**               | `meta/llama-4-maverick`       | $0.24 / $0.97                          | Strongest free Llama 4 instruct model                                   |
| **DeepSeek**           | `deepseek/deepseek-r1`        | $1.35 / $5.40                          | Strongest free DeepSeek for harder synthesis / reasoning                |

Example:

```bash
AI_MODEL=openai/gpt-5.2
```

Browse the live Free Tier catalog (filters change over time): https://vercel.com/ai-gateway/models?freeTier=true
