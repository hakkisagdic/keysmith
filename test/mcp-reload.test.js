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
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { createMcpServer, createToolRegistry, loadBuiltInTools } from '../src/mcp.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const LABEL = 'dev.keysmith.gateway';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {}
  }
});

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-reload-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const dataDir = path.join(root, 'data');
  const launchDir = path.join(root, 'Library', 'LaunchAgents');
  const plistFile = path.join(launchDir, `${LABEL}.plist`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
  return { root, configFile, dataDir, plistFile };
}

function writeConfig(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

function writePlist(file) {
  fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>\n', {
    mode: 0o644,
  });
}

async function callTool(server, name, args = {}, id = 1) {
  return await server.handle({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function refused(stderr) {
  return Object.assign(new Error('Command failed: launchctl'), { stderr });
}

function makeFakeLaunchctl({
  initialPid = 41001,
  newPid = 41002,
  initiallyLoaded = true,
  heldPrints = 1,
  bootstrapRefusals = 0,
  hangAfterBootout = false,
  onBootstrap = null,
} = {}) {
  const calls = [];
  let loaded = initiallyLoaded;
  let currentPid = initialPid;
  let bootoutHappened = false;
  let heldLeft = heldPrints;
  let refusalsLeft = bootstrapRefusals;

  const run = (args) => {
    calls.push([...args]);
    const cmd = args[0];
    if (cmd === 'print') {
      if (bootoutHappened && loaded) {
        if (hangAfterBootout) {
          return `${LABEL} = {\n\tstate = running\n\tpid = ${currentPid}\n}\n`;
        }
        if (heldLeft-- > 0) {
          return `${LABEL} = {\n\tstate = running\n\tpid = ${currentPid}\n}\n`;
        }
        loaded = false;
      }
      if (!loaded) {
        throw refused(`Bad request.\nCould not find service "${LABEL}" in domain for user gui: 501\n`);
      }
      return currentPid
        ? `${LABEL} = {\n\tstate = running\n\tpid = ${currentPid}\n}\n`
        : `${LABEL} = {\n\tstate = waiting\n}\n`;
    }
    if (cmd === 'bootout') {
      bootoutHappened = true;
      return '';
    }
    if (cmd === 'bootstrap') {
      if (refusalsLeft-- > 0) {
        throw refused('Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n');
      }
      loaded = true;
      bootoutHappened = false;
      currentPid = newPid;
      if (onBootstrap) onBootstrap();
      return '';
    }
    throw new Error(`unexpected launchctl command: ${args.join(' ')}`);
  };

  return { run, calls };
}

async function startFakeHealthzServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

test('loadBuiltInTools registers keysmith_reload with destructive annotations and CLI exposes it in tools/list', async () => {
  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const tools = reg.list();
  const reloadTool = tools.find((t) => t.name === 'keysmith_reload');
  assert.ok(reloadTool, 'keysmith_reload is registered');
  assert.deepEqual(reloadTool.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.equal(reloadTool.inputSchema.type, 'object');
  assert.equal(reloadTool.inputSchema.properties.confirm?.type, 'boolean');

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
  const listed = msgs[1].result.tools.find((t) => t.name === 'keysmith_reload');
  assert.ok(listed, 'CLI tools/list includes keysmith_reload');
  assert.deepEqual(listed.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.equal(listed.inputSchema.properties.confirm?.type, 'boolean');
});

test('keysmith_reload refuses without confirm: true without calling launchctl, /healthz, or touching config', async () => {
  const sb = makeSandbox();
  writePlist(sb.plistFile);
  writeConfig(sb.configFile, {
    host: '127.0.0.1',
    port: 18787,
    adapters: { a1: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_KEY}' } },
  });
  const beforeSha = sha(sb.configFile);

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const launcher = makeFakeLaunchctl();
  let fetchHits = 0;
  const replies = [];

  const server = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => replies.push(m),
    context: {
      homeDir: sb.root,
      plistFile: sb.plistFile,
      launchctl: launcher.run,
      fetch: async () => {
        fetchHits++;
        throw new Error('fetch must not run without confirm: true');
      },
    },
  });

  for (const [idx, badArgs] of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }].entries()) {
    await callTool(server, 'keysmith_reload', badArgs, idx + 1);
    const res = replies[idx].result;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error, 'confirmation_required');
  }

  assert.equal(launcher.calls.length, 0, 'launchctl never called without confirm: true');
  assert.equal(fetchHits, 0, '/healthz never fetched without confirm: true');
  assert.equal(sha(sb.configFile), beforeSha, 'config untouched');
  assert.deepEqual(fs.readdirSync(sb.root).filter((f) => f.includes('.bak-')), []);
});

