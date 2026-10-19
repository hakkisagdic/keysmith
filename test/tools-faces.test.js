/**
 * Face writers (src/tools/faces.js): `tool_call` events out to an OpenAI or an Anthropic client,
 * streamed and not, in the shapes their SDKs read — checked against reference answers
 * (test/fixtures/faces/*), by shape and by what an SDK's accumulator makes of them. A fake
 * adapter yields the events an engine will; nothing here runs a CLI or reaches a provider.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { LlmError } from '../src/util.js';
import { toolCallEvent } from '../src/tools/model.js';
import { AnthropicStream, OpenaiChatStream, keepalive } from '../src/tools/faces.js';

const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const ARG_SENTINEL = 'ARG-SENTINEL-' + crypto.randomBytes(6).toString('hex');
const RESULT_SENTINEL = 'RESULT-SENTINEL-' + crypto.randomBytes(6).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- the fake engine */

/** A call the way an engine yields one, without an id: the face makes keysmith's own for its wire. */
const call = (name, args) => ({ type: 'tool_call', name, arguments: JSON.stringify(args), args });
const delta = (text) => ({ type: 'delta', text });
const usage = { type: 'usage', usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 } };
const done = (finishReason) => ({ type: 'done', finishReason });

const SCRIPTS = {
  'one-call': async function* () {
    yield call('get_weather', { city: 'Ankara' });
    yield usage;
    yield done('tool_calls');
  },
  preamble: async function* () {
    yield delta('Let me check.');
    yield call('get_weather', { city: 'Ankara' });
    yield usage;
    yield done('tool_calls');
  },
  'two-calls': async function* () {
    yield call('get_weather', { city: 'Ankara' });
    yield call('get_weather', { city: 'Izmir' });
    yield done('tool_calls');
  },
  'given-id': async function* () {
    yield toolCallEvent({ id: 'call_0123456789abcdef01234567', name: 'now', args: {} });
    yield done('tool_calls');
  },
  text: async function* () {
    yield delta('just text');
    yield usage;
    yield done('stop');
  },
  mode: async function* () {
    yield { type: 'tool_mode', mode: 'emulate', fallback: 'readyTimeout' };
    yield { type: 'retry', reason: 'invalid_reply', message: 'prose instead of JSON' };
    yield call('lookup', { secret: ARG_SENTINEL });
    yield usage;
    yield done('tool_calls');
  },
  'throw-after-call': async function* () {
    yield call('get_weather', { city: 'Ankara' });
    throw new LlmError('the engine broke after the call', { status: 502 });
  },
  'throw-after-text': async function* () {
    yield delta('partial answer ');
    throw new Error('the stream broke');
  },
  'throw-before': async function* () {
    throw new LlmError('refused before anything', { status: 503 });
  },
  'error-after-call': async function* () {
    yield call('get_weather', { city: 'Ankara' });
    yield { type: 'error', message: 'late failure' };
  },
  'slow-call': async function* () {
    await sleep(400);
    yield call('get_weather', { city: 'Ankara' });
    yield done('tool_calls');
  },
  'slow-throw': async function* () {
    await sleep(150);
    throw new LlmError('the model answered twice with something that is not a tool call', { status: 502, type: 'tool_emulation_error' });
  },
  'bad-call': async function* () {
    yield { type: 'tool_call', name: 'f', arguments: '[1,2]' };
    yield done('tool_calls');
  },
};

const calls = []; // [adapter id, model] per run, to see which legs were asked
function fakeAdapter(id) {
  return {
    id,
    kind: 'cli',
    priority: 100,
    resumeArgs: null,
    resumable: false,
    disabled: false,
    explicitOnly: false,
    unsafeTools: false,
    timeoutMs: 10_000,
    _modelCache: null,
    async models() {
      return Object.keys(SCRIPTS).map((m) => ({ id: m }));
    },
    async *complete({ model }) {
      calls.push([id, model]);
      if (!SCRIPTS[model]) throw new Error(`no script for ${model}`);
      yield* SCRIPTS[model]();
    },
  };
}

