import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, extractPaymentRequest, groundedIn, mergeExtraction, MissingDataError, pickAmount, regexExtract, statedAmounts, validateRequest } from "../src/extraction.js";
import { FakeLlm } from "./helpers.js";

const JIO = "Pay Jio bill at https://www.jio.com/selfcare/paybill/mobility for jio number 9899832545, amount 10 rupees, email ravi_yadav0502@yahoo.in";

describe("extraction", () => {
  it("builds a prompt containing the message", () => {
    expect(buildExtractionPrompt("hello")).toContain("hello");
  });

  it("regex-extracts url, email, amount, account and mobile", () => {
    const r = regexExtract(`${JIO}. CA number 154431846`);
    expect(r).toMatchObject({ targetUrl: "https://www.jio.com/selfcare/paybill/mobility", email: "ravi_yadav0502@yahoo.in", amount: "10", mobileNumber: "9899832545", accountNumber: "154431846" });
    expect(regexExtract("pay Rs. 250 now").amount).toBe("250");
    expect(regexExtract("pay 99 rs").amount).toBe("99");
    expect(regexExtract("visit https://a.com/x).").targetUrl).toBe("https://a.com/x");
  });

  it("grounds values in the prompt", () => {
    expect(groundedIn("amount 10 rupees", "10")).toBe("10");
    expect(groundedIn("amount 10 rupees", "10.00")).toBeUndefined();
    expect(groundedIn("amount 10 rupees", "₹ 10")).toBe("₹ 10");
    expect(groundedIn("abc", "999")).toBeUndefined();
    expect(groundedIn("abc", "  ")).toBeUndefined();
    expect(groundedIn("abc", undefined)).toBeUndefined();
  });

  it("merges LLM and regex results discarding hallucinations", () => {
    const llm = { targetUrl: "https://www.jio.com/selfcare/paybill/mobility", accountNumber: "9899832545", amount: "500", customerName: "Suresh", paymentType: "postpaid", extra: { circle: "Delhi" } };
    const req = mergeExtraction(JIO, llm, regexExtract(JIO));
    expect(req.paymentData).toMatchObject({ accountNumber: "9899832545", amount: "10", mobileNumber: "9899832545", paymentType: "postpaid" });
    expect(req.paymentData.customerName).toBeUndefined();
    expect(req.paymentData.circle).toBeUndefined();
    expect(mergeExtraction("mobile number 9899832545 at https://x.com", null, regexExtract("mobile number 9899832545 at https://x.com")).paymentData.accountNumber).toBe("9899832545");
  });

  it("only treats explicitly stated numbers as amounts and grounds numbers as whole tokens", () => {
    const igl = "Pay IGL gas bill at https://webonline.igl.co.in:8077/x for BP number 1000125036, email ravi_yadav0502@yahoo.in";
    const bses = "Pay BSES bill at https://www.bsesdelhi.com/web/brpl/quick-pay for CA number 154431846";
    expect(groundedIn(igl, "10")).toBeUndefined();
    expect(groundedIn(bses, "15")).toBeUndefined();
    expect(groundedIn(igl, "1000125036")).toBe("1000125036");
    expect(mergeExtraction(igl, { amount: "10", accountNumber: "1000125036" }, regexExtract(igl)).paymentData.amount).toBeUndefined();
    expect(mergeExtraction(bses, { amount: "Pay10" }, regexExtract(bses)).paymentData.amount).toBeUndefined();
    expect(statedAmounts("pay Rs.250, then amount: 99.50 and 10 rupees; ₹5")).toEqual(["250", "99.50", "10", "5"]);
    expect(statedAmounts("pay 10 for jio 9899832545")).toEqual([]);
    expect(pickAmount("amount 10 rs, rs 20", "20")).toBe("20");
    expect(pickAmount("amount 10 rs", "999")).toBe("10");
    expect(pickAmount("no amount here", "10")).toBeUndefined();
  });

  it("validates required data", () => {
    expect(() => validateRequest({ targetUrl: "", paymentData: {} })).toThrow(MissingDataError);
    try {
      validateRequest({ targetUrl: "x", paymentData: {} });
    } catch (e) {
      expect((e as MissingDataError).missing).toEqual(["website URL", "account / consumer / mobile number"]);
    }
    expect(validateRequest({ targetUrl: "https://a", paymentData: { mobileNumber: "1" } }).targetUrl).toBe("https://a");
  });

  it("extracts end to end with the LLM, falling back to regex on LLM failure", async () => {
    const ok = await extractPaymentRequest(JIO, new FakeLlm([JSON.stringify({ accountNumber: "9899832545", email: "ravi_yadav0502@yahoo.in" })]));
    expect(ok.paymentData.amount).toBe("10");
    const fallback = await extractPaymentRequest(JIO, new FakeLlm(["THROW:down"]));
    expect(fallback.targetUrl).toBe("https://www.jio.com/selfcare/paybill/mobility");
    await expect(extractPaymentRequest("pay my bill", new FakeLlm(["{}"]))).rejects.toThrow("Missing required data");
  });
});
