/**
 * The MCP bridge with agy (design §3, U7): src/bridge/index.js and src/bridge/agy.js behind the
 * gateway's two faces. The CLI is test/stubs/agy-bridge.mjs, which does what agy 1.4.2 was seen
 * to do: it reads the session's agent file from its cwd, starts the MCP server named there (the
 * real shim, so the hub is the real one), prints agy's stream-json, calls the tools and waits for
 * their results. With any other agent it is the EMULATE stub. Nothing here spends a token.
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
import { CliAdapter } from '../src/cli-adapter.js';
import { McpBridge } from '../src/bridge/index.js';
import { agyDriver } from '../src/bridge/agy.js';
import { agyStreamJson } from '../src/parsers.js';

const STUB = fileURLToPath(new URL('./stubs/agy-bridge.mjs', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const OTHER = 'ks_' + crypto.randomBytes(24).toString('base64url');

let dir, ws, cache, server, base, gateway, usageLog;
const log = [];

/** The agy profile around the stub, toolMode `mode`, the bridge's limits `limits`. */
function agy(mode, limits = {}, extra = {}) {
  const p = CLI_PROFILES.agy;
  return {
    kind: 'cli',
    bin: STUB,
    args: p.args,
    emulateArgs: p.emulateArgs,
    bridge: { ...p.bridge, mcpCacheDir: cache, readyTimeoutMs: 10_000, toolResultTimeoutMs: 60_000, ...limits },
    parser: p.parser,
    cwd: ws,
    workspaceFiles: p.workspaceFiles,
    stopAtToolCall: true,
    toolMode: mode,
    env: { AGY_BRIDGE_LOG: path.join(dir, 'bridge.jsonl'), AGY_EMU_LOG: path.join(dir, 'emu.jsonl'), STUB_MCP_CACHE: cache },
    timeoutMs: 20_000,
    maxConcurrent: 4,
    ...extra,
  };
}

before(async () => {
  // os.tmpdir(): the socket's path must stay under 103 bytes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksba-'));
  ws = path.join(dir, 'ws');
  cache = path.join(dir, 'mcp-cache');
  const cfg = {
    auth: { enabled: true, keys: [KEY, OTHER] },
    limits: { streamHoldMs: 300, streamKeepaliveMs: 60, bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 4, maxSessionsPerKey: 1 } },
    adapters: {
      agy: agy('auto'),
      agym: agy('mcp', { maxSessions: 1 }),
      agy1: agy('auto', { maxSessions: 1 }),
      agyt: agy('auto', { toolResultTimeoutMs: 1_200, readyTimeoutMs: 1_000 }),
      agy2: agy('auto', { maxTurns: 2 }),
      agys: agy('auto', {}, { maxConcurrent: 1 }),
      // An env value spawn() refuses at once (a NUL): a CLI that cannot be started.
      agyz: agy('mcp', {}, { env: { AGY_BRIDGE_LOG: path.join(dir, 'bridge.jsonl'), STUB_MCP_CACHE: cache, BROKEN: 'x\u0000y' } }),
    },
    aliases: { pair: ['agy/m', 'agy1/m'] },
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

/* ------------------------------------------------------------------------- helpers */

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }];
const A_TOOLS = [{ name: 'get_weather', description: 'Weather', input_schema: TOOLS[0].function.parameters }];

async function post(route, body, key = KEY, signal) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const json = (r) => JSON.parse(r.text);
const rows = () => usageLog.tail(200);
const lastRow = () => usageLog.tail(1)[0];
const stub = () => lines(path.join(dir, 'bridge.jsonl'));
const emuRuns = () => lines(path.join(dir, 'emu.jsonl'));
function lines(f) {
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
/** The stub's runs for one conversation, by the tag in its user text. */
const runsOf = (tag) => stub().filter((e) => e.event === 'start' && e.prompt.includes(tag));
const shimOf = (pid) => stub().find((e) => e.event === 'shim' && e.pid === pid)?.shimPid;
/** agy's process group: the stub, its helper (which only a signal to the group ends) and the shim. */
const groupOf = (pid) => [pid, stub().find((e) => e.event === 'helper' && e.pid === pid)?.helperPid, shimOf(pid)];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};
/** No session file or schema directory is left, and no stub or shim of `pids` runs. */
const clean = (pids = []) => {
  const agents = fs.existsSync(path.join(ws, '.agents', 'agents')) ? fs.readdirSync(path.join(ws, '.agents', 'agents')).filter((f) => f.startsWith('ks-b-')) : [];
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
  return !agents.length && !dirs.length && pids.filter(Boolean).every((p) => !alive(p));
};

