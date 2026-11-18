import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { createMcpServer, createToolRegistry, loadBuiltInTools } from '../src/mcp.js';
import { UsageLog } from '../src/usage.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

const cleanups = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
});

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-write-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { root, configFile, dataDir };
}

function writeConfig(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listBackups(configFile) {
  const dir = path.dirname(configFile);
  const prefix = path.basename(configFile) + '.bak-';
  return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
}

function rollbackFromBackup(configFile, backupName) {
  assert.ok(backupName && !backupName.includes('/') && !backupName.includes('\\'), 'backup must be basename only');
  const backupPath = path.join(path.dirname(configFile), backupName);
  fs.copyFileSync(backupPath, configFile);
  fs.chmodSync(configFile, 0o600);
}

async function callTool(server, name, args = {}, id = 1) {
  return await server.handle({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

const WRITE_TOOL_NAMES = [
  'keysmith_source_add',
  'keysmith_source_enable',
  'keysmith_source_disable',
  'keysmith_source_set_models',
  'keysmith_model_approve',
  'keysmith_model_revoke',
];

test('loadBuiltInTools registers all 6 write tools with destructive annotations and CLI exposes them', async () => {
  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const tools = reg.list();

  for (const name of WRITE_TOOL_NAMES) {
    const def = tools.find((t) => t.name === name);
    assert.ok(def, `${name} is registered`);
    assert.deepEqual(def.annotations, { readOnlyHint: false, destructiveHint: true });
    assert.equal(def.inputSchema.type, 'object');
    assert.equal(def.inputSchema.properties.confirm?.type, 'boolean');
  }
  assert.equal(tools.filter((t) => WRITE_TOOL_NAMES.includes(t.name) && t.annotations.readOnlyHint === false).length, 6);

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
  for (const name of WRITE_TOOL_NAMES) {
    assert.ok(listedNames.includes(name), `CLI tools/list includes ${name}`);
  }
});

test('all 6 write tools refuse without confirm: true and leave config untouched without backups', async () => {
  const sb = makeSandbox();
  const kcRef = '{exec:/usr/bin/security find-generic-password -s fake-confirm-svc -a keysmith -w}';
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: kcRef,
        disabled: true,
        modelsOnly: true,
        models: ['model-a'],
      },
    },
  });
  const beforeSha = sha(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  let kcLookups = 0;
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      homeDir: sb.root,
      keychainHas: async () => {
        kcLookups++;
        return true;
      },
    },
  });

  const calls = [
    ['keysmith_source_add', { profile: 'tokenrouter', keyRef: 'fake-new-svc' }],
    ['keysmith_source_enable', { source: 'groq', confirm: false }],
    ['keysmith_source_disable', { source: 'groq', confirm: 'true' }],
    ['keysmith_source_set_models', { source: 'groq', models: ['model-b'], confirm: 1 }],
    ['keysmith_model_approve', { source: 'groq', model: 'model-b' }],
    ['keysmith_model_revoke', { source: 'groq', model: 'model-a', confirm: false }],
  ];

  for (const [idx, [tool, args]] of calls.entries()) {
    await callTool(server, tool, args, idx + 1);
    const res = replies[idx].result;
    assert.equal(res.isError, true, `${tool} rejected without confirm: true`);
    assert.equal(res.structuredContent.error, 'confirmation_required');
  }

  assert.equal(kcLookups, 0, 'Keychain was not checked without confirm: true');
  assert.equal(sha(sb.configFile), beforeSha, 'config bytes unchanged');
  assert.deepEqual(listBackups(sb.configFile), [], 'no backups created');
});

