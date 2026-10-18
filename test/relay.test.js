/**
 * The tool relay and streamed answers where a route has more than one way to go wrong: two
 * gateway keys, two conversations that drew the same tool call id, two google adapters on one
 * endpoint, a route with a CLI leg, and a provider that refuses — or quotes its key — on a
 * stream. Against a stub Gemini and a stub CLI; nothing here spends a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { HTTP_PROFILES } from '../src/profiles.js';
import { signatureOf } from '../src/thought-signatures.js';
import { redactKey } from '../src/redact.js';

const K1 = 'ks_' + crypto.randomBytes(24).toString('base64url');
const K2 = 'ks_' + crypto.randomBytes(24).toString('base64url');
const googleKey = () => 'AIzaSy' + crypto.randomBytes(30).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 33);
const KEY_A = googleKey();
const KEY_B = googleKey();

function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 4; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of the key were printed`);
}

/* ------------------------------------------------------------------- stub upstream */

const seen = []; // { url, key, body }
const next = []; // tool calls the stub hands out, in order: { id, name, args, sig }
const quotaKeys = new Set();

function geminiError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify([{ error: { code: status, message, status: code } }]));
}

function stub(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    const key = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-api-key'] || '';
    seen.push({ url: req.url, key, body });
    if (req.url.endsWith('/messages')) {
      // The Anthropic wire: one delta, then an error event that quotes the key.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial ' } })}\n\n`);
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `API key ${key} not valid` } })}\n\n`);
      return res.end();
    }
    if (req.url.endsWith('/embeddings') && body.model === 'echo-key') return geminiError(res, 400, 'INVALID_ARGUMENT', `API key ${key} not valid`);
    if (!req.url.endsWith('/chat/completions')) return geminiError(res, 404, 'NOT_FOUND', 'no such route');
    if (String(body.model).startsWith('slow')) await new Promise((r) => setTimeout(r, 700));
    if (body.model === 'quota' || body.model === 'slow-quota' || quotaKeys.has(key)) {
      return geminiError(res, 429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota. Please retry in 38s.', { 'retry-after': '38' });
    }
    if (body.model === 'invalid') return geminiError(res, 400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.');
    if (body.model === 'midstream-echo') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ error: { message: `API key ${key} not valid` } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // Gemini 3's rule: a replayed function call carries a signature. Which one it carries is
    // what the tests read off `seen`.
    for (const m of body.messages || []) {
      for (const tc of m.tool_calls || []) {
        if (!signatureOf(tc)) return geminiError(res, 400, 'INVALID_ARGUMENT', 'Function call is missing a thought_signature in functionCall parts.');
      }
    }
    if (body.tools && next.length) {
      const c = next.shift();
      const call = { id: c.id, type: 'function', function: { name: c.name, arguments: c.args }, extra_content: { google: { thought_signature: c.sig } } };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }));
  });
}

const ECHO = `#!/usr/bin/env node
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'event', event: { type: 'text_delta', delta: 'echo answer' } });
line({ type: 'result', sessionId: 'e1', subtype: 'success', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
`;

/* ----------------------------------------------------------------------- gateway */

let dir, upstream, server, base, gateway;
const log = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-relay-'));
  const echoBin = path.join(dir, 'echo-cli');
  fs.writeFileSync(echoBin, ECHO, { mode: 0o755 });
  upstream = http.createServer(stub);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1beta/openai`;
  const cfg = {
    auth: { enabled: true, keys: [K1, K2] },
    limits: { streamHoldMs: 250 },
    adapters: {
      google: { ...structuredClone(HTTP_PROFILES.google), baseUrl: upstreamBase, apiKey: KEY_A },
      // The same endpoint under a second key (a second free-tier project), written with a
      // trailing slash.
      google2: { ...structuredClone(HTTP_PROFILES.google), baseUrl: upstreamBase + '/', apiKey: KEY_B },
      anth: { kind: 'http', wire: 'anthropic', baseUrl: upstreamBase, apiKey: KEY_A },
      echo: { kind: 'cli', bin: echoBin, args: ['{prompt}'], parser: 'cmd-ndjson', models: ['x'], timeoutMs: 15_000 },
    },
    aliases: {
      gem: ['google/gemini-3.8-flash', 'google2/gemini-3.8-flash'],
      pref: ['google/quota', 'google2/invalid'],
      mixed: ['google/quota', 'echo/x'],
    },
  };
  gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  server = createServer(gateway, cfg, { log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(body, { key = K1, route = '/v1/chat/completions' } = {}) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const chats = () => seen.filter((s) => s.url.endsWith('/chat/completions'));
const MODEL = 'google/gemini-3.8-flash';
const tools = (...names) => names.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
/** An assistant turn the way LangChain's ChatOpenAI sends it back: no extra_content, arguments re-serialized. */
const asst = (id, fn) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: fn }] });
const result = (id) => ({ role: 'tool', tool_call_id: id, content: '{"ok":true}' });
/** The signatures the stub received on the last request, one per assistant tool call. */
const sentSigs = () => chats().at(-1).body.messages.filter((m) => m.role === 'assistant').map((m) => signatureOf(m.tool_calls[0]));

