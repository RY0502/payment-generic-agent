import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PAGE_MARKER } from "../src/history.js";
import { createAllTools, formatToolDocs } from "../src/tools/index.js";
import { errorText, fillFields, methodGuard, siteAmount } from "../src/tools/browser-tools.js";
import { extractQr, runOtpFlow, waitForPaymentCompletion } from "../src/tools/payment-tools.js";
import { closeBrowser, fakeFetch, pageWith, serve, sessionFor } from "./helpers.js";

afterAll(closeBrowser);
afterEach(() => ["OTP_NOTIFICATION_URL", "OTP_LOOKUP_URL", "SUPABASE_ANON_KEY", "PAYMENT_NOTIFICATION_URL", "PAYMENT_WAIT_MS", "PAYMENT_POLL_MS"].forEach((k) => delete process.env[k]));

const QR_SVG = `<div class="qr"><p>Scan QR to pay</p><svg width="200" height="200">${Array.from({ length: 12 }, (_, i) => `<path d="M${i} 0h1v1h-1z"/>`).join("")}</svg></div>`;

/** Returns a tool by name for a session. */
const toolOf = (session: any, name: string) => createAllTools(session).find((t) => t.name === name)!;

describe("session", () => {
  it("describes the page with one vision call per URL and handles native dialogs", async () => {
    const page = await pageWith('<input placeholder="CA Number"><button onclick="alert(\'Invalid CA\')">Go</button>');
    const { session, visionLlm } = sessionFor(page, {}, () => '{"pageType":"form","summary":"a form","hasCaptcha":true}');
    const first = await session.describePage("auto");
    expect(first).toContain("VISION: pageType=form; a form (vision suspects a captcha");
    expect(await session.describePage("auto")).not.toContain("VISION");
    expect(await session.describePage("never")).not.toContain("VISION");
    expect(visionLlm.calls).toHaveLength(1);
    await page.evaluate(() => void setTimeout(() => alert("Invalid CA"), 10));
    await page.waitForTimeout(200);
    expect(await session.describePage()).toContain('NATIVE BROWSER DIALOG IS OPEN: "Invalid CA"');
    expect(await toolOf(session, "handle_dialog").invoke({ action: "accept" })).toContain("accepted");
    expect(await toolOf(session, "handle_dialog").invoke({ action: "dismiss" })).toContain("No native dialog");
    await page.close();
  });

  it("reports vision unavailable and keeps the first signal", async () => {
    const page = await pageWith("<p>x</p>");
    const { session } = sessionFor(page, {}, ["THROW:down"]);
    session.browser.captureScreenshot = async () => {
      throw new Error("no shot");
    };
    expect(await session.describePage("always")).toContain("VISION: unavailable");
    session.setSignal({ type: "fatal", code: "OTHER", reason: "a" });
    session.setSignal({ type: "success", confirmation: "b" });
    expect(session.takeSignal()).toMatchObject({ reason: "a" });
    expect(session.takeSignal()).toBeNull();
    await page.close();
  });
});

