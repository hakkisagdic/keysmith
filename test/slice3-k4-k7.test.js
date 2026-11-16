/** Slice 3 acceptance: K4 (usage record) and K7 (discover). Black-box through the CLI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const KEY = 'sk-slice3-stub-key-0123456789';

function box(t, extra = {}, adapters = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s3-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: false, keys: [] }, adapters, aliases: {}, ...extra }), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  delete env.XDG_CONFIG_HOME; delete env.XDG_DATA_HOME;
  const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', timeout: 20000 }); return { ...r, all: `${r.stdout}${r.stderr}` }; };
  const runAsync = (...a) => new Promise((res) => { const p = spawn(process.execPath, [CLI, ...a], { env }); let all = ''; p.stdout.on('data', (d) => { all += d; }); p.stderr.on('data', (d) => { all += d; }); p.on('close', (status) => res({ status, all })); });
  const lines = () => { const out = []; for (const f of fs.existsSync(data) ? fs.readdirSync(data) : []) if (/^usage.*\.jsonl$/.test(f)) out.push(...fs.readFileSync(path.join(data, f), 'utf8').split('\n').filter(Boolean)); return out; };
  return { run, runAsync, data, lines };
}

test('K4: record twice with same --id gives one external row; usage --by adapter counts it', (t) => {
  const b = box(t);
  const a = ['usage', 'record', '--source', 'qoder', '--model', 'm', '--tag', 'job/1', '--id', 'r1'];
  const r1 = b.run(...a); assert.equal(r1.status, 0, r1.all);
  const r2 = b.run(...a); assert.equal(r2.status, 0, r2.all);
  const rows = b.lines().map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].face, 'external');
  assert.ok(b.lines()[0].length < 4096);
  const u = b.run('usage', '--by', 'adapter', '--format', 'json');
  assert.equal(u.status, 0, u.all);
  assert.match(u.stdout, /qoder/);
});

test('K4: different ids add rows; --from file works and dedups', (t) => {
  const b = box(t);
  b.run('usage', 'record', '--source', 'qoder', '--id', 'a');
  b.run('usage', 'record', '--source', 'qoder', '--id', 'b');
  assert.equal(b.lines().length, 2);
  const f = path.join(path.dirname(b.data), 'in.jsonl');
  fs.writeFileSync(f, '{"source":"kiro","id":"x1"}\n{"source":"kiro","id":"x1"}\n');
  assert.equal(b.run('usage', 'record', '--from', f).status, 0);
  assert.equal(b.lines().length, 3);
});

test('K4: record without --source fails cleanly and writes nothing', (t) => {
  const b = box(t);
  const r = b.run('usage', 'record', '--model', 'm');
  assert.notEqual(r.status, 0);
  assert.equal(b.lines().length, 0);
});

async function stub(t, status, body) {
  const s = http.createServer((q, r) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(body)); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  return `http://127.0.0.1:${s.address().port}/v1`;
}

test('K7: discover writes only price-0 models when switch on', async (t) => {
  const base = await stub(t, 200, { data: [
    { id: 'f1', pricing: { prompt: '0', completion: '0' } },
    { id: 'p1', pricing: { prompt: '0', completion: '0.5' } },
    { id: 'p2', pricing: { prompt: '1', completion: '1' } },
    { id: 'n' },
  ] });
  const b = box(t, { discovery: { enabled: true } }, { tokenrouter: { type: 'http', baseUrl: base, apiKey: KEY } });
  const r = await b.runAsync('discover', 'tokenrouter');
  assert.equal(r.status, 0, r.all);
  const f = path.join(b.data, 'discovered', 'tokenrouter.json');
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /f1/); assert.doesNotMatch(txt, /p1|p2|"n"/);
  assert.ok(!r.all.includes(KEY));
});

test('K7: switch off refuses and writes nothing', async (t) => {
  const base = await stub(t, 200, { data: [] });
  const b = box(t, {}, { tokenrouter: { type: 'http', baseUrl: base, apiKey: KEY } });
  const r = await b.runAsync('discover', 'tokenrouter');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /discovery/i);
  assert.ok(!fs.existsSync(path.join(b.data, 'discovered', 'tokenrouter.json')));
});

test('K7: 401 says renew key and hides the key', async (t) => {
  const base = await stub(t, 401, { error: 'no' });
  const b = box(t, { discovery: { enabled: true } }, { tokenrouter: { type: 'http', baseUrl: base, apiKey: KEY } });
  const r = await b.runAsync('discover', 'tokenrouter');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /renew key/);
  assert.ok(!r.all.includes(KEY));
});
