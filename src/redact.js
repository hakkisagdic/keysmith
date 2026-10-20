import crypto from 'node:crypto';

/**
 * The gateway key is the one secret keysmith mints itself, and behind a tunnel it is the
 * only thing standing between a hostname and your agents' quota. It is printed in full in
 * exactly two places — `keysmith init --reveal` and `keysmith key list|add --reveal` — and
 * only to an interactive terminal. Everything else keysmith writes (the serve banner,
 * launchd's log, keysmith.log, usage.jsonl, error messages, the verbose gateway log)
 * carries this redacted form instead: enough to tell two keys apart, nothing to replay.
 *
 *   ks_Q…35 fp:3f9a0c12      first 4 chars · length · first 8 hex of sha256(key)
 *
 * The first 4 chars of a minted key are `ks_` plus one base64url char (6 of 192 bits);
 * a key shorter than 16 chars gets no prefix at all.
 */

/**
 * A key `newApiKey()` mints: `ks_` + 24 random bytes as base64url. Nothing is required of
 * the character before it: a key glued to `\n` in JSON, to the `m` closing an ANSI colour or
 * to `Bearer_` is still a key.
 */
const KEY_SHAPE = /ks_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;
const MINTED_LENGTH = 35;

/**
 * What a cut leaves of a minted key: `ks_` and 8 or more of its characters, then the
 * ellipsis `truncate()` appends (`…`, which is three bytes in a raw log file) or `...`.
 */
const CUT_SHAPE = /ks_[A-Za-z0-9_-]{8,31}(?=…|â\u0080¦|\.\.\.)/g;

/** The start of a minted key, as the tail of a piece of streamed text. */
const MINTED_PREFIX = /^k(?:s(?:_[A-Za-z0-9_-]{0,32})?)?$/;

/**
 * Configured keys shorter than this are not hunted down in output: they collide with
 * ordinary words, and a key that short is guessable whether it is printed or not.
 */
const MIN_REGISTERED = 8;

/** A run of this many characters of a configured key is taken out wherever it appears. */
const MIN_FRAGMENT = 12;

const known = new Set();

