import { SvgMarkup } from "@/components/SvgMarkup";
import { buildFearGreedGaugeSvg } from "@/lib/fear-greed-gauge";
import type { SentimentBand } from "@/lib/sentiment";

type FearGreedDialProps = {
  score: number;
  /** Ignored for rendering — highlight follows `score`. Kept for call sites. */
  band?: SentimentBand | null;
  label?: string;
  className?: string;
  /** Kept for call-site compatibility (no longer used). */
  gradientId?: string;
};

function clampScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * CNN-style Fear → Greed semicircle (static SVG graphic).
 * @see https://edition.cnn.com/markets/fear-and-greed
 */
export function FearGreedDial({
  score,
  label,
  className,
}: FearGreedDialProps) {
  const clamped = clampScore(score);
  const svg = buildFearGreedGaugeSvg({ score: clamped, activeColorOnly: true });

  return (
    <div className={className}>
      {label ? (
        <div className="mb-1 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#718079]">
          {label}
        </div>
      ) : null}
      <SvgMarkup
        className="mx-auto w-full max-w-[320px] [&_svg]:h-auto [&_svg]:w-full"
        svg={svg}
      />
    </div>
  );
}
