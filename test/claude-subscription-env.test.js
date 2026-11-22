/**
 * Claude Code subscription hardening (key scope, single-leg aliases, and env scrubbing):
 *
 * 1. `claudeSubscriptionEnv` / `isClaudeSubscriptionAdapter` strip ANTHROPIC_*, CLAUDE_API_KEY,
 *    CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY|MANTLE on every run path
 *    (text, vision, EMULATE, modelsFrom, and the MCP bridge) — even when present in the gateway
 *    environment OR configured in the adapter's own `env` map — while preserving
 *    CLAUDE_CODE_DISABLE_AUTO_MEMORY, CLAUDE_CONFIG_DIR, and unrelated CLIs sharing parser
 *    `claude-stream-json` (such as `qodercli`).
 * 2. A scoped key with an allow-list and `claude-api*` / `claude-failover*` deny patterns cannot
 *    reach API-billed HTTP adapters while still reaching `claude` and single-leg aliases.
 * 3. A single-leg alias pointing only at `claude/<model>` fails with 502 (or 503 when disabled)
 *    and never falls through to an API adapter.
 *
 * All credentials and adapter/alias names here are synthetic.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { claudeSubscriptionEnv, isClaudeSubscriptionAdapter } from '../src/util.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { claudeDriver } from '../src/bridge/clis.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const SUB_KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const API_KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Split synthetic secret-looking strings so static scanners recognise them as non-secrets.
const HAZARDOUS_ENV = {
  ANTHROPIC_API_KEY: 'sk-' + 'ant-test-' + '000000000000',
  ANTHROPIC_AUTH_TOKEN: 'tok-' + 'auth-test-' + '000000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:19999',
  ANTHROPIC_CUSTOM_HEADERS: 'x-test-header: 1',
  ANTHROPIC_FOUNDRY_API_KEY: 'fnd-' + 'test-000000',
  CLAUDE_API_KEY: 'sk-' + 'claude-test-' + '000000',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-' + 'test-000000',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'parent-sdk',
  CLAUDECODE: '1',
};

const FAKE_BIN_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

process.stdout._handle?.setBlocking?.(true);

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;
const leaked = Object.keys(process.env)
  .filter((k) => /^(?:ANTHROPIC_|CLAUDE_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_)/.test(k))
  .sort();
const markers = {
  CLAUDECODE: process.env.CLAUDECODE ?? null,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
  MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? null,
  MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? null,
  ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? null,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  KEYSMITH_TEST_KEEP: process.env.KEYSMITH_TEST_KEEP ?? null,
};

const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const record = (extra) => {
  if (logFile) {
    fs.appendFileSync(
      logFile,
      JSON.stringify({ bin: path.basename(process.argv[1]), argv, leaked, markers, ...extra }) + '\\n',
    );
  }
};

const mcpConfigPath = val('--mcp-config');
const hasStreamStdin = argv.includes('--input-format') && val('--input-format') === 'stream-json';
const prompt = argv.at(-1) ?? '';

if (hasStreamStdin) {
  let stdinRaw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinRaw += chunk;
  });
  process.stdin.on('end', () => {
    const first = JSON.parse(stdinRaw.split('\\n').find((l) => l.trim()) || '{}');
    if (first.type === 'control_request') {
      record({ mode: 'modelsFrom' });
      line({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: first.request_id,
          response: {
            models: [{ model_id: 'claude-haiku-4-5', supportedEffortLevels: ['low', 'medium', 'high'] }],
          },
        },
      });
      process.exit(0);
    }
    const blockTypes = (first.message?.content || []).map((b) => b.type).join(',');
    record({ mode: 'vision', blockTypes });
    const text = 'VISION_OK:' + blockTypes;
    line({ type: 'assistant', message: { id: 'msg_vis', role: 'assistant', content: [{ type: 'text', text }] } });
    line({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 12, output_tokens: 5 } });
    process.exit(0);
  });
} else if (mcpConfigPath) {
  record({ mode: 'bridge' });
  const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  const [serverName, srv] = Object.entries(cfg.mcpServers || {})[0] || [];
  if (!serverName || !srv) process.exit(2);

  line({ type: 'system', subtype: 'init', tools: ['mcp__' + serverName + '__get_weather'], mcp_servers: [{ name: serverName, status: 'connected' }], model: 'claude-stub' });

  const mcp = spawn(srv.command, srv.args || [], { env: { ...process.env, ...(srv.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const waiting = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
    });

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-stub', version: '0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
  await rpc('tools/list', {});

  const callId = 'call_1';
  line({
    type: 'assistant',
    message: {
      id: 'msg_b1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name: 'mcp__' + serverName + '__get_weather', input: { city: 'Izmir' } }],
      usage: { input_tokens: 20, output_tokens: 5 },
    },
  });
  const toolRes = await rpc('tools/call', { name: 'get_weather', arguments: { city: 'Izmir' } });
  const toolText = (toolRes.result?.content || []).map((c) => c.text).join('');
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: toolText }] } });
  const answer = 'BRIDGE_OK:' + toolText;
  line({
    type: 'assistant',
    message: {
      id: 'msg_b2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
      usage: { input_tokens: 30, output_tokens: 8 },
    },
  });
  line({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { input_tokens: 50, output_tokens: 13 } });
  mcp.stdin.end();
  setTimeout(() => process.exit(0), 30);
} else if (prompt.includes('TRIGGER_FAIL')) {
  record({ mode: 'fail' });
  process.stderr.write('simulated upstream failure\\n');
  process.exit(1);
} else if (prompt.includes('# Answer format') || prompt.includes('<<<TOOL_RESULT')) {
  record({ mode: 'emulate' });
  const reply = prompt.includes('<<<TOOL_RESULT')
    ? JSON.stringify({ final: 'EMULATE_OK' })
    : JSON.stringify({ tool_calls: [{ name: 'get_weather', arguments: { city: 'Izmir' } }] });
  line({ type: 'assistant', message: { id: 'msg_emu', role: 'assistant', content: [{ type: 'text', text: reply }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: 15, output_tokens: 7 } });
  process.exit(0);
} else {
  record({ mode: 'text' });
  const reply = 'TEXT_OK';
  line({ type: 'assistant', message: { id: 'msg_txt', role: 'assistant', content: [{ type: 'text', text: reply }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 4 } });
  process.exit(0);
}
`;

let dir;
let fakeClaudeBin;
let fakeQoderBin;
let fakeLogFile;
let stubHttp;
let stubHttpUrl;
const httpHits = [];
let gateway;
let server;
let base;
let usageLog;
let savedEnv;

const readRuns = () =>
  fs.existsSync(fakeLogFile)
    ? fs
        .readFileSync(fakeLogFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function post(route, body, key = SUB_KEY) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-csub-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fakeClaudeBin = path.join(binDir, 'claude');
  fakeQoderBin = path.join(binDir, 'qodercli');
  fs.writeFileSync(fakeClaudeBin, FAKE_BIN_SOURCE, { mode: 0o755 });
  fs.writeFileSync(fakeQoderBin, FAKE_BIN_SOURCE, { mode: 0o755 });
  fakeLogFile = path.join(dir, 'runs.jsonl');

  const keepVars = {
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-cfg'),
    KEYSMITH_TEST_KEEP: 'preserved',
  };
  const allInjected = { ...HAZARDOUS_ENV, ...keepVars };
  savedEnv = Object.fromEntries(Object.keys(allInjected).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(allInjected)) process.env[k] = v;

  stubHttp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      httpHits.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 1,
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'HTTP_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
  });
  await new Promise((r) => stubHttp.listen(0, '127.0.0.1', r));
  stubHttpUrl = `http://127.0.0.1:${stubHttp.address().port}/v1`;

  const claudeProfile = structuredClone(CLI_PROFILES.claude);
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        {
          key: SUB_KEY,
          label: 'sub-worker',
          allow: ['claude', 'alias:claude-sonnet-5-5', 'alias:claude-opus-5-5', 'alias:claude-haiku-4-5'],
          deny: ['claude-api*', 'claude-failover*'],
          perDay: 200,
          perMinute: 30,
        },
        { key: API_KEY, label: 'api-client' },
      ],
    },
    limits: {
      streamHoldMs: 300,
      streamKeepaliveMs: 60,
      bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 4, maxSessionsPerKey: 2 },
    },
    adapters: {
      claude: {
        ...claudeProfile,
        bin: fakeClaudeBin,
        cwd: path.join(dir, 'ws-claude'),
        models: ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
        toolMode: 'auto',
        timeoutMs: 20_000,
        bridge: { ...claudeProfile.bridge, readyTimeoutMs: 15_000, toolResultTimeoutMs: 30_000 },
        // Attempt to re-introduce API vars via adapter config `env`: must still be stripped.
        env: {
          FAKE_CLAUDE_LOG: fakeLogFile,
          ANTHROPIC_API_KEY: 'sk-' + 'cfg-attempt-' + '0000',
          CLAUDE_API_KEY: 'sk-' + 'cfg-claude-' + '0000',
        },
      },
      'claude-off': {
        ...claudeProfile,
        bin: fakeClaudeBin,
        cwd: path.join(dir, 'ws-claude-off'),
        models: ['claude-haiku-4-5'],
        disabled: true,
      },
      'qoder-json': {
        kind: 'cli',
        bin: fakeQoderBin,
        args: ['-p', '{prompt}'],
        parser: 'claude-stream-json',
        cwd: path.join(dir, 'ws-qoder'),
        models: ['m'],
        explicitOnly: true,
        timeoutMs: 15_000,
        env: { FAKE_CLAUDE_LOG: fakeLogFile },
      },
      'claude-api-promo': {
        kind: 'http',
        baseUrl: stubHttpUrl,
        wire: 'openai',
        apiKey: 'sk-' + 'http-stub-' + '0001',
        models: ['claude-haiku-4-5'],
      },
      'claude-api': {
        kind: 'http',
        baseUrl: stubHttpUrl,
        wire: 'openai',
        apiKey: 'sk-' + 'http-stub-' + '0002',
        models: ['claude-haiku-4-5'],
      },
      'claude-failover-api': {
        kind: 'http',
        baseUrl: stubHttpUrl,
        wire: 'openai',
        apiKey: 'sk-' + 'http-stub-' + '0003',
        models: ['claude-haiku-4-5'],
      },
    },
    aliases: {
      'claude-haiku-4-5': ['claude/claude-haiku-4-5'],
      'claude-sonnet-5-5': ['claude/claude-sonnet-5-5'],
      'claude-opus-5-5': ['claude/claude-opus-5-5'],
      'claude-haiku-off': ['claude-off/claude-haiku-4-5'],
    },
    aliasPolicy: {
      'claude-haiku-4-5': { allowExplicitOnly: true },
      'claude-sonnet-5-5': { allowExplicitOnly: true },
      'claude-opus-5-5': { allowExplicitOnly: true },
      'claude-haiku-off': { allowExplicitOnly: true },
    },
    fetchMedia: false,
  };

  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await gateway.close();
  await new Promise((r) => server.close(r));
  await new Promise((r) => stubHttp.close(r));
  for (const [k, v] of Object.entries(savedEnv || {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- unit checks */

