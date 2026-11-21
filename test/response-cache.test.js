/**
 * Exact-match response cache for non-streaming chat completions.
 *
 * Unit: LRU eviction, TTL (a read does not extend it), key canonicalisation.
 * HTTP: acceptance checks 1–9 against one gateway and a stub upstream, on an
 * injected clock. Nothing spends a token. `keysmith usage` is the real CLI,
 * pointed at the sandbox data dir.
 */
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
import { fingerprint } from '../src/redact.js';
import { ResponseCache, keyFor, resolveCacheConfig, MAX_CACHED_BYTES, CACHE_DEFAULTS } from '../src/response-cache.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');
const fakeGhp = (ch = 'a') => 'gh' + 'p_' + ch.repeat(36);
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

/** 2 prompt + 2 completion tokens at $1/token → $4. A hit must not add another $4. */
const PRICE = { 'up/m': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } };
const MISS_USD = 4;

function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 3; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of a key were printed`);
}

const chat = (content, extra = {}) => ({ model: 'up/m', messages: [{ role: 'user', content }], ...extra });

function withoutFresh(payload) {
  const { id, created, ...rest } = payload;
  return rest;
}

function lastUser(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (typeof messages[i]?.content === 'string') return messages[i].content;
  }
  if (typeof body.input === 'string') return body.input;
  return 'up answer';
}

/* ------------------------------------------------------------------- stub upstream */

async function upstreamServer(t) {
  const hits = { up: 0, err: 0, fail: false, bodies: [] };
  const up = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = {}; }
      }
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }, { id: 'e', object: 'model' }] }));
      }
      if (hits.fail) {
        hits.err++;
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'boom' } }));
      }
      hits.up++;
      hits.bodies.push({ url: req.url, raw, body });
      const answer = lastUser(body);
      if (req.url.includes('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } }));
      }
      // The openai-wire adapter always asks the upstream to stream. A tool relay sends the
      // client body as it is, so a non-stream tool request is answered as one JSON object.
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: answer } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => up.close(r)));
  return { root: `http://127.0.0.1:${up.address().port}`, hits };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * One gateway on `clock`, usage log in a fresh dir. `cache` omitted leaves the setting absent.
 * `pricing` prices `up/m` so a miss has a real dollar cost and a hit must stay at 0.
 */
async function rig(t, { keys, cache, pricing = null, clock = null, guard, spend = null, extraAdapters = null } = {}) {
  const up = await upstreamServer(t);
  const dir = tmp(t);
  const clk = clock || { t: at(2026, 11, 20, 12, 0, 0) };
  const cfg = {
    auth: { enabled: true, keys },
    limits: { streamHoldMs: 250, ...(spend ? { spend } : {}) },
    adapters: {
      up: { kind: 'http', wire: 'openai', baseUrl: `${up.root}/up/v1`, apiKey: false, models: ['m', 'e'] },
      ...(extraAdapters ? extraAdapters(up.root) : {}),
    },
  };
  if (cache !== undefined) cfg.cache = cache;
  if (guard !== undefined) cfg.guard = guard;
  if (pricing) cfg.pricing = pricing;
  const now = () => clk.t;
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now, pricing });
  const server = createServer(new Gateway(cfg), cfg, { usage, log: () => {}, now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, body, headers = {}, route = '/v1/chat/completions') => {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text && text.trim().startsWith('{')) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, text, json, headers: res.headers, cache: res.headers.get('x-keysmith-cache') };
  };
  const get = async (key, route = '/') => {
    const res = await fetch(base + route, { headers: { authorization: `Bearer ${key}` } });
    const text = await res.text();
    let json = null;
    if (text && text.trim().startsWith('{')) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, text, json };
  };
  return { hits: up.hits, dir, clock: clk, call, get, usage, base };
}

/** Two identical posts, both reaching the stub, neither carrying a cache header. */
async function assertUncached(gw, key, body, { headers = {}, route = '/v1/chat/completions', where }) {
  const n = gw.hits.up;
  const a = await gw.call(key, body, headers, route);
  const b = await gw.call(key, body, headers, route);
  assert.equal(a.status, 200, `${where} first: ${a.status} ${a.text.slice(0, 400)}`);
  assert.equal(b.status, 200, `${where} second: ${b.status} ${b.text.slice(0, 400)}`);
  assert.equal(a.cache, null, `${where}: no cache header on the first`);
  assert.equal(b.cache, null, `${where}: no cache header on the second`);
  assert.equal(gw.hits.up, n + 2, `${where}: both reached the upstream`);
  return [a, b];
}

