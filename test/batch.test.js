/** Batch jobs (K1-K8): a stub Message Batches upstream on its own port, the CLI run as a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function stub(t, { results = null, endState = 'ended', counts = null } = {}) {
  const log = [];
  const state = { status: 'in_progress', canceled: false };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      log.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers['x-api-key'] });
      const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      const reqs = log.find((l) => l.method === 'POST' && l.url === '/v1/messages/batches')?.body?.requests || [];
      if (req.method === 'POST' && req.url === '/v1/messages/batches') return json({ id: 'msgbatch_1', processing_status: 'in_progress', request_counts: { processing: reqs.length || 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 } });
      if (req.method === 'POST' && req.url === '/v1/messages/batches/msgbatch_1/cancel') { state.canceled = true; return json({ id: 'msgbatch_1', processing_status: 'canceling' }); }
      if (req.method === 'GET' && req.url === '/v1/messages/batches/msgbatch_1') {
        const ended = state.canceled || endState === 'ended' || endState === 'expired';
        const c = counts || (endState === 'expired' ? { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: reqs.length } : { processing: 0, succeeded: reqs.length - 1, errored: 1, canceled: 0, expired: 0 });
        return json({ id: 'msgbatch_1', processing_status: ended ? 'ended' : 'in_progress', request_counts: ended ? c : { ...c, processing: reqs.length }, results_url: null });
      }
      if (req.method === 'GET' && req.url === '/v1/messages/batches/msgbatch_1/results') {
        res.end((results || reqs.map((r, i) => (i === 1
          ? { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'invalid_request_error', message: 'bad' } } }
          : { custom_id: r.custom_id, result: { type: 'succeeded', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } } }))).map((x) => JSON.stringify(x)).join('\n') + '\n');
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { log, port: srv.address().port, posts: () => log.filter((l) => l.method === 'POST' && l.url === '/v1/messages/batches').length };
}

function sandbox(t, port, { enabled = true, keys = [], adapters = null, auth = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-batch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  const cfg = {
    host: '127.0.0.1', port: 0, auth: { enabled: auth, keys },
    batch: enabled ? { enabled: true } : undefined,
    adapters: adapters || {
      claude: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-literal-xyz' },
      oa: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-literal-abc' },
    },
    aliases: {},
  };
  fs.writeFileSync(config, JSON.stringify(cfg), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  // async: the stub lives in this process, so a blocking spawn would starve it
  const run = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => c.kill(), 30_000);
    c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, all: `${stdout}${stderr}` }); });
  });
  const input = path.join(home, 'jobs.jsonl');
  const write = (n = 3, extra = {}) => fs.writeFileSync(input, Array.from({ length: n }, (_, i) => JSON.stringify({ custom_id: `r${i + 1}`, params: { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(700) }], ...extra } })).join('\n') + '\n');
  write();
  const rows = () => { try { return fs.readFileSync(path.join(data, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { run, input, write, rows, data, env };
}

test('K1 submit prints the name and the estimate, one batch reaches the stub', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  const r = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j1', '--cap-usd', '5');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /submitted j1 \(3 requests/);
  assert.match(r.all, /estimate \$/);
  assert.equal(s.posts(), 1);
  assert.equal(s.log[0].body.requests.length, 3);
  assert.equal(s.log[0].auth, 'sk-test-literal-xyz');
  assert.ok(!r.all.includes('sk-test-literal-xyz'));
});

test('K2 an estimate above the cap sends nothing', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  const r = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j2', '--cap-usd', '0.0001');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /estimate \$[\d.]+ is above the cap \$0\.0001/);
  assert.equal(s.log.length, 0);
  assert.ok(!fs.existsSync(path.join(sb.data, 'batch', 'j2.json')));
});

test('K2 a model without a price is refused: no cap can be checked', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  sb.write(1, { model: 'mystery-1' });
  const r = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j2b', '--cap-usd', '50');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no price/);
  assert.equal(s.log.length, 0);
});

test('K3 an openai-wire adapter has no batch interface', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  const r = await sb.run('batch', 'submit', sb.input, '--adapter', 'oa', '--name', 'j3', '--cap-usd', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no batch interface/);
  assert.equal(s.log.length, 0);
});

test('K4 partial failure: 3 result lines, same custom_ids, the failed one marked; status counts', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  assert.equal((await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j4', '--cap-usd', '5')).status, 0);
  const st = await sb.run('batch', 'status', 'j4');
  assert.match(st.all, /succeeded 2, errored 1, expired 0/);
  const r = await sb.run('batch', 'results', 'j4');
  assert.equal(r.status, 0, r.all);
  const lines = fs.readFileSync(sb.input.replace(/\.jsonl$/, '.results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.custom_id), ['r1', 'r2', 'r3']);
  assert.equal(lines[1].failed, true);
  assert.equal(lines[0].failed, undefined);
});

test('K5 expiry ends as expired; cancel reaches the stub and ends canceled', async (t) => {
  const e = await stub(t, { endState: 'expired' }); const a = sandbox(t, e.port);
  await a.run('batch', 'submit', a.input, '--adapter', 'claude', '--name', 'j5', '--cap-usd', '5');
  assert.match((await a.run('batch', 'status', 'j5')).all, /j5  expired/);
  const s = await stub(t, { endState: 'running' }); const b = sandbox(t, s.port);
  await b.run('batch', 'submit', b.input, '--adapter', 'claude', '--name', 'j5c', '--cap-usd', '5');
  assert.match((await b.run('batch', 'status', 'j5c')).all, /j5c  in_progress/);
  const c = await b.run('batch', 'cancel', 'j5c');
  assert.equal(c.status, 0, c.all);
  assert.ok(s.log.some((l) => l.url.endsWith('/cancel')));
  assert.match(c.all, /j5c  canceled/);
});

test('K6 after a restart the job is found on disk and polled; a second submit of the name sends nothing', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  // submit in a child that is stopped by its own pid right after
  const child = spawn(process.execPath, [CLI, 'batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j6', '--cap-usd', '5'], { env: sb.env, stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  assert.equal(s.posts(), 1);
  const st = await sb.run('batch', 'status');
  assert.match(st.all, /j6  (ended|in_progress)/);
  const again = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j6', '--cap-usd', '5');
  assert.notEqual(again.status, 0);
  assert.match(again.all, /exists already/);
  assert.equal(s.posts(), 1);
});

test('K7 one usage row per request, cost = half the live price, cache counts apart, written once', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j7', '--cap-usd', '5');
  assert.equal((await sb.run('batch', 'results', 'j7')).status, 0);
  assert.equal((await sb.run('batch', 'results', 'j7')).status, 0);
  const rows = sb.rows().filter((r) => r.batch);
  assert.equal(rows.length, 3);
  const ok = rows.filter((r) => r.status === 'ok');
  assert.equal(ok.length, 2);
  // opus 5.5 live: input 4, output 20, cacheRead 0.2 per MTok; half of it: 1000*2 + 500*10 + 2000*0.1 = 7200 / 1e6
  for (const r of ok) {
    assert.equal(r.cost.usd, 0.0072);
    assert.equal(r.usage.cacheRead, 2000);
    assert.equal(r.usage.input, 3000);
  }
  assert.equal(rows.find((r) => r.status === 'error').cost.usd, 0);
});

test('K8 a key whose allow-list does not reach the adapter is refused; batch off says so', async (t) => {
  const s = await stub(t);
  const keys = [{ key: 'ks_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'narrow', allow: ['oa'] }, { key: 'ks_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'wide', allow: ['claude'] }];
  const sb = sandbox(t, s.port, { keys, auth: true });
  const no = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j8', '--cap-usd', '5', '--key', 'narrow');
  assert.notEqual(no.status, 0);
  assert.match(no.all, /refused for key fp:[0-9a-f]{8} \(narrow\)/);
  assert.equal(s.log.length, 0);
  assert.ok(!no.all.includes('ks_aaaa'));
  const yes = await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'j8', '--cap-usd', '5', '--key', 'wide');
  assert.equal(yes.status, 0, yes.all);
  const off = await stub(t); const o = sandbox(t, off.port, { enabled: false });
  const r = await o.run('batch', 'submit', o.input, '--adapter', 'claude', '--name', 'x', '--cap-usd', '5');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /batch is off/);
  assert.equal(off.log.length, 0);
  assert.ok(!fs.existsSync(path.join(o.data, 'batch')));
});

test('--cache marks a long system prompt once and the estimate counts the 1-hour write', async (t) => {
  const s = await stub(t); const sb = sandbox(t, s.port);
  sb.write(2, { system: 'rule. '.repeat(1500) });
  assert.equal((await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'jc', '--cap-usd', '5', '--cache')).status, 0);
  const sent = s.log[0].body.requests;
  assert.deepEqual(sent[0].params.system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
  s.log.length = 0;
  sb.write(2, { system: 'short' });
  await sb.run('batch', 'submit', sb.input, '--adapter', 'claude', '--name', 'jd', '--cap-usd', '5', '--cache');
  assert.equal(s.log[0].body.requests[0].params.system, 'short');
});
