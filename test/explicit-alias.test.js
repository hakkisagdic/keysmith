/**
 * Opt-in explicit-only alias chains (`aliasPolicy[name].allowExplicitOnly`), CLI `--allow-explicit-only`,
 * strict chain failover order with zero paid fall-through, `modelsOnly` + paid-leg `aliasIssues`,
 * and unconditional `unsafeTools` refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const LEGS = [
  'groq/openai/gpt-oss-120b',
  'mistral/codestral-latest',
  'cloudflare/@cf/meta/llama-3.1-8b-instruct-fast',
];

function makeSandbox(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-exp-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const baseCfg = {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: false, keys: [] },
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'http://127.0.0.1:1/groq/v1',
        apiKey: false,
        explicitOnly: true,
        modelsOnly: true,
        models: ['openai/gpt-oss-120b'],
      },
      mistral: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'http://127.0.0.1:1/mistral/v1',
        apiKey: false,
        explicitOnly: true,
        modelsOnly: true,
        models: ['codestral-latest'],
      },
      cloudflare: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'http://127.0.0.1:1/cloudflare/v1',
        apiKey: false,
        explicitOnly: true,
        modelsOnly: true,
        models: ['@cf/meta/llama-3.1-8b-instruct-fast'],
      },
      'paid-openai': {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'http://127.0.0.1:1/paid/v1',
        apiKey: false,
        models: ['gpt-5'],
      },
      'tool-cli': {
        kind: 'cli',
        bin: 'claude',
        args: ['{prompt}'],
        explicitOnly: true,
        unsafeTools: true,
      },
    },
    aliases: {},
    ...extra,
  };
  fs.writeFileSync(config, JSON.stringify(baseCfg, null, 2) + '\n', { mode: 0o600 });
  const env = { ...process.env, HOME: root, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  return { root, config, data, env, run, read };
}

test('CLI alias refuses explicitOnly legs without --allow-explicit-only, permits them with it, and still refuses unsafeTools', (t) => {
  const sb = makeSandbox(t);

  const denied = sb.run('alias', 'cheap-public', ...LEGS);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /explicit-only/);
  assert.match(denied.stderr, /--allow-explicit-only/);
  assert.equal(sb.read().aliases['cheap-public'], undefined);

  const ok = sb.run('alias', 'cheap-public', ...LEGS, '--allow-explicit-only');
  assert.equal(ok.status, 0, ok.stderr);
  const cfg = sb.read();
  assert.deepEqual(cfg.aliases['cheap-public'], LEGS);
  assert.equal(cfg.aliasPolicy?.['cheap-public']?.allowExplicitOnly, true);

  const shown = sb.run('alias', 'cheap-public');
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /\[explicit-only legs allowed\]/);

  const listed = sb.run('alias');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /cheap-public.*\[explicit-only legs allowed\]/);

  const dropFlag = sb.run('alias', 'cheap-public', '--no-allow-explicit-only');
  assert.notEqual(dropFlag.status, 0);
  assert.match(dropFlag.stderr, /explicit-only/);

  const unsafeDenied = sb.run('alias', 'bad-chain', 'tool-cli/sonnet', '--allow-explicit-only');
  assert.notEqual(unsafeDenied.status, 0);
  assert.match(unsafeDenied.stderr, /unsafeTools|can run commands/);
});

test('cheap-public tries only listed legs in order, never falls through outside chain, and isolates other aliases / unsafeTools / modelsOnly / paid checks', async (t) => {
  const statuses = { groq: 200, mistral: 200, cloudflare: 200, paid: 200 };
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const provider = req.url.split('/')[1];
      calls.push({ provider, model: body.model });
      const status = statuses[provider] ?? 500;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${provider} failed (${status})`, type: 'upstream_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chat-${provider}`,
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `from:${provider}:${body.model}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const cfg = {
    adapters: {
      groq: { kind: 'http', wire: 'openai', baseUrl: `${base}/groq/v1`, apiKey: false, explicitOnly: true, modelsOnly: true, models: ['openai/gpt-oss-120b'] },
      mistral: { kind: 'http', wire: 'openai', baseUrl: `${base}/mistral/v1`, apiKey: false, explicitOnly: true, modelsOnly: true, models: ['codestral-latest'] },
      cloudflare: { kind: 'http', wire: 'openai', baseUrl: `${base}/cloudflare/v1`, apiKey: false, explicitOnly: true, modelsOnly: true, models: ['@cf/meta/llama-3.1-8b-instruct-fast'] },
      'paid-openai': { kind: 'http', wire: 'openai', baseUrl: `${base}/paid/v1`, apiKey: false, explicitOnly: false, models: ['gpt-5'] },
      'tool-cli': { kind: 'cli', bin: 'claude', args: ['{prompt}'], explicitOnly: true, unsafeTools: true },
    },
    aliases: {
      'cheap-public': LEGS,
      'other-alias': ['groq/openai/gpt-oss-120b'],
      'unsafe-opted': ['tool-cli/sonnet'],
      'bad-model-chain': ['groq/unlisted-model'],
      'paid-chain': ['paid-openai/gpt-5'],
    },
    aliasPolicy: {
      'cheap-public': { allowExplicitOnly: true },
      'unsafe-opted': { allowExplicitOnly: true },
      'bad-model-chain': { allowExplicitOnly: true },
      'paid-chain': { allowExplicitOnly: true },
    },
    pricing: {
      'paid-openai/*': { input: 2.5, output: 10 },
    },
  };

  const gw = new Gateway(cfg);

  // 1) Leg 1 answers first.
  const r1 = await gw.collect({ model: 'cheap-public', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r1.text, 'from:groq:openai/gpt-oss-120b');

  // 2) Leg 1 429 -> Leg 2 answers.
  statuses.groq = 429;
  const r2 = await gw.collect({ model: 'cheap-public', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r2.text, 'from:mistral:codestral-latest');

  // 3) Leg 1 429 + Leg 2 503 -> Leg 3 answers.
  statuses.mistral = 503;
  const r3 = await gw.collect({ model: 'cheap-public', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r3.text, 'from:cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');

  // 4) All 3 fail -> chain exhausts in order, throws last error, and paid-openai is NEVER touched.
  statuses.groq = 500;
  statuses.mistral = 502;
  statuses.cloudflare = 503;
  const beforeAllFail = calls.length;
  await assert.rejects(
    () => gw.collect({ model: 'cheap-public', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => {
      assert.equal(e.status, 503);
      assert.match(e.message, /cloudflare failed/);
      return true;
    },
  );
  assert.deepEqual(
    calls.slice(beforeAllFail),
    [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'mistral', model: 'codestral-latest' },
      { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fast' },
    ],
  );
  assert.equal(calls.some((c) => c.provider === 'paid'), false, 'paid adapter must never be called');

  // 5) Other non-opted-in alias still refuses explicitOnly with 403.
  await assert.rejects(() => gw.collect({ model: 'other-alias', messages: [{ role: 'user', content: 'hi' }] }), { status: 403 });

  // 6) unsafeTools remains refused even if allowExplicitOnly is hand-edited on its alias.
  await assert.rejects(() => gw.collect({ model: 'unsafe-opted', messages: [{ role: 'user', content: 'hi' }] }), { status: 403 });

  // 7) modelsOnly still refuses unlisted models on an opted-in explicit chain.
  await assert.rejects(
    () => gw.collect({ model: 'bad-model-chain', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => {
      assert.match(e.message, /not one of the models named for groq/i);
      return true;
    },
  );

  // 8) aliasIssues checks: cheap-public is clean; other-alias, unsafe-opted, bad-model-chain, and paid-chain are all flagged.
  assert.equal(gw.aliasIssues['cheap-public'], undefined);
  assert.match((gw.aliasIssues['other-alias'] || []).join('\n'), /explicit-only/);
  assert.match((gw.aliasIssues['unsafe-opted'] || []).join('\n'), /unsafeTools/);
  assert.match((gw.aliasIssues['bad-model-chain'] || []).join('\n'), /modelsOnly/);
  assert.match((gw.aliasIssues['paid-chain'] || []).join('\n'), /priced\/paid/);
});
