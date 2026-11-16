/** `keysmith usage record`: runs made outside keysmith, written once, counted, never long. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageLog } from '../src/usage.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-urec-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const rows = () => {
    try { return fs.readFileSync(path.join(data, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { run, rows, data };
}

test('the same --id twice leaves one row', (t) => {
  const { run, rows } = sandbox(t);
  assert.equal(run('usage', 'record', '--source', 'qoder', '--model', 'm', '--tag', 'job/1', '--id', 'r1').status, 0);
  const second = run('usage', 'record', '--source', 'qoder', '--model', 'm', '--tag', 'job/1', '--id', 'r1');
  assert.equal(second.status, 0);
  assert.match(second.all, /already recorded/);
  assert.equal(rows().length, 1);
});

test('--accepted correction adds an amends row that is not counted', (t) => {
  const { run, rows } = sandbox(t);
  run('usage', 'record', '--source', 'qoder', '--id', 'r2', '--accepted', 'true');
  run('usage', 'record', '--source', 'qoder', '--id', 'r2', '--accepted', 'false');
  const r = rows();
  assert.equal(r.length, 2);
  assert.equal(r[1].amends, true);
  assert.equal(r[1].accepted, false);
  const j = JSON.parse(run('usage', '--by', 'adapter', '--format', 'json').stdout);
  const row = (j.groups || []).find((x) => x.adapter === 'qoder');
  assert.equal(row.requests, 1);
});

test('usage --by adapter counts an external row by its requests', (t) => {
  const { run } = sandbox(t);
  run('usage', 'record', '--source', 'qoder', '--requests', '3', '--input', '10', '--output', '5');
  const j = JSON.parse(run('usage', '--by', 'adapter', '--format', 'json').stdout);
  const row = (j.groups || []).find((x) => x.adapter === 'qoder');
  assert.equal(row.requests, 3);
});

test('a row stays under 512 bytes, long fields clipped', (t) => {
  const { run, data } = sandbox(t);
  run('usage', 'record', '--source', 'qoder', '--model', 'm', '--tag', 'job/1', '--id', 'r1', '--input', '1200', '--output', '300', '--ms', '4000');
  const line = fs.readFileSync(path.join(data, 'usage.jsonl'), 'utf8').split('\n')[0];
  assert.ok(Buffer.byteLength(line) < 512, `${Buffer.byteLength(line)} bytes`);
  const long = 'x'.repeat(1000);
  run('usage', 'record', '--source', 'qoder', '--model', long, '--tag', long, '--id', long);
  const rows = fs.readFileSync(path.join(data, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const k of ['model', 'tag', 'id']) assert.equal(rows[1][k].length, 128);
});

test('--from reads one record per line', (t) => {
  const { run, rows, data } = sandbox(t);
  fs.mkdirSync(data, { recursive: true });
  const f = path.join(data, 'in.jsonl');
  fs.writeFileSync(f, '{"source":"a","id":"1"}\n{"source":"b","id":"2"}\n');
  assert.equal(run('usage', 'record', '--from', f).status, 0);
  assert.deepEqual(rows().map((r) => r.source), ['a', 'b']);
});

test('an open UsageLog sees a row another process appended, without rebuilding', (t) => {
  const { run, data } = sandbox(t);
  fs.mkdirSync(data, { recursive: true });
  const log = new UsageLog(path.join(data, 'usage.jsonl'));
  const before = log.query({ by: ['adapter'] });
  assert.equal((before.groups || []).length, 0);
  run('usage', 'record', '--source', 'qoder', '--requests', '2');
  const after = log.query({ by: ['adapter'] });
  assert.equal(after.groups.find((x) => x.adapter === 'qoder').requests, 2);
});

test('monthTokensByAdapter sums this month', (t) => {
  const { data } = sandbox(t);
  fs.mkdirSync(data, { recursive: true });
  const log = new UsageLog(path.join(data, 'usage.jsonl'));
  log.recordExternal({ source: 'qoder', input: 10, output: 5 });
  assert.equal(log.monthTokensByAdapter().qoder, 15);
});
