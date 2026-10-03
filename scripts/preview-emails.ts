/** Offline HTML previews: no provider requests, AI credits, delivery or shared writes. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderBriefHtml, renderBriefText, renderOperationsHtml, renderOperationsText } from "@/lib/email";
import { briefFixture, operationsFixture } from "../tests/fixtures";

const output = path.resolve(".data/email-preview");
const operations = operationsFixture();
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
]) {
  const file = path.join(output, filename);
  await writeFile(file, content);
  console.log(file);
}
