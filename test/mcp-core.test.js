import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL } from '../src/bridge/mcp.js';
import {
  collectConfigSecrets,
  createMcpServer,
  createToolRegistry,
  listRegisteredTools,
  registerMcpClients,
  registerTool,
  startMcpServer,
  unregisterTool,
  writeConfigWithBackup,
} from '../src/mcp.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { root, configFile, dataDir };
}

function makeFakeSecrets(root) {
  const mintedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const scopedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const literalApiKey = 'tok_' + 'fakeLiteralSecretValue9911';
  const bearerToken = 'tok_' + 'fakeBearerHeaderValue8822';
  const headerApiKey = 'hdr_' + 'fakeHeaderSecretValue7733';
  const envSecret = 'env_' + 'fakeEnvSecretValue6644';
  const providerPrefixed = 'sk-' + 'fakeProviderKeyPartA' + 'fakeProviderKeyPartB';
  const keychainSvc = 'fake-kc-service-901';
  const keychainAcct = 'fake-kc-account-902';
  const execInner = `/usr/bin/security find-generic-password -s ${keychainSvc} -a ${keychainAcct} -w`;
  const jsonFile = path.join(root, 'fake-store-903', 'creds.json');
  const jsonInner = `${jsonFile}#provider.secretField`;
  const fileInner = path.join(root, 'fake-store-903', 'api-token.txt');
  const dotenvFile = path.join(root, 'fake-store-903', '.env.local');
  const dotenvInner = `${dotenvFile}#DOTENV_FAKE_KEY`;
  const cfAccountId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const workspaceContent = 'WS_FAKE_CONTENT_SECRET_904_DO_NOT_LEAK';
  const reqBody = '{"prompt":"REQ_BODY_SECRET_905"}';
  const resBody = '{"answer":"RES_BODY_SECRET_906"}';

  const config = {
    host: '127.0.0.1',
    port: 8787,
    auth: {
      enabled: true,
      keys: [mintedKey, { key: scopedKey, label: 'mcp-test-agent', allow: ['groq'] }],
    },
    log: { usage: true, body: false },
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: literalApiKey,
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'x-api-key': headerApiKey,
        },
        env: {
          UPSTREAM_SECRET_KEY: envSecret,
          PUBLIC_REGION: 'eu-central',
        },
      },
      cf: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/v1`,
        accountId: cfAccountId,
        apiKey: `{exec:${execInner}}`,
      },
      jsonref: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{json:${jsonInner}}`,
      },
      fileref: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{file:${fileInner}}`,
      },
      dotenvref: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: `{dotenv:${dotenvInner}}`,
      },
      clitest: {
        kind: 'cli',
        bin: 'echo',
        args: ['{prompt}'],
        parser: 'raw',
        workspaceFiles: {
          '.kiro/agents/fake.json': workspaceContent,
        },
      },
    },
    aliases: { fast: ['groq/model-a'] },
  };

  const forbidden = [
    mintedKey,
    scopedKey,
    literalApiKey,
    bearerToken,
    headerApiKey,
    envSecret,
    providerPrefixed,
    keychainSvc,
    keychainAcct,
    execInner,
    jsonFile,
    jsonInner,
    'provider.secretField',
    fileInner,
    dotenvFile,
    dotenvInner,
    'DOTENV_FAKE_KEY',
    cfAccountId,
    workspaceContent,
    reqBody,
    resBody,
    'REQ_BODY_SECRET_905',
    'RES_BODY_SECRET_906',
  ];

  return {
    config,
    forbidden,
    mintedKey,
    scopedKey,
    literalApiKey,
    bearerToken,
    headerApiKey,
    envSecret,
    providerPrefixed,
    keychainSvc,
    keychainAcct,
    execInner,
    jsonInner,
    fileInner,
    dotenvInner,
    cfAccountId,
    workspaceContent,
    reqBody,
    resBody,
  };
}

test('JSON-RPC lifecycle: initialize, notifications/initialized, ping, tools/list, and errors', async () => {
  const sb = makeSandbox();
  fs.writeFileSync(sb.configFile, JSON.stringify({ auth: { enabled: true, keys: [] }, adapters: {}, aliases: {} }), { mode: 0o600 });

  const replies = [];
  const server = createMcpServer({
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (msg) => replies.push(msg),
  });

  // Known protocol version is echoed; unknown falls back to LATEST_PROTOCOL.
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.equal(replies[0].result.serverInfo.name, 'keysmith');
  assert.deepEqual(replies[0].result.capabilities, { tools: { listChanged: false } });

  await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(replies[1].result.protocolVersion, LATEST_PROTOCOL);

  // Notification produces no reply and updates initialized flag.
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(replies.length, 2);
  assert.equal(server.state().initialized, true);

  // Ping answers empty object.
  await server.handle({ jsonrpc: '2.0', id: 'p-1', method: 'ping' });
  assert.deepEqual(replies[2], { jsonrpc: '2.0', id: 'p-1', result: {} });

  // tools/list returns keysmith_ping with read-only annotations.
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const listed = replies[3].result.tools;
  const pingTool = listed.find((t) => t.name === 'keysmith_ping');
  assert.ok(pingTool, 'keysmith_ping is listed');
  assert.deepEqual(pingTool.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.equal(pingTool.inputSchema.type, 'object');

  // Unknown method returns -32601; parse error returns -32700 without echoing input.
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'server/discover' });
  assert.equal(replies[4].error.code, -32601);

  await server.handleLine('{bad json with SECRET_BAD_JSON_MARKER');
  assert.equal(replies[5].error.code, -32700);
  assert.ok(!JSON.stringify(replies[5]).includes('SECRET_BAD_JSON_MARKER'));

  await server.handle('not-an-object');
  assert.equal(replies[6].error.code, -32600);

  await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keysmith_missing' } });
  assert.equal(replies[7].error.code, -32602);
});

test('registry, central confirm gate, and backup-first config writes', async () => {
  const sb = makeSandbox();
  fs.writeFileSync(sb.configFile, JSON.stringify({ host: '127.0.0.1', port: 8787, adapters: {} }), { mode: 0o600 });

  const reg = createToolRegistry();
  assert.throws(() => registerTool({ name: 'bad_name', handler: () => {} }, reg), /invalid MCP tool name/);

  let handlerCalls = 0;
  registerTool(
    {
      name: 'keysmith_test_write',
      description: 'Test write tool',
      write: true,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: { port: { type: 'number' } },
      },
      handler: async (args, ctx) => {
        handlerCalls++;
        assert.equal(Object.hasOwn(args, 'toolSummary'), false, 'injected harness args stripped');
        assert.equal(Object.hasOwn(args, 'toolAction'), false, 'injected harness args stripped');
        return await writeConfigWithBackup(
          ctx.configFile,
          (doc) => {
            doc.port = args.port;
            return { port: doc.port };
          },
          { tag: 'mcp' },
        );
      },
    },
    reg,
  );

  const listed = listRegisteredTools(reg);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].annotations, { readOnlyHint: false, destructiveHint: true });
  assert.equal(listed[0].inputSchema.properties.confirm.type, 'boolean');

  const replies = [];
  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
  });

  // Missing, false, string, and numeric confirm values must be rejected BEFORE handler runs.
  for (const [idx, badArgs] of [
    { port: 9000 },
    { port: 9000, confirm: false },
    { port: 9000, confirm: 'true' },
    { port: 9000, confirm: 1 },
  ].entries()) {
    await server.handle({
      jsonrpc: '2.0',
      id: idx + 1,
      method: 'tools/call',
      params: { name: 'keysmith_test_write', arguments: badArgs },
    });
    const res = replies[idx].result;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error, 'confirmation_required');
    assert.match(res.content[0].text, /ask the user/i);
  }
  assert.equal(handlerCalls, 0, 'handler was never called without confirm: true');
  assert.equal(JSON.parse(fs.readFileSync(sb.configFile, 'utf8')).port, 8787);

  // With confirm: true, handler runs, backup is written (0600), config updates atomically (0600).
  await server.handle({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'keysmith_test_write',
      arguments: { port: 9001, confirm: true, toolSummary: 'Update port', toolAction: 'edit' },
    },
  });
  const okRes = replies[4].result;
  assert.equal(handlerCalls, 1);
  assert.equal(okRes.isError, undefined);
  assert.equal(okRes.structuredContent.changed, true);
  assert.equal(okRes.structuredContent.port, 9001);
  assert.ok(fs.existsSync(okRes.structuredContent.backup), 'backup file exists');
  assert.equal(fs.statSync(okRes.structuredContent.backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sb.configFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(sb.configFile, 'utf8')).port, 9001);

  // Repeating the same port creates no new backup and returns changed: false.
  await server.handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'keysmith_test_write', arguments: { port: 9001, confirm: true } },
  });
  assert.equal(replies[5].result.structuredContent.changed, false);
  assert.equal(replies[5].result.structuredContent.backup, null);

  assert.equal(unregisterTool('keysmith_test_write', reg), true);
  assert.equal(reg.list().length, 0);
});

test('redaction: fake secrets, reference interiors, Keychain args, Cloudflare accountId, workspaceFiles, and bodies never leak', async () => {
  const sb = makeSandbox();
  const fake = makeFakeSecrets(sb.root);
  fs.writeFileSync(sb.configFile, JSON.stringify(fake.config, null, 2), { mode: 0o600 });

  // Fake security binary must never be invoked by MCP config inspection/ping.
  const secCalled = path.join(sb.root, 'security-called');
  const secBin = path.join(sb.root, 'fake-security');
  fs.writeFileSync(secBin, `#!/bin/sh\ntouch "${secCalled}"\necho "SHOULD_NOT_RUN"\nexit 0\n`, { mode: 0o755 });

  // Pre-collect check confirms secrets are registered and collected without running {exec:...}.
  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  process.env.KEYSMITH_SECURITY_BIN = secBin;
  try {
    collectConfigSecrets(sb.configFile);
    assert.equal(fs.existsSync(secCalled), false, 'Keychain binary was never executed');

    const reg = createToolRegistry();
    registerTool(
      {
        name: 'keysmith_test_raw_config',
        description: 'Returns raw config to verify central redaction layer',
        write: false,
        handler: async () => ({
          ...structuredClone(fake.config),
          requestBody: fake.reqBody,
          responseBody: fake.resBody,
          body: { messages: [{ role: 'user', content: fake.reqBody }] },
          diagnostic: [
            `exec={exec:${fake.execInner}}`,
            `json={json:${fake.jsonInner}}`,
            `file={file:${fake.fileInner}}`,
            `dotenv={dotenv:${fake.dotenvInner}}`,
            `auth=Bearer ${fake.bearerToken}`,
            `provider=${fake.providerPrefixed}`,
            `cf=https://api.cloudflare.com/client/v4/accounts/${fake.cfAccountId}/ai/v1`,
            `ws=${fake.workspaceContent}`,
          ].join(' | '),
        }),
      },
      reg,
    );

    registerTool(
      {
        name: 'keysmith_test_throw_secret',
        description: 'Throws an error containing secrets to verify error redaction',
        write: false,
        handler: async () => {
          throw new Error(
            `failed with ${fake.mintedKey} {exec:${fake.execInner}} account=${fake.cfAccountId} body=${fake.resBody}`,
          );
        },
      },
      reg,
    );

    registerTool(
      {
        name: 'keysmith_test_raw_text',
        description: 'Returns raw JSON string in content[]',
        write: false,
        handler: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ ...fake.config, requestBody: fake.reqBody }) }],
        }),
      },
      reg,
    );

    const replies = [];
    const server = createMcpServer({
      registry: reg,
      configFile: sb.configFile,
      dataDir: sb.dataDir,
      send: (m) => replies.push(m),
    });

    for (const [idx, name] of ['keysmith_test_raw_config', 'keysmith_test_throw_secret', 'keysmith_test_raw_text'].entries()) {
      await server.handle({ jsonrpc: '2.0', id: idx + 1, method: 'tools/call', params: { name, arguments: {} } });
    }

    const dump = JSON.stringify(replies);
    for (const secret of fake.forbidden) {
      assert.equal(dump.includes(secret), false, `secret leaked in tool output: ${secret}`);
    }
    // Non-secret booleans and safe {env:VAR} references stay intact.
    assert.equal(replies[0].result.structuredContent.log.body, false);
    assert.equal(replies[0].result.structuredContent.adapters.groq.env.PUBLIC_REGION, 'eu-central');
    assert.deepEqual(replies[0].result.structuredContent.adapters.clitest.workspaceFiles, {
      '.kiro/agents/fake.json': '[redacted]',
    });

    // Also drive the real stdio server via in-memory streams for keysmith_ping.
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = '';
    output.on('data', (c) => (stdout += c));
    const runPromise = startMcpServer({ input, output, configFile: sb.configFile, dataDir: sb.dataDir, loadSlices: false });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'keysmith_ping', arguments: {} } }) + '\n');
    input.end();
    await runPromise;

    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].result.structuredContent.ok, true);
    assert.equal(lines[1].result.structuredContent.configLoaded, true);
    assert.equal(lines[1].result.structuredContent.adapterCount, 6);
    assert.equal(lines[1].result.structuredContent.aliasCount, 1);
    for (const secret of fake.forbidden) {
      assert.equal(stdout.includes(secret), false, `secret leaked in stdio ping output: ${secret}`);
    }
    assert.equal(fs.existsSync(secCalled), false, 'Keychain binary still never executed');
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
  }
});

