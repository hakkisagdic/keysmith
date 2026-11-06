import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dataDir } from './config.js';
import { openPrivateLog } from './logfiles.js';
import { fingerprint, redactSecrets } from './redact.js';
import { dayOf, nextMidnight, startOfDay } from './quota.js';

/**
 * Append-only JSONL usage & audit log.
 *
 * Keeps: timestamp, model, adapter, kind (http|cli), upstream host (for HTTP, no path or
 * query), credential account name (never its secret value), face
 * (chat|messages|responses|embeddings), status, duration ms, token counts
 * (input, output, cacheRead, cacheWrite), cost ({usd, basis, listUsd?}), bytesIn/bytesOut,
 * upstreamId, client tag (x-keysmith-tag), stream flag, user-agent, key fingerprint + label +
 * scope decision, and tool/retry marks.
 * Never keeps: the key, the prompt, the answer, a header or the request URL.
 *
 * One file per UTC calendar month: the active month is written to `usage.jsonl` (the
 * documented path) so `tail -F ~/.local/share/keysmith/usage.jsonl` keeps working across
 * runs and month rollovers; when a new UTC month begins, the previous month's `usage.jsonl`
 * is rolled over to `usage.jsonl.YYYY-MM` and nothing is ever deleted.
 */

/**
 * Default price table (USD per 1,000,000 tokens: input, output, cacheRead, cacheWrite).
 * Read from Anthropic's pricing page on 2026-10-20, with cache writes at the 5-minute TTL
 * rate. Claude Haiku 5.5 uses its rate for prompts up to 100K tokens (prompts above 100K
 * are billed at 2x; a single per-token rate table approximates all Haiku 5.5 calls at <=100K).
 */
export const DEFAULT_PRICING = {
  '*/claude-opus-5-5*': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  '*/claude-sonnet-5-5*': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  '*/claude-haiku-5-5*': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export const USAGE_DIMENSIONS = ['key', 'label', 'adapter', 'model', 'account', 'tag', 'day', 'client'];
export const TAIL_RING_MAX = 2000;
export const TAIL_RING_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ADAPTERS_SEEN = 1000;

const TAG_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SAFE_SERVICE_RE = /^[A-Za-z0-9._@-]{1,128}$/;
const CHUNK_BYTES = 64 * 1024;
const MAX_DISTINCT_MODELS = 1000;
const MAX_DISTINCT_GROUPS = 5000;
const MAX_TABLE_GROUPS = 500;
const MAX_CELLS_PER_DAY = 2000;
const MAX_CELLS_PER_HOUR = 500;
const MAX_TOTAL_DAY_CELLS = 20_000;
const MAX_DAYS_IN_MEMORY = 400;
const MAX_HOURS_IN_MEMORY = 49;
const MAX_DIM_CHARS = 200;
const MAX_UNLOGGED_EVENTS = 2000;
const SPEND_RETRY_BACKOFF_MS = 5_000;

/**
 * Fixed log-spaced latency histogram upper bounds (ms): 1 ms resolution up to 100 ms, then 50
 * log-spaced buckets per decade up to 1,000,000 ms (~4.7% step width, with exact boundaries at
 * 100, 1,000, 10,000, 30,000, 60,000, 100,000 and 1,000,000 ms).
 */
export const LATENCY_BOUNDS = (() => {
  const set = new Set();
  for (let ms = 0; ms <= 100; ms++) set.add(ms);
  for (let k = 100; k <= 300; k++) set.add(Math.round(10 ** (k / 50)));
  set.add(30_000);
  set.add(60_000);
  return [...set].sort((a, b) => a - b);
})();

function histBucketIndex(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  let lo = 0;
  let hi = LATENCY_BOUNDS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (LATENCY_BOUNDS[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function histPercentile(hist, q) {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total === 0) return 0;
  const target = Math.max(1, Math.ceil(q * total));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return LATENCY_BOUNDS[i];
  }
  return LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1];
}

function capDim(val) {
  if (typeof val !== 'string') return val ?? null;
  if (val.length <= MAX_DIM_CHARS) return val;
  return `${val.slice(0, MAX_DIM_CHARS)}…[truncated]`;
}

/** Validate an `x-keysmith-tag` request header value; null when absent or invalid. */
export function parseTag(raw) {
  if (typeof raw !== 'string') return null;
  return TAG_RE.test(raw) ? raw : null;
}

/** The upstream host alone (no scheme, no path, no query) for an HTTP adapter's `baseUrl`. */
export function hostOf(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * Which credential an adapter spent — named from config only, never from CLI output or free
 * command text, and never valued:
 *  - explicit `cfg.account` -> that name
 *  - `{exec:security find-generic-password ... -s NAME ...}` -> `NAME`
 *  - `{env:NAME}`           -> `NAME`
 *  - `{file:PATH}`          -> `path.basename(PATH)`
 *  - any other `{...}` ref  -> `"exec"` with no text from it
 *  - literal key / none     -> `null`
 */
export function credentialAccount(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (typeof cfg.account === 'string' && cfg.account.trim()) return cfg.account.trim();
  const ref = cfg._rawKeyRef ?? cfg.apiKey ?? cfg.key ?? null;
  if (typeof ref === 'string') {
    const m = ref.match(/^\{(\w+):([\s\S]*)\}$/);
    if (m) {
      const [, kind, rawArg] = m;
      const arg = rawArg.trim();
      if (kind === 'env') return arg || null;
      if (kind === 'file') return path.basename(arg) || null;
      if (kind === 'exec') return execServiceName(arg);
      return 'exec';
    }
  }
  if (typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.trim()) return cfg.apiKeyEnv.trim();
  return null;
}

function execServiceName(cmd) {
  const trimmed = String(cmd || '').trim();
  const parts = trimmed.split(/\s+/);
  const bin = path.basename(parts[0] || '');
  if (bin === 'security' && parts[1] === 'find-generic-password') {
    const s = trimmed.match(/(?:^|\s)(?:-s|--service)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const name = s ? (s[1] || s[2] || s[3] || '').trim() : '';
    if (name && SAFE_SERVICE_RE.test(name)) return name;
  }
  return 'exec';
}

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function splitPricePattern(pattern) {
  const s = String(pattern || '').trim();
  const i = s.indexOf('/');
  if (i < 0) return ['*', s];
  return [s.slice(0, i) || '*', s.slice(i + 1) || '*'];
}

function sameDefaultRate(pattern, rates) {
  const def = DEFAULT_PRICING[pattern];
  if (!def || !rates || typeof rates !== 'object') return false;
  return (
    Number(def.input) === Number(rates.input) &&
    Number(def.output) === Number(rates.output) &&
    Number(def.cacheRead) === Number(rates.cacheRead) &&
    Number(def.cacheWrite) === Number(rates.cacheWrite)
  );
}

function patternScore(pattern, isCustom) {
  const [aGlob, mGlob] = splitPricePattern(pattern);
  const aExact = !aGlob.includes('*') ? 2 : aGlob === '*' ? 0 : 1;
  const mExact = !mGlob.includes('*') ? 2 : mGlob === '*' ? 0 : 1;
  const literalLen = (aGlob + mGlob).replace(/\*/g, '').length;
  return (isCustom ? 100_000 : 0) + aExact * 10_000 + mExact * 1_000 + literalLen;
}

function mergedPriceEntries(pricing) {
  const merged = { ...DEFAULT_PRICING, ...(pricing && typeof pricing === 'object' ? pricing : {}) };
  const list = [];
  for (const [pattern, rates] of Object.entries(merged)) {
    if (rates == null || rates === false) {
      list.push({ pattern, rates: null, score: patternScore(pattern, true) });
      continue;
    }
    if (typeof rates !== 'object' || Array.isArray(rates)) continue;
    const isCustom = !sameDefaultRate(pattern, rates);
    list.push({ pattern, rates, score: patternScore(pattern, isCustom) });
  }
  return list.sort((a, b) => b.score - a.score);
}

function splitTargetModel(model) {
  const s = String(model || '');
  const i = s.indexOf('/');
  return i < 0 ? { adapter: null, model: s } : { adapter: s.slice(0, i), model: s.slice(i + 1) };
}

/**
 * Find the price entry for `(adapter, model)`.
 * When `anyAdapter` is true (used to look up a CLI model's list price), if no entry matches
 * `adapter/model` directly, any entry whose model glob matches `model` is used.
 */
export function matchPrice(pricing, adapter, model, { upstreamModel = null, anyAdapter = false } = {}) {
  const parsed = splitTargetModel(model);
  const adapterId = adapter || parsed.adapter || '';
  const rawCandidates = [upstreamModel, parsed.model, String(model || '')].filter(Boolean);
  for (const c of [...rawCandidates]) {
    const lastSlash = c.lastIndexOf('/');
    if (lastSlash >= 0 && lastSlash + 1 < c.length) rawCandidates.push(c.slice(lastSlash + 1));
  }
  const candidates = [...new Set(rawCandidates)];
  const entries = mergedPriceEntries(pricing);

  for (const { pattern, rates } of entries) {
    const [aGlob, mGlob] = splitPricePattern(pattern);
    if (!globToRegExp(aGlob).test(adapterId)) continue;
    const mRe = globToRegExp(mGlob);
    if (candidates.some((c) => mRe.test(c))) return rates;
  }
  if (anyAdapter) {
    for (const { pattern, rates } of entries) {
      const [, mGlob] = splitPricePattern(pattern);
      const mRe = globToRegExp(mGlob);
      if (candidates.some((c) => mRe.test(c))) return rates;
    }
  }
  return null;
}

export function tokensToUsd(usage, rates) {
  if (!rates || typeof rates !== 'object') return 0;
  const u = usage || {};
  const cacheRead = Math.max(0, Number(u.cacheRead) || 0);
  const cacheWrite = Math.max(0, Number(u.cacheWrite) || 0);
  const uncachedInput = Math.max(0, (Number(u.input) || 0) - cacheRead - cacheWrite);
  const raw =
    (uncachedInput * (Number(rates.input) || 0) +
      (Number(u.output) || 0) * (Number(rates.output) || 0) +
      cacheRead * (Number(rates.cacheRead) || 0) +
      cacheWrite * (Number(rates.cacheWrite) || 0)) /
    1_000_000;
  return roundUsd(raw);
}

export function roundUsd(n) {
  return Math.round((Number(n) || 0) * 1e9) / 1e9;
}

export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'unreadable';
  const v = Number(n) || 0;
  const fixed6 = v.toFixed(6).replace(/0+$/, '');
  const [, dec = ''] = fixed6.split('.');
  return `$${dec.length <= 2 ? v.toFixed(2) : fixed6}`;
}

/**
 * Compute a usage line's `cost` field:
 *  - when token counts are unknown (`null` usage or `usageReason`): `{ usd: null, basis: "unpriced", reason? }`
 *  - `metered`      for a metered HTTP adapter matched by the price table: `{ usd, basis: "metered" }`
 *  - `subscription` for a CLI or subscription HTTP adapter (`usd: 0`), with `listUsd` when the
 *                   price table names a rate for that model: `{ usd: 0, basis: "subscription", listUsd? }`
 *  - `unpriced`     otherwise: `{ usd: 0, basis: "unpriced" }`
 */
export function computeCost(opts = {}) {
  const {
    usage = null,
    usageReason = null,
    reason = null,
    adapter = null,
    model = null,
    upstreamModel = null,
    kind = null,
    costBasis = null,
    pricing = null,
  } = opts || {};
  const isUnknown =
    Boolean(usageReason) ||
    Boolean(reason) ||
    ('usage' in (opts || {}) && opts.usage === null) ||
    Boolean(usage && typeof usage === 'object' && (usage.input === null || usage.output === null));
  if (isUnknown) {
    const why = usageReason ?? reason ?? usage?.reason ?? null;
    return { usd: null, basis: 'unpriced', ...(why ? { reason: String(why) } : {}) };
  }
  const basis = costBasis || (kind === 'cli' ? 'subscription' : kind === 'http' ? 'metered' : null);
  if (basis === 'subscription') {
    const rates = matchPrice(pricing, adapter, model, { upstreamModel, anyAdapter: true });
    return rates
      ? { usd: 0, basis: 'subscription', listUsd: tokensToUsd(usage, rates) }
      : { usd: 0, basis: 'subscription' };
  }
  if (basis === 'metered') {
    const rates = matchPrice(pricing, adapter, model, { upstreamModel, anyAdapter: false });
    if (rates) return { usd: tokensToUsd(usage, rates), basis: 'metered' };
  }
  return { usd: 0, basis: 'unpriced' };
}

function isRowUsageUnknown(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.status === 'limited' || e.status === 'denied' || e.scope === 'denied') return false;
  if (e.usageReason) return true;
  if (e.cost && e.cost.usd === null) return true;
  if ('usage' in e && e.usage === null) return true;
  if (e.usage && typeof e.usage === 'object' && (e.usage.input === null || e.usage.output === null)) return true;
  return false;
}

/** UTC month string (`YYYY-MM`) for a timestamp or Date. */
export function utcMonth(ts = new Date()) {
  const iso = typeof ts === 'string' ? ts : (ts instanceof Date ? ts : new Date(ts)).toISOString();
  return iso.slice(0, 7);
}

/** ISO timestamp (`YYYY-MM-01T00:00:00Z`) when the given UTC month (`YYYY-MM`) resets. */
export function nextMonthStartUtc(month) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    const now = new Date();
    const y = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const nextM = now.getUTCMonth() === 11 ? 1 : now.getUTCMonth() + 2;
    return `${String(y).padStart(4, '0')}-${String(nextM).padStart(2, '0')}-01T00:00:00Z`;
  }
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) {
    y += 1;
    mo = 1;
  }
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01T00:00:00Z`;
}

/**
 * Normalize `limits.spend` from config into `[{ kind: 'adapter'|'account'|'any', target, cap }]`.
 * Accepts flat `{ anthropic: 20, ANTHROPIC_API_KEY: 50 }`, prefixed `adapter:id` / `account:name`,
 * or nested `{ adapters: { ... }, accounts: { ... } }`. `null`, `false`, and `""` mean no cap.
 */
export function parseSpendCaps(spendCfg, adaptersCfg = null) {
  if (!spendCfg || typeof spendCfg !== 'object' || Array.isArray(spendCfg)) return [];
  const out = [];
  const addCap = (kind, target, raw) => {
    const val = typeof raw === 'object' && raw !== null ? (raw.usd ?? raw.cap ?? raw.limit) : raw;
    if (val == null || typeof val === 'boolean' || (typeof val === 'string' && !val.trim())) return;
    const cap = Number(val);
    if (!target || !Number.isFinite(cap) || cap < 0) return;
    out.push({ kind, target: String(target), cap });
  };
  for (const [k, v] of Object.entries(spendCfg)) {
    if ((k === 'adapters' || k === 'adapter' || k === 'byAdapter') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [id, cap] of Object.entries(v)) addCap('adapter', id.trim(), cap);
    } else if ((k === 'accounts' || k === 'account' || k === 'byAccount') && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [acct, cap] of Object.entries(v)) addCap('account', acct.trim(), cap);
    } else if (k.startsWith('adapter:')) {
      addCap('adapter', k.slice(8).trim(), v);
    } else if (k.startsWith('account:')) {
      addCap('account', k.slice(8).trim(), v);
    } else {
      const target = k.trim();
      const isKnownAdapter = !!(adaptersCfg && typeof adaptersCfg === 'object' && Object.hasOwn(adaptersCfg, target));
      addCap(isKnownAdapter ? 'adapter' : 'any', target, v);
    }
  }
  return out;
}

function redactDeep(v) {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) out[k] = redactDeep(val);
    }
    return out;
  }
  return v;
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export function parseBy(by) {
  if (by == null || by === '' || by === false) return ['model'];
  const raw = Array.isArray(by) ? by : [by];
  const dims = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`--by takes one or two of: ${USAGE_DIMENSIONS.join(', ')}`);
    for (const part of item.split(',')) {
      const d = part.trim();
      if (d && !dims.includes(d)) dims.push(d);
    }
  }
  if (!dims.length) return ['model'];
  if (dims.length > 2) throw new Error(`--by takes one or two dimensions (got ${dims.length}: ${dims.join(', ')})`);
  for (const d of dims) {
    if (!USAGE_DIMENSIONS.includes(d)) {
      throw new Error(`unknown --by dimension "${d}" — choose one or two of: ${USAGE_DIMENSIONS.join(', ')}`);
    }
  }
  return dims;
}

/**
 * Parse a `--since` or `--until` bound into epoch ms.
 * Dates (`YYYY-MM-DD`, `YYYY-MM`) are interpreted in UTC and are always inclusive:
 * `--since YYYY-MM-DD` starts at `00:00:00.000Z`, `--until YYYY-MM-DD` ends at `23:59:59.999Z`.
 */
export function parseTimeBound(raw, { isUntil = false, now = Date.now() } = {}) {
  if (raw == null || raw === '' || raw === false) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  const dur = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[unit];
    return now - n * mult;
  }
  if (MONTH_RE.test(s)) {
    if (!isUntil) return Date.parse(`${s}-01T00:00:00.000Z`);
    return Date.parse(nextMonthStartUtc(s)) - 1;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const start = Date.parse(`${s}T00:00:00.000Z`);
    if (Number.isNaN(start)) throw new Error(`invalid date "${s}"`);
    if (!isUntil) return start;
    return Date.parse(`${s}T23:59:59.999Z`);
  }
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid time bound "${s}" — use a date (YYYY-MM-DD, ISO-8601) or duration (e.g. 7d, 24h)`);
  }
  return parsed;
}

