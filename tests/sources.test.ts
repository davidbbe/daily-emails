import assert from "node:assert/strict";
import test from "node:test";
import type { TrendingNowItem } from "google-trends-now";
import {
  embeddedTrendRows,
  rssNewsByTitle,
  selectTrendingItems,
} from "@/lib/research";
import { redditPostsFromArchive } from "@/lib/reddit";

function trend(query: string, volume: number, categoryId: number): TrendingNowItem {
  return {
    position: 1,
    raw_position: 1,
    query,
    normalized_query: query,
    search_volume: volume,
    search_volume_label: `${volume}+`,
    increase_percentage: null,
    started_at: null,
    ended_at: null,
    start_timestamp: null,
    end_timestamp: null,
    active: true,
    trend_breakdown: [],
    news_refs: [],
    categories: [{ id: categoryId, name: categoryId === 17 ? "Sports" : "Other" }],
    explore_url: "https://trends.google.com/trends/explore",
    source: "google_trending_now",
  };
}

test("embedded trends page rows keep the query list", () => {
  const html = `<script>AF_initDataCallback({key: 'ds:0', hash: '2', data:[null,[["gold",null,"US",[1700000000],null,null,1000,null,50,[],[],[3],[],"gold"],["match",null,"US",[1700000000],null,null,500]]], sideChannel: {}});</script>`;
  const rows = embeddedTrendRows(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], "gold");
  assert.equal(rows[1][0], "match");
});

test("trend selection drops sports and keeps the highest volume", () => {
  const selected = selectTrendingItems(
    [
      trend("final", 9000, 17),
      trend("markets", 2000, 3),
      trend("quiet", 50, 11),
    ],
    1,
    true,
  );
  assert.deepEqual(selected.map((item) => item.query), ["markets"]);
});

test("RSS trend news keeps the first headline and link", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>Bob &amp; Woodward</title><ht:news_item><ht:news_item_title>Memoir published</ht:news_item_title><ht:news_item_url>https://example.com/a</ht:news_item_url><ht:news_item_source>Globe</ht:news_item_source></ht:news_item><ht:news_item><ht:news_item_title>Second</ht:news_item_title><ht:news_item_url>https://example.com/b</ht:news_item_url></ht:news_item></item></channel></rss>`;
  const news = rssNewsByTitle(xml).get("bob & woodward");
  assert.equal(news?.newsTitle, "Memoir published");
  assert.equal(news?.newsUrl, "https://example.com/a");
  assert.equal(news?.newsSource, "Globe");
});

test("archive posts keep the highest score from the last day and only image thumbnails", () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0);
  const hour = 60 * 60;
  const posts = redditPostsFromArchive(
    "pics",
    [
      { id: "old", title: "Yesterday", score: 9999, created_utc: now / 1000 - 30 * hour, url: "https://i.redd.it/old.jpeg" },
      { id: "nsfw", title: "Hidden", score: 8000, created_utc: now / 1000 - hour, over_18: true, url: "https://i.redd.it/hidden.jpeg" },
      { id: "video", title: "Clip", score: 50, created_utc: now / 1000 - 2 * hour, url: "https://v.redd.it/clip" },
      { id: "photo", title: "Photo", score: 400, created_utc: now / 1000 - 3 * hour, url: "https://i.redd.it/photo.jpeg", author: "ada" },
      { id: "photo", title: "Photo duplicate", score: 10, created_utc: now / 1000 - 3 * hour, url: "https://i.redd.it/photo.jpeg" },
    ],
    6,
    now,
  );
  assert.deepEqual(
    posts.map((post) => [post.title, post.thumbnail, post.permalink]),
    [
      ["Photo", "https://i.redd.it/photo.jpeg", "https://www.reddit.com/r/pics/comments/photo/"],
      ["Clip", undefined, "https://www.reddit.com/r/pics/comments/video/"],
    ],
  );
  assert.equal(posts[0].author, "ada");
});
