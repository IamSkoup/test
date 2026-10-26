# LEGACY — НЕ ИСПОЛЬЗУЕТСЯ ДЛЯ ТЕКУЩЕГО PUSH

Текущий production push работает через `push-worker/` (прямой Web Push/VAPID) + Firebase Spark. Этот файл описывает старый Cloudflare→FCM HTTP v1 путь и оставлен только как историческая справка. Не деплойте этот Worker для текущей системы.

# Kapani Push — Cloudflare deployment

## 1. Deploy the Worker

cd cloudflare-worker
wrangler login
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
wrangler deploy

The secret must be the Firebase service-account JSON for project `kapanisite`.

## 2. Deploy the updated GitHub Pages frontend

Publish:
- index.html
- config.js
- firebase-messaging-sw.js
- manifest.json
- assets used by the site

The canonical site is:
https://iamskoup1.github.io/kapani/

## 3. Retire legacy Firebase push sender functions

The source no longer exports the old Firebase push sender functions:
- enqueueNotificationPush
- processNotificationQueue

If those functions are currently deployed in Firebase, delete them once the Cloudflare Worker is live:

firebase functions:delete enqueueNotificationPush --region europe-west1
firebase functions:delete processNotificationQueue --region europe-west1

Do NOT delete notification fan-out functions such as notifyOnChatMessage or notifyOnNewsCreated; they create canonical notification records that Cloudflare delivers.

## 4. Required Worker secret/config

Worker vars in wrangler.toml:
- FIREBASE_PROJECT_ID=kapanisite
- FIREBASE_DATABASE_URL=https://kapanisite-default-rtdb.europe-west1.firebasedatabase.app
- FIREBASE_WEB_API_KEY=<public web API key>

The Worker also uses the service-account OAuth token for Firebase Realtime Database REST access. Do not loosen `database.rules.json` just for push.

Required secret:
- FIREBASE_SERVICE_ACCOUNT_JSON

## 5. Verify

curl https://kapani-free-push.kapani.workers.dev/health

Then on the site:

await window.getKapaniPushDiagnostics()

Expected:
- permission: granted
- serviceWorkerRegistered: true
- activeServiceWorker: true
- fcmTokenExists: true
- serverRegistered: true
- serverTokenCount >= 1
- serverError: null

Finally test with the recipient's Kapani tab/browser fully closed.