function usageCli(dir, args) {
  const env = { ...process.env, HOME: dir, KEYSMITH_DATA: dir };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_CONFIG', 'KEYSMITH_VERBOSE']) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

/* ----------------------------------------------------------------------- units */

test('resolveCacheConfig: absent is off with the defaults; a bad value is an error and the cache stays off', () => {
  assert.deepEqual(resolveCacheConfig(undefined), { ...CACHE_DEFAULTS, error: null });
  assert.deepEqual(resolveCacheConfig(null), { ...CACHE_DEFAULTS, error: null });
  assert.deepEqual(resolveCacheConfig({ enabled: true, ttlSeconds: 30, maxEntries: 2 }), {
    enabled: true, ttlSeconds: 30, maxEntries: 2, error: null,
  });
  const off = resolveCacheConfig({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.error, null);
  for (const raw of [{ enabled: 'yes' }, { ttlSeconds: 0 }, { ttlSeconds: 1.5 }, { maxEntries: -1 }, { maxEntries: '2' }, { extra: true }, { enabled: true, ttlSeconds: 0 }, 'on', []]) {
    const got = resolveCacheConfig(raw);
    assert.equal(got.enabled, false, JSON.stringify(raw));
    assert.equal(got.ttlSeconds, CACHE_DEFAULTS.ttlSeconds);
    assert.equal(got.maxEntries, CACHE_DEFAULTS.maxEntries);
    assert.match(got.error, /response cache stays off/);
  }
});

test('keyFor: JSON key order does not matter, a changed message does, and the caller hash is part of the key', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const a = { model: 'm', temperature: 0, messages, max_tokens: 8, seed: 1 };
  const b = { seed: 1, messages: [{ content: 'hi', role: 'user' }], max_tokens: 8, model: 'm', temperature: 0, user: 'ignored', stream: false };
  const ka = keyFor({ callerHash: 'caller-a', body: a });
  assert.match(ka, /^[0-9a-f]{64}$/);
  assert.equal(ka, keyFor({ callerHash: 'caller-a', body: b }), 'key order and non-answer fields stay out of the hash');
  assert.notEqual(ka, keyFor({ callerHash: 'caller-a', body: { ...a, messages: [{ role: 'user', content: 'yo' }] } }), 'a changed message');
  assert.notEqual(ka, keyFor({ callerHash: 'caller-b', body: a }), 'a different caller hash');
  assert.notEqual(ka, keyFor({ callerHash: 'caller-a', body: { ...a, temperature: 1 } }));
  assert.notEqual(
    keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, stop: ['a', 'b'] } }),
    keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, stop: ['b', 'a'] } }),
    'array order is part of the answer',
  );
  const effort = keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, output_config: { effort: 'low', other: 1 } } });
  assert.equal(effort, keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, output_config: { other: 9, effort: 'low' } } }), 'only output_config.effort is hashed');
  assert.notEqual(effort, keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, output_config: { effort: 'high' } } }));
  assert.notEqual(ka, keyFor({ callerHash: 'caller-a', body: { ...a, reasoning_effort: 'high' } }));
  assert.notEqual(
    keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, reasoning: { effort: 'low' } } }),
    keyFor({ callerHash: 'caller-a', body: { model: 'm', messages, reasoning: { effort: 'high' } } }),
  );
});

