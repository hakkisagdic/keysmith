/**
 * Virtual models (inspired by Pi's "Virtual Models"): one model name such as `auto/text`
 * or `auto/vision` that keysmith resolves per request to a concrete `adapter/model`.
 *
 * Routing flow per request:
 *   1. Check key scope for naming the virtual model (`auto/*`, `auto/text`, etc.).
 *   2. Check `loadGate` (`maxLoadPerCore`, `maxMemoryPressure`). If the machine is congested,
 *      skip the classifier and route to the configured `congested` tier or the first remote
 *      candidate of the `medium` tier (falling through to `complex`).
 *   3. Otherwise ask the configured `classifier` (`adapter/model`) for a one-word complexity
 *      label (`simple` | `medium` | `complex`) with a short, cached prompt, tiny `max_tokens`,
 *      and low timeout; on classifier failure, timeout, or invalid reply, default to `medium`.
 *   4. Try the chosen tier's candidates in declared order, enforcing key scope on every concrete
 *      target before calling it, and falling through on 429 / quota / spend cap / timeout / 5xx
 *      to the next candidate in the tier and then to the next tier up (`simple` -> `medium` -> `complex`).
 *   5. Record `{ virtual, label, chosen, fallbacks, reason, latency }` in the usage/audit log.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { flattenMessages } from './util.js';

export const TIER_ORDER = Object.freeze(['simple', 'medium', 'complex']);
export const ALL_TIERS = Object.freeze(['simple', 'medium', 'complex', 'congested']);

export const MEMORY_PRESSURE_RANKS = Object.freeze({
  normal: 1,
  warn: 2,
  warning: 2,
  critical: 3,
});

export const CLASSIFIER_SYSTEM_PROMPT =
  'Classify the complexity of the user request. Reply with one word only: simple, medium, or complex.';

export const DEFAULT_CLASSIFIER_MAX_TOKENS = 8;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 2500;
export const DEFAULT_PROMPT_CACHE_SECONDS = 60;
const MAX_CLASSIFIER_PROMPT_CHARS = 1200;
const MAX_CACHE_ENTRIES = 512;

const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const ALLOWED_VIRTUAL_FIELDS = new Set([
  'classifier',
  'tiers',
  'loadGate',
  'stickySeconds',
  'timeoutMs',
  'classifierTimeoutMs',
  'maxTokens',
  'classifierMaxTokens',
  'note',
  'description',
  'media',
  'vision',
]);
const ALLOWED_LOAD_GATE_FIELDS = new Set(['maxLoadPerCore', 'maxMemoryPressure']);

const own = (obj, k) => Boolean(obj && typeof obj === 'object' && Object.hasOwn(obj, k) && !FORBIDDEN_NAMES.has(k));

/**
 * Split a `<adapter>/<model>` target string on the first slash.
 */
export function parseTargetSpec(raw, { adapters = null, cfgAdapters = null } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: `target must be a "<adapter>/<model>" string` };
  const s = raw.trim();
  if (!s || s !== raw || /\s/.test(s)) {
    return { ok: false, error: `invalid target "${raw}" (must be a non-empty "<adapter>/<model>" string without whitespace)` };
  }
  const slash = s.indexOf('/');
  if (slash === 0 || slash === s.length - 1) {
    return { ok: false, error: `invalid target "${raw}" (expected "<adapter>/<model>")` };
  }
  if (slash < 0) {
    const adapterObj = adapters?.get?.(s) || (own(cfgAdapters, s) ? cfgAdapters[s] : null);
    if (adapterObj?.defaultModel) {
      return {
        ok: true,
        adapterId: s,
        model: String(adapterObj.defaultModel),
        target: `${s}/${adapterObj.defaultModel}`,
      };
    }
    return { ok: false, error: `target "${raw}" is missing "/<model>" (expected "<adapter>/<model>")` };
  }
  const adapterId = s.slice(0, slash);
  const model = s.slice(slash + 1);
  if (FORBIDDEN_NAMES.has(adapterId) || FORBIDDEN_NAMES.has(model)) {
    return { ok: false, error: `invalid target "${raw}"` };
  }
  return { ok: true, adapterId, model, target: `${adapterId}/${model}` };
}

