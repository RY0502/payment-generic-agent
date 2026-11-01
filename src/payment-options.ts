/**
 * Recognises payment gateway options (BillDesk, PayU, Paytm, ...) and payment methods (QR, UPI, cards, ...)
 * in a page snapshot, and derives the preferred next action:
 *   QR visible > QR option > UPI option > payment gateway (user's choice, then priority list).
 * Cards / net banking / wallets / EMI are never chosen.
 */

import type { PageSnapshot, SnapshotElement } from "./types.js";

export type MethodType = "qr" | "upi" | "netbanking" | "card" | "wallet" | "emi" | "paylater";

/** Patterns are checked in order, so "UPI / QR" is QR and "Cards / UPI" is UPI. */
const METHOD_PATTERNS: [MethodType, RegExp][] = [
  ["qr", /\bqr\b|scan\s*(?:&|and|to)?\s*pay|bharat\s*qr/i],
  ["upi", /\bupi\b|\bbhim\b|\bvpa\b/i],
  ["netbanking", /net\s*-?\s*banking|internet\s*banking/i],
  ["card", /\b(?:credit|debit|atm)\b|\bcards?\b/i],
  ["wallet", /wallets?\b/i],
  ["emi", /\bemi\b/i],
  ["paylater", /pay\s*later|\bbnpl\b/i],
];

export const ALLOWED_METHODS: MethodType[] = ["qr", "upi"];

export const DEFAULT_GATEWAY_PRIORITY = [
  "billdesk", "payu", "razorpay", "paytm", "ccavenue", "cashfree", "phonepe", "easebuzz", "juspay",
  "airpay", "atom", "pay10", "sbiepay", "worldline", "instamojo", "paygov", "citiunion", "cityunion",
];

const OPTION_KINDS = new Set(["radio", "tab", "button", "option"]);
const GATEWAY_GROUP = /gate\s*way|(?:^|[^a-z])pg(?:[^a-z]|$)|pgtype/i;

export interface DetectedOption {
  el: SnapshotElement;
  /** Method type, or the matched gateway key ("gateway" when only the radio group says so). */
  type: string;
}

export interface PaymentOptionsView {
  gateways: DetectedOption[];
  methods: DetectedOption[];
  suggestion: string | null;
}

