import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmError, truncate } from './util.js';

/**
 * The Kiro credit guard. Kiro reports no token counts, so a spend cap (limits.spend) never sees
 * what a kiro leg spends: the plan's own meter is read instead — `kiro-cli chat --no-interactive
 * /usage` prints `Credits (X of Y covered in plan)` — and an adapter whose plan is at or over its
 * threshold (`creditGuardThreshold` on the adapter, 0.90 by default) is unavailable: a route
 * passes it by (the reason in the usage row's `skippedLegs`), a request that names it is a 429.
 *
 * The reading is cached for ten minutes and `/usage` runs at most once per ten minutes per Kiro
 * login (the adapter's binary and environment: `kiro` and `kiro-emu` share one plan, and one
 * reading), whatever comes of it. A reading that fails never blocks: the adapter stays available,
 * and the failure is logged. With a `statePath` the readings outlive the process, so a restarted
 * gateway and `keysmith doctor` do not run `/usage` again inside the ten minutes.
 */

export const CREDIT_GUARD_TTL_MS = 10 * 60_000;
export const DEFAULT_CREDIT_THRESHOLD = 0.9;
export const KIRO_USAGE_ARGS = ['chat', '--no-interactive', '/usage'];
const FIRST_WAIT_MS = 10_000;
// A reading older than this is not answered on while a new one is coming: the request waits for
// that one (at most firstWaitMs). Younger, it is (the plan's meter only climbs inside a period).
const MAX_STALE_MS = 60 * 60_000;
const RUN_TIMEOUT_MS = 30_000;

/** `s` without terminal escapes: CSI (colours, cursor), OSC (titles, links) and lone ESC pairs. */
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}

function number(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * What `kiro-cli chat --no-interactive /usage` says of the plan (kiro-cli 2.27.1):
 *
 *   Estimated Usage | resets on 2026-12-01 | KIRO POWER
 *   Credits (1524.71 of 10000 covered in plan), 15.2%
 *
 * `{ used, limit, ratio, resetsOn }`, or null when the output has no such line (a login prompt,
 * an error, another version's wording): never a guess.
 */
export function parseKiroUsage(text) {
  const s = stripAnsi(text);
  const m = s.match(/Credits\s*\(\s*([\d][\d,]*(?:\.\d+)?)\s+of\s+([\d][\d,]*(?:\.\d+)?)\s+covered\s+in\s+plan\s*\)/i);
  if (!m) return null;
  const used = number(m[1]);
  const limit = number(m[2]);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit <= 0) return null;
  const resetsOn = s.match(/resets\s+on\s+(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
  return { used, limit, ratio: used / limit, resetsOn };
}

/** Whether a reading is at or over `threshold`: `{ blocked, ratio, threshold }`. */
export function evaluateCredits(reading, threshold = DEFAULT_CREDIT_THRESHOLD) {
  if (!reading || !Number.isFinite(reading.ratio)) return { blocked: false, ratio: null, threshold };
  return { blocked: reading.ratio >= threshold, ratio: reading.ratio, threshold };
}

/** Whether `bin` is Kiro's CLI: the one binary whose `/usage` the guard can read. */
export function isKiroBin(bin) {
  return /^kiro-cli(?:\.exe)?$/i.test(String(bin || '').split(/[\\/]/).pop());
}

/**
 * A CLI entry's credit guard, at load: `{ kind: 'kiro', threshold }` for an entry that runs
 * kiro-cli (whatever its id: `kiro`, `kiro-emu`), null otherwise. `creditGuardThreshold` is a
 * fraction of the plan, above 0 and at most 1 (1: held back only once the plan is spent); any
 * other value is a load error, and so is the key on an entry that does not run kiro-cli (it would
 * guard nothing, and say nothing about it).
 */
export function checkCreditGuard(id, cfg, bin) {
  const raw = cfg?.creditGuardThreshold;
  const kiro = isKiroBin(bin);
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 1) {
      throw new Error(`adapter "${id}": creditGuardThreshold must be a fraction of the plan above 0 and at most 1 (0.9 holds the adapter back at 90% of its credits) — got ${JSON.stringify(raw)?.slice(0, 40)}`);
    }
    if (!kiro) throw new Error(`adapter "${id}": creditGuardThreshold guards a Kiro plan, and this entry does not run kiro-cli (bin ${JSON.stringify(String(bin)).slice(0, 80)})`);
  }
  if (!kiro) return null;
  return { kind: 'kiro', threshold: typeof raw === 'number' ? raw : DEFAULT_CREDIT_THRESHOLD };
}

/** `/usage`'s output for `adapter`, run the way its own runs are: its binary, environment and workspace. */
export function runKiroUsage(adapter, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    try {
      adapter._ensureCwd?.();
    } catch {}
    let cwd = adapter.cwd;
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = os.homedir();
    } catch {
      cwd = os.homedir();
    }
    const env = typeof adapter._childEnv === 'function' ? adapter._childEnv(cwd) : process.env;
    execFile(adapter.bin, KIRO_USAGE_ARGS, { cwd, env, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `timed out after ${timeoutMs} ms` : err.code === 'ENOENT' ? `${adapter.bin} not found` : `exited ${err.code ?? err.signal}`;
        return reject(new Error(`${why}${stderr ? `: ${truncate(stripAnsi(stderr), 160)}` : ''}`));
      }
      resolve(String(stdout || ''));
    });
  });
}

