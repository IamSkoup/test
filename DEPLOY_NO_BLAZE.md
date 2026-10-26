# KAPANI — No Blaze deployment

В этой версии **Cloud Functions изменять/деплоить не нужно**.

Изменённые файлы:
- `index.html` — GitHub Pages
- `push-worker/worker.js` — Cloudflare Worker
- `database.rules.json` — только индексы RTDB; деплой правил опционален

## 1. GitHub Pages
Заменить существующий `index.html`.

## 2. Cloudflare Worker
Заменить `push-worker/worker.js` и выполнить из папки `push-worker`:

```bat
npx wrangler deploy
```

Существующие secrets не менять. Worker продолжает использовать уже настроенный `FIREBASE_SERVICE_ACCOUNT_JSON` и `VAPID_PRIVATE_KEY`.

Новые endpoint'ы Worker:
- `POST /session` — выдаёт Firebase custom token без Cloud Functions
- `POST /gift` — безопасно проводит подарок подписки через RTDB с серверной проверкой

## 3. RTDB indexes (необязательно)
Если нужно убрать предупреждения `Using an unspecified index`, можно один раз выполнить:

```bat
firebase deploy --only database
```

Это **не требует Blaze** и не деплоит Cloud Functions.

## 4. Cloud Functions
`firebase deploy --only functions` **не выполнять** для этой версии.

После загрузки сайта и Worker при обычном входе/защищённом действии клиент больше не вызывает `issueKapaniSessionToken`.
