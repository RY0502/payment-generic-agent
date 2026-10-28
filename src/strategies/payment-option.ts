/**
 * Strategies for selecting a payment gateway / payment method / UPI app / tab
 * (radio buttons, image tiles, tabs, clickable divs).
 * Order: the original agent's strategies first (unchanged order), then new generic strategies.
 */

import type { Locator, Page } from "playwright";
import { locateRef } from "../page-snapshot.js";
import { clickLocator, escapeRegex, firstVisible, nonEmpty, q, runStrategies, type LocatorStrategy, type StrategyOutcome } from "./common.js";

export interface OptionContext {
  page: Page;
  optionName: string;
  elementId?: string;
}

/** Name variants used by image/src matching: "Bill Desk" -> billdesk / bill-desk / bill_desk. */
export function nameVariants(name: string): { spaced: string; compact: string; hyphen: string; underscore: string } {
  const lower = name.toLowerCase().trim();
  return { spaced: lower, compact: lower.replace(/\s+/g, ""), hyphen: lower.replace(/\s+/g, "-"), underscore: lower.replace(/\s+/g, "_") };
}

/** For a (possibly hidden) radio returns the element a user would actually click. */
export async function clickableForRadio(page: Page, radio: Locator): Promise<Locator> {
  if (await radio.isVisible().catch(() => false)) return radio;
  const parent = radio.locator("..");
  if ((await parent.evaluate((el) => el.tagName).catch(() => "")) === "LABEL") return parent;
  const id = await radio.getAttribute("id").catch(() => null);
  if (id) {
    const label = await nonEmpty(page.locator(`label[for="${q(id)}"]`));
    if (label) return label;
  }
  if ((await parent.getAttribute("role").catch(() => null)) === "radio") return parent;
  return radio;
}