test('claudeSubscriptionEnv strips ANTHROPIC_*, CLAUDE_API_KEY, OAuth token, and cloud-provider flags without mutating input or dropping safe Claude knobs', () => {
  const input = {
    ...HAZARDOUS_ENV,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CONFIG_DIR: '/tmp/cfg',
    MCP_TOOL_TIMEOUT: '90000',
    MCP_TIMEOUT: '30000',
    ENABLE_TOOL_SEARCH: 'false',
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    PWD: '/tmp/ws',
    UNRELATED_VAR: 'keep',
  };
  const snapshot = { ...input };
  const cleaned = claudeSubscriptionEnv(input);

  assert.deepEqual(input, snapshot, 'input object must not be mutated');
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'CLAUDE_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
  ]) {
    assert.equal(Object.hasOwn(cleaned, k), false, `${k} must be deleted`);
  }

  assert.equal(cleaned.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(cleaned.CLAUDE_CONFIG_DIR, '/tmp/cfg');
  assert.equal(cleaned.MCP_TOOL_TIMEOUT, '90000');
  assert.equal(cleaned.MCP_TIMEOUT, '30000');
  assert.equal(cleaned.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(cleaned.PATH, '/usr/bin');
  assert.equal(cleaned.HOME, '/tmp/home');
  assert.equal(cleaned.PWD, '/tmp/ws');
  assert.equal(cleaned.UNRELATED_VAR, 'keep');
});

