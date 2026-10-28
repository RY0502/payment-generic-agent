/**
 * Shared building blocks for element-locating strategies.
 *
 * A strategy is a named function that returns a Locator (or null). The runner tries strategies
 * in order and applies the action (fill / click) to the first locator that works.
 */

import type { Locator, Page } from "playwright";
import { DISPATCH_CLICK_SCRIPT, NATIVE_SET_VALUE_SCRIPT } from "../dom-scripts.js";

export interface LocatorStrategy<C> {
  name: string;
  find(ctx: C): Promise<Locator | null>;
}

export interface StrategyOutcome {
  ok: boolean;
  strategy?: string;
  message: string;
}

export const LOADER_SELECTOR = '.Loader_preloader__2jBNF, [class*="loader"]:visible, [class*="spinner"]:visible, [data-testid="central-loader"]';

/** Escapes a string for use inside a double-quoted CSS/Playwright selector. */
export function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escapes a string for literal use inside a RegExp. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a loose "word1.*word2" regex from a description. */
export function looseRegex(description: string): RegExp {
  const words = description.toLowerCase().split(/\s+/).filter(Boolean).map(escapeRegex);
  return new RegExp(words.join(".*"), "i");
}

/** Removes chevrons / arrows and collapses whitespace ("Next >" -> "Next"). */
export function cleanText(value: string): string {
  return value.replace(/[>→»›<←«‹\t\r\n*]/g, " ").replace(/\s+/g, " ").trim();
}

/** Returns the locator if it matches at least one element, else null. */
export async function nonEmpty(locator: Locator): Promise<Locator | null> {
  return (await locator.count().catch(() => 0)) > 0 ? locator.first() : null;
}

/** Returns the first VISIBLE element of a locator, else null. */
export async function firstVisible(locator: Locator, limit = 15): Promise<Locator | null> {
  const count = Math.min(await locator.count().catch(() => 0), limit);
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/** Tries each strategy in order; `apply` performs the action and throws on failure. */
export async function runStrategies<C>(
  strategies: LocatorStrategy<C>[],
  ctx: C,
  apply: (locator: Locator, strategy: string) => Promise<void>
): Promise<StrategyOutcome> {
  let lastError = "";
  for (const strategy of strategies) {
    let locator: Locator | null = null;
    try {
      locator = await strategy.find(ctx);
    } catch {
      locator = null;
    }
    if (!locator) continue;
    try {
      await apply(locator, strategy.name);
      console.log(`✅ Strategy "${strategy.name}" succeeded`);
      return { ok: true, strategy: strategy.name, message: `succeeded via ${strategy.name}` };
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error).split("\n")[0];
      console.log(`❌ Strategy "${strategy.name}" failed: ${lastError}`);
      if (lastError.startsWith("VALUE_TOO_LONG")) break;
    }
  }
  return { ok: false, message: lastError ? `element found but action failed: ${lastError}` : "no strategy could locate a usable element" };
}

/** Waits briefly for common loaders/spinners to disappear. */
export async function waitForLoaders(page: Page, timeout = 3000): Promise<void> {
  await page.locator(LOADER_SELECTOR).first().waitFor({ state: "hidden", timeout }).catch(() => {});
}

/** Reads the current value of an input-like element. */
async function currentValue(locator: Locator): Promise<string> {
  return locator.inputValue({ timeout: 1000 }).catch(() => "");
}

/** Normalises values for comparison (digits-only for numeric input, else trimmed lower). */
export function valuesMatch(actual: string, expected: string): boolean {
  const norm = (s: string) => s.replace(/[\s,₹]/g, "").toLowerCase();
  if (norm(actual) === norm(expected)) return true;
  const numeric = /^\d+(\.\d+)?$/;
  return numeric.test(norm(actual)) && numeric.test(norm(expected)) && parseFloat(norm(actual)) === parseFloat(norm(expected));
}

/**
 * Fills an input robustly: fill() -> verify; else type key-by-key -> verify; else native setter.
 * Throws when the value could not be set.
 */
export async function fillLocator(locator: Locator, value: string): Promise<void> {
  const maxLength = parseInt((await locator.getAttribute("maxlength", { timeout: 2000 }).catch(() => null)) || "0", 10);
  if (maxLength > 0 && value.length > maxLength) {
    throw new Error(`VALUE_TOO_LONG: field accepts at most ${maxLength} characters but the value has ${value.length} - the user's data does not fit this field`);
  }
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await locator.fill(value, { timeout: 3000 });
  if (valuesMatch(await currentValue(locator), value)) return;
  await locator.click({ timeout: 2000 }).catch(() => {});
  await locator.fill("", { timeout: 2000 }).catch(() => {});
  await locator.pressSequentially(value, { delay: 60, timeout: 10000 });
  if (valuesMatch(await currentValue(locator), value)) return;
  await locator.evaluate(`(el) => (${NATIVE_SET_VALUE_SCRIPT})(el, ${JSON.stringify(value)})`);
  if (!valuesMatch(await currentValue(locator), value)) throw new Error(`value did not stick (got "${await currentValue(locator)}")`);
}

/** Clicks with Playwright, falling back to a JS click and finally a dispatched mouse sequence. */
export async function clickLocator(locator: Locator, opts: { force?: boolean } = {}): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  try {
    await locator.click({ timeout: 3000, force: opts.force });
    return;
  } catch {
    // fall through to JS based clicks
  }
  try {
    await locator.evaluate((el) => (el as HTMLElement).click());
  } catch {
    await locator.evaluate(`(el) => (${DISPATCH_CLICK_SCRIPT})(el)`);
  }
}

/** Waits up to `ms` for a locator to become enabled. Returns final enabled state. */
export async function waitEnabled(page: Page, locator: Locator, ms = 2500): Promise<boolean> {
  for (let waited = 0; waited <= ms; waited += 500) {
    if (await locator.isEnabled().catch(() => true)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