/** Lowercase alphanumerics only ("Bill Desk" -> "billdesk"). */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Classifies text as a payment method, or null. */
export function classifyMethod(text: string): MethodType | null {
  return METHOD_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** True when the text names a method the agent must not use (cards, net banking, wallets, EMI, pay later). */
export function isDisallowedMethod(text: string): boolean {
  const method = classifyMethod(text);
  return method !== null && !ALLOWED_METHODS.includes(method);
}

/** Returns the known gateway key contained in the text, if any. */
export function matchGateway(text: string, priority: string[]): string | null {
  const norm = normalise(text);
  return priority.find((g) => norm.includes(g)) ?? null;
}

/** Gateway priority from GATEWAY_PRIORITY env (comma separated) or the default list. */
export function gatewayPriority(): string[] {
  const env = process.env.GATEWAY_PRIORITY;
  return env ? env.split(",").map(normalise).filter(Boolean) : DEFAULT_GATEWAY_PRIORITY;
}

/** Elements that can be payment options (not chrome/sidebar/disabled, short labels). */
function candidates(elements: SnapshotElement[]): SnapshotElement[] {
  return elements.filter((e) => OPTION_KINDS.has(e.kind) && !e.inChrome && !e.inSidebar && !e.disabled && e.label && e.label.length <= 50);
}

/** Splits candidates into gateway and method options. */
export function detectOptions(elements: SnapshotElement[], priority = gatewayPriority()): { gateways: DetectedOption[]; methods: DetectedOption[] } {
  const gateways: DetectedOption[] = [];
  const methods: DetectedOption[] = [];
  for (const el of candidates(elements)) {
    const inGatewayGroup = el.kind === "radio" && GATEWAY_GROUP.test(`${el.name ?? ""} ${el.domId ?? ""}`);
    const gateway = matchGateway(el.label, priority);
    const method = classifyMethod(el.label);
    if (inGatewayGroup || (gateway && !method)) gateways.push({ el, type: gateway ?? "gateway" });
    else if (method) methods.push({ el, type: method });
  }
  return { gateways, methods };
}

/** Picks the gateway: user's preference, then priority order, then the first one. */
export function pickGateway(gateways: DetectedOption[], preferred: string | undefined, priority: string[]): DetectedOption | null {
  if (!gateways.length) return null;
  const pref = preferred ? normalise(preferred) : "";
  const byPref = pref ? gateways.find((g) => normalise(g.el.label).includes(pref) || normalise(g.el.domId ?? "").includes(pref)) : undefined;
  const rank = (g: DetectedOption) => (priority.indexOf(g.type) === -1 ? priority.length : priority.indexOf(g.type));
  return byPref ?? [...gateways].sort((a, b) => rank(a) - rank(b))[0];
}

/** Picks the method: QR first, then UPI. */
export function pickMethod(methods: DetectedOption[]): DetectedOption | null {
  return methods.find((m) => m.type === "qr") ?? methods.find((m) => m.type === "upi") ?? null;
}

/** Tool call text for choosing an option (radios via select_option, everything else via click). */
function chooseCall(opt: DetectedOption): string {
  const label = JSON.stringify(opt.el.label);
  return opt.el.kind === "radio" || opt.el.kind === "option"
    ? `select_option({"elementId":"${opt.el.id}","optionName":${label}})`
    : `click({"elementId":"${opt.el.id}","description":${label}})`;
}

/** Suggestion when a method option is the best next step. */
function methodSuggestion(best: DetectedOption): string {
  if (!best.el.checked) return `${chooseCall(best)} - ${best.type === "qr" ? "UPI QR is the preferred payment method" : "UPI is the preferred method when no QR option exists"}.`;
  if (best.type === "qr") return `QR option "${best.el.label}" is already selected: click the button that reveals/generates the QR (e.g. Make Payment / Proceed / Show QR / Generate QR), then scan_upi_qr_code.`;
  return `UPI "${best.el.label}" is selected: if a QR / Scan option appears choose it; otherwise fill the UPI ID field with dataKey "upiId" (fail_payment MISSING_DATA if absent), click Pay/Verify, then wait_for_payment({"after":"upi_collect"}).`;
}

/** Suggestion when a gateway choice is the best next step. */
function gatewaySuggestion(gateways: DetectedOption[], preferred: string | undefined, priority: string[]): string {
  const selected = gateways.find((g) => g.el.checked);
  if (selected) return `Payment gateway "${selected.el.label}" is selected: click the Pay Now / Proceed / Submit button to continue to the gateway.`;
  const pick = pickGateway(gateways, preferred, priority)!;
  return `${chooseCall(pick)} to choose the payment gateway, then click the Pay Now / Proceed button.`;
}

/** Builds the payment options view (detected options + suggested next action) for a snapshot. */
export function analysePaymentOptions(snapshot: PageSnapshot, preferredGateway?: string, priority = gatewayPriority()): PaymentOptionsView {
  const { gateways, methods } = detectOptions(snapshot.elements, priority);
  const best = pickMethod(methods);
  let suggestion: string | null = null;
  if (snapshot.hasQrCode) suggestion = "A QR code is visible: call scan_upi_qr_code now.";
  else if (best) suggestion = methodSuggestion(best);
  else if (gateways.length) suggestion = gatewaySuggestion(gateways, preferredGateway, priority);
  else if (methods.length) suggestion = `Only ${Array.from(new Set(methods.map((m) => m.type))).join(", ")} are offered here. Look for a UPI / QR option (other tabs, "More payment options"); if none exists call fail_payment with code BLOCKED.`;
  return { gateways, methods, suggestion };
}

/** Renders the PAYMENT OPTIONS section (empty string when nothing was detected). */
export function formatPaymentOptions(view: PaymentOptionsView): string {
  if (!view.gateways.length && !view.methods.length && !view.suggestion) return "";
  const line = (o: DetectedOption) => `[${o.el.id}] ${o.el.label}${o.el.checked ? " (selected)" : ""}`;
  const lines = ["PAYMENT OPTIONS:"];
  if (view.gateways.length) lines.push(`  gateways: ${view.gateways.map(line).join(", ")}`);
  if (view.methods.length) lines.push(`  methods: ${view.methods.map((m) => `${line(m)} {${m.type}${ALLOWED_METHODS.includes(m.type as MethodType) ? "" : " - not allowed"}}`).join(", ")}`);
  if (view.suggestion) lines.push(`SUGGESTED NEXT ACTION: ${view.suggestion}`);
  return lines.join("\n");
}
