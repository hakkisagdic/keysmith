import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoveredPath, writeDiscovered } from '../src/catalogue.js';
import { DEFAULT_HEALTH_TIMEOUT_MS } from '../src/http-adapter.js';
import { createMcpServer, createToolRegistry, loadBuiltInTools } from '../src/mcp.js';
import { UsageLog } from '../src/usage.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const cleanups = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
});

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-read-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { root, configFile, dataDir };
}

function writeConfig(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

async function callTool(server, name, args = {}, id = 1) {
  let reply = null;
  // Create a thin wrapper only when caller wants single-reply capture; callers pass shared replies[] otherwise.
  void reply;
  return await server.handle({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function makeFakeLauncher({ gwLoaded = true, gwPid = 42424, tunnelLoaded = false, tunnelPid = null } = {}) {
  const calls = [];
  const launchctl = (argv) => {
    calls.push(argv);
    if (argv[0] !== 'print') throw new Error(`unexpected launchctl command: ${argv[0]}`);
    const target = argv[1] || '';
    if (target.endsWith('/dev.keysmith.gateway')) {
      if (!gwLoaded) throw new Error('Could not find service');
      return gwPid ? `gui/501/dev.keysmith.gateway = {\n\tstate = running\n\tpid = ${gwPid}\n}\n` : 'gui/501/dev.keysmith.gateway = {\n\tstate = waiting\n}\n';
    }
    if (target.endsWith('/dev.keysmith.tunnel')) {
      if (!tunnelLoaded) throw new Error('Could not find service');
      return tunnelPid ? `gui/501/dev.keysmith.tunnel = {\n\tstate = running\n\tpid = ${tunnelPid}\n}\n` : 'gui/501/dev.keysmith.tunnel = {\n\tstate = waiting\n}\n';
    }
    throw new Error(`unknown label: ${target}`);
  };
  return { launchctl, calls };
}

test('loadBuiltInTools registers all 6 read-only tools and CLI exposes them in tools/list', async () => {
  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const tools = reg.list();
  const names = tools.map((t) => t.name);

  for (const expected of [
    'keysmith_status',
    'keysmith_sources',
    'keysmith_source_models',
    'keysmith_test',
    'keysmith_usage',
    'keysmith_approved',
  ]) {
    const def = tools.find((t) => t.name === expected);
    assert.ok(def, `${expected} is registered`);
    assert.deepEqual(def.annotations, { readOnlyHint: true, destructiveHint: false });
    assert.equal(def.inputSchema.type, 'object');
  }
  assert.equal(tools.filter((t) => t.annotations.readOnlyHint).length, 6);

  // Verify real CLI `keysmith mcp` stdio server exposes all 6 read tools within the exact 13-tool list and no keysmith_ping.
  const sb = makeSandbox();
  writeConfig(sb.configFile, { host: '127.0.0.1', port: 8787, auth: { enabled: true, keys: [] }, adapters: {}, aliases: {} });
  const env = { ...process.env, HOME: sb.root, KEYSMITH_CONFIG: sb.configFile, KEYSMITH_DATA: sb.dataDir };
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  proc.stdin.end();
  const code = await new Promise((resolve) => proc.on('close', resolve));
  assert.equal(code, 0, err);
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  const listedNames = msgs[1].result.tools.map((t) => t.name);
  assert.equal(listedNames.includes('keysmith_ping'), false);
  assert.equal(listedNames.length, 13);
  for (const expected of names) {
    assert.ok(listedNames.includes(expected), `CLI tools/list includes ${expected}`);
  }
});

test('keysmith_status reports launchd state, pid, port, /healthz result, and enabled counts without touching real gateway', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    host: '127.0.0.1',
    port: 18787,
    auth: { enabled: true, keys: [] },
    adapters: {
      a1: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_KEY_1}' },
      a2: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_KEY_2}', disabled: true },
      a3: { kind: 'cli', bin: 'echo', args: ['{prompt}'], parser: 'raw' },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);

  // Case 1: gateway not running -> fake fetch must NEVER be called (never probes real port 8787/18787).
  let fetchCalls = 0;
  const replies = [];
  const offLauncher = makeFakeLauncher({ gwLoaded: false, gwPid: null });
  const offServer = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      launchctl: offLauncher.launchctl,
      isPidAlive: () => false,
      fetch: async () => {
        fetchCalls++;
        throw new Error('fetch must not run when gateway is stopped');
      },
    },
  });
  await callTool(offServer, 'keysmith_status', {}, 1);
  assert.equal(fetchCalls, 0);
  const offOut = replies[0].result.structuredContent;
  assert.equal(offOut.ok, true);
  assert.equal(offOut.running, false);
  assert.equal(offOut.pid, null);
  assert.equal(offOut.port, 18787);
  assert.equal(offOut.enabledSources, 2);
  assert.equal(offOut.disabledSources, 1);
  assert.equal(offOut.totalSources, 3);
  assert.equal(offOut.launchd.state, 'not_loaded');
  assert.equal(offOut.healthz.reachable, false);
  assert.equal(offOut.healthz.reason, 'not_running');

  // Case 2: gateway running via pidfile + launchd, fake /healthz returns safe health fields + extra ignored secret.
  fs.writeFileSync(path.join(sb.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 51515, port: 19999 }), { mode: 0o600 });
  const onLauncher = makeFakeLauncher({ gwLoaded: true, gwPid: 51515, tunnelLoaded: true, tunnelPid: 51516 });
  const healthUrls = [];
  const onReplies = [];
  const onServer = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => onReplies.push(m),
    context: {
      launchctl: onLauncher.launchctl,
      isPidAlive: (pid) => pid === 51515,
      fetch: async (url) => {
        healthUrls.push(url);
        return new Response(
          JSON.stringify({
            ok: true,
            uptime_s: 120,
            adapters: 2,
            failed_to_load: 0,
            alias_warnings: 1,
            internalSecretField: 'HEALTHZ_EXTRA_SHOULD_BE_DROPPED',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });

  await callTool(onServer, 'keysmith_status', {}, 2);
  assert.deepEqual(healthUrls, ['http://127.0.0.1:19999/healthz']);
  const onOut = onReplies[0].result.structuredContent;
  assert.equal(onOut.running, true);
  assert.equal(onOut.pid, 51515);
  assert.equal(onOut.port, 19999);
  assert.equal(onOut.launchd.state, 'running');
  assert.equal(onOut.launchd.loaded, true);
  assert.equal(onOut.launchd.pid, 51515);
  assert.equal(onOut.launchd.tunnel.loaded, true);
  assert.equal(onOut.launchd.tunnel.pid, 51516);
  assert.deepEqual(onOut.healthz, {
    ok: true,
    reachable: true,
    httpStatus: 200,
    uptimeSeconds: 120,
    adapters: 2,
    failedToLoad: 0,
    aliasWarnings: 1,
  });
  assert.equal(JSON.stringify(onReplies).includes('HEALTHZ_EXTRA_SHOULD_BE_DROPPED'), false);
});

test('keysmith_sources reports metadata, keyRefType, Keychain existence, and sanitized baseUrl', async () => {
  const sb = makeSandbox();
  const cfAcct = '00112233445566778899aabbccddeeff';
  writeConfig(sb.configFile, {
    adapters: {
      kc_present: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{exec:/usr/bin/security find-generic-password -s fake-present-svc -a keysmith -w}',
        explicitOnly: true,
        modelsOnly: true,
        models: ['model-1', { id: 'model-2' }],
      },
      kc_missing: {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: 'https://api.example.invalid/v1/',
        apiKey: '{exec:/usr/bin/security find-generic-password -s fake-missing-svc -a keysmith -w}',
        disabled: true,
      },
      cf_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfAcct}/ai/v1?secret=query123`,
        accountId: cfAcct,
        apiKey: `{json:${path.join(sb.root, 'auth.json')}#cf.token}`,
        models: { '@cf/model-a': { maxTokens: 1024 } },
      },
      file_src: {
        kind: 'http',
        baseUrl: 'https://user:pass@api.example.invalid/v1',
        apiKey: `{file:${path.join(sb.root, 'tok.txt')}}`,
        freeOnly: true,
      },
      dotenv_src: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{dotenv:${path.join(sb.root, '.env')}#PROVIDER_KEY}`,
      },
      env_src: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:EXAMPLE_PUBLIC_ENV_VAR}',
      },
      cli_src: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        models: ['cli-m1'],
      },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const kcChecks = [];
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      keychainHas: async (service, account) => {
        kcChecks.push({ service, account });
        return service === 'fake-present-svc' && account === 'keysmith';
      },
    },
  });

  await callTool(server, 'keysmith_sources', {}, 1);
  await callTool(server, 'keysmith_sources', { includeDisabled: false }, 2);

  assert.deepEqual(kcChecks, [
    { service: 'fake-present-svc', account: 'keysmith' },
    { service: 'fake-missing-svc', account: 'keysmith' },
    { service: 'fake-present-svc', account: 'keysmith' },
  ]);

  const all = replies[0].result.structuredContent;
  assert.equal(all.ok, true);
  assert.equal(all.sources.length, 7);
  assert.ok(Array.isArray(all.profiles) && all.profiles.some((p) => p.id === 'groq'));

  const byId = Object.fromEntries(all.sources.map((s) => [s.id, s]));
  assert.deepEqual(byId.kc_present, {
    id: 'kc_present',
    kind: 'http',
    wire: 'openai',
    baseUrl: 'https://api.example.invalid/v1',
    disabled: false,
    explicitOnly: true,
    modelsOnly: true,
    freeOnly: false,
    modelCount: 2,
    keyRefType: 'exec',
    keychainExists: 'yes',
  });
  assert.equal(byId.kc_missing.disabled, true);
  assert.equal(byId.kc_missing.wire, 'anthropic');
  assert.equal(byId.kc_missing.keyRefType, 'exec');
  assert.equal(byId.kc_missing.keychainExists, 'no');

  assert.equal(byId.cf_src.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/[redacted]/ai/v1');
  assert.equal(byId.cf_src.keyRefType, 'json');
  assert.equal(byId.cf_src.keychainExists, 'no');
  assert.equal(byId.cf_src.modelCount, 1);

  assert.equal(byId.file_src.baseUrl, 'https://api.example.invalid/v1');
  assert.equal(byId.file_src.keyRefType, 'file');
  assert.equal(byId.file_src.freeOnly, true);

  assert.equal(byId.dotenv_src.keyRefType, 'dotenv');
  assert.equal(byId.env_src.keyRefType, 'env');
  assert.equal(byId.cli_src.kind, 'cli');
  assert.equal(byId.cli_src.wire, null);
  assert.equal(byId.cli_src.baseUrl, null);
  assert.equal(byId.cli_src.keyRefType, 'none');
  assert.equal(byId.cli_src.keychainExists, 'no');

  const activeOnly = replies[1].result.structuredContent;
  assert.equal(activeOnly.sources.length, 6);
  assert.equal(activeOnly.sources.some((s) => s.id === 'kc_missing'), false);
});

