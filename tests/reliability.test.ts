import assert from "node:assert/strict";
import test from "node:test";
import Parser from "rss-parser";
import { fallbackCoreBrief, generateDailyBrief, normalizeCore } from "@/lib/brief";
import { parseTrafficScore, collectNewsFeeds } from "@/lib/research";
import { collectRedditTops } from "@/lib/reddit";
import { computeRsi14 } from "@/lib/sentiment";
import { TICKERS } from "@/lib/config";
import { researchFixture } from "./fixtures";

test("traffic labels retain their magnitude and decimals", () => {
  for (const [label, expected] of [["200K+", 200_000], ["1.5M+", 1_500_000], ["1,000+", 1000], ["2B", 2e9], ["—", 0]] as const) {
    assert.equal(parseTrafficScore(label), expected);
  }
});

test("flat closes produce neutral RSI, rising/falling closes keep their extremes", () => {
  assert.equal(computeRsi14(Array(30).fill(10)), 50);
  assert.equal(computeRsi14(Array.from({ length: 30 }, (_, i) => i + 1)), 100);
  assert.equal(computeRsi14(Array.from({ length: 30 }, (_, i) => 30 - i)), 0);
  assert.equal(computeRsi14([1, 2]), null);
});

test("failed feeds cannot become invented headlines or a quiet-session claim", () => {
  const research = researchFixture();
  research.feedErrors = { TSLA: "timeout" };
  const object = fallbackCoreBrief(research);
  object.tickers[0].bullets = [{ text: "Invented catalyst", flag: "Actionable", sourceIndex: 0 }];
  object.tickers[0].overnightOpener = "Quiet overnight";
  const core = normalizeCore(object, research);
  assert.equal(core.tickers[0].bullets[0].text, "News feed unavailable today.");
  assert.match(core.tickers[0].overnightOpener, /could not be checked/);
  assert.equal(core.tickers.length, TICKERS.length);
});

test("fallback retains original headlines with working source links", () => {
  const research = researchFixture();
  research.tickers.TSLA = [{ title: "Real sourced headline", link: "https://example.com/news", publishedAt: research.collectedAt, source: "Publisher" }];
  const core = normalizeCore(fallbackCoreBrief(research), research);
  assert.equal(core.tickers[0].bullets[0].text, "Real sourced headline");
  assert.equal(core.tickers[0].bullets[0].sourceUrl, "https://example.com/news");
  assert.deepEqual(core.people, []);
});

test("person remarks require a valid source index", () => {
  const research = researchFixture();
  research.people.musk = [{ title: "Sourced post", link: "https://example.com/post", publishedAt: research.collectedAt }];
  const object = fallbackCoreBrief(research);
  object.people = [{ id: "musk", name: "Elon Musk", summary: undefined, quote: undefined, sourceIndex: undefined, items: [{ summary: "Unsupported", quote: undefined, sourceIndex: 50 }, { summary: "Supported", quote: undefined, sourceIndex: 0 }] }];
  assert.deepEqual(normalizeCore(object, research).people[0].items, [{ summary: "Supported", sourceUrl: "https://example.com/post" }]);
});

test("one failed RSS feed does not abort collection of other headlines", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  t.mock.method(Parser.prototype, "parseURL", async (url: string) => {
    if (decodeURIComponent(url).includes("TSLA")) throw new Error("feed failed");
    return { items: [{ title: "Available news", link: "https://example.com/news", isoDate: new Date().toISOString() }] };
  });
  const research = await collectNewsFeeds();
  assert.deepEqual(research.tickers.TSLA, []);
  assert.equal(research.feedErrors?.TSLA, "feed failed");
  assert.equal(research.tickers.MU[0].title, "Available news");
  assert.equal(research.people.huang[0].title, "Available news");
});

test("Reddit stops rate-limit waits at its collection deadline", async (t) => {
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "3600" } });
  });
  const started = Date.now();
  const result = await collectRedditTops(30);
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1);
  assert.equal(result.length, 4);
});

test("AI outage still produces a complete source-based brief", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "offline" }), { status: 400, headers: { "Content-Type": "application/json" } }));
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "offline-test-key";
  t.after(() => { if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey; });
  const research = researchFixture();
  research.tickers.TSLA = [{ title: "Available headline", link: "https://example.com/news", publishedAt: research.collectedAt }];
  const brief = await generateDailyBrief(research);
  assert.equal(brief.tickers.length, TICKERS.length);
  assert.equal(brief.tickers[0].bullets[0].text, "Available headline");
});

