// The tray icon, drawn the way the app draws it (tray_icon.rs): an SVG in a 64-unit box,
// rendered at the exact physical size of the icon. Chrome rasterises it here, resvg in the app.
const BODY = '<path d="M 12.8 32.8 Q 9.6 22.4 14.6 13.6 Q 21.8 20 25.6 28 Z" fill="#b7bdda"/>'
  + '<path d="M 51.2 32.8 Q 54.4 22.4 49.4 13.6 Q 42.2 20 38.4 28 Z" fill="#b7bdda"/>'
  + '<path fill-rule="evenodd" fill="#b7bdda" d="M 9.4 55 C 9.6 46 10.8 40 13.2 36 C 15.6 27.6 22.4 25.6 32 25.6 C 41.6 25.6 48.4 27.6 50.8 36 C 53.2 40 54.4 46 54.6 55 Q 32 62.5 9.4 55 Z M 16.8 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z M 33.6 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z"/>';
const GLYPH = 'translate(32 32) scale(1.17) translate(-32 -36.8)';
const TM = '#fc9230';
// iris + pale core; the orange iris is darker than the app's orange so that it stands out on the lavender face
const EYE = { green: ['#2aa757', '#d9ffe0'], orange: ['#e8690a', '#ffe2bf'] };
const SIZES = [16, 20, 24, 32];
// badge diameter as a share of the icon size
const K = { s: .25, m: .31, l: .38, cnt: .5 };

const DPR = () => window.devicePixelRatio || 1;
const h = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const html = (tag, cls, inner) => { const e = h(tag, cls); e.innerHTML = inner; return e; };

function eyesSvg(kind) {
  if (!kind) return '';
  const [iris, core] = EYE[kind];
  const pair = (rx, ry, fill) => [23.6, 40.4].map(cx => `<ellipse cx="${cx}" cy="42.8" rx="${rx}" ry="${ry}" fill="${fill}"/>`).join('');
  return pair(6.4, 8.9, iris) + pair(3, 4.6, core);
}

// The badge is laid out in physical pixels, snapped to the pixel grid, and only then converted to the 64-unit box.
function badgeGeo(size, k, gapPx) {
  const u = 64 / size;
  const d = Math.max(4, Math.round(size * k));
  const gap = gapPx ?? Math.max(1, Math.round(size / 20));
  return { u, d, gap, c: (size - d / 2) * u, r: d / 2 * u, cut: (d / 2 + gap) * u };
}

// spec: { eyes?: 'green' | 'orange', badge?: { look: 'disc' | 'dim' | 'ring' | 'grey', k?, gap?, digit? } }
function svgFor(spec, size) {
  let defs = '', mask = '', badge = '';
  const b = spec.badge;
  if (b) {
    const g = badgeGeo(size, b.k ?? K.m, b.gap);
    defs = `<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">`
      + `<rect width="64" height="64" fill="#fff"/><circle cx="${g.c}" cy="${g.c}" r="${g.cut}" fill="#000"/></mask></defs>`;
    mask = ' mask="url(#cut)"';
    const soft = b.look === 'dim' ? ' opacity=".5"' : '';
    if (b.look === 'ring') {
      const sw = Math.max(1, Math.round(size / 14)) * g.u;
      badge = `<circle cx="${g.c}" cy="${g.c}" r="${g.r - sw / 2}" fill="none" stroke="${TM}" stroke-width="${sw}"/>`;
    } else {
      badge = `<circle cx="${g.c}" cy="${g.c}" r="${g.r}" fill="${b.look === 'grey' ? '#8f95ad' : TM}"${soft}/>`;
    }
    if (b.digit != null) {
      badge += `<text x="${g.c}" y="${g.c + g.r * .6}" font-family="'Segoe UI', Arial, sans-serif" font-weight="700" font-size="${g.r * 1.7}"`
        + ` text-anchor="middle" fill="#1e1e2e"${soft}>${b.digit}</text>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${defs}`
    + `<g${mask}><g transform="${GLYPH}">${BODY}${eyesSvg(spec.eyes)}</g></g>${badge}</svg>`;
}

const cache = new Map();
function raster(spec, size) {
  const key = size + JSON.stringify(spec);
  if (!cache.has(key)) {
    cache.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        resolve(c);
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(spec, size));
    }));
  }
  return cache.get(key);
}
// a canvas of size × size real pixels shown at cssPx
function canvasOf(spec, size, cssPx) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.style.width = c.style.height = cssPx + 'px';
  raster(spec, size).then(src => c.getContext('2d').drawImage(src, 0, 0));
  return c;
}

// big pixels: every icon pixel is a whole number of screen pixels
function zoom(spec, size, theme, target = 104) {
  const dpr = DPR();
  const k = Math.max(2, Math.round(target * dpr / size));
  return h('div', 'zoom ' + theme, canvasOf(spec, size, size * k / dpr));
}