function dimensionValue(entry, dim) {
  switch (dim) {
    case 'key':
      return capDim(entry.key ?? null);
    case 'label':
      return capDim(entry.label ?? null);
    case 'adapter':
      return capDim(entry.adapter ?? splitTargetModel(entry.model).adapter ?? null);
    case 'model':
      return capDim(entry.model ?? null);
    case 'account':
      return capDim(entry.account ?? null);
    case 'tag':
      return capDim(entry.tag ?? null);
    case 'day':
      return typeof entry.ts === 'string' && entry.ts.length >= 10 ? entry.ts.slice(0, 10) : null;
    case 'client':
      return capDim(entry.client ?? null);
    default:
      return null;
  }
}

/**
 * Stream a file line by line in 64 KiB Buffer chunks, never reading the whole file into a single
 * string (avoiding V8's string-length limit on large monthly logs).
 */
function forEachLine(file, onLine, { startOffset = 0, onError = null } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${file}'`), { code: 'EISDIR' });
    }
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let pos = Math.max(0, startOffset);
    let carry = '';
    while (pos < st.size) {
      const toRead = Math.min(CHUNK_BYTES, st.size - pos);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const chunkStr = carry + decoder.write(buf.subarray(0, bytesRead));
      let start = 0;
      let nl = chunkStr.indexOf('\n', start);
      while (nl !== -1) {
        const line = chunkStr.slice(start, nl).trim();
        if (line && onLine(line) === false) {
          return { ok: true, ino: st.ino, size: pos, mtimeMs: st.mtimeMs, stopped: true };
        }
        start = nl + 1;
        nl = chunkStr.indexOf('\n', start);
      }
      carry = chunkStr.slice(start);
    }
    const tail = (carry + decoder.end()).trim();
    if (tail) onLine(tail);
    return { ok: true, ino: st.ino, size: pos, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, ino: 0, size: 0, mtimeMs: 0, missing: true };
    }
    onError?.(err, file);
    return { ok: false, error: err };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Walk a file's lines backwards from EOF in 64 KiB Buffer chunks. Stops immediately when
 * `onLine(line)` returns `false`.
 */
function readLinesReverse(file, onLine, { onError = null } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${file}'`), { code: 'EISDIR' });
    }
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = st.size;
    let remainder = Buffer.alloc(0);
    while (pos > 0) {
      const toRead = Math.min(CHUNK_BYTES, pos);
      pos -= toRead;
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      const combined = remainder.length
        ? Buffer.concat([buf.subarray(0, bytesRead), remainder])
        : Buffer.from(buf.subarray(0, bytesRead));
      let end = combined.length;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] === 0x0a) {
          if (end > i + 1) {
            const line = combined.subarray(i + 1, end).toString('utf8').trim();
            if (line && onLine(line) === false) return { ok: true };
          }
          end = i;
        }
      }
      remainder = combined.subarray(0, end);
    }
    if (remainder.length > 0) {
      const line = remainder.toString('utf8').trim();
      if (line) onLine(line);
    }
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true };
    onError?.(err, file);
    return { ok: false, error: err };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/** Append `srcFile` to `destFile` in 64 KiB chunks without loading `srcFile` into one string. */
