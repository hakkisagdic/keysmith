/**
 * The MCP bridge's core (design §3, U6): the hub (src/bridge/hub.js), its MCP protocol
 * (src/bridge/mcp.js) and the shim (src/bridge/shim.js). The MCP client here is this test: it
 * runs the real shim the way a CLI would — `node shim.js`, the session's socket and token in its
 * env — and speaks JSON-RPC over its stdin and stdout. No CLI, no model.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub, PROGRESS_MS, RETRY_AFTER_S } from '../src/bridge/hub.js';
import { LATEST_PROTOCOL, MAX_INVALID_CALLS, toolListing } from '../src/bridge/mcp.js';
import { knownSecrets } from '../src/redact.js';

const SHIM = fileURLToPath(new URL('../src/bridge/shim.js', import.meta.url));
const dirs = [];
const hubs = [];
after(async () => {
  for (const h of hubs) await h.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp() {
  // os.tmpdir(), not a long scratch path: a Unix socket's path is at most 103 bytes.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ksbc-'));
  dirs.push(d);
  return d;
}

/** A pydantic-shaped schema: $defs, $ref, anyOf with null — what ucmdb's tools look like. */
const WEATHER = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: {
    type: 'object',
    $defs: { Unit: { type: 'string', enum: ['c', 'f'] } },
    properties: { city: { type: 'string' }, unit: { anyOf: [{ $ref: '#/$defs/Unit' }, { type: 'null' }], default: null } },
    required: ['city'],
    additionalProperties: false,
  },
};
const NOTE = { name: 'note', description: 'Takes a summary of its own', parameters: { type: 'object', properties: { toolSummary: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } };
const SPEC = { tools: [WEATHER, NOTE], choice: { mode: 'auto' }, parallel: true, unsupported: [] };

/** A hub listening on a socket of its own; `open()` a session for SPEC's tools, `log` its lines. */
async function setup({ hubOptions = {}, limits = {} } = {}) {
  const dir = tmp();
  const log = [];
  const hub = new Hub({ socketPath: path.join(dir, 'b.sock'), log: (m) => log.push(m), ...hubOptions });
  await hub.start();
  hubs.push(hub);
  const open = (o = {}) => hub.open({ adapterId: 'agy', caller: 'k1', target: 'agy/m', tools: SPEC.tools, listing: toolListing(SPEC.tools), prefix: (s) => `mcp_${s}_`, limits, ...o });
  return { dir, log, hub, open };
}

/** The real shim, run as a CLI runs its MCP server, with this test as the MCP client. */
function client(env) {
  const child = spawn(process.execPath, [SHIM], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notes = [];
  let next = 1;
  let stderr = '';
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else notes.push(m);
  });
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.on('error', () => {});
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    notes,
    exited,
    get stderr() {
      return stderr;
    },
    rpc(method, params = {}) {
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    get lastId() {
      return next - 1;
    },
    close() {
      child.stdin.end();
    },
  };
}

/** `p`, or 'timeout' after `ms`. */
const within = (p, ms = 1500) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

/** Up to the tools/list a CLI asks for, the way agy 1.4.2 asks. */
async function handshake(c) {
  const discover = await c.rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  const init = await c.rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'antigravity-client', version: 'v1.0.0' }, capabilities: {} });
  c.notify('notifications/initialized');
  const list = await c.rpc('tools/list');
  return { discover, init, list };
}

