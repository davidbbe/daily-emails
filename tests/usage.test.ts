import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { operationsFixture } from "./fixtures";

// Give persistence a private temporary directory; never touch real local caches.
const originalCwd = process.cwd();
const workspace = await mkdtemp(path.join(tmpdir(), "daily-emails-usage-"));
process.chdir(workspace);
const { collectResendQuota } = await import("@/lib/usage");
const { renderOperationsHtml, renderOperationsText } = await import("@/lib/email");
after(async () => { process.chdir(originalCwd); await rm(workspace, { recursive: true, force: true }); });
const cachePath = path.join(workspace, ".data/resend-usage.json");
const now = new Date("2026-10-03T09:00:00Z");
const windows = {
  daily: { used: 12, limit: 100, resets_at: "2026-10-04T00:00:00Z" },
  monthly: { used: 1800, limit: 3000, resets_at: "2026-11-01T00:00:00Z" },
};

async function setup(t: TestContext) {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.RESEND_API_KEY = "offline-full-access-key";
  delete process.env.RESEND_USAGE_API_KEY;
  for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "VERCEL", "AWS_LAMBDA_FUNCTION_NAME"]) delete process.env[key];
  t.mock.method(console, "warn", () => {});
  await rm(cachePath, { force: true });
}

async function cache(payload: unknown) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(payload));
}

test("Resend GET /usage reads provider limits and persists dated reset times", async (t) => {
  await setup(t);
  process.env.RESEND_DAILY_LIMIT = "1"; // Old free-plan overrides must not affect provider readings.
  process.env.RESEND_MONTHLY_LIMIT = "2";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/usage");
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer offline-full-access-key");
    assert.ok(init.signal);
    return Response.json({ emails: windows });
  });
  const metrics = await collectResendQuota(now);
  assert.equal(metrics[0].used, 12);
  assert.equal(metrics[0].limit, 100);
  assert.equal(metrics[1].percent, 60);
  assert.match(metrics[0].detail, /sent \+ received/);
  assert.match(metrics[0].detail, /observed 3 Oct 2026/);
  assert.match(metrics[0].detail, /before both daily emails are sent/);
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), { updatedAt: now.toISOString(), ...windows });
});

test("cached daily and monthly counters expire separately exactly at reset", async (t) => {
  await setup(t);
  await cache({ updatedAt: now.toISOString(), ...windows });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const current = await collectResendQuota(new Date("2026-10-03T23:59:59Z"));
  assert.ok(current.every((m) => m.available));
  assert.match(current[0].detail, /cached 3 Oct 2026/);
  const nextDay = await collectResendQuota(new Date(windows.daily.resets_at));
  assert.equal(nextDay[0].available, false);
  assert.match(nextDay[0].detail, /expired/);
  assert.equal(nextDay[1].available, true);
  const nextMonth = await collectResendQuota(new Date(windows.monthly.resets_at));
  assert.ok(nextMonth.every((m) => !m.available));
  const usage = { collectedAt: now.toISOString(), thresholdPercent: 50, metrics: nextMonth, watch: [] };
  assert.match(renderOperationsText({ ...operationsFixture(), usage }), /Some usage readings are unavailable/);
  assert.doesNotMatch(renderOperationsHtml({ ...operationsFixture(), usage }), /All tracked quotas.*under/);
});

test("Resend usage uses a separate full-access key and explains restricted-key failures", async (t) => {
  await setup(t);
  process.env.RESEND_API_KEY = "offline-send-only-key";
  process.env.RESEND_USAGE_API_KEY = " offline-usage-key ";
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer offline-usage-key");
    return Response.json({ emails: windows });
  });
  assert.ok((await collectResendQuota(now)).every(m => m.available));
  assert.equal(process.env.RESEND_API_KEY, "offline-send-only-key");
  await rm(cachePath, { force: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }));
  const metrics = await collectResendQuota(now);
  assert.ok(metrics.every(m => !m.available));
  assert.match(metrics[0].detail, /full-access key.*RESEND_USAGE_API_KEY/);
  await cache({ updatedAt: now.toISOString(), ...windows });
  const cached = await collectResendQuota(now);
  assert.equal(cached[0].source, "cached");
  assert.match(cached[0].detail, /Live refresh failed:.*full-access key/);
});

