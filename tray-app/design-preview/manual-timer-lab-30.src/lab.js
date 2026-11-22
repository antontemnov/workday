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
  const X = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6"/></svg>';
  const OK = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.3l2.1 2.1L8 2.9"/></svg>';
  const PLUS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';

  const T1 = { desc: 'созвон по инциденту', time: '47m 15s' };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s' };
  const TL = { desc: 'разбор 500-х на checkout после выкладки платёжного шлюза', time: '47m 15s' };
  const K1 = { desc: 'code review', time: '1h 20m', key: 'ATL-6712' };
  const K2 = { desc: 'стенд для демо', time: '25m 10s', key: 'ATL-7002' };
  const TICKET = { key: 'ATL-6781', name: 'Daily standup and team sync' };
  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height, cls = '') {
    const cv = document.createElement('div');
    cv.className = `cv ${cls}`;
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, hdr: $('.header', app), head: $('.day-head', app), date: $('.day-date', app), logBtn: $('.g-btn', app), total: $('.day-total', app),
      cloud: $('app-log-cloud', app), backdrop: $('.cloud-backdrop', app) };
    const N = ngOf(x.hdr);
    x.hdr.insertAdjacentHTML('beforeend', `<div ${N} class="win-controls"><button ${N} class="wc-btn" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1 5.5h8"/></svg></button><button ${N} class="wc-btn wc-close" type="button"><svg ${N} viewBox="0 0 10 10"><path ${N} d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4"/></svg></button></div>`);
    x.wc = $('.win-controls', x.hdr);
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

  // ── the timer in the header: idle (the chip's outline) | run | pause ──
  function timer(x, st, t, o = {}) {
    const el = st === 'idle' ? `<span class="tchip ghost">${ic(st)}</span>`
      : `<span class="tchip ${st}${st === 'pause' && !o.grey ? ' dim' : ''}">${ic(st)}<b class="tchip-time" style="width:${t.time.length}ch">${t.time}</b></span>`;
    x.wc.insertAdjacentHTML('beforebegin', `<span class="tmz">${el}</span>`);
    x.chip = $('.tchip', x.hdr);
    if (st === 'run' || o.feeding) sessionsPaused(x);
  }

  // ── the island ───────────────────────────────────────────────────
  // rows: [{ t, st: run | pause, focus, armed }] — t.key marks a timer with a ticket
  // o.mat: m1 | m2 | var (follows the toolbar) · o.w: w23 | w12 · o.one — one floor · o.newTimer
  function panel(x, rows, o = {}) {
    const two = !o.one;
    const html = rows.map((r) => {
      const btn = r.st === 'run' ? `<button type="button" class="tbtn pz">${PAUSE}</button>` : `<button type="button" class="tbtn go">${PLAY}</button>`;
      const time = `<b class="ttime">${r.t.time}</b>`;
      const field = r.focus ? '<span class="tfield focus"><i class="caret"></i><span class="ph">description</span></span>' : `<span class="tfield">${esc(r.t.desc)}</span>`;
      const act = r.t.key ? `<span class="tkey">${r.t.key}</span>` : `<button type="button" class="tlog${r.armed ? ' armed' : ''}">Log…</button>`;
      const end = `<button type="button" class="tx">${r.t.key ? OK : X}</button>`;
      return `<div class="trow${two ? ' two' : ''} ${r.st}">${btn}${time}${two ? act + end + field : field + act + end}</div>`;
    }).join('');
    const nt = o.newTimer === false ? '' : `<div class="tsep"></div><div class="tnew"><span class="nt-g">${PLAY}</span><span>New timer</span></div>`;
    x.app.insertAdjacentHTML('beforeend', `<div class="tpanel ${o.w || 'w23'}">${html}${nt}</div>`);
    x.panel = x.app.lastElementChild;
    const mat = o.mat || 'var';
    if (mat === 'var') x.panel.dataset.mv = '1';
    paintMat(x.panel, mat === 'var' ? curMat : mat);
    if (o.dim) { x.backdrop.classList.add('open'); x.backdrop.style.top = '29px'; x.app.append(x.backdrop); }
  }
  let curMat = 'm2';
  function paintMat(p, m) {
    p.classList.toggle('m1', m === 'm1');
    for (const c of ['m2', 'ctx-menu', 'anchored', 'right']) p.classList.toggle(c, m === 'm2');
  }

  // ── a record in the ticket card the timer wrote into ─────────────
  function addRec(x, o) {
    const blk = $('.blk.hot', x.app);
    const src = $('.wl.ent', blk);
    const el = src.cloneNode(true);
    $('.c-type', el).textContent = o.type;
    $('.c-ds', el).innerHTML = `${esc(o.desc)}${o.live ? `<span class="tmk run">${PAUSE}</span>` : `<span class="tmk">${ic('idle')}</span>`}`;
    $('.c-dur', el).textContent = o.dur;
    el.classList.add('tm-new');
    if (o.live) el.classList.add('tm-live');
    src.parentNode.append(el);
    $('.sum', blk).textContent = o.sum;
    x.total.textContent = o.total;
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
      + `<input ${N} class="cf-min" value="${o.min}"><button type="button" class="cf-tm${o.timer ? ' on' : ''}">${ic('idle')}timer</button>`
      + `<input ${N} class="cf-desc" value="${esc(o.desc)}"><button ${N} type="button" class="cf-submit">Log</button></div></div>`);
  }

  function offsetIn(el, root) {
    let left = 0, top = 0;
    for (let n = el; n && n !== root; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  }
  function place(x) {
    if (x.cloud.classList.contains('open')) {
      x.cloud.style.top = `${offsetIn(x.head, x.app).bottom - 4}px`;
      x.backdrop.style.top = `${x.hdr.offsetHeight}px`;
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

  // 1 ─ the chip
  const s1 = section('1 · Чип в шапке: фон и пауза',
    'Вкладки снова иконками, описания в шапке нет. В покое — контур чипа (Б2). Чёрный фон v29 был слишком сильным акцентом: <b>Ч1</b> — #11111b, самый тёмный тон палитры (им залиты поля форм); <b>Ч2</b> — плоский оранжевый оттенок, как у остальных чипов приложения. Пауза одна на все случаи, без красных полосок: <b>П1</b> — серая, <b>П2</b> — приглушённый оранжевый.');
  for (const [key, cls, st, o, cap] of [
    ['idle', '', 'idle', {}, '<b>Покой</b><br>контур будущего чипа; клик = таймер идёт с клика'],
    ['ch0', 'ch0', 'run', {}, '<b>Ч0 · чёрный</b> (v29, контроль)<br>#0b0b11 — самый контрастный объект окна'],
    ['ch1', '', 'run', {}, '<b>Ч1 · #11111b</b><br>контур залился тёмным тоном палитры; акцент — только значок и время'],
    ['ch2', 'ch2', 'run', {}, '<b>Ч2 · оранжевый оттенок</b><br>13 % цвета таймера, без тёмной подложки'],
    ['p1', '', 'pause', { grey: true }, '<b>П1 · пауза серая</b> (Ч1)<br>значок и время гаснут в серый — акцента нет'],
    ['p2', '', 'pause', {}, '<b>П2 · пауза приглушённым оранжевым</b> (Ч1)<br>тот же цвет вполсилы — видно, что это таймер и что он стоит'],
    ['p2c', 'ch2', 'pause', {}, '<b>П2 на Ч2</b><br>оттенок и текст слабеют вместе'],
  ]) {
    const x = mkCell(HEAD, cls);
    timer(x, st, T1, o);
    cell(s1, x, cap, key);
  }

  // 2 ─ the panel: material, width, dimming
  const s2 = section('2 · Панель-остров: материал, ширина, затемнение',
    'Панель висит у правого края окна под чипом и кнопками окна. Дата слева остаётся целой при любой ширине; + Log и total закрываются всегда (панель должна быть уже 162px, чтобы их не задеть). <b>М1</b> — сама шапка стекает вниз: её фон и её линия, скруглённый стык. <b>М2</b> — матовое стекло: материал меню карточек, поповер с зазором под шапкой; лента под ним читается размытой.');
  const ONE = [{ t: T1, st: 'run' }];
  for (const [key, o, cap] of [
    ['m1w23', { mat: 'm1', w: 'w23' }, '<b>М1 · продолжение шапки · 2/3 окна</b><br>панель и шапка — одно тело; чёрного объекта в окне нет'],
    ['m2w23', { mat: 'm2', w: 'w23' }, '<b>М2 · матовое стекло · 2/3 окна</b><br>язык меню карточек; total и + Log просвечивают размытыми'],
    ['m1w12', { mat: 'm1', w: 'w12' }, '<b>М1 · половина окна</b><br>уже, но + Log и total всё равно под панелью; описанию теснее'],
    ['m2w12', { mat: 'm2', w: 'w12' }, '<b>М2 · половина окна</b>'],
    ['m1dim', { mat: 'm1', w: 'w23', dim: true }, '<b>М1 + затемнение</b> (как у облака + Log, для сравнения)<br>лента гаснет и размывается ради одного клика по ⏸'],
    ['m2dim', { mat: 'm2', w: 'w23', dim: true }, '<b>М2 + затемнение</b> (для сравнения)<br>стекло поверх размытия — двойная вуаль'],
  ]) {
    const x = mkCell(218);
    timer(x, 'run', T1);
    panel(x, ONE, o);
    cell(s2, x, cap, key);
  }

  // 3 ─ the row: one floor or two
  const s3 = section('3 · Строка таймера: один этаж или два',
    'Панель уже окна, поэтому описанию в одну строку тесно. В два этажа: сверху ⏸/▶ · время · Log… · ✕, снизу поле описания на всю ширину — как двустрочные записи ленты. Материал переключается кнопками наверху страницы.');
  const TWO = [{ t: TL, st: 'run' }, { t: T2, st: 'pause' }];
  {
    const x = mkCell(218);
    timer(x, 'run', TL);
    panel(x, TWO, { one: true });
    cell(s3, x, '<b>Один этаж</b><br>⏸ · время · описание · Log… · ✕ — описание режется рано', 'one');
  }
  {
    const x = mkCell(218);
    timer(x, 'run', TL);
    panel(x, TWO);
    cell(s3, x, '<b>Два этажа</b><br>описанию вся ширина панели; строка выше на 20px', 'two');
  }
  {
    const x = mkCell(218);
    timer(x, 'run', { desc: '', time: '0m 04s' });
    panel(x, [{ t: { desc: '', time: '0m 04s' }, st: 'run', focus: true }], { newTimer: false });
    cell(s3, x, '<b>Сразу после рождения</b> (два этажа)<br>курсор в описании; Enter / клик мимо — закрыть, Esc с пустым полем — передумал', 'born');
  }

  // 4 ─ what lives in the island
  const s4 = section('4 · Кто живёт в острове: только таймеры без тикета — или все',
    '<b>А · только без тикета.</b> Остров — место для времени, которому ещё не нашли тикет. Таймер с тикетом — это запись в карточке, там же его ⏸/▶. <b>Б · все.</b> Единый пульт: у таймера с тикетом вместо Log… — ключ, вместо ✕ (выбросить время) — ✓ (готово: убрать из острова, время остаётся в записи). Цена Б: список растёт за день, управление дублируется с карточкой, и ✓ — это вернувшийся Stop.');
  {
    const x = mkCell(250);
    timer(x, 'run', T1);
    panel(x, [{ t: T1, st: 'run' }, { t: T2, st: 'pause' }]);
    cell(s4, x, '<b>А · в острове два таймера без тикета</b><br>у каждого Log… и ✕', 'a-list');
  }
  {
    const x = mkCell(330);
    timer(x, 'run', T1);
    panel(x, [{ t: T1, st: 'run' }, { t: T2, st: 'pause' }, { t: K1, st: 'pause' }, { t: K2, st: 'pause' }]);
    cell(s4, x, '<b>Б · те же два + два таймера с тикетом</b><br>ключ вместо Log…, ✓ вместо ✕; к вечеру строк больше', 'b-list');
  }
  {
    const x = mkCell(250);
    timer(x, 'idle');
    sessionsPaused(x);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '48m', live: true, sum: '6h 22m', total: '13h 19m' });
    cell(s4, x, '<b>А · идёт таймер с тикетом</b><br>время тикает в записи карточки (оранжевый ⏸, сумма растёт), а в шапке тишина — контур. С вкладок Timesheets и Settings этот таймер не виден', 'a-feed');
  }
  {
    const x = mkCell(250);
    timer(x, 'run', { time: '48m 02s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '48m', live: true, sum: '6h 22m', total: '13h 19m' });
    panel(x, [{ t: { desc: T1.desc, time: '48m 02s', key: TICKET.key }, st: 'run' }, { t: T2, st: 'pause' }]);
    cell(s4, x, '<b>Б · идёт таймер с тикетом</b><br>чип в шапке горит, строка в острове с ключом; та же ⏸ есть и в записи под панелью', 'b-feed');
  }

  // 5 ─ Log…: how the time gets into a ticket
  const s5 = section('5 · Log… — как время таймера попадает в тикет (СТОП + LOG)',
    'Тот же путь, что у подсказок: Log… → облако выбора тикета → форма с одной кнопкой Log. Минуты и описание подставлены из таймера и правятся. Переключатель timer выключен — <b>СТОП + LOG</b>: время записано, таймер закончился. Включён — «привязать и продолжать»: запись появилась, таймер кормит её дальше.');
  {
    const x = mkCell(250);
    timer(x, 'run', T1);
    panel(x, [{ t: T1, st: 'run', armed: true }]);
    cell(s5, x, '<b>1 · Log… в строке таймера</b><br>слово и цвет кнопки + Log: «записать это время»', 'log1');
  }
  {
    const x = mkCell(396);
    timer(x, 'run', T1);
    cloudPick(x, T1.desc);
    cell(s5, x, '<b>2 · Облако выбора тикета</b><br>то же облако, что у task? подсказки; таймер пока идёт; внизу — Create in Jira…', 'log2');
  }
  {
    const x = mkCell(250);
    timer(x, 'run', T1);
    cloudForm(x, { act: 'Meeting', min: '47m', desc: T1.desc, timer: false });
    cell(s5, x, '<b>3 · Форма: одна кнопка Log</b><br>тип активности · 47m из таймера · timer выключен · описание из таймера', 'log3');
  }
  {
    const x = mkCell(250);
    timer(x, 'idle');
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', sum: '6h 21m', total: '13h 18m' });
    cell(s5, x, '<b>4 · Итог: СТОП + LOG</b> (timer выключен)<br>запись в карточке с меткой таймера, суммы выросли на 47m; таймер закончился — в шапке снова контур, сессия идёт дальше', 'log4');
  }
  {
    const x = mkCell(250);
    timer(x, 'run', T1);
    cloudForm(x, { act: 'Meeting', min: '47m', desc: T1.desc, timer: true });
    cell(s5, x, '<b>3′ · То же, timer включён</b><br>«привязать и продолжать»: итог — кадры «идёт таймер с тикетом» в разделе 4 (А или Б)', 'log3t');
  }

  // ── measurements, straight from the cells ────────────────────────
  function measure() {
    const z = +getComputedStyle(document.documentElement).getPropertyValue('--z') || 1;
    const rr = (v) => Math.round(v * 10) / 10;
    const w = (el) => rr(el.getBoundingClientRect().width / z);
    const h = (el) => rr(el.getBoundingClientRect().height / z);
    const lx = (x, el) => rr((el.getBoundingClientRect().left - x.cv.getBoundingClientRect().left) / z - 1);
    const rx = (x, el) => rr((el.getBoundingClientRect().right - x.cv.getBoundingClientRect().left) / z - 1);
    const probe = document.createElement('span');
    probe.className = 'probe';
    probe.textContent = '0000000000';
    M.idle.hdr.append(probe);
    const ch = probe.getBoundingClientRect().width / z / 10;
    probe.remove();
    const X = M.idle;
    const rng = document.createRange();
    rng.selectNodeContents(X.date);
    const dateR = rr((rng.getBoundingClientRect().right - X.cv.getBoundingClientRect().left) / z - 1);
    const heads = cells.map((x) => h(x.head));
    const fld = (k) => { const f = $('.tfield', M[k].panel); return `${w(f)}px ≈ ${Math.floor(w(f) / ch)} зн.`; };
    const pl = (k) => `${lx(M[k], M[k].panel)}px`;
    const out = [];
    const g = (title, rows) => out.push({ title, rows });
    g('Окно и шапка', [
      ['ширина окна', `${w(X.app)}px`],
      ['шапка приложения / шапка Day', `${h(X.hdr)}px / ${Math.min(...heads) === Math.max(...heads) ? heads[0] : `${Math.min(...heads)}–${Math.max(...heads)}`}px (кадров: ${heads.length})`],
      ['иконки вкладок', `${w($('.view-switcher', X.hdr))}px`],
      ['свободно между вкладками и кнопками окна', `${rr(lx(X, X.wc) - rx(X, $('.view-switcher', X.hdr)))}px`],
      ['контур чипа в покое', `${w(X.chip)} × ${h(X.chip)}px`],
      ['чип «47m 15s»', `${w(M.ch1.chip)} × ${h(M.ch1.chip)}px`],
    ]);
    g('Панель и шапка Day', [
      ['текст даты заканчивается на', `${dateR}px`],
      ['+ Log начинается с / total с', `${lx(X, X.logBtn)}px / ${lx(X, X.total)}px`],
      ['левый край панели: М1 2/3 · М2 2/3', `${pl('m1w23')} · ${pl('m2w23')}`],
      ['левый край панели: М1 1/2 · М2 1/2', `${pl('m1w12')} · ${pl('m2w12')}`],
      ['высота панели: один таймер + New timer (два этажа)', `М1 ${h(M.m1w23.panel)}px · М2 ${h(M.m2w23.panel)}px`],
      ['высота панели: вариант А, два таймера', `${h(M['a-list'].panel)}px`],
      ['высота панели: вариант Б, четыре таймера', `${h(M['b-list'].panel)}px`],
    ]);
    g('Поле описания', [
      ['один этаж, 2/3 окна', fld('one')],
      ['два этажа, 2/3 окна', fld('two')],
      ['два этажа, половина окна', fld('m2w12')],
    ]);
    return out;
  }
  function renderMeasure() {
    const m = measure();
    $('#meas').innerHTML = m.map((gr) => `<span class="mh">${gr.title}</span>${gr.rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}`).join('');
    window.__meas = m;
  }

  const setZoom = (z) => {
    document.documentElement.style.setProperty('--z', z);
    for (const b of $$('[data-z]')) b.classList.toggle('on', b.dataset.z === String(z));
    for (const x of cells) place(x);
    renderMeasure();
  };
  const setMat = (m) => {
    curMat = m;
    for (const b of $$('[data-m]')) b.classList.toggle('on', b.dataset.m === m);
    for (const p of $$('.tpanel[data-mv]')) paintMat(p, m);
    renderMeasure();
  };
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('.tbb');
    if (!b) return;
    if (b.dataset.z) setZoom(b.dataset.z);
    if (b.dataset.m) setMat(b.dataset.m);
  });
  setZoom('1');
  document.fonts?.ready.then(() => renderMeasure());
})();
