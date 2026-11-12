/**
 * The Messages face's verbatim relay (server.js relayMessagesLeg): a request on /v1/messages that
 * offers tools — Claude Code's — reaching a leg on the anthropic wire as the client wrote it, and
 * the upstream's answer coming back as it is. Against a stub Messages API; nothing spends a token.
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
import { UsageLog } from '../src/usage.js';
import { anthropicBetas, pickMessagesRelayFields } from '../src/http-adapter.js';

const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const UPSTREAM_KEY = 'sk-ant-api03-' + crypto.randomBytes(30).toString('base64url');

const seen = []; // { url, headers, body }
let dripClosed = 0;

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_up', type: 'message', role: 'assistant', model: 'claude-sonnet-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
  .join('');

const MESSAGE = (model) => ({
  id: 'msg_up',
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 11, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 9 },
});

function stub(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, headers: req.headers, body });
    if (!req.url.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (body.model === 'quota') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'stub quota exhausted' } }));
    }
    if (body.model === 'slowhead') await new Promise((r) => setTimeout(r, 400));
    if (body.model === 'drip') {
      // One event, then the rest of a long answer at a crawl: a client that leaves must stop it.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE.split('\n\n')[0] + '\n\n');
      const t = setInterval(() => res.write(': still going\n\n'), 100);
      res.on('close', () => {
        clearInterval(t);
        dripClosed = Date.now();
      });
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_stub_1' });
      return res.end(SSE);
    }
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_stub_1' });
    res.end(JSON.stringify(MESSAGE(body.model)));
  });
}

let dir, upstream, server, base, usage;
const log = [];
const ECHO = `#!/usr/bin/env node
process.stdout.write('echo text answer');
`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-msg-relay-'));
  const echoBin = path.join(dir, 'echo-cli');
  fs.writeFileSync(echoBin, ECHO, { mode: 0o755 });
  upstream = http.createServer(stub);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 100, streamKeepaliveMs: 60 },
    adapters: {
      claude: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: UPSTREAM_KEY, models: ['sonnet', 'quota', 'slowhead', 'drip'], modelMap: { sonnet: 'claude-sonnet-x' } },
      echo: { kind: 'cli', bin: echoBin, args: ['{prompt}'], parser: 'raw', models: ['x'], timeoutMs: 15_000 },
    },
    aliases: { claudes: ['claude/quota', 'claude/sonnet'], mixed: ['claude/quota', 'echo/x'], slow: ['claude/slowhead'] },
  };
  usage = new UsageLog(path.join(dir, 'usage.jsonl'));
  const gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  server = createServer(gateway, cfg, { usage, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];

async function post(body, headers = {}) {
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const lastRow = () => usage.tail(1)[0];

test('pickMessagesRelayFields and anthropicBetas: the Messages API fields a relay passes on, and the client\'s beta features without an OAuth one', () => {
  const body = { model: 'm', messages: [], system: 's', max_tokens: 5, tools: [], tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 1024 }, metadata: { user_id: 'u' }, context_management: {}, output_config: { effort: 'high' }, mcp_servers: [{ url: 'https://x' }], container: 'c', keysmith: 1 };
  assert.deepEqual(Object.keys(pickMessagesRelayFields(body)).sort(), ['context_management', 'max_tokens', 'messages', 'metadata', 'model', 'output_config', 'system', 'thinking', 'tool_choice', 'tools']);
  assert.equal(anthropicBetas(['claude-code-20250219, oauth-2025-04-20,interleaved-thinking-2025-05-14', 'claude-code-20250219', 'bad token;x']), 'claude-code-20250219,interleaved-thinking-2025-05-14');
  assert.equal(anthropicBetas([null, '']), null);
});

test('/v1/messages with tools on an anthropic-wire leg: the body goes up verbatim (its model mapped, the adapter\'s key) and the answer comes back as it is', async () => {
  seen.length = 0;
  const body = { model: 'claude/sonnet', max_tokens: 256, system: 'be brief', tools: TOOLS, tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 1024 }, metadata: { user_id: 'u1' }, mcp_servers: [{ type: 'url', url: 'https://example.invalid' }], messages: [{ role: 'user', content: 'read /x' }] };
  const r = await post(body, { 'anthropic-beta': 'interleaved-thinking-2025-05-14,oauth-2025-04-20' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
  assert.deepEqual(JSON.parse(r.text), MESSAGE('claude-sonnet-x'), 'the upstream\'s answer, byte for byte');
  assert.equal(seen.length, 1);
  const [up] = seen;
  assert.equal(up.url, '/v1/messages');
  assert.equal(up.headers['x-api-key'], UPSTREAM_KEY, 'the adapter\'s credential, never the gateway key');
  assert.equal(up.headers['anthropic-version'], '2023-06-01');
  assert.equal(up.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  assert.equal(up.body.model, 'claude-sonnet-x');
  assert.deepEqual(up.body.tools, TOOLS);
  assert.deepEqual([up.body.tool_choice, up.body.thinking, up.body.system, up.body.max_tokens, up.body.metadata], [body.tool_choice, body.thinking, 'be brief', 256, body.metadata]);
  assert.equal('mcp_servers' in up.body, false);
  const row = lastRow();
  assert.deepEqual([row.status, row.toolMode, row.via, row.stream], ['ok', 'passthrough', 'passthrough', false]);
  assert.deepEqual([row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheWrite], [18, 9, 5, 2]);
  assert.ok(!JSON.stringify(row).includes(UPSTREAM_KEY));
});

test('/v1/messages streamed with tools: the upstream\'s SSE verbatim, its usage in the row', async () => {
  const r = await post({ model: 'claude/sonnet', max_tokens: 256, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'read /x' }] });
  assert.equal(r.status, 200, r.text);
  // SSE comments first when the hold (100 ms here) ran out before the upstream answered; never a frame of keysmith's.
  assert.equal(r.text.replace(/^(?::[^\n]*\n\n)+/, ''), SSE, 'nothing of keysmith\'s in the stream');
  const row = lastRow();
  assert.deepEqual([row.status, row.toolMode, row.stream], ['ok', 'passthrough', true]);
  assert.deepEqual([row.usage.input, row.usage.output], [18, 9]);
});

test('a refusal before anything went out hands the request on: a 429 leg, then the next anthropic leg answers; a text-only leg after it is never asked', async () => {
  seen.length = 0;
  let r = await post({ model: 'claudes', max_tokens: 64, tools: TOOLS, messages: [{ role: 'user', content: 'read /x' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).content[0].type, 'tool_use');
  assert.deepEqual(seen.map((s) => s.body.model), ['quota', 'claude-sonnet-x']);
  // [claude/quota, echo/x]: echo carries no tools (toolMode off), so the 429 is the answer — never a text answer in its place.
  r = await post({ model: 'mixed', max_tokens: 64, tools: TOOLS, messages: [{ role: 'user', content: 'read /x' }] });
  assert.equal(r.status, 429, r.text);
  const err = JSON.parse(r.text);
  assert.equal(err.type, 'error');
  assert.match(err.error.message, /claude 429: stub quota exhausted/);
  assert.doesNotMatch(r.text, /echo text answer/);
  // tool_choice none asks for text: the relay still takes it (the upstream reads tool_choice itself).
  seen.length = 0;
  r = await post({ model: 'claude/sonnet', max_tokens: 64, tools: TOOLS, tool_choice: { type: 'none' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(seen[0].body.tool_choice, { type: 'none' });
});

test('a stream whose hold ran out before the upstream answered: the face wrote comments only, and the relay carries on in it', async () => {
  const r = await post({ model: 'slow', max_tokens: 64, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'read /x' }] });
  assert.equal(r.status, 200);
  const frames = r.text.replace(/^(?::[^\n]*\n\n)+/, '');
  assert.ok(r.text.startsWith(': stream open\n\n'), 'the stream opened while the upstream was asked');
  assert.equal(frames, SSE, 'then the upstream\'s SSE alone: no message_start of keysmith\'s before it');
  assert.deepEqual([lastRow().status, lastRow().toolMode], ['ok', 'passthrough']);
});

test('AnthropicStream lazy: comments only until the answer has something; message_start then; detach() hands the stream over', async () => {
  const { AnthropicStream } = await import('../src/tools/faces.js');
  const writes = [];
  const res = { write: (s) => writes.push(s), end: () => writes.push('<end>'), once() {}, writableEnded: false, destroyed: false };
  const face = new AnthropicStream(res, { id: 'x', model: 'm', keepaliveMs: 0, lazy: true });
  face.open();
  assert.deepEqual(writes, []);
  assert.equal(face.wroteData, false);
  face.text('hi');
  assert.match(writes[0], /^event: message_start\n/);
  assert.match(writes[1], /^event: content_block_start\n/);
  assert.equal(face.wroteData, true);
  const other = new AnthropicStream(res, { id: 'y', model: 'm', keepaliveMs: 0, lazy: true });
  other.open();
  other.detach();
  const before = writes.length;
  other.text('never');
  other.finish();
  other.fail('never');
  assert.equal(writes.length, before, 'a detached face writes nothing');
});

test('an HTTP upstream that sends its headers and then goes quiet past the budget: a 504 that names the adapter, and the route moves on', async () => {
  const { HttpAdapter } = await import('../src/http-adapter.js');
  const hang = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/ok/')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok answer' } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n'); // then nothing
    });
  });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${hang.address().port}`;
  try {
    const a = new HttpAdapter('hangbody', { baseUrl: `${at}/hang/v1`, apiKey: false, timeoutMs: 300, models: ['m'] });
    const t0 = Date.now();
    await assert.rejects(
      (async () => {
        for await (const evt of a.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) void evt;
      })(),
      (e) => e.status === 504 && /^hangbody: timeout after 300ms$/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 3_000);
    const gw = new Gateway({ adapters: { hangbody: { kind: 'http', baseUrl: `${at}/hang/v1`, apiKey: false, timeoutMs: 300, models: ['m'] }, okhttp: { kind: 'http', baseUrl: `${at}/ok/v1`, apiKey: false, models: ['m'] } }, aliases: { both: ['hangbody/m', 'okhttp/m'] } }, { log: () => {} });
    await assert.rejects(gw.collect({ model: 'hangbody/m', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 504);
    const r = await gw.collect({ model: 'both', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, 'ok answer');
  } finally {
    hang.closeAllConnections?.();
    await new Promise((r) => hang.close(r));
  }
});

test('a client that leaves mid-answer (Claude Code\'s Esc) stops the upstream\'s answer: it is not run, and paid for, to its end', async () => {
  dripClosed = 0;
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', signal: ctrl.signal, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude/drip', max_tokens: 64, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'go' }] }) });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /message_start/);
  const left = Date.now();
  ctrl.abort();
  for (let i = 0; i < 40 && !dripClosed; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(dripClosed && dripClosed - left < 1_500, 'the upstream request was closed soon after the client left');
  for (let i = 0; i < 40 && lastRow()?.error !== 'client disconnected'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([lastRow().status, lastRow().error], ['error', 'client disconnected']);
});
