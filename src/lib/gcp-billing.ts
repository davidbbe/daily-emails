import {
  GCP_BILLING_ACCOUNT,
  type GcpBillingAccountConfig,
} from "@/lib/config";
import {
  getGoogleAccessToken,
  getGoogleCloudProjectId,
  getServiceAccountCredentials,
} from "@/lib/google-auth";

const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";

const SERVICE_STYLES: Array<{
  match?: RegExp;
  color: string;
  marker: "circle" | "square";
}> = [
  { match: /places api/i, color: "#4185f4", marker: "circle" },
  { match: /gemini/i, color: "#ff5620", marker: "square" },
  { color: "#34a853", marker: "circle" },
  { color: "#a142f4", marker: "square" },
  { color: "#f9ab00", marker: "circle" },
  { color: "#00acc1", marker: "square" },
];

export type GcpBillingSkuUnit = "calls" | "tokens";

export type GcpBillingSku = {
  name: string;
  quantity: number;
  unit: GcpBillingSkuUnit;
  /** Per-SKU monthly free events, when known (Places Enterprise is 1,000). */
  freeMonthly?: number;
};

export type GcpBillingApiUsage = {
  name: string;
  color: string;
  marker: "circle" | "square";
  /** Month-to-date request-like SKUs (excludes token counts). */
  calls: number | null;
  skus: GcpBillingSku[];
};

export type GcpBillingService = {
  name: string;
  color: string;
  marker: "circle" | "square";
  usageCost: number;
  previousCost: number | null;
  /** Month-to-date request-like SKUs (from the 1st), not the cost chart window. */
  calls: number | null;
  /** Largest project contributor when known */
  projectHint?: string;
};

export type GcpBillingDay = {
  date: string;
  /** Service display name → USD for that UTC day */
  costs: Record<string, number>;
};

export type GcpBillingReport = {
  accountId: string;
  accountLabel: string;
  reportsUrl: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  currency: "USD";
  total: number;
  previousTotal: number;
  savings: number;
  services: GcpBillingService[];
  /**
   * SKU-level API usage for the current calendar month (from the 1st),
   * independent of the cost chart window. Free-tier SKUs reset monthly.
   */
  apiUsage: GcpBillingApiUsage[];
  apiUsageStartDate: string;
  apiUsageEndDate: string;
  days: GcpBillingDay[];
  insight?: string;
  /** Provisional status, date basis, and export coverage. */
  freshnessNote?: string;
  period: "month_to_date" | "latest_month" | "trailing";
  source: "bigquery";
  /** Latest export append, distinct from the date of the usage. */
  exportedAt?: string;
  latestUsageDate?: string;
  comparisonAvailable?: boolean;
  error?: string;
};

export type GcpBillingPeriod = GcpBillingReport["period"];

export type GcpBillingWindow = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  year: number;
  monthIndex: number;
  period: GcpBillingPeriod;
};

export type GcpBillingRow = {
  day: string;
  service: string;
  sku?: string;
  project: string;
  usageCost: number;
  credits: number;
  usageAmount?: number;
  usageUnit?: string;
  exportedAt?: string;
};

/** Length used by legacy saved trailing-window reports. */
export const TRAILING_BILLING_DAYS = 30;

type BqJobResponse = {
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  jobComplete?: boolean;
  pageToken?: string;
  totalRows?: string;
  rows?: Array<{ f?: Array<{ v?: string | null }> }>;
  schema?: { fields?: Array<{ name?: string }> };
  errorResult?: { message?: string };
  errors?: Array<{ message?: string }>;
};

function billingAccount(): GcpBillingAccountConfig {
  const id =
    process.env.GCP_BILLING_ACCOUNT_ID?.trim() || GCP_BILLING_ACCOUNT.id;
  return {
    ...GCP_BILLING_ACCOUNT,
    id,
    reportsUrl: reportsUrlFor(id, "month_to_date"),
  };
}