test('ResponseCache is an LRU with a TTL the read does not extend, and it stores a clone under the size cap', () => {
  const clock = { t: 5_000 };
  const cache = ResponseCache({ maxEntries: 2, ttlMs: 1_000, now: () => clock.t });
  assert.ok(cache instanceof ResponseCache);

  const payload = { id: 'old', created: 1, n: 1 };
  assert.equal(cache.set('a', payload), true);
  payload.n = 9;
  assert.deepEqual(cache.get('a'), { id: 'old', created: 1, n: 1 }, 'set keeps its own copy');
  const got = cache.get('a');
  got.id = 'mutated';
  got.n = 3;
  assert.deepEqual(cache.get('a'), { id: 'old', created: 1, n: 1 }, 'get returns a clone');

  assert.equal(cache.set('b', { v: 'b' }), true);
  assert.equal(cache.set('c', { v: 'c' }), true); // evicts a, the least recently used
  assert.equal(cache.get('a'), null);
  assert.deepEqual(cache.get('b'), { v: 'b' }); // b becomes newest
  assert.equal(cache.set('d', { v: 'd' }), true); // evicts c, now the oldest
  assert.equal(cache.get('c'), null);
  assert.deepEqual(cache.get('b'), { v: 'b' });
  assert.deepEqual(cache.get('d'), { v: 'd' });

  // A read at t+999 is still fresh, and it does not move the expiry. t+1000 is a miss.
  clock.t = 5_000;
  const ttl = new ResponseCache({ maxEntries: 4, ttlMs: 1_000, now: () => clock.t });
  ttl.set('a', { v: 1 });
  clock.t = 5_999;
  assert.deepEqual(ttl.get('a'), { v: 1 });
  clock.t = 6_000;
  assert.equal(ttl.get('a'), null, 'ttl is measured from set, not from the last read');
  assert.deepEqual(ttl.stats(), { hits: 1, misses: 1, entries: 0 });

  // set refreshes the clock and replaces the payload.
  clock.t = 7_000;
  ttl.set('a', { v: 1 });
  clock.t = 7_800;
  assert.equal(ttl.set('a', { v: 2 }), true);
  clock.t = 8_700;
  assert.deepEqual(ttl.get('a'), { v: 2 });
  clock.t = 8_800;
  assert.equal(ttl.get('a'), null);

  // Expired rows are dropped by stats and do not occupy a slot.
  clock.t = 9_000;
  ttl.set('stale', { v: 1 });
  clock.t = 10_000;
  assert.equal(ttl.set('fresh', { v: 2 }), true);
  assert.deepEqual(ttl.stats(), { hits: 2, misses: 2, entries: 1 });
  assert.equal(ttl.get('stale'), null);
  assert.deepEqual(ttl.get('fresh'), { v: 2 });

  const huge = { text: 'x'.repeat(MAX_CACHED_BYTES) };
  assert.equal(ttl.set('big', huge), false);
  assert.equal(ttl.get('big'), null);
  assert.equal(ttl.set('nope', null), false);
  ttl.clear();
  assert.equal(ttl.get('fresh'), null);
  assert.equal(ttl.stats().entries, 0);
});

/* ------------------------------------------------------------------------ HTTP */

test('check 1: temperature 0 is stored on the miss and served on the second post, upstream called once', async (t) => {
  const key = mint();
  const clock = { t: Date.UTC(2030, 0, 2, 3, 4, 5) };
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    clock,
  });
  const body = chat('same-body', { temperature: 0 });
  const first = await gw.call(key, body);
  const second = await gw.call(key, body);
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.equal(first.json.choices[0].message.content, 'same-body');
  assert.deepEqual(withoutFresh(second.json), withoutFresh(first.json));
  assert.notEqual(second.json.id, first.json.id);
  assert.equal(second.json.created, Math.floor(clock.t / 1000), 'a hit takes created from the injected clock');
  assert.notEqual(second.json.created, first.json.created);
  assert.equal(gw.hits.up, 1, 'the second post did not call the upstream');

  const page = await gw.get(key, '/');
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /response cache: 1 hits \/ 1 misses, 1 entries/);
  assertNoKey(page.text, key, 'status page');

  const third = await gw.call(key, body);
  assert.equal(third.cache, 'hit');
  assert.notEqual(third.json.id, second.json.id);
  assert.equal(gw.hits.up, 1);
});

test('check 2: without temperature 0 and without the opt-in header, both posts reach the upstream', async (t) => {
  const key = mint();
  const gw = await rig(t, { keys: [key], cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 } });
  await assertUncached(gw, key, chat('plain'), { where: 'no temperature, no header' });
});

test('check 3: x-keysmith-cache: use caches a request that has no temperature', async (t) => {
  const key = mint();
  const gw = await rig(t, { keys: [key], cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 } });
  const body = chat('opt-in');
  const headers = { 'x-keysmith-cache': 'use' };
  const first = await gw.call(key, body, headers);
  const second = await gw.call(key, body, headers);
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.deepEqual(withoutFresh(second.json), withoutFresh(first.json));
  assert.equal(gw.hits.up, 1);
});

