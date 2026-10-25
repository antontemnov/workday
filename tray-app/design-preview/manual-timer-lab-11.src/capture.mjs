// Snapshots the live tray app (?mock=1, `npm start` in tray-app) in headless
// Chrome over CDP: DOM of <app-root> + every stylesheet, per view (Day,
// Settings, Timesheets) → capture.json next to this file.
// Usage: node capture.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = dirname(fileURLToPath(import.meta.url));
const PORT = 9341;
const URL_APP = 'http://localhost:4200/?mock=1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'workday-capture-prof')}`,
  '--window-size=500,560', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ }
  if (!page) await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result.result.value;
};

const CAPTURE = `(async () => {
  const styles = [];
  for (const el of document.querySelectorAll('style, link[rel=stylesheet]')) {
    if (el.tagName === 'STYLE') styles.push(el.textContent);
    else { try { styles.push(await (await fetch(el.href)).text()); } catch (e) { styles.push('/* fail ' + el.href + ' */'); } }
  }
  return {
    styles,
    html: document.querySelector('app-root').outerHTML,
    view: document.querySelector('app-day-view, app-settings-view, app-timesheets-view')?.outerHTML ?? '',
  };
})()`;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 560, deviceScaleFactor: 1, mobile: false });
const out = {};

await send('Page.navigate', { url: URL_APP });
await sleep(6000);
out.day = await evalJs(CAPTURE);

await send('Page.navigate', { url: URL_APP });
await sleep(5000);
await evalJs(`document.querySelector('.view-btn[title=Settings]').click()`);
await sleep(2500);
out.set = await evalJs(CAPTURE);

await send('Page.navigate', { url: URL_APP });
await sleep(5000);
await evalJs(`document.querySelector('.view-btn[title=Timesheets]').click()`);
await sleep(3500);
out.sheet = await evalJs(CAPTURE);

writeFileSync(`${OUT}/capture.json`, JSON.stringify(out));
ws.close();
proc.kill();
console.log('ok', Object.keys(out).join(', '));
