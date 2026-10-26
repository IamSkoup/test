// Kapani Free Push Bridge — production push path.
// Kapani Free Push Bridge
// RTDB -> Cloudflare Worker -> FCM HTTP v1
// RTDB закрыт для анонимного REST-доступа. Worker использует
// короткоживущий Google OAuth2 access token из server-only service account
// и этим же контуром отправляет FCM HTTP v1.

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/firebase.messaging'
].join(' ');
const FIREBASE_CUSTOM_TOKEN_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const KAPANI_CANONICAL_URL = 'https://iamskoup1.github.io/kapani/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IDENTITY_LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

function base64UrlEncode(input) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new TextEncoder().encode(String(input));

  let binary = '';
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const base64 = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}


function normalizePublicName(value) {
  return String(value || '').trim().toLowerCase();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value || ''))
  );
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashKapaniPassword(password, salt) {
  return sha256Hex(
    `kapani::${normalizePublicName(salt)}::${String(password || '')}`
  );
}

async function signJwtRS256(serviceAccount, headerObject, payloadObject) {
  const header = base64UrlEncode(JSON.stringify(headerObject));
  const payload = base64UrlEncode(JSON.stringify(payloadObject));
  const unsigned = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getServiceAccount(env) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(String(env.FIREBASE_SERVICE_ACCOUNT_JSON || ''));
  } catch (_) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON');
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }
  return serviceAccount;
}

async function createFirebaseCustomToken(env, uid, additionalClaims = {}) {
  const serviceAccount = await getServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid || normalizedUid.length > 128) {
    throw new Error('Invalid Firebase UID for custom token');
  }

  return signJwtRS256(
    serviceAccount,
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: FIREBASE_CUSTOM_TOKEN_AUD,
      iat: now,
      exp: now + 3600,
      uid: normalizedUid,
      claims: {
        ...additionalClaims,
        provider: 'kapani-cloudflare'
      }
    }
  );
}

async function pushBridgeSecret(env) {
  // Reuse the existing server-only Cloudflare secret. Nothing derived from it is
  // exposed to the frontend except a short-lived signed session token.
  const source = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!source) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return new Uint8Array(digest);
}

async function signPushBridgeSession(env, uid, exp) {
  const secret = await pushBridgeSecret(env);
  const payload = `${String(uid)}.${String(exp)}`;
  const key = await crypto.subtle.importKey('raw', secret, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `cfp.${base64UrlEncode(payload)}.${base64UrlEncode(sig)}`;
}

async function verifyPushBridgeSession(request, env) {
  const bearer = getBearerToken(request);
  if (!bearer.startsWith('cfp.')) return null;
  const parts = bearer.split('.');
  if (parts.length !== 3) throw new Error('Invalid Cloudflare push session');
  let payloadText = '';
  let signature = null;
  try {
    payloadText = new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/').padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '=')), c=>c.charCodeAt(0)));
    signature = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/').padEnd(parts[2].length + (4 - parts[2].length % 4) % 4, '=')), c=>c.charCodeAt(0));
  } catch (_) { throw new Error('Invalid Cloudflare push session encoding'); }
  const [uid, expText] = payloadText.split('.');
  const exp = Number(expText || 0);
  if (!uid || !Number.isFinite(exp) || exp <= Math.floor(Date.now()/1000)) throw new Error('Cloudflare push session expired');
  const secret = await pushBridgeSecret(env);
  const key = await crypto.subtle.importKey('raw', secret, { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(payloadText));
  if (!ok) throw new Error('Invalid Cloudflare push session signature');
  return { uid, exp };
}

async function authenticatePushRequest(request, env) {
  const bridge = await verifyPushBridgeSession(request, env);
  if (bridge) return bridge;
  // Backward compatibility for already-deployed clients. New client code uses
  // the Cloudflare-issued cfp.* token and does not wait for Firebase Auth.
  return authenticateRequest(request, env);
}

async function handleSession(request, env) {
  let input;
  try {
    input = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, request);
  }

  const nick = String(input?.nick || '').trim();
  const password = String(input?.password || '');
  if (!nick || !password) {
    return jsonResponse({ ok: false, error: 'nick and password are required' }, 400, request);
  }

  const user = await rtdbGet(env, `users/${encodeURIComponent(nick)}`);
  if (!user) {
    return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401, request);
  }

  const expected = String(user.passwordHash || '');
  const salt = String(user.passwordHashSalt || user.nick || nick);
  if (!expected) {
    return jsonResponse({ ok: false, error: 'Account does not have a password configured' }, 403, request);
  }

  const actual = await hashKapaniPassword(password, salt);
  if (actual !== expected) {
    return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401, request);
  }

  const token = await createFirebaseCustomToken(env, nick, {
    nick: String(user.nick || nick),
    displayName: String(user.displayName || nick)
  });

  const pushTokenExp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const pushToken = await signPushBridgeSession(env, nick, pushTokenExp);

  return jsonResponse({
    ok: true,
    token,
    uid: nick,
    expiresIn: 3600,
    pushToken,
    pushTokenExpiresAt: pushTokenExp * 1000
  }, 200, request);
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  if (
    cachedAccessToken &&
    cachedAccessTokenExp - now > 120
  ) {
    return cachedAccessToken;
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
  } catch (error) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON'
    );
  }

  if (
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key'
    );
  }

  const header = base64UrlEncode(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT'
    })
  );

  const payload = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: GOOGLE_SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    })
  );

  const unsigned = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  const assertion =
    `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type':
        'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type:
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Google OAuth failed: ${response.status} ${responseText}`
    );
  }

  let json;

  try {
    json = JSON.parse(responseText);
  } catch (_) {
    throw new Error(
      'Google OAuth returned invalid JSON'
    );
  }

  if (!json.access_token) {
    throw new Error(
      'Google OAuth response does not contain access_token'
    );
  }

  cachedAccessToken = json.access_token;
  cachedAccessTokenExp =
    now + Number(json.expires_in || 3600);

  return cachedAccessToken;
}

