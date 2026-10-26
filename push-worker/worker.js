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
    claims: { admin: !!env.ADMIN_NICK && String(uid) === String(env.ADMIN_NICK) }
  })));
  const input = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', customTokenKeyCache.key, te.encode(input)));
  return `${input}.${b64uEnc(sig)}`;
}

const SUBSCRIPTIONS = Object.freeze({
  plus:  { rank: 1, price: 299,  name: 'Kapani Plus',  durationDays: 7 },
  ultra: { rank: 2, price: 899,  name: 'Kapani Ultra', durationDays: 7 },
  prime: { rank: 3, price: 1499, name: 'Kapani Prime', durationDays: 7 }
});
function normalizeSubscriptionType(value) {
  const v = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTIONS, v) ? v : 'none';
}
function subscriptionRank(user) {
  return Number(SUBSCRIPTIONS[normalizeSubscriptionType(user?.subscription)]?.rank || 0);
}
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
  try { return (await env.PUSH_KV.get('subs', 'json')) || {}; } catch { return {}; }
}
const saveSubs = (env, all) => env.PUSH_KV.put('subs', JSON.stringify(all));

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
  const res = await fetch(sub.endpoint, {
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
const maxPush = env => Math.max(1, Math.min(40, Number(env.MAX_PUSH_PER_RUN) || 10));
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
    const n = await rtdbGet(env, `users/${enc(job.to)}/notifications/${enc(job.id)}`);

    // The site can create pushOutbox/<jobId> and the notification record in two
    // separate RTDB writes. If /event arrives first, KEEP the job instead of
    // deleting it. Cron will retry it after the notification becomes visible.
    if (!n) return { kind: 'retry', reason: 'notification record not visible yet' };

    if (n.pushedAt) return { kind: 'discard', reason: 'notification already pushed' };
    if (n.push === false) return { kind: 'discard', reason: 'push disabled for notification' };

    const payload = payloadFromNotification(env, job.id, n);
    if (!payload.body) return { kind: 'discard', reason: 'notification has empty body' };

    if (n.source === 'dm' && n.from) {
      const open = await rtdbGet(env, `presence/${enc(job.to)}/dmOpenWith`);
      if (open === n.from) {
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
      nicks = recipients.filter(n => presence[n]?.generalChatOpen !== true);
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
async function processJob(env, jobId, budget, preloaded) {
  const job = preloaded || await rtdbGet(env, `pushOutbox/${enc(jobId)}`);
  const finish = async (extra = {}) => {
    await rtdbPatch(env, { [`pushOutbox/${jobId}`]: null, ...extra });
  };
  if (!job || typeof job !== 'object') {
    console.log('push job missing', jobId);
    return { sent: 0, next: null };
  }

  const plan = await planJob(env, job);

  // IMPORTANT: never delete a job just because the source/notification record
  // is not visible yet. This is the race that was losing normal Kapani pushes.
  if (plan?.kind === 'retry') {
    const attempts = Number(job.attempts || 0) + 1;
    const nextJob = {
      ...job,
      attempts,
      queuedAt: Number(job.queuedAt || job.ts || Date.now()),
      ts: Date.now(),
      lastRetryReason: String(plan.reason || 'temporary condition').slice(0, 160)
    };
    await rtdbPatch(env, { [`pushOutbox/${jobId}`]: nextJob });
    console.log('push job retry', jobId, attempts, plan.reason || 'temporary condition');
    return { sent: 0, next: null, retry: true, reason: plan.reason };
  }

  if (plan?.kind === 'discard' || !plan) {
    await finish();
    console.log('push job discarded', jobId, plan?.reason || 'no plan');
    return { sent: 0, next: null, discarded: true, reason: plan?.reason };
  }

  if (Object.keys(plan.inbox).length) {
    await rtdbPatch(env, plan.inbox); // inbox first: record exists before the push arrives
  }

  const all = await loadSubs(env);
  const dead = [];
  let sent = 0, i = 0, hadPushErrors = false, attempted = 0;
  const lookups = [], statuses = [];

  for (; i < plan.nicks.length; i++) {
    const nick = plan.nicks[i];
    const bucket = await subscriptionBucket(env, all, nick);
    const rawSubs = bucket.subs;
    const subs = rawSubs.filter(s => prefsAllow(s, plan.payload.category) && !staleKey(s, env));

    lookups.push({
      recipient: nick, mode: bucket.mode, matchedKey: bucket.key,
      stored: rawSubs.length, eligible: subs.length,
      blockedByPrefs: rawSubs.filter(s => !prefsAllow(s, plan.payload.category)).length,
      staleKey: rawSubs.filter(s => staleKey(s, env)).length, category: plan.payload.category
    });
    console.log('push device lookup', jobId, JSON.stringify({
      recipient: nick,
      matchMode: bucket.mode,
      matchedKey: bucket.key,
      storedDevices: rawSubs.length,
      eligibleDevices: subs.length,
      category: plan.payload.category
    }));

    // If this recipient alone would exceed the remaining budget, defer the
    // whole recipient to a continuation job. This avoids dropping devices.
    if (subs.length && budget.left < subs.length && sent > 0) break;

    for (const s of subs) {
      if (budget.left <= 0) break;
      budget.left--;
      attempted++;

      try {
        const status = await sendPush(env, s, plan.payload);
        statuses.push({ recipient: nick, device: String(s.id).slice(0, 8), host: new URL(s.endpoint).host, status });
        console.log('push send result', jobId, nick, s.id, status);

        if (status === 404 || status === 410) {
          dead.push([nick, s.id]);
        } else if (status >= 200 && status < 300) {
          sent++;
        } else {
          hadPushErrors = true;
          console.warn('push status', status, new URL(s.endpoint).host);
        }
      } catch (e) {
        hadPushErrors = true;
        if (e?.deadSub) dead.push([nick, s.id]);                                   // keys can never work: drop the device, the browser re-registers it
        statuses.push({ recipient: nick, device: String(s.id).slice(0, 8), error: String(e?.message || e).slice(0, 200) });
        console.warn('push error', jobId, nick, String(e?.message || e));
      }
    }

    // This recipient has been handled (fully or up to the budget): the continuation
    // job must start AFTER it, otherwise its devices get the same push twice.
    if (budget.left <= 0) { i++; break; }
  }

  if (dead.length) {
    const fresh = await loadSubs(env);
    for (const [nick, id] of dead) {
      if (fresh[nick]) {
        fresh[nick] = fresh[nick].filter(s => s.id !== id);
        if (!fresh[nick].length) delete fresh[nick];
      }
    }
    await saveSubs(env, fresh);
  }

  // A normal notification is only considered delivered after at least one
  // real Web Push succeeds. Temporary send failures keep the job alive.
  if (job.type === 'notification' && plan.nicks.length && sent === 0) {
    const attempts = Number(job.attempts || 0) + 1;
    const lookupMiss = !attempted && !hadPushErrors;
    const retryJob = {
      ...job,
      attempts,
      queuedAt: Number(job.queuedAt || job.ts || Date.now()),
      ts: Date.now(),
      lastRetryReason: attempted ? (hadPushErrors ? 'push delivery failed' : 'push device not delivered') : 'no eligible push device'
    };

    if (lookupMiss) {
      console.warn('notification has no eligible device', jobId, JSON.stringify({ recipient: plan.nicks[0], category: plan.payload.category }));
    }

    // If there is still no active device, keep the job until the normal
    // 24-hour outbox retention limit. This lets a newly-registered device
    // receive the queued notification instead of losing it immediately.
    await rtdbPatch(env, { [`pushOutbox/${jobId}`]: retryJob });
    console.log('notification queued for retry', jobId, retryJob.lastRetryReason);
    const totals = { accounts: Object.keys(all).length, devices: Object.values(all).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0) };
    return {
      sent: 0, next: null, retry: true, reason: retryJob.lastRetryReason,
      detail: lookups[0] ? diagnoseRecipient(lookups[0], totals) : null,
      statuses
    };
  }

  const rest = plan.nicks.slice(i);
  let next = null;
  const extra = {};

  // For fanout jobs, do NOT mark pushDone until all recipients fit in the
  // current invocation and have been handed off/processed.
  if (rest.length) {
    next = `${String(jobId).replace(/_c[0-9a-z]+$/, '')}_c${Date.now().toString(36)}`;
    extra[`pushOutbox/${next}`] = {
      type: 'deliver',
      payload: plan.payload,
      nicks: rest,
      marks: plan.marks,
      queuedAt: Number(job.queuedAt || job.ts || Date.now()),
      ts: Date.now()
    };
  } else {
    Object.assign(extra, plan.marks);
  }

  await finish(extra);
  console.log('push job completed', jobId, { sent, attempted, next });
  return { sent, next, statuses };
}

async function runCron(env) {
  const jobs = await rtdbGet(env, 'pushOutbox', '?orderBy=%22%24key%22&limitToFirst=10');
  if (!jobs) return;
  const budget = { left: maxPush(env) };
  for (const [id, job] of Object.entries(jobs)) {
    if (budget.left <= 0) break;
    const age = Date.now() - Number(job?.queuedAt || job?.ts || 0);
    if (age > 24 * 3600e3) { await rtdbPatch(env, { [`pushOutbox/${id}`]: null }); continue; }
    if (age < 15000) continue;                                                    // the live /event call is probably handling it
    try { await processJob(env, id, budget, job); }
    catch (e) {
      const attempts = Number(job.attempts || 0) + 1;
      console.warn('job failed', id, String(e?.message || e));
      await rtdbPatch(env, { [`pushOutbox/${id}`]: attempts >= 5 ? null : { ...job, attempts } }).catch(() => {});
    }
  }
}

/* ───────────── request handlers ───────────── */
async function handleSession(request, env, body) {
  const nick = String(body?.nick || '').trim();
  const ph = String(body?.ph || '').trim();
  if (!(await verifyUser(env, nick, ph))) return json(request, env, { error: 'unauthorized' }, 401);
  const token = await createFirebaseCustomToken(env, nick);
  return json(request, env, { ok: true, token, uid: nick });
}

// Release an assigned taxi/delivery job without granting the browser permission
// to edit the order or the worker's balance. Both changes commit atomically.
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
  const giftId = giftIdPart('gift');
  const giverTxId = giftIdPart('tx');
  const recipientTxId = giftIdPart('tx');
  const giverJobId = giftIdPart('push');
  const recipientJobId = giftIdPart('push');

  const tx = await rtdbRootTransaction(env, async (root) => {
    const users = root?.users && typeof root.users === 'object' ? root.users : {};
    const giver = users[giverNick];
    const recipient = users[recipientNick];
    if (!giver || !recipient) return { abort: true, reason: 'Пользователь не найден' };

    const balance = Number(giver.balance || 0);
    if (!Number.isFinite(balance) || balance < price) return { abort: true, reason: `Недостаточно средств. Нужно ${price}₽` };

    const recipientRank = subscriptionRank(recipient);
    if (recipientRank >= giftRank) return { abort: true, reason: 'Нельзя подарить эту подписку. У пользователя уже есть подписка более высокого уровня.' };

    const currentExpiry = recipient.subscriptionExpiry ? new Date(recipient.subscriptionExpiry) : null;
    const activeSameType = normalizeSubscriptionType(recipient.subscription) === type
      && currentExpiry && !Number.isNaN(currentExpiry.getTime()) && currentExpiry.getTime() > committedAt;
    const expiry = activeSameType
      ? new Date(currentExpiry.getTime() + 7 * 24 * 60 * 60 * 1000)
      : new Date(committedAt + 7 * 24 * 60 * 60 * 1000);
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
      [giverJobId]: { type: 'notification', to: giverNick, id: `gift_${giftId}`, sender: giverNick, queuedAt: committedAt, ts: committedAt },
      [recipientJobId]: { type: 'notification', to: recipientNick, id: `gift_${giftId}`, sender: giverNick, queuedAt: committedAt, ts: committedAt }
    };
    return { value: next };
  });

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

    const notificationId = String(body?.notificationId || '').trim();
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

    const rnd = Array.from(crypto.getRandomValues(new Uint32Array(2)), x => x.toString(36)).join('');
    const jobId = `p${Date.now().toString(36)}${rnd}`.slice(0, 60);
    const job = {
      type: 'notification',
      to: targetNick,
      id: notificationId,
      sender,
      queuedAt: Date.now(),
      ts: Date.now()
    };

    // Notification + durable push job are created in ONE authenticated server-side
    // RTDB patch. The browser therefore never needs write access to protected inbox paths,
    // and Firebase Cloud Functions are not needed for push on the Spark plan.
    await rtdbPatch(env, {
      [`users/${enc(targetNick)}/notifications/${enc(notificationId)}`]: record,
      [`pushOutbox/${enc(jobId)}`]: job
    });

    const result = await processJob(env, jobId, { left: maxPush(env) });
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
  const all = await loadSubs(env);
  const owner = await subscriptionBucket(env, all, nick);
  const displayNameRaw = await rtdbGet(env, `users/${enc(nick)}/displayName`).catch(() => null);
  const displayName = String(displayNameRaw || body.displayName || '').trim().slice(0, 120);

  // Nothing changed since the last registration: skip the KV write (free plan: ~1000 writes/day).
  const curSub = (all[nick] || []).find(x => x.id === id);
  if (curSub && curSub.displayName === displayName && JSON.stringify(curSub.prefs) === JSON.stringify(sanitizePrefs(prefs))
      && Date.now() - Number(curSub.updatedAt || 0) < 12 * 3600e3) {
    return json(request, env, { success: true, subscriptionId: id, ownerNick: nick, displayName, unchanged: true });
  }

  // If an older registration used the same account name with different
  // casing/spacing, migrate that bucket to the exact authenticated nick.
  // This repairs existing subscriptions without requiring the browser to
  // generate a new PushSubscription.
  if (owner.key && owner.key !== nick && !Array.isArray(all[nick])) {
    all[nick] = owner.subs.slice();
    delete all[owner.key];
    console.log('push subscription owner normalized', owner.key, '=>', nick);
  }

  for (const n of Object.keys(all)) {                                             // a device belongs to one account
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
  await saveSubs(env, all);
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
  const all = await loadSubs(env);
  const before = (all[body.nick] || []).length;
  all[body.nick] = (all[body.nick] || []).filter(x => x.id !== body.subscriptionId);
  if (!all[body.nick].length) delete all[body.nick];
  await saveSubs(env, all);
  return json(request, env, { success: true, removed: before !== (all[body.nick] || []).length });
}
async function handlePrefs(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
  const all = await loadSubs(env);
  const sub = (all[body.nick] || []).find(x => x.id === body.subscriptionId);
  if (!sub) return json(request, env, { error: 'subscription not found' }, 404);
  sub.prefs = sanitizePrefs(body.prefs);
  await saveSubs(env, all);
  return json(request, env, { success: true, prefs: sub.prefs });
}
async function handleTest(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);

  const all = await loadSubs(env);
  const subs = (all[body.nick] || []).filter(s => prefsAllow(s, String(body.category || 'system')));
  if (!subs.length) return json(request, env, { ok: true, sent: 0, devices: 0, message: 'no active push devices for this user' });

  const payload = {
    title: String(body.title || 'Капани — тест Push').slice(0, 120),
    body: String(body.body || 'Тестовое Push-уведомление успешно отправлено.').trim().slice(0, 1000),
    category: String(body.category || 'system'),
    notificationId: `test_${Date.now().toString(36)}`,
    url: String(body.url || appUrl(env)),
    createdAt: Date.now(),
    source: 'worker_test',
    sourceMessageId: ''
  };

  let sent = 0;
  const dead = new Set();
  const results = [];
  for (const sub of subs) {
    try {
      const status = await sendPush(env, sub, payload);
      results.push({ id: sub.id, status });
      if (status === 404 || status === 410) dead.add(sub.id);
      else if (status >= 200 && status < 300) sent++;
    } catch (e) {
      results.push({ id: sub.id, error: String(e?.message || e).slice(0, 200) });
    }
  }

  if (dead.size) {
    const fresh = await loadSubs(env);
    if (fresh[body.nick]) {
      fresh[body.nick] = fresh[body.nick].filter(s => !dead.has(s.id));
      if (!fresh[body.nick].length) delete fresh[body.nick];
      await saveSubs(env, fresh);
    }
  }

  return json(request, env, { ok: true, sent, devices: subs.length, results });
}

async function handleDebug(request, env, body) {
  if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
  const all = await loadSubs(env);
  const totals = { accounts: Object.keys(all).length, devices: Object.values(all).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0) };
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
    accountsWithPush: Object.fromEntries(Object.entries(all).map(([k, l]) => [k, Array.isArray(l) ? l.length : 0])),
    yourDevices: mine
  });
}