/* ------------------------------------------------------------ whose signature */

test('a replayed call gets a signature only under its own gateway key, and only when it names its function', async () => {
  const user = { role: 'user', content: 'Look up record 7.' };
  const t = tools('lookup_private_record');
  next.push({ id: 'call_10078', name: 'lookup_private_record', args: '{"record":7}', sig: 'SIG_OF_CALLER_A' });
  const t1 = await post({ model: MODEL, messages: [user], tools: t }, { key: K1 });
  assert.equal(t1.status, 200, t1.text);
  const replay = (fn, key) => post({ model: MODEL, messages: [user, asst('call_10078', fn), result('call_10078')], tools: t }, { key });

  await replay({ arguments: '{}' }, K2);
  assert.deepEqual(sentSigs(), [null], 'another gateway key, no function name: none of K1\'s signatures goes upstream');
  await replay({ name: 'lookup_private_record', arguments: '{"record": 7}' }, K2);
  assert.deepEqual(sentSigs(), [null], 'another gateway key, same name and arguments: still not its signature');
  await replay({ arguments: '{"record": 7}' }, K1);
  assert.deepEqual(sentSigs(), [null], 'a call that does not say which function it is gets nothing, whoever sends it');
  const own = await replay({ name: 'lookup_private_record', arguments: '{"record": 7}' }, K1);
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(sentSigs(), ['SIG_OF_CALLER_A'], 'its own call, re-serialized the way LangChain does it');
});

test('two conversations that drew the same call id each get their own signature back', async () => {
  const a = { role: 'user', content: 'conversation A: open a.example' };
  const b = { role: 'user', content: 'conversation B: open b.example' };
  const t = tools('browser_navigate', 'browser_snapshot');

  // Same id, same function, different arguments.
  next.push({ id: 'call_20001', name: 'browser_navigate', args: '{"url":"https://a.example"}', sig: 'SIG-A' });
  await post({ model: MODEL, messages: [a], tools: t });
  next.push({ id: 'call_20001', name: 'browser_navigate', args: '{"url":"https://b.example"}', sig: 'SIG-B' });
  await post({ model: MODEL, messages: [b], tools: t });
  const ra = await post({ model: MODEL, messages: [a, asst('call_20001', { name: 'browser_navigate', arguments: '{"url": "https://a.example"}' }), result('call_20001')], tools: t });
  assert.equal(ra.status, 200, ra.text);
  assert.deepEqual(sentSigs(), ['SIG-A'], 'conversation A gets A\'s signature, not the one stored after it');

  // Same id, same function, same (empty) arguments: told apart by the history before the call.
  next.push({ id: 'call_20002', name: 'browser_snapshot', args: '{}', sig: 'SNAP-A' });
  await post({ model: MODEL, messages: [a], tools: t });
  next.push({ id: 'call_20002', name: 'browser_snapshot', args: '{}', sig: 'SNAP-B' });
  await post({ model: MODEL, messages: [b], tools: t });
  await post({ model: MODEL, messages: [a, asst('call_20002', { name: 'browser_snapshot', arguments: '{}' }), result('call_20002')], tools: t });
  assert.deepEqual(sentSigs(), ['SNAP-A']);
  await post({ model: MODEL, messages: [b, asst('call_20002', { name: 'browser_snapshot', arguments: '{}' }), result('call_20002')], tools: t });
  assert.deepEqual(sentSigs(), ['SNAP-B']);
});

test('one conversation that draws the same call id again later gets each step\'s own signature', async () => {
  const u = { role: 'user', content: 'two steps' };
  const t = tools('step');
  next.push({ id: 'call_7', name: 'step', args: '{"n":1}', sig: 'STEP1' });
  await post({ model: MODEL, messages: [u], tools: t });
  next.push({ id: 'call_7', name: 'step', args: '{"n":2}', sig: 'STEP2' });
  const h1 = [u, asst('call_7', { name: 'step', arguments: '{"n": 1}' }), result('call_7')];
  await post({ model: MODEL, messages: h1, tools: t });
  assert.deepEqual(sentSigs(), ['STEP1']);
  const h2 = [...h1, asst('call_7', { name: 'step', arguments: '{"n": 2}' }), result('call_7')];
  const r = await post({ model: MODEL, messages: h2, tools: t });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(sentSigs(), ['STEP1', 'STEP2']);
});

/* ------------------------------------------------------------------- failover */

