/* Generated from supabase-bridge.js for file:// and HTTPS script loading. */
(function(){
'use strict';
try {
// Supabase compatibility layer for the original Firebase-style tree API.
// No Firebase SDK or privileged Supabase service-role key is used in the browser.
const createClient = window.supabase?.createClient;
if (typeof createClient !== 'function') throw new Error('Supabase SDK could not be loaded');
const config = globalThis.KAPANI_CONFIG?.supabase || {};
if (!config.url || !config.anonKey) {
  throw new Error('Заполните supabase.url и supabase.anonKey в config.js');
}

// Supabase Auth v2.49.8 sometimes requests the same Navigator Lock with a
// zero-millisecond timeout while another auth operation holds it. Waiting in
// the browser's native queue avoids a spurious unhandled rejection without
// disabling cross-tab session safety.
async function authSessionLock(name, timeout, callback) {
  if (!globalThis.navigator?.locks?.request) return callback();
  const controller = new AbortController();
  const waitMs = Number.isFinite(timeout) && timeout > 0 ? Math.max(1500, timeout) : 10000;
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    return await navigator.locks.request(name, {
      mode: 'exclusive', signal: controller.signal
    }, () => {
      clearTimeout(timer);
      return callback();
    });
  } finally {
    clearTimeout(timer);
  }
}

const supabase = createClient(config.url, config.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    lock: authSessionLock
  }
});
const db = { kind: 'supabase-tree' };
const watchers = new Map();
const rootChannels = new Map();
const normalized = path => String(path || '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
const branchOf = path => normalized(path).split('/')[0] || '';
const idPart = () => Math.random().toString(36).slice(2, 12);
const newKey = () => `-${Date.now().toString(36)}${idPart()}${idPart()}`;

function ref(_db, path = '') {
  const normalizedPath = normalized(path);
  return { path: normalizedPath, key: normalizedPath.split('/').at(-1) || null };
}
function serverTimestamp() { return Date.now(); }

class TreeSnapshot {
  constructor(reference, value, revision = 0) {
    this.ref = reference;
    this.key = reference.key;
    this._value = value ?? null;
    this.revision = revision;
  }
  val() { return this._value; }
  exists() { return this._value !== null && this._value !== undefined; }
  forEach(callback) {
    if (!this._value || typeof this._value !== 'object') return false;
    for (const [key, value] of Object.entries(this._value)) {
      if (callback(new TreeSnapshot(ref(db, `${this.ref.path}/${key}`), value)) === true) return true;
    }
    return false;
  }
  child(path) {
    const keys = normalized(path).split('/');
    let value = this._value;
    for (const key of keys) value = value?.[key];
    return new TreeSnapshot(ref(db, `${this.ref.path}/${normalized(path)}`), value);
  }
}

function applyFilters(source, options = []) {
  if (!options.length || !source || typeof source !== 'object') return source;
  let entries = Object.entries(source);
  const by = options.find(x => x.type === 'order')?.name;
  const eq = options.find(x => x.type === 'equal');
  if (eq) entries = entries.filter(([key, value]) => (by === '$key' ? key : value?.[by]) === eq.value);
  if (by) entries.sort((a, b) => {
    const va = by === '$key' ? a[0] : a[1]?.[by];
    const vb = by === '$key' ? b[0] : b[1]?.[by];
    return va === vb ? a[0].localeCompare(b[0]) : va == null ? -1 : vb == null ? 1 : va < vb ? -1 : 1;
  });
  const last = options.find(x => x.type === 'limitLast');
  if (last) entries = entries.slice(-last.count);
  return Object.fromEntries(entries);
}

const query = (r, ...options) => ({ ...r, queryOptions: options });
const orderByChild = name => ({ type: 'order', name });
const equalTo = value => ({ type: 'equal', value });
const limitToLast = count => ({ type: 'limitLast', count });

async function treeCall(operation, r, payload = null, expected = null) {
  const { data, error } = await supabase.rpc('kp_tree_access', {
    p_operation: operation,
    p_path: r.path,
    p_payload: payload,
    p_expected_revision: expected
  });
  if (error) throw new Error(error.message || 'Supabase: ошибка базы данных');
  return data || {};
}

async function get(reference) {
  const result = await treeCall('read', reference);
  return new TreeSnapshot(reference, applyFilters(result.value ?? null, reference.queryOptions), result.revision);
}

async function mutate(operation, reference, value, expected = null) {
  const result = await treeCall(operation, reference, value, expected);
  if (result.conflict) return result;
  notifyLocal(branchOf(reference.path));
  return result;
}

async function secureRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'Операция на сервере не выполнена');
  notifyLocal('users');
  return data;
}

// Only the authenticated user may edit an allowlisted part of their profile.
// This deliberately never accepts balance, rewards, roles, or subscription flags.
const patchOwnProfile = changes => secureRpc('kp_profile_patch', { p_patch: changes });
const manageOwnNotifications = (action, notificationId = null) =>
  secureRpc('kp_manage_notifications', { p_action: action, p_notification_id: notificationId });
const claimVerifiedTask = (kind, taskId) =>
  secureRpc('kp_claim_task', { p_kind: kind, p_task_id: taskId });
