# Push при закрытом сайте — бесплатно, через Cloudflare Worker

Схема: сайт → Worker (Cloudflare) → push-сервис браузера → системное уведомление.
Firebase используется как RTDB/Auth-контур. Push и выдача защищённой Firebase-сессии выполняются через этот Worker; Firebase Functions и тариф Blaze не нужны для этих путей.

Понадобится: Node.js 18+, бесплатный аккаунт Cloudflare, доступ к консоли Firebase.

## 1. Установить wrangler и войти
```bash
npm install -g wrangler
wrangler login
cd push-worker
```

## 2. Ключи VAPID
Публичный ключ в `config.js` (`webPushVapidPublicKey`) и в `wrangler.toml` (`VAPID_PUBLIC_KEY`) должен быть ОДНИМ И ТЕМ ЖЕ и соответствовать приватному ключу Worker.

В этой исправленной сборке новая пара VAPID уже сгенерирована и public key прописан в обоих файлах. Приватная часть находится **вне архива проекта** в отдельном файле `KAPANI_VAPID_PRIVATE_KEY_2026-09-30.txt`; не добавляйте её в GitHub.

Если вы самостоятельно генерируете другую пару, используйте: 
```bash
node generate-vapid.mjs --apply
```
После этого обязательно запишите новый private key в Cloudflare Secret и опубликуйте изменённый `config.js`. При смене public key старые browser subscriptions будут пересозданы при следующем открытии сайта.

## 3. Создать хранилище подписок (KV)
```bash
wrangler kv namespace create PUSH_KV
```
В выводе будет `id = "..."` — вставьте его в `wrangler.toml` вместо `PASTE_KV_NAMESPACE_ID_HERE`.

## 4. Доступ Worker к базе (сервисный аккаунт)
Firebase Console → ⚙ Project settings → Service accounts → **Generate new private key** → скачается JSON.
(Если такой JSON у вас уже лежит секретом в старом воркере `kapani-free-push` — можно взять тот же.)
```bash
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```
и вставьте **всё содержимое JSON-файла**. Файл никуда не коммитьте и не выкладывайте — он даёт полный доступ к базе.

## 5. Приватный ключ VAPID
```bash
wrangler secret put VAPID_PRIVATE_KEY
```
(вставьте приватный ключ: из варианта А или из вывода `generate-vapid.mjs`).

## 6. Задеплоить
```bash
wrangler deploy
```
В конце будет адрес вида `https://kapani-push.<ваш-поддомен>.workers.dev`.

## 7. Проверить Worker
Откройте в браузере `https://kapani-push.<...>.workers.dev/health`. Должно быть:
```json
{"ok":true,"kv":true,"vapidPublic":true,"vapidPrivate":true,"vapid":{"publicOk":true,"privateOk":true,"pairOk":true},"serviceAccount":true,"subscribers":0,"devices":0}
```
Любое `false` — это то, что вы забыли настроить (шаги 2–5).

## 8. Подключить сайт

> В этой версии Worker также имеет `POST /session`: клиент использует его для выдачи Firebase custom token и больше не зависит от старого callable `issueKapaniSessionToken`. Для этого используется тот же `FIREBASE_SERVICE_ACCOUNT_JSON`, который уже нужен Worker для RTDB.
В `config.js`:
```js
pushWorkerUrl: "https://kapani-push.<ваш-поддомен>.workers.dev",
```
Выложите на GitHub Pages **три файла**: `index.html`, `config.js`, `firebase-messaging-sw.js`.
Затем один раз обновите страницу (Ctrl+F5 / перезапустите приложение на телефоне).

## 9. Включить push на устройстве и проверить
1. Профиль → «Push-уведомления» → «Включить» → разрешите уведомления.
2. В консоли браузера: `await getKapaniPushWorkerHealth()` — `devices` должно стать ≥ 1.
3. Профиль → «🧪 Проверить уведомления», и **сразу закройте вкладку** — должно прийти системное уведомление.
4. Настоящая проверка: закройте сайт полностью, со второго аккаунта напишите в ЛС и в общий чат — придёт push.

## Что происходит под капотом
* Сообщение/новость/уведомление → сайт отправляет Worker (`POST /event` или `/notify`). Worker сам создаёт задачу `pushOutbox/<id>` перед обработкой.
* Worker сам читает настоящее сообщение из базы (нельзя подделать чужой текст), пишет «🔔 Уведомления» всем адресатам
  (`users/<ник>/notifications/...`) и шлёт Web Push на все устройства адресатов.
* Не дошло сразу (обрыв сети и т.п.) — раз в минуту задачу подберёт cron Worker.
* Большая рассылка режется на пачки автоматически (лимиты бесплатного плана). `MAX_PUSH_PER_RUN` в `wrangler.toml`.

## Firebase Functions
Больше не нужны. Если они задеплоены — можно оставить (дублей не будет), можно удалить:
`firebase functions:delete notifyOnChatMessage notifyOnNewsCreated deliverKapaniWebPush ...`
Старая папка `cloudflare-worker/` (через FCM) — тоже устарела, `push-worker/` её заменяет.

