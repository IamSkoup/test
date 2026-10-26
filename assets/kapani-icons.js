/* Convert legacy decorative emoji in interface copy to one stroke-icon language.
   User-authored messages, posts, game symbols and the explicit emoji picker stay intact. */
(function () {
  'use strict';
  const svgPaths = {
    check:'<path d="M4 12l5 5L20 6"/>',
    close:'<path d="M5 5l14 14M19 5 5 19"/>',
    alert:'<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    chat:'<path d="M3 5h18v13H8l-5 3V5Z"/><path d="M7 10h10m-10 4h7"/>',
    news:'<path d="M4 3h16v18H4zM8 7h8M8 11h8M8 15h5"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    minus:'<path d="M4 12h16"/>',
    person:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3-7 8-7s8 3 8 7"/>',
    people:'<circle cx="9" cy="8" r="3"/><path d="M2 20c0-4 3-7 7-7s7 3 7 7M16 5c2 0 4 2 4 4s-2 4-4 4m0 1c3 0 6 3 6 6"/>',
    crown:'<path d="M2 7l5 4 5-7 5 7 5-4-2 13H4L2 7Z"/>',
    star:'<path d="m12 2 3 7h7l-5.5 5 2 8-6.5-4-6.5 4 2-8L2 9h7l3-7Z"/>',
    gift:'<path d="M3 10h18v11H3zM2 7h20v3H2zM12 7v14M12 7c-6 0-7-5-4-5 2 0 4 3 4 5Zm0 0c6 0 7-5 4-5-2 0-4 3-4 5Z"/>',
    bank:'<path d="M2 8 12 3l10 5M3 21h18M5 9v10m5-10v10m5-10v10m5-10v10"/>',
    money:'<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M5 9h1m12 6h1"/>',
    card:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20m-16 5h5"/>',
    shop:'<path d="M3 10 5 3h14l2 7M4 10v11h16V10M3 10c0 3 4 4 6 1 1 3 5 3 6 0 2 3 6 2 6-1M9 21v-7h6v7"/>',
    bag:'<path d="M3 8h18l-1 13H4L3 8ZM8 9V6a4 4 0 0 1 8 0v3"/>',
    package:'<path d="m12 2 9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5m-9 5v10"/>',
    briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V4h8v3M2 12h20m-12 0v2h4v-2"/>',
    building:'<path d="M4 21V5h16v16M2 21h20M8 9h2m4 0h2m-8 4h2m4 0h2m-7 8v-4h6v4"/>',
    map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/>',
    pin:'<path d="M12 22s8-7 8-13a8 8 0 1 0-16 0c0 6 8 13 8 13Z"/><circle cx="12" cy="9" r="2"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 10h18"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    bell:'<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 3h4"/>',
    lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
    shield:'<path d="M12 2 3 6v6c0 6 4 9 9 10 5-1 9-4 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
    file:'<path d="M5 2h10l4 4v16H5V2Zm10 0v5h4M8 12h8m-8 4h8"/>',
    edit:'<path d="M4 20h16M5 16 16 5l3 3L8 19l-4 1 1-4Z"/>',
    delete:'<path d="M4 6h16M9 6V3h6v3m-9 0 1 15h10l1-15M10 10v7m4-7v7"/>',
    camera:'<path d="M3 7h4l2-3h6l2 3h4v14H3V7Z"/><circle cx="12" cy="14" r="4"/>',
    image:'<rect x="2" y="3" width="20" height="18" rx="2"/><circle cx="8" cy="9" r="2"/><path d="m3 18 6-5 4 3 3-2 5 4"/>',
    video:'<rect x="2" y="5" width="16" height="14" rx="2"/><path d="m18 9 4-3v12l-4-3"/>',
    mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/>',
    send:'<path d="m2 12 20-9-5 18-5-7-10-2Zm10 2 10-11"/>',
    refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    heart:'<path d="M12 21 3 12a5 5 0 0 1 7-7l2 2 2-2a5 5 0 0 1 7 7l-9 9Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M20 4l-2 2M6 18l-2 2"/>',
    leaf:'<path d="M3 20C2 8 9 4 21 3c-1 12-5 19-18 17Zm0 0c6-7 10-10 16-13"/>',
    game:'<rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h6m-3-3v6m8-3h.01m2-2h.01"/>',
    trophy:'<path d="M6 3h12v7a6 6 0 0 1-12 0V3Zm0 3H3v3a4 4 0 0 0 4 4m11-7h3v3a4 4 0 0 1-4 4m-5 3v4m-5 0h10"/>',
    vehicle:'<path d="M4 14 6 7h12l2 7v5h-2v-2H6v2H4v-5Zm2 0h12M8 17h.01M16 17h.01"/>',
    health:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7v10M7 12h10"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
    chart:'<path d="M3 21V3m0 18h18M7 17v-4m5 4V8m5 9V5"/>',
    info:'<circle cx="12" cy="12" r="10"/><path d="M12 10v7m0-10h.01"/>',
    spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>'
  };
  const labels = {check:'Готово',close:'Ошибка',alert:'Внимание',chat:'Сообщения',news:'Новости',plus:'Добавить',minus:'Убрать',person:'Профиль',people:'Жители',crown:'Подписка',star:'Избранное',gift:'Подарок',bank:'Банк',money:'Деньги',card:'Карта',shop:'Магазин',bag:'Покупки',package:'Заказ',briefcase:'Работа',building:'Здание',map:'Карта местности',pin:'Место',calendar:'Календарь',clock:'Время',bell:'Уведомления',lock:'Доступ',shield:'Безопасность',file:'Документ',edit:'Изменить',delete:'Удалить',camera:'Камера',image:'Изображение',video:'Видео',mic:'Голос',send:'Отправить',refresh:'Обновить',heart:'Нравится',sun:'Погода',leaf:'Природа',game:'Игра',trophy:'Награда',vehicle:'Транспорт',health:'Здоровье',settings:'Настройки',chart:'Статистика',info:'Информация',spark:'Действие'};
  function iconName(value) {
    if (/[✅☑✔]/u.test(value)) return 'check';
    if (/[❌❎🚫]/u.test(value)) return 'close';
    if (/[⚠❗‼]/u.test(value)) return 'alert';
    if (/[💬🗨📨✉]/u.test(value)) return 'chat';
    if (/[📰🗞📢📣]/u.test(value)) return 'news';
    if (/[➕✚]/u.test(value)) return 'plus';
    if (/[➖]/u.test(value)) return 'minus';
    if (/[👑]/u.test(value)) return 'crown';
    if (/[💎⭐🌟]/u.test(value)) return 'star';
    if (/[🎁🎀]/u.test(value)) return 'gift';
    if (/[🏦🏛]/u.test(value)) return 'bank';
    if (/[💰💸💵🪙]/u.test(value)) return 'money';
    if (/[💳]/u.test(value)) return 'card';
    if (/[🏪🏬]/u.test(value)) return 'shop';
    if (/[🛍🛒]/u.test(value)) return 'bag';
    if (/[📦🚚]/u.test(value)) return 'package';
    if (/[👔🧰🛠🧹]/u.test(value)) return 'briefcase';
    if (/[🏘🏠🏡🏢]/u.test(value)) return 'building';
    if (/[🗺🌍]/u.test(value)) return 'map';
    if (/[📍]/u.test(value)) return 'pin';
    if (/[📅🗓]/u.test(value)) return 'calendar';
    if (/[⏳⏰⌛]/u.test(value)) return 'clock';
    if (/[🔔🔕]/u.test(value)) return 'bell';
    if (/[🔒🔐🪪]/u.test(value)) return 'lock';
    if (/[🛡👮🚓]/u.test(value)) return 'shield';
    if (/[📋📝📄📜📑🎓]/u.test(value)) return 'file';
    if (/[✏🖊]/u.test(value)) return 'edit';
    if (/[🗑]/u.test(value)) return 'delete';
    if (/[📷📸]/u.test(value)) return 'camera';
    if (/[🖼]/u.test(value)) return 'image';
    if (/[🎬🎥📹]/u.test(value)) return 'video';
    if (/[🎤🎙]/u.test(value)) return 'mic';
    if (/[📤🚀]/u.test(value)) return 'send';
    if (/[🔄🔁]/u.test(value)) return 'refresh';
    if (/[❤️💖💗]/u.test(value)) return 'heart';
    if (/[☀🌤🔥]/u.test(value)) return 'sun';
    if (/[🌲🌱🍃🍂🍁🌿]/u.test(value)) return 'leaf';
    if (/[🎮🎰🎲🃏🎯🪙]/u.test(value)) return 'game';
    if (/[🏆🥇🏅🏁]/u.test(value)) return 'trophy';
    if (/[🚲🛵🚗🚙🚕]/u.test(value)) return 'vehicle';
    if (/[🏥🩺💊]/u.test(value)) return 'health';
    if (/[🔧⚙]/u.test(value)) return 'settings';
    if (/[📊📈📉]/u.test(value)) return 'chart';
    if (/[ℹ❓💡]/u.test(value)) return 'info';
    if (/[👤👥🤝]/u.test(value)) return 'people';
    return 'spark';
  }
  const emojiPattern = /[\p{Extended_Pictographic}\u20e3]/u;
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ru', {granularity:'grapheme'}) : null;
  const skipSelector = '#wallEmojiPanel,#nicknameEmojiSelect,#abnGrid,.msg-text,.msg-caption,.news-user-text,.chat-sender,.dm-user-name,.lb-name,.h-name';
  function isUserContent(parent) {
    if (parent.closest(skipSelector)) return true;
    if (parent.closest('#slotsArea,#blackjackArea,#baccaratArea,#videoPokerArea,#rouletteArea,#coinflipArea,#diceArea') && !parent.closest('button,.card-title')) return true;
    if (parent.closest('.wall-post') && !parent.closest('button')) return true;
    if (parent.closest('.chat-bubble') && !parent.closest('button,.msg-actions')) return true;
    if (parent.closest('#newsDiscussionHeader') && !parent.closest('.news-scope-badge,button')) return true;
    return false;
  }
  function makeIcon(name) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox','0 0 24 24');
    icon.setAttribute('aria-hidden','true');
    icon.setAttribute('focusable','false');
    icon.classList.add('kapani-icon');
    icon.innerHTML = svgPaths[name];
    return icon;
  }
  function replaceText(node) {
    const value = node.nodeValue;
    if (!value || !emojiPattern.test(value)) return;
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,svg,textarea,pre,code,[contenteditable="true"]') || isUserContent(parent)) return;
    const chunks = segmenter ? Array.from(segmenter.segment(value), part => part.segment) : Array.from(value);
    if (!chunks.some(chunk => emojiPattern.test(chunk))) return;
    // Some legacy selects use their visible text as the submitted value.
    if (parent.tagName === 'OPTION' && !parent.hasAttribute('value')) parent.value = parent.value;
    const fragment = document.createDocumentFragment();
    const onlyEmoji = chunks.every(chunk => !chunk.trim() || emojiPattern.test(chunk));
    const control = parent.closest('button,[role="button"]');
    if (onlyEmoji && control && !control.getAttribute('aria-label') &&
        !control.textContent.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20e3]/gu, '').trim()) {
      control.setAttribute('aria-label', labels[iconName(chunks.find(chunk => emojiPattern.test(chunk)))]);
    }
    let plain = '';
    function flush() { if (plain) { fragment.appendChild(document.createTextNode(plain)); plain=''; } }
    for (const chunk of chunks) {
      if (!emojiPattern.test(chunk)) { plain += chunk; continue; }
      if (parent.tagName === 'OPTION') continue;
      flush();
      fragment.appendChild(makeIcon(iconName(chunk)));
    }
    flush();
    node.replaceWith(fragment);
  }
  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) { replaceText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || root.matches('script,style,svg,textarea,pre,code')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(replaceText);
  }
  function start() {
    scan(document.body);
    const pending = new Set();
    let frame = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') pending.add(record.target);
        else for (const node of record.addedNodes) pending.add(node);
      }
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        for (const node of pending) if (node.isConnected) scan(node);
        pending.clear();
      });
    });
    observer.observe(document.body, {subtree:true,childList:true,characterData:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
