import { TICKERS } from "@/lib/config";

export const SENTIMENT_BANDS = [
  "Extreme Fear",
  "Fear",
  "Neutral",
  "Greed",
  "Extreme Greed",
] as const;

export type SentimentBand = (typeof SENTIMENT_BANDS)[number];

export type ValueStance = "Lean buy" | "Neutral" | "Patience";

export type FearGreedMeter = {
  id: "cnn" | "crypto" | "vix";
  label: string;
  /** CNN/Crypto: 0–100. VIX: index level. */
  value: number | null;
  band: SentimentBand | null;
  previousClose?: number;
  previous1Week?: number;
  changeDay?: number;
  changeWeek?: number;
  /**
   * Daily closes oldest→newest (VIX only). Roughly ~3 months from the quote API.
   */
  history?: number[];
  asOf?: string;
  sourceUrl: string;
  error?: string;
};

export type TickerGreedProxy = {
  tickerId: string;
  label: string;
  quoteSymbol?: string;
  price?: number;
  high52w?: number;
  low52w?: number;
  /** % below 52-week high (negative when below highs) */
  drawdownFromHighPct?: number;
  /** Where price sits in the 52-week range (0 = low, 100 = high) */
  rangePositionPct?: number;
  rsi14?: number;
  /** Composite 0–100 greed proxy (higher = hotter / less attractive for value adds) */
  score?: number;
  band?: SentimentBand;
  stance?: ValueStance;
  asOf?: string;
  error?: string;
};

