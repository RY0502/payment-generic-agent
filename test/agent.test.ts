import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPaymentAgent, failure, firstUserText, invokeWithRetry, routeAfterAgent, signalToUpdate, type AgentDeps } from "../src/agent.js";
import { BrowserManager } from "../src/browser.js";
import { buildInitialState } from "../src/request.js";
import { closeBrowser, FakeLlm, fakeFetch, getBrowser, serve } from "./helpers.js";
import { VisionAnalyzer } from "../src/vision.js";

const QR = `<svg width="200" height="200">${Array.from({ length: 12 }, (_, i) => `<path d="M${i} 0h1v1h-1z"/>`).join("")}</svg>`;

/** Fake biller site: account -> OTP -> bill/amount -> gateway -> QR (auto-success after 300ms). */
const SITE: Record<string, string> = {
  "/": `<h1>Pay Bill</h1><input placeholder="Mobile Number" id="m"><button onclick="if(document.getElementById('m').value==='9899892558')location.href='/otp'">VERIFY WITH OTP</button>`,
  "/otp": `<div role="dialog"><p>Enter OTP</p>${[0, 1, 2, 3].map(() => '<input maxlength="1">').join("")}<button onclick="location.href='/bill'">LOGIN</button></div>`,
  "/bill": `<h2>Outstanding 10</h2><input placeholder="Amount" id="a"><button onclick="location.href='/gateway?amt='+document.getElementById('a').value">PAY BILL</button>`,
  "/gateway": `<label><input type="radio" name="g" id="bd"> BillDesk</label><button onclick="if(document.getElementById('bd').checked)location.href='/qr'">Pay Now</button>`,
  "/qr": `<div class="qr"><p>Scan QR</p>${QR}</div><script>setTimeout(()=>location.href='/done',300)</script>`,
  "/done": `<h1>Payment Successful</h1><p>Transaction reference number TX1</p>`,
  "/nodues": `<h1>Bill details</h1><p>Payable amount 0.00. No dues.</p>`,
  "/confirm": `<input placeholder="Advance Payment" id="adv" onchange="if(confirm('No amount is due, do you still want to make a payment'))document.getElementById('pg').style.display='block'">
    <div id="pg" style="display:none"><h3>Payment Gateway</h3><div style="height:0"><input type="radio" name="x_paymentGateWay" title="Bill Desk" style="opacity:0;width:18px;height:13px"></div>
    <button onclick="location.href='/done'">Pay Now</button></div>`,
};

const PROMPT = "Pay Airtel postpaid at {URL}/ for mobile number 9899892558, amount 10 rs, email ravi_yadav0502@yahoo.in";

let site: { url: string; close: () => Promise<void> };
let emails: string[] = [];

beforeAll(async () => {
  site = await serve(SITE);
  process.env.OTP_NOTIFICATION_URL = "https://n/otp";
  process.env.OTP_LOOKUP_URL = "https://n/lookup";
  process.env.SUPABASE_ANON_KEY = "k";
  process.env.OTP_POLL_MS = "1";
  process.env.PAYMENT_POLL_MS = "200";
  process.env.PAYMENT_WAIT_MS = "5000";
  process.env.LLM_RETRY_DELAY_MS = "1";
});
afterAll(async () => {
  await site.close();
  await closeBrowser();
});
afterEach(() => (emails = []));

/** Builds deps around a fresh page from the shared Chromium. */
function deps(agentLlm: FakeLlm, visionReply: (p: { prompt: string }) => string = () => '{"isSuccess":true,"confidence":0.95,"pageType":"form","summary":"page"}'): AgentDeps {
  return {
    createBrowser: async () => {
      const manager = new BrowserManager();
      manager.usePage(await (await getBrowser()).newPage());
      return manager;
    },
    createVision: () => new VisionAnalyzer(new FakeLlm(visionReply)),
    createTextLlm: () => agentLlm,
    sendSuccessEmail: async (state) => void emails.push(state.paymentData.email!),
    sessionOptions: { sleep: async () => {}, fetchFn: fakeFetch([{ body: {} }, { body: { code: "1234" } }]).fn },
  };
}

/** Scripted agent replies (extraction reply first). */
const reply = (tool: string, args: object) => JSON.stringify({ thought: `do ${tool}`, tool, args });

