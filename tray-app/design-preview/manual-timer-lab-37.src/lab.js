(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtRun = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    return h ? `${h}h ${pad(Math.floor(s / 60) % 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  };
  const fmtHm = (min) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${pad(min % 60)}m`);

  // ── glyphs (own SVG — no SF Symbols) ─────────────────────────────
  const IC = '<svg class="g-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/><path d="M7 7V3.8"/></svg>';
  const IC_P = '<svg class="g-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/><path d="M5.7 5.1v3.8M8.3 5.1v3.8"/></svg>';
  const GO = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.8 1.5l5.6 3.5-5.6 3.5z"/></svg>';
  const PZ = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.3 2.2v5.6M6.7 2.2v5.6"/></svg>';
  const PLAY = GO.replace('<svg', '<svg class="g-go"');
  const PAUSE = PZ.replace('<svg', '<svg class="g-pz"');
  const X = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2"/></svg>';
  const PIN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.1 1.5h3.8M4.8 1.5v3.1L3.1 6.9h5.8L7.2 4.6V1.5M6 6.9v3.6"/></svg>';
  const CUR = '<svg viewBox="0 0 12 17" aria-hidden="true"><path d="M1 1v12.2l3.2-3 2.1 4.8 2-.9-2.1-4.7h4.3z"/></svg>';

  // ── the widget ───────────────────────────────────────────────────
  // t: { st: run | wait | pause, time, key?, desc?, id?, cur? (a still of the cursor: 'toggle' | 'off') }
  // Only a standing row has the cross; the place for it is in every row.
  function row(t) {
    const tx = t.key || t.desc
      ? `<span class="w-tx">${t.key ? `<span class="w-k">${t.key}</span>` : ''}${t.desc ? `<span class="w-d">${esc(t.desc)}</span>` : ''}</span>` : '';
    const off = t.st === 'pause' ? `<button type="button" class="w-x${t.cur === 'off' ? ' h' : ''}" data-a="off">${X}</button>` : '';
    return `<div class="w-row ${t.st}${t.cur ? ' rh' : ''}"${t.id ? ` data-id="${t.id}"` : ''}${t.cur ? ` data-cur="${t.cur}"` : ''}>`
      + `<button type="button" class="w-b" data-a="toggle"><span class="at-rest">${t.st === 'pause' ? IC_P : IC}</span><span class="at-hov">${t.st === 'pause' ? PLAY : PAUSE}</span></button>`
      + `<b class="w-t">${t.time}</b>${tx}<span class="w-acts">${off}</span></div>`;
  }
  const narrow = (w, list) => w < (list ? 200 : 150);
  // o: w (px) · fluid (the window sets the width) · hov (a still of the widget under the cursor) · ghost (К2) · plate (0–1) · cls
  function widget(rows, o = {}) {
    const list = rows.length > 1;
    const st = [o.w && !o.fluid ? `width:${o.w}px` : '', list ? `--tw:${rows.some((t) => t.time.includes('h')) ? 10 : 7}ch` : '', o.plate ? `--plate:${o.plate}` : ''].filter(Boolean).join(';');
    return `<div class="w sz-${o.w && narrow(o.w, list) ? 's' : 'm'}${list ? ' list' : ''}${o.hov ? ' hov' : ''}${o.ghost ? ' xg' : ''}${o.cls ? ` ${o.cls}` : ''}"${st ? ` style="${st}"` : ''}>`
      + `${rows.map(row).join('')}</div>`;
  }

  // ── what lies under the widget ───────────────────────────────────
  function backdrop(bg, w, h) {
    if (bg === 'dark') return '';
    const light = bg === 'light';
    const cols = light ? ['#d5d9e2'] : ['#89b4fa', '#a6e3a1', '#f9e2af', '#cba6f7', '#6c7086'];
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const x0 = light ? 28 : 16;
    let s = light ? '<div class="bg-page"></div>' : '';
    for (let y = light ? 24 : 12; y < h - 4; y += 11) {
      let x = x0 + (light ? 0 : Math.floor(rnd() * 3) * 14);
      const n = light ? 1 : 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const len = 30 + Math.floor(rnd() * (light ? w - 110 : 90));
        if (x + len > w - x0) break;
        s += `<i class="bg-ln" style="left:${x}px;top:${y}px;width:${len}px;background:${cols[Math.floor(rnd() * cols.length)]};opacity:${light ? 1 : .55}"></i>`;
        x += len + 8;
      }
    }
    return s;
  }
  const scene = (bg, inner, w = 300, h = 112) => `<div class="scene bg-${bg}" style="width:${w}px;height:${h}px">${backdrop(bg, w, h)}${inner}</div>`;
  const cell = (sc, cap, w = 300) => `<div class="cell">${sc}${cap ? `<div class="cap" style="max-width:${w}px">${cap}</div>` : ''}</div>`;
  const BR = '<div style="flex-basis:100%;height:0"></div>';

  // the timers of the stills: a deploy, a call, a review, a favour
  const D = { key: 'ATL-6790', desc: 'деплой релиза на staging' };
  const C = { desc: 'звонок по выгрузке отчётов' };
  const R = { key: 'ATL-6712', desc: 'PR #214 review with team' };
  const H = { desc: 'помог соседней команде с логами' };
  const run = (t, time, cur) => ({ ...t, st: 'run', time, cur });
  const stop = (t, time, cur) => ({ ...t, st: 'pause', time, cur });
  const W = 262;

  // ── 1 · the scenario ─────────────────────────────────────────────
  const shot = (rows, cap, hov) => cell(scene('dark', widget(rows, { w: W, hov }), 300, 92), cap);
  $('#g-story').innerHTML = [
    shot([run(D, '38m 12s')], '<b>1.</b> Идёт таймер деплоя. На столе одна строка.'),
    shot([stop(D, '38m'), run(C, '0m 04s')], '<b>2.</b> Звонок. В приложении нажали New timer: деплой встал, строка звонка появилась на столе сама.'),
    shot([stop(D, '38m', 'toggle'), run(C, '6m 48s')], '<b>3.</b> Звонок кончился. Курсор на строке деплоя — её значок стал ▶.', true),
    BR,
    shot([run(D, '38m 13s'), stop(C, '6m 48s')], '<b>4.</b> Клик. Считает деплой, звонок встал. Приложение не открывалось.'),
    shot([run(D, '38m 31s'), stop(C, '6m 48s', 'off')], '<b>5.</b> Таймер звонка больше не нужен. Крестик справа убирает строку со стола.', true),
    shot([run(D, '38m 33s')], '<b>6.</b> Снова одна строка. Таймер звонка остался в острове со своим временем.'),
  ].join('');

  // ── 2 · rest and under the cursor ────────────────────────────────
  const L3 = [run(D, '38m 12s'), stop(C, '6m 48s'), stop(R, '30m')];
  const BGS = [['dark', 'тёмные обои'], ['light', 'светлое окно'], ['code', 'редактор кода']];
  $('#g-hover').innerHTML = `<div class="grid">${BGS.map(([bg, bn]) => cell(scene(bg, widget(L3, { w: W })), `<b>Покой</b> — ${bn}. Идёт верхний таймер, два стоят`)).join('')}</div>`
    + `<div class="grid">${[
      cell(scene('dark', widget([L3[0], { ...L3[1], cur: 'toggle' }, L3[2]], { w: W, hov: true })), '<b>Курсор на стоящей строке</b> — зелёный ▶ запустит её, идущий таймер встанет'),
      cell(scene('dark', widget([{ ...L3[0], cur: 'toggle' }, L3[1], L3[2]], { w: W, hov: true })), '<b>Курсор на идущей строке</b> — ⏸. Крестика у неё нет: идущий таймер со стола не убрать'),
      cell(scene('light', widget([L3[0], L3[1], { ...L3[2], cur: 'off' }], { w: W, hov: true })), '<b>Курсор на крестике</b> — строка уйдёт со стола, таймер останется в острове'),
    ].join('')}</div>`;

  // a finding: on a white window the standing rows are hard to read at 50 %
  $('#g-plate').innerHTML = [[.5, '50 % — ваш выбор. Идущая строка читается, стоящие почти нет'], [.65, '65 %'], [.8, '80 %']]
    .map(([plate, cap]) => cell(scene('light', widget(L3, { w: W, plate })), `<b>Подложка ${cap}</b>`)).join('');

  // ── 3 · the cross at rest ────────────────────────────────────────
  $('#g-cross').innerHTML = [
    cell(scene('dark', widget(L3, { w: W })), '<b>К1 · в покое крестика нет</b> — виджет только показывает'),
    cell(scene('dark', widget(L3, { w: W, ghost: true })), '<b>К2 · крестик едва виден</b> — у каждой стоящей строки'),
    BR,
    cell(scene('light', widget(L3, { w: W })), '<b>К1</b> — светлое окно'),
    cell(scene('light', widget(L3, { w: W, ghost: true })), '<b>К2</b> — светлое окно'),
  ].join('');

  // ── 4 · the width ────────────────────────────────────────────────
  $('#g-size').innerHTML = [
    cell(scene('dark', widget(L3, { w: W })), '<b>Широкий список</b> — время, ключ и описание, сколько влезло'),
    cell(scene('dark', widget(L3, { w: 168 })), '<b>Узкий список</b> — время и ключ; у таймера без тикета — начало описания'),
    cell(scene('dark', widget([run(D, '1h 02m 15s'), stop(C, '6m 48s'), stop(R, '30m')], { w: W })), '<b>Больше часа</b> — колонка времени шире у всех строк, ключи остаются на одной линии'),
    BR,
    cell(scene('dark', widget([run(D, '38m 12s')], { w: W }), 300, 60), '<b>Одна строка, широкая</b>'),
    cell(scene('dark', widget([run(D, '38m 12s')], { w: 104 }), 300, 60), '<b>Одна строка, узкая</b> — только время. Справа место под крестик: пока таймер идёт, оно пустое'),
    cell(scene('dark', widget([stop(D, '38m', 'off')], { w: 104, hov: true }), 300, 60), '<b>Она же стоит, под курсором</b> — крестик на своём месте'),
  ].join('');

  // ── 5 · the states ───────────────────────────────────────────────
  $('#g-state').innerHTML = [
    cell(scene('dark', widget([{ ...D, st: 'wait', time: '38m 12s' }, stop(C, '6m 48s')], { w: W }), 300, 92), '<b>Считает сессия</b> — таймер ждёт оранжевым вполсилы и вернётся сам. Крестика у него нет'),
    cell(scene('dark', widget([stop(D, '38m'), stop(C, '6m 48s'), stop(R, '30m')], { w: W }), 300, 92), '<b>Ничего не идёт</b> — все строки серые; у каждой под курсором ▶ и крестик'),
    cell(scene('dark', widget([run(D, '38m 12s'), { st: 'pause', time: '3m 05s' }], { w: W }), 300, 92), '<b>Таймер без тикета и без описания</b> — в строке только время'),
  ].join('');

  // ── 6 · the limit ────────────────────────────────────────────────
  $('#g-cap').innerHTML = [
    cell(scene('dark', widget(L3, { w: W })), '<b>Было</b> — три строки, идёт деплой. Строку ATL-6712 не трогали дольше всех'),
    cell(scene('dark', widget([stop(D, '38m'), stop(C, '6m 48s'), run(H, '0m 04s')], { w: W })), '<b>В приложении запущен четвёртый таймер</b> — он встал снизу, строка ATL-6712 ушла со стола. В острове она осталась; запустить её снова — вернётся'),
  ].join('');

  // ── 7 · the window grows from the nearest edge ───────────────────
  $('#g-grow').innerHTML = [
    cell(scene('dark', widget(L3, { w: W }), 300, 132), '<b>Виджет в нижнем углу</b> — нижний край на месте, строки добавляются вверх'),
    cell(scene('dark', widget(L3, { w: W, cls: 'top' }), 300, 132), '<b>Виджет в верхнем углу</b> — верхний край на месте, строки добавляются вниз'),
    cell(scene('dark', '', 300, 132), '<b>Все строки убраны</b> — виджета нет. Появится со следующим запуском таймера'),
  ].join('');

  // ── 8 · where it is switched on ──────────────────────────────────
  const irow = (t) => `<div class="irow ${t.st}"${t.id ? ` data-id="${t.id}"` : ''}>`
    + `<button type="button" class="ib ${t.st === 'pause' ? 'go' : 'pz'}" data-a="toggle">${t.st === 'pause' ? GO : PZ}</button>`
    + (t.key ? `<span class="ik">${t.key}</span>` : '<span class="ik ask">task?</span>')
    + `<span class="if">${t.desc ? esc(t.desc) : '<span class="ph">description</span>'}</span><b class="it">${t.time}</b></div>`;
  const island = (rows, pin) => `<div class="isl">${rows.map(irow).join('')}<div class="isep"></div><div class="inew">`
    + `<button type="button" class="inb" data-a="new"><span>${GO}</span><span>New timer</span></button>${pin ? `<span class="ip">${PIN}</span>` : ''}</div></div>`;
  $('#g-set').innerHTML = [
    cell('<div class="set"><h3>Timer <span class="sub">desktop widget</span></h3><div class="opt-row"><div class="left"><span class="name">Desktop widget</span>'
      + '<span class="hint">Show timers on the desktop, on top of other windows.</span></div><div class="right"><div class="toggle on"></div></div></div></div>',
    '<b>Settings</b> — новая секция Timer с одним выключателем. Сюда же потом ляжет «каждая карточка создаётся с пустым таймером»', 333),
    cell(island([run(D, '38m 12s')], true), '<b>Остров, было (v35)</b> — булавка справа в строке New timer', 333),
    cell(island([run(D, '38m 12s')], false), '<b>Остров, стало</b> — булавки нет', 333),
  ].join('');

  // the cursor of a still stands on the control it points at
  for (const r of $$('.w-row[data-cur]')) {
    const sc = r.closest('.scene'), a = $(`[data-a="${r.dataset.cur}"]`, r).getBoundingClientRect(), b = sc.getBoundingClientRect();
    const c = document.createElement('i');
    c.className = 'cur';
    c.innerHTML = CUR;
    // the tip rests on the lower right part of the control, so the control itself stays in sight
    c.style.left = `${a.left - b.left - sc.clientLeft + a.width * .68}px`;
    c.style.top = `${a.top - b.top - sc.clientTop + a.height * .7}px`;
    sc.appendChild(c);
  }

  // ── 9 · the sandbox ──────────────────────────────────────────────
  const stage = $('#stage'), islEl = $('#isl');
  const ONE_MIN = 104, LIST_MIN = 168, HOURS = 19; // the least widths: the time and the cross · plus the key · plus three more characters of time
  const POOL = ['звонок по выгрузке отчётов', 'ответ в чате поддержки', 'разбор логов с соседней командой'];
  const SB = { bg: 'dark', cap: 3, ghost: false, plate: 50, on: true, ses: false, clock: 0, seq: 0, pool: [], timers: [], log: [], box: null };

  function seed() {
    Object.assign(SB, { ses: false, clock: 0, seq: 0, pool: [...POOL], log: [] });
    const mk = (o) => ({ id: ++SB.seq, used: ++SB.clock, desk: false, ...o });
    SB.timers = [
      mk({ st: 'pause', sec: 30 * 60, key: 'ATL-6712', desc: 'PR #214 review with team' }),
      mk({ st: 'pause', sec: 12 * 60 + 40, desc: 'помог соседней команде с логами' }),
      mk({ st: 'run', sec: 38 * 60 + 12, key: 'ATL-6790', desc: 'деплой релиза на staging', desk: true }),
    ];
    // ax / ay — the edges that stay in place: the window grows away from the nearest edges of the screen
    SB.box = { ax: stage.clientWidth - 14, ay: stage.clientHeight - 14, w: W, side: 'r', grow: 'up' };
    ev('на столе один таймер — деплой. Нажмите New timer в острове: это звонок');
  }
  const desk = () => SB.timers.filter((t) => t.desk);
  // a record at rest shows whole minutes, everything else — seconds too (as in the island)
  const timeOf = (t) => (t.key && t.st === 'pause' ? fmtHm(Math.floor(t.sec / 60)) : fmtRun(t.sec));
  const nameOf = (t) => t.key || (t.desc ? `«${t.desc}»` : 'таймер без описания');
  const view = (t) => ({ ...t, time: timeOf(t) });
  const minW = () => {
    const rows = desk();
    return (rows.length > 1 ? LIST_MIN : ONE_MIN) + (rows.some((t) => t.sec >= 3600) ? HOURS : 0);
  };
  function ev(msg) {
    SB.log.unshift(msg);
    SB.log.length = Math.min(SB.log.length, 5);
    $('#evlog').innerHTML = SB.log.map((m) => `<div>${esc(m)}</div>`).join('');
  }

  function readout() {
    const rows = desk(), el = $('.w-box', stage);
    $('#readout').innerHTML = !SB.on ? 'виджет выключен в Settings — на рабочем столе ничего нет, таймеры идут как обычно'
      : !el ? 'на столе нет строк — виджета нет; появится со следующим запуском таймера'
        : `окно виджета <b>${el.offsetWidth} × ${el.offsetHeight}</b> px · на столе <b>${rows.length}</b> из ${SB.timers.length} таймеров дня · предел ${SB.cap} · `
          + `растёт ${SB.box.grow === 'up' ? 'вверх' : 'вниз'} и ${SB.box.side === 'r' ? 'влево' : 'вправо'}`;
  }
  function applyBox() {
    const el = $('.w-box', stage);
    if (el) {
      const b = SB.box, w = Math.max(b.w, minW()), s = el.style, list = desk().length > 1;
      s.width = `${w}px`;
      s.left = b.side === 'r' ? 'auto' : `${b.ax}px`;
      s.right = b.side === 'r' ? `${stage.clientWidth - b.ax}px` : 'auto';
      s.top = b.grow === 'up' ? 'auto' : `${b.ay}px`;
      s.bottom = b.grow === 'up' ? `${stage.clientHeight - b.ay}px` : 'auto';
      const wg = $('.w', el);
      wg.style.setProperty('--plate', SB.plate / 100);
      wg.classList.toggle('sz-s', narrow(w, list));
      wg.classList.toggle('sz-m', !narrow(w, list));
    }
    readout();
  }
  function renderDesk() {
    stage.className = `scene sand-stage bg-${SB.bg}`;
    const rows = desk(), bg = backdrop(SB.bg, stage.clientWidth, stage.clientHeight);
    stage.innerHTML = !SB.on || !rows.length ? bg
      : `${bg}<div class="w-box">${widget(rows.map(view), { fluid: true, ghost: SB.ghost })}<i class="rz w"></i><i class="rz e"></i></div>`;
    applyBox();
  }
  function renderIsland() { islEl.innerHTML = island(SB.timers.map(view), false); }
  function syncCtl() {
    for (const b of $$('[data-bg]')) b.classList.toggle('on', b.dataset.bg === SB.bg);
    for (const b of $$('[data-cap]')) b.classList.toggle('on', +b.dataset.cap === SB.cap);
    for (const b of $$('[data-ghost]')) b.classList.toggle('on', !!+b.dataset.ghost === SB.ghost);
    $('#b-ses').classList.toggle('on', SB.ses);
    $('#t-on').classList.toggle('on', SB.on);
    $('#r-plate').value = SB.plate;
    $('#v-plate').textContent = `${SB.plate} %`;
  }
  $('#r-plate').addEventListener('input', (e) => { SB.plate = +e.target.value; syncCtl(); applyBox(); });
  function renderAll() { syncCtl(); renderIsland(); renderDesk(); }

  // more rows than the limit: the standing row left alone the longest leaves the desktop
  function enforceCap() {
    for (;;) {
      const rows = desk();
      if (rows.length <= SB.cap) return;
      const out = rows.filter((t) => t.st === 'pause').sort((a, b) => a.used - b.used)[0];
      if (!out) return;
      out.desk = false;
      ev(`${nameOf(out)} ушёл со стола: строк стало больше ${SB.cap}, а им не пользовались дольше всех. В острове он остался`);
    }
  }
  function start(t, where) {
    for (const x of SB.timers) if (x !== t && x.st !== 'pause') { x.st = 'pause'; x.used = ++SB.clock; } // one source counts at a time
    const ses = SB.ses, came = !t.desk;
    SB.ses = false;
    Object.assign(t, { st: 'run', used: ++SB.clock, desk: true });
    ev(`${nameOf(t)} запущен ${where}${came ? ' → строка сама появилась на столе' : ''}${ses ? '; сессия вытеснена' : ''}`);
    enforceCap();
  }
  function halt(t, where) {
    Object.assign(t, { st: 'pause', used: ++SB.clock });
    ev(`${nameOf(t)} остановлен ${where}`);
  }
  const byRow = (e) => SB.timers.find((x) => x.id === +e.target.closest('[data-id]').dataset.id);

  islEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'new') {
      const t = { id: ++SB.seq, used: 0, desk: false, st: 'pause', sec: 0, desc: SB.pool.shift() || '' };
      SB.timers.push(t);
      start(t, 'в приложении (New timer)');
    } else {
      const t = byRow(e);
      if (t.st === 'pause') start(t, 'в приложении'); else halt(t, 'в приложении');
    }
    renderAll();
  });
  stage.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const t = byRow(e);
    if (a === 'off') { t.desk = false; ev(`${nameOf(t)} убран со стола крестиком — в острове остался, время при нём`); }
    else if (t.st === 'pause') start(t, 'с рабочего стола');
    else halt(t, 'с рабочего стола');
    renderAll();
  });
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.w-box') && !e.target.closest('button')) ev('двойной клик по виджету → открылось приложение');
  });

  $('.sand-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('button, .toggle');
    if (!b) return;
    if (b.dataset.bg) SB.bg = b.dataset.bg;
    if (b.dataset.ghost) SB.ghost = !!+b.dataset.ghost;
    if (b.dataset.cap) { SB.cap = +b.dataset.cap; enforceCap(); }
    if (b.id === 't-on') { SB.on = !SB.on; ev(SB.on ? 'Desktop widget включён в Settings' : 'Desktop widget выключен в Settings — стол пуст, таймеры идут'); }
    if (b.id === 'b-reset') seed();
    if (b.id === 'b-ses') {
      SB.ses = !SB.ses;
      const t = SB.timers.find((x) => x.st !== 'pause');
      if (SB.ses && t?.st === 'run') { t.st = 'wait'; ev(`плотные правки в репозитории: считает сессия — ${nameOf(t)} ждёт и вернётся сам`); }
      else if (!SB.ses && t?.st === 'wait') { t.st = 'run'; ev(`сессия угасла — ${nameOf(t)} пошёл сам`); }
      else ev(SB.ses ? 'считает сессия; таймеры стоят' : 'сессия угасла; таймеры стоят');
    }
    renderAll();
  });

  // dragging by the body · the width by the left and the right edge · the height is never dragged
  let grab = null;
  const rectOf = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  stage.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.w-box');
    if (!el || e.target.closest('button')) return;
    const rz = e.target.closest('.rz');
    grab = { kind: rz ? rz.className.replace('rz ', '') : 'move', px: e.clientX, py: e.clientY, ...rectOf(el), moved: false };
    el.classList.toggle('drag', !rz);
    try { el.setPointerCapture(e.pointerId); } catch { /* a scripted event has no live pointer to capture */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    const el = $('.w-box', stage);
    if (!grab || !el) return;
    const dx = e.clientX - grab.px, dy = e.clientY - grab.py, SW = stage.clientWidth, SH = stage.clientHeight;
    let { x, y, w } = grab;
    if (grab.kind === 'move') {
      x = Math.min(SW - w, Math.max(0, x + dx));
      y = Math.min(SH - grab.h, Math.max(0, y + dy));
    } else if (grab.kind === 'e') {
      w = Math.min(SW - x, Math.max(minW(), w + dx));
    } else {
      const right = x + w;
      w = Math.min(right, Math.max(minW(), w - dx));
      x = right - w;
    }
    grab.moved = true;
    // the edges nearest to the screen's edges stay in place from now on
    const b = SB.box;
    b.side = x + w / 2 > SW / 2 ? 'r' : 'l';
    b.grow = y + grab.h / 2 > SH / 2 ? 'up' : 'down';
    b.ax = b.side === 'r' ? x + w : x;
    b.ay = b.grow === 'up' ? y + grab.h : y;
    if (grab.kind !== 'move') b.w = w;
    applyBox();
  });
  const drop = () => { grab = null; $('.w-box', stage)?.classList.remove('drag'); };
  stage.addEventListener('pointerup', drop);
  stage.addEventListener('pointercancel', drop);

  // the time goes on — the figures change in place, nothing is redrawn under the cursor
  setInterval(() => {
    for (const t of SB.timers) {
      if (t.st !== 'run') continue;
      t.sec += 1;
      for (const el of $$(`[data-id="${t.id}"] .w-t, [data-id="${t.id}"] .it`)) el.textContent = timeOf(t);
    }
  }, 1000);

  seed();
  renderAll();
})();
