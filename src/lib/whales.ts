const DATAROMA_ORIGIN = "https://www.dataroma.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const WHALE_SOURCE_URL = `${DATAROMA_ORIGIN}/m/allact.php?typ=a`;
export const WHALE_SOURCE_NAME = "Dataroma";

export type WhaleAction = "Buy" | "Add" | "Sell" | "Reduce";

export type WhaleClusterBuy = {
  ticker: string;
  name: string;
  buyerCount: number;
  portfolioWeightPct?: number;
};

export type WhaleManagerMove = {
  manager: string;
  period: string;
  ticker: string;
  name: string;
  action: WhaleAction;
  shareChangePct?: number;
  portfolioPct: number;
};

export type WhaleRealtimeBuy = {
  date: string;
  filer: string;
  security: string;
  totalUsd: number;
  filingUrl?: string;
};

export type WhaleSectorWeight = {
  sector: string;
  holdingsPct: number;
};

export type WhaleResearch = {
  collectedAt: string;
  quarterLabel: string;
  filingsSoFar?: number;
  filingsTotal?: number;
  buyAddCount?: number;
  clusterBuys: WhaleClusterBuy[];
  managerMoves: WhaleManagerMove[];
  realtimeBuys: WhaleRealtimeBuy[];
  sectors: WhaleSectorWeight[];
  sourceUrl: string;
  error?: string;
};

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": BROWSER_UA,
      Referer: `${DATAROMA_ORIGIN}/m/home.php`,
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
  const n = Number(value.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function firstTbody(html: string): string {
  return html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
}

function splitRows(tbody: string): string[] {
  return tbody
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((row) => row.replace(/<\/tr>/i, "").trim())
    .filter(Boolean);
}

function parseQuarterLabel(html: string): string | undefined {
  const match = html.match(/\b(Q[1-4]\s+20\d{2})\b/);
  return match?.[1];
}

function parseFilingsProgress(html: string): {
  filingsSoFar?: number;
  filingsTotal?: number;
} {
  const match = html.match(
    /Based on\s+(\d+)\s+out of\s+(\d+)\s+SuperInvestor filings/i,
  );
  if (!match) return {};
  return {
    filingsSoFar: Number(match[1]),
    filingsTotal: Number(match[2]),
  };
}

function parseClusterBuys(html: string): {
  quarterLabel?: string;
  buyAddCount?: number;
  rows: WhaleClusterBuy[];
} {
  const buyAddCount = parseNumber(
    html.match(/No\.\s+of buys\/adds[^<]*<b>([\d,]+)<\/b>/i)?.[1] ?? "",
  );
  const tbody = firstTbody(html);
  const rows: WhaleClusterBuy[] = [];

  for (const row of splitRows(tbody)) {
    const ticker = stripTags(
      row.match(/<td class="sym">([\s\S]*?)<\/td>/i)?.[1] ?? "",
    );
    const name = stripTags(
      row.match(/<td class="stock">([\s\S]*?)<\/td>/i)?.[1] ?? "",
    );
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      stripTags(m[1]),
    );
    if (!ticker || !name || cells.length < 4) continue;
    const buyerCount = parseNumber(cells[3]);
    const portfolioWeightPct = parseNumber(cells[2]);
    if (!buyerCount || buyerCount < 1) continue;
    rows.push({
      ticker,
      name,
      buyerCount,
      portfolioWeightPct,
    });
  }

  return {
    quarterLabel: parseQuarterLabel(html),
    buyAddCount,
    rows: rows.slice(0, 40),
  };
}