test('check 4: a second gateway key with the same body is a miss', async (t) => {
  const a = mint();
  const b = mint();
  const gw = await rig(t, { keys: [a, b], cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 } });
  const body = chat('shared-text', { temperature: 0 });
  const first = await gw.call(a, body);
  const other = await gw.call(b, body);
  assert.equal(first.cache, 'miss');
  assert.equal(other.cache, 'miss', 'the other key does not read the first key\'s answer');
  assert.equal(gw.hits.up, 2);
  const again = await gw.call(a, body);
  assert.equal(again.cache, 'hit');
  assert.equal(gw.hits.up, 2, 'the first key still has its own entry');
  const otherAgain = await gw.call(b, body);
  assert.equal(otherAgain.cache, 'hit');
  assert.equal(gw.hits.up, 2);
});

test('check 5: stream, tools, tool history, and a session bypass the cache; other faces are not this cache', async (t) => {
  const key = mint();
  const gw = await rig(t, { keys: [key], cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 } });
  const [s1, s2] = await assertUncached(gw, key, chat('stream-me', { temperature: 0, stream: true }), { where: 'stream' });
  assert.match(s1.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(s2.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(s1.text, /stream-me/);
  assert.match(s2.text, /stream-me/);

  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  await assertUncached(gw, key, chat('tool-me', { temperature: 0, tools }), { where: 'tools' });

  await assertUncached(gw, key, {
    model: 'up/m',
    temperature: 0,
    messages: [
      { role: 'user', content: 'hist' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '1' },
    ],
  }, { where: 'tool history' });

  await assertUncached(gw, key, chat('sess-h', { temperature: 0 }), { headers: { 'x-keysmith-session': 'sess-1' }, where: 'session header' });
  await assertUncached(gw, key, chat('sess-b', { temperature: 0, session: 'sess-2' }), { where: 'session body' });

  await assertUncached(gw, key, { model: 'up/m', max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'msg' }] }, { route: '/v1/messages', where: 'messages' });
  await assertUncached(gw, key, { model: 'up/m', input: 'resp-body', temperature: 0 }, { route: '/v1/responses', where: 'responses' });
  await assertUncached(gw, key, { model: 'up/e', input: 'embed-me' }, { route: '/v1/embeddings', where: 'embeddings' });
});

test('check 6: past ttlSeconds the next post is a miss; maxEntries 2 evicts the least recently used', async (t) => {
  const key = mint();
  const clock = { t: at(2026, 11, 20, 12, 0, 0) };
  const ttl = await rig(t, { keys: [key], cache: { enabled: true, ttlSeconds: 30, maxEntries: 10 }, clock });
  const body = chat('expires', { temperature: 0 });
  const t0 = clock.t;
  assert.equal((await ttl.call(key, body)).cache, 'miss');
  assert.equal((await ttl.call(key, body)).cache, 'hit');
  assert.equal(ttl.hits.up, 1);
  clock.t = t0 + 30_000 - 1;
  assert.equal((await ttl.call(key, body)).cache, 'hit', 'one millisecond inside the ttl is still a hit');
  assert.equal(ttl.hits.up, 1);
  clock.t = t0 + 30_000;
  const expired = await ttl.call(key, body);
  assert.equal(expired.cache, 'miss');
  assert.equal(expired.status, 200, expired.text);
  assert.equal(ttl.hits.up, 2, 'the upstream is asked again once the entry has expired');

  const lru = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 2 },
    clock: { t: at(2026, 11, 20, 13, 0, 0) },
  });
  const post = (content) => lru.call(key, chat(content, { temperature: 0 }));
  assert.equal((await post('alpha')).cache, 'miss');
  assert.equal((await post('beta')).cache, 'miss');
  assert.equal((await post('alpha')).cache, 'hit', 'reading alpha makes it the newest');
  assert.equal(lru.hits.up, 2);
  assert.equal((await post('gamma')).cache, 'miss');
  assert.equal(lru.hits.up, 3);
  const alpha = await post('alpha');
  assert.equal(alpha.cache, 'hit', 'alpha was used more recently than beta, so it stayed');
  assert.equal(alpha.json.choices[0].message.content, 'alpha');
  assert.equal(lru.hits.up, 3);
  const beta = await post('beta');
  assert.equal(beta.cache, 'miss', 'beta was the least recently used and was evicted');
  assert.equal(beta.json.choices[0].message.content, 'beta');
  assert.equal(lru.hits.up, 4);
});

