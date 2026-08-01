export const TICKERS = [
  { id: "TSLA", label: "Tesla (TSLA)", query: "TSLA OR Tesla stock" },
  { id: "MU", label: "Micron (MU)", query: "MU OR Micron Technology stock" },
  { id: "META", label: "Meta (META)", query: "META OR Meta Platforms stock" },
  { id: "BTC", label: "Bitcoin (BTC)", query: "Bitcoin OR BTC crypto" },
  { id: "AVGO", label: "Broadcom (AVGO)", query: "AVGO OR Broadcom stock" },
  { id: "CRCL", label: "Circle (CRCL)", query: "CRCL OR Circle Internet stock OR Circle IPO" },
  { id: "SPCX", label: "SpaceX (SPCX)", query: "SPCX OR SpaceX stock OR Space Exploration Technologies" },
  { id: "MSFT", label: "Microsoft (MSFT)", query: "MSFT OR Microsoft stock" },
] as const;

export const PEOPLE = [
  { id: "karpathy", name: "Andrej Karpathy", query: "Andrej Karpathy" },
  { id: "huang", name: "Jensen Huang", query: "Jensen Huang NVIDIA" },
  { id: "karp", name: "Alex Karp", query: "Alex Karp Palantir" },
  { id: "altman", name: "Sam Altman", query: "Sam Altman OpenAI" },
] as const;

/** Google Trends RSS regions shown in the daily brief */
export const TREND_REGIONS = [
  { id: "us", label: "United States", geo: "US", limit: 10 },
  { id: "thailand", label: "Thailand", geo: "TH", limit: 3 },
  { id: "bulgaria", label: "Bulgaria", geo: "BG", limit: 3 },
] as const;

export type TrendRegionId = (typeof TREND_REGIONS)[number]["id"];

/** Free-tier-friendly Gateway model with reliable structured output */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";

/** Flag metrics in the daily email when used/limit is at or above this % */
export const USAGE_WATCH_THRESHOLD = 50;

/** Default AI Gateway free monthly credit allowance (USD) */
export const AI_GATEWAY_MONTHLY_BUDGET_USD = 5;

/** Hobby Blob included storage (1 GB) for near-limit watch */
export const BLOB_HOBBY_STORAGE_BYTES = 1 * 1024 * 1024 * 1024;

/** Hobby Blob included operations (per month / rolling window) */
export const BLOB_HOBBY_SIMPLE_OPS = 10_000;
export const BLOB_HOBBY_ADVANCED_OPS = 2_000;

/** Hobby Fast Origin Transfer included (10 GB) */
export const HOBBY_FAST_ORIGIN_TRANSFER_BYTES = 10 * 1024 * 1024 * 1024;

/** Hobby Function Invocations included */
export const HOBBY_FUNCTION_INVOCATIONS = 1_000_000;

/** Resend free-plan email quotas */
export const RESEND_DAILY_LIMIT = 100;
export const RESEND_MONTHLY_LIMIT = 3000;

export function getModel() {
  return process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
}

export function getEmailTo() {
  return process.env.EMAIL_TO?.trim() || "streethouse4@gmail.com";
}

export function getEmailFrom() {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    throw new Error("EMAIL_FROM is required");
  }

  // Allow either "noreply@domain.com" or a full "Name <noreply@domain.com>" value.
  if (from.includes("<") && from.includes(">")) {
    return from;
  }

  return `Agent Dave <${from}>`;
}
