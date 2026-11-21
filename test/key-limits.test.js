/**
 * Per-key expiry (`expires`), disable switch (`disabled`) and rolling per-minute request limit
 * (`perMinute`), modelled on test/quota.test.js: stub upstream, injected clock, temporary data
 * directories, and `assertNoKey` across responses, usage rows, logs and CLI output.
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
import { describePerMinute, keyStrings, parseKeys, targetDecision } from '../src/keys.js';
import { MinuteLimiter } from '../src/quota.js';
import { BatchError, submit as batchSubmit } from '../src/batch.js';
import { redactMcpValue } from '../src/mcp.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 3; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of a key were printed`);
}

/* ------------------------------------------------------------------- stub upstream */

let upstreamHits = 0;

function upstream(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'up answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
    );
  });
}

async function upstreamServer(t) {
  const up = http.createServer(upstream);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => up.close(r)));
  return `http://127.0.0.1:${up.address().port}`;
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-key-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function gateway(t, { keys, dir, clock, upRoot, cfgPath = null }) {
  const cfg = {
    ...(cfgPath ? { _path: cfgPath } : {}),
    auth: { enabled: true, allowQueryApiKey: true, keys },
    limits: { streamHoldMs: 250 },
    adapters: {
      up: { kind: 'http', wire: 'openai', baseUrl: `${upRoot}/up/v1`, apiKey: false, models: ['m'] },
    },
    aliases: {},
  };
  const now = () => clock.t;
  const log = [];
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now });
  const server = createServer(new Gateway(cfg), cfg, { usage, log: (m) => log.push(m), now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let closed = false;
  const close = () => (closed ? Promise.resolve() : ((closed = true), new Promise((r) => server.close(r))));
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, route, body = null) => {
    const res = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  return { base, call, log, usage, usageFile: usage.file, close };
}

function sandbox(keys) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-limits-cli-'));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      port: 0,
      auth: { enabled: true, keys },
      adapters: {
        up: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false, models: ['m'] },
      },
      aliases: {},
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const outputs = [];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    outputs.push((r.stdout || '') + (r.stderr || ''));
    return r;
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  return { home, config, data, env, run, read, outputs, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const say = (content = 'hi') => ({ model: 'up/m', messages: [{ role: 'user', content }] });

/* ----------------------------------------------------- checks 1, 2 & 9: perMinute */

test('checks 1, 2 & 9: perMinute admits N requests in 60 s, refuses N+1 with 429 and retry-after 1..60, writes one limited row per minute, and admits again after 61 s', async (t) => {
  const upRoot = await upstreamServer(t);
  const sb = sandbox([]);
  t.after(sb.cleanup);
  const LIMITED = mint();
  const FREE = mint();
  const clock = { t: at(2026, 10, 20, 14, 0, 0) };
  const keys = [FREE, { key: LIMITED, label: 'runner', perMinute: 3, perDay: 10 }];
  fs.writeFileSync(sb.config, JSON.stringify({ ...sb.read(), auth: { enabled: true, keys } }), { mode: 0o600 });

  const gw = await gateway(t, { keys, dir: sb.data, clock, upRoot });

  // First 3 chat requests within one minute return 200.
  for (let i = 0; i < 3; i++) {
    const r = await gw.call(LIMITED, '/v1/chat/completions', say(`m${i}`));
    assert.equal(r.status, 200, r.text);
  }
  const beforeRefusalHits = upstreamHits;

  // 4th, 5th, 6th requests within the same minute return 429 with retry-after in 1..60 and never name the key.
  for (const offsetMs of [0, 15_000, 40_000]) {
    clock.t = at(2026, 10, 20, 14, 0, 0) + offsetMs;
    const r = await gw.call(LIMITED, '/v1/chat/completions', say('over'));
    assert.equal(r.status, 429, r.text);
    const ra = Number(r.headers.get('retry-after'));
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `retry-after 1..60, got ${r.headers.get('retry-after')}`);
    const err = r.json().error;
    assert.equal(err.type, 'rate_limit_error');
    assert.match(err.message, /3 requests?\/minute/);
    for (const k of [LIMITED, FREE]) {
      assertNoKey(r.text, k, '429 body');
      assert.ok(!r.text.includes(fingerprint(k)), '429 body does not include fingerprint');
    }
    assert.ok(!r.text.includes('runner'), '429 body does not include label');
  }
  assert.equal(upstreamHits, beforeRefusalHits, 'refused requests never reach upstream');

  // Listing models, routes and the status page are not counted or refused by perMinute.
  assert.equal((await gw.call(LIMITED, '/v1/models')).status, 200);
  assert.equal((await gw.call(LIMITED, '/v1/keysmith/routes')).status, 200);
  assert.equal((await gw.call(LIMITED, '/status')).status, 200);

  // Check 9: only one usage row with status "limited" was written in that minute, not one per refusal.
  const rows1 = fs.readFileSync(gw.usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows1.filter((e) => e.status === 'limited').length, 1, 'one limited row in the minute');
  const tailCli = sb.run('usage', '--tail', '20');
  assert.equal(tailCli.status, 0, tailCli.stderr);
  const tailJson = JSON.parse(sb.run('usage', '--tail', '20', '--format', 'json').stdout);
  assert.equal(tailJson.entries.filter((e) => e.status === 'limited').length, 1, 'keysmith usage --tail 20 sees one limited row');

  // Check 2: move injected clock 61 seconds from the start of the burst -> next request returns 200!
  clock.t = at(2026, 10, 20, 14, 0, 0) + 61_000;
  const after61 = await gw.call(LIMITED, '/v1/chat/completions', say('fresh'));
  assert.equal(after61.status, 200, after61.text);

  // Refused requests did not count toward perDay either: 4 admitted total out of perDay: 10.
  const u = (await gw.call(FREE, '/v1/keysmith/usage')).json();
  assert.equal(u.daily.find((d) => d.fp === fingerprint(LIMITED)).requests, 4);

  for (const k of [LIMITED, FREE]) {
    assertNoKey(fs.readFileSync(gw.usageFile, 'utf8') + gw.log.join('\n') + sb.outputs.join('\n'), k, 'logs and CLI');
  }
});

