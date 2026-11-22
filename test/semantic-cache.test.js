/**
 * Opt-in semantic cache layer (on top of exact response cache).
 *
 * Unit: sparse vector, cosine, guard tokens, 4 KB & term caps, text-free shape/vector
 * isolation, config validation, LRU/TTL index cleanup, and maxProbe bound.
 * HTTP & CLI: acceptance checks 1–10 against one gateway and a stub upstream on an
 * injected clock. Synthetic prompts only; zero network calls.
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
import {
  CACHE_DEFAULTS,
  ResponseCache,
  SEMANTIC_DEFAULTS,
  keyFor,
  resolveCacheConfig,
  shapeFor,
} from '../src/response-cache.js';
import {
  MAX_INPUT_BYTES,
  MAX_VECTOR_TERMS,
  buildVector,
  cosine,
  guardTokens,
  lastUserText,
} from '../src/semantic-vector.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');
const fakeGhp = (ch = 'b') => 'gh' + 'p_' + ch.repeat(36);
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

const PRICE = { 'up/m': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } };
const MISS_USD = 4;

const chat = (content, extra = {}) => ({ model: 'up/m', messages: [{ role: 'user', content }], ...extra });

function lastUser(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const texts = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean);
      if (texts.length) return texts.join(' ');
    }
  }
  if (typeof body.input === 'string') return body.input;
  return 'up answer';
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-semcache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function upstreamServer(t) {
  const hits = { up: 0, bodies: [] };
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
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }, { id: 'm2', object: 'model' }, { id: 'e', object: 'model' }] }));
      }
      hits.up++;
      hits.bodies.push({ url: req.url, raw, body });
      const answer = lastUser(body);
      if (req.url.includes('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], model: body.model, usage: { prompt_tokens: 2, total_tokens: 2 } }));
      }
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

async function rig(t, { keys, cache, pricing = null, clock = null, guard, spend = null, extraAdapters = null } = {}) {
  const up = await upstreamServer(t);
  const dir = tmp(t);
  const clk = clock || { t: at(2026, 11, 22, 10, 0, 0) };
  const cfg = {
    auth: { enabled: true, keys },
    limits: { streamHoldMs: 250, ...(spend ? { spend } : {}) },
    adapters: {
      up: { kind: 'http', wire: 'openai', baseUrl: `${up.root}/up/v1`, apiKey: false, models: ['m', 'm2', 'e'] },
      ...(extraAdapters ? extraAdapters(up.root) : {}),
    },
  };
  if (cache !== undefined) cfg.cache = cache;
  if (guard !== undefined) cfg.guard = guard;
  if (pricing) cfg.pricing = pricing;
  const now = () => clk.t;
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now, pricing });
  const logs = [];
  const server = createServer(new Gateway(cfg), cfg, { usage, log: (m) => logs.push(m), now });
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
  return { hits: up.hits, dir, clock: clk, call, get, usage, logs };
}

function runCli(dir, args) {
  const env = { ...process.env, HOME: dir, KEYSMITH_DATA: dir };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_CONFIG', 'KEYSMITH_VERBOSE']) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

/* ---------------------------------------------------------- check 1: vector & config unit tests */

