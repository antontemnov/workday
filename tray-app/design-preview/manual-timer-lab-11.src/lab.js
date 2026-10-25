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
  const fmtMin = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
  const fmtClock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtSec = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

  // ── glyphs ───────────────────────────────────────────────────────
  const SW = (cls = '') => `<svg class="tm-sw ${cls}" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5.9" r="3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 5.9V3.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M3.8 0.9h2.4M5 0.9v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  const PZ = '<svg class="tm-pz" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.4" y="1" width="2.8" height="8" rx=".8"/><rect x="5.8" y="1" width="2.8" height="8" rx=".8"/></svg>';
  const PLUS = '<svg class="tm-plus" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.6V9.4M2.6 6H9.4"/></svg>';
  const CHEV = '<svg class="tm-chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.6 3l2.4 2.4L6.4 3"/></svg>';
  const IC = {
    pause: '<svg viewBox="0 0 12 12"><path d="M4 2.5v7M8 2.5v7"/></svg>',
    play: '<svg viewBox="0 0 12 12"><path d="M3.5 2.2l6 3.8-6 3.8z"/></svg>',
    stop: '<svg viewBox="0 0 12 12"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1"/></svg>',
    stopnew: '<svg viewBox="0 0 12 12"><rect x="1.4" y="3.4" width="5.2" height="5.2" rx=".8"/><path d="M9.2 3.6v4.8M6.8 6h4.8"/></svg>',
    plus: '<svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg>',
    x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9"/></svg>',
    pin: '<svg viewBox="0 0 12 12"><path d="M4.4 1.6h3.2M5 1.6v3L3.2 6.6h5.6L7 4.6v-3M6 6.6v3.8"/></svg>',
    swap: '<svg viewBox="0 0 12 12"><path d="M2 4h7.5M7.6 2.1L9.5 4 7.6 5.9M10 8H2.5M4.4 6.1L2.5 8l1.9 1.9"/></svg>',
  };
  const glyph = (st) => (st === 'run' ? SW('glow') : PZ);

  // ── state ────────────────────────────────────────────────────────
  const S = { mode: 'yield', pinned: true, timers: [], drafts: [], session: 'tracking', seq: 0 };
  const running = () => S.timers.find((t) => t.state === 'run');
  const current = () => running() || S.timers[0];
  const byId = (id) => S.timers.find((t) => t.id === id);
  const draftById = (id) => S.drafts.find((d) => d.id === id);
  const elapsed = (t) => (t.fixedMs ?? (t.acc + (t.state === 'run' ? simNow - t.runSince : 0)));
  let nextKey = 7203;

  // ── DOM handles ──────────────────────────────────────────────────
  const desk = $('#desk');
  const wd = $('#wd');
  const ide = $('#ide');
  const browser = $('#browser');
  const widget = $('#widget');
  const appEl = $('.app', wd);
  const hdr = $('.header', appEl);
  const NG_APP = [...hdr.attributes].find((a) => a.name.startsWith('_ngcontent')).name;
  const dayView = $('app-day-view', appEl);
  const lpMid = $('.lp-mid', dayView);
  const sesRow = $('.blk.hot app-session-row', dayView);
  const sesBtn = sesRow && $('.tb', sesRow);

  // Suggestion-row templates for drafts: a task? row and a resolved row's Log….
  const sugRows = $$('app-suggestion-row', lpMid);
  const tplSug = sugRows.find((r) => $('.chip.ask', r)).cloneNode(true);
  const tplLog = $('.btn-log', sugRows.find((r) => $('.btn-log', r))).cloneNode(true);

  // ── windows, z-order ─────────────────────────────────────────────
  let zTop = 10;
  const raise = (el) => { el.style.zIndex = String(++zTop); };
  for (const w of [ide, wd, browser]) w.addEventListener('mousedown', () => raise(w), true);

  // ── titlebar: timer capsule + window controls ────────────────────
  const anchor = document.createElement('button');
  anchor.type = 'button';
  const wc = document.createElement('div');
  wc.innerHTML = `<div ${NG_APP} class="win-controls"><button ${NG_APP} class="wc-btn" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1 5.5h8"/></svg></button><button ${NG_APP} class="wc-btn wc-close" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`;
  hdr.append(anchor, wc.firstElementChild);

  function anchorParts(t, multi) {
    if (!t) return { cls: 'tm-cap idle', html: `${PLUS}<span>Timer</span>` };
    const live = t.id ? ` data-t="${t.id}"` : '';
    return { cls: `tm-cap ${t.state}${multi ? ' multi' : ''}`, html: `<span class="tm-gl">${glyph(t.state)}</span><span class="tm-t"${live}>${fmtRun(elapsed(t))}</span>${multi ? CHEV : ''}` };
  }
  function renderAnchor() {
    const p = anchorParts(current(), S.timers.length > 1);
    anchor.className = p.cls + (menuEl ? ' armed' : '');
    anchor.innerHTML = p.html;
  }
  anchor.addEventListener('click', () => {
    if (!S.timers.length) { startNew(); return; }
    if (menuEl) closeMenu(); else openMenu();
  });

  // ── views (Day / Sheets / Settings) ──────────────────────────────
  const views = { day: dayView };
  for (const [k, id] of [['set', 'tpl-set'], ['sheet', 'tpl-sheet']]) {
    const el = $(`#${id}`).content.firstElementChild.cloneNode(true);
    el.style.display = 'none';
    appEl.insertBefore(el, dayView.nextSibling);
    views[k] = el;
  }
  const viewBtns = { Day: 'day', Timesheets: 'sheet', Settings: 'set' };
  for (const b of $$('.view-btn', hdr)) {
    b.addEventListener('click', () => {
      const v = viewBtns[b.getAttribute('title')];
      for (const [k, el] of Object.entries(views)) el.style.display = k === v ? '' : 'none';
      for (const x of $$('.view-btn', hdr)) x.classList.toggle('active', x === b);
    });
  }

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
  function startNew() {
    const r = running();
    if (r) haltRun(r, 'pause');
    const t = { id: ++S.seq, task: null, title: '', desc: '', firstAt: simNow, acc: 0, runSince: simNow, state: 'run' };
    S.timers.unshift(t);
    log(`▶ таймер #${t.id} пошёл${r ? `, #${r.id} на паузе` : ''}${yieldSessions()}`);
    render();
    return t;
  }
  function pauseT(t) {
    haltRun(t, 'pause');
    log(`⏸ таймер ${label(t)} на паузе${sessionsBack()}`);
    render();
  }
  function resumeT(t) {
    const r = running();
    if (r && r !== t) haltRun(r, 'pause');
    t.state = 'run';
    t.runSince = simNow;
    S.timers = [t, ...S.timers.filter((x) => x !== t)];
    log(`▶ таймер ${label(t)} снова считает${r && r !== t ? `, #${r.id} на паузе` : ''}${yieldSessions()}`);
    render();
  }
  function toggleT(t) { if (t.state === 'run') pauseT(t); else resumeT(t); }
  function stopT(t, quiet) {
    const ms = elapsed(t);
    S.timers = S.timers.filter((x) => x !== t);
    S.drafts.unshift({ id: t.id, task: t.task, title: t.title, desc: t.desc, from: t.firstAt, to: simNow, ms, fresh: true });
    const back = quiet ? '' : sessionsBack();
    log(`■ таймер ${label(t)} → черновик ${fmtMin(ms)} в ленте${back}`);
    if (!quiet) render();
  }
  function stopNew(t) { stopT(t, true); startNew(); }
  function discardT(t) {
    S.timers = S.timers.filter((x) => x !== t);
    log(`✕ таймер ${label(t)} выброшен${sessionsBack()}`);
    render();
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

  // ── the menu ─────────────────────────────────────────────────────
  let menuEl = null;
  let selId = null;
  let edit = null; // { kind: 'desc' | 'time', id }
  const ordered = () => { const r = running(); return r ? [r, ...S.timers.filter((t) => t !== r)] : [...S.timers]; };
  const selected = () => byId(selId) || current();

  function openMenu() {
    closeMenu();
    if (!S.timers.length) return;
    selId = current().id;
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu anchored right tm-menu';
    wd.appendChild(menuEl);
    buildMenu();
    renderAnchor();
  }
  function closeMenu() {
    if (!menuEl) return;
    commitEdit();
    menuEl.remove();
    menuEl = null;
    edit = null;
    renderAnchor();
  }
  function placeMenu() {
    const a = anchor.getBoundingClientRect();
    const w = wd.getBoundingClientRect();
    menuEl.style.top = `${a.bottom - w.top + 6}px`;
    menuEl.style.right = `${Math.max(8, w.right - a.right - 10)}px`;
    menuEl.style.left = 'auto';
  }
  const item = (a, icon, text, hint = '', danger = false) =>
    `<div class="ctx-item${danger ? ' danger' : ''}" data-a="${a}"><span class="ci-ic">${icon}</span>${text}${hint ? `<span class="ci-hint">${hint}</span>` : ''}</div>`;

  function rowHTML(t) {
    const key = t.task
      ? `<span class="tm-key key" data-a="pick" data-id="${t.id}">${SW()}${esc(t.task)}</span><span class="tm-ttl">${esc(t.title)}</span>`
      : `<span class="tm-key ask" data-a="pick" data-id="${t.id}">${SW()}task?</span>`;
    const desc = edit && edit.kind === 'desc' && edit.id === t.id
      ? `<input class="tm-in" data-in="desc" value="${esc(t.desc)}" placeholder="what is it?">`
      : `<span class="tm-desc${t.desc ? '' : ' ph'}" data-a="desc" data-id="${t.id}">${t.desc ? esc(t.desc) : 'what is it?'}</span>`;
    const time = edit && edit.kind === 'time' && edit.id === t.id
      ? `<input class="tm-tin" data-in="time" value="${Math.round(elapsed(t) / 60000)}m">`
      : `<span class="tm-time" data-a="time" data-id="${t.id}" data-t="${t.id}">${fmtRun(elapsed(t))}</span>`;
    return `<div class="tm-row ${t.state}${t.id === selId ? ' sel' : ''}" data-a="sel" data-id="${t.id}">
      <button type="button" class="tm-g" data-a="toggle" data-id="${t.id}">${glyph(t.state)}</button>
      <div class="tm-mid"><div class="tm-l1">${key}</div><div class="tm-l2">${desc}</div></div>
      <div class="tm-right">${time}<span class="tm-word">${t.state === 'yield' ? 'session' : ''}</span></div></div>`;
  }

  function buildMenu() {
    if (!menuEl) return;
    if (!S.timers.length) { closeMenu(); return; }
    const t = selected();
    selId = t.id;
    const r = running();
    menuEl.innerHTML = `<div class="tm-list">${ordered().map(rowHTML).join('')}</div>
      <div class="ctx-sep"></div>
      ${t.state === 'run' ? item('pause', IC.pause, 'Pause') : item('resume', IC.play, 'Resume')}
      ${item('stop', IC.stop, 'Stop', '→ draft')}
      ${item('stopnew', IC.stopnew, 'Stop &amp; new')}
      ${item('new', IC.plus, 'New timer', r ? 'current pauses' : '')}
      ${item('discard', IC.x, 'Discard', '', true)}
      <div class="ctx-sep"></div>
      ${item('pin', IC.pin, 'Widget', S.pinned ? 'over all windows' : 'off')}
      ${item('mode', IC.swap, 'With sessions', S.mode)}`;
    placeMenu();
    const inp = $('[data-in]', menuEl);
    if (inp) { inp.focus(); inp.select(); }
  }

  function commitEdit() {
    if (!edit || !menuEl) return;
    const inp = $('[data-in]', menuEl);
    const t = byId(edit.id);
    if (inp && t) applyInput(t, edit.kind, inp.value);
    edit = null;
  }
  function applyInput(t, kind, value) {
    if (kind === 'desc') {
      t.desc = value.trim();
    } else {
      const m = parseInt(value, 10);
      if (!Number.isFinite(m)) return;
      const target = Math.max(0, m) * 60000;
      t.acc = t.state === 'run' ? target - (simNow - t.runSince) : target;
      log(`✎ таймер ${label(t)}: время → ${fmtRun(target)}, счёт продолжается от него`);
    }
  }

  document.addEventListener('click', (e) => {
    if (!menuEl || !menuEl.contains(e.target)) return;
    const el = e.target.closest('[data-a]');
    if (!el) return;
    const a = el.dataset.a;
    const id = +el.dataset.id;
    if (a === 'sel') { if (!edit) { selId = id; buildMenu(); } return; }
    if (a === 'toggle') { commitEdit(); selId = id; toggleT(byId(id)); return; }
    if (a === 'pick') { commitEdit(); closeMenu(); openCloud('pick', { kind: 'timer', id }); return; }
    if (a === 'desc' || a === 'time') { commitEdit(); selId = id; edit = { kind: a, id }; buildMenu(); return; }
    const t = selected();
    commitEdit();
    switch (a) {
      case 'pause': closeMenu(); pauseT(t); break;
      case 'resume': closeMenu(); resumeT(t); break;
      case 'stop': closeMenu(); stopT(t); break;
      case 'stopnew': closeMenu(); stopNew(t); break;
      case 'new': closeMenu(); startNew(); break;
      case 'discard': closeMenu(); discardT(t); break;
      case 'pin': S.pinned = !S.pinned; log(S.pinned ? '📌 виджет поверх всех окон' : 'виджет снят — таймер только в заголовке приложения'); render(); break;
      case 'mode': setMode(S.mode === 'yield' ? 'parallel' : 'yield'); break;
    }
  });
  document.addEventListener('keydown', (e) => {
    const inp = e.target.closest && e.target.closest('[data-in]');
    if (inp && menuEl) {
      if (e.key === 'Enter') { commitEdit(); buildMenu(); render(); }
      if (e.key === 'Escape') { edit = null; buildMenu(); e.stopPropagation(); }
      return;
    }
    if (e.key === 'Escape') { if (cloudState) closeCloud(); else closeMenu(); }
  }, true);
  document.addEventListener('wheel', (e) => {
    const inp = e.target.closest && e.target.closest('[data-in="time"]');
    if (!inp) return;
    e.preventDefault();
    const m = Math.max(0, (parseInt(inp.value, 10) || 0) + (e.deltaY < 0 ? 15 : -15));
    inp.value = `${m}m`;
  }, { passive: false });
  document.addEventListener('mousedown', (e) => {
    if (!menuEl) return;
    if (menuEl.contains(e.target) || anchor.contains(e.target) || widget.contains(e.target)) return;
    closeMenu();
  }, true);

  // ── cloud: one picker for Log and for the timer ──────────────────
  const cloud = $('app-log-cloud', appEl);
  const backdrop = $('.cloud-backdrop', appEl);
  appEl.append(backdrop, cloud);
  const cloudInput = $('.cloud-filter input', cloud);
  const chips = $('.cloud-chips', cloud);
  const NG_CLOUD = [...$('.fav', chips).attributes].find((a) => a.name.startsWith('_ngcontent')).name;
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
  // Pinned footer under the scrolling chips: creating is always one glance away.
  const createChip = mkChip('＋', 'Create in Jira…', 'tm-create');
  const foot = document.createElement('div');
  foot.className = 'tm-foot';
  foot.append(createChip);
  $('.cloud-body', cloud).after(foot);
  foot.addEventListener('click', () => { if (cloudState) openJiraForm(); });
  let createdLbl = null;

  function openCloud(mode, target) {
    cloudState = { mode, target };
    cloud.classList.add('open');
    cloud.classList.toggle('tm-pick', mode === 'pick');
    backdrop.classList.add('open');
    cloud.style.top = mode === 'pick' ? '35px' : '84px';
    cloudInput.value = '';
    cloudInput.placeholder = mode === 'pick' ? 'ticket for the timer · no match → search Jira' : origPlaceholder;
    filterChips();
    setTimeout(() => cloudInput.focus(), 40);
  }
  function closeCloud() {
    cloud.classList.remove('open', 'tm-pick');
    backdrop.classList.remove('open');
    cloudState = null;
  }
  backdrop.addEventListener('click', closeCloud);
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
    const isFav = !chip.classList.contains('jira');
    pick(task, name, isFav);
  });
  function pick(task, name, isFav) {
    const st = cloudState;
    if (st.mode === 'log') { log(`+ Log → ${task}: дальше обычная форма Log`); closeCloud(); return; }
    const obj = st.target.kind === 'timer' ? byId(st.target.id) : draftById(st.target.id);
    if (obj) {
      obj.task = task;
      obj.title = isFav ? '' : name;
      if (isFav && !obj.desc) obj.desc = name;
      log(`${st.target.kind === 'timer' ? 'таймер' : 'черновик'} #${obj.id} ← ${task}${isFav ? ` · «${name}»` : ''}`);
    }
    closeCloud();
    render();
    if (st.target.kind === 'timer' && obj) { openMenu(); selId = obj.id; buildMenu(); }
  }

  // ── Create in Jira: the real form, in the browser ────────────────
  const brSum = $('#brSum');
  function openJiraForm() {
    const st = cloudState;
    const owner = st && st.mode === 'pick' ? (st.target.kind === 'timer' ? byId(st.target.id) : draftById(st.target.id)) : null;
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

  // ── drafts in the feed ───────────────────────────────────────────
  function draftEl(d) {
    const host = tplSug.cloneNode(true);
    host.classList.add('tm-draft-host');
    host.dataset.id = d.id;
    const sug = $('.sug2', host);
    sug.classList.add('tm-draft');
    if (d.fresh) sug.classList.add('fresh');
    let chip = $('.chip', host);
    if (d.task) {
      const span = document.createElement('span');
      for (const at of chip.attributes) span.setAttribute(at.name, at.value);
      span.append(...chip.childNodes);
      chip.replaceWith(span);
      chip = span;
    }
    chip.className = `chip ${d.task ? 'key' : 'ask'}`;
    chip.dataset.a = 'dpick';
    $('.k-ind', chip).innerHTML = SW();
    for (const n of [...chip.childNodes]) if (n.nodeType === 3) n.remove();
    chip.append(d.task || 'task?');
    $('.s-title', host).textContent = d.title || '';
    $('.s-dur', host).textContent = fmtMin(d.ms);
    $('.s-when', host).textContent = `${fmtClock(d.from)}–${fmtClock(d.to)}`;
    const src = $('.s-src', host);
    if (dEdit === d.id) {
      src.className = 's-src';
      src.innerHTML = `<input class="tm-in" data-din="${d.id}" value="${esc(d.desc)}" placeholder="what is it?">`;
    } else {
      src.className = `s-src tm-desc${d.desc ? '' : ' ph'}`;
      src.dataset.a = 'ddesc';
      src.textContent = d.desc || 'what is it?';
    }
    const act = $('.s-act', host);
    const deny = $('.lnk-deny', act);
    deny.textContent = 'Discard';
    deny.dataset.a = 'ddiscard';
    for (const b of $$('.btn-log', act)) b.remove();
    if (d.task) {
      const lg = tplLog.cloneNode(true);
      lg.classList.add('tm-log');
      lg.dataset.a = 'dlog';
      act.append(lg);
    }
    return host;
  }
  let dEdit = null;
  function renderDrafts() {
    for (const n of $$('.tm-draft-host', lpMid)) n.remove();
    for (const d of [...S.drafts].reverse()) lpMid.prepend(draftEl(d));
    for (const d of S.drafts) d.fresh = false;
    const inp = $('[data-din]', lpMid);
    if (inp) { inp.focus(); inp.select(); }
  }
  lpMid.addEventListener('click', (e) => {
    const host = e.target.closest('.tm-draft-host');
    if (!host) return;
    const el = e.target.closest('[data-a]');
    if (!el) return;
    const d = draftById(+host.dataset.id);
    switch (el.dataset.a) {
      case 'dpick': openCloud('pick', { kind: 'draft', id: d.id }); break;
      case 'ddesc': dEdit = d.id; renderDrafts(); break;
      case 'ddiscard': S.drafts = S.drafts.filter((x) => x !== d); log(`черновик #${d.id} выброшен`); render(); break;
      case 'dlog':
        S.drafts = S.drafts.filter((x) => x !== d);
        log(`Log… #${d.id} → форма Log (как у suggestion) → ManualEntry ${d.task} ${fmtMin(d.ms)}, sourceRef timer:${d.id}`);
        render();
        break;
    }
  });
  lpMid.addEventListener('keydown', (e) => {
    const inp = e.target.closest('[data-din]');
    if (!inp) return;
    if (e.key === 'Enter') { draftById(+inp.dataset.din).desc = inp.value.trim(); dEdit = null; renderDrafts(); }
    if (e.key === 'Escape') { dEdit = null; renderDrafts(); }
  });
  lpMid.addEventListener('focusout', (e) => {
    const inp = e.target.closest && e.target.closest('[data-din]');
    if (!inp || dEdit === null) return;
    const d = draftById(+inp.dataset.din);
    if (d) d.desc = inp.value.trim();
    dEdit = null;
    setTimeout(renderDrafts, 0);
  });

  // ── the widget ───────────────────────────────────────────────────
  const wPos = { x: 318, y: 36, w: 250, h: 46 };
  function widgetInner(t, live) {
    const key = t.task ? `<span class="tw-key">${esc(t.task)}</span>` : '<span class="tw-key ask">task?</span>';
    const desc = t.state === 'yield'
      ? '<span class="tw-desc word">session</span>'
      : `<span class="tw-desc${t.desc ? '' : ' ph'}">${t.desc ? esc(t.desc) : 'what is it?'}</span>`;
    return `<button type="button" class="tw-g" data-w="toggle">${glyph(t.state)}</button><div class="tw-mid">${key}${desc}</div><span class="tw-time"${live ? ` data-t="${t.id}"` : ''}>${fmtRun(elapsed(t))}</span>`;
  }
  function placeWidget() {
    Object.assign(widget.style, { left: `${wPos.x}px`, top: `${wPos.y}px`, width: `${wPos.w}px`, height: `${wPos.h}px` });
  }
  function renderWidget() {
    const t = current();
    const show = S.pinned && !!t;
    widget.hidden = !show;
    if (!show) return;
    widget.className = `tm-widget ${t.state}`;
    widget.innerHTML = `${widgetInner(t, true)}<button type="button" class="tw-pin" data-w="unpin">${IC.pin}</button><span class="tw-grip" data-w="grip"></span>`;
    placeWidget();
  }
  widget.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w === 'toggle' || w === 'unpin') return;
    e.preventDefault();
    const grip = w === 'grip';
    const st = { cx: e.clientX, cy: e.clientY, ...wPos };
    let moved = false;
    widget.classList.add('dragging');
    const mv = (ev) => {
      const dx = ev.clientX - st.cx;
      const dy = ev.clientY - st.cy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (grip) { wPos.w = clamp(st.w + dx, 160, 480); wPos.h = clamp(st.h + dy, 34, 130); }
      else { wPos.x = clamp(st.x + dx, 0, desk.clientWidth - wPos.w); wPos.y = clamp(st.y + dy, 0, desk.clientHeight - 40 - wPos.h); }
      placeWidget();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      widget.classList.remove('dragging');
      if (!moved && !grip) { raise(wd); openMenu(); log('клик по виджету → приложение впереди, меню таймера открыто'); }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
  widget.addEventListener('click', (e) => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w === 'toggle') { const t = current(); if (t) toggleT(t); }
    if (w === 'unpin') { S.pinned = false; log('виджет снят (Unpin) — таймер только в заголовке приложения'); render(); }
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
    if (m === 'yield' && running()) log(`(уже идущие таймер и сессия не трогаем — правило сработает на следующем событии)`);
    render();
  }
  function syncToolbar() {
    for (const b of $$('[data-mode]')) b.classList.toggle('on', b.dataset.mode === S.mode);
    for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === speed);
  }
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    if (b.dataset.speed) { speed = +b.dataset.speed; syncToolbar(); }
    if (b.dataset.act === 'git') gitActivity();
    if (b.dataset.preset) preset(b.dataset.preset);
  });

  function reset() {
    closeMenu(); closeCloud(); closeBrowser();
    S.timers = []; S.drafts = []; S.seq = 0; S.pinned = true; S.mode = 'yield';
    simNow = DAY0;
    nextKey = 7203;
    for (const c of $$('.fav.jira.mine', chips)) if (/^ATL-72\d\d$/.test($('.f-task', c).textContent)) c.remove();
    if (createdLbl) { createdLbl.remove(); createdLbl = null; }
    setSession('tracking');
    evlog.innerHTML = '';
  }
  const mkT = (o) => ({ id: ++S.seq, task: null, title: '', desc: '', firstAt: simNow - (o.acc || 0), acc: 0, runSince: null, state: 'pause', ...o });
  function preset(name) {
    reset();
    if (name === 'run') {
      const t = mkT({ desc: 'разбор 500-х на checkout', acc: (47 * 60 + 15) * 1000, state: 'run' });
      t.acc = (47 * 60 + 15) * 1000; t.runSince = simNow;
      S.timers = [t]; setSession('paused');
      log('сцена: идёт таймер без тикета, сессия web-frontend на паузе (yield)');
    }
    if (name === 'two') {
      const a = mkT({ desc: 'разбор 500-х на checkout', acc: (47 * 60 + 15) * 1000 });
      const b = mkT({ task: 'ATL-7014', title: 'Save pipeline drops middle names on import', desc: 'созвон с QA', acc: 12 * 60 * 1000, state: 'run' });
      b.runSince = simNow;
      S.timers = [b, a]; setSession('paused');
      log('сцена: два таймера — идёт #2, #1 на паузе; в заголовке шеврон');
    }
    if (name === 'yield') {
      const t = mkT({ desc: 'разбор 500-х на checkout', acc: (23 * 60 + 40) * 1000, state: 'yield' });
      S.timers = [t]; setSession('tracking');
      log('сцена: git-правка — сессия выиграла, таймер стоит; вернуть — кликом ⏵');
    }
    if (name === 'drafts') {
      S.seq = 2;
      S.drafts = [
        { id: 2, task: 'ATL-7001', title: 'Payment gateway timeout on 3DS callback', desc: 'repro на стенде', from: DAY0 - 95 * 60000, to: DAY0 - 40 * 60000, ms: 55 * 60000 },
        { id: 1, task: null, title: '', desc: 'помог соседней команде с деплоем', from: DAY0 - 180 * 60000, to: DAY0 - 140 * 60000, ms: 40 * 60000 },
      ];
      log('сцена: два черновика — без тикета (только Discard, тикет через task?) и с тикетом (Log…)');
    }
    if (name === 'empty') log('сцена: пусто — в заголовке + Timer');
    render();
  }

  // ── render + tick ────────────────────────────────────────────────
  function render() {
    renderAnchor();
    renderWidget();
    renderTray();
    renderDrafts();
    if (menuEl) buildMenu();
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
    $('#tbClock').innerHTML = `${fmtClock(simNow)}<br>26.10.2026`;
  }
  setInterval(tick, 200);

  // ── states at a glance ───────────────────────────────────────────
  function buildStrips() {
    const host = $('#strips');
    const hdrCell = (t, multi, cap, extra = '') => {
      const h = hdr.cloneNode(true);
      const a = $('.tm-cap', h);
      const p = anchorParts(t, multi);
      a.className = p.cls + extra;
      a.innerHTML = p.html;
      return `<div class="st-cell"><div class="st-hdr">${h.outerHTML}</div><div class="st-cap">${cap}</div></div>`;
    };
    const F = (o) => ({ task: null, title: '', desc: '', state: 'run', ...o });
    const m = (mm, ss = 0) => (mm * 60 + ss) * 1000;
    const wCell = (t, w, h, cap) => `<div class="st-cell"><div class="tm-widget static ${t.state}" style="width:${w}px;height:${h}px">${widgetInner(t, false)}</div><div class="st-cap">${cap}</div></div>`;
    const tCell = (eyes, clock, cap) => `<div class="st-cell"><span class="st-tray">${traySvg(eyes, clock, 52)}</span><span class="st-tray sm">${traySvg(eyes, clock, 16)}</span><div class="st-cap" style="max-width:150px">${cap}</div></div>`;
    host.innerHTML = `
      <div class="st-row">
        ${hdrCell(null, false, 'нет таймеров — тихий плоский <b>+ Timer</b>, на наведении лайм; один клик = таймер пошёл')}
        ${hdrCell(F({ fixedMs: m(12, 8) }), false, 'идёт — акцент только цветом: светящийся секундомер + лаймовое время')}
        ${hdrCell(F({ fixedMs: m(65, 30) }), false, 'с часа — без секунд (1h 05m)')}
        ${hdrCell(F({ state: 'pause', fixedMs: m(47, 15) }), false, 'на паузе — красный ⏸, время гаснет')}
        ${hdrCell(F({ fixedMs: m(12, 8) }), true, 'таймеров несколько — шеврон; меню = список + действия')}
        ${hdrCell(F({ fixedMs: m(12, 8) }), true, 'наведение / меню открыто — плоская подложка, без стекла', ' armed')}
      </div>
      <div class="st-row">
        ${wCell(F({ fixedMs: m(12, 8) }), 250, 46, 'виджет: идёт, без тикета')}
        ${wCell(F({ task: 'ATL-7203', desc: 'Prod 500s on 3DS callback', fixedMs: m(65) }), 250, 46, 'с тикетом и описанием')}
        ${wCell(F({ state: 'pause', desc: 'разбор 500-х на checkout', fixedMs: m(47, 15) }), 250, 46, 'на паузе (рукой)')}
        ${wCell(F({ state: 'yield', desc: 'разбор 500-х', fixedMs: m(23, 40) }), 250, 46, 'перехватила сессия — слово session; вернуть кликом ⏵')}
        ${wCell(F({ task: 'ATL-7203', desc: 'Prod 500s on 3DS callback', fixedMs: m(65) }), 380, 82, 'растянут мышью — всё масштабируется')}
      </div>
      <div class="st-row">
        ${tCell(false, null, 'ничего не идёт')}
        ${tCell(true, null, 'идёт сессия — зелёные глаза')}
        ${tCell(false, 'run', 'идёт таймер (yield: сессии на паузе)')}
        ${tCell(true, 'run', 'parallel: и сессия, и таймер')}
        ${tCell(true, 'pause', 'сессия перехватила, таймер ждёт')}
      </div>`;
  }

  syncToolbar();
  render();
  buildStrips();
  tick();
  log('макет готов — нажми + Timer в заголовке окна');
})();
