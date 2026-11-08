(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ngOf = (el) => [...el.attributes].find((a) => a.name.startsWith('_ngcontent')).name;

  // ── glyphs ───────────────────────────────────────────────────────
  const PLAY = '<svg class="g-play" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.7l5.2 3.3L3 8.3z"/></svg>';
  const PZ = '<svg class="g-pz" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.6" y="1.2" width="2.5" height="7.6" rx=".8"/><rect x="5.9" y="1.2" width="2.5" height="7.6" rx=".8"/></svg>';
  const X = '<svg class="g-x" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9"/></svg>';
  const CHEV = '<svg class="g-chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.6 3.8L5 6.2l2.4-2.4"/></svg>';
  const ARR = { prev: '<svg class="g-arr" viewBox="0 0 8 12" aria-hidden="true"><path d="M5.4 2.6L2.4 6l3 3.4"/></svg>',
    next: '<svg class="g-arr" viewBox="0 0 8 12" aria-hidden="true"><path d="M2.6 2.6L5.6 6l-3 3.4"/></svg>' };

  const T1 = { desc: 'разбор 500-х на checkout', time: '47m 15s', run: true };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s', run: false };

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, title: $('.header', app), head: $('.day-head', app), date: $('.day-date', app), week: $('.day-week', app), logBtn: $('.g-btn', app), total: $('.day-total', app) };
    const N = ngOf(x.title);
    x.title.insertAdjacentHTML('beforeend', `<div ${N} class="win-controls"><button ${N} class="wc-btn" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1 5.5h8"/></svg></button><button ${N} class="wc-btn wc-close" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
    return x;
  }
  function sessionsPaused(x) {
    for (const r of $$('.blk.hot app-session-row', x.app)) {
      r.classList.remove('lead'); r.classList.add('paused');
      const tb = $('.tb', r);
      if (tb) { tb.classList.remove('lead'); tb.classList.add('willp'); }
    }
  }

  // ── the flat control ─────────────────────────────────────────────
  // kind: combo (▾ — opens the small menu) | slider (‹ › — flips, one visible)
  // o: { t, desc (show the description), prev, next, open }
  function ctl(kind, o) {
    const t = o.t;
    const g = `<span class="tmx-g">${t.run ? PLAY : PZ}</span>`;
    const time = `<b class="tmx-time">${t.time}</b>`;
    const desc = o.desc ? `<span class="tmx-desc">${esc(t.desc)}</span>` : '';
    if (kind === 'slider') {
      return `<span class="tmx sl ${t.run ? 'run' : 'pause'}"><span class="tmx-arr${o.prev ? '' : ' off'}">${ARR.prev}</span>${g}${time}${desc}<span class="tmx-arr${o.next ? '' : ' off'}">${ARR.next}</span></span>`;
    }
    return `<span class="tmx combo ${t.run ? 'run' : 'pause'}${o.open ? ' open' : ''}">${g}${time}${desc}<span class="tmx-chev">${CHEV}</span></span>`;
  }
  // where: date | week | under | over | left
  function place(x, where, kind, o) {
    const html = ctl(kind, o);
    if (where === 'date') x.date.insertAdjacentHTML('afterend', `<span class="tmx-at date">${html}</span>`);
    if (where === 'week') x.week.insertAdjacentHTML('beforeend', `<span class="tmx-at week"><span class="tmx-sep">·</span>${html}</span>`);
    if (where === 'under') { x.head.classList.add('tmx-under'); x.head.insertAdjacentHTML('beforeend', `<span class="tmx-at under">${html}</span>`); }
    if (where === 'over') x.head.insertAdjacentHTML('beforeend', `<span class="tmx-at over">${html}</span>`);
    if (where === 'bottom' || where === 'bottom-c') {
      x.head.classList.add('tmx-bottom');
      x.head.insertAdjacentHTML('beforeend', `<span class="tmx-at bottom${where === 'bottom-c' ? ' center' : ''}">${html}</span>`);
    }
    if (where === 'left') { x.logBtn.insertAdjacentHTML('beforebegin', `<span class="tmx-at left">${html}</span>`); x.logBtn.classList.add('tmx-next'); }
    x.anchor = $('.tmx', x.head);
    if (o.t.run) sessionsPaused(x);
  }

  // ── the small menu (v18) ─────────────────────────────────────────
  function offsetIn(el, root) {
    let left = 0, top = 0;
    for (let n = el; n && n !== root; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  }
  function menu(x, timers, side) {
    const rows = timers.map((t) => `<div class="ctx-item tmm${t.run ? ' run' : ''}"><button type="button" class="tmm-g">${t.run ? PLAY : PZ}</button>`
      + `<b class="tmm-time">${t.time}</b><span class="tmm-desc">${esc(t.desc)}</span><button type="button" class="tmm-x">${X}</button></div>`).join('');
    x.app.insertAdjacentHTML('beforeend', `<div class="ctx-menu anchored tmm-menu">${rows}</div>`);
    x.menu = x.app.lastElementChild;
    x.menuSide = side;
  }
  function placeMenus(x) {
    if (!x.menu) return;
    const a = offsetIn(x.anchor, x.app);
    x.menu.style.top = `${Math.max(a.bottom + 5, offsetIn(x.head, x.app).bottom - 3)}px`;
    x.menu.style.left = x.menuSide === 'right'
      ? `${Math.max(8, a.right - x.menu.offsetWidth + 6)}px`
      : x.menuSide === 'center'
        ? `${Math.round((a.left + a.right - x.menu.offsetWidth) / 2)}px`
        : `${Math.max(8, a.left - 8)}px`;
  }

  // ── the grid ─────────────────────────────────────────────────────
  const grid = $('#grid');
  const cells = [];
  function section(title, note) {
    grid.insertAdjacentHTML('beforeend', `<h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}<div class="row"></div>`);
    return grid.lastElementChild;
  }
  function cell(row, x, cap) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.append(x.cv);
    c.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`);
    row.append(c);
    cells.push(x);
  }

  // the head as a 2×2 grid: date · + Log / timer line · total
  const grid2 = (x) => x.head.classList.add('v23');
  T1.time = '47m 15s';

  const s1 = section('1 · + Log — к правому краю на уровне даты, total — ниже, на линии таймера',
    'Шапка — сетка 2×2: слева день недели · дата · строка таймера, справа + Log над total. Строка таймера и total стоят на одной базовой линии, + Log — на оси даты.');
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'combo', { t: T1, desc: true });
    cell(s1, x, '<b>Идёт</b><br>светящийся ▶, лаймовое время, описание');
  }
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'combo', { t: { ...T1, run: false }, desc: true });
    cell(s1, x, '<b>Пауза</b><br>серое время, красный ⏸');
  }
  {
    const x = mkCell(270);
    grid2(x);
    place(x, 'bottom', 'combo', { t: T1, desc: true, open: true });
    menu(x, [T1, T2], 'left');
    cell(s1, x, '<b>Два таймера — ▾ открывает меню v18</b>');
  }
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'combo', { t: { ...T1, desc: 'созвон с QA по регрессу оплаты и разбор логов чекаута после релиза' }, desc: true });
    cell(s1, x, '<b>Длинное описание</b><br>режется многоточием до ▾; total не двигается');
  }

  const s2 = section('2 · Без таймера — что со шапкой',
    'Строка есть только у таймера без тикета. Либо раскладка 2×2 остаётся всегда (слева внизу пусто), либо шапка возвращается к сегодняшней в одну строку — и перестраивается в момент старта таймера.');
  {
    const x = mkCell(170);
    grid2(x);
    cell(s2, x, '<b>2×2 всегда</b><br>шапка не прыгает; пустота переехала влево вниз');
  }
  {
    const x = mkCell(170);
    cell(s2, x, '<b>Как сегодня</b><br>старт таймера перестраивает шапку: total уезжает вниз, + Log — вправо');
  }

  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
    for (const x of cells) placeMenus(x);
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('1');
})();