/* ----------------------------------------------------- check 3: expires */

test('check 3: expires in the past returns 401 authentication_error "key expired"; future date returns 200; date-only is 00:00 UTC', async (t) => {
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const PAST = mint();
  const FUTURE = mint();
  const DATE_ONLY = mint();
  const clock = { t: Date.parse('2026-10-19T23:59:59Z') };
  const gw = await gateway(t, {
    keys: [
      { key: PAST, label: 'old', expires: '2026-10-19T12:00:00Z' },
      { key: FUTURE, label: 'next-year', expires: '2027-01-31T00:00:00Z' },
      { key: DATE_ONLY, label: 'day-cut', expires: '2026-10-20' },
    ],
    dir,
    clock,
    upRoot,
  });

  // Past expiry -> 401 authentication_error with message "key expired", one limited row per minute.
  const rPast1 = await gw.call(PAST, '/v1/chat/completions', say());
  const rPast2 = await gw.call(PAST, '/v1/chat/completions', say());
  assert.equal(rPast1.status, 401, rPast1.text);
  assert.equal(rPast2.status, 401, rPast2.text);
  assert.equal(rPast1.json().error.type, 'authentication_error');
  assert.match(rPast1.json().error.message, /key expired/);
  assertNoKey(rPast1.text, PAST, 'expired response');
  assert.ok(!rPast1.text.includes(fingerprint(PAST)));

  // Future expiry -> 200.
  const rFuture = await gw.call(FUTURE, '/v1/chat/completions', say());
  assert.equal(rFuture.status, 200, rFuture.text);

  // Date-only "2026-10-20": 1 s before 00:00 UTC -> 200; at 00:00 UTC -> 401.
  assert.equal((await gw.call(DATE_ONLY, '/v1/chat/completions', say())).status, 200);
  clock.t = Date.parse('2026-10-20T00:00:00Z');
  const rAtCut = await gw.call(DATE_ONLY, '/v1/chat/completions', say());
  assert.equal(rAtCut.status, 401, rAtCut.text);
  assert.equal(rAtCut.json().error.type, 'authentication_error');
  assert.match(rAtCut.json().error.message, /key expired/);

  const rows = fs.readFileSync(gw.usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((e) => e.key === `fp:${fingerprint(PAST)}` && e.status === 'limited').length, 1, 'one limited row for repeated expired refusals in a minute');
});

