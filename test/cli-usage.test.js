/**
 * Token usage on the CLI paths: what each CLI reports, read one way (`input` every input token the
 * upstream charged, the ones read from or written to its cache included — the harness's own system
 * prompt with them), and written on every face; where a CLI reports none, the face says so
 * (`keysmith_usage: "unknown"` and the reason, 0 only where a client's parser requires a number —
 * src/protocols.js) and the usage row is null, never a 0. No CLI, no model: stub CLIs print each
 * one's stream.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { claudeStreamJson, codexJsonFinal } from '../src/parsers.js';
import { truncate } from '../src/util.js';

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

// A finding of the independent test of 2026-11-03. codex exec --json prints a stream error it
// retries as a top-level `error` line (exec's JSONL processor turns every ServerNotification::Error
// into ThreadEvent::Error; the app-server sends StreamError as one with will_retry: true, and exec
// sets its failure flag only when !will_retry), then goes on to turn.completed and exits 0. Plain
// `codex exec` (parser raw, before this branch) printed that notice on stderr and the answer on
// stdout. Through a stub that prints this run, every face answered 502 "codex: Reconnecting… 1/5".
test('codex-json-final: a stream error codex retries ("Reconnecting... 1/5") and a turn that then completes is the answer, not a failure', async () => {
  const events = await all(
    codexJsonFinal(
      lines([
        { type: 'thread.started', thread_id: 'th' },
        { type: 'turn.started' },
        { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses))' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'PONG' } },
        { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
      ]),
    ),
  );
  assert.deepEqual(events.filter((e) => e.type === 'delta'), [{ type: 'delta', text: 'PONG' }]);
  assert.deepEqual(events.filter((e) => e.type === 'error'), [], 'codex retried and answered: no error reaches the client');
});

test('codex-json: an `error` line is the run\'s failure when the turn does not complete — turn.failed says it once, and an end with no turn says the held line', async () => {
  const RETRY = { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' };
  const errors = async (parser, list) => (await all(parser(lines(list)))).filter((e) => e.type === 'error');
  const { codexJson } = await import('../src/parsers.js');
  for (const parser of [codexJson, codexJsonFinal]) {
    // The bridge's parser too: its run is one turn, and a retried error inside it is no failure.
    assert.deepEqual(await errors(parser, [{ type: 'turn.started' }, RETRY, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]), [], parser.name);
    // Retries spent: codex prints the error it will not retry, then turn.failed — one failure, turn.failed's.
    assert.deepEqual(await errors(parser, [{ type: 'turn.started' }, RETRY, { type: 'error', message: 'stream disconnected: gave up' }, { type: 'turn.failed', error: { message: 'stream disconnected: gave up' } }]), [{ type: 'error', message: 'codex: stream disconnected: gave up' }], parser.name);
    // turn.failed that names nothing: the held line names it.
    assert.deepEqual(await errors(parser, [{ type: 'turn.started' }, { type: 'error', message: 'quota exceeded' }, { type: 'turn.failed' }]), [{ type: 'error', message: 'codex: quota exceeded' }], parser.name);
    // No turn at all (a refused login, a bad flag), or a run that stopped mid-turn: the line is the failure.
    assert.deepEqual(await errors(parser, [{ type: 'error', message: 'not logged in' }]), [{ type: 'error', message: 'codex: not logged in' }], parser.name);
    assert.deepEqual(await errors(parser, [{ type: 'turn.started' }, RETRY]), [{ type: 'error', message: `codex: ${RETRY.message}` }], parser.name);
  }
  // A final message left unsent when the run stopped: the error goes first, as it was printed first (a 502, not a half answer).
  const ev = await all(codexJsonFinal(lines([{ type: 'turn.started' }, RETRY, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'half' } }])));
  assert.deepEqual(ev.map((e) => e.type), ['error', 'delta', 'done']);
});

// Independent re-check of 88f4cd1: what codex 0.163.0 printed live (2026-11-03) for a failure it
// does not retry — a model the ChatGPT account cannot use, exit 1: a warning item (`error` item),
// the top-level `error` line, then turn.failed with the same message.
test('codex-json-final: a failure codex does not retry, as 0.163.0 prints it live, is one error (turn.failed\'s), and its warning item is no tool', async () => {
  const why = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-nonexistent-zz\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
  const events = await all(
    codexJsonFinal(
      lines([
        { type: 'thread.started', thread_id: '01a1a223-8588-7e93-be46-d86e78df91cc' },
        { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-nonexistent-zz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
        { type: 'turn.started' },
        { type: 'error', message: why },
        { type: 'turn.failed', error: { message: why } },
      ]),
    ),
  );
  assert.deepEqual(events.map((e) => e.type), ['session', 'error', 'done']);
  assert.equal(events[1].message, `codex: ${why}`);
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
      // codex exec --json on a run whose stream codex retried once, then completed (exit 0).
      cxretry: {
        kind: 'cli',
        bin: stubCli('cxretry', `const p = process.argv.at(-1); const text = p.includes('Answer format') ? '{"final":"emulated"}' : 'PONG';
for (const l of [{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: error sending request)' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } }, { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }]) process.stdout.write(JSON.stringify(l) + '\\n');`),
        args: ['exec', '--json', '--', '{prompt}'],
        parser: 'codex-json-final',
        models: ['m'],
        cwd: path.join(dir, 'ws-cxretry'),
        toolMode: 'emulate',
      },
      // codex exec --json on a run whose stream codex is still retrying when keysmith's timeout ends it.
      cxhang: {
        kind: 'cli',
        bin: stubCli('cxhang', `for (const l of [{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }]) process.stdout.write(JSON.stringify(l) + '\\n');
setTimeout(() => {}, 20_000);`),
        args: ['exec', '--json', '--', '{prompt}'],
        parser: 'codex-json-final',
        models: ['m'],
        cwd: path.join(dir, 'ws-cxhang'),
        // Long enough for the stub to print its lines on a loaded machine (the full suite runs
        // files side by side): the case is a timeout while codex retries, not one before it starts.
        timeoutMs: 3000,
      },
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

test('a CLI that reports no tokens: on every face, streamed or not, the marker and the reason, null where the clients\' parsers take null and 0 only where they require a number; in the usage row null — never a 0', async () => {
  const faces = await usageOnEveryFace('plain/m');
  // The wire rule (src/protocols.js, usageUnknown): what the AI SDK's schemas require, field by field
  // (test/wire-conformance.test.js runs them). message_delta is the streamed Messages answer's usage.
  const expected = {
    chat: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached: null },
    messages: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    messagesStream: { input_tokens: null, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    // Codex CLI reads every Responses count into an integer, the details' ones included.
    responses: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached: 0, reasoning: 0 },
  };
  expected.chatStream = expected.chat;
  expected.responsesStream = expected.responses;
  for (const [face, [u, row]] of Object.entries(faces)) {
    assert.equal(u.keysmith_usage, 'unknown', face);
    assert.match(u.reason, /plain runs with parser raw: the CLI's plain output carries no token counts/, face);
    const seen = { ...u };
    if (face.startsWith('chat')) seen.cached = u.prompt_tokens_details.cached_tokens;
    if (face.startsWith('responses')) [seen.cached, seen.reasoning] = [u.input_tokens_details.cached_tokens, u.output_tokens_details.reasoning_tokens];
    for (const [k, v] of Object.entries(expected[face])) assert.equal(seen[k], v, `${face}: ${k}`);
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

test('codex: a stream error it retried, then a completed turn, is the answer on every face, streamed or not, with its usage — and through EMULATE', async () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const text = {
    chat: (t) => JSON.parse(t).choices[0].message.content,
    chatStream: (t) => sse(t).map((c) => c.choices?.[0]?.delta?.content || '').join(''),
    messages: (t) => JSON.parse(t).content.map((b) => b.text).join(''),
    messagesStream: (t) => sse(t).map((e) => e.delta?.text || '').join(''),
    responses: (t) => JSON.parse(t).output.flatMap((o) => o.content || []).map((c) => c.text).join(''),
    responsesStream: (t) => sse(t).filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''),
  };
  const asks = {
    chat: ['/v1/chat/completions', { model: 'cxretry/m', messages: msgs }],
    chatStream: ['/v1/chat/completions', { model: 'cxretry/m', messages: msgs, stream: true }],
    messages: ['/v1/messages', { model: 'cxretry/m', max_tokens: 64, messages: msgs }],
    messagesStream: ['/v1/messages', { model: 'cxretry/m', max_tokens: 64, messages: msgs, stream: true }],
    responses: ['/v1/responses', { model: 'cxretry/m', input: 'hi' }],
    responsesStream: ['/v1/responses', { model: 'cxretry/m', input: 'hi', stream: true }],
  };
  for (const [face, [route, body]] of Object.entries(asks)) {
    const r = await post(route, body);
    assert.equal(r.status, 200, `${face}: ${r.text}`);
    assert.doesNotMatch(r.text, /Reconnecting/, face);
    assert.equal(text[face](r.text), 'PONG', face);
    const row = lastRow();
    assert.equal(row.status, 'ok', face);
    assert.deepEqual([row.usage?.input, row.usage?.output], [100, 5], face);
  }
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const r = await post('/v1/chat/completions', { model: 'cxretry/m', tools, messages: msgs });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'emulated');
  assert.equal(lastRow().toolMode, 'emulate');
  assert.equal(lastRow().status, 'ok');
});

// A run keysmith's timeout ends while codex is still retrying its stream (found by the independent
// re-check of 88f4cd1). The held `Reconnecting...` line is reported at the stream's end, before the
// adapter looks at the exit: it used to reach the client as a 502 "codex: Reconnecting... 1/5", with
// no word of the timeout. An error the parser reports after keysmith's own clock stopped the run is
// that timeout: a 504 naming it, the CLI's last error after it.
test('codex: a run the timeout ends while codex retries its stream is a 504 that names the timeout, and the retried error with it', async () => {
  const r = await post('/v1/chat/completions', { model: 'cxhang/m', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 504, r.text);
  assert.match(JSON.parse(r.text).error.message, /timeout after 3000ms/);
  assert.match(JSON.parse(r.text).error.message, /Reconnecting\.\.\. 1\/5/, 'the retried error rides with it');
  assert.match(lastRow().error, /timeout/);
});

test('EMULATE through a CLI that reports no tokens: the answer says so the same way', async () => {
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const r = await post('/v1/chat/completions', { model: 'plain/m', tools, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.equal(body.choices[0].message.content, 'emulated');
  assert.equal(body.usage.prompt_tokens, null);
  assert.equal(body.usage.keysmith_usage, 'unknown');
  assert.match(body.usage.reason, /parser raw/);
  assert.equal(lastRow().toolMode, 'emulate');
  assert.equal(lastRow().usage, null);
});

/* --------------------------------------- keysmith usage: recent-row filters */

