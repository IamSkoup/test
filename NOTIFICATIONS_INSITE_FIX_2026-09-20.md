# Kapani — in-site notifications + push while the site is open (2026-09-20)

## Root causes found
1. The inbox listener (`attachNotificationsListener`) waited for a Firebase Auth custom-token session
   (`issueKapaniSessionToken`) and, if that failed, silently never bound -> "🔔 Уведомления" stayed empty.
2. `pushNotification()` also required that session + the `createKapaniNotification` callable, so any
   session/Functions problem meant notifications were never created.
3. OS-level notification while the site is open was only shown for self-addressed notifications; everything
   arriving from other users (chat, news, DM, transfers) got only an in-page banner.
4. Inbox ordering used push-key order (`chat_*`, `news_*`, `legacy_*` ids are not chronological) and the
   time came from the server (UTC).

## Changes
- `index.html`
  - Listener binds immediately, retries with back-off (re-establishing the session), re-binds on tab focus / online.
  - One entry point `announceIncomingNotification()` -> in-app banner + system notification (Service Worker),
    respects push category toggles; skipped when that chat/DM is already open.
  - `pushNotification()` writes to `users/<nick>/notifications` directly first; callable is the fallback.
    The `deliverKapaniWebPush` trigger still delivers closed-tab push for the same record.
  - Inbox sorted by `createdAt`, local time, multi-line text, HTML-escaped.
  - Duel invites are mirrored to the inbox from the client under the same `legacy_<key>` id as the backend bridge.
  - Notification click while the app is open routes in-app (no reload).
  - New button "🧪 Проверить уведомления" in the Push card (`testKapaniPush()`).
- `firebase-messaging-sw.js` (v3): dedupe id recorded only after a successful `showNotification`;
  click posts `KAPANI_NOTIFICATION_CLICK` to the open page instead of forcing a reload.
- `functions/*`, `database.rules.json`, `config.js`: unchanged.

## Verify after publishing
1. Hard-reload (or reopen the PWA) so the new Service Worker (v3) activates.
2. Profile -> "🧪 Проверить уведомления": item appears in the list + banner (+ system notification if permitted).
3. Second account writes to general chat / DM -> recipient sees list item, banner and system notification.
4. Console: `await getKapaniPushDiagnostics()`.
