/**
 * KS-AUDIT: per-request audit fields, price table, monthly log rotation, statistics (`--by`,
 * `--since`/`--until`, `--format table|csv|json`, `GET /v1/keysmith/usage`), and monthly
 * metered spend caps (`limits.spend`) per adapter and per account across all faces.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { DailyQuota } from '../src/quota.js';
import { createServer } from '../src/server.js';
import {
  DEFAULT_PRICING,
  MAX_ADAPTERS_SEEN,
  TAIL_RING_MAX,
  TAIL_RING_MAX_BYTES,
  UsageLog,
  computeCost,
  credentialAccount,
  formatUsageCsv,
  formatUsageTable,
  hostOf,
  matchPrice,
  parseSpendCaps,
  parseTag,
} from '../src/usage.js';
import { fingerprint } from '../src/redact.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');

const KEY_ADA = mint();
const KEY_BOB = mint();
const KEY_UNLABELLED = mint();
const SECRET_EXEC_VAL = 'sk-ant-api03-exec-secret-' + crypto.randomBytes(12).toString('hex');
const SECRET_FILE_VAL = 'sk-openai-file-secret-' + crypto.randomBytes(12).toString('hex');
const SECRET_ENV_VAL = 'sk-env-secret-' + crypto.randomBytes(12).toString('hex');
const SECRET_LITERAL_VAL = 'sk-literal-secret-' + crypto.randomBytes(12).toString('hex');

const CLI_STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'claude-opus-5-5';
const withAccount = argv.includes('--with-account');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (withAccount) line({ type: 'init', account: 'cli-team-seat' });
line({ type: 'event', event: { type: 'text_delta', delta: 'cli answer from ' + model } });
line({
  type: 'result',
  sessionId: 'cli_s1',
  subtype: 'success',
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 },
  stopReason: 'end_turn',
});
`;

let tmpDir;
let upstreamServer;
let upstreamPort;
let upstreamHits = [];
let slowGate = null;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-audit-'));
  process.env.KEYSMITH_AUDIT_TEST_KEY = SECRET_ENV_VAL;

  upstreamServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    upstreamHits.push({ url: req.url, headers: req.headers, body });

    if (slowGate) await slowGate;

    if (req.url.startsWith('/anthropic/')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'request-id': 'req_ant_01JXYZ987',
      });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 400,
          },
        },
      });
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `anthropic reply (${body.model})` },
      });
      ev('message_delta', {
        type: 'message_delta',
        usage: { output_tokens: 500 },
      });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }

    // OpenAI-wire stub
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req_oai_998877',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: `openai reply (${body.model})` } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 500, cache_creation_tokens: 250 },
        },
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });

  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
  upstreamPort = upstreamServer.address().port;
});

after(async () => {
  delete process.env.KEYSMITH_AUDIT_TEST_KEY;
  if (upstreamServer) {
    upstreamServer.closeAllConnections?.();
    await new Promise((r) => upstreamServer.close(r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ----------------------------------------------------- 1. credential & field helpers */

test('account names the credential source and never holds a secret value', () => {
  // Explicit cfg.account always wins
  assert.equal(
    credentialAccount({ account: 'team-seat-1', apiKey: '{env:IGNORED_VAR}' }),
    'team-seat-1',
  );
  // {exec:security find-generic-password ... -s NAME ...} extracts NAME
  assert.equal(
    credentialAccount({ apiKey: '{exec:security find-generic-password -a me -s claude-prod-key -w}' }),
    'claude-prod-key',
  );
  assert.equal(
    credentialAccount({ apiKey: '{exec:security find-generic-password --service=openai-work -w}' }),
    'openai-work',
  );
  // Any other {exec:...} reference (including curl -s with a URL/token) returns 'exec' with no text from it
  assert.equal(
    credentialAccount({ apiKey: '{exec:op read op://vault/item/credential}' }),
    'exec',
  );
  assert.equal(
    credentialAccount({ apiKey: '{exec:curl -s "https://vault.internal/v1/kv?token=hvs.SECRET_TOKEN_99"}' }),
    'exec',
  );
  // {env:...} extracts the environment variable name
  assert.equal(credentialAccount({ apiKey: '{env:ANTHROPIC_API_KEY}' }), 'ANTHROPIC_API_KEY');
  // {file:...} extracts the file's basename
  assert.equal(credentialAccount({ apiKey: '{file:~/.config/keys/claude.key}' }), 'claude.key');
  // Any other {...} reference (including {json:...}, {dotenv:...}, {custom:...}) returns 'exec'
  assert.equal(
    credentialAccount({ apiKey: '{json:~/.local/share/opencode/auth.json#evren.key}' }),
    'exec',
  );
  assert.equal(
    credentialAccount({ apiKey: '{dotenv:~/project/.env#GOOGLE_API_KEY}' }),
    'exec',
  );
  assert.equal(credentialAccount({ apiKey: '{custom:secret-ref}' }), 'exec');
  // A literal key in the config has no reference name -> null (never its secret value)
  const litAccount = credentialAccount({ apiKey: SECRET_LITERAL_VAL });
  assert.equal(litAccount, null);
  assert.equal(credentialAccount({}), null);
});

test('hostOf strips scheme, path, query, fragment and credentials', () => {
  assert.equal(hostOf('https://api.anthropic.com/v1/messages?beta=true#frag'), 'api.anthropic.com');
  assert.equal(hostOf('http://user:pass@127.0.0.1:8787/claude/v1?x=1'), '127.0.0.1:8787');
  assert.equal(hostOf('not a url'), null);
});

