import {
  categories,
  fetchTrendingNews,
  fetchTrendingNow,
  normalizeTrendingRow,
  parseTrendingRssXml,
  type TrendingNowItem,
} from "google-trends-now";
import Parser from "rss-parser";
import {
  collectSiteAnalytics,
  type SiteAnalytics,
} from "@/lib/analytics";
import {
  collectGcpBilling,
  type GcpBillingReport,
} from "@/lib/gcp-billing";
import {
  PEOPLE,
  PERSON_NEWS_LIMIT,
  TICKERS,
  TREND_REGIONS,
  personSocial,
  type PersonConfig,
  type TrendRegionId,
} from "@/lib/config";
import { fetchSocialPosts } from "@/lib/social-posts";
import {
  collectEarningsCalendar,
  type EarningsDates,
} from "@/lib/earnings";
import { collectRedditTops, type RedditSubFeed } from "@/lib/reddit";
import {
  collectSentiment,
  type SentimentReport,
} from "@/lib/sentiment";
import {
  collectValuation,
  type TickerValuation,
} from "@/lib/valuation";
import {
  collectInsiderTrades,
  emptyInsiderBrief,
  type InsiderBrief,
} from "@/lib/openinsider";
import {
  collectWhaleActivity,
  emptyWhaleResearch,
  type WhaleResearch,
} from "@/lib/whales";

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
  /** Feed failures are distinct from a successful feed with no recent items. */
  feedErrors?: Record<string, string>;
  earnings: EarningsDates[];
  trends: Record<TrendRegionId, TrendItem[]>;
  reddit: RedditSubFeed[];
  /** GA4 site overviews — pass-through, no LLM; empty when creds missing */
  sites: SiteAnalytics[];
  /** Cloud Billing report — pass-through, no LLM */
  gcpBilling: GcpBillingReport | null;
  /** Fear & greed meters + per-ticker proxies — pass-through, no LLM */
  sentiment: SentimentReport;
  /** Open-market Form 4 buys/sells from OpenInsider — pass-through, no LLM */
  insiders: InsiderBrief;
  /** Superinvestor 13F / Form 4 activity — pass-through, then LLM briefing */
  whales: WhaleResearch;
  /** Value multiples for listed equity tickers — pass-through, no LLM */
  valuation: TickerValuation[];
};

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "daily-emails-brief/1.0",
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
  const match = approxTraffic
    .replaceAll(",", "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([KMB])?\+?$/i);
  if (!match) return 0;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() ?? ""] ?? 1;
  return Number(match[1]) * multiplier;
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

const TRENDS_PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type TrendNewsFields = Pick<TrendItem, "newsTitle" | "newsUrl" | "newsSource">;

function trendVolume(item: TrendingNowItem) {
  const value = Number(item.search_volume);
  return Number.isFinite(value) ? value : 0;
}

