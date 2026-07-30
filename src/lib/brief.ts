import { generateObject } from "ai";
import { z } from "zod";
import { getModel, PEOPLE, TICKERS, type TrendRegionId } from "@/lib/config";
import type { BriefSnapshot } from "@/lib/history";
import type { NewsItem, ResearchBundle } from "@/lib/research";
import { buildBriefTrends, type BriefTrends } from "@/lib/trends";

export const BULLET_FLAGS = ["Watch", "Noise", "Actionable"] as const;
export type BulletFlag = (typeof BULLET_FLAGS)[number];

export type BriefBullet = {
  text: string;
  flag: BulletFlag;
  sourceUrl?: string;
  sourceTitle?: string;
};

export type TickerBrief = {
  id: string;
  label: string;
  bullets: BriefBullet[];
  whyItMatters: string;
  overnightOpener: string;
  watchlistDelta: string;
};

export type PersonBrief = {
  id: string;
  name: string;
  summary: string;
  quote?: string;
  sourceUrl?: string;
};

export type EarningsEvent = {
  tickerId: string;
  label: string;
  event: string;
  when: string;
  sourceUrl?: string;
};

export type TrendMovers = {
  newToday: string[];
  stillRising: string[];
  fellOff: string[];
};

export type DailyBrief = {
  tickers: TickerBrief[];
  people: PersonBrief[];
  earningsCalendar: EarningsEvent[];
  themeOfTheDay: string;
  regionalPulse: string;
  trendMovers: TrendMovers;
  trends: BriefTrends;
  generatedAt: string;
  model: string;
  windowHours: number;
  catalystWindowHours: number;
  hasPreviousBrief: boolean;
};

const flagSchema = z.enum(BULLET_FLAGS);

const coreBriefSchema = z.object({
  tickers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      bullets: z.array(
        z.object({
          text: z.string(),
          flag: flagSchema,
          sourceIndex: z.number().int().optional(),
        }),
      ),
      whyItMatters: z.string(),
      overnightOpener: z.string(),
    }),
  ),
  people: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      quote: z.string().optional(),
      sourceIndex: z.number().int().optional(),
    }),
  ),
  earningsCalendar: z.array(
    z.object({
      tickerId: z.string(),
      event: z.string(),
      when: z.string(),
      sourceIndex: z.number().int().optional(),
    }),
  ),
});

const synthesisSchema = z.object({
  themeOfTheDay: z.string(),
  regionalPulse: z.string(),
  watchlistDelta: z.array(
    z.object({
      id: z.string(),
      delta: z.string(),
    }),
  ),
});

function formatIndexedNews(items: NewsItem[], limit = 5) {
  if (items.length === 0) return "- (no headlines in window)";
  return items
    .slice(0, limit)
    .map(
      (item, index) =>
        `- [${index}] ${item.publishedAt} | ${item.title}${item.source ? ` [${item.source}]` : ""} | ${item.link}`,
    )
    .join("\n");
}

function formatSources(bundle: ResearchBundle) {
  const lines: string[] = [];

  for (const ticker of TICKERS) {
    lines.push(`\n## ${ticker.label} (id=${ticker.id})`);
    lines.push(formatIndexedNews(bundle.tickers[ticker.id] ?? []));
  }

  for (const person of PEOPLE) {
    lines.push(`\n## ${person.name} (id=${person.id})`);
    lines.push(formatIndexedNews(bundle.people[person.id] ?? []));
  }

  lines.push(
    `\n## Catalyst / earnings headlines (last ${Math.round(bundle.catalystWindowHours / 24)} days)`,
  );
  for (const ticker of TICKERS) {
    lines.push(`\n### ${ticker.id}`);
    lines.push(formatIndexedNews(bundle.catalysts[ticker.id] ?? [], 6));
  }

  return lines.join("\n");
}