test('parseTag keeps [A-Za-z0-9._-] up to 40 chars and drops anything else', () => {
  assert.equal(parseTag('ao-review'), 'ao-review');
  assert.equal(parseTag('exp_2026.10-a'), 'exp_2026.10-a');
  assert.equal(parseTag('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(parseTag('a'.repeat(41)), null);
  assert.equal(parseTag('bad tag!'), null);
  assert.equal(parseTag('slash/not-allowed'), null);
  assert.equal(parseTag(''), null);
  assert.equal(parseTag(undefined), null);
});

/* ------------------------------------------- 2. price table & cost bases with cache */

test('default Anthropic price table and cost computation across metered, subscription and unpriced bases', () => {
  // Verify shipped Anthropic defaults (2026-10-20; 5-minute cache write rate)
  assert.deepEqual(DEFAULT_PRICING['*/claude-opus-5-5*'], {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
  });
  assert.deepEqual(DEFAULT_PRICING['*/claude-sonnet-5-5*'], {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  });
  assert.deepEqual(DEFAULT_PRICING['*/claude-haiku-5-5*'], {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  });

  // usage.input is total input charged (100k uncached + 200k cacheRead + 40k cacheWrite = 340k)
  const usage = { input: 340_000, output: 50_000, cacheRead: 200_000, cacheWrite: 40_000 };

  // Metered HTTP on claude-opus-5-5: ((340k-200k-40k)*4 + 50k*20 + 200k*0.2 + 40k*5) / 1M = (400k + 1000k + 40k + 200k)/1M = 1.64
  const opusCost = computeCost({
    usage,
    adapter: 'claude-api',
    model: 'claude-api/claude-opus-5-5-20261001',
    kind: 'http',
  });
  assert.deepEqual(opusCost, { usd: 1.64, basis: 'metered' });

  // Metered HTTP on claude-sonnet-5-5: (100k*2 + 50k*10 + 200k*0.1 + 40k*2.5) / 1M = 0.82
  const sonnetCost = computeCost({
    usage,
    adapter: 'claude-api',
    model: 'claude-api/claude-sonnet-5-5',
    kind: 'http',
  });
  assert.deepEqual(sonnetCost, { usd: 0.82, basis: 'metered' });

  // Metered HTTP on claude-haiku-5-5: (100k*0.1 + 50k*0.5 + 200k*0.01 + 40k*0.125) / 1M = 0.042
  const haikuCost = computeCost({
    usage,
    adapter: 'claude-api',
    model: 'claude-api/claude-haiku-5-5',
    kind: 'http',
  });
  assert.deepEqual(haikuCost, { usd: 0.042, basis: 'metered' });

  // Config override wins over default
  const overridden = computeCost({
    usage,
    adapter: 'claude-api',
    model: 'claude-api/claude-sonnet-5-5',
    kind: 'http',
    pricing: {
      'claude-api/claude-sonnet-5-5': { input: 10, output: 20, cacheRead: 1, cacheWrite: 5 },
    },
  });
  // (100k*10 + 50k*20 + 200k*1 + 40k*5) / 1M = 2.4
  assert.deepEqual(overridden, { usd: 2.4, basis: 'metered' });

  // Subscription CLI with a model in the price table: usd is 0, listUsd is computed
  const subPriced = computeCost({
    usage,
    adapter: 'claude-cli',
    model: 'claude-cli/claude-opus-5-5',
    kind: 'cli',
  });
  assert.deepEqual(subPriced, { usd: 0, basis: 'subscription', listUsd: 1.64 });

  // Subscription CLI with an unpriced model: usd is 0, no listUsd
  const subUnpriced = computeCost({
    usage,
    adapter: 'agy',
    model: 'agy/gemini-4-argon-high',
    kind: 'cli',
  });
  assert.deepEqual(subUnpriced, { usd: 0, basis: 'subscription' });

  // Unpriced HTTP adapter
  const unpricedHttp = computeCost({
    usage,
    adapter: 'ollama',
    model: 'ollama/qwen3:4b',
    kind: 'http',
  });
  assert.deepEqual(unpricedHttp, { usd: 0, basis: 'unpriced' });
});

/* ------------------------------ 3. end-to-end HTTP + CLI audit fields & redaction */

test('each new audit field is written on HTTP and CLI requests across faces, and account never holds a secret', async () => {
  const caseDir = fs.mkdtempSync(path.join(tmpDir, 'e2e-'));
  const cliBin = path.join(caseDir, 'cli-stub');
  fs.writeFileSync(cliBin, CLI_STUB, { mode: 0o755 });
  const keyFile = path.join(caseDir, 'openai-team.key');
  fs.writeFileSync(keyFile, SECRET_FILE_VAL, { mode: 0o600 });

  // {exec:...} reference that prints SECRET_EXEC_VAL while carrying `-s "https://vault.internal/..."`
  // must resolve to account "exec" (never leaking the argument to -s when the binary is not `security`).
  const execRef = `{exec:node -e "process.stdout.write('${SECRET_EXEC_VAL}')" -- -s "https://vault.internal/v1/kv?token=hvs.VAULT_TOKEN_123"}`;

  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada' },
        { key: KEY_BOB, label: 'bob', allow: ['cli-known', 'claude-api'] },
        KEY_UNLABELLED,
      ],
    },
    pricing: {
      'openai-api/gpt-5*': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1?org=test`,
        apiKey: execRef,
        models: ['claude-sonnet-5-5'],
      },
      'openai-api': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/openai/v1`,
        apiKey: `{file:${keyFile}}`,
        models: ['gpt-5-mini', 'unpriced-model'],
      },
      'cli-known': {
        kind: 'cli',
        bin: cliBin,
        args: ['--with-account', '--model', '{model}', '{prompt}'],
        parser: 'cmd-ndjson',
        account: 'cli-team-seat',
        models: ['claude-opus-5-5'],
        timeoutMs: 10_000,
      },
      'cli-anon': {
        kind: 'cli',
        bin: cliBin,
        args: ['--with-account', '--model', '{model}', '{prompt}'],
        parser: 'cmd-ndjson',
        models: ['custom-local'],
        timeoutMs: 10_000,
      },
    },
    aliases: {},
    limits: {},
  };

  const usageFile = path.join(caseDir, 'usage.jsonl');
  const usage = new UsageLog(usageFile, { pricing: cfg.pricing });
  const gateway = new Gateway(cfg, { usage });
  const server = createServer(gateway, cfg, { usage });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1) HTTP Anthropic adapter via /v1/messages with valid x-keysmith-tag
    const reqBody1 = JSON.stringify({
      model: 'claude-api/claude-sonnet-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res1 = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY_ADA}`,
        'content-type': 'application/json',
        'user-agent': 'audit-test/1.0',
        'x-keysmith-tag': 'ao-review',
      },
      body: reqBody1,
    });
    const text1 = await res1.text();
    assert.equal(res1.status, 200);

    // 2) HTTP OpenAI adapter via /v1/responses with invalid tag (dropped)
    const reqBody2 = JSON.stringify({
      model: 'openai-api/gpt-5-mini',
      input: 'hello responses',
    });
    const res2 = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY_ADA}`,
        'content-type': 'application/json',
        'x-keysmith-tag': 'invalid tag with spaces!',
      },
      body: reqBody2,
    });
    await res2.text();
    assert.equal(res2.status, 200);

    // 3) CLI adapter that reports its account, via /v1/chat/completions
    const reqBody3 = JSON.stringify({
      model: 'cli-known/claude-opus-5-5',
      messages: [{ role: 'user', content: 'hello cli' }],
    });
    const res3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY_BOB}`,
        'content-type': 'application/json',
        'x-keysmith-tag': 'cli_run.1',
      },
      body: reqBody3,
    });
    const text3 = await res3.text();
    assert.equal(res3.status, 200);

    // 4) CLI adapter that cannot tell its account, with unlabelled key and unpriced model
    const reqBody4 = JSON.stringify({
      model: 'cli-anon/custom-local',
      messages: [{ role: 'user', content: 'hello anon' }],
    });
    const res4 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY_UNLABELLED}`,
        'content-type': 'application/json',
      },
      body: reqBody4,
    });
    await res4.text();
    assert.equal(res4.status, 200);

    const rows = usage.readAll();
    assert.equal(rows.length, 4);

    // Row 1: HTTP Anthropic via /v1/messages
    const r1 = rows[0];
    assert.equal(r1.key, `fp:${fingerprint(KEY_ADA)}`);
    assert.equal(r1.label, 'ada');
    assert.equal(r1.adapter, 'claude-api');
    assert.equal(r1.kind, 'http');
    assert.equal(r1.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(r1.account, 'exec');
    assert.equal(r1.face, 'messages');
    assert.equal(r1.bytesIn, Buffer.byteLength(reqBody1));
    assert.equal(r1.bytesOut, Buffer.byteLength(text1));
    assert.equal(r1.upstreamId, 'req_ant_01JXYZ987');
    assert.equal(r1.tag, 'ao-review');
    // usage.input includes cacheRead + cacheWrite (1000 + 2000 + 400 = 3400); pricing charges uncached 1000 at input rate
    assert.deepEqual(r1.usage, { input: 3400, output: 500, cacheRead: 2000, cacheWrite: 400 });
    // claude-sonnet-5-5: (3400-2000-400) in * 2 + 500 out * 10 + 2000 cacheRead * 0.1 + 400 cacheWrite * 2.5 = 8200 / 1M = 0.0082
    assert.deepEqual(r1.cost, { usd: 0.0082, basis: 'metered' });

    // Row 2: HTTP OpenAI via /v1/responses, invalid tag dropped, usage.input keeps total prompt_tokens (2000)
    const r2 = rows[1];
    assert.equal(r2.adapter, 'openai-api');
    assert.equal(r2.kind, 'http');
    assert.equal(r2.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(r2.account, 'openai-team.key');
    assert.equal(r2.face, 'responses');
    assert.equal(r2.upstreamId, 'req_oai_998877');
    assert.equal('tag' in r2, false);
    assert.deepEqual(r2.usage, { input: 2000, output: 1000, cacheRead: 500, cacheWrite: 250 });
    // gpt-5-mini: (2000-500-250)*2 + 1000*8 + 500*0.5 + 250*1 = 11000 / 1M = 0.011
    assert.deepEqual(r2.cost, { usd: 0.011, basis: 'metered' });

    // Row 3: CLI adapter with configured account and listUsd
    const r3 = rows[2];
    assert.equal(r3.key, `fp:${fingerprint(KEY_BOB)}`);
    assert.equal(r3.label, 'bob');
    assert.equal(r3.adapter, 'cli-known');
    assert.equal(r3.kind, 'cli');
    assert.equal('host' in r3, false);
    assert.equal(r3.account, 'cli-team-seat');
    assert.equal(r3.face, 'chat');
    assert.equal(r3.bytesIn, Buffer.byteLength(reqBody3));
    assert.equal(r3.bytesOut, Buffer.byteLength(text3));
    assert.equal(r3.tag, 'cli_run.1');
    assert.deepEqual(r3.usage, { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 });
    // claude-opus-5-5 list price (input 1000 includes 500 cacheRead + 100 cacheWrite -> 400 uncached):
    // (400*4 + 200*20 + 500*0.2 + 100*5) / 1M = 0.0062
    assert.deepEqual(r3.cost, { usd: 0, basis: 'subscription', listUsd: 0.0062 });

    // Row 4: CLI adapter with no configured account ignores stdout "account" -> account: null
    const r4 = rows[3];
    assert.equal(r4.key, `fp:${fingerprint(KEY_UNLABELLED)}`);
    assert.equal('label' in r4, false);
    assert.equal(r4.adapter, 'cli-anon');
    assert.equal(r4.kind, 'cli');
    assert.equal('host' in r4, false);
    assert.equal(r4.account, null);
    assert.equal('tag' in r4, false);
    assert.deepEqual(r4.cost, { usd: 0, basis: 'subscription' });

    // Verify raw file on disk never contains any secret value and has 0600 mode
    const rawDisk = fs.readFileSync(usageFile, 'utf8');
    assert.ok(!rawDisk.includes(SECRET_EXEC_VAL));
    assert.ok(!rawDisk.includes('hvs.VAULT_TOKEN_123'));
    assert.ok(!rawDisk.includes(SECRET_FILE_VAL));
    assert.ok(!rawDisk.includes(KEY_ADA));
    assert.ok(!rawDisk.includes(KEY_BOB));
    assert.equal(fs.statSync(usageFile).mode & 0o777, 0o600);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* -------------------------- 4. monthly rotation, whole-log stats, CLI & HTTP query */

test('monthly UTC log files keep usage.jsonl for tail -f, roll closed months, and query reads every month past 5000 lines', () => {
  const monthDir = fs.mkdtempSync(path.join(tmpDir, 'months-'));
  const usageFile = path.join(monthDir, 'usage.jsonl');
  let now = new Date('2026-09-15T12:00:00.000Z');
  const usage = new UsageLog(usageFile, { now: () => now });

  // Write 5,100 rows in 2026-09 so total rows exceed the old 5,000-line cap
  const makeSepRow = (i) => ({
    ts: '2026-09-15T12:00:00.000Z',
    key: 'fp:11111111',
    label: 'ada',
    adapter: 'claude-api',
    kind: 'http',
    host: 'api.anthropic.com',
    account: 'ANTHROPIC_API_KEY',
    model: 'claude-api/claude-haiku-5-5',
    face: 'chat',
    status: i % 100 === 0 ? 'error' : 'ok',
    ms: 100 + (i % 50),
    usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    cost: { usd: 0.001, basis: 'metered' },
    tag: 'batch-sep',
    client: 'curl/8.0',
  });
  for (let i = 0; i < 10; i++) usage.record(makeSepRow(i));
  const bulkLines = [];
  for (let i = 10; i < 5100; i++) bulkLines.push(JSON.stringify(makeSepRow(i)));
  fs.appendFileSync(usageFile, bulkLines.join('\n') + '\n');
  assert.ok(fs.existsSync(usageFile));
  assert.equal(fs.existsSync(`${usageFile}.2026-09`), false);
  const inoBeforeRollover = fs.statSync(usageFile).ino;

  // Advance clock to 2026-10: recording rolls 2026-09 to usage.jsonl.2026-09 and writes 2026-10 into usage.jsonl
  now = new Date('2026-10-20T10:00:00.000Z');
  for (let i = 0; i < 100; i++) {
    usage.record({
      ts: `2026-10-${String(10 + (i % 10)).padStart(2, '0')}T10:00:00.000Z`,
      key: 'fp:22222222',
      label: 'bob',
      adapter: 'claude-cli',
      kind: 'cli',
      account: 'bob-seat',
      model: 'claude-cli/claude-sonnet-5-5',
      face: 'messages',
      status: 'ok',
      ms: 200 + i,
      usage: { input: 500, output: 200, cacheRead: 1000, cacheWrite: 0 },
      cost: { usd: 0, basis: 'subscription', listUsd: 0.0031 },
      tag: i < 50 ? 'ao-review' : 'oct-dev',
      client: 'claude-code/2.1',
    });
  }

  // Verify rollover atomically renamed 2026-09 to usage.jsonl.2026-09 and opened a fresh usage.jsonl for tail -F
  assert.ok(fs.existsSync(`${usageFile}.2026-09`), 'closed month rolled to usage.jsonl.2026-09');
  assert.ok(fs.existsSync(usageFile), 'current month written at usage.jsonl for tail -F');
  assert.equal(fs.statSync(`${usageFile}.2026-09`).ino, inoBeforeRollover, 'rollover atomically renames usage.jsonl to usage.jsonl.YYYY-MM');

  // Whole-log query reads all 5,200 lines across both months
  const allStats = usage.query({ by: ['adapter', 'tag'] });
  assert.equal(allStats.totals.requests, 5200);
  assert.equal(allStats.totals.failures, 51);
  assert.equal(allStats.totals.meteredUsd, 5.1);
  assert.equal(allStats.totals.listUsd, 0.31);
  assert.equal(allStats.groups.length, 3);

  // Range query with --since / --until dates
  const octOnly = usage.query({
    by: ['day'],
    since: '2026-10-01',
    until: '2026-10-14',
  });
  // Days 10, 11, 12, 13, 14 -> 5 days * 10 requests each = 50 requests
  assert.equal(octOnly.totals.requests, 50);
  assert.equal(octOnly.groups.length, 5);

  // Relative duration (--since 7d from now = 2026-10-20T10:00:00Z -> since 2026-10-13T10:00:00Z)
  const last7d = usage.query({
    by: ['label', 'account'],
    since: '7d',
  });
  // Days 13..19 -> 7 days * 10 = 70 requests
  assert.equal(last7d.totals.requests, 70);
  assert.equal(last7d.groups[0].label, 'bob');
  assert.equal(last7d.groups[0].account, 'bob-seat');
  assert.ok(last7d.groups[0].p50Ms >= 200);
  assert.ok(last7d.groups[0].p95Ms >= last7d.groups[0].p50Ms);

  // Formatters: CSV and table
  const csv = formatUsageCsv(allStats);
  const csvLines = csv.trim().split('\n');
  assert.equal(
    csvLines[0],
    'adapter,tag,requests,failures,input,output,cacheRead,cacheWrite,meteredUsd,listUsd,p50Ms,p95Ms',
  );
  assert.equal(csvLines.length, 5); // header + 3 groups + TOTAL

  const table = formatUsageTable(allStats, {
    spend: [{ target: 'claude-api', kind: 'adapter', month: '2026-10', spent: 1.25, cap: 5, resetAt: '2026-11-01T00:00:00Z', exceeded: false }],
  });
  assert.match(table, /requests: 5200/);
  assert.match(table, /spend caps \(2026-10/);
  assert.match(table, /\$1\.25 \/ \$5\.00/);

  // Also test `keysmith usage` CLI command with --by, --since, --format csv|json|table
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    KEYSMITH_DATA: monthDir,
    KEYSMITH_CONFIG: path.join(monthDir, 'config.json'),
  };
  fs.writeFileSync(
    env.KEYSMITH_CONFIG,
    JSON.stringify({
      auth: { enabled: true, keys: [KEY_ADA] },
      limits: { spend: { 'claude-api': 10 } },
      adapters: {},
    }),
    { mode: 0o600 },
  );

  const cliJson = spawnSync(
    process.execPath,
    [CLI_PATH, 'usage', '--by', 'adapter,model', '--since', '2026-09-01', '--format', 'json'],
    { env, encoding: 'utf8' },
  );
  assert.equal(cliJson.status, 0, cliJson.stderr);
  const parsedCliJson = JSON.parse(cliJson.stdout);
  assert.equal(parsedCliJson.totals.requests, 5200);
  assert.equal(parsedCliJson.spend[0].target, 'claude-api');
  assert.equal(parsedCliJson.spend[0].cap, 10);

  const cliCsv = spawnSync(
    process.execPath,
    [CLI_PATH, 'usage', '--by', 'tag', '--since', '2026-10-01', '--format', 'csv'],
    { env, encoding: 'utf8' },
  );
  assert.equal(cliCsv.status, 0, cliCsv.stderr);
  assert.match(cliCsv.stdout, /^tag,requests,failures,input,output,cacheRead,cacheWrite,meteredUsd,listUsd,p50Ms,p95Ms/m);
});

/* ---------------- 5. spend cap: 429 per face, in-flight, restart, next-month reset */

test('limits.spend caps monthly metered USD per adapter and per account, refuses with 429 in each face, allows in-flight to finish, survives restart, and resets next month', async () => {
  const capDir = fs.mkdtempSync(path.join(tmpDir, 'caps-'));
  const usageFile = path.join(capDir, 'usage.jsonl');
  let now = new Date('2026-10-20T15:00:00.000Z');

  // Each Anthropic stub call spends $0.0082 (1000 in, 500 out, 2000 cacheRead, 400 cacheWrite on claude-sonnet-5-5).
  // Set adapter cap on `claude-api` to $0.015 (2 requests cross it: $0.0164 >= $0.015),
  // and account cap on `KEYSMITH_AUDIT_TEST_KEY` to $0.0082 (1 request reaches it: $0.0082 >= $0.0082).
  const makeCfg = () => ({
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada' },
        { key: KEY_BOB, label: 'bob', allow: ['acct-capped'] },
      ],
    },
    limits: {
      spend: {
        'claude-api': 0.015,
        KEYSMITH_AUDIT_TEST_KEY: 0.0082,
      },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5'],
      },
      'acct-capped': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: '{env:KEYSMITH_AUDIT_TEST_KEY}',
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  });

  const cfg1 = makeCfg();
  const usage1 = new UsageLog(usageFile, { now: () => now, pricing: cfg1.pricing });
  const gw1 = new Gateway(cfg1, { usage: usage1 });
  const srv1 = createServer(gw1, cfg1, { usage: usage1 });
  await new Promise((r) => srv1.listen(0, '127.0.0.1', r));
  const base1 = `http://127.0.0.1:${srv1.address().port}`;
  const authAda = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const authBob = { authorization: `Bearer ${KEY_BOB}`, 'content-type': 'application/json' };

  try {
    // Request 1 to claude-api ($0.0082 < $0.015): succeeds
    const r1 = await fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'one' }] }),
    });
    assert.equal(r1.status, 200);

    // Launch two concurrent requests while spend is $0.0082 (< $0.015):
    // Both pass the pre-request check before either finishes; both must finish with 200 even
    // though the first one to complete pushes spend to $0.0164 (past the $0.015 cap).
    let releaseSlow;
    slowGate = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const inFlightA = fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'two-a' }] }),
    });
    const inFlightB = fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'two-b' }] }),
    });
    await new Promise((r) => setTimeout(r, 40));
    slowGate = null;
    releaseSlow();
    const [resA, resB] = await Promise.all([inFlightA, inFlightB]);
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    // Spend is now 3 * $0.0082 = $0.0246 (past the $0.015 cap).
    // Verify refusal on all three faces, and verify upstream is NOT called!
    const hitsBeforeRefusals = upstreamHits.length;

    // Face 1: /v1/chat/completions
    const refChat = await fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'blocked' }] }),
    });
    assert.equal(refChat.status, 429);
    const bodyChat = await refChat.json();
    assert.equal(bodyChat.error.type, 'rate_limit_error');
    assert.match(bodyChat.error.message, /\$0\.015/);
    assert.match(bodyChat.error.message, /\$0\.0246/);
    assert.match(bodyChat.error.message, /2026-11-01T00:00:00Z/);

    // Face 2: /v1/messages (Anthropic error shape: top-level type: "error" + error.type: "rate_limit_error")
    const refMsg = await fetch(`${base1}/v1/messages`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'blocked' }] }),
    });
    assert.equal(refMsg.status, 429);
    const bodyMsg = await refMsg.json();
    assert.equal(bodyMsg.type, 'error');
    assert.equal(bodyMsg.error.type, 'rate_limit_error');
    assert.match(bodyMsg.error.message, /\$0\.015/);
    assert.match(bodyMsg.error.message, /2026-11-01T00:00:00Z/);

    // Face 3: /v1/responses
    const refResp = await fetch(`${base1}/v1/responses`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', input: 'blocked' }),
    });
    assert.equal(refResp.status, 429);
    const bodyResp = await refResp.json();
    assert.equal(bodyResp.error.type, 'rate_limit_error');
    assert.match(bodyResp.error.message, /\$0\.015/);
    assert.match(bodyResp.error.message, /2026-11-01T00:00:00Z/);

    // Upstream never heard of any of the 3 refused requests
    assert.equal(upstreamHits.length, hitsBeforeRefusals);

    // Account-level cap on `KEYSMITH_AUDIT_TEST_KEY` ($0.0082 — exact boundary: 1st succeeds, 2nd is AT the cap and is refused)
    const acctOk = await fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authBob,
      body: JSON.stringify({ model: 'acct-capped/claude-sonnet-5-5', messages: [{ role: 'user', content: 'acct-1' }] }),
    });
    assert.equal(acctOk.status, 200);

    const acctRef = await fetch(`${base1}/v1/chat/completions`, {
      method: 'POST',
      headers: authBob,
      body: JSON.stringify({ model: 'acct-capped/claude-sonnet-5-5', messages: [{ role: 'user', content: 'acct-2' }] }),
    });
    assert.equal(acctRef.status, 429);
    const bodyAcct = await acctRef.json();
    assert.match(bodyAcct.error.message, /KEYSMITH_AUDIT_TEST_KEY/);
    assert.match(bodyAcct.error.message, /\$0\.0082/);
    assert.match(bodyAcct.error.message, /2026-11-01T00:00:00Z/);

    // Check scoped vs unscoped view on GET /v1/keysmith/usage
    const usageAda = await (await fetch(`${base1}/v1/keysmith/usage?by=adapter,model&tail=20`, { headers: authAda })).json();
    assert.equal(usageAda.totals.requests, 8); // 3 ok + 3 refused on claude-api + 1 ok + 1 refused on acct-capped
    assert.equal(usageAda.totals.failures, 4); // the 4 cap refusals were each recorded as their own error line

    const usageBob = await (await fetch(`${base1}/v1/keysmith/usage?by=adapter`, { headers: authBob })).json();
    // Bob is scoped to `acct-capped` only: sees only his 2 requests (1 ok, 1 refused)
    assert.equal(usageBob.totals.requests, 2);
    assert.equal(usageBob.totals.failures, 1);
    assert.equal(usageBob.groups.length, 1);
    assert.equal(usageBob.groups[0].adapter, 'acct-capped');
  } finally {
    await new Promise((r) => srv1.close(r));
  }

  // Restart gateway on the same usage.jsonl: cap state survives from disk!
  const cfg2 = makeCfg();
  const usage2 = new UsageLog(usageFile, { now: () => now, pricing: cfg2.pricing });
  const gw2 = new Gateway(cfg2, { usage: usage2 });
  const srv2 = createServer(gw2, cfg2, { usage: usage2 });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${srv2.address().port}`;

  try {
    const afterRestart = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'after-restart' }] }),
    });
    assert.equal(afterRestart.status, 429, 'spend cap survives a gateway restart');

    // Advance clock to next UTC month (2026-11): cap resets and requests succeed again
    now = new Date('2026-11-01T00:00:05.000Z');
    const nextMonthRes = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'november' }] }),
    });
    assert.equal(nextMonthRes.status, 200, 'spend cap resets at the start of the next UTC month');
  } finally {
    await new Promise((r) => srv2.close(r));
  }
});

/* ---------------- 6. daily cap + spend cap unified: month boundary, audit lines, usage & status page */

test('daily cap and limits.spend: DailyQuota seeds across monthly files at local midnight, each cap writes its own refusal line, and both caps show in keysmith usage and on the status page', async () => {
  const unifyDir = fs.mkdtempSync(path.join(tmpDir, 'unify-'));
  const usageFile = path.join(unifyDir, 'usage.jsonl');
  const fpAda = fingerprint(KEY_ADA);

  // 1) Cross-month boundary at local midnight:
  // Suppose a local day spans the end of 2026-10 UTC (`usage.jsonl.2026-10`) and start of 2026-11 UTC (`usage.jsonl`).
  let clockMs = Date.parse('2026-09-30T12:00:00.000Z');
  const usageBoundary = new UsageLog(usageFile, { now: () => clockMs });
  usageBoundary.record({ key: `fp:${fpAda}`, label: 'ada', model: 'm', status: 'ok' });

  clockMs = Date.parse('2026-10-31T20:00:00.000Z');
  usageBoundary.record({ key: `fp:${fpAda}`, label: 'ada', model: 'm', status: 'ok' });
  clockMs = Date.parse('2026-10-31T23:30:00.000Z');
  usageBoundary.record({ key: `fp:${fpAda}`, label: 'ada', model: 'm', status: 'ok' });
  clockMs = Date.parse('2026-10-31T23:45:00.000Z');
  usageBoundary.record({ key: `fp:${fpAda}`, label: 'ada', model: 'm', status: 'limited' });

  // Roll over to 2026-11 UTC
  clockMs = Date.parse('2026-11-01T00:15:00.000Z');
  usageBoundary.record({ key: `fp:${fpAda}`, label: 'ada', model: 'm', status: 'ok' });
  assert.ok(fs.existsSync(`${usageFile}.2026-09`));
  assert.ok(fs.existsSync(`${usageFile}.2026-10`));
  assert.ok(fs.existsSync(usageFile));

  // Query rowsSince across the 2026-10 -> 2026-11 UTC rollover (since 2026-10-31T23:00:00Z):
  // Should read the 23:30Z and 23:45Z rows from usage.jsonl.2026-10 and the 00:15Z row from usage.jsonl,
  // stopping before the 20:00Z row and never needing usage.jsonl.2026-09.
  const crossRows = usageBoundary.rowsSince(Date.parse('2026-10-31T23:00:00.000Z'));
  assert.equal(crossRows.length, 3);
  assert.deepEqual(
    crossRows.map((r) => r.ts),
    ['2026-10-31T23:30:00.000Z', '2026-10-31T23:45:00.000Z', '2026-11-01T00:15:00.000Z'],
  );

  // Also test DailyQuota.seed when local day starts at local midnight on 1st of month, written via usageLocal.record()
  const localNov1Start = new Date(2026, 10, 1, 0, 0, 0).getTime(); // local 2026-11-01 00:00:00
  const dirLocal = fs.mkdtempSync(path.join(tmpDir, 'local-boundary-'));
  const fileLocal = path.join(dirLocal, 'usage.jsonl');
  let localClock = localNov1Start - 24 * 3600_000;
  const writerLocal = new UsageLog(fileLocal, { now: () => localClock });
  writerLocal.record({ key: `fp:${fpAda}`, status: 'ok' }); // yesterday in 2026-10 UTC
  localClock = localNov1Start - 60_000;
  writerLocal.record({ key: `fp:${fpAda}`, status: 'ok' }); // 1 min before local midnight
  localClock = localNov1Start + 10_000;
  writerLocal.record({ key: `fp:${fpAda}`, status: 'ok' }); // 10s after local midnight (today #1)
  localClock = localNov1Start + 4 * 3600_000;
  writerLocal.record({ key: `fp:${fpAda}`, status: 'ok' }); // 4h after local midnight (today #2)

  const usageLocal = new UsageLog(fileLocal, { now: () => localNov1Start + 5 * 3600_000 });
  const dq = new DailyQuota({ now: () => localNov1Start + 5 * 3600_000 });
  dq.seed(usageLocal);
  assert.deepEqual(dq.today(fpAda), { requests: 2, refused: 0 }, 'DailyQuota.seed counts rows of today across monthly rollover files');

  // 2) Refusal audit lines and display of both caps in `keysmith usage` and on the status page:
  const bothDir = fs.mkdtempSync(path.join(tmpDir, 'both-caps-'));
  const bothFile = path.join(bothDir, 'usage.jsonl');
  const nowFixed = new Date(2026, 9, 20, 14, 0, 0).getTime();
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', perDay: 2 },
        { key: KEY_UNLABELLED, label: 'owner' },
      ],
    },
    limits: {
      spend: {
        'claude-api': 0.0082, // 1 request reaches the spend cap
      },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };

  const uLog = new UsageLog(bothFile, { now: () => nowFixed, pricing: cfg.pricing });
  const gw = new Gateway(cfg, { usage: uLog });
  const srv = createServer(gw, cfg, { usage: uLog, now: () => nowFixed });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const authAda = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const authOwner = { authorization: `Bearer ${KEY_UNLABELLED}`, 'content-type': 'application/json' };

  try {
    // Request 1 by ada: succeeds (1/2 daily cap used, $0.0082/$0.0082 spend cap reached)
    const req1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'r1' }] }),
    });
    assert.equal(req1.status, 200);

    // Request 2 by ada: admitted by daily cap (2/2 daily cap used), refused by `limits.spend` (429)
    const req2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'r2' }] }),
    });
    assert.equal(req2.status, 429);
    const err2 = await req2.json();
    assert.match(err2.error.message, /spend cap reached for adapter "claude-api"/);

    // Request 3 by ada: refused by per-key daily cap (429, over perDay: 2)
    const req3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'r3' }] }),
    });
    assert.equal(req3.status, 429);
    const err3 = await req3.json();
    assert.match(err3.error.message, /daily cap of 2 requests is used up/);

    // Verify the usage log holds 3 lines: 1 ok, 1 spend-cap refusal, 1 daily-cap refusal, each with its own reason
    const lines = uLog.readAll();
    assert.equal(lines.length, 3);
    assert.equal(lines[0].status, 'ok');
    assert.equal(lines[1].status, 'error');
    assert.match(lines[1].error, /spend cap reached for adapter "claude-api"/);
    assert.equal(lines[2].status, 'limited');
    assert.match(lines[2].error, /daily cap of 2 requests is used up/);

    // Verify GET /v1/keysmith/usage includes both `spend` and `daily`
    const usageResp = await (await fetch(`${base}/v1/keysmith/usage`, { headers: authOwner })).json();
    assert.equal(usageResp.spend.length, 1);
    assert.equal(usageResp.spend[0].target, 'claude-api');
    assert.equal(usageResp.spend[0].exceeded, true);
    assert.equal(usageResp.daily.length, 1);
    assert.equal(usageResp.daily[0].fp, fpAda);
    assert.equal(usageResp.daily[0].requests, 2);
    assert.equal(usageResp.daily[0].perDay, 2);
    assert.equal(usageResp.daily[0].refused, 1);
    assert.equal(usageResp.daily[0].exceeded, true);

    // Verify status page (`GET /`) shows both the per-key daily cap and the monthly spend cap
    const pageHtml = await (await fetch(`${base}/`, { headers: authOwner })).text();
    assert.match(pageHtml, /today \/ cap/);
    assert.match(pageHtml, /2 \/ 2/);
    assert.match(pageHtml, /1 refused/);
    assert.match(pageHtml, /Spend caps/);
    assert.match(pageHtml, /claude-api/);
    assert.match(pageHtml, /\$0\.0082 \/ \$0\.0082/);

    // Verify `keysmith usage` CLI table output shows both `spend caps` and `daily caps`
    const tableText = formatUsageTable(uLog.query(), {
      spend: usageResp.spend,
      daily: usageResp.daily,
    });
    assert.match(tableText, /spend caps/);
    assert.match(tableText, /adapter claude-api\s+\$0\.0082 \/ \$0\.0082\s+CAPPED/);
    assert.match(tableText, /daily caps/);
    assert.match(tableText, new RegExp(`fp:${fpAda} \\(ada\\)\\s+2 / 2 requests \\(1 refused\\)\\s+CAPPED`));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------- 7. max_tokens vs modelParams.max_tokens on Anthropic and OpenAI wires */

test('HttpAdapter max_tokens order: client max_tokens first, then modelParams.max_tokens, then 4096 on Anthropic wire (none on OpenAI wire)', async () => {
  const anthPayloads = [];
  const oaiPayloads = [];

  const drain = async (gen) => {
    for await (const evt of gen) void evt;
  };

  // Stub server that records raw request bodies on both wires
  const wireSrv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url.endsWith('/messages')) {
      anthPayloads.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return res.end();
    }
    oaiPayloads.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    return res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => wireSrv.listen(0, '127.0.0.1', r));
  const port = wireSrv.address().port;

  try {
    const anthWithParam = new HttpAdapter('anth', {
      wire: 'anthropic',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: false,
      modelParams: {
        '*': { max_tokens: 8192 },
        'claude-opus-5-5': { max_tokens: 16384 },
      },
    });
    const anthPlain = new HttpAdapter('anth-plain', {
      wire: 'anthropic',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: false,
    });

    // Anthropic wire:
    // 1) Client omits maxTokens -> modelParams['claude-opus-5-5'].max_tokens (16384) wins over '*' (8192) and 4096
    await drain(anthWithParam.complete({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(anthPayloads.at(-1).max_tokens, 16384);

    // 2) Client omits maxTokens on another model -> modelParams['*'].max_tokens (8192) wins over 4096
    await drain(anthWithParam.complete({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(anthPayloads.at(-1).max_tokens, 8192);

    // 3) Client provides maxTokens (1024) -> client wins over modelParams.max_tokens (16384) and 4096
    await drain(anthWithParam.complete({ model: 'claude-opus-5-5', maxTokens: 1024, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(anthPayloads.at(-1).max_tokens, 1024);

    // 4) Neither client nor modelParams sets max_tokens -> defaults to 4096
    await drain(anthPlain.complete({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(anthPayloads.at(-1).max_tokens, 4096);

    // OpenAI wire:
    const oaiWithParam = new HttpAdapter('oai', {
      wire: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: false,
      modelParams: {
        'gpt-5': { max_tokens: 8192 },
      },
    });
    const oaiPlain = new HttpAdapter('oai-plain', {
      wire: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: false,
    });

    // 1) Client omits maxTokens -> modelParams['gpt-5'].max_tokens (8192) is sent
    await drain(oaiWithParam.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(oaiPayloads.at(-1).max_tokens, 8192);

    // 2) Client provides maxTokens (512) -> client wins over modelParams['gpt-5'].max_tokens (8192)
    await drain(oaiWithParam.complete({ model: 'gpt-5', maxTokens: 512, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(oaiPayloads.at(-1).max_tokens, 512);

    // 3) Neither client nor modelParams sets max_tokens -> omitted (none)
    await drain(oaiPlain.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal('max_tokens' in oaiPayloads.at(-1), false);
  } finally {
    await new Promise((r) => wireSrv.close(r));
  }
});

/* ---------------- 8. Finding 1: in-memory spend, streaming reader, fail-closed unreadable month */

test('in-memory spend checks do not read disk on the request path, stream lines without readFileSync, and fail closed when a month file is unreadable', async () => {
  const f1Dir = fs.mkdtempSync(path.join(tmpDir, 'f1-'));
  const usageFile = path.join(f1Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T12:00:00.000Z');

  // Seed a month log with 2,000 rows totaling $2.00 ($0.001 each)
  const seedRow = JSON.stringify({
    ts: '2026-10-20T11:00:00.000Z',
    adapter: 'claude-api',
    kind: 'http',
    account: 'acct-main',
    model: 'claude-api/claude-sonnet-5-5',
    status: 'ok',
    ms: 50,
    usage: { input: 100, output: 50 },
    cost: { usd: 0.001, basis: 'metered' },
  });
  fs.writeFileSync(usageFile, Array.from({ length: 2000 }, () => seedRow).join('\n') + '\n', { mode: 0o600 });

  const usage = new UsageLog(usageFile, { now: () => nowMs });
  usage.seedSpend();
  assert.equal(usage.spendFor({ adapter: 'claude-api' }), 2);
  assert.equal(usage.spendFor({ account: 'acct-main' }), 2);

  // After seeding, checkSpendCap reads from memory only — no fs.openSync / fs.readFileSync on the request path
  let openCalls = 0;
  const origOpen = fs.openSync;
  fs.openSync = function (...args) {
    openCalls++;
    return origOpen.apply(this, args);
  };
  try {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      const d = usage.checkSpendCap(
        { 'claude-api': 5, 'account:acct-main': 10 },
        { id: 'claude-api', kind: 'http', account: 'acct-main' },
      );
      assert.equal(d, null);
    }
    const elapsed = performance.now() - t0;
    assert.equal(openCalls, 0, 'checkSpendCap must not open or read files on the request path');
    assert.ok(elapsed < 100, `500 spend cap checks took ${elapsed.toFixed(1)}ms`);
  } finally {
    fs.openSync = origOpen;
  }

  // Recording a new metered row updates the in-memory spend immediately without re-reading the file
  usage.record({
    adapter: 'claude-api',
    kind: 'http',
    account: 'acct-main',
    model: 'claude-api/claude-sonnet-5-5',
    status: 'ok',
    ms: 20,
    cost: { usd: 3.5, basis: 'metered' },
  });
  const exceeded = usage.checkSpendCap(
    { 'claude-api': 5 },
    { id: 'claude-api', kind: 'http', account: 'acct-main' },
  );
  assert.equal(exceeded.target, 'claude-api');
  assert.equal(exceeded.spent, 5.5);

  // Unreadable month file: replace usage.jsonl with a directory so open/read fails with EISDIR.
  // Must fail closed (refuse capped adapters with 429 and retry-after, never $0) and surface on
  // status page, `keysmith doctor`, and `keysmith status`.
  const badDir = fs.mkdtempSync(path.join(tmpDir, 'bad-month-'));
  const badUsageFile = path.join(badDir, 'usage.jsonl');
  fs.mkdirSync(badUsageFile, { mode: 0o700 }); // directory where usage.jsonl should be -> unreadable!

  const logs = [];
  const badCfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    limits: { spend: { 'claude-api': 100 } },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };
  const badUsage = new UsageLog(badUsageFile, { now: () => nowMs });
  const badGw = new Gateway(badCfg, { usage: badUsage, log: (m) => logs.push(m) });
  // Lazy startup: Gateway constructor does not read the file until first use
  assert.equal(logs.length, 0, 'gateway does not parse usage log eagerly at constructor time');

  const badSrv = createServer(badGw, badCfg, { usage: badUsage, log: (m) => logs.push(m), now: () => nowMs });
  await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
  const badBase = `http://127.0.0.1:${badSrv.address().port}`;
  try {
    // Capped adapter refuses (fail-closed) when month log is unreadable, and includes short backoff retry-after
    const res = await fetch(`${badBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 429);
    assert.equal(Number(res.headers.get('retry-after')), 5, '429 unreadable-log refusal sets short backoff retry-after');
    assert.ok(logs.some((m) => m.includes('unreadable') && m.includes(badUsageFile)), 'server log keeps full path');
    assert.ok(badUsage.readErrors().length > 0);
    const errBody = await res.json();
    assert.match(errBody.error.message, /unreadable/);
    assert.ok(!errBody.error.message.includes(badDir), '429 body never exposes absolute directory path');

    // Status page surfaces the unreadable usage log error without absolute path
    const html = await (await fetch(`${badBase}/`, { headers: { authorization: `Bearer ${KEY_ADA}` } })).text();
    assert.match(html, /usage log unreadable/);
    assert.match(html, /unreadable/);
    assert.ok(!html.includes(badDir), 'status page never exposes absolute log path');
  } finally {
    await new Promise((r) => badSrv.close(r));
  }

  // `keysmith status` and `keysmith doctor` also surface the unreadable usage log
  const cfgPath = path.join(badDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(badCfg), { mode: 0o600 });
  const cliEnv = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    KEYSMITH_DATA: badDir,
    KEYSMITH_CONFIG: cfgPath,
  };
  const statusRun = spawnSync(process.execPath, [CLI_PATH, 'status'], { env: cliEnv, encoding: 'utf8' });
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.match(statusRun.stdout, /usage\s*:\s*UNREADABLE/);

  const doctorRun = spawnSync(process.execPath, [CLI_PATH, 'doctor'], { env: cliEnv, encoding: 'utf8' });
  assert.equal(doctorRun.status, 0, doctorRun.stderr);
  assert.match(doctorRun.stdout, /usage log\s+unreadable/);
});

/* ---------------- 9. Finding 2: CLI raw stdout never sets adapter account */

test('CLI adapter account is never read from stdout model output on raw or ndjson parsers', async () => {
  const f2Dir = fs.mkdtempSync(path.join(tmpDir, 'f2-'));
  const rawBin = path.join(f2Dir, 'raw-cli');
  // Stub raw CLI that prints a JSON line with top-level "account" in the model answer
  fs.writeFileSync(
    rawBin,
    `#!/usr/bin/env node\nprocess.stdout.write('{"account":"ACME-4242 jane@x.com","answer":"ok"}\\n');\n`,
    { mode: 0o755 },
  );

  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada' },
        { key: KEY_BOB, label: 'bob', allow: ['raw-agent'] },
      ],
    },
    adapters: {
      'raw-agent': {
        kind: 'cli',
        bin: rawBin,
        args: ['{prompt}'],
        parser: 'raw',
        models: ['m1'],
        timeoutMs: 10_000,
      },
    },
    aliases: {},
  };

  const usage = new UsageLog(path.join(f2Dir, 'usage.jsonl'));
  const gw = new Gateway(cfg, { usage });
  const srv = createServer(gw, cfg, { usage });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'raw-agent/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_BOB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'raw-agent/m1', messages: [{ role: 'user', content: 'hi bob' }] }),
    });
    assert.equal(r2.status, 200);

    const rows = usage.readAll();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].account, null);
    assert.equal(rows[1].account, null);

    const bobUsage = await (
      await fetch(`${base}/v1/keysmith/usage?by=account&tail=10`, {
        headers: { authorization: `Bearer ${KEY_BOB}` },
      })
    ).json();
    assert.ok(!JSON.stringify(bobUsage).includes('ACME-4242'));
    assert.ok(!JSON.stringify(bobUsage).includes('jane@x.com'));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------- 10. Finding 4, 9, 10: scoped /v1/keysmith/routes limits, parseSpendCaps null/false/"", scoped spend visibility */

