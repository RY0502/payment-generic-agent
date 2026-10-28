/**
 * Converts incoming request bodies (prompt / message / LangGraph input / structured) into initial graph state,
 * and graph results into API responses.
 */

import { HumanMessage } from "@langchain/core/messages";
import { CONFIG } from "./config.js";
import type { PaymentData } from "./types.js";

export class BadRequestError extends Error {}

/** Joins prompt arrays/strings and LangGraph-style message lists into one text. */
export function promptText(body: any): string | null {
  if (body?.input?.messages) return body.input.messages.map((m: any) => (typeof m === "string" ? m : Array.isArray(m.content) ? m.content.join("\n") : m.content)).join("\n");
  const prompt = body?.prompt ?? body?.message;
  if (prompt === undefined || prompt === null) return null;
  return Array.isArray(prompt) ? prompt.join("\n") : String(prompt);
}

/** Builds the initial graph state for either request format. */
export function buildInitialState(body: any) {
  const text = promptText(body);
  const base = { maxAttempts: CONFIG.maxSteps, attemptCount: 0, status: "running" as const };
  if (text !== null) {
    if (!text.trim()) throw new BadRequestError("Prompt is empty");
    return { ...base, messages: [new HumanMessage(text)], paymentData: {} as PaymentData, targetUrl: "" };
  }
  if (!body?.paymentData || !body?.targetUrl) {
    throw new BadRequestError("Provide either 'prompt' (natural language) or both 'paymentData' and 'targetUrl' (structured)");
  }
  return {
    ...base,
    messages: [new HumanMessage(`Pay the bill on ${body.targetUrl} using the provided payment data.`)],
    paymentData: body.paymentData as PaymentData,
    targetUrl: String(body.targetUrl),
  };
}

/** Maps the final graph state to the public API response. */
export function toResponse(result: any) {
  return result?.isPaymentComplete
    ? { success: true, details: result.confirmationDetails || "Payment completed successfully", attempts: result.attemptCount, paymentData: result.paymentData }
    : { success: false, code: result?.failureCode || "OTHER", details: result?.error || "Payment failed", attempts: result?.attemptCount ?? 0, paymentData: result?.paymentData };
}

/** True if the client asked for SSE streaming. */
export function wantsStream(body: any): boolean {
  const modes: string[] = Array.isArray(body?.stream_mode) ? body.stream_mode : [body?.stream_mode].filter(Boolean);
  return modes.includes("values") || modes.includes("updates");
}