test('keysmith_source_add writes Keychain exec reference, 0600 backup/files, validates inputs, and rolls back', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    port: 8787,
    auth: { enabled: true, keys: [] },
    adapters: {
      keep: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:KEEP_KEY}' },
    },
    aliases: { fast: ['keep/m1'] },
  });
  const initialSha = sha(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);

  const knownItems = new Set(['fake-svc-tr:keysmith', 'fake-svc-groq:keysmith', 'fake-svc-cf:customacct']);
  const fetchCalls = [];
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      homeDir: sb.root,
      keychainHas: async (svc, acct) => knownItems.has(`${svc}:${acct}`),
      keychainRead: async (svc) => (svc === 'fake-svc-groq' ? 'tok_fakeGroqResolvedKey123456' : ''),
      fetch: async (url) => {
        fetchCalls.push(url);
        return new Response(
          JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });

  // 1. Add tokenrouter using fake Keychain (freeOnly, no models required).
  await callTool(server, 'keysmith_source_add', { profile: 'tokenrouter', keyRef: 'fake-svc-tr', confirm: true }, 1);
  const trOut = replies[0].result.structuredContent;
  assert.equal(trOut.ok, true);
  assert.equal(trOut.changed, true);
  assert.equal(trOut.source, 'tokenrouter');
  assert.equal(trOut.profile, 'tokenrouter');
  assert.equal(trOut.freeOnly, true);
  assert.equal(trOut.explicitOnly, true);
  assert.equal(trOut.keyRefType, 'exec');
  assert.equal(trOut.reloadRequired, true);
  assert.ok(trOut.backup && !trOut.backup.includes('/'), 'backup returned as basename only');
  assert.match(trOut.backup, /^config\.json\.bak-\d{8}-\d{6}-source/);

  const backupPath1 = path.join(sb.root, trOut.backup);
  assert.ok(fs.existsSync(backupPath1));
  assert.equal(modeOf(backupPath1), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);
  const catFile = path.join(sb.root, 'catalogue.json');
  assert.ok(fs.existsSync(catFile));
  assert.equal(modeOf(catFile), 0o600);

  const cfg1 = readConfig(sb.configFile);
  assert.equal(
    cfg1.adapters.tokenrouter.apiKey,
    '{exec:/usr/bin/security find-generic-password -s fake-svc-tr -a keysmith -w}',
  );
  assert.deepEqual(cfg1.aliases, { fast: ['keep/m1'] }, 'aliases untouched');
  assert.equal(JSON.stringify(replies[0]).includes('fake-svc-tr'), false, 'keyRef never returned');

  // Verify rollback from backup 1 restores exact initial config bytes.
  const midSha = sha(sb.configFile);
  rollbackFromBackup(sb.configFile, trOut.backup);
  assert.equal(sha(sb.configFile), initialSha, 'rollback restored original config byte-for-byte');
  // Re-apply tokenrouter for subsequent checks.
  await callTool(server, 'keysmith_source_add', { profile: 'tokenrouter', keyRef: 'fake-svc-tr', confirm: true }, 2);
  assert.notEqual(sha(sb.configFile), initialSha);
  void midSha;

  // 2. Add groq without explicit model -> picks default via fake fetch + fake keychainRead; value never saved or returned.
  await callTool(server, 'keysmith_source_add', { profile: 'groq', keyRef: 'fake-svc-groq', confirm: true }, 3);
  const groqOut = replies[2].result.structuredContent;
  assert.equal(groqOut.ok, true);
  assert.equal(groqOut.modelsOnly, true);
  assert.deepEqual(groqOut.models, ['llama-3.1-8b-instant']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fs.readFileSync(sb.configFile, 'utf8').includes('tok_fakeGroqResolvedKey123456'), false);
  assert.equal(JSON.stringify(replies[2]).includes('tok_fakeGroqResolvedKey123456'), false);

  // 3. Add cloudflare with custom alias (`as`), custom `keyAccount`, 32-hex `accountId`, and explicit `models`.
  const cfAccount = '0123456789abcdef0123456789abcdef';
  await callTool(
    server,
    'keysmith_source_add',
    {
      profile: 'cloudflare',
      as: 'cf_alt',
      keyRef: 'fake-svc-cf',
      keyAccount: 'customacct',
      accountId: cfAccount,
      models: ['@cf/meta/llama-3.1-8b-instruct'],
      confirm: true,
    },
    4,
  );
  const cfRes = replies[3].result;
  assert.equal(cfRes.isError, undefined);
  assert.equal(cfRes.structuredContent.source, 'cf_alt');
  assert.equal(cfRes.structuredContent.modelsOnly, true);
  assert.deepEqual(cfRes.structuredContent.models, ['@cf/meta/llama-3.1-8b-instruct']);
  const dumpCf = JSON.stringify(cfRes);
  assert.equal(dumpCf.includes(cfAccount), false, 'accountId never leaked');
  assert.equal(dumpCf.includes('fake-svc-cf'), false, 'keyRef never leaked');
  assert.equal(dumpCf.includes('customacct'), false, 'keyAccount never leaked');
  const cfgAfterCf = readConfig(sb.configFile);
  assert.equal(
    cfgAfterCf.adapters.cf_alt.apiKey,
    '{exec:/usr/bin/security find-generic-password -s fake-svc-cf -a customacct -w}',
  );
  assert.equal(
    cfgAfterCf.adapters.cf_alt.baseUrl,
    `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1`,
  );

  // 4. Reject missing Keychain item, raw secret value in keyRef, {exec:...} in keyRef, and direct apiKey param.
  const preErrSha = sha(sb.configFile);
  const preErrBaks = listBackups(sb.configFile);

  await callTool(server, 'keysmith_source_add', { profile: 'mistral', keyRef: 'missing-svc', models: ['mistral-small-latest'], confirm: true }, 5);
  assert.equal(replies[4].result.isError, true);
  assert.equal(JSON.stringify(replies[4]).includes('missing-svc'), false);

  const rawSecretInput = 'sk' + '-fakeLiteralSecretShouldNeverBeAccepted1234';
  await callTool(server, 'keysmith_source_add', { profile: 'mistral', keyRef: rawSecretInput, models: ['m'], confirm: true }, 6);
  assert.equal(replies[5].result.isError, true);
  assert.equal(JSON.stringify(replies[5]).includes(rawSecretInput), false);

  await callTool(
    server,
    'keysmith_source_add',
    { profile: 'mistral', keyRef: '{exec:/usr/bin/security find-generic-password -s secret-in-ref -w}', models: ['m'], confirm: true },
    7,
  );
  assert.equal(replies[6].result.isError, true);
  assert.equal(JSON.stringify(replies[6]).includes('secret-in-ref'), false);

  await callTool(
    server,
    'keysmith_source_add',
    { profile: 'mistral', keyRef: 'fake-svc-tr', apiKey: rawSecretInput, models: ['m'], confirm: true },
    8,
  );
  assert.equal(replies[7].result.isError, true);
  assert.equal(JSON.stringify(replies[7]).includes(rawSecretInput), false);

  assert.equal(sha(sb.configFile), preErrSha, 'error paths never modified config');
  assert.deepEqual(listBackups(sb.configFile), preErrBaks, 'error paths created no backup');
});

