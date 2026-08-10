# Daily Emails

Daily 09:00-UTC email brief for markets, tech people, catalysts, web trends, Reddit tops, and GA4 site overviews.

## What it does

Every day at **09:00 UTC** (Hobby timing may land anytime in the 09:00–09:59 window), Vercel Cron hits `/api/daily-brief`, which:

1. Pulls the last 24 hours of Google News headlines for **TSLA, MU, META, BTC, AVGO, CRCL, SPCX, MSFT**
2. Checks for speeches/announcements by **Andrej Karpathy, Jensen Huang, Alex Karp, Sam Altman**
3. Pulls previous + next earnings report dates for public tickers on the watchlist
4. Pulls **Fear & greed** meters (CNN equities, Crypto Alternative.me, VIX) plus a per-ticker greed proxy (52-week range + RSI)
5. Pulls Google Trends top searches (Trending Now) for:
   - **United States** — top 10 (with traffic + related news; non-English titles translated)
   - **Thailand** and **Bulgaria** — top 3 each, summarized in English (what’s rising and why; no local-language text)
   - Fetches **2×** each region’s limit, drops **Sports**-category rows, then keeps the configured top N
6. Flags topics rising in **2+ regions**
7. Pulls top Reddit posts (title, link, thumbnail when available) for configured subreddits
8. Pulls **GA4** yesterday + 7-day trend + month-to-date overviews for configured sites (when a service account is set)
9. Loads yesterday’s slim snapshot (when available) as synthesis context
10. Summarizes with **Vercel AI Gateway** (`google/gemini-2.5-flash` by default)
11. Saves a **markets brief** payload for the secret hosted page (Blob when configured, otherwise `.data/markets-latest.json`)
12. Emails `EMAIL_TO` via **Resend** as an HTML + plain-text digest (Overnight stays in-email; full markets live on the hosted page)
13. Appends a **usage** section (AI Gateway credits, Blob storage, Resend quotas) and a **usage watch** for anything ≥50% of its limit
14. Saves a slim day-over-day snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`)

Configurable lists live in `src/lib/config.ts` (`TICKERS`, `PEOPLE`, `TREND_REGIONS`, `REDDIT_SUBREDDITS`, `GA_ACCOUNTS`, `DEFAULT_MODEL`).

## Hosted markets page

Fear & greed, watchlist notes, greed proxies, **TradingView** charts, and earnings render at a **secret URL**:

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
| **Theme of the day** _(email)_                            | Markets + people + trends + sentiment context                                                                                                                      | AI Gateway — one cross-cutting sentence                                                                                         |
| **Overnight openers** _(email)_                           | Google News RSS — last 24h per ticker                                                                                                                              | Same core brief call — one session-context line each                                                                            |
| **Full markets brief CTA** _(email → hosted page)_        | Link built from `APP_BASE_URL` + `MARKETS_PAGE_SECRET`                                                                                                             | **No LLM**                                                                                                                      |
| **Fear & greed** _(hosted page)_                          | CNN F&G, Alternative.me Crypto F&G, VIX via feargreedchart; equities via Stock Analysis (52w + RSI14); BTC via CoinGecko                                           | **No LLM** — value dial + Lean buy / Neutral / Patience stance per ticker (SPCX skipped — private)                              |
| **Markets + TradingView** _(hosted page)_                 | Google News RSS — last 24h; charts via TradingView embeds (`tradingViewSymbol` in config)                                                                          | Core brief: 3–5 bullets with **Watch / Noise / Actionable** flags, **source links**, **why it matters**                         |
| **Earnings & catalysts** _(hosted page)_                  | Stock Analysis earnings calendar (prev + next report dates)                                                                                                        | **No LLM** — skips BTC / SPCX                                                                                                   |
| **Speeches & announcements** _(email)_                    | Google News RSS — last 24h per person                                                                                                                              | Core brief: one sentence each, optional **quote** + source link                                                                 |
| **Regional pulse**                                        | Trends across US / TH / BG                                                                                                                                         | Synthesis call — 2–3 sentences comparing regions                                                                                |
| **Web trends · United States**                            | Google Trends Trending Now (`geo=US`); Sports filtered                                                                                                             | Optional translation when non-English                                                                                           |
| **Web trends · Thailand / Bulgaria**                      | Google Trends Trending Now (`geo=TH`, `geo=BG`); Sports filtered                                                                                                   | One English summary each of the **top 3** trends and why they are rising (no item list; no local-language text)                 |
| **Also rising in 2+ regions**                             | —                                                                                                                                                                  | **No LLM** — string match on English titles                                                                                     |
| **Reddit**                                                | Reddit Atom RSS — top 6 per sub (`pics`, `generativeAI`, `CursedAI`, `aiArt`); day → week → hot fallback | **No LLM** — subreddits in 2 columns; posts in a 3-column grid with larger thumbnails                                           |
| **Google Analytics**                                      | GA4 Data API — yesterday KPIs (vs prior day), 7-day users bar chart, and month-to-date totals for `uwhmap.com`, `greetingcardfun.com`, `tvroulette.app`            | **No LLM** — skipped when `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` are unset                                                |
| **Usage watch**                                           | AI Gateway, Fast Origin Transfer, Blob size/ops, function invocations, Resend                                                                                      | **No LLM** — flags anything ≥50% of its Hobby/free limit                                                                        |
| **Delivery**                                              | —                                                                                                                                                                  | **Resend API** sends HTML + plain-text email                                                                                    |

In practice that means **up to four** Gateway model calls per daily run:

1. One structured core brief (markets, people, overnight, flags, quotes)
2. One optional US translation pass if non-English strings appear
3. One Thailand/Bulgaria English summary pass (top 3 each)
4. One synthesis pass (theme, regional pulse)

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
| `VERCEL_TOKEN`              | Prod\*   | [Account token](https://vercel.com/account/tokens) for Fast Origin Transfer / platform usage via `/v2/usage` |
| `VERCEL_TEAM_ID`            | No       | Team id (defaults to `orgId` in `.vercel/project.json` when linked)                                          |
| `GOOGLE_CLIENT_EMAIL`       | No       | GCP service account email for the **Google Analytics** section                                               |
| `GOOGLE_PRIVATE_KEY`        | No       | Service account private key (PEM; literal `\n` newlines are fine)                                            |

\*Without Blob, local runs still persist to `.data/previous-brief.json` and `.data/markets-latest.json`. On Vercel without Blob, day-over-day sections and the hosted markets page stay empty until a store is connected. `APP_BASE_URL` is recommended in production so the email CTA always points at your canonical domain.

### Google Analytics

Optional. Without these env vars the brief still sends — the analytics block is omitted.

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project
2. Enable **Google Analytics Data API** and **Google Analytics Admin API**
3. Create a **service account**, download a JSON key, and copy `client_email` + `private_key` into `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`
4. In Google Analytics (as the property owner), open each account under `GA_ACCOUNTS` → **Admin → Account access management** → add the service account email as **Viewer**
5. Redeploy / restart so the env vars are available

Account IDs and email labels live in `src/lib/config.ts` (`GA_ACCOUNTS`). Each account is expected to have a single GA4 property; the Admin API resolves the property id at runtime.

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
- **Fast Origin Transfer**: Hobby includes **10 GB** (rolling ~30 days). The daily email reads this from Vercel’s `/v2/usage` API when `VERCEL_TOKEN` is set (CLI auth works locally). Without a token on Vercel, it falls back to the last successful sync cached in Blob.
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
