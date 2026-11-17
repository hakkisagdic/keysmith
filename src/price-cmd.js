/**
 * `keysmith price list|set`: the price table, and the one way the config's `pricing` is written.
 * `set` validates every number, copies the file to a dated backup, then writes it through a temp
 * file and a rename, mode 0600 (the helpers `config` uses). Nothing else is touched.
 */
import { mergedPriceEntries, DEFAULT_PRICING, PRICE_SOURCE } from './usage.js';
import { readRaw, backupFile, writeJsonAtomic } from './config-edit.js';

const FIELDS = [
  ['input', 'input', true],
  ['output', 'output', true],
  ['cacheRead', 'cache-read', true],
  ['cacheWrite', 'cache-write-5m', true],
  ['cacheWrite1h', 'cache-write-1h', false],
];
const NUM = /^\d+(\.\d+)?$/;
const BAD_NAME = new Set(['__proto__', 'constructor', 'prototype']);

const num = (v) => (v == null ? '-' : String(Number(v)));

function sourceOf(pattern, rates) {
  const def = DEFAULT_PRICING[pattern];
  const same = def && FIELDS.every(([k]) => def[k] == null || Number(def[k]) === Number(rates[k])) && Number(def.batchFactor ?? 0.5) === Number(rates.batchFactor ?? 0.5);
  if (same) return `${PRICE_SOURCE.url} read ${PRICE_SOURCE.date}`;
  return rates.setAt ? `config, set ${rates.setAt}` : 'config';
}

/** The table, one line per entry (USD per million tokens), each with where its numbers come from. */
export function priceList(pricing, filter = null) {
  const lines = [`USD per million tokens. Built-in rates: ${PRICE_SOURCE.url}, read ${PRICE_SOURCE.date}.`];
  lines.push('pattern                          input  output  cache-read  cache-write-5m  cache-write-1h  batch  source');
  const want = filter && filter !== true ? String(filter) : null;
  const entries = mergedPriceEntries(pricing).slice().sort((a, b) => a.pattern.localeCompare(b.pattern));
  for (const { pattern, rates } of entries) {
    if (want && !pattern.includes(want)) continue;
    if (!rates) { lines.push(`${pattern.padEnd(32)} (no price on purpose: set to null in the config)`); continue; }
    const w1h = rates.cacheWrite1h != null ? num(rates.cacheWrite1h) : `${num(2 * (Number(rates.input) || 0))} (2x input)`;
    lines.push(
      `${pattern.padEnd(32)} ${num(rates.input).padStart(6)} ${num(rates.output).padStart(7)} ${num(rates.cacheRead).padStart(11)} ${num(rates.cacheWrite).padStart(15)} ${w1h.padStart(15)} ${num(rates.batchFactor ?? 0.5).padStart(6)}  ${sourceOf(pattern, rates)}`,
    );
  }
  if (lines.length === 2) lines.push(want ? `no entry matches "${want}"` : '(empty)');
  return lines;
}

function value(flagName, raw, required) {
  if (raw === undefined) {
    if (required) throw new Error(`--${flagName} is required (USD per million tokens, e.g. 1.25)`);
    return undefined;
  }
  if (typeof raw !== 'string' || !NUM.test(raw.trim())) throw new Error(`--${flagName} takes a number of 0 or more (USD per million tokens), not "${raw === true ? '' : raw}"`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`--${flagName} takes a number from 0 to 100000, not ${raw}`);
  return n;
}

/** The entry `flags` describe, or throws a message naming what is wrong. */
export function priceEntry(flags) {
  const entry = {};
  for (const [field, flag, required] of FIELDS) {
    const v = value(flag, flags[flag.replace(/-(\w)/g, (_, c) => c.toUpperCase())], required);
    if (v !== undefined) entry[field] = v;
  }
  const bf = flags.batchFactor;
  if (bf !== undefined) {
    const f = typeof bf === 'string' && NUM.test(bf.trim()) ? Number(bf) : NaN;
    if (!(f > 0 && f <= 1)) throw new Error(`--batch-factor takes a number above 0 and up to 1 (0.5 is half price), not "${bf === true ? '' : bf}"`);
    entry.batchFactor = f;
  }
  return entry;
}

/** Validates, then writes `pricing.<pattern>`. Returns { lines, changed, backup }. Writes nothing when `write` is false. */
export function priceSet(file, pattern, flags, { write = true } = {}) {
  const p = String(pattern || '').trim();
  const model = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
  if (!p || /\s/.test(p) || !model || BAD_NAME.has(p) || BAD_NAME.has(model) || p.length > 200) {
    throw new Error('usage: keysmith price set <adapter/model pattern, e.g. "*/claude-haiku-4-5*"> --input N --output N --cache-read N --cache-write-5m N [--cache-write-1h N] [--batch-factor F]');
  }
  const entry = priceEntry(flags);
  entry.setAt = new Date().toISOString().slice(0, 10);
  const doc = readRaw(file);
  if (doc.pricing != null && (typeof doc.pricing !== 'object' || Array.isArray(doc.pricing))) throw new Error(`${file}: "pricing" is not an object`);
  const before = doc.pricing && Object.hasOwn(doc.pricing, p) ? doc.pricing[p] : undefined;
  const strip = (e) => { if (!e) return e; const { setAt, ...rest } = e; return rest; };
  const same = before !== undefined && JSON.stringify(strip(before)) === JSON.stringify(strip(entry));
  const lines = same
    ? [`pricing.${p}: ${JSON.stringify(before)} (unchanged)`]
    : [...(before !== undefined ? [`- pricing.${p}: ${JSON.stringify(before)}`] : []), `+ pricing.${p}: ${JSON.stringify(entry)}`];
  if (same || !write) return { lines, changed: false };
  const backup = backupFile(file, 'price');
  doc.pricing = { ...(doc.pricing || {}), [p]: entry };
  writeJsonAtomic(file, doc);
  return { lines, changed: true, backup };
}
