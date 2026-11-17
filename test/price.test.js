/**
 * 20261117-fiyat-ve-kucuk-bulgular: the Claude price table is whole, an unpriced model says so,
 * `keysmith price set` is the one writer, a price table is read over https only, and
 * `--models-url` never carries the key off its own origin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchPrice, tokensToUsd, UsageLog, formatUsageTable, DEFAULT_PRICING, PRICE_SOURCE } from '../src/usage.js';
import { estimateUsd } from '../src/batch.js';
import { modelsRequest } from '../src/source.js';
import { DEFAULTS } from '../src/config.js';
import { priceEntry } from '../src/price-cmd.js';
import { parseValue, schemaFor } from '../src/config-edit.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MODELS = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
  'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
];
// Anthropic's page, 2026-11-17: [input, output, cache read, cache write 5m, cache write 1h]
const PAGE = {
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5-2': [8, 40, 0.2, 10, 16],
  'claude-haiku-4-5-20251001': [1, 5, 0.1, 1.25, 2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, 0.2],
  'claude-opus-4-5-20251101': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-sonnet-4-5-20250929': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
};

test('K2 all 15 listed Claude models have every rate, each the page\'s; the page and date are recorded', () => {
  assert.match(PRICE_SOURCE.url, /^https:\/\/platform\.claude\.com\//);
  assert.match(PRICE_SOURCE.date, /^\d{4}-\d\d-\d\d$/);
  for (const m of MODELS) {
    const r = matchPrice({}, 'claude-api', m);
    assert.ok(r, `${m} has a price`);
    assert.deepEqual([r.input, r.output, r.cacheRead, r.cacheWrite, r.cacheWrite1h], PAGE[m], m);
    assert.equal(r.batchFactor, 0.5, m);
  }
  for (const m of ['claude-opus-5-6', 'claude-haiku-9', 'claude-fable-6']) assert.equal(matchPrice({}, 'claude-api', m), null, `${m} is not guessed`);
  assert.equal(matchPrice({}, 'claude-api', 'claude-opus-5-20261101').input, 5, 'a dated Opus 5 is Opus 5, not 5.5');
  assert.deepEqual(DEFAULTS.pricing, JSON.parse(JSON.stringify(DEFAULT_PRICING)), 'the shipped config default is the same table');
});

test('a user entry still beats the built-in one', () => {
  const r = matchPrice({ '*/claude-haiku-4-5*': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }, 'claude-api', 'claude-haiku-4-5-20251001');
  assert.equal(r.input, 9);
});

function usageLog(t, pricing = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-price-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new UsageLog(path.join(dir, 'usage.jsonl'), { pricing });
}
const row = (model, usage) => ({ adapter: 'claude-api', kind: 'http', model, status: 'ok', ms: 5, usage });

test('K1 a Haiku 4.5 row with 8,617 cache-read tokens is priced and saves money at list price', (t) => {
  const log = usageLog(t);
  log.record(row('claude-haiku-4-5-20251001', { input: 9000, output: 100, cacheRead: 8617, cacheWrite: 0 }));
  const r = log.query({ by: ['model'] });
  // uncached 383 * 1 + 100 * 5 + 8617 * 0.1 = 1744.7 / 1e6
  assert.equal(r.meteredUsd, 0.0017447);
  assert.ok(r.cacheSavingsUsd > 0);
  assert.equal(r.cacheSavingsUsd, 0.0077553);
  assert.equal(r.unpricedRequests, 0);
  assert.doesNotMatch(formatUsageTable(r), /unpriced/);
});

test('K1 a row written as unpriced before the table knew its model is priced in the report; the log is not rewritten', (t) => {
  const log = usageLog(t);
  log.record({ ...row('claude-haiku-4-5-20251001', { input: 9000, output: 100, cacheRead: 8617, cacheWrite: 0 }), cost: { usd: 0, basis: 'unpriced' } });
  const written = fs.readFileSync(log.file, 'utf8');
  assert.match(written, /"basis":"unpriced"/);
  const r = log.query({ by: ['model'] });
  assert.equal(r.meteredUsd, 0.0017447);
  assert.equal(r.unpricedRequests, 0);
  assert.equal(fs.readFileSync(log.file, 'utf8'), written);
});