/**
 * Determine whether an adapter is a local on-machine model server (e.g. Ollama on 127.0.0.1:11434,
 * LM Studio, llama.cpp, vLLM, MLX) vs a remote/cloud provider or cloud-backed CLI.
 */
export function isLocalAdapter(adapterId, adapter = null, rawCfg = null) {
  const src = adapter || rawCfg || {};
  if (typeof src.local === 'boolean') return src.local;
  if (typeof src.remote === 'boolean') return !src.remote;
  if (typeof rawCfg?.local === 'boolean') return rawCfg.local;
  if (typeof rawCfg?.remote === 'boolean') return !rawCfg.remote;

  const id = String(adapterId || src.id || '').toLowerCase();
  if (/^(ollama|lmstudio|llamacpp|llama-cpp|vllm|mlx|local)\b|[-_](local|ollama|lmstudio|llamacpp|vllm|mlx)$/.test(id)) {
    return true;
  }

  const baseUrl = src.baseUrl || rawCfg?.baseUrl || '';
  if (typeof baseUrl === 'string' && baseUrl) {
    try {
      const u = new URL(baseUrl);
      const host = u.hostname.toLowerCase();
      const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
      if (!isLoopback) return false;
      // Known local LLM server ports (11434 Ollama, 1234 LM Studio)
      if (u.port === '11434' || u.port === '1234') return true;
    } catch {}
  }
  return false;
}

function declaredModelList(adapter, rawCfg) {
  const decl = adapter?._declared ?? rawCfg?.models;
  if (!decl) return null;
  if (Array.isArray(decl)) {
    return decl.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  }
  if (typeof decl === 'object') return Object.keys(decl);
  return null;
}

function checkLegReference(where, rawLeg, { cfg = {}, adapters = null, loadErrors = null, requireAdapter = true } = {}) {
  const cfgAdapters = cfg?.adapters && typeof cfg.adapters === 'object' ? cfg.adapters : {};
  const cfgAliases = cfg?.aliases && typeof cfg.aliases === 'object' ? cfg.aliases : {};
  const cfgVirtuals = cfg?.virtualModels && typeof cfg.virtualModels === 'object' ? cfg.virtualModels : {};

  if (typeof rawLeg === 'string' && (own(cfgAliases, rawLeg) || own(cfgVirtuals, rawLeg))) {
    throw new Error(`${where}: "${rawLeg}" references an alias or virtual model (must be a concrete "<adapter>/<model>")`);
  }

  const parsed = parseTargetSpec(rawLeg, { adapters, cfgAdapters });
  if (!parsed.ok) {
    throw new Error(`${where}: ${parsed.error}`);
  }
  const { adapterId, model, target } = parsed;

  if (own(cfgAliases, adapterId) || own(cfgVirtuals, adapterId) || own(cfgVirtuals, target)) {
    throw new Error(`${where}: "${rawLeg}" cannot reference an alias or virtual model`);
  }

  const loaded = adapters?.get?.(adapterId) || null;
  const rawAdapter = own(cfgAdapters, adapterId) ? cfgAdapters[adapterId] : null;
  const loadErr = loadErrors?.get?.(adapterId) || null;

  if (requireAdapter && !loaded && !rawAdapter && !loadErr) {
    throw new Error(`${where}: no adapter named "${adapterId}"`);
  }

  const effective = loaded || rawAdapter;
  if (effective) {
    if (effective.unsafeTools) {
      throw new Error(`${where}: adapter "${adapterId}" has tool access (unsafeTools) and cannot be used in a virtual model`);
    }
    if (effective.explicitOnly) {
      throw new Error(`${where}: adapter "${adapterId}" is marked explicitOnly and cannot be used in a virtual model`);
    }
    if (effective.disabled) {
      throw new Error(`${where}: adapter "${adapterId}" is disabled`);
    }
    const declared = declaredModelList(loaded, rawAdapter);
    if (declared && declared.length > 0 && !declared.includes(model)) {
      const stripPrefix = effective.stripModelPrefix;
      const stripped = typeof stripPrefix === 'string' && stripPrefix && model.startsWith(stripPrefix) ? model.slice(stripPrefix.length) : null;
      const mapped = effective.modelMap && own(effective.modelMap, model);
      if (!mapped && (!stripped || !declared.includes(stripped))) {
        throw new Error(`${where}: "${model}" is not among ${adapterId}'s declared models (${declared.join(', ')})`);
      }
    }
  }

  return { adapterId, model, target };
}

