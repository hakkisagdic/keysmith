/**
 * Per-key daily token cap (`tokensPerDay`) and `keysmith key usage fp:<x> --json`. Synthetic keys
 * built at run time, a stub upstream, an injectable clock and temporary data directories.
 */
import { test, after } from 'node:test';
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
import { fingerprint } from '../src/redact.js';
import { parseKeys } from '../src/keys.js';
import { DailyQuota, rowTokens } from '../src/quota.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-token-cap-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const row = (ts, extra = {}) => JSON.stringify({ ts: new Date(ts).toISOString(), model: 'up/m', status: 'ok', bytesIn: 0, bytesOut: 0, ...extra }) + '\n';
function usageFile(rows) {
  const f = path.join(tmp(), 'usage.jsonl');
  fs.writeFileSync(f, rows.join(''));
  return f;
}

/* ---------------------------------------------------------------- K1, K2, K3: quota */

test('K1: a key at its token cap is refused until local midnight, one token under it is let in', () => {
  const clock = { t: at(2026, 10, 20, 14, 0, 0) };
  const KEY = fingerprint(mint());
  const mk = (n) => {
    const f = usageFile([row(clock.t - 1000, { key: `fp:${KEY}`, usage: { input: n - 400, output: 400 } })]);
    const q = new DailyQuota({ now: () => clock.t });
    q.seed(new UsageLog(f, { now: () => clock.t }));
    return q;
  };
  const full = mk(1000).admitTokens(KEY, 1000);
  assert.equal(full.ok, false);
  assert.equal(full.retryAfter, 10 * 3600);
  assert.equal(full.first, true);
  assert.equal(mk(999).admitTokens(KEY, 1000).ok, true);
  assert.equal(mk(1000).admitTokens(KEY, null).ok, true, 'no cap: always let in');
});

test('K2: a row without token counts is estimated from bytes, never zero, and flagged', () => {
  assert.deepEqual(rowTokens({ usage: null, bytesIn: 4000, bytesOut: 1 }), { tokens: 1001, estimated: true });
  assert.deepEqual(rowTokens({ bytesIn: 0, bytesOut: 0 }), { tokens: 1, estimated: true });
  assert.deepEqual(rowTokens({ usage: { input: 3, output: null }, bytesIn: 8, bytesOut: 0 }), { tokens: 2, estimated: true });
  assert.deepEqual(rowTokens({ usage: { input: 3, output: 4 }, bytesIn: 900 }), { tokens: 7, estimated: false });
  assert.deepEqual(rowTokens({ cache: 'hit', usage: { input: 3, output: 4 } }), { tokens: 0, estimated: false });
  assert.deepEqual(rowTokens({ cache: 'hit-semantic', bytesIn: 40 }), { tokens: 0, estimated: false });
  const clock = { t: at(2026, 10, 20, 14, 0, 0) };
  const f = usageFile([row(clock.t - 1000, { key: 'fp:aaaaaaaa', usage: null, bytesIn: 4000, bytesOut: 1 }), row(clock.t - 900, { key: 'fp:aaaaaaaa', status: 'limited', limit: 'tokens', bytesOut: 999 })]);
  const q = new DailyQuota({ now: () => clock.t });
  q.seed(new UsageLog(f, { now: () => clock.t }));
  assert.deepEqual(q.today('aaaaaaaa'), { requests: 1, refused: 0 });
  assert.deepEqual(q.tokensToday('aaaaaaaa'), { tokens: 1001, tokensEstimated: true });
});

test('K3: the count survives a restart and starts again at 0 after local midnight', () => {
  const clock = { t: at(2026, 10, 20, 14, 0, 0) };
  const f = usageFile([
    row(at(2026, 10, 19, 23, 0, 0), { key: 'fp:bbbbbbbb', usage: { input: 5000, output: 5000 } }), // yesterday: never counted
    row(clock.t - 5000, { key: 'fp:bbbbbbbb', usage: { input: 30, output: 20 } }),
    row(clock.t - 4000, { key: 'fp:bbbbbbbb', usage: { input: 1, output: 1 } }),
  ]);
  const first = new DailyQuota({ now: () => clock.t });
  first.seed(new UsageLog(f, { now: () => clock.t }));
  const again = new DailyQuota({ now: () => clock.t });
  again.seed(new UsageLog(f, { now: () => clock.t }));
  assert.equal(first.tokensToday('bbbbbbbb').tokens, 52);
  assert.equal(again.tokensToday('bbbbbbbb').tokens, 52);
  again.addTokens('bbbbbbbb', 10, true);
  assert.equal(again.tokensToday('bbbbbbbb').tokens, 62);
  assert.equal(again.tokensToday('bbbbbbbb').tokensEstimated, true);
  clock.t = at(2026, 10, 21, 0, 0, 1);
  assert.deepEqual(again.tokensToday('bbbbbbbb'), { tokens: 0, tokensEstimated: false });
  assert.equal(again.admitTokens('bbbbbbbb', 1).ok, true);
});

