import type { DailyBrief } from "@/lib/brief";
import { sendBriefEmail, sendOperationsEmail } from "@/lib/email";
import { savePreviousBrief, toSnapshot } from "@/lib/history";
import type { UsageReport } from "@/lib/usage";

export type EmailDelivery = { id: string | null; error: string | null };

async function attemptDelivery(send: () => Promise<{ id: string }>): Promise<EmailDelivery> {
  try {
    const email = await send();
    return { id: email.id, error: null };
  } catch (error) {
    return { id: null, error: error instanceof Error ? error.message : "Email delivery failed" };
  }
}

/** Attempt both deliveries, even when one fails. History follows the main digest. */
export async function sendDailyEmails(brief: DailyBrief, usage: UsageReport) {
  const digest = await attemptDelivery(() => sendBriefEmail(brief));
  if (digest.id) {
    try {
      await savePreviousBrief(toSnapshot(brief));
    } catch (error) {
      console.warn("daily-brief: previous-brief save failed", error);
    }
  }
  const operations = await attemptDelivery(() => sendOperationsEmail({
    generatedAt: brief.generatedAt,
    sites: brief.sites,
    gcpBilling: brief.gcpBilling,
    usage,
  }));
  return { brief: digest, operations };
}
