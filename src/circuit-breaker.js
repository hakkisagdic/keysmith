import { LlmError } from './util.js';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Health-Based Circuit Breaker (`P2-3` / Matrix #17).
 *
 * Tracks per-leg (`adapter/model` or `adapter`) consecutive upstream failures and transitions
 * through `closed` -> `open` -> `half-open` states.
 *
 * When `open`, multi-leg failover routes bypass the unhealthy leg immediately (`circuit_open`)
 * until `cooldownMs` elapses, avoiding repeated timeouts and 5xx delays on dead providers.
 */
export class CircuitBreakerRegistry {
  constructor(cfg = {}, { now = () => Date.now() } = {}) {
    this.now = now;
    this.configure(cfg);
    this._states = new Map(); // target -> { target, state, failures, lastError, lastStatus, openedAt, openUntil, halfOpenInFlight, totalTrips }
  }

  configure(cfg = {}) {
    const raw = cfg?.limits?.circuitBreaker ?? cfg?.circuitBreaker;
    if (raw === true) {
      this.enabled = true;
      this.failureThreshold = DEFAULT_FAILURE_THRESHOLD;
      this.cooldownMs = DEFAULT_COOLDOWN_MS;
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.enabled = false;
      this.failureThreshold = DEFAULT_FAILURE_THRESHOLD;
      this.cooldownMs = DEFAULT_COOLDOWN_MS;
      return;
    }
    this.enabled = raw.enabled !== false;
    const ft = Number(raw.failureThreshold);
    this.failureThreshold = Number.isInteger(ft) && ft >= 1 ? ft : DEFAULT_FAILURE_THRESHOLD;
    const cd = Number(raw.cooldownMs);
    this.cooldownMs = Number.isFinite(cd) && cd > 0 ? Math.floor(cd) : DEFAULT_COOLDOWN_MS;
  }

  _keyFor(legOrTarget) {
    if (typeof legOrTarget === 'string') return legOrTarget.trim();
    if (!legOrTarget || typeof legOrTarget !== 'object') return '';
    if (typeof legOrTarget.target === 'string' && legOrTarget.target.trim()) {
      return legOrTarget.target.trim();
    }
    const adapterId = legOrTarget.adapter?.id || legOrTarget.adapterId || '';
    const model = legOrTarget.model || '';
    return model ? `${adapterId}/${model}` : adapterId;
  }

  /**
   * Check whether a candidate leg is allowed to run.
   * Returns `{ ok: true, state: 'closed' | 'half-open' }` or
   * `{ ok: false, state: 'open', retryAfterMs, detail, error }`.
   */
  check(legOrTarget) {
    if (!this.enabled) return { ok: true, state: 'closed' };
    const key = this._keyFor(legOrTarget);
    if (!key) return { ok: true, state: 'closed' };

    const rec = this._states.get(key);
    if (!rec || rec.state === 'closed') {
      return { ok: true, state: 'closed' };
    }

    const t = this.now();
    if (rec.state === 'open') {
      if (t >= rec.openUntil) {
        rec.state = 'half-open';
        rec.halfOpenInFlight = true;
        return { ok: true, state: 'half-open' };
      }
      const retryAfterMs = Math.max(0, rec.openUntil - t);
      const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const detail = `circuit breaker open after ${rec.failures} consecutive failures (last: ${rec.lastError || 'upstream error'}); cools down in ${retrySec}s`;
      const err = new LlmError(`${key}: ${detail}`, {
        status: 503,
        type: 'upstream_error',
        provider: legOrTarget?.adapter?.id || null,
      });
      err.code = 'circuit_breaker_open';
      err.retryAfter = retrySec;
      return {
        ok: false,
        state: 'open',
        retryAfterMs,
        retryAfter: retrySec,
        failures: rec.failures,
        detail,
        error: err,
      };
    }

    // half-open: allow probe
    return { ok: true, state: 'half-open' };
  }

  /**
   * Record a successful response on `legOrTarget`, closing any open/half-open circuit.
   */
  recordSuccess(legOrTarget) {
    if (!this.enabled) return;
    const key = this._keyFor(legOrTarget);
    if (!key) return;
    const rec = this._states.get(key);
    if (!rec) return;
    rec.state = 'closed';
    rec.failures = 0;
    rec.openedAt = null;
    rec.openUntil = null;
    rec.halfOpenInFlight = false;
  }

  /**
   * Record an upstream failure on `legOrTarget`. Client 400/401/403/404 errors (except 429)
   * do not trip the upstream health breaker.
   */
  recordFailure(legOrTarget, err = null) {
    if (!this.enabled) return null;
    const status = Number(err?.status) || 502;
    if (err?.clientError || err?.scopeDenied) return null;
    if (status >= 400 && status < 500 && status !== 429 && status !== 408) return null;

    const key = this._keyFor(legOrTarget);
    if (!key) return null;
    const t = this.now();
    let rec = this._states.get(key);
    if (!rec) {
      rec = {
        target: key,
        state: 'closed',
        failures: 0,
        lastError: null,
        lastStatus: null,
        openedAt: null,
        openUntil: null,
        halfOpenInFlight: false,
        totalTrips: 0,
      };
      this._states.set(key, rec);
    }

    rec.failures += 1;
    rec.lastError = String(err?.message || err || 'upstream error').slice(0, 200);
    rec.lastStatus = status;

    if (rec.state === 'half-open' || rec.failures >= this.failureThreshold) {
      const wasOpen = rec.state === 'open';
      rec.state = 'open';
      rec.openedAt = t;
      rec.openUntil = t + this.cooldownMs;
      rec.halfOpenInFlight = false;
      if (!wasOpen) rec.totalTrips += 1;
    }
    return this.snapshotOne(key);
  }

  snapshotOne(key) {
    const rec = this._states.get(key);
    if (!rec) return null;
    const t = this.now();
    let effectiveState = rec.state;
    if (effectiveState === 'open' && rec.openUntil && t >= rec.openUntil) {
      effectiveState = 'half-open';
    }
    return {
      target: rec.target,
      state: effectiveState,
      failures: rec.failures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      lastError: rec.lastError,
      lastStatus: rec.lastStatus,
      openedAt: rec.openedAt ? new Date(rec.openedAt).toISOString() : null,
      openUntil: rec.openUntil ? new Date(rec.openUntil).toISOString() : null,
      remainingCooldownMs: effectiveState === 'open' && rec.openUntil ? Math.max(0, rec.openUntil - t) : 0,
      totalTrips: rec.totalTrips,
    };
  }

  /**
   * Return the current status of all tracked circuit breakers.
   */
  snapshot() {
    const breakers = [];
    for (const key of this._states.keys()) {
      const item = this.snapshotOne(key);
      if (item) breakers.push(item);
    }
    return {
      enabled: this.enabled,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      breakers,
    };
  }

  /**
   * Reset a specific target or all targets back to `closed`.
   */
  reset(target = null) {
    if (target) {
      const existed = this._states.delete(String(target).trim());
      return existed ? 1 : 0;
    }
    const count = this._states.size;
    this._states.clear();
    return count;
  }
}
