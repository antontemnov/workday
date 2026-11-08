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

  function dialSvg(run, min, stack) {
    const fr = (min % 60) / 60, a = fr * 2 * Math.PI, cx = 8, cy = 9.2, rs = 4.1, rh = 3.4;
    const sec = fr > 0.004 ? `<path class="sec" d="M${cx} ${cy} L${cx} ${(cy - rs).toFixed(2)} A${rs} ${rs} 0 ${fr > 0.5 ? 1 : 0} 1 ${(cx + rs * Math.sin(a)).toFixed(2)} ${(cy - rs * Math.cos(a)).toFixed(2)} Z"/>` : '';
    const inner = run
      ? `<path class="hand" d="M${cx} ${cy} L${(cx + rh * Math.sin(a)).toFixed(2)} ${(cy - rh * Math.cos(a)).toFixed(2)}"/>`
      : '<rect class="pz" x="5.85" y="7.1" width="1.55" height="4.2" rx=".55"/><rect class="pz" x="8.6" y="7.1" width="1.55" height="4.2" rx=".55"/>';
    const back = stack ? '<path class="back" d="M2.53 2.68 A5 5 0 1 0 1.69 12.3"/>' : '';
    const vb = stack ? '-2.6 0 18.6 16' : '0 0 16 16';
    return `<svg class="tm-dial${stack ? ' stack' : ''}" viewBox="${vb}" aria-hidden="true">${back}<path class="crown" d="M6.4 1.2h3.2M8 1.2v2.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5.6"/>${sec}${inner}</svg>`;
  }

  const T1 = { desc: 'разбор 500-х на checkout', time: '47m 15s', min: 47, run: true };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s', min: 12, run: false };

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
    if (kind === 'dial') {
      // icon: front — the dial carries the state (as in the titlebar); end — ▶ stays, the dial replaces ▾
      const ic = `<span class="tmx-ic">${dialSvg(t.run, t.min, o.stack)}</span>`;
      const end = o.icon === 'end';
      return `<span class="tmx dl ${t.run ? 'run' : 'pause'}${o.open ? ' open' : ''}${end ? ' icend' : ''}">${end ? g : ic}${time}${desc}${end ? ic : ''}</span>`;
    }
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

  // the head as a 2×2 grid: date · total / timer line · + Log
  const grid2 = (x) => x.head.classList.add('v23', 'v24');

  const s1 = section('1 · Циферблат спереди — вместо ▶ и шеврона, как в заголовке окна',
    'Шапка 2×2: слева дата над строкой таймера, справа total на оси даты, + Log — на линии таймера. Циферблат несёт состояние: стрелка и лаймовый сектор (минуты часа) — идёт, красные полоски внутри — пауза. Таймеров больше одного — за циферблатом второе кольцо. Клик по строке — меню v18.');
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'dial', { t: T1, desc: true });
    cell(s1, x, '<b>Один таймер, идёт</b>');
  }
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'dial', { t: { ...T1, run: false }, desc: true });
    cell(s1, x, '<b>Пауза</b> (руками или git-правка перехватила)');
  }
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'dial', { t: T1, desc: true, stack: true });
    cell(s1, x, '<b>Таймеров два</b><br>второе кольцо за циферблатом — без счётчика');
  }
  {
    const x = mkCell(270);
    grid2(x);
    place(x, 'bottom', 'dial', { t: T1, desc: true, stack: true, open: true });
    menu(x, [T1, T2], 'left');
    cell(s1, x, '<b>Клик — меню v18</b><br>⏸/▶ · время · описание · ✕; строка → облако тикета');
  }

  const s2 = section('2 · Циферблат на месте шеврона, ▶ спереди',
    'Буквальная замена ▾: глиф состояния остаётся, циферблат в конце строки — ручка меню.');
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'dial', { t: T1, desc: true, icon: 'end' });
    cell(s2, x, '<b>Один таймер</b><br>состояние показано дважды — ▶ и стрелкой циферблата');
  }
  {
    const x = mkCell(170);
    grid2(x);
    place(x, 'bottom', 'dial', { t: T1, desc: true, icon: 'end', stack: true });
    cell(s2, x, '<b>Таймеров два</b>');
  }

  const s3 = section('3 · Без таймера — шапка как сегодня',
    'После перестановки total стоит на своём месте и с таймером, и без него. Старт таймера двигает только + Log — вниз, на линию таймера.');
  {
    const x = mkCell(170);
    cell(s3, x, '<b>Таймера без тикета нет</b><br>+ Log · total в одну строку, как сейчас');
  }

  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
    for (const x of cells) placeMenus(x);
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('1');
})();