test('CLI `keysmith mcp` stdio subprocess and `--help` work without leaking secrets or touching config', async () => {
  const sb = makeSandbox();
  const fake = makeFakeSecrets(sb.root);
  fs.writeFileSync(sb.configFile, JSON.stringify(fake.config, null, 2), { mode: 0o600 });
  const beforeConfig = fs.readFileSync(sb.configFile, 'utf8');

  const env = {
    ...process.env,
    HOME: sb.root,
    KEYSMITH_CONFIG: sb.configFile,
    KEYSMITH_DATA: sb.dataDir,
  };

  for (const flag of ['--help', '-h']) {
    const h = spawnSync(process.execPath, [CLI, 'mcp', flag], { env, encoding: 'utf8' });
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /keysmith mcp/);
  }
  assert.equal(fs.readFileSync(sb.configFile, 'utf8'), beforeConfig);

  const proc = spawn(process.execPath, [CLI, 'mcp'], { env });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'keysmith_ping', arguments: {} } }) + '\n');
  proc.stdin.end();

  const code = await new Promise((resolve) => proc.on('close', resolve));
  assert.equal(code, 0, `stderr: ${err}`);
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].result.serverInfo.name, 'keysmith');
  assert.ok(msgs[1].result.tools.some((t) => t.name === 'keysmith_ping'));
  assert.equal(msgs[2].result.structuredContent.adapterCount, 6);
  for (const secret of fake.forbidden) {
    assert.equal((out + err).includes(secret), false, `CLI subprocess leaked secret: ${secret}`);
  }
});

