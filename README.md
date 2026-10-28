# Generic Payment Agent

A self-reasoning bill-payment agent (TypeScript, LangGraph, FreeTier orchestrator, Playwright).
You give it **minimal data**: website URL, account/mobile number, amount (if needed) and email.
It works out each screen by itself: what to fill, what to click, CAPTCHA, OTP, gateway, UPI QR, waiting and success.

```bash
npm install
cp .env.example .env   # fill in keys
npm run pay -- "Pay Jio postpaid bill at https://www.jio.com/selfcare/paybill/mobility for jio number 98XXXXXXXX, amount 10 rupees, email me@x.com"
npm start              # HTTP server on port 8123 (PORT env overrides): GET /health, POST /payment
                       # body: {"prompt": [...]} or {"paymentData": {...}, "targetUrl": "..."}
```

## How it works

```
START → start   extract + ground + validate data (fails fast: MISSING_DATA), open browser, load start page
      → agent   LLM picks ONE action from the current page snapshot
      → tools   run it, attach a fresh snapshot, detect success / fatal signals
      → … → cleanup (success email, close browser, delete screenshots) → END
```

- **One-pass page understanding** (`src/page-snapshot.ts`, `src/dom-scripts.ts`): a single DOM scan (main frame, iframes and shadow DOM) lists every input, button, radio, tab and dropdown with stable ids (`e12`), plus flags for captcha, OTP boxes, QR and open dialogs. Vision is called at most once per new URL, not once per field.
- **Batch filling from data keys**: `fill_fields` fills all of a page's fields in one call. The LLM maps each field to a payment-data key (`accountNumber`, `amount`, …), never to free text. A missing standard key fails the run with `MISSING_DATA`. Values longer than a field's `maxlength` are reported as `VALUE_TOO_LONG`.
- **Locator strategies** (`src/strategies/*`): the original agent's fill, click, payment-option, captcha and OTP strategies run first, in their original order. New strategies come after them: snapshot id, iframes, preceding text, tab/menuitem, exact text and vision coordinates.
- **Outcomes**: `success`, or `failed` with a code: `MISSING_DATA`, `NO_DUES`, `DATA_MISMATCH`, `OTP_FAILED`, `PAYMENT_FAILED`, `BLOCKED` or `OTHER`.

Push notifications (QR, OTP), Mailgun success email and success detection work the same as in the original agent.
