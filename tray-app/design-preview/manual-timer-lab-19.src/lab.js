(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ngOf = (el) => [...el.attributes].find((a) => a.name.startsWith('_ngcontent')).name;

  // ── simulated clock ──────────────────────────────────────────────
  const DAY0 = new Date(2026, 9, 26, 14, 5, 0).getTime();
  let simNow = DAY0;
  let speed = 1;
  let lastReal = performance.now();
  const fmtRun = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
  };
  const fmtHm = (min) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${pad(min % 60)}m`);
  const fmtSec = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  // 1h 15m · 1h · 90 · 45m — like the app's duration field
  function parseMin(v) {
    const m = String(v).trim().toLowerCase().match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?$/);
    if (!m || (!m[1] && !m[2])) return null;
    return (+(m[1] || 0)) * 60 + (+(m[2] || 0));
  }

  // ── glyphs ───────────────────────────────────────────────────────
  const PLAY = '<svg class="g-play" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.7l5.2 3.3L3 8.3z"/></svg>';
  const PZ = '<svg class="g-pz" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.6" y="1.2" width="2.5" height="7.6" rx=".8"/><rect x="5.9" y="1.2" width="2.5" height="7.6" rx=".8"/></svg>';
  const X = '<svg class="g-x" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9"/></svg>';
  // ⏱ — "the timer took part": the mark after a record's description or label
  const CLOCK = '<svg class="g-clock" viewBox="0 0 10 10" aria-hidden="true"><path d="M4 .8h2M5 .8v1.4"/><circle cx="5" cy="5.9" r="3.4"/><path d="M5 5.9V4.2"/></svg>';
  const DIAL_S = '<svg class="g-dial" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 1.2h3.2M8 1.2v2.2"/><circle cx="8" cy="9.2" r="5.6"/><path d="M8 9.2V6.2"/></svg>';
  const MI = {
    play: '<svg viewBox="0 0 12 12"><path d="M3.5 2.2l6 3.8-6 3.8z"/></svg>',
    pause: '<svg viewBox="0 0 12 12"><path d="M4 2.5v7M8 2.5v7"/></svg>',
    edit: '<svg viewBox="0 0 12 12"><path d="M2 10l.6-2.4L8 2.2l1.8 1.8-5.4 5.4z"/></svg>',
    del: '<svg viewBox="0 0 12 12"><path d="M2.5 3.5h7M4.8 3.5V2.3h2.4v1.2M3.5 3.5l.5 6.2h4l.5-6.2"/></svg>',
  };
  function dialSvg(state, sec) {
    const fr = ((sec / 60) % 60) / 60, a = fr * 2 * Math.PI, cx = 8, cy = 9.2, rs = 4.1, rh = 3.4;
    let sector = '';
    if (fr > 0.004) {
      sector = fr > 0.996 ? `<circle class="sec" cx="${cx}" cy="${cy}" r="${rs}"/>`
        : `<path class="sec" d="M${cx} ${cy} L${cx} ${(cy - rs).toFixed(2)} A${rs} ${rs} 0 ${fr > 0.5 ? 1 : 0} 1 ${(cx + rs * Math.sin(a)).toFixed(2)} ${(cy - rs * Math.cos(a)).toFixed(2)} Z"/>`;
    }
    const inner = state === 'run'
      ? `<path class="hand" d="M${cx} ${cy} L${(cx + rh * Math.sin(a)).toFixed(2)} ${(cy - rh * Math.cos(a)).toFixed(2)}"/>`
      : '<rect class="pz" x="5.85" y="7.1" width="1.55" height="4.2" rx=".55"/><rect class="pz" x="8.6" y="7.1" width="1.55" height="4.2" rx=".55"/>';
    return `<svg class="tm-dial" viewBox="0 0 16 16" aria-hidden="true"><path class="crown" d="M6.4 1.2h3.2M8 1.2v2.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5.6"/>${sector}${inner}</svg>`;
  }

  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];
  const ACT_NAME = { CodeReview: 'Code Review', DesignAnalysis: 'Design Analysis' };

  // ── state ────────────────────────────────────────────────────────
  // anon — a timer without a ticket: { id, desc, acc (s), runSince, state: run | pause | yield }
  // rec — a record in a ticket card: { id, el, blk, task, kind: ent | man | tadd, act, desc,
  //       sec, sec0, runSince (a timer feeds it right now), yielded, timered }
  const S = { anchor: 'L', session: 'tracking', seq: 0, anon: [], recs: [], lastAnon: null };
  const anonSec = (t) => t.acc + (t.state === 'run' ? (simNow - t.runSince) / 1000 : 0);
  const recSec = (r) => r.sec + (r.runSince != null ? (simNow - r.runSince) / 1000 : 0);
  let nextKey = 7203;

  // ── DOM handles ──────────────────────────────────────────────────
  const wd = $('#wd');
  const appEl = $('.app', wd);
  const hdr = $('.header', appEl);
  const NG_APP = ngOf(hdr);
  const dayView = $('app-day-view', appEl);
  const content = $('.content', dayView);
  const dayHead = $('.day-head', dayView);
  const dayTotal = $('.day-total', dayHead);
  const logBtn = $('.g-btn', dayHead);
  const lpTable = $('.lp-table', dayView);
  const cloud = $('app-log-cloud', dayView);
  const backdrop = $('.cloud-backdrop', dayView);
  appEl.append(backdrop, cloud);
  const feedOrig = lpTable.cloneNode(true);
  const tplBlk = $('.blk.one[data-task="APP-1024"]', feedOrig).cloneNode(true);
  const tplEnt = $('.wl.ent[data-eid="m2"]', feedOrig).cloneNode(true);
  const tplMan = $('.wl.manline', feedOrig).cloneNode(true);
  const MG = $('.mg', tplMan).outerHTML;
  const NG_LP = ngOf(tplEnt);
  const totalBase = parseMin(dayTotal.textContent);
  let sesRow = null, sesBtn = null;

  const wc = document.createElement('div');
  wc.innerHTML = `<div ${NG_APP} class="win-controls"><button ${NG_APP} class="wc-btn" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1 5.5h8"/></svg></button><button ${NG_APP} class="wc-btn wc-close" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`;
  hdr.append(wc.firstElementChild);

  // ── views (Day / Sheets / Settings) — L is seen from every tab ───
  const views = { day: dayView };
  for (const [k, id] of [['set', 'tpl-set'], ['sheet', 'tpl-sheet']]) {
    const el = $(`#${id}`).content.firstElementChild.cloneNode(true);
    el.style.display = 'none';
    appEl.insertBefore(el, dayView.nextSibling);
    views[k] = el;
  }
  const viewBtns = { Day: 'day', Timesheets: 'sheet', Settings: 'set' };
  function showView(v) {
    for (const [k, el] of Object.entries(views)) el.style.display = k === v ? '' : 'none';
    for (const x of $$('.view-btn', hdr)) x.classList.toggle('active', viewBtns[x.getAttribute('title')] === v);
    renderAnchor();
  }
  for (const b of $$('.view-btn', hdr)) b.addEventListener('click', () => { closeMenu(); closeCloud(); showView(viewBtns[b.getAttribute('title')]); });
  const onDay = () => views.day.style.display !== 'none';

  // ── event log ────────────────────────────────────────────────────
  const evlog = $('#evlog');
  function log(msg) {
    const d = document.createElement('div');
    d.className = 'ev';
    d.innerHTML = `<b>${fmtSec(simNow)}</b>${msg}`;
    evlog.prepend(d);
    while (evlog.children.length > 14) evlog.lastChild.remove();
  }

  // ── sessions: one source counts at a time (yield) ────────────────
  function setSession(state) {
    S.session = state;
    if (!sesRow) return;
    const tr = state === 'tracking';
    sesRow.classList.toggle('lead', tr);
    sesRow.classList.toggle('paused', !tr);
    sesBtn.classList.toggle('lead', tr);
    sesBtn.classList.toggle('willp', !tr);
  }
  const anyRunning = () => S.anon.some((t) => t.state === 'run') || S.recs.some((r) => r.runSince != null);
  function yieldSessions() {
    if (S.session !== 'tracking') return '';
    setSession('paused');
    return ' · сессия web-frontend на паузе';
  }
  function sessionsBack() {
    if (anyRunning() || S.session === 'tracking') return '';
    setSession('tracking');
    return ' · сессии вернулись к своему циклу';
  }

  // ── the feed: records a timer can feed ───────────────────────────
  function initFeed() {
    sesRow = $('.blk.hot app-session-row', lpTable);
    sesBtn = sesRow && $('.tb', sesRow);
    S.recs = [];
    for (const blk of $$('.blk', lpTable)) {
      blk.dataset.base = String(parseMin($('.sum', blk).textContent) || 0);
      const body = $('.blk-body', blk);
      const rowCount = $$(':scope > .wl, :scope > app-session-row', body).length;
      for (const el of $$(':scope > .wl.ent, :scope > .wl.manline', body)) {
        const dur = $('.c-dur', el).textContent.trim();
        const min = dur ? parseMin(dur) : (rowCount === 1 ? +blk.dataset.base : 0);
        const man = el.classList.contains('manline');
        const r = { id: ++S.seq, el, blk, task: blk.dataset.task, kind: man ? 'man' : 'ent', act: $('.c-type', el).textContent.trim(),
          desc: man ? '' : $('.c-ds', el).textContent.trim(), sec: min * 60, sec0: min * 60, runSince: null, yielded: false, timered: false };
        el.dataset.rid = r.id;
        S.recs.push(r);
      }
    }
  }
  const recById = (id) => S.recs.find((r) => r.id === id);
  // timer added: pause / resume sits inside the label, where manual added has ⊕
  function labelGlyph(r) {
    const N = NG_LP;
    const ring = `<circle ${N} cx="4.5" cy="4.5" r="3.9" fill="none" stroke="currentColor" stroke-width=".9"/>`;
    const pz = `<path ${N} d="M3.5 3v3M5.5 3v3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>`;
    const pl = `<path ${N} d="M3.7 2.9l2.5 1.6-2.5 1.6z" fill="currentColor"/>`;
    const svg = (inner) => `<svg ${N} width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" class="mg">${ring}${inner}</svg>`;
    if (r.runSince != null) return `<button type="button" class="tmk in run" data-pz="${r.id}">${svg(pz)}</button>`;
    if (r.yielded) return `<button type="button" class="tmk in yield" data-go="${r.id}">${svg(pz)}</button>`;
    return `<button type="button" class="tmk in" data-go="${r.id}">${svg(pl)}</button>`;
  }
  function markHTML(r) {
    if (r.runSince != null) return `<button type="button" class="tmk run" data-pz="${r.id}">${PZ}</button>`;
    if (r.yielded) return `<button type="button" class="tmk yield" data-go="${r.id}">${PZ}</button>`;
    if (r.timered) return `<span class="tmk">${CLOCK}</span>`;
    return '';
  }
  function paintRec(r) {
    const ds = $('.c-ds', r.el);
    if (r.kind === 'tadd') ds.innerHTML = `<span ${NG_LP}>timer added</span>${labelGlyph(r)}`;
    else if (r.kind === 'man') ds.innerHTML = `<span ${NG_LP}>manual added</span>${MG}`;
    else ds.innerHTML = `${esc(r.desc)}${markHTML(r)}`;
    r.el.classList.toggle('tm-live', r.runSince != null);
    ds.classList.toggle('tadd', r.kind === 'tadd');
    paintDur(r);
  }
  function paintDur(r) {
    const s = recSec(r);
    $('.c-dur', r.el).textContent = r.blk.classList.contains('one') ? '' : (r.runSince != null ? fmtRun(s) : fmtHm(Math.round(s / 60)));
  }
  function paintBlk(blk) {
    const recs = S.recs.filter((r) => r.blk === blk);
    const sec = (+blk.dataset.base) * 60 + recs.reduce((a, r) => a + recSec(r) - r.sec0, 0);
    const live = recs.some((r) => r.runSince != null) && blk.classList.contains('one');
    const sum = $('.sum', blk);
    sum.textContent = live ? fmtRun(sec) : fmtHm(Math.floor(sec / 60));
    sum.classList.toggle('tm-live', live);
  }
  function paintTotal() {
    const d = S.recs.reduce((a, r) => a + recSec(r) - r.sec0, 0);
    dayTotal.textContent = fmtHm(totalBase + Math.floor(d / 60));
  }

  function blockFor(task, title) {
    let blk = $(`.blk[data-task="${task}"]`, lpTable);
    if (blk) return blk;
    blk = tplBlk.cloneNode(true);
    blk.dataset.task = task;
    blk.dataset.base = '0';
    $('.tkt', blk).textContent = task;
    const nm = $('.c-nm', blk);
    nm.textContent = title || '— name not cached';
    nm.classList.toggle('none', !title);
    $('.blk-body', blk).innerHTML = '';
    blk.classList.add('one');
    blk.style.order = '2';
    lpTable.insertBefore(blk, $$('.blk', lpTable).find((b) => !b.classList.contains('hot')) || null);
    return blk;
  }
  function newRec(task, title, kind, act, desc, sec) {
    const blk = blockFor(task, title);
    const body = $('.blk-body', blk);
    if ($$(':scope > .wl, :scope > app-session-row', body).length && blk.classList.contains('one')) {
      // a second row: every row gets its own time slot back
      blk.classList.remove('one');
      for (const d of $$('app-session-row .dur', blk)) if (!d.textContent.trim()) d.textContent = fmtHm(+blk.dataset.base);
    }
    const el = (kind === 'ent' ? tplEnt : tplMan).cloneNode(true);
    el.removeAttribute('data-eid');
    $('.c-type', el).textContent = act;
    const man = kind === 'tadd' && S.recs.find((x) => x.blk === blk && x.kind === 'man');
    if (man) man.el.after(el); else body.append(el);
    const r = { id: ++S.seq, el, blk, task, kind, act, desc, sec, sec0: 0, runSince: null, yielded: false, timered: kind === 'tadd' };
    el.dataset.rid = r.id;
    S.recs.push(r);
    for (const x of S.recs) if (x.blk === blk) paintRec(x);
    paintBlk(blk);
    return r;
  }
  // bare time folds into the ticket's one record of its kind (manual added / timer added)
  function addBare(task, title, kind, sec) {
    const blk = $(`.blk[data-task="${task}"]`, lpTable);
    const r = blk && S.recs.find((x) => x.blk === blk && x.kind === kind);
    if (r) { r.sec += sec; return r; }
    return newRec(task, title, kind, 'Development', '', sec);
  }

  // ── running: one source at a time ────────────────────────────────
  function foldRec(r, yielded = false) {
    r.sec = recSec(r);
    r.runSince = null;
    r.yielded = yielded;
  }
  function pauseAnonT(t, state = 'pause') {
    t.acc = anonSec(t);
    t.runSince = null;
    t.state = state;
  }
  function haltOthers(keep) {
    let who = '';
    for (const t of S.anon) if (t !== keep && t.state === 'run') { pauseAnonT(t); who = ` · «${esc(t.desc || 'без описания')}» на паузе`; }
    for (const r of S.recs) if (r !== keep && r.runSince != null) { foldRec(r); who = ` · таймер записи ${r.task} на паузе`; }
    return who;
  }
  function runRec(r) {
    if (r.kind === 'man') {
      const t = addBare(r.task, '', 'tadd', 0);
      log(`manual added — только ручное время; таймер пишет в соседнюю бирку timer added`);
      r = t;
    }
    const who = haltOthers(r);
    r.runSince = simNow;
    r.yielded = false;
    r.timered = true;
    log(`▶ таймер питает запись ${r.task} · ${r.kind === 'ent' ? `«${esc(r.desc)}»` : r.kind === 'man' ? 'manual added' : 'timer added'}${who}${yieldSessions()}`);
    renderAll();
  }
  function pauseRec(r) {
    foldRec(r);
    log(`⏸ таймер отключён от записи ${r.task}: ${fmtHm(Math.round(r.sec / 60))} остаются в ней${sessionsBack()}`);
    renderAll();
  }
  function runAnon(t) {
    const who = haltOthers(t);
    t.state = 'run';
    t.runSince = simNow;
    S.lastAnon = t;
    log(`▶ таймер без тикета «${esc(t.desc || 'без описания')}» идёт${who}${yieldSessions()}`);
    renderAll();
  }
  function pauseAnon(t) {
    pauseAnonT(t);
    S.lastAnon = t;
    log(`⏸ таймер без тикета «${esc(t.desc || 'без описания')}» на паузе · ${fmtRun(t.acc)}${sessionsBack()}`);
    renderAll();
  }
  function gitActivity() {
    const wasTracking = S.session === 'tracking';
    setSession('tracking');
    let hit = '';
    for (const t of S.anon) if (t.state === 'run') { pauseAnonT(t, 'yield'); hit = `таймер «${esc(t.desc || 'без описания')}»`; }
    for (const r of S.recs) if (r.runSince != null) { foldRec(r, true); hit = `таймер записи ${r.task}`; }
    log(hit ? `git-правка в web-frontend → сессия выиграла, ${hit} встал (красный ⏸) · вернуть — кликом`
      : `git-правка в web-frontend → сессия ${wasTracking ? 'и так считает' : 'проснулась'}`);
    renderAll();
  }

  // ── anchor of the ticketless timers: K capsule / L titlebar label ─
  const anchorTimer = () => S.anon.find((t) => t.state === 'run') || (S.anon.includes(S.lastAnon) ? S.lastAnon : S.anon[S.anon.length - 1]) || null;
  let anchorEl = null;
  function renderAnchor() {
    $('.tmc-row', dayHead)?.remove();
    $('.tm-ndiv', hdr)?.remove();
    $('.tm-nav', hdr)?.remove();
    anchorEl = null;
    const t = anchorTimer();
    if (!t) return;
    const g = t.state === 'run' ? PLAY : PZ;
    if (S.anchor === 'K') {
      logBtn.insertAdjacentHTML('beforebegin', `<span class="tmc-row"><span class="tmc candy ${t.state === 'run' ? 'run' : 'paused'}">${g}<b data-anon-t="${t.id}">${fmtRun(anonSec(t))}</b></span></span>`);
      anchorEl = $('.tmc', dayHead);
    } else {
      $('.view-switcher', hdr).insertAdjacentHTML('afterend', `<span class="tm-ndiv"></span><button type="button" class="tm-nav ${t.state === 'run' ? 'run' : 'pause'}"><span class="tm-dw" data-anon-dial="${t.id}">${dialSvg(t.state, anonSec(t))}</span><span class="tm-min" data-anon-t="${t.id}">${fmtRun(anonSec(t))}</span></button>`);
      anchorEl = $('.tm-nav', hdr);
    }
    anchorEl.addEventListener('click', (e) => { e.stopPropagation(); if (menu && menu.kind === 'anon') closeMenu(); else openAnonMenu(); });
  }

  // ── menus: the anonymous timers' one, a record's one ──────────────
  let menu = null; // { kind: 'anon' | 'rec', el, rec? }
  const relRect = (el) => {
    const a = el.getBoundingClientRect(), b = appEl.getBoundingClientRect();
    return { left: a.left - b.left, top: a.top - b.top, right: a.right - b.left, bottom: a.bottom - b.top };
  };
  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    for (const x of $$('.c-type.armed', lpTable)) x.classList.remove('armed');
    menu = null;
  }
  function anonMenuHTML() {
    return S.anon.map((t) => `<div class="ctx-item tmm ${t.state}" data-tid="${t.id}"><button type="button" class="tmm-g" data-a="toggle">${t.state === 'run' ? PLAY : PZ}</button>`
      + `<b class="tmm-time" data-anon-t="${t.id}">${fmtRun(anonSec(t))}</b><span class="tmm-desc${t.desc ? '' : ' ph'}">${esc(t.desc || 'no description')}</span>`
      + `<button type="button" class="tmm-x" data-a="x">${X}</button></div>`).join('');
  }
  function openAnonMenu() {
    closeMenu();
    if (!anchorEl || !S.anon.length) return;
    const el = document.createElement('div');
    el.className = `ctx-menu anchored${S.anchor === 'K' ? ' right' : ''} tmm-menu`;
    el.innerHTML = anonMenuHTML();
    appEl.append(el);
    menu = { kind: 'anon', el };
    const a = relRect(anchorEl);
    el.style.top = `${a.bottom + 6}px`;
    el.style.left = S.anchor === 'K' ? `${Math.max(8, a.right - el.offsetWidth + 4)}px` : `${Math.max(8, a.left - 10)}px`;
    el.addEventListener('click', onAnonMenu);
  }
  function onAnonMenu(e) {
    const row = e.target.closest('[data-tid]');
    if (!row) return;
    const t = S.anon.find((x) => x.id === +row.dataset.tid);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'toggle') { if (t.state === 'run') pauseAnon(t); else runAnon(t); return; }
    if (a === 'x') {
      S.anon = S.anon.filter((x) => x !== t);
      log(`✕ таймер без тикета «${esc(t.desc || 'без описания')}» выброшен вместе с ${fmtRun(anonSec(t))}${sessionsBack()}`);
      renderAll();
      if (!S.anon.length) closeMenu();
      return;
    }
    closeMenu();
    if (!onDay()) showView('day');
    openCloud('pick', t);
  }
  function openRecMenu(r, typeEl) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'ctx-menu anchored';
    const t = r.runSince != null
      ? `<div class="ctx-item" data-a="pause"><span class="ci-ic">${MI.pause}</span>Pause timer</div>`
      : `<div class="ctx-item tm-go" data-a="run"><span class="ci-ic">${MI.play}</span>${r.kind === 'man' ? 'Start timer → timer added' : 'Start timer'}</div>`;
    el.innerHTML = `${t}<div class="ctx-item" data-a="edit"><span class="ci-ic">${MI.edit}</span>Edit</div><div class="ctx-sep"></div><div class="ctx-item" data-a="del"><span class="ci-ic">${MI.del}</span>Delete</div>`;
    appEl.append(el);
    menu = { kind: 'rec', el, rec: r };
    typeEl.classList.add('armed');
    const a = relRect(typeEl);
    el.style.top = `${a.bottom + 4}px`;
    el.style.left = `${Math.max(8, a.left - 8)}px`;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (!act) return;
      closeMenu();
      if (act === 'run') runRec(r);
      else if (act === 'pause') pauseRec(r);
      else log(`${act === 'edit' ? 'Edit' : 'Delete'} — как сегодня (в макете не трогаем)`);
    });
  }
  lpTable.addEventListener('click', (e) => {
    const mk = e.target.closest('.tmk[data-pz], .tmk[data-go]');
    if (mk) {
      const r = recById(+(mk.dataset.pz || mk.dataset.go));
      if (mk.dataset.pz) pauseRec(r); else runRec(r);
      return;
    }
    const type = e.target.closest('.wl .c-type');
    const row = type && type.closest('.wl[data-rid]');
    if (!row) return;
    const r = recById(+row.dataset.rid);
    if (menu && menu.rec === r) closeMenu(); else openRecMenu(r, type);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu) return;
    if (menu.el.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
    if (menu.kind === 'rec' && e.target.closest('.wl .c-type')) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu) closeMenu();
    else if (cloudState?.form) exitForm();
    else if (cloudState) closeCloud();
  });

  // ── the one cloud: + Log (log) · ticket pick for a timer (pick) ───
  const cloudInput = $('.cloud-filter input', cloud);
  const chips = $('.cloud-chips', cloud);
  const batchBtn = $('.f-batch', cloud);
  const NGC = ngOf($('.fav', chips));
  const origPlaceholder = cloudInput.placeholder;
  const mkChip = (task, name, cls) => {
    const s = document.createElement('span');
    s.setAttribute(NGC, '');
    s.className = `fav ${cls}`;
    s.innerHTML = `<span ${NGC} class="f-task">${esc(task)}</span><span ${NGC} class="f-name">${esc(name)}</span>`;
    return s;
  };
  const startChip = mkChip('▶', 'Start timer', 'tm-start');
  const createChip = mkChip('＋', 'Create in Jira…', 'tm-create');
  const foot = document.createElement('div');
  foot.className = 'tmf';
  foot.append(startChip, createChip);
  $('.cloud-body', cloud).after(foot);
  const noneLbl = document.createElement('span');
  noneLbl.setAttribute(NGC, '');
  noneLbl.className = 'row-label jira tm-none';
  noneLbl.textContent = 'jira · nothing found';
  chips.append(noneLbl);
  let createdLbl = null;
  let cloudState = null; // { mode: 'log' | 'pick', t?, form? }

  function openCloud(mode, t = null) {
    closeMenu();
    exitForm(true);
    cloudState = { mode, t };
    cloud.classList.add('open');
    cloud.classList.toggle('accept-mode', mode === 'pick');
    backdrop.classList.add('open');
    batchBtn.style.display = mode === 'pick' ? 'none' : '';
    startChip.style.display = mode === 'pick' ? 'none' : '';
    cloud.style.top = `${Math.round(relRect(dayHead).bottom - 4)}px`;
    cloudInput.value = '';
    cloudInput.placeholder = mode === 'pick' ? `ticket for «${t.desc || 'timer'}» · no match → search Jira` : origPlaceholder;
    filterChips();
    setTimeout(() => cloudInput.focus(), 40);
  }
  function closeCloud() {
    exitForm(true);
    cloud.classList.remove('open', 'accept-mode');
    backdrop.classList.remove('open');
    cloudState = null;
  }
  backdrop.addEventListener('click', closeCloud);
  logBtn.addEventListener('click', () => openCloud('log'));
  cloudInput.addEventListener('input', filterChips);
  function filterChips() {
    const raw = cloudInput.value.trim();
    const q = raw.toLowerCase();
    let lastLabel = null, any = false, anyAll = false;
    const flush = () => { if (lastLabel) lastLabel.classList.toggle('tm-hide', !any); };
    for (const el of [...chips.children]) {
      if (el === noneLbl) continue;
      if (el.classList.contains('row-label')) { flush(); lastLabel = el; any = false; continue; }
      const hit = !q || el.textContent.toLowerCase().includes(q);
      el.classList.toggle('tm-hide', !hit);
      if (hit) { any = true; anyAll = true; }
    }
    flush();
    noneLbl.classList.toggle('tm-hide', anyAll);
    // the timer's chip follows the search: typed text becomes the description
    $('.f-name', startChip).textContent = raw ? `Start timer «${raw}»` : 'Start timer';
    $('.f-name', createChip).textContent = raw ? `Create «${raw}» in Jira` : 'Create in Jira…';
  }
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.fav');
    if (!chip || !cloudState) return;
    const task = $('.f-task', chip).textContent.trim();
    const name = $('.f-name', chip).textContent.trim();
    const fav = !chip.classList.contains('jira');
    const act = fav ? (ACT_NAME[(chip.getAttribute('title') || '').split(' ·')[0]] || (chip.getAttribute('title') || 'Other').split(' ·')[0]) : 'Development';
    if (cloudState.mode === 'pick') { bind(cloudState.t, task, fav ? '' : name, act, fav ? name : ''); return; }
    if (fav) {
      const min = parseMin($('.f-min', chip)?.textContent || '') || 15;
      closeCloud();
      const r = newRec(task, '', 'ent', act, name, min * 60);
      land(r.el);
      renderAll();
      log(`★ ${task} · ${esc(name)} · ${fmtHm(min)} — избранное, как сегодня`);
      return;
    }
    showForm(task, name);
  });
  startChip.addEventListener('click', () => {
    if (!cloudState || cloudState.mode !== 'log') return;
    const desc = cloudInput.value.trim();
    closeCloud();
    const t = { id: ++S.seq, desc, acc: 0, runSince: simNow, state: 'run' };
    S.anon.push(t);
    runAnon(t);
  });
  createChip.addEventListener('click', () => {
    if (!cloudState) return;
    const summary = cloudInput.value.trim() || (cloudState.t && cloudState.t.desc) || 'New ticket';
    const key = `ATL-${nextKey++}`;
    for (const c of $$('.tm-new', chips)) c.classList.remove('tm-new');
    if (!createdLbl) { createdLbl = mkChip('', '', ''); createdLbl.className = 'row-label jira'; createdLbl.innerHTML = 'jira · created just now'; chips.prepend(createdLbl); }
    createdLbl.after(mkChip(key, summary, 'jira mine tm-new'));
    cloudInput.value = '';
    filterChips();
    log(`Create in Jira → форма в браузере; в макете сразу создан ${key} «${esc(summary)}» — первым чипом`);
  });

  // the single-entry form: one Log; timer is an option of the record
  function showForm(task, name) {
    cloudState.form = { task, name };
    cloud.classList.add('form-mode');
    const N = NGC;
    const opts = ACTS.map((a) => `<option>${a}</option>`).join('');
    cloud.insertAdjacentHTML('beforeend', `<div ${N} class="cloud-form"><div ${N} class="cf-top"><span ${N} class="cf-key">${esc(task)}</span><span ${N} class="cf-name">${esc(name)}</span></div>`
      + `<div ${N} class="cf-ctl"><button ${N} type="button" class="cf-back">←</button><select ${N} class="cf-act">${opts}</select>`
      + `<input ${N} class="cf-min" placeholder="45m"><button type="button" class="cf-tm">${DIAL_S}timer</button>`
      + `<input ${N} class="cf-desc" placeholder="description"><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
    const f = $('.cloud-form', cloud);
    $('.cf-back', f).addEventListener('click', () => exitForm());
    $('.cf-tm', f).addEventListener('click', (e) => { e.currentTarget.classList.toggle('on'); $('.cf-min', f).classList.remove('need'); });
    $('.cf-submit', f).addEventListener('click', submitForm);
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });
    f.addEventListener('wheel', (e) => {
      const inp = e.target.closest('.cf-min');
      if (!inp) return;
      e.preventDefault();
      inp.value = fmtHm(Math.max(0, (parseMin(inp.value) || 0) + (e.deltaY < 0 ? 15 : -15)));
    }, { passive: false });
    setTimeout(() => $('.cf-min', f).focus(), 40);
  }
  function exitForm(quiet = false) {
    $('.cloud-form', cloud)?.remove();
    cloud.classList.remove('form-mode');
    if (cloudState) cloudState.form = null;
    if (!quiet) setTimeout(() => cloudInput.focus(), 40);
  }
  function submitForm() {
    const f = $('.cloud-form', cloud);
    const { task, name } = cloudState.form;
    const act = $('.cf-act', f).value;
    const min = parseMin($('.cf-min', f).value);
    const timer = $('.cf-tm', f).classList.contains('on');
    const desc = $('.cf-desc', f).value.trim();
    if (!timer && !min) { $('.cf-min', f).classList.add('need'); return; }
    if (act !== 'Development' && !desc) { $('.cf-desc', f).classList.add('need'); return; }
    closeCloud();
    const sec = (min || 0) * 60;
    const r = !desc && act === 'Development' ? addBare(task, name, timer ? 'tadd' : 'man', sec) : newRec(task, name, 'ent', act, desc, sec);
    if (timer) runRec(r);
    else { renderAll(); log(`Log → ${task} · ${act} · ${fmtHm(min)}${desc ? ` · «${esc(desc)}»` : ' (manual added)'}`); }
    land(r.el);
  }

  // binding: the ticketless timer becomes the time of a record in the ticket's card
  function bind(t, task, title, act, favName) {
    const from = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const sec = anonSec(t);
    const state = t.state;
    S.anon = S.anon.filter((x) => x !== t);
    closeCloud();
    const desc = t.desc || favName;
    const r = desc ? newRec(task, title, 'ent', act, desc, sec) : addBare(task, title, 'tadd', sec);
    r.timered = true;
    if (state === 'run') r.runSince = simNow;
    if (state === 'yield') r.yielded = true;
    log(`таймер «${esc(t.desc || 'без описания')}» → ${task}: ${fmtRun(sec)} теперь в ${desc ? 'записи' : 'timer added'} и в total${state === 'run' ? ', счёт идёт дальше' : ''}`);
    renderAll();
    if (from && onDay()) fly(r.el, from); else land(r.el);
  }
  function land(el) {
    el.classList.remove('tm-landed');
    void el.offsetWidth;
    el.classList.add('tm-landed');
    setTimeout(() => el.classList.remove('tm-landed'), 2600);
  }
  function fly(el, from) {
    const at = el.getBoundingClientRect();
    el.animate([
      { transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.25,1)' });
    land(el);
  }

  // ── toolbar ──────────────────────────────────────────────────────
  function syncToolbar() {
    for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === speed);
    for (const b of $$('[data-anchor]')) b.classList.toggle('on', b.dataset.anchor === S.anchor);
  }
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.speed) { speed = +b.dataset.speed; syncToolbar(); }
    if (b.dataset.anchor) { closeMenu(); S.anchor = b.dataset.anchor; renderAll(); log(S.anchor === 'K' ? 'таймер без тикета виден капсулой рядом с + Log' : 'таймер без тикета виден лейблом в заголовке окна — с любой вкладки'); }
    if (b.dataset.act === 'git') gitActivity();
    if (b.dataset.preset) preset(b.dataset.preset);
  });
  function reset() {
    closeMenu(); closeCloud();
    S.anon = []; S.lastAnon = null; S.seq = 0;
    simNow = DAY0;
    nextKey = 7203;
    lpTable.replaceChildren(...feedOrig.cloneNode(true).childNodes);
    initFeed();
    for (const c of $$('.fav.jira.mine', chips)) if (/^ATL-72\d\d$/.test($('.f-task', c).textContent)) c.remove();
    if (createdLbl) { createdLbl.remove(); createdLbl = null; }
    setSession('tracking');
    showView('day');
    content.scrollTop = 0;
    evlog.innerHTML = '';
  }
  function preset(name) {
    reset();
    const mk = (desc, sec, state) => ({ id: ++S.seq, desc, acc: sec, runSince: state === 'run' ? simNow : null, state });
    if (name === 'one') {
      S.anon = [mk('разбор 500-х на checkout', 47 * 60 + 15, 'run')];
      setSession('paused');
      log('сцена: идёт таймер без тикета (рождён из «Start timer «разбор 500-х на checkout»»); сессия на паузе');
    }
    if (name === 'two') {
      S.anon = [mk('помог соседней команде с деплоем', 12 * 60 + 40, 'pause'), mk('разбор 500-х на checkout', 47 * 60 + 15, 'run')];
      setSession('paused');
      log('сцена: два таймера без тикета — клик по капсуле открывает меню');
    }
    if (name === 'bound') {
      const r = S.recs.find((x) => x.task === 'ATL-6712' && x.kind === 'ent' && x.desc.startsWith('PR #214'));
      r.timered = true;
      r.runSince = simNow;
      setSession('paused');
      log('сцена: таймер питает запись ATL-6712 «PR #214 review with team» — у неё ⏸ вместо ⏱, время с секундами, total растёт');
    }
    if (name === 'empty') log('сцена: пусто — + Log как сегодня; внизу облака ▶ Start timer');
    renderAll();
  }

  // ── render + tick ────────────────────────────────────────────────
  function renderAll() {
    renderAnchor();
    for (const r of S.recs) paintRec(r);
    for (const blk of $$('.blk', lpTable)) paintBlk(blk);
    paintTotal();
    if (menu && menu.kind === 'anon') { if (S.anon.length) menu.el.innerHTML = anonMenuHTML(); else closeMenu(); }
    syncToolbar();
  }
  function tick() {
    const nowReal = performance.now();
    simNow += (nowReal - lastReal) * speed;
    lastReal = nowReal;
    for (const el of $$('[data-anon-t]')) {
      const t = S.anon.find((x) => x.id === +el.dataset.anonT);
      if (t) el.textContent = fmtRun(anonSec(t));
    }
    for (const el of $$('[data-anon-dial]')) {
      const t = S.anon.find((x) => x.id === +el.dataset.anonDial);
      if (t) el.innerHTML = dialSvg(t.state, anonSec(t));
    }
    const live = S.recs.filter((r) => r.runSince != null);
    for (const r of live) { paintDur(r); paintBlk(r.blk); }
    if (live.length) paintTotal();
  }
  setInterval(tick, 200);

  initFeed();
  preset('one');
  log('макет готов — + Log, капсула, слово типа у любой записи');
})();
