# Kapani — архитектурный аудит и внесённые исправления

Дата: 2026-09-09

## Push / notification scope

В этом патче изменены: `functions/index.js`, `index.html`, `firebase-messaging-sw.js`, `manifest.json`, `README.md`, `DEPLOY.md`, `README_CHAT_NOTIFICATIONS.md`, `KAPANI_ARCHITECTURE_FIX_REPORT.md`.

Проверены без изменения: `firebase.json`, `functions/package.json`/lock, `cloudflare-worker/worker.js`, `wrangler.toml`, `config.js`, существующие RTDB/Firestore структуры. В архиве нет Firebase Rules-файлов, поэтому новые правила доступа не придумывались без миграции текущей auth-модели.

Cloudflare Worker оставлен без изменений: исходник помечает его как legacy/deprecated push bridge и он не используется в текущей активной server-side FCM pipeline.

## Такси
Исходный цикл был: GPS водителя → `update(orders/{id})` → общий listener заказов → повторная вставка tracking DOM → пересоздание Leaflet map/listener. Дополнительно tracking listener вызывал `setView()` при каждом обновлении координат.

Новый поток: GPS → один RTDB update координат → существующий listener → `setLatLng()` существующего маркера. Карта и tracking-listener создаются один раз на конкретный заказ/контейнер; GPS больше не приводит к пересозданию DOM, карты или listener.

Жизненный цикл такси: `pending → accepted → driver_arriving → in_progress → waiting_payment → paid`. После оплаты заказ переносится в `taxiHistory/{orderId}`, а `orders/{orderId}` удаляется одним multi-location update. Кнопка «Оплатить» показывается только при `waiting_payment`.

Добавлена проверка `runTransaction(...).committed` перед выплатой водителю. Также исправлена ошибка старой схемы отмены: при создании заказа баланс не резервировался, поэтому старый «возврат» мог фактически создавать деньги. Теперь отмена не возвращает цену заказа, а применяет только фактический штраф.

Добавлен блок истории поездок с датой, водителем, стоимостью, маршрутом и статусом «Завершено».

## Карта
Проект использует Leaflet. Видимые Leaflet-карты переведены на единый спутниковый helper `addSatelliteLayer()` с Esri World Imagery. Маркеры и GPS-логика сохранены.

## iOS PWA
Добавлена Safe Area-поддержка через `env(safe-area-inset-top)` и `env(safe-area-inset-bottom)` для header, основного контента и нижней навигации. Нижняя панель больше не сжимает 12 пунктов до невидимых размеров и поддерживает горизонтальное прокручивание. Кнопка КВЭ больше не скрывается `attachUserListener()`.

## Рекламщик
Существующее `invitedBy` сохранено. Для новых аккаунтов создаётся уникальный `referralCode` формата `KP-XXXXXXXXXX`; при регистрации можно указать отображаемое имя или referral code рекламщика.

Счётчик хранится в `advertiserStats/{nick}`, отображается в разделе «Работа», а в мэрии выводится список рекламщиков и количество приглашённых. Очистка выполняется только мэром, требует подтверждения, не удаляет пользователей и фиксирует `resetAt`, после чего новые приглашения продолжают учитываться.

## Чаты
Общий чат загружается только последними 80 сообщениями через RTDB query + `limitToLast(80)`. DM-инбокс переведён на `dmIndex/{nick}` вместо чтения всего `dms`; открытый диалог слушает последние 80 сообщений. После открытия диалога индекс помечается `unread=false`. Из рендера сообщений убрано лишнее чтение собственного профиля.

Один legacy full-read `dms` остаётся внутри проверки ежедневного задания. Это не listener UI чатов и оставлено для сохранения существующей семантики задания.

## «🛵 Мой транспорт»
Обработчик формы усилен проверками сессии и наличия поля, ограничением длины, обновлением локального cache и явным сообщением об ошибке. Главная причина ситуации, когда строка «не работала» при активном заказе, находилась в циклическом ререндере страницы таксиста; после стабилизации рендера GPS больше не уничтожает форму.

## Firebase Functions / Cloudflare Worker
Callable order functions в `functions/index.js` ожидают `request.auth.uid`, тогда как этот SPA использует собственную RTDB-модель входа по никнейму/паролю без Firebase Auth. Поэтому заказный client-path переведён на единый RTDB repository/fallback и больше не делает лишний callable→fallback круг.

`cloudflare-worker/worker.js` отвечает за FCM/RTDB proxy и не участвует в найденном taxi/map/chat UI-цикле, поэтому оставлен без изменений.

## Проверки
- 8 inline `<script>` блоков `index.html`: `node --check` — PASS.
- `functions/index.js`: `node --check` — PASS.
- В `index.html` 5 ожидаемых `L.map()` конструкторов.
- OSM tile layer удалён из Leaflet-карт.
- `clientTrackingMap.setView()` отсутствует в GPS-update обработчике.
- `get(chatRef())` отсутствует.
- Main DM inbox не читает весь `dms`.

## Безопасность
В архиве нет Firebase Realtime Database Rules. В Cloudflare worker есть допущение публичного доступа к RTDB. Это отдельный production security-риск. Rules не добавлялись в этот патч, потому что их нет в исходнике, а смена access model без миграции auth может заблокировать существующий сайт.
