/* Kapani main entry. Runs once after the HTML has been parsed. */
(async function(){
'use strict';

    const CONFIG = globalThis.KAPANI_CONFIG;
    if (!CONFIG) throw new Error("Kapani config.js не загружен");
    function getSubscriptionPrice(type){
        const item = globalThis.KAPANI_SUBSCRIPTIONS?.[type];
        return Number(item?.price ?? CONFIG.subscriptions?.[type]?.price ?? 0);
    }
    function getSubscriptionRank(subscription, expiry){
        const active = subscription && subscription !== 'none' && expiry && new Date(expiry) > new Date();
        if(!active) return 0;
        return Number(globalThis.KAPANI_SUBSCRIPTIONS?.[subscription]?.rank || 0);
    }
    window.openBizOwnerPanel = function(bizId){
    currentBizId = bizId;
    try { sessionStorage.setItem('kapani:lastBizId', bizId); } catch(e) {}
    navTo('bizOwnerPanel');
};
const { supabase, db, ref, set, get, update, push, remove, onValue, off,
    serverTimestamp, runTransaction, query, orderByChild, equalTo, limitToLast,
    onDisconnect, authEmail, patchOwnProfile, manageOwnNotifications,
    claimVerifiedTask, withdrawVerifiedTasks } = window.KAPANI_BRIDGE || {};
if (!supabase) throw new Error('Защищённый клиент Supabase не загружен');

// Messaging / Functions / Storage are initialized only when their functionality is actually used.
let functions = null;
let storage = null;
let authInstance = null;
let authModule = null;
let authInitPromise = null;
let kapaniSessionEstablishPromise = null;
let kapaniSessionEstablishNick = null;
let kapaniSessionRetryTimer = null;
let kapaniLegacyLoginEmail = '';
let kapaniVerifiedIdentity = null;

async function ensureAuth(){
    if(!authInstance) authInstance = {currentUser:null};
    authModule = { signOut: () => supabase.auth.signOut() };
    const {data,error}=await supabase.auth.getUser();
    if(error && !/session missing/i.test(String(error.message))) console.debug('[Kapani auth]',error.message);
    const signedUser=data?.user;
    if(!signedUser){
        kapaniVerifiedIdentity=null;
        authInstance.currentUser=null;
        return authInstance;
    }
    // Local storage and user-editable metadata are not proof of ownership.
    // Resolve the nickname exclusively by the signed-in user's database UUID.
    let verifiedNick=kapaniVerifiedIdentity?.id===signedUser.id ? kapaniVerifiedIdentity.nick : null;
    if(!verifiedNick){
        const {data:owner,error:profileError}=await supabase.from('kp_profiles')
            .select('nickname').eq('user_id',signedUser.id).maybeSingle();
        if(profileError) console.debug('[Kapani auth] profile identity:',profileError.message);
        verifiedNick=owner?.nickname||null;
        if(verifiedNick) kapaniVerifiedIdentity={id:signedUser.id,nick:verifiedNick};
    }
    authInstance.currentUser=verifiedNick ? {uid:verifiedNick,id:signedUser.id,email:signedUser.email} : null;
    return authInstance;
}
async function ensureFunctions(){
    throw new Error('Cloud Functions больше не используются');
}
// Firebase Auth persistence is asynchronous. Kapani keeps the public nickname/password
// flow separate from Firebase Auth, so these helpers bridge that UI to the protected
// callable and Realtime Database layers.
async function waitForFirebaseAuthUser(timeoutMs=15000){
    return (await ensureAuth()).currentUser;
}

function isRetryableKapaniAuthError(error){
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return (
        code === 'auth/network-request-failed' ||
        code === 'auth/internal-error' ||
        code === 'auth/timeout' ||
        code === 'functions/unavailable' ||
        code === 'functions/deadline-exceeded' ||
        code === 'functions/internal' ||
        code === 'functions/aborted' ||
        /network|failed to fetch|fetch failed|timeout|timed out|temporar|unavailable|offline|connection/i.test(message)
    );
}

async function withKapaniAuthRetry(operation, label, maxAttempts=3){
    let lastError = null;
    const delays = [350, 1000];
    for(let attempt=1; attempt<=maxAttempts; attempt++){
        try{
            return await operation();
        }catch(e){
            lastError = e;
            if(attempt >= maxAttempts || !isRetryableKapaniAuthError(e)) throw e;
            const delay = delays[Math.min(attempt-1, delays.length-1)];
            console.warn(`[Kapani auth] ${label}: временная ошибка, повтор ${attempt+1}/${maxAttempts} через ${delay}мс`, e?.message || e);
            await new Promise(resolve=>setTimeout(resolve, delay));
        }
    }
    throw lastError || new Error('Не удалось выполнить защищённую Firebase-операцию');
}

async function establishKapaniServerSession(nick, password, legacyEmail=''){
    const expectedNick = String(nick || '').trim();
    const secret = String(password || '');
    if(!expectedNick || !secret) throw new Error('Для входа нужны имя и пароль');
    const auth = await ensureAuth();
    if(auth.currentUser?.uid === expectedNick){
        const ensured=await supabase.rpc('kp_ensure_my_profile');
        if(ensured.error) throw new Error('Не удалось восстановить данные аккаунта: '+ensured.error.message);
        if(auth.currentUser.email?.toLowerCase()!==String(await authEmail(expectedNick)).toLowerCase())
            kapaniLegacyLoginEmail=String(auth.currentUser.email||'').toLowerCase();
        return auth.currentUser;
    }
    if(kapaniSessionEstablishPromise && kapaniSessionEstablishNick===expectedNick) return kapaniSessionEstablishPromise;
    kapaniSessionEstablishNick=expectedNick;
    kapaniSessionEstablishPromise=(async()=>{
        const normalizedEmail=String(legacyEmail||'').trim().toLowerCase();
        if(normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
            throw new Error('Укажи корректную почту старого аккаунта');
        const {data,error}=await supabase.auth.signInWithPassword({
            email:normalizedEmail||await authEmail(expectedNick), password:secret
        });
        if(error || !data?.session) throw new Error(normalizedEmail
            ? 'Не удалось войти по старой почте и паролю: '+(error?.message||'нет сессии')
            : 'Не удалось войти. Если аккаунт старый, впиши прежнюю почту: '+(error?.message||'нет сессии'));
        const serverProfile=await supabase.from('kp_profiles').select('nickname').eq('user_id',data.user.id).maybeSingle();
        if(serverProfile.error || serverProfile.data?.nickname!==expectedNick){
            await supabase.auth.signOut();
            throw new Error('Имя в защищённом профиле не совпадает');
        }
        // Some migrated accounts have Auth + kp_profiles + wallet, but no JSON
        // profile yet. The SECURITY DEFINER RPC can only create the caller's own.
        const ensured=await supabase.rpc('kp_ensure_my_profile');
        if(ensured.error) throw new Error('Не удалось восстановить данные аккаунта: '+ensured.error.message);
        kapaniLegacyLoginEmail=normalizedEmail || (data.user.email?.toLowerCase()!==String(await authEmail(expectedNick)).toLowerCase()
            ? String(data.user.email||'').toLowerCase() : '');
        auth.currentUser={uid:expectedNick,id:data.user.id,email:data.user.email};
        return auth.currentUser;
    })();
    try{return await kapaniSessionEstablishPromise;}
    finally{kapaniSessionEstablishPromise=null;kapaniSessionEstablishNick=null;}
}

async function ensureKapaniServerSessionForCurrentUser(timeoutMs=5000){
    return await requireKapaniServerSession(timeoutMs);
}

function scheduleKapaniServerSessionRetry(nick, maxAttempts=3){
    const expectedNick = String(nick || '').trim();
    if(!expectedNick || !currentNick || currentNick !== expectedNick) return;

    if(kapaniSessionRetryTimer) clearTimeout(kapaniSessionRetryTimer);
    let attempt = 0;
    const delays = [1500, 4000];

    const retry = async()=>{
        if(!currentNick || currentNick !== expectedNick) return;
        attempt++;
        try{
            await requireKapaniServerSession(6000);
            console.info('[Kapani auth] защищённая сессия восстановлена после повторной попытки');
            return;
        }catch(e){
            console.warn(`[Kapani auth] фоновое восстановление ${attempt}/${maxAttempts}:`, e?.message || e);
        }
        if(attempt < maxAttempts && currentNick === expectedNick){
            kapaniSessionRetryTimer = setTimeout(retry, delays[Math.min(attempt-1, delays.length-1)]);
        }else{
            kapaniSessionRetryTimer = null;
        }
    };
    kapaniSessionRetryTimer = setTimeout(retry, delays[0]);
}

async function ensureStorage(){
    return supabase.storage;
}

const app = supabase;

const ADMIN = 'Кайон';
// ─── Deterministic bootstrap signal for additive modules (Kapani Pack v2 etc.) ───
// Replaces the old setInterval/setTimeout polling handoff: other <script type="module">
// blocks just `await window.kapaniReady()` instead of polling window.db every 250ms.
let _resolveKapaniReady;
window.KAPANI_READY = new Promise(res => { _resolveKapaniReady = res; });
window.kapaniReady = function(){ return window.KAPANI_READY; };
const JOB_JANITOR = CONFIG.jobs.janitor;
const JOB_JOURNALIST = "Журналист";
const JOB_ADVERTISER = "Рекламщик";
const ADVERTISER_KVE_REQUIRED = 50;
const ADVERTISER_WEEKLY_BASE_SALARY = 3900;
const ADVERTISER_WEEKLY_MIN_REFERRALS = 4;
const ADVERTISER_EXTRA_REFERRAL_BONUS = 500;
const JANITOR_TASK_TEXT = CONFIG.jobs.janitorTaskText;
const MIN_BALANCE_ALLOWED = CONFIG.finance.minBalanceAllowed;
const DEFAULT_AVATAR_URL = CONFIG.ui.defaultAvatarUrl;
const REWARD_CUSTOM_AVATAR = CONFIG.rewards.customAvatar;
const REWARD_FIRST_WALL = CONFIG.rewards.firstWall;
const WEB_PUSH_VAPID_PUBLIC_KEY = CONFIG.webPushVapidPublicKey;
// Canonical push backend: direct Web Push through the Cloudflare Worker in push-worker/.
// Firebase Functions are not part of the push delivery path.
const PUSH_WORKER_URL = String(CONFIG.pushWorkerUrl || '').trim().replace(/\/+$/,'');
const KAPANI_BUILD = '2026-09-30-noblaze-worker'; window.KAPANI_BUILD = KAPANI_BUILD;   // shown in the push status line: proves which version a device is running
const ECONOMY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ECONOMY_ACCOUNT_WEEKLY_FEE = 15;
const ECONOMY_TRANSFER_COMMISSION = 0.02;
const ECONOMY_MARKET_COMMISSION = 0.02;
const ECONOMY_BUSINESS_CREATION_FEE = 2500;
const ECONOMY_MARKET_PIN_PRICE = 160;
const ECONOMY_MARKET_PIN_DURATION_MS = ECONOMY_WEEK_MS;
const ECONOMY_BUSINESS_PROMOTE_PRICE = 600;
const ECONOMY_BUSINESS_PROMOTE_DURATION_MS = ECONOMY_WEEK_MS;
const ECONOMY_BUSINESS_WEEKLY_FEE = 500;
const ECONOMY_SAVINGS_RATE_TIERS = [
    { max: 999.99, rate: 0.07, label: '7%' },
    { max: 10000, rate: 0.10, label: '10%' },
    { max: 100000, rate: 0.17, label: '17%' },
    { max: Infinity, rate: 0.25, label: '25%' }
];
function getSavingsDailyRate(balance){
    return 0.005; // 0.5% в день
}
function getSavingsRateLabel(balance){
    return '0.5%';
}
function getWealthTaxRate(taxBase){
    const amount = Math.max(0, Number(taxBase) || 0);
    if(amount < 1000) return 0.07;
    if(amount <= 10000) return 0.10;
    if(amount <= 100000) return 0.17;
    return 0.25;
}
const ECONOMY_DAY_MS = 24 * 60 * 60 * 1000;
const BIZ_BASE_LIMITS = { employees: 3, products: 3, maxProductPrice: 1000 };
const BIZ_UPGRADE_PRICES = { employee: 350, product: 250, priceCap: 400 };
const BIZ_BG_EFFECTS = [
    { id: 'shimmer', name: '✨ Мерцание', price: 199, cls: 'profile-bg-shimmer' },
    { id: 'particles', name: '🌟 Частицы', price: 249, cls: 'profile-bg-particles' },
    { id: 'aurora', name: '🌌 Аврора', price: 399, cls: 'profile-bg-aurora' },
    { id: 'fire', name: '🔥 Пламя', price: 449, cls: 'profile-bg-fire' },
    { id: 'plasma', name: '💜 Плазма', price: 499, cls: 'profile-bg-plasma' },
    { id: 'galaxy', name: '🌠 Галактика', price: 549, cls: 'profile-bg-galaxy' },
    { id: 'thunder', name: '⚡ Гром', price: 699, cls: 'profile-bg-thunder' },
    { id: 'hologram', name: '🪩 Голограмма', price: 749, cls: 'profile-bg-hologram' },
    { id: 'dragon', name: '🐉 Дракон', price: 849, cls: 'profile-bg-dragon' },
    { id: 'prime', name: '👑 Прайм', price: 899, cls: 'profile-bg-prime' }
];
const AVATAR_FRAME_CLASSES = Object.freeze({
    gold:'avatar-frame-gold', rainbow:'avatar-frame-rainbow', pulse:'avatar-frame-pulse',
    glow:'avatar-frame-glow', neon:'avatar-frame-neon', fire:'avatar-frame-fire',
    crystal:'avatar-frame-crystal', ice:'avatar-frame-ice', rose:'avatar-frame-rose',
    plasma:'avatar-frame-plasma', thunder:'avatar-frame-thunder', hologram:'avatar-frame-hologram',
    dragon:'avatar-frame-dragon', prime:'avatar-frame-prime',
    forest_moss:'avatar-frame-forest-moss', forest_dusk:'avatar-frame-forest-dusk',
    nature_meadow:'avatar-frame-nature-meadow', nature_aurora:'avatar-frame-nature-aurora',
    wild_ember:'avatar-frame-wild-ember', wild_storm:'avatar-frame-wild-storm'
});
const PROFILE_BG_CLASSES = Object.freeze({
    shimmer:'profile-bg-shimmer', particles:'profile-bg-particles',
    gradient:'profile-bg-gradient-animated', ocean:'profile-bg-ocean', sunset:'profile-bg-sunset',
    aurora:'profile-bg-aurora', galaxy:'profile-bg-galaxy', fire:'profile-bg-fire',
    plasma:'profile-bg-plasma', thunder:'profile-bg-thunder', hologram:'profile-bg-hologram',
    dragon:'profile-bg-dragon', prime:'profile-bg-prime', custom:'profile-bg-custom',
    forest_moss:'profile-bg-forest-moss', forest_dusk:'profile-bg-forest-dusk',
    nature_meadow:'profile-bg-nature-meadow', nature_aurora:'profile-bg-nature-aurora',
    wild_ember:'profile-bg-wild-ember', wild_storm:'profile-bg-wild-storm'
});
const PROFILE_EFFECT_CLASSES = Object.freeze([...Object.values(PROFILE_BG_CLASSES)]);
const CHAT_BUBBLE_CLASSES = Object.freeze({
    gold:'chat-bubble-gold', rainbow:'chat-bubble-rainbow', ocean:'chat-bubble-ocean',
    sunset:'chat-bubble-sunset', aurora:'chat-bubble-aurora', galaxy:'chat-bubble-galaxy',
    fire:'chat-bubble-fire', neon:'chat-bubble-neon', rose:'chat-bubble-rose',
    plasma:'chat-bubble-plasma', thunder:'chat-bubble-thunder',
    hologram:'chat-bubble-hologram', dragon:'chat-bubble-dragon', prime:'chat-bubble-prime',
    forest_moss:'chat-bubble-forest-moss', forest_dusk:'chat-bubble-forest-dusk',
    nature_meadow:'chat-bubble-nature-meadow', nature_aurora:'chat-bubble-nature-aurora',
    wild_ember:'chat-bubble-wild-ember', wild_storm:'chat-bubble-wild-storm'
});
function hasActiveSubscription(u){
    const expiry = u?.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    return !!(expiry && expiry > new Date());
}
function getAvatarFrameClass(user){
    if(!hasActiveSubscription(user)) return '';
    return AVATAR_FRAME_CLASSES[user?.avatarFrame] || '';
}
function getProfileBgClass(user){
    if(!hasActiveSubscription(user)) return '';
    if(user?.profileBgEffect === 'custom' && user?.subscription !== 'prime') return '';
    return PROFILE_BG_CLASSES[user?.profileBgEffect] || '';
}
function validPrimeCoverData(value){
    return typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length <= 240000;
}
function applyPrimeCoverToElement(el, effect, image){
    if(!el) return;
    el.style.removeProperty('--kp-profile-skin');
    if(effect === 'custom' && validPrimeCoverData(image)){
        el.style.setProperty('--kp-profile-skin', `linear-gradient(120deg,rgba(5,23,16,.48),rgba(10,35,27,.22)),url("${image}") center/cover`);
    }
}
const PRICE_PER_KM = CONFIG.finance.pricePerKm;
const MAX_SPEED_KMH = CONFIG.finance.maxSpeedKmh;
const KAPANI_LAT = CONFIG.location.kapani.lat;
const KAPANI_LNG = CONFIG.location.kapani.lng;
const BUSINESS_DEFAULT_LAT = 52.628433;
const BUSINESS_DEFAULT_LNG = 38.417049;
const ONLINE_TIMEOUT_MS = 3 * 60 * 1000;

let currentNick = localStorage.getItem('kp_s') || sessionStorage.getItem('kp_s') || null;
let _kapaniSessionPassword = null;
function syncCurrentNick(){ window.currentNick = currentNick; return currentNick; }
syncCurrentNick();
let appStarted = false;
let rememberedAuth = null;
try { rememberedAuth = JSON.parse(localStorage.getItem('kp_auth') || 'null'); } catch(e) { rememberedAuth = null; }
let curPage = 'home';
let listeners = {};
let onlineHeartbeatInterval = null;
let allUsersCache = {};
let allUsersCacheLoaded = false;
let allUsersCachePromise = null;
let lastChatMsgs = {};
let lastDmMsgs = {};
let pendingPhotoQueues = { chat: [], dm: [] };
let vcFacingMode = 'user';
let chatLoading = false;
let dmLoading = false;

const ROLE_MIGRANT = 'Мигрант';
function isMigrantUser(u){ return !!(u && u.roles && u.roles.migrant === true); }
async function requireNotMigrant(actionText){
    try{
        const snap = await get(userRef(currentNick));
        const u = snap.exists() ? (snap.val()||{}) : {};
        if(isMigrantUser(u)){
            toast(`🚫 ${ROLE_MIGRANT}: ${actionText}`,'red');
            return false;
        }
    }catch(e){}
    return true;
}
function loadingHtml(text='Загрузка...'){
    const t = escHtml(text);
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 0;color:var(--muted);font-size:13px;">
        <div class="spinner" style="width:24px;height:24px;border-width:2px;margin-bottom:10px;"></div>
        <div>${t}</div>
    </div>`;
}
function safeExtFromMime(mime, fallback){
    if(!mime) return fallback || 'bin';
    const map = { 'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3','video/webm':'webm','video/mp4':'mp4','video/quicktime':'mov','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
    return map[String(mime).split(';')[0]] || (fallback || 'bin');
}
let kapaniActiveMediaUpload = null;
function mediaProgressUI(label, progress=0){
    let panel=document.getElementById('kpMediaProgress');
    if(!panel){
        panel=document.createElement('div');panel.id='kpMediaProgress';
        panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');
        panel.style.cssText='position:fixed;bottom:85px;left:50%;transform:translateX(-50%);z-index:11000;max-width:410px;width:calc(100% - 32px);padding:14px 16px;border:1px solid var(--border);border-radius:17px;background:var(--surface,#10291f);box-shadow:0 14px 38px #0007;color:var(--text)';
        panel.innerHTML='<div id="kpMediaLabel" style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div><div style="display:flex;align-items:center;gap:10px;margin-top:10px"><progress id="kpMediaBar" max="100" value="0" style="width:100%;height:10px;accent-color:var(--primary)"></progress><span id="kpMediaPercent" style="font-size:12px;min-width:38px;text-align:right"></span><button id="kpMediaCancel" type="button" style="border:0;color:var(--text);background:transparent;cursor:pointer;font-size:16px" aria-label="Отменить загрузку">×</button></div>';
        document.body.appendChild(panel);
        panel.querySelector('#kpMediaCancel').onclick=()=>kapaniActiveMediaUpload?.abort?.();
    }
    panel.querySelector('#kpMediaLabel').textContent=label;
    panel.querySelector('#kpMediaBar').value=Math.max(0,Math.min(100,progress));
    panel.querySelector('#kpMediaPercent').textContent=`${Math.round(progress)}%`;
}
function hideMediaProgress(){document.getElementById('kpMediaProgress')?.remove();}
async function uploadBlobToStorage(blobOrFile,folder){
    if(!(blobOrFile instanceof Blob) || !blobOrFile.size) throw new Error('Файл пуст');
    // Free Supabase projects cap each object at 50MB. Keep a safety margin.
    if(blobOrFile.size>49*1024*1024) throw new Error('Видео превышает лимит Supabase Free (49 МБ)');
    const {data:{session},error:sessionError}=await supabase.auth.getSession();
    if(sessionError||!session?.access_token) throw new Error('Войдите заново, чтобы отправить файл');
    const uid=session.user.id;
    const mime=String(blobOrFile.type||'application/octet-stream').split(';')[0];
    const ext=safeExtFromMime(mime,'bin');
    const objectPath=`${uid}/${folder}/${Date.now()}_${crypto.randomUUID()}.${ext}`;
    const {Upload}=await import('https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/+esm');
    const projectId=new URL(CONFIG.supabase.url).hostname.split('.')[0];
    const label=blobOrFile.name||folder.split('/').at(-1)||'Медиа';
    mediaProgressUI(`Загрузка ${label}`,0);
    try{
        await new Promise((resolve,reject)=>{
            const transfer=new Upload(blobOrFile,{
                endpoint:`https://${projectId}.storage.supabase.co/storage/v1/upload/resumable`,
                retryDelays:[0,1000,3000,5000,10000],
                headers:{authorization:`Bearer ${session.access_token}`},
                uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,
                chunkSize:6*1024*1024,
                metadata:{bucketName:'kapani-media',objectName:objectPath,contentType:mime,cacheControl:'3600'},
                onError:reject,
                onProgress:(sent,total)=>mediaProgressUI(`Загрузка ${label}`,Math.round(sent/Math.max(total,1)*100)),
                onSuccess:resolve
            });
            kapaniActiveMediaUpload=transfer;
            transfer.findPreviousUploads().then(previous=>{
                if(previous.length) transfer.resumeFromPreviousUpload(previous[0]);
                transfer.start();
            }).catch(reject);
        });
        const {data}=supabase.storage.from('kapani-media').getPublicUrl(objectPath);
        if(!data?.publicUrl) throw new Error('Не удалось получить адрес загруженного файла');
        return data.publicUrl;
    }finally{
        kapaniActiveMediaUpload=null;
        hideMediaProgress();
    }
}

// ─── INTERVAL REGISTRY ─────────────────────
const activeIntervals = new Map();

function registerInterval(name, intervalId) {
    activeIntervals.set(name, intervalId);
    return intervalId;
}

function clearIntervalByName(name) {
    const intervalId = activeIntervals.get(name);
    if (intervalId) {
        clearInterval(intervalId);
        activeIntervals.delete(name);
    }
}

function stopAllActivity() {
    activeIntervals.forEach((intervalId, name) => {
        clearInterval(intervalId);
    });
    activeIntervals.clear();
}

let taxiMap = null, fromMarker = null, toMarker = null, routeLine = null;
let selectingPoint = null;
let fromCoords = null, toCoords = null;
let shopMapObj = null, shopMarker = null, shopAddrCoords = null;
let currentDmNick = null;
let dmListeners = {};
let viewingProfileNick = null;
let dmPeerReadTs = 0;
let lastMarketListings = {};
let dmConvoMeta = {};
let myPinnedChats = {};
let dmTypingUnsub = null;
let chatTypingUnsub = null;
let dmTypingResetTimer = null;
let chatTypingResetTimer = null;
let _imgZoomScale = 1;
let wallMediaPending = null;
let renderChat;
let renderDmMessages;
let chatReadStates = {};

// currentDmNick is accessed directly — no defineProperty needed (it caused call stack overflow)
window._getDmNick = () => currentDmNick;
window.openCurrentDmProfile = function(){
    const nick = currentDmNick || window._getDmNick?.();
    if(!nick) return toast('⚠️ Профиль чата ещё не загрузился','gold');
    return window.openUserProfile(nick);
};

// ─── GLOBAL ERROR HANDLER ───────────────────
window.addEventListener('error', (event) => {
    console.error('Глобальная ошибка:', event.error);
    // Можно добавить логирование в аналитическую систему
});

let lastProtectedMutationWarning=0;
window.addEventListener('unhandledrejection', (event) => {
    console.error('Необработанный Promise rejection:', event.reason);
    const message=String(event.reason?.message||event.reason||'');
    if(/Protected operation|Protected account field|whole user record|Cannot modify another user|Notifications are server-managed|Replacing an entire user/i.test(message)){
        if(Date.now()-lastProtectedMutationWarning>5000){
            lastProtectedMutationWarning=Date.now();
            toast('Эта операция ещё не перенесена на защищённый сервер. Деньги и права не изменены.','red');
        }
        event.preventDefault();
    }
});

// ─── HELPERS ──────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function qs(id) { return document.getElementById(id); }
function nowTime() { return new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}); }
function fullDateTimeStr(){ const d=new Date(); return { date:d.toLocaleDateString('ru'), time:nowTime(), ts:d.toISOString() }; }
function dmKey(a,b) { return [a,b].sort().join('__dm__'); }
function typingChatRef(nick){ return ref(db, `typing/chat/${nick}`); }
function typingDmRef(key, nick){ return ref(db, `typing/dm/${key}/${nick}`); }
function safeAvatar(userOrNick, fallback='https://cdn-icons-png.flaticon.com/512/149/149071.png') {
    if(!userOrNick) return fallback;
    if(typeof userOrNick === 'string') return (allUsersCache[userOrNick]?.avatar) || fallback;
    return userOrNick.avatar || fallback;
}
function requestPersistentStorage(){
    try { if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{}); } catch(e) {}
}
function haversine(lat1,lon1,lat2,lon2) {
    const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
    const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function isUserOnline(user) { if(!user||!user.lastSeen) return false; return (Date.now()-user.lastSeen)<ONLINE_TIMEOUT_MS; }
function formatLastSeen(user){
    if(!user || !user.lastSeen) return 'был(а) давно';
    const diff = Date.now() - Number(user.lastSeen || 0);
    if(diff < ONLINE_TIMEOUT_MS) return 'В сети';
    const m = Math.floor(diff / 60000);
    if(m < 60) return `${m || 1} мин. назад`;
    const h = Math.floor(m / 60);
    if(h < 24) return `${h} ч. назад`;
    const d = Math.floor(h / 24);
    if(d < 7) return `${d} ${d===1?'день':(d>=2&&d<=4?'дня':'дней')} назад`;
    if(d < 30) return `${Math.floor(d/7)} нед. назад`;
    return `был(а) ${new Date(Number(user.lastSeen)).toLocaleDateString('ru')}`;
}
function updateDmLiveStatus(peerUser, typingData){
    const el = qs('dmChatJob');
    if(!el || !peerUser) return;
    const base = getUserBusinessRoleLabel(peerUser, peerUser.nick || '');
    const online = isUserOnline(peerUser);
    const ageOk = typingData && (Date.now() - Number(typingData.ts || 0) < 7000);
    let live = online ? 'в сети' : formatLastSeen(peerUser);
    if(ageOk){
        if(typingData.state === 'typing') live = 'Печатает...';
        else if(typingData.state === 'voice') live = 'Записывает голосовое...';
        else if(typingData.state === 'video') live = 'Записывает видеосообщение...';
    }
    el.textContent = `${base} · ${live}`;
    el.style.color = ageOk ? 'var(--primary)' : 'var(--muted)';
}
function updateChatLiveStatus(usersTyping){
    const el = qs('chatLiveStatus');
    if(!el) return;
    const now = Date.now();
    const rows = Object.entries(usersTyping || {})
        .filter(([nick]) => nick !== currentNick)
        .map(([nick, v]) => ({nick, state: v?.state || 'typing', ts: Number(v?.ts || 0)}))
        .filter(x => x.ts && now - x.ts < 7000);
    if(!rows.length){
        el.textContent = '';
        el.style.display = 'none';
        return;
    }
    const line = rows.slice(0,2).map(x => {
        const dn = displayNick(allUsersCache[x.nick]) || x.nick;
        if(x.state === 'voice') return `${dn} записывает голосовое...`;
        if(x.state === 'video') return `${dn} записывает видеосообщение...`;
        return `${dn} печатает...`;
    }).join(' · ');
    el.textContent = line;
    el.style.display = 'block';
}
async function setChatTypingState(state){
    if(!currentNick) return;
    try { await set(typingChatRef(currentNick), { state, ts: Date.now() }); } catch(e){}
}
async function setDmTypingState(state){
    if(!currentNick || !currentDmNick) return;
    try { await set(typingDmRef(dmKey(currentNick, currentDmNick), currentNick), { state, ts: Date.now() }); } catch(e){}
}
function setNewsTypingState(state){ /* intentionally silent */ }
window.onChatInputTyping = function(){
    if(chatTypingResetTimer) clearTimeout(chatTypingResetTimer);
    setChatTypingState('typing');
    chatTypingResetTimer = setTimeout(()=>setChatTypingState('idle'), 1600);
};
window.onDmInputTyping = function(){
    if(dmTypingResetTimer) clearTimeout(dmTypingResetTimer);
    setDmTypingState('typing');
    dmTypingResetTimer = setTimeout(()=>setDmTypingState('idle'), 1600);
};

// ─── CLOUD FUNCTION FALLBACK HELPERS ────────
// These helpers try Cloud Functions first, then fall back to direct DB operations
async function callFunctionWithFallback(functionName, data, fallbackFn) {
    if(fallbackFn) return await fallbackFn(data);
    throw new Error(`Серверная операция ${functionName} ещё не перенесена на Supabase`);
}

// Single-flight lock: several callers (e.g. several pushNotification() calls
// fired in quick succession) can hit requireKapaniServerSession() at once
// while Firebase Auth is still restoring. Without a shared lock each caller
// starts its own waitForFirebaseAuthUser()/establishKapaniServerSession(),
// which races several signInWithCustomToken() calls against each other and
// produces the "Not found" session-healing errors. Instead, the first caller
// starts the healing process and every concurrent caller awaits the same
// promise and reuses its result.
let firebaseAuthRestorePromise = null;
let firebaseAuthRestoreNick = null;

async function requireKapaniServerSession(timeoutMs=15000){
    const nick = String(currentNick || '').trim();
    if(!nick) throw new Error('Пользователь не определён для защищённой Firebase-сессии');

    const auth = await ensureAuth();
    if(auth.currentUser?.uid === nick) return auth.currentUser;

    if(firebaseAuthRestorePromise && firebaseAuthRestoreNick === nick){
        return await firebaseAuthRestorePromise;
    }

    // A different nick can only appear after a logout/login race. Do not let the
    // old recovery promise be reused for a new account.
    if(firebaseAuthRestorePromise && firebaseAuthRestoreNick !== nick){
        try{ await firebaseAuthRestorePromise; }catch(_) {}
    }

    firebaseAuthRestoreNick = nick;
    firebaseAuthRestorePromise = (async()=>{
        // 1) Wait for Firebase's own persisted-auth initialization to settle.
        // Never interpret the pre-initialization null currentUser as final.
        const restored = await waitForFirebaseAuthUser(timeoutMs);
        if(restored?.uid === nick) return restored;

        // 2) If the user logged in during this page lifetime, heal via the existing
        // Cloudflare Worker /session -> signInWithCustomToken flow. The password remains
        // memory-only and is never persisted by this helper.
        if(_kapaniSessionPassword){
            try{
                const healed = await establishKapaniServerSession(nick, _kapaniSessionPassword, kapaniLegacyLoginEmail);
                if(healed?.uid === nick) return healed;
            }catch(e){
                console.warn('[Kapani auth] session healing:', e?.message || e);
            }
        }

        // 3) Give a just-finished Auth state transition / network initialization
        // one more short window before surfacing a genuine failure.
        const secondChance = await waitForFirebaseAuthUser(Math.min(Math.max(timeoutMs, 1500), 5000));
        if(secondChance?.uid === nick) return secondChance;

        throw new Error('Защищённая Firebase-сессия не готова. Повторите действие через несколько секунд.');
    })();

    try{
        return await firebaseAuthRestorePromise;
    }finally{
        firebaseAuthRestorePromise = null;
        firebaseAuthRestoreNick = null;
    }
}

// Fallback: Create order directly in database
async function fallbackCreateOrder(data) {
    const id = genId();
    const orderData = {
        id,
        type: data.type,
        client: currentNick,
        info: data.info,
        price: data.price,
        originalPrice: data.originalPrice || data.price,
        discountApplied: data.discountApplied || 0,
        address: data.address || '',
        status: data.type==='taxi' ? 'pending' : 'waiting',
        createdAt: Date.now(),
        clientLat: data.clientLat || null,
        clientLng: data.clientLng || null,
        destLat: data.destLat || null,
        destLng: data.destLng || null,
        distanceKm: data.distanceKm || 0
    };
    
    // Do NOT deduct balance immediately - only deduct on confirmation/payment
    await set(orderRef(id), orderData);
    
    return { success: true, orderId: id };
}

// Fallback: Take order directly
async function fallbackTakeOrder(data) {
    const snap = await get(orderRef(data.orderId));
    if(!snap.exists()) throw new Error('Заказ не найден');
    const o = snap.val();
    if(o.client === currentNick) throw new Error('Нельзя брать свой заказ');
    if(!['pending','waiting'].includes(String(o.status||''))) throw new Error('Заказ уже в работе');
    if(o.worker) throw new Error('Уже есть исполнитель');
    
    const workerSnap = await get(userRef(currentNick));
    const worker = workerSnap.val()||{};
    await update(orderRef(data.orderId), { worker: currentNick, status: o.type==='taxi'?'accepted':'in_progress', driverVehicle: worker.vehicle||'', driverAvatar: worker.avatar||'', acceptedAt: Date.now() });
    return { success: true };
}

// Fallback: Cancel order directly
async function fallbackCancelOrder(data) {
    const snap = await get(orderRef(data.orderId));
    if(!snap.exists()) throw new Error('Заказ не найден');
    const o = snap.val();
    
    if(o.client === currentNick) {
        // Client canceling: this architecture charges only at payment time, so
        // there is no amount to refund. Apply only the cancellation penalty.
        const penalty = 35;
        const userSnap = await get(userRef(currentNick));
        const before = userSnap.val() || {};
        const tx = await runTransaction(userRef(currentNick), current => {
            const u = current || before;
            const balance = Number(u.balance || 0);
            const actualPenalty = Math.min(penalty, Math.max(0, balance));
            return { ...u, balance: balance - actualPenalty };
        });
        if(!tx?.committed) throw new Error('Не удалось применить штраф');
        const after = tx.snapshot.val() || {};
        const actualPenalty = Math.max(0, Number(before.balance || 0) - Number(after.balance || 0));
        await remove(orderRef(data.orderId));
        if(actualPenalty > 0) await logTx(currentNick, { type: 'out', who: 'Система', amt: actualPenalty, desc: 'Штраф за отмену заказа' });
        return { success: true, refundAmount: 0, penalty: actualPenalty };
    } else if(o.worker === currentNick) {
        // Taxi orders are accepted before they become in_progress. Releasing
        // them must work in all three driver states, not just during a trip.
        const isAllowed = o.type === 'taxi'
            ? DRIVER_ACTIVE_ORDER_STATUSES.has(String(o.status || ''))
            : o.status === 'in_progress';
        if (!isAllowed) throw new Error('Отказ от заказа в этом состоянии недоступен');
        const released = await runTransaction(orderRef(data.orderId), current => {
            if (!current || current.worker !== currentNick) return;
            const valid = current.type === 'taxi'
                ? DRIVER_ACTIVE_ORDER_STATUSES.has(String(current.status || ''))
                : current.status === 'in_progress';
            if (!valid) return;
            return { ...current, worker: null, status: current.type === 'taxi' ? 'pending' : 'waiting',
                driverLat: null, driverLng: null, driverLocationUpdatedAt: null, abandonedAt: Date.now() };
        });
        if (!released.committed) throw new Error('Заказ уже изменился. Обновите страницу.');
        const uSnap = await get(userRef(currentNick));
        const before = uSnap.val() || {};
        const charged = await runTransaction(userRef(currentNick), current => {
            const user = current || before;
            const balance = Number(user.balance || 0);
            return { ...user, balance: balance - Math.min(35, Math.max(0, balance)) };
        });
        if (!charged.committed) throw new Error('Не удалось применить штраф за отказ');
        const after = charged.snapshot.val() || {};
        const actualPenalty = Math.max(0, Number(before.balance || 0) - Number(after.balance || 0));
        if (actualPenalty) await logTx(currentNick, { type: 'out', who: 'Система', amt: actualPenalty, desc: 'Отказ исполнителя от заказа' });
        return { success: true, penalty: actualPenalty };
    }
    throw new Error('Нет прав для отмены');
}

// Fallback: Pay order directly
async function fallbackPayOrder(data) {
    const snap = await get(orderRef(data.orderId));
    if(!snap.exists()) throw new Error('Заказ не найден');
    const o = snap.val();
    if(!o.worker) throw new Error('Нет исполнителя');
    if(o.type==='taxi' && o.status !== 'waiting_payment') throw new Error('Заказ ещё не готов к оплате');
    const [cSnap, wSnap] = await Promise.all([get(userRef(o.client)), get(userRef(o.worker))]);
    const c = cSnap.val();
    const w = wSnap.val();
    if(!c || !w) throw new Error('Пользователь не найден');
    if(Number(c.balance||0) < Number(o.price||0)) throw new Error('Недостаточно средств');
    const debitTx = await runTransaction(userRef(o.client), current=>{
        const u=current||c;
        if(Number(u.balance||0) < Number(o.price||0)) return;
        return {...u,balance:Number(u.balance||0)-Number(o.price||0)};
    });
    if(!debitTx?.committed) throw new Error('Недостаточно средств');
    await runTransaction(userRef(o.worker), current=>{
        const u=current||w;
        return {...u,balance:Number(u.balance||0)+Number(o.price||0)};
    });
    const paidAt=Date.now();
    await logTx(o.client, { type:'out', who:o.worker, amt:o.price, desc:`Оплата заказа ${data.orderId}` });
    await logTx(o.worker, { type:'in', who:o.client, amt:o.price, desc:`Выплата за заказ ${data.orderId}` });
    if(o.type==='taxi') await archiveTaxiOrder(o,'paid');
    else await update(orderRef(data.orderId),{status:'completed',paidAt});
    return { success:true, status:'paid', paidAt };
}

// Fallback: Transfer money directly
async function fallbackTransferMoney(data) {
    const [fromSnap, toSnap] = await Promise.all([get(userRef(currentNick)), get(userRef(data.toUid))]);
    const fromUser = fromSnap.val();
    const toUser = toSnap.val();

    if(!fromUser || !toUser) throw new Error('Пользователь не найден');
    if(!fromUser.accountVerified) throw new Error('Ваш аккаунт не подтверждён');
    if(!toUser.accountVerified) throw new Error('Аккаунт получателя не подтверждён');
    const amount = Math.max(0, Number(data.amount) || 0);
    const rate = (typeof data.commissionRate === 'number') ? data.commissionRate : ECONOMY_TRANSFER_COMMISSION;
    const fee = calcCommission(amount, rate);
    const total = amount + fee;
    if(fromUser.balance < total) throw new Error('Недостаточно средств');

    await update(userRef(currentNick), { balance: fromUser.balance - total });
    await update(userRef(data.toUid), { balance: (toUser.balance || 0) + amount });
    await logTx(currentNick, { type: 'out', who: data.toUid, amt: amount, desc: data.description || 'Перевод' });
    if(fee > 0) await logTx(currentNick, { type: 'out', who: 'Комиссия', amt: fee, desc: `Комиссия ${Math.round(rate*100)}% за перевод` });
    await logTx(data.toUid, { type: 'in', who: currentNick, amt: amount, desc: data.description || 'Перевод' });

    return { success: true, commissionCharged: true, commission: fee, totalSpent: total };
}

// Fallback: Admin adjust balance directly
async function fallbackAdminAdjustBalance(data) {
    if(currentNick !== ADMIN) throw new Error('Только для мэра');
    
    const snap = await get(userRef(data.uid));
    if(!snap.exists()) throw new Error('Пользователь не найден');
    
    const u = snap.val();
    const newBalance = (u.balance || 0) + data.amount;
    
    await update(userRef(data.uid), { balance: newBalance });
    
    if(data.amount > 0) {
        await logTx(data.uid, { type: 'in', who: 'Мэрия', amt: data.amount, desc: data.description || 'Зачисление от мэрии' });
    } else {
        await logTx(data.uid, { type: 'out', who: 'Мэрия', amt: Math.abs(data.amount), desc: data.description || 'Списание мэрией' });
    }
    
    return { success: true, newBalance };
}

function isVideoAvatarSrc(src){
    if(!src) return false;
    return /^data:video\//i.test(src) || /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(src) || src.includes('video');
}
function toggleAvatarMedia(imgEl, videoEl, src){
    if(!imgEl || !videoEl) return;
    const isVideo = isVideoAvatarSrc(src);
    if(isVideo){
        imgEl.style.display = 'none';
        videoEl.style.display = 'block';
        videoEl.src = src || DEFAULT_AVATAR_URL;
        videoEl.muted = true;
        videoEl.loop = true;
        videoEl.playsInline = true;
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', '');
        videoEl.play().catch(()=>{});
    } else {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl.style.display = 'none';
        imgEl.src = src || DEFAULT_AVATAR_URL;
        imgEl.style.display = 'block';
    }
}
function toast(text, type='green') {
    const c=qs('toasts');const t=document.createElement('div');t.className=`toast ${type}`;t.innerHTML=`<span>${text}</span>`;c.appendChild(t);
    setTimeout(()=>{t.style.cssText='opacity:0;transform:translateX(40px);transition:.3s';setTimeout(()=>t.remove(),300);},3000);
}
function hideLoading() {
    const ov = qs('loadingOverlay');
    if(!ov || ov.dataset.closing === '1') return;
    ov.dataset.closing = '1';
    // Let the pine and the village name finish their entrance, even on fast connections.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const elapsed = Date.now() - (window.__kapaniLoaderStart || Date.now());
    const wait = reduced ? 0 : Math.max(0, 1650 - elapsed);
    setTimeout(() => {
        ov.classList.add('lo-complete');
        const status = qs('loStatus');
        if(status) status.textContent = 'Готово!';
        setTimeout(() => {
            ov.classList.add('hidden');
            setTimeout(() => { ov.style.display = 'none'; }, 460);
        }, reduced ? 50 : 290);
    }, wait);
}

// Loading status messages: finite stages instead of a permanent interval.
(function(){
    const msgs = ['Подключение к серверу…','Загружаем данные…','Авторизация…','Почти готово…'];
    msgs.forEach((msg, i)=>setTimeout(()=>{
        const el=qs('loStatus'); const ov=qs('loadingOverlay');
        if(el && ov && ov.style.display !== 'none' && !ov.classList.contains('hidden')) el.textContent=msg;
    }, i*900));
})();

// ─── ONLINE PRESENCE ──────────────────────
let _onlineStatusTimer=null;
let _onlineStatusInFlight=false;
async function updateOnlineStatus() {
    if(!currentNick || _onlineStatusInFlight) return;
    _onlineStatusInFlight=true;
    try { _lastOnlineWriteAt=Date.now(); await update(userRef(currentNick), {lastSeen:Date.now()}); } catch(e){} finally { _onlineStatusInFlight=false; }
}
let _lastOnlineWriteAt=0;
function scheduleOnlineStatusUpdate(){
    // Activity pings are throttled: every click used to write lastSeen (and wake every
    // other client's listeners). ONLINE_TIMEOUT_MS is 3 min, so 30 s precision is plenty.
    if(_onlineStatusTimer || Date.now()-_lastOnlineWriteAt<30000) return;
    _onlineStatusTimer=setTimeout(()=>{_onlineStatusTimer=null;updateOnlineStatus();},1500);
}
function startOnlineHeartbeat() {
    updateOnlineStatus();
    onlineHeartbeatInterval = registerInterval('onlineHeartbeat', setInterval(updateOnlineStatus, 60000));
    ['click','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,scheduleOnlineStatusUpdate,{passive:true}));
    // iOS audio unlock: create AudioContext on first touch so speaker is used
    const unlockAudio = () => {
        try {
            if(!window._iosAudioCtx){
                window._iosAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
                const buf = window._iosAudioCtx.createBuffer(1,1,22050);
                const src = window._iosAudioCtx.createBufferSource();
                src.buffer = buf; src.connect(window._iosAudioCtx.destination); src.start(0);
            }
        } catch(e){}
        document.removeEventListener('touchstart', unlockAudio);
        document.removeEventListener('click', unlockAudio);
    };
    document.addEventListener('touchstart', unlockAudio, {passive:true, once:true});
    document.addEventListener('click', unlockAudio, {once:true});
}

// ─── NOTIFICATION POPUP ───────────────────
let npTimer = null;
function showNotifPopup(text, time) {
    if(npTimer) clearTimeout(npTimer);
    qs('npText').textContent = text;
    qs('npTime').textContent = time||nowTime();
    const el = qs('notifPopup');
    // Reset any stale inline styles left over from clearBlockingLayers()/closeNotifPopup()
    // (display:none / pointer-events:none set while hidden must not persist once shown,
    // otherwise the whole popup — including the ✕ — silently stops receiving clicks).
    el.style.display = '';
    el.style.pointerEvents = 'auto';
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    npTimer = setTimeout(()=>closeNotifPopup(), 5000);
}
window.closeNotifPopup = function() {
    const el = qs('notifPopup');
    el.classList.remove('show');
    el.style.display='none';
    el.style.pointerEvents='none';
    if(npTimer) clearTimeout(npTimer);
};
// Reliable close handler: works for mouse, touch and iOS Safari regardless of
// whatever inline styles other iOS-compat code may have toggled on ancestors.
document.addEventListener('click', function(e){
    const closeBtn = e.target.closest && e.target.closest('.np-close');
    if(!closeBtn) return;
    e.preventDefault();
    e.stopPropagation();
    window.closeNotifPopup();
});

// ─── DB SHORTCUTS ─────────────────────────
const userRef   = (nick) => ref(db, `users/${nick}`);
const ordersRef = ()     => ref(db, 'orders');
const orderRef  = (id)   => ref(db, `orders/${id}`);
const appsRef   = ()     => ref(db, 'apps');
const appRef    = (id)   => ref(db, `apps/${id}`);
const chatRef   = ()     => ref(db, 'chat');
const dmRef     = (key)  => ref(db, `dms/${key}/messages`);
const dmIndexRef = (nick) => ref(db, `dmIndex/${nick}`);
const marketRef = ()     => ref(db, 'marketplace');
const listingRef= (id)   => ref(db, `marketplace/${id}`);
const notifRef  = (nick) => ref(db, `users/${nick}/notifications`);
const txLogRef  = (nick) => ref(db, `users/${nick}/txlog`);
const janitorSubsRef = () => ref(db, 'janitorSubmissions');
const janitorSubRef = (id) => ref(db, `janitorSubmissions/${id}`);
const wallRef = (nick) => ref(db, `walls/${nick}`);
const newsRef = () => ref(db, 'news');
const newsItemRef = (id) => ref(db, `news/${id}`);
const rentBuildingsRef = () => ref(db, 'rentBuildings');
const rentBuildingRef = (id) => ref(db, `rentBuildings/${id}`);
const bizOrdersRef = (bizId) => ref(db, `bizOrders/${bizId}`);
const bizOrderRef = (bizId, orderId) => ref(db, `bizOrders/${bizId}/${orderId}`);
const bizRef = () => ref(db, 'businesses');
const taxiHistoryRef = (id) => ref(db, `taxiHistory/${id}`);
const advertiserStatsRef = (nick) => ref(db, `advertiserStats/${nick}`);
const ACTIVE_ORDER_STATUSES = new Set(['pending','accepted','driver_arriving','in_progress','waiting_payment']);
const DRIVER_ACTIVE_ORDER_STATUSES = new Set(['accepted','driver_arriving','in_progress']);
const TAXI_ACTIVE_STATUSES = new Set(['pending','waiting','accepted','driver_arriving','in_progress','waiting_payment']);
function isActiveOrder(o){ return !!o && ACTIVE_ORDER_STATUSES.has(String(o.status||'')); }
function orderStatusLabel(status){
    return ({pending:'⏳ Ожидание водителя',accepted:'✅ Водитель принял',driver_arriving:'📍 Водитель едет',in_progress:'🚕 Поездка идёт',waiting_payment:'💳 Ожидает оплаты'})[status] || '⏳ Ожидает';
}
async function archiveTaxiOrder(order, finalStatus='paid'){
    if(!order?.id) return;
    const history={...order,status:finalStatus,completedAt:Date.now(),paidAt:order.paidAt||Date.now()};
    const updates={};
    updates[`taxiHistory/${order.id}`]=history;
    updates[`orders/${order.id}`]=null;
    await update(ref(db), updates);
}

function getBusinessIds(u){
    const ids = [];
    const pushId = (v) => {
        if(!v) return;
        if(Array.isArray(v)){ v.forEach(pushId); return; }
        const id = String(v).trim();
        if(id && !ids.includes(id)) ids.push(id);
    };
    pushId(u?.businessIds);
    pushId(u?.businessId);
    return ids;
}
function getOwnedActiveBusinesses(u, nick = currentNick){
    const scan = Object.values(allBusinessesCache || {});
    return scan.filter(b => b && b.status === 'active' && b.owner === (u?.nick || nick));
}
function getBusinessLimitForUser(u){
    const active = u?.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    if((u?.subscription === 'prime') && active) return 8;
    if((u?.subscription === 'ultra') && active) return 5;
    if((u?.subscription === 'plus') && active) return 3;
    return 1;
}

function todayKey(){ return new Date().toLocaleDateString('sv-SE'); }
function displayNick(u){ if(!u) return ''; return (u.displayName && String(u.displayName).trim()) || u.nick || ''; }
function normalizePublicName(s){ return String(s||'').trim().toLowerCase(); }
async function sha256Hex(str){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function hashPassword(password, salt){
    return sha256Hex(`kapani::${normalizePublicName(salt)}::${String(password||'')}`);
}
window.toggleAuthPasswordVisibility = function(){
    const el = qs('lgPass');
    if(!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
};
async function findUserByPublicName(name){
    const q = normalizePublicName(name);
    if(!q) return null;
    if(allUsersCache && Object.keys(allUsersCache).length){
        for(const [nick, u] of Object.entries(allUsersCache)){
            const dn = normalizePublicName(displayNick(u));
            if(dn === q || normalizePublicName(u.referralCode) === q) return { nick, ...u };
        }
    }
    // The login screen is not authenticated yet. It needs public names only,
    // never a full account tree or password-related data.
    const { data: publicProfiles, error: lookupError } = await supabase.rpc('kp_public_profiles');
    if(lookupError) throw new Error('Не удалось найти аккаунты: '+lookupError.message);
    let users = publicProfiles || {};
    const {data:{session:publicLookupSession}}=await supabase.auth.getSession();
    if(publicLookupSession){
        try{
            // A migrated Auth account may still have no JSON profile. Never
            // discard reserved nicknames returned from kp_profiles.
            users={...users,...((await get(ref(db,'users'))).val()||{})};
        }catch(e){console.debug('[Kapani public lookup fallback]',e);}
    }
    for(const [nick, u] of Object.entries(users)){
        const dn = normalizePublicName(displayNick(u));
        if(dn === q || normalizePublicName(u.referralCode) === q) return { nick, ...u };
    }
    return null;
}
function generateReferralCode(){
    const raw=(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID().replace(/-/g,''):`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `KP-${raw.slice(0,10).toUpperCase()}`;
}
function makeNickFromName(name){
    let base = String(name||'').trim().replace(/\s+/g, '_').replace(/[^\wа-яА-ЯёЁ_-]/gi, '').slice(0, 24);
    if(!base) base = 'user';
    return base;
}
async function ensureUniqueNick(baseNick){
    let nick = baseNick;
    let i = 1;
    const {data:publicProfiles,error:lookupError}=await supabase.rpc('kp_public_profiles');
    if(lookupError) throw new Error('Не удалось проверить имя: '+lookupError.message);
    while(true){
        if(!Object.hasOwn(publicProfiles||{},nick)) return nick;
        nick = `${baseNick.slice(0, 20)}_${i}`;
        i++;
        if(i > 99) return genId();
    }
}
function getJobLimit(u){
    const active = u?.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    if(u?.subscription === 'prime' && active) return 5;
    if(u?.subscription === 'ultra' && active) return 4;
    if(u?.subscription === 'plus' && active) return 3;
    return 2;
}
function getBizLimits(b){
    const bonus = b?.limitBonus || {};
    return {
        employees: BIZ_BASE_LIMITS.employees + Number(bonus.employees ?? bonus.employee ?? 0),
        products: BIZ_BASE_LIMITS.products + Number(bonus.products ?? bonus.product ?? 0),
        maxProductPrice: BIZ_BASE_LIMITS.maxProductPrice + Number(bonus.priceCap || 0) * 500
    };
}
function collectEmploymentsFromData(u, nick){
    const list = [];
    const seen = new Set();
    const push = (item) => {
        if(!item || !item.id || seen.has(item.id)) return;
        seen.add(item.id);
        list.push(item);
    };
    if(Array.isArray(u?.employments)) u.employments.forEach(push);
    if(u?.job && u.job !== 'Житель') push({ id: `muni_${u.job}`, type: 'municipal', role: u.job });
    const scan = Object.values(allBusinessesCache || {});
    scan.forEach(b => {
        if(!b || b.status !== 'active') return;
        const emp = b.employees?.[nick];
        if(emp) push({ id: `biz_${b.id}`, type: 'business', bizId: b.id, role: getBizEmployeeRoleName(emp), bizName: b.name || 'Бизнес' });
    });
    return list;
}
function countActiveEmployments(u, nick){ return collectEmploymentsFromData(u, nick).length; }
function getDisplayJobLabel(u, nick){
    const emps = collectEmploymentsFromData(u, nick);
    if(u?.displayJob && emps.some(e => e.role === u.displayJob)) return u.displayJob;
    if(emps.length) return emps[0].role;
    return (u && u.job && u.job !== 'Житель') ? u.job : 'Житель';
}
function hasMunicipalJob(u, jobName){
    return collectEmploymentsFromData(u, u?.nick || currentNick).some(e => e.type === 'municipal' && e.role === jobName);
}
function hasEmploymentRole(u, nick, role){
    return collectEmploymentsFromData(u, nick).some(e => e.role === role);
}
async function syncUserEmployments(nick, u){
    const emps = collectEmploymentsFromData(u, nick);
    if(Array.isArray(u?.employments) && u.employments.length === emps.length) return emps;
    await update(userRef(nick), { employments: emps });
    return emps;
}
async function canTakeAnotherJob(u, nick){
    await syncUserEmployments(nick, u);
    const fresh = (await get(userRef(nick))).val() || u;
    return countActiveEmployments(fresh, nick) < getJobLimit(fresh);
}
function applyBizBgEffect(el, effectId){
    if(!el) return;
    const cls = ['profile-bg-shimmer','profile-bg-particles','profile-bg-gradient-animated','profile-bg-ocean','profile-bg-sunset','profile-bg-aurora','profile-bg-galaxy','profile-bg-fire','profile-bg-plasma','profile-bg-thunder','profile-bg-hologram','profile-bg-dragon','profile-bg-prime'];
    el.classList.remove(...cls);
    const eff = BIZ_BG_EFFECTS.find(x => x.id === effectId);
    if(eff?.cls) el.classList.add(eff.cls);
}
function formatMoneyLine(tx){
    const sign = tx.type==='in' ? '+' : '−';
    const amt = Math.abs(tx.amt||0);
    const desc = escHtml(tx.desc || tx.label || (tx.type==='in' ? `от ${tx.who||'?'}` : `к ${tx.who||'?'}`));
    const d = escHtml(tx.date||'');
    const t = escHtml(tx.time||'');
    return `${d}, ${t} — ${sign}${amt} ₽ — ${desc}`;
}
async function syncJanitorTaskState(u){
    if(!currentNick || !u || !hasMunicipalJob(u, JOB_JANITOR)) return;
    const today = todayKey();
    if(u.janitorTaskDate === today) return;
    try {
        await update(userRef(currentNick), { janitorTaskDate: today, janitorSubmissionId: '', janitorSubmissionStatus: 'ready', janitorProof: '', janitorComment: '' });
    } catch(e) {}
}
function updateFrozenOverlay(u){
    const fo = qs('frozenOverlay');
    if(!fo || !u) return;
    const b = u.balance ?? 0;
    if(b <= MIN_BALANCE_ALLOWED) fo.classList.add('open');
    else fo.classList.remove('open');
}

function calcCommission(amount, rate = 0.02){
    const n = Math.max(0, Number(amount) || 0);
    if(n <= 0) return 0;
    return Math.max(1, Math.round(n * rate));
}
function getDebtHelpHtml(){
    return `
    <div class="card" style="margin:0 0 12px;background:rgba(248,191,36,.08);border-color:rgba(255,128,106,.3);">
        <div class="card-title" style="margin-bottom:10px;">⚠️ Долг по аккаунту</div>
        <div style="font-size:13px;line-height:1.55;color:var(--text);margin-bottom:12px;">
            Баланс отрицательный, поэтому такси и маркетплейс заблокированы.
            Напишите мэру <b style="color:var(--gold);">Кайону</b> за заданиями для погашения долга.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="openUserProfile('Кайон')">👤 Профиль Кайона</button>
            <button class="btn btn-ghost btn-sm" onclick="navTo('tasks')">🗂 Задания</button>
        </div>
    </div>`;
}
function renderDebtNotice(targetId, u){
    const el = qs(targetId);
    if(!el) return;
    const balance = Number(u?.balance || 0);
    el.innerHTML = balance < 0 ? getDebtHelpHtml() : '';
}
let economyMaintenanceBusy = false;
async function processBusinessWeeklyFees(nick, u, opts = {}){
    const owned = getOwnedActiveBusinesses(u, nick);
    if(!owned.length) return;
    const now = Date.now();
    let balance = Number(u.balance || 0);
    let charged = 0;
    for(const b of owned){
        const last = Number(b.bizWeeklyFeeAt || b.createdAt || now);
        const weeks = Math.floor((now - last) / ECONOMY_WEEK_MS);
        if(weeks <= 0) continue;
        const fee = ECONOMY_BUSINESS_WEEKLY_FEE * weeks;
        balance -= fee;
        charged += fee;
        await update(bizItemRef(b.id), { bizWeeklyFeeAt: last + weeks * ECONOMY_WEEK_MS });
        await logTx(nick, { type: 'out', who: b.name || 'Бизнес', amt: fee, desc: `Абонентская плата бизнеса «${b.name}» (${weeks} нед.)` });
        if(opts.notify !== false) await pushNotification(nick, `🏪 Списано ${fee}₽ за ${weeks} нед. наличия бизнеса «${b.name}»`, 'money');
    }
    if(charged > 0){
        await update(userRef(nick), { balance });
        await window.addMunicipalTreasury?.(charged, `Абонентская плата бизнеса от ${nick}`, {sourceNick:nick,sourceType:'business_weekly_fee'});
    }
}
async function processSavingsInterest(nick, u, opts = {}){
    const savings = Number(u.savingsBalance || 0);
    if(savings <= 0) return u;
    const now = Date.now();
    const last = Number(u.savingsLastInterestAt || u.createdAt || now);
    const days = Math.floor((now - last) / ECONOMY_DAY_MS);
    if(days <= 0) return u;
    let total = savings;
    for(let i = 0; i < days; i++){
        const dailyRate = getSavingsDailyRate(total);
        total = Math.round(total * (1 + dailyRate));
    }
    const interest = total - savings;
    const patch = { savingsBalance: total, savingsLastInterestAt: last + days * ECONOMY_DAY_MS };
    await update(userRef(nick), patch);
    if(interest > 0 && opts.notify !== false){
        await logTx(nick, { type: 'in', who: 'Накопительный счёт', amt: interest, desc: `Начисление ${days} дн. по действующей ставке` });
        await pushNotification(nick, `📈 Накопительный счёт: +${interest}₽ за ${days} дн.`, 'money');
    }
    return { ...u, ...patch };
}

async function processEconomyChargesForUser(nick, opts = {}) {
    if(!nick || economyMaintenanceBusy) return null;
    // Only the signed-in account may trigger server-calculated charges.
    // Previously this function used a client transaction on users/<nick>,
    // which the protected backend correctly rejected.
    if(nick!==currentNick) return null;
    economyMaintenanceBusy = true;
    try {
        const {data,error}=await supabase.rpc('kp_process_economy_charges');
        if(error) throw new Error(error.message||'Ошибка экономического расчёта');
        const snap=await get(userRef(nick));
        const updated=snap.val()||{};
        if(opts.notify!==false && data?.weeks>0 && data?.charged>0){
            await pushNotification(nick,`💳 Списано за ${data.weeks} нед.: ${Number(data.charged).toLocaleString('ru-RU')} ₽ налогов и абонентской платы.`,'money');
        }
        return updated;
    } catch(e) {
        console.warn('Economy maintenance failed:', e);
        return null;
    } finally {
        economyMaintenanceBusy = false;
    }
}

async function ensureEconomyFresh(opts = {}){
    if(!currentNick) return null;
    const result = await processEconomyChargesForUser(currentNick, opts);
    // Other legacy automated payments are waiting for dedicated, verified RPCs.
    // Client-side accruals would grant the browser the ability to mint money.
    return result;
}
async function requireMarketTaxiAccess(){
    if(!await requireSpendable()) return false;
    const snap = await get(userRef(currentNick));
    if(!snap.exists()) return false;
    const u = snap.val() || {};
    if((u.balance || 0) < 0){
        renderDebtNotice('marketDebtNotice', u);
        renderDebtNotice('taxiDebtNotice', u);
        toast('🚫 Такси и маркетплейс заблокированы при отрицательном балансе. Напишите мэру Кайону за заданиями.', 'red');
        return false;
    }
    return true;
}
async function chargeCommissionAndLog(nick, fee, desc){
    const amount = Math.max(0, Math.round(Number(fee) || 0));
    if(amount <= 0) return;
    const snap = await get(userRef(nick));
    if(!snap.exists()) return;
    const u = snap.val() || {};
    await update(userRef(nick), { balance: (u.balance || 0) - amount });
    await logTx(nick, { type: 'out', who: 'Комиссия', amt: amount, desc: desc || `Комиссия ${amount}₽` });
}

async function requireSpendable(){
    const s = await get(userRef(currentNick));
    if(!s.exists()) return false;
    const u = s.val();
    
    // Check if account is verified
    if(!u.accountVerified) {
        toast('❌ Ваш аккаунт не подтверждён мэрией. Подождите подтверждения.','red');
        return false;
    }
    
    const b = u.balance ?? 0;
    if(b <= MIN_BALANCE_ALLOWED){ toast('🧊 Баланс заблокирован: слишком большой минус. Нужен перевод или помощь мэрии.','red'); return false; }
    return true;
}
async function logTx(nick, entry){
    const { date, time, ts } = fullDateTimeStr();
    await push(txLogRef(nick), { ...entry, date, time, ts });
    
    // Update total earned for income transactions (anti-dup system)
    if(entry.type === 'in' && entry.amt > 0) {
        try {
            const snap = await get(userRef(nick));
            if(snap.exists()) {
                const user = snap.val();
                const newTotalEarned = (user.totalEarned || 0) + entry.amt;
                await update(userRef(nick), { totalEarned: newTotalEarned });
            }
        } catch(e) {
            console.warn('Failed to update total earned:', e);
        }
    }
}

// ─── MONEY / ADVERTISER HELPERS ─────────────────────────────────
function parseMoneyValue(value, fallback = 0){
    if(typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if(value === null || value === undefined) return fallback;
    let s = String(value).trim();
    if(!s) return fallback;
    s = s.replace(/\u00A0/g,'').replace(/\s/g,'').replace(/₽/g,'');
    let normalized = s;
    const comma = normalized.lastIndexOf(',');
    const dot = normalized.lastIndexOf('.');
    if(comma >= 0 && dot >= 0){
        if(comma > dot) normalized = normalized.replace(/\./g,'').replace(',', '.');
        else normalized = normalized.replace(/,/g,'');
    }else if(comma >= 0){
        const tail = normalized.length - comma - 1;
        normalized = tail === 3 ? normalized.replace(/,/g,'') : normalized.replace(',', '.');
    }else if(dot >= 0){
        const tail = normalized.length - dot - 1;
        if(tail === 3) normalized = normalized.replace(/\./g,'');
    }
    const direct = Number(normalized);
    if(Number.isFinite(direct)) return direct;
    return fallback;
}
function advertiserWeekKey(ts = Date.now()){
    const d = new Date(ts);
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString('sv-SE');
}
function shiftAdvertiserWeekKey(key, delta){
    const d = new Date(`${String(key||'')}T00:00:00`);
    if(Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + Number(delta||0) * 7);
    return d.toLocaleDateString('sv-SE');
}
async function getAdvertiserReferralCount(nick){
    if(!nick) return 0;
    try{
        const statsSnap=await get(advertiserStatsRef(nick));
        const resetAt=Number(statsSnap.val()?.resetAt||0);
        const qRef=query(ref(db,'users'),orderByChild('invitedBy'),equalTo(nick));
        const snap=await get(qRef);
        const users=snap.val()||{};
        return Object.values(users).filter(u=>Number(u?.referralCreatedAt||u?.createdAt||0)>resetAt).length;
    }catch(e){
        console.warn('[advertiser referral count]',nick,e);
        return 0;
    }
}
async function incrementAdvertiserReferralCount(nick){
    if(!nick) return;
    try{
        await runTransaction(advertiserStatsRef(nick), cur=>{
            const state=cur&&typeof cur==='object'?cur:{};
            return {...state,total:Number(state.total||0)+1,lastInvitedAt:Date.now()};
        });
    }catch(e){ console.warn('[advertiser referral increment]',nick,e); }
}
async function clearAdvertiserReferralStats(){
    if(currentNick!==ADMIN) throw new Error('Только для мэра');
    const snap=await get(ref(db,'users'));
    const users=snap.val()||{};
    const advertisers=Object.entries(users).filter(([nick,u])=>hasMunicipalJob(u,JOB_ADVERTISER)).map(([nick])=>nick);
    const resetAt=Date.now();
    await Promise.all(advertisers.map(nick=>set(advertiserStatsRef(nick),{total:0,resetAt,updatedAt:resetAt})));
    return advertisers.length;
}
window.getAdvertiserReferralCount=getAdvertiserReferralCount;
window.clearAdvertiserReferralStats=clearAdvertiserReferralStats;

async function processAdvertiserWeeklySalary(nick, uSnapshot){
    if(!nick) return null;
    const userSnap = uSnapshot ? { val:()=>uSnapshot, exists:()=>true } : await get(userRef(nick));
    if(!userSnap.exists()) return null;
    const u = userSnap.val() || {};
    if(!hasMunicipalJob(u, JOB_ADVERTISER)) return u;

    const currentWeek = advertiserWeekKey();
    let paidThrough = String(u.advertiserSalaryPaidThroughWeek || '').trim();
    if(!paidThrough){
        await update(userRef(nick), { advertiserSalaryPaidThroughWeek: currentWeek, advertiserStartedWeek: u.advertiserStartedWeek || currentWeek });
        return { ...u, advertiserSalaryPaidThroughWeek: currentWeek, advertiserStartedWeek: u.advertiserStartedWeek || currentWeek };
    }
    if(paidThrough >= currentWeek) return u;

    const completedWeeks=[];
    let cursor = shiftAdvertiserWeekKey(paidThrough, 1);
    let guard=0;
    while(cursor && cursor < currentWeek && guard++ < 104){
        completedWeeks.push(cursor);
        cursor = shiftAdvertiserWeekKey(cursor, 1);
    }
    if(!completedWeeks.length) return u;

    let allUsers = {};
    try{
        const allUsersSnap = await get(ref(db,'users'));
        allUsers = allUsersSnap.val() || {};
    }catch(e){
        console.warn('[advertiser weekly users read]', nick, e);
        return null;
    }

    const weekRows = await Promise.all(completedWeeks.map(async week => {
        try{
            const referrals = {};
            Object.entries(allUsers).forEach(([userNick,user])=>{
                if(!user || userNick===nick) return;
                if(String(user.invitedBy||'') !== nick) return;
                if(String(user.referralWeekKey||'') !== week) return;
                referrals[userNick] = { nick:userNick, displayName:displayNick(user) || userNick, createdAt:Number(user.referralCreatedAt||user.createdAt||0) };
            });
            const count = Object.keys(referrals).length;
            // Persist the weekly aggregate under the advertiser's own user record.
            try{
                await set(ref(db, `users/${nick}/advertiserWeekly/${week}/count`), count);
                await set(ref(db, `users/${nick}/advertiserWeekly/${week}/referrals`), referrals);
            }catch(writeErr){
                console.warn('[advertiser weekly aggregate write]', nick, week, writeErr);
            }
            const payout = count >= ADVERTISER_WEEKLY_MIN_REFERRALS
                ? ADVERTISER_WEEKLY_BASE_SALARY + Math.max(0, count - ADVERTISER_WEEKLY_MIN_REFERRALS) * ADVERTISER_EXTRA_REFERRAL_BONUS
                : 0;
            return { week, count, payout };
        }catch(e){
            console.warn('[advertiser weekly calculate]', nick, week, e);
            return { week, count:0, payout:0, readError:true };
        }
    }));
    if(weekRows.some(row=>row.readError)) return null;
    const totalPayout = weekRows.reduce((sum,row)=>sum + Number(row.payout||0), 0);

    const tx = await runTransaction(userRef(nick), current => {
        if(!current || !hasMunicipalJob(current, JOB_ADVERTISER)) return;
        if(String(current.advertiserSalaryPaidThroughWeek || '').trim() !== paidThrough) return;
        const currentBalance = parseMoneyValue(current.balance, 0);
        if(totalPayout <= 0){
            return { ...current, advertiserSalaryPaidThroughWeek: currentWeek };
        }
        return {
            ...current,
            balance: currentBalance + totalPayout,
            advertiserSalaryPaidThroughWeek: currentWeek,
            totalEarned: parseMoneyValue(current.totalEarned, 0) + totalPayout
        };
    });
    if(!tx?.committed) return null;

    for(const row of weekRows){
        try{
            if(row.payout > 0){
                await logTx(nick,{type:'in',who:'Мэрия',amt:row.payout,desc:`Зарплата рекламщика за неделю ${row.week}: ${row.count} приглашённых`});
                await pushNotification(nick, `📢 Зарплата рекламщика: +${row.payout.toLocaleString('ru-RU')} ₽ за неделю ${row.week}. Приглашено: ${row.count}`, 'money');
            }else{
                await pushNotification(nick, `📢 Итог недели ${row.week}: приглашено ${row.count}. Нужно минимум 4 — зарплата за эту неделю не начислена.`, 'system');
            }
        }catch(e){ console.warn('[advertiser weekly payout log/notification]', nick, row.week, e); }
    }
    return tx.snapshot?.val?.() || { ...u, advertiserSalaryPaidThroughWeek: currentWeek, balance: parseMoneyValue(u.balance,0)+totalPayout };
}
window.JOB_ADVERTISER = JOB_ADVERTISER;
window.ADVERTISER_KVE_REQUIRED = ADVERTISER_KVE_REQUIRED;
window.advertiserWeekKey = advertiserWeekKey;

// ─── MUNICIPAL TREASURY ─────────────────────────────
const MUNICIPAL_TREASURY_PATH = 'municipalTreasury';
function municipalTreasuryRef(){ return ref(db, MUNICIPAL_TREASURY_PATH); }
async function addMunicipalTreasury(amount, reason, meta = {}){
    const value=Math.round(parseMoneyValue(amount, 0)); if(value<=0) return false;
    try{
        const tx=await runTransaction(municipalTreasuryRef(),current=>{
            const state=(current&&typeof current==='object')?current:{balance:current};
            const balance=parseMoneyValue(state.balance,0);
            return {...state,balance:balance+value,updatedAt:Date.now()};
        });
        if(!tx?.committed) return false;
        try{ await push(ref(db,`${MUNICIPAL_TREASURY_PATH}/history`),{type:'in',amount:value,reason:reason||'Поступление в казну',sourceNick:meta.sourceNick||null,sourceType:meta.sourceType||null,date:new Date().toLocaleDateString('ru'),time:nowTime(),ts:Date.now()}); }catch(e){console.warn('[municipalTreasury history]',e);}
        try{ if(currentNick===ADMIN&&typeof window.renderMunicipalTreasury==='function') window.renderMunicipalTreasury(); }catch(e){}
        return true;
    }catch(e){ console.error('[municipalTreasury add]',e); return false; }
}
window.addMunicipalTreasury=addMunicipalTreasury;

window.clearMunicipalTreasuryHistory=async function(){
    if(currentNick!==ADMIN) return toast('🚫 Только Кайон может очищать историю казны','red');
    const ok=confirm('Очистить всю историю операций казны? Баланс казны при этом не изменится.');
    if(!ok) return;
    try{
        const {error}=await supabase.rpc('kp_municipal_treasury_clear_history');
        if(error) throw new Error(error.message||'Ошибка сервера');
        toast('✅ История операций казны очищена','green');
        if(typeof window.renderMunicipalTreasury==='function') await window.renderMunicipalTreasury();
    }catch(e){
        console.error('[municipalTreasury clear history]',e);
        toast('❌ Не удалось очистить историю: '+(e?.message||'ошибка сервера'),'red');
    }
};

window.withdrawMunicipalTreasury=async function(){
    if(currentNick!==ADMIN) return toast('🚫 Только Кайон может выводить деньги из казны','red');
    const rawAmount=String(prompt('Сколько ₽ вывести из казны на аккаунт Кайона?','0')||'').trim();
    const parsedAmount=parseMoneyValue(rawAmount, NaN);
    const amount=Math.floor(parsedAmount);
    if(!Number.isSafeInteger(amount)||amount<=0) return toast('⚠️ Укажите корректную сумму','gold');
    try{
        const {data,error}=await supabase.rpc('kp_municipal_treasury_withdraw',{p_amount:amount});
        if(error) throw new Error(error.message||'Операция на сервере не выполнена');
        if(!data?.ok) throw new Error('В казне недостаточно средств');
        const committedMayor=(await get(userRef(ADMIN))).val()||{};
        allUsersCache[ADMIN]=committedMayor;
        window.allUsersCache=allUsersCache;
        updateHeader_balance(committedMayor);
        if(typeof window.renderMunicipalTreasury==='function') await window.renderMunicipalTreasury();
        void pushNotification(ADMIN,`💰 Из казны мэрии выведено ${amount.toLocaleString('ru-RU')} ₽`,'money');
        toast(`✅ ${amount.toLocaleString('ru-RU')} ₽ выведено из казны`,'green');
    }catch(e){
        console.error('[municipalTreasury withdraw]',e);
        toast('❌ Не удалось вывести средства из казны: '+(e.message||'ошибка'),'red');
    }
};

// ─── AUTH ─────────────────────────────────
window.handleAuth = async function() {
    const nameInput = (qs('lgNick').value || '').trim();
    const password = (qs('lgPass').value || '');
    const legacyEmail = String(qs('lgLegacyEmail')?.value || '').trim();
    const inviterInput = String(qs('lgInviter')?.value || '').trim();
    if(!nameInput) return toast('⚠️ Введите отображаемое имя','gold');
    if(!password) return toast('⚠️ Введите пароль','gold');
    const btn = qs('authBtn'); btn.disabled = true; btn.textContent = 'Подключение...';
    const resetBtn = () => { btn.disabled = false; btn.textContent = 'Войти / Создать аккаунт'; };
    try {
        const existing = await findUserByPublicName(nameInput);
        if(!existing) {
            if(password.length < 8) throw new Error('Для нового аккаунта пароль должен быть не короче 8 символов');
            if(legacyEmail) throw new Error('Старый аккаунт с таким именем не найден. Проверь имя, не создавай новый аккаунт вместо него.');
            const baseNick = makeNickFromName(nameInput);
            const nick = await ensureUniqueNick(baseNick);
            const now = Date.now();
            // New accounts are owned by Supabase Auth; the database never stores
            // a browser-readable password hash.

            let advertiserReferrer = null;
            if(inviterInput){
                const candidate = await findUserByPublicName(inviterInput);
                if(!candidate){
                    resetBtn();
                    return toast('❌ Рекламщик с таким именем или кодом не найден','red');
                }
                if(candidate.nick === nick){
                    resetBtn();
                    return toast('❌ Нельзя указать себя пригласившим','red');
                }
                if(!hasMunicipalJob(candidate, JOB_ADVERTISER)){
                    resetBtn();
                    return toast('❌ Указанный пользователь сейчас не работает рекламщиком','red');
                }
                advertiserReferrer = { nick:candidate.nick, displayName:displayNick(candidate) || candidate.nick };
            }

            const userData = {
                nick,
                balance: 0,
                job: 'Житель',
                avatar: DEFAULT_AVATAR_URL,
                joinDate: new Date().toLocaleDateString('ru'),
                vehicle: '',
                lastSeen: Date.now(),
                displayName: nameInput,
                accountFrozen: false,
                rewardedAvatar: false,
                rewardedWall: false,
                createdAt: now,
                economyLastProcessedAt: now,
                savingsBalance: 0,
                savingsLastInterestAt: now,
                taskBalance: 0,
                employments: [],
                totalEarned: 0,
                accountVerified: false,
                referralCode: generateReferralCode(),
                ...(advertiserReferrer ? {
                    invitedBy: advertiserReferrer.nick,
                    invitedByName: advertiserReferrer.displayName,
                    referralWeekKey: advertiserWeekKey(now),
                    referralCreatedAt: now
                } : {})
            };

            const registered=await fetch(PUSH_WORKER_URL+'/register',{
                method:'POST',headers:{'content-type':'application/json',apikey:CONFIG.supabase.anonKey},
                body:JSON.stringify({nick,password,profile:userData})
            });
            const registration=await registered.json().catch(()=>({}));
            if(!registered.ok || !registration.ok) throw new Error(registration.error||'Не удалось создать аккаунт');
            await establishKapaniServerSession(nick,password);
            // Referral metadata is stored on the newly-created user's own record.
            // This preserves the existing Firebase user-write boundary; the advertiser's
            // weekly aggregate is materialized later by the advertiser's economy cycle.
            const createdUser=(await get(userRef(nick))).val()||userData;
            localStorage.setItem('kp_s', nick);
            sessionStorage.setItem('kp_s', nick);
            localStorage.setItem('kp_auth', JSON.stringify({ nick, name: nameInput, displayName: nameInput }));
            currentNick = nick;
            allUsersCache[nick]=createdUser;
            allUsersCacheLoaded=true;
            window.allUsersCache=allUsersCache;
            renderHomeStats_users(allUsersCache);
            _kapaniSessionPassword = password;
            syncCurrentNick();
            await ensureAuth();
            if(advertiserReferrer){
                await incrementAdvertiserReferralCount(advertiserReferrer.nick);
                try {
                    await pushNotification(advertiserReferrer.nick, `📢 Новый приглашённый: ${nameInput} зарегистрировался по вашей рекомендации`, 'system');
                } catch(e){ console.warn('[advertiser referral notification]', e); }
            }
            try {
                await pushNotification(ADMIN, `🆕 Новый аккаунт: ${nameInput}`, 'system');
            } catch(e){ console.warn('[new account notification]', e); }
            toast('🎉 Добро пожаловать в Капани! Ваш аккаунт ожидает подтверждения мэрией.','green');
            startApp();
        } else {
            // Password verification must be performed by Supabase Auth, not by
            // comparing hashes downloaded from the public user tree.
            await establishKapaniServerSession(existing.nick, password, legacyEmail);
            toast('👋 С возвращением!','green');
            localStorage.setItem('kp_s', existing.nick);
            sessionStorage.setItem('kp_s', existing.nick);
            localStorage.setItem('kp_auth', JSON.stringify({ nick: existing.nick, name: displayNick(existing), displayName: displayNick(existing) }));
            currentNick = existing.nick;
            _kapaniSessionPassword = password;
            syncCurrentNick();
            startApp();
        }
    } catch(e) {
        resetBtn();
        toast('❌ Ошибка: ' + e.message, 'red');
    }
};

function startApp() {
    if(appStarted){
        revealApp();
        hideLoadingSafe();
        return;
    }
    appStarted = true;

    const authSection = qs('authSection');
    const header = qs('gHeader');
    const bottom = qs('bottomNav');
    const main = qs('mainApp');
    if(authSection) authSection.style.display='none';
    if(header) header.style.display='none';
    if(bottom) bottom.style.display='none';
    if(main) main.style.display='none';

    // Resolve the persisted identity before binding any user-scoped listeners.
    // This prevents notifications/user listeners from being attached to an
    // outdated or empty nick during the startup race.
    try {
        const auth = JSON.parse(localStorage.getItem('kp_auth') || 'null');
        if(auth && auth.nick && (!currentNick || currentNick!==auth.nick)) {
            localStorage.setItem('kp_s', auth.nick);
            sessionStorage.setItem('kp_s', auth.nick);
            currentNick = auth.nick;
        }
    } catch(e) {}
    syncCurrentNick();
    try { attachListeners(); } catch(e) { console.error('[Kapani] listeners init:',e); }

    const loStatus = document.getElementById('loStatus');
    const loBar    = document.getElementById('loBar');
    if(loStatus) loStatus.textContent = 'Загружаем ваш профиль…';
    if(loBar) loBar.style.cssText = 'width:45%;transition:width .35s ease;';

    // Critical path: only the signed-in user's profile. Heavy/global branches are lazy.
    const criticalProfileLoad = Promise.race([
        get(userRef(currentNick)),
        new Promise((_, reject)=>setTimeout(()=>reject(new Error('profile_load_timeout')), 8000))
    ]);
    Promise.resolve()
      .then(()=>criticalProfileLoad)
      .then(()=>{
          try{ revealApp(); }catch(e){ console.error('[Kapani] Failed to reveal app shell:',e); if(header) header.style.display='flex'; if(bottom) bottom.style.display='flex'; if(main) main.style.display='block'; }
          if(loStatus) loStatus.textContent='Готово!';
          if(loBar) loBar.style.cssText='width:100%;transition:width .2s ease;';
          hideLoadingSafe();
          handleKapaniPushDeepLink();
          setTimeout(()=>showFirstPushPrompt(), 600);

          // If permission was already granted, reuse the persisted browser Web Push
          // subscription. No permission prompt is shown automatically here.
          setTimeout(async ()=>{
              try { if(currentNick && ('Notification' in window) && Notification.permission==='granted') await ensureWebPushOnStartup(); }
              catch(e){ console.debug('[Kapani Push] startup restore:', e); }
          }, 900);

          const defer = window.requestIdleCallback || ((cb)=>setTimeout(cb, 0));
          defer(()=>{
              try { startOnlineHeartbeat(); } catch(e) { console.error('[Kapani] heartbeat init:',e); }
              try { startLiveDataLayer(); } catch(e) { console.error('[Kapani] live layer init:',e); }
              try { ensureEconomyFresh({notify:true}).catch(e=>console.warn('[Kapani] economy refresh:',e)); } catch(e) {}
              try {
                  window._economyTimer && clearInterval(window._economyTimer);
                  window._economyTimer = setInterval(()=>ensureEconomyFresh({notify:true}).catch(e=>console.warn('[Kapani] economy refresh:',e)), 5 * 60 * 1000);
              } catch(e) {}
              try { requestPersistentStorage(); } catch(e) {}
              if(typeof window.startKapaniRentExpiryWatcher === 'function') window.startKapaniRentExpiryWatcher();
          }, {timeout: 1500});
      });
}

function handleKapaniPushDeepLink(rawUrl){
    try{
        const params=rawUrl?new URL(rawUrl,location.href).searchParams:new URLSearchParams(location.search);
        const section=params.get('kpSection');
        const dm=params.get('kpDm');
        if(section==='messages'){
            navTo('messages');
            if(dm) setTimeout(()=>{ try{ if(typeof openDmChat==='function') openDmChat(decodeURIComponent(dm)); }catch(e){} },150);
        } else if(section==='news'){
            navTo('news');
        } else if(rawUrl){
            navTo('profile');
        }
    }catch(e){}
}

function revealApp(){
    const h=qs('gHeader'); const b=qs('bottomNav'); const m=qs('mainApp');
    if(h) h.style.display='flex';
    if(b) b.style.display='flex';
    if(m) m.style.display='block';
    try { navTo('home'); } catch(e) { console.error('[Kapani] home navigation:',e); }
}

window.logout = function() {
    const logoutNick=currentNick;

    // Do not block the button on network/Firebase operations. The visible
    // account state is cleared immediately; cleanup continues best-effort.
    try { if(logoutNick) void unregisterWebPushSubscription().catch(e => console.debug('[Kapani Push] logout unregister:', e)); } catch(e) {}
    try { if(typeof stopTaskLiveListeners==='function') stopTaskLiveListeners(); } catch(e) {}
    try { stopAllActivity(); } catch(e) {}
    try { leaveAllServiceServices(); } catch(e) {}
    try { Object.values(listeners).forEach(({ref:r,fn})=>off(r,'value',fn)); } catch(e) {}
    try { if(dmListeners.current){off(dmListeners.current.ref,'value',dmListeners.current.fn);} } catch(e) {}
    try { if(dmListeners.read){off(dmListeners.read.ref,'value',dmListeners.read.fn);} } catch(e) {}
    listeners={}; dmListeners={};
    _callsListenerStarted=false; _callsSeen=false; _lastCalls={};
    try { if(authInstance?.currentUser) void authModule.signOut(authInstance).catch(e=>console.debug('[Kapani auth] signOut:',e)); } catch(e) {}

    try { localStorage.removeItem('kp_webpush_subscription_id'); } catch(e) {}
    window._kapaniWebPushSubscriptionId = null;
    try { localStorage.removeItem('kp_s'); sessionStorage.removeItem('kp_s'); localStorage.removeItem('kp_auth'); } catch(e) {}
    currentNick = null; _kapaniSessionPassword = null; kapaniLegacyLoginEmail = ''; kapaniVerifiedIdentity=null; syncCurrentNick();
    location.reload();
};

// ─── REAL-TIME LISTENERS ──────────────────
const serviceListeners = Object.create(null);
function addServiceListener(service, key, targetRef, callback, cancelCallback){
    if(!serviceListeners[service]) serviceListeners[service]=Object.create(null);
    removeServiceListener(service,key);
    const unsub = onValue(targetRef, callback, cancelCallback || (err=>console.warn(`[Kapani ${service}/${key}] listener`, err?.message || err)));
    serviceListeners[service][key]={ref:targetRef,fn:callback,unsub};
    return serviceListeners[service][key];
}
function removeServiceListener(service,key){
    const item=serviceListeners[service]?.[key];
    if(item){ try{ if(item.unsub) item.unsub(); else off(item.ref,'value',item.fn); }catch(e){} delete serviceListeners[service][key]; }
}
function removeAllServiceListeners(service){
    const bucket=serviceListeners[service];
    if(!bucket) return;
    Object.keys(bucket).forEach(key=>removeServiceListener(service,key));
    delete serviceListeners[service];
}
function leaveAllServiceServices(){
    Object.keys(serviceListeners).forEach(removeAllServiceListeners);
}
async function loadAllUsersCache(force=false){
    if(force){ allUsersCacheLoaded=false; allUsersCachePromise=null; }
    if(!force && allUsersCacheLoaded) return allUsersCache;
    if(!force && allUsersCachePromise) return allUsersCachePromise;
    allUsersCachePromise = (async()=>{
        const snap=await get(ref(db,'users'));
        allUsersCache=snap.val()||{};
        allUsersCacheLoaded=true;
        window.allUsersCache=allUsersCache;
        if(currentNick && !allUsersCache[currentNick]){
            try{ const mine=await get(userRef(currentNick)); if(mine.exists()) allUsersCache[currentNick]=mine.val(); }catch(e){}
        }
        return allUsersCache;
    })();
    try { return await allUsersCachePromise; }
    finally { allUsersCachePromise=null; }
}
function attachUserListener(){
    removeServiceListener('core','user');
    const uRef=userRef(currentNick);
    const uFn=async(snap)=>{
        if(!snap.exists()) return;
        const u=snap.val();
        allUsersCache[currentNick]=u; window.allUsersCache=allUsersCache;
        try{ liveOwnAccountChanged(u); }catch(e){}
        await syncJanitorTaskState(u);
        updateHeader(u); updateFrozenOverlay(u); updateHeader_balance(u);
        renderHomeStats_users(allUsersCache);
        const taskBalanceEl = qs('taskBalanceDisplay');
        if(taskBalanceEl) taskBalanceEl.textContent = `${Math.max(0, Number(u.taskBalance||0)).toLocaleString('ru-RU')} ₽`;
        const casinoBalanceEl = qs('casinoBalanceDisplay');
        if(casinoBalanceEl) casinoBalanceEl.textContent = `${Math.max(0,Number(u.casino?.balance||0)).toLocaleString('ru-RU')} ₽`;
        const casinoMainEl = qs('casinoMainBalanceDisplay');
        if(casinoMainEl) casinoMainEl.textContent = `${Number(u.balance||0).toLocaleString('ru-RU')} ₽`;
        if(curPage==='casino') {
            try{ renderCasinoBalances(u); }catch(e){}
        }
        if(curPage==='tasks') scheduleTaskLiveRefresh();
        if(curPage==='market') renderDebtNotice('marketDebtNotice',u);
        if(curPage==='taxi') renderDebtNotice('taxiDebtNotice',u);
        if(curPage==='subscription' && typeof renderSubscription==='function') renderSubscription();
        if(curPage==='kveExam') renderKveSection(u);
        if(curPage==='jobs') renderKveSection(u);
        const kveBtn=qs('bn11'); if(kveBtn) kveBtn.style.display='flex';
        const kveHomeSub=qs('kveHomeSub');
        if(kveHomeSub){
            if(u.kveScore!==undefined&&u.kveScore!==null){ kveHomeSub.textContent='Ваш балл: '+u.kveScore; const k=qs('kveHomeCard'); if(k) k.style.borderColor='rgba(240,68,74,.6)'; }
            else kveHomeSub.textContent='Результат ещё не получен';
        }
    };
    addServiceListener('core','user',uRef,uFn);
}
function attachNotificationsListener(){
    removeServiceListener('core','notifications');
    if(window._kapaniNotifRetryTimer){ clearTimeout(window._kapaniNotifRetryTimer); window._kapaniNotifRetryTimer=null; }
    const nick=currentNick;
    if(!nick) return;
    // "Seen" ids are tracked per nick: chat_/news_ ids are identical for every
    // recipient, so one shared Set would leak state between accounts.
    if(!window._kapaniSeenNotifs || window._kapaniSeenNotifs.nick!==nick) window._kapaniSeenNotifs={nick,ids:new Set(),baseline:false};
    const state=window._kapaniSeenNotifs;
    let attempt=0;
    const onSnap=(snap)=>{
        if(currentNick!==nick) return;
        attempt=0;
        const notifs=snap.val()||{};
        window._kapaniNotificationsCache=notifs;
        updateBadge(Object.keys(notifs).length);
        // Always render (even while Profile is hidden) so the inbox is ready when opened.
        renderNotifications(notifs);
        if(!state.baseline){
            // First snapshot of this session = history. Never toast/push it.
            Object.keys(notifs).forEach(id=>state.ids.add(id));
            state.baseline=true;
            return;
        }
        const fresh=Object.entries(notifs)
            .filter(([id,n])=>n && !state.ids.has(id))
            .map(([id,n])=>(typeof n==='string'?{text:n,id}:{...n,id}))
            .sort((a,b)=>(Number(a.createdAt)||0)-(Number(b.createdAt)||0));
        fresh.forEach(n=>{
            state.ids.add(n.id);
            try{ announceIncomingNotification(n); }catch(e){ console.warn('[Kapani notifications] announce:',e?.message||e); }
        });
    };
    const bind=()=>{
        if(currentNick!==nick) return;
        addServiceListener('core','notifications',notifRef(nick),onSnap,onErr);
    };
    // The listener is bound immediately. It does NOT wait for the Firebase Auth
    // session: if the database rules do require it, the first attempt fails with
    // permission_denied and we retry after (re)establishing the session, with
    // back-off, instead of silently never binding (the old behaviour).
    const onErr=(err)=>{
        console.warn('[Kapani core/notifications] listener error:',err?.message||err);
        if(currentNick!==nick) return;
        attempt++;
        const delay=Math.min(30000,[800,2500,6000,15000][attempt-1]||30000);
        window._kapaniNotifRetryTimer=setTimeout(async()=>{
            if(currentNick!==nick) return;
            try{ await ensureKapaniServerSessionForCurrentUser(4000); }catch(e){ console.debug('[Kapani notifications] session retry:',e?.message||e); }
            bind();
        },delay);
    };
    bind();
}
// Wake-up hooks: re-bind when the tab returns to foreground / network is back
// and the listener is missing (e.g. cancelled by a permission error earlier).
if(!window._kapaniNotifWakeBound){
    window._kapaniNotifWakeBound=true;
    const wake=()=>{ try{ if(currentNick && appStarted && !serviceListeners.core?.notifications) attachNotificationsListener(); }catch(e){} };
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') wake(); });
    window.addEventListener('online',wake);
}
function attachOrderService(){
    const oRef=ordersRef();
    const oFn=(snap)=>{
        const orders=snap.val()||{};
        renderActiveOrders(orders); renderHomeWorker(orders); renderHomeStats_orders(orders);
        if(curPage==='driverPage'||curPage==='deliveryPage') renderWorkerPage(orders);
        if(curPage==='adminPage') renderAdminOrders(orders);
    };
    addServiceListener('orders','orders',oRef,oFn);
}
function attachChatService(){
    removeServiceListener('messages','chat');
    const cRef=query(chatRef(),orderByChild('createdAt'),limitToLast(80));
    const cFn=(snap)=>{
        const data=snap.val()||{};
        const viewingChat=(curPage==='messages'&&document.querySelector('#msgPanel0.active'));
        lastChatMsgs=data;
        if(viewingChat){
            const b=qs('dmBadge');if(b)b.style.display='none';
            renderChat(lastChatMsgs);
        }
    };
    // One persistent realtime listener for the open chat service.
    // Re-rendering never creates another Firebase listener.
    addServiceListener('messages','chat',cRef,cFn);
    // General-chat typing presence may still be used internally by voice/video flows,
    // but it is intentionally not rendered as a user-facing typing indicator.
    const dmInboxRef=dmIndexRef(currentNick);
    const dmInboxFn=snap=>{
        const index=snap.val()||{};
        dmConvoMeta={};
        Object.entries(index).forEach(([peer,meta])=>{dmConvoMeta[peer]={lastTs:Number(meta?.lastTs||0),latest:meta?.latest||null,unread:!!meta?.unread};});
        if(curPage==='messages'&&document.querySelector('#msgPanel1.active'))renderDmUserList(allUsersCache);
        if(curPage==='messages'&&currentDmNick) renderDmMessages(lastDmMsgs);
    };
    addServiceListener('messages','dmInbox',dmInboxRef,dmInboxFn);
    const rsRef=ref(db,'readState');
    const rsFn=snap=>{chatReadStates={};Object.entries(snap.val()||{}).forEach(([n,o])=>{if(o&&typeof o.chat==='number')chatReadStates[n]=o.chat;});if(curPage==='messages'&&document.querySelector('#msgPanel0.active'))renderChat(lastChatMsgs);};
    addServiceListener('messages','readState',rsRef,rsFn);
}

async function setGeneralChatPresence(active){
    if(!currentNick) return;
    try{
        const p = ref(db, `presence/${currentNick}/generalChatOpen`);
        const dc = onDisconnect(p);
        if(active){
            await dc.set(false);
            await set(p, true);
        }else{
            await dc.cancel();
            await set(p, false);
        }
    }catch(e){ console.warn('[Kapani chat presence]',e); }
}
function enterService(page){
    const service = page==='messages'?'messages':page==='market'?'market':page==='home'?'home':page==='tasks'?'tasks':(['driverPage','deliveryPage'].includes(page)?'orders':page==='adminPage'?'admin':page==='ratings'?'ratings':(['businesses','bizDetail','bizOwnerPanel'].includes(page)?'business':page==='dutyPage'?'duty':null));
    if(!service) return;
    if(service==='home'){
        loadAllUsersCache().then(users=>{ if(curPage==='home') renderHomeStats_users(users); })
            .catch(e=>console.warn('[Kapani] home users cache:',e));
        attachOrderService();
    } else if(service==='orders') attachOrderService();
    if(service==='tasks') startTaskLiveListeners();
    if(service==='messages'){ 
        try{ if(!qs('chatEmojiPanel')) buildEmojiPanels(); }catch(e){}
        setGeneralChatPresence(!!document.querySelector('#msgPanel0.active'));
        loadAllUsersCache().then(()=>{ if(curPage==='messages') renderDmUserList(allUsersCache); }).catch(e=>console.warn('[Kapani] users cache:',e));
        attachChatService();
    }
    if(service==='market'){ const r=marketRef(); addServiceListener('market','market',r,s=>{if(curPage==='market')renderMarket(s.val()||{});}); }
    if(service==='ratings'){ loadAllUsersCache().then(u=>{if(curPage==='ratings')renderLeaderboard(u);}).catch(e=>console.warn('[Kapani] ratings users:',e)); }
    if(service==='admin'){ loadAllUsersCache().then(u=>{if(curPage==='adminPage'){renderAdminUsers(u);renderAdminUserSelect(u);renderUnverifiedAccounts();}}).catch(e=>console.warn('[Kapani] admin users:',e)); const aRef=appsRef(); addServiceListener('admin','apps',aRef,s=>{if(curPage==='adminPage')renderAdminApps(s.val()||{});}); attachOrderService(); }
    if(service==='business'){ const r=bizRef(); addServiceListener('business','businesses',r,s=>{allBusinessesCache=s.val()||{};window.allBusinessesCache=allBusinessesCache;if(curPage==='businesses')renderBusinesses();if(curPage==='bizDetail' && typeof window.renderBizDetail==='function')window.renderBizDetail();if(curPage==='bizOwnerPanel' && typeof window.renderBizOwnerPanel==='function')window.renderBizOwnerPanel();}); }
    if(service==='duty'){ startCallsListener(); }
}
function leaveService(page){
    const mapping={messages:'messages',market:'market',home:'home',tasks:'tasks',driverPage:'orders',deliveryPage:'orders',adminPage:'admin',ratings:'ratings',businesses:'business',bizDetail:'business',bizOwnerPanel:'business',dutyPage:'duty'};
    const service=mapping[page]; if(service) removeAllServiceListeners(service);
    if(page==='messages'){
        setGeneralChatPresence(false);
        if(dmListeners.current){try{off(dmListeners.current.ref,'value',dmListeners.current.fn);}catch(e){} dmListeners.current=null;}
        if(dmListeners.read){try{off(dmListeners.read.ref,'value',dmListeners.read.fn);}catch(e){} dmListeners.read=null;}
        if(dmTypingUnsub){try{dmTypingUnsub();}catch(e){} dmTypingUnsub=null;}
        currentDmNick=null;
    }
    if(page==='tasks') stopTaskLiveListeners();
    if(page==='taxi'){ destroyClientTrackingMap(); _taxiUiKey=''; }
    if(page==='driverPage'){ if(locationWatchId!==null){try{navigator.geolocation.clearWatch(locationWatchId);}catch(e){}locationWatchId=null;} }
    if((page==='bizDetail' || page==='bizOwnerPanel') && listeners.bizOrders){
        try{ off(listeners.bizOrders.ref,'value',listeners.bizOrders.fn); }catch(e){}
        delete listeners.bizOrders;
    }
    if(page==='dutyPage') stopCallsListener();
}
function attachListeners(){
    attachUserListener();
    attachNotificationsListener();
}


// ═══════════════════════════════════════════════════════════════════
// LIVE DATA LAYER
// Keeps balances, the user list and the data behind each page up to date
// without reloads.
//  • Users: `users/<nick>/<field>` LEAF listeners for the hot fields. A listener
//    on the whole `users` node would stream every user's full subtree (txlog,
//    notifications, …) on each heartbeat, so it is deliberately avoided. The
//    user list itself (new/removed accounts, avatars) is re-synced every 3 min.
//  • Pages: while a page is open, its data paths are listened to and the page's
//    existing render function is re-run (debounced, and never while the user is
//    typing inside that page).
//  • Own account: the existing users/<me> listener also refreshes Bank/Jobs/…
//  • Opened profile of another resident: live while the profile is on screen.
// ═══════════════════════════════════════════════════════════════════
const LIVE_USER_FIELDS=['balance','lastSeen','job','displayJob','displayName','subscription','subscriptionExpiry','accountFrozen','accountVerified','taskBalance','savingsBalance','kveScore','fine','employments','totalEarned','nicknameEmoji','avatarFrame'];
const LIVE_USERS_FULL_REFRESH_MS=3*60*1000;
const _liveUserLeafUnsubs=new Map();
let _liveUsersUiTimer=null,_liveUsersPresenceTimer=null,_liveUsersStale=false,_liveUsersLastFull=0,_liveLayerStarted=false;

function isUserEditingIn(sectionId){
    try{
        const a=document.activeElement; if(!a||a===document.body) return false;
        const sec=qs(sectionId); if(!sec||!sec.contains(a)) return false;
        if(a.tagName==='TEXTAREA'||a.tagName==='SELECT') return true;
        if(a.tagName==='INPUT') return !['button','checkbox','radio','submit','file','range'].includes(a.type);
    }catch(_){}
    return false;
}
function syncLiveUserListeners(){
    if(!currentNick||!allUsersCacheLoaded) return;
    const nicks=new Set(Object.keys(allUsersCache||{}));
    for(const [nick,unsubs] of [..._liveUserLeafUnsubs]){
        if(!nicks.has(nick)||nick===currentNick){ unsubs.forEach(u=>{try{u();}catch(_){}}); _liveUserLeafUnsubs.delete(nick); }
    }
    for(const nick of nicks){
        if(nick===currentNick||_liveUserLeafUnsubs.has(nick)) continue;
        const unsubs=LIVE_USER_FIELDS.map(field=>onValue(ref(db,`users/${nick}/${field}`),snap=>{
            const u=allUsersCache&&allUsersCache[nick]; if(!u) return;
            const v=snap.val();
            if(JSON.stringify(u[field])===JSON.stringify(v==null?undefined:v)) return;   // initial event / no change
            if(v==null) delete u[field]; else u[field]=v;
            markLiveUsersDirty(field==='lastSeen');
        },()=>{}));
        _liveUserLeafUnsubs.set(nick,unsubs);
    }
}
function markLiveUsersDirty(presenceOnly){
    if(presenceOnly){
        // lastSeen ticks only affect online dots: refresh at most every 8 s.
        if(_liveUsersPresenceTimer||_liveUsersUiTimer) return;
        _liveUsersPresenceTimer=setTimeout(()=>{_liveUsersPresenceTimer=null;refreshLiveUsersUI();},8000);
        return;
    }
    if(_liveUsersPresenceTimer){ clearTimeout(_liveUsersPresenceTimer); _liveUsersPresenceTimer=null; }
    clearTimeout(_liveUsersUiTimer);
    _liveUsersUiTimer=setTimeout(()=>{_liveUsersUiTimer=null;refreshLiveUsersUI();},350);
}
function refreshLiveUsersUI(){
    if(document.visibilityState!=='visible'){ _liveUsersStale=true; return; }
    if(curPage && isUserEditingIn(curPage)){ setTimeout(()=>markLiveUsersDirty(false),1500); return; }
    const users=allUsersCache||{};
    try{
        renderHomeStats_users(users);
        if(curPage==='ratings') renderLeaderboard(users);
        else if(curPage==='messages'){ if(document.querySelector('#msgPanel1.active')) renderDmUserList(users); }
        else if(curPage==='adminPage'){ renderAdminUsers(users); renderAdminUserSelect(users); renderUnverifiedAccounts(); }
    }catch(e){ console.warn('[Kapani live] users UI refresh:',e?.message||e); }
}
async function refreshUsersStructure(){
    if(document.visibilityState!=='visible'||!currentNick) return;
    try{
        await loadAllUsersCache(true);
        _liveUsersLastFull=Date.now();
        syncLiveUserListeners();
        refreshLiveUsersUI();
    }catch(e){ console.debug('[Kapani live] users structure refresh:',e?.message||e); }
}

// ---- page-scoped live bindings -----------------------------------------
const LIVE_PAGE_BINDINGS={
    news:{q:()=>[newsRef()],render:()=>window.renderNews&&window.renderNews()},
    rentBuildings:{q:()=>[rentBuildingsRef()],render:()=>window.renderRentBuildings&&window.renderRentBuildings()},
    hospital:{q:()=>[ref(db,'hospital')],render:()=>renderHospital()},
    hospitalPanel:{q:()=>[ref(db,'hospital')],render:()=>renderHospitalPanel()},
    deputySession:{q:()=>[deputyProposalsRef()],render:()=>renderDeputyProposals()},
    events:{q:()=>[racesRef(),raceDayGroupsRef()],render:()=>window.renderEventsSection&&window.renderEventsSection()},
    jobs:{q:()=>[appsRef()],render:()=>window.renderJobAppStatus&&window.renderJobAppStatus()},
    taxi:{q:()=>[query(ref(db,'taxiHistory'),orderByChild('client'),equalTo(currentNick))],render:()=>renderTaxiHistory()},
    deliveryOrderPage:{q:()=>[deliveryCustomOrdersRef()],render:()=>renderMyDeliveryOrders()},
    janitorPage:{q:()=>[janitorSubsRef()],render:()=>renderJanitorPage()},
    profile:{q:()=>[wallRef(currentNick)],render:(snap)=>renderWallFeed((snap&&snap.val&&snap.val())||{})}
};
const _livePageState=new Map();
function detachLivePage(page){
    const st=_livePageState.get(page); if(!st) return;
    st.unsubs.forEach(u=>{try{u();}catch(_){}}); clearTimeout(st.timer); _livePageState.delete(page);
}
function attachLivePage(page){
    detachLivePage(page);
    const b=LIVE_PAGE_BINDINGS[page]; if(!b||!currentNick) return;
    const st={unsubs:[],timer:null,snap:null}; _livePageState.set(page,st);
    const run=()=>{
        st.timer=null;
        if(curPage!==page||_livePageState.get(page)!==st) return;
        if(isUserEditingIn(page)){ st.timer=setTimeout(run,1500); return; }   // never clobber typing
        Promise.resolve().then(()=>b.render(st.snap)).catch(e=>console.debug('[Kapani live]',page,e?.message||e));
    };
    let targets=[]; try{ targets=b.q()||[]; }catch(e){ console.debug('[Kapani live] refs',page,e?.message||e); }
    targets.forEach(r=>{
        let initial=true;   // the page's own render already handles the first load
        st.unsubs.push(onValue(r,snap=>{ if(initial){initial=false;return;} st.snap=snap; if(!st.timer) st.timer=setTimeout(run,300); },err=>console.debug('[Kapani live]',page,err?.message||err)));
    });
}

// ---- own account: refresh money-related pages when the numbers change ----
let _liveOwnSig='',_liveOwnTimer=null;
function liveOwnAccountChanged(u){
    if(!u) return;
    const tx=u.txlog||{};
    const sig=JSON.stringify([u.balance,u.savingsBalance,u.taskBalance,u.casino&&u.casino.balance,Object.keys(tx).length,u.subscription,u.subscriptionExpiry,u.accountFrozen,u.accountVerified,u.job,u.fine,u.employments]);
    if(sig===_liveOwnSig) return;
    const first=_liveOwnSig==='';
    _liveOwnSig=sig;
    if(first) return;
    clearTimeout(_liveOwnTimer);
    _liveOwnTimer=setTimeout(()=>{
        if(isUserEditingIn(curPage)) return;
        try{
            if(curPage==='bank'){ renderRecentTransfers(); renderFinancialStats(); renderSavingsDisplay(); }
            else if(curPage==='janitorPage'){ renderJanitorPage(); }
            else if(curPage==='jobs'){ window.renderJobAppStatus&&window.renderJobAppStatus(); }
            else if(curPage==='rentBuildings'){ window.renderRentBuildings&&window.renderRentBuildings(); }
            else if(curPage==='hospital'){ renderHospital(); }
        }catch(e){ console.debug('[Kapani live] own refresh:',e?.message||e); }
    },400);
}

// ---- profile of another resident that is currently on screen ----
let _watchedProfile={nick:null,unsub:null,sig:'',timer:null,initial:true};
function desiredWatchedProfileNick(){
    try{
        const modalOpen=qs('userProfileModal')?.classList.contains('open');
        let n=null;
        if(modalOpen&&typeof viewingProfileNick!=='undefined') n=viewingProfileNick;
        else if(curPage==='visitorProfile') n=window._visitorProfileNick;
        return n&&n!==currentNick?String(n):null;
    }catch(_){ return null; }
}
function profileSig(u){
    if(!u) return '';
    const c={...u}; ['lastSeen','txlog','notifications','pushSubscriptions','pushSettings','notificationTokens'].forEach(k=>delete c[k]);
    return JSON.stringify(c);
}
function syncWatchedProfile(){
    const want=desiredWatchedProfileNick();
    if(want===_watchedProfile.nick) return;
    if(_watchedProfile.unsub){ try{_watchedProfile.unsub();}catch(_){} }
    clearTimeout(_watchedProfile.timer);
    _watchedProfile={nick:want,unsub:null,sig:'',timer:null,initial:true};
    if(!want) return;
    const w=_watchedProfile;
    w.unsub=onValue(userRef(want),snap=>{
        if(!snap.exists()||_watchedProfile!==w) return;
        const u=snap.val(), sig=profileSig(u);
        if(w.initial){ w.initial=false; w.sig=sig; return; }
        if(sig===w.sig) return;   // only lastSeen/txlog moved
        w.sig=sig;
        if(allUsersCache) allUsersCache[want]=u;
        clearTimeout(w.timer);
        w.timer=setTimeout(()=>{
            if(_watchedProfile!==w) return;
            if(qs('userProfileModal')?.classList.contains('open')&&viewingProfileNick===want){
                if(isUserEditingIn('userProfileModal')) return;
                Promise.resolve(window.openUserProfile(want)).catch(()=>{});
            } else if(curPage==='visitorProfile'&&window._visitorProfileNick===want){
                if(isUserEditingIn('visitorProfile')) return;
                Promise.resolve(renderVisitorProfilePage(want)).catch(()=>{});
            }
        },500);
    },()=>{});
}

function startLiveDataLayer(){
    if(_liveLayerStarted||!currentNick) return;
    _liveLayerStarted=true;
    loadAllUsersCache().then(()=>{ _liveUsersLastFull=Date.now(); syncLiveUserListeners(); }).catch(e=>console.debug('[Kapani live] users init:',e?.message||e));
    registerInterval('liveUsersFullRefresh',setInterval(()=>{ if(Date.now()-_liveUsersLastFull>=LIVE_USERS_FULL_REFRESH_MS-1000) refreshUsersStructure(); },30000));
    registerInterval('liveWatchedProfile',setInterval(syncWatchedProfile,1200));
    document.addEventListener('visibilitychange',()=>{
        if(document.visibilityState!=='visible') return;
        if(Date.now()-_liveUsersLastFull>=LIVE_USERS_FULL_REFRESH_MS) refreshUsersStructure();
        else if(_liveUsersStale){ _liveUsersStale=false; refreshLiveUsersUI(); }
    });
    window.addEventListener('online',()=>{ refreshUsersStructure(); });
}

// ─── HEADER ───────────────────────────────
function updateHeader(u) {
    if(!u) return;
    const shown = displayNick(u) || u.nick;
    qs('hNick').textContent=shown; qs('hJob').textContent=getUserBusinessRoleLabel(u, u.nick || currentNick);
    qs('hBal').textContent=(u.balance||0).toLocaleString();
    const av=u.avatar||DEFAULT_AVATAR_URL;
    toggleAvatarMedia(qs('hAv'), qs('hAvVideo'), av);
    
    // Check subscription status first
    const expiry = u.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    const isActive = expiry && expiry > new Date();
    
    // Apply interface theme if user has subscription
    if(isActive && u.interfaceTheme && u.interfaceTheme !== 'default') {
        applyInterfaceTheme(u.interfaceTheme);
    } else {
        // Reset to default theme if no subscription or no theme set
        applyInterfaceTheme('default');
    }
    // Apply avatar frame in header using the same centralized frame mapping.
    const headerAvatarWrap = qs('headerAvatarWrap');
    if(headerAvatarWrap){
        const existingFrame = headerAvatarWrap.querySelector('.avatar-frame');
        if(existingFrame) existingFrame.remove();
        const frameClass = getAvatarFrameClass(u);
        if(frameClass){
            const frameEl = document.createElement('div');
            frameEl.className = `avatar-frame ${frameClass}`;
            frameEl.style.cssText = 'position:absolute;inset:-2px;border-radius:inherit;pointer-events:none;z-index:1;';
            headerAvatarWrap.appendChild(frameEl);
        }
    }

    // Check if avatar is video (only for Ultra)
    const isVideoAvatar = av && (av.endsWith('.mp4') || av.endsWith('.webm') || av.includes('video'));
    const hasUltra = (u.subscription === 'ultra') && isActive;
    
    if(isVideoAvatar && hasUltra){
        const videoEl = qs('uAvVideo');
        const imgEl = qs('uAv');
        if(videoEl){ videoEl.src = av; videoEl.style.display = 'block'; }
        if(imgEl) imgEl.style.display = 'none';
    } else {
        const videoEl = qs('uAvVideo');
        const imgEl = qs('uAv');
        if(videoEl) videoEl.style.display = 'none';
        if(imgEl){ imgEl.src = av; imgEl.style.display = 'block'; }
    }
    
    qs('uNick').textContent=shown;
    qs('uJobDisp').textContent=getUserBusinessRoleLabel(u, u.nick || currentNick);
    const emps = collectEmploymentsFromData(u, u.nick || currentNick);
    const jtw = qs('jobTitleSelectWrap');
    const jts = qs('jobTitleSelect');
    if(jtw && jts){
        if(emps.length > 1){
            jtw.style.display = 'block';
            jts.innerHTML = emps.map(e => `<option value="${escHtml(e.role)}" ${u.displayJob===e.role?'selected':''}>${escHtml(e.role)}</option>`).join('');
        } else {
            jtw.style.display = 'none';
        }
    }
    
    // Profile description
    const descEl = qs('profileDescription');
    if(descEl) {
        if(u.profileDescription && u.profileDescription.trim()) {
            descEl.textContent = u.profileDescription.trim();
            descEl.style.display = 'block';
        } else {
            descEl.style.display = 'none';
        }
    }
    
    // Subscription badge
    const subBadge = qs('subscriptionBadge');
    const profileCust = qs('profileCustomization');
    if(subBadge){
        if(u.subscription === 'plus' && isActive){
            subBadge.innerHTML = '<span class="sub-badge-plus">⭐ Kapani Plus</span>';
            subBadge.style.display = 'block';
            if(profileCust) profileCust.style.display = 'block';
        } else if(u.subscription === 'ultra' && isActive){
            subBadge.innerHTML = '<span class="sub-badge-ultra">💎 Kapani Ultra</span>';
            subBadge.style.display = 'block';
            if(profileCust) profileCust.style.display = 'block';
        } else if(u.subscription === 'prime' && isActive){
            subBadge.innerHTML = '<span class="sub-badge-prime">👑 <span class="text-rainbow-prime">Kapani Prime</span></span>';
            subBadge.style.display = 'block';
            if(profileCust) profileCust.style.display = 'block';
        } else {
            subBadge.style.display = 'none';
            if(profileCust) profileCust.style.display = 'none';
        }
    }
    
    // Avatar frame + profile background use the same mappings everywhere.
    const frameEl = qs('avatarFrame');
    if(frameEl){
        frameEl.className = 'avatar-frame';
        const frameClass = getAvatarFrameClass(u);
        frameEl.style.display = frameClass ? 'block' : 'none';
        if(frameClass) frameEl.classList.add(frameClass);
    }

    const headerBg = qs('profileHeaderBg');
    const bgEffect = qs('profileBgEffect');
    if(headerBg && bgEffect){
        headerBg.classList.remove(...PROFILE_EFFECT_CLASSES);
        const bgClass = getProfileBgClass(u);
        if(bgClass) headerBg.classList.add(bgClass);
        applyPrimeCoverToElement(headerBg, bgClass === 'profile-bg-custom' ? 'custom' : '', u.profileCustomBg);
    }

    updateFrozenOverlay(u);
    const isAdmin=currentNick===ADMIN, isDriver=hasMunicipalJob(u,'Водитель'), isDelivery=hasMunicipalJob(u,'Доставщик'), isJanitor=hasMunicipalJob(u,JOB_JANITOR);
    qs('adminQuickBtn').style.display=isAdmin?'block':'none';
    const mayorHeaderBtn=qs('mayorHeaderBtn'); if(mayorHeaderBtn) mayorHeaderBtn.style.display=isAdmin?'inline-flex':'none';
    qs('workerSection').style.display=(isDriver||isDelivery||isJanitor)?'block':'none';
    if(isDriver) qs('workerTitle').textContent='🛵 Вызовы такси';
    if(isDelivery) qs('workerTitle').textContent='📦 Заказы на доставку';
    if(isJanitor){ const wt=qs('workerTitle'); if(wt) wt.textContent='🧹 Уборка площадки'; }
    const vBtn=qs('vehicleBtn'); if(vBtn) vBtn.style.display=(isDriver||isDelivery)?'inline-block':'none';
    // Всегда показываем кнопку Профиль (bn7)
    const profBtn=qs('bn7'); if(profBtn) profBtn.style.display='flex';
    // Кнопка уборщика — bn8, показываем только для уборщиков
    const janBtn=qs('bn8'); if(janBtn) janBtn.style.display=isJanitor?'flex':'none';
    // nav layout handled by flex
    const vDisp=qs('vehicleDisplay');
    if(vDisp){if(u.vehicle){vDisp.style.display='block';vDisp.textContent='🛵 '+u.vehicle;}else vDisp.style.display='none';}
    const quitBtn=qs('quitJobBtn'); if(quitBtn) quitBtn.style.display=collectEmploymentsFromData(u, u.nick||currentNick).length?'block':'none';
    if(isDriver){ const vehicleInput=qs('vehicleInput'); if(vehicleInput && document.activeElement!==vehicleInput) vehicleInput.value=u.vehicle||''; }
    // Кнопка заседания — только для депутатов
    const depBtn=qs('deputySessionQuickBtn'); if(depBtn) depBtn.style.display=hasMunicipalJob(u,'Депутат')?'block':'none';
    // Блок КСБ-штрафов
    const ksbFineSection=qs('ksbFineSection'); if(ksbFineSection) ksbFineSection.style.display=(hasMunicipalJob(u,'КСБ')||hasMunicipalJob(u,'Полицейский'))?'block':'none';
    // Кнопка панели КСБ/Полиции на главной
    const isDuty = hasMunicipalJob(u,'КСБ')||hasMunicipalJob(u,'Полицейский')||u.job==='КСБ'||u.job==='Полицейский'||currentNick===ADMIN;
    window._isDutyOfficer = isDuty;
    const dutyBtn=qs('dutyQuickBtn'); if(dutyBtn) dutyBtn.style.display=isDuty?'block':'none';
    // Кнопка панели больницы — только для врача
    const hospBtn=qs('hospitalQuickBtn'); if(hospBtn) hospBtn.style.display=(hasMunicipalJob(u,'Врач')||hasMunicipalJob(u,'Помощник врача'))?'block':'none';
}

// ─── ВЫЗОВЫ (КСБ / Полиция) ───────────────
let _callsListenerStarted = false;
let _lastCalls = {};
let _callsSeen = false;
function startCallsListener(){
    if(_callsListenerStarted) return;
    _callsListenerStarted = true;
    const cRef = ref(db,'calls');
    const cb = (snap)=>{
        const data = snap.val() || {};
        // Найти новые активные вызовы (по сравнению с прошлым снимком)
        if(_callsSeen){
            Object.entries(data).forEach(([id, c])=>{
                if(!c || c.status==='closed') return;
                if(!_lastCalls[id] && c.from !== currentNick){
                    toast(`📞 Новый вызов: ${escHtml(c.name||'?')} — ${escHtml((c.desc||'').slice(0,40))}`, 'red');
                    try{ if(window._iosAudioCtx){} }catch(e){}
                }
            });
        }
        _lastCalls = data;
        _callsSeen = true;
        const active = Object.entries(data).filter(([,c])=>c && c.status!=='closed');
        const badge = qs('dutyCallsBadge');
        if(badge){ badge.textContent = active.length>0?active.length:''; badge.style.display = active.length>0?'inline-block':'none'; }
        if(curPage==='dutyPage') renderDutyCalls(data);
    };
    addServiceListener('duty','calls',cRef,cb);
}
function renderDutyCalls(data){
    const host = qs('dutyCalls'); if(!host) return;
    data = data || _lastCalls || {};
    const active = Object.entries(data)
        .filter(([,c])=>c && c.status!=='closed')
        .sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
    if(!active.length){ host.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет активных вызовов</div>'; return; }
    host.innerHTML = active.map(([id,c])=>`
        <div style="border:1px solid rgba(248,113,113,.3);background:rgba(248,113,113,.06);border-radius:14px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div style="font-weight:900;font-size:14px;color:var(--red);">📞 ${escHtml(c.name||'Без имени')}</div>
                <div style="font-size:11px;color:var(--muted);">${escHtml(c.time||'')}</div>
            </div>
            <div style="font-size:13px;margin-bottom:4px;"><b>📍 Адрес:</b> ${escHtml(c.address||'—')}</div>
            <div style="font-size:13px;margin-bottom:8px;white-space:pre-wrap;"><b>📝</b> ${escHtml(c.desc||'')}</div>
            ${c.photo?`<img loading="lazy" decoding="async" src="${escHtml(c.photo)}" onclick="openImgViewer('${jsEsc(c.photo)}')" style="width:100%;border-radius:12px;margin-bottom:8px;max-height:240px;object-fit:cover;cursor:pointer;">`:''}
            <button class="btn btn-primary btn-sm" onclick="closeDutyCall('${jsEsc(id)}')">✅ Закрыть вызов</button>
        </div>
    `).join('');
}
window.closeDutyCall = async function(id){
    try{ await update(ref(db,`calls/${id}`), { status:'closed', closedBy: currentNick, closedAt: Date.now() }); toast('✅ Вызов закрыт','green'); }
    catch(e){ toast('❌ Ошибка','red'); }
};
function updateHeader_balance(u){
    if(!u) return;
    const balance=Number(u.balance||0);
    const balEl=qs('hBal'); if(balEl) balEl.textContent=balance.toLocaleString();
    _myBalance=balance;
    renderHomeStats();
    if(curPage==='bank')renderSavingsDisplay();
}

window.goToWorkerPage=function(){get(userRef(currentNick)).then(snap=>{if(!snap.exists())return;const u=snap.val();if(hasMunicipalJob(u,'Водитель'))navTo('driverPage');else if(hasMunicipalJob(u,'Доставщик'))navTo('deliveryPage');else if(hasMunicipalJob(u,JOB_JANITOR))navTo('janitorPage');});};
function updateBadge(count){const badge=qs('notifyBadge');badge.textContent=count>0?(count>9?'9+':count):'';badge.style.display=count>0?'block':'none';}
function stopCallsListener(){
    if(!_callsListenerStarted) return;
    const item=serviceListeners.duty?.calls;
    if(item){ try{off(item.ref,'value',item.fn);}catch(e){} }
    removeAllServiceListeners('duty');
    _callsListenerStarted=false; _callsSeen=false; _lastCalls={};
}


// ─── HOME STATS ───────────────────────────
let _usersCount=0,_ordersCount=0,_myBalance=0;
function isHomeStatsActiveOrder(o){
    if(!o || !o.status) return false;
    const status=String(o.status);
    return o.type==='taxi' ? TAXI_ACTIVE_STATUSES.has(status)
        : ['waiting','in_progress'].includes(status);
}
function renderHomeStats_users(users){
    const source=users||allUsersCache||{};
    _usersCount=Object.keys(source).length;
    const me=source[currentNick];
    if(me) _myBalance=Number(me.balance||0);
    renderHomeStats();
}
function renderHomeStats_orders(orders){
    _ordersCount=Object.values(orders||{}).reduce((count,o)=>count+(isHomeStatsActiveOrder(o)?1:0),0);
    renderHomeStats();
}
function renderHomeStats_balance(user){
    if(user) _myBalance=Number(user.balance||0);
    renderHomeStats();
}
function renderHomeStats(){
    const host=qs('homeStats'); if(!host) return;
    host.innerHTML=`<div class="stat-box"><div class="sv">${Number(_myBalance||0).toLocaleString()}</div><div class="sl">₽ Баланс</div></div><div class="stat-box"><div class="sv">${_usersCount}</div><div class="sl">Жителей</div></div><div class="stat-box"><div class="sv">${_ordersCount}</div><div class="sl">Заказов</div></div>`;
}

// ─── PUSH NOTIFICATIONS ───────────────────
function getPushPrefs(){try{return JSON.parse(localStorage.getItem('kp_push')||'{}');}catch(e){return{};}}
function isPushOn(){const p=getPushPrefs();return p.enabled!==false;}
function isPushCatEnabled(cat){if(!isPushOn())return false;const p=getPushPrefs();return p[cat]!==false;}
let _swReg=null;
function isIOSDevice(){const ua=navigator.userAgent||'';return /iP(hone|od|ad)/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);}
function isIOSPWA(){return navigator.standalone===true||window.matchMedia('(display-mode: standalone)').matches;}
function base64UrlToUint8Array(base64String){const padding='='.repeat((4-(base64String.length%4))%4);const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base64);return Uint8Array.from([...raw].map(ch=>ch.charCodeAt(0)));}
async function getSwReg(){
    if(_swReg)return _swReg;
    const isLocalDev=location.hostname==='localhost'||location.hostname==='127.0.0.1'||location.hostname==='[::1]';
    if(location.protocol!=='https:'&&!isLocalDev){window._kapaniPushState={...(window._kapaniPushState||{}),status:'https_required',error:'service_worker_requires_https'};return null;}
    if(!('serviceWorker' in navigator)){window._kapaniPushState={...(window._kapaniPushState||{}),status:'unsupported',error:'service_worker_unsupported'};return null;}
    try{const swUrl=new URL('./firebase-messaging-sw.js',location.href);const scope=new URL('./',location.href).pathname;_swReg=await navigator.serviceWorker.register(swUrl.href,{scope});await navigator.serviceWorker.ready;window._kapaniPushState={...(window._kapaniPushState||{}),serviceWorkerRegistered:true,serviceWorkerScope:_swReg.scope};return _swReg;}
    catch(err){window._kapaniPushState={...(window._kapaniPushState||{}),status:'sw_failed',error:String(err?.message||err)};console.error('[Kapani Push] Service Worker registration failed:',err);return null;}
}
async function requestNotificationPermission(){
    if(!('Notification' in window))return 'unsupported';
    if(Notification.permission==='granted')return 'granted';
    if(Notification.permission==='denied')return 'denied';
    try{return await Notification.requestPermission();}catch(e){return await new Promise(resolve=>{try{Notification.requestPermission(resolve);}catch(_){resolve('denied');}});}
}
async function getWebPushSubscription(createIfMissing=false){
    const reg=await getSwReg();if(!reg?.pushManager)return null;let subscription=await reg.pushManager.getSubscription();
    // A subscription created with a different VAPID key (e.g. after switching the push backend)
    // can never receive our pushes and makes subscribe() throw: drop it and create a fresh one.
    if(subscription&&WEB_PUSH_VAPID_PUBLIC_KEY){
        try{
            const cur=subscription.options?.applicationServerKey;
            if(cur){
                const want=base64UrlToUint8Array(WEB_PUSH_VAPID_PUBLIC_KEY),have=new Uint8Array(cur);
                const same=want.length===have.length&&want.every((b,i)=>b===have[i]);
                if(!same){ await subscription.unsubscribe(); subscription=null; }
            }
        }catch(e){ console.debug('[Kapani Push] key check:',e?.message||e); }
    }
    if(!subscription&&createIfMissing){if(!WEB_PUSH_VAPID_PUBLIC_KEY)throw new Error('VAPID public key is not configured');subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64UrlToUint8Array(WEB_PUSH_VAPID_PUBLIC_KEY)});}return subscription;
}
async function getWebPushSubscriptionPayload(subscription){
    const json=subscription?.toJSON?.();if(!json)return null;
    // The VAPID key this subscription was REALLY created with (falls back to the configured one): the worker refuses a
    // device whose key differs from its own, instead of storing a device it can never push to.
    let asKey='';
    try{const k=subscription.options?.applicationServerKey;if(k)asKey=btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}catch(_){}
    return {endpoint:String(json.endpoint||''),expirationTime:json.expirationTime??null,keys:{p256dh:String(json.keys?.p256dh||''),auth:String(json.keys?.auth||'')},applicationServerKey:asKey||String(WEB_PUSH_VAPID_PUBLIC_KEY||'')};
}
async function hashWebPushEndpoint(endpoint){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(endpoint||'')));return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);}
// ─── Cloudflare push worker client ────────────────────────────────
// Identity is the site's own (nick + passwordHash stored in RTDB), the same trust level as the login itself.
async function getPushAuthHash(){
    const {data:{session}}=await supabase.auth.getSession();
    return session?.access_token?'supabase-session':'';
}
async function pushWorkerCall(path,body){
    const {data:{session}}=await supabase.auth.getSession();
    if(!session?.access_token) throw new Error('Сессия Supabase истекла. Войдите заново.');
    const res=await fetch(PUSH_WORKER_URL+path,{method:'POST',headers:{
        'content-type':'application/json','apikey':CONFIG.supabase.anonKey,
        'authorization':`Bearer ${session.access_token}`
    },body:JSON.stringify(body)});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data?.error||data?.detail||('push worker HTTP '+res.status));
    return data;
}
// Wake the worker for a job. The worker returns `next` when it had to split a big fan-out; keep going.
async function kickPushWorker(jobId,inline){
    for(let i=0;i<15&&(jobId||inline);i++){
        let res=null;
        try{
            res=await pushWorkerCall('/event',inline?{nick:currentNick,ph:await getPushAuthHash(),job:inline}:{jobId});
        }catch(e){ console.debug('[Kapani push worker] event:',e?.message||e); return; }
        inline=null; jobId=res?.next||null;
    }
}
// Durable path: write the job to RTDB (cron will pick it up if this call is lost), then wake the worker.
// If the browser may not write the outbox, fall back to an authenticated inline job.
async function enqueuePushJob(job){
    if(!PUSH_WORKER_URL||!currentNick) return;
    void kickPushWorker('',job);
}
window.getKapaniPushWorkerHealth=async function(){
    if(!PUSH_WORKER_URL) return {configured:false,message:'config.js: pushWorkerUrl is empty — Cloudflare Web Push backend is not configured'};
    const res=await fetch(PUSH_WORKER_URL+'/health',{headers:{apikey:CONFIG.supabase.anonKey}}); return {configured:true,url:PUSH_WORKER_URL,...(await res.json())};
};
// ─── Push diagnostics (run in the browser console) ──────────────────
//   await kapaniPushDoctor()            — checks THIS account/device
//   await kapaniPushDoctor('ник')       — also explains why 'ник' has no push device
//   await kapaniPushSelfTest()          — sends a real push to your own devices and shows push-service statuses
window.kapaniPushDoctor=async function(target){
    const out={site:{build:KAPANI_BUILD,worker:PUSH_WORKER_URL||null,me:currentNick,permission:('Notification' in window)?Notification.permission:'unsupported',configVapidPrefix:String(WEB_PUSH_VAPID_PUBLIC_KEY||'').slice(0,16)}};
    let browserId=null;
    try{
        const sub=await getWebPushSubscription(false);
        if(sub){browserId=await hashWebPushEndpoint(sub.endpoint);out.browser={subscriptionId:browserId,host:new URL(sub.endpoint).host};}
        else out.browser='нет подписки в этом браузере';
    }catch(e){out.browser='ошибка: '+(e?.message||e);}
    try{out.worker=await window.getKapaniPushWorkerHealth();}catch(e){out.worker='Worker недоступен: '+(e?.message||e);}
    try{const ph=await getPushAuthHash();out.debug=await pushWorkerCall('/debug',{nick:currentNick,ph,target:target||currentNick});}catch(e){out.debug='ошибка /debug: '+(e?.message||e);}
    const verdict=[];
    if(out.site.permission!=='granted')verdict.push('❌ Браузер не разрешил уведомления (permission='+out.site.permission+')');
    if(typeof out.browser==='string')verdict.push('❌ В этом браузере нет push-подписки — нажмите «Включить» в профиле');
    if(out.worker&&out.worker.vapidPublicPrefix&&out.worker.vapidPublicPrefix!==out.site.configVapidPrefix)verdict.push('❌ Ключ VAPID в config.js и в Worker РАЗНЫЙ — сделайте одинаковыми и заново нажмите «Включить»');
    if(out.worker&&out.worker.vapid&&!out.worker.vapid.pairOk)verdict.push('❌ Ключи VAPID в Worker: '+(out.worker.vapid.error||'не удалось проверить пару ключей'));
    if(out.debug&&typeof out.debug==='object'){
        if(browserId&&!(out.debug.yourDevices||[]).some(d=>d.id===browserId))verdict.push('❌ Это устройство не записано в Worker под ником «'+currentNick+'» — нажмите «Включить» ещё раз');
        if(out.debug.diagnosis?.hint)verdict.push('ℹ️ '+out.debug.diagnosis.hint);
    }
    if(!verdict.length)verdict.push('✅ Всё выглядит правильно');
    out.verdict=verdict;
    console.log(verdict.join('\n'));console.log(out);
    return out;
};
window.kapaniPushSelfTest=async function(){
    const ph=await getPushAuthHash();
    const r=await pushWorkerCall('/test',{nick:currentNick,ph,category:'system'});
    console.log(r);return r;
};
// ─── Push status line + one-tap repair (for people who cannot open the console) ───
function pushErrorText(e){
    const m=String(e?.message||e||'');
    if(/unauthorized/i.test(m)) return 'Worker не принял ваш пароль-хэш: выйдите из аккаунта и войдите снова';
    if(/vapid key mismatch/i.test(m)) return 'Ключ VAPID на сайте (config.js) и в Worker (wrangler.toml) РАЗНЫЙ. Сделайте одинаковыми: обновите config.js на GitHub Pages или задеплойте Worker';
    if(/bad subscription/i.test(m)) return 'Push-сервис этого браузера не поддерживается Worker («bad subscription»)';
    if(/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Не удалось связаться с Worker (проверьте pushWorkerUrl в config.js и интернет)';
    if(/хэш пароля/i.test(m)) return m;
    return m||'неизвестная ошибка';
}
async function refreshPushWorkerStatus(){
    const el=qs('pushWorkerStatus'); if(!el) return;
    if(!PUSH_WORKER_URL){ el.textContent='Сборка '+KAPANI_BUILD+' · Cloudflare Worker не настроен (pushWorkerUrl пуст)'; return; }
    const lines=['Сборка '+KAPANI_BUILD];
    const perm=('Notification' in window)?Notification.permission:'unsupported';
    lines.push('Разрешение браузера: '+perm);
    let browserId=null;
    try{ const sub=await getWebPushSubscription(false); if(sub){ browserId=await hashWebPushEndpoint(sub.endpoint); lines.push('Подписка в браузере: есть ('+new URL(sub.endpoint).host+')'); } else lines.push('Подписка в браузере: нет'); }catch(e){ lines.push('Подписка в браузере: ошибка '+pushErrorText(e)); }
    try{
        const ph=await getPushAuthHash();
        if(!ph) lines.push('В Worker: ❌ не найден хэш пароля (выйдите и войдите снова)');
        else{
            const d=await pushWorkerCall('/debug',{nick:currentNick,ph,target:currentNick});
            const ok=browserId&&(d.yourDevices||[]).some(x=>x.id===browserId);
            lines.push(ok?'В Worker: ✅ это устройство зарегистрировано':'В Worker: ❌ это устройство НЕ зарегистрировано — нажмите «Переподключить»');
        }
    }catch(e){ lines.push('В Worker: ❌ '+pushErrorText(e)); }
    let last=''; try{ last=localStorage.getItem('kp_push_last_error')||''; }catch(_){}
    if(last) lines.push('Последняя ошибка: '+last);
    el.textContent=lines.join('\n');
}
window.kapaniPushRepair=async function(){
    try{
        if(!('Notification' in window)) throw new Error('Браузер не поддерживает уведомления');
        if(isIOSDevice()&&!isIOSPWA()) throw new Error('На iPhone откройте сайт с иконки «На экран Домой»');
        if(Notification.permission==='denied') throw new Error('Уведомления заблокированы: значок замка рядом с адресом сайта → Уведомления → Разрешить');
        toast('🔄 Подключаю push…','gold');
        if(Notification.permission!=='granted'){ const r=await requestNotificationPermission(); if(r!=='granted') throw new Error('Разрешение на уведомления не выдано'); }
        const p=getPushPrefs(); p.enabled=true; savePushPrefs(p);
        await getSwReg();
        await registerWebPushSubscription();
        try{ localStorage.setItem('kp_push_reg',JSON.stringify({stamp:`${currentNick}|${PUSH_WORKER_URL||'cloudflare'}|${String(WEB_PUSH_VAPID_PUBLIC_KEY||'').slice(0,16)}`,at:Date.now(),subId:window._kapaniWebPushSubscriptionId||''})); localStorage.removeItem('kp_push_last_error'); }catch(_){}
        toast('✅ Push подключён на этом устройстве','green');
    }catch(e){
        const msg=pushErrorText(e);
        try{ localStorage.setItem('kp_push_last_error',msg.slice(0,200)); }catch(_){}
        toast('❌ '+msg,'red');
    }
    void refreshPushWorkerStatus();
    try{ updatePushSettingsUI(); }catch(_){}
};
// Rollout helper for the admin: who has / hasn't registered a device with the worker.   await kapaniPushAccounts()
window.kapaniPushAccounts=async function(){
    const ph=await getPushAuthHash();
    const d=await pushWorkerCall('/debug',{nick:currentNick,ph,target:currentNick});
    const have=d.accountsWithPush||{};
    const all=Object.keys(allUsersCache||{});
    const rows=all.map(n=>({аккаунт:n,устройств:have[n]||0})).sort((a,b)=>a.устройств-b.устройств||a.аккаунт.localeCompare(b.аккаунт));
    console.table(rows);
    return {registered:rows.filter(r=>r.устройств>0).length,notRegistered:rows.filter(r=>!r.устройств).map(r=>r.аккаунт)};
};
async function registerWebPushSubscription(){
    if(!currentNick)throw new Error('Пользователь не определён');
    const sub=await getWebPushSubscription(true);const payload=await getWebPushSubscriptionPayload(sub);if(!payload?.endpoint||!payload.keys.p256dh||!payload.keys.auth)throw new Error('Push Subscription is incomplete');
    const subscriptionId=await hashWebPushEndpoint(payload.endpoint);
    let savedId=subscriptionId;
    if(!PUSH_WORKER_URL)throw new Error('Cloudflare push worker is not configured');
    {
        const ph=await getPushAuthHash();if(!ph)throw new Error('Не найден хэш пароля для регистрации push');
        const result=await pushWorkerCall('/subscribe',{nick:currentNick,ph,subscription:payload,prefs:getPushPrefs(),userAgent:navigator.userAgent});
        savedId=String(result?.subscriptionId||subscriptionId);
    }
    window._kapaniWebPushSubscriptionId=savedId;try{localStorage.setItem('kp_webpush_subscription_id',window._kapaniWebPushSubscriptionId);}catch(e){}
    window._kapaniPushState={...(window._kapaniPushState||{}),status:'registered',backend:PUSH_WORKER_URL?'cloudflare-webpush':null,pushSupported:true,pushSubscriptionExists:true,subscriptionId:window._kapaniWebPushSubscriptionId,subscriptionSaved:true,vapidConfigured:!!WEB_PUSH_VAPID_PUBLIC_KEY,lastGoodRegistrationAt:Date.now(),error:null};return sub;
}
async function unregisterWebPushSubscription(){
    let sub=null;try{sub=await getWebPushSubscription(false);}catch(_){}
    let id=window._kapaniWebPushSubscriptionId;try{id=id||localStorage.getItem('kp_webpush_subscription_id')||'';}catch(_){id=id||'';}
    if(!id&&sub?.endpoint)id=await hashWebPushEndpoint(sub.endpoint);
    if(id){
        try{
            if(PUSH_WORKER_URL){ const ph=await getPushAuthHash(); if(ph) await pushWorkerCall('/unsubscribe',{nick:currentNick,ph,subscriptionId:id}); }
        }catch(e){console.debug('[Kapani Push] unregister subscription failed:',e);}
    }
    window._kapaniWebPushSubscriptionId=null;try{localStorage.removeItem('kp_webpush_subscription_id');localStorage.removeItem('kp_push_reg');}catch(e){}
}
async function syncPushPrefs(){
    if(!currentNick)return;let id=window._kapaniWebPushSubscriptionId;try{id=id||localStorage.getItem('kp_webpush_subscription_id')||'';}catch(_){id=id||'';}if(!id)return;
    try{
        if(PUSH_WORKER_URL){ const ph=await getPushAuthHash(); if(ph) await pushWorkerCall('/prefs',{nick:currentNick,ph,subscriptionId:id,prefs:getPushPrefs()}); }
    }catch(e){console.warn('[Kapani Push prefs]',e);}
}
function savePushPrefs(p){try{localStorage.setItem('kp_push',JSON.stringify(p));}catch(e){}void syncPushPrefs();}
async function requestPushPermission(){
    if(!('Notification' in window))return false;
    if(isIOSDevice()&&!isIOSPWA()){toast('📲 Для уведомлений добавьте сайт на экран «Домой» в Safari, затем откройте его как приложение','gold');return false;}
    if(Notification.permission==='denied')return false;const result=await requestNotificationPermission();if(result!=='granted')return false;
    try{await getSwReg();await registerWebPushSubscription();const p=getPushPrefs();p.enabled=true;savePushPrefs(p);toast('🔔 Push-уведомления включены!','green');return true;}catch(e){window._kapaniPushState={...(window._kapaniPushState||{}),status:'error',error:String(e?.message||e)};console.error('[Kapani Push] registration failed:',e);toast('⚠️ Разрешение получено, но Push не зарегистрировался. Проверьте профиль и backend.','gold');return false;}
}
async function ensureWebPushOnStartup(){
    if(!currentNick||!('Notification' in window)||Notification.permission!=='granted')return false;
    if(!isPushOn())return false;
    try{
        // Permission is already granted, so subscribing needs no prompt and nobody has to "re-enable" anything.
        // The old code returned early when the browser had no subscription — but a subscription made with a
        // DIFFERENT VAPID key (or by the old Firebase path) is dropped by getWebPushSubscription(false) below,
        // so those devices were never registered with the push worker.
        const stamp=`${currentNick}|${PUSH_WORKER_URL||'cloudflare'}|${String(WEB_PUSH_VAPID_PUBLIC_KEY||'').slice(0,16)}`;
        let last=null;try{last=JSON.parse(localStorage.getItem('kp_push_reg')||'null');}catch(_){}
        const existing=await getWebPushSubscription(false);
        // The "registered recently" shortcut also requires the saved subscription id: logout removes it (and unregisters the device
        // from the worker), so logging out and back in as the same account always registers the device again.
        let savedId='';try{savedId=localStorage.getItem('kp_webpush_subscription_id')||'';}catch(_){}
        if(existing&&last&&last.stamp===stamp&&savedId&&savedId===last.subId&&Date.now()-Number(last.at||0)<12*3600e3&&last.subId===await hashWebPushEndpoint(existing.endpoint))return true;   // registered recently
        await registerWebPushSubscription();
        try{localStorage.setItem('kp_push_reg',JSON.stringify({stamp,at:Date.now(),subId:window._kapaniWebPushSubscriptionId||''}));}catch(_){}
        return true;
    }catch(e){console.warn('[Kapani Push] startup registration failed:',e?.message||e);try{localStorage.setItem('kp_push_last_error',String(e?.message||e).slice(0,200));}catch(_){}return false;}
}

async function showForegroundKapaniPush(payload={}){
    // System (OS-level) notification while the site is open. Uses the same
    // Service Worker display path as closed-tab Web Push; the shared tag
    // (kapani-<notificationId>) guarantees a later server push for the same
    // notification replaces this one instead of stacking a duplicate.
    try{
        if(!currentNick || !('Notification' in window) || Notification.permission!=='granted') return false;
        const category=String(payload.category||payload.cat||'system');
        if(!isPushCatEnabled(category)) return false;
        const body=String(payload.body||payload.text||'').trim();
        if(!body) return false;
        const data={
            title:String(payload.title||'Капани'),
            body,
            category,
            notificationId:String(payload.notificationId||''),
            url:String(payload.url||''),
            source:String(payload.source||'foreground')
        };
        let reg=null;
        try{ reg=await getSwReg(); }catch(_){}
        const sw=reg?.active || navigator.serviceWorker?.controller;
        if(sw){ sw.postMessage({type:'KAPANI_FOREGROUND_PUSH',payload:data}); return true; }
        const icon=new URL('./image.png',location.href).href;
        const tag=data.notificationId?`kapani-${data.notificationId}`:`kapani-${category}-${Date.now()}`;
        if(reg?.showNotification){
            await reg.showNotification(data.title,{body,icon,badge:icon,tag,data:{...data,category}});
            return true;
        }
        const n=new Notification(data.title,{body,icon,tag});
        n.onclick=()=>{ try{window.focus();n.close();}catch(_){} };
        return true;
    }catch(e){
        console.debug('[Kapani Push] foreground notification failed:',e?.message||e);
        return false;
    }
}
function formatNotifTime(n){
    const ts=Number(n?.createdAt)||0;
    if(ts>0){
        try{
            const d=new Date(ts), now=new Date();
            const hm=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
            if(d.toDateString()===now.toDateString()) return hm;
            return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+hm;
        }catch(_){}
    }
    return String(n?.time||'');
}
// True when the user is already looking at the conversation the notification is about.
function isNotificationContextOpen(n){
    try{
        if(document.visibilityState!=='visible' || curPage!=='messages') return false;
        if(n.source==='general_chat') return !!document.querySelector('#msgPanel0.active');
        if(n.source==='dm' && n.from) return currentDmNick===n.from;
    }catch(_){}
    return false;
}
// Single entry point for every notification that arrives while the site is open:
// in-app banner + OS-level push (when permission is granted and the category is on).
function announceIncomingNotification(n){
    const text=String(n?.text||'').trim();
    if(!text) return;
    if(isNotificationContextOpen(n)) return;
    if(curPage!=='profile') showNotifPopup(text,formatNotifTime(n));
    void showForegroundKapaniPush({
        title:n.title,
        body:text,
        category:n.cat,
        notificationId:n.id,
        url:n.url,
        source:'inbox'
    });
}
if(!window._kapaniPushSwMessageBound&&'serviceWorker' in navigator){window._kapaniPushSwMessageBound=true;navigator.serviceWorker.addEventListener('message',event=>{
    const type=event?.data?.type;
    if(type==='KAPANI_PUSHSUBSCRIPTION_CHANGED'&&currentNick)registerWebPushSubscription().catch(e=>console.debug('[Kapani Push] subscription change:',e));
    // Notification click while the site is already open: navigate in-app, no page reload.
    if(type==='KAPANI_NOTIFICATION_CLICK'){try{handleKapaniPushDeepLink(event.data.url||'');}catch(e){console.debug('[Kapani Push] click route:',e);}}
});}
function makeSw(isOn,fn){const bg=isOn?'var(--primary)':'var(--surface2)';const bdr=isOn?'var(--primary)':'var(--border)';const knob=isOn?'right:3px;background:#080507':'left:3px;background:var(--muted)';return `<div onclick="${fn}" style="cursor:pointer;min-width:48px;width:48px;height:28px;border-radius:14px;background:${bg};border:2px solid ${bdr};transition:.25s;position:relative;flex-shrink:0;"><div style="position:absolute;top:3px;${knob};width:18px;height:18px;border-radius:50%;transition:.25s;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div></div>`;}
function updatePushSettingsUI(){
    const container=qs('pushSettingsContainer'),btn=qs('pushEnableBtn'),statusTxt=qs('pushStatusText');
    if(!container) return;
    try{ void refreshPushWorkerStatus(); }catch(_){}
    // iOS device in browser (not PWA) — show special message
    if(isIOSDevice() && !isIOSPWA()){
        if(btn){
            btn.textContent='📲 Добавьте на экран «Домой»';
            btn.disabled=false;
            btn.className='btn btn-gold';
            btn.onclick=()=>toast('Откройте Safari → Поделиться → «На экран «Домой»» — затем откройте приложение оттуда для уведомлений','gold');
        }
        container.style.display='none';
        return;
    }
    const perm=('Notification' in window)?Notification.permission:'unsupported';
    if(perm==='unsupported'){if(btn){btn.textContent='❌ Не поддерживается';btn.disabled=true;btn.className='btn btn-ghost';}container.style.display='none';return;}
    if(perm==='denied'){if(btn){btn.textContent='🚫 Заблокировано';btn.disabled=false;btn.className='btn btn-ghost';btn.onclick=()=>toast('Откройте настройки браузера → Уведомления и разрешите для этого сайта','gold');}container.style.display='none';return;}
    if(perm==='default'){if(btn){btn.textContent='🔔 Включить push-уведомления';btn.disabled=false;btn.className='btn btn-primary';btn.onclick=handlePushBtn;}container.style.display='none';return;}
    if(btn) btn.style.display='none'; if(statusTxt) statusTxt.style.display='none';
    const masterOn=isPushOn();
    const cats=[
        {id:'messages',label:'💬 Сообщения',desc:'ЛС и чат'},
        {id:'money',label:'💰 Деньги',desc:'Переводы'},
        {id:'taxi_orders',label:'🛵 Такси',desc:'Заказы такси'},
        {id:'delivery_orders',label:'📦 Доставка',desc:'Заказы доставки'},
        {id:'market',label:'🛍 Маркет',desc:'Сделки'},
        {id:'news',label:'📰 Новости',desc:'Новые публикации'},
        {id:'system',label:'⚙️ Система',desc:'Мэрия, должности'}
    ];
    container.style.display='block';
    container.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:2px solid var(--border);margin-bottom:2px;"><div><div style="font-weight:900;font-size:14px;">🔔 Все уведомления</div><div style="font-size:11px;color:var(--muted);">Главный переключатель</div></div>${makeSw(masterOn,"toggleMasterPush()")}</div>`+cats.map(c=>{const catOn=masterOn&&getPushPrefs()[c.id]!==false;const rowOp=masterOn?'':'opacity:.45;pointer-events:none;';return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);${rowOp}"><div><div style="font-weight:800;font-size:13px;">${c.label}</div><div style="font-size:11px;color:var(--muted);">${c.desc}</div></div>${makeSw(catOn,"togglePushCat('"+c.id+"')")}</div>`;}).join('');
}

window.getKapaniPushDiagnostics = async function(){
    const permission=('Notification' in window)?Notification.permission:'unsupported';let reg=null,sub=null,swError=null,subscriptionError=null;
    try{reg=await getSwReg();}catch(e){swError=String(e?.message||e);}try{sub=await getWebPushSubscription(false);}catch(e){subscriptionError=String(e?.message||e);}
    let authDiag=null;try{const a=await ensureAuth();authDiag=a.currentUser||await waitForFirebaseAuthUser(2000);}catch(_){ }
    return {checkedAt:new Date().toISOString(),currentKapaniUser:currentNick||null,permission,pushSupported:!!(window.isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window),serviceWorkerRegistered:!!reg,serviceWorkerScope:reg?.scope||null,activeServiceWorker:!!reg?.active,pushSubscriptionExists:!!sub,pushEndpoint:sub?.endpoint||null,subscriptionId:sub?.endpoint?await hashWebPushEndpoint(sub.endpoint):null,subscriptionSaved:!!(window._kapaniWebPushSubscriptionId||localStorage.getItem('kp_webpush_subscription_id')),firebaseAuthUser:!!authDiag,firebaseAuthUid:authDiag?.uid||null,vapidConfigured:!!WEB_PUSH_VAPID_PUBLIC_KEY,state:window._kapaniPushState||null,lastGoodRegistrationAt:window._kapaniPushState?.lastGoodRegistrationAt||null,swError,subscriptionError,pushBackend:PUSH_WORKER_URL?'cloudflare-webpush':null,firebaseFunctionsPush:false};
};
window.handlePushBtn=async function(){
    if(isIOSDevice()&&!isIOSPWA()){toast('📲 Добавьте сайт на экран «Домой» в Safari, затем откройте его как приложение','gold');return;}
    if(!('Notification' in window)){toast('❌ Браузер не поддерживает уведомления','red');return;}
    if(Notification.permission==='denied'){toast('⚠️ Уведомления всегда можно включить в профиле.','gold');return;}
    const ok=await requestPushPermission();if(ok)updatePushSettingsUI();
};
window.toggleMasterPush=function(){const p=getPushPrefs();p.enabled=p.enabled!==false?false:true;savePushPrefs(p);toast(p.enabled?'🔔 Включены':'🔕 Выключены',p.enabled?'green':'gold');updatePushSettingsUI();};
window.togglePushCat=function(cat){const p=getPushPrefs();p[cat]=p[cat]===false?true:false;savePushPrefs(p);updatePushSettingsUI();toast((p[cat]!==false?'🔔 ':'🔕 ')+'Обновлено','green');};

// ─── FIRST LOGIN PUSH PROMPT ─────────────────
function getFirstPushPromptKey(){ return currentNick ? `kp_first_push_prompt_${currentNick}` : 'kp_first_push_prompt'; }
function wasFirstPushPromptHandled(){ try{return localStorage.getItem(getFirstPushPromptKey())==='1';}catch(e){return false;} }
function markFirstPushPromptHandled(){ try{localStorage.setItem(getFirstPushPromptKey(),'1');}catch(e){} }
function closeFirstPushPrompt(){ const m=qs('firstPushPrompt'); if(m)m.remove(); }
window.finishFirstPushPrompt = async function(allow){
    // Mark immediately: regardless of choice, this account must never see this
    // first-login prompt again.
    markFirstPushPromptHandled();
    closeFirstPushPrompt();
    if(allow){
        try{ const ok=await requestPushPermission(); if(!ok) console.warn('[push first prompt] notification permission/token registration not completed'); }catch(e){ console.error('[push first prompt]',e); }
    } else {
        toast('🔕 Уведомления отключены. Их всегда можно включить в профиле.','gold');
    }
    // This is an in-app notification explaining where the setting lives.
    // It is written independently from browser permission, so declining the
    // browser prompt never blocks the informational notification.
}
function showFirstPushPrompt(){
    if(!currentNick || wasFirstPushPromptHandled() || qs('firstPushPrompt')) return;
    if(!('Notification' in window)) { markFirstPushPromptHandled(); return; }
    if(Notification.permission==='granted') { markFirstPushPromptHandled(); void requestPushPermission().catch(e=>console.error('[push permission prompt]',e)); return; }
    const m=document.createElement('div');
    m.id='firstPushPrompt';
    m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:flex-end;justify-content:center;padding:16px;';
    m.innerHTML=`<div style="width:100%;max-width:490px;background:#170b10;border:1px solid var(--border);border-radius:24px;padding:22px;box-shadow:var(--shadow);">
      <div style="font-size:34px;margin-bottom:8px;">🔔</div>
      <div style="font-size:20px;font-weight:900;margin-bottom:6px;">Включить уведомления?</div>
      <div style="font-size:13px;line-height:1.55;color:var(--muted);margin-bottom:16px;">Получайте сообщения, переводы, уведомления мэрии и другие важные события Капани.</div>
      <button class="btn btn-primary" type="button" onclick="finishFirstPushPrompt(true)">🔔 Включить уведомления</button>
      <button class="btn btn-ghost" type="button" style="margin-top:8px;" onclick="finishFirstPushPrompt(false)">Не сейчас</button>
    </div>`;
    document.body.appendChild(m);
}

if(!window._kapaniChatPresenceUnloadBound){
    window._kapaniChatPresenceUnloadBound = true;
    window.addEventListener('pagehide', ()=>{ 
        if(currentNick) {
            try { set(ref(db, `presence/${currentNick}/generalChatOpen`), false); } catch(e) {}
        }
    }, {capture:true});
}

// ─── NOTIFICATIONS ────────────────────────
// Notifications are always best-effort: pushNotification() must NEVER throw,
// because it is called right after critical business operations (account
// verification, transfers, fines, business approvals, etc.) have already
// succeeded. A push/session failure here must never look like the underlying
// operation failed and must never produce an unhandled promise rejection.
// Protected notification/inbox writes are performed by the authenticated Cloudflare Worker.
// The browser only creates the local notification ID and sends the request; the Worker
// creates the RTDB record and durable pushOutbox job atomically.
async function writeNotificationViaWorker(targetNick,body,cat,extra){
    if(!PUSH_WORKER_URL) throw new Error('Cloudflare push worker is not configured');
    if(!currentNick) throw new Error('Пользователь не определён');
    const ph=await getPushAuthHash();
    if(!ph) throw new Error('Не найден хэш пароля для регистрации push');
    // Firebase push() only generates a local key here; the actual protected RTDB write
    // is performed atomically by the authenticated Cloudflare Worker.
    const nRef=push(notifRef(targetNick));
    const notificationId=String(nRef?.key||'');
    if(!notificationId) throw new Error('Не удалось создать ID уведомления');
    const result=await pushWorkerCall('/notify',{
        nick:currentNick,
        ph,
        targetNick,
        notificationId,
        text:body,
        category:String(cat||'system'),
        title:String(extra?.title||'Капани'),
        url:String(extra?.url||''),
        source:String(extra?.source||''),
        sourceMessageId:String(extra?.sourceMessageId||''),
        createdAt:Date.now()
    });
    return {notificationId,...result};
}
async function pushNotification(nick,text,cat='system',extra={}){
    const targetNick=String(nick||'').trim(),body=String(text||'').trim();
    if(!targetNick||!body)return{ok:false,notificationFailed:true,error:'invalid-args'};
    try{
        const result=await writeNotificationViaWorker(targetNick,body,cat,extra);
        return{ok:true,notificationId:String(result?.notificationId||''),nick:targetNick,via:'cloudflare',delivery:result};
    }catch(e){
        // Push is deliberately best-effort: a push backend outage must never make an
        // already successful business operation appear to have failed.
        console.warn('[pushNotification] Cloudflare notification failed (non-fatal):',e?.message||e);
        return{ok:false,notificationFailed:true,error:String(e?.message||e),nick:targetNick};
    }
}
// The recipient's own realtime listener (attachNotificationsListener) shows the
// in-app banner and the OS-level push, so there is no second display path here.
window.testKapaniPush = async function(){
    if(!currentNick) throw new Error('Сначала войдите в Капани');
    const result = await pushNotification(currentNick, '🧪 Тестовое уведомление Капани. Если вы видите это в списке и во всплывающем окне — уведомления работают.', 'system');
    if(!result.ok) throw new Error('Не удалось создать уведомление: '+(result.error||'неизвестная ошибка'));
    const perm=('Notification' in window)?Notification.permission:'unsupported';
    toast(perm==='granted'?'🧪 Тестовое уведомление отправлено':'🧪 Уведомление добавлено в список. Разрешите push в браузере, чтобы видеть его как системное','green');
    return {...result, permission:perm, diagnostics: await window.getKapaniPushDiagnostics()};
};
window.deleteNotification=async function(notifId){
    try { await manageOwnNotifications('delete',String(notifId)); }
    catch(e){console.error('[notifications] delete failed',e);toast('Не удалось удалить уведомление: '+e.message,'red');}
};
window.clearAllNotifications=async function(){
    try { await manageOwnNotifications('clear');toast('✅ Уведомления очищены','green'); }
    catch(e){console.error('[notifications] clear failed',e);toast('Не удалось очистить уведомления: '+e.message,'red');}
};
function renderNotifications(notifs){
    const el=qs('inboxList');if(!el)return;
    const arr=Object.entries(notifs||{})
        .filter(([,n])=>n)
        .map(([id,n])=>(typeof n==='string'?{text:n,id}:{...n,id}))
        .sort((a,b)=>((Number(b.createdAt)||0)-(Number(a.createdAt)||0)) || (a.id<b.id?1:a.id>b.id?-1:0));
    el.innerHTML=arr.length===0?'<div style="color:var(--muted);font-size:13px;">Нет уведомлений</div>':arr.map(n=>{
      const duelActions=n.type==='duel_invite'&&n.duelId?`<div style="display:flex;gap:6px;margin-top:8px;"><button class="btn btn-primary btn-sm" onclick="acceptOnlineDuelFromNotif('${n.duelId}','${n.id}')">✅ Принять</button><button class="btn btn-red btn-sm" onclick="declineOnlineDuelFromNotif('${n.duelId}','${n.id}')">❌ Отклонить</button></div>`:'';
      return `<div class="notif-item" style="${n.type==='duel_invite'?'border-left-color:var(--gold);':''}" onclick="${!duelActions?`deleteNotification('${n.id}')`:''}">`
        +`<div style="flex:1;min-width:0;"><div class="notif-text" style="white-space:pre-wrap;word-break:break-word;">${escHtml(n.text||'')}</div>${duelActions}</div>`
        +`<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;margin-left:8px;"><div class="notif-time">${escHtml(formatNotifTime(n))}</div>${!duelActions?`<div class="notif-del" onclick="deleteNotification('${n.id}');event.stopPropagation()">✕</div>`:''}</div></div>`;
    }).join('');
}

// Duel events historically live under /notifications/<nick>. Mirror them into the
// canonical inbox from the client under the SAME id the backend bridge uses
// (legacy_<key>), so the invite shows up even if the Cloud Function is slow or
// not deployed; the function's `existing.exists()` check makes this idempotent.
async function pushLegacyDuelNotification(targetNick,payload){
    const legacyRef=await push(ref(db,`notifications/${targetNick}`),payload);
    try{
        const key=String(legacyRef?.key||''); if(!key) return;
        await set(ref(db,`users/${targetNick}/notifications/legacy_${key}`),{
            text:String(payload.text||'Новое уведомление'),
            title:'Капани',
            time:nowTime(),
            cat:'messages',
            createdAt:Number(payload.ts)||Date.now(),
            url:'',
            push:true,
            type:String(payload.type||''),
            from:String(payload.from||''),
            duelId:String(payload.duelId||''),
            source:'legacy_duel',
            sourceMessageId:key
        });
        void enqueuePushJob({type:'notification',to:targetNick,id:`legacy_${key}`});
    }catch(e){ console.debug('[duel notification mirror]',e?.message||e); }
}

window.acceptOnlineDuelFromNotif=async function(duelId,notifId){
  await deleteNotification(notifId);
  await acceptOnlineDuel(duelId);
  navTo('gameDuelSection');
  setTimeout(()=>document.getElementById('duelTabOnline')?.click(),400);
};
window.declineOnlineDuelFromNotif=async function(duelId,notifId){
  await deleteNotification(notifId);
  await declineOnlineDuel(duelId);
};

// ─── EMOJI PICKER ─────────────────────────
const EMOJI_LIST = [
    '😀','😂','😅','😍','🥰','😎','🤩','😢','😭','😡',
    '🥺','😏','😜','🤔','🤗','😴','🤒','🥳','😇','👻',
    '👍','👎','❤️','🔥','✨','💯','🎉','🙏','💪','👀',
    '🤝','💸','🛵','📦','🏠','🌲','🪨','🍎','⚡','🎶',
    '😆','🤣','😋','🙃','🤑','😤','🫡','🫶','💀','👌',
    '✅','❌','⚠️','🕐','📍','🗺','💰','🏆','🛒','🔧'
];
function buildEmojiPanels(){['chatEmojiPanel','dmEmojiPanel','newsEmojiPanel'].forEach(id=>{const el=qs(id);if(!el)return;const grid=document.createElement('div');grid.className='emoji-grid';EMOJI_LIST.forEach(em=>{const btn=document.createElement('button');btn.className='ep-btn';btn.textContent=em;btn.onclick=()=>insertEmoji(id,em);grid.appendChild(btn);});el.appendChild(grid);});}
function insertEmoji(panelId,em){const inputId=panelId==='chatEmojiPanel'?'chatInput':panelId==='newsEmojiPanel'?'newsInput':'dmInput';const inp=qs(inputId);if(!inp)return;const s=inp.selectionStart||0,e=inp.selectionEnd||0,v=inp.value;inp.value=v.slice(0,s)+em+v.slice(e);inp.selectionStart=inp.selectionEnd=s+em.length;inp.focus();}
window.toggleEmoji=function(ctx){const panelId=ctx==='chat'?'chatEmojiPanel':ctx==='news'?'newsEmojiPanel':'dmEmojiPanel';const el=qs(panelId);if(!el)return;el.classList.toggle('open');if(el.classList.contains('open')){const mb=ctx==='chat'?'chatMediaBar':ctx==='news'?'newsMediaBar':'dmMediaBar';qs(mb)&&qs(mb).classList.remove('open');}};
window.toggleMediaBar=function(ctx){const barId=ctx==='chat'?'chatMediaBar':ctx==='news'?'newsMediaBar':'dmMediaBar';const el=qs(barId);if(!el)return;el.classList.toggle('open');if(el.classList.contains('open')){const ep=ctx==='chat'?'chatEmojiPanel':ctx==='news'?'newsEmojiPanel':'dmEmojiPanel';qs(ep)&&qs(ep).classList.remove('open');}};

// ─── IMAGE VIEWER ─────────────────────────
window.openImgViewer=function(src){
    const img=qs('imgViewerImg');
    if(!img)return;
    img.src=src;
    _imgZoomScale=1;
    _imgPanX=0; _imgPanY=0;
    img.style.transform='scale(1) translate(0px,0px)';
    const pct=qs('imgZoomPct');if(pct)pct.textContent='100%';
    lockBodyScroll();
    const _iv=qs('imgViewer'); _iv.style.pointerEvents='auto'; _iv.classList.add('open');
    // Init pinch-to-zoom
    _initImgPinchZoom(img);
};
window.closeImgViewer=function(){
    qs('imgViewer').classList.remove('open');
    _imgZoomScale=1; _imgPanX=0; _imgPanY=0;
    const img=qs('imgViewerImg');if(img)img.style.transform='scale(1) translate(0px,0px)';
    unlockBodyScroll();
};
window.adjustImgZoom=function(delta){
    _imgZoomScale=Math.min(5,Math.max(0.5,_imgZoomScale+delta));
    if(_imgZoomScale<=1){_imgPanX=0;_imgPanY=0;}
    const img=qs('imgViewerImg');
    if(img)img.style.transform=`scale(${_imgZoomScale}) translate(${_imgPanX/_imgZoomScale}px,${_imgPanY/_imgZoomScale}px)`;
    const pct=qs('imgZoomPct');if(pct)pct.textContent=Math.round(_imgZoomScale*100)+'%';
};
window.resetImgZoom=function(){
    _imgZoomScale=1;_imgPanX=0;_imgPanY=0;
    const img=qs('imgViewerImg');if(img)img.style.transform='scale(1) translate(0px,0px)';
    const pct=qs('imgZoomPct');if(pct)pct.textContent='100%';
};
let _imgPanX=0, _imgPanY=0;
function _applyImgTransform(img){
    if(!img)return;
    img.style.transform=`scale(${_imgZoomScale}) translate(${_imgPanX/_imgZoomScale}px,${_imgPanY/_imgZoomScale}px)`;
    const pct=qs('imgZoomPct');if(pct)pct.textContent=Math.round(_imgZoomScale*100)+'%';
}
function _initImgPinchZoom(img){
    if(!img || img._pinchInited) return;
    img._pinchInited = true;
    let startDist=0, startScale=1, startMidX=0, startMidY=0, startPanX=0, startPanY=0;
    let isDragging=false, dragStartX=0, dragStartY=0, dragStartPanX=0, dragStartPanY=0;
    img.addEventListener('touchstart', function(e){
        if(e.touches.length===2){
            e.preventDefault();
            const t1=e.touches[0],t2=e.touches[1];
            startDist=Math.hypot(t2.clientX-t1.clientX,t2.clientY-t1.clientY);
            startScale=_imgZoomScale;
            startMidX=(t1.clientX+t2.clientX)/2;
            startMidY=(t1.clientY+t2.clientY)/2;
            startPanX=_imgPanX; startPanY=_imgPanY;
        } else if(e.touches.length===1&&_imgZoomScale>1){
            isDragging=true;
            dragStartX=e.touches[0].clientX; dragStartY=e.touches[0].clientY;
            dragStartPanX=_imgPanX; dragStartPanY=_imgPanY;
        }
    },{passive:false});
    img.addEventListener('touchmove', function(e){
        if(e.touches.length===2){
            e.preventDefault();
            const t1=e.touches[0],t2=e.touches[1];
            const dist=Math.hypot(t2.clientX-t1.clientX,t2.clientY-t1.clientY);
            _imgZoomScale=Math.min(5,Math.max(0.5,startScale*(dist/startDist)));
            if(_imgZoomScale<=1){_imgPanX=0;_imgPanY=0;}
            _applyImgTransform(img);
        } else if(e.touches.length===1&&isDragging&&_imgZoomScale>1){
            e.preventDefault();
            _imgPanX=dragStartPanX+(e.touches[0].clientX-dragStartX);
            _imgPanY=dragStartPanY+(e.touches[0].clientY-dragStartY);
            _applyImgTransform(img);
        }
    },{passive:false});
    img.addEventListener('touchend', function(){isDragging=false;},{passive:true});
    // Double-tap to zoom
    let _lastTap=0;
    img.addEventListener('touchend', function(e){
        const now=Date.now();
        if(now-_lastTap<300&&e.changedTouches.length===1){
            if(_imgZoomScale>1){window.resetImgZoom();}
            else{_imgZoomScale=2.5;_applyImgTransform(img);}
        }
        _lastTap=now;
    },{passive:true});
}
function setPlaybackAudioRoute(){
    try {
        // Use 'playback' to route through speaker on iOS (not earpiece)
        const session = navigator.audioSession;
        if (session) { session.type = 'playback'; }
    } catch (e) {}
    // Also try to force speaker via dummy AudioContext unlock on iOS
    try {
        if(window._iosAudioCtx && window._iosAudioCtx.state === 'suspended') window._iosAudioCtx.resume().catch(()=>{});
    } catch(e){}
}

window.openVideoViewer=function(src){
    const v=qs('videoViewerVideo');
    if(!v) return;
    setPlaybackAudioRoute();
    v.pause();
    v.removeAttribute('src');
    // Apply optional transform for video circles (front camera needs un-mirror)
    // Pass as: openVideoViewer(url, { transform: 'scaleX(-1)' })
    let transform = null;
    try{
        if(arguments.length > 1 && arguments[1] && typeof arguments[1] === 'object'){
            transform = arguments[1].transform || null;
        }
    }catch(e){}
    if(transform){
        v.style.setProperty('transform', transform, 'important');
        v.style.setProperty('-webkit-transform', transform, 'important');
    } else {
        v.style.removeProperty('transform');
        v.style.removeProperty('-webkit-transform');
    }
    v.src=src;
    v.load();
    v.playsInline = true;
    v.setAttribute('webkit-playsinline', '');
    v.muted = false;
    v.volume = 1;
    lockBodyScroll();
    const _vv=qs('videoViewer'); _vv.style.pointerEvents='auto'; _vv.classList.add('open');
    v.play().catch(()=>{});
};
window.closeVideoViewer=function(){
    const v=qs('videoViewerVideo');
    if(v){v.pause();v.removeAttribute('src');v.load();}
    try { if(navigator.audioSession) navigator.audioSession.type = 'auto'; } catch(e) {}
    unlockBodyScroll();
    qs('videoViewer').classList.remove('open');
};

window.toggleVideoFullscreen = function(){
    const v = qs('videoViewerVideo');
    if(!v) return;
    const doc = document;
    const isFs = doc.fullscreenElement || doc.webkitFullscreenElement;
    if(isFs){
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if(exit) exit.call(doc);
        return;
    }
    const req = v.requestFullscreen || v.webkitRequestFullscreen;
    if(req) req.call(v);
};


// ─── MEDIA FILE HANDLING ──────────────────
window.handleMediaFile=async function(e, ctx){
    const files=Array.from(e.target.files||[]); if(!files.length) return;
    e.target.value='';
    const images=files.filter(f=>f.type.startsWith('image/'));
    const videos=files.filter(f=>f.type.startsWith('video/'));
    try {
        if(images.length){
            for(const file of images){
                if(file.size>10*1024*1024){toast('❌ Фото слишком большое (макс. 10 МБ)','red');continue;}
                const dataUrl=await compressImage(file,900,0.82);
                const blob=await (await fetch(dataUrl)).blob();
                getPendingPhotos(ctx).push({id:genId(),dataUrl,blob,caption:''});
            }
            renderPendingPhotos(ctx);
            toast(`🖼 Добавлено фото: ${images.length}`,'green');
        }
        if(videos.length){
            for(const file of videos){
                const maxMb = 49;
                if(file.size > maxMb*1024*1024){toast(`❌ Видео слишком большое (макс. ${maxMb} МБ)`,'red');continue;}
                toast('🎬 Загружаем видео...','gold');
                const url = await uploadBlobToStorage(file, 'media/videos');
                if(ctx==='chat') await sendChatMsg(null,url,'video');
                else if(ctx==='dm') await sendDmMsg(null,url,'video');
                else if(ctx==='news') await sendNewsDiscussionMsg(null,url,'video');
            }
        }
        const mb=ctx==='chat'?'chatMediaBar':ctx==='dm'?'dmMediaBar':'newsMediaBar'; qs(mb)&&qs(mb).classList.remove('open');
    } catch(err){toast('❌ Ошибка загрузки: '+err.message,'red');}
};

// ─── VOICE RECORDING ──────────────────────
let voiceRecorder=null, voiceChunks=[], voiceInterval=null, voiceSeconds=0, voiceCtx='chat';
let voiceStopResolve=null;
function voiceUiIds(ctx){
    if(ctx==='wall')return{indId:'wallRecInd',timerId:'wallRecTimer'};
    if(ctx==='chat')return{indId:'chatRecInd',timerId:'chatRecTimer'};
    if(ctx==='news')return{indId:'newsRecInd',timerId:'newsRecTimer'};
    return{indId:'dmRecInd',timerId:'dmRecTimer'};
}
window.startVoice=async function(ctx){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia) return toast('❌ Запись недоступна в этом браузере','red');
    voiceCtx=ctx;
    try {
        const stream=await navigator.mediaDevices.getUserMedia({audio:true});
        voiceChunks=[]; voiceSeconds=0; voiceStopResolve=null;
        const candidates=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'];
        const supported=candidates.find(m=>MediaRecorder.isTypeSupported?.(m));
        voiceRecorder=new MediaRecorder(stream,supported?{mimeType:supported}:undefined);
        voiceRecorder.ondataavailable=e=>{ if(e.data && e.data.size>0) voiceChunks.push(e.data); };
        voiceRecorder.onstop=()=>{ if(voiceStopResolve) voiceStopResolve(); };
        voiceRecorder.onerror=(e)=>{ toast('❌ Ошибка записи','red'); if(voiceStopResolve) voiceStopResolve(); };
        voiceRecorder.start(100);
        const {indId,timerId}=voiceUiIds(ctx);
        const ind=qs(indId);if(ind)ind.classList.add('show');
        if(ctx==='chat'||ctx==='dm'||ctx==='news'){const mb=ctx==='chat'?'chatMediaBar':ctx==='dm'?'dmMediaBar':'newsMediaBar';qs(mb)&&qs(mb).classList.remove('open');}
        if(ctx==='chat') setChatTypingState('voice');
        if(ctx==='dm') setDmTypingState('voice');
        if(ctx==='news') setNewsTypingState('voice');
        voiceInterval=registerInterval('voiceInterval', setInterval(()=>{voiceSeconds++;const m=Math.floor(voiceSeconds/60),s=voiceSeconds%60;const tEl=qs(timerId);if(tEl)tEl.textContent=`${m}:${s<10?'0'+s:s}`;if(voiceSeconds>=120)stopVoice(ctx);},1000));
        toast('🎤 Запись началась...','gold');
    } catch(e){toast('❌ Нет доступа к микрофону','red');}
};
window.stopVoice=async function(ctx){
    if(!voiceRecorder||voiceRecorder.state==='inactive') return;
    // Request final data chunk before stopping
    try { voiceRecorder.requestData(); } catch(e){}
    // Wait for onstop event to ensure all data is collected
    const stopPromise=new Promise(r=>{ voiceStopResolve=r; });
    voiceRecorder.stop();
    voiceRecorder.stream.getTracks().forEach(t=>t.stop());
    clearIntervalByName('voiceInterval');
    const {indId}=voiceUiIds(ctx);
    const ind=qs(indId);if(ind)ind.classList.remove('show');
    if(ctx==='chat') setChatTypingState('idle');
    if(ctx==='dm') setDmTypingState('idle');
    if(ctx==='news') setNewsTypingState('idle');
    // Wait for onstop event
    await stopPromise;
    // Small additional delay to ensure ondataavailable fired
    await new Promise(r=>setTimeout(r,200));
    if(voiceChunks.length===0){ toast('❌ Запись пуста','red'); voiceRecorder=null; voiceChunks=[]; return; }
    const blob=new Blob(voiceChunks,{type:voiceRecorder.mimeType||voiceChunks[0]?.type||'audio/webm'});
    try {
        const url=await uploadBlobToStorage(blob,'media/voice');
        if(ctx==='chat') await sendChatMsg(null,url,'voice');
        else if(ctx==='dm') await sendDmMsg(null,url,'voice');
        else if(ctx==='news') await sendNewsDiscussionMsg(null,url,'voice');
        else if(ctx==='wall') await pushWallPostMedia('voice',url);
        toast('🎤 Голосовое отправлено','green');
    } catch(error){
        toast('❌ Голосовое не отправлено: '+(error?.message||error),'red');
    } finally {
        voiceRecorder=null;voiceChunks=[];
    }
};
window.cancelVoice=function(ctx){
    if(voiceRecorder&&voiceRecorder.state!=='inactive'){voiceRecorder.stop();voiceRecorder.stream.getTracks().forEach(t=>t.stop());}
    clearIntervalByName('voiceInterval'); voiceRecorder=null; voiceChunks=[]; voiceStopResolve=null;
    const {indId}=voiceUiIds(ctx);
    const ind=qs(indId);if(ind)ind.classList.remove('show');
    if(ctx==='chat') setChatTypingState('idle');
    if(ctx==='dm') setDmTypingState('idle');
    if(ctx==='news') setNewsTypingState('idle');
    toast('🗑 Запись отменена','red');
};

async function renderTaxiHistory(){
    const card=qs('taxiHistory'),list=qs('taxiHistoryList');
    if(!card||!list||!currentNick) return;
    try{
        const snap=await get(query(ref(db,'taxiHistory'),orderByChild('client'),equalTo(currentNick)));
        const arr=Object.entries(snap.val()||{}).map(([id,o])=>({...o,id})).sort((a,b)=>(b.completedAt||b.createdAt||0)-(a.completedAt||a.createdAt||0)).slice(0,20);
        card.style.display=arr.length?'block':'none';
        if(!arr.length){list.innerHTML='';return;}
        list.innerHTML=arr.map(o=>{
            const date=o.completedAt||o.paidAt||o.createdAt;
            const route=[o.info,o.address].filter(Boolean).join(' → ');
            return `<div style="padding:12px 0;border-bottom:1px solid var(--border);"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;"><b>${escHtml(route||'Поездка')}</b><span style="color:var(--primary);font-weight:900;white-space:nowrap;">${Number(o.price||0).toLocaleString('ru-RU')}₽</span></div><div style="font-size:12px;color:var(--muted);margin-top:5px;">${date?new Date(date).toLocaleString('ru-RU'):''} · Водитель: ${escHtml(o.worker||'—')} · <span style="color:var(--primary);">Завершено</span></div></div>`;
        }).join('');
    }catch(e){ console.warn('[taxi history]',e); card.style.display='none'; }
}

// ─── ACTIVE ORDERS ────────────────────────
let _taxiUiKey='';
let _driverUiKey='';
function destroyClientTrackingMap(){
    if(clientTrackListener){try{clientTrackListener.unsub?clientTrackListener.unsub():off(clientTrackListener.ref,'value',clientTrackListener.fn);}catch(e){}clientTrackListener=null;}
    if(clientTrackingMap){try{clientTrackingMap.remove();}catch(e){}clientTrackingMap=null;}
    driverMarkerOnClientMap=null;
}
function renderActiveOrders(orders) {
    const ordersArr=Object.entries(orders||{}).map(([id,o])=>({...o,id}));
    const activeMine=ordersArr.filter(o=>o.client===currentNick&&((o.type==='taxi'&&TAXI_ACTIVE_STATUSES.has(String(o.status||'')))||(o.type!=='taxi'&&['waiting','in_progress'].includes(String(o.status||'')))));
    const sOrder=activeMine.find(o=>o.type==='shop');
    const tOrder=activeMine.find(o=>o.type==='taxi');
    const ss=qs('shopStatus'),btnBuy=qs('btnBuy');
    if(sOrder){
        if(btnBuy) btnBuy.disabled=true;
        const cls=sOrder.status==='pending'||sOrder.status==='accepted'?'badge-wait':'badge-active';
        const lbl=sOrder.status==='pending'?'⏳ Ожидание курьера':'📦 Курьер в пути';
        const workerUser=sOrder.worker?(allUsersCache[sOrder.worker]||{}):null;
        const workerOnline=workerUser?isUserOnline(workerUser):false;
        const courierBlock=sOrder.worker?`<div style="display:flex;align-items:center;gap:10px;padding:12px;background:rgba(240,68,74,.08);border-radius:var(--r-sm);margin-bottom:12px;border:1px solid rgba(240,68,74,.2);"><div class="av-wrap-sm ${workerOnline?'online':''}"><img src="${escHtml(workerUser.avatar||DEFAULT_AVATAR_URL)}" style="width:40px;height:40px;border-radius:11px;object-fit:cover;cursor:pointer;" loading="lazy" onclick="openUserProfile('${escHtml(sOrder.worker)}')"><div class="online-dot"></div></div><div style="flex:1;"><div style="font-weight:900;font-size:14px;cursor:pointer;" onclick="openUserProfile('${escHtml(sOrder.worker)}')">${escHtml(sOrder.worker)}</div><div style="font-size:11px;color:${workerOnline?'#22c55e':'var(--muted)'};">${workerOnline?'🟢 В сети':'Курьер'}${workerUser.vehicle?' · '+escHtml(workerUser.vehicle):''}</div></div><button class="btn btn-ghost btn-sm" onclick="goToChat('${escHtml(sOrder.worker)}')" style="font-size:11px;padding:8px 10px;">💬</button></div>`:'';
        ss.innerHTML=`<div class="status-card green"><div class="status-badge ${cls}"><span class="pulse"></span>${lbl}</div><div style="font-weight:700;margin-bottom:8px;">📦 ${escHtml(sOrder.info)}</div><div style="font-size:13px;color:var(--muted);margin-bottom:12px;">📍 ${escHtml(sOrder.address||'')}</div>${courierBlock}<button class="btn btn-primary" style="margin-bottom:8px" onclick="payOrder('${sOrder.id}')">✅ Получил — оплатить ${sOrder.price}₽</button><button class="btn btn-ghost" style="color:var(--red);border-color:var(--red-dim);font-size:12px;" onclick="cancelOrder('${sOrder.id}')">Отменить (-35₽)</button></div>`;
    } else { if(btnBuy) btnBuy.disabled=false; if(ss) ss.innerHTML=''; }
    const ts=qs('taxiStatus');
    if(tOrder){
        const stableKey=[tOrder.id,tOrder.status,tOrder.worker||'',tOrder.info||'',tOrder.price||0,tOrder.driverVehicle||'',tOrder.driverAvatar||'',tOrder.clientLat||'',tOrder.clientLng||'',tOrder.destLat||'',tOrder.destLng||''].join('|');
        const isStable = _taxiUiKey===stableKey;
        if(!isStable){
            _taxiUiKey=stableKey;
            const tf=qs('taxiForm'); if(tf) tf.style.display='none';
            const lbl2=orderStatusLabel(tOrder.status);
            const distKm=tOrder.distanceKm||0; const etaMin=distKm?Math.ceil(distKm/MAX_SPEED_KMH*60):null;
            let driverBlock='';
            if(tOrder.worker){
                driverBlock=`<div class="driver-card"><div class="driver-card-header" style="cursor:pointer;" onclick="openUserProfile('${escHtml(tOrder.worker)}')"><img class="driver-card-av" src="${escHtml(tOrder.driverAvatar||DEFAULT_AVATAR_URL)}" loading="lazy"><div><div class="driver-card-name">${escHtml(tOrder.worker)}</div><div class="driver-card-vehicle">${escHtml(tOrder.driverVehicle||'Транспорт не указан')}</div></div></div>${etaMin?`<div class="driver-eta">⏱ ~<b>${etaMin} мин</b></div>`:''}<div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-ghost btn-sm" style="flex:1;font-size:11px;" onclick="goToChat('${escHtml(tOrder.worker)}')">💬 Написать</button><button class="btn btn-ghost btn-sm" style="flex:1;font-size:11px;" onclick="openUserProfile('${escHtml(tOrder.worker)}')">👤 Профиль</button></div></div>`;
            }
            const tracking=(tOrder.worker&&['driver_arriving','in_progress'].includes(tOrder.status))?`<div class="tracking-card"><div class="tracking-live"><span class="pulse"></span>Live — водитель на карте</div><div id="trackingMap"></div><div id="taxiTrackingEta" style="margin-top:10px;font-size:13px;color:var(--muted);font-weight:800;"></div></div>`:'';
            const payment=tOrder.status==='waiting_payment'?`<button class="btn btn-gold" style="margin-bottom:8px" onclick="payOrder('${tOrder.id}')">💳 Оплатить ${tOrder.price}₽</button>`:'';
            const cancel=`<button class="btn btn-ghost" style="color:var(--red);border-color:var(--red-dim);font-size:12px;" onclick="cancelOrder('${tOrder.id}')">Отменить (-35₽)</button>`;
            ts.innerHTML=`<div class="status-card gold"><div class="status-badge ${tOrder.status==='waiting_payment'?'badge-active':(tOrder.status==='pending'?'badge-wait':'badge-active')}"><span class="pulse"></span>${lbl2}</div><div style="font-weight:700;margin-bottom:8px;">🗺 ${escHtml(tOrder.info)}</div>${driverBlock}${tracking}${payment}${cancel}</div>`;
            if(tOrder.worker&&['driver_arriving','in_progress'].includes(tOrder.status)) setTimeout(()=>initClientTrackingMap(tOrder.id),50);
        }
    } else {
        _taxiUiKey=''; destroyClientTrackingMap();
        const tf=qs('taxiForm'); if(tf) tf.style.display='block'; if(ts) ts.innerHTML='';
    }
    const ho=qs('homeOrders');
    const mine=activeMine;
    if(ho) ho.innerHTML=mine.map(o=>`<div class="status-card ${o.type==='taxi'?'gold':'green'}" style="margin-bottom:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:4px;">${o.type==='taxi'?'🛵 Такси':'📦 Доставка'}</div><div style="font-weight:700;">${escHtml(o.info)}</div><div style="font-size:12px;color:var(--muted);margin-top:4px;">${escHtml(orderStatusLabel(o.status))}</div></div>`).join('');
}

// ─── WORKER HOME ──────────────────────────
async function renderHomeWorker(orders){
    const wl=qs('workerList'); if(!wl) return;
    const snap=await get(userRef(currentNick)); if(!snap.exists()) return;
    const u=snap.val();
    if(hasMunicipalJob(u,JOB_JANITOR)){
        const status=u.janitorSubmissionStatus||'ready';
        const statusTxt=status==='pending'?'⏳ Отчёт в мэрии':status==='approved'?'✅ День оплачен':status==='rejected'?'❌ Отказано':'🟢 Можно выполнять';
        wl.innerHTML=`<div class="work-order work-active"><div style="color:var(--primary);font-size:11px;font-weight:900;text-transform:uppercase;margin-bottom:8px;">Ежедневная задача</div><div style="font-weight:700;font-size:15px;margin-bottom:4px;">🧹 ${JANITOR_TASK_TEXT}</div><div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Сегодня: ${todayKey()}</div><div style="font-size:12px;color:var(--muted);">${statusTxt}</div><div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="navTo('janitorPage')">Открыть →</button></div></div>`;
        return;
    }
    const ordersArr=Object.entries(orders).map(([id,o])=>({...o,id}));
    const active=ordersArr.find(o=>o.worker===currentNick&&((o.type==='taxi'&&DRIVER_ACTIVE_ORDER_STATUSES.has(String(o.status||'')))||(o.type!=='taxi'&&o.status==='in_progress')));
    if(active){wl.innerHTML=`<div class="work-order work-active"><div style="color:var(--primary);font-size:11px;font-weight:900;text-transform:uppercase;margin-bottom:8px;">Активный заказ</div><div style="font-weight:700;font-size:15px;margin-bottom:4px;">${escHtml(active.info)}</div>${active.address?`<div style="color:var(--muted);font-size:12px;">📍 ${escHtml(active.address)}</div>`:''}<div style="color:var(--muted);font-size:12px;margin-top:4px;">Клиент: ${active.client} · ${active.price}₽</div></div>`;}
    else{const type=hasMunicipalJob(u,'Водитель')?'taxi':'shop';const avail=ordersArr.filter(o=>o.type===type&&((type==='taxi'&&['pending','waiting'].includes(String(o.status||'')))||(type!=='taxi'&&o.status==='waiting')));wl.innerHTML=avail.length===0?'<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px 0;">Нет заказов</div>':avail.map(o=>`<div class="work-order" style="margin-bottom:10px;"><div style="font-weight:700;margin-bottom:6px;">${escHtml(o.info)}</div>${o.address?`<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">📍 ${escHtml(o.address)}</div>`:''}<div style="display:flex;justify-content:space-between;align-items:center;"><span style="color:var(--primary);font-weight:900;">${o.price}₽</span><button class="btn btn-primary btn-sm" onclick="takeOrder('${o.id}')">✅ Взять</button></div></div>`).join('');}
}

// ─── WORKER PAGES ─────────────────────────
async function renderWorkerPage(orders){
    const snap=await get(userRef(currentNick)); if(!snap.exists()) return;
    const u=snap.val(); const isDriver=hasMunicipalJob(u,'Водитель');
    const type=isDriver?'taxi':'shop'; const listId=isDriver?'driverList':'deliveryList';
    const el=qs(listId); if(!el) return;
    if(!orders){const oSnap=await get(ordersRef());orders=oSnap.val()||{};}
    const ordersArr=Object.entries(orders).map(([id,o])=>({...o,id}));
    const active=ordersArr.find(o=>o.worker===currentNick&&((o.type==='taxi'&&DRIVER_ACTIVE_ORDER_STATUSES.has(String(o.status||'')))||(o.type!=='taxi'&&o.status==='in_progress')));
    if(active){
        const stableDriverKey=[active.id,active.status,active.info||'',active.client||'',active.price||0,active.clientLat||'',active.clientLng||'',active.destLat||'',active.destLng||'',active.driverVehicle||'',active.driverAvatar||''].join('|');
        if(_driverUiKey===stableDriverKey) return;
        _driverUiKey=stableDriverKey;
        const driverAction=active.status==='accepted'?`<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="startSharingLocation()">📍 Начать движение</button>`:active.status==='driver_arriving'?`<button class="btn btn-gold btn-sm" style="margin-top:8px;" onclick="beginTaxiTrip('${active.id}')">🚕 Клиент найден — начать поездку</button>`:active.status==='in_progress'?`<button class="btn btn-gold btn-sm" style="margin-top:8px;" onclick="finishTaxiTrip('${active.id}')">🏁 Завершить поездку</button>`:'';
        el.innerHTML=`<div class="work-order work-active"><div style="color:var(--primary);font-size:11px;font-weight:900;text-transform:uppercase;margin-bottom:8px;">🟢 Активный заказ</div><div style="font-weight:700;font-size:15px;margin-bottom:4px;">${escHtml(active.info)}</div>${active.address?`<div style="color:var(--muted);font-size:13px;margin-bottom:8px;">📍 ${escHtml(active.address)}</div>`:''}<div style="color:var(--muted);font-size:13px;margin-bottom:8px;">Клиент: <b style="color:var(--text)">${escHtml(active.client)}</b> · ${active.price}₽</div>${isDriver&&active.type==='taxi'?`<div style="font-size:13px;color:var(--primary);font-weight:900;margin-bottom:12px;">🛵 ${escHtml(active.driverVehicle||u.vehicle||'Транспорт не указан')}</div>`:''}<button class="btn btn-ghost" style="color:var(--red);border-color:var(--red-dim);font-size:12px;" onclick="abandonOrder('${active.id}')">⚠️ Отказаться (−35₽)</button>${driverAction}</div>`;
        const clientUser=allUsersCache[active.client]||{};const clientOnline=isUserOnline(clientUser);
        const clientCardId=isDriver?'driverClientCard':'deliveryClientCard';const clientInfoId=isDriver?'driverClientInfo':'deliveryClientInfo';
        const clientCardEl=qs(clientCardId),clientInfoEl=qs(clientInfoId);
        if(clientCardEl) clientCardEl.style.display='block';
        if(clientInfoEl) clientInfoEl.innerHTML=`<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;"><div class="av-wrap-sm ${clientOnline?'online':''}"><img src="${escHtml(clientUser.avatar||'https://cdn-icons-png.flaticon.com/512/149/149071.png')}" style="width:44px;height:44px;border-radius:13px;object-fit:cover;cursor:pointer;" loading="lazy" onclick="openUserProfile('${escHtml(active.client)}')"><div class="online-dot"></div></div><div><div style="font-weight:900;font-size:15px;cursor:pointer;" onclick="openUserProfile('${escHtml(active.client)}')">${escHtml(active.client)}</div><div style="font-size:11px;color:${clientOnline?'#22c55e':'var(--muted)'};">${clientOnline?'🟢 В сети':escHtml(getUserBusinessRoleLabel(clientUser, active.client))}</div></div></div><div style="display:flex;gap:8px;"><button class="btn btn-primary btn-sm" style="flex:1;" onclick="goToChat('${escHtml(active.client)}')">💬 Написать</button><button class="btn btn-ghost btn-sm" style="flex:1;" onclick="openUserProfile('${escHtml(active.client)}')">👤 Профиль</button></div>`;
        if(isDriver&&active.type==='taxi') setTimeout(()=>initDriverTrackMap(active.id,active.clientLat,active.clientLng,active.destLat,active.destLng),200);
        if(!isDriver&&active.type==='shop') setTimeout(()=>initDeliveryMap(active),200);
    } else {
        _driverUiKey='';
        const card=qs('driverTrackCard'); if(card) card.style.display='none';
        const dcc=qs('driverClientCard'); if(dcc) dcc.style.display='none';
        const dlcc=qs('deliveryClientCard'); if(dlcc) dlcc.style.display='none';
        const avail=ordersArr.filter(o=>o.type===type&&((type==='taxi'&&['pending','waiting'].includes(String(o.status||'')))||(type!=='taxi'&&o.status==='waiting')));
        el.innerHTML=avail.length===0?'<div style="color:var(--muted);text-align:center;padding:20px 0;">Нет заказов</div>':avail.map(o=>`<div class="work-order" style="margin-bottom:10px;"><div style="font-weight:700;margin-bottom:6px;">${escHtml(o.info)}</div>${o.distanceKm?`<div style="font-size:12px;color:var(--muted);">📏 ${o.distanceKm.toFixed(1)} км · ~${Math.ceil(o.distanceKm/MAX_SPEED_KMH*60)} мин</div>`:''} ${o.address?`<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">📍 ${escHtml(o.address)}</div>`:''}<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;"><span style="color:var(--primary);font-weight:900;">${o.price}₽</span><button class="btn btn-primary btn-sm" onclick="takeOrder('${o.id}')">✅ Взять</button></div></div>`).join('');
    }
    // Показываем кастомные заказы (из бизнесов/маркетплейса) тоже
    if (!isDriver && typeof renderDeliveryCustomOrders === 'function') {
        setTimeout(renderDeliveryCustomOrders, 200);
    }
}

// ─── DELIVERY MAP ─────────────────────────
let deliveryMapObj=null;
async function initDeliveryMap(order){
    await window.kapaniLoadLeaflet();
    const listEl=qs('deliveryList'); if(!listEl) return;
    let mapContainer=qs('deliveryMapContainer');
    if(!mapContainer){mapContainer=document.createElement('div');mapContainer.id='deliveryMapContainer';mapContainer.className='tracking-card';mapContainer.style.marginTop='12px';mapContainer.innerHTML=`<div class="tracking-live"><span class="pulse"></span>📍 Клиент</div><div id="deliveryMap" style="width:100%;height:260px;border-radius:var(--r-sm);overflow:hidden;border:1px solid var(--border);"></div><div id="deliveryMapInfo" style="margin-top:10px;font-size:13px;color:var(--muted);"></div>`;listEl.appendChild(mapContainer);}
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(deliveryMapObj){try{deliveryMapObj.remove();}catch(e){}deliveryMapObj=null;}
    const mapEl=qs('deliveryMap'); if(!mapEl) return;
    const hasCoords=order.addrLat&&order.addrLng;
    const center=hasCoords?[order.addrLat,order.addrLng]:[KAPANI_LAT,KAPANI_LNG];
    deliveryMapObj=L.map(mapEl,{center,zoom:hasCoords?16:14});
    addSatelliteLayer(deliveryMapObj);
    if(hasCoords){L.marker([order.addrLat,order.addrLng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:28px;height:28px;border-radius:50%;border:3px solid white;box-shadow:0 2px 14px rgba(240,68,74,.8);display:flex;align-items:center;justify-content:center;font-size:15px;">📍</div>',iconSize:[28,28],iconAnchor:[14,14],className:''})}).addTo(deliveryMapObj).bindPopup(`<b>📍 Адрес доставки</b><br>${escHtml(order.address||'')}`).openPopup();}
    const infoEl=qs('deliveryMapInfo');
    if(hasCoords&&infoEl){try{const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:5000}));const dist=haversine(pos.coords.latitude,pos.coords.longitude,order.addrLat,order.addrLng);const eta=Math.ceil(dist/MAX_SPEED_KMH*60);infoEl.innerHTML=`📏 До клиента: <b style="color:var(--primary)">${dist.toFixed(2)} км</b> · ⏱ ~<b style="color:var(--gold)">${eta} мин</b>`;}catch(e){if(infoEl)infoEl.textContent=`📍 Адрес: ${order.address||'не указан'}`;}}
    else if(infoEl) infoEl.innerHTML=`⚠️ Нет координат. Адрес: <b>${escHtml(order.address||'не указан')}</b>`;
}

// ─── IMAGE HELPERS ────────────────────────
function compressImage(file,maxPx,quality){
    maxPx=maxPx||600;quality=quality||0.75;
    return new Promise(function(resolve){
        const reader=new FileReader();
        reader.onload=function(e){const img=new Image();img.onload=function(){const scale=Math.min(1,maxPx/Math.max(img.width,img.height));const w=Math.round(img.width*scale),h=Math.round(img.height*scale);const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(img,0,0,w,h);resolve(canvas.toDataURL('image/jpeg',quality));};img.src=e.target.result;};
        reader.readAsDataURL(file);
    });
}
window.handleAvatarUpload=async function(e){
    const file=e.target.files[0];if(!file)return;
    const snap=await get(userRef(currentNick));
    const u=snap.val()||{};
    
    // Check if video - video avatars are no longer supported
    if(file.type.startsWith('video/')){
        return toast('❌ Видео-аватары больше не поддерживаются','red');
    }
    
    // Image avatar
    const dataUrl=await compressImage(file,800,0.8);
    try { await patchOwnProfile({avatar:dataUrl}); }
    catch(err){ toast('Не удалось сохранить аватарку: '+err.message,'red'); return; }
    toggleAvatarMedia(qs('uAv'), qs('uAvVideo'), dataUrl);
    toggleAvatarMedia(qs('hAv'), qs('hAvVideo'), dataUrl);
    if(!u.rewardedAvatar){await claimOneTimeTask('rewardedAvatar',REWARD_CUSTOM_AVATAR);}
    else toast('✅ Аватарка обновлена','green');
};

// Profile Customization Functions
let primeCoverSaved = '';
let primeCoverPending = '';
window.openProfileCustomizer=async function(){
    const snap=await get(userRef(currentNick));
    const u=snap.val()||{};
    primeCoverSaved = validPrimeCoverData(u.profileCustomBg) ? u.profileCustomBg : '';
    primeCoverPending = '';
    const hasPlus = (u.subscription === 'plus' || u.subscription === 'ultra' || u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasUltra = (u.subscription === 'ultra' || u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasPrime = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    let frameOptions = '';
    if(hasUltra){
        frameOptions = `
            <option value="">Без рамки</option>
            <option value="gold">🥇 Золотая (Plus)</option>
            <option value="rainbow">🌈 Радужная (Ultra)</option>
            <option value="pulse">💓 Пульсирующая (Plus)</option>
            <option value="glow">✨ Свечение (Ultra)</option>
            <option value="neon">💫 Неоновая (Plus)</option>
            <option value="fire">🔥 Огненная (Ultra)</option>
            <option value="crystal">💎 Кристальная (Ultra)</option>
            <option value="ice">❄️ Ледяная (Plus)</option>
            <option value="rose">🌹 Розовая (Ultra)</option>
            <option value="plasma">⚡ Плазма (Ultra)</option>
            <option value="thunder">⚡ Гром (Ultra)</option>
            <option value="hologram">👻 Голограф (Ultra)</option>
            <option value="dragon">🐲 Дракон (Ultra)</option>
            ${hasPrime ? "<option value=\"prime\">👑 Kapani Prime (переливающаяся)</option>" : ""}
        `;
    } else if(hasPlus){
        frameOptions = `
            <option value="">Без рамки</option>
            <option value="gold">🥇 Золотая (Plus)</option>
            <option value="pulse">💓 Пульсирующая (Plus)</option>
            <option value="neon">💫 Неоновая (Plus)</option>
            <option value="ice">❄️ Ледяная (Plus)</option>
            <option value="" disabled>──────────</option>
            <option value="" disabled>🔒 Ultra: Радужная, Свечение, Огненная, Кристальная, Розовая, Плазма, Гром, Голограф, Дракон</option>
        `;
    }
    
    let bgOptions = '';
    if(hasUltra){
        bgOptions = `
            <option value="">Стандартный</option>
            <option value="shimmer">✨ Мерцание (Plus)</option>
            <option value="particles">🔮 Частицы (Plus)</option>
            <option value="gradient">🌊 Градиент (Ultra)</option>
            <option value="ocean">🌊 Океан (Plus)</option>
            <option value="sunset">🌅 Закат (Plus)</option>
            <option value="aurora">🌌 Аврора (Ultra)</option>
            <option value="galaxy">🌌 Галактика (Ultra)</option>
            <option value="fire">🔥 Огонь (Ultra)</option>
            <option value="plasma">⚡ Плазма (Ultra)</option>
            <option value="thunder">⚡ Гром (Ultra)</option>
            <option value="hologram">👻 Голограф (Ultra)</option>
            <option value="dragon">🐲 Дракон (Ultra)</option>
            ${hasPrime ? "<option value=\"prime\">👑 Kapani Prime (переливающаяся)</option>" : ""}
        `;
    } else if(hasPlus){
        bgOptions = `
            <option value="">Стандартный</option>
            <option value="shimmer">✨ Мерцание (Plus)</option>
            <option value="particles">🔮 Частицы (Plus)</option>
            <option value="ocean">🌊 Океан (Plus)</option>
            <option value="sunset">🌅 Закат (Plus)</option>
            <option value="" disabled>──────────</option>
            <option value="" disabled>🔒 Ultra: Градиент, Аврора, Галактика, Огонь, Плазма, Гром, Голограф, Дракон</option>
        `;
    }
    
    let chatBgOptions = '';
    if(hasUltra){
        chatBgOptions = `
            <option value="">Стандартный</option>
            <option value="gold">🥇 Золотой (Plus)</option>
            <option value="rainbow">🌈 Радужный (Ultra)</option>
            <option value="ocean">🌊 Океанский (Plus)</option>
            <option value="sunset">🌅 Закатный (Plus)</option>
            <option value="aurora">🌌 Аврора (Ultra)</option>
            <option value="galaxy">🌌 Галактика (Ultra)</option>
            <option value="fire">🔥 Огненный (Ultra)</option>
            <option value="neon">💫 Неоновый (Plus)</option>
            <option value="rose">🌹 Розовый (Ultra)</option>
            ${hasPrime ? '<option value="prime">👑 Kapani Prime (переливающийся)</option>' : ''}
        `;
    } else if(hasPlus){
        chatBgOptions = `
            <option value="">Стандартный</option>
            <option value="gold">🥇 Золотой (Plus)</option>
            <option value="ocean">🌊 Океанский (Plus)</option>
            <option value="sunset">🌅 Закатный (Plus)</option>
            <option value="neon">💫 Неоновый (Plus)</option>
            <option value="" disabled>──────────</option>
            <option value="" disabled>🔒 Ultra: Радужный, Аврора, Галактика, Огненный, Розовый</option>
        `;
    }

    // One coherent forest / nature / wild catalogue shared by frames,
    // profile backgrounds and chat bubbles. Older purchases stay valid.
    const skinTier = hasPrime ? 3 : hasUltra ? 2 : hasPlus ? 1 : 0;
    const skinGroups = [
        ['Лесные', [
            ['forest_moss', 'Мох и хвоя', 1],
            ['forest_dusk', 'Хвойные сумерки', 2]
        ]],
        ['Природные', [
            ['nature_meadow', 'Лесной луг', 1],
            ['nature_aurora', 'Дыхание природы', 2]
        ]],
        ['Дикие', [
            ['wild_ember', 'Янтарный зверь', 2],
            ['wild_storm', 'Буря тайги', 3]
        ]]
    ];
    const natureOptions = skinGroups.map(([group, items]) => {
        const permitted = items.filter(([, , minimumTier]) => skinTier >= minimumTier);
        return permitted.length
            ? `<optgroup label="${group}">${permitted.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</optgroup>`
            : '';
    }).join('');
    frameOptions += natureOptions;
    bgOptions += natureOptions;
    chatBgOptions += natureOptions;
    if(hasPrime) bgOptions += '<optgroup label="Kapani Prime"><option value="custom">Своё изображение</option></optgroup>';
    
    // Interface theme options
    let themeOptions = '';
    if(hasUltra || hasPlus){
        themeOptions = `
            <option value="default">🌙 Стандартная (тёмная)</option>
            <option value="gold">⭐ Золотая (Plus)</option>
        `;
    }
    
    const modalHtml = `
        <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-end;justify-content:center;" onclick="if(event.target===this)closeProfileCustomizer()">
            <div class="kapani-customizer-sheet" style="background:#0c271c;border-radius:24px 24px 0 0;width:100%;max-width:490px;max-height:80vh;overflow-y:auto;padding:24px 18px 44px;animation:sheetUp .3s ease-out;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                    <div style="font-weight:900;font-size:18px;">🎨 Настройка профиля</div>
                    <span style="cursor:pointer;font-size:20px;" onclick="closeProfileCustomizer()">✕</span>
                </div>
                
                ${hasPlus ? `
                <div style="margin-bottom:20px;">
                    <div style="font-weight:800;font-size:14px;margin-bottom:10px;">🖼 Рамка аватара</div>
                    <select id="avatarFrameSelect" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);" onchange="previewAvatarFrame(this.value)">
                        ${frameOptions}
                    </select>
                </div>
                
                <div style="margin-bottom:20px;">
                    <div style="font-weight:800;font-size:14px;margin-bottom:10px;">🎨 Фон профиля</div>
                    <select id="profileBgSelect" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);" onchange="previewProfileBg(this.value)">
                        ${bgOptions}
                    </select>
                </div>
                ${hasPrime ? `<div id="primeCoverUploadWrap" style="display:none;margin:-8px 0 18px;">
                    <label class="btn btn-ghost btn-sm" style="display:inline-flex;cursor:pointer;align-items:center;" for="primeCoverInput">Выбрать изображение с устройства</label>
                    <input id="primeCoverInput" type="file" accept="image/*" style="display:none" onchange="handlePrimeCoverSelection(event)">
                    <div id="primeCoverUploadStatus" style="font-size:12px;color:var(--muted);margin-top:7px;">Изображение будет сохранено вместе с настройками. До 5 МБ.</div>
                </div>` : ''}
                
                <div style="margin-bottom:20px;">
                    <div style="font-weight:800;font-size:14px;margin-bottom:10px;">💬 Фон сообщений</div>
                    <select id="chatBgSelect" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);" onchange="previewChatBg(this.value)">
                        ${chatBgOptions}
                    </select>
                </div>

                <div class="kapani-skin-preview" id="kapaniSkinPreview">
                    <div class="kapani-preview-avatar"><div id="kapaniPreviewAvatarFrame" class="avatar-frame"></div><span>К</span></div>
                    <div class="kapani-preview-profile" id="kapaniPreviewProfile">
                        <strong>Пример оформления</strong>
                        <div class="chat-bubble" id="kapaniPreviewChat">Так будет выглядеть сообщение</div>
                    </div>
                </div>
                
                ` : '<div style="text-align:center;color:var(--muted);padding:20px;">Нужна подписка для кастомизации</div>'}
                
                <div style="display:flex;gap:10px;">
                    <button class="btn btn-ghost" style="flex:1;" onclick="closeProfileCustomizer()">Отмена</button>
                    ${hasPlus ? `<button class="btn btn-primary" style="flex:1;" onclick="saveProfileCustomization()">💾 Сохранить</button>` : ''}
                </div>
            </div>
        </div>
    `;
    
    // Set current values
    const modal = document.createElement('div');
    modal.id = 'profileCustomizerModal';
    modal.innerHTML = modalHtml;
    document.body.appendChild(modal);
    
    // Set current selections
    setTimeout(() => {
        const emojiSelect = qs('nicknameEmojiSelect');
        const frameSelect = qs('avatarFrameSelect');
        const bgSelect = qs('profileBgSelect');
        const chatSelect = qs('chatBgSelect');
        const themeSelect = qs('interfaceThemeSelect');
        if(emojiSelect) emojiSelect.value = u.nicknameEmoji || '';
        if(frameSelect) frameSelect.value = u.avatarFrame || '';
        if(bgSelect) bgSelect.value = u.profileBgEffect || '';
        if(chatSelect) chatSelect.value = u.chatBubbleStyle || '';
        if(themeSelect) themeSelect.value = u.interfaceTheme || 'default';
        updateKapaniSkinPreview();
        updatePrimeCoverUploadVisibility();
    }, 10);
};

window.closeProfileCustomizer=async function(){
    const modal = qs('profileCustomizerModal');
    if(modal) modal.remove();
    primeCoverPending = '';
    // Cancel means cancel: restore the saved frame, wall and message skins.
    try {
        const snap = await get(userRef(currentNick));
        const u = snap.val() || {};
        primeCoverSaved = validPrimeCoverData(u.profileCustomBg) ? u.profileCustomBg : '';
        previewAvatarFrame(u.avatarFrame || '');
        previewProfileBg(u.profileBgEffect || '');
        previewChatBg(u.chatBubbleStyle || '');
        applyInterfaceTheme(u.interfaceTheme || 'default');
    } catch (e) { console.debug('[Kapani profile] restore customization:', e); }
};

window.previewNicknameEmoji=function(emoji){
    // Preview function - could update a preview element if needed
};

function updatePrimeCoverUploadVisibility(){
    const wrap = qs('primeCoverUploadWrap');
    if(wrap) wrap.style.display = qs('profileBgSelect')?.value === 'custom' ? 'block' : 'none';
}

async function compressPrimeCover(file){
    if(!file || !['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.type)) throw new Error('Выберите JPG, PNG, WebP или фото с телефона');
    if(file.size > 5 * 1024 * 1024) throw new Error('Файл должен быть не больше 5 МБ');
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Не удалось открыть изображение'));
            img.src = url;
        });
        if(!img.naturalWidth || !img.naturalHeight) throw new Error('Повреждённое изображение');
        // Store a bounded JPEG instead of a multi-megabyte original in RTDB.
        for(const [maxPx, quality] of [[1300,.72],[1100,.65],[950,.58],[800,.52],[640,.48]]){
            const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1,Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1,Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            if(!ctx) throw new Error('Не удалось подготовить изображение');
            ctx.fillStyle = '#133426';
            ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(img,0,0,canvas.width,canvas.height);
            const data = canvas.toDataURL('image/jpeg', quality);
            if(validPrimeCoverData(data)) return data;
        }
        throw new Error('Не удалось сжать изображение до нужного размера');
    } finally { URL.revokeObjectURL(url); }
}

window.handlePrimeCoverSelection=async function(event){
    const file = event.target?.files?.[0];
    if(!file) return;
    const status = qs('primeCoverUploadStatus');
    if(status) status.textContent = 'Подготавливаем изображение…';
    try {
        primeCoverPending = await compressPrimeCover(file);
        if(qs('profileBgSelect')) qs('profileBgSelect').value = 'custom';
        if(status) status.textContent = 'Изображение готово. Нажмите «Сохранить».';
        previewProfileBg('custom');
    } catch(err) {
        if(status) status.textContent = err.message || 'Не удалось прочитать файл';
        toast('Не удалось загрузить фон: ' + (err.message || 'ошибка'), 'red');
    } finally { event.target.value = ''; }
};

function updateKapaniSkinPreview(){
    const frame = qs('kapaniPreviewAvatarFrame');
    const wall = qs('kapaniPreviewProfile');
    const message = qs('kapaniPreviewChat');
    if(frame){
        frame.className = 'avatar-frame';
        if(AVATAR_FRAME_CLASSES[qs('avatarFrameSelect')?.value]) frame.classList.add(AVATAR_FRAME_CLASSES[qs('avatarFrameSelect').value]);
    }
    if(wall){
        wall.classList.remove(...PROFILE_EFFECT_CLASSES);
        const effect = qs('profileBgSelect')?.value;
        if(PROFILE_BG_CLASSES[effect]) wall.classList.add(PROFILE_BG_CLASSES[effect]);
        applyPrimeCoverToElement(wall, effect, primeCoverPending || primeCoverSaved);
    }
    if(message){
        message.classList.remove(...Object.values(CHAT_BUBBLE_CLASSES));
        if(CHAT_BUBBLE_CLASSES[qs('chatBgSelect')?.value]) message.classList.add(CHAT_BUBBLE_CLASSES[qs('chatBgSelect').value]);
    }
}

window.previewAvatarFrame=function(frame){
    const frameEl = qs('avatarFrame');
    if(!frameEl) return;
    const cls = AVATAR_FRAME_CLASSES[frame];
    frameEl.style.display = cls ? 'block' : 'none';
    frameEl.className = 'avatar-frame';
    if(cls) frameEl.classList.add(cls);
    updateKapaniSkinPreview();
};

window.previewProfileBg=function(effect){
    const headerBg = qs('profileHeaderBg');
    if(!headerBg) return;
    headerBg.classList.remove(...PROFILE_EFFECT_CLASSES);
    const cls = PROFILE_BG_CLASSES[effect];
    if(cls) headerBg.classList.add(cls);
    applyPrimeCoverToElement(headerBg, effect, primeCoverPending || primeCoverSaved);
    updatePrimeCoverUploadVisibility();
    updateKapaniSkinPreview();
};

window.previewChatBg=function(style){
    // Own messages carry .me on their parent, not on .chat-bubble itself.
    const bubbles = document.querySelectorAll('.chat-msg.me .chat-bubble');
    bubbles.forEach(b => {
        b.classList.remove(...Object.values(CHAT_BUBBLE_CLASSES));
        if(CHAT_BUBBLE_CLASSES[style]) b.classList.add(CHAT_BUBBLE_CLASSES[style]);
    });
    updateKapaniSkinPreview();
};

window.previewInterfaceTheme=function(theme){
    // Shared site appearance takes precedence over legacy personal themes.
    document.body.classList.remove('theme-gold', 'theme-prime');
};

window.applyInterfaceTheme=function(theme){
    document.body.classList.remove('theme-gold', 'theme-prime');
};
window.saveProfileCustomization=async function(){
    const emojiSelect = qs('nicknameEmojiSelect');
    const frameSelect = qs('avatarFrameSelect');
    const bgSelect = qs('profileBgSelect');
    const chatSelect = qs('chatBgSelect');
    const themeSelect = qs('interfaceThemeSelect');
    if(bgSelect?.value === 'custom'){
        const snap = await get(userRef(currentNick));
        const u = snap.val() || {};
        if(u.subscription !== 'prime' || !hasActiveSubscription(u)){
            toast('Свой фон доступен только с активным Kapani Prime', 'red');
            return;
        }
        if(!validPrimeCoverData(primeCoverPending || primeCoverSaved)){
            toast('Сначала выберите изображение для фона', 'red');
            return;
        }
    }
    
    const updates = {};
    if(emojiSelect) updates.nicknameEmoji = emojiSelect.value || null;
    if(frameSelect) updates.avatarFrame = frameSelect.value || null;
    if(bgSelect) updates.profileBgEffect = bgSelect.value || null;
    if(bgSelect?.value === 'custom' && primeCoverPending) updates.profileCustomBg = primeCoverPending;
    if(chatSelect) updates.chatBubbleStyle = chatSelect.value || null;
    // Preserve previously saved interfaceTheme data without overriding the site theme.
    try { await update(userRef(currentNick), updates); }
    catch(err){ toast('Не удалось сохранить фон: '+(err?.message||'ошибка'),'red'); return; }
    if(allUsersCache[currentNick]) Object.assign(allUsersCache[currentNick], updates);
    // Chat's HTML signature doesn't include style choices, so force a rerender
    // immediately rather than waiting for the next incoming message.
    for(const id of ['chatMessages', 'dmMessages']){
        const list=qs(id);if(list) delete list.dataset.sig;
    }
    if(typeof renderChat==='function') void renderChat(lastChatMsgs);
    if(typeof renderDmMessages==='function') void renderDmMessages(lastDmMsgs);
    toast('✅ Настройки сохранены', 'green');
    void closeProfileCustomizer();
};

window.changeAvatarUrl=async function(){
    const url=prompt('Введите URL изображения:');
    if(url===null)return;
    if(!/^https:\/\/\S+$/i.test(url))return toast('Нужна ссылка HTTPS','red');
    try{
        await patchOwnProfile({avatar:url});
        if(!url.includes('flaticon'))await claimOneTimeTask('rewardedAvatar',REWARD_CUSTOM_AVATAR);
        toast('🖼 Аватарка обновлена!','green');
    }catch(e){toast('Не удалось сохранить аватарку: '+e.message,'red');}
};
window.changeDisplayName=async function(){
    const oldNick = currentNick;
    const snap = await get(userRef(oldNick));
    if(!snap.exists()) return;
    const u = snap.val() || {};
    const cur = displayNick(u) || oldNick;
    const v = prompt('Ваше отображаемое имя в Капани (для входа и переводов):',cur);
    if(v===null) return;
    const t = v.trim().slice(0,40);
    if(!t) return toast('⚠️ Имя не может быть пустым','gold');
    // Supabase Auth login IDs and chat references use the immutable account
    // key. Changing the public name must not copy or delete somebody's data.
    // The public name is resolved to that stable key at login.
    try { await patchOwnProfile({displayName:t}); }
    catch(e){ return toast('Не удалось изменить имя: '+e.message,'red'); }
    try{
        const auth = JSON.parse(localStorage.getItem('kp_auth') || 'null') || {};
        localStorage.setItem('kp_auth', JSON.stringify({...auth, nick:oldNick, name:t, displayName:t}));
    }catch(e){}
    const fresh = {...u, displayName:t};
    allUsersCache[oldNick] = fresh;
    window.allUsersCache = allUsersCache;
    updateHeader(fresh);
    toast('✅ Имя обновлено. Идентификатор аккаунта сохранён','green');
};
window.changePassword=async function(){
    // Passwords belong to Supabase Auth, never to the public user JSON.
    const cur = prompt('Введите текущий пароль:');
    if(cur===null)return;
    if(!cur)return toast('Укажите текущий пароль','red');
    const {data:identity,error:identityError}=await supabase.auth.getUser();
    if(identityError || !identity?.user?.email) return toast('Сначала войдите в аккаунт повторно','red');
    const {error:checkError}=await supabase.auth.signInWithPassword({email:identity.user.email,password:cur});
    if(checkError)return toast('Текущий пароль неверный','red');
    const next = prompt('Введите новый пароль (минимум 8 символов):');
    if(next===null) return;
    if(String(next).length < 8) return toast('⚠️ Пароль должен быть не короче 8 символов','gold');
    const confirmNext = prompt('Повторите новый пароль:');
    if(confirmNext===null) return;
    if(next !== confirmNext) return toast('❌ Пароли не совпадают','red');
    const {error}=await supabase.auth.updateUser({password:next});
    if(error)return toast('Не удалось сменить пароль: '+error.message,'red');
    _kapaniSessionPassword=next;
    toast('✅ Пароль обновлён','green');
};
window.saveDisplayJob=async function(){
    const sel=qs('jobTitleSelect'); if(!sel) return;
    const role=sel.value;
    if(!role) return;
    await update(userRef(currentNick), { displayJob: role });
    toast('✅ Звание обновлено','green');
    const snap=await get(userRef(currentNick)); if(snap.exists()) updateHeader(snap.val());
};
window.savingsDeposit=async function(){
    if(!await requireSpendable()) return;
    const amt=parseInt(qs('savingsAmt')?.value||'0',10)||0;
    if(amt<=0) return toast('⚠️ Введите сумму','gold');
    const snap=await get(userRef(currentNick)); const u=snap.val()||{};
    if((u.balance||0)<amt) return toast('❌ Недостаточно средств','red');
    const savings = Number(u.savingsBalance||0)+amt;
    await update(userRef(currentNick), { balance: (u.balance||0)-amt, savingsBalance: savings, savingsLastInterestAt: u.savingsLastInterestAt || Date.now() });
    await logTx(currentNick, { type:'out', who:'Накопительный счёт', amt, desc:'Пополнение накопительного счёта' });
    if(qs('savingsAmt')) qs('savingsAmt').value='';
    toast(`📈 +${amt}₽ на накопительный счёт`,'green');
    renderSavingsDisplay();
};
window.savingsWithdraw=async function(){
    const amt=parseInt(qs('savingsAmt')?.value||'0',10)||0;
    if(amt<=0) return toast('⚠️ Введите сумму','gold');
    const snap=await get(userRef(currentNick)); const u=snap.val()||{};
    if((u.savingsBalance||0)<amt) return toast('❌ Недостаточно на накопительном счёте','red');
    await update(userRef(currentNick), { balance: (u.balance||0)+amt, savingsBalance: (u.savingsBalance||0)-amt });
    await logTx(currentNick, { type:'in', who:'Накопительный счёт', amt, desc:'Снятие с накопительного счёта' });
    if(qs('savingsAmt')) qs('savingsAmt').value='';
    toast(`💰 Снято ${amt}₽ с накопительного счёта`,'green');
    renderSavingsDisplay();
};
function renderSavingsDisplay(){
    const el=qs('savingsBalanceDisplay');
    const rateEl=qs('savingsRateDisplay');
    const u=allUsersCache[currentNick]||{};
    const savings=Number(u.savingsBalance||0);
    if(el) el.textContent=savings.toLocaleString()+' ₽';
    if(rateEl && typeof getSavingsRateLabel==='function') rateEl.textContent=getSavingsRateLabel(savings);
}
window.editProfileDescription=async function(){
    const snap=await get(userRef(currentNick));
    const u=snap.val()||{};
    const current=u.profileDescription||'';
    const newDesc=prompt('Расскажите о себе (максимум 200 символов):',current);
    if(newDesc===null)return;
    const trimmed=newDesc.trim().slice(0,200);
    try{
        await update(userRef(currentNick),{profileDescription:trimmed||null});
        const updated={...u,profileDescription:trimmed||''};
        allUsersCache[currentNick]=updated;
        updateHeader(updated);
        toast('✅ Описание обновлено','green');
    }catch(error){
        console.error('[editProfileDescription]',error);
        toast('❌ Не удалось изменить описание: '+(error?.message||'ошибка'),'red');
    }
};
window.changeAvatar=window.changeAvatarUrl;
window.handleMktPhoto=async function(e){const file=e.target.files[0];if(!file)return;toast('📷 Сжимаем...','gold');const dataUrl=await compressImage(file,900,0.82);qs('mktPhoto').value='';qs('mktPhotoImg').src=dataUrl;qs('mktPhotoPreview').style.display='block';window._mktPhotoData=dataUrl;e.target.value='';};

// ─── SHOP MAP ─────────────────────────────
function createShopMarker(lat,lng){return L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 2px 10px rgba(240,68,74,.6);">📍</div>',iconSize:[22,22],iconAnchor:[11,11],className:''})});}
async function initShopMapIfNeeded(){
    await window.kapaniLoadLeaflet();
    if(shopMapObj){shopMapObj.invalidateSize();return;}
    shopMapObj=L.map('shopMap',{center:[KAPANI_LAT,KAPANI_LNG],zoom:15});
    addSatelliteLayer(shopMapObj);
    shopMapObj.on('click',function(e){const{lat,lng}=e.latlng;shopAddrCoords={lat,lng};if(shopMarker)shopMapObj.removeLayer(shopMarker);shopMarker=createShopMarker(lat,lng).addTo(shopMapObj).bindPopup('📍 Адрес').openPopup();reverseGeocode(lat,lng).then(name=>{qs('sAddr').value=name;});});
}
window.toggleShopMap=function(){const el=qs('shopMap'),toggleBtn=qs('shopMapToggleBtn'),willShow=!el.classList.contains('visible');el.classList.toggle('visible',willShow);if(toggleBtn)toggleBtn.textContent=willShow?'🗺 Скрыть карту':'🗺 Выбрать на карте';if(!willShow)return;requestAnimationFrame(()=>requestAnimationFrame(async()=>{try{await initShopMapIfNeeded();shopMapObj.invalidateSize();toast('🗺 Кликните для выбора','gold');}catch(e){toast('❌ Не удалось загрузить карту','red');}}));};
window.detectShopLocation=function(){if(!navigator.geolocation)return toast('❌ Геолокация недоступна','red');const el=qs('shopMap'),toggleBtn=qs('shopMapToggleBtn');if(!el.classList.contains('visible')){el.classList.add('visible');if(toggleBtn)toggleBtn.textContent='🗺 Скрыть карту';}requestAnimationFrame(()=>requestAnimationFrame(async()=>{try{await initShopMapIfNeeded();shopMapObj.invalidateSize();}catch(e){toast('❌ Не удалось загрузить карту','red');return;}navigator.geolocation.getCurrentPosition(function(pos){const lat=pos.coords.latitude,lng=pos.coords.longitude;shopAddrCoords={lat,lng};if(shopMarker)shopMapObj.removeLayer(shopMarker);shopMarker=createShopMarker(lat,lng).addTo(shopMapObj).bindPopup('📍 Я').openPopup();shopMapObj.setView([lat,lng],16);reverseGeocode(lat,lng).then(name=>{qs('sAddr').value=name;});toast('📍 Определено','green');},function(){toast('❌ Нет геолокации','red');},{enableHighAccuracy:true,timeout:8000});}));};

// ─── SHOP ─────────────────────────────────
window.recalcShop=function(){
    const itemsTotal=(parseInt(qs('sB').value)||0)*250+(parseInt(qs('sP').value)||0)*30+(parseInt(qs('sL').value)||0)*3+(parseInt(qs('sK').value)||0)*100;
    const hasItems = itemsTotal > 0;
    const deliveryFee = hasItems ? 30 : 0;
    const total = itemsTotal + deliveryFee;
    qs('sTotal').textContent=total;
    // Update delivery note
    const delivNote = qs('shopDeliveryNote');
    if(delivNote) delivNote.style.display = hasItems ? 'block' : 'none';
};
window.buyShop=async function(){
    if(!await requireSpendable())return;
    const uSnap=await get(userRef(currentNick));const u=uSnap.val()||{};
    const b=parseInt(qs('sB').value)||0,p=parseInt(qs('sP').value)||0,l=parseInt(qs('sL').value)||0,k=parseInt(qs('sK').value)||0;
    if(b+p+l+k<=0)return toast('⚠️ Выберите товары','gold');
    const addr=qs('sAddr').value.trim();
    if(!addr)return toast('⚠️ Укажите адрес','gold');
    // Цены соответствуют отображаемым в магазине + 30₽ за доставку
    const itemsTotal=b*250+p*30+l*3+k*100;
    const DELIVERY_FEE = 30;
    const total = itemsTotal + DELIVERY_FEE;
    
    // Apply subscription discount
    const isSubActive = u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasPlus = (u.subscription === 'plus' || u.subscription === 'ultra' || u.subscription === 'prime') && isSubActive;
    const hasUltra = (u.subscription === 'ultra' || u.subscription === 'prime') && isSubActive;
    const hasPrime = u.subscription === 'prime' && isSubActive;
    let discountPercent = 0;
    if(hasPrime){ discountPercent = 20; }
    else if(hasUltra){ discountPercent = 10; }
    else if(hasPlus){ discountPercent = 5; }
    
    const finalTotal = Math.max(1, Math.round(total * (1 - discountPercent / 100)));
    
    if(u.balance<finalTotal)return toast(`❌ Недостаточно средств (нужно ${finalTotal}₽${discountPercent > 0 ? ` с учётом скидки -${discountPercent}%` : ''})`,'red');
    const items=[`🌲×${b}`,`🥢×${p}`,`🍃×${l}`,`🗿×${k}`].filter(i=>!i.endsWith('×0')).join(', ');
    
    try {
        // Вызываем Cloud Function с fallback
        const result = await fallbackCreateOrder({
            type: 'shop',
            info: items,
            price: finalTotal,
            originalPrice: total,
            discountApplied: discountPercent,
            address: addr,
            distanceKm: 0,
            clientLat: shopAddrCoords?.lat || null,
            clientLng: shopAddrCoords?.lng || null,
            destLat: null,
            destLng: null
        });
        
        if (result.success) {
            await pushNotification(currentNick,`📦 Заказ: ${items} — ${finalTotal}₽${discountPercent > 0 ? ` (скидка ${discountPercent}%)` : ''} (вкл. доставка 30₽)`);
            try{
                const workersSnap=await get(query(ref(db,'users'),orderByChild('job'),equalTo('Доставщик')));
                const workers=workersSnap.val()||{};
                await Promise.all(Object.keys(workers).filter(nick=>nick!==currentNick).map(nick=>pushNotification(nick,`📦 Новый заказ: ${items} → ${escHtml(addr)} — ${finalTotal}₽`,'delivery_orders')));
            }catch(e){console.error('[notification pipeline][delivery order]',e);}
            ['sB','sP','sL','sK'].forEach(i=>qs(i).value=0);qs('sAddr').value='';shopAddrCoords=null;if(shopMarker&&shopMapObj){shopMapObj.removeLayer(shopMarker);shopMarker=null;}recalcShop();
            toast(`📦 Заказ оформлен!${discountPercent > 0 ? ' Скидка ' + discountPercent + '% применена!' : ''}`,'green');
        }
    } catch (error) {
        console.error('Ошибка заказа:', error);
        const message = error.message || 'Ошибка при оформлении заказа';
        toast(`❌ ${message}`,'red');
    }
};

function addSatelliteLayer(map){
    // Kapani uses a single hybrid map everywhere: current satellite/aerial imagery
    // plus a readable reference overlay with roads, city/place names and boundaries.
    // World Imagery is the base; the reference layer is intentionally transparent.
    const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Tiles © Esri',maxZoom:19});
    const reference=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{attribution:'Reference © Esri',maxZoom:19,pane:'overlayPane'});
    const transportation=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',{attribution:'Transportation © Esri',maxZoom:19,pane:'overlayPane',opacity:0.92});
    imagery.addTo(map);
    try{ reference.addTo(map); transportation.addTo(map); }catch(e){}
    return imagery;
}

// ─── TAXI MAP ─────────────────────────────
let taxiMapInitPromise=null;
window.initTaxiMap=async function(){
    if(taxiMap){taxiMap.invalidateSize();return taxiMap;}
    if(taxiMapInitPromise) return taxiMapInitPromise;
    taxiMapInitPromise=(async()=>{
        await window.kapaniLoadLeaflet();
        if(taxiMap)return taxiMap;
        const el=qs('taxiMap');if(!el)return null;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        if(taxiMap)return taxiMap;
        taxiMap=L.map(el,{center:[KAPANI_LAT,KAPANI_LNG],zoom:15});
        addSatelliteLayer(taxiMap);
        taxiMap.on('click',onMapClick);
        return taxiMap;
    })();
    try{return await taxiMapInitPromise;}finally{taxiMapInitPromise=null;}
};
function onMapClick(e){if(!selectingPoint)return;const{lat,lng}=e.latlng;if(selectingPoint==='from'){setFromPoint(lat,lng);reverseGeocode(lat,lng).then(name=>{qs('tFrom').value=name;});}else{setToPoint(lat,lng);reverseGeocode(lat,lng).then(name=>{qs('tTo').value=name;});}selectingPoint=null;qs('btnFromMap').classList.remove('selecting');qs('btnToMap').classList.remove('selecting');}
function setFromPoint(lat,lng){fromCoords={lat,lng};if(fromMarker)taxiMap.removeLayer(fromMarker);fromMarker=L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(taxiMap).bindPopup('📍 Откуда');updateTaxiCalc();}
function setToPoint(lat,lng){toCoords={lat,lng};if(toMarker)taxiMap.removeLayer(toMarker);toMarker=L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#ff806a;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(taxiMap).bindPopup('🏁 Куда');updateTaxiCalc();}
function updateTaxiCalc(){if(!fromCoords||!toCoords)return;const dist=haversine(fromCoords.lat,fromCoords.lng,toCoords.lat,toCoords.lng);const price=Math.round(dist*PRICE_PER_KM);const timeMin=Math.ceil(dist/MAX_SPEED_KMH*60);qs('tDist').textContent=dist.toFixed(1);qs('tTime').textContent=timeMin;qs('tPrice').textContent=price;qs('taxiInfoRow').style.display='flex';qs('btnCallTaxi').disabled=false;if(routeLine)taxiMap.removeLayer(routeLine);routeLine=L.polyline([[fromCoords.lat,fromCoords.lng],[toCoords.lat,toCoords.lng]],{color:'#f0444a',weight:3,dashArray:'6,6'}).addTo(taxiMap);taxiMap.fitBounds([[fromCoords.lat,fromCoords.lng],[toCoords.lat,toCoords.lng]],{padding:[30,30]});}
window.startSelectPoint=function(which){selectingPoint=which;qs('btnFromMap').classList.toggle('selecting',which==='from');qs('btnToMap').classList.toggle('selecting',which==='to');toast(which==='from'?'📍 Кликните — отправление':'🏁 Кликните — назначение','gold');};
window.detectMyLocation=function(){if(!navigator.geolocation)return toast('❌ Геолокация недоступна','red');toast('📍 Определяем...','gold');navigator.geolocation.getCurrentPosition(pos=>{const{latitude:lat,longitude:lng}=pos.coords;setFromPoint(lat,lng);reverseGeocode(lat,lng).then(name=>{qs('tFrom').value=name;});taxiMap.setView([lat,lng],16);},()=>toast('❌ Нет геолокации','red'));};
async function reverseGeocode(lat,lon){try{const res=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ru`);const d=await res.json();if(d&&d.address){const a=d.address;return[a.road||a.pedestrian||a.hamlet,a.village||a.town||a.city||a.suburb].filter(Boolean).join(', ')||d.display_name.split(',').slice(0,2).join(', ');}}catch(e){}return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;}
window.geocodeFrom=async function(){const q=qs('tFrom').value.trim();if(!q)return;const c=await geocodeAddress(q);if(c){setFromPoint(c.lat,c.lon);taxiMap.setView([c.lat,c.lon],15);}else toast('❌ Адрес не найден','red');};
window.geocodeTo=async function(){const q=qs('tTo').value.trim();if(!q)return;const c=await geocodeAddress(q);if(c){setToPoint(c.lat,c.lon);taxiMap.setView([c.lat,c.lon],15);}else toast('❌ Адрес не найден','red');};
async function geocodeAddress(query){try{const res=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=ru`);const d=await res.json();if(d.length)return{lat:parseFloat(d[0].lat),lon:parseFloat(d[0].lon)};}catch(e){}return null;}

// ─── TAXI ORDER ───────────────────────────
let _orderTaxiBusy = false;
window.orderTaxi=async function(){
    if(_orderTaxiBusy) return toast('⏳ Такси уже вызывается…','gold');
    _orderTaxiBusy = true;
    const taxiBtn = qs('btnCallTaxi');
    if(taxiBtn){ taxiBtn.disabled = true; taxiBtn.textContent = '⏳ Оформляем…'; }
    try {
    if(!await requireSpendable())return;
    const from=qs('tFrom').value.trim(),to=qs('tTo').value.trim(),basePrice=parseInt(qs('tPrice').textContent)||0,dist=parseFloat(qs('tDist').textContent)||0;
    if(!from||!to)return toast('⚠️ Укажите маршрут','gold');if(basePrice<=0)return toast('⚠️ Выберите точки','gold');
    
    // Apply subscription discount
    const uSnap=await get(userRef(currentNick));
    const u=uSnap.val()||{};
    const hasPlus = (u.subscription === 'plus' || u.subscription === 'ultra' || u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasUltra = (u.subscription === 'ultra' || u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasPrime = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    let discountPercent = 0;
    let discountName = '';
    if(hasPrime){ discountPercent = 20; discountName = 'Prime (-20%)'; }
    else if(hasUltra){ discountPercent = 10; discountName = 'Ultra (-10%)'; }
    else if(hasPlus){ discountPercent = 5; discountName = 'Plus (-5%)'; }
    
    const finalPrice = Math.max(1, Math.round(basePrice * (1 - discountPercent / 100)));
    
    if(u.balance < finalPrice)return toast(`❌ Недостаточно средств (нужно ${finalPrice}₽${discountPercent > 0 ? ` с учётом ${discountName}` : ''})`,'red');
    
    try {
        // Вызываем Cloud Function с fallback
        const result = await fallbackCreateOrder({
            type: 'taxi',
            info: `${from} → ${to}`,
            price: finalPrice,
            originalPrice: basePrice,
            discountApplied: discountPercent,
            address: '',
            distanceKm: dist,
            clientLat: fromCoords?.lat || null,
            clientLng: fromCoords?.lng || null,
            destLat: toCoords?.lat || null,
            destLng: toCoords?.lng || null
        });
        
        if (result.success) {
            if(!u.rewardedTaxi){
                await update(userRef(currentNick),{rewardedTaxi:true,taskBalance:Math.max(0,Number(u.taskBalance||0))+80});
                await logTx(currentNick,{type:'in',who:'Задания',amt:80,desc:'Одноразовое задание: первый заказ такси'});
                toast('🎁 +80 ₽ на счёт заданий за первый заказ такси','gold');
            }
            
            const priceText = discountPercent > 0 ? `${finalPrice}₽ (скидка ${discountPercent}%)` : `${finalPrice}₽`;
            await pushNotification(currentNick,`🛵 Такси: ${from} → ${to} — ${priceText}`,'taxi_orders');
            toast(`🛵 Такси вызвано!${discountPercent > 0 ? ` Скидка ${discountPercent}% применена!` : ''}`,'gold');
            try{
                // Use the canonical employment model instead of the legacy top-level
                // `job` field. loadAllUsersCache() is single-flight and reuses the live
                // user cache, so creating a taxi order does not trigger a new global
                // read when the cache is already populated.
                const users = await loadAllUsersCache();
                const driverNicks = [...new Set(
                    Object.entries(users || {})
                        .filter(([nick, user]) =>
                            nick !== currentNick &&
                            hasMunicipalJob(user || {}, 'Водитель')
                        )
                        .map(([nick]) => nick)
                )];

                console.info(`[notification pipeline][taxi order] найдено водителей: ${driverNicks.length}`, driverNicks);

                const results = await Promise.allSettled(driverNicks.map(async driverNick=>{
                    try{
                        const result = await pushNotification(
                            driverNick,
                            `🛵 Новый заказ: ${from} → ${to} — ${finalPrice}₽`,
                            'taxi_orders'
                        );
                        if(result?.ok === false){
                            throw new Error(result.error || 'pushNotification вернул ok=false');
                        }
                        console.info(`[notification pipeline][taxi order] уведомление отправлено: ${driverNick}`);
                        return {nick:driverNick, result};
                    }catch(e){
                        console.warn(`[notification pipeline][taxi order] водитель ${driverNick} не получил уведомление:`, e?.message || e);
                        throw e;
                    }
                }));

                const failed = results.filter(r=>r.status==='rejected');
                if(failed.length){
                    console.warn(`[notification pipeline][taxi order] ошибок доставки: ${failed.length}/${driverNicks.length}`);
                }
            }catch(e){
                // Notification delivery is best-effort and must never roll back or
                // otherwise invalidate the taxi order that was already created.
                console.error('[notification pipeline][taxi order] recipient discovery failed:', e?.message || e);
            }
        }
    } catch (error) {
        console.error('Ошибка заказа такси:', error);
        const message = error.message || 'Ошибка при вызове такси';
        toast(`❌ ${message}`,'red');
    }
    } finally {
        _orderTaxiBusy = false;
        if(taxiBtn && taxiBtn.isConnected){ taxiBtn.disabled = false; taxiBtn.textContent = '🛵 Вызвать такси'; }
    }
};

// ─── ORDER ACTIONS ────────────────────────
window.takeOrder=async function(id){
    const snap=await get(orderRef(id));if(!snap.exists())return;const o=snap.val();
    if(o.client===currentNick)return toast('⚠️ Нельзя брать свой заказ','gold');
    
    try {
        // Вызываем Cloud Function с fallback
        const result = await fallbackTakeOrder({ orderId: id });
        
        if (result.success) {
            const uSnap=await get(userRef(currentNick));const u=uSnap.val()||{};
            const isDriver=hasMunicipalJob(u,'Водитель')||u.job==='Водитель';
            const notifText=isDriver?`🛵 Водитель ${currentNick} принял заказ! Транспорт: ${u.vehicle||'?'}`:`📦 Курьер ${currentNick} принял заказ!`;
            await pushNotification(o.client,notifText,o.type==='taxi'?'taxi_orders':'delivery_orders');
            toast('✅ Заказ принят!','green');
            if(o.type==='taxi'&&isDriver) navTo('driverPage');
            if(o.type==='shop'&&hasMunicipalJob(u,'Доставщик')) navTo('deliveryPage');
        }
    } catch (error) {
        console.error('Ошибка принятия заказа:', error);
        const message = error.message || 'Ошибка при принятии заказа';
        toast(`❌ ${message}`,'red');
    }
};
const _abandonPending = new Set();
window.abandonOrder=async function(id){
    if(!id || _abandonPending.has(id)) return;
    _abandonPending.add(id);
    try {
        const snap=await get(orderRef(id));
        if(!snap.exists()) throw new Error('Заказ уже недоступен');
        const o=snap.val();
        if(o.worker!==currentNick) throw new Error('Этот заказ назначен другому исполнителю');
        const allowed = o.type==='taxi'
            ? DRIVER_ACTIVE_ORDER_STATUSES.has(String(o.status||''))
            : o.status==='in_progress';
        if(!allowed) throw new Error('Отказ в текущем состоянии заказа недоступен');
        if(!confirm('Отказаться от заказа? Штраф до 35 ₽, заказ снова станет доступен исполнителям.')) return;
        // Firebase Spark has no deployable callable Functions. Use the
        // existing authenticated Cloudflare Worker and its RTDB service account.
        // Never grant browser-side write access to orders or balances.
        const localFallback = location.protocol === 'file:' ? fallbackCancelOrder : null;
        const result = localFallback
            ? await localFallback({orderId:id})
            : PUSH_WORKER_URL
                ? await pushWorkerCall('/abandon-order', {
                    nick: currentNick,
                    ph: await getPushAuthHash(),
                    orderId: id
                })
                : await callFunctionWithFallback('abandonOrder',{orderId:id},null);
        if(!result?.success) throw new Error('Сервер не подтвердил отказ от заказа');
        if(locationWatchId!==null){navigator.geolocation.clearWatch(locationWatchId);locationWatchId=null;}
        currentTrackOrderId=null;
        _driverUiKey='';
        const penalty=Math.max(0,Number(result.penalty||0));
        // Notifications are best-effort and must not turn a successful action into an error.
        await Promise.allSettled([
            pushNotification(currentNick,`Отказ от заказа оформлен. Штраф ${penalty} ₽`),
            pushNotification(o.client,'Исполнитель отказался от заказа. Ищем нового.',o.type==='taxi'?'taxi_orders':'delivery_orders')
        ]);
        toast(`Заказ возвращён в очередь (−${penalty} ₽)`,'green');
    } catch (error) {
        console.error('Ошибка отказа от заказа:', error);
        toast('Не удалось отказаться: '+(error?.message||'ошибка'),'red');
    } finally {
        _abandonPending.delete(id);
    }
};

// ─── LOCATION TRACKING ────────────────────
let locationWatchId=null,clientTrackingMap=null,driverMarkerOnClientMap=null,clientTrackListener=null;
let driverTrackMapObj=null,clientMarkerOnDriverMap=null,driverOwnMarker=null,currentTrackOrderId=null;
window.startSharingLocation=function(){
    if(!navigator.geolocation)return toast('❌ Геолокация недоступна','red');
    if(locationWatchId!==null)return;
    if(currentTrackOrderId){ get(orderRef(currentTrackOrderId)).then(s=>{if(s.exists()&&s.val().status==='accepted') update(orderRef(currentTrackOrderId),{status:'driver_arriving',locationSharingStartedAt:Date.now()});}).catch(()=>{}); }
    qs('driverShareLocBtn').style.display='none'; qs('driverStopLocBtn').style.display='block';
    locationWatchId=navigator.geolocation.watchPosition(async pos=>{const lat=pos.coords.latitude,lng=pos.coords.longitude;if(currentTrackOrderId){await update(orderRef(currentTrackOrderId),{driverLat:lat,driverLng:lng,driverLocationUpdatedAt:Date.now()});try{const s=await get(orderRef(currentTrackOrderId));const o=s.val()||{};const tLat=String(o.status)==='in_progress'?Number(o.destLat):Number(o.clientLat),tLng=String(o.status)==='in_progress'?Number(o.destLng):Number(o.clientLng),info=qs('driverTrackInfo');if(info&&Number.isFinite(tLat)&&Number.isFinite(tLng)){const d=haversine(lat,lng,tLat,tLng),mins=Math.max(1,Math.ceil(d/MAX_SPEED_KMH*60));info.innerHTML=String(o.status)==='in_progress'?`🏁 До конечной точки: <b style="color:var(--primary)">${d.toFixed(2)} км</b> · ⏱ ~<b style="color:var(--gold)">${mins} мин</b>`:`🛵 До клиента: <b style="color:var(--primary)">${d.toFixed(2)} км</b> · ⏱ ~<b style="color:var(--gold)">${mins} мин</b>`;}}catch(e){}}if(driverTrackMapObj){if(!driverOwnMarker){driverOwnMarker=L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:18px;height:18px;border-radius:50%;border:3px solid white;">🛵</div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(driverTrackMapObj);}else driverOwnMarker.setLatLng([lat,lng]);}},()=>toast('❌ Геолокация недоступна','red'),{enableHighAccuracy:true,maximumAge:5000,timeout:10000});
    toast('📍 Трансляция началась','green');
};
window.beginTaxiTrip=async function(id){if(!id)return;const snap=await get(orderRef(id));if(!snap.exists())return;if(snap.val().worker!==currentNick||snap.val().status!=='driver_arriving')return;await update(orderRef(id),{status:'in_progress',tripStartedAt:Date.now()});toast('🚕 Поездка началась','green');};
window.finishTaxiTrip=async function(id){if(!id)return;const snap=await get(orderRef(id));if(!snap.exists())return;const o=snap.val();if(o.worker!==currentNick||o.status!=='in_progress')return;await update(orderRef(id),{status:'waiting_payment',waitingPaymentAt:Date.now()});if(locationWatchId!==null){navigator.geolocation.clearWatch(locationWatchId);locationWatchId=null;}qs('driverShareLocBtn')?.style.setProperty('display','block');qs('driverStopLocBtn')?.style.setProperty('display','none');toast('💳 Поездка завершена, ждём оплату','gold');};
window.stopSharingLocation=function(){if(locationWatchId!==null){navigator.geolocation.clearWatch(locationWatchId);locationWatchId=null;}const shareBtn=qs('driverShareLocBtn'),stopBtn=qs('driverStopLocBtn');if(shareBtn)shareBtn.style.display='block';if(stopBtn)stopBtn.style.display='none';toast('⏹ Остановлено','gold');};
async function initDriverTrackMap(orderId,clientLat,clientLng,destLat,destLng){
    await window.kapaniLoadLeaflet();
    currentTrackOrderId=orderId;
    const card=qs('driverTrackCard');if(!card)return;card.style.display='block';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const mapEl=qs('driverTrackMap');if(!mapEl)return;
    if(driverTrackMapObj && driverTrackMapObj.getContainer()===mapEl){driverTrackMapObj.invalidateSize();return;}
    if(driverTrackMapObj){try{driverTrackMapObj.remove();}catch(e){}driverTrackMapObj=null;clientMarkerOnDriverMap=null;driverOwnMarker=null;}
    const center=(Number.isFinite(Number(clientLat))&&Number.isFinite(Number(clientLng)))?[clientLat,clientLng]:[KAPANI_LAT,KAPANI_LNG];
    driverTrackMapObj=L.map(mapEl,{center,zoom:14}); addSatelliteLayer(driverTrackMapObj);
    const bounds=[];
    if(clientLat&&clientLng){clientMarkerOnDriverMap=L.marker([clientLat,clientLng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:22px;height:22px;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:13px;">👤</div>',iconSize:[22,22],iconAnchor:[11,11],className:''})}).addTo(driverTrackMapObj).bindPopup('<b>📍 Клиент</b>');bounds.push([clientLat,clientLng]);}
    if(destLat&&destLng){L.marker([destLat,destLng],{icon:L.divIcon({html:'<div style="background:#ff806a;width:22px;height:22px;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:13px;">🏁</div>',iconSize:[22,22],iconAnchor:[11,11],className:''})}).addTo(driverTrackMapObj).bindPopup('<b>🏁 Конечная</b>');bounds.push([destLat,destLng]);}
    if(clientLat&&clientLng&&destLat&&destLng)L.polyline([[clientLat,clientLng],[destLat,destLng]],{color:'#ff806a',weight:3,dashArray:'5,5',opacity:0.7}).addTo(driverTrackMapObj);
    try{
        const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:7000,maximumAge:0}));
        const dlat=pos.coords.latitude,dlng=pos.coords.longitude; bounds.push([dlat,dlng]);
        driverOwnMarker=L.marker([dlat,dlng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:22px;height:22px;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:13px;">🛵</div>',iconSize:[22,22],iconAnchor:[11,11],className:''})}).addTo(driverTrackMapObj).bindPopup('Вы');
        const infoEl=qs('driverTrackInfo');
        let status='driver_arriving';
        try{const snap=await get(orderRef(orderId));if(snap.exists())status=String(snap.val().status||status);}catch(e){}
        const targetLat=status==='in_progress'?Number(destLat):Number(clientLat);
        const targetLng=status==='in_progress'?Number(destLng):Number(clientLng);
        if(infoEl&&Number.isFinite(targetLat)&&Number.isFinite(targetLng)){
            const d=haversine(dlat,dlng,targetLat,targetLng), mins=Math.max(1,Math.ceil(d/MAX_SPEED_KMH*60));
            infoEl.innerHTML=status==='in_progress'
                ? `🏁 До конечной точки: <b style="color:var(--primary)">${d.toFixed(2)} км</b> · ⏱ ~<b style="color:var(--gold)">${mins} мин</b>`
                : `🛵 До клиента: <b style="color:var(--primary)">${d.toFixed(2)} км</b> · ⏱ ~<b style="color:var(--gold)">${mins} мин</b>`;
        }
    }catch(e){const infoEl=qs('driverTrackInfo');if(infoEl)infoEl.textContent='⚠️ Разрешите геолокацию';}
    if(bounds.length>=2)driverTrackMapObj.fitBounds(bounds,{padding:[40,40]});else if(bounds.length===1)driverTrackMapObj.setView(bounds[0],15);
}

async function initClientTrackingMap(orderId){
    await window.kapaniLoadLeaflet();
    const mapEl=qs('trackingMap');if(!mapEl)return;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(clientTrackingMap && clientTrackingMap.getContainer()===mapEl && clientTrackListener?.orderId===orderId){clientTrackingMap.invalidateSize();return;}
    destroyClientTrackingMap();
    clientTrackingMap=L.map(mapEl,{center:[KAPANI_LAT,KAPANI_LNG],zoom:15});
    addSatelliteLayer(clientTrackingMap);
    const oRef=orderRef(orderId);
    const fn=snap=>{
        if(!snap.exists()||!clientTrackingMap||snap.key!==orderId)return;
        const o=snap.val();
        const lat=Number(o.driverLat),lng=Number(o.driverLng);
        const info=qs('taxiTrackingEta');
        const targetLat=String(o.status||'')==='in_progress'?Number(o.destLat):Number(o.clientLat);
        const targetLng=String(o.status||'')==='in_progress'?Number(o.destLng):Number(o.clientLng);
        if(Number.isFinite(lat)&&Number.isFinite(lng)){
            if(!driverMarkerOnClientMap){
                driverMarkerOnClientMap=L.marker([lat,lng],{icon:L.divIcon({html:'<div style="background:#f0444a;width:22px;height:22px;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:13px;">🛵</div>',iconSize:[22,22],iconAnchor:[11,11],className:''})}).addTo(clientTrackingMap).bindPopup('Водитель');
            } else driverMarkerOnClientMap.setLatLng([lat,lng]);
            if(Number.isFinite(targetLat)&&Number.isFinite(targetLng)){
                const d=haversine(lat,lng,targetLat,targetLng);
                const mins=Math.max(1,Math.ceil(d/MAX_SPEED_KMH*60));
                info.textContent=String(o.status||'')==='in_progress'
                    ? `🏁 До конечной точки примерно ${mins} мин · ${d.toFixed(1)} км`
                    : `🛵 Таксист приедет примерно через ${mins} мин · ${d.toFixed(1)} км`;
            }
        } else if(info) info.textContent='📍 Ожидаем GPS водителя…';
    };
    const unsub=onValue(oRef,fn,err=>console.warn('[taxi tracking listener]',err?.message||err));
    clientTrackListener={ref:oRef,fn,unsub,orderId};
}


let _payOrderBusy = false;
window.payOrder=async function(id){
    if(_payOrderBusy) return toast('⏳ Оплата уже выполняется…','gold');
    _payOrderBusy = true;
    try {
    const snap=await get(orderRef(id));if(!snap.exists())return toast('❌ Заказ не найден','red');const o=snap.val();
    if(!o.worker)return toast('⚠️ Нет исполнителя','gold');
    if(o.type==='taxi' && o.status!=='waiting_payment') return toast('⏳ Заказ ещё не готов к оплате','gold');
    
    try {
        // Вызываем Cloud Function с fallback
        const result = await fallbackPayOrder({ orderId: id });
        
        if (result.success) {
            if(o.type==='taxi'){ try{ await archiveTaxiOrder(o,'paid'); }catch(e){ console.warn('[taxi history]',e); } }
            destroyClientTrackingMap();
            await pushNotification(o.client,`💸 Оплата ${o.price}₽ → ${o.worker}`);await pushNotification(o.worker,`💰 Получено ${o.price}₽ от ${o.client}!`);
            toast('💰 Оплата прошла!','green');
        }
    } catch (error) {
        console.error('Ошибка оплаты заказа:', error);
        const message = error.message || 'Ошибка при оплате заказа';
        toast(`❌ ${message}`,'red');
    }
    } finally {
        _payOrderBusy = false;
    }
};
window.cancelOrder=async function(id){
    const snap=await get(orderRef(id));if(!snap.exists())return;const o=snap.val();
    if(o.client!==currentNick)return toast('❌ Нет прав для отмены','red');
    if(!ACTIVE_ORDER_STATUSES.has(String(o.status||''))) return toast('⚠️ Заказ уже завершён','gold');
    
    try {
        // Вызываем Cloud Function с fallback
        const result = await fallbackCancelOrder({ orderId: id });
        
        if (result.success) {
            // Удаляем заказ из базы данных после успешной отмены
            try { await remove(orderRef(id)); } catch(e) {}
            await pushNotification(currentNick,`❌ Заказ отменён, штраф ${result.penalty}₽`);
            if(o.worker)await pushNotification(o.worker,`⚠️ ${currentNick} отменил заказ`);
            toast(`❌ Отменён (возврат ${result.refundAmount}₽)`,'red');
        }
    } catch (error) {
        console.error('Ошибка отмены заказа:', error);
        const message = error.message || 'Ошибка при отмене заказа';
        toast(`❌ ${message}`,'red');
    }
};

// ─── BANK ─────────────────────────────────
// Helper: strip undefined/null from an object so Firebase doesn't reject it
// Also converts arrays to objects if they contain objects (Firebase arrays issue)
function stripUndefined(obj) {
    if(Array.isArray(obj)){
        // Firebase dislikes sparse arrays — convert to plain objects first, then array
        const cleaned = obj
            .filter(item => item !== undefined && item !== null)
            .map(item => stripUndefined(item));
        return cleaned;
    }
    if(obj && typeof obj === 'object'){
        const out = {};
        for(const k of Object.keys(obj)){
            const v = obj[k];
            if(v !== undefined && v !== null) out[k] = stripUndefined(v);
        }
        return out;
    }
    return obj;
}

// Helper: make a Firebase-safe employment entry — no undefined anywhere
function makeEmpEntry(item){
    const entry = {
        id:   String(item.id   || ''),
        type: String(item.type || 'municipal'),
        role: String(item.role || ''),
    };
    // Only include bizId/bizName if they are real truthy strings
    if(item.bizId   && typeof item.bizId   === 'string') entry.bizId   = item.bizId;
    if(item.bizName && typeof item.bizName === 'string') entry.bizName = item.bizName;
    return entry;
}

let _quitJobBusy = false;
window.quitJob = async function(){
    if(_quitJobBusy) return toast('⏳ Увольнение уже обрабатывается…','gold');
    _quitJobBusy = true;
    try {
        const nick = window.currentNick;
        if(!nick) return toast('⚠️ Сначала войдите','gold');

        let snap;
        try { snap = await get(userRef(nick)); } catch(e){ return toast('❌ Ошибка загрузки данных','red'); }
        if(!snap || !snap.exists()) return toast('❌ Профиль не найден','red');
        const u = snap.val();

        // ── Собираем полный список должностей без рекурсии ──────────────
        const seen = new Set();
        const allEmps = [];
        const addEmp = (item) => {
            if(!item || !item.id || seen.has(item.id)) return;
            seen.add(item.id);
            allEmps.push(makeEmpEntry(item));
        };

        // Из массива employments (Firebase может вернуть его как объект или массив)
        const rawEmps = u.employments;
        if(rawEmps){
            const empArr = Array.isArray(rawEmps) ? rawEmps : Object.values(rawEmps);
            empArr.forEach(e => e && addEmp(e));
        }

        // Legacy u.job (мун. должность)
        if(u.job && u.job !== 'Житель'){
            addEmp({ id: `muni_${u.job}`, type: 'municipal', role: u.job });
        }

        // Из allBusinessesCache (бизнесы, где числимся сотрудником)
        try {
            Object.values(window.allBusinessesCache || {}).forEach(b => {
                if(!b || b.status !== 'active') return;
                const emp = b.employees?.[nick];
                if(emp) addEmp({
                    id:      `biz_${b.id}`,
                    type:    'business',
                    bizId:   String(b.id || ''),
                    role:    String(typeof window.getBizEmployeeRoleName === 'function'
                                ? window.getBizEmployeeRoleName(emp)
                                : (emp.role || 'Сотрудник')),
                    bizName: String(b.name || 'Бизнес'),
                });
            });
        } catch(e){ /* allBusinessesCache might not be ready */ }

        if(!allEmps.length) return toast('⚠️ Вы не трудоустроены','gold');

        // ── Выбор должности если несколько ────────────────────────────
        let targetEmp;
        if(allEmps.length > 1){
            const list = allEmps.map((e,i)=>`${i+1}. ${e.role} (${e.type==='business'?'бизнес':'мэрия'})`).join('\n');
            const pick = prompt(`С какой работы уволиться?\n${list}\n\nВведите номер:`);
            if(pick === null) return;
            const num = parseInt(pick, 10);
            if(num >= 1 && num <= allEmps.length) targetEmp = allEmps[num - 1];
            else targetEmp = allEmps.find(e => e.role.toLowerCase() === pick.trim().toLowerCase());
            if(!targetEmp) return toast('⚠️ Работа не найдена. Введите номер из списка.','gold');
        } else {
            targetEmp = allEmps[0];
        }

        if(!confirm(`Уволиться с должности «${targetEmp.role}»?`)) return;

        // ── Применяем изменения ────────────────────────────────────────
        try {
            // 1) Удаляем из бизнеса если нужно
            if(targetEmp.type === 'business' && targetEmp.bizId){
                try {
                    await update(bizItemRef(targetEmp.bizId), { [`employees/${nick}`]: null });
                } catch(e){ console.warn('[quitJob biz remove]', e); }
            }

            // 2) Новый список employments без уволенной записи
            // Каждый элемент пересоздаём через makeEmpEntry — гарантия отсутствия undefined
            const newEmps = allEmps
                .filter(e => e.id !== targetEmp.id)
                .map(e => makeEmpEntry(e));

            // 3) Вычисляем новую основную мун. должность
            const remainingMuni = newEmps.filter(e => e.type === 'municipal');
            const newMuniJob = remainingMuni.length > 0 ? remainingMuni[0].role : 'Житель';

            // 4) Формируем patch — все значения явно определены, без undefined
            const activeDisplay = newEmps.find(e => e.role && e.role === u.displayJob) || newEmps[0] || null;
            const patch = {
                employments: newEmps,
                // displayJob is only valid while the corresponding employment exists.
                // Never keep the fired role as a stale profile label.
                displayJob: activeDisplay ? activeDisplay.role : null,
                // Legacy municipal role must also be recalculated independently of the
                // fired role. Business employment must never keep an old municipal job.
                job: remainingMuni.length > 0 ? remainingMuni[0].role : 'Житель'
            };

            if(targetEmp.type === 'municipal'){
                patch.job = newMuniJob;
                if(remainingMuni.length === 0){
                    patch.jobApplicationStatus = null;
                    patch.appliedJob = null;
                }
            }

            // 5) Доп. сброс по роли
            if(targetEmp.role === 'Водитель' || targetEmp.role === 'Доставщик'){
                patch.vehicle = '';
            }
            if(targetEmp.role === (window.JOB_JANITOR || 'Уборщик')){
                patch.janitorTaskDate = '';
                patch.janitorSubmissionId = '';
                patch.janitorSubmissionStatus = '';
                patch.janitorProof = '';
                patch.janitorComment = '';
            }
            if(targetEmp.role === JOB_ADVERTISER){
                patch.advertiserSalaryPaidThroughWeek = advertiserWeekKey();
            }
            const securityRoles = ['Полицейский','КСБ','Охранник'];
            if(securityRoles.includes(targetEmp.role) && remainingMuni.every(e => !securityRoles.includes(e.role))){
                patch.securityBadge = null;
            }

            // 6) Финальная очистка patch от undefined перед отправкой
            const safePatch = stripUndefined(patch);

            // 7) Атомарное обновление Firebase
            await update(userRef(nick), safePatch);
            const localFreshUser = { ...u, ...safePatch };
            allUsersCache[nick] = localFreshUser;
            window.allUsersCache = allUsersCache;
            try { updateHeader(localFreshUser); } catch(e) {}

            toast(`🚪 Вы уволились с «${targetEmp.role}»`, 'green');

            // 8) Обновляем UI — без вызова renderProfile (избегаем рекурсии)
            try {
                const quitBtn = document.getElementById('quitJobBtn');
                if(quitBtn) quitBtn.style.display = newEmps.length > 0 ? 'block' : 'none';
                const jobEl = document.getElementById('profileJobLabel') || document.querySelector('.profile-job');
                if(jobEl) jobEl.textContent = patch.displayJob || patch.job || 'Житель';
            } catch(uiErr){ /* ignore */ }

            try {
                if(typeof window.refreshFinePanelVisibility === 'function') window.refreshFinePanelVisibility();
            } catch(e){}

            try {
                if(typeof window.curPage !== 'undefined' && window.curPage === 'profile'){
                    if(typeof window.navTo === 'function') window.navTo('profile');
                }
            } catch(e){}

        } catch(e){
            console.error('[quitJob update]', e);
            toast('❌ Не удалось уволиться: ' + ((e && (e.message || e.code)) || 'ошибка Firebase'), 'red');
        }
    } catch(outer){
        console.error('[quitJob outer]', outer);
        toast('❌ Не удалось уволиться: ' + ((outer && outer.message) || 'неизвестная ошибка'), 'red');
    } finally {
        _quitJobBusy = false;
    }
};

// ─── BANK TRANSFER ─────────────────────────
let _doTransferBusy = false;
window.doTransfer = async function(){
    if(_doTransferBusy) return toast('⏳ Перевод уже выполняется…','gold');
    _doTransferBusy = true;
    const btn = document.querySelector('#bankPage .btn-primary[onclick*="doTransfer"]') || document.querySelector('button[onclick*="doTransfer"]');
    if(btn){ btn.disabled = true; btn.textContent = '⏳ Отправка…'; }
    try {
    if(!await requireNotMigrant('переводы недоступны')) return;
    if(!await requireSpendable())return;
    const toName=qs('bTo').value.trim(),amt=parseInt(qs('bAmt').value)||0;
    if(!toName)return toast('⚠️ Введите имя получателя','gold');
    const toUser = await findUserByPublicName(toName);
    if(!toUser) return toast('❌ Получатель не найден','red');
    const to = toUser.nick;
    if(to===currentNick)return toast('⚠️ Нельзя себе','gold');if(amt<=0)return toast('⚠️ Введите сумму','gold');

    const[fromSnap,toSnap]=await Promise.all([get(userRef(currentNick)),get(userRef(to))]);
    const fromUser = fromSnap.val();
    const toUserData = toSnap.val();
    const hasPrimeTransfer = fromUser?.subscription === 'prime' && fromUser?.subscriptionExpiry && new Date(fromUser.subscriptionExpiry) > new Date();
    const commissionRate = hasPrimeTransfer ? 0.01 : ECONOMY_TRANSFER_COMMISSION;
    const commission = calcCommission(amt, commissionRate);
    const total = amt + commission;

    if(isMigrantUser(fromUser)) return toast(`🚫 ${ROLE_MIGRANT}: переводы недоступны`,'red');
    if(isMigrantUser(toUserData)) return toast(`🚫 Нельзя переводить пользователю с ролью «${ROLE_MIGRANT}»`,'red');
    if(!fromUser.accountVerified) {
        return toast('❌ Ваш аккаунт не подтверждён мэрией. Подождите подтверждения.','red');
    }
    if(!toSnap.exists())return toast('❌ Не найден','red');
    if(!toUserData.accountVerified) {
        return toast('❌ Аккаунт получателя не подтверждён мэрией.','red');
    }
    if((fromUser.balance || 0) < total){
        return toast(`❌ Недостаточно средств. Нужно ${total}₽ (перевод ${amt}₽ + комиссия ${commission}₽)`,'red');
    }

    try {
        const result = await callFunctionWithFallback('transferMoney', { 
            toUid: to, 
            amount: amt,
            commission,
            commissionRate,
            total,
            description: `Перевод пользователю ${to}` 
        }, fallbackTransferMoney);

        if (result && result.success) {
            if(!result.commissionCharged){
                await chargeCommissionAndLog(currentNick, commission, `Комиссия ${Math.round(commissionRate*100)}% за перевод пользователю ${to}`);
            }
            if(commission>0) await window.addMunicipalTreasury?.(commission, `Банковская комиссия ${Math.round(commissionRate*100)}% за перевод ${currentNick} → ${to}`, {sourceNick:currentNick,sourceType:'bank_commission'});
            await pushNotification(to,`💰 Перевод ${amt}₽ от ${displayNick(fromUser)}`,'money');
            qs('bTo').value='';qs('bAmt').value='';
            toast(`💸 ${amt}₽ → ${displayNick(toUserData)} (комиссия ${commission}₽)`,'green');
            renderRecentTransfers();renderFinancialStats();
        } else {
            const errMsg = (result && (result.error || result.message)) || 'Перевод не прошёл. Попробуйте ещё раз.';
            console.warn('Transfer not successful, retrying via fallback:', result);
            try {
                const fb = await fallbackTransferMoney({ toUid: to, amount: amt, commission, commissionRate, total, description: `Перевод пользователю ${to}` });
                if(fb && fb.success){
                    if(commission>0) await window.addMunicipalTreasury?.(commission, `Банковская комиссия ${Math.round(commissionRate*100)}% за перевод ${currentNick} → ${to}`, {sourceNick:currentNick,sourceType:'bank_commission'});
                    await pushNotification(to,`💰 Перевод ${amt}₽ от ${displayNick(fromUser)}`,'money');
                    qs('bTo').value='';qs('bAmt').value='';
                    toast(`💸 ${amt}₽ → ${displayNick(toUserData)} (комиссия ${commission}₽)`,'green');
                    renderRecentTransfers();renderFinancialStats();
                } else {
                    toast(`❌ ${errMsg}`,'red');
                }
            } catch(fbErr){
                toast(`❌ ${(fbErr && fbErr.message) || errMsg}`,'red');
            }
        }
    } catch (error) {
        console.error('Ошибка перевода:', error);
        const message = error.message || 'Ошибка при выполнении перевода';
        toast(`❌ ${message}`,'red');
    }
    } finally {
        _doTransferBusy = false;
        if(btn){ btn.disabled = false; btn.textContent = 'Отправить'; }
    }
};
async function renderRecentTransfers(){
    const el=qs('txHistory');if(!el)return;const snap=await get(txLogRef(currentNick));
    const arr=Object.values(snap.val()||{}).sort((a,b)=>(b.ts||'').localeCompare(a.ts||'')).slice(0,5);
    el.innerHTML=arr.length===0?'<div style="color:var(--muted);font-size:13px;">Нет операций</div>':arr.map(tx=>{
        const whoLine = tx.who ? (tx.type==='in' ? 'От: '+escHtml(tx.who) : '→ '+escHtml(tx.who)) : '';
        const descLine = tx.desc ? escHtml(tx.desc) : (tx.who ? '' : (tx.type==='in'?'Поступление':'Списание'));
        const title = [whoLine, descLine].filter(Boolean).join(' · ');
        return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);"><div style="font-size:20px;">${tx.type==='in'?'💰':'💸'}</div><div style="flex:1;min-width:0;"><div style="font-weight:800;font-size:12px;line-height:1.35;">${title}</div><div style="font-size:10px;color:var(--muted);margin-top:2px;">${escHtml(tx.date||'')} · ${escHtml(tx.time||'')}</div></div><div style="font-weight:900;font-size:14px;white-space:nowrap;${tx.type==='in'?'color:var(--primary)':'color:var(--red)'};">${tx.type==='in'?'+':'−'}${tx.amt}₽</div></div>`;
    }).join('');
}
let _callPhotoData = null;
window.openCallModal = function(){
    const m = qs('callModal'); if(!m) return;
    _callPhotoData = null;
    const nameEl = qs('callName');
    if(nameEl && !nameEl.value){
        const u = allUsersCache[currentNick];
        nameEl.value = (u && (u.displayName || u.name)) || currentNick || '';
    }
    const prev = qs('callPhotoPreview'); if(prev){ prev.style.display='none'; prev.removeAttribute('src'); }
    m.style.display = 'flex';
};
window.closeCallModal = function(){
    const m = qs('callModal'); if(m) m.style.display = 'none';
};
window.handleCallPhoto = async function(e){
    const file = e.target.files[0]; if(!file) return;
    toast('📷 Сжимаем фото...','gold');
    try{
        const dataUrl = await compressImage(file, 1000, 0.82);
        _callPhotoData = dataUrl;
        const prev = qs('callPhotoPreview');
        if(prev){ prev.src = dataUrl; prev.style.display = 'block'; }
    }catch(err){ toast('❌ Не удалось обработать фото','red'); }
    e.target.value = '';
};
window.submitCall = async function(){
    const name = (qs('callName')?.value||'').trim();
    const address = (qs('callAddress')?.value||'').trim();
    const desc = (qs('callDesc')?.value||'').trim();
    if(!name) return toast('⚠️ Укажите ваше имя','gold');
    if(!address) return toast('⚠️ Укажите адрес','gold');
    if(!desc) return toast('⚠️ Опишите, что произошло','gold');
    const call = { name, address, desc, from: currentNick||null, status:'new', time: nowTime(), createdAt: Date.now() };
    if(_callPhotoData) call.photo = _callPhotoData;
    try{
        await push(ref(db,'calls'), call);
        if(qs('callDesc')) qs('callDesc').value='';
        if(qs('callAddress')) qs('callAddress').value='';
        _callPhotoData = null;
        const prev = qs('callPhotoPreview'); if(prev){ prev.style.display='none'; prev.removeAttribute('src'); }
        closeCallModal();
        toast('✅ Вызов отправлен! КСБ и полиция уведомлены.','green');
    }catch(err){ console.error('call error', err); toast('❌ Не удалось отправить вызов','red'); }
};
// Совместимость со старыми вызовами
window.openEmergencyNumbers = window.openCallModal;
window.closeEmergencyNumbers = window.closeCallModal;
window.openInfoModal = function(){
    const m = qs('infoModal');
    if(m) m.style.display = 'flex';
};
window.closeInfoModal = function(){
    const m = qs('infoModal');
    if(m) m.style.display = 'none';
};
window.showInfoTab = function(tab){
    ['pdd','rules','reg','money'].forEach(t=>{
        const c = qs('infoTab_'+t);
        const b = qs('infoTabBtn_'+t);
        if(c) c.style.display = (t===tab) ? 'block' : 'none';
        if(b){
            if(t===tab){ b.classList.add('btn-primary'); b.classList.remove('btn-ghost'); }
            else { b.classList.add('btn-ghost'); b.classList.remove('btn-primary'); }
        }
    });
};
window.openAtmRequestModal = function(){
    const m = qs('atmRequestModal');
    if(m) m.style.display = 'flex';
};
window.closeAtmRequestModal = function(){
    const m = qs('atmRequestModal');
    if(m) m.style.display = 'none';
};
window.submitAtmRequest = async function(){
    if(!currentNick) return;
    const name = (qs('atmName')?.value || '').trim();
    const action = (qs('atmAction')?.value || '').trim();
    const amount = Number(qs('atmAmount')?.value || 0);
    const address = (qs('atmAddress')?.value || '').trim();
    if(!name) return toast('⚠️ Введите имя','gold');
    if(!action) return toast('⚠️ Выберите действие','gold');
    if(!Number.isFinite(amount) || amount <= 0) return toast('⚠️ Введите сумму','gold');
    if(!address) return toast('⚠️ Укажите адрес обмена','gold');
    const id = genId();
    const req = { id, name, action, amount, address, client: currentNick, clientName: displayNick(allUsersCache[currentNick] || {nick: currentNick}), status: 'pending', createdAt: Date.now() };
    await set(ref(db, `atmRequests/${id}`), req);
    await pushNotification(ADMIN, `💵 Новая заявка банкомата от ${req.clientName}`, 'system');
    toast('✅ Заявка отправлена в мэрию','green');
    closeAtmRequestModal();
    ['atmName','atmAction','atmAmount','atmAddress'].forEach(id => { const el = qs(id); if(el) el.value = ''; });
};


window.renderFinancialStats=async function(){
    const snap=await get(txLogRef(currentNick));
    const all=Object.values(snap.val()||{});
    
    // Группировка по месяцам
    const byMonth={};
    all.forEach(tx=>{
        const d=tx.date||'';
        const p=d.split('.');
        const key=p.length>=3?`${p[1]}.${p[2]}`:d;
        if(!byMonth[key])byMonth[key]={income:0,expense:0};
        if(tx.type==='in')byMonth[key].income+=tx.amt||0;
        else byMonth[key].expense+=tx.amt||0;
    });
    
    // Сортировка месяцев (новые первыми)
    const sortedMonths=Object.keys(byMonth).sort((a,b)=>b.localeCompare(a));
    
    // Отображение помесячной статистики (последние 3 месяца)
    const monthlyEl=qs('monthlyStats');
    if(monthlyEl){
        const recentMonths=sortedMonths.slice(0,3);
        if(recentMonths.length===0){
            monthlyEl.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет данных</div>';
        }else{
            monthlyEl.innerHTML=recentMonths.map(monthKey=>{
                const month=byMonth[monthKey];
                const net=month.income-month.expense;
                const [m,y]=monthKey.split('.');
                const monthNames=['','январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
                const monthName=monthNames[parseInt(m)]||m;
                const netColor=net>=0?'var(--primary)':'var(--red)';
                const netSign=net>=0?'+':'';
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);"><div><div style="font-weight:800;font-size:13px;">${monthName} ${y}</div><div style="font-size:11px;color:var(--muted);">Доход: <span style="color:var(--primary)">+${month.income.toLocaleString()}₽</span> · Расход: <span style="color:var(--red)">-${month.expense.toLocaleString()}₽</span></div></div><div style="font-weight:900;font-size:13px;color:${netColor};">${netSign}${net.toLocaleString()}₽</div></div>`;
            }).join('');
        }
    }
    
    // Общая статистика
    const totalIncome=all.filter(t=>t.type==='in').reduce((s,t)=>s+(t.amt||0),0);
    const totalExpense=all.filter(t=>t.type==='out').reduce((s,t)=>s+(t.amt||0),0);
    const totalNet=totalIncome-totalExpense;
    
    const totalEl=qs('totalStats');
    if(totalEl){
        const netColor=totalNet>=0?'var(--primary)':'var(--red)';
        const netSign=totalNet>=0?'+':'';
        totalEl.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;background:var(--surface2);border-radius:12px;border:1px solid var(--border);"><div><div style="font-weight:900;font-size:14px;margin-bottom:4px;">Общая статистика</div><div style="font-size:12px;color:var(--muted);">Всего операций: ${all.length}</div></div><div style="text-align:right;"><div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Доход: <span style="color:var(--primary)">+${totalIncome.toLocaleString()}₽</span></div><div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Расход: <span style="color:var(--red)">-${totalExpense.toLocaleString()}₽</span></div><div style="font-weight:900;font-size:13px;color:${netColor};">${netSign}${totalNet.toLocaleString()}₽</div></div></div>`;
    }
};
function monthTitleRu(dstr){
    if(!dstr)return '—';
    const p=dstr.split('.');
    if(p.length<3)return dstr;
    const mo=['','январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
    const m=parseInt(p[1],10),y=p[2];
    return `Транзакции за ${mo[m]||p[1]} ${y}`;
}
window.openHistoryModal=async function(){
    lockBodyScroll();
    const modal = qs('historyModal');
    modal.style.pointerEvents = 'auto';
    modal.classList.add('open');
    qs('historyList').innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Загрузка...</div>';

    // Escape key closes the modal
    const onEsc = (e) => { if(e.key==='Escape'){ closeHistoryModal(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
    modal._escHandler = onEsc;

    // Swipe down to close (touch devices)
    const sheet = modal.querySelector('.history-sheet');
    let touchStartY = 0;
    const onTouchStart = (e) => { touchStartY = e.touches[0].clientY; };
    const onTouchEnd = (e) => {
        const dy = e.changedTouches[0].clientY - touchStartY;
        if(dy > 80) closeHistoryModal();
    };
    sheet.addEventListener('touchstart', onTouchStart, {passive:true});
    sheet.addEventListener('touchend', onTouchEnd, {passive:true});
    modal._swipeCleanup = () => { sheet.removeEventListener('touchstart', onTouchStart); sheet.removeEventListener('touchend', onTouchEnd); };

    const snap=await get(txLogRef(currentNick));const all=Object.values(snap.val()||{}).sort((a,b)=>(b.ts||'').localeCompare(a.ts||''));
    const income=all.filter(t=>t.type==='in').reduce((s,t)=>s+(t.amt||0),0);const expense=all.filter(t=>t.type==='out').reduce((s,t)=>s+(t.amt||0),0);
    qs('historySummary').innerHTML=`<div class="history-sum-box income"><div class="history-sum-val" style="color:var(--primary);">+${income.toLocaleString()}₽</div><div class="history-sum-lbl">Получено</div></div><div class="history-sum-box expense"><div class="history-sum-val" style="color:var(--red);">−${expense.toLocaleString()}₽</div><div class="history-sum-lbl">Списано</div></div>`;
    if(all.length===0){qs('historyList').innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Пусто</div>';return;}
    const byMonth={};
    all.forEach(tx=>{
        const d=tx.date||'';
        const p=d.split('.');
        const key=p.length>=3?`${p[1]}.${p[2]}`:d;
        (byMonth[key]=byMonth[key]||[]).push(tx);
    });
    qs('historyList').innerHTML=Object.entries(byMonth).map(([key, txs])=>{
        const sample=txs[0]?.date||'';
        const title=sample&&sample.includes('.')?monthTitleRu(sample):`Период ${key}`;
        return `<div style="font-size:12px;font-weight:900;color:var(--gold);padding:16px 0 8px;border-bottom:1px solid var(--border);">${escHtml(title)}</div>${txs.map(tx=>{
            const whoLine = tx.who ? (tx.type==='in' ? 'От: '+escHtml(tx.who) : 'Кому: '+escHtml(tx.who)) : '';
            const descLine = tx.desc ? escHtml(tx.desc) : (tx.who ? '' : (tx.type==='in'?'Поступление':'Списание'));
            const subLines = [whoLine, descLine].filter(Boolean).join('<br>');
            return `<div class="tx-item" style="align-items:flex-start;"><div class="tx-ico">${tx.type==='in'?'💰':'💸'}</div><div class="tx-info" style="min-width:0;overflow:hidden;"><div class="tx-what" style="font-weight:800;font-size:13px;color:var(--text);">${escHtml(tx.date||'')} · ${escHtml(tx.time||'')}</div><div class="tx-who" style="font-size:12px;margin-top:4px;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;">${subLines}</div></div><div class="tx-amt ${tx.type==='in'?'plus':'minus'}" style="flex-shrink:0;align-self:flex-start;">${tx.type==='in'?'+':'−'}${tx.amt}₽</div></div>`;
        }).join('')}`;
    }).join('');
};
window.closeHistoryModal=function(){
    const modal = qs('historyModal');
    modal.classList.remove('open');
    modal.style.pointerEvents = 'none';
    unlockBodyScroll();
    // Clean up listeners
    if(modal._escHandler){ document.removeEventListener('keydown', modal._escHandler); modal._escHandler = null; }
    if(modal._swipeCleanup){ modal._swipeCleanup(); modal._swipeCleanup = null; }
};

// ─── GENERAL CHAT ─────────────────────────
function getPendingPhotos(ctx){return pendingPhotoQueues[ctx] || (pendingPhotoQueues[ctx]=[]);}
function pendingQueueEl(ctx){return qs(ctx==='chat'?'chatPhotoQueue':ctx==='news'?'newsPhotoQueue':'dmPhotoQueue');}
function renderPendingPhotos(ctx){
    const el=pendingQueueEl(ctx); if(!el) return;
    const items=getPendingPhotos(ctx);
    if(!items.length){el.classList.remove('open');el.innerHTML='';return;}
    el.classList.add('open');
    el.innerHTML=items.map(item=>`<div class="media-queue-item" data-id="${item.id}">
        <img loading="lazy" decoding="async" class="media-queue-thumb" src="${escHtml(item.dataUrl)}" onclick="openImgViewer('${escHtml(item.dataUrl).replace(/'/g,"&#39;")}')">
        <div class="media-queue-body">
            <textarea placeholder="Подпись..." oninput="updatePendingCaption('${ctx}', '${item.id}', this.value)">${escHtml(item.caption||'')}</textarea>
            <div class="media-queue-actions">
                <button class="msg-action-btn" style="color:var(--red);" onclick="removePendingPhoto('${ctx}', '${item.id}')">🗑</button>
            </div>
        </div>
    </div>`).join('')+`<button class="btn btn-primary btn-sm media-queue-send" onclick="sendPendingPhotos('${ctx}')">📤 Отправить ${items.length}</button>`;
}
window.updatePendingCaption=function(ctx,id,val){const items=getPendingPhotos(ctx);const item=items.find(x=>x.id===id);if(item)item.caption=val;};
window.removePendingPhoto=function(ctx,id){pendingPhotoQueues[ctx]=getPendingPhotos(ctx).filter(x=>x.id!==id);renderPendingPhotos(ctx);};
window.sendPendingPhotos=async function(ctx){
    const items=[...getPendingPhotos(ctx)];
    if(!items.length) return toast('⚠️ Нет фото в очереди','gold');
    for(const item of items){
        try{
            const mediaUrl=item.blob?await uploadBlobToStorage(item.blob,'media/images'):item.dataUrl;
            if(ctx==='chat') await sendChatMsg(item.caption||null,mediaUrl,'image');
            else if(ctx==='dm') await sendDmMsg(item.caption||null,mediaUrl,'image');
            else if(ctx==='news') await sendNewsDiscussionMsg(item.caption||null,mediaUrl,'image');
            pendingPhotoQueues[ctx]=getPendingPhotos(ctx).filter(x=>x.id!==item.id);
            renderPendingPhotos(ctx);
        }catch(error){
            toast('❌ Фото не отправлено: '+(error?.message||error),'red');
            return; // Failed items stay queued and can be retried.
        }
    }
    toast('📤 Фото отправлены','green');
};

window.sendChat=async function(){
    const inp=qs('chatInput');const text=inp.value.trim();if(!text)return;
    inp.value='';
    setChatTypingState('idle');
    try{ await sendChatMsg(text,null,null); }
    catch(e){ inp.value=text; toast('❌ Не удалось отправить сообщение','red'); }
};
async function sendChatMsg(text,mediaData,msgType,cameraFacing){
    const u = allUsersCache?.[currentNick] || (await get(userRef(currentNick))).val();
    const msg={nick:currentNick,avatar:u?.avatar||DEFAULT_AVATAR_URL,time:nowTime(),createdAt:Date.now()};
    if(text) { msg.text=text; if(mediaData) msg.caption=text; }
    if(mediaData) msg.mediaData=mediaData;
    if(msgType) msg.msgType=msgType;
    if(cameraFacing) msg.cameraFacing = cameraFacing;
    if(!text&&!mediaData) return;
    const pushed = await push(chatRef(),msg);
    void enqueuePushJob({type:'chat',id:String(pushed.key||''),sender:currentNick});
    // Только Cloud Function fan-out уведомлений по событию /chat/{messageId}.
    // Браузер пишет ровно одно сообщение и не рассылает уведомления сам.
    return pushed;
}

// ─── DM MESSENGER ─────────────────────────
function localDateKey(ts){ return new Date(ts || Date.now()).toLocaleDateString('sv-SE'); }
function getPinnedMap(){ return (allUsersCache[currentNick] && allUsersCache[currentNick].pinnedChats) || myPinnedChats || {}; }
function isChatPinned(nick){ return !!getPinnedMap()[nick]; }
function dmPreviewText(msg){
    if(!msg) return 'Новый чат';
    if(msg.msgType==='gift_subscription') return `🎁 ${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: Подарок подписки`;
    if(msg.msgType==='voice') return `🎤 ${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: Голосовое сообщение`;
    if(msg.msgType==='video_circle') return `⭕ ${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: Видеосообщение`;
    if(msg.msgType==='image') return `🖼 ${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: Фото`;
    if(msg.msgType==='video') return `🎬 ${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: Видео`;
    const txt = (msg.text || msg.caption || '').trim();
    if(!txt) return 'Пустое сообщение';
    const preview = txt.length > 54 ? txt.slice(0, 51) + '...' : txt;
    return `${msg.nick===currentNick ? 'Вы' : (displayNick(allUsersCache[msg.nick]) || msg.nick)}: ${preview}`;
}
function latestMessageFrom(messages){
    const arr = Object.values(messages || {});
    if(!arr.length) return null;
    return arr.slice().sort((a,b)=>(a?.createdAt||0)-(b?.createdAt||0)).at(-1) || null;
}
function updateDmConvoMeta(allDms){
    const meta = {};
    Object.entries(allDms || {}).forEach(([key, convo]) => {
        if(!key.includes(currentNick)) return;
        const parts = key.split('__dm__');
        const other = parts.find(n => n !== currentNick);
        if(!other) return;
        const latest = latestMessageFrom(convo.messages || {});
        if(!latest) {
            meta[other] = { key, lastTs: 0, latest: null, unread: false, lastRead: ((convo.lastRead || {})[currentNick]) || 0 };
            return;
        }
        const lastRead = ((convo.lastRead || {})[currentNick]) || 0;
        meta[other] = {
            key,
            lastTs: latest.createdAt || 0,
            latest,
            unread: latest.nick !== currentNick && (latest.createdAt || 0) > lastRead,
            lastRead
        };
    });
    dmConvoMeta = meta;
}
function renderDmContactList(users, pinnedOnly=false){
    const el = qs(pinnedOnly ? 'pinnedDmList' : 'dmUserList');
    if(!el) return;
    const pinned = getPinnedMap();
    const rows = Object.values(users || {})
        .filter(u => u && u.nick && u.nick !== currentNick)
        .map(u => {
            const meta = dmConvoMeta[u.nick] || { lastTs: 0, latest: null, unread: false };
            const isPinned = !!pinned[u.nick];
            if(pinnedOnly && !isPinned) return null;
            return { u, meta, isPinned, online: isUserOnline(u) };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if(a.isPinned !== b.isPinned) return Number(b.isPinned) - Number(a.isPinned);
            if(a.meta.unread !== b.meta.unread) return Number(b.meta.unread) - Number(a.meta.unread);
            if((b.meta.lastTs || 0) !== (a.meta.lastTs || 0)) return (b.meta.lastTs || 0) - (a.meta.lastTs || 0);
            return (displayNick(a.u) || a.u.nick).localeCompare(displayNick(b.u) || b.u.nick, 'ru');
        });
    if(!rows.length){
        el.innerHTML = pinnedOnly
            ? '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Пока ничего не закреплено</div>'
            : '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Нет чатов</div>';
        return;
    }
    el.innerHTML = rows.map(({u, meta, isPinned, online}) => {
        const preview = dmPreviewText(meta.latest) + (meta.unread ? ' · 🔴' : '');
        const badge = meta.unread ? `<span class="dm-unread-badge">${meta.latest?.msgType ? '1' : '•'}</span>` : '';
        
        // Apply avatar frame for users with subscriptions
        const frameClass = getAvatarFrameClass(u);
        const avatarFrameHtml = frameClass
            ? `<div class="avatar-frame ${frameClass}" style="position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;z-index:1;"></div>`
            : '';

        return `<div class="dm-user-row" onclick="${pinnedOnly ? 'openPinnedDmChat' : 'openDmChat'}('${escHtml(u.nick)}')">
            <div class="av-wrap-sm ${online ? 'online' : ''}" style="position:relative;">
                <img class="dm-user-av" src="${escHtml(u.avatar||DEFAULT_AVATAR_URL)}" loading="lazy">
                ${avatarFrameHtml}
                <div class="online-dot"></div>
            </div>
            <div class="dm-user-info">
                <div class="dm-user-name">${escHtml(displayNick(u) || u.nick)}${isPinned ? ' <span style="color:var(--gold);font-size:12px;">📌</span>' : ''}</div>
                <div class="dm-user-preview" style="color:${meta.unread ? 'var(--text)' : (online ? '#22c55e' : 'var(--muted)')};">${escHtml(preview)}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
                ${badge}
                <button type="button" class="msg-action-btn dm-pin-btn ${isPinned ? 'pinned' : ''}" onclick="event.stopPropagation();togglePinChat('${escHtml(u.nick)}')">${isPinned ? '📌' : '➕'}</button>
            </div>
        </div>`;
    }).join('');
}
window.openPinnedDmChat = function(nick){
    switchMsgTab(1);
    setTimeout(()=>openDmChat(nick), 50);
};
window.togglePinChat = async function(nick){
    if(!currentNick || !nick || nick === currentNick) return;
    const cur = { ...getPinnedMap() };
    const willPin = !cur[nick];
    if(willPin) cur[nick] = Date.now(); else delete cur[nick];
    myPinnedChats = cur;
    try{
        await update(userRef(currentNick), { pinnedChats: cur });
        toast(willPin ? '📌 Чат закреплён' : '📍 Чат откреплён', 'green');
        if(curPage === 'messages' && document.querySelector('#msgPanel1.active')){
             renderDmUserList(allUsersCache);
         }
    }catch(e){
        toast('❌ Не удалось сохранить закрепление','red');
    }
};
window.switchMsgTab=function(i){
    [0,1].forEach(j=>{const tab=qs(`msgTab${j}`); if(tab) tab.classList.toggle('active',j===i); const panel=qs(`msgPanel${j}`); if(panel) panel.classList.toggle('active',j===i);});
    setGeneralChatPresence(i===0);
    if(i===0){
        const host = qs('chatMessages');
        if(host && !host.innerHTML.trim()){ host.innerHTML = loadingHtml('Загрузка чата...'); }
        chatLoading=false;
        Promise.resolve(renderChat(lastChatMsgs||{})).catch(err=>console.warn('[Kapani chat render]',err));
        try{set(ref(db,`readState/${currentNick}/chat`),Date.now());}catch(e){}
    }
    if(i===1){
        renderDmContactList(allUsersCache, false);
        if(!allUsersCacheLoaded){
            loadAllUsersCache().then(users=>{
                if(curPage==='messages' && document.querySelector('#msgPanel1.active')) renderDmUserList(users);
            }).catch(e=>console.warn('[Kapani DM users cache]',e));
        }
    }
};
window.renderDmUserList=function(users){ renderDmContactList(users, false); };
window.renderPinnedDmList=function(users){ renderDmContactList(users, true); };
window.openDmChat=async function(nick){
    if(!currentNick || !nick) return;

    // Every open gets its own generation. Late Firebase callbacks from a
    // previous chat are ignored and can no longer replace the new chat.
    const openSeq = (window._dmOpenSeq = (window._dmOpenSeq || 0) + 1);
    currentDmNick = nick;
    try{ await set(ref(db,`presence/${currentNick}/dmOpenWith`),nick); }catch(e){}
    dmPeerReadTs = 0;

    const listView = qs('dmListView');
    const chatView = qs('dmChatView');
    const messagesEl = qs('dmMessages');
    const headerName = qs('dmChatName');
    const avWrap = qs('dmChatAvWrap');

    // Stop previous listeners before starting a new conversation.
    if(dmListeners.current?.unsub){ try{ dmListeners.current.unsub(); }catch(e){} }
    else if(dmListeners.current){ try{ off(dmListeners.current.ref,'value',dmListeners.current.fn); }catch(e){} }
    dmListeners.current = null;
    if(dmListeners.read?.unsub){ try{ dmListeners.read.unsub(); }catch(e){} }
    else if(dmListeners.read){ try{ off(dmListeners.read.ref,'value',dmListeners.read.fn); }catch(e){} }
    dmListeners.read = null;
    if(dmTypingUnsub){ try{ dmTypingUnsub(); }catch(e){} dmTypingUnsub = null; }

    if(listView) listView.style.display='none';
    if(chatView) chatView.style.display='block';
    if(messagesEl){
        messagesEl.dataset.sig='';
        messagesEl.innerHTML = loadingHtml('Загрузка сообщений...');
    }
    dmLoading = true;

    try{
        let u = allUsersCache?.[nick] || null;
        if(!u){
            const snap = await get(userRef(nick));
            u = snap.exists() ? (snap.val() || {}) : {nick,avatar:'',job:'Житель'};
            if(snap.exists()){
                allUsersCache[nick]=u;
                window.allUsersCache=allUsersCache;
            }
        }
        if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
        const online = isUserOnline(u);

        toggleAvatarMedia(qs('dmChatAv'), qs('dmChatAvVideo'), u.avatar||DEFAULT_AVATAR_URL);
        if(headerName) headerName.textContent = displayNick(u)||u.nick;
        updateDmLiveStatus(u, null);
        if(avWrap) avWrap.classList.toggle('online',online);

        // Apply avatar frame for chat header.
        if(avWrap){
            avWrap.querySelectorAll('.avatar-frame').forEach(el=>el.remove());
            const frameClass = getAvatarFrameClass(u);
            if(frameClass){
                const frameEl = document.createElement('div');
                frameEl.className = `avatar-frame ${frameClass}`;
                frameEl.style.cssText = 'position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;z-index:1;';
                avWrap.appendChild(frameEl);
            }
        }

        const key = dmKey(currentNick,nick);
        try{ await update(dmIndexRef(currentNick),{[nick]:{...(dmConvoMeta[nick]||{}),unread:false,lastReadAt:Date.now()}}); }catch(e){ console.warn('[DM index read]',e); }
        const dmR = query(dmRef(key),orderByChild('createdAt'),limitToLast(80));
        const dmFn = (snap2) => {
            if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
            dmLoading = false;
            lastDmMsgs = snap2.val() || {};
            const host = qs('dmMessages');
            if(host) host.removeAttribute('data-dm-load-error');
            Promise.resolve(renderDmMessages(lastDmMsgs)).catch(err=>{
                console.error('[Kapani DM render]',err);
                dmLoading = false;
                if(host && currentDmNick === nick) host.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;">Не удалось отобразить сообщения. Нажмите «Назад» и откройте чат снова.</div>';
            });
        };
        const dmCancel = (err) => {
            if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
            dmLoading = false;
            const host = qs('dmMessages');
            if(host) host.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;">❌ Не удалось загрузить сообщения. Проверьте соединение и откройте чат ещё раз.</div>';
            console.warn('[Kapani DM listener]', err?.message || err);
        };
        const unsub = onValue(dmR, dmFn, dmCancel);
        dmListeners.current = {ref:dmR, fn:dmFn, unsub};

        // Safety timeout: a Firebase listener that never synchronizes must not
        // leave the user on an endless spinner forever.
        const timeoutId = setTimeout(()=>{
            if(openSeq !== window._dmOpenSeq || currentDmNick !== nick || !dmLoading) return;
            dmLoading = false;
            try{ unsub(); }catch(e){}
            if(dmListeners.current?.unsub === unsub) dmListeners.current = null;
            const host = qs('dmMessages');
            if(host) host.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;">⏱️ Чат загружается слишком долго. Проверьте интернет и откройте его снова.</div>';
        }, 12000);
        dmListeners.current.timeoutId = timeoutId;

        try{ await set(ref(db,`dms/${key}/lastRead/${currentNick}`),Date.now()); }catch(e){ console.warn('[Kapani DM lastRead]', e); }

        const peerReadRef = ref(db,`dms/${key}/lastRead/${nick}`);
        const readFn = (rs) => {
            if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
            dmPeerReadTs = rs.exists() ? (rs.val()||0) : 0;
            Promise.resolve(renderDmMessages(lastDmMsgs)).catch(err=>console.warn('[Kapani DM read render]',err));
        };
        const readCancel = err => console.warn('[Kapani DM read listener]', err?.message || err);
        const readUnsub = onValue(peerReadRef,readFn,readCancel);
        dmListeners.read = {ref:peerReadRef,fn:readFn,unsub:readUnsub};

        const typingRef = typingDmRef(key,nick);
        const typingCb = (ts) => {
            if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
            const typingVal = ts.val() || null;
            const freshUser = allUsersCache[nick] || u;
            updateDmLiveStatus(freshUser, typingVal);
        };
        const typingUnsub = onValue(typingRef,typingCb,err=>console.warn('[Kapani DM typing]',err?.message || err));
        dmTypingUnsub = () => { try{typingUnsub();}catch(e){} };
    }catch(err){
        if(openSeq !== window._dmOpenSeq || currentDmNick !== nick) return;
        dmLoading = false;
        console.error('[Kapani openDmChat]', err);
        if(messagesEl) messagesEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;">❌ Не удалось открыть чат. Проверьте соединение и попробуйте снова.</div>';
    }
};
window.closeDmChat=function(){
    window._dmOpenSeq = (window._dmOpenSeq || 0) + 1;
    if(dmListeners.current){
        try{ if(dmListeners.current.timeoutId) clearTimeout(dmListeners.current.timeoutId); }catch(e){}
        try{ if(dmListeners.current.unsub) dmListeners.current.unsub(); else off(dmListeners.current.ref,'value',dmListeners.current.fn); }catch(e){}
        dmListeners.current=null;
    }
    if(dmListeners.read){
        try{ if(dmListeners.read.unsub) dmListeners.read.unsub(); else off(dmListeners.read.ref,'value',dmListeners.read.fn); }catch(e){}
        dmListeners.read=null;
    }
    if(dmTypingUnsub){ try{ dmTypingUnsub(); }catch(e){} dmTypingUnsub = null; }
    setDmTypingState('idle');
    try{ set(ref(db,`presence/${currentNick}/dmOpenWith`),null); }catch(e){}
    currentDmNick=null;dmPeerReadTs=0;dmLoading=false;
    const mv=qs('dmChatView'),lv=qs('dmListView');
    if(mv) mv.style.display='none'; if(lv) lv.style.display='block';
};
window.sendDm=async function(){
    const inp=qs('dmInput');const text=inp.value.trim();if(!text||!currentDmNick)return;
    inp.value='';
    setDmTypingState('idle');
    try{ await sendDmMsg(text,null,null); }
    catch(e){ inp.value=text; toast('❌ Не удалось отправить сообщение','red'); }
};
async function sendDmMsg(text,mediaData,msgType,cameraFacing){
    if(!currentDmNick)return;
    // currentNick's user record is already kept live via attachUserListener(),
    // so avoid a fresh get() on every single message send.
    const u = allUsersCache?.[currentNick] || (await get(userRef(currentNick))).val();
    const msg={nick:currentNick,avatar:u?.avatar||DEFAULT_AVATAR_URL,time:nowTime(),createdAt:Date.now()};
    if(text) { msg.text=text; if(mediaData) msg.caption=text; }
    if(mediaData) msg.mediaData=mediaData;
    if(msgType) msg.msgType=msgType;
    if(cameraFacing) msg.cameraFacing = cameraFacing;
    const key=dmKey(currentNick,currentDmNick);
    await push(dmRef(key),msg);
    const latestMeta={lastTs:msg.createdAt,latest:{nick:msg.nick,avatar:msg.avatar,text:msg.text||'',msgType:msg.msgType||null,time:msg.time,createdAt:msg.createdAt}};
    try{await update(dmIndexRef(currentNick),{[currentDmNick]:{...latestMeta,unread:false}});await update(dmIndexRef(currentDmNick),{[currentNick]:{...latestMeta,unread:true}});}catch(e){console.warn('[DM index update]',e);}
    let notifText;
    if(msgType==='voice') notifText=`🎤 ${currentNick}: Голосовое сообщение`;
    else if(msgType==='video_circle') notifText=`⭕ ${currentNick}: Видеосообщение`;
    else if(msgType==='image') notifText=`🖼 ${currentNick}: Фото`;
    else if(msgType==='video') notifText=`🎥 ${currentNick}: Видео`;
    else { const preview=text?(text.length>60?text.slice(0,57)+'...':text):''; notifText=`💬 ${currentNick}: ${preview}`; }
    if(currentDmNick!==currentNick){
        await pushNotification(currentDmNick,notifText,'messages',{source:'dm',sourceMessageId:`${key}:${msg.createdAt}`,url:`${new URL('./',location.href).pathname}?kpSection=messages&kpDm=${encodeURIComponent(currentDmNick)}`});
    }
}

// ─── USER PROFILE MODAL ───────────────────
function buildWallEmojiIfNeeded(){
    const el=qs('wallEmojiPanel');if(!el||el.dataset.built)return;
    el.dataset.built='1';
    const grid=document.createElement('div');grid.className='emoji-grid';
    EMOJI_LIST.forEach(em=>{const btn=document.createElement('button');btn.className='ep-btn';btn.textContent=em;btn.onclick=()=>{const inp=qs('wallInput');if(!inp)return;inp.value+=em;inp.focus();};grid.appendChild(btn);});
    el.appendChild(grid);
}
function wallPostBodyHtml(p){
    let body='';
    if(p.text)body+=`<div style="font-size:14px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${escHtml(p.text)}</div>`;
    if(p.msgType==='image'&&p.mediaData)body+=`<img loading="lazy" decoding="async" src="${escHtml(p.mediaData)}" style="max-width:100%;border-radius:12px;margin-top:8px;cursor:pointer;" onclick="event.stopPropagation();openImgViewer('${jsEsc(p.mediaData)}')">`;
    if(p.msgType==='video'&&p.mediaData)body+=`<video src="${escHtml(p.mediaData)}" controls playsinline webkit-playsinline style="max-width:100%;border-radius:12px;margin-top:8px;"></video>`;
    if(p.msgType==='video_circle'&&p.mediaData){
        const tf = (p.cameraFacing || 'user') === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
        body+=`<div class="msg-media-wrap msg-media-circle" style="margin-top:6px;"><div class="msg-video-wrap" onclick="openVideoViewer('${jsEsc(p.mediaData)}', { transform: '${tf}' })" style="background:#111;"><video muted preload="metadata" playsinline webkit-playsinline style="pointer-events:none;transform:${tf} !important;-webkit-transform:${tf} !important;"><source src="${escHtml(p.mediaData)}#t=0.1"></video><div class="vc-play-overlay">▶</div></div></div>`;
    }
    if(p.msgType==='voice'&&p.mediaData)body+=`<div class="wall-audio" style="margin-top:8px;"><audio controls preload="metadata" style="width:100%;max-width:100%;height:36px;"><source src="${escHtml(p.mediaData)}"></audio></div>`;
    return body;
}
function wallPostCardHtml(ownerNick, postId, p){
    const canDelete = ownerNick === currentNick;
    return `<div class="wall-post">
        <div class="wall-post-actions">
            <div class="wall-post-meta">${escHtml(p.date||'')} · ${escHtml(p.time||'')}</div>
            ${canDelete ? `<button type="button" class="msg-action-btn" style="color:var(--red);" onclick="deleteWallPost('${jsEsc(ownerNick)}','${jsEsc(postId)}')">🗑</button>` : ''}
        </div>
        ${wallPostBodyHtml(p)}
    </div>`;
}
window.deleteWallPost=async function(ownerNick, postId){
    if(ownerNick!==currentNick) return;
    if(!confirm('Удалить пост?')) return;
    await remove(ref(db,`walls/${ownerNick}/${postId}`));
    const s=await get(wallRef(ownerNick));
    if(curPage==='profile') renderWallFeed(s.val()||{});
    if(window._visitorProfileNick===ownerNick) await renderVisitorProfilePage(ownerNick);
    toast('🗑 Пост удалён','green');
};
function renderWallFeed(data){
    const el=qs('wallFeed');if(!el)return;
    const arr=Object.entries(data||{}).map(([id,p])=>({...p,id})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    el.innerHTML=arr.length===0?'<div style="color:var(--muted);font-size:13px;">Пока пусто</div>':arr.map(p=>wallPostCardHtml(currentNick,p.id,p)).join('');
}
async function applyFirstWallReward(u){
    if(u.rewardedWall)return;
    await creditTaskRewardOnce('rewardedWall',REWARD_FIRST_WALL,'Первый пост в ленте');
}
async function pushWallPostMedia(msgType,mediaData){
    const text=(qs('wallInput')?.value||'').trim();
    if(!text&&!mediaData)return toast('⚠️ Добавьте текст или запишите медиа','gold');
    const uSnap=await get(userRef(currentNick));const u=uSnap.val()||{};
    const msg={text:text||'',date:new Date().toLocaleDateString('ru'),time:nowTime(),createdAt:Date.now()};
    if(msgType&&mediaData){msg.msgType=msgType;msg.mediaData=mediaData;}
    await push(wallRef(currentNick),msg);
    wallMediaPending=null;qs('wallInput').value='';qs('wallMediaPreview').style.display='none';
    const s=await get(wallRef(currentNick));renderWallFeed(s.val()||{});
    if(!u.rewardedWall)await applyFirstWallReward(u);
    else toast('📤 Опубликовано','green');
}
window.onWallMediaPick=async function(e){
    const f=e.target.files[0];e.target.value='';
    if(!f)return;
    if(f.type.startsWith('image/')){wallMediaPending={type:'image',dataUrl:await compressImage(f,900,0.82)};qs('wallMediaPreview').textContent='📷 Фото готово';qs('wallMediaPreview').style.display='block';return;}
    if(f.type.startsWith('video/')&&f.size<15*1024*1024){toast('🎬 Видео...','gold');wallMediaPending={type:'video',dataUrl:await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);})};qs('wallMediaPreview').textContent='🎬 Видео готово';qs('wallMediaPreview').style.display='block';return;}
    toast('❌ Файл слишком большой или не поддерживается','red');
};
window.publishWallPost=async function(){
    const text=(qs('wallInput')?.value||'').trim();
    if(!text&&!wallMediaPending)return toast('⚠️ Текст или медиа','gold');
    const uSnap=await get(userRef(currentNick));const u=uSnap.val()||{};
    const msg={text:text||'',date:new Date().toLocaleDateString('ru'),time:nowTime(),createdAt:Date.now()};
    if(wallMediaPending){msg.msgType=wallMediaPending.type==='image'?'image':'video';msg.mediaData=wallMediaPending.dataUrl;}
    await push(wallRef(currentNick),msg);
    wallMediaPending=null;qs('wallInput').value='';qs('wallMediaPreview').style.display='none';
    const s=await get(wallRef(currentNick));renderWallFeed(s.val()||{});
    if(!u.rewardedWall)await applyFirstWallReward(u);
    else toast('📤 Опубликовано','green');
};

window.openUserProfile=async function(nick){
    if(nick===currentNick){navTo('profile');return;}
    // Prevent rapid double-open
    if(viewingProfileNick === nick && qs('userProfileModal').classList.contains('open')) return;
    viewingProfileNick=nick;
    const profileModal = qs('userProfileModal');
    const switchingWithinOpenProfile = !!(profileModal && profileModal.classList.contains('open'));
    const snap=await get(userRef(nick));if(!snap.exists())return toast('❌ Не найден','red');const u=snap.val();const online=isUserOnline(u);
    
    // Check subscription status
    const expiry = u.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    const isActive = expiry && expiry > new Date();
    
    // Display subscription badge if active
    let subscriptionHtml = '';
    if(u.subscription === 'plus' && isActive){
        subscriptionHtml = '<div style="margin-bottom:8px;text-align:center;"><span class="sub-badge-plus">⭐ Kapani Plus</span></div>';
    } else if(u.subscription === 'ultra' && isActive){
        subscriptionHtml = '<div style="margin-bottom:8px;text-align:center;"><span class="sub-badge-ultra">💎 Kapani Ultra</span></div>';
    } else if(u.subscription === 'prime' && isActive){
        subscriptionHtml = '<div style="margin-bottom:8px;text-align:center;"><span class="sub-badge-prime">👑 <span class="text-rainbow-prime">Kapani Prime</span></span></div>';
    }
    
    toggleAvatarMedia(qs('upmAv'), qs('upmAvVideo'), u.avatar||DEFAULT_AVATAR_URL);
    qs('upmAv').onclick=()=>isVideoAvatarSrc(u.avatar||DEFAULT_AVATAR_URL) ? openVideoViewer(u.avatar||DEFAULT_AVATAR_URL) : openImgViewer(u.avatar||DEFAULT_AVATAR_URL);
    if(qs('upmAvVideo')) qs('upmAvVideo').onclick=()=>openVideoViewer(u.avatar||DEFAULT_AVATAR_URL);
    qs('upmNick').textContent=(displayNick(u)||u.nick)+(u.nick===ADMIN?' 👑':'');qs('upmJob').textContent=getUserBusinessRoleLabel(u, u.nick || currentNick);
    
    // Display subscription badge in visitor profile
    const vpfSubBadge = qs('vpfSubscriptionBadge');
    if(vpfSubBadge) {
        if(u.subscription === 'plus' && isActive){
            vpfSubBadge.textContent = '⭐ Kapani Plus';
            vpfSubBadge.style.color = 'var(--gold)';
            vpfSubBadge.style.display = 'block';
        } else if(u.subscription === 'ultra' && isActive){
            vpfSubBadge.textContent = '💎 Kapani Ultra';
            vpfSubBadge.style.color = '#f0444a';
            vpfSubBadge.style.display = 'block';
        } else if(u.subscription === 'prime' && isActive){
            vpfSubBadge.innerHTML = '👑 <span class="text-rainbow-prime">Kapani Prime</span>';
            vpfSubBadge.style.color = '';
            vpfSubBadge.style.display = 'block';
        } else {
            vpfSubBadge.style.display = 'none';
        }
    }
    const onlineEl=qs('upmOnline');if(onlineEl){onlineEl.className=`upm-online ${online?'is-online':'is-offline'}`;onlineEl.querySelector('span').textContent=online?'В сети':formatLastSeen(u);}
    const avWrap=qs('upmAvatarWrap');if(avWrap)avWrap.classList.toggle('online',online);
    
    // Apply avatar frame using the centralized mapping.
    const frameContainer = qs('upmAvatarWrap');
    if(frameContainer){
        const existingFrame = frameContainer.querySelector('.avatar-frame');
        if(existingFrame) existingFrame.remove();
        const frameClass = getAvatarFrameClass(u);
        if(frameClass){
            const frameEl = document.createElement('div');
            frameEl.className = `avatar-frame ${frameClass}`;
            frameEl.style.cssText = 'position:absolute;inset:-8px;border-radius:inherit;pointer-events:none;z-index:1;';
            frameContainer.appendChild(frameEl);
        }
    }

    // Apply profile background using the same mapping as the full profile page.
    const profileSheet = document.querySelector('#userProfileModal .user-profile-sheet');
    const wallHost = document.getElementById('upmWallHost');
    if(profileSheet) profileSheet.classList.remove(...PROFILE_EFFECT_CLASSES);
    if(wallHost) wallHost.classList.remove(...PROFILE_EFFECT_CLASSES);
    const bgClass = getProfileBgClass(u);
    if(bgClass){
        if(profileSheet) profileSheet.classList.add(bgClass);
        if(wallHost) wallHost.classList.add(bgClass);
    }
    applyPrimeCoverToElement(profileSheet, bgClass === 'profile-bg-custom' ? 'custom' : '', u.profileCustomBg);
    applyPrimeCoverToElement(wallHost, bgClass === 'profile-bg-custom' ? 'custom' : '', u.profileCustomBg);

    qs('upmStats').innerHTML = (subscriptionHtml ? `<div style="grid-column:1/-1;text-align:center;margin-bottom:8px;">${subscriptionHtml}</div>` : '') + `<div class="stat-box" style="grid-column:1/-1;"><div class="sv" style="font-size:16px;">${escHtml(getUserBusinessRoleLabel(u, u.nick || ''))}</div><div class="sl">Должность</div></div>${u.vehicle?`<div class="stat-box" style="grid-column:1/-1;"><div class="sv" style="font-size:14px;">🛵 ${escHtml(u.vehicle)}</div><div class="sl">Транспорт</div></div>`:''}`;
    const wSnap=await get(wallRef(nick));
    const posts=Object.entries(wSnap.val()||{}).map(([id,p])=>({...p,id})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,12);
    const wallHtml=posts.length?`<div style="margin-top:16px;"><div style="font-weight:900;font-size:12px;color:var(--muted);margin-bottom:8px;">📰 Лента</div>${posts.map(p=>wallPostCardHtml(nick,p.id||'',p)).join('')}</div>`:'';
    let sheet=document.getElementById('upmWallHost');
    if(!sheet){sheet=document.createElement('div');sheet.id='upmWallHost';document.querySelector('.user-profile-sheet').appendChild(sheet);}
    sheet.classList.remove(...PROFILE_EFFECT_CLASSES);
    if(bgClass) sheet.classList.add(bgClass);
    applyPrimeCoverToElement(sheet, bgClass === 'profile-bg-custom' ? 'custom' : '', u.profileCustomBg);
    sheet.innerHTML=wallHtml;
    const modal = qs('userProfileModal');
    if(!switchingWithinOpenProfile){
        lockBodyScroll();
        modal.dataset.bodyLockHeld = '1';
    }
    modal.style.display = 'flex';
    modal.style.pointerEvents = 'auto';
    // rAF ensures display:flex is applied before class triggers animation
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            modal.classList.add('open');
        });
    });
};
window.closeUserProfile=function(){
    const modal = qs('userProfileModal');
    modal.classList.remove('open');
    modal.style.pointerEvents = 'none';
    // Delay hiding to allow close animation, then restore scroll.
    // IMPORTANT: unlockBodyScroll is called INSIDE the timeout so that on iOS
    // the body position:fixed is removed only after the modal is display:none.
    // Calling it earlier leaves a window where taps fall on the invisible modal
    // layer instead of the tabs/nav below it.
    setTimeout(()=>{
        if(!modal.classList.contains('open')){
            modal.style.display='none';
            modal.style.pointerEvents = '';
        }
        if(modal.dataset.bodyLockHeld === '1'){
            modal.dataset.bodyLockHeld = '0';
            unlockBodyScroll();
        } else {
            unlockBodyScroll(true);
        }
    }, 350);
    viewingProfileNick=null;
};
window.goToDmFromProfile=function(){if(!viewingProfileNick)return;const nick=viewingProfileNick;closeUserProfile();navTo('messages');setTimeout(()=>{switchMsgTab(1);setTimeout(()=>openDmChat(nick),200);},200);};
window.goToTransferFromProfile=async function(){
    if(!viewingProfileNick) return;
    const nick=viewingProfileNick;
    let publicName = nick;
    try {
        const snap = await get(userRef(nick));
        const u = snap.val() || {};
        publicName = displayNick(u) || nick;
    } catch(e) {}
    closeUserProfile();
    navTo('bank');
    setTimeout(()=>{const el=qs('bTo');if(el)el.value=publicName;},200);
};
async function renderVisitorProfilePage(nick){
    const snap=await get(userRef(nick));
    if(!snap.exists()){toast('❌ Пользователь не найден','red');navTo('home');return;}
    const u=snap.val();
    window._visitorProfileNick=nick;
    const online=isUserOnline(u);
    
    // Check subscription status
    const expiry = u.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    const isActive = expiry && expiry > new Date();
    
    toggleAvatarMedia(qs('vpfAv'), qs('vpfAvVideo'), u.avatar||DEFAULT_AVATAR_URL);
    qs('vpfName').textContent=(u.nicknameEmoji ? u.nicknameEmoji + ' ' : '') + (displayNick(u)||u.nick)+(u.nick===ADMIN?' 👑':'');
    qs('vpfJob').textContent=getUserBusinessRoleLabel(u, u.nick || currentNick);
    
    // Profile description
    const descEl = qs('vpfDescription');
    if(descEl) {
        if(u.profileDescription && u.profileDescription.trim()) {
            descEl.textContent = u.profileDescription.trim();
            descEl.style.display = 'block';
        } else {
            descEl.style.display = 'none';
        }
    }
    const vo=qs('vpfOnline');
    if(vo){vo.className='upm-online '+(online?'is-online':'is-offline');const sp=vo.querySelector('span');if(sp)sp.textContent=online?'В сети':formatLastSeen(u);}
    
    // Apply profile background + avatar frame with the same mappings as the own profile.
    const profileBgEffect = qs('vpfProfileBgEffect');
    if(profileBgEffect){
        profileBgEffect.classList.remove(...PROFILE_EFFECT_CLASSES);
        const bgClass = getProfileBgClass(u);
        if(bgClass) profileBgEffect.classList.add(bgClass);
        applyPrimeCoverToElement(profileBgEffect, bgClass === 'profile-bg-custom' ? 'custom' : '', u.profileCustomBg);
    }
    const visitorFrame = qs('vpfAvatarFrame');
    if(visitorFrame){
        visitorFrame.className = 'avatar-frame';
        const frameClass = getAvatarFrameClass(u);
        visitorFrame.style.display = frameClass ? 'block' : 'none';
        if(frameClass) visitorFrame.classList.add(frameClass);
    }

    const wSnap=await get(wallRef(nick));
    const posts=Object.entries(wSnap.val()||{}).map(([id,p])=>({...p,id})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    qs('vpfWall').innerHTML=posts.length?posts.map(p=>wallPostCardHtml(nick,p.id||'',p)).join(''):'<div style="color:var(--muted);font-size:13px;">Пока пусто</div>';
}
window.openVisitorProfilePage=async function(){
    const nick=viewingProfileNick;
    if(!nick)return;
    closeUserProfile();
    await renderVisitorProfilePage(nick);
    navTo('visitorProfile');
};
window.closeVisitorProfile=function(){window._visitorProfileNick=null;navTo('home');};
window.visitorProfileDm=function(){const n=window._visitorProfileNick;if(!n)return;navTo('messages');setTimeout(()=>{switchMsgTab(1);setTimeout(()=>openDmChat(n),200);},200);};
window.visitorProfileTransfer=async function(){
    const n=window._visitorProfileNick;
    if(!n) return;
    let publicName = n;
    try {
        const snap = await get(userRef(n));
        const u = snap.val() || {};
        publicName = displayNick(u) || n;
    } catch(e) {}
    navTo('bank');
    setTimeout(()=>{const el=qs('bTo');if(el)el.value=publicName;},200);
};

// ─── TASKS ────────────────────────────────
function taskRowHtml(task){
    return `<div class="task-item">
        <div class="task-main">
            <div class="task-name">${escHtml(task.title)}</div>
            <div class="task-desc">${escHtml(task.desc)}</div>
            <div class="task-reward">${escHtml(task.reward)}</div>
        </div>
        <div class="task-state ${task.done ? 'done' : 'todo'}">${task.done ? 'Выполнено' : 'В процессе'}</div>
    </div>`;
}
// ─── DAILY TASKS ROTATION ─────────────────
const ALL_DAILY_TASKS = [
    { id:'chat', title:'💬 Сообщение в общий чат', desc:'Отправьте хотя бы одно сообщение сегодня.', reward:10 },
    { id:'wall', title:'📰 Пост в ленте', desc:'Добавьте пост в ленту сегодня.', reward:10 },
    { id:'transfer', title:'💸 Перевод жителю', desc:'Переведите деньги другому жителю сегодня.', reward:15 },
    { id:'shop', title:'🛒 Заказ в магазине', desc:'Оформите заказ ресурсов сегодня.', reward:20 },
    { id:'taxi_req', title:'🛵 Заказ такси', desc:'Вызовите такси сегодня.', reward:20 },
    { id:'market_browse', title:'🛍 Открыть маркетплейс', desc:'Загляните в маркетплейс сегодня.', reward:5 },
    { id:'dm', title:'✉️ Написать жителю', desc:'Отправьте личное сообщение сегодня.', reward:10 },
];
function getDailyTasksForToday(){
    // Pick 3 tasks that rotate daily based on date seed
    const dateNum = parseInt(todayKey().replace(/-/g,''), 10);
    const seed = dateNum % 997;
    const shuffled = [...ALL_DAILY_TASKS];
    // deterministic shuffle
    for(let i=shuffled.length-1;i>0;i--){
        const j=(seed*(i+1)+i*37)%shuffled.length;
        [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
    }
    return shuffled.slice(0,3);
}
// ─── KAPANI PRIME DAILY TASKS (выше выплаты) ─────
const ALL_PRIME_DAILY_TASKS = [
    { id:'prime_listing', title:'👑 Новое объявление (Prime)', desc:'Опубликуйте новое объявление на маркетплейсе сегодня.', reward:60 },
    { id:'prime_transfer_big', title:'👑 Крупный перевод (Prime)', desc:'Переведите от 200₽ другому жителю сегодня.', reward:70 },
    { id:'prime_taxi2', title:'👑 2 заказа такси (Prime)', desc:'Сделайте 2 заказа такси сегодня.', reward:90 },
    { id:'prime_chat5', title:'👑 Активность в чате (Prime)', desc:'Отправьте 5 сообщений в общий чат сегодня.', reward:50 },
    { id:'prime_dm3', title:'👑 Переписка (Prime)', desc:'Отправьте 3 личных сообщения сегодня.', reward:65 },
    { id:'prime_shop_big', title:'👑 Крупная покупка (Prime)', desc:'Сделайте заказ в магазине на сумму от 150₽ сегодня.', reward:80 },
];
function getPrimeDailyTasksForToday(){
    const dateNum = parseInt(todayKey().replace(/-/g,''), 10);
    const seed = (dateNum * 31) % 991;
    const shuffled = [...ALL_PRIME_DAILY_TASKS];
    for(let i=shuffled.length-1;i>0;i--){
        const j=(seed*(i+1)+i*53)%shuffled.length;
        [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
    }
    return shuffled.slice(0,2);
}
async function checkPrimeDailyTaskCondition(taskId, u, ordersVal, marketVal, chatVal, wallVal, dmVal, txVal){
    const today = todayKey();
    switch(taskId){
        case 'prime_listing': return Object.values(marketVal||{}).some(l=>l.seller===currentNick&&localDateKey(l.createdAt||0)===today);
        case 'prime_transfer_big': return Object.values(txVal||{}).some(tx=>tx.type==='out'&&tx.date===new Date().toLocaleDateString('ru')&&tx.desc&&tx.desc.startsWith('Перевод пользователю')&&Number(tx.amt||0)>=200);
        case 'prime_taxi2': return Object.values(ordersVal||{}).filter(o=>o.client===currentNick&&o.type==='taxi'&&localDateKey(o.createdAt||0)===today).length>=2;
        case 'prime_chat5': return Object.values(chatVal||{}).filter(m=>m.nick===currentNick&&localDateKey(m.createdAt||0)===today).length>=5;
        case 'prime_dm3': return Object.values(dmVal||{}).filter(m=>m.nick===currentNick&&localDateKey(m.createdAt||0)===today).length>=3;
        case 'prime_shop_big': return Object.values(ordersVal||{}).some(o=>o.client===currentNick&&o.type==='shop'&&Number(o.total||o.amount||0)>=150);
        default: return false;
    }
}
async function checkDailyTaskCondition(taskId, u, ordersVal, marketVal, chatVal, wallVal, dmVal, txVal){
    const today = todayKey();
    switch(taskId){
        case 'chat': return Object.values(chatVal||{}).some(m=>m.nick===currentNick&&localDateKey(m.createdAt||0)===today);
        case 'wall': return Object.values(wallVal||{}).some(p=>localDateKey(p.createdAt||0)===today);
        case 'transfer': return Object.values(txVal||{}).some(tx=>tx.type==='out'&&tx.date===new Date().toLocaleDateString('ru')&&tx.desc&&tx.desc.startsWith('Перевод пользователю'));
        case 'shop': return Object.values(ordersVal||{}).some(o=>o.client===currentNick&&o.type==='shop') || Object.values(window._taskDeliveryCustomOrders||{}).some(o=>o.client===currentNick && (o.source==='business' || o.itemKind==='business_product'));
        case 'taxi_req': return Object.values(ordersVal||{}).some(o=>o.client===currentNick&&o.type==='taxi');
        case 'market_browse': return true; // just opening tasks page counts
        case 'dm': return Object.values(dmVal||{}).some(m=>m.nick===currentNick&&localDateKey(m.createdAt||0)===today);
        default: return false;
    }
}
async function creditTaskRewardOnce(taskKey, reward, title, claimedKey, claimValue){
    if(!await requireNotMigrant('заработок через задания недоступен')) return false;
    const dailyId = claimedKey ? String(claimValue || '') : '';
    const kind = dailyId ? 'daily' : 'once';
    const id = dailyId || String(taskKey || '');
    try {
        const result = await claimVerifiedTask(kind,id);
        if(!result?.claimed)return false;
        const fresh = (await get(userRef(currentNick))).val() || {};
        allUsersCache[currentNick] = fresh;
        window.allUsersCache = allUsersCache;
        const taskBalanceEl = qs('taskBalanceDisplay');
        if(taskBalanceEl) taskBalanceEl.textContent = `${Number(fresh.taskBalance||0).toLocaleString('ru-RU')} ₽`;
        toast(`🎁 +${Number(result.reward||0)} ₽ на счёт заданий!`,'green');
        return true;
    } catch(e) {
        console.warn('[tasks] server reward:',e);
        toast('Награда не выдана: '+e.message,'red');
        return false;
    }
}
window.claimDailyTask = async function(taskId, reward, options={}){
    if(!currentNick) return;
    const today = todayKey();
    const claimedKey = `dailyClaimed_${today}`;
    const tasks = [...(getDailyTasksForToday()||[])];
    try{
        const snap = await get(userRef(currentNick));
        const u = snap.val() || {};
        const primeActive = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
        if(primeActive) tasks.push(...(getPrimeDailyTasksForToday()||[]));
    }catch(e){}
    const task = tasks.find(t => t.id === taskId);
    if(!task) return options.autoPrime ? false : toast('❌ Задание не найдено','red');
    if(options.autoPrime && !task.id.startsWith('prime_')) return false;
    const claimed = (await get(userRef(currentNick))).val()?.[claimedKey] || [];
    if(claimed.includes(taskId)) return false;
    const ok = await creditTaskRewardOnce(`__dailyReward_${today}_${taskId}` , Number(task.reward), 'Ежедневное задание выполнено', claimedKey, taskId);
    if(ok) renderTasks();
};
window.claimOneTimeTask = async function(taskKey, reward){
    if(!currentNick) return;
    const rewards = {
        rewardedAvatar: REWARD_CUSTOM_AVATAR,
        rewardedWall: REWARD_FIRST_WALL,
        rewardedListing: 60,
        rewardedTaxi: 80,
        rewardedJob: 100,
        rewardedMarket: 90,
        rewardedPassport: 80,
        rewardedAllLicenses: 90
    };
    if(!Object.prototype.hasOwnProperty.call(rewards, taskKey)) return toast('❌ Недействительное задание','red');
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    if(u[taskKey]) return toast('✅ Уже получено','gold');
    const ok = await creditTaskRewardOnce(taskKey, rewards[taskKey], 'Одноразовое задание выполнено');
    if(ok) renderTasks();
};
window.withdrawTaskBalance = async function(){
    if(!currentNick) return;
    const input = qs('taskWithdrawAmt');
    const amount = Math.floor(Number(input?.value || 0));
    if(!Number.isSafeInteger(amount) || amount < 500) return toast('❌ Минимальная сумма вывода — 500 ₽','red');
    if(window._taskWithdrawBusy) return toast('⏳ Операция уже выполняется…','gold');
    window._taskWithdrawBusy = true;
    try{
        const result = await withdrawVerifiedTasks(amount);
        if(!result?.ok){ toast('❌ Недостаточно средств на счёте заданий','red'); return; }
        if(input) input.value='';
        toast(`✅ ${amount} ₽ переведено на основной баланс`,'green');
        renderTasks();
    }catch(e){
        console.warn('[tasks] withdrawal failed:',e);
        toast('Не удалось вывести деньги: '+e.message,'red');
    }finally{ window._taskWithdrawBusy=false; }
};

window.renderTasks = async function(){
    const el = qs('tasksList'); if(!el || !currentNick) return;
    const renderStartedAt = performance.now();
    try{
        const today = todayKey();
        const claimedKey = `dailyClaimed_${today}`;

        // The core user listener keeps this object fresh, but fall back to a single
        // user read when the cache is not ready yet.
        let u = allUsersCache?.[currentNick] || null;
        if(!u){
            const uSnap = await get(userRef(currentNick));
            u = uSnap.val() || {};
        }
        const claimed = Array.isArray(u[claimedKey]) ? u[claimedKey] : [];
        const dailyTasks = getDailyTasksForToday() || [];
        const primeActive = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
        const primeDailyTasks = primeActive ? (getPrimeDailyTasksForToday() || []) : [];

        // One-time task state can be determined from the user's profile for most
        // tasks. Only marketplace/taxi data is needed to infer legacy completed
        // tasks that were done before their reward flag was persisted.
        const oneTimeNeedsMarket = !u.rewardedListing;
        const oneTimeNeedsOrders = !u.rewardedTaxi;
        const needsChat = dailyTasks.some(t=>t.id==='chat') || primeDailyTasks.some(t=>t.id==='prime_chat5');
        const needsWall = dailyTasks.some(t=>t.id==='wall');
        const needsTransfer = dailyTasks.some(t=>t.id==='transfer') || primeDailyTasks.some(t=>t.id==='prime_transfer_big');
        const needsShop = dailyTasks.some(t=>t.id==='shop') || primeDailyTasks.some(t=>t.id==='prime_shop_big');
        const needsTaxi = dailyTasks.some(t=>t.id==='taxi_req') || primeDailyTasks.some(t=>t.id==='prime_taxi2') || oneTimeNeedsOrders;
        const needsMarket = dailyTasks.some(t=>t.id==='market_browse') || primeDailyTasks.some(t=>t.id==='prime_listing') || oneTimeNeedsMarket;
        const needsDm = dailyTasks.some(t=>t.id==='dm') || primeDailyTasks.some(t=>t.id==='prime_dm3');
        const needsDeliveryCustom = needsShop;

        const reads = [];
        if(needsTaxi || needsShop) reads.push(get(query(ordersRef(), orderByChild('client'), equalTo(currentNick))).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsMarket) reads.push(get(query(marketRef(), orderByChild('seller'), equalTo(currentNick))).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsChat) reads.push(get(query(chatRef(), orderByChild('nick'), equalTo(currentNick))).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsWall) reads.push(get(wallRef(currentNick)).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsTransfer) reads.push(get(txLogRef(currentNick)).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsDm) reads.push(get(ref(db,'dms')).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(needsDeliveryCustom) reads.push(get(query(deliveryCustomOrdersRef(), orderByChild('client'), equalTo(currentNick))).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(!u.rewardedPassport) reads.push(get(ref(db,`passports/${currentNick}`)).catch(()=>null));
        else reads.push(Promise.resolve(null));
        if(!u.rewardedAllLicenses) reads.push(get(ref(db,`licenses/${currentNick}`)).catch(()=>null));
        else reads.push(Promise.resolve(null));

        const [ordersSnap,marketSnap,chatSnap,wallSnap,txSnap,dmAllSnap,deliveryCustomSnap,passportSnap,licenseSnap] = await Promise.all(reads);
        const ordersVal = ordersSnap?.val ? (ordersSnap.val() || {}) : {};
        const marketVal = marketSnap?.val ? (marketSnap.val() || {}) : {};
        const chatVal = chatSnap?.val ? (chatSnap.val() || {}) : {};
        const wallVal = wallSnap?.val ? (wallSnap.val() || {}) : {};
        const txVal = txSnap?.val ? (txSnap.val() || {}) : {};
        const deliveryCustomVal = deliveryCustomSnap?.val ? (deliveryCustomSnap.val() || {}) : {};
        window._taskDeliveryCustomOrders = deliveryCustomVal;

        let dmTodayMsgs = [];
        if(needsDm){
            const allDms = dmAllSnap?.val ? (dmAllSnap.val() || {}) : {};
            Object.entries(allDms).forEach(([key,conv])=>{
                if(!key.includes(currentNick)) return;
                Object.values(conv.messages||{}).forEach(m=>{
                    if(m.nick===currentNick && localDateKey(m.createdAt||0)===today) dmTodayMsgs.push(m);
                });
            });
        }

        // One-time tasks. Legacy completion checks use the filtered datasets above.
        const hasListing = Object.values(marketVal).some(l=>l.seller===currentNick);
        const hasTaxi = Object.values(ordersVal).some(o=>o.client===currentNick&&o.type==='taxi');
        const passportData = passportSnap?.exists && passportSnap.exists() ? passportSnap.val() : (u.passport || null);
        const hasPassport = !!(passportData && (passportData.firstName || passportData.lastName));
        const licensesData = licenseSnap?.exists && licenseSnap.exists() ? licenseSnap.val() : (u.licenses || {});
        const hasAllLicenses = !!(licensesData && licensesData.bike && licensesData.scooter);
        const oneTimeTasks = [
            { key:'rewardedAvatar',   title:'🖼 Своя аватарка',          desc:'Поставьте не стандартную аватарку профиля.',   reward:REWARD_CUSTOM_AVATAR, done:!!u.rewardedAvatar },
            { key:'rewardedWall',     title:'📰 Первый пост в ленте',     desc:'Опубликуйте первый пост в своей ленте.',       reward:REWARD_FIRST_WALL,    done:!!u.rewardedWall },
            { key:'rewardedListing',  title:'🛍 Первое объявление',       desc:'Разместите первый товар или вакансию.',        reward:60,                   done:!!u.rewardedListing||hasListing },
            { key:'rewardedTaxi',     title:'🛵 Первый заказ такси',       desc:'Сделайте первый заказ такси.',                reward:80,                   done:!!u.rewardedTaxi||hasTaxi },
            { key:'rewardedJob',      title:'💼 Устроиться на работу',     desc:'Подайте заявку и получите должность.',        reward:100,                  done:!!u.rewardedJob||(u.job&&u.job!=='Житель') },
            { key:'rewardedMarket',   title:'🛒 Купить на маркетплейсе',   desc:'Купите что-нибудь на маркетплейсе.',          reward:90,                   done:!!u.rewardedMarket },
            { key:'rewardedPassport', title:'📝 Создать паспорт',         desc:'Заполните данные паспорта в профиле.',         reward:80,                   done:!!u.rewardedPassport||hasPassport },
            { key:'rewardedAllLicenses', title:'🪪 Сдать на все категории прав', desc:'Получите права на велосипед и скутер у мэра.', reward:90,             done:!!u.rewardedAllLicenses||hasAllLicenses },
        ];

        const dailyRows = await Promise.all(dailyTasks.map(async task=>{
            const conditionMet = await checkDailyTaskCondition(task.id, u, ordersVal, marketVal, chatVal, wallVal, dmTodayMsgs, txVal);
            return { ...task, conditionMet, alreadyClaimed: claimed.includes(task.id) };
        }));
        const primeDailyRows = await Promise.all(primeDailyTasks.map(async task=>{
            const conditionMet = await checkPrimeDailyTaskCondition(task.id, u, ordersVal, marketVal, chatVal, wallVal, dmTodayMsgs, txVal);
            return { ...task, conditionMet, alreadyClaimed: claimed.includes(task.id) };
        }));

        function oneTimeRow(t){
            return `<div class="task-item">
                <div class="task-main">
                    <div class="task-name">${escHtml(t.title)}</div>
                    <div class="task-desc">${escHtml(t.desc)}</div>
                    <div class="task-reward">+${t.reward} ₽</div>
                </div>
                ${t.done ? `<div class="task-state done">✅ Выполнено</div>` : `<div class="task-state todo">В процессе</div>`}
            </div>`;
        }
        function dailyRow(t){
            let stateHtml;
            if(t.alreadyClaimed) stateHtml = `<div class="task-state done">✅ Получено</div>`;
            else if(t.conditionMet) stateHtml = `<button class="btn btn-primary btn-sm" style="font-size:11px;padding:7px 12px;" onclick="claimDailyTask('${t.id}',${t.reward})">Забрать +${t.reward}₽</button>`;
            else stateHtml = `<div class="task-state todo">В процессе</div>`;
            return `<div class="task-item"><div class="task-main"><div class="task-name">${escHtml(t.title)}</div><div class="task-desc">${escHtml(t.desc)}</div><div class="task-reward">+${t.reward} ₽</div></div>${stateHtml}</div>`;
        }
        function primeDailyRow(t){
            let stateHtml;
            if(t.alreadyClaimed) stateHtml = `<div class="task-state done">✅ Выполнено — +${t.reward} ₽</div>`;
            else if(t.conditionMet) stateHtml = `<div class="task-state done">⏳ Автоматическое начисление…</div>`;
            else stateHtml = `<div class="task-state todo">В процессе</div>`;
            return `<div class="task-item" style="border-color:rgba(240,196,25,.35);background:linear-gradient(120deg,rgba(240,196,25,.08),rgba(255,110,196,.06),rgba(120,115,245,.06));"><div class="task-main"><div class="task-name">${escHtml(t.title)}</div><div class="task-desc">${escHtml(t.desc)}</div><div class="task-reward" style="color:#f0c419;">+${t.reward} ₽</div></div>${stateHtml}</div>`;
        }

        // Render first; legacy one-time rewards are reconciled afterwards so they
        // never block the task screen on serial transactions/logging.
        const taskBalanceEl = qs('taskBalanceDisplay');
        if(taskBalanceEl) taskBalanceEl.textContent = `${Math.max(0, Number(u.taskBalance||0)).toLocaleString('ru-RU')} ₽`;
        el.innerHTML = `${primeDailyRows.length ? `<div class="task-group" style="margin-top:0;"><div class="task-group-title" style="color:var(--gold);">👑 Kapani Prime — эксклюзивные задания</div>${primeDailyRows.map(primeDailyRow).join('')}</div>` : ''}<div class="task-group"><div class="task-group-title">📅 Ежедневные (обновляются каждый день)</div>${dailyRows.map(dailyRow).join('')}</div><div class="task-group" style="margin-top:0;"><div class="task-group-title">⭐ Одноразовые</div>${oneTimeTasks.map(oneTimeRow).join('')}</div>`;

        // Prime Daily Tasks are automatically claimed once their condition is met.
        // The existing creditTaskRewardOnce transaction remains the idempotency guard.
        if (primeDailyRows.length) {
            const autoPrime = primeDailyRows.filter(t => t.conditionMet && !t.alreadyClaimed);
            if (autoPrime.length) {
                Promise.all(autoPrime.map(t => claimDailyTask(t.id, t.reward, {autoPrime:true, silent:true}))).catch(e => console.warn('[prime daily auto]', e));
            }
        }

        if(!isMigrantUser(u)){
            const pendingRewards = oneTimeTasks.filter(t=>t.done && !u[t.key]);
            if(pendingRewards.length){
                // Reconcile old/completed one-time tasks in the background.
                Promise.all(pendingRewards.map(async t=>{
                    try{
                        const ok = await creditTaskRewardOnce(t.key, t.reward, `Одноразовое задание: ${t.title}`);
                        return ok;
                    }catch(e){ console.warn('[task auto reward]',e); return false; }
                })).then(results=>{
                    if(results.some(Boolean)){
                        const cached = allUsersCache?.[currentNick];
                        const elBal = qs('taskBalanceDisplay');
                        if(elBal && cached) elBal.textContent = `${Math.max(0, Number(cached.taskBalance||0)).toLocaleString('ru-RU')} ₽`;
                    }
                }).catch(e=>console.warn('[task auto reward batch]',e));
            }
        }

        // No extra get(user) here: the core user listener updates taskBalance immediately.
        if(typeof console !== 'undefined' && console.debug) console.debug(`[Kapani tasks] rendered in ${Math.round(performance.now()-renderStartedAt)}ms`);
    }catch(e){
        console.error(e);
        el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Не удалось загрузить задания</div>';
    }
};

// ─── MARKETPLACE ──────────────────────────
function getWeekKey(date){
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const weekNum = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}
function daysUntilNextWeek(date){
    const day = date.getDay();
    return ((1 - day + 7) % 7) || 7;
}
window.updateMarketLimitInfo = async function(){
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const isSubActive = u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const subscription = isSubActive ? (u.subscription || 'none') : 'none';
    const listingsThisWeek = u.listingsThisWeek || 0;
    const lastListingWeek = u.lastListingWeek || '';
    
    // Определяем текущую неделю и дату сброса
    const now = new Date();
    const currentWeek = getWeekKey(now);
    const daysUntilReset = daysUntilNextWeek(now);
    const resetDate = new Date(now); resetDate.setDate(resetDate.getDate() + daysUntilReset);
    
    // Сбрасываем счетчик если новая неделя
    let actualListingsThisWeek = (lastListingWeek === currentWeek) ? listingsThisWeek : 0;
    
    // Определяем лимит
    let listingLimit = 2; // default
    let limitColor = 'var(--red)';
    if(subscription === 'plus') { listingLimit = 4; limitColor = 'var(--gold)'; }
    if(subscription === 'ultra') { listingLimit = 8; limitColor = 'var(--primary)'; }
    if(subscription === 'prime') { listingLimit = 999999; limitColor = 'var(--prime-color, #f0c419)'; }
    
    // Обновляем UI
    const limitText = qs('listingLimitText');
    const resetInfo = qs('listingResetInfo');
    
    if(limitText){
        const remaining = listingLimit - actualListingsThisWeek;
        if(subscription === 'prime'){
            limitText.textContent = '♾️ Безлимитно';
            limitText.style.color = 'var(--prime-color, #f0c419)';
        } else {
            limitText.textContent = `${actualListingsThisWeek} / ${listingLimit}`;
            limitText.style.color = remaining > 0 ? limitColor : 'var(--red)';
        }
    }
    
    if(resetInfo){
        if(subscription === 'prime'){
            resetInfo.textContent = '🎯 Kapani Prime — безлимитные объявления';
        } else {
            resetInfo.textContent = `📅 Сброс через ${daysUntilReset} ${daysUntilReset === 1 ? 'день' : daysUntilReset < 5 ? 'дня' : 'дней'} (${resetDate.toLocaleDateString('ru', {day:'numeric',month:'long'})})`;
        }
    }
};

window.switchMarketTab=function(i){[0,1,2].forEach(j=>{qs(`mktTab${j}`).classList.toggle('active',j===i);qs(`mktPanel${j}`).classList.toggle('active',j===i);});if(i===0||i===1)get(marketRef()).then(snap=>renderMarket(snap.val()||{}));if(i===2){updateMarketLimitInfo();toggleMktPriceFields();}};
window.applyMarketFilter=function(){get(marketRef()).then(snap=>renderMarket(snap.val()||{}));};
window.toggleMktPriceFields=function(){
    const neg=qs('mktNegotiable')?.checked;
    const pr=qs('mktPrice');
    const cat=qs('mktCategory')?.value;
    const sal=qs('mktSalaryHint');
    if(pr){ 
        pr.disabled=!!neg || cat==='work' || cat==='service'; 
        pr.style.display=(cat==='work' || cat==='service')?'none':'block'; 
    }
    if(sal){ 
        sal.style.display=(cat==='work'||cat==='service')?'block':'none'; 
        if(cat==='work') sal.placeholder='Оплата (например 350₽/смена)';
        if(cat==='service') sal.placeholder='Стоимость услуги (например 500₽/час или «по договорённости»)';
    }
};
function renderMarket(listings){
    lastMarketListings=listings||{};
    const all=Object.entries(lastMarketListings).map(([id,l])=>({...l,id}));
    const cat=qs('mktBrowseCat')?.value||'all';
    const allEl=qs('marketListings');
    get(userRef(currentNick)).then(s=>{ const u=s.val()||{}; renderDebtNotice('marketDebtNotice', u); }).catch(()=>{});
    if(allEl){
        let active=all.filter(l=>(l.status!=='sold' || l.category==='service') && !l.archived);
        if(cat&&cat!=='all') active=active.filter(l=>(l.category||'other')===cat);
        active.sort((a,b)=>Number(isListingPinned(b)) - Number(isListingPinned(a)) || (b.createdAt||0) - (a.createdAt||0));
        allEl.innerHTML=active.length===0?'<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Нет объявлений</div>':active.map(l=>marketCard(l,false)).join('');
    }
    const myEl=qs('myMarketListings');
    if(myEl){
        const mine=all.filter(l=>l.seller===currentNick);
        const activeMine=mine.filter(l=>!l.archived);
        const archivedMine=mine.filter(l=>l.archived);
        let html='';
        if(activeMine.length===0 && archivedMine.length===0){
            html='<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Нет объявлений</div>';
        } else {
            if(activeMine.length>0){
                html+=`<div style="font-size:12px;font-weight:800;color:var(--muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">📋 Активные (${activeMine.length})</div>`;
                html+=activeMine.map(l=>marketCard(l,true,false)).join('');
            }
            if(archivedMine.length>0){
                html+=`<div style="font-size:12px;font-weight:800;color:var(--muted);margin:20px 0 12px;text-transform:uppercase;letter-spacing:0.5px;">🕓 Скрытые (${archivedMine.length})</div>`;
                html+=archivedMine.map(l=>marketCard(l,true,true)).join('');
            }
        }
        myEl.innerHTML=html;
    }
    if (curPage === 'deliveryOrderPage' && typeof renderDeliveryOrderOptions === 'function') renderDeliveryOrderOptions();
}
const categoryEmoji={other:'📦',food:'🍎',tools:'🔧',clothes:'👕',electronics:'📱',building:'🧱',work:'💼',service:'🤝'};
function isListingPinned(l){
    return Number(l?.pinnedUntil || 0) > Date.now();
}
function priceLine(l){
    if(l.category==='work') return l.salaryHint ? `Оплата: ${escHtml(l.salaryHint)}` : 'Оплата по договорённости';
    if(l.category==='service') return l.salaryHint ? `Стоимость: ${escHtml(l.salaryHint)}` : (l.priceNegotiable ? 'Договорная' : `${(l.price||0).toLocaleString()} ₽`);
    if(l.priceNegotiable)return 'Договорная';
    return `${(l.price||0).toLocaleString()} ₽`;
}
function marketCard(l,isMine, isArchived=false){
    const isWork=l.category==='work';
    const isService=l.category==='service';
    const isBuyer=l.buyer===currentNick;const canBuy=!isMine&&l.seller!==currentNick&&!isArchived;
    const pendingSellerConfirm=isMine&&l.status==='meeting_requested';const pendingBuyerConfirm=isBuyer&&l.status==='meeting_confirmed';
    const pendingBuyerReq=isBuyer&&l.status==='meeting_requested';const chatPartner=isMine?l.buyer:(isBuyer?l.seller:null);
    const showChat=chatPartner&&(l.status==='meeting_requested'||l.status==='meeting_confirmed')&&!isArchived;
    const sellerOnline=isUserOnline(allUsersCache[l.seller]);
    const su=allUsersCache[l.seller]||{};
    
    // Check if seller has active subscription and avatar frame
    const expiry = su.subscriptionExpiry ? new Date(su.subscriptionExpiry) : null;
    const isActive = expiry && expiry > new Date();
    const frameClass = getAvatarFrameClass(su);
    const frameHtml = frameClass
        ? `<div class="avatar-frame ${frameClass}" style="position:absolute;inset:-3px;border-radius:inherit;pointer-events:none;z-index:1;"></div>`
        : '';

    const workBadge=isWork&&l.workAcceptedBy?`<span class="market-status-pending" style="margin-left:8px;">✅ Подтверждено</span>`:'';
    const serviceBadge=isService?`<span class="market-status-service" style="margin-left:8px;">🤝 Услуга</span>`:'';
    const archivedBadge=isArchived?`<span class="market-status-sold" style="margin-left:8px;">🕓 Скрыто</span>`:'';
    const pinnedBadge=isListingPinned(l)?(l.pinnedLabel==='ХИТ ПРОДАЖ!'?'<span class="market-status-pin" style="background:var(--gold-dim);color:var(--gold);">🔥 ХИТ ПРОДАЖ!</span>':'<span class="market-status-pin">⭐ Лидер продаж!</span>'):'';
    const statusBadge=l.status==='sold'&&!isService?'<span class="market-status-sold">Продано</span>':(l.status!=='active'&&!isWork&&!isService?'<span class="market-status-pending">Ожидание</span>':'');
    return `<div class="market-card" style="${isArchived?'opacity:0.7;':''}">${l.photo?`<img loading="lazy" decoding="async" class="market-img" src="${escHtml(l.photo)}" onerror="this.style.display='none'" onclick="openImgViewer('${jsEsc(l.photo)}')">`:''}
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;gap:6px;flex-wrap:wrap;"><div class="market-title">${categoryEmoji[l.category]||'📦'} ${escHtml(l.title)}</div><div style="display:flex;gap:6px;flex-wrap:wrap;">${pinnedBadge}${statusBadge}${workBadge}${serviceBadge}${archivedBadge}</div></div>
        <div class="market-price">${priceLine(l)}</div>${l.desc?`<div class="market-desc">${escHtml(l.desc)}</div>`:''}
        <div class="market-seller" style="cursor:pointer;" onclick="openUserProfile('${escHtml(l.seller)}')">
            <div class="seller-info" style="display:flex;align-items:center;gap:6px;">
                <div class="seller-state ${sellerOnline?'online':'offline'}" style="position:relative;">${frameHtml}</div>
                <span class="seller-nick">${escHtml(displayNick(su)||l.seller)}</span>
            </div>
            <div class="seller-online-text ${sellerOnline?'online':'offline'}" style="margin-top:2px;font-size:11px;">${sellerOnline?'в сети':'не в сети'}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${canBuy?`<button class="btn btn-gold btn-sm" onclick="requestMeeting('${l.id}')">🤝 ${isService?'Заказать':'Договориться'}</button>`:''}
            ${pendingBuyerReq&&!isArchived?`<div style="color:var(--gold);font-size:13px;font-weight:800;padding:6px 0;width:100%;">⏳ Ожидаем продавца</div><button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="cancelMeeting('${l.id}')">✕ Отказаться</button>`:''}
            ${pendingSellerConfirm&&!isArchived?`<div style="color:var(--gold);font-size:13px;font-weight:800;padding:6px 0;width:100%;display:flex;align-items:center;gap:6px;">🤝 Хочет ${isService?'заказать':'купить'}: <span style="color:var(--text);background:var(--gold-dim);border:1px solid rgba(255,128,106,.3);border-radius:8px;padding:2px 10px;">${escHtml(l.buyer||'')}</span></div><button class="btn btn-primary btn-sm" onclick="confirmMeeting('${l.id}')">✅ Подтвердить</button><button class="btn btn-red btn-sm" onclick="declineListing('${l.id}')">❌ Отказать</button>`:''}
            ${pendingBuyerConfirm&&!isArchived?`<button class="btn btn-primary btn-sm" onclick="confirmPurchase('${l.id}')">✅ ${isService?'Подтвердить заказ':'Оплатить и подтвердить'}</button><button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="cancelMeeting('${l.id}')">✕ Отказаться</button>`:''}
            ${showChat?`<button class="btn btn-ghost btn-sm" onclick="goToChat('${escHtml(chatPartner)}')">💬 Написать</button>`:''}
            ${isMine&&!isArchived?`<button class="btn btn-ghost btn-sm" onclick="pinListing('${l.id}')">${(()=>{const me=allUsersCache[currentNick]||{};const mePrime=me.subscription==='prime'&&me.subscriptionExpiry&&new Date(me.subscriptionExpiry)>new Date();return mePrime?`🔥 ${isListingPinned(l)?'Закреплено':'ХИТ ПРОДАЖ!'} (бесплатно)`:`📌 ${isListingPinned(l)?'Закреплено':'Лидер продаж!'} (${ECONOMY_MARKET_PIN_PRICE}₽)`;})()}</button><button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="archiveListing('${l.id}')">🕓 Скрыть</button><button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="deleteListing('${l.id}')">🗑 Удалить</button>`:''}
            ${isMine&&isArchived?`<button class="btn btn-primary btn-sm" onclick="restoreListing('${l.id}')">↩ Вернуть</button><button class="btn btn-red btn-sm" onclick="deleteListing('${l.id}')">🗑 Удалить</button>`:''}
        </div></div>`;
}
window.publishListing=async function(){
    if(!await requireMarketTaxiAccess()) return;
    const title=qs('mktTitle').value.trim();
    const negotiable=qs('mktNegotiable')?.checked;
    const cat=qs('mktCategory').value;
    const price=cat==='work' ? 0 : (negotiable?0:(parseInt(qs('mktPrice').value)||0));
    const salaryHint=(qs('mktSalaryHint')?.value||'').trim();
    if(!title)return toast('⚠️ Название','gold');
    if(cat!=='work' && !negotiable && price<=0)return toast('⚠️ Укажите цену или отметьте «договорная»','gold');
    if(cat==='work' && !salaryHint)return toast('⚠️ Для вакансии укажите оплату','gold');
    
    // Проверяем лимит объявлений в месяц
    const snap=await get(userRef(currentNick));
    const u=snap.val()||{};
    if(isMigrantUser(u)) return toast(`🚫 ${ROLE_MIGRANT}: маркетплейс недоступен`,'red');
    const isSubActive = u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const subscription = isSubActive ? (u.subscription || 'none') : 'none';
    const listingsThisWeek = u.listingsThisWeek || 0;
    const currentWeek=getWeekKey(new Date());
    const lastListingWeek=u.lastListingWeek||'';
    
    // Сбрасываем счетчик если новая неделя
    let actualListingsThisWeek = (lastListingWeek===currentWeek) ? listingsThisWeek : 0;
    
    // Определяем лимит
    let listingLimit=2; // default for free users
    if(subscription==='plus') listingLimit=4;
    if(subscription==='ultra') listingLimit=8;
    if(subscription==='prime') listingLimit=999999; // unlimited
    
    if(actualListingsThisWeek>=listingLimit){
        if(subscription==='none'){
            return toast(`⚠️ Лимит ${listingLimit} объявления в неделю достигнут. Оформите подписку Kapani Plus, Ultra или Prime!`,'gold');
        } else if(subscription==='plus'){
            return toast(`⚠️ Лимит ${listingLimit} объявлений в неделю достигнут. Обновитесь до Kapani Ultra или Prime для большего лимита!`,'gold');
        } else if(subscription==='ultra'){
            return toast(`⚠️ Лимит ${listingLimit} объявлений в неделю достигнут. Обновитесь до Kapani Prime для неограниченных объявлений!`,'gold');
        } else {
            return toast(`⚠️ Достигнут лимит объявлений`,'gold');
        }
    }
    
    const photo=window._mktPhotoData||qs('mktPhoto').value.trim();
    const id=genId();
    await set(listingRef(id),{id,seller:currentNick,title,desc:qs('mktDesc').value.trim(),price,priceNegotiable:cat!=='work' && !!negotiable,salaryHint,photo,category:cat,status:'active',buyer:null});
    
    // Обновляем счетчик объявлений
    await update(userRef(currentNick),{
        listingsThisWeek: actualListingsThisWeek+1,
        lastListingWeek: currentWeek
    });
    
    if(!u.rewardedListing){
        await update(userRef(currentNick),{rewardedListing:true,taskBalance:Math.max(0,Number(u.taskBalance||0))+60});
        await logTx(currentNick,{type:'in',who:'Задания',amt:60,desc:'Одноразовое задание: первое объявление'});
        toast('🎁 +60 ₽ на счёт заданий за первое объявление','gold');
    }
    qs('mktTitle').value='';qs('mktDesc').value='';qs('mktPrice').value='';if(qs('mktNegotiable'))qs('mktNegotiable').checked=false;if(qs('mktSalaryHint'))qs('mktSalaryHint').value='';
    qs('mktPhoto').value='';qs('mktPhotoPreview').style.display='none';window._mktPhotoData=null;toggleMktPriceFields();toast('✅ Опубликовано!','green');switchMarketTab(0);
};
window.requestMeeting=async function(id){
    if(!await requireMarketTaxiAccess()) return;
    const snap=await get(listingRef(id));if(!snap.exists())return toast('❌ Листинг не найден','red');
    const meSnap = await get(userRef(currentNick)); const me = meSnap.val()||{};
    if(isMigrantUser(me)) return toast(`🚫 ${ROLE_MIGRANT}: маркетплейс недоступен`,'red');
    const l=snap.val();
    await update(listingRef(id),{status:'meeting_requested',buyer:currentNick});
    const pl=l.priceNegotiable?'договорная':`${l.price}₽`;
    await pushNotification(l.seller,`🤝 Купить хочет: ${currentNick} · "${l.title}" · ${pl}`,'market');
    toast('✉️ Запрос отправлен!','green');
};
window.confirmMeeting=async function(id){const snap=await get(listingRef(id));if(!snap.exists())return;const l=snap.val();await update(listingRef(id),{status:'meeting_confirmed'});await pushNotification(l.buyer,`✅ ${l.seller} подтвердил встречу!`,'market');toast('✅ Встреча подтверждена','green');};
window.cancelMeeting=async function(id){const snap=await get(listingRef(id));if(!snap.exists())return;const l=snap.val();const otherNick=l.buyer===currentNick?l.seller:l.buyer;await update(listingRef(id),{status:'active',buyer:null});if(otherNick)await pushNotification(otherNick,`⚠️ ${currentNick} отказался от сделки`,'market');toast('❌ Отказ от встречи','red');};
window.goToChat=function(nick){navTo('messages');setTimeout(()=>{switchMsgTab(1);setTimeout(()=>openDmChat(nick),200);},200);};
window.declineListing=async function(id){const snap=await get(listingRef(id));if(!snap.exists())return;const l=snap.val();await update(listingRef(id),{status:'active',buyer:null});await pushNotification(l.buyer,`❌ ${l.seller} отказал`,'market');toast('❌ Отклонено','red');};
window.confirmPurchase=async function(id){
    if(!await requireMarketTaxiAccess()) return;
    const snap=await get(listingRef(id));if(!snap.exists())return;
    const l=snap.val();
    if(l.category==='work'){
        await update(listingRef(id),{status:'active',buyer:null,workAcceptedBy:currentNick,workAcceptedAt:Date.now()});
        await pushNotification(l.seller,`🧑‍💼 ${currentNick} подтвердил вакансию «${l.title}»`,'market');
        toast('✅ Вакансия подтверждена','green');
        return;
    }
    const isService=l.category==='service';
    const pay=l.priceNegotiable?parseInt(prompt('Сколько ₽ перевести продавцу?','0')||'0',10)||0:(l.price||0);
    if(pay<0)return toast('⚠️ Сумма','gold');
    const[bSnap,sSnap]=await Promise.all([get(userRef(l.buyer)),get(userRef(l.seller))]);
    if(!bSnap.exists()||!sSnap.exists())return;
    const fee = calcCommission(pay, ECONOMY_MARKET_COMMISSION);
    const total = pay + fee;
    if(total>0 && (bSnap.val().balance||0) < total)return toast(`❌ Недостаточно средств. Нужно ${total}₽ (комиссия ${fee}₽)`,'red');
    if(total>0){
        await update(userRef(l.buyer),{balance:(bSnap.val().balance||0)-total});
        await update(userRef(l.seller),{balance:(sSnap.val().balance||0)+pay});
        await logTx(l.buyer,{type:'out',who:l.seller,amt:pay,desc:`Куплено${isService?' услуга':' объявление'} «${l.title}»`});
        if(fee>0) await logTx(l.buyer,{type:'out',who:'Комиссия',amt:fee,desc:`Комиссия 2% за покупку «${l.title}»`});
        await logTx(l.seller,{type:'in',who:l.buyer,amt:pay,desc:`Продано${isService?' услуга':' объявление'} «${l.title}»`});
        if(!bSnap.val().rewardedMarket){
            await update(userRef(l.buyer),{rewardedMarket:true,taskBalance:Math.max(0,Number(bSnap.val().taskBalance||0))+90});
            await logTx(l.buyer,{type:'in',who:'Задания',amt:90,desc:'Одноразовое задание: покупка на маркетплейсе'});
            await pushNotification(l.buyer,'🎁 +90 ₽ на счёт заданий за покупку на маркетплейсе','money');
        }
    }
    // Service listings stay active forever — just reset buyer
    if(isService){
        await update(listingRef(id),{status:'active',buyer:null});
        await pushNotification(l.seller,`💰 ${l.buyer} заказал услугу "${l.title}"${pay?` — ${pay}₽`:''}${fee?` (+${fee}₽ комиссия)`:''}`,'market');
        await pushNotification(l.buyer,`✅ Услуга "${l.title}" подтверждена! Комиссия: ${fee}₽`,'market');
        toast('🎉 Услуга заказана!','green');
    } else {
        await update(listingRef(id),{status:'sold'});
        await pushNotification(l.seller,`💰 ${l.buyer} купил "${l.title}"${pay?` — ${pay}₽`:''}${fee?` (+${fee}₽ комиссия)`:''}`,'market');
        await pushNotification(l.buyer,`✅ Покупка "${l.title}" подтверждена! Комиссия: ${fee}₽`,'market');
        toast('🎉 Покупка!','green');
    }
};
window.pinListing=async function(id){
    if(!await requireMarketTaxiAccess()) return;
    const snap=await get(listingRef(id));
    if(!snap.exists()) return toast('❌ Объявление не найдено','red');
    const l=snap.val();
    if(l.seller!==currentNick) return toast('❌ Нет прав','red');
    if(l.archived) return toast('❌ Сначала восстановите объявление','red');
    if((l.pinnedUntil || 0) > Date.now()) return toast('⭐ Уже закреплено','gold');
    const uSnap = await get(userRef(currentNick));
    const u = uSnap.val() || {};
    const hasPrimePin = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const pinPrice = hasPrimePin ? 0 : ECONOMY_MARKET_PIN_PRICE;
    const pinLabel = hasPrimePin ? 'ХИТ ПРОДАЖ!' : 'Лидер продаж!';
    if((u.balance || 0) < pinPrice) return toast(`❌ Нужно ${pinPrice}₽ для закрепления`,'red');
    if(pinPrice > 0) await update(userRef(currentNick), { balance: (u.balance || 0) - pinPrice });
    await update(listingRef(id), { pinnedUntil: Date.now() + ECONOMY_MARKET_PIN_DURATION_MS, pinnedBy: currentNick, pinnedLabel: pinLabel });
    if(pinPrice > 0) await logTx(currentNick, { type:'out', who:'Маркетплейс', amt:pinPrice, desc:`Закрепление объявления «${l.title}»` });
    await pushNotification(currentNick, `📌 Объявление «${l.title}» закреплено как «${pinLabel}»`, 'market');
    toast('📌 Объявление закреплено!', 'green');
    get(marketRef()).then(s=>renderMarket(s.val()||{}));
};
window.promoteBusiness=async function(bizId){
    const uSnap = await get(userRef(currentNick));
    const u = uSnap.val() || {};
    const hasPrimeBiz = u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    if(!hasPrimeBiz) return toast('❌ Продвижение бизнеса в ТОП доступно только для Kapani Prime','red');
    const bSnap = await get(bizItemRef(bizId)); if(!bSnap.exists()) return toast('❌ Бизнес не найден','red');
    const b = bSnap.val();
    if(b.owner !== currentNick) return toast('❌ Нет прав','red');
    if(Number(b.promotedUntil||0) > Date.now()) return toast('🔥 Бизнес уже в ТОПе','gold');
    if((u.balance || 0) < ECONOMY_BUSINESS_PROMOTE_PRICE) return toast(`❌ Нужно ${ECONOMY_BUSINESS_PROMOTE_PRICE}₽ для продвижения`,'red');
    await update(userRef(currentNick), { balance: (u.balance || 0) - ECONOMY_BUSINESS_PROMOTE_PRICE });
    await update(bizItemRef(bizId), { promotedUntil: Date.now() + ECONOMY_BUSINESS_PROMOTE_DURATION_MS });
    await logTx(currentNick, { type:'out', who:'Бизнес', amt:ECONOMY_BUSINESS_PROMOTE_PRICE, desc:`Продвижение «${b.name}» в ТОП` });
    await pushNotification(currentNick, `🔥 Бизнес «${b.name}» продвинут в ТОП на 7 дней!`, 'money');
    toast('🔥 Бизнес продвинут в ТОП!', 'green');
    renderBusinesses();
};
window.deleteListing=async function(id){
    const snap=await get(listingRef(id));
    if(!snap.exists())return toast('❌ Объявление не найдено','red');
    const l=snap.val();
    if(l.seller!==currentNick)return toast('❌ Нет прав','red');
    if(!confirm('Удалить объявление навсегда?'))return;
    await remove(listingRef(id));
    toast('🗑 Удалено','gold');
};
window.archiveListing=async function(id){
    const snap=await get(listingRef(id));
    if(!snap.exists())return toast('❌ Объявление не найдено','red');
    const l=snap.val();
    if(l.seller!==currentNick)return toast('❌ Нет прав','red');
    await update(listingRef(id),{archived:true,archivedAt:Date.now()});
    toast('🕓 Объявление скрыто','gold');
    get(marketRef()).then(snap=>renderMarket(snap.val()||{}));
};
window.restoreListing=async function(id){
    const snap=await get(listingRef(id));
    if(!snap.exists())return toast('❌ Объявление не найдено','red');
    const l=snap.val();
    if(l.seller!==currentNick)return toast('❌ Нет прав','red');
    await update(listingRef(id),{archived:null,archivedAt:null});
    toast('↩ Объявление восстановлено','green');
    get(marketRef()).then(snap=>renderMarket(snap.val()||{}));
};

// ─── LEADERBOARD ──────────────────────────
let currentRatingTab='balance';

window.switchRatingTab=function(tab, btn){
  currentRatingTab=tab;
  document.querySelectorAll('#ratings .msg-tab').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  // allUsersCache is kept live by the live data layer; only fall back to a fetch if it is empty.
  if(allUsersCacheLoaded && Object.keys(allUsersCache||{}).length) renderLeaderboard(allUsersCache);
  else loadAllUsersCache().then(u=>renderLeaderboard(u||{}));
};

function renderLeaderboard(users){
  const medals=['🥇','🥈','🥉'];
  const usersArr=Object.values(users).filter(u=>u.nick);

  const makeRow=(u,i,valHtml)=>{
    const online=isUserOnline(u);const dn=displayNick(u)||u.nick;
    const expiry = u.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    const isActive = expiry && expiry > new Date();
    const frameClass = getAvatarFrameClass(u);
    const frameHtml = frameClass
        ? `<div class="avatar-frame ${frameClass}" style="position:absolute;inset:-4px;border-radius:inherit;pointer-events:none;z-index:1;"></div>`
        : '';
        const avatarSrc = u.avatar || u.avatarUrl || u.photoURL || DEFAULT_AVATAR_URL;
        return `<div class="lb-row" style="cursor:pointer;${u.nick===currentNick?'border-color:var(--primary);background:var(--pri-dim)':''}" onclick="openUserProfile('${escHtml(u.nick)}')"><div class="lb-rank">${medals[i]||`#${i+1}`}</div><div class="av-wrap-sm ${online?'online':''}" style="position:relative;">${frameHtml}<img class="lb-av" src="${escHtml(avatarSrc)}" loading="lazy" onerror="this.onerror=null;this.src='${escHtml(DEFAULT_AVATAR_URL)}'"><div class="online-dot"></div></div><div class="lb-info"><div class="lb-name">${escHtml(dn)}${u.nick===ADMIN?' 👑':''}</div><div class="lb-job" style="color:${online?'#22c55e':'var(--muted)'};">${online?'🟢 В сети':escHtml(getUserBusinessRoleLabel(u, u.nick || ''))}</div></div>${valHtml}</div>`;
  };

  const lbEl=qs('lbList'); if(!lbEl) return;

  const sorted=usersArr.sort((a,b)=>(b.balance||0)-(a.balance||0));
  lbEl.innerHTML=`<div class="card-title">💰 Рейтинг по богатству</div>`+sorted.map((u,i)=>makeRow(u,i,`<div class="lb-bal">${(u.balance||0).toLocaleString()} ₽</div>`)).join('');
}

// ─── JOBS ─────────────────────────────────
window.sendApp=async function(){
    const target=qs('jSel').value;
    const appText=qs('jAppText').value.trim();
    const uSnap=await get(userRef(currentNick));
    const u=uSnap.val()||{};
    if(hasMunicipalJob(u, target)) return toast('⚠️ Вы уже работаете на этой должности','gold');
    if(!await canTakeAnotherJob(u, currentNick)) return toast(`⚠️ Лимит работ: ${getJobLimit(u)}. Увольтесь с одной работы или оформите подписку.`,'gold');
    const kveScore = (u.kveScore !== undefined && u.kveScore !== null) ? Number(u.kveScore) : null;
    const KVE_REQUIREMENTS={'Водитель':60,'Доставщик':53,'Уборщик':40,'Журналист':71,'КСБ':90,'Депутат':95,'Врач':90,'Помощник врача':80,'Рекламщик':50};
    const required=KVE_REQUIREMENTS[target]||0;
    if(kveScore===null){
        return toast('📝 У вас ещё нет результата КВЭ. Дождитесь выставления балла мэрией.','gold');
    }
    if(kveScore<required){
        return toast(`❌ Для профессии «${target}» нужен балл КВЭ: ${required}. Ваш балл: ${kveScore}.`,'red');
    }
    const snap=await get(appsRef());
    const apps=snap.val()||{};
    const already=Object.values(apps).some(a=>a.from===currentNick&&a.status==='new');
    if(already)return toast('⚠️ Заявка уже есть','gold');
    const id=genId();
    await set(appRef(id),{id,from:currentNick,target,status:'new',appText,kveScore,createdAt:Date.now()});
    await pushNotification(currentNick,`📝 Заявка на "${target}" отправлена`,'system');
    toast('📝 Отправлено!','green');
    renderJobAppStatus();
};
window.withdrawApp=async function(){
    const snap=await get(appsRef());
    const apps=snap.val()||{};
    const myApp=Object.values(apps).find(a=>a.from===currentNick&&a.status==='new');
    if(!myApp)return toast('⚠️ Нет активной заявки','gold');
    if(!confirm('Отозвать заявку на работу?')) return;
    await remove(appRef(myApp.id));
    await pushNotification(currentNick,'📝 Заявка отозвана','system');
    toast('📝 Заявка отозвана','gold');
    renderJobAppStatus();
};
function getMunicipalJobSalaryLabel(role){
    const labels={
        'Уборщик':'1700 ₽/неделю',
        'Журналист':'2800 ₽/неделю',
        'КСБ':'4000 ₽/неделю',
        'Депутат':'5000 ₽/неделю',
        'Полицейский':'3400 ₽/неделю',
        'Врач':'в зависимости от приёмов',
        'Помощник врача':'назначается врачом',
        'Рекламщик':'3900 ₽/неделю + 500 ₽ за каждого пользователя сверх 4'
    };
    return labels[role] || (role==='Водитель'||role==='Доставщик' ? 'в зависимости от заказов' : '');
}

window.renderJobAppStatus=async function(){
    const snap=await get(appsRef());
    const apps=snap.val()||{};
    const myApp=Object.values(apps).find(a=>a.from===currentNick);
    const statusEl=qs('myAppStatus');
    const jobsListEl=qs('myJobsList');
    const uSnap=await get(userRef(currentNick));
    const u=uSnap.val()||{};
    if(jobsListEl){
        const emps=collectEmploymentsFromData(u, currentNick);
        const limit=getJobLimit(u);
        jobsListEl.innerHTML=emps.length?`<div style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;">
            <div style="font-weight:800;margin-bottom:6px;">Ваши работы (${emps.length}/${limit})</div>
            ${emps.map(e=>{ const sal=getMunicipalJobSalaryLabel(e.role); return `<div style="padding:6px 0;border-bottom:1px solid var(--border);"><div>${escHtml(e.role)}${e.bizName?` <span style="color:var(--muted);font-size:11px;">· ${escHtml(e.bizName)}</span>`:''}</div>${sal?`<div style="font-size:11px;color:var(--gold);font-weight:800;margin-top:2px;">💰 ${escHtml(sal)}</div>`:''}</div>`; }).join('')}
        </div>`:'';
    }
    
    if(!statusEl) return;
    
    if(!myApp){
        statusEl.innerHTML='';
        if(qs('jAppText')) { qs('jAppText').value=''; qs('jAppText').disabled=false; }
        return;
    }
    
    let statusHTML='';
    if(myApp.status==='new'){
        statusHTML=`<div class="status-card gold" style="margin-top:12px;"><div class="status-badge badge-wait"><span class="pulse"></span>Заявка рассмотривается</div><div style="font-weight:700;margin-bottom:4px;">📝 Заявка на "${myApp.target}"</div>${myApp.appText?`<div style="font-size:13px;color:var(--muted);margin:8px 0;">${escHtml(myApp.appText)}</div>`:''}<div style="font-size:12px;color:var(--muted);">Ожидайте рассмотрения мэрией</div><button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red-dim);margin-top:8px;" onclick="withdrawApp()">Отозвать заявку</button></div>`;
        qs('jAppText').value=myApp.appText||'';
        qs('jAppText').disabled=true;
    } else if(myApp.status==='approved'){
        statusHTML=`<div class="status-card green" style="margin-top:12px;"><div class="status-badge badge-active"><span class="pulse"></span>Заявка одобрена</div><div style="font-weight:700;">✅ Вы приняты на работу "${myApp.target}"</div>${myApp.appText?`<div style="font-size:13px;color:var(--muted);margin:8px 0;">${escHtml(myApp.appText)}</div>`:''}<div style="font-size:12px;color:var(--muted);">Можете приступать к работе</div></div>`;
        qs('jAppText').disabled=true;
    } else if(myApp.status==='rejected'){
        statusHTML=`<div class="status-card" style="margin-top:12px;border-color:var(--red);background:rgba(248,113,113,.08);"><div style="color:var(--red);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">❌ Заявка отклонена</div><div style="font-weight:700;margin-bottom:4px;">📝 Заявка на "${myApp.target}"</div>${myApp.appText?`<div style="font-size:13px;color:var(--muted);margin:8px 0;">${escHtml(myApp.appText)}</div>`:''}<div style="font-size:12px;color:var(--muted);">Попробуйте подать заявку позже</div></div>`;
        qs('jAppText').disabled=false;
    }
    statusEl.innerHTML=statusHTML;
};

// ─── PROFILE ──────────────────────────────
window.changeVehicle=async function(){const v=prompt('Транспорт:');if(v!==null){await update(userRef(currentNick),{vehicle:v});toast('🛵 Обновлено','green');}};
window.saveVehicle=async function(){
    if(!currentNick) return toast('❌ Сначала войдите в аккаунт','red');
    const input=qs('vehicleInput');
    if(!input) return toast('❌ Поле транспорта не найдено','red');
    const v=input.value.trim().slice(0,120);
    try{
        await update(userRef(currentNick),{vehicle:v});
        if(allUsersCache[currentNick]) allUsersCache[currentNick].vehicle=v;
        toast(v?'🛵 Транспорт сохранён':'🛵 Транспорт очищен','green');
    }catch(e){ console.error('[Kapani vehicle]',e); toast('❌ Не удалось сохранить транспорт','red'); }
};
// ─── QUIT JOB (master implementation — all overrides removed below) ───
// quitJob — master implementation above (line ~4800)

function renderJanitorTaskCard(u){
    const el=qs('janitorTaskCard');if(!el||!u)return;
    const status=u.janitorSubmissionStatus||'ready';
    const statusText=status==='approved'?'✅ Отчёт оплачен':status==='pending'?'⏳ Отправлено в мэрию':status==='rejected'?'❌ Отклонено':'🟢 Можно отправить отчёт';
    el.innerHTML=`<div class="status-card green"><div class="status-badge badge-active"><span class="pulse"></span>Уборщик</div><div style="font-weight:900;font-size:18px;margin-bottom:8px;">🧹 ${JANITOR_TASK_TEXT}</div><div style="font-size:13px;color:var(--muted);line-height:1.6;">Дата: <b style="color:var(--text)">${todayKey()}</b><br>${statusText}</div><div style="margin-top:12px;font-size:12px;color:var(--muted);">Фотоотчёт раз в сутки → проверка Кайоном → выплата.</div></div>`;
    const btn=qs('janitorDoneBtn');if(btn)btn.disabled=(status==='pending'||status==='approved');
}
async function renderJanitorPage(){
    const uSnap=await get(userRef(currentNick));if(!uSnap.exists())return;
    const u=uSnap.val();
    renderJanitorTaskCard(u);
    const hist=qs('janitorWorkerHistory');
    if(!hist)return;
    const sSnap=await get(janitorSubsRef());
    const subs=Object.values(sSnap.val()||{}).filter(x=>x.worker===currentNick).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    hist.innerHTML=subs.length===0?'<div style="color:var(--muted);font-size:13px;">Пока нет отправленных отчётов</div>':subs.map(s=>`<div class="work-order" style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;"><b>🧹 ${escHtml(s.date||todayKey())}</b><span style="font-size:11px;color:${s.status==='approved'?'#22c55e':s.status==='rejected'?'var(--red)':'var(--gold)'};font-weight:900;">${s.status==='approved'?'Одобрено'+(s.reward?` +${s.reward}₽`:''):s.status==='rejected'?'Отклонено':'На проверке'}</span></div>${s.photo?`<img loading="lazy" decoding="async" class="submission-photo" src="${escHtml(s.photo)}" onclick="openImgViewer('${jsEsc(s.photo)}')">`:''}${s.comment?`<div style="font-size:13px;white-space:pre-wrap;">${escHtml(s.comment)}</div>`:''}</div>`).join('');
}
window.handleJanitorProof=async function(e){
    const file=e.target.files[0];if(!file)return;
    toast('📷 Сжимаем фото...','gold');
    const dataUrl=await compressImage(file,1100,0.84);
    window._janitorProofData=dataUrl;
    const prev=qs('janitorProofPreview');const img=qs('janitorProofImg');
    if(prev&&img){img.src=dataUrl;prev.style.display='block';}
    const btn=qs('janitorDoneBtn');if(btn)btn.disabled=false;
    e.target.value='';
};
window.submitJanitorDone=async function(){
    const uSnap=await get(userRef(currentNick));if(!uSnap.exists())return;
    const u=uSnap.val();
    if(isMigrantUser(u)) return toast(`🚫 ${ROLE_MIGRANT}: задания недоступны`,'red');
    if(!hasMunicipalJob(u,JOB_JANITOR))return toast('⚠️ Только для уборщика','gold');
    if(u.janitorSubmissionStatus==='pending')return toast('⏳ Уже отправлено','gold');
    if(u.janitorSubmissionStatus==='approved')return toast('✅ Сегодня уже закрыто','green');
    if(!window._janitorProofData)return toast('⚠️ Прикрепите фото','gold');
    const id=genId();
    const sub={id,worker:currentNick,workerAvatar:u.avatar||DEFAULT_AVATAR_URL,workerJob:u.job||JOB_JANITOR,date:todayKey(),task:JANITOR_TASK_TEXT,photo:window._janitorProofData,comment:(qs('janitorProofComment')?.value||'').trim(),status:'pending',createdAt:Date.now()};
    await set(janitorSubRef(id),sub);
    await update(userRef(currentNick),{janitorSubmissionId:id,janitorSubmissionStatus:'pending'});
    window._janitorProofData=null;
    const prev=qs('janitorProofPreview');if(prev)prev.style.display='none';
    const im=qs('janitorProofImg');if(im)im.removeAttribute('src');
    const c=qs('janitorProofComment');if(c)c.value='';
    const fi=qs('janitorProofFile');if(fi)fi.value='';
    const doneBtn=qs('janitorDoneBtn');if(doneBtn)doneBtn.disabled=true;
    try{await pushNotification(ADMIN,`🧹 Отчёт уборщика: ${currentNick}`,'system');}catch(e){console.error('[notification pipeline][cleaner report]',e);}
    toast('📨 Отчёт в мэрии','green');
};

// ─── KVE EXAM ─────────────────────────────
const KVE_JOB_REQUIREMENTS={'Водитель':60,'Доставщик':53,'Уборщик':40,'Журналист':71,'КСБ':90,'Депутат':95,'Врач':90,'Помощник врача':80,'Рекламщик':50};
window.KVE_JOB_REQUIREMENTS = KVE_JOB_REQUIREMENTS;
  window.addSatelliteLayer = addSatelliteLayer;
  window.taxiHistoryRef = taxiHistoryRef;
  window.ACTIVE_ORDER_STATUSES = ACTIVE_ORDER_STATUSES;
function getKveJobAccess(score){
    return Object.entries(KVE_JOB_REQUIREMENTS).filter(([,req])=>score>=req).map(([job])=>job);
}
async function renderKveSection(u){
    const el=qs('kveResultCard');
    if(!el)return;
    if(!u){
        const snap=await get(userRef(currentNick));
        if(!snap.exists()){el.innerHTML='';return;}
        u=snap.val();
    }
    const score=(u.kveScore!==undefined&&u.kveScore!==null)?Number(u.kveScore):null;
    // Update KVE tab notice on jobs page
    const jNotice=qs('jobKveNotice');
    if(jNotice){
        if(score===null){
            jNotice.innerHTML=`<div style="background:rgba(255,128,106,.08);border:1px solid rgba(255,128,106,.3);border-radius:var(--r-sm);padding:12px;font-size:13px;"><b style="color:var(--gold);">📝 Балл КВЭ не выставлен</b><br><span style="color:var(--muted);">Мэрия ещё не выставила вам балл КВЭ. Заявки на работу будут заблокированы до получения результата.</span></div>`;
        } else {
            const available=getKveJobAccess(score);
            const blocked=Object.keys(KVE_JOB_REQUIREMENTS).filter(j=>!available.includes(j));
            jNotice.innerHTML=`<div style="background:rgba(240,68,74,.07);border:1px solid rgba(240,68,74,.25);border-radius:var(--r-sm);padding:12px;font-size:13px;"><b style="color:var(--primary);">📝 Ваш балл КВЭ: <span style="font-size:18px;">${score}</span></b>${available.length?`<div style="margin-top:6px;color:var(--text);">✅ Доступные профессии: <b>${available.join(', ')}</b></div>`:''}${blocked.length?`<div style="margin-top:4px;color:var(--muted);">🔒 Недоступно: ${blocked.join(', ')}</div>`:''}</div>`;
        }
    }
    if(score===null){
        el.innerHTML=`<div class="card" style="border-color:rgba(255,128,106,.3);background:rgba(255,128,106,.06);">
            <div style="text-align:center;padding:10px 0;">
                <div style="font-size:40px;margin-bottom:8px;">⏳</div>
                <div style="font-weight:900;font-size:17px;color:var(--gold);margin-bottom:4px;">Результат ещё не получен</div>
                <div style="font-size:13px;color:var(--muted);line-height:1.5;">Мэрия ещё не выставила вам балл.<br>Вы получите уведомление, когда результат появится.</div>
            </div>
        </div>`;
        return;
    }
    const isPassed=score>=32;
    const available=getKveJobAccess(score);
    const blocked=Object.keys(KVE_JOB_REQUIREMENTS).filter(j=>!available.includes(j));
    const scoreColor=score>=90?'#f0444a':score>=60?'#22c55e':score>=32?'#ff806a':'#f87171';
    const examDate=u.kveExamDate?`<div style="font-size:11px;color:var(--muted);margin-top:6px;">Дата выставления: ${u.kveExamDate}</div>`:'';
    el.innerHTML=`<div class="card" style="border-color:${scoreColor}44;background:${scoreColor}11;">
        <div style="text-align:center;padding:8px 0 4px;">
            <div style="font-size:56px;font-weight:900;font-family:'Unbounded',sans-serif;color:${scoreColor};line-height:1;">${score}</div>
            <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${scoreColor};margin-top:2px;">баллов КВЭ</div>
            ${examDate}
            <div style="margin-top:10px;display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:900;background:${isPassed?'rgba(240,68,74,.14)':'rgba(248,113,113,.14)'};color:${isPassed?'var(--primary)':'var(--red)'};">
                ${isPassed?'✅ Порог пройден':'❌ Ниже минимума (32)'}
            </div>
        </div>
        ${available.length?`<div style="margin-top:14px;"><div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px;">✅ Доступные профессии</div>${available.map(j=>`<div style="padding:8px 12px;background:rgba(240,68,74,.09);border:1px solid rgba(240,68,74,.2);border-radius:10px;font-size:13px;font-weight:800;margin-bottom:6px;">✅ ${j} — нужно ${KVE_JOB_REQUIREMENTS[j]}б.</div>`).join('')}</div>`:''}
        ${blocked.length?`<div style="margin-top:8px;"><div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px;">🔒 Недоступные профессии</div>${blocked.map(j=>`<div style="padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--muted);margin-bottom:6px;">🔒 ${j} — нужно ${KVE_JOB_REQUIREMENTS[j]}б.</div>`).join('')}</div>`:''}
        <button class="btn btn-ghost" style="margin-top:12px;font-size:12px;" onclick="navTo('jobs')">🛠 Перейти к работе →</button>
    </div>`;
}
window.adminSetKveScore=async function(){
    if(currentNick!==ADMIN)return;
    const target=qs('kveTarget')?.value;
    const scoreRaw=qs('kveScoreInput')?.value;
    const statusEl=qs('kveAdminStatus');
    if(!target){if(statusEl)statusEl.textContent='⚠️ Выберите жителя';return;}
    const score=parseInt(scoreRaw,10);
    if(isNaN(score)||score<0||score>100){if(statusEl)statusEl.textContent='⚠️ Введите балл от 0 до 100';return;}
    const snap=await get(userRef(target));
    if(!snap.exists()){if(statusEl)statusEl.textContent='❌ Житель не найден';return;}
    const now=new Date();
    const dateStr=now.toLocaleDateString('ru');
    await update(userRef(target),{kveScore:score,kveExamDate:dateStr,kveScoreSetBy:ADMIN,kveScoreSetAt:Date.now()});
    const isPassed=score>=32;
    const available=getKveJobAccess(score).join(', ')||'нет';
    const msg=`📝 Результат КВЭ: ${score} баллов. ${isPassed?'✅ Порог пройден. Доступные профессии: '+available:'❌ Ниже минимума (32). Обратитесь к мэру.'}`;
    await pushNotification(target,msg,'system');
    await logTx(target,{type:'in',who:'Мэрия',amt:0,desc:`КВЭ выставлен: ${score} баллов`});
    if(statusEl)statusEl.innerHTML=`<span style="color:var(--primary);">✅ Балл ${score} выставлен жителю <b>${target}</b>. Уведомление отправлено.</span>`;
    if(qs('kveScoreInput'))qs('kveScoreInput').value='';
    // Refresh user list in select
    const allSnap=await get(ref(db,'users'));
    renderAdminUserSelect(allSnap.val()||{});
    toast(`📝 КВЭ: ${target} = ${score} балл`,'green');
};
// Live preview of KVE score
document.addEventListener('input',function(e){
    if(e.target.id==='kveScoreInput'){
        const prev=qs('kveScorePreview');
        if(prev){const v=parseInt(e.target.value,10);prev.textContent=isNaN(v)?'—':v+'б.';}
    }
});
// ─── ADMIN ────────────────────────────────
function renderAdminApps(apps){const pending=Object.values(apps||{}).filter(a=>a.status==='new');qs('appList').innerHTML=pending.length===0?'<div style="color:var(--muted);font-size:13px;">Нет</div>':pending.map(a=>`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;margin-bottom:8px;"><b>${escHtml(a.from)}</b> → ${escHtml(a.target)}<div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="approveApp('${a.id}',true)">✅</button><button class="btn btn-red btn-sm" onclick="approveApp('${a.id}',false)">❌</button></div></div>`).join('');}
function renderAdminUsers(users){
    const el=qs('allUsersList');if(!el)return;
    el.innerHTML=Object.values(users).map(u=>{
        const online=isUserOnline(u);
        const canDelete=u.nick!==ADMIN;
        const label = (u.displayName&&u.displayName.trim()) ? escHtml(u.displayName.trim()) : escHtml(u.nick||'');
        const loginHint = (u.displayName&&u.displayName.trim()&&u.displayName.trim()!==u.nick) ? `<span style="font-size:10px;color:var(--muted);margin-left:4px;">(@${escHtml(u.nick)})</span>` : '';
        return `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px;">
            <div class="av-wrap-sm ${online?'online':''}" style="cursor:pointer;" onclick="openUserProfile('${escHtml(u.nick)}')">
                <img src="${escHtml(u.avatar||DEFAULT_AVATAR_URL)}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;" loading="lazy"><div class="online-dot"></div>
            </div>
            <div style="flex:1;cursor:pointer;min-width:0;" onclick="openUserProfile('${escHtml(u.nick)}')">
                <div style="font-weight:800;font-size:13px;">${label}${u.nick===ADMIN?' 👑':''}${loginHint}</div>
                <div style="font-size:11px;color:${online?'#22c55e':'var(--primary)'};">${online?'🟢 В сети · ':''}${escHtml(getUserBusinessRoleLabel(u, u.nick||''))} · ${(u.balance||0).toLocaleString()}₽</div>
            </div>
            ${canDelete?`<button class="btn btn-red btn-sm" style="margin-left:8px;padding:6px 10px;font-size:11px;" onclick="event.stopPropagation();adminDeleteAccount('${escHtml(u.nick)}')">🗑</button>`:''}
        </div>`;
    }).join('');
    const total=Object.values(users).reduce((s,u)=>s+(u.balance||0),0);
    const aStats=qs('adminStats');if(aStats)aStats.innerHTML=`<div class="stat-box"><div class="sv" style="color:var(--gold)">${Object.keys(users).length}</div><div class="sl">Жителей</div></div><div class="stat-box"><div class="sv" style="color:var(--gold)" id="adminOrderCount">—</div><div class="sl">Заказов</div></div><div class="stat-box"><div class="sv" style="color:var(--gold)">${Math.round(total/1000)}к</div><div class="sl">₽ оборот</div></div>`;
}
async function renderAdvertiserWorkStats(){
    const host=qs('jobsAdvertiserStats'); if(!host||!currentNick) return;
    const u=allUsersCache[currentNick]||{}; if(!hasMunicipalJob(u,JOB_ADVERTISER)){host.style.display='none';return;}
    host.style.display='block';
    const count=await getAdvertiserReferralCount(currentNick);
    host.innerHTML=`<div class="card" style="border-color:rgba(240,68,74,.3);background:rgba(240,68,74,.04);"><div class="card-title" style="color:var(--primary);">📢 Результат работы рекламщика</div><div style="font-size:22px;font-weight:900;color:var(--primary);">Приглашено пользователей: ${count}</div></div>`;
}
async function renderAdminAdvertiserStats(){
    const host=qs('adminAdvertiserStats'); if(!host) return;
    const [snap, statsSnap] = await Promise.all([get(ref(db,'users')), get(ref(db,'advertiserStats'))]);
    const users=snap.val()||{};
    const stats=statsSnap.val()||{};
    const rows=[];
    for(const [nick,u] of Object.entries(users)){
        if(!hasMunicipalJob(u,JOB_ADVERTISER)) continue;
        const resetAt=Number(stats[nick]?.resetAt||0);
        const count=Object.values(users).filter(x=>x&&String(x.invitedBy||'')===nick&&Number(x.referralCreatedAt||x.createdAt||0)>resetAt).length;
        rows.push({nick:displayNick(u)||nick,count});
    }
    rows.sort((a,b)=>b.count-a.count||a.nick.localeCompare(b.nick,'ru'));
    host.innerHTML=rows.length?`<div style="display:grid;gap:6px;">${rows.map(r=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--surface2);border-radius:10px;"><span>${escHtml(r.nick)}</span><b style="color:var(--primary);">${r.count}</b></div>`).join('')}</div>`:'<div style="color:var(--muted);font-size:13px;">Нет активных рекламщиков</div>';
}
window.adminClearAdvertiserStats=async function(){
    if(currentNick!==ADMIN)return toast('❌ Только для мэра','red');
    if(!confirm('Вы уверены? Статистика приглашений будет обнулена, пользователи останутся.')) return;
    try{const n=await clearAdvertiserReferralStats();await renderAdminAdvertiserStats();toast(`✅ Статистика обнулена для ${n} рекламщиков`,'green');}catch(e){toast('❌ '+(e.message||'Не удалось очистить статистику'),'red');}
};

function renderAdminOrders(orders){
    const el=qs('adminOrders');if(!el)return;
    const arr=Object.entries(orders||{}).map(([id,o])=>({...o,id}));
    const cnt=qs('adminOrderCount');if(cnt)cnt.textContent=arr.length;
    const uCache = window.allUsersCache || {};
    const dName = (nick) => {
        if(!nick) return '';
        const u = uCache[nick];
        return (u && u.displayName && u.displayName.trim()) ? u.displayName.trim() : nick;
    };
    el.innerHTML=arr.length===0?'<div style="color:var(--muted);font-size:13px;">Нет</div>':arr.map(o=>`
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;font-size:13px;">
            <b>${o.type==='taxi'?'🛵 Такси':'📦 Доставка'}</b> · ${escHtml(o.info)}<br>
            Клиент: ${escHtml(dName(o.client))} · ${o.price}₽
            ${o.worker?` · Исполнитель: ${escHtml(dName(o.worker))}`:'· <span style="color:var(--muted)">Ожидает</span>'}
            <br><button class="btn btn-red btn-sm" style="margin-top:8px;" onclick="adminDeleteOrder('${o.id}')">Удалить</button>
        </div>`).join('');
}
function renderAdminUserSelect(users){
    const sel=qs('adminTarget');
    if(!sel)return;
    const cur=sel.value;
    sel.innerHTML=Object.entries(users).map(([n,u])=>{
        const label = (u.displayName&&u.displayName.trim()) ? `${u.displayName.trim()} (@${n})` : n;
        return `<option value="${n}">${label}</option>`;
    }).join('');
    if(cur)sel.value=cur;
    const forceHireSel=qs('adminForceHireTarget');
    if(forceHireSel){
        const curFH=forceHireSel.value;
        forceHireSel.innerHTML=Object.entries(users).map(([n,u])=>{
            const label = (u.displayName&&u.displayName.trim()) ? `${u.displayName.trim()} (@${n})` : n;
            return `<option value="${n}">${label}</option>`;
        }).join('');
        if(curFH)forceHireSel.value=curFH;
    }
    // Also populate kveTarget select
    const kveSel=qs('kveTarget');
    if(kveSel){
        const kveVal=kveSel.value;
        kveSel.innerHTML='<option value="">— Выберите жителя —</option>'+Object.entries(users).map(([n,u])=>{
            const label = (u.displayName&&u.displayName.trim()) ? `${u.displayName.trim()} (@${n})` : n;
            const score = u.kveScore!==undefined&&u.kveScore!==null ? ` (${u.kveScore}б.)` : ' (нет балла)';
            return `<option value="${n}">${label}${score}</option>`;
        }).join('');
        if(kveVal)kveSel.value=kveVal;
    }
}
function renderAdminJanitorSubmissions(subs){
    const el=qs('janitorAdminList');if(!el)return;
    const pending=Object.values(subs||{}).filter(s=>s.status==='pending').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const uCache = window.allUsersCache || {};
    const dName = (nick) => {
        const u = uCache[nick];
        return (u && u.displayName && u.displayName.trim()) ? u.displayName.trim() : (nick||'');
    };
    el.innerHTML=pending.length===0?'<div style="color:var(--muted);font-size:13px;">Нет отчётов</div>':pending.map(s=>`
        <div class="submission-card">
            <div class="submission-top" onclick="openUserProfile('${jsEsc(s.worker)}')">
                <img src="${escHtml(s.workerAvatar||DEFAULT_AVATAR_URL)}" style="width:46px;height:46px;border-radius:13px;object-fit:cover;border:2px solid var(--primary);" loading="lazy">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:900;font-size:14px;">${escHtml(dName(s.worker))}${s.worker===ADMIN?' 👑':''}</div>
                    <div style="font-size:11px;color:var(--muted);">${escHtml(s.workerJob||JOB_JANITOR)} · ${escHtml(s.date||todayKey())}</div>
                </div>
                <div style="font-size:11px;font-weight:900;color:var(--gold);">⏳ На проверке</div>
            </div>
            ${s.photo?`<img loading="lazy" decoding="async" class="submission-photo" src="${escHtml(s.photo)}" onclick="openImgViewer('${jsEsc(s.photo)}')">`:''}
            ${s.comment?`<div style="font-size:13px;color:var(--text);white-space:pre-wrap;">${escHtml(s.comment)}</div>`:''}
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-ghost btn-sm" onclick="goToChat('${jsEsc(s.worker)}')">💬 Чат</button>
                <button class="btn btn-primary btn-sm" onclick="payoutJanitorSubmission('${jsEsc(s.id)}')">💵 Выплатить</button>
                <button class="btn btn-red btn-sm" onclick="rejectJanitorSubmission('${jsEsc(s.id)}')">❌ Отказать</button>
            </div>
        </div>`).join('');
}
window.payoutJanitorSubmission=async function(id){
    if(currentNick!==ADMIN)return;
    const amt=parseInt(prompt('Сумма выплаты уборщику (₽)','250')||'0',10)||0;
    if(amt<=0)return toast('⚠️ Сумма','gold');
    const snap=await get(janitorSubRef(id));if(!snap.exists())return;
    const s=snap.val();
    const uSnap=await get(userRef(s.worker));if(!uSnap.exists())return;
    const u=uSnap.val();
    const newBal=(u.balance||0)+amt;
    const unfrozen=newBal>MIN_BALANCE_ALLOWED?{accountFrozen:false}:{};
    await update(userRef(s.worker),{balance:newBal,janitorSubmissionStatus:'approved',janitorSubmissionId:id,...unfrozen});
    await update(janitorSubRef(id),{status:'approved',reviewedBy:ADMIN,reviewedAt:Date.now(),reward:amt});
    await logTx(s.worker,{type:'in',who:'Мэрия',amt,desc:'Выплата за уборку (одобрено Кайоном)'});
    await pushNotification(s.worker,`✅ Уборка одобрена. +${amt}₽`,'money');
    toast(`✅ ${s.worker} +${amt}₽`,'green');
    renderAdmin();
};
window.rejectJanitorSubmission=async function(id){
    if(currentNick!==ADMIN)return;
    const snap=await get(janitorSubRef(id));if(!snap.exists())return;
    const s=snap.val();
    await update(userRef(s.worker),{janitorSubmissionStatus:'rejected',janitorSubmissionId:''});
    await update(janitorSubRef(id),{status:'rejected',reviewedBy:ADMIN,reviewedAt:Date.now()});
    await pushNotification(s.worker,'❌ Отчёт по уборке отклонён','system');
    toast('❌ Отклонено','red');
    renderAdmin();
};
async function renderAdmin(){
    const status=qs('mayorLoadStatus');
    if(status) status.textContent='Загружаем данные мэрии…';
    try {
    const[uSnap,oSnap,aSnap,jSnap,rSnap]=await Promise.all([get(ref(db,'users')),get(ordersRef()),get(appsRef()),get(janitorSubsRef()),get(rentBuildingsRef())]);
    renderAdminUsers(uSnap.val()||{});renderAdminOrders(oSnap.val()||{});renderAdminApps(aSnap.val()||{});renderAdminJanitorSubmissions(jSnap.val()||{});renderAdminUserSelect(uSnap.val()||{});renderUnverifiedAccounts();
    renderAdminBizApps();
    renderAdminBizDeleteReqs();
    renderAdminRentBuildings(rSnap.val()||{});
    if(typeof renderAdminRaces === 'function') renderAdminRaces();
    if(typeof renderAdminDayGroups === 'function') renderAdminDayGroups();
    if(typeof populateRaceDayGroupSelect === 'function') populateRaceDayGroupSelect();
    if(typeof populateRaceDayUserSelect === 'function') populateRaceDayUserSelect();
    renderAdminDeputyProposals();
    renderAdminAtmRequests();
    try { if(typeof window.renderMunicipalTreasury === 'function') window.renderMunicipalTreasury(); } catch(e) {}
    if(status) status.textContent='';
    } catch(error) {
        console.error('[Kapani mayor data]',error);
        if(status) status.textContent='Не удалось загрузить данные. Проверьте соединение и откройте мэрию ещё раз.';
        for(const id of ['adminStats','adminOrders','allUsersList','adminRentBuildings','appList','janitorAdminList']){
            const list=qs(id);
            if(list && (!list.textContent.trim() || /загрузка/i.test(list.textContent))) list.textContent='Не удалось загрузить список. Попробуйте открыть мэрию ещё раз.';
        }
    }
}

async function renderAdminDeputyProposals() {
    const el = qs('adminDeputyProposals');
    if (!el) return;
    try {
        const snap = await get(ref(db, 'deputyProposals'));
        const all = snap.val() || {};
        const pending = Object.values(all).filter(p => p.status === 'pending').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        const done = Object.values(all).filter(p => p.status !== 'pending').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,5);
        if (!pending.length && !done.length) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет предложений</div>'; return; }
        const renderProposal = (p) => {
            const stColors = { pending:'gold', approved:'primary', rejected:'red' };
            const sc = stColors[p.status] || 'gold';
            return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
                    <div><b style="font-size:13px;">${escHtml(p.title)}</b><div style="font-size:10px;color:var(--muted);">${escHtml(p.typeLabel||'')} · от ${escHtml(p.author)} · ${escHtml(p.date||'')} ${escHtml(p.time||'')}</div></div>
                    <span style="font-size:10px;font-weight:900;color:var(--${sc});white-space:nowrap;">${p.status==='pending'?'⏳':p.status==='approved'?'✅':'❌'}</span>
                </div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${escHtml(p.text)}</div>
                ${p.status === 'pending' ? `
                <input type="text" id="dpComment_${p.id}" placeholder="Комментарий мэрии (опц.)" style="margin-bottom:6px;">
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm" onclick="reviewDeputyProposal('${p.id}','approved')">✅ Одобрить</button>
                    <button class="btn btn-red btn-sm" onclick="reviewDeputyProposal('${p.id}','rejected')">❌ Отклонить</button>
                </div>` : `<div style="font-size:11px;color:var(--muted);">Ответ: ${escHtml(p.adminComment||'—')}</div>`}
            </div>`;
        };
        el.innerHTML = (pending.length ? '<div style="font-size:11px;font-weight:900;color:var(--gold);margin-bottom:6px;">ОЖИДАЮТ РАССМОТРЕНИЯ</div>' + pending.map(renderProposal).join('') : '') +
            (done.length ? '<div style="font-size:11px;font-weight:900;color:var(--muted);margin:8px 0 4px;">РАССМОТРЕННЫЕ</div>' + done.map(renderProposal).join('') : '');
    } catch(e) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Ошибка загрузки</div>'; }
}

window.reviewDeputyProposal = async function(id, status) {
    const commentEl = qs('dpComment_' + id);
    const comment = (commentEl?.value || '').trim();
    await update(ref(db, `deputyProposals/${id}`), { status, adminComment: comment || null, reviewedAt: Date.now() });
    const snap = await get(ref(db, `deputyProposals/${id}`));
    const p = snap.val();
    if (p && p.author) {
        const msg = status === 'approved' ? `✅ Ваше предложение «${p.title}» одобрено мэрией!${comment?' Комментарий: '+comment:''}` : `❌ Ваше предложение «${p.title}» отклонено.${comment?' Причина: '+comment:''}`;
        await pushNotification(p.author, msg, 'system');
    }
    toast(status === 'approved' ? '✅ Одобрено' : '❌ Отклонено', status === 'approved' ? 'green' : 'red');
    renderAdminDeputyProposals();
    renderAdminAtmRequests();
};

async function renderAdminAtmRequests() {
    const el = qs('adminAtmRequests');
    if(!el) return;
    try {
        const snap = await get(ref(db, 'atmRequests'));
        const all = snap.val() || {};
        const pending = Object.values(all).filter(r => r.status === 'pending').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        const done = Object.values(all).filter(r => r.status !== 'pending').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0, 8);
        if(!pending.length && !done.length){
            el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет заявок</div>';
            return;
        }
        const renderReq = (r) => `
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
                    <div style="font-weight:900;">${escHtml(r.name || r.clientName || 'Житель')}</div>
                    <div style="font-size:10px;color:var(--muted);">${new Date(r.createdAt || 0).toLocaleString('ru')}</div>
                </div>
                <div style="font-size:12px;color:var(--primary);font-weight:800;margin-bottom:6px;">${escHtml(r.action || '')} · ${Number(r.amount || 0).toLocaleString()} ₽</div>
                <div style="font-size:12px;color:var(--text);line-height:1.5;margin-bottom:8px;">📍 ${escHtml(r.address || '')}</div>
                ${r.status === 'pending' ? `
                    <div style="display:flex;gap:6px;">
                        <button class="btn btn-primary btn-sm" onclick="reviewAtmRequest('${r.id}','approved')">✅ Принять</button>
                        <button class="btn btn-red btn-sm" onclick="reviewAtmRequest('${r.id}','rejected')">❌ Отклонить</button>
                    </div>` : `<div style="font-size:11px;color:var(--muted);">Статус: ${r.status === 'approved' ? 'принято' : 'отклонено'}</div>`}
            </div>`;
        el.innerHTML = (pending.length ? '<div style="font-size:11px;font-weight:900;color:var(--gold);margin-bottom:6px;">ОЖИДАЮТ РАССМОТРЕНИЯ</div>' + pending.map(renderReq).join('') : '') +
                       (done.length ? '<div style="font-size:11px;font-weight:900;color:var(--muted);margin:8px 0 4px;">РАССМОТРЕННЫЕ</div>' + done.map(renderReq).join('') : '');
    } catch(e) {
        el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Ошибка загрузки</div>';
    }
}
window.reviewAtmRequest = async function(id, status){
    await update(ref(db, `atmRequests/${id}`), { status, reviewedAt: Date.now() });
    const snap = await get(ref(db, `atmRequests/${id}`));
    const r = snap.val();
    if(r && r.client){
        const msg = status === 'approved'
            ? `✅ Ваша заявка банкомата принята мэрией.`
            : `❌ Ваша заявка банкомата отклонена мэрией.`;
        await pushNotification(r.client, msg, 'system');
    }
    toast(status === 'approved' ? '✅ Заявка принята' : '❌ Заявка отклонена', status === 'approved' ? 'green' : 'red');
    renderAdminAtmRequests();
};

let _forceHireBusy = false;
window.adminForceHire = async function(){
    if(currentNick !== ADMIN) return toast('❌ Только для мэра','red');
    if(_forceHireBusy) return;
    const target = qs('adminForceHireTarget')?.value;
    const job = qs('adminForceHireJob')?.value;
    const statusEl = qs('adminForceHireStatus');
    if(!target || !job){ if(statusEl) statusEl.textContent='⚠️ Выберите жителя и должность'; return; }
    if(!confirm(`Назначить ${target} на должность «${job}» в обход требований КВЭ?`)) return;
    _forceHireBusy = true;
    try {
        const snap = await get(userRef(target));
        if(!snap.exists()){ if(statusEl) statusEl.textContent='❌ Житель не найден'; return; }
        const u = snap.val() || {};
        if(!await canTakeAnotherJob(u, target)){
            if(statusEl) statusEl.innerHTML = `<span style="color:var(--red);">❌ Лимит работ (${getJobLimit(u)}) для ${target}</span>`;
            return;
        }
        // KVE CHECK = BYPASS — this is the one and only path in the app that
        // skips the KVE requirement. Regular applications (sendApp/approveApp)
        // continue to enforce it as before.
        const fresh = (await get(userRef(target))).val() || u;
        const emps = collectEmploymentsFromData(fresh, target);
        const newEmp = { id: `muni_${job}`, type: 'municipal', role: job };
        const patch = { job, vehicle:'', employments:[...emps.filter(e=>e.id!==newEmp.id), newEmp], displayJob: fresh.displayJob || job };
        if(job===JOB_ADVERTISER){ Object.assign(patch, { advertiserSalaryPaidThroughWeek: advertiserWeekKey(), advertiserStartedWeek: advertiserWeekKey() }); }
        if(job===JOB_JANITOR){ Object.assign(patch, {janitorTaskDate:todayKey(), janitorSubmissionId:'', janitorSubmissionStatus:'ready', janitorProof:'', janitorComment:''}); }
        else { Object.assign(patch, {janitorTaskDate:'', janitorSubmissionId:'', janitorSubmissionStatus:'', janitorProof:'', janitorComment:''}); }
        await update(userRef(target), patch);
        const logId = genId();
        await set(ref(db, `adminForceHireLog/${logId}`), { id: logId, admin: currentNick, targetNick: target, job, bypassKve: true, createdAt: Date.now() });
        await pushNotification(target, `🏛 Мэрия назначила вас на должность: ${job}`, 'system');
        if(statusEl) statusEl.innerHTML = `<span style="color:var(--primary);">✅ ${displayNick(fresh)||target} назначен(а) на «${job}» (без проверки КВЭ)</span>`;
        toast(`🏛 ${target} → ${job}`,'green');
        console.log('admin forced hire', target, job);
    } catch(e){ console.error('[adminForceHire]', e); if(statusEl) statusEl.textContent='❌ Ошибка назначения'; }
    finally { _forceHireBusy = false; }
};

window.approveApp=async function(id,ok){
    const snap=await get(appRef(id));if(!snap.exists())return;
    const a=snap.val();
    if(ok){
        const uSnap=await get(userRef(a.from));
        const u=uSnap.val()||{};
        if(!await canTakeAnotherJob(u, a.from)) {
            toast(`❌ Лимит работ (${getJobLimit(u)}) для ${a.from}`,'red');
            return;
        }
        const emps = collectEmploymentsFromData(u, a.from);
        const newEmp = { id: `muni_${a.target}`, type: 'municipal', role: a.target };
        const patch={job:a.target,vehicle:'',employments:[...emps.filter(e=>e.id!==newEmp.id), newEmp], displayJob: u.displayJob || a.target};
        if(a.target===JOB_ADVERTISER){Object.assign(patch,{advertiserSalaryPaidThroughWeek:advertiserWeekKey(),advertiserStartedWeek:advertiserWeekKey()});}
        if(a.target===JOB_JANITOR){Object.assign(patch,{janitorTaskDate:todayKey(),janitorSubmissionId:'',janitorSubmissionStatus:'ready',janitorProof:'',janitorComment:''});}
        else{Object.assign(patch,{janitorTaskDate:'',janitorSubmissionId:'',janitorSubmissionStatus:'',janitorProof:'',janitorComment:''});}
        await update(userRef(a.from),patch);
        await pushNotification(a.from,`✅ Должность: ${a.target}`,'system');
        toast(`✅ ${displayNick(u)||a.from} — ${a.target}`,'green');
    }else{
        await pushNotification(a.from,`❌ Заявка на ${a.target} отклонена`,'system');
        toast('❌ Отклонено','red');
    }
    await update(appRef(id),{status:'done'});
};
let _adminMoneyBusy = false;
window.adminMoney=async function(){
    if(_adminMoneyBusy) return toast('⏳ Операция уже выполняется…','gold');
    if(currentNick!==ADMIN) return toast('🚫 Только мэр','red');
    const confirmTarget=qs('adminTarget')?.value;
    const confirmRaw=String(qs('adminAmt')?.value||'').trim();
    const confirmAmount=/^-?\d+$/.test(confirmRaw) ? Number(confirmRaw) : NaN;
    if(!confirmTarget) return toast('⚠️ Выберите жителя','gold');
    if(!Number.isSafeInteger(confirmAmount)||confirmAmount===0) return toast('⚠️ Укажите целую сумму','gold');
    if(!confirm(`${confirmAmount>0?'Зачислить':'Списать'} ${Math.abs(confirmAmount).toLocaleString('ru-RU')} ₽ ${confirmTarget}? Баланс изменится сразу.`)) return;
    _adminMoneyBusy=true;
    try{
        const target=qs('adminTarget')?.value;
        const amtRaw=String(qs('adminAmt')?.value||'').trim();
        const amt=/^-?\d+$/.test(amtRaw) ? Number(amtRaw) : NaN;
        if(!target)return toast('⚠️ Выберите жителя','gold');
        if(!Number.isSafeInteger(amt)||amt===0)return toast('⚠️ Укажите целую сумму','gold');
        const balanceRef=ref(db, `users/${target}/balance`);
        const result=await runTransaction(balanceRef,currentBalance=>{
            const balance=Number(currentBalance||0);
            if(!Number.isFinite(balance))return;
            const nextBalance=balance+amt;
            if(!Number.isSafeInteger(nextBalance))return;
            return nextBalance;
        });
        if(!result?.committed)return toast('❌ Не удалось изменить баланс','red');
        const committedUser=(await get(userRef(target))).val()||{};
        allUsersCache[target]=committedUser;window.allUsersCache=allUsersCache;
        if(amt>0) await logTx(target,{type:'in',who:'Мэрия',amt,desc:'Зачисление от мэрии'});
        else await logTx(target,{type:'out',who:'Мэрия',amt:Math.abs(amt),desc:'Списание мэрией'});
        await pushNotification(target,`${amt>0?'💰 Зачислено':'💸 Списано'} ${Math.abs(amt).toLocaleString('ru-RU')} ₽ мэром`,'money');
        if(qs('adminAmt'))qs('adminAmt').value='';
        if(target===currentNick){updateHeader(committedUser);updateHeader_balance(committedUser);}
        else {const me=allUsersCache[currentNick]||{};updateHeader(me);updateHeader_balance(me);}
        toast(`${amt>0?'💰':'💸'} ${Math.abs(amt).toLocaleString('ru-RU')} ₽ → ${target}`,amt>0?'green':'red');
        if(typeof window.renderAdmin==='function') window.renderAdmin();
    }catch(e){
        console.error('[adminMoney]',e);
        toast('❌ '+(e.message||'Ошибка'),'red');
    }finally{_adminMoneyBusy=false;}
};

let _adminFineBusy=false;
window.adminFineWorker=async function(){
    if(currentNick!==ADMIN) return toast('Только для мэра','red');
    if(_adminFineBusy) return toast('Операция уже выполняется','gold');
    const target=qs('adminTarget').value;
    const amt=Math.abs(parseInt(qs('adminFineAmt').value)||0);
    const reason=(qs('adminFineReason')?.value||'').trim();
    if(!target)return toast('⚠️ Выберите жителя','gold');
    if(amt<=0)return toast('⚠️ Укажите штраф','gold');
    if(!reason)return toast('⚠️ Укажите причину штрафа','gold');
    if(!confirm(`Выписать штраф ${amt.toLocaleString('ru-RU')} ₽ жителю ${target}? Причина: ${reason}. Деньги будут списаны с баланса.`)) return;
    _adminFineBusy=true;
    try {
        const snap=await get(userRef(target));if(!snap.exists())return toast('❌ Не найден','red');
        // Вызываем Cloud Function с fallback
        const result = await callFunctionWithFallback('adminAdjustBalance', { 
            uid: target, 
            amount: -amt, // Отрицательное значение для списания
            type: 'fine',
            description: `Штраф от мэрии: ${reason}`
        }, fallbackAdminAdjustBalance);
        
        if (result.success) {
            // Проверяем и обновляем статус заморозки аккаунта
            const userSnap = await get(userRef(target));
            const user = userSnap.val();
            const newBal = result.newBalance;
            const patch = {};
            if (newBal <= MIN_BALANCE_ALLOWED) patch.accountFrozen = true;
            
            if (Object.keys(patch).length > 0) {
                await update(userRef(target), patch);
            }
            await window.addMunicipalTreasury?.(amt, `Штраф от мэрии: ${reason}`, {sourceNick:target,sourceType:'fine'});
            
            await pushNotification(target,`💸 Штраф ${amt}₽ от мэрии. Причина: ${reason}`,'money');
            qs('adminFineAmt').value='';if(qs('adminFineReason'))qs('adminFineReason').value='';
            toast(`💸 Штраф ${amt}₽ → ${target}`,'red');
        } else toast('Не удалось выписать штраф','red');
    } catch (error) {
        console.error('Ошибка штрафа:', error);
        const message = error.message || 'Ошибка при выполнении операции';
        toast(`❌ ${message}`,'red');
    } finally { _adminFineBusy=false; }
};
window.adminSetMigrant = async function(on){
    if(currentNick!==ADMIN) return;
    const target = qs('adminTarget').value;
    if(!target) return toast('⚠️ Выберите жителя','gold');
    if(target===ADMIN) return toast('⚠️ Нельзя применить к мэру','gold');
    const snap = await get(userRef(target));
    if(!snap.exists()) return toast('❌ Не найден','red');
    const u = snap.val() || {};
    const already = !!(u.roles && u.roles.migrant === true);
    if(on && already) return toast('✅ Уже мигрант','gold');
    if(!on && !already) return toast('✅ Роли нет','gold');
    try{
        await update(userRef(target), { roles: { ...(u.roles||{}), migrant: !!on } });
        await pushNotification(target, on
            ? `🧾 Мэрия выдала роль «${ROLE_MIGRANT}». Ограничения: без заданий/переводов/маркетплейса.`
            : `♻ Мэрия сняла роль «${ROLE_MIGRANT}».`,
            'system'
        );
        toast(on ? `🧾 ${target} теперь ${ROLE_MIGRANT}` : `♻ Роль снята: ${target}`, on ? 'red' : 'green');
    }catch(e){
        toast('❌ Не удалось обновить роль','red');
    }
};
window.adminDeleteOrder=async function(id){await remove(orderRef(id));toast('🗑 Удалено','gold');};
window.adminFireWorker=async function(){
    if(currentNick !== ADMIN) return toast('🚫 Только мэр','red');
    const target=qs('adminTarget')?.value;
    if(!target)return toast('⚠️ Выберите жителя','gold');
    if(target===currentNick)return toast('⚠️ Нельзя уволить себя','gold');
    const snap=await get(userRef(target));if(!snap.exists())return toast('❌ Не найден','red');
    const u=snap.val();

    // Собираем список должностей из employments + legacy job (без рекурсии через allBusinessesCache)
    const rawArr = Array.isArray(u.employments) ? u.employments : [];
    const seenIds = new Set(rawArr.map(e=>e&&e.id).filter(Boolean));
    const allEmps = rawArr.filter(e=>e&&e.id&&e.role).map(e=>{
        const out={id:String(e.id),type:String(e.type||'municipal'),role:String(e.role)};
        if(e.bizId!==undefined && e.bizId!==null && String(e.bizId).trim()!=='') out.bizId=String(e.bizId);
        if(e.bizName!==undefined && e.bizName!==null && String(e.bizName).trim()!=='') out.bizName=String(e.bizName);
        return out;
    });
    if(u.job && u.job !== 'Житель' && !seenIds.has(`muni_${u.job}`)){
        allEmps.push({ id:`muni_${u.job}`, type:'municipal', role:u.job });
    }
    const muniEmps = allEmps.filter(e=>e.type==='municipal');

    if(!muniEmps.length && (!u.job || u.job==='Житель')) return toast('ℹ️ У жителя нет работы','gold');

    let targetRole = null;
    if(muniEmps.length <= 1){
        targetRole = muniEmps[0]?.role || u.job;
        if(!confirm(`Уволить ${target} с должности «${targetRole}»?`)) return;
    } else {
        const list = muniEmps.map((e,i)=>`${i+1}. ${e.role}`).join('\n');
        const pick = prompt(`С какой работы уволить ${target}?\n${list}\n0 — уволить со ВСЕХ\n\nВведите номер:`);
        if(pick===null || !pick.trim()) return;
        if(pick.trim()==='0'){
            if(!confirm(`Уволить ${target} со ВСЕХ муниципальных работ?`)) return;
            const newEmps = allEmps.filter(e=>e.type!=='municipal');
            const patch = { employments: newEmps, displayJob: newEmps[0]?.role || null, job:'Житель', vehicle:'' };
            if(muniEmps.some(e => e.role === JOB_ADVERTISER)) patch.advertiserSalaryPaidThroughWeek = advertiserWeekKey();
            for(const e of muniEmps){
                if(e.role===JOB_JANITOR){ Object.assign(patch,{janitorTaskDate:'',janitorSubmissionId:'',janitorSubmissionStatus:'',janitorProof:'',janitorComment:''}); }
            }
            try {
                await update(userRef(target), patch);
                await pushNotification(target,'🚪 Мэрия уволила вас со всех работ','system');
                toast(`🚪 ${target} уволен со всех работ`,'red');
                if(typeof window.renderAdmin==='function') window.renderAdmin();
            } catch(e){ console.error('[adminFire all]',e); toast('❌ Ошибка: '+(e.message||''),'red'); }
            return;
        }
        const num = parseInt(pick,10);
        targetRole = (num>=1&&num<=muniEmps.length) ? muniEmps[num-1].role
            : muniEmps.find(e=>e.role.toLowerCase()===pick.trim().toLowerCase())?.role;
        if(!targetRole) return toast('⚠️ Работа не найдена','gold');
        if(!confirm(`Уволить ${target} с «${targetRole}»?`)) return;
    }

    try {
        const newEmps = allEmps.filter(e => !(e.type==='municipal' && e.role===targetRole));
        const newMuniHead = newEmps.find(e=>e.type==='municipal')?.role || 'Житель';
        const patch = {
            employments: newEmps,
            displayJob: newEmps.length > 0 ? newEmps[0].role : null,
            job: (u.job === targetRole || targetRole) ? newMuniHead : u.job,
        };
        if(targetRole==='Водитель'||targetRole==='Доставщик') patch.vehicle='';
        if(targetRole===JOB_ADVERTISER) patch.advertiserSalaryPaidThroughWeek = advertiserWeekKey();
        if(targetRole===JOB_JANITOR){ Object.assign(patch,{janitorTaskDate:'',janitorSubmissionId:'',janitorSubmissionStatus:'',janitorProof:'',janitorComment:''}); }
        await update(userRef(target), patch);
        await pushNotification(target,`🚪 Мэрия уволила вас с должности «${targetRole}»`,'system');
        toast(`🚪 ${target} уволен с «${targetRole}»`,'red');
        if(typeof window.renderAdmin==='function') window.renderAdmin();
    } catch(e){ console.error('[adminFire]',e); toast('❌ Ошибка: '+(e.message||''),'red'); }
};
window.adminVerifyAccount=async function(nick){
    if(!confirm(`Подтвердить аккаунт ${nick}?`))return;
    try {
        const {error}=await supabase.rpc('kp_verify_account',{p_target_nick:nick});
        if(error) throw new Error(error.message||'Ошибка подтверждения');
        if(allUsersCache?.[nick]) allUsersCache[nick].accountVerified = true;
        void pushNotification(nick,'✅ Ваш аккаунт подтверждён мэрией!','system');
        toast(`✅ Аккаунт ${nick} подтверждён`,'green');
        await renderUnverifiedAccounts();
    } catch(error) {
        console.error('[adminVerifyAccount]',error);
        toast('❌ Подтверждение отклонено сервером: '+(error?.message||'ошибка'),'red');
    }
};
window.adminDeleteAccount=async function(nick){
    if(!confirm(`Удалить аккаунт ${nick}? Это действие необратимо!`))return;
    await remove(userRef(nick));
    if(allUsersCache) delete allUsersCache[nick];
    allUsersCacheLoaded=true;
    renderHomeStats_users(allUsersCache);
    toast(`🗑 Аккаунт ${nick} удалён`,'red');
    renderUnverifiedAccounts();
};
window.renderUnverifiedAccounts=async function(){
    const el=qs('unverifiedAccounts');if(!el)return;
    // /admin's service already primes allUsersCache via loadAllUsersCache();
    // reuse it instead of a fresh full get(users) on every render.
    const all = (allUsersCacheLoaded ? allUsersCache : (await loadAllUsersCache())) || {};
    const unverified=Object.entries(all).filter(([k,u])=>u && u.accountVerified !== true);
    if(unverified.length===0){
        el.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет неподтверждённых аккаунтов</div>';
        return;
    }
    el.innerHTML=unverified.map(([nick,u])=>`
        <div style="padding:12px;border-bottom:1px solid var(--border);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div>
                    <div style="font-weight:800;">${escHtml(nick)}</div>
                    <div style="font-size:12px;color:var(--muted);">Создан: ${new Date(u.createdAt||0).toLocaleDateString('ru')}</div>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-primary btn-sm" onclick="adminVerifyAccount('${escHtml(nick)}')">✅ Подтвердить</button>
                    <button class="btn btn-red btn-sm" onclick="adminDeleteAccount('${escHtml(nick)}')">🗑 Удалить</button>
                </div>
            </div>
        </div>
    `).join('');
};

// ─── NEWS FUNCTIONS ─────────────────────────
const NEWS_CATEGORIES = {
    general: { emoji: '📢', label: 'Общее' },
    event: { emoji: '🎉', label: 'Событие' },
    alert: { emoji: '🚨', label: 'Важное' },
    update: { emoji: '🔄', label: 'Обновление' },
    meteorology: { emoji: '🌦', label: 'Метеорология' },
    announcement: { emoji: '📣', label: 'Объявление' }
};
let currentNewsTab = 'village';
let currentNewsId = null;
let currentNewsMsgListener = null;
let currentNewsReadListener = null;
let currentNewsPeerTypingListener = null;
let currentNewsMsgs = {};
let newsReadCache = {};
function newsDiscussionRef(id){ return ref(db, `newsDiscussions/${id}/messages`); }
function newsDiscussionReadRef(id, nick){ return ref(db, `newsDiscussions/${id}/lastRead/${nick}`); }
function newsReadRef(nick){ return ref(db, `users/${nick}/newsRead`); }
function canPublishNews(scope='village'){
    const me = allUsersCache[currentNick];
    if(!me) return false;
    if(currentNick === ADMIN) return true;
    if(scope === 'lands') return false;
    return me.job === JOB_JOURNALIST;
}
function isNewsRead(id){
    const me = allUsersCache[currentNick];
    return !!(me && me.newsRead && me.newsRead[id]);
}
async function markNewsRead(id){
    if(!currentNick || !id) return;
    const patch = {};
    patch[`newsRead.${id}`] = Date.now();
    try { await update(userRef(currentNick), patch); } catch(e){}
}
window.switchNewsTab = function(tab){
    currentNewsTab = tab === 'lands' ? 'lands' : 'village';
    const scopeSel = qs('newsScope');
    if(scopeSel) scopeSel.value = currentNewsTab;
    qs('newsTabVillage')?.classList.toggle('active', currentNewsTab === 'village');
    qs('newsTabLands')?.classList.toggle('active', currentNewsTab === 'lands');
    qs('newsPanelVillage')?.classList.toggle('active', currentNewsTab === 'village');
    qs('newsPanelLands')?.classList.toggle('active', currentNewsTab === 'lands');
    renderNews();
};

window.canPublishNews = canPublishNews;
window.handleNewsPhoto = async function(e){
    const file = e.target.files[0];
    if(!file) return;
    try {
        toast('📷 Сжимаем фото...', 'gold');
        const dataUrl = await compressImage(file, 1200, 0.85);
        const img = qs('newsImageImg');
        img.src = dataUrl;
        img.parentElement.style.display = 'block';
        // Store in hidden input
        window._newsPhotoData = dataUrl;
    } catch(err) {
        toast('❌ Не удалось загрузить фото', 'red');
    }
    e.target.value = '';
};

window.handleNewsVideo = async function(e){
    const file = e.target.files[0];
    if(!file) return;
    try{
        const maxMb = 500;
        if(file.size > maxMb*1024*1024){
            toast(`❌ Видео слишком большое (макс. ${maxMb} МБ)`, 'red');
            e.target.value = '';
            return;
        }
        toast('🎬 Загружаем видео в новости...', 'gold');
        const url = await uploadBlobToStorage(file, 'news/videos');
        window._newsVideoUrl = url;
        const prev = qs('newsVideoPreview');
        const vid = qs('newsVideoVid');
        if(vid){ vid.pause(); vid.removeAttribute('src'); vid.src = url; vid.load(); }
        if(prev) prev.style.display = 'block';
        toast('✅ Видео добавлено', 'green');
    }catch(err){
        console.error(err);
        toast('❌ Не удалось загрузить видео', 'red');
    }
    e.target.value = '';
};
let _publishNewsBusy = false;
window.publishNews = async function(){
    if(_publishNewsBusy) return toast('⏳ Публикация уже выполняется…','gold');
    _publishNewsBusy = true;
    try {
    const scope = qs('newsScope') ? qs('newsScope').value : currentNewsTab;
    if(!canPublishNews(scope)) return toast(scope === 'lands' ? '❌ Только Кайон может публиковать новости Капанёвских земель' : '❌ Только Кайон и Журналисты могут публиковать новости', 'red');
    const title = qs('newsTitle').value.trim();
    const content = qs('newsContent').value.trim();
    const category = qs('newsCategory').value;
    const imageUrl = window._newsPhotoData || qs('newsImage').value.trim() || null;
    const videoUrl = window._newsVideoUrl || null;
    if(!title) return toast('⚠️ Укажите заголовок новости', 'gold');
    if(!content) return toast('⚠️ Укажите текст новости', 'gold');
    const id = genId();
    const newsItem = {
        id,
        scope,
        title,
        content,
        category,
        imageUrl,
        videoUrl,
        author: currentNick,
        authorJob: getUserBusinessRoleLabel(allUsersCache[currentNick] || {}, currentNick),
        createdAt: Date.now(),
        date: new Date().toLocaleDateString('ru'),
        time: nowTime()
    };
    await set(newsItemRef(id), newsItem);
    void enqueuePushJob({type:'news',id:String(id),sender:currentNick});
    // ── Notify residents about the new post (reuses existing notifRef +
    //    Web Push/service-worker plumbing — no parallel notification system) ──
    notifyAllUsersOfNews(newsItem).catch(e=>console.error('[news notify]', e));
    toast('📰 Новость опубликована!', 'green');
    qs('newsTitle').value = '';
    qs('newsContent').value = '';
    qs('newsImage').value = '';
    window._newsPhotoData = null;
    qs('newsImagePreview').style.display = 'none';
    window._newsVideoUrl = null;
    const nvp = qs('newsVideoPreview'); if(nvp) nvp.style.display = 'none';
    const nvv = qs('newsVideoVid'); if(nvv){ nvv.pause(); nvv.removeAttribute('src'); nvv.load(); }
    const nvf = qs('newsVideoFile'); if(nvf) nvf.value = '';
    renderNews();
    } finally {
        _publishNewsBusy = false;
    }
};
// ── News notifications (Part 6): internal notification for every resident +
// best-effort remote push via an existing Cloud Function, if one is deployed
// on the backend (falls back silently to the in-app notification otherwise —
// that one always works, since it's plain Realtime Database writes). ──
async function notifyAllUsersOfNews(newsItem){
    // Notification fan-out is server-side now, triggered by /news/{newsId}.
    // This compatibility function intentionally performs no client-side fan-out.
    return newsItem?.id || null;
}

window.deleteNews = async function(id){
    if(!confirm('Удалить эту новость?')) return;
    const snap = await get(newsItemRef(id));
    if(!snap.exists()) return toast('❌ Новость не найдена', 'red');
    const item = snap.val();
    // Only author or admin can delete
    if(item.author !== currentNick && currentNick !== ADMIN) {
        return toast('❌ Только автор или Кайон может удалить новость', 'red');
    }
    await remove(newsItemRef(id));
    toast('🗑 Новость удалена', 'gold');
    renderNews();
};
let _newsRenderLimit = { village: 10, lands: 10 };
window.loadMoreNews = function(scope){
    _newsRenderLimit[scope] = (_newsRenderLimit[scope]||10) + 10;
    renderNews();
};
window.renderNews = async function(){
    const editorPanel = qs('newsEditorPanel');
    const scopeSel = qs('newsScope');
    if(scopeSel) scopeSel.value = currentNewsTab;
    if(editorPanel) {
        editorPanel.style.display = canPublishNews(currentNewsTab) ? 'block' : 'none';
    }
    const panels = {
        village: qs('newsListVillage'),
        lands: qs('newsListLands')
    };
    try {
        const snap = await get(newsRef());
        const all = snap.val() || {};
        const sorted = Object.values(all).sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
        const byScope = {
            village: sorted.filter(item => (item.scope || 'village') === 'village'),
            lands: sorted.filter(item => item.scope === 'lands')
        };
        const renderList = (fullList, scope) => {
            const el = panels[scope];
            if(!el) return;
            if(!fullList.length) {
                el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Пока нет новостей</div>';
                return;
            }
            const limit = _newsRenderLimit[scope] || 10;
            const list = fullList.slice(0, limit);
            el.innerHTML = list.map(item => {
                const catInfo = NEWS_CATEGORIES[item.category] || NEWS_CATEGORIES.general;
                const canDelete = item.author === currentNick || currentNick === ADMIN;
                const unread = !isNewsRead(item.id);
                return `<div class="news-card card" style="padding:14px;margin-bottom:12px;">
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
                        <span class="news-scope-badge">${scope === 'village' ? '🏘️ Посёлок' : '🌲 Капанёвские земли'}</span>
                        <span style="font-size:12px;background:var(--surface2);padding:4px 8px;border-radius:8px;color:var(--primary);">${catInfo.emoji} ${catInfo.label}</span>
                        <span style="font-size:11px;color:var(--muted);">${item.date} · ${item.time}</span>
                        ${unread ? '<span class="news-badge-new">Новая</span>' : ''}
                        ${canDelete ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red);" onclick="deleteNews('${jsEsc(item.id)}')">🗑</button>` : `<div style="margin-left:auto;"></div>`}
                    </div>
                    <div class="news-user-text" style="font-weight:900;font-size:15px;margin-bottom:8px;">${escHtml(item.title)}</div>
                    ${item.imageUrl ? `<img loading="lazy" decoding="async" src="${escHtml(item.imageUrl)}" style="width:100%;max-height:200px;object-fit:cover;border-radius:var(--r-sm);margin-bottom:10px;cursor:pointer;" onclick="openImgViewer('${jsEsc(item.imageUrl)}')">` : ''}
                    ${item.videoUrl ? `<div style="margin-bottom:10px;cursor:pointer;" onclick="openVideoViewer('${jsEsc(item.videoUrl)}')"><video style="width:100%;max-height:220px;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--border);background:#000;" muted playsinline preload="metadata"><source src="${escHtml(item.videoUrl)}#t=0.1"></video></div>` : ''}
                    <div class="news-user-text" style="font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;">${escHtml(item.content)}</div>
                    <div style="margin-top:10px;font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span>Автор: <b style="color:var(--text);">${escHtml(item.author)}</b>${item.authorJob && item.authorJob !== 'Житель' ? ` · ${escHtml(item.authorJob)}` : ''}</span>
                        <button type="button" class="btn btn-primary btn-sm news-discuss-btn" onclick="openNewsDiscussion('${jsEsc(item.id)}')">Открыть обсуждение</button>
                    </div>
                </div>`;
            }).join('') + (fullList.length > limit ? `<button class="btn btn-ghost" style="width:100%;margin-top:4px;" onclick="loadMoreNews('${scope}')">Показать ещё (${fullList.length - limit})</button>` : '');
        };
        renderList(byScope.village, 'village');
        renderList(byScope.lands, 'lands');
    } catch(e) {
        console.error('Error loading news:', e);
        ['newsListVillage','newsListLands'].forEach(id=>{ const el=qs(id); if(el) el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Ошибка загрузки новостей</div>'; });
    }
};

// ─── NEWS DISCUSSION ──────────────────────
function newsMsgPreview(m){
    if(m.msgType==='voice') return `🎤 ${m.nick === currentNick ? 'Вы' : (displayNick(allUsersCache[m.nick]) || m.nick)}: Голосовое сообщение`;
    if(m.msgType==='video_circle') return `⭕ ${m.nick === currentNick ? 'Вы' : (displayNick(allUsersCache[m.nick]) || m.nick)}: Видеосообщение`;
    if(m.msgType==='image') return `🖼 ${m.nick === currentNick ? 'Вы' : (displayNick(allUsersCache[m.nick]) || m.nick)}: Фото`;
    if(m.msgType==='video') return `🎬 ${m.nick === currentNick ? 'Вы' : (displayNick(allUsersCache[m.nick]) || m.nick)}: Видео`;
    const txt = (m.text || m.caption || '').trim();
    const preview = txt.length > 54 ? txt.slice(0, 51) + '...' : txt;
    return `${m.nick === currentNick ? 'Вы' : (displayNick(allUsersCache[m.nick]) || m.nick)}: ${preview}`;
}
window.openNewsDiscussion = async function(id){
    const snap = await get(newsItemRef(id));
    if(!snap.exists()) return toast('❌ Новость не найдена', 'red');
    currentNewsId = id;
    const item = snap.val();
    await markNewsRead(id);
    qs('newsDiscussionHeader').innerHTML = `
        <div class="card" style="margin-bottom:0;">
            <div class="news-discussion-meta">
                <span class="news-scope-badge">${item.scope === 'lands' ? '🌲 Капанёвские земли' : '🏘️ Посёлок'}</span>
                <span class="news-scope-badge">${(NEWS_CATEGORIES[item.category] || NEWS_CATEGORIES.general).emoji} ${(NEWS_CATEGORIES[item.category] || NEWS_CATEGORIES.general).label}</span>
                <span class="news-scope-badge">${escHtml(item.date || '')} · ${escHtml(item.time || '')}</span>
            </div>
            <div class="news-user-text" style="font-weight:900;font-size:18px;margin:10px 0 8px;">${escHtml(item.title || '')}</div>
            ${item.imageUrl ? `<img loading="lazy" decoding="async" src="${escHtml(item.imageUrl)}" style="width:100%;max-height:240px;object-fit:cover;border-radius:var(--r-sm);margin-bottom:10px;cursor:pointer;" onclick="openImgViewer('${jsEsc(item.imageUrl)}')">` : ''}
            ${item.videoUrl ? `<div style="margin-bottom:10px;cursor:pointer;" onclick="openVideoViewer('${jsEsc(item.videoUrl)}')"><video style="width:100%;max-height:260px;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--border);background:#000;" muted playsinline preload="metadata"><source src="${escHtml(item.videoUrl)}#t=0.1"></video></div>` : ''}
            <div class="news-user-text" style="font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;">${escHtml(item.content || '')}</div>
            <div style="margin-top:10px;font-size:11px;color:var(--muted);">
                Автор: <b style="color:var(--text);">${escHtml(item.author || '')}</b>${item.authorJob && item.authorJob !== 'Житель' ? ` · ${escHtml(item.authorJob)}` : ''}
            </div>
        </div>`;
    qs('newsDiscussionMeta').innerHTML = `<span class="news-scope-badge">💬 Обсуждение</span>`;
    navTo('newsDiscussion');
    attachNewsDiscussion();
};
function detachNewsDiscussion(){
    if(currentNewsMsgListener){ off(currentNewsMsgListener.ref,'value',currentNewsMsgListener.fn); currentNewsMsgListener = null; }
    if(currentNewsReadListener){ off(currentNewsReadListener.ref,'value',currentNewsReadListener.fn); currentNewsReadListener = null; }
}
function attachNewsDiscussion(){
    if(!currentNewsId) return;
    detachNewsDiscussion();
    const msgRef = newsDiscussionRef(currentNewsId);
    const msgFn = snap => {
        currentNewsMsgs = snap.val() || {};
        if(curPage === 'newsDiscussion') renderNewsDiscussionMessages(currentNewsMsgs);
    };
    onValue(msgRef, msgFn);
    currentNewsMsgListener = { ref: msgRef, fn: msgFn };
    const readRef = newsDiscussionReadRef(currentNewsId, currentNick);
    const readFn = async snap => {
        const val = snap.val() || 0;
        if(curPage === 'newsDiscussion') renderNewsDiscussionMessages(currentNewsMsgs);
        if(val < Date.now()) {
            try { await set(readRef, Date.now()); } catch(e){}
        }
    };
    onValue(readRef, readFn);
    currentNewsReadListener = { ref: readRef, fn: readFn };
}
function updateNewsDiscussionHeaderState(){
    const item = qs('newsDiscussionHeader');
    if(!item) return;
}
window.closeNewsDiscussion = function(){
    detachNewsDiscussion();
    currentNewsId = null;
    currentNewsMsgs = {};
    navTo('news');
};
window.renderNewsDiscussionMessages = function(msgs){
    const el = qs('newsDiscussionMessages');
    if(!el || !currentNewsId) return;
    const entries = Object.entries(msgs || {}).sort((a,b)=>(a[1]?.createdAt||0)-(b[1]?.createdAt||0)).slice(-100);
    const sig = entries.map(([id,m])=>`${id}:${m.createdAt||0}:${m.text||''}:${m.msgType||''}:${m.mediaData?1:0}:${m.edited?1:0}`).join('|') + '|r:' + JSON.stringify(chatReadStates || {});
    if(el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    let lastDateStr = '';
    el.innerHTML = entries.map(([msgId, m]) => {
        const isMe = m.nick === currentNick;
        const edited = m.edited ? `<span style="font-size:9px;color:var(--muted);margin-left:4px;">(изм.)</span>` : '';
        const ts = m.createdAt || 0;
        const msgDateStr = ts ? new Date(ts).toLocaleDateString('ru', {day:'numeric',month:'long',year:'numeric'}) : '';
        let separator = '';
        if(msgDateStr && msgDateStr !== lastDateStr){ lastDateStr = msgDateStr; separator = `<div class="chat-date-separator"><span>${msgDateStr}</span></div>`; }
        const avSrc = safeAvatar(m.nick, m.avatar);
        return separator + `<div class="chat-msg ${isMe ? 'me' : ''}" data-msgid="${jsEsc(msgId)}">
            <div style="position:relative;display:inline-block;">
                <img class="chat-av" src="${escHtml(avSrc)}" style="cursor:pointer;" loading="lazy" onclick="openImgViewer(this.src)" onerror="this.src='${DEFAULT_AVATAR_URL}'">
            </div>
            <div class="chat-msg-body">
                ${!isMe ? `<div class="chat-sender" style="cursor:pointer;" onclick="openUserProfile('${jsEsc(m.nick)}')">${escHtml(displayNick(allUsersCache[m.nick]) || m.nick)}</div>` : ''}
                <div class="chat-bubble" id="newsbubble_${jsEsc(msgId)}">
                    <div onclick="event.stopPropagation()">${mediaHtml(m)}</div>${edited}
                    <div class="chat-time">${escHtml(m.time||'')}</div>
                </div>
                ${msgActionsHtml('news', msgId, m, isMe)}
                ${msgEditHtml('news', msgId, m)}
            </div>
        </div>`;
    }).join('');
};
window.sendNewsMsg = async function(){
    const inp = qs('newsInput');
    const text = (inp?.value || '').trim();
    if(!currentNewsId || (!text && !getPendingPhotos('news').length)) return;
    if(text) inp.value = '';
    setNewsTypingState('idle');
    await sendNewsDiscussionMsg(text, null, null);
};
window.sendNewsDiscussionMsg = async function(text, mediaData, msgType){
    if(!currentNewsId) return;
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val();
    const msg = { nick: currentNick, avatar: u?.avatar || DEFAULT_AVATAR_URL, time: nowTime(), createdAt: Date.now() };
    if(text) { msg.text = text; if(mediaData) msg.caption = text; }
    if(mediaData) msg.mediaData = mediaData;
    if(msgType) msg.msgType = msgType;
    await push(newsDiscussionRef(currentNewsId), msg);
};
window.deleteNewsMsg = async function(msgId){
    try {
        await remove(ref(db, `newsDiscussions/${currentNewsId}/messages/${msgId}`));
        if(currentNewsMsgs && currentNewsMsgs[msgId]) delete currentNewsMsgs[msgId];
        if(curPage === 'newsDiscussion') renderNewsDiscussionMessages(currentNewsMsgs);
    } catch(e){ toast('❌ Не удалось удалить сообщение', 'red'); }
};
window.startEditNews = function(msgId, oldText){
    const actions = qs(`newsactions_${msgId}`); if(actions) actions.style.display='none';
    const area = qs(`newsedit_${msgId}`); if(area) area.style.display='block';
    const ta = qs(`newseditText_${msgId}`);
    if(ta){ ta.value = oldText.replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'); ta.focus(); }
};
window.cancelEditNews = function(msgId){ const area = qs(`newsedit_${msgId}`); if(area) area.style.display='none'; };
window.saveEditNews = async function(msgId){
    const ta = qs(`newseditText_${msgId}`); const newText = ta ? ta.value.trim() : '';
    if(!newText) return;
    await update(ref(db, `newsDiscussions/${currentNewsId}/messages/${msgId}`), { text: newText, edited: true });
    const area = qs(`newsedit_${msgId}`); if(area) area.style.display='none';
};
window.onNewsInputTyping = function(){ /* intentionally quiet */ };

const bnMap={home:0,messages:1,market:2,tasks:3,bank:4,news:5,subscription:6,profile:7,janitorPage:8,businesses:9,bizDetail:9,bizOwnerPanel:9,rentBuildings:10,events:0,eventDetail:0,kveExam:11,deputySession:0,deliveryOrderPage:0,kEducation:0,casino:0};

// ─── LIVE TASKS REFRESH ──────────────────
let _taskLiveUnsubs=[];
let _taskLiveTimer=null;
let _taskLiveRendering=false;
function scheduleTaskLiveRefresh(){
    if(curPage!=='tasks') return;
    clearTimeout(_taskLiveTimer);
    _taskLiveTimer=setTimeout(async()=>{
        if(curPage!=='tasks' || _taskLiveRendering) return;
        _taskLiveRendering=true;
        try{ await renderTasks(); }catch(e){ console.warn('[Kapani] live tasks refresh:',e); }
        finally{ _taskLiveRendering=false; }
    },120);
}
function stopTaskLiveListeners(){
    _taskLiveUnsubs.splice(0).forEach(fn=>{try{fn();}catch(e){}});
    clearTimeout(_taskLiveTimer); _taskLiveTimer=null;
}
function startTaskLiveListeners(){
    stopTaskLiveListeners();
    if(!currentNick || curPage!=='tasks') return;
    // Only subscribe to data that can affect today's task set. Large global
    // branches are filtered by the current user's nick where possible.
    const u = allUsersCache?.[currentNick] || {};
    const daily = getDailyTasksForToday() || [];
    const prime = (u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date()) ? (getPrimeDailyTasksForToday() || []) : [];
    const ids = new Set([...daily,...prime].map(t=>t.id));
    const targets=[];
    if(ids.has('taxi_req') || ids.has('shop') || ids.has('prime_taxi2') || ids.has('prime_shop_big') || !u.rewardedTaxi)
        targets.push(query(ordersRef(), orderByChild('client'), equalTo(currentNick)));
    if(ids.has('prime_listing') || !u.rewardedListing)
        targets.push(query(marketRef(), orderByChild('seller'), equalTo(currentNick)));
    if(ids.has('chat') || ids.has('prime_chat5'))
        targets.push(query(chatRef(), orderByChild('nick'), equalTo(currentNick)));
    if(ids.has('wall')) targets.push(wallRef(currentNick));
    if(ids.has('transfer') || ids.has('prime_transfer_big')) targets.push(txLogRef(currentNick));
    if(ids.has('shop')) targets.push(query(deliveryCustomOrdersRef(), orderByChild('client'), equalTo(currentNick)));
    if(!targets.length){ scheduleTaskLiveRefresh(); return; }
    targets.forEach(target=>{
        const fn=()=>scheduleTaskLiveRefresh();
        try{onValue(target,fn);_taskLiveUnsubs.push(()=>off(target,'value',fn));}catch(e){console.warn('[Kapani] task listener:',e);}
    });
    // The user's own listener handles taskBalance and reward flags.
    scheduleTaskLiveRefresh();
}
window.navTo=function(id){
    if(id==='adminPage' && currentNick!==ADMIN){ toast('Раздел доступен только мэру','red'); return; }
    const previousPage=curPage;
    if(previousPage && previousPage!==id){
        leaveService(previousPage);
        try{ detachLivePage(previousPage); }catch(e){}
    }
    document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
    const el=qs(id);if(el){el.classList.add('active');curPage=id;}
    for(let i=0;i<12;i++){const b=qs('bn'+i);if(b)b.classList.toggle('sel',bnMap[id]===i);}
    unlockBodyScroll(true); window.scrollTo(0,0);
    if(el){requestAnimationFrame(()=>{void el.offsetHeight;el.style.pointerEvents='';});}
    enterService(id);
    try{ attachLivePage(id); }catch(e){ console.debug('[Kapani live] attach:',e?.message||e); }
    if(id==='adminPage') { window.mountMayorDashboard?.(); renderAdmin(); setTimeout(renderAdminAdvertiserStats,50); }
    if(id==='kveExam') renderKveSection();
    if(id==='jobs') renderKveSection();
    if(id==='driverPage'||id==='deliveryPage') get(ordersRef()).then(s=>renderWorkerPage(s.val()||{}));
    if(id==='messages'){ const chatHost=qs('chatMessages');if(chatHost&&!chatHost.innerHTML.trim())chatHost.innerHTML=loadingHtml('Загрузка чата...');const dmHost=qs('dmMessages');if(dmHost&&currentDmNick&&!dmHost.innerHTML.trim())dmHost.innerHTML=loadingHtml('Загрузка сообщений...');chatLoading=true; }
    if(id==='profile'){
        updatePushSettingsUI();
        if(window._kapaniNotificationsCache) renderNotifications(window._kapaniNotificationsCache);
        ensureKapaniServerSessionForCurrentUser(5000)
          .then(()=>get(notifRef(currentNick)))
          .then(s=>{
              const value=s.val()||{};
              window._kapaniNotificationsCache=value;
              updateBadge(Object.keys(value).length);
              renderNotifications(value);
          })
          .catch(e=>console.warn('[Kapani] notifications load:',e?.message||e));
        get(wallRef(currentNick)).then(s=>renderWallFeed(s.val()||{}));
        buildWallEmojiIfNeeded();
    }
    if(id==='market') renderDebtNotice('marketDebtNotice',allUsersCache[currentNick]||{});
    if(id==='bank'){renderRecentTransfers();renderFinancialStats();renderSavingsDisplay();}
    if(id==='subscription') renderSubscription();
    if(id==='home') renderHomeBizOrders();
    if(id==='rentBuildings') renderRentBuildings();
    if(id==='tasks'){ /* task service schedules the initial render */ }
    if(id==='jobs'){renderJobAppStatus();renderHospitalJobsCard();setTimeout(renderAdvertiserWorkStats,50);}
    if(id==='hospital') renderHospital();
    if(id==='hospitalPanel') renderHospitalPanel();
    if(id==='news'){currentNewsTab=currentNewsTab||'village';renderNews();}
    if(id==='newsDiscussion'){const e=qs('newsDiscussionMessages');if(e)renderNewsDiscussionMessages(currentNewsMsgs);}
    if(id==='taxi'){renderDebtNotice('taxiDebtNotice',allUsersCache[currentNick]||{});Promise.resolve(window.initTaxiMap?.()).catch(e=>toast('❌ Не удалось загрузить карту','red'));}
    if(id==='taxi') renderTaxiHistory();
    if(id==='driverPage') setTimeout(()=>{if(driverTrackMapObj)driverTrackMapObj.invalidateSize();},450);
    if(id==='janitorPage') renderJanitorPage();
    if(id==='businesses') renderBusinesses();
    if(id==='bizOwnerPanel') renderBizOwnerPanel();
    if(id==='deputySession') renderDeputyProposals();
    if(id==='dutyPage'){startCallsListener();renderDutyCalls(_lastCalls);}
    if(id==='deliveryOrderPage'){renderMyDeliveryOrders();if(typeof renderDeliveryOrderOptions==='function')renderDeliveryOrderOptions(true);else updateDeliverySourceHint();}
    if(id==='events') renderEventsSection();
    if(id==='kEducation' && typeof window.kapaniRenderKEducation==='function' && !window._kapaniEconomyNavHandlesRender) window.kapaniRenderKEducation();
    if(id==='casino' && typeof window.kapaniRenderCasino==='function' && !window._kapaniEconomyNavHandlesRender) window.kapaniRenderCasino();
    if(id==='gameSpySection') initSpyGame();
    if(id==='gameMafiaSection') initMafiaGame();
    if(id==='gameMatch3Section') initMatch3();
    if(id==='gameDuelSection') initDuelGame();
    if(id==='gameAbandonedSection') initAbandonedGame();
    if(id==='gameTowerSection') initTowerGame();
    if(id==='gameWordleSection') initWordleGame();
    if(id==='gameReactionSection') initReactionGame();
    if(id==='game2048Section') init2048Game();
    if(id==='gameSnakeSection') initSnakeGame();
};
// ══════════════════════════════════════════════════════════════════
// 🎮 БИБЛИОТЕКА ИГР
// ══════════════════════════════════════════════════════════════════
const GAMES_CATALOG = [
  { id:'spy',       icon:'🕵️', name:'Кто шпион?',              price:50,  desc:'Найди шпиона среди друзей',        section:'gameSpySection',   canEarn:false },
  { id:'mafia',     icon:'🃏', name:'Мафия',                    price:109, desc:'Мирные жители против мафии',        section:'gameMafiaSection',  canEarn:false },
  { id:'match3',    icon:'💎', name:'Три в ряд',               price:79,  desc:'Собирай комбо, набирай очки',       section:'gameMatch3Section', canEarn:false },
  { id:'duel',      icon:'⚔️', name:'Дуэли',                   price:49,  desc:'КНБ или крестики-нолики на рубли',  section:'gameDuelSection',   canEarn:true  },
  { id:'abandoned', icon:'🏚️', name:'Заброшка',                price:89,  desc:'Ищи хабар, беги от гопников',      section:'gameAbandonedSection', canEarn:true },
  { id:'tower',     icon:'🏗️', name:'Башня Капани',            price:59,  desc:'Ставь блоки на лету — не промахнись!', section:'gameTowerSection', canEarn:false },
  { id:'wordle',    icon:'🔤', name:'Угадай слово',             price:39,  desc:'4–5 букв, 6 попыток, русские слова', section:'gameWordleSection', canEarn:false },
  { id:'reaction',  icon:'⚡', name:'Реакция',                  price:29,  desc:'Кто быстрее нажмёт? Рекорды в рейтинг', section:'gameReactionSection', canEarn:false },
  { id:'game2048',  icon:'🔢', name:'2048',                     price:39,  desc:'Складывай плитки до числа 2048',    section:'game2048Section',   canEarn:false },
  { id:'snake',     icon:'🐍', name:'Змейка',                   price:29,  desc:'Классическая змейка — собирай еду', section:'gameSnakeSection',  canEarn:false },
];



const ALL_ACHIEVEMENTS = [
  { id:'match3_first',   game:'match3',    icon:'💎', name:'Первый матч',       desc:'Сыграй в Три в ряд впервые' },
  { id:'match3_100',     game:'match3',    icon:'🌟', name:'Сотня очков',       desc:'Набери 100+ очков' },
  { id:'match3_500',     game:'match3',    icon:'🏆', name:'Мастер матча',      desc:'Набери 500+ очков за игру' },
  { id:'match3_combo',   game:'match3',    icon:'🔥', name:'Комбо!',            desc:'Сделай комбо x3' },
  { id:'match3_1000',    game:'match3',    icon:'🌈', name:'Легенда матча',     desc:'Набери 1000+ очков за игру' },
  { id:'spy_first',      game:'spy',       icon:'🕵️', name:'Первый шпион',      desc:'Запусти игру Кто шпион?' },
  { id:'spy_5games',     game:'spy',       icon:'🔍', name:'Детектив',          desc:'Запусти 5 игр Кто шпион?' },
  { id:'mafia_first',    game:'mafia',     icon:'🃏', name:'В Мафию!',          desc:'Раздай роли в Мафии' },
  { id:'mafia_5games',   game:'mafia',     icon:'🎭', name:'Дон Корлеоне',      desc:'Сыграй 5 раз в Мафию' },
  { id:'duel_first',     game:'duel',      icon:'⚔️', name:'Первая дуэль',      desc:'Сыграй в дуэль' },
  { id:'duel_win',       game:'duel',      icon:'🥇', name:'Дуэлянт',          desc:'Победи в дуэли' },
  { id:'duel_win5',      game:'duel',      icon:'🏅', name:'Непобедимый',       desc:'Победи в 5 дуэлях' },
  { id:'duel_highstake', game:'duel',      icon:'💸', name:'Большая игра',      desc:'Поставь 50₽+ в дуэли' },
  { id:'abandoned_first',game:'abandoned', icon:'🏚️', name:'Исследователь',     desc:'Открой первую клетку' },
  { id:'abandoned_gold', game:'abandoned', icon:'💰', name:'Кладоискатель',     desc:'Найди крупный куш' },
  { id:'abandoned_clear',game:'abandoned', icon:'🗺️', name:'Выжил!',           desc:'Пройди поле без потерь от гопников' },
  { id:'abandoned_bomb', game:'abandoned', icon:'💣', name:'Сапёр',             desc:'Используй бомбу в Заброшке' },
  { id:'abandoned_rich', game:'abandoned', icon:'🤑', name:'Барыга',            desc:'Найди 200₽+ за одну экспедицию' },
  { id:'tower_first',    game:'tower',     icon:'🏗️', name:'Строитель',        desc:'Поставь первый блок' },
  { id:'tower_10',       game:'tower',     icon:'🏙️', name:'Небоскрёб',        desc:'Поставь 10 блоков подряд' },
  { id:'tower_perfect',  game:'tower',     icon:'✨', name:'Идеальная стопка', desc:'Поставь 3 блока идеально' },
  { id:'tower_20',       game:'tower',     icon:'🚀', name:'До облаков',        desc:'Поставь 20 блоков подряд' },
  { id:'wordle_first',   game:'wordle',    icon:'🔤', name:'Первое слово',      desc:'Угадай любое слово' },
  { id:'wordle_fast',    game:'wordle',    icon:'⚡', name:'С первого раза',    desc:'Угадай слово с 1-й попытки' },
  { id:'wordle_hard',    game:'wordle',    icon:'🎯', name:'Знаток языка',      desc:'Угадай 5-буквенное слово' },
  { id:'wordle_10',      game:'wordle',    icon:'📚', name:'Эрудит',            desc:'Угадай 10 слов' },
  { id:'buyer_all',      game:'all',       icon:'🛒', name:'Коллекционер',      desc:'Купи все игры' },
  { id:'rich_500',       game:'all',       icon:'💵', name:'Богач',             desc:'Достигни баланса 500₽' },
  { id:'rich_1000',      game:'all',       icon:'💎', name:'Миллионер',         desc:'Достигни баланса 1000₽' },
  { id:'gamer',          game:'all',       icon:'🎮', name:'Геймер',            desc:'Сыграй в 3 разные игры' },
];

let achievementsViewNick = null;
let achievementsReturnPage = 'profile';

async function recordGameStart(gameId){
  try{
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const stats = u.gameStats || {};
    const played = Array.isArray(stats.playedGames) ? stats.playedGames.slice() : [];
    if(!played.includes(gameId)){
      played.push(gameId);
      await update(userRef(currentNick), {'gameStats/playedGames': played});
      if(played.length >= 3) unlockAchievement('gamer');
    }
  }catch(err){
    console.warn('recordGameStart failed', err);
  }
}

async function bumpGameCounter(counterKey, achId, threshold){
  try{
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const stats = u.gameStats || {};
    const value = (stats[counterKey] || 0) + 1;
    await update(userRef(currentNick), {[`gameStats/${counterKey}`]: value});
    if(threshold && value >= threshold) unlockAchievement(achId);
  }catch(err){
    console.warn('bumpGameCounter failed', err);
  }
}

async function checkBalanceAchievements(nick=currentNick){
  try{
    const snap = await get(userRef(nick));
    const u = snap.val() || {};
    const bal = u.balance || 0;
    if(bal >= 500) unlockAchievement('rich_500');
    if(bal >= 1000) unlockAchievement('rich_1000');
  }catch(err){
    console.warn('checkBalanceAchievements failed', err);
  }
}

async function renderAchievements(nick=currentNick){
  const snap = await get(userRef(nick));
  const u = snap.val() || {};
  const ach = u.achievements || {};
  const html = ALL_ACHIEVEMENTS.map(a=>{
    const unlocked = !!ach[a.id];
    return `<div style="background:${unlocked?'var(--pri-dim)':'var(--surface2)'};border:1px solid ${unlocked?'rgba(240,68,74,.3)':'var(--border)'};border-radius:var(--r-sm);padding:10px 8px;text-align:center;opacity:${unlocked?'1':'.45'};">
      <div style="font-size:22px;margin-bottom:4px;">${a.icon}</div>
      <div style="font-size:11px;font-weight:900;line-height:1.2;">${a.name}</div>
      <div style="font-size:9px;color:var(--muted);margin-top:2px;line-height:1.3;">${a.desc}</div>
      ${unlocked?`<div style="font-size:9px;color:var(--primary);margin-top:3px;font-weight:800;">✅ Выполнено</div>`:''}
    </div>`;
  }).join('');
  const grid1 = document.getElementById('achievementsList');
  const grid2 = document.getElementById('achievementsListPage');
  if(grid1) grid1.innerHTML = html;
  if(grid2) grid2.innerHTML = html;
  const title = document.getElementById('achievementsTitle');
  if(title) title.textContent = nick===currentNick ? '🏅 Достижения' : `🏅 Достижения: @${nick}`;
  const owned = u.ownedGames || {};
  if(GAMES_CATALOG.every(g=>owned[g.id])) unlockAchievement('buyer_all');
  if(nick === currentNick) await checkBalanceAchievements(nick);
}

window.openAchievementsPage = async function(nick, backPage){
  achievementsViewNick = nick || currentNick;
  achievementsReturnPage = backPage || (achievementsViewNick === currentNick ? 'profile' : 'visitorProfile');
  await renderAchievements(achievementsViewNick);
  navTo('achievementsPage');
};

window.closeAchievementsPage = function(){
  navTo(achievementsReturnPage || 'profile');
};

async function renderGamesLibrary(){
  const snap = await get(userRef(currentNick));
  const u = snap.val()||{};
  const bal = u.balance||0;
  const owned = u.ownedGames||{};
  const balEl = document.getElementById('gamesBalDisplay');
  if(balEl) balEl.textContent = bal.toLocaleString()+'₽';
  const grid = document.getElementById('gamesGrid');
  if(!grid) return;
  grid.innerHTML = GAMES_CATALOG.map(g=>{
    const isOwned = !!owned[g.id];
    const earnBadge = g.canEarn ? `<div style="display:inline-flex;align-items:center;gap:4px;background:linear-gradient(135deg,rgba(255,128,106,.2),rgba(255,128,106,.08));border:1px solid rgba(255,128,106,.4);border-radius:8px;padding:3px 7px;font-size:9px;font-weight:900;color:var(--gold);margin-bottom:6px;">🪙 МОЖНО ЗАРАБОТАТЬ!</div>` : '';
    return `<div class="card" style="margin:0;text-align:center;padding:16px 10px;cursor:${isOwned?'pointer':'default'};${isOwned?'border-color:rgba(240,68,74,.3);':''}" ${isOwned?`onclick="navTo('${g.section}')"`:''}>
      <div style="font-size:32px;margin-bottom:6px;">${g.icon}</div>
      <div style="font-weight:900;font-size:13px;margin-bottom:3px;">${g.name}</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:6px;line-height:1.3;">${g.desc}</div>
      ${earnBadge}
      ${isOwned
        ? `<div style="background:var(--pri-dim);color:var(--primary);border:1px solid rgba(240,68,74,.3);border-radius:10px;padding:5px 8px;font-size:11px;font-weight:900;margin-bottom:6px;">✅ Куплено</div>
           <button class="btn btn-primary btn-sm" style="width:100%;font-size:11px;" onclick="event.stopPropagation();navTo('${g.section}')">Играть →</button>`
        : `<div style="font-size:17px;font-weight:900;color:var(--gold);margin-bottom:6px;">${g.price}₽</div>
           <button class="btn btn-gold btn-sm" style="width:100%;font-size:11px;" onclick="buyGame('${g.id}')">Купить</button>`
      }
    </div>`;
  }).join('');
}

window.buyGame = async function(gameId){
  const g = GAMES_CATALOG.find(x=>x.id===gameId); if(!g) return;
  const snap = await get(userRef(currentNick));
  const u = snap.val()||{};
  if((u.balance||0)<g.price) return toast(`❌ Недостаточно рублей. Нужно ${g.price}₽`,'red');
  const owned = u.ownedGames||{};
  if(owned[gameId]) return toast('✅ Игра уже куплена','gold');
  owned[gameId]=true;
  await update(userRef(currentNick),{balance:(u.balance||0)-g.price, ownedGames:owned});
  await logTx(currentNick,{type:'out',who:'Магазин игр',amt:g.price,desc:`Покупка игры «${g.name}»`});
  toast(`🎮 «${g.name}» куплена!`,'green');
  renderGamesLibrary();
  if(GAMES_CATALOG.every(x=>(u.ownedGames||{})[x.id]||x.id===gameId)) unlockAchievement('buyer_all');
};

async function checkGameOwned(gameId){
  const snap = await get(userRef(currentNick));
  return !!((snap.val()||{}).ownedGames||{})[gameId];
}

function gameLockedHTML(gameId, price){
  return `<div style="text-align:center;padding:24px 0;"><div style="font-size:44px;margin-bottom:12px;">🔒</div><div style="color:var(--muted);margin-bottom:16px;font-size:14px;">Купите игру, чтобы играть</div><button class="btn btn-gold" onclick="buyGame('${gameId}');setTimeout(()=>navTo('games'),600)">Купить за ${price}₽</button></div>`;
}

// ──────────────────────────────────────────────
// 🕵️ КТО ШПИОН?
// ──────────────────────────────────────────────
const SPY_LOCATIONS = [
  'Пляж','Казино','Больница','Школа','Банк','Ресторан','Кинотеатр','Церковь','Тюрьма','Аэропорт',
  'Поезд','Военная база','Спа-салон','Цирк','Посольство','Ночной клуб','Театр','Пиратский корабль',
  'Подводная лодка','Зоопарк','Библиотека','Супермаркет','Стадион','Больница'
];
async function initSpyGame(){
  const owned = await checkGameOwned('spy');
  const area = document.getElementById('spyGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('spy',50); return; }
  unlockAchievement('spy_first');
  await recordGameStart('spy');
  area.innerHTML=`
    <div class="card-title">Настройка игры</div>
    <label style="font-size:12px;font-weight:800;color:var(--muted);">Количество игроков</label>
    <input type="number" id="spyPlayerCount" value="4" min="3" max="12" style="margin-bottom:6px;">
    <label style="font-size:12px;font-weight:800;color:var(--muted);">Количество шпионов</label>
    <input type="number" id="spySpyCount" value="1" min="1" max="2" style="margin-bottom:10px;">
    <button class="btn btn-primary" onclick="startSpyGame()">🕵️ Начать игру</button>
    <div id="spyCardsArea" style="margin-top:16px;"></div>
  `;
  const controls=area.querySelectorAll('button[onclick]');
  controls.forEach(btn=>btn.type='button');
}
window.startSpyGame = async function(){
  const n=parseInt(document.getElementById('spyPlayerCount')?.value||4);
  const s=parseInt(document.getElementById('spySpyCount')?.value||1);
  if(s>=n) return toast('❌ Шпионов не может быть больше игроков','red');
  const loc=SPY_LOCATIONS[Math.floor(Math.random()*SPY_LOCATIONS.length)];
  const roles=Array(s).fill('spy').concat(Array(n-s).fill('civ'));
  roles.sort(()=>Math.random()-.5);
  const area=document.getElementById('spyCardsArea'); if(!area) return;
  await bumpGameCounter('spyGames','spy_5games',5);
  area.innerHTML=`<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Передавайте телефон по очереди — каждый нажимает на свою карточку</div>`
    +roles.map((r,i)=>`
    <div id="spyCard${i}" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;margin-bottom:8px;cursor:pointer;text-align:center;" onclick="revealSpyCard(${i},'${r}','${r==='spy'?'???':loc}')">
      <div style="font-size:15px;font-weight:900;">Игрок ${i+1}</div>
      <div style="font-size:12px;color:var(--primary);margin-top:4px;">Нажмите, чтобы увидеть роль</div>
    </div>`).join('');
};
window.revealSpyCard = function(i,role,loc){
  const card=document.getElementById(`spyCard${i}`); if(!card) return;
  const isSpy=role==='spy';
  card.innerHTML=`
    <div style="font-size:28px;margin-bottom:6px;">${isSpy?'🕵️':'🏘️'}</div>
    <div style="font-size:16px;font-weight:900;color:${isSpy?'var(--red)':'var(--primary)'};">${isSpy?'Шпион':'Житель'}</div>
    <div style="font-size:14px;margin-top:6px;">Локация: <b>${loc}</b></div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;">Нажми снова, чтобы скрыть</div>
  `;
  card.onclick=()=>{card.innerHTML=`<div style="font-size:15px;font-weight:900;">Игрок ${i+1}</div><div style="font-size:12px;color:var(--primary);margin-top:4px;">✅ Просмотрено</div>`;card.onclick=null;card.style.opacity='.5';};
};

// ──────────────────────────────────────────────
// 🃏 МАФИЯ
// ──────────────────────────────────────────────
const MAFIA_ROLES_POOL=[
  {id:'mafia',label:'Мафия',icon:'🔫',desc:'Ночью убивает мирного жителя'},
  {id:'don',label:'Дон мафии',icon:'💼',desc:'Главарь. Ночью проверяет комиссара'},
  {id:'doctor',label:'Доктор',icon:'💊',desc:'Ночью лечит одного игрока'},
  {id:'sheriff',label:'Комиссар',icon:'🛡',desc:'Ночью проверяет одного игрока'},
  {id:'civilian',label:'Мирный житель',icon:'👤',desc:'Голосует за подозреваемых'},
];
async function initMafiaGame(){
  const owned=await checkGameOwned('mafia');
  const area=document.getElementById('mafiaGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('mafia',109); return; }
  await recordGameStart('mafia');
  area.innerHTML=`
    <div class="card-title">Настройка игры</div>
    <label style="font-size:12px;font-weight:800;color:var(--muted);">Количество игроков (4–12)</label>
    <input type="number" id="mafiaCount" value="6" min="4" max="12" style="margin-bottom:4px;">
    <div id="mafiaRoleSuggestion" style="font-size:11px;color:var(--primary);margin-bottom:10px;"></div>
    <button class="btn btn-primary" onclick="startMafiaGame()">🃏 Раздать роли</button>
    <div id="mafiaCardsArea" style="margin-top:16px;"></div>
  `;
  document.getElementById('mafiaCount')?.addEventListener('input',updateMafiaRoleSuggestion);
  updateMafiaRoleSuggestion();
}
function updateMafiaRoleSuggestion(){
  const n=parseInt(document.getElementById('mafiaCount')?.value||6);
  const el=document.getElementById('mafiaRoleSuggestion'); if(!el) return;
  const mc=Math.max(1,Math.floor(n/3));
  let r=[];
  if(n>=6){r.push('Дон мафии');r.push(...Array(mc-1).fill('Мафия'));}else r.push(...Array(mc).fill('Мафия'));
  if(n>=5)r.push('Доктор');if(n>=7)r.push('Комиссар');
  while(r.length<n)r.push('Мирный');
  el.textContent=`Состав: ${r.join(', ')}`;
}
window.startMafiaGame=async function(){
  const n=parseInt(document.getElementById('mafiaCount')?.value||6);
  if(n<4||n>12) return toast('❌ От 4 до 12 игроков','red');
  const mc=Math.max(1,Math.floor(n/3));
  let roles=[];
  if(n>=6){roles.push(MAFIA_ROLES_POOL[1]);roles.push(...Array(mc-1).fill(MAFIA_ROLES_POOL[0]));}
  else roles.push(...Array(mc).fill(MAFIA_ROLES_POOL[0]));
  if(n>=5)roles.push(MAFIA_ROLES_POOL[2]);if(n>=7)roles.push(MAFIA_ROLES_POOL[3]);
  while(roles.length<n)roles.push(MAFIA_ROLES_POOL[4]);
  roles.sort(()=>Math.random()-.5);
  unlockAchievement('mafia_first');
  const area=document.getElementById('mafiaCardsArea'); if(!area) return;
  await bumpGameCounter('mafiaGames','mafia_5games',5);
  area.innerHTML=`<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Передавайте телефон по очереди</div>`
    +roles.map((r,i)=>`
    <div id="mafiaCard${i}" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;margin-bottom:8px;cursor:pointer;text-align:center;" onclick="revealMafiaCard(${i},'${r.id}')">
      <div style="font-size:15px;font-weight:900;">Игрок ${i+1}</div>
      <div style="font-size:12px;color:var(--primary);margin-top:4px;">Нажмите для просмотра роли</div>
    </div>`).join('');
  window._mafiaRoles=roles;
};
window.revealMafiaCard=function(i,roleId){
  const r=MAFIA_ROLES_POOL.find(x=>x.id===roleId); if(!r) return;
  const card=document.getElementById(`mafiaCard${i}`); if(!card) return;
  const isMafia=roleId==='mafia'||roleId==='don';
  card.innerHTML=`<div style="font-size:28px;margin-bottom:6px;">${r.icon}</div>
    <div style="font-size:16px;font-weight:900;color:${isMafia?'var(--red)':'var(--primary)'};">${r.label}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:4px;">${r.desc}</div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;">Нажми снова чтобы скрыть</div>`;
  card.onclick=()=>{card.innerHTML=`<div style="font-size:15px;font-weight:900;">Игрок ${i+1}</div><div style="font-size:12px;color:var(--primary);margin-top:4px;">✅ Просмотрено</div>`;card.onclick=null;card.style.opacity='.5';};
};

// ──────────────────────────────────────────────
// 💎 ТРИ В РЯД (переработанная версия)
// ──────────────────────────────────────────────
const M3_GEMS=['💎','🔥','⚡','🍀','💜','🌸'];
const M3_COLS=6,M3_ROWS=6,M3_INIT_MOVES=20;
let m3Board=[],m3Score=0,m3Moves=M3_INIT_MOVES,m3Selected=null,m3Active=false,m3Combo=1,m3Processing=false;
let m3HintCells=[];

const m3Sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function initMatch3(){
  const owned=await checkGameOwned('match3');
  if(!owned){
    const sec=document.getElementById('gameMatch3Section');
    if(sec){const c=sec.querySelector('.card');if(c)c.innerHTML=`<button class="btn btn-ghost btn-sm" onclick="navTo('games')" style="width:auto;margin-bottom:14px;">← Назад</button>`+gameLockedHTML('match3',79);}
    return;
  }
  unlockAchievement('match3_first');
  updateMatch3BalDisplay();
  match3NewGame();
}

async function updateMatch3BalDisplay(){
  const snap=await get(userRef(currentNick));
  const u=snap.val()||{};
  const el=document.getElementById('match3BalRow');
  if(el) el.textContent=`Баланс: ${(u.balance||0).toLocaleString()}₽`;
}

window.match3NewGame=function(){
  m3Score=0;
  m3Moves=M3_INIT_MOVES;
  m3Selected=null;
  m3Active=true;
  m3Combo=1;
  m3Processing=false;
  m3HintCells=[];
  do{
    m3Board=Array.from({length:M3_ROWS},()=>Array.from({length:M3_COLS},()=>M3_GEMS[Math.floor(Math.random()*M3_GEMS.length)]));
  } while(!m3HasMoves());
  renderMatch3();
};

function m3HasMoves(){
  for(let r=0;r<M3_ROWS;r++){
    for(let c=0;c<M3_COLS;c++){
      if(c<M3_COLS-1){
        [m3Board[r][c],m3Board[r][c+1]]=[m3Board[r][c+1],m3Board[r][c]];
        const h=!!m3FindMatches();
        [m3Board[r][c],m3Board[r][c+1]]=[m3Board[r][c+1],m3Board[r][c]];
        if(h) return true;
      }
      if(r<M3_ROWS-1){
        [m3Board[r][c],m3Board[r+1][c]]=[m3Board[r+1][c],m3Board[r][c]];
        const h=!!m3FindMatches();
        [m3Board[r][c],m3Board[r+1][c]]=[m3Board[r+1][c],m3Board[r][c]];
        if(h) return true;
      }
    }
  }
  return false;
}

function renderMatch3(){
  const board=document.getElementById('match3Board'); if(!board) return;
  const scoreEl=document.getElementById('m3Score');
  const movesEl=document.getElementById('m3Moves');
  const comboEl=document.getElementById('m3Combo');
  if(scoreEl) scoreEl.textContent=m3Score;
  if(movesEl) movesEl.textContent=m3Moves;
  if(comboEl){comboEl.textContent=`x${m3Combo}`;comboEl.style.color=m3Combo>=3?'var(--gold)':m3Combo>=2?'var(--primary)':'var(--red)';}
  board.innerHTML='';
  for(let r=0;r<M3_ROWS;r++){
    for(let c=0;c<M3_COLS;c++){
      const cell=document.createElement('div');
      cell.className='m3cell';
      const isSel=m3Selected&&m3Selected[0]===r&&m3Selected[1]===c;
      const isHint=m3HintCells.some(([hr,hc])=>hr===r&&hc===c);
      if(isSel) cell.classList.add('sel');
      if(isHint) cell.classList.add('hint-cell');
      cell.textContent=m3Board[r]?.[c]||'';
      if(!m3Processing) cell.addEventListener('click',()=>m3Click(r,c));
      board.appendChild(cell);
    }
  }
  const msg=document.getElementById('match3Msg');
  if(msg){
    if(!m3Active) msg.textContent='🏁 Игра окончена! Нажми «Новая» для старта.';
    else if(m3Moves<=3) msg.textContent=`⚠️ Осталось ${m3Moves} ход(а)!`;
    else msg.textContent='';
  }
}

function m3ClearBoardCells(mark){
  let cleared = 0;
  for(let r=0;r<M3_ROWS;r++){
    for(let c=0;c<M3_COLS;c++){
      if(mark[r][c]){
        m3Board[r][c]=null;
        cleared++;
      }
    }
  }
  return cleared;
}

function m3DropBoard(){
  for(let c=0;c<M3_COLS;c++){
    const stack=[];
    for(let r=M3_ROWS-1;r>=0;r--){
      if(m3Board[r][c]!==null) stack.push(m3Board[r][c]);
    }
    while(stack.length<M3_ROWS){
      stack.push(M3_GEMS[Math.floor(Math.random()*M3_GEMS.length)]);
    }
    for(let r=M3_ROWS-1, i=0; r>=0; r--, i++){
      m3Board[r][c]=stack[i];
    }
  }
}

async function m3cascade(){
  try{
    while(true){
      const mark=m3FindMatches();
      if(!mark) break;

      const pts=m3ClearBoardCells(mark);
      const gained=pts*10*m3Combo;
      m3Score+=gained;

      if(m3Score>=100) unlockAchievement('match3_100');
      if(m3Score>=500) unlockAchievement('match3_500');
      if(m3Combo>=3) unlockAchievement('match3_combo');

      renderMatch3();
      await m3Sleep(150);

      m3DropBoard();
      m3Combo++;
      renderMatch3();
      await m3Sleep(150);
    }

    if(m3Moves<=0){
      m3Active=false;
      // Save best score
      get(userRef(currentNick)).then(snap=>{const u=snap.val()||{};const prev=(u.gameStats||{}).match3Best||0;if(m3Score>prev)update(userRef(currentNick),{'gameStats/match3Best':m3Score});});
      if(m3Score>=1000) unlockAchievement('match3_1000');
    } else if(m3Active && !m3HasMoves()){
      toast('⚠️ Нет ходов — перемешиваем','gold');
      match3NewGame();
      return;
    }
  } finally {
    m3Processing=false;
    m3Selected=null;
    renderMatch3();
  }
}

function m3FindMatches(){
  const mark=Array.from({length:M3_ROWS},()=>Array(M3_COLS).fill(false));
  let found=false;
  for(let r=0;r<M3_ROWS;r++){
    for(let c=0;c<M3_COLS-2;c++){
      if(m3Board[r][c]&&m3Board[r][c]===m3Board[r][c+1]&&m3Board[r][c]===m3Board[r][c+2]){
        mark[r][c]=mark[r][c+1]=mark[r][c+2]=true;found=true;
      }
    }
  }
  for(let c=0;c<M3_COLS;c++){
    for(let r=0;r<M3_ROWS-2;r++){
      if(m3Board[r][c]&&m3Board[r][c]===m3Board[r+1][c]&&m3Board[r][c]===m3Board[r+2][c]){
        mark[r][c]=mark[r+1][c]=mark[r+2][c]=true;found=true;
      }
    }
  }
  return found?mark:null;
}

function m3ResolvePotentialMove(){
  let hint=null;
  outer:for(let r=0;r<M3_ROWS;r++){
    for(let c=0;c<M3_COLS-1;c++){
      [m3Board[r][c],m3Board[r][c+1]]=[m3Board[r][c+1],m3Board[r][c]];
      if(m3FindMatches()){
        hint=[[r,c],[r,c+1]];
        [m3Board[r][c],m3Board[r][c+1]]=[m3Board[r][c+1],m3Board[r][c]];
        break outer;
      }
      [m3Board[r][c],m3Board[r][c+1]]=[m3Board[r][c+1],m3Board[r][c]];
    }
  }
  if(!hint){
    for(let r=0;r<M3_ROWS-1;r++){
      for(let c=0;c<M3_COLS;c++){
        [m3Board[r][c],m3Board[r+1][c]]=[m3Board[r+1][c],m3Board[r][c]];
        if(m3FindMatches()){
          hint=[[r,c],[r+1,c]];
          [m3Board[r][c],m3Board[r+1][c]]=[m3Board[r+1][c],m3Board[r][c]];
          break;
        }
        [m3Board[r][c],m3Board[r+1][c]]=[m3Board[r+1][c],m3Board[r][c]];
      }
    }
  }
  return hint;
}

function m3Click(r,c){
  if(!m3Active||m3Processing) return;
  m3HintCells=[];
  if(!m3Selected){m3Selected=[r,c];renderMatch3();return;}
  const[sr,sc]=m3Selected;
  if(sr===r&&sc===c){m3Selected=null;renderMatch3();return;}
  if(Math.abs(r-sr)+Math.abs(c-sc)!==1){m3Selected=[r,c];renderMatch3();return;}
  [m3Board[r][c],m3Board[sr][sc]]=[m3Board[sr][sc],m3Board[r][c]];
  if(!m3FindMatches()){
    [m3Board[r][c],m3Board[sr][sc]]=[m3Board[sr][sc],m3Board[r][c]];
    m3Selected=null;
    renderMatch3();
    toast('❌ Нет совпадений — попробуй другой ход','red');
    return;
  }
  m3Selected=null;
  m3Moves--;
  m3Processing=true;
  m3Combo=1;
  m3cascade();
  renderMatch3();
}

window.match3BuyHint=async function(){
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<5) return toast('❌ Нужно 5₽ для подсказки','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-5});
  await logTx(currentNick,{type:'out',who:'Три в ряд',amt:5,desc:'Подсказка'});
  const hint=m3ResolvePotentialMove();
  if(hint){
    m3HintCells=hint;
    toast('💡 Подсвечено возможное совпадение!','green');
  } else {
    toast('💡 Ходов нет — перемешиваем!','gold');
    match3NewGame();
    return;
  }
  updateMatch3BalDisplay();
  renderMatch3();
};

window.match3BuyRevive=async function(){
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<10) return toast('❌ Нужно 10₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-10});
  await logTx(currentNick,{type:'out',who:'Три в ряд',amt:10,desc:'+10 ходов'});
  m3Moves+=10;
  m3Active=true;
  toast('❤️ +10 ходов добавлено!','green');
  renderMatch3();
  updateMatch3BalDisplay();
};

// ──────────────────────────────────────────────
// ⚔️ ДУЭЛИ
// ──────────────────────────────────────────────

let duelState={mode:'knb',stake:0};
async function initDuelGame(){
  const owned=await checkGameOwned('duel');
  const area=document.getElementById('duelGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('duel',49); return; }
  await recordGameStart('duel');
  renderDuelSetup();
}
function renderDuelSetup(){
  const area=document.getElementById('duelGameArea'); if(!area) return;
  duelState.mode='knb';
  area.innerHTML=`
    <div class="msg-tabs" style="margin-bottom:14px;">
      <button class="msg-tab active" id="duelTabLocal" onclick="duelSwitchTab('local',this)">📱 С одного телефона</button>
      <button class="msg-tab" id="duelTabOnline" onclick="duelSwitchTab('online',this)">🌐 По сети</button>
    </div>
    <div id="duelLocalArea">
      <div class="card-title">Настройка дуэли</div>
      <label style="font-size:12px;font-weight:800;color:var(--muted);">Ставка каждого игрока (₽)</label>
      <input type="number" id="duelStake" value="10" min="1" style="margin-bottom:8px;">
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button id="duelModeKNB" class="btn btn-primary btn-sm" onclick="selectDuelMode('knb')" style="flex:1;">✊ КНБ</button>
        <button id="duelModeTTT" class="btn btn-ghost btn-sm" onclick="selectDuelMode('ttt')" style="flex:1;">⊞ Крестики-нолики</button>
      </div>
      <button class="btn btn-gold" onclick="startDuel()">⚔️ Начать дуэль</button>
    </div>
    <div id="duelOnlineArea" style="display:none;"></div>
    <div id="duelArea" style="margin-top:16px;"></div>
  `;
  renderOnlineDuelLobby();
}

window.duelSwitchTab=function(tab,btn){
  document.querySelectorAll('#duelGameArea .msg-tab').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  document.getElementById('duelLocalArea').style.display=tab==='local'?'':'none';
  document.getElementById('duelOnlineArea').style.display=tab==='online'?'':'none';
  document.getElementById('duelArea').innerHTML='';
};

// ─── ONLINE DUEL ──────────────────────────────────────────────────────
let onlineDuelListener=null, onlineDuelId=null;

function onlineDuelRef(id){ return ref(db,`onlineDuels/${id}`); }

async function renderOnlineDuelLobby(){
  const area=document.getElementById('duelOnlineArea'); if(!area) return;
  // Show incoming duel invites
  const snap=await get(ref(db,'onlineDuels'));
  const all=snap.val()||{};
  const incoming=Object.entries(all).filter(([id,d])=>d.opponent===currentNick&&d.status==='waiting');
  const inviteHtml=incoming.map(([id,d])=>`
    <div style="background:var(--gold-dim);border:1px solid rgba(255,128,106,.35);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div>
        <div style="font-weight:900;font-size:14px;">⚔️ Вызов от <span style="color:var(--gold);">${escHtml(d.challenger)}</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px;">Ставка: ${d.stake}₽ • ${d.mode==='knb'?'КНБ':'Крестики-нолики'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-primary btn-sm" onclick="acceptOnlineDuel('${id}')">✅ Принять</button>
        <button class="btn btn-red btn-sm" onclick="declineOnlineDuel('${id}')">❌</button>
      </div>
    </div>`).join('');

  area.innerHTML=`
    ${inviteHtml}
    <div class="card-title">Вызвать игрока по сети</div>
    <label style="font-size:12px;font-weight:800;color:var(--muted);">Ник соперника</label>
    <input type="text" id="duelOpponentNick" placeholder="Введи ник" style="margin-bottom:8px;" maxlength="30">
    <label style="font-size:12px;font-weight:800;color:var(--muted);">Ставка (₽)</label>
    <input type="number" id="duelOnlineStake" value="10" min="1" style="margin-bottom:8px;">
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button id="duelOnlineKNB" class="btn btn-primary btn-sm" onclick="selectOnlineMode('knb')" style="flex:1;">✊ КНБ</button>
      <button id="duelOnlineTTT" class="btn btn-ghost btn-sm" onclick="selectOnlineMode('ttt')" style="flex:1;">⊞ Крестики-нолики</button>
    </div>
    <button class="btn btn-gold" onclick="sendOnlineDuelInvite()">📨 Отправить вызов</button>
    <div id="onlineDuelStatus" style="margin-top:12px;font-size:13px;font-weight:800;text-align:center;color:var(--muted);min-height:20px;"></div>
  `;
}

let onlineDuelMode='knb';
window.selectOnlineMode=function(m){
  onlineDuelMode=m;
  document.getElementById('duelOnlineKNB')?.classList.toggle('btn-primary',m==='knb');
  document.getElementById('duelOnlineKNB')?.classList.toggle('btn-ghost',m!=='knb');
  document.getElementById('duelOnlineTTT')?.classList.toggle('btn-primary',m==='ttt');
  document.getElementById('duelOnlineTTT')?.classList.toggle('btn-ghost',m!=='ttt');
};

window.sendOnlineDuelInvite=async function(){
  const opponent=(document.getElementById('duelOpponentNick')?.value||'').trim();
  const stake=parseInt(document.getElementById('duelOnlineStake')?.value||10);
  if(!opponent) return toast('❌ Введи ник соперника','red');
  if(opponent===currentNick) return toast('❌ Нельзя вызвать самого себя','red');
  if(stake<1) return toast('❌ Минимальная ставка 1₽','red');
  const opSnap=await get(userRef(opponent));
  if(!opSnap.exists()) return toast('❌ Игрок не найден','red');
  const mySnap=await get(userRef(currentNick));const u=mySnap.val()||{};
  if((u.balance||0)<stake) return toast(`❌ Нужно ${stake}₽`,'red');
  if(stake>=50) unlockAchievement('duel_highstake');
  // Deduct stake
  await update(userRef(currentNick),{balance:(u.balance||0)-stake});
  await logTx(currentNick,{type:'out',who:'Дуэли',amt:stake,desc:`Ставка на онлайн-дуэль с ${opponent}`});
  // Create duel record
  const duelRef2=push(ref(db,'onlineDuels'));
  onlineDuelId=duelRef2.key;
  await set(duelRef2,{challenger:currentNick,opponent,stake,mode:onlineDuelMode,status:'waiting',createdAt:Date.now(),challengerMove:null,opponentMove:null,board:null,turn:1});
  // Notify opponent
  await pushLegacyDuelNotification(opponent,{type:'duel_invite',from:currentNick,duelId:onlineDuelId,text:`⚔️ ${currentNick} вызывает тебя на дуэль! Ставка: ${stake}₽`,ts:Date.now(),read:false});
  document.getElementById('onlineDuelStatus').textContent='⏳ Ожидаем соперника...';
  document.getElementById('onlineDuelStatus').style.color='var(--gold)';
  // Listen for opponent accept
  listenOnlineDuel(onlineDuelId,'challenger');
  unlockAchievement('duel_first');
};

window.acceptOnlineDuel=async function(duelId){
  const dSnap=await get(onlineDuelRef(duelId));
  const d=dSnap.val(); if(!d||d.status!=='waiting') return toast('❌ Дуэль уже не актуальна','red');
  const mySnap=await get(userRef(currentNick));const u=mySnap.val()||{};
  if((u.balance||0)<d.stake) return toast(`❌ Нужно ${d.stake}₽`,'red');
  if(d.stake>=50) unlockAchievement('duel_highstake');
  await update(userRef(currentNick),{balance:(u.balance||0)-d.stake});
  await logTx(currentNick,{type:'out',who:'Дуэли',amt:d.stake,desc:`Ставка на онлайн-дуэль с ${d.challenger}`});
  await update(onlineDuelRef(duelId),{status:'active'});
  onlineDuelId=duelId;
  listenOnlineDuel(duelId,'opponent');
  document.getElementById('duelTabOnline')?.click();
  unlockAchievement('duel_first');
};

window.declineOnlineDuel=async function(duelId){
  const dSnap=await get(onlineDuelRef(duelId));
  const d=dSnap.val(); if(!d) return;
  // Refund challenger
  const cSnap=await get(userRef(d.challenger));const cu=cSnap.val()||{};
  await update(userRef(d.challenger),{balance:(cu.balance||0)+d.stake});
  await logTx(d.challenger,{type:'in',who:'Дуэли',amt:d.stake,desc:`Вызов отклонён ${currentNick}`});
  await update(onlineDuelRef(duelId),{status:'declined'});
  await pushLegacyDuelNotification(d.challenger,{type:'duel_declined',from:currentNick,text:`❌ ${currentNick} отклонил вызов. Ставка возвращена.`,ts:Date.now(),read:false});
  toast('❌ Вызов отклонён','red');
  renderOnlineDuelLobby();
};

function listenOnlineDuel(duelId,role){
  if(onlineDuelListener){off(onlineDuelRef(onlineDuelId));onlineDuelListener=null;}
  const dRef=onlineDuelRef(duelId);
  onlineDuelListener=onValue(dRef,snap=>{
    const d=snap.val(); if(!d) return;
    const area=document.getElementById('duelOnlineArea'); if(!area) return;
    if(d.status==='waiting'){
      if(role==='challenger') area.querySelector('#onlineDuelStatus')&&(area.querySelector('#onlineDuelStatus').textContent='⏳ Ожидаем соперника...');
      return;
    }
    if(d.status==='declined'){
      area.innerHTML=`<div style="text-align:center;padding:20px;color:var(--red);font-weight:800;">❌ Соперник отклонил вызов. Ставка возвращена.</div><button class="btn btn-ghost" onclick="renderOnlineDuelLobby()">← Назад</button>`;
      off(dRef);return;
    }
    if(d.status==='active'){
      if(d.mode==='knb') renderOnlineKNB(duelId,d,role);
      else renderOnlineTTT(duelId,d,role);
    }
    if(d.status==='finished'){
      off(dRef);
      const winner=d.winner;
      const myWin=winner===currentNick;
      area.innerHTML=`<div style="text-align:center;padding:20px;">
        <div style="font-size:40px;margin-bottom:8px;">${myWin?'🏆':'😔'}</div>
        <div style="font-weight:900;font-size:18px;color:${myWin?'var(--primary)':'var(--red)'};margin-bottom:8px;">${winner==='draw'?'🤝 Ничья!':(myWin?'Ты победил!':'Победил '+escHtml(winner))}</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">${myWin?`+${d.stake*2}₽ зачислено!`:winner==='draw'?'Ставка возвращена.':'Ставка проиграна.'}</div>
        <button class="btn btn-primary" onclick="renderOnlineDuelLobby()">🔄 Ещё раз</button>
      </div>`;
    }
  });
}

function renderOnlineKNB(duelId,d,role){
  const area=document.getElementById('duelOnlineArea'); if(!area) return;
  const myMove=role==='challenger'?d.challengerMove:d.opponentMove;
  const oppMove=role==='challenger'?d.opponentMove:d.challengerMove;
  const oppNick=role==='challenger'?d.opponent:d.challenger;
  const KNB_ICONS2={rock:'✊',scissors:'✌️',paper:'🖐',null:'❓'};
  area.innerHTML=`
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;margin-bottom:12px;">
      <div style="text-align:center;margin-bottom:10px;font-weight:900;color:var(--primary);">⚔️ Онлайн-дуэль КНБ</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        <div style="text-align:center;">
          <div style="font-size:11px;font-weight:800;color:var(--muted);margin-bottom:4px;">Ты</div>
          <div style="font-size:36px;">${myMove?KNB_ICONS2[myMove]:'❓'}</div>
          <div style="font-size:10px;color:var(--muted);">${myMove?'Ход сделан':'Выбери:'}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:11px;font-weight:800;color:var(--muted);margin-bottom:4px;">${escHtml(oppNick)}</div>
          <div style="font-size:36px;">${oppMove?'✅':'⏳'}</div>
          <div style="font-size:10px;color:var(--muted);">${oppMove?'Ход сделан':'Ждём...'}</div>
        </div>
      </div>
      ${!myMove?`<div style="display:flex;gap:6px;justify-content:center;">
        <button class="btn btn-ghost btn-sm" onclick="makeOnlineKNBMove('${duelId}','${role}','rock')">✊ Камень</button>
        <button class="btn btn-ghost btn-sm" onclick="makeOnlineKNBMove('${duelId}','${role}','scissors')">✌️ Ножницы</button>
        <button class="btn btn-ghost btn-sm" onclick="makeOnlineKNBMove('${duelId}','${role}','paper')">🖐 Бумага</button>
      </div>`:'<div style="text-align:center;color:var(--muted);font-size:13px;">Ждём ход соперника...</div>'}
    </div>`;
}

window.makeOnlineKNBMove=async function(duelId,role,choice){
  const field=role==='challenger'?'challengerMove':'opponentMove';
  await update(onlineDuelRef(duelId),{[field]:choice});
  // Check if both moved
  const snap=await get(onlineDuelRef(duelId));const d=snap.val();
  if(d.challengerMove&&d.opponentMove){
    // Resolve
    const KNB_BEATS2={rock:'scissors',scissors:'paper',paper:'rock'};
    let winner='draw';
    if(KNB_BEATS2[d.challengerMove]===d.opponentMove) winner=d.challenger;
    else if(KNB_BEATS2[d.opponentMove]===d.challengerMove) winner=d.opponent;
    await update(onlineDuelRef(duelId),{status:'finished',winner});
    // Pay winner (do it once by challenger role to avoid double payout)
    if(role==='challenger'){
      if(winner==='draw'){
        const cSnap=await get(userRef(d.challenger));const cu=cSnap.val()||{};
        await update(userRef(d.challenger),{balance:(cu.balance||0)+d.stake});
        const oSnap=await get(userRef(d.opponent));const ou=oSnap.val()||{};
        await update(userRef(d.opponent),{balance:(ou.balance||0)+d.stake});
      } else {
        const wSnap=await get(userRef(winner));const wu=wSnap.val()||{};
        await update(userRef(winner),{balance:(wu.balance||0)+d.stake*2});
        await logTx(winner,{type:'in',who:'Дуэли',amt:d.stake*2,desc:`Победа в онлайн-дуэли КНБ`});
        unlockAchievement('duel_win');
        get(userRef(winner)).then(snap2=>{const u2=snap2.val()||{};const w=(u2.gameStats?.duelWins||0)+1;update(userRef(winner),{'gameStats/duelWins':w});if(w>=5)unlockAchievement('duel_win5');});
      }
    }
  }
};

function renderOnlineTTT(duelId,d,role){
  const area=document.getElementById('duelOnlineArea'); if(!area) return;
  const isMyTurn=(d.turn===1&&role==='challenger')||(d.turn===2&&role==='opponent');
  const myMark=role==='challenger'?'X':'O';
  const board=d.board||Array(9).fill(null);
  const oppNick=role==='challenger'?d.opponent:d.challenger;
  area.innerHTML=`
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;margin-bottom:12px;">
      <div style="text-align:center;margin-bottom:10px;">
        <div style="font-weight:900;color:var(--primary);margin-bottom:4px;">⊞ Крестики-нолики по сети</div>
        <div style="font-size:12px;color:${isMyTurn?'var(--primary)':'var(--muted)'};">${isMyTurn?'Твой ход!':'Ход '+escHtml(oppNick)+'...'}</div>
      </div>
      <div id="onlineTTTGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:200px;margin:0 auto;"></div>
    </div>`;
  const grid=document.getElementById('onlineTTTGrid');
  board.forEach((cell,i)=>{
    const btn=document.createElement('button');
    btn.style.cssText=`width:62px;height:62px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);font-size:30px;cursor:${(!cell&&isMyTurn)?'pointer':'default'};color:${cell==='X'?'var(--primary)':'var(--red)'};font-family:'Nunito',sans-serif;font-weight:900;`;
    btn.textContent=cell||'';
    if(!cell&&isMyTurn) btn.onclick=()=>makeOnlineTTTMove(duelId,d,role,i,board);
    grid.appendChild(btn);
  });
}

window.makeOnlineTTTMove=async function(duelId,d,role,idx,board){
  const newBoard=[...board];
  newBoard[idx]=role==='challenger'?'X':'O';
  const nextTurn=d.turn===1?2:1;
  const checkTTTWin=(b)=>[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(([a,b2,c])=>b[a]&&b[a]===b[b2]&&b[a]===b[c]);
  if(checkTTTWin(newBoard)){
    const winner=role==='challenger'?d.challenger:d.opponent;
    await update(onlineDuelRef(duelId),{board:newBoard,status:'finished',winner});
    const wSnap=await get(userRef(winner));const wu=wSnap.val()||{};
    await update(userRef(winner),{balance:(wu.balance||0)+d.stake*2});
    await logTx(winner,{type:'in',who:'Дуэли',amt:d.stake*2,desc:`Победа в онлайн-дуэли`});
    unlockAchievement('duel_win');
    get(userRef(winner)).then(snap2=>{const u2=snap2.val()||{};const w=(u2.gameStats?.duelWins||0)+1;update(userRef(winner),{'gameStats/duelWins':w});if(w>=5)unlockAchievement('duel_win5');});
  } else if(newBoard.every(x=>x)){
    await update(onlineDuelRef(duelId),{board:newBoard,status:'finished',winner:'draw'});
    const cSnap=await get(userRef(d.challenger));const cu=cSnap.val()||{};
    await update(userRef(d.challenger),{balance:(cu.balance||0)+d.stake});
    const oSnap=await get(userRef(d.opponent));const ou=oSnap.val()||{};
    await update(userRef(d.opponent),{balance:(ou.balance||0)+d.stake});
  } else {
    await update(onlineDuelRef(duelId),{board:newBoard,turn:nextTurn});
  }
};
window.selectDuelMode=function(mode){
  duelState.mode=mode;
  document.getElementById('duelModeKNB')?.classList.toggle('btn-primary',mode==='knb');
  document.getElementById('duelModeKNB')?.classList.toggle('btn-ghost',mode!=='knb');
  document.getElementById('duelModeTTT')?.classList.toggle('btn-primary',mode==='ttt');
  document.getElementById('duelModeTTT')?.classList.toggle('btn-ghost',mode!=='ttt');
};
window.startDuel=async function(){
  const stake=parseInt(document.getElementById('duelStake')?.value||10);
  if(stake>=50) unlockAchievement('duel_highstake');
  if(stake<1) return toast('❌ Минимальная ставка 1₽','red');
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<stake*2) return toast(`❌ Нужно ${stake*2}₽ (ставка × 2)`,'red');
  await update(userRef(currentNick),{balance:(u.balance||0)-stake*2});
  await logTx(currentNick,{type:'out',who:'Дуэли',amt:stake*2,desc:`Ставка на дуэль`});
  duelState.stake=stake;
  unlockAchievement('duel_first');
  if(duelState.mode==='knb') renderKNBGame();
  else renderTTTGame();
};
let knbP1=null,knbP2=null;
function renderKNBGame(){
  const area=document.getElementById('duelArea'); if(!area) return;
  knbP1=null;knbP2=null;
  area.innerHTML=`<div class="card-title">✊ Камень-ножницы-бумага</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
      <div style="text-align:center;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;">
        <div style="font-weight:900;margin-bottom:8px;">Игрок 1</div>
        <div id="knbP1choice" style="font-size:36px;margin-bottom:10px;">❓</div>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-bottom:4px;" onclick="knbChoose(1,'rock')">✊</button>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-bottom:4px;" onclick="knbChoose(1,'scissors')">✌️</button>
        <button class="btn btn-ghost btn-sm" style="width:100%;" onclick="knbChoose(1,'paper')">🖐</button>
      </div>
      <div style="text-align:center;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;">
        <div style="font-weight:900;margin-bottom:8px;">Игрок 2</div>
        <div id="knbP2choice" style="font-size:36px;margin-bottom:10px;">❓</div>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-bottom:4px;" onclick="knbChoose(2,'rock')">✊</button>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-bottom:4px;" onclick="knbChoose(2,'scissors')">✌️</button>
        <button class="btn btn-ghost btn-sm" style="width:100%;" onclick="knbChoose(2,'paper')">🖐</button>
      </div>
    </div>
    <div id="knbResult" style="font-size:15px;font-weight:900;text-align:center;min-height:24px;"></div>`;
}
const KNB_ICONS={rock:'✊',scissors:'✌️',paper:'🖐'};
const KNB_BEATS={rock:'scissors',scissors:'paper',paper:'rock'};
window.knbChoose=function(player,choice){
  if(player===1)knbP1=choice;else knbP2=choice;
  document.getElementById(`knbP${player}choice`).textContent=KNB_ICONS[choice];
  if(!knbP1||!knbP2)return;
  setTimeout(async()=>{
    const res=document.getElementById('knbResult');
    let winner=0;
    if(KNB_BEATS[knbP1]===knbP2)winner=1;else if(KNB_BEATS[knbP2]===knbP1)winner=2;
    const snap2=await get(userRef(currentNick));const u2=snap2.val()||{};
    if(winner===0){
      if(res)res.innerHTML=`<div style="color:var(--gold);margin-bottom:8px;">🤝 Ничья! Деньги возвращены.</div>`;
      await update(userRef(currentNick),{balance:(u2.balance||0)+duelState.stake*2});
    }else{
      if(res)res.innerHTML=`<div style="color:var(--primary);margin-bottom:8px;">🏆 Игрок ${winner} победил! +${duelState.stake*2}₽</div>`;
      await update(userRef(currentNick),{balance:(u2.balance||0)+duelState.stake*2});
      await logTx(currentNick,{type:'in',who:'Дуэли',amt:duelState.stake*2,desc:`Победа КНБ`});
      unlockAchievement('duel_win');
      get(userRef(currentNick)).then(snap=>{const u=snap.val()||{};const w=(u.gameStats?.duelWins||0)+1;update(userRef(currentNick),{'gameStats/duelWins':w});if(w>=5)unlockAchievement('duel_win5');});
    }
    if(res)res.innerHTML+=`<button class="btn btn-primary btn-sm" onclick="startDuel()">🔄 Ещё раз</button>`;
  },500);
};
let tttBoard,tttTurn2;
function renderTTTGame(){
  tttBoard=Array(9).fill(null);tttTurn2=1;
  const area=document.getElementById('duelArea'); if(!area) return;
  area.innerHTML=`<div class="card-title">⊞ Крестики-нолики</div>
    <div id="tttStatus" style="text-align:center;font-weight:900;margin-bottom:10px;color:var(--primary);">Ход: Игрок 1 (✕)</div>
    <div id="tttGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:200px;margin:0 auto 12px;"></div>
    <div id="tttResult" style="text-align:center;font-size:15px;font-weight:900;min-height:24px;"></div>`;
  renderTTTGrid();
}
function renderTTTGrid(){
  const grid=document.getElementById('tttGrid'); if(!grid) return;
  grid.innerHTML='';
  tttBoard.forEach((cell,i)=>{
    const btn=document.createElement('button');
    btn.style.cssText=`width:62px;height:62px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);font-size:30px;cursor:${cell?'default':'pointer'};color:${cell==='X'?'var(--primary)':'var(--red)'};font-family:'Nunito',sans-serif;font-weight:900;`;
    btn.textContent=cell||'';
    if(!cell) btn.onclick=()=>tttMove(i);
    grid.appendChild(btn);
  });
}
window.tttMove=async function(i){
  if(tttBoard[i])return;
  tttBoard[i]=tttTurn2===1?'X':'O';
  const win=tttCheckWin();
  renderTTTGrid();
  const status=document.getElementById('tttStatus');
  const result=document.getElementById('tttResult');
  if(win){
    if(status)status.textContent=`🏆 Игрок ${tttTurn2} победил!`;
    const snap2=await get(userRef(currentNick));const u2=snap2.val()||{};
    await update(userRef(currentNick),{balance:(u2.balance||0)+duelState.stake*2});
    await logTx(currentNick,{type:'in',who:'Дуэли',amt:duelState.stake*2,desc:`Победа крестики-нолики`});
    if(result)result.innerHTML=`<div style="color:var(--primary);margin-bottom:8px;">Игрок ${tttTurn2} победил! +${duelState.stake*2}₽</div><button class="btn btn-primary btn-sm" onclick="startDuel()">🔄 Ещё раз</button>`;
    unlockAchievement('duel_win');
    get(userRef(currentNick)).then(snap=>{const u=snap.val()||{};const w=(u.gameStats?.duelWins||0)+1;update(userRef(currentNick),{'gameStats/duelWins':w});if(w>=5)unlockAchievement('duel_win5');});
    return;
  }
  if(tttBoard.every(x=>x)){
    if(status)status.textContent='🤝 Ничья!';
    const snap2=await get(userRef(currentNick));const u2=snap2.val()||{};
    await update(userRef(currentNick),{balance:(u2.balance||0)+duelState.stake*2});
    if(result)result.innerHTML=`<div style="color:var(--gold);margin-bottom:8px;">Ничья! Деньги возвращены.</div><button class="btn btn-primary btn-sm" onclick="startDuel()">🔄 Ещё раз</button>`;
    return;
  }
  tttTurn2=tttTurn2===1?2:1;
  if(status)status.textContent=`Ход: Игрок ${tttTurn2} (${tttTurn2===1?'✕':'○'})`;
};
function tttCheckWin(){return[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(([a,b,c])=>tttBoard[a]&&tttBoard[a]===tttBoard[b]&&tttBoard[a]===tttBoard[c]);}

// ──────────────────────────────────────────────
// 🏚️ ЗАБРОШКА: ПОИСК СОКРОВИЩ
// ──────────────────────────────────────────────
const ABN_ROWS=10,ABN_COLS=10;
const ABN_DAILY_ENERGY=15;
let abnBoard=[],abnRevealed=[],abnEnergy=15,abnActive=false,abnScore=0,abnFlashlightUsed=false,abnDetectorUsed=false;

function abnTodayKey(){ const d=new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

async function initAbandonedGame(){
  const owned=await checkGameOwned('abandoned');
  const area=document.getElementById('abandonedGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('abandoned',89); return; }
  await recordGameStart('abandoned');
  // Load saved energy from Firebase (daily reset)
  const snap=await get(userRef(currentNick)); const u=snap.val()||{};
  const abnData=u.abandonedData||{};
  const today=abnTodayKey();
  if(abnData.energyDate===today){
    abnEnergy=typeof abnData.energy==='number'?abnData.energy:ABN_DAILY_ENERGY;
  } else {
    abnEnergy=ABN_DAILY_ENERGY;
    await update(userRef(currentNick),{'abandonedData/energy':ABN_DAILY_ENERGY,'abandonedData/energyDate':today});
  }
  renderAbandonedSetup();
}

async function abnSaveEnergy(){
  const today=abnTodayKey();
  await update(userRef(currentNick),{'abandonedData/energy':abnEnergy,'abandonedData/energyDate':today});
}

function renderAbandonedSetup(){
  const area=document.getElementById('abandonedGameArea'); if(!area) return;
  const energyPct=Math.round((abnEnergy/ABN_DAILY_ENERGY)*100);
  area.innerHTML=`
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">
      <span style="font-size:22px;">⚡</span>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:800;margin-bottom:4px;">Дневная энергия: <span style="color:var(--primary);">${abnEnergy}/${ABN_DAILY_ENERGY}</span></div>
        <div style="background:var(--border);border-radius:6px;height:6px;overflow:hidden;"><div style="width:${energyPct}%;background:var(--primary);height:100%;border-radius:6px;transition:width .3s;"></div></div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">Восстанавливается каждый день</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
      <button type="button" class="btn btn-primary" onclick="startAbandonedGame()" style="flex:1;" ${abnEnergy<=0?'disabled':''}>🏚️ Новая экспедиция</button>
      <button type="button" class="btn btn-gold btn-sm" onclick="abnBuyFlashlight()" style="flex:1;">🔦 Фонарик (15₽)</button>
      <button type="button" class="btn btn-gold btn-sm" onclick="abnBuyDetector()" style="flex:1;">📡 Металлоискатель (25₽)</button>
      <button type="button" class="btn btn-sm" style="background:var(--red-dim);color:var(--red);border:1px solid var(--red);flex:1;" onclick="abnBuyBomb()">💣 Бомба (35₽)</button>
    </div>
    <div id="abnInfo" style="display:flex;gap:8px;margin-bottom:10px;">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;flex:1;text-align:center;"><div id="abnEnergyEl" style="font-size:16px;font-weight:900;color:var(--primary);">${abnEnergy}</div><div style="font-size:9px;color:var(--muted);">Энергия</div></div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;flex:1;text-align:center;"><div id="abnScoreEl" style="font-size:16px;font-weight:900;color:var(--gold);">0₽</div><div style="font-size:9px;color:var(--muted);">Найдено</div></div>
    </div>
    <style>
    .abn-grid{display:grid;gap:2px;margin:0 auto 10px;}
    .abn-cell{width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;transition:.1s;border:1px solid rgba(255,255,255,.06);user-select:none;}
    .abn-cell.fog{background:rgba(100,116,139,.2);cursor:pointer;}
    .abn-cell.fog:active{transform:scale(.88);}
    .abn-cell.fog:hover{background:rgba(100,116,139,.35);border-color:rgba(255,255,255,.15);}
    .abn-cell.safe{background:rgba(240,68,74,.08);cursor:default;}
    .abn-cell.revealed{cursor:default;}
    .abn-cell.hint-safe{background:rgba(240,68,74,.18);border-color:rgba(240,68,74,.4);}
    .abn-cell.hint-treasure{background:rgba(255,128,106,.25);border-color:rgba(255,128,106,.5);animation:hintPulse .7s ease-in-out infinite alternate;}
    .abn-cell.bomb-mode{background:rgba(248,113,113,.25);border-color:rgba(248,113,113,.5);animation:hintPulse .5s ease-in-out infinite alternate;}
    </style>
    <div id="abnGrid" class="abn-grid" style="grid-template-columns:repeat(${ABN_COLS},30px);"></div>
    <div id="abnMsg" style="font-size:13px;font-weight:800;text-align:center;min-height:20px;margin-top:4px;"></div>
  `;
}

window.startAbandonedGame=function(){
  if(abnEnergy<=0) return toast('⚡ Энергия кончилась! Приходи завтра.','red');
  abnScore=0;abnActive=true;abnFlashlightUsed=false;abnDetectorUsed=false;abnBombUsed=false;abnBombMode=false;
  // Generate board: 0=empty, treasure=amt, -amt=gopnik, 'big'=big treasure, 'bomb_trap'=bomb hazard
  abnBoard=Array.from({length:ABN_ROWS},()=>Array(ABN_COLS).fill(0));
  abnRevealed=Array.from({length:ABN_ROWS},()=>Array(ABN_COLS).fill(false));
  // Place items randomly
  const place=(val,count)=>{let n=0;while(n<count){const r=Math.floor(Math.random()*ABN_ROWS),c=Math.floor(Math.random()*ABN_COLS);if(abnBoard[r][c]===0){abnBoard[r][c]=val;n++;}}};
  place(5,8); place(10,6); place(20,4); place(50,2); place('big',1);
  place(-5,6); place(-10,4); place(-15,2); place('bomb_trap',3);
  renderAbnGrid();
  unlockAchievement('abandoned_first');
}

let abnBombUsed=false,abnBombMode=false;

function renderAbnGrid(){
  const grid=document.getElementById('abnGrid'); if(!grid) return;
  const eEl=document.getElementById('abnEnergyEl');const sEl=document.getElementById('abnScoreEl');
  if(eEl)eEl.textContent=abnEnergy;if(sEl)sEl.textContent=abnScore+'₽';
  grid.innerHTML='';
  let allClear=true;
  for(let r=0;r<ABN_ROWS;r++){for(let c=0;c<ABN_COLS;c++){
    const cell=document.createElement('div');
    cell.className='abn-cell';
    if(abnRevealed[r][c]){
      cell.classList.add('revealed');
      const v=abnBoard[r][c];
      if(v===0){cell.textContent='·';cell.style.color='var(--muted)';}
      else if(v==='big'){cell.textContent='💰';}
      else if(v==='bomb_trap'){cell.textContent='💥';}
      else if(typeof v==='number'&&v>0){cell.textContent='💎';cell.title=`+${v}₽`;}
      else{cell.textContent='😤';}
    } else {
      cell.classList.add('fog');
      if(abnBombMode) cell.classList.add('bomb-mode');
      cell.textContent=abnBombMode?'💣':'🌫️';
      if(abnActive) cell.addEventListener('click',()=>abnBombMode?abnUseBombOnCell(r,c):abnOpen(r,c));
      allClear=false;
    }
    grid.appendChild(cell);
  }}
  const msg=document.getElementById('abnMsg');
  if(msg){
    if(!abnActive)msg.textContent=`Экспедиция завершена! Итого: ${abnScore}₽`;
    else if(abnEnergy<=0){msg.textContent='⚡ Энергия на сегодня кончилась! Приходи завтра.';abnActive=false;}
    else if(abnBombMode)msg.textContent=`💣 Выбери клетку для взрыва!`;
    else msg.textContent=`⚡ ${abnEnergy} энергии • 💰 ${abnScore}₽`;
  }
  if(allClear&&abnActive) endAbandonedGame(true);
}

async function abnOpen(r,c){
  if(!abnActive||abnRevealed[r][c]) return;
  abnRevealed[r][c]=true;abnEnergy--;
  await abnSaveEnergy();
  const v=abnBoard[r][c];
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  let gain=0;
  if(typeof v==='number'&&v>0){gain=v;abnScore+=v;await update(userRef(currentNick),{balance:(u.balance||0)+v});await logTx(currentNick,{type:'in',who:'Заброшка',amt:v,desc:'Найден хабар'});}
  else if(v==='big'){gain=100;abnScore+=100;await update(userRef(currentNick),{balance:(u.balance||0)+100});await logTx(currentNick,{type:'in',who:'Заброшка',amt:100,desc:'Большой куш!'});unlockAchievement('abandoned_gold');toast('💰 БОЛЬШОЙ КУШ! +100₽','gold');}
  else if(v==='bomb_trap'){const loss=35;abnScore=Math.max(0,abnScore-loss);const newBal=Math.max(0,(u.balance||0)-loss);await update(userRef(currentNick),{balance:newBal});await logTx(currentNick,{type:'out',who:'Заброшка',amt:loss,desc:'Мина!'});toast(`💥 Мина! -${loss}₽`,'red');}
  else if(typeof v==='number'&&v<0){const loss=Math.abs(v);abnScore=Math.max(0,abnScore-loss);const newBal=Math.max(0,(u.balance||0)-loss);await update(userRef(currentNick),{balance:newBal});await logTx(currentNick,{type:'out',who:'Заброшка',amt:loss,desc:'Гопники!'});toast(`😤 Гопники! -${loss}₽`,'red');}
  if(abnEnergy<=0){abnActive=false;}
  renderAbnGrid();
}

function endAbandonedGame(clear){
  abnActive=false;
  if(clear) unlockAchievement('abandoned_clear');
  if(abnScore>=200) unlockAchievement('abandoned_rich');
  // Save best score
  get(userRef(currentNick)).then(snap=>{const u=snap.val()||{};const prev=(u.gameStats||{}).abandonedBest||0;if(abnScore>prev)update(userRef(currentNick),{'gameStats/abandonedBest':abnScore});});
  toast(`🏚️ Экспедиция окончена! Найдено: ${abnScore}₽`,'green');
  renderAbnGrid();
}

window.abnBuyBomb=async function(){
  if(abnBombUsed) return toast('Бомба уже использована','gold');
  if(!abnActive) return toast('Сначала начни экспедицию','red');
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<35) return toast('❌ Нужно 35₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-35});
  await logTx(currentNick,{type:'out',who:'Заброшка',amt:35,desc:'Бомба'});
  abnBombUsed=true;
  abnBombMode=true;
  toast('💣 Выбери клетку для взрыва! Разрывает 3×3 зону.','gold');
  renderAbnGrid();
};

async function abnUseBombOnCell(r,c){
  if(!abnBombMode||!abnActive) return;
  abnBombMode=false;
  // Reveal 3×3 area
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  let totalGain=0,totalLoss=0;
  for(let dr=-1;dr<=1;dr++){for(let dc=-1;dc<=1;dc++){
    const nr=r+dr,nc=c+dc;
    if(nr<0||nr>=ABN_ROWS||nc<0||nc>=ABN_COLS||abnRevealed[nr][nc]) continue;
    abnRevealed[nr][nc]=true;
    const v=abnBoard[nr][nc];
    if(typeof v==='number'&&v>0){totalGain+=v;abnScore+=v;}
    else if(v==='big'){totalGain+=100;abnScore+=100;unlockAchievement('abandoned_gold');}
    else if(v==='bomb_trap'){/* defused, no penalty */}
    else if(typeof v==='number'&&v<0){const loss=Math.abs(v);abnScore=Math.max(0,abnScore-loss);totalLoss+=loss;}
  }}
  if(totalGain>0){await update(userRef(currentNick),{balance:(u.balance||0)+totalGain});await logTx(currentNick,{type:'in',who:'Заброшка',amt:totalGain,desc:'Взрыв бомбы — хабар!'});}
  if(totalLoss>0){const newBal=Math.max(0,(u.balance||0)+totalGain-totalLoss);await update(userRef(currentNick),{balance:newBal});}
  toast(`💥 Бум! +${totalGain}₽ ${totalLoss>0?`-${totalLoss}₽`:''}`.trim(),'green');
  renderAbnGrid();
}

window.abnBuyFlashlight=async function(){
  if(abnFlashlightUsed) return toast('Фонарик уже использован','gold');
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<15) return toast('❌ Нужно 15₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-15});
  await logTx(currentNick,{type:'out',who:'Заброшка',amt:15,desc:'Фонарик'});
  abnFlashlightUsed=true;
  // reveal safe cells (value=0 or negative) as hints
  const grid=document.getElementById('abnGrid'); if(!grid) return;
  const cells=grid.querySelectorAll('.abn-cell.fog');
  let idx=0;
  cells.forEach(cell=>{
    const r=Math.floor(idx/ABN_COLS),c=idx%ABN_COLS; idx++;
    if(!abnRevealed[r]?.[c]&&(abnBoard[r]?.[c]===0||typeof abnBoard[r]?.[c]==='number'&&abnBoard[r][c]<0)) cell.classList.add('hint-safe');
  });
  toast('🔦 Безопасные клетки подсвечены на 5 сек!','green');
  setTimeout(()=>document.querySelectorAll('.hint-safe').forEach(x=>x.classList.remove('hint-safe')),5000);
  updateMatch3BalDisplay();
};

window.abnBuyDetector=async function(){
  if(abnDetectorUsed) return toast('Металлоискатель уже использован','gold');
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<25) return toast('❌ Нужно 25₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-25});
  await logTx(currentNick,{type:'out',who:'Заброшка',amt:25,desc:'Металлоискатель'});
  abnDetectorUsed=true;
  // highlight big treasure area
  const grid=document.getElementById('abnGrid'); if(!grid) return;
  const cells=grid.querySelectorAll('.abn-cell');
  let idx=0;
  cells.forEach(cell=>{
    const r=Math.floor(idx/ABN_COLS),c=idx%ABN_COLS; idx++;
    if(!abnRevealed[r]?.[c]&&(abnBoard[r]?.[c]==='big'||abnBoard[r]?.[c]===50)) cell.classList.add('hint-treasure');
  });
  toast('📡 Крупные клады подсвечены на 5 сек!','gold');
  setTimeout(()=>document.querySelectorAll('.hint-treasure').forEach(x=>x.classList.remove('hint-treasure')),5000);
};

// ──────────────────────────────────────────────
// 🏗️ БАШНЯ КАПАНИ
// ──────────────────────────────────────────────
let towerBlocks=[],towerBlockPos=0,towerBlockDir=1,towerBlockWidth=200,towerScore=0,towerRunning=false,towerRAF=null,towerPerfectStreak=0,towerStabilityBought=false,towerStabilityCharges=0;
const TOWER_SPEED_BASE=2.2,TOWER_CANVAS_W=280,TOWER_BLOCK_H=28;

async function initTowerGame(){
  const owned=await checkGameOwned('tower');
  const area=document.getElementById('towerGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('tower',59); return; }
  await recordGameStart('tower');
  area.innerHTML=`
    <style>
    #towerCanvas{border-radius:12px;border:1px solid var(--border);background:var(--surface2);display:block;margin:0 auto 10px;touch-action:none;}
    </style>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:8px;">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 14px;text-align:center;"><div id="towerScoreEl" style="font-size:18px;font-weight:900;color:var(--primary);">0</div><div style="font-size:9px;color:var(--muted);">Уровень</div></div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 14px;text-align:center;"><div id="towerPerfEl" style="font-size:18px;font-weight:900;color:var(--gold);">0</div><div style="font-size:9px;color:var(--muted);">Идеально</div></div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 14px;text-align:center;min-width:86px;"><div id="towerStabEl" style="font-size:18px;font-weight:900;color:var(--gold);">0</div><div style="font-size:9px;color:var(--muted);">Стаб.</div></div>
    </div>
    <canvas id="towerCanvas" width="${TOWER_CANVAS_W}" height="360"></canvas>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:8px;">
      <button class="btn btn-primary" id="towerBtn" onclick="towerAction()" style="flex:1;max-width:180px;">▶ Старт / Стоп</button>
      <button class="btn btn-gold btn-sm" onclick="towerBuyStability()">🧱 Устойчивость (20₽)</button>
    </div>
    <div id="towerMsg" style="font-size:13px;color:var(--muted);text-align:center;min-height:20px;"></div>
  `;
  towerStartNew();
}

function towerStartNew(){
  towerBlocks=[];towerBlockPos=0;towerBlockDir=1;towerBlockWidth=TOWER_CANVAS_W*0.7;
  towerScore=0;towerRunning=false;towerPerfectStreak=0;towerStabilityCharges=0;
  if(towerRAF){cancelAnimationFrame(towerRAF);towerRAF=null;}
  towerBlocks.push({x:(TOWER_CANVAS_W-towerBlockWidth)/2,w:towerBlockWidth});
  towerDrawFrame(false);
  const msg=document.getElementById('towerMsg');if(msg)msg.textContent='Нажми Старт, затем нажимай кнопку или экран в нужный момент!';
}

window.towerAction=function(){
  if(!towerRunning){
    towerRunning=true;
    document.getElementById('towerCanvas')?.addEventListener('click',towerPlace,{passive:true});
    towerLoop();
  } else {
    towerPlace();
  }
};

function towerLoop(){
  if(!towerRunning) return;
  const speed=(TOWER_SPEED_BASE+towerScore*0.07)*towerBlockDir;
  towerBlockPos+=speed;
  if(towerBlockPos<0){towerBlockPos=0;towerBlockDir=1;}
  if(towerBlockPos+towerBlockWidth>TOWER_CANVAS_W){towerBlockPos=TOWER_CANVAS_W-towerBlockWidth;towerBlockDir=-1;}
  towerDrawFrame(true);
  towerRAF=requestAnimationFrame(towerLoop);
}

function towerDrawFrame(showMoving){
  const canvas=document.getElementById('towerCanvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,TOWER_CANVAS_W,360);
  const visibleBlocks=towerBlocks.slice(-10);
  const startY=360-TOWER_BLOCK_H;
  visibleBlocks.forEach((b,i)=>{
    const y=startY-(i*TOWER_BLOCK_H);
    if(y<-TOWER_BLOCK_H) return;
    const alpha=0.4+i/visibleBlocks.length*0.6;
    ctx.fillStyle=`rgba(240,68,74,${alpha})`;
    ctx.beginPath();ctx.roundRect(b.x,y,b.w,TOWER_BLOCK_H-2,6);ctx.fill();
    if(i===visibleBlocks.length-1){
      ctx.fillStyle='rgba(255,255,255,0.15)';
      ctx.beginPath();ctx.roundRect(b.x,y,b.w,8,{upperLeft:6,upperRight:6});ctx.fill();
    }
  });
  if(showMoving){
    const y=startY-(towerBlocks.length*TOWER_BLOCK_H);
    ctx.fillStyle='rgba(255,128,106,0.85)';
    ctx.beginPath();ctx.roundRect(towerBlockPos,y,towerBlockWidth,TOWER_BLOCK_H-2,6);ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.2)';
    ctx.beginPath();ctx.roundRect(towerBlockPos,y,towerBlockWidth,8,{upperLeft:6,upperRight:6});ctx.fill();
  }
  const scoreEl=document.getElementById('towerScoreEl');if(scoreEl)scoreEl.textContent=towerScore;
  const perfEl=document.getElementById('towerPerfEl');if(perfEl)perfEl.textContent=towerPerfectStreak;
  const stabEl=document.getElementById('towerStabEl');if(stabEl)stabEl.textContent=towerStabilityCharges;
}

function towerPlace(){
  if(!towerRunning) return;
  cancelAnimationFrame(towerRAF);towerRAF=null;
  const prev=towerBlocks[towerBlocks.length-1];
  const cur={x:towerBlockPos,w:towerBlockWidth};
  const overlap_start=Math.max(prev.x,cur.x);
  const overlap_end=Math.min(prev.x+prev.w,cur.x+cur.w);
  const overlap=overlap_end-overlap_start;
  const msg=document.getElementById('towerMsg');
  if(overlap<=0){
    towerRunning=false;
    if(msg)msg.textContent=`💥 Промахнулся! Игра окончена. Уровень: ${towerScore}`;
    towerDrawFrame(false);
    unlockAchievement('tower_first');
    if(towerScore>=10) unlockAchievement('tower_10');
    if(towerScore>=20) unlockAchievement('tower_20');
    // Save best score
    get(userRef(currentNick)).then(snap=>{const u=snap.val()||{};const prev=(u.gameStats||{}).towerBest||0;if(towerScore>prev)update(userRef(currentNick),{'gameStats/towerBest':towerScore});});
    setTimeout(towerStartNew,2000);
    return;
  }
  const isPerfect=Math.abs(overlap-prev.w)<4;
  if(isPerfect){
    towerPerfectStreak++;
    if(towerPerfectStreak>=3) unlockAchievement('tower_perfect');
    if(msg)msg.textContent=`✨ Идеально! Комбо: ${towerPerfectStreak}`;
    towerBlocks.push({x:prev.x,w:prev.w});
    towerBlockWidth=prev.w;
  } else {
    towerPerfectStreak=0;
    let newW=overlap;
    if(towerStabilityCharges>0){
      towerStabilityCharges--;
      newW=prev.w;
      if(msg)msg.textContent=`🧱 Устойчивость спасла блок! Осталось: ${towerStabilityCharges}`;
    } else {
      if(msg)msg.textContent=`📐 Осталось ${Math.round(newW)}px ширины`;
    }
    towerBlocks.push({x:overlap_start,w:newW});
    towerBlockWidth=newW;
  }
  towerScore++;
  unlockAchievement('tower_first');
  if(towerScore>=10) unlockAchievement('tower_10');
  if(towerBlocks.length>10){towerBlocks.shift();}
  towerBlockPos=(TOWER_CANVAS_W-towerBlockWidth)/2;towerBlockDir=1;
  towerDrawFrame(false);
  setTimeout(()=>{ towerRunning=true; towerLoop(); },200);
}

window.towerBuyStability=async function(){
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<20) return toast('❌ Нужно 20₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-20});
  await logTx(currentNick,{type:'out',who:'Башня',amt:20,desc:'Устойчивость блока'});
  towerStabilityBought=true;
  towerStabilityCharges=2;
  const msg=document.getElementById('towerMsg');
  if(msg) msg.textContent='🧱 Устойчивость включена: 2 ошибки без сужения блока.';
  toast('🧱 Устойчивость включена на 2 хода','green');
};

// ──────────────────────────────────────────────
// 🔤 УГАДАЙ СЛОВО (Wordle RU)
const WORDLE_WORDS4=['КИНО','СЛОН','БЛИН','МОСТ','ГРИБ','СОЛЬ','КЛЕЙ','ПОНИ','ДРУГ','НОЧЬ','ДЕНЬ','СВЕТ','ЗИМА','РЕКА','ЛИСТ'];
const WORDLE_WORDS5=['ЗАМОК','СЛОВО','ЛИМОН','КНИГА','ЗЕМЛЯ','ПЕСНЯ','ЖИВОТ','БЕРЕГ','ПТИЦА','ГРУША','БЕЛКА','ВОЛНА','МЕСТО','ГОЛОС','МАСЛО','КРЫША','ПАРУС','ЛАЙКА','КОБРА','КУБИК','ЛЕНТА','МЫШКА','НОРКА','СОСНА','ЯГОДА'];
const WORDLE_ALL_WORDS = new Set([...WORDLE_WORDS4, ...WORDLE_WORDS5]);
let wdWord='',wdLen=5,wdAttempts=[],wdMaxTries=6,wdDone=false,wdCurInput='',wdHint=null,wdUsedLetters=new Set(),wdUsedPositions=new Set();

async function initWordleGame(){
  const owned=await checkGameOwned('wordle');
  const area=document.getElementById('wordleGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('wordle',39); return; }
  await recordGameStart('wordle');
  startWordleGame();
}

function startWordleGame(len=5){
  wdLen=len;
  const pool=len===4?WORDLE_WORDS4:WORDLE_WORDS5;
  wdWord=pool[Math.floor(Math.random()*pool.length)];
  wdAttempts=[];wdDone=false;wdCurInput='';
  wdHint=null;wdUsedLetters=new Set();wdUsedPositions=new Set();
  wdMaxTries=len===4?5:6;
  renderWordleGame();
}
window.startWordleGame = startWordleGame;

function wdGetHintMarkup(){
  if(!wdHint) return '';
  if(wdHint.type==='letter'){
    return `<div style="display:flex;justify-content:center;margin:0 0 10px;"><div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:14px;background:rgba(255,128,106,.12);border:1px solid rgba(255,128,106,.35);font-weight:900;color:var(--gold);"><span>💡</span><span>Буква: «${wdHint.value}»</span></div></div>`;
  }
  return `<div style="display:flex;justify-content:center;margin:0 0 10px;"><div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:14px;background:rgba(255,128,106,.12);border:1px solid rgba(255,128,106,.35);font-weight:900;color:var(--gold);"><span>🎯</span><span>Позиция ${wdHint.value.pos+1}: «${wdHint.value.letter}»</span></div></div>`;
}

function renderWordleGame(){
  const area=document.getElementById('wordleGameArea'); if(!area) return;
  const rows=[];
  for(let i=0;i<wdMaxTries;i++){
    const attempt=wdAttempts[i];
    if(attempt){
      rows.push(`<div style="display:flex;gap:4px;justify-content:center;margin-bottom:4px;">`+
        attempt.letters.map((l,j)=>{
          const color=attempt.colors[j]==='green'?'#f0444a':attempt.colors[j]==='yellow'?'#ff806a':'rgba(100,116,139,.4)';
          return `<div style="width:40px;height:40px;border-radius:8px;background:${color};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#080507;border:2px solid ${color};">${l}</div>`;
        }).join('')+`</div>`);
    } else if(i===wdAttempts.length&&!wdDone){
      rows.push(`<div style="display:flex;gap:4px;justify-content:center;margin-bottom:4px;">`+
        Array.from({length:wdLen},(_, j)=>{
          const ch=wdCurInput[j]||'';
          const isHintPos=wdHint?.type==='position'&&wdHint.value.pos===j;
          return `<div style="width:40px;height:40px;border-radius:8px;background:${isHintPos?'rgba(255,128,106,.2)':(ch?'var(--surface2)':'transparent')};border:2px solid ${isHintPos?'var(--gold)':(ch?'var(--primary)':'var(--border)')};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:var(--text);position:relative;">${ch|| (isHintPos?wdHint.value.letter:'')}</div>`;
        }).join('')+`</div>`);
    } else {
      rows.push(`<div style="display:flex;gap:4px;justify-content:center;margin-bottom:4px;">`+
        Array.from({length:wdLen},()=>`<div style="width:40px;height:40px;border-radius:8px;border:2px solid var(--border);"></div>`).join('')+`</div>`);
    }
  }
  const keyboard='ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ'.split('').map(k=>{
    let bg='var(--surface2)';let col='var(--text)';
    for(const a of wdAttempts){
      const idx=a.letters.indexOf(k);
      if(idx!==-1){
        if(a.colors[idx]==='green'){bg='#f0444a';col='#080507';}
        else if(a.colors[idx]==='yellow'&&bg!=='#f0444a'){bg='#ff806a';col='#080507';}
        else if(bg==='var(--surface2)'){bg='rgba(100,116,139,.35)';col='var(--muted)';}
      }
    }
    return `<button style="min-width:26px;height:34px;border-radius:6px;background:${bg};color:${col};border:1px solid var(--border);font-size:11px;font-weight:900;font-family:'Nunito',sans-serif;cursor:pointer;padding:0 3px;touch-action:manipulation;" onclick="wdKey('${k}')">${k}</button>`;
  }).join('');
  area.innerHTML=`
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;">
      <button class="btn btn-ghost btn-sm" onclick="startWordleGame(4)" style="${wdLen===4?'border-color:var(--primary);color:var(--primary);':''}">4 буквы</button>
      <button class="btn btn-ghost btn-sm" onclick="startWordleGame(5)" style="${wdLen===5?'border-color:var(--primary);color:var(--primary);':''}">5 букв</button>
    </div>
    ${wdGetHintMarkup()}
    <div style="margin-bottom:12px;">${rows.join('')}</div>
    <div id="wdMsg" style="font-size:13px;font-weight:800;text-align:center;min-height:20px;margin-bottom:10px;color:var(--primary);"></div>
    ${!wdDone?`<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;max-width:300px;margin:0 auto 8px;">${keyboard}</div>
    <div style="display:flex;gap:6px;justify-content:center;margin-top:4px;">
      <button class="btn btn-ghost btn-sm" onclick="wdKey('⌫')">⌫</button>
      <button class="btn btn-primary btn-sm" onclick="wdSubmit()">✓ Ввод</button>
    </div>
    <div style="display:flex;gap:6px;justify-content:center;margin-top:8px;flex-wrap:wrap;">
      <button class="btn btn-gold btn-sm" onclick="wdBuyHint1()">💡 Буква (5₽)</button>
      <button class="btn btn-gold btn-sm" onclick="wdBuyHint2()">🎯 Буква+место (10₽)</button>
    </div>`
    :`<button class="btn btn-primary" onclick="startWordleGame(${wdLen})">🔄 Новое слово</button>`}
  `;
  const msgEl=document.getElementById('wdMsg');
  if(msgEl&&wdDone){
    if(wdAttempts[wdAttempts.length-1]?.colors.every(c=>c==='green')){msgEl.textContent=`🎉 Угадал за ${wdAttempts.length} ${wdAttempts.length===1?'попытку':'попыток'}!`;}
    else msgEl.textContent=`😔 Слово было: ${wdWord}`;
  }
}

window.wdKey=function(k){
  if(wdDone) return;
  if(k==='⌫'){wdCurInput=wdCurInput.slice(0,-1);}
  else if(wdCurInput.length<wdLen){wdCurInput+=k;}
  renderWordleGame();
};

window.wdSubmit=function(){
  if(wdDone) return;
  if(wdCurInput.length<wdLen) return toast(`❌ Введите ${wdLen} букв`,'red');
  const guess = wdCurInput.toUpperCase().replace(/Ё/g,'Е');
  if(!WORDLE_ALL_WORDS.has(guess)) return toast('Такого слова не существует!','red');
  wdCurInput = guess;
  const letters=guess.split('');
  const colors=letters.map((l,i)=>{
    if(wdWord[i]===l) return 'green';
    if(wdWord.includes(l)) return 'yellow';
    return 'gray';
  });
  wdAttempts.push({letters,colors});
  const win=colors.every(c=>c==='green');
  if(win){
    wdDone=true;
    unlockAchievement('wordle_first');
    if(wdAttempts.length===1) unlockAchievement('wordle_fast');
    if(wdLen===5) unlockAchievement('wordle_hard');
  } else if(wdAttempts.length>=wdMaxTries){
    wdDone=true;
  }
  wdCurInput='';
  renderWordleGame();
};

window.wdBuyHint1=async function(){
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<5) return toast('❌ Нужно 5₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-5});
  await logTx(currentNick,{type:'out',who:'Угадай слово',amt:5,desc:'Подсказка: буква'});
  const candidates=[...new Set(wdWord.split(''))].filter(l=>!wdUsedLetters.has(l));
  if(!candidates.length) return toast('Все буквы уже подсказаны','gold');
  const hint=candidates[0];
  wdUsedLetters.add(hint);
  wdHint={type:'letter',value:hint};
  toast(`💡 Буква в слове: ${hint}`,'green');
  renderWordleGame();
};

window.wdBuyHint2=async function(){
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  if((u.balance||0)<10) return toast('❌ Нужно 10₽','red');
  await update(userRef(currentNick),{balance:(u.balance||0)-10});
  await logTx(currentNick,{type:'out',who:'Угадай слово',amt:10,desc:'Подсказка: буква+место'});
  const candidates=[];
  wdWord.split('').forEach((l,i)=>{
    if(!wdUsedPositions.has(i) && !wdAttempts.some(a=>a.letters[i]===l&&a.colors[i]==='green')){
      candidates.push({l,i});
    }
  });
  if(!candidates.length) return toast('Все позиции уже подсказаны','gold');
  const hint=candidates[0];
  wdUsedPositions.add(hint.i);
  wdHint={type:'position',value:{letter:hint.l,pos:hint.i}};
  toast(`🎯 Позиция ${hint.i+1} открыта`,'green');
  renderWordleGame();
};
// ══════════════════════════════════════════════════════════════════

// ─── ⚡ ИГРА: РЕАКЦИЯ ───────────────────────────────────────────
let reactionTimer=null,reactionStarted=false,reactionWaiting=false,reactionBest=null;

async function initReactionGame(){
  const owned=await checkGameOwned('reaction');
  const area=document.getElementById('reactionGameArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('reaction',29); return; }
  await recordGameStart('reaction');
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  reactionBest=(u.gameStats?.reactionBest)||null;
  renderReactionGame('idle');
}

function renderReactionGame(state,time){
  const area=document.getElementById('reactionGameArea'); if(!area) return;
  const bestHtml=reactionBest?`<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Твой рекорд: <span style="color:var(--gold);font-weight:900;">${reactionBest}мс</span></div>`:'';
  if(state==='idle'){
    area.innerHTML=`${bestHtml}<div class="reaction-btn-state" onclick="reactionStart()" style="width:200px;height:200px;border-radius:50%;background:var(--surface2);border:3px solid var(--border);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;font-weight:800;color:var(--muted);text-align:center;user-select:none;touch-action:manipulation;">Нажми, чтобы начать</div>`;
  } else if(state==='waiting'){
    area.innerHTML=`${bestHtml}<div class="reaction-btn-state" style="width:200px;height:200px;border-radius:50%;background:var(--red-dim);border:3px solid var(--red);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:var(--red);text-align:center;user-select:none;">⏳ Жди...</div>`;
  } else if(state==='go'){
    area.innerHTML=`${bestHtml}<div class="reaction-btn-state" onclick="reactionClick()" style="width:200px;height:200px;border-radius:50%;background:rgba(240,68,74,.25);border:3px solid var(--primary);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;font-weight:900;color:var(--primary);text-align:center;user-select:none;touch-action:manipulation;animation:pulse 0.4s infinite;">ЖМЯЯЯЙ!</div>`;
  } else if(state==='result'){
    const isRecord=!reactionBest||time<reactionBest;
    area.innerHTML=`<div style="text-align:center;margin-bottom:12px;">
      <div style="font-size:48px;font-weight:900;color:var(--primary);">${time}мс</div>
      ${isRecord?'<div style="font-size:14px;color:var(--gold);font-weight:900;margin:6px 0;">🏆 Новый рекорд!</div>':''}
      <div style="font-size:12px;color:var(--muted);">Рейтинг: ${time<200?'⚡ Молния':time<300?'🐇 Быстрый':time<500?'👍 Неплохо':'🐢 Можно лучше'}</div>
    </div>
    ${bestHtml}
    <button class="btn btn-primary" onclick="reactionStart()">🔄 Ещё раз</button>`;
  } else if(state==='toosoon'){
    area.innerHTML=`${bestHtml}<div style="text-align:center;color:var(--red);font-weight:800;font-size:16px;margin-bottom:16px;">⚠️ Слишком рано!</div><button class="btn btn-primary" onclick="reactionStart()">🔄 Попробовать снова</button>`;
  }
}

window.reactionStart=function(){
  if(reactionTimer) clearTimeout(reactionTimer);
  reactionStarted=false;reactionWaiting=true;
  renderReactionGame('waiting');
  const delay=1000+Math.random()*3000;
  reactionTimer=setTimeout(()=>{
    reactionWaiting=false;reactionStarted=true;
    window._reactionTs=Date.now();
    renderReactionGame('go');
  },delay);
};

window.reactionClick=async function(){
  if(!reactionStarted){
    if(reactionWaiting){clearTimeout(reactionTimer);reactionWaiting=false;renderReactionGame('toosoon');}
    return;
  }
  reactionStarted=false;
  const t=Date.now()-window._reactionTs;
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  const prev=(u.gameStats?.reactionBest)||null;
  if(!prev||t<prev){
    reactionBest=t;
    await update(userRef(currentNick),{'gameStats/reactionBest':t});
  }
  renderReactionGame('result',t);
};

// ─── 🔢 ИГРА: 2048 ────────────────────────────────────────────
let g2048=[],g2048Score=0,g2048Done=false,g2048Won=false,g2048TouchX=0,g2048TouchY=0;

async function init2048Game(){
  const owned=await checkGameOwned('game2048');
  const area=document.getElementById('game2048Area'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('game2048',39); return; }
  await recordGameStart('game2048');
  start2048();
}

function clone2048Board(board){ return board.map(row=>row.slice()); }
function transpose2048Board(board){ return board[0].map((_,c)=>board.map(row=>row[c])); }
function reverse2048Rows(board){ return board.map(row=>row.slice().reverse()); }

function slide2048Line(line){
  const nums = line.filter(v => v !== 0);
  const out = [];
  let gained = 0;
  for(let i=0;i<nums.length;i++){
    if(i < nums.length - 1 && nums[i] === nums[i+1]){
      const merged = nums[i] * 2;
      out.push(merged);
      gained += merged;
      i++;
    }else{
      out.push(nums[i]);
    }
  }
  while(out.length < 4) out.push(0);
  return { line: out, gained };
}

function start2048(){
  g2048 = Array.from({length:4}, () => Array(4).fill(0));
  g2048Score = 0;
  g2048Done = false;
  g2048Won = false;
  add2048Tile();
  add2048Tile();
  render2048();
}
window.start2048 = start2048;

function add2048Tile(){
  const empty = [];
  for(let r=0;r<4;r++) for(let c=0;c<4;c++) if(g2048[r][c] === 0) empty.push([r,c]);
  if(!empty.length) return false;
  const [r,c] = empty[Math.floor(Math.random()*empty.length)];
  g2048[r][c] = Math.random() < 0.9 ? 2 : 4;
  return true;
}

function can2048Move(board){
  for(let r=0;r<4;r++){
    for(let c=0;c<4;c++){
      if(board[r][c] === 0) return true;
      if(c < 3 && board[r][c] === board[r][c+1]) return true;
      if(r < 3 && board[r][c] === board[r+1][c]) return true;
    }
  }
  return false;
}

function boardMoved(a,b){ return JSON.stringify(a) !== JSON.stringify(b); }

function move2048(dir){
  if(g2048Done) return false;
  let board = clone2048Board(g2048);

  if(dir === 'ArrowRight'){
    board = reverse2048Rows(board);
  }else if(dir === 'ArrowUp'){
    board = transpose2048Board(board);
  }else if(dir === 'ArrowDown'){
    board = transpose2048Board(board);
    board = reverse2048Rows(board);
  }else if(dir !== 'ArrowLeft'){
    return false;
  }

  const before = clone2048Board(board);
  let gained = 0;
  board = board.map(row => {
    const res = slide2048Line(row);
    gained += res.gained;
    return res.line;
  });

  if(dir === 'ArrowRight'){
    board = reverse2048Rows(board);
  }else if(dir === 'ArrowUp'){
    board = transpose2048Board(board);
  }else if(dir === 'ArrowDown'){
    board = reverse2048Rows(board);
    board = transpose2048Board(board);
  }

  if(!boardMoved(before, board)) return false;

  g2048 = board;
  g2048Score += gained;
  add2048Tile();

  if(!g2048Won && g2048.flat().includes(2048)){
    g2048Won = true;
    toast('🎉 Ты набрал 2048!','gold');
  }

  if(!can2048Move(g2048)){
    g2048Done = true;
    toast('Игра окончена! Дальше ходов нет.','red');
  }

  get(userRef(currentNick)).then(snap=>{
    const u=snap.val()||{};
    const prev=(u.gameStats?.g2048Best||0);
    if(g2048Score>prev) update(userRef(currentNick),{'gameStats/g2048Best':g2048Score});
  });

  render2048();
  return true;
}
window.move2048 = move2048;

window.g2048TS = function(e){
  if(!e.touches || !e.touches[0]) return;
  g2048TouchX = e.touches[0].clientX;
  g2048TouchY = e.touches[0].clientY;
};

window.g2048TE = function(e){
  if(g2048Done) return;
  if(!e.changedTouches || !e.changedTouches[0]) return;
  const dx = e.changedTouches[0].clientX - g2048TouchX;
  const dy = e.changedTouches[0].clientY - g2048TouchY;
  if(Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if(Math.abs(dx) > Math.abs(dy)){
    move2048(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
  }else{
    move2048(dy > 0 ? 'ArrowDown' : 'ArrowUp');
  }
};

window.addEventListener('keydown', (e) => {
  if(curPage !== 'game2048Section' || g2048Done) return;
  const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
  if(['INPUT','TEXTAREA','SELECT'].includes(tag) || e.isComposing) return;
  const keyMap = {
    ArrowLeft:'ArrowLeft',
    ArrowRight:'ArrowRight',
    ArrowUp:'ArrowUp',
    ArrowDown:'ArrowDown',
    a:'ArrowLeft',
    A:'ArrowLeft',
    d:'ArrowRight',
    D:'ArrowRight',
    w:'ArrowUp',
    W:'ArrowUp',
    s:'ArrowDown',
    S:'ArrowDown',
  };
  const dir = keyMap[e.key];
  if(dir){
    e.preventDefault();
    move2048(dir);
  }
});

function render2048(){
  const area=document.getElementById('game2048Area'); if(!area) return;
  const colors={0:'var(--surface2)',2:'#eee4da',4:'#ede0c8',8:'#f2b179',16:'#f59563',32:'#f67c5f',64:'#f65e3b',128:'#edcf72',256:'#edcc61',512:'#edc850',1024:'#edc53f',2048:'#edc22e'};
  const cellHtml=g2048.map(row=>row.map(v=>`<div style="width:64px;height:64px;border-radius:8px;background:${colors[v]||'#3c3a32'};display:flex;align-items:center;justify-content:center;font-size:${v>99?(v>999?14:16):20}px;font-weight:900;color:${v>4?'#f9f6f2':'#776e65'};">${v||''}</div>`).join('')).join('');
  area.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 16px;text-align:center;min-width:96px;"><div style="font-size:18px;font-weight:900;color:var(--primary);">${g2048Score}</div><div style="font-size:9px;color:var(--muted);">Очки</div></div>
      <button class="btn btn-ghost btn-sm" onclick="start2048()">🔄 Новая</button>
    </div>
    <div id="g2048grid" tabindex="0" style="display:grid;grid-template-columns:repeat(4,64px);gap:4px;margin:0 auto 12px;width:fit-content;background:var(--surface);border:2px solid var(--border);padding:6px;border-radius:var(--r-sm);touch-action:none;user-select:none;"
      ontouchstart="g2048TS(event)" ontouchend="g2048TE(event)">${cellHtml}</div>
    <div style="display:grid;grid-template-columns:repeat(3,52px);gap:6px;justify-content:center;margin-bottom:12px;">
      <div></div><button class="btn btn-ghost btn-sm" style="padding:10px 0;" onclick="move2048('ArrowUp')">▲</button><div></div>
      <button class="btn btn-ghost btn-sm" style="padding:10px 0;" onclick="move2048('ArrowLeft')">◄</button>
      <button class="btn btn-primary btn-sm" style="padding:10px 0;" onclick="start2048()">⟳</button>
      <button class="btn btn-ghost btn-sm" style="padding:10px 0;" onclick="move2048('ArrowRight')">►</button>
      <div></div><button class="btn btn-ghost btn-sm" style="padding:10px 0;" onclick="move2048('ArrowDown')">▼</button><div></div>
    </div>
    <div style="font-size:11px;color:var(--muted);text-align:center;">Свайп, стрелки или кнопки для управления</div>
    ${g2048Won?'<div style="text-align:center;margin-top:10px;font-size:14px;font-weight:900;color:var(--gold);">Есть 2048 — можно продолжать дальше!</div>':''}
    ${g2048Done?'<div style="text-align:center;margin-top:8px;font-size:16px;font-weight:900;color:var(--red);">Игра окончена!</div>':''}
  `;
}

async function initSnakeGame(){
  const owned=await checkGameOwned('snake');
  const area=document.getElementById('gameSnakeArea'); if(!area) return;
  if(!owned){ area.innerHTML=gameLockedHTML('snake',29); return; }
  await recordGameStart('snake');
  renderSnakeSetup();
}

function snakeDrawFrame(){
  const canvas=document.getElementById('snakeCanvas');if(!canvas)return;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='rgba(12,17,23,0.9)';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#f87171';
  ctx.beginPath();ctx.arc(snakeFood.x*SNAKE_CELL+SNAKE_CELL/2,snakeFood.y*SNAKE_CELL+SNAKE_CELL/2,SNAKE_CELL/2-2,0,Math.PI*2);ctx.fill();
  snakeBody.forEach((s,i)=>{
    ctx.fillStyle=i===0?'#f0444a':'#a71924';
    ctx.beginPath();ctx.roundRect(s.x*SNAKE_CELL+1,s.y*SNAKE_CELL+1,SNAKE_CELL-2,SNAKE_CELL-2,4);ctx.fill();
  });
}

const SNAKE_W=16,SNAKE_H=16,SNAKE_CELL=20;
let snakeBody=[],snakeDir={x:1,y:0},snakeFood={x:5,y:5},snakeScore=0,snakeRunning=false,snakeRAF2=null,snakeLastTime=0,snakeSpeed=150,snakeNextDir=null,snakeGameOverFlag=false;

function renderSnakeSetup(){
  const area=document.getElementById('gameSnakeArea'); if(!area) return;
  area.innerHTML=`
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:10px;">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 16px;text-align:center;"><div id="snakeScoreEl" style="font-size:18px;font-weight:900;color:var(--primary);">0</div><div style="font-size:9px;color:var(--muted);">Очки</div></div>
    </div>
    <canvas id="snakeCanvas" width="${SNAKE_W*SNAKE_CELL}" height="${SNAKE_H*SNAKE_CELL}" style="border-radius:12px;border:1px solid var(--border);background:var(--surface2);display:block;margin:0 auto 10px;touch-action:none;"></canvas>
    <div style="display:grid;grid-template-columns:repeat(3,52px);gap:4px;margin:0 auto 10px;width:fit-content;">
      <div></div><button class="btn btn-ghost btn-sm" style="padding:10px;" onclick="snakeSetDir(0,-1)">▲</button><div></div>
      <button class="btn btn-ghost btn-sm" style="padding:10px;" onclick="snakeSetDir(-1,0)">◄</button>
      <button class="btn btn-primary btn-sm" style="padding:10px;" onclick="snakeToggle()">▶</button>
      <button class="btn btn-ghost btn-sm" style="padding:10px;" onclick="snakeSetDir(1,0)">►</button>
      <div></div><button class="btn btn-ghost btn-sm" style="padding:10px;" onclick="snakeSetDir(0,1)">▼</button><div></div>
    </div>
    <div id="snakeMsg" style="font-size:13px;text-align:center;color:var(--muted);min-height:20px;margin-bottom:8px;">Нажми ▶ для старта</div>
  `;
  snakeStartNew();
  let sx=0,sy=0;
  const canvas=document.getElementById('snakeCanvas');
  canvas?.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY;},{passive:true});
  canvas?.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)>Math.abs(dy)){snakeSetDir(dx>0?1:-1,0);}else{snakeSetDir(0,dy>0?1:-1);}
  });
}

function snakeStartNew(){
  snakeBody=[{x:8,y:8},{x:7,y:8},{x:6,y:8}];
  snakeDir={x:1,y:0};snakeNextDir=null;
  snakeScore=0;snakeRunning=false;snakeSpeed=150;snakeGameOverFlag=false;
  snakePlaceFood();snakeDrawFrame();
  const msg=document.getElementById('snakeMsg');if(msg)msg.textContent='Нажми ▶ для старта';
  const sc=document.getElementById('snakeScoreEl');if(sc)sc.textContent='0';
}

function snakePlaceFood(){
  do{snakeFood={x:Math.floor(Math.random()*SNAKE_W),y:Math.floor(Math.random()*SNAKE_H)};}
  while(snakeBody.some(s=>s.x===snakeFood.x&&s.y===snakeFood.y));
}

window.snakeToggle=function(){
  if(snakeGameOverFlag) return;
  if(snakeRunning){snakeRunning=false;if(snakeRAF2){cancelAnimationFrame(snakeRAF2);snakeRAF2=null;}const msg=document.getElementById('snakeMsg');if(msg)msg.textContent='Пауза';}
  else{snakeRunning=true;snakeLastTime=0;snakeRAF2=requestAnimationFrame(snakeLoop);}
};

window.snakeSetDir=function(x,y){
  if(snakeGameOverFlag) return;
  if(x===1&&snakeDir.x===-1)return;if(x===-1&&snakeDir.x===1)return;
  if(y===1&&snakeDir.y===-1)return;if(y===-1&&snakeDir.y===1)return;
  snakeNextDir={x,y};
  if(!snakeRunning)snakeToggle();
};

function snakeLoop(ts){
  if(!snakeRunning)return;
  if(!snakeLastTime)snakeLastTime=ts;
  if(ts-snakeLastTime>=snakeSpeed){
    snakeLastTime=ts;
    if(snakeNextDir){snakeDir=snakeNextDir;snakeNextDir=null;}
    const head={x:snakeBody[0].x+snakeDir.x,y:snakeBody[0].y+snakeDir.y};
    if(head.x<0||head.x>=SNAKE_W||head.y<0||head.y>=SNAKE_H){snakeGameOver();return;}
    if(snakeBody.some(s=>s.x===head.x&&s.y===head.y)){snakeGameOver();return;}
    snakeBody.unshift(head);
    if(head.x===snakeFood.x&&head.y===snakeFood.y){
      snakeScore+=10;snakeSpeed=Math.max(60,snakeSpeed-2);
      const sc=document.getElementById('snakeScoreEl');if(sc)sc.textContent=snakeScore;
      snakePlaceFood();
    } else {snakeBody.pop();}
    snakeDrawFrame();
  }
  snakeRAF2=requestAnimationFrame(snakeLoop);
}

async function snakeGameOver(){
  snakeRunning=false;snakeGameOverFlag=true;if(snakeRAF2){cancelAnimationFrame(snakeRAF2);snakeRAF2=null;}
  const msg=document.getElementById('snakeMsg');
  if(msg)msg.innerHTML=`💀 Игра окончена! Счёт: ${snakeScore} <button class="btn btn-primary btn-sm" onclick="snakeStartNew();document.getElementById('snakeMsg').textContent='Нажми ▶ для старта'" style="margin-left:8px;">🔄 Снова</button>`;
  const snap=await get(userRef(currentNick));const u=snap.val()||{};
  const prev=(u.gameStats||{}).snakeBest||0;
  if(snakeScore>prev) await update(userRef(currentNick),{'gameStats/snakeBest':snakeScore});
}

const bizItemRef = (id) => ref(db, `businesses/${id}`);
const bizAppsRef = () => ref(db, 'businessApps');
const bizAppRef = (id) => ref(db, `businessApps/${id}`);

let currentBizId = null;
// Keep the legacy inline onclick handlers working: top-level module variables are not
// properties of window, so expose a tiny synchronized bridge for existing UI markup.
try {
    Object.defineProperty(window, 'currentBizId', { configurable:true, get:()=>currentBizId, set:v=>{ currentBizId=v||null; } });
} catch(e) { window.currentBizId = null; }
let currentBizDetailData = null;
let allBusinessesCache = {};
let bizCarts = {};
let _bizEditIconData = null;
let _bizEditBannerData = null;
let _bizProdPhotoData = null;
let _rentBuildingPhotoData = null;


let businessLocationMap=null, businessLocationMarker=null;
let deliveryLocationMap=null, deliveryLocationMarker=null;
let _businessLocationMode='create';
async function ensureMapModal(id,title,initialLat,initialLng,saveFn){
    await window.kapaniLoadLeaflet();
    let modal=qs(id);
    if(!modal){
        modal=document.createElement('div'); modal.id=id;
        modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9998;display:flex;align-items:center;justify-content:center;padding:14px;';
        modal.innerHTML=`<div style="width:100%;max-width:600px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:14px;box-shadow:var(--shadow);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><b style="font-size:16px;">${title}</b><button class="btn btn-ghost btn-sm" onclick="this.closest('#${id}').style.display='none'">✕</button></div>
            <div id="${id}Map" style="height:360px;border-radius:14px;overflow:hidden;"></div>
            <div id="${id}Coords" style="font-size:11px;color:var(--muted);margin:8px 0;"></div>
            <div style="display:flex;gap:8px;"><button type="button" class="btn btn-primary" data-location-save="1" style="flex:1;">✅ Сохранить точку</button><button type="button" class="btn btn-ghost" style="flex:1;" onclick="this.closest('#${id}').style.display='none'">Отмена</button></div>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.style.display='flex';
    await new Promise(r=>requestAnimationFrame(r));
    const host=qs(id+"Map"); if(!host) return;
    const isBusinessPicker = id === 'bizLocationPicker';
    const fallbackLat = isBusinessPicker ? BUSINESS_DEFAULT_LAT : BUSINESS_DEFAULT_LAT;
    const fallbackLng = isBusinessPicker ? BUSINESS_DEFAULT_LNG : BUSINESS_DEFAULT_LNG;
    const saveBtn = modal.querySelector('[data-location-save="1"]');
    if(saveBtn && !saveBtn.dataset.bound){
        saveBtn.dataset.bound='1';
        saveBtn.addEventListener('click', (ev)=>{
            ev.preventDefault(); ev.stopPropagation();
            try { const fn=window[saveFn]; if(typeof fn==='function') fn(); else toast('❌ Функция сохранения точки не найдена','red'); }
            catch(e){ console.error('[location picker save]',e); toast('❌ Не удалось сохранить точку: '+(e?.message||'ошибка'),'red'); }
        });
    }
    const lat=Number.isFinite(Number(initialLat))?Number(initialLat):fallbackLat;
    const lng=Number.isFinite(Number(initialLng))?Number(initialLng):fallbackLng;
    const state={lat,lng};
    modal._locationState=state;
    const mapVar=id==='bizLocationPicker'?'businessLocationMap':'deliveryLocationMap';
    const markerVar=id==='bizLocationPicker'?'businessLocationMarker':'deliveryLocationMarker';
    if(globalThis[mapVar]){try{globalThis[mapVar].remove()}catch(e){}}
    globalThis[mapVar]=L.map(host,{center:[lat,lng],zoom:(Number.isFinite(Number(initialLat))&&Number.isFinite(Number(initialLng)))?17:14});
    addSatelliteLayer(globalThis[mapVar]);
    globalThis[markerVar]=L.marker([lat,lng],{draggable:true}).addTo(globalThis[mapVar]);
    const update=()=>{
        const ll=globalThis[markerVar].getLatLng(); state.lat=ll.lat; state.lng=ll.lng;
        const c=qs(id+"Coords"); if(c)c.textContent=`📍 ${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
    };
    globalThis[mapVar].on('click',e=>{globalThis[markerVar].setLatLng(e.latlng);update();});
    globalThis[markerVar].on('dragend',update);
    update();
}
window.openBusinessLocationPicker=async function(mode){
    _businessLocationMode=mode||'create';
    // Business location picker always opens at the Kapani base point requested by the project.
    // Existing saved coordinates are not overwritten until the user explicitly presses Save.
    const lat=BUSINESS_DEFAULT_LAT;
    const lng=BUSINESS_DEFAULT_LNG;
    await ensureMapModal('bizLocationPicker','🗺 Точка бизнеса',lat,lng,'saveBusinessLocationPicker');
};
window.saveBusinessLocationPicker=async function(){
    const modal=qs('bizLocationPicker');
    if(!modal) return toast('❌ Окно выбора точки не найдено','red');
    const marker=globalThis.businessLocationMarker;
    const state=modal._locationState || {};
    if(marker?.getLatLng){ const ll=marker.getLatLng(); state.lat=ll.lat; state.lng=ll.lng; modal._locationState=state; }
    const lat=Number(state.lat), lng=Number(state.lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)) return toast('⚠️ Сначала выберите точку на карте','gold');
    const ids=_businessLocationMode==='edit'?['bizEditLat','bizEditLng','bizEditLocationPreview']:['bapLat','bapLng','bapLocationPreview'];
    const latEl=qs(ids[0]), lngEl=qs(ids[1]), preview=qs(ids[2]);
    if(!latEl||!lngEl) return toast('❌ Поля координат бизнеса не найдены','red');
    latEl.value=String(lat); lngEl.value=String(lng);
    if(preview) preview.textContent=`📍 ${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    // In edit mode persist the point immediately to the real business record.
    // This avoids the old situation where coordinates only lived in hidden inputs
    // until the owner saved the entire business form.
    if(_businessLocationMode==='edit'){
        const bizId=currentBizId || window.currentBizId;
        if(!bizId) return toast('❌ Не выбран бизнес для сохранения точки','red');
        try{
            await update(bizItemRef(bizId), {lat, lng, address: (qs('bizEditAddress')?.value||'').trim() || `${lat.toFixed(6)}, ${lng.toFixed(6)}`});
            if(allBusinessesCache) allBusinessesCache[bizId] = {...(allBusinessesCache[bizId]||{}), lat, lng};
            currentBizDetailData = currentBizDetailData ? {...currentBizDetailData, lat, lng} : currentBizDetailData;
            modal.style.display='none';
            toast('✅ Точка бизнеса сохранена','green');
            // Refresh owner/public views using the same database coordinates.
            if(curPage==='bizOwnerPanel' && typeof window.renderBizOwnerPanel==='function') await window.renderBizOwnerPanel(bizId);
            return;
        }catch(e){
            console.error('[save business location]',e);
            return toast('❌ Не удалось сохранить точку','red');
        }
    }

    modal.style.display='none';
    toast('✅ Точка сохранена в форме бизнеса','green');
};
window.openDeliveryLocationPicker=async function(){
    // Delivery picker opens at the same fixed Kapani point as the business picker.
    // The selected point is written only when the user confirms the picker.
    const lat=BUSINESS_DEFAULT_LAT;
    const lng=BUSINESS_DEFAULT_LNG;
    if(qs('deliveryOrderLat')) qs('deliveryOrderLat').value=String(lat);
    if(qs('deliveryOrderLng')) qs('deliveryOrderLng').value=String(lng);
    await ensureMapModal('deliveryLocationPicker','🗺 Точка доставки',lat,lng,'saveDeliveryLocationPicker');
};
window.saveDeliveryLocationPicker=function(){
    const state=qs('deliveryLocationPicker')?._locationState; if(!state) return;
    qs('deliveryOrderLat').value=state.lat; qs('deliveryOrderLng').value=state.lng;
    qs('deliveryLocationPreview').textContent=`📍 ${state.lat.toFixed(6)}, ${state.lng.toFixed(6)}`;
    const addr=qs('deliveryOrderAddr'); if(addr&&!addr.value.trim()) addr.value=`${state.lat.toFixed(6)}, ${state.lng.toFixed(6)}`;
    qs('deliveryLocationPicker').style.display='none';
    updateDeliverySummary();
    renderBusinessDeliveryMap().catch(e=>console.warn('[delivery business map]',e));
};
async function initBusinessDetailLocationMap(b){
    const host=qs('bizDetailLocationMap'); if(!host) return;
    if(!host.style.position) host.style.position='relative';
    await window.kapaniLoadLeaflet();
    if(host._map){try{host._map.remove()}catch(e){}}
    const normLat = Number(b?.lat ?? b?.businessLat ?? b?.locationLat);
    const normLng = Number(b?.lng ?? b?.businessLng ?? b?.locationLng);
    const hasPoint=Number.isFinite(normLat)&&Number.isFinite(normLng);
    const center=hasPoint?[normLat,normLng]:[BUSINESS_DEFAULT_LAT,BUSINESS_DEFAULT_LNG];
    const map=L.map(host,{center,zoom:15});
    host._map=map; addSatelliteLayer(map);
    if(hasPoint) L.marker(center).addTo(map).bindPopup(`<b>${escHtml(b.name||'Бизнес')}</b><br>${escHtml(b.address||'')}`).openPopup();
    else host.insertAdjacentHTML('beforeend','<div style="position:absolute;z-index:500;left:10px;bottom:10px;background:rgba(10,15,20,.82);padding:7px 10px;border-radius:8px;color:var(--muted);font-size:11px;">📍 Базовая точка Kapani: 52.628433, 38.417049</div>');
}
// ─── BIZ APPLY MODAL ─────────────────────────
window.openBizApplyModal = async function(){
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const appsSnap = await get(bizAppsRef());
    const apps = appsSnap.val() || {};
    const myPending = Object.values(apps).find(a => a.owner === currentNick && a.status === 'pending');
    if(myPending){ return toast('⏳ Ваша заявка уже на рассмотрении','gold'); }
    const limit = getBusinessLimitForUser(u);
    const ownedCount = getBusinessIds(u).length;
    if(ownedCount >= limit){
        return toast(`⚠️ У вас уже ${ownedCount}/${limit} бизнес${ownedCount === 1 ? '' : 'ов'}. Лимит подписки достигнут.`, 'gold');
    }
    // Clear and show modal
    ['bapName','bapDesc','bapAddress','bapCategory','bapServices','bapLat','bapLng'].forEach(id=>{ const el=qs(id); if(el) el.value=''; });
     if(qs('bapLocationPreview')) qs('bapLocationPreview').textContent='📍 Точка не выбрана';
    const hasUltraBizModal = (u.subscription === 'ultra') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasPrimeBizModal = (u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const feeEl = qs('bizFeeDisplay'); if(feeEl) feeEl.textContent = hasPrimeBizModal ? '1250 ₽' : (hasUltraBizModal ? '2000 ₽' : '2500 ₽');
    qs('bizApplyModal').style.display = 'block';
};
window.closeBizApplyModal = function(){ qs('bizApplyModal').style.display='none'; };
let _submitBizApplyBusy = false;
window.submitBizApply = async function(){
    if(_submitBizApplyBusy) return toast('⏳ Заявка уже отправляется…','gold');
    _submitBizApplyBusy = true;
    try {
    const name = (qs('bapName')?.value||'').trim();
    const desc = (qs('bapDesc')?.value||'').trim();
    const address = (qs('bapAddress')?.value||'').trim();
    const category = (qs('bapCategory')?.value||'Услуги').trim();
    const services = (qs('bapServices')?.value||'').trim();
    const lat = Number(qs('bapLat')?.value);
    const lng = Number(qs('bapLng')?.value);
    if(!name) return toast('⚠️ Укажите название','gold');
    if(!desc) return toast('⚠️ Укажите описание','gold');
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return toast('🗺 Выберите точку бизнеса на карте','gold');
    const normalizedAddress = address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const uSnap = await get(userRef(currentNick));
    const u = uSnap.val() || {};
    const limit = getBusinessLimitForUser(u);
    const ownedCount = getBusinessIds(u).length;
    if(ownedCount >= limit){
        return toast(`⚠️ У вас уже ${ownedCount}/${limit} бизнес${ownedCount === 1 ? '' : 'ов'}.`, 'gold');
    }
    const hasUltraForBiz = (u.subscription === 'ultra') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasPrimeForBiz = (u.subscription === 'prime') && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const actualFee = hasPrimeForBiz ? 1250 : (hasUltraForBiz ? 2000 : ECONOMY_BUSINESS_CREATION_FEE);
    if((u.balance || 0) < actualFee) return toast(`❌ Для создания бизнеса нужно ${actualFee}₽ госпошлины`,'red');
    const id = genId();
    const updatedBizBalance = Number(u.balance || 0) - actualFee;
    await update(userRef(currentNick), { balance: updatedBizBalance });
    await logTx(currentNick, { type:'out', who:'Госпошлина', amt:actualFee, desc:`Госпошлина за создание бизнеса${hasPrimeForBiz ? ' (Prime -50%)' : (hasUltraForBiz ? ' (Ultra -20%)' : '')}` });
    await pushNotification(currentNick, `🏛 Списана госпошлина ${actualFee}₽ за заявку на бизнес${hasPrimeForBiz ? ' (скидка Prime)' : (hasUltraForBiz ? ' (скидка Ultra)' : '')}`, 'money');
    await set(bizAppRef(id), {
        id, owner: currentNick, name, desc, address: normalizedAddress, lat, lng, category, services,
        status: 'pending', createdAt: Date.now(), feePaid: actualFee
    });
    await pushNotification(ADMIN, `🏪 Новая заявка на бизнес от ${currentNick}: «${name}»`, 'system');
    closeBizApplyModal();
    toast('📋 Заявка отправлена в мэрию!', 'green');
    if(curPage==='bizOwnerPanel') renderBizOwnerPanel();
    } finally {
        _submitBizApplyBusy = false;
    }
};

// ─── BIZ DELETE REQUEST ───────────────────────
let _pendingDeleteBizId = null;
window.openBizDeleteRequestModal = function(bizId){
    _pendingDeleteBizId = bizId;
    const el = qs('bizDeleteReason'); if(el) el.value='';
    qs('bizDeleteRequestModal').style.display = 'block';
};
window.closeBizDeleteRequestModal = function(){ qs('bizDeleteRequestModal').style.display='none'; _pendingDeleteBizId=null; };
window.submitBizDeleteRequest = async function(){
    const reason = (qs('bizDeleteReason')?.value||'').trim();
    if(!reason) return toast('⚠️ Укажите причину','gold');
    const bizId = _pendingDeleteBizId; if(!bizId) return;
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    const reqId = genId();
    await set(ref(db,`bizDeleteRequests/${reqId}`), {
        id: reqId, bizId, bizName: b.name, owner: currentNick, reason, status: 'pending', createdAt: Date.now()
    });
    await pushNotification(ADMIN, `🗑 ${currentNick} просит закрыть бизнес «${b.name}»: ${reason}`, 'system');
    closeBizDeleteRequestModal();
    toast('📋 Заявка на закрытие отправлена в мэрию', 'gold');
};
// Admin delete biz directly
window.adminDeleteBiz = async function(bizId){
    if(currentNick !== ADMIN) return;
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    if(!confirm(`Удалить бизнес «${b.name}»? Это необратимо.`)) return;
    await update(bizItemRef(bizId), { status: 'deleted', deletedAt: Date.now(), deletedBy: ADMIN });
    // Remove businessId from owner
    if(b.owner){
        const ownerSnap = await get(userRef(b.owner));
        const owner = ownerSnap.val() || {};
        const businessIds = getBusinessIds(owner).filter(id => id !== bizId);
        const ownerUpdate = { businessIds, businessId: businessIds[0] || null, employerBizId: null, job: 'Житель' };
        await update(userRef(b.owner), ownerUpdate);
    }
    if(b.owner) await pushNotification(b.owner, `🗑 Ваш бизнес «${b.name}» закрыт мэрией.`, 'system');
    toast(`🗑 Бизнес «${b.name}» закрыт`, 'red');
    renderBusinesses();
};

// ─── ADMIN: BIZ DELETE REQUESTS ──────────────
async function renderAdminBizDeleteReqs(){
    const el = qs('adminBizDeleteReqs'); if(!el) return;
    const snap = await get(ref(db,'bizDeleteRequests'));
    const reqs = Object.values(snap.val()||{}).filter(r=>r.status==='pending');
    if(!reqs.length){ el.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет заявок</div>'; return; }
    el.innerHTML = reqs.map(r=>`
        <div class="submission-card">
            <div style="font-weight:900;font-size:15px;margin-bottom:4px;">🗑 ${escHtml(r.bizName)}</div>
            <div style="font-size:12px;color:var(--muted);">Владелец: <b>${escHtml(r.owner)}</b></div>
            <div style="font-size:13px;margin:6px 0;color:var(--text);">Причина: ${escHtml(r.reason)}</div>
            <div class="admin-action-grid" style="margin-top:10px;">
                <button class="btn btn-red btn-sm" onclick="adminApproveBizDelete('${jsEsc(r.id)}','${jsEsc(r.bizId)}')">✅ Одобрить закрытие</button>
                <button class="btn btn-ghost btn-sm" onclick="adminRejectBizDelete('${jsEsc(r.id)}','${jsEsc(r.bizId)}')">❌ Отклонить</button>
            </div>
        </div>`).join('');
}
window.adminApproveBizDelete = async function(reqId, bizId){
    if(currentNick!==ADMIN) return;
    const [rSnap, bSnap] = await Promise.all([get(ref(db,`bizDeleteRequests/${reqId}`)), get(bizItemRef(bizId))]);
    if(!rSnap.exists()||!bSnap.exists()) return;
    const r=rSnap.val(), b=bSnap.val();
    await update(bizItemRef(bizId), { status:'deleted', deletedAt:Date.now(), deletedBy:ADMIN });
    if(b.owner){
        const ownerSnap = await get(userRef(b.owner));
        const owner = ownerSnap.val() || {};
        const businessIds = getBusinessIds(owner).filter(id => id !== bizId);
        await update(userRef(b.owner), { businessIds, businessId: businessIds[0] || null, job:'Житель' });
    }
    await update(ref(db,`bizDeleteRequests/${reqId}`), { status:'approved' });
    if(b.owner) await pushNotification(b.owner, `✅ Ваш бизнес «${b.name}» закрыт по вашей заявке.`, 'system');
    toast(`✅ Бизнес «${b.name}» закрыт`, 'red');
    renderAdminBizDeleteReqs();
    renderBusinesses();
};
window.adminRejectBizDelete = async function(reqId, bizId){
    if(currentNick!==ADMIN) return;
    const rSnap = await get(ref(db,`bizDeleteRequests/${reqId}`)); if(!rSnap.exists()) return;
    const r=rSnap.val();
    await update(ref(db,`bizDeleteRequests/${reqId}`), { status:'rejected' });
    await pushNotification(r.owner, `❌ Заявка на закрытие бизнеса «${r.bizName}» отклонена мэрией.`, 'system');
    toast('❌ Отклонено', 'gold');
    renderAdminBizDeleteReqs();
};


// ─── ADMIN: RENDER BIZ APPS ───────────────
let _adminBizAppsCache = null;
async function renderAdminBizApps(forceFetch){
    const el = qs('adminBizApps'); if(!el) return;
    if(forceFetch || !_adminBizAppsCache){
        const snap = await get(bizAppsRef());
        _adminBizAppsCache = snap.val() || {};
    }
    const apps = Object.values(_adminBizAppsCache).filter(a => a.status === 'pending');
    if(!apps.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет заявок</div>'; return; }
    el.innerHTML = apps.map(a => `
        <div class="submission-card">
            <div style="font-weight:900;font-size:15px;margin-bottom:4px;">🏪 ${escHtml(a.name)}</div>
            <div style="font-size:12px;color:var(--muted);">Владелец: <b>${escHtml(a.owner)}</b> · ${escHtml(a.category)}</div>
            <div style="font-size:13px;margin:6px 0;">${escHtml(a.desc)}</div>
            <div style="font-size:12px;color:var(--muted);">📍 ${escHtml(a.address)}</div>
            ${a.services ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;">Услуги: ${escHtml(a.services)}</div>` : ''}
            <div class="admin-action-grid" style="margin-top:10px;">
                <button class="btn btn-primary btn-sm" onclick="adminApproveBiz('${jsEsc(a.id)}')">✅ Одобрить</button>
                <button class="btn btn-red btn-sm" onclick="adminRejectBiz('${jsEsc(a.id)}')">❌ Отклонить</button>
            </div>
        </div>`).join('');
}
window.adminApproveBiz = async function(id){
    if(currentNick !== ADMIN) return;
    const snap = await get(bizAppRef(id)); if(!snap.exists()) return;
    const a = snap.val();
    const bizId = genId();
    await set(bizItemRef(bizId), {
        id: bizId, owner: a.owner, name: a.name, desc: a.desc,
        address: a.address, ...(Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lng))?{lat:Number(a.lat),lng:Number(a.lng)}:{}), category: a.category, services: a.services,
        icon: '', banner: '', balance: 0, delivery: false,
        roles: {}, employees: {}, products: {},
        createdAt: Date.now(), bizWeeklyFeeAt: Date.now(), status: 'active'
    });

    const ownerSnap = await get(userRef(a.owner));
    const owner = ownerSnap.val() || {};
    const businessIds = getBusinessIds(owner);
    if(!businessIds.includes(bizId)) businessIds.push(bizId);
    const ownerUpdate = { businessIds, businessId: businessIds[0] || bizId };
    if(!owner.businessId) ownerUpdate.businessId = bizId;
    await update(userRef(a.owner), ownerUpdate);

    await update(bizAppRef(id), { status: 'approved' });
    // Update the local admin-apps cache in place instead of re-reading the
    // whole businessApps branch again.
    if(_adminBizAppsCache?.[id]) _adminBizAppsCache[id].status = 'approved';
    await pushNotification(a.owner, `🎉 Ваш бизнес «${a.name}» одобрен мэрией!`, 'system');
    toast(`✅ Бизнес «${a.name}» одобрен`, 'green');
    renderAdminBizApps();
};
window.adminRejectBiz = async function(id){
    if(currentNick !== ADMIN) return;
    const snap = await get(bizAppRef(id)); if(!snap.exists()) return;
    const a = snap.val();
    await update(bizAppRef(id), { status: 'rejected' });
    if(_adminBizAppsCache?.[id]) _adminBizAppsCache[id].status = 'rejected';
    await pushNotification(a.owner, `❌ Заявка на бизнес «${a.name}» отклонена мэрией.`, 'system');
    toast('❌ Отклонено', 'red');
    renderAdminBizApps();
};

// ─── BUSINESSES LIST ──────────────────────
async function renderBusinesses(){
    const el = qs('bizList'); if(!el) return;

    // /businesses is already kept live by the 'business' service listener
    // (attached in enterService), which populates allBusinessesCache on every
    // update. Reuse that cache instead of doing another full get(bizRef())
    // on every render — only fall back to a one-off fetch if the cache is
    // genuinely empty (e.g. this render runs before the listener's first
    // snapshot has arrived).
    let biznesesRaw = allBusinessesCache;
    if(!biznesesRaw || !Object.keys(biznesesRaw).length){
        el.innerHTML = loadingHtml('Загружаем бизнесы...');
        const snap = await get(bizRef());
        biznesesRaw = snap.val() || {};
        allBusinessesCache = biznesesRaw;
        window.allBusinessesCache = allBusinessesCache;
    }
    const bizneses = Object.values(biznesesRaw).filter(b => b.status === 'active')
        .sort((a,b)=>Number(Number(b.promotedUntil||0) > Date.now()) - Number(Number(a.promotedUntil||0) > Date.now()));
    // currentNick's own user record is kept live by attachUserListener()
    // (allUsersCache[currentNick]); reuse it instead of a fresh get() here.
    const u = allUsersCache?.[currentNick] || (await get(userRef(currentNick))).val() || {};
    const myBizPanel = qs('myBizPanel');
    const ownedLimit = getBusinessLimitForUser(u);
    const ownedBizs = bizneses.filter(b => b.owner === currentNick);

    if(ownedBizs.length){
        myBizPanel.style.display = 'block';
        myBizPanel.innerHTML = `
            <div class="card" style="border-color:rgba(240,68,74,.3);background:rgba(240,68,74,.05);">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
                    <div>
                        <div style="font-weight:900;font-size:15px;">Мои бизнесы</div>
                        <div style="font-size:12px;color:var(--muted);">${ownedBizs.length}/${ownedLimit} по подписке</div>
                    </div>
                    <div style="font-size:12px;font-weight:800;color:var(--primary);">🏪 ${ownedBizs.length} шт.</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    ${ownedBizs.map(b => `
                        <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:14px;">
                            ${b.icon ? `<img loading="lazy" decoding="async" src="${escHtml(b.icon)}" style="width:44px;height:44px;border-radius:14px;object-fit:cover;border:2px solid var(--primary);">` : '<div style="width:44px;height:44px;border-radius:14px;background:var(--surface2);border:2px solid var(--primary);display:flex;align-items:center;justify-content:center;font-size:18px;">🏪</div>'}
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:900;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(b.name)}</div>
                                <div style="font-size:12px;color:var(--primary);font-weight:700;">💰 ${(b.balance||0).toLocaleString()} ₽</div>
                            </div>
                            <button class="btn btn-primary btn-sm" onclick="openBizOwnerPanel('${jsEsc(b.id)}');">Управление →</button>
                            ${(u.subscription === 'prime' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date()) ? `<button class="btn btn-ghost btn-sm" style="background:var(--gold-dim);color:var(--gold);border:1px solid rgba(255,128,106,.3);" onclick="promoteBusiness('${jsEsc(b.id)}')">${Number(b.promotedUntil||0) > Date.now() ? '🔥 В ТОПе' : `🔥 <span class="text-rainbow-prime">ТОП!</span> (${ECONOMY_BUSINESS_PROMOTE_PRICE}₽)`}</button>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>`;
            if(!currentBizId && ownedBizs[0]){
    currentBizId = ownedBizs[0].id;
}
    } else {
        myBizPanel.style.display = 'none';
    }

    if(!bizneses.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Бизнесов пока нет</div>'; return; }
    el.innerHTML = `<div class="biz-grid">${bizneses.map(b => `
        <div class="biz-card" onclick="openBizDetail('${jsEsc(b.id)}')">
            ${Number(b.promotedUntil||0) > Date.now() ? `<span style="position:absolute;top:8px;right:8px;z-index:2;display:inline-block;background:var(--gold-dim);border:1px solid rgba(255,128,106,.3);color:var(--gold);padding:4px 10px;border-radius:999px;font-weight:900;font-size:11px;">🔥 <span class="text-rainbow-prime">ТОП!</span></span>` : ''}
            <div style="position:relative;">
                ${b.banner ? `<img class="biz-card-img" src="${escHtml(b.banner)}" loading="lazy" decoding="async">` : '<div class="biz-card-img" style="display:flex;align-items:center;justify-content:center;font-size:40px;">🏪</div>'}
                ${b.bgEffect ? `<div class="biz-card-bg-effect" id="bizCardBg_${jsEsc(b.id)}" style="position:absolute;inset:0;pointer-events:none;z-index:1;"></div>` : ''}
            </div>
            <div class="biz-card-body">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    ${b.icon ? `<img loading="lazy" decoding="async" src="${escHtml(b.icon)}" style="width:28px;height:28px;border-radius:8px;object-fit:cover;border:1px solid var(--border);">` : ''}
                    <div class="biz-card-name">${escHtml(b.name)}</div>
                </div>
                <div class="biz-card-cat">${escHtml(b.category||'')}</div>
                <div class="biz-card-desc">${escHtml(b.desc||'')}</div>
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
                    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;font-weight:800;">Владелец</div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px;">
                        <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:var(--pri-dim);border:1px solid rgba(240,68,74,.22);font-size:11px;font-weight:800;">👑 ${escHtml(b.owner||'')}</span>
                    </div>
                </div>
                ${b.delivery ? '<div style="font-size:11px;color:var(--primary);font-weight:800;margin-top:4px;">🚚 Доставка</div>' : ''}
            </div>
        </div>`).join('')}</div>`;
    // Apply purchased bgEffect visuals on each card (same helper used on the
    // business detail page). Only touches decorative overlay elements, never
    // the card's text/buttons, and does no extra Firebase reads.
    bizneses.forEach(b => { if(b.bgEffect) applyBizBgEffect(qs(`bizCardBg_${b.id}`), b.bgEffect); });
    if (curPage === 'deliveryOrderPage' && typeof renderDeliveryOrderOptions === 'function') renderDeliveryOrderOptions();
}

// ─── BUSINESS DETAIL ──────────────────────
window.openBizDetail = async function(bizId){
    currentBizId = bizId;
    // The business list is already kept live in allBusinessesCache by the
    // 'business' service listener, so reuse it instead of another full
    // get(bizItemRef()) on every open — only fetch when the entry is
    // genuinely missing from cache.
    let b = allBusinessesCache?.[bizId];
    if(!b){
        const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return toast('❌ Бизнес не найден','red');
        b = snap.val();
    }
    currentBizDetailData = b;
    allBusinessesCache[bizId] = b;
    const isOwner = b.owner === currentNick;
    const isAdmin = currentNick === ADMIN;

    // Header
    const headerEl = qs('bizDetailHeader');
    if(headerEl){
        headerEl.innerHTML = `
        <div id="bizDetailBgWrap" style="position:relative;border-radius:var(--r);overflow:hidden;">
            ${b.banner ? `<img loading="lazy" decoding="async" class="biz-detail-banner" src="${escHtml(b.banner)}" onclick="openImgViewer('${jsEsc(b.banner)}')">` : '<div class="biz-detail-banner" style="display:flex;align-items:center;justify-content:center;font-size:60px;">🏪</div>'}
            <div id="bizDetailBgEffect" style="position:absolute;inset:0;pointer-events:none;z-index:1;"></div>
        </div>
        ${b.icon ? `<img class="biz-detail-icon" src="${escHtml(b.icon)}" onclick="openImgViewer('${jsEsc(b.icon)}')">` : '<div class="biz-detail-icon" style="display:flex;align-items:center;justify-content:center;font-size:28px;background:var(--surface2);">🏪</div>'}`;
        applyBizBgEffect(qs('bizDetailBgEffect'), b.bgEffect);
    }

    // About tab
    const roles = b.roles || {};
    const employees = b.employees || {};
    const myRole = employees[currentNick];
    const isStaff = isOwner || isAdmin || !!myRole;
    qs('bizDPanel0').innerHTML = `
        <div class="card">
            <div style="font-size:22px;font-weight:900;margin-bottom:4px;">${escHtml(b.name)}</div>
            <div style="font-size:13px;color:var(--primary);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">${escHtml(b.category||'')}</div>
            <div style="font-size:14px;color:var(--text);line-height:1.6;margin-bottom:12px;">${escHtml(b.desc||'')}</div>
            ${b.address ? `<div style="font-size:13px;color:var(--muted);">📍 ${escHtml(b.address)}</div>` : ''}
            ${b.lat != null && b.lng != null ? `<div style="font-size:12px;color:var(--primary);margin-top:5px;">🗺 Координаты: ${Number(b.lat).toFixed(6)}, ${Number(b.lng).toFixed(6)}</div><div class="card" style="margin-top:10px;padding:8px;"><div id="bizDetailLocationMap" style="width:100%;height:240px;border-radius:12px;overflow:hidden;"></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">📍 Точное местоположение бизнеса</div></div>` : `<div class="card" style="margin-top:10px;padding:8px;"><div id="bizDetailLocationMap" style="width:100%;height:240px;border-radius:12px;overflow:hidden;"></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">📍 Точка бизнеса ещё не задана</div></div>`}
            ${b.services ? `<div style="font-size:13px;color:var(--muted);margin-top:6px;">🛠 ${escHtml(b.services)}</div>` : ''}
            ${b.delivery ? '<div style="margin-top:8px;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--pri-dim);border:1px solid rgba(240,68,74,.3);border-radius:20px;font-size:12px;font-weight:800;color:var(--primary);">🚚 Доставка доступна</div>' : ''}
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:800;">Владелец</div>
                <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;" onclick="openUserProfile('${jsEsc(b.owner)}')">
                    <img src="${escHtml(safeAvatar(b.owner))}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;border:2px solid var(--primary);flex-shrink:0;">
                    <div style="flex:1;">
                        <div style="font-weight:900;font-size:14px;">${escHtml(displayNick(allUsersCache[b.owner]) || b.owner)}</div>
                        <div style="font-size:11px;color:var(--primary);font-weight:700;">Владелец бизнеса</div>
                    </div>
                    <span style="color:var(--muted);font-size:16px;">›</span>
                </div>
            </div>
            ${myRole ? `<div style="margin-top:8px;background:var(--pri-dim);border:1px solid rgba(240,68,74,.25);border-radius:var(--r-sm);padding:10px;font-size:13px;"><b style="color:var(--primary);">👤 Ваша роль:</b> ${escHtml(getBizEmployeeRoleName(myRole))}</div>` : ''}
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
                <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:800;">Сотрудники</div>
                ${renderBizEmployeeTags(b)}
            </div>
        </div>
        ${!isOwner ? `<div class="card">
            <div class="card-title">📬 Жалоба / запрос владельцу</div>
            <textarea id="bizComplaintText" placeholder="Опишите проблему или задайте вопрос владельцу бизнеса..." style="min-height:72px;"></textarea>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
                <button class="btn btn-ghost btn-sm" onclick="sendBizComplaint('${jsEsc(bizId)}','request')">📩 Отправить запрос</button>
                <button class="btn btn-red btn-sm" onclick="sendBizComplaint('${jsEsc(bizId)}','complaint')">⚠️ Пожаловаться</button>
            </div>
        </div>` : ''}
        ${!isOwner ? `<div class="card">
            <div class="card-title">💼 Работа в бизнесе</div>
            ${myRole ? `<div class="biz-apply-pending">👤 Вы сотрудник: <b>${escHtml(myRole.roleName||'')}</b></div>
                <button class="btn btn-red btn-sm" onclick="quitBiz('${jsEsc(bizId)}')">Уволиться</button>` :
            `<div id="bizJobApplyArea">${renderBizJobApplyHtml(roles, b)}</div>`}
        </div>` : ''}
        ${isOwner ? `<div style="margin-bottom:14px;"><button class="btn btn-primary" onclick="currentBizId='${jsEsc(bizId)}'; navTo('bizOwnerPanel');">⚙️ Управление бизнесом</button></div>` : ''}
        ${isAdmin ? `<div style="margin-bottom:14px;"><button class="btn btn-red" onclick="adminDeleteBiz('${jsEsc(bizId)}')">🗑 Удалить бизнес (мэрия)</button></div>` : ''}`;

    // Roles tab
    renderBizDetailRoles(roles, employees);

    // Public business location map
    setTimeout(()=>initBusinessDetailLocationMap(b),180);

    // Products tab
    renderBizDetailProducts(b.products||{}, b, isOwner);

    // Orders tab (load once)
    renderBizDetailOrders();

    // Orders tab: staff see all orders, clients see their own
    const ordersTab = qs('bizDTab3');
    if(ordersTab) ordersTab.style.display = ''; // always show — clients see their own orders

    // Switch to about
    switchBizDetailTab(0);
    navTo('bizDetail');
    setTimeout(()=>initBusinessDetailLocationMap(b).catch(e=>console.warn('[biz map]',e)),120);

    // Live listener for this biz orders — updates both client and staff in real time
    if(listeners.bizOrders) { off(listeners.bizOrders.ref, 'value', listeners.bizOrders.fn); delete listeners.bizOrders; }
    const boRef = bizOrdersRef(bizId);
    const boFn = (snap) => {
        if(curPage === 'bizDetail' || curPage === 'bizOwnerPanel'){
            renderBizDetailOrders();
            renderHomeBizOrders();
        }
    };
    onValue(boRef, boFn);
    listeners.bizOrders = { ref: boRef, fn: boFn };
};

function renderBizJobApplyHtml(roles, b){
    const roleKeys = Object.keys(roles||{});
    if(!roleKeys.length) return '<div style="color:var(--muted);font-size:13px;">Нет открытых вакансий</div>';
    return `<select id="bizApplyRoleSel" style="margin-bottom:8px;">${roleKeys.map(k=>`<option value="${jsEsc(k)}">${escHtml(roles[k].name)}</option>`).join('')}</select>
        <textarea id="bizApplyText" placeholder="Почему хотите работать здесь?" style="min-height:60px;"></textarea>
        <button class="btn btn-primary" onclick="applyToBiz('${jsEsc(b.id)}')">📋 Подать заявку</button>`;
}

function renderBizDetailRoles(roles, employees){
    const el = qs('bizDPanel1'); if(!el) return;
    const roleArr = Object.entries(roles||{});
    const empCount = {};
    Object.values(employees||{}).forEach(e=>{ empCount[e.roleId] = (empCount[e.roleId]||0)+1; });
    el.innerHTML = roleArr.length ? roleArr.map(([rid, r])=>`
        <div class="biz-role-row">
            <div class="biz-role-info">
                <div class="biz-role-name">${escHtml(r.name)}</div>
                ${r.desc ? `<div class="biz-role-desc">${escHtml(r.desc)}</div>` : ''}
                <div class="biz-role-salary">${formatRoleSalary(r)}</div>
            </div>
            <div style="font-size:11px;color:var(--muted);">${empCount[rid]||0} чел.</div>
        </div>`).join('') : '<div style="color:var(--muted);font-size:13px;">Роли не созданы</div>';
}

function renderBizDetailProducts(products, b, isOwner){
    const el = qs('bizDPanel2'); if(!el) return;
    const prodArr = Object.entries(products||{});
    const cart = getBizCart(b.id);
    const cartEntries = Object.entries(cart);
    const total = bizCartTotal(cart);
    const savedName = window._bizOrderName || '';

    const productsHtml = prodArr.length ? prodArr.map(([pid, p])=>{
        const inCart = cart[pid] ? cart[pid].qty : 0;
        return `<div class="market-card">
            ${p.photo ? `<img class="market-img" src="${escHtml(p.photo)}" loading="lazy" onclick="openImgViewer('${jsEsc(p.photo)}')">` : ''}
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
                <div class="market-title">${escHtml(p.name||'')}</div>
                ${b.delivery ? '' : '<span class="market-status-pending">Только в заведении</span>'}
            </div>
            <div class="market-price">${(p.price||0).toLocaleString()} ₽</div>
            ${p.desc ? `<div class="market-desc">${escHtml(p.desc)}</div>` : ''}
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;">
                <button class="btn btn-gold btn-sm" onclick="addBizToCart('${jsEsc(b.id)}','${jsEsc(pid)}')">🧺 В корзину</button>
                ${inCart > 0 ? `
                <div style="display:flex;align-items:center;gap:6px;">
                    <button class="btn btn-ghost btn-sm" style="width:32px;padding:6px 0;" onclick="changeBizCartQty('${jsEsc(b.id)}','${jsEsc(pid)}',-1)">−</button>
                    <span style="font-size:13px;color:var(--primary);font-weight:900;min-width:20px;text-align:center;">${inCart}</span>
                    <button class="btn btn-ghost btn-sm" style="width:32px;padding:6px 0;" onclick="changeBizCartQty('${jsEsc(b.id)}','${jsEsc(pid)}',1)">+</button>
                </div>` : ''}
            </div>
        </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:13px;text-align:center;padding:30px 0;">Товаров нет</div>';

    const cartHtml = cartEntries.length ? `
        <div style="background:var(--surface);border:1px solid rgba(240,68,74,.3);border-radius:var(--r);padding:18px;margin-top:16px;">
            <div class="card-title" style="color:var(--primary);margin-bottom:14px;">🧺 Корзина</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
                ${cartEntries.map(([pid, item])=>`
                <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);">
                    ${item.photo ? `<img src="${escHtml(item.photo)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex-shrink:0;">` : '<div style="width:44px;height:44px;border-radius:10px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🛍</div>'}
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:900;font-size:13px;">${escHtml(item.name||'')}</div>
                        <div style="font-size:11px;color:var(--muted);">${(Number(item.price)||0).toLocaleString()} ₽ × ${item.qty} = <b style="color:var(--gold)">${((Number(item.price)||0)*(Number(item.qty)||0)).toLocaleString()} ₽</b></div>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;">
                        <button class="btn btn-ghost btn-sm" style="width:28px;padding:5px 0;" onclick="changeBizCartQty('${jsEsc(b.id)}','${jsEsc(pid)}',-1)">−</button>
                        <span style="font-size:13px;font-weight:900;color:var(--primary);min-width:18px;text-align:center;">${item.qty}</span>
                        <button class="btn btn-ghost btn-sm" style="width:28px;padding:5px 0;" onclick="changeBizCartQty('${jsEsc(b.id)}','${jsEsc(pid)}',1)">+</button>
                    </div>
                </div>`).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--pri-dim);border-radius:var(--r-sm);border:1px solid rgba(240,68,74,.25);margin-bottom:12px;">
                <span style="font-weight:900;">Итого</span>
                <span style="font-size:22px;font-weight:900;color:var(--primary);">${total.toLocaleString()} ₽</span>
            </div>
            <input type="text" id="bizOrderNameInput" placeholder="Ваше имя для заказа" value="${escHtml(savedName)}" maxlength="60" oninput="window._bizOrderName=this.value" style="margin-bottom:8px;">
            <button class="btn btn-primary" onclick="checkoutBizCart('${jsEsc(b.id)}')">💳 Оплатить — ${total.toLocaleString()} ₽</button>
            <button class="btn btn-ghost" style="margin-top:8px;color:var(--red);border-color:var(--red-dim);" onclick="clearBizCart('${jsEsc(b.id)}')">🗑 Очистить корзину</button>
        </div>` : `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-top:16px;text-align:center;">
            <div style="font-size:28px;margin-bottom:8px;">🧺</div>
            <div style="color:var(--muted);font-size:13px;">Корзина пуста — добавьте товары</div>
        </div>`;

    el.innerHTML = productsHtml + cartHtml;
}

window.switchBizDetailTab = function(i){
    [0,1,2,3].forEach(j=>{qs(`bizDTab${j}`)?.classList.toggle('active',j===i);qs(`bizDPanel${j}`)?.classList.toggle('active',j===i);});
};

// ─── APPLY TO BIZ ─────────────────────────
window.applyToBiz = async function(bizId){
    const roleSel = qs('bizApplyRoleSel');
    const roleId = roleSel?.value;
    const text = (qs('bizApplyText')?.value||'').trim();
    if(!roleId) return toast('⚠️ Выберите роль','gold');
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    if(b.employees && b.employees[currentNick]) return toast('✅ Вы уже сотрудник','gold');
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val()||{};
    if(!await canTakeAnotherJob(u, currentNick)) return toast(`⚠️ Лимит работ: ${getJobLimit(u)}. Увольтесь с одной работы.`,'gold');
    const allAppsSnap = await get(ref(db,`bizJobApps/${bizId}`));
    const allApps = allAppsSnap.val()||{};
    if(Object.values(allApps).find(a=>a.applicant===currentNick&&a.status==='pending')) return toast('⏳ Заявка уже отправлена','gold');
    const appId = genId();
    await set(ref(db,`bizJobApps/${bizId}/${appId}`), {
        id: appId, bizId, applicant: currentNick, roleId,
        roleName: b.roles?.[roleId]?.name||'', text, status: 'pending', createdAt: Date.now()
    });
    await pushNotification(b.owner, `📋 Новая заявка в «${b.name}» от ${displayNick(u)} на роль ${b.roles?.[roleId]?.name||''}`, 'system');
    toast('📋 Заявка отправлена!','green');
    openBizDetail(bizId);
};
window.quitBiz = async function(bizId){
    if(!confirm('Уволиться из бизнеса?')) return;
    await update(bizItemRef(bizId), { [`employees/${currentNick}`]: null });
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val()||{};
    const emps = collectEmploymentsFromData(u, currentNick).filter(e => e.id !== `biz_${bizId}`);
    const patch = { employments: emps };
    if(u.employerBizId === bizId) patch.employerBizId = null;
    if(u.displayJob && !emps.find(e=>e.role===u.displayJob)) patch.displayJob = emps[0]?.role || null;
    await update(userRef(currentNick), patch);
    toast('🚪 Вы уволились','gold');
    openBizDetail(bizId);
};

// ─── BUY BIZ PRODUCT ─────────────────────
window.addBizToCart = async function(bizId, prodId){
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val(); const p = b.products?.[prodId]; if(!p) return;
    const cart = getBizCart(bizId);
    cart[prodId] = cart[prodId] || { name: p.name||'', price: p.price||0, photo: p.photo||'', qty: 0 };
    cart[prodId].qty += 1;
    toast('🧺 Добавлено в корзину','green');
    if(currentBizDetailData && currentBizId === bizId) renderBizDetailProducts(b.products||{}, currentBizDetailData, b.owner===currentNick);
};
window.changeBizCartQty = function(bizId, prodId, delta){
    const cart = getBizCart(bizId);
    if(!cart[prodId]) return;
    cart[prodId].qty = Math.max(1, (parseInt(cart[prodId].qty||1,10) + Number(delta||0)));
    if(currentBizDetailData && currentBizId === bizId) renderBizDetailProducts(currentBizDetailData.products||{}, currentBizDetailData, currentBizDetailData.owner===currentNick);
};
window.setBizCartQty = function(bizId, prodId, value){
    const cart = getBizCart(bizId);
    if(!cart[prodId]) return;
    const q = Math.max(1, parseInt(value||'1',10)||1);
    cart[prodId].qty = q;
    if(currentBizDetailData && currentBizId === bizId) renderBizDetailProducts(currentBizDetailData.products||{}, currentBizDetailData, currentBizDetailData.owner===currentNick);
};
window.clearBizCart = function(bizId){
    bizCarts[bizId] = {};
    if(currentBizDetailData && currentBizId === bizId) renderBizDetailProducts(currentBizDetailData.products||{}, currentBizDetailData, currentBizDetailData.owner===currentNick);
};
let _checkoutBizCartBusy = false;
window.checkoutBizCart = async function(bizId){
    if(_checkoutBizCartBusy) return toast('⏳ Оплата уже выполняется…','gold');
    _checkoutBizCartBusy = true;
    try {
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    const cart = getBizCart(bizId);
    const entries = Object.entries(cart);
    if(!entries.length) return toast('⚠️ Корзина пуста','gold');
    const buyerName = (qs('bizOrderNameInput')?.value || window._bizOrderName || '').trim();
    if(!buyerName) return toast('⚠️ Укажите имя','gold');
    if(!await requireSpendable()) return;
    const total = bizCartTotal(cart);
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val() || {};
    if((u.balance||0) < total) return toast('❌ Недостаточно средств','red');
    const orderId = genId();
    const orderCode = orderId.slice(-6).toUpperCase();
    const items = entries.map(([pid, item]) => ({ pid, name: item.name, qty: item.qty, price: item.price, photo: item.photo || '' }));
    const bizBalance = Number(b.balance||0);
    const newBal = (u.balance||0) - total;
    await update(userRef(currentNick), { balance: newBal });
    await update(bizItemRef(bizId), { balance: bizBalance + total });
    await set(bizOrderRef(bizId, orderId), {
        id: orderId,
        code: orderCode,
        bizId,
        owner: b.owner,
        bizName: b.name,
        client: currentNick,
        clientName: buyerName,
        clientAvatar: u.avatar || DEFAULT_AVATAR_URL,
        items,
        total,
        status: 'active',
        createdAt: Date.now()
    });
    await logTx(currentNick, {type:'out', who:b.name, amt: total, desc:`Заказ в «${b.name}» (${buyerName})`});
    const staff = new Set([b.owner, ...Object.keys(b.employees||{})].filter(Boolean));
    await Promise.all([...staff].map(nick => pushNotification(nick, `🛒 Новый заказ в «${b.name}» от ${buyerName} (код: ${orderId.slice(-6).toUpperCase()})`, 'money')));
    toast(`✅ Заказ #${orderCode} оплачен! Деньги списаны. Ожидайте выдачи.`,'green');
    bizCarts[bizId] = {};
    window._bizOrderName = '';
    if(qs('bizOrderNameInput')) qs('bizOrderNameInput').value = '';
    // Refresh home orders
    renderHomeBizOrders();
    // Show order in biz detail — for staff switch to orders tab, for client show inline
    if(currentBizId === bizId && currentBizDetailData){
        const isStaff = currentBizDetailData.owner === currentNick || currentNick === ADMIN || (currentBizDetailData.employees && currentBizDetailData.employees[currentNick]);
        renderBizDetailProducts(currentBizDetailData.products||{}, currentBizDetailData, currentBizDetailData.owner===currentNick);
        if(isStaff){
            switchBizDetailTab(3);
            renderBizDetailOrders();
        }
    }
    } finally {
        _checkoutBizCartBusy = false;
    }
};
window.confirmBizOrderReceipt = async function(bizId, orderId, side){
    const snap = await get(bizOrderRef(bizId, orderId)); if(!snap.exists()) return;
    const order = snap.val();
    const bSnap = await get(bizItemRef(bizId)); const b = bSnap.exists() ? bSnap.val() : {};
    const isOwner = b.owner === currentNick;
    const isStaff = isOwner || currentNick === ADMIN || (b.employees && b.employees[currentNick]);
    if(side === 'client' && order.client !== currentNick) return toast('❌ Это не ваш заказ','red');
    if(side === 'staff' && !isStaff) return toast('❌ Нет прав','red');
    const patch = {};
    if(side === 'client') patch.clientConfirmed = true;
    if(side === 'staff') patch.staffConfirmed = true;
    await update(bizOrderRef(bizId, orderId), patch);
    // Check if both confirmed
    const newOrder = { ...order, ...patch };
    if(newOrder.clientConfirmed && newOrder.staffConfirmed){
        await remove(bizOrderRef(bizId, orderId));
        if(order.owner) await pushNotification(order.owner, `✅ Заказ от ${order.clientName || order.client} выполнен и подтверждён!`, 'money');
        if(order.client) await pushNotification(order.client, `✅ Заказ в «${order.bizName}» подтверждён — спасибо!`, 'money');
        toast('✅ Заказ завершён!','green');
    } else {
        if(side === 'client'){
            toast('✅ Вы подтвердили получение. Ждём подтверждения персонала.','green');
            if(order.owner) await pushNotification(order.owner, `👤 ${order.clientName || order.client} подтвердил получение заказа — подтвердите с вашей стороны!`, 'money');
        } else {
            toast('✅ Выдача отмечена. Ждём подтверждения клиента.','gold');
            if(order.client) await pushNotification(order.client, `🏪 «${order.bizName}» отметил заказ как выданный — подтвердите получение!`, 'money');
        }
    }
    renderHomeBizOrders();
    renderBizDetailOrders();
    if(currentBizId === bizId && currentBizDetailData) renderBizDetailProducts(currentBizDetailData.products||{}, currentBizDetailData, currentBizDetailData.owner===currentNick);
};
window.buyBizProduct = window.addBizToCart;

// ─── OWNER PANEL ─────────────────────────
async function renderBizOwnerPanel(){
    const u = allUsersCache?.[currentNick] || (await get(userRef(currentNick))).val() || {};

    const bizIds = Array.from(new Set([
        ...(Array.isArray(u.businessIds) ? u.businessIds : []),
        u.businessId,
        currentBizId
    ].filter(Boolean)));

    let bizId = currentBizId;

if(!bizId){
    bizId = u.businessId || bizIds[0];
}

    if(!bizId){
        const switchEl = qs('bizOwnerSwitcher');
        if(switchEl) switchEl.innerHTML = '';
        const nameEl = qs('bizOwnerName'); if(nameEl) nameEl.textContent = '';
        const balEl = qs('bizBalanceDisplay'); if(balEl) balEl.textContent = '0';
        return;
    }

    currentBizId = bizId;

    const switchEl = qs('bizOwnerSwitcher');
    if(switchEl && bizIds.length > 1){
        switchEl.innerHTML = `<label style="font-size:11px;color:var(--muted);font-weight:800;display:block;margin-bottom:4px;">Выберите бизнес</label>
            <select onchange="currentBizId=this.value; renderBizOwnerPanel();" style="margin:0;">
                ${bizIds.map(id => {
                    const bb = allBusinessesCache[id] || {};
                    return `<option value="${escHtml(id)}" ${id===bizId?'selected':''}>${escHtml(bb.name||id)}</option>`;
                }).join('')}
            </select>`;
    } else if(switchEl) {
        switchEl.innerHTML = '';
    }

    let b = allBusinessesCache?.[bizId];
    if(!b){
        const snap = await get(bizItemRef(bizId));
        if(!snap.exists()) return;
        b = snap.val();
    }
    await processBizAutoSalaries(bizId, b).catch(()=>{});
    const refreshedSnap = await get(bizItemRef(bizId));
    const bData = refreshedSnap.val() || b;

    allBusinessesCache[bizId] = bData;

    const nameEl = qs('bizOwnerName'); if(nameEl) nameEl.textContent = bData.name || '';
    const balEl = qs('bizBalanceDisplay'); if(balEl) balEl.textContent = (bData.balance || 0).toLocaleString();

    const fn = (id, v) => { const el = qs(id); if(el) el.value = v || ''; };
    fn('bizEditName', bData.name);
    fn('bizEditDesc', bData.desc);
    fn('bizEditAddress', bData.address);
    fn('bizEditLat', bData.lat);
    fn('bizEditLng', bData.lng);
    const editLoc=qs('bizEditLocationPreview'); if(editLoc) editLoc.textContent=(Number.isFinite(Number(bData.lat))&&Number.isFinite(Number(bData.lng)))?`📍 ${Number(bData.lat).toFixed(6)}, ${Number(bData.lng).toFixed(6)}`:'📍 Точка не выбрана'; 
    fn('bizEditServices', bData.services);
    fn('bizEditCategory', bData.category);

    const dc = qs('bizDeliveryCheck'); if(dc) dc.checked = !!bData.delivery;

    renderBizComplaints(bizId);
    renderBizLimitsPanel(bData);
    renderBizBgShop(bData);
    renderOwnerEmployees(bData);
    renderOwnerRoles(bData);
    renderOwnerJobApps(bizId);
    renderOwnerProducts(bData);
    renderBizOwnerOrders(bizId);
}
async function renderBizComplaints(bizId){
    const el = qs('bizComplaintsList'); if(!el) return;
    const snap = await get(ref(db, `bizComplaints/${bizId}`));
    const list = Object.values(snap.val()||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!list.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет сообщений</div>'; return; }
    el.innerHTML = list.map(c => `
        <div class="submission-card" style="margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;gap:8px;">
                <div style="font-weight:900;">${escHtml(c.fromName||c.from||'Клиент')}</div>
                <div style="font-size:11px;color:var(--muted);">${new Date(c.createdAt||0).toLocaleString('ru')}</div>
            </div>
            <div style="font-size:11px;color:var(--primary);font-weight:800;margin:4px 0;">${c.type==='complaint'?'⚠️ Жалоба':'📩 Запрос'}</div>
            <div style="font-size:13px;color:var(--text);line-height:1.5;">${escHtml(c.text||'')}</div>
            <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="openUserProfile('${jsEsc(c.from)}')">👤 Профиль</button>
        </div>`).join('');
}
function renderBizLimitsPanel(b){
    const limits = getBizLimits(b);
    const empCount = Object.keys(b.employees||{}).length;
    const prodCount = Object.keys(b.products||{}).length;
    const info = qs('bizLimitsInfo');
    if(info) info.innerHTML = `Сотрудники: <b>${empCount}/${limits.employees}</b> · Товары: <b>${prodCount}/${limits.products}</b> · Макс. цена товара: <b>${limits.maxProductPrice.toLocaleString()} ₽</b><br><span style="font-size:11px;">Абонентская плата: ${ECONOMY_BUSINESS_WEEKLY_FEE} ₽/неделю</span>`;
    const upEl = qs('bizLimitsUpgrades');
    if(!upEl) return;
    upEl.innerHTML = `
        ${['employee','product','priceCap'].map(kind=>{
            const names={employee:'Сотрудники',product:'Товары',priceCap:'Лимит цены'};
            const unit=kind==='priceCap'?500:1;
            return `<div style="padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;">
                <div style="font-weight:900;margin-bottom:6px;">${names[kind]}</div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <button class="btn btn-ghost btn-sm" onclick="changeBizUpgradeQty('${kind}',-1)">−</button>
                    <input id="bizUpgradeQty_${kind}" type="number" min="1" value="1" oninput="updateBizUpgradeTotal('${kind}')" style="width:70px;text-align:center;margin:0;">
                    <button class="btn btn-ghost btn-sm" onclick="changeBizUpgradeQty('${kind}',1)">+</button>
                    <div style="font-size:11px;color:var(--muted);">1 ед. = ${unit} ${unit===1?'место':'₽ лимита'}</div>
                </div>
                <div style="font-size:11px;color:var(--gold);margin-top:5px;">Цена за 1: ${BIZ_UPGRADE_PRICES[kind]} ₽</div>
                <div id="bizUpgradeTotal_${kind}" style="font-size:13px;font-weight:900;margin-top:4px;">Итого: ${BIZ_UPGRADE_PRICES[kind]} ₽</div>
                <button class="btn btn-gold btn-sm" style="margin-top:7px;width:100%;" onclick="upgradeBizLimit('${kind}')">Купить</button>
            </div>`;
        }).join('')}`;
}
function renderBizBgShop(b){
    const el = qs('bizBgEffectsShop'); if(!el) return;
    const current = b.bgEffect || '';
    el.innerHTML = BIZ_BG_EFFECTS.map(e => `
        <button class="btn ${current===e.id?'btn-primary':'btn-ghost'} btn-sm" style="text-align:left;" onclick="buyBizBgEffect('${jsEsc(e.id)}')">
            ${e.name} — ${e.price}₽ ${current===e.id?'✓':''}
        </button>`).join('') +
        (current ? `<button class="btn btn-ghost btn-sm" style="color:var(--muted);" onclick="buyBizBgEffect('')">Убрать оформление</button>` : '');
}
let _bizUpgradeBusy = false;
window.updateBizUpgradeTotal=function(kind){
    const qty=Math.max(1,parseInt(qs(`bizUpgradeQty_${kind}`)?.value||'1',10)||1);
    const total=qty*Number(BIZ_UPGRADE_PRICES[kind]||0);
    const el=qs(`bizUpgradeTotal_${kind}`); if(el) el.textContent=`Итого: ${total.toLocaleString()} ₽`;
};
window.changeBizUpgradeQty=function(kind,delta){
    const el=qs(`bizUpgradeQty_${kind}`); if(!el) return;
    el.value=Math.max(1,(parseInt(el.value||1,10)||1)+Number(delta||0));
    updateBizUpgradeTotal(kind);
};
window.upgradeBizLimit = async function(kind){
    if(_bizUpgradeBusy) return toast('⏳ Покупка уже выполняется…','gold');
    if(!currentBizId) return;
    const unitPrice = Number(BIZ_UPGRADE_PRICES[kind]||0);
    if(!unitPrice) return;
    const qty=Math.max(1,parseInt(qs(`bizUpgradeQty_${kind}`)?.value||'1',10)||1);
    const labels={employee:'дополнительных сотрудников',product:'дополнительных товаров',priceCap:'увеличения лимита цены'};
    const canonical={employee:'employees',product:'products',priceCap:'priceCap'}[kind] || kind;
    const total=unitPrice*qty;
    const currentSnap=await get(bizItemRef(currentBizId));
    const currentBiz=currentSnap.val()||{};
    const currentBalance=Number(currentBiz.balance||0);
    if(currentBalance<total) return toast(`❌ Недостаточно средств на счёте бизнеса. Нужно ${total.toLocaleString()} ₽`,'red');
    if(!confirm(`Покупка улучшения бизнеса\n\n${labels[kind]||kind}: ${qty} шт.\nЦена за 1: ${unitPrice.toLocaleString()} ₽\nИтого к оплате: ${total.toLocaleString()} ₽\nБаланс после покупки: ${(currentBalance-total).toLocaleString()} ₽\n\nПодтвердить оплату?`)) return;
    _bizUpgradeBusy=true;
    try{
        const result=await runTransaction(bizItemRef(currentBizId), current=>{
            const cur=current||{};
            const balance=Number(cur.balance||0);
            if(balance<total) return;
            const bonus={...(cur.limitBonus||{})};
            bonus[canonical]=Number(bonus[canonical]||0)+qty;
            // Keep legacy aliases too so older records/readers remain compatible.
            if(kind==='employee') bonus.employee=bonus.employees;
            if(kind==='product') bonus.product=bonus.products;
            return {...cur,balance:balance-total,limitBonus:bonus};
        });
        if(!result?.committed) return toast('❌ Покупка не подтверждена: баланс бизнеса или лимит изменился','red');
        await logTx(currentNick,{type:'out',who:'Бизнес',amt:total,desc:`Улучшение бизнеса: ${labels[kind]||kind} × ${qty}`});
        toast(`✅ Оплата подтверждена: ${total.toLocaleString()} ₽ · лимит увеличен`,'green');
        if(qs(`bizUpgradeQty_${kind}`)) qs(`bizUpgradeQty_${kind}`).value='1';
        await renderBizOwnerPanel();
    }catch(e){ toast('❌ '+(e.message||'Ошибка покупки'),'red'); }
    finally{ _bizUpgradeBusy=false; }
};

let _bizBgBusy = false;
window.buyBizBgEffect = async function(effectId){
    if(_bizBgBusy) return toast('⏳ Покупка уже выполняется…','gold');
    if(!currentBizId) return;
    const snap = await get(bizItemRef(currentBizId)); const b = snap.val()||{};
    if(!effectId){
        await update(bizItemRef(currentBizId), { bgEffect: null });
        if(currentBizDetailData){ currentBizDetailData.bgEffect = null; }
        if(allBusinessesCache?.[currentBizId]) allBusinessesCache[currentBizId].bgEffect = null;
        const effectHost = qs('bizDetailBgEffect'); if(effectHost) applyBizBgEffect(effectHost, null);
        toast('✅ Оформление убрано','green');
        renderBizOwnerPanel();
        return;
    }
    const eff = BIZ_BG_EFFECTS.find(x=>x.id===effectId);
    if(!eff) return;
    if(b.bgEffect === effectId) return toast('✅ Уже активно','gold');
    if(!confirm(`Купить оформление?

Название: ${eff.name}
Стоимость: ${eff.price} ₽

Деньги будут списаны со счёта бизнеса.

Подтвердить покупку?`)) return;
    _bizBgBusy = true;
    try{
        const result = await runTransaction(bizItemRef(currentBizId), current => {
            const cur=current||{};
            const balance=Number(cur.balance||0);
            if(balance < eff.price || cur.bgEffect===effectId) return;
            return {...cur,balance:balance-eff.price,bgEffect:effectId};
        });
        if(!result || !result.committed) return toast(`❌ Недостаточно средств на счёте бизнеса. Нужно ${eff.price}₽`,'red');

        if(currentBizDetailData) currentBizDetailData.bgEffect = effectId;
        if(allBusinessesCache?.[currentBizId]) allBusinessesCache[currentBizId].bgEffect = effectId;
        const effectHost = qs('bizDetailBgEffect'); if(effectHost) applyBizBgEffect(effectHost, effectId);
        await logTx(currentNick, { type:'out', who:'Бизнес', amt:eff.price, desc:`Оформление бизнеса: ${eff.name}` });
        toast('✅ Оформление применено','green');
        renderBizOwnerPanel();
    }catch(e){ toast('❌ '+(e.message||'Ошибка покупки'),'red'); }
    finally{ _bizBgBusy = false; }
};
window.clearBizComplaintsAndRequests=async function(bizId){
    if(!bizId) return;
    if(!confirm('Удалить все жалобы и запросы, накопленные у этого бизнеса? Это нельзя отменить.')) return;
    try{
        await remove(ref(db, `bizComplaints/${bizId}`));
        toast('✅ Жалобы и запросы очищены','green');
        await renderBizComplaints(bizId);
    }catch(e){ toast('❌ Не удалось очистить сообщения: '+(e?.message||'ошибка'),'red'); }
};
window.clearBizJobApps=async function(bizId){
    if(!bizId) return;
    if(!confirm('Удалить все заявки на работу этого бизнеса? Это нельзя отменить.')) return;
    try{
        await remove(ref(db, `bizJobApps/${bizId}`));
        toast('✅ Заявки на работу очищены','green');
        await renderOwnerJobApps(bizId);
    }catch(e){ toast('❌ Не удалось очистить заявки: '+(e?.message||'ошибка'),'red'); }
};
window.sendBizComplaint = async function(bizId, type){
    const text = (qs('bizComplaintText')?.value||'').trim();
    if(!text || text.length < 5) return toast('⚠️ Напишите сообщение (мин. 5 символов)','gold');
    const u = allUsersCache?.[currentNick];
    const b = allBusinessesCache?.[bizId];
    const [uSnap, bSnap] = await Promise.all([
        u ? Promise.resolve(null) : get(userRef(currentNick)),
        b ? Promise.resolve(null) : get(bizItemRef(bizId))
    ]);
    const uu = u || uSnap.val() || {};
    const bb = b || (bSnap && bSnap.exists() ? bSnap.val() : null);
    if(!bb) return;
    const id = genId();
    await set(ref(db, `bizComplaints/${bizId}/${id}`), {
        id, bizId, from: currentNick, fromName: displayNick(uu), text, type: type||'request', createdAt: Date.now()
    });
    await pushNotification(bb.owner, `${type==='complaint'?'⚠️ Жалоба':'📩 Запрос'} в «${bb.name}» от ${displayNick(uu)}`, 'system');
    if(qs('bizComplaintText')) qs('bizComplaintText').value='';
    toast('✅ Сообщение отправлено владельцу','green');
};
function renderOwnerEmployees(b){
    const el = qs('bizEmployeesList'); if(!el) return;
    const emps = Object.entries(b.employees||{});
    if(!emps.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет сотрудников</div>'; return; }
    el.innerHTML = emps.map(([nick,e])=>`
        <div class="biz-employee-row" onclick="openUserProfile('${jsEsc(nick)}')" style="cursor:pointer;">
            <img src="${escHtml(safeAvatar(nick))}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;">
            <div style="flex:1;">
                <div style="font-weight:900;font-size:14px;">${escHtml(nick)}</div>
                <div style="font-size:11px;color:var(--primary);">${escHtml(getBizEmployeeRoleName(e))}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openUserProfile('${jsEsc(nick)}')" style="font-size:11px;">👤 Профиль</button>
            <button class="btn btn-gold btn-sm" onclick="event.stopPropagation(); payEmployee('${jsEsc(nick)}')">💸 Перевести</button>
            <button class="btn btn-red btn-sm" onclick="event.stopPropagation(); fireEmployee('${jsEsc(nick)}')">✕</button>
        </div>`).join('');
}
function renderOwnerRoles(b){
    const el = qs('bizRolesList'); if(!el) return;
    const roles = Object.entries(b.roles||{});
    el.innerHTML = roles.length ? roles.map(([rid,r])=>`
        <div class="biz-role-row" style="margin-bottom:8px;">
            <div class="biz-role-info">
                <div class="biz-role-name">${escHtml(r.name)}</div>
                ${r.desc ? `<div class="biz-role-desc">${escHtml(r.desc)}</div>` : ''}
                <div class="biz-role-salary">${formatRoleSalary(r)}</div>
            </div>
            <button class="btn btn-red btn-sm" onclick="deleteRole('${jsEsc(rid)}')">✕</button>
        </div>`).join('') : '<div style="color:var(--muted);font-size:13px;">Ролей нет</div>';
}
async function renderOwnerJobApps(bizId){
    const el = qs('bizJobApps'); if(!el) return;
    const snap = await get(ref(db,`bizJobApps/${bizId}`));
    const apps = Object.values(snap.val()||{}).filter(a=>a.status==='pending');
    if(!apps.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет заявок</div>'; return; }
    el.innerHTML = apps.map(a=>`
        <div class="submission-card">
            <div style="font-weight:900;">${escHtml(a.applicant)} → ${escHtml(a.roleName)}</div>
            ${a.text ? `<div style="font-size:13px;color:var(--muted);margin-top:4px;">${escHtml(a.text)}</div>` : ''}
            <div class="admin-action-grid" style="margin-top:8px;">
                <button class="btn btn-primary btn-sm" onclick="approveJobApp('${jsEsc(bizId)}','${jsEsc(a.id)}','${jsEsc(a.applicant)}','${jsEsc(a.roleId)}','${jsEsc(a.roleName)}')">✅ Принять</button>
                <button class="btn btn-red btn-sm" onclick="rejectJobApp('${jsEsc(bizId)}','${jsEsc(a.id)}','${jsEsc(a.applicant)}')">❌ Отклонить</button>
            </div>
        </div>`).join('');
}
function renderOwnerProducts(b){
    const el = qs('bizProductsList'); if(!el) return;
    const prods = Object.entries(b.products||{});
    el.innerHTML = prods.length ? prods.map(([pid,p])=>`
        <div class="item-row" style="align-items:center;gap:10px;">
            ${p.photo ? `<img src="${escAttr(p.photo)}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;flex-shrink:0;">` : '<div style="width:44px;height:44px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">📦</div>'}
            <div style="flex:1;min-width:0;">
                <div style="font-weight:800;">${escHtml(p.name||'')}</div>
                ${p.desc ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.desc)}</div>` : ''}
                <div style="font-size:12px;color:var(--gold);margin-top:2px;">${(p.price||0).toLocaleString()} ₽</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="btn btn-ghost btn-sm" onclick="editBizProduct('${jsEsc(pid)}')">✏️</button>
                <button class="btn btn-red btn-sm" onclick="deleteBizProduct('${jsEsc(pid)}')">✕</button>
            </div>
        </div>`).join('') : '<div style="color:var(--muted);font-size:13px;">Нет товаров</div>';
}


function normalizeRoleAmount(r){
    const raw = r?.salaryAmount ?? r?.salary ?? '';
    if(typeof raw === 'number') return String(raw);
    if(typeof raw === 'string'){
        const m = raw.replace(/\s+/g,' ').match(/\d+/);
        return m ? m[0] : raw.trim();
    }
    return '';
}
function normalizeRolePeriod(r){
    const p = String(r?.salaryPeriod || '').toLowerCase();
    if(p === 'week' || p === 'weekly' || p === 'неделю' || p === 'неделя') return 'week';
    if(p === 'day' || p === 'daily' || p === 'день' || p === 'dayly') return 'day';
    const raw = String(r?.salary || '').toLowerCase();
    if(raw.includes('нед')) return 'week';
    return 'day';
}
function normalizeRoleMode(r){
    const mode = String(r?.salaryMode || r?.salaryType || '').toLowerCase();
    if(mode === 'auto' || mode === 'авто' || mode === 'automatic') return 'auto';
    if(mode === 'manual' || mode === 'ручная' || mode === 'ручной') return 'manual';
    if(mode === 'contract') return 'manual';
    return 'manual';
}
function formatRoleSalary(r){
    const amount = normalizeRoleAmount(r);
    const period = normalizeRolePeriod(r) === 'week' ? 'в неделю' : 'в день';
    if(!amount) return '💰 Зарплата не указана';
    return `💰 ${escHtml(amount)} ₽ / ${period}`;
}

function getBizEmployeeRoleName(entry){
    if(!entry) return 'Сотрудник';
    return entry.roleName || entry.role || 'Сотрудник';
}
function getUserBusinessRoleLabel(u, nick = (u && u.nick) || currentNick){
    if(!u) return 'Житель';

    // The stored displayJob is only trusted when it still points to an active
    // employment. This prevents a fired role (for example, 'Врач') from
    // remaining visible until a full reload.
    const emps = collectEmploymentsFromData(u, nick);
    if(u.displayJob && emps.some(e => e.role === u.displayJob)) return u.displayJob;
    if(emps.length) return emps[0].role;

    // Keep legacy municipal `job` compatible, but never let a stale value beat
    // the absence of active employments.
    return (u.job && u.job !== 'Житель') ? u.job : 'Житель';
}
function renderBizEmployeeTags(b){
    const entries = Object.entries(b?.employees || {});
    if(!entries.length) return '<div style="color:var(--muted);font-size:12px;">Сотрудников пока нет</div>';
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${entries.map(([nick, emp])=>`<span onclick="openUserProfile('${jsEsc(nick)}')" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:var(--surface2);border:1px solid var(--border);font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer;"><span>👤</span><span>${escHtml(nick)}</span><span style="color:var(--primary);font-weight:900;">${escHtml(getBizEmployeeRoleName(emp))}</span></span>`).join('')}</div>`;
}
function getBizCart(bizId){
    if(!bizCarts[bizId]) bizCarts[bizId] = {};
    return bizCarts[bizId];
}
function bizCartTotal(cart){
    return Object.values(cart||{}).reduce((sum, item)=>sum + (Number(item.price)||0) * (Number(item.qty)||0), 0);
}
async function processBizAutoSalaries(bizId, b){
    if(!b || !b.roles || !b.employees) return;
    const now = Date.now();
    const periodMs = (p) => p === 'week' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const employeePatch = {};
    let bizBalance = Number(b.balance||0);
    const payOps = [];
    for(const [nick, emp] of Object.entries(b.employees||{})){
        const role = b.roles?.[emp.roleId];
        if(!role || normalizeRoleMode(role) !== 'auto') continue;
        const amount = parseInt(normalizeRoleAmount(role) || '0', 10);
        if(amount <= 0) continue;
        const pp = periodMs(normalizeRolePeriod(role));
        const lastPaid = emp.salaryPaidAt || emp.joinedAt || 0;
        if(now - lastPaid < pp) continue;
        if(bizBalance < amount) continue;
        bizBalance -= amount;
        employeePatch[`employees/${nick}/salaryPaidAt`] = now;
        payOps.push({nick, amount, roleName: role.name || 'Роль', period: normalizeRolePeriod(role)});
    }
    if(!payOps.length) return false;
    await update(bizItemRef(bizId), { balance: bizBalance, ...employeePatch });
    for(const op of payOps){
        const empSnap = await get(userRef(op.nick));
        const emp = empSnap.val() || {};
        await update(userRef(op.nick), { balance: (emp.balance||0) + op.amount });
        await logTx(op.nick, {type:'in', who:b.name, amt:op.amount, desc:`Автозарплата: ${op.roleName} (${op.amount} ₽/${op.period === 'week' ? 'неделю' : 'день'})`});
        await pushNotification(op.nick, `💰 Начислена автозарплата ${op.amount}₽ от «${b.name}»`, 'money');
    }
    return true;
}
async function renderBizOrdersForBiz(bizId, b, mode='detail'){
    const elId = mode === 'owner' ? 'bizOwnerOrders' : mode === 'home' ? 'homeBizOrders' : 'bizDPanel3';
    const el = qs(elId);
    if(!el) return;
    const snap = await get(bizOrdersRef(bizId));
    const orders = Object.values(snap.val()||{}).filter(o=>o && o.status !== 'removed').sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
    const isViewerStaff = b?.owner === currentNick || currentNick === ADMIN || (b?.employees && b.employees[currentNick]);
    const myOrders = (mode === 'home' || (mode === 'detail' && !isViewerStaff)) 
        ? orders.filter(o=>o.client === currentNick) 
        : orders;
    if(!myOrders.length){
        const emptyMsg = (mode === 'detail' && !isViewerStaff) 
            ? '🛒 У вас нет активных заказов в этом бизнесе' 
            : 'Нет активных заказов';
        el.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0;">${emptyMsg}</div>`;
        return;
    }
    el.innerHTML = myOrders.map(o=>{
        const mine = o.client === currentNick;
        const isStaff = b?.owner === currentNick || currentNick === ADMIN || (b?.employees && b.employees[currentNick]);
        const clientConfirmed = !!o.clientConfirmed;
        const staffConfirmed = !!o.staffConfirmed;
        const orderCode = o.id ? o.id.slice(-6).toUpperCase() : '??????';
        return `
        <div class="order-card ${mine ? 'order-active' : ''}">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:10px;">
                <div>
                    <div class="order-title">${escHtml(o.customerName || o.clientName || o.client || 'Клиент')}</div>
                    <div class="order-sub">🕒 ${new Date(o.createdAt||Date.now()).toLocaleString('ru')} · ${escHtml(o.client||'')}</div>
                    <div style="font-size:12px;font-weight:900;color:var(--primary);margin-top:4px;letter-spacing:1px;">🔑 Код: ${escHtml(orderCode)}</div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="openUserProfile('${jsEsc(o.client)}')">👤</button>
            </div>
            <div class="order-items-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">
                ${(o.items||[]).map(it=>`
                    <div class="order-item">
                        ${it.photo ? `<img src="${escHtml(it.photo)}" onclick="openImgViewer('${jsEsc(it.photo)}')">` : '<div style="width:54px;height:54px;border-radius:12px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">📦</div>'}
                        <div class="order-meta">
                            <div class="order-title">${escHtml(it.name||'')}</div>
                            <div class="order-sub">Кол-во: ${Number(it.qty)||0} · ${(Number(it.price)||0).toLocaleString()} ₽</div>
                        </div>
                    </div>`).join('')}
            </div>
            <div class="total-row"><span>Итого</span><span class="total-val">${(o.total||0).toLocaleString()} ₽</span></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                <span style="font-size:11px;padding:4px 10px;border-radius:20px;font-weight:800;${clientConfirmed ? 'background:var(--pri-dim);color:var(--primary);' : 'background:var(--surface2);color:var(--muted);'}">👤 Клиент: ${clientConfirmed ? '✅' : '⏳'}</span>
                <span style="font-size:11px;padding:4px 10px;border-radius:20px;font-weight:800;${staffConfirmed ? 'background:var(--pri-dim);color:var(--primary);' : 'background:var(--surface2);color:var(--muted);'}">🏪 Персонал: ${staffConfirmed ? '✅' : '⏳'}</span>
            </div>
            <div class="order-actions">
                ${mine && !clientConfirmed ? `<button class="btn btn-primary btn-sm" onclick="confirmBizOrderReceipt('${jsEsc(bizId)}','${jsEsc(o.id)}','client')">✅ Подтвердить получение</button>` : ''}
                ${isStaff && !staffConfirmed ? `<button class="btn btn-gold btn-sm" onclick="confirmBizOrderReceipt('${jsEsc(bizId)}','${jsEsc(o.id)}','staff')">✅ Выдано</button>` : ''}
            </div>
        </div>`;
    }).join('');
}
window.renderBizDetailOrders = async function(){
    if(!currentBizId) return;
    // Always re-fetch fresh biz data so employee list is current
    const snap = await get(bizItemRef(currentBizId));
    const b = snap.exists() ? snap.val() : currentBizDetailData;
    if(!b) return;
    currentBizDetailData = b;
    await renderBizOrdersForBiz(currentBizId, b, 'detail');
};
window.renderBizOwnerOrders = async function(bizId){
    const snap = await get(bizItemRef(bizId));
    if(!snap.exists()) return;
    await renderBizOrdersForBiz(bizId, snap.val(), 'owner');
};
window.renderHomeBizOrders = async function(){
    const elWrap = qs('bizOrderSection');
    const el = qs('homeBizOrders');
    if(!elWrap || !el) return;
    const snap = await get(ref(db,'bizOrders'));
    const all = snap.val() || {};
    const orders = [];
    Object.entries(all).forEach(([bizId, bizOrders]) => {
        Object.values(bizOrders || {}).forEach(o => {
            if(o && o.client === currentNick && o.status !== 'removed') orders.push({...o, bizId: o.bizId || bizId});
        });
    });
    elWrap.style.display = orders.length ? 'block' : 'none';
    if(!orders.length){ el.innerHTML = ''; return; }
    el.innerHTML = orders.map(o=>`
        <div class="order-card order-active">
            <div class="order-title">${escHtml(o.clientName || currentNick)}</div>
            <div class="order-sub">${escHtml(o.bizName || '')} · ${(o.total||0).toLocaleString()} ₽</div>
            <div style="font-size:12px;font-weight:900;color:var(--primary);margin-top:4px;letter-spacing:1px;">🔑 Код: ${escHtml((o.id||'').slice(-6).toUpperCase())}</div>
            <div class="order-sub" style="margin-top:6px;">${(o.items||[]).map(it=>`${escHtml(it.name)} × ${it.qty}`).join(', ')}</div>
            ${!o.clientConfirmed ? `<div class="order-actions" style="margin-top:10px;">
                <button class="btn btn-primary btn-sm" onclick="confirmBizOrderReceipt('${jsEsc(o.bizId)}','${jsEsc(o.id)}','client')">✅ Подтвердить получение</button>
                <button class="btn btn-ghost btn-sm" onclick="openBizDetail('${jsEsc(o.bizId)}')">Открыть</button>
            </div>` : `<div style="font-size:12px;color:var(--primary);margin-top:8px;font-weight:800;">✅ Получение подтверждено — ждём персонал</div>`}
        </div>`).join('');
};

// ─── ROLES ────────────────────────────────
window.openAddRoleModal = function(){
    const name = prompt('Название роли (например, Доставщик):');
    if(!name || !name.trim()) return;
    const desc = prompt('Описание — что делает сотрудник:') || '';
    const salaryAmount = parseInt(prompt('Ставка зарплаты цифрой (₽, только для отображения):') || '0', 10);
    if(!salaryAmount || salaryAmount <= 0) return toast('⚠️ Укажите зарплату цифрой','gold');
    const periodPick = prompt('Период ставки:\n1 — в день\n2 — в неделю', '1') || '1';
    const salaryPeriod = periodPick === '2' ? 'week' : 'day';
    const rid = genId();
    if(!currentBizId) return;
    update(bizItemRef(currentBizId), {
        [`roles/${rid}`]: {
            name: name.trim(),
            desc,
            salaryAmount,
            salaryPeriod,
            salaryMode: 'manual',
            salaryType: 'manual',
            createdAt: Date.now()
        }
    }).then(()=>{ toast('✅ Роль добавлена','green'); renderBizOwnerPanel(); });
};
window.deleteRole = async function(rid){
    if(!currentBizId) return;
    if(!confirm('Удалить роль?')) return;
    await update(bizItemRef(currentBizId), { [`roles/${rid}`]: null });
    toast('🗑 Роль удалена','gold');
    renderBizOwnerPanel();
};

// ─── JOB APP ACTIONS ─────────────────────
window.approveJobApp = async function(bizId, appId, applicant, roleId, roleName){
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    const limits = getBizLimits(b);
    const empCount = Object.keys(b.employees||{}).length;
    if(empCount >= limits.employees) return toast(`❌ Лимит сотрудников (${limits.employees}). Расширьте в панели владельца.`,'red');
    const uSnap = await get(userRef(applicant)); const u = uSnap.val()||{};
    if(!await canTakeAnotherJob(u, applicant)) return toast(`❌ ${applicant}: лимит работ (${getJobLimit(u)})`,'red');
    await update(bizItemRef(bizId), { [`employees/${applicant}`]: { roleId, roleName, joinedAt: Date.now() } });
    await update(ref(db,`bizJobApps/${bizId}/${appId}`), { status: 'approved' });
    const emps = collectEmploymentsFromData(u, applicant);
    const newEmp = { id: `biz_${bizId}`, type: 'business', bizId, role: roleName || 'Сотрудник', bizName: b.name };
    await update(userRef(applicant), {
        employments: [...emps.filter(e=>e.id!==newEmp.id), newEmp],
        employerBizId: bizId,
        displayJob: u.displayJob || roleName || 'Сотрудник'
    });
    await pushNotification(applicant, `✅ Вас приняли в «${b.name}» на роль ${roleName}!`, 'system');
    toast(`✅ ${applicant} принят`, 'green');
    renderBizOwnerPanel();
};
window.rejectJobApp = async function(bizId, appId, applicant){
    const snap = await get(bizItemRef(bizId)); if(!snap.exists()) return;
    const b = snap.val();
    await update(ref(db,`bizJobApps/${bizId}/${appId}`), { status: 'rejected' });
    await pushNotification(applicant, `❌ Заявка в «${b.name}» отклонена`, 'system');
    toast('❌ Отклонено','red');
    renderBizOwnerPanel();
};
window.fireEmployee = async function(nick){
    if(!currentBizId) return;
    if(!confirm(`Уволить ${nick}?`)) return;
    await update(bizItemRef(currentBizId), { [`employees/${nick}`]: null });
    const uSnap = await get(userRef(nick)); const u = uSnap.val()||{};
    const emps = collectEmploymentsFromData(u, nick).filter(e => e.id !== `biz_${currentBizId}`);
    const patch = { employments: emps };
    if(u.employerBizId === currentBizId) patch.employerBizId = null;
    if(u.displayJob && !emps.find(e=>e.role===u.displayJob)) patch.displayJob = emps[0]?.role || null;
    await update(userRef(nick), patch);
    const snap = await get(bizItemRef(currentBizId));
    await pushNotification(nick, `🚪 Вы уволены из бизнеса «${snap.val()?.name||''}»`, 'system');
    toast(`🚪 ${nick} уволен`,'gold');
    renderBizOwnerPanel();
};
window.payEmployee = async function(nick){
    if(!currentBizId) return;
    const snap = await get(bizItemRef(currentBizId)); if(!snap.exists()) return;
    const b = snap.val();
    // Only owner can pay
    if(b.owner !== currentNick) return toast('❌ Только владелец может переводить зарплату','red');
    const emp = b.employees?.[nick];
    const role = emp ? b.roles?.[emp.roleId] : null;
    const suggested = role ? normalizeRoleAmount(role) : '';
    const hint = suggested ? ` (ставка: ${suggested} ₽)` : '';
    const amtStr = prompt(`Перевести зарплату сотруднику ${nick}${hint}\nСумма со счёта бизнеса (₽):`);
    const amt = parseInt(amtStr||'0',10);
    if(!amt||amt<=0) return;
    if((b.balance||0) < amt) return toast(`❌ На счету бизнеса только ${(b.balance||0).toLocaleString()} ₽`,'red');
    const empSnap = await get(userRef(nick)); if(!empSnap.exists()) return;
    const empUser = empSnap.val();
    await update(bizItemRef(currentBizId), { balance: (b.balance||0) - amt });
    await update(userRef(nick), { balance: (empUser.balance||0) + amt });
    await logTx(nick, {type:'in',who:b.name,amt,desc:`Зарплата от «${b.name}»`});
    await logTx(currentNick, {type:'out',who:nick,amt,desc:`Зарплата сотруднику ${nick} («${b.name}»)`});
    await pushNotification(nick, `💰 Получена зарплата ${amt.toLocaleString()}₽ от «${b.name}»`, 'money');
    toast(`💸 ${amt.toLocaleString()}₽ переведено сотруднику ${nick}`,'green');
    renderBizOwnerPanel();
};

// ─── BIZ FINANCE ─────────────────────────
window.bizDeposit = async function(){
    if(!currentBizId) return;
    const amtStr = prompt('Пополнить счёт бизнеса из своего баланса. Сумма (₽):');
    const amt = parseInt(amtStr||'0',10); if(!amt||amt<=0) return;
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val();
    if((u.balance||0)<amt) return toast('❌ Недостаточно средств','red');
    const bSnap = await get(bizItemRef(currentBizId)); const b = bSnap.val();
    await update(userRef(currentNick), { balance: (u.balance||0)-amt });
    await update(bizItemRef(currentBizId), { balance: (b.balance||0)+amt });
    await logTx(currentNick, {type:'out',who:b.name,amt,desc:`Пополнение счёта бизнеса «${b.name}»`});
    toast(`💰 ${amt}₽ пополнено`,'green');
    renderBizOwnerPanel();
};
window.bizWithdraw = async function(){
    if(!currentBizId) return;
    const amtStr = prompt('Снять деньги со счёта бизнеса. Сумма (₽):');
    const amt = parseInt(amtStr||'0',10); if(!amt||amt<=0) return;
    const bSnap = await get(bizItemRef(currentBizId)); const b = bSnap.val();
    if((b.balance||0)<amt) return toast('❌ Недостаточно на счету бизнеса','red');
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val();
    await update(bizItemRef(currentBizId), { balance: (b.balance||0)-amt });
    await update(userRef(currentNick), { balance: (u.balance||0)+amt });
    await logTx(currentNick, {type:'in',who:b.name,amt,desc:`Снятие со счёта бизнеса «${b.name}»`});
    toast(`💸 ${amt}₽ снято`,'green');
    renderBizOwnerPanel();
};

// ─── BIZ EDIT ────────────────────────────
window.handleBizIconFile = async function(e){
    const f = e.target.files[0]; if(!f) return;
    _bizEditIconData = await compressImage(f, 300, 0.85);
    toast('🖼 Иконка выбрана','green');
};
window.handleBizBannerFile = async function(e){
    const f = e.target.files[0]; if(!f) return;
    _bizEditBannerData = await compressImage(f, 900, 0.85);
    toast('🖼 Баннер выбран','green');
};
window.handleBizProdPhoto = async function(e){
    const f = e.target.files[0]; if(!f) return;
    _bizProdPhotoData = await compressImage(f, 600, 0.85);
    toast('📷 Фото товара выбрано','green');
};
window.saveBizEdit = async function(){
    if(!currentBizId) return;
    const patch = {
        name: (qs('bizEditName')?.value||'').trim(),
        desc: (qs('bizEditDesc')?.value||'').trim(),
        address: (qs('bizEditAddress')?.value||'').trim(),
        services: (qs('bizEditServices')?.value||'').trim(),
        category: (qs('bizEditCategory')?.value||'').trim(),
        delivery: !!(qs('bizDeliveryCheck')?.checked),
    };
    const editLat = Number(qs('bizEditLat')?.value);
    const editLng = Number(qs('bizEditLng')?.value);
    if(Number.isFinite(editLat) && Number.isFinite(editLng)){ patch.lat=editLat; patch.lng=editLng; }
    if(!patch.name) return toast('⚠️ Укажите название','gold');
    if(_bizEditIconData){ patch.icon = _bizEditIconData; _bizEditIconData = null; }
    if(_bizEditBannerData){ patch.banner = _bizEditBannerData; _bizEditBannerData = null; }
    await update(bizItemRef(currentBizId), patch);
    toast('✅ Бизнес обновлён','green');
    renderBizOwnerPanel();
};

// ─── PRODUCTS ────────────────────────────
window.addBizProduct = async function(){
    if(!currentBizId) return;
    const name = (qs('bizProdName')?.value||'').trim();
    const desc = (qs('bizProdDesc')?.value||'').trim();
    const price = parseInt(qs('bizProdPrice')?.value||'0',10)||0;
    if(!name) return toast('⚠️ Укажите название','gold');
    const bSnap = await get(bizItemRef(currentBizId)); const b = bSnap.val()||{};
    const limits = getBizLimits(b);
    const prodCount = Object.keys(b.products||{}).length;
    if(prodCount >= limits.products) return toast(`❌ Лимит товаров (${limits.products}). Расширьте в панели.`,'red');
    if(price > limits.maxProductPrice) return toast(`❌ Макс. цена товара: ${limits.maxProductPrice.toLocaleString()} ₽`,'red');
    const pid = genId();
    const prod = { name, desc, price, createdAt: Date.now() };
    if(_bizProdPhotoData){ prod.photo = _bizProdPhotoData; _bizProdPhotoData = null; }
    await update(bizItemRef(currentBizId), { [`products/${pid}`]: prod });
    if(qs('bizProdName')) qs('bizProdName').value='';
    if(qs('bizProdDesc')) qs('bizProdDesc').value='';
    if(qs('bizProdPrice')) qs('bizProdPrice').value='';
    toast('✅ Товар добавлен','green');
    renderBizOwnerPanel();
};
window.editBizProduct = async function(pid){
    if(!currentBizId) return;
    const snap = await get(bizItemRef(currentBizId));
    const b = snap.val() || {};
    const existing = b.products?.[pid];
    if(!existing) return toast('❌ Товар не найден','red');

    const name = prompt('Название товара:', String(existing.name || ''));
    if(name === null) return;
    const trimmedName = name.trim();
    if(!trimmedName) return toast('⚠️ Название товара не может быть пустым','gold');

    const desc = prompt('Описание товара:', String(existing.desc || ''));
    if(desc === null) return;

    const priceRaw = prompt('Цена товара (₽):', String(Number(existing.price || 0)));
    if(priceRaw === null) return;
    const price = parseInt(String(priceRaw).replace(/\s+/g,''),10);
    if(!Number.isFinite(price) || price < 0) return toast('⚠️ Укажите корректную цену','gold');

    const limits = getBizLimits(b);
    if(price > limits.maxProductPrice) return toast(`❌ Максимальная цена товара: ${limits.maxProductPrice.toLocaleString()} ₽`,'red');

    const result = await runTransaction(bizItemRef(currentBizId), current => {
        if(!current?.products?.[pid]) return;
        const product = {...current.products[pid], name: trimmedName.slice(0,60), desc: String(desc).trim().slice(0,500), price};
        return {...current, products:{...(current.products||{}), [pid]:product}};
    });
    if(!result?.committed) return toast('❌ Товар уже изменён или удалён','red');
    toast('✅ Товар изменён','green');
    await renderBizOwnerPanel();
};

window.deleteBizProduct = async function(pid){
    if(!currentBizId) return;
    if(!confirm('Удалить товар?')) return;
    await update(bizItemRef(currentBizId), { [`products/${pid}`]: null });
    toast('🗑 Удалено','gold');
    renderBizOwnerPanel();
};


// ─── RENT BUILDINGS ───────────────────────
function renderAdminRentBuildings(buildings){
    const el = qs('adminRentBuildings'); if(!el) return;
    const list = Object.entries(buildings||{}).map(([id,b])=>({...b,id})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    el.innerHTML = list.length ? list.map(b=>{
        // Show display name if available, otherwise nick
        const renterNick = b.renter || '';
        const renterDisplay = (b.renterName && b.renterName.trim()) || renterNick;
        const expMs = (b.rentExpiry && b.rentExpiry > Date.now()) ? b.rentExpiry - Date.now() : 0;
        const expLabel = renterNick
            ? (expMs > 0
                ? `<span style="font-size:11px;color:var(--primary);">⏳ ${Math.ceil(expMs/86400000)} д.</span>`
                : `<span style="font-size:11px;color:var(--red);">⚠️ Истекло</span>`)
            : '';
        return `
        <div class="rent-row" style="align-items:flex-start;gap:10px;">
            ${b.photo ? `<img src="${escHtml(b.photo)}" onclick="openImgViewer('${jsEsc(b.photo)}')" style="width:48px;height:48px;border-radius:10px;object-fit:cover;flex-shrink:0;">` : '<div style="width:48px;height:48px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏘️</div>'}
            <div class="rent-meta" style="flex:1;min-width:0;">
                <div class="rent-title">${escHtml(b.name||'')}</div>
                <div class="rent-sub">${(b.weekPrice||0).toLocaleString()} ₽ / нед.</div>
                ${renterNick
                    ? `<div class="rent-sub" style="color:var(--gold);">Арендует: <b style="cursor:pointer;" onclick="openUserProfile('${jsEsc(renterNick)}')">${escHtml(renterDisplay)}</b> ${expLabel}</div>`
                    : '<div class="rent-sub" style="color:var(--primary);">✅ Свободно</div>'}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
                ${renterNick ? `<button class="btn btn-gold btn-sm" onclick="adminRevokeRent('${jsEsc(b.id)}','${jsEsc(renterNick)}','${jsEsc(b.name||'')}')">🔓 Отобрать</button>` : ''}
                <button class="btn btn-red btn-sm" onclick="deleteRentBuilding('${jsEsc(b.id)}')">✕ Удалить</button>
            </div>
        </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:13px;">Пока нет зданий</div>';
}

window.adminRevokeRent = async function(buildingId, renterNick, buildingName){
    const displayRenter = (window.allUsersCache && window.allUsersCache[renterNick])
        ? ((window.allUsersCache[renterNick].displayName||'').trim() || renterNick)
        : renterNick;
    if(!confirm(`Отобрать здание «${buildingName}» у ${displayRenter}? Деньги НЕ возвращаются.`)) return;
    try {
        await update(rentBuildingRef(buildingId), {
            renter:     null,
            renterName: null,
            rentedAt:   null,
            rentExpiry: null,
        });
        if(typeof pushNotification === 'function'){
            await pushNotification(renterNick, `🏘 Мэрия изъяла у вас аренду здания «${buildingName}».`, 'system');
        }
        toast(`✅ Аренда здания «${buildingName}» отобрана у ${displayRenter}`, 'green');
        const fresh = await get(rentBuildingsRef());
        renderAdminRentBuildings(fresh.val() || {});
    } catch(e){
        console.error('[adminRevokeRent]', e);
        toast('❌ Ошибка: ' + (e.message || 'не удалось отобрать аренду'), 'red');
    }
};
window.handleRentBuildingPhoto = async function(e){
    const f = e.target.files[0]; if(!f) return;
    if(!f.type.startsWith('image/')){
        e.target.value='';
        _rentBuildingPhotoData=null;
        return toast('❌ Выберите именно изображение','red');
    }
    try{
        _rentBuildingPhotoData = await compressImage(f, 900, 0.82);
        const st=qs('rentBuildPhotoStatus'); if(st) st.textContent='✅ Фото выбрано из галереи';
        toast('🖼 Фото здания выбрано','green');
    }catch(err){
        _rentBuildingPhotoData=null;
        e.target.value='';
        console.error('[rent photo]',err);
        toast('❌ Не удалось обработать фото','red');
    }
};
window.addRentBuilding = async function(){
    const name = (qs('rentBuildName')?.value||'').trim();
    const price = parseInt(qs('rentBuildPrice')?.value||'0',10);
    const photo = _rentBuildingPhotoData || '';
    if(!name) return toast('⚠️ Укажите название','gold');
    if(!price || price <= 0) return toast('⚠️ Укажите цену в неделю','gold');
    const id = genId();
    await set(rentBuildingRef(id), {
        id, name, weekPrice: price, photo,
        renter: '', renterName: '', rentedAt: 0, createdAt: Date.now()
    });
    if(qs('rentBuildName')) qs('rentBuildName').value = '';
    if(qs('rentBuildPrice')) qs('rentBuildPrice').value = '';
    if(qs('rentBuildPhotoStatus')) qs('rentBuildPhotoStatus').textContent = 'Фото необязательно';
    if(qs('rentBuildPhotoFile')) qs('rentBuildPhotoFile').value = '';
    _rentBuildingPhotoData = null;
    await renderAdminRentBuildings((await get(rentBuildingsRef())).val()||{});
    toast('✅ Здание добавлено','green');
};
window.deleteRentBuilding = async function(id){
    if(!confirm('Удалить здание?')) return;
    await remove(rentBuildingRef(id));
    await renderAdminRentBuildings((await get(rentBuildingsRef())).val()||{});
    toast('🗑 Удалено','gold');
};
window.rentBuilding = async function(id){
    const snap = await get(rentBuildingRef(id)); if(!snap.exists()) return;
    const b = snap.val();
    if(b.renter) return toast('⚠️ Уже арендовано','gold');
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val() || {};
    const isSubActive = u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
    const hasUltra = (u.subscription === 'ultra') && isSubActive;
    const hasPrime = (u.subscription === 'prime') && isSubActive;
    const basePrice = b.weekPrice || 0;
    const discountPct = hasPrime ? 0.35 : (hasUltra ? 0.20 : 0);
    const finalPrice = discountPct > 0 ? Math.max(1, Math.round(basePrice * (1 - discountPct))) : basePrice;
    const discountNote = discountPct > 0 ? ` (скидка ${hasPrime ? 'Prime -35%' : 'Ultra -20%'}, было ${basePrice}₽)` : '';
    if((u.balance||0) < finalPrice) return toast('❌ Недостаточно средств','red');
    if(!confirm(`Арендовать «${b.name}» за ${finalPrice.toLocaleString()}₽ в неделю?${discountNote}`)) return;
    const now = Date.now();
    const rentExpiry = now + 7 * 24 * 60 * 60 * 1000; // ровно 7 суток
    await update(userRef(currentNick), { balance: (u.balance||0) - finalPrice });
    await update(rentBuildingRef(id), {
        renter: currentNick,
        renterName: displayNick(u) || currentNick,
        rentedAt: now,
        rentExpiry,
    });
    await logTx(currentNick, {type:'out', who:b.name, amt:finalPrice, desc:`Аренда здания «${b.name}»${discountNote}`});
    toast(`🏘 Здание арендовано${discountPct > 0 ? `! Скидка ${hasPrime ? 'Prime 35%' : 'Ultra 20%'}` : ''}`, 'green');
    renderRentBuildings();
};

// ─── RENT EXPIRY CHECK ────────────────────
// Called on render — clears expired rentals automatically
async function checkAndClearExpiredRentals(list) {
    const now = Date.now();
    const expired = list.filter(b =>
        b.renter &&
        b.rentExpiry &&
        now > b.rentExpiry
    );
    if(!expired.length) return;
    await Promise.all(expired.map(async b => {
        try {
            // Use null to delete fields in Firebase Realtime DB
            await update(rentBuildingRef(b.id), {
                renter:     null,
                renterName: null,
                rentedAt:   null,
                rentExpiry: null,
            });
            await pushNotification(b.renter, `🏘 Аренда здания «${b.name}» истекла и сброшена.`, 'system');
        } catch(e){ console.warn('[rentExpiry]', e); }
    }));
}

// Background rental expiry checker — runs every 10 min regardless of page
(function setupRentExpiryWatcher(){
    let started = false;
    async function runCheck(){
        try {
            const snap = await get(rentBuildingsRef());
            const list = Object.values(snap.val() || {});
            await checkAndClearExpiredRentals(list);
        } catch(e){ /* ignore — network may be down */ }
    }
    function start(){
        if(started || !window._getCurrentNick?.()) return;
        started = true;
        setTimeout(runCheck, 5000);
        window._kapaniRentExpiryTimer = setInterval(runCheck, 10 * 60 * 1000);
    }
    // Maintenance is not part of the critical path. The main app starts it
    // explicitly after the authenticated shell has been revealed.
    window.startKapaniRentExpiryWatcher = start;
})();

window.renderRentBuildings = async function(){
    const el = qs('rentBuildingsList'); if(!el) return;
    const snap = await get(rentBuildingsRef());
    let list = Object.values(snap.val()||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));

    // Auto-clear expired rentals first (handles both null and legacy 0/'')
    await checkAndClearExpiredRentals(list);
    // Re-fetch if any expired
    const hasExpired = list.some(b => {
        if(!b.renter) return false;
        const expiry = b.rentExpiry;
        return expiry && Date.now() > expiry;
    });
    if(hasExpired){
        const fresh = await get(rentBuildingsRef());
        list = Object.values(fresh.val()||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    }

    const now = Date.now();
    const myCard = qs('myRentedBuildingCard');
    const my = list.filter(b => b.renter === currentNick);
    if(myCard){
        if(my.length){
            myCard.style.display='block';
            myCard.innerHTML = `<div class="card-title">🏠 Ваши арендованные здания</div>` + my.map(b=>{
                const expMs = b.rentExpiry ? b.rentExpiry - now : 0;
                const expDays = expMs > 0 ? Math.ceil(expMs / 86400000) : 0;
                const expLabel = expDays > 0
                    ? `<div style="font-size:11px;color:${expDays<=1?'var(--red)':'var(--primary)'};">⏳ Осталось: ${expDays} д.</div>`
                    : `<div style="font-size:11px;color:var(--red);">⚠️ Истекает сегодня</div>`;
                return `
                <div class="rent-row" style="align-items:flex-start;">
                    ${b.photo ? `<img src="${escHtml(b.photo)}" onclick="openImgViewer('${jsEsc(b.photo)}')">` : '<div style="width:54px;height:54px;border-radius:12px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏘️</div>'}
                    <div class="rent-meta">
                        <div class="rent-title">${escHtml(b.name||'')}</div>
                        <div class="rent-sub">${(b.weekPrice||0).toLocaleString()} ₽ / неделя</div>
                        ${expLabel}
                    </div>
                </div>`;
            }).join('');
        } else {
            myCard.style.display='none';
            myCard.innerHTML = '';
        }
    }
    el.innerHTML = list.length ? list.map(b=>{
        const expMs = b.renter && b.rentExpiry ? b.rentExpiry - now : 0;
        const expDays = expMs > 0 ? Math.ceil(expMs / 86400000) : 0;
        const expiryNote = b.renter && b.rentExpiry
            ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">⏳ ${expDays > 0 ? `ещё ${expDays} д.` : 'истекает сегодня'}</div>`
            : '';
        return `
        <div class="rent-card ${b.renter ? 'rented' : ''}">
            <div class="rent-row" style="align-items:flex-start;">
                ${b.photo ? `<img src="${escHtml(b.photo)}" onclick="openImgViewer('${jsEsc(b.photo)}')">` : '<div style="width:54px;height:54px;border-radius:12px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏘️</div>'}
                <div class="rent-meta">
                    <div class="rent-title">${escHtml(b.name||'')}</div>
                    <div class="rent-sub">${(b.weekPrice||0).toLocaleString()} ₽ / неделя</div>
                    ${b.renter ? `<div class="rent-owned">Арендует: <b style="color:var(--text);cursor:pointer;" onclick="openUserProfile('${jsEsc(b.renter)}')">${escHtml(b.renterName || b.renter)}</b></div>${expiryNote}` : '<div class="rent-sub">Свободно</div>'}
                </div>
            </div>
            <div class="rent-actions" style="margin-top:10px;">
                ${b.renter ? `<button class="btn btn-ghost btn-sm rent-disabled" disabled>Арендовано</button>` : `<button class="btn btn-gold btn-sm" onclick="rentBuilding('${jsEsc(b.id)}')">Арендовать</button>`}
            </div>
        </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Пока нет зданий</div>';
};
window.refreshRentBuildingsIfNeeded = renderRentBuildings;

// ─── EVENTS / RACES ──────────────────────
const racesRef = () => ref(db, 'races');
const raceRef = (id) => ref(db, `races/${id}`);

let _raceMapPhotoData = null;
let _raceFormEditId = null;

const RACE_TYPE_LABELS = { circuit:'🔄 Круг', sprint:'🏃 Спринт', drag:'🚗 Драг-рейсинг', streetx:'🌀 Стрит-X' };

window.openRaceFormModal = async function(raceId){
  _raceFormEditId = raceId || null;
  _raceMapPhotoData = null;
  ['raceFormName','raceFormDesc','raceFormLaps','raceFormEasyTime','raceFormEasyWin','raceFormEasyLoss',
   'raceFormMedTime','raceFormMedWin','raceFormMedLoss','raceFormHardTime','raceFormHardWin','raceFormHardLoss'].forEach(id=>{
    const el=qs(id); if(el) el.value='';
  });
  const typeEl = qs('raceFormType'); if(typeEl) typeEl.value='circuit';
  toggleRaceLapsRow();
  const preview = qs('raceFormMapPreview'); if(preview) preview.style.display='none';
  const fileInput = qs('raceFormMapFile'); if(fileInput) fileInput.value='';

  if(raceId){
    const snap = await get(raceRef(raceId));
    if(snap.exists()){
      const r = snap.val();
      const set = (id,v) => { const el=qs(id); if(el) el.value=v||''; };
      set('raceFormName', r.name);
      set('raceFormDesc', r.desc);
      if(typeEl) typeEl.value = r.type || 'circuit';
      set('raceFormLaps', r.laps);
      toggleRaceLapsRow();
      set('raceFormEasyTime', r.easy?.time); set('raceFormEasyWin', r.easy?.win); set('raceFormEasyLoss', r.easy?.loss);
      set('raceFormMedTime', r.med?.time); set('raceFormMedWin', r.med?.win); set('raceFormMedLoss', r.med?.loss);
      set('raceFormHardTime', r.hard?.time); set('raceFormHardWin', r.hard?.win); set('raceFormHardLoss', r.hard?.loss);
      if(r.mapImg){
        const img = qs('raceFormMapImg'); if(img) img.src = r.mapImg;
        if(preview) preview.style.display='block';
      }
    }
  }
  qs('raceFormModal').style.display='block';
};
window.closeRaceFormModal = function(){ qs('raceFormModal').style.display='none'; _raceMapPhotoData=null; _raceFormEditId=null; };

function toggleRaceLapsRow(){
  const type = qs('raceFormType')?.value;
  const row = qs('raceFormLapsRow');
  if(row) row.style.display = (type==='circuit'||type==='streetx') ? 'block' : 'none';
}
const raceTypeEl = () => qs('raceFormType');
document.addEventListener('DOMContentLoaded', ()=>{
  const t = raceTypeEl(); if(t) t.addEventListener('change', toggleRaceLapsRow);
});
// Also hook via onchange since dynamic
window.toggleRaceLapsRow = toggleRaceLapsRow;

window.handleRaceMapPhoto = async function(e){
  const f = e.target.files[0]; if(!f) return;
  _raceMapPhotoData = await compressImage(f, 1000, 0.85);
  const img = qs('raceFormMapImg'); if(img){ img.src = _raceMapPhotoData; }
  const preview = qs('raceFormMapPreview'); if(preview) preview.style.display='block';
};
window.clearRaceMapPhoto = function(){
  _raceMapPhotoData = null;
  const img = qs('raceFormMapImg'); if(img) img.removeAttribute('src');
  const preview = qs('raceFormMapPreview'); if(preview) preview.style.display='none';
  const fileInput = qs('raceFormMapFile'); if(fileInput) fileInput.value='';
};

window.submitRaceForm = async function(){
  const name = (qs('raceFormName')?.value||'').trim();
  const type = qs('raceFormType')?.value || 'circuit';
  const laps = parseInt(qs('raceFormLaps')?.value||'0',10);
  const desc = (qs('raceFormDesc')?.value||'').trim();
  const easy = { time:(qs('raceFormEasyTime')?.value||'').trim(), win:parseInt(qs('raceFormEasyWin')?.value||'0',10), loss:parseInt(qs('raceFormEasyLoss')?.value||'0',10) };
  const med  = { time:(qs('raceFormMedTime')?.value||'').trim(),  win:parseInt(qs('raceFormMedWin')?.value||'0',10),  loss:parseInt(qs('raceFormMedLoss')?.value||'0',10)  };
  const hard = { time:(qs('raceFormHardTime')?.value||'').trim(), win:parseInt(qs('raceFormHardWin')?.value||'0',10), loss:parseInt(qs('raceFormHardLoss')?.value||'0',10) };
  if(!name) return toast('⚠️ Укажите название трассы','gold');
  if(!easy.time||!easy.win||!easy.loss||!med.time||!med.win||!med.loss||!hard.time||!hard.win||!hard.loss) return toast('⚠️ Заполните все уровни сложности','gold');
  if((type==='circuit'||type==='streetx')&&(!laps||laps<1)) return toast('⚠️ Укажите количество кругов','gold');

  const id = _raceFormEditId || genId();
  const existing = _raceFormEditId ? (await get(raceRef(id))).val() || {} : {};
  let mapImg = existing.mapImg || '';
  if(_raceMapPhotoData) mapImg = _raceMapPhotoData;

  await set(raceRef(id), {
    id, name, type, laps: (type==='circuit'||type==='streetx') ? laps : null,
    desc, mapImg, easy, med, hard,
    createdAt: existing.createdAt || Date.now(), updatedAt: Date.now(), createdBy: currentNick
  });
  closeRaceFormModal();
  toast(_raceFormEditId ? '✅ Гонка обновлена' : '🏁 Гонка добавлена', 'green');
  renderAdminRaces();
};

window.deleteRace = async function(id){
  if(!confirm('Удалить эту гонку?')) return;
  await remove(raceRef(id));
  toast('🗑 Гонка удалена','red');
  renderAdminRaces();
};

window.renderAdminRaces = async function(){
  const el = qs('adminRacesList'); if(!el) return;
  const snap = await get(racesRef());
  const races = Object.values(snap.val()||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  if(!races.length){ el.innerHTML='<div style="color:var(--muted);font-size:13px;">Гонок пока нет</div>'; return; }
  el.innerHTML = races.map(r=>`
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;">
      <div style="font-weight:900;font-size:14px;margin-bottom:2px;">${escHtml(r.name)}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${RACE_TYPE_LABELS[r.type]||r.type}${r.laps?` · ${r.laps} кр.`:''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="openRaceFormModal('${jsEsc(r.id)}')">✏️ Редактировать</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red-dim);" onclick="deleteRace('${jsEsc(r.id)}')">🗑 Удалить</button>
      </div>
    </div>`).join('');
};


// ─── RACE DAY GROUPS ─────────────────────
const raceDayGroupsRef = () => ref(db, 'raceDayGroups');
const raceDayGroupRef = (key) => ref(db, 'raceDayGroups/' + key);

let _dayGroupFormEditKey = null;

window.openDayGroupFormModal = async function(groupKey) {
  _dayGroupFormEditKey = groupKey || null;
  const nameEl = qs('dayGroupFormName');
  const idEl = qs('dayGroupFormId');
  const cbWrap = qs('dayGroupRaceCheckboxes');
  if (nameEl) nameEl.value = '';
  if (idEl) idEl.value = '';
  if (cbWrap) cbWrap.innerHTML = '<div style="color:var(--muted);font-size:13px;">Загрузка гонок...</div>';

  // Load all races
  const racesSnap = await get(racesRef());
  const allRaces = Object.values(racesSnap.val() || {}).sort((a,b)=>(a.name||'').localeCompare(b.name||''));

  let selectedIds = {};
  if (groupKey) {
    const snap = await get(raceDayGroupRef(groupKey));
    if (snap.exists()) {
      const g = snap.val();
      if (nameEl) nameEl.value = g.name || '';
      if (idEl) idEl.value = groupKey;
      (g.raceIds || []).forEach(id => { selectedIds[id] = true; });
    }
  }

  if (cbWrap) {
    if (!allRaces.length) {
      cbWrap.innerHTML = '<div style="color:var(--muted);font-size:13px;">Сначала добавьте гонки</div>';
    } else {
      cbWrap.innerHTML = allRaces.map(r => `
        <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;">
          <input type="checkbox" data-race-id="${escHtml(r.id)}" ${selectedIds[r.id] ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0;accent-color:var(--gold);">
          <span style="font-weight:700;font-size:13px;">${escHtml(r.name)}</span>
          <span style="font-size:11px;color:var(--muted);margin-left:auto;">${escHtml(RACE_TYPE_LABELS[r.type]||r.type)}</span>
        </label>`).join('');
    }
  }

  qs('dayGroupFormModal').style.display = 'block';
};

window.closeDayGroupFormModal = function() {
  qs('dayGroupFormModal').style.display = 'none';
  _dayGroupFormEditKey = null;
};

window.submitDayGroupForm = async function() {
  const name = (qs('dayGroupFormName')?.value || '').trim();
  if (!name) return toast('⚠️ Введите название дня','gold');
  const cbWrap = qs('dayGroupRaceCheckboxes');
  const checked = cbWrap ? Array.from(cbWrap.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.dataset.raceId) : [];

  const key = _dayGroupFormEditKey || genId();
  const existing = _dayGroupFormEditKey ? (await get(raceDayGroupRef(key))).val() || {} : {};

  await set(raceDayGroupRef(key), {
    key, name, raceIds: checked,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now()
  });

  closeDayGroupFormModal();
  toast(_dayGroupFormEditKey ? '✅ День обновлён' : '📅 День добавлен', 'green');
  renderAdminDayGroups();
  populateRaceDayGroupSelect();
};

window.deleteDayGroup = async function(key) {
  if (!confirm('Удалить эту группу дня? Жители, назначенные на этот день, потеряют назначение.')) return;
  await remove(raceDayGroupRef(key));
  toast('🗑 Группа дня удалена', 'red');
  renderAdminDayGroups();
  populateRaceDayGroupSelect();
};

window.renderAdminDayGroups = async function() {
  const el = qs('adminDayGroupsList'); if (!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Загрузка...</div>';
  const [dgSnap, racesSnap] = await Promise.all([get(raceDayGroupsRef()), get(racesRef())]);
  const groups = Object.values(dgSnap.val() || {}).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const racesMap = racesSnap.val() || {};

  if (!groups.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Групп пока нет</div>';
    return;
  }

  el.innerHTML = groups.map(g => {
    const raceNames = (g.raceIds || []).map(id => racesMap[id]?.name || id);
    return `
    <div style="background:var(--surface2);border:1px solid rgba(255,128,106,.2);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;">
      <div style="font-weight:900;font-size:14px;color:var(--gold);margin-bottom:4px;">📅 ${escHtml(g.name)}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${raceNames.length ? raceNames.map(n=>`🏁 ${escHtml(n)}`).join(' · ') : 'Гонок нет'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" style="border-color:rgba(255,128,106,.35);color:var(--gold);" onclick="openDayGroupFormModal('${jsEsc(g.key)}')">✏️ Редактировать</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red-dim);" onclick="deleteDayGroup('${jsEsc(g.key)}')">🗑 Удалить</button>
      </div>
    </div>`;
  }).join('');
};

async function populateRaceDayGroupSelect() {
  const sel = qs('raceDayGroupSelect'); if (!sel) return;
  const snap = await get(raceDayGroupsRef());
  const groups = Object.values(snap.val() || {}).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  sel.innerHTML = '<option value="">— Выберите день —</option>' +
    groups.map(g=>`<option value="${escHtml(g.key)}">${escHtml(g.name)}</option>`).join('');
}

async function populateRaceDayUserSelect() {
  const sel = qs('raceDayUserSelect'); if (!sel) return;
  const snap = await get(ref(db,'users'));
  const users = snap.val() || {};
  sel.innerHTML = '<option value="">— Выберите жителя —</option>' +
    Object.keys(users).map(nick=>`<option value="${escHtml(nick)}">${escHtml(nick)}</option>`).join('');
}

window.adminSetUserRaceDay = async function() {
  const nick = qs('raceDayUserSelect')?.value;
  const dayKey = qs('raceDayGroupSelect')?.value;
  const statusEl = qs('raceDayAssignStatus');
  if (!nick) { toast('⚠️ Выберите жителя','gold'); return; }

  const snap = await get(raceDayGroupRef(dayKey));
  const dayName = dayKey && snap.exists() ? snap.val().name : null;

  await update(ref(db, 'users/' + nick), { raceDay: dayKey || null });

  if (statusEl) {
    statusEl.textContent = dayKey && dayName
      ? `✅ ${nick} → ${dayName}`
      : `✅ ${nick} — день снят`;
    statusEl.style.color = 'var(--primary)';
  }
  toast(dayKey && dayName ? `✅ ${nick} назначен: ${dayName}` : `✅ День снят с ${nick}`, 'green');

  // notify user
  if (dayKey && dayName) {
    try { await pushNotification(nick, `🏁 Тебе назначен ${dayName} гонок — загляни в Мероприятия!`, 'system'); } catch(e){}
  }
};

// ─── EVENTS SECTION (user view) ──────────
window.renderEventsSection = async function(){
  const el = qs('eventsGrid'); if(!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Загрузка...</div>';

  // Determine user's assigned race day
  const uSnap = await get(ref(db, 'users/' + currentNick));
  const userData = uSnap.val() || {};
  const userRaceDay = userData.raceDay || null;

  const [racesSnap, dgSnap] = await Promise.all([get(racesRef()), get(raceDayGroupsRef())]);
  const allRacesMap = racesSnap.val() || {};
  const dayGroups = dgSnap.val() || {};

  // Admin sees all races (unchanged)
  if (currentNick === ADMIN) {
    const races = Object.values(allRacesMap).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!races.length){ el.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:40px 0;">Мероприятий пока нет</div>'; return; }
    el.innerHTML = races.map(r=>renderRaceCard(r)).join('');
    return;
  }

  // For regular users: show only races from their assigned day group
  if (!userRaceDay || !dayGroups[userRaceDay]) {
    el.innerHTML = `<div style="text-align:center;padding:48px 16px;">
      <div style="font-size:52px;margin-bottom:14px;">🏁</div>
      <div style="font-weight:900;font-size:16px;margin-bottom:8px;">День гонок не назначен</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6;">Мэрия ещё не назначила тебе день. Скоро появится!</div>
    </div>`;
    return;
  }

  const dayGroup = dayGroups[userRaceDay];
  const raceIds = dayGroup.raceIds || [];

  if (!raceIds.length) {
    el.innerHTML = `<div style="text-align:center;padding:48px 16px;">
      <div style="font-size:52px;margin-bottom:14px;">📅</div>
      <div style="font-weight:900;font-size:16px;margin-bottom:8px;">${escHtml(dayGroup.name)}</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6;">В твоём дне пока нет гонок</div>
    </div>`;
    return;
  }

  const dayRaces = raceIds.map(id => allRacesMap[id]).filter(Boolean).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(255,128,106,.08);border:1px solid rgba(255,128,106,.25);border-radius:var(--r-sm);margin-bottom:14px;">
      <div style="font-size:28px;">📅</div>
      <div>
        <div style="font-weight:900;font-size:15px;color:var(--gold);">${escHtml(dayGroup.name)}</div>
        <div style="font-size:12px;color:var(--muted);">${dayRaces.length} ${dayRaces.length===1?'гонка':'гонок'} сегодня</div>
      </div>
    </div>
    ${dayRaces.map(r=>renderRaceCard(r)).join('')}`;
};

function renderRaceCard(r){
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:14px;cursor:pointer;transition:.2s;" onclick="openEventDetail('${jsEsc(r.id)}')" onmouseenter="this.style.borderColor='var(--gold)'" onmouseleave="this.style.borderColor='var(--border)'">
    ${r.mapImg ? `<img src="${escHtml(r.mapImg)}" style="width:100%;height:180px;object-fit:cover;display:block;" onclick="event.stopPropagation();openImgViewer('${jsEsc(r.mapImg)}')">` : '<div style="width:100%;height:120px;background:linear-gradient(135deg,var(--surface2),rgba(255,128,106,.06));display:flex;align-items:center;justify-content:center;font-size:48px;">🏁</div>'}
    <div style="padding:14px;">
      <div style="font-weight:900;font-size:16px;margin-bottom:4px;">${escHtml(r.name)}</div>
      <div style="font-size:12px;color:var(--gold);font-weight:800;margin-bottom:6px;">${escHtml(RACE_TYPE_LABELS[r.type]||r.type)}${r.laps?` · ${r.laps} кр.`:''}</div>
      ${r.desc ? `<div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5;">${escHtml(r.desc)}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openEventDiff('${jsEsc(r.id)}','easy');" style="border-color:rgba(240,68,74,.4);color:var(--primary);">🟢 Легко</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openEventDiff('${jsEsc(r.id)}','med');"  style="border-color:rgba(255,128,106,.4);color:var(--gold);">🟡 Средне</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openEventDiff('${jsEsc(r.id)}','hard');" style="border-color:rgba(248,113,113,.4);color:var(--red);">🔴 Сложно</button>
      </div>
    </div>
  </div>`;
}


window.openEventDetail = async function(raceId){
  const snap = await get(raceRef(raceId)); if(!snap.exists()) return toast('❌ Гонка не найдена','red');
  const r = snap.val();
  const el = qs('eventDetailContent'); if(!el) return;
  el.innerHTML = `
    ${r.mapImg ? `<div style="position:relative;margin-bottom:14px;">
      <img src="${escHtml(r.mapImg)}" style="width:100%;border-radius:var(--r-sm);max-height:260px;object-fit:cover;cursor:zoom-in;" onclick="openImgViewer('${jsEsc(r.mapImg)}')" title="Нажмите для полного экрана">
      <div style="position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,.5);border-radius:8px;padding:4px 10px;font-size:11px;color:#fff;font-weight:800;">🔍 Полный экран</div>
    </div>` : ''}
    <div class="card" style="border-color:rgba(255,128,106,.25);background:linear-gradient(145deg,rgba(255,128,106,.06),transparent);">
      <div style="font-size:24px;font-weight:900;margin-bottom:4px;">${escHtml(r.name)}</div>
      <div style="font-size:13px;color:var(--gold);font-weight:800;margin-bottom:8px;">${RACE_TYPE_LABELS[r.type]||r.type}${r.laps?` · ${r.laps} кр.`:''}</div>
      ${r.desc ? `<div style="font-size:13px;color:var(--muted);line-height:1.6;">${escHtml(r.desc)}</div>` : ''}
    </div>
    <div style="font-weight:900;font-size:14px;margin:14px 0 10px;">🎯 Выбери уровень сложности:</div>
    <div style="display:grid;grid-template-columns:1fr;gap:10px;">
      ${['easy','med','hard'].map((lvl,i)=>{
        const labels = ['🟢 Легко','🟡 Средне','🔴 Сложно'];
        const colors = ['var(--primary)','var(--gold)','var(--red)'];
        const bgs = ['rgba(240,68,74,.06)','rgba(255,128,106,.06)','rgba(248,113,113,.06)'];
        const borders = ['rgba(240,68,74,.25)','rgba(255,128,106,.25)','rgba(248,113,113,.25)'];
        const d = r[lvl] || {};
        return `<div style="padding:14px;background:${bgs[i]};border:1px solid ${borders[i]};border-radius:var(--r-sm);cursor:pointer;" onclick="openEventDiff('${jsEsc(r.id)}','${lvl}')">
          <div style="font-weight:900;font-size:15px;color:${colors[i]};margin-bottom:8px;">${labels[i]}</div>
          <div style="font-size:13px;"><span style="color:var(--muted);">⏱ Цель:</span> <b>${escHtml(d.time||'—')}</b></div>
          <div style="font-size:13px;margin-top:4px;"><span style="color:var(--primary);">💰 Выигрыш:</span> <b>${(d.win||0)}₽</b> &nbsp; <span style="color:var(--red);">📉 Проигрыш:</span> <b>${(d.loss||0)}₽</b></div>
        </div>`;
      }).join('')}
    </div>`;
  navTo('eventDetail');
};

window.openEventDiff = async function(raceId, level){
  const snap = await get(raceRef(raceId)); if(!snap.exists()) return;
  const r = snap.val();
  const labels = {easy:'🟢 Легко', med:'🟡 Средне', hard:'🔴 Сложно'};
  const colors = {easy:'var(--primary)', med:'var(--gold)', hard:'var(--red)'};
  const d = r[level] || {};
  const el = qs('eventDiffContent'); if(!el) return;
  qs('eventDiffTitle').textContent = `${r.name} — ${labels[level]}`;
  el.innerHTML = `
    <div style="text-align:center;padding:10px 0 20px;">
      <div style="font-size:48px;margin-bottom:12px;">${level==='easy'?'🏅':level==='med'?'🏆':'🔥'}</div>
      <div style="font-size:16px;font-weight:900;color:${colors[level]};margin-bottom:4px;">${labels[level]}</div>
    </div>
    <div style="display:grid;gap:10px;">
      <div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-weight:800;">⏱ Целевое время</div>
        <div style="font-size:24px;font-weight:900;">${escHtml(d.time||'—')}</div>
      </div>
      <div style="padding:14px;background:rgba(240,68,74,.06);border:1px solid rgba(240,68,74,.25);border-radius:var(--r-sm);">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-weight:800;">💰 Ставка за выигрыш</div>
        <div style="font-size:24px;font-weight:900;color:var(--primary);">+${(d.win||0)}₽</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Если уложишься в целевое время</div>
      </div>
      <div style="padding:14px;background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.25);border-radius:var(--r-sm);">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-weight:800;">📉 Ставка за проигрыш</div>
        <div style="font-size:24px;font-weight:900;color:var(--red);">-${(d.loss||0)}₽</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Если не уложишься</div>
      </div>
    </div>`;
  qs('eventDiffModal').style.display='block';
};
window.closeEventDiffModal = function(){ qs('eventDiffModal').style.display='none'; };

// Load races for admin panel when navigating there
const _origRenderAdmin = typeof renderAdmin === 'function' ? renderAdmin : null;

// ─── TERMINAL ────────────────────────────
let _terminalBizId = null;
let _terminalAmt = 0;
let _terminalDesc = '';

window.openTerminal = async function(){
    if(!currentBizId) return;
    const amt = parseInt(qs('terminalAmtInput')?.value||'0',10);
    if(!amt||amt<=0) return toast('⚠️ Укажите сумму','gold');
    const snap = await get(bizItemRef(currentBizId)); if(!snap.exists()) return;
    const b = snap.val();
    _terminalBizId = currentBizId;
    _terminalAmt = amt;
    _terminalDesc = (qs('terminalDescInput')?.value||'').trim();
    qs('terminalBizName').textContent = b.name;
    qs('terminalAmtDisplay').textContent = amt.toLocaleString() + ' ₽';
    qs('terminalDescDisplay').textContent = _terminalDesc;
    qs('terminalOverlay').classList.add('open');
};
window.closeTerminal = function(){
    qs('terminalOverlay').classList.remove('open');
    _terminalBizId = null; _terminalAmt = 0; _terminalDesc = '';
};
let _terminalPayBusy = false;
window.terminalPay = async function(){
    if(_terminalPayBusy) return toast('⏳ Оплата уже выполняется…','gold');
    if(!_terminalBizId || !_terminalAmt) return;
    _terminalPayBusy = true;
    const payBtn = document.querySelector('#terminalOverlay .btn-primary');
    if(payBtn){ payBtn.disabled = true; payBtn.textContent = '⏳ Оплата…'; }
    try {
    if(!await requireSpendable()) return;
    const uSnap = await get(userRef(currentNick)); const u = uSnap.val();
    if((u.balance||0) < _terminalAmt) return toast('❌ Недостаточно средств','red');
    const bSnap = await get(bizItemRef(_terminalBizId)); if(!bSnap.exists()) return;
    const b = bSnap.val();
    // Deduct from client, add to biz balance
    await update(userRef(currentNick), { balance: (u.balance||0) - _terminalAmt });
    await update(bizItemRef(_terminalBizId), { balance: (b.balance||0) + _terminalAmt });
    await logTx(currentNick, {type:'out',who:b.name,amt:_terminalAmt,desc:`Оплата терминалом в «${b.name}»${_terminalDesc?' — '+_terminalDesc:''}`});
    await pushNotification(b.owner, `💳 Терминал: ${currentNick} оплатил ${_terminalAmt}₽${_terminalDesc?' ('+_terminalDesc+')':''}`, 'money');
    // Animation
    qs('terminalOverlay').classList.remove('open');
    const anim = qs('terminalPayAnim');
    anim.classList.add('show');
    setTimeout(()=>{ anim.classList.remove('show'); }, 900);
    toast(`✅ ${_terminalAmt.toLocaleString()}₽ оплачено`, 'green');
    _terminalBizId = null; _terminalAmt = 0; _terminalDesc = '';
    if(qs('terminalAmtInput')) qs('terminalAmtInput').value='';
    if(qs('terminalDescInput')) qs('terminalDescInput').value='';
    } finally {
        _terminalPayBusy = false;
        if(payBtn && payBtn.isConnected){ payBtn.disabled = false; payBtn.textContent = '✅ Оплатить'; }
    }
};


// ─── LOADING SCREEN CONTROL ───────────────
// The overlay is ONLY hidden inside startApp() after data loads,
// or after safety timeout. Never hide it prematurely on 'load' event.
const _loadingTimeout = setTimeout(()=>{ if(!appStarted) hideLoading(); }, 15000);
function hideLoadingSafe(){ clearTimeout(_loadingTimeout); hideLoading(); }

// Local HTML entry points are supported. Data still requires an internet
// connection; PWA push notifications require an HTTPS origin.
if(location.protocol === 'file:') console.info('[Kapani] Локальный запуск через file://. Для push используйте HTTPS.');

async function bootstrapKapaniAuthAndApp(){
    if(!currentNick){
        setTimeout(hideLoadingSafe, 600);
        return;
    }

    try{
        // Initialize Firebase Auth and wait for its persisted state before the app shell
        // starts. A null currentUser here is only meaningful after auth initialization.
        const auth = await ensureAuth();
        await waitForFirebaseAuthUser(8000);

        if(auth.currentUser?.uid === currentNick){
            console.info('[Kapani auth] verified Supabase session restored:', auth.currentUser.uid);
        }else if(_kapaniSessionPassword){
            try{
                await requireKapaniServerSession(8000);
            }catch(e){
                console.warn('[Kapani auth] startup session recovery:', e?.message || e);
                scheduleKapaniServerSessionRetry(currentNick);
            }
        }else{
            console.warn('[Kapani auth] Supabase session missing; requiring a fresh login');
            localStorage.removeItem('kp_s');
            localStorage.removeItem('kp_auth');
            sessionStorage.removeItem('kp_s');
            currentNick=null;
            syncCurrentNick();
            hideLoadingSafe();
            return;
        }
    }catch(e){
        // Do not block the whole application on a temporary Auth initialization race.
        // Protected actions will use the same single-flight recovery helper later.
        console.warn('[Kapani auth] startup init:', e?.message || e);
    }

    try {
        startApp();
    } catch(e) {
        console.error('[startApp]', e);
        hideLoadingSafe();
    }
}

// DO NOT hide on window.load — wait for Firebase Auth initialization + app data
void bootstrapKapaniAuthAndApp();
if(curPage==='tasks') renderTasks();

// ─── SAFER STRING HELPERS ─────────────────
function jsEsc(v){return String(v ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r/g,' ').replace(/\n/g,' ');}
function preserveScrollState(el){
    return el ? {top: el.scrollTop, height: el.scrollHeight, stick: (el.scrollHeight - el.scrollTop - el.clientHeight) < 90} : null;
}
function restoreScrollState(el, state){
    if(!el || !state) return;
    if(state.stick){
        el.scrollTop = el.scrollHeight;
    } else {
        const delta = el.scrollHeight - state.height;
        el.scrollTop = Math.max(0, state.top + delta);
    }
}
function mediaHtml(m){
    const caption = escHtml(m.caption || m.text || '');
    let html='';
    if(caption) html += `<div class="msg-caption">${caption}</div>`;
    if(m.msgType==='image' || (!m.msgType && m.mediaData && /^data:image\//.test(m.mediaData))){
        html += `<div class="msg-media-wrap" onclick="event.stopPropagation()"><img class="msg-media-img" src="${escHtml(m.mediaData)}" loading="lazy" decoding="async" onclick="openImgViewer('${jsEsc(m.mediaData)}')" alt="Фото"></div>`;
    } else if(m.msgType==='video'){
        // Preview (tap to open viewer). Use #t=0.1 so browser can grab a first frame.
        const vsrc = escHtml(m.mediaData || '');
        html += `<div class="msg-media-wrap" onclick="event.stopPropagation()">
            <div style="position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:#0b1220;cursor:pointer;" onclick="openVideoViewer('${jsEsc(m.mediaData)}')">
                <video class="msg-media-video" muted playsinline webkit-playsinline preload="metadata" style="max-height:260px;pointer-events:none;">
                    <source src="${vsrc}#t=0.1">
                </video>
                <div class="vc-play-overlay" style="border-radius:12px;">▶</div>
            </div>
        </div>`;
    } else if(m.msgType==='video_circle'){
        // Preview frame (tap to open viewer). Use #t=0.1 for a visible first frame.
        const vsrc = escHtml(m.mediaData || '');
        // Video messages should NEVER be mirrored - always display as recorded
        html += `<div class="msg-media-wrap msg-media-circle" onclick="event.stopPropagation()">
            <div class="msg-video-wrap" onclick="openVideoViewer('${jsEsc(m.mediaData)}')" style="background:#111;">
                <video muted playsinline webkit-playsinline preload="metadata">
                    <source src="${vsrc}#t=0.1">
                </video>
                <div class="vc-play-overlay">▶</div>
            </div>
        </div>`;
    } else if(m.msgType==='voice'){
        html += `<div class="msg-media-wrap" onclick="event.stopPropagation()"><div class="chat-audio-player"><audio controls preload="metadata" style="width:100%;"><source src="${escHtml(m.mediaData)}"></audio></div></div>`;
    } else if(m.msgType==='gift_subscription'){
        html += `<div class="msg-text">🎁 ${escHtml(m.text || 'Подарок подписки')}</div>`;
    } else if(!caption && m.mediaData){
        html += `<div class="msg-text">${escHtml(m.text || '')}</div>`;
    }
    return html || `<div class="msg-text"></div>`;
}
function msgActionsHtml(kind, msgId, m, isMe){
    if(!isMe) return '';
    const text = jsEsc(m.text || '');
    const editFn = kind==='chat' ? 'startEditChat' : kind==='dm' ? 'startEditDm' : 'startEditNews';
    const delFn  = kind==='chat' ? 'deleteChat' : kind==='dm' ? 'deleteDm' : 'deleteNewsMsg';
    const idPrefix = kind==='chat' ? 'gcactions_' : kind==='dm' ? 'actions_' : 'newsactions_';
    return `<div class="msg-actions" id="${idPrefix}${msgId}">
        ${!m.msgType ? `<button type="button" class="msg-action-btn" onclick="event.stopPropagation();${editFn}('${jsEsc(msgId)}','${text}')">✏️</button>` : ''}
        <button type="button" class="msg-action-btn" style="color:var(--red);" onclick="event.stopPropagation();${delFn}('${jsEsc(msgId)}')">🗑</button>
    </div>`;
}
function replyPreviewHtml(m){ return ''; }
function msgEditHtml(kind, msgId, m){
    if(m.msgType) return '';
    const textareaId = kind==='chat' ? `gceditText_${msgId}` : kind==='dm' ? `editText_${msgId}` : `newseditText_${msgId}`;
    const areaId = kind==='chat' ? `gcedit_${msgId}` : kind==='dm' ? `edit_${msgId}` : `newsedit_${msgId}`;
    const saveFn = kind==='chat' ? 'saveEditChat' : kind==='dm' ? 'saveEditDm' : 'saveEditNews';
    const cancelFn = kind==='chat' ? 'cancelEditChat' : kind==='dm' ? 'cancelEditDm' : 'cancelEditNews';
    return `<div class="msg-edit-area" id="${areaId}" style="display:none;">
        <textarea style="min-height:44px;font-size:13px;margin:0;" id="${textareaId}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();${saveFn}('${jsEsc(msgId)}');}">${escHtml(m.text||'')}</textarea>
        <div class="edit-btns"><button type="button" class="btn btn-primary btn-sm" onclick="${saveFn}('${jsEsc(msgId)}')">💾</button><button type="button" class="btn btn-ghost btn-sm" onclick="${cancelFn}('${jsEsc(msgId)}')">✕</button></div>
    </div>`;
}

// ─── CHAT RENDER / DELETE FIXES ───────────
let _chatRenderPending = false;
let _chatRenderTimeout = null;

window.renderChat = async function(msgs){
    lastChatMsgs = msgs || {};
    const el = qs('chatMessages'); if(!el) return;
    
    // Debounce render for performance on iPhone
    if(_chatRenderPending) {
        if(_chatRenderTimeout) clearTimeout(_chatRenderTimeout);
        _chatRenderTimeout = setTimeout(() => renderChat(msgs), 50);
        return;
    }
    
    _chatRenderPending = true;
    
    requestAnimationFrame(async () => {
        const scroll = preserveScrollState(el);
        const entries = Object.entries(lastChatMsgs).sort((a,b)=>(a[1]?.createdAt||0)-(b[1]?.createdAt||0)).slice(-60);
        const sig = entries.map(([id,m])=>`${id}:${m.createdAt||0}:${m.text||''}:${m.msgType||''}:${m.mediaData?1:0}:${m.edited?1:0}`).join('|') + '|r:' + JSON.stringify(chatReadStates||{});
        if(el.dataset.sig === sig){ _chatRenderPending = false; return; }
        el.dataset.sig = sig;
        
        // Get current user's chat bubble style
        let myBubbleStyle = '';
        try {
            const u = allUsersCache[currentNick] || {};
            const hasActiveSub = u.subscriptionExpiry && new Date(u.subscriptionExpiry) > new Date();
            if(hasActiveSub) myBubbleStyle = u.chatBubbleStyle || '';
        } catch(e) {}
        
        let lastDateStr = '';
        const otherUsers = Object.keys(allUsersCache).filter(n => n !== currentNick);
        const hasOtherUsers = otherUsers.length > 0;
        const html = entries.map(([msgId, m]) => {
            const isMe = m.nick === currentNick;
            const online = isUserOnline(allUsersCache[m.nick]);
            const edited = m.edited ? `<span style="font-size:9px;color:var(--muted);margin-left:4px;">(изм.)</span>` : '';
            const avSrc = safeAvatar(m.nick, m.avatar);
            const ts = m.createdAt || 0;
            const allRead = isMe && ts > 0 && hasOtherUsers && otherUsers.every(n => (chatReadStates[n] || 0) >= ts);
            const readLine = isMe && ts > 0 && hasOtherUsers
                ? (allRead ? `<div class="chat-time" style="color:var(--primary);font-weight:800;">✓✓ Прочитано всеми</div>` : `<div class="chat-time" style="color:var(--muted);font-size:9px;">✓ Отправлено</div>`)
                : '';
            // Date separator
            const msgDateStr = ts ? new Date(ts).toLocaleDateString('ru', {day:'numeric',month:'long',year:'numeric'}) : '';
            let separator = '';
            if(msgDateStr && msgDateStr !== lastDateStr) {
                lastDateStr = msgDateStr;
                separator = `<div class="chat-date-separator" data-date="${localDateKey(ts)}"><span>${msgDateStr}</span></div>`;
            }
            // Apply custom bubble style for all users with subscriptions
            let bubbleClass = 'chat-bubble';
            const senderUser = allUsersCache[m.nick];
            if(senderUser) {
                const hasActiveSub = senderUser.subscriptionExpiry && new Date(senderUser.subscriptionExpiry) > new Date();
                if(hasActiveSub && senderUser.chatBubbleStyle) {
                    const styleClass = CHAT_BUBBLE_CLASSES[senderUser.chatBubbleStyle];
                    if(styleClass) bubbleClass += ' ' + styleClass;
                }
            }
            const frameClass = getAvatarFrameClass(senderUser);
            const avatarFrameHtml = frameClass
                ? `<div class="avatar-frame ${frameClass}" style="position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;z-index:1;"></div>`
                : '';

            return separator + `<div class="chat-msg ${isMe ? 'me' : ''}" data-msgid="${jsEsc(msgId)}">
                <div class="av-wrap-sm ${online ? 'online' : ''}" onclick="openUserProfile('${jsEsc(m.nick)}')" style="position:relative;">
                    <img class="chat-av" src="${escHtml(avSrc)}" style="cursor:pointer;" loading="lazy" onerror="this.src='https://cdn-icons-png.flaticon.com/512/149/149071.png'">
                    ${avatarFrameHtml}
                    <div class="online-dot"></div>
                </div>
                <div class="chat-msg-body">
                    <div class="${bubbleClass}" id="gcbubble_${jsEsc(msgId)}">
                        ${!isMe ? `<div class="chat-sender" style="cursor:pointer;" onclick="openUserProfile('${jsEsc(m.nick)}')">${escHtml(displayNick(allUsersCache[m.nick]) || m.nick)}</div>` : ''}
                        ${replyPreviewHtml(m)}
                        <div onclick="event.stopPropagation()">${mediaHtml(m)}</div>${edited}
                        <div class="chat-time">${escHtml(m.time||'')}</div>${readLine}
                    </div>
                    ${msgActionsHtml('chat', msgId, m, isMe)}
                    ${msgEditHtml('chat', msgId, m)}
                </div>
            </div>`;
        }).join('');
        el.innerHTML = html;
        restoreScrollState(el, scroll);
        _chatRenderPending = false;
    });
};
window.deleteChat = async function(msgId){
    try { 
        // Добавляем ID удаленного сообщения в Set
        window._recentlyDeletedMsgs = window._recentlyDeletedMsgs || new Set();
        window._recentlyDeletedMsgs.add(msgId);
        // Удаляем из Set через 5 секунд
        setTimeout(() => { window._recentlyDeletedMsgs.delete(msgId); }, 5000);
        await remove(ref(db, `chat/${msgId}`));
        if(lastChatMsgs && lastChatMsgs[msgId]) delete lastChatMsgs[msgId];
        if(curPage==='messages' && document.querySelector('#msgPanel0.active')) renderChat(lastChatMsgs);
    }
    catch(e){ 
        toast('❌ Не удалось удалить сообщение', 'red'); 
    }
};
window.startEditChat = function(msgId, oldText){
    const actions = qs(`gcactions_${msgId}`); if(actions) actions.style.display='none';
    const area = qs(`gcedit_${msgId}`); if(area) area.style.display='block';
    const ta = qs(`gceditText_${msgId}`);
    if(ta){ ta.value = oldText.replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'); ta.focus(); }
};
window.cancelEditChat = function(msgId){ const area = qs(`gcedit_${msgId}`); if(area) area.style.display='none'; };
window.saveEditChat = async function(msgId){
    const ta = qs(`gceditText_${msgId}`); const newText = ta ? ta.value.trim() : '';
    if(!newText) return;
    await update(ref(db, `chat/${msgId}`), { text: newText, edited: true });
    const area = qs(`gcedit_${msgId}`); if(area) area.style.display='none';
};

// ─── DM RENDER / DELETE FIXES ─────────────
let _dmRenderPending = false;
let _dmRenderTimeout = null;

window.renderDmMessages = async function(msgs){
    lastDmMsgs = msgs || {};
    const el = qs('dmMessages'); if(!el) return;
    
    // Debounce render for performance on iPhone
    if(_dmRenderPending) {
        if(_dmRenderTimeout) clearTimeout(_dmRenderTimeout);
        _dmRenderTimeout = setTimeout(() => renderDmMessages(msgs), 50);
        return;
    }
    
    _dmRenderPending = true;
    
    requestAnimationFrame(async () => {
        try {
        const scroll = preserveScrollState(el);
        const entries = Object.entries(lastDmMsgs).sort((a,b)=>(a[1]?.createdAt||0)-(b[1]?.createdAt||0)).slice(-80);
        const sig = entries.map(([id,m])=>`${id}:${m.createdAt||0}:${m.text||''}:${m.msgType||''}:${m.mediaData?1:0}:${m.edited?1:0}`).join('|') + '|peer:' + String(dmPeerReadTs || 0);
        if(el.dataset.sig === sig){ _dmRenderPending = false; return; }
        el.dataset.sig = sig;
        // Get current user's chat bubble style
        let myBubbleStyle = '';
        try {
            const u = allUsersCache?.[currentNick] || {};
            if(hasActiveSubscription(u)) myBubbleStyle = u.chatBubbleStyle || '';
        } catch(e) {}
        
        let lastDateStr = '';
        const html = entries.map(([msgId, m]) => {
            const isMe = m.nick === currentNick;
            const edited = m.edited ? `<span style="font-size:9px;color:var(--muted);margin-left:4px;">(изм.)</span>` : '';
            const ts = m.createdAt || 0;
            const readOk = isMe && dmPeerReadTs && ts && dmPeerReadTs >= ts;
            const readLine = isMe && ts
                ? (readOk ? `<div class="chat-time" style="color:var(--primary);font-weight:800;">✓✓ Прочитано</div>` : `<div class="chat-time" style="color:var(--muted);font-size:9px;">✓ Доставлено</div>`)
                : '';
            // Date separator
            const msgDateStr = ts ? new Date(ts).toLocaleDateString('ru', {day:'numeric',month:'long',year:'numeric'}) : '';
            let separator = '';
            if(msgDateStr && msgDateStr !== lastDateStr) {
                lastDateStr = msgDateStr;
                separator = `<div class="chat-date-separator" data-date="${localDateKey(ts)}"><span>${msgDateStr}</span></div>`;
            }
            // Apply custom bubble style for all users with subscriptions
            let bubbleClass = 'chat-bubble';
            const senderUser = allUsersCache[m.nick];
            if(senderUser) {
                const hasActiveSub = senderUser.subscriptionExpiry && new Date(senderUser.subscriptionExpiry) > new Date();
                if(hasActiveSub && senderUser.chatBubbleStyle) {
                    const styleClass = CHAT_BUBBLE_CLASSES[senderUser.chatBubbleStyle];
                    if(styleClass) bubbleClass += ' ' + styleClass;
                }
            }
            const frameClass = getAvatarFrameClass(senderUser);
            const avatarFrameHtml = frameClass
                ? `<div class="avatar-frame ${frameClass}" style="position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;z-index:1;"></div>`
                : '';
            
            return separator + `<div class="chat-msg ${isMe ? 'me' : ''}" data-msgid="${jsEsc(msgId)}">
                <div style="position:relative;display:inline-block;">
                    <img class="chat-av" src="${escHtml(m.avatar||DEFAULT_AVATAR_URL)}" style="cursor:pointer;" loading="lazy" onclick="openImgViewer(this.src)" onerror="this.src='${DEFAULT_AVATAR_URL}'">
                    ${avatarFrameHtml}
                </div>
                <div class="chat-msg-body">
                    ${!isMe ? `<div class="chat-sender" style="cursor:pointer;" onclick="openUserProfile('${jsEsc(m.nick)}')">${escHtml(displayNick(allUsersCache[m.nick]) || m.nick)}</div>` : ''}
                    <div class="${bubbleClass}" id="bubble_${jsEsc(msgId)}">
                        ${replyPreviewHtml(m)}
                        <div onclick="event.stopPropagation()">${mediaHtml(m)}</div>${edited}
                        <div class="chat-time">${escHtml(m.time||'')}</div>${readLine}
                    </div>
                    ${msgActionsHtml('dm', msgId, m, isMe)}
                    ${msgEditHtml('dm', msgId, m)}
                </div>
            </div>`;
        }).join('');
        el.innerHTML = html;
        restoreScrollState(el, scroll);
        } catch(err) {
            console.error('[Kapani renderDmMessages]', err);
            if(el) el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 12px;">❌ Не удалось отобразить сообщения.</div>';
        } finally {
            _dmRenderPending = false;
            _dmRenderTimeout = null;
        }
    });
};
window.deleteDm = async function(msgId){
    try { 
        if(currentDmNick){
            // Добавляем ID удаленного сообщения в Set
            window._recentlyDeletedMsgs = window._recentlyDeletedMsgs || new Set();
            window._recentlyDeletedMsgs.add(msgId);
            // Удаляем из Set через 5 секунд
            setTimeout(() => { window._recentlyDeletedMsgs.delete(msgId); }, 5000);
            const key = dmKey(currentNick,currentDmNick);
            await remove(ref(db, `dms/${key}/messages/${msgId}`));
            if(lastDmMsgs && lastDmMsgs[msgId]) delete lastDmMsgs[msgId];
            if(curPage==='messages' && currentDmNick) renderDmMessages(lastDmMsgs);
        }
    }
    catch(e){ 
        toast('❌ Не удалось удалить сообщение', 'red'); 
    }
};
window.startEditDm = function(msgId, oldText){
    const actions = qs(`actions_${msgId}`); if(actions) actions.style.display='none';
    const area = qs(`edit_${msgId}`); if(area) area.style.display='block';
    const ta = qs(`editText_${msgId}`);
    if(ta){ ta.value = oldText.replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'); ta.focus(); }
};
window.cancelEditDm = function(msgId){ const area = qs(`edit_${msgId}`); if(area) area.style.display='none'; };
window.saveEditDm = async function(msgId){
    if(!currentDmNick) return;
    const ta = qs(`editText_${msgId}`); const newText = ta ? ta.value.trim() : '';
    if(!newText) return;
    const key = dmKey(currentNick,currentDmNick);
    await update(ref(db, `dms/${key}/messages/${msgId}`), { text: newText, edited: true });
    const area = qs(`edit_${msgId}`); if(area) area.style.display='none';
};

// ─── JUMP TO DATE IN CHAT ─────────────────
window.openJumpToDate = function(ctx){
    
    try {
        // Создаем простой input для выбора даты
        const input = document.createElement('input');
        input.type = 'date';
        input.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:var(--surface);border:2px solid var(--primary);border-radius:12px;padding:12px;color:var(--text);font-size:16px;';
        input.max = new Date().toISOString().split('T')[0];
        
        // Создаем overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:center;justify-content:center;';
        
        // Создаем контейнер
        const container = document.createElement('div');
        container.style.cssText = 'background:var(--surface);border:2px solid var(--border);border-radius:16px;padding:20px;max-width:320px;text-align:center;';
        container.innerHTML = `
            <div style="font-weight:900;font-size:18px;margin-bottom:16px;color:var(--text);">📅 Выберите дату</div>
            <input type="date" id="datePicker" max="${input.max}" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--text);font-size:16px;margin-bottom:16px;">
            <div style="display:flex;gap:8px;">
                <button id="cancelBtn" style="flex:1;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);cursor:pointer;">Отмена</button>
                <button id="okBtn" style="flex:1;padding:10px;background:var(--primary);border:1px solid var(--primary);border-radius:8px;color:var(--bg);cursor:pointer;font-weight:800;">Перейти</button>
            </div>
        `;
        
        overlay.appendChild(container);
        document.body.appendChild(overlay);
        
        // Фокус на input
        const dateInput = container.querySelector('#datePicker');
        dateInput.focus();
        
        // Обработчики
        container.querySelector('#cancelBtn').onclick = function(){
            document.body.removeChild(overlay);
        };
        
        container.querySelector('#okBtn').onclick = function(){
            const dateVal = dateInput.value;
            if(!dateVal) {
                toast('⚠️ Выберите дату', 'gold');
                return;
            }
            
            const elId = ctx==='chat' ? 'chatMessages' : 'dmMessages';
            const el = qs(elId);
            if(!el) {
                toast('❌ Чат не найден', 'red');
                document.body.removeChild(overlay);
                return;
            }
            
            // Ищем разделитель с этой датой
            const sep = el.querySelector(`.chat-date-separator[data-date="${dateVal}"]`);
            if(sep){
                sep.scrollIntoView({behavior:'smooth', block:'start'});
                toast('📅 Перешли к сообщениям', 'green');
            } else {
                const d = new Date(dateVal);
                const formatted = d.toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'});
                toast(`📅 Сообщений за ${formatted} не найдено`, 'gold');
            }
            
            document.body.removeChild(overlay);
        };
        
        // Закрытие по клику на overlay
        overlay.onclick = function(e){
            if(e.target === overlay){
                document.body.removeChild(overlay);
            }
        };
        
        // Закрытие по Escape
        const escapeHandler = function(e){
            if(e.key === 'Escape' && document.body.contains(overlay)){
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
        
    } catch(e){
        console.error('Error in openJumpToDate:', e);
        toast('❌ Ошибка при выборе даты', 'red');
    }
};

// ─── iOS MODAL BODY LOCK (reference-counted, iOS-safe) ──────────────────
let _scrollY = 0;
let _lockCount = 0;
function lockBodyScroll(){
    _lockCount++;
    if(_lockCount > 1) return; // already locked
    _scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${_scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
}
function unlockBodyScroll(force){
    if(force){ _lockCount = 0; }
    else { _lockCount = Math.max(0, _lockCount - 1); }
    if(_lockCount > 0) return; // still locked by another modal
    const y = _scrollY || 0;
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.bottom = '';
    requestAnimationFrame(() => window.scrollTo(0, y));
    _scrollY = 0;
}
// Safety: force-unlock on every page navigation
window.addEventListener('pageshow', () => { _lockCount = 0; unlockBodyScroll(true); });

// ─── VIDEO CIRCLE: NO MIRROR / SWITCH WHILE RECORDING / 60s ─────────────────
let vcSecondsLeft = 60;
let vcTargetCtx = 'chat';
let vcStream = null;
let vcMediaRecorder = null;
let vcChunks = [];
let vcTimerInterval = null;
let vcClosing = false, vcSwitchPending = false;
const VC_MAX_SEC_OVERRIDE = 30;

function vcApplyLiveStyles(v){
    if(!v) return;
    v.style.display = 'block';
    // Let CSS handle mirroring based on data-facing attribute
    v.setAttribute('data-facing', vcFacingMode);
    v.style.objectFit = 'cover';
    // Do NOT set transform here - CSS handles it
}
window.applyVcZoom = async function(val){
    if(!vcStream) return;
    const track = vcStream.getVideoTracks()[0];
    if(!track || !track.applyConstraints) return;
    try{
        const cap = track.getCapabilities ? track.getCapabilities() : {};
        if(cap.zoom){
            const z = cap.zoom;
            const t = z.min + (z.max - z.min) * (Number(val) / 100);
            await track.applyConstraints({ advanced: [{ zoom: t }] });
        }
    } catch(e) {}
};
async function startVcStream(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Камера недоступна');
    const constraints = { video: { facingMode: { ideal: vcFacingMode }, width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } };
    vcStream = await navigator.mediaDevices.getUserMedia(constraints);
    const zr = qs('vcZoomRange');
    if(zr){
        try{
            const tr = vcStream.getVideoTracks()[0];
            const cap = tr && tr.getCapabilities ? tr.getCapabilities() : {};
            if(cap.zoom){ zr.style.display='block'; zr.min=0; zr.max=100; zr.value=0; }
            else { zr.style.display='none'; }
        } catch(e) { if(zr) zr.style.display='none'; }
    }
    const live = qs('vcLiveVid');
    if(live){ live.srcObject = vcStream; vcApplyLiveStyles(live); }
    const play = qs('vcPlaybackVid');
    if(play){ play.pause(); play.removeAttribute('src'); play.load(); play.style.display='none'; }
}
function stopVcTimer(){ clearIntervalByName('vcTimerInterval'); vcTimerInterval = null; }
function stopVcTracks(){ if(vcStream){ vcStream.getTracks().forEach(t=>t.stop()); vcStream = null; } }
function setVcReadyUI(){
    const btn = qs('vcRecBtn'); if(btn){ btn.textContent = '⏺'; btn.classList.remove('is-rec'); }
    const badge = qs('vcTimerBadge'); if(badge){ badge.style.display = 'none'; badge.textContent = `${VC_MAX_SEC_OVERRIDE}s`; }
    const rec = qs('vcRecControls'); if(rec) rec.style.display = 'flex';
    const send = qs('vcSendRow'); if(send) send.classList.remove('show');
}
function setVcPreviewUI(){
    const live = qs('vcLiveVid'); if(live) live.style.display='none';
    const play = qs('vcPlaybackVid'); if(play) play.style.display='block';
    const rec = qs('vcRecControls'); if(rec) rec.style.display='none';
    const send = qs('vcSendRow'); if(send) send.classList.add('show');
    const badge = qs('vcTimerBadge'); if(badge) badge.style.display='none';
}
function vcMime(){ return MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'; }
async function finalizeVcRecording(){
    // Small delay to ensure all ondataavailable events have fired
    await new Promise(r=>setTimeout(r,200));
    if(vcChunks.length===0){ toast('❌ Запись пуста','red'); setVcReadyUI(); return; }
    // Try webm first, fallback to default if needed
    let blob;
    try { blob = new Blob(vcChunks, { type: 'video/webm' }); }
    catch(e) { blob = new Blob(vcChunks); }
    const url = URL.createObjectURL(blob);
    const play = qs('vcPlaybackVid');
    if(play){
        try { stopVcTracks(); } catch(e) {}
        setPlaybackAudioRoute();
        play.onloadedmetadata = () => {
            setPlaybackAudioRoute();
            play.play().catch(()=>{});
        };
        play.src = url;
        play.style.display='block';
        play.playsInline = true;
        play.setAttribute('webkit-playsinline', '');
        play.muted = false;
        play.volume = 1;
        // Let CSS handle mirroring - do NOT set transform here
        play.play().catch(()=>{});
    }
    setVcPreviewUI();
}
function startVcRecording(){
    if(!vcStream) throw new Error('Камера недоступна');
    const vOpts = { mimeType: vcMime(), videoBitsPerSecond: 450000 };
    try { vcMediaRecorder = new MediaRecorder(vcStream, vOpts); } catch(e) { vcMediaRecorder = new MediaRecorder(vcStream, { mimeType: vcMime() }); }
    vcMediaRecorder.ondataavailable = e => { if(e.data && e.data.size>0) vcChunks.push(e.data); };
    vcMediaRecorder.onstop = async () => {
        const shouldSwitch = vcSwitchPending;
        vcSwitchPending = false;
        if(vcClosing) return;
        if(shouldSwitch){
            try {
                stopVcTracks();
                await startVcStream();
                startVcRecording();
                return;
            } catch(e){
                toast('❌ Не удалось переключить камеру: ' + e.message, 'red');
                setVcPreviewUI();
                return;
            }
        }
        await finalizeVcRecording();
    };
    vcMediaRecorder.start(100);
    // Also collect data every second to ensure we don't lose anything
    vcMediaRecorder._interval = setInterval(() => {
        if(vcMediaRecorder && vcMediaRecorder.state === 'recording') {
            try { vcMediaRecorder.requestData(); } catch(e){}
        }
    }, 1000);
    if(vcTargetCtx === 'chat') setChatTypingState('video');
    if(vcTargetCtx === 'dm') setDmTypingState('video');
    const btn = qs('vcRecBtn'); if(btn){ btn.textContent = '⏹'; btn.classList.add('is-rec'); }
    const badge = qs('vcTimerBadge'); if(badge){ badge.style.display='block'; badge.textContent = `${vcSecondsLeft}s`; }
    stopVcTimer();
    vcTimerInterval = registerInterval('vcTimerInterval', setInterval(() => {
        vcSecondsLeft = Math.max(0, vcSecondsLeft - 1);
        const b = qs('vcTimerBadge'); if(b) b.textContent = `${vcSecondsLeft}s`;
        if(vcSecondsLeft <= 0) stopVcRecording();
    }, 1000));
}
function stopVcRecording(){
    stopVcTimer();
    if(vcTargetCtx === 'chat') setChatTypingState('idle');
    if(vcTargetCtx === 'dm') setDmTypingState('idle');
    if(vcMediaRecorder && vcMediaRecorder.state !== 'inactive'){
        // Request final data chunk before stopping
        try { vcMediaRecorder.requestData(); } catch(e){}
        // Clear the interval
        if(vcMediaRecorder._interval) { clearInterval(vcMediaRecorder._interval); vcMediaRecorder._interval = null; }
        try { vcMediaRecorder.stop(); } catch(e) {}
    }
}
window.openVcModal = async function(ctx){
    vcTargetCtx = ctx;
    if(ctx==='chat'||ctx==='dm'){const mb=ctx==='chat'?'chatMediaBar':'dmMediaBar';qs(mb)&&qs(mb).classList.remove('open');}
    vcClosing = false; vcSwitchPending = false; vcSecondsLeft = VC_MAX_SEC_OVERRIDE; vcChunks = [];
    try {
        if(vcMediaRecorder && vcMediaRecorder.state !== 'inactive') { try { vcMediaRecorder.stop(); } catch(e) {} }
        stopVcTimer();
        stopVcTracks();
        await startVcStream();
        setVcReadyUI();
        qs('vcTimerBadge').textContent = `${VC_MAX_SEC_OVERRIDE}s`;
        qs('vcModal').classList.add('open');
    } catch(e){ toast('❌ Нет доступа к камере: ' + e.message, 'red'); }
};
window.closeVcModal = function(){
    vcClosing = true;
    vcSwitchPending = false;
    stopVcTimer();
    if(vcMediaRecorder && vcMediaRecorder.state !== 'inactive'){ try { vcMediaRecorder.stop(); } catch(e) {} }
    stopVcTracks();
    vcChunks = [];
    // Останавливаем воспроизведение превью видео и освобождаем src
    const play = qs('vcPlaybackVid');
    if(play){ play.pause(); play.removeAttribute('src'); play.load(); play.style.display='none'; }
    const live = qs('vcLiveVid');
    if(live){ live.pause(); live.removeAttribute('srcObject'); live.srcObject=null; live.style.display='none'; }
    setVcReadyUI();
    if(vcTargetCtx === 'chat') setChatTypingState('idle');
    if(vcTargetCtx === 'dm') setDmTypingState('idle');
    qs('vcModal').classList.remove('open');
};
window.toggleVcRecord = function(){
    if(!vcStream || !qs('vcModal').classList.contains('open')) return;
    if(!vcMediaRecorder || vcMediaRecorder.state === 'inactive'){
        vcChunks = [];
        vcSecondsLeft = VC_MAX_SEC_OVERRIDE;
        setVcReadyUI();
        startVcRecording();
    } else {
        stopVcRecording();
    }
};
window.toggleVcCamera = async function(){
    if(!qs('vcModal').classList.contains('open')) return;
    vcFacingMode = vcFacingMode === 'user' ? 'environment' : 'user';
    if(vcMediaRecorder && vcMediaRecorder.state === 'recording'){
        vcSwitchPending = true;
        try { vcMediaRecorder.requestData(); } catch(e) {}
        stopVcTimer();
        try { vcMediaRecorder.stop(); } catch(e) { vcSwitchPending = false; }
        return;
    }
    try {
        stopVcTracks();
        await startVcStream();
        toast(vcFacingMode === 'user' ? '📷 Фронтальная камера' : '📷 Основная камера', 'green');
    } catch(e){ toast('❌ Нет доступа к камере: ' + e.message, 'red'); }
};
window.retakeVc = async function(){
    vcClosing = false;
    vcSwitchPending = false;
    vcChunks = [];
    vcSecondsLeft = VC_MAX_SEC_OVERRIDE;
    stopVcTimer();
    if(vcMediaRecorder && vcMediaRecorder.state !== 'inactive'){ try { vcMediaRecorder.stop(); } catch(e) {} }
    stopVcTracks();
    try {
        await startVcStream();
        setVcReadyUI();
        const badge = qs('vcTimerBadge'); if(badge) badge.textContent = `${VC_MAX_SEC_OVERRIDE}s`;
    } catch(e){ toast('❌ Нет доступа к камере: ' + e.message, 'red'); }
};
window.sendVcMsg = async function(){
    if(!vcChunks.length) return toast('⚠️ Нет записи', 'gold');
    const blob = new Blob(vcChunks, { type: 'video/webm' });
    // Close immediately; upload in background to avoid "stuck" preview
    closeVcModal();
    (async ()=>{
        try{
            const url = await uploadBlobToStorage(blob, 'media/video_circles');
            if(vcTargetCtx === 'chat') await sendChatMsg(null, url, 'video_circle', vcFacingMode);
            else if(vcTargetCtx === 'dm') await sendDmMsg(null, url, 'video_circle', vcFacingMode);
            else if(vcTargetCtx === 'news') await sendNewsDiscussionMsg(null, url, 'video_circle');
            else if(vcTargetCtx === 'wall') await pushWallPostMedia('video_circle', url);
            if(vcTargetCtx !== 'wall') toast('⭕ Видеосообщение отправлено', 'green');
        } catch(e){
            toast('❌ Не удалось отправить видеосообщение','red');
        }
    })();
};

renderChat = window.renderChat;
renderDmMessages = window.renderDmMessages;

// ─── SUBSCRIPTION FUNCTIONS ─────────────────
window.renderSubscription = async function(){
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const subscription = u.subscription || 'none';
    const subscriptionExpiry = u.subscriptionExpiry || '';
    const subscriptionStart = u.subscriptionStart || '';
    
    const statusEl = qs('currentSubscription');
    const expiryEl = qs('subscriptionExpiry');
    const manageEl = qs('subscriptionManage');
    const manageNoneEl = qs('subscriptionManageNone');
    const btnPlus = qs('btnBuyPlus');
    const btnUltra = qs('btnBuyUltra');
    const btnPrime = qs('btnBuyPrime');
    
    if(!statusEl) return;
    
    const now = new Date();
    const expiryDate = subscriptionExpiry ? new Date(subscriptionExpiry) : null;
    const isActive = expiryDate && expiryDate > now;
    
    if(subscription === 'none' || !isActive){
        statusEl.textContent = 'Бесплатный аккаунт';
        statusEl.style.color = 'var(--muted)';
        expiryEl.textContent = subscriptionExpiry && !isActive ? 'Подписка истекла' : '';
        if(manageEl) manageEl.style.display = 'none';
        if(manageNoneEl) manageNoneEl.style.display = 'block';
        if(btnPlus) {
            btnPlus.textContent = 'Оформить Plus';
            btnPlus.style.display = 'block';
        }
        if(btnUltra) { btnUltra.textContent = 'Оформить Ultra'; btnUltra.style.display = 'block'; }
        if(btnPrime) { btnPrime.textContent = 'Оформить Prime'; btnPrime.style.display = 'block'; }
    } else if(subscription === 'plus'){
        statusEl.textContent = '⭐ Kapani Plus';
        statusEl.style.color = 'var(--gold)';
        expiryEl.textContent = 'Действует до: ' + new Date(subscriptionExpiry).toLocaleDateString('ru');
        if(manageEl) manageEl.style.display = 'block';
        if(manageNoneEl) manageNoneEl.style.display = 'none';
        if(btnPlus) {
            btnPlus.textContent = 'Продлить Plus';
            btnPlus.style.display = 'block';
        }
        if(btnUltra) { btnUltra.textContent = 'Обновить до Ultra'; btnUltra.style.display = 'block'; }
        if(btnPrime) { btnPrime.textContent = 'Обновить до Prime'; btnPrime.style.display = 'block'; }
    } else if(subscription === 'ultra'){
        statusEl.textContent = '💎 Kapani Ultra';
        statusEl.style.color = 'var(--primary)';
        expiryEl.textContent = 'Действует до: ' + new Date(subscriptionExpiry).toLocaleDateString('ru');
        if(manageEl) manageEl.style.display = 'block';
        if(manageNoneEl) manageNoneEl.style.display = 'none';
        if(btnPlus) btnPlus.style.display = 'none';
        if(btnUltra) { btnUltra.textContent = 'Продлить Ultra'; btnUltra.style.display = 'block'; }
        if(btnPrime) { btnPrime.textContent = 'Обновить до Prime'; btnPrime.style.display = 'block'; }
    } else if(subscription === 'prime'){
        statusEl.innerHTML = '👑 <span class="text-rainbow-prime">Kapani Prime</span>';
        statusEl.style.color = '';
        expiryEl.textContent = 'Действует до: ' + new Date(subscriptionExpiry).toLocaleDateString('ru');
        if(manageEl) manageEl.style.display = 'block';
        if(manageNoneEl) manageNoneEl.style.display = 'none';
        if(btnPlus) btnPlus.style.display = 'none';
        if(btnUltra) btnUltra.style.display = 'none';
        if(btnPrime) btnPrime.textContent = 'Продлить Prime';
    }
    // Render upcoming tax/fee info
    const taxEl = qs('taxNextInfo');
    if(taxEl){
        const lastProcessed = u.economyLastProcessedAt ? Number(u.economyLastProcessedAt) : Date.now();
        const nextCharge = new Date(lastProcessed + 7 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.max(0, Math.ceil((nextCharge - Date.now()) / (1000 * 60 * 60 * 24)));
        const balance = Number(u.balance || 0);
        const savings = Number(u.savingsBalance || 0);
        const taxBase = Math.max(0,balance) + Math.max(0,savings);
        const wealthTax = taxBase > 0 ? Math.round(taxBase * getWealthTaxRate(taxBase)) : 0;
        const taxPct = Math.round(getWealthTaxRate(taxBase) * 100);
        const totalNext = ECONOMY_ACCOUNT_WEEKLY_FEE + wealthTax;
        taxEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-weight:800;">📅 Следующее списание</span><b style="color:var(--red);">−${totalNext} ₽</b></div><div style="font-size:11px;color:var(--muted);">Через <b style="color:var(--text);">${daysLeft} ${daysLeft===1?'день':(daysLeft>=2&&daysLeft<=4?'дня':'дней')}</b> · ${nextCharge.toLocaleDateString('ru',{day:'numeric',month:'long'})}<br>Налоговая база: <b>${taxBase.toLocaleString('ru-RU')} ₽</b> (основной ${Math.max(0,balance).toLocaleString('ru-RU')} ₽ + накопительный ${Math.max(0,savings).toLocaleString('ru-RU')} ₽)<br>Ставка: <b>${taxPct}%</b> · налог: <b>${wealthTax.toLocaleString('ru-RU')} ₽</b><br>Абонентская плата: <b>${ECONOMY_ACCOUNT_WEEKLY_FEE} ₽</b><br><span style="color:var(--primary);">Списание налога — только с основного баланса. Накопительный счёт не уменьшается.</span></div>`;
    }
};

window.buySubscription = async function(type){
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    const currentBal = u.balance || 0;
    
    const price = getSubscriptionPrice(type);
    const name = CONFIG.subscriptions[type].name;
    
    if(currentBal < price){
        return toast(`❌ Недостаточно средств. Нужно ${price}₽`, 'red');
    }
    
    // Check if user already has active subscription to extend it
    const now = new Date();
    const currentExpiry = u.subscriptionExpiry ? new Date(u.subscriptionExpiry) : null;
    const hasActiveSubscription = currentExpiry && currentExpiry > now;
    
    let expiry, startDate, actionText;
    
    if(hasActiveSubscription && u.subscription === type) {
        // Extend existing subscription
        expiry = new Date(currentExpiry.getTime() + 7 * 24 * 60 * 60 * 1000);
        startDate = u.subscriptionStart || now.toISOString();
        actionText = `Продлена подписка ${name}`;
    } else {
        // New subscription or upgrade
        expiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        startDate = now.toISOString();
        actionText = `Оформлена подписка ${name}`;
    }
    
    if(!confirm(`${actionText} за ${price}₽?`)) return;
    
    // Update user data
    await update(userRef(currentNick), {
        balance: currentBal - price,
        subscription: type,
        subscriptionExpiry: expiry.toISOString(),
        subscriptionStart: startDate
    });
    await window.addMunicipalTreasury?.(price, `Оплата подписки ${name} от ${currentNick}`, {sourceNick:currentNick,sourceType:'subscription'});
    
    // Log transaction
    await logTx(currentNick, {
        type: 'out',
        who: 'Подписка',
        amt: price,
        desc: actionText
    });
    
    // Send notification
    await pushNotification(currentNick, `⭐ ${actionText}!`, 'system');
    
    toast(`⭐ ${actionText}!`, 'green');
    renderSubscription();
    updateHeader_balance({...u, balance: currentBal - price});
    
    // Update marketplace interface to show new limits immediately
    if(typeof renderMarketplace === 'function') {
        renderMarketplace();
    }
};

window.cancelSubscription = async function(){
    if(!confirm('Отменить подписку? Она останется активной до конца оплаченного периода.')) return;
    
    const snap = await get(userRef(currentNick));
    const u = snap.val() || {};
    
    await update(userRef(currentNick), {
        subscription: 'none',
        subscriptionExpiry: ''
    });
    
    await pushNotification(currentNick, '🔔 Подписка отменена', 'system');
    toast('Подписка отменена', 'gold');
    renderSubscription();
};

// ─── GIFT SUBSCRIPTION FUNCTIONS ────────────
let giftSubscriptionType = '';

window.openGiftSubscriptionModal = async function(type){
    giftSubscriptionType = type;
    const price = getSubscriptionPrice(type);
    const name = CONFIG.subscriptions[type].name;
    
    // Get all users for selection
    const usersSnap = await get(ref(db, 'users'));
    const users = usersSnap.val() || {};
    
    // Build user options, excluding current user
    let userOptions = '<option value="">Выберите получателя...</option>';
    Object.values(users).forEach(u => {
        if(u.nick && u.nick !== currentNick) {
            const displayName = u.displayName || u.nick;
            userOptions += `<option value="${escHtml(u.nick)}">${escHtml(displayName)}</option>`;
        }
    });
    
    const modalHtml = `
        <div id="giftSubModal" style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-end;justify-content:center;" onclick="if(event.target===this)closeGiftSubscriptionModal()">
            <div style="background:#170b10;border-radius:24px 24px 0 0;width:100%;max-width:490px;max-height:80vh;overflow-y:auto;padding:24px 18px 44px;animation:sheetUp .3s ease-out;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                    <div style="font-weight:900;font-size:18px;">🎁 Подарить подписку</div>
                    <span style="cursor:pointer;font-size:20px;" onclick="closeGiftSubscriptionModal()">✕</span>
                </div>
                
                <div style="background: ${type==='plus' ? 'rgba(255,128,106,.08)' : type==='ultra' ? 'rgba(240,68,74,.08)' : 'rgba(240,196,25,.08)'};border:2px solid ${type==='plus'?'var(--gold)':type==='ultra'?'var(--primary)':'#f0c419'};border-radius:16px;padding:16px;margin-bottom:20px;">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                        <div style="font-size:28px;">${type==='plus'?'⭐':type==='ultra'?'💎':'👑'}</div>
                        <div>
                            <div style="font-weight:900;font-size:16px;color:${type==='plus'?'var(--gold)':type==='ultra'?'var(--primary)':'#f0c419'};">${name}</div>
                            <div style="font-size:13px;color:var(--muted);">${price} ₽ / неделя</div>
                        </div>
                    </div>
                    <div style="font-size:12px;color:var(--muted);">Получатель получит все привилегии ${name} на 7 дней</div>
                </div>
                
                <div style="margin-bottom:20px;">
                    <div style="font-weight:800;font-size:14px;margin-bottom:10px;">👤 Кому подарить</div>
                    <select id="giftRecipient" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);">
                        ${userOptions}
                    </select>
                </div>
                
                <div style="background:var(--surface2);border-radius:12px;padding:12px;margin-bottom:20px;">
                    <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">Стоимость подарка</div>
                    <div style="font-weight:900;font-size:20px;color:var(--text);">${price} ₽</div>
                    <div style="font-size:11px;color:var(--muted);margin-top:4px;">Списание с вашего баланса</div>
                </div>
                
                <div style="display:flex;gap:10px;">
                    <button class="btn btn-ghost" style="flex:1;" onclick="closeGiftSubscriptionModal()">Отмена</button>
                    <button class="btn btn-primary" style="flex:1;" onclick="sendGiftSubscription()">🎁 Подарить</button>
                </div>
            </div>
        </div>
    `;
    
    const modal = document.createElement('div');
    modal.innerHTML = modalHtml;
    document.body.appendChild(modal.firstElementChild);
};

window.closeGiftSubscriptionModal = function(){
    const modal = qs('giftSubModal');
    if(modal) modal.remove();
    giftSubscriptionType = '';
};

window.sendGiftSubscription = async function(){
    const recipient = qs('giftRecipient')?.value;
    if(!recipient) return toast('⚠️ Выберите получателя', 'gold');
    if(!giftSubscriptionType) return;

    const plan = globalThis.KAPANI_SUBSCRIPTIONS?.[giftSubscriptionType];
    const price = Number(plan?.price || getSubscriptionPrice(giftSubscriptionType));
    const name = plan?.name || CONFIG.subscriptions[giftSubscriptionType]?.name || giftSubscriptionType;

    if(!confirm(`Подарить ${name} пользователю ${recipient} за ${price}₽?`)) return;

    try{
        // Gift is handled by the same Cloudflare Worker that already powers
        // Kapani Push. This keeps the feature available on Firebase Spark and
        // removes the broken Cloud Functions/session dependency entirely.
        const ph = await getPushAuthHash();
        if(!ph) throw new Error('Не найден хэш пароля текущего аккаунта');
        const data = await pushWorkerCall('/gift', {
            nick: String(currentNick || '').trim(),
            ph,
            recipientNick: recipient,
            subscriptionType: giftSubscriptionType
        });
        if(!data.success) throw new Error(data.message || 'Подарок не выполнен');

        toast(`🎁 ${name} подарен ${recipient}!`, 'green');
        closeGiftSubscriptionModal();

        // Server is the source of truth. Refresh local state from RTDB.
        const fresh=await get(userRef(currentNick));
        if(fresh.exists()){
            allUsersCache[currentNick]=fresh.val();
            window.allUsersCache=allUsersCache;
            updateHeader(fresh.val());
            updateHeader_balance(fresh.val());
        }
        try{ if(typeof renderSubscription==='function') renderSubscription(); }catch(e){}
    }catch(e){
        console.error('[giftSubscription]',e);
        const code=e?.code || '';
        const message=String(e?.message || '');
        if(code==='failed-precondition' || message.includes('более высокого') || message.includes('уровень подписки')){
            toast('❌ Нельзя подарить эту подписку. У пользователя уже есть подписка более высокого уровня.','red');
        }else if(code==='permission-denied' || code==='unauthenticated' || message.includes('повторный вход') || message.includes('защищённая сессия')){
            toast('🔐 Восстанавливаю защищённую сессию… повторите подарок через секунду, без повторного входа.','gold');
        }else{
            toast('❌ '+(message || 'Не удалось подарить подписку'),'red');
        }
    }
};

// ═══════════════════════════════════════════════════════
// 🏛 ДЕПУТАТСКИЕ ПРЕДЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════
const deputyProposalsRef = () => ref(db, 'deputyProposals');
const deputyProposalRef = (id) => ref(db, `deputyProposals/${id}`);

window.submitDeputyProposal = async function() {
    const snap = await get(userRef(currentNick));
    if (!snap.exists()) return;
    const u = snap.val();
    if (u.job !== 'Депутат' && currentNick !== ADMIN) {
        return toast('🚫 Отправлять предложения могут только Депутаты', 'red');
    }
    const type = qs('deputyProposalType').value;
    const title = (qs('deputyProposalTitle').value || '').trim();
    const text = (qs('deputyProposalText').value || '').trim();
    if (!title) return toast('⚠️ Введите заголовок', 'gold');
    if (!text) return toast('⚠️ Введите текст предложения', 'gold');
    const id = genId();
    const typeLabels = { proposal: '💡 Предложение', request: '📩 Запрос', complaint: '⚠️ Жалоба', initiative: '🚀 Инициатива' };
    await set(deputyProposalRef(id), {
        id, type, typeLabel: typeLabels[type] || type, title, text,
        author: currentNick, date: new Date().toLocaleDateString('ru'),
        time: nowTime(), createdAt: Date.now(), status: 'pending'
    });
    await pushNotification(ADMIN, `🏛 Депутат ${currentNick}: ${typeLabels[type] || type} — «${title}»`, 'system');
    qs('deputyProposalTitle').value = '';
    qs('deputyProposalText').value = '';
    toast('✅ Предложение отправлено в мэрию', 'green');
    renderDeputyProposals();
};

async function renderDeputyProposals() {
    const el = qs('myDeputyProposals');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Загрузка...</div>';
    try {
        const snap = await get(deputyProposalsRef());
        const all = snap.val() || {};
        const mine = Object.values(all).filter(p => p.author === currentNick).sort((a,b) => (b.createdAt||0)-(a.createdAt||0));
        if (!mine.length) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px 0;">Нет предложений</div>'; return; }
        const statusColors = { pending: 'gold', approved: 'primary', rejected: 'red' };
        const statusLabels = { pending: '⏳ На рассмотрении', approved: '✅ Одобрено', rejected: '❌ Отклонено' };
        el.innerHTML = mine.map(p => {
            const sc = statusColors[p.status] || 'gold';
            const sl = statusLabels[p.status] || '⏳ На рассмотрении';
            return `<div class="work-order" style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
                    <div><div style="font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase;">${escHtml(p.typeLabel||p.type)}</div>
                    <div style="font-weight:900;font-size:15px;margin-top:2px;">${escHtml(p.title)}</div></div>
                    <span style="font-size:10px;font-weight:900;color:var(--${sc});white-space:nowrap;padding:4px 8px;border-radius:8px;background:var(--${sc}-dim);">${sl}</span>
                </div>
                <div style="font-size:12px;color:var(--muted);">${escHtml(p.text)}</div>
                ${p.adminComment ? `<div style="margin-top:8px;font-size:12px;color:var(--text);background:var(--surface2);padding:8px 10px;border-radius:8px;border-left:3px solid var(--primary);"><b>Ответ мэрии:</b> ${escHtml(p.adminComment)}</div>` : ''}
                <div style="font-size:10px;color:var(--muted);margin-top:6px;">${escHtml(p.date||'')} ${escHtml(p.time||'')}</div>
            </div>`;
        }).join('');
    } catch(e) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Ошибка загрузки</div>'; }
}

// ═══════════════════════════════════════════════════════
// 🛡 КСБ — ВЫПИСЫВАНИЕ ШТРАФОВ
// ═══════════════════════════════════════════════════════
// Старая prompt-версия удалена — штраф выписывается формой на dutyPage
// (см. submitDutyFine и window.ksbFineWorker = navTo('dutyPage') ниже).
window.ksbFineWorker = function(){ if(typeof navTo==='function') navTo('dutyPage'); };


async function purchaseMarketplaceListingForDelivery(listingId){
    const lRef=listingRef(listingId);
    const lSnap=await get(lRef); if(!lSnap.exists()) return toast('❌ Объявление не найдено','red')&&false;
    const l=lSnap.val()||{};
    if(l.status==='sold' && l.buyer===currentNick && l.deliveryPurchase===true) return true;
    if(l.status!=='active' || l.seller===currentNick || l.category==='work' || l.category==='service') return toast('❌ Объявление уже куплено или недоступно','red')&&false;
    const price=Math.max(0,Number(l.price||0));
    const buyerSnap=await get(userRef(currentNick)); const sellerSnap=await get(userRef(l.seller));
    if(!buyerSnap.exists()||!sellerSnap.exists()) return toast('❌ Пользователь не найден','red')&&false;
    const reserveId=genId();
    const result=await runTransaction(lRef,cur=>{
        if(!cur || cur.status!=='active') return;
        return {...cur,status:'sold',buyer:currentNick,purchasedAt:Date.now(),deliveryPurchase:true,deliveryPurchaseId:reserveId};
    });
    if(!result?.committed) return toast('❌ Объявление уже купил другой пользователь','red')&&false;

    const payRes=await runTransaction(userRef(currentNick),cur=>{
        const bal=Number(cur?.balance||0);
        if(bal<price) return;
        return {...cur,balance:bal-price};
    });
    if(!payRes?.committed){
        await runTransaction(lRef,cur=>{
            if(cur?.status==='sold'&&cur?.buyer===currentNick&&cur?.deliveryPurchaseId===reserveId){
                const restored={...cur,status:'active'}; delete restored.buyer; delete restored.purchasedAt; delete restored.deliveryPurchase; delete restored.deliveryPurchaseId; return restored;
            }
        });
        return toast(`❌ Недостаточно средств. Нужно ${price.toLocaleString()} ₽`,'red')&&false;
    }

    const sellerPay=await runTransaction(userRef(l.seller),cur=>({...cur,balance:Number(cur?.balance||0)+price}));
    if(!sellerPay?.committed){
        // Keep the listing sold rather than allowing a second buyer; a later reconciliation can
        // finish the seller credit from deliveryPurchaseId.
        console.warn('[market delivery] seller credit not committed',listingId,l.seller);
    }

    await Promise.all([
        logTx(currentNick,{type:'out',who:l.seller,amt:price,desc:`Куплено объявление «${l.title}»`}),
        sellerPay?.committed ? logTx(l.seller,{type:'in',who:currentNick,amt:price,desc:`Продано объявление «${l.title}»`}) : Promise.resolve(),
        pushNotification(l.seller,`💰 ${currentNick} купил «${l.title}» за ${price} ₽`,'market'),
        pushNotification(currentNick,`✅ «${l.title}» куплено. Теперь оформите доставку.`,'market')
    ]);
    return true;
}

// ═══════════════════════════════════════════════════════
// 🚚 ДОСТАВКА ИЗ БИЗНЕСА / МАРКЕТПЛЕЙСА
// ═══════════════════════════════════════════════════════
const deliveryCustomOrdersRef = () => ref(db, 'deliveryCustomOrders');
const deliveryCustomOrderRef = (id) => ref(db, `deliveryCustomOrders/${id}`);

function deliveryBusinessOptions() {
    return Object.values(allBusinessesCache || {})
        .filter(b => b && b.status === 'active' && b.products && Object.keys(b.products).length)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
}

function deliveryMarketplaceOptions() {
    return Object.values(lastMarketListings || {})
        .filter(l => l && !l.archived && l.status !== 'sold' && l.category !== 'work' && l.category !== 'service')
        .sort((a, b) => (b.pinnedUntil || 0) - (a.pinnedUntil || 0) || (b.createdAt || 0) - (a.createdAt || 0));
}

function fillSelectOptions(sel, optionsHtml, placeholder) {
    if (!sel) return;
    sel.innerHTML = optionsHtml || `<option value="">${placeholder || 'Нет вариантов'}</option>`;
}

window.updateDeliverySourceHint = function() {
    const sel = qs('deliveryOrderSource');
    const hint = qs('deliverySourceHint');
    const businessBlock = qs('deliveryBusinessBlock');
    const marketBlock = qs('deliveryMarketplaceBlock');
    if (!sel || !hint) return;

    if (sel.value === 'business') {
        hint.textContent = '🏪 Сначала выберите бизнес, затем конкретный товар из его каталога.';
        hint.style.display = 'block';
        if (businessBlock) businessBlock.style.display = 'grid';
        if (marketBlock) marketBlock.style.display = 'none';
    } else {
        hint.textContent = '🛍 Выберите конкретное объявление с маркетплейса.';
        hint.style.display = 'block';
        if (businessBlock) businessBlock.style.display = 'none';
        if (marketBlock) marketBlock.style.display = 'grid';
    }
    updateDeliverySummary();
};

window.updateDeliveryBizProducts = function() {
    const bizSel = qs('deliveryOrderBiz');
    const prodSel = qs('deliveryOrderBizProduct');
    if (!bizSel || !prodSel) return;
    const bizId = bizSel.value;
    const b = (allBusinessesCache || {})[bizId];
    if (!b || !b.products) {
        prodSel.innerHTML = '<option value="">Нет товаров</option>';
        updateDeliverySummary();
        return;
    }
    const products = Object.entries(b.products || {})
        .sort((a, b) => String(a[1]?.name || '').localeCompare(String(b[1]?.name || ''), 'ru'));
    prodSel.innerHTML = products.length
        ? products.map(([pid, p]) => `<option value="${escHtml(pid)}">${escHtml(p.name || 'Товар')} — ${(p.price || 0).toLocaleString()} ₽</option>`).join('')
        : '<option value="">Нет товаров</option>';
    updateDeliverySummary();
};

let deliveryBusinessMapObj=null, deliveryBusinessMapBusinessMarker=null, deliveryBusinessMapClientMarker=null, deliveryBusinessMapLine=null;
async function renderBusinessDeliveryMap(){
    const card=qs('deliveryBusinessMapCard'), host=qs('deliveryBusinessMap');
    if(!card||!host) return;
    const source=qs('deliveryOrderSource')?.value||'business';
    if(source!=='business'){ card.style.display='none'; if(deliveryBusinessMapObj){try{deliveryBusinessMapObj.remove()}catch(e){} deliveryBusinessMapObj=null;} return; }
    const bizId=qs('deliveryOrderBiz')?.value||'', b=(allBusinessesCache||{})[bizId];
    const dLat=Number(qs('deliveryOrderLat')?.value), dLng=Number(qs('deliveryOrderLng')?.value);
    const bLat=Number(b?.lat), bLng=Number(b?.lng);
    if(!b||!Number.isFinite(bLat)||!Number.isFinite(bLng)||!Number.isFinite(dLat)||!Number.isFinite(dLng)){ card.style.display='none'; if(deliveryBusinessMapObj){try{deliveryBusinessMapObj.remove()}catch(e){} deliveryBusinessMapObj=null;} return; }
    card.style.display='block';
    await window.kapaniLoadLeaflet();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(deliveryBusinessMapObj){try{deliveryBusinessMapObj.remove()}catch(e){}}
    deliveryBusinessMapObj=L.map(host,{center:[bLat,bLng],zoom:14});
    addSatelliteLayer(deliveryBusinessMapObj);
    deliveryBusinessMapBusinessMarker=L.marker([bLat,bLng]).addTo(deliveryBusinessMapObj).bindPopup(`<b>🏪 ${escHtml(b.name||'Бизнес')}</b><br>📍 Бизнес`);
    deliveryBusinessMapClientMarker=L.marker([dLat,dLng]).addTo(deliveryBusinessMapObj).bindPopup('<b>📍 Точка доставки</b>');
    deliveryBusinessMapLine=L.polyline([[bLat,bLng],[dLat,dLng]],{weight:4,dashArray:'8 8'}).addTo(deliveryBusinessMapObj);
    deliveryBusinessMapObj.fitBounds([[bLat,bLng],[dLat,dLng]],{padding:[35,35],maxZoom:16});
    const km=haversineKm(bLat,bLng,dLat,dLng), price=deliveryDistancePrice(km), info=qs('deliveryBusinessMapInfo');
    if(info) info.innerHTML=`🏪 <b>${escHtml(b.name||'Бизнес')}</b> → 📍 доставка · 📏 Расстояние: <b style="color:var(--primary)">${km.toFixed(2)} км</b> · 🚚 Цена доставки: <b style="color:var(--gold)">${price.toLocaleString()} ₽</b>`;
}

window.updateDeliverySummary = function() {
    renderBusinessDeliveryMap().catch(e=>console.warn('[delivery business map]',e));
    const summary = qs('deliverySelectionSummary');
    if (!summary) return;
    const source = qs('deliveryOrderSource')?.value || 'business';
    if (source === 'business') {
        const bizSel = qs('deliveryOrderBiz');
        const prodSel = qs('deliveryOrderBizProduct');
        const b = (allBusinessesCache || {})[bizSel?.value || ''];
        const p = b?.products?.[prodSel?.value || ''];
        if (b && p) {
            summary.style.display = 'block';
            summary.innerHTML = `Выбрано: <b>${escHtml(b.name || 'Бизнес')}</b> → <b>${escHtml(p.name || 'Товар')}</b>${p.price ? ` · ${Number(p.price).toLocaleString()} ₽` : ''}`;
            return;
        }
    } else {
        const item = deliveryMarketplaceOptions().find(x => x.id === (qs('deliveryOrderMarketItem')?.value || ''));
        if (item) {
            const seller = allUsersCache?.[item.seller]?.displayName || item.seller || 'Продавец';
            summary.style.display = 'block';
            summary.innerHTML = `Выбрано: <b>${escHtml(item.title || 'Объявление')}</b> от <b>${escHtml(seller)}</b>${item.price ? ` · ${Number(item.price).toLocaleString()} ₽` : ''}`;
            return;
        }
    }
    summary.style.display = 'none';
    summary.innerHTML = '';
};

window.renderDeliveryOrderOptions = async function(forceFetch = false) {
    const sourceSel = qs('deliveryOrderSource');
    const bizSel = qs('deliveryOrderBiz');
    const prodSel = qs('deliveryOrderBizProduct');
    const marketSel = qs('deliveryOrderMarketItem');
    if (!sourceSel || !bizSel || !prodSel || !marketSel) return;

    if (forceFetch || !Object.keys(allBusinessesCache || {}).length) {
        try {
            const snap = await get(bizRef());
            const raw = snap.val() || {};
            if (raw && Object.keys(raw).length) allBusinessesCache = raw;
        } catch(e) {}
    }
    if (forceFetch || !Object.keys(lastMarketListings || {}).length) {
        try {
            const snap = await get(marketRef());
            const raw = snap.val() || {};
            if (raw && Object.keys(raw).length) lastMarketListings = raw;
        } catch(e) {}
    }

    const businesses = deliveryBusinessOptions();
    const businessOptions = businesses.length
        ? ['<option value="">Выберите бизнес…</option>', ...businesses.map(b => `<option value="${escHtml(b.id)}">${escHtml(b.name || 'Бизнес')} (${Object.keys(b.products || {}).length})</option>`)].join('')
        : '<option value="">Нет подходящих бизнесов</option>';
    fillSelectOptions(bizSel, businessOptions, 'Нет подходящих бизнесов');

    const marketItems = deliveryMarketplaceOptions();
    const marketOptions = marketItems.length
        ? ['<option value="">Выберите объявление…</option>', ...marketItems.map(l => {
            const seller = allUsersCache?.[l.seller]?.displayName || l.seller || 'Продавец';
            return `<option value="${escHtml(l.id)}">${escHtml(l.title || 'Объявление')} — ${escHtml(seller)}</option>`;
        })].join('')
        : '<option value="">Нет подходящих объявлений</option>';
    fillSelectOptions(marketSel, marketOptions, 'Нет подходящих объявлений');

    if (!bizSel.value && businesses.length) bizSel.value = businesses[0].id;
    if (!marketSel.value && marketItems.length) marketSel.value = marketItems[0].id;

    updateDeliveryBizProducts();
    updateDeliverySourceHint();
    updateDeliverySummary();
};

let _placeDeliveryOrderBusy = false;

function haversineKm(lat1,lng1,lat2,lng2){
    const R=6371, dLat=(Number(lat2)-Number(lat1))*Math.PI/180, dLng=(Number(lng2)-Number(lng1))*Math.PI/180;
    const a=Math.sin(dLat/2)**2+Math.cos(Number(lat1)*Math.PI/180)*Math.cos(Number(lat2)*Math.PI/180)*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function deliveryDistancePrice(distanceKm){ return Math.max(0, Math.round(Number(distanceKm||0)*200)); }

window.placeDeliveryOrder = async function() {
    if (_placeDeliveryOrderBusy) return toast('⏳ Заказ уже размещается…','gold');
    _placeDeliveryOrderBusy = true;
    const placeBtn = document.querySelector('button[onclick*="placeDeliveryOrder"]');
    if(placeBtn){ placeBtn.disabled = true; placeBtn.textContent = '⏳ Размещение…'; }
    try {
        if (!await requireSpendable()) return;
        const source = qs('deliveryOrderSource')?.value || 'business';
        const addr = (qs('deliveryOrderAddr')?.value || '').trim();
        const deliveryLat = Number(qs('deliveryOrderLat')?.value), deliveryLng = Number(qs('deliveryOrderLng')?.value);
        const contact = (qs('deliveryOrderContact')?.value || '').trim();
        const notes = (qs('deliveryOrderNotes')?.value || '').trim();
        const sourceLabels = { business: '🏪 Бизнес', marketplace: '🛍 Маркетплейс' };
        if(!Number.isFinite(deliveryLat)||!Number.isFinite(deliveryLng)) return toast('🗺 Выберите точку доставки на карте','gold');

        let from='', items='', summaryText='', payload={source,sourceLabel:sourceLabels[source]||source};
        if(source==='business'){
            const bizId=qs('deliveryOrderBiz')?.value||'', productId=qs('deliveryOrderBizProduct')?.value||'';
            const b=(allBusinessesCache||{})[bizId], p=b?.products?.[productId];
            if(!bizId||!b) return toast('⚠️ Выберите бизнес','gold');
            if(!productId||!p) return toast('⚠️ Выберите товар бизнеса','gold');
            const blat=Number(b.lat), blng=Number(b.lng);
            if(!Number.isFinite(blat)||!Number.isFinite(blng)) return toast('❌ У бизнеса не задана точка на карте','red');
            const distanceKm=haversineKm(blat,blng,deliveryLat,deliveryLng), deliveryPrice=deliveryDistancePrice(distanceKm);
            from=b.name||'Бизнес'; items=p.name||'Товар'; summaryText=`🏪 ${from} → ${items}`;
            payload={...payload,bizId,businessName:b.name||'',businessLat:blat,businessLng:blng,productId,productName:p.name||'',productPrice:Number(p.price||0),itemKind:'business_product',distanceKm,deliveryPrice,deliveryPriceRule:'200_per_km'};
        } else {
            const listingId=qs('deliveryOrderMarketItem')?.value||'', l=(lastMarketListings||{})[listingId];
            if(!listingId||!l) return toast('⚠️ Выберите объявление с маркетплейса','gold');
            // Purchase the one-of-one listing before creating a delivery request.
            const bought=await purchaseMarketplaceListingForDelivery(listingId);
            if(!bought) return;
            const sellerSnap=await get(userRef(l.seller)), seller=sellerSnap.val()||{};
            from=l.seller||'Продавец'; items=l.title||'Объявление'; summaryText=`🛍 ${items} → ${from}`;
            const sellerLat=Number(l.sellerLat ?? seller.lat), sellerLng=Number(l.sellerLng ?? seller.lng);
            if(!Number.isFinite(sellerLat)||!Number.isFinite(sellerLng)) return toast('❌ У продавца не указано местоположение — доставка невозможна','red');
            const distanceKm=haversineKm(sellerLat,sellerLng,deliveryLat,deliveryLng), deliveryPrice=deliveryDistancePrice(distanceKm);
            payload={...payload,listingId,listingTitle:l.title||'',listingPrice:Number(l.price||0),sellerNick:l.seller||'',sellerLat,sellerLng,itemKind:'marketplace_listing',distanceKm,deliveryPrice,deliveryPriceRule:'200_per_km',priceMode:'fixed_200_per_km'};
        }

        const id=genId();
        const order={
            id,...payload,from,items,notes,address:addr||`${deliveryLat.toFixed(6)}, ${deliveryLng.toFixed(6)}`,
            deliveryLat,deliveryLng,contact,client:currentNick,status:'waiting',
            priceOffer:Number(payload.deliveryPrice||0),clientConfirmed:false,workerConfirmed:false,clientReceived:false,
            escrowAmount:0,payoutDone:false,date:new Date().toLocaleDateString('ru'),time:nowTime(),createdAt:Date.now()
        };
        await set(deliveryCustomOrderRef(id),order);

        const notifyText=source==='business'
            ? `🚚 Новый заказ доставки от ${currentNick}: бизнес «${from}», товар «${items}», ${Number(payload.deliveryPrice||0).toLocaleString()} ₽`
            : `🚚 Новый заказ доставки от ${currentNick}: маркетплейс «${items}», цена доставки предложением`;
        await pushNotification(ADMIN,notifyText,'delivery_orders');

        const usersSnap=await get(ref(db,'users')), allUsers=usersSnap.val()||{};
        await Promise.all(Object.entries(allUsers).filter(([,u])=>u?.job==='Доставщик').map(([nick])=>
            pushNotification(nick,source==='business'
                ? `📦 Новый заказ: ${from} → ${items}, доставка ${Number(payload.deliveryPrice||0).toLocaleString()} ₽`
                : `📦 Новый заказ: маркетплейс «${items}» — предложите цену доставки`,'delivery_orders')
        ));

        ['deliveryOrderNotes','deliveryOrderAddr','deliveryOrderContact'].forEach(id2=>{if(qs(id2))qs(id2).value='';});
        if(qs('deliveryOrderLat')) qs('deliveryOrderLat').value='';
        if(qs('deliveryOrderLng')) qs('deliveryOrderLng').value='';
        if(qs('deliveryLocationPreview')) qs('deliveryLocationPreview').textContent='📍 Точка не выбрана';
        toast(`✅ Заказ на доставку размещён! ${summaryText}`,'green');
        renderMyDeliveryOrders();
    } catch(e) {
        console.error('[placeDeliveryOrder]',e);
        toast('❌ Не удалось разместить заказ: '+(e?.message||'ошибка'),'red');
    } finally {
        _placeDeliveryOrderBusy=false;
        if(placeBtn&&placeBtn.isConnected){placeBtn.disabled=false;placeBtn.textContent='📤 Разместить заказ на доставку';}
    }
};

async function renderMyDeliveryOrders(){
    const el=qs('myDeliveryOrders'); if(!el)return;
    el.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px 0;">Загрузка...</div>';
    try{
        const all=(await get(deliveryCustomOrdersRef())).val()||{};
        const mine=Object.values(all).filter(o=>o.client===currentNick).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        if(!mine.length){el.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px 0;">Нет заказов</div>';return;}
        const labels={waiting:'⏳ Ожидает',price_proposed:'💰 Цена предложена',client_confirmed:'✅ Подтверждено',in_progress:'🛵 В доставке',delivered:'📦 Доставлено — ждём подтверждения',done:'✅ Оплачено',cancelled:'❌ Отменён'};
        el.innerHTML=mine.map(o=>{
            const line=o.productName?`${o.from} · ${o.productName}`:o.listingTitle||o.items;
            const extra=o.priceOffer!=null?`<div style="font-size:12px;color:var(--gold);font-weight:900;">🚚 Доставка: ${Number(o.priceOffer).toLocaleString()} ₽</div>`:(o.deliveryPrice!=null?`<div style="font-size:12px;color:var(--gold);font-weight:900;">🚚 Доставка: ${Number(o.deliveryPrice).toLocaleString()} ₽ · ${Number(o.distanceKm||0).toFixed(2)} км</div>`:'');
            let actions='';
            if(o.status==='price_proposed'&&o.client===currentNick) actions=`<div style="display:flex;gap:6px;"><button class="btn btn-primary btn-sm" onclick="confirmCustomDeliveryPrice('${o.id}',true)">✅ Подтвердить</button><button class="btn btn-red btn-sm" onclick="confirmCustomDeliveryPrice('${o.id}',false)">❌ Отказаться</button></div>`;
            if(o.status==='delivered'&&!o.clientReceived) actions=`<button class="btn btn-primary btn-sm" onclick="confirmCustomDeliveryReceived('${o.id}')">✅ Получил</button>`;
            return `<div class="work-order" style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;"><b>${escHtml(line||o.from)}</b><span class="status-badge badge-wait">${labels[o.status]||o.status}</span></div><div style="font-size:12px;color:var(--muted);">📍 ${escHtml(o.address)}</div>${extra}${o.worker?`<div style="font-size:12px;color:var(--primary);">🛵 ${escHtml(o.worker)}</div>`:''}${o.notes?`<div style="font-size:12px;color:var(--muted);">📝 ${escHtml(o.notes)}</div>`:''}<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${actions}${['waiting','client_confirmed','price_proposed'].includes(o.status)?`<button class="btn btn-red btn-sm" onclick="cancelCustomDelivery('${o.id}')">❌ Отменить</button>`:''}</div></div>`;
        }).join('');
    }catch(e){el.innerHTML='<div style="color:var(--muted);font-size:13px;">Ошибка загрузки</div>';}
}

window.clearMyDeliveryHistory = async function(){
    if(!currentNick) return toast('❌ Сначала войдите в аккаунт','red');
    if(!confirm('Очистить историю ваших доставок? Активные и ожидающие заказы останутся, чтобы не сломать текущую доставку.')) return;
    try{
        const snap = await get(deliveryCustomOrdersRef());
        const all = snap.val() || {};
        const terminal = new Set(['done','cancelled']);
        const removals = Object.entries(all).filter(([id,o])=>
            o && o.client === currentNick && terminal.has(String(o.status||''))
        ).map(([id])=>remove(deliveryCustomOrderRef(id)));
        await Promise.all(removals);
        toast(removals.length ? `✅ Удалено записей: ${removals.length}` : 'ℹ️ Готовых записей для очистки нет','green');
        await renderMyDeliveryOrders();
    }catch(e){
        console.error('[clearMyDeliveryHistory]',e);
        toast('❌ Не удалось очистить историю: '+(e?.message||'ошибка'),'red');
    }
};

window.cancelCustomDelivery=async function(orderId){
    if(!currentNick)return toast('❌ Сначала войдите в аккаунт','red');
    if(!confirm('Отменить заказ?'))return;
    try{
        const orderRef=deliveryCustomOrderRef(orderId);
        const snap=await get(orderRef);
        const current=snap.val()||null;
        if(!current)return toast('❌ Заказ не найден','red');
        const status=String(current.status||'').trim().toLowerCase();
        if(String(current.client||'')!==String(currentNick||''))return toast('❌ Это не ваш заказ','red');
        if(status==='cancelled')return toast('ℹ️ Заказ уже отменён','gold');
        if(!['waiting','price_proposed','client_confirmed'].includes(status)){
            return toast(`❌ Нельзя отменить заказ в статусе «${status||'неизвестно'}»`,'red');
        }

        // Do not use runTransaction() on the whole order here: client-side RTDB
        // transactions require read + write permissions at that location.
        // The cancellation state is guarded by a fresh read immediately before
        // a single-path update, then verified after the write.
        await update(orderRef,{
            status:'cancelled',
            cancelledAt:Date.now(),
            cancelledBy:currentNick,
            priceOffer:null,
            escrowAmount:0,
            clientConfirmed:false,
            worker:null,
            updatedAt:Date.now()
        });

        const verify=await get(orderRef);
        const after=verify.val()||null;
        if(String(after?.status||'').trim().toLowerCase()!=='cancelled'){
            return toast('❌ Не удалось отменить заказ. Сервер не подтвердил отмену.','red');
        }
        toast('✅ Заказ отменён','gold');
        renderMyDeliveryOrders();
        renderDeliveryCustomOrders();
    }catch(e){
        console.error('[cancelCustomDelivery]',e);
        toast('❌ Не удалось отменить заказ: '+(e?.message||'ошибка'),'red');
    }
};

async function renderDeliveryCustomOrders(){
    const uSnap=await get(userRef(currentNick)); if(!uSnap.exists())return;
    const u=uSnap.val(); if(u.job!=='Доставщик'&&currentNick!==ADMIN)return;
    const all=(await get(deliveryCustomOrdersRef())).val()||{};
    const waiting=Object.values(all).filter(o=>o.status==='waiting');
    const proposed=Object.values(all).filter(o=>o.status==='price_proposed'&&o.client!==currentNick);
    const myActive=Object.values(all).filter(o=>o.worker===currentNick&&['client_confirmed','in_progress','delivered'].includes(o.status));
    const delivList=qs('deliveryList'); if(!delivList)return;
    const pool=[...waiting,...proposed,...myActive.filter(o=>!waiting.includes(o)&&!proposed.includes(o))];
    if(!pool.length)return;
    let html=`<div style="font-size:12px;font-weight:900;color:var(--primary);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;">📦 Заказы из бизнесов / маркетплейса</div>`;
    pool.forEach(o=>{
        const isMine=o.worker===currentNick;
        let priceControl='';
        if(!isMine&&o.status==='waiting'&&['business','marketplace'].includes(o.source)) priceControl=`<div style="margin-top:7px;"><div style="font-size:12px;color:var(--gold);font-weight:900;margin-bottom:5px;">🚚 Цена доставки: ${Number(o.deliveryPrice||deliveryDistancePrice(Number(o.distanceKm||0))||0).toLocaleString()} ₽</div><button class="btn btn-primary btn-sm" onclick="takeCustomDelivery('${o.id}')">🛵 Взять заказ</button></div>`;
        if(!isMine&&o.status==='waiting'&&o.source==='business') priceControl=`<button class="btn btn-primary btn-sm" onclick="takeCustomDelivery('${o.id}')">✅ Взять заказ (${Number(o.deliveryPrice||0).toLocaleString()} ₽)</button>`;
        const mineActions=isMine?`<div style="display:flex;gap:6px;flex-wrap:wrap;">${o.status==='client_confirmed'?`<button class="btn btn-primary btn-sm" onclick="startCustomDelivery('${o.id}')">🛵 Начать доставку</button>`:''}${o.status==='in_progress'?`<button class="btn btn-gold btn-sm" onclick="completeCustomDelivery('${o.id}')">✅ Доставлено</button>`:''}${o.status==='delivered'&&!o.workerConfirmed?`<button class="btn btn-gold btn-sm" onclick="confirmCustomDeliveryDone('${o.id}')">✅ Завершить</button>`:''}</div>`:'';
        html+=`<div class="work-order" style="margin-bottom:10px;"><div style="font-weight:900;font-size:14px;">${escHtml(o.sourceLabel||'')} «${escHtml(o.from)}»</div><div style="font-size:12px;color:var(--muted);">📋 ${escHtml(o.items)}</div><div style="font-size:12px;color:var(--muted);">📍 ${escHtml(o.address)}</div><div style="font-size:12px;color:var(--muted);">👤 ${escHtml(o.client)}</div>${o.contact?`<div style="font-size:12px;color:var(--muted);">📞 ${escHtml(o.contact)}</div>`:''}${o.distanceKm!=null?`<div style="font-size:12px;color:var(--muted);">📏 ${Number(o.distanceKm).toFixed(2)} км</div>`:''}${o.priceOffer!=null?`<div style="font-size:12px;color:var(--gold);font-weight:900;">💰 ${Number(o.priceOffer).toLocaleString()} ₽</div>`:''}${priceControl}${mineActions}</div>`;
    });
    delivList.insertAdjacentHTML('beforeend',html);
}

window.proposeCustomDeliveryPrice=async function(){ return toast('ℹ️ Цена доставки фиксирована: 200 ₽/км','gold'); };

window.takeCustomDelivery=async function(orderId){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.status!=='waiting'||!['business','marketplace'].includes(cur.source)||cur.worker)return;
        const amount=Number(cur.deliveryPrice||deliveryDistancePrice(Number(cur.distanceKm||0))||0);
        if(!Number.isFinite(amount)||amount<0)return;
        return {...cur,worker:currentNick,priceOffer:amount,status:'client_confirmed',priceMode:'fixed_200_per_km',clientConfirmed:true,clientConfirmedAt:Date.now(),driverAcceptedAt:Date.now()};
    });
    if(!res?.committed)return toast('❌ Заказ уже принят другим доставщиком','red');
    const o=res.snapshot.val(); await pushNotification(o.client,`🛵 ${currentNick} взял доставку «${o.from}» за ${Number(o.priceOffer||0).toLocaleString()} ₽`,'delivery_orders');
    toast(`✅ Заказ взят. Цена доставки: ${Number(o.priceOffer||0).toLocaleString()} ₽`,'green'); renderDeliveryCustomOrders(); renderMyDeliveryOrders();
};

window.confirmCustomDeliveryPrice=async function(orderId,approve){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.client!==currentNick||cur.status!=='price_proposed')return;
        if(!approve)return {...cur,status:'cancelled',cancelledAt:Date.now(),rejectedAt:Date.now(),worker:null,priceOffer:null};
        return {...cur,status:'client_confirmed',clientConfirmed:true,clientConfirmedAt:Date.now()};
    });
    if(!res?.committed)return toast('❌ Заказ уже изменён','red');
    if(!approve){const o=res.snapshot.val();if(o.worker){} toast('❌ Доставка отклонена','gold');renderMyDeliveryOrders();renderDeliveryCustomOrders();return;}
    // Reserve client money in the order escrow; the driver is not paid yet.
    const price=Number(res.snapshot.val()?.priceOffer||0);
    const pay=await runTransaction(userRef(currentNick),cur=>{
        const bal=Number(cur?.balance||0);if(bal<price)return;return {...cur,balance:bal-price};
    });
    if(!pay?.committed){
        await runTransaction(deliveryCustomOrderRef(orderId),cur=>cur?.status==='client_confirmed'&&cur.client===currentNick?{...cur,status:'price_proposed',clientConfirmed:false,clientConfirmedAt:null}:undefined);
        return toast(`❌ Недостаточно средств для доставки: ${price.toLocaleString()} ₽`,'red');
    }
    await update(deliveryCustomOrderRef(orderId),{escrowAmount:price});
    toast('✅ Цена подтверждена. Деньги зарезервированы до получения.','green');
    const o=res.snapshot.val(); await pushNotification(o.worker,`✅ ${o.client} подтвердил доставку за ${price} ₽`,'delivery_orders');
    renderMyDeliveryOrders();renderDeliveryCustomOrders();
};

window.startCustomDelivery=async function(orderId){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.worker!==currentNick||cur.status!=='client_confirmed')return;
        return {...cur,status:'in_progress',startedAt:Date.now()};
    });
    if(!res?.committed)return toast('❌ Статус заказа уже изменён','red');
    toast('🛵 Доставка началась','green');renderDeliveryCustomOrders();renderMyDeliveryOrders();
};

window.completeCustomDelivery=async function(orderId){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.worker!==currentNick||cur.status!=='in_progress')return;
        return {...cur,status:'delivered',deliveredAt:Date.now()};
    });
    if(!res?.committed)return toast('❌ Заказ уже завершён','red');
    const o=res.snapshot.val();if(o?.client)await pushNotification(o.client,`✅ Доставщик отметил доставку «${o.from}» выполненной. Подтвердите получение.` ,'delivery_orders');
    toast('✅ Доставлено. Ждём подтверждения клиента.','green');renderDeliveryCustomOrders();renderMyDeliveryOrders();
};

window.confirmCustomDeliveryReceived=async function(orderId){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.client!==currentNick||cur.status!=='delivered'||cur.clientReceived)return;
        return {...cur,clientReceived:true};
    });
    if(!res?.committed)return toast('❌ Заказ уже подтверждён','red');
    await finalizeCustomDeliveryPayout(orderId);
};

window.confirmCustomDeliveryDone=async function(orderId){
    const res=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.worker!==currentNick||cur.status!=='delivered'||cur.workerConfirmed)return;
        return {...cur,workerConfirmed:true};
    });
    if(!res?.committed)return toast('❌ Заказ уже подтверждён','red');
    await finalizeCustomDeliveryPayout(orderId);
};

async function finalizeCustomDeliveryPayout(orderId){
    const snap=await get(deliveryCustomOrderRef(orderId)),o=snap.val(); if(!o||o.payoutDone)return;
    if(!o.clientReceived||!o.workerConfirmed)return;
    const payout=Number(o.escrowAmount||0); if(payout<=0){
        await update(deliveryCustomOrderRef(orderId),{status:'done',payoutDone:true,paidAt:Date.now(),escrowAmount:0});
        return;
    }
    const pay=await runTransaction(deliveryCustomOrderRef(orderId),cur=>{
        if(!cur||cur.payoutDone||!cur.clientReceived||!cur.workerConfirmed)return;
        return {...cur,payoutDone:true,status:'done',paidAt:Date.now(),escrowAmount:0};
    });
    if(!pay?.committed)return;
    const workerRes=await runTransaction(userRef(o.worker),cur=>({...cur,balance:Number(cur?.balance||0)+payout}));
    if(workerRes?.committed){
        await logTx(o.worker,{type:'in',who:'Доставка',amt:payout,desc:`Доставка заказа ${o.id}`});
        await pushNotification(o.worker,`💰 +${payout} ₽ за доставку`,'money');
        await pushNotification(o.client,`✅ Доставка завершена. Доставщику выплачено ${payout} ₽.` ,'delivery_orders');
    } else {
        console.error('[delivery payout] worker credit failed',o.worker,orderId);
    }
    renderDeliveryCustomOrders();renderMyDeliveryOrders();
};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Hospital Core (refs, constants, identity helpers)
// ══════════════════════════════════════════════════════════════════
const HOSPITAL_LOCATION = 'Лёхин шалаш';
const hospitalServicesRef       = ()   => ref(db, 'hospital/services');
const hospitalServiceRef        = (id) => ref(db, `hospital/services/${id}`);
const hospitalAppointmentsRef   = ()   => ref(db, 'hospital/appointments');
const hospitalAppointmentRef    = (id) => ref(db, `hospital/appointments/${id}`);
const hospitalAssistantAppsRef  = ()   => ref(db, 'hospital/assistantApplications');
const hospitalAssistantAppRef   = (id) => ref(db, `hospital/assistantApplications/${id}`);
const hospitalAssistantSalaryRef= ()   => ref(db, 'hospital/assistantSalary');

function hospitalFindByRole(role){
    const entries = Object.entries(allUsersCache || {});
    const found = entries.find(([nick,u]) => u && hasMunicipalJob(u, role));
    return found ? { nick: found[0], user: found[1] } : null;
}
function getHospitalDoctor(){ return hospitalFindByRole('Врач'); }
function getHospitalAssistant(){ return hospitalFindByRole('Помощник врача'); }
async function refreshHospitalUsersCache(){
    try{
        const snap=await get(ref(db,'users'));
        const users=snap.val()||{};
        allUsersCache=users;window.allUsersCache=allUsersCache;
        return users;
    }catch(e){ console.error('[hospital users refresh]',e);return allUsersCache||{}; }
}
async function getHospitalDoctorFresh(){
    const users=await refreshHospitalUsersCache();
    const found=Object.entries(users||{}).find(([nick,u])=>u&&hasMunicipalJob(u,'Врач'));
    return found?{nick:found[0],user:found[1]}:null;
}
async function getHospitalAssistantFresh(){
    const users=await refreshHospitalUsersCache();
    const found=Object.entries(users||{}).find(([nick,u])=>u&&hasMunicipalJob(u,'Помощник врача'));
    return found?{nick:found[0],user:found[1]}:null;
}
function isHospitalDoctor(nick){
    const u=allUsersCache[nick||currentNick];return !!u&&hasMunicipalJob(u,'Врач');
}
function isHospitalAssistant(nick){
    const u=allUsersCache[nick||currentNick];return !!u&&hasMunicipalJob(u,'Помощник врача');
}
function splitDisplayName(u, nick){
    const dn = (displayNick(u) || nick || '').trim();
    const parts = dn.split(/\s+/).filter(Boolean);
    return { first: parts[0] || nick || '', last: parts.slice(1).join(' ') || '' };
}
const HOSPITAL_STATUS_LABELS = {
    pending:                { label:'⏳ Ожидает подтверждения врача',        cls:'gold'  },
    accepted:               { label:'✅ Подтверждено врачом',                 cls:'green' },
    rejected:               { label:'❌ Отклонено врачом',                    cls:'red'   },
    cancelled:              { label:'🚫 Отменено',                            cls:'red'   },
    awaiting_confirmation:  { label:'🕐 Ожидает подтверждения завершения',    cls:'gold'  },
    completed:              { label:'✅ Приём завершён',                      cls:'green' },
    paid:                   { label:'💳 Оплачено',                            cls:'green' }
};
function hospitalStatusBadge(appt){
    const s = HOSPITAL_STATUS_LABELS[appt.status] || {label:appt.status, cls:'gold'};
    return `<div class="status-badge ${s.cls==='green'?'badge-active':'badge-wait'}" style="${s.cls==='red'?'color:var(--red);':''}">${s.label}</div>`;
}

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — UI: patient-facing page
// ══════════════════════════════════════════════════════════════════
async function renderHospital(){
    const doc=await getHospitalDoctorFresh();
    const asst=await getHospitalAssistantFresh();
    const docCard=qs('hospitalDoctorCard');
    if(docCard){
        if(doc){
            const dn=displayNick(doc.user)||doc.nick;
            docCard.innerHTML=`<div class="item-row"><div style="flex:1;min-width:0;"><div style="font-weight:900;">👨‍⚕️ ${escHtml(dn)}</div><div style="font-size:12px;color:var(--muted);">@${escHtml(doc.nick)}</div></div><button class="btn btn-ghost btn-sm" onclick="openUserProfile('${escHtml(doc.nick)}')">👤 Профиль</button></div><div style="font-size:12px;color:var(--muted);margin-top:8px;">${asst?`🩺 Помощник врача: ${escHtml(displayNick(asst.user)||asst.nick)}`:'🩺 Помощник врача не назначен.'}</div>`;
        }else docCard.innerHTML='<div style="color:var(--muted);font-size:13px;">👨‍⚕️ Сейчас врач не назначен.</div>';
    }
    try{
        const [svcSnap,apptSnap,photoSnap]=await Promise.all([get(hospitalServicesRef()),get(hospitalAppointmentsRef()),get(ref(db,'hospital/photos'))]);
        renderHospitalServicesList(svcSnap.val()||{},doc);renderHospitalMyAppointments(apptSnap.val()||{});renderHospitalPhotosGallery(photoSnap.val()||{});
    }catch(e){console.error('[hospital render]',e);}
}
function renderHospitalServicesList(services, doc){
    const el = qs('hospitalServicesList'); if(!el) return;
    const list = Object.values(services).filter(s=>s.active!==false);
    if(!doc){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Врач ещё не назначен — запись недоступна.</div>'; return; }
    if(!list.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Врач пока не добавил услуги.</div>'; return; }
    el.innerHTML = list.map(s=>`<div class="item-row" style="flex-direction:column;align-items:stretch;">
        <div style="font-weight:900;">${escHtml(s.name)}</div>
        <div style="font-size:12px;color:var(--muted);margin:4px 0;">${escHtml(s.desc||'')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:var(--primary);font-weight:900;">${(s.price||0).toLocaleString()} ₽</span>
            <button class="btn btn-primary btn-sm" onclick="openHospitalBooking('${s.id}')">Записаться</button>
        </div>
    </div>`).join('');
}
function renderHospitalMyAppointments(appts){
    const el = qs('hospitalMyAppointments'); if(!el) return;
    const mine = Object.values(appts).filter(a=>a.clientNick===currentNick).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!mine.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Нет записей</div>'; return; }
    el.innerHTML = mine.map(a=>{
        let actions = '';
        if(a.status==='pending' || a.status==='accepted'){
            actions += `<button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="cancelHospitalAppointment('${a.id}')">❌ Отменить запись</button>`;
        }
        if(a.status==='awaiting_confirmation' && !a.clientConfirmed){
            actions += `<button class="btn btn-primary btn-sm" onclick="clientConfirmHospitalAppointment('${a.id}')">✅ Всё завершено</button>`;
        }
        return `<div class="work-order" style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
                <b>🩺 ${escHtml(a.serviceName)}</b>${hospitalStatusBadge(a)}
            </div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">📅 ${escHtml(a.date)} 🕐 ${escHtml(a.time)} · ${(a.price||0).toLocaleString()} ₽</div>
            ${actions?`<div style="display:flex;gap:8px;flex-wrap:wrap;">${actions}</div>`:''}
        </div>`;
    }).join('');
}

// ── Booking (record creation) ──────────────────────────────────────
let _hospBookingServiceId = null;
window.openHospitalBooking = function(serviceId){
    _hospBookingServiceId = serviceId;
    const card = qs('hospitalBookingCard'); if(!card) return;
    get(hospitalServiceRef(serviceId)).then(snap=>{
        const s = snap.val();
        if(!s) return toast('❌ Услуга не найдена','red');
        const infoEl = qs('hospitalBookingServiceInfo');
        if(infoEl) infoEl.innerHTML = `<b>${escHtml(s.name)}</b> — ${(s.price||0).toLocaleString()} ₽<br>${escHtml(s.desc||'')}`;
        const dateInp = qs('hospitalBookDate'); if(dateInp){ dateInp.min = todayKey(); dateInp.value = todayKey(); }
        card.style.display = 'block';
        card.scrollIntoView({behavior:'smooth', block:'center'});
    });
};
window.cancelHospitalBookingForm = function(){
    _hospBookingServiceId = null;
    const card = qs('hospitalBookingCard'); if(card) card.style.display='none';
};
let _hospBookingBusy = false;
window.confirmHospitalBooking = async function(){
    if(_hospBookingBusy) return;
    if(!_hospBookingServiceId) return toast('⚠️ Услуга не выбрана','gold');
    const date = qs('hospitalBookDate')?.value;
    const time = qs('hospitalBookTime')?.value;
    if(!date || !time) return toast('⚠️ Укажите дату и время','gold');
    _hospBookingBusy = true;
    try {
        const doc = await getHospitalDoctorFresh();
        if(!doc) { toast('❌ Врач не назначен','red'); return; }
        const svcSnap = await get(hospitalServiceRef(_hospBookingServiceId));
        const s = svcSnap.val();
        if(!s || s.active===false) { toast('❌ Услуга недоступна','red'); return; }
        const uSnap = await get(userRef(currentNick));
        const u = uSnap.val() || {};
        const {first, last} = splitDisplayName(u, currentNick);
        const id = genId();
        const appt = {
            id, clientNick: currentNick, clientName: first, clientSurname: last,
            doctorNick: doc.nick, serviceId: s.id, serviceName: s.name, serviceDescription: s.desc||'',
            price: s.price||0, date, time, status:'pending',
            doctorConfirmed:false, clientConfirmed:false, paymentStatus:'unpaid', createdAt: Date.now()
        };
        await set(hospitalAppointmentRef(id), appt);
        await pushNotification(doc.nick, `🏥 Новая запись: ${first} ${last} — ${s.name} (${date} ${time})`, 'system');
        await pushNotification(currentNick, `⏳ Заявка на приём отправлена врачу`, 'system');
        toast('✅ Запись отправлена врачу','green');
        cancelHospitalBookingForm();
        renderHospital();
        console.log('hospital appointment created', id);
    } catch(e){ console.error(e); toast('❌ Не удалось создать запись','red'); }
    finally { _hospBookingBusy = false; }
};

// ── Client-side actions: cancel / confirm completion ────────────────
let _hospActionBusy = false;
window.cancelHospitalAppointment = async function(id){
    if(_hospActionBusy) return;
    if(!confirm('Вы уверены, что хотите отменить запись?')) return;
    _hospActionBusy = true;
    try {
        const snap = await get(hospitalAppointmentRef(id));
        const a = snap.val();
        if(!a) { toast('❌ Запись не найдена','red'); return; }
        if(a.clientNick !== currentNick) { toast('❌ Это не ваша запись','red'); return; }
        if(!['pending','accepted'].includes(a.status)) { toast('⚠️ Эту запись уже нельзя отменить','gold'); return; }
        await update(hospitalAppointmentRef(id), { status:'cancelled', cancelledAt: Date.now(), cancelledBy: currentNick });
        await pushNotification(a.doctorNick, `❌ Клиент отменил запись: ${a.serviceName} (${a.date} ${a.time})`, 'system');
        toast('🚫 Запись отменена','gold');
        renderHospital();
        console.log('hospital appointment cancelled', id);
    } catch(e){ console.error(e); toast('❌ Ошибка отмены','red'); }
    finally { _hospActionBusy = false; }
};
window.clientConfirmHospitalAppointment = async function(id){
    if(_hospActionBusy) return;
    _hospActionBusy = true;
    try {
        const snap = await get(hospitalAppointmentRef(id));
        const a = snap.val();
        if(!a) { toast('❌ Запись не найдена','red'); return; }
        if(a.clientNick !== currentNick) { toast('❌ Это не ваша запись','red'); return; }
        if(a.status !== 'awaiting_confirmation') { toast('⚠️ Нельзя подтвердить сейчас','gold'); return; }
        await update(hospitalAppointmentRef(id), { clientConfirmed: true, clientConfirmedAt: Date.now() });
        toast('✅ Подтверждено','green');
        await tryFinalizeHospitalPayment(id);
        renderHospital();
    } catch(e){ console.error(e); toast('❌ Ошибка','red'); }
    finally { _hospActionBusy = false; }
};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Payments (atomic, double-payment safe)
// ══════════════════════════════════════════════════════════════════
async function tryFinalizeHospitalPayment(id){
    try {
        const snap = await get(hospitalAppointmentRef(id));
        const a = snap.val();
        if(!a) return;
        if(!(a.doctorConfirmed && a.clientConfirmed)) return;
        if(a.paymentStatus === 'paid') return;
        // Atomic lock on paymentStatus prevents double-click / double-tab / reload races
        const txResult = await runTransaction(ref(db, `hospital/appointments/${id}/paymentStatus`), (cur) => {
            if(cur === 'paid' || cur === 'processing') return; // abort transaction, no change
            return 'processing';
        });
        if(!txResult.committed || txResult.snapshot.val() !== 'processing') return;

        const freshSnap = await get(hospitalAppointmentRef(id));
        const appt = freshSnap.val();
        if(!appt || appt.paymentStatus !== 'processing') return;

        const [clientSnap, doctorSnap] = await Promise.all([get(userRef(appt.clientNick)), get(userRef(appt.doctorNick))]);
        const client = clientSnap.val();
        const doctor = doctorSnap.val();
        if(!client || !doctor){ await update(hospitalAppointmentRef(id), { paymentStatus:'unpaid' }); return; }

        const price = Number(appt.price)||0;
        if((client.balance||0) < price){
            await update(hospitalAppointmentRef(id), { paymentStatus:'unpaid' });
            await pushNotification(appt.clientNick, `⚠️ Недостаточно средств для оплаты приёма «${appt.serviceName}» (${price}₽). Пополните баланс.`, 'money');
            return;
        }
        await update(userRef(appt.clientNick), { balance: (client.balance||0) - price });
        await update(userRef(appt.doctorNick), { balance: (doctor.balance||0) + price });
        await logTx(appt.clientNick, { type:'out', who: appt.doctorNick, amt: price, desc: `Оплата приёма: ${appt.serviceName}` });
        await logTx(appt.doctorNick, { type:'in', who: appt.clientNick, amt: price, desc: `Оплата приёма: ${appt.serviceName}` });
        await update(hospitalAppointmentRef(id), { paymentStatus:'paid', status:'paid', paidAt: Date.now() });
        await pushNotification(appt.clientNick, `💳 Оплата приёма «${appt.serviceName}» проведена: ${price}₽`, 'money');
        await pushNotification(appt.doctorNick, `💰 Получена оплата за приём «${appt.serviceName}»: ${price}₽ от ${appt.clientNick}`, 'money');
        console.log('hospital payment completed', id);
    } catch(e){ console.error('[hospital payment]', e); }
}

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Doctor Panel: appointments
// ══════════════════════════════════════════════════════════════════
async function renderHospitalPanel(){
    await refreshHospitalUsersCache();
    const isDoc=isHospitalDoctor(currentNick), isAsst=!isDoc&&isHospitalAssistant(currentNick), canAccess=isDoc||isAsst;
    const notice=qs('hospitalPanelNoAccess'), panel=qs('hospitalPanel');
    if(notice)notice.style.display=canAccess?'none':'block';
    if(panel)panel.querySelectorAll(':scope > .card:not(#hospitalPanelNoAccess)').forEach(c=>c.style.display=canAccess?'':'none');
    if(!canAccess)return;
    const doc=getHospitalDoctor();
    try{
        const [apptSnap,svcSnap,appsSnap,salarySnap,photoSnap]=await Promise.all([get(hospitalAppointmentsRef()),get(hospitalServicesRef()),get(hospitalAssistantAppsRef()),get(hospitalAssistantSalaryRef()),get(ref(db,'hospital/photos'))]);
        renderHospitalPanelAppointments(apptSnap.val()||{},doc?.nick||null);
        renderHospitalPanelServices(svcSnap.val()||{},isDoc);
        renderHospitalPanelAssistant(appsSnap.val()||{},salarySnap.val()||0,isDoc);
        renderHospitalPanelPhotos(photoSnap.val()||{},isDoc);
        renderHospitalPanelFinance(Object.values(apptSnap.val()||{}),doc?.nick||null);
        const se=qs('hospitalDoctorServiceEditor');if(se)se.style.display=isDoc?'':'none';
        const pe=qs('hospitalDoctorPhotoEditor');if(pe)pe.style.display=isDoc?'':'none';
    }catch(e){console.error('[hospital panel render]',e);}
}
function renderHospitalPanelAppointments(appts,doctorNick){
    const el=qs('hospitalPanelAppointments');if(!el)return;
    if(!doctorNick){el.innerHTML='<div style="color:var(--muted);font-size:13px;">Врач ещё не назначен.</div>';return;}
    const mine=Object.values(appts).filter(a=>a.doctorNick===doctorNick).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!mine.length){ el.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет записей</div>'; return; }
    const today = todayKey();
    const groups = {today:[], upcoming:[], completed:[], other:[]};
    mine.forEach(a=>{
        if(a.status==='paid'||a.status==='completed') groups.completed.push(a);
        else if(a.status==='rejected'||a.status==='cancelled') groups.other.push(a);
        else if(a.date===today) groups.today.push(a);
        else groups.upcoming.push(a);
    });
    const renderCard = (a) => {
        let actions='';
        if(a.status==='pending') actions = `<button class="btn btn-primary btn-sm" onclick="doctorAcceptAppointment('${a.id}')">✅ Принять</button><button class="btn btn-red btn-sm" onclick="doctorRejectAppointment('${a.id}')">❌ Отказать</button>`;
        else if(a.status==='accepted') actions = `<button class="btn btn-primary btn-sm" onclick="doctorCompleteAppointment('${a.id}')">✅ Приём завершён</button>`;
        else if(a.status==='awaiting_confirmation') actions = `<div style="font-size:12px;color:var(--gold);">Ожидает подтверждения клиента</div>`;
        return `<div class="work-order" style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
                <b>👤 ${escHtml(a.clientName)} ${escHtml(a.clientSurname)}</b>${hospitalStatusBadge(a)}
            </div>
            <div style="font-size:12px;color:var(--muted);">@${escHtml(a.clientNick)}</div>
            <div style="font-size:13px;font-weight:800;margin:6px 0;">🩺 ${escHtml(a.serviceName)}</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">📅 ${escHtml(a.date)} 🕐 ${escHtml(a.time)} · ${(a.price||0).toLocaleString()} ₽</div>
            ${actions?`<div style="display:flex;gap:8px;flex-wrap:wrap;">${actions}</div>`:''}
        </div>`;
    };
    let html='';
    if(groups.today.length) html += `<div style="font-size:11px;font-weight:900;color:var(--primary);margin-bottom:6px;">СЕГОДНЯ</div>` + groups.today.map(renderCard).join('');
    if(groups.upcoming.length) html += `<div style="font-size:11px;font-weight:900;color:var(--muted);margin:10px 0 6px;">БУДУЩИЕ</div>` + groups.upcoming.map(renderCard).join('');
    if(groups.completed.length) html += `<div style="font-size:11px;font-weight:900;color:var(--muted);margin:10px 0 6px;">ЗАВЕРШЁННЫЕ</div>` + groups.completed.slice(0,15).map(renderCard).join('');
    if(groups.other.length) html += `<div style="font-size:11px;font-weight:900;color:var(--muted);margin:10px 0 6px;">ОТКЛОНЁННЫЕ/ОТМЕНЁННЫЕ</div>` + groups.other.slice(0,10).map(renderCard).join('');
    el.innerHTML = html;
}
let _hospDoctorBusy = false;
async function hospitalDoctorSetStatus(id,newStatus,notifyTextFn,extraPatch){
    if(_hospDoctorBusy)return;
    await refreshHospitalUsersCache();
    const isDoc=isHospitalDoctor(currentNick),isAsst=!isDoc&&isHospitalAssistant(currentNick);
    if(!isDoc&&!isAsst){toast('❌ Только сотрудникам больницы','red');return;}
    const doctor=getHospitalDoctor();if(!doctor){toast('❌ Врач не назначен','red');return;}
    _hospDoctorBusy=true;
    try{
        const snap=await get(hospitalAppointmentRef(id));
        const a=snap.val();
        if(!a){toast('❌ Запись не найдена','red');return;}
        if(a.doctorNick!==doctor.nick){toast('❌ Это не запись вашего врача','red');return;}
        const allowedFrom = { accepted:['pending'], rejected:['pending'], awaiting_confirmation:['accepted'] };
        if(!allowedFrom[newStatus].includes(a.status)) { toast('⚠️ Недопустимый переход статуса','gold'); return; }
        const patch = Object.assign({ status:newStatus, updatedAt: Date.now() }, extraPatch||{});
        await update(hospitalAppointmentRef(id), patch);
        await pushNotification(a.clientNick, notifyTextFn(a), 'system');
        toast('✅ Обновлено','green');
        console.log('hospital appointment', newStatus, id);
        renderHospitalPanel();
    } catch(e){ console.error(e); toast('❌ Ошибка','red'); }
    finally { _hospDoctorBusy = false; }
}
window.doctorAcceptAppointment = function(id){
    return hospitalDoctorSetStatus(id, 'accepted', a => `✅ Врач подтвердил запись: ${a.serviceName} (${a.date} ${a.time})`);
};
window.doctorRejectAppointment = function(id){
    return hospitalDoctorSetStatus(id, 'rejected', a => `❌ Врач отклонил запись: ${a.serviceName} (${a.date} ${a.time})`);
};
window.doctorCompleteAppointment = function(id){
    return hospitalDoctorSetStatus(id, 'awaiting_confirmation', a => `Врач отметил приём «${a.serviceName}» как завершённый. Подтвердите завершение в разделе «🏥 Больница».`, {doctorConfirmed:true, doctorConfirmedAt: Date.now()});
};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Doctor Panel: services CRUD
// ══════════════════════════════════════════════════════════════════
function renderHospitalPanelServices(services,canManage=true){
    const el=qs('hospitalPanelServices');if(!el)return;const list=Object.values(services);
    if(!list.length){el.innerHTML='<div style="color:var(--muted);font-size:13px;">Пока нет услуг</div>';return;}
    el.innerHTML=list.map(s=>`<div class="item-row"><div><div style="font-weight:800;">${escHtml(s.name)} ${s.active===false?'<span style="color:var(--muted);font-size:11px;">(отключена)</span>':''}</div><div style="font-size:12px;color:var(--muted);">${escHtml(s.desc||'')} · ${(s.price||0).toLocaleString()} ₽</div></div>${canManage?`<div style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="editHospitalService('${s.id}')">✏️</button><button class="btn btn-ghost btn-sm" onclick="toggleHospitalService('${s.id}')">${s.active===false?'▶️':'⏸'}</button><button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="deleteHospitalService('${s.id}')">🗑</button></div>`:''}</div>`).join('');
}
window.addHospitalService = async function(){
    if(!isHospitalDoctor(currentNick)) { toast('❌ Только для врача','red'); return; }
    const name = (qs('hospServiceName')?.value||'').trim();
    const desc = (qs('hospServiceDesc')?.value||'').trim();
    const price = parseInt(qs('hospServicePrice')?.value,10);
    if(!name) { toast('⚠️ Укажите название услуги','gold'); return; }
    if(!price || price<=0) { toast('⚠️ Укажите цену','gold'); return; }
    const id = genId();
    await set(hospitalServiceRef(id), { id, name, desc, price, active:true, createdBy: currentNick, createdAt: Date.now() });
    if(qs('hospServiceName')) qs('hospServiceName').value='';
    if(qs('hospServiceDesc')) qs('hospServiceDesc').value='';
    if(qs('hospServicePrice')) qs('hospServicePrice').value='';
    toast('✅ Услуга добавлена','green');
    renderHospitalPanel();
};
window.editHospitalService = async function(id){
    if(!isHospitalDoctor(currentNick)) return;
    const snap = await get(hospitalServiceRef(id));
    const s = snap.val(); if(!s) return;
    const name = prompt('Название услуги:', s.name); if(name===null) return;
    const desc = prompt('Описание:', s.desc||''); if(desc===null) return;
    const priceStr = prompt('Цена ₽:', s.price); if(priceStr===null) return;
    const price = parseInt(priceStr,10);
    if(!name.trim() || !price || price<=0) { toast('⚠️ Некорректные данные','gold'); return; }
    await update(hospitalServiceRef(id), { name:name.trim(), desc:desc.trim(), price });
    toast('✅ Услуга обновлена','green');
    renderHospitalPanel();
};
window.toggleHospitalService = async function(id){
    if(!isHospitalDoctor(currentNick)) return;
    const snap = await get(hospitalServiceRef(id));
    const s = snap.val(); if(!s) return;
    await update(hospitalServiceRef(id), { active: !(s.active!==false) });
    renderHospitalPanel();
};
window.deleteHospitalService = async function(id){
    if(!isHospitalDoctor(currentNick)) return;
    if(!confirm('Удалить услугу?')) return;
    await remove(hospitalServiceRef(id));
    toast('🗑 Услуга удалена','gold');
    renderHospitalPanel();
};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Assistant hiring & salary
// ══════════════════════════════════════════════════════════════════
window.applyForHospitalAssistant = async function(){
    const uSnap = await get(userRef(currentNick));
    const u = uSnap.val()||{};
    if(hasMunicipalJob(u,'Помощник врача')) { toast('⚠️ Вы уже помощник врача','gold'); return; }
    const score = (u.kveScore!==undefined && u.kveScore!==null) ? Number(u.kveScore) : null;
    const required = KVE_JOB_REQUIREMENTS['Помощник врача']||80;
    if(score===null) { toast('📝 У вас ещё нет балла КВЭ','gold'); return; }
    if(score < required) { toast(`❌ Нужен балл КВЭ ${required}. Ваш балл: ${score}.`,'red'); return; }
    if(getHospitalAssistant()) { toast('❌ Должность помощника врача уже занята.','red'); return; }
    const doc = getHospitalDoctor();
    if(!doc) { toast('❌ Врач не назначен, заявка невозможна','red'); return; }
    const appsSnap = await get(hospitalAssistantAppsRef());
    const apps = appsSnap.val()||{};
    const already = Object.values(apps).some(a=>a.from===currentNick && a.status==='pending');
    if(already) { toast('⚠️ Заявка уже отправлена','gold'); return; }
    const id = genId();
    await set(hospitalAssistantAppRef(id), { id, from:currentNick, kveScore:score, status:'pending', createdAt: Date.now() });
    await pushNotification(doc.nick, `🩺 Новая заявка на должность помощника врача: ${currentNick} (КВЭ ${score})`, 'system');
    toast('⏳ Заявка отправлена врачу','green');
    renderHospitalJobsCard();
};
function renderHospitalPanelAssistant(apps,salary,canManageAssistant=true){
    const asst=getHospitalAssistant();const el=qs('hospitalPanelAssistant');if(!el)return;let html='';
    if(asst){html+=`<div class="item-row"><div><div style="font-weight:900;">🩺 ${escHtml(displayNick(asst.user)||asst.nick)}</div><div style="font-size:12px;color:var(--muted);">@${escHtml(asst.nick)}</div></div></div>`;if(canManageAssistant)html+=`<div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Зарплата (₽)</div><input type="number" id="hospAssistantSalaryInput" min="0" step="1" value="${Number(salary)||0}"><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="saveHospitalAssistantSalary()">💾 Сохранить зарплату</button><button class="btn btn-gold btn-sm" style="margin-top:8px;margin-left:8px;" onclick="payHospitalAssistantSalary()">💰 Выдать зарплату</button></div>`;}
    else html='<div style="color:var(--muted);font-size:13px;">🩺 Помощник врача не назначен.</div>';
    if(!canManageAssistant)html+='<div style="font-size:11px;color:var(--muted);margin-top:8px;">Вам доступно принятие записей клиентов. Создание услуг, публикация фото и управление помощником недоступны.</div>';
    el.innerHTML=html;const appsEl=qs('hospitalPanelAssistantApps');if(appsEl)appsEl.innerHTML=canManageAssistant?'<div style="color:var(--muted);font-size:13px;">Заявки доступны врачу.</div>':'<div style="color:var(--muted);font-size:13px;">Назначение помощника доступно только врачу.</div>';
}
let _hospAssistantBusy = false;
window.acceptHospitalAssistantApp = async function(id){
    if(_hospAssistantBusy) return;
    if(!isHospitalDoctor(currentNick)) { toast('❌ Только для врача','red'); return; }
    _hospAssistantBusy = true;
    try {
        if(getHospitalAssistant()) { toast('❌ Должность помощника врача уже занята.','red'); return; }
        const snap = await get(hospitalAssistantAppRef(id));
        const a = snap.val();
        if(!a || a.status!=='pending') { toast('⚠️ Заявка недоступна','gold'); return; }
        const uSnap = await get(userRef(a.from));
        const u = uSnap.val()||{};
        if(!await canTakeAnotherJob(u, a.from)) { toast(`❌ Лимит работ для ${a.from}`,'red'); return; }
        const emps = collectEmploymentsFromData(u, a.from);
        const newEmp = { id: 'muni_Помощник врача', type: 'municipal', role: 'Помощник врача' };
        const patch = { job:'Помощник врача', employments:[...emps.filter(e=>e.id!==newEmp.id), newEmp], displayJob: u.displayJob || 'Помощник врача' };
        await update(userRef(a.from), patch);
        await update(hospitalAssistantAppRef(id), { status:'accepted', reviewedAt: Date.now() });
        await pushNotification(a.from, `✅ Вы приняты на должность помощника врача`, 'system');
        toast('✅ Помощник назначен','green');
        console.log('assistant hired', a.from);
        renderHospitalPanel();
    } catch(e){ console.error(e); toast('❌ Ошибка','red'); }
    finally { _hospAssistantBusy = false; }
};
window.rejectHospitalAssistantApp = async function(id){
    if(!isHospitalDoctor(currentNick)) return;
    await update(hospitalAssistantAppRef(id), { status:'rejected', reviewedAt: Date.now() });
    const snap = await get(hospitalAssistantAppRef(id));
    const a = snap.val();
    if(a) await pushNotification(a.from, `❌ Заявка на должность помощника врача отклонена`, 'system');
    toast('❌ Отклонено','red');
    console.log('assistant rejected', a && a.from);
    renderHospitalPanel();
};
window.saveHospitalAssistantSalary = async function(){
    if(!isHospitalDoctor(currentNick)) return;
    const val = parseInt(qs('hospAssistantSalaryInput')?.value,10);
    if(isNaN(val) || val<0) { toast('⚠️ Некорректная сумма','gold'); return; }
    await set(hospitalAssistantSalaryRef(), val);
    toast('💾 Зарплата сохранена','green');
};
let _hospSalaryBusy = false;
window.payHospitalAssistantSalary = async function(){
    if(_hospSalaryBusy) return;
    if(!isHospitalDoctor(currentNick)) return;
    const asst = getHospitalAssistant();
    if(!asst) { toast('❌ Помощник не назначен','red'); return; }
    const salarySnap = await get(hospitalAssistantSalaryRef());
    const amount = Number(salarySnap.val())||0;
    if(amount<=0) { toast('⚠️ Укажите зарплату перед выплатой','gold'); return; }
    if(!confirm(`Выдать зарплату ${amount}₽ помощнику ${asst.nick}?`)) return;
    _hospSalaryBusy = true;
    try {
        const docSnap = await get(userRef(currentNick));
        const doc = docSnap.val()||{};
        if((doc.balance||0) < amount) { toast('❌ Недостаточно средств','red'); return; }
        const asstSnap = await get(userRef(asst.nick));
        const asstUser = asstSnap.val()||{};
        await update(userRef(currentNick), { balance: (doc.balance||0) - amount });
        await update(userRef(asst.nick), { balance: (asstUser.balance||0) + amount });
        await logTx(currentNick, { type:'out', who: asst.nick, amt: amount, desc:'Зарплата помощнику врача' });
        await logTx(asst.nick, { type:'in', who: currentNick, amt: amount, desc:'Зарплата от врача' });
        await pushNotification(asst.nick, `💰 Получена зарплата ${amount}₽ от врача`, 'money');
        toast('✅ Зарплата выплачена','green');
        console.log('doctor salary paid', asst.nick, amount);
        renderHospitalPanel();
    } catch(e){ console.error(e); toast('❌ Ошибка выплаты','red'); }
    finally { _hospSalaryBusy = false; }
};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Photos
// ══════════════════════════════════════════════════════════════════
function escAttr(v){return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderHospitalPhotoCards(photos,canDelete){
    const list=Object.entries(photos||{}).sort((a,b)=>(b[1]?.createdAt||0)-(a[1]?.createdAt||0));
    if(!list.length)return '<div style="color:var(--muted);font-size:13px;">Фотографий пока нет.</div>';
    return `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">${list.map(([id,p])=>`<div style="position:relative;background:var(--surface2);border:1px solid var(--border);border-radius:14px;overflow:hidden;"><img src="${escAttr(p.data||'')}" alt="Фото больницы" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;cursor:pointer;" onclick="openImageFullscreen('${escAttr(p.data||'')}')">${canDelete?`<button class="btn btn-red btn-sm" style="position:absolute;right:6px;top:6px;min-width:0;padding:7px 9px;" onclick="deleteHospitalPhoto('${escAttr(id)}')">🗑</button>`:''}<div style="font-size:10px;color:var(--muted);padding:7px 8px;">${escHtml(p.authorNick||'Врач')}</div></div>`).join('')}</div>`;
}
function renderHospitalPhotosGallery(photos){const el=qs('hospitalPhotosGallery');if(el)el.innerHTML=renderHospitalPhotoCards(photos,false);}
function renderHospitalPanelPhotos(photos,canDelete){const el=qs('hospitalPanelPhotos');if(el)el.innerHTML=renderHospitalPhotoCards(photos,canDelete);}
function readHospitalImage(file){return new Promise((resolve,reject)=>{if(!file||!file.type.startsWith('image/'))return reject(new Error('Нужен файл изображения'));const r=new FileReader();r.onerror=()=>reject(new Error('Не удалось прочитать фото'));r.onload=()=>{const img=new Image();img.onload=()=>{const max=1280,scale=Math.min(1,max/Math.max(img.width,img.height)),w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);resolve(c.toDataURL('image/jpeg',0.82));};img.onerror=()=>reject(new Error('Не удалось обработать фото'));img.src=r.result;};r.readAsDataURL(file);});}
let _hospitalPhotosBusy=false;
window.uploadHospitalPhotos=async function(){if(!isHospitalDoctor(currentNick))return toast('❌ Публиковать фото может только врач','red');if(_hospitalPhotosBusy)return;const input=qs('hospitalPhotoInput'),files=Array.from(input?.files||[]);if(!files.length)return toast('⚠️ Выберите фотографии','gold');if(files.length>6)return toast('⚠️ За раз можно добавить максимум 6 фото','gold');_hospitalPhotosBusy=true;try{for(const f of files){const data=await readHospitalImage(f),id=genId();await set(ref(db,`hospital/photos/${id}`),{id,data,authorNick:currentNick,createdAt:Date.now()});}if(input)input.value='';toast(`✅ Добавлено фото: ${files.length}`,'green');renderHospitalPanel();renderHospital();}catch(e){console.error('[hospital photo upload]',e);toast('❌ '+(e.message||'Не удалось загрузить фото'),'red');}finally{_hospitalPhotosBusy=false;}};
window.deleteHospitalPhoto=async function(id){if(!isHospitalDoctor(currentNick))return toast('❌ Удалять фото может только врач','red');if(!confirm('Удалить эту фотографию больницы?'))return;try{await remove(ref(db,`hospital/photos/${id}`));toast('🗑 Фото удалено','gold');renderHospitalPanel();renderHospital();}catch(e){console.error('[hospital photo delete]',e);toast('❌ Не удалось удалить фото','red');}};

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Doctor Panel: finance & stats
// ══════════════════════════════════════════════════════════════════
function renderHospitalPanelFinance(appts,doctorNick){
    const el=qs('hospitalPanelFinance');if(!el)return;
    if(!doctorNick){el.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет назначенного врача.</div>';return;}
    const paid=appts.filter(a=>a.doctorNick===doctorNick && a.paymentStatus==='paid');
    const total = paid.reduce((s,a)=>s+(a.price||0),0);
    const now = Date.now();
    const weekAgo = now - 7*24*60*60*1000;
    const monthAgo = now - 30*24*60*60*1000;
    const todayStr = todayKey();
    const todayCount = appts.filter(a=>a.doctorNick===doctorNick && a.date===todayStr && a.status!=='rejected' && a.status!=='cancelled').length;
    const weekSum = paid.filter(a=>(a.paidAt||0)>=weekAgo).reduce((s,a)=>s+(a.price||0),0);
    const monthSum = paid.filter(a=>(a.paidAt||0)>=monthAgo).reduce((s,a)=>s+(a.price||0),0);
    const clients = new Set(paid.map(a=>a.clientNick)).size;
    const svcCounts = {};
    paid.forEach(a=>{ svcCounts[a.serviceName] = (svcCounts[a.serviceName]||0)+1; });
    const topSvc = Object.entries(svcCounts).sort((a,b)=>b[1]-a[1])[0];
    el.innerHTML = `<div style="font-size:13px;line-height:2;">
        💰 Всего заработано: <b style="color:var(--primary);">${total.toLocaleString()} ₽</b><br>
        📅 За неделю: <b>${weekSum.toLocaleString()} ₽</b> · За месяц: <b>${monthSum.toLocaleString()} ₽</b><br>
        🧾 Приёмов оплачено: <b>${paid.length}</b> · Приёмов сегодня: <b>${todayCount}</b> · Клиентов: <b>${clients}</b><br>
        ${topSvc?`⭐ Популярная услуга: <b>${escHtml(topSvc[0])}</b> (${topSvc[1]})`:''}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 🏥 HOSPITAL — Jobs page integration ("О профессиях" / assistant apply)
// ══════════════════════════════════════════════════════════════════
async function renderHospitalJobsCard(){
    const el = qs('hospitalJobsInfo'); if(!el) return;
    await refreshHospitalUsersCache();
    const doc = getHospitalDoctor();
    const asst = getHospitalAssistant();
    const u = allUsersCache[currentNick] || {};
    const score = (u.kveScore!==undefined && u.kveScore!==null) ? Number(u.kveScore) : null;
    const isAsst = hasMunicipalJob(u, 'Помощник врача');
    const required = KVE_JOB_REQUIREMENTS['Помощник врача']||80;
    let asstAction = '';
    if(isAsst){
        asstAction = '<div style="color:var(--primary);font-size:12px;font-weight:800;">✅ Вы — помощник врача</div>';
    } else if(!doc){
        asstAction = '<div style="color:var(--muted);font-size:12px;">Врач ещё не назначен</div>';
    } else if(asst){
        asstAction = '<div style="color:var(--muted);font-size:12px;">❌ Должность помощника врача уже занята.</div>';
    } else if(score===null){
        asstAction = '<div style="color:var(--muted);font-size:12px;">📝 Нужен балл КВЭ</div>';
    } else if(score < required){
        asstAction = `<div style="color:var(--muted);font-size:12px;">🔒 Нужен балл КВЭ ${required} (у вас ${score})</div>`;
    } else {
        asstAction = '<button class="btn btn-primary btn-sm" onclick="applyForHospitalAssistant()">Подать заявку</button>';
    }
    el.innerHTML = `<div style="font-size:13px;">
        <div style="margin-bottom:8px;">👨‍⚕️ Врач: ${doc?`<b>${escHtml(displayNick(doc.user)||doc.nick)}</b>`:'<span style="color:var(--muted);">не назначен</span>'}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div>🩺 Помощник врача: ${asst?`<b>${escHtml(displayNick(asst.user)||asst.nick)}</b>`:'<span style="color:var(--muted);">свободно</span>'}</div>
        </div>
        <div style="margin-top:8px;">${asstAction}</div>
    </div>`;
}

// Inline HTML handlers execute in the window scope, while this file is an ES module.
// Expose the few function declarations that are referenced directly by inline attributes.
window.renderOnlineDuelLobby = renderOnlineDuelLobby;
window.snakeStartNew = snakeStartNew;
window.renderBizOwnerPanel = renderBizOwnerPanel;

// ─── KAPANI PACK v2: expose module-scoped symbols to window for the additive pack ───
try {
  window.db = db;
  window.kapaniSupabase = supabase;
  window.kapaniGetAuth = ensureAuth;
  window.ADMIN = ADMIN;
  window.JOB_JANITOR = JOB_JANITOR;
  window.MIN_BALANCE_ALLOWED = MIN_BALANCE_ALLOWED;
  window.qs = qs;
  window.toast = toast;
  window.escHtml = escHtml;
  window.jsEsc = jsEsc;
  window.userRef = userRef;
  window.collectEmploymentsFromData = collectEmploymentsFromData;
  window.hasMunicipalJob = hasMunicipalJob;
  window.pushNotification = pushNotification;
  window.KVE_JOB_REQUIREMENTS = KVE_JOB_REQUIREMENTS;
  window.findUserByPublicName = findUserByPublicName;
  window.logTx = logTx;
  window.txLogRef = txLogRef;
  window.fullDateTimeStr = fullDateTimeStr;
  window.parseMoneyValue = parseMoneyValue;
  window.bizItemRef = bizItemRef;
  window.JANITOR_TASK_TEXT = JANITOR_TASK_TEXT;
  // updateHeader/updateHeader_balance are called from the classic (non-module)
  // <script> further down (casino, K-education, licenses, etc). Module-scope
  // function declarations are private to this module and are NOT visible
  // there, so without this export those calls throw
  // "ReferenceError: updateHeader is not defined" — an unhandled rejection
  // that aborts the rest of the calling function (toasts/UI updates after it
  // never run, balances look stuck, buttons feel unresponsive).
  window.updateHeader = updateHeader;
  window.updateHeader_balance = updateHeader_balance;
  // Shared Firebase primitives — additive modules must reuse these instead of
  // importing their own copy of the Firebase SDK (was: a second, differently
  // versioned firebase-database.js fetched and initialized independently).
  window.dbRef = ref; window.dbGet = get; window.dbSet = set; window.dbUpdate = update;
  window.dbRemove = remove; window.dbPush = push; window.dbOnValue = onValue; window.dbOff = off;
  window.runTransaction = runTransaction;
  if (typeof renderAdmin === 'function') window.renderAdmin = renderAdmin;
  if (typeof renderJanitorPage === 'function') window.renderJanitorPage = renderJanitorPage;
  // currentNick: direct reference is sufficient — defineProperty caused call stack overflow
  // when any code accessed window.currentNick inside the getter chain.
  // The main app module sets currentNick as a let variable; Kapani Pack reads it via closure.
  window._getCurrentNick = () => currentNick;
  _resolveKapaniReady();
} catch(e) { console.error('[Kapani exports]', e); }


})().catch(error=>{console.error('[Kapani bootstrap]',error);window.kapaniShowBootError?.('Ошибка запуска сайта',error?.message);});
