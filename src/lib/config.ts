export const TICKERS = [
  {
    id: "TSLA",
    label: "Tesla (TSLA)",
    query: "TSLA OR Tesla stock",
    earningsSymbol: "TSLA",
    quoteSymbol: "TSLA",
    tradingViewSymbol: "NASDAQ:TSLA",
  },
  {
    id: "MU",
    label: "Micron (MU)",
    query: "MU OR Micron Technology stock",
    earningsSymbol: "MU",
    quoteSymbol: "MU",
    tradingViewSymbol: "NASDAQ:MU",
  },
  {
    id: "META",
    label: "Meta (META)",
    query: "META OR Meta Platforms stock",
    earningsSymbol: "META",
    quoteSymbol: "META",
    tradingViewSymbol: "NASDAQ:META",
  },
  {
    id: "BTC",
    label: "Bitcoin (BTC)",
    query: "Bitcoin OR BTC crypto",
    earningsSymbol: null,
    quoteSymbol: "BTC-USD",
    tradingViewSymbol: "COINBASE:BTCUSD",
  },
  {
    id: "AVGO",
    label: "Broadcom (AVGO)",
    query: "AVGO OR Broadcom stock",
    earningsSymbol: "AVGO",
    quoteSymbol: "AVGO",
    tradingViewSymbol: "NASDAQ:AVGO",
  },
  {
    id: "CRCL",
    label: "Circle (CRCL)",
    query: "CRCL OR Circle Internet Group stock",
    earningsSymbol: "CRCL",
    quoteSymbol: "CRCL",
    tradingViewSymbol: "NYSE:CRCL",
  },
  {
    id: "SPCX",
    label: "SpaceX (SPCX)",
    query: "SPCX OR SpaceX stock OR Space Exploration Technologies",
    earningsSymbol: "SPCX",
    quoteSymbol: "SPCX",
    tradingViewSymbol: "NASDAQ:SPCX",
  },
  {
    id: "MSFT",
    label: "Microsoft (MSFT)",
    query: "MSFT OR Microsoft stock",
    earningsSymbol: "MSFT",
    quoteSymbol: "MSFT",
    tradingViewSymbol: "NASDAQ:MSFT",
  },
  {
    id: "WQTM",
    label: "WisdomTree Quantum (WQTM)",
    query: "WQTM OR WisdomTree Quantum Computing ETF",
    earningsSymbol: null,
    quoteSymbol: "WQTM",
    tradingViewSymbol: "CBOE:WQTM",
  },
] as const;

/** Local/dev fallback when MARKETS_PAGE_SECRET is unset (never used in production). */
export const DEV_MARKETS_PAGE_SECRET = "dev-markets-secret";

export function getMarketsPageSecret(): string | null {
  const fromEnv = process.env.MARKETS_PAGE_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV !== "production") return DEV_MARKETS_PAGE_SECRET;
  return null;
}

/** Public site origin for email deep links. */
export function getAppBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    return production.startsWith("http")
      ? production.replace(/\/$/, "")
      : `https://${production.replace(/\/$/, "")}`;
  }

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    return vercel.startsWith("http")
      ? vercel.replace(/\/$/, "")
      : `https://${vercel.replace(/\/$/, "")}`;
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3000";
  }

  return null;
}

/** Secret markets brief URL for the email CTA, or null if not configured. */
export function getMarketsPageUrl(): string | null {
  const secret = getMarketsPageSecret();
  const base = getAppBaseUrl();
  if (!secret || !base) return null;
  return `${base}/markets/${encodeURIComponent(secret)}`;
}

export const PEOPLE = [
  { id: "karpathy", name: "Andrej Karpathy", query: "Andrej Karpathy", pickCount: 1 },
  { id: "huang", name: "Jensen Huang", query: "Jensen Huang NVIDIA", pickCount: 1 },
  { id: "karp", name: "Alex Karp", query: "Alex Karp Palantir", pickCount: 1 },
  { id: "altman", name: "Sam Altman", query: "Sam Altman OpenAI", pickCount: 1 },
  {
    id: "musk",
    name: "Elon Musk",
    query: "Elon Musk",
    pickCount: 2,
    social: "x",
    handle: "elonmusk",
  },
  {
    id: "trump",
    name: "Donald Trump",
    query: "Donald Trump",
    pickCount: 2,
    social: "truth",
    handle: "realDonaldTrump",
  },
] as const;

export type PersonConfig = (typeof PEOPLE)[number];

/** Headlines kept per person so the model can pick one market-moving remark */
export const PERSON_NEWS_LIMIT = 24;

/** Own posts kept per social account for the model to choose from */
export const SOCIAL_POST_LIMIT = 40;

export function personPickCount(person: PersonConfig): number {
  return person.pickCount;
}

export function personSocial(
  person: PersonConfig,
): "x" | "truth" | undefined {
  if ("social" in person && (person.social === "x" || person.social === "truth")) {
    return person.social;
  }
  return undefined;
}

export function personHandle(person: PersonConfig): string | undefined {
  if ("handle" in person && typeof person.handle === "string") {
    return person.handle;
  }
  return undefined;
}

/** Google Trends RSS regions shown in the daily brief */
export const TREND_REGIONS = [
  { id: "us", label: "United States", geo: "US", limit: 10 },
  /** Pool size; the brief keeps the 3 most important after the English pass */
  { id: "thailand", label: "Thailand", geo: "TH", limit: 6 },
] as const;

export type TrendRegionId = (typeof TREND_REGIONS)[number]["id"];

/** Subreddits included in the daily brief (top posts, no LLM) */
export const REDDIT_SUBREDDITS = [
  { id: "pics", limit: 6 },
  { id: "generativeAI", limit: 6 },
  { id: "CursedAI", limit: 6 },
  { id: "aiArt", limit: 6 },
] as const;

export type RedditSubredditId = (typeof REDDIT_SUBREDDITS)[number]["id"];

/** GA4 accounts in the Google Analytics email section (display order) */
export const GA_ACCOUNTS = [
  { accountId: "292152311", label: "uwhmap.com" },
  { accountId: "390992554", label: "greetingcardfun.com" },
  { accountId: "220211668", label: "tvroulette.app" },
] as const;

export type GaAccountId = (typeof GA_ACCOUNTS)[number]["accountId"];

/** Free-tier-friendly Gateway model with reliable structured output */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";

/** Flag metrics in the daily email when used/limit is at or above this % */
export const USAGE_WATCH_THRESHOLD = 50;

/** Default AI Gateway free monthly credit allowance (USD) */
export const AI_GATEWAY_MONTHLY_BUDGET_USD = 5;

/** Hobby Blob included storage (1 GB, SI) for near-limit watch */
export const BLOB_HOBBY_STORAGE_BYTES = 1_000_000_000;

/** Hobby Blob included operations (per month / rolling window) */
export const BLOB_HOBBY_SIMPLE_OPS = 10_000;
export const BLOB_HOBBY_ADVANCED_OPS = 2_000;

/** Hobby Fast Data Transfer included (100 GB, SI — matches the Usage dashboard) */
export const HOBBY_FAST_DATA_TRANSFER_BYTES = 100_000_000_000;

/** Hobby Edge Requests included */
export const HOBBY_EDGE_REQUESTS = 1_000_000;

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

  return `Daily Emails <${from}>`;
}
