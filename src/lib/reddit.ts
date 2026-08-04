import Parser from "rss-parser";
import { REDDIT_SUBREDDITS } from "@/lib/config";

export type RedditPost = {
  title: string;
  permalink: string;
  author?: string;
  thumbnail?: string;
};

export type RedditWindow = "day" | "week" | "hot";

export type RedditSubFeed = {
  id: string;
  label: string;
  window: RedditWindow;
  posts: RedditPost[];
};

type MediaNode = {
  $?: { url?: string };
  url?: string;
};

type RedditRssItem = {
  title?: string;
  link?: string;
  creator?: string;
  author?: string;
  content?: string;
  "content:encoded"?: string;
  mediaThumbnails?: MediaNode | MediaNode[];
  mediaContents?: MediaNode | MediaNode[];
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; daily-emails-brief/1.0; +https://github.com/)";

const parser = new Parser<Record<string, unknown>, RedditRssItem>({
  customFields: {
    item: [
      ["media:thumbnail", "mediaThumbnails", { keepArray: true }],
      ["media:content", "mediaContents", { keepArray: true }],
    ],
  },
});

/**
 * Batch to cut request count. Quiet / niche subs get their own request so
 * larger neighbors do not crowd them out of a multireddit listing.
 * Unauthenticated Reddit RSS is roughly 1 request per rate-limit window (~15–20s).
 */
const FETCH_BATCHES: string[][] = [
  ["pics"],
  ["generativeAI", "CursedAI", "aiArt"],
];

/** Earliest time we should hit Reddit again (ms since epoch). */
let rateLimitReadyAt = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForRateBudget() {
  const waitMs = rateLimitReadyAt - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function noteRateLimit(response: Response, attempt = 0) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    rateLimitReadyAt = Math.max(rateLimitReadyAt, Date.now() + retryAfter * 1000 + 500);
    return;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    // On RSS, Reddit sends seconds-until-reset (not a unix timestamp).
    rateLimitReadyAt = Math.max(rateLimitReadyAt, Date.now() + reset * 1000 + 500);
    return;
  }

  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(remaining) && remaining <= 0) {
    rateLimitReadyAt = Math.max(rateLimitReadyAt, Date.now() + 18_000);
    return;
  }

  // Successful responses still consume the tiny unauthenticated budget.
  if (response.ok) {
    rateLimitReadyAt = Math.max(rateLimitReadyAt, Date.now() + 18_000);
    return;
  }

  rateLimitReadyAt = Math.max(
    rateLimitReadyAt,
    Date.now() + Math.min(60_000, 12_000 * 2 ** attempt),
  );
}

