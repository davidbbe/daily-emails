import { JWT } from "google-auth-library";
import { GA_ACCOUNTS } from "@/lib/config";

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

const OVERVIEW_METRICS = [
  { name: "activeUsers" },
  { name: "sessions" },
  { name: "screenPageViews" },
  { name: "bounceRate" },
  { name: "averageSessionDuration" },
] as const;

export type SiteDayMetrics = {
  activeUsers: number;
  sessions: number;
  screenPageViews: number;
  bounceRate: number;
  averageSessionDuration: number;
};

/** One calendar day in a site trend series (YYYY-MM-DD). */
export type SiteDayPoint = {
  date: string;
  activeUsers: number;
  sessions: number;
  screenPageViews: number;
};

export type SiteAnalytics = {
  accountId: string;
  propertyId: string;
  label: string;
  date: string;
  previousDate: string;
  /** First day of the UTC month that contains the report day (YYYY-MM-DD) */
  monthStart: string;
  metrics: SiteDayMetrics;
  previous: SiteDayMetrics;
  /** Month-to-date through yesterday (UTC) */
  monthToDate: SiteDayMetrics;
  /** Daily users/sessions/views for the last 7 complete UTC days */
  dailySeries: SiteDayPoint[];
  /** Present when the property resolved but the report failed */
  error?: string;
};

type AdminProperty = {
  name?: string;
  displayName?: string;
};

type RunReportResponse = {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
};

function stripWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getServiceAccountCredentials() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.GOOGLE_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) return null;

  // Vercel UI / dotenv may wrap the PEM in quotes and store literal \n.
  privateKey = stripWrappingQuotes(privateKey).replace(/\\n/g, "\n");
  return { clientEmail: stripWrappingQuotes(clientEmail), privateKey };
}

async function getAccessToken(): Promise<string | null> {
  const creds = getServiceAccountCredentials();
  if (!creds) return null;

  const client = new JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    scopes: [ANALYTICS_SCOPE],
  });

  const token = await client.getAccessToken();
  return token.token ?? null;
}

function parseMetricNumber(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

function emptyMetrics(): SiteDayMetrics {
  return {
    activeUsers: 0,
    sessions: 0,
    screenPageViews: 0,
    bounceRate: 0,
    averageSessionDuration: 0,
  };
}

function metricsFromValues(
  headers: Array<{ name?: string }> | undefined,
  values: Array<{ value?: string }> | undefined,
): SiteDayMetrics {
  const byName = new Map<string, number>();
  for (let i = 0; i < (headers?.length ?? 0); i++) {
    const name = headers?.[i]?.name;
    if (!name) continue;
    byName.set(name, parseMetricNumber(values?.[i]?.value));
  }
  return {
    activeUsers: byName.get("activeUsers") ?? 0,
    sessions: byName.get("sessions") ?? 0,
    screenPageViews: byName.get("screenPageViews") ?? 0,
    bounceRate: byName.get("bounceRate") ?? 0,
    averageSessionDuration: byName.get("averageSessionDuration") ?? 0,
  };
}

/** YYYY-MM-DD in UTC for N days before today (1 = yesterday). */
function utcDateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** First day of the UTC month that contains yesterday (the report day). */
function utcMonthStart(): string {
  const reportDay = utcDateDaysAgo(1);
  return `${reportDay.slice(0, 8)}01`;
}

async function resolvePropertyId(
  accessToken: string,
  accountId: string,
): Promise<string> {
  const url = new URL(`${ADMIN_API}/properties`);
  url.searchParams.set("filter", `parent:accounts/${accountId}`);
  url.searchParams.set("pageSize", "1");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const payload = (await response.json().catch(() => null)) as {
    properties?: AdminProperty[];
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        `Admin API ${response.status} for account ${accountId}`,
    );
  }

  const property = payload?.properties?.[0];
  const name = property?.name; // properties/123456
  const propertyId = name?.replace(/^properties\//, "");
  if (!property || !propertyId) {
    throw new Error(`No GA4 property found under account ${accountId}`);
  }

  return propertyId;
}

function parseNamedRangeReport(
  payload: RunReportResponse | null,
  rangeNames: string[],
): Record<string, SiteDayMetrics> {
  const metricHeaders = payload?.metricHeaders;
  const dimHeaders = payload?.dimensionHeaders ?? [];
  const dateRangeDimIndex = dimHeaders.findIndex(
    (h) => h.name === "dateRange",
  );
  const rows = payload?.rows ?? [];
  const byName: Record<string, SiteDayMetrics> = {};

  for (const name of rangeNames) {
    byName[name] = emptyMetrics();
  }

  if (dateRangeDimIndex >= 0) {
    for (const row of rows) {
      const rangeName = row.dimensionValues?.[dateRangeDimIndex]?.value;
      if (!rangeName || !(rangeName in byName)) continue;
      byName[rangeName] = metricsFromValues(metricHeaders, row.metricValues);
    }
    return byName;
  }

  // Fallback: assume rows arrive in the same order as requested ranges.
  for (let i = 0; i < rangeNames.length; i++) {
    const name = rangeNames[i];
    if (!name) continue;
    byName[name] = metricsFromValues(metricHeaders, rows[i]?.metricValues);
  }
  return byName;
}

async function fetchOverviewReport(
  accessToken: string,
  propertyId: string,
  monthStart: string,
): Promise<{
  yesterday: SiteDayMetrics;
  previous: SiteDayMetrics;
  monthToDate: SiteDayMetrics;
}> {
  const rangeNames = ["yesterday", "previous", "mtd"] as const;
  const reportDay = utcDateDaysAgo(1);
  const previousDay = utcDateDaysAgo(2);
  const response = await fetch(
    `${DATA_API}/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [
          { startDate: reportDay, endDate: reportDay, name: "yesterday" },
          { startDate: previousDay, endDate: previousDay, name: "previous" },
          { startDate: monthStart, endDate: reportDay, name: "mtd" },
        ],
        metrics: [...OVERVIEW_METRICS],
        keepEmptyRows: true,
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as
    | (RunReportResponse & { error?: { message?: string } })
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        `Data API ${response.status} for property ${propertyId}`,
    );
  }

  const byName = parseNamedRangeReport(payload, [...rangeNames]);
  return {
    yesterday: byName.yesterday ?? emptyMetrics(),
    previous: byName.previous ?? emptyMetrics(),
    monthToDate: byName.mtd ?? emptyMetrics(),
  };
}

/** GA4 date dimension is YYYYMMDD → YYYY-MM-DD. */
function gaDateToIso(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function emptyDailySeries(days = 7): SiteDayPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: utcDateDaysAgo(days - i),
    activeUsers: 0,
    sessions: 0,
    screenPageViews: 0,
  }));
}

async function fetchDailySeries(
  accessToken: string,
  propertyId: string,
  days = 7,
): Promise<SiteDayPoint[]> {
  const startDate = utcDateDaysAgo(days);
  const endDate = utcDateDaysAgo(1);
  const response = await fetch(
    `${DATA_API}/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" } }],
        keepEmptyRows: true,
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as
    | (RunReportResponse & { error?: { message?: string } })
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        `Daily series ${response.status} for property ${propertyId}`,
    );
  }

  const byDate = new Map<string, SiteDayPoint>();
  for (const row of payload?.rows ?? []) {
    const iso = gaDateToIso(row.dimensionValues?.[0]?.value);
    if (!iso) continue;
    const values = row.metricValues;
    byDate.set(iso, {
      date: iso,
      activeUsers: parseMetricNumber(values?.[0]?.value),
      sessions: parseMetricNumber(values?.[1]?.value),
      screenPageViews: parseMetricNumber(values?.[2]?.value),
    });
  }

  // Always return a complete last-N-days spine so charts stay aligned.
  return emptyDailySeries(days).map(
    (point) => byDate.get(point.date) ?? point,
  );
}