function resolveSource(
  items: NewsItem[] | undefined,
  sourceIndex: number | undefined,
): { sourceUrl?: string; sourceTitle?: string } {
  if (sourceIndex === undefined || !items?.length) return {};
  const item = items[sourceIndex];
  if (!item) return {};
  return { sourceUrl: item.link, sourceTitle: item.title };
}

function normalizeTitleKey(title: string) {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeTrendMovers(
  today: BriefTrends,
  previous: BriefSnapshot | null,
): TrendMovers {
  if (!previous?.trendTitles) {
    return { newToday: [], stillRising: [], fellOff: [] };
  }

  const todayByKey = new Map<string, string>();
  for (const region of today.regions) {
    for (const item of region.items) {
      const label = item.titleEn.trim() || item.title.trim();
      const key = normalizeTitleKey(label);
      if (key && !todayByKey.has(key)) todayByKey.set(key, label);
    }
  }

  const prevByKey = new Map<string, string>();
  for (const titles of Object.values(previous.trendTitles)) {
    for (const title of titles ?? []) {
      const key = normalizeTitleKey(title);
      if (key && !prevByKey.has(key)) prevByKey.set(key, title);
    }
  }

  const newToday: string[] = [];
  const stillRising: string[] = [];
  for (const [key, label] of todayByKey) {
    if (prevByKey.has(key)) stillRising.push(label);
    else newToday.push(label);
  }

  const fellOff: string[] = [];
  for (const [key, label] of prevByKey) {
    if (!todayByKey.has(key)) fellOff.push(label);
  }

  return {
    newToday: newToday.slice(0, 8),
    stillRising: stillRising.slice(0, 8),
    fellOff: fellOff.slice(0, 8),
  };
}

function formatPreviousForPrompt(previous: BriefSnapshot | null) {
  if (!previous) return "(no previous brief available)";

  const tickerLines = previous.tickers
    .map((t) => {
      const bullets = t.bullets.map((b) => `  - ${b}`).join("\n");
      return `${t.id}:\n${bullets}\n  why: ${t.whyItMatters}`;
    })
    .join("\n");

  const trendLines = (Object.entries(previous.trendTitles) as Array<
    [TrendRegionId, string[] | undefined]
  >)
    .map(([id, titles]) => `${id}: ${(titles ?? []).join("; ") || "(none)"}`)
    .join("\n");

  return `Previous brief at ${previous.generatedAt}
Theme: ${previous.themeOfTheDay || "(none)"}

Tickers:
${tickerLines}

Trend titles:
${trendLines}`;
}

function formatTodayForSynthesis(args: {
  tickers: TickerBrief[];
  people: PersonBrief[];
  trends: BriefTrends;
}) {
  const tickerLines = args.tickers
    .map((t) => {
      const bullets = t.bullets
        .map((b) => `  - [${b.flag}] ${b.text}`)
        .join("\n");
      return `${t.id}:\n${bullets}\n  why: ${t.whyItMatters}\n  overnight: ${t.overnightOpener}`;
    })
    .join("\n");

  const peopleLines = args.people
    .map((p) => {
      const quote = p.quote ? `\n  quote: ${p.quote}` : "";
      return `${p.name}: ${p.summary}${quote}`;
    })
    .join("\n");

  const trendLines = args.trends.regions
    .map((region) => {
      const items = region.items
        .map((item) => {
          const title = item.titleEn || item.title;
          const desc = item.descriptionEn ? ` — ${item.descriptionEn}` : "";
          return `#${item.rank} ${title}${desc}`;
        })
        .join("; ");
      return `${region.label}: ${items || "(none)"}`;
    })
    .join("\n");

  return `Today's tickers:
${tickerLines}

People:
${peopleLines}

Trends:
${trendLines}
Cross-region: ${args.trends.crossRegion.join(" · ") || "(none)"}`;
}

async function generateCoreBrief(bundle: ResearchBundle, model: string) {
  return generateObject({
    model,
    schema: coreBriefSchema,
    maxOutputTokens: 6144,
    // Keep thinking off so structured JSON is not truncated by reasoning tokens.
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    },
    system: `You are a concise market and tech briefing analyst.
Only use the provided headlines. Do not invent events, dates, prices, or quotes.
Prefer material news over rumor.

For each ticker:
- Return 3-5 short bullets (fewer is fine if coverage is thin). Each bullet ≤25 words.
- Tag every bullet with exactly one flag:
  - Actionable: concrete catalyst, result, guidance, product, regulatory, or deal news
  - Watch: developing story worth monitoring but not yet decisive
  - Noise: soft coverage, rumor, or low-signal chatter
- Set sourceIndex to the [n] index of the best supporting headline for that ticker when possible.
- whyItMatters: one sentence (≤28 words) synthesizing why today's coverage matters for that name.
- overnightOpener: one sentence (≤28 words) on overnight / pre-market / after-hours / crypto-session context from the headlines. If quiet, say so plainly. For BTC, treat it as a 24/7 session.

For each person:
- One short sentence about speeches/announcements, or exactly "None found".
- quote: only if a short attributed quote appears in the headlines; otherwise omit.
- sourceIndex: best supporting headline index when there is material news.

earningsCalendar:
- Only include events where the headlines explicitly mention earnings, investor day, product launch, guidance, or a dated catalyst in the next ~${Math.round(bundle.catalystWindowHours / 24)} days.
- Include any tracked ticker with a clear upcoming dated event in that window.
- when: use an explicit date from the headline when present; otherwise a short relative phrase like "This week" or "Date unclear".
- Do not invent calendar dates. Omit tickers with no clear catalyst.
- sourceIndex refers to the catalyst headline list for that tickerId.

Always include every requested ticker and person id.`,
    prompt: `Create today's brief from these sources collected at ${bundle.collectedAt}:
${formatSources(bundle)}

Return ticker ids exactly: ${TICKERS.map((t) => t.id).join(", ")}.
Return people ids exactly: ${PEOPLE.map((p) => p.id).join(", ")}.
Labels: ${TICKERS.map((t) => `${t.id}=${t.label}`).join("; ")}.
Names: ${PEOPLE.map((p) => `${p.id}=${p.name}`).join("; ")}.`,
  });
}

