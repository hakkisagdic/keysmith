import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { buildSemanticVector, cosineSimilarity } from '../src/cache.js';

function fakeAdapter(id = 'echo', counter = { calls: 0 }) {
  return {
    id,
    kind: 'cli',
    priority: 100,
    models: () => [{ id: `${id}/m1`, owned_by: id }],
    async *complete({ messages }) {
      counter.calls++;
      const text = messages.map((m) => m.content).join(' | ');
      yield { type: 'delta', text: `Answer #${counter.calls}: ${text}` };
      yield { type: 'usage', usage: { input: 100, output: 50 } };
      yield { type: 'done' };
    },
  };
}

test('P2-2: buildSemanticVector and cosineSimilarity score near-duplicate Turkish & English prompts accurately', () => {
  const v1 = buildSemanticVector('Keysmith aylık kurumsal abonelik fiyatları ve KDV oranı nedir?');
  const v2 = buildSemanticVector('Keysmith aylık kurumsal abonelik fiyatı ve KDV oranı nedir');
  const v3 = buildSemanticVector('Python ile hızlı sıralama (quicksort) algoritması nasıl yazılır?');

  const simNear = cosineSimilarity(v1, v2);
  const simFar = cosineSimilarity(v1, v3);

  assert.ok(simNear >= 0.85, `expected near similarity >= 0.85, got ${simNear}`);
  assert.ok(simFar < 0.25, `expected unrelated similarity < 0.25, got ${simFar}`);
});

test('P2-2: Server semantic cache returns SEMANTIC-HIT and X-Keysmith-Cache-Similarity on near-identical prompts without calling upstream', async () => {
  const counter = { calls: 0 };
  const cfg = {
    auth: { enabled: false },
    adapters: { echo: { kind: 'cli', bin: 'echo' } },
    aliases: {},
    pricing: { 'echo/m1': { input: 2.0, output: 8.0 } },
    cache: {
      enabled: true,
      semantic: true,
      semanticThreshold: 0.8,
      ttlSeconds: 600,
    },
  };

  const gw = new Gateway(cfg);
  gw.adapters.set('echo', fakeAdapter('echo', counter));
  const server = createServer(gw, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. First request -> MISS
    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'echo/m1',
        messages: [
          { role: 'system', content: 'You are a billing assistant.' },
          { role: 'user', content: 'Keysmith aylık kurumsal abonelik fiyatları ve KDV oranı nedir?' },
        ],
      }),
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-keysmith-cache'), 'MISS');
    assert.equal(counter.calls, 1);
    const body1 = await res1.json();

    // 2. Near-identical query (slightly different punctuation/plural) -> SEMANTIC-HIT
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'echo/m1',
        messages: [
          { role: 'system', content: 'You are a billing assistant.' },
          { role: 'user', content: 'Keysmith aylık kurumsal abonelik fiyatı ve KDV oranı nedir' },
        ],
      }),
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-keysmith-cache'), 'SEMANTIC-HIT');
    const simHeader = Number(res2.headers.get('x-keysmith-cache-similarity'));
    assert.ok(simHeader >= 0.8 && simHeader < 1, `expected similarity header in [0.8, 1), got ${simHeader}`);
    assert.equal(counter.calls, 1); // Upstream was NOT called!
    const body2 = await res2.json();
    assert.equal(body2.choices[0].message.content, body1.choices[0].message.content);

    // 3. Different system prompt -> contextHash differs -> MISS
    const res3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'echo/m1',
        messages: [
          { role: 'system', content: 'You are a strict security auditor.' },
          { role: 'user', content: 'Keysmith aylık kurumsal abonelik fiyatı ve KDV oranı nedir' },
        ],
      }),
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('x-keysmith-cache'), 'MISS');
    assert.equal(counter.calls, 2);

    // 4. Stats endpoint reports semanticHits
    const statsRes = await fetch(`${base}/v1/keysmith/cache`);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.semantic, true);
    assert.equal(stats.semanticHits, 1);
    assert.equal(stats.hits, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
