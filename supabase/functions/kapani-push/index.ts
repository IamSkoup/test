// Deploy as a Supabase Edge Function with JWT verification enabled.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' }
});
const projectUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const vapidSubject = Deno.env.get('VAPID_SUBJECT') || '';
const configured = !!(vapidPublic && vapidPrivate && /^mailto:[^@\s]+@[^@\s]+$/.test(vapidSubject));
const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false } });
if (configured) webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null };
const toNick = (s: unknown) => String(s || '').trim().slice(0, 120);
const categoryOf = (s: unknown) => String(s || 'system').slice(0, 40);
const hasAllowedPushHost = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|.*\.push\.apple\.com|.*\.notify\.windows\.com|.*\.push\.services\.mozilla\.com)$/i.test(url.hostname);
  } catch { return false; }
};

async function currentUser(req: Request) {
  const token = /^Bearer (.+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await admin.from('kp_profiles').select('nickname').eq('user_id', data.user.id).maybeSingle();
  return profile?.nickname ? { id: data.user.id, nick: profile.nickname } : null;
}
async function getTarget(nick: string) {
  const { data } = await admin.from('kp_profiles').select('user_id').eq('nickname', nick).maybeSingle();
  return data?.user_id || null;
}

async function registerAccount(request: Request, body: Record<string, unknown>) {
  const nick = toNick(body.nick);
  const password = String(body.password || '');
  if (nick.length < 3 || nick.length > 30 || !/^[\p{L}\p{N}_ -]+$/u.test(nick))
    return json({ error:'Ник должен содержать от 3 до 30 букв, цифр, пробелов или подчёркиваний' },400);
  if (password.length < 8 || password.length > 128) return json({ error:'Пароль должен быть длиной от 8 до 128 символов' },400);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const fingerprint = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));
  const ipHash = [...new Uint8Array(fingerprint)].map(n=>n.toString(16).padStart(2,'0')).join('');
  const since = new Date(Date.now()-60*60*1000).toISOString();
  const { count } = await admin.from('kp_signup_attempts').select('id',{count:'exact',head:true})
    .eq('ip_hash',ipHash).gte('attempted_at',since);
  if ((count || 0) >= 5) return json({ error:'Слишком много регистраций. Повторите позже.' },429);
  await admin.from('kp_signup_attempts').insert({ip_hash:ipHash});
  const { data: existing } = await admin.from('kp_profiles').select('user_id').eq('nickname',nick).maybeSingle();
  if (existing) return json({ error:'Такое имя уже занято' },409);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nick.normalize('NFC')));
  const hex = [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const email = `u${hex.slice(0,48)}@users.kapani.invalid`;
  const created = await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{nick}});
  if (created.error || !created.data.user) return json({ error:created.error?.message || 'Не удалось создать аккаунт' },400);
  const userId = created.data.user.id;
  try {
    const profile = await admin.from('kp_profiles').insert({user_id:userId,nickname:nick});
    if (profile.error) throw profile.error;
    const wallet = await admin.from('kp_wallets').insert({user_id:userId});
    if (wallet.error) throw wallet.error;
    const boot = await admin.rpc('kp_tree_bootstrap_user',{
      p_nick:nick,p_profile:{...(body.profile as Record<string,unknown> || {}),nick}
    });
    if (boot.error || !boot.data) throw boot.error || new Error('Profile initialization failed');
    return json({ ok:true,created:true,nick });
  } catch(error) {
    await admin.auth.admin.deleteUser(userId);
    return json({ error:String((error as Error).message || error).slice(0,250) },500);
  }
}

async function sendTo(nick: string, data: Record<string, unknown>) {
  const userId = await getTarget(nick);
  if (!userId) return { sent: 0, devices: 0, reason: 'recipient not registered' };
  const { data: devices, error } = await admin.from('kp_push_devices')
    .select('subscription_id,subscription,prefs').eq('user_id', userId);
  if (error) throw error;
  if (!configured) return { sent: 0, devices: devices?.length || 0, reason: 'VAPID keys not configured' };
  let sent = 0;
  let skipped = 0;
  const statuses: unknown[] = [];
  for (const device of (devices || []).slice(0, 5)) {
    const prefs = device.prefs || {};
    if (prefs.enabled === false || prefs[String(data.category || 'system')] === false) { skipped++; continue; }
    try {
      await webpush.sendNotification(device.subscription as Sub, JSON.stringify(data), { TTL: 24 * 3600 });
      sent++;
      statuses.push({ id: device.subscription_id, status: 201 });
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode || 0);
      if (status === 404 || status === 410) {
        await admin.from('kp_push_devices').delete().eq('subscription_id', device.subscription_id);
      }
      statuses.push({ id: device.subscription_id, status, error: String(error).slice(0, 120) });
    }
  }
  return { sent, skipped, devices: devices?.length || 0, statuses };
}

