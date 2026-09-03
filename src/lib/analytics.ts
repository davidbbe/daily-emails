import { GA_ACCOUNTS } from "@/lib/config";
import {
  addIsoDays,
  calendarDayInZone,
  monthStartOf,
} from "@/lib/dates";
import { getGoogleAccessToken } from "@/lib/google-auth";

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const DEFAULT_TIME_ZONE = "UTC";
const SERIES_DAYS = 7;
/** Extra day so we can fall back when GA4 has not processed yesterday yet. */
const SERIES_LOOKAHEAD_DAYS = SERIES_DAYS + 1;

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
  /** First day of the month that contains the report day (YYYY-MM-DD) */
  monthStart: string;
  /** IANA timezone from the GA4 property (dates are property-local). */
  timeZone: string;
  metrics: SiteDayMetrics;
  previous: SiteDayMetrics;
  /** Month-to-date through the report day */
  monthToDate: SiteDayMetrics;
  /** Daily users/sessions/views for the last 7 complete property-local days */
  dailySeries: SiteDayPoint[];
  /** Why the report day is not property-local yesterday, when GA4 is lagging. */
  freshnessNote?: string;
  /** Present when the property resolved but the report failed */
  error?: string;
};

type AdminProperty = {
  name?: string;
  displayName?: string;
  timeZone?: string;
};

type ResolvedProperty = {
  propertyId: string;
  timeZone: string;
};

type RunReportResponse = {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
};

async function getAccessToken(): Promise<string | null> {
  return getGoogleAccessToken([ANALYTICS_SCOPE]);
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

function metricsFromPoint(point: SiteDayPoint | undefined): SiteDayMetrics {
  if (!point) return emptyMetrics();
  return {
    activeUsers: point.activeUsers,
    sessions: point.sessions,
    screenPageViews: point.screenPageViews,
    bounceRate: 0,
    averageSessionDuration: 0,
  };
}

function dayHasActivity(
  metrics: Pick<
    SiteDayMetrics,
    "activeUsers" | "sessions" | "screenPageViews"
  >,
): boolean {
  return (
    metrics.activeUsers > 0 ||
    metrics.sessions > 0 ||
    metrics.screenPageViews > 0
  );
}

function formatShortDay(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Standard GA4 properties often lag 24–48h. The 09:00 UTC cron is only a few
 * hours after midnight in US timezones, so property-local yesterday is often
 * still empty. If yesterday has no activity but earlier days do, report through
 * the prior day.
 */
function shouldDeferUnprocessedYesterday(
  yesterdayMetrics: SiteDayMetrics,
  yesterdayPoint: SiteDayPoint | undefined,
  priorPoints: SiteDayPoint[],
): boolean {
  if (
    dayHasActivity(yesterdayMetrics) ||
    (yesterdayPoint && dayHasActivity(yesterdayPoint))
  ) {
    return false;
  }
  return priorPoints.some(dayHasActivity);
}

async function resolveProperty(
  accessToken: string,
  accountId: string,
): Promise<ResolvedProperty> {
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

  return {
    propertyId,
    timeZone: property.timeZone?.trim() || DEFAULT_TIME_ZONE,
  };
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
  reportDay: string,
  previousDay: string,
): Promise<{
  yesterday: SiteDayMetrics;
  previous: SiteDayMetrics;
  monthToDate: SiteDayMetrics;
  monthToDatePrevious: SiteDayMetrics;
}> {
  const rangeNames = ["yesterday", "previous", "mtd", "mtdPrev"] as const;
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
          {
            startDate: monthStartOf(reportDay),
            endDate: reportDay,
            name: "mtd",
          },
          {
            startDate: monthStartOf(previousDay),
            endDate: previousDay,
            name: "mtdPrev",
          },
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
    monthToDatePrevious: byName.mtdPrev ?? emptyMetrics(),
  };
}

/** GA4 date dimension is YYYYMMDD → YYYY-MM-DD. */
function gaDateToIso(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function emptyDailySeries(endDate: string, days = SERIES_DAYS): SiteDayPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: addIsoDays(endDate, -(days - 1 - i)),
    activeUsers: 0,
    sessions: 0,
    screenPageViews: 0,
  }));
}

