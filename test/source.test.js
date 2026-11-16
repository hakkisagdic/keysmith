/** K4-K7: `keysmith source enable|disable`, the cloudflare profile, tokensPerDay. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, CatalogueLimiter } from '../src/catalogue.js';
import { getProfile, SOURCE_FACTS } from '../src/profiles.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SECRET = 'sk-source-secret-0123456789abcdef';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** A `security` stand-in: knows the services listed in $KS_KNOWN, prints nothing, never a value. */
function stubSecurity(home) {
  const f = path.join(home, 'security-stub.sh');
  fs.writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do case " $KS_KNOWN " in *" $a "*) exit 0;; esac; done\nexit 44\n', { mode: 0o700 });
  return f;
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-src-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'cfg');
  fs.mkdirSync(dir);
  const config = path.join(dir, 'config.json');
  const base = { port: 8787, auth: { enabled: false, keys: [] }, adapters: { keep: { kind: 'http', baseUrl: 'http://x/v1', apiKey: '{env:X}' } }, aliases: { fast: ['keep/m'] } };
  fs.writeFileSync(config, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data'), KEYSMITH_SECURITY_BIN: stubSecurity(home), KS_KNOWN: 'svc-tr svc-groq svc-mistral svc-cf' };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  const cfg = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const catFile = path.join(dir, 'catalogue.json');
  return { home, dir, config, env, run, cfg, catFile };
}

test('K4: enable tokenrouter writes a keyless exec reference, freeOnly, discovery, a catalogue row; no alias', (t) => {
  const { run, cfg, config, catFile, dir } = setup(t);
  const r = run('source', 'enable', 'tokenrouter', '--key-ref', 'svc-tr');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restart the gateway/);
  const c = cfg();
  const a = c.adapters.tokenrouter;
  assert.match(a.apiKey, /^\{exec:\/usr\/bin\/security find-generic-password -s svc-tr -a keysmith -w\}$/);
  assert.equal(a.freeOnly, true);
  assert.equal(a.explicitOnly, true);
  assert.equal(c.discovery.enabled, true);
  assert.equal(c.discovery.tokenrouter.inputPricePath, 'pricing.prompt');
  assert.ok(!JSON.stringify(c.aliases).includes('tokenrouter'));
  assert.deepEqual(c.aliases, { fast: ['keep/m'] });
  assert.ok(c.adapters.keep, 'the other adapter is untouched');
  assert.equal(c.catalogue, '~/cfg/catalogue.json', 'a path under the home directory is kept as ~/…');
  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  assert.equal(cat.sources[0].reach.keysmith, 'tokenrouter');
  assert.ok(cat.sources[0].limits.requestsPerDay > 0 && cat.sources[0].limits.tokensPerDay > 0);
  assert.equal(fs.statSync(catFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(dir).some((f) => /^config\.json\.bak-\d{8}-\d{6}-source$/.test(f)));
  assert.ok(!r.stdout.includes('sk-'));
  // the loader reads it
  const loaded = loadCatalogue(catFile, { log: () => {} }).get();
  assert.equal(loaded.get('tokenrouter').limits.tokensPerDay, SOURCE_FACTS.tokenrouter.limits.tokensPerDay);
});

