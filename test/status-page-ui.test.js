import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { statusPage, loginPage, resolvePageLang } from '../src/status-page.js';

test('P1-3: resolvePageLang honors ?lang=tr|en and Accept-Language header', () => {
  assert.equal(resolvePageLang(new URL('http://localhost/status?lang=tr'), {}), 'tr');
  assert.equal(resolvePageLang(new URL('http://localhost/status?lang=en'), { 'accept-language': 'tr-TR,tr;q=0.9' }), 'en');
  assert.equal(resolvePageLang(new URL('http://localhost/status'), { 'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8' }), 'tr');
  assert.equal(resolvePageLang(new URL('http://localhost/status'), { 'accept-language': 'en-US,en;q=0.9' }), 'en');
  assert.equal(resolvePageLang(new URL('http://localhost/status'), {}), 'en');
});

test('P1-3: statusPage renders TR and EN locales with locale-matched formatting and new operational sections', () => {
  const sampleProps = {
    cfg: {
      adapters: {
        codex: { kind: 'cli', bin: 'codex', parser: 'codex', toolMode: 'auto', priority: 100 },
      },
      cache: { enabled: true },
      guardrails: { enabled: true, mode: 'mask' },
    },
    models: [
      {
        id: 'codex/gpt-5.4',
        keysmith: { adapter: 'codex', upstream: 'gpt-5.4', contextWindow: 200000 },
      },
    ],
    usage: {
      summarize: () => ({
        requests: 12500,
        failures: 14,
        tokensIn: 840000,
        tokensOut: 320000,
        models: [
          {
            model: 'codex/gpt-5.4',
            requests: 12500,
            failures: 14,
            input: 840000,
            output: 320000,
            p50Ms: 310,
            p95Ms: 820,
            msTotal: 4500000,
          },
        ],
        keys: [],
      }),
      spendSummary: () => [],
      readErrors: () => [],
    },
    startedAt: Date.now() - 3600_000,
    cacheStats: {
      enabled: true,
      hits: 3120,
      misses: 9380,
      hitRate: 0.2496,
      savedUsd: 42.75,
      entries: 412,
    },
    guardrailStats: {
      enabled: true,
      mode: 'mask',
      maskedCount: 27,
      blockedPiiCount: 4,
      blockedInjectionCount: 3,
    },
    billingSummary: {
      tenants: [
        {
          id: 'acme-tr',
          name: 'Acme Yazılım A.Ş.',
          plan: 'pro',
          billingMode: 'prepaid',
          balanceUsd: 125.5,
          balanceTry: 4250.5,
          monthlyRequestsUsed: 48200,
          monthlyRequestsLimit: 250000,
        },
      ],
      invoices: [
        {
          id: 'INV-202611-0001',
          tenantId: 'acme-tr',
          currency: 'TRY',
          subtotal: 1490,
          vatAmount: 298,
          total: 1788,
          issuedAt: '2026-11-13T10:30:00Z',
        },
      ],
    },
    prompts: [
      {
        id: 'support-tr',
        version: 2,
        model: 'smart',
        variables: ['customer_name', 'order_id'],
        updatedAt: '2026-11-13T11:00:00Z',
      },
    ],
  };

  const trHtml = statusPage({ ...sampleProps, lang: 'tr' });

  assert.match(trHtml, /<html lang="tr">/);
  assert.match(trHtml, /Yanıt önbelleği ve maliyet tasarrufu/);
  assert.match(trHtml, /KVKK ve güvenlik duvarı \(Guardrails\)/);
  assert.match(trHtml, /Kiracı cüzdanları ve paketler/);
  assert.match(trHtml, /Son faturalar \(%20 KDV defteri\)/);
  assert.match(trHtml, /Merkezi prompt şablonları/);
  // Turkish decimal comma formatting on currency/numbers/dates
  assert.match(trHtml, /12\.500/);
  assert.match(trHtml, /\$42,75/);
  assert.match(trHtml, /13\.11\.2026 10:30/);

  const enHtml = statusPage({ ...sampleProps, lang: 'en' });

  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /Response cache &amp; cost savings/);
  assert.match(enHtml, /KVKK &amp; guardrail shield/);
  assert.match(enHtml, /Tenant wallets &amp; plans/);
  assert.match(enHtml, /Recent invoices \(20% VAT ledger\)/);
  assert.match(enHtml, /Prompt registry/);
  assert.match(enHtml, /12,500/);
  assert.match(enHtml, /\$42\.75/);
  assert.match(enHtml, /2026-11-13 10:30/);

  const loginTr = loginPage({ lang: 'tr', failed: true });
  assert.match(loginTr, /<html lang="tr">/);
  assert.match(loginTr, /girilen anahtar eşleşmedi/);
});

test('P1-3: GET /status serves Turkish UI when ?lang=tr or Accept-Language: tr is sent', async () => {
  const cfg = {
    auth: { enabled: false },
    adapters: {},
    aliases: {},
    cache: { enabled: true },
    guardrails: { enabled: true, mode: 'mask' },
    billing: {
      tenants: {
        't-1': { name: 'Test Org', plan: 'pro', billingMode: 'prepaid', balanceTry: 500 },
      },
    },
  };
  const gw = new Gateway(cfg);
  const server = createServer(gw, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const resTrQuery = await fetch(`${base}/status?lang=tr`);
    assert.equal(resTrQuery.status, 200);
    const textTrQuery = await resTrQuery.text();
    assert.match(textTrQuery, /<html lang="tr">/);
    assert.match(textTrQuery, /Yanıt önbelleği ve maliyet tasarrufu/);

    const resTrHeader = await fetch(`${base}/status`, {
      headers: { 'Accept-Language': 'tr-TR,tr;q=0.9' },
    });
    assert.equal(resTrHeader.status, 200);
    const textTrHeader = await resTrHeader.text();
    assert.match(textTrHeader, /<html lang="tr">/);

    const resEnDefault = await fetch(`${base}/status`);
    assert.equal(resEnDefault.status, 200);
    const textEnDefault = await resEnDefault.text();
    assert.match(textEnDefault, /<html lang="en">/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
