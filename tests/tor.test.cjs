'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TorManager, allocateLoopbackPort } = require('../desktop/tor.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turbo-tor-test-'));
  const executablePath = path.join(root, 'tor.exe');
  await fs.writeFile(executablePath, 'fixture');
  const events = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
  let call;
  const manager = new TorManager({ executablePath, dataDirectory: path.join(root, 'data'),
    onStatus: status => events.push(status), allocatePort: async () => 23456,
    spawnProcess: (...args) => { call = args; options.onSpawn?.(child); return child; }, ...options });
  t.after(async () => {
    manager.close();
    const safeRoot = path.resolve(root);
    if (path.dirname(safeRoot) === path.resolve(os.tmpdir()) && path.basename(safeRoot).startsWith('turbo-tor-test-')) await fs.rm(safeRoot, { recursive: true, force: true });
  });
  return { manager, child, events, get call() { return call; } };
}

async function waitForSpawn(f) { for (let i = 0; i < 100 && !f.call; i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(f.call); }

test('Tor connects only after 100% bootstrap and binds its owned SOCKS listener to loopback', async t => {
  const f = await fixture(t);
  const pending = f.manager.connect();
  assert.equal(f.manager.connect(), pending);
  await waitForSpawn(f);
  assert.equal(f.call[2].windowsHide, true); assert.equal(f.call[2].shell, false);
  const args = f.call[1];
  assert.equal(args[args.indexOf('--SocksPort') + 1], '127.0.0.1:23456');
  assert.equal(args[args.indexOf('--ClientOnly') + 1], '1');
  assert.equal(args[args.indexOf('--AvoidDiskWrites') + 1], '1');
  assert.ok(args.includes('--defaults-torrc'));
  let settled = false; pending.then(() => { settled = true; });
  f.child.stdout.write('[notice] Bootstrapped 80% (ap_conn): Connecting\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  f.child.stdout.write('[notice] Bootstrapped 1'); f.child.stdout.write('00% (done): Done\n');
  assert.equal(await pending, 23456);
  assert.equal(f.events.at(-1).state, 'connected');
  f.child.exitCode = 2; f.child.emit('exit', 2);
  assert.equal(f.events.at(-1).state, 'error'); assert.equal(f.manager.port, null);
});

test('Tor startup timeout terminates only the owned daemon and never returns a direct port', async t => {
  const f = await fixture(t, { startupTimeoutMs: 15 });
  await assert.rejects(f.manager.connect(), /could not connect/);
  assert.equal(f.child.killed, true); assert.equal(f.manager.port, null);
  assert.equal(f.events.at(-1).state, 'error');
});

test('Tor early exit and spawn failures reject without a fallback connection', async t => {
  const f = await fixture(t);
  const pending = f.manager.connect(); await waitForSpawn(f);
  f.child.exitCode = 7; f.child.emit('exit', 7);
  await assert.rejects(pending, /Tor stopped/); assert.equal(f.manager.port, null);
  const failed = await fixture(t, { spawnProcess: () => { throw new Error('denied'); } });
  await assert.rejects(failed.manager.connect(), /could not start/);
});

test('Closing Tor while connecting rejects startup and is idempotent', async t => {
  const f = await fixture(t);
  const pending = f.manager.connect(); await waitForSpawn(f);
  f.manager.close(); f.manager.close();
  await assert.rejects(pending, /was closed/); assert.equal(f.child.killed, true);
  assert.equal(f.events.at(-1).state, 'stopped');
});

test('Tor archive validation rejects absolute paths, traversal, drive paths and missing notices', async () => {
  const { validateArchivePaths, TOR_BUNDLE } = await import('../scripts/prepare-tor.mjs');
  const valid = ['tor/', 'tor/tor.exe', 'docs/tor.txt'];
  assert.doesNotThrow(() => validateArchivePaths(valid));
  for (const invalid of ['/tor.exe', '../tor.exe', 'tor/../../escape', 'C:/tor.exe', 'tor\\escape.exe', 'tor/./escape']) {
    assert.throws(() => validateArchivePaths([...valid, invalid]), /Unsafe/);
  }
  assert.throws(() => validateArchivePaths(['tor/tor.exe']), /license/);
  assert.match(TOR_BUNDLE.sha256, /^[a-f0-9]{64}$/);
});

test('Tor can allocate an available nonprivileged loopback port', async () => {
  const port = await allocateLoopbackPort(); assert.ok(port >= 1024 && port <= 65535);
});
