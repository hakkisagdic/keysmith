/**
 * The hot path of the catalogue: local limits, freeOnly, row fields. Against a local stub
 * upstream; nothing here reaches a real provider.
 */
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
import { discoveredPath, writeDiscovered } from '../src/catalogue.js';

const KEY = 'sk-test-' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const GW = 'ks_testgatewaykey_0123456789abcdef0123456789';

let dir, upstream, prevData, hits, stub429;
const logs = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-cat-'));
  prevData = process.env.KEYSMITH_DATA;
  process.env.KEYSMITH_DATA = dir;
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(req.url);
      if (stub429) { res.writeHead(429, { 'retry-after': '5', 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, model: body.model })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => upstream.close(r));
  if (prevData === undefined) delete process.env.KEYSMITH_DATA; else process.env.KEYSMITH_DATA = prevData;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(extra = {}, adapterExtra = {}) {
  hits = []; stub429 = false;
  const clock = { t: Date.parse('2026-11-16T10:00:00Z') };
  const cfg = {
    auth: { enabled: true, keys: [GW] },
    adapters: { tr: { ...structuredClone(HTTP_PROFILES.tokenrouter), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: KEY, ...adapterExtra } },
    ...extra,
  };
  const file = path.join(dir, `usage-${Math.random().toString(36).slice(2)}.jsonl`);
  const usage = new UsageLog(file, { now: () => clock.t });
  const gateway = new Gateway(cfg, { log: (m) => logs.push(m), usage, now: () => clock.t });
  const server = createServer(gateway, cfg, { usage, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (model) => {
    const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${GW}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  const rows = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { clock, post, rows, close: () => new Promise((r) => server.close(r)) };
}

function writeCatalogue(limits, models = [{ id: 'm1', tier: 'free' }]) {
  const f = path.join(dir, `cat-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ version: 1, sources: [{ id: 'tokenrouter-src', reach: { keysmith: 'tr' }, limits, models }] }));
  return f;
}

test('K5: a per-minute limit answers 429 with retry-after, then recovers when the clock moves', async () => {
  const s = await boot({ catalogue: writeCatalogue({ requestsPerMinute: 1 }) });
  try {
    assert.equal((await s.post('tr/m1')).status, 200);
    const second = await s.post('tr/m1');
    assert.equal(second.status, 429, second.text);
    assert.ok(Number(second.headers.get('retry-after')) >= 1);
    assert.equal(hits.length, 1, 'the refused request never reached the upstream');
    s.clock.t += 61_000;
    assert.equal((await s.post('tr/m1')).status, 200);
  } finally { await s.close(); }
});

test('K5: an upstream 429 starts a cooldown that refuses locally', async () => {
  const s = await boot({ catalogue: writeCatalogue({ requestsPerDay: 1000 }) });
  try {
    stub429 = true;
    assert.equal((await s.post('tr/m1')).status, 429);
    assert.equal(hits.length, 1);
    stub429 = false;
    const during = await s.post('tr/m1');
    assert.equal(during.status, 429);
    assert.equal(hits.length, 1, 'inside the cooldown the upstream is not called');
    s.clock.t += 6_000;
    assert.equal((await s.post('tr/m1')).status, 200);
  } finally { await s.close(); }
});

test('K6: freeOnly refuses an id off the discovered list and follows the file without a restart', async () => {
  const s = await boot({}, { freeOnly: true });
  const file = discoveredPath(dir, 'tr');
  try {
    fs.rmSync(file, { force: true });
    const no = await s.post('tr/m1');
    assert.equal(no.status, 400, no.text);
    assert.match(no.text, /not on the discovered free list/);
    assert.equal(hits.length, 0);
    writeDiscovered(file, ['other']);
    assert.equal((await s.post('tr/m1')).status, 400);
    const future = new Date(Date.now() + 5000);
    writeDiscovered(file, ['m1']);
    fs.utimesSync(file, future, future);
    assert.equal((await s.post('tr/m1')).status, 200);
  } finally { await s.close(); }
});

test('K3: without a usable catalogue the usage row is the same as with none, and has no source fields', async () => {
  const norm = (rows) => rows.map((r) => ({ ...r, ms: 0 }));
  const a = await boot({});
  let rowsA;
  try { await a.post('tr/m1'); rowsA = norm(a.rows()); } finally { await a.close(); }
  const b = await boot({ catalogue: path.join(dir, 'does-not-exist.json') });
  let rowsB;
  try { await b.post('tr/m1'); rowsB = norm(b.rows()); } finally { await b.close(); }
  assert.ok(rowsA.length >= 1);
  assert.equal(JSON.stringify(rowsB), JSON.stringify(rowsA));
  assert.ok(!('source' in rowsA[0]) && !('sourceTier' in rowsA[0]));
});

test('a catalogued model stamps source and sourceTier on the row', async () => {
  const s = await boot({ catalogue: writeCatalogue({ requestsPerMinute: 50 }) });
  try {
    await s.post('tr/m1');
    const row = s.rows().at(-1);
    assert.equal(row.source, 'tokenrouter-src');
    assert.equal(row.sourceTier, 'free');
  } finally { await s.close(); }
});

test('the key never shows in the log lines', async () => {
  assert.ok(logs.length >= 0);
  for (const l of logs) assert.ok(!String(l).includes(KEY));
});

test('the new profiles exist and the old ones are untouched', () => {
  assert.equal(HTTP_PROFILES.tokenrouter.baseUrl, 'https://api.tokenrouter.com/v1');
  assert.equal(HTTP_PROFILES.mistral.baseUrl, 'https://api.mistral.ai/v1');
  assert.equal(HTTP_PROFILES.groq.baseUrl, 'https://api.groq.com/openai/v1');
});

test('modelsOnly: a model off the declared list is a 400 before the limiter and the upstream', async () => {
  const s = await boot({ catalogue: writeCatalogue({ requestsPerDay: 1000 }) }, { modelsOnly: true, models: ['m1'] });
  try {
    const no = await s.post('tr/big-paid-model');
    assert.equal(no.status, 400, no.text);
    assert.equal(hits.length, 0, 'the upstream never saw it');
    assert.equal((await s.post('tr/m1')).status, 200);
    assert.equal(hits.length, 1);
  } finally { await s.close(); }
});
