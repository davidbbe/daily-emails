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
  }>;
  crossRegion: string[];
};

/** Regions that get an English title + description for the top items */
const LOCAL_REGIONS = new Set<TrendRegionId>(["thailand"]);
const LOCAL_ITEM_COUNT = 3;

const translationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      titleEn: z.string(),
      newsTitleEn: z.string().optional(),
    }),
  ),
});

const localItemsSchema = z.object({
  regions: z.array(
    z.object({
      id: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          titleEn: z.string(),
          descriptionEn: z.string(),
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

type LocalItemsResult = {
  enrichments: Map<string, Enrichment>;
  selectedIds: Map<TrendRegionId, string[]>;
};

async function enrichLocalTrends(
  bundle: ResearchBundle,
): Promise<LocalItemsResult> {
  const enrichments = new Map<string, Enrichment>();
  const selectedIds = new Map<TrendRegionId, string[]>();

  const regionJobs = [...LOCAL_REGIONS]
    .map((regionId) => {
      const items = bundle.trends[regionId] ?? [];
      return { regionId, items };
    })
    .filter((job) => job.items.length > 0);

  if (regionJobs.length === 0) return { enrichments, selectedIds };

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: localItemsSchema,
      maxOutputTokens: 4096,
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 0 } },
      },
      system: `You select and describe Google Trends items for a daily email brief.
For each country region:
- Choose the ${LOCAL_ITEM_COUNT} most important trends (news, civic, markets, culture, or widely discussed events). Skip leftover sports or trivial celebrity noise when better options exist.
- Return exactly those items, most important first.
- titleEn: English search-query translation; keep globally known proper nouns in Latin script.
- descriptionEn: 1–2 English sentences — what the topic is and why it is rising. Ground claims only in the provided title, traffic, and news headline. Do not invent facts. If news is missing, say it is searching highly without inventing a cause.

CRITICAL language rules:
- Output MUST be entirely in English.
- Never include Thai or any non-English text — not even in parentheses.
- Translate all local terms; keep globally known proper nouns in Latin script.`,
      prompt: `Pick and describe the ${LOCAL_ITEM_COUNT} most important trends for each region (English only):
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
      if (!LOCAL_REGIONS.has(regionId)) continue;
      const ids: string[] = [];
      for (const item of region.items.slice(0, LOCAL_ITEM_COUNT)) {
        const id = item.id.trim();
        if (!id) continue;
        ids.push(id);
        enrichments.set(id, {
          titleEn: item.titleEn.trim() || id,
          descriptionEn: item.descriptionEn.trim() || undefined,
        });
      }
      if (ids.length > 0) selectedIds.set(regionId, ids);
    }
  } catch (error) {
    console.warn(
      "trends: local item enrichment failed; using original titles",
      error,
    );
  }

  return { enrichments, selectedIds };
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

function parseLocalItemIndex(itemId: string, regionId: TrendRegionId) {
  const prefix = `${regionId}:`;
  if (!itemId.startsWith(prefix)) return null;
  const index = Number.parseInt(itemId.slice(prefix.length), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function pickLocalItems(
  sourceItems: TrendItem[],
  selectedIds: string[] | undefined,
  regionId: TrendRegionId,
): TrendItem[] {
  const picked: TrendItem[] = [];
  const used = new Set<number>();

  for (const id of selectedIds ?? []) {
    const index = parseLocalItemIndex(id, regionId);
    if (index == null || used.has(index) || !sourceItems[index]) continue;
    used.add(index);
    picked.push(sourceItems[index]);
    if (picked.length >= LOCAL_ITEM_COUNT) return picked;
  }

  for (let index = 0; index < sourceItems.length; index++) {
    if (used.has(index)) continue;
    used.add(index);
    picked.push(sourceItems[index]);
    if (picked.length >= LOCAL_ITEM_COUNT) break;
  }

  return picked;
}

export async function buildBriefTrends(
  bundle: ResearchBundle,
): Promise<BriefTrends> {
  const [usMap, local] = await Promise.all([
    translateUsItems(bundle),
    enrichLocalTrends(bundle),
  ]);

  const regions = TREND_REGIONS.map((region) => {
    const isLocal = LOCAL_REGIONS.has(region.id);
    const sourceItems = bundle.trends[region.id] ?? [];
    const rawItems = isLocal
      ? pickLocalItems(sourceItems, local.selectedIds.get(region.id), region.id)
      : sourceItems;

    const items = rawItems.map((item, index) => {
      const sourceIndex = isLocal
        ? sourceItems.indexOf(item)
        : index;
      const enrichment = isLocal
        ? local.enrichments.get(`${region.id}:${sourceIndex}`)
        : usMap.get(`${region.id}:${index}`);
      return toBriefItem(item, index + 1, enrichment);
    });

    return {
      id: region.id,
      label: region.label,
      items,
    };
  });

  return {
    regions,
    crossRegion: computeCrossRegion(regions),
  };
}
