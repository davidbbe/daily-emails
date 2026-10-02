import assert from "node:assert/strict";
import test from "node:test";
import { GET, HEAD } from "@/app/api/daily-brief/route";
import { sendBriefEmail, renderBriefHtml } from "@/lib/email";
import { briefFixture } from "./fixtures";

test("HEAD cannot send email or call any providers", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network call"); });
  const response = HEAD();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(await response.text(), "");
});

test("production GET fails closed when CRON_SECRET is unset", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.CRON_SECRET;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network call"); });
  assert.equal((await GET(new Request("https://example.com/api/daily-brief"))).status, 401);
});

test("missing delivery configuration fails before research or AI calls", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.CRON_SECRET = "offline-secret";
  delete process.env.RESEND_API_KEY;
  t.mock.method(console, "error", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected network call"); });
  const response = await GET(new Request("https://example.com/api/daily-brief", { headers: { Authorization: "Bearer offline-secret" } }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "RESEND_API_KEY is required");
  assert.equal(calls, 0);
});

test("identical sends reuse an idempotency key; new briefs use a new key", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.RESEND_API_KEY = "offline-key";
  process.env.EMAIL_FROM = "brief@example.com";
  process.env.EMAIL_TO = "reader@example.com";
  process.env.APP_BASE_URL = "https://example.com";
  process.env.MARKETS_PAGE_SECRET = "offline-markets-secret";
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    requests.push(init);
    return Response.json({ id: "offline-email-id" });
  });
  const brief = briefFixture();
  assert.deepEqual(await sendBriefEmail(brief), { id: "offline-email-id" });
  await sendBriefEmail(brief);
  await sendBriefEmail({ ...brief, generatedAt: "2026-10-03T09:00:00.000Z" });
  const keys = requests.map((request) => new Headers(request.headers).get("Idempotency-Key"));
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
  const body = JSON.parse(String(requests[0].body));
  assert.equal(body.from, "Daily Emails <brief@example.com>");
  assert.deepEqual(body.to, ["reader@example.com"]);
  assert.ok(body.html && body.text);
});

test("a successful HTTP response without a delivery id is a failure", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.RESEND_API_KEY = "offline-key";
  process.env.EMAIL_FROM = "brief@example.com";
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(sendBriefEmail(briefFixture()), /without an email id/);
});

test("email rendering escapes source text", () => {
  const brief = briefFixture();
  brief.people = [{ id: "huang", name: "Jensen Huang", summary: "<script>alert(1)</script>", items: [{ summary: "<script>alert(1)</script>" }] }];
  const html = renderBriefHtml(brief);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
});
