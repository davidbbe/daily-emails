# Agent Dave

Daily 09:00-UTC email brief for markets, tech people, catalysts, web trends, and Reddit tops.

## What it does

Every day at **09:00 UTC** (Hobby timing may land anytime in the 09:00–09:59 window), Vercel Cron hits `/api/daily-brief`, which:

1. Pulls the last 24 hours of Google News headlines for **TSLA, MU, META, BTC, AVGO, CRCL, SPCX, MSFT**
2. Checks for speeches/announcements by **Andrej Karpathy, Jensen Huang, Alex Karp, Sam Altman**
3. Pulls previous + next earnings report dates for public tickers on the watchlist
4. Pulls Google Trends top searches (Trending Now) for:
   - **United States** — top 10 (with traffic + related news; non-English titles translated)
   - **Thailand** and **Bulgaria** — top 3 each, summarized in English (what’s rising and why; no local-language text)
   - Fetches **2×** each region’s limit, drops **Sports**-category rows, then keeps the configured top N
5. Flags topics rising in **2+ regions**
6. Pulls top Reddit posts (title, link, thumbnail when available) for configured subreddits
7. Compares against yesterday’s snapshot for **watchlist delta**
8. Summarizes with **Vercel AI Gateway** (`google/gemini-2.5-flash` by default)
9. Emails `EMAIL_TO` via **Resend** as an HTML + plain-text digest
10. Appends a **usage** section (AI Gateway credits, Blob storage, Resend quotas) and a **usage watch** for anything ≥50% of its limit
11. Saves a slim snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`)

Configurable lists live in `src/lib/config.ts` (`TICKERS`, `PEOPLE`, `TREND_REGIONS`, `REDDIT_SUBREDDITS`, `DEFAULT_MODEL`).

## What’s in the email (data + AI)

All LLM calls go through **Vercel AI Gateway** using the [AI SDK](https://ai-sdk.dev) `generateObject` helper. Default model: **`google/gemini-2.5-flash`** (override with `AI_MODEL`). No provider SDKs are wired directly — the Gateway routes the request.

| Email section | Data source (no AI) | LLM / API used |
| --- | --- | --- |
| **Theme of the day** | Markets + people + trends context | AI Gateway — one cross-cutting sentence |
| **Overnight openers** | Google News RSS — last 24h per ticker | Same core brief call — one session-context line each |
| **Markets** (TSLA, MU, META, BTC, AVGO, CRCL, SPCX, MSFT) | Google News RSS — last 24h | Core brief: 3–5 bullets with **Watch / Noise / Actionable** flags, **source links**, **why it matters**, **vs yesterday** delta |
| **Earnings & catalysts** | Stock Analysis earnings calendar (prev + next report dates) | **No LLM** — skips BTC / SPCX |
| **Speeches & announcements** | Google News RSS — last 24h per person | Core brief: one sentence each, optional **quote** + source link |
| **Regional pulse** | Trends across US / TH / BG | Synthesis call — 2–3 sentences comparing regions |
| **Web trends · United States** | Google Trends Trending Now (`geo=US`); Sports filtered | Optional translation when non-English |
| **Web trends · Thailand / Bulgaria** | Google Trends Trending Now (`geo=TH`, `geo=BG`); Sports filtered | One English summary each of the **top 3** trends and why they are rising (no item list; no local-language text) |
| **Also rising in 2+ regions** | — | **No LLM** — string match on English titles |
| **Reddit** | Reddit Atom RSS — top 5 per sub (`worldnews`, `pics`, `funny`, `photoshop`, `Photoshop_creations`, `generativeAI`, `CursedAI`, `aiArt`); day → week → hot fallback | **No LLM** — 2-column HTML layout with title, link, thumbnail |
| **Usage watch** | AI Gateway, Fast Origin Transfer, Blob size/ops, function invocations, Resend | **No LLM** — flags anything ≥50% of its Hobby/free limit |
| **Delivery** | — | **Resend API** sends HTML + plain-text email |

In practice that means **up to four** Gateway model calls per daily run:

1. One structured core brief (markets, people, overnight, flags, quotes)
2. One optional US translation pass if non-English strings appear
3. One Thailand/Bulgaria English summary pass (top 3 each)
4. One synthesis pass (theme, regional pulse, watchlist delta)

Trend fetches, snapshot I/O, and email sending do not use AI credits.

## Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill in:

| Variable                     | Required | Notes                                                                                                      |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`             | Yes      | From [Resend](https://resend.com)                                                                          |
| `EMAIL_FROM`                 | Yes      | Verified Resend domain (sent as `Cloud Agent <EMAIL_FROM>`)                                                 |
| `EMAIL_TO`                   | No       | Defaults to `streethouse4@gmail.com`                                                                       |
| `CRON_SECRET`                | Prod     | Random string; same value in Vercel env                                                                    |
| `AI_GATEWAY_API_KEY`         | Local    | From the [AI Gateway](https://vercel.com/docs/ai-gateway) dashboard; on Vercel, OIDC can work without this |
| `AI_MODEL`                   | No       | Defaults to `google/gemini-2.5-flash`                                                                      |
| `AI_GATEWAY_MONTHLY_BUDGET`  | No       | USD free-credit budget for usage watch (default `5`)                                                       |
| `RESEND_DAILY_LIMIT`         | No       | Daily email quota for usage watch (default `100`)                                                          |
| `RESEND_MONTHLY_LIMIT`       | No       | Monthly email quota for usage watch (default `3000`)                                                       |
| `BLOB_READ_WRITE_TOKEN`      | Prod*    | From a [Vercel Blob](https://vercel.com/docs/vercel-blob) store — enables durable day-over-day history     |
| `VERCEL_TOKEN`               | Prod*    | [Account token](https://vercel.com/account/tokens) for Fast Origin Transfer / platform usage via `/v2/usage` |
| `VERCEL_TEAM_ID`             | No       | Team id (defaults to `orgId` in `.vercel/project.json` when linked)                                      |

\*Without Blob, local runs still persist to `.data/previous-brief.json`. On Vercel without Blob, day-over-day sections stay empty until a store is connected.

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
2. Set env vars: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `CRON_SECRET`
3. (Recommended) Create a Blob store and set `BLOB_READ_WRITE_TOKEN` for day-over-day watchlist delta
4. Deploy to **Production** (crons only run on production)
5. Cron schedule is defined in `vercel.json`: `0 9 * * *` → `/api/daily-brief`

Optional: set `AI_MODEL` to a free-tier Gateway model slug (see below).

## Free-tier notes

- **Vercel Hobby**: up to **100 cron jobs** per project, but each may run **only once per day** (no hourly/minute schedules). Timing has a flexible **1-hour** window (e.g. `0 9 * * *` may fire anytime 09:00–09:59 UTC). This project’s 09:00 UTC schedule qualifies.
- **AI Gateway**: every Vercel team gets **$5 of monthly free credits**. Once-daily briefs on a flash/lite model usually stay well under $1/month. Credits start on the first Gateway request. Free credits only work with [Free Tier models](https://vercel.com/ai-gateway/models?freeTier=true); newer flagships (Gemini 3.x, Claude Sonnet/Opus 4+, GPT-5.4/5.5/5.6 full, Grok 4.3/4.5) are paid-only. Free-tier requests also have lower rate limits (429s are possible). **Buying AI Gateway credits ends the monthly free allowance** for that team. The daily email reports remaining balance and flags usage ≥50% of `AI_GATEWAY_MONTHLY_BUDGET` (default `$5`).
- **Fast Origin Transfer**: Hobby includes **10 GB** (rolling ~30 days). The daily email reads this from Vercel’s `/v2/usage` API when `VERCEL_TOKEN` is set (CLI auth works locally). Without a token on Vercel, it falls back to the last successful sync cached in Blob.
- **Vercel Blob**: Hobby includes **1 GB** storage, **10k** simple ops, and **2k** advanced ops. Storage size comes from `list()`; ops come from `/v2/usage`. Day-over-day snapshots and usage caches use `access: "public"` (required for public Blob stores).
- **Resend free**: 100 emails/day and 3,000/month — one daily digest is fine. Send-only API keys cannot read live quotas; the daily email caches send-response headers in Blob for the next run.

### Strongest free-tier model alternatives

Default: **`google/gemini-2.5-flash`** (also Google’s strongest free-tier chat model — Gemini 3.x is paid-only). Override with `AI_MODEL`. One strong free-tier option per maker:

| Maker | Model slug | Approx. price (in / out per 1M tokens) | Why consider it |
| --- | --- | --- | --- |
| **Google** *(default)* | `google/gemini-2.5-flash` | $0.30 / $2.50 | Best free Google option; reliable structured JSON for this brief |
| **OpenAI** | `openai/gpt-5.2` | $1.75 / $14.00 | Strongest free OpenAI general model; pricier — still fine for 1 run/day |
| **xAI** | `xai/grok-4.1-fast-reasoning` | $0.20 / $0.50 | Strongest free Grok; cheap with reasoning |
| **Anthropic** | `anthropic/claude-3-haiku` | $0.25 / $1.25 | Only Claude on free credits (newer Haiku/Sonnet/Opus are paid-only) |
| **Meta** | `meta/llama-4-maverick` | $0.24 / $0.97 | Strongest free Llama 4 instruct model |
| **DeepSeek** | `deepseek/deepseek-r1` | $1.35 / $5.40 | Strongest free DeepSeek for harder synthesis / reasoning |

Example:

```bash
AI_MODEL=openai/gpt-5.2
```

Browse the live Free Tier catalog (filters change over time): https://vercel.com/ai-gateway/models?freeTier=true
