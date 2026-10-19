/**
 * Tool routing (src/tools/router.js, gateway._toolRoute): a request that offers tools walks its
 * route in declared order — an HTTP upstream verbatim, a CLI with a toolMode through a tool
 * engine, a CLI without one passed by — fails over while nothing went out, and when no leg took
 * it answers in text only where tool_choice allows. Also the gates around toolMode: the config
 * errors, the auto-approve scan over every argv template, `keysmith set <id> toolMode`.
 *
 * The CLI is test/stubs/agy-emu.mjs, Google a stub upstream, the MCP bridge a stub engine:
 * nothing here spends a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway, checkAdapter } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { autoApproveFlag } from '../src/cli-adapter.js';
import { namesFit, pickEngine } from '../src/tools/router.js';

const STUB = fileURLToPath(new URL('./stubs/agy-emu.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const NO_GOOGLE = 'ks_' + crypto.randomBytes(24).toString('base64url');
const NO_AGY = 'ks_' + crypto.randomBytes(24).toString('base64url');

/* -------------------------------------------------------------------- stub Google */

const hits = []; // bodies Google was sent
function google(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    hits.push(body);
    if (body.model === 'quota') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '38' });
      return res.end(JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED' } }]));
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'g-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'google answer' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'g-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'g-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'google answer' }, finish_reason: 'stop' }] }));
  });
}

/* ------------------------------------------------------------------------ gateway */

let dir, upstream, server, base, gateway, usageLog;
const log = [];

