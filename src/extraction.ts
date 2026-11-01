/**
 * Turns the user's free-form prompt into a validated PaymentRequest.
 * LLM extraction is combined with regex extraction; values not present in the prompt are discarded
 * (no hallucinated data), and missing required data fails fast.
 */

import { parseJsonLoose, type LlmClient } from "./llm.js";
import { compactData } from "./payment-data.js";
import type { PaymentData, PaymentRequest } from "./types.js";

export class MissingDataError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required data: ${missing.join(", ")}`);
    this.name = "MissingDataError";
  }
}

const EXTRACTION_SYSTEM = "You extract structured payment details from user requests. Return ONLY valid JSON.";

/** Builds the extraction prompt. */
export function buildExtractionPrompt(message: string): string {
  return `Extract the payment details from the user's request. Use "" for anything not explicitly stated - NEVER invent values.
Return ONLY JSON:
{"targetUrl":"full website URL (http/https)","paymentType":"electricity|gas|water|postpaid|prepaid|broadband|dth|other",
"billerName":"company/biller (e.g. Jio, Airtel, BSES Rajdhani, IGL)",
"accountNumber":"account/consumer/CA/BP/K number OR the mobile number when paying a mobile bill",
"mobileNumber":"10-digit mobile/phone/jio/airtel number if stated","amount":"number only, e.g. 10",
"email":"","customerName":"","upiId":"","paymentGateway":"e.g. BillDesk if stated","paymentMethod":"e.g. UPI QR if stated",
"extra":{"<otherIdentifierName>":"<value>"}}

User request:
${message}`;
}

/** Amount patterns: a number is only an amount when it is explicitly marked as one (amount / Rs / ₹ / INR / rupees). */
const AMOUNT_PATTERNS = [
  /\bamount\s*(?:of|is|:|-|=)?\s*(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d{1,2})?)(?![\d.])/gi,
  /(?:\brs\.?|\binr|₹)\s*(\d+(?:\.\d{1,2})?)(?![\d.])/gi,
  /(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(?:rs\b|rupees\b|inr\b|₹)/gi,
];

/** All explicitly stated amounts in the prompt, in order of appearance. */
export function statedAmounts(message: string): string[] {
  const found: { index: number; value: string }[] = [];
  for (const re of AMOUNT_PATTERNS) for (const m of message.matchAll(re)) found.push({ index: m.index ?? 0, value: m[1] });
  return Array.from(new Set(found.sort((a, b) => a.index - b.index).map((f) => f.value)));
}

/** Accepts the LLM's amount only if it equals an explicitly stated amount; otherwise the first stated amount (or none). */
export function pickAmount(message: string, llmAmount: unknown): string | undefined {
  const stated = statedAmounts(message);
  const llm = parseFloat(String(llmAmount ?? "").replace(/[^\d.]/g, ""));
  return stated.find((s) => Number.isFinite(llm) && parseFloat(s) === llm) ?? stated[0];
}

/** Regex-based extraction used as a fallback and to cross-check the LLM. */
export function regexExtract(message: string): Partial<PaymentData> & { targetUrl?: string } {
  const url = message.match(/https?:\/\/[^\s"'<>,\]]+/i)?.[0]?.replace(/[.)]+$/, "");
  const email = message.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const amount = statedAmounts(message)[0];
  const account = message.match(/(?:account|ca|bp|consumer|customer|k)\s*(?:number|no\.?|id)?\s*(?:is|:|-)?\s*([A-Z0-9]{6,20})\b/i)?.[1];
  const mobile = message.match(/(?:mobile|phone|jio|airtel)\s*(?:number|no\.?)?\s*(?:is|:|-)?\s*(\d{10})\b/i)?.[1];
  return { targetUrl: url, email, amount, accountNumber: account, mobileNumber: mobile };
}

/**
 * Keeps only values that literally appear in the prompt. Numeric values must appear as a whole number
 * (so "10" is NOT grounded by "1000125036"); text values may appear anywhere (case-insensitive).
 */
export function groundedIn(message: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = String(value).trim();
  if (!v) return undefined;
  if (/^[\d\s.,₹-]+$/.test(v)) {
    const digits = v.replace(/[^\d.]/g, "");
    const tokens = message.split(/[^\d.]+/).map((t) => t.replace(/^\.+|\.+$/g, ""));
    return digits && tokens.includes(digits) ? v : undefined;
  }
  return message.toLowerCase().includes(v.toLowerCase()) ? v : undefined;
}

/** Merges LLM + regex results, grounding every user-data value in the prompt. */
export function mergeExtraction(message: string, llm: any, regex: ReturnType<typeof regexExtract>): PaymentRequest {
  const pick = (key: string) => groundedIn(message, llm?.[key]) ?? groundedIn(message, (regex as any)[key]);
  const extra = Object.fromEntries(Object.entries(llm?.extra ?? {}).map(([k, v]) => [k, groundedIn(message, String(v ?? ""))]));
  const data: PaymentData = {
    ...extra,
    paymentType: llm?.paymentType || undefined,
    billerName: llm?.billerName || undefined,
    accountNumber: pick("accountNumber") ?? pick("mobileNumber"),
    mobileNumber: pick("mobileNumber"),
    amount: pickAmount(message, llm?.amount),
    email: pick("email"),
    customerName: pick("customerName"),
    upiId: pick("upiId"),
    paymentGateway: groundedIn(message, llm?.paymentGateway),
    paymentMethod: groundedIn(message, llm?.paymentMethod),
  };
  return { targetUrl: pick("targetUrl") ?? regex.targetUrl ?? "", paymentData: compactData(data) };
}

/** Throws MissingDataError when data needed to even start a payment is absent. */
export function validateRequest(request: PaymentRequest): PaymentRequest {
  const missing: string[] = [];
  if (!/^https?:\/\//i.test(request.targetUrl)) missing.push("website URL");
  if (!request.paymentData.accountNumber && !request.paymentData.mobileNumber) missing.push("account / consumer / mobile number");
  if (missing.length) throw new MissingDataError(missing);
  return request;
}

/** Full extraction: LLM (best effort) + regex, grounded and validated. */
export async function extractPaymentRequest(message: string, llm: LlmClient): Promise<PaymentRequest> {
  let parsed: any = null;
  try {
    parsed = parseJsonLoose(await llm.invoke({ system: EXTRACTION_SYSTEM, prompt: buildExtractionPrompt(message) }));
  } catch (error) {
    console.warn("LLM extraction failed, using regex extraction only:", error);
  }
  return validateRequest(mergeExtraction(message, parsed, regexExtract(message)));
}
