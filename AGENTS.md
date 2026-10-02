<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Daily Emails working guide

This is a Next.js App Router app that sends one daily digest through Vercel Cron,
AI Gateway, and Resend. See `README.md` for setup and `.env.example` for variables.

## Map

- `src/app/api/daily-brief/route.ts`: authorization and daily-run orchestration.
- `src/lib/research.ts`: parallel collection; individual feed failures are isolated.
- `src/lib/brief.ts`, `trends.ts`, `whale-brief.ts`, `valuation.ts`: structured AI output.
- `src/lib/email.ts`: Gmail HTML and plain-text rendering, then Resend delivery.
- `src/lib/history.ts`, `markets-brief.ts`, `usage.ts`: Blob persistence; local `.data/` fallback.
- `src/app/markets/[token]/page.tsx`: token-protected saved daily brief.
- `src/lib/config.ts`: watchlists, regions, sites, quotas, and model defaults.
- `vercel.json`: schedule source of truth (`0 9 * * *`, UTC).

## Runtime and checks

- Use Node.js 22 or later (AI SDK 7 requirement); Node.js 24 is the current local runtime.
- Read installed AI SDK docs/source before changing AI calls. Use AI Gateway and
  `generateText` with `Output.object`; keep deadlines and data-backed fallbacks.
- Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` after
  behavioral changes. Tests mock providers and do not send real email or spend credits.
- The build downloads Google fonts through `next/font/google` and needs network access.
- `scripts/send-test-email.ts`, `scripts/send-live-test-email.ts`, and authenticated
  GETs to `/api/daily-brief` send real mail and can modify shared Blob data. Use them
  only when a live send is part of the user's request; do not use them as routine checks.

## Behavior to preserve

- Cron GET requires `CRON_SECRET` in production. HEAD must never invoke delivery.
- Fetch optional sources with deadlines; an outage must not abort the entire digest
  or masquerade as a verified quiet day. Retain available source links.
- Markets page reads the saved daily brief. Do not add provider fetches, AI calls,
  or persistence writes to page rendering. TradingView widgets still load in the browser.
- Save history after confirmed delivery. Persistence and quota-cache failures are
  best-effort and must not turn an accepted email into a failed send.
- Serverless disk is ephemeral/read-only. Use Blob on Vercel; `.data/` is local only.
- `BLOB_ACCESS` must match the connected store. Public Blob JSON bypasses the page
  token; use a private store for private data. Never expose tokens or private keys.
- Emails are opened in Gmail. Keep table layouts, critical inline styles, escaped
  dynamic text, and plain text. See `.cursor/rules/gmail-email-design.mdc` for design rules.
- Keep market details on the hosted page and its CTA in the email.
- Update README and the env template when behavior or configuration changes.
