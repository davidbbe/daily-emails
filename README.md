# Agent Dave

Daily noon-UTC email brief for markets, tech people, catalysts, and web trends.

## What it does

Every day at **12:00 UTC** (Hobby timing may land anytime in the 12:00–12:59 window), Vercel Cron hits `/api/daily-brief`, which:

1. Pulls the last 24 hours of Google News headlines for **TSLA, MU, META, BTC**
2. Checks for speeches/announcements by **Andrej Karpathy, Jensen Huang, Alex Karp, Sam Altman**
3. Pulls catalyst/earnings headlines for the watchlist over the last **7 days**
4. Pulls Google Trends top searches for:
   - **United States** — top 10 (with traffic + related news; non-English titles translated)
   - **Thailand** and **Bulgaria** — top 5 each (English labels + short descriptions, traffic badges, news links)
5. Flags topics rising in **2+ regions**
6. Compares against yesterday’s snapshot for **trend movers** and **watchlist delta**
7. Summarizes with **Vercel AI Gateway** (`google/gemini-2.5-flash` by default)
8. Emails `EMAIL_TO` via **Resend** as an HTML + plain-text digest
9. Saves a slim snapshot (Vercel Blob when configured, otherwise `.data/previous-brief.json`)

Configurable lists live in `src/lib/config.ts` (`TICKERS`, `PEOPLE`, `TREND_REGIONS`, `DEFAULT_MODEL`).

## What’s in the email (data + AI)

All LLM calls go through **Vercel AI Gateway** using the [AI SDK](https://ai-sdk.dev) `generateObject` helper. Default model: **`google/gemini-2.5-flash`** (override with `AI_MODEL`). No provider SDKs are wired directly — the Gateway routes the request.

| Email section | Data source (no AI) | LLM / API used |
| --- | --- | --- |
| **Theme of the day** | Markets + people + trends context | AI Gateway — one cross-cutting sentence |
| **Overnight openers** | Google News RSS — last 24h per ticker | Same core brief call — one session-context line each |
| **Markets** (TSLA, MU, META, BTC) | Google News RSS — last 24h | Core brief: 3–5 bullets with **Watch / Noise / Actionable** flags, **source links**, **why it matters**, **vs yesterday** delta |
| **Earnings & catalysts** | Google News RSS — last 7d catalyst queries | Core brief extracts only explicitly mentioned dated events |
| **Speeches & announcements** | Google News RSS — last 24h per person | Core brief: one sentence each, optional **quote** + source link |
| **Regional pulse** | Trends across US / TH / BG | Synthesis call — 2–3 sentences comparing regions |
| **Web trends · United States** | Google Trends RSS (`geo=US`) | Optional translation when non-English |
| **Web trends · Thailand / Bulgaria** | Google Trends RSS (`geo=TH`, `geo=BG`) | Localize + short description; email shows **traffic + news links** |
| **Also rising in 2+ regions** | — | **No LLM** — string match on English titles |
| **Trend movers** | Previous brief snapshot | **No LLM** — new today / still rising / fell off |
| **Delivery** | — | **Resend API** sends HTML + plain-text email |

In practice that means **up to four** Gateway model calls per daily run:

1. One structured core brief (markets, people, earnings, overnight, flags, quotes)
2. One optional US translation pass if non-English strings appear
3. One Thailand/Bulgaria localize-and-describe pass
4. One synthesis pass (theme, regional pulse, watchlist delta)

RSS fetches, day-over-day trend diffs, snapshot I/O, and email sending do not use AI credits.

## Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill in:

| Variable                 | Required | Notes                                                                                                      |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`         | Yes      | From [Resend](https://resend.com)                                                                          |
| `EMAIL_FROM`             | Yes      | Verified Resend domain (sent as `Agent Dave <EMAIL_FROM>`)                                                 |
| `EMAIL_TO`               | No       | Defaults to `streethouse4@gmail.com`                                                                       |
| `CRON_SECRET`            | Prod     | Random string; same value in Vercel env                                                                    |
| `AI_GATEWAY_API_KEY`     | Local    | From the [AI Gateway](https://vercel.com/docs/ai-gateway) dashboard; on Vercel, OIDC can work without this |
| `AI_MODEL`               | No       | Defaults to `google/gemini-2.5-flash`                                                                      |
| `BLOB_READ_WRITE_TOKEN`  | Prod*    | From a [Vercel Blob](https://vercel.com/docs/vercel-blob) store — enables durable day-over-day history     |

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
3. (Recommended) Create a Blob store and set `BLOB_READ_WRITE_TOKEN` for day-over-day movers / watchlist delta
4. Deploy to **Production** (crons only run on production)
5. Cron schedule is defined in `vercel.json`: `0 12 * * *` → `/api/daily-brief`

Optional: set `AI_MODEL` to any free-tier Gateway model slug.

## Free-tier notes

- **Vercel Hobby**: up to **100 cron jobs** per project, but each may run **only once per day** (no hourly/minute schedules). Timing has a flexible **1-hour** window (e.g. `0 12 * * *` may fire anytime 12:00–12:59 UTC). This project’s noon schedule qualifies.
- **Resend free**: 100 emails/day — one daily digest is fine
- **AI Gateway**: every Vercel team gets **$5 of monthly free credits** that AI Gateway uses. That is more than enough for this once-daily brief on a lite/flash model. Credits start on first Gateway request; buying paid credits moves you off the monthly free allowance. Monitor usage in the AI Gateway dashboard.
- **Vercel Blob**: free tier is enough for one small JSON snapshot overwritten daily
