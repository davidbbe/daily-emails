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
  BLOB_HOBBY_SIMPLE_OPS,
  BLOB_HOBBY_STORAGE_BYTES,
  HOBBY_EDGE_REQUESTS,
  HOBBY_FAST_DATA_TRANSFER_BYTES,
  HOBBY_FUNCTION_INVOCATIONS,
  USAGE_WATCH_THRESHOLD,
  getBlobAccess,
} from "@/lib/config";
import { formatHumanDate } from "@/lib/dates";

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
};

export type UsageReport = {
  collectedAt: string;
  thresholdPercent: number;
  metrics: UsageMetric[];
  /** Metrics at or above the watch threshold */
  watch: UsageMetric[];
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
  return { ...partial, percent };
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

async function collectAiGateway(): Promise<UsageMetric> {
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
    const credits = await gateway.getCredits();
    const balance = Number.parseFloat(credits.balance);
    const totalUsed = Number.parseFloat(credits.totalUsed);

    if (!Number.isFinite(balance) || !Number.isFinite(totalUsed)) {
      return unavailable(
        "ai-gateway",
        "AI Gateway credits",
        budget,
        "USD",
        "Could not parse Gateway credit response",
      );
    }

    // Free monthly pool: used ≈ budget − remaining. Purchased credits
    // (balance > budget) mean the free allowance is not under pressure.
    const usedTowardBudget =
      balance >= budget ? 0 : Math.max(0, budget - balance);

    return metric({
      id: "ai-gateway",
      label: "AI Gateway credits",
      used: usedTowardBudget,
      limit: budget,
      unit: "USD",
      detail: `${formatUsd(balance)} remaining · ${formatUsd(totalUsed)} lifetime used · ${formatUsd(budget)}/mo free budget`,
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
  const limit = BLOB_HOBBY_STORAGE_BYTES;
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

    do {
      // Pass token explicitly — with BLOB_STORE_ID set locally, the SDK can
      // prefer store/OIDC auth and fail without VERCEL_OIDC_TOKEN.
      const page = await list({
        cursor,
        limit: 1000,
        abortSignal: AbortSignal.timeout(10_000),
        ...(token ? { token } : {}),
      });
      for (const blob of page.blobs) {
        totalBytes += blob.size;
        blobCount += 1;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return metric({
      id: "blob-storage",
      label: "Blob storage",
      used: totalBytes,
      limit,
      unit: "bytes",
      detail: `${formatBytes(totalBytes)} across ${blobCount} object${blobCount === 1 ? "" : "s"} · Hobby included ${formatBytes(limit)}`,
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
      detail: `${amount} (sent + received) · ${observation} · resets ${formatHumanDate(counter.resets_at)} · collected before this digest's send`,
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

/** Read-only account usage, supported by sending-only keys too. */
export async function collectResendQuota(now?: Date): Promise<UsageMetric[]> {
  const unavailableMetrics = (reason: string) => (["daily", "monthly"] as const).map(
    (period) => unavailable(`resend-${period}`, `Resend ${period} emails`, null, "emails", reason),
  );
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return unavailableMetrics("RESEND_API_KEY not set");

  try {
    const response = await fetch("https://api.resend.com/usage", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend usage API ${response.status}`);
    const result = resendUsageSchema.safeParse(await response.json());
    if (!result.success) throw new Error("Resend usage API returned invalid counters, limits, or reset times");
    const observedAt = now ?? new Date();
    const cache: ResendQuotaCache = { updatedAt: observedAt.toISOString(), ...result.data.emails };
    const metrics = buildResendMetrics(cache, "live", observedAt);
    // A cache failure must not discard valid live readings.
    await saveResendCache(cache).catch((error) => console.warn("usage: Resend cache save failed", error));
    return metrics;
  } catch (error) {
    const cached = await loadCachedResendQuota(now);
    if (cached) return cached;
    const message = error instanceof Error ? error.message : "Resend usage unavailable";
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

type UsageApiDay = Record<string, unknown> & {
  date?: string;
  bandwidth_incoming_bytes?: number;
  bandwidth_outgoing_bytes?: number;
  function_invocation_successful_count?: number;
  function_invocation_error_count?: number;
  function_invocation_timeout_count?: number;
  function_invocation_throttle_count?: number;
  blob_simple_request_count?: number;
  blob_advanced_request_count?: number;
};

type UsageApiResponse = {
  data?: UsageApiDay[];
  lastUpdate?: string;
};

function usageWindow() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label: "last 30 days",
  };
}

async function vercelApiGetJson(apiPath: string): Promise<unknown> {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (token) {
    const response = await fetch(`https://api.vercel.com${apiPath}`, {
      headers: { Authorization: `Bearer ${token}` },
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
      ["api", apiPath, "--raw"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
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

async function fetchUsageType(type: string): Promise<UsageApiResponse> {
  const teamId = resolveTeamId();
  if (!teamId) {
    throw new Error(
      "Set VERCEL_TEAM_ID (or link the project so .vercel/project.json has orgId)",
    );
  }
  const { from, to } = usageWindow();
  const qs = new URLSearchParams({
    teamId,
    type,
    from,
    to,
  });
  return (await vercelApiGetJson(`/v2/usage?${qs.toString()}`)) as UsageApiResponse;
}

function sumField(days: UsageApiDay[], field: keyof UsageApiDay) {
  let total = 0;
  for (const day of days) {
    const value = day[field];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

const PLATFORM_BLOB_PATHNAME = "daily-emails/platform-usage.json";
/** Pre-rename path — read fallback until the next successful save. */
const LEGACY_PLATFORM_BLOB_PATHNAME = "agent-dave/platform-usage.json";

type PlatformUsageCache = {
  updatedAt: string;
  metrics: Array<{
    id: string;
    label: string;
    used: number;
    limit: number | null;
    unit: string;
    detail: string;
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
  ];
}

async function loadPlatformUsageCache(): Promise<UsageMetric[] | null> {
  if (!canUseBlob()) return null;
  try {
    const text =
      (await getBlobText(PLATFORM_BLOB_PATHNAME)) ??
      (await getBlobText(LEGACY_PLATFORM_BLOB_PATHNAME));
    if (!text) return null;
    const cached = JSON.parse(text) as PlatformUsageCache;
    if (!Array.isArray(cached.metrics) || cached.metrics.length === 0) {
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
        available: true,
      }),
    );
  } catch (error) {
    console.warn("usage: platform Blob cache load failed", error);
    return null;
  }
}

async function savePlatformUsageCache(metrics: UsageMetric[]) {
  if (!canUseBlob()) return;
  try {
    const token = blobToken();
    const payload: PlatformUsageCache = {
      updatedAt: new Date().toISOString(),
      metrics: metrics.map((m) => ({
        id: m.id,
        label: m.label,
        used: m.used,
        limit: m.limit,
        unit: m.unit,
        detail: m.detail,
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

/** Hobby platform quotas from GET /v2/usage (works without Observability Plus). */
async function collectPlatformUsage(): Promise<UsageMetric[]> {
  const { label } = usageWindow();

  try {
    const [requests, blob] = await Promise.all([
      fetchUsageType("requests"),
      fetchUsageType("storage_blob"),
    ]);

    const requestDays = requests.data ?? [];
    const blobDays = blob.data ?? [];

    const incoming = sumField(requestDays, "bandwidth_incoming_bytes");
    const outgoing = sumField(requestDays, "bandwidth_outgoing_bytes");
    // /v2/usage `bandwidth_*` is Fast Data Transfer (CDN ↔ visitor), not
    // Fast Origin Transfer. Hobby's /v2/usage types do not expose FOT.
    const transferBytes = incoming + outgoing;
    const edgeRequests =
      sumField(requestDays, "request_hit_count") +
      sumField(requestDays, "request_miss_count");

    const invocations =
      sumField(requestDays, "function_invocation_successful_count") +
      sumField(requestDays, "function_invocation_error_count") +
      sumField(requestDays, "function_invocation_timeout_count") +
      sumField(requestDays, "function_invocation_throttle_count");

    const simpleOps = sumField(blobDays, "blob_simple_request_count");
    const advancedOps = sumField(blobDays, "blob_advanced_request_count");
    const updatedNote = requests.lastUpdate
      ? ` · updated ${formatHumanDate(requests.lastUpdate)}`
      : "";

    const metrics = [
      metric({
        id: "fast-data-transfer",
        label: "Fast Data Transfer",
        used: transferBytes,
        limit: HOBBY_FAST_DATA_TRANSFER_BYTES,
        unit: "bytes",
        detail: `${formatBytes(outgoing)} out + ${formatBytes(incoming)} in · ${label} (Hobby 100 GB). Origin transfer is not in this API${updatedNote}`,
        available: true,
      }),
      metric({
        id: "edge-requests",
        label: "Edge Requests",
        used: edgeRequests,
        limit: HOBBY_EDGE_REQUESTS,
        unit: "requests",
        detail: `${edgeRequests.toLocaleString("en-US")} / ${HOBBY_EDGE_REQUESTS.toLocaleString("en-US")} · ${label}`,
        available: true,
      }),
      metric({
        id: "function-invocations",
        label: "Function invocations",
        used: invocations,
        limit: HOBBY_FUNCTION_INVOCATIONS,
        unit: "invocations",
        detail: `${invocations.toLocaleString("en-US")} / ${HOBBY_FUNCTION_INVOCATIONS.toLocaleString("en-US")} · ${label}`,
        available: true,
      }),
      metric({
        id: "blob-simple-ops",
        label: "Blob simple operations",
        used: simpleOps,
        limit: BLOB_HOBBY_SIMPLE_OPS,
        unit: "ops",
        detail: `${simpleOps.toLocaleString("en-US")} / ${BLOB_HOBBY_SIMPLE_OPS.toLocaleString("en-US")} · ${label}`,
        available: true,
      }),
      metric({
        id: "blob-advanced-ops",
        label: "Blob advanced operations",
        used: advancedOps,
        limit: BLOB_HOBBY_ADVANCED_OPS,
        unit: "ops",
        detail: `${advancedOps.toLocaleString("en-US")} / ${BLOB_HOBBY_ADVANCED_OPS.toLocaleString("en-US")} · ${label}`,
        available: true,
      }),
    ];

    // Durable cache so Vercel cron can show last sync when VERCEL_TOKEN is unset.
    await savePlatformUsageCache(metrics);
    return metrics;
  } catch (error) {
    const cached = await loadPlatformUsageCache();
    if (cached) {
      console.warn(
        "usage: platform usage live fetch failed; using Blob cache",
        error,
      );
      return cached;
    }

    const message =
      error instanceof Error ? error.message : "Platform usage unavailable";
    console.warn("usage: platform usage failed", error);
    return platformUnavailable(message);
  }
}

/** Collect AI Gateway, Blob, platform, and Resend usage. Failures are soft. */
export async function collectUsageReport(): Promise<UsageReport> {
  const [aiGateway, blobStorage, platformMetrics, resendMetrics] =
    await Promise.all([
      collectAiGateway(),
      collectBlobStorage(),
      collectPlatformUsage(),
      collectResendQuota(),
    ]);

  const metrics = [
    aiGateway,
    ...platformMetrics,
    blobStorage,
    ...resendMetrics,
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
  };
}
