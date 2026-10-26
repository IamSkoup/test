# Kapani Push — полный аудит и исправление, 12.09.2026

## Итоговая архитектура

`Kapani`
`↓`
`Notification permission`
`↓`
`FCM getToken()`
`↓`
`Cloudflare /register`
`↓`
`users/<nick>/fcmTokens/<tokenId>`
`↓`
`Firebase Functions createKapaniNotification`
`↓`
`users/<nick>/notifications/<notificationId> + pushQueue/<jobId>`
`↓`
`Cloudflare Cron / queue processor`
`↓`
`FCM HTTP v1`
`↓`
`firebase-messaging-sw.js`
`↓`
`system notification`

Открытый сайт использует `onMessage()` и передаёт data-only payload в тот же Service Worker renderer. В фоне/при закрытой странице Firebase Messaging передаёт сообщение в `onBackgroundMessage()` Service Worker.

## Найденные проблемы

### 1. Несовпадение ID очереди — исправлено

`functions/index.js` создавал job ID как полный SHA-256 от `nick:notificationId`.
Cloudflare `/enqueue` использовал другой 32-символьный ID.

Следствие: часть уведомлений могла создавать второй pushQueue job для одного и того же notification ID.

Исправление: Cloudflare теперь использует тот же полный SHA-256 алгоритм, что и Firebase Functions.

### 2. В исходнике Functions оставался неиспользуемый прямой FCM sender — исправлено

В `functions/index.js` присутствовал старый `admin.messaging().sendEach()` processor для отдельной `notificationQueue`.
Он не экспортировался как active trigger, однако это была вторая реализация доставки и её наличие создавало риск повторного включения/дублирования.

Исправление: legacy sender/processor удалён из исходника. FCM delivery теперь выполняет только Cloudflare Worker.

### 3. `/health` был слишком поверхностным — исправлено

Теперь `GET /health` сообщает, настроены ли server-side secret/project/database. При отсутствии критичной production-конфигурации возвращает HTTP 503 и `ok:false`.

### 4. Диагностика была неполной — исправлено

`window.getKapaniPushDiagnostics()` теперь дополнительно показывает:

- `lastRegisterResponse`
- `serviceWorkerScript`
- `cloudflareWorker`
- `cloudflareHealth`

Секреты и полный FCM token не раскрываются.

### 5. Добавлен реальный end-to-end тест — исправлено

Добавлена:

```js
await window.testKapaniPush()
```

Она создаёт настоящее Kapani-уведомление через существующий server-side notification path. Локальный `showNotification()` для теста не используется.

## Что проверено статически

- `cloudflare-worker/worker.js` — синтаксис OK.
- `firebase-messaging-sw.js` — синтаксис OK.
- `functions/index.js` — синтаксис OK.
- В `functions/index.js` больше нет `admin.messaging().sendEach()`/прямого FCM sender.
- В Cloudflare Worker есть `messages:send` через FCM HTTP v1.
- FCM payload у Cloudflare — data-only, без `notification` объекта.
- Service Worker показывает data-only Push через единый `showKapaniPush()`.
- Service Worker обрабатывает `notificationclick` и открывает canonical `/kapani/`.
- `wrangler.toml` содержит Cron `* * * * *`.
- RTDB REST в Worker использует OAuth access token service account.
- `/register`, `/unregister`, `/diagnostics`, `/preferences`, `/enqueue` защищены Cloudflare push session.
- Токены индексируются и не должны привязываться к предыдущему Kapani-аккаунту.

## Что нельзя честно проверить из текущей среды

В данной среде не удалось разрешить DNS имени:

`kapani-free-push.kapani.workers.dev`

Поэтому здесь невозможно честно подтвердить:

- live `/health`;
- наличие `FIREBASE_SERVICE_ACCOUNT_JSON` в Cloudflare;
- реальный Cron Trigger;
- ответ FCM Google;
- реальную доставку на физическом Android/Windows устройстве;
- реальную iPhone/iPad PWA доставку.

Это не обозначает, что код неверный; это означает, что production-контур требует ручной проверки после deploy.

## Ручные шаги перед production test

### Cloudflare

```bash
cd cloudflare-worker
wrangler login
wrangler whoami
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
wrangler deploy
```

### Functions

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### Health

```bash
curl https://kapani-free-push.kapani.workers.dev/health
```

### Browser diagnostics

```js
await window.getKapaniPushDiagnostics()
```

### Real test

```js
await window.testKapaniPush()
```

## iOS / iPadOS

Apple поддерживает Web Push для Home Screen web apps на iOS/iPadOS начиная с 16.4. Запрос разрешения должен происходить как реакция на прямое действие пользователя. Поэтому текущий flow с кнопкой первого входа/профильной кнопкой корректнее, чем автоматический permission prompt вне user gesture.

Обычная вкладка Safari не считается эквивалентом установленной Home Screen PWA для iOS Web Push.
