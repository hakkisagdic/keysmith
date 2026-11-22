import { PII_DEFAULT_TYPES, cloneJson, collectLeaves } from './secret-guard.js';

/**
 * Request-side personal-data and prompt-injection guard (`guard.pii`, `guard.injection`).
 *
 * Best effort on fixed shapes, not a DLP: checksum-valid national ids (Turkish TCKN), IBANs,
 * payment card numbers and email addresses (phone numbers opt-in). Every pattern is linear-time
 * (bounded repeats, digit-boundary lookarounds), so a 32 MB body is scanned in one pass. Matched
 * text is never copied into a result: callers get kinds, counts and pattern ids only.
 */

/** Calls per scanner since process start: lets a test prove a scanner does not run when off. */
export const scanCalls = { pii: 0, injection: 0 };

/* ------------------------------------------------------------------ validators */

/** 11-digit Turkish national id (TCKN) with its two check digits. */
export function isValidTckn(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length !== 11 || digits[0] === '0') return false;
  const d = Array.from(digits, Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  if (d[9] !== (((odd * 7 - even) % 10) + 10) % 10) return false;
  return d[10] === (odd + even + d[9]) % 10;
}

/** 13 to 19 digit payment card number (Luhn). */
export function isValidLuhn(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN (mod 97); a Turkish one must be 26 characters. */
export function isValidIban(raw) {
  const s = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  if (s.startsWith('TR') && s.length !== 26) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < r.length; i++) {
    const c = r.charCodeAt(i);
    if (c >= 65) rem = (rem * 100 + (c - 55)) % 97;
    else rem = (rem * 10 + (c - 48)) % 97;
  }
  return rem === 1;
}

/* ------------------------------------------------------------------ detectors */

// Priority order resolves overlaps: the more specific, checksum-backed shapes first.
const DETECTORS = [
  {
    kind: 'iban',
    re: /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?(?![A-Za-z0-9])/g,
    valid: isValidIban,
  },
  { kind: 'card', re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, valid: isValidLuhn },
  { kind: 'national-id', re: /(?<!\d)\d{11}(?!\d)/g, valid: isValidTckn },
  {
    kind: 'email',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g,
    valid: null,
  },
  {
    kind: 'phone',
    re: /(?<![\w+.-])\+?\d(?:[ .()-]?\d){9,13}(?!\d)/g,
    valid: (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 10 && n <= 14;
    },
  },
];

/**
 * Find personal-data shapes in `text`: `[{ kind, start, end }]` sorted by start, non-overlapping.
 * `types` limits the kinds looked for (default: everything but phone).
 */
export function findPii(text, types = PII_DEFAULT_TYPES) {
  if (typeof text !== 'string' || text.length < 8) return [];
  let accepted = [];
  for (const d of DETECTORS) {
    if (!types.includes(d.kind)) continue;
    const found = [];
    for (const m of text.matchAll(d.re)) {
      if (d.valid && !d.valid(m[0])) continue;
      found.push({ kind: d.kind, start: m.index, end: m.index + m[0].length });
    }
    if (!found.length) continue;
    accepted = mergeNonOverlapping(accepted, found);
  }
  return accepted;
}

/** Merge two start-sorted lists, dropping any of `add` that overlaps one in `base`. */
function mergeNonOverlapping(base, add) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < add.length) {
    const b = base[i];
    const a = add[j];
    if (a && (!b || a.start < b.start)) {
      // overlap with the previous kept hit or with the next base hit?
      const prev = out[out.length - 1];
      if ((!prev || a.start >= prev.end) && (!b || a.end <= b.start)) out.push(a);
      j++;
    } else {
      out.push(b);
      i++;
    }
  }
  return out;
}

/** True when `text` holds any personal-data shape (used to keep it out of a usage row). */
export function hasPii(text, types = PII_DEFAULT_TYPES) {
  return findPii(text, types).length > 0;
}

function maskText(text, hits) {
  let out = '';
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + `[REDACTED:${h.kind}]`;
    at = h.end;
  }
  return out + text.slice(at);
}

