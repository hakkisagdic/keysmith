/** Slice 2 acceptance checks (K2, K3, K5, K6) written from the request; stub upstream only. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { HTTP_PROFILES } from '../src/profiles.js';

const KEY = 'sk-s2-' + 'q1w2e3r4t5y6u7i8o9p0';
const GW = 'ks_s2gatewaykey_0123456789abcdef0123456789ab';
let dir, up, hits, mode;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s2-'));
  process.env.KEYSMITH_DATA = dir;
  up = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(req.url);
      if (mode === '429') { res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' }); return res.end('{"error":{"message":"x"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
});
after(() => { up.close(); delete process.env.KEYSMITH_DATA; fs.rmSync(dir, { recursive: true, force: true }); });

async function boot(profile, extraCfg = {}, adapterExtra = {}) {
  hits = []; mode = 'ok';
  const clock = { t: Date.parse('2026-11-16T10:00:00Z') };
  const cfg = { auth: { enabled: true, keys: [GW] }, adapters: { a: { ...structuredClone(HTTP_PROFILES[profile]), baseUrl: `http://127.0.0.1:${up.address().port}/v1`, apiKey: KEY, ...adapterExtra } }, ...extraCfg };
  const file = path.join(dir, `u-${Math.random().toString(36).slice(2)}.jsonl`);
  const usage = new UsageLog(file, { now: () => clock.t });
  const gw = new Gateway(cfg, { log: () => {}, usage, now: () => clock.t });
  const srv = createServer(gw, cfg, { usage, log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (model) => {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${GW}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const raw = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { clock, post, raw, close: () => new Promise((r) => srv.close(r)) };
}
const cat = (limits) => { const f = path.join(dir, `c-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ version: 1, sources: [{ id: 's', reach: { keysmith: 'a' }, limits, models: [{ id: 'm1', tier: 'free' }] }] })); return f; };

test('K2: an existing profile (groq) still routes and answers 200', async () => {
  const s = await boot('groq');
  try { const r = await s.post('a/llama'); assert.equal(r.status, 200, r.text); assert.equal(hits.length, 1); } finally { await s.close(); }
});

test('K3: no catalogue / freeOnly / discovery: usage lines identical to an invalid-catalogue run, no new fields', async () => {
  const run = async (extra) => { const s = await boot('groq', extra); try { await s.post('a/llama'); return s.raw().trim().split('\n').map((l) => { const o = JSON.parse(l); o.ms = 0; return o; }); } finally { await s.close(); } };
  const base = await run({});
  const bad = await run({ catalogue: path.join(dir, 'nope.json') });
  assert.deepEqual(bad, base);
  assert.equal(base.length, 1);
  for (const k of ['source', 'sourceTier', 'tier']) assert.ok(!(k in base[0]), k);
});

test('K5: minute=1 -> second request 429 + retry-after, never reaches upstream, passes after the minute', async () => {
  const s = await boot('tokenrouter', { catalogue: cat({ requestsPerMinute: 1 }) });
  try {
    assert.equal((await s.post('a/m1')).status, 200);
    const r = await s.post('a/m1');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal(hits.length, 1);
    s.clock.t += 61000;
    assert.equal((await s.post('a/m1')).status, 200);
  } finally { await s.close(); }
});

test('K5: upstream 429 -> local 429 inside cooldown, upstream untouched; open after retry-after', async () => {
  const s = await boot('tokenrouter', { catalogue: cat({ requestsPerDay: 100 }) });
  try {
    mode = '429';
    assert.equal((await s.post('a/m1')).status, 429);
    mode = 'ok';
    assert.equal((await s.post('a/m1')).status, 429);
    assert.equal(hits.length, 1);
    s.clock.t += 31000;
    assert.equal((await s.post('a/m1')).status, 200);
  } finally { await s.close(); }
});

test('K6: freeOnly rejects a non-free id; accepts after the discovered file changes, no restart', async () => {
  const { discoveredPath } = await import('../src/catalogue.js');
  const s = await boot('tokenrouter', {}, { freeOnly: true });
  const f = discoveredPath(dir, 'a');
  try {
    fs.rmSync(f, { force: true });
    assert.ok((await s.post('a/paid')).status >= 400);
    assert.equal(hits.length, 0);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ models: ['paid'], ids: ['paid'], free: ['paid'], data: [{ id: 'paid' }] }));
    const future = new Date(Date.now() + 9000); fs.utimesSync(f, future, future);
    const r = await s.post('a/paid');
    assert.equal(r.status, 200, r.text);
  } finally { await s.close(); }
});
