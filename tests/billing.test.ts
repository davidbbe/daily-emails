import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JWT } from "google-auth-library";
import { collectGcpBilling } from "@/lib/gcp-billing";

function setup(t: TestContext) {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.GOOGLE_CLIENT_EMAIL = "offline@test.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "offline-private-key";
  process.env.GOOGLE_CLOUD_PROJECT = "test";
  process.env.GCP_BILLING_ACCOUNT_ID = "111111-222222-333333";
  process.env.GCP_BILLING_BQ_TABLE = "test.billing.export";
  t.mock.method(console, "warn", () => {});
  t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "offline-token" }));
}

const jobReference = { projectId: "job-project", jobId: "offline-job", location: "asia-southeast1" };
function row(cost: number) {
  const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  return { f: [day, "Compute Engine", `SKU ${cost}`, "test", String(cost), "0", "1", "requests"].map((v) => ({ v })) };
}

test("billing discovery skips exports for other accounts and filters the query", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.GOOGLE_CLIENT_EMAIL = "offline@test.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "offline-private-key";
  process.env.GOOGLE_CLOUD_PROJECT = "test";
  process.env.GCP_BILLING_ACCOUNT_ID = "111111-222222-333333";
  delete process.env.GCP_BILLING_BQ_TABLE;
  t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "offline-token" }));
  let query = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    assert.ok(init.signal);
    if (String(input).endsWith("/datasets")) return Response.json({ datasets: [{ datasetReference: { datasetId: "billing" } }] });
    if (String(input).endsWith("/tables")) return Response.json({ tables: [
      { tableReference: { tableId: "gcp_billing_export_v1_999999_999999_999999" } },
      { tableReference: { tableId: "gcp_billing_export_v1_111111_222222_333333" } },
    ] });
    assert.ok(String(input).endsWith("/queries"));
    const body = JSON.parse(String(init.body));
    query = body.query;
    assert.ok(body.queryParameters.some((p: { name: string; parameterValue: { value: string } }) => p.name === "account" && p.parameterValue.value === "111111-222222-333333"));
    return Response.json({ jobComplete: true, rows: [] });
  });
  await collectGcpBilling();
  assert.ok(query.includes("`test.billing.gcp_billing_export_v1_111111_222222_333333`"));
  assert.ok(query.includes("billing_account_id = @account"));
});

test("paginated BigQuery results cannot silently understate billing totals", async (t) => {
  const oldEnv = { ...process.env };
  t.after(() => { process.env = oldEnv; });
  process.env.GOOGLE_CLIENT_EMAIL = "offline@test.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "offline-private-key";
  process.env.GCP_BILLING_BQ_TABLE = "test.billing.export";
  t.mock.method(console, "warn", () => {});
  t.mock.method(JWT.prototype, "getAccessToken", async () => ({ token: "offline-token" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ jobComplete: true, pageToken: "more", totalRows: "10001", rows: [] }));
  const report = await collectGcpBilling();
  assert.match(report?.error ?? "", /incomplete totals/);
});

test("billing totals include all query pages from the same job and location", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    assert.ok(init.signal);
    const url = new URL(String(input));
    calls++;
    if (calls === 1) {
      assert.equal(init.method, "POST");
      return Response.json({ jobComplete: true, jobReference, pageToken: "page + 2", totalRows: "3", rows: [row(10)] });
    }
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(url.pathname, "/bigquery/v2/projects/job-project/queries/offline-job");
    assert.equal(url.searchParams.get("location"), "asia-southeast1");
    assert.equal(url.searchParams.get("pageToken"), calls === 2 ? "page + 2" : "page3");
    return Response.json({ jobComplete: true, totalRows: "3", rows: [row(calls === 2 ? 20 : 30)], ...(calls === 2 ? { pageToken: "page3" } : {}) });
  });
  const report = await collectGcpBilling();
  assert.equal(calls, 3);
  assert.equal(report?.error, undefined);
  assert.equal(report?.total, 60);
  assert.equal(report?.services[0].usageCost, 60);
});

test("billing discovery finds the account export on later dataset and table pages", async (t) => {
  setup(t);
  delete process.env.GCP_BILLING_BQ_TABLE;
  let query = "";
  const visits: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    const url = new URL(String(input));
    visits.push(`${url.pathname}?${url.searchParams}`);
    const page = url.searchParams.get("pageToken");
    if (url.pathname.endsWith("/datasets")) {
      return Response.json(page
        ? { datasets: [{ datasetReference: { datasetId: "billing" } }] }
        : { datasets: [{ datasetReference: { datasetId: "other" } }], nextPageToken: "datasets2" });
    }
    if (url.pathname.endsWith("/other/tables")) return Response.json({ tables: [] });
    if (url.pathname.endsWith("/billing/tables")) {
      return Response.json(page
        ? { tables: [{ tableReference: { tableId: "gcp_billing_export_v1_111111_222222_333333" } }] }
        : { tables: [{ tableReference: { tableId: "gcp_billing_export_v1_999999_999999_999999" } }], nextPageToken: "tables2" });
    }
    query = JSON.parse(String(init.body)).query;
    return Response.json({ jobComplete: true, totalRows: "0", rows: [] });
  });
  await collectGcpBilling();
  assert.ok(visits.some((v) => v.includes("pageToken=datasets2")));
  assert.ok(visits.some((v) => v.includes("pageToken=tables2")));
  assert.ok(query.includes("`test.billing.gcp_billing_export_v1_111111_222222_333333`"));
});

