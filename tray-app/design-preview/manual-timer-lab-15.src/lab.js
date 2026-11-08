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
  // the timer's identity (the titlebar dial at rest)
  const DIAL = '<svg class="g-dial" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 1.2h3.2M8 1.2v2.2"/><circle cx="8" cy="9.2" r="5.6"/><path d="M8 9.2V6.2"/></svg>';

  const TEXT = 'разбор 500-х на checkout';
  const VARIANTS = {
    A: { name: 'A · «+ Log», таймер внутри облака', plus: false, headStart: false, filterPlay: false, footStart: true },
    B: { name: 'B · «+», таймер внутри облака', plus: true, headStart: false, filterPlay: false, footStart: true },
    C: { name: 'C · «+ Log» и кнопка таймера рядом', plus: false, headStart: true, filterPlay: false, footStart: false },
    D: { name: 'D · «+ Log», ▶ в строке поиска облака', plus: false, headStart: false, filterPlay: true, footStart: false },
  };

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    $('.header', app).remove();
    const x = {
      cv, app,
      head: $('.day-head', app),
      logBtn: $('.g-btn', app),
      cloud: $('app-log-cloud', app),
      backdrop: $('.cloud-backdrop', app),
    };
    x.NGC = ngOf($('.fav', x.cloud));
    return x;
  }

  // Header: unbound timers as capsules left of + Log (the + Log · total pair stays whole).
  function header(x, v, timers = []) {
    if (v.plus) {
      x.logBtn.classList.add('v-plus');
      for (const n of [...x.logBtn.childNodes]) if (n.nodeType === 3) n.remove();
    }
    const row = document.createElement('span');
    row.className = 'tmc-row';
    for (const t of timers) {
      row.insertAdjacentHTML('beforeend', t.run
        ? `<span class="tmc candy run">${PLAY}<b>${t.time}</b></span>`
        : '<span class="tmc candy round paused">' + PZ + '</span>');
    }
    if (v.headStart) row.insertAdjacentHTML('beforeend', `<span class="tmc candy round start">${DIAL}</span>`);
    if (row.children.length) x.logBtn.before(row);
  }

  const chip = (x, task, name, cls) => `<span ${x.NGC} class="fav ${cls}"><span ${x.NGC} class="f-task">${task}</span><span ${x.NGC} class="f-name">${esc(name)}</span></span>`;

  // Cloud open under the header; mode: 'empty' | 'nomatch' | 'form' | 'bind'.
  function cloud(x, v, mode) {
    x.app.append(x.backdrop, x.cloud);
    x.cloud.classList.add('open');
    x.backdrop.classList.add('open');
    const input = $('.cloud-filter input', x.cloud);
    const chips = $('.cloud-chips', x.cloud);
    const text = mode === 'nomatch' ? TEXT : '';
    input.setAttribute('value', text);
    if (mode === 'bind') input.setAttribute('placeholder', 'ticket for the timer · no match → search Jira');
    if (v.filterPlay) {
      $('.f-batch', x.cloud).insertAdjacentHTML('beforebegin', `<button type="button" class="f-play${text ? ' lit' : ''}">${PLAY}timer</button>`);
    }
    if (mode === 'nomatch') {
      for (const el of [...chips.children]) el.style.display = 'none';
      chips.insertAdjacentHTML('beforeend', `<span ${x.NGC} class="row-label jira">jira · nothing found</span>`);
    }
    // footer under the chips: the timer's way in (A/B; C/D only with typed text) + Create in Jira
    const items = [];
    if (mode === 'empty' && v.footStart) items.push(chip(x, '▶', 'Start timer', 'tm-start'));
    if (mode === 'nomatch' && !v.filterPlay) items.push(chip(x, '▶', `Start timer «${TEXT}»`, 'tm-start'));
    if (mode === 'empty' || mode === 'bind') items.push(chip(x, '＋', 'Create in Jira…', 'tm-create'));
    if (mode === 'nomatch') items.push(chip(x, '＋', `Create «${TEXT}» in Jira`, 'tm-create'));
    if (items.length) $('.cloud-body', x.cloud).insertAdjacentHTML('afterend', `<div class="tmf">${items.join('')}</div>`);

    if (mode === 'bind') {
      // the clicked capsule's own line on top: pause · time · description · ✕
      x.cloud.insertAdjacentHTML('afterbegin', `<div class="tmb"><button type="button" class="tmb-g candy run">${PZ}</button>`
        + `<b class="tmb-time">47m 15s</b><input class="tmb-desc" value="${esc(TEXT)}" placeholder="what is it?">`
        + `<button type="button" class="tmb-x">${X}</button></div>`);
    }
    if (mode === 'form') {
      x.cloud.classList.add('form-mode');
      const N = x.NGC;
      x.cloud.insertAdjacentHTML('beforeend', `<div ${N} class="cloud-form"><div ${N} class="cf-top"><span ${N} class="cf-key">ATL-7014</span>`
        + `<span ${N} class="cf-name">Save pipeline drops middle names on import</span></div><div ${N} class="cf-ctl">`
        + `<button ${N} type="button" class="cf-back">←</button><select ${N} class="cf-act"><option>Development</option></select>`
        + `<input ${N} class="cf-min" placeholder="45m"><input ${N} class="cf-desc" placeholder="description">`
        + `<button type="button" class="cf-play candy">${PLAY}</button><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
    }
  }
  function placeCloud(x) {
    if (!x.cloud.classList.contains('open')) return;
    let top = 0;
    for (let el = x.head; el && el !== x.app; el = el.offsetParent) top += el.offsetTop;
    x.cloud.style.top = `${top + x.head.offsetHeight - 4}px`;
  }

  // ── the grid ─────────────────────────────────────────────────────
  const grid = $('#grid');
  const cells = [];
  function cell(row, x, cap) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.append(x.cv);
    c.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`);
    row.append(c);
    cells.push(x);
  }
  function section(title, note) {
    grid.insertAdjacentHTML('beforeend', `<h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}<div class="row"></div>`);
    return grid.lastElementChild;
  }

  const CAPS = {
    rest: {
      A: 'одна кнопка на всё время дня',
      B: 'кнопка без слова: «+» = добавить время, любым источником',
      C: 'рядом своя кнопка таймера — старт без тикета в один клик, без облака',
      D: 'шапка как сегодня',
    },
    timers: {
      A: 'идёт таймер без тикета — капсула с временем; второй на паузе — круглая',
      B: 'то же; рядом с круглым «+» круглый ⏸ — похожи',
      C: 'три кнопки справа: ⏸ · идущий · новый',
      D: 'то же, что A',
    },
    empty: {
      A: 'фильтр пуст — внизу ▶ Start timer рядом с Create in Jira',
      B: 'то же, что A',
      C: 'старт без тикета уже был в шапке — внизу только Create in Jira',
      D: '▶ timer в строке поиска, рядом с ⧉ multi — язык самого облака',
    },
    nomatch: {
      A: 'текст не нашёлся — ▶ Start timer «текст»: текст = описание',
      B: 'то же, что A',
      C: 'то же, что A — «нашёлся текст, а тикета нет» остаётся входом и здесь',
      D: '▶ timer загорелся: стартует с этим текстом как описанием',
    },
  };

  const rows = [
    ['Покой — что видно, пока таймеров нет', 'rest', 128, []],
    ['Идёт таймер без тикета, второй на паузе', 'timers', 128, [{ run: false }, { run: true, time: '47m 15s' }]],
    ['Облако открыто, фильтр пуст', 'empty', 440, []],
    [`Облако: набрали «${TEXT}» — ни один тикет не подошёл`, 'nomatch', 300, []],
  ];
  for (const [title, key, h, timers] of rows) {
    const row = section(title);
    for (const [id, v] of Object.entries(VARIANTS)) {
      const x = mkCell(h);
      header(x, v, timers);
      if (key === 'empty' || key === 'nomatch') cloud(x, v, key);
      cell(row, x, `<b>${v.name}</b><br>${CAPS[key][id]}`);
    }
  }

  const shared = section('Общее для всех вариантов',
    'После выбора тикета — обычная форма облака, ▶ рядом с Log: минуты пустые → счёт с нуля, минуты вписаны → счёт с них (забыл запустить — вписал 45m и ▶). Клик по капсуле — то же облако выбора тикета, сверху строка этого таймера.');
  {
    const x = mkCell(300);
    header(x, VARIANTS.A);
    cloud(x, VARIANTS.A, 'form');
    cell(shared, x, '<b>Тикет выбран → форма</b><br>▶ — считать вместо ввода; Log — как сегодня');
  }
  {
    const x = mkCell(440);
    header(x, VARIANTS.A, [{ run: true, time: '47m 15s' }]);
    cloud(x, VARIANTS.A, 'bind');
    cell(shared, x, '<b>Клик по капсуле → привязка</b><br>сверху: ⏸ · время · описание · ✕; чип тикета → капсула уходит, строка в карточке, total растёт');
  }

  // positions are taken before the zoom so offsets stay in layout pixels
  for (const x of cells) placeCloud(x);
  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('.7');
})();
