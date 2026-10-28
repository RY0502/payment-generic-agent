/**
 * Payment data helpers: key aliasing, value resolution and missing-data detection.
 * The agent never types free-form values: it references a payment data key and the value is resolved here.
 */

import type { PaymentData } from "./types.js";

/** Keys that represent real user data; if a page needs one of these and it is absent the run must fail. */
export const STANDARD_KEYS = ["accountNumber", "amount", "mobileNumber", "email", "customerName", "upiId"] as const;

const ALIASES: Record<string, string> = {
  mobile: "mobileNumber",
  mobileno: "mobileNumber",
  phone: "mobileNumber",
  phonenumber: "mobileNumber",
  jionumber: "mobileNumber",
  airtelnumber: "mobileNumber",
  account: "accountNumber",
  accountno: "accountNumber",
  ca: "accountNumber",
  canumber: "accountNumber",
  canno: "accountNumber",
  bpnumber: "accountNumber",
  bpno: "accountNumber",
  consumernumber: "accountNumber",
  consumerno: "accountNumber",
  customerid: "accountNumber",
  kno: "accountNumber",
  name: "customerName",
  fullname: "customerName",
  emailid: "email",
  emailaddress: "email",
  upi: "upiId",
  vpa: "upiId",
  billamount: "amount",
  paymentamount: "amount",
};

/** Normalises a key for alias lookup ("CA Number" -> "canumber"). */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps a requested key (or alias) to the canonical key present in the data, if any. */
export function canonicalKey(data: PaymentData, key: string): string {
  if (key in data) return key;
  const norm = normaliseKey(key);
  const direct = Object.keys(data).find((k) => normaliseKey(k) === norm);
  if (direct) return direct;
  return ALIASES[norm] ?? key;
}

/** Returns the non-empty value for a key (following aliases); mobileNumber falls back to accountNumber when it is a phone number. */
export function resolveValue(data: PaymentData, key: string): string | undefined {
  const canonical = canonicalKey(data, key);
  const value = data[canonical]?.toString().trim();
  if (value) return value;
  if (canonical === "mobileNumber" && /^\d{10}$/.test(data.accountNumber || "")) return data.accountNumber;
  if (canonical === "accountNumber" && data.mobileNumber) return data.mobileNumber;
  return undefined;
}

/** True when the key refers to standard user data (so its absence is a hard failure). */
export function isStandardKey(data: PaymentData, key: string): boolean {
  return (STANDARD_KEYS as readonly string[]).includes(canonicalKey(data, key));
}

/** Lists keys that currently have values (for LLM hints). */
export function availableKeys(data: PaymentData): string[] {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && String(v).trim() !== "")
    .map(([k]) => k);
}

/** Removes empty values. */
export function compactData(data: PaymentData): PaymentData {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()]));
}
