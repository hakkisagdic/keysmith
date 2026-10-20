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
import { responsesToolMessages, responsesToolSpec } from '../src/tools/model.js';

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
    results(output, textFor = (c) => `RESULT for ${JSON.parse(c.arguments).city}`) {
      for (const item of output) input.push(item);
      for (const c of output.filter((o) => o.type === 'function_call')) input.push({ type: 'function_call_output', call_id: c.call_id, output: textFor(c) });
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

test('Responses input, tool-aware: function_call items are their assistant turn\'s calls, function_call_output items tool results by call_id; reasoning and references left out', () => {
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
    ['assistant', 'Checking.', ['call_a', 'call_b'], null],
    ['tool', 'sunny', [], 'call_a'],
    ['tool', 'rainy', [], 'call_b'],
    ['assistant', '', ['call_c', 'call_d'], null],
    ['tool', 'applied', [], 'call_d'],
  ]);
  assert.deepEqual(messages[3].toolCalls[0].args, { city: 'Ankara' });
  assert.deepEqual(responsesToolMessages({ input: 'hello' }), [{ role: 'user', text: 'hello' }]);
});

test('/v1/responses: a request whose only tool no CLI can honour (Codex\'s freeform apply_patch) is a 400 that names it; more than 128 tools is a 400 before any leg runs', async () => {
  const freeform = await post({ model: 'emu/m', tools: [{ type: 'custom', name: 'apply_patch' }], input: 'patch it' });
  assert.equal(freeform.status, 400, freeform.text);
  assert.match(JSON.parse(freeform.text).error.message, /custom "apply_patch"/);
  const more = await post({ model: 'emu/m', tools: Array.from({ length: 129 }, (_, i) => ({ ...TOOLS[0], name: `t${i}` })), input: 'hi' });
  assert.equal(more.status, 400);
  assert.match(JSON.parse(more.text).error.message, /at most 128/);
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
  assert.deepEqual(a1.calls.map((x) => JSON.parse(x.arguments).city).sort(), ['Ankara', 'Izmir']);
  c.results(a1.output);
  const a2 = await c.ask();
  assert.equal(a2.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir');
  assert.equal(lines(path.join(dir, 'oc.jsonl')).filter((e) => e.event === 'start' && e.argv.at(-1).includes(t)).length, 1);
});
