/**
 * Test helpers: a shared headless Chromium, in-process HTTP server for fixture pages, fake LLM/vision.
 */

import http from "http";
import type { AddressInfo } from "net";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserManager } from "../src/browser.js";
import type { LlmClient } from "../src/llm.js";
import { PaymentSession } from "../src/session.js";
import type { PaymentData } from "../src/types.js";
import { VisionAnalyzer } from "../src/vision.js";

let browser: Browser | null = null;

/** Launches (once) a headless Chromium. */
export async function getBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: true });
  return browser;
}

/** Closes the shared Chromium. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** New page with the given HTML body. */
export async function pageWith(html: string): Promise<Page> {
  const page = await (await getBrowser()).newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(`<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`);
  return page;
}

/** Fake LLM returning scripted responses (function or queue). */
export class FakeLlm implements LlmClient {
  calls: { system: string; prompt: string; imageBase64?: string }[] = [];
  constructor(private readonly responder: string[] | ((input: { system: string; prompt: string }) => string)) {}
  async invoke(input: { system: string; prompt: string; imageBase64?: string }): Promise<string> {
    this.calls.push(input);
    if (typeof this.responder === "function") return this.responder(input);
    const next = this.responder.shift();
    if (next === undefined) throw new Error("FakeLlm: no more responses");
    if (next.startsWith("THROW:")) throw new Error(next.slice(6));
    return next;
  }
}

/** Vision analyzer backed by a fake LLM. */
export function fakeVision(responder: ConstructorParameters<typeof FakeLlm>[0] = () => "{}"): { vision: VisionAnalyzer; llm: FakeLlm } {
  const llm = new FakeLlm(responder);
  return { vision: new VisionAnalyzer(llm), llm };
}

/** Builds a session around a fixture page. */
export function sessionFor(page: Page, data: PaymentData = {}, responder?: ConstructorParameters<typeof FakeLlm>[0], fetchFn?: typeof fetch) {
  const manager = new BrowserManager();
  manager.usePage(page);
  const { vision, llm } = fakeVision(responder);
  const session = new PaymentSession(manager, vision, data, { sleep: async () => {}, fetchFn });
  return { session, manager, vision, visionLlm: llm };
}

/** Starts an HTTP server serving `routes` (path -> html). Returns base URL and a close fn. */
export async function serve(routes: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const html = routes[path];
    res.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
    res.end(html ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** A fake fetch that records calls and returns queued responses. */
export function fakeFetch(responses: Array<{ status?: number; body: any }>) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses.length > 1 ? responses.shift()! : responses[0];
    const status = r.status ?? 200;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status });
  }) as typeof fetch;
  return { fn, calls };
}