test('keysmith_reload restarts via fake launchd, waits for /healthz transition, reports PID change and source counts', async () => {
  const sb = makeSandbox();
  writePlist(sb.plistFile);

  let phase = 'before';
  let postBootPolls = 0;
  const gw = await startFakeHealthzServer((req, res) => {
    assert.equal(req.url, '/healthz');
    if (phase === 'before') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, uptime_s: 42, adapters: 2, in_flight: 0 }));
    }
    postBootPolls++;
    if (postBootPolls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        uptime_s: 1,
        adapters: 2,
        failed_to_load: 0,
        alias_warnings: 0,
        unexpectedBodyField: 'SHOULD_NOT_APPEAR',
      }),
    );
  });

  writeConfig(sb.configFile, {
    host: '127.0.0.1',
    port: gw.port,
    auth: { enabled: true, keys: [] },
    adapters: {
      a1: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_A1}' },
      a2: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_A2}' },
      a3: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_A3}', disabled: true },
    },
  });
  const beforeSha = sha(sb.configFile);
  fs.writeFileSync(path.join(sb.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 41001, port: gw.port }), { mode: 0o600 });

  const launcher = makeFakeLaunchctl({
    initialPid: 41001,
    newPid: 41002,
    heldPrints: 2,
    bootstrapRefusals: 1,
    onBootstrap: () => {
      phase = 'after';
      fs.writeFileSync(path.join(sb.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 41002, port: gw.port }), { mode: 0o600 });
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
    context: {
      homeDir: sb.root,
      plistFile: sb.plistFile,
      launchctl: launcher.run,
      isPidAlive: (pid) => pid === 41001 || pid === 41002,
      reloadTimeoutMs: 1000,
      reloadIntervalMs: 1,
      healthzWaitMs: 3000,
      healthzPollMs: 10,
    },
  });

  await callTool(server, 'keysmith_reload', { confirm: true }, 1);
  const res = replies[0].result;
  assert.equal(res.isError, undefined, JSON.stringify(res));
  const out = res.structuredContent;

  assert.equal(out.ok, true);
  assert.equal(out.restarted, true);
  assert.equal(out.label, LABEL);
  assert.equal(out.previousPid, 41001);
  assert.equal(out.pid, 41002);
  assert.equal(out.pidChanged, true);
  assert.equal(out.port, gw.port);
  assert.equal(out.healthzStatus, 'ok');
  assert.deepEqual(out.healthz, {
    ok: true,
    reachable: true,
    httpStatus: 200,
    uptimeSeconds: 1,
    adapters: 2,
    failedToLoad: 0,
    aliasWarnings: 0,
  });
  assert.equal(typeof out.latencyMs, 'number');
  assert.ok(out.latencyMs >= 0);
  assert.equal(out.inFlight, 0);
  assert.equal(out.inFlightWarning, null);
  assert.equal(out.enabledSources, 2);
  assert.equal(out.disabledSources, 1);
  assert.equal(out.totalSources, 3);
  assert.equal(postBootPolls >= 2, true, 'waited through 503 until /healthz returned 200');
  assert.equal(sha(sb.configFile), beforeSha, 'reload does not modify config');
  assert.equal(JSON.stringify(replies).includes('SHOULD_NOT_APPEAR'), false);

  const cmds = launcher.calls.map((c) => c[0]);
  assert.ok(cmds.includes('bootout'));
  assert.ok(cmds.includes('bootstrap'));
});

