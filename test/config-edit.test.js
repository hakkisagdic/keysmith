/** K2, K3: `keysmith config`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

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

test('Check 8: structuredOutput.mode config edit, doctor error on invalid mode, and server falls back to off', async (t) => {
  const { home, config, run } = setup(t, { structuredOutput: { mode: 'yes' } });
  const badDoc = run('doctor');
  assert.match(badDoc.stdout + badDoc.stderr, /structuredOutput\.mode must be "off" or "heal".*stays off/);

  const badSet = run('config', 'set', 'structuredOutput.mode', 'yes');
  assert.notEqual(badSet.status, 0);
  assert.match(badSet.stderr, /off \| heal/);

  assert.equal(run('config', 'set', 'structuredOutput.mode', 'heal').status, 0);
  assert.equal(run('config', 'get', 'structuredOutput.mode').stdout.trim(), 'heal');
  const okDoc = run('doctor');
  assert.doesNotMatch(okDoc.stdout + okDoc.stderr, /structured-output healing stays off/);

  // Server with bad structuredOutput logs an error and treats requests as off
  const received = [];
  const rawMalformed = '```json {"a":1,}```';
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: rawMalformed } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stub.close(r)));
  const cfg = {
    auth: { enabled: true, keys: [GWKEY] },
    structuredOutput: { mode: 'yes' },
    adapters: { up: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: false, models: ['m'] } },
    aliases: {},
  };
  const logs = [];
  const server = createServer(new Gateway(cfg), cfg, { usage: new UsageLog(path.join(home, 'usage.jsonl')), log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${GWKEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'up/m', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.choices[0].message.content, rawMalformed);
  assert.deepEqual(received[0].messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(logs.some((l) => /structuredOutput.*stays off/.test(l)));
});
