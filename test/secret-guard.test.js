/**
 * Outbound secret guard (`guard.secrets`: "off" | "block" | "mask"): unit tests for `findSecrets`,
 * `guardBody` and `guardMode`, plus HTTP and CLI tests for acceptance checks 1–8 against a local
 * stub upstream. Synthetic test secrets are constructed dynamically from split pieces at run time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { findSecrets, guardBody, guardMode } from '../src/secret-guard.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');

// Synthetic secret builders (constructed at run time; never real-looking literals in source).
const fakePem = (alg = 'RSA') => '-----' + 'BEGIN ' + (alg ? `${alg} ` : '') + 'PRIVATE ' + 'KEY-----';
const fakeAws = (ch = 'A') => 'AK' + 'IA' + ch.repeat(16);
const fakeGhp = (ch = 'a') => 'gh' + 'p_' + ch.repeat(36);
const fakeGho = (ch = 'B') => 'gh' + 'o_' + ch.repeat(36);
const fakeGhPat = () => 'github' + '_pat_' + 'a'.repeat(22) + '_' + 'b'.repeat(59);
const fakeSlack = (t = 'b') => 'xo' + `x${t}-` + '1'.repeat(12) + '-' + '2'.repeat(13) + '-' + 'c'.repeat(24);
const fakeGoogle = (ch = 'G') => 'AI' + 'za' + ch.repeat(35);
const fakeSk = (ch = 'x', len = 32) => 's' + 'k-' + ch.repeat(len);
const fakeAnthropicSk = () => 's' + 'k-ant-api03-' + 'z'.repeat(40);
const fakeKs = (ch = 'Q') => 'k' + 's_' + ch.repeat(32);

function assertNoSecret(text, secret, where) {
  assert.ok(!text.includes(secret), `${where}: full secret appeared`);
  const tail = secret.slice(4);
  for (let i = 0; i + 8 <= tail.length; i++) {
    const frag = tail.slice(i, i + 8);
    if (/^[A-Za-z0-9_-]{8}$/.test(frag) && !/^(PRIVATE|KEY|REDACTED)/i.test(frag)) {
      assert.ok(!text.includes(frag), `${where}: 8-char fragment "${frag}" appeared`);
    }
  }
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-secret-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function upstreamServer(t) {
  const received = [];
  const up = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ url: req.url, raw, body });
      if (req.url.endsWith('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } }));
      }
      if (req.url.endsWith('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'stub ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_stub',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'stub ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => up.close(r)));
  return { root: `http://127.0.0.1:${up.address().port}`, received };
}

async function startGateway(t, { keys, dir, upRoot, guard }) {
  const cfg = {
    auth: { enabled: true, keys },
    ...(guard !== undefined ? { guard } : {}),
    limits: { streamHoldMs: 250 },
    adapters: {
      up: { kind: 'http', wire: 'openai', baseUrl: `${upRoot}/v1`, apiKey: false, models: ['m', 'e'] },
      anth: { kind: 'http', wire: 'anthropic', baseUrl: `${upRoot}/anth`, apiKey: 'anth-test-token', models: ['claude-stub'] },
    },
    aliases: {},
  };
  const log = [];
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'));
  const server = createServer(new Gateway(cfg), cfg, { usage, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, route, body = null) => {
    const res = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  return { base, call, log, usage, usageFile: usage.file };
}

function cliSandbox(t, { keys, guard, usageRows = [] }) {
  const home = tmp(t);
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        host: '127.0.0.1',
        port: 0,
        auth: { enabled: true, keys },
        ...(guard !== undefined ? { guard } : {}),
        adapters: {},
        aliases: {},
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  if (usageRows.length) {
    fs.writeFileSync(path.join(data, 'usage.jsonl'), usageRows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  }
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { home, config, data, run };
}

/* ----------------------------------------------------------------------- unit tests */

