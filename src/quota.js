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
