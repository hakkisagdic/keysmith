import { createHash } from 'node:crypto';
import { roundUsd } from './usage.js';

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_MAX_ENTRIES = 512;

/**
 * Deterministic LRU + TTL response cache for `/v1/chat/completions`, `/v1/messages`,
 * `/v1/responses`, and `/v1/embeddings`.
 */
export class ResponseCache {
  constructor(cfg = {}, { now = () => Date.now() } = {}) {
    this.now = now;
    this.configure(cfg);
    this._map = new Map(); // key -> { key, createdAt, exp, route, model, value, costUsd, usage, hits }
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
    this.savedUsd = 0;
    this.savedInputTokens = 0;
    this.savedOutputTokens = 0;
  }

  configure(cfg = {}) {
    const raw = cfg?.cache;
    if (raw === true) {
      this.enabled = true;
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
      this.maxEntries = DEFAULT_MAX_ENTRIES;
      this.maxTemperature = 1;
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.enabled = false;
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
      this.maxEntries = DEFAULT_MAX_ENTRIES;
      this.maxTemperature = 1;
      return;
    }
    this.enabled = raw.enabled === true;
    this.ttlSeconds =
      Number.isFinite(Number(raw.ttlSeconds)) && Number(raw.ttlSeconds) > 0
        ? Math.floor(Number(raw.ttlSeconds))
        : DEFAULT_TTL_SECONDS;
    this.maxEntries =
      Number.isFinite(Number(raw.maxEntries)) && Number(raw.maxEntries) > 0
        ? Math.floor(Number(raw.maxEntries))
        : DEFAULT_MAX_ENTRIES;
    this.maxTemperature =
      raw.maxTemperature !== undefined && Number.isFinite(Number(raw.maxTemperature))
        ? Number(raw.maxTemperature)
        : 1;
  }

  /**
   * Decide whether a request should use the response cache.
   * Returns `{ active, bypass, ttlMs }`.
   */
  policy(req, body = {}) {
    const hdr = String(req?.headers?.['x-keysmith-cache'] || '').trim().toLowerCase();
    const cc = String(req?.headers?.['cache-control'] || '').trim().toLowerCase();
    const forcedOn = hdr === 'enable' || hdr === 'true' || hdr === 'force' || hdr === '1';
    const active = this.enabled || forcedOn;
    if (!active) return { active: false, bypass: false, ttlMs: 0 };

    if (
      hdr === 'bypass' ||
      hdr === 'off' ||
      hdr === 'false' ||
      hdr === '0' ||
      cc.includes('no-cache') ||
      cc.includes('no-store')
    ) {
      this.bypasses++;
      return { active: true, bypass: true, ttlMs: 0 };
    }

    // Stateful session continuations are never served from static cache.
    if (
      req?.headers?.['x-keysmith-session'] ||
      (typeof body?.session === 'string' && body.session.trim()) ||
      (typeof body?.previous_response_id === 'string' && body.previous_response_id.trim())
    ) {
      return { active: true, bypass: true, ttlMs: 0 };
    }

    if (
      body?.temperature !== undefined &&
      body?.temperature !== null &&
      Number.isFinite(Number(body.temperature)) &&
      Number(body.temperature) > this.maxTemperature
    ) {
      return { active: true, bypass: true, ttlMs: 0 };
    }

    let ttlSeconds = this.ttlSeconds;
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    if (maxAgeMatch) {
      const requestedMaxAge = Number(maxAgeMatch[1]);
      if (requestedMaxAge <= 0) {
        this.bypasses++;
        return { active: true, bypass: true, ttlMs: 0 };
      }
      ttlSeconds = Math.min(ttlSeconds, requestedMaxAge);
    }

    return { active: true, bypass: false, ttlMs: ttlSeconds * 1000 };
  }

  /**
   * Build a deterministic SHA-256 key from the route, resolved candidate targets, and canonical body fields.
   */
  buildKey({ route, model, targets = [], body = {}, effort = null }) {
    const canonical = stableStringify({
      route,
      model: model || body?.model || '',
      targets,
      messages: body?.messages ?? null,
      system: body?.system ?? null,
      input: body?.input ?? null,
      instructions: body?.instructions ?? null,
      tools: body?.tools ?? null,
      functions: body?.functions ?? null,
      tool_choice: body?.tool_choice ?? body?.function_call ?? null,
      temperature: body?.temperature ?? null,
      max_tokens: body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? null,
      effort: effort?.effort ?? body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.output_config?.effort ?? null,
      include_reasoning: !!body?.include_reasoning,
      response_format: body?.response_format ?? null,
      encoding_format: body?.encoding_format ?? null,
      dimensions: body?.dimensions ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  }

  get(key) {
    if (!key) return null;
    const t = this.now();
    this._evictExpired(t);
    const entry = this._map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.exp <= t) {
      this._map.delete(key);
      this.misses++;
      return null;
    }
    // Refresh LRU order.
    this._map.delete(key);
    this._map.set(key, entry);
    entry.hits++;
    this.hits++;
    const savedUsd = Number(entry.costUsd) || 0;
    if (savedUsd > 0) this.savedUsd = roundUsd(this.savedUsd + savedUsd);
    const inTok = Number(entry.usage?.input) || 0;
    const outTok = Number(entry.usage?.output) || 0;
    this.savedInputTokens += inTok;
    this.savedOutputTokens += outTok;
    return entry;
  }

  set(key, { route, model, value, costUsd = 0, usage = null, ttlMs = null } = {}) {
    if (!key || !value) return;
    const t = this.now();
    this._evictExpired(t);
    const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.ttlSeconds * 1000;
    if (this._map.has(key)) this._map.delete(key);
    while (this._map.size >= this.maxEntries) {
      const oldest = this._map.keys().next().value;
      if (oldest === undefined) break;
      this._map.delete(oldest);
    }
    this._map.set(key, {
      key,
      route: route || null,
      model: model || null,
      value,
      costUsd: Number.isFinite(Number(costUsd)) && Number(costUsd) > 0 ? roundUsd(Number(costUsd)) : 0,
      usage: usage && typeof usage === 'object' ? { ...usage } : null,
      createdAt: t,
      exp: t + effectiveTtlMs,
      hits: 0,
    });
  }

  clear() {
    const count = this._map.size;
    this._map.clear();
    return count;
  }

  stats() {
    this._evictExpired(this.now());
    const totalLookups = this.hits + this.misses;
    return {
      enabled: this.enabled,
      entries: this._map.size,
      maxEntries: this.maxEntries,
      ttlSeconds: this.ttlSeconds,
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
      hitRate: totalLookups > 0 ? Math.round((this.hits / totalLookups) * 10000) / 10000 : 0,
      savedUsd: roundUsd(this.savedUsd),
      savedTokens: {
        input: this.savedInputTokens,
        output: this.savedOutputTokens,
        total: this.savedInputTokens + this.savedOutputTokens,
      },
    };
  }

  _evictExpired(t) {
    for (const [k, v] of this._map) {
      if (v.exp <= t) this._map.delete(k);
    }
  }
}

function stableStringify(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(val).sort();
  return (
    '{' +
    keys
      .filter((k) => val[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(val[k]))
      .join(',') +
    '}'
  );
}
