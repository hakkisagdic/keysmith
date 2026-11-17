/** Tester's independent black-box checks for 20261117-fiyat-ve-kucuk-bulgular (K1-K8 and regressions), through the CLI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageLog } from '../src/usage.js';
import { httpsServer, selfSigned } from './tls-helper.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MODELS = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
  'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
];

function box(t, cfg = {}, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-ptester-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: false, keys: [] }, adapters: {}, aliases: {}, ...cfg }, null, 2) + '\n', { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data, ...extraEnv };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  const runAsync = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a], { env });
    let o = ''; let e = '';
    c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
    c.on('close', (status) => resolve({ status, stdout: o, stderr: e }));
  });
  const record = (rows) => { const log = new UsageLog(path.join(data, 'usage.jsonl'), { pricing: cfg.pricing }); for (const r of rows) log.record(r); };
  return { home, config, data, env, run, runAsync, record, read: () => fs.readFileSync(config, 'utf8') };
}
const row = (model, usage, extra = {}) => ({ adapter: 'claude-api', kind: 'http', model, status: 'ok', ms: 5, usage, ...extra });

test('K1 usage --by model: Haiku 4.5 priced, saved at list price above 0.00', (t) => {
  const b = box(t);
  b.record([row('claude-haiku-4-5-20251001', { input: 9000, output: 100, cacheRead: 8617, cacheWrite: 0 })]);
  const r = b.run('usage', '--by', 'model');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /saved at list price \$?0\.00\b/);
  assert.match(r.stdout, /saved at list price \$0\.00[1-9]|saved at list price \$0\.0[1-9]/);
  assert.doesNotMatch(r.stdout, /unpriced/);
  const j = JSON.parse(b.run('usage', '--by', 'model', '--format', 'json').stdout);
  assert.ok(JSON.stringify(j).includes('claude-haiku-4-5-20251001'));
});

test('K3 an unpriced model shows "unpriced" and its tokens, never $0.00; doctor names it', (t) => {
  const b = box(t);
  b.record([row('claude-nonesuch-9', { input: 4321, output: 77, cacheRead: 0, cacheWrite: 0 })]);
  const r = b.run('usage', '--by', 'model');
  assert.match(r.stdout, /claude-nonesuch-9/);
  assert.match(r.stdout, /unpriced/);
  assert.match(r.stdout, /4321/);
  const d = b.run('doctor');
  assert.match(d.stdout + d.stderr, /claude-nonesuch-9/);
  assert.match(d.stdout + d.stderr, /price/i);
});

test('regression: old usage rows are not rewritten by reading reports', (t) => {
  const b = box(t);
  b.record([row('claude-haiku-4-5-20251001', { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 }, { cost: { usd: 0, basis: 'unpriced' } })]);
  const f = path.join(b.data, 'usage.jsonl');
  const before = fs.readFileSync(f, 'utf8');
  b.run('usage', '--by', 'model'); b.run('doctor');
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('K2 price list shows 15 models with the page and the date', (t) => {
  const b = box(t);
  const r = b.run('price', 'list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  assert.match(r.stdout, /2026-11-17/);
  for (const m of MODELS) {
    const one = b.run('price', 'list', m.replace(/-20\d{6}$/, '')).stdout;
    assert.match(one, /\*\/claude-/, m);
    assert.ok(!one.includes('no entry matches'), m);
  }
});

test('K5 price set: dated backup, validation, bad input leaves the file untouched', (t) => {
  const b = box(t);
  const before = b.read();
  const ok = ['--input', '1', '--output', '5', '--cache-read', '0.1', '--cache-write-5m', '1.25'];
  for (const bad of [['--input', '-3'], ['--output', 'abc'], ['--cache-read', '1e9'], ['--batch-factor', '1.5']]) {
    const r = b.run('price', 'set', '*/claude-x*', ...ok, ...bad);
    assert.notEqual(r.status, 0, bad.join(' '));
    assert.equal(b.read(), before);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
  assert.equal(fs.readdirSync(b.home).filter((f) => f.includes('.bak-')).length, 0);
  const r = b.run('price', 'set', '*/claude-x*', ...ok);
  assert.equal(r.status, 0, r.stderr);
  const bak = fs.readdirSync(b.home).filter((f) => f.includes('.bak-'));
  assert.equal(bak.length, 1);
  assert.match(bak[0], /\.bak-\d{8}-\d{6}/);
  assert.equal(fs.readFileSync(path.join(b.home, bak[0]), 'utf8'), before);
  assert.equal(JSON.parse(b.read()).pricing['*/claude-x*'].output, 5);
});

