# Kapani — production push audit и исправление

Дата: 2026-09-10

## 1. Root cause

### A. Критическая причина отсутствия регистрации FCM

Frontend регистрировал FCM token через Cloudflare Worker. Запрос содержал `Authorization: Bearer <Firebase ID token>`, но Worker возвращал CORS `Access-Control-Allow-Headers: content-type` без `Authorization`. Браузерный preflight поэтому блокировал cross-origin POST ещё до `/register`.

### B. Второй конкурентный sender

После записи `users/{nick}/notifications/{id}` frontend дополнительно вызывал Cloudflare `/push`. Одновременно Firebase Function `enqueueNotificationPush` слушала тот же RTDB record и могла самостоятельно отправить тот же FCM. Это создавало два production sender-а, race conditions и риск двойной доставки.

### C. Несогласованный tokenId

Firebase Functions идентифицируют token SHA-256 (первые 32 hex-символа), а Cloudflare Worker использовал другой FNV-подобный 8-символьный идентификатор. Из-за этого состояние одного и того же token могло адресоваться разными ID.

### D. False-positive состояния push

При уже выданном `Notification.permission === "granted"` frontend возвращал успешный результат независимо от того, завершилась ли регистрация Service Worker/FCM token на backend. Кроме того, локальный `enabled=true` выставлялся до подтверждения серверной регистрации.

### E. Auth race

Регистрация token зависела от момента восстановления Firebase Auth. Теперь есть ожидание authenticated user и повторная попытка через `onAuthStateChanged`.

### F. Недостаточная диагностика

Backend diagnostics показывала только количество token-ов. Теперь она возвращает server registration timestamp, preferences, последние queue jobs, статусы и последний server error.

## 2. Изменённые файлы

- `index.html`
- `functions/index.js`
- `firebase-messaging-sw.js`
- `cloudflare-worker/worker.js`
- `KAPANI_PUSH_FIX_REPORT_2026-09-10.md`

Существующие функции сайта не удалялись.

## 3. Что исправлено

### Frontend

- FCM registration, unregister и diagnostics переведены с Cloudflare HTTP bridge на защищённые Firebase Callable Functions.
- `registerFcmToken` считается успешным только после серверной верификации, что конкретный token действительно записан.
- Поддерживается несколько token-ов одного пользователя.
- Auth race обрабатывается повторной регистрацией после восстановления Firebase Auth.
- Foreground `onMessage()` показывает одно системное уведомление через активный Service Worker.
- RTDB listener больше не создаёт второе popup-уведомление, когда authoritative push registration подтверждена.
- `pushNotification()` теперь делает только canonical notification record в RTDB. Отдельного `/push` после записи нет.
- Logout использует `unregisterFcmToken` Cloud Function.
- Локальный статус push не объявляется успешно зарегистрированным до backend confirmation.

### Firebase Functions

- `registerFcmToken` возвращает `tokenCount`, `registeredTokenMatches`, `backendRegisteredAt`.
- `getPushDiagnostics` дополнен queue diagnostics и последней ошибкой.
- Invalid-token cleanup стал race-safe: функция не удаляет token, если он уже перевязан на другой UID.
- `waiting_token` jobs удерживаются в очереди до 7 дней вместо 24 часов.
- Multi-device job больше не объявляется `sent`, если хотя бы один token остаётся transient/unresolved после последней попытки; такой job явно фиксируется как `dead` с `deliveryIncomplete=true`.
- Счётчик успешных доставок сохраняется между retry-циклами.
- Существующий durable queue с lease/retry остаётся основным delivery engine.

### Service Worker

- Версия обновлена до `kapani-fcm-2026-09-10-v5`.
- Сохранился data-only FCM payload.
- Background `onBackgroundMessage()` управляет единственным системным `showNotification()`.
- URL notification click ограничен scope `/kapani/`; чужие/старые URL нормализуются в `/kapani/`.
- Убраны ссылки на отсутствующий в архиве `image.png`, чтобы отсутствие asset не влияло на отображение уведомления.

### Cloudflare Worker

- CORS теперь разрешает `Content-Type` и `Authorization` и корректно обрабатывает preflight.
- Разрешён production origin `https://iamskoup1.github.io`.
- tokenId приведён к тому же SHA-256 алгоритму, что и Functions.
- `/register` и `/diagnostics` остаются совместимыми вспомогательными endpoint-ами.
- `/push` и `/send` больше не отправляют FCM и возвращают `410 CANONICAL_PIPELINE`; это намеренно, чтобы старый sender не мог конкурировать с Firebase queue.

## 4. Единственный production push pipeline