describe("browser tools", () => {
  it("batch-fills fields from payment data and flags missing standard data as fatal", async () => {
    const page = await pageWith('<input placeholder="Mobile Number"><input placeholder="Amount"><input placeholder="Circle">');
    const { session } = sessionFor(page, { mobileNumber: "9899892558", amount: "10" });
    const out = await fillFields(session, [
      { description: "Mobile Number", dataKey: "mobileNumber" },
      { description: "Amount", dataKey: "amount" },
    ]);
    expect(out).toContain('✓ "Mobile Number"');
    expect(await page.inputValue('[placeholder="Amount"]')).toBe("10");
    expect(await fillFields(session, [{ description: "Circle", dataKey: "circle" }])).toContain("unknown data key; available keys: mobileNumber, amount");
    expect(session.takeSignal()).toBeNull();
    const missing = await fillFields(session, [{ description: "Email", dataKey: "email" }]);
    expect(missing).toContain("FATAL: Missing required data: email");
    expect(session.takeSignal()).toMatchObject({ type: "fatal", code: "MISSING_DATA" });
    expect(await fillFields(session, [{ description: "Nope", dataKey: "amount" }])).toContain("✗");
    await page.close();
  });

  it("enforces amount rules: only dataKey amount, never typed when absent, site amount kept, else MISSING_DATA", async () => {
    const page = await pageWith('<input placeholder="Total Demand" value="1,250.00" readonly><input placeholder="Advance Payment"><input placeholder="Enter Amount">');
    const withAmount = sessionFor(page, { accountNumber: "154431846", amount: "10" }).session;
    expect(await fillFields(withAmount, [{ description: "Enter Amount", dataKey: "accountNumber" }])).toContain('can only be filled with dataKey "amount"');
    expect(await fillFields(withAmount, [{ description: "Enter Amount", dataKey: "amount" }])).toContain('✓ "Enter Amount"');

    const noAmount = sessionFor(page, { accountNumber: "154431846" }).session;
    await noAmount.describePage("never");
    expect(siteAmount(noAmount)).toBe("Total Demand: 1,250.00");
    const kept = await fillFields(noAmount, [{ description: "Advance Payment", dataKey: "amount" }]);
    expect(kept).toContain("the user gave no amount - do NOT type one. The site already shows Total Demand: 1,250.00");
    expect(noAmount.takeSignal()).toBeNull();
    expect(await page.inputValue('[placeholder="Advance Payment"]')).toBe("");

    await page.setContent('<input placeholder="Enter Amount">');
    await noAmount.describePage("never");
    const failed = await fillFields(noAmount, [{ description: "Enter Amount", dataKey: "amount" }]);
    expect(failed).toContain("FATAL: Missing required data: amount - amount was not given in the request and the site did not populate it");
    expect(noAmount.takeSignal()).toMatchObject({ type: "fatal", code: "MISSING_DATA" });
    await page.close();
  });

  it("routes OTP-like fields to OTP entry and reports VALUE_TOO_LONG", async () => {
    const page = await pageWith('<input name="otp"><input placeholder="BP Number" maxlength="10">');
    const { session } = sessionFor(page, { otp: "4321", accountNumber: "100000127536" });
    expect(await fillFields(session, [{ description: "OTP", dataKey: "otp" }])).toContain("filled as OTP");
    expect(await page.inputValue('[name="otp"]')).toBe("4321");
    expect(await fillFields(session, [{ description: "BP Number", dataKey: "accountNumber" }])).toContain("VALUE_TOO_LONG");
    const broken = sessionFor(page, { otp: "1" }).session;
    broken.page = () => {
      throw new Error("gone");
    };
    expect(await fillFields(broken, [{ description: "otp", dataKey: "otp" }])).toContain("fill failed");
    await page.close();
  });

  it("navigates, analyzes, clicks, selects, presses keys and waits", async () => {
    const site = await serve({
      "/": '<button onclick="location.href=\'/next\'">Continue</button><label><input type="radio" name="g"> BillDesk</label><select aria-label="State"><option>Delhi</option><option>Goa</option></select><input id="k" onkeydown="window.k=event.key"><button disabled>Pay</button>',
      "/next": "<h1>Next page</h1>",
    });
    const page = await pageWith("<p>start</p>");
    const { session } = sessionFor(page, {}, () => '{"pageType":"form","summary":"s"}');
    expect(await toolOf(session, "navigate").invoke({ url: site.url })).toContain("OK: navigated");
    expect(await toolOf(session, "analyze_page").invoke({})).toContain("VISION: pageType=form");
    expect(await toolOf(session, "select_option").invoke({ optionName: "BillDesk" })).toContain("OK: selected");
    expect(await toolOf(session, "select_option").invoke({ optionName: "Nothing" })).toContain("ERROR");
    expect(await toolOf(session, "select_dropdown").invoke({ dropdownDescription: "State", optionText: "Goa" })).toContain("OK: chose");
    expect(await toolOf(session, "select_dropdown").invoke({ dropdownDescription: "x", optionText: "zz" })).toContain("ERROR");
    await page.focus("#k");
    expect(await toolOf(session, "press_key").invoke({ key: "Enter" })).toContain("OK: pressed");
    expect(await page.evaluate(() => (window as any).k)).toBe("Enter");
    expect(await toolOf(session, "wait").invoke({ seconds: 500 })).toBe("OK: waited 60s");
    expect(await toolOf(session, "click").invoke({ description: "Pay" })).toContain("DISABLED");
    expect(await toolOf(session, "click").invoke({ description: "Continue" })).toContain("navigated to");
    expect(await toolOf(session, "navigate").invoke({ url: "http://127.0.0.1:1/" })).toContain("ERROR: navigation failed");
    await page.close();
    await site.close();
  });

  it("rejects card / net banking / wallet choices and points to the QR option", async () => {
    const page = await pageWith(`<div role="tablist"><div role="tab">Net Banking</div><div role="tab">Debit Card</div><div role="tab" onclick="window.qr=1">QR Code</div></div>`);
    const { session } = sessionFor(page);
    expect(methodGuard(session, "Net Banking")).toContain("Choose the QR / UPI option");
    await session.describePage("never");
    const rejected = await toolOf(session, "click").invoke({ description: "Net Banking" });
    expect(rejected).toMatch(/^REJECTED: "Net Banking" is not an allowed payment method.*click\(\{"elementId":"e\d+","description":"QR Code"\}\)/);
    expect(await toolOf(session, "select_option").invoke({ optionName: "Debit Card" })).toContain("REJECTED");
    expect(methodGuard(session, "UPI")).toBeNull();
    expect(await toolOf(session, "click").invoke({ description: "QR Code" })).toContain("OK: clicked");
    expect(await page.evaluate(() => (window as any).qr)).toBe(1);
    await page.close();
  });

  it("converts thrown errors to text", async () => {
    expect(errorText("p", new Error("a\nb"))).toBe("ERROR: p: a");
    const page = await pageWith("<p></p>");
    const { session } = sessionFor(page);
    session.page = () => {
      throw new Error("closed");
    };
    session.browser.navigate = async () => {
      throw new Error("closed");
    };
    for (const [name, args] of [["click", { description: "x" }], ["select_option", { optionName: "x" }], ["select_dropdown", { dropdownDescription: "a", optionText: "b" }], ["press_key", { key: "a" }], ["solve_captcha", {}], ["scan_upi_qr_code", {}]] as const) {
      expect(await toolOf(session, name).invoke(args as any)).toContain("ERROR");
    }
    session.describePage = async () => {
      throw new Error("x");
    };
    expect(await toolOf(session, "analyze_page").invoke({})).toContain("ERROR: analyze failed");
    session.browser.captureScreenshot = async () => {
      throw new Error("x");
    };
    expect(await toolOf(session, "check_payment_success").invoke({})).toContain("ERROR");
    await page.close();
  });

  it("documents every tool", () => {
    const docs = formatToolDocs(createAllTools(sessionFor({ on: () => {} } as any).session));
    for (const name of ["fill_fields", "get_otp", "scan_upi_qr_code", "fail_payment"]) expect(docs).toContain(name);
  });
});