test('keysmith_reload warns when requests are in flight (fake /healthz and real Gateway.inFlight)', async () => {
  // 1. Fake HTTP server reporting in_flight: 2 on pre-reload /healthz.
  const sb1 = makeSandbox();
  writePlist(sb1.plistFile);
  let phase = 'before';
  const gw1 = await startFakeHealthzServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (phase === 'before') {
      return res.end(JSON.stringify({ ok: true, uptime_s: 10, in_flight: 2 }));
    }
    res.end(JSON.stringify({ ok: true, uptime_s: 0, in_flight: 0 }));
  });
  writeConfig(sb1.configFile, {
    host: '127.0.0.1',
    port: gw1.port,
    adapters: { a1: { kind: 'http', baseUrl: 'https://api.example.invalid/v1', apiKey: '{env:FAKE_K1}' } },
  });
  fs.writeFileSync(path.join(sb1.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 42001, port: gw1.port }), { mode: 0o600 });

  const launcher1 = makeFakeLaunchctl({
    initialPid: 42001,
    newPid: 42002,
    onBootstrap: () => {
      phase = 'after';
      fs.writeFileSync(path.join(sb1.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 42002, port: gw1.port }), { mode: 0o600 });
    },
  });

  const reg = createToolRegistry();
  await loadBuiltInTools(reg);
  const replies1 = [];
  const mcp1 = createMcpServer({
    registry: reg,
    configFile: sb1.configFile,
    dataDir: sb1.dataDir,
    send: (m) => replies1.push(m),
    context: {
      homeDir: sb1.root,
      plistFile: sb1.plistFile,
      launchctl: launcher1.run,
      isPidAlive: (pid) => pid === 42001 || pid === 42002,
      reloadTimeoutMs: 500,
      reloadIntervalMs: 1,
      healthzWaitMs: 2000,
      healthzPollMs: 10,
    },
  });

  await callTool(mcp1, 'keysmith_reload', { confirm: true }, 1);
  const out1 = replies1[0].result.structuredContent;
  assert.equal(out1.restarted, true);
  assert.equal(out1.inFlight, 2);
  assert.match(out1.inFlightWarning, /2 requests in flight/);

  // 2. Real Gateway + createServer with a live held request so gateway.inFlight === 1.
  const sb2 = makeSandbox();
  writePlist(sb2.plistFile);
  let releaseUpstream;
  let markUpstreamReached;
  const upstreamReached = new Promise((resolve) => (markUpstreamReached = resolve));
  const upstream = http.createServer((_req, res) => {
    markUpstreamReached();
    new Promise((resolve) => (releaseUpstream = resolve)).then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => upstream.close(resolve)));

  const gwKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  writeConfig(sb2.configFile, {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: true, keys: [gwKey] },
    adapters: {
      stub: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'tok_fakeStubKey123456',
      },
    },
  });

  const prevCfg = process.env.KEYSMITH_CONFIG;
  const prevData = process.env.KEYSMITH_DATA;
  process.env.KEYSMITH_CONFIG = sb2.configFile;
  process.env.KEYSMITH_DATA = sb2.dataDir;
  let realGateway;
  let realServer;
  try {
    const loadedCfg = loadConfig({ path: sb2.configFile, mint: false });
    const usage = new UsageLog(path.join(sb2.dataDir, 'usage.jsonl'));
    realGateway = new Gateway(loadedCfg, { log: () => {}, usage });
    realServer = createServer(realGateway, loadedCfg, { usage, log: () => {} });
    await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    const gwPort = realServer.address().port;
    fs.writeFileSync(path.join(sb2.dataDir, 'keysmith.pid'), JSON.stringify({ pid: 43001, port: gwPort }), { mode: 0o600 });

    const inFlightReq = fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gwKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub/m1', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    await upstreamReached;
    assert.equal(realGateway.inFlight, 1);

    const launcher2 = makeFakeLaunchctl({ initialPid: 43001, newPid: 43002 });
    const replies2 = [];
    const mcp2 = createMcpServer({
      registry: reg,
      configFile: sb2.configFile,
      dataDir: sb2.dataDir,
      send: (m) => replies2.push(m),
      context: {
        homeDir: sb2.root,
        plistFile: sb2.plistFile,
        gateway: realGateway,
        gatewayUrl: `http://127.0.0.1:${gwPort}`,
        launchctl: launcher2.run,
        isPidAlive: (pid) => pid === 43001 || pid === 43002,
        reloadTimeoutMs: 500,
        reloadIntervalMs: 1,
        healthzWaitMs: 2000,
        healthzPollMs: 10,
      },
    });

    await callTool(mcp2, 'keysmith_reload', { confirm: true }, 2);
    const out2 = replies2[0].result.structuredContent;
    assert.equal(out2.restarted, true);
    assert.equal(out2.inFlight, 1);
    assert.match(out2.inFlightWarning, /1 request in flight/);
    assert.equal(out2.healthzStatus, 'ok');
    assert.equal(JSON.stringify(replies2).includes(gwKey), false);

    releaseUpstream();
    const chatRes = await inFlightReq;
    assert.equal(chatRes.status, 200);
    await chatRes.text();
  } finally {
    if (realServer) await new Promise((resolve) => realServer.close(resolve));
    if (realGateway) await realGateway.close();
    if (prevCfg === undefined) delete process.env.KEYSMITH_CONFIG;
    else process.env.KEYSMITH_CONFIG = prevCfg;
    if (prevData === undefined) delete process.env.KEYSMITH_DATA;
    else process.env.KEYSMITH_DATA = prevData;
  }
});

