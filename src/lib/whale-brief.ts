import { generateObject } from "ai";
import { z } from "zod";
import { getModel, TICKERS } from "@/lib/config";
import {
  emptyWhaleResearch,
  WHALE_SOURCE_NAME,
  WHALE_SOURCE_URL,
  type WhaleClusterBuy,
  type WhaleManagerMove,
  type WhaleRealtimeBuy,
  type WhaleResearch,
} from "@/lib/whales";

export type WhaleBrief = {
  collectedAt: string;
  quarterLabel: string;
  filingsSoFar?: number;
  filingsTotal?: number;
  buyAddCount?: number;
  briefing: string;
  themes: Array<{ title: string; detail: string }>;
  clusteredBuys: WhaleClusterBuy[];
  notableBuys: WhaleManagerMove[];
  realtimeBuys: WhaleRealtimeBuy[];
  watchlist: Array<{ tickerId: string; note: string }>;
  sourceUrl: string;
  sourceName: string;
  error?: string;
};

const whaleSchema = z.object({
  briefing: z.string(),
  themes: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
    }),
  ),
  watchlist: z.array(
    z.object({
      tickerId: z.string(),
      note: z.string(),
    }),
  ),
});

function periodKey(period: string): number {
  const match = period.match(/Q([1-4])\s+(20\d{2})/i);
  if (!match) return 0;
  return Number(match[2]) * 4 + Number(match[1]);
}

function latestPeriod(moves: WhaleManagerMove[]): string {
  let best = "";
  let bestKey = 0;
  for (const move of moves) {
    const key = periodKey(move.period);
    if (key > bestKey) {
      bestKey = key;
      best = move.period;
    }
  }
  return best;
}

function pickNotableBuys(moves: WhaleManagerMove[]): WhaleManagerMove[] {
  const buys = moves.filter(
    (move) =>
      (move.action === "Buy" || move.action === "Add") &&
      move.portfolioPct >= 1.5 &&
      move.portfolioPct <= 80,
  );
  const latest = latestPeriod(buys);
  const preferred = latest
    ? buys.filter((move) => move.period === latest)
    : buys;
  const ranked = [...preferred].sort((a, b) => b.portfolioPct - a.portfolioPct);
  const picked = ranked.slice(0, 12);

  if (picked.length >= 8) return picked;

  const seen = new Set(picked.map((m) => `${m.manager}:${m.ticker}:${m.period}`));
  const fillers = buys
    .filter((move) => !seen.has(`${move.manager}:${move.ticker}:${move.period}`))
    .sort((a, b) => b.portfolioPct - a.portfolioPct);

  return [...picked, ...fillers].slice(0, 12);
}

function formatMoveLine(move: WhaleManagerMove) {
  const change =
    move.action === "Buy"
      ? "new buy"
      : move.shareChangePct != null
        ? `add ${move.shareChangePct}%`
        : "add";
  return `${move.manager} | ${move.period} | ${move.ticker} ${move.name} | ${change} | ${move.portfolioPct.toFixed(2)}% of portfolio`;
}

function formatUsd(n: number) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function fallbackBriefing(research: WhaleResearch, notable: WhaleManagerMove[]) {
  const top = research.clusterBuys
    .slice(0, 5)
    .map((row) => `${row.ticker} (${row.buyerCount} funds)`)
    .join(", ");
  const filing =
    research.filingsSoFar != null && research.filingsTotal != null
      ? `Filings so far: ${research.filingsSoFar} of ${research.filingsTotal} superinvestors.`
      : "";
  const quarter = research.quarterLabel || "the latest quarter";
  const highlight = notable[0]
    ? ` Largest disclosed add: ${notable[0].manager} ${notable[0].action.toLowerCase()} in ${notable[0].ticker}.`
    : "";
  return `${filing} Clustered superinvestor buys in ${quarter} are led by ${top || "a thin set of names"}.${highlight} 13F holdings reflect quarter-end books, filed with a lag of up to 45 days.`.trim();
}

function emptyBrief(research: WhaleResearch, error?: string): WhaleBrief {
  return {
    collectedAt: research.collectedAt,
    quarterLabel: research.quarterLabel,
    filingsSoFar: research.filingsSoFar,
    filingsTotal: research.filingsTotal,
    buyAddCount: research.buyAddCount,
    briefing: "",
    themes: [],
    clusteredBuys: [],
    notableBuys: [],
    realtimeBuys: [],
    watchlist: [],
    sourceUrl: research.sourceUrl || WHALE_SOURCE_URL,
    sourceName: WHALE_SOURCE_NAME,
    error: error || research.error,
  };
}

