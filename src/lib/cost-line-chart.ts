import sharp from "sharp";

export const COST_CHART_WIDTH = 680;
export const COST_CHART_HEIGHT = 260;
export type CostChartPoint = { at: number; cost: number; startsSegment: boolean; partial?: boolean };
export type InlineChartAttachment = { filename: string; content: string; content_type: string; content_id: string };
export type DailyCallBar = { start: number; end: number; calls: number };

export function buildCostLineChartSvg(points: CostChartPoint[], from: number, to: number, axisLabel = "Cost (USD)", options: { dailyCalls?: DailyCallBar[]; dailyLimit?: number; tickCount?: number; dailyCallLabel?: "Calls per day" | "Billed events per day"; dayCenteredBars?: boolean } = {}) {
  const hasCalls = options.dailyCalls !== undefined;
  const width = COST_CHART_WIDTH, height = hasCalls ? 420 : COST_CHART_HEIGHT;
  const left = 80, right = width - 20, top = 34, bottom = hasCalls ? 180 : height - 60;
  const min = Math.min(0, ...points.map(p => p.cost));
  const max = Math.max(0, ...points.map(p => p.cost));
  const rawStep = Math.max(max - min, 1) * 1.15 / 4;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= rawStep)!;
  const floor = Math.floor(min / step) * step;
  const ceiling = Math.max(floor + step, Math.ceil(max / step) * step);
  const plotFrom = from === to || options.dayCenteredBars ? from - 43200000 : from;
  const plotTo = from === to || options.dayCenteredBars ? to + 43200000 : to;
  const x = (at: number) => left + (at - plotFrom) / (plotTo - plotFrom) * (right - left);
  const y = (cost: number) => bottom - (cost - floor) / (ceiling - floor) * (bottom - top);
  const money = (n: number) => `${n < 0 ? "−" : ""}$${Number(Math.abs(n).toFixed(2))}`;
  const grid = Array.from({ length: Math.round((ceiling - floor) / step) + 1 }, (_, i) => {
    const value = floor + i * step, at = y(value);
    return `<line x1="${left}" x2="${right}" y1="${at}" y2="${at}" stroke="${Math.abs(value) < 1e-9 ? "#cbd5e1" : "#e2e8f0"}"/><text x="${left - 12}" y="${at + 6}" text-anchor="end" fill="#64748b" font-size="17">${money(value)}</text>`;
  }).join("");
  const tickCount = options.tickCount ?? 4;
  const tickDates = [...new Set(Array.from({ length: tickCount }, (_, i) => from + Math.round((to - from) / 86400000 * i / (tickCount - 1)) * 86400000))];
  const dateAxisBottom = hasCalls ? 350 : bottom;
  const ticks = tickDates.map((at, i) => {
    const label = new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace("Sept", "Sep");
    const anchor = tickDates.length === 1 || options.dayCenteredBars ? "middle" : i === 0 ? "start" : i === tickDates.length - 1 ? "end" : "middle";
    return `<text x="${x(at)}" y="${dateAxisBottom + 29}" text-anchor="${anchor}" fill="#64748b" font-size="${tickCount > 4 ? 15 : 17}">${label}</text>`;
  }).join("");
  const path = points.map(p => `${p.startsSegment ? "M" : "L"} ${x(p.at).toFixed(2)} ${y(p.cost).toFixed(2)}`).join(" ");
  const dots = points.map(p => `<circle cx="${x(p.at)}" cy="${y(p.cost)}" r="4" fill="${p.partial ? "#d97706" : "#0f766e"}"/>`).join("");
  let callsChart = "";
  if (hasCalls) {
    const bars = options.dailyCalls!;
    const callTop = 240, callBottom = dateAxisBottom;
    const maxCalls = Math.max(options.dailyLimit ?? 0, ...bars.map(b => b.calls), 1);
    const raw = maxCalls / 2, magnitude = 10 ** Math.floor(Math.log10(raw));
    const callStep = Math.max(1, [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= raw)!);
    const callCeiling = callStep * 2;
    const callY = (calls: number) => callBottom - calls / callCeiling * (callBottom - callTop);
    const callGrid = [0, callStep, callCeiling].map(n => `<line x1="${left}" x2="${right}" y1="${callY(n)}" y2="${callY(n)}" stroke="#e2e8f0"/><text x="${left - 12}" y="${callY(n) + 6}" text-anchor="end" fill="#64748b" font-size="17">${n.toLocaleString("en-US")}</text>`).join("");
    const rectangles = bars.map(b => {
      const barLeft = Math.max(left, x(b.start)) + 2;
      const barRight = Math.min(right, x(b.end)) - 2;
      return `<rect class="daily-calls" data-calls="${b.calls}" x="${barLeft}" y="${callY(b.calls)}" width="${Math.max(1, barRight - barLeft)}" height="${Math.max(0, callBottom - callY(b.calls))}" fill="#93c5fd" rx="2"/>`;
    }).join("");
    const quota = options.dailyLimit == null ? "" : `<line x1="${left}" x2="${right}" y1="${callY(options.dailyLimit)}" y2="${callY(options.dailyLimit)}" stroke="#d97706" stroke-width="2" stroke-dasharray="6 4"/>`;
    callsChart = `<text x="${left}" y="222" fill="#64748b" font-size="17">${options.dailyCallLabel ?? "Calls per day"}</text>${bars.length ? `${callGrid}${rectangles}${quota}` : `<text x="${(left + right) / 2}" y="${(callTop + callBottom) / 2}" text-anchor="middle" fill="#64748b" font-size="17">Daily counts unavailable</text>`}<line x1="${left}" x2="${left}" y1="${callTop}" y2="${callBottom}" stroke="#cbd5e1"/><line x1="${left}" x2="${right}" y1="${callBottom}" y2="${callBottom}" stroke="#cbd5e1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <g font-family="Arial,Helvetica,sans-serif"><text x="${left}" y="20" fill="#64748b" font-size="17">${axisLabel}</text>${grid}
    <line x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke="#cbd5e1"/>
    <line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="#cbd5e1"/>
    ${path ? `<path d="${path}" fill="none" stroke="#0f766e" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${dots}` : `<text x="${(left + right) / 2}" y="${(top + bottom) / 2}" text-anchor="middle" fill="#64748b" font-size="18">No recorded cost data</text>`}
    ${callsChart}${ticks}<text x="${(left + right) / 2}" y="${height - 7}" text-anchor="middle" fill="#64748b" font-size="17">Day (UTC)</text></g></svg>`;
}

export async function costChartAttachment(svg: string, id: string): Promise<InlineChartAttachment> {
  const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  return { filename: `${id}.png`, content: png.toString("base64"), content_type: "image/png", content_id: id };
}
