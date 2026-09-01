import { TICKERS } from "@/lib/config";
import { formatTitleDate } from "@/lib/dates";
import {
  fetchCompanyProfiles,
  fetchLargeCompanyUniverse,
  normalizeStockTicker,
  type LargeCompany,
  type LargeCompanyTier,
} from "@/lib/stock-universe";

const OPENINSIDER_ORIGIN = "http://openinsider.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const INSIDER_SOURCE_URL = OPENINSIDER_ORIGIN;
export const INSIDER_SOURCE_NAME = "OpenInsider";

const BUY_MIN_USD = 25_000;
const SELL_MIN_USD = 100_000;
const BUY_MIN_PRICE = 1;
const DISPLAY_LIMIT = 8;
const SELL_DISPLAY_LIMIT = 3;
const RANK_LIMIT = 6;
const CLUSTER_TRADES_LIMIT = 8;
const WINDOW_HOURS = 24;
const FILING_LOOKBACK_DAYS = 3;

export type InsiderSide = "buy" | "sell";

export type InsiderTrade = {
  filingAt: string;
  filingDay: string;
  filingLabel: string;
  tradeDate: string;
  ticker: string;
  company: string;
  insider: string;
  title: string;
  side: InsiderSide;
  price: number;
  qty: number;
  owned?: number;
  ownChange: string;
  valueUsd: number;
  filingUrl?: string;
  tickerUrl: string;
  officer: boolean;
  watchlist: boolean;
};

export type InsiderClusterTrade = {
  insider: string;
  title: string;
  valueUsd: number;
  tradeDate: string;
};

export type InsiderCluster = {
  ticker: string;
  company: string;
  companyTier?: LargeCompanyTier;
  marketCap?: number;
  sector?: string;
  industry?: string;
  companySummary?: string;
  companyProfileUrl?: string;
  insiderCount: number;
  titles: string[];
  titleSummary?: string;
  valueUsd: number;
  tickerUrl: string;
  watchlist: boolean;
  latestTradeDate?: string;
  trades?: InsiderClusterTrade[];
};

export type InsiderBrief = {
  collectedAt: string;
  windowLabel: string;
  usedFallbackDay: boolean;
  buys: InsiderTrade[];
  sells: InsiderTrade[];
  clusters: InsiderCluster[];
  sellGroups?: InsiderCluster[];
  watchlist: InsiderTrade[];
  buyCount: number;
  sellCount: number;
  screenedOutTickerCount?: number;
  universeLabel?: string;
  sourceUrl: string;
  sourceName: string;
  error?: string;
};

const WATCHLIST = new Set(TICKERS.map((ticker) => ticker.id.toUpperCase()));

function screenerUrl(opts: {
  purchases: boolean;
  sales: boolean;
  minValueK: number;
}) {
  const params = new URLSearchParams({
    fd: String(FILING_LOOKBACK_DAYS),
    td: "0",
    vl: String(opts.minValueK),
    sic1: "-1",
    sicl: "100",
    sich: "9999",
    grp: "0",
    sortcol: "0",
    cnt: "200",
    page: "1",
  });
  if (opts.purchases) params.set("xp", "1");
  if (opts.sales) params.set("xs", "1");
  return `${OPENINSIDER_ORIGIN}/screener?${params.toString()}`;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": BROWSER_UA,
      Referer: `${OPENINSIDER_ORIGIN}/`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(Number.parseInt(n, 16)),
    );
}

function stripTags(html: string) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function parseNumber(value: string): number | undefined {
  const n = Number(
    value.replace(/[$,+%\s]/g, "").replace(/[−–]/g, "-"),
  );
  return Number.isFinite(n) ? n : undefined;
}

