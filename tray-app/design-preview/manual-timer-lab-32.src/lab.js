(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ngOf = (el) => [...el.attributes].find((a) => a.name.startsWith('_ngcontent')).name;

  // ── glyphs (own SVG — no SF Symbols) ─────────────────────────────
  // the timer icon: a ring + a hand to 12; paused — two bars inside the ring
  const ic = (st) => `<svg class="t-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/>${
    st === 'pause' ? '<path d="M5.7 5.1v3.8M8.3 5.1v3.8"/>' : '<path d="M7 7V3.8"/>'}</svg>`;
  const PLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.8 1.5l5.6 3.5-5.6 3.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.3 2.2v5.6M6.7 2.2v5.6"/></svg>';
  const PLUS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';
  const MI = {
    pause: '<svg viewBox="0 0 12 12"><path d="M4 2.5v7M8 2.5v7"/></svg>',
    edit: '<svg viewBox="0 0 12 12"><path d="M2 10l.6-2.4L8 2.2l1.8 1.8-5.4 5.4z"/></svg>',
    del: '<svg viewBox="0 0 12 12"><path d="M2.5 3.5h7M4.8 3.5V2.3h2.4v1.2M3.5 3.5l.5 6.2h4l.5-6.2"/></svg>',
    untime: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2"/><path d="M6 6V3.6M2.3 9.7l7.4-7.4"/></svg>',
  };

  const T1 = { desc: 'созвон по инциденту с командой платежей', time: '47m 15s', since: '10:12', till: '10:59' };
  const TL = { desc: 'разбор 500-х на checkout после выкладки платёжного шлюза', time: '47m 15s', since: '10:12', till: '10:59' };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s', since: '11:20', till: '11:33' };
  const T3 = { desc: '', time: '3m 05s', since: '11:40', till: '11:43' };
  const K1 = { desc: 'code review', time: '1h 20m', key: 'ATL-6712' };
  const K2 = { desc: 'стенд для демо', time: '25m', key: 'ATL-7002' };
  const TICKET = { key: 'ATL-6781', name: 'Daily standup and team sync' };
  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height, o = {}) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, hdr: $('.header', app), head: $('.day-head', app), date: $('.day-date', app), logBtn: $('.g-btn', app), total: $('.day-total', app),
      cloud: $('app-log-cloud', app), backdrop: $('.cloud-backdrop', app) };
    x.NL = ngOf($('.btn-log', app));
    const N = ngOf(x.hdr);
    x.hdr.insertAdjacentHTML('beforeend', `<div ${N} class="win-controls"><button ${N} class="wc-btn" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1 5.5h8"/></svg></button><button ${N} class="wc-btn wc-close" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
    x.wc = $('.win-controls', x.hdr);
    if (o.sheet) {
      const day = $('app-day-view', app);
      day.style.display = 'none';
      day.after($('#tpl-sheet').content.firstElementChild.cloneNode(true));
      const tabs = $$('.view-btn', x.hdr);
      tabs[0].classList.remove('active');
      tabs[1].classList.add('active');
      x.sheet = true;
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

  // ── the timer in the header: idle (the icon and the word in the chip's outline) | run | pause ──
  function timer(x, st, t) {
    const el = st === 'idle' ? `<span class="tchip ghost">${ic('idle')}Timer</span>`
      : `<span class="tchip ${st}">${ic(st)}<b class="tchip-time" style="width:${t.time.length}ch">${t.time}</b></span>`;
    x.wc.insertAdjacentHTML('beforebegin', `<span class="tmz">${el}</span>`);
    x.chip = $('.tmz > *', x.hdr);
    if (st === 'run') sessionsPaused(x);
  }

  // ── the island ───────────────────────────────────────────────────
  // rows: [{ t, st: run | pause, focus, armed }] — t.key marks a timer that has a ticket
  // o.pos: a | b | c | var (follows the toolbar) · o.grey — task? as on a suggestion card · o.meta — start time on the second floor
  let curPos = 'a';
  function panel(x, rows, o = {}) {
    const html = rows.map((r) => {
      const run = r.st === 'run';
      const btn = `<button type="button" class="tbtn ${run ? 'pz' : 'go'}">${run ? PAUSE : PLAY}</button>`;
      const time = `<b class="ttime">${r.t.time}</b>`;
      if (r.t.key) return `<div class="trow tk ${r.st}">${btn}<span class="tkey">${r.t.key}</span><span class="tfield">${esc(r.t.desc)}</span>${time}</div>`;
      const field = r.focus ? '<span class="tfield focus"><i class="caret"></i><span class="ph">description</span></span>'
        : r.t.desc ? `<span class="tfield">${esc(r.t.desc)}</span>` : '<span class="tfield"><span class="ph">description</span></span>';
      const chip = `<button ${x.NL} type="button" class="chip ask tq${r.armed ? ' armed' : ''}">task?</button>`;
      const meta = o.meta ? `<span class="tmeta">${r.t.since}–${run ? 'now' : r.t.till}</span>` : '';
      return `<div class="trow an ${r.st}">${btn}${chip}${field}${time}${meta}<button ${x.NL} type="button" class="lnk-deny tdel">Delete</button></div>`;
    }).join('');
    const nt = o.newTimer === false ? '' : `${rows.length ? '<div class="tsep"></div>' : ''}<div class="tnew"><span class="nt-g">${PLAY}</span><span>New timer</span></div>`;
    x.app.insertAdjacentHTML('beforeend', `<div class="tpanel${o.grey ? '' : ' tq-or'}">${html}${nt}</div>`);
    x.panel = x.app.lastElementChild;
    const pos = o.pos || 'var';
    if (pos === 'var') x.panel.dataset.pv = '1';
    paint(x.panel, pos === 'var' ? curPos : pos);
  }
  function paint(p, pos) {
    for (const c of ['a', 'b', 'c']) p.classList.toggle(`pos-${c}`, c === pos);
  }

  // ── a record of the ticket card: o.live — a timer feeds it, o.rest — its timer is paused ──
  function addRec(x, o) {
    const blk = $('.blk.hot', x.app);
    const src = $('.wl.ent', blk);
    const el = src.cloneNode(true);
    $('.c-type', el).textContent = o.type;
    $('.c-ds', el).textContent = o.desc;
    const dur = $('.c-dur', el);
    if (o.live || o.rest) {
      dur.classList.add('rt');
      dur.innerHTML = `<i class="rt-b ${o.live ? 'run' : 'rest'}">${o.live ? PAUSE : PLAY}</i><span>${o.dur}</span>`;
    } else dur.textContent = o.dur;
    if (o.live) el.classList.add('tm-live');
    src.parentNode.append(el);
    $('.sum', blk).textContent = o.sum;
    x.total.textContent = o.total;
    x.rec = el;
  }
  // the record's menu, opened by a click on the word of its type
  function recMenu(x, items) {
    const type = $('.c-type', x.rec);
    type.classList.add('armed');
    const html = items.map((it) => it === '-' ? '<div class="ctx-sep"></div>'
      : `<div class="ctx-item${it.now ? ' now' : ''}"><span class="ci-ic">${it.ic}</span>${it.label}${it.n ? `<span class="ci-n">${it.n}</span>` : ''}</div>`).join('');
    x.app.insertAdjacentHTML('beforeend', `<div class="ctx-menu anchored recm">${html}</div>`);
    x.menu = x.app.lastElementChild;
  }

  // ── the cloud: pick a ticket, then the form with one Log ─────────
  function openCloud(x) {
    x.NGC = ngOf($('.fav', x.cloud));
    x.app.append(x.backdrop, x.cloud);
    x.cloud.classList.add('open', 'accept-mode');
    x.backdrop.classList.add('open');
    $('.f-batch', x.cloud).remove();
  }
  function cloudPick(x, desc) {
    openCloud(x);
    $('.cloud-filter input', x.cloud).setAttribute('placeholder', `ticket for «${desc}» · no match → search Jira`);
    $('.cloud-body', x.cloud).insertAdjacentHTML('afterend', `<div class="tmf"><span ${x.NGC} class="fav tm-act"><span ${x.NGC} class="f-task">${PLUS}</span><span ${x.NGC} class="f-name">Create in Jira…</span></span></div>`);
  }
  function cloudForm(x, o) {
    openCloud(x);
    x.cloud.classList.add('form-mode');
    const N = x.NGC;
    const opts = ACTS.map((a) => `<option${a === o.act ? ' selected' : ''}>${a}</option>`).join('');
    x.cloud.insertAdjacentHTML('beforeend', `<div ${N} class="cloud-form"><div ${N} class="cf-top"><span ${N} class="cf-key">${TICKET.key}</span><span ${N} class="cf-name">${esc(TICKET.name)}</span></div>`
      + `<div ${N} class="cf-ctl"><button ${N} type="button" class="cf-back">←</button><select ${N} class="cf-act">${opts}</select>`
      + `<input ${N} class="cf-min" value="${o.min}"><input ${N} class="cf-desc" value="${esc(o.desc)}"><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
  }

  function offsetIn(el, root) {
    let left = 0, top = 0;
    for (let n = el; n && n !== root; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  }
  // the cloud hangs from the island's row; the record's menu hangs from the word of its type
  function place(x) {
    if (x.cloud.classList.contains('open')) {
      const top = x.panel ? x.panel.offsetTop + x.panel.offsetHeight + 4 : offsetIn(x.head, x.app).bottom - 4;
      x.cloud.style.top = `${top}px`;
      x.backdrop.style.top = `${x.hdr.offsetHeight}px`;
    }
    if (x.menu) {
      const a = offsetIn($('.c-type', x.rec), x.app);
      x.menu.style.top = `${a.bottom + 4}px`;
      x.menu.style.left = `${Math.max(8, a.left - 8)}px`;
    }
  }

  // ── the grid ─────────────────────────────────────────────────────
  const grid = $('#grid');
  const cells = [];
  const M = {};
  function section(title, note) {
    grid.insertAdjacentHTML('beforeend', `<h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}<div class="row"></div>`);
    return grid.lastElementChild;
  }
  function cell(row, x, cap, key) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.append(x.cv);
    c.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`);
    row.append(c);
    cells.push(x);
    if (key) M[key] = x;
  }
  const HEAD = 84; // the header (29) + the day head (48) + a strip of the feed

  // 1 ─ accepted: the header
  const s1 = section('1 · Принято: шапка', 'Три состояния одного элемента слева от кнопок окна.');
  for (const [key, st, cap] of [
    ['idle', 'idle', '<b>Покой · значок + Timer</b><br>контур будущего чипа'],
    ['run', 'run', '<b>Идёт · Ч1</b><br>контур залит #11111b, значок и время оранжевые'],
    ['pause', 'pause', '<b>Пауза · П1</b><br>значок и время серые'],
  ]) {
    const x = mkCell(HEAD);
    timer(x, st, T1);
    cell(s1, x, cap, key);
  }

  // 2 ─ the row of a timer without a ticket: a suggestion card's layout
  const s2 = section('2 · Строка таймера без тикета: компоновка карточки подсказки — где стоит ▶ / ⏸',
    'Первая строка — как у подсказки: чип <b>task?</b>, описание, время справа. Вторая — действия: справа тихое слово <b>Delete</b> на месте Deny. Строка всегда в два этажа; пустое описание держит слово-поле description. Строка таймера с тикетом — в один этаж: ⏸/▶ · ключ · описание · время. В каждом кадре список из трёх: идёт с длинным описанием, пауза без описания, пауза с тикетом.');
  const MIX = [{ t: TL, st: 'run' }, { t: T3, st: 'pause' }, { t: K1, st: 'pause' }];
  for (const [pos, cap] of [
    ['a', '<b>А · ▶ / ⏸ в первой строке</b><br>кнопки и чипы стоят двумя ровными колонками во всех строках; левая половина второго этажа пустая'],
    ['b', '<b>Б · ▶ / ⏸ по центру двух этажей</b><br>те же две колонки, кнопка висит между строками'],
    ['c', '<b>В · ▶ / ⏸ во второй строке</b><br>у обоих этажей есть левый и правый якорь, описание длиннее; но чип и ключ тикета стоят на разных вертикалях'],
  ]) {
    const x = mkCell(238);
    timer(x, 'run', TL);
    panel(x, MIX, { pos });
    cell(s2, x, cap, pos);
  }
  {
    const x = mkCell(238);
    timer(x, 'run', TL);
    panel(x, MIX, { pos: 'a', meta: true });
    cell(s2, x, '<b>Идея к А и Б: время старта на втором этаже</b><br>слева, где у подсказки «когда»: 10:12–now, как у сессий; пустоты не остаётся', 'meta');
  }
  {
    const x = mkCell(238);
    timer(x, 'run', { time: '0m 04s' });
    panel(x, [{ t: { desc: '', time: '0m 04s', since: '11:58' }, st: 'run', focus: true }, { t: T2, st: 'pause' }]);
    cell(s2, x, '<b>Сразу после рождения</b><br>курсор стоит в описании; Enter или клик мимо — готово, Esc с пустым полем — передумал', 'born');
  }
  {
    const x = mkCell(238);
    timer(x, 'run', TL);
    panel(x, MIX, { grey: true });
    cell(s2, x, '<b>Для сверки: task? серым, как у подсказки</b><br>тот же чип без перекраски — теряется среди серого текста строки', 'grey');
  }

  // 3 ─ task?: the ticket is chosen, the timer's state stays
  const s3 = section('3 · task? — тикет выбран, состояние таймера не меняется',
    'task? открывает то же облако выбора тикета, что и у подсказки; остров сжимается до строки-якоря. Нажатие таймер не останавливает: шёл — идёт дальше уже в записи тикета, стоял — остаётся стоять. «Закончил — записываю» = сначала ⏸, потом task?. После Log строка остаётся в острове: в слоте task? встаёт ключ, Delete уходит.');
  {
    const x = mkCell(424);
    timer(x, 'run', T1);
    panel(x, [{ t: T1, st: 'run', armed: true }], { newTimer: false });
    cloudPick(x, T1.desc);
    cell(s3, x, '<b>1 · task? → облако под строкой</b><br>таймер идёт (время и чип оранжевые); в поиске «ticket for …»; внизу Create in Jira…', 'pick');
  }
  {
    const x = mkCell(424);
    timer(x, 'run', T1);
    panel(x, [{ t: T1, st: 'run', armed: true }], { newTimer: false });
    cloudForm(x, { act: 'Meeting', min: '47m', desc: T1.desc });
    cell(s3, x, '<b>2 · Форма</b><br>тип активности · минуты из таймера (правятся) · описание из таймера · одна кнопка Log', 'form');
  }
  {
    const x = mkCell(262);
    timer(x, 'run', { time: '47m 31s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m 31s', live: true, sum: '6h 21m', total: '13h 18m' });
    panel(x, [{ t: { desc: T1.desc, time: '47m 31s', key: TICKET.key }, st: 'run' }, { t: T3, st: 'pause' }]);
    cell(s3, x, '<b>3 · Итог: таймер шёл</b><br>в острове та же строка, теперь с ключом и в один этаж; в карточке появилась запись, и время тикает в ней', 'res-run');
  }
  {
    const x = mkCell(262);
    timer(x, 'pause', { time: '47m' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', rest: true, sum: '6h 21m', total: '13h 18m' });
    panel(x, [{ t: { desc: T1.desc, time: '47m', key: TICKET.key }, st: 'pause' }, { t: T3, st: 'pause' }]);
    cell(s3, x, '<b>3′ · Итог: таймер стоял на паузе</b> (сначала ⏸, потом task?)<br>запись с окончательным временем; ▶ в строке или у записи продолжит счёт', 'res-pause');
  }

  // 4 ─ the record a timer feeds, and the timer's share of its time
  const s4 = section('4 · Запись в карточке и доля таймера',
    'Запись, которую кормит таймер: оранжевое время с секундами и ⏸ рядом, без подложки; секунды остаются и после часа. На экране одно число — всё время записи. Сколько из него насчитал таймер, знают только данные и один пункт меню записи.');
  {
    const x = mkCell(238);
    timer(x, 'run', T1);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m 15s', live: true, sum: '6h 21m', total: '13h 18m' });
    cell(s4, x, '<b>Идёт</b><br>⏸ и время оранжевые; клик по ⏸ ставит паузу', 'k1');
  }
  {
    const x = mkCell(238);
    timer(x, 'run', { time: '1h 02m 15s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '1h 02m 15s', live: true, sum: '6h 36m', total: '13h 33m' });
    cell(s4, x, '<b>Больше часа</b><br>секунды остаются — так заметнее; колонка времени шире, колонки сессий над записью сжимаются', 'long');
  }
  {
    const x = mkCell(238);
    timer(x, 'pause', { time: '47m' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', rest: true, sum: '6h 21m', total: '13h 18m' });
    cell(s4, x, '<b>Пауза</b><br>обычное время без секунд; рядом тихий ▶ — продолжить с этой же записи', 'rest');
  }
  {
    const x = mkCell(356);
    timer(x, 'run', { time: '2h 47m 15s' });
    addRec(x, { type: 'Code Review', desc: 'ревью платёжного модуля', dur: '2h 47m 15s', live: true, sum: '8h 21m', total: '15h 18m' });
    recMenu(x, [
      { ic: MI.pause, label: 'Pause timer' },
      { ic: MI.edit, label: 'Edit' },
      { ic: MI.untime, label: 'Remove timer time', n: '47m', now: true },
      '-',
      { ic: MI.del, label: 'Delete' },
    ]);
    cell(s4, x, '<b>Меню записи: Remove timer time</b><br>в записи было 2h руками, потом по ней пустили таймер. Пункт снимает ровно то, что насчитал таймер (47m), и останавливает его; Delete удаляет запись целиком', 'menu');
  }

  // 5 ─ every timer of the day lives in the island
  const s5 = section('5 · Остров: все таймеры дня',
    'Таймеры без тикета — в два этажа, с task? и Delete. Записи, которые сегодня кормил таймер, — в один этаж, без действий: их время удаляется в карточке. Чип в шапке показывает идущий таймер с любой вкладки. Список сам очищается со сменой дня.');
  const ALL = [{ t: { desc: T1.desc, time: '48m 02s', key: TICKET.key }, st: 'run' }, { t: T2, st: 'pause' }, { t: T3, st: 'pause' }, { t: K1, st: 'pause' }, { t: K2, st: 'pause' }];
  {
    const x = mkCell(322);
    timer(x, 'run', { time: '48m 02s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '48m 02s', live: true, sum: '6h 22m', total: '13h 19m' });
    panel(x, ALL);
    cell(s5, x, '<b>Вкладка Day</b><br>идёт таймер с тикетом, два без тикета на паузе, два с тикетом на паузе', 'all');
  }
  {
    const x = mkCell(322, { sheet: true });
    timer(x, 'run', { time: '48m 02s' });
    panel(x, ALL);
    cell(s5, x, '<b>Вкладка Timesheets</b><br>тот же чип и тот же остров; task? отсюда сначала переключит на Day — облако живёт там', 'sheet');
  }

  // ── measurements, straight from the cells ────────────────────────
  function measure() {
    const z = +getComputedStyle(document.documentElement).getPropertyValue('--z') || 1;
    const rr = (v) => Math.round(v * 10) / 10;
    const w = (el) => rr(el.getBoundingClientRect().width / z);
    const h = (el) => rr(el.getBoundingClientRect().height / z);
    const ty = (x, el) => rr((el.getBoundingClientRect().top - x.cv.getBoundingClientRect().top) / z - 1);
    const by = (x, el) => rr((el.getBoundingClientRect().bottom - x.cv.getBoundingClientRect().top) / z - 1);
    const probe = document.createElement('span');
    probe.className = 'probe';
    probe.textContent = '0000000000';
    M.idle.hdr.append(probe);
    const ch = probe.getBoundingClientRect().width / z / 10;
    probe.remove();
    const heads = cells.filter((x) => !x.sheet).map((x) => h(x.head));
    const wh = (el) => `${w(el)} × ${h(el)}px`;
    const row = (k) => {
      const p = M[k].panel;
      const an = $('.trow.an', p);
      const f = $('.tfield', an);
      return `${w(f)}px ≈ ${Math.floor(w(f) / ch)} зн. · строка ${h(an)}px, с тикетом ${h($('.trow.tk', p))}px · панель ${h(p)}px`;
    };
    const dur = (k) => `${w($('.c-dur', M[k].rec))}px · описанию ${w($('.c-ds', M[k].rec))}px`;
    const out = [];
    const g = (title, rows) => out.push({ title, rows });
    g('Окно и шапка', [
      ['ширина окна', `${w(M.idle.app)}px`],
      ['шапка приложения / шапка Day', `${h(M.idle.hdr)}px / ${Math.min(...heads) === Math.max(...heads) ? heads[0] : `${Math.min(...heads)}–${Math.max(...heads)}`}px (кадров: ${heads.length})`],
      ['покой «значок + Timer»', wh(M.idle.chip)],
      ['чип «47m 15s»', wh(M.run.chip)],
      ['чип task? в острове', wh($('.tq', M.a.panel))],
    ]);
    g('Строка таймера без тикета: поле описания · высота строк · высота панели (три таймера + New timer)', [
      ['А · ▶ / ⏸ в первой строке', row('a')],
      ['Б · ▶ / ⏸ по центру', row('b')],
      ['В · ▶ / ⏸ во второй строке', row('c')],
    ]);
    g('Запись в карточке: ширина колонки времени · сколько остаётся описанию', [
      ['обычная запись «15m»', `${w($('.blk.hot .wl.ent .c-dur', M.idle.app))}px · описанию ${w($('.blk.hot .wl.ent .c-ds', M.idle.app))}px`],
      ['«⏸ 47m 15s»', dur('k1')],
      ['«⏸ 1h 02m 15s»', dur('long')],
      ['«⏸ 2h 47m 15s»', dur('menu')],
      ['пауза «▶ 47m»', dur('rest')],
    ]);
    g('task? и остров', [
      ['строка-якорь: низ острова / верх облака', `${by(M.pick, M.pick.panel)}px / ${ty(M.pick, M.pick.cloud)}px`],
      ['все таймеры дня: панель из пяти строк + New timer', `${h(M.all.panel)}px`],
    ]);
    return out;
  }
  function renderMeasure() {
    const m = measure();
    $('#meas').innerHTML = m.map((gr) => `<span class="mh">${gr.title}</span>${gr.rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}`).join('');
    window.__meas = m;
  }

  const refresh = () => { for (const x of cells) place(x); renderMeasure(); };
  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
    refresh();
  };
  const setPos = (p) => {
    curPos = p;
    for (const b of $$('[data-p]')) b.classList.toggle('on', b.dataset.p === p);
    for (const el of $$('.tpanel[data-pv]')) paint(el, p);
    refresh();
  };
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('.tbb');
    if (!b) return;
    if (b.dataset.z) setZoom(b.dataset.z);
    if (b.dataset.p) setPos(b.dataset.p);
  });
  setZoom('1');
  document.fonts?.ready.then(() => renderMeasure());
})();
