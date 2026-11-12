/**
 * Windowed spend caps (`limits.spend` `{ usd, since, until }`, src/usage.js): one total over a
 * window of UTC days — a promotional grant that expires — instead of a monthly cap, across the
 * month turn, refusing outside the window and when the window is not one.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { UsageLog, formatUsageTable, parseSpendCaps, parseSpendWindow } from '../src/usage.js';

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-spendwin-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const row = (ts, usd, extra = {}) => JSON.stringify({ ts, adapter: 'claude-api', kind: 'http', model: 'claude-api/claude-opus-5-5', status: 'ok', ms: 10, cost: { usd, basis: 'metered' }, ...extra });
const WINDOW = { usd: 25, since: '2026-11-12', until: '2026-12-09' };
const API = { id: 'claude-api', kind: 'http' };

test('parseSpendWindow: UTC days, until after since; anything else is an invalid window, never no cap', () => {
  assert.deepEqual(parseSpendWindow('2026-11-12', '2026-12-09'), { since: '2026-11-12', until: '2026-12-09', sinceMs: Date.parse('2026-11-12T00:00:00Z'), untilMs: Date.parse('2026-12-09T00:00:00Z') });
  for (const [since, until] of [['2026-11-12', undefined], [undefined, '2026-12-09'], ['2026-11-12', '2026-02-30'], ['2026-11-12', '2026-12-09T12:00:00Z'], ['12/11/2026', '2026-12-09'], [20261112, '2026-12-09']]) {
    assert.match(parseSpendWindow(since, until).invalid, /takes both since and until as UTC days \(YYYY-MM-DD\)/, `${since} ${until}`);
  }
  assert.match(parseSpendWindow('2026-12-09', '2026-12-09').invalid, /until \(2026-12-09\) must be a day after since \(2026-12-09\)/);
  // In limits.spend: a window on the object form only; a plain number stays monthly.
  const caps = parseSpendCaps({ 'claude-api': WINDOW, other: 10, broken: { usd: 5, until: '2026-12-09' } }, { 'claude-api': {}, other: {}, broken: {} });
  assert.deepEqual(caps.map((c) => [c.target, c.cap, c.window?.since ?? null, !!c.window?.invalid]), [['claude-api', 25, '2026-11-12', false], ['other', 10, null, false], ['broken', 5, null, true]]);
});

test('a windowed cap is one total over its days, across the month turn: spend before since and from until on is not counted', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.jsonl');
  // November is archived; December is the active file.
  fs.writeFileSync(`${file}.2026-11`, [row('2026-11-11T23:59:59.000Z', 100), row('2026-11-12T00:00:00.000Z', 4), row('2026-11-30T10:00:00.000Z', 6)].join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(file, [row('2026-12-01T00:00:01.000Z', 5), row('2026-12-08T23:59:59.000Z', 3)].join('\n') + '\n', { mode: 0o600 });
  let now = Date.parse('2026-12-05T12:00:00Z');
  const usage = new UsageLog(file, { now: () => now });
  const spend = { 'claude-api': WINDOW };
  // 4 + 6 (November, from the 12th) + 5 + 3 (December) = 18 of 25: open.
  assert.equal(usage.checkSpendCap(spend, API), null);
  const [s] = usage.spendSummary(spend, { adapters: { 'claude-api': {} } });
  assert.deepEqual([s.spent, s.cap, s.remaining, s.exceeded, s.windowStatus, s.window, s.month, s.resetAt], [18, 25, 7, false, 'open', { since: '2026-11-12', until: '2026-12-09' }, null, null]);
  // The same spend under a monthly cap of 25 counts December only (8): the window is what differs.
  assert.equal(usage.spendSummary({ 'claude-api': 25 }, { adapters: { 'claude-api': {} } })[0].spent, 8);
  // A row recorded now counts at once; at 25 the cap refuses, and says it never resets.
  usage.record({ adapter: 'claude-api', kind: 'http', model: 'claude-api/claude-opus-5-5', status: 'ok', ms: 5, cost: { usd: 7, basis: 'metered' } });
  const capped = usage.checkSpendCap(spend, API);
  assert.deepEqual([capped.spent, capped.cap, capped.windowStatus, capped.resetAt, capped.retryAfter], [25, 25, 'spent', null, 3600]);
  assert.match(formatUsageTable({ totals: null, rows: [] }, { spend: usage.spendSummary(spend, { adapters: { 'claude-api': {} } }) }), /spend caps:\n {2}adapter claude-api {2}\$25\.00 \/ \$25\.00 {2}CAPPED \(total 2026-11-12 … 2026-12-09, until excluded\)/);
  // From until on, the window is closed: refused, whatever was spent.
  now = Date.parse('2026-12-09T00:00:00Z');
  const fresh = new UsageLog(file, { now: () => now });
  assert.equal(fresh.checkSpendCap({ 'claude-api': { usd: 1000, since: '2026-11-12', until: '2026-12-09' } }, API).windowStatus, 'closed');
  // Before since, it has not opened: refused, retry-after until it opens.
  now = Date.parse('2026-11-11T23:00:00Z');
  const early = new UsageLog(file, { now: () => now });
  const notOpen = early.checkSpendCap(spend, API);
  assert.deepEqual([notOpen.windowStatus, notOpen.retryAfter], ['not open', 3600]);
});

test('a windowed cap counts what is in flight while it is open, and keeps a closed month across the rollover', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.jsonl');
  let now = Date.parse('2026-11-30T23:00:00Z');
  const usage = new UsageLog(file, { now: () => now, pricing: { 'claude-api/claude-opus-5-5': { input: 5, output: 25 } } });
  const spend = { 'claude-api': { usd: 10, since: '2026-11-12', until: '2026-12-09' } };
  usage.record({ adapter: 'claude-api', kind: 'http', model: 'claude-api/claude-opus-5-5', status: 'ok', ms: 5, cost: { usd: 6, basis: 'metered' } });
  // The month turns; the first row of December rolls usage.jsonl over to usage.jsonl.2026-11.
  now = Date.parse('2026-12-01T00:30:00Z');
  usage.record({ adapter: 'claude-api', kind: 'http', model: 'claude-api/claude-opus-5-5', status: 'ok', ms: 5, cost: { usd: 3, basis: 'metered' } });
  assert.ok(fs.existsSync(`${file}.2026-11`), 'rolled over');
  assert.equal(usage.spendSummary(spend, { adapters: { 'claude-api': {} } })[0].spent, 9, 'November kept, December added');
  assert.equal(usage.checkSpendCap(spend, API), null);
  // A request in flight holds its estimate: 9 + 1.25 (50k in / 40k out at 5/25) ≥ 10 refuses the next one.
  const release = usage.reserveSpend(spend, API, { model: 'claude-api/claude-opus-5-5', inputTokens: 50_000, outputTokens: 40_000 });
  assert.equal(usage.checkSpendCap(spend, API)?.windowStatus, 'spent');
  release();
  assert.equal(usage.checkSpendCap(spend, API), null);
  // A new process reads both months from disk and agrees.
  assert.equal(new UsageLog(file, { now: () => now }).spendSummary(spend, { adapters: { 'claude-api': {} } })[0].spent, 9);
});

test('an invalid window refuses every request, and an unreadable month in the window fails closed', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.jsonl');
  fs.writeFileSync(file, row('2026-12-02T00:00:00.000Z', 1) + '\n', { mode: 0o600 });
  const now = Date.parse('2026-12-02T12:00:00Z');
  const usage = new UsageLog(file, { now: () => now });
  const bad = usage.checkSpendCap({ 'claude-api': { usd: 25, since: '2026-11-12' } }, API);
  assert.equal(bad.windowStatus, 'invalid');
  assert.match(bad.error, /takes both since and until/);
  // November's archive is a directory: unreadable, so the cap refuses rather than counting $0.
  fs.mkdirSync(`${file}.2026-11`);
  const unreadable = usage.checkSpendCap({ 'claude-api': WINDOW }, API);
  assert.equal(unreadable.windowStatus, 'unreadable');
  assert.ok(unreadable.error);
  // A monthly cap of the same adapter reads December only, and is unaffected.
  assert.equal(usage.checkSpendCap({ 'claude-api': 25 }, API), null);
});

test('through the gateway: a spent windowed cap is a 429 that names its window, and a route passes the leg by to the next', async () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.jsonl');
  fs.writeFileSync(file, row('2026-11-12T08:00:00.000Z', 25) + '\n', { mode: 0o600 });
  const now = Date.parse('2026-11-12T12:00:00Z');
  const usage = new UsageLog(file, { now: () => now });
  const stub = (id) => ({
    id,
    kind: 'cli',
    bin: id,
    env: {},
    priority: 100,
    resumable: false,
    disabled: false,
    explicitOnly: false,
    unsafeTools: false,
    timeoutMs: 10_000,
    creditGuard: null,
    async models() {
      return [{ id: 'm' }];
    },
    async *complete() {
      yield { type: 'delta', text: `${id} answer` };
      yield { type: 'done', finishReason: 'stop' };
    },
  });
  const cfg = { adapters: {}, limits: { spend: { 'claude-api': WINDOW } }, aliases: { failover: ['claude-api/m', 'other/m'] } };
  const gateway = new Gateway(cfg, { usage, now: () => now });
  gateway.adapters.set('claude-api', stub('claude-api'));
  gateway.adapters.set('other', stub('other'));
  await assert.rejects(gateway.collect({ model: 'claude-api/m', messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.retryAfter, 3600);
    assert.match(e.message, /spend cap reached for adapter "claude-api": spent \$25\.00 of \$25\.00 in total from 2026-11-12 until 2026-12-09/);
    return true;
  });
  const res = await gateway.collect({ model: 'failover', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(res.text, /other answer/);
});