test('keysmith_source_models returns approved flags and discovered free diff, or empty diff with reason when unavailable', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    discovery: { enabled: true },
    adapters: {
      tr: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:TR_KEY}',
        modelsOnly: true,
        models: ['free/shared', 'paid/pinned-only'],
      },
      nodisc: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:ND_KEY}',
        modelsOnly: false,
        models: ['m1'],
      },
      clitool: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        models: ['cli-a'],
      },
    },
  });
  writeDiscovered(discoveredPath(sb.dataDir, 'tr'), ['free/shared', 'free/new-discovered']);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
  });

  await callTool(server, 'keysmith_source_models', { source: 'tr' }, 1);
  await callTool(server, 'keysmith_source_models', { source: 'nodisc' }, 2);
  await callTool(server, 'keysmith_source_models', { source: 'clitool' }, 3);
  await callTool(server, 'keysmith_source_models', { source: 'missing-source' }, 4);

  const trOut = replies[0].result.structuredContent;
  assert.equal(trOut.ok, true);
  assert.equal(trOut.modelsOnly, true);
  assert.deepEqual(trOut.configuredModels, ['free/shared', 'paid/pinned-only']);
  assert.deepEqual(trOut.models, [
    { id: 'free/shared', approved: true, status: 'approved', configured: true, discoveredFree: true },
    { id: 'paid/pinned-only', approved: true, status: 'approved', configured: true, discoveredFree: false },
    { id: 'free/new-discovered', approved: false, status: 'unapproved', configured: false, discoveredFree: true },
  ]);
  assert.equal(trOut.discovery.available, true);
  assert.deepEqual(trOut.discovery.discoveredFree, ['free/shared', 'free/new-discovered']);
  assert.deepEqual(trOut.discovery.diff, {
    onlyInDiscovered: ['free/new-discovered'],
    onlyInModels: ['paid/pinned-only'],
  });

  const ndOut = replies[1].result.structuredContent;
  assert.equal(ndOut.ok, true);
  assert.deepEqual(ndOut.models, [
    { id: 'm1', approved: false, status: 'unapproved', configured: true, discoveredFree: null },
  ]);
  assert.equal(ndOut.discovery.available, false);
  assert.match(ndOut.discovery.message, /no discovered free list/i);
  assert.deepEqual(ndOut.discovery.discoveredFree, []);
  assert.deepEqual(ndOut.discovery.diff, { onlyInDiscovered: [], onlyInModels: [] });

  const cliOut = replies[2].result.structuredContent;
  assert.equal(cliOut.discovery.available, false);
  assert.match(cliOut.discovery.message, /CLI sources/i);
  assert.deepEqual(cliOut.discovery.discoveredFree, []);

  assert.equal(replies[3].result.isError, true);
  assert.equal(replies[3].result.structuredContent.ok, false);
});

