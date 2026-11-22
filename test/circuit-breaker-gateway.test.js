/**
 * The circuit breaker inside the failover walk, with stub upstreams (K2-K7): an alias of two
 * HTTP adapters, one that fails, one that answers; the clock is injected. Nothing real is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');

/** One stub, many upstreams: /<id>/v1/...; `mode[id]` is a status to fail with, or 'ok'. */
async function stub(t) {
  const hits = {};
  const mode = {};
  const delay = {};
  const srv = http.createServer((req, res) => {
    const id = req.url.split('/')[1];
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }));
      }
      hits[id] = (hits[id] || 0) + 1;
      if (delay[id]) await new Promise((r) => setTimeout(r, delay[id]));
      const m = mode[id] ?? 'ok';
      if (m !== 'ok') {
        res.writeHead(m, { 'content-type': 'application/json', ...(m === 429 ? { 'retry-after': '120' } : {}) });
        return res.end(JSON.stringify({ error: { message: 'no' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: `from ${id}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { root: `http://127.0.0.1:${srv.address().port}`, hits, mode, delay };
}

async function rig(t, { circuitBreaker, ids = ['a', 'b'], alias = ['a/m', 'b/m'], scoped = false } = {}) {
  const up = await stub(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-breaker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = mint();
  const scopedKey = mint();
  const clock = { t: Date.UTC(2026, 10, 22, 12, 0, 0) };
  const now = () => clock.t;
  const cfg = {
    auth: { enabled: true, keys: [key, ...(scoped ? [{ key: scopedKey, models: ['a/m'] }] : [])] },
    limits: { streamHoldMs: 250 },
    adapters: Object.fromEntries(ids.map((id) => [id, { kind: 'http', wire: 'openai', baseUrl: `${up.root}/${id}/v1`, apiKey: false, models: ['m'] }])),
    aliases: { route: alias },
  };
  if (circuitBreaker !== undefined) cfg.circuitBreaker = circuitBreaker;
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now });
  const gateway = new Gateway(cfg, { now, log: () => {} });
  const server = createServer(gateway, cfg, { usage, log: () => {}, now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (model = 'route', k = key) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (route, k = key, method = 'GET') => {
    const res = await fetch(base + route, { method, headers: { authorization: `Bearer ${k}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { up, clock, ask, get, key, scopedKey, usage, gateway };
}

const rows = (r) => r.usage.tail(50); // newest first

test('K2: after the threshold the dead adapter is not asked; the row says circuit_open', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 30_000 } });
  r.up.mode.a = 503;
  for (let i = 0; i < 2; i++) {
    const x = await r.ask();
    assert.equal(x.status, 200);
    assert.match(x.body.choices[0].message.content, /from b/);
  }
  assert.equal(r.up.hits.a, 2);
  const x = await r.ask();
  assert.equal(x.status, 200);
  assert.equal(r.up.hits.a, 2, 'the third request did not ask a');
  assert.equal(r.up.hits.b, 3);
  const last = rows(r)[0]; // newest first
  const skip = last.skippedLegs.find((s) => s.reason === 'circuit_open');
  assert.equal(skip.target, 'a/m');
  assert.ok(skip.retryAfterMs > 0);
  // After the cooldown a probe goes to a; it still fails, so it is passed by again.
  r.clock.t += 30_000;
  await r.ask();
  assert.equal(r.up.hits.a, 3);
  await r.ask();
  assert.equal(r.up.hits.a, 3);
  // Recovery: the next probe succeeds and a is first again.
  r.up.mode.a = 'ok';
  r.clock.t += 30_000;
  const y = await r.ask();
  assert.match(y.body.choices[0].message.content, /from a/);
  const z = await r.ask();
  assert.match(z.body.choices[0].message.content, /from a/);
});

test('K3: 400 and 401 never open the breaker', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 2 } });
  for (const code of [400, 401]) {
    r.up.mode.a = code;
    for (let i = 0; i < 5; i++) await r.ask();
  }
  assert.equal(r.up.hits.a, 10, 'a was asked every time');
  const { body } = await r.get('/v1/keysmith/breakers');
  assert.ok(body.breakers.every((b) => b.state === 'closed'));
});

test('K4: a single-leg route to an open adapter is still sent, and a success closes it', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 2 }, alias: ['a/m'] });
  r.up.mode.a = 503;
  await r.ask();
  await r.ask();
  assert.equal((await r.get('/v1/keysmith/breakers')).body.breakers[0].state, 'open');
  r.up.mode.a = 'ok';
  const x = await r.ask('a/m');
  assert.equal(x.status, 200);
  assert.equal(r.up.hits.a, 3, 'the open adapter was asked as the probe');
  assert.equal((await r.get('/v1/keysmith/breakers')).body.breakers[0].state, 'closed');
});

test('K5: every leg open: the one whose cooldown ends first is asked', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 1, cooldownMs: 60_000 } });
  r.up.mode.a = 503;
  r.up.mode.b = 503;
  await r.ask(); // a fails, b fails: both open, a first
  r.clock.t += 10_000;
  const before = { ...r.up.hits };
  r.up.mode.a = 'ok';
  const x = await r.ask();
  assert.equal(x.status, 200, 'the route did not fail without asking anyone');
  assert.equal(r.up.hits.a, before.a + 1, 'a (earliest end) was asked');
  assert.equal(r.up.hits.b, before.b, 'b was not');
});

test('two concurrent requests in half-open send one probe', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 1 }, alias: ['a/m', 'b/m'] });
  r.up.mode.a = 503;
  await r.ask();
  r.up.mode.a = 'ok';
  r.up.delay.a = 150;
  r.clock.t += 30_000;
  const before = r.up.hits.a;
  const [x, y] = await Promise.all([r.ask(), r.ask()]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  assert.equal(r.up.hits.a - before, 1, 'one probe only');
});

test('K6: GET /v1/keysmith/breakers lists the open adapter; a scoped key gets 403; reset closes', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 1 }, scoped: true });
  r.up.mode.a = 503;
  await r.ask();
  const { status, body } = await r.get('/v1/keysmith/breakers');
  assert.equal(status, 200);
  const a = body.breakers.find((b) => b.adapter === 'a');
  assert.equal(a.state, 'open');
  assert.ok(a.retryAfterMs > 0);
  assert.ok(!JSON.stringify(body).includes('no"'), 'no upstream error text');
  assert.equal((await r.get('/v1/keysmith/breakers', r.scopedKey)).status, 403);
  assert.equal((await r.get('/v1/keysmith/breakers/reset', r.scopedKey, 'POST')).status, 403);
  assert.equal((await r.get('/v1/keysmith/breakers/reset', r.key, 'POST')).body.reset, 1);
  assert.equal((await r.get('/v1/keysmith/breakers')).body.breakers.length, 0);
});

test('K7: with the config key absent nothing is skipped, nothing recorded, no new row fields', async (t) => {
  const r = await rig(t);
  r.up.mode.a = 503;
  for (let i = 0; i < 6; i++) assert.equal((await r.ask()).status, 200);
  assert.equal(r.up.hits.a, 6, 'a is asked every time');
  for (const row of rows(r)) {
    assert.ok(!JSON.stringify(row).includes('circuit'), 'no breaker field on a row');
  }
  const { body } = await r.get('/v1/keysmith/breakers');
  assert.deepEqual(body, { enabled: false, breakers: [] });
});

test('an invalid circuitBreaker value leaves the gateway as it was', async (t) => {
  const r = await rig(t, { circuitBreaker: { enabled: true, failureThreshold: 0 } });
  r.up.mode.a = 503;
  for (let i = 0; i < 5; i++) await r.ask();
  assert.equal(r.up.hits.a, 5);
});
