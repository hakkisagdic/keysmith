/**
 * Prompt caching on the Anthropic wire (src/prompt-cache.js): breakpoints put where the rule says
 * and nowhere else, the body otherwise byte for byte as it was. Against a stub Messages API.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HttpAdapter } from '../src/http-adapter.js';
import { planCache, checkPromptCache } from '../src/prompt-cache.js';
import { UsageLog, tokensToUsd, cacheSavingsUsd } from '../src/usage.js';

const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(400); // ~4.5k tokens
const sent = [];
let srv, base;

before(async () => {
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sent.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const usage = { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation: { ephemeral_1h_input_tokens: 1000 } };
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => srv.close());

const adapter = (promptCache, extra = {}) => new HttpAdapter('claude-api', { baseUrl: base, wire: 'anthropic', _apiKey: 'k', ...(promptCache ? { promptCache } : {}), ...extra });
const history = [
  { role: 'system', content: LONG },
  { role: 'user', content: LONG },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'and now?' },
];
async function run(a, messages = history) {
  sent.length = 0;
  for await (const _ of a.complete({ model: 'claude-sonnet-5-5', messages })) void _;
  return JSON.parse(sent[0]);
}
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));

test('K1: off or absent: the body is the same bytes', async () => {
  await run(adapter(null));
  const plain = sent[0];
  await run(adapter({ mode: 'off' }));
  assert.equal(sent[0], plain);
  await run(adapter({ mode: 'dry-run' })); // K6: dry-run changes nothing either
  assert.equal(sent[0], plain);
  const a = adapter({ mode: 'dry-run' });
  await run(a);
  assert.equal(a.cacheStats.requests, 1);
  assert.ok(a.cacheStats.breakpoints > 0 && a.cacheStats.estTokens > 0);
});

test('K2: on: breakpoints on system and the block before the last turn; text and order unchanged', async () => {
  const off = await run(adapter(null));
  const on = await run(adapter({ mode: 'on' }));
  assert.deepEqual(on.system.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(on.messages[1].content.at(-1).cache_control, { type: 'ephemeral' }); // the assistant before the last user turn
  assert.equal(on.messages.at(-1).content.cache_control ?? on.messages.at(-1).content, 'and now?');
  assert.ok(!JSON.stringify(on.messages.at(-1)).includes('cache_control'));
  // only the string -> single text block shape differs; text and order are intact
  const flat = (b) => (typeof b === 'string' ? b : b.map((x) => x.text).join(''));
  assert.equal(flat(strip(on).system), flat(off.system));
  assert.deepEqual(strip(on).messages.map((m) => [m.role, flat(m.content)]), off.messages.map((m) => [m.role, flat(m.content)]));
});

test('K3: the client sets its own cache_control: the body passes unchanged', () => {
  const body = { model: 'm', system: [{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: LONG }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] };
  const { body: out, report } = planCache(body, { mode: 'on', ttl: '5m' }, 'claude-sonnet-5-5');
  assert.equal(out, body);
  assert.equal(report.skipped, 'client-set');
});

test('relay: tools get a breakpoint on the last tool; at most 3 added', async () => {
  const a = adapter({ mode: 'on' });
  sent.length = 0;
  const tools = [{ name: 'a', description: LONG, input_schema: { type: 'object' } }, { name: 'b', description: 'x', input_schema: { type: 'object' } }];
  await a.rawMessages({ model: 'claude-sonnet-5-5', max_tokens: 10, tools, system: LONG, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }] });
  const b = JSON.parse(sent[0]);
  assert.deepEqual(b.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(b.tools[0].cache_control, undefined);
  assert.equal(JSON.stringify(b).split('cache_control').length - 1 <= 3, true);
});

test('K4: OpenAI-shaped tool history becomes tool_use/tool_result with the breakpoint in place', async () => {
  const messages = [
    { role: 'system', content: LONG },
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'w', arguments: '{"c":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    { role: 'user', content: 'thanks' },
  ];
  const b = await run(adapter({ mode: 'on', minTokens: 10 }), messages);
  assert.equal(b.messages[1].content[0].type, 'tool_use');
  assert.equal(b.messages[2].content[0].type, 'tool_result');
  // the tool result and the user's next words are one user turn: the stable prefix ends at the tool_use
  assert.deepEqual(b.messages[1].content.at(-1).cache_control, { type: 'ephemeral' });
  assert.ok(!JSON.stringify(b.messages.at(-1)).includes('cache_control'));
});

test('K4: wire openai with promptCache: nothing added, a warning is written', async () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => (lines.push(String(s)), true);
  let a;
  try { a = new HttpAdapter('claude-api-oai', { baseUrl: base, wire: 'openai', _apiKey: 'k', promptCache: { mode: 'on' } }); } finally { process.stderr.write = orig; }
  assert.match(lines.join(''), /only the anthropic wire/);
  const body = { model: 'm', messages: [{ role: 'user', content: LONG }] };
  assert.equal(a._cached(body, 'm'), body);
});

test('K5: ttl 1h marks ttl; default has no ttl field; a short request gets no marks', async () => {
  const one = await run(adapter({ mode: 'on', ttl: '1h' }));
  assert.deepEqual(one.system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
  const dflt = await run(adapter({ mode: 'on' }));
  assert.ok(!JSON.stringify(dflt).includes('ttl'));
  const short = await run(adapter({ mode: 'on' }), [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.ok(!JSON.stringify(short).includes('cache_control'));
});

test('a thinking block is never marked; bad settings are load errors', () => {
  const body = { model: 'm', system: LONG, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'thinking', thinking: LONG, signature: 's' }] }, { role: 'user', content: 'b' }] };
  const { body: out } = planCache(body, { mode: 'on', ttl: '5m', minTokens: 10 }, 'm');
  assert.ok(!JSON.stringify(out.messages).includes('cache_control'));
  assert.throws(() => checkPromptCache('x', { mode: 'sure' }), /mode must be/);
  assert.throws(() => checkPromptCache('x', { ttl: '2h' }), /ttl must be/);
  assert.equal(checkPromptCache('x', { mode: 'off' }), null);
});

test('K7: usage reads the cache fields and prices them (Sonnet 5.5 list: 2 in, 0.1 read, 2.5 write)', async () => {
  let u;
  for await (const e of adapter(null).complete({ model: 'claude-sonnet-5-5', messages: history })) if (e.type === 'usage') u = e.usage;
  assert.equal(u.cacheRead, 9000);
  assert.equal(u.cacheWrite, 1000);
  assert.equal(u.cacheWrite1h, 1000);
  const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  // 1h write is 2x input (4/M): 1000 x (4 - 2) = 0.002 premium; read 9000 x 1.9 = 0.0171
  assert.equal(cacheSavingsUsd(u, rates), 0.0151);
  assert.equal(cacheSavingsUsd({ cacheRead: 9000, cacheWrite: 1000 }, rates), 0.0171 - 0.0005);
  // total: 100 uncached? input is inclusive (100+10000): 100 x 2 + 5 x 10 + 9000 x 0.1 + 1000 x 4, per 1M
  assert.equal(tokensToUsd(u, rates), (200 + 50 + 900 + 4000) / 1e6);
  // keysmith usage: the report carries the read share and the savings
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pc-'));
  try {
    const log = new UsageLog(path.join(dir, 'usage.jsonl'));
    log.record({ status: 'ok', kind: 'http', adapter: 'claude-api', model: 'claude-api/claude-sonnet-5-5', usage: { input: 10100, output: 5, cacheRead: 9000, cacheWrite: 1000 }, ms: 5 });
    const r = log.query({ by: ['adapter'] });
    assert.equal(r.totals.cacheRead, 9000);
    assert.equal(r.totals.cacheShare, Math.round((9000 / 10100) * 1000) / 1000);
    assert.equal(r.totals.cacheSavingsUsd, 0.0171 - 0.0005); // read 9000 x (2 - 0.1), write premium 1000 x (2.5 - 2), per 1M
    assert.equal(r.groups[0].cacheSavingsUsd, r.totals.cacheSavingsUsd);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
