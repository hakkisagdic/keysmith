/**
 * Text-free sparse vectors and guard tokens for semantic cache lookup.
 *
 * Zero external dependencies. Extracts hashed word unigrams and hashed character
 * 3-grams from at most the first 4 KB of the last user turn, plus a SHA-256
 * digest of guard tokens (numbers, currency/comparison symbols, negations, and
 * decisive polarity words) so pairs that differ on a decisive token never hit.
 * Neither raw prompt text nor token strings are retained on cached vectors.
 */

import { createHash } from 'node:crypto';

export const MAX_INPUT_BYTES = 4096;
export const MAX_VECTOR_TERMS = 512;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'of', 'for', 'please',
]);

const NEG_NOT_RE = /^(?:not|cannot|cant|[a-z]+n['’]t)$/;

const NEG_WORDS = new Set([
  'no', 'never', 'none', 'nothing', 'nobody', 'nowhere', 'neither', 'nor',
  'without', 'unless', 'except', 'non',
  'değil', 'yok', 'hiç', 'asla', 'hayır', 'olmadan', 'hariç',
]);

const NUM_WORDS = new Set([
  'zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'hundred', 'thousand', 'million', 'billion', 'once', 'twice',
  'sıfır', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz',
  'yüz', 'bin', 'milyon',
]);

const DECISIVE_WORDS = new Set([
  'true', 'false', 'yes', 'off', 'always',
  'enable', 'enabled', 'disable', 'disabled',
  'allow', 'allowed', 'deny', 'denied', 'block', 'blocked',
  'include', 'including', 'included', 'exclude', 'excluding', 'excluded',
  'public', 'private', 'internal', 'external',
  'before', 'after', 'above', 'below', 'under', 'over',
  'min', 'minimum', 'max', 'maximum', 'asc', 'ascending', 'desc', 'descending',
  'increase', 'decrease', 'add', 'remove', 'delete', 'drop', 'keep',
  'annual', 'yearly', 'monthly', 'weekly', 'daily', 'hourly',
  'free', 'paid', 'trial', 'enterprise',
  'refund', 'cancel', 'upgrade', 'downgrade',
  'prod', 'production', 'staging', 'dev', 'development',
  'usd', 'eur', 'gbp', 'try', 'tl',
]);

/** Cap input text to `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
export function capInputBytes(text, maxBytes = MAX_INPUT_BYTES) {
  if (maxBytes <= 0) return '';
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  let i = buf.length - 1;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) i--;
  if (i >= 0 && (buf[i] & 0x80) !== 0) {
    const b = buf[i];
    const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
    if (buf.length - i < need) return buf.subarray(0, i).toString('utf8');
  }
  return buf.toString('utf8');
}

/** Normalize Unicode NFKC and lowercase while stripping Turkish combining dot above. */
export function lowerUnicode(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\u0307/g, '');
}

/**
 * Sorted list of decisive guard tokens (numbers, currency/comparison symbols,
 * negations, and polarity/domain words). Used to block false semantic hits.
 */
export function guardTokens(text) {
  const raw = lowerUnicode(capInputBytes(text));
  const found = new Set();

  for (const m of raw.matchAll(/[$€£¥₺%]|<=|>=|!=|==|[<>]/g)) {
    found.add(`sym:${m[0]}`);
  }

  const numNormalized = raw.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (m) => m.replace(/,/g, ''));
  for (const m of numNormalized.matchAll(/(?:^|[\s(=<>])-(\d+(?:\.\d+)*)/g)) {
    found.add(`num:-${m[1]}`);
  }
  for (const m of numNormalized.matchAll(/\d+(?:\.\d+)*/g)) {
    found.add(`num:${m[0]}`);
  }

  const words = raw.replace(/[^\p{L}\p{N}'’\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (NEG_NOT_RE.test(w)) {
      found.add('neg:not');
      continue;
    }
    const clean = w.replace(/['’].*$/, '');
    if (!clean) continue;
    if (NEG_WORDS.has(clean)) found.add(`neg:${clean}`);
    else if (NUM_WORDS.has(clean)) found.add(`numw:${clean}`);
    else if (DECISIVE_WORDS.has(clean)) found.add(`dec:${clean}`);
  }

  return [...found].sort();
}

/** SHA-256 hex digest of guard tokens so no token text is stored on cache entries. */
export function guardHashFor(tokens) {
  return createHash('sha256').update(tokens.join('\0')).digest('hex');
}

/** Dual 32-bit FNV-1a hash combined into a 52-bit safe integer key. */
export function hashFeature(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i) & 0xffff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1 * 0x100000 + (h2 >>> 12);
}

function expandContractions(s) {
  return s
    .replace(/\bcan['’]t\b/g, 'can not')
    .replace(/\bwon['’]t\b/g, 'will not')
    .replace(/\bshan['’]t\b/g, 'shall not')
    .replace(/\b([a-z]+)n['’]t\b/g, '$1 not')
    .replace(/\b(what|where|when|who|how|it|that|there|here)['’]s\b/g, '$1 is')
    .replace(/\b(what|where|they|we|you)['’]re\b/g, '$1 are')
    .replace(/\bi['’]m\b/g, 'i am')
    .replace(/\b(i|we|you|they)['’]ve\b/g, '$1 have')
    .replace(/\b(i|we|you|they|it)['’]ll\b/g, '$1 will');
}

/**
 * Build a text-free sparse vector `{ terms: Map<number, number>, norm: number, guardHash: string }`
 * from at most the first 4 KB of `text`.
 */
export function buildVector(text) {
  const capped = capInputBytes(text, MAX_INPUT_BYTES);
  const guardHash = guardHashFor(guardTokens(capped));
  const expanded = expandContractions(lowerUnicode(capped));
  const normText = expanded.replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normText) return { terms: new Map(), norm: 0, guardHash };

  const allWords = normText.split(' ').filter(Boolean);
  const filtered = allWords.filter((w) => !STOPWORDS.has(w));
  const words = filtered.length ? filtered : allWords;

  const weights = new Map();
  for (const w of words) {
    const k = hashFeature(`w:${w}`);
    weights.set(k, (weights.get(k) || 0) + 1.0);
  }

  const compact = words.join('_');
  if (compact.length <= 3) {
    const k = hashFeature(`g:${compact}`);
    weights.set(k, (weights.get(k) || 0) + 1.0);
  } else {
    for (let i = 0; i <= compact.length - 3; i++) {
      const k = hashFeature(`g:${compact.slice(i, i + 3)}`);
      weights.set(k, (weights.get(k) || 0) + 1.0);
    }
  }

  let terms = weights;
  if (weights.size > MAX_VECTOR_TERMS) {
    const top = [...weights.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, MAX_VECTOR_TERMS);
    terms = new Map(top);
  }

  let sq = 0;
  for (const v of terms.values()) sq += v * v;
  return { terms, norm: Math.sqrt(sq), guardHash };
}

/** Cosine similarity in `[0, 1]` between two sparse vectors built by `buildVector`. */
export function cosine(a, b) {
  if (!a || !b || !a.norm || !b.norm || !(a.terms instanceof Map) || !(b.terms instanceof Map)) return 0;
  const [small, large] = a.terms.size <= b.terms.size ? [a.terms, b.terms] : [b.terms, a.terms];
  let dot = 0;
  for (const [k, v] of small) {
    const o = large.get(k);
    if (o !== undefined) dot += v * o;
  }
  return Math.max(0, Math.min(1, dot / (a.norm * b.norm)));
}

/**
 * Extract plain text from the last `user` message if and only if the request
 * ends on a `user` turn containing only string / text parts (no images/files).
 * Returns `null` when ineligible for semantic cache lookup or storage.
 */
export function lastUserText(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return null;
  if (last.role !== 'user') return null;
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content) && last.content.length > 0) {
    const parts = [];
    for (const p of last.content) {
      if (typeof p === 'string') {
        parts.push(p);
        continue;
      }
      if (p && typeof p === 'object' && !Array.isArray(p) && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
        parts.push(p.text);
        continue;
      }
      return null;
    }
    return parts.join('\n');
  }
  return null;
}
