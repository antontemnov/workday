(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ── simulated clock ──────────────────────────────────────────────
  const DAY0 = new Date(2026, 9, 26, 14, 5, 0).getTime();
  let simNow = DAY0;
  let speed = 1;
  let lastReal = performance.now();

  const fmtRun = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
  };
  const fmtHm = (min) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${pad(min % 60)}m`);
  const fmtClock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtSec = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const roundMin = (ms) => Math.max(1, Math.round(ms / 60000));
  // 1h 15m · 1h · 90 · 45m — like the app's duration field
  function parseMin(v) {
    const s = String(v).trim().toLowerCase();
    const hm = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?$/);
    if (!hm || (!hm[1] && !hm[2])) return null;
    return (+(hm[1] || 0)) * 60 + (+(hm[2] || 0));
  }

  // ── glyphs ───────────────────────────────────────────────────────
  const PZ = '<svg class="tm-pz" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.4" y="1" width="2.8" height="8" rx=".8"/><rect x="5.8" y="1" width="2.8" height="8" rx=".8"/></svg>';
  const IC = {
    x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9"/></svg>',
    pin: '<svg viewBox="0 0 12 12"><path d="M4.4 1.6h3.2M5 1.6v3L3.2 6.6h5.6L7 4.6v-3M6 6.6v3.8"/></svg>',
  };
  // The strip glyph = the session pill's words without the word: a lit ▶ runs,
  // a red ⏸ is paused, an unlit ▶ is ready. Hovering the glyph shows its action.
  const PLAY_LIT = '<svg class="tm-play lit" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.7l5.2 3.3L3 8.3z"/></svg>';
  const PLAY_DIM = '<svg class="tm-play" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.7l5.2 3.3L3 8.3z"/></svg>';
  const PLAY_AC = '<svg class="tm-play ac" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.7l5.2 3.3L3 8.3z"/></svg>';
  const PAUSE_AC = '<svg class="tm-pause-ac" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="1.6" width="2.3" height="6.8" rx=".7"/><rect x="5.7" y="1.6" width="2.3" height="6.8" rx=".7"/></svg>';
  const glyphBtn = (st) => `<span class="g-st">${st === 'run' ? PLAY_LIT : st === 'ready' ? PLAY_DIM : PZ}</span><span class="g-ac">${st === 'run' ? PAUSE_AC : PLAY_AC}</span>`;
  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];

  // ── state ────────────────────────────────────────────────────────
  const S = { mode: 'yield', timers: [], session: 'tracking', seq: 0, surface: 'tray' };
  // Widget pin per timer: a started one is pinned until unpinned, a ready one only when pinned.
  const pinnedOf = (t) => t.pinned ?? t.state !== 'ready';
  const running = () => S.timers.find((t) => t.state === 'run');
  const counts = (t) => t.state !== 'ready';
  const current = () => running() || S.timers.find(counts);
  const liveCount = () => S.timers.filter(counts).length;
  const byId = (id) => S.timers.find((t) => t.id === id);
  const elapsed = (t) => (t.fixedMs ?? (t.acc + (t.state === 'run' ? simNow - t.runSince : 0)));
  const emptyReady = (t) => t.state === 'ready' && !t.task && !t.desc;
  let nextKey = 7203;
  let edit = null; // { kind: 'desc' | 'time', id } — a strip's own field
  let form = null; // { id, act, desc, min } — Log… opened the strip into the Log form

  // ── DOM handles ──────────────────────────────────────────────────
  const desk = $('#desk');
  const wd = $('#wd');
  const ide = $('#ide');
  const browser = $('#browser');
  const widget = $('#widget');
  const appEl = $('.app', wd);
  const hdr = $('.header', appEl);
  const ngOf = (el) => [...el.attributes].find((a) => a.name.startsWith('_ngcontent')).name;
  const NG_APP = ngOf(hdr);
  const dayView = $('app-day-view', appEl);
  const content = $('.content', dayView);
  const dayHead = $('.day-head', dayView);
  const NG_DAY = ngOf(dayHead);
  const dayTotal = $('.day-total', dayHead);
  const logBtn = $('.g-btn', dayHead);
  const lpTable = $('.lp-table', dayView);
  const sesRow = $('.blk.hot app-session-row', dayView);
  const sesBtn = sesRow && $('.tb', sesRow);

  // Feed templates: a one-entry block and an entry row (the logged panel's own markup).
  const tplBlk = $('.blk.one[data-task="APP-1024"]', lpTable).cloneNode(true);
  const tplEnt = $('.wl.ent[data-eid="m2"]', lpTable).cloneNode(true);
  // Log… on a strip = the suggestion's candy capsule, re-dyed mauve (it makes a logged record).
  const tplLog = $('.btn-log', $$('app-suggestion-row', lpTable).find((r) => $('.btn-log', r))).cloneNode(true);
  tplLog.classList.add('ts-log');
  tplLog.dataset.a = 'log';
  const LOG_BTN = (id) => { tplLog.dataset.id = id; return tplLog.outerHTML; };

  // ── windows, z-order ─────────────────────────────────────────────
  let zTop = 10;
  const raise = (el) => { el.style.zIndex = String(++zTop); };
  for (const w of [ide, wd, browser]) w.addEventListener('mousedown', () => raise(w), true);

  // ── titlebar: the dial at the view icons (T2 of v12) ─────────────
  const anchor = document.createElement('button');
  anchor.type = 'button';
  const wc = document.createElement('div');
  wc.innerHTML = `<div ${NG_APP} class="win-controls"><button ${NG_APP} class="wc-btn" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1 5.5h8"/></svg></button><button ${NG_APP} class="wc-btn wc-close" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`;
  hdr.append(wc.firstElementChild);

  function mountNav(header, btn) {
    const sw = $('.view-switcher', header);
    $('.tm-ndiv', header)?.remove();
    const div = document.createElement('span');
    div.className = 'tm-ndiv';
    sw.after(div);
    div.after(btn);
  }

  // The dial: a stopwatch in the view-icon stroke; the sector is the minutes
  // of the current hour. Several timers — a second dial peeks from behind.
  let dialSeq = 0;
  function dialSvg(state, ms, multi) {
    const fr = state === 'idle' ? 0 : ((ms / 60000) % 60) / 60;
    const ang = fr * 2 * Math.PI;
    const cx = 8, cy = 9.2, rs = 4.1, rh = 3.4;
    let sec = '';
    if (state !== 'idle' && fr > 0.004) {
      if (fr > 0.996) sec = `<circle class="sec" cx="${cx}" cy="${cy}" r="${rs}"/>`;
      else {
        const x = (cx + rs * Math.sin(ang)).toFixed(2);
        const y = (cy - rs * Math.cos(ang)).toFixed(2);
        sec = `<path class="sec" d="M${cx} ${cy} L${cx} ${(cy - rs).toFixed(2)} A${rs} ${rs} 0 ${fr > 0.5 ? 1 : 0} 1 ${x} ${y} Z"/>`;
      }
    }
    const inner = state === 'pause' || state === 'yield'
      ? '<rect class="pz" x="5.85" y="7.1" width="1.55" height="4.2" rx=".55"/><rect class="pz" x="8.6" y="7.1" width="1.55" height="4.2" rx=".55"/>'
      : `<path class="hand" d="M${cx} ${cy} L${(cx + rh * Math.sin(ang)).toFixed(2)} ${(cy - rh * Math.cos(ang)).toFixed(2)}"/>`;
    let back = '';
    if (multi) {
      const id = `tm-dm-${++dialSeq}`;
      back = `<mask id="${id}"><rect x="-2" y="-2" width="24" height="20" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="7.1" fill="#000"/></mask>`
        + `<circle class="ring back" cx="${cx + 4.6}" cy="${cy}" r="5.6" mask="url(#${id})"/>`;
    }
    const w = multi ? 20 : 16;
    return `<svg class="tm-dial${multi ? ' multi' : ''}" viewBox="0 0 ${w} 16" aria-hidden="true">${back}<path class="crown" d="M6.4 1.2h3.2M8 1.2v2.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5.6"/>${sec}${inner}</svg>`;
  }
  function navParts(t, multi) {
    const st = t ? t.state : 'idle';
    const ms = t ? elapsed(t) : 0;
    const live = t && t.id;
    const text = t ? `<span class="tm-min"${live ? ` data-nav="${t.id}"` : ''}>${fmtRun(ms)}</span>` : '';
    return {
      cls: `tm-nav ${st}${multi ? ' multi' : ''}`,
      html: `<span class="tm-dw"${live ? ` data-dial="${t.id}"` : ''}>${dialSvg(st, ms, multi)}</span>${text}`,
    };
  }
  function renderAnchor() {
    const p = navParts(current(), liveCount() > 1);
    anchor.className = p.cls;
    anchor.innerHTML = p.html;
  }
  mountNav(hdr, anchor);
  // The dial = the timer's own button: from any tab it opens Day with a new
  // ready strip, the cursor in its description.
  anchor.addEventListener('click', () => {
    showView('day');
    addReady();
  });

  // ── views (Day / Sheets / Settings) ──────────────────────────────
  const views = { day: dayView };
  for (const [k, id] of [['set', 'tpl-set'], ['sheet', 'tpl-sheet']]) {
    const el = $(`#${id}`).content.firstElementChild.cloneNode(true);
    el.style.display = 'none';
    appEl.insertBefore(el, dayView.nextSibling);
    views[k] = el;
  }
  const defaultsSec = $$('.settings-section', views.set).find((s) => $('h3', s)?.textContent.trim() === 'Defaults');
  const NG_SET = ngOf(defaultsSec);
  const timerSec = document.createElement('div');
  timerSec.setAttribute(NG_SET, '');
  timerSec.className = 'settings-section';
  timerSec.innerHTML = `<h3 ${NG_SET}>Timer</h3><div ${NG_SET} class="opt-row"><div ${NG_SET} class="left"><span ${NG_SET} class="name">With sessions</span>`
    + `<span ${NG_SET} class="hint">Yield — a git session that wakes up pauses the timer; it comes back by click. Parallel — both count.</span></div>`
    + `<div ${NG_SET} class="right"><div ${NG_SET} class="seg"><button ${NG_SET} data-setmode="yield"> Yield </button><button ${NG_SET} data-setmode="parallel"> Parallel </button></div></div></div>`;
  defaultsSec.after(timerSec);
  timerSec.addEventListener('click', (e) => { const b = e.target.closest('[data-setmode]'); if (b) setMode(b.dataset.setmode); });
  const viewBtns = { Day: 'day', Timesheets: 'sheet', Settings: 'set' };
  function showView(v) {
    for (const [k, el] of Object.entries(views)) el.style.display = k === v ? '' : 'none';
    for (const x of $$('.view-btn', hdr)) x.classList.toggle('active', viewBtns[x.getAttribute('title')] === v);
  }
  for (const b of $$('.view-btn', hdr)) b.addEventListener('click', () => showView(viewBtns[b.getAttribute('title')]));

  // ── the hot session (ATL-6781 · web-frontend) ────────────────────
  function setSession(state) {
    S.session = state;
    if (!sesRow) return;
    const tr = state === 'tracking';
    sesRow.classList.toggle('lead', tr);
    sesRow.classList.toggle('paused', !tr);
    sesBtn.classList.toggle('lead', tr);
    sesBtn.classList.toggle('willp', !tr);
  }

  // ── event log ────────────────────────────────────────────────────
  const evlog = $('#evlog');
  function log(msg) {
    const d = document.createElement('div');
    d.className = 'ev';
    d.innerHTML = `<b>${fmtSec(simNow)}</b>${msg}`;
    evlog.prepend(d);
    while (evlog.children.length > 12) evlog.lastChild.remove();
  }

  // ── timer actions ────────────────────────────────────────────────
  const label = (t) => `#${t.id}${t.task ? ' ' + t.task : ''}`;
  function yieldSessions() {
    if (S.mode !== 'yield' || S.session !== 'tracking') return '';
    setSession('paused');
    return ' — сессия web-frontend на паузе';
  }
  function sessionsBack() {
    if (running() || S.session === 'tracking') return '';
    setSession('tracking');
    return ' — сессии вернулись к своему циклу';
  }
  function haltRun(t, state) {
    if (t.state === 'run') { t.acc += simNow - t.runSince; t.runSince = null; }
    t.state = state;
  }
  function materialize() {
    const t = { id: ++S.seq, task: null, title: '', desc: '', firstAt: null, acc: 0, runSince: null, state: 'ready' };
    S.timers.push(t);
    return t;
  }
  function addReady() {
    commitEdit();
    const t = S.timers.find(emptyReady) || materialize();
    edit = { kind: 'desc', id: t.id };
    log(`циферблат → Day, новая заготовка #${t.id}: курсор в описании, ▶ — старт; пустая уйдёт сама`);
    render();
  }
  function pauseT(t) {
    haltRun(t, 'pause');
    log(`⏸ таймер ${label(t)} на паузе${sessionsBack()}`);
    render();
  }
  function resumeT(t) {
    const r = running();
    if (r && r !== t) haltRun(r, 'pause');
    const fresh = t.state === 'ready';
    if (t.firstAt == null) t.firstAt = simNow;
    t.state = 'run';
    t.runSince = simNow;
    log(`▶ таймер ${label(t)} ${fresh ? 'пошёл' : 'снова считает'}${r && r !== t ? `, #${r.id} на паузе` : ''}${yieldSessions()}`);
    render();
  }
  function toggleT(t) { if (t.state === 'run') pauseT(t); else resumeT(t); }  // ready / pause / yield → run
  function removeT(t) {
    const had = t.state !== 'ready';
    S.timers = S.timers.filter((x) => x !== t);
    if (form && form.id === t.id) form = null;
    log(had ? `✕ таймер ${label(t)} удалён вместе с ${fmtRun(elapsed(t))}${sessionsBack()}` : `✕ заготовка ${label(t)} убрана`);
    render();
  }
  function pruneReady(keepId) {
    const before = S.timers.length;
    S.timers = S.timers.filter((t) => !emptyReady(t) || t.id === keepId);
    return S.timers.length !== before;
  }
  function gitActivity() {
    const r = running();
    const wasTracking = S.session === 'tracking';
    setSession('tracking');
    if (r && S.mode === 'yield') {
      haltRun(r, 'yield');
      log(`git-правка в web-frontend → сессия выиграла, таймер ${label(r)} на паузе · вернуть — только кликом`);
    } else if (r) {
      log(`git-правка в web-frontend → сессия считает, таймер ${label(r)} тоже (parallel)`);
    } else {
      log(`git-правка в web-frontend → сессия ${wasTracking ? 'и так считает' : 'проснулась'}`);
    }
    render();
  }

  // ── the dock: narrow strips on the day header's own glass ─────────
  // A second storey of .day-head: the header line keeps its geometry, the
  // strips wrap under it and the header's melt moves below the last strip.
  const dock = document.createElement('div');
  dock.setAttribute(NG_DAY, '');
  dayHead.append(dock);

  const icb = (a, id, icon, extra = '') => `<button type="button" class="ts-ic${extra}" data-a="${a}" data-id="${id}">${icon}</button>`;
  function keyHTML(t, need = false) {
    return t.task
      ? `<button type="button" class="ts-key" data-a="pick" data-id="${t.id}">${esc(t.task)}</button>`
      : `<button type="button" class="ts-key ask${need ? ' need' : ''}" data-a="pick" data-id="${t.id}">task?</button>`;
  }
  function stripHTML(t, live = true) {
    if (live && form && form.id === t.id) return formHTML(t);
    const st = t.state;
    const ed = live && edit && edit.id === t.id ? edit.kind : null;
    const descCls = t.desc ? '' : t.title ? ' ttl' : ' ph';
    const desc = ed === 'desc'
      ? `<input class="ts-in" data-in="desc" value="${esc(edit.val ?? t.desc)}" placeholder="what is it?">`
      : `<span class="ts-desc${descCls}" data-a="desc" data-id="${t.id}">${esc(t.desc || t.title || 'what is it?')}</span>`;
    let time = '<span class="ts-time"></span>';
    if (st !== 'ready') {
      time = ed === 'time'
        ? `<input class="ts-tin" data-in="time" value="${esc(edit.val ?? `${Math.round(elapsed(t) / 60000)}m`)}">`
        : `<span class="ts-time" data-a="time" data-id="${t.id}"${live ? ` data-t="${t.id}"` : ''}>${fmtRun(elapsed(t))}</span>`;
    }
    const ctl = (st === 'ready' ? '' : LOG_BTN(t.id)) + icb('pin', t.id, IC.pin, pinnedOf(t) ? ' on' : '') + icb('x', t.id, IC.x);
    const word = st === 'yield' ? '<span class="ts-word">session</span>' : '';
    return `<div class="ts ${st}" data-sid="${t.id}">`
      + `<button type="button" class="ts-g" data-a="toggle" data-id="${t.id}">${glyphBtn(st)}</button>`
      + `${keyHTML(t)}${desc}<span class="ts-r"><span class="ts-ctl">${ctl}</span>${word}${time}</span></div>`;
  }
  // Log… turns the strip into the Log form in place — the logged row's own
  // form: ← · activity · description · Log, the minutes stay in the time slot.
  function formHTML(t, f = form) {
    const opts = ACTS.map((a) => `<option${a === f.act ? ' selected' : ''}>${a}</option>`).join('');
    return `<div class="ts form" data-sid="${t.id}">`
      + `<button type="button" class="ts-back" data-a="fcancel" data-id="${t.id}">←</button>`
      + keyHTML(t, true)
      + `<select class="ts-act" data-f="act">${opts}</select>`
      + `<input class="ts-fdesc" data-f="desc" value="${esc(f.desc)}" placeholder="description">`
      + `<button type="button" class="ts-save" data-a="flog" data-id="${t.id}"${t.task ? '' : ' disabled'}>Log</button>`
      + `<input class="ts-fmin" data-f="min" value="${fmtHm(f.min)}"></div>`;
  }
  function renderDock() {
    // a re-render keeps what is being typed
    const typing = $('[data-in]', dock);
    if (edit && typing) edit.val = typing.value;
    if (form && $('[data-f]', dock)) readForm();
    const has = S.timers.length > 0;
    dayHead.classList.toggle('tm-docked', has);
    dock.className = `tm-dock s-${S.surface}`;
    dock.innerHTML = S.timers.map((t) => stripHTML(t)).join('');
    const inp = $('[data-in]', dock) || (form && $('[data-f="desc"]', dock));
    if (inp) { inp.focus(); if (inp.dataset.in) inp.select(); }
  }

  function commitEdit() {
    if (!edit) return;
    const inp = $('[data-in]', dock);
    const t = byId(edit.id);
    if (inp && t) applyInput(t, edit.kind, inp.value);
    edit = null;
  }
  function applyInput(t, kind, value) {
    if (kind === 'desc') {
      t.desc = value.trim();
    } else {
      const m = parseMin(value);
      if (m == null) return;
      const target = m * 60000;
      t.acc = t.state === 'run' ? target - (simNow - t.runSince) : target;
      log(`✎ таймер ${label(t)}: время → ${fmtRun(target)}, счёт продолжается от него`);
    }
  }
  function readForm() {
    if (!form) return;
    const f = (k) => $(`[data-f="${k}"]`, dock);
    if (f('act')) form.act = f('act').value;
    if (f('desc')) form.desc = f('desc').value;
    const m = f('min') && parseMin(f('min').value);
    if (m) form.min = m;
  }
  function openForm(t) {
    commitEdit();
    form = { id: t.id, act: t.task ? 'Other' : 'Development', desc: t.desc, min: roundMin(elapsed(t)) };
    log(`Log… ${label(t)} → строка стала формой Log; таймер ${t.state === 'run' ? 'идёт дальше, пока не нажат Log' : 'стоит'}`);
    render();
  }

  dock.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el) { if (!form) render(); return; }
    const a = el.dataset.a;
    const t = byId(+el.dataset.id);
    if (!t) { render(); return; }
    if (a === 'desc' || a === 'time') {
      if (edit && edit.id === t.id && edit.kind === a) return;
      commitEdit();
      edit = { kind: a, id: t.id };
      render();
      return;
    }
    commitEdit();
    readForm();
    switch (a) {
      case 'toggle': toggleT(t); break;
      case 'pick': openCloud('pick', { id: t.id }); break;
      case 'log': openForm(t); break;
      case 'fcancel': form = null; log(`← форма закрыта, таймер ${label(t)} как был`); render(); break;
      case 'flog': submitLog(t); break;
      case 'x': removeT(t); break;
      case 'pin': t.pinned = !pinnedOf(t); log(t.pinned ? `📌 таймер ${label(t)} на виджете` : `булавка снята — таймер ${label(t)} только в приложении`); render(); break;
      default: render();
    }
  });
  dock.addEventListener('keydown', (e) => {
    if (e.target.closest('[data-in]')) {
      if (e.key === 'Enter') { const id = edit && edit.id; commitEdit(); pruneReady(); render(); if (id && byId(id)?.state === 'ready') log(`заготовка #${id} ждёт ▶`); }
      if (e.key === 'Escape') { edit = null; pruneReady(); render(); e.stopPropagation(); }
      return;
    }
    if (e.target.closest('[data-f]') && form) {
      if (e.key === 'Enter') { readForm(); submitLog(byId(form.id)); }
      if (e.key === 'Escape') { form = null; render(); e.stopPropagation(); }
    }
  });
  document.addEventListener('wheel', (e) => {
    const inp = e.target.closest && e.target.closest('[data-in="time"], [data-f="min"]');
    if (!inp) return;
    e.preventDefault();
    const m = Math.max(0, (parseMin(inp.value) || 0) + (e.deltaY < 0 ? 15 : -15));
    inp.value = inp.dataset.f ? fmtHm(m) : `${m}m`;
  }, { passive: false });
  // Outside the dock: a field edit commits, an empty ready strip goes away.
  document.addEventListener('pointerdown', (e) => {
    if (dock.contains(e.target) || cloud.contains(e.target) || anchor.contains(e.target)) return;
    const had = !!edit;
    commitEdit();
    if (pruneReady() || had) render();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cloudState) closeCloud(); }, true);

  // ── Log: the strip leaves the dock, the record lands in the feed ──
  const feedUndo = [];
  const totalOrig = dayTotal.textContent;
  function bumpTotal(min) {
    const m = dayTotal.textContent.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
    const cur = (+(m[1] || 0)) * 60 + (+(m[2] || 0));
    dayTotal.textContent = fmtHm(cur + min);
    dayTotal.classList.add('flash');
    setTimeout(() => dayTotal.classList.remove('flash'), 1300);
  }
  const sumOf = (blk) => parseMin($('.sum', blk).textContent.replace(/\s+/g, ' ')) || 0;
  function addToFeed(task, title, act, desc, min) {
    const ent = tplEnt.cloneNode(true);
    ent.removeAttribute('data-eid');
    $('.c-type', ent).textContent = act;
    $('.c-ds', ent).textContent = desc;
    let blk = $(`.blk[data-task="${task}"]`, lpTable);
    if (blk) {
      const sum0 = $('.sum', blk).textContent;
      const wasOne = blk.classList.contains('one');
      if (wasOne) {
        for (const d of $$('.wl .c-dur, app-session-row .dur', blk)) if (!d.textContent) { d.dataset.tmBlank = '1'; d.textContent = sum0; }
        blk.classList.remove('one');
      }
      $('.c-dur', ent).textContent = fmtHm(min);
      $('.blk-body', blk).append(ent);
      $('.sum', blk).textContent = fmtHm(sumOf(blk) + min);
      feedUndo.push(() => {
        ent.remove();
        $('.sum', blk).textContent = sum0;
        if (wasOne) { blk.classList.add('one'); for (const d of $$('[data-tm-blank]', blk)) { d.textContent = ''; delete d.dataset.tmBlank; } }
      });
      return ent;
    }
    blk = tplBlk.cloneNode(true);
    blk.dataset.task = task;
    $('.tkt', blk).textContent = task;
    const nm = $('.c-nm', blk);
    nm.textContent = title || '— name not cached';
    nm.classList.toggle('none', !title);
    $('.sum', blk).textContent = fmtHm(min);
    const body = $('.blk-body', blk);
    body.innerHTML = '';
    $('.c-dur', ent).textContent = '';
    body.append(ent);
    // freshest logged record on top of the logged part of the feed
    const first = $$('.blk', lpTable).find((b) => !b.classList.contains('hot'));
    lpTable.insertBefore(blk, first || null);
    blk.style.order = '2';
    feedUndo.push(() => blk.remove());
    return blk;
  }
  // The record drops from the strip's place to its own: one move down
  // through the header glass and the feed — no scrolling, the feed stays put.
  // Logged history sits under the suggestions, so the landing may be below
  // the fold; the total's flash is the confirmation that stays in view.
  function fly(el, from) {
    const at = el.getBoundingClientRect();
    el.animate([
      { transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.25,1)' });
    el.classList.add('tm-landed');
    setTimeout(() => el.classList.remove('tm-landed'), 2600);
  }
  function submitLog(t) {
    if (!t || !form) return;
    if (!t.task) {
      log(`Log погашен — у ${label(t)} нет тикета: task? → облако`);
      const k = $('.ts-key.ask', dock);
      if (k) { k.classList.remove('nudge'); void k.offsetWidth; k.classList.add('nudge'); }
      return;
    }
    const strip = $(`[data-sid="${t.id}"]`, dock);
    const from = strip.getBoundingClientRect();
    const { act, desc, min } = form;
    S.timers = S.timers.filter((x) => x !== t);
    form = null;
    log(`Log → ManualEntry ${t.task} · ${act} · ${fmtHm(min)}${desc ? ` · «${esc(desc)}»` : ''}, sourceRef timer:${t.id}; полоска ушла в ленту${sessionsBack()}`);
    render();
    const el = addToFeed(t.task, t.title, act, desc, min);
    fly(el, from);
    bumpTotal(min);
  }

  // ── cloud: one picker for Log and for the timer ──────────────────
  const cloud = $('app-log-cloud', appEl);
  const backdrop = $('.cloud-backdrop', appEl);
  appEl.append(backdrop, cloud);
  const cloudInput = $('.cloud-filter input', cloud);
  const chips = $('.cloud-chips', cloud);
  const NG_CLOUD = ngOf($('.fav', chips));
  const origPlaceholder = cloudInput.placeholder;
  let cloudState = null; // { mode: 'log' | 'pick', target }

  const mkLabel = (text, extra = '') => { const s = document.createElement('span'); s.setAttribute(NG_CLOUD, ''); s.className = `row-label ${extra}`; s.textContent = text; return s; };
  const mkChip = (task, name, cls) => {
    const s = document.createElement('span');
    s.setAttribute(NG_CLOUD, '');
    s.className = `fav ${cls}`;
    s.innerHTML = `<span ${NG_CLOUD} class="f-task">${esc(task)}</span><span ${NG_CLOUD} class="f-name">${esc(name)}</span>`;
    return s;
  };
  const createChip = mkChip('＋', 'Create in Jira…', 'tm-create');
  const foot = document.createElement('div');
  foot.className = 'tm-foot';
  foot.append(createChip);
  $('.cloud-body', cloud).after(foot);
  foot.addEventListener('click', () => { if (cloudState) openJiraForm(); });
  let createdLbl = null;

  // The cloud hangs under the whole header — strips included.
  function openCloud(mode, target) {
    cloudState = { mode, target };
    cloud.classList.add('open');
    cloud.classList.toggle('tm-pick', mode === 'pick');
    backdrop.classList.add('open');
    const top = dayHead.getBoundingClientRect().bottom - appEl.getBoundingClientRect().top - 4;
    cloud.style.top = `${Math.round(top)}px`;
    cloudInput.value = '';
    cloudInput.placeholder = mode !== 'pick' ? origPlaceholder : 'ticket for the timer · no match → search Jira';
    foot.hidden = mode !== 'pick';
    filterChips();
    setTimeout(() => cloudInput.focus(), 40);
  }
  function closeCloud() {
    cloud.classList.remove('open', 'tm-pick');
    backdrop.classList.remove('open');
    cloudState = null;
  }
  backdrop.addEventListener('click', () => { closeCloud(); if (pruneReady()) render(); });
  logBtn.addEventListener('click', () => openCloud('log'));
  cloudInput.addEventListener('input', filterChips);
  function filterChips() {
    const q = cloudInput.value.trim().toLowerCase();
    let lastLabel = null;
    let any = false;
    const flush = () => { if (lastLabel) lastLabel.classList.toggle('tm-hide', !any); };
    for (const el of [...chips.children]) {
      if (el.classList.contains('row-label')) { flush(); lastLabel = el; any = false; continue; }
      const hit = !q || el.textContent.toLowerCase().includes(q);
      el.classList.toggle('tm-hide', !hit);
      if (hit) any = true;
    }
    flush();
    $('.f-name', createChip).textContent = q ? `Create “${cloudInput.value.trim()}” in Jira` : 'Create in Jira…';
  }
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.fav');
    if (!chip || !cloudState) return;
    const task = $('.f-task', chip).textContent.trim();
    const name = $('.f-name', chip).textContent.trim();
    pick(task, name, !chip.classList.contains('jira'));
  });
  function pick(task, name, isFav) {
    const st = cloudState;
    closeCloud();
    if (st.mode === 'log') { log(`+ Log → ${task}: дальше обычная форма Log облака (как сейчас)`); return; }
    const t = byId(st.target.id);
    if (!t) { render(); return; }
    t.task = task;
    t.title = isFav ? '' : name;
    if (isFav && !t.desc) t.desc = name;
    if (form && form.id === t.id && isFav && !form.desc) form.desc = name;
    log(`таймер #${t.id} ← ${task}${isFav ? ` · «${name}»` : ''}${t.state === 'ready' ? ' — ждёт ▶' : ''}${form && form.id === t.id ? ' — форма Log ждёт' : ''}`);
    render();
  }

  // ── Create in Jira: the real form, in the browser ────────────────
  const brSum = $('#brSum');
  function openJiraForm() {
    const owner = cloudState && cloudState.mode === 'pick' ? byId(cloudState.target.id) : null;
    const summary = cloudInput.value.trim() || (owner && owner.desc) || '';
    brSum.value = summary;
    $('#brUrl').innerHTML = `your-site.atlassian.net<b>/secure/CreateIssueDetails!init.jspa?pid=…&amp;summary=${esc(encodeURIComponent(summary))}</b>`;
    browser.hidden = false;
    raise(browser);
    log(`Create in Jira → форма создания в браузере${summary ? ` (summary: «${esc(summary)}»)` : ''}`);
  }
  const closeBrowser = () => { browser.hidden = true; };
  $('#brX').addEventListener('click', closeBrowser);
  $('#brCancel').addEventListener('click', closeBrowser);
  $('#brCreate').addEventListener('click', () => {
    const key = `ATL-${nextKey++}`;
    const name = brSum.value.trim() || 'New ticket';
    closeBrowser();
    for (const c of $$('.tm-new', chips)) c.classList.remove('tm-new');
    if (!createdLbl) { createdLbl = mkLabel('jira · created just now', 'jira'); chips.prepend(createdLbl); }
    const chip = mkChip(key, name, 'jira mine tm-new');
    createdLbl.after(chip);
    filterChips();
    log(`в Jira создан ${key} — первым чипом в облаке, привязка одним кликом`);
  });

  // ── the widget: one window, a stack of pinned strips ─────────────
  // Several pins never mean several windows (each would be a WebView2).
  const wPos = { x: 318, y: 36, w: 250, rowH: 46 };
  const pinnedList = () => S.timers.filter(pinnedOf);
  function widgetRow(t, live) {
    const key = t.task ? `<span class="tw-key">${esc(t.task)}</span>` : '<span class="tw-key ask">task?</span>';
    const desc = t.state === 'yield'
      ? '<span class="tw-desc word">session</span>'
      : `<span class="tw-desc${t.desc ? '' : ' ph'}">${t.desc ? esc(t.desc) : 'what is it?'}</span>`;
    const time = t.state === 'ready' ? '<span class="tw-time"></span>'
      : `<span class="tw-time"${live ? ` data-t="${t.id}"` : ''}>${fmtRun(elapsed(t))}</span>`;
    return `<div class="tw-row ${t.state}" data-wid="${t.id ?? ''}"><button type="button" class="tw-g" data-w="toggle">${glyphBtn(t.state)}</button>`
      + `<div class="tw-mid">${key}${desc}</div>${time}<button type="button" class="tw-pin" data-w="unpin">${IC.pin}</button></div>`;
  }
  const stackH = (n, rowH) => rowH * n + (n - 1);
  function placeWidget(n = pinnedList().length) {
    Object.assign(widget.style, { left: `${wPos.x}px`, top: `${wPos.y}px`, width: `${wPos.w}px`, height: `${stackH(n, wPos.rowH)}px` });
  }
  function renderWidget() {
    const list = pinnedList();
    widget.hidden = !list.length;
    if (!list.length) return;
    widget.className = `tm-widget${list.some((t) => t.state === 'run') ? ' run' : ''}`;
    widget.innerHTML = list.map((t) => widgetRow(t, true)).join('') + '<span class="tw-grip" data-w="grip"></span>';
    placeWidget(list.length);
  }
  widget.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w === 'toggle' || w === 'unpin') return;
    e.preventDefault();
    const grip = w === 'grip';
    const n = pinnedList().length;
    const st = { cx: e.clientX, cy: e.clientY, ...wPos };
    let moved = false;
    widget.classList.add('dragging');
    const mv = (ev) => {
      const dx = ev.clientX - st.cx;
      const dy = ev.clientY - st.cy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (grip) { wPos.w = clamp(st.w + dx, 170, 480); wPos.rowH = clamp(st.rowH + dy / n, 34, 130); }
      else { wPos.x = clamp(st.x + dx, 0, desk.clientWidth - wPos.w); wPos.y = clamp(st.y + dy, 0, desk.clientHeight - 40 - stackH(n, wPos.rowH)); }
      placeWidget(n);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      widget.classList.remove('dragging');
      if (!moved && !grip) { raise(wd); showView('day'); content.scrollTop = 0; log('клик по виджету → приложение впереди, вкладка Day, полоски под шапкой'); }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
  widget.addEventListener('click', (e) => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    const row = e.target.closest('[data-wid]');
    const t = row && byId(+row.dataset.wid);
    if (!t) return;
    if (w === 'toggle') toggleT(t);
    if (w === 'unpin') { t.pinned = false; log(`булавка снята с виджета — таймер ${label(t)} только в приложении`); render(); }
  });

  // ── tray icon ────────────────────────────────────────────────────
  const DEMON = '<path d="M 12.8 32.8 Q 9.6 22.4 14.6 13.6 Q 21.8 20 25.6 28 Z" fill="#b7bdda"/><path d="M 51.2 32.8 Q 54.4 22.4 49.4 13.6 Q 42.2 20 38.4 28 Z" fill="#b7bdda"/><path fill-rule="evenodd" fill="#b7bdda" d="M 9.4 55 C 9.6 46 10.8 40 13.2 36 C 15.6 27.6 22.4 25.6 32 25.6 C 41.6 25.6 48.4 27.6 50.8 36 C 53.2 40 54.4 46 54.6 55 Q 32 62.5 9.4 55 Z M 16.8 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z M 33.6 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z"/>';
  const EYES = '<ellipse cx="23.6" cy="42.8" rx="6.4" ry="8.9" fill="#2aa757"/><ellipse cx="40.4" cy="42.8" rx="6.4" ry="8.9" fill="#2aa757"/><ellipse cx="23.6" cy="42.8" rx="3" ry="4.6" fill="#d9ffe0"/><ellipse cx="40.4" cy="42.8" rx="3" ry="4.6" fill="#d9ffe0"/>';
  let maskSeq = 0;
  function traySvg(eyes, clock, size) {
    const m = `tm-cut-${++maskSeq}`;
    const fill = clock === 'run' ? 'rgb(198,222,120)' : '#7f849c';
    const badge = !clock ? '' : `<g>
      <rect x="45.4" y="31.6" width="7.2" height="4.6" rx="1.2" fill="${fill}"/>
      <circle cx="49" cy="49" r="12.6" fill="${fill}"/>
      ${clock === 'run'
        ? '<path d="M49 49 L49 41.4" stroke="#1e1e2e" stroke-width="2.8" stroke-linecap="round"/><circle cx="49" cy="49" r="2.2" fill="#1e1e2e"/>'
        : '<rect x="44.6" y="43.4" width="3.2" height="11.2" rx="1" fill="#1e1e2e"/><rect x="50.2" y="43.4" width="3.2" height="11.2" rx="1" fill="#1e1e2e"/>'}
    </g>`;
    const mask = clock ? `<mask id="${m}"><rect width="64" height="64" fill="#fff"/><circle cx="49" cy="49" r="16" fill="#000"/><rect x="42.4" y="28.6" width="13.2" height="10" rx="3" fill="#000"/></mask>` : '';
    return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${mask}<g${clock ? ` mask="url(#${m})"` : ''}><g transform="translate(32 32) scale(1.17) translate(-32 -36.8)">${DEMON}${eyes ? EYES : ''}</g></g>${badge}</svg>`;
  }
  function renderTray() {
    const t = current();
    const clock = t ? (t.state === 'run' ? 'run' : 'pause') : null;
    const eyes = S.session === 'tracking';
    $('#trayIc').innerHTML = traySvg(eyes, clock, 22);
    $('#trayZoom').innerHTML = traySvg(eyes, clock, 52);
  }

  // ── toolbar ──────────────────────────────────────────────────────
  function setMode(m) {
    S.mode = m;
    log(m === 'yield' ? 'режим yield: сессия выигрывает, возврат таймера кликом' : 'режим parallel: таймер и сессии не мешают друг другу');
    if (m === 'yield' && running()) log('(уже идущие таймер и сессия не трогаем — правило сработает на следующем событии)');
    render();
  }
  function syncToolbar() {
    for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === S.mode);
    for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === speed);
    for (const b of $$('[data-surface]')) b.classList.toggle('on', b.dataset.surface === S.surface);
    for (const b of $$('[data-setmode]')) b.classList.toggle('active', b.dataset.setmode === S.mode);
  }
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    if (b.dataset.speed) { speed = +b.dataset.speed; syncToolbar(); }
    if (b.dataset.surface) { S.surface = b.dataset.surface; render(); buildStrips(); }
    if (b.dataset.act === 'git') gitActivity();
    if (b.dataset.preset) preset(b.dataset.preset);
  });

  function reset() {
    closeCloud(); closeBrowser();
    edit = null; form = null;
    S.timers = []; S.seq = 0; S.mode = 'yield';
    simNow = DAY0;
    nextKey = 7203;
    while (feedUndo.length) feedUndo.pop()();
    dayTotal.textContent = totalOrig;
    content.scrollTop = 0;
    for (const c of $$('.fav.jira.mine', chips)) if (/^ATL-72\d\d$/.test($('.f-task', c).textContent)) c.remove();
    if (createdLbl) { createdLbl.remove(); createdLbl = null; }
    setSession('tracking');
    showView('day');
    evlog.innerHTML = '';
  }
  const mkT = (o) => ({ id: ++S.seq, task: null, title: '', desc: '', firstAt: simNow - (o.acc || 0), acc: 0, runSince: null, state: 'pause', ...o });
  const mm = (m, s = 0) => (m * 60 + s) * 1000;
  function preset(name) {
    reset();
    if (name === 'run') {
      const t = mkT({ desc: 'разбор 500-х на checkout', acc: mm(47, 15), state: 'run' });
      t.runSince = simNow;
      S.timers = [t]; setSession('paused');
      log('сцена: идёт таймер без тикета — полоска под датой, сессия web-frontend на паузе (yield)');
    }
    if (name === 'two' || name === 'form') {
      const a = mkT({ desc: 'разбор 500-х на checkout', acc: mm(47, 15) });
      const b = mkT({ task: 'ATL-7014', title: 'Save pipeline drops middle names on import', desc: 'созвон с QA', acc: mm(12), state: 'run' });
      b.runSince = simNow;
      const c = mkT({ task: 'ATL-7020', title: 'Organization tree: drag-and-drop reorder', desc: 'ревью PR коллеги', state: 'ready', firstAt: null });
      S.timers = [a, b, c]; setSession('paused');
      if (name === 'form') {
        form = { id: b.id, act: 'Meeting', desc: b.desc, min: roundMin(elapsed(b)) };
        log('сцена: Log… на ATL-7014 — строка стала формой, минуты в своём слоте, Log = запись в ленту');
      } else {
        log('сцена: #1 на паузе, #2 идёт, #3 — заготовка ждёт ▶; порядок = порядок добавления');
      }
    }
    if (name === 'yield') {
      const t = mkT({ desc: 'разбор 500-х на checkout', acc: mm(23, 40), state: 'yield' });
      S.timers = [t]; setSession('tracking');
      log('сцена: git-правка — сессия выиграла, таймер стоит; вернуть — кликом ▶');
    }
    if (name === 'five') {
      const list = [
        mkT({ desc: 'разбор 500-х на checkout', acc: mm(47, 15) }),
        mkT({ task: 'ATL-7014', title: 'Save pipeline drops middle names on import', desc: 'созвон с QA', acc: mm(12), state: 'run' }),
        mkT({ task: 'ATL-6712', desc: 'ревью PR #214', acc: mm(1, 30) }),
        mkT({ desc: 'помог соседней команде с деплоем', acc: mm(65) }),
        mkT({ task: 'ATL-7020', title: 'Organization tree: drag-and-drop reorder', desc: 'ревью PR коллеги', state: 'ready', firstAt: null }),
      ];
      list[1].runSince = simNow;
      S.timers = list; setSession('paused');
      log('сцена: пять полосок — шапка растёт, лента остаётся под ней');
    }
    if (name === 'empty') log('сцена: пусто — шапка как сегодня; циферблат в заголовке тусклый, клик по нему = новая заготовка');
    render();
  }

  // ── render + tick ────────────────────────────────────────────────
  function render() {
    renderAnchor();
    renderDock();
    renderWidget();
    renderTray();
    syncToolbar();
  }
  function tick() {
    const now = performance.now();
    simNow += (now - lastReal) * speed;
    lastReal = now;
    for (const el of $$('[data-t]')) {
      const t = byId(+el.dataset.t);
      if (t) el.textContent = fmtRun(elapsed(t));
    }
    for (const el of $$('[data-nav]')) {
      const t = byId(+el.dataset.nav);
      if (t) el.textContent = fmtRun(elapsed(t));
    }
    for (const el of $$('[data-dial]')) {
      const t = byId(+el.dataset.dial);
      if (t) el.innerHTML = dialSvg(t.state, elapsed(t), liveCount() > 1);
    }
    $('#tbClock').innerHTML = `${fmtClock(simNow)}<br>26.10.2026`;
  }
  setInterval(tick, 200);

  // ── states at a glance ───────────────────────────────────────────
  const appBg = getComputedStyle(appEl).backgroundColor;
  function buildStrips() {
    const host = $('#strips');
    const F = (o) => ({ id: 0, task: null, title: '', desc: '', state: 'run', acc: 0, ...o });
    const hotBlk = $('.blk.hot', lpTable);
    const hdrCell = (t, multi, cap) => {
      const h = hdr.cloneNode(true);
      const a = $('.tm-nav', h);
      const p = navParts(t, multi);
      a.className = p.cls;
      a.innerHTML = p.html;
      return `<div class="st-cell"><div class="st-hdr">${h.outerHTML}</div><div class="st-cap">${cap}</div></div>`;
    };
    // Header + dock clone over the start of the feed: the strip is recessed
    // into the header's glass, the feed card below is raised.
    const dayCell = (list, cap, o = {}) => {
      const h = dayHead.cloneNode(true);
      $('.tm-dock', h).remove();
      h.classList.toggle('tm-docked', list.length > 0);
      const d = document.createElement('div');
      d.setAttribute(NG_DAY, '');
      d.className = `tm-dock s-${o.surface || S.surface}`;
      d.innerHTML = list.map((t) => (o.form && t.id === o.form.id ? formHTML(t, o.form) : stripHTML(t, false))).join('');
      if (o.hover) $(`[data-sid="${o.hover}"]`, d)?.classList.add('hov');
      h.append(d);
      const feed = hotBlk.cloneNode(true);
      return `<div class="st-cell"><div class="st-day" style="background:${appBg}"><div class="st-scroll">${h.outerHTML}<div class="st-feed">${feed.outerHTML}</div></div></div><div class="st-cap">${cap}</div></div>`;
    };
    const wCell = (list, w, rowH, cap) => `<div class="st-cell"><div class="tm-widget static${list.some((t) => t.state === 'run') ? ' run' : ''}" style="width:${w}px;height:${stackH(list.length, rowH)}px">${list.map((t) => widgetRow(t, false)).join('')}</div><div class="st-cap">${cap}</div></div>`;
    const tCell = (eyes, clock, cap) => `<div class="st-cell"><span class="st-tray">${traySvg(eyes, clock, 52)}</span><span class="st-tray sm">${traySvg(eyes, clock, 16)}</span><div class="st-cap" style="max-width:150px">${cap}</div></div>`;
    const p1 = F({ id: 901, state: 'pause', desc: 'разбор 500-х на checkout', fixedMs: mm(47, 15) });
    const r1 = F({ id: 902, task: 'ATL-7014', title: 'Save pipeline drops middle names on import', desc: 'созвон с QA', fixedMs: mm(12, 8) });
    const q1 = F({ id: 903, state: 'ready', task: 'ATL-7020', title: 'Organization tree: drag-and-drop reorder' });
    const y1 = F({ id: 904, state: 'yield', desc: 'разбор 500-х на checkout', fixedMs: mm(23, 40) });
    const n1 = F({ id: 905, state: 'ready' });
    const lone = F({ id: 906, desc: 'разбор 500-х на checkout', fixedMs: mm(47, 15) });
    host.innerHTML = `
      <div class="st-sub">Шапка дня + полоски (поверхность «${{ tray: 'лоток', wells: 'лунки', glass: 'на стекле' }[S.surface]}» — переключается в тулбаре)</div>
      <div class="st-row">
        ${dayCell([lone], 'один идёт — строка вторым этажом шапки; минуты стоят под total, по той же правой кромке')}
        ${dayCell([p1, r1, q1], 'пауза · идёт · заготовка — в порядке добавления; заготовка без минут')}
        ${dayCell([p1, r1, q1], 'наведение на строку — Log… 📌 ✕ проявляются слева от минут; фона у строки нет', { hover: 902 })}
        ${dayCell([y1], 'сессия перехватила — красный ⏸ и слово session; вернуть — ▶ кликом')}
      </div>
      <div class="st-row">
        ${dayCell([p1, r1], 'Log… — строка стала формой Log: ← · вид работы · описание · Log, минуты в своём слоте (колесо ±15)', { form: { id: 902, act: 'Meeting', desc: 'созвон с QA', min: 12 } })}
        ${dayCell([p1], 'без тикета Log погашен, task? в пунктире просит тикет — клик открывает облако под шапкой', { form: { id: 901, act: 'Development', desc: 'разбор 500-х на checkout', min: 47 } })}
        ${dayCell([n1], 'клик по циферблату — пустая заготовка, курсор в описании; ушёл, ничего не вписав — строка исчезла')}
      </div>
      <div class="st-sub">Поверхность полосок — одно и то же содержимое</div>
      <div class="st-row">
        ${dayCell([p1, r1, q1], 'лоток — один утопленный жёлоб на все полоски, между ними волосок', { surface: 'tray' })}
        ${dayCell([p1, r1, q1], 'лунки — у каждой полоски своя утопленная капсула', { surface: 'wells' })}
        ${dayCell([p1, r1, q1], 'на стекле — без жёлоба, только волосок под строкой даты', { surface: 'glass' })}
      </div>
      <div class="st-sub">Заголовок окна — циферблат (без изменений с v12/T2, клик = новая заготовка на Day)</div>
      <div class="st-row">
        ${hdrCell(null, false, 'покой — тусклый')}
        ${hdrCell(F({ fixedMs: mm(12, 8) }), false, 'идёт — лайм, сектор = минуты часа')}
        ${hdrCell(F({ state: 'pause', fixedMs: mm(47, 15) }), false, 'пауза / перехват — красные полоски')}
        ${hdrCell(F({ fixedMs: mm(12, 8) }), true, 'несколько — второй циферблат сзади')}
      </div>
      <div class="st-sub">Виджет и трей — как в v13</div>
      <div class="st-row">
        ${wCell([F({ task: 'ATL-7014', desc: 'созвон с QA', fixedMs: mm(12, 8) }), F({ state: 'pause', desc: 'разбор 500-х на checkout', fixedMs: mm(47, 15) })], 250, 46, 'запинено два — одно окно, стопка')}
        ${wCell([F({ state: 'yield', desc: 'разбор 500-х', fixedMs: mm(23, 40) })], 250, 46, 'перехватила сессия')}
        ${tCell(false, 'run', 'идёт таймер')}
        ${tCell(true, 'pause', 'сессия перехватила, таймер ждёт')}
      </div>`;
  }

  syncToolbar();
  render();
  buildStrips();
  tick();
  log('макет готов — кликни циферблат в заголовке окна или выбери сцену');
})();
