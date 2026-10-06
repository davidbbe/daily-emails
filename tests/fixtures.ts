import type { DailyBrief } from "@/lib/brief";
import type { ResearchBundle } from "@/lib/research";
import { emptyInsiderBrief } from "@/lib/openinsider";
import { emptyWhaleResearch } from "@/lib/whales";
import type { OperationsReport } from "@/lib/email";

export function operationsFixture(): OperationsReport {
  const metrics = { activeUsers: 120, sessions: 160, screenPageViews: 380, bounceRate: 0.35, averageSessionDuration: 95 };
  const quota = { id: "resend-monthly", label: "Resend monthly emails", used: 1800, limit: 3000, unit: "emails", percent: 60, available: true, detail: "Sent + received · observed 3 Oct 2026 · resets 1 Nov 2026" };
  const advancedQuota = { id: "blob-advanced-ops", label: "Blob advanced operations", used: 1362, limit: 2_000, unit: "ops", percent: 68.1, available: true, limitBasis: "provider", source: "live", detail: "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC · rolling last 30 days, including today · all stores in team · Hobby included allowance" };
  return {
    generatedAt: "2026-10-03T09:00:00.000Z",
    sites: ["uwhmap.com", "greetingcardfun.com", "tvroulette.app", "restaurantroulette.app"].map((label, index) => ({
      accountId: `account-${index}`, propertyId: `property-${index}`, label,
      date: "2026-10-02", previousDate: "2026-10-01", monthStart: "2026-10-01", timeZone: "UTC",
      metrics, previous: { ...metrics, activeUsers: 100, sessions: 150, screenPageViews: 400 },
      monthToDate: { ...metrics, activeUsers: 220, sessions: 310, screenPageViews: 780 },
      dailySeries: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10), activeUsers: [70, 90, 80, 110, 100, 100, 120][i], sessions: 160, screenPageViews: 380 })),
      freshnessNote: "Provisional GA4 data; recent values may change during processing.",
    })),
    gcpBilling: {
      accountId: "offline-account", accountLabel: "Greeting Card Fun & Restaurant Roulette",
      reportsUrl: "https://console.cloud.google.com/billing/offline-account/reports",
      startDate: "2026-10-01", endDate: "2026-10-02", previousStartDate: "2026-09-01", previousEndDate: "2026-09-02",
      currency: "USD", total: 8, previousTotal: 10, savings: 0, period: "month_to_date", source: "bigquery",
      services: [
        { name: "Places API", color: "#4185f4", marker: "circle", usageCost: 5, previousCost: 7, calls: 850, projectHint: "Restaurant Roulette" },
        { name: "Gemini API", color: "#ff5620", marker: "square", usageCost: 3, previousCost: 3, calls: null, projectHint: "Greeting Card Fun" },
      ],
      apiUsageStartDate: "2026-10-01", apiUsageEndDate: "2026-10-02",
      apiUsage: [{ name: "Places API", color: "#4185f4", marker: "circle", calls: 850, skus: [{ name: "Nearby Search Enterprise", quantity: 850, unit: "calls", freeMonthly: 1000 }] }],
      days: [{ date: "2026-10-01", costs: { "Places API": 2, "Gemini API": 1 } }, { date: "2026-10-02", costs: { "Places API": 3, "Gemini API": 2 } }],
      freshnessNote: "Export data can arrive late; these totals may change.",
    },
    usage: {
      collectedAt: "2026-10-03T09:00:00.000Z", thresholdPercent: 50, watch: [quota, advancedQuota],
      metrics: [
        { id: "ai-gateway", label: "AI Gateway month-to-date spend", used: 2, limit: 5, unit: "USD", percent: 40, available: true, limitBasis: "budget", source: "live", detail: "Oct 1–3 UTC · measured account spend · $3.00 credit balance · $5 configured budget; not a provider cap" },
        { id: "fast-data-transfer", label: "Fast Data Transfer", used: 12_000_000_000, limit: 100_000_000_000, unit: "bytes", percent: 12, available: true, source: "live", detail: "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC · rolling last 30 days, including today · all projects in team · Hobby included allowance" },
        { id: "blob-simple-ops", label: "Blob simple operations", used: 2681, limit: 10_000, unit: "ops", percent: 26.8, available: true, limitBasis: "provider", source: "live", detail: "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC · rolling last 30 days, including today · all stores in team · Hobby included allowance" },
        advancedQuota,
        { id: "blob-team-storage", label: "Blob storage · rolling team average", used: 70_000_000, limit: 1_000_000_000, unit: "bytes", percent: 7, available: true, limitBasis: "provider", source: "live", detail: "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC · provider average over this rolling window; dashboard Latest value may differ" },
        { id: "blob-data-transfer", label: "Blob Data Transfer", used: 120_000_000, limit: 10_000_000_000, unit: "bytes", percent: 1.2, available: true, limitBasis: "provider", source: "live", detail: "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC · rolling last 30 days · all team stores" },
        { id: "blob-storage", label: "Blob storage · connected store", used: 10_000_000, limit: null, unit: "bytes", percent: 0, available: true, limitBasis: "snapshot", source: "live", detail: "Current snapshot of this store; excludes other team stores and billed storage averages" },
        { ...quota, id: "resend-daily", label: "Resend daily emails", used: 12, limit: 100, percent: 12, detail: "Sent + received · resets 4 Oct 2026" },
        quota,
      ],
    },
  };
}

export function researchFixture(): ResearchBundle {
  return {
    collectedAt: "2026-10-02T09:00:00.000Z",
    windowHours: 24,
    tickers: {},
    people: {},
    trends: { us: [], thailand: [] },
    earnings: [],
    reddit: [],
    sites: [],
    sentiment: { collectedAt: "2026-10-02T09:00:00.000Z", meters: [], tickers: [], valueDial: "" },
    insiders: emptyInsiderBrief(),
    whales: emptyWhaleResearch(),
    valuation: [],
    gcpBilling: null,
  };
}

export function briefFixture(): DailyBrief {
  const research = researchFixture();
  return {
    ...research,
    tickers: [],
    people: [],
    earningsCalendar: [],
    trends: { regions: [], crossRegion: [] },
    whales: {
      collectedAt: research.collectedAt,
      quarterLabel: "",
      briefing: "",
      themes: [],
      clusteredBuys: [],
      notableBuys: [],
      realtimeBuys: [],
      watchlist: [],
      sourceUrl: "https://www.dataroma.com",
      sourceName: "Dataroma",
    },
    generatedAt: research.collectedAt,
    model: "offline-test",
    hasPreviousBrief: false,
  };
}