/* ---------------------------------------------------------------------- the server */

let dir, server, base, gateway, usageLog;
const log = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-faces-'));
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 30, streamKeepaliveMs: 60 },
    adapters: {},
    aliases: {
      'fo-call': ['fake/throw-after-call', 'fake2/text'],
      'fo-text': ['fake/throw-after-text', 'fake2/text'],
      'fo-before': ['fake/throw-before', 'fake2/text'],
    },
  };
  gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  gateway.adapters.set('fake', fakeAdapter('fake'));
  gateway.adapters.set('fake2', fakeAdapter('fake2'));
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const A_TOOLS = [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const ASK = [{ role: 'user', content: 'Weather in Ankara?' }];

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const chat = (model, extra = {}) => post('/v1/chat/completions', { model, messages: ASK, tools: TOOLS, ...extra });
const messages = (model, extra = {}) => post('/v1/messages', { model, max_tokens: 256, messages: ASK, tools: A_TOOLS, ...extra });

/* ------------------------------------------------------------------- reading SSE */

/** SSE text -> [{ event, data }]: comment lines (`: keepalive`) skipped, data parsed as JSON unless it is [DONE]. */
function sse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
    if (!lines.length) continue;
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? null;
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    out.push({ event, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) });
  }
  return out;
}

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/faces/${name}`, import.meta.url), 'utf8');
const REF = {
  openai: JSON.parse(fixture('openai-chat-tool-calls.json')).body,
  openaiStream: sse(fixture('openai-chat-tool-calls.sse')),
  anthropic: JSON.parse(fixture('anthropic-messages-tool-use.json')).body,
  anthropicStream: sse(fixture('anthropic-messages-tool-use.sse')),
};

/** What an OpenAI SDK's stream accumulator does with chunks: concatenate strings, keep index and type, merge tool calls by index. */
function openaiAccumulate(frames) {
  const message = { role: null, content: null, tool_calls: [] };
  let finish = null;
  let usageSeen = null;
  for (const { data } of frames) {
    if (data === '[DONE]') break;
    if (data.error) throw new Error(`stream error: ${data.error.message}`);
    if (data.usage) usageSeen = data.usage;
    const c = data.choices?.[0];
    if (!c) continue;
    const d = c.delta || {};
    if (d.role) message.role = d.role;
    if (typeof d.content === 'string') message.content = (message.content ?? '') + d.content;
    for (const tc of d.tool_calls || []) {
      const slot = (message.tool_calls[tc.index] ??= { id: '', type: '', function: { name: '', arguments: '' } });
      if (tc.id) slot.id += tc.id;
      if (tc.type) slot.type = tc.type;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (c.finish_reason) finish = c.finish_reason;
  }
  return { message, finish, usage: usageSeen };
}

/** What an Anthropic SDK's stream accumulator does with events: blocks by index, text and partial JSON appended. */
function anthropicAccumulate(events) {
  let message = null;
  const json = new Map();
  for (const { event, data } of events) {
    if (event === 'error') throw new Error(`stream error: ${data.error.message}`);
    if (event === 'message_start') message = structuredClone(data.message);
    else if (event === 'content_block_start') message.content[data.index] = structuredClone(data.content_block);
    else if (event === 'content_block_delta') {
      const block = message.content[data.index];
      if (data.delta.type === 'text_delta') block.text += data.delta.text;
      else if (data.delta.type === 'input_json_delta') json.set(data.index, (json.get(data.index) || '') + data.delta.partial_json);
    } else if (event === 'content_block_stop') {
      const block = message.content[data.index];
      if (block.type === 'tool_use') block.input = JSON.parse(json.get(data.index) || '{}');
    } else if (event === 'message_delta') {
      message.stop_reason = data.delta.stop_reason;
      message.usage.output_tokens = data.usage.output_tokens;
    }
  }
  return message;
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Where `got` differs in shape from `ref`: a key the reference has and `got` lacks (unless
 * `optional`), a key `got` adds (unless `extra`), a different JSON type. Arrays compare their
 * first elements. Paths read `choices[].message.tool_calls[].id`.
 */
function shapeDiff(ref, got, { optional = [], extra = [] } = {}, at = '') {
  if (kind(ref) !== kind(got)) return [`${at || '(root)'}: ${kind(ref)} in the reference, ${kind(got)} here`];
  if (kind(ref) === 'array') return ref.length && got.length ? shapeDiff(ref[0], got[0], { optional, extra }, `${at}[]`) : [];
  if (kind(ref) !== 'object') return [];
  const out = [];
  for (const k of Object.keys(ref)) {
    const p = at ? `${at}.${k}` : k;
    if (!Object.hasOwn(got, k)) {
      if (!optional.includes(p)) out.push(`${p}: missing`);
    } else out.push(...shapeDiff(ref[k], got[k], { optional, extra }, p));
  }
  for (const k of Object.keys(got)) {
    const p = at ? `${at}.${k}` : k;
    if (!Object.hasOwn(ref, k) && !extra.includes(p)) out.push(`${p}: not in the reference`);
  }
  return out;
}

/** Fields the providers send that no SDK needs and keysmith has no value for. */
const OPENAI_OPTIONAL = [
  'service_tier',
  'system_fingerprint',
  'usage',
  'choices[].logprobs',
  'choices[].delta.refusal',
  'usage.prompt_tokens_details.audio_tokens',
  'usage.completion_tokens_details.audio_tokens',
  'usage.completion_tokens_details.accepted_prediction_tokens',
  'usage.completion_tokens_details.rejected_prediction_tokens',
];
const ANTHROPIC_OPTIONAL = ['usage.cache_creation_input_tokens', 'usage.cache_read_input_tokens', 'usage.service_tier', 'message.usage.cache_creation_input_tokens', 'message.usage.cache_read_input_tokens'];

function openaiKind({ data }) {
  if (data === '[DONE]') return 'done';
  if (data.error) return 'error';
  if (!data.choices.length && data.usage) return 'usage';
  const c = data.choices[0];
  if (c.finish_reason) return 'finish';
  if (c.delta.role) return 'role';
  if (c.delta.tool_calls?.[0]?.id) return 'tool-head';
  if (c.delta.tool_calls) return 'tool-args';
  if (c.delta.reasoning_content) return 'reasoning';
  return 'content';
}
function anthropicKind({ event, data }) {
  if (event === 'content_block_start') return `${event}:${data.content_block.type}`;
  if (event === 'content_block_delta') return `${event}:${data.delta.type}`;
  return event;
}
/** The kinds in order, a run of the same kind written once: a provider splits arguments across chunks, keysmith sends them in one. */
const runs = (list, kindOf) => list.map(kindOf).filter((k, i, all) => i === 0 || k !== all[i - 1]);

/** Each frame against the reference frame of its kind. */
function framesMatch(ref, got, kindOf, opts) {
  const byKind = new Map();
  for (const f of ref) if (!byKind.has(kindOf(f))) byKind.set(kindOf(f), f);
  const problems = [];
  for (const f of got) {
    const r = byKind.get(kindOf(f));
    if (!r) problems.push(`${kindOf(f)}: no frame of this kind in the reference`);
    else if (r.data !== '[DONE]') problems.push(...shapeDiff(r.data, f.data, opts).map((p) => `${kindOf(f)} ${p}`));
  }
  return problems;
}

/* ------------------------------------------------------------- the reference answers */

test('the reference answers read as their SDKs read them (the accumulators here are the ones the faces are held to)', () => {
  const o = openaiAccumulate(REF.openaiStream);
  assert.equal(o.message.content, 'Let me check.');
  assert.deepEqual(o.message.tool_calls, [{ id: 'call_q8Vb3nT1sLx0Ka7dWm2Yp5Rz', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ankara"}' } }]);
  assert.equal(o.finish, 'tool_calls');
  const a = anthropicAccumulate(REF.anthropicStream);
  assert.deepEqual(a.content, REF.anthropic.content.map((b) => (b.type === 'tool_use' ? { ...b, id: 'toolu_01Ab2Cd3Ef4Gh5Ij6Kl7Mn8P' } : b)));
  assert.equal(a.stop_reason, 'tool_use');
});

/* ---------------------------------------------------------------- OpenAI chat face */

test('OpenAI, not streamed: message.tool_calls with keysmith\'s id, content null, finish_reason tool_calls — the reference shape', async () => {
  const r = await chat('fake/one-call');
  assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.deepEqual(shapeDiff(REF.openai, body, { optional: OPENAI_OPTIONAL }), []);
  const m = body.choices[0].message;
  assert.equal(m.content, null);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(m.tool_calls.length, 1);
  assert.match(m.tool_calls[0].id, /^call_[0-9a-f]{24}$/);
  assert.equal(m.tool_calls[0].type, 'function');
  assert.equal(m.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { city: 'Ankara' });
  assert.equal(body.usage.prompt_tokens, 120);
});

test('OpenAI, not streamed: a preamble stays in content next to the call; two calls are two tool_calls', async () => {
  const pre = JSON.parse((await chat('fake/preamble')).text).choices[0];
  assert.equal(pre.message.content, 'Let me check.');
  assert.equal(pre.message.tool_calls.length, 1);
  assert.equal(pre.finish_reason, 'tool_calls');
  const two = JSON.parse((await chat('fake/two-calls')).text).choices[0].message.tool_calls;
  assert.deepEqual(two.map((c) => JSON.parse(c.function.arguments).city), ['Ankara', 'Izmir']);
  assert.notEqual(two[0].id, two[1].id);
  const plain = JSON.parse((await chat('fake/text')).text).choices[0];
  assert.equal(plain.message.content, 'just text');
  assert.equal(plain.message.tool_calls, undefined, 'an answer without calls has no tool_calls field, as before');
  assert.equal(plain.finish_reason, 'stop');
});

test('OpenAI, streamed: two chunks per call (index, id, name; then the arguments), finish_reason tool_calls, the usage chunk — the reference sequence', async () => {
  const r = await chat('fake/preamble', { stream: true, stream_options: { include_usage: true } });
  assert.equal(r.status, 200, r.text);
  const frames = sse(r.text);
  assert.deepEqual(runs(frames, openaiKind), runs(REF.openaiStream, openaiKind));
  assert.deepEqual(framesMatch(REF.openaiStream, frames, openaiKind, { optional: OPENAI_OPTIONAL }), []);
  const heads = frames.filter((f) => openaiKind(f) === 'tool-head');
  assert.deepEqual(heads[0].data.choices[0].delta.tool_calls[0].function, { name: 'get_weather', arguments: '' });
  const acc = openaiAccumulate(frames);
  assert.equal(acc.message.content, 'Let me check.');
  assert.equal(acc.message.tool_calls.length, 1);
  assert.match(acc.message.tool_calls[0].id, /^call_[0-9a-f]{24}$/);
  assert.deepEqual(JSON.parse(acc.message.tool_calls[0].function.arguments), { city: 'Ankara' });
  assert.equal(acc.finish, 'tool_calls');
  assert.equal(acc.usage.prompt_tokens, 120);
  assert.equal(frames.at(-1).data, '[DONE]');
});

test('OpenAI, streamed: parallel calls get index 0 and 1; a text answer still ends with stop', async () => {
  const acc = openaiAccumulate(sse((await chat('fake/two-calls', { stream: true })).text));
  assert.deepEqual(acc.message.tool_calls.map((c) => JSON.parse(c.function.arguments).city), ['Ankara', 'Izmir']);
  assert.equal(acc.message.content, '', 'the opening chunk carries an empty content, as it always did');
  const text = sse((await chat('fake/text', { stream: true })).text);
  assert.deepEqual(runs(text, openaiKind), ['role', 'content', 'finish', 'done']);
  assert.equal(openaiAccumulate(text).finish, 'stop');
});

/* ------------------------------------------------------------------ Anthropic face */

test('Anthropic, not streamed: the preamble as a text block, a tool_use block, stop_reason tool_use — the reference shape', async () => {
  const r = await messages('fake/preamble');
  assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.deepEqual(shapeDiff(REF.anthropic, body, { optional: ANTHROPIC_OPTIONAL }), []);
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.content[0].text, 'Let me check.');
  assert.match(body.content[1].id, /^toolu_[0-9a-f]{24}$/);
  assert.deepEqual(body.content[1], { type: 'tool_use', id: body.content[1].id, name: 'get_weather', input: { city: 'Ankara' } });
  const only = JSON.parse((await messages('fake/one-call')).text);
  assert.deepEqual(only.content.map((b) => b.type), ['tool_use'], 'no empty text block in front of a call');
  const plain = JSON.parse((await messages('fake/text')).text);
  assert.deepEqual(plain.content, [{ type: 'text', text: 'just text' }]);
  assert.equal(plain.stop_reason, 'end_turn');
});

test('Anthropic, streamed: blocks open when they have content, input_json_delta carries the arguments — the reference sequence', async () => {
  const r = await messages('fake/preamble', { stream: true });
  assert.equal(r.status, 200, r.text);
  const events = sse(r.text);
  assert.deepEqual(runs(events, anthropicKind), runs(REF.anthropicStream, anthropicKind));
  assert.deepEqual(framesMatch(REF.anthropicStream, events, anthropicKind, { optional: ANTHROPIC_OPTIONAL }), []);
  const m = anthropicAccumulate(events);
  assert.equal(m.content[0].text, 'Let me check.');
  assert.match(m.content[1].id, /^toolu_[0-9a-f]{24}$/);
  assert.deepEqual(m.content[1].input, { city: 'Ankara' });
  assert.equal(m.stop_reason, 'tool_use');

  // A call with no text before it is block 0: no empty text block is opened for it.
  const only = sse((await messages('fake/two-calls', { stream: true })).text);
  assert.deepEqual(runs(only, anthropicKind), ['message_start', 'content_block_start:tool_use', 'ping', 'content_block_delta:input_json_delta', 'content_block_stop', 'content_block_start:tool_use', 'content_block_delta:input_json_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(anthropicAccumulate(only).content.map((b) => [b.type, b.input.city]), [['tool_use', 'Ankara'], ['tool_use', 'Izmir']]);
});

test('Anthropic, streamed: a text answer keeps the event sequence it always had', async () => {
  const events = sse((await messages('fake/text', { stream: true })).text);
  assert.deepEqual(events.map((e) => e.event), ['message_start', 'content_block_start', 'ping', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(anthropicAccumulate(events).stop_reason, 'end_turn');
});

test('an engine\'s own id is the id the client gets, on both faces', async () => {
  const o = JSON.parse((await chat('fake/given-id')).text).choices[0].message.tool_calls[0];
  assert.equal(o.id, 'call_0123456789abcdef01234567');
  const a = JSON.parse((await messages('fake/given-id')).text).content[0];
  assert.equal(a.id, 'call_0123456789abcdef01234567');
  assert.deepEqual(a.input, {});
});

/* --------------------------------------------------------------------- error frames */

test('a stream that breaks after a call ends in its face\'s own error frame: OpenAI an error chunk and [DONE], Anthropic an error event', async () => {
  const o = sse((await chat('fake/throw-after-call', { stream: true })).text);
  assert.deepEqual(runs(o, openaiKind), ['role', 'tool-head', 'tool-args', 'error', 'done']);
  assert.match(o.at(-2).data.error.message, /^keysmith: the engine broke after the call/);
  const a = sse((await messages('fake/throw-after-call', { stream: true })).text);
  assert.equal(a.at(-1).event, 'error');
  assert.match(a.at(-1).data.error.message, /^keysmith: the engine broke after the call/);
  assert.throws(() => anthropicAccumulate(a), /stream error/, 'an Anthropic SDK raises on it');
  // Not streamed, the whole answer is the error.
  const plain = await chat('fake/throw-after-call');
  assert.equal(plain.status, 502);
  assert.match(JSON.parse(plain.text).error.message, /broke after the call/);
});

test('a failure after the stream opened but before any content (an engine buffering, then giving up) reaches an Anthropic client as an error event', async () => {
  const o = await chat('fake/slow-throw', { stream: true });
  assert.equal(o.status, 200);
  const of = sse(o.text);
  assert.deepEqual(of.at(-2).data.error, { message: 'keysmith: the model answered twice with something that is not a tool call', type: 'tool_emulation_error' });
  assert.equal(of.at(-1).data, '[DONE]');
  const a = await messages('fake/slow-throw', { stream: true });
  assert.equal(a.status, 200);
  const af = sse(a.text).filter((e) => e.event !== 'ping'); // keepalives while it waited
  assert.deepEqual(af.map((e) => e.event), ['message_start', 'error'], 'an event an Anthropic SDK reads, not an unnamed data frame');
  assert.deepEqual(af[1].data, { type: 'error', error: { type: 'tool_emulation_error', message: 'keysmith: the model answered twice with something that is not a tool call' } });
});

test('an error event after a call: the calls stay, the answer is marked as failed', async () => {
  const o = sse((await chat('fake/error-after-call', { stream: true })).text);
  assert.equal(openaiAccumulate(o).message.tool_calls.length, 1);
  const a = sse((await messages('fake/error-after-call', { stream: true })).text);
  assert.deepEqual(runs(a, anthropicKind), ['message_start', 'content_block_start:tool_use', 'ping', 'content_block_delta:input_json_delta', 'content_block_stop', 'error', 'message_delta', 'message_stop']);
  assert.equal(a.at(-2).data.delta.stop_reason, 'error');
  const rows = usageLog.tail(4).filter((e) => e.stream);
  assert.ok(rows.some((e) => e.status === 'error' && e.error === 'late failure' && e.toolCalls === 1), JSON.stringify(rows));
  // Not streamed: the call went out as the answer, as text that came before an error always did.
  const plain = await chat('fake/error-after-call');
  assert.equal(plain.status, 200, plain.text);
  assert.equal(JSON.parse(plain.text).choices[0].message.tool_calls.length, 1);
});

test('/v1/responses has no tool-call writer yet: an answer that is a call fails out loud instead of arriving empty', async () => {
  const plain = await post('/v1/responses', { model: 'fake/one-call', input: 'Weather in Ankara?' });
  assert.equal(plain.status, 501, plain.text);
  assert.match(JSON.parse(plain.text).error.message, /does not carry tool calls yet/);
  const streamed = await post('/v1/responses', { model: 'fake/one-call', input: 'Weather in Ankara?', stream: true });
  assert.match(streamed.text, /does not carry tool calls yet/);
  assert.doesNotMatch(streamed.text, /response\.completed/);
});

test('a call event that is not a call (arguments not a JSON object) is a 502, never a half-written call', async () => {
  const plain = await chat('fake/bad-call');
  assert.equal(plain.status, 502);
  assert.match(JSON.parse(plain.text).error.message, /without a name or a JSON object of arguments/);
  const streamed = sse((await messages('fake/bad-call', { stream: true })).text);
  assert.equal(streamed.at(-1).event, 'error');
  assert.ok(!streamed.some((e) => anthropicKind(e) === 'content_block_start:tool_use'));
});

/* ------------------------------------------------------------------------- failover */

test('a leg that fails after a call or text went out is not followed by the next leg; before that, failover is as it was', async () => {
  for (const alias of ['fo-call', 'fo-text']) {
    calls.length = 0;
    const r = await chat(alias, { stream: true });
    assert.equal(r.status, 200);
    const frames = sse(r.text);
    assert.equal(frames.at(-2).data.error?.message?.startsWith('keysmith: '), true, `${alias}: ${r.text}`);
    assert.ok(!r.text.includes('just text'), `${alias}: the second leg's answer was appended`);
    assert.deepEqual(calls.map((c) => c[0]), ['fake'], `${alias}: only the first leg ran`);
    calls.length = 0;
    const plain = await chat(alias);
    assert.equal(plain.status, 502, `${alias}: ${plain.text}`);
    assert.deepEqual(calls.map((c) => c[0]), ['fake']);
  }
  assert.ok(log.some((l) => /failed after it had started answering, so no other leg is tried/.test(l)));
  calls.length = 0;
  const before = await chat('fo-before');
  assert.equal(before.status, 200, before.text);
  assert.equal(JSON.parse(before.text).choices[0].message.content, 'just text');
  assert.deepEqual(calls.map((c) => c[0]), ['fake', 'fake2']);
});

