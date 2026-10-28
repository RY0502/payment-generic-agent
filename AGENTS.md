# AGENTS.md

## Commands (npm only, no pnpm)
- Install: `npm install` (postinstall applies `patches/` via patch-package and installs Chromium)
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Tests: `npm test`; with coverage: `npm run test:coverage` (vitest; browser tests use headless Chromium + local fixture pages, no external services)
- Live run: `npm run pay -- "<prompt>"` (set `AGENT_TRACE_FILE=trace.txt` to log every step's full page snapshot)
- Server: `npm start`

## Notes
- `@langchain/core` must satisfy `@langchain/langgraph-checkpoint` (>=1.1.48), otherwise `v6` import errors occur at startup.
- `createPaymentAgent` returns a derived object (`Object.create(graph)`); never mutate the compiled graph's `invoke`/`stream` (invoke calls stream internally).
- In-page scripts live in `src/dom-scripts.ts` as strings (avoids esbuild `__name` helpers leaking into `page.evaluate`).
- Free-tier LLM keys: Cloudflare/Groq 401 errors are treated as quota (failover); NVIDIA alone is slow and rate-limited, so avoid running several live flows in parallel.
- IGL (`webonline.igl.co.in:8077`) is blocked by corporate Zscaler unless the firewall is disabled.
