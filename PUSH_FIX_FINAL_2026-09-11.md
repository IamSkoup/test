# Kapani Push — final repair 2026-09-11

## Root causes found

1. `database.rules.json` denies anonymous RTDB REST access (`.read=false`, `.write=false` at the root), while `cloudflare-worker/worker.js` was calling the RTDB REST API without an `Authorization` header. The Worker therefore could not read users/tokens or process `pushQueue`.
2. `index.html` wrote `users/{nick}/notifications` and `pushQueue` directly from the browser. Those paths are intentionally not browser-writable, so client-generated notifications failed before they could become push jobs.
3. The project contained stale documentation describing the Worker as a legacy path even though the current code uses `pushQueue -> Cloudflare Worker -> FCM`.

## Changes

### Cloudflare Worker
- Added Google OAuth2 scopes for both Firebase Messaging and Firebase Realtime Database.
- All RTDB reads, ETag reads, conditional PUTs and PATCHes now send `Authorization: Bearer <OAuth access token>`.
- Queue status queries also use the same authenticated access.
- RTDB security rules remain closed to anonymous REST clients.

### Firebase Functions
- Added callable `createKapaniNotification`.
- It validates the authenticated Firebase session, creates the canonical notification record and durable `pushQueue` entry atomically, and returns the notification ID.

### Frontend
- Reworked `pushNotification()` to call `createKapaniNotification` instead of writing protected RTDB paths directly.
- It keeps the Cloudflare `/enqueue` call as best-effort wake-up; the Worker cron remains authoritative.
- New-account registration now establishes the protected Firebase/Cloudflare session before attempting notification sends.

### Service Worker
- No change to the display model: FCM remains data-only and `firebase-messaging-sw.js` owns background display via `onBackgroundMessage()` / `showNotification()`.

## Expected production chain

`event -> canonical notification -> pushQueue -> Cloudflare Worker (authenticated RTDB) -> FCM HTTP v1 -> browser Service Worker -> system notification`

This works with the site open, in a background tab, or with the site closed, provided the browser has a valid FCM token and notification permission. iOS Web Push must still run from an installed Home Screen PWA.

## Files changed

- `index.html`
- `functions/index.js`
- `cloudflare-worker/worker.js`
- `README.md`
- `cloudflare-worker/README.md`
- `DEPLOY_CLOUDFLARE_PUSH.md`
- `PUSH_FIX_FINAL_2026-09-11.md`
