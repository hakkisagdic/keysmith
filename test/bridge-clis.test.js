/**
 * The MCP bridge's drivers for opencode, codex, qoder (design U11) and claude: src/bridge/clis.js
 * behind the gateway's faces. The CLI is test/stubs/cli-bridge.mjs, which takes the session's MCP
 * server the way each CLI was seen to take it (opencode's OPENCODE_CONFIG, codex's
 * `-c mcp_servers.…`, qoder's and Claude Code's `--mcp-config`), starts it — the real shim, so the
 * hub is the real one — and prints that CLI's stream. Nothing here spends a token.
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
import { CliAdapter } from '../src/cli-adapter.js';
import { SESSION_DEFAULTS } from '../src/bridge/hub.js';
import { SHIM } from '../src/bridge/agy.js';
import { CLAUDE_BRIDGE_ARGS, claudeDriver, codexDriver, opencodeDriver, qoderDriver } from '../src/bridge/clis.js';
import { DRIVERS } from '../src/bridge/drivers.js';
import { claudeStreamJson, codexJson } from '../src/parsers.js';

const STUB = fileURLToPath(new URL('./stubs/cli-bridge.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/bridge-plans.json', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

let dir, server, base, gateway, usageLog;
const log = [];

/** A built-in profile around the stub: its bridge settings as shipped, toolMode mcp (a failure is the bridge's, never EMULATE's). */
function around(name, cli, { bridge = {}, ...extra } = {}) {
  const p = structuredClone(CLI_PROFILES[name]);
  return {
    ...p,
    bin: STUB,
    cwd: path.join(dir, `ws-${name}`),
    toolMode: 'mcp',
    bridge: { ...p.bridge, readyTimeoutMs: 10_000, toolResultTimeoutMs: 60_000, ...bridge },
    env: { STUB_CLI: cli, CLI_BRIDGE_LOG: path.join(dir, 'bridge.jsonl') },
    timeoutMs: 20_000,
    maxConcurrent: 4,
    ...extra,
  };
}
/** The `--settings` Claude Code's bridge argv is given. */
const CLAUDE_SETTINGS = CLAUDE_BRIDGE_ARGS[CLAUDE_BRIDGE_ARGS.indexOf('--settings') + 1];
const NO_APPROVAL = (args) => args.filter((a, i) => !(a === '-c' && /default_tools_approval_mode/.test(args[i + 1] || '')) && !/default_tools_approval_mode/.test(a));

before(async () => {
  // os.tmpdir(): the socket's path must stay under 103 bytes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksbx-'));
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 300, streamKeepaliveMs: 60, bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 6, maxSessionsPerKey: 6 } },
    adapters: {
      oc: around('opencode', 'opencode'),
      cx: around('codex', 'codex'),
      cxna: around('codex', 'codex', { bridge: { args: NO_APPROVAL(CLI_PROFILES.codex.bridge.args) } }),
      // The codex profile with a catalogue of its own (declared models, with the levels each takes).
      cxe: around('codex', 'codex', { models: [{ id: 'm', efforts: ['low', 'high'] }], cwd: path.join(dir, 'ws-codex-e') }),
      qd: around('qoder', 'qoder'),
      // Claude Code's profile as shipped (explicit-only, toolMode auto made mcp here), with a catalogue of its own.
      cc: around('claude', 'claude', { models: [{ id: 'm', efforts: ['low', 'high'] }] }),
      oct: around('opencode', 'opencode', { bridge: { toolResultTimeoutMs: 1_200 }, cwd: path.join(dir, 'ws-opencode-t') }),
      // Claude Code's profile with a short clock: a client that never comes back.
      cct: around('claude', 'claude', { bridge: { toolResultTimeoutMs: 1_200 }, cwd: path.join(dir, 'ws-claude-t'), models: [{ id: 'm', efforts: ['low', 'high'] }] }),
      // An entry copied from the profile before auto-memory was off in its argv, with a cap of its own.
      ccx: around('claude', 'claude', { bridge: { args: CLAUDE_BRIDGE_ARGS.map((a) => (a === CLAUDE_SETTINGS ? '{"disableAllHooks":true}' : a)) }, cwd: path.join(dir, 'ws-claude-x'), maxPromptChars: 300_000, models: [{ id: 'm' }] }),
      // An entry whose cap was raised past Claude Code's own ceiling for a tool's _meta (500,000).
      ccw: around('claude', 'claude', { cwd: path.join(dir, 'ws-claude-w'), maxPromptChars: 600_000, models: [{ id: 'm' }] }),
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

/* ------------------------------------------------------------------------- helpers */

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }];
const A_TOOLS = [{ name: 'get_weather', description: 'Weather', input_schema: TOOLS[0].function.parameters }];

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stub = () => lines(path.join(dir, 'bridge.jsonl'));
const startsOf = (tag) => stub().filter((e) => e.event === 'start' && e.argv.at(-1).includes(tag));
const eventsOf = (pid) => stub().filter((e) => e.pid === pid);
const rowsOf = (model) => usageLog.tail(500).filter((r) => r.model === model).reverse();
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
const sessionFiles = (name) => {
  const d = path.join(dir, `ws-${name}`, '.keysmith-bridge');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};
/** Close every session a test left waiting (its client never came back), and wait for their CLIs to go. */
async function closeAll() {
  const hub = gateway.toolEngines.mcp.hub;
  await Promise.all([...hub.sessions.values()].map((s) => s.close('test_done')));
}
let tags = 0;
const tag = () => `#x${++tags}-${crypto.randomBytes(3).toString('hex')}`;

/** One chat-completions answer as the OpenAI SDK reads it. */
function chat(r) {
  const c = JSON.parse(r.text).choices[0];
  return { text: c.message.content || '', calls: (c.message.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, args: JSON.parse(t.function.arguments) })), finish: c.finish_reason };
}

/** A conversation on /v1/chat/completions: `ask()` sends it, `results()` answers every call of the last answer. */
function conversation(model, user, extra = {}) {
  const history = [{ role: 'user', content: user }];
  let last = null;
  return {
    history,
    async ask() {
      const r = await post('/v1/chat/completions', { model, tools: TOOLS, messages: history, ...extra });
      last = r.status === 200 ? chat(r) : null;
      return { r, ...(last || {}) };
    },
    results(textFor = (c) => `RESULT for ${c.args.city}`) {
      history.push({ role: 'assistant', content: last.text || null, tool_calls: last.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
      for (const c of last.calls) history.push({ role: 'tool', tool_call_id: c.id, content: textFor(c) });
    },
  };
}

const sse = (text) => text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).filter((l) => l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));

/**
 * One answer on any face, streamed or not, as its SDK reads it: the text and the calls. `face` is
 * chat, messages or responses.
 */