test('keysmith_source_enable and keysmith_source_disable toggle disabled with 0600 backup, preserve key ref, and roll back', async () => {
  const sb = makeSandbox();
  const kcExecRef = '{exec:/usr/bin/security find-generic-password -s fake-toggle-svc -a keysmith -w}';
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: kcExecRef,
        explicitOnly: true,
        modelsOnly: true,
        models: ['llama-3.1-8b-instant'],
      },
      unsafe_cli: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        unsafeTools: true,
        disabled: true,
      },
    },
  });
  const origRaw = fs.readFileSync(sb.configFile, 'utf8');
  const origSha = sha(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  // Disable active source.
  await callTool(server, 'keysmith_source_disable', { source: 'groq', confirm: true }, 1);
  const disOut = replies[0].result.structuredContent;
  assert.equal(disOut.ok, true);
  assert.equal(disOut.changed, true);
  assert.equal(disOut.source, 'groq');
  assert.equal(disOut.previousDisabled, false);
  assert.equal(disOut.disabled, true);
  assert.equal(disOut.reloadRequired, true);
  assert.ok(disOut.backup && !disOut.backup.includes('/'));
  assert.equal(modeOf(path.join(sb.root, disOut.backup)), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);
  assert.equal(readConfig(sb.configFile).adapters.groq.disabled, true);
  assert.equal(readConfig(sb.configFile).adapters.groq.apiKey, kcExecRef, 'key reference unchanged');

  // Repeat disable is idempotent (no new backup).
  await callTool(server, 'keysmith_source_disable', { source: 'groq', confirm: true }, 2);
  assert.equal(replies[1].result.structuredContent.changed, false);
  assert.equal(replies[1].result.structuredContent.backup, null);
  assert.equal(listBackups(sb.configFile).length, 1);

  // Re-enable source.
  await callTool(server, 'keysmith_source_enable', { source: 'groq', confirm: true }, 3);
  const enOut = replies[2].result.structuredContent;
  assert.equal(enOut.ok, true);
  assert.equal(enOut.changed, true);
  assert.equal(enOut.previousDisabled, true);
  assert.equal(enOut.disabled, false);
  assert.ok(enOut.backup && !enOut.backup.includes('/'));
  assert.equal(modeOf(path.join(sb.root, enOut.backup)), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);
  assert.equal(readConfig(sb.configFile).adapters.groq.disabled, false);
  assert.equal(readConfig(sb.configFile).adapters.groq.apiKey, kcExecRef, 'key reference still unchanged');

  // Repeat enable is idempotent.
  await callTool(server, 'keysmith_source_enable', { source: 'groq', confirm: true }, 4);
  assert.equal(replies[3].result.structuredContent.changed, false);
  assert.equal(replies[3].result.structuredContent.backup, null);

  // unsafeTools source cannot be enabled via MCP.
  const preUnsafeSha = sha(sb.configFile);
  await callTool(server, 'keysmith_source_enable', { source: 'unsafe_cli', confirm: true }, 5);
  assert.equal(replies[4].result.isError, true);
  assert.match(replies[4].result.structuredContent.error, /unsafeTools/);
  assert.equal(sha(sb.configFile), preUnsafeSha);

  // Roll back to pre-disable state via backup 1.
  rollbackFromBackup(sb.configFile, disOut.backup);
  assert.equal(sha(sb.configFile), origSha);
  assert.equal(fs.readFileSync(sb.configFile, 'utf8'), origRaw);
});

