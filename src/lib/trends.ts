import { generateObject } from "ai";
import { z } from "zod";
import { getModel, TREND_REGIONS, type TrendRegionId } from "@/lib/config";
import type { ResearchBundle, TrendItem } from "@/lib/research";

export type BriefTrendItem = {
  rank: number;
  title: string;
  titleEn: string;
  approxTraffic: string;
  descriptionEn?: string;
  newsTitle?: string;
  newsTitleEn?: string;
  newsUrl?: string;
  newsSource?: string;
};

export type BriefTrends = {
  regions: Array<{
    id: TrendRegionId;
    label: string;
    items: BriefTrendItem[];
    /** English prose summary for Thailand / Bulgaria (no item list in email) */
    summary?: string;
  }>;
  crossRegion: string[];
};

/** Regions shown as an AI English summary of the top trends (not a list) */
const SUMMARIZED_REGIONS = new Set<TrendRegionId>(["thailand", "bulgaria"]);

const translationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      titleEn: z.string(),
      newsTitleEn: z.string().optional(),
    }),
  ),
});

const localSummarySchema = z.object({
  regions: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          titleEn: z.string(),
        }),
      ),
    }),
  ),
});

/** Non-Latin scripts that almost always need English translation */
export function looksNonEnglish(text: string): boolean {
  return /[\u0400-\u04FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0600-\u06FF\u0590-\u05FF]/.test(
    text,
  );
}

function normalizeTitleKey(title: string) {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

type Enrichment = {
  titleEn: string;
  newsTitleEn?: string;
  descriptionEn?: string;
};

async function translateUsItems(
  bundle: ResearchBundle,
): Promise<Map<string, Enrichment>> {
  const map = new Map<string, Enrichment>();
  const jobs: Array<{ id: string; title: string; newsTitle?: string }> = [];

  const items = bundle.trends.us ?? [];
  items.forEach((item, index) => {
    const titleNeeds = looksNonEnglish(item.title);
    const newsNeeds = Boolean(item.newsTitle && looksNonEnglish(item.newsTitle));
    if (!titleNeeds && !newsNeeds) return;
    jobs.push({
      id: `us:${index}`,
      title: item.title,
      newsTitle: newsNeeds ? item.newsTitle : undefined,
    });
  });

  if (jobs.length === 0) return map;

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: translationSchema,
      maxOutputTokens: 4096,
      // Gemini 2.5 Flash burns thinking tokens against maxOutputTokens; disable
      // so structured JSON is not truncated (finishReason: length).
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 0 } },
      },
      system: `You translate Google Trends search queries and related news headlines into clear, concise English.
Translate literally — do not invent context or explain.
Keep proper nouns when they are already Latin-script names.
Return every requested id exactly once.
If newsTitleEn is not needed (no news title provided), omit it.`,
      prompt: `Translate these trend strings to English:
${jobs
  .map((job) => {
    const news = job.newsTitle ? `\n  news: ${job.newsTitle}` : "";
    return `- id=${job.id}\n  title: ${job.title}${news}`;
  })
  .join("\n")}`,
    });

    for (const item of object.items) {
      map.set(item.id, {
        titleEn: item.titleEn.trim() || item.id,
        newsTitleEn: item.newsTitleEn?.trim() || undefined,
      });
    }
  } catch (error) {
    console.warn("trends: US translation failed; using original titles", error);
  }

  return map;
}

type LocalSummaryResult = {
  enrichments: Map<string, Enrichment>;
  summaries: Map<TrendRegionId, string>;
};

