/** `keysmith discover`: only free models are written; off by default; the key never prints. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SECRET = 'sk-discover-secret-0123456789abcdef';

async function setup(t, { enabled, status = 200, body }) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-disc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  const cfg = {
    host: '127.0.0.1', port: 0, auth: { enabled: false, keys: [] }, aliases: {},
    adapters: { orx: { type: 'http', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: SECRET } },
    ...(enabled ? { discovery: { enabled: true } } : {}),
  };
  fs.writeFileSync(config, JSON.stringify(cfg), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'discover', 'orx'], { env });
    let all = '';
    p.stdout.on('data', (d) => { all += d; });
    p.stderr.on('data', (d) => { all += d; });
    p.on('close', (status) => resolve({ status, all }));
  });
  return { run, hits, data };
}

test('only models priced 0 are written', async (t) => {
  const { run, hits, data } = await setup(t, { enabled: true, body: { data: [
    { id: 'free/a', pricing: { prompt: '0', completion: '0' } },
    { id: 'paid/b', pricing: { prompt: '0.1', completion: '0' } },
    { id: 'nopricing' },
  ] } });
  const r = await run();
  assert.equal(r.status, 0, r.all);
  assert.equal(hits[0].url, '/v1/models');
  const doc = JSON.parse(fs.readFileSync(path.join(data, 'discovered', 'orx.json'), 'utf8'));
  assert.deepEqual(doc.ids, ['free/a']);
  assert.ok(!r.all.includes(SECRET));
});

test('switch off: refused, no request sent', async (t) => {
  const { run, hits } = await setup(t, { enabled: false, body: { data: [] } });
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.all, /discovery is off \(discovery\.enabled\)/);
  assert.equal(hits.length, 0);
});

test('401 says renew key and does not print the key', async (t) => {
  const { run } = await setup(t, { enabled: true, status: 401, body: { error: 'no' } });
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.all, /renew key: orx/);
  assert.ok(!r.all.includes(SECRET));
});

test('a source whose /models carries no price at all says so, and a 405 says there is no listing', async (t) => {
  const { run } = await setup(t, { enabled: true, body: { data: [{ id: 'm1' }, { id: 'm2' }] } });
  const r = await run();
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /2 models listed, none with a price/);
  assert.match(r.all, /0 free models written/);
  const none = await setup(t, { enabled: true, status: 405, body: {} });
  const r2 = await none.run();
  assert.notEqual(r2.status, 0);
  assert.match(r2.all, /no GET \/models \(405\)/);
});

const tbl = (rows, tiered = {}) => ({ data: rows, tiered_pricing: tiered });
const row = (name, o = {}) => ({ model_name: name, quota_type: 0, model_price: 0, model_ratio: 0, ...o });

async function priceSetup(t, body) {
  const state = { body, status: 200 };
  const srv = http.createServer((req, res) => {
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-disc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    host: '127.0.0.1', port: 0, auth: { enabled: false, keys: [] }, aliases: {},
    adapters: { tr: { type: 'http', baseUrl: 'http://127.0.0.1:1/v1', apiKey: SECRET, freeOnly: true } },
    discovery: { enabled: true, tr: { pricingUrl: `http://127.0.0.1:${srv.address().port}/api/pricing` } },
  }), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'discover', 'tr'], { env });
    let all = '';
    p.stdout.on('data', (d) => { all += d; });
    p.stderr.on('data', (d) => { all += d; });
    p.on('close', (status) => resolve({ status, all }));
  });
  const doc = () => JSON.parse(fs.readFileSync(path.join(data, 'discovered', 'tr.json'), 'utf8'));
  return { state, run, doc };
}

test('price table: only quota 0, price 0, ratio 0 and untiered models are free; source and time are written', async (t) => {
  const { run, doc } = await priceSetup(t, tbl([
    row('a/free1'), row('b/free2:free'), row('c/paid', { model_ratio: 0.5 }),
    row('d/quota', { quota_type: 1 }), row('e/tiered'), row('f/missing', { model_ratio: undefined }),
    row('g/priced', { model_price: 0.01 }),
  ], { 'e/tiered': { input: [] } }));
  const r = await run();
  assert.equal(r.status, 0, r.all);
  const d = doc();
  assert.deepEqual(d.ids, ['a/free1', 'b/free2:free']);
  assert.match(d.source, /^127\.0\.0\.1:\d+\/api\/pricing$/);
  assert.ok(!Number.isNaN(Date.parse(d.at)));
  assert.ok(!r.all.includes(SECRET));
});

test('price table: a model that turns paid drops out; an unreadable table empties the list', async (t) => {
  const { state, run, doc } = await priceSetup(t, tbl([row('a/free1'), row('b/free2')]));
  await run();
  assert.deepEqual(doc().ids, ['a/free1', 'b/free2']);
  state.body = tbl([row('a/free1'), row('b/free2', { model_ratio: 1 })]);
  await run();
  assert.deepEqual(doc().ids, ['a/free1']);
  state.status = 500;
  const r = await run();
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /free list is now empty/);
  assert.deepEqual(doc().ids, []);
});