test('K3 a model with no entry shows "unpriced" with its tokens, never $0.00', (t) => {
  const log = usageLog(t);
  log.record(row('claude-nonesuch-1', { input: 1234, output: 56, cacheRead: 1000, cacheWrite: 0 }));
  const r = log.query({ by: ['model'] });
  assert.equal(r.unpricedRequests, 1);
  assert.equal(r.input, 1234);
  const text = formatUsageTable(r);
  assert.match(text, /claude-nonesuch-1\s+1\s+0\s+1234\s+56\s+1000\s+0\s+unpriced/);
  assert.match(text, /1 unpriced request\(s\), not counted/);
  assert.match(text, /unpriced \(no entry in the price table.*claude-nonesuch-1 \(1\)/);
});

test('cacheWrite1h and batchFactor: the 1-hour rate and the batch share come from the entry', () => {
  const rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 3, batchFactor: 0.4 };
  assert.equal(tokensToUsd({ input: 1_000_000, output: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, rates), 3);
});

test('K4 a batch of Haiku 4.5 gets a cap estimate, not a price error; the entry\'s batchFactor and 1-hour rate count', () => {
  const adapter = { id: 'claude-api', upstreamModel: (m) => m };
  const req = (custom_id) => ({ custom_id, params: { model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: 'hello there' }] } });
  const usd = estimateUsd([req('a')], {}, adapter);
  assert.ok(usd > 0);
  // 1000 output tokens at half of $5/MTok = 0.0025, plus the few input tokens
  assert.ok(usd >= 0.0025 && usd < 0.0026, String(usd));
  const dear = estimateUsd([req('a')], { '*/claude-haiku-4-5*': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, batchFactor: 1 } }, adapter);
  assert.ok(dear >= 0.005 && dear < 0.0052, String(dear));
});