async function summarizeLocalTrends(
  bundle: ResearchBundle,
): Promise<LocalSummaryResult> {
  const enrichments = new Map<string, Enrichment>();
  const summaries = new Map<TrendRegionId, string>();

  const regionJobs = [...SUMMARIZED_REGIONS]
    .map((regionId) => {
      const items = (bundle.trends[regionId] ?? []).slice(0, 3);
      return { regionId, items };
    })
    .filter((job) => job.items.length > 0);

  if (regionJobs.length === 0) return { enrichments, summaries };

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: localSummarySchema,
      maxOutputTokens: 4096,
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 0 } },
      },
      system: `You write English-only trend summaries for a daily email brief.
For each country region:
- summary: 2–4 short English sentences covering the top trends and why each is rising. Ground claims only in the provided titles, traffic, and news headlines. Do not invent facts. If news is missing, say the topic is searching highly without detailing a cause.
- items: one English titleEn per trend id (translate the search query; keep proper nouns). Needed for matching across regions.

CRITICAL language rules:
- Output MUST be entirely in English.
- Never include Thai, Bulgarian, Cyrillic, or any non-English text — not even in parentheses.
- Translate all local terms; keep globally known proper nouns in Latin script.`,
      prompt: `Summarize the top trends for each region (English only):
${regionJobs
  .map((job) => {
    const lines = job.items
      .map((item, index) => {
        const news = item.newsTitle
          ? `\n    news: ${item.newsTitle}`
          : "\n    news: (none)";
        const traffic = item.approxTraffic
          ? `\n    traffic: ${item.approxTraffic}`
          : "";
        return `  - id=${job.regionId}:${index}\n    title: ${item.title}${traffic}${news}`;
      })
      .join("\n");
    return `## ${job.regionId}\n${lines}`;
  })
  .join("\n\n")}`,
    });

    for (const region of object.regions) {
      const regionId = region.id as TrendRegionId;
      if (!SUMMARIZED_REGIONS.has(regionId)) continue;
      const summary = region.summary.trim();
      if (summary) summaries.set(regionId, summary);
      for (const item of region.items) {
        enrichments.set(item.id, {
          titleEn: item.titleEn.trim() || item.id,
        });
      }
    }
  } catch (error) {
    console.warn(
      "trends: local summary failed; using original titles",
      error,
    );
  }

  return { enrichments, summaries };
}

function toBriefItem(
  item: TrendItem,
  rank: number,
  enrichment?: Enrichment,
): BriefTrendItem {
  const titleEn = enrichment?.titleEn?.trim() || item.title;
  let newsTitleEn = enrichment?.newsTitleEn?.trim();
  if (!newsTitleEn && item.newsTitle && !looksNonEnglish(item.newsTitle)) {
    newsTitleEn = item.newsTitle;
  }

  return {
    rank,
    title: item.title,
    titleEn,
    approxTraffic: item.approxTraffic || "—",
    descriptionEn: enrichment?.descriptionEn?.trim() || undefined,
    newsTitle: item.newsTitle,
    newsTitleEn,
    newsUrl: item.newsUrl,
    newsSource: item.newsSource,
  };
}

function computeCrossRegion(regions: BriefTrends["regions"]): string[] {
  const counts = new Map<string, { label: string; regions: Set<string> }>();

  for (const region of regions) {
    for (const item of region.items) {
      const key = normalizeTitleKey(item.titleEn || item.title);
      if (!key) continue;
      // Skip keys that still look non-English so the email never lists them
      if (looksNonEnglish(key)) continue;
      const entry = counts.get(key) ?? {
        label: item.titleEn || item.title,
        regions: new Set<string>(),
      };
      entry.regions.add(region.id);
      counts.set(key, entry);
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.regions.size >= 2)
    .map((entry) => entry.label)
    .filter((label) => !looksNonEnglish(label))
    .slice(0, 8);
}

function fallbackLocalSummary(items: BriefTrendItem[]): string {
  if (items.length === 0) return "No trends available today.";
  const topics = items
    .slice(0, 3)
    .map((item) => item.titleEn.trim() || item.title.trim())
    .filter((t) => t && !looksNonEnglish(t));
  if (topics.length === 0) {
    return "Trend topics could not be translated to English today.";
  }
  return `Top searches today include ${topics.join(", ")}.`;
}

export async function buildBriefTrends(
  bundle: ResearchBundle,
): Promise<BriefTrends> {
  const [usMap, local] = await Promise.all([
    translateUsItems(bundle),
    summarizeLocalTrends(bundle),
  ]);

  const regions = TREND_REGIONS.map((region) => {
    const isSummarized = SUMMARIZED_REGIONS.has(region.id);
    const source = isSummarized ? local.enrichments : usMap;
    const rawItems = (bundle.trends[region.id] ?? []).slice(
      0,
      isSummarized ? 3 : undefined,
    );
    const items = rawItems.map((item, index) =>
      toBriefItem(item, index + 1, source.get(`${region.id}:${index}`)),
    );

    const summary = isSummarized
      ? local.summaries.get(region.id)?.trim() || fallbackLocalSummary(items)
      : undefined;

    return {
      id: region.id,
      label: region.label,
      items,
      ...(summary ? { summary } : {}),
    };
  });

  return {
    regions,
    crossRegion: computeCrossRegion(regions),
  };
}
