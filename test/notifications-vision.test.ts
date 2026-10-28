import { afterEach, describe, expect, it } from "vitest";
import { fetchOtpCode, otpConfig, pollOtp, requestOtp, sendQrNotification } from "../src/notifications.js";
import { fakeFetch, fakeVision } from "./helpers.js";

const ENV = ["PAYMENT_NOTIFICATION_URL", "SUPABASE_ANON_KEY", "OTP_NOTIFICATION_URL", "OTP_LOOKUP_URL"];
const setEnv = () => {
  process.env.PAYMENT_NOTIFICATION_URL = "https://n/pay";
  process.env.SUPABASE_ANON_KEY = "k";
  process.env.OTP_NOTIFICATION_URL = "https://n/otp";
  process.env.OTP_LOOKUP_URL = "https://n/lookup";
};

describe("notifications", () => {
  afterEach(() => ENV.forEach((k) => delete process.env[k]));

  it("reports missing configuration", async () => {
    expect((await sendQrNotification({}, "u")).sent).toBe(false);
    expect(otpConfig()).toBeNull();
    await expect(requestOtp("id")).rejects.toThrow("not configured");
    await expect(fetchOtpCode("id")).rejects.toThrow("not configured");
  });

  it("sends QR notifications and handles HTTP/network errors", async () => {
    setEnv();
    const ok = fakeFetch([{ body: "ok" }]);
    expect((await sendQrNotification({ amount: "1" }, "qr", ok.fn)).sent).toBe(true);
    expect(ok.calls[0].body).toEqual({ paymentData: { amount: "1" }, paymentUrl: "qr" });
    expect((await sendQrNotification({}, "qr", fakeFetch([{ status: 500, body: "bad" }]).fn)).message).toContain("500");
    const boom = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    expect((await sendQrNotification({}, "qr", boom)).message).toContain("net");
  });

  it("requests and polls OTP codes", async () => {
    setEnv();
    await requestOtp("id", fakeFetch([{ body: {} }]).fn);
    await expect(requestOtp("id", fakeFetch([{ status: 401, body: "no" }]).fn)).rejects.toThrow("401");
    expect(await fetchOtpCode("id", fakeFetch([{ body: { code: "12-34" } }]).fn)).toBe("1234");
    expect(await fetchOtpCode("id", fakeFetch([{ body: { code: null } }]).fn)).toBeNull();
    expect(await fetchOtpCode("id", fakeFetch([{ body: { code: "--" } }]).fn)).toBeNull();
    await expect(fetchOtpCode("id", fakeFetch([{ status: 500, body: "x" }]).fn)).rejects.toThrow("500");
    const seq = fakeFetch([{ status: 500, body: "x" }, { body: { code: null } }, { body: { code: 4321 } }]);
    expect(await pollOtp("id", { pollMs: 1, totalMs: 1000, fetchFn: seq.fn })).toBe("4321");
    expect(await pollOtp("id", { pollMs: 1, totalMs: 5, sleep: async () => new Promise((r) => setTimeout(r, 3)), fetchFn: fakeFetch([{ body: {} }]).fn })).toBeNull();
  });
});

describe("vision analyzer", () => {
  it("summarises pages with defaults and failure fallback", async () => {
    const { vision } = fakeVision(['{"pageType":"form","summary":"s","hasCaptcha":true}', "garbage", "THROW:x"]);
    expect(await vision.summarizePage("img", "goal")).toEqual({ pageType: "form", summary: "s", hasCaptcha: true, hasQrCode: false, isPaymentSuccessPage: false });
    expect((await vision.summarizePage("img", "goal")).pageType).toBe("unknown");
    expect((await vision.summarizePage("img", "goal")).summary).toBe("");
  });

  it("solves captchas", async () => {
    const { vision } = fakeVision(['"Ab 12"', "UNREADABLE", "THROW:x"]);
    expect(await vision.solveCaptcha("i")).toBe("Ab12");
    expect(await vision.solveCaptcha("i")).toBeNull();
    expect(await vision.solveCaptcha("i")).toBeNull();
  });

  it("detects success with confidence threshold", async () => {
    const { vision } = fakeVision(['{"isSuccess":true,"confidence":0.9}', '{"isSuccess":true,"confidence":0.5}', "THROW:x"]);
    expect(await vision.detectPaymentSuccess("i", "t")).toBe(true);
    expect(await vision.detectPaymentSuccess("i", "t")).toBe(false);
    expect(await vision.detectPaymentSuccess("i", "t")).toBe(false);
  });

  it("finds selectors and coordinates", async () => {
    const { vision } = fakeVision(["`#a`", "null", "THROW:x", '{"found":true,"x":10,"y":20}', '{"found":true,"x":5000,"y":1}', "THROW:x"]);
    expect(await vision.findSelector("i", "x")).toBe("#a");
    expect(await vision.findSelector("i", "x")).toBeNull();
    expect(await vision.findSelector("i", "x")).toBeNull();
    expect(await vision.locateElement("i", "x")).toEqual({ x: 10, y: 20 });
    expect(await vision.locateElement("i", "x")).toBeNull();
    expect(await vision.locateElement("i", "x")).toBeNull();
  });
});
