/**
 * Token usage on the CLI paths: what each CLI reports, read one way (`input` every input token the
 * upstream charged, the ones read from or written to its cache included — the harness's own system
 * prompt with them), and written on every face; where a CLI reports none, null counts and the
 * reason, never a 0. No CLI, no model: stub CLIs print each one's stream.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { claudeStreamJson, codexJsonFinal } from '../src/parsers.js';

const KEY = 'ks_test_usage_00000000000000000000';
let dir, server, base, gateway, usageLog;

async function* lines(list) {
  for (const l of list) yield typeof l === 'string' ? l : JSON.stringify(l);
}
async function all(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Claude Code 2.1.303's stream-json for a run with one MCP call, as a stub Messages endpoint saw it: the usage of a message's start on each of its content blocks. */
const CLAUDE_RUN = [
  { type: 'system', subtype: 'init', tools: ['mcp__ks0a1b2c__get_weather'] },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Let me check.' }], usage: { input_tokens: 7, cache_creation_input_tokens: 1001, cache_read_input_tokens: 5000, output_tokens: 1 } } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__ks0a1b2c__get_weather', input: { city: 'Ankara' } }], usage: { input_tokens: 7, cache_creation_input_tokens: 1001, cache_read_input_tokens: 5000, output_tokens: 1 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] } },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Final answer.' }], usage: { input_tokens: 7, cache_creation_input_tokens: 1002, cache_read_input_tokens: 5000, output_tokens: 1 } } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Final answer.', session_id: 's1', usage: { input_tokens: 14, cache_creation_input_tokens: 2003, cache_read_input_tokens: 10000, output_tokens: 52 } },
];

test('claude-stream-json: the result line is the run\'s whole spend, the cache read and written counted as input; per message on the bridge, each message once', async () => {
  const text = await all(claudeStreamJson(lines(CLAUDE_RUN)));
  assert.deepEqual(text.filter((e) => e.type === 'usage'), [{ type: 'usage', usage: { input: 12017, output: 52, cacheRead: 10000, cacheWrite: 2003 }, scope: 'run' }], 'a text run reports the result line only, as before');
  const bridge = await all(claudeStreamJson(lines(CLAUDE_RUN), { perMessageUsage: true }));
  assert.deepEqual(bridge.filter((e) => e.type === 'usage'), [
    { type: 'usage', usage: { input: 6008, output: 1, cacheRead: 5000, cacheWrite: 1001 }, scope: 'step' },
    { type: 'usage', usage: { input: 6009, output: 1, cacheRead: 5000, cacheWrite: 1002 }, scope: 'step' },
    { type: 'usage', usage: { input: 12017, output: 52, cacheRead: 10000, cacheWrite: 2003 }, scope: 'run' },
  ], 'msg_1 printed twice is reported once');
});

test('codex-json-final: what plain `codex exec` prints — the last agent message, a preamble left out — and the run\'s usage, reasoning and cache included', async () => {
  const events = await all(
    codexJsonFinal(
      lines([
        { type: 'thread.started', thread_id: 'th' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Thinking about it.' } },
        { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'r' } },
        { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'OK' } },
        { type: 'turn.completed', usage: { input_tokens: 21000, cached_input_tokens: 15000, output_tokens: 40, reasoning_output_tokens: 12 } },
      ]),
    ),
  );
  assert.deepEqual(events.filter((e) => e.type === 'delta'), [{ type: 'delta', text: 'OK' }]);
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', usage: { input: 21000, output: 40, cacheRead: 15000, cacheWrite: 0, reasoning: 12 }, scope: 'run' });
  assert.equal(events.at(-1).type, 'done');
});

test('the Anthropic wire: input_tokens is the uncached input, so the cache\'s counts are added to `input`', async () => {
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { id: 'm', usage: { input_tokens: 9, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 1 } } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  try {
    const a = new HttpAdapter('anth', { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKey: false, wire: 'anthropic' });
    const events = await all(a.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }));
    assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 909, output: 1, cacheRead: 800, cacheWrite: 100 });
  } finally {
    up.close();
  }
});

/* ------------------------------------------------------------------- through the faces */