test('keysmith_source_set_models replaces models keeping modelsOnly: true, 0600 backup, preserves key ref, and rolls back', async () => {
  const sb = makeSandbox();
  const kcExecRef = '{exec:/usr/bin/security find-generic-password -s fake-models-svc -a keysmith -w}';
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: kcExecRef,
        modelsOnly: false,
        models: ['m-old-1', 'm-old-2'],
      },
    },
  });
  const origSha = sha(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  await callTool(
    server,
    'keysmith_source_set_models',
    { source: 'groq', models: ['m-old-2', 'm-new-1', 'm-old-2'], confirm: true },
    1,
  );
  const setOut = replies[0].result.structuredContent;
  assert.equal(setOut.ok, true);
  assert.equal(setOut.changed, true);
  assert.equal(setOut.modelsOnly, true);
  assert.deepEqual(setOut.previousModels, ['m-old-1', 'm-old-2']);
  assert.deepEqual(setOut.models, ['m-old-2', 'm-new-1']);
  assert.deepEqual(setOut.added, ['m-new-1']);
  assert.deepEqual(setOut.removed, ['m-old-1']);
  assert.ok(setOut.backup && !setOut.backup.includes('/'));
  assert.equal(modeOf(path.join(sb.root, setOut.backup)), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);

  const afterDoc = readConfig(sb.configFile);
  assert.equal(afterDoc.adapters.groq.modelsOnly, true);
  assert.deepEqual(afterDoc.adapters.groq.models, ['m-old-2', 'm-new-1']);
  assert.equal(afterDoc.adapters.groq.apiKey, kcExecRef, 'key reference unchanged');

  // Repeating same models is idempotent.
  await callTool(server, 'keysmith_source_set_models', { source: 'groq', models: ['m-old-2', 'm-new-1'], confirm: true }, 2);
  assert.equal(replies[1].result.structuredContent.changed, false);
  assert.equal(replies[1].result.structuredContent.backup, null);

  // Empty array keeps modelsOnly: true.
  await callTool(server, 'keysmith_source_set_models', { source: 'groq', models: [], confirm: true }, 3);
  assert.equal(replies[2].result.structuredContent.modelsOnly, true);
  assert.deepEqual(readConfig(sb.configFile).adapters.groq.models, []);
  assert.equal(readConfig(sb.configFile).adapters.groq.modelsOnly, true);

  // Roll back to initial state using first backup.
  rollbackFromBackup(sb.configFile, setOut.backup);
  assert.equal(sha(sb.configFile), origSha);
  assert.equal(readConfig(sb.configFile).adapters.groq.apiKey, kcExecRef);
});

