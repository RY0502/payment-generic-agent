/**
 * Generic Payment Agent graph (LangGraph).
 *
 *   START -> start (extract + validate data, open browser, load start page)
 *         -> agent (LLM decides ONE action from the current page snapshot)
 *         -> tools (execute, attach fresh snapshot, detect success/fatal signals) -> agent ...
 *         -> cleanup (email on success, close browser, delete screenshots) -> END
 */

import "dotenv/config";
import { appendFileSync } from "fs";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { BrowserManager } from "./browser.js";
import { CONFIG } from "./config.js";
import { EmailService } from "./email-service.js";
import { extractPaymentRequest, MissingDataError, validateRequest } from "./extraction.js";
import { actionSignature, formatHistory, messageParts, PAGE_MARKER, parseToolCall, repeatCount } from "./history.js";
import { buildTextLlm, type LlmClient } from "./llm.js";
import { compactData } from "./payment-data.js";
import { buildSystemPrompt, NO_TOOL_NUDGE } from "./prompts.js";
import { PaymentSession, type FailureCode, type SessionOptions, type SessionSignal } from "./session.js";
import { confirmPaymentSuccess, hasSuccessSignal } from "./success.js";
import { ACTION_TOOLS, createAllTools, formatToolDocs } from "./tools/index.js";
import { errorText } from "./tools/browser-tools.js";
import type { PaymentData, RunStatus } from "./types.js";
import { VisionAnalyzer } from "./vision.js";

const keep = <T>(fallback: () => T) => Annotation<T>({ reducer: (left: T, right: T) => (right === undefined ? left : right), default: fallback });

export const PaymentState = Annotation.Root({
  messages: Annotation<any[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  paymentData: keep<PaymentData>(() => ({})),
  targetUrl: keep<string>(() => ""),
  status: keep<RunStatus>(() => "running"),
  isPaymentComplete: keep<boolean>(() => false),
  confirmationDetails: keep<string>(() => ""),
  error: keep<string>(() => ""),
  failureCode: keep<string>(() => ""),
  attemptCount: keep<number>(() => 0),
  maxAttempts: keep<number>(() => CONFIG.maxSteps),
  nudges: keep<number>(() => 0),
  recentActions: keep<string[]>(() => []),
  startedAt: keep<number>(() => 0),
});

export type PaymentStateType = typeof PaymentState.State;
type Update = Partial<PaymentStateType>;

export interface AgentDeps {
  createBrowser: () => Promise<BrowserManager>;
  createVision: () => VisionAnalyzer;
  createTextLlm: () => LlmClient;
  sendSuccessEmail?: (state: PaymentStateType, screenshotPath: string) => Promise<void>;
  sessionOptions?: SessionOptions;
}

interface Runtime {
  llm: LlmClient;
  session: PaymentSession | null;
  tools: StructuredToolInterface[];
}

/** Builds a failure state update. */
export function failure(code: FailureCode, reason: string): Update {
  return { status: "failed", error: reason, failureCode: code, isPaymentComplete: false };
}

/** Converts a session signal into a state update. */
export function signalToUpdate(signal: SessionSignal | null): Update {
  if (!signal) return {};
  return signal.type === "success" ? { status: "success", isPaymentComplete: true, confirmationDetails: signal.confirmation } : failure(signal.code, signal.reason);
}

/** First human message text (the user's prompt). */
export function firstUserText(messages: any[]): string {
  const human = messages.map(messageParts).find((m) => m.role === "human" || m.role === "user");
  return human?.content ?? "";
}

/** True when the caller supplied structured payment data instead of a free-form prompt. */
function hasStructuredData(state: PaymentStateType): boolean {
  return !!state.targetUrl && Object.values(state.paymentData || {}).some((v) => !!v);
}

/** Calls the LLM with exponential backoff (free-tier providers are often briefly saturated); null when all attempts fail. */
export async function invokeWithRetry(llm: LlmClient, system: string, prompt: string, attempts = CONFIG.llmAttempts, baseDelayMs = CONFIG.llmRetryDelayMs): Promise<string | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await llm.invoke({ system, prompt });
    } catch (error) {
      console.error(`LLM call failed (attempt ${i}/${attempts}):`, String(error).substring(0, 300));
      if (i < attempts) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (i - 1)));
    }
  }
  return null;
}

