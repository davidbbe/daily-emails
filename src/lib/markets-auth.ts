import { timingSafeEqual } from "node:crypto";
import { getMarketsPageSecret } from "@/lib/config";

function toBuffer(value: string) {
  return Buffer.from(value, "utf8");
}

/** True when the URL token matches MARKETS_PAGE_SECRET (or the local/dev fallback). */
export function isValidMarketsToken(token: string | undefined): boolean {
  const expected = getMarketsPageSecret();
  if (!expected || !token) return false;

  const a = toBuffer(token);
  const b = toBuffer(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
