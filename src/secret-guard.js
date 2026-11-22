import { GOOGLE_KEY_SHAPE, KEY_SHAPE } from './redact.js';

/**
 * Outbound secret guard (`guard.secrets`: "off" | "block" | "mask").
 *
 * Scans parsed JSON request bodies for fixed, anchored secret shapes before a request goes
 * upstream. Shapes are linear-time (no nested quantifiers over overlapping classes) so bodies up
 * to the server's 32 MB ceiling run in a single pass on the event loop without skipping large
 * prompts. Secret values are never copied into errors or logs — callers receive `kind` names only.
 */

export const SECRET_MODES = ['off', 'block', 'mask'];

const SHAPES = [
  ['pem-private-key', /-----BEGIN (?:[A-Z0-9_-]{1,32} ){0,4}PRIVATE KEY-----/g],
  ['aws-access-key', /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g],
  ['github-token', /(?<![A-Za-z0-9])(?:gh[po]_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])|github_pat_[A-Za-z0-9_]{20,255}(?![A-Za-z0-9_]))/g],
  ['slack-token', /(?<![A-Za-z0-9])xox[baprs]-(?=[A-Za-z0-9-]{10})[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g],
  ['google-api-key', new RegExp(`(?<![A-Za-z0-9])${GOOGLE_KEY_SHAPE.source}`, 'g')],
  ['sk-api-key', /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/g],
  ['keysmith-key', new RegExp(`(?<![A-Za-z0-9])${KEY_SHAPE.source}`, 'g')],
];

/** Protocol identifier fields whose string values are routing/state IDs, never prompt text. */
export const SKIP_STRING_KEYS = new Set(['model', 'id', 'tool_call_id', 'call_id', 'previous_response_id']);

/** Structural enum fields excluded only from cross-field split assembly so content blocks stay adjacent. */
const STRUCTURAL_KEYS = new Set(['role', 'type', 'object', 'status', 'finish_reason', 'stop_reason']);

const SPLIT_WINDOW = 128;

/**
 * Find every non-overlapping known secret shape in `text`, sorted by start offset.
 * Returns `[{ kind, start, end }]`.
 */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const raw = [];
  for (const [kind, re] of SHAPES) {
    for (const m of text.matchAll(re)) {
      raw.push({ kind, start: m.index, end: m.index + m[0].length });
    }
  }
  if (raw.length <= 1) return raw;
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const hit of raw) {
    const last = out[out.length - 1];
    if (last && hit.start < last.end) continue;
    out.push(hit);
  }
  return out;
}

export const PII_MODES = ['off', 'mask', 'block'];
export const INJECTION_MODES = ['off', 'log', 'block'];
export const PII_TYPES = ['national-id', 'iban', 'card', 'email', 'phone'];
/** What `guard.pii` looks for when `types` is not given: phone numbers are opt-in. */
export const PII_DEFAULT_TYPES = ['national-id', 'iban', 'card', 'email'];

const SECRETS_BAD_SHAPE = 'invalid guard setting (expected { "secrets": "off" | "block" | "mask" }), treated as block';
const SECRETS_BAD_FIELD = 'unknown field in guard (expected guard.secrets, guard.pii or guard.injection), treated as block';
const SECRETS_BAD_VALUE = 'invalid value (expected "off", "block" or "mask"), treated as block';
const PII_BAD_VALUE = 'invalid value (expected "off", "mask", "block" or { mode, types }), treated as block';
const INJECTION_BAD_VALUE = 'invalid value (expected "off", "log" or "block"), treated as block';

function parsePii(v) {
  if (v === undefined || v === 'off') return { mode: 'off', types: PII_DEFAULT_TYPES, error: null };
  if (v === 'mask' || v === 'block') return { mode: v, types: PII_DEFAULT_TYPES, error: null };
  const bad = { mode: 'block', types: PII_DEFAULT_TYPES, error: PII_BAD_VALUE };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad;
  for (const k of Object.keys(v)) if (k !== 'mode' && k !== 'types') return bad;
  if (!PII_MODES.includes(v.mode)) return bad;
  let types = PII_DEFAULT_TYPES;
  if (v.types !== undefined) {
    if (!Array.isArray(v.types) || !v.types.length || !v.types.every((t) => PII_TYPES.includes(t))) return bad;
    types = [...new Set(v.types)];
  }
  return { mode: v.mode, types, error: null };
}

