/**
 * Server-level integration tests for structured-output healing (acceptance checks 2-7, 9,
 * tool passthrough preservation, and live SIGHUP/config reload) using local HTTP stubs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const mint = () => 'k' + 's_' + crypto.randomBytes(24).toString('base64url');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-so-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Multi-adapter stub upstream routed by `/<id>/v1/...`.
 * `answer[id]` may be a string or a function `(reqObj) => { status?, text?, usage?, toolCalls? }`.
 */
async function stubUpstreams(t) {
  const hits = {};
  const bodies = {};
  const answer = {};
  const srv = http.createServer((req, res) => {
    const id = req.url.split('/')[1] || 'up';
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }));
      }
      hits[id] = (hits[id] || 0) + 1;
      const body = raw ? JSON.parse(raw) : {};
      (bodies[id] ||= []).push(body);
      const spec = typeof answer[id] === 'function' ? answer[id](body) : { text: answer[id] ?? '{"ok":true}' };
      const status = spec.status || 200;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: spec.error || 'upstream fail' } }));
      }
      const usage = spec.usage || { prompt_tokens: 5, completion_tokens: 3 };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl_stub',
          object: 'chat.completion',
          model: body.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: spec.text ?? null,
              ...(spec.toolCalls ? { tool_calls: spec.toolCalls } : {}),
            },
            finish_reason: spec.toolCalls ? 'tool_calls' : 'stop',
          }],
          usage,
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = String(spec.text ?? '');
      // Send in chunks when large so streaming/buffering exercises multi-delta assembly
      const chunkSize = 65536;
      if (!text) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      } else {
        for (let i = 0; i < text.length; i += chunkSize) {
          const piece = text.slice(i, i + chunkSize);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { ...(i === 0 ? { role: 'assistant' } : {}), content: piece } }] })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { root: `http://127.0.0.1:${srv.address().port}`, hits, bodies, answer };
}

