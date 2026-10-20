/**
 * Daily request caps (`perDay` on a key entry): one gateway in front of a stub upstream, with a
 * clock the test moves. A capped key gets its N requests a local day — every face, adapter and
 * alias, failures included, an alias that fails over counted once — then a 429 with a
 * retry-after to local midnight that names the cap and never the key; the count survives a
 * restart (it is rebuilt from usage.jsonl) and starts again at midnight. Nothing spends a token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { fingerprint, redactKey } from '../src/redact.js';
import { describePerDay, parseKeys, targetDecision } from '../src/keys.js';
import { DailyQuota, dayOf, nextMidnight, overCapMessage } from '../src/quota.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime(); // local time

function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 3; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of a key were printed`);
}

/* ------------------------------------------------------------------- stub upstream */

const hits = { up: 0, down: 0, err: 0 };

function upstream(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/down/')) {
      hits.down++;
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    }
    if (req.url.startsWith('/err/')) {
      hits.err++;
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }
    hits.up++;
    if (req.url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], model: body.model }));
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'up answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'up answer' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

/* ----------------------------------------------------------------------- gateways */

/** A gateway over `keys`, its usage log in `dir`, on the clock `clock.t`. */
async function gateway(t, { keys, dir, clock, upRoot }) {
  const cfg = {
    auth: { enabled: true, keys },
    limits: { streamHoldMs: 250 },
    adapters: {
      up: { kind: 'http', wire: 'openai', baseUrl: `${upRoot}/up/v1`, apiKey: false, models: ['m', 'e'] },
      down: { kind: 'http', wire: 'openai', baseUrl: `${upRoot}/down/v1`, apiKey: false, models: ['m'] },
      err: { kind: 'http', wire: 'openai', baseUrl: `${upRoot}/err/v1`, apiKey: false, models: ['m'] },
    },
    aliases: { flaky: ['down/m', 'up/m'] },
  };
  const now = () => clock.t;
  const log = [];
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now });
  const server = createServer(new Gateway(cfg), cfg, { usage, log: (m) => log.push(m), now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, route, body = null) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  return { base, call, log, usageFile: usage.file, close: () => new Promise((r) => server.close(r)) };
}

async function upstreamServer(t) {
  const up = http.createServer(upstream);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => up.close(r)));
  return `http://127.0.0.1:${up.address().port}`;
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const say = (content) => ({ messages: [{ role: 'user', content }] });
/** One request on every face (and a tool request), each a different way in. */
const FACES = [
  ['chat', '/v1/chat/completions', { model: 'up/m', ...say('hi') }],
  ['chat, streamed', '/v1/chat/completions', { model: 'up/m', stream: true, ...say('hi') }],
  ['chat with tools', '/v1/chat/completions', { model: 'up/m', ...say('hi'), tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] }],
  ['messages', '/v1/messages', { model: 'up/m', max_tokens: 16, ...say('hi') }],
  ['messages, streamed', '/v1/messages', { model: 'up/m', max_tokens: 16, stream: true, ...say('hi') }],
  ['responses', '/v1/responses', { model: 'up/m', input: 'hi' }],
  ['responses, streamed', '/v1/responses', { model: 'up/m', stream: true, input: 'hi' }],
  ['embeddings', '/v1/embeddings', { model: 'up/e', input: 'hi' }],
  ['an alias', '/v1/chat/completions', { model: 'flaky', ...say('hi') }],
];

/** A 429 of the cap: retry-after to the next local midnight, a reason that names the cap, no key. */
function assertOverCap(r, { perDay, retryAfter, keys, label }, where) {
  assert.equal(r.status, 429, `${where}: ${r.text}`);
  assert.equal(r.headers.get('retry-after'), String(retryAfter), `${where}: retry-after runs to local midnight`);
  const err = r.json().error;
  assert.equal(err.type, 'rate_limit_error', where);
  assert.match(err.message, new RegExp(`daily cap of ${perDay} request`), `${where}: the reason names the cap`);
  assert.match(err.message, /resets at local midnight/, where);
  for (const k of keys) {
    assertNoKey(r.text, k, where);
    assert.ok(!r.text.includes(fingerprint(k)), `${where}: the refusal does not name the key, not even by fingerprint`);
  }
  if (label) assert.ok(!r.text.includes(label), `${where}: nor by its label`);
}

