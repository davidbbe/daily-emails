import type { SentimentBand } from "@/lib/sentiment";

type FearGreedDialProps = {
  score: number;
  band?: SentimentBand | null;
  label?: string;
  className?: string;
  /** Unique suffix so multiple dials on one page don't clash gradient ids. */
  gradientId?: string;
};

const BAND_COLOR: Record<SentimentBand, string> = {
  "Extreme Fear": "#e11d48",
  Fear: "#ea580c",
  Neutral: "#64748b",
  Greed: "#65a30d",
  "Extreme Greed": "#059669",
};

function clampScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
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
 * CNN-style Fear → Greed semicircle (static SVG graphic).
 * @see https://edition.cnn.com/markets/fear-and-greed
 */
export function FearGreedDial({
  score,
  band = null,
  label,
  className,
  gradientId = "fg-grad",
}: FearGreedDialProps) {
  const clamped = clampScore(score);
  const width = 440;
  const height = 270;
  const cx = 220;
  const cy = 205;
  const r = 150;
  const needleAngle = 180 - (clamped / 100) * 180;
  const tip = polar(cx, cy, r - 22, needleAngle);
  const left = polar(cx, cy, 10, needleAngle + 90);
  const right = polar(cx, cy, 10, needleAngle - 90);
  const bandColor = band ? BAND_COLOR[band] : "#64748b";

  return (
    <div className={className}>
      {label ? (
        <div className="mb-1 text-center text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">
          {label}
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto h-auto w-full max-w-[320px]"
        role="img"
        aria-label={`Fear and greed score ${clamped}${band ? `, ${band}` : ""}`}
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="40"
            y1="205"
            x2="400"
            y2="205"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="25%" stopColor="#ea580c" />
            <stop offset="45%" stopColor="#ca8a04" />
            <stop offset="55%" stopColor="#a3a3a3" />
            <stop offset="70%" stopColor="#65a30d" />
            <stop offset="100%" stopColor="#15803d" />
          </linearGradient>
        </defs>

        <path
          d={arcPath(cx, cy, r, 0, 100)}
          fill="none"
          stroke="#eef2f7"
          strokeWidth="36"
          strokeLinecap="butt"
        />
        <path
          d={arcPath(cx, cy, r, 0, 100)}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="30"
          strokeLinecap="butt"
        />

        <polygon
          points={`${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${left.x.toFixed(2)},${left.y.toFixed(2)} ${right.x.toFixed(2)},${right.y.toFixed(2)}`}
          fill="#111827"
        />
        <circle cx={cx} cy={cy} r="14" fill="#111827" />
        <circle cx={cx} cy={cy} r="6" fill="#ffffff" />

        <text
          x={cx}
          y="118"
          textAnchor="middle"
          fill="#111827"
          style={{
            fontFamily:
              "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: 68,
            fontWeight: 700,
          }}
        >
          {clamped}
        </text>
        {band ? (
          <text
            x={cx}
            y="154"
            textAnchor="middle"
            fill={bandColor}
            style={{
              fontFamily:
                "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
              fontSize: 22,
              fontWeight: 700,
            }}
          >
            {band}
          </text>
        ) : null}

        <text
          x="36"
          y="255"
          textAnchor="start"
          fill="#94a3b8"
          style={{
            fontFamily:
              "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: 15,
            fontWeight: 700,
          }}
        >
          Fear
        </text>
        <text
          x="404"
          y="255"
          textAnchor="end"
          fill="#94a3b8"
          style={{
            fontFamily:
              "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: 15,
            fontWeight: 700,
          }}
        >
          Greed
        </text>
      </svg>
    </div>
  );
}