async function rig(t, { structuredOutput, cache, circuitBreaker, adapters = ['bad', 'good'], aliases = { route: ['bad/m', 'good/m'] }, configFile = false } = {}) {
  const up = await stubUpstreams(t);
  const dir = tmp(t);
  const key = mint();
  const clock = { t: Date.UTC(2026, 10, 22, 12, 0, 0) };
  const now = () => clock.t;
  const cfg = {
    auth: { enabled: true, keys: [key] },
    limits: { streamHoldMs: 250 },
    adapters: Object.fromEntries(adapters.map((id) => [
      id,
      { kind: 'http', wire: 'openai', baseUrl: `${up.root}/${id}/v1`, apiKey: false, models: ['m'] },
    ])),
    aliases,
  };
  if (structuredOutput !== undefined) cfg.structuredOutput = structuredOutput;
  if (cache !== undefined) cfg.cache = cache;
  if (circuitBreaker !== undefined) cfg.circuitBreaker = circuitBreaker;

  let cfgPath = null;
  if (configFile) {
    cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    cfg._path = cfgPath;
  }

  const logs = [];
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now });
  const gateway = new Gateway(cfg, { now, log: (m) => logs.push(m) });
  const server = createServer(gateway, cfg, { usage, log: (m) => logs.push(m), now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (route, body, headers = {}) => {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text && text.trim().startsWith('{')) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, text, json, headers: res.headers };
  };

  const get = async (route) => {
    const res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${key}` } });
    return { status: res.status, json: await res.json() };
  };

  return { up, cfg, cfgPath, key, logs, usage, gateway, server, post, get };
}

function stripFreshChat(payload) {
  const { id, created, ...rest } = payload;
  return rest;
}

function stripFreshResponses(payload) {
  const { id, created_at, output, ...rest } = payload;
  return {
    ...rest,
    output: (output || []).map(({ id: _itemId, ...item }) => item),
  };
}

test('Check 2: chat completion heals fenced JSON with trailing comma and records healed/valid in usage', async (t) => {
  const r = await rig(t, { structuredOutput: { mode: 'heal' }, adapters: ['good'], aliases: {} });
  r.up.answer.good = 'Here you go: ```json {"a":1,}```';

  const healedRes = await r.post('/v1/chat/completions', {
    model: 'good/m',
    messages: [{ role: 'user', content: 'give json' }],
    response_format: { type: 'json_object' },
  });
  assert.equal(healedRes.status, 200);
  assert.equal(healedRes.json.choices[0].message.content, '{"a":1}');
  assert.equal(r.up.bodies.good[0].messages[0].role, 'system');
  assert.match(r.up.bodies.good[0].messages[0].content, /JSON/i);

  r.up.answer.good = '{"a":2}';
  const validRes = await r.post('/v1/chat/completions', {
    model: 'good/m',
    messages: [{ role: 'user', content: 'give valid json' }],
    response_format: { type: 'json_object' },
  });
  assert.equal(validRes.status, 200);
  assert.equal(validRes.json.choices[0].message.content, '{"a":2}');

  const usageRes = await r.get('/v1/keysmith/usage?tail=5');
  assert.equal(usageRes.status, 200);
  const rows = usageRes.json.entries;
  assert.equal(rows[0].structuredOutput, 'valid');
  assert.equal(rows[0].healed, undefined);
  assert.equal(rows[1].structuredOutput, 'healed');
  assert.equal(rows[1].healed, true);
});

test('Check 3: json_schema mismatch yields 502 invalid_output on single leg and fails over on alias with failedLegs + usage recorded', async (t) => {
  const r = await rig(t, { structuredOutput: { mode: 'heal' } });
  const schema = {
    type: 'object',
    properties: { a: { type: 'integer' }, note: { type: 'string' } },
    required: ['a'],
  };
  r.up.answer.bad = () => ({
    text: '{"b":"SECRET_MODEL_TEXT_LEAK"}',
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });
  r.up.answer.good = () => ({
    text: '{"a":42}',
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  });

  // Single leg returns 502 invalid_output without leaking model text
  const single = await r.post('/v1/chat/completions', {
    model: 'bad/m',
    messages: [{ role: 'user', content: 'need a' }],
    response_format: { type: 'json_schema', json_schema: { name: 'obj', strict: true, schema } },
  });
  assert.equal(single.status, 502);
  assert.equal(single.json.error.type, 'invalid_output');
  assert.match(single.json.error.message, /missing required property "a"/);
  assert.ok(!JSON.stringify(single.json).includes('SECRET_MODEL_TEXT_LEAK'));

  // Route [bad/m, good/m] fails over cleanly and records bad/m in failedLegs + combined tokens
  const routed = await r.post('/v1/chat/completions', {
    model: 'route',
    messages: [{ role: 'user', content: 'need a' }],
    response_format: { type: 'json_schema', json_schema: { name: 'obj', strict: true, schema } },
  });
  assert.equal(routed.status, 200);
  assert.equal(routed.json.choices[0].message.content, '{"a":42}');
  assert.equal(r.up.hits.bad, 2);
  assert.equal(r.up.hits.good, 1);

  const rows = (await r.get('/v1/keysmith/usage?tail=5')).json.entries;
  const routeRow = rows[0];
  const singleRow = rows[1];
  assert.equal(singleRow.status, 'error');
  assert.equal(singleRow.failure, 'invalid_output');
  assert.equal(singleRow.usage.input, 11);
  assert.equal(singleRow.usage.output, 7);
  assert.ok(!JSON.stringify(singleRow).includes('SECRET_MODEL_TEXT_LEAK'));

  assert.equal(routeRow.status, 'ok');
  assert.equal(routeRow.adapter, 'good');
  assert.equal(routeRow.structuredOutput, 'valid');
  assert.equal(routeRow.usage.input, 19);
  assert.equal(routeRow.usage.output, 11);
  assert.equal(routeRow.failedLegs.length, 1);
  assert.equal(routeRow.failedLegs[0].target, 'bad/m');
  assert.equal(routeRow.failedLegs[0].status, 502);
  assert.equal(routeRow.failedLegs[0].failure, 'invalid_output');
  assert.equal(routeRow.failedLegs[0].usage.input, 11);
  assert.equal(routeRow.failedLegs[0].usage.output, 7);
});

test('Check 4: POST /v1/responses heals text.format and fails over on invalid_output', async (t) => {
  const r = await rig(t, { structuredOutput: { mode: 'heal' } });
  const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] };

  r.up.answer.good = 'Here you go: ```json {"a":1,}```';
  const healed = await r.post('/v1/responses', {
    model: 'good/m',
    input: 'give json',
    text: { format: { type: 'json_object' } },
  });
  assert.equal(healed.status, 200);
  assert.equal(healed.json.output_text, '{"a":1}');
  assert.equal(healed.json.output[0].content[0].text, '{"a":1}');

  r.up.answer.bad = () => ({ text: '{"b":2}', usage: { prompt_tokens: 9, completion_tokens: 5 } });
  r.up.answer.good = () => ({ text: '{"a":7}', usage: { prompt_tokens: 6, completion_tokens: 2 } });

  const singleErr = await r.post('/v1/responses', {
    model: 'bad/m',
    input: 'need a',
    text: { format: { type: 'json_schema', name: 's', strict: true, schema } },
  });
  assert.equal(singleErr.status, 502);
  assert.equal(singleErr.json.error.type, 'invalid_output');

  const failover = await r.post('/v1/responses', {
    model: 'route',
    input: 'need a',
    text: { format: { type: 'json_schema', name: 's', strict: true, schema } },
  });
  assert.equal(failover.status, 200);
  assert.equal(failover.json.output_text, '{"a":7}');
  assert.equal(r.up.hits.good, 2);

  const rows = (await r.get('/v1/keysmith/usage?tail=5')).json.entries;
  assert.equal(rows[0].via, '/v1/responses');
  assert.equal(rows[0].failedLegs[0].target, 'bad/m');
  assert.equal(rows[2].structuredOutput, 'healed');
  assert.equal(rows[2].healed, true);
});

test('Check 5: mode absent, mode off, and mode heal without spec are byte-identical (golden check)', async (t) => {
  const rawMalformed = 'Sure! ```json {"a": 1,}```';
  const rAbsent = await rig(t, { adapters: ['up'], aliases: {} });
  const rOff = await rig(t, { structuredOutput: { mode: 'off' }, adapters: ['up'], aliases: {} });
  const rHeal = await rig(t, { structuredOutput: { mode: 'heal' }, adapters: ['up'], aliases: {} });
  for (const r of [rAbsent, rOff, rHeal]) r.up.answer.up = rawMalformed;

  const chatWithSpec = {
    model: 'up/m',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  };
  const chatNoSpec = {
    model: 'up/m',
    messages: [{ role: 'user', content: 'hi' }],
  };

  const baseChat = await rAbsent.post('/v1/chat/completions', chatWithSpec);
  const offChat = await rOff.post('/v1/chat/completions', chatWithSpec);
  assert.equal(baseChat.status, 200);
  assert.equal(offChat.status, 200);
  assert.equal(baseChat.json.choices[0].message.content, rawMalformed);
  assert.deepEqual(stripFreshChat(offChat.json), stripFreshChat(baseChat.json));
  assert.deepEqual(rOff.up.bodies.up[0].messages, [{ role: 'user', content: 'hi' }]);

  const baseNoSpec = await rAbsent.post('/v1/chat/completions', chatNoSpec);
  const healNoSpec = await rHeal.post('/v1/chat/completions', chatNoSpec);
  assert.equal(healNoSpec.json.choices[0].message.content, rawMalformed);
  assert.deepEqual(stripFreshChat(healNoSpec.json), stripFreshChat(baseNoSpec.json));
  assert.deepEqual(rHeal.up.bodies.up[0].messages, [{ role: 'user', content: 'hi' }]);

  const respWithSpec = { model: 'up/m', input: 'hi', text: { format: { type: 'json_object' } } };
  const respNoSpec = { model: 'up/m', input: 'hi' };
  const baseResp = await rAbsent.post('/v1/responses', respWithSpec);
  const offResp = await rOff.post('/v1/responses', respWithSpec);
  const healRespNoSpec = await rHeal.post('/v1/responses', respNoSpec);
  assert.equal(offResp.json.output_text, rawMalformed);
  assert.deepEqual(stripFreshResponses(offResp.json), stripFreshResponses(baseResp.json));
  assert.equal(healRespNoSpec.json.output_text, rawMalformed);
  assert.deepEqual(rOff.up.bodies.up[1].messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(rHeal.up.bodies.up[1].messages, [{ role: 'user', content: 'hi' }]);

  for (const r of [rOff, rHeal]) {
    const rows = (await r.get('/v1/keysmith/usage?tail=5')).json.entries;
    for (const row of rows) {
      assert.equal('structuredOutput' in row, false);
      assert.equal('healed' in row, false);
    }
  }
});

test('Check 6: streaming requests with a spec pass through unchanged and record structuredOutput: "unchecked"', async (t) => {
  const r = await rig(t, { structuredOutput: { mode: 'heal' }, adapters: ['up'], aliases: {} });
  r.up.answer.up = 'not json stream text';

  const chatRes = await r.post('/v1/chat/completions', {
    model: 'up/m',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  });
  assert.equal(chatRes.status, 200);
  assert.match(chatRes.text, /not json stream text/);
  assert.deepEqual(r.up.bodies.up[0].messages, [{ role: 'user', content: 'hi' }]);

  const respRes = await r.post('/v1/responses', {
    model: 'up/m',
    stream: true,
    input: 'hi',
    text: { format: { type: 'json_object' } },
  });
  assert.equal(respRes.status, 200);
  assert.match(respRes.text, /not json stream text/);
  assert.deepEqual(r.up.bodies.up[1].messages, [{ role: 'user', content: 'hi' }]);

  const rows = (await r.get('/v1/keysmith/usage?tail=5')).json.entries;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.structuredOutput, 'unchecked');
    assert.equal('healed' in row, false);
  }
});

test('Check 7: 2 MB non-JSON fails 502 in under 1s and invalid_output does not trip the circuit breaker', async (t) => {
  const r = await rig(t, {
    structuredOutput: { mode: 'heal' },
    circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 30_000 },
    adapters: ['bad'],
    aliases: {},
  });
  r.up.answer.bad = 'x'.repeat(2 * 1024 * 1024);

  const t0 = performance.now();
  const big = await r.post('/v1/chat/completions', {
    model: 'bad/m',
    messages: [{ role: 'user', content: 'big' }],
    response_format: { type: 'json_object' },
  });
  const elapsed = performance.now() - t0;
  assert.equal(big.status, 502);
  assert.equal(big.json.error.type, 'invalid_output');
  assert.ok(elapsed < 1000, `2 MB refusal took ${elapsed}ms`);

  r.up.answer.bad = 'still not json';
  for (let i = 0; i < 3; i++) {
    const res = await r.post('/v1/chat/completions', {
      model: 'bad/m',
      messages: [{ role: 'user', content: 'bad' }],
      response_format: { type: 'json_object' },
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.type, 'invalid_output');
  }
  assert.equal(r.up.hits.bad, 4);
  const breakers = await r.get('/v1/keysmith/breakers');
  assert.equal(breakers.status, 200);
  assert.ok(breakers.json.breakers.every((b) => b.state === 'closed' && b.consecutiveFailures === 0));

  // Real upstream 503 still trips the breaker as usual
  r.up.answer.bad = () => ({ status: 503 });
  await r.post('/v1/chat/completions', { model: 'bad/m', messages: [{ role: 'user', content: 'down1' }] });
  await r.post('/v1/chat/completions', { model: 'bad/m', messages: [{ role: 'user', content: 'down2' }] });
  const afterDown = await r.get('/v1/keysmith/breakers');
  assert.equal(afterDown.json.breakers[0].state, 'open');
});

test('Check 9: response cache stores canonical healed JSON on miss->hit and never stores 502 invalid_output', async (t) => {
  const r = await rig(t, {
    structuredOutput: { mode: 'heal' },
    cache: { enabled: true, ttlSeconds: 3600, maxEntries: 50 },
    adapters: ['up'],
    aliases: {},
  });
  r.up.answer.up = '```json {"a":1,}```';

  const req1 = {
    model: 'up/m',
    temperature: 0,
    messages: [{ role: 'user', content: 'cache heal' }],
    response_format: { type: 'json_object' },
  };
  const miss = await r.post('/v1/chat/completions', req1);
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('x-keysmith-cache'), 'miss');
  assert.equal(miss.json.choices[0].message.content, '{"a":1}');
  assert.equal(r.up.hits.up, 1);

  const hit = await r.post('/v1/chat/completions', req1);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-keysmith-cache'), 'hit');
  assert.equal(hit.json.choices[0].message.content, '{"a":1}');
  assert.equal(r.up.hits.up, 1);

  r.up.answer.up = 'bad unparseable text';
  const req2 = {
    model: 'up/m',
    temperature: 0,
    messages: [{ role: 'user', content: 'cache fail' }],
    response_format: { type: 'json_object' },
  };
  const fail = await r.post('/v1/chat/completions', req2);
  assert.equal(fail.status, 502);
  assert.equal(fail.json.error.type, 'invalid_output');
  assert.equal(r.up.hits.up, 2);

  r.up.answer.up = '{"a":2}';
  const afterFail = await r.post('/v1/chat/completions', req2);
  assert.equal(afterFail.status, 200);
  assert.equal(afterFail.headers.get('x-keysmith-cache'), 'miss');
  assert.equal(afterFail.json.choices[0].message.content, '{"a":2}');
  assert.equal(r.up.hits.up, 3);
});

test('tools relay stays untouched and reloadKeys updates structuredOutput mode live', async (t) => {
  const r = await rig(t, {
    structuredOutput: { mode: 'off' },
    adapters: ['up'],
    aliases: {},
    configFile: true,
  });
  r.up.answer.up = '```json {"a":1,}```';

  const toolReq = {
    model: 'up/m',
    messages: [{ role: 'user', content: 'run tool' }],
    tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }],
    response_format: { type: 'json_object' },
  };
  const chatReq = {
    model: 'up/m',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  };

  // Off initially
  const offRes = await r.post('/v1/chat/completions', chatReq);
  assert.equal(offRes.json.choices[0].message.content, '```json {"a":1,}```');

  // Toggle to heal via config file + reload
  fs.writeFileSync(r.cfgPath, JSON.stringify({ ...r.cfg, structuredOutput: { mode: 'heal' } }, null, 2));
  r.server.reloadKeys();
  const healRes = await r.post('/v1/chat/completions', chatReq);
  assert.equal(healRes.json.choices[0].message.content, '{"a":1}');

  // Tool request still relays verbatim without structured instruction
  const toolRes = await r.post('/v1/chat/completions', toolReq);
  assert.equal(toolRes.status, 200);
  assert.equal(toolRes.json.choices[0].message.content, '```json {"a":1,}```');
  assert.equal(r.up.bodies.up.at(-1).messages.length, 1);

  // Invalid config reload is refused and keeps heal active
  fs.writeFileSync(r.cfgPath, JSON.stringify({ ...r.cfg, structuredOutput: { mode: 'yes' } }, null, 2));
  r.server.reloadKeys();
  const keptHeal = await r.post('/v1/chat/completions', chatReq);
  assert.equal(keptHeal.json.choices[0].message.content, '{"a":1}');
  assert.ok(r.logs.some((l) => /structuredOutput reload refused/.test(l)));
});