/* ------------------------------------------------------------------------- tests */

test('a capped key gets its N requests a day on every face — then a 429 on every face, and the upstream hears nothing more', async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const CAPPED = mint();
  const FREE = mint();
  const perDay = FACES.length;
  const clock = { t: at(2026, 10, 20, 23, 0, 0) };
  const gw = await gateway(t, { keys: [FREE, { key: CAPPED, label: 'ada', perDay }], dir, clock, upRoot });

  for (const [where, route, body] of FACES) {
    const r = await gw.call(CAPPED, route, body);
    assert.equal(r.status, 200, `${where}: ${r.text}`);
  }
  const heard = { ...hits };
  for (const [where, route, body] of FACES) assertOverCap(await gw.call(CAPPED, route, body), { perDay, retryAfter: 3600, keys: [CAPPED, FREE], label: 'ada' }, where);
  // Over the cap is over the cap however the key comes: by `?api_key=` too.
  const res = await fetch(`${gw.base}/v1/chat/completions?api_key=${encodeURIComponent(CAPPED)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'up/m', ...say('hi') }) });
  const text = await res.text();
  assertOverCap({ status: res.status, text, headers: res.headers, json: () => JSON.parse(text) }, { perDay, retryAfter: 3600, keys: [CAPPED, FREE], label: 'ada' }, 'by ?api_key=');
  assert.deepEqual(hits, heard, 'no refused request reached the upstream');

  // An uncapped key is untouched by the other key's cap.
  assert.equal((await gw.call(FREE, '/v1/chat/completions', { model: 'up/m', ...say('hi') })).status, 200);

  // The day's first refusal is one usage row (and one log line); the ones after it write nothing.
  const rows = fs.readFileSync(gw.usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const limited = rows.filter((e) => e.status === 'limited');
  assert.equal(limited.length, 1, 'one row for the first refusal, none for the rest');
  assert.equal(limited[0].key, `fp:${fingerprint(CAPPED)}`);
  assert.equal(rows.filter((e) => e.key === `fp:${fingerprint(CAPPED)}` && e.status !== 'limited').length, perDay, 'one row per request let in');
  assert.equal(gw.log.filter((l) => /reached its daily cap/.test(l)).length, 1);
  for (const k of [CAPPED, FREE]) assertNoKey(fs.readFileSync(gw.usageFile, 'utf8') + gw.log.join('\n'), k, 'usage.jsonl and the log');
});

test('the cap counts client requests: an alias that fails over is one, a request that fails is one, a refused scope is one', async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const KEY = mint();
  const clock = { t: at(2026, 10, 20, 12, 0, 0) };
  const gw = await gateway(t, { keys: [{ key: KEY, perDay: 4, deny: ['err'] }, mint()], dir, clock, upRoot });
  const down = hits.down;
  const up = hits.up;
  const r = await gw.call(KEY, '/v1/chat/completions', { model: 'flaky', ...say('hi') });
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.down, down + 1, 'the first leg was asked and refused (503)');
  assert.equal(hits.up, up + 1, 'the second leg answered');
  // A request that fails upstream counts: down/m alone answers 503.
  assert.equal((await gw.call(KEY, '/v1/chat/completions', { model: 'down/m', ...say('hi') })).status, 503);
  // A request its scope refuses (403) counts too: it was a request.
  assert.equal((await gw.call(KEY, '/v1/chat/completions', { model: 'err/m', ...say('hi') })).status, 403);
  // 3 used: the alias (two legs) was one. One more fits, then the cap.
  assert.equal((await gw.call(KEY, '/v1/chat/completions', { model: 'up/m', stream: true, ...say('hi') })).status, 200);
  const over = await gw.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('hi') });
  assertOverCap(over, { perDay: 4, retryAfter: 12 * 3600, keys: [KEY] }, 'the fifth');
  // Listing models, routes or usage is not a request to a model: neither counted nor refused.
  assert.equal((await gw.call(KEY, '/v1/models')).status, 200);
  assert.equal((await gw.call(KEY, '/v1/keysmith/usage')).status, 200);
});

test('a restart does not hand a capped key a fresh day: the count is rebuilt from usage.jsonl', async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const KEY = mint();
  const keys = [{ key: KEY, label: 'ada', perDay: 3 }];
  const clock = { t: at(2026, 10, 20, 22, 30, 0) };
  const first = await gateway(t, { keys, dir, clock, upRoot });
  assert.equal((await first.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('1') })).status, 200);
  assert.equal((await first.call(KEY, '/v1/embeddings', { model: 'up/e', input: 'x' })).status, 200);
  await first.close();

  clock.t += 60_000;
  const second = await gateway(t, { keys, dir, clock, upRoot });
  assert.equal((await second.call(KEY, '/v1/messages', { model: 'up/m', max_tokens: 8, ...say('3') })).status, 200, 'two of three were used before the restart');
  assertOverCap(await second.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('4') }), { perDay: 3, retryAfter: 89 * 60, keys: [KEY], label: 'ada' }, 'after a restart');
  await second.close();

  // A third start, still that day: the refusal row is not a request, so the count is still 3.
  clock.t += 60_000;
  const third = await gateway(t, { keys, dir, clock, upRoot });
  assertOverCap(await third.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('5') }), { perDay: 3, retryAfter: 88 * 60, keys: [KEY] }, 'after a second restart');
});

test('at local midnight the count starts again — and a restart after midnight does not count yesterday', async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const KEY = mint();
  const keys = [{ key: KEY, perDay: 2 }];
  const clock = { t: at(2026, 10, 20, 23, 59, 30) };
  const gw = await gateway(t, { keys, dir, clock, upRoot });
  const chat = () => gw.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('hi') });
  assert.equal((await chat()).status, 200);
  assert.equal((await chat()).status, 200);
  assertOverCap(await chat(), { perDay: 2, retryAfter: 30, keys: [KEY] }, 'half a minute to midnight');
  clock.t = at(2026, 10, 20, 23, 59, 59) + 500;
  assertOverCap(await chat(), { perDay: 2, retryAfter: 1, keys: [KEY] }, 'half a second to midnight: at least 1 s');

  clock.t = at(2026, 10, 21, 0, 0, 5);
  assert.equal((await chat()).status, 200, 'a new day');
  await gw.close();

  // Restarted the same new day: yesterday's two rows (and its refusal) are not today's.
  clock.t = at(2026, 10, 21, 0, 10, 0);
  const again = await gateway(t, { keys, dir, clock, upRoot });
  assert.equal((await again.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('hi') })).status, 200, "today's second");
  assertOverCap(await again.call(KEY, '/v1/chat/completions', { model: 'up/m', ...say('hi') }), { perDay: 2, retryAfter: 23 * 3600 + 50 * 60, keys: [KEY] }, "today's third");
});

test("the status page shows each key's requests today against its cap, and a capped key its own", async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const MAIN = mint();
  const ADA = mint();
  const clock = { t: at(2026, 10, 20, 10, 0, 0) };
  const gw = await gateway(t, { keys: [MAIN, { key: ADA, label: 'ada', allow: ['up', 'alias:flaky'], perDay: 2 }], dir, clock, upRoot });
  for (let i = 0; i < 3; i++) await gw.call(ADA, '/v1/chat/completions', { model: 'up/m', ...say('hi') });
  await gw.call(MAIN, '/v1/chat/completions', { model: 'up/m', ...say('hi') });

  const owner = await gw.call(MAIN, '/');
  assert.equal(owner.status, 200);
  assert.match(owner.text, /today \/ cap/);
  const adaRow = owner.text.split('<tr>').find((row) => row.includes(`fp:${fingerprint(ADA)}`));
  assert.match(adaRow, /2 \/ 2/, adaRow);
  assert.match(adaRow, /1 refused/, adaRow);
  const mainRow = owner.text.split('<tr>').find((row) => row.includes(`fp:${fingerprint(MAIN)}`));
  assert.match(mainRow, /<td class="n">1<\/td>/, 'an uncapped key: its count, no cap');

  const own = await gw.call(ADA, '/');
  assert.equal(own.status, 200);
  assert.match(own.text, /this key today: <b class="bad">2 of 2<\/b> requests, 1 refused over the cap/);
  assert.ok(!own.text.includes(`fp:${fingerprint(MAIN)}`), 'a scoped key never sees another key');
  for (const k of [MAIN, ADA]) assertNoKey(owner.text + own.text, k, 'the status page');
});

/* -------------------------------------------------------------------- config, units */

test('perDay in a key entry: a whole number, or the key reaches nothing — and two caps for one key is no cap at all', () => {
  const k = 'ks_' + 'q'.repeat(32);
  const ok = parseKeys([{ key: k, label: 'ada', perDay: 300 }]);
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.entries[0].perDay, 300);
  assert.equal(ok.entries[0].scope, null, 'a cap is not a scope: the key is still unscoped');
  assert.equal(parseKeys([{ key: k, perDay: 0 }]).entries[0].perDay, 0, '0 refuses every request');
  assert.equal(parseKeys([k]).entries[0].perDay, null);
  for (const perDay of ['300', -1, 1.5, null, true, 1e300]) {
    const { entries, issues } = parseKeys([{ key: k, perDay }]);
    assert.ok(entries[0].scope?.invalid, `perDay ${JSON.stringify(perDay)} must not read as "no cap"`);
    assert.equal(targetDecision(entries[0].scope, 'up', ['m']).ok, false);
    assert.match(issues[0], /"perDay" must be a whole number/);
    assert.ok(!issues[0].includes(k));
  }
  // An uncapped copy of a capped key, above it: the gateway would match the copy.
  const dup = parseKeys([k, { key: k, perDay: 3 }]);
  assert.ok(dup.entries.every((e) => e.scope?.invalid), 'two caps for one key: neither wins');
  assert.match(dup.issues[0], /listed 2 times with different daily caps/);
  assert.equal(parseKeys([{ key: k, perDay: 3 }, { key: k, perDay: 3 }]).issues.length, 0, 'the same entry twice is just a duplicate');
  assert.equal(describePerDay(300), '300 requests/day');
  assert.equal(describePerDay(1), '1 request/day');
});

test('DailyQuota: counted when let in, refused at the cap until the next local midnight, seeded from today only', () => {
  const clock = { t: at(2026, 3, 29, 22, 0, 0) };
  const q = new DailyQuota({ now: () => clock.t });
  assert.deepEqual(q.admit('aa', 2), { ok: true, count: 1 });
  assert.deepEqual(q.admit('aa', 2), { ok: true, count: 2 });
  const no = q.admit('aa', 2);
  assert.equal(no.ok, false);
  assert.equal(no.first, true);
  assert.equal(no.retryAfter, Math.ceil((nextMidnight(clock.t) - clock.t) / 1000));
  assert.equal(q.admit('aa', 2).first, false);
  assert.deepEqual(q.today('aa'), { requests: 2, refused: 2 });
  assert.deepEqual(q.admit('bb'), { ok: true, count: 1 }, 'no cap: counted, never refused');
  clock.t = at(2026, 3, 30, 0, 0, 0);
  assert.deepEqual(q.today('aa'), { requests: 0, refused: 0 }, 'midnight');
  assert.equal(q.admit('aa', 2).ok, true);

  const rows = [
    { ts: new Date(at(2026, 3, 29, 23, 59, 59)).toISOString(), key: 'fp:cc', status: 'ok' },
    { ts: new Date(at(2026, 3, 30, 0, 0, 1)).toISOString(), key: 'fp:cc', status: 'error' },
    { ts: new Date(at(2026, 3, 30, 0, 0, 2)).toISOString(), key: 'fp:cc', status: 'denied' },
    { ts: new Date(at(2026, 3, 30, 0, 0, 3)).toISOString(), key: 'fp:cc', status: 'limited' },
    { ts: new Date(at(2026, 3, 30, 0, 0, 4)).toISOString(), status: 'ok' },
  ];
  const fresh = new DailyQuota({ now: () => clock.t });
  fresh.seed({ rowsSince: (since) => rows.filter((r) => Date.parse(r.ts) >= since) });
  assert.deepEqual(fresh.today('cc'), { requests: 2, refused: 0 }, "today's rows, failures and refusals by scope in, the cap's own refusal out");
  assert.equal(dayOf(at(2026, 3, 30, 0, 0, 0)), '2026-03-30');
  assert.match(overCapMessage({ perDay: 300, retryAfter: 3 * 3600 + 61 }), /daily cap of 300 requests .* in 3 h 2 min \(retry-after: 10861 s\)/);
  assert.match(overCapMessage({ perDay: 1, retryAfter: 1 }), /daily cap of 1 request is used up .* in 1 min/);
});

test('UsageLog.rowsSince reads back from the end and stops at the first older row', (t) => {
  const dir = tmp(t);
  const clock = { t: at(2026, 10, 19, 23, 0, 0) };
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now: () => clock.t });
  usage.record({ model: 'a', status: 'ok' });
  clock.t = at(2026, 10, 20, 1, 0, 0);
  usage.record({ model: 'b', status: 'ok' });
  fs.appendFileSync(usage.file, 'not json\n');
  usage.record({ model: 'c', status: 'error' });
  assert.deepEqual(usage.rowsSince(at(2026, 10, 20)).map((r) => r.model), ['b', 'c']);
  assert.deepEqual(new UsageLog(path.join(dir, 'nope.jsonl')).rowsSince(0), []);
});

/* ------------------------------------------------------------------------------ CLI */

function sandbox(keys) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-quota-cli-'));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys }, adapters: { agy: { kind: 'cli', bin: 'agy', args: ['{prompt}'] }, 'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false } }, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const outputs = [];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    outputs.push(r.stdout + r.stderr);
    return r;
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  return { run, read, outputs, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('keysmith key scope fp:<hex> --per-day N caps a key, key list shows it, --no-per-day lifts it, --clear keeps it', (t) => {
  const MAIN = mint();
  const ADA = mint();
  const sb = sandbox([MAIN, { key: ADA, label: 'ada', deny: ['claude-api'] }]);
  t.after(sb.cleanup);
  const fp = fingerprint(ADA);

  const r = sb.run('key', 'scope', `fp:${fp}`, '--per-day', '300');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.read().auth.keys[1], { key: ADA, label: 'ada', deny: ['claude-api'], perDay: 300 }, 'the scope and the label are kept');
  assert.match(r.stdout, new RegExp(`fp:${fp} \\(ada\\): deny: claude-api · 300 requests/day`));

  const list = sb.run('key', 'list').stdout.trim().split('\n');
  assert.ok(list[1].startsWith(redactKey(ADA)) && /deny: claude-api · 300 requests\/day/.test(list[1]), list[1]);
  assert.ok(!/requests\/day/.test(list[0]), 'an uncapped key shows no cap');
  assert.match(sb.run('key', 'scope', `fp:${fp}`).stdout, /300 requests\/day/, 'shown with no change asked for');

  assert.equal(sb.run('key', 'scope', `fp:${fp}`, '--clear').status, 0);
  assert.deepEqual(sb.read().auth.keys[1], { key: ADA, label: 'ada', perDay: 300 }, '--clear drops the lists, not the cap');

  for (const bad of [['--per-day'], ['--per-day', 'lots'], ['--per-day', '1.5'], ['--per-day', '5', '--no-per-day']]) {
    const f = sb.run('key', 'scope', `fp:${fp}`, ...bad);
    assert.equal(f.status, 1, bad.join(' '));
  }
  assert.deepEqual(sb.read().auth.keys[1], { key: ADA, label: 'ada', perDay: 300 }, 'a refused change saves nothing');

  assert.equal(sb.run('key', 'scope', `fp:${fp}`, '--no-per-day', '--no-label').status, 0);
  assert.equal(sb.read().auth.keys[1], ADA, 'nothing but the key left: a bare key again');

  const fpMain = fingerprint(MAIN);
  assert.equal(sb.run('key', 'scope', `fp:${fpMain}`, '--per-day=0').status, 0);
  assert.deepEqual(sb.read().auth.keys[0], { key: MAIN, perDay: 0 });
  for (const k of [MAIN, ADA]) assertNoKey(sb.outputs.join('\n'), k, 'every key command');
});
