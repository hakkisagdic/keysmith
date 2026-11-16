/**
 * A `kiro-api` adapter: the built-in kiro profile run with KIRO_API_KEY in its child env, the value
 * a secret reference read when the child is spawned. Every key here is a throwaway; the stand-in
 * kiro-cli (test/stubs/kiro-env-stub.mjs) compares its own env to it and never prints it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { runKiroUsage, parseKiroUsage } from '../src/credit-guard.js';
import { redactSecrets } from '../src/redact.js';
import { CLI_PROFILES } from '../src/profiles.js';

const STUB = fileURLToPath(new URL('./stubs/kiro-env-stub.mjs', import.meta.url));
const GW_KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
const SECRET = 'kiro-test-' + crypto.randomBytes(12).toString('hex');
const SERVICE = 'keysmith-test-' + crypto.randomBytes(6).toString('hex');
const keychain = process.platform === 'darwin';

let dir, expectFile, logFile, server, base, gateway, usageLog, cfg;
const logs = [];
const captured = () => [logs.join('\n'), fs.existsSync(path.join(dir, 'usage.jsonl')) ? fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8') : ''].join('\n');
const stubRuns = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The built-in kiro entry around the stub, with `env` as given (plus the stub's own plumbing). */
function kiroApi(id, env, extra = {}) {
  return {
    ...structuredClone(CLI_PROFILES.kiro),
    bin: STUB,
    cwd: path.join(dir, `ws-${id}`),
    env: { STUB_EXPECT_FILE: expectFile, STUB_LOG: logFile, ...env },
    timeoutMs: 20_000,
    ...extra,
  };
}

const REFS = {
  file: { KIRO_API_KEY: '' }, // filled in before()
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-kiro-api-'));
  expectFile = path.join(dir, 'expect');
  logFile = path.join(dir, 'stub.jsonl');
  fs.writeFileSync(expectFile, SECRET);
  const keyFile = path.join(dir, 'key.txt');
  fs.writeFileSync(keyFile, SECRET + '\n');
  if (keychain) {
    const r = spawnSync('security', ['add-generic-password', '-a', 'keysmith-test', '-s', SERVICE, '-w', SECRET]);
    assert.equal(r.status, 0, 'a throwaway Keychain item is made');
  }
  REFS.file.KIRO_API_KEY = `{file:${keyFile}}`;
  cfg = {
    auth: { enabled: true, keys: [GW_KEY] },
    adapters: {
      'kiro-ref': kiroApi('kiro-ref', { KIRO_API_KEY: keychain ? `{exec:security find-generic-password -s ${SERVICE} -w}` : REFS.file.KIRO_API_KEY }),
      'kiro-file': kiroApi('kiro-file', REFS.file),
      'kiro-literal': kiroApi('kiro-literal', { KIRO_API_KEY: SECRET }),
      'kiro-missing': kiroApi('kiro-missing', { KIRO_API_KEY: '{exec:echo SENTINEL_OUTPUT_7Q; exit 3}' }),
      'kiro-leak': kiroApi('kiro-leak', { KIRO_API_KEY: REFS.file.KIRO_API_KEY, STUB_LEAK: '1' }),
      'kiro-off': kiroApi('kiro-off', { KIRO_API_KEY: REFS.file.KIRO_API_KEY }, { disabled: true }),
    },
  };
  gateway = new Gateway(cfg, { log: (m) => logs.push(m) });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await gateway.close();
  await new Promise((r) => server.close(r));
  if (keychain) spawnSync('security', ['delete-generic-password', '-s', SERVICE]);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function chat(model) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${GW_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
  });
  return { status: res.status, text: await res.text() };
}
const get = async (route) => (await fetch(base + route, { headers: { authorization: `Bearer ${GW_KEY}` } })).text();

test('a reference in env is read when the child is spawned: the stub sees the key, the answer never carries it', async () => {
  for (const id of ['kiro-ref', 'kiro-file']) {
    const r = await chat(`${id}/auto`);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.match(r.text, /ENV_OK/);
    assert.ok(!r.text.includes(SECRET));
  }
});

