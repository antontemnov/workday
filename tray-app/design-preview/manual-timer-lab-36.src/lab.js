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
  const PIN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.1 1.5h3.8M4.8 1.5v3.1L3.1 6.9h5.8L7.2 4.6V1.5M6 6.9v3.6"/></svg>';
  const BIN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 3.5h7M4.8 3.5V2.3h2.4v1.2M3.5 3.5l.5 6.2h4l.5-6.2"/></svg>';

  // ── the widget ───────────────────────────────────────────────────
  // t: { st: run | wait | pause, time, key?, desc?, rh? (a still of this row under the cursor), id? }
  // acts: 1 — ⏸ / ▶ only · 2 — + unpin · 3 — + delete (a timer without a ticket only: a record has no Delete in the island either)
  function row(t, acts) {
    const tx = t.key || t.desc
      ? `<span class="w-tx">${t.key ? `<span class="w-k">${t.key}</span>` : ''}${t.desc ? `<span class="w-d">${esc(t.desc)}</span>` : ''}</span>` : '';
    const xs = (acts >= 3 && !t.key ? `<button type="button" class="w-x del" data-a="del">${BIN}</button>` : '')
      + (acts >= 2 ? `<button type="button" class="w-x pin" data-a="unpin">${PIN}</button>` : '');
    return `<div class="w-row ${t.st}${t.rh ? ' rh' : ''}"${t.id ? ` data-id="${t.id}"` : ''}>`
      + `<button type="button" class="w-b" data-a="toggle"><span class="at-rest">${t.st === 'pause' ? IC_P : IC}</span><span class="at-hov">${t.st === 'pause' ? PLAY : PAUSE}</span></button>`
      + `<b class="w-t">${t.time}</b>${tx}${xs ? `<span class="w-acts">${xs}</span>` : ''}</div>`;
  }
  // o: look a | b | c · size s | m | l · hov (a still of the whole widget under the cursor) · acts · z (scale) · w (px) · cls
  function widget(rows, o = {}) {
    const st = [o.w ? `width:${o.w}px` : '', o.z ? `--z:${o.z}` : ''].filter(Boolean).join(';');
    return `<div class="w look-${o.look || 'b'} sz-${o.size || 'm'}${o.hov ? ' hov' : ''}${rows.length > 1 ? ' list' : ''}${o.cls ? ` ${o.cls}` : ''}"${st ? ` style="${st}"` : ''}>`
      + `${rows.map((t) => row(t, o.acts ?? 2)).join('')}</div>`;
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

  const tk = { st: 'run', time: '47m 15s', key: 'ATL-6781', desc: 'созвон по инциденту с командой платежей' };
  const an = { st: 'run', time: '47m 15s', desc: 'разбор 500-х на checkout' };

  // ── 1 · rest: how transparent ────────────────────────────────────
  const LOOKS = [['a', 'А · только цифры', 'подложки нет, у цифр тёмный ореол'], ['b', 'Б · дымка', 'подложка 45 %'], ['c', 'В · плотная', 'подложка 80 %']];
  const BGS = [['dark', 'тёмные обои'], ['light', 'светлое окно'], ['code', 'редактор кода']];
  $('#g-rest').innerHTML = LOOKS.map(([look, name, how]) => `<div class="grid">${BGS.map(([bg, bn]) =>
    cell(scene(bg, widget([tk], { look, w: 252 })), `<b>${name}</b> — ${how} · ${bn}`)).join('')}</div>`).join('');

  // ── 2 · under the cursor ─────────────────────────────────────────
  const hov = (acts) => scene('dark', widget([{ ...an, rh: true }], { hov: true, acts, w: 252 }));
  $('#g-hover').innerHTML = [
    cell(hov(1), '<b>Д1 · только ⏸ / ▶</b> — убрать виджет с рабочего стола можно лишь из приложения'),
    cell(hov(2), '<b>Д2 · ⏸ / ▶ и открепить</b> — булавка справа снимает таймер с рабочего стола, сам таймер остаётся'),
    cell(hov(3), '<b>Д3 · плюс удалить</b> — ваш максимум. Корзина есть только у таймера без тикета; отмены у неё нет'),
    cell(scene('light', widget([{ ...tk, st: 'pause', time: '48m', rh: true }], { hov: true, w: 252 })), '<b>На светлом окне</b> — стоящий таймер: вместо ⏸ зелёный ▶'),
  ].join('');

  // ── 3 · what resizable means ─────────────────────────────────────
  const keyOnly = { st: 'run', time: '47m 15s', key: 'ATL-6781' };
  $('#g-size').innerHTML = [
    cell(scene('dark', widget([tk], { size: 's' })), '<b>Р1 · узкий</b> — значок и время'),
    cell(scene('dark', widget([tk], { w: 252 })), '<b>Р1 · широкий</b> — плюс ключ и описание, сколько влезет'),
    cell(scene('dark', widget([tk], { size: 'l', w: 252 })), '<b>Р1 · высокий</b> — ключ и описание на своей строке'),
    BR,
    cell(scene('dark', widget([keyOnly], { z: 1 }), 340), '<b>Р2 · ×1</b> — тот же состав', 340),
    cell(scene('dark', widget([keyOnly], { z: 1.4 }), 340), '<b>Р2 · ×1,4</b>', 340),
    cell(scene('dark', widget([keyOnly], { z: 2 }), 340), '<b>Р2 · ×2</b> — читается с другого конца стола', 340),
  ].join('');

  // ── 4 · states and contents ──────────────────────────────────────
  const st = (t, cap, w) => `${widget([t], { cls: 'in', w })}<div class="stk-c">${cap}</div>`;
  $('#g-state').innerHTML = cell(scene('dark', `<div class="stk">${[
    st(tk, 'идёт · таймер с тикетом', 262),
    st({ ...tk, st: 'wait' }, 'ждёт · считает сессия, таймер вернётся сам', 262),
    st({ ...tk, st: 'pause', time: '48m' }, 'стоит · остановлен руками', 262),
    st(an, 'идёт · без тикета: на месте ключа сразу описание', 262),
    st({ st: 'run', time: '3m 05s' }, 'идёт · без тикета и без описания: только время'),
    st({ ...tk, time: '1h 02m 15s' }, 'больше часа · время шире, описанию меньше места', 262),
  ].join('')}</div>`, 640, 236), '', 640);

  // ── 5 · a pin on every row → a list on the desktop ───────────────
  const IR = [
    { cls: 'tk run', pin: 1, key: 'ATL-6781', desc: 'созвон по инциденту с командой платежей', time: '48m 02s' },
    { cls: 'an', pin: 1, desc: 'помог соседней команде с деплоем', time: '12m 40s' },
    { cls: 'an', pin: 0, desc: '', time: '3m 05s' },
    { cls: 'tk', pin: 1, key: 'ATL-6712', desc: 'PR #214 review with team', time: '30m' },
  ];
  const irow = (r) => `<div class="irow ${r.cls}"><span class="ib ${r.cls.includes('run') ? 'pz' : 'go'}">${r.cls.includes('run') ? PZ : GO}</span>`
    + (r.key ? `<span class="ik">${r.key}</span>` : '<span class="ik ask">task?</span>')
    + `<span class="if">${r.desc ? esc(r.desc) : '<span style="color:#585b70">description</span>'}</span><b class="it">${r.time}</b>`
    + `<span class="ip${r.pin ? ' on' : ''}">${PIN}</span>${r.key ? '' : '<span class="id">Delete</span>'}</div>`;
  const island = (p) => `<div class="isl ${p}">${IR.map(irow).join('')}<div class="isep"></div><div class="inew"><span>${GO}</span><span>New timer</span></div></div>`;
  const L = [
    { st: 'run', time: '48m 02s', key: 'ATL-6781', desc: 'созвон по инциденту с командой платежей' },
    { st: 'pause', time: '12m 40s', desc: 'помог соседней команде с деплоем' },
    { st: 'pause', time: '30m', key: 'ATL-6712', desc: 'PR #214 review with team' },
  ];
  $('#g-pin').innerHTML = [
    cell(island('p1'), '<b>П1 · булавка справа от времени</b> — время уходит от правого края на одну колонку', 333),
    cell(island('p2'), '<b>П2 · булавка слева, перед ▶</b> — время остаётся у правого края, как во всём приложении', 333),
    BR,
    cell(scene('dark', widget(L, { w: 262 }), 300, 130), '<b>Виджет-список, покой</b> — три приколотых таймера, идёт верхний'),
    cell(scene('dark', widget(L.map((t, i) => (i === 1 ? { ...t, rh: true } : t)), { hov: true, w: 262 }), 300, 130), '<b>Курсор на второй строке</b> — ▶ переключит счёт на неё, верхний таймер встанет'),
    cell(scene('dark', widget([L[0]], { w: 262 }), 300, 130), '<b>Для сравнения: одна булавка на остров (v34)</b> — виджет показывает один, текущий таймер'),
  ].join('');

  // ── 6 · the sandbox ──────────────────────────────────────────────
  const stage = $('#stage');
  const SW = 760, SH = 380, ROW = 26, LROW = 23.94, LPAD = 4.2;
  const SB = { bg: 'dark', plate: 45, ink: 90, mode: 'info', acts: 2, n: 1, rows: [], box: null };
  const seedRows = () => [
    { id: 1, st: 'run', sec: 47 * 60 + 15, key: 'ATL-6781', desc: 'созвон по инциденту с командой платежей' },
    { id: 2, st: 'pause', sec: 12 * 60 + 40, desc: 'помог соседней команде с деплоем' },
    { id: 3, st: 'pause', sec: 30 * 60, key: 'ATL-6712', desc: 'PR #214 review with team' },
  ].slice(0, SB.n);
  const natural = () => (SB.rows.length > 1 ? SB.rows.length * LROW + LPAD : ROW);
  function home() {
    const w = SB.n > 1 ? 262 : 250, h = Math.round(natural());
    SB.box = { x: SW - w - 14, y: SH - h - 14, w, h };
  }
  // a record at rest shows whole minutes, everything else — seconds too (as in the island)
  const timeOf = (t) => (t.key && t.st === 'pause' ? fmtHm(Math.floor(t.sec / 60)) : fmtRun(t.sec));
  // Р1: the room decides what is shown · Р2: the room decides how large it is
  function layout() {
    const { w, h } = SB.box;
    if (SB.mode === 'zoom') {
      const z = Math.min(3, Math.max(.7, h / natural()));
      return { z, size: w / z < 150 ? 's' : 'm' };
    }
    return { z: 1, size: SB.rows.length === 1 && h >= 45 && w >= 120 ? 'l' : w < 150 ? 's' : 'm' };
  }
  function applyLayout() {
    const box = $('.w-box', stage);
    if (!box) return;
    const { x, y, w, h } = SB.box;
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    const wg = $('.w', box);
    const { z, size } = layout();
    wg.classList.remove('sz-s', 'sz-m', 'sz-l');
    wg.classList.add(`sz-${size}`);
    wg.style.setProperty('--z', z.toFixed(3));
    wg.style.setProperty('--plate', SB.plate / 100);
    wg.style.setProperty('--ink', SB.ink / 100);
    const shown = size === 's' ? 'только время' : size === 'l' ? 'время, ниже — ключ и описание' : 'время, ключ и описание — сколько влезло';
    $('#readout').innerHTML = `окно виджета <b>${Math.round(w)} × ${Math.round(h)}</b> px · ${SB.mode === 'zoom' ? `масштаб <b>×${z.toFixed(2)}</b> · ` : ''}показано: <b>${shown}</b>`;
  }
  function renderBox() {
    stage.className = `scene sand-stage bg-${SB.bg}`;
    if (!SB.rows.length) {
      stage.innerHTML = backdrop(SB.bg, SW, SH);
      $('#readout').innerHTML = 'ни один таймер не приколот — виджета на рабочем столе нет';
      return;
    }
    stage.innerHTML = `${backdrop(SB.bg, SW, SH)}<div class="w-box">${widget(SB.rows.map((t) => ({ ...t, time: timeOf(t) })), { acts: SB.acts })}`
      + '<i class="rz e"></i><i class="rz s"></i><i class="rz se"></i></div>';
    applyLayout();
  }
  function syncCtl() {
    for (const b of $$('[data-bg]')) b.classList.toggle('on', b.dataset.bg === SB.bg);
    for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === SB.mode);
    for (const b of $$('[data-rows]')) b.classList.toggle('on', +b.dataset.rows === SB.n);
    for (const b of $$('[data-acts]')) b.classList.toggle('on', +b.dataset.acts === SB.acts);
    $('#r-plate').value = SB.plate;
    $('#r-ink').value = SB.ink;
    $('#v-plate').textContent = `${SB.plate} %`;
    $('#v-ink').textContent = `${SB.ink} %`;
  }
  $('.sand-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.bg) SB.bg = b.dataset.bg;
    if (b.dataset.mode) SB.mode = b.dataset.mode;
    if (b.dataset.acts) SB.acts = +b.dataset.acts;
    if (b.dataset.rows) { SB.n = +b.dataset.rows; SB.rows = seedRows(); home(); }
    if (b.id === 'b-reset') { SB.rows = seedRows(); home(); }
    syncCtl();
    renderBox();
  });
  $('#r-plate').addEventListener('input', (e) => { SB.plate = +e.target.value; syncCtl(); applyLayout(); });
  $('#r-ink').addEventListener('input', (e) => { SB.ink = +e.target.value; syncCtl(); applyLayout(); });

  // ⏸ / ▶, unpin, delete
  stage.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const id = +e.target.closest('.w-row').dataset.id;
    const t = SB.rows.find((x) => x.id === id);
    if (a === 'toggle') {
      const go = t.st === 'pause';
      if (go) for (const x of SB.rows) if (x.st !== 'pause') x.st = 'pause'; // one source counts at a time
      t.st = go ? 'run' : 'pause';
    } else {
      SB.rows = SB.rows.filter((x) => x !== t);
      if (SB.rows.length) { const h = Math.round(natural()); SB.box.y += SB.box.h - h; SB.box.h = h; }
    }
    renderBox();
  });

  // dragging by the body, resizing by the right / bottom edge
  let grab = null;
  stage.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.w-box');
    if (!box || e.target.closest('button')) return;
    const rz = e.target.closest('.rz');
    grab = { kind: rz ? rz.className.replace('rz ', '') : 'move', px: e.clientX, py: e.clientY, ...SB.box };
    box.classList.toggle('drag', !rz);
    try { box.setPointerCapture(e.pointerId); } catch { /* a scripted event has no live pointer to capture */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!grab) return;
    const dx = e.clientX - grab.px, dy = e.clientY - grab.py, b = SB.box;
    if (grab.kind === 'move') {
      b.x = Math.min(SW - b.w, Math.max(0, grab.x + dx));
      b.y = Math.min(SH - b.h, Math.max(0, grab.y + dy));
    } else {
      // in the corner of the screen there is no room to the right or below: the widget grows the other way
      if (grab.kind !== 's') { b.w = Math.min(SW, Math.max(84, grab.w + dx)); b.x = Math.min(grab.x, SW - b.w); }
      if (grab.kind !== 'e') { b.h = Math.min(SH, Math.max(22, grab.h + dy)); b.y = Math.min(grab.y, SH - b.h); }
    }
    applyLayout();
  });
  const drop = () => { grab = null; $('.w-box', stage)?.classList.remove('drag'); };
  stage.addEventListener('pointerup', drop);
  stage.addEventListener('pointercancel', drop);

  // the time goes on — the figures change in place, nothing is redrawn under the cursor
  setInterval(() => {
    for (const t of SB.rows) {
      if (t.st !== 'run') continue;
      t.sec += 1;
      const el = $(`.w-row[data-id="${t.id}"] .w-t`, stage);
      if (el) el.textContent = timeOf(t);
    }
  }, 1000);

  SB.rows = seedRows();
  home();
  syncCtl();
  renderBox();
})();