/**
 * Scan every string leaf of `body` (never `model`, `id`, `tool_call_id`, ...).
 * `mode: "mask"` returns a masked copy, `"block"` the input untouched. Returns
 * `{ body, kinds, counts }`: kinds in first-seen order, counts per kind.
 */
export function applyPiiGuard(body, { mode = 'off', types = PII_DEFAULT_TYPES } = {}) {
  if (mode !== 'mask' && mode !== 'block') return { body, kinds: [], counts: {} };
  scanCalls.pii++;
  const counts = {};
  const note = (hits) => {
    for (const h of hits) counts[h.kind] = (counts[h.kind] || 0) + 1;
  };
  if (typeof body === 'string') {
    const hits = findPii(body, types);
    note(hits);
    return { body: mode === 'mask' && hits.length ? maskText(body, hits) : body, kinds: Object.keys(counts), counts };
  }
  if (!body || typeof body !== 'object') return { body, kinds: [], counts: {} };
  const root = mode === 'mask' ? cloneJson(body) : body;
  const leaves = [];
  collectLeaves(root, null, leaves, true);
  for (const leaf of leaves) {
    const hits = findPii(leaf.value, types);
    if (!hits.length) continue;
    note(hits);
    if (mode === 'mask') leaf.holder[leaf.prop] = maskText(leaf.value, hits);
  }
  return { body: root, kinds: Object.keys(counts), counts };
}

/* ------------------------------------------------------------------ injection */

const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';

/** Well-known phrasing only; each id is a stable name written to the usage row. */
export const INJECTION_PATTERNS = [
  {
    id: 'ignore-previous',
    re: new RegExp(`${L}(?:ignore|disregard|forget)\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|prior|above|earlier|system)\\s+(?:instructions|prompts|rules|directions)${R}`, 'iu'),
  },
  {
    id: 'ignore-previous-tr',
    re: new RegExp(`${L}(?:önceki|yukarıdaki|tüm)\\s+(?:(?:önceki|yukarıdaki|tüm)\\s+)?(?:sistem\\s+)?(?:talimatlarını|talimatları|kurallarını|kuralları|komutlarını|komutları)\\s+(?:unut|yoksay|görmezden\\s+gel)${R}`, 'iu'),
  },
  {
    id: 'system-override',
    re: /<\|im_start\|>\s*system|\[SYSTEM\s*OVERRIDE\]|###\s*SYSTEM\s*PROMPT\s*OVERRIDE/i,
  },
  {
    id: 'reveal-system-prompt',
    re: new RegExp(`${L}(?:reveal|print|output|repeat)\\s+(?:your|the)\\s+(?:exact\\s+|full\\s+)?(?:system\\s+prompt|hidden\\s+instructions|developer\\s+message)${R}`, 'iu'),
  },
  {
    id: 'dan-jailbreak',
    re: new RegExp(`${L}(?:you\\s+are\\s+now\\s+DAN|do\\s+anything\\s+now\\s+mode|bypass\\s+all\\s+safety\\s+filters)${R}`, 'iu'),
  },
];

/** Ids of the injection patterns that match `text`. */
export function findInjection(text) {
  if (typeof text !== 'string' || text.length < 12) return [];
  const ids = [];
  for (const p of INJECTION_PATTERNS) if (p.re.test(text)) ids.push(p.id);
  return ids;
}

/**
 * Injection ids found in the request's string leaves. The top-level `system` and `instructions`
 * are the operator's own text and are not scanned; user, assistant, tool-result and input content is.
 */
export function scanInjection(body) {
  scanCalls.injection++;
  if (typeof body === 'string') return findInjection(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rest = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'system' || k === 'instructions') continue;
    rest[k] = v;
  }
  const leaves = [];
  collectLeaves(rest, null, leaves, true);
  const seen = new Set();
  for (const leaf of leaves) for (const id of findInjection(leaf.value)) seen.add(id);
  return [...seen];
}
