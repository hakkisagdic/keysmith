import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { Gateway } from '../src/gateway.js';
import { fingerprint } from '../src/redact.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const KEY = ['ks', crypto.randomBytes(24).toString('hex')].join('_');
const BAD_KEY = ['ks', 'bad', crypto.randomBytes(12).toString('hex')].join('_');
const KEY_FP = fingerprint(KEY);
const BAD_KEY_FP = fingerprint(BAD_KEY);

function assertNoKeyLeak(text, secret, label) {
  assert.ok(!text.includes(secret), `${label}: leaked full secret`);
  for (let i = 3; i + 6 <= secret.length; i++) {
    assert.ok(!text.includes(secret.slice(i, i + 6)), `${label}: leaked 6-char slice of secret`);
  }
}

let dir;
let server;
let base;
let usageLog;
let usagePath;
const logs = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-err-shape-'));
  usagePath = path.join(dir, 'usage.jsonl');
  const stubCli = path.join(dir, 'ok-cli');
  fs.writeFileSync(stubCli, '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o755 });
  const cfg = {
    auth: {
      enabled: true,
      keys: [{ key: KEY, label: 'primary', perDay: 10 }],
    },
    adapters: {
      ok: { kind: 'cli', bin: stubCli, args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: dir },
    },
    aliases: {},
  };
  const gateway = new Gateway(cfg, { log: (m) => logs.push(m) });
  usageLog = new UsageLog(usagePath);
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function sendRaw(method, urlPath, headers = {}, body = undefined) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: res.status, headers: res.headers, raw, json };
}

function assertAnthropicError(res, expectedStatus, expectedErrorType, msgPattern) {
  assert.equal(res.status, expectedStatus);
  assert.ok(res.json && typeof res.json === 'object', `expected JSON body, got: ${res.raw}`);
  assert.equal(res.json.type, 'error');
  assert.equal(res.json.status, expectedStatus);
  assert.ok(res.json.error && typeof res.json.error === 'object');
  assert.equal(res.json.error.type, expectedErrorType);
  assert.match(res.json.error.message, msgPattern);
}

function assertOpenaiError(res, expectedStatus, expectedErrorType, msgPattern) {
  assert.equal(res.status, expectedStatus);
  assert.ok(res.json && typeof res.json === 'object', `expected JSON body, got: ${res.raw}`);
  assert.equal(res.json.type, undefined);
  assert.equal(res.json.status, expectedStatus);
  assert.ok(res.json.error && typeof res.json.error === 'object');
  assert.equal(res.json.error.type, expectedErrorType);
  assert.match(res.json.error.message, msgPattern);
}