test('keysmith_model_approve and keysmith_model_revoke update approved list, enforce in fake gateway, and roll back', async () => {
  const sb = makeSandbox();
  const stubHits = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    stubHits.push({ url, body: init?.body });
    const parsed = init?.body ? JSON.parse(init.body) : {};
    const sse = [
      `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: parsed.model || 'm-alpha', choices: [{ index: 0, delta: { content: 'ok' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: parsed.model || 'm-alpha', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  cleanups.push(() => {
    globalThis.fetch = prevFetch;
  });

  const gwKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const kcExecRef = '{exec:/usr/bin/security find-generic-password -s fake-approve-svc -a keysmith -w}';
  const envName = 'KS_TEST_APPROVE_UPSTREAM_KEY';
  const prevEnv = process.env[envName];
  process.env[envName] = 'tok_fakeApproveUpstream123456';
  cleanups.push(() => {
    if (prevEnv === undefined) delete process.env[envName];
    else process.env[envName] = prevEnv;
  });

  // First test approve/revoke on an adapter holding a real {exec:...} Keychain reference.
  writeConfig(sb.configFile, {
    auth: { enabled: true, keys: [gwKey] },
    adapters: {
      kc_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: kcExecRef,
        explicitOnly: true,
        modelsOnly: true,
        models: ['m-alpha'],
      },
      gw_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{env:${envName}}`,
        explicitOnly: true,
        modelsOnly: true,
        models: ['m-alpha'],
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
    context: { homeDir: sb.root },
  });

  // Approve m-beta on kc_src (verifies Keychain ref unchanged, 0600, backup, keysmith_approved).
  const beforeKcSha = sha(sb.configFile);
  await callTool(server, 'keysmith_model_approve', { source: 'kc_src', model: 'm-beta', confirm: true }, 1);
  const appKc = replies[0].result.structuredContent;
  assert.equal(appKc.ok, true);
  assert.equal(appKc.changed, true);
  assert.equal(appKc.approved, true);
  assert.equal(appKc.modelsOnly, true);
  assert.deepEqual(appKc.models, ['m-alpha', 'm-beta']);
  assert.equal(modeOf(path.join(sb.root, appKc.backup)), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);
  assert.equal(readConfig(sb.configFile).adapters.kc_src.apiKey, kcExecRef, 'Keychain exec ref unchanged');

  await callTool(server, 'keysmith_approved', { source: 'kc_src' }, 2);
  assert.deepEqual(replies[1].result.structuredContent.approved, { kc_src: ['m-alpha', 'm-beta'] });

  // Rollback kc_src approve using backup.
  rollbackFromBackup(sb.configFile, appKc.backup);
  assert.equal(sha(sb.configFile), beforeKcSha);

  // Now approve m-beta on gw_src and check fake gateway accepts m-beta, then revoke and verify 400 + rollback.
  await callTool(server, 'keysmith_model_approve', { source: 'gw_src', model: 'm-beta', confirm: true }, 3);
  assert.deepEqual(readConfig(sb.configFile).adapters.gw_src.models, ['m-alpha', 'm-beta']);

  async function queryGateway(model) {
    const prevCfg = process.env.KEYSMITH_CONFIG;
    const prevData = process.env.KEYSMITH_DATA;
    process.env.KEYSMITH_CONFIG = sb.configFile;
    process.env.KEYSMITH_DATA = sb.dataDir;
    const loaded = loadConfig({ path: sb.configFile, mint: false });
    const usage = new UsageLog(path.join(sb.dataDir, 'usage.jsonl'));
    const gateway = new Gateway(loaded, { log: () => {}, usage });
    try {
      const res = await gateway.collect({ model, messages: [{ role: 'user', content: 'hi' }] });
      return { status: 200, text: res.text };
    } catch (err) {
      return { status: err?.status || 500, text: err?.message || String(err) };
    } finally {
      await gateway.close();
      if (prevCfg === undefined) delete process.env.KEYSMITH_CONFIG;
      else process.env.KEYSMITH_CONFIG = prevCfg;
      if (prevData === undefined) delete process.env.KEYSMITH_DATA;
      else process.env.KEYSMITH_DATA = prevData;
    }
  }

  const hitsBefore = stubHits.length;
  const approvedRes = await queryGateway('gw_src/m-beta');
  assert.equal(approvedRes.status, 200, approvedRes.text);
  assert.equal(approvedRes.text, 'ok');
  assert.equal(stubHits.length, hitsBefore + 1);

  const preRevokeSha = sha(sb.configFile);
  await callTool(server, 'keysmith_model_revoke', { source: 'gw_src', model: 'm-beta', confirm: true }, 4);
  const revOut = replies[3].result.structuredContent;
  assert.equal(revOut.ok, true);
  assert.equal(revOut.changed, true);
  assert.equal(revOut.approved, false);
  assert.equal(revOut.modelsOnly, true);
  assert.deepEqual(revOut.models, ['m-alpha']);
  assert.equal(modeOf(path.join(sb.root, revOut.backup)), 0o600);
  assert.equal(modeOf(sb.configFile), 0o600);

  // Revoking an unapproved model is a no-op.
  await callTool(server, 'keysmith_model_revoke', { source: 'gw_src', model: 'm-beta', confirm: true }, 5);
  assert.equal(replies[4].result.structuredContent.changed, false);
  assert.equal(replies[4].result.structuredContent.backup, null);

  // Gateway rejects revoked model without calling upstream.
  const hitsAfterRevoke = stubHits.length;
  const revokedRes = await queryGateway('gw_src/m-beta');
  assert.equal(revokedRes.status, 400, revokedRes.text);
  assert.match(revokedRes.text, /not one of the models named/);
  assert.equal(stubHits.length, hitsAfterRevoke, 'revoked model never reached upstream');

  // Roll back from revoke backup -> m-beta works again.
  rollbackFromBackup(sb.configFile, revOut.backup);
  assert.equal(sha(sb.configFile), preRevokeSha);
  const restoredRes = await queryGateway('gw_src/m-beta');
  assert.equal(restoredRes.status, 200, restoredRes.text);
  assert.equal(restoredRes.text, 'ok');
});

