import Parser from "rss-parser";
import {
  PEOPLE,
  TICKERS,
  TREND_REGIONS,
  type TrendRegionId,
} from "@/lib/config";

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
  catalysts: Record<string, NewsItem[]>;
  trends: Record<TrendRegionId, TrendItem[]>;
};

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "agent-dave-daily-brief/1.0",
  },
});

const TRENDS_UA = "agent-dave-daily-brief/1.0";

function googleNewsRssUrl(query: string) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function googleTrendsRssUrl(geo: string) {
  return `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
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

function decodeXmlEntities(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function firstTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const match = block.match(re);
  if (!match?.[1]) return undefined;
  return decodeXmlEntities(match[1].trim());
}

function parseTrendsXml(xml: string): TrendItem[] {
  const items: TrendItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = firstTag(block, "title");
    if (!title) continue;

    const approxTraffic = firstTag(block, "ht:approx_traffic") ?? "";
    const newsBlock = block.match(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/i)?.[1];
    const newsTitle = newsBlock
      ? firstTag(newsBlock, "ht:news_item_title")
      : undefined;
    const newsUrl = newsBlock
      ? firstTag(newsBlock, "ht:news_item_url")
      : undefined;
    const newsSource = newsBlock
      ? firstTag(newsBlock, "ht:news_item_source")
      : undefined;
    const pubDate = firstTag(block, "pubDate");
    let publishedAt: string | undefined;
    if (pubDate) {
      const date = new Date(pubDate);
      if (!Number.isNaN(date.getTime())) publishedAt = date.toISOString();
    }

    items.push({
      title,
      approxTraffic,
      trafficScore: parseTrafficScore(approxTraffic),
      publishedAt,
      newsTitle,
      newsUrl,
      newsSource,
    });
  }

  return items;
}

function sortAndCapTrends(items: TrendItem[], limit = 10): TrendItem[] {
  return [...items]
    .sort((a, b) => {
      if (b.trafficScore !== a.trafficScore) return b.trafficScore - a.trafficScore;
      return 0;
    })
    .slice(0, limit);
}

async function fetchTrendsXml(geo: string): Promise<string> {
  const response = await fetch(googleTrendsRssUrl(geo), {
    headers: {
      "User-Agent": TRENDS_UA,
      Accept: "application/rss+xml,application/xml,text/xml,*/*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Google Trends RSS failed for geo=${geo}: ${response.status}`);
  }
  return response.text();
}

async function fetchCountryTrends(geo: string, limit = 10): Promise<TrendItem[]> {
  const xml = await fetchTrendsXml(geo);
  return sortAndCapTrends(parseTrendsXml(xml), limit);
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

function catalystQuery(tickerQuery: string) {
  return `(${tickerQuery}) (earnings OR "earnings call" OR "investor day" OR "product launch" OR catalyst OR guidance OR "reports results" OR "reports earnings")`;
}

export async function collectResearch(hours = 24): Promise<ResearchBundle> {
  const tickers: Record<string, NewsItem[]> = {};
  const people: Record<string, NewsItem[]> = {};
  const catalysts: Record<string, NewsItem[]> = {};
  const trends = {} as Record<TrendRegionId, TrendItem[]>;

  await Promise.all([
    ...TICKERS.map(async (ticker) => {
      tickers[ticker.id] = await fetchRecentNews(ticker.query, hours);
    }),
    ...PEOPLE.map(async (person) => {
      people[person.id] = await fetchRecentNews(person.query, hours);
    }),
    ...TICKERS.map(async (ticker) => {
      catalysts[ticker.id] = await fetchRecentNews(
        catalystQuery(ticker.query),
        24 * 7,
      );
    }),
    ...TREND_REGIONS.map(async (region) => {
      try {
        trends[region.id] = await fetchCountryTrends(region.geo, region.limit);
      } catch (error) {
        console.warn(`trends fetch failed for ${region.id}`, error);
        trends[region.id] = [];
      }
    }),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    windowHours: hours,
    tickers,
    people,
    catalysts,
    trends,
  };
}