/** The agy profile around the stub, with a toolMode (or none). */
function agy(toolMode, extra = {}) {
  const p = CLI_PROFILES.agy;
  return {
    kind: 'cli',
    bin: STUB,
    args: p.args,
    emulateArgs: p.emulateArgs,
    parser: p.parser,
    cwd: path.join(dir, `ws-${toolMode || 'none'}`),
    workspaceFiles: p.workspaceFiles,
    stopAtToolCall: true,
    ...(toolMode ? { toolMode } : {}),
    env: { AGY_EMU_LOG: path.join(dir, 'runs.jsonl') },
    timeoutMs: 30_000,
    maxConcurrent: 4,
    ...extra,
  };
}
const runs = () => {
  const f = path.join(dir, 'runs.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

let cfg;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-router-'));
  upstream = http.createServer(google);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  // Claude-shaped stream-json: a thinking block, then an exit with no reply.
  const thinker = path.join(dir, 'thinker');
  fs.writeFileSync(
    thinker,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'thinking about it' }] } }) + '\\n');\nsetTimeout(() => process.exit(1), 300);\n`,
    { mode: 0o755 },
  );
  cfg = {
    auth: { enabled: true, keys: [KEY, { key: NO_GOOGLE, label: 'ada', deny: ['google'] }, { key: NO_AGY, label: 'nocli', deny: ['agy'] }] },
    limits: { streamHoldMs: 400, streamKeepaliveMs: 60 },
    adapters: {
      agy: agy('auto'),
      emu: agy('emulate'),
      bridged: agy('mcp'),
      plain: agy(null),
      thinker: { kind: 'cli', bin: thinker, args: ['{prompt}'], parser: 'claude-stream-json', toolMode: 'emulate', timeoutMs: 30_000 },
      google: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: false },
    },
    aliases: {
      argon: ['agy/gemini-4-argon-high', 'google/gemini-4-argon'],
      rev: ['google/quota', 'agy/gemini-4-argon-high'],
      mixed: ['google/quota', 'plain/m'],
      offonly: ['plain/m'],
      thinks: ['thinker/m', 'google/gemini-4-argon'],
    },
  };
  gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const A_TOOLS = [{ name: 'get_weather', description: 'Weather', input_schema: TOOLS[0].function.parameters }];

async function post(route, body, key = KEY) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const chat = (model, content, extra = {}, key = KEY) => post('/v1/chat/completions', { model, messages: [{ role: 'user', content }], tools: TOOLS, ...extra }, key);
const json = (r) => JSON.parse(r.text);
const lastRow = () => usageLog.tail(1)[0];
/** SSE text -> its data payloads (comments skipped), [DONE] as is. */
const frames = (text) =>
  text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter(Boolean)
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
/** Streamed tool calls, put together the way an OpenAI SDK does it: by index, arguments concatenated. */
const streamedCalls = (text) => {
  const out = [];
  for (const d of frames(text).filter((f) => f !== '[DONE]').flatMap((f) => f.choices?.[0]?.delta?.tool_calls || [])) {
    const c = (out[d.index] ??= { id: null, function: { name: '', arguments: '' } });
    if (d.id) c.id = d.id;
    c.function.name += d.function?.name || '';
    c.function.arguments += d.function?.arguments || '';
  }
  return out;
};

/* --------------------------------------------------- toolMode absent: as it always was */

test('a CLI without a toolMode never takes a tool request: the plain completion it always was, flattened, with no tool protocol', async () => {
  const before = runs().length;
  const history = [
    { role: 'user', content: 'Weather in Ankara? SCENARIO=plain' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ankara"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ];
  const r = await post('/v1/chat/completions', { model: 'mixed', messages: history, tools: TOOLS });
  assert.equal(r.status, 200, r.text);
  assert.equal(json(r).choices[0].message.content, 'plain answer');
  assert.equal(r.headers.get('x-keysmith-mode'), null, 'no tool engine answered');
  const [run] = runs().slice(before);
  assert.equal(run.agent, 'keysmith-text');
  assert.match(run.prompt, /^User: Weather in Ankara\? SCENARIO=plain\n\nTool output: sunny$/, 'the prompt protocols.js has always built');
  const row = lastRow();
  assert.deepEqual(['toolMode', 'toolCalls', 'fallback'].filter((k) => k in row), []);
  assert.ok(log.some((l) => /google\/quota refused \(429\) — the rest of "mixed" runs as a plain completion/.test(l)));
});

/* ----------------------------------------------------- declared order: agy, then Google */

test('argon: a tool request goes to agy first (EMULATE, no bridge yet), and Google is not asked', async () => {
  for (const stream of [false, true]) {
    const before = hits.length;
    const r = await chat('argon', `Weather in Ankara? SCENARIO=one-call`, { stream });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('x-keysmith-mode'), 'emulate');
    const calls = stream ? streamedCalls(r.text) : json(r).choices[0].message.tool_calls;
    assert.equal(calls[0].function.name, 'get_weather');
    assert.equal(hits.length, before, 'the Google leg was not asked');
    const row = lastRow();
    assert.deepEqual([row.toolMode, row.fallback, row.toolCalls], ['emulate', 'no_bridge', 1], JSON.stringify(row));
  }
});

test('argon: agy failing before anything went out hands the request to Google, verbatim, streamed or not', async () => {
  for (const stream of [false, true]) {
    const before = hits.length;
    const r = await chat('argon', 'SCENARIO=exit-1', { stream });
    assert.equal(r.status, 200, r.text);
    // Streamed, the headers are Google's when agy failed inside limits.streamHoldMs — or, on a
    // machine slow enough that the stream opened first, keysmith's, with Google's SSE spliced
    // in (the next test): the same answer either way.
    if (!stream) assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
    else assert.ok(['passthrough', 'emulate'].includes(r.headers.get('x-keysmith-mode')));
    assert.match(r.text, /google answer/);
    if (stream) assert.ok(frames(r.text).filter((d) => d !== '[DONE]').every((d) => d.id === 'g-1'), r.text);
    assert.equal(hits.length, before + 1);
    assert.deepEqual(hits.at(-1).tools, TOOLS, 'the body went up as the client sent it');
    assert.equal(hits.at(-1).model, 'gemini-4-argon');
    assert.deepEqual([lastRow().toolMode, lastRow().via], ['passthrough', 'passthrough']);
  }
  assert.ok(log.some((l) => /agy\/gemini-4-argon-high failed, trying the next leg that takes tools: agy exited 1/.test(l)), log.join('\n'));
  assert.ok(!log.some((l) => /crashed/.test(l)), 'the relay owned the response, and nothing else tried to write it');
});

test('a 429 on the way stays the answer: the plain completion after the tool walk failing too does not turn it into a 502', async () => {
  const r = await chat('mixed', 'SCENARIO=exit-1');
  assert.equal(r.status, 429, r.text);
  assert.equal(r.headers.get('retry-after'), '38');
  assert.match(json(r).error.message, /RESOURCE_EXHAUSTED/);
});

test('argon, streamed: agy gives up after the stream opened, and Google\'s SSE carries on in that stream', async () => {
  const before = hits.length;
  const r = await chat('argon', 'SCENARIO=slow-prose-always', { stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-keysmith-mode'), 'emulate', 'the engine running when the headers went out');
  assert.match(r.text, /^: stream open\n\n/);
  assert.equal(hits.length, before + 1, 'Google was asked once agy had given up');
  const data = frames(r.text);
  assert.deepEqual(data.at(-1), '[DONE]');
  assert.equal(data.filter((d) => d === '[DONE]').length, 1);
  assert.ok(
    data.filter((d) => d !== '[DONE]').every((d) => d.id === 'g-1'),
    'every frame is Google\'s own: no opening chunk, no error frame of keysmith\'s in front of it',
  );
  assert.ok(!r.text.includes('could not be used'), r.text);
  assert.deepEqual([lastRow().status, lastRow().toolMode], ['ok', 'passthrough']);
});

test('a route whose every leg refused the tools answers with the refusal, and the log claims no plain completion', async () => {
  const before = log.length;
  const r = await chat('google/quota', 'hi');
  assert.equal(r.status, 429, r.text);
  assert.ok(!log.slice(before).some((l) => /plain completion/.test(l)), log.slice(before).join('\n'));
});

test('/v1/messages: an HTTP leg is not handed the tools — no verbatim relay on that wire — and answers in text when agy fails', async () => {
  const before = hits.length;
  const r = await post('/v1/messages', { model: 'argon', max_tokens: 64, messages: [{ role: 'user', content: 'SCENARIO=exit-1' }], tools: A_TOOLS });
  assert.equal(r.status, 200, r.text);
  assert.equal(json(r).content[0].text, 'google answer');
  assert.equal(hits.length, before + 1);
  assert.equal(hits.at(-1).tools, undefined, 'a plain completion: the Anthropic tools never reach the OpenAI wire');
  assert.ok(log.some((l) => /tools requested but no leg of "argon" takes them|the rest of "argon" runs as a plain completion/.test(l)));
});

test('rev: Google refuses (429) and agy answers; the other way round, the first refusal is not asked again', async () => {
  const before = hits.length;
  const r = await chat('rev', 'SCENARIO=one-call');
  assert.equal(r.status, 200, r.text);
  assert.equal(json(r).choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.equal(hits.length, before + 1, 'Google once, with its tools');
  assert.equal(lastRow().toolMode, 'emulate');
});

test('the older `functions` shape: EMULATE answers it with one function_call, and an HTTP leg is handed it verbatim now', async () => {
  const functions = [TOOLS[0].function];
  let r = await post('/v1/chat/completions', { model: 'agy/m', messages: [{ role: 'user', content: 'SCENARIO=two-calls' }], functions });
  assert.equal(r.status, 502, 'two calls where the shape takes one: asked again, then refused — never merged');
  r = await post('/v1/chat/completions', { model: 'agy/m', messages: [{ role: 'user', content: 'SCENARIO=one-call' }], functions });
  assert.equal(r.status, 200, r.text);
  const msg = json(r).choices[0];
  assert.deepEqual([msg.finish_reason, msg.message.function_call?.name, msg.message.tool_calls], ['function_call', 'get_weather', undefined]);
  const before = hits.length;
  r = await post('/v1/chat/completions', { model: 'google/gemini-4-argon', messages: [{ role: 'user', content: 'hi' }], functions });
  assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
  assert.deepEqual(hits.at(-1).functions, functions);
  assert.equal(hits.length, before + 1);
});

/* --------------------------------------------------------------------------- scopes */

test('a leg outside the key\'s scope is skipped, a target outside it is a 403 — tools or not', async () => {
  let before = hits.length;
  let r = await chat('argon', 'SCENARIO=exit-1', {}, NO_GOOGLE);
  assert.equal(r.status, 502, 'agy failed and the Google leg is not this key\'s: nothing else to try');
  assert.equal(hits.length, before, 'Google was never asked');
  r = await chat('google/gemini-4-argon', 'hi', {}, NO_GOOGLE);
  assert.equal(r.status, 403, r.text);
  before = runs().length;
  r = await chat('argon', 'SCENARIO=one-call', {}, NO_AGY);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough', 'agy is not this key\'s: Google takes the tools');
  assert.equal(runs().length, before, 'agy never ran');
  assert.equal(r.headers.get('x-keysmith-route'), 'google/gemini-4-argon');
});

/* ------------------------------------------------- what no CLI can take, what must be a call */

test('a tool no CLI can honour goes to the next leg that relays it; with none left, a 400 that names it', async () => {
  const custom = [...TOOLS, { type: 'custom', custom: { name: 'apply_patch' } }];
  const before = { hits: hits.length, runs: runs().length };
  let r = await chat('argon', 'SCENARIO=one-call', { tools: custom });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
  assert.equal(hits.length, before.hits + 1);
  assert.equal(runs().length, before.runs, 'agy was passed by: dropping a tool would answer another request');
  r = await chat('agy/gemini-4-argon-high', 'SCENARIO=one-call', { tools: custom });
  assert.equal(r.status, 400, r.text);
  assert.match(json(r).error.message, /no leg that can take custom "apply_patch"/);
  const web = await post('/v1/messages', { model: 'agy/m', max_tokens: 64, messages: [{ role: 'user', content: 'search' }], tools: [...A_TOOLS, { type: 'web_search_20250305', name: 'web_search' }] });
  assert.equal(web.status, 400, web.text);
  assert.match(json(web).error.message, /web_search_20250305 "web_search"/);
  assert.equal(runs().length, before.runs);
});

test('tool_choice that asks for a call, on a route with no leg that takes tools: an error, never a text answer', async () => {
  const before = runs().length;
  for (const [route, body, why] of [
    ['/v1/chat/completions', { model: 'offonly', messages: [{ role: 'user', content: 'SCENARIO=plain' }], tools: TOOLS, tool_choice: 'required' }, /tool_choice is required/],
    ['/v1/chat/completions', { model: 'offonly', messages: [{ role: 'user', content: 'SCENARIO=plain' }], tools: TOOLS, tool_choice: { type: 'function', function: { name: 'get_weather' } }, stream: true }, /tool_choice names "get_weather"/],
    ['/v1/messages', { model: 'offonly', max_tokens: 64, messages: [{ role: 'user', content: 'SCENARIO=plain' }], tools: A_TOOLS, tool_choice: { type: 'any' } }, /tool_choice is required/],
  ]) {
    const r = await post(route, body);
    assert.equal(r.status, 400, `${route}: ${r.text}`);
    assert.match(json(r).error.message, why);
    assert.doesNotMatch(r.text, /plain answer/);
  }
  assert.equal(runs().length, before, 'the off leg was not asked for text instead');
  // tool_choice auto on the same route: the text answer it always got.
  const auto = await chat('offonly', 'SCENARIO=plain');
  assert.equal(json(auto).choices[0].message.content, 'plain answer');
});

test('auto: tool_choice none is a text answer with the history rendered as such; required and a named tool are EMULATE, bridge or not', async () => {
  let before = runs().length;
  const none = await post('/v1/chat/completions', {
    model: 'agy/m',
    tools: TOOLS,
    tool_choice: 'none',
    messages: [
      { role: 'user', content: 'Weather? SCENARIO=plain' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ankara"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ],
  });
  assert.equal(none.status, 200, none.text);
  assert.equal(json(none).choices[0].message.content, 'plain answer');
  const [run] = runs().slice(before);
  assert.equal(run.agent, 'keysmith-text', 'a text answer: the text agent');
  assert.match(run.prompt, /<assistant_tool_calls>\n\{"tool_calls":\[\{"id":"call_1","name":"get_weather","arguments":\{"city":"Ankara"\}\}\]\}\n<\/assistant_tool_calls>/);
  assert.match(run.prompt, /<<<TOOL_RESULT n=[0-9a-f]{8} id=call_1 name=get_weather error=false>>>\nsunny\n<<<END [0-9a-f]{8}>>>/);
  assert.doesNotMatch(run.prompt, /# Answer format/);

  gateway.toolEngines.mcp = stubBridge({ answer: true });
  try {
    before = runs().length;
    for (const tool_choice of ['required', { type: 'function', function: { name: 'get_weather' } }]) {
      const r = await chat('agy/m', 'SCENARIO=one-call', { tool_choice });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.headers.get('x-keysmith-mode'), 'emulate', 'MCP cannot make a model call a tool');
      assert.equal(lastRow().fallback, undefined, 'EMULATE is auto\'s first pick here, not a fallback');
    }
    assert.equal(runs().length, before + 2);
  } finally {
    gateway.toolEngines.mcp = null;
  }
});

/* ---------------------------------------------------------------- auto and the bridge */

/**
 * A stand-in for the MCP bridge (design U6/U7): `check` says whether it takes the request,
 * `run` answers with a call, or fails the way it is told to.
 */
function stubBridge({ answer = false, refuse = null, fail = null, noFallback = false, usage = null, errorEvent = null } = {}) {
  const seen = { checks: 0, runs: 0 };
  return {
    seen,
    check(adapter, spec) {
      seen.checks++;
      if (refuse === 'name_too_long') return namesFit(spec, 'mcp_ks000000_'.length) ? { ok: true } : { ok: false, reason: 'name_too_long' };
      return refuse ? { ok: false, reason: refuse, status: 503, retryAfter: 5 } : { ok: true };
    },
    async *run() {
      seen.runs++;
      if (usage) yield { type: 'usage', usage };
      if (fail) throw Object.assign(new Error(`bridge: ${fail}`), { fallbackReason: fail, noFallback });
      if (errorEvent) yield { type: 'error', message: `bridge said: ${errorEvent}`, code: errorEvent };
      if (answer) {
        yield { type: 'tool_call', name: 'get_weather', arguments: '{"city":"Bridge"}', args: { city: 'Bridge' } };
        yield { type: 'done', finishReason: 'tool_calls' };
      }
    },
  };
}

test('auto with a bridge: it answers when it can; one that cannot take the request, or fails before any call, is EMULATE in the same request', async () => {
  try {
    gateway.toolEngines.mcp = stubBridge({ answer: true });
    let r = await chat('agy/m', 'SCENARIO=one-call');
    assert.equal(r.headers.get('x-keysmith-mode'), 'mcp');
    assert.equal(json(r).choices[0].message.tool_calls[0].function.arguments, '{"city":"Bridge"}');
    assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['mcp', undefined]);

    const long = 'x'.repeat(55);
    gateway.toolEngines.mcp = stubBridge({ answer: true, refuse: 'name_too_long' });
    r = await chat('agy/m', 'SCENARIO=one-call', { tools: [...TOOLS, { type: 'function', function: { name: long, parameters: { type: 'object' } } }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.headers.get('x-keysmith-mode'), lastRow().fallback], ['emulate', 'name_too_long'], 'mcp_ks<rid6>_ + 55 characters is past Gemini\'s 64');

    gateway.toolEngines.mcp = stubBridge({ answer: true, refuse: 'bridge_full' });
    r = await chat('agy/m', 'SCENARIO=one-call');
    assert.deepEqual([r.headers.get('x-keysmith-mode'), lastRow().fallback], ['emulate', 'bridge_full']);

    const before = runs().length;
    const bridge = stubBridge({ fail: 'ready_timeout', usage: { input: 7, output: 0 } });
    gateway.toolEngines.mcp = bridge;
    for (const stream of [false, true]) {
      r = await chat('agy/m', 'SCENARIO=one-call', { stream });
      assert.equal(r.status, 200, r.text);
      const calls = stream ? streamedCalls(r.text) : json(r).choices[0].message.tool_calls;
      assert.equal(calls[0].function.arguments, '{"city":"Ankara"}', 'EMULATE answered');
      const row = lastRow();
      assert.deepEqual([row.toolMode, row.fallback, row.usage.input], ['emulate', 'ready_timeout', 1007], 'what the bridge spent is counted');
    }
    assert.equal(bridge.seen.runs, 2);
    assert.equal(runs().length, before + 2);
    assert.ok(log.some((l) => /the MCP bridge failed before any call \(ready_timeout: bridge: ready_timeout\); this request runs as EMULATE/.test(l)));
    // A bridge that says it failed (an error event) before any call is failing as much as one that throws.
    gateway.toolEngines.mcp = stubBridge({ errorEvent: 'unknown_agent' });
    r = await chat('agy/m', 'SCENARIO=one-call');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'unknown_agent']);
  } finally {
    gateway.toolEngines.mcp = null;
  }
});

test('a bridge failure that must not be retried another way (the foreign-tool tripwire) is the answer: no EMULATE run', async () => {
  try {
    gateway.toolEngines.mcp = stubBridge({ fail: 'foreign_tool', noFallback: true });
    const before = runs().length;
    const r = await chat('agy/m', 'SCENARIO=one-call');
    assert.equal(r.status, 502, r.text);
    assert.match(json(r).error.message, /bridge: foreign_tool/);
    assert.equal(runs().length, before);
  } finally {
    gateway.toolEngines.mcp = null;
  }
});

test('toolMode mcp: a 503 without a bridge or with a full one, a 400 for a call it cannot force; never EMULATE', async () => {
  const before = runs().length;
  let r = await chat('bridged/m', 'SCENARIO=one-call');
  assert.equal(r.status, 503, r.text);
  assert.match(json(r).error.message, /toolMode mcp, and this keysmith has no MCP bridge/);
  try {
    gateway.toolEngines.mcp = stubBridge({ answer: true, refuse: 'bridge_full' });
    r = await chat('bridged/m', 'SCENARIO=one-call');
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
    gateway.toolEngines.mcp = stubBridge({ answer: true });
    r = await chat('bridged/m', 'SCENARIO=one-call', { tool_choice: 'required' });
    assert.equal(r.status, 400);
    assert.match(json(r).error.message, /cannot make a model call a tool/);
    r = await chat('bridged/m', 'SCENARIO=one-call');
    assert.equal(r.headers.get('x-keysmith-mode'), 'mcp');
    gateway.toolEngines.mcp = stubBridge({ fail: 'ready_timeout' });
    r = await chat('bridged/m', 'SCENARIO=one-call');
    assert.equal(r.status, 502, 'mcp is mcp: no fallback');
  } finally {
    gateway.toolEngines.mcp = null;
  }
  assert.equal(runs().length, before);
});

test('a stream whose face already wrote a frame cannot be handed to an HTTP leg: the route ends in the error frame', async () => {
  // A CLI that thinks out loud (its reasoning goes out as it comes, the client asked for it),
  // then fails without a reply.
  const before = hits.length;
  const r = await chat('thinks', 'SCENARIO=one-call', { stream: true, include_reasoning: true });
  assert.equal(r.status, 200);
  assert.equal(hits.length, before + 1, 'Google was asked…');
  const data = frames(r.text);
  assert.equal(data.find((d) => d !== '[DONE]').choices[0].delta.role, 'assistant');
  assert.ok(data.some((d) => d?.choices?.[0]?.delta?.reasoning_content === 'thinking about it'), r.text);
  assert.match(r.text, /"error":\{"message":"keysmith: google: the stream was already open with another leg's frames in it/);
  assert.ok(!r.text.includes('google answer'), '…and its answer was not spliced after keysmith\'s frames');
});

test('pickEngine and namesFit, the rules on their own', () => {
  const spec = (choice = 'auto', names = ['get_weather']) => ({ tools: names.map((name) => ({ name })), choice: { mode: choice, name: names[0] }, parallel: true, unsupported: [] });
  const a = (toolMode) => ({ id: 'x', toolMode });
  const bridge = { check: () => ({ ok: true }) };
  assert.deepEqual(pickEngine(a('auto'), spec('none'), bridge), { engine: 'plain' });
  assert.deepEqual(pickEngine(a('emulate'), spec(), bridge), { engine: 'emulate' });
  assert.deepEqual(pickEngine(a('auto'), spec('required'), bridge), { engine: 'emulate' });
  assert.deepEqual(pickEngine(a('auto'), spec('named'), bridge), { engine: 'emulate' });
  assert.deepEqual(pickEngine(a('auto'), spec(), null), { engine: 'emulate', fallback: 'no_bridge' });
  assert.deepEqual(pickEngine(a('auto'), spec(), { check: () => ({ ok: false, reason: 'bridge_full' }) }), { engine: 'emulate', fallback: 'bridge_full' });
  assert.deepEqual(pickEngine(a('auto'), spec(), bridge), { engine: 'mcp' });
  assert.deepEqual(pickEngine(a('mcp'), spec(), bridge), { engine: 'mcp' });
  assert.throws(() => pickEngine(a('mcp'), spec('named'), bridge), /cannot make a model call a tool/);
  // agy shows a bridge tool as mcp_ks<rid6>_<tool>: 13 characters before the name, 64 in all.
  assert.ok(namesFit(spec('auto', ['a'.repeat(51)]), 'mcp_ks000000_'.length));
  assert.ok(!namesFit(spec('auto', ['a'.repeat(52)]), 'mcp_ks000000_'.length));
});

/* ------------------------------------------------------------------- /v1/messages */

test('/v1/messages: tools reach a CLI with a toolMode, as tool_use blocks, streamed or not; more than 128 is a 400', async () => {
  const body = { model: 'emu/m', max_tokens: 256, messages: [{ role: 'user', content: 'SCENARIO=two-calls' }], tools: A_TOOLS };
  const r = await post('/v1/messages', body);
  assert.equal(r.status, 200, r.text);
  const msg = json(r);
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.content.map((b) => [b.type, b.name, b.input.city]), [['tool_use', 'get_weather', 'Ankara'], ['tool_use', 'get_weather', 'Izmir']]);
  assert.match(msg.content[0].id, /^toolu_[0-9a-f]{24}$/);
  assert.equal(r.headers.get('x-keysmith-mode'), 'emulate');
  const s = await post('/v1/messages', { ...body, stream: true });
  assert.match(s.text, /"type":"content_block_start","index":0,"content_block":\{"type":"tool_use","id":"toolu_[0-9a-f]{24}","name":"get_weather"/);
  assert.match(s.text, /"stop_reason":"tool_use"/);
  const many = await post('/v1/messages', { ...body, tools: Array.from({ length: 129 }, (_, i) => ({ name: `t${i}`, input_schema: { type: 'object' } })) });
  assert.equal(many.status, 400);
  assert.match(json(many).error.message, /129 tools; at most 128/);
});

/* -------------------------------------------------------------- routes and status page */

test('the routes endpoint and the status page say how each adapter takes tools', async () => {
  const res = await fetch(`${base}/v1/keysmith/routes`, { headers: { authorization: `Bearer ${KEY}` } });
  const routes = await res.json();
  const mode = Object.fromEntries(routes.adapters.map((a) => [a.id, a.tool_mode]));
  assert.deepEqual(mode, { agy: 'auto', emu: 'emulate', bridged: 'mcp', plain: 'off', thinker: 'emulate', google: 'passthrough' });
  const page = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${KEY}` } })).text();
  assert.match(page, /<b>agy<\/b>.*?<span class="pill">tools: auto<\/span>/s);
  assert.doesNotMatch(page, /<b>plain<\/b><small>[^<]*<br><span class="pill">\d+<\/span> <span class="pill">tools/);
});