export type SentimentReport = {
  collectedAt: string;
  meters: FearGreedMeter[];
  tickers: TickerGreedProxy[];
  /** Short value-investor dial from the three Tier-1 meters */
  valueDial: string;
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function bandFromScore(score: number): SentimentBand {
  if (score <= 24) return "Extreme Fear";
  if (score <= 44) return "Fear";
  if (score <= 55) return "Neutral";
  if (score <= 75) return "Greed";
  return "Extreme Greed";
}

/** VIX is inverted vs F&G: high VIX = fear */
function bandFromVix(vix: number): SentimentBand {
  if (vix >= 30) return "Extreme Fear";
  if (vix >= 25) return "Fear";
  if (vix >= 20) return "Neutral";
  if (vix >= 15) return "Greed";
  return "Extreme Greed";
}

function stanceFromScore(score: number): ValueStance {
  if (score <= 25) return "Lean buy";
  if (score <= 60) return "Neutral";
  return "Patience";
}

function titleCaseRating(raw: string): SentimentBand | null {
  const normalized = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  const map: Record<string, SentimentBand> = {
    "extreme fear": "Extreme Fear",
    fear: "Fear",
    neutral: "Neutral",
    greed: "Greed",
    "extreme greed": "Extreme Greed",
  };
  return map[normalized] ?? null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Wilder RSI(14) from closing prices (oldest → newest). */
export function computeRsi14(closes: number[]): number | null {
  const period = 14;
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round1(100 - 100 / (1 + rs));
}

function buildProxy(args: {
  tickerId: string;
  label: string;
  quoteSymbol: string;
  price: number;
  high52w: number;
  low52w: number;
  closesOldestFirst: number[];
  asOf?: string;
}): TickerGreedProxy {
  const {
    tickerId,
    label,
    quoteSymbol,
    price,
    high52w,
    low52w,
    closesOldestFirst,
    asOf,
  } = args;

  if (!(price > 0) || !(high52w > 0) || !(low52w > 0)) {
    return {
      tickerId,
      label,
      quoteSymbol,
      error: "Incomplete quote data",
    };
  }

  const rsi14 = computeRsi14(closesOldestFirst);
  const drawdownFromHighPct = round1((price / high52w - 1) * 100);
  const rangeWidth = high52w - low52w;
  const rangePositionPct =
    rangeWidth > 0
      ? round1(Math.min(100, Math.max(0, ((price - low52w) / rangeWidth) * 100)))
      : 50;

  const scoreParts = [rangePositionPct];
  if (rsi14 !== null) scoreParts.push(rsi14);
  const score = Math.round(
    scoreParts.reduce((sum, n) => sum + n, 0) / scoreParts.length,
  );

  return {
    tickerId,
    label,
    quoteSymbol,
    price: round2(price),
    high52w: round2(high52w),
    low52w: round2(low52w),
    drawdownFromHighPct,
    rangePositionPct,
    rsi14: rsi14 ?? undefined,
    score,
    band: bandFromScore(score),
    stance: stanceFromScore(score),
    asOf,
  };
}

async function fetchCnnFearGreed(): Promise<FearGreedMeter> {
  const sourceUrl = "https://www.cnn.com/markets/fear-and-greed";
  const base: FearGreedMeter = {
    id: "cnn",
    label: "Stocks Fear & Greed",
    value: null,
    band: null,
    sourceUrl,
  };

  try {
    const response = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        headers: {
          Accept: "application/json",
          "User-Agent": BROWSER_UA,
          Referer: sourceUrl,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` };
    }

    const json = (await response.json()) as {
      fear_and_greed?: {
        score?: number;
        rating?: string;
        timestamp?: string;
        previous_close?: number;
        previous_1_week?: number;
      };
    };
    const fg = json.fear_and_greed;
    if (typeof fg?.score !== "number" || !Number.isFinite(fg.score)) {
      return { ...base, error: "Missing score" };
    }

    const value = round1(fg.score);
    const previousClose =
      typeof fg.previous_close === "number" ? round1(fg.previous_close) : undefined;
    const previous1Week =
      typeof fg.previous_1_week === "number" ? round1(fg.previous_1_week) : undefined;

    return {
      ...base,
      value,
      band: titleCaseRating(fg.rating ?? "") ?? bandFromScore(value),
      previousClose,
      previous1Week,
      changeDay:
        previousClose !== undefined ? round1(value - previousClose) : undefined,
      changeWeek:
        previous1Week !== undefined ? round1(value - previous1Week) : undefined,
      asOf: fg.timestamp,
    };
  } catch (error) {
    console.warn("sentiment: CNN F&G failed", error);
    return {
      ...base,
      error: error instanceof Error ? error.message : "Fetch failed",
    };
  }
}

async function fetchCryptoFearGreed(): Promise<FearGreedMeter> {
  const sourceUrl = "https://alternative.me/crypto/fear-and-greed-index/";
  const base: FearGreedMeter = {
    id: "crypto",
    label: "Crypto Fear & Greed",
    value: null,
    band: null,
    sourceUrl,
  };

  try {
    const response = await fetch("https://api.alternative.me/fng/?limit=8", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` };
    }

    const json = (await response.json()) as {
      data?: Array<{
        value?: string;
        value_classification?: string;
        timestamp?: string;
      }>;
    };
    const rows = json.data ?? [];
    const latest = rows[0];
    const value = Number.parseFloat(latest?.value ?? "");
    if (!Number.isFinite(value)) {
      return { ...base, error: "Missing score" };
    }

    const previousClose = Number.parseFloat(rows[1]?.value ?? "");
    const previous1Week = Number.parseFloat(rows[7]?.value ?? "");
    const ts = Number.parseInt(latest?.timestamp ?? "", 10);

    return {
      ...base,
      value: round1(value),
      band:
        titleCaseRating(latest?.value_classification ?? "") ??
        bandFromScore(value),
      previousClose: Number.isFinite(previousClose)
        ? round1(previousClose)
        : undefined,
      previous1Week: Number.isFinite(previous1Week)
        ? round1(previous1Week)
        : undefined,
      changeDay: Number.isFinite(previousClose)
        ? round1(value - previousClose)
        : undefined,
      changeWeek: Number.isFinite(previous1Week)
        ? round1(value - previous1Week)
        : undefined,
      asOf: Number.isFinite(ts)
        ? new Date(ts * 1000).toISOString()
        : undefined,
    };
  } catch (error) {
    console.warn("sentiment: crypto F&G failed", error);
    return {
      ...base,
      error: error instanceof Error ? error.message : "Fetch failed",
    };
  }
}

/** Live VIX quote + ~3 months of daily closes (for markets page chart). */
export async function fetchVixMeter(): Promise<FearGreedMeter> {
  const sourceUrl = "https://www.cboe.com/tradable_products/vix/";
  const base: FearGreedMeter = {
    id: "vix",
    label: "VIX",
    value: null,
    band: null,
    sourceUrl,
  };

  try {
    // feargreedchart caches Yahoo-derived market quotes (including ^VIX).
    const response = await fetch("https://feargreedchart.com/api/?action=all", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` };
    }

    const json = (await response.json()) as {
      market?: Record<
        string,
        { price?: number; chg?: number; closes?: number[] }
      >;
      ts?: number;
    };
    const vix = json.market?.["^VIX"];
    const value = vix?.price;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ...base, error: "Missing quote" };
    }

    const closes = (Array.isArray(vix?.closes) ? vix.closes : []).filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n),
    );
    const history =
      closes.length > 0
        ? closes.map(round2)
        : [round2(value)];
    // Keep the latest close aligned with the live quote when the series lags.
    if (history[history.length - 1] !== round2(value)) {
      history.push(round2(value));
    }

    const previousClose =
      history.length >= 2
        ? history[history.length - 2]
        : typeof vix?.chg === "number"
          ? round2(value - vix.chg)
          : undefined;
    const previous1Week =
      history.length >= 6 ? history[history.length - 6] : undefined;

    return {
      ...base,
      value: round2(value),
      band: bandFromVix(value),
      previousClose,
      previous1Week,
      changeDay:
        previousClose !== undefined ? round2(value - previousClose) : undefined,
      changeWeek:
        previous1Week !== undefined ? round2(value - previous1Week) : undefined,
      history,
      asOf:
        typeof json.ts === "number"
          ? new Date(json.ts).toISOString()
          : undefined,
    };
  } catch (error) {
    console.warn("sentiment: VIX failed", error);
    return {
      ...base,
      error: error instanceof Error ? error.message : "Fetch failed",
    };
  }
}

type StockAnalysisQuote = {
  p?: number;
  pd?: number;
  cl?: number;
  h52?: number;
  l52?: number;
  td?: string;
  ts?: number;
};

type StockAnalysisHistoryRow = {
  c?: number;
  t?: string;
};

async function fetchStockAnalysisProxy(
  tickerId: string,
  label: string,
  quoteSymbol: string,
): Promise<TickerGreedProxy> {
  const symbol = quoteSymbol.toLowerCase();
  const headers = {
    Accept: "application/json",
    "User-Agent": "daily-emails-brief/1.0",
  };

  try {
    const [quoteRes, historyRes] = await Promise.all([
      fetch(`https://stockanalysis.com/api/quotes/s/${encodeURIComponent(symbol)}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      }),
      fetch(
        `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(symbol)}/history`,
        {
          headers,
          signal: AbortSignal.timeout(15000),
        },
      ),
    ]);

    if (!quoteRes.ok) {
      return {
        tickerId,
        label,
        quoteSymbol,
        error: `Quote HTTP ${quoteRes.status}`,
      };
    }

    const quoteJson = (await quoteRes.json()) as {
      data?: StockAnalysisQuote;
    };
    const quote = quoteJson.data;
    const price = quote?.p ?? quote?.pd;
    const high52w = quote?.h52;
    const low52w = quote?.l52;
    if (
      typeof price !== "number" ||
      typeof high52w !== "number" ||
      typeof low52w !== "number"
    ) {
      return {
        tickerId,
        label,
        quoteSymbol,
        error: "Incomplete quote data",
      };
    }

    let closesOldestFirst: number[] = [];
    if (historyRes.ok) {
      const historyJson = (await historyRes.json()) as {
        data?: { data?: StockAnalysisHistoryRow[] };
      };
      const rows = historyJson.data?.data ?? [];
      // API returns newest-first.
      closesOldestFirst = rows
        .slice()
        .reverse()
        .map((row) => row.c)
        .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
    }

    return buildProxy({
      tickerId,
      label,
      quoteSymbol,
      price,
      high52w,
      low52w,
      closesOldestFirst,
      asOf:
        typeof quote?.ts === "number"
          ? new Date(quote.ts).toISOString()
          : quote?.td,
    });
  } catch (error) {
    console.warn(`sentiment: stockanalysis ${quoteSymbol} failed`, error);
    return {
      tickerId,
      label,
      quoteSymbol,
      error: error instanceof Error ? error.message : "Fetch failed",
    };
  }
}

