import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FearGreedDial } from "@/components/FearGreedDial";
import { SvgMarkup } from "@/components/SvgMarkup";
import { TradingViewChart } from "@/components/TradingViewChart";
import type { BriefBullet, EarningsEvent } from "@/lib/brief";
import { TICKERS } from "@/lib/config";
import { formatHumanDate, formatTitleDate } from "@/lib/dates";
import {
  bandFromGaugeScore,
  buildFearGreedGaugeSvg,
  gaugeScoreFromMeter,
} from "@/lib/fear-greed-gauge";
import { isValidMarketsToken } from "@/lib/markets-auth";
import { loadMarketsBrief, saveMarketsBrief } from "@/lib/markets-brief";
import {
  fetchVixMeter,
  type FearGreedMeter,
  type SentimentBand,
  type TickerGreedProxy,
} from "@/lib/sentiment";
import { buildVixLineChartSvg } from "@/lib/vix-line-chart";
import {
  collectInsiderTrades,
  formatInsiderUsd,
  hasInsiderTrades,
  type InsiderBrief,
  type InsiderCluster,
  type InsiderTrade,
} from "@/lib/openinsider";
import type { WhaleBrief } from "@/lib/whale-brief";
import type { WhaleManagerMove } from "@/lib/whales";
import {
  annotateValuation,
  collectValuation,
  hasValuationMetrics,
  needsValueInvestorNote,
  valuationContextLine,
  valuationMetrics,
  type TickerValuation,
  type ValueStance,
} from "@/lib/valuation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Markets brief · Daily Emails",
  robots: { index: false, follow: false },
};

const BAND_STYLES: Record<SentimentBand, string> = {
  "Extreme Fear": "bg-red-100 text-red-800",
  Fear: "bg-red-50 text-red-700",
  Neutral: "bg-slate-100 text-slate-600",
  Greed: "bg-emerald-50 text-emerald-700",
  "Extreme Greed": "bg-emerald-100 text-emerald-800",
};

const FLAG_STYLES: Record<BriefBullet["flag"], string> = {
  Actionable: "bg-emerald-50 text-emerald-700",
  Watch: "bg-amber-50 text-amber-700",
  Noise: "bg-slate-100 text-slate-500",
};

const VALUE_STANCE_STYLES: Record<ValueStance, string> = {
  Cheap: "bg-emerald-50 text-emerald-700",
  Fair: "bg-slate-100 text-slate-600",
  Rich: "bg-amber-50 text-amber-800",
  Trap: "bg-red-50 text-red-700",
};

const TICKER_PILL: Record<string, string> = {
  TSLA: "bg-red-50 text-red-700",
  MU: "bg-sky-50 text-sky-700",
  META: "bg-violet-50 text-violet-700",
  BTC: "bg-orange-50 text-orange-700",
  AVGO: "bg-emerald-50 text-emerald-700",
  CRCL: "bg-cyan-50 text-cyan-700",
  SPCX: "bg-slate-100 text-slate-600",
  MSFT: "bg-blue-50 text-blue-700",
  WQTM: "bg-indigo-50 text-indigo-700",
};

function formatSigned(n: number | undefined, digits = 1) {
  if (n === undefined || !Number.isFinite(n)) return "";
  const fixed = n.toFixed(digits);
  return n > 0 ? `+${fixed}` : fixed;
}

