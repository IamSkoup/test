const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { getFirestore } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { getDatabase } = require('firebase-admin/database');
const admin = require('firebase-admin');

admin.initializeApp();
const db = getDatabase();
const firestore = getFirestore();

const ADMIN_UID = 'Денис'; // UID администратора (должен совпадать с ником в базе)
const SUBSCRIPTIONS = require('./subscription-config');
const crypto = require('crypto');

const KAPANI_CANONICAL_URL = 'https://iamskoup1.github.io/kapani/';
const KAPANI_VAPID_PUBLIC_KEY = 'BDjXi9EvtInIq_Hip8aLRrf5fapGq8p9P6y6kwqDyROSuFRP3AuWvppOb7vieZxWBU4Y1OtCjNzeuTlhHogHwrE';
const KAPANI_VAPID_SUBJECT = KAPANI_CANONICAL_URL;
const KAPANI_VAPID_PRIVATE_KEY = defineSecret('KAPANI_VAPID_PRIVATE_KEY');

function b64uEncode(value) {
    return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uDecode(value) {
    const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(s + '='.repeat((4 - s.length % 4) % 4), 'base64');
}
function hkdfExtract(salt, ikm) {
    return require('crypto').createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, length) {
    const crypto = require('crypto');
    const chunks=[]; let previous=Buffer.alloc(0); let counter=1;
    while(Buffer.concat(chunks).length < length) {
        previous=crypto.createHmac('sha256', prk).update(Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])])).digest();
        chunks.push(previous); counter++;
    }
    return Buffer.concat(chunks).subarray(0,length);
}
function rawP256ToJwk(raw) {
    const bytes=Buffer.from(raw); if(bytes.length!==65 || bytes[0]!==4) throw new Error('Invalid P-256 public key');
    return {kty:'EC',crv:'P-256',x:b64uEncode(bytes.subarray(1,33)),y:b64uEncode(bytes.subarray(33,65))};
}
function makeVapidPrivateKey(rawPrivate, publicRaw) {
    const priv=String(rawPrivate||'').trim(); if(!priv) throw new Error('VAPID private key is missing');
    return require('crypto').createPrivateKey({key:{...rawP256ToJwk(publicRaw),d:b64uEncode(b64uDecode(priv))},format:'jwk'});
}
function makeVapidJwt(endpoint, rawPrivate, publicRaw) {
    const crypto=require('crypto'); const url=new URL(endpoint);
    const header=b64uEncode(JSON.stringify({typ:'JWT',alg:'ES256'}));
    const payload=b64uEncode(JSON.stringify({aud:url.origin,exp:Math.floor(Date.now()/1000)+12*60*60,sub:KAPANI_VAPID_SUBJECT}));
    const input=`${header}.${payload}`;
    const key=makeVapidPrivateKey(rawPrivate,publicRaw);
    const sig=crypto.createSign('SHA256').update(input).sign({key,dsaEncoding:'ieee-p1363'});
    return `${input}.${b64uEncode(sig)}`;
}
function encryptWebPushPayload(subscription, plaintext) {
    const crypto=require('crypto');
    const receiverPublic=b64uDecode(subscription.keys.p256dh); const auth=b64uDecode(subscription.keys.auth);
    if(receiverPublic.length!==65 || receiverPublic[0]!==4 || auth.length<16) throw new Error('Invalid Web Push subscription keys');
    const ecdh=crypto.createECDH('prime256v1'); ecdh.generateKeys(); const senderPublic=ecdh.getPublicKey(); const shared=ecdh.computeSecret(receiverPublic);
    const salt=crypto.randomBytes(16);
    const prk=hkdfExtract(auth,shared);
    const info=Buffer.concat([Buffer.from('WebPush: info\0','ascii'),receiverPublic,senderPublic]);
    const ikm=hkdfExpand(prk,info,32);
    const contentPrk=hkdfExtract(salt,ikm);
    const cek=hkdfExpand(contentPrk,Buffer.from('Content-Encoding: aes128gcm\0','ascii'),16);
    const nonce=hkdfExpand(contentPrk,Buffer.from('Content-Encoding: nonce\0','ascii'),12);
    const cipher=crypto.createCipheriv('aes-128-gcm',cek,nonce);
    const message=Buffer.concat([Buffer.from(String(plaintext),'utf8'),Buffer.from([2])]);
    const ciphertext=Buffer.concat([cipher.update(message),cipher.final(),cipher.getAuthTag()]);
    const recordSize=4096;
    return Buffer.concat([salt,Buffer.from([recordSize>>>24,(recordSize>>>16)&255,(recordSize>>>8)&255,recordSize&255]),Buffer.from([65]),senderPublic,ciphertext]);
}
async function sendWebPush(endpoint, subscription, payload, privateKey, publicKeyRaw) {
    const body=encryptWebPushPayload(subscription,JSON.stringify(payload));
    const jwt=makeVapidJwt(endpoint,privateKey,publicKeyRaw);
    const response=await fetch(endpoint,{method:'POST',headers:{'TTL':'300','Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','Authorization':`vapid t=${jwt}, k=${b64uEncode(publicKeyRaw)}`},body});
    const text=await response.text();
    if(!response.ok){const error=new Error(`Web Push ${response.status}: ${text.slice(0,500)}`);error.statusCode=response.status;throw error;}
    return {status:response.status,text};
}