test('check 1a: buildVector, cosine, and 4 KB / term / text-free invariants', () => {
  const v1 = buildVector('What is the refund policy for annual plans?');
  const v2 = buildVector("what's the refund policy for the annual plan");
  assert.ok(cosine(v1, v2) >= 0.92, `expected paraphrase cosine >= 0.92, got ${cosine(v1, v2)}`);
  assert.equal(v1.guardHash, v2.guardHash);

  const tr1 = buildVector('Keysmith aylık kurumsal abonelik fiyatları ve KDV oranı nedir?');
  const tr2 = buildVector('Keysmith aylık kurumsal abonelik fiyatı ve KDV oranı nedir');
  assert.ok(cosine(tr1, tr2) >= 0.92, `expected Turkish paraphrase >= 0.92, got ${cosine(tr1, tr2)}`);

  const trUpper = buildVector('İSTANBUL ŞUBESİ');
  const trLower = buildVector('istanbul şubesi');
  assert.deepEqual([...trUpper.terms.entries()], [...trLower.terms.entries()]);
  assert.ok(Math.abs(cosine(trUpper, trLower) - 1) < 1e-12);

  const unrel = buildVector('How do I reverse a linked list in Rust?');
  assert.ok(cosine(v1, unrel) < 0.25, `expected unrelated cosine < 0.25, got ${cosine(v1, unrel)}`);

  assert.equal(buildVector('').norm, 0);
  assert.equal(buildVector('   ... !!!   ').norm, 0);
  assert.equal(cosine(v1, buildVector('')), 0);
  assert.equal(cosine(null, v1), 0);

  // 4 KB cap ignores differences past byte 4096 and respects UTF-8 boundaries.
  const head = 'a'.repeat(MAX_INPUT_BYTES - 1);
  const tailA = buildVector(`${head}ş alpha`);
  const tailB = buildVector(`${head}ş beta`);
  assert.ok(Math.abs(cosine(tailA, tailB) - 1) < 1e-12);
  assert.deepEqual([...tailA.terms.entries()], [...tailB.terms.entries()]);

  // Vector term count capped at MAX_VECTOR_TERMS and no plaintext words retained.
  const manyWords = Array.from({ length: 400 }, (_, i) => `uniqueword${i}token`).join(' ');
  const capped = buildVector(manyWords);
  assert.ok(capped.terms.size <= MAX_VECTOR_TERMS);
  for (const k of capped.terms.keys()) assert.equal(typeof k, 'number');
  assert.match(v1.guardHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify([...v1.terms.entries()]).includes('refund'));
});

test('check 1b: guardTokens distinguishes numbers, currencies, operators, negations, and decisive words', () => {
  assert.deepEqual(guardTokens('Pay $1,000'), guardTokens('Pay $1000'));
  assert.notDeepEqual(guardTokens('Pay $100'), guardTokens('Pay $200'));
  assert.notDeepEqual(guardTokens('Pay $100'), guardTokens('Pay €100'));
  assert.notDeepEqual(guardTokens('Set threshold to -5'), guardTokens('Set threshold to 5'));
  assert.notDeepEqual(guardTokens('Latency > 500ms'), guardTokens('Latency < 500ms'));
  assert.notDeepEqual(guardTokens('Enable this flag'), guardTokens('Do not enable this flag'));
  assert.notDeepEqual(guardTokens('Retry on errors'), guardTokens("Don't retry on errors"));
  assert.deepEqual(guardTokens("Why doesn't this work"), guardTokens('Why does not this work'));
  assert.notDeepEqual(guardTokens('Always retry'), guardTokens('Never retry'));
  assert.notDeepEqual(guardTokens('İade kapsamına girer'), guardTokens('İade kapsamına girmez değil'));
  assert.notDeepEqual(guardTokens('Annual billing plan'), guardTokens('Monthly billing plan'));
  assert.notDeepEqual(guardTokens('Delete old rows'), guardTokens('Keep old rows'));
  assert.notDeepEqual(guardTokens('Retry two times'), guardTokens('Retry three times'));
});

test('check 1c: lastUserText rejects media parts and non-user trailing turns', () => {
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'hello' }] }), 'hello');
  assert.equal(
    lastUserText({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'line 1' }, { type: 'input_text', text: 'line 2' }] },
      ],
    }),
    'line 1\nline 2',
  );
  assert.equal(
    lastUserText({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
    }),
    null,
  );
  assert.equal(
    lastUserText({
      messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf' } }] }],
    }),
    null,
  );
  assert.equal(lastUserText({ messages: [{ role: 'assistant', content: 'hi' }] }), null);
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [] }] }), null);
  assert.equal(lastUserText({}), null);
});

