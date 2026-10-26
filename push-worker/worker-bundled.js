// Generated from worker.js and the shared catalogue. Rebuild with node build-dashboard.mjs.
/* Shared Kapani subscription catalogue.
 * Browser: window.KAPANI_SUBSCRIPTIONS
 * Node: require('./subscription-config')
 */
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  if (root) root.KAPANI_SUBSCRIPTIONS = Object.freeze(value);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const catalogue = {
    none:  { rank: 0, price: 0,    name: 'Без подписки',    durationDays: 0 },
    plus:  { rank: 1, price: 299,  name: 'Kapani Plus',    durationDays: 7 },
    ultra: { rank: 2, price: 899,  name: 'Kapani Ultra',   durationDays: 7 },
    prime: { rank: 3, price: 1499, name: 'Kapani Prime',   durationDays: 7 }
  };
  const normalize = value => {
    const type = String(value || '').trim().toLowerCase();
    return ['plus','ultra','prime'].includes(type) ? type : 'none';
  };
  const active = (user, now = Date.now()) => normalize(user?.subscription) !== 'none' && new Date(user?.subscriptionExpiry || 0).getTime() > now;
  Object.defineProperties(catalogue, {
    normalizeType: {value: normalize},
    isActiveSubscription: {value: active},
    activeRank: {value: (user, now = Date.now()) => active(user, now) ? catalogue[normalize(user.subscription)].rank : 0}
  });
  for (const plan of Object.values(catalogue)) Object.freeze(plan);
  return catalogue;
});

/**
 * Kapani free Web Push — Cloudflare Worker + Firebase Spark (no Firebase Functions, no FCM SDK).
 *
 *   site ──► pushOutbox/<job> (RTDB) ──► POST /event ──► this Worker
 *                                                         ├─ reads the real message/notification from RTDB
 *                                                         ├─ writes inbox records users/<nick>/notifications/*
 *                                                         └─ sends Web Push (VAPID + aes128gcm, WebCrypto)
 *   cron (every minute) re-processes jobs that were not delivered immediately.
 *
 * Bindings / config (see SETUP.md):
 *   KV  PUSH_KV                       — all push subscriptions live in the single key "subs"
 *   var FIREBASE_DATABASE_URL, VAPID_PUBLIC_KEY, VAPID_SUBJECT, APP_URL, ALLOWED_ORIGINS, MAX_PUSH_PER_RUN
 *   secret VAPID_PRIVATE_KEY, FIREBASE_SERVICE_ACCOUNT_JSON
 */

const te = new TextEncoder();
const enc = encodeURIComponent;
const PUSH_HOST_ALLOW = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|apple\.com|windows\.com)$/i;
const MAX_DEVICES_PER_USER = 8;
const CATEGORIES = ['messages', 'money', 'taxi_orders', 'delivery_orders', 'market', 'news', 'system'];

/* ───────────── small helpers ───────────── */
function b64uEnc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(str) {
  // Tolerant on purpose: secrets pasted by hand often carry CR/LF, spaces, quotes, "=" padding or the standard alphabet.
  let s = String(str || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Decodes a configured key and explains WHICH setting is malformed (instead of a bare atob() error). */
function decodeKey(name, value, expectedBytes, info) {
  let raw = String(value ?? '').trim();
  if (raw.startsWith('{')) {                                   // a JWK pasted as JSON: use its "d" (private) or x/y (public)
    try { const j = JSON.parse(raw); raw = String(j.d || ''); } catch { /* fall through to the checks below */ }
  }
  let s = raw.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!s) throw new Error(`${name} is empty — set it with "wrangler secret put ${name}"`);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    // Salvage a key that was pasted together with its label ("VAPID_PRIVATE_KEY (secret): <key>"): accept it only
    // when the text holds exactly ONE token of the right length. /health (pairOk) then proves it is the right key.
    const len = expectedBytes ? Math.ceil(expectedBytes * 4 / 3) : 0;
    const tokens = len ? [...new Set(raw.match(new RegExp(`(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_-]{${len}}(?![A-Za-z0-9_+/=-])`, 'g')) || [])] : [];
    if (tokens.length !== 1) throw new Error(`${name} contains characters that are not base64url (a label, PEM text or extra quotes were pasted?)`);
    s = tokens[0];
    if (info) info.salvaged = true;
  }
  if (s.length % 4 === 1) throw new Error(`${name} has an impossible length (${s.length}); it looks truncated or has extra characters`);
  const bytes = b64uDec(s);
  if (expectedBytes && bytes.length !== expectedBytes) throw new Error(`${name} must decode to ${expectedBytes} bytes, got ${bytes.length}`);
  return bytes;
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(String(str))));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const validNick = n => typeof n === 'string' && /^[^/.#$\[\]\s][^/.#$\[\]]{0,63}$/.test(n);
const validKey = k => typeof k === 'string' && /^[-\w]{3,80}$/.test(k);
function moscowTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}
function sanitizePrefs(src) {
  const s = src && typeof src === 'object' ? src : {};
  const p = { enabled: s.enabled !== false };
  for (const c of CATEGORIES) if (Object.prototype.hasOwnProperty.call(s, c)) p[c] = s[c] !== false;
  return p;
}
const prefsAllow = (sub, cat) => sub.prefs?.enabled !== false && sub.prefs?.[cat] !== false;
const vkOf = key => { try { return b64uEnc(decodeKey('VAPID_PUBLIC_KEY', key, 65)).slice(0, 16); } catch { return ''; } };
/** A device is usable when it is allowed by the user's settings and was created with THIS worker's VAPID key. */
const staleKey = (sub, env) => !!(sub.vk && vkOf(env.VAPID_PUBLIC_KEY) && sub.vk !== vkOf(env.VAPID_PUBLIC_KEY));

/* ───────────── HTTP plumbing ───────────── */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (request, env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...corsHeaders(request, env) } });

/* ───────────── Firebase RTDB over REST (service account OAuth2) ───────────── */
let tokenCache = { value: null, exp: 0 };
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp - now > 120) return tokenCache.value;

  let sa;
  try {
    sa = JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON || ''));
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing or not valid JSON');
  }
  if (!sa || sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new Error('service account JSON lacks type=service_account/client_email/private_key');
  }

  const tokenUri = String(sa.token_uri || 'https://oauth2.googleapis.com/token');
  if (tokenUri !== 'https://oauth2.googleapis.com/token') {
    throw new Error(`Unsupported service-account token_uri: ${tokenUri}`);
  }

  // Google-documented service-account JWT assertion header.
  // `kid` selects the exact public key matching `private_key_id`.
  const headerObj = {
    alg: 'RS256',
    typ: 'JWT',
    ...(sa.private_key_id ? { kid: String(sa.private_key_id) } : {})
  };
  const claimsObj = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: tokenUri,
    iat: now - 5,
    exp: now + 3595
  };
  const header = b64uEnc(te.encode(JSON.stringify(headerObj)));
  const claims = b64uEnc(te.encode(JSON.stringify(claimsObj)));

  const pem = String(sa.private_key)
    .replace(/\r/g, '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(pem)) throw new Error('service account private_key contains invalid characters');

  let der;
  try {
    der = Uint8Array.from(atob(pem.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  } catch {
    throw new Error('service account private_key is not valid base64');
  }

  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8', der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  } catch (e) {
    throw new Error(`service account private_key import failed: ${String(e?.message || e)}`);
  }

  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, te.encode(`${header}.${claims}`)
  ));
  const assertion = `${header}.${claims}.${b64uEnc(sig)}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!res.ok || !data.access_token) {
    const reason = [data?.error, data?.error_description].filter(Boolean).join(': ') || raw.slice(0, 300);
    console.error('Google OAuth token exchange failed', {
      status: res.status,
      error: data?.error,
      description: data?.error_description,
      serviceAccount: sa.client_email,
      keyId: sa.private_key_id || null
    });
    throw new Error(`Google OAuth failed: ${res.status}${reason ? ` — ${reason}` : ''}`);
  }

  tokenCache = {
    value: data.access_token,
    exp: Math.floor(Date.now() / 1000) + Math.max(300, Number(data.expires_in || 3600)) - 120
  };
  return tokenCache.value;
}

async function rtdb(env, method, path, body, query = '') {
  const base = String(env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
  const res = await fetch(`${base}/${path}.json${query}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RTDB ${method} ${path}: ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}
const rtdbGet = (env, path, query) => rtdb(env, 'GET', path, undefined, query);
const rtdbPatch = (env, patch) => (Object.keys(patch).length ? rtdb(env, 'PATCH', '', patch) : null);

async function rtdbGetWithEtag(env, path = '') {
  const base = String(env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
  const clean = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const url = clean ? `${base}/${clean}.json` : `${base}/.json`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'X-Firebase-ETag': 'true' }
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`RTDB GET+ETag ${path || '<root>'}: ${res.status} ${raw.slice(0, 200)}`);
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  return { value, etag: res.headers.get('ETag') || 'null_etag' };
}

