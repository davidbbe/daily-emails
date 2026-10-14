import { buildCostLineChartSvg, costChartAttachment, COST_CHART_WIDTH, type InlineChartAttachment } from "@/lib/cost-line-chart";
export type { InlineChartAttachment } from "@/lib/cost-line-chart";
import type { RapidApiUsagePeriod, RapidApiUsageReport, RapidApiUsageSnapshot } from "@/lib/rapidapi-usage";

export const RAPIDAPI_CHART_WIDTH = COST_CHART_WIDTH;
export const RAPIDAPI_CHART_HEIGHT = 420;
export const rapidApiChartId = (index: number) => `rapidapi-overage-${index}`;

/** Sum per-day overage, keeping gaps and provisional observations explicit. */
export function cumulativeOverageSeries(period: RapidApiUsagePeriod, snapshot: RapidApiUsageSnapshot) {
  let cost = 0;
  let gap = true;
  const points: Array<{ at: number; cost: number; startsSegment: boolean; partial: boolean }> = [];
  for (const day of period.days) {
    if (day.requests == null) { gap = true; continue; }
    if (gap) {
      points.push({ at: Math.max(Date.parse(day.start), snapshot.trackingStartedAt ? Date.parse(snapshot.trackingStartedAt) : Date.parse(day.start)), cost, startsSegment: true, partial: false });
    }
    cost += Math.max(0, day.requests - snapshot.dailyLimit) * snapshot.overageRateUsd;
    points.push({ at: Math.min(Date.parse(day.end), Date.parse(snapshot.observedAt)), cost, startsSegment: false, partial: day.status === "partial" });
    gap = false;
  }
  return points;
}

/** SVG is rasterized before delivery; Gmail receives only the inline PNG. */
export function buildRapidApiChartSvg(period: RapidApiUsagePeriod, snapshot: RapidApiUsageSnapshot) {
  const dailyCalls = period.days.flatMap(day => day.requests == null ? [] : [{ start: Date.parse(day.start), end: Date.parse(day.end), calls: day.requests }]);
  return buildCostLineChartSvg(cumulativeOverageSeries(period, snapshot), Date.parse(period.start), Date.parse(period.end), "Cost (USD)", { dailyCalls, dailyLimit: snapshot.dailyLimit, tickCount: 8 });
}

export async function rapidApiChartAttachments(report?: RapidApiUsageReport): Promise<InlineChartAttachment[]> {
  if (!report?.available || !report.snapshot) return [];
  const snapshot = report.snapshot;
  const attachments = await Promise.all(snapshot.periods.map(async (period, index) => {
    if (index > 0 && !period.days.some(d => d.requests != null)) return null;
    try {
      return await costChartAttachment(buildRapidApiChartSvg(period, snapshot), rapidApiChartId(index));
    } catch {
      console.warn("email: RapidAPI chart unavailable");
      return null;
    }
  }));
  return attachments.filter((a): a is InlineChartAttachment => a !== null);
}
