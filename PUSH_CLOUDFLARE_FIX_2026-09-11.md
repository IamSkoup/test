# Kapani Push — Cloudflare token fix — 2026-09-11

## What changed

The active push bridge remains `https://kapani-free-push.kapani.workers.dev`.
The browser no longer needs a ready Firebase Auth session for push bridge operations.

The Worker `/session` validates the existing Kapani nick/password and issues a short-lived
signed `cfp.*` push session token. Frontend push operations use that token for:

- `/register`
- `/unregister`
- `/diagnostics`
- `/preferences`
- `/enqueue`

Firebase Auth custom-token sign-in remains available for existing Kapani features and is not
removed, but it is no longer a prerequisite for push delivery/wake-up.

## Delivery path

`pushNotification()`
→ atomic `users/{nick}/notifications/{id}` + `pushQueue/{jobId}`
→ Cloudflare `/enqueue` using `cfp.*`
→ Worker queue processing / one-minute Cron fallback
→ FCM HTTP v1 using server-only `FIREBASE_SERVICE_ACCOUNT_JSON`
→ `firebase-messaging-sw.js`
→ system notification

## Token handling

The signed push token is derived and verified only inside the Cloudflare Worker using the
existing server-only `FIREBASE_SERVICE_ACCOUNT_JSON` secret as the HMAC source.
No Firebase private key or Cloudflare API token is placed in frontend code.

The frontend stores only the short-lived signed push session token; logout removes it.

## Verification

- `cloudflare-worker/worker.js` syntax: OK
- `index.html` inline JavaScript syntax: OK
- `firebase-messaging-sw.js` syntax: OK
- `functions/index.js` syntax: OK
- No remaining `push enqueue wake-up` path requires `Firebase Auth` in the frontend.

## Production limitation

The environment used for this patch cannot resolve the deployed `kapani-free-push.kapani.workers.dev`
host, so a live Cloudflare `/health`, Cron execution, FCM delivery and real-device closed-site test
could not be performed here.
