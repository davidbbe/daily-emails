import { generateObject } from "ai";
import { z } from "zod";
import {
  getModel,
  PEOPLE,
  PERSON_NEWS_LIMIT,
  TICKERS,
  personPickCount,
  personSocial,
} from "@/lib/config";
import type { BriefSnapshot } from "@/lib/history";
import type { SiteAnalytics } from "@/lib/analytics";
import type { NewsItem, ResearchBundle } from "@/lib/research";
import type { RedditSubFeed } from "@/lib/reddit";
import type { SentimentReport } from "@/lib/sentiment";
import { buildBriefTrends, type BriefTrends } from "@/lib/trends";
import { emptyInsiderBrief, type InsiderBrief } from "@/lib/openinsider";
import { annotateValuation, type TickerValuation } from "@/lib/valuation";
import { buildWhaleBrief, type WhaleBrief } from "@/lib/whale-brief";

export const BULLET_FLAGS = ["Watch", "Noise", "Actionable"] as const;
export type BulletFlag = (typeof BULLET_FLAGS)[number];

export type BriefBullet = {
  text: string;
  flag: BulletFlag;
  sourceUrl?: string;
  sourceTitle?: string;
  /** Short publisher name, e.g. Reuters */
  sourceName?: string;
};

export type TickerBrief = {
  id: string;
  label: string;
  bullets: BriefBullet[];
  whyItMatters: string;
  overnightOpener: string;
};

export type PersonItem = {
  summary: string;
  quote?: string;
  sourceUrl?: string;
  sourceName?: string;
};

export type PersonBrief = {
  id: string;
  name: string;
  items: PersonItem[];
  summary: string;
  quote?: string;
  sourceUrl?: string;
};

export function isMaterialPersonSummary(summary: string | undefined): boolean {
  const text = summary?.trim() ?? "";
  return text.length > 0 && text.toLowerCase() !== "none found";
}

export function materialPersonItems(
  person: PersonBrief | undefined,
): PersonItem[] {
  if (!person) return [];
  const fromItems = (person.items ?? []).filter((item) =>
    isMaterialPersonSummary(item.summary),
  );
  if (fromItems.length > 0) return fromItems;
  if (!isMaterialPersonSummary(person.summary)) return [];
  return [
    {
      summary: person.summary.trim(),
      quote: person.quote,
      sourceUrl: person.sourceUrl,
    },
  ];
}

export type EarningsEvent = {
  tickerId: string;
  label: string;
  previousDate?: string;
  nextDate?: string;
  nextConfirmed?: boolean;
};

export type DailyBrief = {
  tickers: TickerBrief[];
  people: PersonBrief[];
  earningsCalendar: EarningsEvent[];
  trends: BriefTrends;
  /** Top Reddit posts — pass-through, no LLM */
  reddit: RedditSubFeed[];
  /** GA4 site overviews — pass-through, no LLM */
  sites: SiteAnalytics[];
  /** Fear & greed meters + per-ticker proxies — pass-through, no LLM */
  sentiment: SentimentReport;
  /** Open-market Form 4 buys/sells for the hosted markets page */
  insiders: InsiderBrief;
  /** Superinvestor 13F briefing for the hosted markets page */
  whales: WhaleBrief;
  /** Value multiples for listed equity tickers, plus a short LLM take */
  valuation: TickerValuation[];
  generatedAt: string;
  model: string;
  windowHours: number;
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
      summary: z.string().optional(),
      quote: z.string().optional(),
      sourceIndex: z.number().int().optional(),
      items: z
        .array(
          z.object({
            summary: z.string(),
            quote: z.string().optional(),
            sourceIndex: z.number().int().optional(),
          }),
        )
        .optional(),
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
    const social = personSocial(person);
    const kind =
      social === "x"
        ? "own X posts from the last 24 hours"
        : social === "truth"
          ? "own Truth Social posts from the last 24 hours"
          : "headlines";
    lines.push(
      `\n## ${person.name} (id=${person.id}) — ${kind}; pick up to ${personPickCount(person)}`,
    );
    const items = bundle.people[person.id] ?? [];
    lines.push(formatIndexedNews(items, Math.max(PERSON_NEWS_LIMIT, items.length)));
  }

  return lines.join("\n");
}