function stubCli(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-usage-'));
  const claudeOut = CLAUDE_RUN.map((l) => JSON.stringify(l)).join('\n');
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 200, streamKeepaliveMs: 0 },
    adapters: {
      // Plain stdout: nothing in it says what the run spent.
      plain: { kind: 'cli', bin: stubCli('plain', `const p = process.argv.at(-1); process.stdout.write(p.includes('Answer format') ? '{"final":"emulated"}' : 'plain answer');`), args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: path.join(dir, 'ws-plain'), toolMode: 'emulate' },
      // Claude Code's stream, its cache counts and all.
      cc: { kind: 'cli', bin: stubCli('cc', `process.stdout.write(${JSON.stringify(claudeOut)} + '\\n');`), args: ['{prompt}'], parser: 'claude-stream-json', models: ['m'] },
    },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await gateway.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
const sse = (text) => text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).filter((l) => l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
const lastRow = () => usageLog.tail(1)[0];

/** The usage each face writes for one request to `model`, streamed and not. */
async function usageOnEveryFace(model, extra = {}) {
  const msgs = [{ role: 'user', content: 'hi' }];
  const out = {};
  let r = await post('/v1/chat/completions', { model, messages: msgs, ...extra.chat });
  assert.equal(r.status, 200, r.text);
  out.chat = [JSON.parse(r.text).usage, lastRow()];
  r = await post('/v1/chat/completions', { model, messages: msgs, stream: true, stream_options: { include_usage: true }, ...extra.chat });
  out.chatStream = [sse(r.text).find((c) => c.usage)?.usage, lastRow()];
  r = await post('/v1/messages', { model, max_tokens: 64, messages: msgs, ...extra.messages });
  assert.equal(r.status, 200, r.text);
  out.messages = [JSON.parse(r.text).usage, lastRow()];
  r = await post('/v1/messages', { model, max_tokens: 64, messages: msgs, stream: true, ...extra.messages });
  out.messagesStream = [sse(r.text).find((e) => e.type === 'message_delta')?.usage, lastRow()];
  r = await post('/v1/responses', { model, input: 'hi', ...extra.responses });
  assert.equal(r.status, 200, r.text);
  out.responses = [JSON.parse(r.text).usage, lastRow()];
  r = await post('/v1/responses', { model, input: 'hi', stream: true, ...extra.responses });
  out.responsesStream = [sse(r.text).find((e) => e.type === 'response.completed')?.response.usage, lastRow()];
  return out;
}

test('a CLI that reports no tokens: null counts and the reason on every face, streamed or not, and in the usage row — never a 0', async () => {
  const faces = await usageOnEveryFace('plain/m');
  for (const [face, [u, row]] of Object.entries(faces)) {
    assert.match(u.reason, /plain runs with parser raw: the CLI's plain output carries no token counts/, face);
    const counts = face.startsWith('chat') ? [u.prompt_tokens, u.completion_tokens] : [u.input_tokens, u.output_tokens];
    assert.deepEqual(counts, [null, null], face);
    assert.equal(row.usage, null, face);
    assert.match(row.usageReason, /parser raw/, face);
  }
});

test('Claude Code\'s counts: every input token on the OpenAI faces (the cached ones as cached_tokens), the uncached input and the cache\'s two counts apart on /v1/messages', async () => {
  const faces = await usageOnEveryFace('cc/m');
  for (const face of ['chat', 'chatStream']) {
    const [u] = faces[face];
    assert.deepEqual([u.prompt_tokens, u.completion_tokens, u.total_tokens, u.prompt_tokens_details.cached_tokens, u.reason], [12017, 52, 12069, 10000, undefined], face);
  }
  for (const face of ['messages', 'messagesStream']) {
    assert.deepEqual(faces[face][0], { input_tokens: 14, cache_creation_input_tokens: 2003, cache_read_input_tokens: 10000, output_tokens: 52 }, face);
  }
  for (const face of ['responses', 'responsesStream']) {
    const [u] = faces[face];
    assert.deepEqual([u.input_tokens, u.input_tokens_details.cached_tokens, u.output_tokens, u.total_tokens], [12017, 10000, 52, 12069], face);
  }
  assert.deepEqual(faces.chat[1].usage, { input: 12017, output: 52, cacheRead: 10000, cacheWrite: 2003 });
  assert.equal(faces.chat[1].usageReason, undefined);
});

test('EMULATE through a CLI that reports no tokens: the answer says so the same way', async () => {
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const r = await post('/v1/chat/completions', { model: 'plain/m', tools, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.equal(body.choices[0].message.content, 'emulated');
  assert.equal(body.usage.prompt_tokens, null);
  assert.match(body.usage.reason, /parser raw/);
  assert.equal(lastRow().toolMode, 'emulate');
  assert.equal(lastRow().usage, null);
});
