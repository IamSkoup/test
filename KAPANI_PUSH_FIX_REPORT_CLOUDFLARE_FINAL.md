# Kapani Push Cloudflare Production Fix — 2026-09-10

Base: the user-provided deployed project archive.

## Canonical production path

EVENT
-> canonical notification record in RTDB
-> durable pushQueue job
-> Cloudflare Worker lease/retry
-> FCM HTTP v1
-> firebase-messaging-sw.js
-> system notification

The frontend performs an atomic multi-location RTDB write for notification + pushQueue job, then optionally wakes the Worker via /enqueue. Delivery does not depend on index.html remaining open.

## Changes

### cloudflare-worker/worker.js
- Added `/session` endpoint that validates the existing Kapani password hash and mints a Firebase custom auth token.
- Uses the Firebase custom-token JWT format and RS256 service-account signing.
- `/register`, `/unregister`, `/diagnostics`, `/preferences`, `/enqueue` remain protected by Firebase ID token.
- Fixed FCM token id generation to SHA-256 first 32 hex chars, matching frontend.
- Corrected CORS to allow Authorization and Content-Type and handle OPTIONS.
- `/enqueue`, `/push`, `/send` enqueue/wake the durable RTDB queue instead of creating a second direct sender.
- Added lease-based queue claiming with Firebase RTDB ETag/If-Match optimistic locking to reduce concurrent double claims.
- Added transient/permanent/permanent-payload FCM classification.
- Invalid/unregistered tokens are cleaned up; payload errors are not treated as invalid tokens.
- Retry uses exponential backoff + jitter.
- Added queue diagnostics.

### index.html
- Replaced Firebase Function `issueKapaniSessionToken` dependency with Cloudflare `/session`.
- Firebase `signInWithCustomToken()` establishes the protected Firebase session after normal Kapani login.
- FCM token registration stays behind authenticated Cloudflare `/register`.
- Notification creation writes notification + queue job atomically to RTDB.
- Immediate Worker wake is best-effort; scheduler remains authoritative.

### firebase-messaging-sw.js
- Bumped SW version.
- Background notifications remain data-only and are rendered by exactly one controlled `showNotification()` path.
- Notification URLs are normalized to `/kapani/`.

### functions/index.js
- Removed deployed push-sender exports `enqueueNotificationPush` and `processNotificationQueue` from the source to prevent duplicate FCM delivery.
- Notification fan-out functions continue to create canonical notification records; Cloudflare owns push delivery.

## Verification performed locally

- Worker JavaScript syntax: PASS
- Duplicate top-level function declarations in Worker: none
- Frontend push bridge points to Cloudflare Worker
- Service Worker scope and canonical URL logic reviewed
- FCM payload is data-only
- Queue claim uses ETag/If-Match conditional request, matching Firebase REST transaction guidance.

## Production checks still requiring user environment

- Actual `wrangler deploy`
- Worker secret presence
- Live Cloudflare Cron execution
- Live FCM acceptance by Google's endpoint
- Browser restart/closed-browser delivery on a real device
- iOS PWA delivery on physical iOS hardware

These cannot be truthfully marked as completed from the offline build environment.
