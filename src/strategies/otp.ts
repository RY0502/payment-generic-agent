/**
 * OTP entry: locate OTP inputs (single field or one box per digit), type the code and submit.
 * Logic carried over from the original agent's enterOtpOnPage, split into focused helpers.
 */

import type { Locator, Page } from "playwright";
import { clickLocator, firstVisible, nonEmpty, waitEnabled } from "./common.js";

const OTP_SELECTORS = [
  'input[data-testid*="otp" i]:visible',
  'input[aria-label*="otp" i]:visible',
  'input[aria-label*="code" i]:visible',
  'input[aria-label*="verification" i]:visible',
  'input[autocomplete="one-time-code"]:visible',
  'input[name*="otp" i]:visible',
  'input[id*="otp" i]:visible',
  'input[class*="otp" i]:visible',
  'input[placeholder*="otp" i]:visible',
].join(", ");

const EDITABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([disabled]):not([readonly])';

const SUBMIT_SELECTORS = [
  'button[data-testid*="login" i]:visible',
  'button[data-testid*="submit" i]:visible',
  "button.lego-lr-otp-submit:visible",
  'button:text-is("LOGIN"):visible',
  'button:has-text("LOGIN"):visible',
  'button:text-is("LOG IN"):visible',
  'button:has-text("LOG IN"):visible',
  'button:text-is("SIGN IN"):visible',
  'button:has-text("SIGN IN"):visible',
  'button:has-text("VERIFY"):visible',
  "button[type=submit]:visible",
  "input[type=submit]:visible",
  '[role="button"]:has-text("LOGIN"):visible',
  '[role="button"]:has-text("SUBMIT"):visible',
  '[role="button"]:has-text("VERIFY"):visible',
].join(", ");

/** Returns the active OTP container (visible modal) or the page itself. */
async function otpRoot(page: Page): Promise<Page | Locator> {
  const modal = page.locator('[role="dialog"]:visible, .modal:visible, div:has-text("Enter OTP"):visible').last();
  return (await modal.count()) > 0 ? modal : page;
}

/** Fallback heuristics: single-char boxes, exact-count inputs, or an input hinting otp/code. */
async function heuristicInputs(root: Page | Locator, codeLength: number): Promise<Locator[]> {
  const visible: Locator[] = [];
  for (const input of await root.locator(EDITABLE).all()) if (await input.isVisible().catch(() => false)) visible.push(input);
  const maxLen = async (l: Locator) => parseInt((await l.getAttribute("maxlength")) || "0", 10);
  const boxes: Locator[] = [];
  for (const input of visible) if ((await maxLen(input)) === 1) boxes.push(input);
  if (boxes.length >= codeLength) return boxes;
  if (boxes.length === 0 && visible.length === codeLength) return visible;
  for (const input of visible) {
    const hint = ["name", "id", "placeholder", "aria-label", "autocomplete"].map((a) => input.getAttribute(a));
    const text = (await Promise.all(hint)).join(" ").toLowerCase();
    if (text.includes("otp") || text.includes("code") || (await maxLen(input)) === codeLength) return [input];
  }
  return visible.length ? [visible[visible.length - 1]] : [];
}

/** Finds OTP inputs: dedicated selectors (container, page, iframes) then heuristics. */
export async function findOtpInputs(page: Page, codeLength: number): Promise<Locator[]> {
  const root = await otpRoot(page);
  for (const scope of [root, page]) {
    const found = await scope.locator(OTP_SELECTORS).all();
    if (found.length) return found;
  }
  for (const frame of page.frames()) {
    const found = await frame.locator(OTP_SELECTORS).all().catch(() => [] as Locator[]);
    if (found.length) return found;
  }
  return heuristicInputs(root, codeLength);
}

/** Types a value into an input and dispatches input/change events for reactive frameworks. */
async function typeInto(page: Page, input: Locator, value: string): Promise<void> {
  await input.click();
  await input.fill("");
  await input.pressSequentially(value, { delay: 50 });
  await input.evaluate((el, v) => {
    const node = el as HTMLInputElement;
    if (node.value !== v) node.value = v;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value).catch(() => {});
  await page.waitForTimeout(50);
}

/** Locates the OTP submit / login button (container, page, generic role, iframes). */
export async function findOtpSubmit(page: Page): Promise<Locator | null> {
  const root = await otpRoot(page);
  const generic = /^\s*(submit|verify|confirm|proceed|continue|validate|login|log in|sign in|next|done|ok)\b/i;
  const inFrames = async () => {
    for (const frame of page.frames()) {
      const hit = await nonEmpty(frame.locator(SUBMIT_SELECTORS));
      if (hit) return hit;
    }
    return null;
  };
  return (await nonEmpty(root.locator(SUBMIT_SELECTORS))) || (await nonEmpty(page.locator(SUBMIT_SELECTORS))) || (await firstVisible(page.getByRole("button", { name: generic }))) || inFrames();
}

/** Enters the OTP code and optionally clicks the submit button. Throws when inputs/submit are missing. */
export async function enterOtp(page: Page, code: string, autoSubmit = true): Promise<void> {
  const inputs = await findOtpInputs(page, code.length);
  if (inputs.length === 0) throw new Error("No visible OTP input found on page");
  console.log(`🎯 Found ${inputs.length} OTP input(s) for a ${code.length}-digit code`);
  if (inputs.length >= code.length) {
    for (let i = 0; i < code.length; i++) await typeInto(page, inputs[i], code[i]);
  } else {
    await typeInto(page, inputs[0], code);
  }
  if (!autoSubmit) return;
  await page.waitForTimeout(600);
  const submit = await findOtpSubmit(page);
  if (!submit) throw new Error("Submit/Login button not found after entering OTP");
  await waitEnabled(page, submit, 3000);
  await clickLocator(submit);
}
