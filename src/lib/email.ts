import {
  formatBounceRate,
  formatDeltaPercent,
  formatSessionDuration,
  percentChange,
  type SiteAnalytics,
} from "@/lib/analytics";
import type {
  BulletFlag,
  DailyBrief,
  EarningsEvent,
} from "@/lib/brief";
import { getEmailFrom, getEmailTo, PEOPLE, TICKERS } from "@/lib/config";
import { formatHumanDate } from "@/lib/dates";
import type { RedditSubFeed, RedditWindow } from "@/lib/reddit";
import {
  buildFearGreedGaugeAttachments,
  type FearGreedGaugeAttachment,
} from "@/lib/fear-greed-gauge";
import type {
  FearGreedMeter,
  SentimentBand,
  SentimentReport,
  TickerGreedProxy,
  ValueStance,
} from "@/lib/sentiment";
import {
  buildTickerProxyChartAttachments,
  type TickerProxyChartAttachment,
} from "@/lib/ticker-proxy-chart";
import type { BriefTrendItem } from "@/lib/trends";
import {
  formatMetricLimit,
  formatMetricUsed,
  persistResendQuotaFromHeaders,
  type UsageMetric,
  type UsageReport,
} from "@/lib/usage";

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function briefWindowLabel(brief: DailyBrief) {
  return `Past ${brief.windowHours} hours`;
}

const TICKER_COLORS: Record<string, { bg: string; text: string; accent: string }> = {
  TSLA: { bg: "#fff1f0", text: "#b42318", accent: "#f04438" },
  MU: { bg: "#eff8ff", text: "#175cd3", accent: "#2e90fa" },
  META: { bg: "#f4f3ff", text: "#5925dc", accent: "#7a5af8" },
  BTC: { bg: "#fff6ed", text: "#b54708", accent: "#f79009" },
  AVGO: { bg: "#ecfdf3", text: "#067647", accent: "#12b76a" },
  CRCL: { bg: "#f0f9ff", text: "#026aa2", accent: "#0ba5ec" },
  SPCX: { bg: "#f8fafc", text: "#334155", accent: "#64748b" },
  MSFT: { bg: "#eff8ff", text: "#1849a9", accent: "#1570ef" },
};

const TREND_ACCENTS: Record<string, string> = {
  us: "#1d4ed8",
  thailand: "#c2410c",
  bulgaria: "#7c3aed",
};

const FLAG_STYLES: Record<BulletFlag, { bg: string; text: string }> = {
  Actionable: { bg: "#ecfdf5", text: "#047857" },
  Watch: { bg: "#fffbeb", text: "#b45309" },
  Noise: { bg: "#f1f5f9", text: "#64748b" },
};

const BAND_STYLES: Record<SentimentBand, { bg: string; text: string; accent: string }> = {
  "Extreme Fear": { bg: "#fef2f2", text: "#b91c1c", accent: "#dc2626" },
  Fear: { bg: "#fff7ed", text: "#c2410c", accent: "#ea580c" },
  Neutral: { bg: "#f8fafc", text: "#475569", accent: "#64748b" },
  Greed: { bg: "#ecfdf5", text: "#047857", accent: "#10b981" },
  "Extreme Greed": { bg: "#ecfdf5", text: "#065f46", accent: "#059669" },
};

