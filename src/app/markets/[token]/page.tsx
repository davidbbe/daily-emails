import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FearGreedDial } from "@/components/FearGreedDial";
import { SvgMarkup } from "@/components/SvgMarkup";
import { TradingViewChart } from "@/components/TradingViewChart";
import type { BriefBullet, EarningsEvent } from "@/lib/brief";
import { SECTORS, TICKERS, type SectorConfig } from "@/lib/config";
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
  SMH: "border border-sky-400/20 bg-sky-400/10 text-sky-300",
  IGV: "border border-blue-400/20 bg-blue-400/10 text-blue-300",
  XLE: "border border-amber-400/20 bg-amber-400/10 text-amber-300",
  XLF: "border border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  XLU: "border border-teal-400/20 bg-teal-400/10 text-teal-300",
  XLY: "border border-rose-400/20 bg-rose-400/10 text-rose-300",
  XLP: "border border-lime-400/20 bg-lime-400/10 text-lime-300",
  IWM: "border border-white/10 bg-white/5 text-[#a5b2ac]",
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

function clusterRoleLabel(row: InsiderCluster) {
  if (row.titleSummary) return row.titleSummary;
  return row.titles.slice(0, 2).join(", ");
}

function formatMarketCap(value?: number) {
  if (value == null || !Number.isFinite(value)) return "";
  if (value >= 1_000_000_000_000) {
    return `$${(value / 1_000_000_000_000).toFixed(1)}T market cap`;
  }
  return `$${Math.round(value / 1_000_000_000)}B market cap`;
}

function companyTierLabel(row: InsiderCluster) {
  return row.companyTier === "sp500" ? "S&P 500" : "Large cap";
}

function CompanyContext({ row }: { row: InsiderCluster }) {
  const metadata = [
    formatMarketCap(row.marketCap),
    row.sector,
    row.industry,
  ].filter(Boolean);

  return (
    <>
      {metadata.length > 0 ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[#718079]">
          {metadata.join(" · ")}
        </p>
      ) : null}
      {row.companySummary ? (
        <p className="mt-3 text-sm leading-6 text-[#9aa9a1]">
          {row.companySummary}
        </p>
      ) : null}
    </>
  );
}

