/**
 * Independent acceptance checks for prompt caching (20261117-onbellek), written from the
 * request: golden hashes were taken from main before this feature, the client-set and limit
 * rules, the OpenAI-wire refusal, model minimums, and hand-computed savings.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HttpAdapter } from '../src/http-adapter.js';
import { planCache } from '../src/prompt-cache.js';
import { UsageLog, formatUsageTable } from '../src/usage.js';

const sent = [];
let srv, base;
before(async () => {
  srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      sent.push(b);
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => srv.close());
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mk = (pc) => new HttpAdapter('claude-api', { baseUrl: base, wire: 'anthropic', _apiKey: 'k', ...(pc ? { promptCache: pc } : {}) });
const msgs = [{ role: 'system', content: 'sys '.repeat(900) }, { role: 'user', content: 'u '.repeat(900) }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'now' }];
const rawBody = { model: 'claude-sonnet-5-5', max_tokens: 10, system: 's', tools: [{ name: 't', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
async function bodies(a) {
  sent.length = 0;
  for await (const _ of a.complete({ model: 'claude-sonnet-5-5', messages: msgs })) void _;
  await a.rawMessages(rawBody);
  return [...sent];
}

test('K1 golden: absent, off and dry-run send the exact bytes main sent before the feature', async () => {
  for (const pc of [null, { mode: 'off' }, { mode: 'dry-run' }]) {
    const [a, b] = await bodies(mk(pc));
    assert.equal(sha(a), '7adae94bae3e47fb9057f91ec279cacd5d8cce937d6857e0c8274ccca1331703');
    assert.equal(sha(b), '91fa7755dbd29f551a44076aa8f2e40ff2f034530b98f73d7b2cf8b4b8c3889d');
  }
});

test('K3: one client mark anywhere (messages, tools) passes the body untouched; 4 client marks stay 4', () => {
  const big = 'x '.repeat(3000);
  const m = { type: 'ephemeral' };
  const withMsg = { system: big, messages: [{ role: 'user', content: [{ type: 'text', text: big, cache_control: m }] }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] };
  assert.equal(planCache(withMsg, { mode: 'on', ttl: '5m' }, 'claude-sonnet-5-5').body, withMsg);
  const four = { tools: [{ name: 't', description: big, cache_control: m }], system: [{ type: 'text', text: big, cache_control: m }, { type: 'text', text: big, cache_control: m }], messages: [{ role: 'user', content: [{ type: 'text', text: big, cache_control: m }] }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] };
  const out = planCache(four, { mode: 'on', ttl: '5m' }, 'claude-sonnet-5-5').body;
  assert.equal(JSON.stringify(out).split('cache_control').length - 1, 4);
});

test('K2/K5: gateway adds at most 3 marks (never the final turn), 1h only by setting', () => {
  const big = 'x '.repeat(3000);
  const body = { tools: [{ name: 'a', description: big }, { name: 'b', description: big }], system: [{ type: 'text', text: 's1' }, { type: 'text', text: big }], messages: [{ role: 'user', content: big }, { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: big }] }, { role: 'user', content: [{ type: 'text', text: 'last' }] }] };
  const out = planCache(body, { mode: 'on', ttl: '1h' }, 'claude-sonnet-5-5').body;
  const n = JSON.stringify(out).split('cache_control').length - 1;
  assert.equal(n, 3);
  assert.deepEqual(out.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(out.tools[0].cache_control, undefined);
  assert.deepEqual(out.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(out.messages[1].content[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(JSON.stringify(out.messages[2]).includes('cache_control'), false);
  assert.equal(JSON.stringify(planCache(body, { mode: 'on', ttl: '5m' }, 'claude-sonnet-5-5').body).includes('ttl'), false);
  assert.equal(JSON.stringify(body).includes('cache_control'), false, 'input body is not mutated');
});

test('K5: a request below the model minimum gets no mark (Haiku 4.5 needs 4096 per the API docs)', () => {
  const mid = 'x '.repeat(1500); // ~1.5k tokens: above 1024 and above Haiku 2048? no, below 2048
  const body = { system: mid, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.equal(JSON.stringify(planCache(body, { mode: 'on', ttl: '5m' }, 'claude-haiku-4-5').body).includes('cache_control'), false);
});

test('K5 vs docs: ~3000-token prompt on Haiku 4.5 (docs minimum 4096) should not be marked', () => {
  const mid = 'x '.repeat(3000);
  const body = { system: mid, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.equal(JSON.stringify(planCache(body, { mode: 'on', ttl: '5m' }, 'claude-haiku-4-5').body).includes('cache_control'), false);
});

test('K5 vs docs: Opus 4.5 minimum is 4096 (code default 1024)', () => {
  const mid = 'x '.repeat(3000);
  const body = { system: mid, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.equal(JSON.stringify(planCache(body, { mode: 'on', ttl: '5m' }, 'claude-opus-4-5').body).includes('cache_control'), false);
});

test('K6: dry-run counts the plan on adapter stats and leaves the body', async () => {
  const a = mk({ mode: 'dry-run' });
  await bodies(a);
  assert.equal(a.cacheStats.requests, 2);
  assert.ok(a.cacheStats.breakpoints >= 1);
});

test('K7 by hand: read 9000, write 1000 (5m) -> saved 9000x1.9 - 1000x0.5 = 0.0166 USD; share 9000/10100', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pct-'));
  try {
    const log = new UsageLog(path.join(dir, 'u.jsonl'));
    log.record({ status: 'ok', kind: 'http', adapter: 'claude-api', model: 'claude-api/claude-sonnet-5-5', usage: { input: 10100, output: 5, cacheRead: 9000, cacheWrite: 1000 }, ms: 5 });
    const r = log.query({ by: ['adapter'] });
    assert.equal(r.groups[0].cacheSavingsUsd, 0.0166);
    assert.equal(r.groups[0].cacheShare, 0.891);
    const txt = formatUsageTable(r);
    assert.match(txt, /89\.1%/);
    assert.match(txt, /0\.0166/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
