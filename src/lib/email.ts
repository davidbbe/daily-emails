import type {
  BulletFlag,
  DailyBrief,
  EarningsEvent,
  TrendMovers,
} from "@/lib/brief";
import { getEmailFrom, getEmailTo, PEOPLE, TICKERS } from "@/lib/config";
import { formatHumanDate } from "@/lib/dates";
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

function windowDays(hours: number) {
  return Math.max(1, Math.round(hours / 24));
}

function briefWindowLabel(brief: DailyBrief) {
  const catalystDays = windowDays(brief.catalystWindowHours);
  return `Past ${brief.windowHours} hours · Catalysts past ${catalystDays} days`;
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

function sourceLink(url?: string) {
  if (!url) return "";
  return ` <a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:none;font-size:12px;font-weight:600;">Source →</a>`;
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
    return `<a href="${escapeHtml(item.newsUrl)}" style="color:#64748b;text-decoration:none;">${text}</a>`;
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
                <div style="font-size:15px;line-height:1.4;font-weight:650;color:#0f172a;">
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

/** Compact list for side-by-side Thailand / Bulgaria — includes traffic + news links */
function renderCompactTrendRows(items: BriefTrendItem[]) {
  if (items.length === 0) {
    return `<tr><td style="padding:6px 0;font-size:12px;color:#94a3b8;font-style:italic;">No trends.</td></tr>`;
  }

  return items
    .map((item) => {
      const title = escapeHtml(item.titleEn.trim() || item.title.trim());
      const description = (item.descriptionEn || item.newsTitleEn || "").trim();
      const news = trendNewsLine(item);
      return `<tr>
        <td style="padding:7px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:20px;vertical-align:top;font-size:11px;font-weight:700;color:#94a3b8;padding-top:1px;">#${item.rank}</td>
              <td style="vertical-align:top;">
                <div style="font-size:13px;line-height:1.35;font-weight:650;color:#0f172a;">
                  ${title}
                  ${trafficBadge(item.approxTraffic)}
                </div>
                ${
                  description && !news
                    ? `<div style="margin-top:2px;font-size:11px;line-height:1.4;color:#64748b;">${escapeHtml(description)}</div>`
                    : ""
                }
                ${news ? `<div style="margin-top:2px;font-size:11px;line-height:1.4;color:#64748b;">${news}</div>` : ""}
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

function renderCompactTrendColumn(region: {
  id: string;
  label: string;
  items: BriefTrendItem[];
}) {
  const accent = TREND_ACCENTS[region.id] ?? "#475569";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${accent};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-size:13px;font-weight:700;color:#0f172a;vertical-align:middle;">${escapeHtml(region.label)}</span>
          <span style="margin-left:6px;font-size:11px;color:#94a3b8;vertical-align:middle;">Top ${region.items.length || 5}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:2px 10px 6px 10px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renderCompactTrendRows(region.items)}</table>
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

function renderEarningsCalendar(
  events: EarningsEvent[],
  catalystWindowHours: number,
) {
  const catalystDays = windowDays(catalystWindowHours);
  if (events.length === 0) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <div style="font-size:14px;line-height:1.5;color:#94a3b8;font-style:italic;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
          No dated earnings or catalysts found for tracked stocks in the next ${catalystDays} days.
        </div>
      </td>
    </tr>`;
  }

  const rows = events
    .map((event) => {
      const link = event.sourceUrl
        ? ` <a href="${escapeHtml(event.sourceUrl)}" style="color:#2563eb;text-decoration:none;font-size:12px;font-weight:600;">Source →</a>`
        : "";
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;width:72px;">
          <span style="display:inline-block;font-size:11px;font-weight:700;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:2px 8px;">${escapeHtml(event.tickerId)}</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-size:14px;font-weight:650;color:#0f172a;">${escapeHtml(event.when)}</div>
          <div style="margin-top:2px;font-size:13px;line-height:1.45;color:#475569;">${escapeHtml(event.event)}${link}</div>
        </td>
      </tr>`;
    })
    .join("");

  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:15px;font-weight:700;color:#0f172a;">Earnings &amp; catalysts</span>
            <span style="margin-left:8px;font-size:12px;color:#94a3b8;">Next ${catalystDays} days (from headlines)</span>
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

function renderTrendMovers(movers: TrendMovers, hasPrevious: boolean) {
  if (!hasPrevious) {
    return `<tr>
      <td style="padding:0 0 14px 0;">
        <div style="font-size:14px;line-height:1.5;color:#94a3b8;font-style:italic;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
          Day-over-day trend movers appear after the second brief (store a prior snapshot with Vercel Blob or local .data/).
        </div>
      </td>
    </tr>`;
  }

  const groups: Array<{ label: string; items: string[]; color: string }> = [
    { label: "New today", items: movers.newToday, color: "#047857" },
    { label: "Still rising", items: movers.stillRising, color: "#1d4ed8" },
    { label: "Fell off", items: movers.fellOff, color: "#b45309" },
  ];

  const body = groups
    .map((group) => {
      const items =
        group.items.length > 0
          ? escapeHtml(group.items.join(" · "))
          : `<span style="color:#94a3b8;font-style:italic;">None</span>`;
      return `<div style="margin:0 0 10px 0;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${group.color};margin:0 0 4px 0;">${group.label}</div>
        <div style="font-size:14px;line-height:1.5;color:#334155;">${items}</div>
      </div>`;
    })
    .join("");

  return `<tr>
    <td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:15px;font-weight:700;color:#0f172a;">Trend movers</span>
            <span style="margin-left:8px;font-size:12px;color:#94a3b8;">vs yesterday</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px 4px 16px;">${body}</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function percentColor(percent: number, available: boolean) {
  if (!available) return "#94a3b8";
  if (percent >= 90) return "#b42318";
  if (percent >= 70) return "#b45309";
  if (percent >= 50) return "#a16207";
  return "#047857";
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
          <div style="font-size:14px;font-weight:650;color:#0f172a;">${escapeHtml(m.label)}</div>
          <div style="margin-top:2px;font-size:13px;color:#475569;">${escapeHtml(m.detail)}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;text-align:right;white-space:nowrap;">
          <span style="font-size:16px;font-weight:750;color:${color};">${m.percent}%</span>
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
      <div style="font-size:14px;font-weight:650;color:#0f172a;">${escapeHtml(m.label)}</div>
      <div style="margin-top:2px;font-size:12px;line-height:1.45;color:#64748b;">${escapeHtml(m.detail)}</div>
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;text-align:right;white-space:nowrap;">
      <div style="font-size:13px;font-weight:600;color:#334155;">${escapeHtml(usedLimit)}</div>
      <div style="margin-top:2px;font-size:15px;font-weight:750;color:${color};">${pct}</div>
    </td>
  </tr>`;
}

function renderUsageReport(usage: UsageReport) {
  const rows = usage.metrics.map(renderUsageRow).join("");
  return `
    ${renderUsageWatch(usage)}
    <tr>
      <td style="padding:0 0 14px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
              <span style="font-size:15px;font-weight:700;color:#0f172a;">Vercel &amp; delivery usage</span>
              <span style="margin-left:8px;font-size:12px;color:#94a3b8;">Gateway · FOT · Blob · Resend</span>
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

export function renderBriefHtml(brief: DailyBrief, usage?: UsageReport) {
  const date = formatHumanDate(brief.generatedAt);
  const dateShort = formatHumanDate(brief.generatedAt, { withTime: false });

  const tickerSections = TICKERS.map((ticker) => {
    const section = brief.tickers.find((t) => t.id === ticker.id);
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
                    ${flagBadge(b.flag)}${escapeHtml(b.text)}${sourceLink(b.sourceUrl)}
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
                <span style="display:inline-block;margin-left:8px;font-size:16px;font-weight:650;color:#0f172a;">${escapeHtml(ticker.label)}</span>
              </td>
            </tr>
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
                <div style="margin-top:8px;font-size:12px;line-height:1.45;color:#64748b;">
                  <span style="font-weight:700;color:#475569;">vs yesterday:</span> ${escapeHtml(section?.watchlistDelta || "n/a")}
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
              <td width="50%" style="width:50%;padding:0 6px 0 0;vertical-align:top;">
                ${thailandRegion ? renderCompactTrendColumn(thailandRegion) : ""}
              </td>
              <td width="50%" style="width:50%;padding:0 0 0 6px;vertical-align:top;">
                ${bulgariaRegion ? renderCompactTrendColumn(bulgariaRegion) : ""}
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

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Daily Brief ${escapeHtml(dateShort)}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef2ff;font-family:${FONT};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg,#dbeafe 0%,#eef2ff 180px,#f8fafc 180px);padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;margin:0 auto;">
            <tr>
              <td style="padding:0 0 18px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0f766e 0%,#1d4ed8 55%,#7c3aed 100%);border-radius:18px;overflow:hidden;">
                  <tr>
                    <td style="padding:28px 28px 24px 28px;">
                      <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ccfbf1;margin:0 0 8px 0;">Agent Dave</div>
                      <div style="font-size:28px;line-height:1.2;font-weight:750;color:#ffffff;margin:0 0 10px 0;">Daily Market &amp; Tech Brief</div>
                      <div style="font-size:13px;line-height:1.5;color:#e0e7ff;">
                        ${briefWindowLabel(brief)} · ${escapeHtml(date)}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            ${calloutBox("Theme of the day", brief.themeOfTheDay, "#7c3aed")}
            ${sectionLabel("Overnight", { first: true })}
            ${renderOvernightOpeners(brief)}

            ${sectionLabel("Markets")}
            ${tickerSections}

            ${sectionLabel("Earnings &amp; catalysts")}
            ${renderEarningsCalendar(brief.earningsCalendar, brief.catalystWindowHours)}

            ${sectionLabel("Speeches &amp; announcements")}
            ${peopleSections}

            ${sectionDivider()}
            ${calloutBox("Regional pulse", brief.regionalPulse, "#c2410c", "22px")}

            ${sectionLabel("Web trends")}
            ${trendSections}
            ${crossRegion}

            ${sectionLabel("Trend movers")}
            ${renderTrendMovers(brief.trendMovers, brief.hasPreviousBrief)}

            ${usage ? `${sectionLabel("Usage")}${renderUsageReport(usage)}` : ""}

            <tr>
              <td style="padding:18px 8px 8px 8px;text-align:center;">
                <div style="font-size:12px;line-height:1.5;color:#94a3b8;">
                  Generated by Agent Dave · ${escapeHtml(brief.model)}
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
    "",
    "OVERNIGHT OPENERS",
  ];

  for (const ticker of TICKERS) {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    lines.push(`${ticker.id}: ${section?.overnightOpener || "Quiet overnight."}`);
  }

  lines.push("", "MARKETS");
  for (const ticker of TICKERS) {
    const section = brief.tickers.find((t) => t.id === ticker.id);
    lines.push("", ticker.label);
    if (section?.bullets?.length) {
      for (const bullet of section.bullets) {
        const link = bullet.sourceUrl ? ` (${bullet.sourceUrl})` : "";
        lines.push(`- [${bullet.flag}] ${bullet.text}${link}`);
      }
    } else {
      lines.push("- No material headlines in the last 24 hours.");
    }
    lines.push(`Why it matters: ${section?.whyItMatters || "n/a"}`);
    lines.push(`vs yesterday: ${section?.watchlistDelta || "n/a"}`);
  }

  lines.push("", "EARNINGS & CATALYSTS");
  if (brief.earningsCalendar.length === 0) {
    lines.push(
      `No dated earnings or catalysts found for tracked stocks in the next ${windowDays(brief.catalystWindowHours)} days.`,
    );
  } else {
    for (const event of brief.earningsCalendar) {
      const link = event.sourceUrl ? ` (${event.sourceUrl})` : "";
      lines.push(`- ${event.tickerId} · ${event.when}: ${event.event}${link}`);
    }
  }

  lines.push("", "SPEECHES & ANNOUNCEMENTS");
  for (const person of PEOPLE) {
    const section = brief.people.find((p) => p.id === person.id);
    lines.push("", person.name, section?.summary?.trim() || "None found");
    if (section?.quote) lines.push(`  “${section.quote}”`);
    if (section?.sourceUrl) lines.push(`  ${section.sourceUrl}`);
  }

  lines.push("", "REGIONAL PULSE", brief.regionalPulse);

  lines.push("", "WEB TRENDS");
  for (const region of brief.trends?.regions ?? []) {
    lines.push("", region.label);
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

  lines.push("", "TREND MOVERS");
  if (!brief.hasPreviousBrief) {
    lines.push("No prior brief stored yet for day-over-day movers.");
  } else {
    lines.push(`New today: ${brief.trendMovers.newToday.join(" · ") || "None"}`);
    lines.push(
      `Still rising: ${brief.trendMovers.stillRising.join(" · ") || "None"}`,
    );
    lines.push(`Fell off: ${brief.trendMovers.fellOff.join(" · ") || "None"}`);
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

    lines.push("", "VERCEL & DELIVERY USAGE");
    for (const m of usage.metrics) {
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

  return lines.join("\n");
}

export async function sendBriefEmail(brief: DailyBrief, usage?: UsageReport) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required");
  }

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
      html: renderBriefHtml(brief, usage),
      text: renderBriefText(brief, usage),
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
