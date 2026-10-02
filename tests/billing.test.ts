import assert from "node:assert/strict";
import test from "node:test";
import { JWT } from "google-auth-library";
import { collectGcpBilling } from "@/lib/gcp-billing";

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
