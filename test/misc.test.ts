import { describe, expect, it } from "vitest";
import { CONFIG, intFromEnv } from "../src/config.js";
import { availableKeys, canonicalKey, compactData, isStandardKey, resolveValue } from "../src/payment-data.js";
import { buildSystemPrompt, NO_TOOL_NUDGE } from "../src/prompts.js";
import { BadRequestError, buildInitialState, promptText, toResponse, wantsStream } from "../src/request.js";
import { findFailurePhrase, hasSuccessSignal } from "../src/success.js";
import { formatToolDocs } from "../src/tools/index.js";

describe("config", () => {
  it("reads ints with fallback", () => {
    process.env.T_INT = "5";
    expect(intFromEnv("T_INT", 1)).toBe(5);
    process.env.T_INT = "-3";
    expect(intFromEnv("T_INT", 1)).toBe(1);
    expect(intFromEnv("T_MISSING", 7)).toBe(7);
  });
  it("exposes defaults", () => {
    expect(CONFIG.maxSteps).toBeGreaterThan(0);
    expect(CONFIG.paymentTimeoutMs).toBeGreaterThan(0);
    expect(CONFIG.paymentWaitMs + CONFIG.paymentPollMs + CONFIG.otpPollMs + CONFIG.otpTotalWaitMs + CONFIG.snapshotMaxElements + CONFIG.recursionLimit).toBeGreaterThan(0);
    expect(typeof CONFIG.headless).toBe("boolean");
    expect(typeof CONFIG.isVercel).toBe("boolean");
  });
});

describe("payment data", () => {
  const data = { accountNumber: "9899832545", amount: "10", BP_Number: "x", empty: "" };
  it("resolves aliases and fallbacks", () => {
    expect(canonicalKey(data, "amount")).toBe("amount");
    expect(canonicalKey(data, "bp number")).toBe("BP_Number");
    expect(canonicalKey(data, "CA Number")).toBe("accountNumber");
    expect(canonicalKey(data, "whatever")).toBe("whatever");
    expect(resolveValue(data, "phone")).toBe("9899832545");
    expect(resolveValue({ mobileNumber: "1" }, "accountNumber")).toBe("1");
    expect(resolveValue(data, "email")).toBeUndefined();
  });
  it("classifies keys and compacts data", () => {
    expect(isStandardKey(data, "upi")).toBe(true);
    expect(isStandardKey(data, "circle")).toBe(false);
    expect(availableKeys(data)).toEqual(["accountNumber", "amount", "BP_Number"]);
    expect(compactData({ a: " 1 ", b: "", c: undefined })).toEqual({ a: "1" });
  });
});

describe("prompts and docs", () => {
  it("builds the system prompt", () => {
    const p = buildSystemPrompt({ paymentData: { amount: "10" }, targetUrl: "https://x", step: 2, maxSteps: 9, toolDocs: "- t" });
    expect(p).toContain('"amount": "10"');
    expect(p).toContain("Step 2/9");
    expect(NO_TOOL_NUDGE).toContain("JSON");
  });
  it("formats known and unknown tool docs", () => {
    expect(formatToolDocs([{ name: "click", description: "" }, { name: "zzz", description: "desc" }])).toContain("- zzz - desc");
  });
});

describe("request mapping", () => {
  it("parses prompt formats", () => {
    expect(promptText({ prompt: ["a", "b"] })).toBe("a\nb");
    expect(promptText({ message: "m" })).toBe("m");
    expect(promptText({ input: { messages: [{ content: "x" }, "y", { content: ["p", "q"] }] } })).toBe("x\ny\np\nq");
    expect(promptText({})).toBeNull();
  });
  it("builds initial state for prompt and structured requests", () => {
    expect(buildInitialState({ prompt: "pay" }).targetUrl).toBe("");
    expect(buildInitialState({ paymentData: { a: "1" }, targetUrl: "https://t" }).targetUrl).toBe("https://t");
    expect(() => buildInitialState({ prompt: " " })).toThrow(BadRequestError);
    expect(() => buildInitialState({})).toThrow(BadRequestError);
  });
  it("maps responses and stream mode", () => {
    expect(toResponse({ isPaymentComplete: true, attemptCount: 3 })).toMatchObject({ success: true, attempts: 3 });
    expect(toResponse({ error: "e", failureCode: "NO_DUES" })).toMatchObject({ success: false, code: "NO_DUES", details: "e" });
    expect(toResponse(undefined)).toMatchObject({ success: false, attempts: 0 });
    expect(wantsStream({ stream_mode: ["values"] })).toBe(true);
    expect(wantsStream({ stream_mode: "updates" })).toBe(true);
    expect(wantsStream({})).toBe(false);
  });
});

describe("success heuristics", () => {
  it("detects success text except on pre-payment URLs", () => {
    expect(hasSuccessSignal("https://x/status", "Payment Successful")).toBe(true);
    expect(hasSuccessSignal("https://x/quick-pay", "payment successful")).toBe(false);
    expect(hasSuccessSignal("https://x/quick-pay/success", "payment successful")).toBe(true);
    expect(hasSuccessSignal("https://x", "bill details")).toBe(false);
  });
  it("finds failure phrases", () => {
    expect(findFailurePhrase("Sorry, Transaction Failed")).toBe("transaction failed");
    expect(findFailurePhrase("all good")).toBeNull();
  });
});