test("an uncapped Resend plan renders No cap without a fake usage percentage", async (t) => {
  await setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ emails: { ...windows, daily: { ...windows.daily, limit: null } } }));
  const metrics = await collectResendQuota(now);
  assert.equal(metrics[0].limit, null);
  assert.equal(metrics[0].available, true);
  assert.equal(metrics[0].percent, 0);
  const usage = { collectedAt: now.toISOString(), thresholdPercent: 50, metrics: [metrics[0]], watch: [] };
  assert.match(renderOperationsHtml({ ...operationsFixture(), usage }), /No cap/);
  const text = renderOperationsText({ ...operationsFixture(), usage });
  assert.match(text, /No cap/);
  assert.doesNotMatch(text, /Resend daily emails:.*\(0%\)/);
});

test("invalid live data falls back to validated cache; legacy and future caches are not current readings", async (t) => {
  await setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ emails: { ...windows, daily: { ...windows.daily, used: -2 } } }));
  await cache({ updatedAt: now.toISOString(), ...windows });
  assert.match((await collectResendQuota(now))[0].detail, /cached/);
  await cache({ updatedAt: now.toISOString(), dailyUsed: 2, monthlyUsed: 200 });
  assert.ok((await collectResendQuota(now)).every((m) => !m.available));
  await cache({ updatedAt: "2026-10-04T09:00:00Z", ...windows });
  assert.ok((await collectResendQuota(now)).every((m) => !m.available));
});

