import assert from 'node:assert/strict';
import { UpdateManager, isNewerVersion } from '../../src/core/update-manager.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  PASS ${name}`);
      passed++;
    })
    .catch((err: unknown) => {
      console.error(`  FAIL ${name}`);
      console.error(`       ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    });
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  console.log('Version compare');

  await test('strictly newer / equal / older', () => {
    assert.equal(isNewerVersion('0.6.0', '0.5.2'), true);
    assert.equal(isNewerVersion('0.5.2', '0.5.2'), false);
    assert.equal(isNewerVersion('0.5.1', '0.5.2'), false);
  });

  await test('double-digit components compare numerically, not lexically', () => {
    assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
    assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  });

  await test('prerelease tags are never auto-installed', () => {
    assert.equal(isNewerVersion('0.7.0-beta.1', '0.6.0'), false);
  });

  console.log('\nUpdate check');

  await test('reports an available update', async () => {
    const um = new UpdateManager({
      fetchFn: fakeFetch(200, { version: '0.7.0' }),
      readInstalledVersion: () => '0.6.0',
    });
    const res = await um.checkForUpdate();
    assert.deepEqual(res, { current: '0.6.0', latest: '0.7.0', updateAvailable: true });
  });

  await test('up to date → updateAvailable false', async () => {
    const um = new UpdateManager({
      fetchFn: fakeFetch(200, { version: '0.6.0' }),
      readInstalledVersion: () => '0.6.0',
    });
    const res = await um.checkForUpdate();
    assert.equal(res.updateAvailable, false);
  });

  await test('registry error throws (callers degrade gracefully)', async () => {
    const um = new UpdateManager({
      fetchFn: fakeFetch(503, {}),
      readInstalledVersion: () => '0.6.0',
    });
    await assert.rejects(() => um.checkForUpdate(), /503/);
  });

  console.log('\nInstall + verify');

  await test('install succeeds only when the new version landed on disk', async () => {
    let installed = '0.6.0';
    const calls: string[] = [];
    const um = new UpdateManager({
      execRunner: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        installed = '0.7.0';
      },
      readInstalledVersion: () => installed,
    });
    await um.installVersion('0.7.0');
    assert.deepEqual(calls, ['npm install -g workday-daemon@0.7.0'], 'pinned version, not @latest');
  });

  await test('npm exit 0 but old tree on disk → verification throws', async () => {
    const um = new UpdateManager({
      execRunner: async () => { /* npm "succeeded" but replaced nothing */ },
      readInstalledVersion: () => '0.6.0',
    });
    await assert.rejects(() => um.installVersion('0.7.0'), /verification failed/);
  });

  await test('npm failure propagates without touching verify', async () => {
    const um = new UpdateManager({
      execRunner: async () => { throw new Error('npm ERR! network'); },
      readInstalledVersion: () => { throw new Error('must not be called'); },
    });
    await assert.rejects(() => um.installVersion('0.7.0'), /npm ERR! network/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
