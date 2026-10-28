import type { Page } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { takeSnapshot } from "../src/page-snapshot.js";
import { readCaptcha, solveAndFillCaptcha } from "../src/strategies/captcha.js";
import { clickElement } from "../src/strategies/click.js";
import { cleanText, clickLocator, escapeRegex, fillLocator, looseRegex, q, runStrategies, valuesMatch } from "../src/strategies/common.js";
import { selectDropdown } from "../src/strategies/dropdown.js";
import { fillField } from "../src/strategies/fill.js";
import { enterOtp, findOtpInputs, findOtpSubmit } from "../src/strategies/otp.js";
import { nameVariants, selectPaymentOption } from "../src/strategies/payment-option.js";
import { closeBrowser, fakeVision, pageWith } from "./helpers.js";

afterAll(closeBrowser);

const CLICK_LOG = `<script>window.clicked=[];document.addEventListener('click',e=>{const t=e.target.closest('[data-k]');if(t)window.clicked.push(t.dataset.k)},true)</script>`;
const clicked = (page: Page) => page.evaluate(() => (window as any).clicked as string[]);
const val = (page: Page, sel: string) => page.inputValue(sel);

describe("common helpers", () => {
  it("escapes and normalises text", () => {
    expect(q('a"b\\')).toBe('a\\"b\\\\');
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(looseRegex("CA number").test("ca account number")).toBe(true);
    expect(cleanText("Next >\n")).toBe("Next");
    expect(valuesMatch("1,000", "1000")).toBe(true);
    expect(valuesMatch("10", "10.00")).toBe(true);
    expect(valuesMatch("abc", "abd")).toBe(false);
  });

  it("runStrategies skips throwing finders and failing actions", async () => {
    const page = await pageWith("<input id=a>");
    const out = await runStrategies(
      [
        { name: "throws", find: async () => { throw new Error("x"); } },
        { name: "none", find: async () => null },
        { name: "bad", find: async () => page.locator("#a") },
        { name: "good", find: async () => page.locator("#a") },
      ],
      {},
      async (_l, name) => { if (name === "bad") throw new Error("fail"); }
    );
    expect(out).toMatchObject({ ok: true, strategy: "good" });
    expect((await runStrategies([], {}, async () => {})).ok).toBe(false);
    await page.close();
  });

  it("fillLocator falls back to typing / native setter for reactive inputs", async () => {
    const page = await pageWith(`<input id="r"><input id="locked"><script>
      const r=document.getElementById('r'); let first=true;
      r.addEventListener('input',()=>{ if(first){first=false; r.value='';} });
      const l=document.getElementById('locked'); l.addEventListener('input',()=>{ l.value='x'; });
    </script>`);
    await fillLocator(page.locator("#r"), "123");
    expect(await val(page, "#r")).toBe("123");
    await expect(fillLocator(page.locator("#locked"), "9")).rejects.toThrow("did not stick");
    await page.close();
  });

  it("clickLocator falls back to JS click for covered elements", async () => {
    const page = await pageWith(`${CLICK_LOG}<button data-k="b" style="position:absolute;top:0">B</button><div style="position:absolute;top:0;width:500px;height:500px;background:#fff"></div>`);
    await clickLocator(page.locator("button"));
    expect(await clicked(page)).toEqual(["b"]);
    await page.close();
  });
});

