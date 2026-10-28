/**
 * LLM access layer: FreeTier orchestrators (text + vision) and robust JSON parsing helpers.
 */

import {
  FreeTierOrchestrator,
  createTextProviders,
  createVisionProviders,
  ErrorKind,
  type LlmInput,
  type Provider,
} from "@freetier/orchestrator";
import { intFromEnv } from "./config.js";

/** Minimal LLM contract used across the agent (lets tests inject a fake). */
export interface LlmClient {
  invoke(input: LlmInput): Promise<string>;
}

export const TEXT_PROVIDER_PRIORITY = ["Cloudflare", "Requesty", "Groq", "NVIDIA", "Cerebras", "HuggingFace", "SambaNova"];
export const VISION_PROVIDER_PRIORITY = ["Requesty", "Cloudflare", "NVIDIA", "Groq"];

/** Sorts providers by a preferred base-name priority list (unknown providers go last). */
export function sortProviders<T extends { name: string }>(providers: T[], priority: string[]): T[] {
  const rank = (p: T) => {
    const index = priority.indexOf(p.name.replace(/ #\d+$/, ""));
    return index === -1 ? priority.length : index;
  };
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

/**
 * Wraps a provider so authentication / permission errors (401/403, invalid key) switch to the next
 * provider (treated as Quota) instead of aborting the whole call.
 */
export function withAuthFailover<T extends Provider<LlmInput, string>>(provider: T): Provider<LlmInput, string> {
  return {
    name: provider.name,
    invoke: (input) => provider.invoke(input),
    getModelConfig: provider.getModelConfig?.bind(provider),
    classifyError: (error) => {
      const own = provider.classifyError?.(error);
      if (own !== undefined) return own;
      const message = String((error as Error)?.message ?? error);
      if (/empty response/i.test(message)) return ErrorKind.Retryable;
      return /\b(401|403)\b|authenticat|unauthori[sz]ed|invalid api key|forbidden/i.test(message) ? ErrorKind.Quota : undefined;
    },
  };
}

/** Creates an orchestrator over sorted, auth-failover-wrapped providers. */
function buildOrchestrator(providers: Provider<LlmInput, string>[], priority: string[]): LlmClient {
  return new FreeTierOrchestrator<LlmInput, string>(sortProviders(providers, priority).map(withAuthFailover), {
    cooldown: { cooldownMs: intFromEnv("LLM_COOLDOWN_MS", 30_000) },
    retry: { maxRetries: 2, retryDelayMs: intFromEnv("LLM_PROVIDER_RETRY_DELAY_MS", 5_000) },
  });
}

/** Builds the text-model orchestrator with failover across configured free-tier providers. */
export function buildTextLlm(): LlmClient {
  return buildOrchestrator(createTextProviders(), TEXT_PROVIDER_PRIORITY);
}

/** Builds the vision-model orchestrator with failover across configured free-tier providers. */
export function buildVisionLlm(): LlmClient {
  return buildOrchestrator(createVisionProviders(), VISION_PROVIDER_PRIORITY);
}

/** Removes <think> blocks emitted by reasoning models. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Finds the first balanced JSON object/array in arbitrary model output.
 * Handles markdown fences, leading prose and trailing text.
 */
export function extractJsonBlock(text: string): string | null {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : clean;
  const start = source.search(/[{[]/);
  if (start === -1) return null;
  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** Parses JSON, returning undefined on failure. */
function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Repairs common LLM JSON glitches (stray quote/bracket after the last brace, missing closing braces)
 * by trying prefixes that end at a "}" with up to 3 closing braces appended.
 */
export function repairJson<T = any>(text: string): T | null {
  const source = stripThinking(text);
  const start = source.indexOf("{");
  if (start === -1) return null;
  const ends: number[] = [];
  for (let i = source.length - 1; i > start && ends.length < 40; i--) if (source[i] === "}") ends.push(i);
  for (const end of ends) {
    for (let extra = 0; extra <= 3; extra++) {
      const parsed = tryParse<T>(source.slice(start, end + 1) + "}".repeat(extra));
      if (parsed !== undefined) return parsed;
    }
  }
  return null;
}

/** Parses the first JSON value found in model output; returns null when none parses. */
export function parseJsonLoose<T = any>(text: string): T | null {
  const block = extractJsonBlock(text);
  const parsed = block ? (tryParse<T>(block) ?? tryParse<T>(block.replace(/,\s*([}\]])/g, "$1"))) : undefined;
  return parsed ?? repairJson<T>(text);
}
