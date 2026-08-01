import { generateDailyBrief } from "@/lib/brief";
import { sendBriefEmail } from "@/lib/email";
import { loadPreviousBrief, savePreviousBrief, toSnapshot } from "@/lib/history";
import { collectResearch } from "@/lib/research";
import { collectUsageReport } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 120;

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
    // Collect after the brief so AI Gateway balance includes today's spend.
    const usage = await collectUsageReport();
    const email = await sendBriefEmail(brief, usage);

    return Response.json({
      ok: true,
      emailId: email?.id ?? null,
      model: brief.model,
      generatedAt: brief.generatedAt,
      hasPreviousBrief: brief.hasPreviousBrief,
      themeOfTheDay: brief.themeOfTheDay,
      earningsCount: brief.earningsCalendar.length,
      tickerCounts: Object.fromEntries(
        Object.entries(research.tickers).map(([id, items]) => [id, items.length]),
      ),
      peopleCounts: Object.fromEntries(
        Object.entries(research.people).map(([id, items]) => [id, items.length]),
      ),
      catalystCounts: Object.fromEntries(
        Object.entries(research.catalysts).map(([id, items]) => [
          id,
          items.length,
        ]),
      ),
      trendCounts: Object.fromEntries(
        Object.entries(research.trends).map(([id, items]) => [id, items.length]),
      ),
      crossRegionCount: brief.trends.crossRegion.length,
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
