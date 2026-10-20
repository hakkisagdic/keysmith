/**
 * Tools on the Responses face (design U12): a Responses body read into the canonical tool model
 * (src/tools/model.js), and round trips through /v1/responses on the engines — EMULATE (opencode's
 * profile around test/stubs/cli-emu.mjs) and the MCP bridge (agy around test/stubs/agy-bridge.mjs;
 * opencode, two calls at once, around test/stubs/cli-bridge.mjs). The answer's shape against the
 * SDK's reading is test/tools-faces.test.js's. Nothing here spends a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { responsesStateRefusal, responsesToolMessages, responsesToolSpec } from '../src/tools/model.js';

const EMU = fileURLToPath(new URL('./stubs/cli-emu.mjs', import.meta.url));
const AGY = fileURLToPath(new URL('./stubs/agy-bridge.mjs', import.meta.url));
const OC = fileURLToPath(new URL('./stubs/cli-bridge.mjs', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

let dir, server, base, gateway, usageLog;
const log = [];

before(async () => {
  // os.tmpdir(): the bridge socket's path must stay under 103 bytes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksrs-'));
  const p = (name) => structuredClone(CLI_PROFILES[name]);
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 300, streamKeepaliveMs: 60, bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 4, maxSessionsPerKey: 4 } },
    adapters: {
      // EMULATE: opencode's own argv around a stub that answers from the fenced results.
      emu: { ...p('opencode'), bin: EMU, cwd: path.join(dir, 'ws-emu'), toolMode: 'emulate', env: { STUB_FORMAT: 'opencode', CLI_EMU_LOG: path.join(dir, 'emu.jsonl') }, timeoutMs: 20_000 },
      // The bridge on agy: one call per answer, the result into the same process.
      agy: { ...p('agy'), bin: AGY, cwd: path.join(dir, 'ws-agy'), toolMode: 'mcp', bridge: { ...p('agy').bridge, mcpCacheDir: path.join(dir, 'mcp-cache'), readyTimeoutMs: 10_000 }, env: { AGY_BRIDGE_LOG: path.join(dir, 'agy.jsonl'), STUB_MCP_CACHE: path.join(dir, 'mcp-cache') }, timeoutMs: 20_000, maxConcurrent: 4 },
      // The bridge on opencode: a step's calls in one answer.
      oc: { ...p('opencode'), bin: OC, cwd: path.join(dir, 'ws-oc'), toolMode: 'mcp', bridge: { ...p('opencode').bridge, readyTimeoutMs: 10_000 }, env: { STUB_CLI: 'opencode', CLI_BRIDGE_LOG: path.join(dir, 'oc.jsonl') }, timeoutMs: 20_000, maxConcurrent: 4 },
    },
  };
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

const TOOLS = [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } }];

async function post(body) {
  const res = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastRow = () => usageLog.tail(1)[0];
let tags = 0;
const tag = () => `#r${++tags}-${crypto.randomBytes(3).toString('hex')}`;

/** A Responses answer, streamed or not, as the SDK's final response has it: its output items. */
function outputOf(stream, r) {
  if (!stream) return JSON.parse(r.text).output;
  const events = r.text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const done = events.find((e) => e.type === 'response.completed');
  if (!done) throw new Error(`no response.completed: ${r.text.slice(-300)}`);
  return done.response.output;
}

/**
 * A conversation on /v1/responses, the way a Responses client keeps one (store: false): the input
 * grows by the answer's output items and a function_call_output for each call.
 */
function conversation(model, user, { stream = false } = {}) {
  const input = [{ role: 'user', content: user }];
  return {
    input,
    async ask() {
      const r = await post({ model, stream, store: false, tools: TOOLS, input });
      if (r.status !== 200) return { r, output: [] };
      const output = outputOf(stream, r);
      return { r, output, calls: output.filter((o) => o.type === 'function_call'), text: output.filter((o) => o.type === 'message').map((o) => o.content.map((c) => c.text).join('')).join('') };
    },
    /** The answer's items, and an output for each call: after all of them, or (`interleave`) right after each one. */
    results(output, textFor = (c) => `RESULT for ${JSON.parse(c.arguments).city}`, { interleave = false } = {}) {
      const result = (c) => ({ type: 'function_call_output', call_id: c.call_id, output: textFor(c) });
      for (const item of output) {
        input.push(item);
        if (interleave && item.type === 'function_call') input.push(result(item));
      }
      if (!interleave) for (const c of output.filter((o) => o.type === 'function_call')) input.push(result(c));
    },
  };
}