async function notify(from: { id: string; nick: string }, body: Record<string, unknown>) {
  const targetNick = toNick(body.targetNick || body.to);
  const message = String(body.text || body.body || '').trim().slice(0, 2000);
  if (!targetNick || !message) return json({ error: 'Recipient and text required' }, 400);
  if (!await getTarget(targetNick)) return json({ error: 'Recipient not found' }, 404);
  const category = categoryOf(body.category);
  const notificationId = /^[A-Za-z0-9_-]{5,100}$/.test(String(body.notificationId || ''))
    ? String(body.notificationId) : crypto.randomUUID();
  const createdAt = Date.now();
  const record = {
    text: message,
    title: String(body.title || 'Капани').slice(0, 120),
    category, cat: category,
    source: String(body.source || '').slice(0, 80),
    from: from.nick,
    sourceMessageId: String(body.sourceMessageId || '').slice(0, 120),
    url: String(body.url || '/kapani/').slice(0, 500),
    createdAt,
    time: new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit' }).format(createdAt)
  };
  const { data, error } = await admin.rpc('kp_tree_push_notification', { p_nick:targetNick, p_id:notificationId, p_record:record });
  if (error || !data) return json({ error: error?.message || 'Inbox storage failed' }, 500);
  const push = await sendTo(targetNick, {
    title:record.title,body:message,category,notificationId,url:record.url,
    source:record.source,createdAt
  });
  return json({ ok:true, notificationId, ...push });
}

async function chatFanout(from: { id: string; nick: string }, body: Record<string, unknown>) {
  const job = (body.job || {}) as Record<string, unknown>;
  if (job.type !== 'chat') return json({ ok:true, sent:0, reason:'unsupported event type' });
  const messageId = String(job.id || '');
  const { data: root } = await admin.from('kp_tree_roots').select('document').eq('branch','chat').maybeSingle();
  const message = root?.document?.[messageId];
  if (!message || message.nick !== from.nick) return json({ error:'Chat author mismatch' }, 403);
  const preview = String(message.text || '').slice(0, 100) ||
    ({ video:'Видео', image:'Фото', voice:'Голосовое', video_circle:'Видеосообщение' }[message.msgType as string] || 'Новое сообщение');
  const { data: recipients } = await admin.from('kp_profiles').select('nickname').neq('user_id', from.id).limit(200);
  let sent = 0;
  for (const recipient of recipients || []) {
    const noticeId = crypto.randomUUID();
    const payload = { text:`${from.nick}: ${preview}`,title:'Общий чат',cat:'messages',source:'general_chat',
      createdAt:Date.now(),url:'/kapani/?kpSection=messages' };
    await admin.rpc('kp_tree_push_notification',{p_nick:recipient.nickname,p_id:noticeId,p_record:payload});
    const result = await sendTo(recipient.nickname,{...payload,body:payload.text,category:'messages',notificationId:noticeId});
    sent += result.sent;
  }
  return json({ ok:true,sent });
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status:204,headers:cors });
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) || '';
  if (action === 'health') return json({ ok:true,backend:'supabase',vapid:configured,pairOk:configured });
  if (action === 'register') {
    if (request.method !== 'POST') return json({ error:'Use POST' },405);
    const payload=await request.json().catch(()=>null);
    if (!payload || typeof payload !== 'object') return json({ error:'Bad JSON' },400);
    return await registerAccount(request,payload);
  }
  const caller = await currentUser(request);
  if (!caller) return json({ error:'Unauthorized Supabase session' }, 401);
  if (request.method !== 'POST') return json({ error:'Use POST' }, 405);
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== 'object') return json({ error:'Bad JSON' }, 400);
  const object = body as Record<string, unknown>;
  try {
    if (action === 'subscribe') {
      const subscription = object.subscription as Sub;
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth ||
          !hasAllowedPushHost(subscription.endpoint)) return json({ error:'Invalid push subscription' }, 400);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
      const id = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,'0')).join('').slice(0,32);
      const { error } = await admin.from('kp_push_devices').upsert({
        subscription_id:id,user_id:caller.id,endpoint:subscription.endpoint,
        subscription,prefs:object.prefs || {},user_agent:String(object.userAgent || '').slice(0,250),updated_at:new Date().toISOString()
      });
      if (error) throw error;
      return json({ ok:true,success:true,subscriptionId:id });
    }
    if (action === 'unsubscribe') {
      await admin.from('kp_push_devices').delete().eq('subscription_id',String(object.subscriptionId||'')).eq('user_id',caller.id);
      return json({ ok:true,success:true });
    }
    if (action === 'prefs') {
      await admin.from('kp_push_devices').update({prefs:object.prefs||{}})
        .eq('subscription_id',String(object.subscriptionId||'')).eq('user_id',caller.id);
      return json({ ok:true,success:true });
    }
    if (action === 'notify') return await notify(caller,object);
    if (action === 'event') return await chatFanout(caller,object);
    if (action === 'test') {
      const result = await sendTo(caller.nick,{
        title:'Капани — проверка Push',body:'Тестовое уведомление доставлено',category:'system',
        notificationId:crypto.randomUUID(),url:'/kapani/',createdAt:Date.now()
      });
      return json({ ok:true,...result });
    }
    if (action === 'debug') {
      const { count } = await admin.from('kp_push_devices').select('subscription_id',{count:'exact',head:true}).eq('user_id',caller.id);
      return json({ ok:true,yourDevices:count || 0,diagnosis:{hint:configured?'VAPID configured':'Set VAPID secrets'} });
    }
    return json({ error:'Unknown action' },404);
  } catch (error) {
    console.error('[kapani-push]',error);
    return json({ error:String((error as Error)?.message||error).slice(0,280) },500);
  }
});
