/* Additive finish pass for the existing Kapani static app. No build tools. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const money = value => Number(value || 0).toLocaleString('ru-RU') + ' ₽';
  const nick = () => window._getCurrentNick?.();
  const bridge = () => window.KAPANI_BRIDGE;
  const dbref = path => bridge().ref(bridge().db, path);
  const notify = (text, tone='green') => window.toast?.(text, tone);
  const rpc = async (name, args) => {
    const {data, error} = await window.kapaniSupabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Ошибка защищённой операции');
    return data;
  };
  const pending = new Map();
  const requestId = key => {
    const fullKey = 'kp_finish_retry:' + nick() + ':' + key;
    if (!pending.has(fullKey)) {
      let id = sessionStorage.getItem(fullKey);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(fullKey, id); }
      pending.set(fullKey, id);
    }
    return pending.get(fullKey);
  };
  const commit = key => { const fullKey = 'kp_finish_retry:' + nick() + ':' + key; pending.delete(fullKey); sessionStorage.removeItem(fullKey); };
  async function run(label, fn) {
    try { return await fn(); }
    catch (error) { console.error('[Kapani finish] ' + label, error); notify(error.message || 'Ошибка операции', 'red'); }
  }

  function profileLayout() {
    const p = $('profile'), header = $('profileHeaderBg');
    if (!p || !header || p.dataset.finishLayout) return;
    const row = p.querySelector('.v8-profile-actions');
    if (!row) return;
    p.dataset.finishLayout = '1';
    const photo = document.createElement('button');
    photo.type = 'button'; photo.className = 'btn btn-ghost';
    photo.textContent = 'Фото из галереи';
    photo.addEventListener('click', () => $('avatarFileInput')?.click());
    row.insertBefore(photo, row.firstChild);
    const oldButtons = header.querySelector('button[onclick^="changeDisplayName"]')?.parentElement;
    if (oldButtons) {
      const details = document.createElement('details');
      details.className = 'v9-profile-more';
      const summary = document.createElement('summary');
      summary.textContent = 'Дополнительные действия с профилем и документами';
      details.append(summary, oldButtons);
      row.after(details);
    }
  }

  // A rental is one protected wallet+building transaction. One request ID may
  // be retried after a network timeout without paying a second time.
  window.rentBuilding = id => run('rent', async () => {
    const b = (await bridge().get(dbref('rentBuildings/' + id))).val();
    if (!b) throw new Error('Здание уже недоступно');
    if (b.renter && Number(b.rentExpiry) > Date.now()) throw new Error('Здание уже занято');
    if (!confirm('Арендовать «' + b.name + '» на семь суток? Цена ' + money(b.weekPrice) + ' до серверной скидки по подписке.')) return;
    const key = 'rent:' + id;
    const result = await rpc('kp_rental_v8', {p_action:'rent', p_id:requestId(key), p_building:id});
    commit(key);
    notify('Аренда оформлена. Списано ' + money(result.paid));
    await window.renderRentBuildings?.();
  });
  window.adminRevokeRent = (id, renter, name) => run('revoke-rent', async () => {
    if (!confirm('Прекратить аренду «' + name + '» у ' + renter + '? Оплата за прошедший срок не возвращается.')) return;
    const key = 'revoke-rent:' + id;
    await rpc('kp_rental_v8', {p_action:'revoke', p_id:requestId(key), p_building:id});
    commit(key); notify('Аренда завершена');
    await window.renderAdmin?.();
  });

  function rentEditButtons() {
    const list = $('adminRentBuildings');
    if (!list) return;
    for (const row of list.querySelectorAll('.rent-row')) {
      if (row.querySelector('.v9-rent-edit')) continue;
      const del = row.querySelector('button[onclick^="deleteRentBuilding"]');
      const id = del?.getAttribute('onclick')?.match(/deleteRentBuilding\('([^']+)'\)/)?.[1];
      if (!id) continue;
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm v9-rent-edit';
      btn.textContent = 'Изменить';
      btn.onclick = () => window.kpEditRent(id);
      del.parentElement.insertBefore(btn, del);
    }
  }
  window.kpEditRent = id => run('edit-rent', async () => {
    const b = (await bridge().get(dbref('rentBuildings/' + id))).val();
    if (!b) throw new Error('Объявление удалено');
    const old = $('kpFinishRentEdit'); old?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'kpFinishRentEdit'; overlay.className = 'v8-overlay'; overlay.setAttribute('role','dialog');
    overlay.innerHTML = '<section class="v8-sheet"><header><h2>Редактировать здание</h2><button type="button" class="v8-icon" data-close>×</button></header><div class="v8-sheet-body v9-rent-editor"><label>Название<input id="finishRentName" maxlength="80"></label><label>Цена за неделю<input id="finishRentPrice" type="number" min="1" max="100000" step="1"></label><label>Фото из галереи<input id="finishRentFile" type="file" accept="image/*"></label><img id="finishRentPreview" alt="Фото здания"><button type="button" class="btn btn-primary" id="finishRentSave">Сохранить</button></div></section>';
    document.body.append(overlay);
    $('finishRentName').value = b.name || '';
    $('finishRentPrice').value = b.weekPrice || 0;
    $('finishRentPreview').src = /^(https:\/\/|data:image\/)/.test(b.photo || '') ? b.photo : 'assets/avatar.svg';
    let newPhoto = null;
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    $('finishRentFile').onchange = async e => run('rent-photo', async () => {
      const file = e.target.files?.[0]; if (!file) return;
      if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) throw new Error('Выберите фото до 10 МБ');
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
      newPhoto = canvas.toDataURL('image/jpeg',.78);
      $('finishRentPreview').src = newPhoto;
    });
    $('finishRentSave').onclick = () => run('save-rent', async () => {
      const name = $('finishRentName').value.trim(), price = Number($('finishRentPrice').value);
      if (name.length < 2 || name.length > 80 || !Number.isSafeInteger(price) || price < 1 || price > 100000) throw new Error('Название 2–80 символов и цена 1–100 000 ₽');
      await bridge().update(dbref('rentBuildings/' + id), {name, weekPrice:price, ...(newPhoto ? {photo:newPhoto} : {})});
      close(); notify('Объявление обновлено'); await window.renderAdmin?.();
    });
  });

  // Historical deliveries form part of the money audit and cannot be erased.
  // The resident can hide terminal cards locally instead.
  let hideDelivery = sessionStorage.getItem('kp_hide_delivery_history') === '1';
  function filterDeliveryHistory() {
    const host = $('myDeliveryOrders'); if (!host) return;
    for (const card of host.querySelectorAll('.work-order')) {
      const badge = card.querySelector('.status-badge')?.textContent || '';
      card.style.display = hideDelivery && /(Отменён|Оплачено)/i.test(badge) ? 'none' : '';
    }
  }
  window.clearMyDeliveryHistory = async () => {
    hideDelivery = !hideDelivery;
    sessionStorage.setItem('kp_hide_delivery_history', hideDelivery ? '1' : '0');
    filterDeliveryHistory();
    notify(hideDelivery ? 'Завершённые доставки скрыты на этом устройстве. Финансовые записи сохранены.' : 'История доставок показана');
  };

  let priorListingDelivery = null;
  window.kpDeliveryForListing = id => run('delivery-listing', async () => {
    const item = (await bridge().get(dbref('marketplace/' + id))).val();
    if (!item || item.buyer !== nick() || item.status !== 'sold') throw new Error('Сначала оплатите покупку после согласия продавца');
    if (![item.sellerLat, item.sellerLng].every(v => v !== null && v !== undefined && v !== '') ) throw new Error('Продавец не отметил место товара на карте');
    const orders = (await bridge().get(dbref('deliveryCustomOrders'))).val() || {};
    const previous = Object.values(orders).find(o => o.listingId === id && o.status !== 'cancelled');
    if (previous) throw new Error(previous.status === 'done' ? 'Этот товар уже был доставлен' : 'Доставка уже оформлена. Следите за ней в своих заказах.');
    if (typeof priorListingDelivery !== 'function') throw new Error('Окно доставки ещё не готово');
    return priorListingDelivery(id);
  });

  // Finance operations need the owner role server-side and are journalled.
  const upgradePrices = {employee:350,product:250,priceCap:400};
  const effectPrices = {shimmer:199,particles:249,aurora:399,fire:449,plasma:499,galaxy:549,thunder:699,hologram:749,dragon:849,prime:899};
  async function businessFinance(action,target,amount) {
    const bizId = window.kpCurrentBizId?.();
    if (!bizId) throw new Error('Откройте панель своего бизнеса');
    const key = 'business:' + bizId + ':' + action + ':' + target + ':' + amount;
    const result = await rpc('kp_business_finance_v8', {p_action:action,p_id:requestId(key),p_biz:bizId,p_target:target,p_amount:amount});
    commit(key);notify('Операция сохранена. Баланс бизнеса ' + money(result.balance));
    await window.renderBizOwnerPanel?.();
    return result;
  }
  window.upgradeBizLimit = kind => run('upgrade', async () => {
    const unit = upgradePrices[kind], qty = Number($('bizUpgradeQty_' + kind)?.value);
    if (!unit || !Number.isSafeInteger(qty) || qty < 1 || qty > 20) throw new Error('Выберите от 1 до 20 улучшений');
    if (!confirm('Списать со счёта бизнеса ' + money(unit * qty) + ' за улучшение лимита?')) return;
    await businessFinance('upgrade',kind + ':' + qty,unit * qty);
  });
  window.buyBizBgEffect = effect => run('effect', async () => {
    const biz = window.kpCurrentBizId?.(); if (!biz) throw new Error('Откройте свой бизнес');
    if (!effect) { await bridge().update(dbref('businesses/' + biz),{bgEffect:null});notify('Оформление отключено');await window.renderBizOwnerPanel?.();return; }
    const price = effectPrices[effect];if (!price) throw new Error('Оформление не найдено');
    if (!confirm('Купить оформление за ' + money(price) + ' со счёта бизнеса?')) return;
    await businessFinance('effect',effect,price);
  });
  window.kpBusinessStatement = () => run('business-statement', async () => {
    const biz = window.kpCurrentBizId?.();if (!biz) throw new Error('Откройте свой бизнес');
    const data = await rpc('kp_business_statement_v8',{p_biz:biz});
    const host = $('kpFinishStatement') || document.createElement('div');
    host.id = 'kpFinishStatement';host.className='v9-business-statement';
    host.innerHTML = '<b>Счёт бизнеса ' + money(data.balance) + '</b><p class="v8-muted">Только подтверждённые сервером операции. Ранние несохранённые начисления не восстанавливаются.</p>' +
      ((data.lines || []).map(line => '<div class="v9-ledger-row"><span>' + esc(({sale:'Продажа',deposit:'Пополнение',withdraw:'Вывод',salary:'Зарплата',auto_salary:'Автозарплата',upgrade:'Улучшение',effect:'Оформление'})[line.kind] || line.kind) + '<small>' + new Date(line.created_at).toLocaleString('ru-RU') + '</small></span><strong class="' + (line.amount < 0 ? 'out' : '') + '">' + (line.amount > 0 ? '+' : '') + money(line.amount) + '</strong></div>').join('') || '<p class="v8-muted">Новых операций пока нет</p>');
    const panel = $('bizOwnerOrders')?.parentElement || $('bizOwnerPanel');
    panel?.prepend(host);
  });
  function statementButton() {
    const host = $('bizOwnerOrders')?.parentElement;
    if (!host || host.querySelector('.v9-ledger-button')) return;
    const btn = document.createElement('button');btn.className = 'btn btn-ghost btn-sm v9-ledger-button';
    btn.textContent = 'Журнал операций бизнеса';btn.onclick = () => window.kpBusinessStatement();
    host.prepend(btn);
  }
  function correctDriverLabels() {
    const host = $('driverList'); if (!host) return;
    for (const btn of host.querySelectorAll('button[onclick*="abandonOrder"]')) {
      if (/35\s*₽|штраф/i.test(btn.textContent)) btn.textContent = 'Отказаться от заказа';
    }
  }

  const protectedOverrides = Object.fromEntries([
    'rentBuilding','adminRevokeRent','clearMyDeliveryHistory','kpDeliveryForListing',
    'upgradeBizLimit','buyBizBgEffect','kpBusinessStatement'
  ].map(name => [name,window[name]]));
  function boot() {
    if (!window.KAPANI_V8_READY || !window.KAPANI_BRIDGE || !window.kapaniSupabase) return false;
    if (window.kpDeliveryForListing !== protectedOverrides.kpDeliveryForListing)
      priorListingDelivery = window.kpDeliveryForListing;
    Object.assign(window,protectedOverrides);
    profileLayout();rentEditButtons();statementButton();filterDeliveryHistory();correctDriverLabels();
    const rentals = $('adminRentBuildings'), deliveries = $('myDeliveryOrders'), panel = $('bizOwnerPanel');
    if (rentals) new MutationObserver(rentEditButtons).observe(rentals,{childList:true});
    if (deliveries) new MutationObserver(filterDeliveryHistory).observe(deliveries,{childList:true});
    if (panel) new MutationObserver(statementButton).observe(panel,{childList:true});
    if ($('driverList')) new MutationObserver(correctDriverLabels).observe($('driverList'),{childList:true,subtree:true});
    window.KAPANI_FINISHES_READY = true;
    return true;
  }
  if (!boot()) {
    let attempts = 0;
    const timer = setInterval(() => { if (boot() || ++attempts > 400) clearInterval(timer); },50);
  }
})();