export class CreditGuard {
  /**
   * `run(adapter)`: `/usage`'s output (runKiroUsage; a fixture in tests). `statePath`: where the
   * readings are kept between processes (null: in memory only). `firstWaitMs`: how long a request
   * waits for the first reading of a login it has none of (a reading takes kiro-cli ~8 s; the
   * gateway asks for it at start, so a request rarely waits at all).
   */
  constructor({ run = runKiroUsage, now = Date.now, ttlMs = CREDIT_GUARD_TTL_MS, firstWaitMs = FIRST_WAIT_MS, statePath = null, log = () => {} } = {}) {
    this.run = run;
    this.now = now;
    this.ttlMs = ttlMs;
    this.firstWaitMs = firstWaitMs;
    this.statePath = statePath;
    this.log = log;
    this.entries = new Map(); // login key -> { bin, adapters, reading, at, error, lastAttemptAt, inflight, blocked }
    this._load();
  }

  /** One Kiro login: the binary and the environment the adapter runs it with (a hash of it). */
  keyOf(adapter) {
    const env = Object.entries(adapter.env || {}).sort(([a], [b]) => (a < b ? -1 : 1));
    const h = createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 12);
    return `${adapter.bin}#${h}`;
  }

  _entry(adapter) {
    const key = this.keyOf(adapter);
    let e = this.entries.get(key);
    if (!e) {
      e = { bin: String(adapter.bin), adapters: [], reading: null, at: 0, error: null, lastAttemptAt: 0, inflight: null, said: {} };
      this.entries.set(key, e);
    }
    if (adapter.id && !e.adapters.includes(adapter.id)) e.adapters.push(adapter.id);
    return e;
  }

  /** A reading of `adapter`'s plan when the cached one is older than the TTL and none ran inside it: the promise, or null. */
  refresh(adapter) {
    const e = this._entry(adapter);
    if (e.inflight) return e.inflight;
    const now = this.now();
    if (e.reading && now - e.at < this.ttlMs) return null;
    if (e.lastAttemptAt && now - e.lastAttemptAt < this.ttlMs) return null;
    e.lastAttemptAt = now;
    e.inflight = (async () => {
      try {
        const out = await this.run(adapter);
        const reading = parseKiroUsage(out);
        if (!reading) throw new Error('no "Credits (X of Y covered in plan)" line in its output');
        e.reading = reading;
        e.at = this.now();
        e.error = null;
      } catch (err) {
        e.error = truncate(err?.message || String(err), 200);
        this.log(`kiro credit guard: reading the plan of ${e.adapters.join(', ') || adapter.id} (kiro-cli ${KIRO_USAGE_ARGS.join(' ')}) failed: ${e.error} — not held back; the next reading is in ${Math.round(this.ttlMs / 60_000)} min`);
      } finally {
        e.inflight = null;
        this._save();
      }
    })();
    return e.inflight;
  }

  /** Readings for every guarded adapter, now (the gateway's start): none waits on them. */
  prime(adapters) {
    for (const a of adapters) if (a?.creditGuard && !a.disabled) this.refresh(a)?.catch(() => {});
  }

  /**
   * Whether `adapter` may be asked now: `{ ok: true, … }`, or `{ ok: false, reading, ratio,
   * threshold, detail }` when its plan is at or over its threshold. A request waits for a first
   * reading at most `firstWaitMs`; a reading that failed, or none yet, is ok (logged).
   */
  async check(adapter) {
    const guard = adapter?.creditGuard;
    if (!guard) return { ok: true };
    const e = this._entry(adapter);
    const pending = this.refresh(adapter);
    if (pending && (!e.reading || this.now() - e.at > MAX_STALE_MS)) {
      let timer;
      await Promise.race([pending, new Promise((r) => (timer = setTimeout(r, this.firstWaitMs)))]);
      clearTimeout(timer);
    }
    if (!e.reading) return { ok: true, unknown: true, error: e.error || 'no reading yet', threshold: guard.threshold };
    if (e.error && e.lastAttemptAt > e.at) {
      // The newest attempt failed: the reading before it is not the plan now. Never blocks.
      return { ok: true, unknown: true, error: e.error, threshold: guard.threshold, reading: e.reading };
    }
    const reset = e.reading.resetsOn ? Date.parse(`${e.reading.resetsOn}T00:00:00Z`) : NaN;
    if (Number.isFinite(reset) && e.at < reset && this.now() >= reset) {
      // Read before the plan reset: it says nothing of the new period.
      return { ok: true, unknown: true, error: `the reading is from before the plan reset on ${e.reading.resetsOn}`, threshold: guard.threshold };
    }
    const v = evaluateCredits(e.reading, guard.threshold);
    const state = v.blocked ? 'blocked' : 'ok';
    const said = e.said[adapter.id] ?? null;
    if (said !== state && (said !== null || v.blocked)) {
      this.log(`kiro credit guard: ${adapter.id} ${v.blocked ? 'held back' : 'available again'} — ${describeReading(e.reading)}, threshold ${pct(guard.threshold)}`);
    }
    e.said[adapter.id] = state;
    if (!v.blocked) return { ok: true, reading: e.reading, ratio: v.ratio, threshold: guard.threshold };
    return {
      ok: false,
      reading: e.reading,
      ratio: v.ratio,
      threshold: guard.threshold,
      ageMs: Math.max(0, this.now() - e.at),
      detail: `Kiro plan at ${describeReading(e.reading)}, at or over this adapter's creditGuardThreshold of ${pct(guard.threshold)}`,
    };
  }

  /** What the guard knows, per login, for doctor, status and /v1/keysmith/routes: no secrets in it. */
  snapshot() {
    const now = this.now();
    return [...this.entries.values()].map((e) => ({
      bin: e.bin,
      adapters: [...e.adapters],
      reading: e.reading ? { ...e.reading } : null,
      readAt: e.at ? new Date(e.at).toISOString() : null,
      ageMs: e.at ? Math.max(0, now - e.at) : null,
      error: e.error,
      lastAttemptAt: e.lastAttemptAt ? new Date(e.lastAttemptAt).toISOString() : null,
      nextReadingAt: e.lastAttemptAt ? new Date(Math.max(e.lastAttemptAt, e.at) + this.ttlMs).toISOString() : null,
    }));
  }

  _load() {
    if (!this.statePath) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return;
    }
    for (const [key, s] of Object.entries(data?.logins || {})) {
      if (!s || typeof s !== 'object') continue;
      const reading = s.reading && Number.isFinite(s.reading.used) && Number.isFinite(s.reading.limit) && s.reading.limit > 0 ? { used: s.reading.used, limit: s.reading.limit, ratio: s.reading.used / s.reading.limit, resetsOn: s.reading.resetsOn || null } : null;
      this.entries.set(key, {
        bin: String(s.bin || ''),
        adapters: Array.isArray(s.adapters) ? s.adapters.filter((a) => typeof a === 'string') : [],
        reading,
        at: Number(s.at) || 0,
        error: typeof s.error === 'string' ? s.error : null,
        lastAttemptAt: Number(s.lastAttemptAt) || 0,
        inflight: null,
        said: {},
      });
    }
  }

  _save() {
    if (!this.statePath) return;
    const logins = {};
    for (const [key, e] of this.entries) logins[key] = { bin: e.bin, adapters: e.adapters, reading: e.reading, at: e.at, error: e.error, lastAttemptAt: e.lastAttemptAt };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, logins }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.log(`kiro credit guard: could not keep its reading in ${this.statePath}: ${err.message}`);
    }
  }
}

