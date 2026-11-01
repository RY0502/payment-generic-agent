/**
 * Page-interaction tools: navigate, analyze, fill (batch), click, select option, dropdown, keys, wait, dialogs.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { analysePaymentOptions, isDisallowedMethod } from "../payment-options.js";
import { availableKeys, canonicalKey, isStandardKey, resolveValue } from "../payment-data.js";
import type { PaymentSession } from "../session.js";
import { clickElement } from "../strategies/click.js";
import { selectDropdown } from "../strategies/dropdown.js";
import { fillField } from "../strategies/fill.js";
import { enterOtp } from "../strategies/otp.js";
import { selectPaymentOption } from "../strategies/payment-option.js";

const elementId = z.string().optional().describe("Element id from the page snapshot, e.g. e12");

/** Returns a short error string for a tool failure. */
export function errorText(prefix: string, error: unknown): string {
  return `ERROR: ${prefix}: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`;
}

/** Rejects card / net banking / wallet / EMI choices and points to the preferred QR / UPI option. */
export function methodGuard(session: PaymentSession, text: string): string | null {
  if (!isDisallowedMethod(text)) return null;
  const view = session.lastSnapshot ? analysePaymentOptions(session.lastSnapshot, session.paymentData.paymentGateway) : null;
  return `REJECTED: "${text}" is not an allowed payment method - pay only by UPI QR (preferred) or UPI. ${view?.suggestion ?? "Choose the QR / UPI option; if none exists call fail_payment with code BLOCKED."}`;
}

export interface FieldRequest {
  elementId?: string;
  description: string;
  dataKey: string;
}

const AMOUNT_FIELD = /\bamount\b|payable|₹|\brs\.?\b|rupees|\bdemand\b/i;

/** Amount the site itself shows in an amount-like input of the latest snapshot (value > 0), if any. */
export function siteAmount(session: PaymentSession): string | null {
  const field = session.lastSnapshot?.elements.find(
    (e) => (e.kind === "input" || e.kind === "textarea") && AMOUNT_FIELD.test(`${e.label} ${e.name ?? ""} ${e.placeholder ?? ""}`) && parseFloat((e.value ?? "").replace(/[^\d.]/g, "")) > 0
  );
  return field ? `${field.label}: ${field.value}` : null;
}

/**
 * Amount rules: an amount field may only be filled from the user's "amount".
 * Without a user amount the site's pre-filled amount is used; if the site shows none either, the run fails (MISSING_DATA).
 */
function amountCheck(session: PaymentSession, field: FieldRequest): { line: string; missing?: string } | null {
  const isAmountField = AMOUNT_FIELD.test(field.description);
  const key = canonicalKey(session.paymentData, field.dataKey);
  if (isAmountField && key !== "amount") return { line: `✗ "${field.description}": an amount field can only be filled with dataKey "amount" (never ${field.dataKey}).` };
  if (key !== "amount" || resolveValue(session.paymentData, "amount")) return null;
  const shown = siteAmount(session);
  if (shown) return { line: `✗ "${field.description}": the user gave no amount - do NOT type one. The site already shows ${shown}; keep it and continue with that amount.` };
  return { line: `✗ "${field.description}": the user gave no amount and the site did not populate one`, missing: "amount" };
}

/** Fills one field from payment data; returns a result line. */
async function fillOne(session: PaymentSession, field: FieldRequest): Promise<{ line: string; missing?: string }> {
  const amountIssue = amountCheck(session, field);
  if (amountIssue) return amountIssue;
  const value = resolveValue(session.paymentData, field.dataKey);
  if (!value) {
    const standard = isStandardKey(session.paymentData, field.dataKey);
    const hint = standard ? "required user data is missing" : `unknown data key; available keys: ${availableKeys(session.paymentData).join(", ")}`;
    return { line: `✗ "${field.description}": ${hint}`, missing: standard ? canonicalKey(session.paymentData, field.dataKey) : undefined };
  }
  if (/\botp\b|one.time|verification code/i.test(field.description)) {
    await enterOtp(session.page(), value, false);
    return { line: `✓ "${field.description}" filled as OTP` };
  }
  const outcome = await fillField({ page: session.page(), description: field.description, value, elementId: field.elementId });
  return { line: outcome.ok ? `✓ "${field.description}" = ${field.dataKey} (${outcome.strategy})` : `✗ "${field.description}": ${outcome.message}` };
}

/** Batch-fills several fields in one step; a missing standard key is a fatal MISSING_DATA failure. */
export async function fillFields(session: PaymentSession, fields: FieldRequest[]): Promise<string> {
  await session.browser.dismissCookieBanner();
  const lines: string[] = [];
  const missing: string[] = [];
  for (const field of fields) {
    try {
      const result = await fillOne(session, field);
      lines.push(result.line);
      if (result.missing) missing.push(result.missing);
    } catch (error) {
      lines.push(`✗ "${field.description}": ${errorText("fill failed", error)}`);
    }
  }
  if (missing.length) {
    const keys = Array.from(new Set(missing));
    const needed = fields.filter((f) => keys.includes(canonicalKey(session.paymentData, f.dataKey))).map((f) => f.description).join(", ");
    const amountNote = keys.includes("amount") ? " - amount was not given in the request and the site did not populate it" : "";
    const reason = `Missing required data: ${keys.join(", ")}${amountNote} (needed by fields: ${needed})`;
    session.setSignal({ type: "fatal", code: "MISSING_DATA", reason });
    lines.push(`FATAL: ${reason}`);
  }
  return lines.join("\n");
}

