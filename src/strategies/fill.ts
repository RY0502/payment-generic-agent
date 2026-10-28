/**
 * Strategies for locating a text input to fill.
 * Order: the original agent's strategies first (unchanged order), then new generic strategies.
 */

import type { Locator, Page } from "playwright";
import { locateRef } from "../page-snapshot.js";
import { firstVisible, fillLocator, looseRegex, nonEmpty, q, runStrategies, type LocatorStrategy, type StrategyOutcome } from "./common.js";

export interface FillContext {
  page: Page;
  description: string;
  value: string;
  elementId?: string;
}

const TEXT_INPUTS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([disabled]):not([readonly])';

/** Splits a description into usable attribute keywords. */
function keywords(description: string): string[] {
  return description.toLowerCase().split(/[\s_-]+/).filter((k) => k.length >= 2);
}

/** Tries each keyword against an attribute (name/id) and returns the first visible match. */
async function byAttributeKeyword(page: Page, attr: "name" | "id", description: string): Promise<Locator | null> {
  for (const k of keywords(description)) {
    const hit = await nonEmpty(page.locator(`input[${attr}*="${q(k)}" i]:visible, textarea[${attr}*="${q(k)}" i]:visible`));
    if (hit) return hit;
  }
  return null;
}

/** Original Strategy 8: scan visible text inputs comparing placeholder/aria/title/name/id. */
async function byDirectAttributeScan(page: Page, description: string): Promise<Locator | null> {
  const cleanDesc = description.toLowerCase().replace(/[-_]/g, " ");
  const inputs = await page.locator('input[type="text"]:visible, input:not([type]):visible, input[type="tel"]:visible, input[type="number"]:visible, textarea:visible').all();
  for (const input of inputs) {
    const attr = async (n: string) => ((await input.getAttribute(n)) || "").toLowerCase().replace(/[-_]/g, " ");
    const [placeholder, label, title, name, id] = await Promise.all(["placeholder", "aria-label", "title", "name", "id"].map(attr));
    const contains = [placeholder, label, title, name, id].some((v) => v.includes(cleanDesc));
    const reverse = (placeholder.length > 2 && cleanDesc.includes(placeholder)) || (title.length > 2 && cleanDesc.includes(title));
    if (contains || reverse) return input;
  }
  return null;
}

/** New strategy: same placeholder/label lookups inside child iframes. */
async function inFrames(page: Page, description: string): Promise<Locator | null> {
  const regex = looseRegex(description);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hit = (await firstVisible(frame.getByPlaceholder(regex))) || (await firstVisible(frame.getByLabel(regex)));
    if (hit) return hit;
  }
  return null;
}

/** New strategy: label-like text immediately preceding an input in DOM order (generic forms). */
async function byPrecedingText(page: Page, description: string): Promise<Locator | null> {
  const text = page.getByText(looseRegex(description)).filter({ hasNot: page.locator("input") });
  const anchor = await firstVisible(text);
  if (!anchor) return null;
  return firstVisible(anchor.locator(`xpath=following::input[not(@type="hidden") and not(@type="radio") and not(@type="checkbox")][1]`));
}

export const FILL_STRATEGIES: LocatorStrategy<FillContext>[] = [
  {
    name: "utility-account-number",
    find: async ({ page, description }) => {
      if (!/ca.*number|account.*number|^ca$|^account$/i.test(description.trim())) return null;
      const selectors = ['input[id*="accountNumber" i]:visible', 'input[placeholder*="CA Number" i]:visible', 'input[name*="accountNumber" i]:visible', 'input[title*="account-number" i]:visible'];
      return nonEmpty(page.locator(selectors.join(", ")));
    },
  },
  { name: "placeholder-exact", find: async ({ page, description }) => nonEmpty(page.getByPlaceholder(description, { exact: false }).locator("visible=true")) },
  { name: "placeholder-regex", find: async ({ page, description }) => nonEmpty(page.getByPlaceholder(looseRegex(description)).locator("visible=true")) },
  { name: "label-regex", find: async ({ page, description }) => nonEmpty(page.getByLabel(looseRegex(description)).locator("visible=true")) },
  { name: "role-textbox", find: async ({ page, description }) => nonEmpty(page.getByRole("textbox", { name: looseRegex(description) }).locator("visible=true")) },
  {
    name: "text-label-parent",
    find: async ({ page, description }) => {
      const label = await nonEmpty(page.locator(`text=${description}`).locator("visible=true"));
      return label ? nonEmpty(label.locator("..").locator("input:visible, textarea:visible")) : null;
    },
  },
  { name: "proximity", find: async ({ page, description }) => nonEmpty(page.locator(`input:visible:near(:text("${q(description)}"))`)) },
  { name: "name-attribute", find: async ({ page, description }) => byAttributeKeyword(page, "name", description) },
  { name: "id-attribute", find: async ({ page, description }) => byAttributeKeyword(page, "id", description) },
  { name: "direct-attribute-scan", find: async ({ page, description }) => byDirectAttributeScan(page, description) },
  // ---- New strategies (generic agent) ----
  { name: "snapshot-ref", find: async ({ page, elementId }) => (elementId ? locateRef(page, elementId) : null) },
  { name: "iframe-placeholder-label", find: async ({ page, description }) => inFrames(page, description) },
  { name: "preceding-text", find: async ({ page, description }) => byPrecedingText(page, description) },
  {
    name: "single-visible-input",
    find: async ({ page }) => {
      const inputs = page.locator(`${TEXT_INPUTS}:visible`);
      return (await inputs.count()) === 1 ? inputs.first() : null;
    },
  },
];

/** Locates the described field using all strategies and fills it with `value`. */
export async function fillField(ctx: FillContext): Promise<StrategyOutcome> {
  return runStrategies(FILL_STRATEGIES, ctx, async (locator) => fillLocator(locator, ctx.value));
}