test('scoped keys see only reachable limits.spend on /v1/keysmith/routes, null/false/"" mean no cap, and scoped spend shows cap state + own spend', async () => {
  // Finding 9: null, false, or "" in limits.spend means no cap
  const caps = parseSpendCaps(
    {
      'claude-api': null,
      'openai-api': false,
      'empty-str': '',
      'active-cap': 25,
      'account:my-acct': '12.5',
    },
    { 'claude-api': {}, 'openai-api': {}, 'active-cap': {} },
  );
  assert.deepEqual(caps, [
    { kind: 'adapter', target: 'active-cap', cap: 25 },
    { kind: 'account', target: 'my-acct', cap: 12.5 },
  ]);

  // Finding 4 & 10: /v1/keysmith/routes filters limits.spend by scope; /v1/keysmith/usage shows
  // adapter cap state (exceeded, remaining, totalSpent) alongside the scoped key's own spend.
  const f4Dir = fs.mkdtempSync(path.join(tmpDir, 'f4-'));
  const usageFile = path.join(f4Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T15:00:00.000Z');
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada' }, // unscoped
        { key: KEY_BOB, label: 'bob', allow: ['claude-api'] }, // scoped to claude-api only
      ],
    },
    limits: {
      streamHoldMs: 1500,
      spend: {
        'claude-api': 0.0082,
        'secret-adapter': 50,
        'account:secret-vault-acct': 100,
        'disabled-cap': null,
      },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5'],
      },
      'secret-adapter': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/openai/v1`,
        apiKey: SECRET_LITERAL_VAL,
        account: 'secret-vault-acct',
        models: ['gpt-5-mini'],
      },
    },
    aliases: {},
  };

  const usage = new UsageLog(usageFile, { now: () => nowMs });
  const gw = new Gateway(cfg, { usage });
  const srv = createServer(gw, cfg, { usage, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const authAda = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const authBob = { authorization: `Bearer ${KEY_BOB}`, 'content-type': 'application/json' };

  try {
    // Finding 4: Bob fetches /v1/keysmith/routes and must NOT see secret-adapter or account:secret-vault-acct
    const routesBob = await (await fetch(`${base}/v1/keysmith/routes`, { headers: authBob })).json();
    assert.deepEqual(routesBob.limits, {
      streamHoldMs: 1500,
      spend: { 'claude-api': 0.0082 },
    });
    assert.ok(!JSON.stringify(routesBob).includes('secret-adapter'));
    assert.ok(!JSON.stringify(routesBob).includes('secret-vault-acct'));

    // Unscoped Ada sees all configured limits
    const routesAda = await (await fetch(`${base}/v1/keysmith/routes`, { headers: authAda })).json();
    assert.equal(routesAda.limits.spend['secret-adapter'], 50);

    // Finding 10: Ada (unscoped) spends $0.0082 on claude-api, reaching the $0.0082 cap.
    const rAda = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'ada spends' }] }),
    });
    assert.equal(rAda.status, 200);

    // Bob (scoped to claude-api) has spent $0 himself, but claude-api is now capped at $0.0082.
    // Bob's /v1/keysmith/usage must report exceeded: true and spent: 0 (his own spend), and NEVER
    // totalSpent or remaining across other keys!
    const bobUsage = await (await fetch(`${base}/v1/keysmith/usage`, { headers: authBob })).json();
    assert.equal(bobUsage.spend.length, 1);
    assert.equal(bobUsage.spend[0].target, 'claude-api');
    assert.equal(bobUsage.spend[0].spent, 0);
    assert.equal(bobUsage.spend[0].cap, 0.0082);
    assert.equal(bobUsage.spend[0].exceeded, true);
    assert.equal(bobUsage.spend[0].totalSpent, undefined);
    assert.equal(bobUsage.spend[0].ownSpent, undefined);
    assert.equal(bobUsage.spend[0].remaining, undefined);

    // And a 429 to scoped Bob says the cap is reached and when it resets, without Ada's total spend:
    const rBobCapped = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authBob,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'bob tries' }] }),
    });
    assert.equal(rBobCapped.status, 429);
    const bobErr = await rBobCapped.json();
    assert.match(bobErr.error.message, /spend cap reached for adapter "claude-api"/);
    assert.match(bobErr.error.message, /resets 2026-11-01T00:00:00Z/);
    assert.doesNotMatch(bobErr.error.message, /spent \$/);

    // And Bob's status page shows "$0.00 / $0.0082", never "(... total)"
    const bobStatusHtml = await (await fetch(`${base}/status`, { headers: authBob })).text();
    assert.doesNotMatch(bobStatusHtml, /total\)/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------- 11. Finding 5 & 6: passthrough cached_tokens and failed CLI tool legs */

test('failed CLI tool leg tokens are subscription (never metered on fallback HTTP leg), and passthrough relay records cache-inclusive input while pricing uncached and cached tokens at their own rates', async () => {
  const f6Dir = fs.mkdtempSync(path.join(tmpDir, 'f6-'));
  const failCliBin = path.join(f6Dir, 'fail-cli');
  // A CLI stub in emulate mode that prints usage (10,000 input, 5,000 output tokens) and then a broken tool call twice so EMULATE fails
  fs.writeFileSync(
    failCliBin,
    `#!/usr/bin/env node
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'event', event: { type: 'text_delta', delta: '<<KEYSMITH_TOOL_CALL>>not valid json<</KEYSMITH_TOOL_CALL>>' } });
line({
  type: 'result',
  sessionId: 's_fail',
  subtype: 'success',
  usage: { inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: 'end_turn',
});
`,
    { mode: 0o755 },
  );

  const usageFile = path.join(f6Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T16:00:00.000Z');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    pricing: {
      'openrouter/gpt-5*': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 },
    },
    limits: {
      spend: {
        // One HTTP response on openrouter/gpt-5-mini costs $0.011:
        // ((2000 - 500 - 250) in * $2 + 1000 out * $8 + 500 cacheRead * $0.5 + 250 cacheWrite * $1) / 1M = $0.011.
        // If the failed CLI leg's 10,000 in + 5,000 out tokens were priced at OpenRouter's rate,
        // they would add $0.0600 and blow past a $0.0200 cap!
        openrouter: 0.011,
      },
    },
    adapters: {
      'bad-cli': {
        kind: 'cli',
        bin: failCliBin,
        args: ['{prompt}'],
        parser: 'cmd-ndjson',
        toolMode: 'emulate',
        cwd: f6Dir,
        models: ['cli-m'],
        timeoutMs: 10_000,
      },
      openrouter: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/openai/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['gpt-5-mini'],
      },
    },
    aliases: {
      combo: ['bad-cli/cli-m', 'openrouter/gpt-5-mini'],
    },
  };

  const usage = new UsageLog(usageFile, { now: () => nowMs, pricing: cfg.pricing });
  const gw = new Gateway(cfg, { usage });
  const srv = createServer(gw, cfg, { usage, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const authAda = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) Request 1 with tools on `combo`: bad-cli fails after spending 10k input + 5k output,
    // falls back to openrouter (passthrough relay).
    // OpenRouter's own usage has prompt_tokens=2000 (including cached_tokens=500, cache_creation_tokens=250) and completion_tokens=1000 ->
    // row usage.input is cache-inclusive 12000 (10000 from failed CLI leg + 2000 from OpenRouter), while metered cost is OpenRouter's own tokens ($0.011).
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({
        model: 'combo',
        messages: [{ role: 'user', content: 'weather?' }],
        tools,
        tool_choice: 'required',
      }),
    });
    await r1.text();
    assert.equal(r1.status, 200);

    const rowsAfter1 = usage.readAll();
    assert.equal(rowsAfter1.length, 1);
    // Total row usage includes both the failed CLI leg (10,000 in, 5,000 out) and OpenRouter's (2,000 in, 1,000 out):
    assert.equal(rowsAfter1[0].usage.input, 12000);
    assert.equal(rowsAfter1[0].usage.cacheRead, 500);
    // But the row's metered cost is ONLY OpenRouter's own tokens ($0.011), never the failed CLI leg's!
    assert.deepEqual(rowsAfter1[0].cost, { usd: 0.011, basis: 'metered' });
    assert.equal(usage.spendFor({ adapter: 'openrouter' }), 0.011);

    // 2) Request 2 with tools on `combo`: bad-cli fails again (20k in, 10k out), and then OpenRouter
    // is at its $0.011 spend cap and refuses with 429.
    // The 429 refusal row carries bad-cli's failedLegs tokens, but its metered cost on OpenRouter must be $0!
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({
        model: 'combo',
        messages: [{ role: 'user', content: 'weather again?' }],
        tools,
        tool_choice: 'required',
      }),
    });
    assert.equal(r2.status, 429);

    const rowsAfter2 = usage.readAll();
    assert.equal(rowsAfter2.length, 2);
    assert.equal(rowsAfter2[1].adapter, 'openrouter');
    assert.deepEqual(rowsAfter2[1].cost, { usd: 0, basis: 'metered' });
    assert.equal(usage.spendFor({ adapter: 'openrouter' }), 0.011);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------- 12. Finding 11, 12, 13, 14, 15: inclusive --until, CSV formula neutralisation & >130k models, max_completion_tokens / max_output_tokens, daily counts in CLI vs HTTP, embeddings face */

test('inclusive --until on -01 dates, CSV formula neutralisation, 135k distinct models without RangeError, max_completion_tokens/max_output_tokens, CLI vs HTTP daily counts, and embeddings face', async () => {
  const miscDir = fs.mkdtempSync(path.join(tmpDir, 'misc-'));
  const usageFile = path.join(miscDir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T18:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  // Finding 11: --until 2026-10-01 is inclusive of the whole UTC day 2026-10-01
  u.record({
    ts: '2026-10-01T15:30:00.000Z',
    model: '=cmd|\'/c calc\'!A0',
    tag: '+SUM(1,2)',
    account: '-acct',
    label: '@admin',
    status: 'ok',
    ms: 10,
  });
  const oct1 = u.query({ by: ['model', 'tag'], since: '2026-10-01', until: '2026-10-01' });
  assert.equal(oct1.totals.requests, 1, '--until 2026-10-01 includes rows throughout 2026-10-01');

  // Finding 12a: CSV formula injection neutralisation (=, +, -, @ prefixed with ')
  const csv = formatUsageCsv(oct1);
  const dataLine = csv.trim().split('\n')[1];
  assert.match(dataLine, /^'=cmd\|'\/c calc'!A0,"'\+SUM\(1,2\)",1,0,/);

  const byAcctLabel = u.query({ by: ['account', 'label'], since: '2026-10-01', until: '2026-10-01' });
  const csv2 = formatUsageCsv(byAcctLabel);
  assert.match(csv2.trim().split('\n')[1], /^'-acct,'@admin,1,0,/);

  // Finding 12b: ~135k distinct model names in formatUsageTable / summarize never throw RangeError
  const manyGroups = Array.from({ length: 135_000 }, (_, i) => ({
    model: `junk-model-${i}`,
    requests: 1,
    failures: 0,
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    meteredUsd: 0,
    listUsd: 0,
    p50Ms: 5,
    p95Ms: 5,
  }));
  const fakeStats = {
    by: ['model'],
    since: null,
    until: null,
    totals: { requests: 135_000, failures: 0, input: 135_000, output: 135_000, cacheRead: 0, cacheWrite: 0, meteredUsd: 0, listUsd: 0, p50Ms: 5, p95Ms: 5 },
    groups: manyGroups,
  };
  const bigTable = formatUsageTable(fakeStats);
  assert.match(bigTable, /requests: 135000/);
  assert.match(bigTable, /\(\d+ more groups omitted\)/);

  // Finding 13, 14, 15: max_completion_tokens on chat, max_output_tokens on responses, embeddings face,
  // and identical daily request/refusal counts between CLI `keysmith usage` and GET /v1/keysmith/usage
  const capturedBodies = [];
  const stubSrv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    capturedBodies.push({ url: req.url, body });
    if (req.url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'emb_req_1' });
      return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: body.model }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => stubSrv.listen(0, '127.0.0.1', r));
  const stubPort = stubSrv.address().port;

  const e2eDir = fs.mkdtempSync(path.join(tmpDir, 'f13-15-'));
  const e2eUsageFile = path.join(e2eDir, 'usage.jsonl');
  const e2eCfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', perDay: 3 },
        { key: KEY_BOB, label: 'bob' },
      ],
    },
    adapters: {
      oai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['gpt-5', 'text-embedding-3-small'],
      },
    },
    aliases: {},
  };
  const e2eUsage = new UsageLog(e2eUsageFile, { pricing: e2eCfg.pricing });
  const e2eGw = new Gateway(e2eCfg, { usage: e2eUsage });
  const e2eSrv = createServer(e2eGw, e2eCfg, { usage: e2eUsage });
  await new Promise((r) => e2eSrv.listen(0, '127.0.0.1', r));
  const e2eBase = `http://127.0.0.1:${e2eSrv.address().port}`;
  const authAda = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const authBob = { authorization: `Bearer ${KEY_BOB}`, 'content-type': 'application/json' };

  try {
    // 1) /v1/chat/completions with max_completion_tokens on OpenAI wire stays max_completion_tokens (never max_tokens)
    const rChat = await fetch(`${e2eBase}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'oai/gpt-5', max_completion_tokens: 333, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(rChat.status, 200);
    assert.equal(capturedBodies.at(-1).body.max_completion_tokens, 333);
    assert.equal(capturedBodies.at(-1).body.max_tokens, undefined);
    assert.equal(capturedBodies.at(-1).body.temperature, undefined);

    // 2) /v1/responses with max_output_tokens on OpenAI wire does NOT translate into max_tokens
    const rResp = await fetch(`${e2eBase}/v1/responses`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'oai/gpt-5', max_output_tokens: 444, input: 'hi' }),
    });
    assert.equal(rResp.status, 200);
    assert.equal(capturedBodies.at(-1).body.max_tokens, undefined);
    assert.equal(capturedBodies.at(-1).body.max_completion_tokens, undefined);

    // 3) /v1/embeddings -> face: "embeddings" in usage.jsonl
    const rEmb = await fetch(`${e2eBase}/v1/embeddings`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'oai/text-embedding-3-small', input: 'embed me' }),
    });
    assert.equal(rEmb.status, 200);

    // Ada is now at 3/3 of her perDay cap. Trigger a refusal (429):
    const rRef1 = await fetch(`${e2eBase}/v1/chat/completions`, {
      method: 'POST',
      headers: authAda,
      body: JSON.stringify({ model: 'oai/gpt-5', messages: [{ role: 'user', content: 'over-1' }] }),
    });
    assert.equal(rRef1.status, 429);

    const rows = e2eUsage.readAll();
    const embRow = rows.find((r) => r.model === 'oai/text-embedding-3-small');
    assert.equal(embRow.face, 'embeddings');
    assert.equal(embRow.upstreamId, 'emb_req_1');

    // Compare GET /v1/keysmith/usage daily summary with `keysmith usage --format json` subprocess
    const httpUsage = await (await fetch(`${e2eBase}/v1/keysmith/usage`, { headers: authBob })).json();
    const cfgPath = path.join(e2eDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(e2eCfg), { mode: 0o600 });
    const cliOut = spawnSync(
      process.execPath,
      [CLI_PATH, 'usage', '--format', 'json'],
      {
        env: {
          ...process.env,
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          KEYSMITH_DATA: e2eDir,
          KEYSMITH_CONFIG: cfgPath,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(cliOut.status, 0, cliOut.stderr);
    const cliUsage = JSON.parse(cliOut.stdout);
    assert.deepEqual(cliUsage.daily, httpUsage.daily);
    assert.equal(cliUsage.daily[0].requests, 3);
    assert.equal(cliUsage.daily[0].refused, 1);
    assert.equal(cliUsage.daily[0].exceeded, true);
  } finally {
    await new Promise((r) => e2eSrv.close(r));
    await new Promise((r) => stubSrv.close(r));
  }
});

/* ---------------- 13. Round 4 findings: wire token fields, transient read recovery, deny-only scope spend, archive ranges, day aggregates, 50 refusals, top groups by spend, and passthrough usage */

test('Round 4 New 1: OpenAI wire keeps max_completion_tokens and max_tokens under their own names and sends temperature only when given; Anthropic wire resolves max_tokens from any client field, modelParams, or 4096', async () => {
  const upstreamCalls = [];
  const srvStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    upstreamCalls.push({ url: req.url, body });
    // Simulate OpenAI reasoning model (o3 / gpt-5) rejecting max_tokens or temperature !== 1
    if (req.url.endsWith('/chat/completions') && (body.model === 'o3' || body.model === 'gpt-5')) {
      if (body.max_tokens !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead.' } }));
      }
      if (body.temperature !== undefined && body.temperature !== 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Unsupported value: temperature is not supported with this model.' } }));
      }
    }
    if (req.url.endsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`);
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => srvStub.listen(0, '127.0.0.1', r));
  const port = srvStub.address().port;

  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new1-'));
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      openai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['o3', 'gpt-5', 'gpt-4o'],
      },
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5', 'claude-param'],
        modelParams: {
          'claude-param': { max_tokens: 8192 },
        },
      },
    },
    aliases: {},
  };
  const usage = new UsageLog(path.join(r4Dir, 'usage.jsonl'));
  const gw = new Gateway(cfg, { usage });
  const srv = createServer(gw, cfg, { usage });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };

  try {
    // OpenAI wire with max_completion_tokens on o3 -> sends max_completion_tokens: 2000, no max_tokens, no temperature
    const rO3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openai/o3', max_completion_tokens: 2000, messages: [{ role: 'user', content: 'reason' }] }),
    });
    assert.equal(rO3.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_completion_tokens, 2000);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, undefined);
    assert.equal(upstreamCalls.at(-1).body.temperature, undefined);

    // OpenAI wire with max_tokens and temperature on gpt-4o -> sends max_tokens: 500 and temperature: 0.2
    const r4o = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openai/gpt-4o', max_tokens: 500, temperature: 0.2, messages: [{ role: 'user', content: 'chat' }] }),
    });
    assert.equal(r4o.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, 500);
    assert.equal(upstreamCalls.at(-1).body.max_completion_tokens, undefined);
    assert.equal(upstreamCalls.at(-1).body.temperature, 0.2);

    // Anthropic wire via /v1/chat/completions with max_completion_tokens -> max_tokens: 1234
    const rAnthChat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', max_completion_tokens: 1234, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(rAnthChat.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, 1234);

    // Anthropic wire via /v1/responses with max_output_tokens -> max_tokens: 2345
    const rAnthResp = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', max_output_tokens: 2345, input: 'hi' }),
    });
    assert.equal(rAnthResp.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, 2345);

    // Anthropic wire with no client token limit -> uses modelParams (8192), else 4096
    const rAnthParam = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-param', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(rAnthParam.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, 8192);

    const rAnthDefault = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(rAnthDefault.status, 200);
    assert.equal(upstreamCalls.at(-1).body.max_tokens, 4096);
  } finally {
    await new Promise((r) => srv.close(r));
    await new Promise((r) => srvStub.close(r));
  }
});