test('check 7: a hit writes cache "hit" and cost 0, and keysmith usage does not charge it', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    pricing: PRICE,
  });
  const body = chat('priced', { temperature: 0 });
  const miss = await gw.call(key, body);
  const hit = await gw.call(key, body);
  assert.equal(miss.cache, 'miss');
  assert.equal(hit.cache, 'hit');
  assert.equal(gw.hits.up, 1);

  const run = usageCli(gw.dir, ['usage', '--tail', '3', '--format', 'json']);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  const entries = report.entries;
  assert.equal(entries.length, 2);
  const hitRow = entries.filter((e) => e.cache === 'hit');
  const missRow = entries.filter((e) => e.status === 'ok' && e.cache !== 'hit');
  assert.equal(hitRow.length, 1);
  assert.equal(missRow.length, 1);
  assert.equal(hitRow[0].cost.usd, 0);
  assert.equal(hitRow[0].cost.basis, 'metered');
  assert.equal(missRow[0].cost.usd, MISS_USD);
  assert.equal(missRow[0].cost.basis, 'metered');
  assert.equal(report.requests, 2, 'the hit is a request');
  assert.equal(report.meteredUsd, MISS_USD, 'the total is the miss alone');
  assert.equal(report.totals.meteredUsd, MISS_USD);
  assert.equal(report.input, 4, 'both rows keep their token counts');
  assert.equal(report.output, 4);

  const httpUsage = await gw.get(key, '/v1/keysmith/usage?tail=3');
  assert.equal(httpUsage.status, 200, httpUsage.text);
  assert.equal(httpUsage.json.entries.length, 2);
  const httpHit = httpUsage.json.entries.find((e) => e.cache === 'hit');
  const httpMiss = httpUsage.json.entries.find((e) => e.status === 'ok' && e.cache !== 'hit');
  assert.ok(httpHit, 'GET /v1/keysmith/usage?tail=3 returns the hit row');
  assert.ok(httpMiss, 'GET /v1/keysmith/usage?tail=3 returns the miss row');
  assert.deepEqual(httpHit.cost, { usd: 0, basis: 'metered' });
  assert.deepEqual(httpMiss.cost, { usd: MISS_USD, basis: 'metered' });
  assert.equal(httpUsage.json.totals.requests, 2);
  assert.equal(httpUsage.json.totals.meteredUsd, MISS_USD);

  assertNoKey(run.stdout + httpUsage.text + fs.readFileSync(gw.usage.file, 'utf8'), key, 'usage');
});

test('check 8: an upstream 500 is not cached, so the retry and the later success both reach the upstream', async (t) => {
  const key = mint();
  const gw = await rig(t, { keys: [key], cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 } });
  const body = chat('flaky', { temperature: 0 });
  gw.hits.fail = true;
  const first = await gw.call(key, body);
  const retry = await gw.call(key, body);
  assert.equal(first.status, 502, first.text);
  assert.equal(retry.status, 502, retry.text);
  assert.equal(first.cache, null);
  assert.equal(retry.cache, null);
  assert.equal(gw.hits.err, 2, 'the retry reached the upstream');
  assert.equal(gw.hits.up, 0);
  const rows = fs.readFileSync(gw.usage.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.cache !== 'hit'));

  gw.hits.fail = false;
  const ok = await gw.call(key, body);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.cache, 'miss', 'the failed attempts were not stored');
  assert.equal(gw.hits.up, 1);
  const again = await gw.call(key, body);
  assert.equal(again.cache, 'hit');
  assert.equal(gw.hits.up, 1);
});