/** SSE text -> its data payloads, [DONE] as is. */
const frames = (text) =>
  text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''))
    .filter(Boolean)
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));

/** One turn's answer on any face, read the way that face's SDK reads it: `{ text, calls: [{ id, name, args }], finish }`. */
function answer(face, stream, r) {
  if (face === 'openai' && !stream) {
    const c = json(r).choices[0];
    return { text: c.message.content || '', calls: (c.message.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, args: JSON.parse(t.function.arguments) })), finish: c.finish_reason };
  }
  if (face === 'openai') {
    const data = frames(r.text).filter((f) => f !== '[DONE]');
    const calls = [];
    let text = '';
    let finish = null;
    for (const f of data) {
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
  if (!stream) {
    const m = json(r);
    return { text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls: m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })), finish: m.stop_reason };
  }
  const events = r.text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const blocks = [];
  let finish = null;
  for (const e of events) {
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block, json: '' };
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') blocks[e.index].text += e.delta.text;
    if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') blocks[e.index].json += e.delta.partial_json;
    if (e.type === 'message_delta') finish = e.delta.stop_reason;
  }
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: JSON.parse(b.json) })), finish };
}

/**
 * A conversation on one face: `ask()` sends the history (with the tools) and returns the turn's
 * answer; `result(text)` appends that answer's calls and a result for each, the way the face's
 * SDK users do it.
 */
function conversation(face, { model = 'agy/m', stream = false, user, key = KEY } = {}) {
  const history = [{ role: 'user', content: user }];
  let last = null;
  return {
    history,
    async ask(extra = {}) {
      const body = face === 'openai' ? { model, stream, tools: TOOLS, messages: history, ...extra } : { model, stream, max_tokens: 512, tools: A_TOOLS, messages: history, ...extra };
      const r = await post(face === 'openai' ? '/v1/chat/completions' : '/v1/messages', body, key);
      last = r.status === 200 ? answer(face, stream, r) : null;
      return { r, ...(last || {}) };
    },
    result(textFor = (c) => `RESULT for ${c.args.city}`) {
      if (face === 'openai') {
        history.push({ role: 'assistant', content: last.text || null, tool_calls: last.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
        for (const c of last.calls) history.push({ role: 'tool', tool_call_id: c.id, content: textFor(c) });
      } else {
        history.push({ role: 'assistant', content: [...(last.text ? [{ type: 'text', text: last.text }] : []), ...last.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] });
        history.push({ role: 'user', content: last.calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: textFor(c) })) });
      }
    },
  };
}

let tags = 0;
const tag = () => `#t${++tags}-${crypto.randomBytes(3).toString('hex')}`;

/* --------------------------------------------------------------------------- tests */