function sandbox(t, cfg = { port: 0, auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-price-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  return { home, config, run, read: () => fs.readFileSync(config, 'utf8') };
}
const PRICE_FLAGS = ['--input', '1', '--output', '5', '--cache-read', '0.1', '--cache-write-5m', '1.25'];

test('K2 `price list` shows every model with its rates, the page and the date', (t) => {
  const sb = sandbox(t);
  const r = sb.run('price', 'list');
  assert.equal(r.status, 0, r.stderr);
  for (const m of MODELS) assert.ok(r.stdout.includes(`*/${m.replace(/-20\d{6}$/, '')}`) || r.stdout.includes(`*/${m}`), m);
  assert.match(r.stdout, /platform\.claude\.com\/docs\/en\/about-claude\/pricing read 2026-11-17/);
  const haiku = r.stdout.split('\n').find((l) => l.startsWith('*/claude-haiku-4-5*'));
  assert.match(haiku, /\s1\s+5\s+0\.1\s+1\.25\s+2\s+0\.5\s+https:\/\//);
});

test('K5 `price set` writes one entry after a dated backup; bad numbers change nothing', (t) => {
  const sb = sandbox(t);
  const before = sb.read();
  for (const bad of [['--input', '-1'], ['--input=-1'], ['--input', 'abc'], ['--output', 'NaN'], ['--cache-read', '1e3'], ['--batch-factor', '2'], ['--batch-factor', '0']]) {
    const flags = bad[0].includes('=') ? [bad[0], ...PRICE_FLAGS.filter((x, i) => i > 1)] : [...PRICE_FLAGS.slice(0), ...bad];
    const r = sb.run('price', 'set', '*/claude-test*', ...flags);
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.equal(sb.read(), before, `${JSON.stringify(bad)} left the file alone`);
  }
  assert.notEqual(sb.run('price', 'set', '*/claude-test*', '--input', '1').status, 0, 'a missing rate is refused');
  assert.equal(fs.readdirSync(sb.home).filter((f) => f.includes('.bak-')).length, 0);

  const dry = sb.run('price', 'set', '*/claude-test*', ...PRICE_FLAGS, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(sb.read(), before);

  const ok = sb.run('price', 'set', '*/claude-test*', ...PRICE_FLAGS, '--cache-write-1h', '2', '--batch-factor', '0.5');
  assert.equal(ok.status, 0, ok.stderr);
  const doc = JSON.parse(sb.read());
  assert.deepEqual({ ...doc.pricing['*/claude-test*'], setAt: undefined }, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, batchFactor: 0.5, setAt: undefined });
  const backups = fs.readdirSync(sb.home).filter((f) => f.includes('.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(sb.home, backups[0]), 'utf8'), before);
  assert.equal(fs.statSync(sb.config).mode & 0o777, 0o600);
  assert.match(sb.run('price', 'list', 'claude-test').stdout, /\*\/claude-test\*.*config, set \d{4}-\d\d-\d\d/);
  assert.equal(fs.readdirSync(sb.home).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('price set refuses an unsafe pattern', (t) => {
  const sb = sandbox(t);
  for (const p of ['__proto__', '*/__proto__', '', 'a b']) assert.notEqual(sb.run('price', 'set', p, ...PRICE_FLAGS).status, 0, p);
  assert.throws(() => priceEntry({ input: '1' }), /--output is required/);
});

test('K6 discover: a price table over http is refused, a broken address is one line, no list written', (t) => {
  for (const [url, msg] of [['http://example.invalid/api/pricing', /must be https, not http/], ['::', /not a URL/]]) {
    const sb = sandbox(t, { port: 0, auth: { enabled: false, keys: [] }, aliases: {}, adapters: { orx: { type: 'http', baseUrl: 'https://orx.invalid/v1', apiKey: 'k' } }, discovery: { enabled: true, orx: { pricingUrl: url } } });
    const r = sb.run('discover', 'orx');
    assert.equal(r.status, 1);
    assert.match(r.stderr, msg);
    assert.equal(r.stderr.trim().split('\n').length, 1, 'one line, no stack');
    assert.equal(fs.existsSync(path.join(sb.home, 'data')), false, 'no free list written');
  }
});

test('config set discovery.<id>.pricingUrl takes https only', () => {
  const schema = schemaFor('discovery.orx.pricingUrl');
  assert.equal(parseValue('k', schema, 'https://x.example/p'), 'https://x.example/p');
  assert.throws(() => parseValue('k', schema, 'http://x.example/p'), /must be https/);
  assert.throws(() => parseValue('k', schema, '::'), /not a URL/);
});

test('K7 --models-url: the key goes only to an https address of the source\'s own origin', () => {
  const base = 'https://api.example.com/v1';
  assert.equal(modelsRequest(base, 'SECRET').headers.authorization, 'Bearer SECRET', 'the default address');
  assert.equal(modelsRequest(base, 'SECRET', 'https://api.example.com/v1/models?x=1').headers.authorization, 'Bearer SECRET', 'same origin');
  assert.equal(modelsRequest(base, 'SECRET', 'https://other.example.com/v1/models').headers.authorization, undefined, 'another host');
  assert.equal(modelsRequest(base, 'SECRET', 'https://api.example.com:8443/v1/models').headers.authorization, undefined, 'another port');
  assert.equal(modelsRequest(base, 'SECRET', 'http://api.example.com/v1/models').headers.authorization, undefined, 'http');
  assert.equal(modelsRequest('http://api.example.com/v1', 'SECRET', 'http://api.example.com/v1/models').headers.authorization, undefined, 'a source on http gets none');
  assert.equal(modelsRequest(base, 'SECRET', '::').headers.authorization, undefined, 'a broken address');
  assert.equal(modelsRequest(base, '', 'https://api.example.com/m').headers.authorization, undefined, 'no key, no header');
});

test('K8 help source names --models-url and the key rule', (t) => {
  const sb = sandbox(t);
  const r = sb.run('source', '--help');
  assert.match(r.stdout, /--models-url/);
  assert.match(r.stdout, /https address with the baseUrl's own origin/);
});