/**
 * Validate a single virtual model entry at config/gateway load time.
 * Throws a descriptive `Error` if any field is invalid.
 */
export function checkVirtualModel(name, raw, { cfg = {}, adapters = null, loadErrors = null, requireAdapter = true } = {}) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /\s/.test(name) || FORBIDDEN_NAMES.has(name)) {
    throw new Error(`invalid virtual model name "${name}"`);
  }
  const cfgAdapters = cfg?.adapters && typeof cfg.adapters === 'object' ? cfg.adapters : {};
  const cfgAliases = cfg?.aliases && typeof cfg.aliases === 'object' ? cfg.aliases : {};

  if (own(cfgAdapters, name) || adapters?.has?.(name)) {
    throw new Error(`virtual model "${name}" collides with adapter "${name}"`);
  }
  if (own(cfgAliases, name)) {
    throw new Error(`virtual model "${name}" collides with alias "${name}"`);
  }
  const slash = name.indexOf('/');
  if (slash === 0 || slash === name.length - 1) {
    throw new Error(`virtual model "${name}": name cannot start or end with "/"`);
  }
  if (slash > 0) {
    const prefix = name.slice(0, slash);
    if (FORBIDDEN_NAMES.has(prefix)) {
      throw new Error(`virtual model "${name}": invalid prefix "${prefix}"`);
    }
    if (own(cfgAdapters, prefix) || adapters?.has?.(prefix)) {
      throw new Error(`virtual model "${name}": prefix "${prefix}" collides with configured adapter "${prefix}"`);
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`virtual model "${name}": configuration must be an object`);
  }
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_VIRTUAL_FIELDS.has(k)) {
      throw new Error(`virtual model "${name}": unknown field "${k}"`);
    }
  }

  // 1. Validate classifier
  let classifierStr = null;
  let classifierTimeoutMs = raw.classifierTimeoutMs ?? raw.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  let classifierMaxTokens = raw.classifierMaxTokens ?? raw.maxTokens ?? DEFAULT_CLASSIFIER_MAX_TOKENS;

  if (typeof raw.classifier === 'string') {
    classifierStr = raw.classifier;
  } else if (raw.classifier && typeof raw.classifier === 'object' && !Array.isArray(raw.classifier)) {
    classifierStr = raw.classifier.model;
    if (raw.classifier.timeoutMs !== undefined) classifierTimeoutMs = raw.classifier.timeoutMs;
    if (raw.classifier.maxTokens !== undefined) classifierMaxTokens = raw.classifier.maxTokens;
  }
  if (typeof classifierStr !== 'string' || !classifierStr.trim()) {
    throw new Error(`virtual model "${name}": classifier must be a non-empty "<adapter>/<model>" string`);
  }
  const classifierLeg = checkLegReference(`virtual model "${name}" classifier`, classifierStr, {
    cfg,
    adapters,
    loadErrors,
    requireAdapter,
  });

  if (typeof classifierTimeoutMs !== 'number' || !Number.isFinite(classifierTimeoutMs) || classifierTimeoutMs <= 0) {
    throw new Error(`virtual model "${name}": classifierTimeoutMs must be a positive number`);
  }
  if (typeof classifierMaxTokens !== 'number' || !Number.isInteger(classifierMaxTokens) || classifierMaxTokens <= 0) {
    throw new Error(`virtual model "${name}": classifierMaxTokens must be a positive integer`);
  }

  // 2. Validate tiers
  if (!raw.tiers || typeof raw.tiers !== 'object' || Array.isArray(raw.tiers)) {
    throw new Error(`virtual model "${name}": tiers must be an object defining simple, medium, and complex candidate lists`);
  }
  for (const tk of Object.keys(raw.tiers)) {
    if (!ALL_TIERS.includes(tk)) {
      throw new Error(`virtual model "${name}": unknown tier "${tk}" (expected simple, medium, complex, or congested)`);
    }
  }
  const tiers = {};
  const tierLegs = {};
  for (const t of TIER_ORDER) {
    const list = raw.tiers[t];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`virtual model "${name}": tiers.${t} must be a non-empty array of "<adapter>/<model>" strings`);
    }
    tierLegs[t] = list.map((item, idx) =>
      checkLegReference(`virtual model "${name}" tiers.${t}[${idx}]`, item, {
        cfg,
        adapters,
        loadErrors,
        requireAdapter,
      }),
    );
    tiers[t] = tierLegs[t].map((l) => l.target);
  }
  if (raw.tiers.congested !== undefined) {
    const list = raw.tiers.congested;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`virtual model "${name}": tiers.congested must be a non-empty array of "<adapter>/<model>" strings`);
    }
    tierLegs.congested = list.map((item, idx) =>
      checkLegReference(`virtual model "${name}" tiers.congested[${idx}]`, item, {
        cfg,
        adapters,
        loadErrors,
        requireAdapter,
      }),
    );
    tiers.congested = tierLegs.congested.map((l) => l.target);
  }

  // 3. Validate loadGate
  let loadGate = null;
  if (raw.loadGate !== undefined && raw.loadGate !== null) {
    if (typeof raw.loadGate !== 'object' || Array.isArray(raw.loadGate)) {
      throw new Error(`virtual model "${name}": loadGate must be an object`);
    }
    for (const lk of Object.keys(raw.loadGate)) {
      if (!ALLOWED_LOAD_GATE_FIELDS.has(lk)) {
        throw new Error(`virtual model "${name}": unknown loadGate field "${lk}" (expected maxLoadPerCore, maxMemoryPressure)`);
      }
    }
    let maxLoadPerCore = null;
    if (raw.loadGate.maxLoadPerCore !== undefined && raw.loadGate.maxLoadPerCore !== null) {
      const v = raw.loadGate.maxLoadPerCore;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new Error(`virtual model "${name}": loadGate.maxLoadPerCore must be a positive number`);
      }
      maxLoadPerCore = v;
    }
    let maxMemoryPressure = null;
    if (raw.loadGate.maxMemoryPressure !== undefined && raw.loadGate.maxMemoryPressure !== null) {
      const mp = raw.loadGate.maxMemoryPressure;
      if (typeof mp === 'string') {
        const norm = mp.trim().toLowerCase();
        if (!Object.hasOwn(MEMORY_PRESSURE_RANKS, norm)) {
          throw new Error(
            `virtual model "${name}": loadGate.maxMemoryPressure must be "normal", "warn", "critical", or a positive number <= 100 (got "${mp}")`,
          );
        }
        maxMemoryPressure = norm === 'warning' ? 'warn' : norm;
      } else if (typeof mp === 'number' && Number.isFinite(mp) && mp > 0 && mp <= 100) {
        maxMemoryPressure = mp;
      } else {
        throw new Error(
          `virtual model "${name}": loadGate.maxMemoryPressure must be "normal", "warn", "critical", or a positive number <= 100`,
        );
      }
    }
    loadGate = {
      ...(maxLoadPerCore !== null ? { maxLoadPerCore } : {}),
      ...(maxMemoryPressure !== null ? { maxMemoryPressure } : {}),
    };
  }

  // 4. Validate stickySeconds
  let stickySeconds = null;
  if (raw.stickySeconds !== undefined && raw.stickySeconds !== null) {
    if (typeof raw.stickySeconds !== 'number' || !Number.isFinite(raw.stickySeconds) || raw.stickySeconds < 0) {
      throw new Error(`virtual model "${name}": stickySeconds must be a non-negative number`);
    }
    stickySeconds = raw.stickySeconds;
  }

  return {
    name,
    classifier: classifierLeg.target,
    classifierLeg,
    tiers,
    tierLegs,
    loadGate,
    stickySeconds,
    classifierTimeoutMs,
    classifierMaxTokens,
    note: typeof raw.note === 'string' ? raw.note : null,
  };
}