test('keysmith_reload handles missing plist, reloadAgent failure, and unhealthy/unreachable /healthz', async () => {
  const reg = createToolRegistry();
  await loadBuiltInTools(reg);

  // 1. Missing LaunchAgent plist -> refuses before bootout/bootstrap.
  const sbMissing = makeSandbox();
  writeConfig(sbMissing.configFile, { port: 18787, adapters: {} });
  const launcherMissing = makeFakeLaunchctl();
  const repliesMissing = [];
  const mcpMissing = createMcpServer({
    registry: reg,
    configFile: sbMissing.configFile,
    dataDir: sbMissing.dataDir,
    send: (m) => repliesMissing.push(m),
    context: {
      homeDir: sbMissing.root,
      plistFile: sbMissing.plistFile,
      launchctl: launcherMissing.run,
    },
  });
  await callTool(mcpMissing, 'keysmith_reload', { confirm: true }, 1);
  assert.equal(repliesMissing[0].result.isError, true);
  assert.equal(repliesMissing[0].result.structuredContent.restarted, false);
  assert.match(repliesMissing[0].result.structuredContent.error, /plist is not installed/i);
  assert.equal(launcherMissing.calls.length, 0);

  // 2. reloadAgent timeout (bootout held forever) -> error scrubbed, restarted: false.
  const sbTimeout = makeSandbox();
  writePlist(sbTimeout.plistFile);
  writeConfig(sbTimeout.configFile, { port: 18787, adapters: {} });
  const launcherStuck = makeFakeLaunchctl({ hangAfterBootout: true });
  const repliesTimeout = [];
  const mcpTimeout = createMcpServer({
    registry: reg,
    configFile: sbTimeout.configFile,
    dataDir: sbTimeout.dataDir,
    send: (m) => repliesTimeout.push(m),
    context: {
      homeDir: sbTimeout.root,
      plistFile: sbTimeout.plistFile,
      launchctl: launcherStuck.run,
      isPidAlive: () => false,
      reloadTimeoutMs: 40,
      reloadIntervalMs: 5,
    },
  });
  await callTool(mcpTimeout, 'keysmith_reload', { confirm: true }, 2);
  assert.equal(repliesTimeout[0].result.isError, true);
  assert.equal(repliesTimeout[0].result.structuredContent.restarted, false);
  assert.equal(JSON.stringify(repliesTimeout[0]).includes(sbTimeout.root), false, 'sandbox path scrubbed from error');

  // 3. /healthz remains unreachable on closed local port after reloadAgent succeeds.
  const deadProbe = http.createServer();
  await new Promise((resolve) => deadProbe.listen(0, '127.0.0.1', resolve));
  const deadPort = deadProbe.address().port;
  await new Promise((resolve) => deadProbe.close(resolve));

  const sbUnreach = makeSandbox();
  writePlist(sbUnreach.plistFile);
  writeConfig(sbUnreach.configFile, { port: deadPort, adapters: {} });
  const launcherUnreach = makeFakeLaunchctl({ initiallyLoaded: false, newPid: 44002 });
  const repliesUnreach = [];
  const mcpUnreach = createMcpServer({
    registry: reg,
    configFile: sbUnreach.configFile,
    dataDir: sbUnreach.dataDir,
    send: (m) => repliesUnreach.push(m),
    context: {
      homeDir: sbUnreach.root,
      plistFile: sbUnreach.plistFile,
      launchctl: launcherUnreach.run,
      isPidAlive: (p) => p === 44002,
      reloadTimeoutMs: 500,
      reloadIntervalMs: 1,
      healthzWaitMs: 60,
      healthzPollMs: 15,
      healthzTimeoutMs: 200,
    },
  });
  await callTool(mcpUnreach, 'keysmith_reload', { confirm: true }, 3);
  assert.equal(repliesUnreach[0].result.isError, true);
  assert.equal(repliesUnreach[0].result.structuredContent.restarted, true);
  assert.equal(repliesUnreach[0].result.structuredContent.healthzStatus, 'unreachable');

  // 4. /healthz returns 503 past wait deadline -> unhealthy.
  const sick = await startFakeHealthzServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  const sbSick = makeSandbox();
  writePlist(sbSick.plistFile);
  writeConfig(sbSick.configFile, { port: sick.port, adapters: {} });
  const launcherSick = makeFakeLaunchctl({ initiallyLoaded: false, newPid: 45002 });
  const repliesSick = [];
  const mcpSick = createMcpServer({
    registry: reg,
    configFile: sbSick.configFile,
    dataDir: sbSick.dataDir,
    send: (m) => repliesSick.push(m),
    context: {
      homeDir: sbSick.root,
      plistFile: sbSick.plistFile,
      launchctl: launcherSick.run,
      isPidAlive: (p) => p === 45002,
      reloadTimeoutMs: 500,
      reloadIntervalMs: 1,
      healthzWaitMs: 60,
      healthzPollMs: 15,
    },
  });
  await callTool(mcpSick, 'keysmith_reload', { confirm: true }, 4);
  assert.equal(repliesSick[0].result.isError, true);
  assert.equal(repliesSick[0].result.structuredContent.restarted, true);
  assert.equal(repliesSick[0].result.structuredContent.healthzStatus, 'unhealthy');
  assert.equal(repliesSick[0].result.structuredContent.healthz.httpStatus, 503);
});

