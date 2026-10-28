/**
 * Vision helpers. Each method is ONE vision-model call; the agent never needs per-field vision calls
 * because field discovery is done from the DOM snapshot.
 */

import { buildVisionLlm, parseJsonLoose, stripThinking, type LlmClient } from "./llm.js";
import type { VisionSummary } from "./types.js";

const SYSTEM = "You are a web automation expert analysing screenshots of Indian bill-payment websites.";

export class VisionAnalyzer {
  constructor(private readonly llm: LlmClient = buildVisionLlm()) {}

  /** One-shot page summary used to complement the DOM snapshot. */
  async summarizePage(screenshot: string, goal: string): Promise<VisionSummary> {
    const prompt = `Goal: ${goal}
Describe the screenshot for an automation agent. Respond ONLY with JSON:
{"pageType":"form|otp|captcha|bill_details|gateway_selection|payment_methods|qr_code|processing|success|failure|error|other",
 "summary":"<=60 words: what is visible, main form/dialog, primary call-to-action button text, any error/notice message",
 "hasCaptcha":true|false,"hasQrCode":true|false,"isPaymentSuccessPage":true|false}`;
    try {
      const parsed = parseJsonLoose<Partial<VisionSummary>>(await this.llm.invoke({ system: SYSTEM, prompt, imageBase64: screenshot }));
      return {
        pageType: parsed?.pageType || "unknown",
        summary: parsed?.summary || "",
        hasCaptcha: parsed?.hasCaptcha === true,
        hasQrCode: parsed?.hasQrCode === true,
        isPaymentSuccessPage: parsed?.isPaymentSuccessPage === true,
      };
    } catch (error) {
      console.error("Vision summary failed:", error);
      return { pageType: "unknown", summary: "", hasCaptcha: false, hasQrCode: false, isPaymentSuccessPage: false };
    }
  }

  /** Reads the CAPTCHA characters from the screenshot (spaces removed). Returns null if unreadable. */
  async solveCaptcha(screenshot: string): Promise<string | null> {
    const prompt = `There is a CAPTCHA image on this webpage. Read the characters shown in it.
Return ONLY the characters (preserve case, no spaces, no explanation). If unreadable return UNREADABLE.`;
    try {
      const text = stripThinking(await this.llm.invoke({ system: SYSTEM, prompt, imageBase64: screenshot }))
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/\s+/g, "");
      return !text || /UNREADABLE/i.test(text) ? null : text;
    } catch (error) {
      console.error("CAPTCHA solving error:", error);
      return null;
    }
  }

  /** Confirms whether the screenshot shows a successful payment (confidence > 0.7). */
  async detectPaymentSuccess(screenshot: string, pageText: string): Promise<boolean> {
    const prompt = `Does this webpage show a SUCCESSFUL, COMPLETED payment confirmation?
PAGE TEXT:
${pageText.substring(0, 1500)}
A bill summary, "pay now" page, pending/processing page or QR code page is NOT a success page.
Respond ONLY with JSON: {"isSuccess":true|false,"confidence":0.0-1.0,"reasoning":"short"}`;
    try {
      const result = parseJsonLoose<{ isSuccess?: boolean; confidence?: number }>(
        await this.llm.invoke({ system: SYSTEM, prompt, imageBase64: screenshot })
      );
      return result?.isSuccess === true && Number(result.confidence ?? 0) > 0.7;
    } catch (error) {
      console.error("Success detection error:", error);
      return false;
    }
  }

  /** Original findElementByIntent: asks the vision model for a CSS selector matching the intent. */
  async findSelector(screenshot: string, intent: string): Promise<string | null> {
    const prompt = `Given this webpage screenshot, return the CSS selector for: ${intent}
Return ONLY the CSS selector, nothing else. If not found, return null.`;
    try {
      const selector = stripThinking(await this.llm.invoke({ system: SYSTEM, prompt, imageBase64: screenshot })).replace(/^`+|`+$/g, "").trim();
      return !selector || selector === "null" ? null : selector;
    } catch {
      return null;
    }
  }

  /** Last-resort locator: asks for viewport pixel coordinates (1280x720) of an element. */
  async locateElement(screenshot: string, description: string): Promise<{ x: number; y: number } | null> {
    const prompt = `The screenshot is 1280x720 pixels. Find the clickable element: "${description}".
Respond ONLY with JSON {"found":true|false,"x":<center x>,"y":<center y>}`;
    try {
      const r = parseJsonLoose<{ found?: boolean; x?: number; y?: number }>(await this.llm.invoke({ system: SYSTEM, prompt, imageBase64: screenshot }));
      const valid = r?.found && Number.isFinite(r.x) && Number.isFinite(r.y) && r.x! >= 0 && r.x! <= 1280 && r.y! >= 0 && r.y! <= 720;
      return valid ? { x: Number(r!.x), y: Number(r!.y) } : null;
    } catch {
      return null;
    }
  }
}
