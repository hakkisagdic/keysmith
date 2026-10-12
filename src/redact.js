import crypto from 'node:crypto';

/**
 * The gateway key is the one secret keysmith mints itself, and behind a tunnel it is the
 * only thing standing between a hostname and your agents' quota. It is printed in full in
 * exactly two places — `keysmith init` and `keysmith key list|add` — and only to an
 * interactive terminal. Everything else keysmith writes (the serve banner, launchd's log,
 * keysmith.log, usage.jsonl, error messages, the verbose gateway log) carries this
 * redacted form instead: enough to tell two keys apart, nothing to replay.
 *
 *   ks_Q…35 fp:3f9a0c12      first 4 chars · length · first 8 hex of sha256(key)
 *
 * The first 4 chars of a minted key are `ks_` plus one base64url char (6 of 192 bits);
 * a key shorter than 16 chars gets no prefix at all.
 */

/** A key `newApiKey()` mints: `ks_` + 24 random bytes as base64url. */
const KEY_SHAPE = /(?<![A-Za-z0-9_-])ks_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;

/**
 * Configured keys shorter than this are not hunted down in output: they collide with
 * ordinary words, and a key that short is guessable whether it is printed or not.
 */
const MIN_REGISTERED = 8;

const known = new Set();

export function fingerprint(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

export function redactKey(key) {
  const s = String(key ?? '');
  if (!s) return '(none)';
  return `${s.length >= 16 ? s.slice(0, 4) : ''}…${s.length} fp:${fingerprint(s)}`;
}

/** Remember the gateway keys, so every later write can take them out. */
export function registerSecrets(keys) {
  for (const k of keys || []) if (typeof k === 'string' && k.length >= MIN_REGISTERED) known.add(k);
}

export function knownSecrets() {
  return [...known];
}

/** Every registered key, and anything shaped like a minted key, replaced by its redacted form. */
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const k of byLength(known)) if (s.includes(k)) s = s.split(k).join(redactKey(k));
  return s.replace(KEY_SHAPE, (m) => redactKey(m));
}

/**
 * The same replacement on raw bytes, for a log file that is rewritten in place: bytes that
 * are not UTF-8 come back exactly as they were. Returns how many of each kind were found.
 */
export function scrubBuffer(buf, keys = knownSecrets()) {
  const bytes = (t) => Buffer.from(t, 'utf8').toString('latin1');
  let s = buf.toString('latin1');
  let configured = 0;
  for (const k of byLength(keys)) {
    const parts = s.split(bytes(k));
    if (parts.length < 2) continue;
    configured += parts.length - 1;
    s = parts.join(bytes(redactKey(k)));
  }
  let shaped = 0;
  s = s.replace(KEY_SHAPE, (m) => {
    shaped++;
    return bytes(redactKey(m));
  });
  return { buf: Buffer.from(s, 'latin1'), configured, shaped };
}

/** Longest first, so a key that contains another is replaced whole. */
function byLength(keys) {
  return [...keys].filter(Boolean).sort((a, b) => b.length - a.length);
}