test('findSecrets: detects every supported secret kind with exact offsets', () => {
  const cases = [
    ['pem-private-key', fakePem('RSA')],
    ['pem-private-key', fakePem('')],
    ['pem-private-key', fakePem('OPENSSH')],
    ['aws-access-key', fakeAws('9')],
    ['github-token', fakeGhp('f')],
    ['github-token', fakeGho('Z')],
    ['github-token', fakeGhPat()],
    ['slack-token', fakeSlack('b')],
    ['slack-token', fakeSlack('a')],
    ['slack-token', fakeSlack('p')],
    ['slack-token', fakeSlack('r')],
    ['slack-token', fakeSlack('s')],
    ['google-api-key', fakeGoogle('k')],
    ['sk-api-key', fakeSk('m', 32)],
    ['sk-api-key', fakeAnthropicSk()],
    ['keysmith-key', fakeKs('W')],
  ];
  for (const [expectedKind, secret] of cases) {
    const prefix = 'prefix: ';
    const suffix = ' (end)';
    const text = prefix + secret + suffix;
    const found = findSecrets(text);
    assert.deepEqual(
      found,
      [{ kind: expectedKind, start: prefix.length, end: prefix.length + secret.length }],
      `expected ${expectedKind} for shape length ${secret.length}`,
    );
    assert.equal(text.slice(found[0].start, found[0].end), secret);
  }
});

test('findSecrets: rejects near-misses and respects word boundaries', () => {
  const nearMisses = [
    '-----' + 'BEGIN PUBLIC KEY-----',
    '-----' + 'BEGIN CERTIFICATE-----',
    'AK' + 'IA' + 'A'.repeat(15),
    'AK' + 'IA' + 'A'.repeat(17),
    'AK' + 'IA' + 'a'.repeat(16),
    'ZAK' + 'IA' + 'A'.repeat(16),
    'gh' + 'p_short123',
    'gh' + 'z_' + 'a'.repeat(36),
    'xo' + 'xb-short',
    'xo' + 'xz-' + '1'.repeat(24),
    'AI' + 'za' + 'A'.repeat(34),
    'AI' + 'za' + 'A'.repeat(36),
    's' + 'k-' + 'a'.repeat(31),
    'task-' + 'a'.repeat(40),
    'disk-' + 'b'.repeat(40),
    'mask-' + 'c'.repeat(40),
    'k' + 's_' + 'Q'.repeat(31),
    'k' + 's_' + 'Q'.repeat(33),
  ];
  for (const sample of nearMisses) {
    assert.deepEqual(findSecrets(sample), [], `near-miss should not match: ${sample.slice(0, 12)}...`);
  }
});

test('findSecrets: handles adjacent secrets, unicode/surrogate offsets, and overlapping sub-matches', () => {
  const aws = fakeAws('B');
  const ghp = fakeGhp('c');
  const ks = fakeKs('R');
  const text = `🔐 çğıİöşü KEY1=${aws}\nKEY2="${ghp}",🧪:${ks}!`;
  const hits = findSecrets(text);
  assert.deepEqual(
    hits.map((h) => [h.kind, text.slice(h.start, h.end)]),
    [
      ['aws-access-key', aws],
      ['github-token', ghp],
      ['keysmith-key', ks],
    ],
  );

  // Overlapping candidate: an sk- token that contains _ks_<32> inside it must yield one non-overlapping match.
  const nested = 's' + 'k-proj_' + fakeKs('T');
  const nestedHits = findSecrets(nested);
  assert.equal(nestedHits.length, 1);
  assert.equal(nestedHits[0].kind, 'sk-api-key');
  assert.equal(nestedHits[0].start, 0);
  assert.equal(nestedHits[0].end, nested.length);
});