test('check 1d: resolveCacheConfig freezes defaults, validates cache.semantic.*, and warns when cache.enabled is false', () => {
  assert.equal(Object.isFrozen(CACHE_DEFAULTS), true);
  assert.equal(Object.isFrozen(CACHE_DEFAULTS.semantic), true);
  assert.equal(Object.isFrozen(SEMANTIC_DEFAULTS), true);

  const ok = resolveCacheConfig({ enabled: true, semantic: { enabled: true, threshold: 0.9, maxProbe: 50 } });
  assert.deepEqual(ok, {
    enabled: true,
    ttlSeconds: 3600,
    maxEntries: 500,
    semantic: { enabled: true, threshold: 0.9, maxProbe: 50 },
    error: null,
  });

  const inactive = resolveCacheConfig({ enabled: false, semantic: { enabled: true } });
  assert.equal(inactive.enabled, false);
  assert.equal(inactive.error, null);
  assert.match(inactive.warning, /no effect/);

  const badInputs = [
    [{ enabled: true, semantic: true }, /cache\.semantic must be an object/],
    [{ enabled: true, semantic: null }, /cache\.semantic must be an object/],
    [{ enabled: true, semantic: [] }, /cache\.semantic must be an object/],
    [{ enabled: true, semantic: { enabled: 'yes' } }, /cache\.semantic\.enabled/],
    [{ enabled: true, semantic: { threshold: 0 } }, /cache\.semantic\.threshold/],
    [{ enabled: true, semantic: { threshold: -0.2 } }, /cache\.semantic\.threshold/],
    [{ enabled: true, semantic: { threshold: 1.5 } }, /cache\.semantic\.threshold/],
    [{ enabled: true, semantic: { threshold: Number.NaN } }, /cache\.semantic\.threshold/],
    [{ enabled: true, semantic: { threshold: '0.92' } }, /cache\.semantic\.threshold/],
    [{ enabled: true, semantic: { maxProbe: 0 } }, /cache\.semantic\.maxProbe/],
    [{ enabled: true, semantic: { maxProbe: 1.5 } }, /cache\.semantic\.maxProbe/],
    [{ enabled: true, semantic: { extra: 1 } }, /cache\.semantic has an unknown field "extra"/],
  ];
  for (const [raw, re] of badInputs) {
    const res = resolveCacheConfig(raw);
    assert.equal(res.enabled, false, JSON.stringify(raw));
    assert.equal(res.semantic.enabled, false, JSON.stringify(raw));
    assert.match(res.error, re, JSON.stringify(raw));
    assert.match(res.error, /response cache stays off/);
  }
});

test('check 1e: shapeFor binds caller, model, params, and all earlier turns while allowing last user paraphrase', () => {
  const baseBody = {
    model: 'up/m',
    temperature: 0,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'First turn' },
      { role: 'assistant', content: 'First reply' },
      { role: 'user', content: 'What is the refund policy?' },
    ],
  };
  const s1 = shapeFor({ callerHash: 'c1', body: baseBody });
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.equal(
    s1,
    shapeFor({
      callerHash: 'c1',
      body: {
        ...baseBody,
        messages: [...baseBody.messages.slice(0, -1), { role: 'user', content: 'Paraphrased last turn' }],
      },
    }),
  );
  assert.notEqual(s1, shapeFor({ callerHash: 'c2', body: baseBody }));
  assert.notEqual(s1, shapeFor({ callerHash: 'c1', body: { ...baseBody, model: 'up/m2' } }));
  assert.notEqual(s1, shapeFor({ callerHash: 'c1', body: { ...baseBody, temperature: 0.2 } }));
  assert.notEqual(
    s1,
    shapeFor({
      callerHash: 'c1',
      body: { ...baseBody, messages: [{ role: 'system', content: 'Be verbose.' }, ...baseBody.messages.slice(1)] },
    }),
  );
  assert.notEqual(
    s1,
    shapeFor({
      callerHash: 'c1',
      body: {
        ...baseBody,
        messages: [baseBody.messages[0], { role: 'user', content: 'Different first turn' }, ...baseBody.messages.slice(2)],
      },
    }),
  );
  assert.equal(shapeFor({ callerHash: 'c1', body: { model: 'up/m', messages: [{ role: 'assistant', content: 'hi' }] } }), null);
});