const GL = {
  up: '<path d="M4 10l4-4 4 4"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
  wifi: '<path d="M2 6.5a9 9 0 0 1 12 0M4.3 9a6 6 0 0 1 7.4 0"/><circle cx="8" cy="12" r=".9" fill="currentColor" stroke="none"/>',
  vol: '<path d="M2.5 6.5H5l3-2.5v8L5 9.5H2.5z"/><path d="M10.5 6a3 3 0 0 1 0 4M12.3 4.4a5.6 5.6 0 0 1 0 7.2"/>',
};
const glyph = name => html('div', 'slot', `<svg viewBox="0 0 16 16">${GL[name]}</svg>`);

// a piece of the taskbar at the scale of the chosen icon size, one icon pixel = one screen pixel
function tb(spec, size, theme) {
  const dpr = DPR();
  const bar = h('div', 'tb ' + theme);
  bar.style.setProperty('--u', (size / 16 / dpr) + 'px');
  bar.append(glyph('up'), glyph('shield'), h('div', 'slot', canvasOf(spec, size, size / dpr)), glyph('wifi'), glyph('vol'),
    html('div', 'clock', '14:07<br>15.11.2026'));
  return bar;
}

const shot = (spec, size) => h('div', 'shot', zoom(spec, size, 'dark'), zoom(spec, size, 'light'),
  h('div', 'tbs', tb(spec, size, 'dark'), tb(spec, size, 'light')));
const cell = (spec, size, cap) => h('div', 'cell', shot(spec, size), html('div', 'cap', cap));

// ── what the icon shows: variant × state ──
// states: none · ses (a session counts) · tm (a timer counts) · wait (a session counts, a timer waits) · stand (timers are paused)
function specFor(variant, state, o = {}) {
  const k = o.k ?? K.m;
  const dot = look => ({ look, k, gap: o.gap });
  const hours = Math.floor(o.hours ?? 0);
  const badge = look => variant === 'cnt' && hours >= 1 ? { look, k: K.cnt, gap: o.gap, digit: Math.min(9, hours) } : dot(look);
  if (state === 'none') return {};
  if (state === 'ses') return { eyes: 'green' };
  if (state === 'stand') return variant !== 'eyes' && o.stand === 'grey' ? { badge: dot('grey') } : {};
  if (variant === 'eyes') return { eyes: state === 'tm' ? 'orange' : 'green' };
  if (state === 'tm') return { badge: badge('disc') };
  const wait = o.wait ?? 'dim';
  return wait === 'none' ? { eyes: 'green' } : { eyes: 'green', badge: badge(wait) };
}

const fmt = m => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
function tipFor(state, minutes = 47) {
  const t = fmt(minutes);
  return {
    none: 'Workday',
    ses: 'Workday — web-app · ATL-8110',
    tm: `Workday — timer ${t} · ATL-6712`,
    wait: `Workday — web-app · ATL-8110\ntimer waiting ${t} · ATL-6712`,
    stand: 'Workday',
  }[state];
}

// ── page state ──
const params = new URLSearchParams(location.search);
const nearest = px => SIZES.reduce((a, b) => Math.abs(b - px) < Math.abs(a - px) ? b : a);
const S = { size: SIZES.includes(+params.get('size')) ? +params.get('size') : nearest(16 * DPR()) };
const SB = { state: 'tm', variant: 'eyes', k: K.m, gap: null, wait: 'dim', stand: 'none', minutes: 47 };

// Layout leaves canvases at fractional screen pixels (the 125 % and 150 % scales), and a canvas drawn there is resampled:
// a column of the icon is lost, another is doubled. Nudge every canvas onto the screen pixel grid.
function alignCanvases() {
  const dpr = DPR();
  const list = [...document.querySelectorAll('canvas')];
  list.forEach(c => { c.style.left = c.style.top = '0px'; });
  const moves = list.map(c => {
    const r = c.getBoundingClientRect();
    const x = (r.left + scrollX) * dpr, y = (r.top + scrollY) * dpr;
    return [(Math.round(x) - x) / dpr, (Math.round(y) - y) / dpr];
  });
  list.forEach((c, i) => { c.style.left = moves[i][0] + 'px'; c.style.top = moves[i][1] + 'px'; });
}

const $ = id => document.getElementById(id);
const fill = (id, kids) => { const el = $(id); el.replaceChildren(...kids.flat()); return el; };
const pct = size => Math.round(size / 16 * 100);

function seg(options, get, set) {
  const el = h('div', 'seg');
  options.forEach(([value, label]) => {
    const b = h('button', '', label);
    b.type = 'button';
    b.onclick = () => set(value);
    el.append(b);
  });
  el.sync = () => [...el.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === get()));
  el.sync();
  return el;
}

