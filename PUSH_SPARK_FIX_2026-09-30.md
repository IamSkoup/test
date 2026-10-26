# Kapani Push — Cloudflare Worker + Firebase Spark fix (2026-09-30)

## Target architecture

`Kapani → Cloudflare Worker (push-worker/) → Web Push/VAPID → browser Push Service → firebase-messaging-sw.js`

Firebase remains the RTDB/Auth data layer. Firebase Cloud Functions are not part of push delivery.

## What was fixed

1. Replaced the mismatched VAPID public key in `config.js` and `push-worker/wrangler.toml` with one newly generated P-256 public key. A matching private key is supplied separately and must be stored only as the Cloudflare `VAPID_PRIVATE_KEY` secret.
2. Added `POST /notify` to the Worker. It authenticates the current Kapani account using the existing nick + passwordHash model, creates the protected `users/<nick>/notifications/<id>` record and durable `pushOutbox/<jobId>` entry in one server-side RTDB patch, then attempts immediate Web Push delivery.
3. Removed the push-time Firebase Functions fallbacks from registration, unregistration, preferences and notification creation. With the configured Worker URL, push is Cloudflare-only.
4. Kept the existing direct Web Push implementation (VAPID + `aes128gcm`) and Service Worker closed-tab `push` handler.
5. Bumped the frontend/Service Worker build identifiers so a fresh deployment replaces stale client code.
6. Marked the old `cloudflare-worker/` FCM bridge documentation as legacy rather than the active push backend.
7. Removed the stale credential/package artifacts `push-worker/sa-new.json` and `push-worker/push-worker.zip` from the deliverable.

## Validation performed locally

- `config.js` syntax: OK
- `push-worker/worker.js` syntax: OK
- `firebase-messaging-sw.js` syntax: OK
- all inline `<script>` blocks in `index.html`: OK
- new VAPID public/private pair: 65-byte public key + 32-byte private scalar; ECDSA signature verification: OK
- public key in `config.js` exactly matches `VAPID_PUBLIC_KEY` in `push-worker/wrangler.toml`

## Required deployment steps

1. In `push-worker/`, set the Firebase service-account JSON as Cloudflare secret `FIREBASE_SERVICE_ACCOUNT_JSON`.
2. Set the supplied VAPID private key as Cloudflare secret `VAPID_PRIVATE_KEY`.
3. Deploy `push-worker/` with Wrangler.
4. Publish `index.html`, `config.js` and `firebase-messaging-sw.js` to GitHub Pages.
5. On each browser with an old VAPID subscription, open Kapani once with notification permission already granted; the frontend detects the old applicationServerKey, unsubscribes it and creates a new subscription.
6. Verify `/health`, then run `await kapaniPushSelfTest()` while logged in.

A successful `/health` must report `vapid.publicOk: true`, `vapid.privateOk: true`, `vapid.pairOk: true`. A successful self-test with one device should report `sent: 1`.

## Firebase billing note

This push implementation does not use Firebase Cloud Functions. The Firebase project can remain on Spark within its applicable no-cost quotas. The Worker still uses a server-only Google service-account credential to access the locked RTDB via REST; that is not a Cloud Function.
