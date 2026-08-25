import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FearGreedDial } from "@/components/FearGreedDial";
import { SvgMarkup } from "@/components/SvgMarkup";
import { TradingViewChart } from "@/components/TradingViewChart";
import type { BriefBullet, EarningsEvent } from "@/lib/brief";
import { TICKERS } from "@/lib/config";
import { formatHumanDate, formatRelativeDay, formatTitleDate } from "@/lib/dates";
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
  rankBuyTickers,
  rankSellTickers,
  type InsiderBrief,
  type InsiderCluster,
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
  "Extreme Fear": "border border-rose-400/20 bg-rose-400/10 text-rose-300",
  Fear: "border border-rose-400/20 bg-rose-400/10 text-rose-300",
  Neutral: "border border-white/10 bg-white/5 text-[#a5b2ac]",
  Greed: "border border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  "Extreme Greed":
    "border border-lime-400/20 bg-lime-400/10 text-lime-300",
};

const FLAG_STYLES: Record<BriefBullet["flag"], string> = {
  Actionable: "border border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  Watch: "border border-amber-400/20 bg-amber-400/10 text-amber-300",
  Noise: "border border-white/10 bg-white/5 text-[#89968f]",
};

const VALUE_STANCE_STYLES: Record<ValueStance, string> = {
  Cheap: "border border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  Fair: "border border-white/10 bg-white/5 text-[#a5b2ac]",
  Rich: "border border-amber-400/20 bg-amber-400/10 text-amber-300",
  Trap: "border border-rose-400/20 bg-rose-400/10 text-rose-300",
};

const TICKER_PILL: Record<string, string> = {
  TSLA: "border border-rose-400/20 bg-rose-400/10 text-rose-300",
  MU: "border border-sky-400/20 bg-sky-400/10 text-sky-300",
  META: "border border-violet-400/20 bg-violet-400/10 text-violet-300",
  BTC: "border border-orange-400/20 bg-orange-400/10 text-orange-300",
  AVGO: "border border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  CRCL: "border border-cyan-400/20 bg-cyan-400/10 text-cyan-300",
  SPCX: "border border-white/10 bg-white/5 text-[#a5b2ac]",
  MSFT: "border border-blue-400/20 bg-blue-400/10 text-blue-300",
  WQTM: "border border-indigo-400/20 bg-indigo-400/10 text-indigo-300",
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
      className={`inline-block rounded-full px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${BAND_STYLES[band]}`}
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
    <article className="group rounded-3xl border border-white/8 bg-[#0d1311] p-5 transition-colors hover:border-white/14">
      <a
        href={meter.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#718079] no-underline transition-colors hover:text-lime-300"
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
        <div className="py-10 text-center text-2xl font-semibold text-[#f4f7f5]">
          {rawValueLabel}
          {meter.error ? (
            <p className="mt-2 text-sm font-normal italic text-[#65736d]">
              {meter.error}
            </p>
          ) : null}
        </div>
      )}
      <div className="mt-2 flex flex-col items-center gap-1">
        {isVix && meter.value != null ? (
          <p className="text-center font-mono text-2xl font-semibold tabular-nums text-[#f4f7f5]">
            {meter.value.toFixed(2)}
          </p>
        ) : null}
        <BandBadge band={dialBand} />
        {isVix ? (
          <p className="text-center font-mono text-[10px] text-[#65736d]">
            Last ~3 months · daily closes
          </p>
        ) : null}
        {deltas ? (
          <p className="text-center font-mono text-[10px] text-[#65736d]">{deltas}</p>
        ) : null}
      </div>
    </article>
  );
}

