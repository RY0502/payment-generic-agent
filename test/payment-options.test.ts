import { afterEach, describe, expect, it } from "vitest";
import {
  analysePaymentOptions,
  classifyMethod,
  DEFAULT_GATEWAY_PRIORITY,
  detectOptions,
  formatPaymentOptions,
  gatewayPriority,
  isDisallowedMethod,
  matchGateway,
  normalise,
  pickGateway,
  pickMethod,
} from "../src/payment-options.js";
import type { PageSnapshot, SnapshotElement } from "../src/types.js";

let n = 0;
const el = (kind: SnapshotElement["kind"], label: string, extra: Partial<SnapshotElement> = {}): SnapshotElement => ({ id: `e${n++}`, kind, label, tag: "x", frame: 0, ...extra });
const snap = (elements: SnapshotElement[], hasQrCode = false): PageSnapshot => ({ url: "u", title: "t", headings: [], text: "", elements, hasCaptcha: false, hasOtpInputs: false, otpBoxCount: 0, hasQrCode, hasDialog: false });

afterEach(() => delete process.env.GATEWAY_PRIORITY);

describe("classification", () => {
  it("classifies payment methods with QR and UPI taking precedence", () => {
    expect(classifyMethod("Pay via QR")).toBe("qr");
    expect(classifyMethod("Scan & Pay")).toBe("qr");
    expect(classifyMethod("UPI / QR")).toBe("qr");
    expect(classifyMethod("Cards / UPI")).toBe("upi");
    expect(classifyMethod("BHIM")).toBe("upi");
    expect(classifyMethod("Net Banking")).toBe("netbanking");
    expect(classifyMethod("Credit/Debit/ATM Card")).toBe("card");
    expect(classifyMethod("Wallets")).toBe("wallet");
    expect(classifyMethod("EMI")).toBe("emi");
    expect(classifyMethod("Pay Later")).toBe("paylater");
    expect(classifyMethod("Pay Now")).toBeNull();
  });

  it("flags disallowed methods only", () => {
    expect(isDisallowedMethod("Netbanking")).toBe(true);
    expect(isDisallowedMethod("Debit Card")).toBe(true);
    expect(isDisallowedMethod("UPI")).toBe(false);
    expect(isDisallowedMethod("Net Banking / Cards / UPI")).toBe(false);
    expect(isDisallowedMethod("Continue")).toBe(false);
  });

  it("matches gateways by normalised name and reads priority from env", () => {
    expect(normalise("Bill Desk")).toBe("billdesk");
    expect(matchGateway("Select for BILL DESK", DEFAULT_GATEWAY_PRIORITY)).toBe("billdesk");
    expect(matchGateway("PayU Money", DEFAULT_GATEWAY_PRIORITY)).toBe("payu");
    expect(matchGateway("Continue", DEFAULT_GATEWAY_PRIORITY)).toBeNull();
    expect(gatewayPriority()).toBe(DEFAULT_GATEWAY_PRIORITY);
    process.env.GATEWAY_PRIORITY = "Paytm, Bill Desk,";
    expect(gatewayPriority()).toEqual(["paytm", "billdesk"]);
  });
});

