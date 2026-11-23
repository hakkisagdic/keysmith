/**
 * `key add --out F --force` truncates F before the config is saved. If that save fails,
 * the previous key file must still be there, byte for byte. A file this add created
 * (no --force, or --force and nothing was there) is removed. The key is never printed.
 *
 * A config directory at mode 0500 makes saveConfig fail. Root ignores that mode, so
 * those tests are skipped when process.getuid() === 0. The key file lives in its own
 * temp directory: sealing the config directory must not make --out unwritable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// Built at run time so the test source holds no secret-looking literal.
const mint = () => ['ks', '_', crypto.randomBytes(24).toString('base64url')].join('');
const MINTED_KEY = /ks_[A-Za-z0-9_-]{32}/;

function sandbox(keys) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-scopes-cli-'));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      port: 0,
      auth: { enabled: true, keys },
      adapters: { agy: { kind: 'cli', bin: 'agy', args: ['{prompt}'] }, google: { kind: 'http', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false }, 'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false } },
      aliases: { argon: ['agy/gemini-4-argon-high', 'google/gemini-4-argon'] },
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const outputs = [];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    outputs.push(r.stdout + r.stderr);
    return r;
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const edit = (change) => {
    const cfg = read();
    change(cfg);
    fs.writeFileSync(config, JSON.stringify(cfg), { mode: 0o600 });
  };
  return { home, config, env, run, read, edit, outputs, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function assertNoKey(text, key, where) {
  assert.equal(text.includes(key), false, `${where}: the full key was printed`);
  for (let i = 3; i + 8 <= key.length; i++) {
    assert.equal(text.includes(key.slice(i, i + 8)), false, `${where}: 8 characters of a key were printed`);
  }
}

/** K6: no output line contains a known key, and no line contains a minted key. */
function assertLinesHideKeys(r, keys, where) {
  const text = `${r.stdout}${r.stderr}`;
  for (const line of text.split('\n')) {
    assert.equal(MINTED_KEY.test(line), false, `${where}: a minted key was printed`);
    for (const key of keys) {
      if (typeof key === 'string' && key) assert.equal(line.includes(key), false, `${where}: a line contains a key`);
    }
  }
  for (const key of keys) if (typeof key === 'string' && key) assertNoKey(text, key, where);
}

function rootCannotBlockSave() {
  return process.getuid && process.getuid() === 0;
}

function useSandbox(t) {
  const sb = sandbox([mint()]);
  t.after(() => {
    try { fs.chmodSync(path.dirname(sb.config), 0o700); } catch { /* already removable */ }
    sb.cleanup();
  });
  return sb;
}

function outFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-key-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ada.key');
}

function sealConfig(sb) {
  fs.chmodSync(path.dirname(sb.config), 0o500);
}

test('K1 --force over an existing file, config save fails: exit non-zero, file bytes unchanged, config keys unchanged', (t) => {
  if (rootCannotBlockSave()) {
    t.skip('root ignores directory mode 0500');
    return;
  }
  const oldKey = mint();
  const sb = useSandbox(t);
  const file = outFile(t);
  fs.writeFileSync(file, `${oldKey}\n`, { mode: 0o600 });
  const before = fs.readFileSync(file);
  const configBefore = fs.readFileSync(sb.config);
  const keysBefore = sb.read().auth.keys.slice();
  sealConfig(sb);
  const r = sb.run('key', 'add', 'ada2', '--out', file, '--force');
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null);
  assert.ok(fs.readFileSync(file).equals(before), 'previous key file was not restored byte for byte');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(sb.config).equals(configBefore), 'config changed though the save failed');
  assert.deepEqual(sb.read().auth.keys, keysBefore);
  assertLinesHideKeys(r, [oldKey, ...keysBefore], 'K1');
});

