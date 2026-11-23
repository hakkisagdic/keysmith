/**
 * modelMap is applied once.
 * Embeddings: local stub shaped like test/catalogue-gateway.test.js boot.
 * UHP: stub shaped like test/uhp-relay.test.js (wire: 'uhp').
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { HTTP_PROFILES } from '../src/profiles.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function writeSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'uhp-version': '2026-10-19',
  });
  for (const ev of events) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

function uhpOk(res, body) {
  const respId = 'resp_map';
  writeSse(res, [
    {
      type: 'response.created',
      sequence_number: 1,
      response: { id: respId, object: 'response', status: 'in_progress', output: [], model: body.model },
    },
    { type: 'response.output_text.delta', sequence_number: 2, delta: 'ok' },
    {
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: respId,
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [
          { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
        ],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    },
  ]);
}

/** Local embeddings upstream plus a gateway, same shape as catalogue-gateway boot. */
async function withEmbeddings(adapterExtra, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, body });
      if (req.url.endsWith('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: body.model,
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await listen(upstream);
  const port = upstream.address().port;
  let server;
  try {
    const cfg = {
      auth: { enabled: false },
      adapters: {
        up: {
          kind: 'http',
          wire: 'openai',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: false,
          ...adapterExtra,
        },
      },
    };
    const gateway = new Gateway(cfg, { log: () => {} });
    server = createServer(gateway, cfg, { log: () => {} });
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn({
      seen,
      post: async (body) => {
        const res = await fetch(`${base}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, text: await res.text() };
      },
    });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
}

function startMockHarnessRouter(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/harness/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startKeysmith(cfg) {
  const full = { auth: { enabled: false }, ...cfg };
  const gateway = new Gateway(full);
  const server = createServer(gateway, full, { log: () => {} });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const CHAIN = { a: 'b', b: 'c' };

/** UHP adapter config copied from the relay tests, with wire forced to uhp. */
async function withUhp(extra, fn) {
  const seen = [];
  const hr = await startMockHarnessRouter(async (req, res) => {
    if (req.url === '/api/harness/v1/responses' && req.method === 'POST') {
      const body = await readJsonBody(req);
      seen.push(body);
      uhpOk(res, body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const ks = await startKeysmith({
      adapters: {
        hr: {
          ...structuredClone(HTTP_PROFILES.harnessrouter),
          baseUrl: hr.baseUrl,
          wire: 'uhp',
          ...extra,
        },
      },
    });
    try {
      await fn({
        seen,
        post: async (model) => {
          const res = await fetch(`${ks.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          });
          return { status: res.status, text: await res.text() };
        },
      });
    } finally {
      await ks.close();
    }
  } finally {
    await hr.close();
  }
}

test('K1 embeddings with a modelMap entry sends the mapped id upstream', async () => {
  await withEmbeddings({ modelMap: { e: 'real-embed' } }, async ({ seen, post }) => {
    const res = await post({ model: 'up/e', input: 'x' });
    assert.equal(res.status, 200, res.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, 'real-embed');
  });
});

test('K2 embeddings without a modelMap entry sends the model unchanged', async () => {
  await withEmbeddings({ modelMap: { e: 'real-embed' } }, async ({ seen, post }) => {
    const res = await post({ model: 'up/other', input: 'x' });
    assert.equal(res.status, 200, res.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, 'other');
  });
});

test('K3 UHP wire maps a chained modelMap once', async () => {
  await withUhp({ modelMap: CHAIN }, async ({ seen, post }) => {
    const res = await post('hr/a');
    assert.equal(res.status, 200, res.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'b');
    assert.notEqual(seen[0].model, 'c');
  });
});

test('K4 UHP modelsOnly allows the once-mapped id and the upstream receives it', async () => {
  await withUhp({ modelMap: CHAIN, modelsOnly: true, models: ['b'] }, async ({ seen, post }) => {
    const res = await post('hr/a');
    assert.equal(res.status, 200, res.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'b');
  });
});

test('K5 UHP maps a directly named model once', async () => {
  await withUhp({ modelMap: CHAIN }, async ({ seen, post }) => {
    const res = await post('hr/b');
    assert.equal(res.status, 200, res.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'c');
  });
});
