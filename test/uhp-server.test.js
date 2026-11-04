import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';

function startMockUhpUpstream(handler) {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    await handler(req, res, body);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/v1`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function startKeysmith(cfg) {
  const full = { adapters: {}, aliases: {}, limits: { maxRetries: 0, maxConcurrentCli: 2 }, ...cfg };
  const gateway = new Gateway(full);
  const srv = createServer(gateway, full, { log: () => {} });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${srv.address().port}`,
        gateway,
        close: async () => {
          await gateway.close();
          await new Promise((r) => srv.close(r));
        },
      });
    });
  });
}

test('UHP Server: GET /v1/uhp discovery is unauthenticated and negotiates UHP-Version', async () => {
  const ks = await startKeysmith({
    auth: { enabled: true, keys: ['ks-secret-key-123456'] },
    adapters: {},
  });
  try {
    // 1. Unauthenticated GET /v1/uhp succeeds even when auth is enabled
    const r1 = await fetch(`${ks.base}/v1/uhp`);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('uhp-version'), '2026-10-19');
    const info = await r1.json();
    assert.equal(info.object, 'uhp.info');
    assert.equal(info.uhp_version, '2026-10-19');
    assert.ok(info.supported_versions.includes('2026-10-19'));
    assert.equal(info.capabilities.responses, true);
    assert.equal(info.capabilities.stateful_continuation, true);
    assert.equal(info.capabilities.harnesses, true);

    // 2. Supported historical UHP-Version header is echoed back
    const r2 = await fetch(`${ks.base}/v1/uhp`, {
      headers: { 'UHP-Version': '2026-09-28' },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('uhp-version'), '2026-09-28');
    const info2 = await r2.json();
    assert.equal(info2.uhp_version, '2026-09-28');

    // 3. Unsupported UHP-Version returns 400 unsupported_protocol_version
    const r3 = await fetch(`${ks.base}/v1/uhp`, {
      headers: { 'UHP-Version': '1999-01-01' },
    });
    assert.equal(r3.status, 400);
    assert.equal(r3.headers.get('uhp-version'), '2026-10-19');
    const err = await r3.json();
    assert.equal(err.error.type, 'unsupported_protocol_version');
  } finally {
    await ks.close();
  }
});

test('UHP Server: GET /v1/harnesses, /v1/harnesses/:id, and /v1/harnesses/:id/models respect key scopes', async () => {
  const upstream = await startMockUhpUpstream((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-6', owned_by: 'claude' }],
          backends: { claude: { available: true, models: ['claude-sonnet-4-6'] } },
        }),
      );
      return;
    }
    if (req.url === '/v1/harnesses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404).end();
  });

  const ks = await startKeysmith({
    auth: {
      enabled: true,
      keys: [
        { key: 'ks-admin-key-123456', label: 'admin' },
        { key: 'ks-scoped-key-123456', label: 'scoped', allow: ['harnessrouter/*'] },
      ],
    },
    adapters: {
      harnessrouter: {
        kind: 'http',
        wire: 'uhp',
        baseUrl: upstream.url,
        enabled: true,
        priority: 10,
      },
      'openai-api': {
        kind: 'http',
        wire: 'openai',
        baseUrl: upstream.url,
        apiKey: 'sk-test-123',
        defaultModel: 'gpt-4o',
        enabled: true,
        priority: 20,
      },
    },
  });

  try {
    // Unscoped key sees both harnesses
    const allRes = await fetch(`${ks.base}/v1/harnesses`, {
      headers: { Authorization: 'Bearer ks-admin-key-123456' },
    });
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.equal(allBody.object, 'list');
    assert.deepEqual(
      allBody.data.map((h) => h.id),
      ['harnessrouter', 'openai-api'],
    );
    assert.equal(allBody.data[0].capabilities.sessions, true);
    assert.equal(allBody.data[0].capabilities.client_tools, true);

    // Scoped key sees only harnessrouter
    const scopedRes = await fetch(`${ks.base}/v1/harnesses`, {
      headers: { Authorization: 'Bearer ks-scoped-key-123456' },
    });
    assert.equal(scopedRes.status, 200);
    const scopedBody = await scopedRes.json();
    assert.deepEqual(
      scopedBody.data.map((h) => h.id),
      ['harnessrouter'],
    );

    // GET /v1/harnesses/:id for allowed harness
    const hRes = await fetch(`${ks.base}/v1/harnesses/harnessrouter`, {
      headers: { Authorization: 'Bearer ks-scoped-key-123456' },
    });
    assert.equal(hRes.status, 200);
    const hBody = await hRes.json();
    assert.equal(hBody.id, 'harnessrouter');
    assert.equal(hBody.object, 'harness');

    // GET /v1/harnesses/:id for out-of-scope harness returns 404
    const deniedRes = await fetch(`${ks.base}/v1/harnesses/openai-api`, {
      headers: { Authorization: 'Bearer ks-scoped-key-123456' },
    });
    assert.equal(deniedRes.status, 404);

    // GET /v1/harnesses/:id/models lists models for that harness
    const mRes = await fetch(`${ks.base}/v1/harnesses/harnessrouter/models`, {
      headers: { Authorization: 'Bearer ks-scoped-key-123456' },
    });
    assert.equal(mRes.status, 200);
    const mBody = await mRes.json();
    assert.equal(mBody.object, 'list');
    assert.ok(mBody.data.some((m) => m.id === 'harnessrouter/claude/claude-sonnet-4-6'));
  } finally {
    await ks.close();
    await upstream.close();
  }
});

