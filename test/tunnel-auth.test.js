/**
 * `tunnel run` and `serve` must not publish an unauthenticated gateway.
 * The cloudflared stand-in lives only on this test's PATH and records its argv;
 * it is not the real binary, and nothing here opens a tunnel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const KEY = 'ks_tunnelauthcase000111222333444555666';
const TUNNEL_REFUSAL = 'keysmith: refusing to start a tunnel with auth.enabled === false: the tunnel is public, so authentication has to stay on\n';
const SERVE_REFUSAL = 'keysmith: refusing to start with auth.enabled === false when a tunnel is configured or host is not loopback\n';

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tunnel-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeConfig(home, cfg) {
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return config;
}

function baseEnv(home, config, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    KEYSMITH_CONFIG: config,
    KEYSMITH_DATA: path.join(home, 'data'),
    NO_COLOR: '1',
    ...extra,
  };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.KEYSMITH_VERBOSE;
  return env;
}

/** Executable `cloudflared` that only appends its arguments. PATH must be this directory alone. */
function stubCloudflared(home) {
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(home, 'cloudflared-calls.txt');
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CLOUDFLARED_CALLS"\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return { dir, marker };
}

function run(home, config, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: baseEnv(home, config, extraEnv),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function tunnelBlock() {
  return { provider: 'cloudflared', name: 'keysmith', hostname: 'llm.example.com', configFile: null };
}

function assertNoKey(text) {
  assert.equal(text.includes(KEY), false, 'a key value was printed');
}

test('tunnel run with auth off and a tunnel block refuses and does not start cloudflared', (t) => {
  const home = tempHome(t);
  const { dir, marker } = stubCloudflared(home);
  const config = writeConfig(home, {
    host: '127.0.0.1',
    port: 1,
    auth: { enabled: false, keys: [KEY] },
    adapters: {},
    tunnel: tunnelBlock(),
  });
  const r = run(home, config, ['tunnel', 'run'], { PATH: dir, CLOUDFLARED_CALLS: marker });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, TUNNEL_REFUSAL);
  assert.equal(r.stdout, '');
  assertNoKey(r.stdout + r.stderr);
  assert.equal(fs.existsSync(marker), false, 'cloudflared was started');
});

test('tunnel run with auth on invokes the cloudflared on PATH', (t) => {
  const home = tempHome(t);
  const { dir, marker } = stubCloudflared(home);
  const config = writeConfig(home, {
    host: '127.0.0.1',
    port: 8787,
    auth: { enabled: true, keys: [KEY] },
    adapters: {},
    tunnel: tunnelBlock(),
  });
  const r = run(home, config, ['tunnel', 'run'], { PATH: dir, CLOUDFLARED_CALLS: marker });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloudflared named tunnel → 127\.0\.0\.1:8787/);
  assertNoKey(r.stdout + r.stderr);
  assert.equal(fs.existsSync(marker), true, 'cloudflared was not invoked');
  assert.match(fs.readFileSync(marker, 'utf8'), /tunnel/);
});

test('tunnel status with auth off still prints status and does not start cloudflared', (t) => {
  const home = tempHome(t);
  const { dir, marker } = stubCloudflared(home);
  const config = writeConfig(home, {
    host: '127.0.0.1',
    port: 8787,
    auth: { enabled: false, keys: [KEY] },
    adapters: {},
    tunnel: tunnelBlock(),
  });
  const r = run(home, config, ['tunnel', 'status'], { PATH: dir, CLOUDFLARED_CALLS: marker });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"installed": true/);
  assertNoKey(r.stdout + r.stderr);
  assert.equal(fs.existsSync(marker), false, 'tunnel status started cloudflared');
});

function assertServeRefuses(t, host) {
  const home = tempHome(t);
  const config = writeConfig(home, {
    host,
    port: 1,
    auth: { enabled: false, keys: [KEY] },
    adapters: {},
  });
  const r = run(home, config, ['serve']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, SERVE_REFUSAL);
  assert.equal(r.stdout, '');
  assertNoKey(r.stdout + r.stderr);
}

test('serve with auth off and host null refuses before listen', (t) => {
  assertServeRefuses(t, null);
});

test('serve with auth off refuses a blank or non-string host before listen', (t) => {
  // '' is the isLoopbackHost hole (it returns true); 0 is not a string, so listen() drops it and binds every interface.
  for (const host of ['', '   ', 0]) assertServeRefuses(t, host);
});

test('serve with auth off and host 0.0.0.0 refuses', (t) => {
  assertServeRefuses(t, '0.0.0.0');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
  });
}

async function waitUntil(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms`);
}

test('serve with auth off, loopback host and no tunnel answers GET /v1/models', { timeout: 20_000 }, async (t) => {
  const home = tempHome(t);
  const port = await freePort();
  const config = writeConfig(home, {
    host: '127.0.0.1',
    port,
    auth: { enabled: false, keys: [] },
    adapters: {},
  });
  const child = spawn(process.execPath, [CLI, 'serve'], {
    env: baseEnv(home, config),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 4000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  t.after(stop);
  const read = () => log;
  try {
    await waitUntil(() => {
      const log = read();
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error(`serve exited ${child.exitCode ?? child.signalCode}\n${log}`);
      }
      return log.includes('listening on');
    }, 10_000);
    const log = read();
    assert.match(log, new RegExp(`http://127\\.0\\.0\\.1:${port}/v1`));
    assert.equal(log.includes('refusing to start'), false);
    const res = await httpGet(port, '/v1/models');
    assert.equal(res.status, 200, res.raw);
    const body = JSON.parse(res.raw);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  } finally {
    await stop();
  }
});