/** A fake clock for the hub: time moves only when the test says. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  const add = (fn, ms, every) => {
    const id = { id: ++seq, unref() {} };
    due.set(id, { fn, at: now + ms, every });
    return id;
  };
  const clear = (id) => due.delete(id);
  return {
    now: () => now,
    timers: { setTimeout: (fn, ms) => add(fn, ms, 0), setInterval: (fn, ms) => add(fn, ms, ms), clearTimeout: clear, clearInterval: clear },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else due.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

test('the handshake agy 1.4.2 makes: server/discover is refused (-32601), initialize echoes a version it knows, tools/list is the request\'s tools with their $refs written out', async () => {
  const { open } = await setup();
  const s = open();
  const c = client(s.env);
  const { discover, init, list } = await handshake(c);
  assert.equal(discover.error.code, -32601);
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } }, 'tools only');
  assert.equal((await s.next()).type, 'ready', 'the first tools/list answered is the session being ready');
  const [weather, note] = list.result.tools;
  assert.equal(weather.name, 'get_weather');
  assert.equal(weather.description, 'Current weather for a city');
  const text = JSON.stringify(weather.inputSchema);
  assert.ok(!text.includes('$ref') && !text.includes('$defs'), text);
  assert.deepEqual(weather.inputSchema.properties.unit.anyOf[0], { type: 'string', enum: ['c', 'f'] });
  assert.equal(note.inputSchema.type, 'object');
  // A version it does not know gets the latest it does; ping is answered; other methods are not.
  assert.equal((await c.rpc('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, LATEST_PROTOCOL);
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18']) assert.equal((await c.rpc('initialize', { protocolVersion: v })).result.protocolVersion, v);
  assert.deepEqual((await c.rpc('ping')).result, {});
  assert.equal((await c.rpc('resources/list')).error.code, -32601);
  c.close();
  await c.exited;
  await s.close('done');
});

test('tools/call waits for the client\'s result, which goes back as the call\'s MCP result; isError comes from the client', async () => {
  const { open } = await setup();
  const s = open();
  const c = client(s.env);
  await handshake(c);
  assert.equal((await s.next()).type, 'ready');
  const pending = c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Ankara', unit: null }, _meta: { progressToken: 'tok-1' } });
  const call = await s.next();
  assert.deepEqual([call.type, call.name, call.args], ['call', 'get_weather', { city: 'Ankara', unit: null }]);
  assert.equal(await within(pending, 300), 'timeout', 'held: no answer until the client has one');
  s.hold({ id: 'call_abc', mcpId: call.mcpId, name: call.name });
  assert.equal(s.state, 'waiting');
  s.attach();
  assert.equal(s.answer({ text: 'sunny, 21 C', isError: false }), true);
  const r = await pending;
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'sunny, 21 C' }], isError: false });
  // The client's is_error is the MCP result's isError.
  const second = c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Nowhere' } });
  const call2 = await s.next();
  s.hold({ id: 'call_def', mcpId: call2.mcpId, name: call2.name });
  s.attach();
  s.answer({ text: 'no such city', isError: true });
  assert.deepEqual((await second).result, { content: [{ type: 'text', text: 'no such city' }], isError: true });
  c.close();
  await s.close('done');
});

test('a wrong or missing token is refused, so is a second connection; a dropped one may be replaced', async () => {
  const { open, log } = await setup();
  const s = open();
  // Wrong token: the connection is closed unanswered, and the shim ends with it.
  const wrong = client({ ...s.env, KEYSMITH_BRIDGE_TOKEN: 'not-the-token-' + 'x'.repeat(30) });
  assert.equal(await within(wrong.rpc('ping'), 800), 'timeout');
  assert.equal(await within(wrong.exited, 2000), 0);
  // No token at all: the shim refuses to start.
  const none = client({ KEYSMITH_BRIDGE_SOCK: s.env.KEYSMITH_BRIDGE_SOCK });
  assert.equal(await none.exited, 2);
  assert.match(none.stderr, /KEYSMITH_BRIDGE_TOKEN must be set/);
  assert.ok(log.some((l) => /a connection was refused: a wrong or missing token/.test(l)), log.join('\n'));
  // One connection per session.
  const first = client(s.env);
  assert.deepEqual((await first.rpc('ping')).result, {});
  const second = client(s.env);
  assert.equal(await within(second.rpc('ping'), 800), 'timeout');
  assert.equal(await within(second.exited, 2000), 0);
  assert.ok(log.some((l) => new RegExp(`bridge ${s.server} has a connection already`).test(l)));
  assert.deepEqual((await first.rpc('ping')).result, {}, 'the first one is untouched');
  // It drops; a new one takes its place.
  first.close();
  await first.exited;
  assert.ok(await until(() => s.conn === null));
  const third = client(s.env);
  assert.deepEqual((await third.rpc('ping')).result, {});
  third.close();
  await s.close('done');
});

test('a call that does not fit the client\'s schema, or names a tool the request does not offer, is answered with isError at once, and counted', async () => {
  const { open } = await setup();
  const s = open();
  const c = client(s.env);
  await handshake(c);
  await s.next(); // ready
  const bad = await c.rpc('tools/call', { name: 'get_weather', arguments: { city: 7 } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /not run: get_weather\.arguments\.city: expected string, got integer/);
  assert.ok(!bad.result.content[0].text.includes('7'), 'the reason names a place and a type, never a value');
  assert.deepEqual(await s.next(), { type: 'invalid', name: 'get_weather', count: 1, reason: 'get_weather.arguments.city: expected string, got integer' });
  const unknown = await c.rpc('tools/call', { name: 'launch_rocket', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /unknown tool "launch_rocket"; the tools are: get_weather, note/);
  const ev = await s.next();
  assert.deepEqual([ev.type, ev.name, ev.count], ['invalid', null, 2], 'a name the request does not offer is not repeated in the event');
  assert.equal(MAX_INVALID_CALLS, 3);
  s.mcp.resetTurn();
  await c.rpc('tools/call', { name: 'get_weather', arguments: {} });
  assert.equal((await s.next()).count, 1, 'a new turn counts from zero');
  // The arguments agy adds to what it shows its model are taken off — unless the tool has them.
  const p1 = c.rpc('tools/call', { name: 'mcp_' + s.server + '_get_weather', arguments: { city: 'Ankara', toolSummary: 'Looking it up', toolAction: 'Weather' } });
  const call = await s.next();
  assert.deepEqual([call.type, call.name, call.args], ['call', 'get_weather', { city: 'Ankara' }], 'the prefix and the injected arguments are taken off');
  s.hold({ id: 'call_1', mcpId: call.mcpId, name: call.name });
  s.attach();
  s.answer({ text: 'ok' });
  await p1;
  const p2 = c.rpc('tools/call', { name: 'note', arguments: { text: 'hi', toolSummary: 'mine' } });
  assert.deepEqual((await s.next()).args, { text: 'hi', toolSummary: 'mine' }, "a tool whose schema has toolSummary keeps it");
  void p2;
  c.close();
  await s.close('done');
});

test('notifications/cancelled for the waiting call breaks the session: closed, its call tombstoned', async () => {
  const { open, hub } = await setup();
  const s = open();
  let cleaned = null;
  s.onClose((reason) => (cleaned = reason));
  const c = client(s.env);
  await handshake(c);
  await s.next();
  void c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Ankara' } });
  const call = await s.next();
  s.hold({ id: 'call_cancelled', mcpId: call.mcpId, name: call.name });
  assert.equal(hub.sessionForCall('call_cancelled'), s);
  c.notify('notifications/cancelled', { requestId: c.lastId, reason: 'user stopped it' });
  assert.ok(await until(() => s.closed));
  assert.equal(s.closedReason, 'cancelled');
  assert.equal(hub.sessionForCall('call_cancelled'), null);
  assert.equal(hub.tombstone('call_cancelled').reason, 'cancelled');
  await s.closing;
  assert.equal(cleaned, 'cancelled');
  assert.equal(await within(c.exited, 2000), 0, 'the connection is closed, and the CLI\'s MCP server ends');
  // While a turn reads it, a cancel is that turn's event instead.
  const s2 = open({ caller: 'k2' });
  const c2 = client(s2.env);
  await handshake(c2);
  await s2.next();
  void c2.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Ankara' } });
  await s2.next();
  c2.notify('notifications/cancelled', { requestId: c2.lastId });
  assert.deepEqual(await s2.next(), { type: 'broken', reason: 'cancelled' });
  c2.close();
  await s2.close('done');
});

test('a client that never comes back: at toolResultTimeoutMs the session closes and leaves a tombstone, kept an hour', async () => {
  const clock = fakeClock();
  const { open, hub } = await setup({ hubOptions: { now: clock.now }, limits: { toolResultTimeoutMs: 300 } });
  const s = open();
  const c = client(s.env);
  await handshake(c);
  await s.next();
  void c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Ankara' } });
  const call = await s.next();
  s.hold({ id: 'call_late', mcpId: call.mcpId, name: call.name });
  assert.ok(await until(() => s.closed, 2000), 'closed by its clock');
  assert.equal(s.closedReason, 'expired');
  assert.equal(hub.sessionForCall('call_late'), null);
  assert.deepEqual(hub.tombstone('call_late'), { reason: 'expired', at: 0, caller: 'k1' });
  assert.ok(!knownSecrets().includes(s.token), 'a dead token is no secret worth keeping');
  assert.equal(await within(c.exited, 2000), 0);
  clock.tick(3_600_001);
  assert.equal(hub.tombstone('call_late'), null, 'an hour later the id is forgotten');
});

test('room: an adapter\'s own cap, the cap in all, and one session per key — the key\'s oldest waiting one gives way (LRU)', async () => {
  const { hub, open } = await setup();
  hub.maxSessions = 3;
  const a = open({ caller: 'k1' });
  a.hold({ id: 'call_a', mcpId: 1, name: 'get_weather' }); // waiting
  const b = open({ caller: 'k2' }); // generating
  // k1 over its share: its waiting session is the one to close.
  let r = hub.room({ adapterId: 'agy', caller: 'k1', adapterMax: 2 });
  assert.deepEqual([r.ok, r.evict], [true, [a]]);
  // k2's only session is generating: nothing of k2's can give way.
  r = hub.room({ adapterId: 'agy', caller: 'k2', adapterMax: 2 });
  assert.deepEqual(r, { ok: false, reason: 'bridge_full', retryAfter: RETRY_AFTER_S });
  // A third key: agy has its two.
  r = hub.room({ adapterId: 'agy', caller: 'k3', adapterMax: 2 });
  assert.equal(r.ok, false);
  r = hub.room({ adapterId: 'other', caller: 'k3', adapterMax: 2 });
  assert.equal(r.ok, true, 'another adapter has room of its own');
  const c = open({ caller: 'k3', adapterId: 'other' });
  r = hub.room({ adapterId: 'other', caller: 'k4', adapterMax: 2 });
  assert.equal(r.ok, false, 'three in all: full');
  // Two waiting sessions of one key: the older goes first.
  hub.maxSessionsPerKey = 2;
  hub.maxSessions = 10;
  const d = open({ caller: 'k1' });
  d.hold({ id: 'call_d', mcpId: 2, name: 'get_weather' });
  a.lastActive = 1;
  d.lastActive = 2;
  r = hub.room({ adapterId: 'other', caller: 'k1', adapterMax: 5 });
  assert.deepEqual(r.evict, [a]);
  for (const s of [a, b, c, d]) await s.close('done');
});

test('while a call waits, progress goes to its progressToken every PROGRESS_MS; it stops when the result goes back (fake clock)', async () => {
  const clock = fakeClock();
  const { open } = await setup({ hubOptions: { timers: clock.timers, now: clock.now } });
  const s = open();
  const c = client(s.env);
  await handshake(c);
  await s.next();
  const pending = c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'Ankara' }, _meta: { progressToken: 'tok-7' } });
  const call = await s.next();
  s.hold({ id: 'call_p', mcpId: call.mcpId, name: call.name });
  assert.equal(PROGRESS_MS, 15_000);
  clock.tick(PROGRESS_MS - 1);
  clock.tick(1);
  clock.tick(PROGRESS_MS);
  assert.ok(await until(() => c.notes.length >= 2));
  assert.deepEqual(
    c.notes.map((n) => [n.method, n.params.progressToken, n.params.progress]),
    [
      ['notifications/progress', 'tok-7', 1],
      ['notifications/progress', 'tok-7', 2],
    ],
  );
  s.attach();
  s.answer({ text: 'sunny' });
  await pending;
  clock.tick(PROGRESS_MS * 3);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.notes.length, 2, 'no progress for a call that was answered');
  c.close();
  await s.close('done');
});

test('the hub\'s log names sessions, tools and reasons — never a token, an argument or a result', async () => {
  const { open, log, hub } = await setup({ limits: { toolResultTimeoutMs: 200 } });
  const s = open();
  const wrong = client({ ...s.env, KEYSMITH_BRIDGE_TOKEN: s.token.slice(0, -2) + 'zz' });
  await wrong.exited;
  const c = client(s.env);
  await handshake(c);
  await s.next();
  await c.rpc('tools/call', { name: 'get_weather', arguments: { city: 99_123 } });
  void c.rpc('tools/call', { name: 'get_weather', arguments: { city: 'ARG-MARKER-Q7' } });
  let call;
  do call = await s.next();
  while (call.type !== 'call');
  s.hold({ id: 'call_log', mcpId: call.mcpId, name: call.name });
  s.attach();
  s.answer({ text: 'RESULT-MARKER-Z9' });
  await new Promise((r) => setTimeout(r, 100));
  await s.close('done');
  void hub;
  const all = log.join('\n');
  assert.ok(log.length >= 1, 'it did log');
  for (const secret of [s.token, s.token.slice(0, 20), 'ARG-MARKER-Q7', '99123', 'RESULT-MARKER-Z9']) assert.ok(!all.includes(secret), `${secret.slice(0, 12)}… in:\n${all}`);
});

test('the socket: 0600 in a 0700 directory; a directory open to others, a file in its place, a socket another process listens on — each refused', async () => {
  const { hub, dir } = await setup();
  assert.equal(fs.statSync(hub.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const twin = new Hub({ socketPath: hub.socketPath });
  await assert.rejects(twin.start(), /another process is listening on the bridge socket/);
  const open = tmp();
  fs.chmodSync(open, 0o755);
  await assert.rejects(new Hub({ socketPath: path.join(open, 'b.sock') }).start(), /open to other users/);
  const file = path.join(tmp(), 'b.sock');
  fs.writeFileSync(file, 'not a socket');
  await assert.rejects(new Hub({ socketPath: file }).start(), /exists and is not a socket/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a socket', 'and it is left alone');
  await assert.rejects(new Hub({ socketPath: path.join(tmp(), 'x'.repeat(120), 'b.sock') }).start(), /over the 103 a Unix socket path takes/);
  // Closed: the socket is gone, and a new hub takes the path.
  await hub.close();
  assert.ok(!fs.existsSync(hub.socketPath));
  const again = new Hub({ socketPath: hub.socketPath });
  await again.start();
  hubs.push(again);
});