describe("fill strategies", () => {
  const cases: [string, string, string][] = [
    ["placeholder-exact", '<input id="t" placeholder="Enter Jio Number">', "Jio Number"],
    ["label", '<label for="t">Consumer No</label><input id="t">', "Consumer No"],
    ["name-attribute", '<input id="t" name="bpNumberField">', "bpnumberfield value"],
    ["id-attribute", '<input id="t" class="x"><input id="mobileNo">', "t"],
    ["preceding-text", '<span>Mobile Number</span><div><input id="t"></div>', "Mobile Number"],
    ["utility CA", '<input id="t" placeholder="CA Number">', "CA Number"],
    ["title scan", '<input id="t" title="account-number-box">', "zz account number box"],
  ];
  for (const [name, html, description] of cases) {
    it(`fills via ${name}`, async () => {
      const page = await pageWith(html);
      const out = await fillField({ page, description, value: "9899832545" });
      expect(out.ok).toBe(true);
      expect(await val(page, "#t")).toBe("9899832545");
      await page.close();
    });
  }

  it("fills by snapshot ref and inside iframes; fails when nothing matches", async () => {
    const page = await pageWith('<input id="a"><input id="t"><iframe srcdoc="<input placeholder=\'Frame Field\'>"></iframe>');
    await page.waitForTimeout(200);
    const snap = await takeSnapshot(page);
    const ref = snap.elements.find((e) => e.domId === "t")!.id;
    expect((await fillField({ page, description: "qqq", value: "7", elementId: ref })).strategy).toBe("snapshot-ref");
    expect(await val(page, "#t")).toBe("7");
    expect((await fillField({ page, description: "Frame Field", value: "8" })).strategy).toBe("iframe-placeholder-label");
    expect((await fillField({ page, description: "nothing here", value: "1" })).ok).toBe(false);
    await page.close();
  });

  it("fills the single visible input as last resort", async () => {
    const page = await pageWith('<input id="t">');
    expect((await fillField({ page, description: "qqq", value: "5" })).strategy).toBe("single-visible-input");
    await page.close();
  });
});

describe("click strategies", () => {
  const cases: [string, string, string][] = [
    ["exact button", '<button data-k="x">Continue</button>', "Continue >"],
    ["submit input", '<input type="submit" data-k="x" value="Quick Pay">', "Quick Pay"],
    ["link", '<a data-k="x" href="#">Get Details</a>', "Get Details"],
    ["role regex", '<button data-k="x"><span>Pay</span> <b>Bill Now</b></button>', "Pay Bill"],
    ["text div", '<div data-k="x" style="cursor:pointer">Pay via QR</div>', "Pay via QR"],
    ["class attribute", '<a data-k="x" class="bdi-netbanking"></a>', "net banking"],
    ["aria label", '<button data-k="x" aria-label="Close dialog"></button>', "Close dialog"],
  ];
  for (const [name, html, description] of cases) {
    it(`clicks via ${name}`, async () => {
      const page = await pageWith(CLICK_LOG + html);
      const out = await clickElement({ page, description });
      expect(out.ok).toBe(true);
      expect(await clicked(page)).toContain("x");
      await page.close();
    });
  }

  it("reports disabled buttons instead of clicking", async () => {
    const page = await pageWith('<button disabled>PAY BILL</button>');
    const out = await clickElement({ page, description: "PAY BILL" });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("DISABLED");
    await page.close();
  });

  it("uses snapshot ref, iframes and finally vision coordinates", async () => {
    const page = await pageWith(`${CLICK_LOG}<span data-k="ref" id="s">zz</span><iframe srcdoc="<button onclick='parent.framed=1'>Frame Go</button>"></iframe>`);
    await page.waitForTimeout(200);
    const snap = await takeSnapshot(page);
    const ref = snap.elements.find((e) => e.domId === "s")?.id ?? "e0";
    await page.evaluate(() => document.getElementById("s")!.setAttribute("tabindex", "0"));
    const snap2 = await takeSnapshot(page);
    const ref2 = snap2.elements.find((e) => e.domId === "s")?.id ?? ref;
    expect((await clickElement({ page, description: "nomatch-ref", elementId: ref2 })).strategy).toBe("snapshot-ref");
    expect((await clickElement({ page, description: "Frame Go" })).ok).toBe(true);
    expect(await page.evaluate(() => (window as any).framed)).toBe(1);
    const { vision } = fakeVision(['{"found":true,"x":5,"y":5}']);
    expect((await clickElement({ page, description: "invisible thing", vision })).strategy).toBe("vision-coordinates");
    expect((await clickElement({ page, description: "invisible thing" })).ok).toBe(false);
    await page.close();
  });
});