/** The state file's readings without a guard: for `keysmith status`, which runs nothing. */
export function readCreditState(statePath, { now = Date.now(), ttlMs = CREDIT_GUARD_TTL_MS } = {}) {
  const g = new CreditGuard({ statePath, now: () => now, ttlMs, run: async () => '' });
  return g.snapshot();
}

/** The 429 a request that names a held-back adapter gets (the spend cap's status and type). */
export function creditGuardError(adapter, verdict, now = Date.now()) {
  const reset = verdict.reading?.resetsOn ? Date.parse(`${verdict.reading.resetsOn}T00:00:00Z`) : NaN;
  const err = new LlmError(
    `${adapter.id}: held back by the kiro credit guard — ${verdict.detail}${verdict.reading?.resetsOn ? ` (the plan resets on ${verdict.reading.resetsOn})` : ''}. Another leg answers inside a route; raise creditGuardThreshold on "${adapter.id}" to use it anyway`,
    { status: 429, type: 'rate_limit_error', provider: adapter.id },
  );
  err.retryAfter = Number.isFinite(reset) && reset > now ? Math.ceil((reset - now) / 1000) : Math.ceil(CREDIT_GUARD_TTL_MS / 1000);
  err.creditGuard = true;
  return err;
}

export function describeReading(r) {
  if (!r) return 'no reading';
  return `${fmtCredits(r.used)} of ${fmtCredits(r.limit)} credits (${pct(r.ratio)})`;
}

function fmtCredits(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function pct(f) {
  return `${(Number(f) * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
