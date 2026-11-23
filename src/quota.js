/**
 * Daily request caps: how many requests each gateway key made today, and whether one more fits.
 *
 * A key entry's `perDay` (keys.js) caps the requests it may make in one local calendar day. A
 * request is counted once, when it is let in — before its body is read, before any adapter or
 * alias leg is chosen — so an alias that fails over, a CLI that is asked again, a tool route
 * that walks three legs, a stream and an embedding are each one request, and a request that
 * fails is one too. Over the cap the gateway answers 429 with a `retry-after` up to the next
 * local midnight, when every count starts again at 0.
 *
 * Counts live in memory and are rebuilt at start from usage.jsonl: a request writes one usage
 * row, stamped with its key's fingerprint, so today's rows are today's requests. (A request
 * refused before it was read — a body that is not JSON — costs nothing upstream and leaves no
 * row: it is counted while the gateway runs, not after a restart.) Refusals over the cap are
 * counted apart and never count toward it.
 *
 * Every key is counted, capped or not — the status page shows today's requests per key — and
 * only a key with a cap is ever refused. Nothing here holds or prints a key: keys are counted by
 * fingerprint.
 */
export class DailyQuota {
  /** `now`: the clock (ms), injectable so a test can cross midnight. */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.day = dayOf(this.now());
    this.counts = new Map(); // fp -> requests let in today
    this.refused = new Map(); // fp -> requests refused today, over the cap
    this.tokens = new Map(); // fp -> tokens spent today (reported, or estimated from bytes)
    this.estimated = new Set(); // fps with at least one estimated row today
  }

  /** Start again at 0 when the local day changed since the last look. */
  _roll(t = this.now()) {
    const d = dayOf(t);
    if (d === this.day) return t;
    this.day = d;
    this.counts.clear();
    this.refused.clear();
    this.tokens.clear();
    this.estimated.clear();
    return t;
  }

  /**
   * Today's counts out of a UsageLog: one per row stamped with a key (`key: "fp:…"`) written
   * since local midnight, the cap's own refusals (`status: "limited"`) left out.
   */
  seed(usage) {
    const t = this._roll();
    if (!usage?.rowsSince) return;
    for (const row of usage.rowsSince(startOfDay(t))) {
      if (typeof row.key !== 'string' || !row.key.startsWith('fp:') || row.status === 'limited') continue;
      const fp = row.key.slice(3);
      this.counts.set(fp, (this.counts.get(fp) || 0) + 1);
      const r = rowTokens(row);
      this.addTokens(fp, r.tokens, r.estimated);
    }
  }

  /** Add `n` tokens to key `fp`'s count for today; `estimated` marks a count made from bytes. */
  addTokens(fp, n, estimated = false) {
    this._roll();
    if (!Number.isFinite(n) || n < 0) return;
    this.tokens.set(fp, (this.tokens.get(fp) || 0) + n);
    if (estimated && n > 0) this.estimated.add(fp);
  }

  /**
   * The token cap's check, without counting a request: `{ ok: true }` when key `fp` is under
   * `tokensPerDay` (or has none), else `{ ok: false, tokens, tokensPerDay, retryAfter, first }`.
   * A request already in flight may overshoot the cap by its own size: tokens are known only
   * after the answer, so the cap refuses the NEXT request once the day's tokens reached it.
   */
  admitTokens(fp, tokensPerDay = null) {
    const t = this._roll();
    const tokens = this.tokens.get(fp) || 0;
    if (tokensPerDay == null || tokens < tokensPerDay) return { ok: true, tokens };
    const refused = (this.refused.get(fp) || 0) + 1;
    this.refused.set(fp, refused);
    return { ok: false, tokens, tokensPerDay, retryAfter: Math.max(1, Math.ceil((nextMidnight(t) - t) / 1000)), first: refused === 1 };
  }

  /**
   * Let one request of key `fp` in, or not. Without a cap (`perDay` null) it is always let in
   * and counted. `{ ok: true, count }`, or `{ ok: false, count, perDay, retryAfter, first }` —
   * `retryAfter` the whole seconds to the next local midnight, `first` true for the day's first
   * refusal of that key.
   */
  admit(fp, perDay = null) {
    const t = this._roll();
    const count = this.counts.get(fp) || 0;
    if (perDay != null && count >= perDay) {
      const refused = (this.refused.get(fp) || 0) + 1;
      this.refused.set(fp, refused);
      return { ok: false, count, perDay, retryAfter: Math.max(1, Math.ceil((nextMidnight(t) - t) / 1000)), first: refused === 1 };
    }
    this.counts.set(fp, count + 1);
    return { ok: true, count: count + 1 };
  }

  /** `{ requests, refused }` of key `fp` today. */
  today(fp) {
    this._roll();
    return { requests: this.counts.get(fp) || 0, refused: this.refused.get(fp) || 0 };
  }

  /** `{ tokens, tokensEstimated }` of key `fp` today (kept apart from `today`, whose shape others compare). */
  tokensToday(fp) {
    this._roll();
    return { tokens: this.tokens.get(fp) || 0, tokensEstimated: this.estimated.has(fp) };
  }
}