test('keysmith_test probes one source with latency and status without reading or returning HTTP bodies', async () => {
  const sb = makeSandbox();
  const cfAcct = 'abcdef0123456789abcdef0123456789';
  writeConfig(sb.configFile, {
    adapters: {
      healthy: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{exec:/usr/bin/security find-generic-password -s fake-ok-svc -a keysmith -w}',
      },
      unauth: {
        kind: 'http',
        wire: 'anthropic',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:TEST_ANTHROPIC_KEY}',
      },
      down: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfAcct}/ai/v1`,
        accountId: cfAcct,
        apiKey: 'tok_fakeDownKey1234567890',
      },
      missing_kc: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{exec:/usr/bin/security find-generic-password -s missing-kc-svc -a keysmith -w}',
      },
      off: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:OFF_KEY}',
        disabled: true,
      },
      bad_cfg: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        modelParams: 'not-an-object',
      },
      cli_ok: {
        kind: 'cli',
        bin: 'fake-cli-bin',
        args: ['{prompt}'],
        parser: 'raw',
      },
      cli_missing: {
        kind: 'cli',
        bin: 'missing-cli-bin',
        args: ['{prompt}'],
        parser: 'raw',
      },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const requests = [];
  let bodyCancelled = false;
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      env: { TEST_ANTHROPIC_KEY: 'ant_fakeTestSecretKey987654' },
      keychainHas: async (svc) => svc === 'fake-ok-svc',
      keychainRead: async (svc) => (svc === 'fake-ok-svc' ? 'kc_fakeResolvedToken998877' : ''),
      which: (bin) => (bin === 'fake-cli-bin' ? '/fake/bin/fake-cli-bin' : null),
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers });
        if (url.includes(cfAcct)) {
          throw new Error(`connect failed for https://api.cloudflare.com/client/v4/accounts/${cfAcct}/ai/v1/models`);
        }
        if (init.headers['x-api-key']) {
          return {
            ok: false,
            status: 401,
            body: { cancel: async () => {} },
            text: async () => {
              throw new Error('response body must not be read');
            },
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            cancel: async () => {
              bodyCancelled = true;
            },
          },
          text: async () => {
            throw new Error('response body must not be read');
          },
          json: async () => {
            throw new Error('response body must not be read');
          },
        };
      },
    },
  });

  await callTool(server, 'keysmith_test', { source: 'healthy' }, 1);
  await callTool(server, 'keysmith_test', { source: 'unauth' }, 2);
  await callTool(server, 'keysmith_test', { source: 'down' }, 3);
  await callTool(server, 'keysmith_test', { source: 'missing_kc' }, 4);
  await callTool(server, 'keysmith_test', { source: 'off' }, 5);
  await callTool(server, 'keysmith_test', { source: 'bad_cfg' }, 6);
  await callTool(server, 'keysmith_test', { source: 'cli_ok' }, 7);
  await callTool(server, 'keysmith_test', { source: 'cli_missing' }, 8);

  assert.equal(requests.length, 3, 'disabled, invalid, missing_kc, and cli sources did not trigger HTTP fetch');
  assert.equal(requests[0].headers.authorization, 'Bearer kc_fakeResolvedToken998877');
  assert.equal(requests[1].headers['x-api-key'], 'ant_fakeTestSecretKey987654');
  assert.equal(bodyCancelled, true, 'HTTP response body stream cancelled without reading');

  const rHealthy = replies[0].result.structuredContent;
  assert.equal(rHealthy.ok, true);
  assert.equal(rHealthy.status, 'ok');
  assert.equal(rHealthy.httpStatus, 200);
  assert.equal(typeof rHealthy.latencyMs, 'number');

  assert.equal(replies[1].result.structuredContent.ok, false);
  assert.equal(replies[1].result.structuredContent.status, 'unauthorized');
  assert.equal(replies[1].result.structuredContent.httpStatus, 401);

  assert.equal(replies[2].result.structuredContent.ok, false);
  assert.equal(replies[2].result.structuredContent.status, 'unreachable');
  assert.equal(JSON.stringify(replies[2]).includes(cfAcct), false);

  assert.equal(replies[3].result.structuredContent.status, 'missing_credentials');
  assert.equal(replies[4].result.structuredContent.status, 'disabled');
  assert.equal(replies[5].result.structuredContent.status, 'invalid_config');
  assert.equal(replies[6].result.structuredContent.ok, true);
  assert.equal(replies[6].result.structuredContent.status, 'ok');
  assert.equal(JSON.stringify(replies[6]).includes('/fake/bin/fake-cli-bin'), false);
  assert.equal(replies[7].result.structuredContent.ok, false);
  assert.equal(replies[7].result.structuredContent.status, 'binary_missing');
});

