import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectRapidApiUsage, estimatedOverage, parseRapidApiUsage, rapidApiDailyMetric, type RapidApiUsageSnapshot } from "@/lib/rapidapi-usage";
import { renderOperationsHtml, renderOperationsText, renderBriefHtml, renderBriefText, sendOperationsEmail } from "@/lib/email";
import { buildRapidApiChartSvg, cumulativeOverageSeries, rapidApiChartAttachments } from "@/lib/rapidapi-chart";
import sharp from "sharp";
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

test("RapidAPI HTML and text show billing boundaries and cumulative cost only in operations", () => {
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
    assert.match(content, /9 Oct 2026/);
  }
  assert.match(html, /Cumulative estimated overage/);
  assert.match(html, /cid:rapidapi-overage-0/);
  assert.match(html, /width:100%;max-width:100%;height:auto/);
  assert.doesNotMatch(html, /max-width:680px|8 Nov 2026/);
  assert.match(html, /Days over the free quota/);
  assert.match(text, /Days over the free quota/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(text, /8 Nov 2026|<script>/);
  report.usage.rapidApi.snapshot!.dailyCapEnforced = true;
  assert.match(renderOperationsHtml(report), /enforces a 100-request daily cap/);
  assert.match(renderOperationsText(report), /enforces a 100-request daily cap/);
  assert.doesNotMatch(renderBriefHtml(briefFixture()), /unogsNG|RapidAPI/);
  assert.doesNotMatch(renderBriefText(briefFixture()), /unogsNG|RapidAPI/);
  report.usage.rapidApi = { available: false, detail: "Tracking not configured" };
  assert.match(renderOperationsHtml(report), /Tracking not configured/);
});

test("cumulative cost applies each daily allowance before adding, and never projects future days", () => {
  const snapshot = rapidApiFixture();
  const points = cumulativeOverageSeries(snapshot.periods[0], snapshot);
  assert.deepEqual(points.map(p => p.cost), [0, 5, 5]);
  assert.equal(points.at(-1)!.at, Date.parse(snapshot.observedAt));
  assert.ok(points.every(p => p.at <= Date.parse(snapshot.observedAt)));
  assert.equal(points[0].at, Date.parse(snapshot.trackingStartedAt!));
  const svg = buildRapidApiChartSvg(snapshot.periods[0], snapshot);
  assert.match(svg, /Cost \(USD\)/); assert.match(svg, /Day \(UTC\)/);
  assert.match(svg, /9 Oct/); assert.match(svg, /9 Nov/);
  assert.equal((svg.match(/class="daily-calls"/g) ?? []).length, 2);
  assert.match(svg, /data-calls="150"/); assert.match(svg, /data-calls="70"/);
  assert.ok((svg.match(/>\d+ (Oct|Nov)<\/text>/g) ?? []).length >= 8);
  assert.match(svg, /Calls per day/); assert.match(svg, /stroke-dasharray="6 4"/);
  // A gap starts a fresh segment, rather than a line across missing readings.
  const period = structuredClone(snapshot.periods[0]);
  period.days[0].requests = null;
  assert.deepEqual(cumulativeOverageSeries(period, snapshot).map(p => p.cost), [0, 0]);
  period.days[1].requests = null;
  assert.match(buildRapidApiChartSvg(period, snapshot), /No recorded cost data/);
  assert.doesNotMatch(buildRapidApiChartSvg(period, snapshot), /<path /);
});

test("operations delivery includes PNG CID charts and keeps image bytes out of HTML", async () => {
  const report = operationsFixture();
  report.usage.rapidApi = { available: true, snapshot: rapidApiFixture(), detail: "Recorded estimates" };
  const attachments = await rapidApiChartAttachments(report.usage.rapidApi);
  assert.equal(attachments.length, 1);
  const png = Buffer.from(attachments[0].content, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 1360); assert.equal(metadata.height, 840);
  process.env.RESEND_API_KEY = "offline-key";
  process.env.EMAIL_FROM = "Daily Emails <sender@example.com>";
  process.env.EMAIL_TO = "reader@example.com";
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    const body = JSON.parse(String(init!.body)); bodies.push(String(init!.body));
    const attachment = body.attachments.find((a: { content_id: string }) => a.content_id === "rapidapi-overage-0");
    assert.ok(attachment);
    assert.equal(attachment.content_type, "image/png");
    assert.match(body.html, /src="cid:rapidapi-overage-0"/);
    assert.doesNotMatch(body.html, /data:image|<svg/);
    return Response.json({ id: "mock-chart-email" });
  };
  await sendOperationsEmail(report); await sendOperationsEmail(report);
  assert.equal(bodies[0], bodies[1]);
  const withoutChart = renderOperationsHtml(report, { 0: null });
  assert.match(withoutChart, /Cost chart unavailable/);
  assert.match(withoutChart, /\$5.00 estimated overage/);
  assert.doesNotMatch(withoutChart, /cid:rapidapi/);
  const previous = await rapidApiChartAttachments({ available: true, snapshot: rapidApiFixture("2026-09-09T10:51:00.000Z"), detail: "Recorded estimates" });
  assert.equal(previous.length, 2);
  assert.equal(previous[1].content_id, "rapidapi-overage-1");
});

test("RapidAPI detail rows include only recorded days strictly above the daily allowance", () => {
  const report = operationsFixture();
  const snapshot = rapidApiFixture();
  report.usage.rapidApi = { available: true, snapshot, detail: "Recorded estimates" };
  let html = renderOperationsHtml(report);
  const table = html.split("Days over the free quota")[1].split("</tbody>")[0];
  assert.match(table, /9 Oct 2026/); assert.match(table, />150</); assert.match(table, /\$5.00/);
  assert.doesNotMatch(table, /10 Oct 2026|11 Oct 2026|>70</);
  const text = renderOperationsText(report).split("Days over the free quota:")[1];
  assert.match(text, /150 calls/); assert.doesNotMatch(text, /70 calls/);
  snapshot.periods[0].days[0].requests = 100;
  snapshot.periods[0].days[1].requests = 0;
  html = renderOperationsHtml(report);
  assert.doesNotMatch(html, /Days over the free quota/);
  assert.doesNotMatch(renderOperationsText(report), /Days over the free quota/);
  const svg = buildRapidApiChartSvg(snapshot.periods[0], snapshot);
  assert.match(svg, /data-calls="100"/); assert.match(svg, /data-calls="0"/);
  assert.equal((svg.match(/class="daily-calls"/g) ?? []).length, 2);
});
