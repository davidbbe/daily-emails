import {
  categories,
  fetchTrendingNews,
  fetchTrendingNow,
  type TrendingNowItem,
} from "google-trends-now";
import Parser from "rss-parser";
import {
  PEOPLE,
  TICKERS,
  TREND_REGIONS,
  type TrendRegionId,
} from "@/lib/config";
import {
  collectEarningsCalendar,
  type EarningsDates,
} from "@/lib/earnings";
import { collectRedditTops, type RedditSubFeed } from "@/lib/reddit";

export type NewsItem = {
  title: string;
  link: string;
  publishedAt: string;
  source?: string;
};

export type TrendItem = {
  title: string;
  approxTraffic: string;
  trafficScore: number;
  publishedAt?: string;
  newsTitle?: string;
  newsUrl?: string;
  newsSource?: string;
};

export type ResearchBundle = {
  collectedAt: string;
  windowHours: number;
  tickers: Record<string, NewsItem[]>;
  people: Record<string, NewsItem[]>;
  earnings: EarningsDates[];
  trends: Record<TrendRegionId, TrendItem[]>;
  reddit: RedditSubFeed[];
};

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "agent-dave-daily-brief/1.0",
  },
});

/** Google Trends Trending Now category id for Sports */
const SPORTS_CATEGORY_ID = categories.sports;

function googleNewsRssUrl(query: string) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function isWithinHours(date: Date, hours: number) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

export function parseTrafficScore(approxTraffic: string): number {
  const digits = approxTraffic.replace(/[^\d]/g, "");
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : 0;
}

function trafficScoreFromItem(item: TrendingNowItem): number {
  if (typeof item.search_volume === "number" && Number.isFinite(item.search_volume)) {
    return item.search_volume;
  }
  return parseTrafficScore(item.search_volume_label ?? "");
}

function isSportsTrend(item: TrendingNowItem): boolean {
  return item.categories.some((category) => {
    if (category.id === SPORTS_CATEGORY_ID) return true;
    return String(category.name).toLowerCase() === "sports";
  });
}

async function attachNews(
  item: TrendingNowItem,
  geo: string,
): Promise<Pick<TrendItem, "newsTitle" | "newsUrl" | "newsSource">> {
  const ref = item.news_refs?.[0];
  if (!ref) return {};

  try {
    const articles = await fetchTrendingNews([ref], {
      geo,
      hl: "en",
      timeoutMs: 12000,
    });
    const article = articles[0];
    if (!article?.title) return {};
    return {
      newsTitle: article.title,
      newsUrl: article.url ?? undefined,
      newsSource: article.source ?? undefined,
    };
  } catch (error) {
    console.warn(`trends news resolve failed for "${item.query}"`, error);
    return {};
  }
}

/**
 * Pull 2× the display limit from Trending Now, drop Sports-category rows,
 * then keep the top `limit` remaining (by search volume).
 */
async function fetchCountryTrends(geo: string, limit = 10): Promise<TrendItem[]> {
  const fetchLimit = Math.max(limit * 2, limit);
  const output = await fetchTrendingNow({
    geo,
    hours: 24,
    status: "active",
    sort: "volume",
    limit: fetchLimit,
    fallback: "rss",
    timeoutMs: 20000,
  });

  if (output.fetch_status !== "success" && output.items.length === 0) {
    throw new Error(
      `Google Trends failed for geo=${geo}: ${output.error ?? output.fetch_status}`,
    );
  }

  if (output.source === "rss_limited") {
    console.warn(
      `trends: geo=${geo} fell back to RSS (no category field); sports filter skipped`,
    );
  }

  const withoutSports =
    output.source === "rss_limited"
      ? output.items
      : output.items.filter((item) => !isSportsTrend(item));

  const selected = withoutSports.slice(0, limit);
  const newsFields = await Promise.all(
    selected.map((item) => attachNews(item, geo)),
  );

  return selected.map((item, index) => {
    const approxTraffic = item.search_volume_label || "—";
    const publishedAt = item.started_at ?? undefined;
    return {
      title: item.query,
      approxTraffic,
      trafficScore: trafficScoreFromItem(item),
      publishedAt,
      ...newsFields[index],
    };
  });
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

export async function collectResearch(hours = 24): Promise<ResearchBundle> {
  const tickers: Record<string, NewsItem[]> = {};
  const people: Record<string, NewsItem[]> = {};
  const trends = {} as Record<TrendRegionId, TrendItem[]>;

  const [, , earnings, reddit] = await Promise.all([
    Promise.all(
      TICKERS.map(async (ticker) => {
        tickers[ticker.id] = await fetchRecentNews(ticker.query, hours);
      }),
    ),
    Promise.all(
      PEOPLE.map(async (person) => {
        people[person.id] = await fetchRecentNews(person.query, hours);
      }),
    ),
    collectEarningsCalendar(),
    collectRedditTops().catch((error) => {
      console.warn("reddit fetch failed", error);
      return [] as RedditSubFeed[];
    }),
    Promise.all(
      TREND_REGIONS.map(async (region) => {
        try {
          trends[region.id] = await fetchCountryTrends(region.geo, region.limit);
        } catch (error) {
          console.warn(`trends fetch failed for ${region.id}`, error);
          trends[region.id] = [];
        }
      }),
    ),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    windowHours: hours,
    tickers,
    people,
    earnings,
    trends,
    reddit,
  };
}
