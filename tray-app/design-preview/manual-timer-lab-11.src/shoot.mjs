// Headless Chrome screenshot of a lab page, optionally after a script.
// Usage: node shoot.mjs <url> <out.png> [x,y,w,h | -] [js run before the shot]
// The js runs inside an async function: `await`, `return` value is printed.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, out, clipArg, js] = process.argv;
const PORT = 9342;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'workday-shoot-prof')}`,
  '--hide-scrollbars', '--no-first-run', 'about:blank',
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

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1700, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url });
await sleep(1500);
if (js) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${js}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log('JS ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  else if (r.result?.result?.value !== undefined) console.log('JS', JSON.stringify(r.result.result.value));
}
await sleep(400);
const params = { format: 'png' };
if (clipArg && clipArg !== '-') {
  const [x, y, width, height] = clipArg.split(',').map(Number);
  params.clip = { x, y, width, height, scale: 1 };
}
const r = await send('Page.captureScreenshot', params);
writeFileSync(out, Buffer.from(r.result.data, 'base64'));
ws.close();
proc.kill();
console.log('shot', out);