/** Original Strategy 0A: BillDesk-style tabs, Jio-style divs/buttons, "Pay via X" elements. */
async function byTabOrLink(page: Page, name: string): Promise<Locator | null> {
  const k = q(nameVariants(name).compact);
  const n = q(name);
  const any = page.locator(
    `a[data-value*="${k}" i], a[href*="${k}" i], a:has(i[class*="${k}" i]), a:has(.bdi-${k}), li:has-text("${n}") > a, div:has-text("${n}"), button:has-text("${n}"), div:has-text("Pay via ${n}"), button:has-text("Pay via ${n}")`
  );
  if ((await any.count()) === 0) return null;
  const exactTab = page.locator("ul.tabs li a span").filter({ hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`, "i") });
  if ((await exactTab.count()) > 0) return exactTab.first().locator("..");
  return any.first();
}

/** Original Strategy 1: radio by data-title, then id/name keyword. */
async function byRadioAttributes(page: Page, name: string): Promise<Locator | null> {
  const k = q(nameVariants(name).compact);
  const radio =
    (await nonEmpty(page.locator(`input[type="radio"][data-title="${q(name)}" i]`))) ||
    (await nonEmpty(page.locator(`input[type="radio"][id*="${k}" i], input[type="radio"][name*="${k}" i]`)));
  return radio ? clickableForRadio(page, radio) : null;
}

/** Original Strategy 4: image alt/src/data-bank/class match, then nearby radio or the image itself. */
async function byImage(page: Page, name: string): Promise<Locator | null> {
  const v = nameVariants(name);
  const img = await nonEmpty(
    page.locator(`img[alt*="${q(name)}" i], img[src*="${q(v.compact)}" i], img[src*="${q(v.hyphen)}" i], img[src*="${q(v.underscore)}" i], img[data-bank*="${q(v.compact)}" i], img[class*="${q(v.compact)}" i]`)
  );
  if (!img) return null;
  const parent = img.locator("..");
  if ((await parent.evaluate((el) => el.tagName).catch(() => "")) === "LABEL") return parent;
  const radio = (await nonEmpty(parent.locator('input[type="radio"]'))) || (await nonEmpty(parent.locator("..").locator('input[type="radio"]')));
  if (radio) return clickableForRadio(page, radio);
  return (await img.isVisible().catch(() => false)) ? img : parent;
}

/** Original Strategy 8: iterate radios and match by parent text or parent image. */
async function byRadioIteration(page: Page, name: string): Promise<Locator | null> {
  const v = nameVariants(name);
  for (const radio of (await page.locator('input[type="radio"]').all()).slice(0, 60)) {
    const parent = radio.locator("..");
    const text = ((await parent.textContent().catch(() => "")) || "").toLowerCase();
    const img = parent.locator("img").first();
    const meta = (await img.count()) > 0 ? `${await img.getAttribute("alt").catch(() => "")} ${await img.getAttribute("src").catch(() => "")}`.toLowerCase() : "";
    if (text.includes(v.spaced) || [v.spaced, v.compact, v.hyphen, v.underscore].some((x) => meta.includes(x))) return clickableForRadio(page, radio);
  }
  return null;
}

/** New strategy: smallest visible element whose own text equals the option name. */
async function byExactText(page: Page, name: string): Promise<Locator | null> {
  return firstVisible(page.getByText(new RegExp(`^\\s*${escapeRegex(name)}\\s*$`, "i")));
}

/** New strategy: option inside child iframes. */
async function inFrames(page: Page, name: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hit = (await firstVisible(frame.getByRole("radio", { name: new RegExp(escapeRegex(name), "i") }))) || (await firstVisible(frame.getByText(name, { exact: false })));
    if (hit) return hit;
  }
  return null;
}

export const OPTION_STRATEGIES: LocatorStrategy<OptionContext>[] = [
  { name: "tab-or-link", find: async ({ page, optionName }) => byTabOrLink(page, optionName) },
  {
    name: "role-radio-wrapper",
    find: async ({ page, optionName }) => {
      const k = q(nameVariants(optionName).compact);
      return nonEmpty(page.locator(`[role="radio"][id*="${k}" i], [role="radio"][data-id*="${k}" i]`));
    },
  },
  { name: "radio-attributes", find: async ({ page, optionName }) => byRadioAttributes(page, optionName) },
  {
    name: "radio-aria",
    find: async ({ page, optionName }) => nonEmpty(page.locator(`input[type="radio"][aria-label*="${q(optionName)}" i], input[type="radio"][aria-describedby*="${q(optionName)}" i]`)),
  },
  { name: "label-text", find: async ({ page, optionName }) => nonEmpty(page.locator(`label:has-text("${q(optionName)}")`)) },
  { name: "image", find: async ({ page, optionName }) => byImage(page, optionName) },
  {
    name: "container-radio",
    find: async ({ page, optionName }) => {
      const container = await nonEmpty(page.locator(`div:has-text("${q(optionName)}"), span:has-text("${q(optionName)}")`));
      return container ? nonEmpty(container.locator('input[type="radio"]')) : null;
    },
  },
  {
    name: "container-with-image",
    find: async ({ page, optionName }) => {
      const v = nameVariants(optionName);
      return nonEmpty(page.locator(`div:has(img[alt*="${q(optionName)}" i]), div:has(img[src*="${q(v.compact)}" i]), div:has(img[src*="${q(v.hyphen)}" i]), div:has(img[src*="${q(v.underscore)}" i])`));
    },
  },
  { name: "role-radio", find: async ({ page, optionName }) => nonEmpty(page.getByRole("radio", { name: new RegExp(escapeRegex(optionName), "i") })) },
  { name: "radio-iteration", find: async ({ page, optionName }) => byRadioIteration(page, optionName) },
  // ---- New strategies (generic agent) ----
  { name: "snapshot-ref", find: async ({ page, elementId }) => (elementId ? locateRef(page, elementId) : null) },
  { name: "exact-text", find: async ({ page, optionName }) => byExactText(page, optionName) },
  { name: "iframe-option", find: async ({ page, optionName }) => inFrames(page, optionName) },
];

/** Selects the named payment option by trying every strategy in order. */
export async function selectPaymentOption(ctx: OptionContext): Promise<StrategyOutcome> {
  await ctx.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  return runStrategies(OPTION_STRATEGIES, ctx, async (locator) => {
    const visible = await locator.isVisible().catch(() => false);
    await clickLocator(locator, { force: !visible });
    await ctx.page.waitForTimeout(1000);
  });
}
