import assert from "node:assert/strict";
import test from "node:test";
import { JWT } from "google-auth-library";
import { collectSiteAnalytics } from "@/lib/analytics";
import { renderBriefHtml, renderBriefText } from "@/lib/email";
import { briefFixture } from "./fixtures";

for (const users of [0, 12]) {
  test(`GA4 preserves yesterday's ${users} users and labels recent data provisional`, async (t) => {
    const oldEnv = { ...process.env };
    t.after(() => { process.env = oldEnv; });
    process.env.GOOGLE_CLIENT_EMAIL = "offline@test.iam.gserviceaccount.com";
    process.env.GOOGLE_PRIVATE_KEY = "offline-private-key";
    t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "offline-token" }));
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
      assert.ok(init.signal);
      if (String(input).includes("analyticsadmin")) {
        return Response.json({ properties: [{ name: "properties/123", timeZone: "America/Los_Angeles" }] });
      }
      const body = JSON.parse(String(init.body));
      assert.equal(body.dateRanges[0].endDate, "2026-10-01");
      if (body.dimensions) {
        assert.equal(body.dateRanges[0].startDate, "2026-09-25");
        return Response.json({ rows: [
          { dimensionValues: [{ value: "20260930" }], metricValues: [{ value: "80" }, { value: "90" }, { value: "100" }] },
        ] });
      }
      return Response.json({
        dimensionHeaders: [{ name: "dateRange" }],
        metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
        rows: [
          { dimensionValues: [{ value: "yesterday" }], metricValues: [{ value: String(users) }, { value: String(users) }, { value: String(users) }] },
          { dimensionValues: [{ value: "previous" }], metricValues: [{ value: "80" }, { value: "90" }, { value: "100" }] },
          { dimensionValues: [{ value: "mtd" }], metricValues: [{ value: String(users) }] },
        ],
      });
    });
    // UTC has rolled into Oct 3, but the property-local date is still Oct 2.
    const sites = await collectSiteAnalytics(new Date("2026-10-03T01:00:00Z"));
    assert.ok(sites.length > 0);
    for (const site of sites) {
      assert.equal(site.date, "2026-10-01");
      assert.equal(site.previousDate, "2026-09-30");
      assert.equal(site.metrics.activeUsers, users);
      assert.equal(site.previous.activeUsers, 80);
      assert.equal(site.monthStart, "2026-10-01");
      assert.equal(site.monthToDate.activeUsers, users);
      assert.equal(site.dailySeries.length, 7);
      assert.equal(site.dailySeries.at(-1)?.date, site.date);
      assert.match(site.freshnessNote ?? "", /Provisional/);
      assert.doesNotMatch(site.freshnessNote ?? "", /has not finished/);
    }
    const brief = { ...briefFixture(), sites };
    assert.match(renderBriefHtml(brief), /Yesterday · 1 Oct 2026/);
    assert.match(renderBriefText(brief), /Yesterday \(1 Oct 2026\)/);
    assert.match(renderBriefText(brief), /Provisional GA4/);
  });
}