test('a reference is not read at construction, and the adapter keeps it as written', () => {
  const a = new CliAdapter('late', { ...kiroApi('late', { KIRO_API_KEY: '{file:/nonexistent/never-read}' }) });
  assert.equal(a.env.KIRO_API_KEY, '{file:/nonexistent/never-read}');
  assert.throws(() => a._childEnv(), /env KIRO_API_KEY/);
});

test('a literal env value is passed on unchanged', async () => {
  const r = await chat('kiro-literal/auto');
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /ENV_OK/);
  const a = new CliAdapter('lit', kiroApi('lit', { KIRO_API_KEY: SECRET, PLAIN: '{not a ref}' }));
  const env = a._childEnv();
  assert.equal(env.KIRO_API_KEY, SECRET);
  assert.equal(env.PLAIN, '{not a ref}');
});

test('an unresolved reference fails the run naming the variable, never a value or the command output', async () => {
  const before = stubRuns().length;
  const r = await chat('kiro-missing/auto');
  assert.ok(r.status >= 400, r.text.slice(0, 300));
  assert.match(r.text, /KIRO_API_KEY/);
  for (const bad of ['SENTINEL_OUTPUT_7Q', 'exit 3', SECRET]) assert.ok(!r.text.includes(bad), `error text leaks ${bad}`);
  assert.equal(stubRuns().length, before, 'the CLI was never started');
});

test('the credit guard\'s /usage run gets the same env', async () => {
  const before = stubRuns().length;
  const adapter = gateway.adapters.get('kiro-ref');
  const out = await runKiroUsage(adapter);
  assert.equal(parseKiroUsage(out)?.used, 100, 'the stub read the right key (a wrong one reports 9999)');
  const runs = stubRuns().slice(before);
  assert.deepEqual(runs.map((x) => [x.usage, x.verdict]), [[true, 'ENV_OK']]);
  await assert.rejects(runKiroUsage(gateway.adapters.get('kiro-missing')), /env KIRO_API_KEY/);
  const err = await runKiroUsage(gateway.adapters.get('kiro-missing')).catch((e) => e.message);
  assert.ok(!err.includes('SENTINEL_OUTPUT_7Q'));
});

test('the value is on no log, status page, routes page, usage row, error text or saved config', async () => {
  // A child that prints the key on stderr and fails: the error that comes back is redacted.
  const leak = await chat('kiro-leak/auto');
  assert.match(leak.text, /boom/, 'the child\'s stderr reaches the error, so redaction is what keeps the key out');
  assert.ok(!leak.text.includes(SECRET), 'error text');
  const pages = [await get('/status'), await get('/v1/keysmith/routes'), await get('/v1/models'), leak.text];
  for (const p of pages) assert.ok(!p.includes(SECRET));
  assert.ok(!captured().includes(SECRET), 'log and usage.jsonl');
  // what `keysmith set/get/status` show comes from the config, which still holds the reference
  assert.ok(!JSON.stringify(gateway.adapters.get('kiro-file').env).includes(SECRET));
  assert.ok(!JSON.stringify(cfg.adapters['kiro-file']).includes(SECRET));
  const saved = path.join(dir, 'saved.json');
  fs.writeFileSync(saved, JSON.stringify(cfg));
  assert.ok(!fs.readFileSync(saved, 'utf8').replace(JSON.stringify(cfg.adapters['kiro-literal']), '').includes(SECRET));
  assert.ok(!redactSecrets(`x ${SECRET} y`).includes(SECRET), 'the resolved value is registered with the redactor');
});

test('a disabled adapter is not routed', async () => {
  const before = stubRuns().length;
  const r = await chat('kiro-off/auto');
  assert.equal(r.status, 503, r.text.slice(0, 300));
  assert.match(r.text, /disabled/);
  assert.equal(stubRuns().length, before);
  assert.ok(!(await get('/v1/models')).includes('kiro-off/'));
});
