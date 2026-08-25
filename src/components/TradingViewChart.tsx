"use client";

import { useEffect, useId, useRef } from "react";

type TradingViewChartProps = {
  symbol: string;
  height?: number;
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
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const containerId = `tv_${reactId}`;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const mount = () => {
      loadTradingViewScript()
        .then(() => {
          if (cancelled || !container || !window.TradingView) return;
          container.innerHTML = "";
          const widget = new window.TradingView.widget({
            autosize: true,
            symbol,
            interval: "D",
            timezone: "Etc/UTC",
            theme: "dark",
            style: "2",
            locale: "en",
            toolbar_bg: "#0d1311",
            enable_publishing: false,
            allow_symbol_change: false,
            hide_side_toolbar: false,
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
          void widget;
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
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
      container.innerHTML = "";
    };
  }, [symbol, containerId]);

  return (
    <div
      className="tradingview-widget-container overflow-hidden rounded-2xl border border-white/8 bg-[#0d1311]"
      style={{ height }}
    >
      <div
        id={containerId}
        ref={containerRef}
        style={{ height: "100%", width: "100%" }}
      />
    </div>
  );
}
