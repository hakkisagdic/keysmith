/**
 * The status a failed leg is kept with (gateway._legFailed): an upstream timeout is a 504, any
 * other upstream error a 502 — read off what the failure is typed as, never off a word in its
 * message. cc17cc2 guessed 504 from "timeout" anywhere in a message, which turned the bridge's
 * `ready_timeout` (a CLI that did not list its tools in time, a 502 by the bridge's own account)
 * and every untyped "bridge: timeout" into a 504 (test/tools-router.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, isTimeoutError } from '../src/gateway.js';
import { LlmError } from '../src/util.js';

const gateway = new Gateway({ adapters: {} }, { log: () => {} });
const leg = { adapter: { id: 'x', kind: 'cli' }, model: 'm' };
const statusOf = (e) => gateway._legFailed(leg, e, { emitted: false }, null, 'trying next candidate').status;

test('isTimeoutError: ETIMEDOUT and TimeoutError are timeouts; a message that says "timeout" is not', () => {
  assert.equal(isTimeoutError(Object.assign(new Error('request timed out after 2000ms'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTimeoutError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isTimeoutError(new Error('bridge: ready_timeout')), false);
  assert.equal(isTimeoutError(new Error('bridge: timeout')), false);
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError('timeout'), false);
});

test('_legFailed: a typed timeout is a 504, an untyped failure a 502, whatever its message says', () => {
  assert.equal(statusOf(Object.assign(new Error('request timed out after 2000ms'), { code: 'ETIMEDOUT' })), 504);
  assert.equal(statusOf(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 504);
  assert.equal(statusOf(new Error('bridge: ready_timeout')), 502, 'the bridge reports ready_timeout as a 502');
  assert.equal(statusOf(new Error('bridge: timeout')), 502, 'untyped: an upstream error');
  assert.equal(statusOf(new Error('connect ECONNREFUSED (timeout setting 30s)')), 502);
});

test('_legFailed: a status the failure carries is kept, an LlmError is the error itself', () => {
  assert.equal(statusOf(Object.assign(new Error('bridge: timeout'), { status: 504 })), 504);
  assert.equal(statusOf(Object.assign(new Error('bridge: ready_timeout'), { status: 502 })), 502);
  const own = new LlmError('x: upstream said no', { status: 503, provider: 'x' });
  assert.equal(gateway._legFailed(leg, own, { emitted: false }, null, 'giving up'), own);
  assert.equal(statusOf(new Error('429 Too Many Requests')), 429, 'a rate limit stays a 429');
});