function renderBar() {
  const s = seg(SIZES.map(v => [v, `${v} px`]), () => S.size, v => { S.size = v; renderAll(); });
  $('size-seg').replaceWith(Object.assign(s, { id: 'size-seg' }));
  const native = 16 * DPR(), near = nearest(native);
  const exact = Math.abs(native - near) < .5;
  $('dpr-note').innerHTML = exact
    ? `Этот экран: масштаб <b>${pct(near)} %</b>, значок в трее <b>${near} × ${near} px</b>.`
    : `Масштаб страницы в браузере не 100 % — настоящий размер будет виден после Ctrl+0.`;
}

function renderNow() {
  fill('g-now', [
    cell(specFor('dot', 'none'), S.size, '<b>Никто не считает.</b> Глазницы пустые, сквозь них видна панель задач.'),
    cell(specFor('dot', 'ses'), S.size, '<b>Считает сессия.</b> Глаза зелёные.'),
  ]);
}

const VARIANTS = [
  { id: 'dot', name: '<i>К</i> · Кружок',
    note: 'Оранжевый кружок в правом нижнем углу, вокруг него вырез в маскоте. Глаза по-прежнему говорят только о сессии. Времени на значке нет — оно в подсказке и на виджете.',
    tm: '<b>Считает таймер.</b> Сессии нет или она вытеснена: глазницы пустые, кружок оранжевый.',
    wait: '<b>Считает сессия, таймер ждёт.</b> Глаза зелёные, кружок вполсилы.' },
  { id: 'cnt', name: '<i>Ч</i> · Счётчик часов',
    note: 'Выбор октября. Первый час — тот же кружок, что в варианте К; дальше в нём цифра полных часов. Здесь таймер идёт 2h 30m.',
    tm: '<b>Считает таймер.</b> Под цифру кружок нужен вдвое больше.',
    wait: '<b>Считает сессия, таймер ждёт.</b> Тот же кружок вполсилы.' },
  { id: 'eyes', name: '<i>Г</i> · Только глаза',
    note: 'Бейджа нет. Глаза горят цветом того, кто считает: зелёные — сессия, оранжевые — таймер. Маскот остаётся целым.',
    tm: '<b>Считает таймер.</b> Глаза оранжевые.',
    wait: '<b>Считает сессия, таймер ждёт.</b> Как сегодня при сессии: ждущий таймер на значке не виден, он виден на виджете.' },
];

function renderVariants() {
  fill('g-var', VARIANTS.map(v => [
    html('div', 'vt', v.name),
    html('p', 'q', v.note),
    h('div', 'grid',
      cell(specFor(v.id, 'tm', { hours: 2.5 }), S.size, v.tm),
      cell(specFor(v.id, 'wait', { hours: 2.5 }), S.size, v.wait)),
  ]));
}

const sizeCell = (spec, size) => h('div', 'cell', zoom(spec, size, 'dark'), zoom(spec, size, 'light'), tb(spec, size, 'dark'),
  html('div', 'cap', `${size} px · ${pct(size)} %`));
function renderSizes() {
  const row = (title, spec) => [html('div', 'vt', title), h('div', 'sizes', SIZES.map(size => sizeCell(spec, size)))];
  fill('g-sizes', [
    row('<i>К</i> · Кружок — считает таймер', specFor('dot', 'tm')),
    row('<i>Ч</i> · Счётчик часов — считает таймер, 2h 30m', specFor('cnt', 'tm', { hours: 2.5 })),
    row('<i>Г</i> · Только глаза — считает таймер', specFor('eyes', 'tm')),
    row('<i>К</i> · Кружок — считает сессия, таймер ждёт', specFor('dot', 'wait')),
  ]);
}

function renderDot() {
  const one = (k, name) => {
    const g = badgeGeo(S.size, k);
    return cell(specFor('dot', 'tm', { k }), S.size, `<b>${name}.</b> Диаметр ${g.d} px, зазор ${g.gap} px.`);
  };
  fill('g-dot', [one(K.s, 'Малый'), one(K.m, 'Средний'), one(K.l, 'Большой')]);
}

function renderWait() {
  fill('g-wait', [
    cell(specFor('dot', 'wait', { wait: 'dim' }), S.size, '<b>Вполсилы.</b> Тот же кружок, прозрачность 50 %. Как в приложении.'),
    cell(specFor('dot', 'wait', { wait: 'ring' }), S.size, '<b>Кольцо.</b> Полный цвет, пустая середина.'),
    cell(specFor('dot', 'wait', { wait: 'none' }), S.size, '<b>Не показывать.</b> Значок говорит только о том, кто считает сейчас.'),
  ]);
}

