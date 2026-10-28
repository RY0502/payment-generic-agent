/**
 * In-page JavaScript executed via Playwright `evaluate`.
 * Kept as plain strings so bundler helpers (e.g. esbuild `__name`) never leak into the page context.
 */

/**
 * Scans the document (incl. open shadow roots) in ONE pass and returns every visible interactive
 * element, tagging each with a `data-pa-id` attribute. Argument: { startIndex, frameIndex }.
 */
export const SNAPSHOT_SCRIPT = String.raw`(args) => {
  const startIndex = args.startIndex || 0;
  const frameIndex = args.frameIndex || 0;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const short = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity || '1') > 0.05;
  };
  const all = [];
  const walk = (root) => {
    const nodes = root.querySelectorAll('*');
    for (const n of nodes) { all.push(n); if (n.shadowRoot) walk(n.shadowRoot); }
  };
  walk(document);

  document.querySelectorAll('[data-pa-id]').forEach((n) => n.removeAttribute('data-pa-id'));
  all.forEach((n) => n.removeAttribute && n.removeAttribute('data-pa-id'));

  const dialogSel = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal.show,.modal.in,.modal[style*="block"],dialog[open]';
  const dialogs = all.filter((n) => n.matches && n.matches(dialogSel) && isVisible(n));
  const inDialog = (el) => dialogs.some((d) => d.contains(el) || (el.getRootNode && d.contains(el.getRootNode().host)));

  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.innerText : ''; }).join(' '); if (clean(t)) return t; }
    if (el.id) { try { const l = (el.getRootNode() || document).querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return l.innerText; } catch (e) {} }
    const wrap = el.closest && el.closest('label');
    if (wrap && clean(wrap.innerText)) return wrap.innerText;
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    let p = el.parentElement;
    for (let depth = 0; p && depth < 3; depth++, p = p.parentElement) {
      const txt = clean(p.innerText);
      if (txt && txt.length < 80) return txt;
    }
    return el.getAttribute('name') || el.id || '';
  };
  const textOf = (el) => clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || (el.querySelector && el.querySelector('img') ? el.querySelector('img').getAttribute('alt') : '') || '');

  const interactiveSel = 'input,textarea,select,button,a,[role="button"],[role="tab"],[role="radio"],[role="checkbox"],[role="option"],[role="link"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"])';
  const seen = new Set();
  const out = [];
  let idx = startIndex;
  const chromeSel = 'header,footer,nav,[role="navigation"],[role="contentinfo"],[role="banner"],[class*="footer" i],[id*="footer" i]';
  const inChrome = (el) => !!(el.closest && el.closest(chromeSel));
  const add = (el, data) => {
    if (seen.has(el)) return;
    seen.add(el);
    const id = 'e' + (idx++);
    el.setAttribute('data-pa-id', id);
    const dlg = inDialog(el);
    out.push(Object.assign({ id, frame: frameIndex, tag: el.tagName.toLowerCase(), inDialog: dlg || undefined, inChrome: (!dlg && inChrome(el)) || undefined }, data));
  };

  for (const el of all) {
    if (!el.matches) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
      if (type === 'hidden') continue;
      const isChoice = type === 'radio' || type === 'checkbox';
      const target = isChoice && !isVisible(el) ? (el.closest('label') || el.parentElement) : el;
      if (!isVisible(target)) continue;
      if (type === 'submit' || type === 'button' || type === 'image') {
        add(el, { kind: 'button', label: short(el.value || labelFor(el), 60), type });
        continue;
      }
      const ml = parseInt(el.getAttribute('maxlength') || '0', 10);
      const data = {
        kind: isChoice ? type : (tag === 'input' ? 'input' : tag),
        label: short(isChoice ? (labelFor(el) || el.value) : labelFor(el), 70),
        type, name: el.getAttribute('name') || undefined, domId: el.id || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        value: isChoice ? undefined : short(el.value, 40) || undefined,
        checked: isChoice ? !!el.checked : undefined,
        disabled: el.disabled || el.readOnly || undefined,
        required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
        maxLength: ml > 0 ? ml : undefined,
      };
      if (tag === 'select') data.options = Array.from(el.options).map((o) => short(o.text, 40)).filter(Boolean).slice(0, 25);
      add(el, data);
      continue;
    }
    if (!isVisible(el)) continue;
    const role = (el.getAttribute('role') || '').toLowerCase();
    let kind = null;
    if (el.matches(interactiveSel)) {
      if (tag === 'button' || role === 'button' || role === 'menuitem') kind = 'button';
      else if (role === 'tab') kind = 'tab';
      else if (role === 'radio') kind = 'radio';
      else if (role === 'checkbox') kind = 'checkbox';
      else if (role === 'option') kind = 'option';
      else if (tag === 'a' || role === 'link') kind = 'link';
      else kind = 'button';
    } else {
      const st = getComputedStyle(el);
      if (st.cursor !== 'pointer') continue;
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
      if (el.querySelector('input,button,a,select,textarea')) continue;
      kind = 'button';
    }
    if (el.closest('li') && el.closest('ul.tabs, [role="tablist"], .nav-tabs')) kind = 'tab';
    const text = textOf(el);
    if (!text && !el.id) continue;
    if (text.length > 120) continue;
    add(el, { kind, label: short(text || el.id, 60), domId: el.id || undefined, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      checked: (kind === 'radio' || kind === 'checkbox' || kind === 'tab') ? (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') || undefined) : undefined });
  }

  const visibleInputs = out.filter((e) => e.kind === 'input');
  const attrs = (e) => ((e.name || '') + ' ' + (e.domId || '') + ' ' + (e.placeholder || '') + ' ' + e.label).toLowerCase();
  const otpBoxes = visibleInputs.filter((e) => e.maxLength === 1).length;
  const hasOtpInputs = otpBoxes >= 4 || visibleInputs.some((e) => /otp|one.time/.test(attrs(e))) || !!document.querySelector('input[autocomplete="one-time-code"]');
  const captchaRe = /captcha/i;
  const hasCaptcha = visibleInputs.some((e) => captchaRe.test(attrs(e)) || /security code|enter.*(text|code).*(image|shown)/.test(attrs(e))) ||
    all.some((n) => (n.tagName === 'IMG' || n.tagName === 'CANVAS') && isVisible(n) && captchaRe.test((n.getAttribute('src') || '') + (n.getAttribute('alt') || '') + n.id + (typeof n.className === 'string' ? n.className : ''))) ||
    all.some((n) => n.tagName === 'IFRAME' && isVisible(n) && /recaptcha|hcaptcha|turnstile/i.test(n.getAttribute('src') || ''));
  const hasQrCode = all.some((n) => {
    if (!isVisible(n)) return false;
    const r = n.getBoundingClientRect();
    if (r.width < 100 || r.height < 100 || Math.abs(r.width - r.height) > 60) return false;
    const ctx = ((n.parentElement && n.parentElement.innerText) || '') + ' ' + (n.getAttribute('alt') || '') + ' ' + (n.getAttribute('src') || '') + ' ' + (typeof n.className === 'string' ? n.className : '');
    if (n.tagName === 'IMG') return /qr|scan|upi|paydigi/i.test(ctx);
    if (n.tagName === 'CANVAS') return /qr|scan|upi/i.test(ctx);
    if (n.tagName === 'svg' || n.tagName === 'SVG') return /qr|scan/i.test(ctx) && n.querySelectorAll('path,rect').length > 0;
    return false;
  });
  const headings = all.filter((n) => /^H[1-3]$/.test(n.tagName) && isVisible(n)).map((n) => short(n.innerText, 80)).filter(Boolean).slice(0, 8);
  const dialogText = dialogs.length ? short(dialogs[dialogs.length - 1].innerText, 400) : undefined;
  const body = document.body ? document.body.innerText : '';
  return { url: location.href, title: document.title, headings, text: short(body, 2500), elements: out, nextIndex: idx,
    hasCaptcha, hasOtpInputs, otpBoxCount: otpBoxes, hasQrCode, hasDialog: dialogs.length > 0, dialogText };
}`;

