/**
 * One-shot rich test send: live news, sentiment, earnings, GA, usage + AI brief.
 * Skips Reddit and Google Trends (and omits those email sections when empty).
 *
 *   npx tsx scripts/send-live-test-email.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateDailyBrief } from "@/lib/brief";
import {
  PEOPLE,
  TICKERS,
  TREND_REGIONS,
  type TrendRegionId,
} from "@/lib/config";
import { collectEarningsCalendar } from "@/lib/earnings";
import { sendBriefEmail } from "@/lib/email";
import { saveMarketsBrief, toMarketsBrief } from "@/lib/markets-brief";
import { loadPreviousBrief } from "@/lib/history";
import {
  collectSiteAnalytics,
  type SiteAnalytics,
} from "@/lib/analytics";
import type { NewsItem, ResearchBundle, TrendItem } from "@/lib/research";
import { collectSentiment } from "@/lib/sentiment";
import { collectUsageReport } from "@/lib/usage";
import { collectValuation, type TickerValuation } from "@/lib/valuation";
import { collectWhaleActivity, emptyWhaleResearch } from "@/lib/whales";
import Parser from "rss-parser";

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

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "daily-emails-brief/1.0" },
});

function googleNewsRssUrl(query: string) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function isWithinHours(date: Date, hours: number) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

async function fetchRecentNews(query: string, hours = 24): Promise<NewsItem[]> {
  const feed = await parser.parseURL(googleNewsRssUrl(query));
  const items: NewsItem[] = [];

  for (const item of feed.items.slice(0, 20)) {
    const published = item.isoDate || item.pubDate;
    if (!published || !item.title || !item.link) continue;
    const date = new Date(published);
    if (Number.isNaN(date.getTime()) || !isWithinHours(date, hours)) continue;
    items.push({
      title: item.title,
      link: item.link,
      publishedAt: date.toISOString(),
      source: item.source?.name || item.creator || undefined,
    });
  }

  return items.slice(0, 8);
}

async function collectResearchWithoutTrendsOrReddit(
  hours = 24,
): Promise<ResearchBundle> {
  const tickers: Record<string, NewsItem[]> = {};
  const people: Record<string, NewsItem[]> = {};
  const trends = {} as Record<TrendRegionId, TrendItem[]>;
  for (const region of TREND_REGIONS) {
    trends[region.id] = [];
  }

  const [, , earnings, sites, sentiment, whales, valuation] = await Promise.all([
    Promise.all(
      TICKERS.map(async (ticker) => {
        tickers[ticker.id] = await fetchRecentNews(ticker.query, hours).catch(
          (error) => {
            console.warn(`news failed for ${ticker.id}`, error);
            return [] as NewsItem[];
          },
        );
      }),
    ),
    Promise.all(
      PEOPLE.map(async (person) => {
        people[person.id] = await fetchRecentNews(person.query, hours).catch(
          (error) => {
            console.warn(`news failed for ${person.id}`, error);
            return [] as NewsItem[];
          },
        );
      }),
    ),
    collectEarningsCalendar(),
    collectSiteAnalytics().catch((error) => {
      console.warn("analytics fetch failed", error);
      return [] as SiteAnalytics[];
    }),
    collectSentiment(),
    collectWhaleActivity().catch((error) => {
      console.warn("whale activity fetch failed", error);
      return emptyWhaleResearch(
        error instanceof Error ? error.message : "Whale activity fetch failed",
      );
    }),
    collectValuation().catch((error) => {
      console.warn("valuation fetch failed", error);
      return [] as TickerValuation[];
    }),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    windowHours: hours,
    tickers,
    people,
    earnings,
    trends,
    reddit: [],
    sites,
    sentiment,
    whales,
    valuation,
  };
}

async function main() {
  console.log("Collecting live research (no Reddit / Trends)...");
  const previous = await loadPreviousBrief();
  const research = await collectResearchWithoutTrendsOrReddit(24);

  console.log(
    JSON.stringify(
      {
        tickerCounts: Object.fromEntries(
          Object.entries(research.tickers).map(([id, items]) => [
            id,
            items.length,
          ]),
        ),
        peopleCounts: Object.fromEntries(
          Object.entries(research.people).map(([id, items]) => [
            id,
            items.length,
          ]),
        ),
        earnings: research.earnings.length,
        sites: research.sites.map((s) => s.label),
        sentimentMeters: research.sentiment.meters.map((m) => ({
          id: m.id,
          value: m.value,
          band: m.band,
        })),
        tickerProxies: research.sentiment.tickers.map((t) => ({
          id: t.tickerId,
          score: t.score ?? null,
          stance: t.stance ?? null,
        })),
        whales: {
          quarter: research.whales.quarterLabel,
          clusters: research.whales.clusterBuys.length,
          error: research.whales.error ?? null,
        },
      },
      null,
      2,
    ),
  );

  console.log("Generating AI brief...");
  const brief = await generateDailyBrief(research, previous);
  // This test intentionally omits trend/reddit sections.
  brief.reddit = [];
  brief.trends = { regions: [], crossRegion: [] };
  brief.regionalPulse = "";
  brief.themeOfTheDay = `[TEST · live data, no Reddit/Trends] ${brief.themeOfTheDay}`;

  await saveMarketsBrief(toMarketsBrief(brief)).catch((error) => {
    console.warn("markets-brief save failed", error);
  });

  console.log("Collecting usage + sending...");
  const usage = await collectUsageReport();
  const email = await sendBriefEmail(brief, usage);

  console.log(
    JSON.stringify(
      {
        ok: true,
        emailId: email?.id ?? null,
        to: process.env.EMAIL_TO,
        model: brief.model,
        themeOfTheDay: brief.themeOfTheDay,
        sentiment: brief.sentiment.valueDial,
        earningsCount: brief.earningsCalendar.length,
        siteCount: brief.sites.length,
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
