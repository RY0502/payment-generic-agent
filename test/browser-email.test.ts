import { promises as fs } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const created: any[] = [];
vi.mock("mailgun.js", () => ({
  default: class {
    client() {
      return {
        messages: {
          create: async (domain: string, params: any) => {
            if (params.to[0] === "fail@x.com") throw new Error("mailgun down");
            created.push({ domain, params });
            return { id: "1" };
          },
        },
      };
    }
  },
}));

const { BrowserManager, SCREENSHOTS_DIR } = await import("../src/browser.js");
const { EmailService } = await import("../src/email-service.js");
const { serve } = await import("./helpers.js");

let site: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  process.env.HEADLESS = "true";
  site = await serve({
    "/": `<div id="cookie"><button onclick="document.getElementById('cookie').remove()">Accept all cookies</button></div><a href="/popup" target="_blank" id="pop">open</a><button id="al" onclick="alert('hi')">alert</button><button id="pr" onclick="window.r=prompt('name')">prompt</button>`,
    "/popup": "<h1>Gateway</h1>",
  });
});
afterAll(async () => site.close());

describe("BrowserManager", () => {
  it("launches, navigates, dismisses cookies, screenshots, adopts popups and handles dialogs", async () => {
    const b = new BrowserManager();
    expect(() => b.requirePage()).toThrow("Browser not initialized");
    expect(await b.getCurrentUrl()).toBe("");
    await b.initialize();
    await b.navigate(`${site.url}/`);
    expect(await b.requirePage().locator("#cookie").count()).toBe(0);
    expect(await b.dismissCookieBanner()).toBe(false);
    expect(await b.getPageText()).toContain("open");
    expect((await b.captureScreenshot()).length).toBeGreaterThan(100);
    expect(b.getLastScreenshotPath()).toContain(SCREENSHOTS_DIR);
    await b.waitForSettle(10);

    await b.requirePage().evaluate(() => void setTimeout(() => alert("hi"), 10));
    await b.requirePage().waitForTimeout(200);
    expect(b.hasDialog()).toBe(true);
    expect(b.getDialogMessage()).toBe("hi");
    await b.dismissDialog();
    expect(b.hasDialog()).toBe(false);
    expect(b.getDialogMessage()).toBeNull();
    await b.requirePage().evaluate(() => void setTimeout(() => ((window as any).r = prompt("name")), 10));
    await b.requirePage().waitForTimeout(200);
    await b.acceptDialog("Ravi");
    expect(await b.requirePage().evaluate(() => (window as any).r)).toBe("Ravi");

    const main = b.requirePage();
    await main.click("#pop");
    await main.waitForTimeout(1000);
    expect(b.getPage()).not.toBe(main);
    await b.requirePage().close();
    await main.waitForTimeout(200);
    expect(b.getPage()).toBe(main);

    await b.cleanupScreenshots();
    expect((await fs.readdir(SCREENSHOTS_DIR)).filter((f) => f.endsWith(".png"))).toHaveLength(0);
    await b.close();
    await b.close();
    expect(b.getPage()).toBeNull();
  });

  it("falls back to load navigation when domcontentloaded fails", async () => {
    const b = new BrowserManager();
    await b.initialize();
    const page = b.requirePage();
    let calls = 0;
    const original = page.goto.bind(page);
    (page as any).goto = async (url: string, opts: any) => {
      if (calls++ === 0) throw new Error("first fails");
      return original(url, opts);
    };
    await b.navigate(`${site.url}/popup`);
    expect(calls).toBe(2);
    await b.close();
  });
});

describe("EmailService", () => {
  const shot = path.join(SCREENSHOTS_DIR, "email-test.png");
  beforeAll(async () => {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    await fs.writeFile(shot, "png");
  });
  afterAll(async () => fs.unlink(shot).catch(() => {}));

  it("skips when not configured or no recipient", async () => {
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
    delete process.env.MAILGUN_TO_EMAIL;
    expect((await new EmailService().sendPaymentSuccessEmail("site", shot, {})).success).toBe(false);
    process.env.MAILGUN_API_KEY = "k";
    process.env.MAILGUN_DOMAIN = "d";
    expect((await new EmailService().sendPaymentSuccessEmail("site", shot, {})).message).toContain("No recipient");
  });

  it("sends the success email with screenshot and reports failures", async () => {
    process.env.MAILGUN_API_KEY = "k";
    process.env.MAILGUN_DOMAIN = "d";
    const ok = await new EmailService().sendPaymentSuccessEmail("jio.com", shot, { amount: "10" }, "a@b.com");
    expect(ok.success).toBe(true);
    expect(created[0].params.subject).toContain("jio.com");
    expect(created[0].params.attachment.filename).toBe("email-test.png");
    const bad = await new EmailService().sendPaymentSuccessEmail("jio.com", shot, {}, "fail@x.com");
    expect(bad.success).toBe(false);
  });
});
