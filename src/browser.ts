/**
 * Playwright browser lifecycle + low-level page helpers.
 * Launch options, stealth scripts and CORS origin fix are carried over from the original agent.
 */

import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "./config.js";

export const SCREENSHOTS_DIR = process.env.VERCEL ? "/tmp/screenshots" : path.join(process.cwd(), "screenshots");

const STEALTH_ARGS = ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];

const VERCEL_ARGS = [
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-blink-features=AutomationControlled",
  "--font-render-hinting=none",
  "--enable-font-antialiasing",
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--use-gl=swiftshader",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const COOKIE_BUTTONS =
  '#bsesAcceptCookiesBtn:visible, button:has-text("Accept all cookies"):visible, button:has-text("Accept Cookies"):visible, button:has-text("Accept All"):visible, button:has-text("I Accept"):visible';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotCounter = 0;
  private lastDialog: Dialog | null = null;
  private dialogWaiters: ((message: string) => void)[] = [];
  private lastScreenshotPath = "";

  /** Launches Chromium (sparticuz build on Vercel) and prepares a stealth page. */
  async initialize(): Promise<void> {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    this.browser = await this.launch();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: USER_AGENT,
      deviceScaleFactor: 1,
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      colorScheme: "light",
      reducedMotion: "reduce",
      extraHTTPHeaders: { "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8", DNT: "1" },
    });
    this.page = await this.context.newPage();
    this.context.on("page", (popup) => this.adoptPopup(popup));
    await this.installOriginFix(this.context);
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      (window as any).chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-IN", "en-US", "en"] });
    });
    this.attachDialogListener(this.page);
  }

  /** Picks the right Chromium binary for the environment. */
  private async launch(): Promise<Browser> {
    if (CONFIG.isVercel) {
      const pkg: any = await import("@sparticuz/chromium");
      return chromium.launch({ headless: true, executablePath: await pkg.default.executablePath(), args: [...pkg.default.args, ...VERCEL_ARGS] });
    }
    return chromium.launch({ headless: CONFIG.headless, args: STEALTH_ARGS });
  }

  /** Sets the Origin header on cross-origin XHR/fetch (needed by gateways such as BillDesk). */
  private async installOriginFix(context: BrowserContext): Promise<void> {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const headers = { ...request.headers() };
      const pageUrl = this.page?.url();
      if ((request.resourceType() === "xhr" || request.resourceType() === "fetch") && pageUrl?.startsWith("http")) {
        const pageOrigin = new URL(pageUrl).origin;
        if (new URL(request.url()).origin !== pageOrigin) headers["origin"] = pageOrigin;
      }
      await route.continue({ headers }).catch(() => {});
    });
  }

  /** Stores native dialogs so the agent can decide how to handle them, and wakes anyone waiting for one. */
  attachDialogListener(page: Page): void {
    page.on("dialog", (dialog) => {
      console.log(`Dialog detected: ${dialog.type()} - "${dialog.message()}"`);
      this.lastDialog = dialog;
      const waiters = this.dialogWaiters.splice(0);
      waiters.forEach((resolve) => resolve(dialog.message()));
    });
  }

  /** Promise resolving with the message of the next native dialog, plus a cancel to drop the waiter. */
  nextDialog(): { promise: Promise<string>; cancel: () => void } {
    let waiter: (message: string) => void = () => {};
    const promise = new Promise<string>((resolve) => (waiter = resolve));
    this.dialogWaiters.push(waiter);
    return { promise, cancel: () => (this.dialogWaiters = this.dialogWaiters.filter((w) => w !== waiter)) };
  }

  /** Switches to a newly opened tab/popup (e.g. a payment gateway opened in a new window). */
  adoptPopup(popup: Page): void {
    console.log(`🪟 New tab opened: ${popup.url() || "(loading)"} - switching to it`);
    this.page = popup;
    this.attachDialogListener(popup);
    popup.on("close", () => {
      const remaining = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
      if (this.page === popup && remaining.length) this.page = remaining[remaining.length - 1];
    });
  }

  /** Uses an externally created page (used by tests). */
  usePage(page: Page): void {
    this.page = page;
    this.attachDialogListener(page);
  }

  /** Returns the active page or throws if the browser is not ready. */
  requirePage(): Page {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page;
  }

  getPage(): Page | null {
    return this.page;
  }

  /** Navigates to a URL, retrying with the "load" strategy, then dismisses cookie banners. */
  async navigate(url: string): Promise<void> {
    const page = this.requirePage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {
      await page.goto(url, { waitUntil: "load", timeout: 60000 });
    }
    await page.waitForTimeout(3000);
    await this.dismissCookieBanner();
  }

  /** Clicks a visible cookie-consent button if one is present. */
  async dismissCookieBanner(): Promise<boolean> {
    const page = this.requirePage();
    try {
      const button = page.locator(COOKIE_BUTTONS);
      if ((await button.count()) === 0) return false;
      await button.first().click({ timeout: 3000 });
      await page.waitForTimeout(800);
      return true;
    } catch {
      return false;
    }
  }

  /** Saves a viewport screenshot to disk and returns it as base64. */
  async captureScreenshot(): Promise<string> {
    const page = this.requirePage();
    const filepath = path.join(SCREENSHOTS_DIR, `ss_${this.screenshotCounter++}.png`);
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    const buffer = await page.screenshot({ type: "png", fullPage: false, path: filepath });
    this.lastScreenshotPath = filepath;
    return buffer.toString("base64");
  }

  getLastScreenshotPath(): string {
    return this.lastScreenshotPath;
  }

  async getCurrentUrl(): Promise<string> {
    return this.page ? this.page.url() : "";
  }

  /** Visible text of the page body. */
  async getPageText(): Promise<string> {
    const page = this.requirePage();
    return (await page.locator("body").innerText({ timeout: 5000 }).catch(() => page.textContent("body"))) || "";
  }

  /** Waits for navigation/network to settle after an action. */
  async waitForSettle(extraMs = 1500): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(extraMs);
  }

  hasDialog(): boolean {
    return this.lastDialog !== null;
  }

  getDialogMessage(): string | null {
    return this.lastDialog ? this.lastDialog.message() : null;
  }

  async acceptDialog(promptText?: string): Promise<void> {
    await this.lastDialog?.accept(promptText);
    this.lastDialog = null;
  }

  async dismissDialog(): Promise<void> {
    await this.lastDialog?.dismiss();
    this.lastDialog = null;
  }

  /** Deletes every screenshot in the screenshots directory. */
  async cleanupScreenshots(): Promise<void> {
    const files = await fs.readdir(SCREENSHOTS_DIR).catch(() => [] as string[]);
    await Promise.all(files.filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => {})));
  }

  /** Closes page, context and browser (idempotent). */
  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
