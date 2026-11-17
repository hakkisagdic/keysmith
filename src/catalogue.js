/**
 * Catalogue-aware limits: a small, optional JSON file names, per adapter, how many requests a
 * minute / day and tokens a month a source allows. Pure and offline: nothing here touches the
 * network, and nothing runs unless `cfg.catalogue` (a file path) is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expand } from './config.js';
import { LlmError } from './util.js';
import { utcMonth, nextMonthStartUtc } from './usage.js';
import { dayOf, nextMidnight } from './quota.js';

const DEFAULT_COOLDOWN_SEC = 60;
const DEFAULT_PRICE_PATHS = { inputPricePath: 'pricing.prompt', outputPricePath: 'pricing.completion' };

/** Resolved settings: catalogue file path (or null) and per-adapter discovery options. */
export function catalogueSettings(cfg) {
  const raw = cfg && typeof cfg.catalogue === 'string' && cfg.catalogue.trim() ? cfg.catalogue.trim() : null;
  const d = (cfg && cfg.discovery && typeof cfg.discovery === 'object') ? cfg.discovery : {};
  const discovery = { enabled: d.enabled === true };
  for (const [id, v] of Object.entries(d)) {
    if (id === 'enabled' || !v || typeof v !== 'object') continue;
    discovery[id] = { ...DEFAULT_PRICE_PATHS, ...pick(v, ['inputPricePath', 'outputPricePath', 'pricingUrl']) };
  }
  return { path: raw ? expand(raw) : null, discovery };
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
  return out;
}

const posInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

function normalise(doc) {
  const sources = new Map();
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.sources)) {
    throw new Error('expected { version: 1, sources: [...] }');
  }
  for (const s of doc.sources) {
    const id = s?.reach?.keysmith;
    if (typeof id !== 'string' || !id) continue;
    const l = s.limits || {};
    const models = new Map();
    for (const m of Array.isArray(s.models) ? s.models : []) {
      if (m && typeof m.id === 'string') models.set(m.id, typeof m.tier === 'string' ? m.tier : null);
    }
    sources.set(id, {
      source: typeof s.id === 'string' ? s.id : id,
      limits: {
        requestsPerMinute: posInt(l.requestsPerMinute),
        requestsPerDay: posInt(l.requestsPerDay),
        tokensPerDay: posInt(l.tokensPerDay),
        tokensPerMonth: posInt(l.tokensPerMonth),
      },
      models,
    });
  }
  return sources;
}

/** A reader that re-reads the file when its mtime changes. `get()` returns a Map(adapterId -> entry). */
export function loadCatalogue(file, { log = (m) => console.warn(m) } = {}) {
  let mtime = null;
  let cached = new Map();
  let warnedFor = null;
  return {
    get() {
      if (!file) return cached;
      let st;
      try { st = fs.statSync(file); } catch {
        if (warnedFor !== 'missing') { warnedFor = 'missing'; log(`catalogue: cannot read ${path.basename(file)}; ignoring it`); }
        mtime = null; cached = new Map();
        return cached;
      }
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp === mtime) return cached;
      mtime = stamp;
      try {
        cached = normalise(JSON.parse(fs.readFileSync(file, 'utf8')));
        warnedFor = null;
      } catch (e) {
        cached = new Map();
        if (warnedFor !== stamp) { warnedFor = stamp; log(`catalogue: ${path.basename(file)} is invalid (${e.message}); ignoring it`); }
      }
      return cached;
    },
  };
}

export class CatalogueLimiter {
  constructor({ catalogue, now = () => Date.now(), seedMonthTokens = () => 0, seedDayTokens = () => 0 } = {}) {
    this.catalogue = catalogue;
    this.now = now;
    this.seedMonthTokens = seedMonthTokens;
    this.seedDayTokens = seedDayTokens;
    this.state = new Map();
  }

