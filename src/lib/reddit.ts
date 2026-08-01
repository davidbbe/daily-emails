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

const parser = new Parser<Record<string, unknown>, RedditRssItem>({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; agent-dave-daily-brief/1.0; +https://github.com/)",
    Accept: "application/atom+xml,application/xml,text/xml,*/*",
  },
  customFields: {
    item: [
      ["media:thumbnail", "mediaThumbnails", { keepArray: true }],
      ["media:content", "mediaContents", { keepArray: true }],
    ],
  },
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function feedUrls(subreddit: string): Array<{ url: string; window: RedditWindow }> {
  return [
    {
      url: `https://www.reddit.com/r/${subreddit}/top.rss?t=day`,
      window: "day",
    },
    {
      url: `https://www.reddit.com/r/${subreddit}/top.rss?t=week`,
      window: "week",
    },
    {
      url: `https://www.reddit.com/r/${subreddit}.rss`,
      window: "hot",
    },
  ];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function mediaUrl(node: MediaNode | undefined): string | undefined {
  const url = node?.$?.url || node?.url;
  return url?.trim() || undefined;
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
    if (match?.[0]) return match[0].replaceAll("&amp;", "&");
  }
  return undefined;
}

function normalizeAuthor(value?: string) {
  const author = value?.trim();
  if (!author) return undefined;
  return author.replace(/^\/u\//, "");
}

async function fetchSubredditFeed(
  subreddit: string,
  limit: number,
): Promise<Pick<RedditSubFeed, "window" | "posts">> {
  let lastError: unknown;

  for (const candidate of feedUrls(subreddit)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const feed = await parser.parseURL(candidate.url);
        const posts: RedditPost[] = [];

        for (const item of feed.items.slice(0, limit * 2)) {
          const title = item.title?.trim();
          const permalink = item.link?.trim();
          if (!title || !permalink) continue;

          posts.push({
            title,
            permalink,
            author: normalizeAuthor(item.creator || item.author),
            thumbnail: thumbnailFromItem(item),
          });
          if (posts.length >= limit) break;
        }

        if (posts.length > 0) {
          return { window: candidate.window, posts };
        }
        // Empty feed — try next window (quiet subs with no daily tops).
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /status code 429|status code 500|status code 503|429|503/i.test(
          message,
        );
        if (retryable && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }

  if (lastError) {
    console.warn(`reddit: fetch failed for r/${subreddit}`, lastError);
  }
  return { window: "day", posts: [] };
}

/**
 * Pull top posts for configured subreddits via Reddit Atom RSS.
 * Fetches sequentially with short gaps to reduce 429s.
 */
export async function collectRedditTops(): Promise<RedditSubFeed[]> {
  const feeds: RedditSubFeed[] = [];

  for (let i = 0; i < REDDIT_SUBREDDITS.length; i++) {
    const sub = REDDIT_SUBREDDITS[i];
    if (!sub) continue;
    if (i > 0) await sleep(1200);

    const { window, posts } = await fetchSubredditFeed(sub.id, sub.limit);
    feeds.push({
      id: sub.id,
      label: `r/${sub.id}`,
      window,
      posts,
    });
  }

  return feeds;
}