test('agy-stream-json with perStepUsage: each agent_response step\'s usage as it ends, and the result line\'s total only when no step had one', async () => {
  const run = async (list, opts) => {
    const out = [];
    for await (const e of agyStreamJson((async function* () {
      for (const l of list) yield JSON.stringify(l);
    })(), opts)) out.push(e);
    return out;
  };
  const steps = [
    { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 10, output_tokens: 1 } } },
    { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'mcp_ks000000_get_weather' } },
    { event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'ok', usage: { input_tokens: 20, output_tokens: 2 } } },
    { event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { input_tokens: 999, output_tokens: 999 } } },
  ];
  const per = await run(steps, { perStepUsage: true });
  assert.deepEqual(per.filter((e) => e.type === 'usage').map((e) => [e.usage.input, e.usage.output]), [[10, 1], [20, 2]]);
  assert.deepEqual(per.filter((e) => e.type === 'tool').map((e) => e.name), ['mcp_ks000000_get_weather']);
  const summed = await run(steps);
  assert.deepEqual(summed.filter((e) => e.type === 'usage').map((e) => [e.usage.input, e.usage.output]), [[30, 3]], 'a text run reads it as it always did');
  const noSteps = await run([steps[3]], { perStepUsage: true });
  assert.deepEqual(noSteps.filter((e) => e.type === 'usage').map((e) => e.usage.input), [999]);
});

for (const [face, stream] of [
  ['openai', false],
  ['openai', true],
  ['anthropic', false],
  ['anthropic', true],
]) {
  test(`two turns on one agy process (${face}, ${stream ? 'streamed' : 'not streamed'}): the call goes to the client, its result back to the same process, and nothing is left after`, async () => {
    const t = tag();
    const c = conversation(face, { stream, user: `Weather in Ankara? SCENARIO=one-call ${t}` });
    const one = await c.ask();
    assert.equal(one.r.status, 200, one.r.text);
    assert.equal(one.r.headers.get('x-keysmith-mode'), 'mcp');
    assert.equal(one.calls.length, 1);
    assert.equal(one.calls[0].name, 'get_weather');
    assert.deepEqual(one.calls[0].args, { city: 'Ankara' });
    assert.match(one.calls[0].id, face === 'openai' ? /^call_[0-9a-f]{24}$/ : /^toolu_[0-9a-f]{24}$/, 'keysmith\'s id, in the face\'s shape');
    assert.equal(one.finish, face === 'openai' ? 'tool_calls' : 'tool_use');
    let row = lastRow();
    assert.deepEqual([row.toolMode, row.toolCalls, row.bridge.path, row.bridge.turn], ['mcp', 1, 'new', 1]);
    assert.deepEqual([row.usage.input, row.usage.output], [1000, 20], 'the steps of this turn');
    // Between the turns: one agy process, waiting on its call, with its agent file in place.
    const [run] = runsOf(t);
    assert.ok(alive(run.pid));
    const file = path.join(ws, '.agents', 'agents', `${run.agent}.md`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(`ks${run.agent.slice(5, 11)}`, row.bridge.session, 'the server is ks<rid6> of the agent ks-b-<rid>');
    assert.ok(fs.existsSync(path.join(cache, row.bridge.session)), 'agy wrote its schemas for the server');

    c.result();
    const two = await c.ask();
    assert.equal(two.r.status, 200, two.r.text);
    assert.equal(two.text, 'Weather: RESULT for Ankara', 'the result reached agy as the call\'s MCP result');
    assert.equal(two.calls.length, 0);
    assert.equal(two.finish, face === 'openai' ? 'stop' : 'end_turn');
    row = lastRow();
    assert.deepEqual([row.toolMode, row.bridge.path, row.bridge.turn, row.bridge.session], ['mcp', 'attached', 2, `ks${run.agent.slice(5, 11)}`]);
    assert.deepEqual([row.usage.input, row.usage.output], [1100, 30]);
    assert.equal(runsOf(t).length, 1, 'both turns on one agy process');
    assert.ok(await until(() => clean(groupOf(run.pid))), 'its agent file, its schema dir, agy, its helper and the shim: all gone');
  });
}

test('the agent file and the argv: a list of one MCP server (the shim, its socket and token), every tool eager, tool-less otherwise, no auto-approve', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  const [run] = runsOf(t);
  const agent = stub().find((e) => e.event === 'agent' && e.pid === run.pid);
  assert.equal(agent.mode, '600');
  for (const [k, v] of Object.entries({ tools: '[]', inheritMcp: 'false', inheritCustomizations: 'false', excludeDefaultComponents: 'true', hidden: 'true' })) assert.equal(agent.front[k], v, k);
  assert.ok(!('hooks' in agent.front));
  assert.equal(agent.server.command, process.execPath);
  assert.deepEqual(agent.server.args, [fileURLToPath(new URL('../src/bridge/shim.js', import.meta.url))]);
  assert.deepEqual(agent.server.env, ['KEYSMITH_BRIDGE_SOCK', 'KEYSMITH_BRIDGE_TOKEN']);
  assert.deepEqual(agent.server.tools, { get_weather: { eager: true } });
  const at = run.argv.indexOf('--agent');
  assert.equal(run.argv[at + 1], run.agent);
  assert.equal(run.printTimeout, '1800s', 'agy\'s own print timeout is the session\'s ceiling');
  assert.ok(!run.argv.includes('--mode') && !run.argv.includes('--conversation'));
  assert.deepEqual(run.argv.slice(-2, -1), ['-p']);
  const mcp = stub().find((e) => e.event === 'mcp' && e.pid === run.pid);
  assert.deepEqual([mcp.discover, mcp.protocolVersion], [-32601, '2025-11-25']);
  c.result();
  await c.ask();
});

