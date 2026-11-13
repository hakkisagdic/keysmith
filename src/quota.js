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
  }

  /** Start again at 0 when the local day changed since the last look. */
  _roll(t = this.now()) {
    const d = dayOf(t);
    if (d === this.day) return t;
    this.day = d;
    this.counts.clear();
    this.refused.clear();
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
    }
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

const WINDOW_MS = 60_000;

/**
 * Sliding 60-second rate limiter for requests per minute (`perMinute` / `rpm`) and tokens per
 * minute (`tokensPerMinute` / `tpm`).
 */
export class MinuteRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reqWindows = new Map(); // fp -> number[] (timestamps in ms)
    this.tokWindows = new Map(); // fp -> { ts: number, tokens: number }[]
    this.refusedMinute = new Map(); // fp -> { minuteBucket, count }
  }

  _prune(fp, t) {
    const cutoff = t - WINDOW_MS;
    const reqs = this.reqWindows.get(fp);
    if (reqs) {
      while (reqs.length && reqs[0] <= cutoff) reqs.shift();
      if (!reqs.length) this.reqWindows.delete(fp);
    }
    const toks = this.tokWindows.get(fp);
    if (toks) {
      while (toks.length && toks[0].ts <= cutoff) toks.shift();
      if (!toks.length) this.tokWindows.delete(fp);
    }
  }

  admit(fp, { perMinute = null, tokensPerMinute = null } = {}) {
    const key = fp || '__global__';
    const t = this.now();
    this._prune(key, t);

    const reqs = this.reqWindows.get(key) || [];
    const toks = this.tokWindows.get(key) || [];
    const usedRequests = reqs.length;
    const usedTokens = toks.reduce((sum, x) => sum + x.tokens, 0);

    const reqResetSec = reqs.length ? Math.max(1, Math.ceil((reqs[0] + WINDOW_MS - t) / 1000)) : 60;
    const tokResetSec = toks.length ? Math.max(1, Math.ceil((toks[0].ts + WINDOW_MS - t) / 1000)) : 60;

    if (perMinute != null && usedRequests >= perMinute) {
      const first = this._markRefused(key, t);
      return {
        ok: false,
        kind: 'requests',
        limit: perMinute,
        used: usedRequests,
        retryAfter: reqResetSec,
        first,
        requests: { limit: perMinute, remaining: 0, resetSeconds: reqResetSec },
        tokens: tokensPerMinute != null ? { limit: tokensPerMinute, remaining: Math.max(0, tokensPerMinute - usedTokens), resetSeconds: tokResetSec } : null,
      };
    }

    if (tokensPerMinute != null && (tokensPerMinute === 0 || usedTokens >= tokensPerMinute)) {
      const first = this._markRefused(key, t);
      return {
        ok: false,
        kind: 'tokens',
        limit: tokensPerMinute,
        used: usedTokens,
        retryAfter: tokResetSec,
        first,
        requests: perMinute != null ? { limit: perMinute, remaining: Math.max(0, perMinute - usedRequests), resetSeconds: reqResetSec } : null,
        tokens: { limit: tokensPerMinute, remaining: 0, resetSeconds: tokResetSec },
      };
    }

    reqs.push(t);
    this.reqWindows.set(key, reqs);
    const nextReqResetSec = Math.max(1, Math.ceil((reqs[0] + WINDOW_MS - t) / 1000));

    return {
      ok: true,
      requests: perMinute != null ? { limit: perMinute, remaining: Math.max(0, perMinute - reqs.length), resetSeconds: nextReqResetSec } : null,
      tokens: tokensPerMinute != null ? { limit: tokensPerMinute, remaining: Math.max(0, tokensPerMinute - usedTokens), resetSeconds: tokResetSec } : null,
    };
  }

  recordTokens(fp, tokens) {
    const n = Number(tokens) || 0;
    if (n <= 0) return;
    const key = fp || '__global__';
    const t = this.now();
    this._prune(key, t);
    const toks = this.tokWindows.get(key) || [];
    toks.push({ ts: t, tokens: n });
    this.tokWindows.set(key, toks);
  }

  _markRefused(key, t) {
    const bucket = Math.floor(t / WINDOW_MS);
    const prev = this.refusedMinute.get(key);
    if (!prev || prev.bucket !== bucket) {
      this.refusedMinute.set(key, { bucket, count: 1 });
      return true;
    }
    prev.count++;
    return false;
  }
}

export function overRateLimitMessage({ kind, limit, retryAfter }) {
  if (kind === 'tokens') {
    return `this key's token rate limit of ${limit} token${limit === 1 ? '' : 's'}/min is exceeded; retry in ${retryAfter} s`;
  }
  return `this key's request rate limit of ${limit} request${limit === 1 ? '' : 's'}/min is exceeded; retry in ${retryAfter} s`;
}