test('regression: custom pricing entries (Gemini, -5-5) keep values and beat the defaults', (t) => {
  const pricing = { '*/gemini-3-pro*': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }, '*/claude-opus-5-5*': { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 } };
  const b = box(t, { pricing });
  const before = JSON.parse(b.read()).pricing;
  b.record([row('claude-opus-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })]);
  const r = b.run('usage', '--by', 'model', '--format', 'json');
  assert.match(r.stdout, /7(\.0+)?\b/);
  const list = b.run('price', 'list').stdout;
  assert.match(list, /\*\/gemini-3-pro\*/);
  assert.match(list, /\*\/claude-opus-5-5\*\s+7\s+7\s+7\s+7/);
  assert.deepEqual(JSON.parse(b.read()).pricing, before);
});

// ---- K4 batch against a stub
async function stubBatch(t) {
  const calls = [];
  const srv = http.createServer((req, res) => { let x = ''; req.on('data', (c) => (x += c)); req.on('end', () => { calls.push(`${req.method} ${req.url}`); res.end(JSON.stringify({ id: 'mb_t', processing_status: 'in_progress', request_counts: {} })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { calls, port: srv.address().port };
}
test('K4 batch submit of Haiku 4.5 is no longer refused for a missing price; a too-small cap is refused for the estimate', async (t) => {
  const s = await stubBatch(t);
  const b = box(t, { batch: { enabled: true }, adapters: { cl: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${s.port}/v1`, apiKey: 'sk-test-literal-1' } } });
  const input = path.join(b.home, 'in.jsonl');
  fs.writeFileSync(input, JSON.stringify({ custom_id: 'a', params: { model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: 'hello' }] } }) + '\n');
  const tiny = await b.runAsync('batch', 'submit', input, '--adapter', 'cl', '--name', 'tiny', '--cap-usd', '0.0001');
  assert.notEqual(tiny.status, 0);
  assert.doesNotMatch(tiny.stderr + tiny.stdout, /no price/);
  assert.match(tiny.stderr + tiny.stdout, /estimate/);
  assert.equal(s.calls.length, 0);
  const dry = await b.runAsync('batch', 'submit', input, '--adapter', 'cl', '--name', 'dry', '--cap-usd', '1', '--dry-run');
  assert.doesNotMatch(dry.stderr + dry.stdout, /no price/);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run.*estimate/);
  assert.equal(s.calls.length, 0, 'dry run must not send');
  assert.equal(fs.readdirSync(b.home, { recursive: true }).some((f) => /dry\.json$/.test(String(f))), false, 'dry run must not save a job');
  const real = await b.runAsync('batch', 'submit', input, '--adapter', 'cl', '--name', 'real', '--cap-usd', '1');
  assert.equal(real.status, 0, real.stderr);
  assert.doesNotMatch(real.stderr + real.stdout, /no price/);
});

// ---- K6
test('K6 discover: http pricingUrl refused with a message; a malformed one gives one line', async (t) => {
  for (const [url, re] of [['http://127.0.0.1:9/api/pricing', /https/i], ['not a url at all', /./]]) {
    const b = box(t, { adapters: { tr: { type: 'http', baseUrl: 'https://127.0.0.1:1/v1', apiKey: 'k', freeOnly: true } }, discovery: { enabled: true, tr: { pricingUrl: url } } });
    const r = await b.runAsync('discover', 'tr');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at |TypeError|ERR_INVALID_URL/);
    assert.equal(fs.existsSync(path.join(b.data, 'discovered', 'tr.json')), false);
  }
});

test('regression: tokenrouter-style https free-list discovery still works', async (t) => {
  const srv = await httpsServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ model_name: 'a/free1', quota_type: 0, model_price: 0, model_ratio: 0 }, { model_name: 'b/paid', quota_type: 0, model_price: 0, model_ratio: 1 }], tiered_pricing: {} }));
  });
  t.after(() => srv.close());
  const b = box(t, { adapters: { tr: { type: 'http', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', freeOnly: true } }, discovery: { enabled: true, tr: { pricingUrl: `https://127.0.0.1:${srv.address().port}/api/pricing` } } }, { NODE_EXTRA_CA_CERTS: selfSigned().file });
  const r = await b.runAsync('discover', 'tr');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.data, 'discovered', 'tr.json'), 'utf8')).ids, ['a/free1']);
});

// ---- K7 / K8 / regression of source enable
function stubSecurity(home) {
  const f = path.join(home, 'security-stub.sh');
  fs.writeFileSync(f, '#!/bin/sh\ncase " $* " in *" svc-groq "*) echo "KEY-VALUE-123"; exit 0;; esac\nexit 44\n', { mode: 0o700 });
  return f;
}
async function spy(t, makeServer) {
  const seen = [];
  const handler = (req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'big-model' }] })); };
  const srv = await makeServer(handler);
  t.after(() => srv.close());
  return { seen, port: srv.address().port };
}
const plain = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });

test('K7 source enable --models-url sends the key only for https on baseUrl\'s own origin', async (t) => {
  const other = await spy(t, httpsServer);         // https, other port
  const plainSpy = await spy(t, plain);            // http
  const same = await spy(t, httpsServer);          // https; used as baseUrl origin
  const b0 = box(t);
  const sec = stubSecurity(b0.home);
  // groq's profile baseUrl is a public host; the config entry is rewritten per case by pointing the profile at the https spy through a custom profile is not possible, so
  // the baseUrl origin cannot be 127.0.0.1: for the cross-origin cases the key must not reach the spy.
  const mk = () => box(t, {}, { KEYSMITH_SECURITY_BIN: sec, NODE_EXTRA_CA_CERTS: selfSigned().file });
  let b = mk();
  let r = await b.runAsync('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'llama-3.1-8b-instant', '--models-url', `https://127.0.0.1:${other.port}/v1/models`, '--dry-run');
  assert.equal(other.seen.length, 1, 'the list was fetched');
  assert.equal(other.seen[0].auth, undefined, 'no key to another origin');
  b = mk();
  r = await b.runAsync('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'llama-3.1-8b-instant', '--models-url', `http://127.0.0.1:${plainSpy.port}/v1/models`, '--dry-run');
  assert.equal(plainSpy.seen.length, 1);
  assert.equal(plainSpy.seen[0].auth, undefined, 'no key over http');
  assert.ok(!(r.stdout + r.stderr).includes('KEY-VALUE-123'));
  void same;
});

test('K8 source help documents --models-url and the key rule', (t) => {
  const b = box(t);
  const r = b.run('source', '--help');
  assert.match(r.stdout, /--models-url/);
  assert.match(r.stdout, /key/i);
  assert.match(r.stdout, /https/);
});

test('regression: source enable with --model and no --models-url behaves as before (dry run, key-less list)', (t) => {
  const b = box(t, {}, { KEYSMITH_SECURITY_BIN: stubSecurity(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sec-'))) });
  const before = b.read();
  const r = b.run('source', 'enable', 'tokenrouter', '--key-ref', 'svc-nope', '--dry-run');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no Keychain item/);
  assert.equal(b.read(), before);
});
