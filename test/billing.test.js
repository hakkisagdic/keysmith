import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { buildIyzicoAuthHeader, computeIyzicoWebhookSignature } from '../src/billing.js';

describe('P0-4 · iyzico cryptographic signing and webhook verification', () => {
  test('buildIyzicoAuthHeader produces IYZWSv2 base64 HMAC-SHA256 token and never leaks secretKey', () => {
    const res = buildIyzicoAuthHeader({
      apiKey: 'sandbox-api-key-123',
      secretKey: 'sandbox-secret-xyz',
      body: { conversationId: 'conv_1', price: '990.00' },
      randomKey: 'fixedrandom123',
    });
    assert.match(res.authorization, /^IYZWSv2 /);
    const decoded = Buffer.from(res.authorization.slice('IYZWSv2 '.length), 'base64').toString('utf8');
    assert.ok(decoded.startsWith('apiKey:sandbox-api-key-123&randomKey:fixedrandom123&signature:'));
    assert.ok(!decoded.includes('sandbox-secret-xyz'));
  });
});

describe('P0-4 · Tenant wallets, 402 enforcement, iyzico checkout/webhook, markup settlement & invoices', () => {
  let dir;
  let upstreamServer;
  let srv;
  let base;
  let usage;
  const ADMIN_KEY = 'ks_billing_admin_key_1234567890';
  const TENANT_KEY = 'ks_billing_tenant_acme_12345678';
  const WEBHOOK_SECRET = 'iyz_wh_test_secret_987654321';

  before(async () => {
    process.env.IYZICO_API_KEY = 'iyz_test_api_key';
    process.env.IYZICO_SECRET_KEY = WEBHOOK_SECRET;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-bill-'));
    upstreamServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'b_1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'billed answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 },
        }),
      );
    });
    await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
    const upPort = upstreamServer.address().port;

    const cfg = {
      auth: {
        enabled: true,
        keys: [
          ADMIN_KEY,
          { key: TENANT_KEY, label: 'acme-prod', tenantId: 'acme', allow: ['up/*'] },
        ],
      },
      billing: {
        enabled: true,
        provider: 'iyzico',
        vatRate: 0.2,
        fxTryPerUsd: 35,
        stateFile: path.join(dir, 'billing.json'),
        invoicesFile: path.join(dir, 'invoices.jsonl'),
        tenants: {
          acme: {
            name: 'Acme Yazılım A.Ş.',
            plan: 'starter',
            billingMode: 'prepaid',
            currency: 'TRY',
            balanceTry: 0,
            balanceUsd: 0,
            markupPct: 20, // 20% agency/platform markup
            taxId: '1234567890',
            taxOffice: 'Maslak VD',
          },
        },
      },
      pricing: {
        // $100 / 1M input + $100 / 1M output -> 1,000 in + 1,000 out = $0.20 raw cost per call
        'up/m': { input: 100, output: 100 },
      },
      adapters: {
        up: {
          kind: 'http',
          baseUrl: `http://127.0.0.1:${upPort}/v1`,
          apiKey: false,
          models: ['m'],
        },
      },
    };
    usage = new UsageLog(path.join(dir, 'usage.jsonl'));
    const gw = new Gateway(cfg, { usage });
    srv = createServer(gw, cfg, { usage });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  after(async () => {
    delete process.env.IYZICO_API_KEY;
    delete process.env.IYZICO_SECRET_KEY;
    await new Promise((r) => srv?.close(r));
    await new Promise((r) => upstreamServer?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function api(route, { method = 'GET', body = null, key = ADMIN_KEY, headers = {} } = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: () => JSON.parse(text) };
  }

  test('1. Plans endpoint returns Starter, Pro, Team, and Enterprise tiers with TRY and USD prices', async () => {
    const r = await api('/v1/keysmith/billing/plans');
    assert.equal(r.status, 200);
    const ids = r.json().data.map((p) => p.id);
    assert.deepEqual(ids, ['starter', 'pro', 'team', 'enterprise']);
    const pro = r.json().data.find((p) => p.id === 'pro');
    assert.equal(pro.monthlyTry, 990);
    assert.equal(pro.monthlyUsd, 29);
  });

  test('2. Prepaid tenant with 0 balance is refused with 402 Payment Required (insufficient_balance)', async () => {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      key: TENANT_KEY,
      body: { model: 'up/m', messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(r.status, 402);
    assert.equal(r.json().error.code, 'insufficient_balance');
  });

  test('3. iyzico checkout & signed webhook top-up credits wallet, upgrades plan, and writes 20% VAT invoice', async () => {
    // Scoped tenant key initiates checkout for its own tenant
    const chk = await api('/v1/keysmith/billing/checkout', {
      method: 'POST',
      key: TENANT_KEY,
      body: { kind: 'topup', planId: 'team', amount: 1000, currency: 'TRY' },
    });
    assert.equal(chk.status, 200);
    const chkData = chk.json();
    assert.equal(chkData.subtotal, 1000);
    assert.equal(chkData.vatAmount, 200);
    assert.equal(chkData.paidPrice, 1200);
    assert.equal(chkData.iyzicoAuth.scheme, 'IYZWSv2');

    // Forged webhook signature is rejected with 401
    const badWh = await api('/v1/keysmith/billing/webhooks/iyzico', {
      method: 'POST',
      key: null,
      headers: { 'x-iyz-signature-v3': 'deadbeef' },
      body: {
        iyziEventType: 'CREDIT_PAYMENT_AUTH',
        paymentId: 'pay_999',
        paymentConversationId: chkData.conversationId,
        status: 'SUCCESS',
      },
    });
    assert.equal(badWh.status, 401);

    // Valid HMAC-SHA256 webhook signature succeeds
    const whPayload = {
      iyziEventType: 'CREDIT_PAYMENT_AUTH',
      paymentId: 'pay_999',
      paymentConversationId: chkData.conversationId,
      status: 'SUCCESS',
    };
    const validSig = computeIyzicoWebhookSignature(WEBHOOK_SECRET, whPayload);
    const goodWh = await api('/v1/keysmith/billing/webhooks/iyzico', {
      method: 'POST',
      key: null,
      headers: { 'x-iyz-signature-v3': validSig },
      body: whPayload,
    });
    assert.equal(goodWh.status, 200);
    const whOut = goodWh.json();
    assert.equal(whOut.tenant.balanceTry, 1000);
    assert.equal(whOut.tenant.plan, 'team');
    assert.equal(whOut.invoice.subtotal, 1000);
    assert.equal(whOut.invoice.vatAmount, 200);
    assert.equal(whOut.invoice.total, 1200);
    assert.equal(whOut.invoice.provider, 'iyzico');
  });

  test('4. Funded tenant call succeeds, applies 20% markupPct, debits wallet, and records billedCost + invoice ledger', async () => {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      key: TENANT_KEY,
      body: { model: 'up/m', messages: [{ role: 'user', content: 'hello paid' }] },
    });
    assert.equal(r.status, 200);

    // Raw cost is $0.20; with 20% markup -> $0.24 billedUsd = 8.40 TRY (at fx 35)
    const [last] = usage.tail(1);
    assert.equal(last.tenantId, 'acme');
    assert.equal(last.cost.usd, 0.2);
    assert.equal(last.billedCost.usd, 0.24);
    assert.equal(last.billedCost.try, 8.4);
    assert.equal(last.billedCost.markupPct, 20);

    // Check updated wallet balance via scoped tenant endpoint
    const tRes = await api('/v1/keysmith/billing/tenants', { key: TENANT_KEY });
    assert.equal(tRes.status, 200);
    assert.equal(tRes.json().data.length, 1);
    assert.equal(tRes.json().data[0].balanceTry, 991.6);

    // Scoped key cannot call manual admin topup
    const deniedTopup = await api('/v1/keysmith/billing/topup', {
      method: 'POST',
      key: TENANT_KEY,
      body: { tenantId: 'acme', amount: 500 },
    });
    assert.equal(deniedTopup.status, 403);

    // Invoices endpoint returns the persisted invoice
    const invRes = await api('/v1/keysmith/billing/invoices', { key: TENANT_KEY });
    assert.equal(invRes.status, 200);
    assert.equal(invRes.json().data.length, 1);
    assert.equal(invRes.json().data[0].total, 1200);
  });
});
