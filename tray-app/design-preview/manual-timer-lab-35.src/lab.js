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
  // a ticking time keeps its seconds past the hour too
  const fmtRun = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    return h ? `${h}h ${pad(Math.floor(s / 60) % 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  };
  const fmtHm = (min) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${pad(min % 60)}m`);
  const fmtSec = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const fmtClock = (t) => fmtSec(t).slice(0, 5);
  // 1h 15m · 1h · 90 · 45m — like the app's duration field
  function parseMin(v) {
    const m = String(v).trim().toLowerCase().match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?$/);
    if (!m || (!m[1] && !m[2])) return null;
    return (+(m[1] || 0)) * 60 + (+(m[2] || 0));
  }

  // ── glyphs (own SVG — no SF Symbols) ─────────────────────────────
  // the timer icon: a ring + a hand to 12; paused — two bars inside the ring
  const ic = (st) => `<svg class="t-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/>${
    st === 'pause' ? '<path d="M5.7 5.1v3.8M8.3 5.1v3.8"/>' : '<path d="M7 7V3.8"/>'}</svg>`;
  const PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.8 1.5l5.6 3.5-5.6 3.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.3 2.2v5.6M6.7 2.2v5.6"/></svg>';
  const PLUS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';
  const PIN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.1 1.5h3.8M4.8 1.5v3.1L3.1 6.9h5.8L7.2 4.6V1.5M6 6.9v3.6"/></svg>';
  const MI = {
    play: '<svg viewBox="0 0 12 12"><path d="M3.5 2.2l6 3.8-6 3.8z"/></svg>',
    edit: '<svg viewBox="0 0 12 12"><path d="M2 10l.6-2.4L8 2.2l1.8 1.8-5.4 5.4z"/></svg>',
    del: '<svg viewBox="0 0 12 12"><path d="M2.5 3.5h7M4.8 3.5V2.3h2.4v1.2M3.5 3.5l.5 6.2h4l.5-6.2"/></svg>',
    untime: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2"/><path d="M6 6V3.6M2.3 9.7l7.4-7.4"/></svg>',
    timer: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2"/><path d="M6 6V3.6"/></svg>',
    add: '<svg viewBox="0 0 12 12"><path d="M6 2.2v7.6M2.2 6h7.6"/></svg>',
    globe: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2"/><path d="M1.8 6h8.4M6 1.8c1.6 1.2 1.6 7.2 0 8.4M6 1.8c-1.6 1.2-1.6 7.2 0 8.4"/></svg>',
    x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
  };
  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];
  const ACT_NAME = { CodeReview: 'Code Review', DesignAnalysis: 'Design Analysis' };

  // ── state ────────────────────────────────────────────────────────
  // a timer without a ticket: { id, desc, sec, runSince, state: run | wait | pause }
  // a record of a ticket card: { id, el, blk, task, kind: ent | man, act, desc, sec, sec0, runSince,
  //   state: null | run | wait | pause, fed (a timer fed it today — it lives in the island), share (the timer's seconds since the last manual edit) }
  // order — the island's rows in the order they joined
  // ses — the git session of web-frontend as the daemon's evaluator sees it (30 s ticks, Normal):
  //   score — stamina in ticks (a touch buys the floor of 22.5 = 11m 15s, the cap is 90 = 45m), att — the 2-minute attention EMA,
  //   sec / since — its tracked time, off — the tracked total at the birth of the current row, closed — no live row
  const TICK = 30000, ALPHA = 0.25, CAP = 90, FLOOR = 22.5, GAIN = 2, IDLE_CLOSE = 3 * 3600000;
  // the evaluator's takeover rule with the timer in the leader's seat: it defends the lead with one touch's worth of attention
  const TIMER_ATT = ALPHA;
  const S = { seq: 0, anon: [], recs: [], order: [], hist: [], pinned: false, open: false, anchor: null, editing: null, cut: 0, ses: null, nextTick: 0, ev: null };
  const isRec = (x) => !!x.el;
  const delta = (x) => (x.state === 'run' ? (simNow - x.runSince) / 1000 : 0);
  const secOf = (x) => x.sec + delta(x);
  const shareOf = (r) => r.share + delta(r);
  const live = (x) => x.state === 'run' || x.state === 'wait';
  const fmtOf = (x) => (isRec(x) && !live(x) ? fmtHm(Math.floor(x.sec / 60)) : fmtRun(secOf(x)));
  const nameOf = (x) => (isRec(x) ? `запись ${x.task} ${x.kind === 'man' ? '· manual added' : `«${esc(x.desc)}»`}` : `таймер без тикета «${esc(x.desc || 'без описания')}»`);
  const byId = (id) => S.order.find((x) => x.id === id) || S.recs.find((x) => x.id === id) || S.anon.find((x) => x.id === id);
  const current = () => S.order.find((x) => x.state === 'run') || S.order.find((x) => x.state === 'wait')
    || [...S.hist].reverse().find((x) => S.order.includes(x)) || S.order[S.order.length - 1] || null;
  const touch = (x) => { S.hist = S.hist.filter((y) => y !== x); S.hist.push(x); };
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
  const NL = ngOf($('.btn-log', dayView)); // the suggestion card's scope: task? and Deny are its own classes
  const feedOrig = lpTable.cloneNode(true);
  const tplBlk = $('.blk.one[data-task="APP-1024"]', feedOrig).cloneNode(true);
  const tplEnt = $('.wl.ent[data-eid="m2"]', feedOrig).cloneNode(true);
  const tplMan = $('.wl.manline', feedOrig).cloneNode(true);
  const MG = $('.mg', tplMan).outerHTML;
  const NG_LP = ngOf(tplEnt);
  const totalBase = parseMin(dayTotal.textContent);
  const lead0 = $('.blk.hot app-session-row.lead', feedOrig);
  const frost0 = $('.blk.hot app-session-row.frost', feedOrig);
  const closed0 = $('app-session-row.closed', feedOrig);
  const SES = {
    lead: { cls: lead0.className, style: lead0.getAttribute('style'), btn: $('.tb', lead0).outerHTML },
    frost: { cls: frost0.className, style: frost0.getAttribute('style'), btn: $('.tb', frost0).outerHTML },
    closed: { cls: closed0.className, style: closed0.getAttribute('style'), type: $('.c-type', closed0).outerHTML },
  };
  const sesBase = parseMin($('.dur', lead0).textContent) * 60;
  const sesFrom0 = $('.rv', lead0).textContent.split('–')[0];
  const newSes = (score) => ({ sec: sesBase, since: null, off: 0, from: sesFrom0, score, att: 0, edit: false, zeroAt: null, endAt: null, closed: false });
  let sesRow = null, hotBlk = null;

  hdr.insertAdjacentHTML('beforeend', `<div ${NG_APP} class="win-controls"><button ${NG_APP} class="wc-btn" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1 5.5h8"/></svg></button><button ${NG_APP} class="wc-btn wc-close" type="button"><svg ${NG_APP} viewBox="0 0 10 10"><path ${NG_APP} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
  const zone = document.createElement('span');
  zone.className = 'tmz';
  hdr.insertBefore(zone, $('.win-controls', hdr));
  const panel = document.createElement('div');
  panel.className = 'tpanel';
  panel.style.display = 'none';
  appEl.append(panel);
  const slot = $('#wgt-slot');
  const deskN = $('#desk-n');

  // ── views (Day / Timesheets / Settings) — the chip and the island are seen from every tab ───
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
  }
  for (const b of $$('.view-btn', hdr)) b.addEventListener('click', () => { closeMenu(); closeCloud(); if (S.editing) endEdit(false); showView(viewBtns[b.getAttribute('title')]); });
  const onDay = () => views.day.style.display !== 'none';

  // ── event log ────────────────────────────────────────────────────
  const evlog = $('#evlog');
  function log(msg) {
    const d = document.createElement('div');
    d.className = 'ev';
    d.innerHTML = `<b>${fmtSec(simNow)}</b>${msg}`;
    evlog.prepend(d);
    while (evlog.children.length > 16) evlog.lastChild.remove();
  }

  // ── the git session: it counts only while it has stamina and no timer runs ──
  // Under a timer it is superseded, not frozen: its stamina keeps fading by the clock.
  const anyRun = () => S.order.some((x) => x.state === 'run');
  const sesAlive = () => S.ses.score > 0;
  const sesTracking = () => sesAlive() && !anyRun();
  const sesSec = () => S.ses.sec + (S.ses.since != null ? (simNow - S.ses.since) / 1000 : 0);
  const stamina = () => fmtRun(S.ses.score * TICK / 1000);
  function clockSes() {
    const s = S.ses, tr = sesTracking();
    if (tr && s.since == null) s.since = simNow;
    if (!tr && s.since != null) { s.sec = sesSec(); s.since = null; s.endAt = simNow; }
  }
  function syncSession() {
    clockSes();
    if (S.ses.closed) {
      if (!sesTracking()) return;
      bornSession();
    }
    const want = sesTracking() ? SES.lead : SES.frost;
    if (sesRow.className !== want.cls) {
      sesRow.className = want.cls;
      sesRow.setAttribute('style', want.style);
      $('.tb', sesRow).outerHTML = want.btn;
    }
    paintSes();
  }
  function paintSes() {
    if (!sesRow) return;
    $('.dur', sesRow).textContent = fmtHm(Math.floor((sesSec() - S.ses.off) / 60));
    sesRow.style.setProperty('--stam', (S.ses.score / CAP).toFixed(3));
  }
  // three hours in the idle pause: the session closes by itself, its end is where the pause began
  function closeSession() {
    const s = S.ses;
    paintSes();
    sesRow.className = SES.closed.cls;
    sesRow.setAttribute('style', SES.closed.style);
    $('.tb', sesRow).outerHTML = SES.closed.type;
    $('.rv', sesRow).textContent = `${s.from}–${fmtClock(s.endAt ?? simNow)}`;
    sesRow = null;
    s.closed = true;
    log(`три часа тишины → сессия web-frontend закрылась сама, конец — ${fmtClock(s.endAt ?? simNow)}; будить больше нечего`);
  }
  // lazy sessions: activity after an auto-close births a fresh one
  function bornSession() {
    const s = S.ses;
    const el = lead0.cloneNode(true);
    s.from = fmtClock(simNow);
    $('.rv', el).textContent = `${s.from}–now`;
    $('.s-com', el).textContent = '0';
    $('.plus', el).textContent = '+14';
    $('.minus', el).textContent = '−3';
    $('.blk-body', hotBlk).prepend(el);
    sesRow = el;
    s.closed = false;
    s.off = sesSec();
    log('правки после закрытия → родилась новая сессия web-frontend');
  }

  // one evaluator tick: attention and stamina first, then who holds the lead
  function evalTick() {
    const s = S.ses, act = s.edit, had = s.score > 0, was = sesTracking();
    s.edit = false;
    s.att = ALPHA * (act ? 1 : 0) + (1 - ALPHA) * s.att;
    if (act) s.score = Math.min(CAP, Math.max(s.score, FLOOR) + GAIN);
    s.score = Math.max(0, s.score - 1);
    const run = S.order.find((x) => x.state === 'run');
    const wait = S.order.find((x) => x.state === 'wait');
    if (act) {
      // a running timer gives the lead away only to edits that come one after another
      if (run && s.att > TIMER_ATT + ALPHA) { fold(run, 'wait'); S.ev = { kind: 'took', who: run }; }
      else S.ev = { kind: run ? 'kept' : 'ses', who: run || wait || null };
    }
    if (had && s.score <= 0) {
      if (wait) { wait.state = 'run'; wait.runSince = simNow; touch(wait); log(`стамина сессии вышла → ${nameOf(wait)} идёт дальше сам`); }
      else if (run) log('стамина сессии вышла под таймером → остановка таймера её уже не разбудит');
      else if (was) log('стамина сессии вышла → Waiting, никто не считает');
    }
    clockSes();
    if (s.score > 0) s.zeroAt = null;
    else if (s.closed) s.att = 0; // a candidate that never took the lead evaporates
    else {
      s.zeroAt ??= simNow;
      if (simNow - s.zeroAt >= IDLE_CLOSE) closeSession();
    }
  }
  // the clock moves only through here, so every tick lands at its own moment
  function advance(ms) {
    const target = simNow + ms;
    while (S.nextTick <= target) { simNow = S.nextTick; S.nextTick += TICK; evalTick(); }
    simNow = target;
  }
  const sig = () => `${sesTracking()}|${S.ses.closed}|${S.order.map((x) => x.state).join()}`;

  // the lab's own readout of the session (not a part of the app)
  const sesLine = $('#sesline');
  let lineTxt = '';
  function paintLine() {
    const s = S.ses;
    const left = s.zeroAt != null ? Math.max(0, IDLE_CLOSE - (simNow - s.zeroAt)) / 1000 : 0;
    const st = sesTracking() ? 'Tracking — считает'
      : sesAlive() ? (s.closed ? 'строки нет — одиночная правка после закрытия' : 'Waiting — вытеснена таймером, стамина тает в фоне')
        : s.closed ? 'закрыта — живой сессии нет'
          : `Waiting — стамина вышла, закроется сама через ${fmtHm(Math.ceil(left / 60))}`;
    const txt = `сессия web-frontend: <b>${st}</b> · стамина <b>${sesAlive() ? stamina() : '0'}</b> · внимание <b>${s.att.toFixed(2)}</b> <i>таймер отдаёт счёт выше ${(TIMER_ATT + ALPHA).toFixed(2)}</i>`;
    if (txt === lineTxt) return;
    lineTxt = txt;
    sesLine.innerHTML = txt;
  }

  // ── the feed: records a timer can feed ───────────────────────────
  function initFeed() {
    hotBlk = $('.blk.hot', lpTable);
    sesRow = $('app-session-row', hotBlk);
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
          desc: man ? '' : $('.c-ds', el).textContent.trim(), sec: min * 60, sec0: min * 60, runSince: null, state: null, fed: false, share: 0 };
        el.dataset.rid = r.id;
        S.recs.push(r);
      }
    }
  }
  // a card of one row keeps its time in the lid; a row with a timer needs its own time slot
  function unOne(blk) {
    if (!blk.classList.contains('one')) return;
    blk.classList.remove('one');
    for (const d of $$('app-session-row .dur', blk)) if (!d.textContent.trim()) d.textContent = fmtHm(+blk.dataset.base);
  }
  function paintRec(r) {
    if (S.editing === r) return;
    const ds = $('.c-ds', r.el);
    if (r.kind === 'man') ds.innerHTML = `<span ${NG_LP}>manual added</span>${MG}`;
    else ds.textContent = r.desc;
    r.el.classList.remove('tm-edit');
    r.el.classList.toggle('tm-live', r.state === 'run');
    r.el.classList.toggle('tm-wait', r.state === 'wait');
    const dur = $('.c-dur', r.el);
    dur.classList.toggle('rt', r.fed);
    if (live(r)) dur.innerHTML = `<button type="button" class="rt-b run${r.state === 'wait' ? ' dim' : ''}" data-pz="${r.id}">${PAUSE}</button><span data-t="${r.id}">${fmtOf(r)}</span>`;
    else if (r.fed) dur.innerHTML = `<button type="button" class="rt-b rest" data-go="${r.id}">${PLAY}</button><span data-t="${r.id}">${fmtOf(r)}</span>`;
    else dur.textContent = r.blk.classList.contains('one') ? '' : fmtOf(r);
  }
  function paintBlk(blk) {
    const recs = S.recs.filter((r) => r.blk === blk);
    const sec = (+blk.dataset.base) * 60 + recs.reduce((a, r) => a + secOf(r) - r.sec0, 0) + (blk === hotBlk ? sesSec() - sesBase : 0);
    $('.sum', blk).textContent = fmtHm(Math.floor(sec / 60));
  }
  function paintTotal() {
    const d = S.recs.reduce((a, r) => a + secOf(r) - r.sec0, 0) + sesSec() - sesBase - S.cut;
    dayTotal.textContent = fmtHm(totalBase + Math.floor(d / 60));
  }
  function blockFor(task, title) {
    let blk = $(`.blk[data-task="${task}"]`, lpTable);
    if (blk) return blk;
    blk = tplBlk.cloneNode(true);
    blk.dataset.task = task;
    blk.dataset.base = '0';
    blk.classList.remove('one');
    $('.tkt', blk).textContent = task;
    const nm = $('.c-nm', blk);
    nm.textContent = title || '— name not cached';
    nm.classList.toggle('none', !title);
    $('.blk-body', blk).innerHTML = '';
    blk.style.order = '2';
    lpTable.insertBefore(blk, $$('.blk', lpTable).find((b) => !b.classList.contains('hot')) || null);
    return blk;
  }
  function newRec(task, title, kind, act, desc, sec) {
    const blk = blockFor(task, title);
    unOne(blk);
    const el = (kind === 'ent' ? tplEnt : tplMan).cloneNode(true);
    el.removeAttribute('data-eid');
    $('.c-type', el).textContent = act;
    $('.blk-body', blk).append(el);
    const r = { id: ++S.seq, el, blk, task, kind, act, desc, sec, sec0: 0, runSince: null, state: null, fed: false, share: 0 };
    el.dataset.rid = r.id;
    S.recs.push(r);
    return r;
  }
  // bare time (no description, Development) folds into the ticket's one manual added line
  const bareRec = (task, title) => S.recs.find((x) => x.task === task && x.kind === 'man') || newRec(task, title, 'man', 'Development', '', 0);
  function land(el) {
    el.classList.remove('tm-landed');
    void el.offsetWidth;
    el.classList.add('tm-landed');
    setTimeout(() => el.classList.remove('tm-landed'), 2600);
  }

  // ── running: one source counts at a time ─────────────────────────
  function fold(x, state) {
    const d = delta(x);
    x.sec += d;
    if (isRec(x)) x.share += d;
    x.runSince = null;
    x.state = state;
  }
  function haltOthers(keep) {
    let who = '';
    for (const x of S.order) if (x !== keep && live(x)) { fold(x, 'pause'); who = ` · ${nameOf(x)} — на паузе`; }
    return who;
  }
  function start(x) {
    const wasTr = sesTracking();
    const who = haltOthers(x);
    if (isRec(x)) { x.fed = true; unOne(x.blk); }
    if (!S.order.includes(x)) S.order.push(x);
    x.state = 'run';
    x.runSince = simNow;
    S.ses.att = 0; // a start by hand moves the attention to the timer
    touch(x);
    log(`▶ ${nameOf(x)} — счёт идёт${who}${wasTr ? ` · сессия web-frontend вытеснена (Waiting), её стамина ${stamina()} тает в фоне` : ''}`);
    renderAll();
  }
  function pause(x) {
    const led = x.state === 'run';
    fold(x, 'pause');
    touch(x);
    log(`⏸ ${nameOf(x)} — на паузе, ${fmtOf(x)}${!led ? '' : sesAlive() ? ` · у сессии ещё ${stamina()} стамины — она снова считает` : ' · стамина сессии вышла — никто не считает'}`);
    renderAll();
  }
  const toggle = (x) => (live(x) ? pause(x) : start(x));
  // edits in web-frontend: one save is one active tick of the evaluator
  const attTxt = () => `внимание ${S.ses.att.toFixed(2)}, порог ${(TIMER_ATT + ALPHA).toFixed(2)}`;
  function editOnce() {
    const was = sesTracking();
    S.ses.edit = true;
    S.nextTick = simNow;
    advance(0);
    const e = S.ev;
    log(e.kind === 'took' ? `правка в web-frontend — уже не одиночная (${attTxt()}) → считает сессия, ${nameOf(e.who)} ждёт`
      : e.kind === 'kept' ? `одиночная правка в web-frontend → счёт остался у таймера (${attTxt()}); у сессии заряд ${stamina()}, но не лидерство`
        : `правка в web-frontend → сессия ${was ? 'считает дальше' : 'проснулась и считает'}, заряд ${stamina()}${e.who ? ` · ${nameOf(e.who)} ждёт` : ''}`);
    renderAll();
  }
  function editBurst() {
    let took = null;
    for (let i = 0; i < 3; i++) {
      S.ses.edit = true;
      S.nextTick = simNow;
      advance(0);
      if (S.ev.kind === 'took') took = S.ev.who;
      advance(TICK - 1);
    }
    log(took ? `полторы минуты плотных правок (${attTxt()}) → сессия перехватила счёт, ${nameOf(took)} ждёт`
      : `полторы минуты плотных правок → считает сессия, заряд ${stamina()}`);
    renderAll();
  }
  function quiet(ms, label) {
    log(`${label} тишины — ни одной правки`);
    advance(ms);
    renderAll();
  }

  // ── the header: Timer at rest, the chip of the current timer otherwise ──
  const stOf = (x) => (x.state === 'run' ? 'run' : x.state === 'wait' ? 'wait' : 'pause');
  function renderChip() {
    const x = current();
    // at rest the element only opens the island — a timer starts from New timer there
    if (!x) { zone.innerHTML = `<button type="button" class="tchip ghost${S.open ? ' open' : ''}" data-a="island">${ic('idle')}Timer</button>`; return; }
    const st = stOf(x);
    const txt = fmtOf(x);
    zone.innerHTML = `<button type="button" class="tchip ${st}" data-a="island">${ic(st === 'pause' ? 'pause' : 'run')}<b class="tchip-time" data-t="${x.id}" style="width:${txt.length}ch">${txt}</b></button>`;
  }
  zone.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'island') {
      const was = S.open && !S.anchor;
      closeCloud();
      S.open = !was;
      renderChip();
      renderIsland();
    }
  });

  // ── the island: every timer of the day ───────────────────────────
  const btnOf = (x) => (x.state === 'run' ? `<button type="button" class="tbtn pz" data-a="toggle">${PAUSE}</button>`
    : x.state === 'wait' ? `<button type="button" class="tbtn pz dim" data-a="toggle">${PAUSE}</button>`
    : `<button type="button" class="tbtn go" data-a="toggle">${PLAY}</button>`);
  function rowHTML(x) {
    const st = stOf(x);
    const time = `<b class="ttime" data-t="${x.id}">${fmtOf(x)}</b>`;
    if (isRec(x)) return `<div class="trow tk ${st}" data-id="${x.id}">${btnOf(x)}<span class="tkey">${x.task}</span><span class="tfield">${x.kind === 'man' ? 'manual added' : esc(x.desc)}</span>${time}</div>`;
    return `<div class="trow an ${st}" data-id="${x.id}">${btnOf(x)}<button ${NL} type="button" class="chip ask tq${S.anchor === x ? ' armed' : ''}" data-a="task">task?</button>`
      + `<input class="tfield" placeholder="description" spellcheck="false" autocomplete="off" value="${esc(x.desc)}">${time}`
      + `<button ${NL} type="button" class="lnk-deny tdel" data-a="del">Delete</button></div>`;
  }
  function renderIsland() {
    if (!S.open) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
    // the lead may change hands by itself while a description is being typed — the caret stays where it was
    const ae = document.activeElement;
    const typing = ae && panel.contains(ae) && ae.matches('input.tfield')
      ? { id: +ae.closest('.trow').dataset.id, v: ae.value, a: ae.selectionStart, b: ae.selectionEnd, birth: pendingBirth } : null;
    const rows = S.anchor ? [S.anchor] : S.order;
    panel.innerHTML = (rows.length ? rows.map(rowHTML).join('') : '<div class="tnone">No timers</div>') + (S.anchor ? ''
      : `<div class="tsep"></div><div class="tbot"><button type="button" class="tnew" data-a="new"><span class="nt-g">${PLAY}</span><span>New timer</span></button>`
        + `<button type="button" class="tpin${S.pinned ? ' on' : ''}" data-a="pin">${PIN}</button></div>`);
    panel.style.display = '';
    for (const inp of $$('input.tfield', panel)) wireDesc(inp);
    const back = typing && $(`.trow[data-id="${typing.id}"] input`, panel);
    if (back) {
      back.value = typing.v;
      back.focus();
      back.setSelectionRange(typing.a, typing.b);
      pendingBirth = typing.birth;
    }
  }
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'new') { birth(); return; }
    if (a === 'pin') { setPin(!S.pinned); return; }
    const x = byId(+e.target.closest('.trow').dataset.id);
    if (a === 'toggle') toggle(x);
    if (a === 'task') { if (S.anchor === x) closeCloud(); else openCloud('pick', x); }
    if (a === 'del') {
      closeCloud();
      S.anon = S.anon.filter((t) => t !== x);
      S.order = S.order.filter((t) => t !== x);
      log(`Delete — ${nameOf(x)} удалён вместе с ${fmtRun(secOf(x))}; отмены нет`);
      renderAll();
    }
  });
  function setPin(on) {
    S.pinned = on;
    log(on ? 'булавка — виджет поверх всех окон включён' : 'булавка — виджет выключен, таймер виден только в шапке приложения');
    renderIsland();
    renderWidget();
  }

  // the description is a plain field: focus it — it is being edited; Enter or a click away keeps it, Esc puts it back
  let pendingBirth = null; // { t, was } — until the first focus leaves the new timer's description
  function wireDesc(inp) {
    const x = byId(+inp.closest('.trow').dataset.id);
    let orig = x.desc, cancel = false;
    inp.addEventListener('focus', () => { orig = x.desc; cancel = false; });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel = true;
      if (pendingBirth && pendingBirth.t === x && !inp.value.trim()) { const was = pendingBirth.was; pendingBirth = null; undoBirth(x, was); return; }
      inp.value = orig;
      inp.blur();
    });
    inp.addEventListener('blur', () => {
      if (pendingBirth && pendingBirth.t === x) pendingBirth = null;
      if (cancel) return;
      const v = inp.value.trim();
      inp.value = v;
      if (v === x.desc) return;
      x.desc = v;
      log(v ? `описание таймера: «${esc(v)}»` : 'описание таймера стёрто');
      renderWidget();
    });
  }
  // a clean timer: born by the click, runs from it, the caret waits in the description
  function birth(desc = '', quiet = false) {
    const cur = S.order.find(live);
    const was = { cur, state: cur?.state, open: S.open };
    const t = { id: ++S.seq, desc, sec: 0, runSince: null, state: 'pause' };
    S.anon.push(t);
    S.order.push(t);
    if (!quiet) S.open = true;
    start(t);
    if (quiet) return;
    pendingBirth = { t, was };
    $(`.trow[data-id="${t.id}"] input`, panel)?.focus();
  }
  // Esc right after an accidental start: the timer goes, whatever it paused runs again
  function undoBirth(t, was) {
    S.anon = S.anon.filter((x) => x !== t);
    S.order = S.order.filter((x) => x !== t);
    if (was.cur && S.order.includes(was.cur)) { was.cur.state = was.state; was.cur.runSince = was.state === 'run' ? simNow : null; }
    S.open = was.open;
    log('Esc сразу после старта — передумал: таймер убран, всё, что он остановил, идёт как шло');
    renderAll();
  }

  // ── the widget: the same timer the chip shows, over all windows ──
  function renderWidget() {
    const x = current();
    if (!S.pinned || !x) {
      slot.innerHTML = '';
      deskN.textContent = S.pinned ? 'виджет включён — появится с первым таймером' : 'виджет выключен — булавка внизу острова';
      return;
    }
    const st = stOf(x);
    const tx = isRec(x) ? `<b>${x.task}</b>${x.kind === 'man' ? 'manual added' : esc(x.desc)}` : (x.desc ? esc(x.desc) : '<span class="ph">no description</span>');
    slot.innerHTML = `<div class="wgt ${st}">${btnOf(x)}<b class="wt" data-t="${x.id}">${fmtOf(x)}</b><span class="wd-tx">${tx}</span><button type="button" class="tpin on" data-a="pin">${PIN}</button></div>`;
    deskN.textContent = 'поверх всех окон · булавка на виджете выключает его';
  }
  slot.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'pin') setPin(false);
    if (a === 'toggle') { const x = current(); if (x) toggle(x); }
  });

  // ── a record: its ⏸ / ▶ next to the time, its menu under the word of its type ──
  let menu = null; // { el, rec }
  const relRect = (el) => {
    const a = el.getBoundingClientRect(), b = appEl.getBoundingClientRect();
    return { left: a.left - b.left, top: a.top - b.top, right: a.right - b.left, bottom: a.bottom - b.top };
  };
  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    for (const x of $$('.c-type.armed, .tkt.armed', lpTable)) x.classList.remove('armed');
    menu = null;
  }
  function openRecMenu(r, typeEl) {
    closeMenu();
    const sh = shareOf(r);
    const items = [];
    // Start timer — only where the row has no ▶ / ⏸ of its own
    if (!r.fed) items.push(`<div class="ctx-item" data-a="run"><span class="ci-ic fl">${MI.play}</span>Start timer</div>`);
    items.push(`<div class="ctx-item" data-a="edit"><span class="ci-ic">${MI.edit}</span>Edit</div>`);
    // Remove timer — the whole timer leaves the row: its time, the ▶ at the time, the row in the island.
    // A record with nothing typed by hand has no such item: there it is Delete.
    if (r.fed && secOf(r) - sh >= 60) items.push(`<div class="ctx-item" data-a="untimer"><span class="ci-ic">${MI.untime}</span>Remove timer${sh >= 60 ? `<span class="ci-n">−${fmtHm(Math.floor(sh / 60))}</span>` : ''}</div>`);
    items.push('<div class="ctx-sep"></div>', `<div class="ctx-item" data-a="del"><span class="ci-ic">${MI.del}</span>Delete</div>`);
    const el = document.createElement('div');
    el.className = 'ctx-menu anchored recm';
    el.innerHTML = items.join('');
    appEl.append(el);
    menu = { el, rec: r };
    typeEl.classList.add('armed');
    const a = relRect(typeEl);
    el.style.top = `${a.bottom + 4}px`;
    el.style.left = `${Math.max(8, a.left - 8)}px`;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (!act) return;
      closeMenu();
      if (act === 'run') start(r);
      if (act === 'edit') beginEdit(r);
      if (act === 'untimer') removeTimer(r);
      if (act === 'del') deleteRec(r);
    });
  }
  function removeTimer(r) {
    if (live(r)) fold(r, 'pause');
    const sh = r.share;
    r.sec -= sh;
    r.share = 0;
    r.fed = false;
    r.state = null;
    S.order = S.order.filter((x) => x !== r);
    S.hist = S.hist.filter((x) => x !== r);
    log(`Remove timer — таймер снят с записи ${r.task} целиком: ${sh >= 60 ? `минус ${fmtHm(Math.floor(sh / 60))}, насчитанные им; ` : ''}осталось ${fmtOf(r)}, вбитое руками; строки в острове и ▶ у времени больше нет; отмены нет`);
    renderAll();
  }
  function deleteRec(r) {
    if (live(r)) fold(r, 'pause');
    S.recs = S.recs.filter((x) => x !== r);
    S.order = S.order.filter((x) => x !== r);
    const body = r.el.parentNode;
    r.el.remove();
    r.blk.dataset.base = String(+r.blk.dataset.base - r.sec0 / 60);
    S.cut += r.sec0;
    if (!$$(':scope > .wl, :scope > app-session-row', body).length) r.blk.remove();
    log(`Delete — запись ${r.task} удалена целиком (${fmtOf(r)})`);
    renderAll();
  }
  // the edit: a snapshot of the time; a changed time is the new base the timer counts on from
  function beginEdit(r) {
    if (S.editing) endEdit(false);
    S.editing = r;
    unOne(r.blk);
    r.snap = Math.floor(secOf(r) / 60);
    r.el.classList.add('tm-edit');
    if (r.kind === 'ent') {
      $('.c-ds', r.el).innerHTML = '<input class="ed-ds" spellcheck="false" autocomplete="off">';
      $('.ed-ds', r.el).value = r.desc;
    }
    const dur = $('.c-dur', r.el);
    dur.classList.remove('rt');
    dur.innerHTML = `<input class="ed-min" spellcheck="false" autocomplete="off" value="${fmtHm(r.snap)}"><button type="button" class="ed-save">Save</button>`;
    const min = $('.ed-min', r.el);
    $('.ed-save', r.el).addEventListener('click', () => endEdit(true));
    r.el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false); }
    };
    min.addEventListener('wheel', (e) => {
      e.preventDefault();
      min.value = fmtHm(Math.max(0, (parseMin(min.value) || 0) + (e.deltaY < 0 ? 15 : -15)));
    }, { passive: false });
    log(`Edit — в поле снимок времени записи: ${fmtHm(r.snap)}${r.state === 'run' ? '; таймер под ним идёт' : ''}`);
    min.focus();
    min.select();
  }
  function endEdit(save) {
    const r = S.editing;
    if (!r) return;
    if (save) {
      const inp = $('.ed-min', r.el);
      const min = parseMin(inp.value);
      if (min == null) { inp.classList.add('need'); return; }
      const dsI = $('.ed-ds', r.el);
      const desc = dsI ? dsI.value.trim() : r.desc;
      const timeCh = min !== r.snap;
      const descCh = desc !== r.desc;
      if (timeCh) {
        r.sec = min * 60;
        r.share = 0;
        if (r.state === 'run') r.runSince = simNow;
      }
      r.desc = desc;
      log(timeCh ? `Save — время записи ${r.task} выставлено руками: ${fmtHm(min)}${r.state === 'run' ? '; таймер считает дальше от него' : ''}`
        : descCh ? 'Save — поменяли только описание; время и таймер не тронуты' : 'Save — без изменений');
    } else log('правка записи отменена');
    r.el.onkeydown = null;
    S.editing = null;
    renderAll();
  }
  // the card's menu — the ticket key is its handle, as in the app (Add time · Open in browser · Delete)
  const cardTimer = (blk) => S.recs.find((x) => x.blk === blk && x.kind === 'man' && x.fed);
  function openBlkMenu(blk, keyEl) {
    closeMenu();
    const items = [`<div class="ctx-item" data-a="time"><span class="ci-ic">${MI.add}</span>Add time</div>`];
    // one bare timer per card: once it is there, its own ▶ / ⏸ is the control
    if (!cardTimer(blk)) items.push(`<div class="ctx-item" data-a="timer"><span class="ci-ic">${MI.timer}</span>New timer</div>`);
    items.push(`<div class="ctx-item" data-a="web"><span class="ci-ic">${MI.globe}</span>Open in browser</div>`, '<div class="ctx-sep"></div>',
      `<div class="ctx-item" data-a="kill"><span class="ci-ic">${MI.x}</span>${blk === hotBlk ? 'Stop and Delete' : 'Delete'}</div>`);
    const el = document.createElement('div');
    el.className = 'ctx-menu anchored recm';
    el.innerHTML = items.join('');
    appEl.append(el);
    menu = { el, rec: null, blk };
    keyEl.classList.add('armed');
    const a = relRect(keyEl);
    el.style.top = `${a.bottom + 4}px`;
    el.style.left = `${Math.max(8, a.left - 8)}px`;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (!act) return;
      closeMenu();
      const task = blk.dataset.task, title = $('.c-nm', blk).textContent.trim();
      if (act === 'timer') addCardTimer(blk, task, title);
      if (act === 'time') { openCloud('log'); showForm(task, title, {}); }
      if (act === 'web' || act === 'kill') log('этот пункт — из приложения, в макете он не работает');
    });
  }
  // New timer in the card's menu: a bare timer on the card's ticket — its manual added line ticks.
  // While the card's own session counts, the timer does not take the lead: it waits and fills the gaps.
  function addCardTimer(blk, task, title) {
    const r = bareRec(task, title);
    if (blk === hotBlk && sesTracking()) {
      r.fed = true;
      unOne(r.blk);
      r.state = 'wait';
      r.runSince = null;
      if (!S.order.includes(r)) S.order.push(r);
      touch(r);
      log(`New timer в меню карточки → на ${task} появился таймер (строка manual added). Сейчас считает сессия — таймер ждёт и пойдёт сам, когда она угаснет`);
      renderAll();
    } else {
      start(r);
      log(`New timer в меню карточки → на ${task} появился таймер (строка manual added) и сразу считает`);
    }
    land(r.el);
  }
  lpTable.addEventListener('click', (e) => {
    const key = e.target.closest('.blk-id .tkt');
    if (key) {
      const blk = key.closest('.blk');
      if (menu && menu.blk === blk) closeMenu(); else openBlkMenu(blk, key);
      return;
    }
    const b = e.target.closest('.rt-b');
    if (b) { toggle(byId(+(b.dataset.pz || b.dataset.go))); return; }
    const type = e.target.closest('.wl .c-type');
    const row = type && type.closest('.wl[data-rid]');
    if (!row) return;
    const r = byId(+row.dataset.rid);
    if (!r || S.editing === r) return;
    if (menu && menu.rec === r) closeMenu(); else openRecMenu(r, type);
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.el.contains(e.target) && !e.target.closest('.wl .c-type') && !e.target.closest('.blk-id .tkt')) closeMenu();
    if (S.open && !cloudState && wd.contains(e.target) && !panel.contains(e.target) && !zone.contains(e.target)) { S.open = false; renderChip(); renderIsland(); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu) closeMenu();
    else if (cloudState?.form) exitForm();
    else if (cloudState) closeCloud();
    else if (S.open) { S.open = false; renderChip(); renderIsland(); }
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
    s.innerHTML = `<span ${NGC} class="f-task">${task}</span><span ${NGC} class="f-name">${esc(name)}</span>`;
    return s;
  };
  const startChip = mkChip(PLAY, 'Start timer', 'tm-act go');
  const createChip = mkChip(PLUS, 'Create in Jira…', 'tm-act');
  const foot = document.createElement('div');
  foot.className = 'tmf';
  foot.append(startChip, createChip);
  $('.cloud-body', cloud).after(foot);
  const noneLbl = document.createElement('span');
  noneLbl.setAttribute(NGC, '');
  noneLbl.className = 'row-label jira';
  noneLbl.textContent = 'jira · nothing found';
  chips.append(noneLbl);
  let createdLbl = null;
  let cloudState = null; // { mode: 'log' | 'pick', t?, form? }

  function openCloud(mode, t = null) {
    closeMenu();
    exitForm(true);
    if (S.editing) endEdit(false);
    if (!onDay()) showView('day');
    cloudState = { mode, t };
    S.anchor = mode === 'pick' ? t : null;
    S.open = mode === 'pick';
    renderIsland();
    cloud.classList.add('open');
    cloud.classList.toggle('accept-mode', mode === 'pick');
    backdrop.classList.add('open');
    backdrop.style.top = `${hdr.offsetHeight}px`;
    batchBtn.style.display = mode === 'pick' ? 'none' : '';
    // the cloud hangs from the timer's row in the island, or from the day head
    cloud.style.top = `${Math.round(mode === 'pick' ? relRect(panel).bottom + 4 : relRect(dayHead).bottom - 4)}px`;
    cloudInput.value = '';
    cloudInput.placeholder = mode === 'pick' ? `ticket for «${t.desc || 'timer'}» · no match → search Jira` : origPlaceholder;
    filterChips();
    if (mode === 'pick') log(`task? — облако выбора тикета под строкой; таймер ${t.state === 'run' ? 'идёт дальше' : 'как стоял, так и стоит'}`);
    setTimeout(() => cloudInput.focus(), 40);
  }
  function closeCloud() {
    if (!cloudState) return;
    exitForm(true);
    cloud.classList.remove('open', 'accept-mode');
    backdrop.classList.remove('open');
    cloudState = null;
    if (S.anchor) { S.anchor = null; renderIsland(); }
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
    $('.f-name', createChip).textContent = raw ? `Create «${raw}» in Jira` : 'Create in Jira…';
    // Start timer «text» — only in + Log, only when there is a text to name the timer with
    startChip.classList.toggle('tm-hide', !raw || cloudState?.mode !== 'log');
    $('.f-name', startChip).textContent = `Start timer «${raw}»`;
  }
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.fav');
    if (!chip || !cloudState) return;
    const task = $('.f-task', chip).textContent.trim();
    const name = $('.f-name', chip).textContent.trim();
    const fav = !chip.classList.contains('jira');
    const act = fav ? (ACT_NAME[(chip.getAttribute('title') || '').split(' ·')[0]] || (chip.getAttribute('title') || 'Other').split(' ·')[0]) : 'Development';
    if (cloudState.mode === 'pick') {
      const t = cloudState.t;
      showForm(task, fav ? '' : name, { act, desc: t.desc || (fav ? name : ''), min: Math.floor(secOf(t) / 60) });
      return;
    }
    if (fav) {
      const min = parseMin($('.f-min', chip)?.textContent || '') || 15;
      closeCloud();
      const r = newRec(task, '', 'ent', act, name, min * 60);
      renderAll();
      land(r.el);
      log(`★ ${task} · ${esc(name)} · ${fmtHm(min)} — избранное, как сегодня`);
      return;
    }
    showForm(task, name, {});
  });
  createChip.addEventListener('click', () => {
    if (!cloudState) return;
    const summary = cloudInput.value.trim() || (cloudState.t && cloudState.t.desc) || 'New ticket';
    const key = `ATL-${nextKey++}`;
    for (const c of $$('.tm-new', chips)) c.classList.remove('tm-new');
    if (!createdLbl) { createdLbl = document.createElement('span'); createdLbl.setAttribute(NGC, ''); createdLbl.className = 'row-label jira'; createdLbl.textContent = 'jira · created just now'; chips.prepend(createdLbl); }
    createdLbl.after(mkChip(key, summary, 'jira mine tm-new'));
    cloudInput.value = '';
    filterChips();
    log(`Create in Jira → форма в браузере; в макете сразу создан ${key} «${esc(summary)}» — первым чипом`);
  });
  startChip.addEventListener('click', () => {
    const text = cloudInput.value.trim();
    if (!text || !cloudState) return;
    closeCloud();
    birth(text, true);
    log(`Start timer «${esc(text)}» — таймер без тикета с готовым описанием; он в острове`);
  });

  // the form: one Log; in pick mode the minutes and the description come from the timer
  function showForm(task, name, pre) {
    cloudState.form = { task, name, snap: pre.min ?? null };
    cloud.classList.add('form-mode');
    const N = NGC;
    const opts = ACTS.map((a) => `<option${a === pre.act ? ' selected' : ''}>${a}</option>`).join('');
    cloud.insertAdjacentHTML('beforeend', `<div ${N} class="cloud-form"><div ${N} class="cf-top"><span ${N} class="cf-key">${esc(task)}</span><span ${N} class="cf-name">${esc(name)}</span></div>`
      + `<div ${N} class="cf-ctl"><button ${N} type="button" class="cf-back">←</button><select ${N} class="cf-act">${opts}</select>`
      + `<input ${N} class="cf-min" placeholder="45m" value="${pre.min != null ? fmtHm(pre.min) : ''}"><input ${N} class="cf-desc" placeholder="description" value="${esc(pre.desc || '')}"><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
    const f = $('.cloud-form', cloud);
    $('.cf-back', f).addEventListener('click', () => exitForm());
    $('.cf-submit', f).addEventListener('click', submitForm);
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });
    f.addEventListener('wheel', (e) => {
      const inp = e.target.closest('.cf-min');
      if (!inp) return;
      e.preventDefault();
      inp.value = fmtHm(Math.max(0, (parseMin(inp.value) || 0) + (e.deltaY < 0 ? 15 : -15)));
    }, { passive: false });
    setTimeout(() => $(pre.min != null ? '.cf-desc' : '.cf-min', f).focus(), 40);
  }
  function exitForm(quiet = false) {
    $('.cloud-form', cloud)?.remove();
    cloud.classList.remove('form-mode');
    if (cloudState) cloudState.form = null;
    if (!quiet) setTimeout(() => cloudInput.focus(), 40);
  }
  function submitForm() {
    const f = $('.cloud-form', cloud);
    const { task, name, snap } = cloudState.form;
    const act = $('.cf-act', f).value;
    const min = parseMin($('.cf-min', f).value);
    const desc = $('.cf-desc', f).value.trim();
    const pick = cloudState.mode === 'pick';
    if (min == null || (!pick && !min)) { $('.cf-min', f).classList.add('need'); return; }
    if (act !== 'Development' && !desc) { $('.cf-desc', f).classList.add('need'); return; }
    if (pick) { bind(cloudState.t, task, name, act, desc, min, snap); return; }
    closeCloud();
    const bare = !desc && act === 'Development';
    const r = bare ? bareRec(task, name) : newRec(task, name, 'ent', act, desc, 0);
    r.sec += min * 60;
    renderAll();
    land(r.el);
    log(`Log → ${task} · ${act} · ${fmtHm(min)}${bare ? ' (manual added)' : ` · «${esc(desc)}»`}`);
  }
  // a ticket for the timer: its time becomes a record of the ticket's card; the timer's state stays as it was
  function bind(t, task, title, act, desc, min, snap) {
    const edited = min !== snap;
    const st = t.state;
    const sec = edited ? min * 60 : secOf(t);
    const at = S.order.indexOf(t);
    S.anon = S.anon.filter((x) => x !== t);
    closeCloud();
    const bare = !desc && act === 'Development';
    const r = bare ? bareRec(task, title) : newRec(task, title, 'ent', act, desc, 0);
    r.sec += sec;
    if (!edited) r.share += sec;
    r.fed = true;
    unOne(r.blk);
    if (!live(r)) { r.state = st; r.runSince = st === 'run' ? simNow : null; }
    if (S.order.includes(r)) S.order.splice(at, 1); else S.order[at] = r;
    S.hist = S.hist.map((x) => (x === t ? r : x));
    S.open = true;
    log(`task? → ${task}: ${fmtRun(sec)} теперь в ${bare ? 'manual added' : 'записи'} и в total${edited ? ' (минуты поправлены в форме)' : ''}; `
      + (st === 'run' ? 'таймер идёт дальше уже в записи' : st === 'wait' ? 'таймер ждёт, пока считает сессия' : 'таймер стоит — время окончательное'));
    renderAll();
    land(r.el);
  }

  // ── toolbar ──────────────────────────────────────────────────────
  function syncToolbar() {
    for (const b of $$('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === speed);
  }
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.speed) { speed = +b.dataset.speed; syncToolbar(); }
    if (b.dataset.act === 'edit1') editOnce();
    if (b.dataset.act === 'burst') editBurst();
    if (b.dataset.act === 'q15') quiet(15 * 60000, '15 минут');
    if (b.dataset.act === 'q5h') quiet(5 * 3600000, '5 часов');
    if (b.dataset.preset) preset(b.dataset.preset);
  });
  function reset() {
    closeMenu();
    closeCloud();
    Object.assign(S, { seq: 0, anon: [], recs: [], order: [], hist: [], pinned: false, open: false, anchor: null, editing: null, cut: 0, ses: newSes(24), ev: null });
    pendingBirth = null;
    simNow = DAY0;
    S.nextTick = simNow + TICK;
    nextKey = 7203;
    lpTable.replaceChildren(...feedOrig.cloneNode(true).childNodes);
    initFeed();
    for (const c of $$('.fav.jira.mine', chips)) if (/^ATL-72\d\d$/.test($('.f-task', c).textContent)) c.remove();
    if (createdLbl) { createdLbl.remove(); createdLbl = null; }
    showView('day');
    content.scrollTop = 0;
    evlog.innerHTML = '';
  }
  function preset(name) {
    reset();
    const anon = (desc, sec, state) => {
      const t = { id: ++S.seq, desc, sec, runSince: state === 'run' ? simNow : null, state };
      S.anon.push(t);
      S.order.push(t);
      return t;
    };
    const feed = (r, share, state) => {
      r.fed = true;
      r.share = share;
      r.state = state;
      r.runSince = state === 'run' ? simNow : null;
      unOne(r.blk);
      S.order.push(r);
      return r;
    };
    if (name === 'one') {
      touch(anon('разбор 500-х на checkout', 47 * 60 + 15, 'run'));
      S.ses.score = 16;
      S.ses.endAt = simNow - (47 * 60 + 15) * 1000; // superseded when the timer was started
      S.open = true;
      log('сцена: таймер идёт поверх живой сессии — она вытеснена, её стамина (8m) тает в фоне. ⏸ сейчас — сессия снова считает; ⏸ после «15 минут» тишины — уже нет');
    }
    if (name === 'all') {
      const sec = 48 * 60 + 2;
      touch(feed(newRec('ATL-6781', '', 'ent', 'Meeting', 'созвон по инциденту с командой платежей', sec), sec, 'run'));
      anon('помог соседней команде с деплоем', 12 * 60 + 40, 'pause');
      anon('', 3 * 60 + 5, 'pause');
      const old = S.recs.find((x) => x.task === 'ATL-6712' && x.kind === 'ent');
      if (old) feed(old, 20 * 60, 'pause');
      S.ses.score = 0;
      S.ses.endAt = simNow - (48 * 60 + 2) * 1000;
      S.open = true;
      log('сцена: все таймеры дня — идёт запись ATL-6781, два таймера без тикета на паузе, запись ATL-6712 на паузе; стамина сессии уже вышла');
    }
    if (name === 'base') {
      touch(feed(newRec('ATL-6781', '', 'ent', 'Code Review', 'ревью платёжного модуля', 2 * 3600 + 47 * 60 + 15), 47 * 60 + 15, 'run'));
      S.ses.score = 16;
      S.ses.endAt = simNow - (47 * 60 + 15) * 1000;
      log('сцена: в записи было 2h руками, потом по ней пустили таймер — клик по слову Code Review → Remove timer −47m');
    }
    if (name === 'empty') log('сцена: пусто — в шапке «Timer»; клик открывает остров: No timers и New timer');
    renderAll();
  }

  // ── render + tick ────────────────────────────────────────────────
  function renderAll() {
    syncSession();
    for (const r of S.recs) paintRec(r);
    for (const blk of $$('.blk', lpTable)) paintBlk(blk);
    paintTotal();
    renderChip();
    renderIsland();
    renderWidget();
    syncToolbar();
    paintLine();
  }
  function tick() {
    const nowReal = performance.now();
    const before = sig();
    advance((nowReal - lastReal) * speed);
    lastReal = nowReal;
    if (sig() !== before) renderAll();
    paintLine();
    for (const el of $$('[data-t]')) {
      const x = byId(+el.dataset.t);
      if (!x) continue;
      const s = fmtOf(x);
      if (el.textContent === s) continue;
      el.textContent = s;
      if (el.classList.contains('tchip-time')) el.style.width = `${s.length}ch`;
    }
    paintSes();
    for (const blk of $$('.blk', lpTable)) paintBlk(blk);
    paintTotal();
  }
  setInterval(tick, 200);

  preset('empty');
  log('макет готов — клик по «Timer» в шапке или по ключу ATL-6781 → New timer');
})();
