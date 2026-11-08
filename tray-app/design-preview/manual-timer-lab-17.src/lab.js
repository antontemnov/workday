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
  const DIAL_S = '<svg class="g-dial" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 1.2h3.2M8 1.2v2.2"/><circle cx="8" cy="9.2" r="5.6"/><path d="M8 9.2V6.2"/></svg>';
  // the titlebar dial (v12 T2): sector = minutes of the hour, red bars when paused
  function dialSvg(run, min) {
    const fr = (min % 60) / 60, a = fr * 2 * Math.PI, cx = 8, cy = 9.2, rs = 4.1, rh = 3.4;
    const sec = `<path class="sec" d="M${cx} ${cy} L${cx} ${(cy - rs).toFixed(2)} A${rs} ${rs} 0 ${fr > 0.5 ? 1 : 0} 1 ${(cx + rs * Math.sin(a)).toFixed(2)} ${(cy - rs * Math.cos(a)).toFixed(2)} Z"/>`;
    const inner = run
      ? `<path class="hand" d="M${cx} ${cy} L${(cx + rh * Math.sin(a)).toFixed(2)} ${(cy - rh * Math.cos(a)).toFixed(2)}"/>`
      : '<rect class="pz" x="5.85" y="7.1" width="1.55" height="4.2" rx=".55"/><rect class="pz" x="8.6" y="7.1" width="1.55" height="4.2" rx=".55"/>';
    return `<svg class="tm-dial" viewBox="0 0 16 16" aria-hidden="true"><path class="crown" d="M6.4 1.2h3.2M8 1.2v2.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5.6"/>${sec}${inner}</svg>`;
  }

  const T1 = { desc: 'разбор 500-х на checkout', time: '47m 15s' };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s' };

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

  // ── where an anonymous timer shows when the cloud is closed ───────
  function headerShow(x, how, run) {
    const time = run ? T1.time : T1.time;
    const g = run ? PLAY : PZ;
    if (how === 'caps') {
      x.logBtn.insertAdjacentHTML('beforebegin', `<span class="tmc-row"><span class="tmc candy ${run ? 'run' : 'paused'}">${g}<b>${time}</b></span></span>`);
    }
    if (how === 'title') {
      const sw = $('.view-switcher', x.title);
      sw.insertAdjacentHTML('afterend', `<span class="tm-ndiv"></span><span class="tm-nav ${run ? 'run' : 'pause'}"><span class="tm-dw">${dialSvg(run, 47)}</span><span class="tm-min">${time}</span></span>`);
    }
  }

  // ── the cloud with the anonymous timers as its first section ──────
  function openCloud(x, o = {}) {
    x.app.append(x.backdrop, x.cloud);
    x.cloud.classList.add('open');
    x.backdrop.classList.add('open');
    const N = x.NGC;
    if (o.timers) {
      const rows = o.timers.map((t, i) => `<div class="tmr-row${t.run ? ' run' : ''}${o.sel === i ? ' sel' : ''}">`
        + `<button type="button" class="tmr-g">${t.run ? PLAY : PZ}</button><b class="tmr-time">${t.time}</b>`
        + `<span class="tmr-desc">${esc(t.desc)}</span><button type="button" class="tmr-key">task?</button>`
        + `<button type="button" class="tmr-x">${X}</button></div>`).join('');
      const foot = `<div class="tmf">${chip(x, '▶', 'Start timer', 'tm-start')}${chip(x, '＋', 'Create in Jira…', 'tm-create')}</div>`;
      $('.cloud-body', x.cloud).insertAdjacentHTML('afterend', `<div class="tmr bottom"><span ${N} class="row-label tmr-lbl">timers</span>${rows}</div>${foot}`);
      if (o.sel != null) $('.cloud-filter input', x.cloud).setAttribute('placeholder', `ticket for «${o.timers[o.sel].desc}»`);
    }
    if (o.form) {
      x.cloud.classList.add('form-mode');
      x.cloud.insertAdjacentHTML('beforeend', `<div ${N} class="cloud-form"><div ${N} class="cf-top"><span ${N} class="cf-key">ATL-7014</span>`
        + `<span ${N} class="cf-name">Save pipeline drops middle names on import</span></div><div ${N} class="cf-ctl">`
        + `<button ${N} type="button" class="cf-back">←</button><select ${N} class="cf-act"><option>Development</option></select>`
        + `<input ${N} class="cf-min" ${o.form.min ? `value="${o.form.min}"` : 'placeholder="45m"'}>`
        + `<button type="button" class="cf-tm${o.form.on ? ' on' : ''}">${DIAL_S}timer</button>`
        + `<input ${N} class="cf-desc" placeholder="description"><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
    }
  }
  const chip = (x, task, name, cls) => `<span ${x.NGC} class="fav ${cls}"><span ${x.NGC} class="f-task">${task}</span><span ${x.NGC} class="f-name">${esc(name)}</span></span>`;
  function placeCloud(x) {
    if (!x.cloud.classList.contains('open')) return;
    let top = 0;
    for (let el = x.head; el && el !== x.app; el = el.offsetParent) top += el.offsetTop;
    x.cloud.style.top = `${top + x.head.offsetHeight - 4}px`;
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

  const HOWS = [
    ['caps', 'K · отдельная капсула рядом с + Log', 'своя капсула, не сегмент + Log; на паузе — то же время, серое'],
    ['title', 'L · лейбл в заголовке окна', 'шапка дня не меняется; циферблат + время видны с любой вкладки'],
  ];
  const head = section('1 · Облако закрыто: где видно анонимный таймер',
    'Показывается один — идущий, а если ни один не идёт — последний на паузе; остальные — только в облаке (две полные капсулы в 500px не помещаются). Управление — только из облака + Log.');
  for (const [how, name, note] of HOWS) {
    for (const run of [true, false]) {
      const x = mkCell(how === 'title' ? 164 : 128, how === 'title');
      headerShow(x, how, run);
      cell(head, x, `<b>${name}</b> · ${run ? 'идёт' : 'на паузе'}<br>${note}`);
    }
  }

  const cl = section('2 · Облако + Log: анонимные таймеры — внизу, рядом со Start timer',
    'Сверху облако как сегодня — поиск и чипы для обычного Log. Всё про таймеры собрано внизу: свои строки и Start timer.');
  {
    const x = mkCell(470);
    headerShow(x, 'caps', true);
    openCloud(x, { timers: [{ ...T1, run: true }, { ...T2 }] });
    cell(cl, x, '<b>Клик по + Log</b><br>сверху — обычный Log; внизу timers: ▶/⏸ · время · описание · task? · ✕, под ними Start timer');
  }
  {
    const x = mkCell(470);
    headerShow(x, 'caps', true);
    openCloud(x, { timers: [{ ...T1, run: true }, { ...T2 }], sel: 0 });
    cell(cl, x, '<b>task? у таймера → привязка</b><br>строка выбрана, поиск ищет тикет для неё; чип → таймер уходит в карточку тикета, total растёт; Esc — обратно к обычному Log');
  }

  const fm = section('3 · Форма после выбора тикета: одна кнопка Log, таймер — опция',
    'Переключатель того же вида, что ⧉ multi. Выключен — форма как сегодня. Включён — Log пишет запись с вписанными минутами (пусто = 0), и дальше её питает таймер.');
  {
    const x = mkCell(250);
    openCloud(x, { form: { on: false } });
    cell(fm, x, '<b>timer выключен</b><br>как сегодня');
  }
  {
    const x = mkCell(250);
    openCloud(x, { form: { on: true, min: '45m' } });
    cell(fm, x, '<b>timer включён, вписано 45m</b><br>«залогировал 45 минут и дальше по таймеру»');
  }

  for (const x of cells) placeCloud(x);
  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('.7');
})();