export function fingerprint(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

export function redactKey(key) {
  const s = String(key ?? '');
  if (!s) return '(none)';
  return `${s.length >= 16 ? s.slice(0, 4) : ''}…${s.length} fp:${fingerprint(s)}`;
}

/**
 * A Google API key (`AIza` + 35 characters): what the `google` profile sends upstream. Like
 * a minted key, it is taken out on its shape alone, so one that was never registered here —
 * read by another process, quoted back in a provider's error — is not printed either.
 */
const GOOGLE_KEY_SHAPE = /AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g;
const GOOGLE_KEY_LENGTH = 39;

/** The start of a Google API key, as the tail of a piece of streamed text. */
const GOOGLE_KEY_PREFIX = /^A(?:I(?:z(?:a[0-9A-Za-z_-]{0,35})?)?)?$/;

/**
 * Remember a secret, so every later write can take it out: the gateway keys (loadConfig,
 * createServer) and every provider key an adapter resolved from its `apiKey` reference (the
 * Gateway, as it loads the adapter). Both get the same treatment everywhere keysmith writes:
 * the log, usage.jsonl, error messages, the status page.
 */
export function registerSecrets(keys) {
  // `auth.keys` entries come in two forms: a bare key, or `{ key, label, allow, deny }` for a
  // key with a scope (keys.js). Both are the same secret.
  for (const entry of Array.isArray(keys) ? keys : []) {
    const k = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof entry.key === 'string' ? entry.key : null;
    if (k && k.length >= MIN_REGISTERED) known.add(k);
  }
}

/**
 * Forget secrets that are dead: an MCP bridge session's token (src/bridge/hub.js) once its
 * session is closed. A gateway that runs for weeks opens thousands of sessions, and every write
 * looks for every registered secret; a dead token can no longer open anything.
 */
export function forgetSecrets(keys) {
  for (const k of Array.isArray(keys) ? keys : []) if (typeof k === 'string') known.delete(k);
}

export function knownSecrets() {
  return [...known];
}

/**
 * Every registered key — as written, as JSON escapes it, and any run of 12 or more of its
 * characters a cut left behind — and anything shaped like a minted key, whole or cut,
 * replaced by its redacted form.
 */
export function redactSecrets(text) {
  return rewrite(String(text ?? ''), knownSecrets()).text;
}

/**
 * The same replacement on raw bytes, for a log file that is rewritten in place: bytes that
 * are not UTF-8 come back exactly as they were. Returns how many of each kind were found.
 *
 * `sameLength` pads every replacement to the length of what it replaces, so the buffer
 * comes back exactly as long as it went in — see scrubLogFile for why that matters.
 */
export function scrubBuffer(buf, keys = knownSecrets(), { sameLength = false } = {}) {
  const { text, configured, shaped } = rewrite(buf.toString('latin1'), keys, { enc: utf8AsLatin1, sameLength });
  return { buf: Buffer.from(text, 'latin1'), configured, shaped };
}

/**
 * Redaction for text that arrives in pieces: streamed deltas, a child process's output. A
 * key split across two pieces is in neither of them, so each piece is checked on its own
 * and still the two print the key. `push` returns what is safe to write now and holds back
 * the tail that could still be the start of a key; `end` releases the rest.
 */
export function streamRedactor() {
  let pending = '';
  return {
    push(chunk) {
      pending += String(chunk ?? '');
      const keys = usable(knownSecrets());
      const cut = settledLength(pending, keys);
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return redactSecrets(ready);
    },
    end() {
      const rest = pending;
      pending = '';
      return redactSecrets(rest);
    },
  };
}

/* ------------------------------------------------------------------------ internals */

const same = (t) => t;
const utf8AsLatin1 = (t) => Buffer.from(t, 'utf8').toString('latin1');
const jsonEscaped = (t) => JSON.stringify(t).slice(1, -1);

function usable(keys) {
  return byLength((keys || []).filter((k) => typeof k === 'string' && k.length >= MIN_REGISTERED));
}

/** Longest first, so a key that contains another is replaced whole. */
function byLength(keys) {
  return [...new Set(keys)].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * `s` is either plain text (`enc` is the identity) or bytes held one per character as
 * latin1 (`enc` turns text into that form), so one set of rules runs over both.
 */
function rewrite(s, keys, { enc = same, sameLength = false } = {}) {
  let configured = 0;
  let shaped = 0;
  const fit = (replacement, matched) => {
    const r = enc(replacement);
    if (!sameLength || r.length === matched.length) return r;
    return r.length < matched.length ? r + ' '.repeat(matched.length - r.length) : '*'.repeat(matched.length);
  };
  const list = usable(keys);

  // The whole key, as written and as JSON writes it (a key holding `"` or `\`).
  for (const k of list) {
    const spellings = [[k, redactKey(k)]];
    if (jsonEscaped(k) !== k) spellings.push([jsonEscaped(k), jsonEscaped(redactKey(k))]);
    for (const [spelled, redacted] of spellings) {
      const needle = enc(spelled);
      if (!s.includes(needle)) continue;
      const parts = s.split(needle);
      configured += parts.length - 1;
      s = parts.join(fit(redacted, needle));
    }
  }

  // What a cut left of one: its head before an ellipsis, its tail after a dropped front.
  for (const k of list) {
    if (k.length <= MIN_FRAGMENT) continue;
    const ranges = fragmentRanges(s, enc(k));
    if (!ranges.length) continue;
    configured += ranges.length;
    let out = '';
    let at = 0;
    for (const [a, b] of ranges) {
      out += s.slice(at, a) + fit(redactKey(k), s.slice(a, b));
      at = b;
    }
    s = out + s.slice(at);
  }

  // Keys nobody registered here — revoked, from another config, added after start.
  for (const re of [KEY_SHAPE, CUT_SHAPE, GOOGLE_KEY_SHAPE]) {
    s = s.replace(re, (m) => {
      shaped++;
      return fit(redactKey(m), m);
    });
  }
  return { text: s, configured, shaped };
}

/** Every stretch of `s` that is a run of at least MIN_FRAGMENT characters of `k`, merged. */
function fragmentRanges(s, k) {
  const ranges = [];
  for (let a = 0; a + MIN_FRAGMENT <= k.length; a++) {
    const gram = k.slice(a, a + MIN_FRAGMENT);
    for (let i = s.indexOf(gram); i !== -1; i = s.indexOf(gram, i + 1)) {
      let start = i;
      let ka = a;
      while (start > 0 && ka > 0 && s[start - 1] === k[ka - 1]) {
        start--;
        ka--;
      }
      let end = i + MIN_FRAGMENT;
      let kb = a + MIN_FRAGMENT;
      while (end < s.length && kb < k.length && s[end] === k[kb]) {
        end++;
        kb++;
      }
      ranges.push([start, end]);
    }
  }
  return merge(ranges);
}

function merge(ranges) {
  ranges.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const out = [];
  for (const [a, b] of ranges) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Every secret wholly inside `s`: configured keys, runs of them, minted-shaped keys. */
function secretRanges(s, keys) {
  const ranges = [];
  for (const k of keys) {
    for (let i = s.indexOf(k); i !== -1; i = s.indexOf(k, i + 1)) ranges.push([i, i + k.length]);
    if (k.length > MIN_FRAGMENT) ranges.push(...fragmentRanges(s, k));
  }
  for (const re of [KEY_SHAPE, GOOGLE_KEY_SHAPE]) for (const m of s.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  return merge(ranges);
}

/**
 * How much of `s` can be redacted and written now. The tail that is held back is the
 * longest one that could still grow into a key: a piece of a configured key, or the start
 * of a minted one. A whole key that the cut would split goes out whole instead.
 */
function settledLength(s, keys) {
  const longest = Math.max(MINTED_LENGTH, GOOGLE_KEY_LENGTH, ...keys.map((k) => k.length));
  let cut = s.length;
  for (let i = Math.max(0, s.length - longest); i < s.length; i++) {
    const tail = s.slice(i);
    if (MINTED_PREFIX.test(tail) || GOOGLE_KEY_PREFIX.test(tail) || keys.some((k) => k.includes(tail))) {
      cut = i;
      break;
    }
  }
  for (const [a, b] of secretRanges(s, keys)) if (a < cut && cut < b) cut = b;
  return cut;
}