async function rtdbPutIfMatch(env, path, value, etag) {
  const base = String(env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
  const clean = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const url = clean ? `${base}/${clean}.json` : `${base}/.json`;
  return await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${await accessToken(env)}`,
      'content-type': 'application/json',
      'If-Match': String(etag || 'null_etag')
    },
    body: JSON.stringify(value)
  });
}

async function rtdbRootTransaction(env, updater, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snap = await rtdbGetWithEtag(env, '');
    const decision = await updater(snap.value || {});
    if (!decision || decision.abort) return { committed: false, reason: decision?.reason || 'rejected' };

    const res = await rtdbPutIfMatch(env, '', decision.value, snap.etag);
    const raw = await res.text();
    if (res.status === 412 || res.status === 409) continue;
    if (!res.ok) throw new Error(`RTDB root conditional PUT: ${res.status} ${raw.slice(0, 240)}`);
    return { committed: true, attempts: attempt };
  }
  return { committed: false, reason: 'concurrent-write-retry-exhausted' };
}

let customTokenKeyCache = null;
async function createFirebaseCustomToken(env, uid) {
  let sa;
  try { sa = JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '')); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing or not valid JSON'); }
  if (!sa || sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new Error('service account JSON lacks type=service_account/client_email/private_key');
  }

  if (!customTokenKeyCache || customTokenKeyCache.privateKeyId !== String(sa.private_key_id || '')) {
    const pem = String(sa.private_key).replace(/\r/g, '').replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(pem.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    customTokenKeyCache = { privateKeyId: String(sa.private_key_id || ''), email: sa.client_email, key };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64uEnc(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(customTokenKeyCache.privateKeyId ? { kid: customTokenKeyCache.privateKeyId } : {}) })));
  const payload = b64uEnc(te.encode(JSON.stringify({
    iss: customTokenKeyCache.email,
    sub: customTokenKeyCache.email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: String(uid),
    claims: {admin:!!env.ADMIN_NICK && String(uid)===String(env.ADMIN_NICK)}
  })));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', customTokenKeyCache.key, te.encode(input)));
  return `${input}.${b64uEnc(sig)}`;
}

const SUBSCRIPTIONS = globalThis.KAPANI_SUBSCRIPTIONS;
function normalizeSubscriptionType(value){ return SUBSCRIPTIONS.normalizeType(value); }
function isActiveSubscription(user,now=Date.now()){ return SUBSCRIPTIONS.isActiveSubscription(user,now); }
function subscriptionRank(user){ return SUBSCRIPTIONS.activeRank(user); }
function giftIdPart(prefix = 'g') {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}_${a[0].toString(36)}${a[1].toString(36)}`;
}

/* Identity model = the site's own: nick + passwordHash that the site keeps in RTDB. */
async function verifyUser(env, nick, ph) {
  if (!validNick(nick) || typeof ph !== 'string' || ph.length < 32) return false;
  const real = await rtdbGet(env, `users/${enc(nick)}/passwordHash`);
  return typeof real === 'string' && safeEqual(real, ph);
}

/* ───────────── subscriptions in KV (single key) ───────────── */
async function loadSubs(env) {
  const current=await rtdbGet(env,'pushDevices');
  if(current?.accounts) return current.accounts;
  // One-time atomic migration from the legacy KV map (or an earlier flat RTDB map).
  const legacy=current||await env.PUSH_KV.get('subs','json')||{};
  const accounts=Object.fromEntries(Object.entries(legacy).filter(([,value])=>Array.isArray(value)));
  const snap=await rtdbGetWithEtag(env,'pushDevices');
  if(snap.value?.accounts) return snap.value.accounts;
  const res=await rtdbPutIfMatch(env,'pushDevices',{accounts,migratedAt:Date.now()},snap.etag);
  if(res.status===412) return await loadSubs(env);
  if(!res.ok) throw new Error('device migration failed');
  return accounts;
}
async function mutateSubs(env,updater){
  await loadSubs(env);
  for(let i=0;i<6;i++) {
    const snap=await rtdbGetWithEtag(env,'pushDevices'),record=snap.value||{accounts:{},migratedAt:Date.now()},all=record.accounts||{};
    await updater(all);
    const res=await rtdbPutIfMatch(env,'pushDevices',{...record,accounts:all},snap.etag);
    if(res.status===412) continue;
    if(!res.ok) throw new Error('device update failed');
    return all;
  }
  throw new Error('concurrent device update exhausted');
}

// Usernames in the site can arrive with harmless formatting differences
// (case/Unicode normalization/outer whitespace). Keep exact matching first,
// then allow a single unambiguous normalized match. Never pick arbitrarily if
// multiple accounts collide after normalization.
function normalizeNick(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}
function subscriptionBucketLocal(all, nick) {
  if (Array.isArray(all?.[nick])) {
    return { key: nick, subs: all[nick], mode: 'exact' };
  }

  const target = normalizeNick(nick);
  if (!target) return { key: null, subs: [], mode: 'none' };

  const keyMatches = Object.keys(all || {}).filter(k => normalizeNick(k) === target && Array.isArray(all[k]));
  if (keyMatches.length === 1) {
    return { key: keyMatches[0], subs: all[keyMatches[0]], mode: 'normalized' };
  }
  if (keyMatches.length > 1) {
    return { key: null, subs: [], mode: 'ambiguous', matches: keyMatches };
  }

  // Newer subscriptions carry aliases directly in the subscription record.
  const aliasMatches = [];
  for (const [key, list] of Object.entries(all || {})) {
    if (!Array.isArray(list)) continue;
    for (const sub of list) {
      if (normalizeNick(sub?.ownerNick) === target || normalizeNick(sub?.displayName) === target) {
        if (!aliasMatches.includes(key)) aliasMatches.push(key);
        break;
      }
    }
  }
  if (aliasMatches.length === 1) {
    return { key: aliasMatches[0], subs: all[aliasMatches[0]], mode: 'subscription-alias' };
  }

  return { key: null, subs: [], mode: aliasMatches.length > 1 ? 'ambiguous-alias' : 'none', matches: aliasMatches };
}

async function subscriptionBucket(env, all, nick) {
  const local = subscriptionBucketLocal(all, nick);
  if (local.key || local.mode === 'ambiguous' || local.mode === 'ambiguous-alias') return local;

  const target = normalizeNick(nick);
  if (!target) return local;

  // The site can address notifications by an editable display name while the
  // Push subscription is keyed by the immutable RTDB account key. Resolve the
  // display name against Firebase, then use that account key in PUSH_KV.
  // Prefer an indexed exact RTDB query so this remains cheap even with many users.
  try {
    const q = `?orderBy=${encodeURIComponent('\"displayName\"')}&equalTo=${encodeURIComponent(JSON.stringify(String(nick)))}`;
    const users = await rtdbGet(env, 'users', q);
    const matches = Object.keys(users || {}).filter(k => Array.isArray(all?.[k]) && normalizeNick(users[k]?.displayName) === target);
    if (matches.length === 1) {
      return { key: matches[0], subs: all[matches[0]], mode: 'firebase-displayName' };
    }
    if (matches.length > 1) {
      return { key: null, subs: [], mode: 'ambiguous-firebase-displayName', matches };
    }
  } catch (e) {
    console.warn('displayName subscription lookup failed', String(e?.message || e));
  }

  // Exact RTDB queries do not handle case differences. For the small set of
  // currently subscribed accounts, fall back to checking each owner's
  // displayName directly. This still never chooses an arbitrary device.
  const candidates = [];
  for (const key of Object.keys(all || {})) {
    if (!Array.isArray(all[key])) continue;
    try {
      const dn = await rtdbGet(env, `users/${enc(key)}/displayName`);
      if (normalizeNick(dn) === target) candidates.push(key);
      if (candidates.length > 1) break;
    } catch {}
  }
  if (candidates.length === 1) {
    return { key: candidates[0], subs: all[candidates[0]], mode: 'firebase-displayName-normalized' };
  }
  if (candidates.length > 1) {
    return { key: null, subs: [], mode: 'ambiguous-firebase-displayName', matches: candidates };
  }

  return local;
}

/* ───────────── Web Push: VAPID + aes128gcm (RFC 8291 / 8292) with WebCrypto ───────────── */
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
async function encryptPayload(sub, text) {
  let uaPub, auth;
  try { uaPub = b64uDec(sub.keys.p256dh); auth = b64uDec(sub.keys.auth); }
  catch (e) { const err = new Error('invalid subscription keys (p256dh/auth are not base64url)'); err.deadSub = true; throw err; }
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length < 16) { const err = new Error('invalid subscription keys'); err.deadSub = true; throw err; }
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(te.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0); head.set([0, 0, 0x10, 0], 16); head[20] = 65;      // record size 4096, key id length 65
  return concat(head, asPub, ct);
}
let vapidKey = null;
const jwtCache = new Map();
async function vapidJwt(env, endpoint) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 3600) return hit.jwt;
  if (!vapidKey) {
    const pub = decodeKey('VAPID_PUBLIC_KEY', env.VAPID_PUBLIC_KEY, 65);
    const d = decodeKey('VAPID_PRIVATE_KEY', env.VAPID_PRIVATE_KEY, 32);
    vapidKey = crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: b64uEnc(pub.subarray(1, 33)), y: b64uEnc(pub.subarray(33, 65)), d: b64uEnc(d), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).catch(e => { vapidKey = null; throw new Error('VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY (or is not a valid P-256 key): ' + String(e?.message || e).slice(0, 80)); });
  }
  const exp = now + 12 * 3600;
  const input = `${b64uEnc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64uEnc(te.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || env.APP_URL })))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey, te.encode(input)));
  const jwt = `${input}.${b64uEnc(sig)}`;
  jwtCache.set(aud, { jwt, exp });
  return jwt;
}

/** Real check of the configured VAPID pair (no key material is returned). */
async function vapidHealth(env) {
  const r = { publicOk: false, privateOk: false, pairOk: false };
  let pub, d;
  try { pub = decodeKey('VAPID_PUBLIC_KEY', env.VAPID_PUBLIC_KEY, 65); r.publicOk = true; } catch (e) { r.error = String(e.message); }
  const info = {};
  try { d = decodeKey('VAPID_PRIVATE_KEY', env.VAPID_PRIVATE_KEY, 32, info); r.privateOk = true; if (info.salvaged) r.note = 'VAPID_PRIVATE_KEY was pasted with extra text; the key was extracted automatically — re-set the secret with only the key when convenient'; } catch (e) { r.error = r.error ? r.error + ' | ' + e.message : String(e.message); }
  if (r.publicOk && r.privateOk) {
    try {
      const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64uEnc(pub.subarray(1, 33)), y: b64uEnc(pub.subarray(33, 65)), d: b64uEnc(d), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const data = te.encode('kapani-vapid-check');
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data);
      r.pairOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, data);
      if (!r.pairOk) r.error = 'VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY (they must be one generated pair)';
    } catch (e) { r.error = 'VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY (or is not a valid P-256 key): ' + String(e?.message || e).slice(0, 80); }
  }
  return r;
}

/** Returns the HTTP status of the push service. 404/410 = subscription is gone. */
async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {signal:AbortSignal.timeout(15000),
    method: 'POST',
    headers: {
      TTL: '86400', Urgency: 'high',
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${await vapidJwt(env, sub.endpoint)}, k=${b64uEnc(decodeKey('VAPID_PUBLIC_KEY', env.VAPID_PUBLIC_KEY, 65))}`
    },
    body
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

/* ───────────── jobs (pushOutbox/<jobId>) ───────────── */
const maxPush = env => Math.max(1, Math.min(3, Number(env.MAX_PUSH_PER_RUN) || 3));
const appUrl = env => String(env.APP_URL || 'https://iamskoup1.github.io/kapani/');

function payloadFromNotification(env, id, n) {
  return {
    title: String(n.title || 'Капани').slice(0, 120),
    body: String(n.text || n.body || '').trim().slice(0, 1000),
    category: String(n.cat || 'system'),
    notificationId: id,
    url: String(n.url || appUrl(env)),
    createdAt: Number(n.createdAt || Date.now()),
    source: String(n.source || ''), sourceMessageId: String(n.sourceMessageId || ''), newsId: String(n.newsId || '')
  };
}
function previewOf(m) {
  let p = String(m.text || m.caption || '').trim();
  if (!p) p = m.msgType === 'image' ? '📷 Фото' : m.msgType === 'voice' ? '🎤 Голосовое сообщение'
    : m.msgType === 'video' ? '🎬 Видео' : m.msgType === 'video_circle' ? '⭕ Видеосообщение' : m.mediaData ? '📎 Вложение' : 'Новое сообщение';
  return p.length > 80 ? p.slice(0, 77) + '...' : p;
}

