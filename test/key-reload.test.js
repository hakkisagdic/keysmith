/**
 * In-process server test proving auth.keys additions and revocations in config.json
 * take effect on the very next request via reloadKeys(false), with no restart or SIGHUP.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

let dir;
let cfgFile;
let upstream;
let gateway;
let server;
let baseGw;
let writeSeq = 1;

const key1 = `ks_${crypto.randomBytes(24).toString('base64url')}`;
const key2 = `ks_${crypto.randomBytes(24).toString('base64url')}`;

function buildDoc(keys) {
  return {
    host: '127.0.0.1',
    auth: { enabled: true, keys },
    adapters: {
      up: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'test-upstream-token',
        models: ['m1'],
      },
    },
    aliases: {},
  };
}

function writeConfig(keys) {
  const tmp = path.join(dir, `.config.${process.pid}.${writeSeq}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(buildDoc(keys), null, 2), { mode: 0o600 });
  const t = new Date(Date.now() + writeSeq++ * 2000);
  fs.utimesSync(tmp, t, t);
  fs.renameSync(tmp, cfgFile);
}

async function ask(key) {
  const res = await fetch(`${baseGw}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'up/m1',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await res.text();
  return res.status;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-key-reload-'));
  cfgFile = path.join(dir, 'config.json');

  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  writeConfig([key1]);
  const cfg = { ...buildDoc([key1]), _path: cfgFile };
  gateway = new Gateway(cfg, { log: () => {} });
  server = createServer(gateway, cfg, {
    usage: new UsageLog(path.join(dir, 'usage.jsonl')),
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseGw = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  if (upstream) await new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('added key is accepted and revoked key is refused on the next request without restart or SIGHUP', async () => {
  assert.equal(await ask(key1), 200, 'initial configured key should be accepted');
  assert.equal(await ask(key2), 401, 'unconfigured key should initially be refused');

  writeConfig([key1, key2]);
  assert.equal(await ask(key2), 200, 'newly added key should be accepted on the next request without restart');
  assert.equal(await ask(key1), 200, 'existing key should remain accepted');

  writeConfig([key2]);
  assert.equal(await ask(key1), 401, 'revoked key should be refused on the next request without restart');
  assert.equal(await ask(key2), 200, 'remaining key should still be accepted');
});