test('UHP Server: stateful /v1/responses, GET /v1/responses/:id, previous_response_id, metadata.harness_id, Idempotency-Key, and W3C traceparent', async () => {
  const upstreamCalls = [];
  const upstream = await startMockUhpUpstream((req, res, body) => {
    if (req.url === '/v1/responses' && req.method === 'POST') {
      upstreamCalls.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      const turn = upstreamCalls.length;
      res.end(
        JSON.stringify({
          id: `resp_up_${turn}`,
          object: 'response',
          status: 'completed',
          model: body.model || 'claude-sonnet-4-6',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: `Turn ${turn} answer` }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const ks = await startKeysmith({
    adapters: {
      harnessrouter: {
        kind: 'http',
        wire: 'uhp',
        baseUrl: upstream.url,
        defaultModel: 'claude/claude-sonnet-4-6',
        enabled: true,
        priority: 10,
      },
    },
  });

  try {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    // 1. POST /v1/responses routed via metadata.harness_id with Idempotency-Key and W3C traceparent
    const r1 = await fetch(`${ks.base}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-key-1',
        traceparent,
        tracestate: 'congo=t61rcWkgMzE',
        baggage: 'secret=never-forward',
      },
      body: JSON.stringify({
        metadata: { harness_id: 'harnessrouter' },
        input: 'First question',
      }),
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('traceparent'), traceparent);
    assert.equal(r1.headers.get('tracestate'), 'congo=t61rcWkgMzE');
    const resp1 = await r1.json();
    assert.match(resp1.id, /^resp_/);
    assert.equal(resp1.output_text, 'Turn 1 answer');
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].headers.traceparent, traceparent);
    assert.equal(upstreamCalls[0].headers.tracestate, 'congo=t61rcWkgMzE');
    assert.equal(upstreamCalls[0].headers.baggage, undefined);

    // 2. Replaying same Idempotency-Key + same payload returns cached response without hitting upstream
    const r1Replay = await fetch(`${ks.base}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-key-1',
      },
      body: JSON.stringify({
        metadata: { harness_id: 'harnessrouter' },
        input: 'First question',
      }),
    });
    assert.equal(r1Replay.status, 200);
    assert.equal(r1Replay.headers.get('idempotency-replayed'), 'true');
    const resp1Replay = await r1Replay.json();
    assert.equal(resp1Replay.id, resp1.id);
    assert.equal(upstreamCalls.length, 1, 'upstream was not called again');

    // 3. Reusing same Idempotency-Key with different payload returns 409 Conflict
    const r1Conflict = await fetch(`${ks.base}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-key-1',
      },
      body: JSON.stringify({
        metadata: { harness_id: 'harnessrouter' },
        input: 'Different question',
      }),
    });
    assert.equal(r1Conflict.status, 409);
    const conflictErr = await r1Conflict.json();
    assert.equal(conflictErr.error.type, 'idempotency_conflict');

    // 4. GET /v1/responses/:id retrieves stored response
    const getRes = await fetch(`${ks.base}/v1/responses/${resp1.id}`);
    assert.equal(getRes.status, 200);
    const got = await getRes.json();
    assert.equal(got.id, resp1.id);
    assert.equal(got.output_text, 'Turn 1 answer');

    // 5. Follow-up turn using previous_response_id continues stateful session
    const r2 = await fetch(`${ks.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: resp1.id,
        input: 'Second question',
      }),
    });
    assert.equal(r2.status, 200);
    const resp2 = await r2.json();
    assert.equal(resp2.previous_response_id, resp1.id);
    assert.equal(resp2.output_text, 'Turn 2 answer');
    assert.equal(upstreamCalls.length, 2);
    assert.equal(upstreamCalls[1].body.previous_response_id, 'resp_up_1');
  } finally {
    await ks.close();
    await upstream.close();
  }
});