/** Turns a job into a processing plan.
 * kind = done    -> process normally
 * kind = retry   -> keep the job; a required RTDB record is not visible yet
 * kind = discard -> the job is invalid, already handled, or explicitly suppressed
 */
async function planJob(env, job) {
  const now = Date.now();
  if (job.type === 'deliver') {
    return {
      kind: 'done',
      payload: job.payload,
      nicks: job.nicks || [],
      inbox: {},
      marks: job.marks || {}
    };
  }

  if (job.type === 'notification') {
    if (!validNick(job.to) || !validKey(job.id)) return { kind: 'discard', reason: 'invalid notification job' };

    const path = `users/${job.to}/notifications/${job.id}`;
    if (await rtdbGet(env, `notificationTombstones/${enc(job.to)}/${enc(job.id)}`)) return {kind:'discard',reason:'deleted notification'};
    const n = await rtdbGet(env, `users/${enc(job.to)}/notifications/${enc(job.id)}`);

    // The site can create pushOutbox/<jobId> and the notification record in two
    // separate RTDB writes. If /event arrives first, KEEP the job instead of
    // deleting it. Cron will retry it after the notification becomes visible.
    if (!n) return { kind: 'retry', reason: 'notification record not visible yet' };

    if (n.pushedAt && !Object.keys(job.delivered||{}).length) return {kind:'discard',reason:'notification already delivered'};
    if (n.deletedAt) return {kind:'discard',reason:'deleted notification'};
    if (n.push === false) return { kind: 'discard', reason: 'push disabled for notification' };

    const payload = payloadFromNotification(env, job.id, n);
    if (!payload.body) return { kind: 'discard', reason: 'notification has empty body' };

    if (n.source === 'dm' && n.from) {
      const presence = await rtdbGet(env, `presence/${enc(job.to)}`);
      if (presence?.dmOpenWith === n.from && now-Number(presence.updatedAt||0)<90000) {
        return {
          kind: 'done',
          payload,
          nicks: [],
          inbox: {},
          marks: { [`${path}/pushedAt`]: now }
        };
      }
    }

    return {
      kind: 'done',
      payload,
      nicks: [job.to],
      inbox: {},
      marks: { [`${path}/pushedAt`]: now }
    };
  }

  if (job.type === 'dm') {
    if (!validNick(job.to) || !validNick(job.sender) || !validKey(job.id) || !validKey(job.dmKey)) return {kind:'discard',reason:'invalid dm job'};
    const key = [job.sender,job.to].sort().join('__dm__');
    if (key !== job.dmKey) return {kind:'discard',reason:'invalid dm participants'};
    const msg = await rtdbGet(env, `dms/${enc(key)}/messages/${enc(job.id)}`);
    if (!msg) return {kind:'retry',reason:'dm missing'};
    if (msg.nick !== job.sender) return {kind:'discard',reason:'dm author mismatch'};
    const id = `dm_${job.id}`, path = `users/${job.to}/notifications/${id}`;
    const record = {title:'Капани',text:`💬 ${job.sender}: ${previewOf(msg)}`,cat:'messages',createdAt:Number(msg.createdAt||now),time:moscowTime(msg.createdAt||now),push:true,source:'dm',sourceMessageId:job.id,from:job.sender,url:`${appUrl(env)}?kpSection=messages&kpDm=${enc(job.sender)}`};
    const open = await rtdbGet(env, `presence/${enc(job.to)}`);
    const suppressed = open?.dmOpenWith === job.sender && now-Number(open.updatedAt||0)<90000;
    return {kind:'done',payload:payloadFromNotification(env,id,record),nicks:suppressed?[]:[job.to],inbox:{[path]:record},marks:{}};
  }

  if (job.type === 'chat' || job.type === 'news') {
    if (!validKey(job.id) || !validNick(job.sender)) return { kind: 'discard', reason: 'invalid fanout job' };

    const key = `${job.type}_${job.id}`;
    if (await rtdbGet(env, `pushDone/${enc(key)}`)) {
      return { kind: 'discard', reason: 'fanout already completed' };
    }

    const item = await rtdbGet(env, `${job.type === 'chat' ? 'chat' : 'news'}/${enc(job.id)}`);
    // Same race protection as notifications: the source object may appear
    // milliseconds after pushOutbox/<jobId>.
    if (!item) return { kind: 'retry', reason: `${job.type} source record not visible yet` };

    const author = job.type === 'chat' ? item.nick : item.author;
    if (author !== job.sender) {
      return { kind: 'discard', reason: 'sender does not match source author' };
    }

    const usersRaw = await rtdbGet(env, 'users', '?shallow=true');
    if (usersRaw === null) return { kind: 'retry', reason: 'users index not visible yet' };
    const users = usersRaw || {};

    let text, cat, url, source, extra = {};
    if (job.type === 'chat') {
      const name = (await rtdbGet(env, `users/${enc(author)}/displayName`)) || author;
      text = `💬 ${name} написал в общий чат: ${previewOf(item)}`;
      cat = 'messages';
      url = `${appUrl(env)}?kpSection=messages`;
      source = 'general_chat';
      extra = { from: author };
    } else {
      text = `📰 Новая новость в Капани\n${String(item.title || '').trim() || 'Новая публикация'}`;
      cat = 'news';
      url = `${appUrl(env)}?kpSection=news&news=${enc(job.id)}`;
      source = 'news';
      extra = { newsId: job.id };
    }

    const createdAt = Number(item.createdAt || now);
    const record = {
      text,
      title: 'Капани',
      time: moscowTime(createdAt),
      cat,
      createdAt,
      url,
      push: true,
      source,
      sourceMessageId: job.id,
      ...extra
    };

    const inbox = {}, recipients = [];
    for (const nick of Object.keys(users)) {
      if (nick === author) continue;
      inbox[`users/${nick}/notifications/${key}`] = record;
      recipients.push(nick);
    }

    let nicks = recipients;
    if (job.type === 'chat') {
      const presence = (await rtdbGet(env, 'presence')) || {};
      nicks = recipients.filter(n => !(presence[n]?.generalChatOpen === true && now - Number(presence[n]?.updatedAt || 0) < 90000));
    }

    return {
      kind: 'done',
      payload: payloadFromNotification(env, key, record),
      nicks,
      inbox,
      // For fanout jobs, delay pushDone until the final continuation job
      // completes. This prevents a partial send from permanently suppressing retries.
      marks: nicks.length ? { [`pushDone/${key}`]: now } : { [`pushDone/${key}`]: now },
      fanoutKey: key
    };
  }

  return { kind: 'discard', reason: 'unknown job type' };
}


/** Human-readable reason why a recipient has no usable push device (returned in the /event response). */
function diagnoseRecipient(entry, totals, ctx) {
  const t = totals || { accounts: 0, devices: 0 };
  let hint;
  if (entry.mode === 'ambiguous' || entry.mode === 'ambiguous-alias' || entry.mode === 'ambiguous-firebase-displayName') {
    hint = 'Под этим именем подходит несколько аккаунтов — Worker не гадает. Проверьте, какой ник записан в получателе уведомления.';
  } else if (!t.devices) {
    hint = 'В Worker нет НИ ОДНОГО зарегистрированного устройства: ни один аккаунт ещё не включил push через Worker (или KV пуст).';
  } else if (!entry.stored) {
    hint = `У «${entry.recipient}» нет устройств в Worker (всего аккаунтов с push: ${t.accounts}). Получатель должен войти под своим аккаунтом и нажать «Включить» в профиле. `
      + 'Если он уже включал — устройство могло быть перезаписано другим аккаунтом в том же браузере (одно устройство = один аккаунт).';
  } else if (!entry.eligible && entry.staleKey) {
    hint = `Устройство «${entry.recipient}» зарегистрировано со СТАРЫМ ключом VAPID. Получателю достаточно открыть обновлённый сайт — устройство обновится само.`;
  } else if (!entry.eligible) {
    hint = `Устройства есть (${entry.stored}), но push для категории «${entry.category}» у получателя выключен в настройках.`;
  } else {
    hint = ctx === 'debug'
      ? `Устройство «${entry.recipient}» зарегистрировано и разрешено (устройств: ${entry.eligible}). Это проверка записи, отправка не выполнялась — реальную доставку показывает kapaniPushSelfTest() или ответ /event (statuses).`
      : 'Устройства найдены, но ни одно не приняло push — см. statuses.';
  }
  return { ...entry, totalAccountsWithPush: t.accounts, totalDevices: t.devices, hint };
}

