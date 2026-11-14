import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, LlmError } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { CircuitBreakerRegistry } from '../src/circuit-breaker.js';

test('P2-3: CircuitBreakerRegistry transitions closed -> open -> half-open -> closed', () => {
  let clock = 1_000_000;
  const cb = new CircuitBreakerRegistry(
    { limits: { circuitBreaker: { enabled: true, failureThreshold: 2, cooldownMs: 10_000 } } },
    { now: () => clock },
  );

  assert.equal(cb.check('flaky/m1').ok, true);
  assert.equal(cb.check('flaky/m1').state, 'closed');

  // 1st failure -> still closed
  cb.recordFailure('flaky/m1', new LlmError('upstream 502', { status: 502 }));
  assert.equal(cb.check('flaky/m1').ok, true);

  // 2nd failure -> trips open
  cb.recordFailure('flaky/m1', new LlmError('upstream 502', { status: 502 }));
  const openVerdict = cb.check('flaky/m1');
  assert.equal(openVerdict.ok, false);
  assert.equal(openVerdict.state, 'open');
  assert.equal(openVerdict.retryAfter, 10);

  // Advance clock past cooldown -> half-open probe allowed
  clock += 10_500;
  const halfOpenVerdict = cb.check('flaky/m1');
  assert.equal(halfOpenVerdict.ok, true);
  assert.equal(halfOpenVerdict.state, 'half-open');

  // Probe succeeds -> circuit closes
  cb.recordSuccess('flaky/m1');
  const closedVerdict = cb.check('flaky/m1');
  assert.equal(closedVerdict.ok, true);
  assert.equal(closedVerdict.state, 'closed');
  assert.equal(cb.snapshotOne('flaky/m1').failures, 0);
  assert.equal(cb.snapshotOne('flaky/m1').totalTrips, 1);
});

test('P2-3: Gateway failover skips open circuit leg without calling it, recovers after cooldown, and exposes /v1/keysmith/breakers', async () => {
  let clock = 2_000_000;
  let primaryHealthy = false;
  let primaryCalls = 0;
  let backupCalls = 0;

  const primaryAdapter = {
    id: 'primary',
    kind: 'cli',
    priority: 100,
    models: () => [{ id: 'primary/m1', owned_by: 'primary' }],
    async *complete() {
      primaryCalls++;
      if (!primaryHealthy) {
        throw new LlmError('primary provider overloaded (503)', { status: 503, provider: 'primary' });
      }
      yield { type: 'delta', text: 'from-primary' };
      yield { type: 'usage', usage: { input: 10, output: 5 } };
      yield { type: 'done' };
    },
  };

  const backupAdapter = {
    id: 'backup',
    kind: 'cli',
    priority: 90,
    models: () => [{ id: 'backup/m1', owned_by: 'backup' }],
    async *complete() {
      backupCalls++;
      yield { type: 'delta', text: 'from-backup' };
      yield { type: 'usage', usage: { input: 10, output: 5 } };
      yield { type: 'done' };
    },
  };

  const cfg = {
    auth: { enabled: false },
    adapters: {
      primary: { kind: 'cli', bin: 'echo' },
      backup: { kind: 'cli', bin: 'echo' },
    },
    aliases: {
      ha: ['primary/m1', 'backup/m1'],
    },
    limits: {
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        cooldownMs: 15_000,
      },
    },
  };

  const gw = new Gateway(cfg, { now: () => clock });
  gw.adapters.set('primary', primaryAdapter);
  gw.adapters.set('backup', backupAdapter);
  const server = createServer(gw, cfg, { now: () => clock });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Request 1 & 2: primary fails twice -> trips circuit breaker open, backup answers
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'ha', messages: [{ role: 'user', content: 'ping' }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, 'from-backup');
    }
    assert.equal(primaryCalls, 2);
    assert.equal(backupCalls, 2);

    // Check /v1/keysmith/breakers -> primary/m1 is open
    const brkRes1 = await fetch(`${base}/v1/keysmith/breakers`);
    assert.equal(brkRes1.status, 200);
    const brkBody1 = await brkRes1.json();
    const pState = brkBody1.breakers.find((b) => b.target === 'primary/m1');
    assert.ok(pState);
    assert.equal(pState.state, 'open');
    assert.equal(pState.failures, 2);

    // Request 3 (during cooldown): primary is skipped immediately WITHOUT calling primaryAdapter!
    const res3 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'ha', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(res3.status, 200);
    assert.equal(primaryCalls, 2); // Still 2!
    assert.equal(backupCalls, 3);

    // Advance clock past 15s cooldown and mark primary healthy -> half-open probe succeeds and closes breaker
    clock += 16_000;
    primaryHealthy = true;
    const res4 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'ha', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(res4.status, 200);
    const body4 = await res4.json();
    assert.equal(body4.choices[0].message.content, 'from-primary');
    assert.equal(primaryCalls, 3);

    const brkRes2 = await fetch(`${base}/v1/keysmith/breakers`);
    const brkBody2 = await brkRes2.json();
    assert.equal(brkBody2.breakers.find((b) => b.target === 'primary/m1').state, 'closed');

    // Reset endpoint works
    const resetRes = await fetch(`${base}/v1/keysmith/breakers/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'primary/m1' }),
    });
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.cleared, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