function parseActionLine(line: string): {
  action: WhaleAction;
  shareChangePct?: number;
} | null {
  const match = line
    .trim()
    .match(/^(Buy|Add|Sell|Reduce)(?:\s+(-?[\d.]+)%)?$/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const action: WhaleAction =
    raw === "buy"
      ? "Buy"
      : raw === "add"
        ? "Add"
        : raw === "sell"
          ? "Sell"
          : "Reduce";
  const shareChangePct = match[2] ? Number(match[2]) : undefined;
  return {
    action,
    shareChangePct: Number.isFinite(shareChangePct) ? shareChangePct : undefined,
  };
}

function parseManagerMoves(html: string): WhaleManagerMove[] {
  const tbody = firstTbody(html);
  const moves: WhaleManagerMove[] = [];

  for (const row of splitRows(tbody)) {
    const manager = stripTags(
      row.match(/<td class="firm">([\s\S]*?)<\/td>/i)?.[1] ?? "",
    );
    const period = stripTags(
      row.match(/<td class="period">([\s\S]*?)<\/td>/i)?.[1] ?? "",
    );
    if (!manager || !period) continue;

    const cells = [...row.matchAll(/<td class="sym">([\s\S]*?)<\/td>/gi)];
    for (const cell of cells) {
      const inner = cell[1];
      const ticker = stripTags(
        inner.match(/<a class="(?:buy|sell)"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "",
      );
      const detailHtml = inner.match(/<div>([\s\S]*?)<\/div>/i)?.[1];
      if (!ticker || !detailHtml) continue;

      const parts = detailHtml
        .split(/<br\s*\/?>/i)
        .map((part) => stripTags(part))
        .filter(Boolean);
      const name = parts[0] ?? ticker;
      const parsedAction = parts[1] ? parseActionLine(parts[1]) : null;
      const portfolioPct = parseNumber(
        parts.find((part) => /change to portfolio/i.test(part))?.replace(
          /change to portfolio:\s*/i,
          "",
        ) ?? "",
      );
      if (!parsedAction || portfolioPct == null) continue;
      if (portfolioPct > 80) continue;

      moves.push({
        manager,
        period,
        ticker,
        name,
        action: parsedAction.action,
        shareChangePct: parsedAction.shareChangePct,
        portfolioPct,
      });
    }
  }

  return moves;
}

function parseRealtimeBuys(html: string): WhaleRealtimeBuy[] {
  const tbody = firstTbody(html);
  const aggregated = new Map<string, WhaleRealtimeBuy>();

  for (const row of splitRows(tbody)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 8) continue;
    const activity = stripTags(cells[3]?.[1] ?? "").toLowerCase();
    if (activity !== "buy") continue;

    const date = stripTags(cells[0]?.[1] ?? "");
    const filingUrl = cells[1]?.[1]?.match(/href="([^"]+)"/i)?.[1];
    const filer = stripTags(cells[2]?.[1] ?? "");
    const security = stripTags(cells[4]?.[1] ?? "");
    const totalUsd = parseNumber(cells[7]?.[1] ?? "") ?? 0;
    if (!filer || !security || totalUsd < 50_000) continue;

    const key = `${filer}::${security}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.totalUsd += totalUsd;
      continue;
    }
    aggregated.set(key, {
      date,
      filer,
      security,
      totalUsd,
      filingUrl,
    });
  }

  return [...aggregated.values()]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 12);
}

function parseSectorWeights(html: string): WhaleSectorWeight[] {
  const holdingsBlock = html.split(/Sectors as % of total holdings/i)[1];
  if (!holdingsBlock) return [];
  const tbody = firstTbody(holdingsBlock);
  const sectors: WhaleSectorWeight[] = [];

  for (const row of splitRows(tbody)) {
    const sector = stripTags(
      row.match(/<td class="sector">([\s\S]*?)<\/td>/i)?.[1] ?? "",
    );
    const pct = parseNumber(row.match(/<p class="bar"[^>]*>([\d.]+)<\/p>/i)?.[1] ?? "");
    if (!sector || pct == null) continue;
    sectors.push({ sector, holdingsPct: pct });
  }

  return sectors.slice(0, 12);
}

export function emptyWhaleResearch(error?: string): WhaleResearch {
  return {
    collectedAt: new Date().toISOString(),
    quarterLabel: "",
    clusterBuys: [],
    managerMoves: [],
    realtimeBuys: [],
    sectors: [],
    sourceUrl: WHALE_SOURCE_URL,
    error,
  };
}

/**
 * Superinvestor 13F activity + recent Form 4 buys from Dataroma.
 * Dataroma already maps CUSIPs to tickers and clusters overlapping buys —
 * better than raw SEC XML for a daily briefing.
 */
export async function collectWhaleActivity(): Promise<WhaleResearch> {
  const collectedAt = new Date().toISOString();
  const pages = {
    home: `${DATAROMA_ORIGIN}/m/home.php`,
    activity: WHALE_SOURCE_URL,
    buys: `${DATAROMA_ORIGIN}/m/g/portfolio_b.php?q=q&o=c`,
    realtime: `${DATAROMA_ORIGIN}/m/rt.php`,
    sectors: `${DATAROMA_ORIGIN}/m/stats/stats.php`,
  };

  try {
    const [homeHtml, activityHtml, buysHtml, realtimeHtml, sectorsHtml] =
      await Promise.all([
        fetchHtml(pages.home),
        fetchHtml(pages.activity),
        fetchHtml(pages.buys),
        fetchHtml(pages.realtime),
        fetchHtml(pages.sectors),
      ]);

    const clusters = parseClusterBuys(buysHtml);
    const managerMoves = parseManagerMoves(activityHtml);
    const realtimeBuys = parseRealtimeBuys(realtimeHtml);
    const sectors = parseSectorWeights(sectorsHtml);
    const filings = parseFilingsProgress(homeHtml);
    const quarterLabel =
      clusters.quarterLabel ||
      parseQuarterLabel(activityHtml) ||
      parseQuarterLabel(homeHtml) ||
      "";

    if (clusters.rows.length === 0 && managerMoves.length === 0) {
      return emptyWhaleResearch("Dataroma tables could not be parsed");
    }

    return {
      collectedAt,
      quarterLabel,
      ...filings,
      buyAddCount: clusters.buyAddCount,
      clusterBuys: clusters.rows,
      managerMoves,
      realtimeBuys,
      sectors,
      sourceUrl: WHALE_SOURCE_URL,
    };
  } catch (error) {
    console.warn("whales: Dataroma fetch failed", error);
    return emptyWhaleResearch(
      error instanceof Error ? error.message : "Dataroma fetch failed",
    );
  }
}