/** Creates the page-interaction tools bound to a session. */
export function createBrowserTools(session: PaymentSession) {
  const navigate = tool(
    async ({ url }) => {
      try {
        await session.browser.navigate(url);
        return `OK: navigated to ${await session.browser.getCurrentUrl()}`;
      } catch (error) {
        return errorText("navigation failed", error);
      }
    },
    { name: "navigate", description: "Open a URL in the browser.", schema: z.object({ url: z.string() }) }
  );

  const analyzePage = tool(
    async () => {
      try {
        return await session.describePage("always");
      } catch (error) {
        return errorText("analyze failed", error);
      }
    },
    { name: "analyze_page", description: "Fresh DOM snapshot of ALL fields/buttons plus a vision summary of the screenshot.", schema: z.object({}) }
  );

  const fill = tool(async ({ fields }) => fillFields(session, fields), {
    name: "fill_fields",
    description: "Fill one or more input fields in ONE call. Values come from payment data keys, never free text.",
    schema: z.object({
      fields: z.array(z.object({ elementId, description: z.string().describe("Field label/placeholder as shown"), dataKey: z.string().describe("Payment data key, e.g. accountNumber, amount, mobileNumber, email") })).min(1),
    }),
  });

  const click = tool(
    async ({ elementId: id, description }) => {
      const rejected = methodGuard(session, description);
      if (rejected) return rejected;
      try {
        const before = await session.browser.getCurrentUrl();
        const outcome = await clickElement({ page: session.page(), description, elementId: id, vision: session.vision });
        if (!outcome.ok) return `ERROR: could not click "${description}": ${outcome.message}`;
        await session.page().waitForURL((u) => u.toString() !== before, { timeout: 2500 }).catch(() => {});
        await session.browser.waitForSettle(/\bqr\b|scan/i.test(description) ? 4000 : 1500);
        const after = await session.browser.getCurrentUrl();
        return `OK: clicked "${description}" (${outcome.strategy})${after !== before ? `; navigated to ${after}` : ""}`;
      } catch (error) {
        return errorText("click failed", error);
      }
    },
    { name: "click", description: "Click a button, link, tab or any clickable element.", schema: z.object({ elementId, description: z.string().describe("Visible text of the element") }) }
  );

  const selectOption = tool(
    async ({ elementId: id, optionName }) => {
      const rejected = methodGuard(session, optionName);
      if (rejected) return rejected;
      try {
        const outcome = await selectPaymentOption({ page: session.page(), optionName, elementId: id });
        if (!outcome.ok) return `ERROR: could not select "${optionName}": ${outcome.message}`;
        await session.browser.waitForSettle(1000);
        return `OK: selected "${optionName}" (${outcome.strategy})`;
      } catch (error) {
        return errorText("select failed", error);
      }
    },
    {
      name: "select_option",
      description: "Select a radio/tab/tile option such as a payment gateway (BillDesk), payment method (UPI, QR) or UPI app.",
      schema: z.object({ elementId, optionName: z.string().describe("Option text, e.g. BillDesk, UPI, QR") }),
    }
  );

  const dropdown = tool(
    async ({ elementId: id, dropdownDescription, optionText }) => {
      try {
        const outcome = await selectDropdown({ page: session.page(), dropdownDescription, optionText, elementId: id, vision: session.vision });
        return outcome.ok ? `OK: chose "${optionText}" in "${dropdownDescription}" (${outcome.strategy})` : `ERROR: ${outcome.message}`;
      } catch (error) {
        return errorText("dropdown failed", error);
      }
    },
    { name: "select_dropdown", description: "Choose an option in a dropdown / select box.", schema: z.object({ elementId, dropdownDescription: z.string(), optionText: z.string() }) }
  );

  const pressKey = tool(
    async ({ key }) => {
      try {
        await session.page().keyboard.press(key);
        await session.browser.waitForSettle(1000);
        return `OK: pressed ${key}`;
      } catch (error) {
        return errorText("key press failed", error);
      }
    },
    { name: "press_key", description: "Press a keyboard key (e.g. Enter, Tab, Escape).", schema: z.object({ key: z.string() }) }
  );

  const wait = tool(
    async ({ seconds }) => {
      const ms = Math.min(Math.max(seconds, 1), 60) * 1000;
      await session.sleep(ms);
      return `OK: waited ${ms / 1000}s`;
    },
    { name: "wait", description: "Wait for a slow page to load (1-60 seconds).", schema: z.object({ seconds: z.number() }) }
  );

  const handleDialog = tool(
    async ({ action, promptText }) => {
      if (!session.browser.hasDialog()) return "No native dialog is open (for HTML popups use click).";
      const message = session.browser.getDialogMessage();
      if (action === "accept") await session.browser.acceptDialog(promptText);
      else await session.browser.dismissDialog();
      return `OK: ${action}ed dialog "${message}"`;
    },
    {
      name: "handle_dialog",
      description: "Accept or dismiss a NATIVE browser alert/confirm/prompt dialog.",
      schema: z.object({ action: z.enum(["accept", "dismiss"]), promptText: z.string().optional() }),
    }
  );

  return [navigate, analyzePage, fill, click, selectOption, dropdown, pressKey, wait, handleDialog];
}
