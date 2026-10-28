/**
 * CLI runner: `npm run pay -- "<prompt>"` or `npm run pay -- --file prompt.json`
 * (JSON file may contain {"prompt": [...]} or {"paymentData": {...}, "targetUrl": "..."}).
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { agent } from "./agent.js";
import { buildInitialState, toResponse } from "./request.js";

/** Builds the request body from CLI arguments. */
export function bodyFromArgs(args: string[]): any {
  const fileIndex = args.indexOf("--file");
  if (fileIndex !== -1) return JSON.parse(readFileSync(args[fileIndex + 1], "utf8"));
  const prompt = args.join(" ").trim();
  if (!prompt) throw new Error('Usage: npm run pay -- "<payment prompt>"  |  npm run pay -- --file request.json');
  return { prompt };
}

const result = await agent.invoke(buildInitialState(bodyFromArgs(process.argv.slice(2))));
const response = toResponse(result);
console.log("\nRESULT:", JSON.stringify(response, null, 2));
process.exit(response.success ? 0 : 1);