describe("payment agent graph", () => {
  it("completes a multi-page payment end to end and sends the success email", async () => {
    const llm = new FakeLlm([
      JSON.stringify({ targetUrl: `${site.url}/`, accountNumber: "9899892558", mobileNumber: "9899892558", amount: "10", email: "ravi_yadav0502@yahoo.in" }),
      "I am not sure",
      reply("fill_fields", { fields: [{ description: "Mobile Number", dataKey: "mobileNumber" }] }),
      reply("click", { description: "VERIFY WITH OTP" }),
      reply("get_otp", {}),
      reply("fill_fields", { fields: [{ description: "Amount", dataKey: "amount" }] }),
      reply("click", { description: "PAY BILL" }),
      reply("select_option", { optionName: "BillDesk" }),
      reply("click", { description: "Pay Now" }),
      reply("scan_upi_qr_code", {}),
      reply("wait_for_payment", { after: "qr_scan" }),
    ]);
    const agent = createPaymentAgent(deps(llm));
    const result = await agent.invoke(buildInitialState({ prompt: PROMPT.replace("{URL}", site.url) }));
    expect(result.error).toBe("");
    expect(result.isPaymentComplete).toBe(true);
    expect(result.status).toBe("success");
    expect(result.paymentData).toMatchObject({ amount: "10", mobileNumber: "9899892558" });
    expect(emails).toEqual(["ravi_yadav0502@yahoo.in"]);
    expect(String(result.messages[result.messages.length - 1].content)).toContain("PAYMENT SUCCESS");
    const prompts = llm.calls.slice(2).map((c) => c.prompt).join("\n");
    expect(prompts).toContain("older page snapshot omitted");
  });

  it("fails fast with MISSING_DATA when required data is missing from the prompt", async () => {
    const agent = createPaymentAgent(deps(new FakeLlm(["{}"])));
    const result = await agent.invoke(buildInitialState({ prompt: "pay my electricity bill" }));
    expect(result).toMatchObject({ status: "failed", failureCode: "MISSING_DATA" });
    expect(result.error).toContain("website URL");
  });

  it("fails with MISSING_DATA when a page needs data the user did not give", async () => {
    const llm = new FakeLlm([reply("fill_fields", { fields: [{ description: "Amount", dataKey: "amount" }] })]);
    const agent = createPaymentAgent(deps(llm));
    const result = await agent.invoke(buildInitialState({ paymentData: { accountNumber: "9899892558" }, targetUrl: `${site.url}/bill` }));
    expect(result).toMatchObject({ status: "failed", failureCode: "MISSING_DATA" });
    expect(result.error).toContain("amount");
  });

  it("stops with NO_DUES via fail_payment and detects stuck loops / step limits / bad models", async () => {
    const noDues = await createPaymentAgent(deps(new FakeLlm([reply("fail_payment", { code: "NO_DUES", reason: "payable 0.00" })]))).invoke(
      buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` })
    );
    expect(noDues).toMatchObject({ failureCode: "NO_DUES", error: "payable 0.00" });

    const loop = Array.from({ length: 6 }, () => reply("click", { description: "Nothing here" }));
    const stuck = await createPaymentAgent(deps(new FakeLlm(loop))).invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }));
    expect(stuck.error).toContain("stuck repeating");

    const limited = await createPaymentAgent(deps(new FakeLlm([reply("wait", { seconds: 1 }), reply("unknown_tool_x", {}), reply("wait", { seconds: 2 })]))).invoke({
      ...buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }),
      maxAttempts: 1,
    });
    expect(limited.error).toContain("Max steps");

    const babble = await createPaymentAgent(deps(new FakeLlm(["hmm", "still thinking", "no idea"]))).invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }));
    expect(babble.error).toContain("valid tool call");

    const down = await createPaymentAgent(deps(new FakeLlm(["THROW:a", "THROW:b", "THROW:c", "THROW:d"]))).invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }));
    expect(down.error).toBe("LLM providers unavailable");
  });

  it("surfaces native dialogs opened mid-action, blocks other tools until handled, then follows the gateway suggestion", async () => {
    const llm = new FakeLlm([
      reply("fill_fields", { fields: [{ description: "Advance Payment", dataKey: "amount" }] }),
      reply("click", { description: "Pay Now" }),
      reply("handle_dialog", { action: "accept" }),
      reply("select_option", { optionName: "Bill Desk" }),
      reply("click", { description: "Pay Now" }),
    ]);
    const agent = createPaymentAgent(deps(llm));
    const result = await agent.invoke(buildInitialState({ paymentData: { accountNumber: "1", amount: "10" }, targetUrl: `${site.url}/confirm` }));
    const prompts = llm.calls.map((c) => c.prompt);
    expect(prompts[1]).toContain('NATIVE DIALOG OPENED during fill_fields: "No amount is due, do you still want to make a payment"');
    expect(prompts[2]).toContain("ERROR: a native browser dialog is open");
    expect(prompts[3]).toMatch(/SUGGESTED NEXT ACTION: select_option\(\{"elementId":"e\d+","optionName":"Bill Desk"\}\)/);
    expect(prompts[4]).toContain('Payment gateway "Bill Desk" is selected: click the Pay Now');
    expect(result.isPaymentComplete).toBe(true);
  });

  it("detects success automatically after an action and handles unreachable sites", async () => {
    const auto = await createPaymentAgent(deps(new FakeLlm([reply("wait", { seconds: 1 })]))).invoke(buildInitialState({ paymentData: { accountNumber: "1", email: "a@b.c" }, targetUrl: `${site.url}/done` }));
    expect(auto.isPaymentComplete).toBe(true);

    const unreachable = await createPaymentAgent(deps(new FakeLlm([]))).invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: "http://127.0.0.1:1/" }));
    expect(unreachable).toMatchObject({ failureCode: "BLOCKED" });
  });

  it("times out long flows and streams graph updates", async () => {
    process.env.PAYMENT_TIMEOUT_MS = "1";
    const slow = await createPaymentAgent(deps(new FakeLlm([reply("wait", { seconds: 1 })]))).invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }));
    expect(slow.error).toContain("timeout");
    delete process.env.PAYMENT_TIMEOUT_MS;

    const agent = createPaymentAgent(deps(new FakeLlm([reply("fail_payment", { code: "OTHER", reason: "x" })])));
    const chunks: any[] = [];
    for await (const chunk of await agent.stream(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }), { streamMode: "values" })) chunks.push(chunk);
    expect(chunks[chunks.length - 1].status).toBe("failed");
  });

  it("rejects concurrent runs and releases the browser when the graph throws", async () => {
    const agent = createPaymentAgent(deps(new FakeLlm([reply("fail_payment", { code: "OTHER", reason: "x" })])));
    const first = agent.invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }));
    await expect(agent.invoke(buildInitialState({ prompt: "x" }))).rejects.toThrow("already in progress");
    await first;
    await expect(agent.invoke(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }), { recursionLimit: 1 })).rejects.toThrow();
    const gen = agent.stream(buildInitialState({ paymentData: { accountNumber: "1" }, targetUrl: `${site.url}/nodues` }), { recursionLimit: 1 });
    await expect((async () => {
      for await (const _ of await gen) void _;
    })()).rejects.toThrow();
  });
});

describe("agent helpers", () => {
  it("maps signals, failures, routes and first user text", () => {
    expect(signalToUpdate(null)).toEqual({});
    expect(signalToUpdate({ type: "success", confirmation: "ok" })).toMatchObject({ status: "success", isPaymentComplete: true });
    expect(signalToUpdate({ type: "fatal", code: "NO_DUES", reason: "r" })).toEqual(failure("NO_DUES", "r"));
    expect(firstUserText([new AIMessage("a"), new HumanMessage("user text")])).toBe("user text");
    expect(firstUserText([])).toBe("");
    const base: any = { status: "running", messages: [new AIMessage({ content: "", tool_calls: [{ id: "1", name: "click", args: {} }] })] };
    expect(routeAfterAgent(base)).toBe("tools");
    expect(routeAfterAgent({ ...base, messages: [new HumanMessage("nudge")] })).toBe("agent");
    expect(routeAfterAgent({ ...base, status: "failed" })).toBe("cleanup");
  });

  it("retries LLM calls with backoff", async () => {
    expect(await invokeWithRetry(new FakeLlm(["THROW:x", "ok"]), "s", "p", 3, 1)).toBe("ok");
    expect(await invokeWithRetry(new FakeLlm(["THROW:x"]), "s", "p", 1, 1)).toBeNull();
  });
});