function ProxyBlock({ proxy }: { proxy: TickerGreedProxy }) {
  if (proxy.error || proxy.score == null) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/2.5 px-4 py-6 text-center">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#65736d]">
          Greed proxy
        </div>
        <p className="mt-2 text-sm italic text-[#65736d]">
          {proxy.error || "Unavailable"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/8 bg-white/2.5 px-4 py-5">
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

function signedInsiderUsd(amount: number, side: "buy" | "sell") {
  const formatted = formatInsiderUsd(amount);
  return side === "buy" ? `+${formatted}` : `−${formatted}`;
}

const BUY_RANK_GRID =
  "grid grid-cols-[minmax(0,1fr)_3.25rem_4.5rem_6.75rem] items-baseline gap-x-3";
const SELL_RANK_GRID =
  "grid grid-cols-[minmax(0,1fr)_4.5rem_6.75rem] items-baseline gap-x-3";

function clusterRoleLabel(row: InsiderCluster) {
  if (row.titleSummary) return row.titleSummary;
  return row.titles.slice(0, 2).join(", ");
}

function BuyTickerRow({ row }: { row: InsiderCluster }) {
  const pill = TICKER_PILL[row.ticker] ?? "bg-slate-100 text-slate-600";
  const recency = row.latestTradeDate
    ? formatRelativeDay(row.latestTradeDate)
    : "—";
  const roleLabel = clusterRoleLabel(row);
  const people = row.trades ?? [];
  const canExpand = people.length > 0;

  const headline = (
    <span className={`${BUY_RANK_GRID} w-full`}>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span
            aria-hidden="true"
            className={`inline-block w-3 shrink-0 text-center text-[10px] text-slate-400 transition-transform group-open:rotate-90 ${
              canExpand ? "" : "invisible"
            }`}
          >
            ▸
          </span>
          <span className="font-semibold text-slate-800">{row.ticker}</span>
          <span className="hidden min-w-0 truncate text-slate-500 sm:inline">
            {row.company}
          </span>
          {row.watchlist ? (
            <span
              className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${pill}`}
            >
              Watchlist
            </span>
          ) : null}
        </span>
        {roleLabel ? (
          <span className="mt-0.5 block truncate pl-5 text-xs text-slate-400">
            {roleLabel}
          </span>
        ) : null}
      </span>
      <span className="text-right font-semibold tabular-nums text-slate-800">
        {row.insiderCount}
      </span>
      <span className="text-right tabular-nums font-semibold text-emerald-700">
        {signedInsiderUsd(row.valueUsd, "buy")}
      </span>
      <span className="text-right tabular-nums text-slate-500">{recency}</span>
    </span>
  );

  if (!canExpand) {
    return <li className="px-5 py-3 text-sm">{headline}</li>;
  }

  return (
    <li className="text-sm">
      <details className="group">
        <summary className="cursor-pointer list-none px-5 py-3 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
          {headline}
        </summary>
        <ul className="space-y-2 border-t border-slate-100 pb-3 pl-10 pr-5 pt-3">
          {people.map((person, index) => (
            <li
              key={`${row.ticker}-${person.insider}-${person.tradeDate}-${index}`}
              className="flex items-baseline justify-between gap-3 text-sm text-slate-600"
            >
              <span className="min-w-0 truncate">
                {person.insider}
                {person.title ? (
                  <span className="text-slate-400"> · {person.title}</span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {signedInsiderUsd(person.valueUsd, "buy")}
                {person.tradeDate
                  ? ` · ${formatRelativeDay(person.tradeDate)}`
                  : ""}
              </span>
            </li>
          ))}
          <li>
            <a
              href={row.tickerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-teal-800 no-underline hover:underline"
            >
              OpenInsider
            </a>
          </li>
        </ul>
      </details>
    </li>
  );
}

function CompactSellRow({ row }: { row: InsiderCluster }) {
  const pill = TICKER_PILL[row.ticker] ?? "bg-slate-100 text-slate-600";
  return (
    <li className={`${SELL_RANK_GRID} px-5 py-2.5 text-sm`}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-semibold text-slate-800">{row.ticker}</span>
        <span className="hidden min-w-0 truncate text-slate-500 sm:inline">
          {row.company}
        </span>
        {row.watchlist ? (
          <span
            className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${pill}`}
          >
            Watchlist
          </span>
        ) : null}
        {row.insiderCount > 1 ? (
          <span className="shrink-0 text-xs text-slate-400">
            {row.insiderCount} sellers
          </span>
        ) : null}
      </div>
      <span className="text-right tabular-nums font-semibold text-red-700">
        {signedInsiderUsd(row.valueUsd, "sell")}
      </span>
      <span className="text-right tabular-nums text-slate-500">
        {row.latestTradeDate ? formatRelativeDay(row.latestTradeDate) : "—"}
      </span>
    </li>
  );
}

function InsiderTradesSection({ insiders }: { insiders?: InsiderBrief }) {
  if (!insiders || !hasInsiderTrades(insiders)) {
    if (insiders?.error) {
      return (
        <section className="mb-12">
          <div className="mb-5 flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">02</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Insider flow
            </h2>
            <span className="h-px flex-1 bg-white/8" />
          </div>
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
  const rankedBuys =
    (insiders.clusters?.length ?? 0) > 0
      ? insiders.clusters
      : rankBuyTickers([
          ...insiders.buys,
          ...insiders.watchlist.filter((trade) => trade.side === "buy"),
        ]);
  const notableSells =
    (insiders.sellGroups?.length ?? 0) > 0
      ? (insiders.sellGroups ?? [])
      : rankSellTickers(insiders.sells);
  if (rankedBuys.length === 0 && notableSells.length === 0) return null;

  return (
    <section className="mb-12">
      <div className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">02</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Insider flow
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#65736d]">
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

      <div className="market-surface overflow-hidden rounded-3xl border border-white/8 bg-[#0d1311]">
        {rankedBuys.length > 0 ? (
          <div className={notableSells.length > 0 ? "border-b border-slate-100" : ""}>
            <div className="px-5 pt-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Popular purchases
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Ranked by how many insiders bought · dates are trade dates
              </p>
            </div>
            <div
              className={`${BUY_RANK_GRID} px-5 pb-2 pt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-400`}
            >
              <span className="flex items-baseline gap-2">
                <span className="inline-block w-3 shrink-0" />
                Stock
              </span>
              <span className="text-right">Buyers</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Last buy</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {rankedBuys.map((row) => (
                <BuyTickerRow key={row.ticker} row={row} />
              ))}
            </ul>
          </div>
        ) : null}

        {notableSells.length > 0 ? (
          <div>
            <div className="px-5 pt-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Notable sells
              </div>
            </div>
            <div
              className={`${SELL_RANK_GRID} px-5 pb-2 pt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-400`}
            >
              <span>Stock</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Last sale</span>
            </div>
            <ul className="divide-y divide-slate-100 pb-1">
              {notableSells.map((row) => (
                <CompactSellRow key={`sell-${row.ticker}`} row={row} />
              ))}
            </ul>
          </div>
        ) : null}
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
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">03</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Institutional flow
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#65736d]">
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

      <div className="market-surface overflow-hidden rounded-3xl border border-white/8 bg-[#0d1311]">
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
      <main className="markets-page min-h-screen px-4 py-16 text-[#f4f7f5]">
        <div className="market-surface mx-auto max-w-2xl rounded-3xl border border-white/8 bg-[#0d1311] p-8">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lime-300">
            Daily Emails
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
            Markets brief
          </h1>
          <p className="mt-4 text-base leading-relaxed text-[#9aa9a1]">
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
    <main className="markets-page min-h-screen text-[#f4f7f5]">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <header className="relative mb-12 overflow-hidden rounded-4xl border border-white/8 bg-[#0d1311]/90 px-6 py-8 sm:px-9 sm:py-10">
          <div className="pointer-events-none absolute -right-20 -top-32 h-80 w-80 rounded-full bg-lime-300/8 blur-3xl" />
          <div className="relative">
            <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-lime-300">
                <span className="h-1.5 w-1.5 rounded-full bg-lime-300 shadow-[0_0_12px_rgba(190,242,100,0.8)]" />
                Daily market intelligence
              </div>
              <div className="rounded-full border border-white/8 bg-white/3 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#718079]">
                Stocks · Crypto · Macro
              </div>
            </div>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-[#718079]">
              {dateLabel}
            </p>
            <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.055em] sm:text-6xl">
              Markets brief
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-[#9aa9a1] sm:text-base">
              A signal-first view of sentiment, insider activity, institutional
              moves, valuation, charts, and earnings.
            </p>
          </div>
        </header>

        <section className="mb-12">
          <div className="mb-5 flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">01</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Market pulse
            </h2>
            <span className="h-px flex-1 bg-white/8" />
          </div>
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
            <p className="mt-4 rounded-2xl border border-white/6 bg-white/2.5 px-5 py-4 text-sm leading-relaxed text-[#9aa9a1]">
              {brief.sentiment.valueDial}
            </p>
          ) : null}
        </section>

        <InsiderTradesSection insiders={insiders} />

        <WhaleWatchSection whales={brief.whales} />

        <section className="mb-12">
          <div className="mb-5 flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">04</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Watchlist
            </h2>
            <span className="h-px flex-1 bg-white/8" />
          </div>
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
                  className="overflow-hidden rounded-3xl border border-white/8 bg-[#0d1311] transition-colors hover:border-white/14"
                >
                  <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                    <div className="min-w-0">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill}`}
                      >
                        {ticker.id}
                      </span>
                      <span className="ml-2 text-lg font-semibold tracking-[-0.02em] text-[#f4f7f5]">
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

                        <div className="rounded-2xl border border-white/6 bg-white/2.5 px-4 py-3 text-sm leading-relaxed text-[#bdc9c2]">
                          <span className="font-semibold text-[#f4f7f5]">
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
                      <p className="rounded-2xl border border-white/6 bg-white/2.5 px-4 py-3 text-sm italic text-[#65736d]">
                        No public TradingView chart (private company).
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <footer className="border-t border-white/8 pt-6 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-[#65736d]">
          Charts by TradingView · Generated by Daily Emails
        </footer>
      </div>
    </main>
  );
}