/** Processes one job. budget.left = how many pushes this invocation may still send. */
const LEASE_MS = 120000;
const MAX_ATTEMPTS = 8;
const TERMINAL = new Set(['sent','skipped','dead']);
async function claimJob(env, jobId) {
  const path = `pushOutbox/${enc(jobId)}`;
  for (let i=0;i<4;i++) {
    const snap = await rtdbGetWithEtag(env,path), job=snap.value, now=Date.now();
    if (!job || TERMINAL.has(job.state) || Number(job.nextAttemptAt||0)>now || Number(job.leaseUntil||0)>now) return null;
    const claimed={...job,state:'processing',leaseOwner:crypto.randomUUID(),leaseUntil:now+LEASE_MS,nextAttemptAt:now+LEASE_MS,updatedAt:now,attempts:Number(job.attempts||0)+1};
    const res=await rtdbPutIfMatch(env,path,claimed,snap.etag);
    if(res.status===412) continue;
    if(!res.ok) throw new Error(`claim: ${res.status}`);
    return claimed;
  }
  return null;
}
async function processJob(env, jobId, budget) {
  const job=await claimJob(env,jobId);
  if(!job) return {sent:0,next:null,reason:'missing, terminal, backoff or claimed'};
  const path=`pushOutbox/${enc(jobId)}`, owner=job.leaseOwner;
  // Every progress/finish is conditional on ownership; an expired invocation cannot overwrite a new claimant.
  const save=async(fields)=>{
    const snap=await rtdbGetWithEtag(env,path);
    if(snap.value?.leaseOwner!==owner) throw new Error('lease lost');
    Object.assign(job,fields,{updatedAt:Date.now()});
    const res=await rtdbPutIfMatch(env,path,job,snap.etag);
    if(!res.ok) throw new Error('lease progress conflict');
  };
  const complete=async(state,error='')=>save({state,lastError:error,leaseUntil:0,nextAttemptAt:-1,leaseOwner:null});
  const retry=async(reason)=>{
    if(job.attempts>=MAX_ATTEMPTS || Date.now()-Number(job.queuedAt||job.ts||Date.now())>86400000) {
      await complete('dead',reason); return {sent:0,next:null,reason,dead:true};
    }
    const next=Date.now()+Math.min(3600000,15000*2**Math.max(0,job.attempts-1))+Math.floor(Math.random()*5000);
    await save({state:'retry',leaseUntil:0,leaseOwner:null,nextAttemptAt:next,lastError:reason});
    return {sent:0,next:null,retry:true,reason};
  };
  let sent=0;
  const statuses=[];
  try {
    const plan=await planJob(env,job);
    if(!plan || plan.kind==='discard') {await complete('skipped',plan?.reason||'no plan');return {sent:0,next:null,discarded:true,reason:plan?.reason};}
    if(plan.kind==='retry') return await retry(plan.reason);
    // Root CAS makes creation + tombstone checking indivisible, and never overwrites readAt/pushedAt.
    if(Object.keys(plan.inbox).length) {
      const result=await rtdbRootTransaction(env,root=>{
        for(const [p,n] of Object.entries(plan.inbox)) {
          const [,nick,,id]=p.split('/');
          if(root.notificationTombstones?.[nick]?.[id]) continue;
          if(!root.users?.[nick]) continue;
          root.users[nick].notifications ||= {};
          root.users[nick].notifications[id] ||= n;
        }
        return {value:root};
      });
      if(!result.committed) throw new Error('inbox conflict');
    }
    const all=await loadSubs(env), delivered=job.delivered||{};
    let pending=false, transient=false;
    for(const nick of plan.nicks) {
      const id=plan.payload.notificationId;
      if(await rtdbGet(env,`notificationTombstones/${enc(nick)}/${enc(id)}`)) continue;
      const inbox=await rtdbGet(env,`users/${enc(nick)}/notifications/${enc(id)}`);
      if(inbox?.deletedAt) continue;
      const bucket={key:nick,mode:'exact',subs:Array.isArray(all[nick])?all[nick]:[]};
      const stale=bucket.subs.filter(s=>staleKey(s,env));
      if(stale.length) await mutateSubs(env,all=>{if(Array.isArray(all[bucket.key])) all[bucket.key]=all[bucket.key].filter(s=>!stale.some(old=>old.endpoint===s.endpoint));});
      const subs=bucket.subs.filter(s=>prefsAllow(s,plan.payload.category)&&!staleKey(s,env));
      for(const sub of subs) {
        const deviceKey=await sha256Hex(nick+':'+sub.endpoint);
        if(delivered[deviceKey]) continue;
        if(budget.left<=0) {pending=true;continue;}
        await save({delivered,leaseUntil:Date.now()+LEASE_MS,nextAttemptAt:Date.now()+LEASE_MS});
        budget.left--;
        let status;
        try {status=await sendPush(env,sub,{...plan.payload,recipientNick:nick});}
        catch(e) {if(e.deadSub) status=410;else {transient=true;statuses.push({recipient:nick,device:sub.id,error:String(e.message||e)});continue;}}
        statuses.push({recipient:nick,device:sub.id,status});
        if(status>=200&&status<300) {sent++;delivered[deviceKey]={status,at:Date.now(),recipient:nick};}
        else if(status===404||status===410) {
          // Re-read before pruning so a newly rotated endpoint isn't removed.
          const key=bucket.key;
          await mutateSubs(env,fresh=>{if(key&&Array.isArray(fresh[key])) fresh[key]=fresh[key].filter(s=>s.endpoint!==sub.endpoint);});
          delivered[deviceKey]={status,at:Date.now(),recipient:nick};
        } else if(status===429||status>=500) transient=true;
        else {delivered[deviceKey]={status,at:Date.now(),recipient:nick,permanent:true};}
        await save({delivered});
      }
    }
    if(transient) return {...await retry('temporary push failure'),sent,statuses};
    if(pending) {
      // Keep the SAME logical job + per-device ledger; next invocation never skips remaining devices.
      await save({state:'pending',attempts:Math.max(0,job.attempts-1),leaseUntil:0,leaseOwner:null,nextAttemptAt:Date.now()});
      return {sent,next:jobId,statuses};
    }
    // Mark only extant records: deleting an inbox must not recreate pushedAt children.
    const result=await rtdbRootTransaction(env,root=>{
      for(const nick of plan.nicks) {
        const n=root.users?.[nick]?.notifications?.[plan.payload.notificationId];
        if(n && !root.notificationTombstones?.[nick]?.[plan.payload.notificationId] && Object.values(delivered).some(d=>d.recipient===nick&&d.status>=200&&d.status<300)) n.pushedAt ||= Date.now();
      }
      if(plan.fanoutKey) {root.pushDone ||= {};root.pushDone[plan.fanoutKey]=Date.now();}
      return {value:root};
    });
    if(!result.committed) throw new Error('completion conflict');
    const success=Object.values(delivered).some(d=>d.status>=200&&d.status<300);
    await complete(success?'sent':'skipped',success?'':'no eligible device, permanent error or context suppressed');
    return {sent,next:null,statuses,reason:job.lastError||null};
  } catch(e) {
    if(/lease/.test(String(e.message))) return {sent,next:null,reason:e.message};
    return {...await retry(String(e.message||e).slice(0,240)),sent,statuses};
  }
}
async function runCron(env) {
  const budget={left:maxPush(env)};
  // null nextAttemptAt of terminal jobs is excluded, so old jobs cannot starve the queue.
  const query=`?orderBy=%22nextAttemptAt%22&startAt=1&endAt=${Date.now()}&limitToFirst=4`;
  // One-time lazy migration of pre-upgrade jobs without nextAttemptAt.
  const legacy=await rtdbGet(env,'pushOutbox','?orderBy=%22nextAttemptAt%22&equalTo=null&limitToFirst=5');
  for(const [id] of Object.entries(legacy||{})) {
    const snap=await rtdbGetWithEtag(env,`pushOutbox/${enc(id)}`);
    if(snap.value && snap.value.nextAttemptAt==null) await rtdbPutIfMatch(env,`pushOutbox/${enc(id)}`,{...snap.value,nextAttemptAt:TERMINAL.has(snap.value.state)?-1:Date.now()},snap.etag);
  }
  const jobs=await rtdbGet(env,'pushOutbox',query);
  for(const [id] of Object.entries(jobs||{})) {
    if(budget.left<=0) break;
    await processJob(env,id,budget);
    // Free Workers have a subrequest budget; continue the remaining queue next minute.
    break;
  }
}

/* ───────────── request handlers ───────────── */
async function handleAuth(request,env,body){
  const name=String(body.name||'').trim(),password=String(body.password||'');
  if(!name || name.length>100 || password.length<4 || password.length>256) return json(request,env,{error:'Введите имя и пароль (от 4 символов)'},400);
  let authenticated,created=false;
  const tx=await rtdbRootTransaction(env,async root=>{
    const users=root.users||{},query=normalizeNick(name);
    const matches=Object.entries(users).filter(([nick,u])=>normalizeNick(nick)===query||normalizeNick(u.displayName||nick)===query);
    if(matches.length>1) return {abort:true,reason:'Неоднозначное имя. Введите точный ник аккаунта'};
    if(matches.length) {
      const [nick,user]=matches[0];
      if(!user.passwordHash) return {abort:true,reason:'У старого аккаунта нет пароля. Попросите мэрию восстановить доступ'};
      const hash=await sha256Hex(`kapani::${String(user.passwordHashSalt||nick).trim().toLowerCase()}::${password}`);
      if(!safeEqual(user.passwordHash,hash)) return {abort:true,reason:'Неверный пароль'};
      authenticated={...user,nick};created=false;
      return {abort:true,reason:'authenticated'};
    }
    let nick=name.replace(/\s+/g,'_').replace(/[^\wа-яА-ЯёЁ_-]/gi,'').slice(0,24)||'user';
    const base=nick;let i=1;while(users[nick]) nick=`${base.slice(0,20)}_${i++}`;
    const now=Date.now();
    const user={nick,displayName:name,passwordHash:await sha256Hex(`kapani::${nick.toLowerCase()}::${password}`),passwordHashSalt:nick,balance:0,savingsBalance:0,taskBalance:0,totalEarned:0,job:'Житель',avatar:'https://cdn-icons-png.flaticon.com/512/149/149071.png',vehicle:'',accountFrozen:false,accountVerified:false,rewardedAvatar:false,rewardedWall:false,createdAt:now,lastSeen:now,economyLastProcessedAt:now,savingsLastInterestAt:now,employments:[],joinDate:new Date().toLocaleDateString('ru-RU'),referralCode:'KP-'+crypto.randomUUID().replace(/-/g,'').slice(0,10).toUpperCase()};
    const inviter=String(body.inviter||'').trim();
    if(inviter) {
      const found=Object.entries(users).filter(([n,u])=>normalizeNick(n)===normalizeNick(inviter)||normalizeNick(u.displayName)===normalizeNick(inviter)||normalizeNick(u.referralCode)===normalizeNick(inviter));
      if(found.length!==1||found[0][1].job!=='Рекламщик') return {abort:true,reason:'Рекламщик не найден'};
      user.invitedBy=found[0][0];user.invitedByName=found[0][1].displayName||found[0][0];user.referralCreatedAt=now;
      const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));user.referralWeekKey=d.toLocaleDateString('sv-SE');
    }
    root.users ||= {};root.users[nick]=user;authenticated=user;created=true;
    appendNotification(root,String(env.ADMIN_NICK||'Денис'),`register_${now}`,`🆕 Новый аккаунт: ${name}`,'system',nick);
    return {value:root};
  });
  if(!tx.committed&&tx.reason!=='authenticated') return json(request,env,{error:tx.reason},401);
  const token=await createFirebaseCustomToken(env,authenticated.nick);
  return json(request,env,{ok:true,user:authenticated,created,token});
}
async function handleDirectory(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  if(body.target && !validNick(body.target)) return json(request,env,{error:'invalid target'},400);
  if(body.resource==='businessApps') {
    const apps=await rtdbGet(env,'businessApps')||{};
    const filtered=body.nick===String(env.ADMIN_NICK||'Денис')?apps:Object.fromEntries(Object.entries(apps).filter(([,a])=>a.owner===body.nick));
    return json(request,env,{ok:true,apps:filtered});
  }
  const users=body.target?{[body.target]:await rtdbGet(env,`users/${enc(String(body.target))}`)}:await rtdbGet(env,'users')||{};
  for(const [nick,u] of Object.entries(users)) {
    if(!u) {delete users[nick];continue;}
    if(nick===body.nick) continue;
    // Only data actually used by public profiles, rosters and ratings.
    const publicFields=new Set(['nick','displayName','avatar','joinDate','createdAt','lastSeen','job','displayJob','vehicle','balance','taskBalance','savingsBalance','subscription','subscriptionExpiry','accountVerified','accountFrozen','kveScore','fine','employments','totalEarned','nicknameEmoji','avatarFrame','profileBgEffect','chatBubbleStyle','profileDescription','businessIds','businessId','employerBizId','referralCode','invitedBy','referralWeekKey','referralCreatedAt','policeRole','licenses']);
    for(const key of Object.keys(u)) if(!publicFields.has(key)) delete u[key];
  }
  return json(request,env,{ok:true,users});
}