/**
 * Validate `cfg.virtualModels` at load time.
 * Returns a Map of `<virtualModelName> -> normalizedSpec`.
 */
export function validateVirtualModels(cfg, { adapters = null, loadErrors = null, requireAdapter = true } = {}) {
  const rawMap = cfg?.virtualModels;
  if (rawMap === undefined || rawMap === null) return new Map();
  if (typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    throw new Error('virtualModels must be an object mapping virtual model names to their configuration');
  }
  for (const k of Object.getOwnPropertyNames(rawMap)) {
    if (FORBIDDEN_NAMES.has(k)) {
      throw new Error(`invalid virtual model name "${k}"`);
    }
  }
  const out = new Map();
  for (const [name, raw] of Object.entries(rawMap)) {
    const spec = checkVirtualModel(name, raw, { cfg, adapters, loadErrors, requireAdapter });
    out.set(name, spec);
  }
  return out;
}

/* --------------------------------------------------- machine load & memory pressure */

let _cachedMacPressure = { at: 0, value: 'normal' };

export function readMacMemoryPressure() {
  if (process.platform !== 'darwin') return 'normal';
  const now = Date.now();
  if (now - _cachedMacPressure.at < 2000) return _cachedMacPressure.value;
  let value = 'normal';
  try {
    const raw = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      encoding: 'utf8',
      timeout: 250,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const level = Number(raw);
    if (level >= 4) value = 'critical';
    else if (level === 2) value = 'warn';
    else value = 'normal';
  } catch {
    value = 'normal';
  }
  _cachedMacPressure = { at: now, value };
  return value;
}