/* ---------------------------------------------------------------- K4: parsing, fail closed */

test('K4: an invalid tokensPerDay, or two entries with different values, reaches nothing', () => {
  for (const bad of ['1000', -1, 1.5, null, true]) {
    const k = mint();
    const { entries, issues } = parseKeys([{ key: k, tokensPerDay: bad }]);
    assert.equal(entries[0].scope.invalid !== null && entries[0].scope.invalid !== undefined, true, `${JSON.stringify(bad)} reaches nothing`);
    assert.match(issues[0], /tokensPerDay/);
    assert.ok(!issues.join('\n').includes(k));
  }
  const ok = parseKeys([{ key: mint(), tokensPerDay: 0 }, { key: mint(), tokensPerDay: 200000, label: 'x' }]);
  assert.equal(ok.issues.length, 0);
  assert.deepEqual(ok.entries.map((e) => e.tokensPerDay), [0, 200000]);
  const k = mint();
  const dup = parseKeys([{ key: k, tokensPerDay: 10 }, { key: k, tokensPerDay: 20 }]);
  assert.match(dup.issues[0], /different token caps/);
  assert.ok(dup.entries.every((e) => e.scope.invalid));
  const same = parseKeys([{ key: k, tokensPerDay: 10 }, { key: k, tokensPerDay: 10 }]);
  assert.equal(same.issues.length, 0);
  const unknown = parseKeys([{ key: mint(), tokenPerDay: 5 }]);
  assert.match(unknown.issues[0], /tokensPerDay/);
});

/* ---------------------------------------------------------------- K5: key usage --json */

function sandbox(keys, rows = []) {
  const home = tmp();
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys }, adapters: { up: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false, models: ['m'] } }, aliases: {} }), { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'usage.jsonl'), rows.join(''), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  return { config, run: (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 }) };
}

test('K5: key usage --json prints one line with exactly the fields, exit 2 for an unknown fingerprint, never the key', () => {
  const KEY = mint();
  const fp = fingerprint(KEY);
  const now = Date.now();
  const sb = sandbox([{ key: KEY, label: 'zihin', perDay: 150, tokensPerDay: 5000 }], [
    row(now - 2000, { key: `fp:${fp}`, usage: { input: 100, output: 20 } }),
    row(now - 1500, { key: `fp:${fp}`, usage: null, bytesIn: 400, bytesOut: 0 }),
    row(now - 1000, { key: `fp:${fp}`, status: 'limited', limit: 'tokens' }),
    row(now - 900, { key: 'fp:cccccccc', usage: { input: 9, output: 9 } }),
  ]);
  const r = sb.run('key', 'usage', `fp:${fp}`, '--json');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(j), ['fp', 'label', 'requests', 'perDay', 'tokens', 'tokensEstimated', 'tokensPerDay', 'refused', 'resets_at']);
  assert.equal(j.fp, fp);
  assert.equal(j.label, 'zihin');
  assert.equal(j.requests, 2);
  assert.equal(j.perDay, 150);
  assert.equal(j.tokens, 220);
  assert.equal(j.tokensEstimated, true);
  assert.equal(j.tokensPerDay, 5000);
  assert.equal(j.refused, 1);
  assert.ok(Date.parse(j.resets_at) > now);
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
  const unknown = sb.run('key', 'usage', 'fp:deadbeef', '--json');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no key matched/);
  assert.ok(!(unknown.stdout + unknown.stderr).includes(KEY));
  // The flag before the fingerprint reads the same.
  assert.equal(sb.run('key', 'usage', '--json', `fp:${fp}`).status, 0);
});