async function fetchBitcoinProxy(
  tickerId: string,
  label: string,
): Promise<TickerGreedProxy> {
  const quoteSymbol = "BTC-USD";
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily",
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      return {
        tickerId,
        label,
        quoteSymbol,
        error: `HTTP ${response.status}`,
      };
    }

    const json = (await response.json()) as {
      prices?: Array<[number, number]>;
    };
    const points = (json.prices ?? []).filter(
      (point): point is [number, number] =>
        Array.isArray(point) &&
        typeof point[0] === "number" &&
        typeof point[1] === "number",
    );
    if (points.length < 20) {
      return {
        tickerId,
        label,
        quoteSymbol,
        error: "Insufficient history",
      };
    }

    const closesOldestFirst = points.map(([, price]) => price);
    const price = closesOldestFirst[closesOldestFirst.length - 1]!;
    const high52w = Math.max(...closesOldestFirst);
    const low52w = Math.min(...closesOldestFirst);
    const asOf = new Date(points[points.length - 1]![0]).toISOString();

    return buildProxy({
      tickerId,
      label,
      quoteSymbol,
      price,
      high52w,
      low52w,
      closesOldestFirst,
      asOf,
    });
  } catch (error) {
    console.warn("sentiment: bitcoin proxy failed", error);
    return {
      tickerId,
      label,
      quoteSymbol,
      error: error instanceof Error ? error.message : "Fetch failed",
    };
  }
}

