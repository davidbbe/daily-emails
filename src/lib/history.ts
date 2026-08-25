import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import { materialPersonItems, type DailyBrief } from "@/lib/brief";
import type { TrendRegionId } from "@/lib/config";

const BLOB_PATHNAME = "daily-emails/previous-brief.json";
/** Pre-rename path — read fallback until the next successful save. */
const LEGACY_BLOB_PATHNAME = "agent-dave/previous-brief.json";
const LOCAL_PATH = path.join(process.cwd(), ".data", "previous-brief.json");

/** Slim snapshot used for day-over-day comparisons */
export type BriefSnapshot = {
  generatedAt: string;
  tickers: Array<{
    id: string;
    bullets: string[];
    whyItMatters: string;
  }>;
  people: Array<{ id: string; summary: string }>;
  trendTitles: Partial<Record<TrendRegionId, string[]>>;
};

export function toSnapshot(brief: DailyBrief): BriefSnapshot {
  const trendTitles: BriefSnapshot["trendTitles"] = {};
  for (const region of brief.trends.regions) {
    trendTitles[region.id] = region.items
      .map((item) => item.titleEn.trim() || item.title.trim())
      .filter((title) => title.length > 0);
  }

  return {
    generatedAt: brief.generatedAt,
    tickers: brief.tickers.map((t) => ({
      id: t.id,
      bullets: t.bullets.map((b) => b.text),
      whyItMatters: t.whyItMatters,
    })),
    people: brief.people.map((p) => ({
      id: p.id,
      summary: materialPersonItems(p)
        .map((item) => item.summary)
        .join(" | "),
    })),
    trendTitles,
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

async function streamToText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

async function getBlobText(pathname: string): Promise<string | null> {
  const token = blobToken();
  // Store is public (private access is rejected by the Blob API).
  const result = await get(pathname, {
    access: "public",
    useCache: false,
    ...(token ? { token } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return streamToText(result.stream);
}

async function loadFromBlob(): Promise<BriefSnapshot | null> {
  try {
    const text =
      (await getBlobText(BLOB_PATHNAME)) ??
      (await getBlobText(LEGACY_BLOB_PATHNAME));
    if (!text) return null;
    return JSON.parse(text) as BriefSnapshot;
  } catch (error) {
    console.warn("history: blob load failed", error);
    return null;
  }
}

async function saveToBlob(snapshot: BriefSnapshot) {
  const token = blobToken();
  await put(BLOB_PATHNAME, JSON.stringify(snapshot, null, 2), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    ...(token ? { token } : {}),
  });
}

async function loadFromLocal(): Promise<BriefSnapshot | null> {
  try {
    const text = await readFile(LOCAL_PATH, "utf8");
    return JSON.parse(text) as BriefSnapshot;
  } catch {
    return null;
  }
}

async function saveToLocal(snapshot: BriefSnapshot) {
  await mkdir(path.dirname(LOCAL_PATH), { recursive: true });
  await writeFile(LOCAL_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

export async function loadPreviousBrief(): Promise<BriefSnapshot | null> {
  if (canUseBlob()) {
    const fromBlob = await loadFromBlob();
    if (fromBlob) return fromBlob;
  }
  // Serverless FS is read-only / ephemeral — only use local disk in dev.
  if (isVercelRuntime()) return null;
  return loadFromLocal();
}

/**
 * Persist a snapshot for day-over-day comparisons.
 * Never throws: a failed save must not block the daily email.
 */
export async function savePreviousBrief(snapshot: BriefSnapshot): Promise<void> {
  if (canUseBlob()) {
    try {
      await saveToBlob(snapshot);
      return;
    } catch (error) {
      console.warn("history: blob save failed", error);
      if (isVercelRuntime()) {
        // Do not fall back to local mkdir under /var/task — that throws ENOENT
        // and previously aborted the cron before Resend ran.
        return;
      }
      console.warn("history: falling back to local snapshot store");
    }
  } else if (isVercelRuntime()) {
    console.warn(
      "history: Blob not configured on Vercel; day-over-day movers will be unavailable until BLOB_READ_WRITE_TOKEN is set",
    );
    return;
  }

  try {
    await saveToLocal(snapshot);
  } catch (error) {
    console.warn("history: local save failed", error);
  }
}