function BuyTickerCard({ row }: { row: InsiderCluster }) {
  const pill = TICKER_PILL[row.ticker] ?? "bg-slate-100 text-slate-600";
  const recency = row.latestTradeDate
    ? formatRelativeDay(row.latestTradeDate)
    : "—";
  const roleLabel = clusterRoleLabel(row);
  const people = row.trades ?? [];

  return (
    <article className="overflow-hidden rounded-3xl border border-white/8 bg-[#0d1311] transition-colors hover:border-white/14">
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 font-mono text-xs font-bold ${pill}`}
              >
                {row.ticker}
              </span>
              <span className="rounded-full border border-lime-300/15 bg-lime-300/8 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-widest text-lime-300">
                {companyTierLabel(row)}
              </span>
              {row.watchlist ? (
                <span className="rounded-full border border-white/8 bg-white/4 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-[#9aa9a1]">
                  Watchlist
                </span>
              ) : null}
            </div>
            <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em] text-[#f4f7f5]">
              {row.company}
            </h3>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-[9px] uppercase tracking-widest text-[#65736d]">
              Insider buying
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-emerald-300">
              {signedInsiderUsd(row.valueUsd, "buy")}
            </p>
          </div>
        </div>
        <CompanyContext row={row} />

        <dl className="mt-5 grid grid-cols-3 divide-x divide-white/8 rounded-2xl border border-white/8 bg-white/2.5 py-3">
          <div className="px-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#65736d]">
              Buyers
            </dt>
            <dd className="mt-1 text-sm font-semibold text-[#dce4df]">
              {row.insiderCount}
            </dd>
          </div>
          <div className="px-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#65736d]">
              Roles
            </dt>
            <dd className="mt-1 truncate text-sm font-semibold text-[#dce4df]">
              {roleLabel || "Insider"}
            </dd>
          </div>
          <div className="px-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#65736d]">
              Last buy
            </dt>
            <dd className="mt-1 text-sm font-semibold text-[#dce4df]">
              {recency}
            </dd>
          </div>
        </dl>
      </div>

      {people.length > 0 ? (
        <details className="group border-t border-white/8">
          <summary className="flex cursor-pointer items-center justify-between px-5 py-3 text-xs font-medium text-[#9aa9a1] transition-colors hover:bg-white/3 hover:text-lime-300">
            <span>
              View {people.length} reported trade
              {people.length === 1 ? "" : "s"}
            </span>
            <span className="transition-transform group-open:rotate-45">+</span>
          </summary>
          <ul className="space-y-2 border-t border-white/8 px-5 py-4">
            {people.map((person, index) => (
              <li
                key={`${row.ticker}-${person.insider}-${person.tradeDate}-${index}`}
                className="flex items-baseline justify-between gap-3 text-xs text-slate-600"
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
            <li className="flex gap-4 pt-1">
              <a
                href={row.tickerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-teal-800 no-underline hover:underline"
              >
                Open filing data
              </a>
              {row.companyProfileUrl ? (
                <a
                  href={row.companyProfileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-teal-800 no-underline hover:underline"
                >
                  Company profile
                </a>
              ) : null}
            </li>
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function SellTickerCard({ row }: { row: InsiderCluster }) {
  const pill = TICKER_PILL[row.ticker] ?? "bg-slate-100 text-slate-600";
  return (
    <article className="rounded-2xl border border-white/8 bg-white/2.5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${pill}`}
            >
              {row.ticker}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-[#718079]">
              {companyTierLabel(row)}
            </span>
          </div>
          <h3 className="mt-2 truncate text-sm font-semibold text-[#dce4df]">
            {row.company}
          </h3>
          <p className="mt-1 text-xs text-[#65736d]">
            {[formatMarketCap(row.marketCap), row.sector]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-semibold tabular-nums text-rose-300">
            {signedInsiderUsd(row.valueUsd, "sell")}
          </p>
          <p className="mt-1 text-xs tabular-nums text-[#65736d]">
            {row.latestTradeDate ? formatRelativeDay(row.latestTradeDate) : "—"}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-[#7f8e87]">
        {row.watchlist ? (
          <span>Watchlist ·</span>
        ) : null}
        <span>{row.insiderCount} seller{row.insiderCount === 1 ? "" : "s"}</span>
      </div>
    </article>
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

  const rankedBuys = (insiders.clusters ?? []).filter(
    (row) => row.companyTier != null,
  );
  const notableSells = (insiders.sellGroups ?? []).filter(
    (row) => row.companyTier != null,
  );
  if (rankedBuys.length === 0 && notableSells.length === 0) return null;
  const visibleTickerCount = new Set(
    [...rankedBuys, ...notableSells].map((row) => row.ticker),
  ).size;
  const sp500Count = new Set(
    [...rankedBuys, ...notableSells]
      .filter((row) => row.companyTier === "sp500")
      .map((row) => row.ticker),
  ).size;

  return (
    <section className="mb-12">
      <div className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-lime-300">02</span>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
              Insider flow
            </h2>
          </div>
          <span className="rounded-full border border-lime-300/15 bg-lime-300/8 px-3 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-widest text-lime-300">
            {insiders.universeLabel || "S&P 500 + large caps"}
          </span>
        </div>
        <h3 className="mt-4 max-w-2xl text-2xl font-semibold tracking-[-0.035em] text-[#f4f7f5]">
          A shorter list of companies worth recognizing
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9aa9a1]">
          Smaller companies are filtered out. The remaining names are ranked by
          unique insider buyers, then total reported purchase value.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#718079]">
          <span className="rounded-full border border-white/8 bg-white/3 px-3 py-1.5">
            {visibleTickerCount} names surfaced
          </span>
          <span className="rounded-full border border-white/8 bg-white/3 px-3 py-1.5">
            {sp500Count} S&P 500
          </span>
          {(insiders.screenedOutTickerCount ?? 0) > 0 ? (
            <span className="rounded-full border border-white/8 bg-white/3 px-3 py-1.5">
              {insiders.screenedOutTickerCount} smaller names hidden
            </span>
          ) : null}
          <span className="rounded-full border border-white/8 bg-white/3 px-3 py-1.5">
            {insiders.windowLabel}
          </span>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Trades from{" "}
          <a
            href={insiders.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-teal-800 underline decoration-teal-800/30 underline-offset-2 hover:decoration-teal-800"
          >
            {insiders.sourceName}
          </a>
          ; size and company profiles from Stock Analysis.
        </p>
      </div>

      {rankedBuys.length > 0 ? (
        <div>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#dce4df]">
                Top purchases
              </h3>
              <p className="mt-1 text-xs text-[#65736d]">
                Open-market buys · trade dates shown
              </p>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {rankedBuys.map((row) => (
              <BuyTickerCard key={row.ticker} row={row} />
            ))}
          </div>
        </div>
      ) : null}

      {notableSells.length > 0 ? (
        <div className={rankedBuys.length > 0 ? "mt-7" : ""}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-[#dce4df]">
              Notable sales
            </h3>
            <p className="mt-1 text-xs text-[#65736d]">
              Context only—insiders sell for many personal reasons.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {notableSells.map((row) => (
              <SellTickerCard key={`sell-${row.ticker}`} row={row} />
            ))}
          </div>
        </div>
      ) : null}
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

function SectorCard({ sector }: { sector: SectorConfig }) {
  const pill = TICKER_PILL[sector.id] ?? "border border-white/10 bg-white/5 text-[#a5b2ac]";

  return (
    <article className="min-w-0 overflow-hidden rounded-3xl border border-white/8 bg-[#0d1311] transition-colors hover:border-white/14">
      <div className="flex min-w-0 items-baseline gap-2 border-b border-slate-100 px-5 py-4">
        <span
          className={`inline-block shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill}`}
        >
          {sector.id}
        </span>
        <span className="shrink-0 text-lg font-semibold tracking-[-0.02em] text-[#f4f7f5]">
          {sector.label}
        </span>
        <span className="min-w-0 truncate text-sm text-[#65736d]">{sector.name}</span>
      </div>
      <div className="space-y-2.5 border-b border-white/8 px-5 py-3">
        <p className="text-sm leading-relaxed text-[#9aa9a1]">{sector.blurb}</p>
        <ul className="flex flex-wrap gap-1.5">
          {sector.names.map((name) => (
            <li
              key={name}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-[#c5d0cb]"
            >
              {name}
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        <TradingViewChart compact symbol={sector.tradingViewSymbol} />
      </div>
    </article>
  );
}

function SectorsSection() {
  return (
    <section className="mb-12">
      <div className="mb-5">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-lime-300">05</span>
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9aa9a1]">
            Sector rotation
          </h2>
          <span className="h-px flex-1 bg-white/8" />
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          Same daily RSI charts as the watchlist. Scan pairs for leadership
          shifts and RSI extremes — no headlines.
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {SECTORS.map((sector) => (
          <SectorCard key={sector.id} sector={sector} />
        ))}
      </div>
    </section>
  );
}

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
              moves, valuation, charts, sector rotation, and earnings.
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

        <SectorsSection />

        <footer className="border-t border-white/8 pt-6 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-[#65736d]">
          Charts by TradingView · Generated by Daily Emails
        </footer>
      </div>
    </main>
  );
}
