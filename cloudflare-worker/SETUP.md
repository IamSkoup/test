# LEGACY — НЕ ИСПОЛЬЗУЕТСЯ ДЛЯ ТЕКУЩЕГО PUSH

Текущий push: `push-worker/` → прямой Web Push/VAPID → `firebase-messaging-sw.js`, Firebase остаётся на Spark.

# Kapani Cloudflare Push — production setup

## Canonical production flow

`RTDB notification + durable pushQueue job (atomic write)` → `Cloudflare Cron` → `lease/retry` → `FCM HTTP v1` → `firebase-messaging-sw.js` → system notification.

Firebase Functions are not required for push delivery. The Worker is the only FCM sender.

## 1. Install Wrangler

```powershell
npm install -g wrangler
wrangler login
wrangler whoami
```

## 2. Configure the FCM service account secret

The Worker requires the Firebase service-account JSON as a Cloudflare secret. Do not put the private key in `wrangler.toml`, Git, or frontend files.

```powershell
cd cloudflare-worker
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

Paste the **entire JSON service-account document** when Wrangler prompts for it.

Check that the secret exists:

```powershell
wrangler secret list
```

## 3. Deploy the Worker

```powershell
wrangler deploy
```

The Wrangler config contains a one-minute Cron Trigger. Cloudflare invokes the Worker's `scheduled()` handler every minute; Cron Triggers run in UTC. See the official docs: https://developers.cloudflare.com/workers/configuration/cron-triggers/

## 4. Check the Worker

```powershell
curl https://kapani-free-push.kapani.workers.dev/health
```

Expected response contains:

```json
{"ok":true,"service":"kapani-free-push-bridge","mode":"cloudflare-queue-fcm-v1"}
```

## 5. Check CORS preflight

From the browser, the frontend sends `Authorization: Bearer cfp.<signed-session>` issued by `/session`.

```powershell
curl -i -X OPTIONS https://kapani-free-push.kapani.workers.dev/register `
  -H "Origin: https://iamskoup1.github.io" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: authorization,content-type"
```

Expected: `204`, with headers including:

- `access-control-allow-origin: https://iamskoup1.github.io`
- `access-control-allow-methods: GET, POST, OPTIONS`
- `access-control-allow-headers: Authorization, Content-Type`

## 6. Test local scheduled processing

```powershell
wrangler dev --test-scheduled
```

In another terminal:

```powershell
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

Cloudflare documents this scheduled-test route here: https://developers.cloudflare.com/workers/configuration/cron-triggers/

## 7. Verify from Kapani

Open:

`https://iamskoup1.github.io/kapani/`

Then in DevTools Console:

```js
window.getKapaniPushDiagnostics()
```

For a correctly registered browser, the important fields are:

```text
permission               granted
serviceWorkerRegistered  true
activeServiceWorker      true
fcmTokenExists           true
serverRegistered         true
serverTokenCount         >= 1
serverError              null
queueDiagnostic          [array]
```

## 8. Real closed-site test

1. Browser B enables push and shows `serverRegistered: true`.
2. Completely close Kapani.
3. User A sends a message/event to B.
4. The RTDB write creates the notification and `pushQueue` job atomically.
5. Cloudflare Cron picks the job up even though Kapani is closed.
6. Worker sends FCM HTTP v1.
7. `firebase-messaging-sw.js` receives the data-only message.
8. The OS displays the notification.

The browser tab is not part of steps 4–8.