function answerOf(face, stream, r) {
  if (face === 'chat') {
    if (!stream) return chat(r);
    const calls = [];
    let text = '';
    for (const e of sse(r.text)) {
      const d = e.choices?.[0]?.delta || {};
      if (d.content) text += d.content;
      for (const tc of d.tool_calls || []) {
        if (tc.id) calls[tc.index] = { id: tc.id, name: tc.function.name, arguments: '' };
        calls[tc.index].arguments += tc.function?.arguments || '';
      }
    }
    return { text, calls: calls.map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.arguments) })) };
  }
  if (face === 'messages') {
    let blocks;
    if (!stream) blocks = JSON.parse(r.text).content;
    else {
      blocks = [];
      for (const e of sse(r.text)) {
        if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block, json: '' };
        else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') blocks[e.index].text += e.delta.text;
        else if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') blocks[e.index].json += e.delta.partial_json;
      }
      for (const b of blocks) if (b.type === 'tool_use') b.input = JSON.parse(b.json);
    }
    return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })) };
  }
  const output = stream ? sse(r.text).find((e) => e.type === 'response.completed').response.output : JSON.parse(r.text).output;
  return { output, text: output.filter((o) => o.type === 'message').map((o) => o.content.map((c) => c.text).join('')).join(''), calls: output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, args: JSON.parse(o.arguments) })) };
}

/** A two-turn round trip on any face: the first answer, and the one after its calls' results. */
async function roundTrip(face, stream, model, user, textFor = (c) => `RESULT for ${c.args.city}`) {
  const route = { chat: '/v1/chat/completions', messages: '/v1/messages', responses: '/v1/responses' }[face];
  const first = [{ role: 'user', content: user }];
  const body = (history) =>
    face === 'chat' ? { model, stream, tools: TOOLS, messages: history }
    : face === 'messages' ? { model, stream, max_tokens: 256, tools: A_TOOLS, messages: history }
    : { model, stream, store: false, tools: [{ type: 'function', ...TOOLS[0].function }], input: history };
  const r1 = await post(route, body(first));
  assert.equal(r1.status, 200, r1.text);
  const a1 = answerOf(face, stream, r1);
  const history = [...first];
  if (face === 'chat') {
    history.push({ role: 'assistant', content: a1.text || null, tool_calls: a1.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    for (const c of a1.calls) history.push({ role: 'tool', tool_call_id: c.id, content: textFor(c) });
  } else if (face === 'messages') {
    history.push({ role: 'assistant', content: [...(a1.text ? [{ type: 'text', text: a1.text }] : []), ...a1.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] });
    history.push({ role: 'user', content: a1.calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: textFor(c) })) });
  } else {
    history.push(...a1.output);
    for (const c of a1.calls) history.push({ type: 'function_call_output', call_id: c.id, output: textFor(c) });
  }
  const r2 = await post(route, body(history));
  assert.equal(r2.status, 200, r2.text);
  return [a1, answerOf(face, stream, r2)];
}

/* ------------------------------------------------------------------- golden plans */

