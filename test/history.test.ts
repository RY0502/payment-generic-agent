import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { actionSignature, compactSnapshot, formatHistory, matchToolName, messageParts, PAGE_MARKER, parseToolCall, repeatCount } from "../src/history.js";

const tools = ["fill_fields", "click", "get_otp"];

describe("history", () => {
  it("extracts message parts for strings, arrays and langchain messages", () => {
    expect(messageParts("hi")).toEqual({ role: "human", content: "hi" });
    expect(messageParts({ role: "user", content: ["a", { text: "b" }, {}] }).content).toBe("a\nb\n");
    expect(messageParts({ role: "x", content: { k: 1 } }).content).toBe('{"k":1}');
    expect(messageParts(new ToolMessage({ content: "r", tool_call_id: "1", name: "click" }))).toMatchObject({ role: "tool", name: "click" });
    expect(messageParts({}).role).toBe("unknown");
  });

  it("compacts snapshots keeping the URL", () => {
    expect(compactSnapshot(`OK${PAGE_MARKER}URL: http://x\nINPUT`)).toBe("OK\n(older page snapshot omitted; URL: http://x)");
    expect(compactSnapshot(`OK${PAGE_MARKER}nothing`)).toBe("OK\n(older page snapshot omitted)");
    expect(compactSnapshot("plain")).toBe("plain");
  });

  it("formats history keeping only latest snapshot and collapsing old messages", () => {
    const msgs = [
      new HumanMessage(`task${PAGE_MARKER}URL: a\nold`),
      new AIMessage({ content: "think", tool_calls: [{ id: "1", name: "click", args: { description: "Go" } }] }),
      new ToolMessage({ content: `done${PAGE_MARKER}URL: b\nnew`, tool_call_id: "1", name: "click" }),
      { role: "system", content: "sys" },
    ];
    const out = formatHistory(msgs);
    expect(out).toContain("(older page snapshot omitted; URL: a)");
    expect(out).toContain("URL: b\nnew");
    expect(out).toContain('ACTION: click({"description":"Go"})');
    expect(out).toContain("RESULT (click)");
    expect(out).toContain("SYSTEM: sys");
    const collapsed = formatHistory([new HumanMessage("first"), new HumanMessage("line1\nline2"), new HumanMessage("last")], 1, 1);
    expect(collapsed).toContain("USER: line1");
    expect(collapsed).not.toContain("line2");
    expect(formatHistory([new AIMessage("x"), new ToolMessage({ content: "y", tool_call_id: "1" })])).toContain("RESULT (tool)");
  });

  it("matches tool names loosely", () => {
    expect(matchToolName("Fill-Fields", tools)).toBe("fill_fields");
    expect(matchToolName("nope", tools)).toBeNull();
    expect(matchToolName(5, tools)).toBeNull();
  });

  it("parses tool calls in several shapes", () => {
    expect(parseToolCall('{"thought":"t","tool":"click","args":{"description":"Pay"}}', tools)).toEqual({ thought: "t", name: "click", args: { description: "Pay" } });
    expect(parseToolCall('[{"name":"get_otp","arguments":"{\\"a\\":1}"}]', tools)).toMatchObject({ name: "get_otp", args: { a: 1 } });
    expect(parseToolCall('{"tool_call":{"action":"click","action_input":{"x":1}},"reasoning":"r"}', tools)).toMatchObject({ thought: "r", args: { x: 1 } });
    expect(parseToolCall('{"tool":"click","args":[1]}', tools)?.args).toEqual({});
    expect(parseToolCall('{"tool":"click","args":"not json"}', tools)?.args).toEqual({});
    expect(parseToolCall('{"tool":"unknown"}', tools)).toBeNull();
    expect(parseToolCall("plain text", tools)).toBeNull();
    expect(parseToolCall("[]", tools)).toBeNull();
  });

  it("computes action signatures and repeat counts", () => {
    const sig = actionSignature("click", { description: "Pay" });
    expect(repeatCount([sig, "x", sig], sig)).toBe(2);
  });
});