/* ------------------------------------------------------------------- the reading */

test('a Responses body\'s tools: function tools taken; custom (freeform apply_patch) and hosted tools unsupported; tool_choice and parallel_tool_calls read', () => {
  const spec = responsesToolSpec({ tools: [...TOOLS, { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }, { type: 'web_search' }], tool_choice: 'required', parallel_tool_calls: false });
  assert.deepEqual(spec.tools.map((t) => t.name), ['get_weather']);
  assert.deepEqual(spec.unsupported, [{ type: 'custom', name: 'apply_patch' }, { type: 'web_search' }]);
  assert.deepEqual(spec.choice, { mode: 'required' });
  assert.equal(spec.parallel, false);
  assert.deepEqual(responsesToolSpec({ tools: TOOLS, tool_choice: { type: 'function', name: 'get_weather' } }).choice, { mode: 'named', name: 'get_weather' });
  const allowed = responsesToolSpec({ tools: TOOLS, tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [] } });
  assert.equal(allowed.unsupported[0].type, 'tool_choice');
  assert.equal(responsesToolSpec({ tools: TOOLS }).parallel, true);
  assert.equal(responsesToolSpec({ input: 'hi' }), null);
});

test('Responses input, tool-aware: function_call items are their assistant turn\'s calls, function_call_output items tool results by call_id; reasoning items left out (an item reference too: the server refuses it first)', () => {
  const messages = responsesToolMessages({
    instructions: 'Be brief.',
    input: [
      { role: 'developer', content: 'Use tools.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Weather in two cities?' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xyz' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Ankara"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'get_weather', arguments: '{"city":"Izmir"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'sunny' },
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'rainy' }] },
      { type: 'item_reference', id: 'msg_old' },
      { type: 'function_call', call_id: 'call_c', name: 'get_weather', arguments: '{"city":"Bursa"}' },
      { type: 'custom_tool_call', call_id: 'call_d', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_d', output: 'applied' },
    ],
  });
  assert.deepEqual(messages.map((m) => [m.role, m.text, (m.toolCalls || []).map((c) => c.id), m.toolCallId ?? null]), [
    ['system', 'Be brief.', [], null],
    ['system', 'Use tools.', [], null],
    ['user', 'Weather in two cities?', [], null],
    // One run of calls and outputs, no message between them: one turn.
    ['assistant', 'Checking.', ['call_a', 'call_b', 'call_c', 'call_d'], null],
    ['tool', 'sunny', [], 'call_a'],
    ['tool', 'rainy', [], 'call_b'],
    ['tool', 'applied', [], 'call_d'],
  ]);
  assert.match(responsesStateRefusal({ input: [{ type: 'item_reference', id: 'msg_old' }] }), /item_reference \(msg_old\)/);
  assert.deepEqual(messages[3].toolCalls[0].args, { city: 'Ankara' });
  assert.deepEqual(responsesToolMessages({ input: 'hello' }), [{ role: 'user', text: 'hello' }]);
});

test('Responses input: the calls of an unbroken run of function_call and function_call_output items are one assistant turn, its outputs after it in the calls\' order, whichever order the client used; a message ends the run', () => {
  const fc = (id) => ({ type: 'function_call', call_id: id, name: 'get_weather', arguments: '{"city":"X"}' });
  const fco = (id) => ({ type: 'function_call_output', call_id: id, output: `out ${id}` });
  const shape = (input) => responsesToolMessages({ input }).map((m) => [m.role, m.text, (m.toolCalls || []).map((c) => c.id), m.toolCallId ?? null]);
  const both = [
    ['user', 'Two cities?', [], null],
    ['assistant', 'Checking.', ['a', 'b'], null],
    ['tool', 'out a', [], 'a'],
    ['tool', 'out b', [], 'b'],
  ];
  const head = [{ role: 'user', content: 'Two cities?' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] }];
  assert.deepEqual(shape([...head, fc('a'), fc('b'), fco('a'), fco('b')]), both);
  assert.deepEqual(shape([...head, fc('a'), fco('a'), fc('b'), fco('b')]), both, 'each call followed by its output');
  assert.deepEqual(shape([...head, fc('a'), fc('b'), fco('b'), fco('a')]), both, 'the outputs in another order');
  // A reasoning item inside the run does not end it; a message does, and so does a plain string.
  assert.deepEqual(shape([...head, fc('a'), fco('a'), { type: 'reasoning', id: 'rs_1', summary: [] }, fc('b'), fco('b')]), both);
  assert.deepEqual(shape([...head, fc('a'), fco('a'), { role: 'user', content: 'and Izmir?' }, fc('b'), fco('b')]), [
    ['user', 'Two cities?', [], null],
    ['assistant', 'Checking.', ['a'], null],
    ['tool', 'out a', [], 'a'],
    ['user', 'and Izmir?', [], null],
    ['assistant', '', ['b'], null],
    ['tool', 'out b', [], 'b'],
  ]);
  assert.deepEqual(shape([...head, fc('a'), fco('a'), { type: 'message', role: 'assistant', content: 'Now Izmir.' }, fc('b'), fco('b')]).map((m) => m.slice(0, 3)), [
    ['user', 'Two cities?', []],
    ['assistant', 'Checking.', ['a']],
    ['tool', 'out a', []],
    ['assistant', 'Now Izmir.', ['b']],
    ['tool', 'out b', []],
  ]);
  assert.deepEqual(shape([...head, fc('a'), fco('a'), 'and Izmir?', fco('a')]).map((m) => m[0]), ['user', 'assistant', 'tool', 'user', 'tool']);
});