async function generateSynthesis(args: {
  model: string;
  previous: BriefSnapshot | null;
  tickers: TickerBrief[];
  people: PersonBrief[];
  trends: BriefTrends;
}) {
  return generateObject({
    model: args.model,
    schema: synthesisSchema,
    maxOutputTokens: 4096,
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    },
    system: `You write the cross-cutting synthesis for a daily market/tech email.
Only use the provided today/previous brief material. Do not invent facts.

themeOfTheDay: one sharp sentence (≤30 words) capturing the cross-cutting story across markets, people, and trends.

regionalPulse: 2-3 short sentences comparing what is hot in the United States vs Thailand vs Bulgaria today. Mention concrete trend topics when available.

watchlistDelta: one short sentence per ticker id about what changed vs yesterday's brief.
If no previous brief exists, use exactly: "First brief — no prior day to compare."
If little changed, say so. Do not invent moves.`,
    prompt: `${formatPreviousForPrompt(args.previous)}

---

${formatTodayForSynthesis({
  tickers: args.tickers,
  people: args.people,
  trends: args.trends,
})}

Return watchlistDelta ids exactly: ${TICKERS.map((t) => t.id).join(", ")}.`,
  });
}

function normalizeCore(
  object: z.infer<typeof coreBriefSchema>,
  bundle: ResearchBundle,
): {
  tickers: Omit<TickerBrief, "watchlistDelta">[];
  people: PersonBrief[];
  earningsCalendar: EarningsEvent[];
} {
  const tickers = TICKERS.map((ticker) => {
    const found = object.tickers.find((t) => t.id === ticker.id);
    const sourceItems = bundle.tickers[ticker.id] ?? [];
    const bullets = (found?.bullets ?? [])
      .map((b) => {
        const text = b.text.trim();
        if (!text) return null;
        const source = resolveSource(sourceItems, b.sourceIndex);
        return {
          text,
          flag: b.flag,
          ...source,
        } satisfies BriefBullet;
      })
      .filter((b): b is BriefBullet => Boolean(b))
      .slice(0, 5);

    return {
      id: ticker.id,
      label: ticker.label,
      bullets:
        bullets.length > 0
          ? bullets
          : [
              {
                text: "No material headlines in the last 24 hours.",
                flag: "Noise" as const,
              },
            ],
      whyItMatters:
        found?.whyItMatters?.trim() || "Limited coverage in the last 24 hours.",
      overnightOpener:
        found?.overnightOpener?.trim() ||
        "Quiet overnight — no notable session headlines.",
    };
  });

  const people = PEOPLE.map((person) => {
    const found = object.people.find((p) => p.id === person.id);
    const summary = found?.summary?.trim() || "None found";
    const source = resolveSource(
      bundle.people[person.id],
      found?.sourceIndex,
    );
    const quote = found?.quote?.trim() || undefined;
    return {
      id: person.id,
      name: person.name,
      summary,
      quote: quote && summary.toLowerCase() !== "none found" ? quote : undefined,
      sourceUrl:
        summary.toLowerCase() === "none found" ? undefined : source.sourceUrl,
    };
  });

  const earningsCalendar: EarningsEvent[] = [];
  for (const entry of object.earningsCalendar ?? []) {
    const ticker = TICKERS.find((t) => t.id === entry.tickerId);
    if (!ticker) continue;
    const event = entry.event.trim();
    const when = entry.when.trim();
    if (!event || !when) continue;
    const source = resolveSource(
      bundle.catalysts[ticker.id],
      entry.sourceIndex,
    );
    earningsCalendar.push({
      tickerId: ticker.id,
      label: ticker.label,
      event,
      when,
      sourceUrl: source.sourceUrl,
    });
  }

  return { tickers, people, earningsCalendar: earningsCalendar.slice(0, 10) };
}

