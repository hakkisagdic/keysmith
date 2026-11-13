import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { parseKeys } from '../src/keys.js';

describe('P0-2 · RPM & TPM rate limiting and X-RateLimit-* headers', () => {
  test('parseKeys validates perMinute/rpm and tokensPerMinute/tpm fail-closed', () => {
    const valid = parseKeys([
      { key: 'ks_valid_rpm_1234567890', perMinute: 60, tokensPerMinute: 50000 },
      { key: 'ks_valid_short_1234567890', rpm: 30, tpm: 10000, tenantId: 't_acme' },
    ]);
    assert.equal(valid.issues.length, 0);
    assert.equal(valid.entries[0].perMinute, 60);
    assert.equal(valid.entries[0].tokensPerMinute, 50000);
    assert.equal(valid.entries[1].perMinute, 30);
    assert.equal(valid.entries[1].tokensPerMinute, 10000);
    assert.equal(valid.entries[1].tenantId, 't_acme');

    const bad = parseKeys([
      { key: 'ks_bad_rpm_123456789012', perMinute: -5 },
      { key: 'ks_bad_tpm_123456789012', tpm: '1000' },
      { key: 'ks_conflict_12345678901', perMinute: 10, rpm: 20 },
    ]);
    assert.equal(bad.issues.length, 3);
    for (const e of bad.entries) {
      assert.ok(e.scope?.invalid);
    }
  });

  let dir;
  let upstreamServer;
  let srv;
  let base;
  let clock = 1_700_000_000_000;
  const RPM_KEY = 'ks_rpm_test_key_12345678901234';
  const TPM_KEY = 'ks_tpm_test_key_12345678901234';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-rl-'));
    upstreamServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'rl_1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 },
        }),
      );
    });
    await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
    const upPort = upstreamServer.address().port;

    const cfg = {
      auth: {
        enabled: true,
        keys: [
          { key: RPM_KEY, label: 'rpm-limited', perMinute: 2, perDay: 100 },
          { key: TPM_KEY, label: 'tpm-limited', perMinute: 50, tokensPerMinute: 1500 },
        ],
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
    const usage = new UsageLog(path.join(dir, 'usage.jsonl'), { now: () => clock });
    const gw = new Gateway(cfg, { usage });
    srv = createServer(gw, cfg, { usage, now: () => clock });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  after(async () => {
    await new Promise((r) => srv?.close(r));
    await new Promise((r) => upstreamServer?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function call(key, content = 'hi') {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'up/m', messages: [{ role: 'user', content }] }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: () => JSON.parse(text) };
  }

  test('RPM limit emits X-RateLimit-* headers, enforces 429 + Retry-After, and resets after 60s', async () => {
    const r1 = await call(RPM_KEY, '1');
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-ratelimit-limit-requests'), '2');
    assert.equal(r1.headers.get('x-ratelimit-remaining-requests'), '1');
    assert.equal(r1.headers.get('x-ratelimit-limit-day'), '100');
    assert.equal(r1.headers.get('x-ratelimit-remaining-day'), '99');

    clock += 10_000;
    const r2 = await call(RPM_KEY, '2');
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-ratelimit-remaining-requests'), '0');

    // 3rd request within the 60s window is refused with 429 and retry-after: 50
    const r3 = await call(RPM_KEY, '3');
    assert.equal(r3.status, 429);
    assert.equal(r3.headers.get('retry-after'), '50');
    assert.equal(r3.headers.get('x-ratelimit-remaining-requests'), '0');
    assert.match(r3.json().error.message, /request rate limit of 2 requests\/min is exceeded/);

    // Advance past the first request's 60s window.
    clock += 51_000;
    const r4 = await call(RPM_KEY, '4');
    assert.equal(r4.status, 200);
  });

  test('TPM limit tracks actual token consumption and enforces 429 when tokensPerMinute is exceeded', async () => {
    // First call uses 1000 tokens (limit is 1500/min).
    const t1 = await call(TPM_KEY, 't1');
    assert.equal(t1.status, 200);
    assert.equal(t1.headers.get('x-ratelimit-limit-tokens'), '1500');
    assert.equal(t1.headers.get('x-ratelimit-remaining-tokens'), '1500');

    // Second call enters with 500 remaining, then consumes another 1000 tokens (total 2000 >= 1500).
    const t2 = await call(TPM_KEY, 't2');
    assert.equal(t2.status, 200);
    assert.equal(t2.headers.get('x-ratelimit-remaining-tokens'), '500');

    // Third call in the same minute is blocked by TPM limit!
    const t3 = await call(TPM_KEY, 't3');
    assert.equal(t3.status, 429);
    assert.equal(t3.headers.get('x-ratelimit-remaining-tokens'), '0');
    assert.match(t3.json().error.message, /token rate limit of 1500 tokens\/min is exceeded/);

    // After 61 seconds, token window slides and allows requests again.
    clock += 61_000;
    const t4 = await call(TPM_KEY, 't4');
    assert.equal(t4.status, 200);
  });
});
