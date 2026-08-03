/**
 * Unit tests for the browser inventory mapper — registry entries → BrowserInfo
 * list: quote stripping, IE filter, HKCU/HKLM dedupe, name fallback.
 *
 * Run: npx tsx tests/unit/browser-registry.test.ts
 */
import assert from 'node:assert/strict';
import { mapRegistryBrowsers, listInstalledBrowsers } from '../../src/core/browser-registry.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    });
}

await test('strips quotes and keeps display names', () => {
  const list = mapRegistryBrowsers([
    { key: 'Microsoft Edge', name: 'Microsoft Edge', command: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"' },
    { key: 'Google Chrome', name: 'Google Chrome', command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
  ]);
  assert.deepEqual(list.map(b => b.name), ['Google Chrome', 'Microsoft Edge']);
  assert.equal(list[1].path, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
});

await test('IE never appears (key or exe)', () => {
  const list = mapRegistryBrowsers([
    { key: 'IEXPLORE.EXE', name: null, command: '"C:\\Program Files\\Internet Explorer\\iexplore.exe"' },
    { key: 'Legacy IE', name: 'Internet Explorer', command: 'C:\\somewhere\\IEXPLORE.EXE' },
    { key: 'Firefox-308046B0AF4A39CB', name: 'Firefox', command: '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"' },
  ]);
  assert.deepEqual(list.map(b => b.name), ['Firefox']);
});

await test('dedupes the same exe across hives, first entry wins', () => {
  const list = mapRegistryBrowsers([
    { key: 'Google Chrome', name: 'Google Chrome', command: '"C:\\PF\\chrome.exe"' },
    { key: 'Google Chrome', name: 'Chrome (user)', command: '"c:\\pf\\CHROME.EXE"' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Google Chrome');
});

await test('name falls back to the key; commandless entries drop', () => {
  const list = mapRegistryBrowsers([
    { key: 'SomeBrowser', name: null, command: 'C:\\SB\\sb.exe' },
    { key: 'Broken', name: 'Broken', command: null },
    { key: 'Blank', name: '  ', command: '"C:\\B\\b.exe"' },
  ]);
  assert.deepEqual(list.map(b => b.name), ['Blank', 'SomeBrowser']);
});

await test('unquoted command with non-ASCII per-user path survives', () => {
  const list = mapRegistryBrowsers([
    { key: 'Firefox', name: 'Firefox', command: 'C:\\Users\\Антон\\AppData\\Local\\Mozilla Firefox\\firefox.exe' },
  ]);
  assert.equal(list[0].path, 'C:\\Users\\Антон\\AppData\\Local\\Mozilla Firefox\\firefox.exe');
});

// Live enumeration: shape-only — the machine's browser set varies. On
// Windows the PowerShell path must not throw and every row must be complete.
await test('live enumeration returns well-formed rows (win32) or [] elsewhere', async () => {
  const list = await listInstalledBrowsers();
  if (process.platform !== 'win32') {
    assert.deepEqual(list, []);
    return;
  }
  for (const b of list) {
    assert.equal(typeof b.name, 'string');
    assert.ok(b.name.length > 0);
    assert.ok(/\.exe$/i.test(b.path), `path should be an exe: ${b.path}`);
    assert.ok(!/iexplore\.exe$/i.test(b.path), 'IE must be filtered');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
