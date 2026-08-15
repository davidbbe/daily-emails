import { TICKERS } from "@/lib/config";

export type TickerValuation = {
  tickerId: string;
  quoteSymbol: string;
  /** Trailing PE */
  pe?: number;
  forwardPe?: number;
  /** Free-cash-flow yield as a decimal (0.018 = 1.8%) */
  fcfYield?: number;
  peg?: number;
  evEbitda?: number;
  /** Net debt / EBITDA. Negative means net cash. */
  netDebtEbitda?: number;
  /** Average trailing PE over completed fiscal years (up to 5). */
  pe5yAvg?: number;
  /** Return on invested capital as a decimal (0.26 = 26%) */
  roic?: number;
  sourceUrl: string;
  error?: string;
};

export type ValuationMetric = {
  key: string;
  label: string;
  value: string;
};

type SvelteKitPayload = {
  type?: string;
  nodes?: Array<{ type?: string; data?: unknown }>;
};

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "daily-emails-brief/1.0",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSvelteKit(arr: unknown[], index: unknown): unknown {
  const memo = new Map<number, unknown>();

  function resolve(idx: unknown): unknown {
    if (typeof idx !== "number") return idx;
    if (idx < 0) return undefined;
    if (memo.has(idx)) return memo.get(idx);
    if (idx >= arr.length) return undefined;

    const val = arr[idx];
    memo.set(idx, undefined);
    let out: unknown = val;
    if (Array.isArray(val)) {
      out = val.map((item) => resolve(item));
    } else if (isRecord(val)) {
      const obj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(val)) {
        obj[key] = resolve(value);
      }
      out = obj;
    }
    memo.set(idx, out);
    return out;
  }

  return resolve(index);
}

function findResolvedNode(
  payload: SvelteKitPayload,
  predicate: (root: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (const node of payload.nodes ?? []) {
    if (node.type !== "data" || !Array.isArray(node.data)) continue;
    const root = resolveSvelteKit(node.data, 0);
    if (isRecord(root) && predicate(root)) return root;
  }
  return null;
}

function parseMetricNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /^n\/?a$/i.test(trimmed) || trimmed === "—" || trimmed === "-") {
    return undefined;
  }
  const isPercent = trimmed.endsWith("%");
  const cleaned = trimmed.replace(/[$,%]/g, "").replace(/,/g, "");
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return isPercent ? n / 100 : n;
}

function metricMap(section: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!isRecord(section) || !Array.isArray(section.data)) return map;
  for (const row of section.data) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const n = parseMetricNumber(row.hover) ?? parseMetricNumber(row.value);
    if (n !== undefined) map.set(row.id, n);
  }
  return map;
}