test('Round 4 New 2 & New 8: stats-path read errors never poison spend state, failed spend builds retry after short backoff, and public errors never leak absolute paths or usernames', async () => {
  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new2-'));
  const usageFile = path.join(r4Dir, 'usage.jsonl');
  let clockMs = Date.parse('2026-10-20T12:00:00.000Z');
  const serverLogs = [];
  const usage = new UsageLog(usageFile, { now: () => clockMs, log: (m) => serverLogs.push(m) });

  // 1) Seed valid spend state first
  usage.record({
    ts: '2026-10-20T12:00:00.000Z',
    adapter: 'claude-api',
    kind: 'http',
    model: 'claude-api/claude-sonnet-5-5',
    status: 'ok',
    ms: 10,
    cost: { usd: 1.0, basis: 'metered' },
  });
  assert.equal(usage.checkSpendCap({ 'claude-api': 10 }, { id: 'claude-api', kind: 'http' }), null);

  // Simulate a transient stats-path read error on an archive file (e.g. usage.jsonl.2026-09 is a directory)
  const badArchive = `${usageFile}.2026-09`;
  fs.mkdirSync(badArchive, { mode: 0o700 });
  usage.query({ by: ['model'], since: '2026-09-01', until: '2026-10-31' });
  usage.tail(10);
  usage.readAll();
  // Stats-path read errors must NEVER enter _spendState.readError!
  assert.equal(usage.checkSpendCap({ 'claude-api': 10 }, { id: 'claude-api', kind: 'http' }), null);
  fs.rmdirSync(badArchive);

  // 2) Now test a spend-cap build failure on startup and automatic recovery after short backoff (5s)
  const retryDir = fs.mkdtempSync(path.join(tmpDir, 'r4-retry-'));
  const retryFile = path.join(retryDir, 'usage.jsonl');
  fs.mkdirSync(retryFile, { mode: 0o700 }); // unreadable directory at start
  const retryLogs = [];
  const retryUsage = new UsageLog(retryFile, { now: () => clockMs, log: (m) => retryLogs.push(m) });

  // First check fails closed with short retryAfter (5s) and path-free error message
  const c1 = retryUsage.checkSpendCap({ 'claude-api': 10 }, { id: 'claude-api', kind: 'http' });
  assert.ok(c1?.error);
  assert.equal(c1.retryAfter, 5);
  assert.ok(!c1.error.includes(retryDir), 'error text must not contain directory path');
  const username = os.userInfo().username;
  if (username) assert.ok(!c1.error.includes(username), 'error text must not contain OS username');
  assert.ok(retryLogs.some((l) => l.includes(retryFile)), 'server log keeps full path');

  // Fix the file on disk (replace directory with valid JSONL file)
  fs.rmdirSync(retryFile);
  fs.writeFileSync(
    retryFile,
    JSON.stringify({
      ts: '2026-10-20T12:00:00.000Z',
      adapter: 'claude-api',
      kind: 'http',
      model: 'claude-api/claude-sonnet-5-5',
      status: 'ok',
      cost: { usd: 2.5, basis: 'metered' },
    }) + '\n',
    { mode: 0o600 },
  );

  // Before backoff expires (clock + 1s), still returns cached error state without hitting disk
  clockMs += 1_000;
  assert.ok(retryUsage.checkSpendCap({ 'claude-api': 10 }, { id: 'claude-api', kind: 'http' })?.error);

  // After 5s backoff expires, _ensureSpendMonth retries the build, succeeds, and clears the error!
  clockMs += 5_000;
  assert.equal(retryUsage.checkSpendCap({ 'claude-api': 10 }, { id: 'claude-api', kind: 'http' }), null);
  assert.equal(retryUsage.spendFor({ adapter: 'claude-api' }), 2.5);
  assert.deepEqual(retryUsage.readErrors(), []);
});

test('Round 4 New 3 & New 7: deny-only and allow scopes with nested and flat spend keys never leak unreachable adapters, accounts, or totals', async () => {
  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new3-'));
  const usageFile = path.join(r4Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T15:00:00.000Z');
  const KEY_DENY = mint();
  const KEY_ALLOW = mint();

  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada' }, // unscoped
        { key: KEY_DENY, label: 'deny-claude', deny: ['claude-api'] }, // deny-only scope
        { key: KEY_ALLOW, label: 'allow-oai', allow: ['oai'] }, // allow-only scope
      ],
    },
    limits: {
      spend: {
        adapters: {
          'claude-api': 25,
          oai: 15,
        },
        accounts: {
          ANTHROPIC_PROD_KEY: 50,
          OPENAI_PROD_KEY: 30,
        },
        'adapter:claude-api': 25,
        'account:ANTHROPIC_PROD_KEY': 50,
        ANTHROPIC_PROD_KEY: 50,
        OPENAI_PROD_KEY: 30,
      },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: '{env:ANTHROPIC_PROD_KEY}',
        _apiKey: SECRET_LITERAL_VAL,
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
      oai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/openai/v1`,
        apiKey: '{env:OPENAI_PROD_KEY}',
        _apiKey: SECRET_LITERAL_VAL,
        _apiKeyResolved: true,
        models: ['gpt-5-mini'],
      },
    },
    aliases: {},
  };

  const usage = new UsageLog(usageFile, { now: () => nowMs });
  const gw = new Gateway(cfg, { usage });
  const srv = createServer(gw, cfg, { usage, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    for (const token of [KEY_DENY, KEY_ALLOW]) {
      const headers = { authorization: `Bearer ${token}` };
      const routes = await (await fetch(`${base}/v1/keysmith/routes`, { headers })).json();
      const routesStr = JSON.stringify(routes.limits.spend);
      assert.ok(!routesStr.includes('claude-api'), `routes for ${token} must not contain claude-api`);
      assert.ok(!routesStr.includes('ANTHROPIC_PROD_KEY'), `routes for ${token} must not contain ANTHROPIC_PROD_KEY`);
      assert.deepEqual(routes.limits.spend, {
        adapters: { oai: 15 },
        accounts: { OPENAI_PROD_KEY: 30 },
        OPENAI_PROD_KEY: 30,
      });

      const u = await (await fetch(`${base}/v1/keysmith/usage`, { headers })).json();
      const uStr = JSON.stringify(u.spend);
      assert.ok(!uStr.includes('claude-api'));
      assert.ok(!uStr.includes('ANTHROPIC_PROD_KEY'));
      for (const s of u.spend) {
        assert.equal(s.totalSpent, undefined);
        assert.equal(s.remaining, undefined);
      }
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Round 4 New 4: _candidateFiles and rowsSince choose archive files by their first and last row timestamps, not their filename suffix', () => {
  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new4-'));
  const usageFile = path.join(r4Dir, 'usage.jsonl');
  let clockMs = Date.parse('2026-07-15T10:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => clockMs });

  // Simulate an existing pre-upgrade single usage.jsonl that accumulated July, August, and September rows
  const legacyRows = [
    { ts: '2026-07-10T12:00:00.000Z', model: 'claude-api/claude-sonnet-5-5', adapter: 'claude-api', kind: 'http', status: 'ok', ms: 100, usage: { input: 100, output: 50 }, cost: { usd: 0.0007, basis: 'metered' } },
    { ts: '2026-08-15T12:00:00.000Z', model: 'claude-api/claude-sonnet-5-5', adapter: 'claude-api', kind: 'http', status: 'ok', ms: 120, usage: { input: 200, output: 100 }, cost: { usd: 0.0014, basis: 'metered' } },
    { ts: '2026-09-20T12:00:00.000Z', model: 'claude-api/claude-sonnet-5-5', adapter: 'claude-api', kind: 'http', status: 'ok', ms: 140, usage: { input: 300, output: 150 }, cost: { usd: 0.0021, basis: 'metered' } },
  ];
  fs.writeFileSync(usageFile, legacyRows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });

  // Now upgrade happens in October 2026: first October write rolls usage.jsonl -> usage.jsonl.2026-09
  clockMs = Date.parse('2026-10-02T09:00:00.000Z');
  u.record({ model: 'claude-api/claude-sonnet-5-5', adapter: 'claude-api', kind: 'http', status: 'ok', ms: 90, usage: { input: 50, output: 25 } });
  assert.ok(fs.existsSync(`${usageFile}.2026-09`));

  // Querying July 2026 (--since 2026-07-01 --until 2026-07-31) on a fresh UsageLog instance must find the July row inside usage.jsonl.2026-09!
  const reader = new UsageLog(usageFile, { now: () => clockMs });
  const july = reader.query({ by: ['model'], since: '2026-07-01', until: '2026-07-31' });
  assert.equal(july.totals.requests, 1);
  assert.equal(july.totals.input, 100);
  assert.equal(july.totals.output, 50);

  const aug = reader.query({ by: ['model'], since: '2026-08-01', until: '2026-08-31' });
  assert.equal(aug.totals.requests, 1);
  assert.equal(aug.totals.input, 200);
});

test('Round 4 New 5 & New 11: /v1/keysmith/usage and /status answer from in-memory per-day aggregates with whole-day rounding without re-reading log files', async () => {
  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new5-'));
  const usageFile = path.join(r4Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-20T15:30:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  u.record({ ts: '2026-10-14T08:00:00.000Z', key: `fp:${fingerprint(KEY_ADA)}`, label: 'ada', adapter: 'oai', model: 'oai/gpt-5', account: 'acct1', tag: 't1', client: 'c1', status: 'ok', ms: 50, usage: { input: 10, output: 5 } });
  u.record({ ts: '2026-10-20T10:00:00.000Z', key: `fp:${fingerprint(KEY_ADA)}`, label: 'ada', adapter: 'oai', model: 'oai/gpt-5', account: 'acct1', tag: 't1', client: 'c1', status: 'ok', ms: 70, usage: { input: 20, output: 10 } });

  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {},
    aliases: {},
  };
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}` };

  try {
    // First call lazily builds _dayAggregates
    const r1 = await (await fetch(`${base}/v1/keysmith/usage?by=adapter,model&since=7d`, { headers })).json();
    assert.equal(r1.roundedToWholeDays, true);
    assert.equal(r1.since, '2026-10-13T00:00:00.000Z');
    assert.equal(r1.totals.requests, 2);

    // Count fs.openSync calls on usageFile during varied relative/absolute queries on /v1/keysmith/usage
    let openCount = 0;
    const origOpenSync = fs.openSync;
    fs.openSync = function (p, ...rest) {
      if (String(p).startsWith(usageFile)) openCount++;
      return origOpenSync.call(this, p, ...rest);
    };
    try {
      const r2 = await (await fetch(`${base}/v1/keysmith/usage?by=key,tag&since=7.001d`, { headers })).json();
      const r3 = await (await fetch(`${base}/v1/keysmith/usage?by=account,client&since=2026-10-14T11:22:33Z&until=2026-10-20T01:02:03Z`, { headers })).json();
      assert.equal(r2.roundedToWholeDays, true);
      assert.equal(r3.roundedToWholeDays, true);
      assert.equal(r3.since, '2026-10-14T00:00:00.000Z');
      assert.equal(r3.until, '2026-10-20T23:59:59.999Z');
      assert.equal(r3.totals.requests, 2);
      assert.equal(openCount, 0, 'varied /v1/keysmith/usage queries read from in-memory day aggregates with 0 file opens');
    } finally {
      fs.openSync = origOpenSync;
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Round 4 New 6 & New 10: 50 daily-cap refusals match across /status, /v1/keysmith/usage, and CLI; top groups keep highest spend/requests over 5,000 junk models', async () => {
  // 1) New 10: 5,050 junk 404 models first, then a real model with $5,000 spend and 100 requests
  const r10Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new10-'));
  const r10File = path.join(r10Dir, 'usage.jsonl');
  const lines = [];
  for (let i = 0; i < 5050; i++) {
    lines.push(JSON.stringify({
      ts: '2026-10-20T10:00:00.000Z',
      model: `junk/model-${i}`,
      adapter: 'junk',
      kind: 'http',
      status: 'error',
      ms: 5,
      cost: { usd: 0, basis: 'unpriced' },
    }));
  }
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      ts: '2026-10-20T11:00:00.000Z',
      model: 'claude-api/claude-opus-5-5',
      adapter: 'claude-api',
      kind: 'http',
      status: 'ok',
      ms: 100,
      usage: { input: 1000, output: 500 },
      cost: { usd: 50, basis: 'metered' },
    }));
  }
  fs.writeFileSync(r10File, lines.join('\n') + '\n', { mode: 0o600 });

  const u10 = new UsageLog(r10File, { now: () => Date.parse('2026-10-20T12:00:00.000Z') });
  const qFull = u10.query({ by: ['model'] });
  assert.equal(qFull.groups[0].model, 'claude-api/claude-opus-5-5', 'top model by spend/requests is kept, not folded into (other)');
  assert.equal(qFull.groups[0].meteredUsd, 5000);
  assert.equal(qFull.groups[0].requests, 100);
  assert.ok(qFull.groups.some((g) => g.model === '(other)'), 'excess low-spend junk models are folded into (other)');

  const qDays = u10.query({ by: ['model'], fromDays: true });
  assert.equal(qDays.groups[0].model, 'claude-api/claude-opus-5-5', 'in-memory day aggregates also keep top model by spend/requests');
  assert.equal(qDays.groups[0].meteredUsd, 5000);

  // 2) New 6: 50 refusals (and a non-JSON body request that leaves no JSONL row) show identical counts everywhere
  const r6Dir = fs.mkdtempSync(path.join(tmpDir, 'r4-new6-'));
  const r6File = path.join(r6Dir, 'usage.jsonl');
  const r6Cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', perDay: 1 },
        { key: KEY_BOB, label: 'bob' },
      ],
    },
    adapters: {},
    aliases: {},
  };
  const r6Usage = new UsageLog(r6File);
  const r6Gw = new Gateway(r6Cfg, { usage: r6Usage });
  const r6Srv = createServer(r6Gw, r6Cfg, { usage: r6Usage });
  await new Promise((r) => r6Srv.listen(0, '127.0.0.1', r));
  const r6Base = `http://127.0.0.1:${r6Srv.address().port}`;

  try {
    // 1st request admitted (invalid JSON -> 400 before any usage row is written, still counts as 1 request)
    const rAdmitted = await fetch(`${r6Base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
      body: '{not-valid-json',
    });
    assert.equal(rAdmitted.status, 400);

    // 50 requests refused over the perDay=1 cap (only the 1st writes a "limited" row to usage.jsonl)
    for (let i = 0; i < 50; i++) {
      const rRef = await fetch(`${r6Base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x/y', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(rRef.status, 429);
    }

    // Only 1 row was written to usage.jsonl, yet /status, /v1/keysmith/usage, and `keysmith usage` CLI all report requests: 1, refused: 50!
    assert.equal(r6Usage.readAll().length, 1);

    const statusHtml = await (await fetch(`${r6Base}/status`, { headers: { authorization: `Bearer ${KEY_ADA}` } })).text();
    assert.match(statusHtml, /1 of 1<\/b> requests, 50 refused over the cap/);

    const apiUsage = await (await fetch(`${r6Base}/v1/keysmith/usage`, { headers: { authorization: `Bearer ${KEY_BOB}` } })).json();
    assert.equal(apiUsage.daily[0].requests, 1);
    assert.equal(apiUsage.daily[0].refused, 50);

    const cfgPath = path.join(r6Dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(r6Cfg), { mode: 0o600 });
    const cliOut = spawnSync(
      process.execPath,
      [CLI_PATH, 'usage', '--format', 'json'],
      {
        env: {
          ...process.env,
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          KEYSMITH_DATA: r6Dir,
          KEYSMITH_CONFIG: cfgPath,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(cliOut.status, 0, cliOut.stderr);
    const cliUsage = JSON.parse(cliOut.stdout);
    assert.equal(cliUsage.daily[0].requests, 1);
    assert.equal(cliUsage.daily[0].refused, 50);
  } finally {
    await new Promise((r) => r6Srv.close(r));
  }
});

test('Round 4 & 6 (3b) Passthrough usage: non-streamed and streamed tool passthrough on claude-api-oai extracts usage, withholds unrequested usage chunk, and shares one keychain service account spend cap with claude-api', async () => {
  const upstreamReqs = [];
  const ptStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    upstreamReqs.push({ url: req.url, body });

    if (req.url.endsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_anth_1' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 1 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anth' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } })}\n\n`);
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }

    // OpenAI-compatible endpoint (like https://api.anthropic.com/v1 for claude-api-oai)
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_oai_nonstream' });
      return res.end(JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_oai_stream' });
    // First chunk has empty usage: {} like Anthropic's OpenAI-compatible endpoint
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_s1',
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    })}\n\n`);
    if (body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_s1',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => ptStub.listen(0, '127.0.0.1', r));
  const ptPort = ptStub.address().port;

  const ptDir = fs.mkdtempSync(path.join(tmpDir, 'r4-pt-'));
  const ptUsageFile = path.join(ptDir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T10:00:00.000Z');
  // Both claude-api and claude-api-oai share the `ks-shared-cred` keychain reference:
  // Each request (1000 input * $2/1M + 500 output * $10/1M) = $0.002 + $0.005 = $0.0070.
  // Cap `ks-shared-cred` at $0.0210 (exactly 3 requests across both adapters).
  const ptCfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    limits: {
      spend: {
        'ks-shared-cred': 0.021,
      },
    },
    adapters: {
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${ptPort}/v1`,
        apiKey: '{exec:security find-generic-password -s ks-shared-cred -w}',
        _apiKey: SECRET_EXEC_VAL,
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
      'claude-api-oai': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${ptPort}/v1`,
        apiKey: '{exec:security find-generic-password -s ks-shared-cred -w}',
        _apiKey: SECRET_EXEC_VAL,
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };

  const ptUsage = new UsageLog(ptUsageFile, { now: () => nowMs });
  const ptGw = new Gateway(ptCfg, { usage: ptUsage });
  const ptSrv = createServer(ptGw, ptCfg, { usage: ptUsage, now: () => nowMs });
  await new Promise((r) => ptSrv.listen(0, '127.0.0.1', r));
  const ptBase = `http://127.0.0.1:${ptSrv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) Non-streamed passthrough tool call on claude-api-oai ($0.0070 on account `ks-shared-cred`)
    const r1 = await fetch(`${ptBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api-oai/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'q1' }], tools }),
    });
    assert.equal(r1.status, 200);
    await r1.json();

    // 2) Streamed passthrough tool call on claude-api-oai WITHOUT stream_options.include_usage ($0.0070 on `ks-shared-cred`)
    // Gateway must inject stream_options.include_usage upstream, withhold the extra usage-only chunk from the client, and price the row!
    const r2 = await fetch(`${ptBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api-oai/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'q2' }], tools }),
    });
    assert.equal(r2.status, 200);
    const r2Sse = await r2.text();
    assert.equal(upstreamReqs.at(-1).body.stream_options?.include_usage, true, 'gateway injected include_usage upstream');
    assert.ok(!r2Sse.includes('"completion_tokens":500'), 'extra usage-only chunk was withheld from client that did not ask for include_usage');

    // 3) Plain call on claude-api ($0.0070 on `ks-shared-cred`, bringing shared `ks-shared-cred` account spend to $0.0210 == cap)
    const r3 = await fetch(`${ptBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'q3' }] }),
    });
    assert.equal(r3.status, 200);
    await r3.json();

    const rows = ptUsage.readAll();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.account, 'ks-shared-cred');
      assert.deepEqual(row.usage, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
      assert.deepEqual(row.cost, { usd: 0.007, basis: 'metered' });
    }
    assert.equal(ptUsage.spendFor({ account: 'ks-shared-cred' }), 0.021);

    // 4) Next request on either claude-api-oai or claude-api is refused with 429 because shared `ks-shared-cred` account cap is reached!
    const r4 = await fetch(`${ptBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api-oai/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'q4' }], tools }),
    });
    assert.equal(r4.status, 429);
    const err4 = await r4.json();
    assert.match(err4.error.message, /account "ks-shared-cred"/);

    const r5 = await fetch(`${ptBase}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'q5' }] }),
    });
    assert.equal(r5.status, 429);
    await r5.json();
  } finally {
    ptSrv.closeAllConnections?.();
    ptStub.closeAllConnections?.();
    await new Promise((r) => ptSrv.close(r));
    await new Promise((r) => ptStub.close(r));
  }
});