describe("payment tools", () => {
  it("solves captcha via tool", async () => {
    const page = await pageWith('<input name="captcha">');
    const { session } = sessionFor(page, {}, ["AB12"]);
    session.browser.captureScreenshot = async () => "full";
    expect(await toolOf(session, "solve_captcha").invoke({})).toContain('filled "AB12"');
    const { session: s2 } = sessionFor(page, {}, ["UNREADABLE"]);
    s2.browser.captureScreenshot = async () => "full";
    expect(await toolOf(s2, "solve_captcha").invoke({})).toContain("ERROR");
    await page.close();
  });

  it("extracts QR codes, notifies and enforces scan-before-wait", async () => {
    const page = await pageWith("<p>no qr</p>");
    const { session } = sessionFor(page);
    expect(await toolOf(session, "wait_for_payment").invoke({ after: "qr_scan" })).toContain("call scan_upi_qr_code");
    expect(await toolOf(session, "scan_upi_qr_code").invoke({})).toContain("no UPI QR code found");
    await page.setContent(QR_SVG);
    expect(await extractQr(session)).toMatch(/^data:image\/svg\+xml;base64,/);
    process.env.PAYMENT_NOTIFICATION_URL = "https://n";
    process.env.SUPABASE_ANON_KEY = "k";
    const fetch = fakeFetch([{ body: "ok" }]);
    const { session: s2 } = sessionFor(page, { amount: "10" }, undefined, fetch.fn);
    expect(await toolOf(s2, "scan_upi_qr_code").invoke({})).toContain("QR notification sent");
    expect(fetch.calls[0].body.paymentData).toEqual({ amount: "10" });
    expect(s2.qrScanned).toBe(true);
    for (const html of ['<div class="qr"><img src="data:image/png;base64,iVBORw0KGgo=" width="150" height="150" alt="QR code"></div>', '<canvas width="150" height="150"></canvas>']) {
      await page.setContent(html);
      expect(await extractQr(s2)).toMatch(/^data:image/);
    }
    await page.close();
  });

  it("waits for payment: success, failure phrase and timeout", async () => {
    process.env.PAYMENT_WAIT_MS = "3";
    process.env.PAYMENT_POLL_MS = "1";
    const page = await pageWith("<h1>Payment Successful</h1><p>Transaction reference number 123</p>");
    const ok = sessionFor(page, {}, () => '{"isSuccess":true,"confidence":0.95}').session;
    ok.qrScanned = true;
    expect(await toolOf(ok, "wait_for_payment").invoke({ after: "qr_scan" })).toContain("SUCCESS");
    expect(ok.takeSignal()).toMatchObject({ type: "success" });
    await page.setContent("<h1>Transaction Failed</h1>");
    const failed = sessionFor(page).session;
    expect(await waitForPaymentCompletion(failed)).toContain("FATAL: payment failed");
    await page.setContent("<p>Waiting for payment</p>");
    const timeout = sessionFor(page, {}, () => '{"isSuccess":false}').session;
    expect(await waitForPaymentCompletion(timeout)).toContain("not completed");
    expect(timeout.takeSignal()).toMatchObject({ code: "PAYMENT_FAILED" });
    const late = sessionFor(page, {}, () => '{"isSuccess":true,"confidence":0.9}').session;
    expect(await waitForPaymentCompletion(late)).toContain("SUCCESS");
    await page.close();
  });

  it("checks success and fails payments explicitly", async () => {
    const page = await pageWith("<h1>Bill</h1>");
    const { session } = sessionFor(page, {}, ['{"isSuccess":false}', '{"isSuccess":true,"confidence":0.8}']);
    expect(await toolOf(session, "check_payment_success").invoke({})).toContain("NOT_SUCCESS");
    expect(await toolOf(session, "check_payment_success").invoke({})).toContain("SUCCESS");
    session.takeSignal();
    expect(await toolOf(session, "fail_payment").invoke({ code: "MISSING_DATA", reason: "amount needed", missingData: ["amount"] })).toBe("FATAL: MISSING_DATA: amount needed (missing: amount)");
    expect(session.takeSignal()).toMatchObject({ code: "MISSING_DATA" });
    expect(await toolOf(session, "fail_payment").invoke({ code: "NO_DUES", reason: "0 due" })).toBe("FATAL: NO_DUES: 0 due");
    session.paymentData = { amount: "10" };
    expect(await toolOf(session, "fail_payment").invoke({ code: "NO_DUES", reason: "0 due" })).toContain("REJECTED: the user supplied amount 10");
    expect(await toolOf(session, "fail_payment").invoke({ code: "NO_DUES", reason: "site blocks" })).toBe("FATAL: NO_DUES: site blocks");
    await page.close();
  });

  it("runs the OTP flow end to end and fails fatally on problems", async () => {
    const page = await pageWith('<div role="dialog"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><button>LOGIN</button></div>');
    const s0 = sessionFor(page).session;
    expect(await runOtpFlow(s0)).toContain("not configured");
    process.env.OTP_NOTIFICATION_URL = "https://n/otp";
    process.env.OTP_LOOKUP_URL = "https://n/lookup";
    process.env.SUPABASE_ANON_KEY = "k";
    process.env.OTP_POLL_MS = "1";
    const ok = fakeFetch([{ body: {} }, { body: { code: "1234" } }]);
    const s1 = sessionFor(page, {}, undefined, ok.fn).session;
    expect(await toolOf(s1, "get_otp").invoke({})).toContain("OK: OTP received");
    expect(await page.inputValue("input >> nth=3")).toBe("4");
    expect(await runOtpFlow(sessionFor(page, {}, undefined, fakeFetch([{ status: 500, body: "x" }]).fn).session)).toContain("FATAL: OTP push notification failed");
    process.env.OTP_TOTAL_WAIT_MS = "5";
    const never = sessionFor(page, {}, undefined, fakeFetch([{ body: {} }]).fn).session;
    (never as any).sleep = () => new Promise((r) => setTimeout(r, 3));
    expect(await runOtpFlow(never)).toContain("OTP not received");
    delete process.env.OTP_TOTAL_WAIT_MS;
    const blank = await pageWith("<p>no otp</p>");
    const s3 = sessionFor(blank, {}, undefined, fakeFetch([{ body: {} }, { body: { code: "11" } }]).fn).session;
    expect(await runOtpFlow(s3)).toContain("entering it failed");
    s3.otpRequests = 5;
    expect(await runOtpFlow(s3)).toContain("too many times");
    delete process.env.OTP_POLL_MS;
    await page.close();
    await blank.close();
  });

  it("PAGE_MARKER is stable", () => {
    expect(PAGE_MARKER).toContain("CURRENT PAGE");
  });
});
