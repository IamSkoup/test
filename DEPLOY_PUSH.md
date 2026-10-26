# Kapani Web Push — Cloudflare Worker + Firebase Spark

Эта инструкция относится к **текущему production push-контру**. Firebase Cloud Functions для push не используются. Firebase остаётся в Spark, а Cloudflare Worker выполняет прямой Web Push.

## 1. Что должно быть настроено

- Firebase project: `kapanisite`
- Realtime Database: `https://kapanisite-default-rtdb.europe-west1.firebasedatabase.app`
- Cloudflare Worker: `push-worker/`
- Cloudflare KV binding: `PUSH_KV`
- одна и та же VAPID public key в `config.js` и `push-worker/wrangler.toml`
- секреты Worker: `VAPID_PRIVATE_KEY` и `FIREBASE_SERVICE_ACCOUNT_JSON`

Firebase Spark здесь не мешает: Firebase документирует, что Realtime Database имеет бесплатную квоту на Spark, а Cloud Functions требуют Blaze. REST API RTDB поддерживает Google OAuth2 access token от service account для серверного доступа.

## 2. VAPID private key

В этой исправленной сборке public key уже прописан в `config.js` и `push-worker/wrangler.toml`. Приватная часть лежит **отдельным файлом вне архива**; её нужно записать только в Cloudflare Secret.

```powershell
cd push-worker
Get-Content ..\KAPANI_VAPID_PRIVATE_KEY_2026-09-30.txt -Raw | wrangler secret put VAPID_PRIVATE_KEY
```

Либо можно сгенерировать другую пару локально через `node generate-vapid.mjs --apply`, после чего обязательно заменить secret и опубликовать новый `config.js`.

## 3. Firebase service account для Worker

Worker читает/пишет закрытую RTDB через REST API. Поэтому нужен сервисный аккаунт Firebase/Google. Получить JSON можно в Firebase Console → Project settings → Service accounts → Generate new private key.

Сохраняйте JSON только локально и в Cloudflare Secret:

```powershell
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

Это **не** Firebase Cloud Function и не требует размещать функцию. Secret нужен только Worker для серверного REST-доступа к RTDB.

## 4. KV

Если namespace ещё не существует:

```powershell
wrangler kv namespace create PUSH_KV
```

ID namespace должен совпадать с `push-worker/wrangler.toml`. В текущем архиве уже стоит существующий ID; менять его не нужно, если это тот namespace, который использует твой Worker.

## 5. Deploy Worker

```powershell
cd push-worker
wrangler login
wrangler deploy
```

## 6. Проверка Worker

```text
https://kapani-push.kapani.workers.dev/health
```

Критическая часть ответа:

```json
{
  "ok": true,
  "kv": true,
  "vapidPublic": true,
  "vapidPrivate": true,
  "vapid": {
    "publicOk": true,
    "privateOk": true,
    "pairOk": true
  }
}
```

`pairOk: false` означает, что `VAPID_PRIVATE_KEY` не соответствует public key.

## 7. Publish frontend

Выложите на GitHub Pages:

```text
index.html
config.js
firebase-messaging-sw.js
```

После смены VAPID public key существующая PushSubscription на устройстве будет пересоздана при следующем запуске сайта с уже выданным разрешением.

## 8. Реальный тест закрытого сайта

После входа и разрешения уведомлений откройте консоль:

```js
await getKapaniPushWorkerHealth()
await kapaniPushDoctor()
await kapaniPushSelfTest()
```

Ожидается примерно:

```js
{ ok: true, sent: 1, devices: 1, ... }
```

После `sent: 1` полностью закройте вкладку/окно Kapani и отправьте себе уведомление с другого аккаунта. Системное уведомление должно прийти без открытого `index.html`.

## 9. Что происходит при обычных уведомлениях

Клиент создаёт canonical notification record и job в `pushOutbox`. Worker получает job через `/event`; если браузер/сеть потеряли запрос, ежеминутный cron Worker подбирает оставшиеся jobs. Worker сам шифрует Web Push payload и отправляет его браузерному Push Service.

Firebase Functions не участвуют в этом пути. Папка `functions/` может оставаться в проекте для других функций сайта, но **для push её деплоить не нужно**. Старый `cloudflare-worker/` через FCM также не является production push backend.

## 10. Секреты

Никогда не коммитьте:

- `VAPID_PRIVATE_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- локальные `vapid-private.txt` / `sa.json`

В исправленном архиве удалены старые credential-файлы и вложенный zip с такими материалами.
