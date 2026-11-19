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

type ArchivePost = {
  id?: string;
  title?: string;
  author?: string;
  score?: number;
  url?: string;
  created_utc?: number;
  over_18?: boolean;
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; daily-emails-brief/1.0; +https://github.com/)";

const ARCHIVE_URL = "https://arctic-shift.photon-reddit.com/api/posts/search";
const DAY_SECONDS = 24 * 60 * 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

class RedditRateLimitError extends Error {
  constructor(status: number) {
    super(`status code ${status}`);
    this.name = "RedditRateLimitError";
  }
}

function imageThumbnail(url: string | undefined) {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (
      host === "i.redd.it" ||
      host === "preview.redd.it" ||
      host === "external-preview.redd.it" ||
      host === "i.imgur.com"
    ) {
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Highest-scoring posts from the last 24 hours in one archive page set. */
export function redditPostsFromArchive(
  subreddit: string,
  posts: ArchivePost[],
  limit: number,
  nowMs = Date.now(),
): RedditPost[] {
  const cutoff = nowMs / 1000 - DAY_SECONDS;
  const seen = new Set<string>();
  const ranked = posts
    .filter((post) => {
      const id = post.id?.trim();
      const title = post.title?.trim();
      if (!id || !title || post.over_18 || seen.has(id)) return false;
      if ((post.created_utc ?? 0) < cutoff) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return ranked.slice(0, limit).map((post) => ({
    title: post.title?.trim() ?? "",
    permalink: `https://www.reddit.com/r/${subreddit}/comments/${post.id}/`,
    author: post.author?.trim() || undefined,
    thumbnail: imageThumbnail(post.url),
  }));
}

async function fetchArchivePage(
  subreddit: string,
  before: number | undefined,
  signal: AbortSignal,
): Promise<ArchivePost[]> {
  const url = new URL(ARCHIVE_URL);
  url.searchParams.set("subreddit", subreddit);
  url.searchParams.set("after", "24h");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("sort", "desc");
  url.searchParams.set(
    "fields",
    "id,title,author,score,url,created_utc,over_18",
  );
  if (before) url.searchParams.set("before", String(before));

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: "no-store",
  });

  if (response.status === 429 || response.status === 503) {
    throw new RedditRateLimitError(response.status);
  }
  if (!response.ok) {
    throw new Error(`status code ${response.status}`);
  }

  const body = (await response.json()) as { data?: ArchivePost[] };
  return Array.isArray(body.data) ? body.data : [];
}

async function fetchSubredditTop(
  subreddit: string,
  limit: number,
  signal: AbortSignal,
): Promise<RedditPost[]> {
  const collected: ArchivePost[] = [];
  let before: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal.aborted) break;
    const posts = await fetchArchivePage(subreddit, before, signal);
    collected.push(...posts);
    if (posts.length < PAGE_SIZE) break;

    const oldest = posts.reduce((min, post) => {
      const created = post.created_utc ?? Number.POSITIVE_INFINITY;
      return Math.min(min, created);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(oldest) || (before !== undefined && oldest >= before)) break;
    const cutoff = Date.now() / 1000 - DAY_SECONDS;
    if (oldest <= cutoff) break;
    before = oldest;
  }

  return redditPostsFromArchive(subreddit, collected, limit);
}

/**
 * Top posts for the configured subreddits.
 * Reddit's public RSS feeds started returning 404 on 18 Nov 2026, so this
 * reads the Arctic Shift archive of the last 24 hours and keeps the
 * highest-scoring posts. A rate limit stops the rest of the collection
 * instead of waiting out the provider window.
 */
export async function collectRedditTops(
  timeoutMs = 60_000,
): Promise<RedditSubFeed[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const results = new Map<string, RedditPost[]>();

  for (const sub of REDDIT_SUBREDDITS) {
    if (signal.aborted) break;
    try {
      const posts = await fetchSubredditTop(sub.id, sub.limit, signal);
      if (posts.length > 0) results.set(sub.id.toLowerCase(), posts);
    } catch (error) {
      console.warn(`reddit: r/${sub.id} failed`, error);
      if (error instanceof RedditRateLimitError || signal.aborted) break;
    }
  }

  return REDDIT_SUBREDDITS.map((sub) => ({
    id: sub.id,
    label: `r/${sub.id}`,
    window: "day" as const,
    posts: results.get(sub.id.toLowerCase()) ?? [],
  }));
}