test('redaction: write tools never leak fake secrets, key ref interiors, accountIds, workspaceFiles, or full directory paths', async () => {
  const sb = makeSandbox();
  const mintedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const literalKey = 'tok_' + 'fakeWriteSliceLiteralSecret9911';
  const bearerHeader = 'hdr_' + 'fakeWriteSliceBearerSecret8822';
  const kcSvc = 'fake-write-kc-svc-701';
  const kcAcct = 'fake-write-kc-acct-702';
  const newKcSvc = 'fake-write-new-svc-703';
  const newKcAcct = 'fake-write-new-acct-704';
  const kcReadSecret = 'kc_' + 'fakeWriteKcReadSecret705';
  const execInner = `/usr/bin/security find-generic-password -s ${kcSvc} -a ${kcAcct} -w`;
  const jsonFile = path.join(sb.root, 'creds-706.json');
  const jsonField = 'provider.secretToken706';
  const cfAccountId = 'aabbccddeeff00112233445566778899';
  const wsContent = 'WS_WRITE_SLICE_SECRET_707_NEVER_LEAK';

  writeConfig(sb.configFile, {
    auth: { enabled: true, keys: [mintedKey] },
    adapters: {
      kc_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{exec:${execInner}}`,
        modelsOnly: true,
        models: ['m1'],
      },
      lit_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: literalKey,
        headers: { Authorization: `Bearer ${bearerHeader}` },
      },
      json_src: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1`,
        accountId: cfAccountId,
        apiKey: `{json:${jsonFile}#${jsonField}}`,
      },
      cli_src: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        unsafeTools: true,
        disabled: true,
        workspaceFiles: { '.kiro/agents/write-test.json': wsContent },
      },
    },
  });

  const secCalled = path.join(sb.root, 'real-security-called');
  const secBin = path.join(sb.root, 'real-security-sentinel');
  fs.writeFileSync(secBin, `#!/bin/sh\ntouch "${secCalled}"\nexit 0\n`, { mode: 0o755 });
  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  process.env.KEYSMITH_SECURITY_BIN = secBin;

  try {
    const reg = createToolRegistry();
    await loadBuiltInTools(reg);
    const replies = [];
    const server = createMcpServer({
      registry: reg,
      configFile: sb.configFile,
      dataDir: sb.dataDir,
      send: (m) => replies.push(m),
      context: {
        homeDir: sb.root,
        keychainHas: async (svc, acct) => svc === newKcSvc && acct === newKcAcct,
        keychainRead: async (svc, acct) => (svc === newKcSvc && acct === newKcAcct ? kcReadSecret : ''),
        fetch: async () =>
          new Response(JSON.stringify({ data: [{ id: 'mistral-small-latest' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });

    await callTool(
      server,
      'keysmith_source_add',
      { profile: 'cloudflare', keyRef: newKcSvc, keyAccount: newKcAcct, accountId: cfAccountId, models: ['@cf/m1'], confirm: true },
      1,
    );
    await callTool(server, 'keysmith_source_disable', { source: 'kc_src', confirm: true }, 2);
    await callTool(server, 'keysmith_source_enable', { source: 'kc_src', confirm: true }, 3);
    await callTool(server, 'keysmith_source_enable', { source: 'cli_src', confirm: true }, 4);
    await callTool(server, 'keysmith_source_set_models', { source: 'kc_src', models: ['m1', 'm2'], confirm: true }, 5);
    await callTool(server, 'keysmith_model_approve', { source: 'kc_src', model: 'm3', confirm: true }, 6);
    await callTool(server, 'keysmith_model_revoke', { source: 'kc_src', model: 'm2', confirm: true }, 7);
    await callTool(
      server,
      'keysmith_source_add',
      { profile: 'groq', keyRef: 'nonexistent-kc-svc-708', keyAccount: 'nonexistent-acct-709', confirm: true },
      8,
    );

    const dump = JSON.stringify(replies);
    const forbidden = [
      sb.root,
      sb.configFile,
      sb.dataDir,
      mintedKey,
      literalKey,
      bearerHeader,
      kcSvc,
      kcAcct,
      newKcSvc,
      newKcAcct,
      kcReadSecret,
      execInner,
      jsonFile,
      jsonField,
      cfAccountId,
      wsContent,
      'nonexistent-kc-svc-708',
      'nonexistent-acct-709',
    ];

    for (const secret of forbidden) {
      assert.equal(dump.includes(secret), false, `sensitive string leaked in write output: ${secret}`);
    }
    assert.equal(fs.existsSync(secCalled), false, 'sentinel Keychain binary was never executed');
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
  }
});

test('approved model write tools refuse CLI sources and leave config unchanged', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    adapters: {
      kiro_cli: {
        kind: 'cli',
        bin: 'kiro-cli',
        args: ['{prompt}'],
        parser: 'raw',
        models: ['m1'],
      },
      inferred_cli: {
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        models: ['m2'],
      },
    },
  });
  const beforeBytes = fs.readFileSync(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  const calls = [
    ['keysmith_source_set_models', { source: 'kiro_cli', models: ['m1', 'm2'], confirm: true }],
    ['keysmith_model_approve', { source: 'kiro_cli', model: 'm3', confirm: true }],
    ['keysmith_model_revoke', { source: 'kiro_cli', model: 'm1', confirm: true }],
    ['keysmith_source_set_models', { source: 'inferred_cli', models: ['m2'], confirm: true }],
    ['keysmith_model_approve', { source: 'inferred_cli', model: 'm3', confirm: true }],
    ['keysmith_model_revoke', { source: 'inferred_cli', model: 'm2', confirm: true }],
  ];

  for (const [idx, [tool, args]] of calls.entries()) {
    await callTool(server, tool, args, idx + 1);
    const res = replies[idx].result;
    assert.equal(res.isError, true, `${tool} on ${args.source} must refuse`);
    assert.equal(res.structuredContent.ok, false);
    assert.equal(res.structuredContent.error, 'approved model lists are enforced only on HTTP sources');
  }

  assert.equal(Buffer.compare(fs.readFileSync(sb.configFile), beforeBytes), 0, 'config bytes unchanged');
  assert.deepEqual(listBackups(sb.configFile), [], 'no backups created');
});

test('write tools reject dotted source ids up front without modifying config', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
        headers: { 'x-test': '1' },
        modelsOnly: true,
        models: ['m1'],
      },
    },
  });
  const beforeBytes = fs.readFileSync(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  const calls = [
    ['keysmith_source_enable', { source: 'groq.headers', confirm: true }],
    ['keysmith_source_disable', { source: 'groq.headers', confirm: true }],
    ['keysmith_source_set_models', { source: 'groq.headers', models: ['m2'], confirm: true }],
    ['keysmith_model_approve', { source: 'groq.headers', model: 'm2', confirm: true }],
    ['keysmith_model_revoke', { source: 'groq.headers', model: 'm1', confirm: true }],
  ];

  for (const [idx, [tool, args]] of calls.entries()) {
    await callTool(server, tool, args, idx + 1);
    const res = replies[idx].result;
    assert.equal(res.isError, true, `${tool} rejected dotted source id`);
    assert.match(res.structuredContent.error, /invalid source name/);
  }

  assert.equal(Buffer.compare(fs.readFileSync(sb.configFile), beforeBytes), 0, 'config bytes unchanged');
  assert.deepEqual(listBackups(sb.configFile), [], 'no backups created');
});

