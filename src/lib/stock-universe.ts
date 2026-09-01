const STOCK_ANALYSIS_ORIGIN = "https://stockanalysis.com";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "daily-emails-brief/1.0",
};

type SvelteKitPayload = {
  nodes?: Array<{ type?: string; data?: unknown }>;
};

export type LargeCompanyTier = "sp500" | "large-cap";

export type LargeCompany = {
  ticker: string;
  name: string;
  marketCap?: number;
  tier: LargeCompanyTier;
};

export type CompanyProfile = {
  ticker: string;
  name?: string;
  sector?: string;
  industry?: string;
  summary?: string;
  sourceUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSvelteKit(arr: unknown[], index: unknown): unknown {
  const memo = new Map<number, unknown>();

  function resolve(idx: unknown): unknown {
    if (typeof idx !== "number") return idx;
    if (idx < 0 || idx >= arr.length) return undefined;
    if (memo.has(idx)) return memo.get(idx);

    const value = arr[idx];
    memo.set(idx, undefined);
    let result: unknown = value;
    if (Array.isArray(value)) {
      result = value.map((item) => resolve(item));
    } else if (isRecord(value)) {
      const object: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        object[key] = resolve(item);
      }
      result = object;
    }
    memo.set(idx, result);
    return result;
  }

  return resolve(index);
}

function resolvedRoots(payload: SvelteKitPayload) {
  const roots: Record<string, unknown>[] = [];
  for (const node of payload.nodes ?? []) {
    if (node.type !== "data" || !Array.isArray(node.data)) continue;
    const root = resolveSvelteKit(node.data, 0);
    if (isRecord(root)) roots.push(root);
  }
  return roots;
}

async function fetchPayload(url: string): Promise<SvelteKitPayload> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as SvelteKitPayload;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeStockTicker(ticker: string) {
  return ticker.trim().toUpperCase().replace(/[-/]/g, ".");
}

function parseCompanyList(
  payload: SvelteKitPayload,
  tier: LargeCompanyTier,
): LargeCompany[] {
  const root = resolvedRoots(payload).find((item) => Array.isArray(item.stockData));
  if (!root || !Array.isArray(root.stockData)) return [];

  return root.stockData.flatMap((item) => {
    if (!isRecord(item)) return [];
    const ticker = text(item.s);
    const name = text(item.n);
    if (!ticker || !name) return [];
    return [
      {
        ticker: normalizeStockTicker(ticker),
        name,
        marketCap: finiteNumber(item.marketCap),
        tier,
      },
    ];
  });
}

function mergeCompany(
  companies: Map<string, LargeCompany>,
  company: LargeCompany,
) {
  const previous = companies.get(company.ticker);
  if (!previous || company.tier === "sp500") {
    companies.set(company.ticker, company);
  }
}

/**
 * Current S&P 500 constituents plus stocks in Stock Analysis' large- and
 * mega-cap universes. The latter starts at a $10B market capitalization.
 */
export async function fetchLargeCompanyUniverse() {
  const urls: Array<[string, LargeCompanyTier]> = [
    [`${STOCK_ANALYSIS_ORIGIN}/list/mega-cap-stocks/__data.json`, "large-cap"],
    [`${STOCK_ANALYSIS_ORIGIN}/list/large-cap-stocks/__data.json`, "large-cap"],
    [
      `${STOCK_ANALYSIS_ORIGIN}/list/large-cap-stocks/__data.json?page=2`,
      "large-cap",
    ],
    [`${STOCK_ANALYSIS_ORIGIN}/list/sp-500-stocks/__data.json`, "sp500"],
  ];
  const results = await Promise.allSettled(
    urls.map(async ([url, tier]) => ({
      tier,
      payload: await fetchPayload(url),
    })),
  );

  const companies = new Map<string, LargeCompany>();
  for (const result of results) {
    if (result.status !== "fulfilled") {
      console.warn("stock universe: list fetch failed", result.reason);
      continue;
    }
    for (const company of parseCompanyList(result.value.payload, result.value.tier)) {
      mergeCompany(companies, company);
    }
  }
  if (companies.size === 0) {
    throw new Error("Large-cap stock universe is unavailable");
  }
  return companies;
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(html: string) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function shortBusinessSummary(html: string) {
  const firstParagraph = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? html;
  const summary = plainText(firstParagraph);
  if (summary.length <= 220) return summary;
  const sentenceEnd = summary.slice(0, 220).lastIndexOf(".");
  if (sentenceEnd >= 100) return summary.slice(0, sentenceEnd + 1);
  return `${summary.slice(0, 217).trimEnd()}…`;
}

function nestedValue(record: unknown, key: string) {
  if (!isRecord(record)) return undefined;
  return text(record[key]);
}

function parseCompanyProfile(
  payload: SvelteKitPayload,
  ticker: string,
): CompanyProfile | null {
  const root = resolvedRoots(payload).find(
    (item) => isRecord(item.profile) && typeof item.description === "string",
  );
  if (!root || !isRecord(root.profile)) return null;

  const profile = root.profile;
  const description = text(root.description);
  return {
    ticker,
    name: text(profile.name),
    sector: nestedValue(profile.sector, "value"),
    industry: nestedValue(profile.industry, "value"),
    summary: description ? shortBusinessSummary(description) : undefined,
    sourceUrl: `${STOCK_ANALYSIS_ORIGIN}/stocks/${encodeURIComponent(
      ticker.toLowerCase(),
    )}/company/`,
  };
}

async function fetchCompanyProfile(ticker: string) {
  const normalized = normalizeStockTicker(ticker);
  const symbol = encodeURIComponent(normalized.toLowerCase());
  const payload = await fetchPayload(
    `${STOCK_ANALYSIS_ORIGIN}/stocks/${symbol}/company/__data.json`,
  );
  return parseCompanyProfile(payload, normalized);
}

export async function fetchCompanyProfiles(tickers: string[]) {
  const unique = [...new Set(tickers.map(normalizeStockTicker))];
  const results = await Promise.allSettled(unique.map(fetchCompanyProfile));
  const profiles = new Map<string, CompanyProfile>();
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      profiles.set(result.value.ticker, result.value);
    } else if (result.status === "rejected") {
      console.warn("stock universe: company profile fetch failed", result.reason);
    }
  }
  return profiles;
}