test('K2 --force over an existing file, save succeeds: file holds the new key plus newline, mode 0600', (t) => {
  const oldKey = mint();
  const sb = useSandbox(t);
  const file = outFile(t);
  fs.writeFileSync(file, `${oldKey}\n`, { mode: 0o600 });
  const kept = sb.read().auth.keys.slice();
  const r = sb.run('key', 'add', 'ada2', '--out', file, '--force');
  assert.equal(r.status, 0);
  const keys = sb.read().auth.keys;
  assert.equal(keys.length, kept.length + 1);
  assert.equal(keys[0], kept[0]);
  assert.equal(keys[1].label, 'ada2');
  const body = fs.readFileSync(file);
  assert.ok(body.equals(Buffer.from(`${keys[1].key}\n`)), 'file should hold the new key and a newline');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assertLinesHideKeys(r, [oldKey, keys[1].key, kept[0]], 'K2');
});

test('K3 no --force, new path, config save fails: the new file does not exist afterwards', (t) => {
  if (rootCannotBlockSave()) {
    t.skip('root ignores directory mode 0500');
    return;
  }
  const sb = useSandbox(t);
  const file = outFile(t);
  const configBefore = fs.readFileSync(sb.config);
  const keysBefore = sb.read().auth.keys.slice();
  sealConfig(sb);
  const r = sb.run('key', 'add', 'ada2', '--out', file);
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.readFileSync(sb.config).equals(configBefore), 'config changed though the save failed');
  assert.deepEqual(sb.read().auth.keys, keysBefore);
  assertLinesHideKeys(r, keysBefore, 'K3');
});

test('K4 no --force, file exists: refused as before, file untouched', (t) => {
  const oldKey = mint();
  const sb = useSandbox(t);
  const file = outFile(t);
  fs.writeFileSync(file, `${oldKey}\n`, { mode: 0o600 });
  const before = fs.readFileSync(file);
  const mode = fs.statSync(file).mode & 0o777;
  const configBefore = fs.readFileSync(sb.config);
  const keysBefore = sb.read().auth.keys.slice();
  const r = sb.run('key', 'add', 'ada2', '--out', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exists: not overwritten, and no key was added/);
  assert.ok(fs.readFileSync(file).equals(before), 'refused add changed the existing file');
  assert.equal(fs.statSync(file).mode & 0o777, mode);
  assert.ok(fs.readFileSync(sb.config).equals(configBefore));
  assert.deepEqual(sb.read().auth.keys, keysBefore);
  assertLinesHideKeys(r, [oldKey, ...keysBefore], 'K4');
});

test('K5 --force with a file that did not exist, config save fails: the file does not exist afterwards', (t) => {
  if (rootCannotBlockSave()) {
    t.skip('root ignores directory mode 0500');
    return;
  }
  const sb = useSandbox(t);
  const file = outFile(t);
  assert.equal(fs.existsSync(file), false);
  const configBefore = fs.readFileSync(sb.config);
  const keysBefore = sb.read().auth.keys.slice();
  sealConfig(sb);
  const r = sb.run('key', 'add', 'ada2', '--out', file, '--force');
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.readFileSync(sb.config).equals(configBefore), 'config changed though the save failed');
  assert.deepEqual(sb.read().auth.keys, keysBefore);
  assertLinesHideKeys(r, keysBefore, 'K5');
});

test('K6 no stdout or stderr line contains the previous key or the new key', (t) => {
  const oldKey = mint();
  const sb = useSandbox(t);
  const file = outFile(t);
  fs.writeFileSync(file, `${oldKey}\n`, { mode: 0o600 });
  const existing = sb.read().auth.keys[0];

  if (!rootCannotBlockSave()) {
    const before = fs.readFileSync(file);
    sealConfig(sb);
    const failed = sb.run('key', 'add', 'ada2', '--out', file, '--force');
    try { fs.chmodSync(path.dirname(sb.config), 0o700); } catch { /* t.after unseals too */ }
    assert.notEqual(failed.status, 0);
    assert.ok(fs.readFileSync(file).equals(before), 'previous key file was not restored byte for byte');
    assertLinesHideKeys(failed, [oldKey, existing], 'K6 failed save');
  }

  const ok = sb.run('key', 'add', 'ada2', '--out', file, '--force');
  assert.equal(ok.status, 0);
  const newKey = sb.read().auth.keys.at(-1).key;
  assert.ok(fs.readFileSync(file).equals(Buffer.from(`${newKey}\n`)), 'file should hold the new key and a newline');
  assertLinesHideKeys(ok, [oldKey, newKey, existing], 'K6 saved');
});
