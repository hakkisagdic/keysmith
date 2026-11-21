/**
 * Shared test helpers for deterministic event- and condition-based synchronization.
 */
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Poll `check()` until it returns a truthy value or `timeoutMs` elapses.
 * Accepts either a numeric timeout or `{ timeoutMs, intervalMs, message }`.
 */
export async function waitFor(check, opts = {}) {
  const { timeoutMs = 20_000, intervalMs = 20, message = 'condition was not met in time' } =
    typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? ` (${lastError.message || lastError})` : '';
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${message}${detail}`);
    }
    await delay(intervalMs);
  }
}

/**
 * Gate matching `setTimeout` callbacks on `target.timers` (e.g. `Hub.timers`) until the
 * returned release function is called, so pre-expiry checks cannot race short test timers.
 */
export function holdTimer(target, match = () => true) {
  const base = target.timers || globalThis;
  const prev = target.timers;
  let open = false;
  const pending = new Set();
  target.timers = {
    setTimeout(fn, ms, ...args) {
      if (open || !match(ms)) return base.setTimeout(fn, ms, ...args);
      const entry = {
        fired: false,
        cleared: false,
        raw: null,
        run() {
          if (entry.cleared || !open || !entry.fired) return;
          pending.delete(entry);
          if (pending.size === 0) target.timers = prev;
          fn(...args);
        },
      };
      entry.raw = base.setTimeout(() => {
        entry.fired = true;
        entry.run();
      }, ms);
      pending.add(entry);
      return entry.raw;
    },
    clearTimeout(raw) {
      for (const e of pending) {
        if (e.raw === raw) {
          e.cleared = true;
          pending.delete(e);
        }
      }
      if (open && pending.size === 0) target.timers = prev;
      return base.clearTimeout(raw);
    },
    setInterval: (...a) => base.setInterval(...a),
    clearInterval: (...a) => base.clearInterval(...a),
  };
  return () => {
    if (open) return;
    open = true;
    for (const e of [...pending]) e.run();
    if (pending.size === 0) target.timers = prev;
  };
}