async function handleSession(request, env, body) {
  const nick = String(body?.nick || '').trim();
  const ph = String(body?.ph || '').trim();
  if (!(await verifyUser(env, nick, ph))) return json(request, env, { error: 'unauthorized' }, 401);
  const token = await createFirebaseCustomToken(env, nick);
  return json(request, env, { ok: true, token, uid: nick });
}

// Atomic release and penalty for the worker who actually owns the order.
async function handleAbandonOrder(request, env, body) {
  const nick = String(body?.nick || '').trim();
  const ph = String(body?.ph || '').trim();
  const orderId = String(body?.orderId || '').trim();
  if (!(await verifyUser(env, nick, ph))) return json(request, env, { error: 'Необходимо заново войти в аккаунт' }, 401);
  if (!/^[-\w]{1,120}$/.test(orderId)) return json(request, env, { error: 'Некорректный заказ' }, 400);

  const now = Date.now();
  const txId = giftIdPart('tx');
  let chargedPenalty = 0;
  let resetStatus = '';
  const tx = await rtdbRootTransaction(env, root => {
    const order = root?.orders?.[orderId];
    const worker = root?.users?.[nick];
    if (!order || !worker) return { abort: true, reason: 'Заказ или исполнитель не найдены' };
    if (order.worker !== nick) return { abort: true, reason: 'Этот заказ назначен другому исполнителю' };
    const taxi = order.type === 'taxi';
    const allowed = taxi
      ? ['accepted', 'driver_arriving', 'in_progress'].includes(String(order.status || ''))
      : order.status === 'in_progress';
    if (!allowed) return { abort: true, reason: 'Отказ в текущем состоянии заказа недоступен' };

    const balance = Number(worker.balance || 0);
    if (!Number.isFinite(balance)) return { abort: true, reason: 'Некорректный баланс исполнителя' };
    chargedPenalty = Math.min(35, Math.max(0, balance));
    resetStatus = taxi ? 'pending' : 'waiting';
    const date = new Date(now).toLocaleDateString('ru-RU', {timeZone: 'Europe/Moscow'});
    const ts = new Date(now).toISOString();
    const nextWorker = { ...worker, balance: balance - chargedPenalty };
    if (chargedPenalty > 0) {
      nextWorker.txlog = {
        ...(worker.txlog || {}),
        [txId]: {type:'out',who:'Система',amt:chargedPenalty,desc:'Отказ исполнителя от заказа',date,time:moscowTime(now),ts}
      };
    }
    return {
      value: {
        ...root,
        orders: { ...root.orders, [orderId]: {
          ...order, worker: null, status: resetStatus,
          driverLat: null, driverLng: null, driverLocationUpdatedAt: null,
          abandonedAt: now
        }},
        users: { ...root.users, [nick]: nextWorker }
      }
    };
  });
  if (!tx.committed) return json(request, env, {error:tx.reason || 'Заказ изменён, обновите страницу'}, 409);
  return json(request, env, {ok:true,success:true,penalty:chargedPenalty,orderStatus:resetStatus});
}

async function handleGift(request, env, body) {
  const giverNick = String(body?.nick || '').trim();
  const ph = String(body?.ph || '').trim();
  const recipientNick = String(body?.recipientNick || '').trim();
  const type = normalizeSubscriptionType(body?.subscriptionType);

  if (!(await verifyUser(env, giverNick, ph))) return json(request, env, { error: 'unauthorized' }, 401);
  if (!validNick(giverNick) || !validNick(recipientNick) || recipientNick === giverNick) {
    return json(request, env, { error: 'Некорректный получатель' }, 400);
  }
  if (type === 'none') return json(request, env, { error: 'Некорректная подписка' }, 400);

  const plan = SUBSCRIPTIONS[type];
  const price = Number(plan.price);
  const giftRank = Number(plan.rank);
  const committedAt = Date.now();
  const requestId = String(body.requestId || giftIdPart('request'));
  if (!validKey(requestId)) return json(request, env, {error:'invalid requestId'}, 400);
  const giftId = `gift_${await sha256Hex(giverNick + ':' + requestId)}`;
  const giverTxId = giftIdPart('tx');
  const recipientTxId = giftIdPart('tx');
  const giverJobId = giftIdPart('push');
  const recipientJobId = giftIdPart('push');

  const tx = await rtdbRootTransaction(env, async (root) => {
    if (root.subscriptionGifts?.[giftId]) return {abort:true, reason:'already-completed'};
    const users = root?.users && typeof root.users === 'object' ? root.users : {};
    const giver = users[giverNick];
    const recipient = users[recipientNick];
    if (!giver || !recipient) return { abort: true, reason: 'Пользователь не найден' };

    const balance = Number(giver.balance || 0);
    if (!Number.isFinite(balance) || balance < price) return { abort: true, reason: `Недостаточно средств. Нужно ${price}₽` };

    const recipientRank = subscriptionRank(recipient);
    if (recipientRank > giftRank) return { abort: true, reason: 'Нельзя подарить эту подписку. У пользователя уже есть подписка более высокого уровня.' };

    const currentExpiry = recipient.subscriptionExpiry ? new Date(recipient.subscriptionExpiry) : null;
    const activeSameType = normalizeSubscriptionType(recipient.subscription) === type
      && currentExpiry && !Number.isNaN(currentExpiry.getTime()) && currentExpiry.getTime() > committedAt;
    const expiry = activeSameType
      ? new Date(currentExpiry.getTime() + plan.durationDays * 24 * 60 * 60 * 1000)
      : new Date(committedAt + plan.durationDays * 24 * 60 * 60 * 1000);
    const now = new Date(committedAt);
    const startDate = activeSameType ? String(recipient.subscriptionStart || now.toISOString()) : now.toISOString();
    const date = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    const time = moscowTime(committedAt);
    const ts = now.toISOString();

    const next = { ...root, users: { ...users } };
    next.users[giverNick] = {
      ...giver,
      balance: balance - price,
      txlog: { ...(giver.txlog || {}), [giverTxId]: { type: 'out', who: 'Подарок подписки', amt: price, desc: `Подарок ${plan.name} для ${recipientNick}`, date, time, ts } },
      notifications: { ...(giver.notifications || {}), [`gift_${giftId}`]: {
        createdAt: committedAt, url: appUrl(env), cat: 'system', push: true, title: 'Капани', time,
        text: `🎁 Вы подарили ${plan.name} пользователю ${recipientNick}!`, source: 'subscription_gift', sourceMessageId: giftId
      }}
    };
    next.users[recipientNick] = {
      ...recipient, subscription: type, subscriptionStatus: 'active', subscriptionExpiry: expiry.toISOString(),
      subscriptionStart: startDate, subscriptionGiftedBy: giverNick, subscriptionGiftedAt: now.toISOString(),
      totalEarned: Number(recipient.totalEarned || 0),
      txlog: { ...(recipient.txlog || {}), [recipientTxId]: { type: 'in', who: 'Подарок подписки', amt: 0, desc: `Получена ${plan.name} от ${giverNick}`, date, time, ts } },
      notifications: { ...(recipient.notifications || {}), [`gift_${giftId}`]: {
        createdAt: committedAt, url: appUrl(env), cat: 'system', push: true, title: 'Капани', time,
        text: `🎁 ${giverNick} подарил вам ${plan.name}!`, source: 'subscription_gift', sourceMessageId: giftId
      }}
    };

    next.subscriptionGifts = { ...(root.subscriptionGifts || {}), [giftId]: { id: giftId, from: giverNick, to: recipientNick, subscription: type, price, createdAt: committedAt, status: 'completed' } };
    const treasury = root.municipalTreasury && typeof root.municipalTreasury === 'object' ? root.municipalTreasury : { balance: 0 };
    next.municipalTreasury = { ...treasury, balance: Number(treasury.balance || 0) + price, updatedAt: committedAt };
    const treasuryHistory = treasury.history && typeof treasury.history === 'object' ? treasury.history : {};
    next.municipalTreasury.history = { ...(next.municipalTreasury.history || {}), [giftIdPart('treasury')]: {
      type: 'in', amount: price, reason: `Подаренная подписка ${plan.name} от ${giverNick}`, sourceNick: giverNick, sourceType: 'subscription_gift', date, time, ts
    }};

    next.pushOutbox = { ...(root.pushOutbox || {}),
      [giverJobId]: { type: 'notification', to: giverNick, id: `gift_${giftId}`, sender: giverNick, state:'pending', attempts:0, nextAttemptAt:committedAt, queuedAt: committedAt, ts: committedAt },
      [recipientJobId]: { type: 'notification', to: recipientNick, id: `gift_${giftId}`, sender: giverNick, state:'pending', attempts:0, nextAttemptAt:committedAt, queuedAt: committedAt, ts: committedAt }
    };
    return { value: next };
  });

  if (!tx.committed && tx.reason === 'already-completed') return json(request, env, {ok:true,success:true,giftId,replayed:true});
  if (!tx.committed) {
    const reason = String(tx.reason || 'Операция не подтверждена').trim();
    const status = /Недостаточно средств|более высокого уровня|Некорректн/.test(reason) ? 400 : 409;
    return json(request, env, { ok: false, error: reason }, status);
  }

  const deliveries = [];
  for (const jobId of [giverJobId, recipientJobId]) {
    try {
      const result = await processJob(env, jobId, { left: maxPush(env) });
      deliveries.push({ jobId, sent: Number(result?.sent || 0), retry: !!result?.retry, statuses: result?.statuses || [] });
    } catch (e) {
      console.warn('gift push job failed', jobId, String(e?.message || e));
      deliveries.push({ jobId, error: String(e?.message || e).slice(0, 200) });
    }
  }

  return json(request, env, { ok: true, success: true, giftId, subscription: type, price, deliveries });
}