test('isClaudeSubscriptionAdapter detects Claude Code adapters while sparing other claude-stream-json CLIs', () => {
  assert.equal(isClaudeSubscriptionAdapter(null), false);
  assert.equal(isClaudeSubscriptionAdapter({ bin: 'claude', parser: 'claude-stream-json' }), true);
  assert.equal(isClaudeSubscriptionAdapter({ bin: '/opt/homebrew/bin/claude', parser: 'claude-stream-json' }), true);
  assert.equal(isClaudeSubscriptionAdapter({ bin: '~/.local/bin/claude', parser: 'claude-stream-json' }), true);
  assert.equal(isClaudeSubscriptionAdapter({ bin: 'claude.exe', parser: 'claude-stream-json' }), true);
  assert.equal(isClaudeSubscriptionAdapter({ bin: '/tmp/stub.mjs', parser: 'claude-stream-json', bridge: { driver: 'claude' } }), true);

  assert.equal(isClaudeSubscriptionAdapter({ bin: 'qodercli', parser: 'claude-stream-json' }), false);
  assert.equal(isClaudeSubscriptionAdapter({ bin: 'qodercli', parser: 'claude-stream-json', bridge: { driver: 'qoder' } }), false);
  assert.equal(isClaudeSubscriptionAdapter({ bin: 'mimo', parser: 'claude-stream-json' }), false);
  assert.equal(isClaudeSubscriptionAdapter({ bin: 'claude', parser: 'raw' }), false);
});

