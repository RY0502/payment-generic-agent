/**
 * Page snapshot: discovers ALL interactive elements of the current page (main frame + iframes,
 * incl. shadow DOM) in a single DOM pass, and renders a compact text view for the LLM.
 */

import type { Frame, Locator, Page } from "playwright";
import { QR_EXTRACT_SCRIPT, SNAPSHOT_SCRIPT } from "./dom-scripts.js";
import { analysePaymentOptions, formatPaymentOptions } from "./payment-options.js";
import type { PageSnapshot, SnapshotElement } from "./types.js";

const FIELD_KINDS = new Set(["input", "textarea", "select"]);
const CHOICE_KINDS = new Set(["radio", "checkbox", "tab", "option"]);

/** Runs the snapshot script in one frame; returns null for detached / cross-origin-blocked frames. */
async function snapshotFrame(frame: Frame, startIndex: number, frameIndex: number): Promise<any | null> {
  try {
    const snap: any = await frame.evaluate(`(${SNAPSHOT_SCRIPT})(${JSON.stringify({ startIndex, frameIndex })})`);
    if (!snap.hasQrCode) snap.hasQrCode = !!(await frame.evaluate(`(${QR_EXTRACT_SCRIPT})()`).catch(() => null));
    return snap;
  } catch {
    return null;
  }
}

/** Takes a full snapshot of the page across all frames. */
export async function takeSnapshot(page: Page): Promise<PageSnapshot> {
  const frames = page.frames();
  const main = await snapshotFrame(page.mainFrame(), 0, 0);
  if (!main) throw new Error("Could not read page DOM");
  let next = main.nextIndex as number;
  const snapshot: PageSnapshot = { ...main, elements: [...main.elements] };
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === page.mainFrame()) continue;
    const sub = await snapshotFrame(frame, next, i);
    if (!sub || sub.elements.length === 0) continue;
    next = sub.nextIndex;
    snapshot.elements.push(...sub.elements);
    snapshot.hasCaptcha ||= sub.hasCaptcha;
    snapshot.hasOtpInputs ||= sub.hasOtpInputs;
    snapshot.otpBoxCount = Math.max(snapshot.otpBoxCount, sub.otpBoxCount);
    snapshot.hasQrCode ||= sub.hasQrCode;
  }
  delete (snapshot as any).nextIndex;
  return snapshot;
}

/** Returns a locator for a snapshot element id (searches every frame). */
export async function locateRef(page: Page, id: string): Promise<Locator | null> {
  const selector = `[data-pa-id="${id.replace(/[^a-zA-Z0-9_-]/g, "")}"]`;
  for (const frame of page.frames()) {
    const locator = frame.locator(selector);
    if ((await locator.count().catch(() => 0)) > 0) return locator.first();
  }
  return null;
}

/** Ranks elements so that dialog content, fields and primary actions survive truncation. */
export function rankElement(el: SnapshotElement): number {
  let score = 0;
  if (el.inDialog) score += 100;
  if (FIELD_KINDS.has(el.kind)) score += 50;
  if (CHOICE_KINDS.has(el.kind)) score += 30;
  if (el.kind === "button") score += 25;
  if (el.kind === "link") score += 5;
  if (/pay|proceed|continue|submit|next|verify|login|get details|fetch|qr|upi|confirm|ok/i.test(el.label)) score += 10;
  if (el.disabled) score -= 5;
  if (el.inChrome) score -= 60;
  if (el.inSidebar) score -= 40;
  return score;
}

/** Drops navigation links living in header/footer/nav (rarely part of a payment flow). */
export function isNoise(el: SnapshotElement): boolean {
  return !!el.inChrome && (el.kind === "link" || el.kind === "button") && !/pay|bill|login|accept|close|ok|continue|proceed/i.test(el.label);
}

