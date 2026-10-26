/* Kapani season: classic script for file:// and HTTPS. */
(function(){
'use strict';
/* One shared appearance record. Preview is local until the mayor confirms saving. */
const MONTHS = [
  ['Январь','Морозное утро','#d5ebf2','#eef8fa','#285d79'],
  ['Февраль','Иней и синие сумерки','#c8d4e8','#e9eef8','#394f7b'],
  ['Март','Оттепель и первые ростки','#d9eacb','#f2f6ea','#49764f'],
  ['Апрель','Дождь и свежая зелень','#d2e8e7','#edf5f3','#3a7774'],
  ['Май','Цветение и солнце','#e9ebc8','#faf6e6','#69733c'],
  ['Июнь','Трава и длинный день','#cdebdc','#ecf8f1','#286c5d'],
  ['Июль','Солнце и сухое золото','#f0e1ab','#faf5df','#726229'],
  ['Август','Урожай и полевые травы','#eed6a8','#faf0e0','#85551f'],
  ['Сентябрь','Охра и прохладный воздух','#e8d0a9','#f7ede0','#7d5735'],
  ['Октябрь','Красная листва и тыквы','#edc7ac','#f8e9e0','#924d35'],
  ['Ноябрь','Туман и графит','#d4dfe1','#f0f3f3','#4f646e'],
  ['Декабрь','Снег и хвойный лес','#cfe6e8','#f0f8f8','#296a79']
];
const currentMonth = new Date().getMonth() + 1;
const stored = Number(document.documentElement.dataset.season);
let saved = Number.isInteger(stored) && stored >= 1 && stored <= 12 ? stored : currentMonth;
let preview = saved;
let unsubscribe = null;
let saving = false;
let status = 'Подключаем общее оформление…';
const effectsKey = 'kapani:seasonEffects';
let effectsEnabled = true;
try { effectsEnabled = localStorage.getItem(effectsKey) !== 'off'; } catch (_) {}
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const effectShapes = {
  snow: '<path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" fill="none"/>',
  frost: '<path d="M12 2 21 12 12 22 3 12Z" fill="none"/><path d="M12 2v20M3 12h18" fill="none"/>',
  drop: '<path d="M12 2C8 8 5 11 5 15a7 7 0 0 0 14 0c0-4-3-7-7-13Z"/>',
  petal: '<path d="M12 3C6 8 5 14 12 21c7-7 6-13 0-18Z"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4" fill="none"/>',
  seed: '<path d="M12 3c-8 4-9 12-1 18 8-6 9-14 1-18Z"/><path d="M11 21c0-5 2-10 5-13" fill="none"/>',
  leaf: '<path d="M3 12C5 5 12 3 21 4c-1 9-4 16-12 17C5 20 3 17 3 12Z"/><path d="M5 18c4-4 8-7 13-10" fill="none"/>',
  mist: '<path d="M2 9h15m-10 5h15m-17 5h10" fill="none"/>'
};
const monthEffects = [
  ['snow','#87b7c9'],['frost','#b5c9e6'],['drop','#7ea886'],['drop','#74a9aa'],
  ['petal','#d598a0'],['light','#8ebf91'],['light','#d0a750'],['seed','#b48a4b'],
  ['leaf','#b4824b'],['leaf','#bd7045'],['mist','#9ab0b7'],['snow','#85bfc6']
];

function renderEffects(month) {
  const layer = document.getElementById('seasonEffectsLayer');
  const button = document.getElementById('seasonEffectsToggle');
  if (!layer || !button) return;
  const reduced = !!reducedMotion?.matches;
  const active = effectsEnabled && !reduced;
  button.disabled = reduced;
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', reduced ? 'Сезонные эффекты отключены настройкой устройства' : active ? 'Выключить сезонные эффекты' : 'Включить сезонные эффекты');
  button.querySelector('span').textContent = reduced ? 'Эффекты: выкл.' : active ? 'Эффекты: вкл.' : 'Эффекты: выкл.';
  layer.hidden = !active;
  if (!active) { layer.replaceChildren(); return; }
  const [shape, color] = monthEffects[month - 1];
  const count = window.innerWidth < 720 ? 12 : 18;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index++) {
    const particle = document.createElement('span');
    particle.className = 'season-particle';
    particle.style.setProperty('--x', `${(index * 41 + 9) % 101}%`);
    particle.style.setProperty('--size', `${shape === 'mist' ? 20 : 8 + index % 4 * 3}px`);
    particle.style.setProperty('--duration', `${10 + index % 5 * 3}s`);
    particle.style.setProperty('--delay', `${-index * 1.7}s`);
    particle.style.setProperty('--drift', `${index % 2 ? 36 : -34}px`);
    particle.style.setProperty('--rotate', `${shape === 'snow' || shape === 'frost' ? 120 : 340}deg`);
    particle.style.setProperty('--particle-color', color);
    particle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${effectShapes[shape]}</svg>`;
    fragment.appendChild(particle);
  }
  layer.replaceChildren(fragment);
}

function mountEffects() {
  if (document.getElementById('seasonEffectsToggle')) return;
  const layer = document.createElement('div');
  layer.id = 'seasonEffectsLayer';
  layer.className = 'season-effects-layer';
  layer.setAttribute('aria-hidden', 'true');
  const button = document.createElement('button');
  button.id = 'seasonEffectsToggle';
  button.className = 'season-effects-toggle';
  button.type = 'button';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M19 5l-3 3M8 16l-3 3"/><circle cx="12" cy="12" r="4"/></svg><span></span>';
  button.addEventListener('click', () => {
    effectsEnabled = !effectsEnabled;
    try { localStorage.setItem(effectsKey, effectsEnabled ? 'on' : 'off'); } catch (_) {}
    renderEffects(Number(document.documentElement.dataset.season) || currentMonth);
  });
  document.body.append(layer, button);
  reducedMotion?.addEventListener?.('change', () => renderEffects(Number(document.documentElement.dataset.season) || currentMonth));
  renderEffects(Number(document.documentElement.dataset.season) || currentMonth);
}

function scene(month) {
  const [,,sky,ground,ink] = MONTHS[month - 1];
  const base = `<rect width="160" height="88" fill="${sky}"/><path d="M0 65 Q40 50 82 65 T160 61 V88 H0Z" fill="${ground}"/>`;
  const motifs = [
    '<circle cx="124" cy="23" r="11" fill="#fff"/><path d="M10 78 Q36 67 67 73 T150 73 M24 22l4 8m-8-3 8-4 M61 14l3 8m-8-3 8-4 M99 47l3 8m-8-3 8-4" stroke="#fff" stroke-width="2" fill="none"/>',
    '<path d="M35 70V35m-15 15 15-15 15 15M108 70V26m-20 24 20-24 20 24" stroke="#eaf4ff" stroke-width="5" fill="none"/><circle cx="24" cy="18" r="2" fill="#fff"/><circle cx="74" cy="12" r="2" fill="#fff"/><circle cx="140" cy="21" r="2" fill="#fff"/>',
    '<path d="M18 78l22-14 17 14 M78 78l26-18 26 18" fill="#eef4e7"/><path d="M77 72v-20m0 11c-14 0-16-10-16-10 13-2 16 10 16 10m0-6c12-8 20-6 20-6-4 11-20 14-20 14" stroke="#59875a" stroke-width="2.5" fill="none"/>',
    '<path d="M17 18l-5 12m31-15-5 12m31-10-5 12m31-14-5 12m31-14-5 12m31-14-5 12M10 72q14-8 29 0t29 0t29 0t29 0t29 0" stroke="#639da2" stroke-width="2" fill="none"/>',
    '<circle cx="125" cy="25" r="13" fill="#efd894"/><path d="M30 75V42m0 9c-22-9-23-22-23-22 21-1 23 22 23 22m0-7c18-15 30-11 30-11-4 17-30 19-30 19" stroke="#6c8953" stroke-width="3" fill="none"/><circle cx="21" cy="37" r="5" fill="#efd6ce"/><circle cx="42" cy="35" r="5" fill="#efd6ce"/>',
    '<circle cx="122" cy="25" r="15" fill="#fff1bf"/><path d="M0 75q45-20 80 0t80 0M24 78V58m0 7-8-9m8 9 8-10m45 23V50m0 8-8-8m8 8 8-8m45 26V53m0 10-8-9m8 9 8-9" stroke="#4e9b6e" stroke-width="2.5" fill="none"/>',
    '<circle cx="119" cy="22" r="17" fill="#f6db83"/><path d="M18 78V40m0 11-9-10m9 15 10-12m25 34V45m0 11-9-11m9 14 10-10m25 29V41m0 10-9-10m9 15 10-12" stroke="#b6a04d" stroke-width="3" fill="none"/>',
    '<circle cx="120" cy="23" r="14" fill="#f4d58a"/><path d="M14 79V39m0 15-8-10m8 15 9-11m36 31V34m0 16-8-9m8 17 8-10m36 31V39m0 16-8-10m8 15 8-11" stroke="#a28545" stroke-width="2.5" fill="none"/><circle cx="74" cy="68" r="7" fill="#bb6a43"/>',
    '<path d="M0 68q40-17 80 0t80 0" stroke="#ac824f" stroke-width="5" fill="none"/><path d="M38 19 Q25 34 35 43 Q51 38 38 19 M95 30Q82 43 90 52 Q108 47 95 30 M133 17Q123 34 132 43Q150 35 133 17" fill="#b77f43"/>',
    '<path d="M0 72q40-12 80 0t80 0" fill="#dfab75"/><ellipse cx="50" cy="64" rx="18" ry="13" fill="#dc8c4e"/><ellipse cx="90" cy="69" rx="13" ry="9" fill="#d87940"/><path d="M50 52v-7m40 15v-6" stroke="#5c6d41" stroke-width="3"/><path d="M115 18 Q101 34 114 43Q130 35 115 18" fill="#b6633d"/>',
    '<path d="M0 40h160 M0 52h160 M0 66h160" stroke="#fff" stroke-width="8" opacity=".55"/><path d="M39 77V38m0 10-15-11m15 17 18-15m52 38V29m0 18-13-12m13 20 16-15" stroke="#879a9e" stroke-width="3" fill="none"/>',
    '<path d="M35 78V31m-19 30 19-30 19 30m-34-8 15-22 15 22 M107 78V24m-22 39 22-39 22 39m-39-13 17-26 17 26" fill="#4f8a77" stroke="#4f8a77" stroke-width="2"/><path d="M16 60h38m32 2h43" stroke="#fff" stroke-width="3"/><circle cx="135" cy="18" r="2" fill="#fff"/>'
  ];
  return `<svg viewBox="0 0 160 88" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice">${base}<g stroke-linecap="round" stroke-linejoin="round">${motifs[month - 1]}</g><path d="M0 87 H160" stroke="${ink}" opacity=".15"/></svg>`;
}

function setMonth(month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return;
  document.documentElement.dataset.season = String(month);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b241b');
  renderEffects(month);
  const hero = document.querySelector('.home-hero');
  if (hero) {
    let artwork = hero.querySelector('.site-season-scene');
    if (!artwork) {
      artwork = document.createElement('div');
      artwork.className = 'site-season-scene';
      artwork.setAttribute('aria-hidden', 'true');
      hero.insertBefore(artwork, hero.lastElementChild);
    }
    artwork.innerHTML = scene(month);
  }
}
setMonth(saved);
mountEffects();

function updatePicker() {
  const host = document.getElementById('kapaniSeasonPicker');
  if (!host) return;
  host.querySelector('[data-season-status]').textContent = status;
  host.querySelector('[data-current-season]').textContent = MONTHS[saved - 1][0];
  host.querySelector('[data-preview-season]').textContent = MONTHS[preview - 1][0] + ' — ' + MONTHS[preview - 1][1];
  host.querySelector('[data-apply-season]').disabled = saving || preview === saved;
  host.querySelectorAll('[data-season-choice]').forEach(button => {
    const month = Number(button.dataset.seasonChoice);
    button.setAttribute('aria-pressed', String(month === preview));
    button.classList.toggle('is-current', month === saved);
    button.querySelector('.season-current').textContent = month === saved ? 'Сейчас' : '';
  });
}

function choose(month) {
  if (window._getCurrentNick?.() !== window.ADMIN) return;
  preview = month;
  setMonth(month);
  status = 'Предпросмотр. Другие жители пока не видят это оформление.';
  updatePicker();
}

async function apply() {
  if (saving || preview === saved || window._getCurrentNick?.() !== window.ADMIN) return;
  const month = preview;
  if (!confirm(`Применить оформление «${MONTHS[month - 1][0]}» для всех жителей?`)) return;
  saving = true;
  status = 'Сохраняем оформление…';
  updatePicker();
  try {
    const auth = await window.kapaniGetAuth();
    const user = auth.currentUser;
    if (!user || user.uid !== window.ADMIN || !(await user.getIdTokenResult()).claims.admin) {
      throw new Error('Нужна защищённая сессия мэра. Проверьте серверную настройку прав.');
    }
    await window.dbSet(window.dbRef(window.db, 'siteAppearance'), {month, updatedAt: Date.now()});
    saved = month;
    try { localStorage.setItem('kapani:sharedSeason', String(month)); } catch (_) {}
    status = 'Сохранено. Подключённые жители получат оформление автоматически.';
  } catch (error) {
    preview = saved;
    setMonth(saved);
    status = 'Не удалось сохранить. Вернули прежнее оформление. ' + (error?.message || 'Проверьте соединение.');
  } finally {
    saving = false;
    updatePicker();
  }
}

window.renderSeasonPicker = function () {
  if (window._getCurrentNick?.() !== window.ADMIN) return;
  const panel = document.getElementById('mayor-panel-appearance');
  if (!panel || document.getElementById('kapaniSeasonPicker')) return;
  const card = document.createElement('div');
  card.id = 'kapaniSeasonPicker';
  card.className = 'season-picker';
  card.innerHTML = `<div class="season-picker-heading"><div><h3>Оформление сайта</h3><p>Выберите месяц, посмотрите его на сайте и затем сохраните для всех.</p></div><div class="season-active">Сейчас: <strong data-current-season></strong></div></div>
    <div class="season-choices" role="group" aria-label="Сезонные оформления">${MONTHS.map(([name, description], index) => `<button type="button" class="season-choice" data-season-choice="${index + 1}" aria-label="${name}: ${description}"><span class="season-scene">${scene(index + 1)}</span><span class="season-copy"><strong>${name}</strong><small>${description}</small></span><span class="season-current"></span></button>`).join('')}</div>
    <div class="season-preview"><div><small>Предпросмотр</small><strong data-preview-season></strong><span data-season-status role="status"></span></div><button type="button" class="btn btn-primary" data-apply-season>Применить для всех</button></div>`;
  panel.appendChild(card);
  card.querySelectorAll('[data-season-choice]').forEach(button => button.addEventListener('click', () => choose(Number(button.dataset.seasonChoice))));
  card.querySelector('[data-apply-season]').addEventListener('click', apply);
  updatePicker();
};

async function watchSharedAppearance() {
  try {
    await window.kapaniReady();
    const auth = await window.kapaniGetAuth();
    const {onAuthStateChanged} = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    onAuthStateChanged(auth, user => {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (!user) { status = 'Войдите, чтобы получить общее оформление.'; updatePicker(); return; }
      const target = window.dbRef(window.db, 'siteAppearance');
      unsubscribe = window.dbOnValue(target, async snapshot => {
        const value = snapshot.val();
        const month = Number(value?.month);
        saved = Number.isInteger(month) && month >= 1 && month <= 12 ? month : currentMonth;
        preview = saved;
        setMonth(saved);
        try { localStorage.setItem('kapani:sharedSeason', String(saved)); } catch (_) {}
        status = value ? 'Это оформление видят все жители.' : 'Первый запуск: выбран текущий месяц.';
        updatePicker();
        if (!value && user.uid === window.ADMIN) {
          try {
            if ((await user.getIdTokenResult()).claims.admin) {
              await window.runTransaction(target, current => current || {month: currentMonth, updatedAt: Date.now()});
            } else {
              status = 'Для сохранения настройте серверные права мэра.';
              updatePicker();
            }
          } catch (error) {
            status = 'Начальное оформление не сохранено: ' + (error?.message || 'ошибка соединения');
            updatePicker();
          }
        }
      }, error => {
        preview = saved;
        setMonth(saved);
        status = 'Не удалось загрузить общее оформление: ' + (error?.message || 'проверьте соединение');
        updatePicker();
      });
    });
    window.renderSeasonPicker();
  } catch (error) {
    status = 'Не удалось подключить общее оформление: ' + (error?.message || 'ошибка');
    updatePicker();
  }
}
watchSharedAppearance();

})();