test('injectable `--register` updates installed client configs with backups, preserves existing data, and is idempotent', () => {
  const sb = makeSandbox();
  const fakeHome = path.join(sb.root, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  // Empty home writes nothing and returns manual snippet.
  const emptyRes = registerMcpClients({ homeDir: fakeHome, platform: 'darwin', nodeBin: '/usr/local/bin/node', entry: CLI });
  assert.equal(emptyRes.results.length, 0);
  assert.match(emptyRes.lines.join('\n'), /mcpServers/);
  assert.deepEqual(fs.readdirSync(fakeHome), []);

  // Populate fake client config files & dirs inside temp home only.
  const claudeCode = path.join(fakeHome, '.claude.json');
  fs.writeFileSync(claudeCode, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'echo', args: [] } } }, null, 2));

  const claudeDesktopDir = path.join(fakeHome, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(claudeDesktopDir, { recursive: true });

  const cursorDir = path.join(fakeHome, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });

  const geminiFile = path.join(fakeHome, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(geminiFile), { recursive: true });
  fs.writeFileSync(geminiFile, JSON.stringify({ model: 'default' }, null, 2));

  const opencodeFile = path.join(fakeHome, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(opencodeFile), { recursive: true });
  fs.writeFileSync(opencodeFile, JSON.stringify({ plugin: [] }, null, 2));

  const codexFile = path.join(fakeHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = []\n');

  // Dry run touches nothing.
  const dry = registerMcpClients({ homeDir: fakeHome, platform: 'darwin', nodeBin: '/usr/local/bin/node', entry: CLI, dryRun: true });
  assert.equal(dry.results.length, 6);
  assert.ok(dry.results.every((r) => r.status === 'would-write'));
  assert.equal(JSON.parse(fs.readFileSync(claudeCode, 'utf8')).mcpServers.keysmith, undefined);

  // Real register writes entries, preserves unrelated entries, and backs up existing files.
  const first = registerMcpClients({ homeDir: fakeHome, platform: 'darwin', nodeBin: '/usr/local/bin/node', entry: CLI });
  assert.equal(first.results.length, 6);
  const byClient = Object.fromEntries(first.results.map((r) => [r.client, r]));
  assert.equal(byClient['claude-code'].status, 'updated');
  assert.ok(fs.existsSync(byClient['claude-code'].backup));
  assert.equal(byClient['claude-desktop'].status, 'created');
  assert.equal(byClient['cursor'].status, 'created');
  assert.equal(byClient['gemini-cli'].status, 'updated');
  assert.equal(byClient['opencode'].status, 'updated');
  assert.equal(byClient['codex-cli'].status, 'updated');
  assert.ok(fs.existsSync(byClient['codex-cli'].backup));

  const ccDoc = JSON.parse(fs.readFileSync(claudeCode, 'utf8'));
  assert.equal(ccDoc.theme, 'dark');
  assert.deepEqual(ccDoc.mcpServers.other, { command: 'echo', args: [] });
  assert.deepEqual(ccDoc.mcpServers.keysmith, { command: '/usr/local/bin/node', args: [CLI, 'mcp'] });

  const ocDoc = JSON.parse(fs.readFileSync(opencodeFile, 'utf8'));
  assert.deepEqual(ocDoc.mcp.keysmith, { type: 'local', command: ['/usr/local/bin/node', CLI, 'mcp'], enabled: true });

  const tomlText = fs.readFileSync(codexFile, 'utf8');
  assert.match(tomlText, /model = "gpt-5"/);
  assert.match(tomlText, /\[mcp_servers\.other\]/);
  assert.match(tomlText, /\[mcp_servers\.keysmith\]/);

  // Re-running is idempotent (unchanged).
  const second = registerMcpClients({ homeDir: fakeHome, platform: 'darwin', nodeBin: '/usr/local/bin/node', entry: CLI });
  assert.ok(second.results.every((r) => r.status === 'unchanged'));

  // CLI `keysmith mcp --register` uses temp HOME when invoked as subprocess.
  const cliHome = path.join(sb.root, 'cli-home');
  fs.mkdirSync(cliHome, { recursive: true });
  fs.writeFileSync(path.join(cliHome, '.claude.json'), JSON.stringify({ existing: true }));
  const regCli = spawnSync(process.execPath, [CLI, 'mcp', '--register'], {
    env: { ...process.env, HOME: cliHome, KEYSMITH_CONFIG: sb.configFile, KEYSMITH_DATA: sb.dataDir },
    encoding: 'utf8',
  });
  assert.equal(regCli.status, 0, regCli.stderr);
  const cliCcDoc = JSON.parse(fs.readFileSync(path.join(cliHome, '.claude.json'), 'utf8'));
  assert.equal(cliCcDoc.existing, true);
  assert.deepEqual(cliCcDoc.mcpServers.keysmith.args, [CLI, 'mcp']);
});