test('K4: groq and mistral need a named model and are never freeOnly; cloudflare needs the account id', (t) => {
  const { run, cfg } = setup(t);
  const noModel = run('source', 'enable', 'groq', '--key-ref', 'svc-groq');
  assert.notEqual(noModel.status, 0);
  assert.match(noModel.stderr, /--model/);
  assert.equal(run('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'llama-3.1-8b-instant').status, 0);
  assert.equal(run('source', 'enable', 'mistral', '--key-ref', 'svc-mistral', '--model', 'mistral-small-latest').status, 0);
  const noAcc = run('source', 'enable', 'cloudflare', '--key-ref', 'svc-cf', '--model', '@cf/meta/llama-3.1-8b-instruct');
  assert.notEqual(noAcc.status, 0);
  assert.match(noAcc.stderr, /--account-id/);
  assert.notEqual(run('source', 'enable', 'cloudflare', '--key-ref', 'svc-cf', '--model', 'm', '--account-id', 'nope').status, 0);
  assert.equal(run('source', 'enable', 'cloudflare', '--key-ref', 'svc-cf', '--model', '@cf/meta/llama-3.1-8b-instruct', '--account-id', ACCOUNT).status, 0);
  const c = cfg();
  for (const n of ['groq', 'mistral', 'cloudflare']) {
    assert.equal(c.adapters[n].freeOnly, undefined, n);
    assert.equal(c.adapters[n].explicitOnly, true, n);
    assert.ok(c.adapters[n].models.length === 1, n);
    assert.equal(c.discovery[n], undefined, n);
  }
  assert.equal(c.adapters.cloudflare.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`);
  assert.ok(!('{account}' in c) && !JSON.stringify(c).includes('{account}'));
  assert.equal(getProfile('cloudflare').baseUrl.includes('{account}'), true);
});

test('K4: --dry-run writes nothing; a shell-looking service name is refused', (t) => {
  const { run, config, dir } = setup(t);
  const before = sha(config);
  const dry = run('source', 'enable', 'tokenrouter', '--key-ref', 'svc-tr', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  assert.equal(sha(config), before);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  assert.notEqual(run('source', 'enable', 'tokenrouter', '--key-ref', 'x; rm -rf ~').status, 0);
  assert.equal(sha(config), before);
});

test('K5: a Keychain service that does not exist is refused and the config is byte-identical', (t) => {
  const { run, config, dir } = setup(t);
  const before = sha(config);
  const r = run('source', 'enable', 'tokenrouter', '--key-ref', 'no-such-service');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no Keychain item/);
  assert.equal(sha(config), before);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('K6: disable removes the adapter, its discovery entry and its catalogue row, and only those', (t) => {
  const { run, cfg, config, catFile } = setup(t);
  const orig = fs.readFileSync(config, 'utf8');
  run('source', 'enable', 'groq', '--key-ref', 'svc-groq', '--model', 'm1');
  assert.equal(run('source', 'enable', 'tokenrouter', '--key-ref', 'svc-tr').status, 0);
  const mid = cfg();
  const off = run('source', 'disable', 'tokenrouter');
  assert.equal(off.status, 0, off.stderr);
  const c = cfg();
  assert.equal(c.adapters.tokenrouter, undefined);
  assert.equal(c.discovery.tokenrouter, undefined);
  assert.deepEqual(c.adapters.groq, mid.adapters.groq);
  assert.deepEqual(c.adapters.keep, mid.adapters.keep);
  assert.deepEqual(JSON.parse(fs.readFileSync(catFile, 'utf8')).sources.map((s) => s.reach.keysmith), ['groq']);
  assert.equal(run('source', 'disable', 'tokenrouter').status !== 0, true, 'disabling twice says so');
  assert.equal(run('source', 'disable', 'groq').status, 0);
  const left = cfg();
  delete left.discovery; delete left.catalogue;
  assert.equal(JSON.stringify(left, null, 2) + '\n', orig, 'enable then disable leaves the original file');
});

test('tokensPerDay: refuses after the day total, resets on the next local day, seeds from usage', () => {
  let t = new Date(2026, 10, 17, 10, 0, 0).getTime();
  const doc = { version: 1, sources: [{ id: 's', reach: { keysmith: 'x' }, limits: { tokensPerDay: 100 }, models: [] }] };
  const f = path.join(os.tmpdir(), `ks-tpd-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  try {
    const mk = (seed = 0) => new CatalogueLimiter({ catalogue: loadCatalogue(f, { log: () => {} }), now: () => t, seedDayTokens: () => seed });
    const l = mk();
    assert.equal(l.admit('x').ok, true);
    l.noteTokens('x', 100);
    const d = l.admit('x');
    assert.equal(d.ok, false);
    assert.match(d.why, /100 tokens per day/);
    t += 24 * 3600_000;
    assert.equal(l.admit('x').ok, true);
    assert.equal(mk(150).admit('x').ok, false, 'a restart counts what the usage log already holds');
    const old = { version: 1, sources: [{ id: 's', reach: { keysmith: 'x' }, limits: { requestsPerDay: 5 } }] };
    fs.writeFileSync(f, JSON.stringify(old));
    assert.equal(loadCatalogue(f, { log: () => {} }).get().get('x').limits.tokensPerDay, null, 'an older file still loads');
  } finally { fs.rmSync(f, { force: true }); }
});

test('K7: enabled tokenrouter against a stub upstream: discover lists the free ones, a paid model is 400, a free one 200', async (t) => {
  const { run, cfg, config, env, home } = setup(t);
  assert.equal(run('source', 'enable', 'tokenrouter', '--key-ref', 'svc-tr').status, 0);
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'free/a', pricing: { prompt: '0', completion: '0' } }, { id: 'paid/b', pricing: { prompt: '1', completion: '1' } }] }));
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'free/a', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  // The key reference is the Keychain's and not resolvable here; point the entry at the stub with a literal.
  const c = cfg();
  c.adapters.tokenrouter.baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  c.adapters.tokenrouter.apiKey = SECRET;
  c.auth = { enabled: true, keys: ['ks_k7_gateway_key_0123456789abcdefghijkl'] };
  fs.writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
  // async: the stub upstream lives in this process, a blocking spawn would starve it
  const d = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'discover', 'tokenrouter'], { env });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (x) => { stdout += x; });
    p.stderr.on('data', (x) => { stderr += x; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /1 free model/);
  assert.ok(!d.stdout.includes(SECRET) && !d.stderr.includes(SECRET));

  const { Gateway } = await import('../src/gateway.js');
  const { createServer } = await import('../src/server.js');
  const { UsageLog } = await import('../src/usage.js');
  const { loadConfig } = await import('../src/config.js');
  const prev = process.env.KEYSMITH_DATA;
  process.env.KEYSMITH_DATA = env.KEYSMITH_DATA;
  const lines = [];
  const loaded = loadConfig({ path: config });
  const usageFile = path.join(home, 'usage.jsonl');
  const usage = new UsageLog(usageFile);
  const gateway = new Gateway(loaded, { log: (m) => lines.push(m), usage });
  const server = createServer(gateway, loaded, { usage, log: (m) => lines.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); // a second instance, on a port of its own
  t.after(() => { server.close(); if (prev === undefined) delete process.env.KEYSMITH_DATA; else process.env.KEYSMITH_DATA = prev; });
  const post = async (model) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${loaded.auth.keys[0]}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
    return { status: res.status, text: await res.text() };
  };
  const paid = await post('tokenrouter/paid/b');
  assert.equal(paid.status, 400, paid.text);
  assert.ok(!hits.includes('POST /v1/chat/completions'), 'the paid model never reached the upstream');
  const free = await post('tokenrouter/free/a');
  assert.equal(free.status, 200, free.text);
  assert.ok(fs.readFileSync(usageFile, 'utf8').includes('tokenrouter'), 'a usage row for the adapter');
  assert.ok(!lines.join('\n').includes(SECRET));
});

test('add cloudflare fills {account} from --account-id and refuses without it', (t) => {
  const { run, cfg } = setup(t);
  const no = run('add', 'cloudflare');
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /--account-id/);
  assert.equal(run('add', 'cloudflare', '--account-id', ACCOUNT).status, 0);
  assert.equal(cfg().adapters.cloudflare.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`);
});
