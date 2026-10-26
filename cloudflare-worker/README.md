# LEGACY — старый Cloudflare → FCM Worker

**Не является текущим production push backend.** Текущая схема: `push-worker/` → прямой Web Push/VAPID → Service Worker. Firebase Functions для push не используются.

# Kapani Cloudflare Push Bridge — ACTIVE PRODUCTION PUSH BRIDGE

Это активная production-система Push Kapani.

Каноническая цепочка:

`Kapani → createKapaniNotification → users/<nick>/notifications + pushQueue → Cloudflare Worker → FCM HTTP v1 → firebase-messaging-sw.js → системное уведомление`

## API

- `GET /health` — проверка production-конфигурации Worker.
- `POST /session` — короткоживущая Cloudflare push-сессия.
- `POST /register` — регистрация FCM token.
- `POST /unregister` — удаление FCM token.
- `POST /diagnostics` — состояние токенов и очереди пользователя.
- `POST /preferences` — настройки категорий Push.
- `POST /enqueue` — идемпотентный wake-up/ensure queue entry.

Actual FCM delivery выполняется только Worker через FCM HTTP v1. Firebase Functions больше не отправляют Push напрямую.

## Важно

Не удаляйте `createKapaniNotification`, `notifyOnChatMessage`, `notifyOnLegacyDuelNotification` и `notifyOnNewsCreated`: эти функции создают канонические записи уведомлений/очереди.

Не возвращайте `admin.messaging().sendEach()` или другой прямой sender в Firebase Functions: это создаст конкурирующий путь доставки и риск двойных Push.
