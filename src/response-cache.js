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
import { cosine } from './semantic-vector.js';

export const SEMANTIC_DEFAULTS = Object.freeze({ enabled: false, threshold: 0.92, maxProbe: 200 });
export const CACHE_DEFAULTS = Object.freeze({
  enabled: false,
  ttlSeconds: 3600,
  maxEntries: 500,
  semantic: SEMANTIC_DEFAULTS,
});

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

function validThreshold(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1;
}

function offConfig() {
  return {
    enabled: false,
    ttlSeconds: CACHE_DEFAULTS.ttlSeconds,
    maxEntries: CACHE_DEFAULTS.maxEntries,
    semantic: { ...SEMANTIC_DEFAULTS, enabled: false },
  };
}

/**
 * `cache` from config. Absent is the default, off, and not an error. A bad value
 * is `{ enabled: false, error }` — the cache stays off and doctor prints `error`.
 */
export function resolveCacheConfig(raw) {
  const off = offConfig();
  if (raw == null) return { ...off, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...off, error: 'cache must be an object, e.g. {"enabled": false, "ttlSeconds": 3600, "maxEntries": 500} — response cache stays off' };
  }
  const errors = [];
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') errors.push('cache.enabled must be true or false');
  if (Object.hasOwn(raw, 'ttlSeconds') && !whole(raw.ttlSeconds)) errors.push('cache.ttlSeconds must be a whole number of seconds, 1 or more');
  if (Object.hasOwn(raw, 'maxEntries') && !whole(raw.maxEntries)) errors.push('cache.maxEntries must be a whole number, 1 or more');
  for (const k of Object.keys(raw)) {
    if (k !== 'enabled' && k !== 'ttlSeconds' && k !== 'maxEntries' && k !== 'semantic') errors.push(`cache has an unknown field "${k}"`);
  }
  let sem = { ...SEMANTIC_DEFAULTS };
  if (Object.hasOwn(raw, 'semantic') && raw.semantic !== undefined) {
    const s = raw.semantic;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push('cache.semantic must be an object, e.g. {"enabled": false, "threshold": 0.92, "maxProbe": 200}');
    } else {
      if (Object.hasOwn(s, 'enabled') && typeof s.enabled !== 'boolean') errors.push('cache.semantic.enabled must be true or false');
      if (Object.hasOwn(s, 'threshold') && !validThreshold(s.threshold)) errors.push('cache.semantic.threshold must be a number in (0, 1]');
      if (Object.hasOwn(s, 'maxProbe') && !whole(s.maxProbe)) errors.push('cache.semantic.maxProbe must be a whole number, 1 or more');
      for (const sk of Object.keys(s)) {
        if (sk !== 'enabled' && sk !== 'threshold' && sk !== 'maxProbe') errors.push(`cache.semantic has an unknown field "${sk}"`);
      }
      sem = {
        enabled: s.enabled === true,
        threshold: Object.hasOwn(s, 'threshold') && validThreshold(s.threshold) ? s.threshold : SEMANTIC_DEFAULTS.threshold,
        maxProbe: Object.hasOwn(s, 'maxProbe') && whole(s.maxProbe) ? s.maxProbe : SEMANTIC_DEFAULTS.maxProbe,
      };
    }
  }
  if (errors.length) return { ...off, error: `${errors.join('; ')} — response cache stays off` };
  const enabled = raw.enabled === true;
  const out = {
    enabled,
    ttlSeconds: Object.hasOwn(raw, 'ttlSeconds') ? raw.ttlSeconds : CACHE_DEFAULTS.ttlSeconds,
    maxEntries: Object.hasOwn(raw, 'maxEntries') ? raw.maxEntries : CACHE_DEFAULTS.maxEntries,
    semantic: sem,
    error: null,
  };
  if (!enabled && sem.enabled) {
    out.warning = 'cache.semantic.enabled is true while cache.enabled is false — semantic cache has no effect';
  }
  return out;
}

/** Canonical JSON: object keys sorted, array order kept, so key order in the body does not change the hash. */
function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v) ?? 'null').join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function pickAnswerFields(src, fields) {
  const picked = {};
  for (const k of fields) {
    if (src[k] !== undefined) picked[k] = src[k];
  }
  const oc = src.output_config;
  if (oc && typeof oc === 'object' && !Array.isArray(oc) && Object.hasOwn(oc, 'effort')) {
    picked.output_config = { effort: oc.effort };
  }
  return picked;
}

const SHAPE_FIELDS = ANSWER_FIELDS.filter((k) => k !== 'messages');

/**
 * SHA-256 hex of the caller hash plus the canonical answer-fields of `body`.
 * `callerHash` is `identify()`'s `caller`, already a hash — never the key itself.
 */
export function keyFor({ callerHash, body } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const picked = pickAnswerFields(src, ANSWER_FIELDS);
  return createHash('sha256').update(String(callerHash ?? '')).update('\0').update(canonical(picked)).digest('hex');
}

/**
 * SHA-256 hex of the caller hash, model + parameters, and every message except
 * the last `user` turn. Ensures semantic lookup never crosses callers, models,
 * system prompts, or earlier conversation turns. Returns `null` when ineligible.
 */
export function shapeFor({ callerHash, body } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!src || !Array.isArray(src.messages) || src.messages.length === 0) return null;
  const last = src.messages[src.messages.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last) || last.role !== 'user') return null;
  const picked = pickAnswerFields(src, SHAPE_FIELDS);
  picked.prefix = src.messages.slice(0, -1);
  if (last.name !== undefined) picked.lastName = last.name;
  return createHash('sha256').update(String(callerHash ?? '')).update('\0').update(canonical(picked)).digest('hex');
}

function cleanSemanticMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.shape !== 'string' || !meta.shape) return null;
  const v = meta.vector;
  if (!v || typeof v !== 'object' || typeof v.norm !== 'number' || !(v.norm > 0) || !(v.terms instanceof Map)) return null;
  return {
    shape: meta.shape,
    vector: {
      terms: new Map(v.terms),
      norm: v.norm,
      ...(typeof v.guardHash === 'string' ? { guardHash: v.guardHash } : {}),
    },
  };
}

/**
 * LRU map of completion payloads, with an optional per-shape semantic index.
 * `get` / `getSemantic` count hits and misses. `set` returns false and stores
 * nothing when the JSON is over {@link MAX_CACHED_BYTES}. `now` is milliseconds
 * (a Date is accepted). Expired rows are dropped, not served.
 */
export function ResponseCache({ maxEntries = CACHE_DEFAULTS.maxEntries, ttlMs = CACHE_DEFAULTS.ttlSeconds * 1000, now = () => Date.now(), semantic = false } = {}) {
  if (!(this instanceof ResponseCache)) return new ResponseCache({ maxEntries, ttlMs, now, semantic });
  this.maxEntries = maxEntries;
  this.ttlMs = ttlMs;
  this.now = typeof now === 'function' ? now : () => Date.now();
  this._map = new Map();
  this._shapes = new Map();
  this._semantic = Boolean(semantic);
  this._semanticUsed = false;
  this._hits = 0;
  this._semanticHits = 0;
  this._misses = 0;
}

ResponseCache.prototype._at = function _at() {
  const t = this.now();
  return t instanceof Date ? t.getTime() : Number(t);
};

ResponseCache.prototype._delete = function _delete(key) {
  const row = this._map.get(key);
  if (!row) return false;
  this._map.delete(key);
  if (row.shape !== undefined) {
    const bucket = this._shapes.get(row.shape);
    if (bucket) {
      bucket.delete(key);
      if (bucket.size === 0) this._shapes.delete(row.shape);
    }
  }
  return true;
};

ResponseCache.prototype._touch = function _touch(key, row) {
  // Most recently used, without extending the TTL: the clock it was stored at stays.
  this._map.delete(key);
  this._map.set(key, row);
  if (row.shape !== undefined) {
    const bucket = this._shapes.get(row.shape);
    if (bucket) {
      bucket.delete(key);
      bucket.add(key);
    }
  }
};

ResponseCache.prototype._fresh = function _fresh(key, row) {
  if (this._at() - row.at >= this.ttlMs) {
    this._delete(key);
    return false;
  }
  return true;
};

ResponseCache.prototype._purgeExpired = function _purgeExpired() {
  for (const [key, row] of this._map) this._fresh(key, row);
};

ResponseCache.prototype.get = function get(key, { countMiss = true } = {}) {
  const row = this._map.get(key);
  if (!row || !this._fresh(key, row)) {
    if (countMiss) this._misses++;
    return null;
  }
  this._touch(key, row);
  this._hits++;
  return structuredClone(row.payload);
};

ResponseCache.prototype.getSemantic = function getSemantic(
  shape,
  vector,
  { threshold = SEMANTIC_DEFAULTS.threshold, maxProbe = SEMANTIC_DEFAULTS.maxProbe, similarity = cosine } = {},
) {
  this._semanticUsed = true;
  if (typeof shape !== 'string' || !shape || !vector || typeof vector !== 'object' || !(vector.norm > 0)) {
    this._misses++;
    return null;
  }
  const bucket = this._shapes.get(shape);
  if (!bucket || bucket.size === 0) {
    this._misses++;
    return null;
  }
  const keys = [...bucket];
  let probed = 0;
  let bestSim = -1;
  let bestKey = null;
  let bestRow = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    const row = this._map.get(k);
    if (!row || !this._fresh(k, row)) continue;
    if (probed >= maxProbe) break;
    probed++;
    if (!row.vector) continue;
    if (vector.guardHash !== undefined && row.vector.guardHash !== undefined && vector.guardHash !== row.vector.guardHash) {
      continue;
    }
    const sim = similarity(vector, row.vector);
    if (typeof sim === 'number' && Number.isFinite(sim) && sim >= threshold && sim > bestSim) {
      bestSim = sim;
      bestKey = k;
      bestRow = row;
    }
  }
  if (!bestRow) {
    this._misses++;
    return null;
  }
  this._touch(bestKey, bestRow);
  this._hits++;
  this._semanticHits++;
  return { payload: structuredClone(bestRow.payload), similarity: bestSim };
};

ResponseCache.prototype.set = function set(key, payload, meta = null) {
  if (!payload || typeof payload !== 'object') return false;
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_CACHED_BYTES) return false;
  this._purgeExpired();
  if (this._map.has(key)) this._delete(key);
  const cleanMeta = cleanSemanticMeta(meta);
  const row = { at: this._at(), payload: JSON.parse(encoded) };
  if (cleanMeta) {
    row.shape = cleanMeta.shape;
    row.vector = cleanMeta.vector;
    let bucket = this._shapes.get(cleanMeta.shape);
    if (!bucket) {
      bucket = new Set();
      this._shapes.set(cleanMeta.shape, bucket);
    }
    bucket.add(key);
  }
  this._map.set(key, row);
  while (this._map.size > this.maxEntries) {
    const oldest = this._map.keys().next().value;
    if (oldest === undefined) break;
    this._delete(oldest);
  }
  return true;
};

ResponseCache.prototype.clear = function clear() {
  this._map.clear();
  this._shapes.clear();
};

ResponseCache.prototype.stats = function stats() {
  this._purgeExpired();
  const out = { hits: this._hits, misses: this._misses, entries: this._map.size };
  if (this._semantic || this._semanticUsed || this._semanticHits > 0) out.semanticHits = this._semanticHits;
  return out;
};