function resolveSource(
  items: NewsItem[] | undefined,
  sourceIndex: number | undefined,
): { sourceUrl?: string; sourceTitle?: string; sourceName?: string } {
  if (sourceIndex === undefined || !items?.length) return {};
  const item = items[sourceIndex];
  if (!item) return {};
  return {
    sourceUrl: item.link,
    sourceTitle: item.title,
    sourceName: item.source,
  };
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
- Read every item in that person's list before choosing. High-volume speakers often have many items — do not stop at the first one.
- Elon Musk and Donald Trump lists are THEIR OWN posts (X / Truth Social) from the last 24 hours. Choose up to TWO posts most likely to move stock or crypto prices (policy, regulation, tariffs, rates, company guidance, products, deals, Tesla/SpaceX/xAI, Bitcoin, etc.). Prefer two distinct topics. Always set sourceIndex so the original post can be linked.
- Everyone else: include them only if they themselves said, posted, or announced something in this window. Choose at most ONE item.
- Each item: one short sentence (what they said and why it could matter for markets). Do not round up several remarks into one item.
- If nothing they said is market-significant, return items: [] and summary exactly "None found". Do not stretch gossip, campaign color, or coverage that is merely about them.
- quote: a short attributed quote of that chosen post/statement when the text is available; otherwise omit.
- sourceIndex: the [n] index of the chosen post/headline.

Always include every requested ticker and person id.
Return each person as { id, name, items: [{ summary, quote, sourceIndex }] }.`,
    prompt: `Create today's brief from these sources collected at ${bundle.collectedAt}:
${formatSources(bundle)}

Return ticker ids exactly: ${TICKERS.map((t) => t.id).join(", ")}.
Return people ids exactly: ${PEOPLE.map((p) => p.id).join(", ")}.
Labels: ${TICKERS.map((t) => `${t.id}=${t.label}`).join("; ")}.
Names: ${PEOPLE.map((p) => `${p.id}=${p.name}`).join("; ")}.
    Person item limits: ${PEOPLE.map((p) => `${p.id}≤${personPickCount(p)}`).join("; ")}.`,
  });
}

function normalizeCore(
  object: z.infer<typeof coreBriefSchema>,
  bundle: ResearchBundle,
): {
  tickers: TickerBrief[];
  people: PersonBrief[];
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

  const people = PEOPLE.flatMap((person) => {
    const found = object.people.find((p) => p.id === person.id);
    const rawItems =
      found?.items && found.items.length > 0
        ? found.items
        : found?.summary
          ? [
              {
                summary: found.summary,
                quote: found.quote,
                sourceIndex: found.sourceIndex,
              },
            ]
          : [];

    const items = rawItems
      .flatMap((item) => {
        const summary = item.summary?.trim() || "";
        if (!isMaterialPersonSummary(summary)) return [];
        const source = resolveSource(
          bundle.people[person.id],
          item.sourceIndex,
        );
        const next: PersonItem = { summary };
        const quote = item.quote?.trim();
        if (quote) next.quote = quote;
        if (source.sourceUrl) next.sourceUrl = source.sourceUrl;
        if (source.sourceName) next.sourceName = source.sourceName;
        return [next];
      })
      .slice(0, personPickCount(person));

    if (items.length === 0) return [];

    return [
      {
        id: person.id,
        name: person.name,
        items,
        summary: items[0].summary,
        quote: items[0].quote,
        sourceUrl: items[0].sourceUrl,
      } satisfies PersonBrief,
    ];
  });

  return { tickers, people };
}

function mapEarningsCalendar(bundle: ResearchBundle): EarningsEvent[] {
  const events: EarningsEvent[] = [];
  for (const entry of bundle.earnings) {
    const ticker = TICKERS.find((t) => t.id === entry.tickerId);
    if (!ticker) continue;
    if (!entry.previousDate && !entry.nextDate) continue;
    events.push({
      tickerId: ticker.id,
      label: ticker.label,
      previousDate: entry.previousDate,
      nextDate: entry.nextDate,
      nextConfirmed: entry.nextConfirmed,
    });
  }
  return events;
}

export async function generateDailyBrief(
  bundle: ResearchBundle,
  previous: BriefSnapshot | null = null,
): Promise<DailyBrief> {
  const model = getModel();

  const [coreResult, trends, whales, valuation] = await Promise.all([
    generateCoreBrief(bundle, model),
    buildBriefTrends(bundle),
    buildWhaleBrief(bundle.whales),
    annotateValuation(bundle.valuation ?? []),
  ]);

  const core = normalizeCore(coreResult.object, bundle);

  const sentiment = bundle.sentiment ?? {
    collectedAt: bundle.collectedAt,
    meters: [],
    tickers: [],
    valueDial:
      "Sentiment meters unavailable today — rely on valuation and catalysts.",
  };

  return {
    model,
    windowHours: bundle.windowHours,
    generatedAt: new Date().toISOString(),
    trends,
    reddit: bundle.reddit ?? [],
    sites: bundle.sites ?? [],
    sentiment,
    insiders: bundle.insiders ?? emptyInsiderBrief("Insider trades were not collected"),
    whales,
    valuation,
    hasPreviousBrief: Boolean(previous),
    tickers: core.tickers,
    people: core.people,
    earningsCalendar: mapEarningsCalendar(bundle),
  };
}