async function handleEvent(request, env, body) {
  let jobId = String(body.jobId || '');
  if (body.job) {                                                                 // fallback: the browser could not write the outbox itself
    if (!(await verifyUser(env, body.nick, body.ph))) return json(request, env, { error: 'unauthorized' }, 401);
    const j = body.job;
    if (!['notification', 'chat', 'news'].includes(j?.type)) return json(request, env, { error: 'bad job' }, 400);
    jobId = `w${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    const now = Date.now();
    await rtdb(env, 'PUT', `pushOutbox/${jobId}`, {
      type: j.type,
      id: String(j.id || ''),
      to: String(j.to || ''),
      sender: body.nick,
      queuedAt: now,
      ts: now
    });
  }
  if (!validKey(jobId)) return json(request, env, { error: 'bad jobId' }, 400);
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
          endpoints: { health: 'GET /health', session: 'POST /session', gift: 'POST /gift', abandonOrder: 'POST /abandon-order', subscribe: 'POST /subscribe', unsubscribe: 'POST /unsubscribe', prefs: 'POST /prefs', notify: 'POST /notify', event: 'POST /event', test: 'POST /test', debug: 'POST /debug' }
        });
      }
      if (url.pathname === '/health') {
        const subs = await loadSubs(env);
        return json(request, env, {
          ok: true,
          kv: !!env.PUSH_KV,
          vapidPublic: !!env.VAPID_PUBLIC_KEY, vapidPrivate: !!env.VAPID_PRIVATE_KEY, vapidPublicPrefix: String(env.VAPID_PUBLIC_KEY || '').slice(0, 16),
          vapid: await vapidHealth(env),
          serviceAccount: !!env.FIREBASE_SERVICE_ACCOUNT_JSON,
          subscribers: Object.keys(subs).length, devices: Object.values(subs).reduce((n, l) => n + l.length, 0)
        });
      }
      if (request.method !== 'POST') return json(request, env, { error: 'not found' }, 404);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json(request, env, { error: 'bad json' }, 400);
      if (url.pathname === '/session') return await handleSession(request, env, body);
      if (url.pathname === '/abandon-order') return await handleAbandonOrder(request, env, body);
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