test('Round 5 New 1: /v1/embeddings records usage, prices input tokens, and enforces limits.spend', async () => {
  const embStub = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_emb_1' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
    }));
  });
  await new Promise((r) => embStub.listen(0, '127.0.0.1', r));
  const embPort = embStub.address().port;

  const r1Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new1-'));
  const usageFile = path.join(r1Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T12:00:00.000Z');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    pricing: { 'openai/text-embedding-3-large': { input: 0.13 } },
    limits: { spend: { openai: 0.2 } },
    adapters: {
      openai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${embPort}/v1`,
        apiKey: 'sk-test-emb',
        _apiKey: 'sk-test-emb',
        _apiKeyResolved: true,
        models: ['text-embedding-3-large'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile, { now: () => nowMs, pricing: cfg.pricing });
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };

  try {
    // 1st call: 1M tokens -> $0.13 (under $0.20 cap)
    const c1 = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openai/text-embedding-3-large', input: 'hello' }),
    });
    assert.equal(c1.status, 200);
    // 2nd call: 1M tokens -> $0.13 + $0.13 = $0.26 (now past $0.20 cap)
    const c2 = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openai/text-embedding-3-large', input: 'world' }),
    });
    assert.equal(c2.status, 200);
    // 3rd call: refused with 429 because spend ($0.26) >= cap ($0.20)
    const c3 = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'openai/text-embedding-3-large', input: 'again' }),
    });
    assert.equal(c3.status, 429);
    const err3 = await c3.json();
    assert.match(err3.error.message, /spend cap reached/i);

    const rows = u.readAll();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].usage, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(rows[0].cost, { usd: 0.13, basis: 'metered' });
    assert.equal(u.spendFor({ adapter: 'openai' }), 0.26);
    assert.equal(rows[2].status, 'error');
    assert.match(rows[2].error, /spend cap reached/i);
  } finally {
    await new Promise((r) => srv.close(r));
    await new Promise((r) => embStub.close(r));
  }
});

test('Round 5 New 2: client receives upstream prompt_tokens (including cached_tokens) on /v1/chat/completions, /v1/responses, and /v1/messages, and audit log keeps cache-inclusive input with cacheRead beside it', async () => {
  const cacheStub = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_cache_1' });
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'cached answer' }, finish_reason: 'stop' }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_c1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: 10000,
        completion_tokens: 100,
        total_tokens: 10100,
        prompt_tokens_details: { cached_tokens: 8000 },
      },
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => cacheStub.listen(0, '127.0.0.1', r));
  const cachePort = cacheStub.address().port;

  const r2Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new2-'));
  const usageFile = path.join(r2Dir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      oai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${cachePort}/v1`,
        apiKey: 'sk-test-cache',
        _apiKey: 'sk-test-cache',
        _apiKeyResolved: true,
        models: ['gpt-5-mini'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };

  try {
    // 1) Non-streamed /v1/chat/completions
    const chatRes = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.deepEqual(chatRes.usage, {
      prompt_tokens: 10000,
      completion_tokens: 100,
      total_tokens: 10100,
      prompt_tokens_details: { cached_tokens: 8000 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });

    // 1b) Streamed /v1/chat/completions with include_usage
    const chatStreamText = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
    })).text();
    assert.match(chatStreamText, /"prompt_tokens":10000,"completion_tokens":100,"total_tokens":10100/);

    // 2) Non-streamed /v1/responses
    const respRes = await (await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', stream: false, input: 'hi' }),
    })).json();
    assert.deepEqual(respRes.usage, {
      input_tokens: 10000,
      input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 0 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 10100,
    });

    // 3) Streamed /v1/responses
    const respStreamText = await (await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', stream: true, input: 'hi' }),
    })).text();
    assert.match(respStreamText, /"usage":\{"input_tokens":10000,"input_tokens_details":\{"cached_tokens":8000,"cache_write_tokens":0\},"output_tokens":100/);

    // 4) Non-streamed & streamed /v1/messages (Round 6 2a: client receives provider's 10000, not 2000)
    const msgRes = await (await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.deepEqual(msgRes.usage, {
      input_tokens: 10000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      output_tokens: 100,
    });

    const msgStreamText = await (await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/gpt-5-mini', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })).text();
    assert.match(msgStreamText, /"input_tokens":10000,"cache_creation_input_tokens":0,"cache_read_input_tokens":8000/);

    // Audit rows also record input=10000 (cache included, 3b7e612), with cacheRead=8000 beside it
    const rows = u.readAll();
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.deepEqual(row.usage, { input: 10000, output: 100, cacheRead: 8000, cacheWrite: 0 });
    }
  } finally {
    await new Promise((r) => srv.close(r));
    await new Promise((r) => cacheStub.close(r));
  }
});