/** Tools that may run while a native dialog is open. */
const DIALOG_SAFE_TOOLS = new Set(["handle_dialog", "fail_payment", "wait"]);

/** Appends the full step observation to AGENT_TRACE_FILE (debugging aid; disabled when unset). */
export function traceStep(step: number, call: { name: string; args: unknown }, result: string): void {
  const file = process.env.AGENT_TRACE_FILE;
  if (file) appendFileSync(file, `\n##### STEP ${step}: ${call.name}(${JSON.stringify(call.args)})\n${result}\n`);
}

/** Default success email (Mailgun) - same behaviour as the original agent. */
async function defaultSuccessEmail(state: PaymentStateType, screenshotPath: string): Promise<void> {
  if (!screenshotPath) return console.log("⚠ No screenshot available for email");
  const websiteName = new URL(state.targetUrl).hostname.replace("www.", "");
  const result = await new EmailService().sendPaymentSuccessEmail(websiteName, screenshotPath, state.paymentData, state.paymentData.email);
  console.log(result.success ? "✓ Payment success email sent successfully" : `⚠ Email notification skipped: ${result.message}`);
}

/** Creates the compiled payment graph with injectable dependencies. */
export function createPaymentGraph(deps: AgentDeps) {
  const runtime: Runtime = { llm: deps.createTextLlm(), session: null, tools: [] };

  /** Extracts + validates data, launches the browser and opens the start page. */
  async function startNode(state: PaymentStateType): Promise<Update> {
    let request;
    try {
      request = hasStructuredData(state)
        ? validateRequest({ targetUrl: state.targetUrl, paymentData: compactData(state.paymentData) })
        : await extractPaymentRequest(firstUserText(state.messages), runtime.llm);
    } catch (error) {
      return failure(error instanceof MissingDataError ? "MISSING_DATA" : "OTHER", String((error as Error).message ?? error));
    }
    console.log("💳 Payment data:", JSON.stringify(request.paymentData), "→", request.targetUrl);
    try {
      const browser = await deps.createBrowser();
      runtime.session = new PaymentSession(browser, deps.createVision(), request.paymentData, deps.sessionOptions);
      runtime.tools = createAllTools(runtime.session);
      await browser.navigate(request.targetUrl);
      const page = await runtime.session.describePage("auto");
      const intro = `Pay the bill on ${request.targetUrl} with the PAYMENT DATA. The start page is open.${PAGE_MARKER}${page}`;
      return { ...request, startedAt: Date.now(), status: "running", messages: [new HumanMessage(intro)] };
    } catch (error) {
      return { ...request, ...failure("BLOCKED", `Could not open ${request.targetUrl}: ${error}`) };
    }
  }

  /** Asks the LLM for the next single action. */
  async function agentNode(state: PaymentStateType): Promise<Update> {
    const step = state.attemptCount + 1;
    const system = buildSystemPrompt({ paymentData: state.paymentData, targetUrl: state.targetUrl, step, maxSteps: state.maxAttempts, toolDocs: formatToolDocs(runtime.tools) });
    const prompt = `${formatHistory(state.messages)}\n\nDecide the next action for the CURRENT PAGE. Reply with ONE JSON object.`;
    const text = await invokeWithRetry(runtime.llm, system, prompt);
    if (text === null) return failure("OTHER", "LLM providers unavailable");
    console.log(`🤖 Step ${step}: ${text.substring(0, 400)}`);
    const call = parseToolCall(text, runtime.tools.map((t) => t.name));
    if (!call) {
      if (state.nudges >= 2) return failure("OTHER", "Model did not produce a valid tool call");
      return { nudges: state.nudges + 1, messages: [new AIMessage(text.substring(0, 300)), new HumanMessage(NO_TOOL_NUDGE)] };
    }
    const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return { nudges: 0, messages: [new AIMessage({ content: call.thought, tool_calls: [{ id, name: call.name, args: call.args, type: "tool_call" }] })] };
  }

  /** Runs one tool, attaches the new page view and translates signals into state. */
  async function toolsNode(state: PaymentStateType): Promise<Update> {
    const session = runtime.session!;
    const call = (state.messages[state.messages.length - 1] as AIMessage).tool_calls![0];
    const step = state.attemptCount + 1;
    if (Date.now() - state.startedAt > CONFIG.paymentTimeoutMs) return { attemptCount: step, ...failure("BLOCKED", `Payment flow timeout: ${Math.round(CONFIG.paymentTimeoutMs / 60000)} minutes exceeded`) };
    const signature = actionSignature(call.name, call.args);
    const repeats = repeatCount(state.recentActions, signature) + 1;
    if (repeats >= 5) return { attemptCount: step, ...failure("BLOCKED", `Agent stuck repeating ${call.name} without progress`) };
    console.log(`🔧 ${call.name}(${JSON.stringify(call.args)})`);
    let result = await runTool(call.name, call.args);
    let signal = session.takeSignal();
    if (!signal && ACTION_TOOLS.has(call.name)) {
      if (!session.browser.hasDialog()) signal = await quickSuccessCheck(session);
      if (!signal) result += `${PAGE_MARKER}${await session.describePage("auto").catch((e) => errorText("snapshot failed", e))}`;
    }
    if (repeats >= 3) result += `\nWARNING: you already tried this exact action ${repeats} times. Try a different approach.`;
    console.log(`📋 ${result.split(PAGE_MARKER)[0].substring(0, 300)}`);
    traceStep(step, call, result);
    const update: Update = { attemptCount: step, recentActions: [...state.recentActions, signature].slice(-8), ...signalToUpdate(signal) };
    if (!signal && step >= state.maxAttempts) Object.assign(update, failure("BLOCKED", `Max steps (${state.maxAttempts}) reached`));
    return { ...update, messages: [new ToolMessage({ content: result, tool_call_id: call.id ?? "", name: call.name })] };
  }

  /**
   * Invokes a tool by name, converting exceptions/validation errors to text. Native browser dialogs
   * (alert/confirm) block page actions, so the call returns as soon as one opens and asks for handle_dialog.
   */
  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = runtime.tools.find((t) => t.name === name);
    if (!tool) return `ERROR: unknown tool ${name}`;
    const browser = runtime.session!.browser;
    if (browser.hasDialog() && !DIALOG_SAFE_TOOLS.has(name)) {
      return `ERROR: a native browser dialog is open ("${browser.getDialogMessage()}"). Call handle_dialog first.`;
    }
    const invocation = tool.invoke(args).then(String, (error) => errorText(`invalid call to ${name}`, error));
    const next = browser.nextDialog();
    const dialog = next.promise.then((message) => `NATIVE DIALOG OPENED during ${name}: "${message}". The page is waiting for it - call handle_dialog ("accept" to confirm/OK, "dismiss" to cancel).`);
    try {
      return await Promise.race([invocation, dialog]);
    } finally {
      next.cancel();
    }
  }

  /** Cheap success heuristic after actions; vision confirms only when keywords match. */
  async function quickSuccessCheck(session: PaymentSession): Promise<SessionSignal | null> {
    const url = await session.browser.getCurrentUrl();
    const text = await session.browser.getPageText().catch(() => "");
    if (!hasSuccessSignal(url, text)) return null;
    const result = await confirmPaymentSuccess(session.browser, session.vision).catch(() => null);
    return result?.success ? { type: "success", confirmation: result.text.substring(0, 500) } : null;
  }

  /** Sends the success email, closes the browser, deletes screenshots and appends a summary. */
  async function cleanupNode(state: PaymentStateType): Promise<Update> {
    const session = runtime.session;
    const success = state.status === "success";
    if (success && session) {
      await (deps.sendSuccessEmail ?? defaultSuccessEmail)(state, session.browser.getLastScreenshotPath()).catch((e) => console.error("Email failed:", e));
    }
    if (session) {
      await session.browser.cleanupScreenshots().catch(() => {});
      await session.browser.close().catch(() => {});
    }
    runtime.session = null;
    runtime.tools = [];
    const summary = success
      ? { status: "success", paymentData: state.paymentData }
      : { status: "failed", reason: state.error || "Max attempts reached", attemptCount: state.attemptCount, maxAttempts: state.maxAttempts };
    if (success) {
      console.log(`\n=== PAYMENT SUCCESS ===\n${JSON.stringify(summary, null, 2)}\n======================\n`);
    } else {
      console.log(`\n=== PAYMENT FAILED ===\nReason: ${summary.reason}\nAttempts: ${state.attemptCount}/${state.maxAttempts}\n======================\n`);
    }
    return { status: success ? "success" : "failed", messages: [new AIMessage(`${success ? "🎉 PAYMENT SUCCESS" : "❌ PAYMENT FAILED"}\n${JSON.stringify(summary, null, 2)}`)] };
  }

  const graph = new StateGraph(PaymentState)
    .addNode("start", startNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("cleanup", cleanupNode)
    .addEdge(START, "start")
    .addConditionalEdges("start", (s) => (s.status === "running" ? "agent" : "cleanup"), ["agent", "cleanup"])
    .addConditionalEdges("agent", (s) => routeAfterAgent(s), ["tools", "agent", "cleanup"])
    .addConditionalEdges("tools", (s) => (s.status === "running" ? "agent" : "cleanup"), ["agent", "cleanup"])
    .addEdge("cleanup", END)
    .compile();

  return { graph, runtime };
}