function finitePositive(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function finiteNumber(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return n;
}

function roundTo(n: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function formatMultiple(n: number) {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : 1;
  return `${n.toFixed(digits)}×`;
}

function formatPercent(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

function average(values: number[]) {
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`valuation: ${url} HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    console.warn(`valuation: fetch failed ${url}`, error);
    return null;
  }
}

function statsUrl(symbol: string) {
  const s = encodeURIComponent(symbol.toLowerCase());
  return `https://stockanalysis.com/stocks/${s}/statistics/__data.json`;
}

function ratiosUrl(symbol: string) {
  const s = encodeURIComponent(symbol.toLowerCase());
  return `https://stockanalysis.com/stocks/${s}/financials/ratios/__data.json`;
}

function sourceUrl(symbol: string) {
  return `https://stockanalysis.com/stocks/${symbol.toLowerCase()}/statistics/`;
}

function fromStatistics(root: Record<string, unknown>): Partial<TickerValuation> {
  const ratios = metricMap(root.ratios);
  const ev = metricMap(root.evRatios);
  const efficiency = metricMap(root.financialEfficiency);
  const dividends = metricMap(root.dividends);
  const balance = metricMap(root.balanceSheet);
  const income = metricMap(root.incomeStatement);

  const pfcf = finitePositive(ratios.get("pfcf"));
  const fcfYield =
    finiteNumber(dividends.get("fcfYield")) ??
    (pfcf ? 1 / pfcf : undefined);

  const netCash = finiteNumber(balance.get("netcash"));
  const ebitda = finiteNumber(income.get("ebitda"));
  const netDebtEbitda =
    netCash !== undefined && ebitda !== undefined && ebitda !== 0
      ? -netCash / ebitda
      : undefined;
  const roic = finiteNumber(efficiency.get("roic"));

  return {
    pe: finitePositive(ratios.get("pe")),
    forwardPe: finitePositive(ratios.get("peForward")),
    fcfYield: fcfYield !== undefined ? roundTo(fcfYield, 5) : undefined,
    peg: finitePositive(ratios.get("pegRatio")),
    evEbitda: finitePositive(ev.get("evEbitda")),
    netDebtEbitda:
      netDebtEbitda !== undefined ? roundTo(netDebtEbitda, 3) : undefined,
    roic: roic !== undefined ? roundTo(roic, 5) : undefined,
  };
}

function pe5yAvgFromRatios(root: Record<string, unknown>): number | undefined {
  if (!isRecord(root.financialData)) return undefined;
  const datekey = root.financialData.datekey;
  const pe = root.financialData.pe;
  if (!Array.isArray(pe)) return undefined;

  const keys = Array.isArray(datekey) ? datekey : [];
  const historical: number[] = [];
  for (let i = 0; i < pe.length && historical.length < 5; i++) {
    if (keys[i] === "TTM") continue;
    const n = parseMetricNumber(pe[i]);
    if (n !== undefined && n > 0) historical.push(n);
  }
  if (historical.length < 3) return undefined;
  return roundTo(average(historical), 3);
}

async function fetchTickerValuation(
  tickerId: string,
  quoteSymbol: string,
): Promise<TickerValuation> {
  const source = sourceUrl(quoteSymbol);
  const base: TickerValuation = {
    tickerId,
    quoteSymbol,
    sourceUrl: source,
  };

  const [statsJson, ratiosJson] = await Promise.all([
    fetchJson(statsUrl(quoteSymbol)),
    fetchJson(ratiosUrl(quoteSymbol)),
  ]);

  const statsRoot =
    isRecord(statsJson) && Array.isArray(statsJson.nodes)
      ? findResolvedNode(statsJson as SvelteKitPayload, (root) =>
          Boolean(root.ratios && root.evRatios),
        )
      : null;

  if (!statsRoot) {
    return { ...base, error: "No statistics available" };
  }

  const current = fromStatistics(statsRoot);
  const ratiosRoot =
    isRecord(ratiosJson) && Array.isArray(ratiosJson.nodes)
      ? findResolvedNode(ratiosJson as SvelteKitPayload, (root) =>
          isRecord(root.financialData),
        )
      : null;

  return {
    ...base,
    ...current,
    pe5yAvg: ratiosRoot ? pe5yAvgFromRatios(ratiosRoot) : undefined,
  };
}

export function hasValuationMetrics(valuation: TickerValuation) {
  return (
    valuation.pe != null ||
    valuation.forwardPe != null ||
    valuation.fcfYield != null ||
    valuation.peg != null ||
    valuation.evEbitda != null ||
    valuation.netDebtEbitda != null
  );
}

export function valuationMetrics(valuation: TickerValuation): ValuationMetric[] {
  const rows: ValuationMetric[] = [];
  if (valuation.pe != null) {
    rows.push({ key: "pe", label: "PE", value: formatMultiple(valuation.pe) });
  }
  if (valuation.forwardPe != null) {
    rows.push({
      key: "forwardPe",
      label: "Fwd PE",
      value: formatMultiple(valuation.forwardPe),
    });
  }
  if (valuation.fcfYield != null) {
    rows.push({
      key: "fcfYield",
      label: "FCF yield",
      value: formatPercent(valuation.fcfYield),
    });
  }
  if (valuation.peg != null) {
    rows.push({
      key: "peg",
      label: "PEG",
      value: valuation.peg.toFixed(2),
    });
  }
  if (valuation.evEbitda != null) {
    rows.push({
      key: "evEbitda",
      label: "EV/EBITDA",
      value: formatMultiple(valuation.evEbitda),
    });
  }
  if (valuation.netDebtEbitda != null) {
    const netCash = valuation.netDebtEbitda < 0;
    rows.push({
      key: "netDebtEbitda",
      label: netCash ? "Net cash / EBITDA" : "Net debt / EBITDA",
      value: formatMultiple(Math.abs(valuation.netDebtEbitda)),
    });
  }
  return rows;
}

export function valuationContextLine(valuation: TickerValuation): string | undefined {
  const parts: string[] = [];
  if (valuation.forwardPe != null && valuation.pe5yAvg != null) {
    parts.push(
      `Forward PE ${formatMultiple(valuation.forwardPe)} vs 5y avg ${formatMultiple(valuation.pe5yAvg)}`,
    );
  } else if (valuation.forwardPe != null) {
    parts.push(`Forward PE ${formatMultiple(valuation.forwardPe)}`);
  }
  if (valuation.roic != null) {
    parts.push(`ROIC ${formatPercent(valuation.roic, 0)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function isCryptoQuote(quoteSymbol: string) {
  return quoteSymbol.toUpperCase().endsWith("-USD");
}

/** Value-investor snapshot for listed equity tickers. */
export async function collectValuation(): Promise<TickerValuation[]> {
  const results = await Promise.all(
    TICKERS.map(async (ticker) => {
      if (isCryptoQuote(ticker.quoteSymbol)) return null;
      return fetchTickerValuation(ticker.id, ticker.quoteSymbol);
    }),
  );

  const order = new Map<string, number>(
    TICKERS.map((ticker, index) => [ticker.id, index]),
  );
  return results
    .filter((row): row is TickerValuation => Boolean(row))
    .sort((a, b) => (order.get(a.tickerId) ?? 0) - (order.get(b.tickerId) ?? 0));
}