test('Round 5 New 3: bounded latency histogram reports proportional p50/p95 across merged cells and large streams on endpoint, status page, and CLI', () => {
  // Case A: key A sends 10,000 requests at 1,000 ms and key B sends 10 at 30,000 ms to one model
  const dirA = fs.mkdtempSync(path.join(tmpDir, 'r5-new3a-'));
  const fileA = path.join(dirA, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T12:00:00.000Z');
  const uA = new UsageLog(fileA, { now: () => nowMs });
  const linesA = [];
  for (let i = 0; i < 10000; i++) {
    linesA.push(JSON.stringify({
      ts: '2026-10-21T10:00:00.000Z',
      key: 'fp:aaaaaaaa',
      label: 'keyA',
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 1000,
    }));
  }
  for (let i = 0; i < 10; i++) {
    linesA.push(JSON.stringify({
      ts: '2026-10-21T10:05:00.000Z',
      key: 'fp:bbbbbbbb',
      label: 'keyB',
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 30000,
    }));
  }
  fs.writeFileSync(fileA, linesA.join('\n') + '\n', { mode: 0o600 });

  const endpointModel = uA.query({ by: ['model'], fromDays: true });
  assert.equal(endpointModel.groups.length, 1);
  assert.equal(endpointModel.groups[0].p50Ms, 1000);
  assert.equal(endpointModel.groups[0].p95Ms, 1000);
  assert.equal(endpointModel.totals.p95Ms, 1000);

  const summaryA = uA.summarize();
  assert.equal(summaryA.models[0].p50Ms, 1000);
  assert.equal(summaryA.models[0].p95Ms, 1000);

  // Case B: 98,000 rows at 1,000 ms then 2,000 at 100 ms -> CLI (fromDays: false) reports p50/p95 = 1000/1000
  const dirB = fs.mkdtempSync(path.join(tmpDir, 'r5-new3b-'));
  const fileB = path.join(dirB, 'usage.jsonl');
  const fdB = fs.openSync(fileB, 'w', 0o600);
  const row1000 = JSON.stringify({ ts: '2026-10-21T10:00:00.000Z', adapter: 'oai', model: 'oai/gpt-5-mini', status: 'ok', ms: 1000 }) + '\n';
  const row100 = JSON.stringify({ ts: '2026-10-21T10:00:00.000Z', adapter: 'oai', model: 'oai/gpt-5-mini', status: 'ok', ms: 100 }) + '\n';
  const chunk1000 = row1000.repeat(1000);
  for (let i = 0; i < 98; i++) fs.writeSync(fdB, chunk1000);
  const chunk100 = row100.repeat(1000);
  for (let i = 0; i < 2; i++) fs.writeSync(fdB, chunk100);
  fs.closeSync(fdB);

  const uB = new UsageLog(fileB, { now: () => nowMs });
  const cliStats = uB.query({ by: ['model'] });
  assert.equal(cliStats.totals.requests, 100000);
  assert.equal(cliStats.totals.p50Ms, 1000);
  assert.equal(cliStats.totals.p95Ms, 1000);
  assert.equal(cliStats.groups[0].p50Ms, 1000);
  assert.equal(cliStats.groups[0].p95Ms, 1000);
});

test('Round 5 New 4: ?tail answers from the 2,000-row in-memory ring with 0 file opens after warm, rejects tail > 2000 with 400, and meters /v1/keysmith/usage against perDay', async () => {
  const r4Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new4-'));
  const usageFile = path.join(r4Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T12:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  // Write 2,500 rows for bob and 3 for ada
  const lines = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({
      ts: '2026-10-21T10:00:00.000Z',
      key: `fp:${fingerprint(KEY_BOB)}`,
      label: 'bob',
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 20,
    }));
  }
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify({
      ts: '2026-10-21T11:00:00.000Z',
      key: `fp:${fingerprint(KEY_ADA)}`,
      label: 'ada',
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 30,
    }));
  }
  fs.writeFileSync(usageFile, lines.join('\n') + '\n', { mode: 0o600 });

  const KEY_SCOPED_CAP = 'sk-ks-scoped-cap-key-0000000000000000';
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', allow: ['oai/*'] },
        { key: KEY_BOB, label: 'bob' },
        { key: KEY_SCOPED_CAP, label: 'capped', allow: ['oai/*'], perDay: 2 },
      ],
    },
    adapters: { oai: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9', models: ['gpt-5-mini'] } },
    aliases: {},
  };
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const adaHeaders = { authorization: `Bearer ${KEY_ADA}` };

  try {
    // Warm the ring and day aggregates on first call
    const first = await (await fetch(`${base}/v1/keysmith/usage?tail=50`, { headers: adaHeaders })).json();
    assert.equal(first.entries.length, 3);

    // Subsequent ?tail=50 calls must not open usage.jsonl at all
    let openCount = 0;
    const origOpenSync = fs.openSync;
    fs.openSync = function (p, ...rest) {
      if (String(p) === usageFile || String(p).startsWith(`${usageFile}.20`)) openCount++;
      return origOpenSync.call(this, p, ...rest);
    };
    try {
      const t0 = performance.now();
      const second = await (await fetch(`${base}/v1/keysmith/usage?tail=50`, { headers: adaHeaders })).json();
      const elapsed = performance.now() - t0;
      assert.equal(second.entries.length, 3);
      assert.equal(openCount, 0, '?tail=50 served from in-memory ring with 0 log file opens');
      assert.ok(elapsed < 100, `?tail=50 took ${elapsed.toFixed(1)}ms`);
    } finally {
      fs.openSync = origOpenSync;
    }

    // tail above 2000 is refused with 400 naming the bound
    const over = await fetch(`${base}/v1/keysmith/usage?tail=2001`, { headers: adaHeaders });
    assert.equal(over.status, 400);
    const overBody = await over.json();
    assert.match(overBody.error.message, /2000/);

    // /v1/keysmith/usage counts against perDay
    const capHeaders = { authorization: `Bearer ${KEY_SCOPED_CAP}` };
    assert.equal((await fetch(`${base}/v1/keysmith/usage?tail=10`, { headers: capHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v1/keysmith/usage?tail=10`, { headers: capHeaders })).status, 200);
    const thirdCap = await fetch(`${base}/v1/keysmith/usage?tail=10`, { headers: capHeaders });
    assert.equal(thirdCap.status, 429);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Round 5 New 5: hour cells make 24h status figures and ?hours<=48 exact to the UTC hour, while ?hours>48 uses whole UTC days', async () => {
  const r5Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new5-'));
  const usageFile = path.join(r5Dir, 'usage.jsonl');
  // 20:00 UTC on 2026-10-21
  const nowMs = Date.parse('2026-10-21T20:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  // 40 rows 43.5 hours old (2026-10-20T00:30:00.000Z, still on yesterday's UTC date!)
  for (let i = 0; i < 40; i++) {
    u.record({
      ts: '2026-10-20T00:30:00.000Z',
      key: `fp:${fingerprint(KEY_ADA)}`,
      label: 'ada',
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 100,
    });
  }
  // 1 row 1 hour old (2026-10-21T19:00:00.000Z)
  u.record({
    ts: '2026-10-21T19:00:00.000Z',
    key: `fp:${fingerprint(KEY_ADA)}`,
    label: 'ada',
    adapter: 'oai',
    model: 'oai/gpt-5-mini',
    status: 'ok',
    ms: 100,
  });

  // Reset in-memory caches to verify rebuild from disk also populates hour cells
  u._dayAggregates = null;
  u._hourAggregates = null;

  const summary = u.summarize();
  assert.equal(summary.requests, 1, 'status 24h requests counts only the last 24 UTC hours, not 43.5h-old rows');
  assert.equal(summary.granularity, 'hour');

  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {},
    aliases: {},
  };
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u, now: () => nowMs });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}` };

  try {
    const h24 = await (await fetch(`${base}/v1/keysmith/usage?hours=24`, { headers })).json();
    assert.equal(h24.totals.requests, 1);
    assert.equal(h24.granularity, 'hour');
    assert.equal(h24.roundedToWholeHours, true);
    assert.equal(h24.roundedToWholeDays, undefined);

    const h72 = await (await fetch(`${base}/v1/keysmith/usage?hours=72`, { headers })).json();
    assert.equal(h72.totals.requests, 41);
    assert.equal(h72.granularity, 'day');
    assert.equal(h72.roundedToWholeDays, true);

    const statusHtml = await (await fetch(`${base}/status`, { headers })).text();
    assert.match(statusHtml, /requests 24h \(UTC hour\)/);
    assert.match(statusHtml, /rounded to the UTC hour/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Round 5 New 6 & Round 4 New 6: /v1/keysmith/usage?by=key reports identical requests and refused in groups, keys, totals, and daily', async () => {
  const r6Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new6-'));
  const usageFile = path.join(r6Dir, 'usage.jsonl');
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', perDay: 1 },
        { key: KEY_BOB, label: 'bob' },
      ],
    },
    adapters: { oai: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9', models: ['gpt-5-mini'] } },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    // 1 admitted call (fails upstream on port 9 -> records status: 'error')
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'oai/gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r1.status, 502);

    // 50 refused calls over perDay=1 (1st refusal writes status: 'limited' row; next 49 increment live counter)
    for (let i = 0; i < 50; i++) {
      const rRef = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'oai/gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(rRef.status, 429);
    }

    const res = await (await fetch(`${base}/v1/keysmith/usage?by=key`, {
      headers: { authorization: `Bearer ${KEY_BOB}` },
    })).json();
    const adaFp = `fp:${fingerprint(KEY_ADA)}`;
    const adaGroup = res.groups.find((g) => g.key === adaFp);
    const adaDaily = res.daily.find((d) => d.key === adaFp);
    const adaKey = res.keys.find((k) => k.key === adaFp);

    assert.ok(adaGroup, 'ada group present');
    assert.equal(adaGroup.requests, 1, 'groups[ada].requests excludes daily-cap refusal row and matches daily');
    assert.equal(adaGroup.failures, 1, 'groups[ada].failures counts only the 1 admitted error');
    assert.equal(adaGroup.refused, 50, 'groups[ada].refused reports all 50 daily-cap refusals');
    assert.equal(adaDaily.requests, 1);
    assert.equal(adaDaily.refused, 50);
    assert.equal(adaKey.requests, 1);
    assert.equal(adaKey.refused, 50);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Round 5 New 7: evicted days report earliest kept day in since (not null), and 100 KB dimension names are truncated to cap memory', () => {
  const r7Dir = fs.mkdtempSync(path.join(tmpDir, 'r5-new7-'));
  const usageFile = path.join(r7Dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T12:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  // 450 consecutive days ending 2026-10-21
  const baseDayMs = Date.parse('2026-10-21T12:00:00.000Z');
  for (let i = 449; i >= 0; i--) {
    const ts = new Date(baseDayMs - i * 86_400_000).toISOString();
    u.record({
      ts,
      adapter: 'oai',
      model: 'oai/gpt-5-mini',
      status: 'ok',
      ms: 10,
    });
  }

  const res = u.query({ by: ['adapter'], fromDays: true });
  assert.equal(res.totals.requests, 400);
  assert.notEqual(res.since, null, 'when days > 400 fall out of _dayAggregates, since must report earliest kept day');
  assert.equal(res.since, '2025-09-17T00:00:00.000Z');

  // 300 rows with 100 KB model names -> truncated at 200 chars + marker in aggregates
  const hugePrefix = 'x'.repeat(100_000);
  for (let i = 0; i < 300; i++) {
    u.record({
      ts: '2026-10-21T11:00:00.000Z',
      adapter: 'oai',
      model: `oai/${i}-${hugePrefix}`,
      status: 'ok',
      ms: 10,
    });
  }
  const byModel = u.query({ by: ['model'], fromDays: true });
  for (const g of byModel.groups) {
    assert.ok(g.model.length <= 220, `model name in aggregate must be capped (got ${g.model.length})`);
  }
});

test('Round 6 (2b & 2c) Tool-call history without tools: Anthropic wire converts tool_calls to tool_use and tool messages to tool_result (refusing non-object arguments with 400), and aliases keep their declared CLI -> HTTP order', async () => {
  const upstreamCalls = [];
  const toolHistStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    upstreamCalls.push({ url: req.url, body });

    if (req.url.endsWith('/chat/completions')) {
      const toolMsg = (body.messages || []).find((m) => m.role === 'tool');
      if (toolMsg && !toolMsg.tool_call_id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'messages.2.tool.tool_call_id: Field required' } }));
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl_th1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'It is 18C.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_ths1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'It is 18C.' }, finish_reason: 'stop' }],
      })}\n\n`);
      if (body.stream_options?.include_usage) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl_ths1',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        })}\n\n`);
      }
      return res.end('data: [DONE]\n\n');
    }

    // Strict Anthropic /v1/messages stub: refuses role: "tool", raw tool_calls, or tool_result without matching tool_use in preceding assistant turn
    let prevToolUseIds = new Set();
    for (let idx = 0; idx < (body.messages || []).length; idx++) {
      const m = body.messages[idx];
      if (m.role !== 'user' && m.role !== 'assistant') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `messages.${idx}.role: unexpected role "${m.role}"` } }));
      }
      if (m.tool_calls || m.tool_call_id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `messages.${idx}: OpenAI tool fields not accepted on Anthropic wire` } }));
      }
      if (idx > 0 && body.messages[idx - 1].role === m.role) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `messages.${idx}: consecutive "${m.role}" turns are not allowed` } }));
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (m.role === 'user') {
        for (const b of blocks) {
          if (b.type === 'tool_result' && !prevToolUseIds.has(b.tool_use_id)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `unexpected tool_use_id "${b.tool_use_id}"` } }));
          }
        }
        prevToolUseIds = new Set();
      } else {
        prevToolUseIds = new Set(blocks.filter((b) => b.type === 'tool_use').map((b) => b.id));
      }
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm_th', usage: { input_tokens: 50, output_tokens: 1 } } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic 18C.' } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`);
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await new Promise((r) => toolHistStub.listen(0, '127.0.0.1', r));
  const thPort = toolHistStub.address().port;

  const thDir = fs.mkdtempSync(path.join(tmpDir, 'r6-th-'));
  const usageFile = path.join(thDir, 'usage.jsonl');
  const cliWorkspace = fs.mkdtempSync(path.join(tmpDir, 'r6-th-ws-'));
  const cliStubPath = path.join(thDir, 'cli-stub.js');
  fs.writeFileSync(cliStubPath, CLI_STUB, { mode: 0o755 });
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      'cli-first': {
        kind: 'cli',
        bin: cliStubPath,
        args: ['-p', '{prompt}'],
        parser: 'cmd-ndjson',
        cwd: cliWorkspace,
        toolMode: 'emulate',
        emulateArgs: ['-p', '{prompt}'],
        models: ['m'],
      },
      'claude-api-oai': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${thPort}/v1`,
        apiKey: 'sk-test-oai',
        _apiKey: 'sk-test-oai',
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${thPort}/v1`,
        apiKey: 'sk-test-anth',
        _apiKey: 'sk-test-anth',
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {
      ordered: ['cli-first/m', 'claude-api-oai/claude-sonnet-5-5'],
    },
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };

  const historyMessages = [
    { role: 'user', content: 'Weather and time in Istanbul?' },
    {
      role: 'assistant',
      content: 'Checking both now.',
      tool_calls: [
        { id: 'call_w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Istanbul"}' } },
        { id: 'call_t1', type: 'function', function: { name: 'get_time', arguments: '{"city":"Istanbul"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_w1', content: '18C' },
    { role: 'tool', tool_call_id: 'call_t1', content: '14:00' },
    { role: 'user', content: 'Summarize in one line.' },
  ];

  try {
    // 1) OpenAI-wire adapter, non-streamed & streamed, no tools offered -> verbatim relay
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api-oai/claude-sonnet-5-5', stream: false, messages: historyMessages }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.choices[0].message.content, 'It is 18C.');
    assert.equal(upstreamCalls.at(-1).body.messages[1].tool_calls[0].id, 'call_w1');
    assert.equal(upstreamCalls.at(-1).body.messages[2].tool_call_id, 'call_w1');

    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api-oai/claude-sonnet-5-5', stream: true, messages: historyMessages }),
    });
    assert.equal(r2.status, 200);
    const s2 = await r2.text();
    assert.match(s2, /It is 18C\./);

    // 2) Anthropic-wire adapter (2b): converts assistant tool_calls -> tool_use blocks after text,
    // and joins consecutive tool results + following user message into one user turn, streamed and not.
    const r3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', stream: false, messages: historyMessages }),
    });
    assert.equal(r3.status, 200);
    const j3 = await r3.json();
    assert.equal(j3.choices[0].message.content, 'Anthropic 18C.');
    const anthMsgs = upstreamCalls.at(-1).body.messages;
    assert.equal(anthMsgs.length, 3);
    assert.deepEqual(anthMsgs[1], {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking both now.' },
        { type: 'tool_use', id: 'call_w1', name: 'get_weather', input: { city: 'Istanbul' } },
        { type: 'tool_use', id: 'call_t1', name: 'get_time', input: { city: 'Istanbul' } },
      ],
    });
    assert.deepEqual(anthMsgs[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_w1', content: '18C' },
        { type: 'tool_result', tool_use_id: 'call_t1', content: '14:00' },
        { type: 'text', text: 'Summarize in one line.' },
      ],
    });

    const r4 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', stream: true, messages: historyMessages }),
    });
    assert.equal(r4.status, 200);
    const s4 = await r4.text();
    assert.match(s4, /Anthropic 18C\./);
    assert.equal(upstreamCalls.at(-1).body.messages.length, 3);

    // 3) Invalid tool_calls arguments (not a JSON object) -> 400 in the face's error shape
    for (const badArgs of ['not-json', '[]', '"str"', '42', 'null']) {
      const badRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-api/claude-sonnet-5-5',
          stream: false,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: badArgs } }] },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' },
          ],
        }),
      });
      assert.equal(badRes.status, 400);
      const badJson = await badRes.json();
      assert.equal(badJson.error.type, 'invalid_request_error');
    }

    // 4) Alias order (2c): alias `ordered` has first leg CLI (`cli-first/m`) and second leg `claude-api-oai/claude-sonnet-5-5`.
    // A chat with tool-call history and no `tools` does NOT skip the CLI leg — the first leg (CLI) answers it!
    const httpCallsBefore = upstreamCalls.length;
    const rAlias = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'ordered', stream: false, messages: historyMessages }),
    });
    assert.equal(rAlias.status, 200);
    const jAlias = await rAlias.json();
    assert.match(jAlias.choices[0].message.content, /^cli answer from /);
    assert.equal(upstreamCalls.length, httpCallsBefore, 'first leg (CLI) answered; HTTP leg was not called');
    const lastRow = u.readAll().at(-1);
    assert.equal(lastRow.adapter, 'cli-first');
    assert.equal(lastRow.kind, 'cli');
  } finally {
    srv.closeAllConnections?.();
    toolHistStub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => toolHistStub.close(r));
  }
});

test('Round 6 (2d & 2e): every refusal (including refused reads of /v1/keysmith/usage) reaches groups and daily alike at its own timestamp in hour and day cells', async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'r6-refusals-'));
  const usageFile = path.join(dir, 'usage.jsonl');
  const clock = { t: Date.parse('2026-10-20T01:00:00.000Z') };
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        { key: KEY_ADA, label: 'ada', perDay: 4 },
        { key: KEY_BOB, label: 'bob' },
      ],
    },
    adapters: { oai: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9', models: ['gpt-5-mini'] } },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u, now: () => clock.t });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const adaH = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const bobH = { authorization: `Bearer ${KEY_BOB}` };

  try {
    // 4 admitted requests that fail before routing (3 POSTs + 1 refused GET /v1/keysmith/usage?tail=9999)
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: adaH, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', headers: adaH, body: JSON.stringify({ model: 'oai/gpt-5-mini', messages: [] }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', headers: adaH, body: JSON.stringify({ model: 'oai/gpt-5-mini', input: 'hi', previous_response_id: 'resp_1' }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/keysmith/usage?tail=9999`, { headers: { authorization: `Bearer ${KEY_ADA}` } })).status, 400);

    // 2d: groups and daily both show 4 requests (and 4 failures) for ada — never groups 3 and daily 4!
    const after4 = await (await fetch(`${base}/v1/keysmith/usage?by=key`, { headers: bobH })).json();
    const adaFp = `fp:${fingerprint(KEY_ADA)}`;
    assert.equal(after4.groups.find((g) => g.key === adaFp).requests, 4);
    assert.equal(after4.groups.find((g) => g.key === adaFp).failures, 4);
    assert.equal(after4.daily.find((d) => d.key === adaFp).requests, 4);

    // Now ada is at her perDay=4 cap. Trigger 9 daily-cap refusals (429) at 2026-10-20T01:00:00Z, including on /v1/keysmith/usage
    for (let i = 0; i < 8; i++) {
      assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: adaH, body: JSON.stringify({ model: 'oai/gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }) })).status, 429);
    }
    assert.equal((await fetch(`${base}/v1/keysmith/usage`, { headers: { authorization: `Bearer ${KEY_ADA}` } })).status, 429);

    // 2e: ?by=day includes all 9 refusals in the 2026-10-20 group (both fromDays: true and CLI fromDays: false)
    const byDayNow = await (await fetch(`${base}/v1/keysmith/usage?by=day`, { headers: bobH })).json();
    const dayGroup = byDayNow.groups.find((g) => g.day === '2026-10-20');
    assert.ok(dayGroup, '2026-10-20 day group present');
    assert.equal(dayGroup.requests, 4);
    assert.equal(dayGroup.refused, 9);

    const cliByDay = u.query({ by: ['day'], now: clock.t, fromDays: false });
    assert.equal(cliByDay.groups.find((g) => g.day === '2026-10-20').refused, 9);

    // Advance clock by 22 hours (to 2026-10-20T23:00:00Z): ?hours=1 must show 0 requests and 0 refused (not 9!)
    clock.t = Date.parse('2026-10-20T23:00:00.000Z');
    const h1Later = await (await fetch(`${base}/v1/keysmith/usage?hours=1`, { headers: bobH })).json();
    assert.equal(h1Later.totals.requests, 0);
    assert.equal(h1Later.totals.refused, 0);
    assert.equal(h1Later.groups.length, 0);

    // While ?hours=24 still includes the 01:00Z hour cell (4 requests, 9 refused)
    const h24Later = await (await fetch(`${base}/v1/keysmith/usage?hours=24&by=day`, { headers: bobH })).json();
    assert.equal(h24Later.totals.requests, 4);
    assert.equal(h24Later.totals.refused, 9);
    assert.equal(h24Later.groups[0].day, '2026-10-20');
    assert.equal(h24Later.groups[0].refused, 9);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test('Round 6 (2f): tail ring is bounded by bytes (TAIL_RING_MAX_BYTES) as well as rows, and spend state adaptersSeen is bounded by name length (200 chars + marker) and count (MAX_ADAPTERS_SEEN)', () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'r6-bounds-'));
  const usageFile = path.join(dir, 'usage.jsonl');
  const nowMs = Date.parse('2026-10-21T12:00:00.000Z');
  const u = new UsageLog(usageFile, { now: () => nowMs });

  // Warm the tail ring, then write 250 rows of ~12 KB each (~3 MB total > 2 MiB TAIL_RING_MAX_BYTES)
  assert.deepEqual(u.tail(10), []);
  const bigError = 'e'.repeat(12_000);
  for (let i = 0; i < 250; i++) {
    u.record({
      ts: '2026-10-21T10:00:00.000Z',
      adapter: 'oai',
      model: `oai/m-${i}`,
      status: 'error',
      error: bigError,
      ms: 10,
    });
  }
  const tailRows = u.tail(TAIL_RING_MAX);
  assert.ok(tailRows.length < 250, `tail ring evicted oldest rows to stay under 2 MiB (kept ${tailRows.length} rows)`);
  assert.ok(u._tailRingBytes <= TAIL_RING_MAX_BYTES, `_tailRingBytes (${u._tailRingBytes}) <= ${TAIL_RING_MAX_BYTES}`);
  assert.equal(tailRows[0].model, 'oai/m-249');

  // Cold rebuild of tail ring from disk also enforces TAIL_RING_MAX_BYTES
  u._tailRing = null;
  u._tailRingBytes = 0;
  const rebuiltTail = u.tail(TAIL_RING_MAX);
  assert.ok(rebuiltTail.length < 250);
  assert.ok(u._tailRingBytes <= TAIL_RING_MAX_BYTES);

  // Spend state's adaptersSeen: truncates >200-char adapter names with `…[truncated]` and caps count at MAX_ADAPTERS_SEEN (1,000)
  const dir2 = fs.mkdtempSync(path.join(tmpDir, 'r6-adapters-seen-'));
  const u2 = new UsageLog(path.join(dir2, 'usage.jsonl'), { now: () => nowMs });
  u2.seedSpend();
  const longAdapter = 'a'.repeat(500);
  u2.record({ ts: '2026-10-21T11:00:00.000Z', adapter: longAdapter, model: 'm', status: 'ok', ms: 1 });
  for (let i = 0; i < MAX_ADAPTERS_SEEN + 200; i++) {
    u2.record({ ts: '2026-10-21T11:00:00.000Z', adapter: `adp-${i}`, model: 'm', status: 'ok', ms: 1 });
  }
  const seen = [...u2._spendState.adaptersSeen];
  assert.equal(seen.length, MAX_ADAPTERS_SEEN);
  assert.equal(seen[0], `${'a'.repeat(200)}…[truncated]`);
});

test('Round 6 (3a): verbatim openai-wire relay records usage from non-streamed body, usage-only last chunk, finish_reason chunk with usage, client-requested include_usage, and streamUsage: false', async () => {
  let streamMode = 'usage-only-chunk';
  const upstreamBodies = [];
  const relayStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    upstreamBodies.push(body);

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl_ns',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'nonstream ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
      }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (streamMode === 'usage-on-finish') {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_uf',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'on ' }, finish_reason: null }],
        ...(body.stream_options?.include_usage ? { usage: null } : {}),
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_uf',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'finish' }, finish_reason: 'stop' }],
        ...(body.stream_options?.include_usage ? { usage: { prompt_tokens: 200, completion_tokens: 40 } } : {}),
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    // Default: usage-only last chunk (choices: []), with "usage": null on non-final chunks when include_usage is on
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_uo',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'usage only chunk' }, finish_reason: 'stop' }],
      ...(body.stream_options?.include_usage ? { usage: null } : {}),
    })}\n\n`);
    if (body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_uo',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => relayStub.listen(0, '127.0.0.1', r));
  const port = relayStub.address().port;

  const dir = fs.mkdtempSync(path.join(tmpDir, 'r6-3a-'));
  const usageFile = path.join(dir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      oai: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: false,
        models: ['claude-sonnet-5-5'],
      },
      'oai-no-su': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: false,
        streamUsage: false,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) Non-streamed relay
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: '1' }], tools }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.usage.prompt_tokens, 120);

    // 2) Streamed relay with usage-only last chunk (client did not ask for include_usage -> usage: null stripped from content chunk, usage-only chunk dropped)
    streamMode = 'usage-only-chunk';
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: '2' }], tools }),
    });
    const t2 = await r2.text();
    assert.match(t2, /usage only chunk/);
    assert.ok(!t2.includes('"usage"'), 'usage: null and usage-only chunk stripped when client did not request include_usage');

    // 3) Streamed relay with usage: null on content chunk and usage object on finish_reason chunk (client did not ask -> usage stripped from both, choices kept)
    streamMode = 'usage-on-finish';
    const r3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: '3' }], tools }),
    });
    const t3 = await r3.text();
    assert.match(t3, /on /);
    assert.match(t3, /finish/);
    assert.match(t3, /"finish_reason":"stop"/);
    assert.ok(!t3.includes('"usage"'), 'usage: null and usage object stripped from chunks while keeping choices');

    // 4) Streamed relay where client asked for stream_options: { include_usage: true } itself
    streamMode = 'usage-only-chunk';
    const r4 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'oai/claude-sonnet-5-5',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '4' }],
        tools,
      }),
    });
    const t4 = await r4.text();
    assert.match(t4, /"usage":null/, 'client that requested include_usage receives non-final usage: null');
    assert.match(t4, /"prompt_tokens":300,"completion_tokens":60/, 'client that requested include_usage receives final usage chunk');

    // 5) Adapter with streamUsage: false -> no stream_options sent upstream, row records usage: null + usageReason
    const r5 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai-no-su/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: '5' }], tools }),
    });
    await r5.text();
    assert.equal(upstreamBodies.at(-1).stream_options, undefined);

    const rows = u.readAll();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0].usage, { input: 120, output: 30, cacheRead: 20, cacheWrite: 0 });
    assert.deepEqual(rows[0].cost, { usd: 0.000502, basis: 'metered' });
    assert.deepEqual(rows[1].usage, { input: 300, output: 60, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(rows[2].usage, { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(rows[3].usage, { input: 300, output: 60, cacheRead: 0, cacheWrite: 0 });
    assert.equal(rows[4].usage, null);
    assert.match(rows[4].usageReason, /streamUsage false/);
  } finally {
    srv.closeAllConnections?.();
    relayStub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => relayStub.close(r));
  }
});

test('Round 6 (Item 1): paths added on main (codex exec --json, effort, media) write the audit slice fields and price cache-inclusive CLI tokens accurately', async () => {
  // Stub CLI emitting codex --json turn.completed with cached_input_tokens
  const codexStubPath = path.join(tmpDir, 'codex-audit-stub.js');
  fs.writeFileSync(
    codexStubPath,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'debug' && argv[1] === 'models') {
  process.stdout.write(JSON.stringify([{ slug: 'claude-sonnet-5-5', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] }]));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex json ok' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500 } }) + '\\n');
`,
    { mode: 0o755 },
  );

  const mediaStub = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_media_1' });
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_m1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'saw image' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => mediaStub.listen(0, '127.0.0.1', r));
  const mediaPort = mediaStub.address().port;

  const dir = fs.mkdtempSync(path.join(tmpDir, 'r6-item1-'));
  const usageFile = path.join(dir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      codex: {
        kind: 'cli',
        bin: codexStubPath,
        args: ['exec', '--json', ['-m', '{model}'], ['-c', 'model_reasoning_effort={effort}'], '--', '{prompt}'],
        parser: 'codex-json',
        modelsFrom: { args: ['debug', 'models'] },
        account: 'codex-sub',
        models: ['claude-sonnet-5-5'],
      },
      'vision-http': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${mediaPort}/v1`,
        apiKey: false,
        account: 'vision-acct',
        media: ['image'],
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json', 'x-keysmith-tag': 'r6-main' };

  // 1x1 PNG data URL
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  try {
    // 1) codex exec --json with reasoning_effort: 'high'
    const rCodex = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'codex/claude-sonnet-5-5',
        reasoning_effort: 'high',
        stream: false,
        messages: [{ role: 'user', content: 'hello codex' }],
      }),
    });
    assert.equal(rCodex.status, 200);
    const jCodex = await rCodex.json();
    assert.equal(jCodex.choices[0].message.content, 'codex json ok');
    assert.equal(jCodex.usage.prompt_tokens, 10000);
    assert.equal(jCodex.usage.prompt_tokens_details.cached_tokens, 8000);

    // 2) Media (inline PNG image_url) through HTTP adapter
    const rMedia = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'vision-http/claude-sonnet-5-5',
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image_url', image_url: { url: png1x1 } },
          ],
        }],
      }),
    });
    assert.equal(rMedia.status, 200);
    await rMedia.json();

    const rows = u.readAll();
    assert.equal(rows.length, 2);
    // Row 0: codex CLI row has effort: 'high', usage.input: 10000 (3b7e612), and listUsd priced on 2000 uncached ($0.004) + 8000 cacheRead ($0.0008) + 500 output ($0.005) = $0.0098
    assert.equal(rows[0].label, 'ada');
    assert.equal(rows[0].adapter, 'codex');
    assert.equal(rows[0].kind, 'cli');
    assert.equal(rows[0].account, 'codex-sub');
    assert.equal(rows[0].face, 'chat');
    assert.equal(rows[0].tag, 'r6-main');
    assert.equal(rows[0].effort, 'high');
    assert.deepEqual(rows[0].usage, { input: 10000, output: 500, cacheRead: 8000, cacheWrite: 0 });
    assert.deepEqual(rows[0].cost, { usd: 0, basis: 'subscription', listUsd: 0.0098 });

    // Row 1: media HTTP row
    assert.equal(rows[1].label, 'ada');
    assert.equal(rows[1].adapter, 'vision-http');
    assert.equal(rows[1].kind, 'http');
    assert.equal(rows[1].host, `127.0.0.1:${mediaPort}`);
    assert.equal(rows[1].account, 'vision-acct');
    assert.equal(rows[1].face, 'chat');
    assert.equal(rows[1].upstreamId, 'req_media_1');
    assert.equal(rows[1].tag, 'r6-main');
    assert.ok(rows[1].bytesIn > 100);
    assert.ok(rows[1].bytesOut > 50);
    assert.deepEqual(rows[1].cost, { usd: 0.0015, basis: 'metered' });
  } finally {
    srv.closeAllConnections?.();
    mediaStub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => mediaStub.close(r));
  }
});

test('Round 6 fix round: every CLI parser subtracts cache tokens in listUsd, HTTP and CLI rows log cache-inclusive usage.input so keysmith usage totals add like with like, and stripInjectedUsageSseEvent strips usage: null from every non-final chunk', async () => {
  const fixDir = fs.mkdtempSync(path.join(tmpDir, 'r6-fix-'));

  // 1) Finding 1: cmd-ndjson, agy-stream-json, kiro-stream-json, and warp-ndjson all report
  // input: 1000, cacheRead: 500, cacheWrite: 100, output: 200 on claude-opus-5-5 -> listUsd: 0.0062 (never 0.0086)
  const makeCliBin = (name, lines) => {
    const p = path.join(fixDir, name);
    fs.writeFileSync(
      p,
      `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + '\\n');\n`,
      { mode: 0o755 },
    );
    return p;
  };
  const cmdBin = makeCliBin('cmd-cli', [
    { type: 'event', event: { type: 'text_delta', delta: 'cmd ok' } },
    { type: 'result', sessionId: 's1', subtype: 'success', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 }, stopReason: 'end_turn' },
  ]);
  const agyBin = makeCliBin('agy-cli', [
    { event: 'result', result: { status: 'SUCCESS', response: 'agy ok', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } } },
  ]);
  const kiroBin = makeCliBin('kiro-cli', [
    { type: 'metadata', data: { tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 } } },
    { type: 'runFinished', data: { finalText: 'kiro ok' } },
  ]);
  // Also a CLI stub that reports the same Anthropic turn as upstreamServer's /anthropic/ (3400 input = 1000 uncached + 2000 cacheRead + 400 cacheWrite, 500 output)
  const anthTurnCliBin = makeCliBin('anth-turn-cli', [
    { type: 'event', event: { type: 'text_delta', delta: 'cli sonnet reply' } },
    { type: 'result', sessionId: 's2', subtype: 'success', usage: { inputTokens: 3400, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 400 }, stopReason: 'end_turn' },
  ]);

  // 2) Finding 3 stub: OpenAI-wire upstream sending "usage": null on every non-final chunk when include_usage is true
  const nullUsageStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const inc = !!body.stream_options?.include_usage;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_nu',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'chunk-1 ' }, finish_reason: null }],
      ...(inc ? { usage: null } : {}),
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl_nu',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'chunk-2' }, finish_reason: 'stop' }],
      ...(inc ? { usage: null } : {}),
    })}\n\n`);
    if (inc) {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_nu',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 3400, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 2000, cache_creation_tokens: 400 } },
      })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => nullUsageStub.listen(0, '127.0.0.1', r));
  const nuPort = nullUsageStub.address().port;

  const usageFile = path.join(fixDir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      'cli-cmd': { kind: 'cli', bin: cmdBin, args: ['{prompt}'], parser: 'cmd-ndjson', models: ['claude-opus-5-5'] },
      'cli-agy': { kind: 'cli', bin: agyBin, args: ['{prompt}'], parser: 'agy-stream-json', models: ['claude-opus-5-5'] },
      'cli-kiro': { kind: 'cli', bin: kiroBin, args: ['{prompt}'], parser: 'kiro-stream-json', models: ['claude-opus-5-5'] },
      'claude-cli': { kind: 'cli', bin: anthTurnCliBin, args: ['{prompt}'], parser: 'cmd-ndjson', models: ['claude-sonnet-5-5'] },
      'claude-api': {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic/v1`,
        apiKey: SECRET_LITERAL_VAL,
        models: ['claude-sonnet-5-5'],
      },
      'oai-relay': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${nuPort}/v1`,
        apiKey: false,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) Verify all 3 non-listed CLI parsers (cmd-ndjson, agy-stream-json, kiro-stream-json) produce listUsd = 0.0062 on claude-opus-5-5 (400 uncached * 4 + 200 out * 20 + 500 cacheRead * 0.2 + 100 cacheWrite * 5 = 6200 / 1M)
    for (const adapterId of ['cli-cmd', 'cli-agy', 'cli-kiro']) {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: `${adapterId}/claude-opus-5-5`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(r.status, 200);
      await r.json();
    }

    const parserRows = u.readAll();
    assert.equal(parserRows.length, 3);
    for (const row of parserRows) {
      assert.deepEqual(row.usage, { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 }, `usage for ${row.adapter}`);
      assert.deepEqual(row.cost, { usd: 0, basis: 'subscription', listUsd: 0.0062 }, `listUsd for ${row.adapter}`);
    }

    // 2) Finding 2 & 3: same turn (1000 uncached + 2000 cacheRead + 400 cacheWrite = 3400 input, 500 output)
    // across claude-api (HTTP Anthropic wire), claude-cli (CLI), and oai-relay (streamed tool relay with "usage": null on non-final chunks)
    const rHttp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-api/claude-sonnet-5-5', messages: [{ role: 'user', content: 'same turn' }] }),
    });
    assert.equal(rHttp.status, 200);
    await rHttp.json();

    const rCli = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-cli/claude-sonnet-5-5', messages: [{ role: 'user', content: 'same turn' }] }),
    });
    assert.equal(rCli.status, 200);
    await rCli.json();

    const rRelay = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'oai-relay/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'same turn' }], tools }),
    });
    assert.equal(rRelay.status, 200);
    const relaySse = await rRelay.text();
    assert.match(relaySse, /chunk-1 /);
    assert.match(relaySse, /chunk-2/);
    assert.ok(!relaySse.includes('"usage"'), 'every non-final "usage": null member and final usage-only chunk removed when client did not set stream_options');

    const allRows = u.readAll().slice(3);
    assert.equal(allRows.length, 3);
    for (const row of allRows) {
      assert.deepEqual(row.usage, { input: 3400, output: 500, cacheRead: 2000, cacheWrite: 400 }, `unified usage.input on ${row.adapter}`);
    }
    assert.deepEqual(allRows[0].cost, { usd: 0.0082, basis: 'metered' });
    assert.deepEqual(allRows[1].cost, { usd: 0, basis: 'subscription', listUsd: 0.0082 });
    assert.deepEqual(allRows[2].cost, { usd: 0.0082, basis: 'metered' });

    // And `keysmith usage --by adapter` adds like with like across HTTP and CLI adapters:
    // 3 parser rows * 1000 + 3 sonnet rows * 3400 = 13200 total input tokens
    const byAdapter = u.query({ by: ['adapter'] });
    assert.equal(byAdapter.groups.find((g) => g.adapter === 'claude-api').input, 3400);
    assert.equal(byAdapter.groups.find((g) => g.adapter === 'claude-cli').input, 3400);
    assert.equal(byAdapter.groups.find((g) => g.adapter === 'oai-relay').input, 3400);
    assert.equal(byAdapter.totals.input, 13200);
  } finally {
    srv.closeAllConnections?.();
    nullUsageStub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => nullUsageStub.close(r));
  }
});

/* ---------------- 15. Round 7: UHP & Traycer audit rows (2a), new profile cost bases (2b), unknown usage pricing & stats (2c), and obfuscation usage-only chunk stripping (3a) */

