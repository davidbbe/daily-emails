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

/** Regions that get short English descriptions (traffic + news links still shown) */
const DESCRIBED_REGIONS = new Set<TrendRegionId>(["thailand", "bulgaria"]);

const translationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      titleEn: z.string(),
      newsTitleEn: z.string().optional(),
    }),
  ),
});

const descriptionSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      titleEn: z.string(),
      descriptionEn: z.string(),
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

  const { object } = await generateObject({
    model: getModel(),
    schema: translationSchema,
    maxOutputTokens: 2048,
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

  return map;
}

async function describeLocalTrends(
  bundle: ResearchBundle,
): Promise<Map<string, Enrichment>> {
  const map = new Map<string, Enrichment>();
  const jobs: Array<{
    id: string;
    title: string;
    newsTitle?: string;
  }> = [];

  for (const regionId of DESCRIBED_REGIONS) {
    const items = bundle.trends[regionId] ?? [];
    items.forEach((item, index) => {
      jobs.push({
        id: `${regionId}:${index}`,
        title: item.title,
        newsTitle: item.newsTitle,
      });
    });
  }

  if (jobs.length === 0) return map;

  const { object } = await generateObject({
    model: getModel(),
    schema: descriptionSchema,
    maxOutputTokens: 3072,
    system: `You localize Google Trends items for an English email brief.
For each item:
- titleEn: English search-query label (translate if needed; keep proper nouns)
- descriptionEn: one short English sentence (max 14 words) explaining why it is trending, based only on the provided news headline. Do not invent facts. If no news is given, write a brief neutral gloss of the query itself.`,
    prompt: `Localize these trends:
${jobs
  .map((job) => {
    const news = job.newsTitle ? `\n  news: ${job.newsTitle}` : "\n  news: (none)";
    return `- id=${job.id}\n  title: ${job.title}${news}`;
  })
  .join("\n")}`,
  });

  for (const item of object.items) {
    map.set(item.id, {
      titleEn: item.titleEn.trim() || item.id,
      descriptionEn: item.descriptionEn.trim() || undefined,
    });
  }

  return map;
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
    .slice(0, 8);
}

export async function buildBriefTrends(
  bundle: ResearchBundle,
): Promise<BriefTrends> {
  const [usMap, localMap] = await Promise.all([
    translateUsItems(bundle),
    describeLocalTrends(bundle),
  ]);

  const regions = TREND_REGIONS.map((region) => {
    const source = DESCRIBED_REGIONS.has(region.id) ? localMap : usMap;
    const items = (bundle.trends[region.id] ?? []).map((item, index) =>
      toBriefItem(item, index + 1, source.get(`${region.id}:${index}`)),
    );
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
