# Kapani Push — Cloudflare production architecture

Date: 2026-09-10

## Root cause confirmed

The live browser diagnostics showed a valid FCM token and active Service Worker, but `serverRegistered=false`, `serverTokenCount=0`, and the old Firebase Functions diagnostic endpoint returned `OPTIONS 404 / CORS Missing Allow Origin`. The project also uses a Cloudflare Worker as its intended push bridge.

The revised version therefore treats Cloudflare as the authoritative FCM sender instead of making Firebase Functions part of push delivery.

## Files changed

- `index.html`
- `cloudflare-worker/worker.js`
- `cloudflare-worker/wrangler.toml`
- `cloudflare-worker/SETUP.md`

## What changed

### Frontend

- FCM registration remains authenticated with Firebase ID token and Cloudflare `/register`.
- Push preferences use Cloudflare `/preferences`, not Firebase Functions.
- FCM registration waits for Firebase Auth restoration.
- Failed early Auth restoration causes bounded automatic retries.
- `pushNotification()` now writes the notification and durable Cloudflare queue job in one RTDB multi-location update.
- Worker enqueue is only a best-effort wake-up; failure there cannot delete the notification or queue job.
- Diagnostics verifies the exact local token ID exists on the server, not merely that some token exists.

### Cloudflare Worker

- `Authorization` and `Content-Type` are allowed by CORS.
- `/register`, `/unregister`, `/preferences`, `/diagnostics` are authenticated using Firebase ID token verification.
- `/enqueue`, `/push`, and `/send` enqueue a durable job instead of directly calling FCM.
- One-minute Cron invokes `scheduled()` and is the only FCM sender.
- Queue states: `pending`, `processing`, `retry`, `waiting_token`, `sent`, `skipped`, `dead`.
- Jobs have leases and are reclaimed when a lease expires.
- Retry uses exponential backoff plus jitter.
- Per-token delivery state prevents normal retries from resending tokens that already succeeded.
- FCM data-only payload is used, leaving display control to `firebase-messaging-sw.js`.
- Invalid/unregistered tokens are removed; retryable errors are retried; payload/configuration failures are not silently treated as success.
- Structured logging contains job ID, notification ID, nick, token ID, attempt, result and timestamp.
- Diagnostics exposes recent queue state for the authenticated user.
- Required service-account secret is declared in `wrangler.toml`.

## Canonical production pipeline

`EVENT`
→ `CANONICAL NOTIFICATION`
→ `DURABLE pushQueue JOB`
→ `CLOUDFLARE CRON + LEASE/RETRY`
→ `FCM HTTP v1`
→ `firebase-messaging-sw.js`
→ `SYSTEM NOTIFICATION`

## Validation performed on the edited source

- All inline JavaScript blocks in `index.html`: syntax check passed.
- `cloudflare-worker/worker.js`: Node syntax check passed.
- Existing Service Worker path/scope retained for `/kapani/`.
- Data-only FCM payload retained; Service Worker remains responsible for system notification display.
- No frontend `new Notification()` mechanism was introduced as a replacement for FCM.

## Production checks still requiring deployment/device access

The following cannot be truthfully marked as completed from this environment:

- Current Cloudflare Worker deployment/version.
- Presence of the production `FIREBASE_SERVICE_ACCOUNT_JSON` secret.
- Actual Cloudflare Cron invocation in the user's account.
- Real FCM delivery to a closed desktop browser.
- Browser restart delivery.
- Multiple-device delivery on two real browsers.
- iOS PWA delivery on a physical supported iPhone.

These are deployment/runtime/device tests, not source-code checks.
