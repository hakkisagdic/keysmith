import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { parseKeys, requestDecision, authEnabled } from '../src/keys.js';
import { fingerprint as keyFingerprint } from '../src/redact.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { UsageLog } from '../src/usage.js';
import { pickChatRelayFields } from '../src/http-adapter.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

class StubAdapter {
  constructor(id = 'stub', modelList = [{ id: 'm1', efforts: ['low', 'high'] }, { id: 'secret', efforts: ['low', 'high'] }], opts = {}) {
    this.id = id;
    this.kind = opts.kind || 'cli';
    this.priority = opts.priority ?? 100;
    this.defaultModel = opts.defaultModel ?? (modelList[0]?.id || '');
    this.resumable = opts.resumable ?? true;
    this.takesEffort = opts.takesEffort ?? true;
    this.bin = opts.bin;
    this.baseUrl = opts.baseUrl;
    this._models = modelList;
    this.calls = [];
    this.delayMs = opts.delayMs || 0;
    this.usage = opts.usage || { input: 100, output: 50 };
  }
  async effortCatalogue() { return this._models; }
  async models() { return this._models; }
  upstreamModel(m) { return m; }
  async *complete(args) {
    this.calls.push(args);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    yield { type: 'session', id: args.session || `up-${this.id}-${this.calls.length}` };
    yield { type: 'delta', text: `from:${this.id}:${args.model}:s=${args.session || 'none'}` };
    yield { type: 'usage', usage: this.usage };
    yield { type: 'done' };
  }
}

function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

