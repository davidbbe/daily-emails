import type { SentimentBand, TickerGreedProxy } from "@/lib/sentiment";

const BAND_COLOR: Record<SentimentBand, string> = {
  "Extreme Fear": "#dc2626",
  Fear: "#ef4444",
  Neutral: "#64748b",
  Greed: "#65a30d",
  "Extreme Greed": "#059669",
};

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad),
  };
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startScore: number,
  endScore: number,
) {
  const startAngle = 180 - (startScore / 100) * 180;
  const endAngle = 180 - (endScore / 100) * 180;
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function clampPct(n: number) {
  return Math.max(0, Math.min(100, n));
}

function metricBarColor(pct: number) {
  if (pct <= 24) return "#dc2626";
  if (pct <= 44) return "#ef4444";
  if (pct <= 55) return "#94a3b8";
  if (pct <= 75) return "#65a30d";
  return "#059669";
}

function formatPrice(price: number) {
  return `$${price.toLocaleString("en-US", {
    maximumFractionDigits: price >= 1000 ? 0 : 2,
  })}`;
}

function formatDrawdown(pct: number) {
  const fixed = pct.toFixed(1);
  return `${pct > 0 ? "+" : ""}${fixed}% vs high`;
}

/**
 * Compact per-ticker greed-proxy chart: mini Fear→Greed dial + RSI/range bars.
 * Rasterized for email clients that ignore inline SVG.
 */
export function buildTickerProxyChartSvg(proxy: TickerGreedProxy): string {
  const width = 560;
  const height = 148;
  const score = clampPct(proxy.score ?? 0);
  const band = proxy.band ?? null;
  const bandColor = band ? BAND_COLOR[band] : "#64748b";

  // Dial sits left; score lives inside the arc (band badges stay in HTML).
  const cx = 78;
  const cy = 112;
  const r = 60;
  const needleAngle = 180 - (score / 100) * 180;
  const tip = polar(cx, cy, r - 14, needleAngle);
  const left = polar(cx, cy, 7, needleAngle + 90);
  const right = polar(cx, cy, 7, needleAngle - 90);

  const rangePct =
    proxy.rangePositionPct != null ? clampPct(proxy.rangePositionPct) : null;
  const rsiPct = proxy.rsi14 != null ? clampPct(proxy.rsi14) : null;

  const barX = 168;
  const barW = 292;
  const barH = 10;

  function metricRow(args: {
    y: number;
    label: string;
    valueLabel: string;
    pct: number | null;
    hint: string;
  }) {
    const trackY = args.y + 18;
    if (args.pct == null) {
      return `
        <text x="${barX}" y="${args.y}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="#64748b">${escapeXml(args.label)}</text>
        <text x="${barX + barW + 12}" y="${args.y}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="#94a3b8">—</text>
        <rect x="${barX}" y="${trackY}" width="${barW}" height="${barH}" rx="5" fill="#e2e8f0"/>
        <text x="${barX}" y="${trackY + 26}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#94a3b8">${escapeXml(args.hint)}</text>
      `;
    }

    const fillW = Math.max(6, (args.pct / 100) * barW);
    const fillColor = metricBarColor(args.pct);
    const thumbX = barX + fillW;

    return `
      <text x="${barX}" y="${args.y}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="#475569">${escapeXml(args.label)}</text>
      <text x="${barX + barW + 12}" y="${args.y}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" fill="#0f172a">${escapeXml(args.valueLabel)}</text>
      <rect x="${barX}" y="${trackY}" width="${barW}" height="${barH}" rx="5" fill="#e2e8f0"/>
      <rect x="${barX}" y="${trackY}" width="${fillW.toFixed(1)}" height="${barH}" rx="5" fill="${fillColor}"/>
      <circle cx="${thumbX.toFixed(1)}" cy="${trackY + barH / 2}" r="7" fill="#ffffff" stroke="${fillColor}" stroke-width="2.5"/>
      <text x="${barX}" y="${trackY + 26}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#94a3b8">${escapeXml(args.hint)}</text>
    `;
  }

  const footerBits = [
    proxy.price != null ? formatPrice(proxy.price) : "",
    proxy.drawdownFromHighPct != null
      ? formatDrawdown(proxy.drawdownFromHighPct)
      : "",
  ].filter(Boolean);
  const footer = footerBits.join("  ·  ");

  // Only paint the active band on the arc; the rest stays a neutral track.
  // Ranges match bandFromScore in sentiment.ts.
  const activeRange =
    band === "Extreme Fear"
      ? { start: 0, end: 24 }
      : band === "Fear"
        ? { start: 24, end: 44 }
        : band === "Neutral"
          ? { start: 44, end: 55 }
          : band === "Greed"
            ? { start: 55, end: 75 }
            : band === "Extreme Greed"
              ? { start: 75, end: 100 }
              : null;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#f8fafc"/>

  <!-- Mini dial: neutral track + active band only -->
  <path d="${arcPath(cx, cy, r, 0, 100)}" fill="none" stroke="#e2e8f0" stroke-width="12" stroke-linecap="butt"/>
  ${
    activeRange
      ? `<path d="${arcPath(cx, cy, r, activeRange.start, activeRange.end)}" fill="none" stroke="${bandColor}" stroke-width="12" stroke-linecap="butt"/>`
      : ""
  }
  <polygon points="${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${left.x.toFixed(2)},${left.y.toFixed(2)} ${right.x.toFixed(2)},${right.y.toFixed(2)}" fill="#111827"/>
  <circle cx="${cx}" cy="${cy}" r="8" fill="#111827"/>
  <circle cx="${cx}" cy="${cy}" r="3.5" fill="#ffffff"/>
  <text x="${cx}" y="78" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#0f172a">${Math.round(score)}</text>
  ${
    band
      ? `<text x="${cx}" y="96" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="${bandColor}">${escapeXml(band)}</text>`
      : ""
  }
  <text x="${cx - r + 2}" y="140" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="#94a3b8">Fear</text>
  <text x="${cx + r - 2}" y="140" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="#94a3b8">Greed</text>

  <!-- Metric bars -->
  ${metricRow({
    y: 28,
    label: "52-week range",
    valueLabel: rangePct != null ? `${Math.round(rangePct)}%` : "—",
    pct: rangePct,
    hint: "Low  →  High",
  })}
  ${metricRow({
    y: 78,
    label: "RSI (14)",
    valueLabel: rsiPct != null ? String(proxy.rsi14) : "—",
    pct: rsiPct,
    hint: "Oversold  →  Overbought",
  })}

  ${
    footer
      ? `<text x="${barX}" y="140" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="600" fill="#64748b">${escapeXml(footer)}</text>`
      : ""
  }
</svg>`;
}
