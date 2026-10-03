/** Generation-only evaluation: spends Gateway credits, sends no email, saves no digest. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import nextEnv from "@next/env";
import { generateDailyBrief } from "@/lib/brief";
import { getModel, PEOPLE, TICKERS } from "@/lib/config";
import { emptyInsiderBrief } from "@/lib/openinsider";
import type { ResearchBundle } from "@/lib/research";
import { emptyWhaleResearch } from "@/lib/whales";

nextEnv.loadEnvConfig(process.cwd());
if (getModel() !== "openai/gpt-5-mini") {
  throw new Error("Set AI_MODEL=openai/gpt-5-mini for this evaluation.");
}

/** Synthetic inputs exercise every digest workload without fetching live sources. */
function representativeInput(): ResearchBundle {
  const collectedAt = new Date().toISOString();
  const bundle: ResearchBundle = {
    collectedAt, windowHours: 24, tickers: {}, people: {},
    trends: { us: [], thailand: [] }, earnings: [], reddit: [], sites: [],
    sentiment: { collectedAt, meters: [], tickers: [], valueDial: "" },
    insiders: emptyInsiderBrief(), whales: emptyWhaleResearch(),
    valuation: [], gcpBilling: null,
  };
  for (const ticker of TICKERS) {
    bundle.tickers[ticker.id] = [
      "announces a new product launch with availability next quarter",
      "faces a regulatory review; no decision has been announced",
      "reports rising customer demand while warning of higher operating costs",
      "is discussed by analysts ahead of upcoming results; no results yet",
      "shares trade unevenly after hours amid broader market volatility",
      "is the subject of an unconfirmed social-media rumor",
    ].map((event, index) => ({
      title: `[Synthetic evaluation] ${ticker.label} ${event}`,
      link: `https://example.com/eval/${ticker.id}/${index}`,
      publishedAt: collectedAt, source: "Synthetic fixture",
    }));
    if (ticker.id !== "BTC") bundle.valuation.push({
      tickerId: ticker.id, quoteSymbol: ticker.quoteSymbol,
      pe: 25, forwardPe: 20, pe5yAvg: 28,
      roic: 0.18, fcfYield: 0.035, evEbitda: 17,
      sourceUrl: `https://example.com/eval/valuation/${ticker.id}`,
    });
  }
  for (const person of PEOPLE) {
    bundle.people[person.id] = [{
      title: `[Synthetic evaluation] ${person.name} says infrastructure costs constrain expansion; no specific forecast provided`,
      link: `https://example.com/eval/people/${person.id}`,
      publishedAt: collectedAt, source: "Synthetic fixture",
    }];
  }
  bundle.trends.us = [{ title: "黄金", newsTitle: "黄金价格", approxTraffic: "100K+", trafficScore: 100000 }];
  bundle.trends.thailand = ["ราคาทอง", "น้ำท่วม", "เลือกตั้ง", "หุ้นไทย", "ฟุตบอล"].map((title, index) => ({
    title, approxTraffic: "100K+", trafficScore: 100000 - index * 10000,
    newsTitle: index === 0 ? "Gold prices draw attention" : undefined,
    newsUrl: `https://example.com/eval/trends/${index}`,
  }));
  bundle.whales.quarterLabel = "Q2 2026";
  bundle.whales.filingsSoFar = 30;
  bundle.whales.filingsTotal = 80;
  bundle.whales.clusterBuys = [
    { ticker: "MSFT", name: "Microsoft", buyerCount: 4 },
    { ticker: "META", name: "Meta", buyerCount: 3 },
  ];
  bundle.whales.managerMoves = [
    { manager: "Synthetic fund A", period: "Q2 2026", ticker: "MSFT", name: "Microsoft", action: "Buy", portfolioPct: 4 },
    { manager: "Synthetic fund B", period: "Q2 2026", ticker: "META", name: "Meta", action: "Add", portfolioPct: 3 },
  ];
  return bundle;
}

const inputPath = process.argv.slice(2).find((argument) => argument !== "--sparse");
const fullInput: ResearchBundle = inputPath
  ? JSON.parse(await readFile(inputPath, "utf8"))
  : representativeInput();
const sparseInput: ResearchBundle = {
  ...fullInput, tickers: { TSLA: fullInput.tickers.TSLA?.slice(0, 1) ?? [] },
  people: {}, trends: { us: [], thailand: [] }, valuation: [],
  whales: emptyWhaleResearch(), feedErrors: { MU: "Synthetic feed outage" },
};

type Call = {
  workload: string; elapsedMs: number; status: number; finishReason?: string;
  error?: string;
  inputTokens: number; outputTokens: number; reasoningTokens: number;
};
const results = [];
const scenarios = process.argv.includes("--sparse")
  ? [["sparse", sparseInput]] as const : [["full", fullInput]] as const;
for (const [name, input] of scenarios) {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const started = performance.now();
    const response = await originalFetch(url, init);
    if (new Headers(init?.headers).get("ai-language-model-id")) {
      const request = JSON.parse(String(init?.body));
      const properties = request.responseFormat?.schema?.properties ?? {};
      const data = await response.clone().json().catch(() => ({}));
      const usage = data.usage;
      const call: Call = {
        workload: properties.tickers ? "core" : properties.regions ? "local-trends"
          : properties.items ? "translation" : properties.notes ? "valuation" : "whales",
        elapsedMs: Math.round(performance.now() - started), status: response.status,
        finishReason: data.finishReason?.unified,
        error: response.ok ? undefined : JSON.stringify(data.error ?? data).slice(0, 1500),
        inputTokens: usage?.inputTokens?.total ?? 0,
        outputTokens: usage?.outputTokens?.total ?? 0,
        reasoningTokens: usage?.outputTokens?.reasoning ?? 0,
      };
      calls.push(call);
      console.log(JSON.stringify({ scenario: name, ...call }));
    }
    return response;
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  const started = performance.now();
  try {
    const brief = await generateDailyBrief(input);
    const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
    const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0);
    const totalCostUsd = inputTokens * 0.00000025 + outputTokens * 0.000002;
    const successful = !warnings.length && calls.every((call) => call.status === 200 && call.finishReason === "stop");
    const result = {
      scenario: name, elapsedMs: Math.round(performance.now() - started), calls,
      inputTokens, outputTokens, estimatedCostUsd: totalCostUsd,
      estimated30RunsUsd: successful ? totalCostUsd * 30 : null, warnings,
      tickerCount: brief.tickers.length,
      sourcedBulletCount: brief.tickers.flatMap((ticker) => ticker.bullets).filter((bullet) => bullet.sourceUrl).length,
      valuationNoteCount: brief.valuation.filter((row) => row.valueInvestorNote).length,
      nonEnglishTrendCount: brief.trends.regions.flatMap((region) => region.items)
        .filter((item) => /[\u0E00-\u0E7F\u4E00-\u9FFF]/u.test(`${item.titleEn} ${item.descriptionEn ?? ""}`)).length,
      brief,
    };
    results.push(result);
    console.log(JSON.stringify({ ...result, brief: undefined }));
    if (!successful || result.nonEnglishTrendCount > 0) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}
await mkdir(".data", { recursive: true });
await writeFile(`.data/ai-model-evaluation-${scenarios[0][0]}.json`, JSON.stringify({
  evaluatedAt: new Date().toISOString(), model: getModel(), reasoning: "low",
  input: inputPath ? "Provided research JSON" : "Synthetic representative inputs",
  pricing: "2026-10-03 standard rates; reasoning included in output; cache discounts excluded",
  results,
}, null, 2));