function feedUrl(subreddits: string[], window: RedditWindow): string {
  const joined = subreddits.join("+");
  const limit = Math.min(100, Math.max(25, subreddits.length * 25));
  if (window === "hot") {
    return `https://www.reddit.com/r/${joined}.rss?limit=${limit}`;
  }
  return `https://www.reddit.com/r/${joined}/top.rss?t=${window}&limit=${limit}`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeAmp(url: string) {
  return url.replaceAll("&amp;", "&");
}

function mediaUrl(node: MediaNode | undefined): string | undefined {
  const url = node?.$?.url || node?.url;
  return url ? decodeAmp(url.trim()) : undefined;
}

function thumbnailFromItem(item: RedditRssItem): string | undefined {
  for (const node of asArray(item.mediaThumbnails)) {
    const url = mediaUrl(node);
    if (url) return url;
  }
  for (const node of asArray(item.mediaContents)) {
    const url = mediaUrl(node);
    if (url) return url;
  }

  const html = item.content || item["content:encoded"] || "";
  const patterns = [
    /https:\/\/preview\.redd\.it\/[^"\s&]+(?:&amp;[^"\s]*)*/i,
    /https:\/\/external-preview\.redd\.it\/[^"\s&]+(?:&amp;[^"\s]*)*/i,
    /https:\/\/i\.redd\.it\/[^"\s]+/i,
    /https:\/\/b\.thumbs\.redditmedia\.com\/[^"\s]+/i,
    /https:\/\/i\.imgur\.com\/[^"\s]+/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[0]) return decodeAmp(match[0]);
  }
  return undefined;
}

function normalizeAuthor(value?: string) {
  const author = value?.trim();
  if (!author) return undefined;
  return author.replace(/^\/u\//, "");
}

function subredditFromPermalink(permalink: string): string | undefined {
  const match = permalink.match(/reddit\.com\/r\/([^/]+)\//i);
  return match?.[1];
}

async function parseFeedXml(xml: string): Promise<RedditPost[]> {
  const feed = await parser.parseString(xml);
  const posts: RedditPost[] = [];

  for (const item of feed.items) {
    const title = item.title?.trim();
    const permalink = item.link?.trim();
    if (!title || !permalink) continue;

    posts.push({
      title,
      permalink,
      author: normalizeAuthor(item.creator || item.author),
      thumbnail: thumbnailFromItem(item),
    });
  }

  return posts;
}

async function fetchFeedXml(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await waitForRateBudget();

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/atom+xml,application/xml,text/xml,*/*",
        },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });

      noteRateLimit(response, attempt);

      if (response.status === 429 || response.status === 503) {
        lastError = new Error(`status code ${response.status}`);
        console.warn(
          `reddit: ${response.status} for ${url}; retry after rate-limit window`,
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(`status code ${response.status}`);
      }

      const xml = await response.text();
      if (!xml.includes("<entry") && !xml.includes("<item")) {
        // Valid empty Atom feed (quiet sub) — not an error.
        return xml;
      }
      return xml;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /status code 429|status code 503|timeout|network|fetch failed/i.test(
        message,
      );
      if (retryable && attempt < 5) {
        rateLimitReadyAt = Math.max(
          rateLimitReadyAt,
          Date.now() + Math.min(60_000, 12_000 * 2 ** attempt),
        );
        continue;
      }
      break;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`reddit fetch failed for ${url}`);
}

function groupPostsBySubreddit(posts: RedditPost[]): Map<string, RedditPost[]> {
  const grouped = new Map<string, RedditPost[]>();
  for (const post of posts) {
    const id = subredditFromPermalink(post.permalink);
    if (!id) continue;
    const key = id.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(post);
    grouped.set(key, list);
  }
  return grouped;
}

async function fetchBatchWindow(
  subreddits: string[],
  window: RedditWindow,
): Promise<Map<string, RedditPost[]>> {
  const xml = await fetchFeedXml(feedUrl(subreddits, window));
  const posts = await parseFeedXml(xml);
  return groupPostsBySubreddit(posts);
}

function buildBatches(): string[][] {
  const configured = new Set(REDDIT_SUBREDDITS.map((sub) => sub.id.toLowerCase()));
  const batches = FETCH_BATCHES.map((batch) =>
    batch.filter((id) => configured.has(id.toLowerCase())),
  ).filter((batch) => batch.length > 0);

  const batchedIds = new Set(batches.flat().map((id) => id.toLowerCase()));
  for (const sub of REDDIT_SUBREDDITS) {
    if (!batchedIds.has(sub.id.toLowerCase())) {
      batches.push([sub.id]);
    }
  }
  return batches;
}

/**
 * Pull top posts for configured subreddits via Reddit Atom RSS.
 * Batches subs into a few multireddit requests and respects rate-limit headers
 * so later subs are not wiped out by 429s.
 */
export async function collectRedditTops(): Promise<RedditSubFeed[]> {
  const limits = new Map(
    REDDIT_SUBREDDITS.map((sub) => [sub.id.toLowerCase(), sub.limit]),
  );
  const results = new Map<string, { window: RedditWindow; posts: RedditPost[] }>();
  const batches = buildBatches();
  const windows: RedditWindow[] = ["day", "week", "hot"];
  /** Subs that failed with errors (not merely empty) — retry alone. */
  const retryAlone = new Set<string>();

  for (const batch of batches) {
    for (const window of windows) {
      try {
        const grouped = await fetchBatchWindow(batch, window);

        for (const subId of batch) {
          const key = subId.toLowerCase();
          if (results.has(key)) continue;
          const limit = limits.get(key) ?? 5;
          const posts = (grouped.get(key) ?? []).slice(0, limit);
          if (posts.length === 0) continue;
          results.set(key, { window, posts });
        }

        if (batch.every((subId) => results.has(subId.toLowerCase()))) {
          break;
        }
        // Partial / empty — try next window after the shared rate-limit wait.
      } catch (error) {
        console.warn(
          `reddit: batch failed (${batch.join("+")} / ${window})`,
          error,
        );
        for (const subId of batch) {
          const key = subId.toLowerCase();
          if (!results.has(key)) retryAlone.add(key);
        }
        break;
      }
    }
  }

  // Retry only subs that errored out of a shared batch (not quiet empty feeds).
  for (const sub of REDDIT_SUBREDDITS) {
    const key = sub.id.toLowerCase();
    if (results.has(key) || !retryAlone.has(key)) continue;

    for (const window of windows) {
      try {
        const grouped = await fetchBatchWindow([sub.id], window);
        const posts = (grouped.get(key) ?? []).slice(0, sub.limit);
        if (posts.length > 0) {
          results.set(key, { window, posts });
          break;
        }
      } catch (error) {
        console.warn(`reddit: fallback failed for r/${sub.id}`, error);
        break;
      }
    }
  }

  return REDDIT_SUBREDDITS.map((sub) => {
    const key = sub.id.toLowerCase();
    const hit = results.get(key);
    return {
      id: sub.id,
      label: `r/${sub.id}`,
      window: hit?.window ?? "day",
      posts: hit?.posts ?? [],
    };
  });
}
