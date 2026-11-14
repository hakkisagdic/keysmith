import { createHash } from 'node:crypto';
import { roundUsd } from './usage.js';

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_SEMANTIC_THRESHOLD = 0.88;

/**
 * Extract normalized prompt text from a request body across OpenAI Chat, Anthropic Messages,
 * OpenAI Responses, and Embeddings.
 */
export function extractPromptText(body = {}) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'system') continue; // system prompt is already in contextHash
      parts.push(`${m.role || 'user'}:${flattenContent(m.content)}`);
    }
  } else if (body.input !== undefined && body.input !== null) {
    if (typeof body.input === 'string') {
      parts.push(body.input);
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object') {
          parts.push(`${item.role || 'user'}:${flattenContent(item.content ?? item.text ?? '')}`);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

function flattenContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * Build a sparse TF vector of character 3-grams and normalized word tokens, along with its L2 norm.
 * Supports Turkish and English characters cleanly with zero external dependencies.
 */
export function buildSemanticVector(text = '') {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return { weights: new Map(), norm: 0 };

  const weights = new Map();
  const words = norm.split(' ').filter(Boolean);
  for (const w of words) {
    const wk = `w:${w}`;
    weights.set(wk, (weights.get(wk) || 0) + 1.5);
  }
  const compact = norm.replace(/\s+/g, '_');
  if (compact.length <= 3) {
    const gk = `g:${compact}`;
    weights.set(gk, (weights.get(gk) || 0) + 1);
  } else {
    for (let i = 0; i <= compact.length - 3; i++) {
      const tri = `g:${compact.slice(i, i + 3)}`;
      weights.set(tri, (weights.get(tri) || 0) + 1);
    }
  }

  let sumSq = 0;
  for (const v of weights.values()) sumSq += v * v;
  return { weights, norm: Math.sqrt(sumSq) };
}

/**
 * Compute cosine similarity in `[0, 1]` between two sparse vectors built by `buildSemanticVector`.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.norm === 0 || vecB.norm === 0) return 0;
  const [small, large] = vecA.weights.size <= vecB.weights.size ? [vecA, vecB] : [vecB, vecA];
  let dot = 0;
  for (const [k, v] of small.weights) {
    const other = large.weights.get(k);
    if (other !== undefined) dot += v * other;
  }
  const sim = dot / (vecA.norm * vecB.norm);
  return Math.max(0, Math.min(1, Math.round(sim * 10000) / 10000));
}

/**
 * Deterministic LRU + TTL + Semantic Similarity response cache for `/v1/chat/completions`,
 * `/v1/messages`, `/v1/responses`, and `/v1/embeddings`.
 */
export class ResponseCache {
  constructor(cfg = {}, { now = () => Date.now() } = {}) {
    this.now = now;
    this.configure(cfg);
    this._map = new Map(); // key -> { key, createdAt, exp, route, model, value, costUsd, usage, hits, contextHash, vector }
    this.hits = 0;
    this.semanticHits = 0;
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
      this.semantic = false;
      this.semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD;
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.enabled = false;
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
      this.maxEntries = DEFAULT_MAX_ENTRIES;
      this.maxTemperature = 1;
      this.semantic = false;
      this.semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD;
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
    this.semantic = raw.semantic === true;
    const rawThresh = Number(raw.semanticThreshold);
    this.semanticThreshold =
      Number.isFinite(rawThresh) && rawThresh >= 0.5 && rawThresh <= 0.9999
        ? rawThresh
        : DEFAULT_SEMANTIC_THRESHOLD;
  }

  /**
   * Decide whether a request should use the response cache.
   * Returns `{ active, bypass, ttlMs, semantic, semanticThreshold }`.
   */
  policy(req, body = {}) {
    const hdr = String(req?.headers?.['x-keysmith-cache'] || '').trim().toLowerCase();
    const semHdr = String(req?.headers?.['x-keysmith-cache-semantic'] || '').trim().toLowerCase();
    const cc = String(req?.headers?.['cache-control'] || '').trim().toLowerCase();
    const forcedOn = hdr === 'enable' || hdr === 'true' || hdr === 'force' || hdr === '1' || hdr === 'semantic';
    const active = this.enabled || forcedOn || (semHdr !== '' && semHdr !== 'false' && semHdr !== '0' && semHdr !== 'off');
    if (!active) return { active: false, bypass: false, ttlMs: 0, semantic: false, semanticThreshold: this.semanticThreshold };

    if (
      hdr === 'bypass' ||
      hdr === 'off' ||
      hdr === 'false' ||
      hdr === '0' ||
      cc.includes('no-cache') ||
      cc.includes('no-store')
    ) {
      this.bypasses++;
      return { active: true, bypass: true, ttlMs: 0, semantic: false, semanticThreshold: this.semanticThreshold };
    }

    // Stateful session continuations are never served from static cache.
    if (
      req?.headers?.['x-keysmith-session'] ||
      (typeof body?.session === 'string' && body.session.trim()) ||
      (typeof body?.previous_response_id === 'string' && body.previous_response_id.trim())
    ) {
      return { active: true, bypass: true, ttlMs: 0, semantic: false, semanticThreshold: this.semanticThreshold };
    }

    if (
      body?.temperature !== undefined &&
      body?.temperature !== null &&
      Number.isFinite(Number(body.temperature)) &&
      Number(body.temperature) > this.maxTemperature
    ) {
      return { active: true, bypass: true, ttlMs: 0, semantic: false, semanticThreshold: this.semanticThreshold };
    }

    let ttlSeconds = this.ttlSeconds;
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    if (maxAgeMatch) {
      const requestedMaxAge = Number(maxAgeMatch[1]);
      if (requestedMaxAge <= 0) {
        this.bypasses++;
        return { active: true, bypass: true, ttlMs: 0, semantic: false, semanticThreshold: this.semanticThreshold };
      }
      ttlSeconds = Math.min(ttlSeconds, requestedMaxAge);
    }

    let semantic = this.semantic || hdr === 'semantic';
    let semanticThreshold = this.semanticThreshold;
    if (semHdr === 'false' || semHdr === '0' || semHdr === 'off') {
      semantic = false;
    } else if (semHdr === 'true' || semHdr === '1' || semHdr === 'enable') {
      semantic = true;
    } else if (semHdr !== '') {
      const parsedThresh = Number(semHdr);
      if (Number.isFinite(parsedThresh) && parsedThresh >= 0.5 && parsedThresh <= 0.9999) {
        semantic = true;
        semanticThreshold = parsedThresh;
      }
    }

    return { active: true, bypass: false, ttlMs: ttlSeconds * 1000, semantic, semanticThreshold };
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

  /**
   * Build a context fingerprint covering everything EXCEPT the user conversation text, so semantic
   * matches only occur within identical route, target models, system prompt, and tool definitions.
   */
  buildContextHash({ route, model, targets = [], body = {}, effort = null }) {
    const sysMessages = Array.isArray(body?.messages)
      ? body.messages.filter((m) => m && m.role === 'system')
      : null;
    const canonical = stableStringify({
      route,
      model: model || body?.model || '',
      targets,
      sysMessages,
      system: body?.system ?? null,
      instructions: body?.instructions ?? null,
      tools: body?.tools ?? null,
      functions: body?.functions ?? null,
      tool_choice: body?.tool_choice ?? body?.function_call ?? null,
      effort: effort?.effort ?? body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.output_config?.effort ?? null,
      response_format: body?.response_format ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  }

  /**
   * Look up a cached response by exact key first, then (if `semantic` is enabled in `options`)
   * by highest cosine similarity `>= semanticThreshold` within the same `contextHash`.
   */
  get(key, options = null) {
    if (!key) return null;
    const t = this.now();
    this._evictExpired(t);
    const entry = this._map.get(key);
    if (entry && entry.exp > t) {
      // Refresh LRU order.
      this._map.delete(key);
      this._map.set(key, entry);
      entry.hits++;
      this.hits++;
      this._accountSavings(entry);
      return { ...entry, semantic: false, similarity: 1 };
    }
    if (entry && entry.exp <= t) {
      this._map.delete(key);
    }

    if (options?.semantic && options?.body) {
      const ctxHash = this.buildContextHash(options);
      const queryText = extractPromptText(options.body);
      const queryVec = buildSemanticVector(queryText);
      const threshold = Number.isFinite(Number(options.semanticThreshold))
        ? Number(options.semanticThreshold)
        : this.semanticThreshold;

      if (queryVec.norm > 0) {
        let bestEntry = null;
        let bestSim = 0;
        for (const cand of this._map.values()) {
          if (cand.exp <= t) continue;
          if (cand.contextHash !== ctxHash || !cand.vector) continue;
          const sim = cosineSimilarity(queryVec, cand.vector);
          if (sim >= threshold && sim > bestSim) {
            bestSim = sim;
            bestEntry = cand;
          }
        }
        if (bestEntry) {
          this._map.delete(bestEntry.key);
          this._map.set(bestEntry.key, bestEntry);
          bestEntry.hits++;
          this.hits++;
          this.semanticHits++;
          this._accountSavings(bestEntry);
          return { ...bestEntry, semantic: true, similarity: bestSim };
        }
      }
    }

    this.misses++;
    return null;
  }

  _accountSavings(entry) {
    const savedUsd = Number(entry.costUsd) || 0;
    if (savedUsd > 0) this.savedUsd = roundUsd(this.savedUsd + savedUsd);
    const inTok = Number(entry.usage?.input) || 0;
    const outTok = Number(entry.usage?.output) || 0;
    this.savedInputTokens += inTok;
    this.savedOutputTokens += outTok;
  }

  set(key, { route, model, targets = [], body = null, effort = null, value, costUsd = 0, usage = null, ttlMs = null } = {}) {
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
    const contextHash = body ? this.buildContextHash({ route, model, targets, body, effort }) : null;
    const promptText = body ? extractPromptText(body) : '';
    const vector = promptText ? buildSemanticVector(promptText) : null;
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
      contextHash,
      vector,
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
      semantic: this.semantic,
      semanticThreshold: this.semanticThreshold,
      entries: this._map.size,
      maxEntries: this.maxEntries,
      ttlSeconds: this.ttlSeconds,
      hits: this.hits,
      semanticHits: this.semanticHits,
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
