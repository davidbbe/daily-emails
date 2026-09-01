"use client";

import { useEffect, useId, useRef } from "react";

type TradingViewChartProps = {
  symbol: string;
  height?: number;
  /** Strip chrome so the plot fits a narrow sector card. */
  compact?: boolean;
};

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown;
    };
  }
}

const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";
let scriptPromise: Promise<void> | null = null;

function loadTradingViewScript() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TradingView) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("TradingView script failed to load")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed to load"));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

const DEFAULT_STUDIES = [
  { id: "RSI@tv-basicstudies", inputs: { length: 14 } },
];

export function TradingViewChart({
  symbol,
  height = 360,
  compact = false,
}: TradingViewChartProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const containerId = `tv_${reactId}`;

  useEffect(() => {
    let cancelled = false;
    let mounted = false;
    let lastWidth = 0;
    let lastHeight = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const frame = frameRef.current;
    const container = containerRef.current;
    if (!frame || !container) return;

    const createWidget = () => {
      if (cancelled || !window.TradingView) return;
      const width = Math.floor(frame.clientWidth);
      const heightPx = Math.floor(frame.clientHeight);
      if (width < 2 || heightPx < 2) return;
      lastWidth = width;
      lastHeight = heightPx;
      container.innerHTML = "";
      new window.TradingView.widget({
        autosize: false,
        width,
        height: heightPx,
        symbol,
        interval: "D",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "2",
        locale: "en",
        toolbar_bg: "#0d1311",
        enable_publishing: false,
        allow_symbol_change: false,
        hide_side_toolbar: compact,
        hide_top_toolbar: compact,
        hide_legend: compact,
        hide_volume: false,
        container_id: containerId,
        // Avoid restoring a prior layout that omitted custom studies.
        disabled_features: ["use_localstorage_for_settings"],
        studies: DEFAULT_STUDIES,
        studies_overrides: {
          "relative strength index.length": 14,
          "relative strength index.rsi.color": "#a3e635",
          "relative strength index.rsi.linewidth": 2,
        },
      });
      mounted = true;
    };

    const mount = () => {
      loadTradingViewScript()
        .then(() => {
          if (cancelled) return;
          createWidget();
        })
        .catch((error) => {
          console.warn("TradingView chart failed to load", error);
        });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        mount();
      },
      { rootMargin: "360px" },
    );
    observer.observe(frame);

    const resizeObserver = new ResizeObserver(() => {
      if (!mounted || cancelled) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (cancelled || !mounted) return;
        const width = Math.floor(frame.clientWidth);
        const heightPx = Math.floor(frame.clientHeight);
        if (
          Math.abs(width - lastWidth) < 4 &&
          Math.abs(heightPx - lastHeight) < 4
        ) {
          return;
        }
        createWidget();
      }, 200);
    });
    resizeObserver.observe(frame);

    return () => {
      cancelled = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearTimeout(resizeTimer);
      container.innerHTML = "";
    };
  }, [symbol, containerId, compact]);

  return (
    <div
      ref={frameRef}
      className={
        compact
          ? "tradingview-widget-container w-full min-w-0 overflow-hidden bg-[#0d1311]"
          : "tradingview-widget-container w-full min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-[#0d1311]"
      }
      style={{ height }}
    >
      <div
        id={containerId}
        ref={containerRef}
        className="h-full min-h-0 w-full min-w-0"
      />
    </div>
  );
}
