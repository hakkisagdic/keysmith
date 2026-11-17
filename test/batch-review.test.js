/** Review fixes for batch jobs: cost of a user's own cache_control, and the per-day cap across batches. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function stub(t) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.end(JSON.stringify({ id: 'mb_' + calls.length, processing_status: 'in_progress', request_counts: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { calls, port: srv.address().port };
}

function box(t, port, { keys = [], auth = false, tz } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-review-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    host: '127.0.0.1', port: 0, auth: { enabled: auth, keys }, batch: { enabled: true },
    adapters: { cl: { kind: 'http', wire: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-literal-1' } }, aliases: {},
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  if (tz) env.TZ = tz;
  const run = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a], { env });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d));
    c.on('close', (status) => resolve({ status, all: o }));
  });
  const write = (name, lines) => { const f = path.join(home, name); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; };
  return { run, write };
}
const req = (id, extra = {}) => ({ custom_id: id, params: { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra } });
const submit = (b, file, name, cap, extra = []) => b.run('batch', 'submit', file, '--adapter', 'cl', '--name', name, '--cap-usd', cap, ...extra);

test('estimate counts a cache_control the user wrote at the write rate: a cap below it refuses, nothing sent', async (t) => {
  const s = await stub(t); const b = box(t, s.port);
  const big = 'x'.repeat(400000);
  const plain = b.write('plain.jsonl', [req('p', { system: big })]);
  const marked = b.write('marked.jsonl', [req('m', { system: [{ type: 'text', text: big, cache_control: { type: 'ephemeral', ttl: '1h' } }] })]);
  // ~100k tokens at half of 4 USD/M: ~0.2 unmarked, ~0.4 when billed as a 1-hour write. 0.3 is between.
  const no = await submit(b, marked, 'rm1', '0.3');
  assert.notEqual(no.status, 0, no.all);
  assert.match(no.all, /estimate/i);
  assert.equal(s.calls.length, 0, 'nothing sent');
  const ok = await submit(b, plain, 'rm2', '0.3');
  assert.equal(ok.status, 0, ok.all);
  assert.equal(s.calls.length, 1);
});

test('perDay cap holds across consecutive batches, also in UTC+3', async (t) => {
  const s = await stub(t);
  const b = box(t, s.port, { auth: true, tz: 'Europe/Istanbul', keys: [{ keyHash: 'c'.repeat(64), label: 'tiny', perDay: 4 }] });
  const f = b.write('three.jsonl', [req('a'), req('b'), req('c')]);
  const first = await submit(b, f, 'pd1', '5', ['--key', 'tiny']);
  assert.equal(first.status, 0, first.all);
  const second = await submit(b, f, 'pd2', '5', ['--key', 'tiny']);
  assert.notEqual(second.status, 0, second.all);
  assert.match(second.all, /daily cap/);
  assert.equal(s.calls.length, 1, 'only the first batch reached the stub');
});