test('keysmith_approved computes pending free-flag changes from catalogue diff and clears them after owner review', async () => {
  const sb = makeSandbox();
  const catFile = path.join(sb.root, 'catalogue.json');
  writeConfig(sb.configFile, {
    catalogue: '~/catalogue.json',
    discovery: { enabled: true },
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:FAKE_GROQ_KEY}',
        modelsOnly: true,
        models: ['m-approved-still-free', 'm-approved-became-paid'],
      },
      tokenrouter: {
        kind: 'http',
        wire: 'openai',
        baseUrl: 'https://api.example.invalid/v1',
        apiKey: '{env:FAKE_TR_KEY}',
        freeOnly: true,
      },
    },
  });

  fs.writeFileSync(
    catFile,
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'groq-src',
          reach: { keysmith: 'groq' },
          limits: { requestsPerMinute: 10 },
          models: [
            { id: 'm-approved-still-free', tier: 'free' },
            { id: 'm-approved-became-paid', tier: 'paid' },
            { id: 'm-unapproved-became-free', tier: 'free' },
            { id: 'm-unapproved-still-paid', tier: 'paid' },
          ],
        },
        {
          id: 'tr-src',
          reach: { keysmith: 'tokenrouter' },
          limits: { requestsPerMinute: 10 },
          models: [
            { id: 'tr-kept-free', tier: 'free' },
            { id: 'tr-dropped-free', tier: 'free' },
            { id: 'tr-was-paid', tier: 'paid' },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );

  writeDiscovered(discoveredPath(sb.dataDir, 'tokenrouter'), ['tr-kept-free', 'tr-was-paid', 'tr-new-free']);

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

  await callTool(server, 'keysmith_approved', {}, 1);
  const allApproved = replies[0].result.structuredContent;
  assert.equal(allApproved.ok, true);
  assert.deepEqual(allApproved.approved, {
    groq: ['m-approved-still-free', 'm-approved-became-paid'],
  });
  assert.deepEqual(allApproved.pending, [
    { source: 'groq', model: 'm-approved-became-paid', oldFree: true, newFree: false },
    { source: 'groq', model: 'm-unapproved-became-free', oldFree: false, newFree: true },
    { source: 'tokenrouter', model: 'tr-dropped-free', oldFree: true, newFree: false },
    { source: 'tokenrouter', model: 'tr-was-paid', oldFree: false, newFree: true },
    { source: 'tokenrouter', model: 'tr-new-free', oldFree: false, newFree: true },
  ]);
  for (const item of allApproved.pending) {
    assert.deepEqual(Object.keys(item).sort(), ['model', 'newFree', 'oldFree', 'source']);
  }

  // Filter by source.
  await callTool(server, 'keysmith_approved', { source: 'groq' }, 2);
  assert.deepEqual(replies[1].result.structuredContent.pending, [
    { source: 'groq', model: 'm-approved-became-paid', oldFree: true, newFree: false },
    { source: 'groq', model: 'm-unapproved-became-free', oldFree: false, newFree: true },
  ]);

  // Owner approves newly free model and revokes model that turned paid -> groq pending clears.
  await callTool(server, 'keysmith_model_approve', { source: 'groq', model: 'm-unapproved-became-free', confirm: true }, 3);
  await callTool(server, 'keysmith_model_revoke', { source: 'groq', model: 'm-approved-became-paid', confirm: true }, 4);
  await callTool(server, 'keysmith_approved', { source: 'groq' }, 5);
  assert.deepEqual(replies[4].result.structuredContent.approved, {
    groq: ['m-approved-still-free', 'm-unapproved-became-free'],
  });
  assert.deepEqual(replies[4].result.structuredContent.pending, []);

  // previousCatalogue diff when an approved model's catalogue entry shifts free -> paid.
  await callTool(server, 'keysmith_model_approve', { source: 'groq', model: 'm-shifted', confirm: true }, 6);
  const prevCat = path.join(sb.root, 'catalogue-prev.json');
  fs.writeFileSync(
    prevCat,
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'groq-src',
          reach: { keysmith: 'groq' },
          limits: { requestsPerMinute: 10 },
          models: [
            { id: 'm-approved-still-free', tier: 'free' },
            { id: 'm-shifted', tier: 'free' },
          ],
        },
      ],
    }),
  );
  fs.writeFileSync(
    catFile,
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'groq-src',
          reach: { keysmith: 'groq' },
          limits: { requestsPerMinute: 10 },
          models: [
            { id: 'm-approved-still-free', tier: 'free' },
            { id: 'm-shifted', tier: 'paid' },
          ],
        },
      ],
    }),
  );
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(catFile, future, future);

  const repliesPrev = [];
  const serverPrev = createMcpServer({
    registry: reg,
    configFile: sb.configFile,
    dataDir: sb.dataDir,
    send: (m) => repliesPrev.push(m),
    context: { homeDir: sb.root, previousCatalogue: prevCat },
  });
  await callTool(serverPrev, 'keysmith_approved', { source: 'groq' }, 7);
  assert.deepEqual(repliesPrev[0].result.structuredContent.pending, [
    { source: 'groq', model: 'm-shifted', oldFree: true, newFree: false },
  ]);
});

