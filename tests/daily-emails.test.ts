import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { briefFixture, operationsFixture } from "./fixtures";

// Import persistence after changing directory so tests cannot touch real history.
const originalCwd = process.cwd();
const workspace = await mkdtemp(path.join(tmpdir(), "daily-emails-delivery-"));
process.chdir(workspace);
const { sendDailyEmails } = await import("@/lib/delivery");
const { renderBriefHtml, renderBriefText, renderOperationsHtml, renderOperationsText, sendOperationsEmail } = await import("@/lib/email");
after(async () => { process.chdir(originalCwd); await rm(workspace, { recursive: true, force: true }); });
const historyPath = path.join(workspace, ".data/previous-brief.json");

async function setup(t: TestContext) {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  Object.assign(process.env, { RESEND_API_KEY: "offline-key", EMAIL_FROM: "brief@example.com", EMAIL_TO: "reader@example.com", APP_BASE_URL: "https://example.com", MARKETS_PAGE_SECRET: "offline-markets-secret" });
  for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "VERCEL", "AWS_LAMBDA_FUNCTION_NAME"]) delete process.env[key];
  t.mock.method(console, "warn", () => {});
  await rm(historyPath, { recursive: true, force: true });
}

test("operational data lives exclusively in its own HTML and plain-text email", async (t) => {
  await setup(t);
  const report = operationsFixture();
  const brief = { ...briefFixture(), sites: report.sites, gcpBilling: report.gcpBilling };
  for (const content of [renderBriefHtml(brief), renderBriefText(brief)]) {
    assert.doesNotMatch(content, /GOOGLE ANALYTICS|Google Analytics|Cloud Billing|uwhmap\.com|Resend monthly|Places API/);
    assert.match(content, /https:\/\/example.com\/markets\/offline-markets-secret/);
  }
  for (const content of [renderOperationsHtml(report), renderOperationsText(report)]) {
    for (const expected of ["uwhmap.com", "Places API", "Nearby Search Enterprise", "AI Gateway credits", "Resend monthly emails", "Provisional GA4", "Export data can arrive late"]) {
      assert.ok(content.includes(expected), `Missing ${expected}`);
    }
    assert.doesNotMatch(content, /offline-markets-secret|Speeches|WEB TRENDS|REDDIT/);
    assert.ok(content.includes(report.gcpBilling!.reportsUrl));
    assert.match(content, /before both daily emails are sent/);
  }
});

test("operations rendering escapes dynamic data and labels unavailable reports", async (t) => {
  await setup(t);
  const report = operationsFixture();
  report.sites[0].label = '<script>alert("site")</script>';
  report.gcpBilling!.accountLabel = "<billing>";
  report.usage.metrics[0].detail = "<usage>";
  const html = renderOperationsHtml(report);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;billing&gt;"));
  assert.ok(html.includes("&lt;usage&gt;"));
  assert.doesNotMatch(html, /<script>|<billing>|<usage>/);
  for (const content of [renderOperationsHtml({ ...report, sites: [], gcpBilling: null }), renderOperationsText({ ...report, sites: [], gcpBilling: null })]) {
    assert.match(content, /Google Analytics data is unavailable/);
    assert.match(content, /Cloud Billing data is unavailable/);
    assert.match(content, /Resend monthly emails/);
  }
  report.gcpBilling!.error = "Export unavailable";
  for (const content of [renderOperationsHtml(report), renderOperationsText(report)]) {
    assert.ok(content.includes(report.gcpBilling!.reportsUrl));
    assert.match(content, /Export unavailable/);
  }
});

test("operations retries reuse a separate payload-derived idempotency key", async (t) => {
  await setup(t);
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    assert.ok(init.signal instanceof AbortSignal);
    requests.push(init);
    return Response.json({ id: "operations-id" });
  });
  const report = operationsFixture();
  await sendOperationsEmail(report);
  await sendOperationsEmail(report);
  await sendOperationsEmail({ ...report, generatedAt: "2026-10-04T09:00:00.000Z" });
  const keys = requests.map((request) => new Headers(request.headers).get("Idempotency-Key"));
  assert.match(keys[0]!, /^daily-operations\//);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  const body = JSON.parse(String(requests[0].body));
  assert.equal(body.subject, "Analytics, Billing & Usage · 3 Oct 2026");
  assert.deepEqual(body.to, ["reader@example.com"]);
  assert.ok(body.html && body.text);
});

test("a billing renderer failure retains analytics, usage and the billing source link", async (t) => {
  await setup(t);
  const report = operationsFixture();
  const reportsUrl = report.gcpBilling!.reportsUrl;
  Object.defineProperty(report.gcpBilling!, "apiUsage", { get() { throw new Error("Malformed optional billing data"); } });
  for (const content of [renderOperationsHtml(report), renderOperationsText(report)]) {
    assert.match(content, /Cloud Billing data is unavailable/);
    assert.match(content, /uwhmap.com/);
    assert.match(content, /Resend monthly emails/);
    assert.ok(content.includes(reportsUrl));
  }
});

test("empty usage cannot look like a verified healthy quota report", async (t) => {
  await setup(t);
  const report = operationsFixture();
  report.usage.metrics = [];
  report.usage.watch = [];
  for (const content of [renderOperationsHtml(report), renderOperationsText(report)]) {
    assert.match(content, /Usage readings are unavailable/);
    assert.doesNotMatch(content, /All tracked quotas.*under/);
  }
});

for (const failed of ["neither", "brief", "operations", "both"] as const) {
  test(`both emails are attempted when ${failed} delivery fails; history follows the main digest`, async (t) => {
    await setup(t);
    await mkdir(path.dirname(historyPath), { recursive: true });
    await writeFile(historyPath, JSON.stringify({ generatedAt: "last-success" }));
    const requests: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
      assert.equal(String(input), "https://api.resend.com/emails");
      requests.push(init);
      const kind = new Headers(init.headers).get("Idempotency-Key")!.startsWith("daily-brief/") ? "brief" : "operations";
      if (failed === "both" || failed === kind) return Response.json({ message: `${kind} rejected` }, { status: 503 });
      return Response.json({ id: `${kind}-id` });
    });
    const report = operationsFixture();
    const brief = { ...briefFixture(), sites: report.sites, gcpBilling: report.gcpBilling };
    const deliveries = await sendDailyEmails(brief, report.usage);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => JSON.parse(String(request.body)).subject), [
      "Markets, News & Trends · 2 Oct 2026",
      "Analytics, Billing & Usage · 2 Oct 2026",
    ]);
    assert.match(new Headers(requests[0].headers).get("Idempotency-Key")!, /^daily-brief\//);
    assert.match(new Headers(requests[1].headers).get("Idempotency-Key")!, /^daily-operations\//);
    for (const kind of ["brief", "operations"] as const) {
      const fails = failed === "both" || failed === kind;
      assert.equal(deliveries[kind].id, fails ? null : `${kind}-id`);
      assert.equal(deliveries[kind].error, fails ? `Resend error: ${kind} rejected` : null);
    }
    const history = JSON.parse(await readFile(historyPath, "utf8"));
    assert.equal(history.generatedAt, deliveries.brief.id ? brief.generatedAt : "last-success");
  });
}

test("history write failure does not invalidate either accepted email", async (t) => {
  await setup(t);
  await mkdir(historyPath, { recursive: true });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    return Response.json({ id: `email-${++calls}` });
  });
  const deliveries = await sendDailyEmails(briefFixture(), operationsFixture().usage);
  assert.deepEqual(deliveries, { brief: { id: "email-1", error: null }, operations: { id: "email-2", error: null } });
});
