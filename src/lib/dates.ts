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