function firstTinyTableBody(html: string): string {
  const table = html.match(
    /<table[^>]*class="tinytable"[^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  if (!table) return "";
  return table.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
}

function splitRows(tbody: string): string[] {
  return tbody
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((row) => row.replace(/<\/tr>/i, "").trim())
    .filter(Boolean);
}

/** OpenInsider filing stamps are America/New_York wall-clock, no offset. */
function parseEasternDateTime(value: string): Date | null {
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(utcGuess))
      .map((part) => [part.type, part.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(utcGuess - (asIfUtc - utcGuess));
}

function titleRank(title: string): number {
  const t = title.toUpperCase();
  if (/\bCEO\b/.test(t)) return 6;
  if (/\bCFO\b/.test(t)) return 5;
  if (/\bCOO\b/.test(t) || /\bPRES\b/.test(t) || /PRESIDENT/.test(t)) return 4;
  if (/\bCOB\b/.test(t) || /CHAIR/.test(t)) return 3;
  if (/\b(EVP|SVP|CTO|CMO|GC|CAO)\b/.test(t)) return 2;
  if (/\b(VP|DIR|DIRECTOR)\b/.test(t)) return 1;
  return 0;
}

function isOfficerTitle(title: string) {
  return titleRank(title) >= 2;
}

function ownChangeMagnitude(ownChange: string): number {
  if (/^new$/i.test(ownChange.trim())) return 100;
  const n = parseNumber(ownChange);
  return n == null ? 0 : Math.abs(n);
}

function tickerUrl(ticker: string) {
  return `${OPENINSIDER_ORIGIN}/${encodeURIComponent(ticker)}`;
}

function parseTradeRow(row: string): InsiderTrade | null {
  const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
    (match) => match[1],
  );
  if (cells.length < 13) return null;

  const tradeType = stripTags(cells[7]);
  const side: InsiderSide | null =
    tradeType === "P - Purchase"
      ? "buy"
      : tradeType === "S - Sale"
        ? "sell"
        : null;
  if (!side) return null;

  const filingHtml = cells[1] ?? "";
  const filingRaw = stripTags(filingHtml);
  const filingAt = parseEasternDateTime(filingRaw);
  if (!filingAt) return null;

  const ticker = (
    cells[3]?.match(/href="\/([^"?#/]+)"/i)?.[1] ??
    stripTags(cells[3] ?? "")
  )
    .replace(/\s+/g, "")
    .toUpperCase();
  const company = stripTags(cells[4] ?? "");
  const insider = stripTags(cells[5] ?? "");
  const title = stripTags(cells[6] ?? "");
  const price = parseNumber(stripTags(cells[8] ?? ""));
  const qty = parseNumber(stripTags(cells[9] ?? ""));
  const owned = parseNumber(stripTags(cells[10] ?? ""));
  const ownChange = stripTags(cells[11] ?? "");
  const valueUsd = Math.abs(parseNumber(stripTags(cells[12] ?? "")) ?? 0);
  if (!ticker || !insider || price == null || !valueUsd) return null;
  if (side === "buy" && (valueUsd < BUY_MIN_USD || price < BUY_MIN_PRICE)) {
    return null;
  }
  if (side === "sell" && valueUsd < SELL_MIN_USD) return null;

  const filingDay = filingRaw.slice(0, 10);
  return {
    filingAt: filingAt.toISOString(),
    filingDay,
    filingLabel: filingRaw.replace(/:\d{2}$/, ""),
    tradeDate: stripTags(cells[2] ?? ""),
    ticker,
    company,
    insider,
    title,
    side,
    price,
    qty: qty ?? 0,
    owned,
    ownChange,
    valueUsd,
    filingUrl: filingHtml.match(/href="([^"]+)"/i)?.[1],
    tickerUrl: tickerUrl(ticker),
    officer: isOfficerTitle(title),
    watchlist: WATCHLIST.has(ticker),
  };
}

function parseTrades(html: string): InsiderTrade[] {
  return splitRows(firstTinyTableBody(html))
    .map(parseTradeRow)
    .filter((row): row is InsiderTrade => row != null);
}

function compareTrades(a: InsiderTrade, b: InsiderTrade) {
  if (a.watchlist !== b.watchlist) return a.watchlist ? -1 : 1;
  if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd;
  const rank = titleRank(b.title) - titleRank(a.title);
  if (rank) return rank;
  return ownChangeMagnitude(b.ownChange) - ownChangeMagnitude(a.ownChange);
}

function shortRole(title: string) {
  const t = title.toUpperCase();
  if (/\bCEO\b/.test(t)) return "CEO";
  if (/\bCFO\b/.test(t)) return "CFO";
  if (/\bCOO\b/.test(t)) return "COO";
  if (/\bPRES\b/.test(t) || /PRESIDENT/.test(t)) return "Pres";
  if (/\bCOB\b/.test(t) || /CHAIR/.test(t)) return "Chair";
  if (/\bCTO\b/.test(t)) return "CTO";
  if (/\bCMO\b/.test(t)) return "CMO";
  if (/\bGC\b/.test(t)) return "GC";
  if (/\b(EVP|SVP)\b/.test(t)) return "EVP";
  if (/\b(VP|DIR|DIRECTOR)\b/.test(t)) return "Dir";
  if (/10%/.test(t)) return "10%";
  return title.split(",")[0]?.trim() || "Insider";
}

function uniquePeople(rows: InsiderTrade[]) {
  const best = new Map<string, InsiderTrade>();
  for (const row of rows) {
    const prev = best.get(row.insider);
    const rank = titleRank(row.title);
    const prevRank = prev ? titleRank(prev.title) : -1;
    if (
      !prev ||
      rank > prevRank ||
      (rank === prevRank && row.valueUsd > prev.valueUsd)
    ) {
      best.set(row.insider, row);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      titleRank(b.title) - titleRank(a.title) || b.valueUsd - a.valueUsd,
  );
}

function summarizeInsiderRoles(rows: InsiderTrade[]) {
  const shown: string[] = [];
  const people = uniquePeople(rows);
  for (const person of people) {
    if (shown.length >= 2) break;
    const role = shortRole(person.title);
    if (!shown.includes(role)) shown.push(role);
  }
  if (shown.length === 0) return "";
  const rest = people.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} + ${rest}` : shown.join(", ");
}

function latestTradeDate(rows: InsiderTrade[]) {
  let best = "";
  for (const row of rows) {
    const day = row.tradeDate.slice(0, 10);
    if (day > best) best = day;
  }
  return best;
}

export function groupTradesByTicker(trades: InsiderTrade[]): InsiderCluster[] {
  const byTicker = new Map<string, InsiderTrade[]>();
  for (const trade of trades) {
    const rows = byTicker.get(trade.ticker) ?? [];
    rows.push(trade);
    byTicker.set(trade.ticker, rows);
  }

  const groups: InsiderCluster[] = [];
  for (const [ticker, rows] of byTicker) {
    const people = uniquePeople(rows);
    const dated = [...rows].sort(
      (a, b) =>
        b.tradeDate.localeCompare(a.tradeDate) || b.valueUsd - a.valueUsd,
    );
    groups.push({
      ticker,
      company: rows[0]?.company ?? ticker,
      insiderCount: people.length,
      titles: [...new Set(rows.map((row) => row.title).filter(Boolean))].slice(
        0,
        4,
      ),
      titleSummary: summarizeInsiderRoles(rows),
      valueUsd: rows.reduce((sum, row) => sum + row.valueUsd, 0),
      tickerUrl: tickerUrl(ticker),
      watchlist: WATCHLIST.has(ticker),
      latestTradeDate: latestTradeDate(rows),
      trades: dated.slice(0, CLUSTER_TRADES_LIMIT).map((row) => ({
        insider: row.insider,
        title: row.title,
        valueUsd: row.valueUsd,
        tradeDate: row.tradeDate,
      })),
    });
  }
  return groups;
}

export function rankBuyTickers(buys: InsiderTrade[]): InsiderCluster[] {
  const ranked = groupTradesByTicker(buys).sort((a, b) => {
    if (b.insiderCount !== a.insiderCount) return b.insiderCount - a.insiderCount;
    return b.valueUsd - a.valueUsd;
  });

  const top = ranked.slice(0, RANK_LIMIT);
  const extraWatchlist = ranked.filter(
    (row) => row.watchlist && !top.some((item) => item.ticker === row.ticker),
  );
  return [...top, ...extraWatchlist];
}

export function rankSellTickers(sells: InsiderTrade[]): InsiderCluster[] {
  const ranked = groupTradesByTicker(sells)
    .map((row) => ({
      ...row,
      titleSummary: undefined,
      titles: [],
      trades: undefined,
    }))
    .sort((a, b) => {
      if (a.watchlist !== b.watchlist) return a.watchlist ? -1 : 1;
      return b.valueUsd - a.valueUsd;
    });

  const top = ranked.slice(0, SELL_DISPLAY_LIMIT);
  const extraWatchlist = ranked.filter(
    (row) => row.watchlist && !top.some((item) => item.ticker === row.ticker),
  );
  return [...top, ...extraWatchlist];
}

function latestFilingDay(trades: InsiderTrade[]): string | null {
  let best = "";
  for (const trade of trades) {
    if (trade.filingDay > best) best = trade.filingDay;
  }
  return best || null;
}

function windowLabel(usedFallbackDay: boolean, filingDay: string | null) {
  if (usedFallbackDay && filingDay) {
    return `Latest filing day · ${formatTitleDate(`${filingDay}T16:00:00Z`)}`;
  }
  return "Filed in the last 24 hours";
}

export function emptyInsiderBrief(error?: string): InsiderBrief {
  return {
    collectedAt: new Date().toISOString(),
    windowLabel: "Filed in the last 24 hours",
    usedFallbackDay: false,
    buys: [],
    sells: [],
    clusters: [],
    sellGroups: [],
    watchlist: [],
    buyCount: 0,
    sellCount: 0,
    screenedOutTickerCount: 0,
    universeLabel: "S&P 500 + $10B large caps",
    sourceUrl: INSIDER_SOURCE_URL,
    sourceName: INSIDER_SOURCE_NAME,
    error,
  };
}

export function formatInsiderUsd(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${Math.round(abs)}`;
}

export function hasInsiderTrades(brief?: InsiderBrief | null) {
  if (!brief) return false;
  return (
    brief.buys.length > 0 ||
    brief.sells.length > 0 ||
    brief.watchlist.length > 0 ||
    (brief.clusters?.length ?? 0) > 0 ||
    (brief.sellGroups?.length ?? 0) > 0
  );
}

/**
 * Open-market Form 4 purchases and sales from OpenInsider.
 * Uses filing time (when the trade became public), not trade date.
 * Falls back to the latest filing day when the rolling 24h window is empty
 * (weekends / Monday 09:00 UTC cron).
 */
export async function collectInsiderTrades(): Promise<InsiderBrief> {
  const collectedAt = new Date().toISOString();
  const buyUrl = screenerUrl({
    purchases: true,
    sales: false,
    minValueK: BUY_MIN_USD / 1000,
  });
  const sellUrl = screenerUrl({
    purchases: false,
    sales: true,
    minValueK: SELL_MIN_USD / 1000,
  });

  try {
    const [buyHtml, sellHtml] = await Promise.all([
      fetchHtml(buyUrl),
      fetchHtml(sellUrl),
    ]);
    const parsed = [...parseTrades(buyHtml), ...parseTrades(sellHtml)];
    if (parsed.length === 0) {
      return emptyInsiderBrief("OpenInsider tables could not be parsed");
    }

    const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
    const last24h = parsed.filter(
      (trade) => new Date(trade.filingAt).getTime() >= cutoff,
    );
    const fallbackDay = latestFilingDay(parsed);
    const usedFallbackDay = last24h.length === 0;
    const windowTrades = usedFallbackDay
      ? parsed.filter((trade) => trade.filingDay === fallbackDay)
      : last24h;

    const universe = await fetchLargeCompanyUniverse();
    const eligibleTrades = windowTrades.filter((trade) =>
      universe.has(normalizeStockTicker(trade.ticker)),
    );
    const allTickers = new Set(
      windowTrades.map((trade) => normalizeStockTicker(trade.ticker)),
    );
    const eligibleTickers = new Set(
      eligibleTrades.map((trade) => normalizeStockTicker(trade.ticker)),
    );
    const screenedOutTickerCount = [...allTickers].filter(
      (ticker) => !eligibleTickers.has(ticker),
    ).length;

    const windowBuys = eligibleTrades.filter((trade) => trade.side === "buy");
    const windowSells = eligibleTrades.filter((trade) => trade.side === "sell");
    const watchlist = eligibleTrades
      .filter((trade) => trade.watchlist)
      .sort(compareTrades);
    const buyGroups = rankBuyTickers(windowBuys);
    const sellGroups = rankSellTickers(windowSells);
    const displayedTickers = [
      ...new Set(
        [...buyGroups, ...sellGroups].map((group) =>
          normalizeStockTicker(group.ticker),
        ),
      ),
    ];
    const profiles = await fetchCompanyProfiles(displayedTickers);

    function enrichGroup(group: InsiderCluster): InsiderCluster {
      const normalizedTicker = normalizeStockTicker(group.ticker);
      const company: LargeCompany | undefined = universe.get(normalizedTicker);
      const profile = profiles.get(normalizedTicker);
      return {
        ...group,
        company: profile?.name || company?.name || group.company,
        companyTier: company?.tier,
        marketCap: company?.marketCap,
        sector: profile?.sector,
        industry: profile?.industry,
        companySummary: profile?.summary,
        companyProfileUrl: profile?.sourceUrl,
      };
    }

    return {
      collectedAt,
      windowLabel: windowLabel(usedFallbackDay, fallbackDay),
      usedFallbackDay,
      buys: [...windowBuys].sort(compareTrades).slice(0, DISPLAY_LIMIT),
      sells: [...windowSells].sort(compareTrades).slice(0, SELL_DISPLAY_LIMIT),
      clusters: buyGroups.map(enrichGroup),
      sellGroups: sellGroups.map(enrichGroup),
      watchlist,
      buyCount: windowBuys.length,
      sellCount: windowSells.length,
      screenedOutTickerCount,
      universeLabel: "S&P 500 + $10B large caps",
      sourceUrl: INSIDER_SOURCE_URL,
      sourceName: INSIDER_SOURCE_NAME,
    };
  } catch (error) {
    console.warn("openinsider: fetch failed", error);
    return emptyInsiderBrief(
      error instanceof Error ? error.message : "OpenInsider fetch failed",
    );
  }
}