async function fetchTickerProxies(): Promise<TickerGreedProxy[]> {
  return Promise.all(
    TICKERS.map(async (ticker) => {
      const quoteSymbol = ticker.quoteSymbol;
      if (!quoteSymbol) {
        return {
          tickerId: ticker.id,
          label: ticker.label,
          error: "No public quote (private / unlisted)",
        } satisfies TickerGreedProxy;
      }

      if (quoteSymbol === "BTC-USD") {
        return fetchBitcoinProxy(ticker.id, ticker.label);
      }

      return fetchStockAnalysisProxy(ticker.id, ticker.label, quoteSymbol);
    }),
  );
}

function buildValueDial(meters: FearGreedMeter[]): string {
  const cnn = meters.find((m) => m.id === "cnn");
  const crypto = meters.find((m) => m.id === "crypto");
  const vix = meters.find((m) => m.id === "vix");

  const fearSignals: string[] = [];
  const greedSignals: string[] = [];

  if (cnn?.value != null && cnn.band) {
    if (cnn.value <= 25) fearSignals.push(`Stocks ${cnn.value} (${cnn.band})`);
    else if (cnn.value >= 75) greedSignals.push(`Stocks ${cnn.value} (${cnn.band})`);
  }
  if (crypto?.value != null && crypto.band) {
    if (crypto.value <= 25)
      fearSignals.push(`Crypto ${crypto.value} (${crypto.band})`);
    else if (crypto.value >= 75)
      greedSignals.push(`Crypto ${crypto.value} (${crypto.band})`);
  }
  if (vix?.value != null && vix.band) {
    if (vix.value >= 25) fearSignals.push(`VIX ${vix.value} (${vix.band})`);
    else if (vix.value < 15)
      greedSignals.push(`VIX ${vix.value} (${vix.band})`);
  }

  if (fearSignals.length >= 2) {
    return `Favorable for value adds — elevated fear: ${fearSignals.join("; ")}.`;
  }
  if (greedSignals.length >= 2) {
    return `Prefer patience / smaller size — elevated greed: ${greedSignals.join("; ")}.`;
  }
  if (fearSignals.length === 1 && greedSignals.length === 0) {
    return `Mixed-to-fearful — one fear signal (${fearSignals[0]}); stock-pick on valuation.`;
  }
  if (greedSignals.length === 1 && fearSignals.length === 0) {
    return `Mixed-to-greedy — one greed signal (${greedSignals[0]}); avoid FOMO sizing.`;
  }

  const parts = [cnn, crypto, vix]
    .filter((m): m is FearGreedMeter => Boolean(m?.value != null && m.band))
    .map((m) =>
      m.id === "vix"
        ? `VIX ${m.value} (${m.band})`
        : `${m.id === "cnn" ? "Stocks" : "Crypto"} ${m.value} (${m.band})`,
    );

  if (parts.length === 0) {
    return "Sentiment meters unavailable today — rely on valuation and catalysts.";
  }
  return `Neutral dial — ${parts.join(" · ")}. Size adds from valuation, not mood.`;
}

export async function collectSentiment(): Promise<SentimentReport> {
  const [cnn, crypto, vix, tickers] = await Promise.all([
    fetchCnnFearGreed(),
    fetchCryptoFearGreed(),
    fetchVixMeter(),
    fetchTickerProxies(),
  ]);

  const meters = [cnn, crypto, vix];
  return {
    collectedAt: new Date().toISOString(),
    meters,
    tickers,
    valueDial: buildValueDial(meters),
  };
}