for (const failure of ["http", "repeated-token", "row-count", "deadline"] as const) {
  test(`a later billing page ${failure} failure never reports a partial total`, async (t) => {
    setup(t);
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    if (failure === "deadline") {
      t.mock.method(AbortSignal, "timeout", (ms: number) => ms === 60_000 ? deadline.signal : originalTimeout(ms));
    }
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init: RequestInit) => {
      calls++;
      if (calls === 1) return Response.json({ jobComplete: true, jobReference, totalRows: "3", pageToken: "next", rows: [row(10)] });
      if (failure === "http") return Response.json({ error: { message: "page unavailable" } }, { status: 503 });
      if (failure === "deadline") {
        deadline.abort(new Error("billing deadline exceeded"));
        init.signal?.throwIfAborted();
      }
      return Response.json({ jobComplete: true, totalRows: "3", rows: [row(20)], ...(failure === "repeated-token" ? { pageToken: "next" } : {}) });
    });
    const report = await collectGcpBilling();
    assert.equal(calls, 2);
    assert.ok(report?.error);
    assert.equal(report?.total, 0);
    assert.deepEqual(report?.services, []);
  });
}

test("zero-cost exports retain MTD, usage, and freshness without claiming pricing lag", async (t) => {
  setup(t);
  const free = row(0);
  free.f[1].v = "Places API (New)";
  free.f[2].v = "Nearby Search Enterprise";
  free.f[6].v = "42";
  free.f.push({ v: "2026-10-03 03:40:26+00" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ jobComplete:true, rows:[free] }));
  const report = await collectGcpBilling();
  assert.equal(report?.error, undefined);
  assert.equal(report?.total, 0);
  assert.equal(report?.period, "month_to_date");
  assert.equal(report?.apiUsage[0].skus[0].quantity, 42);
  assert.match(report?.freshnessNote ?? "", /Export last updated/);
  assert.doesNotMatch(report?.freshnessNote ?? "", /still being priced/);
});

test("fractional billing rows reconcile with the chart and negative credits survive", async (t) => {
  setup(t);
  const rows = Array.from({length:100},()=>row(0.004));
  const adjustment = row(0);
  adjustment.f[5].v = "-0.1";
  rows.push(adjustment);
  t.mock.method(globalThis, "fetch", async (_input:unknown, init:RequestInit)=> {
    const query = JSON.parse(String(init.body)).query;
    assert.match(query,/currency_conversion_rate/);
    assert.doesNotMatch(query,/DATE\(export_time\) <=/);
    assert.match(query,/MAX\(export_time\)/);
    return Response.json({jobComplete:true,rows});
  });
  const report = await collectGcpBilling();
  assert.equal(report?.total, 0.3);
  const plotted = report!.days.reduce((sum,d)=>sum+Object.values(d.costs).reduce((s,n)=>s+n,0),0);
  assert.ok(Math.abs(plotted-0.3)<1e-9);
  assert.equal(report?.savings,0.1);
  assert.equal(report?.comparisonAvailable,false);
});

test("Gemini image input/output billing units are tokens and unknown currency costs fail visibly", async (t)=> {
  setup(t);
  const r=row(0.1);r.f[1].v="Gemini API";r.f[2].v="Gemini 3.1 Flash Image Image Output";r.f[7].v="count";
  t.mock.method(globalThis,"fetch",async()=>Response.json({jobComplete:true,rows:[r]}));
  const report=await collectGcpBilling();
  assert.equal(report?.apiUsage[0].skus[0].unit,"tokens");
  assert.equal(report?.apiUsage[0].calls,null);
  r.f[4].v="";
  assert.ok((await collectGcpBilling())?.error);
});

test("historical rows cannot become a verified zero-cost current month",async t=> {
  setup(t);
  const old=row(5);old.f[0].v=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),0)).toISOString().slice(0,10);
  t.mock.method(globalThis,"fetch",async()=>Response.json({jobComplete:true,rows:[old]}));
  assert.match((await collectGcpBilling())?.error ?? "",/No month-to-date usage rows/);
});
