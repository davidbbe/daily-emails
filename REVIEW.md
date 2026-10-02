# Repository review — 2 October 2026

Reviewed the daily-run flow, source collectors, AI synthesis, delivery, storage,
markets rendering, configuration, dependencies, and project instructions.

## Fixed

- **Accidental delivery from HEAD requests.** Next.js auto-routed HEAD through
  GET. The endpoint now explicitly returns 405 without running the job.
- **Whole-job failures from one news feed or the core model.** News feeds fail
  independently. AI failures preserve source headlines/links; failed feeds are
  labeled unavailable, and person summaries require a valid source.
- **Unbounded delays.** Reddit has one 60-second collection deadline covering
  retries and waits. AI generation has 60-second deadlines. Analytics, billing
  discovery, usage probes, Google token requests, email delivery, and Blob I/O
  now have request deadlines.
- **Page visits performing expensive work and overwriting newer data.** The
  markets page reads its saved daily payload, following the requested behavior.
  Browser TradingView widgets still load their charts. Token URLs use no-referrer.
- **Misleading delivery state.** Missing email configuration fails before AI
  spending. Successful sends require an email ID; quota-cache failures cannot
  invalidate accepted delivery. History updates after delivery.
- **Identical email retries.** Resend requests use a payload-derived idempotency
  key, with the provider's [24-hour retention](https://resend.com/docs/dashboard/emails/idempotency-keys).
- **Wrong/incomplete billing totals.** Discovery selects the exact account's
  export and SQL filters the account. Paginated results fail explicitly instead
  of silently dropping charges.
- **Data calculations.** Traffic labels retain K/M/B magnitudes and decimals;
  a flat closing-price series produces neutral RSI rather than maximum greed.
- **Unnecessary social-feed pagination.** X collection stops once it has enough
  posts. Fallback news is identified correctly in the AI prompt.
- **Deprecated AI API.** All five structured calls use AI SDK 7's generateText
  and Output.object, preserving Gateway routing and the configured model.
- **Storage support.** BLOB_ACCESS supports private stores consistently for
  history, markets, and usage caches. Existing public stores keep working.
- **Documentation drift.** Corrected the homepage schedule to 09:00 UTC;
  expanded AGENTS.md, aligned CLAUDE.md, README, and the env template; documented
  the fifth AI call, actual snapshot behavior, safe checks, and storage privacy.
- **Dependency advisories.** Upgraded Next.js and eslint-config-next from
  16.2.10 to 16.3.8 and refreshed compatible vulnerable dependencies. The old
  version was in affected ranges for several advisories, including this
  [Next.js advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j).
  This app does not use every affected feature; the audit is a dependency scan,
  not evidence that the production application was exploited.

## Remaining improvements

1. **Migrate existing public storage if privacy is expected.** Page-token checks
   do not protect public Blob JSON directly. Connect a private store, set
   BLOB_ACCESS=private with its credentials, generate a fresh brief, and retire
   old public objects deliberately. Code support is ready; no hosted storage
   was changed during this review. See [Vercel's private-store guide](https://vercel.com/docs/vercel-blob/private-storage).
2. **Persist and lock daily runs.** Identical payloads are deduplicated, but
   two concurrent GETs can regenerate different briefs and send twice. A durable
   job record with a lease, pending payload, and sent status would support retries
   across instances without regenerating AI output or clobbering newer snapshots.
3. **GA4 freshness policy.** The zero-activity fallback can hide a real zero-traffic
   day by treating it as processing lag. Choose a fixed reporting delay or an
   explicit freshness policy before replacing that heuristic.
4. **Large BigQuery exports.** Fetch subsequent query pages and paginate dataset/
   table discovery when needed. For now, explicit GCP_BILLING_BQ_TABLE avoids
   discovery limits, and incomplete query results report an error.
5. **Quota freshness.** Resend cached counters are a last-send observation,
   potentially from a prior day/month. Include cache timestamps and expire
   counters when their reporting period resets.
6. **History feature.** Snapshots currently only set hasPreviousBrief. Implement
   comparisons if actual day-over-day news movers are wanted.

## Verification

Offline regression tests cover feed/model failures, all five structured calls,
traffic/RSI edge cases, Reddit deadlines, authorization and HEAD safety, email
idempotency and response validation, billing selection/truncation, and markets
rendering without provider calls or storage changes.

Final checks after the dependency updates:

- npm test: 18 passed.
- npm run typecheck: passed.
- npm run lint: passed.
- npm run build: passed on Next.js 16.3.8.
- npm dependency audit: zero reported vulnerabilities after compatible fixes.
- git diff --check: passed.

No live email was sent, AI generation was mocked in tests, and no deployment or
hosted-storage migration was performed.
