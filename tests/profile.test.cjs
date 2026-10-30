'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createProfileRepository, MAX_PROFILE_BYTES } = require('../desktop/profile.cjs');
const { sanitizeStore } = require('../desktop/core.cjs');

function fixture(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-profile-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'browser.json');
  if (bytes !== undefined) fs.writeFileSync(profile, bytes);
  return { root, profile, read: () => fs.readFileSync(profile),
    backups: () => fs.readdirSync(root).filter(file => file.includes('.recovery-')).map(file => path.join(root, file)) };
}

const saved = sanitizeStore({ bookmarks: [{ url: 'https://example.com/', title: 'Kept' }], settings: { theme: 'light' } });

test('shutdown before profile loading cannot replace existing saved data', t => {
  const data = fixture(t, JSON.stringify(saved));
  const repository = createProfileRepository(data.profile);
  assert.equal(repository.save(sanitizeStore(null)).saved, false);
  assert.deepEqual(JSON.parse(data.read()), saved);
});

test('a new profile and an existing valid profile save and reopen normally', t => {
  const data = fixture(t);
  const repository = createProfileRepository(data.profile);
  assert.equal(repository.load().message, '');
  assert.equal(repository.save(saved).saved, true);
  assert.deepEqual(createProfileRepository(data.profile).load().store, saved);
  assert.deepEqual(data.backups(), []);
});

test('damaged JSON and invalid collection shapes are preserved byte-for-byte before replacement', t => {
  for (const original of ['{"bookmarks":[', 'null', '[]', '{"bookmarks":"lost?"}', '{"settings":[]}']) {
    const data = fixture(t, original);
    const repository = createProfileRepository(data.profile);
    assert.match(repository.load().message, /damaged/);
    const result = repository.save(saved);
    assert.equal(result.saved, true);
    assert.equal(data.backups().length, 1);
    assert.equal(fs.readFileSync(data.backups()[0], 'utf8'), original);
    assert.ok(result.message.includes(data.backups()[0]));
    assert.deepEqual(JSON.parse(data.read()), saved);
    assert.equal(repository.save(saved).saved, true);
    assert.equal(data.backups().length, 1, 'Later saves retain the original recovery copy');
  }
});

test('an oversized or nonregular profile remains untouched across repeated saves', t => {
  const bytes = Buffer.alloc(MAX_PROFILE_BYTES, 32);
  const data = fixture(t, bytes);
  const repository = createProfileRepository(data.profile);
  assert.match(repository.load().message, /preserved/);
  for (let i = 0; i < 2; i++) assert.equal(repository.save(saved).saved, false);
  assert.deepEqual(data.read(), bytes);
  assert.deepEqual(data.backups(), []);
  const directory = fixture(t);
  fs.mkdirSync(directory.profile);
  const other = createProfileRepository(directory.profile);
  other.load();
  assert.equal(other.save(saved).saved, false);
  assert.equal(fs.statSync(directory.profile).isDirectory(), true);
});

test('a read failure cannot cause defaults to replace an unreadable original', t => {
  const data = fixture(t, JSON.stringify(saved));
  const io = { ...fs, readFileSync() { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); } };
  const repository = createProfileRepository(data.profile, io);
  assert.match(repository.load().message, /will not be replaced/);
  assert.equal(repository.save(sanitizeStore(null)).saved, false);
  assert.deepEqual(JSON.parse(data.read()), saved);
});

test('a failed or unverifiable recovery copy never replaces the damaged original', t => {
  for (const failure of ['write', 'verify']) {
    const data = fixture(t, '{broken');
    const io = { ...fs,
      writeFileSync(file, ...args) { if (failure === 'write' && file.includes('.recovery-')) throw new Error('Disk full'); return fs.writeFileSync(file, ...args); },
      readFileSync(file, ...args) { if (failure === 'verify' && file.includes('.recovery-')) return Buffer.from('incomplete'); return fs.readFileSync(file, ...args); },
    };
    const repository = createProfileRepository(data.profile, io);
    repository.load();
    assert.equal(repository.save(saved).saved, false);
    assert.equal(data.read().toString(), '{broken');
  }
});

test('a profile repaired after loading remains untouched instead of being overwritten by recovery', t => {
  const data = fixture(t, '{broken');
  const repository = createProfileRepository(data.profile);
  repository.load();
  fs.writeFileSync(data.profile, JSON.stringify(saved));
  const result = repository.save(sanitizeStore(null));
  assert.equal(result.saved, false);
  assert.match(result.message, /changed during recovery/);
  assert.deepEqual(JSON.parse(data.read()), saved);
  assert.deepEqual(data.backups(), []);
});

test('failed atomic replacement keeps the original and a verified recovery copy, then retries safely', t => {
  const data = fixture(t, '{broken');
  let failRename = true;
  const io = { ...fs, renameSync(...args) { if (failRename) throw new Error('Denied'); return fs.renameSync(...args); } };
  const repository = createProfileRepository(data.profile, io);
  repository.load();
  assert.equal(repository.save(saved).saved, false);
  assert.equal(data.read().toString(), '{broken');
  assert.equal(fs.readFileSync(data.backups()[0], 'utf8'), '{broken');
  assert.equal(fs.readdirSync(data.root).some(file => file.endsWith('.tmp')), false);
  failRename = false;
  assert.equal(repository.save(saved).saved, true);
  assert.deepEqual(JSON.parse(data.read()), saved);
  assert.equal(data.backups().length, 1);
});