test('check 1f & check 8: ResponseCache semantic index cleans up on TTL expiry, LRU eviction, clear, and bounds probes to maxProbe', () => {
  const clk = { t: 1000 };
  const cache = new ResponseCache({ maxEntries: 2, ttlMs: 1000, now: () => clk.t, semantic: true });

  // Entry stored without meta is never a semantic candidate.
  cache.set('plain', { id: '1', text: 'plain' });
  const v = buildVector('What is the refund policy for annual plans?');
  assert.equal(cache.getSemantic('shape-a', v, { threshold: 0.92, maxProbe: 200 }), null);
  assert.equal(cache.stats().semanticHits, 0);

  // Raw fields inside caller meta are stripped; LRU eviction drops shape bucket entries.
  cache.set('k1', { id: 'k1', text: 'first' }, { shape: 'shape-1', vector: v, rawPrompt: 'secret-text' });
  assert.equal(cache._map.get('k1').rawPrompt, undefined);
  assert.equal(cache._shapes.get('shape-1').size, 1);

  cache.set('k2', { id: 'k2', text: 'second' }, { shape: 'shape-2', vector: v });
  // maxEntries=2 evicted 'plain'; now adding 'k3' evicts 'k1' and deletes empty 'shape-1'.
  cache.set('k3', { id: 'k3', text: 'third' }, { shape: 'shape-3', vector: v });
  assert.equal(cache._shapes.has('shape-1'), false);
  assert.equal(cache.getSemantic('shape-1', v, { threshold: 0.92, maxProbe: 200 }), null);

  // Guard hash mismatch blocks semantic hit even when similarity returns 1.
  const vNot = buildVector('Do not refund annual plans');
  assert.equal(cache.getSemantic('shape-2', vNot, { threshold: 0.92, maxProbe: 200, similarity: () => 1 }), null);

  // TTL expiry deletes from both _map and _shapes.
  clk.t = 2000;
  assert.equal(cache.getSemantic('shape-2', v, { threshold: 0.92, maxProbe: 200 }), null);
  assert.equal(cache._shapes.has('shape-2'), false);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache._shapes.size, 0);
  assert.equal(cache._map.size, 0);

  // clear() drops both _map and _shapes.
  cache.set('k4', { id: 'k4' }, { shape: 'shape-4', vector: v });
  cache.clear();
  assert.equal(cache._shapes.size, 0);
  assert.equal(cache._map.size, 0);

  // Check 8: 500 stored entries with one shape; maxProbe=200 calls cosine at most 200 times, newest first.
  const probeCache = new ResponseCache({ maxEntries: 500, ttlMs: 60_000, now: () => clk.t, semantic: true });
  const targetVec = buildVector('What is the refund policy for annual plans?');
  const otherVec = buildVector('Different topic altogether');
  for (let i = 0; i < 500; i++) {
    // Store matching vector only at i=0 (oldest) and non-matching elsewhere first.
    const vec = i === 0 ? targetVec : otherVec;
    probeCache.set(`e-${i}`, { idx: i }, { shape: 'same-shape', vector: { terms: vec.terms, norm: vec.norm, guardHash: targetVec.guardHash } });
  }
  let simCalls = 0;
  const countedCosine = (a, b) => {
    simCalls++;
    return cosine(a, b);
  };
  const missedOldest = probeCache.getSemantic('same-shape', targetVec, {
    threshold: 0.92,
    maxProbe: 200,
    similarity: countedCosine,
  });
  assert.equal(simCalls, 200, 'probed exactly maxProbe=200 newest entries');
  assert.equal(missedOldest, null, 'entry #0 is outside the 200 newest entries');

  // Now put a matching entry at the newest position (replacing e-499): hits within maxProbe=200.
  probeCache.set('e-499', { idx: 499 }, { shape: 'same-shape', vector: targetVec });
  simCalls = 0;
  const hitNewest = probeCache.getSemantic('same-shape', buildVector("what's the refund policy for the annual plan"), {
    threshold: 0.92,
    maxProbe: 200,
    similarity: countedCosine,
  });
  assert.equal(simCalls, 200);
  assert.equal(hitNewest?.payload?.idx, 499);
  assert.ok(hitNewest.similarity >= 0.92);
});

/* ---------------------------------------------------------- checks 2–10: HTTP & CLI */