/**
 * Extracts a QR code from the page as an image URL or data URL (SVG, IMG or CANVAS). Returns null if none.
 * Logic carried over from the original agent's scan_upi_qr_code tool.
 */
export const QR_EXTRACT_SCRIPT = String.raw`() => {
  const svgs = Array.from(document.querySelectorAll('svg'));
  for (const svg of svgs) {
    const w = parseInt(svg.getAttribute('width') || svg.clientWidth, 10);
    const h = parseInt(svg.getAttribute('height') || svg.clientHeight, 10);
    if (w < 100 || h < 100) continue;
    const parentText = ((svg.parentElement && svg.parentElement.textContent) || '').toLowerCase();
    const parentClass = String((svg.parentElement && svg.parentElement.className) || '').toLowerCase();
    const hasContext = parentText.includes('qr') || parentText.includes('scan') || parentClass.includes('qr');
    const paths = svg.querySelectorAll('path');
    let complex = false;
    for (const p of Array.from(paths)) { if (((p.getAttribute('d') || '').match(/M/g) || []).length > 20) { complex = true; break; } }
    if (hasContext && (paths.length > 10 || (paths.length >= 1 && complex) || svg.querySelectorAll('rect').length > 20)) {
      try { return 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(svg)); } catch (e) {}
    }
  }
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = (img.src || '').toLowerCase();
    const alt = (img.alt || '').toLowerCase();
    const cls = String(img.className || '').toLowerCase();
    if (src.includes('icon') || src.endsWith('.svg')) continue;
    if (cls.includes('icon') || cls.includes('logo')) continue;
    if ((img.naturalWidth || img.width) < 100 || (img.naturalHeight || img.height) < 100) continue;
    const testId = (img.getAttribute('data-testid') || '').toLowerCase();
    const parentCls = String((img.parentElement && img.parentElement.className) || '').toLowerCase();
    if (testId.includes('qr') || alt.includes('qr') || src.includes('/qr') || src.includes('qr-code') || src.includes('qrcode') || src.includes('paydigi') || cls.includes('qr') || parentCls.includes('qr') || src.startsWith('data:image')) {
      return img.src;
    }
  }
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    const w = c.width || c.clientWidth, h = c.height || c.clientHeight;
    if (w < 100 || h < 100 || Math.abs(w - h) > 50) continue;
    try { const d = c.toDataURL('image/png'); if (d && d.length > 100) return d; } catch (e) {}
  }
  return null;
}`;

/** Clicks an element (or its nearest clickable ancestor) using a full mouse event sequence. */
export const DISPATCH_CLICK_SCRIPT = String.raw`(el) => {
  let cur = el;
  while (cur && cur !== document.body) {
    const st = getComputedStyle(cur);
    if (cur.tagName === 'BUTTON' || cur.tagName === 'A' || st.cursor === 'pointer' || cur.onclick) break;
    cur = cur.parentElement;
  }
  const target = cur && cur !== document.body ? cur : el;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  const r = target.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => target.dispatchEvent(new MouseEvent(t, o)));
  return true;
}`;

/** Sets a value on an input using the native setter so React/Angular/Vue pick it up. */
export const NATIVE_SET_VALUE_SCRIPT = String.raw`(el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.focus();
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return el.value;
}`;
