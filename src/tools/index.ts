/**
 * Tool registry + compact documentation rendered into the system prompt.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PaymentSession } from "../session.js";
import { createBrowserTools } from "./browser-tools.js";
import { createPaymentTools } from "./payment-tools.js";

/** Tools whose execution changes the page, so a fresh page snapshot is attached to their result. */
export const ACTION_TOOLS = new Set(["navigate", "fill_fields", "click", "select_option", "select_dropdown", "press_key", "wait", "handle_dialog", "solve_captcha", "get_otp"]);

export const TOOL_DOCS: Record<string, string> = {
  analyze_page: `analyze_page({}) - fresh snapshot of all fields/buttons + vision summary. Use when the page is unclear.`,
  fill_fields: `fill_fields({"fields":[{"elementId":"e3","description":"Mobile Number","dataKey":"mobileNumber"}, ...]}) - fill ALL needed fields of the page in ONE call. dataKey must be a PAYMENT DATA key.`,
  click: `click({"elementId":"e7","description":"Continue"}) - click a button/link/tab.`,
  select_option: `select_option({"elementId":"e9","optionName":"BillDesk"}) - pick a radio/tab/tile: payment gateway, payment method (UPI/QR), UPI app.`,
  select_dropdown: `select_dropdown({"elementId":"e4","dropdownDescription":"State","optionText":"Delhi"}) - choose a dropdown option.`,
  solve_captcha: `solve_captcha({"elementId":"e5"}) - read the CAPTCHA image and type it into the CAPTCHA input.`,
  get_otp: `get_otp({}) - ONLY when OTP inputs are visible: asks the user for the OTP (waits up to 5 min), types it and submits.`,
  scan_upi_qr_code: `scan_upi_qr_code({}) - extract the visible UPI QR code and send it to the user's phone.`,
  wait_for_payment: `wait_for_payment({"after":"qr_scan"}) - after scan_upi_qr_code succeeded: wait for the user to pay; detects success.`,
  check_payment_success: `check_payment_success({}) - verify whether the current page is a payment success page.`,
  handle_dialog: `handle_dialog({"action":"accept"}) - accept/dismiss a NATIVE browser alert/confirm.`,
  press_key: `press_key({"key":"Enter"}) - press a keyboard key.`,
  wait: `wait({"seconds":10}) - wait for a slow page (max 60s).`,
  navigate: `navigate({"url":"https://..."}) - open a URL (only to recover; the start page is already open).`,
  fail_payment: `fail_payment({"code":"MISSING_DATA|NO_DUES|DATA_MISMATCH|BLOCKED|OTHER","reason":"...","missingData":["amount"]}) - stop with a failure.`,
};

/** Creates every tool for the session. */
export function createAllTools(session: PaymentSession): StructuredToolInterface[] {
  return [...createBrowserTools(session), ...createPaymentTools(session)] as StructuredToolInterface[];
}

/** Renders tool docs for the given tools. */
export function formatToolDocs(tools: { name: string; description: string }[]): string {
  return tools.map((t) => `- ${TOOL_DOCS[t.name] ?? `${t.name} - ${t.description}`}`).join("\n");
}