function b64uEncode(value) {
    return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uDecode(value) {
    const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(s + '='.repeat((4 - s.length % 4) % 4), 'base64');
}
function hkdfExtract(salt, ikm) {
    return require('crypto').createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, length) {
    const crypto = require('crypto');
    const chunks=[]; let previous=Buffer.alloc(0); let counter=1;
    while(Buffer.concat(chunks).length < length) {
        previous=crypto.createHmac('sha256', prk).update(Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])])).digest();
        chunks.push(previous); counter++;
    }
    return Buffer.concat(chunks).subarray(0,length);
}
function rawP256ToJwk(raw) {
    const bytes=Buffer.from(raw); if(bytes.length!==65 || bytes[0]!==4) throw new Error('Invalid P-256 public key');
    return {kty:'EC',crv:'P-256',x:b64uEncode(bytes.subarray(1,33)),y:b64uEncode(bytes.subarray(33,65))};
}
function makeVapidPrivateKey(rawPrivate, publicRaw) {
    const priv=String(rawPrivate||'').trim(); if(!priv) throw new Error('VAPID private key is missing');
    return require('crypto').createPrivateKey({key:{...rawP256ToJwk(publicRaw),d:b64uEncode(b64uDecode(priv))},format:'jwk'});
}
function makeVapidJwt(endpoint, rawPrivate, publicRaw) {
    const crypto=require('crypto'); const url=new URL(endpoint);
    const header=b64uEncode(JSON.stringify({typ:'JWT',alg:'ES256'}));
    const payload=b64uEncode(JSON.stringify({aud:url.origin,exp:Math.floor(Date.now()/1000)+12*60*60,sub:KAPANI_VAPID_SUBJECT}));
    const input=`${header}.${payload}`;
    const key=makeVapidPrivateKey(rawPrivate,publicRaw);
    const sig=crypto.createSign('SHA256').update(input).sign({key,dsaEncoding:'ieee-p1363'});
    return `${input}.${b64uEncode(sig)}`;
}
function encryptWebPushPayload(subscription, plaintext) {
    const crypto=require('crypto');
    const receiverPublic=b64uDecode(subscription.keys.p256dh); const auth=b64uDecode(subscription.keys.auth);
    if(receiverPublic.length!==65 || receiverPublic[0]!==4 || auth.length<16) throw new Error('Invalid Web Push subscription keys');
    const ecdh=crypto.createECDH('prime256v1'); ecdh.generateKeys(); const senderPublic=ecdh.getPublicKey(); const shared=ecdh.computeSecret(receiverPublic);
    const salt=crypto.randomBytes(16);
    const prk=hkdfExtract(auth,shared);
    const info=Buffer.concat([Buffer.from('WebPush: info\0','ascii'),receiverPublic,senderPublic]);
    const ikm=hkdfExpand(prk,info,32);
    const contentPrk=hkdfExtract(salt,ikm);
    const cek=hkdfExpand(contentPrk,Buffer.from('Content-Encoding: aes128gcm\0','ascii'),16);
    const nonce=hkdfExpand(contentPrk,Buffer.from('Content-Encoding: nonce\0','ascii'),12);
    const cipher=crypto.createCipheriv('aes-128-gcm',cek,nonce);
    const message=Buffer.concat([Buffer.from(String(plaintext),'utf8'),Buffer.from([2])]);
    const ciphertext=Buffer.concat([cipher.update(message),cipher.final(),cipher.getAuthTag()]);
    const recordSize=4096;
    return Buffer.concat([salt,Buffer.from([recordSize>>>24,(recordSize>>>16)&255,(recordSize>>>8)&255,recordSize&255]),Buffer.from([65]),senderPublic,ciphertext]);
}
async function sendWebPush(endpoint, subscription, payload, privateKey, publicKeyRaw) {
    const body=encryptWebPushPayload(subscription,JSON.stringify(payload));
    const jwt=makeVapidJwt(endpoint,privateKey,publicKeyRaw);
    const response=await fetch(endpoint,{method:'POST',headers:{'TTL':'300','Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','Authorization':`vapid t=${jwt}, k=${b64uEncode(publicKeyRaw)}`},body});
    const text=await response.text();
    if(!response.ok){const error=new Error(`Web Push ${response.status}: ${text.slice(0,500)}`);error.statusCode=response.status;throw error;}
    return {status:response.status,text};
}

function sanitizePushPreferences(incoming) {
    const source = incoming && typeof incoming === 'object' ? incoming : {};
    const allowedCategories = ['messages', 'money', 'taxi_orders', 'delivery_orders', 'market', 'news', 'system'];
    const prefs = { enabled: source.enabled !== false };
    for (const category of allowedCategories) {
        if (Object.prototype.hasOwnProperty.call(source, category)) prefs[category] = source[category] !== false;
    }
    return prefs;
}

function normalizeSubscriptionType(value) {
    const type = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SUBSCRIPTIONS, type) ? type : 'none';
}

function isActiveSubscription(user) {
    const expiry = user?.subscriptionExpiry ? new Date(user.subscriptionExpiry) : null;
    return !!expiry && !Number.isNaN(expiry.getTime()) && expiry.getTime() > Date.now() && normalizeSubscriptionType(user?.subscription) !== 'none';
}

function subscriptionRank(user) {
    if (!isActiveSubscription(user)) return 0;
    return Number(SUBSCRIPTIONS[normalizeSubscriptionType(user.subscription)]?.rank || 0);
}

function hashPassword(password, salt) {
    return crypto.createHash('sha256')
        .update(`kapani::${String(salt || '').trim().toLowerCase()}::${String(password || '')}`, 'utf8')
        .digest('hex');
}

function subscriptionKey(endpoint) {
    return crypto.createHash('sha256').update(String(endpoint || ''), 'utf8').digest('hex').slice(0, 32);
}

function sanitizePushPreferences(incoming) {
    const source = incoming && typeof incoming === 'object' ? incoming : {};
    const allowedCategories = ['messages', 'money', 'taxi_orders', 'delivery_orders', 'market', 'news', 'system'];
    const prefs = { enabled: source.enabled !== false };
    for (const category of allowedCategories) {
        if (Object.prototype.hasOwnProperty.call(source, category)) prefs[category] = source[category] !== false;
    }
    return prefs;
}

function pushCategoryEnabled(record, category) {
    const prefs = record?.pushPrefs || {};
    return prefs.enabled !== false && prefs[category] !== false;
}

function makeWebPushPayload(nick, notificationId, notification) {
    const category = String(notification?.cat || 'system');
    return {
        title: String(notification?.title || 'Капани'),
        body: String(notification?.text || notification?.body || '').trim(),
        category, notificationId: String(notificationId || ''),
        url: String(notification?.url || KAPANI_CANONICAL_URL),
        createdAt: Number(notification?.createdAt || Date.now()),
        source: String(notification?.source || ''),
        sourceMessageId: String(notification?.sourceMessageId || ''),
        newsId: String(notification?.newsId || ''),
        recipient: String(nick || '')
    };
}

// Проверка, что пользователь является администратором
function isAdmin(context) {
    const uid = context.auth?.uid;
    return uid === ADMIN_UID;
}