/** Renders a single element line, e.g. `[e3] input type=tel "Mobile Number" value="" required`. */
export function formatElement(el: SnapshotElement): string {
  const parts = [`[${el.id}]`, el.kind];
  if (el.type && FIELD_KINDS.has(el.kind) && el.type !== el.kind) parts.push(`type=${el.type}`);
  parts.push(JSON.stringify(el.label || el.placeholder || el.name || el.domId || ""));
  if (el.placeholder && el.placeholder !== el.label) parts.push(`placeholder=${JSON.stringify(el.placeholder)}`);
  if (el.name && FIELD_KINDS.has(el.kind)) parts.push(`name=${el.name}`);
  if (FIELD_KINDS.has(el.kind)) parts.push(`value=${JSON.stringify(el.value || "")}`);
  if (el.maxLength && el.maxLength < 40) parts.push(`maxlength=${el.maxLength}`);
  if (el.options?.length) parts.push(`options=${JSON.stringify(el.options)}`);
  if (el.checked !== undefined) parts.push(el.checked ? "(selected)" : "(not selected)");
  if (el.required) parts.push("required");
  if (el.disabled) parts.push("(disabled)");
  if (el.inDialog) parts.push("[in dialog]");
  if (el.inSidebar) parts.push("[sidebar widget - ignore]");
  if (el.frame > 0) parts.push(`[iframe ${el.frame}]`);
  return parts.join(" ");
}

/** Removes duplicate (same kind + label) non-field elements, keeping the first occurrence. */
export function dedupeElements(elements: SnapshotElement[]): SnapshotElement[] {
  const seen = new Set<string>();
  return elements.filter((el) => {
    if (FIELD_KINDS.has(el.kind)) return true;
    const key = `${el.kind}|${el.label.toLowerCase()}|${el.inDialog ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Produces the compact, LLM-friendly text view of a snapshot (incl. detected payment options + suggested next action). */
export function formatSnapshot(snapshot: PageSnapshot, maxElements: number, textChars = 1200, preferredGateway?: string): string {
  const unique = dedupeElements(snapshot.elements.filter((e) => !isNoise(e)));
  const kept = [...unique].sort((a, b) => rankElement(b) - rankElement(a)).slice(0, maxElements);
  const keptIds = new Set(kept.map((e) => e.id));
  const ordered = unique.filter((e) => keptIds.has(e.id));
  const fields = ordered.filter((e) => FIELD_KINDS.has(e.kind));
  const actions = ordered.filter((e) => !FIELD_KINDS.has(e.kind));
  const flags = [
    `captcha=${snapshot.hasCaptcha ? "YES" : "no"}`,
    `otp_inputs=${snapshot.hasOtpInputs ? `YES (${snapshot.otpBoxCount} boxes)` : "no"}`,
    `qr_code_visible=${snapshot.hasQrCode ? "YES" : "no"}`,
  ];
  const lines = [`URL: ${snapshot.url}`, `TITLE: ${snapshot.title}`];
  if (snapshot.headings.length) lines.push(`HEADINGS: ${snapshot.headings.join(" | ")}`);
  if (snapshot.hasDialog) lines.push(`OPEN DIALOG/POPUP: ${snapshot.dialogText || "(no text)"}`);
  lines.push(`FLAGS: ${flags.join(", ")}`);
  const options = formatPaymentOptions(analysePaymentOptions(snapshot, preferredGateway));
  if (options) lines.push(options);
  lines.push(`INPUT FIELDS (${fields.length}):`, ...(fields.length ? fields.map(formatElement) : ["(none)"]));
  lines.push(`CLICKABLE ELEMENTS (${actions.length}${unique.length > kept.length ? `, ${unique.length - kept.length} low-priority omitted` : ""}):`);
  lines.push(...(actions.length ? actions.map(formatElement) : ["(none)"]));
  lines.push(`VISIBLE TEXT: ${snapshot.text.substring(0, textChars)}`);
  return lines.join("\n");
}
