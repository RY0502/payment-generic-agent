/**
 * Conversation history formatting (with snapshot compaction) and model response parsing.
 */

import { parseJsonLoose, stripThinking } from "./llm.js";

/** Marker separating a tool result from the page snapshot appended to it. */
export const PAGE_MARKER = "\n=== CURRENT PAGE ===\n";

export interface ParsedToolCall {
  thought: string;
  name: string;
  args: Record<string, unknown>;
}

/** Returns a LangChain-ish message's role + text content. */
export function messageParts(msg: any): { role: string; content: string; name?: string; toolCalls?: any[] } {
  if (typeof msg === "string") return { role: "human", content: msg };
  const role = typeof msg?._getType === "function" ? msg._getType() : msg?.role || msg?.type || "unknown";
  const raw = msg?.content;
  const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : JSON.stringify(raw ?? "");
  return { role, content, name: msg?.name, toolCalls: msg?.tool_calls };
}

/** Replaces the page snapshot part of a message with a short placeholder. */
export function compactSnapshot(content: string): string {
  const index = content.indexOf(PAGE_MARKER);
  if (index === -1) return content;
  const urlLine = content.slice(index + PAGE_MARKER.length).split("\n").find((l) => l.startsWith("URL:"));
  return `${content.slice(0, index)}\n(older page snapshot omitted${urlLine ? `; ${urlLine}` : ""})`;
}

/**
 * Serialises history for the prompt. Only the latest `keepSnapshots` page snapshots are kept in full;
 * messages older than `maxMessages` are collapsed to one line each.
 */
export function formatHistory(messages: any[], keepSnapshots = 1, maxMessages = 30): string {
  const parts = messages.map(messageParts);
  const snapshotIdx = parts.map((p, i) => (p.content.includes(PAGE_MARKER) ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(snapshotIdx.slice(-keepSnapshots));
  const firstFull = Math.max(0, parts.length - maxMessages);
  return parts
    .map((p, i) => {
      const body = keep.has(i) ? p.content : compactSnapshot(p.content);
      const text = i < firstFull && i > 0 ? body.split("\n")[0].substring(0, 160) : body;
      if (p.role === "ai") {
        const calls = (p.toolCalls ?? []).map((c: any) => `ACTION: ${c.name}(${JSON.stringify(c.args ?? {})})`).join("\n");
        return `ASSISTANT: ${text}${calls ? `\n${calls}` : ""}`;
      }
      if (p.role === "tool") return `RESULT (${p.name ?? "tool"}): ${text}`;
      return `${p.role === "human" ? "USER" : p.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");
}

/** Resolves a tool name loosely (case, dashes, spaces). */
export function matchToolName(name: unknown, toolNames: string[]): string | null {
  if (typeof name !== "string") return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return toolNames.find((t) => norm(t) === norm(name)) ?? null;
}

/** Parses the model's JSON reply into a single tool call (null when absent/invalid). */
export function parseToolCall(text: string, toolNames: string[]): ParsedToolCall | null {
  let parsed: any = parseJsonLoose(text);
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== "object") return null;
  const call = parsed.tool_call ?? parsed.toolCall ?? parsed;
  const name = matchToolName(call.tool ?? call.name ?? call.tool_name ?? call.action, toolNames);
  if (!name) return null;
  let args = call.args ?? call.arguments ?? call.parameters ?? call.action_input ?? call.input ?? {};
  if (typeof args === "string") args = parseJsonLoose(args) ?? {};
  return {
    thought: String(parsed.thought ?? parsed.reasoning ?? stripThinking(text).substring(0, 200)),
    name,
    args: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
  };
}

/** Stable signature of an action, used for loop detection. */
export function actionSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

/** Counts occurrences of `signature` in the recent action list. */
export function repeatCount(recent: string[], signature: string): number {
  return recent.filter((s) => s === signature).length;
}