test('check 2: paraphrased repeat returns x-keysmith-cache: hit-semantic without calling upstream, including x-keysmith-cache: use', async (t) => {
  const key = mint();
  const clock = { t: Date.UTC(2030, 0, 2, 3, 4, 5) };
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
    clock,
  });

  const q1 = await gw.call(key, chat('What is the refund policy for annual plans?', { temperature: 0 }));
  const q2 = await gw.call(key, chat("what's the refund policy for the annual plan", { temperature: 0 }));
  assert.equal(q1.status, 200, q1.text);
  assert.equal(q2.status, 200, q2.text);
  assert.equal(q1.cache, 'miss');
  assert.equal(q2.cache, 'hit-semantic');
  assert.equal(gw.hits.up, 1, 'upstream called once');
  assert.equal(q2.json.choices[0].message.content, q1.json.choices[0].message.content);
  assert.notEqual(q2.json.id, q1.json.id);
  assert.equal(q2.json.created, Math.floor(clock.t / 1000));

  const page = await gw.get(key, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /response cache: 1 hits \/ 1 misses, 1 entries, 1 semantic hits/);

  // x-keysmith-cache: use opt-in with non-zero / absent temperature
  const o1 = await gw.call(key, chat('How do I rotate my gateway keys safely?'), { 'x-keysmith-cache': 'use' });
  const o2 = await gw.call(key, chat('how do i rotate my gateway key safely'), { 'x-keysmith-cache': 'use' });
  assert.equal(o1.cache, 'miss');
  assert.equal(o2.cache, 'hit-semantic');
  assert.equal(gw.hits.up, 2);
});

test('check 3 & check 4: misses on unrelated prompt, different model/harness, earlier turn, system prompt word change, media part, and other gateway key', async (t) => {
  const keyA = mint();
  const keyB = mint();
  const gw = await rig(t, {
    keys: [keyA, keyB],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
    extraAdapters: (root) => ({
      up2: { kind: 'http', wire: 'openai', baseUrl: `${root}/up2/v1`, apiKey: false, models: ['m'] },
    }),
  });

  const sys = { role: 'system', content: 'Answer in one short sentence.' };
  const baseMsgs = [
    sys,
    { role: 'user', content: 'We use Postgres.' },
    { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: 'What is the refund policy for annual plans?' },
  ];
  assert.equal((await gw.call(keyA, { model: 'up/m', temperature: 0, messages: baseMsgs })).cache, 'miss');
  assert.equal(gw.hits.up, 1);

  // Control: identical context + paraphrase hits
  const hit = await gw.call(keyA, {
    model: 'up/m',
    temperature: 0,
    messages: [...baseMsgs.slice(0, -1), { role: 'user', content: [{ type: 'text', text: "what's the refund policy for the annual plan" }] }],
  });
  assert.equal(hit.cache, 'hit-semantic');
  assert.equal(gw.hits.up, 1);

  // Unrelated prompt
  assert.equal((await gw.call(keyA, { model: 'up/m', temperature: 0, messages: [...baseMsgs.slice(0, -1), { role: 'user', content: 'How do I parse TOML in Node?' }] })).cache, 'miss');

  // Different model
  assert.equal((await gw.call(keyA, { model: 'up/m2', temperature: 0, messages: [...baseMsgs.slice(0, -1), { role: 'user', content: "what's the refund policy for the annual plan" }] })).cache, 'miss');

  // Different harness resolving bare model
  const h1 = await gw.call(keyA, { model: 'm', temperature: 0, messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }] }, { 'x-harness-id': 'up' });
  const h2 = await gw.call(keyA, { model: 'm', temperature: 0, messages: [{ role: 'user', content: "what's the refund policy for the annual plan" }] }, { 'x-harness-id': 'up2' });
  assert.equal(h1.cache, 'miss');
  assert.equal(h2.cache, 'miss');

  // Different earlier turn
  assert.equal((await gw.call(keyA, {
    model: 'up/m',
    temperature: 0,
    messages: [sys, { role: 'user', content: 'We use SQLite.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: "what's the refund policy for the annual plan" }],
  })).cache, 'miss');

  // One word changed in system prompt
  assert.equal((await gw.call(keyA, {
    model: 'up/m',
    temperature: 0,
    messages: [{ role: 'system', content: 'Answer in two short sentences.' }, ...baseMsgs.slice(1, -1), { role: 'user', content: "what's the refund policy for the annual plan" }],
  })).cache, 'miss');

  // Check 4: Different gateway key
  assert.equal((await gw.call(keyB, {
    model: 'up/m',
    temperature: 0,
    messages: [...baseMsgs.slice(0, -1), { role: 'user', content: "what's the refund policy for the annual plan" }],
  })).cache, 'miss');

  // Media part in last user turn -> excluded from semantic lookup and store
  const imgMiss = await gw.call(keyA, {
    model: 'up/m',
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this diagram carefully' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  });
  assert.equal(imgMiss.cache, 'miss');
  const afterImg = await gw.call(keyA, chat('Describe this diagram carefully', { temperature: 0 }));
  assert.equal(afterImg.cache, 'miss', 'media-bearing turn was not indexed for semantic lookup');
});

test('check 5: false-match corpus differing by numbers, amounts, negations, or decisive words never hits', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 200, semantic: { enabled: true } },
  });
  const pairs = [
    ['Approve a refund of $100 for order A', 'Approve a refund of $200 for order A'],
    ['Approve a refund of $100 for order A', 'Approve a refund of €100 for order A'],
    ['What is the refund policy for 30 day plans?', 'What is the refund policy for 14 day plans?'],
    ['Set the alert offset to -5 seconds', 'Set the alert offset to 5 seconds'],
    ['Retry failed requests two times before failing', 'Retry failed requests three times before failing'],
    ['Should I enable caching for this endpoint?', 'Should I not enable caching for this endpoint?'],
    ['Always retry failed payment requests automatically', 'Never retry failed payment requests automatically'],
    ['Do retry failed requests on 500 errors', "Don't retry failed requests on 500 errors"],
    ['Include full debug logs in production output', 'Include no debug logs in production output'],
    ['Bu işlem iade kapsamına girer mi?', 'Bu işlem iade kapsamına girmez değil mi?'],
    ['What is the refund policy for annual plans?', 'What is the refund policy for monthly plans?'],
    ['Should we delete old usage logs after 30 days?', 'Should we keep old usage logs after 30 days?'],
    ['Alert when latency > 500ms on the gateway', 'Alert when latency < 500ms on the gateway'],
  ];
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const sys = { role: 'system', content: `corpus-${i}` };
    const before = gw.hits.up;
    const ra = await gw.call(key, { model: 'up/m', temperature: 0, messages: [sys, { role: 'user', content: a }] });
    const rb = await gw.call(key, { model: 'up/m', temperature: 0, messages: [sys, { role: 'user', content: b }] });
    assert.equal(ra.cache, 'miss', `pair ${i} first`);
    assert.equal(rb.cache, 'miss', `pair ${i} false-match guard (${a} vs ${b})`);
    assert.equal(gw.hits.up, before + 2, `pair ${i} called upstream twice`);
  }
});