test('check 9: with cache absent, enabled false, or invalid, nothing is cached and the status page has no cache line', async (t) => {
  for (const cache of [undefined, { enabled: false }, { enabled: 'yes', ttlSeconds: 0 }]) {
    const key = mint();
    const gw = await rig(t, { keys: [key], cache });
    await assertUncached(gw, key, chat('off', { temperature: 0 }), { where: `temperature 0, cache ${JSON.stringify(cache)}` });
    await assertUncached(gw, key, chat('off-header'), { headers: { 'x-keysmith-cache': 'use' }, where: `opt-in, cache ${JSON.stringify(cache)}` });
    const page = await gw.get(key, '/');
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.ok(!page.text.includes('response cache:'), `status page stays quiet for cache ${JSON.stringify(cache)}`);
  }
});

test('a cache hit counts as one request against perDay, and the request over the cap does not call the upstream', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [{ key, perDay: 2 }],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
  });
  const body = chat('capped', { temperature: 0 });
  const miss = await gw.call(key, body);
  const hit = await gw.call(key, body);
  assert.equal(miss.status, 200, miss.text);
  assert.equal(hit.status, 200, hit.text);
  assert.equal(miss.cache, 'miss');
  assert.equal(hit.cache, 'hit');
  assert.equal(gw.hits.up, 1);
  const over = await gw.call(key, body);
  assert.equal(over.status, 429, over.text);
  assert.equal(over.cache, null);
  assert.equal(gw.hits.up, 1, 'over the cap is refused before the cache and before the upstream');
});

test('guard.secrets: blocked prompts never reach the cache; masked prompts hash the masked body and stamp key/label/tag/bytes/guard on hits', async (t) => {
  const secret = fakeGhp('a');
  const unmaskedBody = chat(`token ${secret}`, { temperature: 0 });
  const maskedBody = chat('token [REDACTED:github-token]', { temperature: 0 });
  assert.notEqual(
    keyFor({ callerHash: 'c1', body: unmaskedBody }),
    keyFor({ callerHash: 'c1', body: maskedBody }),
    'masked and unmasked bodies do not share a cache key',
  );

  // guard.secrets = block: refused before responseCache and before upstream.
  const bKey = mint();
  const blockedGw = await rig(t, {
    keys: [bKey],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    guard: { secrets: 'block' },
  });
  const blocked1 = await blockedGw.call(bKey, unmaskedBody);
  const blocked2 = await blockedGw.call(bKey, unmaskedBody);
  assert.equal(blocked1.status, 400, blocked1.text);
  assert.equal(blocked2.status, 400, blocked2.text);
  assert.equal(blocked1.cache, null);
  assert.equal(blocked2.cache, null);
  assert.equal(blockedGw.hits.up, 0);
  const blockedPage = await blockedGw.get(bKey, '/');
  assert.match(blockedPage.text, /response cache: 0 hits \/ 0 misses, 0 entries/);

  // guard.secrets = mask: hashed after masking, and hit rows go through stamped usage.
  const mKey = mint();
  const fp = `fp:${fingerprint(mKey)}`;
  const maskedGw = await rig(t, {
    keys: [{ key: mKey, label: 'ops' }],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    guard: { secrets: 'mask' },
    pricing: PRICE,
  });
  const miss = await maskedGw.call(mKey, unmaskedBody, { 'x-keysmith-tag': 'ci-miss' });
  assert.equal(miss.status, 200, miss.text);
  assert.equal(miss.cache, 'miss');
  assert.equal(maskedGw.hits.up, 1);
  assert.match(maskedGw.hits.bodies[0].raw, /\[REDACTED:github-token\]/);
  assert.ok(!maskedGw.hits.bodies[0].raw.includes(secret.slice(4, 16)), 'upstream never saw the secret');

  const hit = await maskedGw.call(mKey, unmaskedBody, { 'x-keysmith-tag': 'ci-hit' });
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.cache, 'hit');
  assert.equal(maskedGw.hits.up, 1);
  assert.equal(hit.json.choices[0].message.content, 'token [REDACTED:github-token]');

  // Sending the already-masked text hits the same entry because keyFor hashed the masked body.
  const hitPreMasked = await maskedGw.call(mKey, maskedBody, { 'x-keysmith-tag': 'ci-pre' });
  assert.equal(hitPreMasked.status, 200, hitPreMasked.text);
  assert.equal(hitPreMasked.cache, 'hit');
  assert.equal(maskedGw.hits.up, 1);

  const rawLog = fs.readFileSync(maskedGw.usage.file, 'utf8');
  assert.ok(!rawLog.includes(secret.slice(4, 16)), 'usage.jsonl holds no secret fragment');
  assertNoKey(rawLog, mKey, 'masked usage.jsonl');
  const rows = rawLog.trim().split('\n').map((l) => JSON.parse(l));
  const hitStamped = rows.find((r) => r.tag === 'ci-hit');
  assert.ok(hitStamped, 'the masked hit row was recorded');
  assert.equal(hitStamped.cache, 'hit');
  assert.equal(hitStamped.key, fp);
  assert.equal(hitStamped.label, 'ops');
  assert.equal(hitStamped.adapter, 'up');
  assert.equal(hitStamped.kind, 'http');
  assert.equal(hitStamped.face, 'chat');
  assert.ok(hitStamped.bytesIn > 0);
  assert.ok(hitStamped.bytesOut > 0);
  assert.equal(hitStamped.guard, 'masked');
  assert.deepEqual(hitStamped.guardKinds, ['github-token']);
  assert.deepEqual(hitStamped.cost, { usd: 0, basis: 'metered' });
});