test('gateway.collect returns the calls, the engine and its fallback', async () => {
  const two = await gateway.collect({ model: 'fake/two-calls', messages: ASK });
  assert.equal(two.text, '');
  assert.deepEqual(two.toolCalls.map((c) => [c.type, c.name, c.args.city]), [['tool_call', 'get_weather', 'Ankara'], ['tool_call', 'get_weather', 'Izmir']]);
  const mode = await gateway.collect({ model: 'fake/mode', messages: ASK });
  assert.deepEqual([mode.toolMode, mode.fallback, mode.retries, mode.toolCalls.length], ['emulate', 'readyTimeout', 1, 1]);
  const text = await gateway.collect({ model: 'fake/text', messages: ASK });
  assert.deepEqual([text.text, text.toolCalls, text.toolMode, text.fallback], ['just text', [], null, null]);
});

/* ------------------------------------------------------------------------ keepalive */

function fakeRes() {
  return {
    out: [],
    writableEnded: false,
    destroyed: false,
    closers: [],
    write(s) {
      this.out.push(s);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    once(event, fn) {
      if (event === 'close') this.closers.push(fn);
    },
  };
}
function fakeTimers() {
  const t = {
    live: new Map(),
    n: 0,
    setInterval(fn, ms) {
      t.live.set(++t.n, { fn, ms });
      return t.n;
    },
    clearInterval(h) {
      t.live.delete(h);
    },
    tick() {
      for (const { fn } of [...t.live.values()]) fn();
    },
  };
  return t;
}

test('keepalive, on a fake clock: one frame per quiet interval, none after a write, none once the answer is over', () => {
  for (const [Face, frame] of [
    [OpenaiChatStream, ': keepalive\n\n'],
    [AnthropicStream, 'event: ping\ndata: {"type":"ping"}\n\n'],
  ]) {
    const res = fakeRes();
    const clock = fakeTimers();
    const face = new Face(res, { id: 'x', model: 'm', created: 1, timers: clock });
    face.open();
    assert.deepEqual([...clock.live.values()].map((t) => t.ms), [15_000], `${Face.name}: every 15 s by default`);
    /** What one interval of the fake clock wrote. */
    const tick = () => {
      const n = res.out.length;
      clock.tick();
      return res.out.slice(n);
    };
    assert.deepEqual(tick(), [frame], `${Face.name}: a quiet interval, a keepalive`);
    assert.deepEqual(tick(), [frame], `${Face.name}: and another`);
    face.text('hello');
    assert.deepEqual(tick(), [], `${Face.name}: an interval with a write needs no keepalive`);
    assert.deepEqual(tick(), [frame]);
    face.finish({});
    assert.equal(clock.live.size, 0, `${Face.name}: the timer is gone with the answer`);
    assert.deepEqual(tick(), []);
  }
  // A response that closed under it stops it too; an interval of 0 is no keepalive at all.
  const res = fakeRes();
  const clock = fakeTimers();
  keepalive(res, ': k\n\n', { intervalMs: 1000, timers: clock });
  res.destroyed = true;
  clock.tick();
  assert.equal(clock.live.size, 0);
  assert.deepEqual(res.out, []);
  const off = fakeTimers();
  keepalive(fakeRes(), ': k\n\n', { intervalMs: 0, timers: off });
  assert.equal(off.live.size, 0);
});

test('keepalive on the wire: while an engine is quiet the stream gets SSE comments (OpenAI) and ping events (Anthropic)', async () => {
  const o = await chat('fake/slow-call', { stream: true });
  assert.ok((o.text.match(/^: keepalive$/gm) || []).length >= 2, o.text);
  assert.equal(openaiAccumulate(sse(o.text)).message.tool_calls.length, 1, 'and the answer is whole');
  const a = await messages('fake/slow-call', { stream: true });
  const events = sse(a.text);
  const firstBlock = events.findIndex((e) => e.event === 'content_block_start');
  assert.ok(events.slice(0, firstBlock).filter((e) => e.event === 'ping').length >= 2, a.text);
  assert.equal(anthropicAccumulate(events).content[0].input.city, 'Ankara');
});

/* --------------------------------------------------------------------- the usage log */

test('a usage row says the engine, the number of calls, the retries and the fallback — never an argument or a result', async () => {
  const history = [
    { role: 'user', content: 'look it up' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ secret: ARG_SENTINEL }) } }] },
    { role: 'tool', tool_call_id: 'call_1', content: RESULT_SENTINEL },
  ];
  const aHistory = [
    { role: 'user', content: 'look it up' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { secret: ARG_SENTINEL } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: RESULT_SENTINEL }] },
  ];
  const before = usageLog.tail(10_000).length;
  for (const stream of [false, true]) {
    const o = await post('/v1/chat/completions', { model: 'fake/mode', messages: history, tools: TOOLS, stream });
    assert.ok(o.text.includes(ARG_SENTINEL), 'the client gets its call');
    await post('/v1/messages', { model: 'fake/mode', max_tokens: 64, messages: aHistory, tools: A_TOOLS, stream });
  }
  const rows = usageLog.tail(10_000).slice(0, usageLog.tail(10_000).length - before);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual([row.status, row.toolMode, row.toolCalls, row.retries, row.fallback], ['ok', 'emulate', 1, 1, 'readyTimeout'], JSON.stringify(row));
    assert.equal(row.key, `fp:${row.key.slice(3)}`);
  }
  const file = fs.readFileSync(usageLog.file, 'utf8');
  assert.ok(!file.includes(ARG_SENTINEL), 'no argument in the usage log');
  assert.ok(!file.includes(RESULT_SENTINEL), 'no tool result in the usage log');
  assert.ok(!log.join('\n').includes(ARG_SENTINEL) && !log.join('\n').includes(RESULT_SENTINEL), 'nor in the gateway log');
  // A row without tools is as it was: no tool fields at all.
  await chat('fake/text');
  const plain = usageLog.tail(1)[0];
  assert.deepEqual(['toolMode', 'toolCalls', 'fallback'].filter((k) => k in plain), []);
});

test('a request relayed verbatim to an HTTP upstream says so in its usage row: toolMode passthrough', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    gateway.adapters.set('up', new HttpAdapter('up', { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, _apiKey: null }));
    const r = await chat('up/m');
    assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
    const row = usageLog.tail(1)[0];
    assert.deepEqual([row.model, row.via, row.toolMode], ['up/m', 'passthrough', 'passthrough']);
  } finally {
    gateway.adapters.delete('up');
    await new Promise((r) => upstream.close(r));
  }
});
