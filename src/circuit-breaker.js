/**
 * Per-adapter circuit breaker.
 *
 * Failover asks a dead provider again on every request and pays its timeout each time. The
 * breaker remembers consecutive upstream failures per adapter (the upstream source, not the
 * model): after `failureThreshold` of them the adapter is passed by for `cooldownMs`, then ONE
 * probe request is let through (half-open) and the breaker closes again when it succeeds.
 *
 * In memory only, with an injectable clock. Nothing here is a key, a header or an upstream error
 * body: a state holds counters, a timestamp and the last failure's status number.
 *
 * Off unless `circuitBreaker.enabled` is true (or an adapter's own `circuitBreaker.enabled`).
 * A value that does not validate is a doctor error and the breaker stays off
 * (`resolveBreakerConfig`), the way the response cache does.
 */

export const BREAKER_DEFAULTS = Object.freeze({ enabled: false, failureThreshold: 3, cooldownMs: 30_000 });

const FIELDS = ['enabled', 'failureThreshold', 'cooldownMs'];
const MAX_COOLDOWN_MS = 24 * 3_600_000;

function whole(n) {
  return Number.isInteger(n) && n >= 1 && n <= Number.MAX_SAFE_INTEGER;
}

function checkBlock(raw, where, errors) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where} must be an object, e.g. {"enabled": true, "failureThreshold": 3, "cooldownMs": 30000}`);
    return;
  }
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') errors.push(`${where}.enabled must be true or false`);
  if (Object.hasOwn(raw, 'failureThreshold') && !whole(raw.failureThreshold)) errors.push(`${where}.failureThreshold must be a whole number, 1 or more`);
  if (Object.hasOwn(raw, 'cooldownMs') && !(whole(raw.cooldownMs) && raw.cooldownMs <= MAX_COOLDOWN_MS)) errors.push(`${where}.cooldownMs must be a whole number of milliseconds, 1 to ${MAX_COOLDOWN_MS}`);
  for (const k of Object.keys(raw)) if (!FIELDS.includes(k)) errors.push(`${where} has an unknown field "${k}"`);
}

/**
 * `circuitBreaker` from config (and each adapter's own override in `adapters.<id>.circuitBreaker`).
 * Absent is the default: off, no error. Any bad value is `{ enabled: false, adapters: {}, error }`:
 * the breaker stays off for every adapter and doctor prints `error`.
 */
export function resolveBreakerConfig(raw, adaptersCfg = null) {
  const off = { ...BREAKER_DEFAULTS, enabled: false, adapters: {} };
  const errors = [];
  if (raw != null) checkBlock(raw, 'circuitBreaker', errors);
  const overrides = {};
  if (adaptersCfg && typeof adaptersCfg === 'object') {
    for (const [id, a] of Object.entries(adaptersCfg)) {
      if (!a || typeof a !== 'object' || !Object.hasOwn(a, 'circuitBreaker')) continue;
      checkBlock(a.circuitBreaker, `adapters.${id}.circuitBreaker`, errors);
      overrides[id] = a.circuitBreaker;
    }
  }
  if (errors.length) return { ...off, error: `${errors.join('; ')} — circuit breaker stays off` };
  const top = raw && typeof raw === 'object' ? raw : {};
  const base = {
    enabled: top.enabled === true,
    failureThreshold: Object.hasOwn(top, 'failureThreshold') ? top.failureThreshold : BREAKER_DEFAULTS.failureThreshold,
    cooldownMs: Object.hasOwn(top, 'cooldownMs') ? top.cooldownMs : BREAKER_DEFAULTS.cooldownMs,
  };
  const adapters = {};
  for (const [id, o] of Object.entries(overrides)) {
    adapters[id] = {
      enabled: Object.hasOwn(o, 'enabled') ? o.enabled : base.enabled,
      failureThreshold: Object.hasOwn(o, 'failureThreshold') ? o.failureThreshold : base.failureThreshold,
      cooldownMs: Object.hasOwn(o, 'cooldownMs') ? o.cooldownMs : base.cooldownMs,
    };
  }
  return { ...base, adapters, error: null };
}

/** Whether a failed leg counts against its adapter: the upstream could not answer. */
export function countsAsFailure(status) {
  if (typeof status !== 'number') return true; // no status: a network error or a timeout
  return status >= 500 || status === 429 || status === 408;
}

/** `retry-after` (seconds, or an HTTP date) as milliseconds from `nowMs`, or 0. */
export function retryAfterMs(value, nowMs = Date.now()) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : 0;
}

export class CircuitBreakerRegistry {
  /**
   * @param {object} opts
   * @param {object} [opts.config] the output of resolveBreakerConfig
   * @param {() => number} [opts.now] clock in ms
   * @param {(m: string) => void} [opts.log]
   */
  constructor({ config = null, now = null, log = () => {} } = {}) {
    this.config = config || resolveBreakerConfig(null);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.log = log;
    this.states = new Map();
  }

  /** The settings in force for `id`, or null when its breaker is off. */
  settingsFor(id) {
    const s = this.config.adapters?.[id] || this.config;
    return s.enabled === true ? s : null;
  }

  /** True when any adapter's breaker may be on: the walks skip every hook otherwise. */
  get active() {
    return this.config.enabled === true || Object.values(this.config.adapters || {}).some((s) => s.enabled === true);
  }

  _state(id) {
    let s = this.states.get(id);
    if (!s) {
      s = { state: 'closed', failures: 0, openUntil: 0, probe: false, probeAt: 0, lastFailureAt: 0, lastStatus: null, trips: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  _probeStale(s, set) {
    return s.probe && this.now() - s.probeAt >= Math.max(set.cooldownMs, 30_000) * 2;
  }

  /**
   * Without changing anything: `{ blocked, state, retryAfterMs, endsAt }`. `blocked` is true while
   * the adapter is in cooldown, or half-open with a probe already out.
   */
  peek(id) {
    const set = this.settingsFor(id);
    if (!set) return { enabled: false, blocked: false, state: 'closed', retryAfterMs: 0, endsAt: 0 };
    const s = this.states.get(id);
    if (!s || s.state === 'closed') return { enabled: true, blocked: false, state: 'closed', retryAfterMs: 0, endsAt: 0 };
    const t = this.now();
    if (s.state === 'open' && t < s.openUntil) return { enabled: true, blocked: true, state: 'open', retryAfterMs: s.openUntil - t, endsAt: s.openUntil };
    if (s.probe && !this._probeStale(s, set)) {
      const endsAt = s.probeAt + Math.max(set.cooldownMs, 30_000) * 2;
      return { enabled: true, blocked: true, state: 'half-open', retryAfterMs: Math.max(0, endsAt - t), endsAt };
    }
    return { enabled: true, blocked: false, state: 'half-open', retryAfterMs: 0, endsAt: 0 };
  }

  /**
   * May a request be sent to `id` now? Synchronous, so two concurrent callers cannot both become
   * the half-open probe: the first takes the probe flag, the second is told no.
   */
  check(id) {
    const p = this.peek(id);
    if (!p.enabled || p.blocked) return { allow: !p.enabled, ...p };
    const s = this.states.get(id);
    if (s && s.state !== 'closed') {
      if (s.state === 'open') this.log(`circuit breaker: ${id} half-open, sending one probe`);
      s.state = 'half-open';
      s.probe = true;
      s.probeAt = this.now();
      return { allow: true, enabled: true, blocked: false, state: 'half-open', retryAfterMs: 0, endsAt: 0, probe: true };
    }
    return { allow: true, ...p };
  }

  /** Send to `id` although it is blocked (the route's last resort): it becomes the probe. */
  force(id) {
    if (!this.settingsFor(id)) return;
    const s = this.states.get(id);
    if (!s || s.state === 'closed') return;
    s.state = 'half-open';
    s.probe = true;
    s.probeAt = this.now();
  }

  /** The request sent to `id` ended in a way that says nothing (aborted, a client error): free the probe. */
  release(id) {
    const s = this.states.get(id);
    if (s) s.probe = false;
  }

  recordSuccess(id) {
    if (!this.settingsFor(id)) return;
    const s = this.states.get(id);
    if (!s) return;
    if (s.state !== 'closed') this.log(`circuit breaker: ${id} closed again`);
    s.state = 'closed';
    s.failures = 0;
    s.openUntil = 0;
    s.probe = false;
  }

  /**
   * One counted failure. `retryAfterMs` (a 429's) lengthens the cooldown: it is
   * max(cooldownMs, retryAfterMs), never shorter than the configured one.
   */
  recordFailure(id, { status = null, retryAfterMs: ra = 0 } = {}) {
    const set = this.settingsFor(id);
    if (!set) return;
    const s = this._state(id);
    const t = this.now();
    s.lastFailureAt = t;
    s.lastStatus = typeof status === 'number' ? status : null;
    const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(set.cooldownMs, Number.isFinite(ra) ? ra : 0));
    if (s.state === 'closed') {
      s.failures++;
      if (s.failures < set.failureThreshold) return;
    }
    // Closed and over the threshold, or a probe (or a late request) failing: (re)open.
    const wasClosed = s.state === 'closed';
    s.state = 'open';
    s.openUntil = Math.max(s.openUntil, t + cooldown);
    s.probe = false;
    if (wasClosed) s.trips++;
    this.log(`circuit breaker: ${id} open for ${Math.round(cooldown / 1000)} s after ${s.failures} failure(s)${s.lastStatus ? ` (last status ${s.lastStatus})` : ''}`);
  }

  /** State per adapter that has one: names, counters and times only (no error text). */
  snapshot() {
    const out = [];
    for (const [id, s] of this.states) {
      const set = this.settingsFor(id);
      if (!set) continue;
      const p = this.peek(id);
      out.push({
        adapter: id,
        state: s.state === 'open' && !p.blocked ? 'half-open' : s.state,
        consecutiveFailures: s.failures,
        failureThreshold: set.failureThreshold,
        cooldownMs: set.cooldownMs,
        retryAfterMs: p.state === 'open' ? p.retryAfterMs : 0,
        probeInFlight: s.probe,
        trips: s.trips,
        lastFailureAt: s.lastFailureAt ? new Date(s.lastFailureAt).toISOString() : null,
        lastStatus: s.lastStatus,
      });
    }
    return out.sort((a, b) => a.adapter.localeCompare(b.adapter));
  }

  /** Close one adapter's breaker (or every one); returns how many were not closed. */
  reset(id = null) {
    let n = 0;
    for (const [k, s] of this.states) {
      if (id && k !== id) continue;
      if (s.state !== 'closed') n++;
      this.states.delete(k);
    }
    return n;
  }
}