test('keysmith_usage reports per-source requests, tokens, spend, and remaining headroom to limits.spend', async () => {
  const sb = makeSandbox();
  const fixedNow = Date.parse('2026-11-18T12:00:00.000Z');
  const kcSecretService = 'kc-usage-service-secret-99';

  writeConfig(sb.configFile, {
    limits: {
      spend: {
        groq: 10,
        promo: { usd: 25, since: '2026-11-01', until: '2026-12-01' },
        [`account:${kcSecretService}`]: 15,
      },
    },
    adapters: {
      groq: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
      },
      promo: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:PROMO_KEY}',
      },
      kc_capped: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{exec:/usr/bin/security find-generic-password -s ${kcSecretService} -a keysmith -w}`,
      },
      uncapped: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:UNCAPPED_KEY}',
      },
    },
  });

  const usage = new UsageLog(path.join(sb.dataDir, 'usage.jsonl'), { now: () => fixedNow });
  usage.record({
    ts: '2026-11-10T10:00:00.000Z',
    adapter: 'groq',
    kind: 'http',
    model: 'groq/llama-3.1-8b',
    status: 'ok',
    ms: 50,
    usage: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 0 },
    cost: { usd: 2.5, basis: 'metered', listUsd: 2.5 },
  });
  usage.record({
    ts: '2026-11-11T10:00:00.000Z',
    adapter: 'groq',
    kind: 'http',
    model: 'groq/llama-3.1-8b',
    status: 'error',
    ms: 30,
    usage: { input: 200, output: 0 },
    cost: { usd: 0.5, basis: 'metered', listUsd: 0.5 },
  });
  usage.record({
    ts: '2026-11-12T10:00:00.000Z',
    adapter: 'promo',
    kind: 'http',
    model: 'promo/model-x',
    status: 'ok',
    ms: 80,
    usage: { input: 3000, output: 1000 },
    cost: { usd: 7, basis: 'metered', listUsd: 7 },
  });
  usage.record({
    ts: '2026-11-12T11:00:00.000Z',
    adapter: 'kc_capped',
    account: kcSecretService,
    kind: 'http',
    model: 'kc_capped/m1',
    status: 'ok',
    ms: 40,
    usage: { input: 500, output: 250 },
    cost: { usd: 4, basis: 'metered', listUsd: 4 },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { now: () => fixedNow },
  });

  await callTool(server, 'keysmith_usage', {}, 1);
  await callTool(server, 'keysmith_usage', { source: 'groq' }, 2);

  const full = replies[0].result.structuredContent;
  assert.equal(full.ok, true);
  assert.equal(full.totals.requests, 4);
  assert.equal(full.totals.failures, 1);
  assert.equal(full.totals.tokens.total, 6450);
  assert.equal(full.totals.spendUsd, 14);

  const byId = Object.fromEntries(full.sources.map((s) => [s.id, s]));
  assert.equal(byId.groq.requests, 2);
  assert.equal(byId.groq.failures, 1);
  assert.equal(byId.groq.tokens.input, 1200);
  assert.equal(byId.groq.tokens.output, 500);
  assert.equal(byId.groq.tokens.total, 1700);
  assert.equal(byId.groq.spendUsd, 3);
  assert.equal(byId.groq.remainingHeadroomUsd, 7);
  assert.equal(byId.groq.spendCap.scope, 'adapter');
  assert.equal(byId.groq.spendCap.capUsd, 10);
  assert.equal(byId.groq.spendCap.remainingUsd, 7);

  assert.equal(byId.promo.requests, 1);
  assert.equal(byId.promo.spendUsd, 7);
  assert.equal(byId.promo.remainingHeadroomUsd, 18);
  assert.equal(byId.promo.spendCap.windowStatus, 'open');

  assert.equal(byId.kc_capped.spendUsd, 4);
  assert.equal(byId.kc_capped.remainingHeadroomUsd, 11);
  assert.equal(byId.kc_capped.spendCap.scope, 'account');
  assert.equal(JSON.stringify(replies[0]).includes(kcSecretService), false, 'account target (keychain service) never leaked');

  assert.equal(byId.uncapped.requests, 0);
  assert.equal(byId.uncapped.remainingHeadroomUsd, null);
  assert.equal(byId.uncapped.spendCap, null);

  const filtered = replies[1].result.structuredContent;
  assert.equal(filtered.sources.length, 1);
  assert.equal(filtered.sources[0].id, 'groq');
  assert.equal(filtered.totals.requests, 2);
});

test('keysmith_approved returns approved source -> models mapping and empty pending array', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
        modelsOnly: true,
        models: ['llama-3.1-8b-instant', { id: 'llama-3.3-70b' }],
      },
      tokenrouter: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:TR_KEY}',
        freeOnly: true,
        models: ['not-models-only-entry'],
      },
      mistral: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:MISTRAL_KEY}',
        modelsOnly: true,
        models: { 'mistral-small-latest': {} },
      },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
  });

  await callTool(server, 'keysmith_approved', {}, 1);
  await callTool(server, 'keysmith_approved', { source: 'groq' }, 2);

  assert.deepEqual(replies[0].result.structuredContent, {
    ok: true,
    configLoaded: true,
    approved: {
      groq: ['llama-3.1-8b-instant', 'llama-3.3-70b'],
      mistral: ['mistral-small-latest'],
    },
    note: 'Approved model lists are enforced only on HTTP sources; list is not enforced for CLI sources.',
    pending: [],
  });
  assert.deepEqual(replies[1].result.structuredContent.approved, {
    groq: ['llama-3.1-8b-instant', 'llama-3.3-70b'],
  });
});

test('redaction: none of the 6 read tools leak fake secrets, key ref interiors, auth.keys, accountId, workspaceFiles, or HTTP bodies', async () => {
  const sb = makeSandbox();
  const mintedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const scopedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const literalKey = 'tok_' + 'fakeReadSliceLiteralSecret9911';
  const bearerHeader = 'hdr_' + 'fakeReadSliceBearerSecret8822';
  const envSecret = 'env_' + 'fakeReadSliceEnvSecret7733';
  const kcResolved = 'kc_' + 'fakeReadSliceKeychainResolved6644';
  const kcSvc = 'fake-read-kc-svc-550';
  const kcAcct = 'fake-read-kc-acct-551';
  const execInner = `/usr/bin/security find-generic-password -s ${kcSvc} -a ${kcAcct} -w`;
  const jsonFile = path.join(sb.root, 'creds-552.json');
  const jsonField = 'provider.nestedSecretToken';
  const jsonValue = 'json_fakeReadSliceSecret552';
  const filePath = path.join(sb.root, 'token-553.txt');
  const fileValue = 'file_fakeReadSliceSecret553';
  const dotenvPath = path.join(sb.root, '.env.554');
  const dotenvVar = 'DOTENV_FAKE_READ_VAR_554';
  const dotenvValue = 'dotenv_fakeReadSliceSecret554';
  const cfAccountId = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
  const wsContent = 'WS_READ_SLICE_SECRET_555_NEVER_LEAK';
  const healthBodySecret = 'HEALTH_BODY_SECRET_556_NEVER_LEAK';
  const modelsBodySecret = 'MODELS_BODY_SECRET_557_NEVER_LEAK';

  fs.writeFileSync(jsonFile, JSON.stringify({ provider: { nestedSecretToken: jsonValue } }), { mode: 0o600 });
  fs.writeFileSync(filePath, fileValue + '\n', { mode: 0o600 });
  fs.writeFileSync(dotenvPath, `${dotenvVar}=${dotenvValue}\n`, { mode: 0o600 });

  const cfg = {
    host: '127.0.0.1',
    port: 19797,
    discovery: { enabled: true },
    limits: { spend: { lit_src: 10, [`account:${kcSvc}`]: 20 } },
    auth: {
      enabled: true,
      keys: [mintedKey, { key: scopedKey, label: 'read-test', allow: ['lit_src'] }],
    },
    adapters: {
      kc_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{exec:${execInner}}`,
        modelsOnly: true,
        models: ['m-kc'],
      },
      cf_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1`,
        accountId: cfAccountId,
        apiKey: `{json:${jsonFile}#${jsonField}}`,
        modelsOnly: true,
        models: ['m-cf'],
      },
      file_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{file:${filePath}}`,
      },
      dotenv_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{dotenv:${dotenvPath}#${dotenvVar}}`,
      },
      lit_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: literalKey,
        headers: { Authorization: `Bearer ${bearerHeader}` },
        env: { UPSTREAM_API_SECRET: envSecret },
      },
      cli_src: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        workspaceFiles: { '.kiro/agents/test.json': wsContent },
      },
    },
  };
  writeConfig(sb.configFile, cfg);
  const rawConfigBefore = fs.readFileSync(sb.configFile, 'utf8');

  fs.writeFileSync(path.join(sb.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 61616, port: 19797 }), { mode: 0o600 });
  writeDiscovered(discoveredPath(sb.dataDir, 'kc_src'), ['m-kc', 'm-kc-extra']);

  const secCalled = path.join(sb.root, 'security-called');
  const secBin = path.join(sb.root, 'fake-security');
  fs.writeFileSync(secBin, `#!/bin/sh\ntouch "${secCalled}"\necho "SHOULD_NOT_RUN"\nexit 0\n`, { mode: 0o755 });

  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  process.env.KEYSMITH_SECURITY_BIN = secBin;

  try {
    const reg = createToolRegistry();
    await loadBuiltInTools(reg);
    const launcher = makeFakeLauncher({ gwLoaded: true, gwPid: 61616 });
    const replies = [];

    const server = createMcpServer({
      registry: reg,
      configFile: sb.configFile,
      dataDir: sb.dataDir,
      send: (m) => replies.push(m),
      context: {
        launchctl: launcher.launchctl,
        isPidAlive: (p) => p === 61616,
        keychainHas: async (svc, acct) => svc === kcSvc && acct === kcAcct,
        keychainRead: async (svc, acct) => (svc === kcSvc && acct === kcAcct ? kcResolved : ''),
        which: () => '/fake/bin/echo',
        fetch: async (url) => {
          if (url.endsWith('/healthz')) {
            return new Response(JSON.stringify({ ok: true, uptime_s: 5, adapters: 6, secretLeak: healthBodySecret }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.includes(cfAccountId)) {
            throw new Error(`network failure at https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1/models token=${jsonValue}`);
          }
          return {
            ok: true,
            status: 200,
            body: { cancel: async () => {} },
            text: async () => modelsBodySecret,
            json: async () => ({ secret: modelsBodySecret }),
          };
        },
      },
    });

    await callTool(server, 'keysmith_status', {}, 1);
    await callTool(server, 'keysmith_sources', {}, 2);
    await callTool(server, 'keysmith_source_models', { source: 'kc_src' }, 3);
    await callTool(server, 'keysmith_test', { source: 'kc_src' }, 4);
    await callTool(server, 'keysmith_test', { source: 'cf_src' }, 5);
    await callTool(server, 'keysmith_test', { source: 'file_src' }, 6);
    await callTool(server, 'keysmith_test', { source: 'dotenv_src' }, 7);
    await callTool(server, 'keysmith_test', { source: 'lit_src' }, 8);
    await callTool(server, 'keysmith_usage', {}, 9);
    await callTool(server, 'keysmith_approved', {}, 10);

    const dump = JSON.stringify(replies);
    const forbidden = [
      mintedKey,
      scopedKey,
      literalKey,
      bearerHeader,
      envSecret,
      kcResolved,
      kcSvc,
      kcAcct,
      execInner,
      jsonFile,
      jsonField,
      jsonValue,
      filePath,
      fileValue,
      dotenvPath,
      dotenvVar,
      dotenvValue,
      cfAccountId,
      wsContent,
      healthBodySecret,
      modelsBodySecret,
    ];

    for (const secret of forbidden) {
      assert.equal(dump.includes(secret), false, `secret leaked in read tool output: ${secret}`);
    }

    // Config stays byte-for-byte unchanged, no backups created, real Keychain binary never touched.
    assert.equal(fs.readFileSync(sb.configFile, 'utf8'), rawConfigBefore);
    assert.deepEqual(fs.readdirSync(sb.root).filter((f) => f.includes('.bak-')), []);
    assert.equal(fs.existsSync(secCalled), false, 'real/env Keychain binary was never executed');
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
  }
});

