/**
 * HTTP server: GET /health, POST /payment (JSON or SSE streaming). Same API as the original agent.
 */

import "dotenv/config";
import http from "http";
import { agent } from "./agent.js";
import { BadRequestError, buildInitialState, toResponse, wantsStream } from "./request.js";

const PORT = Number(process.env.PORT) || 8123;
const HOST = process.env.HOST || "0.0.0.0";

/** Writes a JSON response. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

/** Health payload. */
function health() {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "Generic Payment Agent",
    version: "1.0.0",
    features: {
      emailNotifications: !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN),
      pushNotifications: !!(process.env.PAYMENT_NOTIFICATION_URL && process.env.SUPABASE_ANON_KEY),
      otp: !!(process.env.OTP_NOTIFICATION_URL && process.env.OTP_LOOKUP_URL),
    },
  };
}

/** Streams graph chunks as server-sent events. */
async function streamRun(res: http.ServerResponse, state: any): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  try {
    for await (const chunk of await agent.stream(state, { streamMode: "values" })) res.write(`event: data\ndata: ${JSON.stringify(chunk)}\n\n`);
    res.write("event: end\ndata: {}\n\n");
  } catch (error: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: error?.message ?? String(error) })}\n\n`);
  }
  res.end();
}

/** Handles POST /payment. Logs the same success / failure banners as the original agent. */
async function handlePayment(body: any, res: http.ServerResponse): Promise<void> {
  const state = buildInitialState(body);
  console.log("\n📥 Received payment request");
  console.log("\n⏳ Processing payment...\n");
  if (wantsStream(body)) return streamRun(res, state);
  const response = toResponse(await agent.invoke(state));
  console.log(response.success ? "\n✅ Payment Successful!" : "\n❌ Payment Failed");
  sendJson(res, 200, response);
}

/** Reads the full request body. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return void res.writeHead(200).end();
  if (req.url === "/health" && req.method === "GET") return sendJson(res, 200, health());
  if (req.url !== "/payment" || req.method !== "POST") return sendJson(res, 404, { error: "Not found", availableEndpoints: { health: "GET /health", payment: "POST /payment" } });
  try {
    await handlePayment(JSON.parse((await readBody(req)) || "{}"), res);
  } catch (error: any) {
    if (res.headersSent) return void res.end();
    const status = error instanceof BadRequestError || error instanceof SyntaxError ? 400 : 500;
    sendJson(res, status, { error: status === 400 ? "Bad request" : "Internal server error", message: error?.message ?? String(error) });
  }
});

server.listen(PORT, HOST, () => console.log(`🚀 Generic Payment Agent on http://${HOST}:${PORT}  (GET /health, POST /payment)`));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
