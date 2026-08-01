import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DailyBrief } from "@/lib/brief";
import { sendBriefEmail } from "@/lib/email";
import { collectUsageReport } from "@/lib/usage";

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), filename), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env) || filename.endsWith(".local")) {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const brief: DailyBrief = {
  tickers: [
    {
      id: "TSLA",
      label: "Tesla (TSLA)",
      bullets: [
        { text: "Test bullet for email layout review.", flag: "Watch" },
      ],
      whyItMatters:
        "Placeholder — full AI brief skipped due to Gateway rate limit.",
      overnightOpener: "Quiet overnight (test send).",
      watchlistDelta: "Test send — no prior comparison.",
    },
    {
      id: "MU",
      label: "Micron (MU)",
      bullets: [{ text: "Placeholder Micron note.", flag: "Noise" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
      watchlistDelta: "Test send — no prior comparison.",
    },
    {
      id: "META",
      label: "Meta (META)",
      bullets: [{ text: "Placeholder Meta note.", flag: "Actionable" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
      watchlistDelta: "Test send — no prior comparison.",
    },
    {
      id: "BTC",
      label: "Bitcoin (BTC)",
      bullets: [{ text: "Placeholder BTC note.", flag: "Watch" }],
      whyItMatters: "Layout check only.",
      overnightOpener: "Quiet overnight (test send).",
      watchlistDelta: "Test send — no prior comparison.",
    },
  ],
  people: [
    { id: "karpathy", name: "Andrej Karpathy", summary: "None found" },
    { id: "huang", name: "Jensen Huang", summary: "None found" },
    { id: "karp", name: "Alex Karp", summary: "None found" },
    { id: "altman", name: "Sam Altman", summary: "None found" },
  ],
  earningsCalendar: [],
  themeOfTheDay:
    "TEST EMAIL — review the Usage watch + Vercel & delivery usage sections at the bottom.",
  regionalPulse: "Placeholder regional pulse for layout review.",
  trends: {
    regions: [
      { id: "us", label: "United States", items: [] },
      { id: "thailand", label: "Thailand", items: [] },
      { id: "bulgaria", label: "Bulgaria", items: [] },
    ],
    crossRegion: [],
  },
  generatedAt: new Date().toISOString(),
  model: "test-send (no LLM)",
  windowHours: 24,
  catalystWindowHours: 24 * 14,
  hasPreviousBrief: true,
};

async function main() {
  const usage = await collectUsageReport();
  const email = await sendBriefEmail(brief, usage);
  console.log(
    JSON.stringify(
      {
        ok: true,
        emailId: email?.id ?? null,
        to: process.env.EMAIL_TO,
        watch: usage.watch.map((m) => ({
          id: m.id,
          percent: m.percent,
        })),
        metrics: usage.metrics.map((m) => ({
          id: m.id,
          available: m.available,
          percent: m.percent,
          detail: m.detail,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