test('keysmith_approved and keysmith_source_models do not present CLI sources as having an enforced approved list', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
        modelsOnly: true,
        models: ['llama-3.1-8b-instant'],
      },
      kiro: {
        kind: 'cli',
        bin: 'kiro-cli',
        args: ['{prompt}'],
        parser: 'raw',
        modelsOnly: true,
        freeOnly: true,
        models: ['claude-sonnet-4'],
      },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
  });

  await callTool(server, 'keysmith_approved', {}, 1);
  await callTool(server, 'keysmith_approved', { source: 'kiro' }, 2);
  await callTool(server, 'keysmith_source_models', { source: 'kiro' }, 3);
  await callTool(server, 'keysmith_source_models', { source: 'groq' }, 4);

  const allApproved = replies[0].result.structuredContent;
  assert.deepEqual(allApproved.approved, { groq: ['llama-3.1-8b-instant'] });
  assert.equal(Object.hasOwn(allApproved.approved, 'kiro'), false);
  assert.deepEqual(allApproved.unenforcedCliSources, ['kiro']);
  assert.match(allApproved.note, /not enforced for CLI sources/i);
  assert.equal(allApproved.enforced, undefined);
  assert.deepEqual(allApproved.pending, []);

  const kiroApproved = replies[1].result.structuredContent;
  assert.deepEqual(kiroApproved.approved, {});
  assert.equal(kiroApproved.kind, 'cli');
  assert.equal(kiroApproved.enforced, false);
  assert.deepEqual(kiroApproved.unenforcedCliSources, ['kiro']);
  assert.match(kiroApproved.note, /not enforced for CLI sources/i);
  assert.deepEqual(kiroApproved.pending, []);

  const kiroModels = replies[2].result.structuredContent;
  assert.equal(kiroModels.ok, true);
  assert.equal(kiroModels.kind, 'cli');
  assert.equal(kiroModels.enforced, false);
  assert.equal(kiroModels.modelsOnly, false);
  assert.equal(kiroModels.freeOnly, false);
  assert.match(kiroModels.note, /not enforced for CLI sources/i);
  assert.deepEqual(kiroModels.models, [
    { id: 'claude-sonnet-4', approved: false, status: 'not_enforced', configured: true, discoveredFree: null },
  ]);

  const groqModels = replies[3].result.structuredContent;
  assert.equal(groqModels.kind, 'http');
  assert.equal(groqModels.enforced, true);
  assert.equal(groqModels.modelsOnly, true);
  assert.equal(groqModels.models[0].approved, true);
  assert.equal(groqModels.note, undefined);
});

