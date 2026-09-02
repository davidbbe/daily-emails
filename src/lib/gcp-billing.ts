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

export type GcpBillingService = {
  name: string;
  color: string;
  marker: "circle" | "square";
  usageCost: number;
  previousCost: number | null;
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
  days: GcpBillingDay[];
  insight?: string;
  source: "bigquery";
  error?: string;
};

export type GcpBillingWindow = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  year: number;
  monthIndex: number;
};

type BqJobResponse = {
  jobComplete?: boolean;
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
    reportsUrl: `https://console.cloud.google.com/billing/${id}/reports;timeRange=THIS_MONTH`,
  };
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
  const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
  const py = prev.getUTCFullYear();
  const pm = prev.getUTCMonth();
  const previousEndDay = Math.min(endDay, daysInUtcMonth(py, pm));
  return {
    startDate: isoDate(year, monthIndex, 1),
    endDate: isoDate(year, monthIndex, endDay),
    previousStartDate: isoDate(py, pm, 1),
    previousEndDate: isoDate(py, pm, previousEndDay),
    year,
    monthIndex,
  };
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

function buildInsight(services: GcpBillingService[]): string | undefined {
  const newest = services
    .filter((s) => s.previousCost == null && s.usageCost > 0)
    .sort((a, b) => b.usageCost - a.usageCost)[0];
  if (newest) {
    const project = newest.projectHint
      ? `, driven by ${formatUsd(newest.usageCost)} from Project ${newest.projectHint}`
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
): GcpBillingReport {
  return {
    accountId: account.id,
    accountLabel: account.label,
    reportsUrl: account.reportsUrl,
    startDate: window.startDate,
    endDate: window.endDate,
    previousStartDate: window.previousStartDate,
    previousEndDate: window.previousEndDate,
    currency: "USD",
    total: 0,
    previousTotal: 0,
    savings: 0,
    services: [],
    days: emptyDays(window.startDate, window.endDate),
    source: "bigquery",
    error,
  };
}

const EXPORT_SETUP_HINT =
  "Enable Standard usage cost export to a US BigQuery dataset on a project billed to Restaurant Roulette, share it with this app’s service account as BigQuery Data Viewer, and set GCP_BILLING_BQ_TABLE=project.dataset.gcp_billing_export_v1_016802_8E2106_038F4F.";

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
  url: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function discoverBillingTable(
  accessToken: string,
  projectId: string,
  accountId: string,
): Promise<string | null> {
  const expected = `gcp_billing_export_v1_${accountId.replaceAll("-", "_")}`;
  const datasets = await bqGetJson(
    accessToken,
    `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets`,
  );
  const list = datasets.body as {
    datasets?: Array<{ datasetReference?: { datasetId?: string } }>;
  } | null;
  if (!datasets.ok) return null;

  for (const dataset of list?.datasets ?? []) {
    const datasetId = dataset.datasetReference?.datasetId;
    if (!datasetId) continue;
    const tables = await bqGetJson(
      accessToken,
      `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables`,
    );
    const tableList = tables.body as {
      tables?: Array<{ tableReference?: { tableId?: string } }>;
    } | null;
    if (!tables.ok) continue;
    for (const table of tableList?.tables ?? []) {
      const tableId = table.tableReference?.tableId;
      if (tableId === expected || tableId?.startsWith("gcp_billing_export_v1_")) {
        return `${projectId}.${datasetId}.${tableId}`;
      }
    }
  }
  return null;
}

async function runBqQuery(
  accessToken: string,
  projectId: string,
  query: string,
  params: Array<{ name: string; value: string; type: "DATE" | "STRING" }>,
): Promise<string[][]> {
  const response = await fetch(
    `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        query,
        useLegacySql: false,
        timeoutMs: 20000,
        parameterMode: "NAMED",
        queryParameters: params.map((p) => ({
          name: p.name,
          parameterType: { type: p.type },
          parameterValue: { value: p.value },
        })),
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | (BqJobResponse & { error?: { message?: string } })
    | null;
  if (!response.ok || payload?.errorResult || payload?.error) {
    throw new Error(
      payload?.errorResult?.message ||
        payload?.errors?.[0]?.message ||
        payload?.error?.message ||
        `BigQuery query ${response.status}`,
    );
  }
  if (!payload?.jobComplete) {
    throw new Error("BigQuery billing query timed out");
  }
  return (payload.rows ?? []).map((row) =>
    (row.f ?? []).map((cell) => cell.v ?? ""),
  );
}

function reportFromRows(
  account: GcpBillingAccountConfig,
  window: GcpBillingWindow,
  rows: Array<{
    day: string;
    service: string;
    project: string;
    usageCost: number;
    credits: number;
  }>,
): GcpBillingReport {
  const currentDays = new Set(eachUtcDate(window.startDate, window.endDate));
  const previousDays = new Set(
    eachUtcDate(window.previousStartDate, window.previousEndDate),
  );
  const serviceCosts = new Map<
    string,
    { usage: number; previous: number; projects: Map<string, number> }
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
    if (inCurrent) {
      bucket.usage += net;
      total += net;
      savings += Math.min(0, row.credits);
      const project = row.project.trim();
      if (project) {
        bucket.projects.set(project, (bucket.projects.get(project) ?? 0) + net);
      }
      const day = dayCosts.get(row.day) ?? {};
      day[row.service] = roundUsd((day[row.service] ?? 0) + net);
      dayCosts.set(row.day, day);
    } else if (previousDays.has(row.day)) {
      bucket.previous += net;
      previousTotal += net;
    }
    serviceCosts.set(row.service, bucket);
  }

  const ranked = [...serviceCosts.entries()]
    .filter(([, v]) => v.usage !== 0 || v.previous !== 0)
    .sort((a, b) => b[1].usage - a[1].usage);

  const services = ranked.map(([name, v], index) => {
    const topProject = [...v.projects.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      name,
      ...styleForService(name, index),
      usageCost: roundUsd(v.usage),
      previousCost: v.previous === 0 && v.usage > 0 ? null : roundUsd(v.previous),
      projectHint: topProject?.[0],
    } satisfies GcpBillingService;
  });

  const days = emptyDays(window.startDate, window.endDate).map((day) => ({
    date: day.date,
    costs: dayCosts.get(day.date) ?? {},
  }));

  return {
    accountId: account.id,
    accountLabel: account.label,
    reportsUrl: account.reportsUrl,
    startDate: window.startDate,
    endDate: window.endDate,
    previousStartDate: window.previousStartDate,
    previousEndDate: window.previousEndDate,
    currency: "USD",
    total: roundUsd(total),
    previousTotal: roundUsd(previousTotal),
    savings: roundUsd(Math.abs(savings)),
    services,
    days,
    insight: buildInsight(services),
    source: "bigquery",
  };
}

async function collectFromBigQuery(
  account: GcpBillingAccountConfig,
  window: GcpBillingWindow,
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

  const configured = process.env.GCP_BILLING_BQ_TABLE?.trim();
  let tableRef: string | null = configured || null;
  if (!tableRef) {
    try {
      tableRef = await discoverBillingTable(
        accessToken,
        projectId,
        account.id,
      );
    } catch (error) {
      console.warn("gcp-billing: table discovery failed", error);
      return null;
    }
  }
  if (!tableRef) return null;

  const { project, dataset, table } = parseTableRef(tableRef);
  const fq = `\`${project}.${dataset}.${table}\``;
  const jobProject =
    process.env.GCP_BILLING_BQ_JOB_PROJECT?.trim() || project;
  const query = `
    SELECT
      CAST(DATE(usage_start_time) AS STRING) AS day,
      service.description AS service,
      IFNULL(project.name, "") AS project,
      SUM(cost) AS usage_cost,
      SUM(IFNULL((
        SELECT SUM(CAST(c.amount AS FLOAT64)) FROM UNNEST(credits) c
      ), 0)) AS credits
    FROM ${fq}
    WHERE DATE(usage_start_time) BETWEEN @start AND @end
    GROUP BY 1, 2, 3
  `;

  const rows = await runBqQuery(accessToken, jobProject, query, [
    { name: "start", value: window.previousStartDate, type: "DATE" },
    { name: "end", value: window.endDate, type: "DATE" },
  ]);

  const parsed = rows.map((cols) => ({
    day: cols[0] ?? "",
    service: cols[1] || "Unknown service",
    project: cols[2] ?? "",
    usageCost: Number.parseFloat(cols[3] ?? "0") || 0,
    credits: Number.parseFloat(cols[4] ?? "0") || 0,
  }));

  return reportFromRows(account, window, parsed);
}

/**
 * Current-month Cloud Billing through yesterday UTC, grouped by service.
 * Requires BigQuery billing export. Returns null when Google creds are unset.
 */
export async function collectGcpBilling(): Promise<GcpBillingReport | null> {
  try {
    const account = billingAccount();
    const window = currentMonthToDate();

    if (!getServiceAccountCredentials()) return null;

    try {
      const live = await collectFromBigQuery(account, window);
      if (live) return live;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "BigQuery billing query failed";
      console.warn("gcp-billing: BigQuery fetch failed", error);
      return unavailableReport(account, window, friendlyBillingError(message));
    }

    return unavailableReport(account, window, EXPORT_SETUP_HINT);
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