test('redaction: planted fake secrets in config, catalogue, and /healthz never leak in reload or approved outputs', async () => {
  const sb = makeSandbox();
  writePlist(sb.plistFile);

  const mintedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const scopedKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const literalKey = 'tok_' + 'fakeReloadSliceLiteral9911';
  const bearerHeader = 'hdr_' + 'fakeReloadSliceBearer8822';
  const envSecret = 'env_' + 'fakeReloadSliceEnvSecret7733';
  const kcSvc = 'fake-reload-kc-svc-601';
  const kcAcct = 'fake-reload-kc-acct-602';
  const execInner = `/usr/bin/security find-generic-password -s ${kcSvc} -a ${kcAcct} -w`;
  const jsonFile = path.join(sb.root, 'creds-603.json');
  const jsonField = 'provider.secretToken603';
  const jsonValue = 'json_fakeReloadSecret603';
  const filePath = path.join(sb.root, 'token-604.txt');
  const fileValue = 'file_fakeReloadSecret604';
  const dotenvPath = path.join(sb.root, '.env.605');
  const dotenvVar = 'DOTENV_FAKE_RELOAD_605';
  const dotenvValue = 'dotenv_fakeReloadSecret605';
  const cfAccountId = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const wsContent = 'WS_RELOAD_SLICE_SECRET_606_NEVER_LEAK';
  const healthSecret = 'HEALTH_BODY_RELOAD_SECRET_607';
  const errHealthSecret = 'HEALTH_ERR_BODY_RELOAD_SECRET_608';
  const catExtraSecret = 'CATALOGUE_EXTRA_SECRET_609';

  fs.writeFileSync(jsonFile, JSON.stringify({ provider: { nested: jsonValue } }), { mode: 0o600 });
  fs.writeFileSync(filePath, fileValue + '\n', { mode: 0o600 });
  fs.writeFileSync(dotenvPath, `${dotenvVar}=${dotenvValue}\n`, { mode: 0o600 });

  let failHealth = false;
  const gw = await startFakeHealthzServer((_req, res) => {
    if (failHealth) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, leak: errHealthSecret }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime_s: 3, adapters: 6, secretBody: healthSecret }));
  });

  const catFile = path.join(sb.root, 'catalogue-sec.json');
  fs.writeFileSync(
    catFile,
    JSON.stringify({
      version: 1,
      secretNote: catExtraSecret,
      sources: [
        {
          id: 'kc-cat',
          secretField: catExtraSecret,
          reach: { keysmith: 'kc_src' },
          limits: { requestsPerMinute: 5 },
          models: [
            { id: 'm-kc', tier: 'paid', note: catExtraSecret },
            { id: 'm-kc-free', tier: 'free' },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );

  writeConfig(sb.configFile, {
    host: '127.0.0.1',
    port: gw.port,
    catalogue: catFile,
    auth: {
      enabled: true,
      keys: [mintedKey, { key: scopedKey, label: 'reload-test', allow: ['kc_src'] }],
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
        workspaceFiles: { '.kiro/agents/reload-test.json': wsContent },
      },
    },
  });

  const secCalled = path.join(sb.root, 'security-called');
  const secBin = path.join(sb.root, 'fake-security');
  fs.writeFileSync(secBin, `#!/bin/sh\ntouch "${secCalled}"\nexit 0\n`, { mode: 0o755 });
  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  process.env.KEYSMITH_SECURITY_BIN = secBin;

  try {
    const reg = createToolRegistry();
    await loadBuiltInTools(reg);
    const launcher = makeFakeLaunchctl({ initialPid: 46001, newPid: 46002 });
    const replies = [];
    const server = createMcpServer({
      registry: reg,
      configFile: sb.configFile,
      dataDir: sb.dataDir,
      send: (m) => replies.push(m),
      context: {
        homeDir: sb.root,
        plistFile: sb.plistFile,
        launchctl: launcher.run,
        isPidAlive: (p) => p === 46001 || p === 46002,
        reloadTimeoutMs: 500,
        reloadIntervalMs: 1,
        healthzWaitMs: 80,
        healthzPollMs: 15,
      },
    });

    await callTool(server, 'keysmith_reload', { confirm: true }, 1);
    failHealth = true;
    await callTool(server, 'keysmith_reload', { confirm: true }, 2);
    await callTool(server, 'keysmith_approved', {}, 3);

    const dump = JSON.stringify(replies);
    const forbidden = [
      sb.root,
      sb.configFile,
      sb.dataDir,
      mintedKey,
      scopedKey,
      literalKey,
      bearerHeader,
      envSecret,
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
      healthSecret,
      errHealthSecret,
      catExtraSecret,
    ];
    for (const secret of forbidden) {
      assert.equal(dump.includes(secret), false, `secret leaked in reload/approved output: ${secret}`);
    }
    assert.equal(fs.existsSync(secCalled), false, 'real/env Keychain binary was never executed');
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
  }
});