async function startHealthServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    try {
      server.closeAllConnections?.();
      server.close();
    } catch {}
  });
  return { server, port, baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function getClosedPort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, all: `${stdout}\n${stderr}` }));
  });
}

test('keysmith_test uses per-profile health path (Cloudflare token verify), respects explicit healthPath, never POSTs or reads bodies', async (t) => {
  assert.equal(DEFAULT_HEALTH_TIMEOUT_MS, 15_000);
  const sb = makeSandbox();
  const cfAcct = 'cfae0123456789ab' + 'cdef0123456789ab';
  const cfToken = 'tok_' + 'cloudflare_secret_987654';
  const bodySecret = 'ks_' + 'BodySecretValueNeverShown1234';
  const prevCfEnv = process.env.TEST_CF_HEALTH_KEY;
  process.env.TEST_CF_HEALTH_KEY = cfToken;
  t.after(() => {
    if (prevCfEnv === undefined) delete process.env.TEST_CF_HEALTH_KEY;
    else process.env.TEST_CF_HEALTH_KEY = prevCfEnv;
  });

  const srv = await startHealthServer(t, (req, res) => {
    if (req.url === `/client/v4/accounts/${cfAcct}/ai/v1/models`) {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.url === `/client/v4/accounts/${cfAcct}/tokens/verify`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { status: 'active' }, secret: bodySecret }));
      return;
    }
    if (req.url === `/client/v4/accounts/${cfAcct}/ai/v1/custom-ping`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  writeConfig(sb.configFile, {
    adapters: {
      cf_live: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `${srv.baseUrl}/client/v4/accounts/${cfAcct}/ai/v1`,
        apiKey: '{env:TEST_CF_HEALTH_KEY}',
        models: ['@cf/meta/llama-3.1-8b-instruct-fast'],
      },
      cf_override: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `${srv.baseUrl}/client/v4/accounts/${cfAcct}/ai/v1`,
        apiKey: '{env:TEST_CF_HEALTH_KEY}',
        healthPath: '/custom-ping',
        models: ['@cf/meta/llama-3.1-8b-instruct-fast'],
      },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
  });

  await callTool(server, 'keysmith_test', { source: 'cf_live' }, 1);
  await callTool(server, 'keysmith_test', { source: 'cf_override' }, 2);

  const cfRes = replies[0].result.structuredContent;
  assert.equal(cfRes.ok, true);
  assert.equal(cfRes.status, 'ok');
  assert.equal(cfRes.httpStatus, 200);
  const ovRes = replies[1].result.structuredContent;
  assert.equal(ovRes.ok, true);
  assert.equal(ovRes.status, 'ok');

  assert.deepEqual(srv.requests, [
    { method: 'GET', url: `/client/v4/accounts/${cfAcct}/tokens/verify` },
    { method: 'GET', url: `/client/v4/accounts/${cfAcct}/ai/v1/custom-ping` },
  ]);
  const serialized = JSON.stringify(replies);
  assert.equal(serialized.includes(cfAcct), false, 'account ID must not appear in output');
  assert.equal(serialized.includes(cfToken), false, 'API key must not appear in output');
  assert.equal(serialized.includes(bodySecret), false, 'HTTP response body must never be read or returned');

  // Verify response stream is cancelled unread when a body stream is present.
  let cancelled = false;
  let bodyRead = false;
  const regMock = createToolRegistry();
  await loadBuiltInTools(regMock);
  const mockReplies = [];
  const mockServer = createMcpServer({
    registry: regMock,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => mockReplies.push(m),
    context: {
      fetch: async () => ({
        ok: true,
        status: 200,
        body: {
          cancel: async () => {
            cancelled = true;
          },
          getReader: () => {
            bodyRead = true;
            throw new Error('body must not be read');
          },
        },
        text: async () => {
          bodyRead = true;
          throw new Error('body must not be read');
        },
      }),
    },
  });
  await callTool(mockServer, 'keysmith_test', { source: 'cf_live' }, 3);
  assert.equal(cancelled, true);
  assert.equal(bodyRead, false);
  assert.equal(mockReplies[0].result.structuredContent.status, 'ok');
});