function copyAppendSync(srcFile, destFile) {
  let rfd = null;
  let wfd = null;
  try {
    rfd = fs.openSync(srcFile, 'r');
    const st = fs.fstatSync(rfd);
    if (st.size === 0) return;
    wfd = openPrivateLog(destFile);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pos = 0;
    let lastByte = 0x0a;
    while (pos < st.size) {
      const n = fs.readSync(rfd, buf, 0, Math.min(CHUNK_BYTES, st.size - pos), pos);
      if (n <= 0) break;
      lastByte = buf[n - 1];
      fs.writeSync(wfd, buf, 0, n);
      pos += n;
    }
    if (lastByte !== 0x0a) fs.writeSync(wfd, '\n');
  } finally {
    if (rfd !== null) try { fs.closeSync(rfd); } catch {}
    if (wfd !== null) try { fs.closeSync(wfd); } catch {}
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function maxWidth(items, fn, min = 0) {
  let max = min;
  for (let i = 0; i < items.length; i++) {
    const w = fn(items[i]);
    if (w > max) max = w;
  }
  return max;
}

export class UsageLog {
  /** `now`: the clock a row's `ts` is read from (ms or Date), injectable for a test. */
  constructor(file = null, { pricing = null, now = null, log = null } = {}) {
    this.file = file || path.join(dataDir(), 'usage.jsonl');
    this.enabled = true;
    this.pricing = pricing;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.log = typeof log === 'function' ? log : null;
    this._currentMonth = null;
    this._spendState = null;
    this._dailyState = null;
    this._readErrors = new Map(); // file -> public message (no directory path or username)
    this._fileRanges = new Map(); // file -> { ino, size, firstMs, lastMs }
    this._dayAggregates = null; // Map<YYYY-MM-DD, { day, startMs, endMs, cells: Map }>
    this._hourAggregates = null; // Map<YYYY-MM-DDTHH, { hour, day, startMs, endMs, cells: Map }>
    this._dayFiles = new Map(); // file -> { ino, offset }
    this._totalDayCells = 0;
    this._daysEvicted = false;
    this._tailRing = null; // last TAIL_RING_MAX rows / TAIL_RING_MAX_BYTES bytes (oldest first)
    this._tailRingBytes = 0;
    this._tailFile = null; // { file, ino, offset }
    this._unloggedEvents = []; // timestamped unlogged refusals & failures (up to MAX_UNLOGGED_EVENTS)
  }

  _nowDate() {
    const d = this.now();
    return d instanceof Date ? d : new Date(d);
  }

  _monthOfFile(file, fallbackMonth = null) {
    const base = path.basename(this.file);
    const name = path.basename(file);
    if (name.startsWith(`${base}.`)) {
      const suffix = name.slice(base.length + 1);
      if (MONTH_RE.test(suffix)) return suffix;
    }
    const m = name.match(/(\d{4}-(?:0[1-9]|1[0-2]))/);
    if (m) return m[1];
    return fallbackMonth || this._currentMonth || utcMonth(this._nowDate());
  }

  _formatPublicReadError(err, file, fallbackMonth = null) {
    const m = this._monthOfFile(file, fallbackMonth);
    const reason = err?.code
      ? String(err.code)
      : err?.message === 'file contains no valid JSON lines'
        ? 'invalid JSON'
        : 'read_error';
    return `usage log ${path.basename(file)} (${m}) is unreadable (${reason})`;
  }

  _logReadError(err, file, fallbackMonth = null) {
    const m = this._monthOfFile(file, fallbackMonth);
    const detail = err?.code ? `${err.code}: ${err.message || err.code}` : String(err?.message || err);
    this.log?.(`usage: usage log ${file} (${m}) is unreadable: ${detail}`);
  }

  _noteReadError(err, file, fallbackMonth = null) {
    const msg = this._formatPublicReadError(err, file, fallbackMonth);
    const prev = this._readErrors.get(file);
    this._readErrors.set(file, msg);
    if (prev !== msg) this._logReadError(err, file, fallbackMonth);
    return msg;
  }

  _clearReadError(file) {
    this._readErrors.delete(file);
  }

  /**
   * Check every monthly usage log file for readability without parsing whole files: opens each
   * file and checks its first non-empty line (at most one 64 KiB chunk). Logs the full path to
   * the server's log and returns path-free public error strings for `doctor`, `status`, and `/status`.
   */
  checkReadable() {
    const currentFiles = new Set(this.files());
    for (const k of this._readErrors.keys()) {
      if (!currentFiles.has(k)) this._readErrors.delete(k);
    }
    for (const f of currentFiles) {
      const m = this._monthOfFile(f);
      let totalLines = 0;
      let validLines = 0;
      const res = forEachLine(
        f,
        (line) => {
          totalLines++;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              validLines++;
              return false;
            }
          } catch {}
          return false;
        },
        { onError: (err, file) => this._noteReadError(err, file, m) },
      );
      if (res.ok && !res.missing) {
        if (totalLines > 0 && validLines === 0) {
          this._noteReadError(new Error('file contains no valid JSON lines'), f, m);
        } else {
          this._clearReadError(f);
        }
      }
    }
    return [...this._readErrors.values()];
  }

  readErrors() {
    return [...this._readErrors.values()];
  }

  /**
   * Seed the in-memory month-to-date metered spend state when explicitly requested.
   */
  seedSpend({ log = null } = {}) {
    if (typeof log === 'function') this.log = log;
    this._ensureSpendMonth(utcMonth(this._nowDate()));
  }

  /**
   * Discover the UTC month (`YYYY-MM`) of `this.file` if it already exists on disk.
   */
  _detectFileMonth() {
    if (this._currentMonth) return this._currentMonth;
    if (!fs.existsSync(this.file)) return null;
    readLinesReverse(this.file, (line) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.ts === 'string' && MONTH_RE.test(parsed.ts.slice(0, 7))) {
          this._currentMonth = parsed.ts.slice(0, 7);
          return false;
        }
      } catch {}
      return true;
    });
    return this._currentMonth;
  }

  /**
   * Archive path for a closed UTC calendar month `YYYY-MM`: `usage.jsonl.YYYY-MM`.
   * The active month stays at `usage.jsonl` so `tail -F` on the documented path keeps working.
   */
  monthFile(month) {
    return `${this.file}.${month}`;
  }

  /**
   * Roll `this.file` over to `usage.jsonl.<prevMonth>` when a new UTC month starts.
   * Atomic rename (`fs.renameSync`) so the closed month is never duplicated even if the process
   * dies mid-turn, and `tail -F` on `usage.jsonl` follows the new file automatically.
   */
  _rollover(prevMonth, nextMonth) {
    const archive = this.monthFile(prevMonth);
    const prevRange = this._fileRanges.get(this.file);
    try {
      if (fs.existsSync(this.file)) {
        if (!fs.existsSync(archive)) {
          fs.renameSync(this.file, archive);
          if (prevRange) {
            this._fileRanges.set(archive, prevRange);
          }
        } else {
          copyAppendSync(this.file, archive);
          fs.unlinkSync(this.file);
          this._fileRanges.delete(archive);
        }
      }
    } catch {}
    this._fileRanges.delete(this.file);
    this._dayFiles.delete(this.file);
    this._currentMonth = nextMonth;
    this._spendState = this._emptySpendState(nextMonth);
  }

  _emptySpendState(month) {
    return {
      month,
      byAdapter: new Map(),
      byAccount: new Map(),
      byKeyAdapter: new Map(),
      byKeyAccount: new Map(),
      reservedByAdapter: new Map(),
      reservedByAccount: new Map(),
      adaptersSeen: new Set(),
      readError: null,
      retryAt: 0,
    };
  }

  _addMeteredSpend(state, { adapter, account, key, usd }) {
    if (!(usd > 0)) return;
    if (adapter) {
      const seenAdapter = typeof adapter === 'string' ? capDim(adapter) : null;
      if (seenAdapter && (state.adaptersSeen.has(seenAdapter) || state.adaptersSeen.size < MAX_ADAPTERS_SEEN)) {
        state.adaptersSeen.add(seenAdapter);
      }
      state.byAdapter.set(adapter, roundUsd((state.byAdapter.get(adapter) || 0) + usd));
    }
    if (account) {
      state.byAccount.set(account, roundUsd((state.byAccount.get(account) || 0) + usd));
    }
    if (typeof key === 'string' && key) {
      if (adapter) {
        let ka = state.byKeyAdapter.get(key);
        if (!ka) state.byKeyAdapter.set(key, (ka = new Map()));
        ka.set(adapter, roundUsd((ka.get(adapter) || 0) + usd));
      }
      if (account) {
        let kac = state.byKeyAccount.get(key);
        if (!kac) state.byKeyAccount.set(key, (kac = new Map()));
        kac.set(account, roundUsd((kac.get(account) || 0) + usd));
      }
    }
  }

  _addRowToSpendState(state, e) {
    if (!state || !e || typeof e.ts !== 'string' || e.ts.slice(0, 7) !== state.month) return;
    const rawAdapter = e.adapter ?? splitTargetModel(e.model).adapter;
    const seenAdapter = typeof rawAdapter === 'string' && rawAdapter ? capDim(rawAdapter) : null;
    if (seenAdapter && (state.adaptersSeen.has(seenAdapter) || state.adaptersSeen.size < MAX_ADAPTERS_SEEN)) {
      state.adaptersSeen.add(seenAdapter);
    }
    let failedMeteredUsd = 0;
    if (Array.isArray(e.failedLegs)) {
      for (const f of e.failedLegs) {
        const fAdapter = f?.adapter ?? splitTargetModel(f?.target).adapter;
        if (f?.cost?.basis === 'metered' && f.cost.usd > 0) {
          const fUsd = Number(f.cost.usd) || 0;
          failedMeteredUsd = roundUsd(failedMeteredUsd + fUsd);
          this._addMeteredSpend(state, {
            adapter: fAdapter,
            account: f.account || null,
            key: e.key,
            usd: fUsd,
          });
        }
      }
    }
    if (e.cost?.basis !== 'metered' || !(e.cost?.usd > 0)) return;
    const ownUsd = roundUsd(Math.max(0, (Number(e.cost.usd) || 0) - failedMeteredUsd));
    this._addMeteredSpend(state, {
      adapter: rawAdapter,
      account: e.account || null,
      key: e.key,
      usd: ownUsd,
    });
  }

  /**
   * Build or return the in-memory metered spend state for `month`.
   * Built lazily on first use and when the UTC month turns, and updated in memory on each
   * `record()`. Its error comes only from its own builds, and a failed build is retried on a
   * later check after `SPEND_RETRY_BACKOFF_MS` rather than held to the month turn.
   */
  _ensureSpendMonth(month = null) {
    const nowMs = this._nowDate().getTime();
    const m = month || utcMonth(nowMs);
    if (this._spendState && this._spendState.month === m) {
      if (!this._spendState.readError || nowMs < (this._spendState.retryAt || 0)) {
        return this._spendState;
      }
    }
    const state = this._emptySpendState(m);
    const candidates = [];
    const archived = this.monthFile(m);
    if (fs.existsSync(archived)) candidates.push(archived);
    if (fs.existsSync(this.file)) candidates.push(this.file);

    for (const f of candidates) {
      let totalLines = 0;
      let validLines = 0;
      let firstMs = null;
      let lastMs = null;
      const res = forEachLine(
        f,
        (line) => {
          totalLines++;
          try {
            const e = JSON.parse(line);
            if (e && typeof e === 'object' && !Array.isArray(e)) {
              validLines++;
              const t = Date.parse(e.ts || '');
              if (Number.isFinite(t)) {
                if (firstMs == null || t < firstMs) firstMs = t;
                if (lastMs == null || t > lastMs) lastMs = t;
              }
              this._addRowToSpendState(state, e);
            }
          } catch {}
        },
        {
          onError: (err, file) => {
            state.readError = this._noteReadError(err, file, m);
            state.retryAt = nowMs + SPEND_RETRY_BACKOFF_MS;
          },
        },
      );
      if (res.ok && !res.missing) {
        if (totalLines > 0 && validLines === 0) {
          state.readError = this._noteReadError(new Error('file contains no valid JSON lines'), f, m);
          state.retryAt = nowMs + SPEND_RETRY_BACKOFF_MS;
        } else {
          this._clearReadError(f);
          if (firstMs != null && lastMs != null) {
            this._fileRanges.set(f, { ino: res.ino, size: res.size, firstMs, lastMs });
          }
        }
      }
    }

    this._spendState = state;
    return state;
  }

  _dailySidecarFile() {
    return path.join(path.dirname(this.file), `.${path.basename(this.file)}.daily`);
  }

  _readDailySidecar(day = null) {
    const p = this._dailySidecarFile();
    try {
      if (!fs.existsSync(p)) return null;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      if (day !== null && parsed.day !== day) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  _writeDailySidecar(state) {
    const p = this._dailySidecarFile();
    try {
      const fd = openPrivateLog(p);
      try {
        const payload = JSON.stringify({
          day: state.day,
          utcDay: state.utcDay,
          counts: Object.fromEntries(state.counts),
          refused: Object.fromEntries(state.refused),
          unloggedFailures: Object.fromEntries(state.unloggedFailures),
          labels: Object.fromEntries(state.labels),
          events: this._unloggedEvents,
        }) + '\n';
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, payload, 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
  }

  _recordUnloggedEvent({ ts, key, label = null, tag = null, client = null, status = 'limited', count = 1 }) {
    const n = Math.max(1, Number(count) || 1);
    const k = capDim(key);
    const lbl = capDim(label);
    const tg = capDim(tag);
    const cl = capDim(client);
    const hour = typeof ts === 'string' ? ts.slice(0, 13) : '';
    let target = null;
    const last = this._unloggedEvents.length ? this._unloggedEvents[this._unloggedEvents.length - 1] : null;
    if (
      last &&
      last.key === k &&
      (last.label ?? null) === (lbl ?? null) &&
      (last.tag ?? null) === (tg ?? null) &&
      (last.client ?? null) === (cl ?? null) &&
      last.status === status &&
      (last.ts === ts || (this._unloggedEvents.length >= MAX_UNLOGGED_EVENTS && typeof last.ts === 'string' && last.ts.slice(0, 13) === hour))
    ) {
      target = last;
      target.count += n;
    } else if (this._unloggedEvents.length >= MAX_UNLOGGED_EVENTS) {
      target = this._unloggedEvents.find(
        (ev) =>
          typeof ev.ts === 'string' &&
          ev.ts.slice(0, 13) === hour &&
          ev.key === k &&
          (ev.label ?? null) === (lbl ?? null) &&
          (ev.tag ?? null) === (tg ?? null) &&
          (ev.client ?? null) === (cl ?? null) &&
          ev.status === status,
      );
      if (target) {
        target.count += n;
      }
    }
    if (!target) {
      if (this._unloggedEvents.length >= MAX_UNLOGGED_EVENTS) {
        this._unloggedEvents.shift();
      }
      target = {
        id: `${ts}|${k}|${status}|${this._unloggedEvents.length}`,
        ts,
        key: k,
        ...(lbl ? { label: lbl } : {}),
        adapter: null,
        model: null,
        account: null,
        ...(tg ? { tag: tg } : {}),
        ...(cl ? { client: cl } : {}),
        status,
        ms: 0,
        count: n,
      };
      Object.defineProperty(target, '_appliedCount', { value: 0, writable: true, enumerable: false, configurable: true });
      this._unloggedEvents.push(target);
    }
    if (this._dayAggregates) {
      this._addRowToDayAggregates(target, n);
      target._appliedCount = (target._appliedCount || 0) + n;
    }
  }

  _syncSidecarUnloggedEvents(sidecar = null) {
    const parsed = sidecar || this._readDailySidecar(null);
    if (parsed && Array.isArray(parsed.events)) {
      for (const raw of parsed.events) {
        if (!raw || typeof raw !== 'object' || typeof raw.ts !== 'string' || typeof raw.key !== 'string') continue;
        const count = Math.max(1, Number(raw.count) || 1);
        const existing = raw.id ? this._unloggedEvents.find((e) => e.id === raw.id) : null;
        if (existing) {
          if (count > existing.count) existing.count = count;
        } else {
          if (this._unloggedEvents.length >= MAX_UNLOGGED_EVENTS) this._unloggedEvents.shift();
          const clone = { ...raw, count };
          Object.defineProperty(clone, '_appliedCount', { value: 0, writable: true, enumerable: false, configurable: true });
          this._unloggedEvents.push(clone);
        }
      }
    }
    if (this._dayAggregates) {
      for (const ev of this._unloggedEvents) {
        const delta = (ev.count || 0) - (ev._appliedCount || 0);
        if (delta > 0) {
          this._addRowToDayAggregates(ev, delta);
          ev._appliedCount = ev.count;
        }
      }
    }
  }

  /**
   * Record a key's live daily request and refusal counts from `DailyQuota` as they happen
   * (including the 2nd..Nth refusal of the day that leaves no JSONL row, and admitted requests
   * before their body is read), so `/status`, `/v1/keysmith/usage`, and `keysmith usage` show
   * the same numbers everywhere.
   */
  noteDaily(fp, todayCounts, now = null, { label = null, client = null, tag = null, extraRefusal = null } = {}) {
    if (!fp || !todayCounts) return;
    const nowMs = now != null ? (now instanceof Date ? now.getTime() : Number(now)) : this._nowDate().getTime();
    const state = this._ensureDailyState(nowMs);
    state.fromQuota = true;
    if (typeof label === 'string' && label) state.labels.set(fp, label);
    const reqs = Number(todayCounts.requests) || 0;
    const refs = Number(todayCounts.refused) || 0;
    const prevRefs = state.refused.get(fp) || 0;
    state.counts.set(fp, Math.max(state.counts.get(fp) || 0, reqs));
    state.refused.set(fp, Math.max(prevRefs, refs));
    let deltaRefused = 0;
    if (extraRefusal === true) {
      deltaRefused = Math.max(1, refs - prevRefs);
    } else if (extraRefusal === null) {
      const accounted = (state.rowRefused.get(fp) || 0) + (state.extraRefusedByFp.get(fp) || 0);
      deltaRefused = Math.max(0, refs - accounted);
    }
    if (deltaRefused > 0) {
      state.extraRefusedByFp.set(fp, (state.extraRefusedByFp.get(fp) || 0) + deltaRefused);
      this._recordUnloggedEvent({
        ts: new Date(nowMs).toISOString(),
        key: `fp:${fp}`,
        label: label || state.labels.get(fp) || null,
        tag,
        client,
        status: 'limited',
        count: deltaRefused,
      });
    }
    this._writeDailySidecar(state);
  }

  /**
   * Record an admitted metered request that failed before `track()` could write a JSONL row
   * (e.g. a malformed JSON body or invalid query parameter), so `groups` and `daily` report
   * the same count.
   */
  noteUnloggedFailure(fp, now = null, { label = null, client = null, tag = null } = {}) {
    if (!fp) return;
    const nowMs = now != null ? (now instanceof Date ? now.getTime() : Number(now)) : this._nowDate().getTime();
    const state = this._ensureDailyState(nowMs);
    if (typeof label === 'string' && label) state.labels.set(fp, label);
    state.unloggedFailures.set(fp, (state.unloggedFailures.get(fp) || 0) + 1);
    this._recordUnloggedEvent({
      ts: new Date(nowMs).toISOString(),
      key: `fp:${fp}`,
      label: label || state.labels.get(fp) || null,
      tag,
      client,
      status: 'error',
      count: 1,
    });
    this._writeDailySidecar(state);
  }

  _ensureDailyState(nowMs) {
    const day = dayOf(nowMs);
    const utcDay = new Date(nowMs).toISOString().slice(0, 10);
    if (!this._dailyState || this._dailyState.day !== day) {
      const state = {
        day,
        utcDay,
        startMs: startOfDay(nowMs),
        counts: new Map(),
        refused: new Map(),
        rowCounts: new Map(),
        rowRefused: new Map(),
        extraRefusedByFp: new Map(),
        unloggedFailures: new Map(),
        labels: new Map(),
        fromQuota: false,
      };
      for (const row of this.rowsSince(state.startMs)) {
        this._addRowToDailyState(state, row);
      }
      this._dailyState = state;
    } else {
      this._dailyState.utcDay = utcDay;
    }
    const sidecar = this._readDailySidecar(day);
    if (sidecar) {
      this._dailyState.fromQuota = true;
      if (sidecar.counts && typeof sidecar.counts === 'object') {
        for (const [fp, n] of Object.entries(sidecar.counts)) {
          if (typeof n === 'number' && Number.isFinite(n)) {
            this._dailyState.counts.set(fp, Math.max(this._dailyState.counts.get(fp) || 0, n));
          }
        }
      }
      if (sidecar.refused && typeof sidecar.refused === 'object') {
        for (const [fp, n] of Object.entries(sidecar.refused)) {
          if (typeof n === 'number' && Number.isFinite(n)) {
            this._dailyState.refused.set(fp, Math.max(this._dailyState.refused.get(fp) || 0, n));
          }
        }
      }
      if (sidecar.unloggedFailures && typeof sidecar.unloggedFailures === 'object') {
        for (const [fp, n] of Object.entries(sidecar.unloggedFailures)) {
          if (typeof n === 'number' && Number.isFinite(n)) {
            this._dailyState.unloggedFailures.set(fp, Math.max(this._dailyState.unloggedFailures.get(fp) || 0, n));
          }
        }
      }
      if (sidecar.labels && typeof sidecar.labels === 'object') {
        for (const [fp, lbl] of Object.entries(sidecar.labels)) {
          if (typeof lbl === 'string' && lbl && !this._dailyState.labels.has(fp)) {
            this._dailyState.labels.set(fp, lbl);
          }
        }
      }
      this._syncSidecarUnloggedEvents(sidecar);
    }
    return this._dailyState;
  }

  _addRowToDailyState(state, row) {
    if (!state || typeof row?.key !== 'string' || !row.key.startsWith('fp:')) return;
    const t = Date.parse(row.ts || '');
    if (Number.isFinite(t) && t < state.startMs) return;
    const fp = row.key.slice(3);
    if (typeof row.label === 'string' && row.label) state.labels.set(fp, row.label);
    if (row.status === 'limited') {
      state.rowRefused.set(fp, (state.rowRefused.get(fp) || 0) + 1);
      if (!state.fromQuota) state.refused.set(fp, (state.refused.get(fp) || 0) + 1);
    } else {
      state.rowCounts.set(fp, (state.rowCounts.get(fp) || 0) + 1);
      if (!state.fromQuota) state.counts.set(fp, (state.counts.get(fp) || 0) + 1);
    }
  }

  _noteFileTimestamp(file, rowMs, st = null) {
    if (!Number.isFinite(rowMs)) return;
    const stat = st || safeStat(file);
    if (!stat) return;
    const prev = this._fileRanges.get(file);
    if (prev && prev.ino === stat.ino) {
      prev.size = stat.size;
      prev.firstMs = prev.firstMs == null ? rowMs : Math.min(prev.firstMs, rowMs);
      prev.lastMs = prev.lastMs == null ? rowMs : Math.max(prev.lastMs, rowMs);
    } else {
      this._fileRanges.set(file, { ino: stat.ino, size: stat.size, firstMs: rowMs, lastMs: rowMs });
    }
  }

  record(entry) {
    try {
      const ts = typeof entry?.ts === 'string' && entry.ts ? entry.ts : this._nowDate().toISOString();
      const month = utcMonth(ts);
      const withCost = { ...entry };
      const ownUsage = withCost._ownUsage !== undefined ? withCost._ownUsage : withCost.usage;
      const isUnknown =
        isRowUsageUnknown(withCost) ||
        Boolean(ownUsage && typeof ownUsage === 'object' && (ownUsage.input === null || ownUsage.output === null || ownUsage.reason));
      if (isUnknown && !withCost.failedLegs?.some((f) => f?.usage)) {
        withCost.usage = null;
      }
      delete withCost._leg;
      delete withCost._ownUsage;
      if (!withCost.cost && (withCost.kind || withCost.adapter || withCost.model)) {
        withCost.cost = computeCost({
          usage: isUnknown ? null : (ownUsage ?? { input: 0, output: 0 }),
          usageReason: withCost.usageReason || ownUsage?.reason || null,
          adapter: withCost.adapter,
          model: withCost.model,
          upstreamModel: entry?._leg?.upstreamModel || entry?._leg?.model || null,
          kind: withCost.kind,
          costBasis: entry?._leg?.costBasis || null,
          pricing: this.pricing,
        });
      }
      const clean = redactDeep({ ts, ...withCost });
      const line = redactSecrets(JSON.stringify(clean)) + '\n';

      const curMonth = this._detectFileMonth();
      let targetFile = this.file;
      if (!curMonth) {
        this._currentMonth = month;
        if (!this._spendState) this._spendState = this._emptySpendState(month);
      } else if (month > curMonth) {
        this._rollover(curMonth, month);
      } else if (month < curMonth) {
        targetFile = this.monthFile(month);
      }

      const fd = openPrivateLog(targetFile);
      let st = null;
      try {
        fs.writeSync(fd, line);
        try { st = fs.fstatSync(fd); } catch {}
      } finally {
        fs.closeSync(fd);
      }

      const rowMs = Date.parse(ts);
      this._noteFileTimestamp(targetFile, rowMs, st);

      if (this._spendState && this._spendState.month === month && !this._spendState.readError) {
        this._addRowToSpendState(this._spendState, clean);
      }
      if (this._dailyState && Number.isFinite(rowMs) && dayOf(rowMs) === this._dailyState.day) {
        this._addRowToDailyState(this._dailyState, clean);
      }
      if (this._dayAggregates) {
        this._addRowToDayAggregates(clean);
        if (st) this._dayFiles.set(targetFile, { ino: st.ino, offset: st.size });
      }
      if (this._tailRing) {
        this._pushTailRing(clean, Buffer.byteLength(line, 'utf8'));
        if (st && targetFile === this.file) {
          this._tailFile = { file: this.file, ino: st.ino, offset: st.size };
        }
      }
    } catch {
      // Usage logging must never break a completion.
    }
  }

  /**
   * Every log file across all recorded months, oldest month first, ending with `this.file`.
   */
  files() {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    if (!fs.existsSync(dir)) return fs.existsSync(this.file) ? [this.file] : [];
    const monthly = [];
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return fs.existsSync(this.file) ? [this.file] : [];
    }
    const dotPrefix = `${base}.`;
    const dashRe = new RegExp(`^${stem.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}[.-](\\d{4}-(?:0[1-9]|1[0-2]))${ext.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`);
    for (const name of names) {
      if (name === base || name.startsWith('.')) continue;
      let m = null;
      if (name.startsWith(dotPrefix)) {
        const suffix = name.slice(dotPrefix.length);
        if (MONTH_RE.test(suffix)) m = suffix;
      } else {
        const match = name.match(dashRe);
        if (match) m = match[1];
      }
      if (m) monthly.push({ month: m, file: path.join(dir, name) });
    }
    monthly.sort((a, b) => a.month.localeCompare(b.month) || a.file.localeCompare(b.file));
    const result = monthly.map((x) => x.file);
    if (fs.existsSync(this.file)) result.push(this.file);
    return result;
  }

  /**
   * First and last row timestamp (`firstMs`, `lastMs`) of `file`, learned once from the file's
   * head and tail (one 64 KiB chunk each) and cached in memory by `(ino, size)`. Never trusts the
   * file's name for its time range, so an upgraded single-file log that rolled over with several
   * months inside it is still chosen for every month it holds.
   */
  _fileRange(file) {
    const st = safeStat(file);
    if (!st || st.isDirectory() || st.size === 0) {
      return { ino: st?.ino || 0, size: 0, firstMs: null, lastMs: null };
    }
    const cached = this._fileRanges.get(file);
    if (cached && cached.ino === st.ino && cached.size === st.size) {
      return cached;
    }
    let firstMs = cached && cached.ino === st.ino && cached.size <= st.size ? cached.firstMs : null;
    let lastMs = null;
    if (firstMs == null) {
      forEachLine(file, (line) => {
        try {
          const t = Date.parse(JSON.parse(line)?.ts || '');
          if (Number.isFinite(t)) {
            firstMs = t;
            return false;
          }
        } catch {}
        return true;
      });
    }
    readLinesReverse(file, (line) => {
      try {
        const t = Date.parse(JSON.parse(line)?.ts || '');
        if (Number.isFinite(t)) {
          lastMs = t;
          return false;
        }
      } catch {}
      return true;
    });
    if (firstMs != null && lastMs != null && firstMs > lastMs) {
      const tmp = firstMs;
      firstMs = lastMs;
      lastMs = tmp;
    }
    const entry = { ino: st.ino, size: st.size, firstMs, lastMs };
    this._fileRanges.set(file, entry);
    return entry;
  }

  /**
   * Read the whole log across every calendar month, in chronological order (streamed line by line).
   */
  readAll(filter = null) {
    const out = [];
    for (const f of this.files()) {
      forEachLine(
        f,
        (line) => {
          try {
            const e = JSON.parse(line);
            if (!filter || filter(e)) out.push(e);
          } catch {}
        },
        { onError: (err, file) => this._logReadError(err, file) },
      );
    }
    out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
    return out;
  }

  _pushTailRing(e, rawBytes = null) {
    if (!this._tailRing) return;
    const bytes = rawBytes != null ? rawBytes : Buffer.byteLength(JSON.stringify(e), 'utf8') + 1;
    Object.defineProperty(e, '_bytes', { value: bytes, enumerable: false, configurable: true });
    this._tailRing.push(e);
    this._tailRingBytes += bytes;
    while (this._tailRing.length > TAIL_RING_MAX || (this._tailRingBytes > TAIL_RING_MAX_BYTES && this._tailRing.length > 1)) {
      const removed = this._tailRing.shift();
      this._tailRingBytes = Math.max(0, this._tailRingBytes - (removed?._bytes || 0));
    }
  }

  _ensureTailRing() {
    if (!this._tailRing) {
      const allFiles = this.files();
      const newestFirst = [];
      let totalBytes = 0;
      for (let i = allFiles.length - 1; i >= 0 && newestFirst.length < TAIL_RING_MAX && totalBytes < TAIL_RING_MAX_BYTES; i--) {
        readLinesReverse(
          allFiles[i],
          (line) => {
            try {
              const e = JSON.parse(line);
              if (e && typeof e === 'object' && !Array.isArray(e)) {
                const bytes = Buffer.byteLength(line, 'utf8') + 1;
                if (newestFirst.length > 0 && totalBytes + bytes > TAIL_RING_MAX_BYTES) return false;
                Object.defineProperty(e, '_bytes', { value: bytes, enumerable: false, configurable: true });
                newestFirst.push(e);
                totalBytes += bytes;
                if (newestFirst.length >= TAIL_RING_MAX || totalBytes >= TAIL_RING_MAX_BYTES) return false;
              }
            } catch {}
            return true;
          },
          { onError: (err, f) => this._logReadError(err, f) },
        );
      }
      this._tailRing = newestFirst.reverse();
      this._tailRingBytes = totalBytes;
      const st = safeStat(this.file);
      this._tailFile = st && !st.isDirectory() ? { file: this.file, ino: st.ino, offset: st.size } : null;
      return this._tailRing;
    }

    const st = safeStat(this.file);
    if (st && !st.isDirectory()) {
      const prev = this._tailFile;
      if (!prev || prev.ino !== st.ino || st.size > prev.offset) {
        const startOffset = prev && prev.ino === st.ino && st.size >= prev.offset ? prev.offset : 0;
        const res = forEachLine(
          this.file,
          (line) => {
            try {
              const e = JSON.parse(line);
              if (e && typeof e === 'object' && !Array.isArray(e)) {
                this._pushTailRing(e, Buffer.byteLength(line, 'utf8') + 1);
              }
            } catch {}
          },
          { startOffset, onError: (err, f) => this._logReadError(err, f) },
        );
        if (res.ok && !res.missing) {
          this._tailFile = { file: this.file, ino: res.ino, offset: res.size };
        }
      }
    }
    return this._tailRing;
  }

  /**
   * Last `n` matching entries from the bounded in-memory ring (`TAIL_RING_MAX` = 2,000), newest
   * first, filled lazily once on first use and updated as each line is written.
   */
  tail(n = TAIL_RING_MAX, filter = null) {
    const limit = Math.max(0, Math.min(Number(n) || 0, TAIL_RING_MAX));
    if (!limit) return [];
    const ring = this._ensureTailRing();
    const out = [];
    for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = ring[i];
      if (!filter || filter(e)) {
        out.push(e);
      }
    }
    return out;
  }

  /**
   * Every row written at or after `since` (ms), oldest first — what the daily caps rebuild their
   * counts from at start (quota.js). Walks backwards in 64 KiB chunks from the end of `usage.jsonl`
   * into any archive whose recorded `[firstMs, lastMs]` range overlaps `since`, stopping at the
   * first older row.
   */
  rowsSince(since) {
    const allFiles = this.files();
    if (!allFiles.length) return [];
    const rows = [];
    for (let fIdx = allFiles.length - 1; fIdx >= 0; fIdx--) {
      const f = allFiles[fIdx];
      const range = this._fileRange(f);
      if (range.size === 0) continue;
      if (Number.isFinite(since) && range.lastMs != null && range.lastMs < since) continue;
      readLinesReverse(
        f,
        (line) => {
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            return true;
          }
          const t = Date.parse(e?.ts || '');
          if (!Number.isFinite(t)) return true;
          if (t < since) {
            return false;
          }
          rows.push(e);
          return true;
        },
        { onError: (err, file) => this._logReadError(err, file) },
      );
    }
    return rows.reverse();
  }

  /**
   * Recorded metered spend (USD) in a UTC calendar month (`YYYY-MM`) for an adapter, an
   * account, or either (`target`), read from the in-memory month state.
   */
  spendFor({ adapter = null, account = null, target = null, key = null, month = null } = {}) {
    const m = month || utcMonth(this._nowDate());
    const state = this._ensureSpendMonth(m);
    if (state.readError) return Number.POSITIVE_INFINITY;
    if (key) {
      if (adapter) return state.byKeyAdapter.get(key)?.get(adapter) || 0;
      if (account) return state.byKeyAccount.get(key)?.get(account) || 0;
      if (target) {
        return roundUsd((state.byKeyAdapter.get(key)?.get(target) || 0) + (state.byKeyAccount.get(key)?.get(target) || 0));
      }
      return 0;
    }
    if (adapter) return state.byAdapter.get(adapter) || 0;
    if (account) return state.byAccount.get(account) || 0;
    if (target) return roundUsd((state.byAdapter.get(target) || 0) + (state.byAccount.get(target) || 0));
    let total = 0;
    for (const v of state.byAdapter.values()) total += v;
    return roundUsd(total);
  }

  /**
   * Check whether `adapter` (`{ id, account }`) has reached any configured monthly spend cap
   * in `spendCfg`. Reads the in-memory month spend; fails closed when the month's log is unreadable.
   */
  checkSpendCap(spendCfg, adapter, { adaptersCfg = null, month = null } = {}) {
    if (!spendCfg || !adapter) return null;
    const caps = parseSpendCaps(spendCfg, adaptersCfg);
    if (!caps.length) return null;
    const m = month || utcMonth(this._nowDate());
    const resetAt = nextMonthStartUtc(m);
    const adapterId = adapter.id || adapter.adapter || null;
    const account = adapter.account || null;
    const state = this._ensureSpendMonth(m);

    for (const c of caps) {
      let matches = false;
      let kind = c.kind;
      if (c.kind === 'adapter' && adapterId && c.target === adapterId) {
        matches = true;
      } else if (c.kind === 'account' && account && c.target === account) {
        matches = true;
      } else if (c.kind === 'any') {
        if (adapterId && c.target === adapterId) {
          matches = true;
          kind = 'adapter';
        } else if (account && c.target === account) {
          matches = true;
          kind = 'account';
        }
      }
      if (!matches) continue;
      if (state.readError) {
        return {
          kind,
          target: c.target,
          cap: c.cap,
          spent: null,
          error: state.readError,
          retryAfter: Math.max(1, Math.ceil(SPEND_RETRY_BACKOFF_MS / 1000)),
          month: m,
          resetAt,
        };
      }
      const spent =
        kind === 'adapter'
          ? state.byAdapter.get(c.target) || 0
          : kind === 'account'
            ? state.byAccount.get(c.target) || 0
            : roundUsd((state.byAdapter.get(c.target) || 0) + (state.byAccount.get(c.target) || 0));
      const reserved =
        kind === 'adapter'
          ? state.reservedByAdapter.get(c.target) || 0
          : kind === 'account'
            ? state.reservedByAccount.get(c.target) || 0
            : roundUsd((state.reservedByAdapter.get(c.target) || 0) + (state.reservedByAccount.get(c.target) || 0));
      const effective = roundUsd(spent + reserved);
      if (Math.round(effective * 1e9) >= Math.round(c.cap * 1e9)) {
        return { kind, target: c.target, cap: c.cap, spent: effective, month: m, resetAt };
      }
    }
    return null;
  }

  /**
   * Reserve estimated in-flight metered spend for `adapter` (`{ id, account, kind, costBasis }`)
   * while a request is executing so concurrent requests cannot overshoot `limits.spend`.
   * Returns an idempotent `release()` function to call in `finally`.
   */
  reserveSpend(spendCfg, adapter, { adaptersCfg = null, model = null, upstreamModel = null, inputTokens = 1, outputTokens = 256, month = null } = {}) {
    if (!spendCfg || !adapter) return () => {};
    if (adapter.costBasis === 'subscription') return () => {};
    const caps = parseSpendCaps(spendCfg, adaptersCfg);
    if (!caps.length) return () => {};
    const m = month || utcMonth(this._nowDate());
    const state = this._ensureSpendMonth(m);
    if (state.readError) return () => {};
    const adapterId = adapter.id || adapter.adapter || null;
    const account = adapter.account || null;
    const rates = matchPrice(this.pricing, adapterId, model, { upstreamModel, anyAdapter: false });
    const estIn = Number.isFinite(Number(inputTokens)) && Number(inputTokens) >= 0 ? Math.max(1, Number(inputTokens)) : 1;
    const estOut = Number.isFinite(Number(outputTokens)) && Number(outputTokens) >= 0 ? Number(outputTokens) : 256;
    const est = rates
      ? Math.max(tokensToUsd({ input: estIn, output: estOut }, rates), 1e-6)
      : 0;
    if (!(est > 0)) return () => {};
    if (adapterId) {
      state.reservedByAdapter.set(adapterId, roundUsd((state.reservedByAdapter.get(adapterId) || 0) + est));
    }
    if (account) {
      state.reservedByAccount.set(account, roundUsd((state.reservedByAccount.get(account) || 0) + est));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (adapterId) {
        const next = roundUsd((state.reservedByAdapter.get(adapterId) || 0) - est);
        if (next > 0) state.reservedByAdapter.set(adapterId, next);
        else state.reservedByAdapter.delete(adapterId);
      }
      if (account) {
        const next = roundUsd((state.reservedByAccount.get(account) || 0) - est);
        if (next > 0) state.reservedByAccount.set(account, next);
        else state.reservedByAccount.delete(account);
      }
    };
  }

  /**
   * Status of every configured spend cap for the current UTC month, taken from the in-memory
   * month spend state. For a scoped key (`callerKey`), reports only `exceeded` and its own
   * `spent` — never totals or remaining across keys.
   */
  spendSummary(spendCfg, { adapters = null, month = null, callerKey = null } = {}) {
    const caps = parseSpendCaps(spendCfg, adapters);
    if (!caps.length) return [];
    const m = month || utcMonth(this._nowDate());
    const resetAt = nextMonthStartUtc(m);
    const state = this._ensureSpendMonth(m);

    return caps.map((c) => {
      let kind = c.kind;
      if (kind === 'any') {
        const isAdapter = (adapters && Object.hasOwn(adapters, c.target)) || state.adaptersSeen.has(capDim(c.target));
        kind = isAdapter ? 'adapter' : 'account';
      }
      if (state.readError) {
        if (callerKey) {
          return {
            kind,
            target: c.target,
            spent: null,
            cap: c.cap,
            exceeded: true,
            error: state.readError,
            month: m,
            resetAt,
          };
        }
        return {
          kind,
          target: c.target,
          spent: null,
          cap: c.cap,
          remaining: 0,
          exceeded: true,
          error: state.readError,
          month: m,
          resetAt,
        };
      }
      const totalSpent =
        kind === 'adapter' ? state.byAdapter.get(c.target) || 0 : state.byAccount.get(c.target) || 0;
      const exceeded = Math.round(totalSpent * 1e9) >= Math.round(c.cap * 1e9);
      if (callerKey) {
        const ownSpent =
          kind === 'adapter'
            ? state.byKeyAdapter.get(callerKey)?.get(c.target) || 0
            : state.byKeyAccount.get(callerKey)?.get(c.target) || 0;
        return {
          kind,
          target: c.target,
          spent: ownSpent,
          cap: c.cap,
          exceeded,
          month: m,
          resetAt,
        };
      }
      const remaining = roundUsd(Math.max(0, c.cap - totalSpent));
      return {
        kind,
        target: c.target,
        spent: totalSpent,
        cap: c.cap,
        remaining,
        exceeded,
        month: m,
        resetAt,
      };
    });
  }

  /**
   * Status of every configured per-key daily request cap (`perDay` on `auth.keys` entries)
   * for the current local calendar day, counted consistently across `/status`, `/v1/keysmith/usage`,
   * and `keysmith usage`.
   */
  dailySummary(keys = [], { who = null, quota = null, now = null } = {}) {
    if (!Array.isArray(keys) || !keys.length) return [];
    const capped = [];
    for (const item of keys) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (!Number.isSafeInteger(item.perDay) || item.perDay < 0) continue;
      const fp = typeof item.fp === 'string' && item.fp ? item.fp : typeof item.key === 'string' && item.key ? fingerprint(item.key) : null;
      if (!fp) continue;
      if (who?.scope && who.fp && fp !== who.fp) continue;
      capped.push({ fp, label: typeof item.label === 'string' && item.label ? item.label : null, perDay: item.perDay });
    }
    if (!capped.length) return [];

    const nowMs = now != null ? (now instanceof Date ? now.getTime() : Number(now)) : this._nowDate().getTime();
    const day = dayOf(nowMs);
    const resetAt = new Date(nextMidnight(nowMs)).toISOString();
    const state = this._ensureDailyState(nowMs);

    return capped.map((c) => {
      const qToday = quota ? quota.today(c.fp) : null;
      const requests = Math.max(state.counts.get(c.fp) || 0, qToday?.requests || 0);
      const refused = Math.max(state.refused.get(c.fp) || 0, qToday?.refused || 0);
      return {
        key: `fp:${c.fp}`,
        fp: c.fp,
        ...(c.label ? { label: c.label } : {}),
        requests,
        cap: c.perDay,
        perDay: c.perDay,
        remaining: Math.max(0, c.perDay - requests),
        refused,
        exceeded: requests >= c.perDay,
        day,
        resetAt,
      };
    });
  }

  _candidateFiles(sinceMs, untilMs) {
    const allFiles = this.files();
    if (sinceMs == null && untilMs == null) return allFiles;
    return allFiles.filter((f) => {
      const r = this._fileRange(f);
      if (r.size === 0) return false;
      if (sinceMs != null && Number.isFinite(sinceMs) && r.lastMs != null && r.lastMs < sinceMs) return false;
      if (untilMs != null && Number.isFinite(untilMs) && r.firstMs != null && r.firstMs > untilMs) return false;
      return true;
    });
  }

  /**
   * Lazily build and maintain bounded per-day (`_dayAggregates`) and per-hour (`_hourAggregates`,
   * last 48 hours) aggregates in memory so `/v1/keysmith/usage` and `/status` never re-parse
   * month files on the request path.
   */
  _ensureDayAggregates() {
    if (!this._dayAggregates) {
      this._dayAggregates = new Map();
      this._hourAggregates = new Map();
      this._dayFiles = new Map();
      this._totalDayCells = 0;
      this._daysEvicted = false;
      for (const ev of this._unloggedEvents) ev._appliedCount = 0;
      for (const f of this.files()) {
        let firstMs = null;
        let lastMs = null;
        const res = forEachLine(
          f,
          (line) => {
            try {
              const e = JSON.parse(line);
              if (e && typeof e === 'object' && !Array.isArray(e)) {
                const t = Date.parse(e.ts || '');
                if (Number.isFinite(t)) {
                  if (firstMs == null || t < firstMs) firstMs = t;
                  if (lastMs == null || t > lastMs) lastMs = t;
                }
                this._addRowToDayAggregates(e);
              }
            } catch {}
          },
          { onError: (err, file) => this._logReadError(err, file) },
        );
        if (res.ok && !res.missing) {
          this._dayFiles.set(f, { ino: res.ino, offset: res.size });
          if (firstMs != null && lastMs != null) {
            this._fileRanges.set(f, { ino: res.ino, size: res.size, firstMs, lastMs });
          }
        }
      }
      this._syncSidecarUnloggedEvents();
      return this._dayAggregates;
    }

    // If `this.file` grew on disk outside `this.record()` (e.g. a second writer in a test),
    // read only the appended tail from the last seen offset.
    const st = safeStat(this.file);
    if (st && !st.isDirectory()) {
      const prev = this._dayFiles.get(this.file);
      if (!prev || prev.ino !== st.ino || st.size > prev.offset) {
        const startOffset = prev && prev.ino === st.ino && st.size >= prev.offset ? prev.offset : 0;
        const res = forEachLine(
          this.file,
          (line) => {
            try {
              const e = JSON.parse(line);
              if (e && typeof e === 'object' && !Array.isArray(e)) {
                const t = Date.parse(e.ts || '');
                this._noteFileTimestamp(this.file, t);
                this._addRowToDayAggregates(e);
              }
            } catch {}
          },
          { startOffset, onError: (err, file) => this._logReadError(err, file) },
        );
        if (res.ok && !res.missing) {
          this._dayFiles.set(this.file, { ino: res.ino, offset: res.size });
        }
      }
    }
    this._syncSidecarUnloggedEvents();
    return this._dayAggregates;
  }

  _addRowToDayAggregates(e, count = 1) {
    if (!this._dayAggregates || !e || typeof e.ts !== 'string' || e.ts.length < 10) return;
    const day = e.ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

    const key = capDim(e.key ?? null);
    const label = capDim(e.label ?? null);
    const adapter = capDim(e.adapter ?? splitTargetModel(e.model).adapter ?? null);
    const model = capDim(e.model ?? null);
    const account = capDim(e.account ?? null);
    const tag = capDim(e.tag ?? null);
    const client = capDim(e.client ?? null);
    const isLimited = e.status === 'limited';
    const isDenied = e.status === 'denied' || e.scope === 'denied';
    const cellKey = JSON.stringify([key, label, adapter, model, account, tag, client, isLimited ? 1 : 0]);

    let dayEntry = this._dayAggregates.get(day);
    if (!dayEntry) {
      if (this._dayAggregates.size >= MAX_DAYS_IN_MEMORY) {
        let earliestDay = null;
        for (const k of this._dayAggregates.keys()) {
          if (earliestDay === null || k < earliestDay) earliestDay = k;
        }
        if (earliestDay !== null && day < earliestDay) {
          this._daysEvicted = true;
          dayEntry = null;
        }
      }
      if (!dayEntry && (this._dayAggregates.size < MAX_DAYS_IN_MEMORY || !this._daysEvicted || day >= [...this._dayAggregates.keys()].sort()[0])) {
        const startMs = Date.parse(`${day}T00:00:00.000Z`);
        if (!Number.isNaN(startMs)) {
          dayEntry = {
            day,
            startMs,
            endMs: Date.parse(`${day}T23:59:59.999Z`),
            cells: new Map(),
          };
          this._dayAggregates.set(day, dayEntry);
          if (this._dayAggregates.size > MAX_DAYS_IN_MEMORY) {
            const sortedDays = [...this._dayAggregates.keys()].sort();
            while (this._dayAggregates.size > MAX_DAYS_IN_MEMORY && sortedDays.length) {
              const evictedKey = sortedDays.shift();
              const evicted = this._dayAggregates.get(evictedKey);
              if (evicted) {
                this._totalDayCells = Math.max(0, this._totalDayCells - evicted.cells.size);
                this._dayAggregates.delete(evictedKey);
                this._daysEvicted = true;
              }
            }
          }
        }
      }
    }

    if (dayEntry) {
      let cell = dayEntry.cells.get(cellKey);
      if (!cell) {
        if (dayEntry.cells.size >= MAX_CELLS_PER_DAY * 2) {
          this._compactDayCells(dayEntry, MAX_CELLS_PER_DAY, true);
        }
        cell = this._newCell({ day, key, label, adapter, model, account, tag, client, isLimited });
        dayEntry.cells.set(cellKey, cell);
        this._totalDayCells++;
        if (this._totalDayCells > MAX_TOTAL_DAY_CELLS) {
          this._enforceTotalCellBound();
        }
      }
      this._AccumulateRowIntoCell(cell, e, isLimited, isDenied, count);
    }

    if (this._hourAggregates && e.ts.length >= 13) {
      const hour = e.ts.slice(0, 13);
      if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) {
        let hourEntry = this._hourAggregates.get(hour);
        if (!hourEntry) {
          const startMs = Date.parse(`${hour}:00:00.000Z`);
          if (!Number.isNaN(startMs)) {
            let skipOldHour = false;
            if (this._hourAggregates.size >= MAX_HOURS_IN_MEMORY) {
              let earliestHour = null;
              for (const k of this._hourAggregates.keys()) {
                if (earliestHour === null || k < earliestHour) earliestHour = k;
              }
              if (earliestHour !== null && hour < earliestHour) skipOldHour = true;
            }
            if (!skipOldHour) {
              hourEntry = {
                hour,
                day,
                startMs,
                endMs: startMs + 3_600_000 - 1,
                cells: new Map(),
              };
              this._hourAggregates.set(hour, hourEntry);
              if (this._hourAggregates.size > MAX_HOURS_IN_MEMORY) {
                const sortedHours = [...this._hourAggregates.keys()].sort();
                while (this._hourAggregates.size > MAX_HOURS_IN_MEMORY && sortedHours.length) {
                  this._hourAggregates.delete(sortedHours.shift());
                }
              }
            }
          }
        }
        if (hourEntry) {
          let hCell = hourEntry.cells.get(cellKey);
          if (!hCell) {
            if (hourEntry.cells.size >= MAX_CELLS_PER_HOUR * 2) {
              this._compactDayCells(hourEntry, MAX_CELLS_PER_HOUR, false);
            }
            hCell = this._newCell({ day, key, label, adapter, model, account, tag, client, isLimited });
            hourEntry.cells.set(cellKey, hCell);
          }
          this._AccumulateRowIntoCell(hCell, e, isLimited, isDenied, count);
        }
      }
    }
  }

  _newCell({ day, key, label, adapter, model, account, tag, client, isLimited }) {
    return {
      day,
      key,
      label,
      adapter,
      model,
      account,
      tag,
      client,
      isLimited,
      sampleEntry: {
        ts: `${day}T00:00:00.000Z`,
        key,
        label,
        adapter,
        model,
        account,
        tag,
        client,
        status: isLimited ? 'limited' : 'ok',
      },
      requests: 0,
      failures: 0,
      refused: 0,
      denied: 0,
      unknownUsage: 0,
      knownUsage: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      meteredUsd: 0,
      listUsd: 0,
      msTotal: 0,
      hist: new Uint32Array(LATENCY_BOUNDS.length),
    };
  }

  _AccumulateRowIntoCell(cell, e, isLimited, isDenied, count = 1) {
    const n = Math.max(1, Number(count) || 1);
    if (isLimited) {
      cell.refused += n;
      return;
    }
    cell.requests += n;
    if (e.status !== 'ok') cell.failures += n;
    if (isDenied) cell.denied += n;
    if (isRowUsageUnknown(e)) {
      cell.unknownUsage += n;
      if (Array.isArray(e.failedLegs)) {
        for (const f of e.failedLegs) {
          if (f?.cost?.basis === 'metered' && typeof f.cost.usd === 'number') {
            cell.meteredUsd = roundUsd(cell.meteredUsd + f.cost.usd * n);
          }
          if (typeof f?.cost?.listUsd === 'number') {
            cell.listUsd = roundUsd(cell.listUsd + f.cost.listUsd * n);
          }
        }
      }
    } else {
      cell.knownUsage += n;
      cell.input += (Number(e.usage?.input) || 0) * n;
      cell.output += (Number(e.usage?.output) || 0) * n;
      cell.cacheRead += (Number(e.usage?.cacheRead) || 0) * n;
      cell.cacheWrite += (Number(e.usage?.cacheWrite) || 0) * n;
      if (e.cost?.basis === 'metered' && typeof e.cost.usd === 'number') {
        cell.meteredUsd = roundUsd(cell.meteredUsd + e.cost.usd * n);
      }
      if (typeof e.cost?.listUsd === 'number') {
        cell.listUsd = roundUsd(cell.listUsd + e.cost.listUsd * n);
      }
    }
    const ms = Number(e.ms) || 0;
    cell.msTotal += ms * n;
    cell.hist[histBucketIndex(ms)] += n;
  }

  _enforceTotalCellBound() {
    for (const dayEntry of this._dayAggregates.values()) {
      if (dayEntry.cells.size > MAX_CELLS_PER_DAY) {
        this._compactDayCells(dayEntry, MAX_CELLS_PER_DAY, true);
      }
    }
    if (this._totalDayCells <= MAX_TOTAL_DAY_CELLS) return;
    const sortedDays = [...this._dayAggregates.keys()].sort();
    while (this._totalDayCells > MAX_TOTAL_DAY_CELLS && sortedDays.length > 1) {
      const oldest = sortedDays.shift();
      const evicted = this._dayAggregates.get(oldest);
      if (evicted) {
        this._totalDayCells = Math.max(0, this._totalDayCells - evicted.cells.size);
        this._dayAggregates.delete(oldest);
        this._daysEvicted = true;
      }
    }
  }

  _compactDayCells(entryHolder, maxCells = MAX_CELLS_PER_DAY, trackTotal = true) {
    const beforeSize = entryHolder.cells.size;
    const entries = [...entryHolder.cells.entries()];
    if (entries.length <= maxCells) return;
    entries.sort(([, a], [, b]) => (b.meteredUsd + b.listUsd) - (a.meteredUsd + a.listUsd) || b.requests - a.requests || b.refused - a.refused);
    const keepCount = maxCells - 1;
    const nextCells = new Map();
    for (let i = 0; i < keepCount; i++) {
      nextCells.set(entries[i][0], entries[i][1]);
    }
    for (let i = keepCount; i < entries.length; i++) {
      const c = entries[i][1];
      const ovKey = JSON.stringify([c.key, c.label, c.adapter, '(other)', c.account, null, null, c.isLimited ? 1 : 0]);
      let ov = nextCells.get(ovKey);
      if (!ov) {
        ov = this._newCell({
          day: entryHolder.day,
          key: c.key,
          label: c.label,
          adapter: c.adapter,
          model: '(other)',
          account: c.account,
          tag: null,
          client: null,
          isLimited: c.isLimited,
        });
        nextCells.set(ovKey, ov);
      }
      ov.requests += c.requests;
      ov.failures += c.failures;
      ov.refused += c.refused;
      ov.denied += c.denied;
      ov.unknownUsage += c.unknownUsage || 0;
      ov.knownUsage += c.knownUsage || 0;
      ov.input += c.input;
      ov.output += c.output;
      ov.cacheRead += c.cacheRead;
      ov.cacheWrite += c.cacheWrite;
      ov.meteredUsd = roundUsd(ov.meteredUsd + c.meteredUsd);
      ov.listUsd = roundUsd(ov.listUsd + c.listUsd);
      ov.msTotal += c.msTotal;
      for (let j = 0; j < ov.hist.length; j++) {
        ov.hist[j] += c.hist[j];
      }
    }
    entryHolder.cells = nextCells;
    if (trackTotal) {
      this._totalDayCells = Math.max(0, this._totalDayCells - (beforeSize - nextCells.size));
    }
  }

  _newAggregateState(dims) {
    const newBucket = (dimValues) => ({
      dimValues,
      requests: 0,
      failures: 0,
      refused: 0,
      unknownUsage: 0,
      knownUsage: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      meteredUsd: 0,
      listUsd: 0,
      msTotal: 0,
      hist: new Uint32Array(LATENCY_BOUNDS.length),
    });
    return {
      dims,
      newBucket,
      groupMap: new Map(),
      modelMap: new Map(),
      keyMap: new Map(),
      totalBucket: newBucket([]),
    };
  }

  _mergeBuckets(dst, src) {
    dst.requests += src.requests;
    dst.failures += src.failures;
    dst.refused += src.refused || 0;
    dst.unknownUsage += src.unknownUsage || 0;
    dst.knownUsage += src.knownUsage || 0;
    dst.input += src.input;
    dst.output += src.output;
    dst.cacheRead += src.cacheRead;
    dst.cacheWrite += src.cacheWrite;
    dst.meteredUsd = roundUsd(dst.meteredUsd + src.meteredUsd);
    dst.listUsd = roundUsd(dst.listUsd + src.listUsd);
    dst.msTotal += src.msTotal;
    if (src.hist) {
      for (let i = 0; i < dst.hist.length; i++) {
        dst.hist[i] += src.hist[i];
      }
    }
  }

  /**
   * Keep the top `maxCount - 1` buckets by total spend (`meteredUsd + listUsd`) and then
   * `requests`, folding all remaining buckets into the `"(other)"` bucket (New 10).
   */
  _compactBucketMap(map, maxCount, overflowVals, newBucket) {
    if (map.size <= maxCount) return;
    const overflowKey = JSON.stringify(overflowVals);
    let overflowBucket = map.get(overflowKey) || null;
    if (overflowBucket) map.delete(overflowKey);

    const entries = [...map.entries()];
    entries.sort(([, a], [, b]) => (b.meteredUsd + b.listUsd) - (a.meteredUsd + a.listUsd) || b.requests - a.requests || b.refused - a.refused);
    const keepCount = Math.max(1, maxCount - 1);
    map.clear();
    for (let i = 0; i < entries.length; i++) {
      const [k, b] = entries[i];
      if (i < keepCount) {
        map.set(k, b);
      } else {
        if (!overflowBucket) overflowBucket = newBucket(overflowVals);
        this._mergeBuckets(overflowBucket, b);
      }
    }
    if (overflowBucket) {
      map.set(overflowKey, overflowBucket);
    }
  }

  _addCellToAggregate(agg, cell) {
    this._mergeBuckets(agg.totalBucket, cell);

    const cellDimValue = (d) => {
      switch (d) {
        case 'key': return cell.key;
        case 'label': return cell.label;
        case 'adapter': return cell.adapter;
        case 'model': return cell.model;
        case 'account': return cell.account;
        case 'tag': return cell.tag;
        case 'day': return cell.day;
        case 'client': return cell.client;
        default: return null;
      }
    };

    if (cell.requests > 0 || cell.refused > 0) {
      const vals = agg.dims.map(cellDimValue);
      const rawKey = JSON.stringify(vals);
      let gBucket = agg.groupMap.get(rawKey);
      if (!gBucket) {
        if (agg.groupMap.size >= MAX_DISTINCT_GROUPS * 2) {
          this._compactBucketMap(
            agg.groupMap,
            MAX_DISTINCT_GROUPS,
            agg.dims.map((_, i) => (i === 0 ? '(other)' : null)),
            agg.newBucket,
          );
        }
        gBucket = agg.newBucket(vals);
        agg.groupMap.set(rawKey, gBucket);
      }
      this._mergeBuckets(gBucket, cell);
    }

    if (cell.requests > 0 || cell.model) {
      const mName = cell.model || 'unknown';
      const mKey = JSON.stringify([mName]);
      let mBucket = agg.modelMap.get(mKey);
      if (!mBucket) {
        if (agg.modelMap.size >= MAX_DISTINCT_MODELS * 2) {
          this._compactBucketMap(agg.modelMap, MAX_DISTINCT_MODELS, ['(other)'], agg.newBucket);
        }
        mBucket = agg.newBucket([mName]);
        agg.modelMap.set(mKey, mBucket);
      }
      this._mergeBuckets(mBucket, cell);
    }

    if (cell.key) {
      const kRow = agg.keyMap.get(cell.key) || { key: cell.key, ...(cell.label ? { label: cell.label } : {}), requests: 0, denied: 0, refused: 0 };
      if (cell.label && !kRow.label) kRow.label = cell.label;
      kRow.requests += cell.requests;
      kRow.denied += cell.denied;
      kRow.refused += cell.refused || 0;
      agg.keyMap.set(cell.key, kRow);
    }
  }

  _addEntryToAggregate(agg, e, count = 1) {
    const n = Math.max(1, Number(count) || Number(e?.count) || 1);
    const isLimited = e.status === 'limited';
    const addEntryToBucket = (b, row) => {
      if (row.status === 'limited') {
        b.refused += n;
        return;
      }
      b.requests += n;
      if (row.status !== 'ok') b.failures += n;
      if (isRowUsageUnknown(row)) {
        b.unknownUsage += n;
        if (Array.isArray(row.failedLegs)) {
          for (const f of row.failedLegs) {
            if (f?.cost?.basis === 'metered' && typeof f.cost.usd === 'number') {
              b.meteredUsd = roundUsd(b.meteredUsd + f.cost.usd * n);
            }
            if (typeof f?.cost?.listUsd === 'number') {
              b.listUsd = roundUsd(b.listUsd + f.cost.listUsd * n);
            }
          }
        }
      } else {
        b.knownUsage += n;
        const inp = (Number(row.usage?.input) || 0) * n;
        const out = (Number(row.usage?.output) || 0) * n;
        const cr = (Number(row.usage?.cacheRead) || 0) * n;
        const cw = (Number(row.usage?.cacheWrite) || 0) * n;
        b.input += inp;
        b.output += out;
        b.cacheRead += cr;
        b.cacheWrite += cw;
        if (row.cost?.basis === 'metered' && typeof row.cost.usd === 'number') {
          b.meteredUsd = roundUsd(b.meteredUsd + row.cost.usd * n);
        }
        if (typeof row.cost?.listUsd === 'number') {
          b.listUsd = roundUsd(b.listUsd + row.cost.listUsd * n);
        }
      }
      const ms = Number(row.ms) || 0;
      b.msTotal += ms * n;
      b.hist[histBucketIndex(ms)] += n;
    };

    addEntryToBucket(agg.totalBucket, e);

    {
      const vals = agg.dims.map((d) => dimensionValue(e, d));
      const rawKey = JSON.stringify(vals);
      let gBucket = agg.groupMap.get(rawKey);
      if (!gBucket) {
        if (agg.groupMap.size >= MAX_DISTINCT_GROUPS * 2) {
          this._compactBucketMap(
            agg.groupMap,
            MAX_DISTINCT_GROUPS,
            agg.dims.map((_, i) => (i === 0 ? '(other)' : null)),
            agg.newBucket,
          );
        }
        gBucket = agg.newBucket(vals);
        agg.groupMap.set(rawKey, gBucket);
      }
      addEntryToBucket(gBucket, e);
    }

    if (!isLimited || e.model) {
      const mName = capDim(e.model || 'unknown');
      const mKey = JSON.stringify([mName]);
      let mBucket = agg.modelMap.get(mKey);
      if (!mBucket) {
        if (agg.modelMap.size >= MAX_DISTINCT_MODELS * 2) {
          this._compactBucketMap(agg.modelMap, MAX_DISTINCT_MODELS, ['(other)'], agg.newBucket);
        }
        mBucket = agg.newBucket([mName]);
        agg.modelMap.set(mKey, mBucket);
      }
      addEntryToBucket(mBucket, e);
    }

    if (e.key) {
      const kKey = capDim(e.key);
      const kLabel = capDim(e.label ?? null);
      const kRow = agg.keyMap.get(kKey) || { key: kKey, ...(kLabel ? { label: kLabel } : {}), requests: 0, denied: 0, refused: 0 };
      if (kLabel && !kRow.label) kRow.label = kLabel;
      if (isLimited) {
        kRow.refused += n;
      } else {
        kRow.requests += n;
        if (e.status === 'denied' || e.scope === 'denied') kRow.denied += n;
      }
      agg.keyMap.set(kKey, kRow);
    }
  }

  _finalizeAggregate(agg, { sinceMs = null, untilMs = null, hours = null, granularity = null, roundedToWholeHours = false, roundedToWholeDays = false } = {}) {
    const dims = agg.dims;
    if (agg.groupMap.size > MAX_DISTINCT_GROUPS) {
      this._compactBucketMap(
        agg.groupMap,
        MAX_DISTINCT_GROUPS,
        dims.map((_, i) => (i === 0 ? '(other)' : null)),
        agg.newBucket,
      );
    }
    if (agg.modelMap.size > MAX_DISTINCT_MODELS) {
      this._compactBucketMap(agg.modelMap, MAX_DISTINCT_MODELS, ['(other)'], agg.newBucket);
    }

    const finalizeBucket = (b, extra = {}) => {
      const p50 = histPercentile(b.hist, 0.5);
      const p95 = histPercentile(b.hist, 0.95);
      const unknownUsage = b.unknownUsage || 0;
      const allUnknown = unknownUsage > 0 && (b.knownUsage || 0) === 0;
      const input = allUnknown ? null : b.input;
      const output = allUnknown ? null : b.output;
      const cacheRead = allUnknown ? null : b.cacheRead;
      const cacheWrite = allUnknown ? null : b.cacheWrite;
      const meteredUsd = allUnknown ? null : roundUsd(b.meteredUsd);
      const listUsd = allUnknown ? null : roundUsd(b.listUsd);
      return {
        ...extra,
        requests: b.requests,
        failures: b.failures,
        refused: b.refused || 0,
        unknownUsage,
        input,
        output,
        cacheRead,
        cacheWrite,
        tokensIn: input,
        tokensOut: output,
        tokens: allUnknown ? null : { input, output, cacheRead, cacheWrite },
        meteredUsd,
        listUsd,
        p50,
        p95,
        p50Ms: p50,
        p95Ms: p95,
        msTotal: b.msTotal,
      };
    };

    const isOtherGroup = (g) => g.group === '(other)' || g[dims[0]] === '(other)';
    const groups = [...agg.groupMap.values()]
      .map((b) => {
        const dimFields = {};
        for (let i = 0; i < dims.length; i++) dimFields[dims[i]] = b.dimValues[i];
        const groupLabel = b.dimValues.map((v) => v ?? '-').join('/');
        return finalizeBucket(b, { group: groupLabel, ...dimFields });
      })
      .sort((a, b) => isOtherGroup(a) - isOtherGroup(b) || b.requests - a.requests || (b.meteredUsd + b.listUsd) - (a.meteredUsd + a.listUsd) || b.refused - a.refused || String(a.group).localeCompare(String(b.group)));

    const models = [...agg.modelMap.values()]
      .map((b) => finalizeBucket(b, { model: b.dimValues[0] }))
      .sort((a, b) => (a.model === '(other)' ? 1 : 0) - (b.model === '(other)' ? 1 : 0) || b.requests - a.requests || (b.meteredUsd + b.listUsd) - (a.meteredUsd + a.listUsd));

    const keys = [...agg.keyMap.values()].sort((a, b) => b.requests - a.requests || (b.refused || 0) - (a.refused || 0));
    const totals = finalizeBucket(agg.totalBucket);

    return {
      ...(hours != null ? { windowHours: Number(hours) } : {}),
      ...(granularity ? { granularity } : {}),
      ...(roundedToWholeHours ? { roundedToWholeHours: true } : {}),
      ...(roundedToWholeDays ? { roundedToWholeDays: true } : {}),
      by: dims,
      since: sinceMs != null ? new Date(sinceMs).toISOString() : null,
      until: untilMs != null ? new Date(untilMs).toISOString() : null,
      requests: totals.requests,
      failures: totals.failures,
      refused: totals.refused,
      unknownUsage: totals.unknownUsage,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      tokens: totals.tokens,
      meteredUsd: totals.meteredUsd,
      listUsd: totals.listUsd,
      p50: totals.p50,
      p95: totals.p95,
      p50Ms: totals.p50Ms,
      p95Ms: totals.p95Ms,
      groups,
      totals,
      models,
      keys,
    };
  }

  /**
   * Audit statistics over the log.
   * - When `fromDays: true` (used by `/v1/keysmith/usage` and the status page):
   *   - For windows of 48 hours or less (`hours <= 48`), answers from the in-memory hourly cells
   *     (`_hourAggregates`, `granularity: "hour"`, `roundedToWholeHours: true`).
   *   - Otherwise answers from the bounded in-memory per-day aggregates (`_dayAggregates`,
   *     `granularity: "day"`, `roundedToWholeDays: true`), reporting the earliest kept day in
   *     `since` whenever older days have aged out of memory.
   * - When `fromDays: false` (used by `keysmith usage` on the command line), streams the candidate
   *   log files whose `[firstMs, lastMs]` range overlaps `[sinceMs, untilMs]`.
   */
  query({ by = ['model'], since = null, until = null, hours = null, filter = null, now = null, fromDays = false } = {}) {
    const dims = parseBy(by);
    const nowMs = now != null ? (now instanceof Date ? now.getTime() : Number(now)) : this._nowDate().getTime();
    const rawSinceMs =
      since != null
        ? parseTimeBound(since, { isUntil: false, now: nowMs })
        : hours != null && Number.isFinite(Number(hours))
          ? nowMs - Number(hours) * 3_600_000
          : null;
    const rawUntilMs = until != null ? parseTimeBound(until, { isUntil: true, now: nowMs }) : null;

    if (fromDays) {
      const daysMap = this._ensureDayAggregates();
      const useHours =
        hours != null &&
        Number.isFinite(Number(hours)) &&
        Number(hours) > 0 &&
        Number(hours) <= 48 &&
        since == null &&
        until == null &&
        this._hourAggregates != null;

      if (useHours) {
        const sinceMs = Math.floor(rawSinceMs / 3_600_000) * 3_600_000;
        const agg = this._newAggregateState(dims);
        for (const hourEntry of this._hourAggregates.values()) {
          if (hourEntry.endMs < sinceMs) continue;
          if (hourEntry.cells.size > MAX_CELLS_PER_HOUR) this._compactDayCells(hourEntry, MAX_CELLS_PER_HOUR, false);
          for (const cell of hourEntry.cells.values()) {
            if (filter && !filter(cell.sampleEntry)) continue;
            this._addCellToAggregate(agg, cell);
          }
        }
        return this._finalizeAggregate(agg, {
          sinceMs,
          untilMs: null,
          hours,
          granularity: 'hour',
          roundedToWholeHours: true,
        });
      }

      let sinceMs = null;
      if (rawSinceMs != null && Number.isFinite(rawSinceMs)) {
        const d = new Date(rawSinceMs);
        sinceMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
      }
      let untilMs = null;
      if (rawUntilMs != null && Number.isFinite(rawUntilMs)) {
        const d = new Date(rawUntilMs);
        untilMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999);
      }
      if (this._daysEvicted && daysMap.size > 0) {
        let earliestDayMs = null;
        for (const de of daysMap.values()) {
          if (earliestDayMs == null || de.startMs < earliestDayMs) earliestDayMs = de.startMs;
        }
        if (earliestDayMs != null && (sinceMs == null || sinceMs < earliestDayMs)) {
          sinceMs = earliestDayMs;
        }
      }
      const agg = this._newAggregateState(dims);
      for (const dayEntry of daysMap.values()) {
        if (sinceMs != null && dayEntry.endMs < sinceMs) continue;
        if (untilMs != null && dayEntry.startMs > untilMs) continue;
        if (dayEntry.cells.size > MAX_CELLS_PER_DAY) this._compactDayCells(dayEntry, MAX_CELLS_PER_DAY, true);
        for (const cell of dayEntry.cells.values()) {
          if (filter && !filter(cell.sampleEntry)) continue;
          this._addCellToAggregate(agg, cell);
        }
      }
      return this._finalizeAggregate(agg, {
        sinceMs,
        untilMs,
        hours,
        granularity: 'day',
        roundedToWholeDays: true,
      });
    }

    const candidateFiles = this._candidateFiles(rawSinceMs, rawUntilMs);
    const agg = this._newAggregateState(dims);
    for (const f of candidateFiles) {
      let firstMs = null;
      let lastMs = null;
      const res = forEachLine(
        f,
        (line) => {
          try {
            const e = JSON.parse(line);
            const t = Date.parse(e?.ts || '');
            if (Number.isFinite(t)) {
              if (firstMs == null || t < firstMs) firstMs = t;
              if (lastMs == null || t > lastMs) lastMs = t;
            }
            if (filter && !filter(e)) return;
            if (rawSinceMs != null || rawUntilMs != null) {
              if (Number.isNaN(t)) return;
              if (rawSinceMs != null && t < rawSinceMs) return;
              if (rawUntilMs != null && t > rawUntilMs) return;
            }
            this._addEntryToAggregate(agg, e);
          } catch {}
        },
        { onError: (err, file) => this._logReadError(err, file) },
      );
      if (res.ok && !res.missing && firstMs != null && lastMs != null) {
        this._fileRanges.set(f, { ino: res.ino, size: res.size, firstMs, lastMs });
      }
    }
    this._syncSidecarUnloggedEvents();
    for (const ev of this._unloggedEvents) {
      const t = Date.parse(ev?.ts || '');
      if (filter && !filter(ev)) continue;
      if (rawSinceMs != null || rawUntilMs != null) {
        if (Number.isNaN(t)) continue;
        if (rawSinceMs != null && t < rawSinceMs) continue;
        if (rawUntilMs != null && t > rawUntilMs) continue;
      }
      this._addEntryToAggregate(agg, ev, ev.count);
    }
    return this._finalizeAggregate(agg, { sinceMs: rawSinceMs, untilMs: rawUntilMs, hours });
  }

  /**
   * Summarise usage over a window (default 24h for statusPage; pass null for all time),
   * answered from the in-memory per-day aggregates.
   */
  summarize(sinceMs = 24 * 3600_000, filter = null) {
    const nowMs = this._nowDate().getTime();
    if (sinceMs == null) return this.query({ by: ['model'], filter, now: nowMs, fromDays: true });
    const hours = Math.round(sinceMs / 3600_000);
    return this.query({ by: ['model'], hours, filter, now: nowMs, fromDays: true });
  }
}