function rtdbUrl(env, path) {
  const base = String(
    env.FIREBASE_DATABASE_URL || ''
  ).replace(/\/$/, '');

  return `${base}/${path}.json`;
}

async function rtdbAuthHeaders(env, extra = {}) {
  const accessToken = await getGoogleAccessToken(env);
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

// RTDB rules are intentionally closed to anonymous REST traffic. The Worker
// accesses RTDB with a short-lived Google OAuth2 access token minted from the
// server-only Firebase service account. This keeps the public database rules
// locked while still letting the push backend read/write its queue and tokens.
async function rtdbGet(env, path) {
  const response = await fetch(
    rtdbUrl(env, path),
    { headers: await rtdbAuthHeaders(env) }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `RTDB GET ${path}: ${response.status} ${text}`
    );
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    throw new Error(
      `RTDB GET ${path}: invalid JSON response`
    );
  }
}

async function rtdbGetWithEtag(env, path) {
  const response = await fetch(rtdbUrl(env, path), {
    headers: await rtdbAuthHeaders(env, { 'X-Firebase-ETag': 'true' })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RTDB GET+ETag ${path}: ${response.status} ${text}`);
  }
  return {
    data: text ? JSON.parse(text) : null,
    etag: response.headers.get('ETag') || null
  };
}

async function rtdbPutIfMatch(env, path, value, etag) {
  const response = await fetch(rtdbUrl(env, path), {
    method: 'PUT',
    headers: await rtdbAuthHeaders(env, {
      'content-type': 'application/json',
      'if-match': String(etag || 'null_etag')
    }),
    body: JSON.stringify(value)
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
    data: text ? JSON.parse(text) : null,
    etag: response.headers.get('ETag') || null
  };
}

async function rtdbPatch(env, patch) {
  if (!Object.keys(patch).length) return;

  const response = await fetch(
    rtdbUrl(env, ''),
    {
      method: 'PATCH',
      headers: await rtdbAuthHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify(patch)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `RTDB PATCH: ${response.status} ${text}`
    );
  }
}


async function tokenKey(token) {
  return (await sha256Hex(String(token || ''))).slice(0, 32);
}

function getBearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function authenticateRequest(request, env) {
  const idToken = getBearerToken(request);
  if (!idToken) throw new Error('Missing Firebase ID token');
  const apiKey = String(env.FIREBASE_WEB_API_KEY || '').trim();
  if (!apiKey) throw new Error('FIREBASE_WEB_API_KEY is not configured');

  const response = await fetch(`${IDENTITY_LOOKUP_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Firebase Auth verification failed: ${response.status} ${text}`);
  const json = JSON.parse(text);
  const account = Array.isArray(json.users) ? json.users[0] : null;
  const uid = String(account?.localId || '').trim();
  if (!uid) throw new Error('Firebase ID token has no localId');
  return { uid, account };
}

function extractPrefs(input) {
  const src = input && typeof input === 'object' ? input : {};
  const allowed = ['enabled','messages','money','taxi_orders','delivery_orders','market','news','system'];
  const out = {};
  for (const key of allowed) {
    if (src[key] !== undefined) out[key] = src[key] !== false;
  }
  return out;
}

async function handleRegister(request, env) {
  let input;
  try { input = await request.json(); } catch (_) { return jsonResponse({ ok:false, error:'Invalid JSON' }, 400); }
  try {
    const { uid } = await authenticatePushRequest(request, env);
    const token = String(input?.token || '').trim();
    if (!token || token.length < 20) return jsonResponse({ ok:false, error:'Invalid FCM token' }, 400);
    const tokenId = await tokenKey(token);
    const now = Date.now();
    const prefs = extractPrefs(input?.prefs);
    const index = await rtdbGet(env, `fcmTokenIndex/${encodeURIComponent(tokenId)}`);
    const updates = {};

    if (index && index.uid && String(index.uid) !== uid) {
      const oldUid = encodeURIComponent(String(index.uid));
      updates[`users/${oldUid}/fcmTokens/${tokenId}`] = null;
      if (String(index.token || '') === token) updates[`users/${oldUid}/fcmToken`] = null;
    }

    updates[`users/${encodeURIComponent(uid)}/fcmTokens/${tokenId}`] = {
      token,
      updatedAt: now,
      userAgent: String(input?.userAgent || '').slice(0, 500),
      pushPrefs: prefs
    };
    updates[`users/${encodeURIComponent(uid)}/fcmToken`] = token;
    updates[`users/${encodeURIComponent(uid)}/fcmUpdatedAt`] = now;
    if (Object.keys(prefs).length) updates[`users/${encodeURIComponent(uid)}/pushPrefs`] = prefs;
    updates[`fcmTokenIndex/${tokenId}`] = { uid, token, updatedAt: now };
    await rtdbPatch(env, updates);
    const tokenCount = collectTokens(await rtdbGet(env, `users/${encodeURIComponent(uid)}`) || {}).length;
    return jsonResponse({ ok:true, success:true, tokenId, uid, tokenCount }, 200);
  } catch (error) {
    return jsonResponse({ ok:false, error:String(error?.message || error) }, 401);
  }
}

async function handleUnregister(request, env) {
  let input;
  try { input = await request.json(); } catch (_) { return jsonResponse({ ok:false, error:'Invalid JSON' }, 400); }
  try {
    const { uid } = await authenticatePushRequest(request, env);
    const tokenId = String(input?.tokenId || '').trim();
    const token = String(input?.token || '').trim();
    const resolved = tokenId || await tokenKey(token);
    if (!resolved) return jsonResponse({ ok:false, error:'tokenId or token required' }, 400);
    const userPath = encodeURIComponent(uid);
    const tokenSnap = await rtdbGet(env, `users/${userPath}/fcmTokens/${encodeURIComponent(resolved)}`);
    const legacy = await rtdbGet(env, `users/${userPath}/fcmToken`);
    const updates = {
      [`users/${userPath}/fcmTokens/${encodeURIComponent(resolved)}`]: null,
      [`fcmTokenIndex/${encodeURIComponent(resolved)}`]: null
    };
    const stored = typeof tokenSnap === 'string' ? tokenSnap : String(tokenSnap?.token || '');
    if ((stored && legacy === stored) || (!tokenSnap && token && legacy === token)) {
      updates[`users/${userPath}/fcmToken`] = null;
      updates[`users/${userPath}/fcmUpdatedAt`] = null;
    }
    await rtdbPatch(env, updates);
    return jsonResponse({ ok:true, success:true, tokenId:resolved, removed:!!tokenSnap || !!legacy }, 200);
  } catch (error) {
    return jsonResponse({ ok:false, error:String(error?.message || error) }, 401);
  }
}

async function handleDiagnostics(request, env) {
  try {
    const { uid } = await authenticatePushRequest(request, env);
    const user = await rtdbGet(env, `users/${encodeURIComponent(uid)}`) || {};
    const tokens = collectTokens(user);
    const tokenRows = [];
    for (const entry of tokens) {
      const tid = await tokenKey(entry.token);
      const stored = user?.fcmTokens?.[tid];
      tokenRows.push({
        tokenId: tid,
        updatedAt: Number(stored?.updatedAt || user?.fcmUpdatedAt || 0) || null
      });
    }
    const queue = await getUserQueueDiagnostics(env, uid);
    return jsonResponse({
      ok: true,
      user: uid,
      tokenCount: tokens.length,
      tokens: tokenRows,
      queue
    }, 200, request);
  } catch (error) {
    return jsonResponse({ ok:false, error:String(error?.message || error) }, 401, request);
  }
}

async function getUserQueueDiagnostics(env, uid) {
  const snap = await rtdbGet(env, 'pushQueue');
  const values = snap && typeof snap === 'object' ? Object.values(snap) : [];
  const own = values.filter(job => String(job?.nick || '') === String(uid));
  const counts = { pending:0, processing:0, retry:0, waiting_token:0, sent:0, skipped:0, dead:0 };
  for (const job of own) {
    const status = String(job?.status || '');
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status]++;
  }
  return { counts, activeJobs: own.filter(job => ['pending','processing','retry','waiting_token'].includes(String(job?.status || ''))).slice(0,20) };
}

function collectTokens(user) {
  const entries = [];
  const seen = new Set();

  const add = (token, path, pushPrefs = null) => {
    const value = String(token || '').trim();

    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    entries.push({
      token: value,
      path,
      pushPrefs: pushPrefs || user?.pushPrefs || {}
    });
  };

  add(user?.fcmToken, null, user?.pushPrefs || null);

  const many =
    user?.fcmTokens &&
    typeof user.fcmTokens === 'object'
      ? user.fcmTokens
      : {};

  for (const [id, entry] of Object.entries(many)) {
    if (typeof entry === 'string') {
      add(
        entry,
        `fcmTokens/${id}`,
        user?.pushPrefs || null
      );
    } else if (
      entry &&
      typeof entry.token === 'string'
    ) {
      add(
        entry.token,
        `fcmTokens/${id}`,
        entry.pushPrefs || user?.pushPrefs || null
      );
    }
  }

  return entries;
}

async function sendOneFcm(
  env,
  accessToken,
  token,
  notificationId,
  notification
) {
  const projectId = String(
    env.FIREBASE_PROJECT_ID || 'kapanisite'
  );

  const url =
    `https://fcm.googleapis.com/v1/projects/` +
    `${encodeURIComponent(projectId)}/messages:send`;

  const title = String(
    notification?.title || 'Капани'
  );

  const body = String(
    notification?.text ||
    notification?.body ||
    ''
  );

  const category = String(
    notification?.cat || 'system'
  );

  const targetUrl = String(
    notification?.url || KAPANI_CANONICAL_URL
  );

  const createdAt = String(
    notification?.createdAt || Date.now()
  );

  const payload = {
    message: {
      token,

      data: {
        title,
        body,
        text: body,
        category,
        notificationId: String(notificationId),
        url: targetUrl,
        createdAt
      },

      webpush: {
        headers: {
          Urgency: 'high'
        }
      }
    }
  };

  const response = await fetch(
    url,
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
        'content-type':
          'application/json; UTF-8'
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  let json = null;

  try {
    json = JSON.parse(text);
  } catch (_) {}

  return {
    ok: response.ok,
    status: response.status,
    json,
    text
  };
}

function shouldRemoveToken(result) {
  const status =
    Number(result?.status || 0);

  const errorCode =
    String(
      result?.json?.error?.details?.[0]
        ?.errorCode || ''
    );

  const errorStatus =
    String(
      result?.json?.error?.status || ''
    );

  return (
    status === 404 ||
    status === 400 ||
    errorStatus === 'NOT_FOUND' ||
    errorCode === 'UNREGISTERED'
  );
}

const MAX_QUEUE_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;
const WAITING_TOKEN_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;

async function queueJobId(nick, notificationId) {
  // Must match functions/index.js::notificationJobId exactly. Token IDs are
  // intentionally truncated to 32 hex chars, but queue job IDs are full SHA-256.
  return sha256Hex(`${String(nick)}:${String(notificationId)}`);
}

function nowMs() { return Date.now(); }

function retryDelayMs(attempt) {
  const exp = Math.min(MAX_RETRY_MS, 30 * 1000 * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(30 * 1000, exp * 0.25));
  return Math.min(MAX_RETRY_MS, exp + jitter);
}

function tokenPrefEnabled(entry, category) {
  const prefs = entry?.pushPrefs && typeof entry.pushPrefs === 'object' ? entry.pushPrefs : {};
  if (prefs.enabled === false) return false;
  if (category && prefs[category] === false) return false;
  return true;
}

async function enqueueNotificationJob(env, nick, notificationId, requestedByUid = '') {
  const safeNick = encodeURIComponent(String(nick).trim());
  const safeId = encodeURIComponent(String(notificationId).trim());
  const notification = await rtdbGet(env, `users/${safeNick}/notifications/${safeId}`);
  if (!notification) throw new Error('Notification not found');

  const targetUser = await rtdbGet(env, `users/${safeNick}`) || {};
  if (requestedByUid && String(requestedByUid) !== String(nick) && !targetUser?.authUid && requestedByUid !== 'system') {
    // Kapani custom-auth UIDs are nicknames. Keep the check explicit so a caller
    // cannot enqueue a notification for a different authenticated account.
    throw new Error('Authenticated user does not own this notification target');
  }

  const jobId = await queueJobId(nick, notificationId);
  const existing = await rtdbGet(env, `pushQueue/${encodeURIComponent(jobId)}`);
  if (existing && ['pending','processing','retry','waiting_token'].includes(String(existing.status || ''))) {
    return { ok: true, queued: true, duplicate: true, jobId, status: existing.status };
  }
  const createdAt = Number(notification.createdAt || nowMs());
  const job = {
    jobId,
    nick: String(nick),
    notificationId: String(notificationId),
    status: existing?.status === 'sent' ? 'sent' : 'pending',
    attempts: Number(existing?.attempts || 0),
    createdAt,
    updatedAt: nowMs(),
    retryAt: nowMs(),
    lastError: null
  };
  if (job.status === 'sent') {
    return { ok:true, queued:true, duplicate:true, jobId, status:'sent' };
  }
  await rtdbPatch(env, {
    [`pushQueue/${encodeURIComponent(jobId)}`]: job,
    [`users/${safeNick}/pushQueueRefs/${encodeURIComponent(jobId)}`]: { notificationId:String(notificationId), updatedAt:job.updatedAt }
  });
  return { ok:true, queued:true, duplicate:false, jobId, status:'pending' };
}

function extractFcmError(result) {
  return {
    status: Number(result?.status || 0),
    errorStatus: String(result?.json?.error?.status || ''),
    errorCode: String(result?.json?.error?.details?.find?.(d => d?.errorCode)?.errorCode || ''),
    message: String(result?.json?.error?.message || result?.text || result?.error || 'FCM error').slice(0, 1000)
  };
}

function classifyFcmResult(result) {
  if (result?.ok) return 'sent';
  const e = extractFcmError(result);
  if (e.status === 404 || e.errorCode === 'UNREGISTERED' || e.errorStatus === 'NOT_FOUND') return 'permanent';
  if (e.status === 429 || e.status === 408 || e.status >= 500 || e.errorStatus === 'UNAVAILABLE' || e.errorStatus === 'RESOURCE_EXHAUSTED' || e.errorStatus === 'DEADLINE_EXCEEDED') return 'transient';
  return 'permanent_payload';
}

async function claimQueueJob(env, jobId) {
  const safeId = encodeURIComponent(jobId);
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    const snapshot = await rtdbGetWithEtag(env, `pushQueue/${safeId}`);
    const current = snapshot.data;
    const etag = snapshot.etag;
    if (!current) return null;

    const now = nowMs();
    const status = String(current.status || 'pending');
    const retryAt = Number(current.retryAt || 0);
    const leaseUntil = Number(current.leaseUntil || 0);

    if (status === 'sent' || status === 'skipped' || status === 'dead') return null;
    if ((status === 'retry' || status === 'waiting_token') && retryAt > now) return null;
    if (status === 'processing' && leaseUntil > now) return null;

    const nextAttempt = Number(current.attempts || 0) + 1;
    if (nextAttempt > MAX_QUEUE_ATTEMPTS) {
      await rtdbPatch(env, {
        [`pushQueue/${safeId}/status`]: 'dead',
        [`pushQueue/${safeId}/updatedAt`]: now,
        [`pushQueue/${safeId}/leaseUntil`]: null,
        [`pushQueue/${safeId}/lastError`]: 'max_attempts_exceeded'
      });
      return null;
    }

    const claimed = {
      ...current,
      status: 'processing',
      attempts: nextAttempt,
      leaseUntil: now + LEASE_MS,
      updatedAt: now,
      lastStartedAt: now
    };

    const result = await rtdbPutIfMatch(env, `pushQueue/${safeId}`, claimed, etag);
    if (result.status === 412) {
      continue;
    }
    if (!result.ok) {
      throw new Error(`RTDB queue claim failed: ${result.status} ${result.text}`);
    }
    return claimed;
  }

  return null;
}

async function processQueueJob(env, claimed) {
  const jobId = String(claimed.jobId || '');
  const safeJobId = encodeURIComponent(jobId);
  const nick = String(claimed.nick || '').trim();
  const notificationId = String(claimed.notificationId || '').trim();
  const startedAt = nowMs();
  const safeNick = encodeURIComponent(nick);
  try {
    const notification = await rtdbGet(env, `users/${safeNick}/notifications/${encodeURIComponent(notificationId)}`);
    if (!notification || notification.push === false) {
      await rtdbPatch(env, { [`pushQueue/${safeJobId}/status`]:'skipped', [`pushQueue/${safeJobId}/reason`]: 'notification_missing_or_disabled', [`pushQueue/${safeJobId}/updatedAt`]:nowMs(), [`pushQueue/${safeJobId}/leaseUntil`]:null });
      return { status:'skipped', jobId };
    }
    const user = await rtdbGet(env, `users/${safeNick}`) || {};
    const allTokens = collectTokens(user);
    const category = String(notification?.cat || 'system');
    const eligible = allTokens.filter(entry => tokenPrefEnabled({ ...entry, pushPrefs: entry.pushPrefs || user?.pushPrefs }, category));
    if (!eligible.length) {
      const hasTokens = allTokens.length > 0;
      const nextStatus = hasTokens ? 'skipped' : 'waiting_token';
      await rtdbPatch(env, {
        [`pushQueue/${safeJobId}/status`]: nextStatus,
        [`pushQueue/${safeJobId}/retryAt`]: hasTokens ? null : (nowMs() + WAITING_TOKEN_MS),
        [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
        [`pushQueue/${safeJobId}/leaseUntil`]: null,
        [`pushQueue/${safeJobId}/lastError`]: hasTokens ? 'push_disabled_by_preferences' : 'no_registered_tokens',
        ...(hasTokens ? { [`pushQueue/${safeJobId}/reason`]: 'push_disabled_by_preferences' } : {})
      });
      return { status:nextStatus, jobId };
    }

    const priorDeliveries = claimed.deliveries && typeof claimed.deliveries === 'object' ? claimed.deliveries : {};
    const accessToken = await getGoogleAccessToken(env);
    const cleanup = {};
    const deliveryUpdates = {};
    let sent = 0, retryable = 0, permanent = 0;

    for (const entry of eligible) {
      const tid = await tokenKey(entry.token);
      if (priorDeliveries[tid]?.status === 'sent') { sent++; continue; }
      let result;
      try {
        result = await sendOneFcm(env, accessToken, entry.token, notificationId, notification);
      } catch (error) {
        result = { ok:false, status:500, error:String(error?.message || error) };
      }
      const kind = classifyFcmResult(result);
      const err = kind === 'sent' ? null : extractFcmError(result);
      deliveryUpdates[`pushQueue/${safeJobId}/deliveries/${tid}`] = {
        tokenId: tid,
        path: entry.path || null,
        status: kind,
        updatedAt: nowMs(),
        error: err
      };
      if (kind === 'sent') { sent++; }
      else if (kind === 'permanent') {
        permanent++;
        if (entry.path) cleanup[`users/${safeNick}/${entry.path}`] = null;
        else cleanup[`users/${safeNick}/fcmToken`] = null;
      } else if (kind === 'transient') {
        retryable++;
      } else if (kind === 'permanent_payload') {
        permanent++;
      }
      console.log(JSON.stringify({ tag:'kapani.push', jobId, notificationId, nick, tokenId:tid, attempt:Number(claimed.attempts||0), status:kind, timestamp:nowMs() }));
    }

    if (Object.keys(cleanup).length) {
      await rtdbPatch(env, cleanup);
    }
    if (Object.keys(deliveryUpdates).length) await rtdbPatch(env, deliveryUpdates);

    const allDone = await (async () => {
      for (const entry of eligible) {
        const tid = await tokenKey(entry.token);
        const d = deliveryUpdates[`pushQueue/${safeJobId}/deliveries/${tid}`] || priorDeliveries[tid];
        if (!(d?.status === 'sent' || d?.status === 'permanent' || d?.status === 'permanent_payload')) return false;
      }
      return true;
    })();

    const deliveryValues = Object.values(deliveryUpdates);
    const hasPayloadFailure = deliveryValues.some(d => d?.status === 'permanent_payload');
    const hasInvalidTokenOnly = deliveryValues.length > 0 &&
      deliveryValues.every(d => d?.status === 'permanent');


    if (allDone && sent > 0 && !hasPayloadFailure) {
      await rtdbPatch(env, {
        [`pushQueue/${safeJobId}/status`]: 'sent',
        [`pushQueue/${safeJobId}/sentAt`]: nowMs(),
        [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
        [`pushQueue/${safeJobId}/leaseUntil`]: null,
        [`pushQueue/${safeJobId}/lastError`]: null
      });
      return { status:'sent', jobId, sent, permanent, retryable };
    }

    if (allDone && hasPayloadFailure) {
      await rtdbPatch(env, {
        [`pushQueue/${safeJobId}/status`]: 'dead',
        [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
        [`pushQueue/${safeJobId}/leaseUntil`]: null,
        [`pushQueue/${safeJobId}/lastError`]: 'permanent_fcm_payload_error'
      });
      return { status:'dead', jobId, sent, permanent, retryable };
    }
    if (allDone && sent === 0 && hasInvalidTokenOnly) {
      await rtdbPatch(env, {
        [`pushQueue/${safeJobId}/status`]: 'skipped',
        [`pushQueue/${safeJobId}/reason`]: 'all_tokens_unregistered',
        [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
        [`pushQueue/${safeJobId}/leaseUntil`]: null
      });
      return { status:'skipped', jobId, sent, permanent, retryable };
    }

    if (Number(claimed.attempts || 0) >= MAX_QUEUE_ATTEMPTS) {
      await rtdbPatch(env, {
        [`pushQueue/${safeJobId}/status`]: 'dead',
        [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
        [`pushQueue/${safeJobId}/leaseUntil`]: null,
        [`pushQueue/${safeJobId}/lastError`]: 'max_attempts_exceeded'
      });
      return { status:'dead', jobId, sent, permanent, retryable };
    }

    await rtdbPatch(env, {
      [`pushQueue/${safeJobId}/status`]: 'retry',
      [`pushQueue/${safeJobId}/retryAt`]: nowMs() + retryDelayMs(Number(claimed.attempts || 1)),
      [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
      [`pushQueue/${safeJobId}/leaseUntil`]: null,
      [`pushQueue/${safeJobId}/lastError`]: retryable ? 'transient_fcm_failure' : 'permanent_token_failures'
    });
    return { status:'retry', jobId, sent, permanent, retryable };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    console.error(JSON.stringify({ tag:'kapani.push.error', jobId, notificationId, nick, attempt:Number(claimed.attempts||0), error:message, timestamp:nowMs(), startedAt }));
    const attempt = Number(claimed.attempts || 1);
    const terminal = attempt >= MAX_QUEUE_ATTEMPTS;
    await rtdbPatch(env, {
      [`pushQueue/${safeJobId}/status`]: terminal ? 'dead' : 'retry',
      [`pushQueue/${safeJobId}/retryAt`]: terminal ? null : (nowMs() + retryDelayMs(attempt)),
      [`pushQueue/${safeJobId}/updatedAt`]: nowMs(),
      [`pushQueue/${safeJobId}/leaseUntil`]: null,
      [`pushQueue/${safeJobId}/lastError`]: message
    }).catch(patchError => console.error(JSON.stringify({ tag:'kapani.push.queue_update_error', jobId, error:String(patchError?.message||patchError), timestamp:nowMs() })));
    return { status: terminal ? 'dead' : 'retry', jobId, error:message };
  }
}

async function listQueueJobsByStatus(env, status, limit = 40) {
  const base = String(env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
  const params = new URLSearchParams({ orderBy:'"status"', equalTo:`"${status}"`, limitToFirst:String(limit) });
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(`${base}/pushQueue.json?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`RTDB queue query ${status}: ${response.status} ${text}`);
  const data = text ? JSON.parse(text) : null;
  return data && typeof data === 'object' ? Object.values(data) : [];
}

async function processQueue(env) {
  const candidates = [];
  for (const status of ['pending','retry','waiting_token','processing']) {
    try { candidates.push(...await listQueueJobsByStatus(env, status, 50)); } catch (e) { console.error('[Kapani queue scan]', e); }
  }
  candidates.sort((a,b) => Number(a?.updatedAt||0) - Number(b?.updatedAt||0));
  const unique = [];
  const seen = new Set();
  for (const job of candidates) { const id=String(job?.jobId||''); if(id && !seen.has(id)){seen.add(id);unique.push(job);} }
  const out = [];
  for (const job of unique.slice(0, 40)) {
    const claimed = await claimQueueJob(env, String(job.jobId||''));
    if (claimed) out.push(await processQueueJob(env, claimed));
  }
  return out;
}

async function handleEnqueue(request, env) {
  let input; try { input = await request.json(); } catch (_) { return jsonResponse({ok:false,error:'Invalid JSON'},400); }
  const { uid } = await authenticatePushRequest(request, env);
  const nick = String(input?.nick || '').trim();
  const notificationId = String(input?.notificationId || '').trim();
  if (!nick || !notificationId) return jsonResponse({ok:false,error:'nick and notificationId are required'},400);
  if (uid !== nick) return jsonResponse({ok:false,error:'Authenticated user does not match notification target'},403);
  return jsonResponse(await enqueueNotificationJob(env, nick, notificationId, uid), 200);
}

async function handlePreferences(request, env) {
  let input; try { input = await request.json(); } catch (_) { return jsonResponse({ok:false,error:'Invalid JSON'},400); }
  const { uid } = await authenticatePushRequest(request, env);
  const prefs = extractPrefs(input?.prefs);
  const tokenId = String(input?.tokenId || '').trim();
  const updates = { [`users/${encodeURIComponent(uid)}/pushPrefs`]: {...prefs, updatedAt:nowMs()} };
  if (tokenId) {
    const stored = await rtdbGet(env, `users/${encodeURIComponent(uid)}/fcmTokens/${encodeURIComponent(tokenId)}`);
    if (stored) updates[`users/${encodeURIComponent(uid)}/fcmTokens/${encodeURIComponent(tokenId)}/pushPrefs`] = prefs;
  }
  await rtdbPatch(env, updates);
  return jsonResponse({ok:true,success:true,prefs},200);
}


function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = new Set([
    'https://iamskoup1.github.io',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5500'
  ]);
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
  if (!origin || allowed.has(origin)) headers['access-control-allow-origin'] = origin || 'https://iamskoup1.github.io';
  return headers;
}

function jsonResponse(
  data,
  status = 200,
  request = null
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'content-type':
          'application/json; charset=utf-8',
        ...corsHeaders(request)
      }
    }
  );
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = new Set([
        'https://iamskoup1.github.io',
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5500'
      ]);
      if (origin && !allowedOrigins.has(origin)) {
        return new Response(null, { status: 403, headers: { vary:'Origin' } });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const serviceAccountConfigured = !!String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
        const projectConfigured = !!String(env.FIREBASE_PROJECT_ID || '').trim();
        const databaseConfigured = !!String(env.FIREBASE_DATABASE_URL || '').trim();
        const ready = serviceAccountConfigured && projectConfigured && databaseConfigured;
        return jsonResponse({
          ok: ready,
          service: 'kapani-free-push-bridge',
          mode: 'cloudflare-queue-fcm-v1',
          configured: {
            serviceAccount: serviceAccountConfigured,
            projectId: projectConfigured,
            databaseUrl: databaseConfigured,
            cron: true
          },
          timestamp: nowMs()
        }, ready ? 200 : 503, request);
      }
      if (request.method !== 'POST') return jsonResponse({ok:false,error:'Method not allowed'},405,request);
      if (url.pathname === '/session') return await handleSession(request, env);
      if (url.pathname === '/register') return await handleRegister(request, env);
      if (url.pathname === '/unregister') return await handleUnregister(request, env);
      if (url.pathname === '/diagnostics') return await handleDiagnostics(request, env);
      if (url.pathname === '/preferences') return await handlePreferences(request, env);
      if (url.pathname === '/enqueue' || url.pathname === '/push' || url.pathname === '/send') return await handleEnqueue(request, env);
      return jsonResponse({ok:false,error:'Not found'},404,request);
    } catch (error) {
      console.error(JSON.stringify({tag:'kapani.worker.error',path:url.pathname,error:String(error?.message||error),timestamp:nowMs()}));
      return jsonResponse({ok:false,error:String(error?.message||error)},500,request);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueue(env).catch(error => {
      console.error(JSON.stringify({tag:'kapani.scheduler.error',error:String(error?.message||error),timestamp:nowMs()}));
    }));
  }
};