describe("payment option strategies", () => {
  it("builds name variants", () => {
    expect(nameVariants("Bill Desk")).toEqual({ spaced: "bill desk", compact: "billdesk", hyphen: "bill-desk", underscore: "bill_desk" });
  });

  const cases: [string, string, string][] = [
    ["BillDesk tab", '<ul class="tabs"><li><a data-k="x" data-value="qr"><span>QR</span></a></li></ul>', "QR"],
    ["hidden radio with label", '<label data-k="x"><input type="radio" name="g" id="billdesk-RB" style="display:none"> Bill Desk</label>', "Bill Desk"],
    ["role radio wrapper", '<span role="radio" id="payu" data-k="x">.</span>', "PayU"],
    ["data-title radio", '<input type="radio" data-k="x" data-title="GooglePay">', "GooglePay"],
    ["radio label for", '<input type="radio" id="cub" style="display:none"><label data-k="x" for="cub">City Union Bank</label>', "cub"],
    ["image", '<div><input type="radio" data-k="x" name="g"><img src="/img/bill-desk.png" width="40" height="20"></div>', "Bill Desk"],
    ["aria radio", '<input type="radio" data-k="x" aria-label="Razorpay gateway">', "Razorpay"],
  ];
  for (const [name, html, option] of cases) {
    it(`selects via ${name}`, async () => {
      const page = await pageWith(CLICK_LOG + html);
      const out = await selectPaymentOption({ page, optionName: option });
      expect(out.ok).toBe(true);
      expect(await clicked(page)).toContain("x");
      await page.close();
    });
  }

  const moreCases: [string, string, string, string][] = [
    ["exact tab span", '<ul class="tabs"><li><a data-k="x"><span>UPI</span></a></li></ul>', "UPI", "tab-or-link"],
    ["container radio", '<span>PhonePe <input type="radio" data-k="x"></span>', "PhonePe", ""],
    ["image label parent", '<label data-k="x"><img alt="Paytm wallet" width="30" height="30"></label>', "Paytm", "image"],
    ["image sibling radio", '<div><input type="radio" data-k="x"><div><img src="/b/city_union.png" width="30" height="30"></div></div>', "City Union", "image"],
    ["image only", '<img data-k="x" src="/b/hdfc-logo.png" width="30" height="30">', "HDFC", "image"],
    ["iframe option", '<iframe srcdoc="<span onclick=\'parent.picked=1\'>AmazonPay</span>"></iframe>', "AmazonPay", "iframe-option"],
  ];
  for (const [name, html, option, strategy] of moreCases) {
    it(`selects via ${name}`, async () => {
      const page = await pageWith(CLICK_LOG + html);
      await page.waitForTimeout(150);
      const out = await selectPaymentOption({ page, optionName: option });
      expect(out).toMatchObject(strategy ? { ok: true, strategy } : { ok: true });
      if (strategy === "iframe-option") expect(await page.evaluate(() => (window as any).picked)).toBe(1);
      else expect(await clicked(page)).toContain("x");
      await page.close();
    });
  }

  it("selects by snapshot ref, role radio and radio iteration", async () => {
    const page = await pageWith(`${CLICK_LOG}<p data-k="r" tabindex="0" id="opt">zzz</p><span role="radio" aria-label="Mobikwik" data-k="m">.</span><p><input type="radio" data-k="it"> Freecharge</p>`);
    const snap = await takeSnapshot(page);
    const ref = snap.elements.find((e) => e.domId === "opt")!.id;
    expect((await selectPaymentOption({ page, optionName: "nonexistent-x", elementId: ref })).strategy).toBe("snapshot-ref");
    expect((await selectPaymentOption({ page, optionName: "Mobikwik" })).ok).toBe(true);
    expect((await selectPaymentOption({ page, optionName: "Freecharge" })).ok).toBe(true);
    expect(await clicked(page)).toEqual(expect.arrayContaining(["r", "m", "it"]));
    await page.close();
  });

  it("fails cleanly when no option exists", async () => {
    const page = await pageWith("<p>nothing</p>");
    expect((await selectPaymentOption({ page, optionName: "Zeta" })).ok).toBe(false);
    await page.close();
  });
});

