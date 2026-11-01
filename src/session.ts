/**
 * PaymentSession: per-run state shared by all tools (browser, vision, payment data, flags, signals).
 */

import type { BrowserManager } from "./browser.js";
import { CONFIG } from "./config.js";
import { formatSnapshot, takeSnapshot } from "./page-snapshot.js";
import type { FetchFn } from "./notifications.js";
import type { PageSnapshot, PaymentData } from "./types.js";
import type { VisionAnalyzer } from "./vision.js";

export type FailureCode = "MISSING_DATA" | "NO_DUES" | "DATA_MISMATCH" | "OTP_FAILED" | "PAYMENT_FAILED" | "BLOCKED" | "OTHER";

export type SessionSignal = { type: "success"; confirmation: string } | { type: "fatal"; code: FailureCode; reason: string };

export interface SessionOptions {
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: FetchFn;
}

export class PaymentSession {
  qrScanned = false;
  otpRequests = 0;
  noDuesWarned = false;
  /** Latest snapshot rendered for the LLM (used by tools for payment-option guards). */
  lastSnapshot: PageSnapshot | null = null;
  private lastVisionUrl = "";
  private signal: SessionSignal | null = null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetchFn: FetchFn;

  constructor(
    readonly browser: BrowserManager,
    readonly vision: VisionAnalyzer,
    public paymentData: PaymentData,
    opts: SessionOptions = {}
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Active Playwright page (throws if browser not ready). */
  page() {
    return this.browser.requirePage();
  }

  /** Records a terminal signal (first one wins). */
  setSignal(signal: SessionSignal): void {
    this.signal ??= signal;
  }

  /** Returns and clears the pending signal. */
  takeSignal(): SessionSignal | null {
    const s = this.signal;
    this.signal = null;
    return s;
  }

  /** Snapshot with one retry (the DOM may be mid-navigation). */
  async snapshot(): Promise<PageSnapshot> {
    try {
      return await takeSnapshot(this.page());
    } catch {
      await this.sleep(2000);
      return takeSnapshot(this.page());
    }
  }

  /**
   * Text description of the current page for the LLM. Vision is used when forced, or automatically
   * the first time a URL is seen ("auto"), so each page costs at most one vision call.
   */
  async describePage(vision: "always" | "auto" | "never" = "auto"): Promise<string> {
    if (this.browser.hasDialog()) {
      return `NATIVE BROWSER DIALOG IS OPEN: "${this.browser.getDialogMessage()}". Use handle_dialog to accept or dismiss it before anything else.`;
    }
    const snap = await this.snapshot();
    this.lastSnapshot = snap;
    const lines = [formatSnapshot(snap, CONFIG.snapshotMaxElements, undefined, this.paymentData.paymentGateway)];
    const pageKey = snap.url.split("#")[0];
    if (vision === "always" || (vision === "auto" && pageKey !== this.lastVisionUrl)) {
      this.lastVisionUrl = pageKey;
      lines.unshift(await this.visionLine(snap));
    }
    return lines.join("\n");
  }

  /** One vision call summarising the screenshot; DOM is authoritative for CAPTCHA presence. */
  private async visionLine(snap: PageSnapshot): Promise<string> {
    try {
      const v = await this.vision.summarizePage(await this.browser.captureScreenshot(), "pay a bill using the user's payment data");
      const captchaNote = v.hasCaptcha && !snap.hasCaptcha ? " (vision suspects a captcha but none found in DOM - likely false positive)" : "";
      return `VISION: pageType=${v.pageType}; ${v.summary}${captchaNote}`;
    } catch {
      return "VISION: unavailable";
    }
  }
}
