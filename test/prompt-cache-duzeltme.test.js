/**
 * Prompt caching fix round (20261117-onbellek-duzeltme): the per-model minimum table (K5), the
 * dry-run plan on the usage row and in `keysmith usage` (K6), and the wire warning (K4).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog, formatUsageTable } from '../src/usage.js';
import { MIN_TOKENS_TABLE, UNKNOWN_MODEL_MIN_TOKENS, minFor, planCache } from '../src/prompt-cache.js';

const marked = (o) => JSON.stringify(o).includes('cache_control');
const bodyOf = (tokens) => ({ system: 'x'.repeat(tokens * 4), messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
const on = { mode: 'on', ttl: '5m' };

// One real model name per table row (same order as MIN_TOKENS_TABLE).
const SAMPLES = [
  'claude-fable-5-2', 'claude-mythos-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-mythos-preview', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5',
  'claude-opus-4-8', 'claude-opus-4-1', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-20250514', 'claude-sonnet-4-5-20250929',
];

test('K5a: every table row marks just above its minimum and not just below', () => {
  assert.ok(SAMPLES.length >= MIN_TOKENS_TABLE.length - 1);
  const seen = new Set();
  for (const model of SAMPLES) {
    const min = minFor({}, model);
    seen.add(min);
    assert.ok(min < UNKNOWN_MODEL_MIN_TOKENS || min === UNKNOWN_MODEL_MIN_TOKENS);
    assert.equal(marked(planCache(bodyOf(min - 40), on, model).body), false, `${model} below ${min}`);
    assert.equal(marked(planCache(bodyOf(min + 8), on, model).body), true, `${model} above ${min}`);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [512, 1024, 2048, 4096]);
});

test('K5a: version spellings and date suffixes land on the same row', () => {
  assert.equal(minFor({}, 'claude-opus-4.5'), minFor({}, 'claude-opus-4-5-20251101'));
  assert.equal(minFor({}, 'anthropic/claude-haiku-4-5'), minFor({}, 'claude-haiku-4-5'));
  assert.notEqual(minFor({}, 'claude-sonnet-5'), minFor({}, 'claude-sonnet-5-5'));
});

test('K5b: unknown model gets the largest minimum; minTokens wins', () => {
  assert.equal(minFor({}, 'some-other-model'), Math.max(...MIN_TOKENS_TABLE.map(([, n]) => n)));
  assert.equal(minFor({}, ''), UNKNOWN_MODEL_MIN_TOKENS);
  const mid = bodyOf(1500);
  assert.equal(marked(planCache(mid, on, 'some-other-model').body), false);
  assert.equal(marked(planCache(mid, { ...on, minTokens: 100 }, 'some-other-model').body), true);
  assert.equal(marked(planCache(mid, { ...on, minTokens: 100000 }, 'claude-sonnet-5-5').body), false);
});

test('K5c: the source names the page and the date next to the table', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/prompt-cache.js'), 'utf8');
  const at = src.indexOf('MIN_TOKENS_TABLE');
  const above = src.slice(Math.max(0, at - 700), at);
  assert.match(above, /https:\/\/platform\.claude\.com\/docs\/en\/build-with-claude\/prompt-caching/);
  assert.match(above, /\d{4}-\d{2}-\d{2}/);
});

let dir, upstream, usageLog, server, gateway, baseUp, baseGw;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pcfix-'));
  upstream = http.createServer((q, r) => {
    q.resume();
    q.on('end', () => {
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  baseUp = `http://127.0.0.1:${upstream.address().port}/v1`;
  const cfg = {
    auth: { enabled: false },
    adapters: {
      ca: { kind: 'http', baseUrl: baseUp, wire: 'anthropic', apiKey: 'literal-test-value', models: ['claude-sonnet-5-5'], promptCache: { mode: 'dry-run' } },
    },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseGw = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('K6: a dry-run request writes cachePlan on its usage row; usage shows a marked estimate', async () => {
  const big = 'word '.repeat(3000);
  const res = await fetch(`${baseGw}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'ca/claude-sonnet-5-5', max_tokens: 5, system: big, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  const row = usageLog.tail(5).find((r) => r.cachePlan);
  assert.ok(row, 'a row carries cachePlan');
  assert.ok(row.cachePlan.breakpoints >= 1 && row.cachePlan.estTokens > 1000);
  const stats = usageLog.query({ by: ['model'] });
  assert.ok(stats.totals.cachePlanRequests >= 1);
  assert.ok(stats.totals.cachePlanSavingsUsd > 0);
  const txt = formatUsageTable(stats);
  assert.match(txt, /ESTIMATE/);
  assert.match(txt, /would have cached/);
});

test('K6: a request without a plan has no cachePlan field and no estimate line', () => {
  const log = new UsageLog(path.join(dir, 'plain.jsonl'));
  log.record({ status: 'ok', kind: 'http', adapter: 'a', model: 'a/claude-sonnet-5-5', usage: { input: 10, output: 1 }, ms: 1 });
  assert.equal(log.tail(1)[0].cachePlan, undefined);
  assert.doesNotMatch(formatUsageTable(log.query({ by: ['model'] })), /ESTIMATE/);
});

test('K4: checkAdapters warns for promptCache on a non-anthropic wire, not for anthropic or off', async () => {
  const mk = (a) => new Gateway({ auth: { enabled: false }, adapters: { x: { kind: 'http', baseUrl: baseUp, apiKey: 'literal-test-value', models: ['m'], ...a } } }, { log: () => {} });
  const seen = [];
  const w = await mk({ wire: 'openai', promptCache: { mode: 'on' } }).checkAdapters({ log: (m) => seen.push(m) });
  assert.equal(w.length, 1);
  assert.match(w[0], /promptCache/);
  assert.equal(seen.length, 1);
  assert.deepEqual(await mk({ wire: 'anthropic', promptCache: { mode: 'on' } }).checkAdapters(), []);
  assert.deepEqual(await mk({ wire: 'openai' }).checkAdapters(), []);
  assert.deepEqual(await mk({ wire: 'openai', promptCache: { mode: 'off' } }).checkAdapters(), []);
});
