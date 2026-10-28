/**
 * Payment success / failure detection: cheap text+URL heuristics first, vision confirmation second.
 */

import type { BrowserManager } from "./browser.js";
import type { VisionAnalyzer } from "./vision.js";

export const SUCCESS_KEYWORDS = [
  "payment successful",
  "payment success",
  "payment is successful",
  "transaction successful",
  "transaction success",
  "payment received",
  "payment status: success",
  "payment status : success",
  "paid successfully",
  "payment completed",
  "payment done",
  "transaction reference number",
  "receipt for payment",
  "payment acknowledgement",
  "thank you for your payment",
  "recharge successful",
];

export const FAILURE_PHRASES = ["payment failed", "transaction failed", "payment declined", "transaction declined", "payment unsuccessful", "transaction unsuccessful", "payment cancelled", "payment rejected"];

const PRE_PAYMENT_URL_KEYWORDS = ["verify-quickpay", "quick-pay", "home", "login", "registration", "appointment"];

/** True when page text/URL contains a strong success phrase and the URL is not a known pre-payment page. */
export function hasSuccessSignal(url: string, text: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (PRE_PAYMENT_URL_KEYWORDS.some((k) => lowerUrl.includes(k)) && !/success|status|receipt|response/.test(lowerUrl)) return false;
  const lower = text.toLowerCase();
  return SUCCESS_KEYWORDS.some((k) => lower.includes(k));
}

/** Returns the failure phrase found in the text, if any. */
export function findFailurePhrase(text: string): string | null {
  const lower = text.toLowerCase();
  return FAILURE_PHRASES.find((p) => lower.includes(p)) ?? null;
}

/** Full check: heuristics, then a vision confirmation screenshot (kept on disk for the email). */
export async function confirmPaymentSuccess(
  browser: BrowserManager,
  vision: VisionAnalyzer,
  opts: { requireSignal?: boolean } = {}
): Promise<{ success: boolean; url: string; text: string }> {
  const url = await browser.getCurrentUrl();
  const text = await browser.getPageText().catch(() => "");
  if (opts.requireSignal && !hasSuccessSignal(url, text)) return { success: false, url, text };
  const screenshot = await browser.captureScreenshot();
  const success = await vision.detectPaymentSuccess(screenshot, text);
  return { success, url, text };
}