test('usage filters (--min-cost, --status, --tag, --key, --model) and CLI table/csv totals handle cache "hit" rows cleanly', async (t) => {
  const key = mint();
  const fp = `fp:${fingerprint(key)}`;
  const gw = await rig(t, {
    keys: [{ key, label: 'dev' }],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    pricing: PRICE,
  });
  // Write matching config.json into gw.dir so CLI `keysmith usage` picks up pricing too.
  const cfgPath = path.join(gw.dir, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfgPath, JSON.stringify({ auth: { enabled: true, keys: [{ key, label: 'dev' }] }, pricing: PRICE }), { mode: 0o600 });

  const body = chat('filter-me', { temperature: 0 });
  assert.equal((await gw.call(key, body, { 'x-keysmith-tag': 'eval' })).cache, 'miss');
  assert.equal((await gw.call(key, body, { 'x-keysmith-tag': 'eval' })).cache, 'hit');

  // min_cost=0 includes both the $0 hit and the $4 miss, with 0 unpriced rows.
  const httpZero = await gw.get(key, `/v1/keysmith/usage?tail=5&status=ok&tag=eval&key=${fp}&model=up/m&min_cost=0`);
  assert.equal(httpZero.status, 200, httpZero.text);
  assert.equal(httpZero.json.entries.length, 2);
  assert.equal(httpZero.json.entries.some((e) => e.cache === 'hit' && e.cost.usd === 0), true);
  assert.equal(httpZero.json.entriesUnpriced, 0);
  assert.equal(httpZero.json.totals.requests, 2);
  assert.equal(httpZero.json.totals.meteredUsd, MISS_USD);

  // min_cost=1 filters out the $0 hit without counting it as unpriced; aggregates stay whole-log.
  const httpOne = await gw.get(key, '/v1/keysmith/usage?tail=5&min_cost=1');
  assert.equal(httpOne.status, 200, httpOne.text);
  assert.equal(httpOne.json.entries.length, 1);
  assert.equal(httpOne.json.entries[0].cache, undefined);
  assert.equal(httpOne.json.entries[0].cost.usd, MISS_USD);
  assert.equal(httpOne.json.entriesUnpriced, 0);
  assert.equal(httpOne.json.totals.requests, 2);
  assert.equal(httpOne.json.totals.meteredUsd, MISS_USD);

  // CLI --min-cost 0 and --min-cost 1 JSON, plus default table and CSV formats.
  const cliZero = usageCli(gw.dir, ['usage', '--tail', '5', '--status', 'ok', '--tag', 'eval', '--key', fp, '--model', 'up/m', '--min-cost', '0', '--format', 'json']);
  assert.equal(cliZero.status, 0, cliZero.stderr || cliZero.stdout);
  const parsedZero = JSON.parse(cliZero.stdout);
  assert.equal(parsedZero.entries.length, 2);
  assert.equal(parsedZero.entries.some((e) => e.cache === 'hit'), true);
  assert.equal(parsedZero.entriesUnpriced, 0);
  assert.equal(parsedZero.totals.meteredUsd, MISS_USD);

  const cliOne = usageCli(gw.dir, ['usage', '--tail', '5', '--min-cost', '1', '--format', 'json']);
  assert.equal(cliOne.status, 0, cliOne.stderr || cliOne.stdout);
  const parsedOne = JSON.parse(cliOne.stdout);
  assert.equal(parsedOne.entries.length, 1);
  assert.equal(parsedOne.entries[0].cost.usd, MISS_USD);
  assert.equal(parsedOne.entriesUnpriced, 0);

  const cliTable = usageCli(gw.dir, ['usage', '--tail', '5', '--min-cost', '0']);
  assert.equal(cliTable.status, 0, cliTable.stderr || cliTable.stdout);
  assert.match(cliTable.stdout, /requests: 2 /);
  assert.match(cliTable.stdout, /metered: \$4\.00/);
  assert.match(cliTable.stdout, /unpriced: 0 left out/);

  const cliCsv = usageCli(gw.dir, ['usage', '--format', 'csv']);
  assert.equal(cliCsv.status, 0, cliCsv.stderr || cliCsv.stdout);
  assert.match(cliCsv.stdout, /^total,2,0,4,4,0,0,4,/m);
});