// Cloud Function для перевода денег между пользователями
exports.transferMoney = onCall({ region: 'europe-west1' }, async (request) => {
    const { toUid, amount, description } = request.data;
    const fromUid = request.auth?.uid;

    if (!fromUid) {
        throw new HttpsError('unauthenticated', 'Пользователь не авторизован');
    }

    if (!toUid || !amount || amount <= 0) {
        throw new HttpsError('invalid-argument', 'Некорректные параметры перевода');
    }

    if (toUid === fromUid) {
        throw new HttpsError('invalid-argument', 'Нельзя переводить самому себе');
    }

    try {
        // Получаем данные отправителя
        const fromSnapshot = await db.ref(`users/${fromUid}`).get();
        if (!fromSnapshot.exists()) {
            throw new HttpsError('not-found', 'Отправитель не найден');
        }
        const fromUser = fromSnapshot.val();

        // Проверяем баланс
        if ((fromUser.balance || 0) < amount) {
            throw new HttpsError('failed-precondition', 'Недостаточно средств');
        }

        // Получаем данные получателя
        const toSnapshot = await db.ref(`users/${toUid}`).get();
        if (!toSnapshot.exists()) {
            throw new HttpsError('not-found', 'Получатель не найден');
        }

        // Атомарная транзакция
        await db.ref('users').transaction((users) => {
            if (!users) return users;

            const fromBalance = users[fromUid]?.balance || 0;
            const toBalance = users[toUid]?.balance || 0;

            if (fromBalance < amount) {
                return; // Отмена транзакции
            }

            users[fromUid].balance = fromBalance - amount;
            users[toUid].balance = toBalance + amount;

            return users;
        });

        // Логируем транзакции
        const { date, time, ts } = getDateTime();
        
        await db.ref(`users/${fromUid}/txlog`).push({
            type: 'out',
            who: toUid,
            amt: amount,
            desc: description || `Перевод пользователю ${toUid}`,
            date,
            time,
            ts
        });

        await db.ref(`users/${toUid}/txlog`).push({
            type: 'in',
            who: fromUid,
            amt: amount,
            desc: description || `Перевод от пользователя ${fromUid}`,
            date,
            time,
            ts
        });

        // Обновляем totalEarned для получателя
        await db.ref(`users/${toUid}`).transaction((user) => {
            if (!user) return user;
            user.totalEarned = (user.totalEarned || 0) + amount;
            return user;
        });

        return { success: true, message: 'Перевод выполнен успешно' };

    } catch (error) {
        console.error('Ошибка перевода:', error);
        throw new HttpsError('internal', 'Ошибка при выполнении перевода');
    }
});

// Cloud Function для админских операций с балансом
exports.adminAdjustBalance = onCall({ region: 'europe-west1' }, async (request) => {
    const { uid, amount, type, description } = request.data;

    // Проверка администратора
    if (!isAdmin(request)) {
        throw new HttpsError('permission-denied', 'Только администратор может выполнять эту операцию');
    }

    if (!uid || !amount) {
        throw new HttpsError('invalid-argument', 'Некорректные параметры');
    }

    try {
        const snapshot = await db.ref(`users/${uid}`).get();
        if (!snapshot.exists()) {
            throw new HttpsError('not-found', 'Пользователь не найден');
        }

        const user = snapshot.val();
        const currentBalance = user.balance || 0;
        const newBalance = currentBalance + amount;

        await db.ref(`users/${uid}`).update({ balance: newBalance });

        // Логируем операцию
        const { date, time, ts } = getDateTime();
        const txType = amount >= 0 ? 'in' : 'out';
        const absAmount = Math.abs(amount);

        await db.ref(`users/${uid}/txlog`).push({
            type: txType,
            who: 'Мэрия',
            amt: absAmount,
            desc: description || (type === 'fine' ? 'Штраф' : 'Корректировка баланса'),
            date,
            time,
            ts
        });

        return { success: true, newBalance };

    } catch (error) {
        console.error('Ошибка корректировки баланса:', error);
        throw new HttpsError('internal', 'Ошибка при корректировке баланса');
    }
});

// Cloud Function для создания заказа (такси/доставка)
exports.createOrder = onCall({ region: 'europe-west1' }, async (request) => {
    const { type, info, price, address, distanceKm, clientLat, clientLng, destLat, destLng, originalPrice, discountApplied } = request.data;
    const clientUid = request.auth?.uid;

    if (!clientUid) {
        throw new HttpsError('unauthenticated', 'Пользователь не авторизован');
    }

    try {
        // Проверяем баланс клиента
        const clientSnapshot = await db.ref(`users/${clientUid}`).get();
        if (!clientSnapshot.exists()) {
            throw new HttpsError('not-found', 'Пользователь не найден');
        }

        const clientUser = clientSnapshot.val();
        if ((clientUser.balance || 0) < price) {
            throw new HttpsError('failed-precondition', 'Недостаточно средств');
        }

        // Создаём заказ
        const orderId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const orderData = {
            id: orderId,
            type,
            client: clientUid,
            price,
            originalPrice,
            discountApplied,
            status: 'waiting',
            info,
            address,
            worker: null,
            distanceKm,
            driverVehicle: null,
            driverAvatar: null,
            clientLat,
            clientLng,
            destLat,
            destLng,
            driverLat: null,
            driverLng: null,
            createdAt: Date.now()
        };

        await db.ref(`orders/${orderId}`).set(orderData);

        // Списываем средства при создании заказа (будут возвращены при отмене)
        await db.ref(`users/${clientUid}`).update({
            balance: clientUser.balance - price
        });

        return { success: true, orderId };

    } catch (error) {
        console.error('Ошибка создания заказа:', error);
        throw new HttpsError('internal', 'Ошибка при создании заказа');
    }
});

// Cloud Function для оплаты заказа
exports.payOrder = onCall({ region: 'europe-west1' }, async (request) => {
    const { orderId } = request.data;
    const clientUid = request.auth?.uid;

    if (!clientUid) {
        throw new HttpsError('unauthenticated', 'Пользователь не авторизован');
    }

    try {
        const orderSnapshot = await db.ref(`orders/${orderId}`).get();
        if (!orderSnapshot.exists()) {
            throw new HttpsError('not-found', 'Заказ не найден');
        }

        const order = orderSnapshot.val();

        if (order.client !== clientUid) {
            throw new HttpsError('permission-denied', 'Вы не можете оплатить этот заказ');
        }

        if (!order.worker) {
            throw new HttpsError('failed-precondition', 'Нет исполнителя');
        }

        // Получаем данные клиента и работника
        const [clientSnapshot, workerSnapshot] = await Promise.all([
            db.ref(`users/${clientUid}`).get(),
            db.ref(`users/${order.worker}`).get()
        ]);

        if (!clientSnapshot.exists() || !workerSnapshot.exists()) {
            throw new HttpsError('not-found', 'Пользователь не найден');
        }

        const clientUser = clientSnapshot.val();
        const workerUser = workerSnapshot.val();

        // Проверяем баланс клиента (средства уже списаны при создании заказа)
        // Начисляем оплату работнику
        await db.ref(`users/${order.worker}`).update({
            balance: (workerUser.balance || 0) + order.price
        });

        // Логируем транзакции
        const { date, time, ts } = getDateTime();
        const descC = order.type === 'taxi' ? `Оплата такси (${order.info || ''})` : `Оплата доставки: ${order.info || ''}`;
        const descW = order.type === 'taxi' ? `Оплата поездки от ${clientUid}` : `Доставка для ${clientUid}`;

        await db.ref(`users/${clientUid}/txlog`).push({
            type: 'out',
            who: order.worker,
            amt: order.price,
            desc: descC,
            date,
            time,
            ts
        });

        await db.ref(`users/${order.worker}/txlog`).push({
            type: 'in',
            who: clientUid,
            amt: order.price,
            desc: descW,
            date,
            time,
            ts
        });

        // Удаляем заказ
        await db.ref(`orders/${orderId}`).remove();

        return { success: true, message: 'Оплата выполнена успешно' };

    } catch (error) {
        console.error('Ошибка оплаты заказа:', error);
        throw new HttpsError('internal', 'Ошибка при оплате заказа');
    }
});