export function defaultLoadProbe() {
  const cores = Math.max(1, os.cpus()?.length || 1);
  const loadAvg1m = os.loadavg()[0];
  return {
    loadAvg: loadAvg1m,
    cores,
    loadPerCore: loadAvg1m / cores,
    memoryPressure: readMacMemoryPressure(),
  };
}

function normalizePressureValue(mp) {
  if (typeof mp === 'string') {
    const s = mp.trim().toLowerCase();
    if (s === 'warning') return { label: 'warn', rank: 2, numeric: null };
    if (Object.hasOwn(MEMORY_PRESSURE_RANKS, s)) return { label: s, rank: MEMORY_PRESSURE_RANKS[s], numeric: null };
  }
  if (typeof mp === 'number' && Number.isFinite(mp)) {
    // Support sysctl levels (1=normal, 2=warn, 4=critical) or percentages/fractions
    if (mp <= 1) return { label: mp > 0.85 ? 'critical' : mp > 0.7 ? 'warn' : 'normal', rank: mp > 0.85 ? 3 : mp > 0.7 ? 2 : 1, numeric: mp };
    if (mp === 2) return { label: 'warn', rank: 2, numeric: mp };
    if (mp === 4) return { label: 'critical', rank: 3, numeric: mp };
    return { label: mp >= 85 ? 'critical' : mp >= 70 ? 'warn' : 'normal', rank: mp >= 85 ? 3 : mp >= 70 ? 2 : 1, numeric: mp };
  }
  return { label: 'normal', rank: 1, numeric: null };
}

/**
 * Evaluate `loadGate` against the current machine load and memory pressure.
 */
export function evaluateLoadGate(loadGate, probeFn = defaultLoadProbe) {
  const raw = typeof probeFn === 'function' ? probeFn() || {} : probeFn || {};
  const cores = Math.max(1, Number(raw.cores) || os.cpus()?.length || 1);
  const loadAvg = Array.isArray(raw.loadAvg) ? Number(raw.loadAvg[0]) || 0 : Number(raw.loadAvg ?? os.loadavg()[0]) || 0;
  const loadPerCore =
    typeof raw.loadPerCore === 'number' && Number.isFinite(raw.loadPerCore)
      ? raw.loadPerCore
      : loadAvg / cores;
  const pressure = normalizePressureValue(raw.memoryPressure ?? 'normal');

  if (!loadGate) {
    return {
      congested: false,
      reason: null,
      detail: null,
      loadPerCore,
      cores,
      memoryPressure: pressure.label,
    };
  }

  if (loadGate.maxLoadPerCore != null && loadPerCore > loadGate.maxLoadPerCore) {
    return {
      congested: true,
      reason: 'congested',
      trigger: 'maxLoadPerCore',
      detail: `load per core ${loadPerCore.toFixed(2)} > maxLoadPerCore ${loadGate.maxLoadPerCore}`,
      loadPerCore,
      cores,
      memoryPressure: pressure.label,
    };
  }

  if (loadGate.maxMemoryPressure != null) {
    const gate = loadGate.maxMemoryPressure;
    let over = false;
    if (typeof gate === 'string') {
      const gateRank = MEMORY_PRESSURE_RANKS[gate] || 2;
      // 'normal' is healthy and never trips; 'normal' gate trips on warn/critical (rank > 1);
      // 'warn' gate trips when pressure reaches warn or critical (rank >= 2);
      // 'critical' gate trips when pressure reaches critical (rank >= 3).
      if (pressure.rank > 1) {
        over = gate === 'normal' ? pressure.rank > 1 : pressure.rank >= gateRank;
      }
    } else if (typeof gate === 'number') {
      if (pressure.numeric != null) {
        over = pressure.numeric > gate;
      } else {
        const gateNorm = normalizePressureValue(gate);
        over = pressure.rank > 1 && pressure.rank >= gateNorm.rank;
      }
    }
    if (over) {
      return {
        congested: true,
        reason: 'congested',
        trigger: 'maxMemoryPressure',
        detail: `memory pressure "${pressure.label}" over maxMemoryPressure "${gate}"`,
        loadPerCore,
        cores,
        memoryPressure: pressure.label,
      };
    }
  }

  return {
    congested: false,
    reason: null,
    detail: null,
    loadPerCore,
    cores,
    memoryPressure: pressure.label,
  };
}

