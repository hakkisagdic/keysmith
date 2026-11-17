/** A reload (SIGHUP) updates promptCache on the running http adapters, and nothing else about them. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

let dir, upstream, server, gateway, baseGw, cfgFile, cfg;
const bodies = [];
const write = (pc, extra = {}) => {
  const doc = { auth: { enabled: false }, adapters: { ca: { ...cfg.adapters.ca, ...(pc === undefined ? {} : { promptCache: pc }), ...extra } } };
  fs.writeFileSync(cfgFile, JSON.stringify(doc));
  const t = new Date(Date.now() + write.n++ * 2000);
  fs.utimesSync(cfgFile, t, t);
};
write.n = 1;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-pcrl-'));
  upstream = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      bodies.push(b);
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  cfgFile = path.join(dir, 'config.json');
  cfg = { auth: { enabled: false }, _path: cfgFile, adapters: { ca: { kind: 'http', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, wire: 'anthropic', apiKey: 'literal-test-value', models: ['claude-sonnet-5-5'] } } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  gateway = new Gateway(cfg, { log: () => {} });
  server = createServer(gateway, cfg, { usage: new UsageLog(path.join(dir, 'u.jsonl')), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseGw = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function ask() {
  const res = await fetch(`${baseGw}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'ca/claude-sonnet-5-5', max_tokens: 5, system: 'word '.repeat(4000), messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  return bodies.at(-1).includes('cache_control');
}

test('K6: SIGHUP turns promptCache on and off for the next request; other adapter fields stay', async () => {
  assert.equal(await ask(), false);
  const adapter = gateway.adapters.get('ca');
  const before = { baseUrl: adapter.baseUrl, models: adapter.models, wire: adapter.wire, obj: adapter };
  write({ mode: 'on', ttl: '5m' });
  server.reloadKeys();
  assert.equal(await ask(), true);
  assert.equal(gateway.adapters.get('ca'), before.obj, 'the adapter object is the same');
  write(undefined, { baseUrl: 'http://127.0.0.1:1/other', models: ['x'] });
  server.reloadKeys();
  assert.equal(await ask(), false, 'promptCache removed from the file: off');
  assert.equal(adapter.baseUrl, before.baseUrl);
  assert.deepEqual(adapter.models, before.models);
  assert.equal(adapter.wire, before.wire);
});

test('K6: an invalid promptCache keeps the old value', async () => {
  write({ mode: 'on', ttl: '5m' });
  server.reloadKeys();
  assert.equal(await ask(), true);
  write({ mode: 'sometimes' });
  server.reloadKeys();
  assert.equal(await ask(), true, 'the previous setting stands');
  assert.equal(gateway.adapters.get('ca').promptCache.mode, 'on');
});