export async function generateDailyBrief(
  bundle: ResearchBundle,
  previous: BriefSnapshot | null = null,
): Promise<DailyBrief> {
  const model = getModel();

  const [coreResult, trends] = await Promise.all([
    generateCoreBrief(bundle, model),
    buildBriefTrends(bundle),
  ]);

  const core = normalizeCore(coreResult.object, bundle);
  const trendMovers = computeTrendMovers(trends, previous);

  const synthesisResult = await generateSynthesis({
    model,
    previous,
    tickers: core.tickers.map((t) => ({
      ...t,
      watchlistDelta: "",
    })),
    people: core.people,
    trends,
  });

  const deltaById = new Map(
    synthesisResult.object.watchlistDelta.map((d) => [
      d.id,
      d.delta.trim(),
    ]),
  );

  const defaultDelta = previous
    ? "Little change vs prior brief."
    : "First brief — no prior day to compare.";

  const tickers: TickerBrief[] = core.tickers.map((t) => ({
    ...t,
    watchlistDelta: deltaById.get(t.id) || defaultDelta,
  }));

  return {
    model,
    windowHours: bundle.windowHours,
    catalystWindowHours: bundle.catalystWindowHours,
    generatedAt: new Date().toISOString(),
    trends,
    trendMovers,
    hasPreviousBrief: Boolean(previous),
    themeOfTheDay:
      synthesisResult.object.themeOfTheDay.trim() ||
      "A quiet session across markets and trends.",
    regionalPulse:
      synthesisResult.object.regionalPulse.trim() ||
      "Regional trend coverage was thin today.",
    tickers,
    people: core.people,
    earningsCalendar: core.earningsCalendar,
  };
}
