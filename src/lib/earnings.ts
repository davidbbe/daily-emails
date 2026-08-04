import { TICKERS } from "@/lib/config";

export type EarningsDates = {
  tickerId: string;
  previousDate?: string;
  nextDate?: string;
  nextConfirmed?: boolean;
};

type StockAnalysisEarningsRow = {
  date?: string;
  confirmed?: boolean;
  eps_actual?: number | null;
};

function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function isReported(row: StockAnalysisEarningsRow, date: Date, today: Date) {
  if (row.eps_actual != null) return true;
  return date.getTime() < today.getTime();
}

async function fetchSymbolEarnings(
  symbol: string,
): Promise<Omit<EarningsDates, "tickerId"> | null> {
  const url = `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(symbol.toLowerCase())}/earnings`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "daily-emails-brief/1.0",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`earnings: ${symbol} HTTP ${response.status}`);
      return null;
    }

    const json = (await response.json()) as {
      data?: StockAnalysisEarningsRow[];
    };
    const rows = Array.isArray(json.data) ? json.data : [];
    if (rows.length === 0) return null;

    const today = todayUtc();
    const dated = rows
      .map((row) => {
        if (!row.date) return null;
        const date = parseDateOnly(row.date);
        if (!date) return null;
        return { row, date, iso: row.date.slice(0, 10) };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const previous = dated
      .filter((entry) => isReported(entry.row, entry.date, today))
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];

    const next = dated
      .filter((entry) => !isReported(entry.row, entry.date, today))
      .sort((a, b) => a.date.getTime() - b.date.getTime())[0];

    if (!previous && !next) return null;

    return {
      previousDate: previous?.iso,
      nextDate: next?.iso,
      nextConfirmed: next ? Boolean(next.row.confirmed) : undefined,
    };
  } catch (error) {
    console.warn(`earnings: fetch failed for ${symbol}`, error);
    return null;
  }
}

/** Previous + next report dates for tickers with an earningsSymbol. */
export async function collectEarningsCalendar(): Promise<EarningsDates[]> {
  const results: EarningsDates[] = [];
  await Promise.all(
    TICKERS.map(async (ticker) => {
      if (!ticker.earningsSymbol) return;
      const dates = await fetchSymbolEarnings(ticker.earningsSymbol);
      if (!dates) return;
      results.push({ tickerId: ticker.id, ...dates });
    }),
  );

  const order = new Map<string, number>(
    TICKERS.map((ticker, index) => [ticker.id, index]),
  );
  results.sort(
    (a, b) => (order.get(a.tickerId) ?? 0) - (order.get(b.tickerId) ?? 0),
  );
  return results;
}
