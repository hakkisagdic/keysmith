/**
 * The per-adapter circuit breaker registry (src/circuit-breaker.js), on an injected clock:
 * closed to open, open to half-open, the single probe, config validation (K1, K8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreakerRegistry, countsAsFailure, resolveBreakerConfig, retryAfterMs } from '../src/circuit-breaker.js';

function rig(circuitBreaker = { enabled: true }, adapters = null) {
  const clock = { t: 1_000_000 };
  const config = resolveBreakerConfig(circuitBreaker, adapters);
  assert.equal(config.error, null);
  return { clock, reg: new CircuitBreakerRegistry({ config, now: () => clock.t }) };
}

test('K1: closed to open after 3 consecutive failures, half-open after the cooldown, success closes, failure reopens', () => {
  const { clock, reg } = rig();
  assert.equal(reg.check('a').allow, true);
  reg.recordFailure('a', { status: 503 });
  reg.recordFailure('a', { status: 503 });
  assert.equal(reg.snapshot()[0].state, 'closed');
  reg.recordFailure('a', { status: 503 });
  assert.equal(reg.snapshot()[0].state, 'open');
  const v = reg.check('a');
  assert.equal(v.allow, false);
  assert.equal(v.retryAfterMs, 30_000);
  clock.t += 29_999;
  assert.equal(reg.check('a').allow, false);
  clock.t += 1;
  const probe = reg.check('a');
  assert.equal(probe.allow, true);
  assert.equal(probe.state, 'half-open');
  reg.recordSuccess('a');
  assert.equal(reg.snapshot()[0].state, 'closed');
  assert.equal(reg.snapshot()[0].consecutiveFailures, 0);
  // Open again, probe fails: reopened for a full cooldown.
  for (let i = 0; i < 3; i++) reg.recordFailure('a', { status: 500 });
  clock.t += 30_000;
  assert.equal(reg.check('a').allow, true);
  reg.recordFailure('a', { status: 503 });
  assert.equal(reg.snapshot()[0].state, 'open');
  assert.equal(reg.check('a').retryAfterMs, 30_000);
});

test('a success between failures resets the count (consecutive only)', () => {
  const { reg } = rig({ enabled: true, failureThreshold: 2 });
  reg.recordFailure('a', { status: 503 });
  reg.recordSuccess('a');
  reg.recordFailure('a', { status: 503 });
  assert.equal(reg.check('a').allow, true);
});

test('half-open lets exactly one probe out; a release frees the next', () => {
  const { clock, reg } = rig({ enabled: true, failureThreshold: 1 });
  reg.recordFailure('a', { status: 502 });
  clock.t += 30_000;
  assert.equal(reg.check('a').allow, true, 'first caller is the probe');
  assert.equal(reg.check('a').allow, false, 'second caller is told no');
  assert.equal(reg.check('a').allow, false);
  reg.release('a');
  assert.equal(reg.check('a').allow, true, 'an aborted probe frees the slot');
});

test('a probe that never reports is given up on after twice the cooldown', () => {
  const { clock, reg } = rig({ enabled: true, failureThreshold: 1, cooldownMs: 1000 });
  reg.recordFailure('a', { status: 502 });
  clock.t += 1000;
  assert.equal(reg.check('a').allow, true);
  clock.t += 59_000;
  assert.equal(reg.check('a').allow, false);
  clock.t += 1000;
  assert.equal(reg.check('a').allow, true);
});

test('a 429 lengthens the cooldown to its retry-after, never shortens it', () => {
  const { reg } = rig({ enabled: true, failureThreshold: 1 });
  reg.recordFailure('a', { status: 429, retryAfterMs: 120_000 });
  assert.equal(reg.check('a').retryAfterMs, 120_000);
  reg.recordFailure('b', { status: 429, retryAfterMs: 1000 });
  assert.equal(reg.check('b').retryAfterMs, 30_000);
});

test('per-adapter override and an adapter with the breaker off', () => {
  const { reg } = rig({ enabled: true, failureThreshold: 3 }, { a: { circuitBreaker: { failureThreshold: 1 } }, b: { circuitBreaker: { enabled: false } } });
  reg.recordFailure('a', { status: 503 });
  assert.equal(reg.check('a').allow, false);
  for (let i = 0; i < 10; i++) reg.recordFailure('b', { status: 503 });
  assert.equal(reg.check('b').allow, true);
  assert.deepEqual(reg.snapshot().map((x) => x.adapter), ['a']);
});

test('off by default: nothing is recorded, nothing blocked', () => {
  const reg = new CircuitBreakerRegistry({ config: resolveBreakerConfig(undefined, {}) });
  assert.equal(reg.active, false);
  for (let i = 0; i < 10; i++) reg.recordFailure('a', { status: 503 });
  assert.equal(reg.check('a').allow, true);
  assert.deepEqual(reg.snapshot(), []);
});

test('snapshot carries names, counters and times only; reset closes', () => {
  const { reg } = rig({ enabled: true, failureThreshold: 1 });
  reg.recordFailure('a', { status: 503 });
  const [row] = reg.snapshot();
  assert.deepEqual(Object.keys(row).sort(), ['adapter', 'consecutiveFailures', 'cooldownMs', 'failureThreshold', 'lastFailureAt', 'lastStatus', 'probeInFlight', 'retryAfterMs', 'state', 'trips']);
  assert.equal(reg.reset('a'), 1);
  assert.equal(reg.check('a').allow, true);
});

test('K8: a bad value names its field and leaves the breaker off', () => {
  for (const [raw, field] of [
    [{ failureThreshold: 0 }, 'circuitBreaker.failureThreshold'],
    [{ enabled: 'yes' }, 'circuitBreaker.enabled'],
    [{ cooldownMs: -5 }, 'circuitBreaker.cooldownMs'],
    [{ retries: 2 }, 'circuitBreaker has an unknown field "retries"'],
    ['on', 'circuitBreaker must be an object'],
  ]) {
    const r = resolveBreakerConfig(typeof raw === 'object' ? { enabled: true, ...raw } : raw);
    assert.equal(r.enabled, false);
    assert.ok(r.error.includes(field), `${field}: ${r.error}`);
    assert.ok(r.error.includes('stays off'));
  }
  const bad = resolveBreakerConfig({ enabled: true }, { a: { circuitBreaker: { cooldownMs: 0 } } });
  assert.equal(bad.enabled, false);
  assert.ok(bad.error.includes('adapters.a.circuitBreaker.cooldownMs'));
});

test('what counts: network errors, timeouts, 5xx, 408, 429; not other 4xx', () => {
  for (const s of [null, 500, 502, 503, 504, 408, 429]) assert.equal(countsAsFailure(s), true, String(s));
  for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(countsAsFailure(s), false, String(s));
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs(undefined), 0);
  assert.equal(retryAfterMs(new Date(1_005_000).toUTCString(), 1_000_000), 5000);
});
