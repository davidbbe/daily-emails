import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FearGreedDial } from "@/components/FearGreedDial";
import { SvgMarkup } from "@/components/SvgMarkup";
import { TradingViewChart } from "@/components/TradingViewChart";
import type { BriefBullet, EarningsEvent } from "@/lib/brief";
import { TICKERS } from "@/lib/config";
import { formatHumanDate } from "@/lib/dates";
import {
  buildFearGreedGaugeSvg,
  gaugeScoreFromMeter,
} from "@/lib/fear-greed-gauge";
import { isValidMarketsToken } from "@/lib/markets-auth";
import { loadMarketsBrief } from "@/lib/markets-brief";
import type {
  FearGreedMeter,
  SentimentBand,
  TickerGreedProxy,
} from "@/lib/sentiment";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Markets brief · Daily Emails",
  robots: { index: false, follow: false },
};

const BAND_STYLES: Record<SentimentBand, string> = {
  "Extreme Fear": "bg-red-50 text-red-700",
  Fear: "bg-orange-50 text-orange-700",
  Neutral: "bg-slate-100 text-slate-600",
  Greed: "bg-emerald-50 text-emerald-700",
  "Extreme Greed": "bg-emerald-50 text-emerald-800",
};

const FLAG_STYLES: Record<BriefBullet["flag"], string> = {
  Actionable: "bg-emerald-50 text-emerald-700",
  Watch: "bg-amber-50 text-amber-700",
  Noise: "bg-slate-100 text-slate-500",
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
  const score = gaugeScoreFromMeter(meter);
  const shortLabel =
    meter.id === "cnn" ? "Stocks" : meter.id === "crypto" ? "Crypto" : "VIX";
  const deltas = formatMeterDeltas(meter);
  const valueLabel =
    meter.value == null
      ? "—"
      : meter.id === "vix"
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
      {score != null ? (
        <SvgMarkup
          className="mx-auto mt-2 max-w-[220px] [&_svg]:h-auto [&_svg]:w-full"
          svg={buildFearGreedGaugeSvg({
            score,
            valueLabel,
            band: meter.band,
          })}
        />
      ) : (
        <div className="py-10 text-center text-2xl font-bold text-slate-900">
          {valueLabel}
          {meter.error ? (
            <p className="mt-2 text-sm font-normal italic text-slate-400">
              {meter.error}
            </p>
          ) : null}
        </div>
      )}
      <div className="mt-2 flex flex-col items-center gap-1">
        <BandBadge band={meter.band} />
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

function EarningsCard({ event }: { event: EarningsEvent }) {
  const pill = TICKER_PILL[event.tickerId] ?? "bg-slate-100 text-slate-600";
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <span
        className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill}`}
      >
        {event.tickerId}
      </span>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
            Prev
          </div>
          <div className="mt-0.5 text-sm font-semibold text-slate-600">
            {formatEarningsDate(event.previousDate)}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
            Next
          </div>
          <div className="mt-0.5 text-sm font-semibold text-slate-900">
            {formatEarningsDate(event.nextDate, {
              est: Boolean(event.nextDate) && event.nextConfirmed === false,
            })}
          </div>
        </div>
      </div>
    </article>
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

  const proxyByTicker = new Map(
    (brief.sentiment?.tickers ?? []).map(
      (proxy) => [proxy.tickerId, proxy] as const,
    ),
  );
  const dateLabel = formatHumanDate(brief.generatedAt);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#e8f0ea,transparent_45%),linear-gradient(160deg,#f7f4ef,#dfe8e3)] text-[#1a1f1c]">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-10">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
            Daily Emails
          </p>
          <h1 className="mt-2 font-serif text-4xl tracking-tight sm:text-5xl">
            Markets brief
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
            Fear &amp; greed, watchlist charts, and earnings for the latest
            daily run.
          </p>
          <p className="mt-2 text-sm text-slate-500">{dateLabel}</p>
          {brief.themeOfTheDay?.trim() ? (
            <p className="mt-4 rounded-xl border border-[#0f766e]/15 bg-white/70 px-4 py-3 text-sm leading-relaxed text-slate-700">
              <span className="font-semibold text-slate-900">Theme: </span>
              {brief.themeOfTheDay}
            </p>
          ) : null}
        </header>

        <section className="mb-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Fear &amp; greed
          </h2>
          {(brief.sentiment?.meters?.length ?? 0) === 0 ? (
            <p className="italic text-slate-400">No market meters available.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              {brief.sentiment.meters.map((meter) => (
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

        <section className="mb-12">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Markets
          </h2>
          <div className="space-y-8">
            {TICKERS.map((ticker) => {
              const section = brief.tickers.find((t) => t.id === ticker.id);
              const proxy = proxyByTicker.get(ticker.id);
              const pill =
                TICKER_PILL[ticker.id] ?? "bg-slate-100 text-slate-600";

              return (
                <article
                  key={ticker.id}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                >
                  <div className="border-b border-slate-100 px-5 py-4">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill}`}
                    >
                      {ticker.id}
                    </span>
                    <span className="ml-2 text-base font-semibold text-slate-900">
                      {ticker.label}
                    </span>
                  </div>

                  <div className="space-y-4 px-5 py-5">
                    {proxy ? <ProxyBlock proxy={proxy} /> : null}

                    {ticker.tradingViewSymbol ? (
                      <TradingViewChart symbol={ticker.tradingViewSymbol} />
                    ) : (
                      <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm italic text-slate-400">
                        No public TradingView chart (private company).
                      </p>
                    )}

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
                </article>
              );
            })}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Earnings &amp; catalysts
          </h2>
          {brief.earningsCalendar.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm italic text-slate-400">
              No earnings dates available for tracked stocks.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {brief.earningsCalendar.map((event) => (
                <EarningsCard key={event.tickerId} event={event} />
              ))}
            </div>
          )}
        </section>

        <footer className="border-t border-black/5 pt-6 text-center text-xs text-slate-400">
          Charts by TradingView · Generated by Daily Emails
        </footer>
      </div>
    </main>
  );
}
