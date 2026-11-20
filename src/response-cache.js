/**
 * Exact-match response cache for non-streaming chat completions.
 *
 * In memory only: an LRU map with a TTL and an injectable clock. The map key is a
 * SHA-256 of the caller hash `identify()` already builds (so one gateway key never
 * reads another's answers) and a canonical JSON of the body fields that change the
 * answer. The stored value is the completion payload. Nothing here is a key, and
 * nothing is written to disk — a restart empties it.
 *
 * Off unless `cache.enabled` is true. A value that does not validate is a doctor
 * error and the cache stays off (`resolveCacheConfig`).
 */

import { createHash } from 'node:crypto';

export const CACHE_DEFAULTS = Object.freeze({ enabled: false, ttlSeconds: 3600, maxEntries: 500 });

/** Skip answers larger than this. About 1 MB of JSON. */
export const MAX_CACHED_BYTES = 1024 * 1024;

/**
 * Fields that change the answer. Anything else (`user`, `stream`, a client tag) is
 * not part of the key. Effort is `reasoning_effort`, the `reasoning` object, and
 * `output_config.effort`.
 */
const ANSWER_FIELDS = [
  'model',
  'messages',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'include_reasoning',
  'response_format',
  'stop',
  'seed',
  'reasoning_effort',
  'reasoning',
];

function whole(n) {
  return Number.isInteger(n) && n >= 1 && n <= Number.MAX_SAFE_INTEGER;
}

/**
 * `cache` from config. Absent is the default, off, and not an error. A bad value
 * is `{ enabled: false, error }` — the cache stays off and doctor prints `error`.
 */
export function resolveCacheConfig(raw) {
  const off = { ...CACHE_DEFAULTS, enabled: false };
  if (raw == null) return { ...off, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...off, error: 'cache must be an object, e.g. {"enabled": false, "ttlSeconds": 3600, "maxEntries": 500} — response cache stays off' };
  }
  const errors = [];
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') errors.push('cache.enabled must be true or false');
  if (Object.hasOwn(raw, 'ttlSeconds') && !whole(raw.ttlSeconds)) errors.push('cache.ttlSeconds must be a whole number of seconds, 1 or more');
  if (Object.hasOwn(raw, 'maxEntries') && !whole(raw.maxEntries)) errors.push('cache.maxEntries must be a whole number, 1 or more');
  for (const k of Object.keys(raw)) {
    if (k !== 'enabled' && k !== 'ttlSeconds' && k !== 'maxEntries') errors.push(`cache has an unknown field "${k}"`);
  }
  if (errors.length) return { ...off, error: `${errors.join('; ')} — response cache stays off` };
  return {
    enabled: raw.enabled === true,
    ttlSeconds: Object.hasOwn(raw, 'ttlSeconds') ? raw.ttlSeconds : CACHE_DEFAULTS.ttlSeconds,
    maxEntries: Object.hasOwn(raw, 'maxEntries') ? raw.maxEntries : CACHE_DEFAULTS.maxEntries,
    error: null,
  };
}

/** Canonical JSON: object keys sorted, array order kept, so key order in the body does not change the hash. */
function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v) ?? 'null').join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * SHA-256 hex of the caller hash plus the canonical answer-fields of `body`.
 * `callerHash` is `identify()`'s `caller`, already a hash — never the key itself.
 */
export function keyFor({ callerHash, body } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const picked = {};
  for (const k of ANSWER_FIELDS) {
    if (src[k] !== undefined) picked[k] = src[k];
  }
  const oc = src.output_config;
  if (oc && typeof oc === 'object' && !Array.isArray(oc) && Object.hasOwn(oc, 'effort')) {
    picked.output_config = { effort: oc.effort };
  }
  return createHash('sha256').update(String(callerHash ?? '')).update('\0').update(canonical(picked)).digest('hex');
}

/**
 * LRU map of completion payloads. `get` counts a hit or a miss. `set` returns false
 * and stores nothing when the JSON is over {@link MAX_CACHED_BYTES}. `now` is
 * milliseconds (a Date is accepted). Expired rows are dropped, not served.
 */
export function ResponseCache({ maxEntries = CACHE_DEFAULTS.maxEntries, ttlMs = CACHE_DEFAULTS.ttlSeconds * 1000, now = () => Date.now() } = {}) {
  if (!(this instanceof ResponseCache)) return new ResponseCache({ maxEntries, ttlMs, now });
  this.maxEntries = maxEntries;
  this.ttlMs = ttlMs;
  this.now = typeof now === 'function' ? now : () => Date.now();
  this._map = new Map();
  this._hits = 0;
  this._misses = 0;
}

ResponseCache.prototype._at = function _at() {
  const t = this.now();
  return t instanceof Date ? t.getTime() : Number(t);
};

ResponseCache.prototype._fresh = function _fresh(key, row) {
  if (this._at() - row.at >= this.ttlMs) {
    this._map.delete(key);
    return false;
  }
  return true;
};

ResponseCache.prototype._purgeExpired = function _purgeExpired() {
  for (const [key, row] of this._map) this._fresh(key, row);
};

ResponseCache.prototype.get = function get(key) {
  const row = this._map.get(key);
  if (!row || !this._fresh(key, row)) {
    this._misses++;
    return null;
  }
  // Most recently used, without extending the TTL: the clock it was stored at stays.
  this._map.delete(key);
  this._map.set(key, row);
  this._hits++;
  return structuredClone(row.payload);
};

ResponseCache.prototype.set = function set(key, payload) {
  if (!payload || typeof payload !== 'object') return false;
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_CACHED_BYTES) return false;
  this._purgeExpired();
  if (this._map.has(key)) this._map.delete(key);
  this._map.set(key, { at: this._at(), payload: JSON.parse(encoded) });
  while (this._map.size > this.maxEntries) {
    const oldest = this._map.keys().next().value;
    if (oldest === undefined) break;
    this._map.delete(oldest);
  }
  return true;
};

ResponseCache.prototype.clear = function clear() {
  this._map.clear();
};

ResponseCache.prototype.stats = function stats() {
  this._purgeExpired();
  return { hits: this._hits, misses: this._misses, entries: this._map.size };
};