function renderStand() {
  fill('g-stand', [
    cell(specFor('dot', 'stand'), S.size, '<b>Значок не меняется.</b> Как сегодня без трекинга.'),
    cell(specFor('dot', 'stand', { stand: 'grey' }), S.size, '<b>Серый кружок.</b> Напоминает, что в острове есть таймеры.'),
  ]);
}

function renderTips() {
  const scene = (state, spec, cap) => h('div', 'cell', html('div', 'tipline', tipFor(state)), tb(spec, S.size, 'dark'), html('div', 'cap', cap));
  fill('g-tip', [
    scene('ses', specFor('eyes', 'ses'), '<b>Считает сессия.</b> Текст как сейчас.'),
    scene('tm', specFor('eyes', 'tm'), '<b>Считает таймер.</b> Время и тикет; у таймера без тикета — начало описания.'),
    scene('wait', specFor('eyes', 'wait'), '<b>Считает сессия, таймер ждёт.</b> Ждущий — второй строкой.'),
    scene('none', specFor('eyes', 'stand'), '<b>Никто не считает.</b> Только имя приложения.'),
  ]);
}

// ── sandbox ──
const segs = [];
function renderSandView() {
  const spec = specFor(SB.variant, SB.state, { k: SB.k, gap: SB.gap ?? undefined, wait: SB.wait, stand: SB.stand, hours: SB.minutes / 60 });
  const g = badgeGeo(S.size, spec.badge?.k ?? SB.k, SB.gap ?? undefined);
  fill('sb-view', [
    h('div', 'shot', zoom(spec, S.size, 'dark', 208), zoom(spec, S.size, 'light', 208)),
    h('div', 'shot', tb(spec, S.size, 'dark'), tb(spec, S.size, 'light')),
    html('div', 'tipline', tipFor(SB.state, SB.minutes)),
    html('div', 'readout', spec.badge
      ? `Значок <b>${S.size} px</b> · кружок <b>${g.d} px</b> · зазор <b>${g.gap} px</b>`
      : `Значок <b>${S.size} px</b> · кружка нет`),
  ]);
  segs.forEach(s => s.sync());
  $('sb-k-val').textContent = `${Math.round(SB.k * 100)} % значка`;
  $('sb-gap-val').textContent = SB.gap == null ? 'авто' : `${SB.gap} px`;
  alignCanvases();
}

function renderSandCtl() {
  const pick = (options, key) => { const s = seg(options, () => SB[key], v => { SB[key] = v; renderSandView(); }); segs.push(s); return s; };
  const kRange = Object.assign(h('input'), { type: 'range', min: .2, max: .56, step: .01, value: SB.k });
  kRange.oninput = () => { SB.k = +kRange.value; renderSandView(); };
  const gapRange = Object.assign(h('input'), { type: 'range', min: 0, max: 3, step: 1, value: 1 });
  gapRange.oninput = () => { SB.gap = +gapRange.value; renderSandView(); };
  const val = id => Object.assign(h('span', 'val'), { id });
  fill('sb-ctl', [
    h('span', 'lbl', 'Состояние'), pick([['none', 'Никто'], ['ses', 'Сессия'], ['tm', 'Таймер'], ['wait', 'Сессия, таймер ждёт'], ['stand', 'Таймеры стоят']], 'state'),
    h('span', 'lbl', 'Вариант'), pick([['dot', 'Кружок'], ['cnt', 'Счётчик часов'], ['eyes', 'Только глаза']], 'variant'),
    h('span', 'lbl', 'Размер кружка'), h('div', '', kRange, val('sb-k-val')),
    h('span', 'lbl', 'Зазор'), h('div', '', gapRange, val('sb-gap-val')),
    h('span', 'lbl', 'Ждущий'), pick([['dim', 'Вполсилы'], ['ring', 'Кольцо'], ['none', 'Не показывать']], 'wait'),
    h('span', 'lbl', 'Стоящие'), pick([['none', 'Значок не меняется'], ['grey', 'Серый кружок']], 'stand'),
    h('span', 'lbl', 'Таймер идёт'), pick([[20, '20m'], [47, '47m'], [70, '1h 10m'], [150, '2h 30m'], [310, '5h 10m']], 'minutes'),
  ]);
}

function renderAll() {
  renderBar();
  renderNow();
  renderVariants();
  renderSizes();
  renderDot();
  renderWait();
  renderStand();
  renderTips();
  renderSandView();
}

renderSandCtl();
renderAll();
document.fonts.ready.then(alignCanvases);

// the window changed width (the layout moved), the page went to a screen with another scale, or the browser zoom changed
let lastDpr = DPR();
window.addEventListener('resize', () => {
  if (DPR() === lastDpr) { alignCanvases(); return; }
  lastDpr = DPR();
  if (!params.get('size')) S.size = nearest(16 * lastDpr);
  renderAll();
});