test('three calls of one step: three HTTP turns, each handing out the next call, on one process', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Three cities. SCENARIO=three-calls ${t}` });
  const cities = [];
  let turn = await c.ask();
  for (let i = 0; i < 3; i++) {
    assert.equal(turn.r.status, 200, turn.r.text);
    assert.equal(turn.calls.length, 1, 'one call per HTTP turn');
    cities.push(turn.calls[0].args.city);
    assert.equal(lastRow().bridge.turn, i + 1);
    c.result();
    turn = await c.ask();
  }
  assert.deepEqual(cities, ['Ankara', 'Izmir', 'Bursa']);
  assert.equal(turn.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir; Bursa RESULT for Bursa');
  assert.equal(runsOf(t).length, 1);
});

test('a session that handed out maxTurns calls is closed at the next result, and the conversation goes on on a new one', async () => {
  const t = tag();
  const c = conversation('openai', { model: 'agy2/m', user: `Three cities. SCENARIO=three-calls ${t}` });
  let turn = await c.ask();
  c.result();
  turn = await c.ask();
  assert.equal(turn.calls[0].args.city, 'Izmir');
  const [first] = runsOf(t);
  c.result();
  turn = await c.ask();
  assert.equal(turn.text, 'From the history: RESULT for Ankara | RESULT for Izmir', 'the third turn ran on a new session, from the transcript');
  assert.equal(lastRow().bridge.path, 'cold');
  assert.equal(runsOf(t).length, 2);
  assert.ok(log.some((l) => /closed at maxTurns \(2 calls\)/.test(l)));
  assert.ok(await until(() => !alive(first.pid)));
});

test('a preamble stays in the answer that carries the call; harness-added arguments are taken off; a call the schema refuses is the model\'s to correct', async () => {
  let t = tag();
  let c = conversation('openai', { user: `Weather? SCENARIO=preamble ${t}` });
  let one = await c.ask();
  assert.equal(one.text, 'Let me check. ');
  assert.equal(one.calls[0].name, 'get_weather');
  c.result();
  await c.ask();
  t = tag();
  c = conversation('openai', { user: `Weather? SCENARIO=injected ${t}` });
  one = await c.ask();
  assert.deepEqual(one.calls[0].args, { city: 'Ankara' }, 'toolSummary and toolAction are agy\'s, not the client\'s');
  c.result();
  await c.ask();
  t = tag();
  c = conversation('openai', { user: `Weather? SCENARIO=self-correct ${t}` });
  one = await c.ask();
  assert.deepEqual(one.calls[0].args, { city: 'Ankara' });
  const [run] = runsOf(t);
  const refused = stub().find((e) => e.event === 'refused' && e.pid === run.pid);
  assert.match(refused.text, /not run: get_weather\.arguments\.city: expected string, got integer/);
  assert.ok(log.some((l) => /did not fit the client's schema \(1 of 3 this turn\)/.test(l)));
  c.result();
  await c.ask();
});

test('three calls the schema refuses in one turn fail the turn; auto answers the same request with EMULATE', async () => {
  const before = emuRuns().length;
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=invalid ${t}` });
  const one = await c.ask();
  assert.equal(one.r.status, 200, one.r.text);
  assert.equal(one.r.headers.get('x-keysmith-mode'), 'emulate');
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'invalid_calls']);
  assert.equal(emuRuns().length, before + 1);
  const [run] = runsOf(t);
  assert.ok(await until(() => clean([run.pid, shimOf(run.pid)])));
});

