/** Tester's independent checks for batch jobs (K1-K8, K10): own stub, own numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function up(t, mode = 'partial') {
  const calls = [];
  let canceled = false;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const j = (o) => res.end(JSON.stringify(o));
      if (req.method === 'POST' && req.url === '/v1/messages/batches') return j({ id: 'mb_t', processing_status: 'in_progress', request_counts: {} });
      if (req.url.endsWith('/cancel')) { canceled = true; return j({ id: 'mb_t', processing_status: 'canceling' }); }
      if (req.url === '/v1/messages/batches/mb_t') {
        const c = mode === 'expired' ? { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 2 } : canceled ? { processing: 0, succeeded: 0, errored: 0, canceled: 2, expired: 0 } : { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 };
        return j({ id: 'mb_t', processing_status: mode === 'slow' && !canceled ? 'in_progress' : 'ended', request_counts: c });
      }
      if (req.url.endsWith('/results')) {
        const ok = (id) => ({ custom_id: id, result: { type: 'succeeded', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 } } } });
        res.end([ok('a1'), { custom_id: 'a2', result: { type: 'errored', error: { type: 'x', message: 'bad' } } }, ok('a3')].map((x) => JSON.stringify(x)).join('\n') + '\n');
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { calls, port: srv.address().port, posts: () => calls.filter((c) => c === 'POST /v1/messages/batches').length };
}

function box(t, port, { batch = { enabled: true }, keys = [], auth = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tester-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    host: '127.0.0.1', port: 0, auth: { enabled: auth, keys }, ...(batch ? { batch } : {}),
    adapters: {
      cl: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-literal-1' },
      oa: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-literal-2' },
    }, aliases: {},
  }), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const run = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a], { env });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d));
    c.on('close', (status) => resolve({ status, all: o }));
  });
  const input = path.join(home, 'in.jsonl');
  const lines = ['a1', 'a2', 'a3'].map((id) => JSON.stringify({ custom_id: id, params: { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'y'.repeat(700) }] } }));
  fs.writeFileSync(input, lines.join('\n') + '\n');
  const usage = () => { try { return fs.readFileSync(path.join(data, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { run, input, usage, data, home };
}
const sub = (b, name, cap = '5', extra = []) => ['batch', 'submit', b.input, '--adapter', 'cl', '--name', name, '--cap-usd', cap, ...extra];

test('T-K1 submit prints name and USD estimate; stub gets exactly one POST', async (t) => {
  const s = await up(t); const b = box(t, s.port);
  const r = await b.run(...sub(b, 'tk1'));
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /tk1/); assert.match(r.all, /\$\s?0\.\d+/);
  assert.equal(s.posts(), 1);
});

test('T-K2 cap just under the estimate refuses, stub untouched; just over passes', async (t) => {
  const s = await up(t); const b = box(t, s.port);
  const no = await b.run(...sub(b, 'tk2a', '0.01'));
  assert.notEqual(no.status, 0); assert.match(no.all, /estimate/i); assert.match(no.all, /cap/i);
  assert.equal(s.calls.length, 0);
  assert.equal(fs.existsSync(path.join(b.data, 'batch', 'tk2a.json')), false, 'no job file left for a refused job');
  const yes = await b.run(...sub(b, 'tk2b', '0.05'));
  assert.equal(yes.status, 0, yes.all);
});

test('T-K3 openai-wire adapter refused with a clear message, no call', async (t) => {
  const s = await up(t); const b = box(t, s.port);
  const r = await b.run('batch', 'submit', b.input, '--adapter', 'oa', '--name', 'tk3', '--cap-usd', '5');
  assert.notEqual(r.status, 0); assert.match(r.all, /batch/i); assert.equal(s.calls.length, 0);
});

test('T-K4 partial failure: 3 lines, ids kept, failed one flagged', async (t) => {
  const s = await up(t); const b = box(t, s.port);
  await b.run(...sub(b, 'tk4'));
  const r = await b.run('batch', 'results', 'tk4');
  assert.equal(r.status, 0, r.all);
  const lines = fs.readFileSync(b.input.replace(/\.jsonl$/, '.results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.custom_id), ['a1', 'a2', 'a3']);
  assert.ok(lines[1].failed); assert.ok(!lines[0].failed && !lines[2].failed);
  const st = await b.run('batch', 'status', 'tk4');
  assert.match(st.all, /succeeded 2/); assert.match(st.all, /errored 1/);
});

test('T-K5 expired and canceled', async (t) => {
  const s = await up(t, 'expired'); const b = box(t, s.port);
  await b.run(...sub(b, 'tk5a'));
  assert.match((await b.run('batch', 'status', 'tk5a')).all, /expired/);
  const s2 = await up(t, 'slow'); const b2 = box(t, s2.port);
  await b2.run(...sub(b2, 'tk5b'));
  const c = await b2.run('batch', 'cancel', 'tk5b');
  assert.match(c.all, /canceled/); assert.ok(s2.calls.some((x) => x.endsWith('/cancel')));
});

test('T-K6 job survives a new process; same name never posts twice', async (t) => {
  const s = await up(t, 'slow'); const b = box(t, s.port);
  await b.run(...sub(b, 'tk6'));
  const job = JSON.parse(fs.readFileSync(path.join(b.data, 'batch', 'tk6.json'), 'utf8'));
  assert.equal(job.id, 'mb_t');
  const st = await b.run('batch', 'status', 'tk6');
  assert.match(st.all, /in_progress/);
  const again = await b.run(...sub(b, 'tk6'));
  assert.notEqual(again.status, 0);
  assert.equal(s.posts(), 1);
});

test('T-K7 usage rows at exactly half price, cache counts separate, once only', async (t) => {
  const s = await up(t); const b = box(t, s.port);
  await b.run(...sub(b, 'tk7'));
  await b.run('batch', 'results', 'tk7');
  await b.run('batch', 'results', 'tk7');
  const rows = b.usage();
  assert.equal(rows.length, 3, 'one row per request, not doubled by a second fetch');
  const okRows = rows.filter((r) => r.status === 'ok');
  assert.equal(okRows.length, 2);
  // live opus-5-5: in 4, out 20, cacheRead 0.2, cacheWrite 5 per M; half, 5m write:
  // 1000*2 + 500*10 + 2000*0.1 + 400*2.5 = 8200 micro-USD
  for (const r of okRows) {
    assert.ok(Math.abs(r.cost.usd - 0.0082) < 1e-9, JSON.stringify(r));
    assert.equal(r.usage.cacheRead, 2000); assert.equal(r.usage.cacheWrite, 400); assert.equal(r.usage.output, 500);
    assert.ok(r.batch === true || r.cost.batch === true);
  }
  assert.equal(rows.find((r) => r.status !== 'ok').cost.usd, 0);
});

test('T-K8 key gate: deny, out-of-allow, perDay, and batch off', async (t) => {
  const s = await up(t);
  const keys = [
    { keyHash: 'a'.repeat(64), label: 'narrow', allow: ['oa'] },
    { keyHash: 'b'.repeat(64), label: 'denied', deny: ['cl'] },
    { keyHash: 'c'.repeat(64), label: 'tiny', perDay: 2 },
    { keyHash: 'd'.repeat(64), label: 'fine', allow: ['cl'] },
  ];
  const b = box(t, s.port, { keys, auth: true });
  for (const [i, k] of ['narrow', 'denied', 'tiny'].entries()) {
    const r = await b.run(...sub(b, `tk8${i}`, '5', ['--key', k]));
    assert.notEqual(r.status, 0, `${k}: ${r.all}`);
  }
  assert.equal(s.calls.length, 0, 'nothing sent for refused keys');
  const ok = await b.run(...sub(b, 'tk8ok', '5', ['--key', 'fine']));
  assert.equal(ok.status, 0, ok.all);
  const s2 = await up(t); const off = box(t, s2.port, { batch: null });
  const r = await off.run(...sub(off, 'tk8off'));
  assert.notEqual(r.status, 0); assert.match(r.all, /off/i);
  assert.equal(s2.calls.length, 0);
  assert.equal(fs.existsSync(path.join(off.data, 'batch')), false);
});

// Private patterns (host, user name, paths) must not live in a public repo: they come from the
// environment, e.g. KEYSMITH_PRIVATE_PATTERNS='pattern1|pattern2' (a regex source). Unset: skipped.
test('T-K10 no private path, email, host or key in the lines the batch change adds', { skip: !process.env.KEYSMITH_PRIVATE_PATTERNS && 'KEYSMITH_PRIVATE_PATTERNS is not set' }, () => {
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const base = git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  assert.ok(base, 'merge-base found (fetch origin/main first)');
  const added = git('diff', base, '--', 'src', 'README.md', 'test').stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  // Built from parts so this file does not itself spell the patterns the repo scans for.
  const generic = ['/Use' + 'rs/', '@gm' + 'ail', '@pro' + 'ton', 'sk-ant-[A-Za-z0-9]{10,}', 'AIza[0-9A-Za-z_-]{20,}'].join('|');
  const bad = new RegExp(`${generic}|${process.env.KEYSMITH_PRIVATE_PATTERNS}`);
  assert.ok(!bad.test(added), String(added.match(bad)?.[0]));
});