/** A session as the hub makes one, with fixed values. */
function fakeSession() {
  return { rid: '0123456789ab', server: 'ks012345', token: 'TOKEN-0123', env: { KEYSMITH_BRIDGE_SOCK: '/run/keysmith/bridge.sock', KEYSMITH_BRIDGE_TOKEN: 'TOKEN-0123' }, limits: { ...SESSION_DEFAULTS } };
}
/** What a driver would start for the fake session, with the machine's own paths written as <NODE>, <SHIM> and <CWD>. */
function planOf(driver, cfg) {
  const adapter = new CliAdapter(driver.id, { ...cfg, cwd: '/ws/' + driver.id, toolMode: cfg.toolMode === 'off' ? 'off' : 'mcp' });
  const p = driver.plan(adapter, { session: fakeSession(), model: 'm1', prompt: 'PROMPT' });
  const norm = (s) => s.split(process.execPath).join('<NODE>').split(SHIM).join('<SHIM>').split(adapter.cwd).join('<CWD>');
  const env = Object.fromEntries(['OPENCODE_CONFIG', 'PWD', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'].filter((k) => p.env[k] !== undefined).map((k) => [k, norm(p.env[k])]));
  return {
    argv: p.argv.map(norm),
    files: p.files.map(({ file, content }) => ({ file: norm(file), content: /\.json$/.test(file) ? JSON.parse(norm(content)) : norm(content) })),
    env,
  };
}

test('golden: what each driver starts for one session — the argv, the session\'s files and the env — matches the reviewed plan', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const plans = {
    opencode: planOf(opencodeDriver, CLI_PROFILES.opencode),
    codex: planOf(codexDriver, CLI_PROFILES.codex),
    qoder: planOf(qoderDriver, CLI_PROFILES.qoder),
    claude: planOf(claudeDriver, CLI_PROFILES.claude),
  };
  for (const name of Object.keys(plans)) assert.deepEqual(plans[name], golden[name], `${name}: the plan changed — review it, then the fixture`);
  // What the plans must hold, whatever the fixture says.
  const oc = plans.opencode.files[0].content;
  assert.deepEqual(oc.permission, { '*': 'deny', 'ks012345_*': 'allow' });
  assert.deepEqual(oc.agent['ks-b-0123456789ab'].tools, { '*': false, 'ks012345_*': true });
  assert.ok(oc.mcp.ks012345.timeout > SESSION_DEFAULTS.toolResultTimeoutMs, 'opencode waits on a call longer than keysmith does');
  assert.deepEqual(oc.plugin, []);
  const cx = plans.codex.argv;
  assert.ok(!cx.some((a) => a.includes('TOKEN-0123')), 'codex: no token in the argv');
  assert.ok(cx.includes('mcp_servers.ks012345.default_tools_approval_mode="approve"'));
  assert.equal(cx.filter((a) => /approval/.test(a)).length, 2, 'the server\'s approval and approval_policy "never", nothing else');
  assert.ok(cx.includes('--disable') && cx.includes('shell_tool') && cx.includes('--ephemeral') && cx.includes('--json'));
  assert.ok(Number(cx.find((a) => a.startsWith('mcp_servers.ks012345.tool_timeout_sec=')).split('=')[1]) * 1000 > SESSION_DEFAULTS.toolResultTimeoutMs);
  for (const name of ['qoder', 'claude']) {
    const argv = plans[name].argv;
    assert.equal(argv[argv.indexOf('--tools') + 1], '', `${name}: no built-in tool`);
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.equal(argv[argv.indexOf(name === 'claude' ? '--allowedTools' : '--allowed-tools') + 1], 'mcp__ks012345');
    assert.equal(JSON.parse(argv[argv.indexOf('--settings') + 1]).disableAllHooks, true, `${name}: no hooks`);
    assert.ok(!argv.some((a) => a.includes('TOKEN-0123')), `${name}: the token is in the 0600 file, not the argv`);
  }
  assert.ok(!plans.claude.argv.includes('--safe-mode'), 'claude: --safe-mode would turn the MCP server off');
  const cc = plans.claude.argv;
  assert.deepEqual(JSON.parse(cc[cc.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false }, 'claude: no hooks, no auto-memory (--setting-sources "" leaves it on)');
  assert.equal(plans.claude.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'claude: auto-memory off in its environment too, whatever an entry\'s argv says');
  assert.equal(cc[cc.indexOf('--setting-sources') + 1], '', 'claude: no settings file and no CLAUDE.md (`project` read the parent directories\' CLAUDE.md)');
  assert.equal(cc[cc.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(cc.includes('--no-session-persistence') && cc.includes('--disable-slash-commands'));
});

test('every session file is 0600 in a 0700 directory of the workspace; qoder\'s run gets no QODER_* variable, opencode\'s gets OPENCODE_CONFIG', async () => {
  const saved = { QODER_MCP_LAZY: process.env.QODER_MCP_LAZY, QODER_AGENT_SDK_ENTRYPOINT: process.env.QODER_AGENT_SDK_ENTRYPOINT };
  process.env.QODER_MCP_LAZY = '1';
  process.env.QODER_AGENT_SDK_ENTRYPOINT = 'stub';
  try {
    for (const id of ['oc', 'qd']) {
      const t = tag();
      const c = conversation(`${id}/m`, `Weather? ${t} SCENARIO=hang-after-call`);
      const a = await c.ask();
      assert.equal(a.r.status, 200, a.r.text);
      const [start] = startsOf(t);
      const cfg = eventsOf(start.pid).find((e) => e.event === 'config');
      if (id === 'qd') {
        assert.deepEqual(start.qoderEnv, [], 'every inherited QODER_* is left out');
        assert.equal(cfg.mode, '600');
      } else {
        assert.match(start.opencodeConfig, /\.keysmith-bridge\/ks-b-[0-9a-f]{12}\.json$/);
        assert.equal(cfg.mode, '600');
        assert.ok(start.qoderEnv.includes('QODER_MCP_LAZY'), 'only qoder\'s run drops them');
        assert.ok(!start.qoderEnv.includes('QODER_AGENT_SDK_ENTRYPOINT'), 'agentCleanEnv drops the entrypoint marker for every CLI');
      }
      const d = path.join(dir, `ws-${id === 'oc' ? 'opencode' : 'qoder'}`, '.keysmith-bridge');
      assert.equal(fs.statSync(d).mode & 0o777, 0o700);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    await closeAll();
  }
});

/* --------------------------------------------------------------------------- opencode */

test('opencode: two calls of one step go out in one answer, their results back into the same process, and nothing is left after', async () => {
  const t = tag();
  const c = conversation('oc/m', `Two cities ${t} SCENARIO=two-calls`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.equal(a1.r.headers.get('x-keysmith-mode'), 'mcp');
  assert.equal(a1.finish, 'tool_calls');
  assert.equal(a1.text, 'Checking both cities. ', 'the text before the calls stays in their answer');
  assert.deepEqual(a1.calls.map((x) => x.args.city).sort(), ['Ankara', 'Izmir'], 'both calls in one answer');
  assert.equal(new Set(a1.calls.map((x) => x.id)).size, 2);
  const [start] = startsOf(t);
  assert.ok(alive(start.pid), 'opencode waits on both calls');
  c.results();
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(a2.text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir', 'each result went to its own call');
  assert.equal(startsOf(t).length, 1, 'one process for both turns');
  assert.ok(await until(() => !alive(start.pid) && !sessionFiles('opencode').length), 'the run ended and its file is gone');
  const rows = rowsOf('oc/m').slice(-2);
  assert.deepEqual(rows.map((r) => [r.toolMode, r.toolCalls ?? 0, r.bridge?.path, r.bridge?.turn]), [['mcp', 2, 'new', 1], ['mcp', 0, 'attached', 2]]);
});

test('opencode: the text before a call is that answer\'s, and the whole text after the result is the next one\'s — on every face, streamed or not', async () => {
  // One opencode process (and one parser) carries both turns; opencode prints each text part whole,
  // once, and the answer after the result is longer than the text before the call.
  for (const face of ['chat', 'messages', 'responses']) {
    for (const stream of [false, true]) {
      const t = tag();
      const [a1, a2] = await roundTrip(face, stream, 'oc/m', `Weather ${t} SCENARIO=one-call`);
      const at = `${face}${stream ? ', streamed' : ''}`;
      assert.equal(a1.text, 'Let me check. ', at);
      assert.deepEqual(a1.calls.map((c) => c.args), [{ city: 'Ankara' }], at);
      assert.equal(a2.text, 'Weather: RESULT for Ankara', at);
      assert.deepEqual(a2.calls, [], at);
      assert.equal(startsOf(t).length, 1, `${at}: one process for both turns`);
      assert.equal(rowsOf('oc/m').at(-1).bridge.path, 'attached', at);
    }
  }
  // An answer after the result exactly as long as the text before the call.
  const t = tag();
  const [, same] = await roundTrip('chat', false, 'oc/m', `Weather ${t} SCENARIO=one-call`, () => 'abcde');
  assert.equal('Weather: abcde'.length, 'Let me check. '.length);
  assert.equal(same.text, 'Weather: abcde');
});

test('opencode: a request that answers one of the two calls out is no continuation — the cold path, and the waiting session is not written to', async () => {
  const t = tag();
  const c = conversation('oc/m', `Two cities ${t} SCENARIO=two-calls`);
  const a1 = await c.ask();
  assert.equal(a1.calls.length, 2);
  const [start] = startsOf(t);
  c.results();
  c.history.pop(); // the second call's result left out
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(rowsOf('oc/m').at(-1).bridge.path, 'cold');
  assert.equal(a2.text, `From the history: RESULT for ${a1.calls[0].args.city}`);
  assert.ok(!eventsOf(start.pid).some((e) => e.event === 'result'), 'the waiting run got no result');
  await closeAll();
  // A client that writes the two calls as two assistant turns, each with its result: the history's
  // calls are the session's, in order, but its last turn holds one of the two calls out — not the
  // session's continuation either: giving it that one result would leave the other call
  // unanswered in a process nobody comes back to.
  const t2 = tag();
  const d = conversation('oc/m', `Two cities ${t2} SCENARIO=two-calls`);
  const b1 = await d.ask();
  assert.equal(b1.calls.length, 2);
  const [start2] = startsOf(t2);
  for (const call of b1.calls) {
    d.history.push({ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'get_weather', arguments: JSON.stringify(call.args) } }] });
    d.history.push({ role: 'tool', tool_call_id: call.id, content: `SPLIT for ${call.args.city}` });
  }
  const b2 = await d.ask();
  assert.equal(b2.r.status, 200, b2.r.text);
  assert.equal(rowsOf('oc/m').at(-1).bridge.path, 'cold');
  assert.match(b2.text, /From the history: SPLIT for .* \| SPLIT for /);
  assert.ok(!eventsOf(start2.pid).some((e) => e.event === 'result'), 'the waiting run got no result');
  await closeAll();
});

test('opencode, parallel_tool_calls false: the step\'s two calls go out one per answer, the second waiting in the session', async () => {
  const t = tag();
  const c = conversation('oc/m', `Two cities ${t} SCENARIO=two-calls`, { parallel_tool_calls: false });
  const a1 = await c.ask();
  assert.equal(a1.calls.length, 1);
  c.results();
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(a2.calls.length, 1, 'the other call, without a new model turn');
  assert.notEqual(a2.calls[0].args.city, a1.calls[0].args.city);
  c.results();
  const a3 = await c.ask();
  assert.match(a3.text, /RESULT for Ankara.*RESULT for Izmir/);
  assert.equal(startsOf(t).length, 1);
});

test('opencode: both calls on /v1/messages, streamed — two tool_use blocks in one answer', async () => {
  const t = tag();
  const r = await post('/v1/messages', { model: 'oc/m', stream: true, max_tokens: 256, tools: A_TOOLS, messages: [{ role: 'user', content: `Two ${t} SCENARIO=two-calls` }] });
  const events = r.text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const uses = events.filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.equal(uses.length, 2);
  assert.ok(uses.every((u) => /^toolu_[0-9a-f]{24}$/.test(u.content_block.id)));
  assert.equal(events.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
  await closeAll(); // its client does not come back
});

test('opencode: its own `invalid` tool (a call to a tool it does not have) is no foreign tool — the run goes on to the bridge call', async () => {
  const c = conversation('oc/m', `Weather ${tag()} SCENARIO=invalid-tool`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.deepEqual(a1.calls.map((x) => x.args), [{ city: 'Ankara' }]);
  c.results();
  assert.equal((await c.ask()).text, 'Weather: RESULT for Ankara');
});

/* ------------------------------------------------------------------------------ codex */

test('codex: the preamble, then the call shown before it is sent; the result back to the same process; the token never in its argv', async () => {
  const t = tag();
  const c = conversation('cx/m', `Weather ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.equal(a1.text, 'Let me check. ', 'text before the call stays in its answer');
  assert.deepEqual(a1.calls.map((x) => [x.name, x.args]), [['get_weather', { city: 'Ankara' }]]);
  const [start] = startsOf(t);
  const cfg = eventsOf(start.pid).find((e) => e.event === 'server');
  assert.deepEqual(cfg.server.env.sort(), ['KEYSMITH_BRIDGE_SOCK', 'KEYSMITH_BRIDGE_TOKEN_FILE']);
  assert.equal(cfg.server.approve, true);
  const token = fs.readFileSync(path.join(dir, 'ws-codex', '.keysmith-bridge', sessionFiles('codex').find((f) => f.endsWith('.token'))), 'utf8').trim();
  assert.ok(token.length > 30);
  assert.ok(!start.argv.some((a) => a.includes(token)), 'the token is in a 0600 file the shim reads, not on the command line');
  c.results();
  const a2 = await c.ask();
  assert.equal(a2.text, 'Weather: RESULT for Ankara');
  assert.equal(startsOf(t).length, 1);
  assert.ok(await until(() => !alive(start.pid) && !sessionFiles('codex').length));
  assert.ok(rowsOf('cx/m').at(-1).usage?.input > 0, 'the run\'s usage from turn.completed');
});

test('codex: the answer that hands a call out has no count of its own (codex reports at the run\'s end): null with the reason, never 0; the answer that ends the session carries the whole run', async () => {
  const t = tag();
  const c = conversation('cx/m', `Usage ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  const u1 = JSON.parse(a1.r.text).usage;
  assert.deepEqual([u1.prompt_tokens, u1.completion_tokens, u1.total_tokens], [null, null, null]);
  assert.match(u1.reason, /^cx reports a run's tokens once, when the run ends/);
  const row1 = rowsOf('cx/m').at(-1);
  assert.equal(row1.usage, null);
  assert.match(row1.usageReason, /when the run ends/);
  c.results();
  const a2 = await c.ask();
  const u2 = JSON.parse(a2.r.text).usage;
  // The stub's turn.completed: 1100 in (the cached ones included), 30 out — the session's whole spend.
  assert.deepEqual([u2.prompt_tokens, u2.completion_tokens, u2.total_tokens], [1100, 30, 1130]);
  assert.equal(u2.reason, undefined);
  assert.deepEqual(rowsOf('cx/m').at(-1).usage, { input: 1100, output: 30, cacheRead: 0, cacheWrite: 0 });
});

test('codex: a bridge session keeps the effort it started at — spelled in the field or in the model id alike; a continuation at another effort is a new session, the cold path', async () => {
  const t = tag();
  // Started as `m-high`, continued as `m` with reasoning_effort high: one model, one effort, one session.
  const first = [{ role: 'user', content: `Effort ${t}` }];
  let r = await post('/v1/chat/completions', { model: 'cxe/m-high', tools: TOOLS, messages: first });
  assert.equal(r.status, 200, r.text);
  const a1 = chat(r);
  const [start] = startsOf(t);
  assert.ok(start.argv.includes('model_reasoning_effort="high"'), 'the session\'s CLI runs at the effort');
  assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'm', 'the base model, the suffix read off');
  const history = [...first, { role: 'assistant', content: a1.text, tool_calls: a1.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, ...a1.calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: `RESULT for ${c.args.city}` }))];
  r = await post('/v1/chat/completions', { model: 'cxe/m', reasoning_effort: 'high', tools: TOOLS, messages: history });
  assert.equal(r.status, 200, r.text);
  assert.equal(chat(r).text, 'Weather: RESULT for Ankara');
  assert.equal(startsOf(t).length, 1);
  assert.equal(rowsOf('cxe/m').at(-1).bridge.path, 'attached');
  assert.equal(rowsOf('cxe/m').at(-1).effort, 'high');

  // Started at high, continued at low: the waiting session is not that conversation's any more.
  const t2 = tag();
  const c = conversation('cxe/m', `Effort ${t2}`, { reasoning_effort: 'high' });
  await c.ask();
  c.results();
  r = await post('/v1/chat/completions', { model: 'cxe/m', reasoning_effort: 'low', tools: TOOLS, messages: c.history });
  assert.equal(r.status, 200, r.text);
  assert.match(chat(r).text, /^From the history: RESULT for Ankara/);
  const starts = startsOf(t2);
  assert.equal(starts.length, 2, 'a new session, with the conversation so far');
  assert.ok(starts[1].argv.includes('model_reasoning_effort="low"'));
  assert.equal(rowsOf('cxe/m').at(-1).bridge.path, 'cold');
  assert.ok(log.some((m) => /bridge ks[0-9a-f]+: opened for cxe\/m, with the conversation so far \(the effort changed\)/.test(m)));
  await closeAll();
});

test('codex: two calls of one step come one after the other, so they go out on two turns of one process', async () => {
  const t = tag();
  const c = conversation('cx/m', `Two ${t} SCENARIO=two-calls`);
  const a1 = await c.ask();
  assert.deepEqual(a1.calls.map((x) => x.args.city), ['Ankara']);
  c.results();
  const a2 = await c.ask();
  assert.deepEqual(a2.calls.map((x) => x.args.city), ['Izmir']);
  c.results();
  assert.equal((await c.ask()).text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir');
  assert.equal(startsOf(t).length, 1);
});

test('codex without its server approved: the call never reaches keysmith (approval_policy "never" refuses it), so the profile approves that server — and only that one', async () => {
  const t = tag();
  const r = await post('/v1/chat/completions', { model: 'cxna/m', tools: TOOLS, messages: [{ role: 'user', content: `Weather ${t}` }] });
  assert.equal(r.status, 200, r.text);
  const a = chat(r);
  assert.deepEqual(a.calls, [], 'nothing reached the client');
  assert.match(a.text, /could not reach the weather tool/);
  const [start] = startsOf(t);
  assert.ok(eventsOf(start.pid).some((e) => e.event === 'refused'));
  assert.ok(!eventsOf(start.pid).some((e) => e.event === 'result'), 'no tools/call was made');
  // The shipped argv approves the session's server by its placeholder; the load check refuses
  // any other approval.
  const args = CLI_PROFILES.codex.bridge.args;
  assert.ok(args.includes('mcp_servers.{server}.default_tools_approval_mode="approve"'));
  const load = (bridgeArgs) => checkAdapter('codex', { ...CLI_PROFILES.codex, cwd: dir, bridge: { driver: 'codex', args: bridgeArgs } });
  assert.throws(() => load([...args, '-c', 'default_tools_approval_mode="approve"']), /approve the session's own MCP server only/);
  assert.throws(() => load([...args, '-c', 'mcp_servers.other.default_tools_approval_mode="approve"']), /approve the session's own MCP server only/);
  assert.throws(() => load([...args, '-c', 'approval_policy="on-request"']), /approval_policy/);
  assert.doesNotThrow(() => load(args));
});

/* ------------------------------------------------------------------------------ qoder */

test('qoder: the call shown in its assistant message, the result back into the same process; through qoder\'s lazy mcp_call too', async () => {
  for (const scenario of ['one-call', 'lazy']) {
    const t = tag();
    const c = conversation('qd/m', `Weather ${t} SCENARIO=${scenario}`);
    const a1 = await c.ask();
    assert.equal(a1.r.status, 200, a1.r.text);
    assert.deepEqual(a1.calls.map((x) => [x.name, x.args]), [['get_weather', { city: 'Ankara' }]], scenario);
    c.results();
    const a2 = await c.ask();
    assert.equal(a2.text, 'Weather: RESULT for Ankara', scenario);
    const [start] = startsOf(t);
    const cfg = eventsOf(start.pid).find((e) => e.event === 'config');
    assert.deepEqual([cfg.strict, cfg.allowed, cfg.sources, cfg.settings], [true, `mcp__${eventsOf(start.pid).find((e) => e.event === 'server').server.name}`, 'project', '{"disableAllHooks":true}']);
    assert.equal(startsOf(t).length, 1);
  }
  assert.ok(await until(() => !sessionFiles('qoder').length));
});

/* ----------------------------------------------------------------------------- claude */

test('claude: a two-turn round trip on every face, streamed or not — the call shown in its assistant message before it runs, the result back into the same process', async () => {
  for (const face of ['chat', 'messages', 'responses']) {
    for (const stream of [false, true]) {
      const t = tag();
      const [a1, a2] = await roundTrip(face, stream, 'cc/m', `Weather ${t}`);
      const at = `${face}${stream ? ', streamed' : ''}`;
      assert.equal(a1.text, 'Let me check. ', at);
      assert.deepEqual(a1.calls.map((x) => [x.name, x.args]), [['get_weather', { city: 'Ankara' }]], at);
      assert.equal(a2.text, 'Weather: RESULT for Ankara', at);
      assert.deepEqual(a2.calls, [], at);
      assert.equal(startsOf(t).length, 1, `${at}: one Claude Code process for both turns`);
      assert.deepEqual(rowsOf('cc/m').slice(-2).map((r) => [r.toolMode, r.bridge?.path]), [['mcp', 'new'], ['mcp', 'attached']], at);
    }
  }
  assert.ok(await until(() => !sessionFiles('claude').length), 'nothing left after');
});

test('claude: what its run is given — the session\'s server alone, allowed; no built-in tool, no settings file, no prompt, no session on disk; the token in a 0600 file; Claude Code\'s own clock past keysmith\'s', async () => {
  const t = tag();
  const c = conversation('cc/m', `Weather ${t}`, { reasoning_effort: 'high' });
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  const [start] = startsOf(t);
  const cfg = eventsOf(start.pid).find((e) => e.event === 'config');
  const server = eventsOf(start.pid).find((e) => e.event === 'server').server.name;
  assert.deepEqual(
    [cfg.mode, cfg.strict, cfg.allowed, cfg.tools, cfg.prompts, cfg.sources, cfg.settings, cfg.safeMode, cfg.persist, cfg.effort],
    ['600', true, `mcp__${server}`, '', 'none', '', '{"disableAllHooks":true,"autoMemoryEnabled":false}', false, false, 'high'],
  );
  assert.equal(cfg.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'no auto-memory: no MEMORY.md and no "keep memories with Write" in its prompt');
  assert.equal(Number(cfg.env.MCP_TOOL_TIMEOUT), 60_000 + 30_000, 'Claude Code waits on a call 30 s past toolResultTimeoutMs');
  assert.equal(cfg.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(cfg.env.CLAUDECODE, null, 'no marker of a Claude Code session the gateway was started in');
  const file = sessionFiles('claude').find((f) => f.endsWith('.mcp.json'));
  const token = JSON.parse(fs.readFileSync(path.join(dir, 'ws-claude', '.keysmith-bridge', file), 'utf8')).mcpServers[server].env.KEYSMITH_BRIDGE_TOKEN;
  assert.ok(token.length > 30);
  assert.ok(!start.argv.some((a) => a.includes(token)), 'the token is in the 0600 file, never the argv');
  c.results();
  const a2 = await c.ask();
  assert.equal(a2.text, 'Weather: RESULT for Ankara');
  assert.equal(rowsOf('cc/m').at(-1).effort, 'high');
});

test('claude: each answer reports its own share of the run — the step that made the call, then the run\'s total less it; a step\'s second call has no tokens of its own (null, with why)', async () => {
  let t = tag();
  const c = conversation('cc/m', `Usage ${t}`);
  const a1 = await c.ask();
  const u1 = JSON.parse(a1.r.text).usage;
  // Message 1's start: 10 uncached + 100 written + 1000 read; its output count is Claude Code's first.
  assert.deepEqual([u1.prompt_tokens, u1.prompt_tokens_details.cached_tokens, u1.completion_tokens], [1110, 1000, 1]);
  c.results();
  const a2 = await c.ask();
  const u2 = JSON.parse(a2.r.text).usage;
  // The result line: 30 + 300 + 2000 in, 30 out, for the whole run — less what the first answer said.
  assert.deepEqual([u2.prompt_tokens, u2.prompt_tokens_details.cached_tokens, u2.completion_tokens], [1220, 1000, 29]);
  assert.deepEqual(rowsOf('cc/m').slice(-2).map((r) => r.usage), [{ input: 1110, output: 1, cacheRead: 1000, cacheWrite: 100 }, { input: 1220, output: 29, cacheRead: 1000, cacheWrite: 200 }]);

  t = tag();
  const d = conversation('cc/m', `Two ${t} SCENARIO=two-calls`);
  assert.deepEqual((await d.ask()).calls.map((x) => x.args.city), ['Ankara']);
  d.results();
  const second = await d.ask();
  assert.deepEqual(second.calls.map((x) => x.args.city), ['Izmir'], 'Claude Code runs a step\'s calls one after the other: one per answer');
  const su = JSON.parse(second.r.text).usage;
  assert.equal(su.prompt_tokens, null);
  assert.match(su.reason, /no model step of cc reported tokens in this turn/);
  d.results();
  assert.equal((await d.ask()).text, 'Ankara RESULT for Ankara; Izmir RESULT for Izmir');
  assert.equal(startsOf(t).length, 1);
});

test('claude: the request\'s own tools may be named like Claude Code\'s built-ins (Bash, Read) — each reaches the client by its own name, one per answer, and none of them is the tripwire', async () => {
  const builtinNamed = [
    { type: 'function', function: { name: 'Bash', description: 'Runs a command on the client', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'Read', description: 'Reads a file on the client', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  ];
  const t = tag();
  const history = [{ role: 'user', content: `List ${t} SCENARIO=builtin-names` }];
  const ask = async () => {
    const r = await post('/v1/chat/completions', { model: 'cc/m', tools: builtinNamed, messages: history });
    assert.equal(r.status, 200, r.text);
    return chat(r);
  };
  const answer = (a, text) => {
    history.push({ role: 'assistant', content: a.text || null, tool_calls: a.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    for (const c of a.calls) history.push({ role: 'tool', tool_call_id: c.id, content: text });
  };
  const a1 = await ask();
  assert.deepEqual(a1.calls.map((c) => [c.name, c.args]), [['Bash', { command: 'ls' }]]);
  answer(a1, 'a.txt');
  const a2 = await ask();
  assert.deepEqual(a2.calls.map((c) => [c.name, c.args]), [['Read', { file_path: 'notes.txt' }]]);
  answer(a2, 'notes');
  const a3 = await ask();
  assert.equal(a3.text, 'Bash said a.txt; Read said notes');
  const [start] = startsOf(t);
  assert.equal(startsOf(t).length, 1, 'one Claude Code process for the three turns');
  assert.deepEqual(eventsOf(start.pid).find((e) => e.event === 'mcp').tools, ['Bash', 'Read'], 'the hub lists them under the request\'s names');
  const server = eventsOf(start.pid).find((e) => e.event === 'server').server.name;
  assert.ok(!log.some((l) => l.includes(server) && /SECURITY/.test(l)), 'no tripwire for the request\'s own tools');
  assert.ok(await until(() => !sessionFiles('claude').length), 'nothing left after');
});

test('claude: a client that never comes back — at toolResultTimeoutMs Claude Code\'s process group is stopped and its MCP config, token and all, removed; the token is in no argv, log line or usage row; the late result runs on the cold path', async () => {
  const t = tag();
  const c = conversation('cct/m', `Weather ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  assert.equal(a1.calls.length, 1);
  const [start] = startsOf(t);
  const shim = eventsOf(start.pid).find((e) => e.event === 'shim').shimPid;
  const server = eventsOf(start.pid).find((e) => e.event === 'server').server.name;
  const file = sessionFiles('claude-t').find((f) => f.endsWith('.mcp.json'));
  const token = JSON.parse(fs.readFileSync(path.join(dir, 'ws-claude-t', '.keysmith-bridge', file), 'utf8')).mcpServers[server].env.KEYSMITH_BRIDGE_TOKEN;
  assert.ok(token.length > 30);
  assert.ok(alive(start.pid));
  assert.ok(await until(() => !alive(start.pid) && !alive(shim) && !sessionFiles('claude-t').length, 6000), 'stopped at its clock, its files gone');
  assert.ok(!start.argv.some((a) => a.includes(token)), 'never in the argv');
  assert.ok(!log.some((l) => l.includes(token)), 'never in the gateway\'s log');
  assert.ok(!fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').includes(token), 'never in a usage row');
  c.results(() => 'LATE-RESULT');
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(a2.text, 'From the history: LATE-RESULT', 'a new run read the conversation so far');
  assert.equal(startsOf(t).length, 2);
  assert.equal(rowsOf('cct/m').at(-1).bridge.path, 'cold');
  assert.ok(await until(() => !sessionFiles('claude-t').length), 'nothing left after');
});

// Two findings of the independent test of 2026-11-03, against Claude Code 2.1.303 itself (a stub
// Messages endpoint, then live on haiku): auto-memory stayed on under --setting-sources "", and a
// result over ~50,000 chars was written under ~/.claude/projects/…/tool-results while the model got
// a 2 KB preview of it. Either way a plain request made the model reach for Read (the tripwire, 502).

test('claude: Claude Code\'s auto-memory is off on the bridge — autoMemoryEnabled false in its --settings, and CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in its environment, an entry\'s older argv and an inherited 0 notwithstanding', async () => {
  const saved = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0';
  try {
    for (const id of ['cc', 'ccx']) {
      const t = tag();
      const c = conversation(`${id}/m`, `Weather ${t}`);
      const a1 = await c.ask();
      assert.equal(a1.r.status, 200, a1.r.text);
      const [start] = startsOf(t);
      const cfg = eventsOf(start.pid).find((e) => e.event === 'config');
      assert.equal(cfg.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', `${id}: auto-memory off in its environment`);
      assert.equal(JSON.parse(cfg.settings).disableAllHooks, true, `${id}: no hooks`);
      // The profile's argv says it too; an entry copied before that keeps its own argv (keysmith upgrade).
      assert.equal(JSON.parse(cfg.settings).autoMemoryEnabled, id === 'cc' ? false : undefined, `${id}: --settings ${cfg.settings}`);
      c.results();
      assert.equal((await c.ask()).text, 'Weather: RESULT for Ankara');
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = saved;
    await closeAll();
  }
});

test('claude: each tool the hub lists to Claude Code takes a result as long as the adapter takes one (_meta "anthropic/maxResultSizeChars" = maxPromptChars) — a 60,000-char result reaches the model whole, and nothing spills to a file', async (ctx) => {
  ctx.after(closeAll);
  for (const [id, ws] of [['cc', 'claude'], ['ccx', 'claude-x']]) {
    const t = tag();
    const big = (c) => `${c.args.city}:` + 'x'.repeat(60_000);
    const c = conversation(`${id}/m`, `Weather ${t}`);
    const a1 = await c.ask();
    assert.equal(a1.r.status, 200, a1.r.text);
    const [start] = startsOf(t);
    const max = gateway.adapters.get(id).maxPromptChars;
    assert.equal(max, id === 'cc' ? 200_000 : 300_000);
    assert.deepEqual(eventsOf(start.pid).find((e) => e.event === 'mcp').meta, [{ 'anthropic/maxResultSizeChars': max }], `${id}: each listed tool says how long a result it takes`);
    c.results(big);
    const a2 = await c.ask();
    assert.equal(a2.r.status, 200, a2.r.text);
    assert.equal(a2.text, `Weather: ${big({ args: { city: 'Ankara' } })}`, `${id}: the result reached the model whole`);
    assert.ok(!eventsOf(start.pid).some((e) => e.event === 'spilled'), `${id}: no result left in a file of Claude Code's`);
    assert.ok(await until(() => !sessionFiles(ws).length), 'nothing left after');
  }
  // A result over maxPromptChars never reaches Claude Code: the request is a 400.
  const t = tag();
  const c = conversation('cc/m', `Weather ${t}`);
  await c.ask();
  c.results(() => 'y'.repeat(200_001));
  const a2 = await c.ask();
  assert.equal(a2.r.status, 400, a2.r.text);
  assert.match(JSON.parse(a2.r.text).error.message, /over maxPromptChars=200000/);
});

// A finding of the independent re-check of 2026-11-03 (Claude Code 2.1.303 against a stub Messages
// endpoint): the _meta above is honoured only up to 500,000 chars. Marked todo until the bridge does
// what it says.

test('claude: an entry whose maxPromptChars is over Claude Code\'s 500,000-char ceiling for a tool\'s _meta never has a result spilled — a longer one is a 400 before Claude Code, or reaches the model whole', {
  todo: 'Claude Code 2.1.303 takes `Math.min(_meta["anthropic/maxResultSizeChars"], 500000)` as a tool\'s threshold: with `keysmith set claude maxPromptChars 700000` (the cap the 400 tells a client to raise) a 550,032-char result was written to <config dir>/projects/<workspace>/<session>/tool-results/toolu_….json (557 KB, 0644, left after the run) and the model got a 2,436-char preview — blocker 1 again, past 500,000. driver.toolMeta and the attach check want the smaller of maxPromptChars and 500,000',
}, async (ctx) => {
  ctx.after(closeAll);
  const t = tag();
  const big = (c) => `${c.args.city}:` + 'z'.repeat(550_000);
  const c = conversation('ccw/m', `Weather ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.r.status, 200, a1.r.text);
  const [start] = startsOf(t);
  c.results(big);
  const a2 = await c.ask();
  assert.ok(!eventsOf(start.pid).some((e) => e.event === 'spilled'), 'no result left in a file of Claude Code\'s');
  if (a2.r.status === 400) assert.match(JSON.parse(a2.r.text).error.message, /tool result/);
  else {
    assert.equal(a2.r.status, 200, a2.r.text);
    assert.equal(a2.text, `Weather: ${big({ args: { city: 'Ankara' } })}`, 'the result reached the model whole');
  }
});

test('the other CLIs\' tools are listed with no _meta: what claude reads off a tool is claude\'s alone', async () => {
  for (const id of ['oc', 'cx', 'qd']) {
    const t = tag();
    const c = conversation(`${id}/m`, `Weather ${t}`);
    const a1 = await c.ask();
    assert.equal(a1.r.status, 200, a1.r.text);
    const [start] = startsOf(t);
    assert.deepEqual(eventsOf(start.pid).find((e) => e.event === 'mcp').meta, [null], id);
    c.results();
    await c.ask();
  }
});

/* ---------------------------------------------------------------- tripwire and clock */

for (const [id, ws] of [['oc', 'opencode'], ['cx', 'codex'], ['qd', 'qoder'], ['cc', 'claude']]) {
  test(`${ws}: a tool of its own in its stream is the tripwire — stopped, a 502 foreign_tool, its files gone`, async () => {
    const t = tag();
    const r = await post('/v1/chat/completions', { model: `${id}/m`, tools: TOOLS, messages: [{ role: 'user', content: `Weather ${t} SCENARIO=foreign` }] });
    assert.equal(r.status, 502, r.text);
    assert.match(JSON.parse(r.text).error.message, /reached for a tool of its own/);
    const [start] = startsOf(t);
    const shim = eventsOf(start.pid).find((e) => e.event === 'shim')?.shimPid;
    assert.ok(await until(() => !alive(start.pid) && !(shim && alive(shim)) && !sessionFiles(ws).length), 'the process group is stopped and its files removed');
    assert.equal(rowsOf(`${id}/m`).at(-1).failure, 'foreign_tool');
    assert.ok(log.some((l) => /SECURITY: .* reached for a tool of its own/.test(l)));
  });
}

test('a client that never comes back: at toolResultTimeoutMs the CLI\'s process group is stopped and its files removed; the late result is answered on the cold path', async () => {
  const t = tag();
  const c = conversation('oct/m', `Weather ${t}`);
  const a1 = await c.ask();
  assert.equal(a1.calls.length, 1);
  const [start] = startsOf(t);
  const shim = eventsOf(start.pid).find((e) => e.event === 'shim').shimPid;
  assert.ok(alive(start.pid));
  assert.ok(await until(() => !alive(start.pid) && !alive(shim) && !sessionFiles('opencode-t').length, 6000), 'stopped at its clock, files gone');
  c.results(() => 'LATE-RESULT');
  const a2 = await c.ask();
  assert.equal(a2.r.status, 200, a2.r.text);
  assert.equal(a2.text, 'From the history: LATE-RESULT', 'a new run read the conversation so far');
  assert.equal(startsOf(t).length, 2);
  assert.equal(rowsOf('oct/m').at(-1).bridge.path, 'cold');
});

test('the start-up sweep: session files of keysmith\'s naming older than an hour go, anything else stays', () => {
  const ws = path.join(dir, 'ws-sweep');
  const d = path.join(ws, '.keysmith-bridge');
  fs.mkdirSync(d, { recursive: true });
  const old = Date.now() / 1000 - 7200;
  const files = { 'ks-b-aaaaaaaaaaaa.json': true, 'ks-b-bbbbbbbbbbbb.token': true, 'ks-b-cccccccccccc.mcp.json': false, 'notes.txt': false, 'ks-b-dddddddddddd.json': false };
  for (const f of Object.keys(files)) fs.writeFileSync(path.join(d, f), 'x');
  for (const f of ['ks-b-aaaaaaaaaaaa.json', 'ks-b-bbbbbbbbbbbb.token', 'notes.txt', 'ks-b-dddddddddddd.json']) fs.utimesSync(path.join(d, f), old, old);
  const adapter = new CliAdapter('oc2', { ...CLI_PROFILES.opencode, cwd: ws });
  // ks-b-dddd… belongs to a live session (`keep`); ks-b-cccc… is new; notes.txt is not keysmith's.
  assert.equal(opencodeDriver.sweep(adapter, { keep: new Set(['ksdddddd']) }), 2);
  assert.deepEqual(fs.readdirSync(d).sort(), ['ks-b-cccccccccccc.mcp.json', 'ks-b-dddddddddddd.json', 'notes.txt']);
});

/* ----------------------------------------------------------------- drivers, parsers */

test('which driver takes an adapter: the one its bridge.driver names (agy also by its parser); claude ships its own, explicit-only still, and an unknown name does not load', () => {
  const at = (cfg) => DRIVERS.filter((d) => d.supports(new CliAdapter('x', { cwd: dir, ...cfg }))).map((d) => d.id);
  for (const name of ['opencode', 'codex', 'qoder', 'agy', 'claude']) assert.deepEqual(at(CLI_PROFILES[name]), [name], name);
  assert.equal(CLAUDE_BRIDGE_ARGS, CLI_PROFILES.claude.bridge.args);
  assert.deepEqual(at({ ...CLI_PROFILES.agy, bridge: { args: CLI_PROFILES.agy.bridge.args } }), ['agy'], 'an agy entry written before bridge.driver');
  assert.deepEqual(at({ ...CLI_PROFILES.codex, bridge: { args: CLI_PROFILES.codex.bridge.args } }), [], 'no driver named, no agy parser: no bridge');
  assert.deepEqual(at({ ...CLI_PROFILES.opencode, cwd: undefined, workspaceFiles: undefined, toolMode: 'off' }), [], 'never outside a workspace keysmith owns');
  assert.equal(CLI_PROFILES.claude.toolMode, 'auto');
  assert.equal(CLI_PROFILES.claude.explicitOnly, true, 'claude spends the subscription: a request that names it, never an alias');
  assert.deepEqual(CLI_PROFILES.claude.emulateArgs, CLI_PROFILES.claude.args, 'EMULATE runs the tool-less text argv');
  assert.throws(() => checkAdapter('x', { ...CLI_PROFILES.opencode, bridge: { driver: 'gemini', args: ['{prompt}'] } }), /bridge.driver must be one of/);
});

const run = async (parser, list) => {
  const out = [];
  for await (const e of parser((async function* () {
    for (const l of list) yield typeof l === 'string' ? l : JSON.stringify(l);
  })())) out.push(e);
  return out;
};

test('codex-json: agent messages are text (two are two paragraphs), an MCP call is a tool event as it starts, anything else that acts is a tool named by its type, turn.completed the usage', async () => {
  const events = await run(codexJson, [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking.' } },
    { type: 'item.started', item: { id: 'item_2', type: 'mcp_tool_call', server: 'ks012345', tool: 'get_weather', arguments: {}, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'ks012345', tool: 'get_weather', status: 'completed' } },
    { type: 'item.started', item: { id: 'item_3', type: 'todo_list', items: [] } },
    { type: 'item.started', item: { id: 'item_4', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'command_execution', command: 'ls' } },
    { type: 'item.started', item: { id: 'item_5', type: 'something_new' } },
    { type: 'item.completed', item: { id: 'item_6', type: 'error', message: 'an MCP server warned' } },
    { type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: 'Done.' } },
    'not json',
    { type: 'turn.completed', usage: { input_tokens: 20000, cached_input_tokens: 15000, output_tokens: 140, reasoning_output_tokens: 20 } },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 'th-1' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'delta', text: 'Checking.' },
    { type: 'tool', name: 'mcp__ks012345__get_weather' },
    { type: 'tool', name: 'command_execution' },
    { type: 'tool', name: 'something_new' },
    { type: 'delta', text: 'Done.' },
    { type: 'usage', usage: { input: 20000, output: 140, cacheRead: 15000, cacheWrite: 0, reasoning: 20 }, scope: 'run' },
    { type: 'done', finishReason: 'stop' },
  ]);
  const two = await run(codexJson, [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'One.' } }, { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Two.' } }]);
  assert.deepEqual(two.filter((e) => e.type === 'delta').map((e) => e.text), ['One.', '\n\nTwo.'], 'two messages with no call between them are two paragraphs');
  assert.deepEqual(await run(codexJson, [{ type: 'turn.failed', error: { message: 'quota' } }]), [{ type: 'error', message: 'codex: quota' }, { type: 'done', finishReason: 'stop' }]);
});

test('claude-stream-json: a tool_use block is a tool event once per id; qoder\'s mcp_call is read as the tool it names', async () => {
  const msg = (id, content) => ({ type: 'assistant', message: { id, content } });
  const events = await run(claudeStreamJson, [
    msg('m1', [{ type: 'text', text: 'Let me check.' }]),
    msg('m2', [{ type: 'tool_use', id: 'tu1', name: 'mcp__ks012345__get_weather', input: {} }]),
    msg('m2', [{ type: 'tool_use', id: 'tu1', name: 'mcp__ks012345__get_weather', input: {} }]),
    msg('m3', [{ type: 'tool_use', id: 'tu2', name: 'mcp_get', input: { toolName: 'mcp__ks012345__get_weather' } }]),
    msg('m4', [{ type: 'tool_use', id: 'tu3', name: 'mcp_call', input: { toolName: 'mcp__ks012345__get_weather', arguments: {} } }]),
    msg('m5', [{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: 'ls' } }]),
    { type: 'result', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['mcp__ks012345__get_weather', 'mcp_get', 'mcp__ks012345__get_weather', 'Bash']);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['Let me check.']);
});