describe("dropdown strategies", () => {
  it("selects native selects by label, by option content and custom dropdowns", async () => {
    const page = await pageWith(`
      <label for="s">Circle</label><select id="s"><option>Delhi</option><option>Mumbai Metro</option></select>
      <select id="s2"><option>Gas</option><option>Water</option></select>
      <div role="combobox" aria-label="Biller" onclick="document.getElementById('opts').style.display='block'">Choose</div>
      <ul id="opts" style="display:none"><li role="option" onclick="window.picked='IGL'">IGL</li></ul>`);
    const { vision } = fakeVision(["#s"]);
    expect((await selectDropdown({ page, dropdownDescription: "Circle", optionText: "mumbai", vision })).strategy).toBe("vision-selector");
    expect(await page.inputValue("#s")).toBe("Mumbai Metro");
    expect((await selectDropdown({ page, dropdownDescription: "type", optionText: "Water" })).ok).toBe(true);
    expect(await page.inputValue("#s2")).toBe("Water");
    expect((await selectDropdown({ page, dropdownDescription: "Biller", optionText: "IGL" })).strategy).toBe("combobox-role");
    expect(await page.evaluate(() => (window as any).picked)).toBe("IGL");
    expect((await selectDropdown({ page, dropdownDescription: "none", optionText: "zzz" })).ok).toBe(false);
    await page.close();
  });
});

describe("captcha", () => {
  const IMG = '<img id="captchaImg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="120" height="40">';
  it("reads the cropped image first and fills the captcha input", async () => {
    const page = await pageWith(`${IMG}<input name="captchaText">`);
    const { vision, llm } = fakeVision(["Ab12"]);
    const out = await solveAndFillCaptcha({ page, fieldDescription: "captcha" }, vision, async () => "full");
    expect(out).toMatchObject({ ok: true, text: "Ab12" });
    expect(llm.calls[0].imageBase64).not.toBe("full");
    expect(await page.inputValue("input")).toBe("Ab12");
    await page.close();
  });

  it("falls back to the full screenshot and reports unreadable / unfillable captchas", async () => {
    const page = await pageWith("<p>no captcha</p>");
    const { vision, llm } = fakeVision(["XY9", "UNREADABLE"]);
    expect(await readCaptcha(page, vision, async () => "full")).toBe("XY9");
    expect(llm.calls[0].imageBase64).toBe("full");
    expect((await solveAndFillCaptcha({ page, fieldDescription: "captcha" }, vision, async () => "full")).ok).toBe(false);
    const { vision: v2 } = fakeVision(["QQ1"]);
    const out = await solveAndFillCaptcha({ page, fieldDescription: "captcha" }, v2, async () => "full");
    expect(out.message).toContain("could not find");
    await page.close();
  });
});

describe("otp", () => {
  it("types one digit per box and submits", async () => {
    const page = await pageWith(`<div role="dialog">${[0, 1, 2, 3].map((i) => `<input id="o${i}" maxlength="1">`).join("")}<button onclick="window.sent=1">LOGIN</button></div>`);
    await enterOtp(page, "1234");
    expect(await Promise.all([0, 1, 2, 3].map((i) => page.inputValue(`#o${i}`)))).toEqual(["1", "2", "3", "4"]);
    expect(await page.evaluate(() => (window as any).sent)).toBe(1);
    await page.close();
  });

  it("fills a single OTP field, supports no-submit and errors when missing", async () => {
    const page = await pageWith('<input name="otpCode"><input name="other"><button type="submit" onclick="window.sent=1">Verify</button>');
    expect(await findOtpInputs(page, 6)).toHaveLength(1);
    await enterOtp(page, "654321", false);
    expect(await page.inputValue('[name="otpCode"]')).toBe("654321");
    expect(await page.evaluate(() => (window as any).sent)).toBeUndefined();
    expect(await findOtpSubmit(page)).not.toBeNull();
    const empty = await pageWith("<p>none</p>");
    await expect(enterOtp(empty, "1")).rejects.toThrow("No visible OTP input");
    const noSubmit = await pageWith('<input autocomplete="one-time-code">');
    await expect(enterOtp(noSubmit, "12")).rejects.toThrow("Submit/Login button not found");
    for (const p of [page, empty, noSubmit]) await p.close();
  });

  it("uses heuristics when no OTP attributes exist", async () => {
    const page = await pageWith('<input id="a"><input id="b" maxlength="6">');
    const inputs = await findOtpInputs(page, 6);
    expect(await inputs[0].getAttribute("id")).toBe("b");
    const exact = await pageWith('<input id="a"><input id="b">');
    expect(await findOtpInputs(exact, 2)).toHaveLength(2);
    const last = await pageWith('<input id="a"><input id="b"><input id="c">');
    expect(await (await findOtpInputs(last, 6))[0].getAttribute("id")).toBe("c");
    for (const p of [page, exact, last]) await p.close();
  });
});