test('/v1/responses: a request whose only tool no CLI can honour (Codex\'s freeform apply_patch) is a 400 that names it; more than 128 tools is a 400 before any leg runs', async () => {
  const freeform = await post({ model: 'emu/m', tools: [{ type: 'custom', name: 'apply_patch' }], input: 'patch it' });
  assert.equal(freeform.status, 400, freeform.text);
  assert.match(JSON.parse(freeform.text).error.message, /custom "apply_patch"/);
  const more = await post({ model: 'emu/m', tools: Array.from({ length: 129 }, (_, i) => ({ ...TOOLS[0], name: `t${i}` })), input: 'hi' });
  assert.equal(more.status, 400);
  assert.match(JSON.parse(more.text).error.message, /at most 128/);
});

/* -------------------------------------------------------- what keysmith never stored */

test('/v1/responses: previous_response_id is a 400 that says keysmith stores no responses — with tools or without — and no CLI runs for it', async () => {
  const t = tag();
  const c = conversation('emu/m', `Weather in Ankara? ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  const id = JSON.parse(a1.r.text).id;
  const runs = () => lines(path.join(dir, 'emu.jsonl')).length;
  const before = runs();
  // The openai SDK's other tool loop: the first response's id, and only the output.
  const follow = await post({ model: 'emu/m', store: true, tools: TOOLS, previous_response_id: id, input: [{ type: 'function_call_output', call_id: a1.calls[0].call_id, output: 'sunny, 24C' }] });
  assert.equal(follow.status, 400, follow.text);
  const err = JSON.parse(follow.text).error;
  assert.equal(err.type, 'invalid_request_error');
  assert.match(err.message, /previous_response_id/);
  assert.match(err.message, /stores no responses/);
  assert.match(err.message, /whole conversation in input/);
  for (const stream of [false, true]) {
    const plain = await post({ model: 'emu/m', stream, previous_response_id: id, input: 'And tomorrow?' });
    assert.equal(plain.status, 400, plain.text);
    assert.match(JSON.parse(plain.text).error.message, /previous_response_id/);
  }
  // The Conversations API's id is the same thing: state keysmith never had.
  const conv = await post({ model: 'emu/m', tools: TOOLS, conversation: 'conv_123', input: 'And tomorrow?' });
  assert.equal(conv.status, 400, conv.text);
  assert.match(JSON.parse(conv.text).error.message, /conversation/);
  // So is an item_reference: an item of a stored response, standing in for the item itself.
  const ref = await post({ model: 'emu/m', tools: TOOLS, input: [{ role: 'user', content: 'Weather?' }, { type: 'item_reference', id: 'fc_old' }, { type: 'function_call_output', call_id: 'call_old', output: 'sunny' }] });
  assert.equal(ref.status, 400, ref.text);
  assert.match(JSON.parse(ref.text).error.message, /item_reference/);
  assert.equal(runs(), before, 'no CLI ran for a refused request');
});

test('/v1/responses: a function_call_output with no function_call before it is a 400 (OpenAI\'s too), not an answer built from an orphan result', async () => {
  const runs = () => lines(path.join(dir, 'emu.jsonl')).length;
  const before = runs();
  const orphan = [{ role: 'user', content: 'Weather in Ankara?' }, { type: 'function_call_output', call_id: 'call_nowhere', output: 'sunny, 24C' }];
  for (const body of [{ tools: TOOLS, input: orphan }, { input: orphan }, { tools: TOOLS, input: [...orphan.slice(0, 1), { type: 'function_call', call_id: 'call_late', name: 'get_weather', arguments: '{"city":"Ankara"}' }, ...orphan.slice(1)] }]) {
    const r = await post({ model: 'emu/m', ...body });
    assert.equal(r.status, 400, r.text);
    assert.equal(JSON.parse(r.text).error.type, 'invalid_request_error');
    assert.match(JSON.parse(r.text).error.message, /No tool call found for function call output with call_id call_nowhere/);
  }
  // The output after its call, in the same input: fine.
  const ok = await post({ model: 'emu/m', tools: TOOLS, input: [...orphan.slice(0, 1), { type: 'function_call', call_id: 'call_nowhere', name: 'get_weather', arguments: '{"city":"Ankara"}' }, ...orphan.slice(1)] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(runs(), before + 1);
});

test('the MCP bridge: a follow-up that names previous_response_id is refused before it reaches a session — the waiting one is neither answered nor evicted', async () => {
  const t = tag();
  const c = conversation('oc/m', `Weather ${t} SCENARIO=one-call`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  const callId = a1.calls[0].call_id;
  const hub = gateway.toolEngines.mcp.hub;
  const waiting = hub.sessionForCall(callId);
  assert.equal(waiting?.state, 'waiting');
  const follow = await post({ model: 'oc/m', tools: TOOLS, previous_response_id: JSON.parse(a1.r.text).id, input: [{ type: 'function_call_output', call_id: callId, output: 'sunny' }] });
  assert.equal(follow.status, 400, follow.text);
  assert.equal(hub.sessionForCall(callId), waiting, 'the session still waits for the call');
  assert.equal(waiting.state, 'waiting');
  assert.equal(lines(path.join(dir, 'oc.jsonl')).filter((e) => e.event === 'start' && e.argv.at(-1).includes(t)).length, 1, 'no second process');
  // The whole conversation, as a Responses client without stored state sends it, continues it.
  c.results(a1.output, () => 'sunny');
  const a2 = await c.ask();
  assert.equal(a2.text, 'Weather: sunny');
  assert.equal(lastRow().bridge.path, 'attached');
});

/* ------------------------------------------------------------------- round trips */

for (const stream of [false, true]) {
  test(`EMULATE through /v1/responses (${stream ? 'streamed' : 'not streamed'}): a function_call, then a function_call_output read as a fenced tool result`, async () => {
    const t = tag();
    const c = conversation('emu/m', `Weather in Ankara? ${t}`, { stream });
    const a1 = await c.ask();
    assert.equal(a1.r.status, 200, a1.r.text);
    assert.equal(a1.r.headers.get('x-keysmith-mode'), 'emulate');
    assert.deepEqual(a1.calls.map((x) => [x.name, JSON.parse(x.arguments)]), [['get_weather', { city: 'Ankara' }]]);
    assert.match(a1.calls[0].call_id, /^call_[0-9a-f]{24}$/);
    c.results(a1.output);
    const a2 = await c.ask();
    assert.equal(a2.r.status, 200, a2.r.text);
    assert.equal(a2.text, 'Weather: RESULT for Ankara');
    const second = lines(path.join(dir, 'emu.jsonl')).filter((e) => e.prompt.includes(t)).at(-1);
    assert.match(second.prompt, new RegExp(`<<<TOOL_RESULT n=[0-9a-f]{8} id=${a1.calls[0].call_id} name=get_weather error=false>>>\\nRESULT for Ankara\\n`));
    assert.equal(lastRow().via, '/v1/responses');
    assert.equal(lastRow().toolMode, 'emulate');
  });
}

test('the MCP bridge through /v1/responses (agy): the call\'s result, sent as a function_call_output, goes back into the same agy process', async () => {
  const t = tag();
  const c = conversation('agy/m', `Weather? ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.equal(a1.r.headers.get('x-keysmith-mode'), 'mcp');
  assert.match(a1.calls[0].call_id, /^call_[0-9a-f]{24}$/);
  c.results(a1.output);
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(a2.text, 'Weather: RESULT for Ankara');
  const starts = lines(path.join(dir, 'agy.jsonl')).filter((e) => e.event === 'start' && e.prompt.includes(t));
  assert.equal(starts.length, 1, 'one agy process for both turns');
  assert.equal(lastRow().bridge.path, 'attached');
});

test('the MCP bridge through /v1/responses (opencode, streamed): a step\'s two calls are two function_call items of one response, and both outputs go back in the next', async () => {
  const t = tag();
  const c = conversation('oc/m', `Two cities ${t} SCENARIO=two-calls`, { stream: true });
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.equal(a1.text, 'Checking both cities. ');
  assert.deepEqual(a1.calls.map((x) => JSON.parse(x.arguments).city).sort(), ['Ankara', 'Izmir']);
  c.results(a1.output);
  const a2 = await c.ask();
  assert.equal(a2.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir', 'the whole answer after the results, not cut by the text before the calls');
  assert.equal(lines(path.join(dir, 'oc.jsonl')).filter((e) => e.event === 'start' && e.argv.at(-1).includes(t)).length, 1);
});

for (const stream of [false, true]) {
  test(`the MCP bridge through /v1/responses (opencode${stream ? ', streamed' : ''}): two calls of one answer sent back each followed by its output still continue the session`, async () => {
    const t = tag();
    const c = conversation('oc/m', `Two cities ${t} SCENARIO=two-calls`, { stream });
    const a1 = await c.ask();
    assert.equal(a1.r.status, 200, a1.r.text);
    assert.equal(a1.calls.length, 2);
    c.results(a1.output, undefined, { interleave: true });
    assert.deepEqual(c.input.map((i) => i.type ?? i.role).slice(1), ['message', 'function_call', 'function_call_output', 'function_call', 'function_call_output']);
    const a2 = await c.ask();
    assert.equal(a2.r.status, 200, a2.r.text);
    assert.equal(a2.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir');
    assert.equal(lastRow().bridge.path, 'attached', 'the results went into the process that waits for them');
    assert.equal(lines(path.join(dir, 'oc.jsonl')).filter((e) => e.event === 'start' && e.argv.at(-1).includes(t)).length, 1, 'one opencode process');
    const hub = gateway.toolEngines.mcp.hub;
    assert.ok(![...hub.sessions.values()].some((s) => a1.calls.some((x) => s.idSeq.includes(x.call_id)) && s.state === 'waiting'), 'no session left waiting on those calls');
  });
}

test('the MCP bridge through /v1/responses (agy): a step\'s three calls, one per answer, each sent back followed by its output, go into one agy process', async () => {
  // agy runs a step's calls one after the other: each answer holds one call, and a Responses client
  // appends each call and its output. The input then reads as one run of calls and outputs.
  const t = tag();
  const c = conversation('agy/m', `Three ${t} SCENARIO=three-calls`);
  const cities = [];
  let a = await c.ask();
  for (let i = 0; i < 3; i++) {
    assert.equal(a.r.status, 200, a.r.text);
    assert.equal(a.calls.length, 1, `answer ${i + 1}: one call`);
    cities.push(JSON.parse(a.calls[0].arguments).city);
    c.results(a.output, undefined, { interleave: true });
    a = await c.ask();
    assert.equal(lastRow().bridge.path, 'attached', `turn ${i + 2}`);
  }
  assert.deepEqual(cities, ['Ankara', 'Izmir', 'Bursa']);
  assert.equal(a.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir; Bursa RESULT for Bursa');
  assert.equal(lines(path.join(dir, 'agy.jsonl')).filter((e) => e.event === 'start' && e.prompt.includes(t)).length, 1, 'one agy process for four turns');
});

test('the MCP bridge through /v1/responses (agy): a run whose earlier call has lost its output is no continuation — every call of the run needs its one output', async () => {
  const t = tag();
  const c = conversation('agy/m', `Three ${t} SCENARIO=three-calls`);
  const a1 = await c.ask();
  c.results(a1.output, undefined, { interleave: true });
  const a2 = await c.ask();
  assert.equal(lastRow().bridge.path, 'attached');
  const [start] = lines(path.join(dir, 'agy.jsonl')).filter((e) => e.event === 'start' && e.prompt.includes(t));
  // The client drops the first call's output: the second call's output is the one the session waits for.
  c.input.splice(c.input.findIndex((i) => i.type === 'function_call_output'), 1);
  c.results(a2.output, undefined, { interleave: true });
  const a3 = await c.ask();
  assert.equal(a3.r.status, 200, a3.r.text);
  assert.equal(lastRow().bridge.path, 'cold');
  assert.equal(lines(path.join(dir, 'agy.jsonl')).filter((e) => e.pid === start.pid && e.event === 'result').length, 1, 'the waiting agy got only the first result');
  await Promise.all([...gateway.toolEngines.mcp.hub.sessions.values()].map((s) => s.close('test_done')));
});
