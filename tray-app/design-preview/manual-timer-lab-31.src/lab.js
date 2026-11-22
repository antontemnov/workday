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
  const PLUS = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';
  const G_PL = '<svg class="g-pl" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';
  const G_GO = '<svg class="g-go" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.8 1.5l5.6 3.5-5.6 3.5z"/></svg>';

  const T1 = { desc: 'созвон по инциденту с командой платежей', time: '47m 15s' };
  const TL = { desc: 'разбор 500-х на checkout после выкладки платёжного шлюза', time: '47m 15s' };
  const T2 = { desc: 'помог соседней команде с деплоем', time: '12m 40s' };
  const T3 = { desc: '', time: '3m 05s' };
  const K1 = { desc: 'code review', time: '1h 20m', key: 'ATL-6712' };
  const K2 = { desc: 'стенд для демо', time: '25m', key: 'ATL-7002' };
  const TICKET = { key: 'ATL-6781', name: 'Daily standup and team sync' };
  const ACTS = ['Development', 'Code Review', 'Estimation', 'Design Analysis', 'Meeting', 'Other'];

  // ── one cell = a fresh copy of the app, cropped ──────────────────
  const tpl = $('#tpl-app');
  function mkCell(height) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.style.height = `${height}px`;
    cv.append(tpl.content.cloneNode(true));
    const app = $('.app', cv);
    const x = { cv, app, hdr: $('.header', app), head: $('.day-head', app), date: $('.day-date', app), logBtn: $('.g-btn', app), total: $('.day-total', app),
      cloud: $('app-log-cloud', app), backdrop: $('.cloud-backdrop', app) };
    x.NG = ngOf(x.logBtn);
    x.NL = ngOf($('.btn-log', app));
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

  // ── the timer in the header: idle (a sign or a word in the chip's outline) | run | pause ──
  const IDLE = {
    ghost: () => `<span class="tchip ghost">${ic('idle')}</span>`,
    plus: () => `<span class="tchip ghost word">${G_PL}Timer</span>`,
    glass: (x) => `<button ${x.NG} type="button" class="g-btn tglass"><svg ${x.NG} viewBox="0 0 12 12" aria-hidden="true"><path ${x.NG} d="M6 2.6V9.4M2.6 6H9.4"/></svg>Timer</button>`,
    icon: () => `<span class="tchip ghost word">${ic('idle')}Timer</span>`,
    none: () => '<span class="tchip bare">No timers</span>',
    play: () => `<span class="tchip ghost word">${G_GO}Timer</span>`,
  };
  function timer(x, st, t, o = {}) {
    const el = st === 'idle' ? IDLE[o.idle || 'plus'](x)
      : `<span class="tchip ${st}">${ic(st)}<b class="tchip-time" style="width:${t.time.length}ch">${t.time}</b></span>`;
    x.wc.insertAdjacentHTML('beforebegin', `<span class="tmz">${el}</span>`);
    x.chip = $('.tmz > *', x.hdr);
    if (st === 'run') sessionsPaused(x);
  }

  // ── the island ───────────────────────────────────────────────────
  // rows: [{ t, st: run | pause, focus, armed }] — t.key marks a timer that has a ticket
  // o.lay: c1 | c2 | c3 | var (follows the toolbar) · o.lc: or | nt | gr | var · o.newTimer
  let curLay = 'c1';
  let curLc = 'or';
  function panel(x, rows, o = {}) {
    const html = rows.map((r) => {
      const run = r.st === 'run';
      const tk = !!r.t.key;
      const has = !!r.t.desc && !r.focus;
      const btn = `<button type="button" class="tbtn ${run ? 'pz' : 'go'}">${run ? PAUSE : PLAY}</button>`;
      const act = tk ? `<span class="tkey">${r.t.key}</span>` : `<button ${x.NL} type="button" class="btn-log tlog${r.armed ? ' armed' : ''}">Log…</button>`;
      const field = r.focus ? '<span class="tfield focus"><i class="caret"></i><span class="ph">description</span></span>'
        : has ? `<span class="tfield">${esc(r.t.desc)}</span>` : `<span class="tfield">${tk ? '' : '<span class="ph">description</span>'}</span>`;
      const end = tk ? '<i class="tgut"></i>' : `<button type="button" class="tx">${X}</button>`;
      return `<div class="trow ${r.st}${tk ? ' tk' : ''}${has && !tk ? ' has-d' : ''}">${btn}${act}${field}<b class="ttime">${r.t.time}</b>${end}</div>`;
    }).join('');
    const nt = o.newTimer === false ? '' : `${rows.length ? '<div class="tsep"></div>' : ''}<div class="tnew"><span class="nt-g">${PLAY}</span><span>New timer</span></div>`;
    x.app.insertAdjacentHTML('beforeend', `<div class="tpanel">${html}${nt}</div>`);
    x.panel = x.app.lastElementChild;
    const lay = o.lay || 'var';
    const lc = o.lc || 'var';
    if (lay === 'var') x.panel.dataset.lv = '1';
    if (lc === 'var') x.panel.dataset.cv = '1';
    paint(x.panel, lay === 'var' ? curLay : lay, lc === 'var' ? curLc : lc);
  }
  function paint(p, lay, lc) {
    if (lay) for (const c of ['c1', 'c2', 'c3']) p.classList.toggle(`lay-${c}`, c === lay);
    if (lc) for (const c of ['or', 'nt', 'gr']) p.classList.toggle(`lc-${c}`, c === lc);
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
    if (o.pill) el.classList.add('tm-pill');
    src.parentNode.append(el);
    $('.sum', blk).textContent = o.sum;
    x.total.textContent = o.total;
    x.rec = el;
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
  // the cloud hangs from the island's row when there is one, else from the day head
  function place(x) {
    if (!x.cloud.classList.contains('open')) return;
    const top = x.panel ? x.panel.offsetTop + x.panel.offsetHeight + 4 : offsetIn(x.head, x.app).bottom - 4;
    x.cloud.style.top = `${top}px`;
    x.backdrop.style.top = `${x.hdr.offsetHeight}px`;
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

  // 1 ─ the header at rest
  const s1 = section('1 · Шапка в покое: чем заменить значок',
    'Таймеров нет. Вместо значка-циферблата в контуре — слово: оно говорит, что будет по клику, и не спорит с иконкой вкладки Day (там тоже часы). В конце ряда для сверки — принятые состояния: идёт (<b>Ч1</b>) и пауза (<b>П1</b>).');
  for (const [key, idle, cap] of [
    ['t0', 'ghost', '<b>Т0 · значок в контуре</b> (как в v30)<br>в шапке два циферблата — вкладка Day и таймер'],
    ['t1', 'plus', '<b>Т1 · + Timer</b>, плоский контур<br>пара к + Log по знаку и слову; материал шапки, без стекла'],
    ['t1g', 'glass', '<b>Т1с · + Timer стеклом, как + Log</b><br>та же капсула в цвете таймера; в покое в шапке уже горит оранжевый'],
    ['t2', 'icon', '<b>Т2 · значок + Timer</b><br>слово объясняет значок, но не говорит, что клик запускает'],
    ['t3', 'none', '<b>Т3 · No timers</b><br>это статус, а не действие: по слову не понять, что сюда нажимают'],
    ['t4', 'play', '<b>Т4 · ▶ Timer</b> (добавка)<br>тот же зелёный ▶, что у New timer в острове и Start timer в облаке'],
  ]) {
    const x = mkCell(HEAD);
    timer(x, 'idle', null, { idle });
    cell(s1, x, cap, key);
  }
  {
    const x = mkCell(HEAD);
    timer(x, 'run', T1);
    cell(s1, x, '<b>Идёт · Ч1</b> (принято)<br>контур залит #11111b, значок и время оранжевые', 'run');
  }
  {
    const x = mkCell(HEAD);
    timer(x, 'pause', T1);
    cell(s1, x, '<b>Пауза · П1</b> (принято)<br>значок и время серые', 'pause');
  }

  // 2 ─ the row: where the description stands
  const s2 = section('2 · Строка таймера: раскладка двух этажей',
    'Время ушло в правую колонку, как во всех строках приложения; ⏸/▶ и Log… стоят слева, ✕ — в узком поле у края. Строка без описания везде в один этаж: слово description в ней — поле для ввода. Раскладки различаются только местом описания. В каждом кадре три таймера: идёт с длинным описанием, пауза с описанием, пауза без описания.');
  const THREE = [{ t: TL, st: 'run' }, { t: T2, st: 'pause' }, { t: T3, st: 'pause' }];
  for (const [lay, cap] of [
    ['c1', '<b>С1 · описание сверху, управление под ним</b><br>описание идёт от левого края на всю ширину; просвет между Log… и временем — тот же, что между текстом и временем в ленте'],
    ['c2', '<b>С2 · управление сверху, описание под ним</b><br>все строки начинаются одинаково, с кнопки; описание читается подписью к ней'],
    ['c3', '<b>С3 · кнопка на два этажа</b><br>отступ стал колонкой: описание и Log… стоят на одной вертикали'],
  ]) {
    const x = mkCell(246);
    timer(x, 'run', TL);
    panel(x, THREE, { lay });
    cell(s2, x, cap, lay);
  }
  {
    const x = mkCell(246);
    timer(x, 'run', { time: '0m 04s' });
    panel(x, [{ t: { desc: '', time: '0m 04s' }, st: 'run', focus: true }, { t: T2, st: 'pause' }], { lay: 'c1' });
    cell(s2, x, '<b>Сразу после рождения</b> (С1)<br>строка в один этаж, курсор в поле между Log… и временем; Enter — описание встаёт своим этажом', 'born');
  }

  // 3 ─ the colour of Log…
  const s3 = section('3 · Цвет Log… — несущий цвет таймеров',
    'Золото — подсказки, фиолетовый — ручной Log, зелёный — tracked. У таймера несущий цвет уже есть — оранжевый: им горят чип, время и ⏸. Кнопка здесь та же, что Log… в строке подсказки, только в другом цвете. Раскладка — по переключателю наверху страницы.');
  const TWO = [{ t: T1, st: 'run' }, { t: T2, st: 'pause' }];
  for (const [lc, cap] of [
    ['or', '<b>Оранжевый</b><br>кнопка в цвете своей сущности, как золотой Log… у подсказки; на паузе это единственный оранжевый в строке'],
    ['nt', '<b>Нейтральный</b><br>цвет остаётся только у того, что тикает; кнопка тише всего остального'],
    ['gr', '<b>Зелёный</b><br>на паузе два зелёных с разным смыслом рядом: ▶ «продолжить» и Log… «записать»'],
  ]) {
    const x = mkCell(204);
    timer(x, 'run', T1);
    panel(x, TWO, { lc });
    cell(s3, x, cap, lc);
  }

  // 4 ─ the record a timer feeds
  const s4 = section('4 · Запись с идущим таймером в карточке',
    'Запись, которую кормит таймер: время оранжевое, с секундами, ⏸ стоит рядом с ним — тот же вид, что у чипа и у строки острова. Бирки timer added и обводки вокруг строки нет. Время и описание правятся как у любой записи. Сессия той же карточки при этом ждёт (красный ⏸ Paused).');
  {
    const x = mkCell(238);
    timer(x, 'run', T1);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m 15s', live: true, sum: '6h 21m', total: '13h 18m' });
    cell(s4, x, '<b>К1 · без подложки</b><br>⏸ и время просто оранжевые; колонка времени шире на секунды', 'k1');
  }
  {
    const x = mkCell(238);
    timer(x, 'run', T1);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m 15s', live: true, pill: true, sum: '6h 21m', total: '13h 18m' });
    cell(s4, x, '<b>К2 · на тёмной подложке, как чип</b><br>запись несёт тот же чип, что и шапка; подложка выходит за правый край колонки времени', 'k2');
  }
  {
    const x = mkCell(238);
    timer(x, 'pause', T1);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', rest: true, sum: '6h 21m', total: '13h 18m' });
    cell(s4, x, '<b>Таймер на паузе</b><br>время снова обычное, без секунд; рядом тихий ▶ — продолжить с этой же записи', 'rest');
  }
  {
    const x = mkCell(238);
    timer(x, 'run', { time: '1h 02m 15s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '1h 02m 15s', live: true, sum: '6h 36m', total: '13h 33m' });
    cell(s4, x, '<b>Больше часа</b> (К1)<br>1h 02m 15s — самое широкое время: колонка раздвигается и теснит колонки сессий над записью', 'long');
  }

  // 5 ─ Log…: the cloud hangs from the timer's row
  const s5 = section('5 · Log…: облако растёт из строки таймера',
    'Log… ставит таймер на паузу и открывает облако выбора тикета. Остров не закрывается, а сжимается до этой строки: она — якорь облака, как + Log при обычном логировании. Esc или клик мимо — облако закрылось, остров вернулся целиком, таймер стоит на паузе. Переключателя timer в форме нет: продолжить можно кнопкой ▶.');
  {
    const x = mkCell(420);
    timer(x, 'pause', T1);
    panel(x, [{ t: T1, st: 'pause', armed: true }], { newTimer: false });
    cloudPick(x, T1.desc);
    cell(s5, x, '<b>1 · Log… → облако под строкой</b><br>время серое — таймер встал; в поиске «ticket for …»; внизу Create in Jira…', 'pick');
  }
  {
    const x = mkCell(420);
    timer(x, 'pause', T1);
    panel(x, [{ t: T1, st: 'pause', armed: true }], { newTimer: false });
    cloudForm(x, { act: 'Meeting', min: '47m', desc: T1.desc });
    cell(s5, x, '<b>2 · Форма</b><br>тип активности · минуты из таймера · описание из таймера · одна кнопка Log', 'form');
  }

  // 6 ─ timers that have a ticket
  const s6 = section('6 · Таймеры с тикетом: «все» или «только без тикета»',
    'Таймер с тикетом — это запись в карточке, у которой тикает время; отдельной сущности нет. Строка в острове — её зеркало. <b>«Все»</b>: в острове таймеры без тикета и все записи, которые сегодня кормил таймер. У строки с тикетом нет ни ✕, ни ✓: время удаляется там, где запись, а список сам очищается со сменой дня. <b>«Только без тикета»</b>: после Log строка уходит, таймер с тикетом живёт только в карточке.');
  {
    const x = mkCell(262);
    timer(x, 'pause', { time: '47m' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', rest: true, sum: '6h 21m', total: '13h 18m' });
    panel(x, [{ t: { desc: T1.desc, time: '47m', key: TICKET.key }, st: 'pause' }, { t: T2, st: 'pause' }]);
    cell(s6, x, '<b>Все · сразу после Log</b><br>строка не исчезла: на месте Log… — ключ тикета, ✕ нет; в карточке появилась запись; ▶ в любом из двух мест продолжит счёт', 'all-after');
  }
  {
    const x = mkCell(262);
    timer(x, 'run', { time: '48m 02s' });
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '48m 02s', live: true, sum: '6h 22m', total: '13h 19m' });
    panel(x, [{ t: { desc: T1.desc, time: '48m 02s', key: TICKET.key }, st: 'run' }, { t: T2, st: 'pause' }, { t: K1, st: 'pause' }, { t: K2, st: 'pause' }]);
    cell(s6, x, '<b>Все · идёт таймер с тикетом</b><br>чип в шапке горит с любой вкладки; строки с тикетом — в один этаж, полное описание в карточке', 'all-run');
  }
  {
    const x = mkCell(262);
    timer(x, 'idle');
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '47m', rest: true, sum: '6h 21m', total: '13h 18m' });
    cell(s6, x, '<b>Только без тикета · после Log</b><br>строка ушла, в шапке снова + Timer; продолжить — ▶ у записи', 'anon-after');
  }
  {
    const x = mkCell(262);
    timer(x, 'idle');
    sessionsPaused(x);
    addRec(x, { type: 'Meeting', desc: T1.desc, dur: '48m 02s', live: true, sum: '6h 22m', total: '13h 19m' });
    cell(s6, x, '<b>Только без тикета · идёт таймер с тикетом</b><br>время тикает только в карточке; шапка молчит, с Timesheets и Settings его не видно', 'anon-run');
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
    M.t0.hdr.append(probe);
    const ch = probe.getBoundingClientRect().width / z / 10;
    probe.remove();
    const heads = cells.map((x) => h(x.head));
    const wh = (k) => `${w(M[k].chip)} × ${h(M[k].chip)}px`;
    const row = (k) => {
      const p = M[k].panel;
      const two = $('.trow.has-d', p);
      const one = $('.trow:not(.has-d)', p);
      const f = $('.tfield', two);
      return `${w(f)}px ≈ ${Math.floor(w(f) / ch)} зн. · этажи ${h(two)} / ${h(one)}px · панель ${h(p)}px`;
    };
    const dur = (k) => `${w($('.c-dur', M[k].rec))}px · описанию ${w($('.c-ds', M[k].rec))}px`;
    const out = [];
    const g = (title, rows) => out.push({ title, rows });
    g('Окно и шапка', [
      ['ширина окна', `${w(M.t0.app)}px`],
      ['шапка приложения / шапка Day', `${h(M.t0.hdr)}px / ${Math.min(...heads) === Math.max(...heads) ? heads[0] : `${Math.min(...heads)}–${Math.max(...heads)}`}px (кадров: ${heads.length})`],
      ['+ Log в шапке Day', `${w(M.t0.logBtn)} × ${h(M.t0.logBtn)}px`],
      ['Т0 значок в контуре', wh('t0')],
      ['Т1 + Timer', wh('t1')],
      ['Т1с + Timer стеклом', wh('t1g')],
      ['Т2 значок + Timer', wh('t2')],
      ['Т3 No timers', wh('t3')],
      ['Т4 ▶ Timer', wh('t4')],
      ['чип «47m 15s»', wh('run')],
    ]);
    g('Строка острова: поле описания · высота строки в два этажа / в один · высота панели (три таймера + New timer)', [
      ['С1 · описание сверху', row('c1')],
      ['С2 · описание снизу', row('c2')],
      ['С3 · кнопка на два этажа', row('c3')],
    ]);
    g('Запись в карточке: ширина колонки времени · сколько остаётся описанию', [
      ['обычная запись «15m»', `${w($('.blk.hot .wl.ent .c-dur', M.t0.app))}px · описанию ${w($('.blk.hot .wl.ent .c-ds', M.t0.app))}px`],
      ['К1 «⏸ 47m 15s»', dur('k1')],
      ['К2 то же на подложке', dur('k2')],
      ['пауза «▶ 47m»', dur('rest')],
      ['К1 «⏸ 1h 02m 15s»', dur('long')],
    ]);
    g('Log… и остров', [
      ['строка-якорь: низ острова / верх облака', `${by(M.pick, M.pick.panel)}px / ${ty(M.pick, M.pick.cloud)}px`],
      ['«все»: панель из четырёх таймеров + New timer', `${h(M['all-run'].panel)}px`],
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
  const setLay = (l) => {
    curLay = l;
    for (const b of $$('[data-l]')) b.classList.toggle('on', b.dataset.l === l);
    for (const p of $$('.tpanel[data-lv]')) paint(p, l, null);
    refresh();
  };
  const setLc = (c) => {
    curLc = c;
    for (const b of $$('[data-c]')) b.classList.toggle('on', b.dataset.c === c);
    for (const p of $$('.tpanel[data-cv]')) paint(p, null, c);
    refresh();
  };
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('.tbb');
    if (!b) return;
    if (b.dataset.z) setZoom(b.dataset.z);
    if (b.dataset.l) setLay(b.dataset.l);
    if (b.dataset.c) setLc(b.dataset.c);
  });
  setZoom('1');
  document.fonts?.ready.then(() => renderMeasure());
})();
