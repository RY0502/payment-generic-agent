/**
 * CAPTCHA handling: read the image with vision (cropped image first, full screenshot fallback)
 * and fill the CAPTCHA input. Field strategies: original order first, then new ones.
 */

import type { Locator, Page } from "playwright";
import { locateRef } from "../page-snapshot.js";
import type { VisionAnalyzer } from "../vision.js";
import { fillLocator, firstVisible, looseRegex, nonEmpty, runStrategies, type LocatorStrategy, type StrategyOutcome } from "./common.js";

export interface CaptchaContext {
  page: Page;
  fieldDescription: string;
  elementId?: string;
}

const CAPTCHA_IMAGE = 'img[src*="captcha" i]:visible, img[alt*="captcha" i]:visible, img[id*="captcha" i]:visible, img[class*="captcha" i]:visible, canvas[id*="captcha" i]:visible, canvas[class*="captcha" i]:visible';

export const CAPTCHA_FIELD_STRATEGIES: LocatorStrategy<CaptchaContext>[] = [
  { name: "captchaText-attr", find: async ({ page }) => nonEmpty(page.locator('input[name*="captchaText" i], input[id*="captchaText" i]').locator("visible=true")) },
  { name: "captcha-attr", find: async ({ page }) => nonEmpty(page.locator('input[name*="captcha" i], input[id*="captcha" i]').locator("visible=true")) },
  { name: "label", find: async ({ page, fieldDescription }) => firstVisible(page.getByLabel(looseRegex(fieldDescription))) },
  { name: "placeholder", find: async ({ page, fieldDescription }) => firstVisible(page.getByPlaceholder(looseRegex(fieldDescription))) },
  { name: "verification-code-attr", find: async ({ page }) => firstVisible(page.locator('input[name*="code" i], input[id*="code" i], input[name*="verify" i]')) },
  { name: "verification-label", find: async ({ page }) => firstVisible(page.getByLabel(/text.*verification|captcha|verify/i)) },
  { name: "near-captcha-image", find: async ({ page }) => nonEmpty(page.locator('img[alt*="captcha" i], img[class*="captcha" i], img[id*="captcha" i]').first().locator("..").locator('input[type="text"]')) },
  // ---- New strategies (generic agent) ----
  { name: "snapshot-ref", find: async ({ page, elementId }) => (elementId ? locateRef(page, elementId) : null) },
  { name: "captcha-placeholder", find: async ({ page }) => firstVisible(page.locator('input[placeholder*="captcha" i], input[placeholder*="security code" i], input[aria-label*="captcha" i]')) },
  { name: "input-proximity", find: async ({ page }) => firstVisible(page.locator(`input[type="text"]:near(${CAPTCHA_IMAGE.split(", ")[0]}, 250)`)) },
];

/** Screenshot of the CAPTCHA image only (better OCR), or null when no image is found. */
async function captchaImage(page: Page): Promise<string | null> {
  const img: Locator | null = await firstVisible(page.locator(CAPTCHA_IMAGE));
  if (!img) return null;
  const buffer = await img.screenshot({ type: "png", timeout: 3000 }).catch(() => null);
  return buffer ? buffer.toString("base64") : null;
}

/** Reads the CAPTCHA (cropped image first, then full screenshot). */
export async function readCaptcha(page: Page, vision: VisionAnalyzer, fullScreenshot: () => Promise<string>): Promise<string | null> {
  const cropped = await captchaImage(page);
  const fromCrop = cropped ? await vision.solveCaptcha(cropped) : null;
  return fromCrop || vision.solveCaptcha(await fullScreenshot());
}

/** Solves the CAPTCHA and fills it. */
export async function solveAndFillCaptcha(
  ctx: CaptchaContext,
  vision: VisionAnalyzer,
  fullScreenshot: () => Promise<string>
): Promise<StrategyOutcome & { text?: string }> {
  await ctx.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  const text = await readCaptcha(ctx.page, vision, fullScreenshot);
  if (!text) return { ok: false, message: "Could not read CAPTCHA text (too distorted). Refresh the captcha if a refresh icon exists, then retry." };
  const outcome = await runStrategies(CAPTCHA_FIELD_STRATEGIES, ctx, async (locator) => fillLocator(locator, text));
  return { ...outcome, text, message: outcome.ok ? `Solved CAPTCHA and filled "${text}"` : `Solved CAPTCHA (${text}) but could not find its input field` };
}
