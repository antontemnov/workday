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
  const CLOCK = '<svg class="g-clock" viewBox="0 0 10 10" aria-hidden="true"><path d="M4 .8h2M5 .8v1.4"/><circle cx="5" cy="5.9" r="3.4"/><path d="M5 5.9V4.2"/></svg>';
  const ARR = { prev: '<svg class="g-arr" viewBox="0 0 8 12" aria-hidden="true"><path d="M5.6 2.2L2.2 6l3.4 3.8"/></svg>',
    next: '<svg class="g-arr" viewBox="0 0 8 12" aria-hidden="true"><path d="M2.4 2.2L5.8 6 2.4 9.8"/></svg>' };

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, title: $('.header', app), head: $('.day-head', app), lp: $('.lp-table', app) };
    const N = ngOf(x.title);
    x.title.insertAdjacentHTML('beforeend', `<div ${N} class="win-controls"><button ${N} class="wc-btn" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1 5.5h8"/></svg></button><button ${N} class="wc-btn wc-close" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
    return x;
  }
  // a timer runs → sessions yield
  function sessionsPaused(x) {
    for (const r of $$('.blk.hot app-session-row', x.app)) {
      r.classList.remove('lead'); r.classList.add('paused');
      const tb = $('.tb', r);
      if (tb) { tb.classList.remove('lead'); tb.classList.add('willp'); }
    }
  }

  // ── the timer line ───────────────────────────────────────────────
  // o: { state: run | pause, time, desc | label, key (bound) , prev, next }
  // where: top — the titlebar's second storey; head — under + Log
  function line(x, o, where = 'top') {
    const arr = (k) => (where === 'top' ? `<span class="tml-arr">${o[k] ? ARR[k] : ''}</span>` : '');
    const desc = o.label ? `<span class="tml-desc"><span class="tml-pill">${o.label}</span></span>` : `<span class="tml-desc">${esc(o.desc)}</span>`;
    const dest = o.key ? `<span class="tml-key bound">${o.key}</span>` : '<span class="tml-key">task?</span>';
    const html = `<div class="tml ${o.state}${where === 'head' ? ' inhead' : ''}">${arr('prev')}`
      + `<span class="tml-g">${o.state === 'run' ? PLAY : PZ}</span><b class="tml-time">${o.time}</b>${desc}${dest}`
      + `${o.key ? '<span class="tml-x"></span>' : `<span class="tml-x">${X}</span>`}${arr('next')}</div>`;
    if (where === 'top') {
      x.title.classList.add('has-tml');
      x.title.insertAdjacentHTML('afterend', html);
    } else {
      x.head.classList.add('has-tml');
      x.head.insertAdjacentHTML('beforeend', html);
    }
    if (o.state === 'run') sessionsPaused(x);
  }
  // a record the bound timer feeds: live time, ⏱ after the description, no button
  function liveRec(x, task, eid, time) {
    const row = $(`.blk[data-task="${task}"] .wl.ent[data-eid="${eid}"]`, x.app);
    row.classList.add('tm-live');
    $('.c-dur', row).textContent = time;
    $('.c-ds', row).insertAdjacentHTML('beforeend', `<span class="tmk">${CLOCK}</span>`);
  }
  // timer added: its own label next to manual added; pause sits inside it, in the ⊕ slot
  function timerAdded(x, time) {
    const man = $('.blk.hot .wl.manline', x.app);
    const row = man.cloneNode(true);
    const N = ngOf(row);
    const ds = $('.c-ds', row);
    ds.classList.add('tadd');
    ds.innerHTML = `<span ${N}>timer added</span><span class="tmk in run"><svg ${N} width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" class="mg"><circle ${N} cx="4.5" cy="4.5" r="3.9" fill="none" stroke="currentColor" stroke-width=".9"/><path ${N} d="M3.5 3v3M5.5 3v3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg></span>`;
    $('.c-dur', row).textContent = time;
    row.classList.add('tm-live');
    man.after(row);
  }
  const noSuggestions = (x) => { const m = $('.lp-mid', x.app); if (m) m.style.display = 'none'; };

  // ── the grid ─────────────────────────────────────────────────────
  const grid = $('#grid');
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
  }

  const s1 = section('1 · Строка над датой — второй этаж заголовка окна',
    'Не карточка и не лоток: тот же фон, что у заголовка, одна линия под ним. Выравнивание по дате. Глиф — язык пилюли сессии: светящийся ▶ = идёт, красный ⏸ = пауза (руками или git-правка перехватила); клик — переключить. <b>task?</b> — облако выбора тикета (то же, что у подсказки). ✕ — выбросить. Строки нет, пока нет таймера без тикета.');
  {
    const x = mkCell(250);
    line(x, { state: 'run', time: '47m 15s', desc: 'разбор 500-х на checkout' });
    cell(s1, x, '<b>Один таймер без тикета, идёт</b><br>сессии уступили (Paused); total не тронут — время пока ничьё');
  }
  {
    const x = mkCell(250);
    line(x, { state: 'run', time: '12m 40s', desc: 'помог соседней команде с деплоем', prev: true });
    cell(s1, x, '<b>Таймеров без тикета два — виден один</b><br>идущий; второй — только стрелкой ‹ у края окна, без счётчика');
  }
  {
    const x = mkCell(250);
    line(x, { state: 'pause', time: '47m 15s', desc: 'разбор 500-х на checkout', next: true });
    cell(s1, x, '<b>Листнул ‹ — второй на его месте</b><br>на паузе; ▶ — он пошёл, первый встал (один источник за раз)');
  }

  const s2 = section('2 · Предложение: строка = сам источник, и с тикетом тоже',
    'Пока таймер питает запись, строка остаётся и показывает, куда течёт время: вместо <b>task?</b> — ключ. Тогда «виден один таймер» — буквально: пауза всегда в одном месте, при любой прокрутке, а в ленте у записи только светящееся время и ⏱, без круглой ⏸. Строка есть, пока таймер идёт или держит ничьё время; поставил на паузу таймер с тикетом — строка уходит (время уже в записи, продолжить — ▶ в её меню).');
  {
    const x = mkCell(560);
    noSuggestions(x);
    line(x, { state: 'run', time: '47m 13s', desc: 'PR #214 review with team', key: 'ATL-6712' });
    liveRec(x, 'ATL-6712', 'm2', '47m 13s');
    cell(s2, x, '<b>Таймер питает запись с описанием</b><br>строка: ключ вместо task?; в ленте запись светится, ⏱ после описания');
  }
  {
    const x = mkCell(400);
    line(x, { state: 'run', time: '12m 40s', label: 'timer added', key: 'ATL-6781' });
    timerAdded(x, '12m 40s');
    cell(s2, x, '<b>Голое время — отдельная бирка timer added</b><br>рядом с manual added, не внутри неё; пауза — внутри бирки, на месте ⊕');
  }

  const s3 = section('3 · Для сравнения: та же строка под + Log',
    'Шапка дня растёт на этаж, а ничьё время встаёт под total, в который оно не входит, — читается как его часть. Пара + Log · total перестаёт быть законченной строкой.');
  {
    const x = mkCell(250);
    line(x, { state: 'run', time: '47m 15s', desc: 'разбор 500-х на checkout' }, 'head');
    cell(s3, x, '<b>Под + Log</b><br>видна только на Day');
  }

  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('.7');
})();
