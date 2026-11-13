import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { ResponseCache } from '../src/cache.js';

describe('P0-1 · ResponseCache unit & LRU/TTL behavior', () => {
  test('LRU eviction and TTL expiration work deterministically', () => {
    let clock = 1_000_000;
    const cache = new ResponseCache(
      { cache: { enabled: true, ttlSeconds: 10, maxEntries: 2 } },
      { now: () => clock },
    );
    const k1 = cache.buildKey({ route: '/v1/chat/completions', model: 'up/m', targets: ['up/m'], body: { messages: [{ role: 'user', content: 'a' }] } });
    const k2 = cache.buildKey({ route: '/v1/chat/completions', model: 'up/m', targets: ['up/m'], body: { messages: [{ role: 'user', content: 'b' }] } });
    const k3 = cache.buildKey({ route: '/v1/chat/completions', model: 'up/m', targets: ['up/m'], body: { messages: [{ role: 'user', content: 'c' }] } });

    cache.set(k1, { route: '/v1/chat/completions', model: 'up/m', value: { text: 'A' }, costUsd: 0.005, usage: { input: 10, output: 5 } });
    cache.set(k2, { route: '/v1/chat/completions', model: 'up/m', value: { text: 'B' }, costUsd: 0.008, usage: { input: 20, output: 8 } });

    // Touch k1 so k2 becomes the oldest LRU entry.
    assert.equal(cache.get(k1)?.value?.text, 'A');
    cache.set(k3, { route: '/v1/chat/completions', model: 'up/m', value: { text: 'C' }, costUsd: 0.01, usage: { input: 30, output: 10 } });

    assert.equal(cache.get(k2), null, 'k2 was evicted by LRU');
    assert.equal(cache.get(k1)?.value?.text, 'A', 'k1 stayed in cache');

    // Advance clock past 10s TTL.
    clock += 11_000;
    assert.equal(cache.get(k1), null, 'k1 expired after TTL');
    const st = cache.stats();
    assert.equal(st.hits, 2);
    assert.equal(st.savedUsd, 0.01);
    assert.equal(st.savedTokens.input, 20);
    assert.equal(st.savedTokens.output, 10);
  });
});

