import { get, list, put } from "@vercel/blob";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createGateway } from "ai";
import { z } from "zod";
import {
  AI_GATEWAY_MONTHLY_BUDGET_USD,
  BLOB_HOBBY_ADVANCED_OPS,
  BLOB_HOBBY_DATA_TRANSFER_BYTES,
  BLOB_HOBBY_SIMPLE_OPS,
  BLOB_HOBBY_STORAGE_BYTES,
  HOBBY_EDGE_REQUESTS,
  HOBBY_FAST_DATA_TRANSFER_BYTES,
  HOBBY_FUNCTION_INVOCATIONS,
  USAGE_WATCH_THRESHOLD,
  getBlobAccess,
} from "@/lib/config";
import { formatHumanDate, formatHumanDatesInText } from "@/lib/dates";
import { collectRapidApiUsage, rapidApiDailyMetric, type RapidApiUsageReport } from "@/lib/rapidapi-usage";

export type UsageMetric = {
  id: string;
  label: string;
  /** Amount consumed toward the limit */
  used: number;
  /** null means the provider reports no cap. */
  limit: number | null;
  unit: string;
  percent: number;
  /** Human-readable status line shown in the email */
  detail: string;
  /** False when the metric could not be collected */
  available: boolean;
  error?: string;
  /** Unverified plan limits must never be presented as provider caps. */
  limitBasis?: "provider" | "budget" | "configured" | "unknown" | "snapshot";
  source?: "live" | "cached";
};

export type UsageReport = {
  collectedAt: string;
  thresholdPercent: number;
  metrics: UsageMetric[];
  /** Metrics at or above the watch threshold */
  watch: UsageMetric[];
  rapidApi?: RapidApiUsageReport;
};

function envNumber(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function gatewayBudgetUsd() {
  return envNumber("AI_GATEWAY_MONTHLY_BUDGET", AI_GATEWAY_MONTHLY_BUDGET_USD);
}

function roundPercent(used: number, limit: number | null) {
  if (limit == null) return 0;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.round((used / limit) * 1000) / 10;
}

function metric(partial: Omit<UsageMetric, "percent"> & { percent?: number }): UsageMetric {
  const percent =
    partial.percent ??
    (partial.available ? roundPercent(partial.used, partial.limit) : 0);
  return { ...partial, detail: formatHumanDatesInText(partial.detail), percent };
}

function unavailable(
  id: string,
  label: string,
  limit: number | null,
  unit: string,
  reason: string,
): UsageMetric {
  return metric({
    id,
    label,
    used: 0,
    limit,
    unit,
    detail: reason,
    available: false,
    error: reason,
  });
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

/** SI units so transfer figures match the Vercel Usage dashboard (8.66 GB, not 8.05 GiB). */
function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) {
    return `${(bytes / (1000 * 1000)).toFixed(2)} MB`;
  }
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
}

