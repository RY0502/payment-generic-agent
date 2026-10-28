import { afterAll, describe, expect, it } from "vitest";
import { dedupeElements, formatElement, formatSnapshot, isNoise, locateRef, rankElement, takeSnapshot } from "../src/page-snapshot.js";
import type { SnapshotElement } from "../src/types.js";
import { closeBrowser, pageWith } from "./helpers.js";

afterAll(closeBrowser);

const FORM = `
<header><nav><a href="#">Home</a><a href="#">Pay Bills</a></nav></header>
<h1>Pay Bill</h1>
<label for="ca">CA Number</label><input id="ca" name="accountNumber" maxlength="9" required>
<input placeholder="Enter Amount" name="amount" value="250">
<input type="hidden" name="secret">
<select id="st" aria-label="State"><option>Delhi</option><option>Noida</option></select>
<label><input type="radio" name="gw" value="bd" style="display:none"> BillDesk</label>
<label><input type="checkbox" checked> I agree</label>
<input type="submit" value="Quick Pay">
<button disabled>Pay Now</button>
<div style="cursor:pointer">Pay via QR</div>
<div style="cursor:pointer"><span>child</span><button>inner</button></div>
<ul class="tabs"><li><a>UPI</a></li></ul>
<div role="tab" aria-selected="true">Cards</div>
<img src="/captcha.jpg" width="120" height="40" alt="captcha">
<input name="captchaText" placeholder="Enter captcha">
<div role="dialog"><p>Confirm payment?</p><button>Proceed with Payment</button></div>
<div id="host"></div>
<footer><a href="#">Privacy</a></footer>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button>Shadow Btn</button>';</script>`;

describe("page snapshot", () => {
  it("discovers every interactive element in one pass, incl. shadow DOM and dialogs", async () => {
    const page = await pageWith(FORM);
    const snap = await takeSnapshot(page);
    const byLabel = (l: string) => snap.elements.find((e) => e.label.includes(l));
    expect(byLabel("CA Number")).toMatchObject({ kind: "input", name: "accountNumber", maxLength: 9, required: true });
    expect(byLabel("Enter Amount")?.value).toBe("250");
    expect(byLabel("State")?.options).toEqual(["Delhi", "Noida"]);
    expect(byLabel("BillDesk")).toMatchObject({ kind: "radio", checked: false });
    expect(byLabel("I agree")).toMatchObject({ kind: "checkbox", checked: true });
    expect(byLabel("Quick Pay")?.kind).toBe("button");
    expect(byLabel("Pay Now")?.disabled).toBe(true);
    expect(byLabel("Pay via QR")?.kind).toBe("button");
    expect(byLabel("UPI")?.kind).toBe("tab");
    expect(byLabel("Cards")).toMatchObject({ kind: "tab", checked: true });
    expect(byLabel("Proceed with Payment")?.inDialog).toBe(true);
    expect(byLabel("Shadow Btn")).toBeTruthy();
    expect(byLabel("Privacy")?.inChrome).toBe(true);
    expect(snap.elements.some((e) => e.name === "secret")).toBe(false);
    expect(snap).toMatchObject({ hasCaptcha: true, hasDialog: true, hasOtpInputs: false, hasQrCode: false });
    expect(snap.dialogText).toContain("Confirm payment?");
    const ref = await locateRef(page, byLabel("Shadow Btn")!.id);
    expect(await ref?.textContent()).toBe("Shadow Btn");
    expect(await locateRef(page, "e9999")).toBeNull();
    const text = formatSnapshot(snap, 60);
    expect(text).toContain("OPEN DIALOG/POPUP");
    expect(text).toContain("captcha=YES");
    expect(text).not.toContain('link "Privacy"');
    await page.close();
  });

  it("detects OTP boxes, QR codes and iframe content", async () => {
    const qr = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>').toString("base64")}`;
    const page = await pageWith(`
      <div>${[1, 2, 3, 4].map(() => '<input maxlength="1">').join("")}</div>
      <div class="qr-wrap"><p>Scan QR</p><img src="${qr}" width="200" height="200" alt="qr"></div>
      <iframe srcdoc="<button>Frame Pay</button>"></iframe>`);
    await page.waitForTimeout(300);
    const snap = await takeSnapshot(page);
    expect(snap).toMatchObject({ hasOtpInputs: true, otpBoxCount: 4, hasQrCode: true });
    const frameBtn = snap.elements.find((e) => e.label === "Frame Pay");
    expect(frameBtn?.frame).toBeGreaterThan(0);
    expect(await (await locateRef(page, frameBtn!.id))?.textContent()).toBe("Frame Pay");
    expect(formatSnapshot(snap, 3)).toMatch(/low-priority omitted/);
    await page.close();
  });

  it("ranks, formats, dedupes and filters noise", () => {
    const base: SnapshotElement = { id: "e1", kind: "button", label: "Pay", tag: "button", frame: 0 };
    expect(rankElement({ ...base, inDialog: true })).toBeGreaterThan(rankElement(base));
    expect(rankElement({ ...base, kind: "link", label: "x", disabled: true, inChrome: true })).toBeLessThan(0);
    expect(rankElement({ ...base, kind: "radio" })).toBeGreaterThan(0);
    expect(formatElement({ ...base, kind: "input", type: "tel", placeholder: "ph", name: "n", value: "v", maxLength: 6, required: true, frame: 2 })).toBe(
      '[e1] input type=tel "Pay" placeholder="ph" name=n value="v" maxlength=6 required [iframe 2]'
    );
    expect(formatElement({ ...base, label: "", checked: true, disabled: true, inDialog: true, options: ["a"] })).toContain('"" options=["a"] (selected) (disabled) [in dialog]');
    expect(dedupeElements([base, { ...base, id: "e2" }, { ...base, id: "e3", kind: "input" }, { ...base, id: "e4", kind: "input" }]).map((e) => e.id)).toEqual(["e1", "e3", "e4"]);
    expect(isNoise({ ...base, label: "About", inChrome: true })).toBe(true);
    expect(isNoise({ ...base, label: "Pay Bills", inChrome: true })).toBe(false);
  });

  it("formats an empty page", () => {
    const text = formatSnapshot({ url: "u", title: "t", headings: [], text: "", elements: [], hasCaptcha: false, hasOtpInputs: false, otpBoxCount: 0, hasQrCode: false, hasDialog: false }, 10);
    expect(text).toContain("INPUT FIELDS (0):\n(none)");
  });
});