test('failover to a second google adapter on the same endpoint carries the signature over', async () => {
  const u = { role: 'user', content: 'failover' };
  const t = tools('get_weather');
  next.push({ id: 'call_30001', name: 'get_weather', args: '{"city":"Ankara"}', sig: 'SIG-P1' });
  const t1 = await post({ model: 'gem', messages: [u], tools: t });
  assert.equal(t1.status, 200, t1.text);
  assert.equal(chats().at(-1).key, KEY_A, 'turn 1 is answered by the first leg');
  quotaKeys.add(KEY_A);
  try {
    const before = chats().length;
    const t2 = await post({ model: 'gem', messages: [u, asst('call_30001', { name: 'get_weather', arguments: '{"city": "Ankara"}' }), result('call_30001')], tools: t });
    const legs = chats().slice(before).map((l) => [l.key === KEY_A ? 'google' : 'google2', signatureOf(l.body.messages[1].tool_calls[0])]);
    assert.deepEqual(legs, [['google', 'SIG-P1'], ['google2', 'SIG-P1']]);
    assert.equal(t2.status, 200, t2.text);
  } finally {
    quotaKeys.delete(KEY_A);
  }
});

test('a route whose first leg answered 429 reports that 429, not the refusal of the leg failover went on to', async () => {
  for (const body of [{ tools: tools('get_weather') }, {}, { stream: true }]) {
    const r = await post({ model: 'pref', messages: [{ role: 'user', content: 'hi' }], ...body });
    assert.equal(r.status, 429, `${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.headers.get('retry-after'), '38');
    assert.match(JSON.parse(r.text).error.message, /RESOURCE_EXHAUSTED/);
  }
});

test('a route with a CLI leg: the HTTP leg that refused the tools is not asked again, and the log says it refused', async () => {
  const before = chats().length;
  const logBefore = log.length;
  const r = await post({ model: 'mixed', messages: [{ role: 'user', content: 'hi' }], tools: tools('get_weather') });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /echo answer/);
  const legs = chats().slice(before);
  assert.equal(legs.length, 1, 'google is asked once, with its tools, not again without them');
  assert.ok(legs[0].body.tools);
  const lines = log.slice(logBefore).join('\n');
  assert.match(lines, /google\/quota refused \(429\)/);
  assert.doesNotMatch(lines, /no HTTP upstream matched/);
});

/* ------------------------------------------------------------ streamed answers */

test('a streamed request without tools: a refusal before the first event keeps its status, on every face', async () => {
  const user = { role: 'user', content: 'hi' };
  for (const [route, body] of [
    ['/v1/chat/completions', { model: 'google/quota', messages: [user], stream: true }],
    ['/v1/messages', { model: 'google/quota', max_tokens: 64, messages: [user], stream: true }],
    ['/v1/responses', { model: 'google/quota', input: 'hi', stream: true }],
  ]) {
    const r = await post(body, { route });
    assert.equal(r.status, 429, `${route}: ${r.text}`);
    assert.equal(r.headers.get('retry-after'), '38', route);
    assert.match(JSON.parse(r.text).error.message, /RESOURCE_EXHAUSTED/, route);
  }
});

test('a streamed answer slower than limits.streamHoldMs still opens, and a refusal after that is an SSE error frame', async () => {
  const ok = await post({ model: 'google/slow', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /^: stream open/);
  assert.match(ok.text, /"content":"done"/);
  const late = await post({ model: 'google/slow-quota', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(late.status, 200);
  assert.match(late.text, /"error":\{"message":"keysmith: google 429: RESOURCE_EXHAUSTED/);
  assert.ok(late.text.trimEnd().endsWith('data: [DONE]'));
});

test('an upstream error in the middle of a stream reaches no client with the provider key in it', async () => {
  const user = { role: 'user', content: 'hi' };
  const faces = [
    ['/v1/messages', { model: 'google/midstream-echo', max_tokens: 64, messages: [user], stream: true }],
    ['/v1/responses', { model: 'google/midstream-echo', input: 'hi', stream: true }],
    ['/v1/chat/completions', { model: 'google/midstream-echo', messages: [user], stream: true }],
    ['/v1/messages', { model: 'anth/x', max_tokens: 64, messages: [user], stream: true }],
  ];
  for (const [route, body] of faces) {
    const r = await post(body, { route });
    const where = `${route} ${body.model}`;
    assert.equal(r.status, 200, where);
    assert.match(r.text, /partial /, where);
    assertNoKey(r.text, KEY_A, where);
    if (route !== '/v1/chat/completions') {
      assert.match(r.text, /not valid/, `${where}: the failure is still reported`);
      assert.ok(r.text.includes(redactKey(KEY_A)), `${where}: as the redacted form`);
    }
  }
  // At the source: the adapters' own error events, for whatever else consumes them.
  for (const [id, model] of [['google', 'midstream-echo'], ['anth', 'x']]) {
    const events = [];
    for await (const e of gateway.adapters.get(id).complete({ model, messages: [user] })) events.push(e);
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, `${id}: an error event`);
    assertNoKey(err.message, KEY_A, `${id} error event`);
  }
  assertNoKey(log.join('\n'), KEY_A, 'log');
  assertNoKey(log.join('\n'), KEY_B, 'log');
});

test('an embeddings refusal that quotes the provider key reaches the client redacted, with its status', async () => {
  const r = await post({ model: 'google/echo-key', input: 'hello' }, { route: '/v1/embeddings' });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /not valid/);
  assertNoKey(r.text, KEY_A, '/v1/embeddings');
  assert.ok(r.text.includes(redactKey(KEY_A)), r.text);
});
