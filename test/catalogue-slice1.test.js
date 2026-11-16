import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalogue, CatalogueLimiter, catalogueLimitError, readDiscovered, writeDiscovered, freeModels } from '../src/catalogue.js';

const mk = (limits) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s1-'));
  const f = path.join(d, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, sources: [{ id: 's', reach: { keysmith: 'a' }, limits, models: [{ id: 'm', tier: 'free' }] }] }));
  return { d, f };
};

test('slice1: rpm limit refuses the extra request and recovers after a minute', () => {
  const { f } = mk({ requestsPerMinute: 2 });
  let t = Date.UTC(2026, 10, 16, 12, 0, 0);
  const l = new CatalogueLimiter({ catalogue: loadCatalogue(f, { log() {} }), now: () => t });
  assert.equal(l.admit('a').ok, true);
  assert.equal(l.admit('a').ok, true);
  const r = l.admit('a');
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
  t += 61000;
  assert.equal(l.admit('a').ok, true);
});

test('slice1: unknown adapter is never limited; limit error is a 429 without secrets', () => {
  const { f } = mk({ requestsPerMinute: 1 });
  const l = new CatalogueLimiter({ catalogue: loadCatalogue(f, { log() {} }) });
  for (let i = 0; i < 5; i++) assert.equal(l.admit('other').ok, true);
  const e = catalogueLimitError('a', { why: '1 requests per minute', retryAfter: 7 });
  assert.equal(e.status, 429);
  assert.equal(e.retryAfter, '7');
});

test('slice1: monthly token cap and upstream 429 cooldown', () => {
  const { f } = mk({ tokensPerMonth: 100 });
  let t = Date.UTC(2026, 10, 16);
  const l = new CatalogueLimiter({ catalogue: loadCatalogue(f, { log() {} }), now: () => t });
  assert.equal(l.admit('a').ok, true);
  l.noteTokens('a', 100);
  assert.equal(l.admit('a').ok, false);
  t = Date.UTC(2026, 11, 1, 0, 0, 1);
  assert.equal(l.admit('a').ok, true);
  l.noteUpstream429('a');
  const r = l.admit('a');
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter <= 60);
});

test('slice1: discovered list round trip with 0600 and free filter', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s1-'));
  const f = path.join(d, 'x', 'a.json');
  assert.equal(readDiscovered(f), null);
  writeDiscovered(f, ['m1', 'm2']);
  assert.deepEqual([...readDiscovered(f)], ['m1', 'm2']);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const ids = freeModels({ data: [
    { id: 'f', pricing: { prompt: '0', completion: 0 } },
    { id: 'p', pricing: { prompt: '0.1', completion: '0' } },
    { id: 'n' },
  ] });
  assert.deepEqual(ids, ['f']);
});
