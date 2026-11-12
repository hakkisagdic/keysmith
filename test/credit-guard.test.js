/**
 * The Kiro credit guard (src/credit-guard.js): the `/usage` parser, the threshold, the ten-minute
 * cache and rate limit, a failed reading that never blocks, and the gateway passing a held-back
 * leg by (a route) or answering a 429 (a request that names it). Every reading here is a fixture:
 * nothing runs kiro-cli, nothing spends a credit.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import {
  CREDIT_GUARD_TTL_MS,
  CreditGuard,
  DEFAULT_CREDIT_THRESHOLD,
  checkCreditGuard,
  creditGuardError,
  evaluateCredits,
  isKiroBin,
  parseKiroUsage,
  readCreditState,
  stripAnsi,
} from '../src/credit-guard.js';

/** What kiro-cli 2.27.1 printed for `chat --no-interactive /usage` (not a TTY: no colours). */
const LIVE = "Estimated Usage | resets on 2026-12-01 | KIRO POWER\nCredits (1524.71 of 10000 covered in plan), 15.2%\nYour plan is managed by your organization's administrator.\n";
const usageOf = (used, limit = 10000) => `Estimated Usage | resets on 2026-12-01 | KIRO POWER\nCredits (${used} of ${limit} covered in plan), ${((used / limit) * 100).toFixed(1)}%\n`;
/** The same on a terminal: bold, colours, a hidden cursor, a hyperlink. */
const COLOURED = '\u001b[?25l\u001b[1mEstimated Usage\u001b[0m | resets on \u001b[38;5;141m2026-12-01\u001b[0m | KIRO POWER\n\u001b[32mCredits\u001b[39m (\u001b[1m9,512.30\u001b[22m of \u001b[1m10,000\u001b[22m covered in plan), 95.1%\n\u001b]8;;https://kiro.dev\u0007kiro.dev\u001b]8;;\u0007\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------- parser */

test('parseKiroUsage: the live output, its terminal form, thousands separators — and never a guess', () => {
  assert.deepEqual(parseKiroUsage(LIVE), { used: 1524.71, limit: 10000, ratio: 0.152471, resetsOn: '2026-12-01' });
  const c = parseKiroUsage(COLOURED);
  assert.deepEqual([c.used, c.limit, c.resetsOn], [9512.3, 10000, '2026-12-01']);
  assert.ok(Math.abs(c.ratio - 0.95123) < 1e-9);
  assert.equal(parseKiroUsage('Credits (10000 of 10000 covered in plan), 100%').ratio, 1);
  assert.equal(parseKiroUsage('Credits (12000.5 of 10000 covered in plan)').ratio, 1.20005, 'overage reads as over the plan');
  assert.equal(parseKiroUsage('credits ( 7 of 10 COVERED IN PLAN )').ratio, 0.7, 'case and spacing');
  for (const bad of ['', 'Error: you are not logged in. Run kiro-cli login', 'Credits (x of 10000 covered in plan)', 'Credits (5 of 0 covered in plan)', 'Credits (5 of 10000)', null, undefined]) {
    assert.equal(parseKiroUsage(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseKiroUsage('Credits (5 of 10 covered in plan)').resetsOn, null, 'no reset date said: none made up');
});

test('stripAnsi: CSI, OSC and lone escapes go, the text stays', () => {
  assert.equal(stripAnsi('\u001b[1m\u001b[38;5;12mbold\u001b[0m'), 'bold');
  assert.equal(stripAnsi('\u001b]8;;https://x\u0007link\u001b]8;;\u0007'), 'link');
  assert.equal(stripAnsi('\u001b[?25lhidden\u001b[?25h'), 'hidden');
  assert.equal(stripAnsi('plain (1 of 2)'), 'plain (1 of 2)');
});

/* ------------------------------------------------------------------------ threshold */

test('evaluateCredits: at or over the threshold is held back, under it is not; no reading never is', () => {
  assert.equal(DEFAULT_CREDIT_THRESHOLD, 0.9);
  assert.deepEqual(evaluateCredits(parseKiroUsage(usageOf(8999)), 0.9), { blocked: false, ratio: 0.8999, threshold: 0.9 });
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(9000)), 0.9).blocked, true, 'at it');
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(9500)), 0.9).blocked, true);
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(9500)), 0.97).blocked, false, 'the adapter\'s own threshold');
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(10000)), 1).blocked, true, '1: only once the plan is spent');
  assert.deepEqual(evaluateCredits(null, 0.9), { blocked: false, ratio: null, threshold: 0.9 });
});