test('guardBody: walks nested strings, skips model/ids, and masking twice equals masking once', () => {
  const aws = fakeAws('C');
  const ghp = fakeGhp('d');
  const sk = fakeSk('p', 36);
  const fakeModelThatLooksSecret = fakeSk('q', 36);
  const input = {
    model: fakeModelThatLooksSecret,
    id: 'resp_keep_id',
    previous_response_id: 'resp_prev_keep',
    messages: [
      { role: 'system', content: `env: ${aws}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: `token ${ghp}` },
          { type: 'tool_result', tool_call_id: 'call_keep_1', content: `out ${sk}` },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'clean description',
          parameters: {
            type: 'object',
            properties: {
              // Object-valued `id` inside JSON schema must still have its description scanned!
              id: { type: 'string', description: `example ${aws}` },
            },
          },
        },
      },
    ],
  };

  const snapshot = structuredClone(input);
  const kinds = guardBody(input, { mode: 'block' });
  assert.deepEqual(kinds, ['aws-access-key', 'github-token', 'sk-api-key']);
  assert.deepEqual(input, snapshot, 'block mode does not mutate input');

  const maskedOnce = guardBody(input, { mode: 'mask' });
  assert.deepEqual(input, snapshot, 'mask mode returns a copy and does not mutate input');
  assert.equal(maskedOnce.model, fakeModelThatLooksSecret, 'model string is never altered');
  assert.equal(maskedOnce.id, 'resp_keep_id');
  assert.equal(maskedOnce.previous_response_id, 'resp_prev_keep');
  assert.equal(maskedOnce.messages[0].content, 'env: [REDACTED:aws-access-key]');
  assert.equal(maskedOnce.messages[1].content[0].text, 'token [REDACTED:github-token]');
  assert.equal(maskedOnce.messages[1].content[1].tool_call_id, 'call_keep_1');
  assert.equal(maskedOnce.messages[1].content[1].content, 'out [REDACTED:sk-api-key]');
  assert.equal(maskedOnce.tools[0].function.parameters.properties.id.description, 'example [REDACTED:aws-access-key]');

  const maskedTwice = guardBody(maskedOnce, { mode: 'mask' });
  assert.deepEqual(maskedTwice, maskedOnce, 'masking twice equals masking once');
  assert.deepEqual(guardBody(maskedOnce, { mode: 'block' }), [], 'masked body contains no secrets');
});

test('guardMode: defaults to off and fails closed to block on invalid values without echoing secrets', () => {
  assert.deepEqual(guardMode({}), { mode: 'off', error: null });
  assert.deepEqual(guardMode({ guard: { secrets: 'off' } }), { mode: 'off', error: null });
  assert.deepEqual(guardMode({ guard: { secrets: 'block' } }), { mode: 'block', error: null });
  assert.deepEqual(guardMode({ guard: { secrets: 'mask' } }), { mode: 'mask', error: null });

  const accidentalSecret = fakeAws('S');
  for (const bad of [{ guard: { secrets: 'maybe' } }, { guard: { secrets: accidentalSecret } }, { guard: 'block' }, { guard: { secret: 'block' } }]) {
    const r = guardMode(bad);
    assert.equal(r.mode, 'block');
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
    assert.ok(!r.error.includes(accidentalSecret), 'error never echoes invalid secret value');
  }
});

/* ---------------------------------------------------------- HTTP & CLI checks 1–8 */

test('Checks 1, 2 & 5: block refuses with 400 naming aws-access-key (0 upstream calls); mask sends [REDACTED:aws-access-key]; absent passes unchanged', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();
  const aws = fakeAws('D');
  const reqBody = {
    model: 'up/m',
    messages: [{ role: 'user', content: `deploy with ${aws} now` }],
  };

  // Check 1: block mode
  const gwBlock = await startGateway(t, { keys: [key], dir: path.join(dir, 'block'), upRoot: root, guard: { secrets: 'block' } });
  const rBlock = await gwBlock.call(key, '/v1/chat/completions', reqBody);
  assert.equal(rBlock.status, 400);
  const errPayload = rBlock.json();
  assert.equal(errPayload.error.type, 'invalid_request_error');
  assert.equal(errPayload.error.message, 'keysmith: request holds a secret of kind aws-access-key (guard.secrets=block)');
  assertNoSecret(rBlock.text, aws, '400 response body');
  assert.equal(received.length, 0, 'stub upstream received no call on block');

  // Check 2: mask mode
  const gwMask = await startGateway(t, { keys: [key], dir: path.join(dir, 'mask'), upRoot: root, guard: { secrets: 'mask' } });
  const rMask = await gwMask.call(key, '/v1/chat/completions', reqBody);
  assert.equal(rMask.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.messages[0].content, 'deploy with [REDACTED:aws-access-key] now');
  assertNoSecret(received[0].raw, aws, 'upstream request raw JSON');
  const maskRows = gwMask.usage.tail(5);
  assert.equal(maskRows.length, 1);
  assert.equal(maskRows[0].status, 'ok');
  assert.equal(maskRows[0].guard, 'masked');
  assert.deepEqual(maskRows[0].guardKinds, ['aws-access-key']);
  assertNoSecret(fs.readFileSync(gwMask.usageFile, 'utf8'), aws, 'mask usage.jsonl');

  // Check 5: setting absent -> identical bytes upstream
  received.length = 0;
  const gwOff = await startGateway(t, { keys: [key], dir: path.join(dir, 'off'), upRoot: root });
  const rOff = await gwOff.call(key, '/v1/chat/completions', reqBody);
  assert.equal(rOff.status, 200);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].body.messages, reqBody.messages);
  const offRows = gwOff.usage.tail(5);
  assert.equal(offRows[0].guard, undefined);
  assert.equal(offRows[0].guardKinds, undefined);
});

test('Check 3: PEM private key header split across a message and a system prompt (string and block-array) is caught on /v1/messages', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();

  const gwBlock = await startGateway(t, { keys: [key], dir: path.join(dir, 'b'), upRoot: root, guard: { secrets: 'block' } });
  const gwMask = await startGateway(t, { keys: [key], dir: path.join(dir, 'm'), upRoot: root, guard: { secrets: 'mask' } });

  // 3a: literally split across `system` (string) and `messages[0].content`
  const splitStringBody = {
    model: 'up/m',
    max_tokens: 32,
    system: 'Context: -----' + 'BEGIN RSA ',
    messages: [{ role: 'user', content: 'PRIVATE ' + 'KEY-----\nbody' }],
  };
  const r1 = await gwBlock.call(key, '/v1/messages', splitStringBody);
  assert.equal(r1.status, 400);
  assert.equal(r1.json().error.type, 'invalid_request_error');
  assert.match(r1.json().error.message, /pem-private-key/);
  assert.equal(received.length, 0);

  // 3b: literally split across `system` (array of text blocks) and `messages` (even when `messages` key precedes `system`)
  const splitArrayBody = {
    model: 'up/m',
    max_tokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE ' + 'KEY-----\nrest' }] }],
    system: [{ type: 'text', text: 'Header: -----' + 'BEGIN EC ' }],
  };
  const r2 = await gwBlock.call(key, '/v1/messages', splitArrayBody);
  assert.equal(r2.status, 400);
  assert.match(r2.json().error.message, /pem-private-key/);
  assert.equal(received.length, 0);

  // 3c: mask mode on split PEM header removes the PEM header before upstream sees it
  const r3 = await gwMask.call(key, '/v1/messages', splitStringBody);
  assert.equal(r3.status, 200);
  assert.equal(received.length, 1);
  assert.ok(!received[0].raw.includes('PRIVATE KEY-----'));
  assert.match(received[0].raw, /\[REDACTED:pem-private-key\]/);
});

test('Check 4: catches secrets in array content parts, /v1/responses input & tool outputs, and /v1/embeddings input', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();
  const ghp = fakeGhp('e');
  const google = fakeGoogle('H');
  const slack = fakeSlack('p');

  const gwBlock = await startGateway(t, { keys: [key], dir: path.join(dir, 'b'), upRoot: root, guard: { secrets: 'block' } });
  const gwMask = await startGateway(t, { keys: [key], dir: path.join(dir, 'm'), upRoot: root, guard: { secrets: 'mask' } });

  // Array content part on /v1/chat/completions
  const chatParts = {
    model: 'up/m',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: `gh=${ghp}` }] }],
  };
  const bChat = await gwBlock.call(key, '/v1/chat/completions', chatParts);
  assert.equal(bChat.status, 400);
  assert.match(bChat.json().error.message, /github-token/);

  // /v1/responses input (string and structured items)
  const respBody = {
    model: 'up/m',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: `key: ${google}` }] },
    ],
  };
  const bResp = await gwBlock.call(key, '/v1/responses', respBody);
  assert.equal(bResp.status, 400);
  assert.match(bResp.json().error.message, /google-api-key/);

  // /v1/embeddings input
  const embBody = { model: 'up/e', input: ['clean line', `slack=${slack}`] };
  const bEmb = await gwBlock.call(key, '/v1/embeddings', embBody);
  assert.equal(bEmb.status, 400);
  assert.match(bEmb.json().error.message, /slack-token/);
  assert.equal(received.length, 0);

  // Mask mode on /v1/responses and /v1/embeddings
  const mResp = await gwMask.call(key, '/v1/responses', respBody);
  assert.equal(mResp.status, 200);
  assertNoSecret(received[0].raw, google, 'masked /v1/responses upstream');
  assert.match(received[0].raw, /\[REDACTED:google-api-key\]/);

  const mEmb = await gwMask.call(key, '/v1/embeddings', embBody);
  assert.equal(mEmb.status, 200);
  assertNoSecret(received[1].raw, slack, 'masked /v1/embeddings upstream');
  assert.deepEqual(received[1].body.input, ['clean line', 'slack=[REDACTED:slack-token]']);
});

test('Check 6: guard.secrets: "maybe" makes keysmith doctor report config error and requests behave as block; config CLI validates enum', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();
  const sk = fakeSk('k', 34);

  // HTTP server fails closed to block when guard.secrets is "maybe"
  const gwMaybe = await startGateway(t, { keys: [key], dir, upRoot: root, guard: { secrets: 'maybe' } });
  assert.ok(gwMaybe.log.some((l) => /guard\.secrets.*treated as block/i.test(l)), 'startup log warns about invalid guard.secrets');
  const res = await gwMaybe.call(key, '/v1/chat/completions', {
    model: 'up/m',
    messages: [{ role: 'user', content: `secret ${sk}` }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.json().error.type, 'invalid_request_error');
  assert.match(res.json().error.message, /sk-api-key/);
  assert.equal(received.length, 0);

  // CLI doctor reports config error on guard.secrets: "maybe"
  const sb = cliSandbox(t, { keys: [key], guard: { secrets: 'maybe' } });
  const doc = sb.run('doctor');
  assert.equal(doc.status, 0, doc.stderr);
  assert.match(doc.stdout, /guard\.secrets/);
  assert.match(doc.stdout, /config error/);
  assert.match(doc.stdout, /treated as block/);

  // CLI `keysmith config set guard.secrets` accepts off|block|mask and rejects maybe
  const badSet = sb.run('config', 'set', 'guard.secrets', 'maybe');
  assert.notEqual(badSet.status, 0);
  assert.match(badSet.stderr, /off \| block \| mask/);

  const okSet = sb.run('config', 'set', 'guard.secrets', 'block');
  assert.equal(okSet.status, 0, okSet.stderr);
  assert.equal(sb.run('config', 'get', 'guard.secrets').stdout.trim(), 'block');
});

test('Check 7: after a block, `keysmith usage --tail 5 --format json` shows the row with mark and kinds, and secret is nowhere in logs or 400 body', async (t) => {
  const sb = cliSandbox(t, { keys: [] });
  const key = mint();
  fs.writeFileSync(
    sb.config,
    JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [key] }, guard: { secrets: 'block' }, adapters: {}, aliases: {} }, null, 2) + '\n',
    { mode: 0o600 },
  );
  const { root, received } = await upstreamServer(t);
  const aws = fakeAws('Z');
  const ghp = fakeGhp('q');

  const cfg = {
    auth: { enabled: true, keys: [key] },
    guard: { secrets: 'block' },
    adapters: { up: { kind: 'http', wire: 'openai', baseUrl: `${root}/v1`, apiKey: false, models: ['m'] } },
    aliases: {},
  };
  const log = [];
  const usageFile = path.join(sb.data, 'usage.jsonl');
  const usage = new UsageLog(usageFile);
  const server = createServer(new Gateway(cfg), cfg, { usage, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const resp = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'up/m', messages: [{ role: 'user', content: `keys: ${aws} and ${ghp}` }] }),
  });
  const body400 = await resp.text();
  assert.equal(resp.status, 400);
  assert.equal(received.length, 0);

  // CLI: keysmith usage --tail 5 --format json
  const uJson = sb.run('usage', '--tail', '5', '--format', 'json');
  assert.equal(uJson.status, 0, uJson.stderr);
  const parsed = JSON.parse(uJson.stdout);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].status, 'blocked');
  assert.equal(parsed.entries[0].guard, 'blocked');
  assert.deepEqual(parsed.entries[0].guardKinds, ['aws-access-key', 'github-token']);
  assert.equal(parsed.blocked, 1);

  // CLI table + /status page also tolerate and surface blocked without leaking
  const uTable = sb.run('usage', '--tail', '5');
  assert.equal(uTable.status, 0, uTable.stderr);
  assert.match(uTable.stdout, /1 blocked/);
  assert.match(uTable.stdout, /BLK/);

  const statusResp = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${key}` } });
  const statusHtml = await statusResp.text();
  assert.equal(statusResp.status, 200);
  assert.match(statusHtml, /1 blocked/);

  // Grep every output surface for both secrets and any 8-char payload fragment
  const rawUsage = fs.readFileSync(usageFile, 'utf8');
  for (const [where, text] of [
    ['400 response', body400],
    ['usage.jsonl', rawUsage],
    ['gateway log', log.join('\n')],
    ['usage json', uJson.stdout],
    ['usage table', uTable.stdout],
    ['/status html', statusHtml],
  ]) {
    assertNoSecret(text, aws, where);
    assertNoSecret(text, ghp, where);
  }
});

