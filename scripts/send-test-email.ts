import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectSiteAnalytics,
  type SiteAnalytics,
} from "@/lib/analytics";
import type { DailyBrief } from "@/lib/brief";
import { GA_ACCOUNTS } from "@/lib/config";
import { sendBriefEmail } from "@/lib/email";
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
  ],
  people: [
    { id: "karpathy", name: "Andrej Karpathy", summary: "None found" },
    { id: "huang", name: "Jensen Huang", summary: "None found" },
    { id: "karp", name: "Alex Karp", summary: "None found" },
    { id: "altman", name: "Sam Altman", summary: "None found" },
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
  themeOfTheDay:
    "TEST EMAIL — Fear & greed gauges layout check (no Reddit / Trends).",
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
        label: "CNN Fear & Greed",
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
        tickerId: "SPCX",
        label: "SpaceX (SPCX)",
        error: "No public quote (private / unlisted)",
      },
    ],
  },
  generatedAt: new Date().toISOString(),
  model: "test-send (no LLM)",
  windowHours: 24,
  hasPreviousBrief: true,
};

async function main() {
  const [usage, sites] = await Promise.all([
    collectUsageReport(),
    collectSiteAnalytics().catch((error) => {
      console.warn("live GA fetch failed; using demo sites", error);
      return demoSites();
    }),
  ]);
  brief.sites = sites.length > 0 ? sites : demoSites();
  brief.generatedAt = new Date().toISOString();

  const email = await sendBriefEmail(brief, usage);
  console.log(
    JSON.stringify(
      {
        ok: true,
        emailId: email?.id ?? null,
        to: process.env.EMAIL_TO,
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