/* ----------------------------------------------------- check 4: disabled & --enable */

test('check 4: disabled: true refuses with 403 permission_error; keysmith key scope fp:<fp> --enable plus restart makes it 200', async (t) => {
  const upRoot = await upstreamServer(t);
  const KEY = mint();
  const fp = fingerprint(KEY);
  const sb = sandbox([{ key: KEY, label: 'agent1', disabled: true, perDay: 5 }]);
  t.after(sb.cleanup);
  const clock = { t: at(2026, 10, 20, 10, 0, 0) };

  const first = await gateway(t, { keys: sb.read().auth.keys, dir: sb.data, clock, upRoot });
  const r1 = await first.call(KEY, '/v1/chat/completions', say());
  const r2 = await first.call(KEY, '/v1/chat/completions', say());
  assert.equal(r1.status, 403, r1.text);
  assert.equal(r2.status, 403, r2.text);
  assert.equal(r1.json().error.type, 'permission_error');
  assertNoKey(r1.text, KEY, 'disabled response');
  assert.ok(!r1.text.includes(fp));
  await first.close();

  const en = sb.run('key', 'scope', `fp:${fp}`, '--enable');
  assert.equal(en.status, 0, en.stderr);

  const second = await gateway(t, { keys: sb.read().auth.keys, dir: sb.data, clock, upRoot });
  const rOk = await second.call(KEY, '/v1/chat/completions', say());
  assert.equal(rOk.status, 200, rOk.text);
  // Disabled refusals before restart did not consume perDay: only 1 of 5 used.
  const usageResp = (await second.call(KEY, '/v1/keysmith/usage')).json();
  assert.equal(usageResp.daily.find((d) => d.fp === fp).requests, 2, '1 chat + 1 /v1/keysmith/usage, disabled refusals excluded');
  await second.close();

  assertNoKey(sb.outputs.join('\n'), KEY, 'CLI --enable');
});

/* ----------------------------------------------------- checks 5 & 6: fail closed & duplicates */

