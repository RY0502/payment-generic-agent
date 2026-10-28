/**
 * Strategies for locating a button / link / clickable element.
 * Order: the original agent's strategies first (unchanged order), then new generic strategies.
 */

import type { Locator, Page } from "playwright";
import { locateRef } from "../page-snapshot.js";
import type { VisionAnalyzer } from "../vision.js";
import { cleanText, clickLocator, escapeRegex, firstVisible, looseRegex, nonEmpty, q, runStrategies, waitEnabled, waitForLoaders, type LocatorStrategy, type StrategyOutcome } from "./common.js";

export interface ClickContext {
  page: Page;
  description: string;
  elementId?: string;
  vision?: VisionAnalyzer;
}

/** Original 0A/0B/0C: exact button, then partial button, then link selectors. */
function directSelectors(t: string): string[][] {
  const v = q(t);
  return [
    [`button:text-is("${v}"):visible`, `button[aria-label="${v}" i]:visible`, `[role="button"]:text-is("${v}"):visible`, `[role="button"][aria-label="${v}" i]:visible`, `input[type="submit"][value="${v}" i]:visible`, `input[type="button"][value="${v}" i]:visible`],
    [`button:has-text("${v}"):visible`, `button[id*="${v}" i]:visible`, `button[name*="${v}" i]:visible`, `input[type="submit"][value*="${v}" i]:visible`, `input[type="button"][value*="${v}" i]:visible`, `[role="button"]:has-text("${v}"):visible`],
    [`a:text-is("${v}"):visible`, `a[aria-label="${v}" i]:visible`, `a.btn:has-text("${v}"):visible`, `a[role="button"]:has-text("${v}"):visible`, `a:has-text("${v}"):visible`],
  ];
}

/** Original Strategy 2: accessibility-style scan of buttons by label/text. */
async function byAccessibilityScan(page: Page, description: string): Promise<Locator | null> {
  const target = description.toLowerCase();
  const buttons = await page.locator('button, [role="button"]').all();
  for (const button of buttons.slice(0, 200)) {
    const label = ((await button.getAttribute("aria-label").catch(() => "")) || "").toLowerCase();
    const text = ((await button.textContent().catch(() => "")) || "").trim().toLowerCase().substring(0, 50);
    if ((label && label.includes(target)) || (text && text.includes(target))) return button;
  }
  return null;
}

/** Original Strategy 4: class name / data attribute keyword match (icon-only elements). */
async function byClassOrData(page: Page, description: string): Promise<Locator | null> {
  const k = q(description.toLowerCase().replace(/\s+/g, ""));
  const kh = q(description.toLowerCase().replace(/\s+/g, "-"));
  const d = q(description);
  return (
    (await nonEmpty(page.locator(`button[class*="${k}" i], a[class*="${k}" i], button[class*="${kh}" i], a[class*="${kh}" i]`))) ||
    (await nonEmpty(page.locator(`button[data-value*="${d}" i], a[data-value*="${d}" i], button[data-name*="${d}" i], a[data-name*="${d}" i]`)))
  );
}

/** Original Strategy 6: text scan across all elements, returning the first rendered match. */
async function byTextScan(page: Page, description: string, clean: string): Promise<Locator | null> {
  const candidates = page.locator('button, a, [role="button"], input[type="submit"], input[type="button"], div, span').filter({ hasText: new RegExp(escapeRegex(clean), "i") });
  return (await firstVisible(candidates.last())) || (await firstVisible(page.locator(`[id*="${q(description.replace(/\s+/g, ""))}" i]`)));
}

/** New strategy: same selectors inside child iframes (payment gateways often embed iframes). */
async function inFrames(page: Page, t: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hit = (await firstVisible(frame.getByRole("button", { name: looseRegex(t) }))) || (await firstVisible(frame.getByText(t, { exact: false })));
    if (hit) return hit;
  }
  return null;
}

