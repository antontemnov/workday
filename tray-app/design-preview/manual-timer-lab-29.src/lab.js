(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ngOf = (el) => [...el.attributes].find((a) => a.name.startsWith('_ngcontent')).name;

  // ── glyphs (own SVG — no SF Symbols) ─────────────────────────────
  // the timer icon: a ring + a hand to 12; paused — two bars inside the ring
  const ic = (st) => `<svg class="t-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/>${
    st === 'pause' || st === 'yield' ? '<path class="bars" d="M5.7 5.1v3.8M8.3 5.1v3.8"/>' : '<path d="M7 7V3.8"/>'}</svg>`;
  const PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.8 1.5l5.6 3.5-5.6 3.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.3 2.2v5.6M6.7 2.2v5.6"/></svg>';
  const X = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6"/></svg>';
  const PLUS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';

  const T1 = { desc: 'разбор 500-х на checkout', time: '47m 15s' };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s' };
  const TS = { desc: 'созвон по инциденту', time: '47m 15s' };
  const TL = { desc: 'разбор 500-х на checkout после выкладки платёжного шлюза', time: '47m 15s' };
  const TH = { desc: TS.desc, time: '1h 05m' };
  const TB = { desc: '', time: '0m 04s' };

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  const TABS = ['Day', 'Timesheets', 'Settings'];
  function mkCell(height, o = {}) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, hdr: $('.header', app), head: $('.day-head', app), cloud: $('app-log-cloud', app), backdrop: $('.cloud-backdrop', app) };
    const N = ngOf(x.hdr);
    x.hdr.insertAdjacentHTML('beforeend', `<div ${N} class="win-controls"><button ${N} class="wc-btn" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1 5.5h8"/></svg></button><button ${N} class="wc-btn wc-close" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
    x.wc = $('.win-controls', x.hdr);
    if (!o.icons) {
      const view = o.view || 'Day';
      x.hdr.classList.add('words');
      $('.view-switcher', x.hdr).insertAdjacentHTML('afterend', `<div class="tabs">${TABS.map((w) => `<button type="button" class="tab-w${w === view ? ' active' : ''}">${w}</button>`).join('')}</div>`);
      x.tabs = $('.tabs', x.hdr);
      if (view === 'Timesheets') {
        const day = $('app-day-view', app);
        day.style.display = 'none';
        day.after($('#tpl-sheet').content.firstElementChild.cloneNode(true));
      }
    }
    return x;
  }
  // yield: while a timer runs, the live session waits (the red ⏸ pill)
  function sessionsPaused(x) {
    for (const r of $$('.blk.hot app-session-row.lead', x.app)) {
      r.classList.remove('lead'); r.classList.add('paused');
      const tb = $('.tb', r);
      if (tb) { tb.classList.remove('lead'); tb.classList.add('willp'); }
    }
  }
  function keepSuggestions(x, n) {
    $$('app-suggestion-row', x.app).forEach((el, i) => { if (i >= n) el.style.display = 'none'; });
  }

  // ── the timer: one element in the app header ─────────────────────
  // o.st:    idle | run | pause | yield
  // o.place: right (before the window buttons) | mid (centre of the free space) | center (centre of the window)
  // o.sep:   b0 flush, like a third button | b1 gap + hairline | b2 gap, at rest — the chip's outline
  // o.desc:  none | left (dim italic, left of the chip) | in (inside the chip) | after (right of the island)
  function timer(x, o) {
    const st = o.st, place = o.place || 'right', sep = o.sep || 'b1', t = o.t || {};
    let el;
    if (st === 'idle') {
      el = sep === 'b2' && place === 'right' ? `<span class="tchip ghost">${ic(st)}</span>` : `<span class="tidle${sep === 'b0' && place === 'right' ? ' slot' : ''}">${ic(st)}</span>`;
    } else {
      const inner = o.desc === 'in' && t.desc ? `<span class="tchip-desc">${esc(t.desc)}</span>` : '';
      el = `<span class="tchip ${st}${inner ? ' wide' : ''}">${ic(st)}<b class="tchip-time" style="width:${t.time.length}ch">${t.time}</b>${inner}</span>`;
    }
    const shown = st !== 'idle' && t.desc && !o.open;
    const left = o.desc === 'left' && shown ? `<span class="tmz-desc">${esc(t.desc)}</span>` : '';
    const after = o.desc === 'after' && shown ? `<span class="tmz-desc after">${esc(t.desc)}</span>` : '';
    const rule = place === 'right' && sep === 'b1' ? '<i class="tm-rule"></i>' : '';
    x.wc.insertAdjacentHTML('beforebegin', `<span class="tmz ${place}${place === 'right' ? ` ${sep}` : ''} ${st}">${left}${el}${after}${rule}</span>`);
    x.zone = x.wc.previousElementSibling;
    x.anchor = $('.tchip, .tidle', x.zone);
    x.place = place;
    if (st === 'run') sessionsPaused(x);
  }

  // ── the chip unfolded ────────────────────────────────────────────
  // rows: [{ t, st: run | pause | yield, focus }] · o.go: green | neutral · o.newTimer
  function panel(x, rows, o = {}) {
    const go = o.go || 'green';
    const html = rows.map((r) => {
      const btn = r.st === 'run' ? `<button type="button" class="tbtn pz">${PAUSE}</button>` : `<button type="button" class="tbtn go ${go}">${PLAY}</button>`;
      const field = r.focus ? '<span class="tfield focus"><i class="caret"></i><span class="ph">description</span></span>' : `<span class="tfield">${esc(r.t.desc)}</span>`;
      return `<div class="trow ${r.st}">${btn}<b class="ttime">${r.t.time}</b>${field}<span class="tkey">task?</span><button type="button" class="tx">${X}</button></div>`;
    }).join('');
    const nt = o.newTimer ? `<div class="tsep"></div><div class="tnew ${go}"><span class="nt-g">${PLAY}</span><span>New timer</span></div>` : '';
    x.app.insertAdjacentHTML('beforeend', `<div class="tpanel">${html}${nt}</div>`);
    x.panel = x.app.lastElementChild;
  }

  // ── the + Log cloud: a typed text found no ticket ────────────────
  const chip = (x, glyph, name, cls) => `<span ${x.NGC} class="fav tm-act ${cls}"><span ${x.NGC} class="f-task">${glyph}</span><span ${x.NGC} class="f-name">${esc(name)}</span></span>`;
  function cloud(x, text, go) {
    x.NGC = ngOf($('.fav', x.cloud));
    x.app.append(x.backdrop, x.cloud);
    x.cloud.classList.add('open');
    x.backdrop.classList.add('open');
    $('.cloud-filter input', x.cloud).setAttribute('value', text);
    for (const el of [...$('.cloud-chips', x.cloud).children]) el.style.display = 'none';
    $('.cloud-chips', x.cloud).insertAdjacentHTML('beforeend', `<span ${x.NGC} class="row-label jira">jira · nothing found</span>`);
    $('.cloud-body', x.cloud).insertAdjacentHTML('afterend', `<div class="tmf">${chip(x, PLAY, `Start timer «${text}»`, `tm-start ${go}`)}${chip(x, PLUS, `Create «${text}» in Jira…`, 'tm-create')}</div>`);
  }

  // offsets in layout pixels (the zoom does not change them)
  function offsetIn(el, root) {
    let left = 0, top = 0;
    for (let n = el; n && n !== root; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  }
  function place(x) {
    const W = x.app.offsetWidth, hb = x.hdr.offsetHeight;
    const after = x.zone && $('.tmz-desc.after', x.zone);
    if (after) after.style.maxWidth = `${W - x.wc.offsetWidth - 10 - (W / 2 + x.anchor.offsetWidth / 2 + 8)}px`;
    if (x.panel) x.panel.style.top = `${hb + 4}px`;
    if (x.cloud.classList.contains('open')) {
      x.cloud.style.top = `${offsetIn(x.head, x.app).bottom - 4}px`;
      x.backdrop.style.top = `${hb}px`;
    }
  }

  // ── the grid ─────────────────────────────────────────────────────
  const grid = $('#grid');
  const cells = [];
  const M = {};
  // cols — a fixed matrix (a variant per line); otherwise the cells wrap
  function section(title, note, cols) {
    grid.insertAdjacentHTML('beforeend', `<h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}<div class="row${cols ? ' matrix' : ''}"${cols ? ` style="--cols:${cols}"` : ''}></div>`);
    return grid.lastElementChild;
  }
  function cell(row, x, cap, key) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.append(x.cv);
    c.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`);
    row.append(c);
    cells.push(x);
    if (key) { M[key] = x; c.dataset.k = key; }
  }
  const HEAD = 84; // the header (29) + the day head (48) + a strip of the feed

  // 1 ─ words instead of icons
  const s1 = section('1 · Шапка приложения — тулбар: слева слова, справа значки',
    'Слова = куда перейти, значки = что происходит сейчас. Активная вкладка светлее, остальные тусклые; без подчёркиваний, рамок и подложек. Вкладка Day больше не нарисована часами — значок часов в шапке остаётся один, и он про таймер.');
  {
    const x = mkCell(HEAD, { icons: true });
    cell(s1, x, '<b>Сегодня</b><br>три иконки вкладок; справа только кнопки окна', 'today');
  }
  {
    const x = mkCell(HEAD);
    timer(x, { st: 'idle' });
    cell(s1, x, '<b>Вкладки словами · таймер в покое</b><br>тусклый значок: кольцо и стрелка к 12; клик = таймер идёт с клика', 'words');
  }
  {
    const x = mkCell(HEAD, { view: 'Timesheets' });
    timer(x, { st: 'run', t: T1 });
    cell(s1, x, '<b>Вкладка Timesheets · таймер идёт</b><br>чип виден и управляется с любой вкладки', 'sheet');
  }

  // 2 ─ question (б): the timer vs the window buttons
  const s2 = section('2 · Вопрос (б) — как отделить таймер от кнопок «свернуть» и «закрыть»',
    'Слева — покой, справа — таймер идёт. <b>Б0</b> — контроль: значок в такой же ячейке, того же размера и штриха, что у кнопок окна (читается третьей кнопкой). <b>Б1</b> — отступ и тонкая черта. <b>Б2</b> — в покое не значок, а тусклый контур будущего чипа. <b>Б3</b> — по центру шапки, далеко от кнопок окна.', 2);
  const SEP = [
    ['b0', 'right', '<b>Б0 · вплотную (контроль)</b>', 'значок = третья кнопка окна', 'чип в 4px от «свернуть»'],
    ['b1', 'right', '<b>Б1 · отступ + черта</b>', 'значок крупнее и толще штрихом, за чертой — кнопки окна', 'чип, отступ, черта'],
    ['b2', 'right', '<b>Б2 · контур чипа</b>', 'пустая «лунка» — форма чипа, а не глиф кнопки; черты нет', 'лунка залилась: тот же чип на том же месте'],
    ['b0', 'center', '<b>Б3 · по центру</b>', 'значок посередине шапки', 'чип-«остров» посередине шапки'],
  ];
  for (const [sep, pl, name, idle, run] of SEP) {
    for (const st of ['idle', 'run']) {
      const x = mkCell(HEAD);
      timer(x, { st, t: T1, sep, place: pl });
      cell(s2, x, `${name} · ${st === 'idle' ? 'покой' : 'идёт'}<br>${st === 'idle' ? idle : run}`, `${pl === 'center' ? 'b3' : sep}-${st}`);
    }
  }

  // 3 ─ question (а): the description in plain sight
  const s3 = section('3 · Вопрос (а) — описание видно сразу',
    'Слева — короткое описание (19 знаков), справа — длинное: в шапку помещается около 22 знаков, дальше многоточие. Клик по видимому описанию = раскрыть строку с курсором в поле; наведение — только под самим текстом. Пустое описание места в шапке не занимает (кадр выглядит как Д0). Отделение от кнопок окна здесь — Б1.', 2);
  const DESC = [
    ['d0', { desc: 'none' }, '<b>Д0 · только в раскрытой строке</b> (контроль)', 'описания в шапке нет — один клик по чипу'],
    ['d1', { desc: 'left' }, '<b>Д1 · слева от чипа</b>', 'тусклый курсив в пустой зоне шапки, прижат к чипу'],
    ['d2', { desc: 'in' }, '<b>Д2 · внутри чипа</b>', 'чип растёт влево до предела и режет текст'],
    ['d3a', { desc: 'in', place: 'mid' }, '<b>Д3а · остров, описание внутри</b>', 'чип по центру свободной зоны (между вкладками и кнопками окна)'],
    ['d3b', { desc: 'after', place: 'center' }, '<b>Д3б · остров, описание справа</b>', 'чип строго по центру окна, описание — курсивом за ним'],
  ];
  for (const [k, o, name, cap] of DESC) {
    for (const t of [TS, TL]) {
      if (k === 'd0' && t === TL) { s3.insertAdjacentHTML('beforeend', '<div class="cell"></div>'); continue; }
      const x = mkCell(HEAD);
      timer(x, { st: 'run', t, ...o });
      cell(s3, x, `${name}${t === TL ? ' · длинное' : ''}<br>${cap}`, `${k}-${t === TL ? 'long' : 'norm'}`);
    }
  }

  // 4 ─ the states of the one element
  const s4 = section('4 · Состояния одного элемента',
    'Показаны на чипе справа (Б1) с описанием слева (Д1). Раскрытая строка — тёмная плоская полоса во всю ширину окна сразу под шапкой: сразу после рождения она ложится ровно на шапку Day и ленту не закрывает; пока она раскрыта, описание в шапке не дублируется. Время: <b>12m 08s</b> до часа, <b>1h 05m</b> с часа; ширина бокса = число знаков, чип не дёргается на каждой секунде. В раскрытой строке кнопки круглые: идёт — оранжевое кольцо с ⏸, стоит — ▶ (здесь зелёный, сравнение — в разделе 5), ✕ — серый круг.');
  {
    const x = mkCell(HEAD);
    timer(x, { st: 'pause', t: TS, desc: 'left' });
    cell(s4, x, '<b>Пауза</b> (поставил сам)<br>тот же чип, время и значок серые; в кольце — две полоски', 'pause');
  }
  {
    const x = mkCell(HEAD);
    timer(x, { st: 'yield', t: TS, desc: 'left' });
    cell(s4, x, '<b>Перехвачен git-правкой</b> (yield → пауза)<br>полоски красные — как красный ⏸ у сессий: остановил не ты', 'yield');
  }
  {
    const x = mkCell(HEAD);
    timer(x, { st: 'run', t: TH, desc: 'left' });
    cell(s4, x, '<b>Идёт больше часа</b><br>формат 1h 05m — на знак короче, чип сужается один раз на границе часа', 'hour');
  }
  {
    const x = mkCell(132);
    timer(x, { st: 'run', t: TB, open: true });
    panel(x, [{ t: TB, st: 'run', focus: true }]);
    cell(s4, x, '<b>Раскрыт сразу после рождения</b><br>таймер идёт с клика, курсор в описании; Enter / клик мимо — закрыть, Esc с пустым полем — передумал', 'born');
  }
  {
    const x = mkCell(168);
    timer(x, { st: 'run', t: T1, open: true, desc: 'left' });
    panel(x, [{ t: T1, st: 'run' }], { newTimer: true });
    cell(s4, x, '<b>Раскрыт кликом по чипу</b><br>⏸ · время · поле описания · task? (облако выбора тикета) · ✕; под чертой — New timer (второй таймер без тикета)', 'open1');
  }
  {
    const x = mkCell(198);
    timer(x, { st: 'run', t: T1, open: true, desc: 'left' });
    panel(x, [{ t: T1, st: 'run' }, { t: T2, st: 'pause' }], { newTimer: true });
    cell(s4, x, '<b>Раскрыт, таймеров два</b><br>вторая строка + New timer под чертой; на чипе — идущий (или последний), знака количества нет', 'open2');
  }
  {
    const x = mkCell(168);
    timer(x, { st: 'run', t: TL, open: true, desc: 'left' });
    panel(x, [{ t: TL, st: 'run' }], { newTimer: true });
    cell(s4, x, '<b>Раскрыт, длинное описание</b><br>в поле помещается вдвое больше, чем в шапке; дальше — многоточие, в фокусе прокручивается, как обычное поле', 'openlong');
  }

  // 5 ─ question (в): the colour of the action
  const s5 = section('5 · Вопрос (в) — зелёный ▶ или нейтральная кнопка',
    'В кадре живая лента: сессия и янтарная искра подсказки. <b>Поправка к ТЗ:</b> пилюля Tracking в живом окне не зелёная — она красится температурой стамины (здесь персиковая, 0.62), зелёного <i>состояния</i> в ленте нет вовсе; зелёным остаётся только +312 в строке сессии. В первом кадре таймер идёт — сессия уступила (красный ⏸ Paused): оранжевый рядом с красным и янтарём. В двух других таймер перехвачен git-правкой: сессия снова Tracking, чип серый, а ▶ в строке таймера — действие. При yield оранжевый чип и тёплая пилюля Tracking одновременно не горят: идёт либо таймер, либо сессия.');
  {
    const x = mkCell(262);
    keepSuggestions(x, 2);
    timer(x, { st: 'run', t: T1, open: true, desc: 'left' });
    panel(x, [{ t: T1, st: 'run' }], { newTimer: true, go: 'green' });
    cell(s5, x, '<b>Таймер идёт</b> · оранжевый рядом с красным ⏸ и янтарём<br>оранжевое кольцо ⏸ и время; сессия ждёт — красный ⏸ Paused', 'c-run');
  }
  {
    const x = mkCell(262);
    keepSuggestions(x, 2);
    timer(x, { st: 'yield', t: T1, open: true, desc: 'left' });
    panel(x, [{ t: T1, st: 'yield' }], { newTimer: true, go: 'green' });
    cell(s5, x, '<b>В1 · зелёный ▶</b> (systemGreen #30D158, круг — 20 % цвета)<br>ниже — пилюля Tracking со своим ▶: тёплая, не зелёная — цвета не встречаются', 'c-green');
  }
  {
    const x = mkCell(262);
    keepSuggestions(x, 2);
    timer(x, { st: 'yield', t: T1, open: true, desc: 'left' });
    panel(x, [{ t: T1, st: 'yield' }], { newTimer: true, go: 'neutral' });
    cell(s5, x, '<b>В2 · нейтральная кнопка</b><br>серый круг со светлым ▶; цвета действия нет, единственный акцент строки — оранжевое время', 'c-neutral');
  }

  // 6 ─ the + Log cloud gives birth to a timer
  const s6 = section('6 · Облако + Log: текст не нашёл тикет → ▶ Start timer «текст»',
    'Строка появляется только когда в поиске набран текст — рядом с Create «текст» in Jira…. При пустом поиске её нет: вечной заготовки в облаке не остаётся, + Log — про тикеты. Старт без текста — значок в шапке.');
  {
    const x = mkCell(228);
    timer(x, { st: 'idle' });
    cloud(x, T1.desc, 'green');
    cell(s6, x, '<b>Текст без совпадений · зелёный ▶</b><br>два действия одной формы: ▶ Start timer и ＋ Create in Jira', 'cloud-green');
  }
  {
    const x = mkCell(228);
    timer(x, { st: 'idle' });
    cloud(x, T1.desc, 'neutral');
    cell(s6, x, '<b>То же · нейтральный ▶</b><br>действия различаются только глифом', 'cloud-neutral');
  }
  {
    const x = mkCell(HEAD);
    timer(x, { st: 'run', t: { desc: T1.desc, time: '0m 04s' }, desc: 'left' });
    cell(s6, x, '<b>Следующий кадр</b><br>облако закрылось, чип в шапке идёт с этим описанием (показано на Д1); раскрывать строку не нужно — описание уже есть', 'cloud-next');
  }

  // ── measurements, straight from the cells ────────────────────────
  function measure() {
    const z = +getComputedStyle(document.documentElement).getPropertyValue('--z') || 1;
    const w = (el) => Math.round(el.getBoundingClientRect().width / z * 10) / 10;
    const h = (el) => Math.round(el.getBoundingClientRect().height / z * 10) / 10;
    const gap = (a, b) => Math.round((b.getBoundingClientRect().left - a.getBoundingClientRect().right) / z * 10) / 10;
    const probe = document.createElement('span');
    probe.className = 'probe';
    probe.textContent = '0000000000';
    M.words.hdr.append(probe);
    const ch = probe.getBoundingClientRect().width / z / 10;
    probe.style.fontStyle = 'italic';
    const chI = probe.getBoundingClientRect().width / z / 10;
    probe.remove();
    const X = M.words, tabs = $$('.tab-w', X.hdr);
    const free = gap(X.tabs, X.wc);
    const heads = cells.map((x) => h(x.head)).filter((v) => v > 0);
    const out = { groups: [] };
    const g = (title, rows) => out.groups.push({ title, rows });
    g('Окно и шапка', [
      ['ширина окна', `${w(X.app)}px`],
      ['высота шапки приложения', `${h(X.hdr)}px`],
      ['шапка Day во всех кадрах', `${Math.min(...heads) === Math.max(...heads) ? heads[0] : `${Math.min(...heads)}–${Math.max(...heads)}`}px (кадров с вкладкой Day: ${heads.length})`],
      ['кнопки окна («свернуть» + «закрыть»)', `${w(X.wc)}px`],
    ]);
    g('Вкладки словами', [
      ...tabs.map((b) => [b.textContent, `${w(b)}px`]),
      ['три слова с промежутками', `${w(X.tabs)}px`],
      ['иконки вкладок сегодня', `${w($('.view-switcher', M.today.hdr))}px`],
      ['свободно между вкладками и кнопками окна', `${free}px`],
    ]);
    const c7 = $('.tchip', M['d0-norm'].zone), c6 = $('.tchip', M.hour.zone);
    g('Таймер', [
      ['значок в покое (Б1)', `${w($('.tidle', M['b1-idle'].zone))}px`],
      ['контур чипа в покое (Б2)', `${w($('.tchip', M['b2-idle'].zone))} × ${h($('.tchip', M['b2-idle'].zone))}px`],
      ['чип «47m 15s» (7 знаков)', `${w(c7)} × ${h(c7)}px`],
      ['чип «1h 05m» / «0m 04s» (6 знаков)', `${w(c6)}px`],
      ['зона таймера Б1 целиком (чип + отступ + черта)', `${w(M['d0-norm'].zone) - 24}px`],
      ['раскрытая строка сразу после рождения (от края окна по 8px)', `${w($('.tpanel', M.born.app))} × ${h($('.tpanel', M.born.app))}px`],
      ['раскрытая: один таймер + New timer', `${h($('.tpanel', M.open1.app))}px высоты`],
      ['раскрытая: два таймера + New timer', `${h($('.tpanel', M.open2.app))}px высоты`],
      ['поле описания в раскрытой строке', `${w($('.tfield', M.open1.app))}px ≈ ${Math.floor(w($('.tfield', M.open1.app)) / (ch * 11 / 10.5))} зн.`],
    ]);
    const rows = [];
    for (const [k, name] of [['d0', 'Д0'], ['d1', 'Д1 слева от чипа'], ['d2', 'Д2 внутри чипа'], ['d3a', 'Д3а остров, внутри'], ['d3b', 'Д3б остров, справа']]) {
      const x = M[`${k}-long`] || M[`${k}-norm`];
      const d = $('.tmz-desc, .tchip-desc', x.zone);
      const it = d && d.classList.contains('tmz-desc');
      rows.push([`${name}: под описание`, d ? `${w(d)}px ≈ ${Math.floor(w(d) / (it ? chI : ch))} зн.` : '—']);
      const first = x.place === 'center' ? x.anchor : (d && it && !d.classList.contains('after') ? d : x.anchor);
      rows.push([`${name}: зона перетаскивания слева от таймера`, `${gap(x.tabs, first)}px`]);
    }
    g('Вопрос (а): остаток под описание (длинный текст, чип «47m 15s»)', rows);
    out.ch = Math.round(ch * 100) / 100;
    return out;
  }
  function renderMeasure() {
    const m = measure();
    $('#meas').innerHTML = m.groups.map((gr) => `<span class="mh">${gr.title}</span>${gr.rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}`).join('');
    window.__meas = m;
  }

  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
    for (const x of cells) place(x);
    renderMeasure();
  };
  $('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(b.dataset.z); });
  setZoom('1');
  document.fonts?.ready.then(() => setZoom(getComputedStyle(document.documentElement).getPropertyValue('--z').trim() || '1'));
})();