test('keysmith_test classifies timeout, unreachable, unauthorized, no_such_endpoint vs no_models_endpoint, rate_limited, and http_error', async (t) => {
  const sb = makeSandbox();
  const cfAcct = 'def00123456789ab' + 'cdef0123456789cd';
  const genericToken = 'tok_' + 'generic_health_123456';
  const prevEnv = process.env.TEST_HEALTH_GENERIC_KEY;
  process.env.TEST_HEALTH_GENERIC_KEY = genericToken;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.TEST_HEALTH_GENERIC_KEY;
    else process.env.TEST_HEALTH_GENERIC_KEY = prevEnv;
  });

  const srv = await startHealthServer(t, (req, res) => {
    if (req.url === '/slow/v1/models') {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200);
          res.end('{}');
        } catch {}
      }, 600);
      timer.unref?.();
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/auth401/v1/models') return res.writeHead(401).end();
    if (req.url === '/missing-health/v1/health') return res.writeHead(404).end();
    if (req.url === `/client/v4/accounts/${cfAcct}/tokens/verify`) return res.writeHead(404).end();
    if (req.url === '/no-models-405/v1/models') return res.writeHead(405).end();
    if (req.url === '/rate429/v1/models') return res.writeHead(429).end();
    if (req.url === '/err500/v1/models') return res.writeHead(500).end();
    res.writeHead(404).end();
  });
  const closedPort = await getClosedPort();

  writeConfig(sb.configFile, {
    adapters: {
      slow: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/slow/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      closed: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      unauth: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/auth401/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      bad_health: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/missing-health/v1`, healthPath: '/health', apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      cf_bad: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/client/v4/accounts/${cfAcct}/ai/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      fallback_405: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/no-models-405/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      rate: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/rate429/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
      err500: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/err500/v1`, apiKey: '{env:TEST_HEALTH_GENERIC_KEY}' },
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    context: { testTimeoutMs: 120 },
    send: (m) => replies.push(m),
  });

  const sources = ['slow', 'closed', 'unauth', 'bad_health', 'cf_bad', 'fallback_405', 'rate', 'err500'];
  for (let i = 0; i < sources.length; i++) {
    await callTool(server, 'keysmith_test', { source: sources[i] }, i + 1);
  }
  const bySource = Object.fromEntries(replies.map((r) => [r.result.structuredContent.source, r.result.structuredContent]));

  assert.equal(bySource.slow.status, 'timeout');
  assert.equal(bySource.slow.ok, false);
  assert.equal(bySource.slow.httpStatus, null);
  assert.equal(bySource.slow.error, 'no answer in 0.12 s');

  assert.equal(bySource.closed.status, 'unreachable');
  assert.equal(bySource.closed.httpStatus, null);
  assert.equal(bySource.closed.error, 'ECONNREFUSED');

  assert.equal(bySource.unauth.status, 'unauthorized');
  assert.equal(bySource.unauth.httpStatus, 401);

  assert.equal(bySource.bad_health.status, 'no_such_endpoint');
  assert.equal(bySource.bad_health.httpStatus, 404);

  assert.equal(bySource.cf_bad.status, 'no_such_endpoint');
  assert.equal(bySource.cf_bad.httpStatus, 404);

  assert.equal(bySource.fallback_405.status, 'no_models_endpoint');
  assert.equal(bySource.fallback_405.httpStatus, 405);

  assert.equal(bySource.rate.status, 'rate_limited');
  assert.equal(bySource.rate.httpStatus, 429);

  assert.equal(bySource.err500.status, 'http_error');
  assert.equal(bySource.err500.httpStatus, 500);
});