test('check 6: with semantic off or absent, client headers/body fields never activate semantic caching', async (t) => {
  for (const cache of [{ enabled: true }, { enabled: true, semantic: { enabled: false } }]) {
    const key = mint();
    const gw = await rig(t, { keys: [key], cache });
    const first = await gw.call(
      key,
      chat('What is the refund policy for annual plans?', { temperature: 0, semantic: true }),
      { 'x-keysmith-cache-semantic': 'on' },
    );
    const para = await gw.call(
      key,
      chat("what's the refund policy for the annual plan", { temperature: 0, semantic: true }),
      { 'x-keysmith-cache-semantic': 'on' },
    );
    const exact = await gw.call(key, chat('What is the refund policy for annual plans?', { temperature: 0, semantic: true }));
    assert.equal(first.cache, 'miss');
    assert.equal(para.cache, 'miss');
    assert.equal(exact.cache, 'hit');
    assert.equal(gw.hits.up, 2);

    const page = await gw.get(key, '/');
    assert.match(page.text, /response cache: 1 hits \/ 2 misses, 2 entries/);
    assert.ok(!page.text.includes('semantic hits'));
  }
});

test('check 7: usage CLI & HTTP record cache "hit", numeric similarity, cost 0; spend/quota/guard invariants hold', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [{ key, perDay: 3 }],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
    pricing: PRICE,
    spend: { up: MISS_USD },
    guard: { secrets: 'mask' },
  });

  const secret = fakeGhp('c');
  const m1 = await gw.call(key, chat(`What is the refund policy for token ${secret} on annual plans?`, { temperature: 0 }));
  const m2 = await gw.call(key, chat(`what's the refund policy for token ${secret} on the annual plan`, { temperature: 0 }));
  assert.equal(m1.status, 200, m1.text);
  assert.equal(m2.status, 200, m2.text);
  assert.equal(m1.cache, 'miss');
  assert.equal(m2.cache, 'hit-semantic');
  assert.equal(gw.hits.up, 1);

  const cli = runCli(gw.dir, ['usage', '--tail', '1', '--format', 'json']);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.entries.length, 1);
  const row = report.entries[0];
  assert.equal(row.cache, 'hit');
  assert.equal(typeof row.similarity, 'number');
  assert.ok(row.similarity >= 0.92 && row.similarity <= 1, `unexpected similarity ${row.similarity}`);
  assert.equal(Math.round(row.similarity * 1000) / 1000, row.similarity);
  assert.equal(row.cost.usd, 0);
  assert.equal(row.cost.basis, 'metered');
  assert.equal(row.guard, 'masked');
  assert.deepEqual(row.guardKinds, ['github-token']);
  assert.equal(report.meteredUsd, MISS_USD);

  const rawLog = fs.readFileSync(gw.usage.file, 'utf8');
  assert.ok(!rawLog.includes(secret.slice(4, 16)), 'no secret leaked to usage log');

  // 3rd metered request hits GET /v1/keysmith/usage; 4th is refused by perDay (3).
  const httpUsage = await gw.get(key, '/v1/keysmith/usage?tail=1');
  assert.equal(httpUsage.status, 200, httpUsage.text);
  assert.equal(httpUsage.json.entries[0].cache, 'hit');
  assert.equal(httpUsage.json.entries[0].similarity, row.similarity);
  assert.equal(httpUsage.json.entries[0].cost.usd, 0);
  assert.equal(gw.usage._spendState?.reservedByAdapter?.size || 0, 0, 'semantic hit reserves no spend');

  const overCap = await gw.call(key, chat('Totally different question', { temperature: 0 }));
  assert.equal(overCap.status, 429);
  assert.equal(gw.hits.up, 1);

  // Separate rig with no perDay proves limits.spend alone stays untouched by semantic hit and blocks the next miss.
  const spendKey = mint();
  const spendGw = await rig(t, {
    keys: [spendKey],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
    pricing: PRICE,
    spend: { up: MISS_USD },
  });
  assert.equal((await spendGw.call(spendKey, chat('What is the refund policy for annual plans?', { temperature: 0 }))).cache, 'miss');
  assert.equal((await spendGw.call(spendKey, chat("what's the refund policy for the annual plan", { temperature: 0 }))).cache, 'hit-semantic');
  const [summary] = spendGw.usage.spendSummary({ up: MISS_USD }, { adapters: { up: {} } });
  assert.equal(summary.spent, MISS_USD);
  assert.equal(summary.exceeded, true);
  assert.equal((await spendGw.call(spendKey, chat('New prompt after spend cap', { temperature: 0 }))).status, 429);
  assert.equal(spendGw.hits.up, 1);
});

