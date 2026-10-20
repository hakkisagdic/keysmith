/**
 * EMULATE on the CLIs that are not agy (design U10): opencode, codex and qoder answer a tool
 * request through their own tool-less argv (`emulateArgs`, the text argv), each read by its
 * profile's parser; kiro's argv is there too, checked against a stub only (its live runs hit the
 * overage limit), so its profile keeps toolMode off. The CLI is test/stubs/cli-emu.mjs, which
 * prints each CLI's stdout shape and answers the JSON protocol: nothing here spends a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway, checkAdapter } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { joinArgs } from '../src/util.js';

const STUB = fileURLToPath(new URL('./stubs/cli-emu.mjs', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

let dir, server, base, gateway, usageLog;
const log = [];

/** A profile around the stub: its argv, parser and workspace files as shipped, the stub printing `format`. */
function around(name, format, extra = {}) {
  const p = CLI_PROFILES[name];
  return {
    ...structuredClone(p),
    bin: STUB,
    cwd: path.join(dir, `ws-${name}-${format}`),
    env: { STUB_FORMAT: format, CLI_EMU_LOG: path.join(dir, 'runs.jsonl') },
    timeoutMs: 20_000,
    ...extra,
  };
}

/** The adapters under test: id -> [profile, stdout format, what the profile's run must carry]. */
const CASES = {
  oc: ['opencode', 'opencode'],
  cx: ['codex', 'raw'],
  qd: ['qoder', 'raw'],
  // qoder's other output shape (`-o stream-json`, parser claude-stream-json), which its note offers.
  qdj: ['qoder', 'claude', { parser: 'claude-stream-json' }],
  // kiro's profile ships toolMode off: its EMULATE argv is turned on here, as `keysmith set` would.
  kr: ['kiro', 'kiro', { toolMode: 'emulate' }],
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksec-'));
  const adapters = Object.fromEntries(Object.entries(CASES).map(([id, [name, format, extra]]) => [id, around(name, format, extra)]));
  const cfg = { auth: { enabled: true, keys: [KEY] }, limits: { streamHoldMs: 300, streamKeepaliveMs: 60 }, adapters };
  gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await gateway.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }];
const A_TOOLS = [{ name: 'get_weather', description: 'Weather', input_schema: TOOLS[0].function.parameters }];

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const runs = () => {
  const f = path.join(dir, 'runs.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const runsOf = (tag) => runs().filter((r) => r.prompt.includes(tag));
/** The usage rows of one model, oldest first (tail() reads newest first). */
const rowsOf = (model) => usageLog.tail(500).filter((r) => r.model === model).reverse();
let tags = 0;
const tag = () => `#e${++tags}-${crypto.randomBytes(3).toString('hex')}`;

/** SSE text -> its data payloads. */
const frames = (text) =>
  text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));

/** One chat-completions answer, streamed or not, as the OpenAI SDK reads it. */
function chatAnswer(stream, r) {
  if (!stream) {
    const c = JSON.parse(r.text).choices[0];
    return { text: c.message.content || '', calls: (c.message.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, args: JSON.parse(t.function.arguments) })), finish: c.finish_reason };
  }
  const calls = [];
  let text = '';
  let finish = null;
  for (const f of frames(r.text)) {
    const d = f.choices?.[0]?.delta || {};
    text += d.content || '';
    for (const t of d.tool_calls || []) {
      const c = (calls[t.index] ??= { id: null, name: '', args: '' });
      if (t.id) c.id = t.id;
      c.name += t.function?.name || '';
      c.args += t.function?.arguments || '';
    }
    finish = f.choices?.[0]?.finish_reason || finish;
  }
  return { text, calls: calls.map((c) => ({ ...c, args: JSON.parse(c.args) })), finish };
}