test("live Resend usage survives a cache write failure", async (t) => {
  await setup(t);
  await mkdir(cachePath);
  t.after(async () => { await rm(cachePath, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => Response.json({ emails: windows }));
  assert.ok((await collectResendQuota(now)).every((m) => m.available));
});

const { collectPlatformUsage, parsePlatformUsageCache, collectAiGateway } = await import("@/lib/usage");
const totals: Record<string, number> = {
  fast_data_transfer: 300, edge_requests: 120, function_invocations: 30,
  blob_simple_operations: 2681, blob_advanced_operations: 1362,
  blob_storage_size: 74_040_845, blob_data_transfer: 113_739_797,
};
function meter(body: Record<string, unknown>) {
  return { metric: { slug: body.metric }, from: body.from, to: body.to,
    queriedAt: body.to, filterBy: {}, results: { format: "scalar", totalValue: totals[String(body.metric)] } };
}
async function platformSetup(t: TestContext) {
  await setup(t);
  process.env.VERCEL_TOKEN = "offline-token";
  process.env.VERCEL_TEAM_ID = "offline-team";
}
test("Vercel dashboard meters use an exact rolling 30 days including today", async t => {
  await platformSetup(t);
  for (const at of [now, new Date("2026-11-01T00:01:23.456Z"), new Date("2026-10-04T09:00:00Z")]) {
    const seen: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/teams/")) return Response.json({ billing: { plan: "hobby" } });
      assert.equal(url.pathname, "/v1/usage-metrics/query");
      assert.equal(url.searchParams.get("teamId"), "offline-team");
      assert.equal(init.method, "POST"); // Read-only queries; no email or provider mutations.
      const body = JSON.parse(String(init.body));
      seen.push(body.metric);
      assert.equal(body.to, at.toISOString());
      assert.equal(body.from, new Date(at.getTime() - 30 * 86400000).toISOString());
      assert.equal(body.format, "scalar");
      assert.deepEqual(body.views, { total: { groupBy: [] } });
      return Response.json(meter(body));
    });
    const metrics = await collectPlatformUsage(at);
    assert.deepEqual(seen.sort(), Object.keys(totals).sort());
    assert.ok(metrics.every(m => m.available));
    assert.equal(metrics[3].used, 2681); // The old simple-request counter was 11,493.
    assert.equal(metrics[3].percent, 26.8);
    assert.equal(metrics[4].used, 1362);
    assert.equal(metrics[5].used, totals.blob_storage_size);
    assert.equal(metrics[6].used, totals.blob_data_transfer);
    assert.match(metrics[5].detail, /provider average.*Latest value may differ/);
    assert.match(metrics[3].detail, /rolling last 30 days, including today/);
    assert.doesNotMatch(metrics[3].detail, /complete days|2026-\d{2}-\d{2}/);
  }
});
test("a single failed or missing Vercel meter preserves the other live readings", async t => {
  await platformSetup(t);
  for (const failed of Object.keys(totals)) {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
      if (String(input).includes("/teams/")) return Response.json({ billing: { plan: "hobby" } });
      const body = JSON.parse(String(init.body));
      return body.metric === failed ? new Response("", { status: 503 }) : Response.json(meter(body));
    });
    const metrics = await collectPlatformUsage(now);
    assert.equal(metrics.filter(m => m.available).length, 6);
    assert.equal(metrics.find(m => m.id === "blob-simple-ops")?.available, failed !== "blob_simple_operations");
  }
});
test("other or unverified Vercel plans never use Hobby quota percentages", async t => {
  await platformSetup(t);
  for (const team of [{ billing: { plan: "pro" } }, {}]) {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) =>
      String(input).includes("/teams/") ? Response.json(team) : Response.json(meter(JSON.parse(String(init.body)))));
    const metrics = await collectPlatformUsage(now);
    assert.ok(metrics.every(m => m.available && m.limit === null && m.limitBasis === "unknown"));
    const report = { ...operationsFixture(), usage: { collectedAt: now.toISOString(), thresholdPercent: 50, metrics, watch: [] } };
    assert.match(renderOperationsHtml(report), /Cap unverified/);
  }
});
test("invalid, scoped, stale or mismatched Vercel meters never produce a quota total; zero remains valid", async t => {
  await platformSetup(t);
  const mutations = [
    (m: ReturnType<typeof meter>) => ({ ...m, results: {} }),
    (m: ReturnType<typeof meter>) => ({ ...m, results: { ...m.results, totalValue: -1 } }),
    (m: ReturnType<typeof meter>) => ({ ...m, metric: { slug: "legacy_counter" } }),
    (m: ReturnType<typeof meter>) => ({ ...m, from: "2026-09-03T00:00:00Z" }),
    (m: ReturnType<typeof meter>) => ({ ...m, to: "2026-10-02T23:59:59Z" }),
    (m: ReturnType<typeof meter>) => ({ ...m, to: "2026-10-04T09:00:00Z" }),
    (m: ReturnType<typeof meter>) => ({ ...m, filterBy: { resourceId: ["one-store"] } }),
    (m: ReturnType<typeof meter>) => ({ ...m, queriedAt: "invalid" }),
    (m: ReturnType<typeof meter>) => ({ ...m, results: { ...m.results, format: "timeseries" } }),
  ];
  for (const mutate of mutations) {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) =>
      String(input).includes("/teams/") ? Response.json({ billing: { plan: "hobby" } }) : Response.json(mutate(meter(JSON.parse(String(init.body))))));
    assert.ok((await collectPlatformUsage(now)).every(m => !m.available));
  }
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) =>
    String(input).includes("/teams/") ? Response.json({ billing: { plan: "hobby" } }) : Response.json({ ...meter(JSON.parse(String(init.body))), results: { format: "scalar", totalValue: 0 } }));
  assert.ok((await collectPlatformUsage(now)).every(m => m.available && m.used === 0));
});

test("compact platform usage shares live dates but retains cache dates and failures", () => {
  const report = operationsFixture();
  const range = "3 Sept 2026, 09:00 UTC–3 Oct 2026, 09:00 UTC";
  report.usage.watch = [];
  report.usage.metrics = [
    { id: "edge-requests", label: "CDN Requests", used: 10, limit: 100, unit: "requests", percent: 10, available: true, source: "live", limitBasis: "provider", detail: `${range} · rolling last 30 days, including today · all projects/stores in team · Hobby included allowance` },
    { id: "function-invocations", label: "Function invocations", used: 20, limit: 100, unit: "invocations", percent: 20, available: true, source: "live", limitBasis: "provider", detail: `${range} · rolling last 30 days, including today · all projects/stores in team · Hobby included allowance` },
    { id: "blob-simple-ops", label: "Blob simple operations", used: 5, limit: null, unit: "ops", percent: 0, available: true, source: "cached", limitBasis: "unknown", detail: "2 Oct 2026, 09:00 UTC · cached observation; Live refresh failed: meter timeout" },
    { id: "blob-advanced-ops", label: "Blob advanced operations", used: 0, limit: 2000, unit: "ops", percent: 0, available: false, detail: "Meter unavailable: permission denied" },
  ];
  const html = renderOperationsHtml(report);
  assert.equal(html.split(range).length - 1, 1);
  for (const text of ["10 / 100", "20 / 100", "10%", "20%", "CACHED", "2 Oct 2026, 09:00 UTC", "meter timeout", "Cap unverified", "Unavailable", "permission denied"]) {
    assert.ok(html.includes(text), `Missing ${text}`);
  }
  assert.doesNotMatch(html, />0%</);
});