test('CliAdapter._childEnv and claudeDriver.plan drop hazardous vars even when configured on adapter.env, while qodercli keeps its env', () => {
  const claudeAdapter = new CliAdapter('cc-unit', {
    ...structuredClone(CLI_PROFILES.claude),
    bin: fakeClaudeBin,
    cwd: path.join(dir, 'ws-unit-cc'),
    env: {
      ANTHROPIC_API_KEY: 'sk-' + 'adapter-env-' + '1111',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888',
      CLAUDE_API_KEY: 'sk-' + 'adapter-claude-' + '2222',
      CLAUDE_CODE_USE_VERTEX: '1',
      KEEP_CUSTOM: 'yes',
    },
  });
  const childEnv = claudeAdapter._childEnv();
  for (const k of Object.keys(HAZARDOUS_ENV)) {
    assert.equal(Object.hasOwn(childEnv, k), false, `_childEnv must strip ${k}`);
  }
  assert.equal(childEnv.KEEP_CUSTOM, 'yes');
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, path.join(dir, 'claude-cfg'));

  const fakeSession = {
    rid: '0123456789ab',
    server: 'ks012345',
    token: 'tok-unit',
    env: { KEYSMITH_BRIDGE_SOCK: '/tmp/b.sock', KEYSMITH_BRIDGE_TOKEN: 'tok-unit' },
    limits: { readyTimeoutMs: 15_000, toolResultTimeoutMs: 30_000, sessionMaxMs: 600_000 },
  };
  const bridgePlanEnv = claudeDriver.plan(claudeAdapter, { session: fakeSession, model: 'claude-haiku-4-5', prompt: 'hi' }).env;
  for (const k of Object.keys(HAZARDOUS_ENV)) {
    assert.equal(Object.hasOwn(bridgePlanEnv, k), false, `claudeDriver.plan env must strip ${k}`);
  }
  assert.equal(bridgePlanEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(bridgePlanEnv.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(bridgePlanEnv.KEEP_CUSTOM, 'yes');
  assert.equal(bridgePlanEnv.CLAUDE_CONFIG_DIR, path.join(dir, 'claude-cfg'));

  const qoderAdapter = new CliAdapter('qd-unit', {
    kind: 'cli',
    bin: fakeQoderBin,
    args: ['-p', '{prompt}'],
    parser: 'claude-stream-json',
    cwd: path.join(dir, 'ws-unit-qd'),
    env: { ANTHROPIC_API_KEY: 'sk-' + 'qoder-own-' + '3333' },
  });
  const qoderEnv = qoderAdapter._childEnv();
  assert.equal(qoderEnv.ANTHROPIC_API_KEY, 'sk-' + 'qoder-own-' + '3333');
  assert.equal(qoderEnv.CLAUDE_CODE_ENTRYPOINT, undefined, 'agentCleanEnv still strips nested entrypoint markers');
});

/* ------------------------------------------------------------------- K5: end-to-end child env */

test('K5: text, vision, EMULATE, modelsFrom, and MCP bridge spawn fake claude with zero ANTHROPIC_*/CLAUDE_API_KEY/OAuth/cloud vars, while qodercli keeps them', async () => {
  const beforeRuns = readRuns().length;

  // 1. text
  const rText = await post('/v1/chat/completions', {
    model: 'claude/claude-haiku-4-5',
    messages: [{ role: 'user', content: 'ping text' }],
  });
  assert.equal(rText.status, 200, rText.text);
  assert.equal(JSON.parse(rText.text).choices[0].message.content, 'TEXT_OK');

  // 2. vision (/v1/messages with image block)
  const rVision = await post('/v1/messages', {
    model: 'claude/claude-haiku-4-5',
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
          { type: 'text', text: 'describe' },
        ],
      },
    ],
  });
  assert.equal(rVision.status, 200, rVision.text);
  assert.match(JSON.parse(rVision.text).content[0].text, /^VISION_OK:.*image/);

  // 3. EMULATE (tool_choice: required forces EMULATE engine under toolMode: auto)
  const rEmu = await post('/v1/chat/completions', {
    model: 'claude/claude-haiku-4-5',
    tool_choice: 'required',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather lookup',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
        },
      },
    ],
    messages: [{ role: 'user', content: 'Weather in Izmir?' }],
  });
  assert.equal(rEmu.status, 200, rEmu.text);
  assert.equal(rEmu.headers.get('x-keysmith-mode'), 'emulate');
  assert.equal(JSON.parse(rEmu.text).choices[0].message.tool_calls[0].function.name, 'get_weather');

  // 4. MCP bridge (two-turn round trip on /v1/messages)
  const aTools = [
    {
      name: 'get_weather',
      description: 'Weather lookup',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    },
  ];
  const rBridge1 = await post('/v1/messages', {
    model: 'claude/claude-haiku-4-5',
    max_tokens: 128,
    tools: aTools,
    messages: [{ role: 'user', content: 'Check Izmir weather' }],
  });
  assert.equal(rBridge1.status, 200, rBridge1.text);
  assert.equal(rBridge1.headers.get('x-keysmith-mode'), 'mcp');
  const msg1 = JSON.parse(rBridge1.text);
  const tu = msg1.content.find((b) => b.type === 'tool_use');
  assert.ok(tu, 'bridge turn 1 must return tool_use');

  const rBridge2 = await post('/v1/messages', {
    model: 'claude/claude-haiku-4-5',
    max_tokens: 128,
    tools: aTools,
    messages: [
      { role: 'user', content: 'Check Izmir weather' },
      { role: 'assistant', content: msg1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '24C sunny' }] },
    ],
  });
  assert.equal(rBridge2.status, 200, rBridge2.text);
  assert.equal(JSON.parse(rBridge2.text).content[0].text, 'BRIDGE_OK:24C sunny');

  // 5. modelsFrom (_listModels)
  const listed = await gateway.adapters.get('claude')._listModels();
  assert.equal(listed[0].id, 'claude-haiku-4-5');

  const claudeRuns = readRuns().slice(beforeRuns);
  const seenModes = new Set(claudeRuns.map((r) => r.mode));
  for (const mode of ['text', 'vision', 'emulate', 'bridge', 'modelsFrom']) {
    assert.ok(seenModes.has(mode), `expected ${mode} run to execute`);
  }
  for (const run of claudeRuns) {
    assert.deepEqual(run.leaked, [], `${run.mode}: no ANTHROPIC_*/CLAUDE_API_KEY/OAuth/cloud vars may reach claude`);
    assert.equal(run.markers.CLAUDECODE, null, `${run.mode}: CLAUDECODE stripped`);
    assert.equal(run.markers.CLAUDE_CODE_ENTRYPOINT, null, `${run.mode}: CLAUDE_CODE_ENTRYPOINT stripped`);
    assert.equal(run.markers.CLAUDE_CONFIG_DIR, path.join(dir, 'claude-cfg'), `${run.mode}: CLAUDE_CONFIG_DIR kept`);
    assert.equal(run.markers.KEYSMITH_TEST_KEEP, 'preserved', `${run.mode}: unrelated env kept`);
    if (run.mode === 'bridge') {
      assert.equal(run.markers.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
      assert.equal(run.markers.ENABLE_TOOL_SEARCH, 'false');
      assert.ok(run.markers.MCP_TOOL_TIMEOUT);
    }
  }

  // 6. qodercli adapter sharing parser `claude-stream-json` keeps its own ANTHROPIC_* env.
  const qBefore = readRuns().length;
  const rQoder = await post(
    '/v1/chat/completions',
    {
      model: 'qoder-json/m',
      messages: [{ role: 'user', content: 'ping qoder' }],
    },
    API_KEY,
  );
  assert.equal(rQoder.status, 200, rQoder.text);
  const [qRun] = readRuns().slice(qBefore);
  assert.equal(qRun.bin, 'qodercli');
  assert.ok(qRun.leaked.includes('ANTHROPIC_API_KEY'), 'qodercli keeps inherited ANTHROPIC_API_KEY');
});

