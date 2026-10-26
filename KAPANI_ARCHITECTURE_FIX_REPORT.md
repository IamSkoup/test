# Kapani — production push-архитектура: аудит и исправления

Дата: 2026-09-09

## Причины исходных проблем

1. Клиентская регистрация FCM имела RTDB fallback и могла считать push включённым, даже если защищённая backend-регистрация через Firebase Auth не состоялась.
2. Очередь не подбирала зависшие `processing/sending` jobs после падения worker/function.
3. Классификация FCM считала общий `invalid-argument` признаком умершего token, хотя это может быть ошибка payload.
4. Не все notification sources проходили через канонический `/users/{nick}/notifications/*`: legacy-дуэли использовали отдельную ветку.
5. News fan-out выполнялся из клиентской вкладки и мог прерваться при закрытии страницы/ошибке сети.
6. Подарок подписки создавал финансовую запись и уведомления раздельно, поэтому уведомление могло потеряться после успешной финансовой операции.
7. В клиенте существовал параллельный локальный `showNotification`/`Notification` путь, способный расходиться с FCM и давать дубли.

## Что изменено

- `functions/index.js`
  - единая durable queue `notificationQueue`;
  - transaction/lease locking и reclaim просроченных jobs;
  - статусы `pending`, `processing`, `retry`, `waiting_token`, `sent`, `skipped`, `dead`;
  - exponential backoff + jitter;
  - per-token delivery state;
  - удаление permanent/invalid FCM tokens;
  - structured push logs;
  - `registerFcmToken`, `unregisterFcmToken`, `getPushDiagnostics` требуют Firebase Auth;
  - backend triggers для общего канала, legacy duel notifications и news;
  - notification records подарков создаются внутри одной RTDB transaction с основной операцией.
- `index.html`
  - удалён client-side FCM token fallback;
  - регистрация token ожидает Firebase Auth и активный Service Worker;
  - добавлена безопасная push diagnostics функция;
  - foreground `onMessage()` больше не создаёт второе системное уведомление;
  - удалён отдельный local notification bridge;
  - logout снимает текущий token с backend;
  - news fan-out перенесён на backend trigger;
  - критические push-ошибки больше не проглатываются пустыми catch-блоками.
- `firebase-messaging-sw.js`
  - data-only background handler с `showNotification()`;
  - стабильный notification tag/id и deep-link click handling.
- `manifest.json`
  - добавлен стабильный PWA `id`.
- `README.md`, `DEPLOY.md`, `README_CHAT_NOTIFICATIONS.md`
  - обновлены под фактическую архитектуру.

## Background / closed-site

FCM отправляется backend как data-only payload. Service Worker получает сообщение в background/closed состоянии и вызывает `showNotification()`. Открытая страница `index.html` для этого не нужна.

## Надёжность

Очередь реализует at-least-once обработку на стороне backend. Она сохраняет состояние job и token, делает retry при временных ошибках и reclaim просроченного lease после падения обработчика. Полной гарантии фактического показа на физическом устройстве сервер не получает: FCM acknowledgement не является атомарным подтверждением отображения пользователю.

## Production validation

Локально выполнены синтаксические проверки всех inline JavaScript-блоков `index.html`, `functions/index.js` и `firebase-messaging-sw.js`.

Фактическая end-to-end доставка через production Firebase FCM, физический iOS/Android и Cloudflare runtime без деплоя этой версии и доступа к production telemetry не подтверждена.