describe('P0-1 · Server integration across chat, messages, responses, and embeddings', () => {
  let dir;
  let upstreamServer;
  let upstreamPort;
  let upstreamHits = 0;
  let srv;
  let base;
  let usage;
  const ADMIN_KEY = 'ks_admin_cache_test_key_12345';
  const SCOPED_KEY = 'ks_scoped_cache_test_key_67890';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cache-'));
    upstreamServer = http.createServer(async (req, res) => {
      upstreamHits++;
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
            model: body.model || 'emb-1',
            usage: { prompt_tokens: 12, total_tokens: 12 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `up_${upstreamHits}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: `answer #${upstreamHits}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
    await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = upstreamServer.address().port;

    const cfg = {
      auth: {
        enabled: true,
        keys: [
          ADMIN_KEY,
          { key: SCOPED_KEY, label: 'scoped', allow: ['up/*'] },
        ],
      },
      cache: {
        enabled: true,
        ttlSeconds: 300,
        maxEntries: 64,
      },
      pricing: {
        'up/m': { input: 10, output: 20 },
        'up/emb': { input: 5, output: 0 },
      },
      adapters: {
        up: {
          kind: 'http',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'up-secret',
          models: ['m', 'emb'],
          defaultModel: 'm',
        },
      },
    };
    usage = new UsageLog(path.join(dir, 'usage.jsonl'));
    const gw = new Gateway(cfg, { usage });
    srv = createServer(gw, cfg, { usage });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  after(async () => {
    await new Promise((r) => srv?.close(r));
    await new Promise((r) => upstreamServer?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function request(route, { method = 'POST', body = null, headers = {}, key = ADMIN_KEY } = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }

  test('chat completions: MISS then HIT (non-stream and stream), bypass headers, and zero-cost usage row', async () => {
    const beforeHits = upstreamHits;
    const r1 = await request('/v1/chat/completions', {
      body: { model: 'up/m', messages: [{ role: 'user', content: 'hello cache' }] },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-keysmith-cache'), 'MISS');
    assert.equal(r1.json().choices[0].message.content, 'answer #1');
    assert.equal(upstreamHits, beforeHits + 1);

    // Second identical request hits cache without calling upstream.
    const r2 = await request('/v1/chat/completions', {
      body: { model: 'up/m', messages: [{ role: 'user', content: 'hello cache' }] },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-keysmith-cache'), 'HIT');
    assert.equal(r2.json().choices[0].message.content, 'answer #1');
    assert.equal(upstreamHits, beforeHits + 1, 'upstream was not called on HIT');

    // Last usage row has cacheHit: true and cost.usd === 0 with savedUsd > 0.
    const [last] = usage.tail(1);
    assert.equal(last.cacheHit, true);
    assert.equal(last.cost.usd, 0);
    assert.equal(last.cost.basis, 'cached');
    assert.ok(last.cost.savedUsd > 0);

    // Streamed request for the same prompt also hits the cache and streams SSE frames.
    const rStream = await request('/v1/chat/completions', {
      body: { model: 'up/m', stream: true, messages: [{ role: 'user', content: 'hello cache' }] },
    });
    assert.equal(rStream.status, 200);
    assert.equal(rStream.headers.get('x-keysmith-cache'), 'HIT');
    assert.match(rStream.text, /answer #1/);
    assert.equal(upstreamHits, beforeHits + 1);

    // Bypass via Cache-Control: no-cache or x-keysmith-cache: bypass calls upstream.
    const rBypass = await request('/v1/chat/completions', {
      headers: { 'cache-control': 'no-cache' },
      body: { model: 'up/m', messages: [{ role: 'user', content: 'hello cache' }] },
    });
    assert.equal(rBypass.status, 200);
    assert.equal(rBypass.headers.get('x-keysmith-cache'), 'BYPASS');
    assert.equal(rBypass.json().choices[0].message.content, 'answer #2');
    assert.equal(upstreamHits, beforeHits + 2);
  });

  test('/v1/messages, /v1/responses, and /v1/embeddings all cache and serve HITs', async () => {
    const h0 = upstreamHits;
    const m1 = await request('/v1/messages', {
      body: { model: 'up/m', max_tokens: 64, messages: [{ role: 'user', content: 'msg cache' }] },
    });
    assert.equal(m1.headers.get('x-keysmith-cache'), 'MISS');
    const m2 = await request('/v1/messages', {
      body: { model: 'up/m', max_tokens: 64, messages: [{ role: 'user', content: 'msg cache' }] },
    });
    assert.equal(m2.headers.get('x-keysmith-cache'), 'HIT');
    assert.equal(m2.json().content[0].text, m1.json().content[0].text);
    assert.equal(upstreamHits, h0 + 1);

    const resp1 = await request('/v1/responses', {
      body: { model: 'up/m', input: 'responses cache' },
    });
    assert.equal(resp1.headers.get('x-keysmith-cache'), 'MISS');
    const resp2 = await request('/v1/responses', {
      body: { model: 'up/m', input: 'responses cache' },
    });
    assert.equal(resp2.headers.get('x-keysmith-cache'), 'HIT');
    assert.equal(upstreamHits, h0 + 2);

    const emb1 = await request('/v1/embeddings', {
      body: { model: 'up/emb', input: 'embed me' },
    });
    assert.equal(emb1.headers.get('x-keysmith-cache'), 'MISS');
    const emb2 = await request('/v1/embeddings', {
      body: { model: 'up/emb', input: 'embed me' },
    });
    assert.equal(emb2.headers.get('x-keysmith-cache'), 'HIT');
    assert.deepEqual(emb2.json().data, emb1.json().data);
    assert.equal(upstreamHits, h0 + 3);
  });

  test('GET and DELETE /v1/keysmith/cache report stats and enforce unscoped permission on clear', async () => {
    const statsRes = await request('/v1/keysmith/cache', { method: 'GET' });
    assert.equal(statsRes.status, 200);
    const stats = statsRes.json();
    assert.equal(stats.enabled, true);
    assert.ok(stats.entries >= 4);
    assert.ok(stats.hits >= 5);
    assert.ok(stats.savedUsd > 0);

    // Scoped key cannot clear cache.
    const denied = await request('/v1/keysmith/cache', { method: 'DELETE', key: SCOPED_KEY });
    assert.equal(denied.status, 403);

    // Admin unscoped key clears cache.
    const cleared = await request('/v1/keysmith/cache', { method: 'DELETE', key: ADMIN_KEY });
    assert.equal(cleared.status, 200);
    assert.ok(cleared.json().cleared >= 4);
    assert.equal(cleared.json().entries, 0);
  });
});