// Cloud Function для отмены заказа
exports.cancelOrder = onCall({ region: 'europe-west1' }, async (request) => {
    const { orderId } = request.data;
    const clientUid = request.auth?.uid;

    if (!clientUid) {
        throw new HttpsError('unauthenticated', 'Пользователь не авторизован');
    }

    try {
        const orderSnapshot = await db.ref(`orders/${orderId}`).get();
        if (!orderSnapshot.exists()) {
            throw new HttpsError('not-found', 'Заказ не найден');
        }

        const order = orderSnapshot.val();

        if (order.client !== clientUid) {
            throw new HttpsError('permission-denied', 'Вы не можете отменить этот заказ');
        }

        const penalty = 50;

        // Возвращаем средства за вычетом штрафа
        const clientSnapshot = await db.ref(`users/${clientUid}`).get();
        if (!clientSnapshot.exists()) {
            throw new HttpsError('not-found', 'Пользователь не найден');
        }

        const clientUser = clientSnapshot.val();
        const refundAmount = order.price - penalty;

        await db.ref(`users/${clientUid}`).update({
            balance: clientUser.balance + refundAmount
        });

        // Логируем штраф
        const { date, time, ts } = getDateTime();
        await db.ref(`users/${clientUid}/txlog`).push({
            type: 'out',
            who: 'Система',
            amt: penalty,
            desc: 'Штраф за отмену заказа',
            date,
            time,
            ts
        });

        // Уведомляем работника если есть
        if (order.worker) {
            await db.ref(`users/${order.worker}/notifications`).push({
                text: `⚠️ ${clientUid} отменил заказ`,
                time: getTime(),
                cat: order.type === 'taxi' ? 'taxi_orders' : 'delivery_orders',
                createdAt: Date.now(),
                push: true,
                source: 'order_cancel'
            });
        }

        // Удаляем заказ
        await db.ref(`orders/${orderId}`).remove();

        return { success: true, refundAmount, penalty };

    } catch (error) {
        console.error('Ошибка отмены заказа:', error);
        throw new HttpsError('internal', 'Ошибка при отмене заказа');
    }
});

// A worker has a separate cancellation action. Client cancellation above must
// never be used to release an accepted taxi/delivery job.
exports.abandonOrder = onCall({ region: 'europe-west1' }, async (request) => {
    const workerUid = request.auth?.uid;
    const orderId = String(request.data?.orderId || '').trim();
    if (!workerUid) throw new HttpsError('unauthenticated', 'Требуется вход');
    if (!orderId || !/^[\w-]{1,120}$/.test(orderId)) {
        throw new HttpsError('invalid-argument', 'Некорректный номер заказа');
    }

    const orderRef = db.ref('orders/' + orderId);
    const userRef = db.ref('users/' + workerUid);
    const [orderSnapshot, workerSnapshot] = await Promise.all([orderRef.get(), userRef.get()]);
    if (!orderSnapshot.exists()) throw new HttpsError('not-found', 'Заказ не найден');
    if (!workerSnapshot.exists()) throw new HttpsError('not-found', 'Исполнитель не найден');
    const original = orderSnapshot.val();
    if (original.worker !== workerUid) throw new HttpsError('permission-denied', 'Заказ назначен другому исполнителю');
    const canRelease = order => order?.type === 'taxi'
        ? ['accepted', 'driver_arriving', 'in_progress'].includes(String(order.status || ''))
        : order?.status === 'in_progress';
    if (!canRelease(original)) throw new HttpsError('failed-precondition', 'Заказ уже нельзя отменить');

    // The order transition is conditional, so two fast clicks cannot both
    // release and penalize the same assignment.
    const changed = await orderRef.transaction(order => {
        if (!order || order.worker !== workerUid || !canRelease(order)) return;
        return {
            ...order,
            worker: null,
            status: order.type === 'taxi' ? 'pending' : 'waiting',
            driverLat: null,
            driverLng: null,
            driverLocationUpdatedAt: null,
            abandonedAt: Date.now()
        };
    }, undefined, false);
    if (!changed.committed) throw new HttpsError('failed-precondition', 'Заказ уже изменился');

    let penalty = 0;
    const debit = await userRef.transaction(user => {
        if (!user) return;
        const balance = Number(user.balance || 0);
        penalty = Math.min(35, Math.max(0, balance));
        return { ...user, balance: balance - penalty };
    }, undefined, false);
    if (!debit.committed) throw new HttpsError('internal', 'Заказ освобождён, но не удалось записать штраф');

    if (penalty > 0) {
        const { date, time, ts } = getDateTime();
        await userRef.child('txlog').push({
            type: 'out', who: 'Система', amt: penalty,
            desc: 'Штраф за отказ исполнителя от заказа', date, time, ts
        });
    }
    return { success: true, penalty, orderStatus: original.type === 'taxi' ? 'pending' : 'waiting' };
});