test('check 9: invalid cache.semantic.threshold keeps whole cache off and doctor names cache.semantic.threshold', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, semantic: { enabled: true, threshold: 1.5 } },
  });
  assert.ok(gw.logs.some((l) => l.includes('cache.semantic.threshold')));
  const a = await gw.call(key, chat('What is the refund policy for annual plans?', { temperature: 0 }));
  const b = await gw.call(key, chat('What is the refund policy for annual plans?', { temperature: 0 }));
  assert.equal(a.cache, null);
  assert.equal(b.cache, null);
  assert.equal(gw.hits.up, 2);
  const page = await gw.get(key, '/');
  assert.ok(!page.text.includes('response cache:'));

  const docDir = tmp(t);
  const cfgPath = path.join(docDir, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ auth: { enabled: true, keys: [key] }, cache: { enabled: true, semantic: { enabled: true, threshold: 1.5 } } }),
    { mode: 0o600 },
  );
  const badDoc = runCli(docDir, ['doctor']);
  assert.match(badDoc.stdout + badDoc.stderr, /cache\.semantic\.threshold.*response cache stays off/);

  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ auth: { enabled: true, keys: [key] }, cache: { enabled: false, semantic: { enabled: true } } }),
    { mode: 0o600 },
  );
  const inactiveDoc = runCli(docDir, ['doctor']);
  assert.match(inactiveDoc.stdout + inactiveDoc.stderr, /cache\.semantic\.enabled.*no effect/);
});