/* ------------------------------------------------------------------- K3: key scope */

test('K3: scoped key with allow-list and claude-api*/claude-failover* deny rejects API adapters (403) and allows claude and aliases', async () => {
  httpHits.length = 0;

  for (const blocked of ['claude-api-promo/claude-haiku-4-5', 'claude-api/claude-haiku-4-5', 'claude-failover-api/claude-haiku-4-5']) {
    const r = await post('/v1/chat/completions', {
      model: blocked,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 403, `${blocked}: expected 403, got ${r.status}: ${r.text}`);
    assert.match(r.text, /deny|allow-list|claude-api\*|claude-failover\*/i);
  }

  const rMsgBlocked = await post('/v1/messages', {
    model: 'claude-api-promo/claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(rMsgBlocked.status, 403, rMsgBlocked.text);
  assert.equal(httpHits.length, 0, 'blocked HTTP adapters must never receive upstream traffic');

  const rDirect = await post('/v1/chat/completions', {
    model: 'claude/claude-haiku-4-5',
    messages: [{ role: 'user', content: 'direct' }],
  });
  assert.equal(rDirect.status, 200, rDirect.text);

  const rAlias = await post('/v1/chat/completions', {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'via alias' }],
  });
  assert.equal(rAlias.status, 200, rAlias.text);
  assert.equal(httpHits.length, 0);
  const lastRow = usageLog.tail(10)[0];
  assert.equal(lastRow.adapter, 'claude');

  // Other keys still reach claude-api/*.
  const rOther = await post(
    '/v1/chat/completions',
    { model: 'claude-api/claude-haiku-4-5', messages: [{ role: 'user', content: 'unscoped' }] },
    API_KEY,
  );
  assert.equal(rOther.status, 200, rOther.text);
  assert.equal(httpHits.length, 1);
});

/* ------------------------------------------------------------------- K4: single-leg alias */

test('K4: single-leg claude/ alias returns 502 on failure and 503 when disabled, with zero API fallback', async () => {
  httpHits.length = 0;

  for (const key of [SUB_KEY, API_KEY]) {
    const rowsBefore = usageLog.tail(200).length;
    const rFail = await post(
      '/v1/chat/completions',
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'TRIGGER_FAIL' }] },
      key,
    );
    assert.equal(rFail.status, 502, rFail.text);
    assert.equal(httpHits.length, 0, 'single-leg failure must never fall through to HTTP API');
    const newRows = usageLog.tail(200).slice(0, usageLog.tail(200).length - rowsBefore);
    assert.ok(newRows.length >= 1);
    for (const row of newRows) {
      assert.ok(!String(row.adapter || '').startsWith('claude-api'), `unexpected API usage row: ${row.adapter}`);
    }
    assert.equal(newRows[0].adapter, 'claude');
  }

  const rOff = await post(
    '/v1/chat/completions',
    { model: 'claude-haiku-off', messages: [{ role: 'user', content: 'hi' }] },
    API_KEY,
  );
  assert.equal(rOff.status, 503, rOff.text);
  assert.equal(httpHits.length, 0);
});