export async function collectAiGateway(now = new Date()): Promise<UsageMetric> {
  const budget = gatewayBudgetUsd();
  try {
    const gateway = createGateway({
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(10_000),
        ]),
      }),
    });
    const startDate = `${now.toISOString().slice(0, 7)}-01`;
    const endDate = now.toISOString().slice(0, 10);
    const [credits, spend] = await Promise.allSettled([
      gateway.getCredits(),
      gateway.getSpendReport({ startDate, endDate, groupBy: "day" }),
    ]);
    const balance = credits.status === "fulfilled" ? Number(credits.value.balance) : NaN;
    const totalUsed = credits.status === "fulfilled" ? Number(credits.value.totalUsed) : NaN;
    const creditsNote = Number.isFinite(balance) && Number.isFinite(totalUsed)
      ? `${formatUsd(balance)} credit balance · ${formatUsd(totalUsed)} lifetime spend`
      : "Credit balance unavailable";
    if (spend.status === "rejected") {
      const reason = spend.reason instanceof Error ? spend.reason.message : "Spend report unavailable";
      return unavailable(
        "ai-gateway",
        "AI Gateway month-to-date spend",
        budget,
        "USD",
        `${creditsNote} · Monthly spend unavailable: ${reason} Credit balance is not a monthly spend measurement.`,
      );
    }

    const usedTowardBudget = spend.value.results.reduce((sum, row) => sum + row.totalCost, 0);
    if (!Number.isFinite(usedTowardBudget) || usedTowardBudget < 0) {
      throw new Error("Invalid Gateway spend report");
    }

    return metric({
      id: "ai-gateway",
      label: "AI Gateway month-to-date spend",
      used: usedTowardBudget,
      limit: budget,
      unit: "USD",
      detail: `${startDate}–${endDate} UTC · Gateway account total · ${creditsNote} · ${formatUsd(budget)} configured monthly budget; not a provider cap`,
      limitBasis: "budget",
      source: "live",
      available: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Gateway credits unavailable";
    console.warn("usage: AI Gateway credits failed", error);
    return unavailable(
      "ai-gateway",
      "AI Gateway credits",
      budget,
      "USD",
      message,
    );
  }
}

function canUseBlob() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
      process.env.BLOB_STORE_ID?.trim(),
  );
}

async function collectBlobStorage(): Promise<UsageMetric> {
  const limit = null;
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!canUseBlob()) {
    return unavailable(
      "blob-storage",
      "Blob storage",
      limit,
      "bytes",
      "Blob not configured (set BLOB_READ_WRITE_TOKEN)",
    );
  }

  try {
    let cursor: string | undefined;
    let totalBytes = 0;
    let blobCount = 0;
    const signal = AbortSignal.timeout(20_000);
    const cursors = new Set<string>();

    do {
      // Pass token explicitly — with BLOB_STORE_ID set locally, the SDK can
      // prefer store/OIDC auth and fail without VERCEL_OIDC_TOKEN.
      const page = await list({
        cursor,
        limit: 1000,
        abortSignal: signal,
        ...(token ? { token } : {}),
      });
      for (const blob of page.blobs) {
        if (!Number.isFinite(blob.size) || blob.size < 0) throw new Error("Invalid Blob object size");
        totalBytes += blob.size;
        blobCount += 1;
      }
      cursor = page.hasMore ? page.cursor : undefined;
      if (page.hasMore && (!cursor || cursors.has(cursor))) throw new Error("Incomplete Blob listing");
      if (cursor) cursors.add(cursor);
    } while (cursor);

    return metric({
      id: "blob-storage",
      label: "Blob storage · connected store",
      used: totalBytes,
      limit,
      unit: "bytes",
      detail: `${formatBytes(totalBytes)} across ${blobCount} object${blobCount === 1 ? "" : "s"} · current snapshot of this store; excludes other team stores and is not Vercel’s billed storage average`,
      limitBasis: "snapshot",
      source: "live",
      available: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Blob list failed";
    console.warn("usage: Blob storage failed", error);
    return unavailable("blob-storage", "Blob storage", limit, "bytes", message);
  }
}

const resendWindowSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  resets_at: z.string().datetime({ offset: true }),
});
const resendCacheSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  daily: resendWindowSchema,
  monthly: resendWindowSchema,
});
const resendUsageSchema = z.object({
  emails: z.object({ daily: resendWindowSchema, monthly: resendWindowSchema }),
});
type ResendQuotaCache = z.infer<typeof resendCacheSchema>;

const RESEND_CACHE_PATH = path.join(
  process.cwd(),
  ".data",
  "resend-usage.json",
);
const RESEND_BLOB_PATHNAME = "daily-emails/resend-usage.json";
/** Pre-rename path — read fallback until the next successful save. */
const LEGACY_RESEND_BLOB_PATHNAME = "agent-dave/resend-usage.json";

function isVercelRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

async function streamToText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

