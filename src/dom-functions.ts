/**
 * Element-level in-page functions, passed to Playwright `locator.evaluate(fn, arg)` as real functions
 * (Playwright only invokes *functions* with the element; a string is merely evaluated as an expression).
 * Keep these free of inner named functions so bundler helpers (esbuild `__name`) never leak into the page.
 */

/** Selection state of a radio / checkbox / tab-like element: true / false, or null when it exposes no state. */
export function selectionStateInPage(el: Element): boolean | null {
  const node = el as HTMLInputElement;
  if (node.type === "radio" || node.type === "checkbox") return !!node.checked;
  const aria = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected");
  if (aria !== null) return aria === "true";
  const inner = el.querySelector('input[type="radio"],input[type="checkbox"]') as HTMLInputElement | null;
  if (inner) return inner.checked;
  if (el.classList.contains("active") || el.classList.contains("selected")) return true;
  return null;
}

/** Sets a value with the native setter (so React/Angular/Vue notice) and fires input/change/blur. */
export function nativeSetValueInPage(el: Element, value: string): string {
  const input = el as HTMLInputElement;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  return input.value;
}

/** Clicks the element (or its nearest clickable ancestor) with a full pointer/mouse event sequence. */
export function dispatchClickInPage(el: Element): boolean {
  let cur: HTMLElement | null = el as HTMLElement;
  while (cur && cur !== document.body) {
    if (cur.tagName === "BUTTON" || cur.tagName === "A" || getComputedStyle(cur).cursor === "pointer" || cur.onclick) break;
    cur = cur.parentElement;
  }
  const target = cur && cur !== document.body ? cur : (el as HTMLElement);
  target.scrollIntoView({ block: "center", inline: "center" });
  const r = target.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => target.dispatchEvent(new MouseEvent(type, opts)));
  return true;
}