test("all five structured AI calls validate and enrich the daily brief", async (t) => {
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  const oldModel = process.env.AI_MODEL;
  process.env.AI_GATEWAY_API_KEY = "offline-test-key";
  delete process.env.AI_MODEL;
  t.after(() => {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  });
  const research = researchFixture();
  research.tickers.TSLA = [{ title: "Sourced catalyst", link: "https://example.com/news", publishedAt: research.collectedAt }];
  research.people.musk = [{ title: "Own post", link: "https://example.com/post", publishedAt: research.collectedAt, source: "X" }];
  research.trends.us = [{ title: "黄金", approxTraffic: "100K+", trafficScore: 100000 }];
  research.trends.thailand = [{ title: "ทองคำ", approxTraffic: "100K+", trafficScore: 100000 }];
  research.valuation = [{ tickerId: "TSLA", quoteSymbol: "TSLA", pe: 20, sourceUrl: "https://example.com/value" }];
  research.whales.clusterBuys = [{ ticker: "TSLA", name: "Tesla", buyerCount: 3 }];
  const kinds = new Set<string>();
  function assertStrictSchema(schema: { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] }) {
    if (schema.properties) {
      assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties).sort());
      for (const property of Object.values(schema.properties)) assertStrictSchema(property as typeof schema);
    }
    if (schema.items) assertStrictSchema(schema.items as typeof schema);
    for (const option of schema.anyOf ?? []) assertStrictSchema(option as typeof schema);
  }
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init: RequestInit) => {
    assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get("ai-language-model-id"), "openai/gpt-5-mini");
    const body = JSON.parse(String(init.body));
    assert.equal(body.reasoning, "low");
    assert.equal(body.providerOptions?.google, undefined);
    assertStrictSchema(body.responseFormat.schema);
    const properties = body.responseFormat.schema.properties;
    let object: unknown;
    if (properties.tickers) {
      kinds.add("core");
      object = { tickers: [{ id: "TSLA", label: "Tesla", bullets: [{ text: "Sourced catalyst", flag: "Watch", sourceIndex: 0 }], whyItMatters: "A catalyst.", overnightOpener: "Session context." }], people: [{ id: "musk", name: "Elon Musk", summary: null, quote: null, sourceIndex: null, items: [{ summary: "A sourced remark.", quote: null, sourceIndex: 0 }, { summary: "An unsupported remark.", quote: null, sourceIndex: null }] }] };
    } else if (properties.items) {
      kinds.add("us"); object = { items: [{ id: "us:0", titleEn: "Gold", newsTitleEn: null }] };
    } else if (properties.regions) {
      kinds.add("thailand"); object = { regions: [{ id: "thailand", items: [{ id: "thailand:0", titleEn: "Gold", descriptionEn: "Gold searches are rising." }] }] };
    } else if (properties.notes) {
      kinds.add("valuation"); object = { notes: [{ tickerId: "TSLA", stance: "Fair", note: "Multiples look fair." }] };
    } else {
      kinds.add("whales"); object = { briefing: "Three funds added Tesla.", themes: [], watchlist: [{ tickerId: "TSLA", note: "Three disclosed buyers." }] };
    }
    return Response.json({ content: [{ type: "text", text: JSON.stringify(object) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
  });
  const brief = await generateDailyBrief(research);
  assert.equal(kinds.size, 5);
  assert.equal(brief.model, "openai/gpt-5-mini");
  assert.equal(brief.people[0].items[0].sourceUrl, "https://example.com/post");
  assert.equal(brief.people[0].items.length, 1);
  assert.equal(brief.people[0].items[0].quote, undefined);
  assert.equal(brief.tickers[0].bullets[0].sourceUrl, "https://example.com/news");
  assert.equal(brief.valuation[0].valueStance, "Fair");
  assert.equal(brief.whales.briefing, "Three funds added Tesla.");
  assert.deepEqual(brief.trends.crossRegion, ["Gold"]);
});

test("Gemini model override preserves disabled thinking for the brief", async (t) => {
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  const oldModel = process.env.AI_MODEL;
  process.env.AI_GATEWAY_API_KEY = "offline-test-key";
  process.env.AI_MODEL = "google/gemini-2.5-flash";
  t.after(() => {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  });
  t.mock.method(console, "warn", () => {});
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init: RequestInit) => {
    requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return Response.json({ error: "offline" }, { status: 400 });
  });
  const brief = await generateDailyBrief(researchFixture());
  assert.equal(brief.model, "google/gemini-2.5-flash");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get("ai-language-model-id"), "google/gemini-2.5-flash");
  assert.equal(requests[0].body.reasoning, undefined);
  assert.deepEqual(requests[0].body.providerOptions, { google: { thinkingConfig: { thinkingBudget: 0 } } });
  assert.equal(brief.tickers.length, TICKERS.length);
});