export async function buildWhaleBrief(
  research: WhaleResearch | undefined,
): Promise<WhaleBrief> {
  if (!research) {
    return emptyBrief(emptyWhaleResearch(), "Whale activity was not collected");
  }

  const clusteredBuys = research.clusterBuys
    .filter((row) => row.buyerCount >= 2)
    .slice(0, 12);
  const notableBuys = pickNotableBuys(research.managerMoves);
  const realtimeBuys = research.realtimeBuys.slice(0, 8);

  if (clusteredBuys.length === 0 && notableBuys.length === 0) {
    return emptyBrief(research, research.error || "No superinvestor buys parsed");
  }

  const watchlistIds: string[] = TICKERS.map((t) => t.id);
  const base: Omit<WhaleBrief, "briefing" | "themes" | "watchlist"> = {
    collectedAt: research.collectedAt,
    quarterLabel: research.quarterLabel,
    filingsSoFar: research.filingsSoFar,
    filingsTotal: research.filingsTotal,
    buyAddCount: research.buyAddCount,
    clusteredBuys,
    notableBuys,
    realtimeBuys,
    sourceUrl: research.sourceUrl || WHALE_SOURCE_URL,
    sourceName: WHALE_SOURCE_NAME,
    error: research.error,
  };

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: whaleSchema,
      maxOutputTokens: 4096,
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 0 } },
      },
      system: `You brief a value-oriented reader on hedge-fund / superinvestor activity.
Only use the provided 13F and Form 4 tables. Do not invent funds, tickers, percents, or dates.

13F rules:
- Holdings are as of quarter-end and filed up to 45 days later. This is not live trading.
- If filings are incomplete, say so. Do not treat a partial quarter as a finished picture.
- Clustered buys (several unrelated funds adding the same name) matter more than one fund's hobby position.
- "Buy" = new 13F position. "Add" = increased an existing stake.

Form 4 / RealTime rows are actual recent open-market trades by those managers as insiders — separate from 13F quarter-end snapshots.

briefing: 3–5 sentences. Cover the cross-cutting trend, overlapping purchases, and sector tilt. Mention the filing lag once.
themes: 3–5 items. title ≤6 words (a sector or motif). detail ≤28 words, grounded in the tables.
watchlist: only for ids from the provided watchlist that actually appear in the tables. Omit ids with no overlap. note ≤22 words.`,
      prompt: `Watchlist ids: ${watchlistIds.join(", ")}
Quarter in focus: ${research.quarterLabel || "(unknown)"}
Filings progress: ${
        research.filingsSoFar != null && research.filingsTotal != null
          ? `${research.filingsSoFar} of ${research.filingsTotal}`
          : "(unknown)"
      }
Buys/adds reported: ${research.buyAddCount ?? "(unknown)"}

Clustered 13F buys (sorted by number of superinvestor buyers):
${
  clusteredBuys
    .map(
      (row) =>
        `- ${row.ticker} ${row.name} | ${row.buyerCount} buyers | weight ${row.portfolioWeightPct ?? "n/a"}%`,
    )
    .join("\n") || "- (none)"
}

Notable manager Buy/Add (≥1.5% of that fund's 13F book):
${notableBuys.map(formatMoveLine).join("\n") || "- (none)"}

Recent Form 4 buys by superinvestors (aggregated, not 13F):
${
  realtimeBuys
    .map(
      (row) =>
        `- ${row.date} | ${row.filer} | ${row.security} | ${formatUsd(row.totalUsd)}`,
    )
    .join("\n") || "- (none)"
}

Superinvestor book sector weights (% of combined holdings):
${
  research.sectors
    .slice(0, 8)
    .map((s) => `- ${s.sector}: ${s.holdingsPct}%`)
    .join("\n") || "- (none)"
}`,
    });

    const allowed = new Set(watchlistIds);
    const watchlist = object.watchlist
      .map((item) => ({
        tickerId: item.tickerId.trim().toUpperCase(),
        note: item.note.trim(),
      }))
      .filter((item) => allowed.has(item.tickerId) && item.note.length > 0)
      .slice(0, 6);

    const themes = object.themes
      .map((theme) => ({
        title: theme.title.trim(),
        detail: theme.detail.trim(),
      }))
      .filter((theme) => theme.title && theme.detail)
      .slice(0, 5);

    return {
      ...base,
      briefing:
        object.briefing.trim() || fallbackBriefing(research, notableBuys),
      themes,
      watchlist,
    };
  } catch (error) {
    console.warn("whales: briefing model failed", error);
    return {
      ...base,
      briefing: fallbackBriefing(research, notableBuys),
      themes: [],
      watchlist: [],
      error: research.error,
    };
  }
}

export function formatWhaleUsd(n: number) {
  return formatUsd(n);
}
