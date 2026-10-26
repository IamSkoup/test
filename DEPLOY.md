# Deploy Kapani

## Firebase Functions

```bash
cd functions
npm ci
cd ..
firebase deploy --only functions
```

Должны быть deployed:

- `registerFcmToken`
- `unregisterFcmToken`
- `updatePushPreferences`
- `getPushDiagnostics`
- `enqueueNotificationPush`
- `processNotificationQueue`
- `notifyOnChatMessage`
- `notifyOnLegacyDuelNotification`
- `notifyOnNewsCreated`
- остальные существующие Cloud Functions проекта

## Client / Service Worker

На production domain рядом с `index.html` должны быть доступны:

- `/kapani/index.html`
- `/kapani/config.js`
- `/kapani/firebase-messaging-sw.js`
- `/kapani/manifest.json`
- `/kapani/image.png`

FCM Web требует HTTPS. citeturn733441search7

## Firebase prerequisites

1. Authentication должен быть включён: Kapani создаёт Firebase custom-token сессию перед server-side `registerFcmToken`.
2. Cloud Functions должны иметь доступ к Firebase Admin SDK.
3. FCM API и Web Push credentials проекта должны оставаться на backend.
4. Realtime Database должна быть доступна Functions в регионе `europe-west1`.

## RTDB Rules

В архиве отсутствуют исходные RTDB/Firestore rules. Functions работают через Admin SDK и не требуют client rules для `notificationQueue`/`fcmTokenIndex`. Не копируйте публичные RTDB rules из старого Worker-конфига в production без отдельного security-аудита.

## Verification after deployment

### 1. Token registration

Откройте Kapani, разрешите Notifications и выполните:

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

### 2. End-to-end push

Создайте новое notification событие. В `notificationQueue/{jobId}` ожидается `pending → processing → sent`.

### 3. Closed-site test

Полностью закройте вкладки/окна Kapani и отправьте новое сообщение другому пользователю. Системное уведомление должно приходить через FCM + Service Worker без открытого `index.html`.

### 4. iOS

На iPhone установите Kapani на Home Screen, разрешите Notifications и тестируйте из PWA. Apple документирует Web Push для Home Screen web apps на iOS/iPadOS 16.4+. citeturn733441search0turn733441search1

### 5. Logs

Ищите структурированные строки `[KapaniPush]` по `jobId`, `notificationId`, `user`, `tokenId`, `attempt`, `code`.
