import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { operationsFixture } from "./fixtures";
import { buildGcpBillingChartSvg, cumulativeBillingSeries, gcpBillingChartAttachments, GCP_COST_CHART_ID } from "@/lib/gcp-billing-chart";
import { renderOperationsHtml, renderOperationsText } from "@/lib/email";

test("billing cumulative cost retains credits, measured zeroes, and gaps in daily exports", () => {
  const report = operationsFixture();
  const billing = report.gcpBilling!;
  billing.endDate = "2026-10-05";
  billing.days = [
    { date: "2026-10-01", costs: { API: 3 } },
    { date: "2026-10-02", costs: { API: -5 } },
    { date: "2026-10-03", costs: { API: 0 } },
    { date: "2026-10-04", costs: {} },
    { date: "2026-10-05", costs: { API: 2 } },
  ];
  const points = cumulativeBillingSeries(billing);
  assert.deepEqual(points.map(p => p.cost), [3, -2, -2, 0]);
  assert.deepEqual(points.map(p => p.startsSegment), [true, false, false, true]);
  assert.equal(points[2].at, Date.parse("2026-10-03T12:00:00Z"));
  const svg = buildGcpBillingChartSvg(billing);
  assert.match(svg, /Net cost \(USD\)/);
  assert.match(svg, /−\$/);
  assert.match(svg, /1 Oct/); assert.match(svg, /5 Oct/);
  const html = renderOperationsHtml(report);
  assert.match(html, /Cumulative net cost · USD/);
  assert.match(html, /width:100%;max-width:100%;height:auto/);
  assert.doesNotMatch(html, /Bars show magnitude|Daily net cost|Weekly net cost/);
  const text = renderOperationsText(report);
  assert.match(text, /2 Oct 2026: -\$2.00/);
  assert.match(text, /3 Oct 2026: -\$2.00/);
  assert.doesNotMatch(text, /4 Oct 2026: \$0/);
  billing.days = billing.days.map(day => ({ ...day, costs: {} }));
  assert.equal(cumulativeBillingSeries(billing).length, 0);
  assert.match(buildGcpBillingChartSvg(billing), /No recorded cost data/);
});

test("billing chart PNG is an inline attachment and an unavailable image preserves the report", async () => {
  const report = operationsFixture();
  assert.deepEqual(cumulativeBillingSeries(report.gcpBilling!).map(p => p.cost), [3, 8]);
  const attachments = await gcpBillingChartAttachments(report.gcpBilling);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].content_id, GCP_COST_CHART_ID);
  const metadata = await sharp(Buffer.from(attachments[0].content, "base64")).metadata();
  assert.equal(metadata.format, "png"); assert.equal(metadata.width, 1360); assert.equal(metadata.height, 840);
  const fallback = renderOperationsHtml(report, undefined, null);
  assert.match(fallback, /Cost chart unavailable/); assert.match(fallback, /\$8.00/);
  assert.doesNotMatch(fallback, /cid:gcp-cumulative/);
  assert.deepEqual(await gcpBillingChartAttachments(null), []);
  assert.deepEqual(await gcpBillingChartAttachments({ ...report.gcpBilling!, error: "Export unavailable" }), []);
});

test("billing daily bars use reported request-like events, retaining zero and omitting unknown counts", () => {
  const report = operationsFixture();
  const billing = report.gcpBilling!;
  let svg = buildGcpBillingChartSvg(billing);
  assert.match(svg, /Billed events per day/);
  assert.match(svg, /data-calls="300"/); assert.match(svg, /data-calls="550"/);
  assert.equal((svg.match(/class="daily-calls"/g) ?? []).length, 2);
  assert.doesNotMatch(svg, /stroke-dasharray/); // Google allowances are monthly/SKU-specific.
  billing.days[0].billedEvents = 0;
  billing.days[1].billedEvents = null;
  svg = buildGcpBillingChartSvg(billing);
  assert.match(svg, /data-calls="0"/);
  assert.equal((svg.match(/class="daily-calls"/g) ?? []).length, 1);
  delete billing.days[0].billedEvents;
  svg = buildGcpBillingChartSvg(billing);
  assert.match(svg, /Daily counts unavailable/);
  assert.doesNotMatch(svg, /class="daily-calls"/);
  assert.match(svg, /<path /); // Available costs survive missing daily counts.
});

test("billing axes show the entire calendar month without extending data into future days", () => {
  for (const [month, finalDay, label] of [["2026-10", 31, "Oct"], ["2026-04", 30, "Apr"], ["2027-02", 28, "Feb"], ["2028-02", 29, "Feb"]] as const) {
    const billing = operationsFixture().gcpBilling!;
    billing.startDate = `${month}-01`; billing.endDate = `${month}-02`;
    billing.days = billing.days.map((day, index) => ({ ...day, date: `${month}-0${index + 1}` }));
    const svg = buildGcpBillingChartSvg(billing);
    assert.match(svg, new RegExp(`>1 ${label}</text>`));
    assert.match(svg, new RegExp(`>${finalDay} ${label}</text>`));
    assert.equal((svg.match(/class="daily-calls"/g) ?? []).length, 2);
    assert.equal((svg.match(/<circle /g) ?? []).length, 2);
    assert.deepEqual(cumulativeBillingSeries(billing).map(p => p.cost), [3, 8]);
    assert.ok((svg.match(/>\d+ (Oct|Apr|Feb)<\/text>/g) ?? []).length >= 8);
  }
});