test('checks 5 & 6: malformed perMinute, expires or disabled, and duplicate keys with differing limits, fail closed and are named by fingerprint in doctor and key list', async (t) => {
  const upRoot = await upstreamServer(t);
  const badEntries = [
    { key: mint(), label: 'str-rpm', perMinute: '5' },
    { key: mint(), label: 'neg-rpm', perMinute: -1 },
    { key: mint(), label: 'frac-rpm', perMinute: 1.5 },
    { key: mint(), label: 'bad-exp', expires: 'tomorrow' },
    { key: mint(), label: 'bad-dis', disabled: 'yes' },
  ];
  const parsed = parseKeys(badEntries);
  assert.equal(parsed.entries.length, badEntries.length);
  assert.equal(parsed.issues.length, badEntries.length);
  for (let i = 0; i < badEntries.length; i++) {
    assert.ok(parsed.entries[i].scope?.invalid, JSON.stringify(badEntries[i]));
    assert.equal(targetDecision(parsed.entries[i].scope, 'up', ['m']).ok, false);
    assert.ok(parsed.issues[i].includes(`fp:${fingerprint(badEntries[i].key)}`), parsed.issues[i]);
    assertNoKey(parsed.issues[i], badEntries[i].key, 'parseKeys issue');
  }

  // Check 6: duplicate key with different perMinute (and expires / disabled) reaches nothing.
  const DUP_RPM = mint();
  const dupRpm = parseKeys([{ key: DUP_RPM, perMinute: 10 }, { key: DUP_RPM, perMinute: 3 }]);
  assert.ok(dupRpm.entries.every((e) => e.scope?.invalid));
  assert.match(dupRpm.issues[0], new RegExp(`fp:${fingerprint(DUP_RPM)}.*listed 2 times`));

  const DUP_EXP = mint();
  assert.ok(parseKeys([DUP_EXP, { key: DUP_EXP, expires: '2027-01-31' }]).entries.every((e) => e.scope?.invalid));
  const DUP_DIS = mint();
  assert.ok(parseKeys([{ key: DUP_DIS, disabled: false }, { key: DUP_DIS, disabled: true }]).entries.every((e) => e.scope?.invalid));
  const SAME = mint();
  assert.equal(parseKeys([{ key: SAME, perMinute: 5, expires: '2027-01-31', disabled: true }, { key: SAME, perMinute: 5, expires: '2027-01-31', disabled: true }]).issues.length, 0);

  // CLI doctor & key list name each bad entry by fingerprint, and gateway refuses them all.
  const allKeys = [...badEntries, { key: DUP_RPM, perMinute: 10 }, { key: DUP_RPM, perMinute: 3 }];
  const sb = sandbox(allKeys);
  t.after(sb.cleanup);

  const listOut = sb.run('key', 'list');
  assert.equal(listOut.status, 0);
  const docOut = sb.run('doctor');
  assert.equal(docOut.status, 0);
  for (const e of [...badEntries, { key: DUP_RPM }]) {
    const fp = `fp:${fingerprint(e.key)}`;
    assert.ok(listOut.stderr.includes(fp), `key list stderr names ${fp}`);
    assert.ok(docOut.stdout.includes(fp), `doctor stdout names ${fp}`);
  }

  const clock = { t: at(2026, 10, 20, 12, 0, 0) };
  const gw = await gateway(t, { keys: allKeys, dir: sb.data, clock, upRoot });
  for (const e of [...badEntries, { key: DUP_RPM }]) {
    assert.equal((await gw.call(e.key, '/v1/chat/completions', say())).status, 403);
    assert.deepEqual((await gw.call(e.key, '/v1/models')).json().data, []);
  }
  for (const k of keyStrings(allKeys)) assertNoKey(sb.outputs.join('\n') + gw.log.join('\n'), k, 'doctor and key list');
});

/* ----------------------------------------------------- check 7: CLI flags */

test('check 7: key add and key scope manage --per-minute, --expires and --disable/--enable, and key list prints them without leaking the key', (t) => {
  const MAIN = mint();
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);

  const add = sb.run('key', 'add', 'ci', '--per-minute', '30', '--expires', '2027-01-31');
  assert.equal(add.status, 0, add.stderr);
  const ciEntry = sb.read().auth.keys[1];
  assert.equal(ciEntry.label, 'ci');
  assert.equal(ciEntry.perMinute, 30);
  assert.equal(ciEntry.expires, '2027-01-31');

  const list = sb.run('key', 'list');
  assert.equal(list.status, 0, list.stderr);
  const ciLine = list.stdout.trim().split('\n')[1];
  assert.ok(ciLine.startsWith(redactKey(ciEntry.key)), ciLine);
  assert.match(ciLine, /30 requests\/minute/);
  assert.match(ciLine, /2027-01-31/);

  const ciFp = fingerprint(ciEntry.key);
  assert.equal(sb.run('key', 'scope', `fp:${ciFp}`, '--disable').status, 0);
  assert.equal(sb.read().auth.keys[1].disabled, true);
  assert.match(sb.run('key', 'list').stdout, /disabled/);

  assert.equal(sb.run('key', 'scope', `fp:${ciFp}`, '--clear').status, 0);
  assert.equal(sb.read().auth.keys[1].perMinute, 30, '--clear preserves perMinute');
  assert.equal(sb.read().auth.keys[1].expires, '2027-01-31', '--clear preserves expires');
  assert.equal(sb.read().auth.keys[1].disabled, true, '--clear preserves disabled');

  assert.equal(sb.run('key', 'scope', `fp:${ciFp}`, '--no-per-minute', '--no-expires', '--enable', '--no-label').status, 0);
  assert.equal(sb.read().auth.keys[1], ciEntry.key, 'collapses back to bare string when all fields cleared');

  for (const bad of [
    ['--per-minute', 'abc'],
    ['--per-minute', '1.5'],
    ['--per-minute', '5', '--no-per-minute'],
    ['--expires', 'tomorrow'],
    ['--expires', '2027-02-29'],
    ['--expires', '2027-01-31', '--no-expires'],
    ['--disable', '--enable'],
  ]) {
    assert.equal(sb.run('key', 'scope', `fp:${ciFp}`, ...bad).status, 1, bad.join(' '));
  }

  for (const k of [MAIN, ciEntry.key]) assertNoKey(sb.outputs.join('\n'), k, 'CLI key add/scope/list');
});