/** Builds the ordered click strategy list for a (cleaned) description. */
export const CLICK_STRATEGIES: LocatorStrategy<ClickContext>[] = [
  ...[0, 1, 2].map((tier) => ({
    name: ["direct-exact-button", "direct-partial-button", "direct-link"][tier],
    find: async ({ page, description }: ClickContext) => nonEmpty(page.locator(directSelectors(cleanText(description))[tier].join(", "))),
  })),
  { name: "role-button-regex", find: async ({ page, description }) => nonEmpty(page.getByRole("button", { name: looseRegex(cleanText(description)) })) },
  { name: "text-locator", find: async ({ page, description }) => nonEmpty(page.locator(`text=${cleanText(description)}`)) },
  { name: "text-regex-clickable", find: async ({ page, description }) => nonEmpty(page.locator(`text=/${escapeRegex(cleanText(description))}/i`)) },
  { name: "accessibility-scan", find: async ({ page, description }) => byAccessibilityScan(page, description) },
  { name: "role-link", find: async ({ page, description }) => nonEmpty(page.getByRole("link", { name: looseRegex(description) })) },
  { name: "class-or-data-attribute", find: async ({ page, description }) => byClassOrData(page, description) },
  {
    name: "title-or-aria-label",
    find: async ({ page, description }) => {
      const d = q(description);
      return nonEmpty(page.locator(`button[title*="${d}" i], a[title*="${d}" i], button[aria-label*="${d}" i], a[aria-label*="${d}" i]`));
    },
  },
  { name: "text-scan-dispatch", find: async ({ page, description }) => byTextScan(page, description, cleanText(description)) },
  // ---- New strategies (generic agent) ----
  { name: "snapshot-ref", find: async ({ page, elementId }) => (elementId ? locateRef(page, elementId) : null) },
  { name: "iframe-role-text", find: async ({ page, description }) => inFrames(page, cleanText(description)) },
  {
    name: "role-tab-or-menuitem",
    find: async ({ page, description }) => {
      const name = looseRegex(cleanText(description));
      return (await firstVisible(page.getByRole("tab", { name }))) || (await firstVisible(page.getByRole("menuitem", { name })));
    },
  },
];

/** Waits (up to 3s) for the described text to appear, for dynamically rendered buttons. */
async function waitForText(page: Page, terms: string[]): Promise<void> {
  await page
    .waitForFunction((t) => t.some((x) => document.body.innerText.toLowerCase().includes(x.toLowerCase())), terms, { timeout: 3000 })
    .catch(() => {});
}

/** Last resort (new): ask vision for coordinates and click there. */
async function clickByVision(ctx: ClickContext): Promise<boolean> {
  if (!ctx.vision) return false;
  const screenshot = (await ctx.page.screenshot({ type: "png" })).toString("base64");
  const point = await ctx.vision.locateElement(screenshot, ctx.description);
  if (!point) return false;
  await ctx.page.mouse.click(point.x, point.y);
  return true;
}

/**
 * Clicks the described element. Disabled targets are waited on (2.5s) and reported, not force-clicked.
 */
export async function clickElement(ctx: ClickContext): Promise<StrategyOutcome> {
  const { page } = ctx;
  await waitForText(page, Array.from(new Set([cleanText(ctx.description), ctx.description.trim()])).filter(Boolean));
  let disabled = false;
  const outcome = await runStrategies(CLICK_STRATEGIES, ctx, async (locator) => {
    await waitForLoaders(page);
    if (!(await waitEnabled(page, locator))) {
      disabled = true;
      throw new Error("element is disabled");
    }
    await clickLocator(locator);
  });
  if (outcome.ok) return outcome;
  if (disabled) return { ok: false, message: `"${ctx.description}" is DISABLED. Fill all required fields (amount, OTP, captcha, consent checkbox) first.` };
  if (await clickByVision(ctx).catch(() => false)) return { ok: true, strategy: "vision-coordinates", message: "succeeded via vision-coordinates" };
  return outcome;
}
