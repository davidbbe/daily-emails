import type { RapidApiUsageSnapshot } from "@/lib/rapidapi-usage";
const now = new Date("2026-10-11T09:00:00.000Z");

export function rapidApiFixture(tracked = "2026-10-09T12:00:00.000Z"): RapidApiUsageSnapshot {
  const observed = now.toISOString();
  const period = (month: number) => {
    const start = new Date(Date.UTC(2026, month - 1, 9, 10, 51));
    const end = new Date(Date.UTC(2026, month, 9, 10, 51));
    return { start: start.toISOString(), end: end.toISOString(), days: Array.from({ length: (end.getTime() - start.getTime()) / 86_400_000 }, (_, i) => {
      const from = new Date(start.getTime() + i * 86_400_000).toISOString();
      const to = new Date(start.getTime() + (i + 1) * 86_400_000).toISOString();
      const status = from >= observed ? "upcoming" : to <= tracked ? "untracked" : from < tracked || to > observed ? "partial" : "complete";
      return { start: from, end: to, status, requests: status === "upcoming" || status === "untracked" ? null : i === 0 ? 150 : 70 } as const;
    }) };
  };
  return { version: 1, api: "unogsNG", app: "TV Roulette", observedAt: observed, trackingStartedAt: tracked,
    billingAnchor: "2026-01-09T10:51:00.000Z", dailyLimit: 100, overageRateUsd: 0.1, periods: [period(10), period(9)] };
}