test('a cache hit reserves no spend via holdSpend and adds nothing to limits.spend', async (t) => {
  const key = mint();
  // Cap is $4 — exact cost of one miss. A cached hit ($0) still succeeds; a new miss is 429.
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    pricing: PRICE,
    spend: { up: MISS_USD },
  });
  const body = chat('spend-capped', { temperature: 0 });
  const miss = await gw.call(key, body);
  assert.equal(miss.status, 200, miss.text);
  assert.equal(miss.cache, 'miss');
  assert.equal(gw.hits.up, 1);

  const hit = await gw.call(key, body);
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.cache, 'hit');
  assert.equal(gw.hits.up, 1);
  assert.equal(gw.usage._spendState?.reservedByAdapter?.size || 0, 0, 'nothing left reserved');
  const [summary] = gw.usage.spendSummary({ up: MISS_USD }, { adapters: { up: {} } });
  assert.equal(summary.spent, MISS_USD);
  assert.equal(summary.exceeded, true);

  const secondDistinct = await gw.call(key, chat('new-prompt', { temperature: 0 }));
  assert.equal(secondDistinct.status, 429, secondDistinct.text);
  assert.equal(secondDistinct.cache, null);
  assert.equal(gw.hits.up, 1);
});

test('keysmith doctor reports invalid cache settings, and x-harness-id resolves model before keyFor', async (t) => {
  const key = mint();
  const dir = tmp(t);
  const cfgPath = path.join(dir, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });

  fs.writeFileSync(cfgPath, JSON.stringify({ auth: { enabled: true, keys: [key] }, cache: { enabled: 'yes', ttlSeconds: 0 } }), { mode: 0o600 });
  const badDoc = usageCli(dir, ['doctor']);
  assert.match(badDoc.stdout + badDoc.stderr, /cache.*response cache stays off/);

  fs.writeFileSync(cfgPath, JSON.stringify({ auth: { enabled: true, keys: [key] }, cache: { enabled: true, ttlSeconds: 60, maxEntries: 10 } }), { mode: 0o600 });
  const okDoc = usageCli(dir, ['doctor']);
  assert.doesNotMatch(okDoc.stdout + okDoc.stderr, /response cache stays off/);

  // Two adapters serving bare model `m`: x-harness-id selects different resolved models, so they must not collide.
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    extraAdapters: (root) => ({
      up2: { kind: 'http', wire: 'openai', baseUrl: `${root}/up2/v1`, apiKey: false, models: ['m'] },
    }),
  });
  const bare = { model: 'm', messages: [{ role: 'user', content: 'same' }], temperature: 0 };
  const fromUp = await gw.call(key, bare, { 'x-harness-id': 'up' });
  const fromUp2 = await gw.call(key, bare, { 'x-harness-id': 'up2' });
  assert.equal(fromUp.cache, 'miss');
  assert.equal(fromUp.json.model, 'up/m');
  assert.equal(fromUp2.cache, 'miss', 'different x-harness-id resolves to a different model and must not read up\'s entry');
  assert.equal(fromUp2.json.model, 'up2/m');
  assert.equal(gw.hits.up, 2);
});