describe("detection and picking", () => {
  it("detects gateways (known names or gateway radio group) and methods; skips chrome, sidebar, links, disabled, long labels", () => {
    const elements = [
      el("radio", "Bill Desk", { name: "x_paymentGateWay" }),
      el("radio", "Pay 10", { name: "x_paymentGateWay" }),
      el("radio", "Select for Paytm"),
      el("tab", "UPI"),
      el("button", "Netbanking"),
      el("link", "UPI"),
      el("button", "QR", { inChrome: true }),
      el("button", "QR", { inSidebar: true }),
      el("button", "QR", { disabled: true }),
      el("button", "Assured cashback using Paytm UPI on orders above Rs 349, T&C apply always"),
      el("input", "UPI"),
    ];
    const { gateways, methods } = detectOptions(elements);
    expect(gateways.map((g) => [g.el.label, g.type])).toEqual([["Bill Desk", "billdesk"], ["Pay 10", "pay10"], ["Select for Paytm", "paytm"]]);
    expect(methods.map((m) => [m.el.label, m.type])).toEqual([["UPI", "upi"], ["Netbanking", "netbanking"]]);
    expect(detectOptions([el("radio", "Some Bank", { domId: "pg_bank" })]).gateways[0].type).toBe("gateway");
  });

  it("picks the user's gateway, else by priority; picks QR before UPI", () => {
    const gateways = detectOptions([el("radio", "Paytm"), el("radio", "PayU"), el("radio", "Bill Desk"), el("radio", "Other Bank", { name: "gateway" })]).gateways;
    expect(pickGateway(gateways, undefined, DEFAULT_GATEWAY_PRIORITY)!.el.label).toBe("Bill Desk");
    expect(pickGateway(gateways, "PayU", DEFAULT_GATEWAY_PRIORITY)!.el.label).toBe("PayU");
    expect(pickGateway(gateways, "Unknown PG", DEFAULT_GATEWAY_PRIORITY)!.el.label).toBe("Bill Desk");
    expect(pickGateway(detectOptions([el("radio", "Other Bank", { name: "gateway" }), el("radio", "Paytm")]).gateways, undefined, DEFAULT_GATEWAY_PRIORITY)!.el.label).toBe("Paytm");
    expect(pickGateway([], undefined, DEFAULT_GATEWAY_PRIORITY)).toBeNull();
    const methods = detectOptions([el("tab", "Cards"), el("tab", "UPI"), el("tab", "QR Code")]).methods;
    expect(pickMethod(methods)!.el.label).toBe("QR Code");
    expect(pickMethod(methods.filter((m) => m.type !== "qr"))!.el.label).toBe("UPI");
    expect(pickMethod(methods.filter((m) => m.type === "card"))).toBeNull();
  });
});

describe("suggestions", () => {
  it("prefers a visible QR, then QR/UPI options, then gateways", () => {
    expect(analysePaymentOptions(snap([el("tab", "UPI")], true)).suggestion).toContain("scan_upi_qr_code now");
    const qrTab = analysePaymentOptions(snap([el("radio", "Bill Desk", { name: "gateway" }), el("tab", "Net Banking"), el("tab", "QR")]));
    expect(qrTab.suggestion).toMatch(/^click\(\{"elementId":"e\d+","description":"QR"\}\) - UPI QR is the preferred/);
    const upiRadio = analysePaymentOptions(snap([el("radio", "UPI"), el("radio", "Debit Card")]));
    expect(upiRadio.suggestion).toMatch(/^select_option\(\{"elementId":"e\d+","optionName":"UPI"\}\) - UPI is the preferred method when no QR/);
    expect(analysePaymentOptions(snap([el("tab", "QR", { checked: true })])).suggestion).toContain("already selected: click the button that reveals");
    expect(analysePaymentOptions(snap([el("tab", "UPI", { checked: true })])).suggestion).toContain('dataKey "upiId"');
  });

  it("suggests choosing / continuing with a gateway, honouring the user's preference", () => {
    const page = snap([el("radio", "Pay 10", { name: "pg" }), el("radio", "Bill Desk", { name: "pg" })]);
    expect(analysePaymentOptions(page).suggestion).toMatch(/select_option\(\{"elementId":"e\d+","optionName":"Bill Desk"\}\) to choose the payment gateway/);
    expect(analysePaymentOptions(page, "Pay10").suggestion).toContain('"optionName":"Pay 10"');
    expect(analysePaymentOptions(snap([el("radio", "Bill Desk", { name: "pg", checked: true })])).suggestion).toContain('"Bill Desk" is selected: click the Pay Now');
  });

  it("explains when only disallowed methods exist, and renders the section", () => {
    const only = analysePaymentOptions(snap([el("tab", "Net Banking"), el("tab", "Cards")]));
    expect(only.suggestion).toContain("Only netbanking, card are offered");
    const text = formatPaymentOptions(analysePaymentOptions(snap([el("radio", "Bill Desk", { name: "pg", checked: true }), el("tab", "Wallets")])));
    expect(text).toContain("gateways: [e");
    expect(text).toContain("Bill Desk (selected)");
    expect(text).toContain("{wallet - not allowed}");
    expect(text).toContain("SUGGESTED NEXT ACTION:");
    expect(formatPaymentOptions(analysePaymentOptions(snap([el("button", "Continue")])))).toBe("");
    expect(formatPaymentOptions({ gateways: [], methods: [], suggestion: "x" })).toBe("PAYMENT OPTIONS:\nSUGGESTED NEXT ACTION: x");
  });
});
