/**
 * Strategies for choosing an option from a dropdown (native <select> or custom combobox).
 * Order: original vision-selector strategy first, then new DOM strategies.
 */

import type { Locator, Page } from "playwright";
import { locateRef } from "../page-snapshot.js";
import type { VisionAnalyzer } from "../vision.js";
import { clickLocator, escapeRegex, firstVisible, looseRegex, nonEmpty, runStrategies, type LocatorStrategy, type StrategyOutcome } from "./common.js";

export interface DropdownContext {
  page: Page;
  dropdownDescription: string;
  optionText: string;
  elementId?: string;
  vision?: VisionAnalyzer;
}

/** Original strategy: vision model returns a CSS selector for the dropdown. */
async function byVisionSelector(ctx: DropdownContext): Promise<Locator | null> {
  if (!ctx.vision) return null;
  const screenshot = (await ctx.page.screenshot({ type: "png" })).toString("base64");
  const selector = await ctx.vision.findSelector(screenshot, `dropdown: ${ctx.dropdownDescription}`);
  return selector ? nonEmpty(ctx.page.locator(selector)) : null;
}

export const DROPDOWN_STRATEGIES: LocatorStrategy<DropdownContext>[] = [
  { name: "vision-selector", find: byVisionSelector },
  // ---- New strategies (generic agent) ----
  { name: "snapshot-ref", find: async ({ page, elementId }) => (elementId ? locateRef(page, elementId) : null) },
  { name: "select-by-label", find: async ({ page, dropdownDescription }) => firstVisible(page.getByLabel(looseRegex(dropdownDescription)).and(page.locator("select"))) },
  { name: "combobox-role", find: async ({ page, dropdownDescription }) => firstVisible(page.getByRole("combobox", { name: looseRegex(dropdownDescription) })) },
  {
    name: "select-containing-option",
    find: async ({ page, optionText }) => firstVisible(page.locator("select").filter({ has: page.locator("option", { hasText: new RegExp(escapeRegex(optionText), "i") }) })),
  },
];

/** Picks the option on a native select (by label, then value) or opens a custom dropdown and clicks it. */
async function chooseOption(page: Page, dropdown: Locator, optionText: string): Promise<void> {
  const tag = await dropdown.evaluate((el) => el.tagName).catch(() => "");
  if (tag === "SELECT") {
    const labels = await dropdown.locator("option").allInnerTexts();
    const match = labels.find((l) => l.trim().toLowerCase() === optionText.toLowerCase()) || labels.find((l) => l.toLowerCase().includes(optionText.toLowerCase()));
    await dropdown.selectOption(match ? { label: match } : optionText, { timeout: 5000 });
    return;
  }
  await clickLocator(dropdown);
  await page.waitForTimeout(500);
  const option =
    (await firstVisible(page.getByRole("option", { name: new RegExp(escapeRegex(optionText), "i") }))) ||
    (await firstVisible(page.getByText(new RegExp(`^\\s*${escapeRegex(optionText)}\\s*$`, "i"))));
  if (!option) throw new Error(`option "${optionText}" not visible after opening dropdown`);
  await clickLocator(option);
}

/** Selects `optionText` in the described dropdown. */
export async function selectDropdown(ctx: DropdownContext): Promise<StrategyOutcome> {
  return runStrategies(DROPDOWN_STRATEGIES, ctx, async (locator) => chooseOption(ctx.page, locator, ctx.optionText));
}
