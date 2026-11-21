/**
 * Recent-row filters on GET /v1/keysmith/usage. A temp KEYSMITH_DATA holds a fixed usage.jsonl
 * (ok, error and limited rows for two keys). The test removes that directory. Nothing calls an
 * upstream: the adapters exist so a scoped key's `mayName` check is the same one the gateway uses.
 * The scoped key is built the way test/scopes.test.js builds one: `{ key, label, deny }`.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog, entryFilter } from '../src/usage.js';
import { fingerprint } from '../src/redact.js';

const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');
const MAIN = mint(); // unscoped, a bare string
const ADA = mint(); // scoped: deny claude-api, as in test/scopes.test.js
const fpMain = `fp:${fingerprint(MAIN)}`;
const fpAda = `fp:${fingerprint(ADA)}`;

let dir, server, base;
let prevData, prevConfig;

function row(partial) {
  return {
    tag: null,
    usage: { input: 1, output: 1 },
    via: '/v1/chat/completions',
    error: null,
    ...partial,
  };
}

before(async () => {
  prevData = process.env.KEYSMITH_DATA;
  prevConfig = process.env.KEYSMITH_CONFIG;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-usage-filters-'));
  process.env.KEYSMITH_DATA = dir;
  process.env.KEYSMITH_CONFIG = path.join(dir, 'no-such-config.json');
  const rows = [
    row({ ts: '2026-11-20T12:00:01.000Z', key: fpAda, label: 'ada', model: 'google/gemini-3.8-flash', adapter: 'google', status: 'ok', ms: 12, tag: 'ci', cost: { usd: 0.2, basis: 'metered' } }),
    row({ ts: '2026-11-20T12:00:02.000Z', key: fpAda, label: 'ada', model: null, adapter: null, status: 'limited', ms: 0, usage: null, cost: { usd: null, basis: 'unpriced' }, error: 'daily cap' }),
    row({ ts: '2026-11-20T12:00:03.000Z', key: fpMain, model: 'claude-api/claude-x', adapter: 'claude-api', status: 'ok', ms: 30, tag: 'ci', usage: { input: 100, output: 20 }, cost: { usd: 1.5, basis: 'metered' } }),
    row({ ts: '2026-11-20T12:00:04.000Z', key: fpMain, model: 'claude-api/claude-x', adapter: 'claude-api', status: 'limited', ms: 0, usage: null, cost: { usd: null, basis: 'unpriced' }, error: 'daily cap' }),
    row({ ts: '2026-11-20T12:00:04.500Z', key: fpAda, label: 'ada', model: 'google/gemini-3.8-flash', adapter: 'google', status: 'blocked', ms: 0, usage: null, cost: { usd: null, basis: 'unpriced' }, guard: 'blocked', guardKinds: ['github-token'], error: 'request blocked by secret guard (github-token)', face: 'chat' }),
    row({ ts: '2026-11-20T12:00:04.800Z', key: fpMain, model: 'claude-api/claude-x', adapter: 'claude-api', status: 'denied', ms: 0, usage: null, cost: { usd: null, basis: 'unpriced' }, error: 'scope denied' }),
    row({ ts: '2026-11-20T12:00:05.000Z', key: fpMain, model: 'google/gemini-3.8-flash', adapter: 'google', status: 'error', ms: 80, tag: 'other', cost: { usd: 0.7, basis: 'metered' }, error: 'upstream' }),
    row({ ts: '2026-11-20T12:00:06.000Z', key: fpAda, label: 'ada', model: 'google/gemini-3.8-flash', adapter: 'google', status: 'error', ms: 15, tag: 'ci', cost: { usd: 0.05, basis: 'list' }, error: 'ada-err', via: '/v1/messages' }),
  ];
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        MAIN,
        { key: ADA, label: 'ada', deny: ['claude-api'] },
      ],
    },
    adapters: {
      google: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['gemini-3.8-flash'] },
      'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['claude-x'] },
    },
  };
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(new Gateway(cfg, { log: () => {} }), cfg, { usage, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (prevData === undefined) delete process.env.KEYSMITH_DATA;
  else process.env.KEYSMITH_DATA = prevData;
  if (prevConfig === undefined) delete process.env.KEYSMITH_CONFIG;
  else process.env.KEYSMITH_CONFIG = prevConfig;
});

async function get(key, route) {
  const res = await fetch(base + route, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  assert.equal(text.includes(MAIN), false, 'response carries the unscoped key');
  assert.equal(text.includes(ADA), false, 'response carries the scoped key');
  let json = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body fails the assertion that reads it */ }
  return { status: res.status, text, json };
}

test('?tail=20&status=limited returns only limited rows, and does not filter the totals', async () => {
  const plain = await get(MAIN, '/v1/keysmith/usage?tail=20');
  const limited = await get(MAIN, '/v1/keysmith/usage?tail=20&status=limited');
  assert.equal(limited.status, 200, limited.text);
  assert.deepEqual(limited.json.entries.map((e) => e.key), [fpMain, fpAda]);
  assert.ok(limited.json.entries.every((e) => e.status === 'limited'));
  assert.equal(Object.hasOwn(limited.json, 'entriesUnpriced'), false);
  assert.ok(plain.json.entries.length > limited.json.entries.length);
  assert.equal(limited.json.totals.requests, plain.json.totals.requests);
  assert.deepEqual(limited.json.groups, plain.json.groups);

  const ada = await get(ADA, '/v1/keysmith/usage?tail=20&status=limited');
  assert.equal(ada.status, 200, ada.text);
  assert.deepEqual(ada.json.entries.map((e) => e.key), [fpAda]);
  assert.ok(ada.json.entries.every((e) => e.status === 'limited'));
  assert.equal(ada.json.entries.some((e) => e.key === fpMain), false);
});

