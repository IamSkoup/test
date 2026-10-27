/* Kapani Pack v2 — no file:// module fetches. */
(function(){
'use strict';

// Reuses the main module's already-initialized Firebase primitives instead of
// importing a second copy of the SDK (previously: a separate, differently
// versioned firebase-database.js fetched and initialized independently —
// duplicate network request + duplicate SDK instance for no benefit).
// Waits on the deterministic window.KAPANI_READY promise instead of polling
// window.db every 250ms.
async function ready(cb){
  if(window.KAPANI_READY && typeof window.KAPANI_READY.then === 'function'){
    await window.KAPANI_READY;
  } else {
    // Extremely defensive fallback if the bootstrap promise is somehow missing.
    await new Promise(res => {
      const start = Date.now();
      (function poll(){
        if(window.db && typeof window.qs === 'function' && typeof window._getCurrentNick === 'function') return res();
        if(Date.now() - start >= 15000){ console.error('[Kapani Pack] Основной клиентский модуль не предоставил API за 15 секунд'); return res(); }
        setTimeout(poll, 250);
      })();
    });
  }
  cb();
}

ready(function(){
  const db = window.db;
  const ref = window.dbRef, get = window.dbGet, set = window.dbSet, update = window.dbUpdate,
        remove = window.dbRemove, push = window.dbPush, onValue = window.dbOnValue, off = window.dbOff;
  const ADMIN = window.ADMIN || 'Кайон';
  const qs = window.qs;
  const toast = window.toast || ((m)=>alert(m));
  const escHtml = window.escHtml || ((s)=>String(s==null?'':s));
  const jsEsc = window.jsEsc || escHtml;
  const userRef = window.userRef || ((n)=>ref(db,`users/${n}`));
  const pushNotification = window.pushNotification || (async()=>{});
  const collectEmploymentsFromData = window.collectEmploymentsFromData;
  const hasMunicipalJob = window.hasMunicipalJob || (()=>false);
  const renderProfile = window.renderProfile || (()=>{});
  const findUserByPublicName = window.findUserByPublicName || (async(name)=>{
    // Fallback: direct lookup by nick if the main app's helper isn't exposed
    try { const s = await get(userRef(name)); return s.exists() ? { nick: name, ...s.val() } : null; } catch(e){ return null; }
  });
  const logTx = window.logTx || (async()=>{});
  const txLogRef = window.txLogRef || ((nick)=>ref(db,`users/${nick}/txlog`));
  // Pack v2 must not depend on a module-scoped helper from the main ES module.
  // Keep a local, self-contained timestamp helper with the same output shape.
  const packFullDateTimeStr = (typeof window.fullDateTimeStr === 'function')
    ? window.fullDateTimeStr
    : (()=>{ const d=new Date(); return { date:d.toLocaleDateString('ru'), time:d.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}), ts:d.toISOString() }; });
  const bizItemRef = window.bizItemRef || ((id)=>ref(db, `businesses/${id}`));
  const JOB_JANITOR = window.JOB_JANITOR || 'Уборщик';
  const JOB_ADVERTISER = window.JOB_ADVERTISER || 'Рекламщик';
  const ADVERTISER_KVE_REQUIRED = Number(window.ADVERTISER_KVE_REQUIRED || 50);

  // ── KVE: Полицейский = 80
  try {
    if(window.KVE_JOB_REQUIREMENTS) { window.KVE_JOB_REQUIREMENTS['Полицейский'] = 80; window.KVE_JOB_REQUIREMENTS[JOB_ADVERTISER] = ADVERTISER_KVE_REQUIRED; }
    if(window.KVE_REQUIREMENTS) { window.KVE_REQUIREMENTS['Полицейский'] = 80; window.KVE_REQUIREMENTS[JOB_ADVERTISER] = ADVERTISER_KVE_REQUIRED; }
  } catch(e) {}

  // ── Firebase paths for new features
  const policeReqRef = (id) => ref(db, id ? `policeRequests/${id}` : 'policeRequests');
  const marketRentRef = (id) => ref(db, id ? `marketRentals/${id}` : 'marketRentals');
  const passportRef = (nick) => ref(db, `users/${nick}/passport`);
  const licenseRef = (nick) => ref(db, `licenses/${nick}`);

  // ═══════════════════════════════════════════
  // 1) FIX: proper job dismissal (mayor + self)
  // ═══════════════════════════════════════════
  function clearJobSideEffects(role, u){
    const patch = {};
    if(role === 'Водитель' || role === 'Доставщик') patch.vehicle = '';
    if(role === JOB_ADVERTISER) patch.advertiserSalaryPaidThroughWeek = (window.advertiserWeekKey ? window.advertiserWeekKey() : new Date().toLocaleDateString('sv-SE'));
    if(role === JOB_JANITOR){
      patch.janitorTaskDate=''; patch.janitorSubmissionId='';
      patch.janitorSubmissionStatus=''; patch.janitorProof=''; patch.janitorComment='';
    }
    return patch;
  }

  // quitJob: master implementation is defined in the main app block above — no override needed here
  const _origQuitJob = null; // kept for reference only

  // adminFireWorker: master implementation is in the main app block — no override needed

  // ═══════════════════════════════════════════
  // 2) ELECTRONIC PASSPORT (profile)
  // ═══════════════════════════════════════════
  function injectPassportUI(){ /* no-op: buttons теперь в самом HTML профиля */ }
  function renderPassportCard(){ /* no-op */ }

  // Modal-based form для заполнения паспорта
  window.fillPassportForm = async function(){
    const nick = window.currentNick;
    if(!nick) return toast('⚠️ Сначала войдите','gold');
    let existing = {};
    try {
      const pSnap = await get(ref(db, `passports/${nick}`));
      if(pSnap.exists()) existing = pSnap.val();
      else {
        const snap = await get(userRef(nick));
        if(snap.exists()) existing = snap.val().passport || {};
      }
    } catch(e){ console.warn('[passport] get failed', e); }

    const old = document.getElementById('passportFormModal'); if(old) old.remove();
    const m = document.createElement('div');
    m.id = 'passportFormModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9997;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.onclick = (e)=>{ if(e.target===m) m.remove(); };
    m.innerHTML = `
      <div style="width:100%;max-width:380px;background:linear-gradient(160deg,#16242a,#0e1620);border:1px solid rgba(240,68,74,.4);border-radius:22px;padding:20px;box-shadow:0 12px 60px rgba(0,0,0,.7);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div style="font-family:'Unbounded',sans-serif;font-size:16px;font-weight:900;color:var(--primary);">📝 Данные паспорта</div>
          <button class="btn btn-ghost btn-sm" style="width:auto;padding:6px 10px;" onclick="this.closest('#passportFormModal').remove()">✕</button>
        </div>
        <input type="text" id="ppFirstName" placeholder="Имя" maxlength="40" value="${escHtml(existing.firstName||'')}" style="font-size:16px;">
        <input type="text" id="ppLastName" placeholder="Фамилия" maxlength="40" value="${escHtml(existing.lastName||'')}" style="font-size:16px;">
        <input type="date" id="ppDob" value="${escHtml(existing.dob||'')}" style="font-size:16px;">
        <button class="btn btn-primary" onclick="savePassport()" style="margin-top:8px;width:100%;">💾 Сохранить</button>
      </div>`;
    document.body.appendChild(m);
    setTimeout(()=>{ try{ document.getElementById('ppFirstName')?.focus(); }catch(e){} }, 60);
  };

  window.savePassport = async function(){
    const fn = document.getElementById('ppFirstName')?.value.trim();
    const ln = document.getElementById('ppLastName')?.value.trim();
    const dob = document.getElementById('ppDob')?.value.trim();
    if(!fn || !ln || !dob) return toast('⚠️ Заполните все поля','gold');
    const nick = window.currentNick;
    if(!nick) return toast('⚠️ Сначала войдите','gold');
    try {
      // Passports are private. A signed-in user may edit only their own record.
      const {error} = await window.kapaniSupabase.rpc('kp_save_passport', {
        p_first_name: fn, p_last_name: ln, p_dob: dob
      });
      if(error) throw new Error(error.message || 'Не удалось записать паспорт');
      toast('✅ Паспорт сохранён','green');
      document.getElementById('passportFormModal')?.remove();
    } catch(error){
      console.error('[savePassport]',error);
      toast('❌ Ошибка сохранения: '+(error.message||'сервер недоступен'),'red');
    }
  };


  window.openPassport = async function(targetNick){
    const viewerNick = window.currentNick;
    const nick = targetNick || viewerNick;
    if(!nick) return toast('⚠️ Сначала войдите','gold');
    const isOwn = nick === viewerNick;
    // Показываем модалку сразу со скелетом — без бесконечной загрузки
    const old = document.getElementById('passportModal'); if(old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'passportModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9996;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.onclick = (e)=>{ if(e.target===modal) modal.remove(); };
    modal.innerHTML = `
      <div style="width:100%;max-width:420px;background:linear-gradient(160deg,#16242a,#0e1620);border:1px solid rgba(240,68,74,.4);border-radius:24px;padding:22px;box-shadow:0 12px 60px rgba(0,0,0,.7);max-height:92vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div style="font-family:'Unbounded',sans-serif;font-size:18px;font-weight:900;color:var(--primary);">🪪 Паспорт Капани${isOwn?'':' — '+escHtml(nick)}</div>
          <button class="btn btn-ghost btn-sm" style="width:auto;padding:6px 10px;" onclick="this.closest('#passportModal').remove()">✕</button>
        </div>
        <div id="passportModalBody" style="font-size:13px;color:var(--muted);text-align:center;padding:20px 0;">Загрузка…</div>
      </div>`;
    document.body.appendChild(modal);

    let u = null;
    let passportData = null;
    try {
      const [snap, pSnap, lSnap] = await Promise.race([
        Promise.all([ get(userRef(nick)), get(ref(db, `passports/${nick}`)), get(ref(db, `licenses/${nick}`)) ]),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 8000))
      ]);
      if(!snap || !snap.exists()){
        const body = document.getElementById('passportModalBody');
        if(body) body.innerHTML = '<div style="color:var(--red);">Не удалось загрузить данные пользователя.</div>';
        return;
      }
      u = snap.val();
      passportData = (pSnap && pSnap.exists()) ? pSnap.val() : (u.passport || null);
      u._licenses = { ...(u.licenses || {}), ...((lSnap && lSnap.exists()) ? (lSnap.val() || {}) : {}) };

    } catch(e){
      console.error('[openPassport]', e);
      const body = document.getElementById('passportModalBody');
      if(body) body.innerHTML = `<div style="color:var(--red);">Ошибка загрузки: ${escHtml(e.message||'нет связи')}</div><button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="openPassport('${jsEsc(nick)}')">🔄 Повторить</button>`;
      return;
    }

    const p = passportData || {};
    const body = document.getElementById('passportModalBody');
    if(!body) return;



    if(!p.firstName || !p.lastName || !p.dob){
      body.style.textAlign = 'left';
      body.innerHTML = isOwn ? `
        <div style="color:var(--text);margin-bottom:12px;">Паспорт ещё не оформлен. Заполните данные:</div>
        <button class="btn btn-primary" style="width:100%;" onclick="document.getElementById('passportModal').remove();fillPassportForm();">📝 Заполнить паспорт</button>
      ` : `
        <div style="color:var(--text);">У этого жителя паспорт ещё не оформлен.</div>
      `;
      return;
    }

    const emps = (collectEmploymentsFromData ? collectEmploymentsFromData(u, nick) : (u.employments||[]));
    const jobsList = emps.length ? emps.map(e=>escHtml(e.role)).join(', ') : '—';
    const lic = u._licenses || u.licenses || {};
    const bike = lic.bike ? '✅ Есть' : '❌ Нет';
    const scooter = lic.scooter ? '✅ Есть' : '❌ Нет';
    const createdStr = u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—';
    const siteNick = (u && u.displayName && String(u.displayName).trim()) || (u && u.name && String(u.name).trim()) || '—';
    body.style.textAlign = 'left';
    body.style.color = 'var(--text)';
    body.innerHTML = `
      <div style="background:rgba(240,68,74,.06);border:1px solid rgba(240,68,74,.25);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5;">
        <div><span style="color:var(--muted);">Имя:</span> <b>${escHtml(p.firstName)}</b></div>
        <div><span style="color:var(--muted);">Фамилия:</span> <b>${escHtml(p.lastName)}</b></div>
        <div><span style="color:var(--muted);">Никнейм на сайте:</span> <b style="color:var(--primary);">${escHtml(siteNick)}</b></div>
        <div><span style="color:var(--muted);">Дата рождения:</span> <b>${escHtml(p.dob)}</b></div>
        <div><span style="color:var(--muted);">Аккаунт создан:</span> <b>${createdStr}</b></div>
        <div><span style="color:var(--muted);">Текущие работы:</span> <b>${jobsList}</b></div>
        <div style="border-top:1px dashed rgba(255,255,255,.08);padding-top:10px;margin-top:4px;">
          <div><span style="color:var(--muted);">🚲 В.У. на велосипед:</span> <b style="color:${lic.bike?'#22c55e':'var(--red)'};">${bike}</b></div>
          <div style="margin-top:4px;"><span style="color:var(--muted);">🛵 В.У. на скутер:</span> <b style="color:${lic.scooter?'#22c55e':'var(--red)'};">${scooter}</b></div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted);text-align:center;margin-top:12px;">Документ выдан мэрией Капани</div>
      ${isOwn ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%;" onclick="document.getElementById('passportModal').remove();fillPassportForm();">✏️ Изменить данные</button>` : ''}
    `;
  };



  // ═══════════════════════════════════════════
  // 3) MAYOR: licenses + per-user job control
  // ═══════════════════════════════════════════
  function ensureAdminPoliceListener(){
    if(window.__kapaniAdminPoliceListener || !qs('adminPoliceReqs')) return;
    const pRef = policeReqRef();
    const pFn = snap=>{ if(window._kapaniActivePage === 'adminPage') renderAdminPoliceReqs(snap.val()||{}); };
    onValue(pRef, pFn);
    window.__kapaniAdminPoliceListener = {ref:pRef, fn:pFn};
  }

  function injectAdminUI(){
    if(window._getCurrentNick?.() !== ADMIN) return;
    const adminPage = qs('adminPage'); if(!adminPage) return;
    if(qs('adminLicensesCard')){ ensureAdminPoliceListener(); _bindAdminTarget(); return; }
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'adminLicensesCard';
    card.style.cssText = 'border-color:rgba(240,68,74,.25);background:rgba(240,68,74,.04);';
    card.innerHTML = `
      <div class="card-title" style="color:var(--primary);">🪪 Водительские удостоверения</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Выдайте или изымите права у выбранного выше жителя (поле «Управление балансом»).</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button class="btn btn-primary btn-sm" onclick="adminGrantLicense('bike')">🚲 Выдать на велосипед</button>
        <button class="btn btn-red btn-sm" onclick="adminRevokeLicense('bike')">🚲 Изъять</button>
        <button class="btn btn-primary btn-sm" onclick="adminGrantLicense('scooter')">🛵 Выдать на скутер</button>
        <button class="btn btn-red btn-sm" onclick="adminRevokeLicense('scooter')">🛵 Изъять</button>
      </div>
      <div id="adminLicenseStatus" style="margin-top:10px;font-size:12px;color:var(--muted);"></div>
    `;
    // Insert after balance card (find by KVE card)
    const kveCard = adminPage.querySelector('select#kveTarget')?.closest('.card');
    if(kveCard && kveCard.parentNode) kveCard.parentNode.insertBefore(card, kveCard.nextSibling);
    else adminPage.appendChild(card);

    _bindAdminTarget();

    // Police requests card
    if(!qs('adminPoliceReqs')){
      const pcard = document.createElement('div');
      pcard.className = 'card';
      pcard.style.cssText = 'border-color:rgba(59,130,246,.25);';
      pcard.innerHTML = `
        <div class="card-title" style="color:#60a5fa;">👮 Запросы от полиции</div>
        <div id="adminPoliceReqs"><div style="color:var(--muted);font-size:13px;">Нет запросов</div></div>
      `;
      adminPage.appendChild(pcard);
      ensureAdminPoliceListener();
    }
  }

  async function showAdminLicenseStatus(target){
    const el = qs('adminLicenseStatus'); if(!el) return;
    try {
      const {data:l,error}=await window.KAPANI_BRIDGE.supabase.rpc('kp_license_status',{p_target:target});
      if(error)throw error;
      el.innerHTML = `<b>${escHtml(target)}</b> · 🚲 ${l.bike?'✅':'❌'} · 🛵 ${l.scooter?'✅':'❌'}`;
    } catch(e){ el.innerHTML = `<span style="color:var(--red);">Ошибка: ${escHtml(e.message||e.code||'')}</span>`; }
  }

  async function writeLicense(target, patch){
    const kind = Object.keys(patch).find(k=>k==='bike'||k==='scooter');
    if(!kind)throw new Error('Неверная категория прав');
    const {error}=await window.KAPANI_BRIDGE.supabase.rpc('kp_mayor_update_resident',{
      p_target:target,p_action:'license',p_value:{kind,enabled:!!patch[kind]}
    });
    if(error)throw error;
  }

  window.adminGrantLicense = async function(kind){
    if(window.currentNick !== ADMIN) return toast('🚫 Только мэр','red');
    const target = qs('adminTarget')?.value; if(!target) return toast('⚠️ Выберите жителя','gold');
    try {
      await writeLicense(target, { [kind]: true, [kind+'IssuedAt']: Date.now() });
      await pushNotification(target, `✅ Мэрия выдала вам ${kind==='bike'?'права на велосипед 🚲':'права на скутер 🛵'}`,'system');
      toast(`✅ ${target} получил права`,'green');
      showAdminLicenseStatus(target);
    } catch(e){ toast('❌ ' + (e.message||e.code||'Ошибка'),'red'); }
  };
  window.adminRevokeLicense = async function(kind){
    if(window.currentNick !== ADMIN) return toast('🚫 Только мэр','red');
    const target = qs('adminTarget')?.value; if(!target) return toast('⚠️ Выберите жителя','gold');
    try {
      await writeLicense(target, { [kind]: false });
      await pushNotification(target, `❌ Мэрия изъяла ваши ${kind==='bike'?'права на велосипед 🚲':'права на скутер 🛵'}`,'system');
      toast(`🚫 У ${target} изъяты права`,'gold');
      showAdminLicenseStatus(target);
    } catch(e){ toast('❌ ' + (e.message||e.code||'Ошибка'),'red'); }
  };


  // React when admin changes target
  const _bindAdminTarget = () => {
    const sel = qs('adminTarget'); if(!sel || sel._licBound) return;
    sel._licBound = true;
    sel.addEventListener('change', ()=>{ if(sel.value) showAdminLicenseStatus(sel.value); });
  };

  // ═══════════════════════════════════════════
  // 3b) КСБ / ПОЛИЦИЯ: просмотр паспорта и выдача прав любому жителю
  // ═══════════════════════════════════════════
  async function ksbCheckAccess(){
    const myNick = window.currentNick;
    if(!myNick) { toast('❌ Не авторизован','red'); return null; }
    const meSnap = await get(userRef(myNick));
    if(!meSnap.exists()) { toast('❌ Профиль не найден','red'); return null; }
    const me = meSnap.val();
    const isKsb = hasMunicipalJob(me,'КСБ') || me.job==='КСБ';
    const isPolice = hasMunicipalJob(me,'Полицейский') || me.job==='Полицейский';
    const isAdmin = myNick === ADMIN;
    if(!isKsb && !isPolice && !isAdmin) { toast('🚫 Доступно только КСБ и полиции','red'); return null; }
    return myNick;
  }
  async function ksbFindResident(nameInput){
    const q = (nameInput||'').toLowerCase().trim();
    if(!q) return null;
    if(window.allUsersCache && Object.keys(window.allUsersCache).length){
      for(const [nick, u] of Object.entries(window.allUsersCache)){
        const dn = ((u.displayName||'').trim() || nick).toLowerCase();
        if(dn === q || nick.toLowerCase() === q) return { nick, ...u };
      }
    }
    const allSnap = await get(ref(db,'users'));
    const allU = allSnap.val() || {};
    for(const [nick, u] of Object.entries(allU)){
      const dn = ((u.displayName||'').trim() || nick).toLowerCase();
      if(dn === q || nick.toLowerCase() === q) return { nick, ...u };
    }
    return null;
  }

  window.ksbViewPassport = async function(){
    if(!(await ksbCheckAccess())) return;
    const nameInput = (qs('dutyPassportNick')?.value||'').trim();
    if(!nameInput) return toast('⚠️ Укажите никнейм или имя жителя','gold');
    const target = await ksbFindResident(nameInput);
    if(!target) return toast('❌ Житель с таким именем не найден','red');
    openPassport(target.nick);
  };

  window.ksbGrantLicense = async function(kind){
    if(!(await ksbCheckAccess())) return;
    const nameInput = (qs('dutyLicenseNick')?.value||'').trim();
    if(!nameInput) return toast('⚠️ Укажите никнейм или имя жителя','gold');
    const target = await ksbFindResident(nameInput);
    if(!target) return toast('❌ Житель с таким именем не найден','red');
    try {
      await writeLicense(target.nick, { [kind]: true, [kind+'IssuedAt']: Date.now() });
      await pushNotification(target.nick, `✅ КСБ/Полиция выдали вам ${kind==='bike'?'права на велосипед 🚲':'права на скутер 🛵'}`,'system');
      toast(`✅ ${target.nick} получил права`,'green');
    } catch(e){ toast('❌ ' + (e.message||e.code||'Ошибка'),'red'); }
  };
  window.ksbRevokeLicense = async function(kind){
    if(!(await ksbCheckAccess())) return;
    const nameInput = (qs('dutyLicenseNick')?.value||'').trim();
    if(!nameInput) return toast('⚠️ Укажите никнейм или имя жителя','gold');
    const target = await ksbFindResident(nameInput);
    if(!target) return toast('❌ Житель с таким именем не найден','red');
    try {
      await writeLicense(target.nick, { [kind]: false });
      await pushNotification(target.nick, `❌ КСБ/Полиция изъяли ваши ${kind==='bike'?'права на велосипед 🚲':'права на скутер 🛵'}`,'system');
      toast(`🚫 У ${target.nick} изъяты права`,'gold');
    } catch(e){ toast('❌ ' + (e.message||e.code||'Ошибка'),'red'); }
  };

  // Inject the КСБ/Полиция passport+license card directly into the static dutyPage
  function injectDutyPassportLicenseUI(){
    const dutyPage = qs('dutyPage'); if(!dutyPage) return;
    if(qs('dutyPassportLicenseCard')) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'dutyPassportLicenseCard';
    card.style.cssText = 'border-color:rgba(240,68,74,.25);background:rgba(240,68,74,.04);';
    card.innerHTML = `
      <div class="card-title" style="color:var(--primary);">🪪 Паспорт и права жителя</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Посмотрите паспорт любого жителя или выдайте/изымите права на велосипед и скутер.</div>
      <input type="text" id="dutyPassportNick" placeholder="Никнейм или имя жителя" maxlength="40">
      <button class="btn btn-ghost" style="margin-top:8px;" onclick="ksbViewPassport()">🪪 Показать паспорт</button>
      <div style="border-top:1px dashed rgba(255,255,255,.1);margin:14px 0;"></div>
      <input type="text" id="dutyLicenseNick" placeholder="Никнейм или имя жителя" maxlength="40">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
        <button class="btn btn-primary btn-sm" onclick="ksbGrantLicense('bike')">🚲 Выдать на велосипед</button>
        <button class="btn btn-red btn-sm" onclick="ksbRevokeLicense('bike')">🚲 Изъять</button>
        <button class="btn btn-primary btn-sm" onclick="ksbGrantLicense('scooter')">🛵 Выдать на скутер</button>
        <button class="btn btn-red btn-sm" onclick="ksbRevokeLicense('scooter')">🛵 Изъять</button>
      </div>
    `;
    const firstCard = dutyPage.querySelector('.card');
    if(firstCard && firstCard.nextSibling) firstCard.parentNode.insertBefore(card, firstCard.nextSibling);
    else dutyPage.appendChild(card);
  }

  // ═══════════════════════════════════════════
  // 4) POLICE: requests to mayor
  // ═══════════════════════════════════════════
  function injectPoliceUI(){
    const jobsSection = qs('jobs'); if(!jobsSection) return;
    if(qs('policePanel')) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'policePanel';
    card.style.cssText = 'border-color:rgba(59,130,246,.3);background:rgba(59,130,246,.04);display:none;';
    card.innerHTML = `
      <div class="card-title" style="color:#60a5fa;">👮 Полицейский — запросы в мэрию</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Создайте запрос мэру: на штраф или удаление аккаунта.</div>
      <input type="text" id="polTarget" placeholder="Ник нарушителя" maxlength="40">
      <select id="polType">
        <option value="fine">💸 Штраф</option>
        <option value="delete">🗑 Удаление аккаунта</option>
      </select>
      <input type="number" id="polAmount" placeholder="Сумма штрафа (₽)" min="1" step="1">
      <textarea id="polReason" placeholder="Причина (обязательно)" style="min-height:60px;"></textarea>
      <button class="btn btn-primary" onclick="submitPoliceRequest()" style="margin-top:6px;">📤 Отправить в мэрию</button>
      <div id="myPoliceReqs" style="margin-top:14px;"></div>
    `;
    jobsSection.appendChild(card);
  }
  async function refreshPolicePanelVisibility(){
    const panel = qs('policePanel'); if(!panel) return;
    const snap = await get(userRef(window.currentNick)); const u = snap.val()||{};
    const isPolice = hasMunicipalJob(u,'Полицейский') || u.job==='Полицейский';
    panel.style.display = isPolice ? 'block' : 'none';
    if(isPolice) renderMyPoliceReqs();
  }
  async function renderMyPoliceReqs(){
    const el = qs('myPoliceReqs'); if(!el) return;
    const snap = await get(policeReqRef());
    const all = Object.values(snap.val()||{}).filter(r=>r.officer===window.currentNick).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,10);
    el.innerHTML = all.length ? all.map(r=>{
      const st = r.status==='approved'?'✅ Одобрено':r.status==='rejected'?'❌ Отклонено':'⏳ Ожидает';
      const col = r.status==='approved'?'#22c55e':r.status==='rejected'?'var(--red)':'var(--gold)';
      return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;margin-bottom:6px;font-size:12px;">
        <b>${r.type==='fine'?'💸 Штраф':'🗑 Удаление'}</b> · ${escHtml(r.target)}${r.amount?' · '+r.amount+'₽':''}
        <div style="color:var(--muted);margin-top:4px;">${escHtml(r.reason||'')}</div>
        <div style="color:${col};font-weight:800;margin-top:4px;">${st}</div>
      </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:12px;">Запросов пока нет</div>';
  }

  window.submitPoliceRequest = async function(){
    const target = qs('polTarget')?.value.trim();
    const type = qs('polType')?.value;
    const amount = parseInt(qs('polAmount')?.value||'0',10)||0;
    const reason = qs('polReason')?.value.trim();
    if(!target || !reason) return toast('⚠️ Заполните ник и причину','gold');
    if(type==='fine' && amount<=0) return toast('⚠️ Укажите сумму штрафа','gold');
    const tsnap = await get(userRef(target)); if(!tsnap.exists()) return toast('❌ Жителя нет','red');
    const id = 'pr_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    await set(policeReqRef(id), { id, officer: window.currentNick, target, type, amount, reason, status:'pending', createdAt: Date.now() });
    await pushNotification(ADMIN, `👮 Новый запрос от полиции (${window.currentNick}) на ${target}`,'system');
    toast('📤 Запрос отправлен в мэрию','green');
    qs('polTarget').value=''; qs('polAmount').value=''; qs('polReason').value='';
    renderMyPoliceReqs();
  };

  function renderAdminPoliceReqs(map){
    const el = qs('adminPoliceReqs'); if(!el) return;
    const pending = Object.values(map||{}).filter(r=>r.status==='pending').sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    if(!pending.length){ el.innerHTML='<div style="color:var(--muted);font-size:13px;">Нет запросов</div>'; return; }
    el.innerHTML = pending.map(r=>`
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;">
        <div style="font-size:13px;"><b>${r.type==='fine'?'💸 Штраф':'🗑 Удаление'}</b> · от <b>${escHtml(r.officer)}</b> на <b>${escHtml(r.target)}</b>${r.amount?' · '+r.amount+'₽':''}</div>
        <div style="font-size:12px;color:var(--muted);margin:6px 0;">${escHtml(r.reason||'')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="approvePoliceRequest('${jsEsc(r.id)}')">✅ Одобрить</button>
          <button class="btn btn-red btn-sm" onclick="rejectPoliceRequest('${jsEsc(r.id)}')">❌ Отклонить</button>
        </div>
      </div>`).join('');
  }

  window.approvePoliceRequest = async function(id){
    if(window.currentNick !== ADMIN) return;
    const snap = await get(policeReqRef(id)); if(!snap.exists()) return;
    const r = snap.val();
    if(r.type === 'fine'){
      const tsnap = await get(userRef(r.target)); if(!tsnap.exists()) return toast('❌ Нет жителя','red');
      const u = tsnap.val();
      await update(userRef(r.target), { balance: (u.balance||0) - r.amount });
      await window.addMunicipalTreasury?.(r.amount, `Штраф от полиции: ${r.reason||''}`, {sourceNick:r.target,sourceType:'fine'});
      if(typeof window.logTx === 'function') await window.logTx(r.target, { type:'out', who:'Мэрия (полиция)', amt:r.amount, desc:'Штраф: '+(r.reason||'') });
      await pushNotification(r.target, `💸 Штраф от мэрии: ${r.amount}₽ — ${r.reason||''}`,'money');
    } else if(r.type === 'delete'){
      if(!confirm(`Удалить аккаунт ${r.target}?`)) return;
      await remove(userRef(r.target));
    }
    await update(policeReqRef(id), { status:'approved', reviewedAt: Date.now() });
    await pushNotification(r.officer, `✅ Ваш запрос на ${r.target} одобрен`,'system');
    toast('✅ Одобрено','green');
  };
  window.rejectPoliceRequest = async function(id){
    if(window.currentNick !== ADMIN) return;
    const snap = await get(policeReqRef(id)); if(!snap.exists()) return;
    const r = snap.val();
    await update(policeReqRef(id), { status:'rejected', reviewedAt: Date.now() });
    await pushNotification(r.officer, `❌ Ваш запрос на ${r.target} отклонён`,'system');
    toast('❌ Отклонено','gold');
  };

  // ═══════════════════════════════════════════
  // 5) MARKETPLACE: building rentals
  // ═══════════════════════════════════════════
  function injectMarketRentUI(){
    const marketSection = qs('market'); if(!marketSection) return;
    const ensureRentListener = ()=>{
      if(window.__kapaniRentListener) return;
      const rentRef = marketRentRef();
      const rentFn = snap=>{ if(window._kapaniActivePage === 'market') renderRentListingsOnMarket(snap?.val?.() || {}); };
      onValue(rentRef, rentFn);
      window.__kapaniRentListener = {ref:rentRef, fn:rentFn};
    };
    // The UI is created once, while the realtime listener is attached only
    // while the Market page is active. Reopening the page therefore reuses
    // the DOM and safely reattaches a single listener.
    if(qs('rentListingForm')){ ensureRentListener(); return; }
    // Find "create listing" panel (mktPanel2 area) and append a "rent building" sub-form
    const createPanel = qs('mktPanel2') || marketSection;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'rentListingForm';
    card.style.cssText = 'border-color:rgba(255,128,106,.3);background:rgba(255,128,106,.04);margin-top:14px;';
    card.innerHTML = `
      <div class="card-title" style="color:var(--gold);">🏘️ Сдать здание в аренду</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Объявление появится в общем списке маркетплейса.</div>
      <input type="text" id="rlTitle" placeholder="Название здания" maxlength="80">
      <input type="number" id="rlPrice" placeholder="Цена аренды (₽/неделю)" min="1" step="1">
      <input type="text" id="rlAddress" placeholder="Адрес / район" maxlength="120">
      <textarea id="rlDesc" placeholder="Описание (комнаты, этаж, мебель...)" style="min-height:60px;" maxlength="500"></textarea>
      <input type="url" id="rlPhoto" placeholder="Фото URL (необязательно)">
      <button class="btn btn-gold" onclick="publishRentListing()" style="margin-top:6px;">🏘️ Выставить на аренду</button>
      <div id="myRentListings" style="margin-top:14px;"></div>
    `;
    createPanel.appendChild(card);
    ensureRentListener();
  }

  window.publishRentListing = async function(){
    const title = qs('rlTitle')?.value.trim();
    const price = parseInt(qs('rlPrice')?.value||'0',10)||0;
    const address = qs('rlAddress')?.value.trim();
    const desc = qs('rlDesc')?.value.trim();
    const photo = qs('rlPhoto')?.value.trim();
    if(!title || !price || !desc) return toast('⚠️ Заполните название, цену, описание','gold');
    const id = 'rl_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    try{
      const {error}=await window.kapaniSupabase.rpc('kp_rent_listing_action',{
        p_action:'create',p_listing_id:id,p_payload:{title,price,address,desc,photo}
      });
      if(error)throw error;
    }catch(e){console.error('[rent create]',e);return toast('❌ '+(e?.message||'Ошибка аренды'),'red');}
    toast('✅ Объявление об аренде опубликовано','green');
    qs('rlTitle').value=''; qs('rlPrice').value=''; qs('rlAddress').value=''; qs('rlDesc').value=''; qs('rlPhoto').value='';
    renderRentListingsOnMarket();
  };

  async function renderRentListingsOnMarket(data){
    const source = (data && typeof data === 'object') ? data : ((await get(marketRentRef())).val() || {});
    const all = Object.values(source).filter(r=>r.status==='active').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    // Inject above marketListings
    const host = qs('marketListings'); if(!host) return;
    let block = qs('marketRentBlock');
    if(!block){
      block = document.createElement('div');
      block.id = 'marketRentBlock';
      block.style.cssText = 'margin-bottom:14px;';
      host.parentNode.insertBefore(block, host);
    }
    if(!all.length){ block.innerHTML=''; }
    else block.innerHTML = `
      <div style="font-weight:900;font-size:14px;margin-bottom:8px;color:var(--gold);">🏘️ Здания в аренду</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${all.map(r=>`
          <div style="background:var(--surface);border:1px solid rgba(255,128,106,.25);border-radius:var(--r-sm);padding:12px;">
            ${r.photo?`<img src="${escHtml(r.photo)}" style="width:100%;max-height:160px;object-fit:cover;border-radius:10px;margin-bottom:8px;" loading="lazy">`:''}
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
              <div style="min-width:0;flex:1;">
                <div style="font-weight:900;font-size:14px;">${escHtml(r.title)}</div>
                ${r.address?`<div style="font-size:12px;color:var(--muted);margin-top:2px;">📍 ${escHtml(r.address)}</div>`:''}
                <div style="font-size:12px;color:var(--text);margin-top:6px;white-space:pre-wrap;">${escHtml(r.desc)}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:4px;">Владелец: <b style="color:var(--primary);cursor:pointer;" onclick="openUserProfile('${jsEsc(r.owner)}')">${escHtml(r.owner)}</b></div>
              </div>
              <div style="text-align:right;flex-shrink:0;">
                <div style="font-weight:900;color:var(--gold);">${r.price.toLocaleString()}₽</div>
                <div style="font-size:10px;color:var(--muted);">в неделю</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" onclick="goToChat('${jsEsc(r.owner)}')" style="flex:1;min-width:120px;">💬 Написать</button>
              ${r.owner===window.currentNick?`<button class="btn btn-red btn-sm" onclick="removeRentListing('${jsEsc(r.id)}')">🗑 Снять</button>`:''}
            </div>
          </div>`).join('')}
      </div>
    `;
  }
  window.removeRentListing = async function(id){
    if(!confirm('Снять объявление?')) return;
    try{
      const {error}=await window.kapaniSupabase.rpc('kp_rent_listing_action',{
        p_action:'delete',p_listing_id:id
      });
      if(error)throw error;
    }catch(e){console.error('[rent delete]',e);return toast('❌ '+(e?.message||'Ошибка аренды'),'red');}
    renderRentListingsOnMarket();
  };

  // ═══════════════════════════════════════════
  // INJECTION HOOKS — единая обёртка навигации
  // ═══════════════════════════════════════════
  const _kapaniBaseNavTo = window.navTo;
  let _kapaniLastPage = null;
  window.navTo = function(id){
    if(id==='adminPage' && window._getCurrentNick?.() !== ADMIN) return;
    const previous = _kapaniLastPage;
    _kapaniLastPage = id;
    window._kapaniActivePage = id;
    if(previous==='market' && id!=='market' && window.__kapaniRentListener){
      try{ window.dbOff(window.__kapaniRentListener.ref,'value',window.__kapaniRentListener.fn); }catch(e){}
      window.__kapaniRentListener=null;
    }
    if(previous==='adminPage' && id!=='adminPage' && window.__kapaniAdminPoliceListener){
      try{ window.dbOff(window.__kapaniAdminPoliceListener.ref,'value',window.__kapaniAdminPoliceListener.fn); }catch(e){}
      window.__kapaniAdminPoliceListener=null;
    }
    const r = typeof _kapaniBaseNavTo === 'function'
      ? _kapaniBaseNavTo.apply(this, arguments)
      : undefined;
    try {
      if(id==='profile'){
        injectPassportUI();
        setTimeout(renderPassportCard, 50);
      }
      if(id==='adminPage'){
        injectAdminUI();
      }
      if(id==='jobs'){
        injectPoliceUI();
        injectFinePanel();
        refreshPolicePanelVisibility();
        refreshFinePanelVisibility();
      }
      if(id==='market'){
        injectMarketRentUI();
        renderRentListingsOnMarket();
      }
      if(id==='dutyPage'){
        injectDutyPassportLicenseUI();
      }
    } catch(e) {
      console.error('[Kapani navigation hook]', e);
    }
    return r;
  };

  // No startup injection: these integrations initialize only when their page opens.

  // ═══════════════════════════════════════════
  // 5) КСБ / Полиция — прямой штраф (на странице работ)
  // ═══════════════════════════════════════════
  function injectFinePanel(){
    const jobsSection = qs('jobs'); if(!jobsSection) return;
    if(qs('directFinePanel')) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'directFinePanel';
    card.style.cssText = 'border-color:rgba(248,113,113,.3);background:rgba(248,113,113,.06);display:none;';
    card.innerHTML = `
      <div class="card-title" style="color:var(--red);">💸 Выписать штраф</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Доступно сотрудникам КСБ и полиции.</div>
      <button class="btn btn-red" onclick="ksbFineWorker()">💸 Выписать штраф нарушителю</button>
    `;
    jobsSection.appendChild(card);
  }
  async function refreshFinePanelVisibility(){
    const panel = qs('directFinePanel'); if(!panel) return;
    const snap = await get(userRef(window.currentNick)); const u = snap.val()||{};
    const isKsb = hasMunicipalJob(u,'КСБ') || u.job==='КСБ';
    const isPolice = hasMunicipalJob(u,'Полицейский') || u.job==='Полицейский';
    panel.style.display = (isKsb || isPolice) ? 'block' : 'none';
  }

  // ═══════════════════════════════════════════
  // 6) FIX: гарантированный сброс должности и прав профессии
  // ═══════════════════════════════════════════
  function buildClearJobPatch(role, u){
    const patch = {};
    if(role === 'Водитель' || role === 'Доставщик') patch.vehicle = '';
    if(role === JOB_JANITOR){
      patch.janitorTaskDate=''; patch.janitorSubmissionId='';
      patch.janitorSubmissionStatus=''; patch.janitorProof=''; patch.janitorComment='';
    }
    return patch;
  }

  // Sanitize employment items to plain primitive objects (no refs/cycles)
  function sanitizeEmp(e){
    if(!e || typeof e !== 'object') return null;
    const o = {
      id: String(e.id||''),
      type: String(e.type||''),
      role: String(e.role||''),
    };
    if(e.bizId) o.bizId = String(e.bizId);
    if(e.bizName) o.bizName = String(e.bizName);
    return o.id ? o : null;
  }
  function sanitizeEmps(arr){
    const out = [];
    const seen = new Set();
    (Array.isArray(arr)?arr:[]).forEach(e=>{
      const s = sanitizeEmp(e);
      if(s && !seen.has(s.id)){ seen.add(s.id); out.push(s); }
    });
    return out;
  }

  // quitJob: единственная мастер-реализация определена в основном блоке выше — дубликат убран

  // Штраф через форму на странице (без prompt — надёжно на телефоне)
  let _submitDutyFineBusy = false;
  // Supabase forbids changing another resident's balance from the browser.
  // Only the authorized atomic SQL operation can issue a fine.
  let lastDutyFineAttempt = null;
  window.submitDutyFine = async function(){
    if(_submitDutyFineBusy)return toast('Штраф уже оформляется','gold');
    const myNick=window._getCurrentNick?.();
    if(!myNick)return toast('Сначала войдите в аккаунт','red');
    const name=(qs('dutyFineNick')?.value||'').trim();
    const reason=(qs('dutyFineReason')?.value||'').trim();
    const amountText=(qs('dutyFineAmt')?.value||'').trim();
    const amount=/^\d+$/.test(amountText)?Number(amountText):NaN;
    if(!name)return toast('Укажите нарушителя','gold');
    if(reason.length<3||reason.length>200)return toast('Укажите причину штрафа (3–200 символов)','gold');
    if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000)
      return toast('Сумма штрафа должна быть от 1 до 1 000 000 ₽','gold');
    const btn=qs('dutyFineSubmitBtn');
    _submitDutyFineBusy=true;
    if(btn){btn.disabled=true;btn.textContent='Выписываем…';}
    try{
      const usersSnap=await get(ref(db,'users'));
      const users=usersSnap.val()||{};
      const match=Object.entries(users).filter(([nick,u])=>
        nick.toLowerCase()===name.toLowerCase() ||
        String(u?.displayName||'').toLowerCase()===name.toLowerCase()
      );
      if(match.length!==1)throw new Error(match.length?'Уточните никнейм: найдено несколько жителей':'Житель не найден');
      const target=match[0][0];
      if(target===myNick)throw new Error('Нельзя выписать штраф самому себе');
      const fingerprint=JSON.stringify([myNick,target,amount,reason]);
      if(lastDutyFineAttempt?.fingerprint!==fingerprint)
        lastDutyFineAttempt={fingerprint,id:crypto.randomUUID()};
      const rpc=window.kapaniSupabase;
      if(!rpc)throw new Error('Supabase ещё не подключён');
      const {data,error}=await rpc.rpc('kp_duty_fine',{
        p_target:target,p_amount:amount,p_reason:reason,p_request_id:lastDutyFineAttempt.id
      });
      if(error)throw error;
      if(!data?.ok)throw new Error('Сервер не подтвердил штраф');
      lastDutyFineAttempt=null;
      for(const id of ['dutyFineNick','dutyFineReason','dutyFineAmt']){
        const input=qs(id);if(input)input.value='';
      }
      if(typeof pushNotification==='function'){
        await Promise.allSettled([
          pushNotification(target,`Штраф ${amount} ₽ от КСБ/полиции. Причина: ${reason}`,'money'),
          pushNotification(ADMIN,`${myNick} выписал штраф ${amount} ₽ пользователю ${target}. Причина: ${reason}`,'system')
        ]);
      }
      toast(`Штраф ${amount} ₽ выписан ${target}`,'green');
    }catch(error){
      console.error('[kp_duty_fine]',error);
      toast('Не удалось выписать штраф: '+(error.message||error),'red');
    }finally{
      _submitDutyFineBusy=false;
      const current=qs('dutyFineSubmitBtn');
      if(current){current.disabled=false;current.textContent='Выписать штраф';}
    }
  };

  // Старые кнопки «Выписать штраф» теперь ведут на панель с формой
  window.ksbFineWorker = function(){ navTo('dutyPage'); };

  // adminFireWorker: master implementation is in the main app block — no override needed

  // Панель штрафов подключается общей обёрткой navTo выше.

  // Konec Kapani Pack v2
});

})();