/**
 * What one usage row spent, in tokens: `usage.input + usage.output` when the row reports both as
 * numbers; otherwise (usage null, absent or unknown) `max(1, ceil((bytesIn + bytesOut) / 4))`,
 * marked `estimated`. A cache hit costs 0. Bytes over-count tool-heavy JSON, the safe direction.
 */
export function rowTokens(row) {
  if (!row || typeof row !== 'object') return { tokens: 0, estimated: false };
  if (row.cache === 'hit' || row.cache === 'hit-semantic') return { tokens: 0, estimated: false };
  const u = row.usage;
  if (u && typeof u === 'object' && !u.reason && Number.isFinite(u.input) && Number.isFinite(u.output) && u.input >= 0 && u.output >= 0) {
    return { tokens: u.input + u.output, estimated: false };
  }
  const bytes = (Number.isFinite(row.bytesIn) ? row.bytesIn : 0) + (Number.isFinite(row.bytesOut) ? row.bytesOut : 0);
  return { tokens: Math.max(1, Math.ceil(bytes / 4)), estimated: true };
}

/** The local calendar day of `t` (ms), `2026-10-20`. */
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight at the start of the day of `t`, in ms. */
export function startOfDay(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The next local midnight after `t`, in ms (a DST day is 23 or 25 hours long, and so is this). */
export function nextMidnight(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** The refusal's reason: names the cap and when it resets, never the key (not even its fingerprint). */
export function overCapMessage({ perDay, retryAfter }) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  const wait = h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
  return `this key's daily cap of ${perDay} request${perDay === 1 ? '' : 's'} is used up for today; it resets at local midnight, in ${wait} (retry-after: ${retryAfter} s)`;
}

/** The token cap's refusal reason: names the cap and when it resets, never the key. */
export function overTokensMessage({ tokensPerDay, retryAfter }) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  const wait = h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
  return `this key's daily cap of ${tokensPerDay} token${tokensPerDay === 1 ? '' : 's'} is used up for today; it resets at local midnight, in ${wait} (retry-after: ${retryAfter} s)`;
}

/**
 * Rolling 60-second request limiter (`perMinute` on an `auth.keys` entry), keyed by fingerprint.
 * Admitted requests record their timestamp; refused requests are never counted toward the limit.
 */
export class MinuteLimiter {
  /** `now`: the clock (ms), injectable so a test can advance 61 s. */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windows = new Map(); // fp -> ms timestamps of requests let in within the last 60 s
    this.lastLoggedAt = new Map(); // fp -> ms timestamp of last first-in-minute refusal
  }

  _prune(fp, t) {
    const cur = this.windows.get(fp);
    if (!cur || !cur.length) return [];
    const cutoff = t - 60_000;
    if (cur[0] > cutoff) return cur;
    const next = cur.filter((x) => x > cutoff);
    if (next.length) this.windows.set(fp, next);
    else this.windows.delete(fp);
    return next;
  }

  /**
   * Let one request of key `fp` in, or refuse it when `perMinute` requests were already let in
   * during the last 60 s. `{ ok: true, count }` or `{ ok: false, count, perMinute, retryAfter, first }`.
   */
  admit(fp, perMinute = null) {
    const t = this.now();
    const hits = this._prune(fp, t);
    if (perMinute != null && hits.length >= perMinute) {
      const unblockAt = perMinute === 0 ? t + 60_000 : hits[hits.length - perMinute] + 60_000;
      const retryAfter = Math.min(60, Math.max(1, Math.ceil((unblockAt - t) / 1000)));
      const prevLog = this.lastLoggedAt.get(fp);
      const first = prevLog === undefined || t - prevLog >= 60_000;
      if (first) this.lastLoggedAt.set(fp, t);
      return { ok: false, count: hits.length, perMinute, retryAfter, first };
    }
    hits.push(t);
    this.windows.set(fp, hits);
    return { ok: true, count: hits.length };
  }

  /** Undo the most recent admission of `fp` when a later limit (`perDay`) refuses the request. */
  unadmit(fp) {
    const hits = this.windows.get(fp);
    if (!hits || !hits.length) return;
    hits.pop();
    if (!hits.length) this.windows.delete(fp);
  }
}

/** The per-minute refusal's reason: names the limit and retry-after, never the key. */
export function overMinuteMessage({ perMinute, retryAfter }) {
  return `this key's per-minute limit of ${perMinute} request${perMinute === 1 ? '' : 's'}/minute is reached; try again in ${retryAfter} s (retry-after: ${retryAfter} s)`;
}