async function handleNotify(request, env, body) {
  try {
    const sender = String(body?.nick || '').trim();
    const ph = String(body?.ph || '').trim();
    const targetNick = String(body?.targetNick || body?.to || '').trim();
    const text = String(body?.text || body?.body || '').trim();
    if (!(await verifyUser(env, sender, ph))) return json(request, env, { error: 'unauthorized' }, 401);
    if (!validNick(targetNick)) return json(request, env, { error: 'invalid targetNick' }, 400);
    if (!text) return json(request, env, { error: 'notification text is empty' }, 400);

    const notificationId = String(body?.notificationId || giftIdPart('notification')).trim();
    if (!validKey(notificationId)) return json(request, env, { error: 'invalid notificationId' }, 400);

    const createdAt = Number(body?.createdAt || Date.now()) || Date.now();
    const category = String(body?.category || body?.cat || 'system').slice(0, 40);
    const record = {
      text: text.slice(0, 2000),
      title: String(body?.title || 'Капани').slice(0, 120),
      time: moscowTime(createdAt),
      cat: category,
      createdAt,
      url: String(body?.url || appUrl(env)).slice(0, 1000),
      push: body?.push !== false,
      source: String(body?.source || '').slice(0, 80),
      sourceMessageId: String(body?.sourceMessageId || '').slice(0, 120)
    };
    if (record.source === 'dm') record.from = sender;
    for(const key of ['type','duelId','from']) if(body[key]) record[key]=String(body[key]).slice(0,120);

    const jobId = `notify_${await sha256Hex(targetNick+':'+notificationId)}`;
    const created=await rtdbRootTransaction(env,root=>{
      if(!root.users?.[targetNick]) return {abort:true,reason:'recipient missing'};
      if(root.notificationTombstones?.[targetNick]?.[notificationId]) return {abort:true,reason:'deleted'};
      root.users[targetNick].notifications ||= {};
      const previous=root.users[targetNick].notifications[notificationId];
      if(previous && previous.createdBy !== sender) return {abort:true,reason:'notification owner mismatch'};
      root.users[targetNick].notifications[notificationId] ||= {...record,createdBy:sender};
      root.pushOutbox ||= {};
      root.pushOutbox[jobId] ||= {type:'notification',to:targetNick,id:notificationId,sender,state:'pending',attempts:0,nextAttemptAt:Date.now(),queuedAt:Date.now()};
      return {value:root};
    });
    if(!created.committed) return json(request,env,{ok:created.reason==='deleted',discarded:true,reason:created.reason},created.reason==='deleted'?200:409);
    const result = await processJob(env, jobId, { left: maxPush(env) }).catch(e=>({sent:0,retry:true,reason:String(e.message||e)}));
    return json(request, env, {
      ok: true,
      notificationId,
      jobId,
      sent: Number(result?.sent || 0),
      retry: !!result?.retry,
      reason: result?.reason || null,
      detail: result?.detail || null,
      statuses: result?.statuses || []
    });
  } catch (error) {
    console.error('notify handler failed', String(error?.message || error));
    return json(request, env, { ok: false, error: String(error?.message || error).slice(0, 300) }, 500);
  }
}
async function handleSubscribe(request, env, body) {
  const { nick, ph, subscription: s, prefs, userAgent } = body;
  if (!(await verifyUser(env, nick, ph))) return json(request, env, { error: 'unauthorized' }, 401);
  let host = '';
  try { const u = new URL(String(s?.endpoint || '')); if (u.protocol === 'https:') host = u.hostname; } catch {}
  if (!host || !PUSH_HOST_ALLOW.test(host) || !s?.keys?.p256dh || !s?.keys?.auth) return json(request, env, { error: 'bad subscription' }, 400);
  const id = (await sha256Hex(s.endpoint)).slice(0, 32);
  const workerVk = vkOf(env.VAPID_PUBLIC_KEY);
  let deviceVk = '';
  try { deviceVk = s.applicationServerKey ? b64uEnc(decodeKey('applicationServerKey', s.applicationServerKey, 65)).slice(0, 16) : ''; } catch {}
  if (deviceVk && workerVk && deviceVk !== workerVk) {
    return json(request, env, { error: 'vapid key mismatch', workerVapidPrefix: workerVk, deviceVapidPrefix: deviceVk }, 409);
  }
  const before = await loadSubs(env);
  const owner = await subscriptionBucket(env, before, nick);
  const displayNameRaw = await rtdbGet(env, `users/${enc(nick)}/displayName`).catch(() => null);
  const displayName = String(displayNameRaw || body.displayName || '').trim().slice(0, 120);

  // Nothing changed since the last registration: skip the KV write (free plan: ~1000 writes/day).
  const curSub = (before[nick] || []).find(x => x.id === id);
  if (curSub && curSub.displayName === displayName && JSON.stringify(curSub.prefs) === JSON.stringify(sanitizePrefs(prefs))
      && Date.now() - Number(curSub.updatedAt || 0) < 12 * 3600e3) {
    return json(request, env, { success: true, subscriptionId: id, ownerNick: nick, displayName, unchanged: true });
  }

  const all=await mutateSubs(env,async all=>{
  // If an older registration used the same account name with different
  // casing/spacing, migrate that bucket to the exact authenticated nick.
  // This repairs existing subscriptions without requiring the browser to
  // generate a new PushSubscription.
  if (owner.key && owner.key !== nick && !Array.isArray(all[nick])) {
    all[nick] = owner.subs.slice();
    delete all[owner.key];
    console.log('push subscription owner normalized', owner.key, '=>', nick);
  }

  for (const n of Object.keys(all).filter(n=>Array.isArray(all[n]))) {                                             // a device belongs to one account
    if (n === nick) continue;
    all[n] = all[n].filter(x => x.id !== id);
    if (!all[n].length) delete all[n];
  }
  // Drop devices of this account that can no longer work: created with another VAPID key, or legacy records
  // (no key recorded) from the same kind of browser that this new registration replaces.
  const mine = (all[nick] || []).filter(x => x.id !== id && !staleKey(x, env) && !(workerVk && !x.vk && x.ua && x.ua === String(userAgent || '').slice(0, 200)));
  mine.unshift({
    id,
    vk: deviceVk || workerVk,
    endpoint: s.endpoint,
    keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) },
    prefs: sanitizePrefs(prefs),
    ua: String(userAgent || '').slice(0, 200),
    ownerNick: nick,
    displayName,
    updatedAt: Date.now()
  });
  all[nick] = mine.slice(0, MAX_DEVICES_PER_USER);
  });
  console.log('push subscription saved', JSON.stringify({
    ownerNick: nick,
    displayName,
    subscriptionId: id,
    storedDevices: all[nick].length,
    bucketKeys: Object.keys(all).slice(0, 20)
  }));
  return json(request, env, { success: true, subscriptionId: id, ownerNick: nick, displayName });
}
async function handleUnsubscribe(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
  let removed=false;
  await mutateSubs(env,all=>{
    const before=(all[body.nick]||[]).length;
    all[body.nick]=(all[body.nick]||[]).filter(x=>x.id!==body.subscriptionId);
    removed=before!==all[body.nick].length;
    if(!all[body.nick].length) delete all[body.nick];
  });
  return json(request,env,{success:true,removed});
}
async function handlePrefs(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
  let prefs=null;
  await mutateSubs(env,all=>{
    const sub=(all[body.nick]||[]).find(x=>x.id===body.subscriptionId);
    if(sub) {sub.prefs=sanitizePrefs(body.prefs);prefs=sub.prefs;}
  });
  return json(request,env,prefs?{success:true,prefs}:{error:'subscription not found'},prefs?200:404);
}
// Financial and address writes are server-owned; public forms cannot forge the price or pickup.
const DELIVERY_PRICE_PER_KM = 200;
function serverPoint(point){
  if(!point || point.lat==null || point.lng==null || String(point.lat).trim()==='' || String(point.lng).trim()==='') return null;
  const lat=Number(point.lat),lng=Number(point.lng),address=String(point.address||point.text||'').trim();
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180||!address) return null;
  return {lat,lng,address:address.slice(0,300)};
}
function distanceKm(a,b){
  const rad=Math.PI/180,dLat=(b.lat-a.lat)*rad,dLng=(b.lng-a.lng)*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLng/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(Math.min(1,x)),Math.sqrt(Math.max(0,1-x)));
}
function appendNotification(root,nick,id,text,cat,sender){
  if(!root.users?.[nick] || root.notificationTombstones?.[nick]?.[id]) return;
  root.users[nick].notifications ||= {};
  root.users[nick].notifications[id] ||= {title:'Капани',text,cat,createdAt:Date.now(),time:moscowTime(Date.now()),push:true,url:appUrlForRecord,source:'service',sourceMessageId:id,createdBy:sender};
  root.pushOutbox ||= {};
    // Account keys may contain Unicode; outbox IDs remain ASCII and stable.
  const jobId=`service_${id}_${b64uEnc(te.encode(nick))}`;
  root.pushOutbox[jobId] ||= {type:'notification',id,to:nick,sender,state:'pending',attempts:0,nextAttemptAt:Date.now(),queuedAt:Date.now()};
}
const appUrlForRecord='https://iamskoup1.github.io/kapani/';
function appendTx(user,id,type,who,amount,desc){
  user.txlog ||= {};user.txlog[id]={type,who,amt:amount,desc,date:new Date().toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}),time:moscowTime(Date.now()),ts:new Date().toISOString()};
}
async function handleDeliveryCreate(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const input=body.order,id=String(input?.id||'');
  if(!validKey(id) || !['business','marketplace'].includes(input?.source)) return json(request,env,{error:'Некорректный заказ'},400);
  const dropoff=serverPoint(input.deliveryAddress);
  if(!dropoff) return json(request,env,{error:'Укажите адрес доставки и координаты'},400);
  let order;
  const tx=await rtdbRootTransaction(env,root=>{
    const client=root.users?.[body.nick];
    if(!client) return {abort:true,reason:'Пользователь не найден'};
    if(!client.accountVerified||client.accountFrozen) return {abort:true,reason:'Аккаунт не подтверждён или заморожен'};
    const previous=root.deliveryCustomOrders?.[id];
    if(previous) {if(previous.client!==body.nick) return {abort:true,reason:'Чужой заказ'};order=previous;return {abort:true,reason:'replayed'};}
    let pickup,from,items,extra={};
    if(input.source==='marketplace') {
      const listing=root.marketplace?.[input.listingId];
      if(!listing || listing.status!=='active' || listing.archived || ['work','service'].includes(listing.category)) return {abort:true,reason:'Объявление недоступно'};
      if(listing.seller===body.nick) return {abort:true,reason:'Нельзя купить свой товар'};
      pickup=serverPoint(listing.pickupAddress);
      if(!pickup) return {abort:true,reason:'У товара отсутствует адрес'};
      const seller=root.users?.[listing.seller],price=Number(listing.price);
      if(!seller || listing.priceNegotiable || !Number.isFinite(price)||price<=0) return {abort:true,reason:'Для доставки нужна фиксированная цена товара'};
      const shipping=Math.round(distanceKm(pickup,dropoff)*DELIVERY_PRICE_PER_KM);
      if(Math.abs(shipping-Number(input.deliveryPrice))>0) return {abort:true,reason:'Цена доставки изменилась. Обновите выбранные адреса'};
      if(!Number.isFinite(Number(client.balance)) || Number(client.balance)<price) return {abort:true,reason:'Недостаточно средств для покупки'};
      client.balance=Number(client.balance)-price;seller.balance=Number(seller.balance||0)+price;
      Object.assign(listing,{status:'sold',buyer:body.nick,deliveryPurchaseId:id,soldAt:Date.now()});
      appendTx(client,id,'out',listing.seller,price,`Покупка «${listing.title}»`);
      appendTx(seller,id,'in',body.nick,price,`Продажа «${listing.title}»`);
      appendNotification(root,listing.seller,`sale_${id}`,`💰 ${body.nick} купил «${listing.title}» за ${price} ₽`,'market',body.nick);
      appendNotification(root,body.nick,`buy_${id}`,`✅ «${listing.title}» куплено, доставка оформлена`,'market',body.nick);
      from=listing.seller;items=listing.title;
      extra={listingId:input.listingId,listingTitle:items,listingPrice:price,sellerNick:listing.seller,sellerLat:pickup.lat,sellerLng:pickup.lng,itemKind:'marketplace_listing'};
    } else {
      const business=root.businesses?.[input.bizId], product=business?.products?.[input.productId];
      if(!business || business.status!=='active'||!product) return {abort:true,reason:'Товар бизнеса недоступен'};
      pickup=serverPoint({lat:business.lat,lng:business.lng,address:business.address});
      if(!pickup) return {abort:true,reason:'У бизнеса отсутствует адрес'};
      from=business.name;items=product.name;
      extra={bizId:input.bizId,businessName:from,businessLat:pickup.lat,businessLng:pickup.lng,productId:input.productId,productName:items,productPrice:Number(product.price||0),itemKind:'business_product'};
    }
    const km=distanceKm(pickup,dropoff),price=Math.round(km*DELIVERY_PRICE_PER_KM);
    if(!Number.isFinite(Number(input.deliveryPrice))||price!==Number(input.deliveryPrice)) return {abort:true,reason:'Цена доставки изменилась. Обновите выбранные адреса'};
    if(Number(client.balance||0)<price) return {abort:true,reason:'Недостаточно средств для доставки'};
    client.balance=Number(client.balance||0)-price;
    appendTx(client,`shipping_${id}`,'out','Доставка',price,'Резерв оплаты доставки');
    order={id,source:input.source,sourceLabel:input.source==='business'?'🏪 Бизнес':'🛍 Маркетплейс',...extra,from,items,pickupAddress:{...pickup},deliveryAddress:{...dropoff},address:dropoff.address,deliveryLat:dropoff.lat,deliveryLng:dropoff.lng,distanceKm:km,deliveryPrice:price,priceOffer:price,deliveryPriceRule:'200_per_km',priceMode:'fixed_200_per_km',notes:String(input.notes||'').slice(0,1000),contact:String(input.contact||'').slice(0,200),client:body.nick,status:'waiting',clientConfirmed:false,workerConfirmed:false,clientReceived:false,escrowAmount:price,payoutDone:false,date:new Date().toLocaleDateString('ru-RU'),time:moscowTime(Date.now()),createdAt:Date.now()};
    root.deliveryCustomOrders ||= {};root.deliveryCustomOrders[id]=order;
    for(const [nick,u] of Object.entries(root.users||{})) if(u.job==='Доставщик'||nick===String(env.ADMIN_NICK||'Денис')) appendNotification(root,nick,`delivery_${id}`,`📦 Новый заказ: ${items}. Забрать: ${pickup.address}; доставить: ${dropoff.address}. ${price} ₽`,'delivery_orders',body.nick);
    return {value:root};
  });
  return json(request,env,tx.committed||tx.reason==='replayed'?{ok:true,order,replayed:tx.reason==='replayed'}:{ok:false,error:tx.reason},tx.committed||tx.reason==='replayed'?200:409);
}
async function handleDeliveryAction(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const id=String(body.orderId||''),action=String(body.action||'');
  if(!validKey(id)) return json(request,env,{error:'invalid orderId'},400);
  let order;
  const tx=await rtdbRootTransaction(env,root=>{
    const o=root.deliveryCustomOrders?.[id],u=root.users?.[body.nick];
    if(!o||!u) return {abort:true,reason:'Заказ не найден'};
    const client=o.client===body.nick,worker=o.worker===body.nick;
    if(action==='take') {
      if(!(u.job==='Доставщик'||body.nick===String(env.ADMIN_NICK||'Денис'))||client) return {abort:true,reason:'Заказ может взять доставщик'};
      if(o.worker===body.nick&&o.status==='client_confirmed') {order=o;return {abort:true,reason:'replayed'};}
      if(o.status!=='waiting'||o.worker) return {abort:true,reason:'Заказ уже принят'};
      if(Number(o.escrowAmount)!==Number(o.deliveryPrice)) return {abort:true,reason:'Оплата старого заказа не зарезервирована'};
      Object.assign(o,{worker:body.nick,status:'client_confirmed',clientConfirmed:true,driverAcceptedAt:Date.now()});
      appendNotification(root,o.client,`accepted_${id}`,`🛵 ${body.nick} взял доставку «${o.items}»`,'delivery_orders',body.nick);
    } else if(action==='cancel') {
      if(!client) return {abort:true,reason:'Чужой заказ'};
      if(o.status==='cancelled') {order=o;return {abort:true,reason:'replayed'};}
      if(!['waiting','price_proposed','client_confirmed'].includes(o.status)) return {abort:true,reason:'Доставка уже началась'};
      const refund=Number(o.escrowAmount||0);u.balance=Number(u.balance||0)+refund;
      if(refund) appendTx(u,`refund_${id}`,'in','Доставка',refund,'Возврат резерва доставки');
      if(o.worker) appendNotification(root,o.worker,`cancelled_${id}`,'❌ Клиент отменил доставку','delivery_orders',body.nick);
      Object.assign(o,{status:'cancelled',cancelledAt:Date.now(),escrowAmount:0,worker:null});
    } else if(action==='start'||action==='complete') {
      if(!worker) return {abort:true,reason:'Чужой заказ'};
      const expected=action==='start'?'client_confirmed':'in_progress',next=action==='start'?'in_progress':'delivered';
      if(o.status===next) {order=o;return {abort:true,reason:'replayed'};}
      if(o.status!==expected) return {abort:true,reason:'Статус изменён'};
      o.status=next;o[action==='start'?'startedAt':'deliveredAt']=Date.now();
      if(action==='complete') appendNotification(root,o.client,`delivered_${id}`,'📦 Доставлено. Подтвердите получение.','delivery_orders',body.nick);
    } else if(action==='received'||action==='done') {
      if(action==='received'&&!client || action==='done'&&!worker) return {abort:true,reason:'Чужой заказ'};
      if(o.status==='done'&&o.payoutDone) {order=o;return {abort:true,reason:'replayed'};}
      if(o.status!=='delivered') return {abort:true,reason:'Доставка ещё не завершена'};
      o[action==='received'?'clientReceived':'workerConfirmed']=true;
      if(o.clientReceived&&o.workerConfirmed&&!o.payoutDone) {
        const target=root.users?.[o.worker],amount=Number(o.escrowAmount||0);
        if(!target||!Number.isFinite(amount)||amount<0) return {abort:true,reason:'Некорректная выплата'};
        target.balance=Number(target.balance||0)+amount;target.totalEarned=Number(target.totalEarned||0)+amount;
        appendTx(target,`payout_${id}`,'in','Доставка',amount,'Завершённая доставка');
        Object.assign(o,{status:'done',payoutDone:true,paidAt:Date.now(),escrowAmount:0});
        appendNotification(root,o.worker,`payout_${id}`,`💰 +${amount} ₽ за доставку`,'money',body.nick);
        appendNotification(root,o.client,`closed_${id}`,'✅ Доставка завершена и оплачена','delivery_orders',body.nick);
      }
    } else return {abort:true,reason:'Неизвестное действие'};
    o.updatedAt=Date.now();order=o;return {value:root};
  });
  return json(request,env,tx.committed||tx.reason==='replayed'?{ok:true,order}:{error:tx.reason},tx.committed||tx.reason==='replayed'?200:409);
}