test('checkCreditGuard: every kiro-cli entry is guarded at 0.9 unless it says otherwise; a bad threshold, or one on another CLI, is a load error', () => {
  assert.deepEqual(checkCreditGuard('kiro', {}, '/Users/x/.local/bin/kiro-cli'), { kind: 'kiro', threshold: 0.9 });
  assert.deepEqual(checkCreditGuard('kiro-emu', { creditGuardThreshold: 0.75 }, 'kiro-cli'), { kind: 'kiro', threshold: 0.75 });
  assert.deepEqual(checkCreditGuard('k', { creditGuardThreshold: 1 }, 'kiro-cli'), { kind: 'kiro', threshold: 1 });
  assert.equal(checkCreditGuard('agy', {}, '/usr/local/bin/agy'), null);
  for (const bad of [0, -0.1, 1.5, '0.9', NaN, true]) {
    assert.throws(() => checkCreditGuard('kiro', { creditGuardThreshold: bad }, 'kiro-cli'), /creditGuardThreshold must be a fraction of the plan above 0 and at most 1/, String(bad));
  }
  assert.throws(() => checkCreditGuard('agy', { creditGuardThreshold: 0.9 }, 'agy'), /does not run kiro-cli/);
  assert.equal(isKiroBin('C:\\tools\\kiro-cli.exe'), true);
  assert.equal(isKiroBin('kiro-cli-wrapper'), false);
  // The adapter carries it, both of the owner's kinds.
  const kiro = new CliAdapter('kiro', { kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', args: ['{prompt}'] });
  const emu = new CliAdapter('kiro-emu', { kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', args: ['{prompt}'], cwd: path.join(os.tmpdir(), 'ks-cg-emu'), toolMode: 'emulate', creditGuardThreshold: 0.8 });
  assert.deepEqual([kiro.creditGuard, emu.creditGuard], [{ kind: 'kiro', threshold: 0.9 }, { kind: 'kiro', threshold: 0.8 }]);
  assert.throws(() => new CliAdapter('k', { kind: 'cli', bin: 'kiro-cli', creditGuardThreshold: 2 }), /creditGuardThreshold/);
});

/* ------------------------------------------------------------ cache and rate limit */

/** A guard on a hand-moved clock, its `/usage` a fixture that counts its runs. */
function rig({ outputs = [usageOf(1000)], firstWaitMs = 50, statePath = null } = {}) {
  let t = Date.parse('2026-11-12T10:00:00Z');
  const runs = [];
  const logs = [];
  const guard = new CreditGuard({
    now: () => t,
    firstWaitMs,
    statePath,
    log: (m) => logs.push(m),
    run: async (adapter) => {
      runs.push(adapter.id);
      const out = outputs[Math.min(runs.length - 1, outputs.length - 1)];
      if (out instanceof Error) throw out;
      if (typeof out === 'function') return out();
      return out;
    },
  });
  return { guard, runs, logs, advance: (ms) => (t += ms), now: () => t };
}
const kiroLike = (id, threshold = 0.9, extra = {}) => ({ id, kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', env: {}, creditGuard: { kind: 'kiro', threshold }, ...extra });

test('CreditGuard: one /usage per ten minutes per Kiro login, whatever asks; the reading is cached for ten minutes', async () => {
  const { guard, runs, advance } = rig({ outputs: [usageOf(1000), usageOf(9600)] });
  const kiro = kiroLike('kiro');
  const emu = kiroLike('kiro-emu');
  assert.equal((await guard.check(kiro)).ok, true);
  assert.equal((await guard.check(emu)).ok, true, 'kiro-emu shares the login, and the reading');
  assert.equal((await guard.check(kiro)).ok, true);
  assert.deepEqual(runs, ['kiro'], 'one run for both adapters');
  advance(CREDIT_GUARD_TTL_MS - 1);
  await guard.check(kiro);
  assert.equal(runs.length, 1, 'inside ten minutes: the cache');
  advance(1);
  // Stale: a new reading starts; this request is answered on the one it has, not made to wait.
  const v = await guard.check(kiro);
  assert.equal(v.ok, true);
  assert.equal(runs.length, 2);
  await sleep(0);
  const after = await guard.check(emu);
  assert.equal(after.ok, false, 'the new reading (96%) holds both back');
  assert.match(after.detail, /9,600 of 10,000 credits \(96%\), at or over this adapter's creditGuardThreshold of 90%/);
  assert.equal(runs.length, 2);
  const snap = guard.snapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].adapters, ['kiro', 'kiro-emu']);
  assert.equal(snap[0].reading.used, 9600);
  // Another login (another environment) is another plan, and another reading.
  await guard.check(kiroLike('kiro-work', 0.9, { env: { HOME: '/Users/work' } }));
  assert.equal(runs.length, 3);
});

test('CreditGuard: a reading that fails never blocks — logged, and not retried inside ten minutes', async () => {
  const { guard, runs, logs, advance } = rig({ outputs: [new Error('exited 1: not logged in'), 'Welcome to Kiro! (no usage line)', usageOf(9900)] });
  const kiro = kiroLike('kiro');
  let v = await guard.check(kiro);
  assert.deepEqual([v.ok, v.unknown], [true, true]);
  assert.match(v.error, /not logged in/);
  assert.ok(logs.some((l) => /kiro credit guard: reading the plan of kiro .* failed: exited 1: not logged in — not held back/.test(l)), logs.join('\n'));
  advance(5 * 60_000);
  await guard.check(kiro);
  assert.equal(runs.length, 1, 'a failure counts as the run of its ten minutes');
  advance(5 * 60_000);
  v = await guard.check(kiro);
  assert.equal(runs.length, 2);
  assert.equal(v.ok, true, 'output with no credits line: not a reading, not a block');
  assert.ok(logs.some((l) => /no "Credits \(X of Y covered in plan\)" line/.test(l)));
  advance(CREDIT_GUARD_TTL_MS);
  v = await guard.check(kiro);
  assert.equal(runs.length, 3);
  assert.equal(v.ok, false, 'a good reading at 99% holds it back');
  // The next reading fails: the 99% before it is not the plan now, so it is not held back.
  const { guard: g2, advance: adv2 } = rig({ outputs: [usageOf(9900), new Error('timed out after 30000 ms')] });
  assert.equal((await g2.check(kiro)).ok, false);
  adv2(CREDIT_GUARD_TTL_MS);
  await g2.check(kiro);
  await sleep(0);
  v = await g2.check(kiro);
  assert.deepEqual([v.ok, v.unknown], [true, true]);
  assert.match(v.error, /timed out/);
});

test('CreditGuard: a first reading is waited for at most firstWaitMs; an adapter with no guard is never read', async () => {
  let release;
  const { guard, runs } = rig({ outputs: [() => new Promise((r) => (release = r))], firstWaitMs: 30 });
  const t0 = Date.now();
  const v = await guard.check(kiroLike('kiro'));
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual([v.ok, v.unknown, v.error], [true, true, 'no reading yet']);
  release(usageOf(9950));
  await sleep(0);
  assert.equal((await guard.check(kiroLike('kiro'))).ok, false);
  assert.equal(runs.length, 1);
  assert.deepEqual(await guard.check({ id: 'agy', kind: 'cli', bin: 'agy', creditGuard: null }), { ok: true });
  assert.equal(runs.length, 1);
});

test('CreditGuard: a reading over an hour old is read again before it is answered on; one from before the plan reset never blocks after it', async () => {
  // Two hours on, a new reading comes back at once: the request is answered on it, not the old one.
  const a = rig({ outputs: [usageOf(9900), usageOf(100)] });
  assert.equal((await a.guard.check(kiroLike('kiro'))).ok, false);
  a.advance(2 * 60 * 60_000);
  const fresh = await a.guard.check(kiroLike('kiro'));
  assert.deepEqual([fresh.ok, fresh.reading.used], [true, 100]);
  // The plan reset (2026-12-01) since the 99% reading, and the new reading is slow to come.
  const b = rig({ outputs: [usageOf(9900), () => new Promise(() => {})], firstWaitMs: 20 });
  assert.equal((await b.guard.check(kiroLike('kiro'))).ok, false);
  b.advance(Date.parse('2026-12-01T00:30:00Z') - b.now());
  const v = await b.guard.check(kiroLike('kiro'));
  assert.deepEqual([v.ok, v.unknown], [true, true]);
  assert.match(v.error, /from before the plan reset on 2026-12-01/);
});

test('CreditGuard: with a state file the reading outlives the process — a restart inside ten minutes runs nothing; status reads it without a guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cg-'));
  try {
    const statePath = path.join(dir, 'credit-guard.json');
    const a = rig({ outputs: [usageOf(9300)], statePath });
    assert.equal((await a.guard.check(kiroLike('kiro'))).ok, false);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.version, 1);
    assert.doesNotMatch(JSON.stringify(saved), /env|HOME/, 'the login is a hash of its environment, never the environment');
    const b = rig({ outputs: [usageOf(100)], statePath });
    assert.equal((await b.guard.check(kiroLike('kiro'))).ok, false, 'the kept reading, still fresh');
    assert.equal(b.runs.length, 0);
    const [s] = readCreditState(statePath, { now: a.now() + 60_000 });
    assert.deepEqual([s.reading.used, s.adapters, s.ageMs], [9300, ['kiro'], 60_000]);
    assert.deepEqual(readCreditState(path.join(dir, 'missing.json')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creditGuardError: a 429 rate_limit_error that names the adapter, the plan and the threshold, retry-after at the plan\'s reset', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  const reading = parseKiroUsage(usageOf(9500));
  const err = creditGuardError({ id: 'kiro' }, { reading, ratio: reading.ratio, threshold: 0.9, detail: 'Kiro plan at 9,500 of 10,000 credits (95%), at or over this adapter\'s creditGuardThreshold of 90%' }, now);
  assert.equal(err.status, 429);
  assert.equal(err.type, 'rate_limit_error');
  assert.equal(err.provider, 'kiro');
  assert.match(err.message, /^kiro: held back by the kiro credit guard — Kiro plan at 9,500 of 10,000 credits \(95%\).*\(the plan resets on 2026-12-01\)/);
  assert.equal(err.retryAfter, (Date.parse('2026-12-01T00:00:00Z') - now) / 1000);
});

/* ---------------------------------------------------------------- through the gateway */

/** A CLI stand-in that answers in text, and counts what it was asked. */
function textAdapter(id, extra = {}) {
  const asked = [];
  return {
    asked,
    adapter: {
      id,
      kind: 'cli',
      bin: id === 'kiro' || id === 'kiro-emu' ? '/opt/kiro/bin/kiro-cli' : id,
      env: {},
      priority: 100,
      resumeArgs: null,
      resumable: false,
      disabled: false,
      explicitOnly: false,
      unsafeTools: false,
      timeoutMs: 10_000,
      _modelCache: null,
      creditGuard: null,
      async models() {
        return [{ id: 'm' }];
      },
      async *complete({ model }) {
        asked.push(model);
        yield { type: 'delta', text: `${id} answer` };
        yield { type: 'done', finishReason: 'stop' };
      },
      ...extra,
    },
  };
}

let dir, server, base, gateway, usageLog, plan;
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const log = [];
const kiro = textAdapter('kiro', { creditGuard: { kind: 'kiro', threshold: 0.9 } });
const other = textAdapter('other');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cg-gw-'));
  plan = usageOf(9600);
  const cfg = { auth: { enabled: true, keys: [KEY] }, limits: { streamHoldMs: 200, streamKeepaliveMs: 60 }, adapters: {}, aliases: { route: ['kiro/m', 'other/m'], kiroonly: ['kiro/m'] } };
  const guard = new CreditGuard({ run: async () => (plan instanceof Error ? Promise.reject(plan) : plan), firstWaitMs: 200, ttlMs: 0, log: (m) => log.push(m) });
  gateway = new Gateway(cfg, { log: (m) => log.push(m), creditGuard: guard });
  gateway.adapters.set('kiro', kiro.adapter);
  gateway.adapters.set('other', other.adapter);
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const lastRow = () => usageLog.tail(1)[0];
/** The plan says `out` from now on: read it (this guard's TTL is 0, so every check also reads again, in the background). */
async function planSays(out) {
  plan = out;
  await gateway.creditGuard.refresh(kiro.adapter);
}

test('a route passes a held-back kiro leg by and the next leg answers; the row says which leg, why, and at what share of the plan', async () => {
  plan = usageOf(9600); // the first reading: the request waits for it (firstWaitMs)
  const before = kiro.asked.length;
  for (const [route, body] of [
    ['/v1/chat/completions', { model: 'route', messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/chat/completions', { model: 'route', stream: true, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/messages', { model: 'route', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }],
  ]) {
    const r = await post(route, body);
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /other answer/);
    const row = lastRow();
    assert.equal(row.status, 'ok');
    assert.equal(row.skippedLegs.length, 1, JSON.stringify(row));
    const [s] = row.skippedLegs;
    assert.deepEqual([s.target, s.reason, s.ratio, s.threshold], ['kiro/m', 'credit_guard', 0.96, 0.9]);
    assert.match(s.detail, /9,600 of 10,000 credits \(96%\)/);
  }
  assert.equal(kiro.asked.length, before, 'kiro was never run');
  assert.ok(log.some((l) => /kiro\/m passed by \(credit_guard\)/.test(l)));
  const res = await gateway.collect({ model: 'route', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(res.skippedLegs.map((x) => x.reason), ['credit_guard']);
});

test('a request that names a held-back kiro leg is a 429 that says why; under the threshold, or with no reading, kiro answers', async () => {
  await planSays(usageOf(9600));
  let r = await post('/v1/messages', { model: 'kiro/m', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 429, r.text);
  const body = JSON.parse(r.text);
  assert.equal(body.type, 'error', 'the Anthropic error shape');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /kiro: held back by the kiro credit guard — Kiro plan at 9,600 of 10,000 credits \(96%\), at or over this adapter's creditGuardThreshold of 90%/);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.deepEqual(lastRow().skippedLegs.map((x) => x.reason), ['credit_guard']);
  // An alias of kiro alone: the same 429.
  r = await post('/v1/chat/completions', { model: 'kiroonly', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 429, r.text);
  // Under the threshold: kiro answers, and nothing is passed by.
  await planSays(usageOf(8999));
  r = await post('/v1/chat/completions', { model: 'route', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /kiro answer/);
  assert.equal('skippedLegs' in lastRow(), false);
  // The reading fails: never a block, the failure logged.
  await planSays(new Error('exited 1: kiro-cli is not logged in'));
  r = await post('/v1/chat/completions', { model: 'kiro/m', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /kiro answer/);
  assert.ok(log.some((l) => /kiro credit guard: reading the plan of kiro .*not logged in — not held back/.test(l)));
});
