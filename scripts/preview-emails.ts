/** Offline HTML previews: no provider requests, AI credits, delivery or shared writes. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderBriefHtml, renderBriefText, renderOperationsHtml, renderOperationsText } from "@/lib/email";
import { briefFixture, operationsFixture } from "../tests/fixtures";
import type { GcpBillingDay } from "@/lib/gcp-billing";

const output = path.resolve(".data/email-preview");
const operations = operationsFixture();
const month = operationsFixture();
const billing = month.gcpBilling!;
billing.startDate = "2026-09-01";
billing.endDate = "2026-09-30";
billing.previousStartDate = "2026-08-01";
billing.previousEndDate = "2026-08-30";
billing.days = Array.from({ length: 30 }, (_, i): GcpBillingDay => ({
  date: `2026-09-${String(i + 1).padStart(2, "0")}`,
  costs: i === 29 ? {} : { "Places API": i >= 14 && i < 21 ? -0.1 : 0.15, "Gemini API": i >= 14 && i < 21 ? 0 : 0.08 },
}));
for (const service of billing.services) service.usageCost = Number(billing.days.reduce((sum, day) => sum + (day.costs[service.name] ?? 0), 0).toFixed(2));
billing.total = Number(billing.services.reduce((sum, service) => sum + service.usageCost, 0).toFixed(2));
const brief = {
  ...briefFixture(),
  generatedAt: operations.generatedAt,
  people: [{ id: "huang", name: "Jensen Huang", summary: "Example announcement for layout review.", items: [{ summary: "Example announcement for layout review.", sourceUrl: "https://example.com/announcement", sourceName: "Example source" }] }],
  sites: operations.sites,
  gcpBilling: operations.gcpBilling,
};

await mkdir(output, { recursive: true });
for (const [filename, content] of [
  ["brief.html", renderBriefHtml(brief)],
  ["brief.txt", renderBriefText(brief)],
  ["operations.html", renderOperationsHtml(operations)],
  ["operations.txt", renderOperationsText(operations)],
  ["operations-month.html", renderOperationsHtml(month)],
  ["operations-mobile.html", '<!doctype html><html><head><title>Mobile email preview</title></head><body style="margin:0;background:#e2e8f0"><iframe title="390px mobile preview" src="operations-month.html" style="width:390px;height:3600px;border:0;display:block;margin:auto;"></iframe></body></html>'],
]) {
  const file = path.join(output, filename);
  await writeFile(file, content);
  console.log(file);
}