test('keysmith_source_add rejects Keychain names starting with "-"', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, { adapters: {} });
  const beforeBytes = fs.readFileSync(sb.configFile);

  let kcCalled = 0;
  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      homeDir: sb.root,
      keychainHas: async () => {
        kcCalled++;
        return true;
      },
    },
  });

  await callTool(server, 'keysmith_source_add', { profile: 'tokenrouter', keyRef: '-w', confirm: true }, 1);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.structuredContent.error, /keyRef/);

  await callTool(server, 'keysmith_source_add', { profile: 'tokenrouter', keyRef: 'valid-svc', keyAccount: '-w', confirm: true }, 2);
  assert.equal(replies[1].result.isError, true);
  assert.match(replies[1].result.structuredContent.error, /keyAccount/);

  assert.equal(kcCalled, 0, 'Keychain was never checked for leading-dash names');
  assert.equal(Buffer.compare(fs.readFileSync(sb.configFile), beforeBytes), 0, 'config bytes unchanged');
  assert.deepEqual(listBackups(sb.configFile), [], 'no backups created');
});

test('keysmith_source_set_models and keysmith_model_approve reject model ids with spaces or commas', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, {
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
        modelsOnly: true,
        models: ['m1'],
      },
    },
  });
  const beforeBytes = fs.readFileSync(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  const calls = [
    ['keysmith_source_set_models', { source: 'groq', models: ['llama 3'], confirm: true }],
    ['keysmith_source_set_models', { source: 'groq', models: ['m1,m2'], confirm: true }],
    ['keysmith_model_approve', { source: 'groq', model: 'llama 3', confirm: true }],
    ['keysmith_model_approve', { source: 'groq', model: 'm1,m2', confirm: true }],
  ];

  for (const [idx, [tool, args]] of calls.entries()) {
    await callTool(server, tool, args, idx + 1);
    const res = replies[idx].result;
    assert.equal(res.isError, true, `${tool} rejected bad model id`);
    assert.match(res.structuredContent.error, /invalid model id/);
  }

  assert.equal(Buffer.compare(fs.readFileSync(sb.configFile), beforeBytes), 0, 'config bytes unchanged');
  assert.deepEqual(listBackups(sb.configFile), [], 'no backups created');
});

