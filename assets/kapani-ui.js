/* Layout only: existing actions, DOM IDs and Firebase listeners stay in index.html. */
(function () {
  'use strict';

  const page = document.getElementById('adminPage');
  if (!page) return;

  const sections = [
    ['overview', 'Обзор', 'Главное за сегодня'],
    ['requests', 'Заявки', 'Очереди, требующие решения'],
    ['residents', 'Жители', 'Карточки и полномочия'],
    ['economy', 'Экономика', 'Казна, заказы и статистика'],
    ['city', 'Посёлок и события', 'Здания и гонки'],
    ['other', 'Ещё', 'Дополнительные инструменты']
  ];
  const queues = [
    ['unverifiedAccounts', 'Новые аккаунты'],
    ['appList', 'Работа'],
    ['janitorAdminList', 'Отчёты уборщиков'],
    ['adminBizApps', 'Открытие бизнеса'],
    ['adminBizDeleteReqs', 'Закрытие бизнеса'],
    ['adminAtmRequests', 'Банкомат'],
    ['kapaniScooterApps', 'Права'],
    ['kapaniKEducationApps', 'Образование'],
    ['adminDeputyProposals', 'Депутаты'],
    ['adminPoliceReqs', 'Полиция']
  ];
  let mounted = false;
  let active = 'overview';
  let countsFrame = 0;

  function classify(card) {
    const has = selector => !!card.querySelector(selector);
    if (has('#adminStats')) return 'overview';
    if (has('#unverifiedAccounts,#appList,#janitorAdminList,#adminBizApps,#adminBizDeleteReqs,#adminAtmRequests,#kapaniScooterApps,#kapaniKEducationApps,#adminDeputyProposals,#adminPoliceReqs')) return 'requests';
    if (has('#allUsersList,#adminTarget,#adminForceHireTarget,#kveTarget,#adminLicenseStatus')) return 'residents';
    if (has('#kapaniTreasuryBalance,#adminOrders,#adminAdvertiserStats')) return 'economy';
    if (has('#adminRentBuildings,#adminRacesList,#adminDayGroupsList,#raceDayUserSelect')) return 'city';
    return 'other';
  }

  function selectTab(id, focus) {
    if (window._getCurrentNick?.() !== window.ADMIN) return;
    if (!sections.some(section => section[0] === id)) return;
    active = id;
    for (const [key] of sections) {
      const panel = document.getElementById('mayor-panel-' + key);
      const tab = document.getElementById('mayor-tab-' + key);
      if (panel) panel.hidden = key !== id;
      if (tab) {
        tab.setAttribute('aria-selected', String(key === id));
        tab.tabIndex = key === id ? 0 : -1;
      }
    }
    if (focus) document.getElementById('mayor-tab-' + id)?.focus();
    document.getElementById('mayorSectionTitle').textContent = sections.find(section => section[0] === id)[1];
    document.getElementById('mayorSectionSubtitle').textContent = sections.find(section => section[0] === id)[2];
  }

  function moveNewCards() {
    for (const child of Array.from(page.children)) {
      if (!child.classList.contains('card')) continue;
      const title = child.querySelector('.card-title');
      if (title && !title.dataset.mayorTitleClean) {
        title.textContent = child.querySelector('#adminStats') ? 'Показатели' :
          title.textContent.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
        title.dataset.mayorTitleClean = '1';
      }
      const panel = document.getElementById('mayor-panel-' + classify(child));
      panel?.appendChild(child);
    }
  }

  function queueCount(element) {
    if (!element) return '—';
    const text = element.textContent.trim();
    if (/загруз/i.test(text) && !element.querySelector('button')) return '…';
    if (/ошиб|не удалось/i.test(text) && !element.querySelector('button')) return '!';
    if (!text || /^нет\b/i.test(text)) return '0';
    const approve = Array.from(element.querySelectorAll('button')).filter(button => {
      const handler = button.getAttribute('onclick') || '';
      return /одобр|подтверд|принят|выплат|выдать/i.test(button.textContent) ||
        /approveApp\([^,]+,\s*true|adminVerifyAccount|payoutJanitorSubmission|adminApproveBiz|kapaniReviewScooter/.test(handler);
    });
    return approve.length ? String(approve.length) : '0';
  }

  function updateQueues() {
    countsFrame = 0;
    let total = 0;
    for (const [id] of queues) {
      const value = queueCount(document.getElementById(id));
      const badge = document.querySelector('[data-mayor-count="' + id + '"]');
      if (badge) badge.textContent = value;
      if (/^\d+$/.test(value)) total += Number(value);
    }
    const totalNode = document.getElementById('mayorPendingTotal');
    if (totalNode) totalNode.textContent = String(total);
  }

  function scheduleQueues() {
    if (!countsFrame) countsFrame = requestAnimationFrame(updateQueues);
  }

  function filterResidents() {
    const list = document.getElementById('allUsersList');
    const search = document.getElementById('mayorResidentSearch');
    const result = document.getElementById('mayorResidentResult');
    if (!list || !search || !result) return;
    const query = search.value.trim().toLocaleLowerCase('ru');
    const rows = Array.from(list.children);
    let shown = 0;
    for (const row of rows) {
      row.hidden = !row.textContent.toLocaleLowerCase('ru').includes(query);
      if (!row.hidden) shown++;
    }
    result.textContent = query ? `Найдено: ${shown}` : `Жителей: ${rows.length}`;
  }

  function refreshResidentCard() {
    const picker = document.getElementById('mayorResidentSelect');
    const original = document.getElementById('adminTarget');
    const summary = document.getElementById('mayorResidentSummary');
    if (!picker || !original || !summary) return;
    const before = picker.value;
    picker.replaceChildren(new Option('Выберите жителя', ''));
    for (const option of original.options) {
      if (option.value) picker.add(new Option(option.textContent, option.value));
    }
    picker.value = before && Array.from(picker.options).some(option => option.value === before) ? before : (original.value || '');
    const nick = picker.value;
    if (!nick) { summary.textContent = 'Выберите жителя, чтобы увидеть основные данные и доступные действия.'; return; }
    const resident = window.allUsersCache?.[nick] || {};
    const money = Number(resident.balance || 0);
    const score = resident.kveScore === undefined || resident.kveScore === null ? 'не указан' : String(resident.kveScore);
    summary.textContent = `${resident.displayName || nick} · ${resident.job || 'Житель'} · баланс ${Number.isFinite(money) ? money.toLocaleString('ru-RU') : '—'} ₽ · КВЭ: ${score}`;
  }

  function selectResident(nick) {
    for (const id of ['adminTarget','adminForceHireTarget','kveTarget','raceDayUserSelect']) {
      const select = document.getElementById(id);
      if (!select || !Array.from(select.options).some(option => option.value === nick)) continue;
      select.value = nick;
      if (id === 'adminTarget') select.dispatchEvent(new Event('change', {bubbles:true}));
    }
    refreshResidentCard();
  }

  function groupHomeServices() {
    const grid = document.querySelector('#home > .quick-grid');
    if (!grid || grid.dataset.grouped) return;
    grid.dataset.grouped = 'true';
    const cards = Array.from(grid.children);
    const groups = [
      ['Быстрые действия', 'Всё необходимое в посёлке', [0, 1, 2]],
      ['Работа и обучение', 'Профессии, права и экзамены', [3, 6, 7, 8]],
      ['Жизнь посёлка', 'Жители, здоровье и события', [4, 5, 9, 10, 11]]
    ];
    const host = document.createElement('div');
    host.className = 'service-catalog';
    for (const [title, description, indices] of groups) {
      const section = document.createElement('section');
      section.className = 'service-group';
      const heading = document.createElement('div');
      heading.className = 'service-group-heading';
      heading.innerHTML = `<div><h2>${title}</h2><p>${description}</p></div>`;
      const tiles = document.createElement('div');
      tiles.className = 'service-tiles';
      for (const index of indices) if (cards[index]) tiles.appendChild(cards[index]);
      section.append(heading, tiles);
      host.appendChild(section);
    }
    grid.replaceWith(host);
  }

  function buildMobileMenu() {
    const nav = document.getElementById('bottomNav');
    if (!nav || document.getElementById('bnMore')) return;
    const more = document.createElement('button');
    more.type = 'button';
    more.id = 'bnMore';
    more.className = 'bn-item';
    more.setAttribute('aria-label', 'Открыть все разделы');
    more.innerHTML = '<span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16 M4 12h16 M4 19h16"/></svg></span>Разделы';
    nav.appendChild(more);
    const drawer = document.createElement('div');
    drawer.id = 'kapaniSectionsDrawer';
    drawer.className = 'sections-drawer';
    drawer.hidden = true;
    drawer.innerHTML = '<div class="sections-drawer-backdrop"></div><div class="sections-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="sectionsDrawerTitle"><div class="sections-drawer-head"><h2 id="sectionsDrawerTitle">Разделы</h2><button type="button" class="btn btn-ghost" id="sectionsDrawerClose">Закрыть</button></div><div class="sections-drawer-links"></div></div>';
    document.body.appendChild(drawer);
    const close = () => { drawer.hidden = true; more.focus(); };
    const links = [
      ['Задания','tasks'], ['Новости','news'], ['Плюс','subscription'],
      ['Бизнесы','businesses'], ['Здания','rentBuildings'], ['Мероприятия','events'],
      ['Работа','jobs'], ['Такси','taxi'], ['Доставка','deliveryOrderPage'],
      ['КВЭ','kveExam'], ['Уборщик','janitorPage']
    ];
    more.addEventListener('click', () => {
      const visible = links.filter(([,id]) => {
        if (id === 'janitorPage') return document.getElementById('bn8')?.style.display === 'flex';
        if (id === 'kveExam') return document.getElementById('bn11')?.style.display === 'flex';
        return true;
      });
      if (window._getCurrentNick?.() === window.ADMIN) visible.unshift(['Мэрия','adminPage']);
      const list = drawer.querySelector('.sections-drawer-links');
      list.replaceChildren();
      for (const [label,id] of visible) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => { drawer.hidden = true; window.navTo(id); });
        list.appendChild(button);
      }
      drawer.hidden = false;
      drawer.querySelector('#sectionsDrawerClose').focus();
    });
    drawer.querySelector('#sectionsDrawerClose').addEventListener('click', close);
    drawer.querySelector('.sections-drawer-backdrop').addEventListener('click', close);
    drawer.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  }

  function mount() {
    if (window._getCurrentNick?.() !== window.ADMIN) return;
    if (mounted) { selectTab(active); moveNewCards(); scheduleQueues(); return; }
    mounted = true;
    const header = document.createElement('header');
    header.className = 'mayor-heading';
    header.innerHTML = '<div><span class="mayor-eyebrow">Панель управления</span><h1>Мэрия Капаней</h1><p>Заявки, жители и дела посёлка — по разделам.</p></div><button type="button" class="btn btn-ghost" id="mayorBackHome">На главную</button>';
    header.querySelector('button').addEventListener('click', () => window.navTo('home'));
    const nav = document.createElement('div');
    nav.className = 'mayor-tabs';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Разделы мэрии');
    nav.innerHTML = sections.map(([id, label]) => `<button type="button" role="tab" id="mayor-tab-${id}" aria-controls="mayor-panel-${id}">${label}</button>`).join('');
    nav.querySelectorAll('button').forEach((button, index) => {
      button.addEventListener('click', () => selectTab(sections[index][0]));
      button.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
        selectTab(sections[next][0], true);
      });
    });
    const sectionHeading = document.createElement('div');
    sectionHeading.className = 'mayor-section-heading';
    sectionHeading.innerHTML = '<h2 id="mayorSectionTitle"></h2><p id="mayorSectionSubtitle"></p>';
    page.prepend(sectionHeading);
    page.prepend(nav);
    page.prepend(header);
    for (const [id] of sections) {
      const panel = document.createElement('div');
      panel.id = 'mayor-panel-' + id;
      panel.className = 'mayor-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'mayor-tab-' + id);
      page.appendChild(panel);
    }

    const overview = document.createElement('div');
    overview.className = 'mayor-overview';
    overview.innerHTML = `<div class="mayor-overview-lead"><span>Требуют внимания</span><strong id="mayorPendingTotal">—</strong><p>Новых заявок в очередях</p><button type="button" class="btn btn-primary">Открыть заявки →</button><span id="mayorLoadStatus" role="status"></span></div><div class="mayor-queue-grid">${queues.map(([id, label]) => `<button type="button" data-mayor-queue="${id}"><span>${label}</span><strong data-mayor-count="${id}">—</strong></button>`).join('')}</div>`;
    overview.querySelector('.btn').addEventListener('click', () => selectTab('requests'));
    overview.querySelectorAll('[data-mayor-queue]').forEach(button => button.addEventListener('click', () => {
      selectTab('requests');
      const card = document.getElementById(button.dataset.mayorQueue)?.closest('.card');
      card?.scrollIntoView({block:'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    }));
    document.getElementById('mayor-panel-overview').appendChild(overview);

    const residentTools = document.createElement('div');
    residentTools.className = 'mayor-search';
    residentTools.innerHTML = '<label for="mayorResidentSearch">Найти жителя</label><input type="search" id="mayorResidentSearch" placeholder="Имя или должность"><span id="mayorResidentResult" role="status"></span>';
    residentTools.querySelector('input').addEventListener('input', filterResidents);
    document.getElementById('mayor-panel-residents').appendChild(residentTools);
    const residentCard = document.createElement('div');
    residentCard.className = 'mayor-resident-card';
    residentCard.innerHTML = '<h3>Карточка жителя</h3><label for="mayorResidentSelect">Житель</label><select id="mayorResidentSelect"><option value="">Выберите жителя</option></select><p id="mayorResidentSummary" role="status">Выберите жителя, чтобы увидеть основные данные и доступные действия.</p><div class="mayor-resident-actions"><button type="button" data-resident-action="adminTarget">Баланс и штрафы</button><button type="button" data-resident-action="adminForceHireTarget">Должность</button><button type="button" data-resident-action="kveTarget">КВЭ</button><button type="button" data-resident-action="adminLicenseStatus">Права</button></div>';
    document.getElementById('mayor-panel-residents').appendChild(residentCard);
    residentCard.querySelector('select').addEventListener('change', event => selectResident(event.target.value));
    residentCard.querySelectorAll('[data-resident-action]').forEach(button => button.addEventListener('click', () => {
      document.getElementById(button.dataset.residentAction)?.closest('.card')?.scrollIntoView({block:'start'});
    }));

    moveNewCards();
    selectTab('overview');
    for (const id of ['adminStats','adminOrders','allUsersList','adminRentBuildings','adminRacesList','adminDayGroupsList']) {
      const list = document.getElementById(id);
      if (list && !list.textContent.trim()) list.textContent = 'Загрузка…';
    }
    refreshResidentCard();
    const targetSelect = document.getElementById('adminTarget');
    if (targetSelect) {
      new MutationObserver(refreshResidentCard).observe(targetSelect,{childList:true});
      targetSelect.addEventListener('change',refreshResidentCard);
    }
    updateQueues();
    new MutationObserver(moveNewCards).observe(page, {childList:true});
    new MutationObserver(scheduleQueues).observe(document.getElementById('mayor-panel-requests'), {childList:true,subtree:true,characterData:true});
    const residentList = document.getElementById('allUsersList');
    if (residentList) new MutationObserver(filterResidents).observe(residentList, {childList:true});
  }

  window.mountMayorDashboard = mount;
  groupHomeServices();
  buildMobileMenu();
  document.addEventListener('keydown', event => {
    const tile = event.target.closest?.('.quick-card[role="button"]');
    if (!tile || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    tile.click();
  });
})();
