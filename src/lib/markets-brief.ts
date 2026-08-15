import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import type { DailyBrief, EarningsEvent, TickerBrief } from "@/lib/brief";
import type { SentimentReport } from "@/lib/sentiment";
import type { TickerValuation } from "@/lib/valuation";
import type { InsiderBrief } from "@/lib/openinsider";
import type { WhaleBrief } from "@/lib/whale-brief";

const BLOB_PATHNAME = "daily-emails/markets-latest.json";
const LOCAL_PATH = path.join(process.cwd(), ".data", "markets-latest.json");

/** Markets payload shown on the secret hosted page (latest run only). */
export type MarketsBrief = {
  generatedAt: string;
  sentiment: SentimentReport;
  tickers: TickerBrief[];
  earningsCalendar: EarningsEvent[];
  insiders?: InsiderBrief;
  whales?: WhaleBrief;
  valuation?: TickerValuation[];
};

export function toMarketsBrief(brief: DailyBrief): MarketsBrief {
  return {
    generatedAt: brief.generatedAt,
    sentiment: brief.sentiment,
    tickers: brief.tickers,
    earningsCalendar: brief.earningsCalendar,
    insiders: brief.insiders,
    whales: brief.whales,
    valuation: brief.valuation,
  };
}

function isVercelRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function canUseBlob() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
      process.env.BLOB_STORE_ID?.trim(),
  );
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

async function streamToText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

async function getBlobText(pathname: string): Promise<string | null> {
  const token = blobToken();
  const result = await get(pathname, {
    access: "public",
    useCache: false,
    ...(token ? { token } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return streamToText(result.stream);
}

async function loadFromBlob(): Promise<MarketsBrief | null> {
  try {
    const text = await getBlobText(BLOB_PATHNAME);
    if (!text) return null;
    return JSON.parse(text) as MarketsBrief;
  } catch (error) {
    console.warn("markets-brief: blob load failed", error);
    return null;
  }
}

async function saveToBlob(payload: MarketsBrief) {
  const token = blobToken();
  await put(BLOB_PATHNAME, JSON.stringify(payload, null, 2), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    ...(token ? { token } : {}),
  });
}

async function loadFromLocal(): Promise<MarketsBrief | null> {
  try {
    const text = await readFile(LOCAL_PATH, "utf8");
    return JSON.parse(text) as MarketsBrief;
  } catch {
    return null;
  }
}

async function saveToLocal(payload: MarketsBrief) {
  await mkdir(path.dirname(LOCAL_PATH), { recursive: true });
  await writeFile(LOCAL_PATH, JSON.stringify(payload, null, 2), "utf8");
}

export async function loadMarketsBrief(): Promise<MarketsBrief | null> {
  if (canUseBlob()) {
    const fromBlob = await loadFromBlob();
    if (fromBlob) return fromBlob;
  }
  if (isVercelRuntime()) return null;
  return loadFromLocal();
}

/**
 * Persist the latest markets brief for the hosted page.
 * Never throws: a failed save must not block the daily email.
 */
export async function saveMarketsBrief(payload: MarketsBrief): Promise<void> {
  if (canUseBlob()) {
    try {
      await saveToBlob(payload);
      return;
    } catch (error) {
      console.warn("markets-brief: blob save failed", error);
      if (isVercelRuntime()) return;
      console.warn("markets-brief: falling back to local store");
    }
  } else if (isVercelRuntime()) {
    console.warn(
      "markets-brief: Blob not configured on Vercel; hosted markets page will be empty until BLOB_READ_WRITE_TOKEN is set",
    );
    return;
  }

  try {
    await saveToLocal(payload);
  } catch (error) {
    console.warn("markets-brief: local save failed", error);
  }
}
