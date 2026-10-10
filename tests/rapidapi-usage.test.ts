import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectRapidApiUsage, estimatedOverage, parseRapidApiUsage, rapidApiDailyMetric, type RapidApiUsageSnapshot } from "@/lib/rapidapi-usage";
import { renderOperationsHtml, renderOperationsText, renderBriefHtml, renderBriefText } from "@/lib/email";
import { briefFixture, operationsFixture } from "./fixtures";
import { rapidApiFixture } from "./rapidapi-fixture";

const now = new Date("2026-10-11T09:00:00.000Z");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });



test("RapidAPI uses anniversary periods and separate 24-hour quota windows, with unknown and future days", () => {
  const snapshot = parseRapidApiUsage(rapidApiFixture(), now);
  assert.equal(snapshot.periods[0].start, "2026-10-09T10:51:00.000Z");
  assert.equal(snapshot.periods[0].end, "2026-11-09T10:51:00.000Z");
  assert.equal(snapshot.periods[0].days[0].status, "partial");
  assert.equal(snapshot.periods[0].days[2].requests, null);
  assert.equal(snapshot.periods[1].days[0].status, "untracked");
  // 150 + 70 across separate days produces $5 overage, never a monthly average.
  assert.equal(estimatedOverage(snapshot.periods[0], snapshot), 5);
  const metric = rapidApiDailyMetric({ available: true, snapshot, detail: "Recorded attempts" });
  assert.equal(metric.used, 70);
  assert.equal(metric.percent, 70);
});

test("RapidAPI rejects missing pages/days, duplicates, malformed coverage and stale observations", () => {
  for (const mutate of [
    (s: RapidApiUsageSnapshot) => { s.periods[0].days.pop(); },
    (s: RapidApiUsageSnapshot) => { s.periods[0].days[1] = s.periods[0].days[0]; },
    (s: RapidApiUsageSnapshot) => { s.periods[1].days[0].requests = 0; },
    (s: RapidApiUsageSnapshot) => { s.periods[0].days[0].requests = -1; },
    (s: RapidApiUsageSnapshot) => { s.periods[0].days[0].status = "complete"; },
    (s: RapidApiUsageSnapshot) => { s.periods[0].start = "2026-10-01T00:00:00.000Z"; },
  ]) {
    const snapshot = rapidApiFixture(); mutate(snapshot);
    assert.throws(() => parseRapidApiUsage(snapshot, now));
  }
  assert.throws(() => parseRapidApiUsage(rapidApiFixture(), new Date("2026-10-13T09:00:00Z")));
});

test("RapidAPI collection reads only the protected TV Roulette report and fails independently", async () => {
  process.env.TV_ROULETTE_USAGE_URL = "https://tvroulette.app/api/unogs-usage";
  process.env.TV_ROULETTE_USAGE_SECRET = "offline-secret";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), process.env.TV_ROULETTE_USAGE_URL);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer offline-secret");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json(rapidApiFixture());
  };
  assert.equal((await collectRapidApiUsage(now)).available, true);
  globalThis.fetch = async () => Response.json({ ...rapidApiFixture(), dailyCapEnforced: true });
  const capped = await collectRapidApiUsage(now);
  assert.match(capped.detail, /enforces the daily cap/);
  globalThis.fetch = async () => { throw new Error("secret=offline-secret"); };
  const failure = await collectRapidApiUsage(now);
  assert.equal(failure.available, false);
  assert.doesNotMatch(failure.detail, /offline-secret/);
  assert.equal(rapidApiDailyMetric(failure).available, false);
  globalThis.fetch = async () => new Response(null, { status: 401 });
  assert.match((await collectRapidApiUsage(now)).detail, /HTTP 401/);
  delete process.env.TV_ROULETTE_USAGE_SECRET;
  globalThis.fetch = async () => { assert.fail("Missing configuration must not fetch"); };
  assert.equal((await collectRapidApiUsage(now)).available, false);
});

test("RapidAPI HTML and text show billing boundaries, every subscription day and daily overage only in operations", () => {
  const report = operationsFixture();
  report.usage.rapidApi = { available: true, snapshot: rapidApiFixture(), detail: "Unknown days are not zero. <script>" };
  const metric = rapidApiDailyMetric(report.usage.rapidApi);
  report.usage.metrics.push(metric); report.usage.watch.push(metric);
  const html = renderOperationsHtml(report);
  const text = renderOperationsText(report);
  for (const content of [html, text]) {
    assert.match(content, /Billing start: 9 Oct 2026, 10:51 UTC/);
    assert.match(content, /Billing end: 9 Nov 2026, 10:51 UTC/);
    assert.match(content, /\$5\.00 estimated overage/);
    assert.match(content, /100 requests per subscription day/);
    assert.match(content, /10:51/);
    assert.match(content, /9 Oct 2026/); assert.match(content, /8 Nov 2026/);
  }
  assert.match(html, /Upcoming/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(text, /upcoming/);
  report.usage.rapidApi.snapshot!.dailyCapEnforced = true;
  assert.match(renderOperationsHtml(report), /enforces a 100-request daily cap/);
  assert.match(renderOperationsText(report), /enforces a 100-request daily cap/);
  assert.doesNotMatch(renderBriefHtml(briefFixture()), /unogsNG|RapidAPI/);
  assert.doesNotMatch(renderBriefText(briefFixture()), /unogsNG|RapidAPI/);
  report.usage.rapidApi = { available: false, detail: "Tracking not configured" };
  assert.match(renderOperationsHtml(report), /Tracking not configured/);
});
