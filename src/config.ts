/**
 * Centralised runtime configuration (all values overridable via environment variables).
 */

/** Reads a positive integer env var, falling back to the provided default. */
export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONFIG = {
  /** Maximum number of agent reasoning steps (each step = one tool call). */
  get maxSteps(): number {
    return intFromEnv("MAX_AGENT_STEPS", 60);
  },
  /** Overall timeout for the whole payment flow. */
  get paymentTimeoutMs(): number {
    return intFromEnv("PAYMENT_TIMEOUT_MS", 20 * 60 * 1000);
  },
  /** How long wait_for_payment waits for the user to complete the payment. */
  get paymentWaitMs(): number {
    return intFromEnv("PAYMENT_WAIT_MS", 5 * 60 * 1000);
  },
  /** Polling interval used by wait_for_payment. */
  get paymentPollMs(): number {
    return intFromEnv("PAYMENT_POLL_MS", 30 * 1000);
  },
  /** OTP polling settings. */
  get otpPollMs(): number {
    return intFromEnv("OTP_POLL_MS", 30 * 1000);
  },
  get otpTotalWaitMs(): number {
    return intFromEnv("OTP_TOTAL_WAIT_MS", 5 * 60 * 1000);
  },
  /** Max number of elements included in a page snapshot sent to the LLM. */
  get snapshotMaxElements(): number {
    return intFromEnv("SNAPSHOT_MAX_ELEMENTS", 60);
  },
  /** Attempts + base backoff delay for each agent LLM call. */
  get llmAttempts(): number {
    return intFromEnv("LLM_ATTEMPTS", 5);
  },
  get llmRetryDelayMs(): number {
    return intFromEnv("LLM_RETRY_DELAY_MS", 5000);
  },
  /** LangGraph recursion limit. */
  get recursionLimit(): number {
    return intFromEnv("RECURSION_LIMIT", 250);
  },
  get headless(): boolean {
    return process.env.NODE_ENV === "production" || process.env.HEADLESS === "true";
  },
  get isVercel(): boolean {
    return process.env.VERCEL === "1";
  },
};