function siteShell(
  accountId: string,
  label: string,
  propertyId: string,
  error?: string,
): SiteAnalytics {
  const date = utcDateDaysAgo(1);
  const previousDate = utcDateDaysAgo(2);
  const monthStart = utcMonthStart();
  return {
    accountId,
    propertyId,
    label,
    date,
    previousDate,
    monthStart,
    metrics: emptyMetrics(),
    previous: emptyMetrics(),
    monthToDate: emptyMetrics(),
    dailySeries: emptyDailySeries(7),
    error,
  };
}

async function collectOneSite(
  accessToken: string,
  accountId: string,
  label: string,
): Promise<SiteAnalytics> {
  try {
    const propertyId = await resolvePropertyId(accessToken, accountId);
    try {
      const monthStart = utcMonthStart();
      const [{ yesterday, previous, monthToDate }, dailySeries] =
        await Promise.all([
          fetchOverviewReport(accessToken, propertyId, monthStart),
          fetchDailySeries(accessToken, propertyId, 7),
        ]);
      return {
        ...siteShell(accountId, label, propertyId),
        metrics: yesterday,
        previous,
        monthToDate,
        dailySeries,
      };
    } catch (error) {
      return siteShell(
        accountId,
        label,
        propertyId,
        error instanceof Error ? error.message : "Report failed",
      );
    }
  } catch (error) {
    return siteShell(
      accountId,
      label,
      "",
      error instanceof Error ? error.message : "Property resolve failed",
    );
  }
}

/**
 * Yesterday + month-to-date GA4 overview for configured accounts.
 * Returns [] when credentials are missing (section omitted from email).
 */
export async function collectSiteAnalytics(): Promise<SiteAnalytics[]> {
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch (error) {
    console.warn("analytics: failed to obtain access token", error);
    return [];
  }

  if (!accessToken) {
    return [];
  }

  return Promise.all(
    GA_ACCOUNTS.map((account) =>
      collectOneSite(accessToken, account.accountId, account.label),
    ),
  );
}

/** Percent change for day-over-day; null when previous is zero. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export function formatBounceRate(rate: number): string {
  // GA4 returns bounce rate as a fraction 0–1.
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${pct.toFixed(1)}%`;
}

export function formatSessionDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDeltaPercent(delta: number | null): string {
  if (delta === null) return "n/a";
  const rounded = Math.round(delta);
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