/* ----------------------------------------------------- check 8: status page, login & usage */

test('check 8: /status (unscoped) and keysmith usage show expired/disabled next to fingerprint, and cookie login refuses disabled/expired keys', async (t) => {
  const upRoot = await upstreamServer(t);
  const OWNER = mint();
  const EXPIRED = mint();
  const DISABLED = mint();
  const RPM_ONLY = mint();
  const keys = [
    OWNER,
    { key: EXPIRED, label: 'old-ci', expires: '2026-01-15' },
    { key: DISABLED, label: 'paused', disabled: true },
    { key: RPM_ONLY, label: 'burst', perMinute: 12 },
  ];
  const sb = sandbox(keys);
  t.after(sb.cleanup);
  const clock = { t: Date.parse('2026-10-20T12:00:00Z') };
  const gw = await gateway(t, { keys, dir: sb.data, clock, upRoot });

  const page = await gw.call(OWNER, '/status');
  assert.equal(page.status, 200);
  const expRow = page.text.split('<tr>').find((row) => row.includes(`fp:${fingerprint(EXPIRED)}`));
  const disRow = page.text.split('<tr>').find((row) => row.includes(`fp:${fingerprint(DISABLED)}`));
  const rpmRow = page.text.split('<tr>').find((row) => row.includes(`fp:${fingerprint(RPM_ONLY)}`));
  assert.ok(expRow && /fp:[0-9a-f]{8}[^<]*(?:<[^>]+>)*expired/.test(expRow), expRow);
  assert.ok(disRow && /fp:[0-9a-f]{8}[^<]*(?:<[^>]+>)*disabled/.test(disRow), disRow);
  assert.ok(rpmRow && /12\/min/.test(rpmRow), rpmRow);

  // Disabled and expired keys cannot open /status via header or cookie login.
  assert.equal((await gw.call(DISABLED, '/status')).status, 403);
  assert.equal((await gw.call(EXPIRED, '/status')).status, 401);
  const loginDis = await fetch(`${gw.base}/status`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: DISABLED }).toString(),
  });
  assert.equal(loginDis.status, 403);
  const loginExp = await fetch(`${gw.base}/status`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: EXPIRED }).toString(),
  });
  assert.equal(loginExp.status, 401);

  // `keysmith usage` lists keys that have only expires, disabled or perMinute (without perDay).
  const usageOut = sb.run('usage');
  assert.equal(usageOut.status, 0, usageOut.stderr);
  assert.match(usageOut.stdout, new RegExp(`fp:${fingerprint(EXPIRED)}.*expired`));
  assert.match(usageOut.stdout, new RegExp(`fp:${fingerprint(DISABLED)}.*disabled`));
  assert.match(usageOut.stdout, new RegExp(`fp:${fingerprint(RPM_ONLY)}.*12/min`));

  for (const k of [OWNER, EXPIRED, DISABLED, RPM_ONLY]) {
    assertNoKey(page.text + usageOut.stdout, k, 'status page and keysmith usage');
  }
});