/** Routes after the agent node: execute a tool, retry after a nudge, or stop. */
export function routeAfterAgent(state: PaymentStateType): "tools" | "agent" | "cleanup" {
  if (state.status !== "running") return "cleanup";
  const last = state.messages[state.messages.length - 1];
  return last instanceof AIMessage && last.tool_calls?.length ? "tools" : "agent";
}

/** Wraps the graph so each run is isolated, uses a default recursion limit and always releases the browser. */
export function createPaymentAgent(deps: AgentDeps) {
  const { graph, runtime } = createPaymentGraph(deps);
  const originalInvoke = graph.invoke.bind(graph);
  const originalStream = graph.stream.bind(graph);
  let running = false;

  const begin = () => {
    if (running) throw new Error("A payment run is already in progress");
    running = true;
  };
  const emergencyClose = async () => {
    await runtime.session?.browser.close().catch(() => {});
    runtime.session = null;
  };
  const config = (c?: any) => ({ recursionLimit: CONFIG.recursionLimit, ...c });

  const invoke = async (input: any, c?: any) => {
    begin();
    try {
      return await originalInvoke(input, config(c));
    } catch (error) {
      await emergencyClose();
      throw error;
    } finally {
      running = false;
    }
  };

  const stream = async function* (input: any, c?: any) {
    begin();
    try {
      for await (const chunk of await originalStream(input, config(c))) yield chunk;
    } catch (error) {
      await emergencyClose();
      throw error;
    } finally {
      running = false;
    }
  };

  // Derived object: the original graph keeps its own invoke/stream (invoke internally calls this.stream).
  return Object.assign(Object.create(graph), { invoke, stream }) as typeof graph;
}

/** Production dependencies. */
export const defaultDeps: AgentDeps = {
  createBrowser: async () => {
    const browser = new BrowserManager();
    await browser.initialize();
    return browser;
  },
  createVision: () => new VisionAnalyzer(),
  createTextLlm: buildTextLlm,
};

/** Lazily created production agent (exported for LangGraph CLI / server). */
export const agent = createPaymentAgent(defaultDeps);