describe('error shape per face (K1-K5)', () => {
  test('K1 + K5: 401 on /v1/messages uses Anthropic shape, hides keys/fingerprints, writes no usage row', async () => {
    const logsBefore = logs.length;
    const msgBody = { model: 'ok/m', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
    const cases = [
      ['missing auth', '/v1/messages', 'POST', { 'content-type': 'application/json' }, msgBody],
      ['wrong x-api-key', '/v1/messages', 'POST', { 'content-type': 'application/json', 'x-api-key': BAD_KEY }, msgBody],
      ['wrong Bearer', '/v1/messages', 'POST', { 'content-type': 'application/json', authorization: `Bearer ${BAD_KEY}` }, msgBody],
      ['disabled query api_key', `/v1/messages?api_key=${KEY}`, 'POST', { 'content-type': 'application/json' }, msgBody],
      ['unauthenticated GET /v1/messages', '/v1/messages', 'GET', {}, undefined],
      ['unauthenticated subpath POST /v1/messages/count_tokens', '/v1/messages/count_tokens', 'POST', { 'content-type': 'application/json' }, msgBody],
    ];

    for (const [name, urlPath, method, headers, body] of cases) {
      const res = await sendRaw(method, urlPath, headers, body);
      assertAnthropicError(res, 401, 'authentication_error', /^keysmith: missing or invalid API key/);

      const headerDump = JSON.stringify(Object.fromEntries(res.headers.entries()));
      const recentLogs = logs.slice(logsBefore).join('\n');
      for (const [surfaceName, text] of [['body', res.raw], ['headers', headerDump], ['logs', recentLogs]]) {
        assertNoKeyLeak(text, KEY, `${name} (${surfaceName}) configured key`);
        assertNoKeyLeak(text, BAD_KEY, `${name} (${surfaceName}) submitted bad key`);
        assert.ok(!text.includes(KEY_FP), `${name} (${surfaceName}): leaked configured fingerprint`);
        assert.ok(!text.includes(BAD_KEY_FP), `${name} (${surfaceName}): leaked bad key fingerprint`);
        assert.ok(!text.includes('fp:'), `${name} (${surfaceName}): leaked fp: marker`);
      }
    }

    assert.equal(usageLog.tail(100).length, 0, '401 must not write usage rows');
    assert.equal(fs.existsSync(usagePath), false, 'usage.jsonl must not be created on 401');

    // Verify daily meter did not count any of the rejected 401 requests (querying /v1/keysmith/usage
    // itself is metered, so check usageLog.dailySummary directly first).
    const daily = usageLog.dailySummary([{ key: KEY, label: 'primary', perDay: 10 }]);
    assert.equal(daily[0].requests, 0, '401 must not increment daily request count');
    assert.equal(daily[0].refused, 0, '401 must not increment daily refusal count');
  });

  test('K2: 401 and 404 on OpenAI faces stay OpenAI-shaped', async () => {
    const chatBody = { model: 'ok/m', messages: [{ role: 'user', content: 'hi' }] };
    const respBody = { model: 'ok/m', input: 'hi' };

    for (const [urlPath, body] of [['/v1/chat/completions', chatBody], ['/v1/responses', respBody]]) {
      const noKey = await sendRaw('POST', urlPath, { 'content-type': 'application/json' }, body);
      assertOpenaiError(noKey, 401, 'authentication_error', /^keysmith: missing or invalid API key/);

      const badKey = await sendRaw('POST', urlPath, { 'content-type': 'application/json', authorization: `Bearer ${BAD_KEY}` }, body);
      assertOpenaiError(badKey, 401, 'authentication_error', /^keysmith: missing or invalid API key/);

      const badMethod = await sendRaw('GET', urlPath, { authorization: `Bearer ${KEY}` });
      assertOpenaiError(badMethod, 404, 'invalid_request_error', /^keysmith: no route for GET$/);
    }
  });

  test('K3: unknown method and unknown subpaths under /v1/messages return Anthropic-shaped 404 without path echo', async () => {
    const cases = [
      ['GET', '/v1/messages'],
      ['DELETE', '/v1/messages'],
      ['PUT', '/v1/messages'],
      ['POST', '/v1/messages/count_tokens'],
      ['GET', '/v1/messages/batches'],
      ['POST', '/v1/messages/probe-secret-subpath'],
    ];
    for (const [method, urlPath] of cases) {
      const res = await sendRaw(method, urlPath, { 'x-api-key': KEY, 'content-type': 'application/json' }, method === 'POST' ? {} : undefined);
      assertAnthropicError(res, 404, 'not_found_error', new RegExp(`^keysmith: no route for ${method}$`));
      assert.ok(!res.raw.includes('probe-secret-subpath'), '404 must not echo raw request subpath');
    }

    // Unsupported UHP-Version 400 also respects the /v1/messages face while /v1/uhp keeps OpenAI shape.
    const badUhpMsg = await sendRaw('POST', '/v1/messages', { 'content-type': 'application/json', 'uhp-version': '1999-01-01' }, {});
    assertAnthropicError(badUhpMsg, 400, 'unsupported_protocol_version', /^keysmith: Unsupported UHP-Version/);

    const badUhpDiscovery = await sendRaw('GET', '/v1/uhp', { 'uhp-version': '1999-01-01' });
    assertOpenaiError(badUhpDiscovery, 400, 'unsupported_protocol_version', /^keysmith: Unsupported UHP-Version/);
  });

  test('K3/500: outer crash handler returns Anthropic-shaped 500 on /v1/messages', async () => {
    const crashGateway = {
      publicAdapters: [],
      loadErrors: {},
      aliasIssues: {},
      adapters: new Map(),
      adapterVisible: () => true,
      aliasIssuesFor: () => ({}),
      virtualModelsFor: () => ({}),
      virtualModelIssuesFor: () => ({}),
    };
    const crashServer = createServer(crashGateway, { auth: { enabled: false }, adapters: {} });
    await new Promise((r) => crashServer.listen(0, '127.0.0.1', r));
    try {
      const fakeRes = new http.ServerResponse({ method: 'POST', url: '/v1/messages' });
      const chunks = [];
      let statusCode = null;
      fakeRes.writeHead = (s) => { statusCode = s; };
      fakeRes.end = (b) => { if (b) chunks.push(String(b)); };
      const throwingReq = {
        url: '/v1/messages',
        method: 'POST',
        get headers() { throw new Error('boom'); },
      };
      crashServer.emit('request', throwingReq, fakeRes);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(statusCode, 500);
      const body = JSON.parse(chunks.join(''));
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'internal_error');
      assert.equal(body.error.message, 'keysmith: internal error');
    } finally {
      await new Promise((r) => crashServer.close(r));
    }
  });

  test('K4: @ai-sdk/anthropic and @anthropic-ai/sdk surface keysmith 401 reason in error.message', async () => {
    const model = createAnthropic({ baseURL: `${base}/v1`, apiKey: BAD_KEY })('ok/m');
    let aiSdkErr = null;
    try {
      await generateText({ model, maxRetries: 0, prompt: 'hi' });
    } catch (e) {
      aiSdkErr = e;
    }
    assert.ok(aiSdkErr, 'expected @ai-sdk/anthropic to reject on 401');
    assert.match(String(aiSdkErr.message), /missing or invalid API key/);

    const client = new Anthropic({ baseURL: base, apiKey: BAD_KEY, maxRetries: 0 });
    let officialErr = null;
    try {
      await client.messages.create({ model: 'ok/m', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      officialErr = e;
    }
    assert.ok(officialErr, 'expected @anthropic-ai/sdk to reject on 401');
    assert.equal(officialErr.status, 401);
    assert.match(String(officialErr.message), /missing or invalid API key/);
  });
});
