import { get, list, put } from "@vercel/blob";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { gateway } from "ai";
import {
  AI_GATEWAY_MONTHLY_BUDGET_USD,
  BLOB_HOBBY_ADVANCED_OPS,
  BLOB_HOBBY_SIMPLE_OPS,
  BLOB_HOBBY_STORAGE_BYTES,
  HOBBY_FAST_ORIGIN_TRANSFER_BYTES,
  HOBBY_FUNCTION_INVOCATIONS,
  RESEND_DAILY_LIMIT,
  RESEND_MONTHLY_LIMIT,
  USAGE_WATCH_THRESHOLD,
} from "@/lib/config";
import { formatHumanDate } from "@/lib/dates";

export type UsageMetric = {
  id: string;
  label: string;
  /** Amount consumed toward the limit */
  used: number;
  limit: number;
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

function resendDailyLimit() {
  return envNumber("RESEND_DAILY_LIMIT", RESEND_DAILY_LIMIT);
}

function resendMonthlyLimit() {
  return envNumber("RESEND_MONTHLY_LIMIT", RESEND_MONTHLY_LIMIT);
}

function roundPercent(used: number, limit: number) {
  if (limit <= 0) return 0;
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
  limit: number,
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function collectAiGateway(): Promise<UsageMetric> {
  const budget = gatewayBudgetUsd();
  try {
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

function headerNumber(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

type ResendQuotaCache = {
  updatedAt: string;
  dailyUsed: number | null;
  monthlyUsed: number | null;
};

const RESEND_CACHE_PATH = path.join(
  process.cwd(),
  ".data",
  "resend-usage.json",
);
const RESEND_BLOB_PATHNAME = "agent-dave/resend-usage.json";

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
  dailyUsed: number | null,
  monthlyUsed: number | null,
  source: "live" | "last-send",
): UsageMetric[] {
  const dailyLimit = resendDailyLimit();
  const monthlyLimit = resendMonthlyLimit();
  const sourceNote =
    source === "last-send" ? " · as of last send (send-only API key)" : "";
  const metrics: UsageMetric[] = [];

  if (dailyUsed != null) {
    metrics.push(
      metric({
        id: "resend-daily",
        label: "Resend daily emails",
        used: dailyUsed,
        limit: dailyLimit,
        unit: "emails",
        detail: `${dailyUsed} / ${dailyLimit} emails today (free plan)${sourceNote}`,
        available: true,
      }),
    );
  } else {
    metrics.push(
      unavailable(
        "resend-daily",
        "Resend daily emails",
        dailyLimit,
        "emails",
        "Daily quota header not returned (paid plan or unavailable)",
      ),
    );
  }

  if (monthlyUsed != null) {
    metrics.push(
      metric({
        id: "resend-monthly",
        label: "Resend monthly emails",
        used: monthlyUsed,
        limit: monthlyLimit,
        unit: "emails",
        detail: `${monthlyUsed} / ${monthlyLimit} emails this month${sourceNote}`,
        available: true,
      }),
    );
  } else {
    metrics.push(
      unavailable(
        "resend-monthly",
        "Resend monthly emails",
        monthlyLimit,
        "emails",
        "Monthly quota header not returned",
      ),
    );
  }

  return metrics;
}

function parseResendCache(text: string): ResendQuotaCache | null {
  try {
    const cached = JSON.parse(text) as ResendQuotaCache;
    if (cached.dailyUsed == null && cached.monthlyUsed == null) return null;
    return cached;
  } catch {
    return null;
  }
}

async function loadResendCacheFromBlob(): Promise<ResendQuotaCache | null> {
  if (!canUseBlob()) return null;
  try {
    const token = blobToken();
    // Store is public (private access is rejected by the Blob API).
    const result = await get(RESEND_BLOB_PATHNAME, {
      access: "public",
      useCache: false,
      ...(token ? { token } : {}),
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return parseResendCache(await streamToText(result.stream));
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

async function loadCachedResendQuota(): Promise<UsageMetric[] | null> {
  const cached =
    (await loadResendCacheFromBlob()) ??
    (isVercelRuntime() ? null : await loadResendCacheFromLocal());
  if (!cached) return null;
  return buildResendMetrics(cached.dailyUsed, cached.monthlyUsed, "last-send");
}

async function saveResendCache(payload: ResendQuotaCache) {
  const body = JSON.stringify(payload, null, 2);

  if (canUseBlob()) {
    try {
      const token = blobToken();
      await put(RESEND_BLOB_PATHNAME, body, {
        access: "public",
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
      "usage: Blob not configured; Resend quotas cannot persist across cron runs with a send-only API key",
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

/** Persist quota headers from a Resend send response (works with send-only API keys). */
export async function persistResendQuotaFromHeaders(headers: Headers) {
  const dailyUsed = headerNumber(headers, "x-resend-daily-quota");
  const monthlyUsed = headerNumber(headers, "x-resend-monthly-quota");
  if (dailyUsed == null && monthlyUsed == null) return;

  await saveResendCache({
    updatedAt: new Date().toISOString(),
    dailyUsed,
    monthlyUsed,
  });
}

function resendUnavailableReason(status: number, body: string) {
  if (status === 401 && body.includes("restricted_api_key")) {
    return "Send-only Resend API key — quotas appear after the next send (cached in Blob)";
  }
  return `Resend API ${status}${body ? `: ${body.slice(0, 120)}` : ""}`;
}

/** Lightweight Resend API call to read quota headers (does not send mail). */
async function collectResendQuota(): Promise<UsageMetric[]> {
  const dailyLimit = resendDailyLimit();
  const monthlyLimit = resendMonthlyLimit();
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return [
      unavailable(
        "resend-daily",
        "Resend daily emails",
        dailyLimit,
        "emails",
        "RESEND_API_KEY not set",
      ),
      unavailable(
        "resend-monthly",
        "Resend monthly emails",
        monthlyLimit,
        "emails",
        "RESEND_API_KEY not set",
      ),
    ];
  }

  // Prefer durable last-send cache first — send-only keys cannot GET /emails,
  // and serverless FS does not keep the local fallback between cron runs.
  const cached = await loadCachedResendQuota();

  try {
    const response = await fetch("https://api.resend.com/emails?limit=1", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      if (cached) return cached;
      const body = await response.text().catch(() => "");
      const reason = resendUnavailableReason(response.status, body);
      return [
        unavailable(
          "resend-daily",
          "Resend daily emails",
          dailyLimit,
          "emails",
          reason,
        ),
        unavailable(
          "resend-monthly",
          "Resend monthly emails",
          monthlyLimit,
          "emails",
          reason,
        ),
      ];
    }

    const live = buildResendMetrics(
      headerNumber(response.headers, "x-resend-daily-quota"),
      headerNumber(response.headers, "x-resend-monthly-quota"),
      "live",
    );
    // Keep Blob/local cache warm when a full-access key returns quotas live.
    const dailyUsed = headerNumber(response.headers, "x-resend-daily-quota");
    const monthlyUsed = headerNumber(response.headers, "x-resend-monthly-quota");
    if (dailyUsed != null || monthlyUsed != null) {
      void saveResendCache({
        updatedAt: new Date().toISOString(),
        dailyUsed,
        monthlyUsed,
      });
    }
    return live;
  } catch (error) {
    if (cached) return cached;

    const message =
      error instanceof Error ? error.message : "Resend probe failed";
    console.warn("usage: Resend quota failed", error);
    return [
      unavailable(
        "resend-daily",
        "Resend daily emails",
        dailyLimit,
        "emails",
        message,
      ),
      unavailable(
        "resend-monthly",
        "Resend monthly emails",
        monthlyLimit,
        "emails",
        message,
      ),
    ];
  }
}

export function formatMetricUsed(m: UsageMetric) {
  if (!m.available) return "n/a";
  if (m.unit === "USD") return formatUsd(m.used);
  if (m.unit === "bytes") return formatBytes(m.used);
  return `${m.used.toLocaleString("en-US")} ${m.unit}`;
}

export function formatMetricLimit(m: UsageMetric) {
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
      { stdio: ["ignore", "pipe", "pipe"] },
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

const PLATFORM_BLOB_PATHNAME = "agent-dave/platform-usage.json";

type PlatformUsageCache = {
  updatedAt: string;
  metrics: Array<{
    id: string;
    label: string;
    used: number;
    limit: number;
    unit: string;
    detail: string;
  }>;
};

function platformUnavailable(reason: string): UsageMetric[] {
  return [
    unavailable(
      "fast-origin-transfer",
      "Fast Origin Transfer",
      HOBBY_FAST_ORIGIN_TRANSFER_BYTES,
      "bytes",
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
    const token = blobToken();
    const result = await get(PLATFORM_BLOB_PATHNAME, {
      access: "public",
      useCache: false,
      ...(token ? { token } : {}),
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const cached = JSON.parse(
      await streamToText(result.stream),
    ) as PlatformUsageCache;
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
      access: "public",
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
    const transferBytes = incoming + outgoing;

    const invocations =
      sumField(requestDays, "function_invocation_successful_count") +
      sumField(requestDays, "function_invocation_error_count") +
      sumField(requestDays, "function_invocation_timeout_count") +
      sumField(requestDays, "function_invocation_throttle_count");

    const simpleOps = sumField(blobDays, "blob_simple_request_count");
    const advancedOps = sumField(blobDays, "blob_advanced_request_count");

    const metrics = [
      metric({
        id: "fast-origin-transfer",
        label: "Fast Origin Transfer",
        used: transferBytes,
        limit: HOBBY_FAST_ORIGIN_TRANSFER_BYTES,
        unit: "bytes",
        detail: `${formatBytes(transferBytes)} / ${formatBytes(HOBBY_FAST_ORIGIN_TRANSFER_BYTES)} · ${label} (Hobby included)${requests.lastUpdate ? ` · updated ${formatHumanDate(requests.lastUpdate)}` : ""}`,
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
    (m) => m.available && m.percent >= thresholdPercent,
  );

  return {
    collectedAt: new Date().toISOString(),
    thresholdPercent,
    metrics,
    watch,
  };
}