## Если что-то не работает
| Симптом | Что делать |
|---|---|
| `/health` показывает `false` | не заданы секреты/KV: шаги 2–5, затем `wrangler deploy` |
| «Разрешение получено, но Push не зарегистрировался» | `wrangler tail` и снова «Включить»; ошибка `unauthorized` — зайдите в аккаунт заново (нужен хэш пароля в базе) |
| Ошибка `bad subscription` | нестандартный push-сервис; напишите мне endpoint из `getKapaniPushDiagnostics()` |
| Push приходит с задержкой до минуты | сработал cron вместо прямого вызова — смотрите `wrangler tail` |
| В логах `Exceeded CPU` (код 1102) | уменьшите `MAX_PUSH_PER_RUN` до 5 (или платный план Workers) |
| iPhone молчит | сайт должен быть добавлен «На экран Домой» и открыт оттуда (iOS 16.4+) |
| Сообщения в общем чате не попадают в «🔔 Уведомления» | Worker не может писать в базу: проверьте `serviceAccount` в `/health` и `wrangler tail` |

## Безопасность (важно знать)
* Вход на сайте проверяется на клиенте; Worker проверяет ник + хэш пароля из базы — ровно тот же уровень защиты, что у самого входа.
  Настоящая защита требует нормальной авторизации (например Firebase Auth), это отдельная задача.
* Секреты (`VAPID_PRIVATE_KEY`, JSON сервисного аккаунта) хранятся только в Cloudflare и в git не попадают.
* Сервисный аккаунт обходит правила RTDB. Правила базы Worker не ослабляет.


## OAuth key fix (если `/event` даёт Google OAuth 400)

Создайте НОВЫЙ private key для service account в Firebase Console: Project settings → Service accounts → Generate new private key. Затем замените secret Worker:

```bash
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON < sa.json
```

После этого задеплойте обновлённый `worker.js`. В этой версии JWT содержит `kid` из `private_key_id`, а ответ Google OAuth при ошибке больше не скрывается.

Важно: `sa.json` не должен находиться в репозитории или публиковаться.


## Быстрый реальный тест Push

После того как `/health` показывает `subscribers >= 1` и `devices >= 1`, можно проверить доставку напрямую, не создавая тестовую запись в RTDB:

```js
fetch('https://kapani-push.kapani.workers.dev/test', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    nick: 'ВАШ_НИК',
    ph: 'ВАШ_PASSWORD_HASH',
    title: 'Капани — тест Push',
    body: 'Если это уведомление появилось, Web Push работает.',
    category: 'system'
  })
}).then(r => r.json()).then(console.log)
```

Ожидаемый результат при одной рабочей подписке: `ok: true`, `devices: 1`, `sent: 1`.

`/test` требует те же `nick + ph`, что и `/subscribe`, и отправляет тест только устройствам этого пользователя. Приватные ключи в проект не входят и не должны добавляться в архив.

## Диагностика: «no eligible push device» (нет подходящего устройства)
Это значит: у получателя в Worker нет ни одного устройства, которое можно использовать. Теперь ответ `/event` сам объясняет причину
(поля `detail.hint` и `statuses`). Быстрая проверка в консоли браузера (F12 → Console) на сайте:
```js
await kapaniPushDoctor('ник_получателя')   // что не так у меня и у получателя
await kapaniPushSelfTest()                 // реальный push на мои устройства + ответы push-сервиса
```
Частые причины:
1. Получатель ни разу не нажал «Включить» после перехода на Worker.
2. **Одно устройство = один аккаунт.** Если в одном браузере зайти под двумя аккаунтами и включить push в обоих, устройство остаётся за последним.
3. Только что нажали «Включить» — хранилище KV обновляется до минуты. Подождите и повторите (задача сама повторится по cron).
4. Разные ключи VAPID в `config.js` и в `wrangler.toml` (или приватный ключ от другой пары) — `kapaniPushDoctor()` это покажет.

## Ошибка «atob() called with invalid base64-encoded data» / «push delivery failed»
Так выглядит испорченный секрет `VAPID_PRIVATE_KEY` (при вставке в консоль в конец попадает перенос строки `\r\n`, кавычки или подпись).
Теперь Worker сам чистит такие символы, а `/health` проверяет ключи по-настоящему:
```json
"vapid": {"publicOk":true,"privateOk":true,"pairOk":true}
```
* `privateOk:false` — секрет пустой или в нём мусор: `wrangler secret put VAPID_PRIVATE_KEY` и вставьте только 43 символа ключа.
* `pairOk:false` — приватный ключ от ДРУГОЙ пары, чем публичный в `wrangler.toml`/`config.js`. Выполните `node generate-vapid.mjs`,
  впишите публичный ключ в `wrangler.toml` и `config.js`, приватный — в секрет, затем `wrangler deploy` и выложите `config.js`.
  Устройства зарегистрируются заново сами при открытии сайта.

### Быстрое исправление ключей VAPID (рекомендуется, если `/health` показывает `privateOk:false` или `pairOk:false`)
В папке `push-worker`:
```
node generate-vapid.mjs --apply
```
Скрипт сам впишет новый публичный ключ в `wrangler.toml` и `../config.js`, а приватный сохранит в `vapid-private.txt` (там ТОЛЬКО ключ).
Дальше (выберите свою консоль):
```
cmd:         wrangler secret put VAPID_PRIVATE_KEY < vapid-private.txt
PowerShell:  Get-Content vapid-private.txt -Raw | wrangler secret put VAPID_PRIVATE_KEY
```
Затем `wrangler deploy`, выложить `config.js` на GitHub Pages и **удалить `vapid-private.txt`**.