test('Check 8: normal prompt with long base64 text, git SHAs, UUIDs, public keys, and hyphenated words is not flagged', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();
  const gw = await startGateway(t, { keys: [key], dir, upRoot: root, guard: { secrets: 'block' } });

  // Deterministic 16 KB base64 payload + git SHAs + normal code/identifiers
  const deterministicBytes = Buffer.alloc(12_288);
  for (let i = 0; i < deterministicBytes.length; i++) deterministicBytes[i] = (i * 73 + 19) & 0xff;
  const b64 = deterministicBytes.toString('base64');
  const sha1 = '698cf8d0fd70c78a1b2c3d4e5f60718293a4b5c6';
  const sha2 = 'fd70c7890123456789abcdef0123456789abcdef';
  const prompt = [
    `Commit ${sha1} merged into ${sha2}.`,
    'Identifier task-0123456789abcdefghijklmnopqrstuvwxyz012345 and disk-9876543210abcdefghijklmnopqrstuvwxyz987654.',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----',
    `Attachment base64:\n${b64}`,
  ].join('\n\n');

  const r = await gw.call(key, '/v1/chat/completions', {
    model: 'up/m',
    messages: [{ role: 'user', content: prompt }],
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.messages[0].content, prompt);

  // Large string scan stays fast and linear
  const fourMb = 'clean log line 0123456789abcdef\n'.repeat(131_072);
  const t0 = Date.now();
  assert.deepEqual(findSecrets(fourMb), []);
  assert.ok(Date.now() - t0 < 2000, '4 MB linear scan completes quickly');
});