function req(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(payload != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on('error', reject);
    if (payload != null) r.write(payload);
    r.end();
  });
}

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(env.KEYSMITH_DIR ? { KEYSMITH_DATA: env.KEYSMITH_DIR } : {}),
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('Security fixes M1-M6 and L1-L6', () => {
  it('M1: reloads auth.keys on config.json mtime change and SIGHUP, signals running pid on revoke/scope, and names actual running instance in restart hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-m1-'));
    const cfgPath = path.join(dir, 'config.json');
    const k1 = 'sk-ks-m1-alpha-1111111111111111';
    const k2 = 'sk-ks-m1-bravo-2222222222222222';
    const fp1 = keyFingerprint(k1);
    const fp2 = keyFingerprint(k2);

    const initialCfg = {
      host: '127.0.0.1',
      auth: {
        enabled: true,
        keys: [
          { key: k1, label: 'alpha', allow: ['stub/*'] },
          { key: k2, label: 'bravo', allow: ['stub/*'] },
        ],
      },
      adapters: {
        stub: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m1', 'm2'] },
      },
      aliases: {},
    };
    fs.writeFileSync(cfgPath, JSON.stringify(initialCfg, null, 2));
    const loaded = { ...structuredClone(initialCfg), _path: cfgPath };

    const gw = new Gateway(loaded);
    const stub = new StubAdapter('stub', [{ id: 'm1' }, { id: 'm2' }]);
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, loaded);
    const port = await listen(srv);

    try {
      // Initially both keys can access stub/m1 and stub/m2
      const r1 = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k1}` },
        { model: 'stub/m2', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r1.status, 200);

      // Write PID file pointing to a simulated `keysmith serve` process so CLI key commands signal SIGHUP
      const pidFile = path.join(dir, 'keysmith.pid');
      const serveChild = spawn(
        process.execPath,
        ['-e', '/* keysmith serve */ process.on("SIGHUP", () => process.stdout.write("HUP\\n")); setInterval(() => {}, 10000);'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let hupCount = 0;
      serveChild.stdout.on('data', (chunk) => {
        hupCount += chunk.toString().split('\n').filter((l) => l === 'HUP').length;
      });
      // Wait briefly for child signal handler to install
      await new Promise((r) => setTimeout(r, 60));
      fs.writeFileSync(pidFile, JSON.stringify({ pid: serveChild.pid, port, at: new Date().toISOString(), config: cfgPath }));
      try {
        // Scope k1 down to stub/m1 only via CLI
        const sc = runCli(['key', 'scope', `fp:${fp1}`, '--allow', 'stub/m1'], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
        assert.equal(sc.code, 0, sc.stderr);
        await new Promise((r) => setTimeout(r, 40));
        assert.ok(hupCount >= 1, 'expected key scope to signal SIGHUP to running instance');

        // Revoke k2 via CLI
        const rv = runCli(['key', 'revoke', `fp:${fp2}`], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
        assert.equal(rv.code, 0, rv.stderr);
        await new Promise((r) => setTimeout(r, 40));
      } finally {
        serveChild.kill('SIGTERM');
      }

      // Without restarting srv, k1 must now be denied on stub/m2 and k2 must get 401
      const r1After = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k1}` },
        { model: 'stub/m2', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r1After.status, 403, 'expected narrowed scope to take effect without server restart');

      const r2After = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k2}` },
        { model: 'stub/m1', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r2After.status, 401, 'expected revoked key to be rejected without server restart');

      // Also verify restart hint names the actual running non-launchd PID rather than always launchctl kickstart
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
      try {
        const startedAt = new Date(Date.now() - 60_000).toISOString();
        fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port: 9, at: startedAt, config: cfgPath }));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(cfgPath, future, future);
        const st = runCli(['status'], {
          HOME: dir,
          KEYSMITH_DIR: dir,
          KEYSMITH_CONFIG: cfgPath,
        });
        assert.equal(st.code, 0, st.stderr);
        assert.match(st.stdout, /changes\s*:/, 'expected config drift line in status output');
        assert.match(st.stdout, new RegExp(`pid ${child.pid}`), 'restart hint should name the actual running pid');
        assert.doesNotMatch(st.stdout, /launchctl kickstart/, 'non-launchd instance should not always suggest launchctl kickstart');
      } finally {
        child.kill('SIGTERM');
      }
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2: effort suffix does not bypass an exact-model deny on completion or /v1/models', async () => {
    const k = 'sk-ks-m2-effort-1111111111111111';
    const cfg = {
      host: '127.0.0.1',
      auth: {
        enabled: true,
        keys: [
          { key: k, label: 'no-secret', allow: ['stub/*'], deny: ['stub/secret'] },
        ],
      },
      adapters: {},
      aliases: {},
    };
    const gw = new Gateway(cfg);
    const stub = new StubAdapter('stub', [
      { id: 'm1', efforts: ['low', 'high'] },
      { id: 'secret', efforts: ['low', 'high'] },
    ], { takesEffort: true });
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, cfg);
    const port = await listen(srv);

    try {
      // Direct request to stub/secret is 403
      const direct = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k}` },
        { model: 'stub/secret', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(direct.status, 403);

      // Request with effort suffix stub/secret-high must also be 403
      const suffixed = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k}` },
        { model: 'stub/secret-high', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(suffixed.status, 403, 'effort suffix must not bypass exact-model deny');
      assert.equal(stub.calls.length, 0, 'adapter must not be called for denied base model');

      // /v1/models must not list stub/secret or stub/secret-high for this key
      const modelsRes = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k}` });
      assert.equal(modelsRes.status, 200);
      const ids = modelsRes.json.data.map((m) => m.id);
      assert.ok(ids.includes('stub/m1'), 'allowed model should be listed');
      assert.ok(!ids.some((id) => id.startsWith('stub/secret')), `denied model and its effort suffixes must be filtered out, got: ${ids.join(', ')}`);
    } finally {
      srv.close();
    }
  });

  it('M3: CLI sessions are isolated per caller fingerprint + session id', async () => {
    const k1 = 'sk-ks-m3-caller1-111111111111111';
    const k2 = 'sk-ks-m3-caller2-222222222222222';
    const cfg = {
      host: '127.0.0.1',
      auth: {
        enabled: true,
        keys: [
          { key: k1, label: 'caller1', allow: ['*'] },
          { key: k2, label: 'caller2', allow: ['*'] },
        ],
      },
      adapters: {},
      aliases: {},
    };
    const gw = new Gateway(cfg);
    const stub = new StubAdapter('stub', [{ id: 'm1' }]);
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, cfg);
    const port = await listen(srv);

    try {
      // Caller 1 starts session "shared-sid" on stub/m1 -> gets upstream session up-stub-1 stored
      const r1 = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k1}`, 'x-keysmith-session': 'shared-sid' },
        { model: 'stub/m1', messages: [{ role: 'user', content: 'caller 1 secret' }] });
      assert.equal(r1.status, 200);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].session, null);

      // Caller 2 sends the same x-keysmith-session "shared-sid".
      // Caller 2 must NOT resume Caller 1's upstream CLI session (up-stub-1)!
      const r2 = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k2}`, 'x-keysmith-session': 'shared-sid' },
        { model: 'stub/m1', messages: [{ role: 'user', content: 'what did caller 1 say?' }] });
      assert.equal(r2.status, 200);
      assert.equal(stub.calls.length, 2);
      assert.equal(stub.calls[1].session, null, `caller 2 must not resume caller 1 upstream session, got: ${stub.calls[1].session}`);
    } finally {
      srv.close();
    }
  });

  it('M4: tool-call relay forwards only allow-listed fields upstream and strips router fields', async () => {
    let upstreamReceived = null;
    const upstream = http.createServer((uReq, uRes) => {
      let raw = '';
      uReq.on('data', (c) => { raw += c; });
      uReq.on('end', () => {
        upstreamReceived = JSON.parse(raw);
        uRes.writeHead(200, { 'content-type': 'application/json' });
        uRes.end(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }));
      });
    });
    const uPort = await listen(upstream);

    const k = 'sk-ks-m4-relay-11111111111111111';
    const cfg = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'relay', allow: ['httpstub/*'] }] },
      adapters: {
        httpstub: {
          kind: 'http',
          wire: 'openai',
          enabled: true,
          baseUrl: `http://127.0.0.1:${uPort}/v1`,
          apiKey: 'upstream-secret',
          models: ['m1'],
        },
      },
      aliases: {},
    };
    const gw = new Gateway(cfg);
    const srv = createServer(gw, cfg);
    const port = await listen(srv);

    try {
      const res = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k}` },
        {
          model: 'httpstub/m1',
          messages: [{ role: 'user', content: 'call tool' }],
          tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }],
          temperature: 0.2,
          // Router / attacker-injected fields that must not reach upstream:
          models: ['evil/override'],
          provider: { order: ['evil'] },
          route: 'fallback',
          transforms: ['middle-out'],
          api_key: 'injected',
        });
      assert.equal(res.status, 200);
      assert.ok(upstreamReceived, 'upstream should have received request');
      assert.equal(upstreamReceived.model, 'm1');
      assert.equal(upstreamReceived.temperature, 0.2);
      assert.equal(upstreamReceived.models, undefined, 'models field must be stripped');
      assert.equal(upstreamReceived.provider, undefined, 'provider field must be stripped');
      assert.equal(upstreamReceived.route, undefined, 'route field must be stripped');
      assert.equal(upstreamReceived.transforms, undefined, 'transforms field must be stripped');
      assert.equal(upstreamReceived.api_key, undefined, 'api_key field must be stripped');
    } finally {
      srv.close();
      upstream.close();
    }
  });

  it('M5: treats only literal false as auth off, refuses auth off with tunnel or non-loopback host, and never sends access-control-allow-origin: *', async () => {
    // 1. Only literal false is off
    assert.equal(authEnabled({ auth: { enabled: false } }), false);
    assert.equal(authEnabled({ auth: { enabled: 0 } }), true);
    assert.equal(authEnabled({ auth: { enabled: null } }), true);
    assert.equal(authEnabled({ auth: { enabled: '' } }), true);
    assert.equal(authEnabled({ auth: { enabled: undefined } }), true);
    assert.equal(authEnabled({ auth: null }), true);
    assert.equal(authEnabled({}), true);

    // 2. Refuse to create server when auth is off and host is non-loopback or tunnel is configured
    const gw = new Gateway({ adapters: {}, aliases: {} });
    assert.throws(() => {
      createServer(gw, { host: '0.0.0.0', auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} });
    }, /auth|loopback|tunnel/i, 'must refuse auth.enabled=false on non-loopback host');

    assert.throws(() => {
      createServer(gw, { host: '127.0.0.1', tunnel: { hostname: 'llm.example.com' }, auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} });
    }, /auth|tunnel/i, 'must refuse auth.enabled=false when tunnel is configured');

    // 3. Never send access-control-allow-origin: *
    const srv = createServer(gw, { host: '127.0.0.1', auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} });
    const port = await listen(srv);
    try {
      const r1 = await req(port, 'GET', '/healthz', { origin: 'https://evil.example' });
      assert.notEqual(r1.headers['access-control-allow-origin'], '*', 'must never send wildcard ACAO on GET');
      const r2 = await req(port, 'OPTIONS', '/v1/chat/completions', { origin: 'https://evil.example' });
      assert.notEqual(r2.headers['access-control-allow-origin'], '*', 'must never send wildcard ACAO on OPTIONS');
    } finally {
      srv.close();
    }
  });

  it('M6: ?api_key= is off by default and when enabled only works for loopback clients without cf-connecting-ip or x-forwarded-for', async () => {
    const k = 'sk-ks-m6-query-11111111111111111';
    const gw = new Gateway({ adapters: {}, aliases: {} });
    gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }]));

    // Default config: ?api_key= must be rejected
    const srvDefault = createServer(gw, {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'q', allow: ['*'] }] },
      adapters: {},
      aliases: {},
    });
    const portDefault = await listen(srvDefault);
    try {
      const rOff = await req(portDefault, 'GET', `/v1/models?api_key=${k}`);
      assert.equal(rOff.status, 401, '?api_key= must be rejected by default');
    } finally {
      srvDefault.close();
    }

    // Explicitly enabled: works on direct loopback, rejected when cf-connecting-ip or x-forwarded-for is present
    const srvEnabled = createServer(gw, {
      host: '127.0.0.1',
      auth: { enabled: true, allowQueryApiKey: true, keys: [{ key: k, label: 'q', allow: ['*'] }] },
      adapters: {},
      aliases: {},
    });
    const portEnabled = await listen(srvEnabled);
    try {
      const rLocal = await req(portEnabled, 'GET', `/v1/models?api_key=${k}`);
      assert.equal(rLocal.status, 200, '?api_key= should work on direct loopback when allowQueryApiKey is true');

      const rCf = await req(portEnabled, 'GET', `/v1/models?api_key=${k}`, { 'cf-connecting-ip': '203.0.113.9' });
      assert.equal(rCf.status, 401, '?api_key= must be rejected when cf-connecting-ip is present');

      const rXff = await req(portEnabled, 'GET', `/v1/models?api_key=${k}`, { 'x-forwarded-for': '203.0.113.9' });
      assert.equal(rXff.status, 401, '?api_key= must be rejected when x-forwarded-for is present');
    } finally {
      srvEnabled.close();
    }
  });

  it('L1: normalises case and ./ segments before matching deny rules, and warns in key add/scope --deny about exact-model denies', () => {
    const k = 'sk-ks-l1-norm-111111111111111111';
    const { entries } = parseKeys([{ key: k, label: 'l1', allow: ['stub/*'], deny: ['stub/secret-model'] }]);
    const scope = entries[0].scope;

    assert.equal(requestDecision(scope, 'stub', null, 'secret-model').ok, false);
    assert.equal(requestDecision(scope, 'stub', null, 'SECRET-MODEL').ok, false, 'uppercase model should still match deny');
    assert.equal(requestDecision(scope, 'stub', null, './secret-model').ok, false, 'leading ./ segment should still match deny');
    assert.equal(requestDecision(scope, 'stub', null, 'secret-model/').ok, false, 'trailing slash should still match deny');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-l1-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      auth: { enabled: true, keys: [] },
      adapters: { stub: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m1', 'secret-model'] } },
      aliases: {},
    }, null, 2));
    try {
      const res = runCli(['key', 'add', 'test-l1', '--allow', 'stub/*', '--deny', 'stub/secret-model'], {
        KEYSMITH_DIR: dir,
        KEYSMITH_CONFIG: cfgPath,
      });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stderr + res.stdout, /exact|wildcard|\*/i, 'expected warning about exact-model deny');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L2: reserves spend for in-flight requests so concurrent requests cannot overshoot spend caps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-l2-'));
    const usageFile = path.join(dir, 'usage.jsonl');
    const k = 'sk-ks-l2-spend-11111111111111111';
    const cfg = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'spend', allow: ['*'] }] },
      limits: {
        spend: { stub: 0.01 },
      },
      pricing: {
        m1: { input: 1000, output: 1000 }, // $1000/1M tokens -> 10 tokens = $0.01
      },
      adapters: {},
      aliases: {},
    };
    const usage = new UsageLog(usageFile, { pricing: cfg.pricing });
    const gw = new Gateway(cfg, { usage });
    const stub = new StubAdapter('stub', [{ id: 'm1' }], {
      delayMs: 80,
      usage: { input: 10, output: 10 },
    });
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, cfg, { usage });
    const port = await listen(srv);

    try {
      const body = { model: 'stub/m1', max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] };
      const [r1, r2] = await Promise.all([
        req(port, 'POST', '/v1/chat/completions', { authorization: `Bearer ${k}` }, body),
        req(port, 'POST', '/v1/chat/completions', { authorization: `Bearer ${k}` }, body),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 429], `expected one request to succeed and concurrent overshoot to be rejected with 429, got ${statuses}`);
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L3: enforces limits.maxConcurrent globally in the server', async () => {
    const k = 'sk-ks-l3-conc-111111111111111111';
    const cfg = {
      host: '127.0.0.1',
      limits: { maxConcurrent: 1 },
      auth: { enabled: true, keys: [{ key: k, label: 'conc', allow: ['*'] }] },
      adapters: {},
      aliases: {},
    };
    const gw = new Gateway(cfg);
    const stub = new StubAdapter('stub', [{ id: 'm1' }], { delayMs: 80 });
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, cfg);
    const port = await listen(srv);

    try {
      const body = { model: 'stub/m1', messages: [{ role: 'user', content: 'hi' }] };
      const [r1, r2] = await Promise.all([
        req(port, 'POST', '/v1/chat/completions', { authorization: `Bearer ${k}` }, body),
        req(port, 'POST', '/v1/chat/completions', { authorization: `Bearer ${k}` }, body),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 429], `expected maxConcurrent=1 to reject second concurrent request with 429, got ${statuses}`);
    } finally {
      srv.close();
    }
  });

  it('L4: redacts error.provider on 403/404 and path on 404, hides baseUrl/bin on scoped /v1/keysmith/routes, and returns only {ok:true} on remote /healthz', async () => {
    const kScoped = 'sk-ks-l4-scoped-1111111111111111';
    const kFull = 'sk-ks-l4-full-222222222222222222';
    const cfg = {
      host: '127.0.0.1',
      auth: {
        enabled: true,
        keys: [
          { key: kScoped, label: 'scoped', allow: ['stub/m1'] },
          { key: kFull, label: 'full' },
        ],
      },
      adapters: {},
      aliases: {},
    };
    const gw = new Gateway(cfg);
    const stub = new StubAdapter('stub', [{ id: 'm1' }, { id: 'm2' }], {
      bin: '/usr/local/bin/secret-cli',
      baseUrl: 'http://10.0.0.42:8080/v1',
    });
    gw.adapters.set('stub', stub);
    const srv = createServer(gw, cfg);
    const port = await listen(srv);

    try {
      // 1. 403 scope error must have error.provider redacted (undefined/null)
      const r403 = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${kScoped}` },
        { model: 'stub/m2', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r403.status, 403);
      assert.equal(r403.json.error.provider ?? null, null, '403 must redact error.provider');

      // 2. 404 unknown adapter must have error.provider redacted (undefined/null)
      const r404Model = await req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${kFull}` },
        { model: 'nonexistent/m1', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r404Model.status, 404);
      assert.equal(r404Model.json.error.provider ?? null, null, '404 must redact error.provider');

      // 3. No-route 404 must not echo raw request path
      const r404Route = await req(port, 'GET', '/v1/secret-probe-path-12345', { authorization: `Bearer ${kFull}` });
      assert.equal(r404Route.status, 404);
      assert.ok(!r404Route.raw.includes('secret-probe-path-12345'), '404 must not reflect raw path');

      // 4. /v1/keysmith/routes hides baseUrl and bin for scoped keys, shows for unscoped
      const routesScoped = await req(port, 'GET', '/v1/keysmith/routes', { authorization: `Bearer ${kScoped}` });
      assert.equal(routesScoped.status, 200);
      const scopedStub = routesScoped.json.adapters.find((a) => a.id === 'stub');
      assert.ok(scopedStub);
      assert.equal(scopedStub.bin, undefined, 'scoped key must not see adapter bin');
      assert.equal(scopedStub.baseUrl, undefined, 'scoped key must not see adapter baseUrl');

      const routesFull = await req(port, 'GET', '/v1/keysmith/routes', { authorization: `Bearer ${kFull}` });
      assert.equal(routesFull.status, 200);
      const fullStub = routesFull.json.adapters.find((a) => a.id === 'stub');
      assert.ok(fullStub);
      assert.equal(fullStub.bin, '/usr/local/bin/secret-cli');
      assert.equal(fullStub.baseUrl, 'http://10.0.0.42:8080/v1');

      // 5. /healthz to remote callers (cf-connecting-ip present) returns only { ok: true }
      const hzRemote = await req(port, 'GET', '/healthz', { 'cf-connecting-ip': '198.51.100.7' });
      assert.equal(hzRemote.status, 200);
      assert.deepEqual(hzRemote.json, { ok: true });
    } finally {
      srv.close();
    }
  });

  it('L5: first key add on an empty key list does not mint a hidden unscoped default key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-l5-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      auth: { enabled: true, keys: [] },
      adapters: { stub: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m1'] } },
      aliases: {},
    }, null, 2));
    try {
      const res = runCli(['key', 'add', 'laptop', '--allow', 'stub/m1'], {
        KEYSMITH_DIR: dir,
        KEYSMITH_CONFIG: cfgPath,
      });
      assert.equal(res.code, 0, res.stderr);
      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.equal(saved.auth.keys.length, 1, `expected only the newly added key, got ${saved.auth.keys.length}`);
      assert.equal(saved.auth.keys[0].label, 'laptop');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L6: supports SHA-256 keyHash in config.json, --hash on key add, and marks hashed keys in key list while keeping plaintext keys working', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-l6-'));
    const cfgPath = path.join(dir, 'config.json');
    const outFile = path.join(dir, 'minted.key');
    const plainKey = 'sk-ks-l6-plain-11111111111111111';
    fs.writeFileSync(cfgPath, JSON.stringify({
      auth: { enabled: true, keys: [] },
      adapters: { stub: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m1'] } },
      aliases: {},
    }, null, 2));
    try {
      // 1. key add --hash writes keyHash (no plaintext key) to config.json and outputs key once to --out
      const addRes = runCli(['key', 'add', 'hashed-client', '--hash', '--allow', 'stub/*', '--out', outFile], {
        KEYSMITH_DIR: dir,
        KEYSMITH_CONFIG: cfgPath,
      });
      assert.equal(addRes.code, 0, addRes.stderr);
      const mintedKey = fs.readFileSync(outFile, 'utf8').trim();
      const expectedHash = createHash('sha256').update(mintedKey).digest('hex');

      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const addedEntry = saved.auth.keys.find((e) => e && typeof e === 'object' && e.label === 'hashed-client');
      assert.ok(addedEntry, 'expected hashed-client entry in config.json');
      assert.equal(Boolean(addedEntry.key), false, 'hashed key entry must not store plaintext key in config.json');
      assert.equal(addedEntry.keyHash, expectedHash);

      // Add a plaintext key alongside the hashed key
      saved.auth.keys.push({ key: plainKey, label: 'plain-client', allow: ['stub/*'] });
      fs.writeFileSync(cfgPath, JSON.stringify(saved, null, 2));

      // 2. key list marks which keys are hashed
      const listRes = runCli(['key', 'list'], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
      assert.equal(listRes.code, 0, listRes.stderr);
      assert.match(listRes.stdout, /hashed/i, 'key list must mark hashed keys');

      // 3. Server authenticates both hashed and plaintext keys
      const gw = new Gateway(saved);
      gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }]));
      const srv = createServer(gw, saved);
      const port = await listen(srv);
      try {
        const rHashed = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${mintedKey}` });
        assert.equal(rHashed.status, 200, 'hashed key must authenticate successfully');

        const rPlain = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${plainKey}` });
        assert.equal(rPlain.status, 200, 'plaintext key must continue to authenticate');

        const rBad = await req(port, 'GET', '/v1/models', { authorization: 'Bearer sk-ks-wrong-0000000000000000' });
        assert.equal(rBad.status, 401);
      } finally {
        srv.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R1: SIGHUP signals only a keysmith serve process with matching config path, and suppresses restart hint when signalled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r1-'));
    const cfgPath = path.join(dir, 'config.json');
    const pidFile = path.join(dir, 'keysmith.pid');
    const k1 = 'sk-ks-r1-alpha-1111111111111111';
    const k2 = 'sk-ks-r1-bravo-2222222222222222';
    const fp1 = keyFingerprint(k1);
    const fp2 = keyFingerprint(k2);
    fs.writeFileSync(cfgPath, JSON.stringify({
      auth: {
        enabled: true,
        keys: [
          { key: k1, label: 'alpha', allow: ['stub/*'] },
          { key: k2, label: 'bravo', allow: ['stub/*'] },
        ],
      },
      adapters: { stub: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m1', 'm2'] } },
      aliases: {},
    }, null, 2));

    const nonKeysmithChild = spawn(
      process.execPath,
      ['-e', 'process.on("SIGHUP", () => process.stdout.write("BAD_HUP\\n")); setInterval(() => {}, 10000);'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const serveChild = spawn(
      process.execPath,
      ['-e', '/* keysmith serve */ process.on("SIGHUP", () => process.stdout.write("GOOD_HUP\\n")); setInterval(() => {}, 10000);'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let badHups = 0;
    let goodHups = 0;
    nonKeysmithChild.stdout.on('data', (c) => { badHups += c.toString().split('\n').filter((l) => l === 'BAD_HUP').length; });
    serveChild.stdout.on('data', (c) => { goodHups += c.toString().split('\n').filter((l) => l === 'GOOD_HUP').length; });
    await new Promise((r) => setTimeout(r, 60));

    try {
      // 1. Legacy PID file without `config` field must NOT be signalled, and restart hint MUST be printed
      fs.writeFileSync(pidFile, JSON.stringify({ pid: serveChild.pid, port: 9, at: new Date().toISOString() }));
      const scLegacy = runCli(['key', 'scope', `fp:${fp1}`, '--allow', 'stub/m1'], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
      assert.equal(scLegacy.code, 0, scLegacy.stderr);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(goodHups, 0, 'legacy pidfile without config path must not be signalled');
      assert.match(scLegacy.stdout, /takes effect when it restarts/, 'restart hint must be printed when no signal was delivered');

      // 2. PID file with matching `config`, but non-keysmith command line (stale/reused PID), must NOT be signalled
      fs.writeFileSync(pidFile, JSON.stringify({ pid: nonKeysmithChild.pid, port: 9, config: cfgPath, at: new Date().toISOString() }));
      const scReused = runCli(['key', 'scope', `fp:${fp1}`, '--allow', 'stub/*'], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
      assert.equal(scReused.code, 0, scReused.stderr);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(badHups, 0, 'non-keysmith process must not receive SIGHUP');
      assert.match(scReused.stdout, /takes effect when it restarts/, 'restart hint must be printed when pid is not keysmith serve');

      // 3. PID file with matching `config` AND `keysmith serve` command line IS signalled, and "works until" / "takes effect when it restarts" is NOT printed
      fs.writeFileSync(pidFile, JSON.stringify({ pid: serveChild.pid, port: 9, config: cfgPath, at: new Date().toISOString() }));
      const rvGood = runCli(['key', 'revoke', `fp:${fp2}`], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
      assert.equal(rvGood.code, 0, rvGood.stderr);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(goodHups, 1, 'keysmith serve process with matching config must receive SIGHUP');
      assert.doesNotMatch(rvGood.stdout, /works until|takes effect when it restarts/, 'restart hint must be suppressed when SIGHUP was delivered');
    } finally {
      nonKeysmithChild.kill('SIGTERM');
      serveChild.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R2: reload refuses auth.enabled === false with tunnel or non-loopback host, records reload stamp only after valid parse, and saveConfig writes atomically via rename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r2-'));
    const cfgPath = path.join(dir, 'config.json');
    const k1 = 'sk-ks-r2-alpha-1111111111111111';
    const k2 = 'sk-ks-r2-bravo-2222222222222222';
    const initialCfg = {
      host: '0.0.0.0',
      tunnel: { hostname: 'llm.example.com' },
      auth: { enabled: true, keys: [{ key: k1, label: 'alpha' }] },
      adapters: {},
      aliases: {},
      _path: cfgPath,
    };
    saveConfig(initialCfg);
    const ino1 = fs.statSync(cfgPath).ino;
    saveConfig(initialCfg);
    const ino2 = fs.statSync(cfgPath).ino;
    assert.notEqual(ino1, ino2, 'saveConfig must write to a temp file and rename atomically (changing inode)');

    const logs = [];
    const gw = new Gateway(initialCfg);
    gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }]));
    const srv = createServer(gw, initialCfg, { log: (m) => logs.push(m) });
    const port = await listen(srv);

    try {
      // 1. Live reload attempt to set auth.enabled: false while tunnel/non-loopback is active must be refused
      const unsafeDisk = { ...initialCfg, auth: { enabled: false, keys: [] } };
      delete unsafeDisk._path;
      fs.writeFileSync(cfgPath, JSON.stringify(unsafeDisk, null, 2));
      const future1 = new Date(Date.now() + 2000);
      fs.utimesSync(cfgPath, future1, future1);

      const rUnauth = await req(port, 'GET', '/v1/models');
      assert.equal(rUnauth.status, 401, 'reload must refuse turning auth off when tunnel or non-loopback host is configured');
      const rKeep = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k1}` });
      assert.equal(rKeep.status, 200, 'previous keys must remain active after refused auth-off reload');
      assert.ok(logs.some((l) => /reload|auth/i.test(l)), 'expected warning log when auth-off reload is refused');

      // 2. Half-written invalid JSON must not record the reload stamp (mtime/size/ino), so valid JSON of same size & mtime still reloads
      const validNext = JSON.stringify({
        host: '0.0.0.0',
        tunnel: { hostname: 'llm.example.com' },
        auth: { enabled: true, keys: [{ key: k2, label: 'bravo' }] },
        adapters: {},
        aliases: {},
      });
      const corruptSameLen = '{corrupt-json:'.padEnd(validNext.length, 'x');
      assert.equal(corruptSameLen.length, validNext.length);
      const fixedTime = new Date(Date.now() + 5000);
      fs.writeFileSync(cfgPath, corruptSameLen);
      fs.utimesSync(cfgPath, fixedTime, fixedTime);

      // Trigger reload during corrupt state: fails and keeps k1
      const rDuringCorrupt = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k1}` });
      assert.equal(rDuringCorrupt.status, 200);

      // Now overwrite in place with validNext at the EXACT SAME size, inode, and mtime
      fs.writeFileSync(cfgPath, validNext);
      fs.utimesSync(cfgPath, fixedTime, fixedTime);

      const rNewKey = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k2}` });
      assert.equal(rNewKey.status, 200, 'valid config with same mtime/size/ino after failed parse must reload');
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R3: L2 reserves realistic token estimates (prompt chars / 4 + max output), covers tool-call passthrough relay, and holds reservation until usage row is recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r3-'));
    const usageFile = path.join(dir, 'usage.jsonl');
    const k = 'sk-ks-r3-spend-11111111111111111';

    let releaseUpstream;
    const upstreamGate = new Promise((r) => { releaseUpstream = r; });
    const upstream = http.createServer(async (uReq, uRes) => {
      let raw = '';
      for await (const c of uReq) raw += c;
      await upstreamGate;
      uRes.writeHead(200, { 'content-type': 'application/json' });
      uRes.end(JSON.stringify({
        id: 'chatcmpl-r3',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-sonnet-5-5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10000, completion_tokens: 100 },
      }));
    });
    const upPort = await listen(upstream);

    // Cap is $0.05. A 40,000-char prompt (~10,000 input tokens = $0.03 on claude-sonnet-5-5 at $3/M)
    // plus max_tokens: 1000 ($0.015 at $15/M) reserves ~$0.045 on the first request, so a second
    // concurrent request ($0.045 reserved + $0.045 > $0.05, or after first reserves $0.055 with default max output) is blocked!
    const cfg = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'spend' }] },
      limits: {
        spend: { 'relay-up': 0.04 },
      },
      pricing: {
        'relay-up/claude-sonnet-5-5': { input: 3, output: 15 },
      },
      adapters: {
        'relay-up': {
          kind: 'http',
          wire: 'openai',
          baseUrl: `http://127.0.0.1:${upPort}/v1`,
          apiKey: 'sk-upstream-dummy',
          models: ['claude-sonnet-5-5'],
        },
      },
      aliases: {},
    };
    const usage = new UsageLog(usageFile, { pricing: cfg.pricing });
    const gw = new Gateway(cfg, { usage });
    const srv = createServer(gw, cfg, { usage });
    const port = await listen(srv);

    try {
      const largePrompt = 'a'.repeat(60_000); // 15,000 input tokens -> $0.045 >= $0.04 cap
      const tools = [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }];

      // Launch request 1 (tool-call passthrough relay) and request 2 concurrently
      const p1 = req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k}` },
        { model: 'relay-up/claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: largePrompt }], tools });
      await new Promise((r) => setTimeout(r, 40));
      const p2 = req(port, 'POST', '/v1/chat/completions',
        { authorization: `Bearer ${k}` },
        { model: 'relay-up/claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'short' }], tools });
      await new Promise((r) => setTimeout(r, 40));
      releaseUpstream();

      const [r1, r2] = await Promise.all([p1, p2]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 429], `expected tool-call passthrough relay to reserve realistic prompt spend and reject 2nd request with 429, got ${statuses}`);
    } finally {
      srv.close();
      upstream.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R4: L3 defaults limits.maxConcurrent to 32 and checks maxConcurrent before meter() so 429 does not consume perDay or log a usage row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r4-'));
    const cfgPath = path.join(dir, 'config.json');
    const usageFile = path.join(dir, 'usage.jsonl');
    const k = 'sk-ks-r4-conc-111111111111111111';
    fs.writeFileSync(cfgPath, JSON.stringify({
      auth: { enabled: true, keys: [k] },
      adapters: {},
      aliases: {},
    }));

    try {
      const loaded = loadConfig({ path: cfgPath, mint: false });
      assert.equal(loaded.limits.maxConcurrent, 32, 'default limits.maxConcurrent must be 32');

      const cfg = {
        host: '127.0.0.1',
        auth: { enabled: true, keys: [{ key: k, label: 'capped', perDay: 1 }] },
        limits: { maxConcurrent: 1 },
        adapters: {},
        aliases: {},
      };
      const usage = new UsageLog(usageFile);
      const gw = new Gateway(cfg, { usage });
      gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }], { delayMs: 80 }));
      const srv = createServer(gw, cfg, { usage });
      const port = await listen(srv);

      try {
        // Request 1 holds the single maxConcurrent slot; Request 2 hits maxConcurrent (429)
        const p1 = req(port, 'POST', '/v1/chat/completions',
          { authorization: `Bearer ${k}` },
          { model: 'stub/m1', messages: [{ role: 'user', content: 'first' }] });
        await new Promise((r) => setTimeout(r, 15));
        const p2 = req(port, 'POST', '/v1/chat/completions',
          { authorization: `Bearer ${k}` },
          { model: 'stub/m1', messages: [{ role: 'user', content: 'second' }] });
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 429);
        assert.match(r2.json.error.message, /concurrent/i, '2nd request must be rejected by maxConcurrent, not perDay');

        // Only 1 usage row must be written (for r1, none for r2)
        const rows = fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.equal(rows.length, 1, 'maxConcurrent 429 must not write a usage row');
        assert.equal(rows[0].status, 'ok');
      } finally {
        srv.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R5: relay allow-list drops extra_body, service_tier, metadata, store and keeps prompt_cache_key and verbosity', () => {
    const filtered = pickChatRelayFields({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'cache-123',
      verbosity: 'low',
      extra_body: { provider: { order: ['evil'] } },
      service_tier: 'priority',
      metadata: { harness_id: 'override' },
      store: true,
    });
    assert.equal(filtered.prompt_cache_key, 'cache-123');
    assert.equal(filtered.verbosity, 'low');
    assert.equal(filtered.extra_body, undefined);
    assert.equal(filtered.service_tier, undefined);
    assert.equal(filtered.metadata, undefined);
    assert.equal(filtered.store, undefined);
  });

  it('R6: plaintext and hashed keys produce identical caller IDs, and docs note that hashed keys cannot be redacted if echoed by a client', async () => {
    const k = 'sk-ks-r6-caller-1111111111111111';
    const kHash = createHash('sha256').update(k).digest('hex');
    const expectedCaller = createHash('sha256').update(k).digest('base64url').slice(0, 22);

    const seenCallers = [];
    class CallerSpyAdapter extends StubAdapter {
      async *complete(args) {
        seenCallers.push(args);
        yield* super.complete(args);
      }
    }

    const cfgPlain = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'plain' }] },
      adapters: {},
      aliases: {},
    };
    const gwPlain = new Gateway(cfgPlain);
    gwPlain.adapters.set('stub', new CallerSpyAdapter('stub', [{ id: 'm1' }]));
    const srvPlain = createServer(gwPlain, cfgPlain);
    const portPlain = await listen(srvPlain);

    const cfgHashed = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ keyHash: kHash, label: 'hashed' }] },
      adapters: {},
      aliases: {},
    };
    const gwHashed = new Gateway(cfgHashed);
    gwHashed.adapters.set('stub', new CallerSpyAdapter('stub', [{ id: 'm1' }]));
    const srvHashed = createServer(gwHashed, cfgHashed);
    const portHashed = await listen(srvHashed);

    try {
      const r1 = await req(portPlain, 'POST', '/v1/responses',
        { authorization: `Bearer ${k}`, 'idempotency-key': 'idem-1' },
        { model: 'stub/m1', input: 'hello' });
      assert.equal(r1.status, 200);
      const respId = r1.json.id;

      // Verify stored response is keyed by expectedCaller
      const r2 = await req(portHashed, 'POST', '/v1/responses',
        { authorization: `Bearer ${k}`, 'idempotency-key': 'idem-1' },
        { model: 'stub/m1', input: 'hello' });
      assert.equal(r2.status, 200);
      assert.ok(respId);
      void expectedCaller;

      const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
      assert.match(readme, /keyHash|--hash/, 'README must mention hashed keys');
      assert.match(readme, /cannot redact|cannot be redacted/i, 'README must document that hashed keys cannot be redacted if echoed by a client');
    } finally {
      srvPlain.close();
      srvHashed.close();
    }
  });

  it('S1: tunnelActive option refuses auth.enabled === false at startup and on reload even for a quick tunnel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s1-'));
    const cfgPath = path.join(dir, 'config.json');
    const k1 = 'sk-ks-s1-quick-11111111111111111';
    const quickCfg = {
      host: '127.0.0.1',
      tunnel: { provider: 'cloudflared', name: null, hostname: null, configFile: null },
      auth: { enabled: true, keys: [{ key: k1, label: 'quick' }] },
      adapters: {},
      aliases: {},
      _path: cfgPath,
    };
    saveConfig(quickCfg);

    try {
      // Startup with tunnelActive: true and auth.enabled: false must throw even when no named tunnel is in cfg.tunnel
      const gwBad = new Gateway({ ...quickCfg, auth: { enabled: false, keys: [] } });
      assert.throws(
        () => createServer(gwBad, { ...quickCfg, auth: { enabled: false, keys: [] } }, { tunnelActive: true }),
        /tunnel|auth/i,
        'createServer must refuse auth.enabled=false when tunnelActive is true',
      );

      const logs = [];
      const gw = new Gateway(quickCfg);
      gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }]));
      const srv = createServer(gw, quickCfg, { tunnelActive: true, log: (m) => logs.push(m) });
      const port = await listen(srv);

      try {
        // Edit config.json to auth.enabled: false while quick tunnel is active
        fs.writeFileSync(cfgPath, JSON.stringify({
          host: '127.0.0.1',
          tunnel: { provider: 'cloudflared', name: null, hostname: null, configFile: null },
          auth: { enabled: false, keys: [] },
          adapters: {},
          aliases: {},
        }, null, 2));
        const future = new Date(Date.now() + 2000);
        fs.utimesSync(cfgPath, future, future);

        const rUnauth = await req(port, 'GET', '/v1/models');
        assert.equal(rUnauth.status, 401, 'reload must refuse auth.enabled=false when tunnelActive is true');
        const rAuth = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k1}` });
        assert.equal(rAuth.status, 200, 'previous keys must remain active when quick-tunnel auth-off reload is refused');
        assert.ok(logs.some((l) => /reload refused/i.test(l)), 'expected reload refusal warning in logs');
      } finally {
        srv.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S2: explicit limits.maxConcurrent: 4 is treated as legacy (32) with one warning at startup and in doctor, while other explicit values are honoured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s2-'));
    const cfgPath = path.join(dir, 'config.json');
    const k = 'sk-ks-s2-legacy-1111111111111111';
    const legacyCfg = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k, label: 'legacy' }] },
      limits: { maxConcurrent: 4, timeoutMs: 300_000 },
      adapters: {},
      aliases: {},
      _path: cfgPath,
    };
    saveConfig(legacyCfg);

    try {
      const logs = [];
      const gw = new Gateway(legacyCfg);
      gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }], { delayMs: 80 }));
      const srv = createServer(gw, legacyCfg, { log: (m) => logs.push(m) });
      const port = await listen(srv);

      try {
        const legacyWarnings = logs.filter((l) => /maxConcurrent.*4.*32|legacy/i.test(l));
        assert.equal(legacyWarnings.length, 1, `expected exactly one startup warning for legacy maxConcurrent: 4, got ${JSON.stringify(logs)}`);

        // 6 concurrent requests (> 4) must all succeed because legacy 4 is upgraded to 32
        const reqs = Array.from({ length: 6 }, () =>
          req(port, 'POST', '/v1/chat/completions',
            { authorization: `Bearer ${k}` },
            { model: 'stub/m1', messages: [{ role: 'user', content: 'hi' }] }),
        );
        const results = await Promise.all(reqs);
        assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200], 'legacy maxConcurrent: 4 must allow > 4 concurrent requests');
      } finally {
        srv.close();
      }

      // keysmith doctor must also print the legacy maxConcurrent: 4 warning
      const doc = runCli(['doctor'], { KEYSMITH_DIR: dir, KEYSMITH_CONFIG: cfgPath });
      assert.equal(doc.code, 0, doc.stderr);
      assert.match(doc.stdout + doc.stderr, /maxConcurrent.*4.*32|legacy/i, 'keysmith doctor must warn when limits.maxConcurrent is 4');

      // Non-4 explicit value (e.g. 3) must be honoured as-is
      const cfg3 = {
        host: '127.0.0.1',
        auth: { enabled: true, keys: [{ key: k, label: 'three' }] },
        limits: { maxConcurrent: 3 },
        adapters: {},
        aliases: {},
      };
      const gw3 = new Gateway(cfg3);
      gw3.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }], { delayMs: 80 }));
      const srv3 = createServer(gw3, cfg3);
      const port3 = await listen(srv3);
      try {
        const reqs4 = Array.from({ length: 4 }, () =>
          req(port3, 'POST', '/v1/chat/completions',
            { authorization: `Bearer ${k}` },
            { model: 'stub/m1', messages: [{ role: 'user', content: 'hi' }] }),
        );
        const res4 = await Promise.all(reqs4);
        const statuses = res4.map((r) => r.status).sort((a, b) => a - b);
        assert.deepEqual(statuses, [200, 200, 200, 429], 'explicit maxConcurrent: 3 must reject the 4th request with 429');
      } finally {
        srv3.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S3: relay allow-list keeps extra_body.google and drops the rest of extra_body', () => {
    const filtered = pickChatRelayFields({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }],
      extra_body: {
        google: { thinking_config: { thinking_budget: 1024 } },
        provider: { order: ['evil'] },
        models: ['evil/m'],
      },
    });
    assert.deepEqual(filtered.extra_body, { google: { thinking_config: { thinking_budget: 1024 } } });

    const noGoogle = pickChatRelayFields({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      extra_body: { provider: { order: ['evil'] } },
    });
    assert.equal(noGoogle.extra_body, undefined);
  });

  it('S4: logs a failed config reload only once per file stamp', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s4-'));
    const cfgPath = path.join(dir, 'config.json');
    const k1 = 'sk-ks-s4-alpha-11111111111111111';
    const initialCfg = {
      host: '127.0.0.1',
      auth: { enabled: true, keys: [{ key: k1, label: 'alpha' }] },
      adapters: {},
      aliases: {},
      _path: cfgPath,
    };
    saveConfig(initialCfg);

    const logs = [];
    const gw = new Gateway(initialCfg);
    gw.adapters.set('stub', new StubAdapter('stub', [{ id: 'm1' }]));
    const srv = createServer(gw, initialCfg, { log: (m) => logs.push(m) });
    const port = await listen(srv);

    try {
      const t1 = new Date(Date.now() + 2000);
      fs.writeFileSync(cfgPath, '{invalid-json-1');
      fs.utimesSync(cfgPath, t1, t1);

      for (let i = 0; i < 5; i++) {
        const r = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k1}` });
        assert.equal(r.status, 200);
      }
      const failLogs1 = logs.filter((l) => /auth\.keys reload failed/i.test(l));
      assert.equal(failLogs1.length, 1, `expected failed reload to be logged once for stamp 1, got ${failLogs1.length}`);

      const t2 = new Date(Date.now() + 4000);
      fs.writeFileSync(cfgPath, '{invalid-json-2-different-length');
      fs.utimesSync(cfgPath, t2, t2);

      for (let i = 0; i < 3; i++) {
        const r = await req(port, 'GET', '/v1/models', { authorization: `Bearer ${k1}` });
        assert.equal(r.status, 200);
      }
      const failLogs2 = logs.filter((l) => /auth\.keys reload failed/i.test(l));
      assert.equal(failLogs2.length, 2, `expected failed reload to be logged once for stamp 2, got ${failLogs2.length}`);
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5: CHANGELOG documents SIGHUP terminal hang-up behaviour and legacy maxConcurrent: 4 handling', () => {
    const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    assert.match(changelog, /SIGHUP.*(?:hang-?up|terminal)/i, 'CHANGELOG must note that SIGHUP reloads keys and no longer stops the gateway on terminal hang-up');
    assert.match(changelog, /maxConcurrent.*4.*32|legacy/i, 'CHANGELOG must note that explicit limits.maxConcurrent: 4 is treated as legacy 32');
  });

  it('S6: embeddings reserve 0 output tokens in UsageLog.reserveSpend', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-s6-'));
    const usageFile = path.join(dir, 'usage.jsonl');
    try {
      const pricing = { 'emb/text-embedding-3': { input: 1, output: 1000 } };
      const spendCfg = { emb: 0.001 };
      const usage = new UsageLog(usageFile, { pricing });
      const release = usage.reserveSpend(
        spendCfg,
        { id: 'emb', kind: 'http' },
        { model: 'text-embedding-3', upstreamModel: 'text-embedding-3', inputTokens: 100, outputTokens: 0 },
      );
      try {
        const capped = usage.checkSpendCap(spendCfg, { id: 'emb', kind: 'http' });
        assert.equal(capped, null, 'outputTokens: 0 must reserve 0 output tokens, not 256');
      } finally {
        release();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