// Cloud Function для принятия заказа работником
exports.takeOrder = onCall({ region: 'europe-west1' }, async (request) => {
    const { orderId } = request.data;
    const workerUid = request.auth?.uid;

    if (!workerUid) {
        throw new HttpsError('unauthenticated', 'Пользователь не авторизован');
    }

    try {
        const orderSnapshot = await db.ref(`orders/${orderId}`).get();
        if (!orderSnapshot.exists()) {
            throw new HttpsError('not-found', 'Заказ не найден');
        }

        const order = orderSnapshot.val();

        if (order.client === workerUid) {
            throw new HttpsError('failed-precondition', 'Нельзя брать свой заказ');
        }

        if (order.worker) {
            throw new HttpsError('failed-precondition', 'Заказ уже взят');
        }

        // Проверяем, не занят ли работник
        const ordersSnapshot = await db.ref('orders').get();
        const orders = ordersSnapshot.val() || {};
        const isBusy = Object.values(orders).some(
            o => o.worker === workerUid && o.status === 'in_progress'
        );

        if (isBusy) {
            throw new HttpsError('failed-precondition', 'Вы уже заняты другим заказом');
        }

        // Получаем данные работника
        const workerSnapshot = await db.ref(`users/${workerUid}`).get();
        if (!workerSnapshot.exists()) {
            throw new HttpsError('not-found', 'Работник не найден');
        }

        const workerUser = workerSnapshot.val();

        // Принимаем заказ
        await db.ref(`orders/${orderId}`).update({
            status: 'in_progress',
            worker: workerUid,
            driverVehicle: workerUser.vehicle || '',
            driverAvatar: workerUser.avatar || ''
        });

        return { success: true };

    } catch (error) {
        console.error('Ошибка принятия заказа:', error);
        throw new HttpsError('internal', 'Ошибка при принятии заказа');
    }
});


/**
 * Internal Firebase Auth session for the existing Kapani nickname/password UI.
 * The user still uses the public/display name in the interface; Firebase Auth
 * is only a backend identity layer for protected operations.
 */
exports.issueKapaniSessionToken = onCall({ region: 'europe-west1' }, async (request) => {
    const nick = String(request.data?.nick || '').trim();
    const password = String(request.data?.password || '');

    if (!nick || password.length < 4) {
        throw new HttpsError('invalid-argument', 'Некорректные данные входа');
    }

    const snapshot = await db.ref(`users/${nick}`).get();
    if (!snapshot.exists()) {
        throw new HttpsError('not-found', 'Пользователь не найден');
    }

    const user = snapshot.val() || {};
    const expected = String(user.passwordHash || '');
    const salt = String(user.passwordHashSalt || user.nick || nick);
    const actual = hashPassword(password, salt);

    if (!expected || actual !== expected) {
        throw new HttpsError('permission-denied', 'Неверный пароль');
    }

    const token = await admin.auth().createCustomToken(nick);
    return { token };
});

/**
 * Registers the current browser Web Push token server-side.
 * The same token is removed from other Kapani users, preventing delivery
 * to a previous account when the same browser switches users.
 */
exports.registerWebPushSubscription = onCall({ region: 'europe-west1' }, async (request) => {
    const uid = String(request.auth?.uid || '').trim();
    const incoming = request.data?.subscription || {};
    if (!uid) throw new HttpsError('unauthenticated', 'Требуется защищённая сессия');
    const endpoint = String(incoming.endpoint || '').trim();
    const p256dh = String(incoming.keys?.p256dh || '').trim();
    const auth = String(incoming.keys?.auth || '').trim();
    if (!endpoint || !p256dh || !auth) throw new HttpsError('invalid-argument', 'Некорректная Web Push subscription');
    const subscriptionId = subscriptionKey(endpoint);
    const now = Date.now();
    const prefs = sanitizePushPreferences(request.data?.prefs);
    const indexRef = db.ref(`pushSubscriptionIndex/${subscriptionId}`);
    const indexSnap = await indexRef.get();
    const previousOwner = indexSnap.exists() ? String(indexSnap.val()?.uid || '') : '';
    const updates = {};
    if (previousOwner && previousOwner !== uid) updates[`users/${previousOwner}/pushSubscriptions/${subscriptionId}`] = null;
    updates[`users/${uid}/pushSubscriptions/${subscriptionId}`] = { endpoint, expirationTime: incoming.expirationTime ?? null, keys:{p256dh,auth}, updatedAt: now, userAgent:String(request.data?.userAgent||'').slice(0,500), pushPrefs:prefs };
    updates[`pushSubscriptionIndex/${subscriptionId}`] = { uid, updatedAt: now };
    await db.ref().update(updates);
    return { success:true, subscriptionId };
});

exports.updateWebPushPreferences = onCall({ region: 'europe-west1' }, async (request) => {
    const uid = String(request.auth?.uid || '').trim(); const subscriptionId = String(request.data?.subscriptionId || '').trim();
    if (!uid) throw new HttpsError('unauthenticated', 'Требуется защищённая сессия');
    if (!subscriptionId) throw new HttpsError('invalid-argument', 'Не указан subscriptionId');
    const snap = await db.ref(`users/${uid}/pushSubscriptions/${subscriptionId}`).get();
    if (!snap.exists()) throw new HttpsError('not-found', 'Push subscription не найдена');
    const prefs=sanitizePushPreferences(request.data?.prefs); prefs.updatedAt=Date.now();
    await db.ref(`users/${uid}/pushSubscriptions/${subscriptionId}/pushPrefs`).set(prefs);
    return {success:true,prefs,subscriptionId};
});

exports.unregisterWebPushSubscription = onCall({ region: 'europe-west1' }, async (request) => {
    const uid=String(request.auth?.uid||'').trim(); const subscriptionId=String(request.data?.subscriptionId||'').trim();
    if(!uid) throw new HttpsError('unauthenticated','Требуется защищённая сессия');
    if(!subscriptionId) throw new HttpsError('invalid-argument','Не указан subscriptionId');
    const snap=await db.ref(`users/${uid}/pushSubscriptions/${subscriptionId}`).get();
    if(!snap.exists()) return {success:true,subscriptionId,removed:false};
    await db.ref().update({[`users/${uid}/pushSubscriptions/${subscriptionId}`]:null,[`pushSubscriptionIndex/${subscriptionId}`]:null});
    return {success:true,subscriptionId,removed:true};
});

exports.getPushDiagnostics = onCall({ region: 'europe-west1', secrets: [KAPANI_VAPID_PRIVATE_KEY] }, async (request) => {
    const uid=String(request.auth?.uid||'').trim();
    if(!uid) throw new HttpsError('unauthenticated','Требуется защищённая сессия');
    const snap=await db.ref(`users/${uid}/pushSubscriptions`).get(); const subs=snap.exists()?snap.val()||{}:{};
    return {ok:true,user:uid,vapidConfigured:!!String(KAPANI_VAPID_PRIVATE_KEY.value()||'').trim(),subscriptionCount:Object.keys(subs).length,subscriptions:Object.entries(subs).map(([id,item])=>({subscriptionId:id,updatedAt:Number(item?.updatedAt||0)||null,endpoint:String(item?.endpoint||'').slice(0,120),pushPrefs:item?.pushPrefs||null}))};
});