test('key add and key scope set, show and lift --tokens-per-day', () => {
  const KEY = mint();
  const fp = fingerprint(KEY);
  const sb = sandbox([{ key: KEY, label: 'a' }]);
  const set = sb.run('key', 'scope', `fp:${fp}`, '--tokens-per-day', '200000');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /200000 tokens\/day/);
  assert.equal(JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys[0].tokensPerDay, 200000);
  assert.match(sb.run('key', 'list').stdout, /200000 tokens\/day/);
  assert.notEqual(sb.run('key', 'scope', `fp:${fp}`, '--tokens-per-day', 'many').status, 0);
  assert.notEqual(sb.run('key', 'scope', `fp:${fp}`, '--tokens-per-day', '5', '--no-tokens-per-day').status, 0);
  const lift = sb.run('key', 'scope', `fp:${fp}`, '--no-tokens-per-day');
  assert.equal(lift.status, 0, lift.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys[0].tokensPerDay, undefined);
  const add = sb.run('key', 'add', 'b', '--tokens-per-day', '77');
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /77 tokens\/day/);
});

/* ---------------------------------------------------------------- K7: end to end */

let upstreamHits = 0;
function upstream(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'up answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 30 } }));
  });
}

test('K7: a key over its token cap is refused 429 before the upstream is hit; cache hits stay free', async (t) => {
  const up = http.createServer(upstream);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => up.close(r)));
  const KEY = mint();
  const OTHER = mint();
  const fp = fingerprint(KEY);
  const clock = { t: at(2026, 10, 20, 14, 0, 0) };
  const now = () => clock.t;
  const keys = [OTHER, { key: KEY, label: 'capped', tokensPerDay: 100 }];
  const cfg = {
    auth: { enabled: true, keys },
    limits: { streamHoldMs: 250 },
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    adapters: { up: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${up.address().port}/up/v1`, apiKey: false, models: ['m'] } },
    aliases: {},
  };
  const usage = new UsageLog(path.join(tmp(), 'usage.jsonl'), { now });
  const server = createServer(new Gateway(cfg), cfg, { usage, log: () => {}, now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, body) => {
    const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const say = (c, extra = {}) => ({ model: 'up/m', messages: [{ role: 'user', content: c }], temperature: 0, ...extra });
  const status = async () => {
    const u = await (await fetch(`${base}/v1/keysmith/usage`, { headers: { authorization: `Bearer ${OTHER}` } })).json();
    const d = u.daily.find((x) => x.fp === fp);
    return { tokensPerDay: d.tokensPerDay, today: { tokens: d.tokens } };
  };

  const first = await call(KEY, say('one'));
  assert.equal(first.status, 200, first.text);
  assert.equal(upstreamHits, 1);
  let k = await status();
  assert.equal(k.tokensPerDay, 100);
  assert.equal(k.today.tokens, 60);
  // 60 < 100: let in (it may overshoot by its own size), now at 120.
  assert.equal((await call(KEY, say('two'))).status, 200);
  assert.equal(upstreamHits, 2);
  assert.equal((await status()).today.tokens, 120);
  // The cap is checked first, before the body is read or the cache is asked: even a new body is refused.
  const hitsBefore = upstreamHits;
  const refused = await call(KEY, say('three'));
  assert.equal(refused.status, 429, refused.text);
  assert.equal(upstreamHits, hitsBefore, 'refused before the upstream');
  assert.equal(Number(refused.headers.get('retry-after')), 10 * 3600);
  assert.match(JSON.parse(refused.text).error.message, /daily cap of 100 tokens/);
  assert.ok(!refused.text.includes(KEY) && !refused.text.includes(fp) && !refused.text.includes('capped'));
  await call(KEY, say('three'));
  const limited = fs.readFileSync(usage.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.status === 'limited');
  assert.equal(limited.length, 1, 'one limited row per day');
  assert.equal(limited[0].limit, 'tokens');
  // Another key is untouched; a cache hit for it adds nothing to ITS count either.
  assert.equal((await call(OTHER, say('one'))).status, 200);
  assert.equal(upstreamHits, hitsBefore + 1);
  assert.equal((await call(OTHER, say('one'))).status, 200);
  assert.equal(upstreamHits, hitsBefore + 1, 'second identical request is a cache hit');
  // A restart rebuilds the same count from the usage file; midnight resets it.
  const q = new DailyQuota({ now });
  q.seed(usage);
  assert.equal(q.tokensToday(fp).tokens, 120);
  assert.equal(q.tokensToday(fingerprint(OTHER)).tokens, 60, 'the cache hit added 0');
  clock.t = at(2026, 10, 21, 0, 0, 5);
  assert.equal((await call(KEY, say('four'))).status, 200);
});