test('a client that never comes back: the session closes at toolResultTimeoutMs — process group stopped, files gone — and its late result is answered on the cold path', async () => {
  const t = tag();
  const c = conversation('openai', { model: 'agyt/m', user: `Weather? SCENARIO=one-call ${t}` });
  const one = await c.ask();
  assert.equal(one.calls.length, 1);
  const [run] = runsOf(t);
  const group = groupOf(run.pid);
  assert.ok(group.every(alive));
  assert.ok(await until(() => clean(group), 6000), 'the process group stopped and cleaned up after 1.2 s');
  assert.ok(log.some((l) => /bridge ks[0-9a-f]{6}: call 1 \(get_weather\) handed to the client/.test(l)));
  c.result();
  const late = await c.ask();
  assert.equal(late.r.status, 200, late.r.text);
  assert.equal(late.text, 'From the history: RESULT for Ankara', 'a new run, the conversation so far in its prompt');
  const runs = runsOf(t);
  assert.equal(runs.length, 2);
  assert.match(runs[1].prompt, /<<<TOOL_RESULT n=[0-9a-f]{8} id=call_[0-9a-f]{24} name=get_weather error=false>>>\nRESULT for Ankara\n<<<END [0-9a-f]{8}>>>/);
  assert.match(runs[1].prompt, /<assistant_tool_calls>/);
  assert.deepEqual([lastRow().toolMode, lastRow().bridge.path], ['mcp', 'cold']);
  assert.ok(log.some((l) => /a late result for agyt\/m \(its session is gone: expired\)/.test(l)));
  assert.ok(await until(() => clean([runs[1].pid])));
});