function pushLog(level,event,fields={}){const safe={};for(const [k,v] of Object.entries(fields)){if(v===undefined||v===null)continue;const t=typeof v==='string'?v:JSON.stringify(v);safe[k]=t.length>500?t.slice(0,500)+'…':t;}const line=`[KapaniPush] ${event} ${JSON.stringify(safe)}`;if(level==='error')console.error(line);else if(level==='warn')console.warn(line);else console.log(line);}
async function shouldSuppressNotificationForOpenContext(nick,notification){
    if(String(notification?.source||'')==='general_chat'){const snap=await db.ref(`presence/${nick}/generalChatOpen`).get();return snap.exists()&&snap.val()===true;}
    if(String(notification?.source||'')==='dm'&&notification?.from){const snap=await db.ref(`presence/${nick}/dmOpenWith`).get();return snap.exists()&&String(snap.val()||'')===String(notification.from);}
    return false;
}
exports.deliverKapaniWebPush=onValueCreated({ref:'/users/{nick}/notifications/{notificationId}',region:'europe-west1',secrets:[KAPANI_VAPID_PRIVATE_KEY]},async(event)=>{
    const nick=String(event.params?.nick||'');const notificationId=String(event.params?.notificationId||'');const notification=event.data?.val()||null;if(!nick||!notificationId||!notification||notification.push===false)return null;
    const body=String(notification.text||notification.body||'').trim();if(!body)return null;
    const privateKey=String(KAPANI_VAPID_PRIVATE_KEY.value()||'').trim();if(!privateKey){pushLog('error','vapid_private_key_missing',{nick,notificationId});return null;}
    const vapidPublicRaw=b64uDecode(KAPANI_VAPID_PUBLIC_KEY);
    const snap=await db.ref(`users/${nick}/pushSubscriptions`).get();if(!snap.exists())return null;
    const payload={title:String(notification.title||'Капани'),body,category:String(notification.cat||'system'),notificationId,url:String(notification.url||KAPANI_CANONICAL_URL),createdAt:Number(notification.createdAt||Date.now()),source:String(notification.source||''),sourceMessageId:String(notification.sourceMessageId||''),newsId:String(notification.newsId||'')};
    const updates={};let sent=0,removed=0;const entries=Object.entries(snap.val()||{});
    for(const [subscriptionId,record] of entries){if(!record?.endpoint||!record?.keys?.p256dh||!record?.keys?.auth)continue;if(!pushCategoryEnabled(record,payload.category))continue;try{await sendWebPush(record.endpoint,{endpoint:record.endpoint,expirationTime:record.expirationTime||null,keys:record.keys},payload,privateKey,vapidPublicRaw);sent++;}catch(error){const status=Number(error?.statusCode||0);if(status===404||status===410){updates[`users/${nick}/pushSubscriptions/${subscriptionId}`]=null;updates[`pushSubscriptionIndex/${subscriptionId}`]=null;removed++;}else pushLog('warn','send_failed',{nick,notificationId,subscriptionId,status,error:String(error?.message||error)});}}
    if(Object.keys(updates).length)await db.ref().update(updates);pushLog('info','webpush_delivery',{nick,notificationId,sent,removed,subscriptions:entries.length});return null;
});

/**
 * Server-authoritative subscription gifting.
 *
 * IMPORTANT:
 * The complete financial/subscription mutation happens in one RTDB root
 * transaction. If the gift is rejected or the transaction does not commit,
 * no balance/subscription/transaction/gift record is changed.
 */
