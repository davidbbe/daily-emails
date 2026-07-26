import { generateDailyBrief } from "@/lib/brief";
import { sendBriefEmail } from "@/lib/email";
import { loadPreviousBrief, savePreviousBrief, toSnapshot } from "@/lib/history";
import { collectResearch } from "@/lib/research";

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
    await savePreviousBrief(toSnapshot(brief));
    const email = await sendBriefEmail(brief);

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
      trendMovers: {
        newToday: brief.trendMovers.newToday.length,
        stillRising: brief.trendMovers.stillRising.length,
        fellOff: brief.trendMovers.fellOff.length,
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