/** Turn one (the call), the client's result, turn two (the answer that reads it): on /v1/chat/completions. */
async function roundTrip(id, { stream = false, scenario = 'round-trip' } = {}) {
  const t = tag();
  const value = `RESULT-${crypto.randomBytes(4).toString('hex')}`;
  const history = [{ role: 'user', content: `Weather in Ankara? ${t} SCENARIO=${scenario}` }];
  const r1 = await post('/v1/chat/completions', { model: `${id}/m`, stream, tools: TOOLS, messages: history });
  assert.equal(r1.status, 200, `${id}: ${r1.text.slice(0, 300)}`);
  const a1 = chatAnswer(stream, r1);
  history.push({ role: 'assistant', content: null, tool_calls: a1.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
  for (const c of a1.calls) history.push({ role: 'tool', tool_call_id: c.id, content: `${value} for ${c.args.city}` });
  const r2 = await post('/v1/chat/completions', { model: `${id}/m`, stream, tools: TOOLS, messages: history });
  assert.equal(r2.status, 200, `${id}: ${r2.text.slice(0, 300)}`);
  return { t, value, r1, a1, r2, a2: chatAnswer(stream, r2) };
}

/* --------------------------------------------------------------------------- tests */

for (const [id, [name, format]] of Object.entries(CASES)) {
  test(`${name} (${format}): a two-turn round trip, not streamed — the call fits the schema, the answer reads the result, through the profile's own tool-less argv`, async () => {
    const { t, value, r1, a1, a2 } = await roundTrip(id);
    assert.equal(r1.headers.get('x-keysmith-mode'), 'emulate');
    assert.equal(a1.finish, 'tool_calls');
    assert.deepEqual(a1.calls.map((c) => [c.name, c.args]), [['get_weather', { city: 'Ankara' }]]);
    assert.match(a1.calls[0].id, /^call_[0-9a-f]{24}$/, 'keysmith makes the id');
    assert.equal(a2.finish, 'stop');
    assert.equal(a2.text, `Weather: ${value} for Ankara`, 'the second turn read the fenced result');
    const [one, two] = runsOf(t);
    assert.ok(one && two, 'one run a turn');
    // The run is the profile's emulateArgs, as shipped: the prompt last, nothing resumed.
    const p = CLI_PROFILES[name];
    const expected = joinArgs(p.emulateArgs, { model: 'm', prompt: one.prompt, system: '', session: '', noSession: p.persistSessions ? '' : p.noSessionFlag || '--no-session', maxTokens: '' });
    assert.deepEqual(one.argv, expected);
    assert.equal(one.argv.at(-1), one.prompt);
    assert.match(one.prompt, /# Answer format/, 'the tool protocol is in the prompt');
    assert.match(two.prompt, /<<<TOOL_RESULT n=[0-9a-f]{8} id=call_[0-9a-f]{24} name=get_weather error=false>>>/, 'the result is fenced');
    assert.ok(!one.argv.some((a) => /resume|--session$|--conversation/.test(a)), 'no CLI session is resumed on this path');
    const rows = rowsOf(`${id}/m`).filter((r) => r.toolMode);
    assert.deepEqual(rows.slice(-2).map((r) => [r.toolMode, r.toolCalls ?? 0]), [['emulate', 1], ['emulate', 0]]);
  });

  test(`${name} (${format}): streamed, the call arrives the way a provider streams it, and /v1/messages takes the same round trip`, async () => {
    const { value, r1, a1, a2 } = await roundTrip(id, { stream: true });
    assert.match(r1.headers.get('content-type'), /event-stream/);
    assert.deepEqual(a1.calls.map((c) => [c.name, c.args]), [['get_weather', { city: 'Ankara' }]]);
    assert.equal(a1.finish, 'tool_calls');
    assert.equal(a2.text, `Weather: ${value} for Ankara`);
    // The Messages API: tool_use, then a tool_result in the user turn.
    const t = tag();
    const first = await post('/v1/messages', { model: `${id}/m`, max_tokens: 256, tools: A_TOOLS, messages: [{ role: 'user', content: `Weather? ${t}` }] });
    assert.equal(first.status, 200, first.text);
    const m1 = JSON.parse(first.text);
    assert.equal(m1.stop_reason, 'tool_use');
    const use = m1.content.find((b) => b.type === 'tool_use');
    assert.match(use.id, /^toolu_[0-9a-f]{24}$/);
    assert.deepEqual(use.input, { city: 'Ankara' });
    const second = await post('/v1/messages', {
      model: `${id}/m`,
      max_tokens: 256,
      tools: A_TOOLS,
      messages: [{ role: 'user', content: `Weather? ${t}` }, { role: 'assistant', content: m1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'cloudy-17' }] }],
    });
    const m2 = JSON.parse(second.text);
    assert.equal(m2.stop_reason, 'end_turn');
    assert.equal(m2.content[0].text, 'Weather: cloudy-17');
  });
}

test('opencode: parallel calls come back in one answer, two tool_calls', async () => {
  const r = await post('/v1/chat/completions', { model: 'oc/m', tools: TOOLS, messages: [{ role: 'user', content: `Two cities ${tag()} SCENARIO=two-calls` }] });
  const a = chatAnswer(false, r);
  assert.deepEqual(a.calls.map((c) => c.args.city), ['Ankara', 'Izmir']);
  assert.equal(new Set(a.calls.map((c) => c.id)).size, 2);
});

test('codex (raw): prose around the JSON is asked for again once, and the second reply is the answer; a fenced object is read as is', async () => {
  const t = tag();
  const r = await post('/v1/chat/completions', { model: 'cx/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather ${t} SCENARIO=prose-then-ok` }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(chatAnswer(false, r).calls.map((c) => c.args), [{ city: 'Ankara' }]);
  const [one, two] = runsOf(t);
  assert.equal(one.second, false);
  assert.equal(two.second, true, 'the second run carries the correction line');
  assert.equal(rowsOf('cx/m').at(-1).retries, 1);
  const fenced = await post('/v1/chat/completions', { model: 'cx/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather ${tag()} SCENARIO=fenced` }] });
  assert.deepEqual(chatAnswer(false, fenced).calls.map((c) => c.args), [{ city: 'Ankara' }]);
});

test('qoder (raw): two replies that are not the JSON object are a 502 tool_emulation_error, and no text goes out in place of a call', async () => {
  const r = await post('/v1/chat/completions', { model: 'qd/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather ${tag()} SCENARIO=prose-always` }] });
  assert.equal(r.status, 502);
  const body = JSON.parse(r.text);
  assert.equal(body.error.type, 'tool_emulation_error');
  assert.match(body.error.message, /twice/);
  assert.doesNotMatch(r.text, /I would call/, 'the reply itself is not repeated');
});

for (const [id, name] of [['oc', 'opencode'], ['kr', 'kiro']]) {
  test(`${name}: a tool call of the CLI's own before the reply is passed by; one after it ends the run there (stopAtToolCall), and the reply stands`, async () => {
    const beforeR = await post('/v1/chat/completions', { model: `${id}/m`, tools: TOOLS, messages: [{ role: 'user', content: `Weather ${tag()} SCENARIO=tool-before` }] });
    assert.equal(beforeR.status, 200, beforeR.text);
    assert.deepEqual(chatAnswer(false, beforeR).calls.map((c) => c.args), [{ city: 'Ankara' }]);
    assert.equal(rowsOf(`${id}/m`).at(-1).cutAt, undefined);
    const t0 = Date.now();
    const afterR = await post('/v1/chat/completions', { model: `${id}/m`, tools: TOOLS, messages: [{ role: 'user', content: `Weather ${tag()} SCENARIO=tool-after` }] });
    assert.equal(afterR.status, 200, afterR.text);
    assert.deepEqual(chatAnswer(false, afterR).calls.map((c) => c.args), [{ city: 'Ankara' }], 'the reply before the call, and nothing after it');
    assert.ok(Date.now() - t0 < 10_000, 'the run was stopped at the call, not left to run on');
    assert.equal(rowsOf(`${id}/m`).at(-1).cutAt, 'bash');
  });
}

test('profiles: opencode, codex and qoder answer tool requests with EMULATE through their text argv; kiro carries the argv and keeps toolMode off', () => {
  for (const name of ['opencode', 'codex', 'qoder']) {
    const p = CLI_PROFILES[name];
    assert.equal(p.toolMode, 'emulate', name);
    assert.deepEqual(p.emulateArgs, p.args, `${name}: EMULATE runs the tool-less text argv`);
    assert.notEqual(p.emulateArgs, p.args, `${name}: a copy, not the same list`);
    assert.equal(checkAdapter(name, p).toolMode, 'emulate');
    assert.match(p.note, /EMULATE/, `${name}: the note says how tool requests are answered`);
  }
  const k = CLI_PROFILES.kiro;
  assert.equal(k.toolMode, 'off', 'never verified live: the overage limit refused every run');
  assert.deepEqual(k.emulateArgs, k.args);
  assert.match(k.note, /stub/);
  assert.equal(checkAdapter('kiro', { ...k, toolMode: 'emulate' }).toolMode, 'emulate', '`keysmith set kiro toolMode emulate` loads');
});