/* ----------------------------------------------------- prompt extraction & classifier */

export function extractClassifierPrompt(messages, fallbackPrompt = '') {
  if (typeof fallbackPrompt === 'string' && fallbackPrompt.trim()) {
    return fallbackPrompt.trim().slice(0, MAX_CLASSIFIER_PROMPT_CHARS);
  }
  if (!Array.isArray(messages) || !messages.length) return '';
  // Prefer the last user message(s); fall back to flattened transcript
  const userTexts = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string' && m.content.trim()) {
      userTexts.unshift(m.content.trim());
      break;
    }
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (parts) {
        userTexts.unshift(parts);
        break;
      }
    }
  }
  if (userTexts.length) {
    return userTexts.join('\n').slice(0, MAX_CLASSIFIER_PROMPT_CHARS);
  }
  const { prompt } = flattenMessages(messages);
  return String(prompt || '').trim().slice(0, MAX_CLASSIFIER_PROMPT_CHARS);
}

export function hashClassifierPrompt(promptText) {
  const norm = String(promptText || '').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${CLASSIFIER_SYSTEM_PROMPT}\0${norm}`).digest('hex').slice(0, 24);
}

/**
 * Parse a one-word complexity label (`simple` | `medium` | `complex`) from classifier output.
 * Returns null if the output does not contain a valid label.
 */
export function parseClassifierLabel(rawText) {
  if (typeof rawText !== 'string') return null;
  // Strip any `<think>...</think>` blocks if a reasoning model emitted them
  const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().toLowerCase();
  if (!cleaned) return null;
  const exact = cleaned.match(/^(simple|medium|complex)\b/);
  if (exact) return exact[1];
  const word = cleaned.match(/\b(simple|medium|complex)\b/);
  return word ? word[1] : null;
}

/**
 * Ask the classifier adapter/model for a one-word label (`simple` | `medium` | `complex`),
 * using a short cached prompt, tiny `max_tokens`, and low timeout.
 * Defaults to `medium` on any failure, timeout, or unparseable output.
 */
export async function classifyPrompt({
  vspec,
  adapter,
  promptText,
  session = null,
  cache = null,
  now = () => Date.now(),
  signal = null,
  unavailable = null,
}) {
  const t0 = Date.now();
  const nowMs = now();
  const promptHash = hashClassifierPrompt(promptText);
  const ttlMs =
    vspec.stickySeconds != null
      ? vspec.stickySeconds * 1000
      : DEFAULT_PROMPT_CACHE_SECONDS * 1000;

  if (cache && ttlMs > 0) {
    if (session) {
      const sKey = `${vspec.name}\0session:${session}`;
      const hit = cache.get(sKey);
      if (hit && nowMs - hit.at <= ttlMs) {
        return {
          label: hit.label,
          reason: 'sticky',
          cached: true,
          classifyMs: 0,
          promptHash,
        };
      }
    }
    const pKey = `${vspec.name}\0prompt:${promptHash}`;
    const hit = cache.get(pKey);
    if (hit && nowMs - hit.at <= ttlMs) {
      return {
        label: hit.label,
        reason: vspec.stickySeconds != null ? 'sticky' : 'cached',
        cached: true,
        classifyMs: 0,
        promptHash,
      };
    }
  }

  // `unavailable`: why the gateway will not have it asked now (the Kiro credit guard holds it back).
  if (!adapter || adapter.disabled || unavailable) {
    return {
      label: 'medium',
      reason: 'classifier_unavailable',
      error: unavailable ? String(unavailable) : adapter ? `classifier adapter "${vspec.classifierLeg.adapterId}" is disabled` : `classifier adapter "${vspec.classifierLeg.adapterId}" is not loaded`,
      cached: false,
      classifyMs: Math.max(0, Date.now() - t0),
      promptHash,
    };
  }

  const timeoutMs = vspec.classifierTimeoutMs || DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const maxTokens = vspec.classifierMaxTokens || DEFAULT_CLASSIFIER_MAX_TOKENS;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  let timedOut = false;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        reject(Object.assign(new Error(`classifier timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT', status: 504 }));
      }, timeoutMs);
      timer.unref?.();
    });

    const runClassifier = async () => {
      let out = '';
      const iter = adapter.complete({
        model: vspec.classifierLeg.model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: promptText || 'hello' }],
        maxTokens,
        temperature: 0,
        signal: ac.signal,
      });
      for await (const ev of iter) {
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          out += ev.text;
          const early = parseClassifierLabel(out);
          if (early && out.length >= early.length) {
            break;
          }
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'classifier error');
        } else if (ev.type === 'done') {
          break;
        }
      }
      return out;
    };

    const rawReply = await Promise.race([runClassifier(), timeoutPromise]);
    const classifyMs = Math.max(0, Date.now() - t0);
    const label = parseClassifierLabel(rawReply);

    if (!label) {
      return {
        label: 'medium',
        reason: 'classifier_invalid',
        rawReply: String(rawReply || '').slice(0, 80),
        cached: false,
        classifyMs,
        promptHash,
      };
    }

    if (cache && ttlMs > 0) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      const entry = { label, at: now() };
      cache.set(`${vspec.name}\0prompt:${promptHash}`, entry);
      if (session) cache.set(`${vspec.name}\0session:${session}`, entry);
    }

    return {
      label,
      reason: 'classified',
      cached: false,
      classifyMs,
      promptHash,
    };
  } catch (err) {
    const classifyMs = Math.max(0, Date.now() - t0);
    const isTimeout = timedOut || err?.code === 'ETIMEDOUT' || err?.status === 504 || /timed?\s*out|timeout/i.test(String(err?.message || ''));
    return {
      label: 'medium',
      reason: isTimeout ? 'classifier_timeout' : 'classifier_error',
      error: err?.message || String(err),
      cached: false,
      classifyMs,
      promptHash,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/* ------------------------------------------- tier & candidate resolution + fallthrough */

/**
 * Build the ordered list of candidate `{ adapterId, model, target, tier, local }` legs
 * for a virtual model decision.
 *
 * - When `congested` is true:
 *   If `tiers.congested` is configured, tries `tiers.congested` first, then remote candidates
 *   of `medium` and `complex`.
 *   Otherwise, routes to the first remote candidate of `medium` (followed by remaining remote
 *   candidates of `medium` and `complex`; if no remote candidates exist at all, falls back to
 *   all candidates of `medium` and `complex`).
 * - When `congested` is false:
 *   Starts at `label` (`simple` | `medium` | `complex`) and escalates up (`simple` -> `medium` -> `complex`).
 */
export function buildVirtualCandidateList(vspec, { label = 'medium', congested = false, adapters = null, cfgAdapters = null } = {}) {
  const seen = new Set();
  const candidates = [];

  const decorate = (leg, tier) => {
    const adapter = adapters?.get?.(leg.adapterId) || null;
    const rawCfg = own(cfgAdapters, leg.adapterId) ? cfgAdapters[leg.adapterId] : null;
    return {
      adapterId: leg.adapterId,
      model: leg.model,
      target: leg.target,
      tier,
      local: isLocalAdapter(leg.adapterId, adapter, rawCfg),
    };
  };

  const pushUnique = (item) => {
    if (seen.has(item.target)) return;
    seen.add(item.target);
    candidates.push(item);
  };

  if (congested) {
    if (Array.isArray(vspec.tierLegs.congested) && vspec.tierLegs.congested.length > 0) {
      for (const leg of vspec.tierLegs.congested) {
        pushUnique(decorate(leg, 'congested'));
      }
      for (const t of ['medium', 'complex']) {
        for (const leg of vspec.tierLegs[t] || []) {
          const dec = decorate(leg, t);
          if (!dec.local) pushUnique(dec);
        }
      }
    } else {
      const mediumDecorated = (vspec.tierLegs.medium || []).map((l) => decorate(l, 'medium'));
      const complexDecorated = (vspec.tierLegs.complex || []).map((l) => decorate(l, 'complex'));
      for (const dec of mediumDecorated) {
        if (!dec.local) pushUnique(dec);
      }
      for (const dec of complexDecorated) {
        if (!dec.local) pushUnique(dec);
      }
      // If every candidate in medium and complex was local, keep medium -> complex so there is still a target
      if (candidates.length === 0) {
        for (const dec of [...mediumDecorated, ...complexDecorated]) pushUnique(dec);
      }
    }
    return candidates;
  }

  const startIdx = Math.max(0, TIER_ORDER.indexOf(label));
  const activeTiers = TIER_ORDER.slice(startIdx);
  for (const tier of activeTiers) {
    for (const leg of vspec.tierLegs[tier] || []) {
      pushUnique(decorate(leg, tier));
    }
  }
  return candidates;
}

/**
 * Determine whether an error from a candidate leg should trigger fallthrough to the next
 * candidate / next tier up (429, rate limit, quota, spend cap, timeout, 5xx, upstream down).
 */
export function isFallthroughError(err) {
  if (!err) return false;
  if (err.code === 'foreign_tool') return false;
  const status = Number(err.status || err.statusCode || 0);
  if (status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status >= 500 && status <= 599) return true;
  // CLI NUL-byte 400 can fall through to an HTTP leg
  const msg = String(err.message || err);
  if (status === 400 && !/NUL/.test(msg)) return false;
  if (status === 401 || status === 403) return false;
  if (
    err.code === 'ETIMEDOUT' ||
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    /429|rate[_\s-]?limit|quota|exhausted|overage|spend cap|too many requests|timed?\s*out|timeout|overloaded|502|503|504|is down|ECONNREFUSED|ECONNRESET|fetch failed/i.test(
      msg,
    )
  ) {
    return true;
  }
  // Default pre-output adapter errors (e.g. CLI non-zero exit before output) fall through like aliases
  return status === 0 || status >= 500;
}

/**
 * Format the human-readable output of `keysmith route explain <virtualModel> "<prompt>"`.
 */
export function formatRouteExplain(explanation) {
  const lines = [];
  lines.push(`virtual model: ${explanation.virtual}`);
  lines.push(`prompt:        ${JSON.stringify(explanation.prompt)}`);
  lines.push(`classifier:    ${explanation.classifier}${explanation.congested ? ' (skipped — machine congested)' : ''}`);
  if (explanation.loadGate) {
    const lg = [];
    if (explanation.loadGate.maxLoadPerCore != null) {
      lg.push(`loadPerCore=${explanation.load.loadPerCore.toFixed(2)} (max ${explanation.loadGate.maxLoadPerCore})`);
    }
    if (explanation.loadGate.maxMemoryPressure != null) {
      lg.push(`memoryPressure=${explanation.load.memoryPressure} (max ${explanation.loadGate.maxMemoryPressure})`);
    }
    lines.push(`load gate:     ${lg.join(', ')} -> ${explanation.congested ? `CONGESTED (${explanation.load.detail})` : 'ok'}`);
  } else {
    lines.push(`load gate:     none (loadPerCore=${explanation.load.loadPerCore.toFixed(2)}, memoryPressure=${explanation.load.memoryPressure})`);
  }
  lines.push(`label:         ${explanation.label}`);
  lines.push(`tier:          ${explanation.tier}`);
  lines.push(`reason:        ${explanation.reason}${explanation.classifyError ? ` (${explanation.classifyError})` : ''}`);
  lines.push(`chosen:        ${explanation.chosen || '(none)'}`);
  lines.push(`fallbacks:     ${explanation.fallbacks.length ? explanation.fallbacks.join(' -> ') : '(none)'}`);
  if (explanation.skipped?.length) {
    lines.push(`skipped:       ${explanation.skipped.join(', ')}`);
  }
  lines.push(`latency:       ${explanation.latency}ms (dry-run; target not called)`);
  return lines.join('\n');
}
