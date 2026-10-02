import type { DailyBrief } from "@/lib/brief";
import type { ResearchBundle } from "@/lib/research";
import { emptyInsiderBrief } from "@/lib/openinsider";
import { emptyWhaleResearch } from "@/lib/whales";

export function researchFixture(): ResearchBundle {
  return {
    collectedAt: "2026-10-02T09:00:00.000Z",
    windowHours: 24,
    tickers: {},
    people: {},
    trends: { us: [], thailand: [] },
    earnings: [],
    reddit: [],
    sites: [],
    sentiment: { collectedAt: "2026-10-02T09:00:00.000Z", meters: [], tickers: [], valueDial: "" },
    insiders: emptyInsiderBrief(),
    whales: emptyWhaleResearch(),
    valuation: [],
    gcpBilling: null,
  };
}

export function briefFixture(): DailyBrief {
  const research = researchFixture();
  return {
    ...research,
    tickers: [],
    people: [],
    earningsCalendar: [],
    trends: { regions: [], crossRegion: [] },
    whales: {
      collectedAt: research.collectedAt,
      quarterLabel: "",
      briefing: "",
      themes: [],
      clusteredBuys: [],
      notableBuys: [],
      realtimeBuys: [],
      watchlist: [],
      sourceUrl: "https://www.dataroma.com",
      sourceName: "Dataroma",
    },
    generatedAt: research.collectedAt,
    model: "offline-test",
    hasPreviousBrief: false,
  };
}