  _st(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { minute: [], day: null, dayCount: 0, tokenDay: null, dayTokens: 0, month: null, monthTokens: 0, cooldownUntil: 0 };
      this.state.set(id, s);
    }
    return s;
  }

  /** `{ ok: true }` or `{ ok: false, retryAfter, why }`. An admitted request is counted; a refused one is not. */
  admit(adapterId) {
    const entry = this.catalogue.get().get(adapterId);
    const t = this.now();
    const s = this._st(adapterId);
    if (s.cooldownUntil > t) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((s.cooldownUntil - t) / 1000)), why: 'cooling down after an upstream 429' };
    }
    if (!entry) return { ok: true };
    const { requestsPerMinute: rpm, requestsPerDay: rpd, tokensPerDay: tpd, tokensPerMonth: tpm } = entry.limits;
    s.minute = s.minute.filter((x) => x > t - 60000);
    if (rpm && s.minute.length >= rpm) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((s.minute[0] + 60000 - t) / 1000)), why: `${rpm} requests per minute` };
    }
    const day = dayOf(t);
    if (s.day !== day) { s.day = day; s.dayCount = 0; }
    if (rpd && s.dayCount >= rpd) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((nextMidnight(t) - t) / 1000)), why: `${rpd} requests per day` };
    }
    if (tpd && this._dayTokens(adapterId, s, t) >= tpd) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((nextMidnight(t) - t) / 1000)), why: `${tpd} tokens per day` };
    }
    if (tpm) {
      const used = this._monthTokens(adapterId, s, t);
      if (used >= tpm) {
        const reset = Date.parse(nextMonthStartUtc(utcMonth(t)));
        return { ok: false, retryAfter: Math.max(1, Math.ceil((reset - t) / 1000)), why: `${tpm} tokens per month` };
      }
    }
    s.minute.push(t);
    s.dayCount += 1;
    return { ok: true };
  }

  _monthTokens(id, s, t) {
    const m = utcMonth(t);
    if (s.month !== m) {
      s.month = m;
      let seed = 0;
      try { seed = Number(this.seedMonthTokens(id)) || 0; } catch { seed = 0; }
      s.monthTokens = seed;
    }
    return s.monthTokens;
  }

  /** Today's tokens (local day, as requestsPerDay counts it); a restart re-seeds from the usage log. */
  _dayTokens(id, s, t) {
    const d = dayOf(t);
    if (s.tokenDay !== d) {
      s.tokenDay = d;
      let seed = 0;
      try { seed = Number(this.seedDayTokens(id)) || 0; } catch { seed = 0; }
      s.dayTokens = seed;
    }
    return s.dayTokens;
  }

  noteTokens(adapterId, n) {
    if (!Number.isFinite(n) || n <= 0) return;
    const s = this._st(adapterId);
    this._dayTokens(adapterId, s, this.now());
    s.dayTokens += n;
    this._monthTokens(adapterId, s, this.now());
    s.monthTokens += n;
  }

  noteUpstream429(adapterId, retryAfterSec) {
    const n = Number(retryAfterSec);
    const sec = Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_SEC;
    this._st(adapterId).cooldownUntil = this.now() + sec * 1000;
  }

  /** `{ source, tier }` for a model the catalogue knows, else null. */
  info(adapterId, model) {
    const entry = this.catalogue.get().get(adapterId);
    if (!entry || !entry.models.has(model)) return null;
    const tier = entry.models.get(model);
    return tier ? { source: entry.source, tier } : { source: entry.source };
  }
}

/** The local refusal, shaped like an upstream 429. The message names the adapter and limit, never a key. */
export function catalogueLimitError(adapterId, d) {
  const err = new LlmError(`${adapterId}: local limit reached (${d.why}); retry in ${d.retryAfter} s`, {
    status: 429, type: 'rate_limit_error', provider: adapterId, retriable: true,
  });
  err.retryAfter = String(d.retryAfter);
  return err;
}

export function discoveredPath(dataDir, adapterId) {
  return path.join(dataDir, 'discovered', `${adapterId}.json`);
}

const discoveredCache = new Map();

/** A Set of discovered ids, or null when the file is missing or unreadable. Re-read on mtime change. */
export function readDiscovered(file) {
  let st;
  try { st = fs.statSync(file); } catch { discoveredCache.delete(file); return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = discoveredCache.get(file);
  if (hit && hit.stamp === stamp) return hit.set;
  let set = null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = Array.isArray(doc) ? doc : doc?.ids;
    if (Array.isArray(ids)) set = new Set(ids.filter((x) => typeof x === 'string'));
  } catch { set = null; }
  discoveredCache.set(file, { stamp, set });
  return set;
}

/**
 * Ids that are free in a NewAPI-style public price table (`{ data: [{ model_name, quota_type,
 * model_price, model_ratio }], tiered_pricing: { <model>: … } }`): a model counts only when
 * quota_type, model_price and model_ratio are all present and zero and it has no tiered entry.
 * A completion ratio multiplies model_ratio, so zero there is zero out. Anything missing,
 * unreadable or not numeric is not free.
 */
export function freeModelsFromPriceTable(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const tiered = body?.tiered_pricing && typeof body.tiered_pricing === 'object' ? body.tiered_pricing : {};
  const out = [];
  for (const m of rows) {
    if (!m || typeof m.model_name !== 'string' || !m.model_name) continue;
    if (m.quota_type !== 0 || m.model_price !== 0 || m.model_ratio !== 0) continue;
    if (Object.hasOwn(tiered, m.model_name)) continue;
    if (!out.includes(m.model_name)) out.push(m.model_name);
  }
  return out;
}

/** `source` is a host and path only: never a query, never a credential. */
export function writeDiscovered(file, ids, meta = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ids: [...ids], ...(meta ? { source: meta.source, at: meta.at } : {}) }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function at(obj, dotted) {
  let v = obj;
  for (const k of String(dotted).split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return v;
}

const isZero = (v) => (typeof v === 'number' && v === 0) || (typeof v === 'string' && /^\s*0+(\.0+)?\s*$/.test(v));

/** Ids whose input and output price are both zero. A missing price field never counts as free. */
export function freeModels(list, { inputPricePath, outputPricePath } = DEFAULT_PRICE_PATHS) {
  const arr = Array.isArray(list) ? list : (Array.isArray(list?.data) ? list.data : []);
  const out = [];
  for (const m of arr) {
    if (!m || typeof m.id !== 'string') continue;
    if (isZero(at(m, inputPricePath)) && isZero(at(m, outputPricePath))) out.push(m.id);
  }
  return out;
}
