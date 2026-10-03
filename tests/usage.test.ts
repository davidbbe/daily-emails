import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { briefFixture } from "./fixtures";

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
  process.env.RESEND_API_KEY = "offline-send-only-key";
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
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer offline-send-only-key");
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
  assert.match(renderOperationsText({ ...briefFixture(), usage }), /Some usage readings are unavailable/);
  assert.doesNotMatch(renderOperationsHtml({ ...briefFixture(), usage }), /All tracked quotas.*under/);
});

test("an uncapped Resend plan renders No cap without a fake usage percentage", async (t) => {
  await setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ emails: { ...windows, daily: { ...windows.daily, limit: null } } }));
  const metrics = await collectResendQuota(now);
  assert.equal(metrics[0].limit, null);
  assert.equal(metrics[0].available, true);
  assert.equal(metrics[0].percent, 0);
  const usage = { collectedAt: now.toISOString(), thresholdPercent: 50, metrics: [metrics[0]], watch: [] };
  assert.match(renderOperationsHtml({ ...briefFixture(), usage }), /No cap/);
  const text = renderOperationsText({ ...briefFixture(), usage });
  assert.match(text, /No cap/);
  assert.doesNotMatch(text, /\(0%\)/);
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
function platformDays() {
  return Array.from({length:30},(_,i)=>({
    date:new Date(Date.UTC(2026,8,3+i)).toISOString(),
    bandwidth_incoming_bytes:2,bandwidth_outgoing_bytes:8,request_hit_count:3,request_miss_count:1,
    function_invocation_successful_count:1,function_invocation_error_count:0,function_invocation_timeout_count:0,function_invocation_throttle_count:0,
    blob_simple_request_count:5,blob_advanced_request_count:2,
  }));
}
async function platformSetup(t:TestContext) {
  await setup(t);process.env.VERCEL_TOKEN="offline-token";process.env.VERCEL_TEAM_ID="offline-team";
}
test("Vercel sums exactly 30 complete UTC dates and confirms Hobby scope",async t=> {
  await platformSetup(t);
  const data=platformDays();
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request)=> {
    const url=new URL(String(input));
    if(url.pathname.includes("/teams/")) return Response.json({billing:{plan:"hobby"}});
    assert.equal(url.searchParams.get("from"),"2026-09-03T00:00:00.000Z");
    assert.equal(url.searchParams.get("to"),"2026-10-02T23:59:59.999Z");
    return Response.json({data:[...data,{...data[0],date:"2026-10-03T00:00:00.000Z",bandwidth_outgoing_bytes:999}],lastUpdate:"2026-10-03T08:00:00Z"});
  });
  const metrics=await collectPlatformUsage(now);
  assert.equal(metrics[0].used,300);assert.equal(metrics[1].used,120);assert.equal(metrics[3].used,150);
  assert.ok(metrics.every(m=>m.available));assert.match(metrics[3].detail,/provider updated 2026-10-03T08:00:00/);
  assert.match(metrics[0].detail,/all projects in team/);assert.equal(metrics[1].label,"CDN Requests");
});
test("missing Vercel counters are unavailable, not zero; Blob survives request failure",async t=> {
  await platformSetup(t);
  t.mock.method(globalThis,"fetch",async (input:string|URL|Request)=> {
    const url=new URL(String(input));
    if(url.pathname.includes("/teams/"))return Response.json({billing:{plan:"hobby"}});
    return url.searchParams.get("type")==="requests"?new Response("",{status:503}):Response.json({data:platformDays()});
  });
  let metrics=await collectPlatformUsage(now);
  assert.ok(metrics.slice(0,3).every(m=>!m.available));assert.ok(metrics.slice(3).every(m=>m.available));
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=> {
    if(String(input).includes("/teams/"))return Response.json({billing:{plan:"pro"}});
    return Response.json({data:platformDays().map(d=>({...d,request_hit_count:undefined}))});
  });
  metrics=await collectPlatformUsage(now);
  assert.equal(metrics[1].available,false);assert.equal(metrics[0].limit,null);assert.equal(metrics[0].limitBasis,"unknown");
  const report={...briefFixture(),usage:{collectedAt:now.toISOString(),thresholdPercent:50,metrics,watch:[]}};
  assert.match(renderOperationsHtml(report),/Cap unverified/);
});
test("malformed, duplicate or incomplete Vercel buckets never produce a verified total",async t=> {
  await platformSetup(t);
  for(const data of [undefined,[],platformDays().slice(1),[...platformDays(),platformDays()[0]]]) {
    t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=>String(input).includes("/teams/")?Response.json({billing:{plan:"hobby"}}):Response.json({data}));
    assert.ok((await collectPlatformUsage(now)).every(m=>!m.available));
  }
});
test("platform cache expires at 24 hours, rejects other teams, legacy and invalid counters",()=> {
  const payload={teamId:"offline-team",updatedAt:now.toISOString(),from:"2026-09-03T00:00:00Z",to:"2026-10-02T23:59:59.999Z",metrics:[{id:"edge-requests",label:"CDN Requests",used:20,limit:100,unit:"requests",available:true,detail:"dated snapshot"}]};
  const parse=(p:unknown,team="offline-team",at=now)=>parsePlatformUsageCache(JSON.stringify(p),team,at);
  assert.equal(parse(payload)?.[0].source,"cached");assert.equal(parse(payload)?.[0].percent,20);
  assert.equal(parse(payload,"another-team"),null);assert.equal(parse(payload,"offline-team",new Date(now.getTime()+86400000)),null);
  assert.equal(parse({...payload,updatedAt:"2099-01-01T00:00:00Z"}),null);
  assert.equal(parse({...payload,teamId:undefined}),null);
  assert.equal(parse({...payload,metrics:[{...payload.metrics[0],used:-1}]}),null);
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