/**
 * Format a CSV cell value, neutralising spreadsheet formula prefixes (`=`, `+`, `-`, `@`,
 * tab, CR) on non-numeric strings so client-controlled fields (User-Agent, model, tag)
 * cannot inject formulas into `--format csv`.
 */
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  let s = String(v);
  if (/^[\s\t\r\n]*[=+\-@]|^[\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function formatUsageCsv(report) {
  const dims = report.by || ['model'];
  const header = [...dims, 'requests', 'failures', 'input', 'output', 'cacheRead', 'cacheWrite', 'meteredUsd', 'listUsd', 'p50Ms', 'p95Ms'];
  const lines = [header.join(',')];
  for (const g of report.groups || []) {
    const dimCols = dims.map((d) => csvCell(g[d] ?? ''));
    lines.push(
      [
        ...dimCols,
        g.requests,
        g.failures,
        g.input,
        g.output,
        g.cacheRead,
        g.cacheWrite,
        g.meteredUsd,
        g.listUsd,
        g.p50Ms,
        g.p95Ms,
      ].join(','),
    );
  }
  const t = report.totals || report;
  const totalCols = dims.map((_, i) => (i === 0 ? 'total' : ''));
  lines.push(
    [
      ...totalCols,
      t.requests,
      t.failures,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheWrite,
      t.meteredUsd,
      t.listUsd,
      t.p50Ms,
      t.p95Ms,
    ].join(','),
  );
  return lines.join('\n');
}

export function formatUsageTable(report, { spend = [], daily = [] } = {}) {
  const dims = report.by || ['model'];
  const t = report.totals || report;
  const lines = [];
  const fmtTok = (n) => (n == null ? 'unknown' : String(n));
  const fmtCellTok = (n) => (n == null ? '-' : String(n));
  const fmtBucketUsd = (n, cell = false) => (n == null ? (cell ? '-' : 'unknown') : fmtUsd(n));
  const unkNote = t.unknownUsage ? `, ${t.unknownUsage} unknown usage` : '';
  lines.push(
    `requests: ${t.requests} (${t.failures} failed${unkNote}) · tokens: ${fmtTok(t.input)} in / ${fmtTok(t.output)} out / ${fmtTok(t.cacheRead)} cache read / ${fmtTok(t.cacheWrite)} cache write · metered: ${fmtBucketUsd(t.meteredUsd)} · list-equiv: ${fmtBucketUsd(t.listUsd)} · duration: p50 ${t.p50Ms}ms / p95 ${t.p95Ms}ms`,
  );
  const allGroups = report.groups || [];
  const groups = allGroups.length > MAX_TABLE_GROUPS ? allGroups.slice(0, MAX_TABLE_GROUPS) : allGroups;
  if (groups.length) {
    lines.push('');
    const widths = dims.map((d) => maxWidth(groups, (g) => String(g[d] ?? '-').length, Math.max(d.length, 5)));
    const headDims = dims.map((d, i) => d.padEnd(widths[i])).join('  ');
    lines.push(
      `  ${headDims}  ${'req'.padStart(5)}  ${'fail'.padStart(4)}  ${'in'.padStart(9)}  ${'out'.padStart(9)}  ${'cache r'.padStart(9)}  ${'cache w'.padStart(9)}  ${'metered'.padStart(9)}  ${'list'.padStart(9)}  ${'p50'.padStart(7)}  ${'p95'.padStart(7)}`,
    );
    for (const g of groups) {
      const cols = dims.map((d, i) => String(g[d] ?? '-').padEnd(widths[i])).join('  ');
      lines.push(
        `  ${cols}  ${String(g.requests).padStart(5)}  ${String(g.failures).padStart(4)}  ${fmtCellTok(g.input).padStart(9)}  ${fmtCellTok(g.output).padStart(9)}  ${fmtCellTok(g.cacheRead).padStart(9)}  ${fmtCellTok(g.cacheWrite).padStart(9)}  ${fmtBucketUsd(g.meteredUsd, true).padStart(9)}  ${fmtBucketUsd(g.listUsd, true).padStart(9)}  ${(g.p50Ms + 'ms').padStart(7)}  ${(g.p95Ms + 'ms').padStart(7)}`,
      );
    }
    if (allGroups.length > groups.length) {
      lines.push(`  … (${allGroups.length - groups.length} more groups omitted)`);
    }
    const totalDims = dims.map((_, i) => (i === 0 ? 'total' : '').padEnd(widths[i])).join('  ');
    lines.push(
      `  ${totalDims}  ${String(t.requests).padStart(5)}  ${String(t.failures).padStart(4)}  ${fmtCellTok(t.input).padStart(9)}  ${fmtCellTok(t.output).padStart(9)}  ${fmtCellTok(t.cacheRead).padStart(9)}  ${fmtCellTok(t.cacheWrite).padStart(9)}  ${fmtBucketUsd(t.meteredUsd, true).padStart(9)}  ${fmtBucketUsd(t.listUsd, true).padStart(9)}  ${(t.p50Ms + 'ms').padStart(7)}  ${(t.p95Ms + 'ms').padStart(7)}`,
    );
  }
  if (spend && spend.length) {
    lines.push('');
    lines.push(`spend caps (${spend[0].month}, resets ${spend[0].resetAt}):`);
    const w = maxWidth(spend, (s) => `${s.kind} ${s.target}`.length, 8);
    for (const s of spend) {
      const status = s.error ? `UNREADABLE (${s.error})` : s.exceeded ? 'CAPPED' : 'ok';
      lines.push(`  ${`${s.kind} ${s.target}`.padEnd(w)}  ${fmtUsd(s.spent)} / ${fmtUsd(s.cap)}  ${status}`);
    }
  }
  if (daily && daily.length) {
    lines.push('');
    lines.push(`daily caps (${daily[0].day}, resets at local midnight):`);
    const labelOf = (d) => `fp:${d.fp}${d.label ? ` (${d.label})` : ''}`;
    const w = maxWidth(daily, (d) => labelOf(d).length, 8);
    for (const d of daily) {
      const ref = d.refused ? ` (${d.refused} refused)` : '';
      lines.push(`  ${labelOf(d).padEnd(w)}  ${d.requests} / ${d.perDay} requests${ref}  ${d.exceeded ? 'CAPPED' : 'ok'}`);
    }
  }
  return lines.join('\n');
}