/* ------------------------ order of refusals, MinuteLimiter, batch & mcp */

test('order of refusals (disabled -> expired -> perMinute -> perDay), MinuteLimiter unit, batch --key guard, and MCP key redaction', async (t) => {
  // MinuteLimiter unit
  const clock = { t: 100_000 };
  const lim = new MinuteLimiter({ now: () => clock.t });
  assert.equal(lim.admit('fp1', 2).ok, true);
  assert.equal(lim.admit('fp1', 2).ok, true);
  const third = lim.admit('fp1', 2);
  assert.equal(third.ok, false);
  assert.equal(third.retryAfter, 60);
  assert.equal(describePerMinute(1), '1 request/minute');
  assert.equal(describePerMinute(30), '30 requests/minute');

  // Order of refusals on server: disabled (403) before expired (401) before perMinute (429) before perDay (429)
  const upRoot = await upstreamServer(t);
  const dir = tmp(t);
  const BOTH_DEAD = mint();
  const EXP_AND_CAP = mint();
  const RPM_AND_DAY = mint();
  const gwClock = { t: Date.parse('2026-10-20T12:00:00Z') };
  const gw = await gateway(t, {
    keys: [
      { key: BOTH_DEAD, disabled: true, expires: '2020-01-01', perMinute: 0, perDay: 0 },
      { key: EXP_AND_CAP, expires: '2020-01-01', perMinute: 0, perDay: 0 },
      { key: RPM_AND_DAY, perMinute: 0, perDay: 0 },
    ],
    dir,
    clock: gwClock,
    upRoot,
  });
  assert.equal((await gw.call(BOTH_DEAD, '/v1/chat/completions', say())).status, 403);
  assert.equal((await gw.call(EXP_AND_CAP, '/v1/chat/completions', say())).status, 401);
  const rRpm = await gw.call(RPM_AND_DAY, '/v1/chat/completions', say());
  assert.equal(rRpm.status, 429);
  assert.match(rRpm.json().error.message, /per-minute/);

  // Batch refuses disabled and expired keys
  const jobsFile = path.join(dir, 'jobs.jsonl');
  fs.writeFileSync(jobsFile, JSON.stringify({ custom_id: 'r1', params: { model: 'claude-x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } }) + '\n');
  const batchCfg = {
    batch: { enabled: true },
    auth: {
      enabled: true,
      keys: [
        { key: BOTH_DEAD, label: 'dis', disabled: true },
        { key: EXP_AND_CAP, label: 'exp', expires: '2020-01-01' },
      ],
    },
    adapters: { cl: { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-' + 'test-batch-cred' } },
    pricing: { 'cl/claude-x': { input: 1, output: 1 } },
  };
  await assert.rejects(() => batchSubmit(batchCfg, { name: 'j1', file: jobsFile, adapterId: 'cl', capUsd: 5, keyRef: 'dis' }), BatchError);
  await assert.rejects(() => batchSubmit(batchCfg, { name: 'j2', file: jobsFile, adapterId: 'cl', capUsd: 5, keyRef: 'exp' }), BatchError);

  // MCP redaction treats perMinute, expires and disabled objects as auth key entries
  const secretA = mint();
  const secretB = mint();
  const secretC = mint();
  for (const [obj, k] of [
    [{ key: secretA, perMinute: 10 }, secretA],
    [{ key: secretB, expires: '2027-01-31' }, secretB],
    [{ key: secretC, disabled: true }, secretC],
  ]) {
    const scrubbed = JSON.stringify(redactMcpValue(obj));
    assertNoKey(scrubbed, k, 'redactMcpValue');
  }
});