test('Round 7 (2a & 2b): UHP server/relay and Traycer multi-provider wire write all audit fields, extract cache-inclusive tokens, and assign metered vs subscription (with listUsd) cost bases across all e4b809d and db9ca66 profiles', async () => {
  const { CLI_PROFILES, HTTP_PROFILES } = await import('../src/profiles.js');
  const { checkAdapter, kindOf } = await import('../src/gateway.js');

  // 2b: Read each profile's real definition without overriding fields and assert its basis by name
  const e4b809dCliProfiles = [
    'gemini', 'kilo', 'qwen', 'cline', 'goose', 'kimi', 'minimax', 'grok',
    'pi', 'omp', 'dsh', 'aider', 'mimo', 'jcode', 'vibe', 'hermes',
    'openhands', 'cheetahclaws', 'opensquilla', 'nanobot', 'zeroclaw',
    'docker-agent', 'fast-agent', 'dcode',
  ];
  const db9ca66CliProfiles = ['traycer-cli', 'droid', 'devin', 'copilot-cli', 'cursor', 'amp', 'reasonix'];
  for (const name of [...e4b809dCliProfiles, ...db9ca66CliProfiles]) {
    const def = CLI_PROFILES[name];
    assert.ok(def, `CLI profile ${name} exists`);
    assert.equal(def.kind, 'cli', `CLI profile ${name} declares kind: 'cli'`);
    assert.equal(kindOf(def), 'cli', `kindOf(CLI_PROFILES.${name}) is 'cli'`);
    assert.equal(def.costBasis, undefined, `CLI profile ${name} does not override subscription default`);
    const inst = checkAdapter(name, def);
    assert.equal(inst.kind, 'cli', `checkAdapter(${name}) has kind 'cli'`);
    assert.equal(inst.costBasis, 'subscription', `CLI profile ${name} has subscription costBasis`);
    const c = computeCost({
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
      adapter: name,
      model: `${name}/claude-sonnet-5-5`,
      kind: def.kind,
      costBasis: def.costBasis,
    });
    assert.deepEqual(c, { usd: 0, basis: 'subscription', listUsd: 0.00662 });
  }

  for (const name of ['harnessrouter']) {
    const def = HTTP_PROFILES[name];
    assert.ok(def, `HTTP profile ${name} exists`);
    assert.equal(def.wire, 'uhp', `HTTP profile ${name} uses uhp wire`);
    assert.equal(kindOf(def), 'http', `kindOf(HTTP_PROFILES.${name}) is 'http'`);
    assert.equal(def.costBasis, undefined, `HTTP profile ${name} defaults to metered costBasis`);
    const inst = checkAdapter(name, def);
    assert.equal(inst.kind, 'http', `checkAdapter(${name}) has kind 'http'`);
    assert.equal(inst.costBasis, 'metered', `HTTP profile ${name} has metered costBasis`);
    const c = computeCost({
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
      adapter: name,
      model: `${name}/claude/claude-sonnet-5-5`,
      kind: kindOf(def),
      costBasis: def.costBasis,
    });
    assert.deepEqual(c, { usd: 0.00662, basis: 'metered' });
  }

  assert.ok(HTTP_PROFILES.traycer, 'HTTP profile traycer exists');
  assert.equal(HTTP_PROFILES.traycer.wire, 'traycer');
  assert.equal(kindOf(HTTP_PROFILES.traycer), 'http');
  assert.equal(HTTP_PROFILES.traycer.costBasis, 'subscription');
  const traycerInst = checkAdapter('traycer', HTTP_PROFILES.traycer);
  assert.equal(traycerInst.kind, 'http');
  assert.equal(traycerInst.costBasis, 'subscription');
  assert.deepEqual(
    computeCost({
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
      adapter: 'traycer',
      model: 'traycer/anthropic/claude-sonnet-5-5',
      kind: kindOf(HTTP_PROFILES.traycer),
      costBasis: HTTP_PROFILES.traycer.costBasis,
    }),
    { usd: 0, basis: 'subscription', listUsd: 0.00662 },
  );

  // 2a: End-to-end UHP relay (SSE + JSON + EMULATE fallback) and Traycer wire (anthropic, openai/responses, openrouter)
  const upstreamStub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};

    if (req.url === '/uhp/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_uhp_up_1', status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'uhp hello' })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_uhp_up_1',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'uhp hello' }] }],
          usage: {
            input_tokens: 1500,
            input_tokens_details: { cached_tokens: 500 },
            output_tokens: 200,
            total_tokens: 1700,
          },
        },
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    if (req.url === '/traycer/api/traycer/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        models: [
          { id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
          { id: 'openai/claude-opus-5-5', provider: 'openai', modelId: 'claude-opus-5-5' },
        ],
      }));
    }

    if (req.url === '/traycer/inference/anthropic/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_traycer_anth_1' });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_tr1', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400, output_tokens: 1 } },
      })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'traycer anthropic ok' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } })}\n\n`);
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }

    if (req.url === '/traycer/inference/openai/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_traycer_oai_1' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_tr_oai_1', status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'traycer oai ok' })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_tr_oai_1',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'traycer oai ok' }] }],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 500, cache_write_tokens: 100 },
            output_tokens: 200,
            total_tokens: 1200,
          },
        },
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    res.writeHead(404);
    res.end();
    void body;
  });
  await new Promise((r) => upstreamStub.listen(0, '127.0.0.1', r));
  const port = upstreamStub.address().port;

  const r7Dir = fs.mkdtempSync(path.join(tmpDir, 'r7-2ab-'));
  const usageFile = path.join(r7Dir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      harnessrouter: {
        ...HTTP_PROFILES.harnessrouter,
        baseUrl: `http://127.0.0.1:${port}/uhp/v1`,
        apiKey: '{env:HARNESSROUTER_API_KEY}',
        _rawKeyRef: '{env:HARNESSROUTER_API_KEY}',
        _apiKey: 'hr-secret',
        _apiKeyResolved: true,
        models: ['claude/claude-sonnet-5-5'],
      },
      traycer: {
        ...HTTP_PROFILES.traycer,
        baseUrl: `http://127.0.0.1:${port}/traycer`,
        apiKey: '{json:~/.traycer/cli/credentials#token}',
        _rawKeyRef: '{json:~/.traycer/cli/credentials#token}',
        _apiKey: 'tr-secret',
        _apiKeyResolved: true,
        models: ['anthropic/claude-sonnet-5-5', 'openai/claude-opus-5-5'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = {
    authorization: `Bearer ${KEY_ADA}`,
    'content-type': 'application/json',
    'x-keysmith-tag': 'uhp-traycer',
    'user-agent': 'ks-r7-test/1.0',
  };

  try {
    // 1) UHP request via /v1/responses with x-harness-id -> harnessrouter (metered)
    const rUhp = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...headers, 'x-harness-id': 'harnessrouter' },
      body: JSON.stringify({ model: 'claude/claude-sonnet-5-5', stream: false, input: 'ping uhp' }),
    });
    assert.equal(rUhp.status, 200);
    const jUhp = await rUhp.json();
    assert.equal(jUhp.output[0].content[0].text, 'uhp hello');
    assert.equal(jUhp.usage.input_tokens, 1500);
    assert.equal(jUhp.usage.input_tokens_details.cached_tokens, 500);

    // 2) Traycer request on anthropic provider via /v1/messages -> subscription with listUsd
    const rTrAnth = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'traycer/anthropic/claude-sonnet-5-5', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'ping traycer anth' }] }),
    });
    assert.equal(rTrAnth.status, 200);
    const jTrAnth = await rTrAnth.json();
    assert.equal(jTrAnth.content[0].text, 'traycer anthropic ok');

    // 3) Traycer request on openai/responses provider via /v1/chat/completions -> subscription with listUsd
    const rTrOai = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'traycer/openai/claude-opus-5-5', stream: false, messages: [{ role: 'user', content: 'ping traycer oai' }] }),
    });
    assert.equal(rTrOai.status, 200);
    const jTrOai = await rTrOai.json();
    assert.equal(jTrOai.choices[0].message.content, 'traycer oai ok');

    const rows = u.readAll();
    assert.equal(rows.length, 3);

    // Row 0: UHP relay on harnessrouter -> metered ($0.00405: 1000 uncached * $2 + 500 cached * $0.10 + 200 out * $10 / 1M)
    assert.equal(rows[0].label, 'ada');
    assert.equal(rows[0].adapter, 'harnessrouter');
    assert.equal(rows[0].kind, 'http');
    assert.equal(rows[0].host, `127.0.0.1:${port}`);
    assert.equal(rows[0].account, 'HARNESSROUTER_API_KEY');
    assert.equal(rows[0].face, 'responses');
    assert.equal(rows[0].upstreamId, 'resp_uhp_up_1');
    assert.equal(rows[0].tag, 'uhp-traycer');
    assert.ok(rows[0].bytesIn > 0);
    assert.ok(rows[0].bytesOut > 0);
    assert.deepEqual(rows[0].usage, { input: 1500, output: 200, cacheRead: 500, cacheWrite: 0 });
    assert.deepEqual(rows[0].cost, { usd: 0.00405, basis: 'metered' });

    // Row 1: Traycer anthropic -> subscription with listUsd ($0.0082 on claude-sonnet-5-5)
    assert.equal(rows[1].label, 'ada');
    assert.equal(rows[1].adapter, 'traycer');
    assert.equal(rows[1].kind, 'http');
    assert.equal(rows[1].host, `127.0.0.1:${port}`);
    assert.equal(rows[1].account, 'exec');
    assert.equal(rows[1].face, 'messages');
    assert.equal(rows[1].upstreamId, 'req_traycer_anth_1');
    assert.equal(rows[1].tag, 'uhp-traycer');
    assert.ok(rows[1].bytesIn > 0);
    assert.ok(rows[1].bytesOut > 0);
    assert.deepEqual(rows[1].usage, { input: 3400, output: 500, cacheRead: 2000, cacheWrite: 400 });
    assert.deepEqual(rows[1].cost, { usd: 0, basis: 'subscription', listUsd: 0.0082 });

    // Row 2: Traycer openai/responses -> subscription with listUsd ($0.0062 on claude-opus-5-5)
    assert.equal(rows[2].adapter, 'traycer');
    assert.equal(rows[2].account, 'exec');
    assert.equal(rows[2].face, 'chat');
    assert.equal(rows[2].upstreamId, 'req_traycer_oai_1');
    assert.deepEqual(rows[2].usage, { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 });
    assert.deepEqual(rows[2].cost, { usd: 0, basis: 'subscription', listUsd: 0.0062 });
  } finally {
    srv.closeAllConnections?.();
    upstreamStub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => upstreamStub.close(r));
  }
});