const STANCE_STYLES: Record<ValueStance, { bg: string; text: string }> = {
  "Lean buy": { bg: "#ecfdf5", text: "#047857" },
  Neutral: { bg: "#f1f5f9", text: "#64748b" },
  Patience: { bg: "#fffbeb", text: "#b45309" },
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sectionDivider() {
  return `<tr>
    <td style="padding:16px 0 0 0;">
      <div style="height:1px;background:#cbd5e1;line-height:1px;font-size:1px;">&nbsp;</div>
    </td>
  </tr>`;
}

function sectionLabel(text: string, opts?: { first?: boolean }) {
  const topPad = opts?.first ? "4px" : "22px";
  return `${opts?.first ? "" : sectionDivider()}
  <tr>
    <td style="padding:${topPad} 4px 12px 4px;">
      <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#475569;">${text}</div>
    </td>
  </tr>`;
}

function calloutBox(title: string, body: string, accent = "#0f766e", topPad = "0") {
  return `<tr>
    <td style="padding:${topPad} 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="width:5px;background:${accent};"></td>
          <td style="padding:14px 16px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${accent};margin:0 0 6px 0;">${escapeHtml(title)}</div>
            <div style="font-size:15px;line-height:1.55;color:#1e293b;">${escapeHtml(body)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function flagBadge(flag: BulletFlag) {
  const style = FLAG_STYLES[flag];
  return `<span style="display:inline-block;margin-right:8px;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${style.text};background:${style.bg};border-radius:999px;padding:2px 7px;vertical-align:middle;">${flag}</span>`;
}

function sourceLink(url?: string, name?: string) {
  const label = name?.trim() || "Source";
  if (!url) {
    if (!name?.trim()) return "";
    return ` <span style="color:#94a3b8;font-size:12px;font-weight:600;">${escapeHtml(label)}</span>`;
  }
  return ` <a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:none;font-size:12px;font-weight:600;">${escapeHtml(label)} →</a>`;
}

function trendDisplayTitle(item: BriefTrendItem) {
  const en = item.titleEn.trim();
  const original = item.title.trim();
  if (en && original && en.toLowerCase() !== original.toLowerCase()) {
    return `${escapeHtml(en)} <span style="color:#94a3b8;font-weight:500;">(${escapeHtml(original)})</span>`;
  }
  return escapeHtml(en || original);
}

function trendNewsLine(item: BriefTrendItem) {
  const headline = (item.newsTitleEn || item.newsTitle || item.descriptionEn || "").trim();
  if (!headline) return "";
  const source = item.newsSource ? `${escapeHtml(item.newsSource)} — ` : "";
  const text = `${source}${escapeHtml(headline)}`;
  if (item.newsUrl) {
    return `<a href="${escapeHtml(item.newsUrl)}" style="color:#2563eb;text-decoration:none;">${text}</a>`;
  }
  return text;
}

function trafficBadge(approxTraffic: string) {
  return `<span style="display:inline-block;margin-left:8px;font-size:11px;font-weight:700;letter-spacing:0.02em;color:#0f766e;background:#ecfdf5;border-radius:999px;padding:2px 8px;vertical-align:middle;">${escapeHtml(approxTraffic)}</span>`;
}

function renderTrendRows(items: BriefTrendItem[]) {
  if (items.length === 0) {
    return `<tr><td style="padding:8px 0;font-size:14px;color:#94a3b8;font-style:italic;">No trends available.</td></tr>`;
  }

  return items
    .map((item) => {
      const news = trendNewsLine(item);
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:28px;vertical-align:top;font-size:13px;font-weight:700;color:#94a3b8;padding-top:2px;">#${item.rank}</td>
              <td style="vertical-align:top;">
                <div style="font-size:15px;line-height:1.4;font-weight:600;color:#0f172a;">
                  ${trendDisplayTitle(item)}
                  ${trafficBadge(item.approxTraffic)}
                </div>
                ${news ? `<div style="margin-top:4px;font-size:13px;line-height:1.45;color:#64748b;">${news}</div>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join("");
}

function renderFullTrendSection(region: {
  id: string;
  label: string;
  items: BriefTrendItem[];
}) {
  const accent = TREND_ACCENTS[region.id] ?? "#475569";
  return `
      <tr>
        <td style="padding:0 0 14px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent};margin-right:8px;vertical-align:middle;"></span>
                <span style="font-size:15px;font-weight:700;color:#0f172a;vertical-align:middle;">${escapeHtml(region.label)}</span>
                <span style="margin-left:8px;font-size:12px;color:#94a3b8;vertical-align:middle;">Top ${region.items.length || 10}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 16px 8px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renderTrendRows(region.items)}</table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
}

/** Side-by-side Thailand / Bulgaria — English AI summary of top trends */
function renderTrendSummaryColumn(region: {
  id: string;
  label: string;
  items: BriefTrendItem[];
  summary?: string;
}) {
  const accent = TREND_ACCENTS[region.id] ?? "#475569";
  const summary = region.summary?.trim();
  const body = summary
    ? `<div style="font-size:13px;line-height:1.55;color:#334155;">${escapeHtml(summary)}</div>`
    : `<div style="font-size:12px;color:#94a3b8;font-style:italic;">No trends available.</div>`;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${accent};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-size:13px;font-weight:700;color:#0f172a;vertical-align:middle;">${escapeHtml(region.label)}</span>
          <span style="margin-left:6px;font-size:11px;color:#94a3b8;vertical-align:middle;">Top ${region.items.length || 3} · summary</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px;">
          ${body}
        </td>
      </tr>
    </table>`;
}

function renderOvernightOpeners(brief: DailyBrief) {
  const rows = TICKERS.map((ticker) => {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    const colors = TICKER_COLORS[ticker.id] ?? {
      bg: "#f8fafc",
      text: "#334155",
      accent: "#64748b",
    };
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
        <span style="display:inline-block;font-size:11px;font-weight:700;color:${colors.text};background:${colors.bg};border-radius:999px;padding:2px 8px;margin-right:8px;">${escapeHtml(ticker.id)}</span>
        <span style="font-size:14px;line-height:1.5;color:#334155;">${escapeHtml(section?.overnightOpener || "Quiet overnight.")}</span>
      </td>
    </tr>`;
  }).join("");

  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:15px;font-weight:700;color:#0f172a;">Overnight openers</span>
            <span style="margin-left:8px;font-size:12px;color:#94a3b8;">Pre-market / session context</span>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 16px 8px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function formatEarningsDate(value?: string, opts?: { est?: boolean }) {
  if (!value) return "—";
  const formatted = formatHumanDate(value, { withTime: false });
  if (opts?.est) return `${formatted} (est.)`;
  return formatted;
}

function formatSigned(n: number | undefined, digits = 1) {
  if (n === undefined || !Number.isFinite(n)) return "";
  const fixed = n.toFixed(digits);
  if (n > 0) return `+${fixed}`;
  return fixed;
}

function formatPct(n: number | undefined) {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${formatSigned(n, 1)}%`;
}

/** Human-readable day/week point deltas under fear & greed gauges. */
function formatMeterDeltas(meter: FearGreedMeter) {
  const dayDigits = meter.id === "vix" ? 2 : 1;
  const bits = [
    meter.changeDay !== undefined
      ? `${formatSigned(meter.changeDay, dayDigits)} vs yesterday`
      : "",
    meter.changeWeek !== undefined
      ? `${formatSigned(meter.changeWeek, 1)} vs last week`
      : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function bandBadge(band: SentimentBand | null | undefined) {
  if (!band) return "";
  const style = BAND_STYLES[band];
  return `<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${style.text};background:${style.bg};border-radius:999px;padding:2px 7px;">${escapeHtml(band)}</span>`;
}

function stanceBadge(stance: ValueStance | undefined) {
  if (!stance) return "";
  const style = STANCE_STYLES[stance];
  return `<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${style.text};background:${style.bg};border-radius:999px;padding:2px 7px;">${escapeHtml(stance)}</span>`;
}

function renderMeterColumn(
  meter: FearGreedMeter,
  gaugeCid: string | undefined,
) {
  const deltaBits = formatMeterDeltas(meter);

  const shortLabel =
    meter.id === "cnn" ? "Stocks" : meter.id === "crypto" ? "Crypto" : "VIX";

  const gaugeImg = gaugeCid
    ? `<img src="cid:${escapeHtml(gaugeCid)}" width="220" height="140" alt="${escapeHtml(meter.label)}" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;width:100%;max-width:220px;height:auto;" />`
    : `<div style="padding:28px 8px;font-size:22px;font-weight:700;color:#0f172a;">${
        meter.value == null
          ? "—"
          : meter.id === "vix"
            ? meter.value.toFixed(2)
            : Math.round(meter.value)
      }</div>`;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:10px 10px 4px 10px;text-align:center;">
          <a href="${escapeHtml(meter.sourceUrl)}" style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#64748b;text-decoration:none;">${escapeHtml(shortLabel)}</a>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 4px;">
          ${gaugeImg}
        </td>
      </tr>
      <tr>
        <td style="padding:2px 10px 12px 10px;text-align:center;">
          ${bandBadge(meter.band)}
          ${
            deltaBits
              ? `<div style="margin-top:6px;font-size:11px;color:#94a3b8;">${escapeHtml(deltaBits)}</div>`
              : ""
          }
        </td>
      </tr>
    </table>`;
}

function tickerProxyDetail(proxy: TickerGreedProxy) {
  return [
    proxy.price != null ? `$${proxy.price.toLocaleString("en-US")}` : "",
    proxy.drawdownFromHighPct != null
      ? `${formatPct(proxy.drawdownFromHighPct)} vs 52w high`
      : "",
    proxy.rsi14 != null ? `RSI ${proxy.rsi14}` : "",
    proxy.rangePositionPct != null
      ? `Range ${Math.round(proxy.rangePositionPct)}%`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Compact greed-proxy strip shown inside each Markets ticker card. */
function renderTickerProxyStrip(
  proxy: TickerGreedProxy | undefined,
  chartCid?: string,
) {
  if (!proxy) return "";

  if (proxy.error || proxy.score == null) {
    return `<tr>
      <td style="padding:10px 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;margin:0 0 4px 0;">Greed proxy</div>
        <div style="font-size:13px;color:#94a3b8;font-style:italic;">${escapeHtml(proxy.error || "Unavailable")}</div>
      </td>
    </tr>`;
  }

  const chartImg = chartCid
    ? `<img src="cid:${escapeHtml(chartCid)}" width="560" height="148" alt="Greed proxy ${proxy.score}" style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:560px;height:auto;" />`
    : `<div style="padding:4px 0 2px 0;">
        <span style="font-size:22px;font-weight:700;color:#0f172a;vertical-align:middle;margin-right:8px;">${proxy.score}</span>
        <div style="margin-top:6px;font-size:12px;line-height:1.4;color:#64748b;">
          ${escapeHtml(tickerProxyDetail(proxy))}
        </div>
      </div>`;

  return `<tr>
    <td style="padding:12px 18px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:middle;padding:0 0 8px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;">Greed proxy</div>
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  ${bandBadge(proxy.band)}
                  <span style="display:inline-block;margin-left:6px;vertical-align:middle;">${stanceBadge(proxy.stance)}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            ${chartImg}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderSentimentSection(
  sentiment: SentimentReport | undefined,
  gaugeAttachments: FearGreedGaugeAttachment[] = [],
) {
  if (!sentiment) return "";

  const meters = sentiment.meters ?? [];
  const cidByMeter = new Map(
    gaugeAttachments.map((item) => [item.meterId, item.contentId] as const),
  );

  const meterRow =
    meters.length === 0
      ? `<tr><td style="padding:0 0 14px 0;font-size:14px;color:#94a3b8;font-style:italic;">No market meters available.</td></tr>`
      : `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          ${meters
            .map((meter, index) => {
              const pad =
                index === 0
                  ? "0 4px 0 0"
                  : index === meters.length - 1
                    ? "0 0 0 4px"
                    : "0 4px";
              return `<td class="stack-col" width="33.33%" style="width:33.33%;padding:${pad};vertical-align:top;">
              ${renderMeterColumn(meter, cidByMeter.get(meter.id))}
            </td>`;
            })
            .join("")}
        </tr>
      </table>
    </td>
  </tr>`;

  return `${sectionLabel("Fear &amp; greed", { first: true })}
  ${meterRow}`;
}

function renderEarningsCard(event: EarningsEvent) {
  const colors = TICKER_COLORS[event.tickerId] ?? {
    bg: "#f8fafc",
    text: "#334155",
    accent: "#64748b",
  };
  const previous = formatEarningsDate(event.previousDate);
  const next = formatEarningsDate(event.nextDate, {
    est: Boolean(event.nextDate) && event.nextConfirmed === false,
  });

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:10px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:middle;padding:0 0 8px 0;">
                <span style="display:inline-block;font-size:11px;font-weight:700;color:${colors.text};background:${colors.bg};border-radius:999px;padding:2px 8px;">${escapeHtml(event.tickerId)}</span>
              </td>
            </tr>
            <tr>
              <td width="50%" style="width:50%;padding:0 4px 0 0;vertical-align:top;">
                <div style="font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;">Prev</div>
                <div style="margin-top:2px;font-size:13px;line-height:1.3;font-weight:600;color:#334155;">${escapeHtml(previous)}</div>
              </td>
              <td width="50%" style="width:50%;padding:0 0 0 4px;vertical-align:top;">
                <div style="font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;">Next</div>
                <div style="margin-top:2px;font-size:13px;line-height:1.3;font-weight:600;color:#0f172a;">${escapeHtml(next)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

function renderEarningsCalendar(events: EarningsEvent[]) {
  if (events.length === 0) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <div style="font-size:14px;line-height:1.5;color:#94a3b8;font-style:italic;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
          No earnings dates available for tracked stocks.
        </div>
      </td>
    </tr>`;
  }

  const rows: string[] = [];
  for (let i = 0; i < events.length; i += 2) {
    const left = events[i];
    const right = events[i + 1];
    rows.push(`<tr>
      <td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="stack-col" width="50%" style="width:50%;padding:0 5px 0 0;vertical-align:top;">
              ${left ? renderEarningsCard(left) : ""}
            </td>
            <td class="stack-col" width="50%" style="width:50%;padding:0 0 0 5px;vertical-align:top;">
              ${right ? renderEarningsCard(right) : ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>`);
  }

  return rows.join("");
}

function percentColor(percent: number, available: boolean) {
  if (!available) return "#94a3b8";
  if (percent >= 90) return "#b42318";
  if (percent >= 70) return "#b45309";
  if (percent >= 50) return "#a16207";
  return "#047857";
}

function redditWindowLabel(window: RedditWindow) {
  if (window === "day") return "Top · day";
  if (window === "week") return "Top · week";
  return "Hot";
}

function siteOrigin() {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production.replace(/^https?:\/\//, "")}`;
  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) return `https://${deployment.replace(/^https?:\/\//, "")}`;
  return undefined;
}

const REDDIT_THUMB_SIZE = 110;
const REDDIT_POSTS_PER_ROW = 3;

/** Crossed-out picture icon when a post has no thumbnail. */
function redditNoImageThumbHtml() {
  const size = REDDIT_THUMB_SIZE;
  const origin = siteOrigin();
  if (origin) {
    return `<img src="${escapeHtml(`${origin}/reddit-no-image.svg`)}" width="${size}" height="${size}" alt="No image" style="display:block;width:100%;max-width:${size}px;height:auto;aspect-ratio:1/1;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;background:#f1f5f9;" />`;
  }

  // Fallback when no public origin is available (local sends).
  return `<table role="presentation" width="${size}" height="${size}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${size}px;height:${size}px;border-radius:8px;border:1px solid #e2e8f0;background:#f1f5f9;"><tr><td align="center" valign="middle" width="${size}" height="${size}" style="width:${size}px;height:${size}px;font-size:22px;line-height:22px;color:#64748b;font-family:${FONT};" title="No image">∅</td></tr></table>`;
}

function renderRedditPostCell(post: RedditSubFeed["posts"][number], rank: number) {
  const thumb = post.thumbnail
    ? `<img src="${escapeHtml(post.thumbnail)}" width="${REDDIT_THUMB_SIZE}" height="${REDDIT_THUMB_SIZE}" alt="" style="display:block;width:100%;max-width:${REDDIT_THUMB_SIZE}px;height:auto;aspect-ratio:1/1;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;" />`
    : redditNoImageThumbHtml();

  return `<td width="33.33%" style="width:33.33%;padding:2px;vertical-align:top;">
      <a href="${escapeHtml(post.permalink)}" style="text-decoration:none;">${thumb}</a>
      <div style="padding:4px 0 1px 0;">
        <div style="font-size:9px;font-weight:700;color:#94a3b8;line-height:1.2;margin:0 0 2px 0;">${rank}</div>
        <a href="${escapeHtml(post.permalink)}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:2.6em;font-size:10px;line-height:1.3;font-weight:600;color:#0f172a;text-decoration:none;">${escapeHtml(post.title)}</a>
      </div>
    </td>`;
}

function renderRedditPostGrid(posts: RedditSubFeed["posts"]) {
  if (posts.length === 0) {
    return `<tr><td style="padding:8px 0;font-size:12px;color:#94a3b8;font-style:italic;">No posts available.</td></tr>`;
  }

  const rows: string[] = [];
  for (let i = 0; i < posts.length; i += REDDIT_POSTS_PER_ROW) {
    const slice = posts.slice(i, i + REDDIT_POSTS_PER_ROW);
    const cells = slice.map((post, j) => renderRedditPostCell(post, i + j + 1));
    while (cells.length < REDDIT_POSTS_PER_ROW) {
      cells.push(`<td width="33.33%" style="width:33.33%;padding:2px;"></td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return rows.join("");
}

function renderRedditSubColumn(feed: RedditSubFeed) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
          <span style="font-size:13px;font-weight:700;color:#0f172a;vertical-align:middle;">${escapeHtml(feed.label)}</span>
          <span style="margin-left:6px;font-size:11px;color:#94a3b8;vertical-align:middle;">${escapeHtml(redditWindowLabel(feed.window))}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:4px 4px 8px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renderRedditPostGrid(feed.posts)}</table>
        </td>
      </tr>
    </table>`;
}

/** Pair subreddit cards into a 2-column grid to keep the email shorter. */
function renderRedditSection(feeds: RedditSubFeed[]) {
  if (feeds.length === 0) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <div style="font-size:14px;line-height:1.5;color:#94a3b8;font-style:italic;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
          No Reddit posts available.
        </div>
      </td>
    </tr>`;
  }

  const rows: string[] = [];
  for (let i = 0; i < feeds.length; i += 2) {
    const left = feeds[i];
    const right = feeds[i + 1];
    rows.push(`<tr>
      <td style="padding:0 0 12px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="stack-col" width="50%" style="width:50%;padding:0 4px 0 0;vertical-align:top;">
              ${left ? renderRedditSubColumn(left) : ""}
            </td>
            <td class="stack-col" width="50%" style="width:50%;padding:0 0 0 4px;vertical-align:top;">
              ${right ? renderRedditSubColumn(right) : ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>`);
  }

  return rows.join("");
}

function deltaColor(delta: number | null) {
  if (delta === null || delta === 0) return "#94a3b8";
  return delta > 0 ? "#047857" : "#b42318";
}

function deltaBadgeBg(delta: number | null) {
  if (delta === null || delta === 0) return "#f1f5f9";
  return delta > 0 ? "#ecfdf5" : "#fef2f2";
}

function formatCount(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

function shortWeekday(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function siteAccent(label: string) {
  const accents = [
    { strong: "#0d9488", soft: "#99f6e4", chip: "#f0fdfa" },
    { strong: "#2563eb", soft: "#bfdbfe", chip: "#eff6ff" },
    { strong: "#7c3aed", soft: "#ddd6fe", chip: "#f5f3ff" },
    { strong: "#c2410c", soft: "#fdba74", chip: "#fff7ed" },
    { strong: "#0891b2", soft: "#a5f3fc", chip: "#ecfeff" },
  ] as const;
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash + label.charCodeAt(i) * (i + 1)) % accents.length;
  }
  return accents[hash] ?? accents[0];
}

function renderDeltaBadge(delta: number | null) {
  const label = formatDeltaPercent(delta);
  return `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.02em;color:${deltaColor(delta)};background:${deltaBadgeBg(delta)};border-radius:999px;padding:3px 8px;vertical-align:middle;">${escapeHtml(label)} vs prior day</span>`;
}

function renderHeroKpi(
  label: string,
  value: string,
  delta?: number | null,
  opts?: { emphasize?: boolean },
) {
  const valueSize = opts?.emphasize ? "26px" : "20px";
  const deltaHtml =
    delta === undefined
      ? ""
      : `<div style="margin-top:6px;">${renderDeltaBadge(delta)}</div>`;
  return `<td class="stack-col" style="padding:0 6px;vertical-align:top;width:33.33%;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
      <tr>
        <td style="padding:12px 12px 14px 12px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;">${escapeHtml(label)}</div>
          <div style="margin-top:6px;font-size:${valueSize};line-height:1.15;font-weight:700;color:#0f172a;">${escapeHtml(value)}</div>
          ${deltaHtml}
        </td>
      </tr>
    </table>
  </td>`;
}

function renderSecondaryMetric(label: string, value: string) {
  return `<td class="stack-col" style="padding:0 4px;vertical-align:top;width:50%;">
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#94a3b8;">${escapeHtml(label)}</div>
      <div style="margin-top:4px;font-size:15px;font-weight:700;color:#334155;">${escapeHtml(value)}</div>
    </div>
  </td>`;
}

/** Email-safe 7-day users bar chart (HTML tables, no images). */
function renderUsersBarChart(
  series: SiteAnalytics["dailySeries"],
  accent: ReturnType<typeof siteAccent>,
) {
  const points = series.length > 0 ? series : [];
  if (points.length === 0) {
    return `<div style="font-size:12px;color:#94a3b8;font-style:italic;">No trend data.</div>`;
  }

  const maxUsers = Math.max(...points.map((p) => p.activeUsers), 1);
  const barMaxHeight = 56;

  const bars = points
    .map((point, index) => {
      const height = Math.max(
        4,
        Math.round((point.activeUsers / maxUsers) * barMaxHeight),
      );
      const isLast = index === points.length - 1;
      const barColor = isLast ? accent.strong : accent.soft;
      const labelColor = isLast ? "#0f172a" : "#94a3b8";
      const weight = isLast ? "700" : "600";
      return `<td style="padding:0 3px;vertical-align:bottom;text-align:center;width:${Math.floor(100 / points.length)}%;">
        <div style="font-size:10px;font-weight:700;color:#64748b;margin:0 0 4px 0;line-height:1;">${formatCount(point.activeUsers)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:${barMaxHeight}px;">
          <tr>
            <td style="vertical-align:bottom;height:${barMaxHeight}px;">
              <div style="height:${height}px;background:${barColor};border-radius:6px 6px 2px 2px;line-height:1px;font-size:1px;">&nbsp;</div>
            </td>
          </tr>
        </table>
        <div style="margin-top:6px;font-size:10px;font-weight:${weight};color:${labelColor};">${escapeHtml(shortWeekday(point.date))}</div>
      </td>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${bars}</tr>
  </table>`;
}

function renderMtdStat(label: string, value: string) {
  return `<td class="stack-col" style="padding:0 4px;vertical-align:top;width:25%;text-align:center;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;">${escapeHtml(label)}</div>
    <div style="margin-top:4px;font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(value)}</div>
  </td>`;
}

function renderSiteCard(site: SiteAnalytics) {
  const accent = siteAccent(site.label);

  if (site.error) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:4px;background:${accent.strong};line-height:1px;font-size:1px;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:16px;font-weight:700;color:#0f172a;">${escapeHtml(site.label)}</div>
              <div style="margin-top:8px;font-size:13px;line-height:1.45;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;">${escapeHtml(site.error)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  const usersDelta = percentChange(
    site.metrics.activeUsers,
    site.previous.activeUsers,
  );
  const sessionsDelta = percentChange(
    site.metrics.sessions,
    site.previous.sessions,
  );
  const viewsDelta = percentChange(
    site.metrics.screenPageViews,
    site.previous.screenPageViews,
  );
  const mtd = site.monthToDate;
  const dateLabel = formatHumanDate(site.date, { withTime: false });
  const mtdRange = `${formatHumanDate(site.monthStart, { withTime: false })} – ${dateLabel}`;

  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="height:4px;background:${accent.strong};line-height:1px;font-size:1px;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:16px 18px 8px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-size:17px;font-weight:700;color:#0f172a;">${escapeHtml(site.label)}</div>
                  <div style="margin-top:3px;font-size:12px;color:#64748b;">Yesterday · ${escapeHtml(dateLabel)}</div>
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  <span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${accent.strong};background:${accent.chip};border-radius:999px;padding:4px 9px;">GA4</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 12px 4px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${renderHeroKpi("Users", formatCount(site.metrics.activeUsers), usersDelta, { emphasize: true })}
                ${renderHeroKpi("Sessions", formatCount(site.metrics.sessions), sessionsDelta)}
                ${renderHeroKpi("Pageviews", formatCount(site.metrics.screenPageViews), viewsDelta)}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 14px 4px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${renderSecondaryMetric("Bounce rate", formatBounceRate(site.metrics.bounceRate))}
                ${renderSecondaryMetric("Avg duration", formatSessionDuration(site.metrics.averageSessionDuration))}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 18px 8px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-size:12px;font-weight:700;color:#0f172a;">Users · last 7 days</div>
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  <div style="font-size:11px;color:#94a3b8;">UTC days through yesterday</div>
                </td>
              </tr>
            </table>
            <div style="margin-top:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 8px 10px 8px;">
              ${renderUsersBarChart(site.dailySeries ?? [], accent)}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 18px 16px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
              <tr>
                <td style="padding:12px 12px 10px 12px;">
                  <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#64748b;margin:0 0 10px 0;">
                    Month to date · ${escapeHtml(mtdRange)}
                  </div>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      ${renderMtdStat("Users", formatCount(mtd.activeUsers))}
                      ${renderMtdStat("Sessions", formatCount(mtd.sessions))}
                      ${renderMtdStat("Pageviews", formatCount(mtd.screenPageViews))}
                      ${renderMtdStat("Bounce", formatBounceRate(mtd.bounceRate))}
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderSitesSection(sites: SiteAnalytics[]) {
  if (sites.length === 0) return "";
  return `${sectionLabel("Google Analytics")}
    <tr>
      <td style="padding:0 4px 12px 4px;">
        <div style="font-size:13px;line-height:1.5;color:#64748b;">
          Yesterday vs prior day, plus a 7-day users trend and month-to-date totals.
        </div>
      </td>
    </tr>
    ${sites.map(renderSiteCard).join("")}`;
}

function renderUsageWatch(usage: UsageReport) {
  if (usage.watch.length === 0) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <div style="font-size:14px;line-height:1.5;color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px 16px;">
          All tracked quotas are under ${usage.thresholdPercent}% of their limits.
        </div>
      </td>
    </tr>`;
  }

  const rows = usage.watch
    .map((m) => {
      const color = percentColor(m.percent, true);
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(m.label)}</div>
          <div style="margin-top:2px;font-size:13px;color:#475569;">${escapeHtml(m.detail)}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;text-align:right;white-space:nowrap;">
          <span style="font-size:16px;font-weight:700;color:${color};">${m.percent}%</span>
        </td>
      </tr>`;
    })
    .join("");

  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #fde68a;">
            <span style="font-size:15px;font-weight:700;color:#92400e;">Usage watch</span>
            <span style="margin-left:8px;font-size:12px;color:#b45309;">≥ ${usage.thresholdPercent}% of limit</span>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 16px 8px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderUsageRow(m: UsageMetric) {
  const color = percentColor(m.percent, m.available);
  const pct = m.available ? `${m.percent}%` : "—";
  const usedLimit = m.available
    ? `${formatMetricUsed(m)} / ${formatMetricLimit(m)}`
    : "n/a";
  return `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
      <div style="font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(m.label)}</div>
      <div style="margin-top:2px;font-size:12px;line-height:1.45;color:#64748b;">${escapeHtml(m.detail)}</div>
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;text-align:right;white-space:nowrap;">
      <div style="font-size:13px;font-weight:600;color:#334155;">${escapeHtml(usedLimit)}</div>
      <div style="margin-top:2px;font-size:15px;font-weight:700;color:${color};">${pct}</div>
    </td>
  </tr>`;
}

function isResendUsageMetric(m: UsageMetric) {
  return m.id.startsWith("resend-");
}

function splitUsageMetrics(metrics: UsageMetric[]) {
  const vercel: UsageMetric[] = [];
  const resend: UsageMetric[] = [];
  for (const m of metrics) {
    if (isResendUsageMetric(m)) resend.push(m);
    else vercel.push(m);
  }
  return { vercel, resend };
}

function renderUsageBrandHeader(opts: {
  logoHtml: string;
  title?: string;
  subtitle?: string;
}) {
  const title = opts.title
    ? `<span style="font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">${opts.title}</span>`
    : "";
  const subtitle = opts.subtitle
    ? `<span style="margin-left:8px;font-size:12px;color:#94a3b8;">${opts.subtitle}</span>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0">
    <tr>
      <td style="padding:0 10px 0 0;vertical-align:middle;">${opts.logoHtml}</td>
      <td style="vertical-align:middle;">${title}${subtitle}</td>
    </tr>
  </table>`;
}

function renderUsageTable(opts: {
  headerHtml: string;
  metrics: UsageMetric[];
}) {
  if (opts.metrics.length === 0) return "";
  const rows = opts.metrics.map(renderUsageRow).join("");
  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            ${opts.headerHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:4px 16px 8px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderUsageReport(usage: UsageReport) {
  const { vercel, resend } = splitUsageMetrics(usage.metrics);
  const vercelLogo = `<img src="https://assets.vercel.com/image/upload/q_auto/front/assets/design/vercel-triangle-black.png" width="16" height="14" alt="" style="display:block;border:0;outline:none;text-decoration:none;width:16px;height:14px;" />`;
  const resendLogo = `<img src="https://cdn.resend.com/brand/resend-wordmark-black.png" width="78" height="18" alt="Resend" style="display:block;border:0;outline:none;text-decoration:none;width:78px;height:18px;" />`;

  return `
    ${renderUsageWatch(usage)}
    ${renderUsageTable({
      headerHtml: renderUsageBrandHeader({
        logoHtml: vercelLogo,
        title: "Vercel",
        subtitle: "Gateway · FOT · Blob",
      }),
      metrics: vercel,
    })}
    ${renderUsageTable({
      headerHtml: renderUsageBrandHeader({
        logoHtml: resendLogo,
        subtitle: "Daily · Monthly",
      }),
      metrics: resend,
    })}`;
}

export function renderBriefHtml(
  brief: DailyBrief,
  usage?: UsageReport,
  gaugeAttachments: FearGreedGaugeAttachment[] = [],
  proxyChartAttachments: TickerProxyChartAttachment[] = [],
) {
  const date = formatHumanDate(brief.generatedAt);
  const dateShort = formatHumanDate(brief.generatedAt, { withTime: false });

  const proxyByTicker = new Map(
    (brief.sentiment?.tickers ?? []).map(
      (proxy) => [proxy.tickerId, proxy] as const,
    ),
  );
  const proxyChartCidByTicker = new Map(
    proxyChartAttachments.map(
      (item) => [item.tickerId, item.contentId] as const,
    ),
  );

  const tickerSections = TICKERS.map((ticker) => {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    const proxy = proxyByTicker.get(ticker.id);
    const colors = TICKER_COLORS[ticker.id] ?? {
      bg: "#f8fafc",
      text: "#334155",
      accent: "#64748b",
    };
    const bullets =
      section?.bullets?.length
        ? section.bullets
            .map(
              (b) =>
                `<tr>
                  <td style="padding:0 0 10px 0;font-size:15px;line-height:1.55;color:#1e293b;">
                    ${flagBadge(b.flag)}${escapeHtml(b.text)}${sourceLink(b.sourceUrl, b.sourceName)}
                  </td>
                </tr>`,
            )
            .join("")
        : `<tr><td style="font-size:15px;color:#64748b;">No material headlines in the last 24 hours.</td></tr>`;

    return `
      <tr>
        <td style="padding:0 0 16px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:14px 18px;background:${colors.bg};border-bottom:1px solid #e2e8f0;">
                <span style="display:inline-block;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${colors.text};background:#fff;border:1px solid ${colors.accent}33;border-radius:999px;padding:4px 10px;">${escapeHtml(ticker.id)}</span>
                <span style="display:inline-block;margin-left:8px;font-size:16px;font-weight:600;color:#0f172a;">${escapeHtml(ticker.label)}</span>
              </td>
            </tr>
            ${renderTickerProxyStrip(proxy, proxyChartCidByTicker.get(ticker.id))}
            <tr>
              <td style="padding:16px 18px 8px 18px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bullets}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 18px 14px 18px;">
                <div style="font-size:13px;line-height:1.5;color:#334155;background:#f8fafc;border-radius:10px;padding:10px 12px;">
                  <span style="font-weight:700;color:#0f172a;">Why it matters:</span> ${escapeHtml(section?.whyItMatters || "Limited coverage today.")}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }).join("");

  const peopleSections = PEOPLE.map((person, index) => {
    const section = brief.people.find((p) => p.id === person.id);
    const summary = section?.summary?.trim() || "None found";
    const isNone = summary.toLowerCase() === "none found";
    const accents = ["#0d9488", "#2563eb", "#db2777", "#ca8a04"];
    const accent = accents[index % accents.length];
    const quote = section?.quote?.trim();
    const link = !isNone && section?.sourceUrl
      ? sourceLink(section.sourceUrl)
      : "";

    return `
      <tr>
        <td style="padding:0 0 12px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
            <tr>
              <td style="width:5px;background:${accent};border-radius:12px 0 0 12px;"></td>
              <td style="padding:14px 16px;">
                <div style="font-size:15px;font-weight:700;color:#0f172a;margin:0 0 6px 0;">${escapeHtml(person.name)}</div>
                <div style="font-size:14px;line-height:1.55;color:${isNone ? "#94a3b8" : "#334155"};font-style:${isNone ? "italic" : "normal"};">${escapeHtml(summary)}${link}</div>
                ${
                  quote
                    ? `<div style="margin-top:8px;font-size:13px;line-height:1.5;color:#475569;border-left:3px solid ${accent};padding-left:10px;font-style:italic;">“${escapeHtml(quote)}”</div>`
                    : ""
                }
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }).join("");

  const regions = brief.trends?.regions ?? [];
  const usRegion = regions.find((r) => r.id === "us");
  const thailandRegion = regions.find((r) => r.id === "thailand");
  const bulgariaRegion = regions.find((r) => r.id === "bulgaria");

  const trendSections = [
    usRegion ? renderFullTrendSection(usRegion) : "",
    thailandRegion || bulgariaRegion
      ? `<tr>
        <td style="padding:0 0 14px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td class="stack-col" width="50%" style="width:50%;padding:0 6px 0 0;vertical-align:top;">
                ${thailandRegion ? renderTrendSummaryColumn(thailandRegion) : ""}
              </td>
              <td class="stack-col" width="50%" style="width:50%;padding:0 0 0 6px;vertical-align:top;">
                ${bulgariaRegion ? renderTrendSummaryColumn(bulgariaRegion) : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>`
      : "",
  ].join("");

  const crossRegion =
    brief.trends?.crossRegion?.length > 0
      ? `<tr>
        <td style="padding:0 0 16px 0;">
          <div style="font-size:13px;line-height:1.5;color:#475569;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;">
            <span style="font-weight:700;color:#0f172a;">Also rising in 2+ regions:</span>
            ${escapeHtml(brief.trends.crossRegion.join(" · "))}
          </div>
        </td>
      </tr>`
      : "";

  const preheader = `${brief.themeOfTheDay} · ${dateShort}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>Daily Brief ${escapeHtml(dateShort)}</title>
    <style type="text/css">
      :root { color-scheme: light; supported-color-schemes: light; }
      @media only screen and (max-width: 620px) {
        .stack-col {
          display: block !important;
          width: 100% !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
        }
        .stack-col + .stack-col {
          padding-top: 10px !important;
        }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#eef2ff;font-family:${FONT};">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg,#dbeafe 0%,#eef2ff 180px,#f8fafc 180px);padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:820px;margin:0 auto;">
            <tr>
              <td style="padding:0 0 18px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0f766e 0%,#1d4ed8 55%,#7c3aed 100%);border-radius:18px;overflow:hidden;">
                  <tr>
                    <td style="padding:28px 28px 24px 28px;">
                      <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ccfbf1;margin:0 0 8px 0;">Daily Emails</div>
                      <div style="font-size:28px;line-height:1.2;font-weight:700;color:#ffffff;margin:0 0 10px 0;">Daily Market &amp; Tech Brief</div>
                      <div style="font-size:13px;line-height:1.5;color:#e0e7ff;">
                        ${briefWindowLabel(brief)} · ${escapeHtml(date)}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            ${calloutBox("Theme of the day", brief.themeOfTheDay, "#7c3aed")}
            ${renderSentimentSection(brief.sentiment, gaugeAttachments)}

            ${sectionLabel("Overnight")}
            ${renderOvernightOpeners(brief)}

            ${sectionLabel("Markets")}
            ${tickerSections}

            ${sectionLabel("Earnings &amp; catalysts")}
            ${renderEarningsCalendar(brief.earningsCalendar)}

            ${sectionLabel("Speeches &amp; announcements")}
            ${peopleSections}

            ${
              brief.regionalPulse?.trim()
                ? `${sectionDivider()}${calloutBox("Regional pulse", brief.regionalPulse, "#c2410c", "22px")}`
                : ""
            }

            ${
              (brief.trends?.regions ?? []).some(
                (region) =>
                  region.items.length > 0 || Boolean(region.summary?.trim()),
              ) || (brief.trends?.crossRegion?.length ?? 0) > 0
                ? `${sectionLabel("Web trends")}${trendSections}${crossRegion}`
                : ""
            }

            ${
              (brief.reddit ?? []).some((feed) => feed.posts.length > 0)
                ? `${sectionLabel("Reddit")}${renderRedditSection(brief.reddit ?? [])}`
                : ""
            }

            ${renderSitesSection(brief.sites ?? [])}

            ${usage ? `${sectionLabel("Usage")}${renderUsageReport(usage)}` : ""}

            <tr>
              <td style="padding:18px 8px 8px 8px;text-align:center;">
                <div style="font-size:12px;line-height:1.5;color:#94a3b8;">
                  Generated by Daily Emails · ${escapeHtml(brief.model)}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderBriefText(brief: DailyBrief, usage?: UsageReport) {
  const lines = [
    "Daily Market & Tech Brief",
    `${briefWindowLabel(brief)} · ${formatHumanDate(brief.generatedAt)} · ${brief.model}`,
    "",
    "THEME OF THE DAY",
    brief.themeOfTheDay,
  ];

  if (brief.sentiment) {
    lines.push("", "FEAR & GREED");
    for (const meter of brief.sentiment.meters) {
      if (meter.value == null) {
        lines.push(
          `- ${meter.label}: unavailable${meter.error ? ` (${meter.error})` : ""}`,
        );
        continue;
      }
      const band = meter.band ? ` · ${meter.band}` : "";
      const deltas = formatMeterDeltas(meter);
      lines.push(
        `- ${meter.label}: ${meter.id === "vix" ? meter.value.toFixed(2) : Math.round(meter.value)}${band}${deltas ? ` (${deltas})` : ""}`,
      );
    }
  }

  lines.push("", "OVERNIGHT OPENERS");

  for (const ticker of TICKERS) {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    lines.push(`${ticker.id}: ${section?.overnightOpener || "Quiet overnight."}`);
  }

  const proxyByTickerText = new Map(
    (brief.sentiment?.tickers ?? []).map(
      (proxy) => [proxy.tickerId, proxy] as const,
    ),
  );

  lines.push("", "MARKETS");
  for (const ticker of TICKERS) {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    const proxy = proxyByTickerText.get(ticker.id);
    lines.push("", ticker.label);
    if (proxy) {
      if (proxy.score == null) {
        lines.push(`Greed proxy: ${proxy.error || "unavailable"}`);
      } else {
        const bits = [
          `score ${proxy.score}`,
          proxy.band,
          proxy.stance,
          tickerProxyDetail(proxy),
        ]
          .filter(Boolean)
          .join(" · ");
        lines.push(`Greed proxy: ${bits}`);
      }
    }
    if (section?.bullets?.length) {
      for (const bullet of section.bullets) {
        const source = bullet.sourceName
          ? ` · ${bullet.sourceName}`
          : bullet.sourceUrl
            ? " · Source"
            : "";
        const link = bullet.sourceUrl ? ` (${bullet.sourceUrl})` : "";
        lines.push(`- [${bullet.flag}] ${bullet.text}${source}${link}`);
      }
    } else {
      lines.push("- No material headlines in the last 24 hours.");
    }
    lines.push(`Why it matters: ${section?.whyItMatters || "n/a"}`);
  }

  lines.push("", "EARNINGS & CATALYSTS");
  if (brief.earningsCalendar.length === 0) {
    lines.push("No earnings dates available for tracked stocks.");
  } else {
    for (const event of brief.earningsCalendar) {
      const previous = formatEarningsDate(event.previousDate);
      const next = formatEarningsDate(event.nextDate, {
        est: Boolean(event.nextDate) && event.nextConfirmed === false,
      });
      lines.push(`- ${event.tickerId} · Previous ${previous} · Next ${next}`);
    }
  }

  lines.push("", "SPEECHES & ANNOUNCEMENTS");
  for (const person of PEOPLE) {
    const section = brief.people.find((p) => p.id === person.id);
    lines.push("", person.name, section?.summary?.trim() || "None found");
    if (section?.quote) lines.push(`  “${section.quote}”`);
    if (section?.sourceUrl) lines.push(`  ${section.sourceUrl}`);
  }

  if (brief.regionalPulse?.trim()) {
    lines.push("", "REGIONAL PULSE", brief.regionalPulse);
  }

  const trendRegions = brief.trends?.regions ?? [];
  const hasTrendContent =
    trendRegions.some(
      (region) => region.items.length > 0 || Boolean(region.summary?.trim()),
    ) || (brief.trends?.crossRegion?.length ?? 0) > 0;
  if (hasTrendContent) {
    lines.push("", "WEB TRENDS");
    for (const region of trendRegions) {
      lines.push("", region.label);
      if (region.summary?.trim()) {
        lines.push(region.summary.trim());
        continue;
      }
      if (region.items.length === 0) {
        lines.push("- No trends available.");
        continue;
      }
      for (const item of region.items) {
        const en = item.titleEn.trim();
        const original = item.title.trim();
        const title =
          en && original && en.toLowerCase() !== original.toLowerCase()
            ? `${en} (${original})`
            : en || original;
        lines.push(`#${item.rank} ${title} · ${item.approxTraffic}`);
        const headline = (
          item.descriptionEn ||
          item.newsTitleEn ||
          item.newsTitle ||
          ""
        ).trim();
        if (headline) {
          const source = item.newsSource ? `${item.newsSource} — ` : "";
          const url = item.newsUrl ? ` (${item.newsUrl})` : "";
          lines.push(`  ${source}${headline}${url}`);
        }
      }
    }
    if (brief.trends?.crossRegion?.length) {
      lines.push(
        "",
        `Also rising in 2+ regions: ${brief.trends.crossRegion.join(" · ")}`,
      );
    }
  }

  const redditFeeds = (brief.reddit ?? []).filter((feed) => feed.posts.length > 0);
  if (redditFeeds.length > 0) {
    lines.push("", "REDDIT");
    for (const feed of redditFeeds) {
      lines.push("", `${feed.label} (${redditWindowLabel(feed.window)})`);
      for (const [index, post] of feed.posts.entries()) {
        lines.push(`${index + 1}. ${post.title}`);
        lines.push(`   ${post.permalink}`);
      }
    }
  }

  if (brief.sites?.length) {
    lines.push("", "GOOGLE ANALYTICS");
    for (const site of brief.sites) {
      lines.push("", site.label);
      if (site.error) {
        lines.push(`  Error: ${site.error}`);
        continue;
      }
      const usersDelta = formatDeltaPercent(
        percentChange(site.metrics.activeUsers, site.previous.activeUsers),
      );
      const sessionsDelta = formatDeltaPercent(
        percentChange(site.metrics.sessions, site.previous.sessions),
      );
      const viewsDelta = formatDeltaPercent(
        percentChange(
          site.metrics.screenPageViews,
          site.previous.screenPageViews,
        ),
      );
      lines.push(
        `  Yesterday (${formatHumanDate(site.date, { withTime: false })})`,
      );
      lines.push(
        `  Users: ${Math.round(site.metrics.activeUsers)} (${usersDelta})`,
      );
      lines.push(
        `  Sessions: ${Math.round(site.metrics.sessions)} (${sessionsDelta})`,
      );
      lines.push(
        `  Pageviews: ${Math.round(site.metrics.screenPageViews)} (${viewsDelta})`,
      );
      lines.push(`  Bounce: ${formatBounceRate(site.metrics.bounceRate)}`);
      lines.push(
        `  Avg duration: ${formatSessionDuration(site.metrics.averageSessionDuration)}`,
      );
      if (site.dailySeries?.length) {
        const trend = site.dailySeries
          .map((p) => `${shortWeekday(p.date)} ${Math.round(p.activeUsers)}`)
          .join(" · ");
        lines.push(`  Users last 7 days: ${trend}`);
      }
      const mtd = site.monthToDate;
      if (mtd) {
        lines.push(
          `  Month to date (${formatHumanDate(site.monthStart, { withTime: false })} – ${formatHumanDate(site.date, { withTime: false })})`,
        );
        lines.push(`  Users: ${Math.round(mtd.activeUsers)}`);
        lines.push(`  Sessions: ${Math.round(mtd.sessions)}`);
        lines.push(`  Pageviews: ${Math.round(mtd.screenPageViews)}`);
        lines.push(`  Bounce: ${formatBounceRate(mtd.bounceRate)}`);
        lines.push(
          `  Avg duration: ${formatSessionDuration(mtd.averageSessionDuration)}`,
        );
      }
    }
  }

  if (usage) {
    lines.push("", "USAGE WATCH");
    if (usage.watch.length === 0) {
      lines.push(
        `All tracked quotas are under ${usage.thresholdPercent}% of their limits.`,
      );
    } else {
      for (const m of usage.watch) {
        lines.push(
          `- ${m.label}: ${m.percent}% (${formatMetricUsed(m)} / ${formatMetricLimit(m)})`,
        );
        lines.push(`  ${m.detail}`);
      }
    }

    const { vercel, resend } = splitUsageMetrics(usage.metrics);
    if (vercel.length > 0) {
      lines.push("", "VERCEL USAGE");
      for (const m of vercel) {
        if (!m.available) {
          lines.push(`- ${m.label}: unavailable — ${m.detail}`);
          continue;
        }
        lines.push(
          `- ${m.label}: ${formatMetricUsed(m)} / ${formatMetricLimit(m)} (${m.percent}%)`,
        );
        lines.push(`  ${m.detail}`);
      }
    }
    if (resend.length > 0) {
      lines.push("", "RESEND USAGE");
      for (const m of resend) {
        if (!m.available) {
          lines.push(`- ${m.label}: unavailable — ${m.detail}`);
          continue;
        }
        lines.push(
          `- ${m.label}: ${formatMetricUsed(m)} / ${formatMetricLimit(m)} (${m.percent}%)`,
        );
        lines.push(`  ${m.detail}`);
      }
    }
  }

  return lines.join("\n");
}

export async function sendBriefEmail(brief: DailyBrief, usage?: UsageReport) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required");
  }

  const gaugeAttachments = await buildFearGreedGaugeAttachments(
    brief.sentiment?.meters ?? [],
  ).catch((error) => {
    console.warn("fear-greed gauge render failed", error);
    return [] as FearGreedGaugeAttachment[];
  });

  const proxyChartAttachments = await buildTickerProxyChartAttachments(
    brief.sentiment?.tickers ?? [],
  ).catch((error) => {
    console.warn("ticker proxy chart render failed", error);
    return [] as TickerProxyChartAttachment[];
  });

  const inlineAttachments = [...gaugeAttachments, ...proxyChartAttachments];

  const dateLabel = formatHumanDate(brief.generatedAt, { withTime: false });
  // Use fetch (not the SDK) so we can read quota response headers — needed for
  // send-only API keys that cannot call GET /emails.
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: getEmailFrom(),
      to: [getEmailTo()],
      subject: `Daily Brief · ${dateLabel}`,
      html: renderBriefHtml(
        brief,
        usage,
        gaugeAttachments,
        proxyChartAttachments,
      ),
      text: renderBriefText(brief, usage),
      attachments: inlineAttachments.map((item) => ({
        filename: item.filename,
        content: item.content,
        content_id: item.contentId,
        content_type: item.contentType,
      })),
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
    name?: string;
  } | null;

  if (!response.ok) {
    throw new Error(
      `Resend error: ${payload?.message || response.statusText || response.status}`,
    );
  }

  await persistResendQuotaFromHeaders(response.headers);

  return payload?.id ? { id: payload.id } : null;
}
