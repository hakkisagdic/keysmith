import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { LlmError } from '../src/util.js';
import { verifyWebhookSignature } from '../src/webhooks.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('P1-2: Prometheus /metrics Endpoint & Signed Budget/Error Webhooks', () => {
  it('exposes Prometheus 0.0.4 metrics on GET /metrics and GET /v1/keysmith/metrics', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-metrics-'));
    const adapter = {
      id: 'mock',
      kind: 'http',
      wire: 'openai',
      costBasis: 'metered',
      declaredModels: ['claude-haiku-5-5'],
      async models() {
        return [{ id: 'claude-haiku-5-5' }];
      },
      async *complete() {
        yield { type: 'delta', text: 'metrics response' };
        yield { type: 'usage', usage: { input: 1000, output: 500 } };
        yield { type: 'done' };
      },
    };

    const cfg = {
      auth: {
        enabled: true,
        keys: [
          { key: 'ks_admin_metrics', label: 'admin' },
          { key: 'ks_scoped_metrics', label: 'scoped', allow: ['mock/*'] },
        ],
      },
      cache: { enabled: true, ttlSeconds: 300 },
      guardrails: { enabled: true, mode: 'mask' },
      billing: {
        enabled: true,
        dataDir: tmpDir,
        tenants: {},
      },
      adapters: {},
    };

    const gw = new Gateway(cfg, { adapters: { mock: adapter } });
    const server = createServer(gw, cfg);
    const baseUrl = await listen(server);

    try {
      // 1st request: cache MISS + PII masked (`test@example.com`)
      const r1 = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ks_admin_metrics',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mock/claude-haiku-5-5',
          messages: [{ role: 'user', content: 'Reach me at test@example.com' }],
        }),
      });
      assert.equal(r1.status, 200);

      // 2nd identical request: cache HIT
      const r2 = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ks_admin_metrics',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mock/claude-haiku-5-5',
          messages: [{ role: 'user', content: 'Reach me at test@example.com' }],
        }),
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('x-keysmith-cache'), 'HIT');

      // Scoped key is refused /metrics (403)
      const rScoped = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: 'Bearer ks_scoped_metrics' },
      });
      assert.equal(rScoped.status, 403);

      // Unscoped key fetches /metrics
      const rMetrics = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: 'Bearer ks_admin_metrics' },
      });
      assert.equal(rMetrics.status, 200);
      assert.match(rMetrics.headers.get('content-type') || '', /text\/plain;\s*version=0\.0\.4/);
      const text = await rMetrics.text();

      assert.match(text, /keysmith_requests_total\{adapter="mock",model="claude-haiku-5-5",face="chat",status="ok"\}\s+2/);
      assert.match(text, /keysmith_tokens_total\{direction="input"\}\s+1000/);
      assert.match(text, /keysmith_tokens_total\{direction="output"\}\s+500/);
      assert.match(text, /keysmith_cost_usd_total\s+0\.00035/);
      assert.match(text, /keysmith_cache_hits_total\s+1/);
      assert.match(text, /keysmith_guardrail_hits_total\{action="masked"\}\s+2/);
      assert.match(text, /keysmith_spend_cap_blocked_total/);
      assert.match(text, /keysmith_request_duration_ms_bucket\{le="\+Inf"\}\s+2/);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('delivers HMAC-SHA256 signed webhooks with retry on adapter.error and budget.low_balance', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-webhooks-'));
    const webhookSecret = 'whsec_test_secret_key_999';
    const received = [];
    let failFirstAttempt = true;

    const receiver = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (failFirstAttempt) {
          failFirstAttempt = false;
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('temporary receiver error');
          return;
        }
        received.push({
          headers: req.headers,
          rawBody,
          body: JSON.parse(rawBody),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const receiverUrl = await listen(receiver);

    let shouldFailUpstream = false;
    const adapter = {
      id: 'prov',
      kind: 'http',
      wire: 'openai',
      costBasis: 'metered',
      declaredModels: ['claude-opus-5-5'],
      async models() {
        return [{ id: 'claude-opus-5-5' }];
      },
      async *complete() {
        if (shouldFailUpstream) {
          throw new LlmError('upstream connection reset', { status: 502, provider: 'prov' });
        }
        yield { type: 'delta', text: 'ok' };
        yield { type: 'usage', usage: { input: 1000, output: 1000 } };
        yield { type: 'done' };
      },
    };

    const cfg = {
      auth: {
        enabled: true,
        keys: [
          { key: 'ks_admin_wh', label: 'admin' },
          { key: 'ks_tenant_wh', label: 'tenant-key', tenantId: 't_low' },
        ],
      },
      billing: {
        enabled: true,
        dataDir: tmpDir,
        lowBalanceThresholdUsd: 1.0,
        tenants: {
          t_low: {
            name: 'Low Balance Co',
            plan: 'pro',
            billingMode: 'prepaid',
            balanceUsd: 0.5,
            markupPct: 0,
          },
        },
      },
      webhooks: [
        {
          url: `${receiverUrl}/hooks`,
          secret: webhookSecret,
          events: ['budget.low_balance', 'adapter.error', 'spend_cap.exceeded'],
          retries: 2,
          retryDelayMs: 10,
        },
      ],
      adapters: {},
    };

    const gw = new Gateway(cfg, { adapters: { prov: adapter } });
    const server = createServer(gw, cfg);
    const baseUrl = await listen(server);

    try {
      // 1. Trigger budget.low_balance (first webhook attempt returns 502, retry succeeds with 200)
      const r1 = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ks_tenant_wh',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'prov/claude-opus-5-5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(r1.status, 200);

      // 2. Trigger adapter.error
      shouldFailUpstream = true;
      const r2 = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ks_admin_wh',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'prov/claude-opus-5-5',
          messages: [{ role: 'user', content: 'fail please' }],
        }),
      });
      assert.equal(r2.status, 502);

      await server.webhooks.flush();

      assert.equal(received.length, 2);
      const lowBalEvt = received.find((x) => x.body.type === 'budget.low_balance');
      const errEvt = received.find((x) => x.body.type === 'adapter.error');
      assert.ok(lowBalEvt);
      assert.ok(errEvt);

      // Verify HMAC-SHA256 signature on both delivered webhooks
      for (const item of received) {
        const sigHeader = item.headers['x-keysmith-signature-256'];
        assert.ok(sigHeader && sigHeader.startsWith('sha256='));
        assert.equal(verifyWebhookSignature(webhookSecret, item.rawBody, sigHeader), true);
        assert.equal(verifyWebhookSignature('wrong_secret', item.rawBody, sigHeader), false);
      }

      assert.equal(lowBalEvt.body.data.tenantId, 't_low');
      assert.equal(errEvt.body.data.adapter, 'prov');

      // Check delivery log via GET /v1/keysmith/webhooks (verify retries=2 was recorded on first event)
      const rHooks = await fetch(`${baseUrl}/v1/keysmith/webhooks`, {
        headers: { authorization: 'Bearer ks_admin_wh' },
      });
      assert.equal(rHooks.status, 200);
      const hookData = await rHooks.json();
      assert.equal(hookData.endpoints.length, 1);
      assert.equal(hookData.endpoints[0].signed, true);
      const retriedDelivery = hookData.deliveries.find((d) => d.type === 'budget.low_balance');
      assert.ok(retriedDelivery);
      assert.equal(retriedDelivery.attempts, 2);
      assert.equal(retriedDelivery.ok, true);
    } finally {
      server.close();
      receiver.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