test('a client that leaves in the middle of a streamed turn: agy is stopped, the session gone', async () => {
  const t = tag();
  const ctrl = new AbortController();
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'agy/m', stream: true, tools: TOOLS, messages: [{ role: 'user', content: `Think. SCENARIO=text-then-hang ${t}` }] }),
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  let seen = '';
  while (!seen.includes('Thinking out loud')) {
    const { value, done } = await reader.read();
    assert.ok(!done, `the stream ended before the text: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  const [run] = runsOf(t);
  assert.ok(alive(run.pid));
  ctrl.abort();
  assert.ok(await until(() => clean(groupOf(run.pid))), 'the client left: agy, its helper and its shim were stopped');
});

test('a result sent with another key is not attached: that request is a new one, and the session waits for its own key', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  c.result();
  const [first] = runsOf(t);
  const other = await post('/v1/chat/completions', { model: 'agy/m', tools: TOOLS, messages: c.history }, OTHER);
  assert.equal(other.status, 200, other.text);
  assert.equal(json(other).choices[0].message.content, 'From the history: RESULT for Ankara', 'answered from the history, on a run of its own');
  assert.equal(lastRow().bridge.path, 'cold');
  assert.equal(runsOf(t).length, 2);
  assert.ok(alive(first.pid), 'the session of the key that made the call is untouched');
  const own = await c.ask();
  assert.equal(own.text, 'Weather: RESULT for Ankara');
  assert.equal(lastRow().bridge.path, 'attached');
});

test('a history whose user turns changed is not a continuation: the cold path, and the key\'s waiting session gives way', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  c.result();
  const [first] = runsOf(t);
  c.history[0].content += ' (edited)';
  const r = await c.ask();
  assert.equal(r.text, 'From the history: RESULT for Ankara');
  assert.equal(lastRow().bridge.path, 'cold');
  assert.ok(await until(() => !alive(first.pid)), 'one session per key: the old one was closed for the new one');
  assert.ok(log.some((l) => /closed to make room for a new session of the same key/.test(l)));
});

test('a second request for a result another request is answering: 409, and no other leg of the route is asked', async () => {
  const t = tag();
  const c = conversation('openai', { model: 'pair', user: `Weather? SCENARIO=slow-final ${t}` });
  await c.ask();
  c.result();
  const body = { model: 'pair', tools: TOOLS, messages: c.history };
  const first = post('/v1/chat/completions', body);
  await new Promise((r) => setTimeout(r, 300));
  const second = await post('/v1/chat/completions', body);
  assert.equal(second.status, 409, second.text);
  assert.match(json(second).error.message, /being answered by another request right now/);
  const done = await first;
  assert.equal(json(done).choices[0].message.content, 'Weather: RESULT for Ankara');
  assert.equal(runsOf(t).length, 1);
});

test('agy that cannot find the agent (rc=1), and one that never lists the tools: the same request is EMULATE, and the row says why', async () => {
  let before = emuRuns().length;
  let t = tag();
  let r = await post('/v1/chat/completions', { model: 'agy/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=unknown-agent ${t}` }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-keysmith-mode'), 'emulate');
  assert.deepEqual(json(r).choices[0].message.tool_calls.map((c) => c.function.arguments), ['{"city":"Ankara"}']);
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'unknown_agent']);
  assert.equal(emuRuns().length, before + 1);
  assert.ok(await until(() => clean()));

  before = emuRuns().length;
  t = tag();
  r = await post('/v1/chat/completions', { model: 'agyt/m', stream: true, tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=never-ready ${t}` }] });
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes('never-ready'));
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'ready_timeout']);
  assert.equal(emuRuns().length, before + 1);
  const [run] = runsOf(t);
  assert.ok(await until(() => clean([run.pid])), 'the run that never got ready was stopped');

  // agy that ran without reading the session's server (its default agent, say) answers in text
  // without ever listing the tools: that text is not the answer; EMULATE is.
  before = emuRuns().length;
  t = tag();
  r = await post('/v1/chat/completions', { model: 'agy/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=no-bridge ${t}` }] });
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes('no tools here'), 'nothing went out before the readiness gate');
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'not_ready']);
  assert.equal(emuRuns().length, before + 1);
});

