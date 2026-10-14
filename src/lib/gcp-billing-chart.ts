import type { GcpBillingReport } from "@/lib/gcp-billing";
import { buildCostLineChartSvg, costChartAttachment, type CostChartPoint, type InlineChartAttachment } from "@/lib/cost-line-chart";

export const GCP_COST_CHART_ID = "gcp-cumulative-net-cost";
export const GCP_COST_CHART_HEIGHT = 420;

/** Credits decrease the running net cost; missing export dates break the line. */
export function cumulativeBillingSeries(report: GcpBillingReport): CostChartPoint[] {
  const days = [...report.days].sort((a, b) => a.date.localeCompare(b.date));
  let cost = 0, previous: number | null = null;
  return days.flatMap(day => {
    const at = Date.parse(`${day.date}T12:00:00Z`);
    const values = Object.values(day.costs ?? {});
    if (!values.length) { previous = null; return []; }
    if (!Number.isFinite(at) || values.some(v => !Number.isFinite(v))) throw new Error("Invalid daily billing cost");
    const startsSegment = previous === null || at - previous !== 86400000;
    cost += values.reduce((sum, n) => sum + n, 0);
    previous = at;
    return [{ at, cost, startsSegment }];
  });
}

export function buildGcpBillingChartSvg(report: GcpBillingReport) {
  const first = new Date(`${report.startDate}T12:00:00Z`);
  const last = new Date(`${report.endDate}T12:00:00Z`);
  // Expand the axis only. No points or bars are invented for the remaining days.
  const from = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1, 12);
  const to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0, 12);
  const dailyCalls = report.days.flatMap(day => {
    if (day.billedEvents == null) return [];
    if (!Number.isFinite(day.billedEvents) || day.billedEvents < 0) throw new Error("Invalid billed-event count");
    const start = Date.parse(`${day.date}T00:00:00Z`);
    return [{ start, end: start + 86400000, calls: day.billedEvents }];
  });
  return buildCostLineChartSvg(cumulativeBillingSeries(report), from, to, "Net cost (USD)", { dailyCalls, dailyCallLabel: "Billed events per day", dayCenteredBars: true, tickCount: 8 });
}

export async function gcpBillingChartAttachments(report?: GcpBillingReport | null): Promise<InlineChartAttachment[]> {
  if (!report || report.error || !report.days.length) return [];
  try {
    return [await costChartAttachment(buildGcpBillingChartSvg(report), GCP_COST_CHART_ID)];
  } catch {
    console.warn("email: Cloud Billing chart unavailable");
    return [];
  }
}
