import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectSiteAnalytics,
  type SiteAnalytics,
} from "@/lib/analytics";
import type { DailyBrief } from "@/lib/brief";
import { GA_ACCOUNTS } from "@/lib/config";
import { sendBriefEmail } from "@/lib/email";
import { saveMarketsBrief, toMarketsBrief } from "@/lib/markets-brief";
import { collectRedditTops } from "@/lib/reddit";
import { collectUsageReport } from "@/lib/usage";

function demoDailySeries(baseUsers: number): SiteAnalytics["dailySeries"] {
  const pattern = [0.72, 0.8, 0.68, 0.95, 1.05, 0.88, 1];
  return pattern.map((factor, i) => {
    const users = Math.round(baseUsers * factor);
    return {
      date: new Date(Date.UTC(2026, 6, 26 + i)).toISOString().slice(0, 10),
      activeUsers: users,
      sessions: users + 15,
      screenPageViews: users * 3,
    };
  });
}

function demoSites(): SiteAnalytics[] {
  return GA_ACCOUNTS.map((account, index) => {
    const users = 120 + index * 40;
    const prevUsers = 100 + index * 35;
    return {
      accountId: account.accountId,
      propertyId: `100000${index}`,
      label: account.label,
      date: "2026-08-01",
      previousDate: "2026-07-31",
      monthStart: "2026-08-01",
      metrics: {
        activeUsers: users,
        sessions: users + 20,
        screenPageViews: users * 3,
        bounceRate: 0.42 + index * 0.05,
        averageSessionDuration: 95 + index * 25,
      },
      previous: {
        activeUsers: prevUsers,
        sessions: prevUsers + 15,
        screenPageViews: prevUsers * 3,
        bounceRate: 0.4,
        averageSessionDuration: 90,
      },
      monthToDate: {
        activeUsers: users * 8,
        sessions: (users + 20) * 8,
        screenPageViews: users * 3 * 8,
        bounceRate: 0.4,
        averageSessionDuration: 100,
      },
      dailySeries: demoDailySeries(users),
    };
  });
}

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), filename), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env) || filename.endsWith(".local")) {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const brief: DailyBrief = {
  tickers: [
    {
      id: "TSLA",
      label: "Tesla (TSLA)",
      bullets: [
        { text: "Test bullet for email layout review.", flag: "Watch" },
      ],
      whyItMatters:
        "Placeholder — full AI brief skipped due to Gateway rate limit.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "MU",
      label: "Micron (MU)",
      bullets: [{ text: "Placeholder Micron note.", flag: "Noise" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "META",
      label: "Meta (META)",
      bullets: [{ text: "Placeholder Meta note.", flag: "Actionable" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "BTC",
      label: "Bitcoin (BTC)",
      bullets: [{ text: "Placeholder BTC note.", flag: "Watch" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "AVGO",
      label: "Broadcom (AVGO)",
      bullets: [{ text: "Placeholder Broadcom note.", flag: "Watch" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "CRCL",
      label: "Circle (CRCL)",
      bullets: [{ text: "Placeholder Circle note.", flag: "Noise" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "SPCX",
      label: "SpaceX (SPCX)",
      bullets: [{ text: "Placeholder SpaceX note.", flag: "Watch" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "MSFT",
      label: "Microsoft (MSFT)",
      bullets: [{ text: "Placeholder Microsoft note.", flag: "Actionable" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
    {
      id: "WQTM",
      label: "WisdomTree Quantum (WQTM)",
      bullets: [{ text: "Placeholder WQTM note.", flag: "Watch" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
    },
  ],
  people: [
    { id: "karpathy", name: "Andrej Karpathy", summary: "None found" },
    {
      id: "huang",
      name: "Jensen Huang",
      summary:
        "Huang said NVIDIA is seeing stronger-than-expected data-center demand, a remark that could lift AI-chip names.",
      quote: "Demand for AI infrastructure continues to exceed supply.",
      sourceUrl: "https://example.com/huang",
    },
    { id: "karp", name: "Alex Karp", summary: "None found" },
    { id: "altman", name: "Sam Altman", summary: "None found" },
    {
      id: "musk",
      name: "Elon Musk",
      summary:
        "Musk said Tesla will expand robotaxi service next month, which could reprice TSLA and related autonomy names.",
      quote: "Robotaxi will be in more cities next month.",
      sourceUrl: "https://example.com/musk",
    },
    {
      id: "trump",
      name: "Donald Trump",
      summary:
        "Trump said he would raise auto tariffs, a statement that could move auto, steel, and import-sensitive stocks.",
      quote: "We're putting a very big tariff on cars.",
      sourceUrl: "https://example.com/trump",
    },
  ],
  earningsCalendar: [
    {
      tickerId: "TSLA",
      label: "Tesla (TSLA)",
      previousDate: "2026-07-22",
      nextDate: "2026-10-21",
      nextConfirmed: false,
    },
    {
      tickerId: "MU",
      label: "Micron (MU)",
      previousDate: "2026-06-24",
      nextDate: "2026-09-22",
      nextConfirmed: false,
    },
    {
      tickerId: "META",
      label: "Meta (META)",
      previousDate: "2026-07-29",
      nextDate: "2026-10-28",
      nextConfirmed: false,
    },
  ],
  regionalPulse: "",
  trends: {
    regions: [],
    crossRegion: [],
  },
  reddit: [],
  sites: [],
  sentiment: {
    collectedAt: new Date().toISOString(),
    valueDial: "",
    meters: [
      {
        id: "cnn",
        label: "Stocks Fear & Greed",
        value: 60,
        band: "Greed",
        changeDay: 0.7,
        changeWeek: 19.7,
        sourceUrl: "https://www.cnn.com/markets/fear-and-greed",
      },
      {
        id: "crypto",
        label: "Crypto Fear & Greed",
        value: 25,
        band: "Extreme Fear",
        changeDay: -2,
        changeWeek: -3,
        sourceUrl: "https://alternative.me/crypto/fear-and-greed-index/",
      },
      {
        id: "vix",
        label: "VIX",
        value: 15.85,
        band: "Greed",
        changeDay: 0.04,
        sourceUrl: "https://www.cboe.com/tradable_products/vix/",
      },
    ],
    tickers: [
      {
        tickerId: "TSLA",
        label: "Tesla (TSLA)",
        price: 321.55,
        drawdownFromHighPct: -35.5,
        rangePositionPct: 12,
        rsi14: 26.2,
        score: 19,
        band: "Extreme Fear",
        stance: "Lean buy",
      },
      {
        tickerId: "MU",
        label: "Micron (MU)",
        price: 120,
        drawdownFromHighPct: -8.2,
        rangePositionPct: 72,
        rsi14: 58,
        score: 65,
        band: "Greed",
        stance: "Patience",
      },
      {
        tickerId: "META",
        label: "Meta (META)",
        price: 612.4,
        drawdownFromHighPct: -18.1,
        rangePositionPct: 48,
        rsi14: 44.5,
        score: 46,
        band: "Neutral",
        stance: "Neutral",
      },
      {
        tickerId: "BTC",
        label: "Bitcoin (BTC)",
        price: 68450,
        drawdownFromHighPct: -22.4,
        rangePositionPct: 38,
        rsi14: 41.2,
        score: 40,
        band: "Fear",
        stance: "Lean buy",
      },
      {
        tickerId: "AVGO",
        label: "Broadcom (AVGO)",
        price: 298.1,
        drawdownFromHighPct: -5.4,
        rangePositionPct: 81,
        rsi14: 62.8,
        score: 72,
        band: "Greed",
        stance: "Patience",
      },
      {
        tickerId: "CRCL",
        label: "Circle (CRCL)",
        price: 84.2,
        drawdownFromHighPct: -12.6,
        rangePositionPct: 55,
        rsi14: 51.3,
        score: 53,
        band: "Neutral",
        stance: "Neutral",
      },
      {
        tickerId: "SPCX",
        label: "SpaceX (SPCX)",
        error: "No public quote (private / unlisted)",
      },
      {
        tickerId: "MSFT",
        label: "Microsoft (MSFT)",
        price: 428.9,
        drawdownFromHighPct: -9.8,
        rangePositionPct: 66,
        rsi14: 54.1,
        score: 58,
        band: "Neutral",
        stance: "Patience",
      },
    ],
  },
  insiders: {
    collectedAt: new Date().toISOString(),
    windowLabel: "Filed in the last 24 hours",
    usedFallbackDay: false,
    buys: [],
    sells: [],
    clusters: [],
    watchlist: [],
    buyCount: 0,
    sellCount: 0,
    sourceUrl: "http://openinsider.com/",
    sourceName: "OpenInsider",
  },
  whales: {
    collectedAt: new Date().toISOString(),
    quarterLabel: "Q2 2026",
    filingsSoFar: 23,
    filingsTotal: 83,
    buyAddCount: 700,
    briefing:
      "Placeholder whale briefing — superinvestor 13Fs are still coming in for Q2.",
    themes: [
      {
        title: "Managed care",
        detail: "ELV and UNH show up among the most-shared buys so far.",
      },
    ],
    clusteredBuys: [
      {
        ticker: "BRK.B",
        name: "Berkshire Hathaway CL B",
        buyerCount: 6,
        portfolioWeightPct: 0.069,
      },
    ],
    notableBuys: [
      {
        manager: "Bill Ackman - Pershing Square",
        period: "Q1 2026",
        ticker: "MSFT",
        name: "Microsoft Corp.",
        action: "Buy",
        portfolioPct: 15.26,
      },
    ],
    realtimeBuys: [
      {
        date: "31 Jul 2026",
        filer: "DURABLE CAPITAL PARTNERS LP",
        security: "Goosehead Insurance Inc",
        totalUsd: 9_800_000,
      },
    ],
    watchlist: [
      {
        tickerId: "MSFT",
        note: "Ackman opened a large new stake last quarter.",
      },
    ],
    sourceUrl: "https://www.dataroma.com/m/allact.php?typ=a",
    sourceName: "Dataroma",
  },
  valuation: [],
  generatedAt: new Date().toISOString(),
  model: "test-send (no LLM)",
  windowHours: 24,
  hasPreviousBrief: true,
};

async function main() {
  const [usage, sites, reddit] = await Promise.all([
    collectUsageReport(),
    collectSiteAnalytics().catch((error) => {
      console.warn("live GA fetch failed; using demo sites", error);
      return demoSites();
    }),
    collectRedditTops().catch((error) => {
      console.warn("live Reddit fetch failed", error);
      return [];
    }),
  ]);
  brief.sites = sites.length > 0 ? sites : demoSites();
  brief.reddit = reddit;
  brief.generatedAt = new Date().toISOString();

  await saveMarketsBrief(toMarketsBrief(brief)).catch((error) => {
    console.warn("markets-brief save failed", error);
  });

  const email = await sendBriefEmail(brief, usage);
  console.log(
    JSON.stringify(
      {
        ok: true,
        emailId: email?.id ?? null,
        to: process.env.EMAIL_TO,
        reddit: brief.reddit.map((feed) => ({
          id: feed.id,
          window: feed.window,
          posts: feed.posts.length,
        })),
        sites: brief.sites.map((s) => ({
          label: s.label,
          propertyId: s.propertyId,
          users: s.metrics.activeUsers,
          error: s.error ?? null,
        })),
        watch: usage.watch.map((m) => ({
          id: m.id,
          percent: m.percent,
        })),
        metrics: usage.metrics.map((m) => ({
          id: m.id,
          available: m.available,
          percent: m.percent,
          detail: m.detail,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