test('a waiting session holds no process slot: with maxConcurrent 1, agy still answers a text request while a client runs its tool', async () => {
  const t = tag();
  const c = conversation('openai', { model: 'agys/m', user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  const ctrl = AbortSignal.timeout(8000);
  const r = await post('/v1/chat/completions', { model: 'agys/m', messages: [{ role: 'user', content: 'Hi. SCENARIO=plain' }] }, KEY, ctrl);
  assert.equal(json(r).choices[0].message.content, 'plain answer');
  c.result();
  assert.equal((await c.ask()).text, 'Weather: RESULT for Ankara');
});

test('agy reaching for a tool of its own: stopped, a 502, logged — and never retried as EMULATE (the tripwire)', async () => {
  const before = emuRuns().length;
  const t = tag();
  const r = await post('/v1/chat/completions', { model: 'agy/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=foreign ${t}` }] });
  assert.equal(r.status, 502, r.text);
  assert.match(json(r).error.message, /reached for a tool of its own \("run_command"\)/);
  assert.equal(emuRuns().length, before, 'a security event, not a slow engine');
  assert.deepEqual([lastRow().status, lastRow().toolMode, lastRow().fallback], ['error', 'mcp', undefined]);
  assert.ok(log.some((l) => /SECURITY: agy reached for a tool of its own \("run_command"\).*foreign tool/.test(l)));
  const [run] = runsOf(t);
  assert.ok(await until(() => clean([run.pid, shimOf(run.pid)])));
});

test('an answer followed by manage_task ends there (stopAtToolCall): the text stands, the row says cutAt', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=answer-then-manage-task ${t}` });
  await c.ask();
  c.result();
  const two = await c.ask();
  assert.equal(two.text, 'Weather: RESULT for Ankara');
  assert.equal(lastRow().cutAt, 'manage_task');
  const [run] = runsOf(t);
  assert.ok(await until(() => clean([run.pid])));
});

test('a tool name too long for mcp_ks<rid6>_ under Gemini\'s 64 is EMULATE\'s; so is a request with no room — and with toolMode mcp, no room is a 503', async () => {
  const long = 'x'.repeat(52);
  let before = stub().length;
  let r = await post('/v1/chat/completions', { model: 'agy/m', tools: [...TOOLS, { type: 'function', function: { name: long, parameters: { type: 'object' } } }], messages: [{ role: 'user', content: `Weather? ${tag()}` }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'name_too_long']);
  assert.equal(stub().length, before, 'no bridge run');
  assert.equal(agyDriver.prefix('ks000000').length + 51, 64, '51 characters still fit');

  // agym and agy1 take one session each; KEY's waits on each, OTHER finds them full.
  const hold = async (model, key) => {
    const c = conversation('openai', { model, key, user: `Weather? SCENARIO=one-call ${tag()}` });
    const one = await c.ask();
    assert.equal(one.calls.length, 1);
    return c;
  };
  const m = await hold('agym/m', KEY);
  r = await post('/v1/chat/completions', { model: 'agym/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=one-call ${tag()}` }] }, OTHER);
  assert.equal(r.status, 503, r.text);
  assert.equal(r.headers.get('retry-after'), '15');
  assert.match(json(r).error.message, /the MCP bridge cannot take this request \(bridge_full\)/);
  m.result();
  assert.equal((await m.ask()).text, 'Weather: RESULT for Ankara', 'a continuation needs no room of its own');

  const a = await hold('agy1/m', KEY);
  before = emuRuns().length;
  r = await post('/v1/chat/completions', { model: 'agy1/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=one-call ${tag()}` }] }, OTHER);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([lastRow().toolMode, lastRow().fallback], ['emulate', 'bridge_full']);
  assert.equal(emuRuns().length, before + 1);
  a.result();
  await a.ask();
});

test('the usage rows and the gateway log: names, counts and short session ids — never a token, an argument or a result', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  const [run] = runsOf(t);
  const text = fs.readFileSync(path.join(ws, '.agents', 'agents', `${run.agent}.md`), 'utf8');
  const token = text.match(/KEYSMITH_BRIDGE_TOKEN: "([^"]+)"/)[1];
  c.result(() => 'RESULT-MARKER-4f2a');
  const two = await c.ask();
  assert.equal(two.text, 'Weather: RESULT-MARKER-4f2a');
  const written = fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8') + '\n' + log.join('\n');
  for (const s of [token, token.slice(0, 16), 'RESULT-MARKER-4f2a', 'Ankara', KEY]) assert.ok(!written.includes(s), `${s.slice(0, 10)}… in ${written.split('\n').filter((l) => l.includes(s)).slice(0, 3).join('\n')}`);
  assert.ok(rows().some((r) => r.bridge?.session === `ks${run.agent.slice(5, 11)}`));
});

