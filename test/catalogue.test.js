import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  catalogueSettings, loadCatalogue, CatalogueLimiter, catalogueLimitError,
  discoveredPath, readDiscovered, writeDiscovered, freeModels,
} from '../src/catalogue.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cat-'));
const doc = (limits) => ({ version: 1, extra: 1, sources: [{ id: 'src', reach: { keysmith: 'tr' }, limits, models: [{ id: 'm1', tier: 'free', x: 1 }] }] });
const write = (f, d, mt) => { fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); if (mt) fs.utimesSync(f, mt, mt); };

test('catalogueSettings defaults and path expansion', () => {
  assert.deepEqual(catalogueSettings({}), { path: null, discovery: { enabled: false } });
  const s = catalogueSettings({ catalogue: '~/c.json', discovery: { enabled: true, tr: {} } });
  assert.equal(s.path, path.join(os.homedir(), 'c.json'));
  assert.equal(s.discovery.enabled, true);
  assert.deepEqual(s.discovery.tr, { inputPricePath: 'pricing.prompt', outputPricePath: 'pricing.completion' });
});

test('loadCatalogue re-reads on mtime change', () => {
  const f = path.join(tmp(), 'c.json');
  write(f, doc({ requestsPerMinute: 1 }), 1000);
  const c = loadCatalogue(f, { log: () => {} });
  assert.equal(c.get().get('tr').limits.requestsPerMinute, 1);
  write(f, doc({ requestsPerMinute: 5 }), 2000);
  assert.equal(c.get().get('tr').limits.requestsPerMinute, 5);
});

test('broken JSON warns once per mtime and yields an empty catalogue', () => {
  const f = path.join(tmp(), 'c.json');
  write(f, '{nope', 1000);
  const logs = [];
  const c = loadCatalogue(f, { log: (m) => logs.push(m) });
  assert.equal(c.get().size, 0);
  assert.equal(c.get().size, 0);
  assert.equal(logs.length, 1);
  write(f, '{still', 2000);
  c.get();
  assert.equal(logs.length, 2);
  const missing = loadCatalogue(path.join(tmp(), 'none.json'), { log: (m) => logs.push(m) });
  missing.get(); missing.get();
  assert.equal(logs.length, 3);
});

function limiter(limits, extra = {}) {
  const f = path.join(tmp(), 'c.json');
  write(f, doc(limits));
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0) };
  const l = new CatalogueLimiter({ catalogue: loadCatalogue(f, { log: () => {} }), now: () => clock.t, ...extra });
  return { l, clock };
}

test('per-minute limit with retry-after, then admits after the window', () => {
  const { l, clock } = limiter({ requestsPerMinute: 1 });
  assert.equal(l.admit('tr').ok, true);
  clock.t += 20000;
  const r = l.admit('tr');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 40);
  assert.equal(l.admit('tr').ok, false);
  clock.t += 40000;
  assert.equal(l.admit('tr').ok, true);
  assert.equal(l.admit('other').ok, true);
});

test('per-day limit retries at local midnight', () => {
  const { l, clock } = limiter({ requestsPerDay: 2 });
  assert.equal(l.admit('tr').ok, true);
  assert.equal(l.admit('tr').ok, true);
  const r = l.admit('tr');
  assert.equal(r.ok, false);
  const d = new Date(clock.t);
  const mid = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  assert.equal(r.retryAfter, Math.ceil((mid - clock.t) / 1000));
  clock.t = mid + 1000;
  assert.equal(l.admit('tr').ok, true);
});

test('tokensPerMonth counts, seeds and resets next UTC month', () => {
  const { l, clock } = limiter({ tokensPerMonth: 100 }, { seedMonthTokens: (id) => (id === 'tr' ? 60 : 0) });
  assert.equal(l.admit('tr').ok, true);
  l.noteTokens('tr', 30);
  assert.equal(l.admit('tr').ok, true);
  l.noteTokens('tr', 10);
  const r = l.admit('tr');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, Math.ceil((Date.UTC(2026, 11, 1) - clock.t) / 1000));
  clock.t = Date.UTC(2026, 11, 1, 0, 0, 1);
  assert.equal(l.admit('tr').ok, true);
});

test('upstream 429 cooldown uses retry-after or 60 s', () => {
  const { l, clock } = limiter({});
  l.noteUpstream429('tr', 5);
  assert.equal(l.admit('tr').ok, false);
  clock.t += 5000;
  assert.equal(l.admit('tr').ok, true);
  l.noteUpstream429('tr', undefined);
  const r = l.admit('tr');
  assert.equal(r.retryAfter, 60);
  clock.t += 60000;
  assert.equal(l.admit('tr').ok, true);
});

test('info and the limit error carry no key', () => {
  const { l } = limiter({});
  assert.deepEqual(l.info('tr', 'm1'), { source: 'src', tier: 'free' });
  assert.equal(l.info('tr', 'zz'), null);
  assert.equal(l.info('nope', 'm1'), null);
  const e = catalogueLimitError('tr', { retryAfter: 7, why: '1 requests per minute' });
  assert.equal(e.status, 429);
  assert.equal(e.type, 'rate_limit_error');
  assert.equal(e.retryAfter, '7');
  assert.match(e.message, /tr/);
});

test('freeModels price paths', () => {
  const list = { data: [
    { id: 'a', pricing: { prompt: '0', completion: '0' } },
    { id: 'b', pricing: { prompt: 0, completion: 0 } },
    { id: 'c', pricing: { prompt: '0', completion: '0.1' } },
    { id: 'd' },
    { id: 'e', pricing: { prompt: 0 } },
    { id: 'f', cost: { in: 0, out: 0 } },
  ] };
  assert.deepEqual(freeModels(list, { inputPricePath: 'pricing.prompt', outputPricePath: 'pricing.completion' }), ['a', 'b']);
  assert.deepEqual(freeModels(list, { inputPricePath: 'cost.in', outputPricePath: 'cost.out' }), ['f']);
});

test('discovered file: mode 600, mtime-cached read', () => {
  const dir = tmp();
  const f = discoveredPath(dir, 'tr');
  assert.equal(f, path.join(dir, 'discovered', 'tr.json'));
  assert.equal(readDiscovered(f), null);
  writeDiscovered(f, ['a', 'b']);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual([...readDiscovered(f)], ['a', 'b']);
  writeDiscovered(f, ['c']);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual([...readDiscovered(f)], ['c']);
});