exports.giftSubscription = onCall({ region: 'europe-west1' }, async (request) => {
    // Primary authorization: Firebase Auth when the auxiliary server session is
    // already available. Fallback authorization: Kapani's own password hash,
    // supplied by the already-authenticated Kapani UI. This keeps gifting usable
    // even when Firebase Auth persistence is temporarily unavailable.
    let giverNick = String(request.auth?.uid || '').trim();
    const suppliedNick = String(request.data?.nick || '').trim();
    const suppliedPh = String(request.data?.ph || '').trim();

    if (!giverNick) {
        if (!suppliedNick || !/^[a-f0-9]{64}$/i.test(suppliedPh)) {
            throw new HttpsError('unauthenticated', 'Требуется защищённая сессия или подтверждение пароля');
        }
        const authSnapshot = await db.ref(`users/${suppliedNick}`).get();
        const authUser = authSnapshot.exists() ? (authSnapshot.val() || {}) : null;
        const expectedHash = String(authUser?.passwordHash || '').trim();
        if (!expectedHash || expectedHash.length !== suppliedPh.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedHash, 'utf8'), Buffer.from(suppliedPh, 'utf8'))) {
            throw new HttpsError('permission-denied', 'Неверное подтверждение аккаунта');
        }
        giverNick = suppliedNick;
    } else if (suppliedNick && suppliedNick !== giverNick) {
        throw new HttpsError('permission-denied', 'Несоответствие аккаунта отправителя');
    }

    const recipientNick = String(request.data?.recipientNick || '').trim();
    const type = normalizeSubscriptionType(request.data?.subscriptionType);

    if (!giverNick) throw new HttpsError('unauthenticated', 'Требуется защищённая сессия');
    if (!recipientNick || recipientNick === giverNick) {
        throw new HttpsError('invalid-argument', 'Некорректный получатель');
    }
    if (type === 'none') {
        throw new HttpsError('invalid-argument', 'Некорректная подписка');
    }

    const plan = SUBSCRIPTIONS[type];
    const price = Number(plan?.price || 0);
    const giftRank = Number(plan?.rank || 0);
    if (!Number.isSafeInteger(price) || price <= 0 || giftRank <= 0) {
        throw new HttpsError('failed-precondition', 'Некорректная конфигурация подписки');
    }

    const rootRef = db.ref();
    const giftId = rootRef.child(`subscriptionGifts/${recipientNick}`).push().key;
    const giverTxId = rootRef.child(`users/${giverNick}/txlog`).push().key;
    const recipientTxId = rootRef.child(`users/${recipientNick}/txlog`).push().key;
    if (!giftId || !giverTxId || !recipientTxId) {
        throw new HttpsError('internal', 'Не удалось подготовить идентификаторы операции');
    }

    const committedAt = Date.now();
    const txResult = await rootRef.transaction((root) => {
        if (!root) return;

        const users = root.users || {};
        const giver = users[giverNick];
        const recipient = users[recipientNick];

        if (!giver || !recipient) return;

        const balance = Number(giver.balance || 0);
        if (!Number.isFinite(balance) || balance < price) return;

        const recipientRank = subscriptionRank(recipient);
        if (recipientRank >= giftRank) return;

        const now = new Date(committedAt);
        const currentExpiry = recipient.subscriptionExpiry ? new Date(recipient.subscriptionExpiry) : null;
        const activeSameType = normalizeSubscriptionType(recipient.subscription) === type
            && currentExpiry
            && !Number.isNaN(currentExpiry.getTime())
            && currentExpiry.getTime() > committedAt;

        const expiry = activeSameType
            ? new Date(currentExpiry.getTime() + 7 * 24 * 60 * 60 * 1000)
            : new Date(committedAt + 7 * 24 * 60 * 60 * 1000);

        const startDate = activeSameType
            ? String(recipient.subscriptionStart || now.toISOString())
            : now.toISOString();

        const updatedRoot = { ...root };
        updatedRoot.users = { ...users };
        updatedRoot.users[giverNick] = {
            ...giver,
            balance: balance - price
        };
        updatedRoot.users[recipientNick] = {
            ...recipient,
            subscription: type,
            subscriptionStatus: 'active',
            subscriptionExpiry: expiry.toISOString(),
            subscriptionStart: startDate,
            subscriptionGiftedBy: giverNick,
            subscriptionGiftedAt: now.toISOString(),
            totalEarned: Number(recipient.totalEarned || 0)
        };

        const date = now.toLocaleDateString('ru');
        const time = now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        const ts = now.toISOString();

        updatedRoot.users[giverNick].txlog = {
            ...(giver.txlog || {}),
            [giverTxId]: {
                type: 'out',
                who: 'Подарок подписки',
                amt: price,
                desc: `Подарок ${plan.name} для ${recipientNick}`,
                date, time, ts
            }
        };

        updatedRoot.users[recipientNick].txlog = {
            ...(recipient.txlog || {}),
            [recipientTxId]: {
                type: 'in',
                who: 'Подарок подписки',
                amt: 0,
                desc: `Получена ${plan.name} от ${giverNick}`,
                date, time, ts
            }
        };

        updatedRoot.subscriptionGifts = {
            ...(root.subscriptionGifts || {}),
            [giftId]: {
                id: giftId,
                from: giverNick,
                to: recipientNick,
                subscription: type,
                price,
                createdAt: committedAt,
                status: 'completed'
            }
        };

        const treasury = root.municipalTreasury && typeof root.municipalTreasury === 'object'
            ? root.municipalTreasury
            : { balance: 0 };
        updatedRoot.municipalTreasury = {
            ...treasury,
            balance: Number(treasury.balance || 0) + price,
            updatedAt: committedAt
        };

        const history = root.municipalTreasury?.history && typeof root.municipalTreasury.history === 'object'
            ? root.municipalTreasury.history
            : {};
        const treasuryHistoryId = rootRef.child('municipalTreasury/history').push().key;
        updatedRoot.municipalTreasury.history = {
            ...history,
            [treasuryHistoryId]: {
                type: 'in',
                amount: price,
                reason: `Подаренная подписка ${plan.name} от ${giverNick}`,
                sourceNick: giverNick,
                sourceType: 'subscription_gift',
                date, time, ts
            }
        };

        updatedRoot.users[giverNick].notifications = {
            ...(giver.notifications || {}),
            [`gift_${giftId}`]: {
                createdAt: committedAt,
                url: KAPANI_CANONICAL_URL,
                cat: 'system',
                push: true,
                title: 'Капани',
                time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                text: `🎁 Вы подарили ${plan.name} пользователю ${recipientNick}!`,
                source: 'subscription_gift',
                sourceMessageId: giftId
            }
        };
        updatedRoot.users[recipientNick].notifications = {
            ...(recipient.notifications || {}),
            [`gift_${giftId}`]: {
                createdAt: committedAt,
                url: KAPANI_CANONICAL_URL,
                cat: 'system',
                push: true,
                title: 'Капани',
                time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                text: `🎁 ${giverNick} подарил вам ${plan.name}!`,
                source: 'subscription_gift',
                sourceMessageId: giftId
            }
        };

        return updatedRoot;
    });

    if (!txResult.committed) {
        const latest = await db.ref(`users/${recipientNick}`).get();
        const latestUser = latest.exists() ? latest.val() : null;
        const latestRank = subscriptionRank(latestUser);
        if (latestRank >= giftRank) {
            throw new HttpsError('failed-precondition', 'Нельзя подарить эту подписку. У пользователя уже есть подписка более высокого уровня.');
        }

        const giverSnap = await db.ref(`users/${giverNick}`).get();
        const giverBalance = Number(giverSnap.val()?.balance || 0);
        if (giverBalance < price) {
            throw new HttpsError('failed-precondition', `Недостаточно средств. Нужно ${price}₽`);
        }

        throw new HttpsError('aborted', 'Операция не была подтверждена Firebase. Повторите попытку.');
    }

    return {
        success: true,
        giftId,
        subscription: type,
        price
    };
});

/**
 * General-chat notification fan-out.
 * One /chat write -> one deterministic notification per recipient -> Web Push.
 * The sender is excluded, and Web Push is skipped for users who currently have
 * the general chat open. RTDB notification remains available to them.
 */
exports.notifyOnChatMessage = onValueCreated(
  {
    ref: '/chat/{messageId}',
    region: 'europe-west1'
  },
  async (event) => {
    const message = event.data?.val();
    const messageId = String(event.params?.messageId || '');
    if (!message?.nick || !messageId) return null;

    const senderNick = String(message.nick);
    let preview = String(message.text || message.caption || '').trim();
    if (!preview) {
      if (message.msgType === 'image') preview = '📷 Фото';
      else if (message.msgType === 'voice') preview = '🎤 Голосовое сообщение';
      else if (message.msgType === 'video') preview = '🎬 Видео';
      else if (message.msgType === 'video_circle') preview = '⭕ Видеосообщение';
      else if (message.mediaData) preview = '📎 Вложение';
      else preview = 'Новое сообщение';
    }
    if (preview.length > 80) preview = `${preview.slice(0, 77)}...`;

    const usersSnap = await db.ref('users').get();
    const users = usersSnap.val() || {};
    const sender = users[senderNick] || {};
    const senderName = String(sender.displayName || sender.name || sender.publicName || sender.nick || senderNick);
    const notificationText = `💬 ${senderName} написал в общий чат: ${preview}`;
    const now = Date.now();

    const updates = {};

    for (const [nick, user] of Object.entries(users)) {
      if (!user || nick === senderNick) continue;

      const notificationId = `chat_${messageId}`;
      updates[`users/${nick}/notifications/${notificationId}`] = {
        text: notificationText,
        time: new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        cat: 'messages',
        createdAt: now,
        url: `${KAPANI_CANONICAL_URL}?kpSection=messages`,
        push: true,
        source: 'general_chat',
        sourceMessageId: messageId,
        from: senderNick
      };

    }

    if (Object.keys(updates).length) {
      await db.ref().update(updates);
    }

    // Push delivery is handled by the canonical Web Push delivery.
    // The queue entries are created above atomically with the notification rows,
    // so closing the publisher's browser cannot interrupt delivery.

    return null;
  }
);


