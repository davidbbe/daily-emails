import sharp from "sharp";
import type { FearGreedMeter, SentimentBand } from "@/lib/sentiment";

export type FearGreedGaugeAttachment = {
  meterId: FearGreedMeter["id"];
  filename: string;
  contentId: string;
  contentType: "image/png";
  /** Base64-encoded PNG */
  content: string;
};

const BAND_LABEL_COLOR: Record<SentimentBand, string> = {
  "Extreme Fear": "#e11d48",
  Fear: "#ea580c",
  Neutral: "#64748b",
  Greed: "#65a30d",
  "Extreme Greed": "#059669",
};

/** Map a meter onto the classic 0–100 Fear→Greed arc (VIX is inverted). */
export function gaugeScoreFromMeter(meter: FearGreedMeter): number | null {
  if (meter.value == null || !Number.isFinite(meter.value)) return null;
  if (meter.id !== "vix") {
    return Math.max(0, Math.min(100, meter.value));
  }
  const vix = meter.value;
  if (vix <= 12) return 90;
  if (vix >= 40) return 5;
  return Math.round(90 - ((vix - 12) / 28) * 85);
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

/**
 * CNN-style semicircle fear/greed meter as SVG (rasterized for email clients).
 */
export function buildFearGreedGaugeSvg(args: {
  score: number;
  valueLabel: string;
  band: SentimentBand | null;
}): string {
  const width = 440;
  const height = 270;
  const cx = 220;
  const cy = 205;
  const r = 150;
  const clamped = Math.max(0, Math.min(100, args.score));
  const needleAngle = 180 - (clamped / 100) * 180;
  const tip = polar(cx, cy, r - 22, needleAngle);
  const bandColor = args.band
    ? BAND_LABEL_COLOR[args.band]
    : "#64748b";

  // Smooth multi-stop gradient like CNN's meter
  const gradientArc = `<path d="${arcPath(cx, cy, r, 0, 100)}" fill="none" stroke="url(#fgGradient)" stroke-width="30" stroke-linecap="butt" />`;
  const track = `<path d="${arcPath(cx, cy, r, 0, 100)}" fill="none" stroke="#eef2f7" stroke-width="36" stroke-linecap="butt" />`;

  // Needle as a tapered triangle pointing at the score
  const left = polar(cx, cy, 10, needleAngle + 90);
  const right = polar(cx, cy, 10, needleAngle - 90);
  const needle = `<polygon points="${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${left.x.toFixed(2)},${left.y.toFixed(2)} ${right.x.toFixed(2)},${right.y.toFixed(2)}" fill="#111827"/>`;

  const bandLabel = args.band ?? "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fgGradient" x1="40" y1="205" x2="400" y2="205" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#dc2626"/>
      <stop offset="25%" stop-color="#ea580c"/>
      <stop offset="45%" stop-color="#ca8a04"/>
      <stop offset="55%" stop-color="#a3a3a3"/>
      <stop offset="70%" stop-color="#65a30d"/>
      <stop offset="100%" stop-color="#15803d"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${track}
  ${gradientArc}
  ${needle}
  <circle cx="${cx}" cy="${cy}" r="14" fill="#111827"/>
  <circle cx="${cx}" cy="${cy}" r="6" fill="#ffffff"/>
  <text x="${cx}" y="118" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700" fill="#111827">${escapeXml(args.valueLabel)}</text>
  ${
    bandLabel
      ? `<text x="${cx}" y="154" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="${bandColor}">${escapeXml(bandLabel)}</text>`
      : ""
  }
  <text x="36" y="255" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" fill="#94a3b8">Fear</text>
  <text x="404" y="255" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" fill="#94a3b8">Greed</text>
</svg>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function renderFearGreedGaugePng(args: {
  score: number;
  valueLabel: string;
  band: SentimentBand | null;
}): Promise<Buffer> {
  const svg = buildFearGreedGaugeSvg(args);
  return sharp(Buffer.from(svg))
    .png()
    .resize(440, 280, { fit: "contain", background: "#ffffff" })
    .toBuffer();
}

export async function buildFearGreedGaugeAttachments(
  meters: FearGreedMeter[],
): Promise<FearGreedGaugeAttachment[]> {
  const attachments: FearGreedGaugeAttachment[] = [];

  for (const meter of meters) {
    const score = gaugeScoreFromMeter(meter);
    if (score == null) continue;

    const valueLabel =
      meter.id === "vix" && meter.value != null
        ? meter.value.toFixed(2)
        : String(Math.round(meter.value ?? score));

    const png = await renderFearGreedGaugePng({
      score,
      valueLabel,
      band: meter.band,
    });

    attachments.push({
      meterId: meter.id,
      filename: `fg-${meter.id}.png`,
      contentId: `fg-${meter.id}`,
      contentType: "image/png",
      content: png.toString("base64"),
    });
  }

  return attachments;
}