test('keysmith_source_add production Keychain path registers key value in redactSecrets and extraLiterals', async () => {
  const sb = makeSandbox();
  writeConfig(sb.configFile, { port: 8787, auth: { enabled: true, keys: [] }, adapters: {}, aliases: {} });

  const prodSecret = 'plain_kc_' + 'prod_secret_99887766';
  const secBin = path.join(sb.root, 'fake-prod-security');
  const secOut = path.join(sb.root, 'prod-sec-val.txt');
  fs.writeFileSync(secOut, prodSecret, { mode: 0o600 });
  fs.writeFileSync(
    secBin,
    [
      '#!/bin/sh',
      'want_w=0',
      'for arg in "$@"; do',
      '  if [ "$arg" = "-w" ]; then want_w=1; fi',
      'done',
      `if [ "$want_w" = "1" ]; then cat "${secOut}"; fi`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );

  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  process.env.KEYSMITH_SECURITY_BIN = secBin;

  let mode = 'mismatch';
  try {
    const reg = createToolRegistry();
    await loadBuiltInTools(reg);
    const replies = [];
    const server = createMcpServer({
      registry: reg,
      configFile: sb.configFile,
      dataDir: sb.dataDir,
      send: (m) => replies.push(m),
      context: {
        homeDir: sb.root,
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: [{ id: mode === 'mismatch' ? `err_${prodSecret}` : 'llama-3.1-8b-instant' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    });

    await callTool(
      server,
      'keysmith_source_add',
      { profile: 'groq', keyRef: 'prod-svc', models: ['llama-3.1-8b-instant'], confirm: true },
      1,
    );
    assert.equal(replies[0].result.isError, true);
    const errDump = JSON.stringify(replies[0]);
    assert.equal(errDump.includes(prodSecret), false, 'full secret absent from error output');
    assert.equal(errDump.includes(prodSecret.slice(0, 12)), false, '12-char secret fragment redacted');

    mode = 'ok';
    await callTool(server, 'keysmith_source_add', { profile: 'groq', keyRef: 'prod-svc', confirm: true }, 2);
    assert.equal(replies[1].result.isError, undefined);
    assert.equal(replies[1].result.structuredContent.ok, true);
    assert.equal(JSON.stringify(replies[1]).includes(prodSecret), false, 'secret absent from success output');
    assert.equal(fs.readFileSync(sb.configFile, 'utf8').includes(prodSecret), false, 'secret never written to config');
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
  }
});

test('keysmith_model_approve writes tier: free to catalogue so approved models missing from catalogue are handled in pending list', async () => {
  const sb = makeSandbox();
  const catFile = path.join(sb.root, 'catalogue.json');
  writeConfig(sb.configFile, {
    catalogue: '~/catalogue.json',
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:GROQ_KEY}',
        modelsOnly: true,
        models: ['m-existing'],
      },
    },
  });
  fs.writeFileSync(
    catFile,
    JSON.stringify(
      {
        version: 1,
        sources: [
          {
            id: 'groq',
            reach: { keysmith: 'groq' },
            limits: { requestsPerMinute: 30 },
            models: [{ id: 'm-existing', tier: 'free' }],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: { homeDir: sb.root },
  });

  await callTool(server, 'keysmith_model_approve', { source: 'groq', model: 'm-missing', confirm: true }, 1);
  const appOut = replies[0].result.structuredContent;
  assert.equal(appOut.ok, true);
  assert.equal(appOut.changed, true);
  assert.deepEqual(appOut.models, ['m-existing', 'm-missing']);

  const catAfter = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  const groqCat = catAfter.sources.find((s) => s?.reach?.keysmith === 'groq');
  assert.ok(groqCat.models.some((m) => m.id === 'm-missing' && m.tier === 'free'));
  assert.equal(modeOf(catFile), 0o600);
  const catBackups = fs.readdirSync(sb.root).filter((f) => f.startsWith('catalogue.json.bak-'));
  assert.equal(catBackups.length, 1);
  assert.equal(modeOf(path.join(sb.root, catBackups[0])), 0o600);

  await callTool(server, 'keysmith_approved', { source: 'groq' }, 2);
  assert.deepEqual(replies[1].result.structuredContent.approved, { groq: ['m-existing', 'm-missing'] });
  assert.deepEqual(replies[1].result.structuredContent.pending, []);

  // Re-classify m-missing as paid in catalogue -> keysmith_approved surfaces it in pending just like source.js entries.
  groqCat.models = groqCat.models.map((m) => (m.id === 'm-missing' ? { ...m, tier: 'paid' } : m));
  fs.writeFileSync(catFile, JSON.stringify(catAfter, null, 2) + '\n', { mode: 0o600 });
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(catFile, future, future);

  await callTool(server, 'keysmith_approved', { source: 'groq' }, 3);
  assert.deepEqual(replies[2].result.structuredContent.pending, [
    { source: 'groq', model: 'm-missing', oldFree: true, newFree: false },
  ]);
});