/* ------------------------------------------------------------------ the config gates */

test('toolMode is checked at load: a mode that is not one, on an HTTP upstream, next to unsafeTools; the templates are argv lists', () => {
  const base = { kind: 'cli', bin: 'sh', args: ['{prompt}'] };
  assert.equal(checkAdapter('a', base).toolMode, 'off', 'absent is off');
  assert.throws(() => checkAdapter('a', { ...base, toolMode: 'yes' }), /toolMode must be one of off, emulate, mcp, auto/);
  assert.throws(() => checkAdapter('a', { ...base, toolMode: 'auto', unsafeTools: true }), /toolMode auto on an adapter marked unsafeTools/);
  assert.equal(checkAdapter('a', { ...base, toolMode: 'off', unsafeTools: true }).toolMode, 'off');
  assert.throws(() => checkAdapter('g', { kind: 'http', baseUrl: 'http://x/v1', toolMode: 'emulate' }), /toolMode is a CLI adapter's field/);
  assert.throws(() => checkAdapter('a', { ...base, emulateArgs: '-p {prompt}' }), /emulateArgs must be an argv template/);
  assert.throws(() => checkAdapter('a', { ...base, bridge: ['--agent'] }), /bridge must be an object/);
  assert.throws(() => checkAdapter('a', { ...base, bridge: { args: [1] } }), /bridge\.args must be an argv template/);
});

test('the auto-approve scan reads every argv template: agy\'s --mode auto, --yolo in emulateArgs, --mode accept-edits in the bridge\'s', () => {
  assert.equal(autoApproveFlag({ args: ['--mode', 'auto', '-p', '{prompt}'] }), '--mode auto');
  assert.equal(autoApproveFlag({ args: ['--mode=accept-edits', '{prompt}'] }), '--mode=accept-edits');
  assert.equal(autoApproveFlag({ args: ['{prompt}'], emulateArgs: ['--yolo', '{prompt}'] }), '--yolo');
  assert.equal(autoApproveFlag({ args: ['{prompt}'], bridge: { args: ['--mode', 'accept-edits'] } }), '--mode accept-edits');
  assert.equal(autoApproveFlag({ args: ['--mode', 'plan'] }), null, 'only the approving values');
  for (const tpl of ['emulateArgs', 'args']) {
    assert.throws(() => checkAdapter('agy', { kind: 'cli', bin: 'agy', args: ['{prompt}'], [tpl]: ['--mode', 'auto', '{prompt}'] }), /its argv passes --mode auto, which auto-approves/, tpl);
  }
  assert.throws(() => checkAdapter('agy', { kind: 'cli', bin: 'agy', args: ['{prompt}'], bridge: { args: ['--yolo'] } }), /passes --yolo/);
  for (const [name, p] of Object.entries(CLI_PROFILES)) {
    if (!p.unsafeTools) assert.equal(autoApproveFlag(p), null, `${name}: no template of a shipped profile approves its own tools`);
  }
});

/* --------------------------------------------------------------- keysmith set toolMode */

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-toolmode-'));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const write = (c) => fs.writeFileSync(config, JSON.stringify(c, null, 2), { mode: 0o600 });
  return { run, read, write, home };
}

