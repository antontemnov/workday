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
  function dialSvg(run, min) {
    const fr = (min % 60) / 60, a = fr * 2 * Math.PI, cx = 8, cy = 9.2, rs = 4.1, rh = 3.4;
    const sec = `<path class="sec" d="M${cx} ${cy} L${cx} ${(cy - rs).toFixed(2)} A${rs} ${rs} 0 ${fr > 0.5 ? 1 : 0} 1 ${(cx + rs * Math.sin(a)).toFixed(2)} ${(cy - rs * Math.cos(a)).toFixed(2)} Z"/>`;
    const inner = run
      ? `<path class="hand" d="M${cx} ${cy} L${(cx + rh * Math.sin(a)).toFixed(2)} ${(cy - rh * Math.cos(a)).toFixed(2)}"/>`
      : '<rect class="pz" x="5.85" y="7.1" width="1.55" height="4.2" rx=".55"/><rect class="pz" x="8.6" y="7.1" width="1.55" height="4.2" rx=".55"/>';
    return `<svg class="tm-dial" viewBox="0 0 16 16" aria-hidden="true"><path class="crown" d="M6.4 1.2h3.2M8 1.2v2.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5.6"/>${sec}${inner}</svg>`;
  }

  const T1 = { desc: 'разбор 500-х на checkout', time: '47m 15s', run: true };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s', run: false };
  const TEXT = T1.desc;

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height, keepTitle = false) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    if (!keepTitle) $('.header', app).remove();
    const x = { cv, app, title: $('.header', app), head: $('.day-head', app), logBtn: $('.g-btn', app), cloud: $('app-log-cloud', app), backdrop: $('.cloud-backdrop', app) };
    x.NGC = ngOf($('.fav', x.cloud));
    return x;
  }
  // the anchor: K — a capsule of its own left of + Log; L — the titlebar label
  function anchor(x, how, t) {
    const g = t.run ? PLAY : PZ;
    if (how === 'K') {
      x.logBtn.insertAdjacentHTML('beforebegin', `<span class="tmc-row"><span class="tmc candy ${t.run ? 'run' : 'paused'}">${g}<b>${t.time}</b></span></span>`);
      x.anchor = $('.tmc', x.head);
    } else {
      $('.view-switcher', x.title).insertAdjacentHTML('afterend', `<span class="tm-ndiv"></span><span class="tm-nav ${t.run ? 'run' : 'pause'}"><span class="tm-dw">${dialSvg(t.run, 47)}</span><span class="tm-min">${t.time}</span></span>`);
      x.anchor = $('.tm-nav', x.title);
    }
  }

  // ── the small menu: one line per anonymous timer ─────────────────
  // glyph = pause / resume · time · description (click → the ticket cloud) · ✕
  function menu(x, timers, side) {
    const rows = timers.map((t) => `<div class="ctx-item tmm${t.run ? ' run' : ''}"><button type="button" class="tmm-g">${t.run ? PLAY : PZ}</button>`
      + `<b class="tmm-time">${t.time}</b><span class="tmm-desc">${esc(t.desc)}</span><button type="button" class="tmm-x">${X}</button></div>`).join('');
    x.app.insertAdjacentHTML('beforeend', `<div class="ctx-menu anchored${side === 'right' ? ' right' : ''} tmm-menu">${rows}</div>`);
    x.menu = x.app.lastElementChild;
    x.menuSide = side;
  }

  const chip = (x, task, name, cls) => `<span ${x.NGC} class="fav ${cls}"><span ${x.NGC} class="f-task">${task}</span><span ${x.NGC} class="f-name">${esc(name)}</span></span>`;
  // the one cloud: + Log (log) or the ticket pick a timer row opens (pick —
  // the same mode task? on a suggestion opens today)
  function cloud(x, mode, o = {}) {
    x.app.append(x.backdrop, x.cloud);
    x.cloud.classList.add('open');
    x.backdrop.classList.add('open');
    const input = $('.cloud-filter input', x.cloud);
    const items = [];
    if (mode === 'pick') {
      x.cloud.classList.add('accept-mode');
      $('.f-batch', x.cloud).remove();
      input.setAttribute('placeholder', `ticket for «${o.desc}» · no match → search Jira`);
      items.push(chip(x, '＋', 'Create in Jira…', 'tm-create'));
    } else if (o.text) {
      input.setAttribute('value', o.text);
      for (const el of [...$('.cloud-chips', x.cloud).children]) el.style.display = 'none';
      $('.cloud-chips', x.cloud).insertAdjacentHTML('beforeend', `<span ${x.NGC} class="row-label jira">jira · nothing found</span>`);
      items.push(chip(x, '▶', `Start timer «${o.text}»`, 'tm-start'), chip(x, '＋', `Create «${o.text}» in Jira`, 'tm-create'));
    } else {
      items.push(chip(x, '▶', 'Start timer', 'tm-start'), chip(x, '＋', 'Create in Jira…', 'tm-create'));
    }
    $('.cloud-body', x.cloud).insertAdjacentHTML('afterend', `<div class="tmf">${items.join('')}</div>`);
  }

  // offsets in layout pixels, taken before the zoom
  function offsetIn(el, root) {
    let left = 0, top = 0;
    for (let n = el; n && n !== root; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  }
  function place(x) {
    if (x.cloud.classList.contains('open')) x.cloud.style.top = `${offsetIn(x.head, x.app).bottom - 4}px`;
    if (x.menu) {
      const a = offsetIn(x.anchor, x.app);
      x.menu.style.top = `${a.bottom + 6}px`;
      x.menu.style.left = x.menuSide === 'right'
        ? `${Math.max(8, a.right - x.menu.offsetWidth + 4)}px`
        : `${Math.max(8, a.left - 10)}px`;
    }
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

  const s1 = section('1 · K: капсула → меню → облако',
    'Таймеров больше одного — клик по капсуле открывает маленькое стеклянное меню (язык меню карточек). Клик по строке — стандартное облако выбора тикета; ⏸/▶ и ✕ — прямо в строке меню.');
  {
    const x = mkCell(250);
    anchor(x, 'K', T1);
    menu(x, [T1, T2], 'right');
    cell(s1, x, '<b>Два таймера → меню</b><br>строка: ⏸/▶ · время · описание · ✕');
  }
  {
    const x = mkCell(430);
    anchor(x, 'K', T1);
    cloud(x, 'pick', { desc: T1.desc });
    cell(s1, x, '<b>Клик по строке → облако выбора тикета</b><br>то же облако, что открывает task? у подсказки; чип → таймер уходит в карточку, total растёт');
  }

  const s2 = section('2 · Таймер один — где тогда ⏸ и ✕?',
    'Если единственный таймер открывает сразу облако, паузе и удалению негде жить: облако — только про тикет. Меню из одной строки — на один клик дольше до тикета, зато управление всегда в одном месте.');
  {
    const x = mkCell(430);
    anchor(x, 'K', T1);
    cloud(x, 'pick', { desc: T1.desc });
    cell(s2, x, '<b>Один → сразу облако</b> (твоё правило)<br>быстрее к тикету; ⏸ и ✕ нет');
  }
  {
    const x = mkCell(250);
    anchor(x, 'K', T1);
    menu(x, [T1], 'right');
    cell(s2, x, '<b>Один → меню из одной строки</b> (моя ставка)<br>пауза за 2 клика, к тикету — тоже 2');
  }

  const s3 = section('3 · L: то же от лейбла в заголовке окна',
    'Аккуратнее и тише: шапка дня не меняется. Цена — меню падает из заголовка, а облако живёт на вкладке Day: с Timesheets / Settings клик по строке сначала переключает на Day.');
  {
    const x = mkCell(250, true);
    anchor(x, 'L', T1);
    menu(x, [T1, T2], 'left');
    cell(s3, x, '<b>Лейбл → то же меню</b><br>строки и действия — как в K');
  }

  const s4 = section('4 · Облако + Log — одно на всё, списка таймеров в нём нет',
    'Таймер в облаке только рождается: Start timer внизу или Start timer «текст», если текст не нашёл тикет. Привязка — то же облако в режиме выбора тикета (раздел 1).');
  {
    const x = mkCell(430);
    anchor(x, 'K', T1);
    cloud(x, 'log');
    cell(s4, x, '<b>+ Log, фильтр пуст</b><br>внизу ▶ Start timer · Create in Jira');
  }
  {
    const x = mkCell(250);
    cloud(x, 'log', { text: TEXT });
    cell(s4, x, '<b>+ Log, текст не нашёл тикет</b><br>▶ Start timer «текст» — текст становится описанием');
  }

  for (const x of cells) place(x);
  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('.7');
})();