function normalizeTrendTitle(title: string) {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function xmlTag(block: string, localName: string) {
  const match = block.match(
    new RegExp(
      `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
      "i",
    ),
  );
  return match ? decodeXml(match[1]) : "";
}

function sliceJsonArray(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error("Trends page list was truncated");
}

/** Rows embedded in the public Trending Now page (`AF_initDataCallback`). */
export function embeddedTrendRows(html: string): unknown[][] {
  const marker = "AF_initDataCallback({key: 'ds:0'";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error("Trends page has no embedded list");
  const dataAt = html.indexOf("data:", markerAt);
  const arrayAt = html.indexOf("[", dataAt);
  if (dataAt < 0 || arrayAt < 0) throw new Error("Trends page list was missing");
  const parsed = JSON.parse(sliceJsonArray(html, arrayAt)) as unknown;
  const rows = Array.isArray(parsed) ? parsed[1] : undefined;
  if (!Array.isArray(rows)) throw new Error("Trends page list was empty");
  return rows.filter((row): row is unknown[] => Array.isArray(row));
}

/** First related headline from a Google Trends RSS document, keyed by title. */
export function rssNewsByTitle(xml: string): Map<string, TrendNewsFields> {
  const news = new Map<string, TrendNewsFields>();
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = xmlTag(block, "title");
    if (!title) continue;
    const newsTitle = xmlTag(block, "news_item_title");
    const newsUrl = xmlTag(block, "news_item_url");
    const newsSource = xmlTag(block, "news_item_source");
    if (!newsTitle && !newsUrl) continue;
    news.set(normalizeTrendTitle(title), {
      newsTitle: newsTitle || undefined,
      newsUrl: newsUrl || undefined,
      newsSource: newsSource || undefined,
    });
  }
  return news;
}

/** Drop Sports when categories exist, then keep the highest-volume rows. */
export function selectTrendingItems(
  items: TrendingNowItem[],
  limit: number,
  dropSports: boolean,
) {
  const pool = dropSports ? items.filter((item) => !isSportsTrend(item)) : items;
  return [...pool].sort((a, b) => trendVolume(b) - trendVolume(a)).slice(0, limit);
}

async function fetchEmbeddedTrends(geo: string): Promise<TrendingNowItem[]> {
  const url = `https://trends.google.com/trending?geo=${encodeURIComponent(geo)}&hl=en&hours=24`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": TRENDS_PAGE_UA,
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`trends page HTTP ${response.status}`);
  const rows = embeddedTrendRows(await response.text());
  return rows.map((row, index) =>
    normalizeTrendingRow(row, { position: index + 1, geo, hours: 24 }),
  );
}

async function fetchTrendRss(geo: string) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": TRENDS_PAGE_UA,
      Accept: "application/rss+xml,text/xml,*/*",
    },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`trends RSS HTTP ${response.status}`);
  const xml = await response.text();
  return {
    items: parseTrendingRssXml(xml, { geo, hours: 24 }),
    news: rssNewsByTitle(xml),
  };
}

/**
 * Trending Now for one country.
 * The batch endpoint can answer successfully with no rows (it started doing
 * that in Nov 2026). The public trends page still embeds the full list,
 * including categories, and RSS is the last resort.
 */
