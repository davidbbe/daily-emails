import { z } from "zod";
import type { UsageMetric } from "@/lib/usage";
import { formatHumanDate } from "@/lib/dates";

const daySchema = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  requests: z.number().int().nonnegative().nullable(),
  status: z.enum(["complete", "partial", "untracked", "upcoming"]),
});
const periodSchema = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  days: z.array(daySchema).min(28).max(31),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  api: z.literal("unogsNG"),
  app: z.literal("TV Roulette"),
  observedAt: z.iso.datetime(),
  trackingStartedAt: z.iso.datetime().nullable(),
  billingAnchor: z.iso.datetime(),
  dailyLimit: z.number().int().positive(),
  dailyCapEnforced: z.boolean().optional(),
  overageRateUsd: z.number().finite().nonnegative(),
  periods: z.array(periodSchema).length(2),
});

export type RapidApiUsageDay = z.infer<typeof daySchema>;
export type RapidApiUsagePeriod = z.infer<typeof periodSchema>;
export type RapidApiUsageSnapshot = z.infer<typeof snapshotSchema>;
export type RapidApiUsageReport = {
  available: boolean;
  snapshot?: RapidApiUsageSnapshot;
  detail: string;
};

/** Reject stale, missing, duplicated, misaligned, or incomplete source windows. */
export function parseRapidApiUsage(value: unknown, now = new Date()): RapidApiUsageSnapshot {
  const snapshot = snapshotSchema.parse(value);
  const observed = Date.parse(snapshot.observedAt);
  const tracked = snapshot.trackingStartedAt ? Date.parse(snapshot.trackingStartedAt) : null;
  if (observed > now.getTime() + 60_000 || now.getTime() - observed > 24 * 60 * 60 * 1000 || (tracked != null && tracked > observed)) {
    throw new Error("Invalid observation time");
  }
  const anchor = new Date(snapshot.billingAnchor);
  if (anchor.getUTCDate() > 28 || (tracked != null && tracked < anchor.getTime())) throw new Error("Invalid billing anchor or tracking start");
  for (const period of snapshot.periods) {
    const start = Date.parse(period.start);
    const end = Date.parse(period.end);
    // These periods follow the subscription anniversary, never calendar months.
    const startDate = new Date(start);
    const expectedEnd = new Date(startDate);
    expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
    if (end !== expectedEnd.getTime() || startDate.getUTCDate() !== anchor.getUTCDate() ||
        startDate.toISOString().slice(11) !== anchor.toISOString().slice(11) || start < anchor.getTime()) {
      throw new Error("Invalid billing period");
    }
    let cursor = start;
    for (const day of period.days) {
      const dayStart = Date.parse(day.start);
      const dayEnd = Date.parse(day.end);
      const expectedStatus = dayStart >= observed ? "upcoming"
        : tracked == null || dayEnd <= tracked ? "untracked"
        : dayStart < tracked || dayEnd > observed ? "partial" : "complete";
      if (dayStart !== cursor || dayEnd !== cursor + 86_400_000 || dayEnd > end ||
          day.status !== expectedStatus || ((day.requests == null) !== (expectedStatus === "untracked" || expectedStatus === "upcoming"))) {
        throw new Error("Invalid daily coverage");
      }
      cursor = dayEnd;
    }
    if (cursor !== end) throw new Error("Incomplete billing period");
  }
  const [current, previous] = snapshot.periods;
  if (!(Date.parse(current.start) <= observed && observed < Date.parse(current.end)) || previous.end !== current.start) {
    throw new Error("Invalid current billing period");
  }
  return snapshot;
}

export async function collectRapidApiUsage(now = new Date()): Promise<RapidApiUsageReport> {
  const endpoint = process.env.TV_ROULETTE_USAGE_URL?.trim();
  const secret = process.env.TV_ROULETTE_USAGE_SECRET?.trim();
  if (!endpoint || !secret) return { available: false, detail: "Set TV_ROULETTE_USAGE_URL and TV_ROULETTE_USAGE_SECRET after enabling usage tracking in TV Roulette." };
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid endpoint");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
      redirect: "error", // Never forward the reporting secret to a redirect destination.
    });
    if (!response.ok) return { available: false, detail: `TV Roulette usage report returned HTTP ${response.status}. Check the reporting secret and tracking configuration.` };
    const snapshot = parseRapidApiUsage(await response.json(), now);
    return { available: true, snapshot, detail: `Recorded outgoing request attempts from TV Roulette only. ${snapshot.dailyCapEnforced ? "TV Roulette enforces the daily cap; quota or storage failures use cached/local recommendations. Initial partial-day requests pause until the next reset." : "Best-effort logging can undercount if storage fails."} Costs are estimates using the configured plan; failed requests, other apps, and provider billing rules can differ. Earlier untracked days are not zero usage.` };
  } catch {
    // Do not expose URLs, credentials, provider response bodies, or parser input.
    return { available: false, detail: "TV Roulette usage report could not be collected or validated. No usage or cost has been assumed." };
  }
}

export function rapidApiDailyMetric(report: RapidApiUsageReport): UsageMetric {
  const snapshot = report.snapshot;
  const currentDay = snapshot?.periods[0].days.find(day => day.start <= snapshot.observedAt && snapshot.observedAt < day.end);
  const available = report.available && currentDay?.requests != null;
  const used = available ? currentDay!.requests! : 0;
  const limit = snapshot?.dailyLimit ?? null;
  return {
    id: "rapidapi-unogs-daily", label: "unogsNG · TV Roulette daily requests", used, limit,
    unit: "requests", percent: available && limit ? Math.round(used / limit * 1000) / 10 : 0,
    available, limitBasis: "configured", source: "live",
    detail: available
      ? `${formatHumanDate(currentDay!.start)}–${formatHumanDate(currentDay!.end)} · recorded attempts; current day is provisional · ${limit} requests per subscription day (configured plan allowance) · $${snapshot!.overageRateUsd.toFixed(2)} per extra request`
      : "unogsNG daily usage unavailable. " + report.detail,
  };
}

export function recordedRequests(period: RapidApiUsagePeriod) {
  return period.days.reduce((sum, day) => sum + (day.requests ?? 0), 0);
}

export function estimatedOverage(period: RapidApiUsagePeriod, snapshot: RapidApiUsageSnapshot) {
  return period.days.reduce((sum, day) => sum + Math.max(0, (day.requests ?? 0) - snapshot.dailyLimit), 0) * snapshot.overageRateUsd;
}