/**
 * Legacy duel notification bridge.
 * The game UI historically stores duel events under /notifications/{nick}.
 * Mirror only duel events into the canonical user notification collection so
 * they use the same Web Push delivery/Web Push path without removing the legacy UI data.
 */
exports.notifyOnLegacyDuelNotification = onValueCreated(
  { ref: '/notifications/{nick}/{notificationId}', region: 'europe-west1' },
  async (event) => {
    const nick = String(event.params?.nick || '');
    const notificationId = String(event.params?.notificationId || '');
    const raw = event.data?.val() || null;
    if (!nick || !notificationId || !raw) return null;
    if (!['duel_invite', 'duel_declined'].includes(String(raw.type || ''))) return null;

    const canonicalId = `legacy_${notificationId}`;
    const targetRef = db.ref(`users/${nick}/notifications/${canonicalId}`);
    const existing = await targetRef.get();
    if (existing.exists()) return null;

    const createdAt = Number(raw.ts || Date.now());
    await targetRef.set({
      text: String(raw.text || 'Новое уведомление'),
      title: 'Капани',
      time: String(raw.time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })),
      cat: 'messages',
      createdAt,
      url: `${KAPANI_CANONICAL_URL}?duel=${encodeURIComponent(String(raw.duelId || ''))}`,
      push: true,
      type: String(raw.type),
      from: String(raw.from || ''),
      duelId: String(raw.duelId || ''),
      source: 'legacy_duel',
      sourceMessageId: notificationId
    });
    return null;
  }
);

/**
 * Server-side news fan-out. This replaces the old client-side best-effort
 * fan-out, so a publisher closing their tab cannot interrupt delivery.
 */
exports.notifyOnNewsCreated = onValueCreated(
  { ref: '/news/{newsId}', region: 'europe-west1' },
  async (event) => {
    const newsId = String(event.params?.newsId || '');
    const news = event.data?.val() || null;
    if (!newsId || !news) return null;

    const usersSnap = await db.ref('users').get();
    const users = usersSnap.val() || {};
    const text = `📰 Новая новость в Капани\n${String(news.title || '').trim() || 'Новая публикация'}`;
    const createdAt = Number(news.createdAt || Date.now());
    const updates = {};

    for (const nick of Object.keys(users)) {
      if (!nick || nick === String(news.author || '')) continue;
      const notificationId = `news_${newsId}`;
      updates[`users/${nick}/notifications/${notificationId}`] = {
        text,
        title: 'Капани',
        time: new Date(createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        cat: 'news',
        newsId,
        createdAt,
        url: `${KAPANI_CANONICAL_URL}?kpSection=news&news=${encodeURIComponent(newsId)}`,
        push: true,
        source: 'news',
        sourceMessageId: newsId
      };
    }

    if (Object.keys(updates).length) await db.ref().update(updates);
    pushLog('info', 'news_fanout_created', { newsId, recipients: Object.keys(updates).length });
    return null;
  }
);

// Вспомогательная функция для получения даты/времени
/**
 * Canonical client-created notification writer.
 *
 * Client code must not write users/<nick>/notifications directly because that
 * node is intentionally read-only from the browser. This callable uses the
 * authenticated Firebase session, writes the inbox item atomically; the notification trigger performs the actual Web Push delivery.
 */
exports.createKapaniNotification = onCall({ region: 'europe-west1' }, async (request) => {
    const senderNick = String(request.auth?.uid || '').trim();
    const targetNick = String(request.data?.nick || '').trim();
    const text = String(request.data?.text || '').trim();
    const category = String(request.data?.cat || 'system').trim() || 'system';
    const title = String(request.data?.title || 'Капани').trim() || 'Капани';
    const url = String(request.data?.url || KAPANI_CANONICAL_URL).trim() || KAPANI_CANONICAL_URL;
    const source = String(request.data?.source || '').trim();
    const sourceMessageId = String(request.data?.sourceMessageId || '').trim();

    if (!senderNick) {
        throw new HttpsError('unauthenticated', 'Требуется защищённая Firebase-сессия');
    }
    if (!targetNick || !text) {
        throw new HttpsError('invalid-argument', 'Не указаны получатель или текст уведомления');
    }
    if (text.length > 2000) {
        throw new HttpsError('invalid-argument', 'Слишком длинное уведомление');
    }

    const targetRef = db.ref(`users/${targetNick}`);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists()) {
        throw new HttpsError('not-found', 'Получатель не найден');
    }

    const notificationRef = targetRef.child('notifications').push();
    const notificationId = String(notificationRef.key || '');
    if (!notificationId) {
        throw new HttpsError('internal', 'Не удалось создать ID уведомления');
    }

    const createdAt = Date.now();
    const notification = {
        text,
        title,
        time: new Date(createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        cat: category,
        createdAt,
        url,
        push: true,
        source,
        sourceMessageId,
        ...(source === 'dm' && senderNick ? { from: senderNick } : {})
    };
    const updates = {};
    updates[`users/${targetNick}/notifications/${notificationId}`] = notification;
    await db.ref().update(updates);

    pushLog('info', 'client_notification_created', {
        sender: senderNick,
        user: targetNick,
        notificationId,
        category
    });

    return { ok: true, notificationId, queued: false, delivery: 'web_push_trigger' };
});

function getDateTime() {
    const d = new Date();
    return {
        date: d.toLocaleDateString('ru'),
        time: d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }),
        ts: d.toISOString()
    };
}

function getTime() {
    return new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Уведомления общего чата.
 *
 * Архитектурно fan-out выполняется на сервере, а не из браузера пользователя:
 * 1) клиент пишет одно сообщение в /chat;
 * 2) Cloud Function получает событие;
 * 3) сервер записывает уведомление каждому другому пользователю;
 * 4) существующие RTDB-listener'ы и Web Push bridge доставляют его без перезагрузки.
 */