test('check 10: stream, tools, tool history, sessions, and other faces never get hit-semantic', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
  });

  // Prime semantic cache with an annual refund question first.
  const prime = await gw.call(key, chat('What is the refund policy for annual plans?', { temperature: 0 }));
  assert.equal(prime.cache, 'miss');
  const startHits = gw.hits.up;

  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const checks = [
    [chat("what's the refund policy for the annual plan", { temperature: 0, stream: true }), {}, '/v1/chat/completions'],
    [chat("what's the refund policy for the annual plan", { temperature: 0, tools }), {}, '/v1/chat/completions'],
    [
      {
        model: 'up/m',
        temperature: 0,
        messages: [
          { role: 'user', content: 'What is the refund policy for annual plans?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
          { role: 'user', content: "what's the refund policy for the annual plan" },
        ],
      },
      {},
      '/v1/chat/completions',
    ],
    [chat("what's the refund policy for the annual plan", { temperature: 0 }), { 'x-keysmith-session': 's1' }, '/v1/chat/completions'],
    [chat("what's the refund policy for the annual plan", { temperature: 0, session: 's2' }), {}, '/v1/chat/completions'],
    [{ model: 'up/m', max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: "what's the refund policy for the annual plan" }] }, {}, '/v1/messages'],
    [{ model: 'up/m', input: "what's the refund policy for the annual plan", temperature: 0 }, {}, '/v1/responses'],
    [{ model: 'up/e', input: "what's the refund policy for the annual plan" }, {}, '/v1/embeddings'],
  ];

  for (let i = 0; i < checks.length; i++) {
    const [body, headers, route] = checks[i];
    const r = await gw.call(key, body, headers, route);
    assert.equal(r.status, 200, `case ${i}: ${r.text}`);
    assert.equal(r.cache, null, `case ${i} (${route}) must not carry cache header`);
  }
  assert.equal(gw.hits.up, startHits + checks.length);
});

test('prompts longer than MAX_INPUT_BYTES that differ only after 4 KB skip semantic cache while keeping exact cache', async (t) => {
  const key = mint();
  const gw = await rig(t, {
    keys: [key],
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50, semantic: { enabled: true } },
  });

  const doc = 'Clause details for the service agreement. '.repeat(125);
  assert.ok(Buffer.byteLength(doc, 'utf8') > MAX_INPUT_BYTES);
  const p1 = `${doc}\nWhat is the termination clause?`;
  const p2 = `${doc}\nSummarise the payment section.`;

  const r1 = await gw.call(key, chat(p1, { temperature: 0 }));
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.cache, 'miss');
  assert.equal(gw.hits.up, 1);
  assert.equal(r1.json.choices[0].message.content, p1);

  const r2 = await gw.call(key, chat(p2, { temperature: 0 }));
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.cache, 'miss');
  assert.equal(gw.hits.up, 2);
  assert.equal(r2.json.choices[0].message.content, p2);

  // Exact cache continues to serve repeated >4 KB prompts.
  const exact1 = await gw.call(key, chat(p1, { temperature: 0 }));
  const exact2 = await gw.call(key, chat(p2, { temperature: 0 }));
  assert.equal(exact1.cache, 'hit');
  assert.equal(exact2.cache, 'hit');
  assert.equal(gw.hits.up, 2);
  assert.equal(exact1.json.choices[0].message.content, p1);
  assert.equal(exact2.json.choices[0].message.content, p2);

  // Over-limit entries were not indexed into the semantic bucket.
  const prefixReq = await gw.call(key, chat(doc.slice(0, MAX_INPUT_BYTES), { temperature: 0 }));
  assert.equal(prefixReq.status, 200, prefixReq.text);
  assert.equal(prefixReq.cache, 'miss');
  assert.equal(gw.hits.up, 3);

  // UTF-8 byte length (not JS UTF-16 .length) enforces MAX_INPUT_BYTES.
  const mbPrefix = 'ş'.repeat(2100);
  assert.ok(mbPrefix.length < MAX_INPUT_BYTES);
  assert.ok(Buffer.byteLength(mbPrefix, 'utf8') > MAX_INPUT_BYTES);
  const mb1 = await gw.call(key, chat(`${mbPrefix} termination clause`, { temperature: 0 }));
  const mb2 = await gw.call(key, chat(`${mbPrefix} payment section`, { temperature: 0 }));
  assert.equal(mb1.status, 200, mb1.text);
  assert.equal(mb2.status, 200, mb2.text);
  assert.equal(mb1.cache, 'miss');
  assert.equal(mb2.cache, 'miss');
  assert.equal(gw.hits.up, 5);
});