describe('keysmith usage recent-row filters', () => {
  const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  // Oldest first. Two fingerprints, ok/error/limited/blocked, priced and unpriced. Tail reads newest first.
  const ROWS = [
    { ts: '2026-11-20T12:00:01.000Z', key: 'fp:aaaa1111', model: 'price-low', status: 'ok', ms: 10, tag: 'ci', usage: { input: 1, output: 1 }, cost: { usd: 0.1, basis: 'list' }, via: '/v1/chat/completions' },
    { ts: '2026-11-20T12:00:02.000Z', key: 'fp:aaaa1111', model: 'err-ci', status: 'error', ms: 20, tag: 'ci', usage: { input: 2, output: 0 }, cost: { usd: 0.6, basis: 'metered' }, error: 'boom', via: '/v1/chat/completions' },
    { ts: '2026-11-20T12:00:03.000Z', key: 'fp:bbbb2222', model: 'price-high', status: 'ok', ms: 30, tag: 'other', usage: { input: 3, output: 3 }, cost: { usd: 1.2, basis: 'list' }, via: '/v1/chat/completions' },
    { ts: '2026-11-20T12:00:04.000Z', key: 'fp:bbbb2222', model: 'lim-row', status: 'limited', ms: 0, tag: null, usage: null, cost: { usd: null, basis: 'unpriced' }, error: 'cap', via: '/v1/chat/completions' },
    { ts: '2026-11-20T12:00:04.500Z', key: 'fp:aaaa1111', model: 'guard-blk', status: 'blocked', ms: 0, tag: null, usage: null, cost: { usd: null, basis: 'unpriced' }, guard: 'blocked', guardKinds: ['github-token'], error: 'request blocked by secret guard (github-token)', face: 'chat' },
    { ts: '2026-11-20T12:00:05.000Z', key: 'fp:aaaa1111', model: 'err-noprice', status: 'error', ms: 40, tag: 'ci', usage: null, cost: { usd: null, basis: 'unpriced', reason: 'no usage' }, error: 'nope', via: '/v1/chat/completions' },
    { ts: '2026-11-20T12:00:06.000Z', key: 'fp:aaaa1111', model: 'err-slow', status: 'error', ms: 500, tag: 'nightly', usage: { input: 9, output: 1 }, cost: { usd: 0.5, basis: 'metered' }, error: 'slow', via: '/v1/messages' },
  ];
  let dir;
  let env;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cli-usage-filters-'));
    fs.writeFileSync(path.join(dir, 'usage.jsonl'), ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    env = {
      ...process.env,
      KEYSMITH_DATA: dir,
      KEYSMITH_CONFIG: path.join(dir, 'no-such-config.json'),
    };
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  }

  function recentLine(e) {
    const st = e.status === 'ok' ? 'ok  ' : e.status === 'blocked' ? 'BLK ' : 'ERR ';
    return `  ${e.ts}  ${st}  ${(e.model || '?').padEnd(40)} ${String(e.ms).padStart(6)}ms  ${e.usage?.input || 0}→${e.usage?.output || 0}  ${truncate(e.error || '', 60)}`;
  }

  /** The `recent:` block, including the blank line `out('\\nrecent:')` writes before it. */
  function recentBlock(entries, extra = []) {
    return `\nrecent:\n${[...entries.map(recentLine), ...extra].join('\n')}\n`;
  }

  function statsOf(payload) {
    const rest = { ...payload };
    delete rest.entries;
    delete rest.entriesUnpriced;
    return rest;
  }

  test('usage --help names the recent-row flags', () => {
    const help = run(['usage', '--help']);
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ['--tail', '--status', '--tag', '--key', '--model', '--min-cost', '--min-ms', 'blocked']) {
      assert.ok(help.stdout.includes(flag), flag);
    }
    assert.match(help.stdout, /need --tail/);
  });

  test('--status error lists only error rows, and the totals stay the whole log', () => {
    const plain = run(['usage', '--tail', '50', '--format', 'json']);
    const filtered = run(['usage', '--tail', '50', '--status', 'error', '--format', 'json']);
    assert.equal(filtered.status, 0, filtered.stderr);
    const all = JSON.parse(plain.stdout);
    const body = JSON.parse(filtered.stdout);
    assert.deepEqual(body.entries.map((e) => e.model), ['err-slow', 'err-noprice', 'err-ci']);
    assert.ok(body.entries.every((e) => e.status === 'error'));
    assert.equal(Object.hasOwn(body, 'entriesUnpriced'), false);
    assert.deepEqual(statsOf(body), statsOf(all));
    const table = run(['usage', '--tail', '50', '--status', 'error']);
    assert.equal(table.status, 0, table.stderr);
    const shown = ROWS.filter((e) => e.status === 'error').slice().reverse();
    assert.ok(table.stdout.endsWith(recentBlock(shown)), table.stdout.slice(table.stdout.lastIndexOf('recent:')));
    assert.equal(table.stdout.split('\nrecent:\n')[0], run(['usage', '--tail', '50']).stdout.split('\nrecent:\n')[0]);
  });

  test('--status blocked lists only guard-blocked rows, and renders BLK in table output', () => {
    const plain = run(['usage', '--tail', '50', '--format', 'json']);
    const filtered = run(['usage', '--tail', '50', '--status', 'blocked', '--format', 'json']);
    assert.equal(filtered.status, 0, filtered.stderr);
    const all = JSON.parse(plain.stdout);
    const body = JSON.parse(filtered.stdout);
    assert.deepEqual(body.entries.map((e) => e.model), ['guard-blk']);
    assert.ok(body.entries.every((e) => e.status === 'blocked'));
    assert.equal(Object.hasOwn(body, 'entriesUnpriced'), false);
    assert.deepEqual(statsOf(body), statsOf(all));
    const table = run(['usage', '--tail', '50', '--status', 'blocked']);
    assert.equal(table.status, 0, table.stderr);
    const shown = ROWS.filter((e) => e.status === 'blocked').slice().reverse();
    assert.ok(table.stdout.includes('  BLK   guard-blk'), table.stdout);
    assert.ok(table.stdout.endsWith(recentBlock(shown)), table.stdout.slice(table.stdout.lastIndexOf('recent:')));
    assert.equal(table.stdout.split('\nrecent:\n')[0], run(['usage', '--tail', '50']).stdout.split('\nrecent:\n')[0]);
  });

  test('--tag ci lists only rows sent with that tag', () => {
    const runTag = run(['usage', '--tail', '50', '--tag', 'ci', '--format', 'json']);
    assert.equal(runTag.status, 0, runTag.stderr);
    const body = JSON.parse(runTag.stdout);
    assert.deepEqual(body.entries.map((e) => e.model), ['err-noprice', 'err-ci', 'price-low']);
    assert.ok(body.entries.every((e) => e.tag === 'ci'));
    const table = run(['usage', '--tail', '50', '--tag', 'ci']);
    const shown = ROWS.filter((e) => e.tag === 'ci').slice().reverse();
    assert.ok(table.stdout.endsWith(recentBlock(shown)), table.stdout);
  });

  test('--min-cost 0.5 lists priced rows at or above 0.5 USD and says how many were unpriced', () => {
    const json = run(['usage', '--tail', '50', '--min-cost', '0.5', '--format', 'json']);
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.deepEqual(body.entries.map((e) => e.model), ['err-slow', 'price-high', 'err-ci']);
    assert.ok(body.entries.every((e) => e.cost.usd >= 0.5 && e.cost.basis !== 'unpriced'));
    assert.equal(body.entriesUnpriced, 3);
    const plain = JSON.parse(run(['usage', '--tail', '50', '--format', 'json']).stdout);
    assert.deepEqual(statsOf(body), statsOf(plain));
    const table = run(['usage', '--tail', '50', '--min-cost', '0.5']);
    assert.equal(table.status, 0, table.stderr);
    const shown = ROWS.filter((e) => e.model === 'err-slow' || e.model === 'price-high' || e.model === 'err-ci').slice().reverse();
    assert.ok(table.stdout.endsWith(recentBlock(shown, ['  unpriced: 3 left out'])), table.stdout.slice(table.stdout.lastIndexOf('recent:')));
    assert.equal(table.stdout.split('\nrecent:\n')[0], run(['usage', '--tail', '50']).stdout.split('\nrecent:\n')[0]);
  });

  test('--key, --model and --min-ms narrow the same recent list', () => {
    const byKey = JSON.parse(run(['usage', '--tail', '50', '--key', 'fp:bbbb2222', '--format', 'json']).stdout);
    assert.deepEqual(byKey.entries.map((e) => e.model), ['lim-row', 'price-high']);
    const byModel = JSON.parse(run(['usage', '--tail', '50', '--model', 'price-high', '--format', 'json']).stdout);
    assert.deepEqual(byModel.entries.map((e) => e.model), ['price-high']);
    const byMs = JSON.parse(run(['usage', '--tail', '50', '--min-ms', '100', '--format', 'json']).stdout);
    assert.deepEqual(byMs.entries.map((e) => e.model), ['err-slow']);
    const bad = run(['usage', '--tail', '50', '--min-cost', 'abc']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--min-cost/);
    assert.equal(bad.stdout, '');
  });

  test('--status error without --tail exits non-zero and explains', () => {
    const missing = run(['usage', '--status', 'error']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /need --tail/);
    assert.match(missing.stderr, /--status/);
    assert.equal(missing.stdout, '');

    const bareTail = run(['usage', '--tail', '--status', 'error']);
    assert.notEqual(bareTail.status, 0);
    assert.match(bareTail.stderr, /need --tail/);
  });

  test('--tail without a new flag matches the unfiltered log, json and the recent lines', () => {
    const json = run(['usage', '--tail', '5', '--format', 'json']);
    assert.equal(json.status, 0, json.stderr);
    const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { pricing: {} });
    const expected = JSON.stringify({ ...usage.query({ by: ['model'], hours: null }), entries: usage.tail(5) }, null, 2) + '\n';
    assert.equal(json.stdout, expected);
    assert.equal(Object.hasOwn(JSON.parse(json.stdout), 'entriesUnpriced'), false);
    assert.deepEqual(JSON.parse(json.stdout).entries.map((e) => e.ts), ROWS.slice(-5).map((e) => e.ts).reverse());
    const again = run(['usage', '--tail', '5', '--format', 'json']);
    assert.equal(again.stdout, json.stdout);
    const table = run(['usage', '--tail', '5']);
    assert.equal(table.status, 0, table.stderr);
    assert.ok(table.stdout.endsWith(recentBlock(ROWS.slice(-5).slice().reverse())), table.stdout.slice(table.stdout.lastIndexOf('recent:')));
    const csvTail = run(['usage', '--tail', '5', '--format', 'csv']);
    const csvPlain = run(['usage', '--format', 'csv']);
    assert.equal(csvTail.status, 0, csvTail.stderr);
    assert.equal(csvTail.stdout, csvPlain.stdout);
  });
});
