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

const SEGMENTS: ReadonlyArray<{
  band: SentimentBand;
  label: string;
  start: number;
  end: number;
}> = [
  { band: "Extreme Fear", label: "EXTREME FEAR", start: 0, end: 20 },
  { band: "Fear", label: "FEAR", start: 20, end: 40 },
  { band: "Neutral", label: "NEUTRAL", start: 40, end: 60 },
  { band: "Greed", label: "GREED", start: 60, end: 80 },
  { band: "Extreme Greed", label: "EXTREME GREED", start: 80, end: 100 },
];

/** Per-band fills: red fear → grey neutral → green greed. */
const BAND_STYLE: Record<
  SentimentBand,
  { idleFill: string; activeFill: string; activeStroke: string; activeText: string }
> = {
  "Extreme Fear": {
    idleFill: "#FECACA",
    activeFill: "#FCA5A5",
    activeStroke: "#DC2626",
    activeText: "#991B1B",
  },
  Fear: {
    idleFill: "#FEE2E2",
    activeFill: "#FECACA",
    activeStroke: "#EF4444",
    activeText: "#B91C1C",
  },
  Neutral: {
    idleFill: "#F3F4F6",
    activeFill: "#E5E7EB",
    activeStroke: "#9CA3AF",
    activeText: "#374151",
  },
  Greed: {
    idleFill: "#D1FAE5",
    activeFill: "#A7F3D0",
    activeStroke: "#34D399",
    activeText: "#065F46",
  },
  "Extreme Greed": {
    idleFill: "#A7F3D0",
    activeFill: "#6EE7B7",
    activeStroke: "#059669",
    activeText: "#064E3B",
  },
};

const IDLE_TEXT = "#9CA3AF";
/** Neutral track for inactive segments when only the active band is colored. */
const IDLE_FILL_NEUTRAL = "#F3F4F6";
const SCALE_COLOR = "#A8B0BC";
const NEEDLE_COLOR = "#1F2937";
/** Angular gap between segments (score units). */
const SEGMENT_GAP = 0.9;

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

/** Band for the equal 20-point dial segments (needle / highlight / hub stay in sync). */
export function bandFromGaugeScore(score: number): SentimentBand {
  const s = Math.max(0, Math.min(100, score));
  if (s <= 20) return "Extreme Fear";
  if (s <= 40) return "Fear";
  if (s <= 60) return "Neutral";
  if (s <= 80) return "Greed";
  return "Extreme Greed";
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad),
  };
}

function scoreToAngle(score: number) {
  return 180 - (score / 100) * 180;
}

function annularSegmentPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startScore: number,
  endScore: number,
) {
  const startAngle = scoreToAngle(startScore);
  const endAngle = scoreToAngle(endScore);
  const p1 = polar(cx, cy, rOuter, startAngle);
  const p2 = polar(cx, cy, rOuter, endAngle);
  const p3 = polar(cx, cy, rInner, endAngle);
  const p4 = polar(cx, cy, rInner, startAngle);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 0 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * CNN-style Fear → Greed semicircle: five labeled segments (red → grey → green),
 * dotted inner scale, hub score + needle.
 *
 * Hub number, needle, and highlighted segment all derive from `score` only so they
 * cannot drift apart (e.g. VIX raw level vs inverted arc, or a stale API rating).
 */
export function buildFearGreedGaugeSvg(args: {
  score: number;
  /** @deprecated Ignored — hub always shows the rounded gauge score. */
  valueLabel?: string;
  /** @deprecated Ignored — highlight follows the needle score. */
  band?: SentimentBand | null;
  /**
   * When true, inactive segments use a neutral grey instead of tinted band
   * colors — only the active band keeps its color.
   */
  activeColorOnly?: boolean;
}): string {
  const width = 440;
  const height = 248;
  const cx = 220;
  const cy = 200;
  const rOuter = 168;
  const rInner = 118;
  const rLabel = (rOuter + rInner) / 2;
  const rScale = rInner - 14;
  const rScaleLabel = rScale - 16;
  const clamped = Math.max(0, Math.min(100, args.score));
  const hubValue = String(Math.round(clamped));
  const activeBand = bandFromGaugeScore(clamped);
  const needleAngle = scoreToAngle(clamped);
  const tip = polar(cx, cy, rInner - 6, needleAngle);
  const left = polar(cx, cy, 9, needleAngle + 90);
  const right = polar(cx, cy, 9, needleAngle - 90);
  const activeColorOnly = args.activeColorOnly === true;

  const segmentPaths = SEGMENTS.map((seg, i) => {
    const start = seg.start + (i === 0 ? 0 : SEGMENT_GAP / 2);
    const end = seg.end - (i === SEGMENTS.length - 1 ? 0 : SEGMENT_GAP / 2);
    const active = seg.band === activeBand;
    const colors = BAND_STYLE[seg.band];
    const mid = (start + end) / 2;
    const midAngle = scoreToAngle(mid);
    const labelPos = polar(cx, cy, rLabel, midAngle);
    // Tangent to the arc (left → right): SVG rotate is clockwise from +x.
    const rotate = 90 - midAngle;
    const fontSize = seg.label.length > 8 ? 9.5 : 11;
    const idleFill = activeColorOnly ? IDLE_FILL_NEUTRAL : colors.idleFill;
    const fill = active ? colors.activeFill : idleFill;
    const textFill = active ? colors.activeText : IDLE_TEXT;
    return `
  <path d="${annularSegmentPath(cx, cy, rOuter, rInner, start, end)}" fill="${fill}"${active ? ` stroke="${colors.activeStroke}" stroke-width="1.5"` : ""}/>
  <text transform="translate(${labelPos.x.toFixed(2)} ${labelPos.y.toFixed(2)}) rotate(${rotate.toFixed(2)})" text-anchor="middle" dominant-baseline="central" fill="${textFill}" style="font-family:Arial,Helvetica,sans-serif;font-size:${fontSize}px;font-weight:${active ? 700 : 600};letter-spacing:0.06em">${escapeXml(seg.label)}</text>`;
  }).join("");

  const scaleDots: string[] = [];
  for (let s = 0; s <= 100; s += 2.5) {
    const p = polar(cx, cy, rScale, scoreToAngle(s));
    scaleDots.push(
      `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.15" fill="${SCALE_COLOR}"/>`,
    );
  }

  const scaleLabels = [0, 25, 50, 75, 100]
    .map((n) => {
      const p = polar(cx, cy, rScaleLabel, scoreToAngle(n));
      return `<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" text-anchor="middle" dominant-baseline="central" fill="#8B95A5" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:600">${n}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Fear and greed score ${hubValue}, ${escapeXml(activeBand)}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${segmentPaths}
  ${scaleDots.join("")}
  ${scaleLabels}
  <polygon points="${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${left.x.toFixed(2)},${left.y.toFixed(2)} ${right.x.toFixed(2)},${right.y.toFixed(2)}" fill="${NEEDLE_COLOR}"/>
  <circle cx="${cx}" cy="${cy}" r="38" fill="#ffffff"/>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="#111827" style="font-family:Arial,Helvetica,sans-serif;font-size:36px;font-weight:700">${hubValue}</text>
</svg>`;
}

export async function renderFearGreedGaugePng(args: {
  score: number;
  valueLabel?: string;
  band?: SentimentBand | null;
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
    // VIX uses a history line chart on the markets page, not this F&G dial.
    if (meter.id === "vix") continue;
    const score = gaugeScoreFromMeter(meter);
    if (score == null) continue;

    const png = await renderFearGreedGaugePng({ score });

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
