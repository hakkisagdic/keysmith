/** Tester checks for 20261117-acilis-eksikleri (K1-K6, K11), written from the acceptance list. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { httpsServer, selfSigned } from './tls-helper.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function stubSecurity(home) {
  const f = path.join(home, 'sec.sh');
  fs.writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do case " $KS_KNOWN " in *" $a "*) echo "tester-key"; exit 0;; esac; done\nexit 44\n', { mode: 0o700 });
  return f;
}
function env0(t, cfgObj) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify(cfgObj ?? { port: 8787, auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data'), KEYSMITH_SECURITY_BIN: stubSecurity(home), KS_KNOWN: 'svc-groq svc-mistral' };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  const arun = (...a) => new Promise((res) => { const p = spawn(process.execPath, [CLI, ...a], { env }); let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; }); p.on('close', (status) => res({ status, stdout: o, stderr: e })); });
  return { home, config, env, run, arun, cfg: () => JSON.parse(fs.readFileSync(config, 'utf8')) };
}
async function serve(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return srv.address().port;
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('K1: batch.enabled set/get/unset, non-bool refused, batch status flips', (t) => {
  const { run, cfg } = env0(t);
  assert.match(run('batch', 'status').stderr, /batch is off/);
  assert.equal(run('config', 'set', 'batch.enabled', 'true').status, 0);
  assert.equal(cfg().batch.enabled, true);
  assert.match(run('config', 'get', 'batch.enabled').stdout, /true/);
  assert.match(run('batch', 'status').stdout, /no batch jobs/);
  const bad = run('config', 'set', 'batch.enabled', 'maybe');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /bool|true|false/i);
  assert.equal(cfg().batch.enabled, true, 'bad value did not overwrite');
  assert.equal(run('config', 'unset', 'batch.enabled').status, 0);
  assert.equal(cfg().batch?.enabled, undefined);
  assert.match(run('batch', 'status').stderr, /batch is off/);
});

const TABLE = (over = {}) => ({
  data: [
    { model_name: 'free/a:free', quota_type: 0, model_price: 0, model_ratio: 0 },
    { model_name: 'free/b', quota_type: 0, model_price: 0, model_ratio: 0 },
    { model_name: 'paid/c', quota_type: 0, model_price: 0, model_ratio: 1.5 },
    { model_name: 'paid/price', quota_type: 0, model_price: 0.2, model_ratio: 0 },
    { model_name: 'quota/d', quota_type: 1, model_price: 0, model_ratio: 0 },
    { model_name: 'tier/e', quota_type: 0, model_price: 0, model_ratio: 0 },
    { model_name: 'missing/f', quota_type: 0, model_price: 0 },
    { model_name: 'str/g', quota_type: 0, model_price: '0', model_ratio: '0' },
    ...(over.rows || []),
  ],
  tiered_pricing: { 'tier/e': { x: 1 } },
});

test('K2+K3: discover builds the free list from the price table, with source and time; a repriced model drops out; unreadable empties', async (t) => {
  let table = TABLE();
  let status = 200;
  const srv = await httpsServer((q, r) => (q.url === '/api/pricing' ? json(r, table, status) : json(r, {}, 404)));
  t.after(() => srv.close());
  const port = srv.address().port;
  const prevCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = selfSigned().file; // env0 copies the environment for its children
  t.after(() => { if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = prevCa; });
  const { arun, home } = env0(t, { port: 8787, auth: { enabled: false, keys: [] }, aliases: {}, discovery: { enabled: true, tokenrouter: { pricingUrl: `https://127.0.0.1:${port}/api/pricing` } },
    adapters: { tokenrouter: { kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', freeOnly: true } } });
  const file = path.join(home, 'data', 'discovered', 'tokenrouter.json');
  const r1 = await arun('discover', 'tokenrouter'); r1.s = r1.status; r1.o = r1.stdout + r1.stderr;
  assert.equal(r1.s, 0, r1.o);
  const d1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(d1.ids.sort(), ['free/a:free', 'free/b']);
  assert.ok(d1.source && !/[?@]/.test(d1.source), 'source is host/path only');
  assert.ok(!Number.isNaN(Date.parse(d1.at)), 'timestamp');
  // K3: free/b becomes paid
  table = TABLE(); table.data[1].model_ratio = 0.3;
  const again = () => arun('discover', 'tokenrouter');
  assert.equal((await again()).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids, ['free/a:free']);
  status = 500;
  assert.equal((await again()).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids, [], 'unreadable table: empty, not stale');
});

test('K2+K3: through a running gateway, a model off the free list is refused (400, no upstream call), a listed one passes', async (t) => {
  const { Gateway } = await import('../src/gateway.js');
  const { createServer } = await import('../src/server.js');
  const { UsageLog } = await import('../src/usage.js');
  const { writeDiscovered, discoveredPath } = await import('../src/catalogue.js');
  const { dataDir } = await import('../src/config.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prev = process.env.KEYSMITH_DATA;
  process.env.KEYSMITH_DATA = path.join(home, 'data');
  t.after(() => { if (prev === undefined) delete process.env.KEYSMITH_DATA; else process.env.KEYSMITH_DATA = prev; });
  writeDiscovered(discoveredPath(dataDir(), 'tr'), ['free/a'], { source: 'h/p', at: new Date().toISOString() });
  let hits = 0;
  const port = await serve(t, (q, r) => { hits++; json(r, { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); });
  const cfg = { auth: { enabled: false }, aliases: {}, adapters: { tr: { kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', freeOnly: true } } };
  const srv = createServer(new Gateway(cfg, { log: () => {} }), cfg, { usage: new UsageLog(path.join(home, 'u.jsonl')), log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const ask = (model, stream) => fetch(`http://127.0.0.1:${srv.address().port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
  for (const stream of [false, true]) assert.equal((await ask('tr/paid/c', stream)).status, 400);
  assert.equal(hits, 0);
  assert.equal((await ask('tr/free/a', false)).status, 200);
  assert.equal(hits, 1);
});

function mkProviderList(t, ids) {
  return serve(t, (q, r) => json(r, { data: ids.map((id) => ({ id })) }));
}

test('K4: default model chosen from the provider list; --model wins; unlisted model errors and writes nothing', async (t) => {
  const port = await mkProviderList(t, ['whisper-large-v3', 'llama-guard-4-12b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gpt-oss-20b', 'llama-3.2-3b-preview']);
  const { arun: run, cfg, config } = env0(t);
  const url = `http://127.0.0.1:${port}/models`;
  const before = fs.readFileSync(config, 'utf8');
  const bad = await run('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'nonexistent-model', '--models-url', url);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /nonexistent-model/);
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'config untouched');
  const auto = await run('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--models-url', url);
  assert.equal(auto.status, 0, auto.stderr);
  const m = cfg().adapters.groq.models;
  assert.equal(m.length, 1);
  assert.ok(['llama-3.1-8b-instant', 'gpt-oss-20b', 'llama-3.2-3b-preview'].includes(m[0]), `picked ${m[0]}`);
  assert.ok(!/whisper|guard|70b/.test(m[0]), 'not a non-chat or large model');
  const run2 = await run('source', 'disable', 'groq');
  assert.equal(run2.status, 0);
  const named = await run('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'gpt-oss-20b', '--models-url', url);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(cfg().adapters.groq.models, ['gpt-oss-20b']);
});

test('K5: mistral note says 429 / no free rate / left out, in enable and in source list', (t) => {
  const { run } = env0(t);
  const en = run('source', 'enable', 'mistral', '--key-ref', 'svc-mistral', '--model', 'mistral-small-latest', '--dry-run');
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /429/);
  assert.match(en.stdout, /no free rate/);
  assert.match(en.stdout, /left out/);
  const ls = run('source', 'list');
  assert.equal(ls.status, 0, ls.stderr);
  const line = ls.stdout.split('\n').find((l) => l.startsWith('mistral'));
  assert.match(line, /429/);
  assert.ok(ls.stdout.split('\n').some((l) => l.startsWith('tokenrouter')));
});

test('K6: real SIGHUP on a separate-port gateway toggles promptCache, nothing else, invalid keeps old', async (t) => {
  const bodies = [];
  const up = await serve(t, (q, r) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { bodies.push(b); json(r, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }); }); });
  const free = await serve(t, () => {}); // reserve a port number
  const gwPort = free + 1000 > 65000 ? free - 1000 : free + 1000;
  const mk = (pc, extra = {}) => ({ host: '127.0.0.1', port: gwPort, auth: { enabled: false, keys: [] }, aliases: {}, adapters: { ca: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${up}/v1`, apiKey: 'literal-test', models: ['claude-sonnet-5-5'], ...(pc === undefined ? {} : { promptCache: pc }), ...extra } } });
  const { home, config, env } = env0(t, mk());
  const logf = path.join(home, 'gw.log');
  const child = spawn(process.execPath, [CLI, 'serve'], { env: { ...env, KEYSMITH_VERBOSE: '1' }, stdio: ['ignore', fs.openSync(logf, 'w'), fs.openSync(logf, 'a')] });
  t.after(() => { try { child.kill('SIGTERM'); } catch {} });
  const base = `http://127.0.0.1:${gwPort}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/v1/models`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const ask = async () => {
    bodies.length = 0;
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'x', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'ca/claude-sonnet-5-5', max_tokens: 8, system: 'S'.repeat(8000), messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200, await res.text());
    return bodies[0].includes('cache_control');
  };
  const reload = async (doc) => { fs.writeFileSync(config, JSON.stringify(doc)); const t2 = new Date(Date.now() + (reload.n++) * 3000); fs.utimesSync(config, t2, t2); child.kill('SIGHUP'); await new Promise((r) => setTimeout(r, 700)); };
  reload.n = 1;
  assert.equal(await ask(), false);
  await reload(mk({ mode: 'on', ttl: '5m' }));
  assert.equal(await ask(), true, 'on after SIGHUP');
  await reload(mk({ mode: 'on', ttl: '5m' }, { baseUrl: 'http://127.0.0.1:1/changed' }));
  assert.equal(await ask(), true, 'baseUrl change not applied (upstream still reached)');
  await reload(mk({ mode: 'bogus' }));
  assert.equal(await ask(), true, 'invalid keeps old');
  await reload(mk());
  assert.equal(await ask(), false, 'off after SIGHUP');
});

test('K11: the public tree carries no private path, address or key', () => {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const changed = git('diff', 'main', '--name-only');
  const files = [...new Set([...git('ls-files', 'src', 'test/acilis-eksikleri-tester.test.js', 'examples', 'docs', 'README.md', 'CHANGELOG.md'), ...changed])];
  // Generic patterns only. Private values (server address, owner names) are read from outside the repo:
  // KEYSMITH_PRIVATE_PATTERNS (newline separated regex sources) or the untracked file named by
  // KEYSMITH_PRIVATE_PATTERNS_FILE. Absent both, only the generic patterns run.
  const generic = [/\/Users\/(?!me\/|x\/|alice\/)[a-z]+\//, /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-[A-Za-z0-9]{32,}/];
  let extra = process.env.KEYSMITH_PRIVATE_PATTERNS || '';
  const pf = process.env.KEYSMITH_PRIVATE_PATTERNS_FILE;
  if (pf && fs.existsSync(pf)) extra += '\n' + fs.readFileSync(pf, 'utf8');
  const patterns = [...generic, ...extra.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => new RegExp(l))];
  const bad = [];
  for (const f of files) {
    let s; try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (patterns.some((re) => re.test(s))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
