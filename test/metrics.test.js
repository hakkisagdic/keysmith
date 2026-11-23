/**
 * GET /v1/keysmith/metrics: Prometheus text for the rolling usage window.
 * K5 and K7 call the pure formatter. K1–K4 and K6 boot a gateway in front of a
 * local stub. Keys are minted at run time. Nothing here reaches a real provider.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { formatPrometheus } from '../src/metrics.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const GW = mint();
const OTHER = mint();
const SCOPED = mint();
const CAPPED = mint();

// The brief's `[a-z_]+` cannot match `keysmith_latency_p95_ms`. Prometheus names
// may contain digits after the first character. The rest of the check is unchanged:
// optional labels, then a plain integer or decimal (no NaN, no exponent).
const SAMPLE = /^[a-z_][a-z0-9_]*(\{.*\})? -?\d+(\.\d+)?$/;

let dir, upstream;

function upstreamHandler(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (body?.messages?.[0]?.content === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"boom"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-metrics-'));
  upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(keys = [GW]) {
  const file = path.join(dir, `usage-${crypto.randomBytes(4).toString('hex')}.jsonl`);
  const cfg = {
    auth: { enabled: true, keys },
    adapters: {
      up: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: false,
        models: ['m', 'other'],
      },
    },
  };
  const usage = new UsageLog(file);
  const gateway = new Gateway(cfg, { usage });
  const server = createServer(gateway, cfg, { usage });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = async (key, model, content = 'hi') => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
    });
    return { status: res.status, text: await res.text() };
  };
  const metrics = async (key, query = '') => {
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const res = await fetch(`${base}/v1/keysmith/metrics${query}`, { headers });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { chat, metrics, close: () => new Promise((r) => server.close(r)) };
}

function assertExposition(text) {
  assert.match(text, /rolling window/);
  assert.match(text, /not a counter/);
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('#')) continue;
    assert.match(line, SAMPLE, line);
  }
  assert.ok(!text.includes('NaN'));
}

test('K1: an authenticated scrape is Prometheus text', async () => {
  const s = await boot();
  try {
    const res = await s.metrics(GW);
    assert.equal(res.status, 200, res.text);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.startsWith('text/plain'), ct);
    assert.ok(ct.includes('version=0.0.4'), ct);
    assert.match(res.text, /# TYPE keysmith_requests gauge/);
    assert.match(res.text, /^keysmith_window_hours 24$/m);
    assertExposition(res.text);
  } finally { await s.close(); }
});

test('K2: two calls to up/m, one of them failing, show requests 2 and failures 1', async () => {
  const s = await boot();
  try {
    assert.equal((await s.chat(GW, 'up/m', 'hi')).status, 200);
    const failed = await s.chat(GW, 'up/m', 'fail');
    assert.ok(failed.status >= 400, failed.text);
    const res = await s.metrics(GW);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /keysmith_requests\{model="up\/m"\} 2/);
    assert.match(res.text, /keysmith_failures\{model="up\/m"\} 1/);
  } finally { await s.close(); }
});

test('K3: no Authorization header is 401 and the body has no metrics', async () => {
  const s = await boot();
  try {
    const res = await s.metrics(null);
    assert.equal(res.status, 401, res.text);
    assert.ok(!res.text.includes('keysmith_'));
    assert.ok(!res.text.includes('# TYPE'));
    assert.ok(!res.text.includes('# HELP'));
  } finally { await s.close(); }
});

test('K4: a scoped key sees only the models of its own rows', async () => {
  const s = await boot([OTHER, { key: SCOPED, label: 'ada', allow: ['up'] }]);
  try {
    assert.equal((await s.chat(SCOPED, 'up/m')).status, 200);
    assert.equal((await s.chat(OTHER, 'up/other')).status, 200);
    const mine = await s.metrics(SCOPED);
    assert.equal(mine.status, 200, mine.text);
    assert.match(mine.text, /keysmith_requests\{model="up\/m"\} /);
    assert.ok(!mine.text.includes('up/other'), mine.text);
    assert.ok(!mine.text.includes('fp:'), mine.text);
    const theirs = await s.metrics(OTHER);
    assert.match(theirs.text, /model="up\/other"/);
  } finally { await s.close(); }
});

test('K5: label values are escaped and null numbers are left out', () => {
  const model = `q${'"'}nl${'\n'}bs${'\\'}end`;
  const text = formatPrometheus({
    groups: [{
      model,
      requests: 1,
      failures: null,
      refused: 0,
      tokensIn: 4,
      tokensOut: null,
      meteredUsd: null,
      listUsd: 1.5,
      p95Ms: 8,
    }, {
      model: 'tiny',
      requests: 1,
      failures: 0,
      refused: 0,
      tokensIn: null,
      tokensOut: null,
      meteredUsd: 1e-9,
      listUsd: null,
      p95Ms: null,
    }],
  }, { windowHours: 24 });

  const expectedLabel = `model="${'q\\"' + 'nl\\n' + 'bs\\\\' + 'end'}"`;
  const samples = text.trim().split('\n').filter((l) => !l.startsWith('#'));
  const requests = samples.find((l) => l.startsWith('keysmith_requests{'));
  assert.equal(requests, `keysmith_requests{${expectedLabel}} 1`);
  assert.ok(!requests.includes('\n'));
  assert.ok(!samples.some((l) => l.startsWith('keysmith_failures{') && l.includes('\\n')));
  assert.ok(samples.includes('keysmith_failures{model="tiny"} 0'));
  assert.ok(!samples.some((l) => l.startsWith('keysmith_tokens_out')));
  assert.ok(samples.includes(`keysmith_cost_usd{${expectedLabel},kind="list"} 1.5`));
  assert.ok(!samples.some((l) => l.includes(expectedLabel) && l.includes('kind="metered"')));
  assert.ok(samples.includes('keysmith_cost_usd{model="tiny",kind="metered"} 0.000000001'));
  assert.ok(samples.includes(`keysmith_tokens_in{${expectedLabel}} 4`));
  assertExposition(text);
});

test('K6: a bad hours value is 400, and metrics does not spend perDay', async () => {
  const s = await boot([{ key: CAPPED, perDay: 1 }]);
  try {
    const bad = await s.metrics(CAPPED, '?hours=abc');
    assert.equal(bad.status, 400, bad.text);
    assert.ok(!bad.text.includes('keysmith_'));
    assert.ok(!bad.text.includes('# TYPE'));
    const first = await s.metrics(CAPPED);
    const second = await s.metrics(CAPPED);
    assert.equal(first.status, 200, first.text);
    assert.equal(second.status, 200, second.text);
    const chat = await s.chat(CAPPED, 'up/m');
    assert.equal(chat.status, 200, chat.text);
  } finally { await s.close(); }
});

test('K7: an empty report is HELP/TYPE lines and the window gauge only', () => {
  const text = formatPrometheus({ groups: [] }, { windowHours: 24 });
  const samples = text.trim().split('\n').filter((l) => !l.startsWith('#'));
  assert.deepEqual(samples, ['keysmith_window_hours 24']);
  for (const name of [
    'keysmith_requests',
    'keysmith_failures',
    'keysmith_refused',
    'keysmith_tokens_in',
    'keysmith_tokens_out',
    'keysmith_cost_usd',
    'keysmith_latency_p95_ms',
    'keysmith_window_hours',
  ]) {
    assert.match(text, new RegExp(`# HELP ${name} `));
    assert.match(text, new RegExp(`# TYPE ${name} gauge`));
  }
  assertExposition(text);
});
