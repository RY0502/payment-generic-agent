import { describe, expect, it, vi } from "vitest";

vi.mock("@freetier/orchestrator", () => ({
  ErrorKind: { Retryable: "retryable", Quota: "quota", Fatal: "fatal" },
  FreeTierOrchestrator: class {
    constructor(readonly providers: any[]) {}
    async invoke() {
      return "ok";
    }
  },
  createTextProviders: () => [{ name: "Groq" }, { name: "Cloudflare #2" }, { name: "Unknown" }],
  createVisionProviders: () => [{ name: "Groq" }, { name: "Requesty" }],
}));

const llm = await import("../src/llm.js");

describe("llm helpers", () => {
  it("sorts providers by priority, unknown last, ignoring #n suffix", () => {
    const sorted = llm.sortProviders([{ name: "Unknown" }, { name: "Groq" }, { name: "Cloudflare #2" }], llm.TEXT_PROVIDER_PRIORITY);
    expect(sorted.map((p) => p.name)).toEqual(["Cloudflare #2", "Groq", "Unknown"]);
  });

  it("builds text and vision orchestrators in priority order", async () => {
    const text: any = llm.buildTextLlm();
    expect(text.providers.map((p: any) => p.name)).toEqual(["Cloudflare #2", "Groq", "Unknown"]);
    const vision: any = llm.buildVisionLlm();
    expect(vision.providers.map((p: any) => p.name)).toEqual(["Requesty", "Groq"]);
    expect(await text.invoke({ system: "", prompt: "" })).toBe("ok");
  });

  it("wraps providers so auth errors fail over and empty responses retry", async () => {
    const base = { name: "P", invoke: async () => "r" };
    const wrapped = llm.withAuthFailover(base as any);
    expect(await wrapped.invoke({ system: "", prompt: "" })).toBe("r");
    expect(wrapped.classifyError!(new Error("Cloudflare API error (401): Authentication error"))).toBe("quota");
    expect(wrapped.classifyError!(new Error("returned an empty response"))).toBe("retryable");
    expect(wrapped.classifyError!(new Error("boom"))).toBeUndefined();
    const custom = llm.withAuthFailover({ ...base, classifyError: () => "fatal" } as any);
    expect(custom.classifyError!("401")).toBe("fatal");
  });

  it("strips think blocks", () => {
    expect(llm.stripThinking("<think>hmm</think> answer")).toBe("answer");
  });

  it("extracts balanced JSON from prose, fences and nested strings", () => {
    expect(llm.extractJsonBlock('Sure! {"a":{"b":"}"}} trailing')).toBe('{"a":{"b":"}"}}');
    expect(llm.extractJsonBlock('```json\n[1,2]\n```')).toBe("[1,2]");
    expect(llm.extractJsonBlock('{"s":"a\\"b"}')).toBe('{"s":"a\\"b"}');
    expect(llm.extractJsonBlock("no json")).toBeNull();
    expect(llm.extractJsonBlock("{unterminated")).toBeNull();
  });

  it("parses loose JSON including trailing commas", () => {
    expect(llm.parseJsonLoose('{"a":1,}')).toEqual({ a: 1 });
    expect(llm.parseJsonLoose("{bad json}")).toBeNull();
    expect(llm.parseJsonLoose('{"tool":"fill_fields","args":{"fields":[{"dataKey":"amount"}]}"}')).toEqual({ tool: "fill_fields", args: { fields: [{ dataKey: "amount" }] } });
    expect(llm.parseJsonLoose('{"tool":"x","args":{"fields":[{"a":1}]}]')).toEqual({ tool: "x", args: { fields: [{ a: 1 }] } });
    expect(llm.repairJson("no braces")).toBeNull();
    expect(llm.parseJsonLoose("nothing")).toBeNull();
  });
});