function formatMeterDeltas(meter: FearGreedMeter) {
  const dayDigits = meter.id === "vix" ? 2 : 1;
  return [
    meter.changeDay !== undefined
      ? `${formatSigned(meter.changeDay, dayDigits)} vs yesterday`
      : "",
    meter.changeWeek !== undefined
      ? `${formatSigned(meter.changeWeek, 1)} vs last week`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatEarningsDate(value?: string, opts?: { est?: boolean }) {
  if (!value) return "—";
  const formatted = formatHumanDate(value, { withTime: false });
  return opts?.est ? `${formatted} (est.)` : formatted;
}

function BandBadge({ band }: { band?: SentimentBand | null }) {
  if (!band) return null;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${BAND_STYLES[band]}`}
    >
      {band}
    </span>
  );
}

function MeterCard({ meter }: { meter: FearGreedMeter }) {
  const shortLabel =
    meter.id === "cnn" ? "Stocks" : meter.id === "crypto" ? "Crypto" : "VIX";
  const deltas = formatMeterDeltas(meter);
  const isVix = meter.id === "vix";
  const vixHistory = isVix
    ? (meter.history ?? []).filter(
        (n) => typeof n === "number" && Number.isFinite(n),
      )
    : [];
  const score = isVix ? null : gaugeScoreFromMeter(meter);
  const dialBand = score != null ? bandFromGaugeScore(score) : meter.band;
  const rawValueLabel =
    meter.value == null
      ? "—"
      : isVix
        ? meter.value.toFixed(2)
        : String(Math.round(meter.value));

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <a
        href={meter.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-bold uppercase tracking-wide text-slate-500 no-underline hover:text-slate-800"
      >
        {shortLabel}
      </a>
      {isVix && vixHistory.length >= 2 ? (
        <SvgMarkup
          className="mx-auto mt-2 w-full [&_svg]:h-auto [&_svg]:w-full"
          svg={buildVixLineChartSvg({
            history: vixHistory,
            asOf: meter.asOf,
          })}
        />
      ) : score != null ? (
        <SvgMarkup
          className="mx-auto mt-2 w-full [&_svg]:h-auto [&_svg]:w-full"
          svg={buildFearGreedGaugeSvg({ score, activeColorOnly: true })}
        />
      ) : (
        <div className="py-10 text-center text-2xl font-bold text-slate-900">
          {rawValueLabel}
          {meter.error ? (
            <p className="mt-2 text-sm font-normal italic text-slate-400">
              {meter.error}
            </p>
          ) : null}
        </div>
      )}
      <div className="mt-2 flex flex-col items-center gap-1">
        {isVix && meter.value != null ? (
          <p className="text-center text-2xl font-bold tabular-nums text-slate-900">
            {meter.value.toFixed(2)}
          </p>
        ) : null}
        <BandBadge band={dialBand} />
        {isVix ? (
          <p className="text-center text-xs text-slate-400">
            Last ~3 months · daily closes
          </p>
        ) : null}
        {deltas ? (
          <p className="text-center text-xs text-slate-400">{deltas}</p>
        ) : null}
      </div>
    </article>
  );
}

function ProxyBlock({ proxy }: { proxy: TickerGreedProxy }) {
  if (proxy.error || proxy.score == null) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-6 text-center shadow-sm">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Greed proxy
        </div>
        <p className="mt-2 text-sm italic text-slate-400">
          {proxy.error || "Unavailable"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-5 shadow-sm">
      <FearGreedDial
        score={proxy.score}
        band={proxy.band}
        label="Greed proxy"
        gradientId={`proxy-${proxy.tickerId.toLowerCase()}`}
      />
    </div>
  );
}

function TickerValueCard({ valuation }: { valuation: TickerValuation }) {
  if (!hasValuationMetrics(valuation)) return null;
  const metrics = valuationMetrics(valuation);
  const context = valuationContextLine(valuation);

  return (
    <div className="border-b border-slate-100 px-5 py-3">
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.key}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
              {metric.label}
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
              {metric.value}
            </div>
          </div>
        ))}
      </div>
      {context ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{context}</p>
      ) : null}
      {valuation.valueInvestorNote?.trim() ? (
        <div className="mt-1.5 flex items-start gap-2">
          {valuation.valueStance ? (
            <span
              className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${VALUE_STANCE_STYLES[valuation.valueStance]}`}
            >
              {valuation.valueStance}
            </span>
          ) : null}
          <p className="text-xs leading-relaxed text-slate-600">
            <span className="font-semibold text-slate-700">
              Value investor:{" "}
            </span>
            {valuation.valueInvestorNote.trim()}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TickerEarningsDates({ event }: { event: EarningsEvent }) {
  return (
    <div className="flex shrink-0 items-start gap-4 text-right sm:gap-5">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Prev earnings
        </div>
        <div className="mt-0.5 text-xs font-semibold tabular-nums text-slate-600 sm:text-sm">
          {formatEarningsDate(event.previousDate)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Next earnings
        </div>
        <div className="mt-0.5 text-xs font-semibold tabular-nums text-slate-900 sm:text-sm">
          {formatEarningsDate(event.nextDate, {
            est: Boolean(event.nextDate) && event.nextConfirmed === false,
          })}
        </div>
      </div>
    </div>
  );
}

function signedInsiderUsd(trade: InsiderTrade) {
  const amount = formatInsiderUsd(trade.valueUsd);
  return trade.side === "buy" ? `+${amount}` : `−${amount}`;
}

function TradeRow({ trade }: { trade: InsiderTrade }) {
  const pill = TICKER_PILL[trade.ticker] ?? "bg-slate-100 text-slate-600";
  return (
    <li className="text-sm leading-snug">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={trade.tickerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-slate-800 no-underline hover:text-teal-800"
        >
          <span className="font-semibold">{trade.ticker}</span>
          {trade.watchlist ? (
            <span
              className={`ml-2 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${pill}`}
            >
              Watchlist
            </span>
          ) : null}
          <span className="ml-2 text-slate-500">{trade.company}</span>
        </a>
        <span
          className={`shrink-0 tabular-nums font-semibold ${
            trade.side === "buy" ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {signedInsiderUsd(trade)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 text-slate-600">
        <span className="min-w-0 truncate">
          {trade.insider}
          {trade.title ? (
            <span className="text-slate-400"> · {trade.title}</span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums text-slate-500">
          {trade.ownChange}
          {trade.price ? ` · $${trade.price.toFixed(2)}` : ""}
        </span>
      </div>
    </li>
  );
}

function ClusterRow({ row }: { row: InsiderCluster }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm">
      <a
        href={row.tickerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 truncate text-slate-800 no-underline hover:text-teal-800"
      >
        <span className="font-semibold">{row.ticker}</span>
        <span className="ml-2 text-slate-500">{row.company}</span>
        {row.titles.length > 0 ? (
          <span className="ml-2 text-slate-400">{row.titles.join(", ")}</span>
        ) : null}
      </a>
      <span className="shrink-0 tabular-nums text-slate-500">
        {row.insiderCount} insiders · +{formatInsiderUsd(row.valueUsd)}
      </span>
    </li>
  );
}

function InsiderTradesSection({ insiders }: { insiders?: InsiderBrief }) {
  if (!insiders || !hasInsiderTrades(insiders)) {
    if (insiders?.error) {
      return (
        <section className="mb-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Insider trades
          </h2>
          <p className="italic text-slate-400">{insiders.error}</p>
        </section>
      );
    }
    return null;
  }

  const countNote = [
    insiders.buyCount ? `${insiders.buyCount} buys` : "",
    insiders.sellCount ? `${insiders.sellCount} sells` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="mb-12">
      <div className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Insider trades
          </h2>
          <p className="text-xs text-slate-400">
            {[insiders.windowLabel, countNote].filter(Boolean).join(" · ")}
          </p>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Data from{" "}
          <a
            href={insiders.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
          >
            {insiders.sourceName}
          </a>
          , an SEC Form 4 insider-trading screener.
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {insiders.watchlist.length > 0 ? (
          <div className="border-b border-slate-100 px-5 py-4">
            <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Watchlist
            </div>
            <ul className="space-y-2.5">
              {insiders.watchlist.map((trade) => (
                <TradeRow
                  key={`watch-${trade.ticker}-${trade.insider}-${trade.filingAt}`}
                  trade={trade}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {insiders.clusters.length > 0 ? (
          <div className="border-b border-slate-100 px-5 py-4">
            <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Clustered buys
            </div>
            <ul className="space-y-2">
              {insiders.clusters.map((row) => (
                <ClusterRow key={row.ticker} row={row} />
              ))}
            </ul>
          </div>
        ) : null}

        <div
          className={`grid gap-px bg-slate-100 ${
            insiders.buys.length > 0 && insiders.sells.length > 0
              ? "lg:grid-cols-2"
              : ""
          }`}
        >
          {insiders.buys.length > 0 ? (
            <div className="bg-white px-5 py-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Open-market buys
              </div>
              <ul className="space-y-2.5">
                {insiders.buys.map((trade) => (
                  <TradeRow
                    key={`buy-${trade.ticker}-${trade.insider}-${trade.filingAt}`}
                    trade={trade}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {insiders.sells.length > 0 ? (
            <div className="bg-white px-5 py-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Open-market sells
              </div>
              <ul className="space-y-2.5">
                {insiders.sells.map((trade) => (
                  <TradeRow
                    key={`sell-${trade.ticker}-${trade.insider}-${trade.filingAt}`}
                    trade={trade}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>

      </div>
    </section>
  );
}

function dataromaStockUrl(ticker: string) {
  return `https://www.dataroma.com/m/stock.php?sym=${encodeURIComponent(ticker)}`;
}

function formatMoveAction(move: WhaleManagerMove) {
  if (move.action === "Buy") return "New buy";
  if (move.shareChangePct != null) return `Add ${move.shareChangePct}%`;
  return "Add";
}

const NOTABLE_ADDS_LIMIT = 7;

function WhaleWatchSection({ whales }: { whales?: WhaleBrief }) {
  if (!whales) return null;
  const notableBuys = whales.notableBuys.slice(0, NOTABLE_ADDS_LIMIT);
  const hasBody =
    Boolean(whales.briefing?.trim()) ||
    whales.clusteredBuys.length > 0 ||
    notableBuys.length > 0;
  if (!hasBody) return null;

  const filingNote =
    whales.filingsSoFar != null && whales.filingsTotal != null
      ? `${whales.filingsSoFar} of ${whales.filingsTotal} superinvestor 13Fs in`
      : null;

  return (
    <section className="mb-12">
      <div className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Whale watch
          </h2>
          <p className="text-xs text-slate-400">
            {[whales.quarterLabel, filingNote].filter(Boolean).join(" · ")}
          </p>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Data from{" "}
          <a
            href={whales.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
          >
            {whales.sourceName}
          </a>
          , which tracks superinvestor 13F filings.
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {whales.briefing?.trim() ? (
          <div className="border-b border-slate-100 px-5 py-5">
            <p className="text-[15px] leading-relaxed text-slate-800">
              {whales.briefing}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              13F holdings are quarter-end snapshots, filed up to 45 days later
              — not live trades.
              {whales.buyAddCount
                ? ` ${whales.buyAddCount} buys/adds reported so far this quarter.`
                : ""}
            </p>
          </div>
        ) : null}

        {whales.themes.length > 0 ? (
          <div className="grid gap-px border-b border-slate-100 bg-slate-100 sm:grid-cols-2 lg:grid-cols-3">
            {whales.themes.map((theme, index) => (
              <div
                key={`${theme.title}-${index}`}
                className="bg-white px-5 py-4"
              >
                <div className="text-[11px] font-bold uppercase tracking-wide text-teal-800">
                  {theme.title}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                  {theme.detail}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div
          className={`grid gap-px bg-slate-100 ${
            whales.clusteredBuys.length > 0 && notableBuys.length > 0
              ? "lg:grid-cols-2"
              : ""
          }`}
        >
          {whales.clusteredBuys.length > 0 ? (
            <div className="bg-white px-5 py-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Clustered buys
              </div>
              <ul className="space-y-2">
                {whales.clusteredBuys.map((row) => (
                  <li
                    key={row.ticker}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <a
                      href={dataromaStockUrl(row.ticker)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 truncate text-slate-800 no-underline hover:text-teal-800"
                    >
                      <span className="font-semibold">{row.ticker}</span>
                      <span className="ml-2 text-slate-500">{row.name}</span>
                    </a>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {row.buyerCount} funds
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {notableBuys.length > 0 ? (
            <div className="bg-white px-5 py-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Notable adds
              </div>
              <ul className="space-y-2.5">
                {notableBuys.map((move) => (
                  <li
                    key={`${move.manager}-${move.ticker}-${move.period}`}
                    className="text-sm leading-snug text-slate-700"
                  >
                    <span className="font-semibold text-slate-900">
                      {move.manager}
                    </span>
                    <span className="text-slate-400"> · {move.period}</span>
                    <div className="mt-0.5 text-slate-600">
                      {formatMoveAction(move)}{" "}
                      <a
                        href={dataromaStockUrl(move.ticker)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-teal-800 no-underline hover:underline"
                      >
                        {move.ticker}
                      </a>{" "}
                      · {move.portfolioPct.toFixed(1)}% of book
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

      </div>
    </section>
  );
}

export default async function MarketsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isValidMarketsToken(token)) notFound();

  const brief = await loadMarketsBrief();
  if (!brief) {
    return (
      <main className="min-h-screen bg-[linear-gradient(160deg,#f7f4ef,#dfe8e3)] px-4 py-16 text-[#1a1f1c]">
        <div className="mx-auto max-w-2xl rounded-2xl border border-black/5 bg-white/80 p-8 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
            Daily Emails
          </p>
          <h1 className="mt-2 font-serif text-3xl tracking-tight">
            Markets brief
          </h1>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            No markets brief has been saved yet. Run the daily brief once, then
            refresh this page.
          </p>
        </div>
      </main>
    );
  }

  const liveInsidersPromise = collectInsiderTrades().catch((error) => {
    console.warn("markets: live insider trades hydrate failed", error);
    return null;
  });

  // Older briefs omit VIX history — hydrate the chart from the live quote API.
  const meters = [...(brief.sentiment?.meters ?? [])];
  const vixIndex = meters.findIndex((m) => m.id === "vix");
  const savedVix = vixIndex >= 0 ? meters[vixIndex] : null;
  if (!savedVix?.history || savedVix.history.length < 2) {
    try {
      const liveVix = await fetchVixMeter();
      if (liveVix.history && liveVix.history.length >= 2) {
        if (vixIndex >= 0) meters[vixIndex] = { ...savedVix!, ...liveVix };
        else meters.push(liveVix);
      }
    } catch (error) {
      console.warn("markets: live VIX hydrate failed", error);
    }
  }

  const proxyByTicker = new Map(
    (brief.sentiment?.tickers ?? []).map(
      (proxy) => [proxy.tickerId, proxy] as const,
    ),
  );
  const earningsByTicker = new Map(
    brief.earningsCalendar.map((event) => [event.tickerId, event] as const),
  );
  let valuationRows = brief.valuation ?? [];
  if (!valuationRows.some(hasValuationMetrics)) {
    try {
      valuationRows = await collectValuation();
    } catch (error) {
      console.warn("markets: live valuation hydrate failed", error);
    }
  }
  if (valuationRows.some(needsValueInvestorNote)) {
    try {
      valuationRows = await annotateValuation(valuationRows);
      await saveMarketsBrief({ ...brief, valuation: valuationRows });
    } catch (error) {
      console.warn("markets: value-investor notes failed", error);
    }
  }
  const valuationByTicker = new Map(
    valuationRows.map((row) => [row.tickerId, row] as const),
  );
  const liveInsiders = await liveInsidersPromise;
  const insiders =
    liveInsiders &&
    (hasInsiderTrades(liveInsiders) || !hasInsiderTrades(brief.insiders))
      ? liveInsiders
      : brief.insiders;

  const dateLabel = formatTitleDate(brief.generatedAt);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#e8f0ea,transparent_45%),linear-gradient(160deg,#f7f4ef,#dfe8e3)] text-[#1a1f1c]">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-10">
          <h1 className="mt-2 font-serif text-4xl tracking-tight sm:text-5xl">
            Markets brief - {dateLabel}
          </h1>
          <p className="mt-3 text-base leading-relaxed text-slate-600">
            Fear &amp; greed, insider trades, whale watch, valuation, watchlist
            charts, and earnings for the latest daily run.
          </p>
        </header>

        <section className="mb-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Fear &amp; greed
          </h2>
          {meters.length === 0 ? (
            <p className="italic text-slate-400">No market meters available.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              {meters.map((meter) => (
                <MeterCard key={meter.id} meter={meter} />
              ))}
            </div>
          )}
          {brief.sentiment?.valueDial?.trim() ? (
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              {brief.sentiment.valueDial}
            </p>
          ) : null}
        </section>

        <InsiderTradesSection insiders={insiders} />

        <WhaleWatchSection whales={brief.whales} />

        <section className="mb-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Markets
          </h2>
          <div className="space-y-8">
            {TICKERS.map((ticker) => {
              const section = brief.tickers.find((t) => t.id === ticker.id);
              const proxy = proxyByTicker.get(ticker.id);
              const earnings = earningsByTicker.get(ticker.id);
              const valuation = valuationByTicker.get(ticker.id);
              const pill =
                TICKER_PILL[ticker.id] ?? "bg-slate-100 text-slate-600";

              return (
                <article
                  key={ticker.id}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                    <div className="min-w-0">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill}`}
                      >
                        {ticker.id}
                      </span>
                      <span className="ml-2 text-lg font-semibold text-slate-900">
                        {ticker.label}
                      </span>
                    </div>
                    {earnings ? <TickerEarningsDates event={earnings} /> : null}
                  </div>

                  {valuation ? <TickerValueCard valuation={valuation} /> : null}

                  <div className="space-y-4 px-5 py-5">
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-start">
                      <div className="min-w-0 space-y-3">
                        <ul className="space-y-3">
                          {section?.bullets?.length ? (
                            section.bullets.map((bullet, index) => (
                              <li
                                key={`${ticker.id}-${index}`}
                                className="text-[15px] leading-relaxed text-slate-800"
                              >
                                <span
                                  className={`mr-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${FLAG_STYLES[bullet.flag]}`}
                                >
                                  {bullet.flag}
                                </span>
                                {bullet.text}
                                {bullet.sourceUrl ? (
                                  <>
                                    {" "}
                                    <a
                                      href={bullet.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sm font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
                                    >
                                      {bullet.sourceName || "Source"}
                                    </a>
                                  </>
                                ) : null}
                              </li>
                            ))
                          ) : (
                            <li className="text-[15px] text-slate-500">
                              No material headlines in the last 24 hours.
                            </li>
                          )}
                        </ul>

                        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700">
                          <span className="font-bold text-slate-900">
                            Why it matters:{" "}
                          </span>
                          {section?.whyItMatters || "Limited coverage today."}
                        </div>
                      </div>

                      {proxy ? (
                        <div className="sm:w-44 sm:justify-self-end">
                          <ProxyBlock proxy={proxy} />
                        </div>
                      ) : null}
                    </div>

                    {ticker.tradingViewSymbol ? (
                      <TradingViewChart symbol={ticker.tradingViewSymbol} />
                    ) : (
                      <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm italic text-slate-400">
                        No public TradingView chart (private company).
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <footer className="border-t border-black/5 pt-6 text-center text-xs text-slate-400">
          Charts by TradingView · Generated by Daily Emails
        </footer>
      </div>
    </main>
  );
}