test('a NUL character in the conversation is a 400 that quotes none of it, before a file is written or a process started: the bridge, EMULATE and the text path alike', async () => {
  const before = stub().length;
  const emuBefore = emuRuns().length;
  const marker = `PROMPT-MARKER-${crypto.randomBytes(3).toString('hex')}`;
  for (const [model, extra] of [
    ['agym/m', { tools: TOOLS }], // the bridge (toolMode mcp)
    ['agy/m', { tools: TOOLS }], // auto: EMULATE would refuse it the same way, so it is not asked
    ['agy/m', { tools: TOOLS, tool_choice: 'required' }], // EMULATE
    ['agy/m', {}], // the text path
  ]) {
    const r = await post('/v1/chat/completions', { model, ...extra, messages: [{ role: 'user', content: `${marker} hello\u0000world SCENARIO=one-call` }] });
    assert.equal(r.status, 400, `${model} ${JSON.stringify(Object.keys(extra))}: ${r.text}`);
    assert.match(json(r).error.message, /a NUL character \(U\+0000\), which a command line cannot carry/);
    assert.ok(!r.text.includes(marker));
  }
  assert.equal(stub().length, before, 'no agy run was started');
  assert.equal(emuRuns().length, emuBefore);
  assert.ok(clean(), 'no session agent file was written');
  const written = fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8') + '\n' + log.join('\n');
  assert.ok(!written.includes(marker), written.split('\n').filter((l) => l.includes(marker)).slice(0, 2).join('\n'));
});

test('a CLI that cannot be started at all (spawn() throws at once): no agent file left, and the 502 names the error by its code', async () => {
  const r = await post('/v1/chat/completions', { model: 'agyz/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather? SCENARIO=one-call ${tag()}` }] });
  assert.equal(r.status, 502, r.text);
  assert.match(json(r).error.message, /could not start agy-bridge\.mjs \(ERR_INVALID_ARG_VALUE\)/);
  assert.ok(!r.text.includes('BROKEN'), 'what spawn() quoted stays out of the message');
  assert.ok(await until(() => clean()), 'the session\'s agent file (with its token) was removed');
  assert.equal(gateway.toolEngines.mcp.hub.stats().sessions, 0);
});

test('the start-up sweep: an earlier gateway\'s agent files and schema dirs older than an hour go, anything else stays', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ksbs-'));
  try {
    const adapter = new CliAdapter('agy', { ...agy('auto'), cwd: path.join(d, 'ws'), bridge: { ...CLI_PROFILES.agy.bridge, mcpCacheDir: path.join(d, 'cache') } });
    const agents = path.join(d, 'ws', '.agents', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
    const old = (p) => fs.utimesSync(p, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    for (const f of ['ks-b-aaaaaaaaaaaa.md', 'ks-b-bbbbbbbbbbbb.md', 'keysmith-tools.md', 'ks-b-mine.md']) fs.writeFileSync(path.join(agents, f), 'x');
    for (const n of ['ksaaaaaa', 'kscccccc', 'kscope', 'weather']) fs.mkdirSync(path.join(d, 'cache', n));
    for (const f of ['ks-b-aaaaaaaaaaaa.md', 'keysmith-tools.md', 'ks-b-mine.md']) old(path.join(agents, f));
    for (const n of ['ksaaaaaa', 'kscope', 'weather']) old(path.join(d, 'cache', n));
    const bridge = new McpBridge({ socketPath: path.join(d, 'b.sock'), adapters: () => [adapter], log: () => {} });
    await bridge.start();
    await bridge.close();
    assert.deepEqual(fs.readdirSync(agents).sort(), ['keysmith-tools.md', 'ks-b-bbbbbbbbbbbb.md', 'ks-b-mine.md'], 'an old ks-b-<rid> went; a fresh one, and names keysmith does not make, stayed');
    assert.deepEqual(fs.readdirSync(path.join(d, 'cache')).sort(), ['kscccccc', 'kscope', 'weather']);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the gateway closing (SIGTERM) stops every waiting session: process groups stopped, files gone, the socket removed', async () => {
  const t = tag();
  const c = conversation('openai', { user: `Weather? SCENARIO=one-call ${t}` });
  await c.ask();
  const [run] = runsOf(t);
  const group = groupOf(run.pid);
  assert.ok(group.every(alive));
  await gateway.close();
  assert.ok(await until(() => clean(group)));
  assert.ok(!fs.existsSync(path.join(dir, 'b.sock')));
  // Its result comes back after the restart: the cold path answers it.
  c.result();
  const r = await c.ask();
  assert.equal(r.text, 'From the history: RESULT for Ankara');
});
