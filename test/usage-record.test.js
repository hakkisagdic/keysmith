/** `keysmith usage record`: runs made outside keysmith, written once, counted, never long. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
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

test('an external claude-* row is not re-priced as metered and doctor does not name it', (t) => {
  const { run } = sandbox(t);
  assert.equal(run('usage', 'record', '--source', 'kiro-cli', '--model', 'claude-sonnet-4-5', '--input', '1000000', '--output', '200000').status, 0);
  const j = JSON.parse(run('usage', '--format', 'json').stdout);
  assert.equal(j.meteredUsd, 0);
  assert.equal(j.groups[0].meteredUsd, 0);
  assert.equal(j.unpricedRequests, 0);
  assert.doesNotMatch(run('doctor').all, /price warning|price claude-sonnet-4-5/);
});

test('provider token counts and key label reach usage.jsonl across non-stream, stream, and partial-stream errors', async (t) => {
  const { data } = sandbox(t);
  fs.mkdirSync(data, { recursive: true });
  let mode = 'json-ok';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (mode === 'json-ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chat-json',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 41, completion_tokens: 17, total_tokens: 58 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (mode === 'sse-ok') {
        send({ id: 's1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] });
        send({ id: 's1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 29, completion_tokens: 11, total_tokens: 40 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (mode === 'sse-err-after-delta') {
        send({ id: 's2', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' } }] });
        send({ id: 's2', choices: [], usage: { prompt_tokens: 19, completion_tokens: 5, total_tokens: 24 } });
        send({ error: { message: 'mid-stream failure', type: 'server_error' } });
        return res.end();
      }
      if (mode === 'sse-err-pre-delta') {
        send({ id: 's3', choices: [], usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 } });
        send({ error: { message: 'early stream failure', type: 'server_error' } });
        return res.end();
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const clientKey = 'ks_' + crypto.randomBytes(24).toString('base64url');
  const usageFile = path.join(data, 'usage.jsonl');
  const usage = new UsageLog(usageFile);
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    auth: {
      enabled: true,
      keys: [{ key: clientKey, label: 'changelog', allow: ['alias:cheap-public', 'groq/openai/gpt-oss-120b'], perDay: 20 }],
    },
    adapters: {
      groq: {
        kind: 'http',
        wire: 'openai',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: false,
        explicitOnly: true,
        modelsOnly: true,
        models: ['openai/gpt-oss-120b'],
      },
    },
    aliases: {
      'cheap-public': ['groq/openai/gpt-oss-120b'],
    },
    aliasPolicy: {
      'cheap-public': { allowExplicitOnly: true },
    },
  };

  const gw = new Gateway(cfg);
  const srv = createServer(gw, cfg, { usage, holdMs: 0 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    srv.closeAllConnections?.();
    srv.close();
  });
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  const post = async (stream) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${clientKey}` },
      body: JSON.stringify({ model: 'cheap-public', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return r;
  };

  mode = 'json-ok';
  assert.equal((await post(false)).status, 200);
  mode = 'sse-ok';
  assert.equal((await post(true)).status, 200);
  mode = 'sse-err-after-delta';
  assert.equal((await post(true)).status, 200);
  mode = 'sse-err-pre-delta';
  assert.equal((await post(true)).status, 502);

  // Also test partial stream usage preserved through Gateway.collect on stream errors before delta.
  mode = 'sse-err-pre-delta';
  await assert.rejects(
    () => gw.collect({ model: 'cheap-public', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => {
      assert.equal(e.usage?.input, 13);
      assert.equal(e.usage?.output, 2);
      return true;
    },
  );

  await new Promise((r) => setTimeout(r, 30));
  const logged = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(logged.length, 4);

  assert.equal(logged[0].status, 'ok');
  assert.equal(logged[0].label, 'changelog');
  assert.equal(logged[0].usage.input, 41);
  assert.equal(logged[0].usage.output, 17);

  assert.equal(logged[1].status, 'ok');
  assert.equal(logged[1].stream, true);
  assert.equal(logged[1].label, 'changelog');
  assert.equal(logged[1].usage.input, 29);
  assert.equal(logged[1].usage.output, 11);

  assert.equal(logged[2].status, 'error');
  assert.equal(logged[2].label, 'changelog');
  assert.equal(logged[2].usage.input, 19);
  assert.equal(logged[2].usage.output, 5);

  assert.equal(logged[3].status, 'error');
  assert.equal(logged[3].label, 'changelog');
  assert.equal(logged[3].usage.input, 13);
  assert.equal(logged[3].usage.output, 2);
});