test("HTML and plain text format dates in older notes without rewriting URLs", () => {
  const brief = operationsFixture();
  const detail = "2026-09-06–2026-10-05 UTC · provider updated 2026-10-06T10:00:15.011Z · https://example.com/2026-10-06";
  brief.usage = { collectedAt: now.toISOString(), thresholdPercent: 50, watch: [], metrics: [{ id: "blob-storage", label: "Blob storage · connected store", used: 24_770_000, limit: null, unit: "bytes", percent: 0, available: true, limitBasis: "snapshot", detail }] };
  for (const rendered of [renderOperationsHtml(brief), renderOperationsText(brief)]) {
    assert.match(rendered, /6 Sept 2026–5 Oct 2026 UTC/);
    assert.match(rendered, /6 Oct 2026, 10:00 UTC/);
    assert.match(rendered, /Snapshot only/);
    assert.match(rendered, /https:\/\/example.com\/2026-10-06/);
    assert.doesNotMatch(rendered, /Cap unverified|No cap|provider updated 2026-/);
  }
});
test("platform cache expires at 24 hours and rejects old sources, other teams and invalid counters", () => {
  const payload = { version: 2, teamId: "offline-team", updatedAt: now.toISOString(), from: "2026-09-03T09:00:00.000Z", to: now.toISOString(), metrics: [{ id: "edge-requests", label: "CDN Requests", used: 20, limit: 100, unit: "requests", available: true, detail: "dated snapshot" }] };
  const parse = (p: unknown, team = "offline-team", at = now) => parsePlatformUsageCache(JSON.stringify(p), team, at);
  assert.equal(parse(payload)?.[0].source, "cached");
  assert.equal(parse(payload)?.[0].percent, 20);
  assert.equal(parse(payload, "another-team"), null);
  assert.equal(parse(payload, "offline-team", new Date(now.getTime() + 86400000)), null);
  assert.equal(parse({ ...payload, updatedAt: "2099-01-01T00:00:00Z" }), null);
  assert.equal(parse({ ...payload, version: undefined }), null);
  assert.equal(parse({ ...payload, version: 1 }), null);
  assert.equal(parse({ ...payload, teamId: undefined }), null);
  assert.equal(parse({ ...payload, metrics: [{ ...payload.metrics[0], used: -1 }] }), null);
});
test("Gateway budget uses actual MTD spend even with purchased credits",async t=> {
  await platformSetup(t);process.env.AI_GATEWAY_API_KEY="offline-key";
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=> {
    const url=new URL(String(input));
    if(url.pathname.endsWith("/credits"))return Response.json({balance:"50",total_used:"10"});
    assert.equal(url.pathname,"/v1/report");assert.equal(url.searchParams.get("start_date"),"2026-10-01");
    return Response.json({results:[{day:"2026-10-01",total_cost:1.2},{day:"2026-10-02",total_cost:0.8}]});
  });
  const m=await collectAiGateway(now);
  assert.equal(m.available,true);assert.equal(m.used,2);assert.equal(m.percent,40);assert.equal(m.limitBasis,"budget");
  assert.match(m.detail,/\$50.00 credit balance/);assert.doesNotMatch(m.detail,/free budget/);
});

test("free Gateway plan retains credit balance but cannot claim measured monthly spend",async t=> {
  await platformSetup(t);process.env.AI_GATEWAY_API_KEY="offline-key";
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=>String(input).endsWith("/credits")
    ? Response.json({balance:"4.25",total_used:"0.75"})
    : Response.json({error:{message:"Spend report access requires a paid plan",type:"forbidden"}},{status:403}));
  const m=await collectAiGateway(now);
  assert.equal(m.available,false);assert.equal(m.percent,0);
  assert.match(m.detail,/\$4.25 credit balance/);assert.match(m.detail,/paid plan/);
  assert.match(m.detail,/not a monthly spend measurement/);
});