test('keysmith set <id> toolMode: an entry attached before the tool engine gets the templates it lacks from its profile, and keeps what it has', () => {
  const { run, read, write, home } = sandbox();
  try {
    assert.equal(run('add', 'agy', '--bin', '/opt/homebrew/bin/agy').status, 0);
    // What an older keysmith wrote: no templates, only the text agent — and an argv of its own.
    const old = read();
    for (const k of ['toolMode', 'emulateArgs', 'bridge']) delete old.adapters.agy[k];
    old.adapters.agy.workspaceFiles = { '.agents/agents/keysmith-text.md': 'MY OWN TEXT AGENT\n' };
    old.adapters.agy.args = ['--agent', 'keysmith-text', '-p', '{prompt}'];
    write(old);
    let r = run('set', 'agy', 'toolMode', 'auto');
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /filled from the built-in "agy" profile: emulateArgs, workspaceFiles\[\.agents\/agents\/keysmith-tools\.md\]/);
    const now = read().adapters.agy;
    assert.equal(now.toolMode, 'auto');
    assert.deepEqual(now.emulateArgs, CLI_PROFILES.agy.emulateArgs);
    assert.equal(now.workspaceFiles['.agents/agents/keysmith-tools.md'], CLI_PROFILES.agy.workspaceFiles['.agents/agents/keysmith-tools.md']);
    assert.equal(now.workspaceFiles['.agents/agents/keysmith-text.md'], 'MY OWN TEXT AGENT\n', 'a file the entry has is never replaced');
    assert.deepEqual(now.args, ['--agent', 'keysmith-text', '-p', '{prompt}'], 'nor is its argv');
    r = run('set', 'agy', 'toolMode', 'emulate');
    assert.match(r.all, /already has the "agy" profile's tool templates/);

    // No cwd: the agent file has nowhere keysmith owns to go, so the change is not made.
    const nocwd = read();
    delete nocwd.adapters.agy.cwd;
    delete nocwd.adapters.agy.workspaceFiles;
    delete nocwd.adapters.agy.emulateArgs;
    nocwd.adapters.agy.toolMode = 'off';
    write(nocwd);
    r = run('set', 'agy', 'toolMode', 'auto');
    assert.notEqual(r.status, 0);
    assert.match(r.all, /has no cwd/);
    assert.equal(read().adapters.agy.toolMode, 'off', 'refused means unchanged');

    // A CLI no profile runs: nothing to fill, and said so.
    assert.equal(run('add', 'custom', '--as', 'mine', '--bin', 'mycli').status, 0);
    r = run('set', 'mine', 'toolMode', 'emulate');
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /no built-in profile runs "mycli" with parser raw: EMULATE runs this adapter's own args/);

    // Never on a CLI that kept its tools; never on an HTTP upstream.
    run('add', 'warp');
    r = run('set', 'warp', 'toolMode', 'auto', '--allow-unsafe-tools');
    assert.notEqual(r.status, 0);
    assert.match(r.all, /toolMode auto on an adapter marked unsafeTools/);
    assert.equal(read().adapters.warp.toolMode, undefined);
    run('add', 'ollama');
    r = run('set', 'ollama', 'toolMode', 'emulate');
    assert.notEqual(r.status, 0);
    assert.match(r.all, /toolMode is a CLI adapter's field/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
