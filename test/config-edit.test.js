/** K2, K3: `keysmith config`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const GWKEY = 'ks_configedit_secret_0123456789abcdefghij';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function setup(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cfg-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port: 8787, auth: { enabled: true, keys: [GWKEY] }, adapters: { a: { kind: 'http', baseUrl: 'http://x/v1', apiKey: '{env:X}' } }, aliases: {}, ...extra }, null, 2) + '\n', { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  const baks = () => fs.readdirSync(home).filter((f) => f.startsWith('config.json.bak-'));
  return { home, config, run, baks };
}

test('K2: --dry-run prints the difference and writes nothing; set writes a backup, mode 0600', (t) => {
  const { config, run, baks } = setup(t);
  const before = sha(config);
  const dry = run('config', 'set', 'discovery.enabled', 'true', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+ discovery\.enabled: true/);
  assert.equal(sha(config), before);
  assert.equal(baks().length, 0);

  const set = run('config', 'set', 'discovery.enabled', 'true');
  assert.equal(set.status, 0, set.stderr);
  assert.equal(run('config', 'get', 'discovery.enabled').stdout.trim(), 'true');
  assert.equal(baks().length, 1);
  assert.match(baks()[0], /^config\.json\.bak-\d{8}-\d{6}-config$/);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(path.dirname(config), baks()[0])).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['adapters', 'aliases', 'auth', 'discovery', 'port'], 'nothing the loader merges in is written back');
  assert.equal(run('config', 'set', 'discovery.enabled', 'true').stdout.includes('unchanged'), true);
  assert.equal(baks().length, 1, 'an unchanged value makes no backup');
});

test('K3: an unknown key is refused with the known keys; a wrong type is refused; the file is untouched', (t) => {
  const { config, run, baks } = setup(t);
  const before = sha(config);
  const bad = run('config', 'set', 'foo.bar', '1');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Known keys/);
  assert.match(bad.stderr, /discovery\.enabled/);
  for (const [k, v] of [['port', 'abc'], ['port', '70000'], ['discovery.enabled', 'yes'], ['adapters.a.apiKey', 'x'], ['auth.keys', 'x'], ['limits.spend', '1']]) {
    const r = run('config', 'set', k, v);
    assert.notEqual(r.status, 0, `${k} ${v}`);
  }
  assert.match(run('config', 'set', 'port', 'abc').stderr, /whole number/);
  assert.equal(sha(config), before);
  assert.equal(baks().length, 0);
});

test('config get masks the gateway keys; unset removes; discovery price paths are known keys', (t) => {
  const { config, run } = setup(t);
  const got = run('config', 'get', 'auth.keys');
  assert.equal(got.status, 0);
  assert.ok(!got.stdout.includes(GWKEY) && !got.stderr.includes(GWKEY));
  assert.equal(run('config', 'set', 'discovery.tr.inputPricePath', 'cost.in').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).discovery.tr.inputPricePath, 'cost.in');
  assert.equal(run('config', 'unset', 'discovery.tr.inputPricePath').status, 0);
  assert.equal(run('config', 'get', 'discovery.tr.inputPricePath').status, 1);
  assert.equal(run('config', 'set', 'tunnel.name', 'null').status, 0);
});

test('batch.enabled: set, get, reject non-bool, unset', (t) => {
  const { config, run } = setup(t);
  assert.equal(run('config', 'set', 'batch.enabled', 'true').status, 0);
  assert.equal(run('config', 'get', 'batch.enabled').stdout.trim(), 'true');
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).batch.enabled, true);
  const bad = run('config', 'set', 'batch.enabled', 'maybe');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /true or false/);
  assert.equal(run('config', 'unset', 'batch.enabled').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).batch?.enabled, undefined);
});
