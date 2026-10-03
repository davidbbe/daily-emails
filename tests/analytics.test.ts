import assert from "node:assert/strict";
import test from "node:test";
import { JWT } from "google-auth-library";
import { collectSiteAnalytics } from "@/lib/analytics";
import { GA_ACCOUNTS } from "@/lib/config";
import { renderOperationsHtml, renderOperationsText } from "@/lib/email";
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
        const site = GA_ACCOUNTS.find((site) => String(input).endsWith(`/properties/${site.propertyId}`));
        assert.ok(site, "Only the explicitly configured GA4 property may be queried");
        return Response.json({ name: `properties/${site.propertyId}`, account: `accounts/${site.accountId}`, timeZone: "America/Los_Angeles" });
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
    assert.equal(sites.length, 4);
    assert.deepEqual(sites.map((site) => site.propertyId), GA_ACCOUNTS.map((site) => site.propertyId));
    assert.equal(sites.at(-1)?.label, "restaurantroulette.app");
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
    const report = { ...briefFixture(), sites, usage: { collectedAt: "2026-10-03T01:00:00Z", thresholdPercent: 50, metrics: [], watch: [] } };
    assert.match(renderOperationsHtml(report), /Yesterday · 1 Oct 2026/);
    assert.match(renderOperationsText(report), /Yesterday \(1 Oct 2026\)/);
    assert.match(renderOperationsText(report), /Provisional GA4/);
    assert.match(renderOperationsHtml(report), /restaurantroulette.app/);
    assert.match(renderOperationsText(report), /restaurantroulette.app/);
  });
}

for (const failure of ["permission", "wrong-account"] as const) {
  test(`Restaurant Roulette ${failure} failure is isolated from the other sites`, async (t) => {
    const oldEnv = { ...process.env };
    t.after(() => { process.env = oldEnv; });
    process.env.GOOGLE_CLIENT_EMAIL = "offline@test.iam.gserviceaccount.com";
    process.env.GOOGLE_PRIVATE_KEY = "offline-private-key";
    t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "offline-token" }));
    const reportedProperties: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
      assert.ok(init.signal);
      const url = String(input);
      if (url.includes("analyticsadmin")) {
        const site = GA_ACCOUNTS.find((site) => url.endsWith(`/properties/${site.propertyId}`));
        assert.ok(site);
        if (site.label === "restaurantroulette.app" && failure === "permission") {
          return Response.json({ error: { message: "Service account needs Viewer access" } }, { status: 403 });
        }
        const accountId = site.label === "restaurantroulette.app" ? "incorrect-account" : site.accountId;
        return Response.json({ name: `properties/${site.propertyId}`, account: `accounts/${accountId}`, timeZone: "America/Los_Angeles" });
      }
      reportedProperties.push(url.match(/properties\/(\d+)/)![1]);
      return Response.json({ rows: [] });
    });
    const sites = await collectSiteAnalytics(new Date("2026-10-03T09:00:00Z"));
    assert.equal(sites.length, 4);
    assert.ok(sites.slice(0, 3).every((site) => !site.error));
    const restaurant = sites.at(-1)!;
    assert.equal(restaurant.label, "restaurantroulette.app");
    assert.equal(restaurant.propertyId, "477168801");
    assert.match(restaurant.error!, failure === "permission" ? /Viewer access/ : /does not match configured account/);
    assert.ok(!reportedProperties.includes(restaurant.propertyId));
    const report = { ...briefFixture(), sites, usage: { collectedAt: "2026-10-03T09:00:00Z", thresholdPercent: 50, metrics: [], watch: [] } };
    assert.match(renderOperationsHtml(report), /restaurantroulette.app/);
    assert.match(renderOperationsText(report), /Error:/);
  });
}