test('keysmith doctor shares health probe, distinguishes timeout/unreachable/auth/missing-endpoint, and never leaks keys or account IDs', async (t) => {
  const sb = makeSandbox();
  const cfAcct = '1122334455667788' + '99aabbccddeeff00';
  const doctorKey = 'tok_' + 'doctor_secret_xyz999';
  const srv = await startHealthServer(t, (req, res) => {
    if (req.url === `/client/v4/accounts/${cfAcct}/ai/v1/models`) return res.writeHead(405).end();
    if (req.url === `/client/v4/accounts/${cfAcct}/tokens/verify`) return res.writeHead(200).end('{"success":true}');
    if (req.url === '/auth/v1/models') return res.writeHead(401).end();
    if (req.url === '/missing/v1/custom-health') return res.writeHead(404).end();
    if (req.url === '/hang/v1/models') {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200).end('{}');
        } catch {}
      }, 1500);
      timer.unref?.();
      req.on('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(404).end();
  });
  const closedPort = await getClosedPort();

  writeConfig(sb.configFile, {
    adapters: {
      cloudflare: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `${srv.baseUrl}/client/v4/accounts/${cfAcct}/ai/v1`,
        apiKey: '{env:DOCTOR_PROBE_KEY}',
        explicitOnly: true,
        models: ['@cf/meta/llama-3.1-8b-instruct-fast'],
      },
      auth_bad: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/auth/v1`, apiKey: '{env:DOCTOR_PROBE_KEY}' },
      bad_health: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/missing/v1`, healthPath: '/custom-health', apiKey: '{env:DOCTOR_PROBE_KEY}' },
      slow_api: { kind: 'http', wire: 'openai', baseUrl: `${srv.baseUrl}/hang/v1`, apiKey: '{env:DOCTOR_PROBE_KEY}' },
      down_api: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: '{env:DOCTOR_PROBE_KEY}' },
    },
  });

  const env = {
    ...process.env,
    HOME: sb.root,
    KEYSMITH_DIR: sb.root,
    KEYSMITH_CONFIG: sb.configFile,
    KEYSMITH_DATA: sb.dataDir,
    KEYSMITH_TEST_TIMEOUT_MS: '250',
    DOCTOR_PROBE_KEY: doctorKey,
  };
  const r = await runCliAsync(['doctor'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloudflare\s+ok/);
  assert.match(r.stdout, /tokens\/verify/);
  assert.match(r.stdout, /auth_bad\s+unauthorized/);
  assert.match(r.stdout, /bad_health\s+no_such_endpoint/);
  assert.match(r.stdout, /slow_api\s+timeout\s+no answer in 0\.25 s/);
  assert.match(r.stdout, /down_api\s+unreachable\s+ECONNREFUSED/);
  assert.equal(srv.requests.some((x) => x.method === 'POST' || x.url.includes('/chat/completions')), false, 'doctor must never POST or call completions');
  assert.equal(r.all.includes(doctorKey), false, 'doctor output must never contain secret key');
  assert.equal(r.all.includes(cfAcct), false, 'doctor output must never contain raw account ID');
});