const withdrawVerifiedTasks = amount =>
  secureRpc('kp_withdraw_tasks', { p_amount: amount });

async function set(reference, value) { return mutate('set', reference, value); }
async function remove(reference) { return mutate('remove', reference); }
async function update(reference, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('update ожидает объект');
  // Legacy Firebase updated users/<nick> with a flat object. The old SQL
  // correctly refuses whole-record writes; send normal profile edits to an
  // owner-only, field-by-field validated server procedure instead.
  if (/^users\/[^/]+$/.test(reference.path) && !Object.keys(changes).some(key => key.includes('/'))) {
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    if (userError || !userResult?.user) throw new Error('Сначала войдите в аккаунт');
    const { data: ownProfile, error: profileError } = await supabase.from('kp_profiles')
      .select('nickname').eq('user_id', userResult.user.id).maybeSingle();
    if (profileError || ownProfile?.nickname !== reference.path.slice(6))
      throw new Error('Нельзя изменять чужой профиль');
    return patchOwnProfile(changes);
  }
  // Firebase supports slash-separated update keys and null-as-delete.
  const changesWithPaths = Object.entries(changes).filter(([key]) => key.includes('/') || !reference.path);
  if (changesWithPaths.length) {
    for (const [key, value] of Object.entries(changes)) {
      const childRef = ref(db, [reference.path, key].filter(Boolean).join('/'));
      if (value === null) await remove(childRef);
      else await set(childRef, value);
    }
    return;
  }
  return mutate('update', reference, changes);
}

function push(reference, value) {
  const child = ref(db, [reference.path, newKey()].filter(Boolean).join('/'));
  if (arguments.length < 2) return child;
  return set(child, value).then(() => child);
}

async function runTransaction(reference, updater) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const previous = await get(reference);
    const updated = updater(structuredClone(previous.val()));
    if (updated === undefined) return { committed: false, snapshot: previous };
    const answer = await mutate('set', reference, updated, previous.revision);
    if (!answer.conflict) return { committed: true, snapshot: new TreeSnapshot(reference, updated, answer.revision) };
  }
  throw new Error('Слишком много одновременных изменений. Повторите действие.');
}

// Supabase Realtime broadcasts only root revision numbers. It never exposes
// private tree JSON to all subscribed users.
function notifyLocal(branch) {
  const channel = rootChannels.get(branch);
  if (channel) channel.refresh();
}
function channelFor(branch) {
  let existing = rootChannels.get(branch);
  if (existing) return existing;
  const channel = supabase.channel(`kapani-tree-${branch}`);
  let pending = false;
  existing = {
    count: 0,
    channel,
    refresh() {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        for (const entry of watchers.values()) {
          if (branchOf(entry.reference.path) !== branch) continue;
          get(entry.reference).then(entry.callback).catch(entry.onError);
        }
      });
    }
  };
  channel.on('postgres_changes', {
    event: '*', schema: 'public', table: 'kp_tree_revisions', filter: `branch=eq.${branch}`
  }, () => existing.refresh()).subscribe();
  rootChannels.set(branch, existing);
  return existing;
}
function onValue(reference, callback, onError = console.error) {
  const key = Symbol(reference.path);
  const branch = branchOf(reference.path);
  const root = channelFor(branch);
  root.count++;
  watchers.set(key, { reference, callback, onError });
  get(reference).then(s => { if (watchers.has(key)) callback(s); }).catch(onError);
  return () => {
    watchers.delete(key);
    root.count--;
    if (root.count <= 0) {
      supabase.removeChannel(root.channel);
      rootChannels.delete(branch);
    }
  };
}
function off(reference, _type, callback) {
  for (const [id, item] of watchers) {
    if (item.reference.path === reference.path && (!callback || callback === item.callback)) {
      watchers.delete(id);
      const root = rootChannels.get(branchOf(reference.path));
      if (root && --root.count <= 0) {
        supabase.removeChannel(root.channel);
        rootChannels.delete(branchOf(reference.path));
      }
    }
  }
}
function onDisconnect(reference) {
  // This compatibility hook is best-effort. The server heartbeat is authoritative.
  let intended;
  const handler = () => { if (intended !== undefined) void set(reference, intended).catch(() => {}); };
  return {
    async set(value) {
      intended = value;
      window.addEventListener('pagehide', handler, { once: true });
    },
    async cancel() {
      intended = undefined;
      window.removeEventListener('pagehide', handler);
    }
  };
}

const authEmail = async nick => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(nick).normalize('NFC')));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `u${hex.slice(0, 48)}@users.kapani.invalid`;
};

window.KAPANI_BRIDGE = {supabase,db,ref,set,get,update,push,remove,onValue,off,serverTimestamp,runTransaction,query,orderByChild,equalTo,limitToLast,onDisconnect,authEmail,patchOwnProfile,manageOwnNotifications,claimVerifiedTask,withdrawVerifiedTasks};
} catch (error) { console.error('[Kapani bridge]',error); window.kapaniShowBootError?.('Не удалось подключить Supabase',error?.message); }
})();
