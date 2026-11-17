/** QA (black box) for 20261117-saglayicilari-ac: K1-K7 against the real CLI, a real temporary Keychain item, a child gateway on its own port. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SEC = '/usr/bin/security';
const SVC = `keysmith-qa-${process.pid}-${Date.now()}`;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const hasSec = fs.existsSync(SEC);

before(() => { if (hasSec) spawnSync(SEC, ['add-generic-password', '-s', SVC, '-a', 'keysmith', '-w', 'qa-dummy-value-not-a-key']); });
after(() => { if (hasSec) spawnSync(SEC, ['delete-generic-password', '-s', SVC, '-a', 'keysmith'], { stdio: 'ignore' }); });

function env0(t, base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-qa-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify(base || { port: 8787, auth: { enabled: false, keys: [] }, adapters: { keep: { kind: 'http', baseUrl: 'http://x/v1', apiKey: '{env:X}' } }, aliases: { fast: ['keep/m'] } }, null, 2) + '\n', { mode: 0o600 });
  const env = { ...process.env, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  return { home, config, env, run, cfg: () => JSON.parse(fs.readFileSync(config, 'utf8')), baks: () => fs.readdirSync(home).filter((f) => f.includes('.bak-')) };
}

test('K1: every subcommand answers --help and -h with help, exit 0, config untouched', (t) => {
  const { run, config, home } = env0(t);
  const before = sha(config);
  const cmds = ['init', 'add', 'add tokenrouter', 'remove', 'set', 'upgrade', 'enable', 'disable', 'vision', 'tools', 'alias', 'route', 'adapters', 'models', 'serve', 'start', 'stop', 'status', 'install-service', 'uninstall-service', 'chat', 'doctor', 'tunnel', 'usage', 'discover', 'config', 'source', 'source enable', 'source disable', 'key', 'scrub-logs'];
  for (const c of cmds) for (const h of ['--help', '-h']) {
    const r = run(...c.split(' '), h);
    assert.equal(r.status, 0, `${c} ${h}: ${r.stderr}`);
    assert.ok((r.stdout + r.stderr).length > 40, `${c} ${h} printed help`);
    assert.equal(sha(config), before, `${c} ${h} changed the config`);
  }
  assert.equal(run('add', 'tokenrouter', '--help').stdout.includes('adapters.tokenrouter'), false);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(config, 'utf8')).adapters), JSON.stringify({ keep: { kind: 'http', baseUrl: 'http://x/v1', apiKey: '{env:X}' } }));
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.json']);
});

test('K2: config set --dry-run writes nothing; real write: get true, backup, mode 0600', (t) => {
  const { run, config, home, baks } = env0(t);
  const b = sha(config);
  const d = run('config', 'set', 'discovery.enabled', 'true', '--dry-run');
  assert.equal(d.status, 0, d.stderr);
  assert.equal(sha(config), b);
  assert.deepEqual(baks(), []);
  const w = run('config', 'set', 'discovery.enabled', 'true');
  assert.equal(w.status, 0, w.stderr);
  assert.equal(run('config', 'get', 'discovery.enabled').stdout.trim(), 'true');
  assert.equal(baks().length, 1);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  for (const f of baks()) assert.equal(fs.statSync(path.join(home, f)).mode & 0o777, 0o600);
});

test('K3: unknown key and type error refused, file unchanged, known keys listed', (t) => {
  const { run, config } = env0(t);
  const b = sha(config);
  const u = run('config', 'set', 'bilinmeyen.anahtar', '1');
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /discovery\.enabled/);
  assert.match(u.stderr, /port/);
  const e = run('config', 'set', 'port', 'abc');
  assert.notEqual(e.status, 0);
  assert.notEqual(run('config', 'set', 'port', '99999').status, 0);
  assert.notEqual(run('config', 'set', 'adapters.keep.apiKey', 'x').status, 0, 'adapters are not set through config');
  assert.equal(sha(config), b);
});

test('K4/K5/K6: enable with a real temporary Keychain item, refuse a missing one, disable restores', { skip: !hasSec }, (t) => {
  const { run, config, cfg, home } = env0(t);
  const orig = fs.readFileSync(config, 'utf8');
  const b = sha(config);
  const no = run('source', 'enable', 'tokenrouter', '--key-ref', `${SVC}-missing`);
  assert.notEqual(no.status, 0);
  assert.equal(sha(config), b, 'K5 byte-identical');
  assert.deepEqual(fs.readdirSync(home).filter((f) => f !== 'config.json'), [], 'K5 nothing else written');

  const r = run('source', 'enable', 'tokenrouter', '--key-ref', SVC);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restart/i);
  const c = cfg();
  assert.match(c.adapters.tokenrouter.apiKey, /^\{exec:.*security.*\}$/);
  assert.ok(!JSON.stringify(c).includes('qa-dummy-value'));
  assert.equal(c.adapters.tokenrouter.freeOnly, true);
  assert.equal(c.discovery.enabled, true);
  for (const [k, v] of Object.entries(c.aliases)) assert.ok(!JSON.stringify(v).includes('tokenrouter'), k);
  const cat = JSON.parse(fs.readFileSync(c.catalogue.replace(/^~/, os.homedir()), 'utf8'));
  assert.ok(cat.sources.some((s) => s.reach.keysmith === 'tokenrouter' && s.limits));
  assert.ok(!r.stdout.includes('qa-dummy-value'));
  // the stored reference really resolves through the system tool (value never printed)
  const exec = c.adapters.tokenrouter.apiKey.slice(6, -1).split(' ');
  const got = spawnSync(exec[0], exec.slice(1), { encoding: 'utf8' });
  assert.equal(got.stdout.trim(), 'qa-dummy-value-not-a-key');

  const off = run('source', 'disable', 'tokenrouter');
  assert.equal(off.status, 0, off.stderr);
  const c2 = cfg();
  assert.equal(c2.adapters.tokenrouter, undefined);
  assert.deepEqual(c2.adapters.keep, c.adapters.keep);
  assert.deepEqual(c2.aliases, c.aliases);
  const cat2 = JSON.parse(fs.readFileSync(c.catalogue.replace(/^~/, os.homedir()), 'utf8'));
  assert.ok(!cat2.sources.some((s) => s.reach.keysmith === 'tokenrouter'));
  assert.notEqual(orig, '');
});

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = async (url, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error('no start ' + url); };

test('K7: child gateway on its own port: discover lists free, paid 400, free 200 + usage row, stopped by its PID', async (t) => {
  const e = env0(t);
  const hits = [];
  const up = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${raw.includes('paid') ? 'paid' : ''}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'free/a', pricing: { prompt: '0', completion: '0' } }, { id: 'paid/b', pricing: { prompt: '2', completion: '2' } }] }));
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: 'free/a', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const KEY = 'ks_qa_gateway_key_0123456789abcdefghijklmn';
  const c = e.cfg();
  c.adapters.tokenrouter = { kind: 'http', baseUrl: `http://127.0.0.1:${up.address().port}/v1`, apiKey: 'upstream-qa-literal', freeOnly: true, explicitOnly: true };
  c.discovery = { enabled: true, tokenrouter: { inputPricePath: 'pricing.prompt', outputPricePath: 'pricing.completion' } };
  c.auth = { enabled: true, keys: [KEY] };
  const port = await freePort();
  c.port = port;
  fs.writeFileSync(e.config, JSON.stringify(c), { mode: 0o600 });
  const d = await new Promise((resolve) => { const p = spawn(process.execPath, [CLI, 'discover', 'tokenrouter'], { env: e.env }); let o = ''; p.stdout.on('data', (x) => (o += x)); p.stderr.on('data', (x) => (o += x)); p.on('close', (s) => resolve({ s, o })); });
  assert.equal(d.s, 0, d.o);
  assert.match(d.o, /1 free model/);
  const found = fs.readdirSync(path.join(e.home, 'data'), { recursive: true }).map((f) => path.join(e.home, 'data', f)).filter((f) => fs.statSync(f).isFile());
  const txt = found.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(txt.includes('free/a') && !txt.includes('paid/b'), 'discovered list holds only the free model: ' + found.join(','));

  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { env: e.env, stdio: 'ignore' });
  const pid = child.pid;
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch {} });
  await wait(`http://127.0.0.1:${port}/health`).catch(() => wait(`http://127.0.0.1:${port}/v1/models`));
  const post = async (model) => { const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) }); return { status: r.status, text: await r.text() }; };
  const paid = await post('tokenrouter/paid/b');
  assert.equal(paid.status, 400, paid.text);
  assert.ok(!hits.some((h) => h.startsWith('POST') ), 'paid model never reached upstream');
  const free = await post('tokenrouter/free/a');
  assert.equal(free.status, 200, free.text);
  const nokey = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(nokey.status, 401);
  await new Promise((r) => setTimeout(r, 500));
  const u = spawnSync(process.execPath, [CLI, 'usage', '--by', 'adapter'], { env: e.env, encoding: 'utf8' });
  assert.match(u.stdout, /tokenrouter/, u.stdout + u.stderr);
  assert.ok(!(u.stdout + d.o).includes('upstream-qa-literal'));
  process.kill(pid, 'SIGTERM');
  await new Promise((r) => child.once('exit', r));
});
