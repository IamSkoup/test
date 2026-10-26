# Kapani Web Push implementation — 2026-09-13

## What was found

The project had a Cloudflare Worker-based FCM delivery path, frontend FCM token registration, Cloudflare push-session helpers, and a durable `pushQueue` model. `firebase-messaging-sw.js` was also coupled to Firebase Messaging background handling.

## What was changed

- Removed runtime dependence on the Cloudflare Push bridge from `index.html`.
- Removed FCM token registration/diagnostics from the frontend.
- Kept a single Service Worker at `firebase-messaging-sw.js`, but converted it to standard Web Push handling with the browser `push` event and `showNotification()`.
- Added browser-standard `PushManager.subscribe()` registration using a VAPID public key.
- Added server-side `pushSubscriptions/<subscriptionId>` storage with one user able to have multiple devices.
- Added subscription ownership index and stale-subscription cleanup for HTTP 404/410 responses.
- Added server-side preference updates and unsubscribe callable functions.
- Added a generic Firebase Realtime Database trigger on `users/{nick}/notifications/{notificationId}`. Existing Kapani notification writers therefore automatically feed Web Push without a second event system.
- Added VAPID signing and Web Push payload encryption in the existing Cloud Functions backend using Node's built-in crypto/HTTPS APIs; no new external push SaaS and no new npm dependency are required.
- Private VAPID key is read only from Firebase Functions Secret Manager as `KAPANI_VAPID_PRIVATE_KEY`.
- Added general-chat suppression when the recipient's general chat is visibly open, while retaining the in-app notification record.
- Added DM open-state tracking and DM deep-link data so notification clicks can target the existing messages/DM UI.
- Removed the Cloudflare Worker directory and the dedicated Cloudflare deployment document. Historical audit/report markdown files were left untouched as non-runtime history.
- Updated `DEPLOY_PUSH.md` with the new Secret Manager and deployment workflow.

## New delivery chain

```text
Kapani event
  ↓
users/<nick>/notifications/<notificationId>
  ↓
Firebase Cloud Function onValueCreated
  ↓
VAPID + Web Push protocol
  ↓
Browser Push Service
  ↓
firebase-messaging-sw.js (standard push event)
  ↓
showNotification()
```

## Static/runtime-independent checks completed

- All inline JavaScript extracted from `index.html` passes `node --check`.
- `functions/index.js` passes `node --check`.
- `firebase-messaging-sw.js` passes `node --check`.
- Native Web Push encryption path produced a valid encrypted payload with a generated P-256 receiver subscription in a local crypto self-test.
- VAPID JWT generation produced a three-part ES256 JWT in the same self-test.
- Runtime source no longer contains Cloudflare/FCM delivery symbols in `index.html`, `config.js`, `functions/index.js`, the Service Worker, or database rules.

## Acceptance status

The archive was not deployed to the user's Firebase/GitHub Pages production environment from this session, so the physical end-to-end acceptance test with a completely closed Kapani tab cannot honestly be marked `✅`. The critical test remains: grant permission → register subscription → close Kapani tab → send a message from another user → receive a real system notification through the Service Worker.
