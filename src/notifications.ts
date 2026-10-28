/**
 * Push notifications (Supabase functions): QR payment link + OTP request/lookup.
 * Same endpoints and payloads as the original agent.
 */

import type { PaymentData } from "./types.js";

export type FetchFn = typeof fetch;

/** POSTs JSON with the Supabase bearer token. */
async function postJson(fetchFn: FetchFn, url: string, anonKey: string, body: unknown): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Sends the QR image URL + payment data to the user's phone. Returns a human readable status. */
export async function sendQrNotification(paymentData: PaymentData, qrUrl: string, fetchFn: FetchFn = fetch): Promise<{ sent: boolean; message: string }> {
  const url = process.env.PAYMENT_NOTIFICATION_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { sent: false, message: "Push notification not configured (PAYMENT_NOTIFICATION_URL / SUPABASE_ANON_KEY missing)" };
  try {
    const response = await postJson(fetchFn, url, key, { paymentData: paymentData || { paymentType: "unknown" }, paymentUrl: qrUrl });
    const text = await response.text();
    return response.ok ? { sent: true, message: "QR notification sent to user's phone" } : { sent: false, message: `Notification failed (${response.status}): ${text}` };
  } catch (error) {
    return { sent: false, message: `Notification error: ${error}` };
  }
}

/** Reads OTP service configuration; null if incomplete. */
export function otpConfig(): { notificationUrl: string; lookupUrl: string; anonKey: string } | null {
  const notificationUrl = process.env.OTP_NOTIFICATION_URL;
  const lookupUrl = process.env.OTP_LOOKUP_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  return notificationUrl && lookupUrl && anonKey ? { notificationUrl, lookupUrl, anonKey } : null;
}

/** Sends the "please enter OTP" push notification. Throws on HTTP failure. */
export async function requestOtp(identifier: string, fetchFn: FetchFn = fetch): Promise<void> {
  const cfg = otpConfig();
  if (!cfg) throw new Error("OTP service not configured (OTP_NOTIFICATION_URL, OTP_LOOKUP_URL, SUPABASE_ANON_KEY required)");
  const response = await postJson(fetchFn, cfg.notificationUrl, cfg.anonKey, { message: "Please enter the OTP code received for the payment", identifier });
  if (!response.ok) throw new Error(`OTP push notification failed: ${response.status} ${await response.text()}`);
}

/** Looks up the OTP the user entered; returns digits or null if not yet available. */
export async function fetchOtpCode(identifier: string, fetchFn: FetchFn = fetch): Promise<string | null> {
  const cfg = otpConfig();
  if (!cfg) throw new Error("OTP service not configured");
  const response = await postJson(fetchFn, cfg.lookupUrl, cfg.anonKey, { identifier });
  if (!response.ok) throw new Error(`lookup returned ${response.status}: ${await response.text()}`);
  const data: any = await response.json();
  if (data?.code === null || data?.code === undefined) return null;
  const digits = String(data.code).replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** Polls for the OTP until it arrives or the total wait elapses. */
export async function pollOtp(
  identifier: string,
  opts: { pollMs: number; totalMs: number; sleep?: (ms: number) => Promise<void>; fetchFn?: FetchFn }
): Promise<string | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (let attempt = 1; Date.now() - start < opts.totalMs; attempt++) {
    await sleep(Math.min(opts.pollMs, Math.max(0, opts.totalMs - (Date.now() - start))));
    try {
      const code = await fetchOtpCode(identifier, opts.fetchFn);
      if (code) return code;
    } catch (error) {
      console.error(`OTP lookup attempt ${attempt} failed:`, error);
    }
    console.log(`⏳ OTP not received yet (attempt ${attempt})`);
  }
  return null;
}