`EVENT`
→ `users/{nick}/notifications/{notificationId}`
→ `enqueueNotificationPush`
→ `notificationQueue/{jobId}`
→ lease/processing
→ FCM HTTP v1 data-only
→ FCM/Web Push
→ `firebase-messaging-sw.js`
→ `showNotification()`

Открытая вкладка `index.html` не требуется для background/closed-site доставки.

## 5. Token registration verification

Клиент проверяет:

- Notification permission = `granted`
- Service Worker зарегистрирован
- Service Worker active
- FCM token получен
- `registerFcmToken` вернул `success=true`
- `registeredTokenMatches=true`
- `tokenCount >= 1`

Diagnostics также возвращает server token count, registration time и queue state.

## 6. Background / closed-site

В production delivery path нет зависимости от runtime `index.html`. Backend отправляет data-only FCM. Service Worker получает background message и сам создаёт системное уведомление. Это соответствует текущей модели FCM Web для background Service Worker обработки. См. официальную документацию Firebase: https://firebase.google.com/docs/cloud-messaging/web/receive-messages

## 7. Foreground

Foreground FCM обрабатывается `onMessage()`. Он вызывает `ServiceWorkerRegistration.showNotification()`. RTDB inbox listener используется для состояния/истории и не создаёт второе popup при подтверждённой push-регистрации.

## 8. Общий чат / новости / остальные notification records

Общий чат и новости уже создают canonical notification records на backend triggers. После этого все recipients проходят через общую queue/FCM обработку. Остальные существующие вызовы `pushNotification()` теперь тоже используют тот же canonical notification record и тот же queue trigger, без отдельной client→Cloudflare отправки.

## 9. Durable queue

Поддерживаются состояния:

`pending`, `processing`, `retry`, `waiting_token`, `sent`, `skipped`, `dead`

Lease reclaim выполняется scheduler-ом после истечения `leaseUntil`. Retry использует exponential backoff + jitter. Ошибки логируются с `jobId`, `notificationId`, `user`, `tokenId`, `attempt`, `code` и timestamp.

## 10. FCM errors

`registration-token-not-registered`/invalid registration token удаляются. `invalid-argument` не используется как автоматическое условие удаления token: такой ответ может обозначать ошибку самого payload.

## 11. Проверки, выполненные локально

- `functions/index.js` — `node --check`: PASS
- `cloudflare-worker/worker.js` — ESM syntax check: PASS
- `firebase-messaging-sw.js` — ESM syntax check: PASS
- Все 9 inline `<script>` блоков `index.html` — PASS
- Worker CORS integration harness — PASS:
  - OPTIONS 204
  - `Access-Control-Allow-Origin: https://iamskoup1.github.io`
  - `Access-Control-Allow-Headers: content-type, authorization`
  - POST `/register` проходит CORS и авторизацию harness
  - POST `/diagnostics` проходит CORS и авторизацию harness
  - POST `/push` проходит CORS и возвращает `410 CANONICAL_PIPELINE`
- Service Worker harness — PASS:
  - `onBackgroundMessage` bound
  - data-only payload вызывает `showNotification`
  - stable notification tag формируется из `notificationId`
  - external URL нормализуется в `/kapani/`

## 12. Что невозможно подтвердить без production доступа

Не могу из этого архива достоверно подтвердить:

1. Что обновлённые Firebase Functions уже deployed в проект `kapanisite`.
2. Что Cloudflare Worker уже deployed с новым `worker.js`.
3. Что production GitHub Pages уже содержит эту версию `firebase-messaging-sw.js`.
4. Что Firebase Cloud Messaging фактически принимает и доставляет сообщение к реальному registered token.
5. Closed-browser test на реальном Chrome/Firefox/Android устройстве.
6. iOS PWA end-to-end test на физическом iPhone.
7. Реальное наличие/содержимое production Firebase Auth/RTDB rules и runtime logs.

В окружении текущей сессии нет credentials для `firebase deploy` или `wrangler deploy`, а исходный архив не содержит Firebase Rules.

## 13. Production validation sequence

После deploy:

```js
await window.getKapaniPushDiagnostics()
```

Ожидается:

- `permission: "granted"`
- `serviceWorkerRegistered: true`
- `activeServiceWorker: true`
- `fcmTokenExists: true`
- `serverRegistered: true`
- `serverTokenCount >= 1`
- `state.registered`

Затем выполнить закрытый-site test: отправить событие на этот аккаунт при полностью закрытой вкладке. В RTDB должна пройти цепочка `pending → processing → sent`, а уведомление — появиться через Service Worker.

Для iOS: установить `/kapani/` на Home Screen, выдать Notifications permission и тестировать именно PWA. Web Push для Home Screen web apps поддерживается Apple начиная с iOS/iPadOS 16.4.