function sliceSeriesEndingOn(
  series: SiteDayPoint[],
  endDate: string,
  days = SERIES_DAYS,
): SiteDayPoint[] {
  const spine = emptyDailySeries(endDate, days);
  const byDate = new Map(series.map((point) => [point.date, point]));
  return spine.map((point) => byDate.get(point.date) ?? point);
}

async function fetchDailySeries(
  accessToken: string,
  propertyId: string,
  endDate: string,
  days = SERIES_LOOKAHEAD_DAYS,
): Promise<SiteDayPoint[]> {
  const startDate = addIsoDays(endDate, -(days - 1));
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
  return emptyDailySeries(endDate, days).map(
    (point) => byDate.get(point.date) ?? point,
  );
}

function siteShell(
  accountId: string,
  label: string,
  propertyId: string,
  timeZone: string,
  reportDay: string,
  error?: string,
): SiteAnalytics {
  const previousDate = addIsoDays(reportDay, -1);
  const monthStart = monthStartOf(reportDay);
  return {
    accountId,
    propertyId,
    label,
    date: reportDay,
    previousDate,
    monthStart,
    timeZone,
    metrics: emptyMetrics(),
    previous: emptyMetrics(),
    monthToDate: emptyMetrics(),
    dailySeries: emptyDailySeries(reportDay, SERIES_DAYS),
    error,
  };
}

async function collectOneSite(
  accessToken: string,
  accountId: string,
  label: string,
  now = new Date(),
): Promise<SiteAnalytics> {
  try {
    const { propertyId, timeZone } = await resolveProperty(
      accessToken,
      accountId,
    );
    try {
      const today = calendarDayInZone(now, timeZone);
      const yesterday = addIsoDays(today, -1);
      const previousDay = addIsoDays(today, -2);
      const [overview, dailySeries] = await Promise.all([
        fetchOverviewReport(accessToken, propertyId, yesterday, previousDay),
        fetchDailySeries(accessToken, propertyId, yesterday),
      ]);
      const {
        yesterday: yesterdayMetrics,
        previous,
        monthToDate,
        monthToDatePrevious,
      } = overview;

      const yesterdayPoint = dailySeries.find((point) => point.date === yesterday);
      const priorPoints = dailySeries.filter((point) => point.date < yesterday);
      const defer = shouldDeferUnprocessedYesterday(
        yesterdayMetrics,
        yesterdayPoint,
        priorPoints,
      );
      const reportDay = defer ? previousDay : yesterday;

      return {
        ...siteShell(accountId, label, propertyId, timeZone, reportDay),
        metrics: defer ? previous : yesterdayMetrics,
        previous: defer
          ? metricsFromPoint(
              dailySeries.find((point) => point.date === addIsoDays(reportDay, -1)),
            )
          : previous,
        monthToDate: defer ? monthToDatePrevious : monthToDate,
        dailySeries: sliceSeriesEndingOn(dailySeries, reportDay, SERIES_DAYS),
        freshnessNote: defer
          ? `GA4 has not finished processing ${formatShortDay(yesterday)} yet. Showing ${formatShortDay(reportDay)}.`
          : undefined,
      };
    } catch (error) {
      const today = calendarDayInZone(now, timeZone);
      return siteShell(
        accountId,
        label,
        propertyId,
        timeZone,
        addIsoDays(today, -1),
        error instanceof Error ? error.message : "Report failed",
      );
    }
  } catch (error) {
    const today = calendarDayInZone(now, DEFAULT_TIME_ZONE);
    return siteShell(
      accountId,
      label,
      "",
      DEFAULT_TIME_ZONE,
      addIsoDays(today, -1),
      error instanceof Error ? error.message : "Property resolve failed",
    );
  }
}

/**
 * Yesterday + month-to-date GA4 overview for configured accounts.
 * Returns [] when credentials are missing (section omitted from email).
 */
export async function collectSiteAnalytics(
  now = new Date(),
): Promise<SiteAnalytics[]> {
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
      collectOneSite(accessToken, account.accountId, account.label, now),
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