function isoWeekKey(){
  const d=new Date(new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'})+'T00:00:00Z');
  const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day+3);
  const first=new Date(Date.UTC(d.getUTCFullYear(),0,4));
  return `${d.getUTCFullYear()}-W${String(1+Math.round(((d-first)/86400000-3+((first.getUTCDay()+6)%7))/7)).padStart(2,'0')}`;
}
async function handleMarketAddress(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const id=String(body.listingId||''),point=serverPoint(body.pickupAddress);
  if(!validKey(id)||!point) return json(request,env,{error:'Укажите адрес товара и координаты'},400);
  const tx=await rtdbRootTransaction(env,root=>{
    const listing=root.marketplace?.[id];
    if(!listing||listing.seller!==body.nick) return {abort:true,reason:'Чужое объявление'};
    listing.pickupAddress=point;listing.updatedAt=Date.now();return {value:root};
  });
  return json(request,env,{ok:tx.committed,error:tx.reason},tx.committed?200:403);
}
async function handleMarketPublish(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const l=body.listing,id=String(l?.id||''),pickup=serverPoint(l?.pickupAddress);
  if(!validKey(id)||!pickup||!String(l?.title||'').trim()) return json(request,env,{error:'Укажите название и адрес товара'},400);
  const category=String(l.category||'other'),price=Number(l.price);
  if(!['other','food','tools','clothes','electronics','building','work','service'].includes(category)||!Number.isFinite(price)||price<0 || (category!=='work'&&!l.priceNegotiable&&price<=0)) return json(request,env,{error:'Некорректная цена или категория'},400);
  const week=isoWeekKey();
  const tx=await rtdbRootTransaction(env,root=>{
    const u=root.users?.[body.nick];if(!u) return {abort:true,reason:'Пользователь не найден'};
    if(!u.accountVerified||u.accountFrozen||Number(u.balance)<0) return {abort:true,reason:'Маркетплейс недоступен для этого аккаунта'};
    if(root.marketplace?.[id]) return {abort:true,reason:root.marketplace[id].seller===body.nick?'replayed':'Чужое объявление'};
    const rank=subscriptionRank(u),limit=[2,4,8,999999][rank],count=u.lastListingWeek===week?Number(u.listingsThisWeek||0):0;
    if(count>=limit) return {abort:true,reason:'Лимит объявлений за неделю достигнут'};
    root.marketplace ||= {};
    root.marketplace[id]={id,seller:body.nick,pickupAddress:pickup,title:String(l.title).slice(0,100),desc:String(l.desc||'').slice(0,500),photo:String(l.photo||''),price:category==='work'?0:price,priceNegotiable:category!=='work'&&!!l.priceNegotiable,salaryHint:String(l.salaryHint||'').slice(0,100),category,status:'active',createdAt:Date.now()};
    u.listingsThisWeek=count+1;u.lastListingWeek=week;
    if(!u.rewardedListing){u.rewardedListing=true;u.taskBalance=Number(u.taskBalance||0)+60;appendTx(u,id,'in','Задания',60,'Первое объявление');}
    return {value:root};
  });
  return json(request,env,{ok:tx.committed||tx.reason==='replayed',error:tx.reason},tx.committed||tx.reason==='replayed'?200:409);
}
async function handleBusinessApply(request,env,body){
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const a=body.application,id=String(a?.id||''),point=serverPoint({lat:a?.lat,lng:a?.lng,address:a?.address});
  if(!validKey(id)||!point||!String(a.name||'').trim()||!String(a.desc||'').trim()) return json(request,env,{error:'Укажите название, описание и адрес бизнеса'},400);
  const tx=await rtdbRootTransaction(env,root=>{
    const u=root.users?.[body.nick];if(!u) return {abort:true,reason:'Пользователь не найден'};
    if(root.businessApps?.[id]) return {abort:true,reason:root.businessApps[id].owner===body.nick?'replayed':'Чужая заявка'};
    const owned=Object.values(root.businesses||{}).filter(b=>b.owner===body.nick&&b.status==='active').length;
    if(Object.values(root.businessApps||{}).some(a=>a.owner===body.nick&&a.status==='pending')) return {abort:true,reason:'Заявка уже на рассмотрении'};
    const rank=subscriptionRank(u),fee=rank===3?1250:rank===2?2000:2500;
    if(owned>=[1,3,5,8][rank]) return {abort:true,reason:'Лимит бизнесов достигнут'};
    if(!Number.isFinite(Number(u.balance))||Number(u.balance)<fee) return {abort:true,reason:'Недостаточно средств для госпошлины'};
    u.balance=Number(u.balance)-fee;appendTx(u,id,'out','Госпошлина',fee,'Заявка на создание бизнеса');
    root.businessApps ||= {};root.businessApps[id]={id,owner:body.nick,name:String(a.name).slice(0,150),desc:String(a.desc).slice(0,2000),address:point.address,lat:point.lat,lng:point.lng,location:point,category:String(a.category||'Услуги').slice(0,100),services:String(a.services||'').slice(0,2000),status:'pending',createdAt:Date.now(),feePaid:fee};
    appendNotification(root,body.nick,`bizfee_${id}`,`🏛 Списана госпошлина ${fee} ₽ за заявку на бизнес`,'money',body.nick);
    appendNotification(root,String(env.ADMIN_NICK||'Денис'),`bizapp_${id}`,`🏪 Новая заявка на бизнес от ${body.nick}: «${a.name}»`,'system',body.nick);
    return {value:root};
  });
  return json(request,env,{ok:tx.committed||tx.reason==='replayed',error:tx.reason},tx.committed||tx.reason==='replayed'?200:409);
}

