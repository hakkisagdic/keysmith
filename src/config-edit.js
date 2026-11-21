/**
 * `keysmith config get|set|unset <dotted.key> [value]`: the top-level settings that have no
 * command of their own (discovery, catalogue, tunnel, limits …). It edits the file as written —
 * nothing the loader merges in is written back — after a dated backup, through a temp file and a
 * rename, mode 0600. `adapters.*`, `aliases.*` and `auth.keys` are not here: they have commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { jsonErrorWithoutText } from './config.js';
import { redactKey } from './redact.js';

const T = {
  bool: { type: 'bool' },
  str: { type: 'string' },
  nstr: { type: 'string', nullable: true },
  int: (min = 1, max = Number.MAX_SAFE_INTEGER) => ({ type: 'int', min, max }),
  oneOf: (values) => ({ type: 'enum', values }),
};

/** Known dotted keys. `discovery.<adapter>.<…>` is matched by `schemaFor`. */
export const SCHEMA = {
  host: T.str,
  port: T.int(0, 65535),
  'auth.enabled': T.bool,
  'log.usage': T.bool,
  'log.body': T.bool,
  'guard.secrets': T.oneOf(['off', 'block', 'mask']),
  'limits.maxConcurrent': T.int(),
  'limits.timeoutMs': T.int(),
  'limits.streamHoldMs': T.int(0),
  'limits.streamKeepaliveMs': T.int(0),
  'tunnel.provider': T.str,
  'tunnel.name': T.nstr,
  'tunnel.hostname': T.nstr,
  'tunnel.configFile': T.nstr,
  catalogue: T.nstr,
  'discovery.enabled': T.bool,
  'batch.enabled': T.bool,
};
const DISCOVERY_LEAF = /^discovery\.([A-Za-z0-9_-]+)\.(inputPricePath|outputPricePath|pricingUrl)$/;
const HTTPS_STR = { type: 'string', https: true };
const SECRETISH = /(^|\.)(keys?|apiKey|token|secret|password)$/i;

export function schemaFor(key) {
  if (Object.hasOwn(SCHEMA, key)) return SCHEMA[key];
  const m = DISCOVERY_LEAF.exec(key);
  if (m && !['__proto__', 'prototype', 'constructor', 'enabled'].includes(m[1])) return m[2] === 'pricingUrl' ? HTTPS_STR : T.str;
  return null;
}

export function knownKeys() {
  return [...Object.keys(SCHEMA), 'discovery.<adapter>.inputPricePath', 'discovery.<adapter>.outputPricePath'];
}

export function unknownKeyError(key) {
  return `"${key}" is not a setting \`config\` changes. Known keys:\n  ${knownKeys().join('\n  ')}\n  (adapters: keysmith add|set|remove; aliases: keysmith alias; keys: keysmith key)`;
}

/** The typed value for `raw`, or throws a message naming what the key takes. */
export function parseValue(key, schema, raw) {
  const s = String(raw);
  if (schema.nullable && s === 'null') return null;
  if (schema.type === 'bool') {
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw new Error(`${key} takes true or false, not "${s}"`);
  }
  if (schema.type === 'enum') {
    if (schema.values.includes(s)) return s;
    const shown = s.length <= 20 && !/^(AKIA|gh[po]_|github_pat_|xox[baprs]-|AIza|sk-|ks_|-----)/.test(s) ? `, not "${s}"` : '';
    throw new Error(`${key} takes ${schema.values.join(' | ')}${shown}`);
  }
  if (schema.type === 'int') {
    if (!/^-?\d+$/.test(s)) throw new Error(`${key} takes a whole number, not "${s}"`);
    const n = Number(s);
    if (n < schema.min || n > schema.max) throw new Error(`${key} takes a number from ${schema.min} to ${schema.max}, not ${n}`);
    return n;
  }
  if (!s.trim()) throw new Error(`${key} takes a non-empty string${schema.nullable ? ' (or null)' : ''}`);
  if (schema.https) {
    let u;
    try { u = new URL(s); } catch { throw new Error(`${key} takes an https address, and "${s.slice(0, 60)}" is not a URL`); }
    if (u.protocol !== 'https:') throw new Error(`${key} must be https (a price table is read from it), not ${u.protocol.replace(':', '')}`);
  }
  return s;
}

