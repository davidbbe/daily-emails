const EASTERN = "America/New_York";

/** Title date like "Aug 15, 2026". */
export function formatTitleDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function calendarDayInZone(date: Date, timeZone = EASTERN) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Shift a YYYY-MM-DD calendar date by a whole number of days. */
export function addIsoDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStartOf(isoDate: string): string {
  return `${isoDate.slice(0, 8)}01`;
}

export function formatTimeZoneAbbr(
  timeZone: string,
  at: Date | string = new Date(),
): string {
  const date = typeof at === "string" ? new Date(`${at}T12:00:00.000Z`) : at;
  if (Number.isNaN(date.getTime())) return timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

function isoDay(value: string): string | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Relative label for a YYYY-MM-DD calendar date ("yesterday", "3 days ago"). */
export function formatRelativeDay(value: string, now = new Date()) {
  const day = isoDay(value);
  if (!day) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : formatTitleDate(parsed);
  }

  const today = calendarDayInZone(now);
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      86_400_000,
  );
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days >= 2 && days < 7) return `${days} days ago`;

  const date = new Date(`${day}T16:00:00Z`);
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return formatTitleDate(date);
}

/** Human-readable UTC date for email / usage copy (e.g. "26 Jul 2026, 16:51 UTC"). */
export function formatHumanDate(
  value: string | Date,
  options?: { withTime?: boolean },
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const withTime = options?.withTime !== false;
  if (!withTime) {
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