function buildResendMetrics(
  cache: ResendQuotaCache,
  source: "live" | "cached",
  now: Date,
): UsageMetric[] {
  return (["daily", "monthly"] as const).map((period) => {
    const counter = cache[period];
    const id = `resend-${period}`;
    const label = `Resend ${period} emails`;
    const observedAt = Date.parse(cache.updatedAt);
    const resetsAt = Date.parse(counter.resets_at);
    const observation = `${source === "cached" ? "cached" : "observed"} ${formatHumanDate(cache.updatedAt)}`;
    if (observedAt > now.getTime() || resetsAt <= observedAt || resetsAt <= now.getTime()) {
      return unavailable(id, label, counter.limit, "emails", `Current usage unavailable — ${observation}; reporting period expired or invalid. Refresh required.`);
    }
    const amount = counter.limit == null
      ? `${counter.used} emails; no ${period} cap`
      : `${counter.used} / ${counter.limit} emails`;
    return metric({
      id,
      label,
      used: counter.used,
      limit: counter.limit,
      unit: "emails",
      available: true,
      source,
      limitBasis: "provider",
      detail: `${amount} (sent + received) · ${observation} · resets ${formatHumanDate(counter.resets_at)} · collected before both daily emails are sent`,
    });
  });
}

function parseResendCache(text: string): ResendQuotaCache | null {
  try {
    // Old last-send headers have no limits/reset times, so cannot be reused safely.
    const result = resendCacheSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function getBlobText(pathname: string): Promise<string | null> {
  const token = blobToken();
  const result = await get(pathname, {
    access: getBlobAccess(),
    abortSignal: AbortSignal.timeout(10_000),
    useCache: false,
    ...(token ? { token } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return streamToText(result.stream);
}

async function loadResendCacheFromBlob(): Promise<ResendQuotaCache | null> {
  if (!canUseBlob()) return null;
  try {
    const text =
      (await getBlobText(RESEND_BLOB_PATHNAME)) ??
      (await getBlobText(LEGACY_RESEND_BLOB_PATHNAME));
    if (!text) return null;
    return parseResendCache(text);
  } catch (error) {
    console.warn("usage: Resend Blob cache load failed", error);
    return null;
  }
}

async function loadResendCacheFromLocal(): Promise<ResendQuotaCache | null> {
  try {
    return parseResendCache(await readFile(RESEND_CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function loadCachedResendQuota(now?: Date): Promise<UsageMetric[] | null> {
  const cached =
    (await loadResendCacheFromBlob()) ??
    (isVercelRuntime() ? null : await loadResendCacheFromLocal());
  if (!cached) return null;
  return buildResendMetrics(cached, "cached", now ?? new Date());
}

async function saveResendCache(payload: ResendQuotaCache) {
  const body = JSON.stringify(payload, null, 2);

  if (canUseBlob()) {
    try {
      const token = blobToken();
      await put(RESEND_BLOB_PATHNAME, body, {
        access: getBlobAccess(),
        abortSignal: AbortSignal.timeout(10_000),
        contentType: "application/json",
        allowOverwrite: true,
        addRandomSuffix: false,
        cacheControlMaxAge: 60,
        ...(token ? { token } : {}),
      });
      if (isVercelRuntime()) return;
    } catch (error) {
      console.warn("usage: Resend Blob cache save failed", error);
      if (isVercelRuntime()) return;
    }
  } else if (isVercelRuntime()) {
    console.warn(
      "usage: Blob not configured; Resend usage fallback cannot persist across cron runs",
    );
    return;
  }

  try {
    await mkdir(path.dirname(RESEND_CACHE_PATH), { recursive: true });
    await writeFile(RESEND_CACHE_PATH, body, "utf8");
  } catch (error) {
    console.warn("usage: failed to cache Resend quotas locally", error);
  }
}

/** Read-only account usage requires a full-access key; sending can keep its own key. */
export async function collectResendQuota(now?: Date): Promise<UsageMetric[]> {
  const unavailableMetrics = (reason: string) => (["daily", "monthly"] as const).map(
    (period) => unavailable(`resend-${period}`, `Resend ${period} emails`, null, "emails", reason),
  );
  const apiKey = process.env.RESEND_USAGE_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return unavailableMetrics("Set RESEND_USAGE_API_KEY to a full-access Resend key (or use a full-access RESEND_API_KEY)");

  try {
    const response = await fetch("https://api.resend.com/usage", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Resend usage API ${response.status}: usage requires a valid full-access key. Set RESEND_USAGE_API_KEY; the sending key can remain in RESEND_API_KEY.`);
      }
      throw new Error(`Resend usage API ${response.status}`);
    }
    const result = resendUsageSchema.safeParse(await response.json());
    if (!result.success) throw new Error("Resend usage API returned invalid counters, limits, or reset times");
    const observedAt = now ?? new Date();
    const cache: ResendQuotaCache = { updatedAt: observedAt.toISOString(), ...result.data.emails };
    const metrics = buildResendMetrics(cache, "live", observedAt);
    // A cache failure must not discard valid live readings.
    await saveResendCache(cache).catch((error) => console.warn("usage: Resend cache save failed", error));
    return metrics;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend usage unavailable";
    const cached = await loadCachedResendQuota(now);
    if (cached) return cached.map(m => ({ ...m, detail: `${m.detail} · Live refresh failed: ${message}` }));
    console.warn("usage: Resend quota failed", error);
    return unavailableMetrics(message);
  }
}

export function formatMetricUsed(m: UsageMetric) {
  if (!m.available) return "n/a";
  if (m.unit === "USD") return formatUsd(m.used);
  if (m.unit === "bytes") return formatBytes(m.used);
  return `${m.used.toLocaleString("en-US")} ${m.unit}`;
}

export function formatMetricLimit(m: UsageMetric) {
  if (m.limitBasis === "snapshot") return "Snapshot only";
  if (m.limitBasis === "unknown") return "Cap unverified";
  if (m.limit == null) return "No cap";
  if (m.unit === "USD") return formatUsd(m.limit);
  if (m.unit === "bytes") return formatBytes(m.limit);
  return `${m.limit.toLocaleString("en-US")} ${m.unit}`;
}

function resolveTeamId() {
  const fromEnv =
    process.env.VERCEL_TEAM_ID?.trim() || process.env.VERCEL_ORG_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(
      path.join(process.cwd(), ".vercel", "project.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { orgId?: string };
    return parsed.orgId?.trim() || null;
  } catch {
    return null;
  }
}

/** Hobby allowances use a moving 30-day window, including today's partial usage. */
function usageWindow(now = new Date()) {
  return {
    from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

async function vercelApiGetJson(apiPath: string, body?: Record<string, unknown>): Promise<unknown> {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (token) {
    const response = await fetch(`https://api.vercel.com${apiPath}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Vercel API ${response.status}: ${text.slice(0, 180) || response.statusText}`,
      );
    }
    return JSON.parse(text) as unknown;
  }

  // Local/dev fallback: use authenticated Vercel CLI when no token is set.
  // On Vercel (VERCEL=1), require VERCEL_TOKEN instead.
  if (process.env.VERCEL === "1") {
    throw new Error(
      "VERCEL_TOKEN is required on Vercel to read platform usage (create at vercel.com/account/tokens)",
    );
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(
      "vercel",
      ["api", apiPath, "--raw", ...(body ? ["--method", "POST", "--input", "-"] : [])],
      { stdio: [body ? "pipe" : "ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    child.stdin?.on("error", reject);
    if (body) child.stdin?.end(JSON.stringify(body));
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `vercel api failed (${code}): ${(stderr || stdout).slice(0, 200)}`,
          ),
        );
        return;
      }
      try {
        const jsonStart = stdout.indexOf("{");
        const payload = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
        resolve(JSON.parse(payload) as unknown);
      } catch (error) {
        reject(
          new Error(
            `vercel api returned non-JSON: ${stdout.slice(0, 120) || String(error)}`,
          ),
        );
      }
    });
  });
}

const usageMeterSchema = z.object({
  metric: z.object({ slug: z.string() }),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  queriedAt: z.iso.datetime(),
  filterBy: z.record(z.string(), z.unknown()),
  results: z.object({ format: z.literal("scalar"), totalValue: z.number().finite().nonnegative() }),
});

/** Dashboard metered totals; legacy /v2/usage Blob counters include different operations. */
async function fetchUsageMeter(slug: string, teamId: string, window: ReturnType<typeof usageWindow>) {
  const result = await vercelApiGetJson(
    `/v1/usage-metrics/query?teamId=${encodeURIComponent(teamId)}`,
    { metric: slug, ...window, format: "scalar", views: { total: { groupBy: [] } } },
  );
  const parsed = usageMeterSchema.safeParse(result);
  if (!parsed.success) throw new Error("Invalid Vercel usage meter; no verified total");
  const meter = parsed.data;
  const end = Date.parse(meter.to);
  if (meter.metric.slug !== slug || Date.parse(meter.from) !== Date.parse(window.from) ||
      end > Date.parse(window.to) || end < Date.parse(window.to) - 60_000 ||
      Date.parse(meter.queriedAt) < end || Date.parse(meter.queriedAt) > Date.parse(window.to) + 60_000 ||
      Object.keys(meter.filterBy).length > 0) {
    throw new Error("Vercel usage meter returned a different reporting window or scope");
  }
  return meter;
}

// Invalidate old complete-day/legacy-counter caches after changing the meter source.
const PLATFORM_CACHE_VERSION = 2;

const PLATFORM_BLOB_PATHNAME = "daily-emails/platform-usage.json";
/** Pre-rename path — read fallback until the next successful save. */
const LEGACY_PLATFORM_BLOB_PATHNAME = "agent-dave/platform-usage.json";

type PlatformUsageCache = {
  version: number;
  updatedAt: string;
  teamId: string;
  from: string;
  to: string;
  metrics: Array<{
    id: string;
    label: string;
    used: number;
    limit: number | null;
    unit: string;
    detail: string;
    limitBasis?: UsageMetric["limitBasis"];
    available: boolean;
  }>;
};

function platformUnavailable(reason: string): UsageMetric[] {
  return [
    unavailable(
      "fast-data-transfer",
      "Fast Data Transfer",
      HOBBY_FAST_DATA_TRANSFER_BYTES,
      "bytes",
      reason,
    ),
    unavailable(
      "edge-requests",
      "Edge Requests",
      HOBBY_EDGE_REQUESTS,
      "requests",
      reason,
    ),
    unavailable(
      "function-invocations",
      "Function invocations",
      HOBBY_FUNCTION_INVOCATIONS,
      "invocations",
      reason,
    ),
    unavailable(
      "blob-simple-ops",
      "Blob simple operations",
      BLOB_HOBBY_SIMPLE_OPS,
      "ops",
      reason,
    ),
    unavailable(
      "blob-advanced-ops",
      "Blob advanced operations",
      BLOB_HOBBY_ADVANCED_OPS,
      "ops",
      reason,
    ),
    unavailable("blob-team-storage", "Blob storage · rolling team average", null, "bytes", reason),
    unavailable("blob-data-transfer", "Blob Data Transfer", null, "bytes", reason),
  ];
}

/** Validate scope and observation age before trusting a fallback. */
export function parsePlatformUsageCache(text: string, teamId: string, now = new Date()): UsageMetric[] | null {
  try {
    const cached = JSON.parse(text) as PlatformUsageCache;
    const age = now.getTime() - Date.parse(cached.updatedAt);
    if (cached.version !== PLATFORM_CACHE_VERSION || cached.teamId !== teamId || !Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000 ||
        !Number.isFinite(Date.parse(cached.from)) || !Number.isFinite(Date.parse(cached.to)) ||
        Date.parse(cached.to) !== Date.parse(cached.updatedAt) ||
        Date.parse(cached.to) - Date.parse(cached.from) !== 30 * 24 * 60 * 60 * 1000 ||
        !Array.isArray(cached.metrics) || cached.metrics.length === 0 ||
        cached.metrics.some(m => !m || typeof m.available !== "boolean" || !Number.isFinite(m.used) || m.used < 0 ||
          (m.limit !== null && (!Number.isFinite(m.limit) || m.limit < 0)) || typeof m.detail !== "string" ||
          typeof m.id !== "string" || typeof m.label !== "string" || typeof m.unit !== "string")) {
      return null;
    }
    const asOf = cached.updatedAt
      ? ` · cached ${formatHumanDate(cached.updatedAt)}`
      : " · from last successful sync";
    return cached.metrics.map((m) =>
      metric({
        id: m.id,
        label: m.label,
        used: m.used,
        limit: m.limit,
        unit: m.unit,
        detail: `${m.detail}${asOf}`,
        available: m.available,
        limitBasis: m.limitBasis,
        source: "cached",
      }),
    );
  } catch {
    return null;
  }
}

async function loadPlatformUsageCache(teamId: string, now: Date): Promise<UsageMetric[] | null> {
  if (!canUseBlob()) return null;
  try {
    const text =
      (await getBlobText(PLATFORM_BLOB_PATHNAME)) ??
      (await getBlobText(LEGACY_PLATFORM_BLOB_PATHNAME));
    if (!text) return null;
    return parsePlatformUsageCache(text, teamId, now);
  } catch (error) {
    console.warn("usage: platform Blob cache load failed", error);
    return null;
  }
}

async function savePlatformUsageCache(metrics: UsageMetric[], teamId: string, window: ReturnType<typeof usageWindow>, now: Date) {
  if (!canUseBlob()) return;
  try {
    const token = blobToken();
    const payload: PlatformUsageCache = {
      version: PLATFORM_CACHE_VERSION,
      updatedAt: now.toISOString(),
      teamId,
      from: window.from,
      to: window.to,
      metrics: metrics.map((m) => ({
        id: m.id,
        label: m.label,
        used: m.used,
        limit: m.limit,
        unit: m.unit,
        detail: m.detail,
        available: m.available,
        limitBasis: m.limitBasis,
      })),
    };
    await put(PLATFORM_BLOB_PATHNAME, JSON.stringify(payload, null, 2), {
      access: getBlobAccess(),
      abortSignal: AbortSignal.timeout(10_000),
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      ...(token ? { token } : {}),
    });
  } catch (error) {
    console.warn("usage: platform Blob cache save failed", error);
  }
}

/** Each meter fails independently, preserving available readings and dated fallbacks. */
export async function collectPlatformUsage(now = new Date()): Promise<UsageMetric[]> {
  const window = usageWindow(now);
  const teamId = resolveTeamId();
  if (!teamId) return platformUnavailable("Set VERCEL_TEAM_ID or link the project");
  const definitions = [
    { id: "fast-data-transfer", label: "Fast Data Transfer", slug: "fast_data_transfer", limit: HOBBY_FAST_DATA_TRANSFER_BYTES, unit: "bytes" },
    { id: "edge-requests", label: "CDN Requests", slug: "edge_requests", limit: HOBBY_EDGE_REQUESTS, unit: "requests" },
    { id: "function-invocations", label: "Function invocations", slug: "function_invocations", limit: HOBBY_FUNCTION_INVOCATIONS, unit: "invocations" },
    { id: "blob-simple-ops", label: "Blob simple operations", slug: "blob_simple_operations", limit: BLOB_HOBBY_SIMPLE_OPS, unit: "ops" },
    { id: "blob-advanced-ops", label: "Blob advanced operations", slug: "blob_advanced_operations", limit: BLOB_HOBBY_ADVANCED_OPS, unit: "ops" },
    { id: "blob-team-storage", label: "Blob storage · rolling team average", slug: "blob_storage_size", limit: BLOB_HOBBY_STORAGE_BYTES, unit: "bytes" },
    { id: "blob-data-transfer", label: "Blob Data Transfer", slug: "blob_data_transfer", limit: BLOB_HOBBY_DATA_TRANSFER_BYTES, unit: "bytes" },
  ];
  const [readings, team] = await Promise.all([
    Promise.allSettled(definitions.map(d => fetchUsageMeter(d.slug, teamId, window))),
    vercelApiGetJson(`/v2/teams/${encodeURIComponent(teamId)}`).catch(() => null),
  ]);
  const planResult = z.object({ billing: z.object({ plan: z.string() }) }).safeParse(team);
  const plan = planResult.success ? planResult.data.billing.plan : null;
  const isHobby = plan === "hobby";
  const cached = readings.some(r => r.status === "rejected") ? await loadPlatformUsageCache(teamId, now) : null;
  const metrics = definitions.map((d, index) => {
    const result = readings[index];
    const limit = isHobby ? d.limit : null;
    if (result.status === "rejected") {
      const fallback = cached?.find(m => m.id === d.id && m.available);
      if (fallback) return { ...fallback, ...(plan ? { limit, percent: roundPercent(fallback.used, limit), limitBasis: isHobby ? "provider" as const : "unknown" as const } : {}) };
      return unavailable(d.id, d.label, limit, d.unit, "Rolling last 30 days · all projects/stores in team · metered usage unavailable");
    }
    const meter = result.value;
    const range = `${formatHumanDate(meter.from, { withTime: true })}–${formatHumanDate(meter.to, { withTime: true })}`;
    const note = d.id === "blob-team-storage" ? "; provider average over this rolling window; dashboard Latest value may differ"
      : d.id === "fast-data-transfer" ? "; CDN transfer only; origin transfer not included" : "";
    return metric({ id: d.id, label: d.label, used: meter.results.totalValue, limit, unit: d.unit,
      available: true, source: "live", limitBasis: isHobby ? "provider" : "unknown",
      detail: `${range} · rolling last 30 days, including today · all projects/stores in team · queried ${formatHumanDate(meter.queriedAt, { withTime: true })} · ${isHobby ? "Hobby included allowance" : plan ? `Plan: ${plan}; cap unverified` : "Plan unavailable; cap unverified"}${note}` });
  });
  // Never re-date cached observations after a partial outage.
  if (readings.every(r => r.status === "fulfilled")) await savePlatformUsageCache(metrics, teamId, window, now);
  return metrics;
}

/** Collect AI Gateway, Blob, platform, and Resend usage. Failures are soft. */
export async function collectUsageReport(): Promise<UsageReport> {
  const [aiGateway, blobStorage, platformMetrics, resendMetrics, rapidApi] =
    await Promise.all([
      collectAiGateway(),
      collectBlobStorage(),
      collectPlatformUsage(),
      collectResendQuota(),
      collectRapidApiUsage(),
    ]);

  const metrics = [
    aiGateway,
    ...platformMetrics,
    blobStorage,
    ...resendMetrics,
    rapidApiDailyMetric(rapidApi),
  ];
  const thresholdPercent = USAGE_WATCH_THRESHOLD;
  const watch = metrics.filter(
    (m) => m.available && m.limit != null && m.percent >= thresholdPercent,
  );

  return {
    collectedAt: new Date().toISOString(),
    thresholdPercent,
    metrics,
    watch,
    rapidApi,
  };
}
