/**
 * The MCP bridge's drivers for opencode, codex and qoder (design U11), and claude's, written but
 * never run: src/bridge/clis.js behind the gateway's faces. The CLI is test/stubs/cli-bridge.mjs,
 * which takes the session's MCP server the way each CLI was seen to take it (opencode's
 * OPENCODE_CONFIG, codex's `-c mcp_servers.…`, qoder's `--mcp-config`), starts it — the real
 * shim, so the hub is the real one — and prints that CLI's stream. Nothing here spends a token.
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
      qd: around('qoder', 'qoder'),
      oct: around('opencode', 'opencode', { bridge: { toolResultTimeoutMs: 1_200 }, cwd: path.join(dir, 'ws-opencode-t') }),
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
  const env = Object.fromEntries(['OPENCODE_CONFIG', 'PWD'].filter((k) => p.env[k] !== undefined).map((k) => [k, norm(p.env[k])]));
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
    claude: planOf(claudeDriver, { ...CLI_PROFILES.claude, bridge: { driver: 'claude', args: CLAUDE_BRIDGE_ARGS } }),
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
    assert.equal(argv[argv.indexOf('--allowed-tools') + 1], 'mcp__ks012345');
    assert.equal(argv[argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
    assert.ok(!argv.some((a) => a.includes('TOKEN-0123')), `${name}: the token is in the 0600 file, not the argv`);
  }
  assert.ok(!plans.claude.argv.includes('--safe-mode'), 'claude: --safe-mode would turn the MCP server off');
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

/* ---------------------------------------------------------------- tripwire and clock */

for (const [id, ws] of [['oc', 'opencode'], ['cx', 'codex'], ['qd', 'qoder']]) {
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

test('which driver takes an adapter: the one its bridge.driver names (agy also by its parser); claude ships without one, and an unknown name does not load', () => {
  const at = (cfg) => DRIVERS.filter((d) => d.supports(new CliAdapter('x', { cwd: dir, ...cfg }))).map((d) => d.id);
  for (const name of ['opencode', 'codex', 'qoder', 'agy']) assert.deepEqual(at(CLI_PROFILES[name]), [name], name);
  assert.deepEqual(at({ ...CLI_PROFILES.claude, bridge: { driver: 'claude', args: CLAUDE_BRIDGE_ARGS } }), ['claude']);
  assert.deepEqual(at({ ...CLI_PROFILES.agy, bridge: { args: CLI_PROFILES.agy.bridge.args } }), ['agy'], 'an agy entry written before bridge.driver');
  assert.deepEqual(at({ ...CLI_PROFILES.codex, bridge: { args: CLI_PROFILES.codex.bridge.args } }), [], 'no driver named, no agy parser: no bridge');
  assert.deepEqual(at({ ...CLI_PROFILES.opencode, cwd: undefined, workspaceFiles: undefined, toolMode: 'off' }), [], 'never outside a workspace keysmith owns');
  assert.equal(CLI_PROFILES.claude.bridge, undefined, 'claude spends the subscription: no bridge settings ship');
  assert.equal(CLI_PROFILES.claude.toolMode, 'off');
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
    { type: 'usage', usage: { input: 20000, output: 140, cacheRead: 15000, cacheWrite: 0 } },
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