async function handleTest(request, env, body) {
  return handleNotify(request,env,{...body,targetNick:body.nick,notificationId:giftIdPart('test'),text:body.text||body.body||'🧪 Тестовое уведомление Капани',source:'worker_test'});
}
async function handleNotificationAction(request,env,body,action) {
  if(!(await verifyUser(env,body.nick,body.ph))) return json(request,env,{error:'unauthorized'},401);
  const id=String(body.notificationId||'');
  if(action!=='clear'&&!validKey(id)) return json(request,env,{error:'invalid notificationId'},400);
  const result=await rtdbRootTransaction(env,root=>{
    const user=root.users?.[body.nick];
    if(!user) return {abort:true,reason:'user missing'};
    user.notifications ||= {};
    const ids=action==='clear'?Object.keys(user.notifications):[id];
    for(const key of ids) {
      if(action==='read') {if(user.notifications[key]) user.notifications[key].readAt ||= Date.now();}
      else {
        root.notificationTombstones ||= {};root.notificationTombstones[body.nick] ||= {};
        root.notificationTombstones[body.nick][key]={deletedAt:Date.now()};
        delete user.notifications[key];
      }
    }
    return {value:root};
  });
  return json(request,env,{ok:result.committed},result.committed?200:409);
}

async function handleDebug(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
  const all = await loadSubs(env);
  const totals = { accounts: Object.values(all).filter(Array.isArray).length, devices: Object.values(all).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0) };
  const category = String(body.category || 'messages');
  const target = String(body.target || body.nick);
  const b = await subscriptionBucket(env, all, target);
  const subs = b.subs || [];
  const entry = { recipient: target, mode: b.mode, matchedKey: b.key, stored: subs.length, eligible: subs.filter(s => prefsAllow(s, category) && !staleKey(s, env)).length, blockedByPrefs: subs.filter(s => !prefsAllow(s, category)).length, staleKey: subs.filter(s => staleKey(s, env)).length, category };
  const mine = (all[body.nick] || []).map(s => ({
    id: s.id, host: (() => { try { return new URL(s.endpoint).host; } catch { return '?'; } })(),
    vk: s.vk || null, staleKey: staleKey(s, env), prefs: s.prefs, ua: s.ua, updatedAt: s.updatedAt
  }));
  return json(request, env, {
    ok: true,
    vapidPublicPrefix: String(env.VAPID_PUBLIC_KEY || '').slice(0, 16),
    vapid: await vapidHealth(env),
    diagnosis: diagnoseRecipient(entry, totals, 'debug'),
    accountsWithPush: Object.fromEntries(Object.entries(all).filter(([,l])=>Array.isArray(l)).map(([k, l]) => [k, Array.isArray(l) ? l.length : 0])),
    yourDevices: mine
  });
}

async function handleEvent(request, env, body) {
  let jobId = String(body.jobId || '');
  if (body.job) {                                                                 // fallback: the browser could not write the outbox itself
    if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
    const j = body.job;
    if (!['chat', 'news', 'dm'].includes(j?.type)) return json(request, env, { error: 'bad job' }, 400);
    if(!validKey(String(j.id||''))) return json(request,env,{error:'bad source id'},400);
    jobId = `${j.type}_${j.id}`;
    const now = Date.now();
    const snapshot=await rtdbGetWithEtag(env,`pushOutbox/${jobId}`);
    if(!snapshot.value) {
      const result=await rtdbPutIfMatch(env,`pushOutbox/${jobId}`,{
        type:j.type,id:String(j.id),to:String(j.to||''),dmKey:String(j.dmKey||''),sender:body.nick,
        state:'pending',attempts:0,nextAttemptAt:now,queuedAt:now,ts:now
      },snapshot.etag);
      if(!result.ok&&result.status!==412) throw new Error('outbox creation failed');
    }

  }
  if (!/^[-\w]{3,512}$/.test(jobId)) return json(request, env, { error: 'bad jobId' }, 400);
  const budget = { left: maxPush(env) };
  console.log('push event received', jobId, body.job ? 'inline-job' : 'outbox-job');
  const r = await processJob(env, jobId, budget);
  return json(request, env, {
    ok: true,
    sent: r.sent,
    next: r.next,
    retry: !!r.retry,
    discarded: !!r.discarded,
    reason: r.reason || null,
    detail: r.detail || undefined,
    statuses: r.statuses && r.statuses.length ? r.statuses : undefined
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === '/') {
        return json(request, env, {
          ok: true,
          service: 'kapani-push',
          endpoints: { health: 'GET /health', session: 'POST /session', gift: 'POST /gift', abandonOrder: 'POST /abandon-order', subscribe: 'POST /subscribe', unsubscribe: 'POST /unsubscribe', prefs: 'POST /prefs', notify: 'POST /notify', event: 'POST /event', test: 'POST /test', debug: 'POST /debug',auth:'POST /auth',directory:'POST /directory',notificationDelete:'POST /notification/delete',notificationClear:'POST /notification/clear',notificationRead:'POST /notification/read',marketPublish:'POST /market/publish',businessApply:'POST /business/apply',deliveryCreate:'POST /delivery/create',deliveryAction:'POST /delivery/action' }
        });
      }
      if (url.pathname === '/health') {
        const subs = await loadSubs(env);
        return json(request, env, {
          ok: true, version:'kapani-2026-10-03',
          kv: !!env.PUSH_KV,
          vapidPublic: !!env.VAPID_PUBLIC_KEY, vapidPrivate: !!env.VAPID_PRIVATE_KEY, vapidPublicPrefix: String(env.VAPID_PUBLIC_KEY || '').slice(0, 16),
          vapid: await vapidHealth(env),
          serviceAccount: !!env.FIREBASE_SERVICE_ACCOUNT_JSON,
          subscribers: Object.values(subs).filter(Array.isArray).length, devices: Object.values(subs).reduce((n, l) => n + (Array.isArray(l)?l.length:0), 0)
        });
      }
      if (request.method !== 'POST') return json(request, env, { error: 'not found' }, 404);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json(request, env, { error: 'bad json' }, 400);
      if (/^\/notification\/(delete|clear|read)$/.test(url.pathname)) return await handleNotificationAction(request,env,body,url.pathname.split('/').pop());
      if (url.pathname === '/session') return await handleSession(request, env, body);
      if (url.pathname === '/abandon-order') return await handleAbandonOrder(request, env, body);
      if (url.pathname === '/auth') return await handleAuth(request,env,body);
      if (url.pathname === '/directory') return await handleDirectory(request,env,body);
      if (url.pathname === '/delivery/action') return await handleDeliveryAction(request,env,body);
      if (url.pathname === '/delivery/create') return await handleDeliveryCreate(request,env,body);
      if (url.pathname === '/market/address') return await handleMarketAddress(request,env,body);
      if (url.pathname === '/market/publish') return await handleMarketPublish(request,env,body);
      if (url.pathname === '/business/apply') return await handleBusinessApply(request,env,body);
      if (url.pathname === '/gift') return await handleGift(request, env, body);
      if (url.pathname === '/notify') return await handleNotify(request, env, body);
      if (url.pathname === '/subscribe') return await handleSubscribe(request, env, body);
      if (url.pathname === '/unsubscribe') return await handleUnsubscribe(request, env, body);
      if (url.pathname === '/prefs') return await handlePrefs(request, env, body);
      if (url.pathname === '/event') return await handleEvent(request, env, body);
      if (url.pathname === '/test') return await handleTest(request, env, body);
      if (url.pathname === '/debug') return await handleDebug(request, env, body);
      return json(request, env, { error: 'not found' }, 404);
    } catch (e) {
      console.error('worker error', String(e?.message || e));
      return json(request, env, { error: 'server error', detail: String(e?.message || e).slice(0, 200) }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(env)); }
};