test('a scoped key asking key=fp:<another key> gets an empty entries list and still its own totals', async () => {
  const own = await get(ADA, '/v1/keysmith/usage?tail=20');
  assert.equal(own.status, 200, own.text);
  assert.ok(own.json.entries.length >= 1);
  assert.ok(own.json.entries.every((e) => e.key === fpAda));
  assert.ok(own.json.totals.requests > 0);

  const foreign = await get(ADA, `/v1/keysmith/usage?tail=20&key=${fpMain}`);
  assert.equal(foreign.status, 200, foreign.text);
  assert.deepEqual(foreign.json.entries, []);
  assert.equal(foreign.text.includes(fpMain), false);
  assert.equal(foreign.json.totals.requests, own.json.totals.requests);
  assert.deepEqual(foreign.json.groups, own.json.groups);

  const mine = await get(ADA, `/v1/keysmith/usage?tail=20&key=${fpAda}`);
  assert.deepEqual(mine.json.entries.map((e) => e.key), own.json.entries.map((e) => e.key));
});

test('?tail=20&min_cost=abc is 400 naming min_cost; an unknown parameter is ignored', async () => {
  const bad = await get(MAIN, '/v1/keysmith/usage?tail=20&min_cost=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.type, 'invalid_request_error');
  assert.match(bad.json.error.message, /min_cost/);
  assert.equal(bad.json.entries, undefined);

  const limited = await get(MAIN, '/v1/keysmith/usage?tail=20&status=limited');
  const extra = await get(MAIN, '/v1/keysmith/usage?tail=20&status=limited&not_a_filter=1');
  assert.equal(extra.status, 200, extra.text);
  assert.deepEqual(extra.json.entries, limited.json.entries);
  assert.equal(extra.json.totals.requests, limited.json.totals.requests);

  const priced = await get(MAIN, '/v1/keysmith/usage?tail=20&min_cost=0.5');
  assert.equal(priced.status, 200, priced.text);
  assert.ok(priced.json.entries.every((e) => e.cost.usd >= 0.5));
  assert.equal(priced.json.entriesUnpriced, 4);
  assert.equal(priced.json.totals.requests, limited.json.totals.requests);

  const adaPriced = await get(ADA, '/v1/keysmith/usage?tail=20&min_cost=0.5');
  assert.equal(adaPriced.status, 200, adaPriced.text);
  assert.deepEqual(adaPriced.json.entries, []);
  assert.equal(adaPriced.json.entriesUnpriced, 2);
});

test('?tail=20&status=blocked and status=denied filter guard-blocked and denied rows; unknown status is 400', async () => {
  const blocked = await get(MAIN, '/v1/keysmith/usage?tail=20&status=blocked');
  assert.equal(blocked.status, 200, blocked.text);
  assert.equal(blocked.json.entries.length, 1);
  assert.equal(blocked.json.entries[0].status, 'blocked');
  assert.equal(blocked.json.entries[0].key, fpAda);

  const adaBlocked = await get(ADA, '/v1/keysmith/usage?tail=20&status=blocked');
  assert.equal(adaBlocked.status, 200, adaBlocked.text);
  assert.equal(adaBlocked.json.entries.length, 1);
  assert.equal(adaBlocked.json.entries[0].key, fpAda);

  const adaDenied = await get(ADA, '/v1/keysmith/usage?tail=20&status=denied');
  assert.equal(adaDenied.status, 200, adaDenied.text);
  assert.deepEqual(adaDenied.json.entries, []);

  const mainDenied = await get(MAIN, '/v1/keysmith/usage?tail=20&status=denied');
  assert.equal(mainDenied.status, 200, mainDenied.text);
  assert.equal(mainDenied.json.entries.length, 1);
  assert.equal(mainDenied.json.entries[0].status, 'denied');

  const badStatus = await get(MAIN, '/v1/keysmith/usage?tail=20&status=bogus');
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.json.error.type, 'invalid_request_error');
  assert.match(badStatus.json.error.message, /status/);
  assert.match(badStatus.json.error.message, /blocked/);

  const noTail = await get(MAIN, '/v1/keysmith/usage?status=blocked');
  assert.equal(noTail.status, 400);
  assert.equal(noTail.json.error.type, 'invalid_request_error');
  assert.match(noTail.json.error.message, /tail/);
});

test('entryFilter rejects unknown filter names, resolves route from via or face, and ANDs with viewer', () => {
  assert.equal(entryFilter(null), null);
  assert.equal(entryFilter(undefined), null);
  const viewer = (r) => r.key === fpAda;
  assert.equal(entryFilter(null, viewer), viewer);
  assert.equal(entryFilter({}, viewer), viewer);
  assert.throws(() => entryFilter({ nope: 1 }), /unknown filter "nope"/);
  assert.throws(() => entryFilter([]), /unknown filter/);

  const chatPred = entryFilter({ route: '/v1/chat/completions' }, viewer);
  assert.equal(chatPred({ key: fpAda, face: 'chat' }), true);
  assert.equal(chatPred({ key: fpAda, via: '/v1/chat/completions' }), true);
  assert.equal(chatPred({ key: fpMain, face: 'chat' }), false);
  assert.equal(chatPred({ key: fpAda, via: '/v1/messages', face: 'messages' }), false);

  const msgPred = entryFilter({ route: '/v1/messages' });
  assert.equal(msgPred({ via: 'passthrough', face: 'messages' }), true);
  assert.equal(msgPred({ via: '/v1/messages', face: 'messages' }), true);
  assert.equal(msgPred({ via: 'passthrough', face: 'chat' }), false);
});

