/**
 * A failed usage-log append still counts toward `limits.spend`, and the process warns once.
 * The log path is replaced with a directory so the append throws; the row is never on disk.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLog, _resetUsageWarningForTests } from '../src/usage.js';

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-usewrite-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const FIXED_MS = Date.parse('2026-12-05T12:00:00Z');
const PRICING = { 'claude-api/claude-opus-5-5': { input: 5, output: 25 } };
const SPEND = { 'claude-api': 25 };
const ADAPTERS = { 'claude-api': {} };
const WARNING = /^keysmith: usage log not written \([A-Z][A-Z0-9_]{0,31}\): spend caps count this request in memory only$/;

function logAt(file) {
  return new UsageLog(file, { now: () => FIXED_MS, pricing: PRICING });
}

function pricedRow(usd, extra = {}) {
  return {
    adapter: 'claude-api',
    kind: 'http',
    model: 'claude-api/claude-opus-5-5',
    status: 'ok',
    ms: 5,
    cost: { usd, basis: 'metered' },
    ...extra,
  };
}

function spentOf(usage) {
  const [s] = usage.spendSummary(SPEND, { adapters: ADAPTERS });
  assert.equal(s.target, 'claude-api');
  return s.spent;
}

/** Directory where the log file was, so the next append cannot create it. */
function replaceWithDirectory(file) {
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file);
}

function watchStderr(t) {
  _resetUsageWarningForTests();
  const lines = [];
  const prev = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.error = prev;
    _resetUsageWarningForTests();
  });
  return lines;
}

test('K1 K2: a failed append still counts a 5 USD row, and record returns undefined', (t) => {
  watchStderr(t);
  const file = path.join(tmp(), 'usage.jsonl');
  const usage = logAt(file);
  usage.record(pricedRow(1));
  assert.equal(spentOf(usage), 1);
  replaceWithDirectory(file);
  let returned = 'unset';
  assert.doesNotThrow(() => {
    returned = usage.record(pricedRow(5));
  });
  assert.equal(returned, undefined);
  assert.equal(fs.statSync(file).isDirectory(), true);
  const spent = spentOf(usage);
  assert.ok(spent >= 5, `spent ${spent}`);
  assert.equal(spent, 6);
});

test('K3: two failing records warn once, with no row and no key', (t) => {
  const lines = watchStderr(t);
  const file = path.join(tmp(), 'usage.jsonl');
  fs.mkdirSync(file);
  const usage = logAt(file);
  const markerA = ['row', 'one', 'body'].join('-');
  const markerB = ['row', 'two', 'body'].join('-');
  const keyLike = ['sk', 'live', 'notreal'].join('-');
  usage.record(pricedRow(5, { tag: markerA, account: keyLike }));
  usage.record(pricedRow(5, { tag: markerB, account: keyLike }));
  assert.equal(lines.length, 1, lines.join('\n'));
  const warning = lines[0];
  assert.match(warning, WARNING);
  assert.equal(warning.includes(markerA), false);
  assert.equal(warning.includes(markerB), false);
  assert.equal(warning.includes(keyLike), false);
  assert.equal(warning.includes(file), false);
  assert.equal(warning.includes('illegal operation'), false);
});

test('K4: a healthy log warns nothing, writes the row once, and counts spend once', (t) => {
  const lines = watchStderr(t);
  const file = path.join(tmp(), 'usage.jsonl');
  const usage = logAt(file);
  const marker = ['once', 'disk', 'row'].join('-');
  const returned = usage.record(pricedRow(5, { tag: marker }));
  assert.equal(returned, undefined);
  assert.deepEqual(lines, []);
  const text = fs.readFileSync(file, 'utf8');
  const rows = text.split('\n').filter((line) => line.length > 0);
  assert.equal(rows.length, 1);
  assert.equal(text.split(marker).length, 2);
  const parsed = JSON.parse(rows[0]);
  assert.equal(parsed.cost.usd, 5);
  assert.equal(parsed.cost.basis, 'metered');
  assert.equal(parsed.adapter, 'claude-api');
  assert.equal(parsed.model, 'claude-api/claude-opus-5-5');
  assert.equal(spentOf(usage), 5);
});
