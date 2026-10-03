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
