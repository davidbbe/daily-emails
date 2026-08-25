/**
 * 3-month VIX line chart (SVG) for the hosted markets page.
 * Plots daily closes; dots every other session so the series stays readable.
 */

export type VixLineChartArgs = {
  /** Daily closes, oldest → newest */
  history: number[];
  /** ISO timestamp for the latest point (used to backfill x-axis dates) */
  asOf?: string;
};

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Walk back N trading days from `end` (skips Sat/Sun). */
function tradingDaysEndingAt(end: Date, count: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );
  while (days.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      days.push(new Date(cursor));
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  days.reverse();
  return days;
}

function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return niceTicks(min - pad, max + pad, target);
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step =
    residual <= 1.5 ? magnitude : residual <= 3 ? 2 * magnitude : residual <= 7 ? 5 * magnitude : 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

function formatAxisDate(date: Date) {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Compact VIX history chart: daily polyline, dots every 2 sessions,
 * current level callout, and month-ish x labels.
 */
export function buildVixLineChartSvg(args: VixLineChartArgs): string {
  const history = args.history.filter(
    (n) => typeof n === "number" && Number.isFinite(n),
  );
  const width = 440;
  const height = 220;
  const padL = 40;
  const padR = 16;
  const padT = 28;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  if (history.length < 2) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="VIX history unavailable">
  <rect width="${width}" height="${height}" fill="#0d1311"/>
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#64736d" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">No VIX history</text>
</svg>`;
  }

  const end =
    args.asOf && !Number.isNaN(Date.parse(args.asOf))
      ? new Date(args.asOf)
      : new Date();
  const dates = tradingDaysEndingAt(end, history.length);

  const dataMin = Math.min(...history);
  const dataMax = Math.max(...history);
  const pad = Math.max(0.5, (dataMax - dataMin) * 0.12);
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;
  const yTicks = niceTicks(yMin, yMax, 4);
  const axisMin = yTicks[0] ?? yMin;
  const axisMax = yTicks[yTicks.length - 1] ?? yMax;
  const ySpan = Math.max(0.01, axisMax - axisMin);

  const xAt = (i: number) =>
    padL + (history.length === 1 ? plotW / 2 : (i / (history.length - 1)) * plotW);
  const yAt = (v: number) => padT + (1 - (v - axisMin) / ySpan) * plotH;

  const points = history.map((v, i) => ({
    x: xAt(i),
    y: yAt(v),
    v,
    date: dates[i]!,
  }));

  const lineD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");

  // Area fill under the line
  const areaD = [
    `M ${points[0]!.x.toFixed(2)} ${yAt(axisMin).toFixed(2)}`,
    ...points.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`),
    `L ${points[points.length - 1]!.x.toFixed(2)} ${yAt(axisMin).toFixed(2)}`,
    "Z",
  ].join(" ");

  const grid = yTicks
    .map((tick) => {
      const y = yAt(tick);
      return `
  <line x1="${padL}" y1="${y.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#25302c" stroke-width="1"/>
  <text x="${padL - 8}" y="${y.toFixed(2)}" text-anchor="end" dominant-baseline="central" fill="#64736d" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600">${tick}</text>`;
    })
    .join("");

  // Dots every other trading day (+ always the latest)
  const dots = points
    .filter((_, i) => i % 2 === 0 || i === points.length - 1)
    .map((p, idx, arr) => {
      const isLast = idx === arr.length - 1 && p === points[points.length - 1];
      const r = isLast ? 4.5 : 2.75;
      const fill = isLast ? "#a3e635" : "#477b69";
      return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r}" fill="${fill}"${isLast ? ' stroke="#0d1311" stroke-width="2"' : ""}/>`;
    })
    .join("");

  const latest = points[points.length - 1]!;
  const labelX = Math.min(latest.x + 8, padL + plotW - 4);
  const labelAnchor = latest.x > padL + plotW * 0.72 ? "end" : "start";
  const labelDrawX =
    labelAnchor === "end" ? latest.x - 8 : labelX;

  const xLabelIndexes = [
    0,
    Math.floor((points.length - 1) / 2),
    points.length - 1,
  ];
  const xLabels = xLabelIndexes
    .map((i) => {
      const p = points[i]!;
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      return `<text x="${p.x.toFixed(2)}" y="${(height - 12).toFixed(2)}" text-anchor="${anchor}" fill="#64736d" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600">${escapeXml(formatAxisDate(p.date))}</text>`;
    })
    .join("");

  const aria = `VIX ${latest.v.toFixed(2)}, last ${history.length} sessions`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(aria)}">
  <rect width="${width}" height="${height}" fill="#0d1311"/>
  ${grid}
  <path d="${areaD}" fill="#a3e635" fill-opacity="0.09"/>
  <path d="${lineD}" fill="none" stroke="#5eead4" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  <text x="${labelDrawX.toFixed(2)}" y="${(latest.y - 12).toFixed(2)}" text-anchor="${labelAnchor}" fill="#f4f7f5" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700">${latest.v.toFixed(2)}</text>
  ${xLabels}
</svg>`;
}