function reportsUrlFor(
  accountId: string,
  period: GcpBillingWindow["period"],
) {
  const range =
    period === "latest_month"
      ? "LAST_MONTH"
      : period === "trailing"
        ? "LAST_30_DAYS"
        : "THIS_MONTH";
  return `https://console.cloud.google.com/billing/${accountId}/reports;timeRange=${range}`;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function isoDate(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function daysInUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Current UTC month through yesterday (today if it is the 1st).
 * Comparison window is the same day-of-month range last month.
 */
export function currentMonthToDate(now = new Date()): GcpBillingWindow {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const today = now.getUTCDate();
  const endDay = today <= 1 ? 1 : today - 1;
  return windowThroughDay(year, monthIndex, endDay, now);
}

/** First of the month three months ago through yesterday — enough for MoM + trailing 30. */
export function lookbackRange(now = new Date()) {
  const mtd = currentMonthToDate(now);
  const start = new Date(Date.UTC(mtd.year, mtd.monthIndex - 3, 1));
  return {
    startDate: isoDate(start.getUTCFullYear(), start.getUTCMonth(), 1),
    endDate: mtd.endDate,
  };
}

function windowThroughDay(
  year: number,
  monthIndex: number,
  endDay: number,
  now: Date,
): GcpBillingWindow {
  const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
  const py = prev.getUTCFullYear();
  const pm = prev.getUTCMonth();
  const previousEndDay = Math.min(endDay, daysInUtcMonth(py, pm));
  const inCurrentMonth =
    year === now.getUTCFullYear() && monthIndex === now.getUTCMonth();
  return {
    startDate: isoDate(year, monthIndex, 1),
    endDate: isoDate(year, monthIndex, endDay),
    previousStartDate: isoDate(py, pm, 1),
    previousEndDate: isoDate(py, pm, previousEndDay),
    year,
    monthIndex,
    period: inCurrentMonth ? "month_to_date" : "latest_month",
  };
}

/** Calendar month that contains `spendDay`, through that day, vs the same days prior month. */
export function windowFromSpendDate(
  spendDay: string,
  now = new Date(),
): GcpBillingWindow {
  const end = new Date(`${spendDay}T12:00:00.000Z`);
  if (Number.isNaN(end.getTime())) {
    return currentMonthToDate(now);
  }
  return windowThroughDay(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
    now,
  );
}

function shiftIsoDate(iso: string, deltaDays: number) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `dayCount` days ending on `endDate`, vs the equal-length window before that. */
export function trailingWindow(
  endDate: string,
  dayCount = TRAILING_BILLING_DAYS,
  now = new Date(),
): GcpBillingWindow {
  const end = new Date(`${endDate}T12:00:00.000Z`);
  if (Number.isNaN(end.getTime()) || dayCount < 1) {
    return currentMonthToDate(now);
  }
  const startDate = shiftIsoDate(endDate, -(dayCount - 1));
  const previousEndDate = shiftIsoDate(startDate, -1);
  const previousStartDate = shiftIsoDate(previousEndDate, -(dayCount - 1));
  return {
    startDate,
    endDate,
    previousStartDate,
    previousEndDate,
    year: end.getUTCFullYear(),
    monthIndex: end.getUTCMonth(),
    period: "trailing",
  };
}

export function resolveBillingWindow(
  rows: GcpBillingRow[],
  now = new Date(),
): GcpBillingWindow {
  // A free day is still a reporting day. Keep MTD stable; spend is not
  // evidence of export freshness or a reason to change the reporting period.
  void rows;
  return currentMonthToDate(now);
}

function eachUtcDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function styleForService(name: string, index: number) {
  const named = SERVICE_STYLES.find((s) => s.match?.test(name));
  if (named) return { color: named.color, marker: named.marker };
  const fallback =
    SERVICE_STYLES.filter((s) => !s.match)[index] ??
    SERVICE_STYLES[SERVICE_STYLES.length - 1]!;
  return { color: fallback.color, marker: fallback.marker };
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

export function percentChange(
  current: number,
  previous: number | null,
): number | null {
  if (previous == null || previous === 0) {
    return current === 0 ? 0 : null;
  }
  return ((current - previous) / previous) * 100;
}

export function formatUsd(value: number) {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function formatChangePercent(delta: number | null): string {
  if (delta === null) return "New";
  const rounded = Math.round(delta * 100) / 100;
  if (rounded === 0) return "0%";
  const body =
    Math.abs(rounded) >= 10
      ? rounded.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : rounded.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
  return `${rounded > 0 ? "+" : ""}${body}%`;
}

export function formatHeroChangePercent(delta: number) {
  const rounded = Math.round(delta * 100) / 100;
  if (rounded === 0) return "0.00%";
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function formatCallCount(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

export function formatSkuUsage(
  quantity: number,
  unit: GcpBillingSkuUnit,
  freeMonthly?: number,
) {
  const n = formatCallCount(quantity);
  if (unit === "tokens") return `${n} tokens`;
  if (freeMonthly) return `${n} / ${formatCallCount(freeMonthly)} free events`;
  return `${n} billed events`;
}

function humanizeModelName(raw: string) {
  return raw
    .split(/\s+/)
    .map((part) => {
      if (/^[0-9.]+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Short label for a Cloud Billing SKU (Places Nearby Search, Gemini tokens, …). */
export function displaySkuName(service: string, sku: string): string {
  let name = sku.trim();
  const prefixes = [
    service,
    "Places API (New)",
    "Places API",
    "Maps API",
    "Gemini API",
    "Cloud Logging",
    "BigQuery",
  ].sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      name = name.slice(prefix.length).replace(/^[\s:_-]+/, "");
      break;
    }
  }

  name = name.replace(/\s+-\s+Predictions$/i, "").trim();
  name = name.replace(/^Generate_content\s+/i, "");

  const token = name.match(/^text (input|output) token count for (.+)$/i);
  if (token) {
    const model = humanizeModelName(
      token[2]!.replace(/\s+short$/i, "").trim(),
    );
    return `${model} · ${token[1]!.toLowerCase()} tokens`;
  }

  const geminiImage = name.match(
    /^(Gemini .+? Image)\s+(Image|Text)\s+(Input|Output)$/i,
  );
  if (geminiImage) {
    return `${geminiImage[1]} · ${geminiImage[2]!.toLowerCase()} ${geminiImage[3]!.toLowerCase()}`;
  }

  return name.replace(/\s+/g, " ").trim() || sku.trim();
}

export function skuUsageUnit(
  sku: string,
  usageUnit: string,
): GcpBillingSkuUnit | null {
  if (/byte/i.test(usageUnit)) return null;
  if (/token/i.test(sku)) return "tokens";
  if (/gemini|generate_content/i.test(sku) && /input|output/i.test(sku)) return "tokens";
  if (/request|count/i.test(usageUnit)) return "calls";
  return null;
}

/**
 * Google Maps Platform free monthly events by SKU category (resets on the 1st).
 * Enterprise / Place Photos = 1,000; Pro = 5,000; Essentials = 10,000.
 */
export function skuFreeMonthlyCap(sku: string): number | null {
  const s = sku.toLowerCase();
  if (/photo/.test(s)) return 1000;
  if (/enterprise/.test(s)) return 1000;
  if (/\bpro\b/.test(s)) return 5000;
  if (/autocomplete requests/.test(s)) return 10_000;
  if (/dynamic maps/.test(s)) return 10_000;
  if (/essentials/.test(s)) return 10_000;
  return null;
}

function buildInsight(services: GcpBillingService[]): string | undefined {
  const newest = services
    .filter((s) => s.previousCost == null && s.usageCost > 0)
    .sort((a, b) => b.usageCost - a.usageCost)[0];
  if (newest) {
    const project = newest.projectHint
      ? `; largest contributor: Project ${newest.projectHint}`
      : "";
    return `New charge from ${newest.name} at ${formatUsd(newest.usageCost)}${project}.`;
  }

  const biggest = [...services]
    .filter((s) => s.previousCost != null && s.previousCost > 0)
    .map((s) => ({
      service: s,
      delta: s.usageCost - (s.previousCost ?? 0),
    }))
    .sort((a, b) => b.delta - a.delta)[0];
  if (biggest && biggest.delta >= 0.5) {
    const project = biggest.service.projectHint
      ? `, driven by Project ${biggest.service.projectHint}`
      : "";
    return `${biggest.service.name} rose ${formatUsd(biggest.delta)}${project}.`;
  }
  return undefined;
}

function emptyDays(startDate: string, endDate: string): GcpBillingDay[] {
  return eachUtcDate(startDate, endDate).map((date) => ({ date, costs: {} }));
}

function unavailableReport(
  account: GcpBillingAccountConfig,
  window: GcpBillingWindow,
  error: string,
  now = new Date(),
): GcpBillingReport {
  const mtd = currentMonthToDate(now);
  return {
    accountId: account.id,
    accountLabel: account.label,
    reportsUrl: reportsUrlFor(account.id, window.period),
    startDate: window.startDate,
    endDate: window.endDate,
    previousStartDate: window.previousStartDate,
    previousEndDate: window.previousEndDate,
    currency: "USD",
    total: 0,
    previousTotal: 0,
    savings: 0,
    services: [],
    apiUsage: [],
    apiUsageStartDate: mtd.startDate,
    apiUsageEndDate: mtd.endDate,
    days: emptyDays(window.startDate, window.endDate),
    period: window.period,
    source: "bigquery",
    error,
  };
}

const EXPORT_SETUP_HINT =
  "Enable Standard usage cost export to a US BigQuery dataset on a project billed to AI Greeting Card & Restaurant Roulette, share it with this app’s service account as BigQuery Data Viewer, and set GCP_BILLING_BQ_TABLE=project.dataset.gcp_billing_export_v1_016802_8E2106_038F4F.";

function parseTableRef(raw: string) {
  const cleaned = raw.replace(/`/g, "").trim();
  const parts = cleaned.split(".");
  if (parts.length !== 3 || parts.some((p) => !p || !/^[\w-]+$/.test(p))) {
    throw new Error(
      "GCP_BILLING_BQ_TABLE must be project.dataset.table (letters, numbers, _ or -)",
    );
  }
  return { project: parts[0]!, dataset: parts[1]!, table: parts[2]! };
}

async function bqGetJson(
  accessToken: string,
  url: string | URL,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

type BqListEntry = {
  datasetReference?: { datasetId?: string };
  tableReference?: { tableId?: string };
};

/** Each collection has its own tokens; all requests share the billing deadline. */
async function* listBqEntries(
  accessToken: string,
  endpoint: string,
  collection: "datasets" | "tables",
  signal: AbortSignal,
): AsyncGenerator<BqListEntry> {
  const url = new URL(endpoint);
  const seen = new Set<string>();
  while (true) {
    signal.throwIfAborted();
    const response = await bqGetJson(accessToken, url, signal);
    // Inaccessible datasets can be skipped during discovery of other datasets.
    if (collection === "tables" && [403, 404].includes(response.status)) return;
    const body = response.body as {
      datasets?: BqListEntry[];
      tables?: BqListEntry[];
      nextPageToken?: string;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body) throw new Error(body?.error?.message || `BigQuery ${collection} discovery ${response.status}`);
    for (const entry of body[collection] ?? []) yield entry;
    if (!body.nextPageToken) return;
    if (seen.has(body.nextPageToken)) throw new Error(`BigQuery ${collection} discovery repeated a page token`);
    seen.add(body.nextPageToken);
    url.searchParams.set("pageToken", body.nextPageToken);
  }
}

async function discoverBillingTable(
  accessToken: string,
  projectId: string,
  accountId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const expected = `gcp_billing_export_v1_${accountId.replaceAll("-", "_")}`;
  const projectUrl = `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}`;
  for await (const dataset of listBqEntries(accessToken, `${projectUrl}/datasets`, "datasets", signal)) {
    const datasetId = dataset.datasetReference?.datasetId;
    if (!datasetId) continue;
    for await (const table of listBqEntries(accessToken, `${projectUrl}/datasets/${encodeURIComponent(datasetId)}/tables`, "tables", signal)) {
      if (table.tableReference?.tableId === expected) return `${projectId}.${datasetId}.${expected}`;
    }
  }
  return null;
}

async function runBqQuery(
  accessToken: string,
  projectId: string,
  query: string,
  params: Array<{ name: string; value: string; type: "DATE" | "STRING" }>,
  signal: AbortSignal,
): Promise<string[][]> {
  signal.throwIfAborted();
  const response = await fetch(
    `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      body: JSON.stringify({
        query,
        useLegacySql: false,
        timeoutMs: 20000,
        maxResults: 10000,
        parameterMode: "NAMED",
        queryParameters: params.map((p) => ({
          name: p.name,
          parameterType: { type: p.type },
          parameterValue: { value: p.value },
        })),
      }),
    },
  );
  const parsePage = async (response: Response): Promise<BqJobResponse> => {
    const payload = await response.json().catch(() => null) as
      | (BqJobResponse & { error?: { message?: string } })
      | null;
    if (!response.ok || !payload || payload.errorResult || payload.error) {
      throw new Error(payload?.errorResult?.message || payload?.error?.message || payload?.errors?.[0]?.message || `BigQuery query ${response.status}`);
    }
    return payload;
  };
  let payload = await parsePage(response);
  const job = payload.jobReference;
  const rows: string[][] = [];
  const seen = new Set<string>();
  let totalRows: string | undefined;
  while (true) {
    signal.throwIfAborted();
    if (!payload.jobComplete) throw new Error("BigQuery billing query timed out");
    totalRows = payload.totalRows ?? totalRows;
    rows.push(...(payload.rows ?? []).map((row) => (row.f ?? []).map((cell) => cell.v ?? "")));
    if (!payload.pageToken) break;
    if (!job?.jobId) throw new Error("BigQuery billing results missing job reference; refusing to report incomplete totals");
    if (seen.has(payload.pageToken)) throw new Error("BigQuery billing repeated a page token; refusing to report incomplete totals");
    seen.add(payload.pageToken);
    const url = new URL(`${BIGQUERY_API}/projects/${encodeURIComponent(job.projectId || projectId)}/queries/${encodeURIComponent(job.jobId)}`);
    url.searchParams.set("pageToken", payload.pageToken);
    url.searchParams.set("maxResults", "10000");
    if (job.location) url.searchParams.set("location", job.location);
    const next = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    payload = await parsePage(next);
  }
  if (totalRows != null && BigInt(totalRows) !== BigInt(rows.length)) {
    throw new Error("BigQuery billing row count mismatch; refusing to report incomplete totals");
  }
  return rows;
}

function reportFromRows(
  account: GcpBillingAccountConfig,
  window: GcpBillingWindow,
  rows: GcpBillingRow[],
  now = new Date(),
): GcpBillingReport {
  const currentDays = new Set(eachUtcDate(window.startDate, window.endDate));
  const previousDays = new Set(
    eachUtcDate(window.previousStartDate, window.previousEndDate),
  );
  const mtd = currentMonthToDate(now);
  const usageDays = new Set(eachUtcDate(mtd.startDate, mtd.endDate));
  const serviceCosts = new Map<
    string,
    {
      usage: number;
      previous: number;
      projects: Map<string, number>;
    }
  >();
  const mtdServiceCalls = new Map<string, number>();
  const skuUsage = new Map<
    string,
    {
      service: string;
      sku: string;
      unit: GcpBillingSkuUnit;
      quantity: number;
    }
  >();
  const dayCosts = new Map<string, Record<string, number>>();
  let total = 0;
  let previousTotal = 0;
  let savings = 0;

  for (const row of rows) {
    const net = row.usageCost + row.credits;
    const inCurrent = currentDays.has(row.day);
    const bucket = serviceCosts.get(row.service) ?? {
      usage: 0,
      previous: 0,
      projects: new Map<string, number>(),
    };
    const amount = row.usageAmount ?? 0;
    const unit = skuUsageUnit(row.sku ?? "", row.usageUnit ?? "");
    if (inCurrent) {
      bucket.usage += net;
      total += net;
      savings += Math.min(0, row.credits);
      const project = row.project.trim();
      if (project) {
        bucket.projects.set(project, (bucket.projects.get(project) ?? 0) + net);
      }
      const day = dayCosts.get(row.day) ?? {};
      day[row.service] = (day[row.service] ?? 0) + net;
      dayCosts.set(row.day, day);
    } else if (previousDays.has(row.day)) {
      bucket.previous += net;
      previousTotal += net;
    }
    serviceCosts.set(row.service, bucket);

    if (unit && usageDays.has(row.day)) {
      const skuName = row.sku?.trim() || "Unknown SKU";
      const skuKey = `${row.service}\t${skuName}`;
      const skuBucket = skuUsage.get(skuKey) ?? {
        service: row.service,
        sku: skuName,
        unit,
        quantity: 0,
      };
      skuBucket.quantity += amount;
      skuUsage.set(skuKey, skuBucket);
      if (unit === "calls") {
        mtdServiceCalls.set(
          row.service,
          (mtdServiceCalls.get(row.service) ?? 0) + amount,
        );
      }
    }
  }

  const ranked = [...serviceCosts.entries()]
    .filter(
      ([, v]) => roundUsd(v.usage) !== 0 || roundUsd(v.previous) !== 0,
    )
    .sort((a, b) => b[1].usage - a[1].usage);

  const skuGroups = new Map<string, GcpBillingSku[]>();
  for (const bucket of skuUsage.values()) {
    if (Math.round(bucket.quantity) <= 0) continue;
    const list = skuGroups.get(bucket.service) ?? [];
    const name = displaySkuName(bucket.service, bucket.sku);
    const quantity = Math.round(bucket.quantity);
    const existing = list.find((sku) => sku.name === name && sku.unit === bucket.unit);
    const freeMonthly = /places api|maps api/i.test(bucket.service) ? skuFreeMonthlyCap(bucket.sku) ?? undefined : undefined;
    if (existing) existing.quantity += quantity;
    else {
      list.push({
        name,
        quantity,
        unit: bucket.unit,
        ...(freeMonthly ? { freeMonthly } : {}),
      });
    }
    skuGroups.set(bucket.service, list);
  }
  for (const list of skuGroups.values()) {
    list.sort((a, b) => {
      if (a.unit !== b.unit) return a.unit === "calls" ? -1 : 1;
      return b.quantity - a.quantity;
    });
  }

  const styleNames = [
    ...ranked.map(([name]) => name),
    ...[...skuGroups.keys()].filter(
      (name) => !ranked.some(([service]) => service === name),
    ),
  ];
  const styles = new Map(
    styleNames.map((name, index) => [name, styleForService(name, index)]),
  );

  const services = ranked.map(([name, v]) => {
    const topProject = [...v.projects.entries()].sort((a, b) => b[1] - a[1])[0];
    const roundedCalls = Math.round(mtdServiceCalls.get(name) ?? 0);
    return {
      name,
      ...(styles.get(name) ?? styleForService(name, 0)),
      usageCost: roundUsd(v.usage),
      previousCost: v.previous === 0 && v.usage > 0 ? null : roundUsd(v.previous),
      calls: roundedCalls > 0 ? roundedCalls : null,
      projectHint: topProject?.[0],
    } satisfies GcpBillingService;
  });

  const apiUsage: GcpBillingApiUsage[] = [...skuGroups.entries()]
    .map(([name, skus]) => {
      const roundedCalls = Math.round(mtdServiceCalls.get(name) ?? 0);
      return {
        name,
        ...(styles.get(name) ?? styleForService(name, 0)),
        calls: roundedCalls > 0 ? roundedCalls : null,
        skus,
      } satisfies GcpBillingApiUsage;
    })
    .sort((a, b) => {
      const aRank = ranked.findIndex(([name]) => name === a.name);
      const bRank = ranked.findIndex(([name]) => name === b.name);
      const aOrder = aRank === -1 ? Number.POSITIVE_INFINITY : aRank;
      const bOrder = bRank === -1 ? Number.POSITIVE_INFINITY : bRank;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.calls ?? 0) - (a.calls ?? 0) || a.name.localeCompare(b.name);
    });

  const days = emptyDays(window.startDate, window.endDate).map((day) => ({
    date: day.date,
    costs: dayCosts.get(day.date) ?? {},
  }));
  const latestUsageDate = rows.map((r) => r.day).sort().at(-1);
  const firstUsageDate = rows.map((r) => r.day).sort()[0];
  const exportedAt = rows.map((r) => r.exportedAt).filter((v): v is string => Boolean(v)).sort().at(-1);
  const comparisonAvailable = Boolean(firstUsageDate && firstUsageDate <= window.previousStartDate && rows.some(r => previousDays.has(r.day)));
  const freshnessNote = [
    "Provisional net costs after credits, grouped by usage date in UTC; not an invoice total. Google Console daily reports use Pacific time.",
    exportedAt ? `Export last updated ${exportedAt}.` : "Export update time unavailable.",
    latestUsageDate ? `Latest exported usage: ${latestUsageDate}; missing days are unreported, not verified zero usage.` : "No exported usage rows in the selected range.",
    comparisonAvailable ? undefined : "Prior-period export coverage is incomplete; comparison unavailable.",
  ].filter(Boolean).join(" ");

  return {
    accountId: account.id,
    accountLabel: account.label,
    reportsUrl: reportsUrlFor(account.id, window.period),
    startDate: window.startDate,
    endDate: window.endDate,
    previousStartDate: window.previousStartDate,
    previousEndDate: window.previousEndDate,
    currency: "USD",
    total: roundUsd(total),
    previousTotal: roundUsd(previousTotal),
    savings: roundUsd(Math.abs(savings)),
    services,
    apiUsage,
    apiUsageStartDate: mtd.startDate,
    apiUsageEndDate: mtd.endDate,
    days,
    insight: comparisonAvailable ? buildInsight(services) : undefined,
    freshnessNote,
    exportedAt,
    latestUsageDate,
    comparisonAvailable,
    error: rows.some(r => currentDays.has(r.day)) ? undefined
      : `No month-to-date usage rows have been exported. Current costs are unavailable. ${freshnessNote}`,
    period: window.period,
    source: "bigquery",
  };
}

async function collectFromBigQuery(
  account: GcpBillingAccountConfig,
  now = new Date(),
): Promise<GcpBillingReport | null> {
  if (!getServiceAccountCredentials()) return null;

  let accessToken: string | null;
  try {
    accessToken = await getGoogleAccessToken([BIGQUERY_SCOPE]);
  } catch (error) {
    console.warn("gcp-billing: access token failed", error);
    return null;
  }
  if (!accessToken) return null;

  const projectId = getGoogleCloudProjectId();
  if (!projectId) return null;

  // Discovery and all query pages share one total collection budget.
  const signal = AbortSignal.timeout(60_000);
  const configured = process.env.GCP_BILLING_BQ_TABLE?.trim();
  let tableRef: string | null = configured || null;
  if (!tableRef) {
    tableRef = await discoverBillingTable(accessToken, projectId, account.id, signal);
  }
  if (!tableRef) return null;

  const { project, dataset, table } = parseTableRef(tableRef);
  const fq = `\`${project}.${dataset}.${table}\``;
  const jobProject =
    process.env.GCP_BILLING_BQ_JOB_PROJECT?.trim() || project;
  const lookback = lookbackRange(now);
  const query = `
    SELECT
      CAST(DATE(usage_start_time) AS STRING) AS day,
      service.description AS service,
      sku.description AS sku,
      IFNULL(project.name, "") AS project,
      SUM(cost / IF(currency = 'USD', 1, currency_conversion_rate)) AS usage_cost,
      SUM(IFNULL((
        SELECT SUM(CAST(c.amount AS FLOAT64)) FROM UNNEST(credits) c
      ), 0) / IF(currency = 'USD', 1, currency_conversion_rate)) AS credits,
      SUM(IFNULL(usage.amount, 0)) AS usage_amount,
      usage.unit AS usage_unit,
      CAST(MAX(export_time) AS STRING) AS exported_at
    FROM ${fq}
    WHERE DATE(usage_start_time) BETWEEN @start AND @end
      AND billing_account_id = @account
      AND DATE(export_time) >= DATE_SUB(@start, INTERVAL 5 DAY)
    GROUP BY 1, 2, 3, 4, 8
  `;

  const rows = await runBqQuery(
    accessToken, jobProject, query,
    [
      { name: "start", value: lookback.startDate, type: "DATE" },
      { name: "end", value: lookback.endDate, type: "DATE" },
      { name: "account", value: account.id, type: "STRING" },
    ],
    signal,
  );

  const parsed: GcpBillingRow[] = rows.map((cols) => {
    const number = (index: number) => {
      const value = Number(cols[index]);
      if (cols[index] == null || cols[index] === "" || !Number.isFinite(value)) {
        throw new Error("Invalid billing cost or quantity; check export currency conversion rates");
      }
      return value;
    };
    return {
      day: cols[0] ?? "",
      service: cols[1] || "Unknown service",
      sku: cols[2] || "Unknown SKU",
      project: cols[3] ?? "",
      usageCost: number(4),
      credits: number(5),
      usageAmount: number(6),
      usageUnit: cols[7] ?? "",
      exportedAt: cols[8] || undefined,
    };
  });

  if (parsed.length === 0) {
    return unavailableReport(
      account,
      currentMonthToDate(now),
      "No usage rows were returned by the billing export. Current costs are unavailable, not a verified $0.",
    );
  }

  const window = resolveBillingWindow(parsed, now);
  return reportFromRows(account, window, parsed, now);
}

/** Provisional month-to-date usage costs, including zero-cost rows and corrections. */
export async function collectGcpBilling(): Promise<GcpBillingReport | null> {
  try {
    const account = billingAccount();
    const now = new Date();

    if (!getServiceAccountCredentials()) return null;

    try {
      const live = await collectFromBigQuery(account, now);
      if (live) return live;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "BigQuery billing query failed";
      console.warn("gcp-billing: BigQuery fetch failed", error);
      return unavailableReport(
        account,
        currentMonthToDate(now),
        friendlyBillingError(message),
      );
    }

    return unavailableReport(account, currentMonthToDate(now), EXPORT_SETUP_HINT);
  } catch (error) {
    console.warn("gcp-billing: collector crashed; skipping section", error);
    return null;
  }
}

function friendlyBillingError(message: string) {
  if (/not found|does not exist/i.test(message)) {
    return "Cloud Billing export is enabled. Daily cost rows have not landed in BigQuery yet.";
  }
  if (/access denied|permission|403/i.test(message)) {
    return "Cloud Billing export is enabled, but this app cannot query BigQuery yet.";
  }
  return message;
}