/**
 * Resolve the whole `cfg.guard` block into
 * `{ secrets, pii: { mode, types }, injection, error, errors }`.
 * Each scanner that gets an invalid value fails closed to "block"; an unknown field or a
 * non-object block fails closed on secrets. Errors never carry the offending value.
 * `errors` is `[{ key, message }]`, `error` the first message (or null).
 */
export function guardConfig(cfg) {
  const off = { secrets: 'off', pii: { mode: 'off', types: PII_DEFAULT_TYPES }, injection: 'off', error: null, errors: [] };
  const g = cfg?.guard;
  if (g === undefined) return off;
  const errors = [];
  const out = { secrets: 'off', pii: { mode: 'off', types: PII_DEFAULT_TYPES }, injection: 'off' };
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return {
      secrets: 'block',
      pii: { mode: 'block', types: PII_DEFAULT_TYPES },
      injection: 'block',
      error: SECRETS_BAD_SHAPE,
      errors: [{ key: 'guard', message: SECRETS_BAD_SHAPE }],
    };
  }
  if (Object.keys(g).some((k) => k !== 'secrets' && k !== 'pii' && k !== 'injection')) {
    out.secrets = 'block';
    errors.push({ key: 'secrets', message: SECRETS_BAD_FIELD });
  } else if (g.secrets === 'block' || g.secrets === 'mask') {
    out.secrets = g.secrets;
  } else if (g.secrets !== undefined && g.secrets !== 'off') {
    out.secrets = 'block';
    errors.push({ key: 'secrets', message: SECRETS_BAD_VALUE });
  }
  const p = parsePii(g.pii);
  out.pii = { mode: p.mode, types: p.types };
  if (p.error) errors.push({ key: 'pii', message: p.error });
  if (g.injection === undefined || g.injection === 'off') out.injection = 'off';
  else if (g.injection === 'log' || g.injection === 'block') out.injection = g.injection;
  else {
    out.injection = 'block';
    errors.push({ key: 'injection', message: INJECTION_BAD_VALUE });
  }
  return { ...out, error: errors[0]?.message ?? null, errors };
}

/**
 * Resolve `cfg.guard.secrets` into `{ mode, error }`.
 * Absent or `"off"` -> `{ mode: "off", error: null }`.
 * Any invalid shape or value fails closed to `"block"` and returns a value-free error message.
 */
export function guardMode(cfg) {
  const c = guardConfig(cfg);
  const e = c.errors.find((x) => x.key === 'secrets' || x.key === 'guard');
  return { mode: c.secrets, error: e ? e.message : null };
}

/**
 * Walk every string in `body` (except `SKIP_STRING_KEYS`).
 * - `mode: "block"` returns the deduplicated list of secret `kind`s found (`string[]`).
 * - `mode: "mask"` returns a copy of `body` with each match replaced by `[REDACTED:<kind>]`.
 * - `mode: "off"` returns `body` unchanged.
 */
export function guardBody(body, { mode = 'block' } = {}) {
  if (mode === 'off' || !mode) return body;
  const res = applySecretGuard(body, mode);
  return mode === 'block' ? res.kinds : res.body;
}

/**
 * Single-pass helper for HTTP handlers: returns `{ body, kinds }` where `body` is a masked copy
 * when `mode === "mask"` (or the input when `mode === "block"` / `"off"`).
 */
