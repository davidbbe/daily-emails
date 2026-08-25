import {
  SOCIAL_POST_LIMIT,
  personHandle,
  personSocial,
  type PersonConfig,
} from "@/lib/config";

type SocialPost = {
  title: string;
  link: string;
  publishedAt: string;
  source?: string;
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; daily-emails-brief/1.0; +https://github.com/)";

const FX_TIMELINE = "https://api.fxtwitter.com/2/profile";
const TRUMP_TRUTH_FEED = "https://trumpstruth.org/feed";

type FxStatus = {
  url?: string;
  text?: string;
  created_timestamp?: number;
  author?: { screen_name?: string };
  quote?: { text?: string; author?: { screen_name?: string } };
};

type FxTimeline = {
  code?: number;
  results?: FxStatus[];
  cursor?: { bottom?: string };
};

function cutoffMs(hours: number) {
  return Date.now() - hours * 60 * 60 * 1000;
}

function timestampMs(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 0;
  return value >= 1e12 ? value : value * 1000;
}

function collapseText(value: string, max = 480) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function stripHtml(html: string) {
  return collapseText(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'"),
  );
}

function tagValue(block: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "i"),
  );
  return match?.[1]?.trim() || "";
}

async function fetchText(url: string, accept: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: accept,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function formatXPost(post: FxStatus) {
  const text = collapseText(post.text ?? "");
  if (!text) return "";
  const quoted = collapseText(post.quote?.text ?? "", 220);
  if (!quoted) return text;
  const who = post.quote?.author?.screen_name
    ? `@${post.quote.author.screen_name}`
    : "quoted post";
  return collapseText(`${text} — quoting ${who}: ${quoted}`, 520);
}

function isOwnXPost(post: FxStatus, handle: string) {
  const author = post.author?.screen_name?.toLowerCase();
  return author === handle.toLowerCase() && Boolean(post.url);
}

async function fetchXPosts(
  handle: string,
  hours: number,
): Promise<SocialPost[]> {
  const cutoff = cutoffMs(hours);
  const items: SocialPost[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 8; page++) {
    const url = new URL(`${FX_TIMELINE}/${encodeURIComponent(handle)}/statuses`);
    url.searchParams.set("count", "20");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 204) break;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url.toString()}`);
    }
    const data = (await response.json()) as FxTimeline;
    const results = data.results ?? [];
    if (results.length === 0) break;

    let pageAllOlder = true;
    for (const post of results) {
      const published = timestampMs(post.created_timestamp);
      if (!published) continue;
      if (published >= cutoff) pageAllOlder = false;
      if (published < cutoff) continue;
      if (!isOwnXPost(post, handle)) continue;
      const title = formatXPost(post);
      if (!title || !post.url) continue;
      items.push({
        title,
        link: post.url,
        publishedAt: new Date(published).toISOString(),
        source: "X",
      });
    }

    cursor = data.cursor?.bottom;
    if (pageAllOlder || !cursor) break;
  }

  return items.slice(0, SOCIAL_POST_LIMIT);
}

async function fetchTruthSocialPosts(hours: number): Promise<SocialPost[]> {
  const xml = await fetchText(
    TRUMP_TRUTH_FEED,
    "application/rss+xml, application/xml, text/xml",
  );
  const cutoff = cutoffMs(hours);
  const items: SocialPost[] = [];

  for (const block of xml.split(/<item>/i).slice(1)) {
    const originalUrl =
      stripHtml(tagValue(block, "truth:originalUrl")) ||
      stripHtml(tagValue(block, "link"));
    const pubDate = stripHtml(tagValue(block, "pubDate"));
    const body =
      stripHtml(tagValue(block, "description")) ||
      stripHtml(tagValue(block, "title"));
    if (!originalUrl || !body || !pubDate) continue;

    const published = new Date(pubDate);
    if (Number.isNaN(published.getTime()) || published.getTime() < cutoff) {
      continue;
    }

    items.push({
      title: body,
      link: originalUrl,
      publishedAt: published.toISOString(),
      source: "Truth Social",
    });
  }

  return items.slice(0, SOCIAL_POST_LIMIT);
}

/** Own posts from the last `hours`, or [] when this person has no social feed. */
export async function fetchSocialPosts(
  person: PersonConfig,
  hours = 24,
): Promise<SocialPost[]> {
  const social = personSocial(person);
  if (!social) return [];

  if (social === "x") {
    const handle = personHandle(person);
    if (!handle) return [];
    return fetchXPosts(handle, hours);
  }

  return fetchTruthSocialPosts(hours);
}