export function readRaw(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${e.code || e.message}`); }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc;
  } catch (e) {
    throw new Error(`${file}: ${jsonErrorWithoutText(e)}`);
  }
}

const own = (o, k) => o != null && typeof o === 'object' && Object.hasOwn(o, k);

export function getPath(doc, key) {
  let v = doc;
  for (const k of key.split('.')) {
    if (!own(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

export function setPath(doc, key, value) {
  const parts = key.split('.');
  let v = doc;
  for (const k of parts.slice(0, -1)) {
    if (!own(v, k) || v[k] == null || typeof v[k] !== 'object' || Array.isArray(v[k])) v[k] = {};
    v = v[k];
  }
  v[parts.at(-1)] = value;
}

export function unsetPath(doc, key) {
  const parts = key.split('.');
  let v = doc;
  for (const k of parts.slice(0, -1)) {
    if (!own(v, k)) return false;
    v = v[k];
  }
  if (!own(v, parts.at(-1))) return false;
  delete v[parts.at(-1)];
  return true;
}

/** What `config get` prints: keys by fingerprint, secret-looking strings shortened, references as they are. */
export function mask(key, v) {
  if (key === 'auth.keys' || key.startsWith('auth.keys.')) {
    const list = Array.isArray(v) ? v : [v];
    return list.map((k) => redactKey(typeof k === 'string' ? k : k?.key ?? ''));
  }
  if (v && typeof v === 'object') {
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) out[k] = mask(`${key}.${k}`, x);
    return out;
  }
  if (typeof v === 'string' && SECRETISH.test(key) && !/^\{\w+:/.test(v)) return redactKey(v);
  return v;
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Copies `file` to `file.bak-<YYYYMMDD-HHMMSS>-<tag>` (0600); never overwrites one. Returns its path. */
export function backupFile(file, tag = 'config') {
  const base = `${file}.bak-${stamp()}-${tag}`;
  for (let i = 0; ; i++) {
    const dest = i ? `${base}-${i}` : base;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, 0o600);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

export function writeJsonAtomic(file, doc) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

const show = (v) => (v === undefined ? '(unset)' : JSON.stringify(v));

/**
 * `get` | `set` | `unset`. Returns { lines, changed, backup }; writes only when `write` is true
 * and the value differs.
 */
export function configEdit(file, op, key, raw, { write = true } = {}) {
  if (!key) throw new Error('usage: keysmith config get|set|unset <dotted.key> [value] [--dry-run]');
  const doc = readRaw(file);
  if (op === 'get') {
    const v = getPath(doc, key);
    if (v === undefined) throw new Error(`${key} is not set in ${file}`);
    const m = mask(key, v);
    return { lines: [typeof m === 'string' ? m : JSON.stringify(m, null, 2)], changed: false };
  }
  const schema = schemaFor(key);
  if (!schema) throw new Error(unknownKeyError(key));
  const before = getPath(doc, key);
  let after;
  if (op === 'set') {
    if (raw === undefined || raw === true) throw new Error(`usage: keysmith config set ${key} <value>`);
    after = parseValue(key, schema, raw);
    setPath(doc, key, after);
  } else if (op === 'unset') {
    unsetPath(doc, key);
  } else {
    throw new Error('usage: keysmith config get|set|unset <dotted.key> [value] [--dry-run]');
  }
  const same = JSON.stringify(before) === JSON.stringify(after);
  const lines = same ? [`${key}: ${show(before)} (unchanged)`] : [`- ${key}: ${show(before)}`, `+ ${key}: ${show(after)}`];
  if (same || !write) return { lines, changed: false };
  const backup = backupFile(file, 'config');
  writeJsonAtomic(file, doc);
  return { lines, changed: true, backup };
}