async function fetchCountryTrends(geo: string, limit = 10): Promise<TrendItem[]> {
  const fetchLimit = Math.max(limit * 2, limit);
  let selected: TrendingNowItem[] = [];
  let source: "batch" | "page" | "rss" = "batch";

  try {
    const output = await fetchTrendingNow({
      geo,
      hours: 24,
      status: "active",
      sort: "volume",
      limit: fetchLimit,
      fallback: "none",
      timeoutMs: 20000,
    });
    if (output.items.length > 0) {
      selected = selectTrendingItems(output.items, limit, output.source !== "rss_limited");
      source = output.source === "rss_limited" ? "rss" : "batch";
    }
  } catch (error) {
    console.warn(`trends: geo=${geo} batch failed`, error);
  }

  if (selected.length === 0) {
    try {
      const active = (await fetchEmbeddedTrends(geo)).filter((item) => item.active === true);
      selected = selectTrendingItems(active, limit, true);
      if (selected.length > 0) source = "page";
    } catch (error) {
      console.warn(`trends: geo=${geo} trends page failed`, error);
    }
  }

  let rssNews = new Map<string, TrendNewsFields>();
  try {
    const rss = await fetchTrendRss(geo);
    rssNews = rss.news;
    if (selected.length === 0) {
      selected = selectTrendingItems(rss.items, limit, false);
      source = "rss";
    }
  } catch (error) {
    console.warn(`trends: geo=${geo} RSS failed`, error);
  }

  if (selected.length === 0) {
    throw new Error(`Google Trends failed for geo=${geo}`);
  }

  if (source === "rss") {
    console.warn(
      `trends: geo=${geo} fell back to RSS (no category field); sports filter skipped`,
    );
  } else if (source === "page") {
    console.warn(`trends: geo=${geo} used the public trends page (${selected.length} items)`);
  }

  const newsFields = await Promise.all(
    selected.map(async (item) => {
      if (source === "batch") {
        const resolved = await attachNews(item, geo);
        if (resolved.newsTitle) return resolved;
      }
      return rssNews.get(normalizeTrendTitle(item.query)) ?? {};
    }),
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

export async function fetchRecentNews(
  query: string,
  hours = 24,
  maxItems = 8,
): Promise<NewsItem[]> {
  const feed = await parser.parseURL(googleNewsRssUrl(query));
  const items: NewsItem[] = [];

  for (const item of feed.items) {
    if (items.length >= maxItems) break;

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

  return items;
}

export async function fetchPersonNews(query: string, hours = 24) {
  // when:1d ranks last-day stories so high-volume names aren't drowned out.
  return fetchRecentNews(`${query} when:1d`, hours, PERSON_NEWS_LIMIT);
}

export async function collectPersonFeed(
  person: PersonConfig,
  hours = 24,
): Promise<NewsItem[]> {
  if (personSocial(person)) {
    try {
      const posts = await fetchSocialPosts(person, hours);
      if (posts.length > 0) return posts;
      console.warn(
        `social posts empty for ${person.id}; falling back to Google News`,
      );
    } catch (error) {
      console.warn(`social posts failed for ${person.id}`, error);
    }
  }

  return fetchPersonNews(person.query, hours);
}

/** Isolate feed failures without losing the rest of the watchlist. */
export async function collectNewsFeeds(hours = 24) {
  const tickers: Record<string, NewsItem[]> = {};
  const people: Record<string, NewsItem[]> = {};
  const feedErrors: Record<string, string> = {};
  await Promise.all([
    Promise.all(
      TICKERS.map(async (ticker) => {
        tickers[ticker.id] = await fetchRecentNews(ticker.query, hours).catch(
          (error) => {
            console.warn(`news fetch failed for ${ticker.id}`, error);
            feedErrors[ticker.id] = error instanceof Error ? error.message : "News feed unavailable";
            return [];
          },
        );
      }),
    ),
    Promise.all(
      PEOPLE.map(async (person) => {
        people[person.id] = await collectPersonFeed(person, hours).catch(
          (error) => {
            console.warn(`news fetch failed for ${person.id}`, error);
            feedErrors[person.id] = error instanceof Error ? error.message : "News feed unavailable";
            return [];
          },
        );
      }),
    ),
  ]);
  return { tickers, people, feedErrors };
}

export async function collectResearch(hours = 24): Promise<ResearchBundle> {
  const trends = {} as Record<TrendRegionId, TrendItem[]>;
  const [news, earnings, reddit, , sites, sentiment, insiders, whales, valuation, gcpBilling] =
    await Promise.all([
    collectNewsFeeds(hours),
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
    collectSiteAnalytics().catch((error) => {
      console.warn("analytics fetch failed", error);
      return [] as SiteAnalytics[];
    }),
    collectSentiment().catch((error) => {
      console.warn("sentiment fetch failed", error);
      return {
        collectedAt: new Date().toISOString(),
        meters: [],
        tickers: [],
        valueDial:
          "Sentiment meters unavailable today — rely on valuation and catalysts.",
      } satisfies SentimentReport;
    }),
    collectInsiderTrades().catch((error) => {
      console.warn("insider trades fetch failed", error);
      return emptyInsiderBrief(
        error instanceof Error ? error.message : "Insider trades fetch failed",
      );
    }),
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
    collectGcpBilling().catch((error) => {
      console.warn("gcp billing fetch failed", error);
      return null;
    }),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    windowHours: hours,
    ...news,
    earnings,
    trends,
    reddit,
    sites,
    gcpBilling,
    sentiment,
    insiders,
    whales,
    valuation,
  };
}
