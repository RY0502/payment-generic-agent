/**
 * Payment-specific tools: CAPTCHA, OTP, UPI QR extraction, waiting for payment, success check, failing the run.
 */

import { tool } from "@langchain/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { QR_EXTRACT_SCRIPT } from "../dom-scripts.js";
import { otpConfig, pollOtp, requestOtp, sendQrNotification } from "../notifications.js";
import type { FailureCode, PaymentSession } from "../session.js";
import { solveAndFillCaptcha } from "../strategies/captcha.js";
import { enterOtp } from "../strategies/otp.js";
import { confirmPaymentSuccess, findFailurePhrase, hasSuccessSignal } from "../success.js";
import { errorText } from "./browser-tools.js";

/** Tries to extract a QR image URL from every frame. */
export async function extractQr(session: PaymentSession): Promise<string | null> {
  for (const frame of session.page().frames()) {
    const url = await frame.evaluate(`(${QR_EXTRACT_SCRIPT})()`).catch(() => null);
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/** Polls for a QR code (it often renders a few seconds after the click). */
async function waitForQr(session: PaymentSession, attempts = 4): Promise<string | null> {
  await session.page().locator('[data-testid="central-loader"]').waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  for (let i = 0; i < attempts; i++) {
    await session.sleep(3000);
    const url = await extractQr(session);
    if (url) return url;
  }
  return null;
}

/** Fails the OTP step fatally with a reason. */
function otpFailure(session: PaymentSession, reason: string): string {
  session.setSignal({ type: "fatal", code: "OTP_FAILED", reason });
  return `FATAL: ${reason}`;
}

/** Full OTP flow: push notification -> poll -> type digits -> submit. */
export async function runOtpFlow(session: PaymentSession): Promise<string> {
  if (!otpConfig()) return otpFailure(session, "OTP service not configured (OTP_NOTIFICATION_URL, OTP_LOOKUP_URL, SUPABASE_ANON_KEY required)");
  if (++session.otpRequests > 2) return otpFailure(session, "OTP requested too many times");
  const identifier = randomUUID();
  try {
    console.log(`📱 Sending OTP request notification (identifier: ${identifier})`);
    await requestOtp(identifier, session.fetchFn);
  } catch (error) {
    return otpFailure(session, String(error instanceof Error ? error.message : error));
  }
  const code = await pollOtp(identifier, { pollMs: CONFIG.otpPollMs, totalMs: CONFIG.otpTotalWaitMs, sleep: session.sleep, fetchFn: session.fetchFn });
  if (!code) return otpFailure(session, `OTP not received within ${Math.round(CONFIG.otpTotalWaitMs / 60000)} minutes`);
  try {
    await enterOtp(session.page(), code, true);
    await session.browser.waitForSettle(2000);
    return "OK: OTP received, entered and submitted.";
  } catch (error) {
    return otpFailure(session, `OTP received but entering it failed: ${error}`);
  }
}

/** Polls the page until success, an explicit failure, or the configured timeout. */
export async function waitForPaymentCompletion(session: PaymentSession): Promise<string> {
  const total = CONFIG.paymentWaitMs;
  const poll = CONFIG.paymentPollMs;
  console.log(`⏳ Waiting up to ${total / 1000}s for the user to complete the payment...`);
  for (let elapsed = 0; elapsed < total; elapsed += poll) {
    await session.sleep(Math.min(poll, total - elapsed));
    const url = await session.browser.getCurrentUrl();
    const text = await session.browser.getPageText().catch(() => "");
    console.log(`⏱️ Payment wait progress: ${Math.min(elapsed + poll, total) / 1000}s / ${total / 1000}s`);
    if (hasSuccessSignal(url, text) && (await confirmPaymentSuccess(session.browser, session.vision)).success) return markSuccess(session, text);
    const failure = findFailurePhrase(text);
    if (failure) {
      session.setSignal({ type: "fatal", code: "PAYMENT_FAILED", reason: `Payment failed: "${failure}" shown on page` });
      return `FATAL: payment failed ("${failure}")`;
    }
  }
  const final = await confirmPaymentSuccess(session.browser, session.vision);
  if (final.success) return markSuccess(session, final.text);
  session.setSignal({ type: "fatal", code: "PAYMENT_FAILED", reason: `Payment not completed: no confirmation after ${total / 1000}s` });
  return "FATAL: payment not completed within the wait window";
}

/** Records a success signal. */
function markSuccess(session: PaymentSession, text: string): string {
  session.setSignal({ type: "success", confirmation: text.substring(0, 500) });
  return "SUCCESS: payment confirmed on page.";
}

/** Creates payment tools bound to a session. */
export function createPaymentTools(session: PaymentSession) {
  const solveCaptcha = tool(
    async ({ elementId, fieldDescription }) => {
      try {
        const outcome = await solveAndFillCaptcha({ page: session.page(), fieldDescription: fieldDescription || "captcha", elementId }, session.vision, () => session.browser.captureScreenshot());
        return outcome.ok ? `OK: ${outcome.message}` : `ERROR: ${outcome.message}`;
      } catch (error) {
        return errorText("captcha failed", error);
      }
    },
    {
      name: "solve_captcha",
      description: "Read the CAPTCHA image with vision and type it into the CAPTCHA input.",
      schema: z.object({ elementId: z.string().optional().describe("CAPTCHA input element id"), fieldDescription: z.string().optional() }),
    }
  );

  const getOtp = tool(async () => runOtpFlow(session), {
    name: "get_otp",
    description: "When OTP inputs are visible: notify the user, wait up to 5 min for the code, type it and submit. Call ONCE.",
    schema: z.object({}),
  });

  const scanQr = tool(
    async () => {
      try {
        const qrUrl = await waitForQr(session);
        if (!qrUrl) return "ERROR: no UPI QR code found yet. Reveal it first (click Show QR / Click here to scan / Generate QR) and retry.";
        session.qrScanned = true;
        const notification = await sendQrNotification(session.paymentData, qrUrl, session.fetchFn);
        console.log(`📱 ${notification.message}`);
        return `OK: QR code extracted (${qrUrl.substring(0, 60)}...). ${notification.message}. Now call wait_for_payment.`;
      } catch (error) {
        return errorText("QR extraction failed", error);
      }
    },
    { name: "scan_upi_qr_code", description: "Extract the visible UPI QR code and push it to the user's phone.", schema: z.object({}) }
  );

  const waitForPayment = tool(
    async ({ after }) => {
      if (after === "qr_scan" && !session.qrScanned) return "ERROR: call scan_upi_qr_code successfully before wait_for_payment.";
      return waitForPaymentCompletion(session);
    },
    {
      name: "wait_for_payment",
      description: "After the QR was sent (or UPI collect request submitted): wait for the user to pay and detect success.",
      schema: z.object({ after: z.enum(["qr_scan", "upi_collect"]).default("qr_scan") }),
    }
  );

  const checkSuccess = tool(
    async () => {
      try {
        const result = await confirmPaymentSuccess(session.browser, session.vision);
        return result.success ? markSuccess(session, result.text) : `NOT_SUCCESS: page ${result.url} is not a payment success page.`;
      } catch (error) {
        return errorText("success check failed", error);
      }
    },
    { name: "check_payment_success", description: "Verify whether the current page is a payment success confirmation.", schema: z.object({}) }
  );

  const failPayment = tool(
    async ({ code, reason, missingData }) => {
      if (code === "NO_DUES" && session.paymentData.amount && !session.noDuesWarned) {
        session.noDuesWarned = true;
        return `REJECTED: the user supplied amount ${session.paymentData.amount}, so pay it as an advance payment: fill the amount field (dataKey "amount") and click the Pay button. Call fail_payment NO_DUES again only if the site really does not allow paying.`;
      }
      const full = missingData?.length ? `${reason} (missing: ${missingData.join(", ")})` : reason;
      session.setSignal({ type: "fatal", code: code as FailureCode, reason: full });
      return `FATAL: ${code}: ${full}`;
    },
    {
      name: "fail_payment",
      description: "Stop the run with a failure (missing user data, nothing to pay, data mismatch, blocked).",
      schema: z.object({
        code: z.enum(["MISSING_DATA", "NO_DUES", "DATA_MISMATCH", "BLOCKED", "OTHER"]),
        reason: z.string(),
        missingData: z.array(z.string()).optional(),
      }),
    }
  );

  return [solveCaptcha, getOtp, scanQr, waitForPayment, checkSuccess, failPayment];
}