test('Round 7 (2c & 3a): unknown token counts log usage: null and cost: {usd: null, basis: "unpriced", reason}, are counted apart in keysmith usage so no total treats unknown as 0, preserve 11350b4/cbd929f client answers, and stripInjectedUsageSseEvent drops choices: [] chunks with obfuscation padding', async () => {
  const r7Dir = fs.mkdtempSync(path.join(tmpDir, 'r7-2c-3a-'));
  const rawCliBin = path.join(r7Dir, 'raw-cli-unknown');
  fs.writeFileSync(
    rawCliBin,
    `#!/usr/bin/env node\nprocess.stdout.write('hello from raw cli\\n');\n`,
    { mode: 0o755 },
  );

  // HTTP stub that serves:
  // - /obfuscated/v1/chat/completions: SSE with a final usage-only chunk containing `obfuscation: "pad_xyz"` and `choices: []`
  // - /unknown-uhp/v1/responses: UHP response with `usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, keysmith_usage: 'unknown', reason: 'remote harness reported no token counts' }`
  const stub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};

    if (req.url === '/obfuscated/v1/chat/completions') {
      const inc = !!body.stream_options?.include_usage;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_obf_1' });
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_obf',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: body.model,
        choices: [],
        prompt_filter_results: [{ prompt_index: 0, content_filter_results: { hate: { filtered: false, severity: 'safe' } } }],
        ...(inc ? { usage: null } : {}),
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl_obf',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'obf ok' }, finish_reason: 'stop' }],
        ...(inc ? { usage: null } : {}),
        obfuscation: 'pad_chunk_1',
      })}\n\n`);
      if (inc) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl_obf',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
          obfuscation: 'pad_final_usage_only',
        })}\n\n`);
      }
      return res.end('data: [DONE]\n\n');
    }

    if (req.url === '/unknown-uhp/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_unk_1', status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'uhp unknown ok' })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_unk_1',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'uhp unknown ok' }] }],
          usage: {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0,
            keysmith_usage: 'unknown',
            reason: 'remote harness reported no token counts',
          },
        },
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  const usageFile = path.join(r7Dir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    adapters: {
      'raw-cli': {
        kind: 'cli',
        bin: rawCliBin,
        args: ['{prompt}'],
        parser: 'raw',
        models: ['claude-sonnet-5-5'],
      },
      'uhp-unk': {
        kind: 'http',
        wire: 'uhp',
        baseUrl: `http://127.0.0.1:${port}/unknown-uhp/v1`,
        apiKey: false,
        models: ['claude-sonnet-5-5'],
      },
      'obf-oai': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${port}/obfuscated/v1`,
        apiKey: false,
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {},
  };
  const u = new UsageLog(usageFile);
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) Raw CLI via /v1/chat/completions -> client gets null where chat SDKs accept null (11350b4), log gets usage: null and cost: { usd: null, basis: 'unpriced', reason }
    const rChatUnk = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'raw-cli/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.equal(rChatUnk.usage.prompt_tokens, null);
    assert.equal(rChatUnk.usage.completion_tokens, null);
    assert.equal(rChatUnk.usage.total_tokens, null);
    assert.deepEqual(rChatUnk.usage.prompt_tokens_details, { cached_tokens: null });
    assert.deepEqual(rChatUnk.usage.completion_tokens_details, { reasoning_tokens: null });
    assert.equal(rChatUnk.usage.keysmith_usage, 'unknown');
    assert.match(rChatUnk.usage.reason, /raw/);

    // 2) Raw CLI via /v1/responses -> client gets 0 in totals and details too (cbd929f), log gets usage: null
    const rRespUnk = await (await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'raw-cli/claude-sonnet-5-5', stream: false, input: 'hi' }),
    })).json();
    assert.equal(rRespUnk.usage.input_tokens, 0);
    assert.equal(rRespUnk.usage.output_tokens, 0);
    assert.equal(rRespUnk.usage.total_tokens, 0);
    assert.deepEqual(rRespUnk.usage.input_tokens_details, { cached_tokens: 0 });
    assert.deepEqual(rRespUnk.usage.output_tokens_details, { reasoning_tokens: 0 });
    assert.equal(rRespUnk.usage.keysmith_usage, 'unknown');

    // 3) UHP upstream reporting unknown usage via /v1/messages -> client gets 0 where Message requires number and null for cache (11350b4), log gets usage: null and cost: { usd: null, basis: 'unpriced', reason }
    const rMsgUnk = await (await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'uhp-unk/claude-sonnet-5-5', max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.equal(rMsgUnk.usage.input_tokens, 0);
    assert.equal(rMsgUnk.usage.output_tokens, 0);
    assert.equal(rMsgUnk.usage.cache_creation_input_tokens, null);
    assert.equal(rMsgUnk.usage.cache_read_input_tokens, null);
    assert.equal(rMsgUnk.usage.keysmith_usage, 'unknown');
    assert.equal(rMsgUnk.usage.reason, 'remote harness reported no token counts');

    // Before any known-usage request is logged, `keysmith usage` has ONLY unknown-usage rows:
    // Totals and groups must report null (not 0!) for token counts and USD, and unknownUsage: 3!
    const allUnknownReport = u.query({ by: ['adapter'] });
    assert.equal(allUnknownReport.totals.requests, 3);
    assert.equal(allUnknownReport.totals.unknownUsage, 3);
    assert.equal(allUnknownReport.totals.input, null);
    assert.equal(allUnknownReport.totals.output, null);
    assert.equal(allUnknownReport.totals.tokens, null);
    assert.equal(allUnknownReport.totals.meteredUsd, null);
    assert.equal(allUnknownReport.totals.listUsd, null);
    const tblAllUnk = formatUsageTable(allUnknownReport);
    assert.match(tblAllUnk, /3 unknown usage/);
    assert.match(tblAllUnk, /tokens: unknown in \/ unknown out/);
    assert.match(tblAllUnk, /metered: unknown · list-equiv: unknown/);
    const csvAllUnk = formatUsageCsv(allUnknownReport);
    assert.match(csvAllUnk, /^total,3,0,,,,,,,/m, 'CSV total row leaves token and USD cells empty (never 0) when all rows have unknown usage');

    // 4) Requirement 3a: streamed tool relay on obf-oai where final usage-only chunk has `choices: []` and `obfuscation: "pad_final_usage_only"`
    const rObf = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'obf-oai/claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }], tools }),
    });
    assert.equal(rObf.status, 200);
    const obfSse = await rObf.text();
    assert.match(obfSse, /obf ok/);
    assert.match(obfSse, /prompt_filter_results/, 'choices: [] chunk with non-padding payload (prompt_filter_results) is preserved when usage is stripped');
    assert.match(obfSse, /pad_chunk_1/, 'chunk with non-empty choices keeps its content and padding');
    assert.ok(!obfSse.includes('pad_final_usage_only'), 'final choices: [] usage-only chunk with obfuscation padding is dropped completely');
    assert.ok(!obfSse.includes('"usage"'), 'no usage field reaches client');

    // Check all 4 rows in usage.jsonl
    const rows = u.readAll();
    assert.equal(rows.length, 4);
    for (let i = 0; i < 3; i++) {
      assert.equal(rows[i].usage, null, `row ${i} usage is null in usage.jsonl`);
      assert.equal(typeof rows[i].usageReason, 'string');
      assert.equal(rows[i].cost.usd, null, `row ${i} cost.usd is null`);
      assert.equal(rows[i].cost.basis, 'unpriced', `row ${i} cost.basis is unpriced`);
      assert.equal(rows[i].cost.reason, rows[i].usageReason, `row ${i} cost.reason matches usageReason`);
    }
    assert.deepEqual(rows[3].usage, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(rows[3].cost, { usd: 0.007, basis: 'metered' });

    // With 3 unknown-usage rows and 1 known-usage row (obf-oai):
    // Unknown groups still have input: null, meteredUsd: null, listUsd: null, while totals sum ONLY the known row and report unknownUsage: 3 apart!
    for (const fromDays of [false, true]) {
      const mixed = u.query({ by: ['adapter'], fromDays });
      assert.equal(mixed.totals.requests, 4);
      assert.equal(mixed.totals.unknownUsage, 3);
      assert.equal(mixed.totals.input, 1000);
      assert.equal(mixed.totals.output, 500);
      assert.equal(mixed.totals.meteredUsd, 0.007);
      const rawGroup = mixed.groups.find((g) => g.adapter === 'raw-cli');
      assert.equal(rawGroup.requests, 2);
      assert.equal(rawGroup.unknownUsage, 2);
      assert.equal(rawGroup.input, null);
      assert.equal(rawGroup.listUsd, null);
      const uhpGroup = mixed.groups.find((g) => g.adapter === 'uhp-unk');
      assert.equal(uhpGroup.requests, 1);
      assert.equal(uhpGroup.unknownUsage, 1);
      assert.equal(uhpGroup.input, null);
      assert.equal(uhpGroup.meteredUsd, null);
    }
  } finally {
    srv.closeAllConnections?.();
    stub.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => stub.close(r));
  }
});

test('Round 7 fix round (MEDIUM & LOW 1): failed metered UHP tool legs (native uhp and auto->emulate fallback) and Traycer tool legs are priced at their own adapter basis on answering and error paths, charge spend state so limits.spend enforces caps on harnessrouter, and preserve unknown usage on the answering leg when failed legs have known usage', async () => {
  const { HTTP_PROFILES } = await import('../src/profiles.js');
  const fixDir = fs.mkdtempSync(path.join(tmpDir, 'r7-fix-'));
  const cliCwd = path.join(fixDir, 'cli-cwd');
  fs.mkdirSync(cliCwd, { recursive: true });

  // Stub CLI that reports known usage (`claude-json` parser) when answering or failing,
  // plus a `raw` CLI that reports no token counts (`usage_unknown`).
  const claudeCliBin = path.join(fixDir, 'claude-cli-stub');
  fs.writeFileSync(
    claudeCliBin,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
if (prompt.includes('CLI_FAIL')) {
  process.stderr.write('cli failed\\n');
  process.exit(1);
}
const reply = prompt.includes('# Tools') ? JSON.stringify({ final: 'cli tool answer' }) : 'cli plain answer';
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { id: 'msg_cli_1', content: [{ type: 'text', text: reply }] },
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  result: reply,
  usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}) + '\\n');
`,
    { mode: 0o755 },
  );

  const rawCliBin = path.join(fixDir, 'raw-cli-stub');
  fs.writeFileSync(
    rawCliBin,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const reply = prompt.includes('# Tools') ? JSON.stringify({ final: 'raw cli tool answer' }) : 'raw cli plain answer';
process.stdout.write(reply + '\\n');
`,
    { mode: 0o755 },
  );

  let hrUhpHits = 0;
  let hrAutoHits = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};

    // 1) Native UHP leg (`toolMode: 'uhp'`) that fails with `response.failed` after spending tokens
    // 1000 input (200 cached -> 800 uncached * $2/1M = $0.0016; 200 cached * $0.10/1M = $0.00002) + 500 output * $10/1M = $0.005 -> $0.00662
    if (req.url === '/hr-uhp/v1/responses') {
      hrUhpHits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_hr_fail_1', status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_hr_fail_1',
          status: 'failed',
          error: { message: 'uhp upstream failed after spending tokens' },
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 200 },
            output_tokens: 500,
            total_tokens: 1500,
          },
        },
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    // 2) Auto UHP leg (`toolMode: 'auto'`) that ignores `tools` on initial call (`uhp_tools_ignored`)
    // and then fails in EMULATE (returns invalid non-JSON prose twice, spending 500 in / 250 out with 100 cached each run -> total 1000 in, 500 out, 200 cacheRead -> $0.00662)
    if (req.url === '/hr-auto/v1/responses') {
      hrAutoHits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        res.write(`data: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_hr_ignored', status: 'in_progress', metadata: { ignored_fields: ['tools'] } },
        })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_hr_emu', status: 'in_progress' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'not valid emulate json' })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_hr_emu',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not valid emulate json' }] }],
          usage: {
            input_tokens: 500,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 250,
            total_tokens: 750,
          },
        },
      })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }

    // 3) Traycer leg that fails in EMULATE after spending 1000 in, 500 out, 200 cacheRead ($0.00662 listUsd)
    if (req.url === '/traycer/inference/anthropic/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_tr_fail' });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_tr_f', usage: { input_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } },
      })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'invalid prose' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 250 } })}\n\n`);
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }

    // 4) Second-leg OpenAI-wire HTTP upstream (`oai-second`) that answers tool requests verbatim
    // 500 input * $2/1M + 100 output * $10/1M = $0.002 metered
    if (req.url === '/oai/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_oai_2nd' });
      return res.end(JSON.stringify({
        id: 'chatcmpl_2nd',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'http second leg ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
      }));
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = upstream.address().port;

  const usageFile = path.join(fixDir, 'usage.jsonl');
  const cfg = {
    auth: { enabled: true, keys: [{ key: KEY_ADA, label: 'ada' }] },
    limits: {
      spend: {
        harnessrouter: 0.015,
      },
    },
    adapters: {
      harnessrouter: {
        ...HTTP_PROFILES.harnessrouter,
        baseUrl: `http://127.0.0.1:${port}/hr-uhp/v1`,
        toolMode: 'uhp',
        apiKey: '{env:HARNESSROUTER_API_KEY}',
        _rawKeyRef: '{env:HARNESSROUTER_API_KEY}',
        _apiKey: 'hr-secret',
        _apiKeyResolved: true,
        models: ['claude/claude-sonnet-5-5'],
      },
      'harnessrouter-auto': {
        ...HTTP_PROFILES.harnessrouter,
        baseUrl: `http://127.0.0.1:${port}/hr-auto/v1`,
        toolMode: 'auto',
        apiKey: '{env:HARNESSROUTER_AUTO_KEY}',
        _rawKeyRef: '{env:HARNESSROUTER_AUTO_KEY}',
        _apiKey: 'hr-auto-secret',
        _apiKeyResolved: true,
        models: ['claude/claude-sonnet-5-5'],
      },
      traycer: {
        ...HTTP_PROFILES.traycer,
        explicitOnly: false,
        baseUrl: `http://127.0.0.1:${port}/traycer`,
        apiKey: '{json:~/.traycer/cli/credentials#token}',
        _rawKeyRef: '{json:~/.traycer/cli/credentials#token}',
        _apiKey: 'tr-secret',
        _apiKeyResolved: true,
        models: ['anthropic/claude-sonnet-5-5'],
      },
      'oai-second': {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${port}/oai/v1`,
        apiKey: '{env:OAI_SECOND_KEY}',
        _rawKeyRef: '{env:OAI_SECOND_KEY}',
        _apiKey: 'oai-secret',
        _apiKeyResolved: true,
        models: ['claude-sonnet-5-5'],
      },
      'claude-cli': {
        kind: 'cli',
        bin: claudeCliBin,
        args: ['{prompt}'],
        parser: 'claude-stream-json',
        cwd: cliCwd,
        toolMode: 'emulate',
        models: ['claude-sonnet-5-5'],
      },
      'raw-cli': {
        kind: 'cli',
        bin: rawCliBin,
        args: ['{prompt}'],
        parser: 'raw',
        cwd: cliCwd,
        toolMode: 'emulate',
        models: ['claude-sonnet-5-5'],
      },
    },
    aliases: {
      'uhp-then-http': ['harnessrouter/claude/claude-sonnet-5-5', 'oai-second/claude-sonnet-5-5'],
      'emulate-then-cli': ['harnessrouter-auto/claude/claude-sonnet-5-5', 'claude-cli/claude-sonnet-5-5'],
      'traycer-then-http': ['traycer/anthropic/claude-sonnet-5-5', 'oai-second/claude-sonnet-5-5'],
      'uhp-then-fail': ['harnessrouter/claude/claude-sonnet-5-5', 'claude-cli/claude-sonnet-5-5'],
      'uhp-then-unknown': ['harnessrouter/claude/claude-sonnet-5-5', 'raw-cli/claude-sonnet-5-5'],
    },
  };
  const u = new UsageLog(usageFile);
  const spendOf = ({ adapter, account }) => {
    const st = u._ensureSpendMonth();
    return adapter ? (st.byAdapter.get(adapter) || 0) : (st.byAccount.get(account) || 0);
  };
  const gw = new Gateway(cfg, { usage: u });
  const srv = createServer(gw, cfg, { usage: u });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: `Bearer ${KEY_ADA}`, 'content-type': 'application/json' };
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];

  try {
    // 1) MEDIUM Case A: Native UHP tool leg (`harnessrouter`) fails ($0.00662 metered) -> HTTP second leg (`oai-second`) answers ($0.002 metered)
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'uhp-then-http', stream: false, messages: [{ role: 'user', content: 'test 1' }], tools }),
    });
    assert.equal(r1.status, 200);
    let rows = u.readAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].adapter, 'oai-second');
    assert.deepEqual(rows[0].usage, { input: 1500, output: 600, cacheRead: 200, cacheWrite: 0 });
    assert.deepEqual(rows[0].cost, { usd: 0.00862, basis: 'metered' });
    assert.equal(rows[0].failedLegs.length, 1);
    assert.equal(rows[0].failedLegs[0].target, 'harnessrouter/claude/claude-sonnet-5-5');
    assert.equal(rows[0].failedLegs[0].toolMode, 'uhp');
    assert.deepEqual(rows[0].failedLegs[0].cost, { usd: 0.00662, basis: 'metered' });
    assert.equal(rows[0].failedLegs[0].account, 'HARNESSROUTER_API_KEY');
    // Spend state tracks failed UHP leg under `harnessrouter` / `HARNESSROUTER_API_KEY`, and answering leg under `oai-second` / `OAI_SECOND_KEY`
    assert.equal(spendOf({ adapter: 'harnessrouter' }), 0.00662);
    assert.equal(spendOf({ account: 'HARNESSROUTER_API_KEY' }), 0.00662);
    assert.equal(spendOf({ adapter: 'oai-second' }), 0.002);
    assert.equal(spendOf({ account: 'OAI_SECOND_KEY' }), 0.002);

    // 2) MEDIUM Case B: UHP auto->emulate fallback tool leg (`harnessrouter-auto`) fails ($0.00662 metered) -> CLI second leg (`claude-cli`) answers ($0.002 listUsd)
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'emulate-then-cli', stream: false, messages: [{ role: 'user', content: 'test 2' }], tools }),
    });
    assert.equal(r2.status, 200);
    assert.equal(hrAutoHits, 3, '1 native UHP call (ignored tools) + 2 EMULATE attempts');
    rows = u.readAll();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].adapter, 'claude-cli');
    assert.equal(rows[1].kind, 'cli');
    // Failed metered UHP leg is priced as metered spend ($0.00662), NOT subscription listUsd; CLI leg is priced as subscription listUsd ($0.002)
    assert.deepEqual(rows[1].cost, { usd: 0.00662, basis: 'metered', listUsd: 0.002 });
    assert.equal(rows[1].failedLegs.length, 1);
    assert.equal(rows[1].failedLegs[0].target, 'harnessrouter-auto/claude/claude-sonnet-5-5');
    assert.equal(rows[1].failedLegs[0].toolMode, 'emulate');
    assert.equal(rows[1].failedLegs[0].fallback, 'uhp_tools_ignored');
    assert.deepEqual(rows[1].failedLegs[0].cost, { usd: 0.00662, basis: 'metered' });
    assert.equal(spendOf({ adapter: 'harnessrouter-auto' }), 0.00662);
    assert.equal(spendOf({ account: 'HARNESSROUTER_AUTO_KEY' }), 0.00662);
    assert.equal(spendOf({ adapter: 'claude-cli' }), 0);

    // 3) MEDIUM Case C: Subscription wire (`traycer`) fails in EMULATE ($0.00662 listUsd) -> HTTP second leg (`oai-second`) answers ($0.002 metered)
    const r3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'traycer-then-http', stream: false, messages: [{ role: 'user', content: 'test 3' }], tools }),
    });
    assert.equal(r3.status, 200);
    rows = u.readAll();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2].cost, { usd: 0.002, basis: 'metered', listUsd: 0.00662 });
    assert.deepEqual(rows[2].failedLegs[0].cost, { usd: 0, basis: 'subscription', listUsd: 0.00662 });
    assert.equal(spendOf({ adapter: 'traycer' }), 0);
    assert.equal(spendOf({ adapter: 'oai-second' }), 0.004);

    // 4) MEDIUM Case D (error path): `harnessrouter` fails ($0.00662 metered) and second leg (`claude-cli`) also fails (502)
    const r4 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'uhp-then-fail', stream: false, messages: [{ role: 'user', content: 'CLI_FAIL' }], tools }),
    });
    assert.equal(r4.status, 502);
    rows = u.readAll();
    assert.equal(rows.length, 4);
    assert.equal(rows[3].status, 'error');
    assert.deepEqual(rows[3].cost, { usd: 0.00662, basis: 'metered' });
    assert.deepEqual(rows[3].failedLegs[0].cost, { usd: 0.00662, basis: 'metered' });
    // `harnessrouter` has now spent $0.00662 + $0.00662 = $0.01324 across two failed legs
    assert.equal(spendOf({ adapter: 'harnessrouter' }), 0.01324);

    // 5) LOW 1: `harnessrouter` fails with known usage ($0.00662 metered) and answering leg (`raw-cli`) reports `usage_unknown`
    // This third failed leg also pushes `harnessrouter` spend to $0.01324 + $0.00662 = $0.01986 >= $0.015 cap!
    const r5 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'uhp-then-unknown', stream: false, messages: [{ role: 'user', content: 'test unknown' }], tools }),
    });
    assert.equal(r5.status, 200);
    rows = u.readAll();
    assert.equal(rows.length, 5);
    assert.equal(rows[4].adapter, 'raw-cli');
    assert.equal(typeof rows[4].usageReason, 'string');
    assert.match(rows[4].usageReason, /raw/);
    assert.deepEqual(rows[4].usage, { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 });
    assert.deepEqual(rows[4].cost, { usd: null, basis: 'unpriced', reason: rows[4].usageReason });
    assert.deepEqual(rows[4].failedLegs[0].cost, { usd: 0.00662, basis: 'metered' });
    assert.equal(spendOf({ adapter: 'harnessrouter' }), 0.01986);

    // `keysmith usage` must NOT count the unknown answering leg as 0 tokens:
    for (const fromDays of [false, true]) {
      const report = u.query({ by: ['adapter'], fromDays });
      const rawGroup = report.groups.find((g) => g.adapter === 'raw-cli');
      assert.ok(rawGroup, 'raw-cli group exists');
      assert.equal(rawGroup.requests, 1);
      assert.equal(rawGroup.unknownUsage, 1);
      assert.equal(rawGroup.input, null, 'unknown answering leg is not counted as 0 input tokens');
      assert.equal(rawGroup.output, null, 'unknown answering leg is not counted as 0 output tokens');
      assert.equal(rawGroup.meteredUsd, null, 'all-unknown group reports null meteredUsd, never 0');
      assert.equal(rawGroup.listUsd, null, 'all-unknown group reports null listUsd, never 0');
      assert.equal(report.totals.meteredUsd, 0.03048, 'totals.meteredUsd includes the failed metered leg from the unknown-answering row');
    }

    // 6) MEDIUM Spend cap enforcement: `harnessrouter` is now at $0.01986 >= $0.015 cap, so it refuses with 429 without hitting upstream again!
    const hitsBeforeCap = hrUhpHits;
    const r6 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'harnessrouter/claude/claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'should be capped' }], tools }),
    });
    assert.equal(r6.status, 429);
    assert.equal(hrUhpHits, hitsBeforeCap, 'upstream was not called once spend cap was reached from failed legs');
    const j6 = await r6.json();
    assert.match(j6.error.message, /spend cap reached for adapter "harnessrouter": spent \$0\.01986 of \$0\.015 monthly cap/);
  } finally {
    srv.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    await new Promise((r) => upstream.close(r));
  }
});