export function applySecretGuard(body, mode = 'off') {
  if (mode !== 'block' && mode !== 'mask') return { body, kinds: [] };
  if (typeof body === 'string') {
    const hits = findSecrets(body);
    if (!hits.length) return { body, kinds: [] };
    const kinds = uniqueKinds(hits);
    return { body: mode === 'mask' ? replaceHits(body, hits) : body, kinds };
  }
  if (!body || typeof body !== 'object') {
    return { body, kinds: [] };
  }

  const root = mode === 'mask' ? cloneJson(body) : body;
  const leaves = [];
  collectLeaves(root, null, leaves, true);

  const seen = new Set();
  const kinds = [];
  const addKind = (k) => {
    if (!seen.has(k)) {
      seen.add(k);
      kinds.push(k);
    }
  };

  for (const leaf of leaves) {
    const hits = findSecrets(leaf.value);
    if (!hits.length) continue;
    for (const h of hits) addKind(h.kind);
    if (mode === 'mask') {
      leaf.value = replaceHits(leaf.value, hits);
      leaf.holder[leaf.prop] = leaf.value;
    } else {
      leaf.hits = hits;
    }
  }

  // Catch secrets split across adjacent prompt parts (e.g. PEM header split across `system` and `messages`).
  const textLeaves = leaves.filter((l) => !STRUCTURAL_KEYS.has(l.keyName) && l.value.length > 0);
  for (let i = 0; i + 1 < textLeaves.length; i++) {
    const a = textLeaves[i];
    const b = textLeaves[i + 1];
    const split = findStraddlingSecret(a, b, mode === 'block');
    if (!split) continue;
    addKind(split.kind);
    if (mode === 'mask') {
      a.value = a.value.slice(0, split.aCutStart) + `[REDACTED:${split.kind}]`;
      b.value = b.value.slice(split.bCutEnd);
      a.holder[a.prop] = a.value;
      b.holder[b.prop] = b.value;
    }
  }

  return { body: root, kinds };
}

/* ------------------------------------------------------------------------ internals */

function uniqueKinds(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    if (!seen.has(h.kind)) {
      seen.add(h.kind);
      out.push(h.kind);
    }
  }
  return out;
}

function replaceHits(text, hits) {
  let out = '';
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + `[REDACTED:${h.kind}]`;
    at = h.end;
  }
  return out + text.slice(at);
}

export function cloneJson(v) {
  if (Array.isArray(v)) return v.map(cloneJson);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneJson(val);
    return out;
  }
  return v;
}

function orderedEntries(obj, isRoot) {
  if (!isRoot) return Object.entries(obj);
  // Visit `system` and `instructions` before `messages` / `input` regardless of JSON key order.
  const out = [];
  for (const prefixKey of ['system', 'instructions']) {
    if (Object.hasOwn(obj, prefixKey)) out.push([prefixKey, obj[prefixKey]]);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'system' || k === 'instructions') continue;
    out.push([k, v]);
  }
  return out;
}

export function collectLeaves(node, parentKey, leaves, isRoot = false) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const val = node[i];
      if (typeof val === 'string') {
        leaves.push({ holder: node, prop: i, keyName: parentKey || '', value: val, hits: null });
      } else if (val && typeof val === 'object') {
        collectLeaves(val, parentKey, leaves, false);
      }
    }
    return;
  }
  for (const [k, val] of orderedEntries(node, isRoot)) {
    if (typeof val === 'string') {
      if (SKIP_STRING_KEYS.has(k)) continue;
      leaves.push({ holder: node, prop: k, keyName: k, value: val, hits: null });
    } else if (val && typeof val === 'object') {
      collectLeaves(val, k, leaves, false);
    }
  }
}

function findStraddlingSecret(a, b, checkExistingHits) {
  const aStart = Math.max(0, a.value.length - SPLIT_WINDOW);
  const tail = a.value.slice(aStart);
  const head = b.value.slice(0, SPLIT_WINDOW);
  if (!tail || !head) return null;

  for (const [sep, onlyPem] of [['', false], [' ', true]]) {
    const joined = tail + sep + head;
    const hits = findSecrets(joined);
    for (const h of hits) {
      if (onlyPem && h.kind !== 'pem-private-key') continue;
      if (h.start >= tail.length || h.end <= tail.length + sep.length) continue;
      const aCutStart = aStart + h.start;
      const bCutEnd = h.end - sep.length - tail.length;
      if (checkExistingHits) {
        if ((a.hits || []).some((x) => x.end > aCutStart)) continue;
        if ((b.hits || []).some((x) => x.start < bCutEnd)) continue;
      }
      return { kind: h.kind, aCutStart, bCutEnd };
    }
  }
  return null;
}