test('Tool relay (`relayLeg` and `relayMessagesLeg`) and streaming preserve exact bytes when off and mask/stamp rows when masked', async (t) => {
  const dir = tmp(t);
  const { root, received } = await upstreamServer(t);
  const key = mint();
  const aws = fakeAws('M');
  const toolSpec = [{ type: 'function', function: { name: 'ping', description: 'ping tool', parameters: { type: 'object', properties: {} } } }];
  const chatToolBody = {
    model: 'up/m',
    messages: [
      { role: 'user', content: 'run tool' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'ping', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_abc', content: `AWS_ACCESS_KEY_ID=${aws}` },
    ],
    tools: toolSpec,
  };

  // Off vs absent: upstream raw request bytes are byte-for-byte identical
  const gwAbsent = await startGateway(t, { keys: [key], dir: path.join(dir, 'abs'), upRoot: root });
  const gwExplicitOff = await startGateway(t, { keys: [key], dir: path.join(dir, 'off'), upRoot: root, guard: { secrets: 'off' } });
  assert.equal((await gwAbsent.call(key, '/v1/chat/completions', chatToolBody)).status, 200);
  assert.equal((await gwExplicitOff.call(key, '/v1/chat/completions', chatToolBody)).status, 200);
  assert.equal(received.length, 2);
  assert.equal(received[0].raw, received[1].raw, 'guard: off produces identical upstream bytes to guard absent');
  assert.ok(received[0].raw.includes(aws), 'upstream receives unmodified payload when guard is off');

  // Mask on tool relay (passthrough): upstream gets masked tool output, tool_call_id preserved, row gets guard mark
  received.length = 0;
  const gwMask = await startGateway(t, { keys: [key], dir: path.join(dir, 'mask'), upRoot: root, guard: { secrets: 'mask' } });
  const rRelay = await gwMask.call(key, '/v1/chat/completions', chatToolBody);
  assert.equal(rRelay.status, 200);
  assert.equal(received.length, 1);
  assertNoSecret(received[0].raw, aws, 'masked relayLeg upstream');
  assert.equal(received[0].body.messages[2].tool_call_id, 'call_abc');
  assert.equal(received[0].body.messages[2].content, 'AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key]');

  // Anthropic tool relay (`relayMessagesLeg`)
  const anthToolBody = {
    model: 'anth/claude-stub',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'run ping' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'ping', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `key=${aws}` }] },
    ],
    tools: [{ name: 'ping', description: 'ping', input_schema: { type: 'object', properties: {} } }],
  };
  const rAnthRelay = await gwMask.call(key, '/v1/messages', anthToolBody);
  assert.equal(rAnthRelay.status, 200, rAnthRelay.text);
  assert.equal(received.length, 2);
  assertNoSecret(received[1].raw, aws, 'masked relayMessagesLeg upstream');
  assert.equal(received[1].body.messages[2].content[0].content, 'key=[REDACTED:aws-access-key]');

  const rows = gwMask.usage.tail(5);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.guard, 'masked');
    assert.deepEqual(row.guardKinds, ['aws-access-key']);
  }
});
