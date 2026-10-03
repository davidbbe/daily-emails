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
  /** Unverified plan limits must never be presented as provider caps. */
  limitBasis?: "provider" | "budget" | "unknown";
  source?: "live" | "cached";
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
      limitBasis: "unknown",
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

function usageWindow(now = new Date()) {
  const midnight = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const to = new Date(midnight.getTime() - 1);
  const from = new Date(midnight.getTime() - 30 * 24 * 60 * 60 * 1000);
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

async function fetchUsageType(type: string, teamId: string, window: ReturnType<typeof usageWindow>): Promise<UsageApiResponse> {
  if (!teamId) {
    throw new Error(
      "Set VERCEL_TEAM_ID (or link the project so .vercel/project.json has orgId)",
    );
  }
  const { from, to } = window;
  const qs = new URLSearchParams({
    teamId,
    type,
    from,
    to,
  });
  const result = await vercelApiGetJson(`/v2/usage?${qs.toString()}`);
  const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())), lastUpdate: z.string().optional() }).safeParse(result);
  if (!parsed.success) throw new Error(`Invalid Vercel ${type} response; usage unavailable`);
  const dates = new Set<string>();
  const data = parsed.data.data.filter(day => {
    if (typeof day.date !== "string" || !Number.isFinite(Date.parse(day.date))) throw new Error("Invalid Vercel usage date");
    const date = day.date.slice(0, 10);
    if (date < from.slice(0, 10) || date > to.slice(0, 10)) return false;
    if (dates.has(date)) throw new Error("Duplicate Vercel daily bucket");
    dates.add(date);
    return true;
  });
  if (dates.size !== 30) throw new Error("Vercel returned incomplete daily buckets");
  return { ...parsed.data, data };
}

function sumField(days: UsageApiDay[], field: keyof UsageApiDay) {
  if (days.length === 0) return null;
  let total = 0;
  for (const day of days) {
    const value = day[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}

const PLATFORM_BLOB_PATHNAME = "daily-emails/platform-usage.json";
/** Pre-rename path — read fallback until the next successful save. */
const LEGACY_PLATFORM_BLOB_PATHNAME = "agent-dave/platform-usage.json";

type PlatformUsageCache = {
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
  ];
}

/** Validate scope and observation age before trusting a fallback. */
export function parsePlatformUsageCache(text: string, teamId: string, now = new Date()): UsageMetric[] | null {
  try {
    const cached = JSON.parse(text) as PlatformUsageCache;
    const age = now.getTime() - Date.parse(cached.updatedAt);
    if (cached.teamId !== teamId || !Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000 ||
        !Number.isFinite(Date.parse(cached.from)) || !Number.isFinite(Date.parse(cached.to)) || Date.parse(cached.to) > Date.parse(cached.updatedAt) ||
        Date.parse(cached.from) >= Date.parse(cached.to) ||
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

/** Independent endpoint failures retain the other live readings. */
export async function collectPlatformUsage(now = new Date()): Promise<UsageMetric[]> {
  const window = usageWindow(now);
  const teamId = resolveTeamId();
  if (!teamId) return platformUnavailable("Set VERCEL_TEAM_ID or link the project");
  const [requests, blob, team] = await Promise.allSettled([
    fetchUsageType("requests", teamId, window),
    fetchUsageType("storage_blob", teamId, window),
    vercelApiGetJson(`/v2/teams/${encodeURIComponent(teamId)}`),
  ]);
  const planResult = team.status === "fulfilled"
    ? z.object({ billing: z.object({ plan: z.string() }) }).safeParse(team.value)
    : null;
  const plan = planResult?.success ? planResult.data.billing.plan : null;
  const isHobby = plan === "hobby";
  const range = `${window.from.slice(0, 10)}–${window.to.slice(0, 10)} UTC · last 30 complete days · all projects in team`;
  const cached = requests.status === "rejected" || blob.status === "rejected"
    ? await loadPlatformUsageCache(teamId, now) : null;
  function reading(id: string, label: string, fields: string[], referenceLimit: number, unit: string,
    result: PromiseSettledResult<UsageApiResponse>): UsageMetric {
    const limit = isHobby ? referenceLimit : null;
    if (result.status === "rejected") {
      const fallback = cached?.find(m => m.id === id);
      if (fallback) return { ...fallback, ...(plan ? {limit, percent:roundPercent(fallback.used,limit),limitBasis:isHobby ? "provider" as const : "unknown" as const} : {}) };
      return unavailable(id, label, limit, unit, `${range} · source unavailable`);
    }
    const totals = fields.map(field => sumField(result.value.data ?? [], field));
    if (totals.some(value => value === null)) {
      return unavailable(id, label, limit, unit, `${range} · API omitted or returned invalid counters; no verified total`);
    }
    const used = totals.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const updated = result.value.lastUpdate;
    const asOf = updated && Number.isFinite(Date.parse(updated))
      ? `provider updated ${new Date(updated).toISOString()}` : "provider update time unavailable";
    return metric({ id, label, used, limit, unit, available:true, source:"live",
      limitBasis:isHobby ? "provider" : "unknown",
      detail:`${range} · ${asOf} · ${isHobby ? "Hobby included allowance" : plan ? `Plan: ${plan}; cap unverified` : "Plan unavailable; cap unverified"}${id === "fast-data-transfer" ? "; CDN transfer only; origin transfer not included" : ""}` });
  }
  const metrics = [
    reading("fast-data-transfer", "Fast Data Transfer", ["bandwidth_incoming_bytes", "bandwidth_outgoing_bytes"], HOBBY_FAST_DATA_TRANSFER_BYTES,"bytes",requests),
    reading("edge-requests", "CDN Requests", ["request_hit_count", "request_miss_count"], HOBBY_EDGE_REQUESTS,"requests",requests),
    reading("function-invocations", "Function invocations", ["function_invocation_successful_count", "function_invocation_error_count", "function_invocation_timeout_count", "function_invocation_throttle_count"], HOBBY_FUNCTION_INVOCATIONS,"invocations",requests),
    reading("blob-simple-ops", "Blob simple operations", ["blob_simple_request_count"], BLOB_HOBBY_SIMPLE_OPS,"ops",blob),
    reading("blob-advanced-ops", "Blob advanced operations", ["blob_advanced_request_count"], BLOB_HOBBY_ADVANCED_OPS,"ops",blob),
  ];
  // Never re-date a cached observation after a failed fetch.
  if (requests.status === "fulfilled" && blob.status === "fulfilled") {
    await savePlatformUsageCache(metrics, teamId, window, now);
  }
  return metrics;
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
