import { generateDailyBrief } from "@/lib/brief";
import { sendBriefEmail } from "@/lib/email";
import { loadPreviousBrief, savePreviousBrief, toSnapshot } from "@/lib/history";
import {
  saveMarketsBrief,
  toMarketsBrief,
} from "@/lib/markets-brief";
import { collectResearch } from "@/lib/research";
import { collectUsageReport } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Allow local/dev runs without CRON_SECRET; require it in production.
    return process.env.NODE_ENV !== "production";
  }

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const previous = await loadPreviousBrief();
    const research = await collectResearch(24);
    const brief = await generateDailyBrief(research, previous);
    // Snapshot is best-effort — never block the email on history persistence.
    await savePreviousBrief(toSnapshot(brief)).catch((error) => {
      console.warn("daily-brief: previous-brief save failed", error);
    });
    // Hosted markets page payload — same best-effort rules as previous-brief.
    await saveMarketsBrief(toMarketsBrief(brief)).catch((error) => {
      console.warn("daily-brief: markets-brief save failed", error);
    });
    // Collect after the brief so AI Gateway balance includes today's spend.
    const usage = await collectUsageReport();
    const email = await sendBriefEmail(brief, usage);

    return Response.json({
      ok: true,
      emailId: email?.id ?? null,
      model: brief.model,
      generatedAt: brief.generatedAt,
      hasPreviousBrief: brief.hasPreviousBrief,
      earningsCount: brief.earningsCalendar.length,
      tickerCounts: Object.fromEntries(
        Object.entries(research.tickers).map(([id, items]) => [id, items.length]),
      ),
      peopleCounts: Object.fromEntries(
        Object.entries(research.people).map(([id, items]) => [id, items.length]),
      ),
      earnings: brief.earningsCalendar.map((event) => ({
        tickerId: event.tickerId,
        previousDate: event.previousDate ?? null,
        nextDate: event.nextDate ?? null,
        nextConfirmed: event.nextConfirmed ?? null,
      })),
      trendCounts: Object.fromEntries(
        Object.entries(research.trends).map(([id, items]) => [id, items.length]),
      ),
      crossRegionCount: brief.trends.crossRegion.length,
      redditCounts: Object.fromEntries(
        (brief.reddit ?? []).map((feed) => [feed.id, feed.posts.length]),
      ),
      siteCounts: Object.fromEntries(
        (brief.sites ?? []).map((site) => [
          site.propertyId || site.accountId,
          site.error ? "error" : site.metrics.activeUsers,
        ]),
      ),
      sentiment: {
        valueDial: brief.sentiment?.valueDial ?? null,
        meters: (brief.sentiment?.meters ?? []).map((m) => ({
          id: m.id,
          value: m.value,
          band: m.band,
          error: m.error ?? null,
        })),
        tickerProxies: (brief.sentiment?.tickers ?? []).map((t) => ({
          tickerId: t.tickerId,
          score: t.score ?? null,
          band: t.band ?? null,
          stance: t.stance ?? null,
          error: t.error ?? null,
        })),
      },
      whales: {
        quarterLabel: brief.whales?.quarterLabel ?? null,
        filingsSoFar: brief.whales?.filingsSoFar ?? null,
        filingsTotal: brief.whales?.filingsTotal ?? null,
        clusteredBuys: brief.whales?.clusteredBuys.length ?? 0,
        notableBuys: brief.whales?.notableBuys.length ?? 0,
        error: brief.whales?.error ?? null,
      },
      valuation: (brief.valuation ?? []).map((row) => ({
        tickerId: row.tickerId,
        pe: row.pe ?? null,
        forwardPe: row.forwardPe ?? null,
        fcfYield: row.fcfYield ?? null,
        peg: row.peg ?? null,
        evEbitda: row.evEbitda ?? null,
        netDebtEbitda: row.netDebtEbitda ?? null,
        pe5yAvg: row.pe5yAvg ?? null,
        roic: row.roic ?? null,
        valueStance: row.valueStance ?? null,
        valueInvestorNote: row.valueInvestorNote ?? null,
        error: row.error ?? null,
      })),
      usage: {
        thresholdPercent: usage.thresholdPercent,
        watch: usage.watch.map((m) => ({
          id: m.id,
          label: m.label,
          percent: m.percent,
        })),
        metrics: usage.metrics.map((m) => ({
          id: m.id,
          label: m.label,
          percent: m.percent,
          available: m.available,
          detail: m.detail,
        })),
      },
    });
  } catch (error) {
    console.error("daily-brief failed", error);
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
