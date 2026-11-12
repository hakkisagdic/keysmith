import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmError, truncate } from './util.js';

/**
 * The Kiro credit guard. Kiro reports no token counts, so a spend cap (limits.spend) never sees
 * what a kiro leg spends: the plan's own meter is read instead — `kiro-cli chat --no-interactive
 * --trust-tools= [--agent <the adapter's>] /usage` prints `Credits (X of Y covered in plan)` — and
 * an adapter whose plan is at or over its threshold (`creditGuardThreshold` on the adapter, 0.90
 * by default, up to 1.25: past 1 it runs into Kiro's overage) is unavailable: a route passes it
 * by (the reason in the usage row's `skippedLegs`), a request that names it is a 429 whose
 * retry-after is at most five minutes.
 *
 * The reading is cached for ten minutes and `/usage` runs at most once per ten minutes per Kiro
 * login (the adapter's binary and environment: `kiro` and `kiro-emu` share one plan, and one
 * reading), whatever comes of it — across processes too: an attempt is written to `statePath`
 * before it runs, and the file is read again before the next one is decided, so the gateway and
 * `keysmith doctor` never both run it inside the ten minutes. `serve` keeps the reading fresh in
 * the background (keepFresh), so a request never waits for one; only the very first reading of a
 * login (none kept, none failed yet) is waited for, at most `firstWaitMs`.
 *
 * The meter only climbs inside a plan period, so a reading is a lower bound until the plan
 * resets: a reading at or over the threshold keeps the adapter held back even when the readings
 * after it fail (a timeout, a login prompt, another version's wording) — stale, and said so by
 * doctor and status — until the plan resets. A failure with no reading of this period never
 * blocks: the adapter stays available, and the failure is logged.
 */

export const CREDIT_GUARD_TTL_MS = 10 * 60_000;
export const DEFAULT_CREDIT_THRESHOLD = 0.9;
/**
 * The highest threshold: 1.25 of the plan. Past 1 the adapter runs into Kiro's overage (credits
 * billed beyond the plan, `Credits (11200 of 10000 covered in plan)`), which a plan may allow up to
 * a share of its own: 1.12 holds the adapter back at 112%.
 */
export const MAX_CREDIT_THRESHOLD = 1.25;
/**
 * The longest retry-after (seconds) of a request that names a held-back adapter. The plan's reset
 * can be weeks away, and a client that honours a retry-after that long stops for weeks: the
 * threshold may be raised, the plan topped up or reset in the meantime, and the guard reads the
 * plan every ten minutes, so the client is told to look again in five.
 */
export const CREDIT_GUARD_MAX_RETRY_AFTER_S = 300;
/** The argv of a reading, before the adapter's agent: headless, trusting no tool. */
export const KIRO_USAGE_ARGS = ['chat', '--no-interactive', '--trust-tools=', '/usage'];
const FIRST_WAIT_MS = 10_000;
const RUN_TIMEOUT_MS = 30_000;
// SIGTERM first, SIGKILL this long after (the adapter's own runs do the same, cli-adapter terminate()).
const KILL_AFTER_MS = 5_000;
// A reading that names no reset date is taken as this period's for at most this long.
const PERIOD_MS = 32 * 24 * 3_600_000;
// How often keepFresh looks: refresh() itself decides whether a reading is due (once per TTL).
const KEEP_FRESH_TICK_MS = 60_000;

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
 * share of the plan, above 0 and at most MAX_CREDIT_THRESHOLD (1: held back once the plan is
 * spent; 1.12: at 112%, into the overage); any other value is a load error, and so is the key on
 * an entry that does not run kiro-cli (it would guard nothing, and say nothing about it).
 */
export function checkCreditGuard(id, cfg, bin) {
  const raw = cfg?.creditGuardThreshold;
  const kiro = isKiroBin(bin);
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > MAX_CREDIT_THRESHOLD) {
      throw new Error(`adapter "${id}": creditGuardThreshold must be a share of the plan above 0 and at most ${MAX_CREDIT_THRESHOLD} (0.9 holds the adapter back at 90% of its credits, 1.12 at 112%, into Kiro's overage) — got ${JSON.stringify(raw)?.slice(0, 40)}`);
    }
    if (!kiro) throw new Error(`adapter "${id}": creditGuardThreshold guards a Kiro plan, and this entry does not run kiro-cli (bin ${JSON.stringify(String(bin)).slice(0, 80)})`);
  }
  if (!kiro) return null;
  return { kind: 'kiro', threshold: typeof raw === 'number' ? raw : DEFAULT_CREDIT_THRESHOLD };
}

/**
 * The argv of `adapter`'s reading: KIRO_USAGE_ARGS with the agent its own runs use (`--agent
 * keysmith-text`: no tools, no MCP server started) before `/usage`, so a kiro-cli that ever took
 * `/usage` for a prompt would answer it with that agent, trusting no tool.
 */
export function kiroUsageArgs(adapter) {
  const flat = [adapter?.args, adapter?.emulateArgs].flat(Infinity).filter((a) => typeof a === 'string');
  let agent = null;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === '--agent') agent = flat[i + 1];
    else if (flat[i].startsWith('--agent=')) agent = flat[i].slice('--agent='.length);
    if (agent !== null) break;
  }
  const usable = typeof agent === 'string' && /^\w[\w.-]{0,63}$/.test(agent);
  const [chat, headless, trust, usage] = KIRO_USAGE_ARGS;
  return [chat, headless, trust, ...(usable ? ['--agent', agent] : []), usage];
}

/**
 * `/usage`'s output for `adapter`, run the way its own runs are: its binary, environment and
 * workspace. A run past `timeoutMs` is stopped the way the adapter stops its own — SIGTERM, then
 * SIGKILL `killAfterMs` later — and the promise settles at the latest a moment after that, whether
 * or not the child ever exits.
 */
export function runKiroUsage(adapter, { timeoutMs = RUN_TIMEOUT_MS, killAfterMs = KILL_AFTER_MS, settleAfterMs = 2_000, spawnImpl = spawn } = {}) {
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
    let child;
    try {
      child = spawnImpl(adapter.bin, kiroUsageArgs(adapter), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new Error(e?.code === 'ENOENT' ? `${adapter.bin} not found` : e?.message || String(e)));
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers = [];
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      fn(value);
    };
    const why = () => (stderr ? `: ${truncate(stripAnsi(stderr), 160)}` : '');
    child.stdout.on('data', (d) => {
      if (stdout.length < 1 << 20) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 1 << 16) stderr += d;
    });
    timers.push(
      setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
      }, timeoutMs),
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, timeoutMs + killAfterMs),
      // A child that outlives SIGKILL (or a grandchild holding its pipes) never pins a reading.
      setTimeout(() => settle(reject, new Error(`timed out after ${timeoutMs} ms, and kiro-cli did not exit when stopped`)), timeoutMs + killAfterMs + settleAfterMs),
    );
    child.on('error', (e) => settle(reject, new Error(e?.code === 'ENOENT' ? `${adapter.bin} not found` : e?.message || String(e))));
    child.on('close', (code, signal) => {
      if (timedOut) return settle(reject, new Error(`timed out after ${timeoutMs} ms${why()}`));
      if (code !== 0) return settle(reject, new Error(`exited ${code ?? signal}${why()}`));
      settle(resolve, stdout);
    });
  });
}

/** When the plan period of `reading` (taken at `at`) ends: its reset date, else PERIOD_MS after it was read. */
function periodEnd(reading, at) {
  const reset = reading?.resetsOn ? Date.parse(`${reading.resetsOn}T00:00:00Z`) : NaN;
  return Number.isFinite(reset) ? reset : at + PERIOD_MS;
}

/**
 * What one login's state says of an adapter at `threshold`, now: `{ state, stale, ratio }` —
 * state 'held back' (a reading of this period at or over the threshold, however many readings
 * after it failed), 'ok', or 'unknown' (no reading, or one from before the plan reset); stale
 * when the newest attempt failed after the reading it goes by. One rule for check(), doctor,
 * status and /v1/keysmith/routes.
 */
export function guardState({ reading, at, error, lastAttemptAt }, threshold, now) {
  const stale = !!(error && lastAttemptAt > at);
  if (!reading) return { state: 'unknown', stale, ratio: null, why: error || 'no reading yet' };
  if (now >= periodEnd(reading, at) && at < periodEnd(reading, at)) {
    return { state: 'unknown', stale, ratio: null, why: reading.resetsOn ? `the reading is from before the plan reset on ${reading.resetsOn}` : 'the reading is from an earlier plan period' };
  }
  const v = evaluateCredits(reading, threshold);
  return { state: v.blocked ? 'held back' : 'ok', stale, ratio: v.ratio };
}

export class CreditGuard {
  /**
   * `run(adapter)`: `/usage`'s output (runKiroUsage; a fixture in tests). `statePath`: where the
   * readings are kept between processes (null: in memory only). `firstWaitMs`: how long a request
   * waits for the first reading of a login nothing is known of (a reading takes kiro-cli ~8 s; the
   * gateway asks for it at start, so a request rarely waits at all). `runDeadlineMs`: a reading
   * not back by then is a failure, whatever `run` is still doing.
   */
  constructor({ run = runKiroUsage, now = Date.now, ttlMs = CREDIT_GUARD_TTL_MS, firstWaitMs = FIRST_WAIT_MS, runDeadlineMs = RUN_TIMEOUT_MS + KILL_AFTER_MS + 5_000, statePath = null, log = () => {} } = {}) {
    this.run = run;
    this.now = now;
    this.ttlMs = ttlMs;
    this.firstWaitMs = firstWaitMs;
    this.runDeadlineMs = runDeadlineMs;
    this.statePath = statePath;
    this.log = log;
    this.entries = new Map(); // login key -> { bin, adapters, reading, at, error, lastAttemptAt, inflight, said }
    this._fileStamp = null; // the state file as last read or written: inode, mtime and size
    this._sync({ force: true });
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

  /**
   * A reading of `adapter`'s plan when the cached one is older than the TTL and no attempt — this
   * process's or another's, by the state file — started inside it: the promise, or null.
   */
  refresh(adapter) {
    const e = this._entry(adapter);
    if (e.inflight) return e.inflight;
    this._sync();
    const now = this.now();
    if (e.reading && now - e.at < this.ttlMs) return null;
    if (e.lastAttemptAt && now - e.lastAttemptAt < this.ttlMs) return null;
    e.lastAttemptAt = now;
    // Said before it runs: another process that looks now leaves this attempt to this one.
    this._save();
    let deadline;
    const late = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`no answer after ${Math.round(this.runDeadlineMs / 1000)} s`)), this.runDeadlineMs);
      // A real reading's child keeps the process alive while it runs; this timer never does.
      deadline.unref?.();
    });
    e.inflight = (async () => {
      try {
        const out = await Promise.race([this.run(adapter), late]);
        const reading = parseKiroUsage(out);
        if (!reading) throw new Error('no "Credits (X of Y covered in plan)" line in its output');
        e.reading = reading;
        e.at = this.now();
        e.error = null;
      } catch (err) {
        e.error = truncate(err?.message || String(err), 200);
        const g = guardState(e, adapter.creditGuard?.threshold ?? DEFAULT_CREDIT_THRESHOLD, this.now());
        const kept = g.state === 'unknown' ? 'not held back' : `going by the reading of ${minutes(this.now() - e.at)} ago (${describeReading(e.reading)}${g.state === 'held back' ? ', held back' : ''}) until one succeeds`;
        this.log(`kiro credit guard: reading the plan of ${e.adapters.join(', ') || adapter.id} (kiro-cli ${kiroUsageArgs(adapter).join(' ')}) failed: ${e.error} — ${kept}; the next reading is in ${Math.round(this.ttlMs / 60_000)} min`);
      } finally {
        clearTimeout(deadline);
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
   * Keeps every guarded adapter's reading fresh while the gateway runs, so no request — a
   * failover leg least of all — waits for one: a look now and every `tickMs`, refresh() deciding
   * whether a reading is due (once per TTL per login). `adapters`: a list, or a function that
   * gives the current one (a config reload changes it). The timer never holds the process open.
   * Returns the function that stops it.
   */
  keepFresh(adapters, { tickMs = KEEP_FRESH_TICK_MS } = {}) {
    const list = typeof adapters === 'function' ? adapters : () => adapters;
    const tick = () => {
      try {
        this.prime(list() || []);
      } catch {}
    };
    tick();
    const timer = setInterval(tick, Math.max(10, tickMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Whether `adapter` may be asked now: `{ ok: true, … }`, or `{ ok: false, reading, ratio,
   * threshold, detail }` when its plan is at or over its threshold. Only the first reading of a
   * login nothing is known of is waited for (at most `firstWaitMs`); any reading, however old, is
   * answered on while the next one comes. No reading of this period is ok (logged).
   */
  async check(adapter) {
    const guard = adapter?.creditGuard;
    if (!guard) return { ok: true };
    const e = this._entry(adapter);
    const pending = this.refresh(adapter);
    if (pending && !e.reading && !e.error) {
      let timer;
      await Promise.race([pending.catch(() => {}), new Promise((r) => (timer = setTimeout(r, this.firstWaitMs)))]);
      clearTimeout(timer);
    }
    const now = this.now();
    const g = guardState(e, guard.threshold, now);
    if (g.state === 'unknown') return { ok: true, unknown: true, error: g.why, threshold: guard.threshold };
    const said = e.said[adapter.id] ?? null;
    const blocked = g.state === 'held back';
    if (said !== g.state && (said !== null || blocked)) {
      this.log(`kiro credit guard: ${adapter.id} ${blocked ? 'held back' : 'available again'} — ${describeReading(e.reading)}, threshold ${pct(guard.threshold)}${g.stale ? ` (read ${minutes(now - e.at)} ago; the newest reading failed)` : ''}`);
    }
    e.said[adapter.id] = g.state;
    const staleMarks = g.stale ? { stale: true, error: e.error } : {};
    if (!blocked) return { ok: true, reading: e.reading, ratio: g.ratio, threshold: guard.threshold, ...staleMarks };
    return {
      ok: false,
      reading: e.reading,
      ratio: g.ratio,
      threshold: guard.threshold,
      ageMs: Math.max(0, now - e.at),
      ...staleMarks,
      detail: `Kiro plan at ${describeReading(e.reading)}, at or over this adapter's creditGuardThreshold of ${pct(guard.threshold)}${g.stale ? ` — read ${minutes(now - e.at)} ago, and the newest reading failed (${truncate(e.error, 100)}): the meter only climbs until the plan resets, so it stays held back` : ''}`,
    };
  }

  /** What the guard knows, per login, for doctor, status and /v1/keysmith/routes: no secrets in it. */
  snapshot() {
    this._sync();
    const now = this.now();
    return [...this.entries.values()].map((e) => ({
      bin: e.bin,
      adapters: [...e.adapters],
      reading: e.reading ? { ...e.reading } : null,
      readAt: e.at ? new Date(e.at).toISOString() : null,
      ageMs: e.at ? Math.max(0, now - e.at) : null,
      // Whether the reading is of the plan's current period (false: from before its reset).
      currentPeriod: e.reading ? guardState(e, 1, now).state !== 'unknown' : null,
      error: e.error,
      // The newest attempt failed after the reading: it is gone by until one succeeds.
      stale: !!(e.error && e.lastAttemptAt > e.at),
      inflight: !!e.inflight,
      lastAttemptAt: e.lastAttemptAt ? new Date(e.lastAttemptAt).toISOString() : null,
      nextReadingAt: e.lastAttemptAt ? new Date(Math.max(e.lastAttemptAt, e.at) + this.ttlMs).toISOString() : null,
    }));
  }

  /** The state file's logins, or null when there is none to read. */
  _readFile() {
    if (!this.statePath) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return data?.logins && typeof data.logins === 'object' ? data.logins : null;
    } catch {
      return null;
    }
  }

  _stamp() {
    try {
      const st = fs.statSync(this.statePath);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /**
   * What other processes kept in the state file since this one last looked, merged in: per login
   * the newer reading (by when it was read) and the newer attempt (with its error). `force` reads
   * the file even when it looks unchanged.
   */
  _sync({ force = false } = {}) {
    if (!this.statePath) return;
    const stamp = this._stamp();
    if (!stamp || (!force && stamp === this._fileStamp)) return;
    const logins = this._readFile();
    this._fileStamp = stamp;
    if (!logins) return;
    for (const [key, s] of Object.entries(logins)) {
      if (!s || typeof s !== 'object') continue;
      const reading = s.reading && Number.isFinite(s.reading.used) && Number.isFinite(s.reading.limit) && s.reading.limit > 0 ? { used: s.reading.used, limit: s.reading.limit, ratio: s.reading.used / s.reading.limit, resetsOn: s.reading.resetsOn || null } : null;
      const at = Number(s.at) || 0;
      const lastAttemptAt = Number(s.lastAttemptAt) || 0;
      const error = typeof s.error === 'string' ? s.error : null;
      const adapters = Array.isArray(s.adapters) ? s.adapters.filter((a) => typeof a === 'string') : [];
      let e = this.entries.get(key);
      if (!e) {
        this.entries.set(key, { bin: String(s.bin || ''), adapters, reading, at, error, lastAttemptAt, inflight: null, said: {} });
        continue;
      }
      for (const a of adapters) if (!e.adapters.includes(a)) e.adapters.push(a);
      if (reading && at > e.at) {
        e.reading = reading;
        e.at = at;
      }
      if (lastAttemptAt > e.lastAttemptAt) {
        e.lastAttemptAt = lastAttemptAt;
        e.error = error;
      }
    }
  }

  _save() {
    if (!this.statePath) return;
    // Another process's newer reading or attempt is merged in first, never written over.
    this._sync({ force: true });
    const logins = {};
    for (const [key, e] of this.entries) logins[key] = { bin: e.bin, adapters: e.adapters, reading: e.reading, at: e.at, error: e.error, lastAttemptAt: e.lastAttemptAt };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, logins }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
      this._fileStamp = this._stamp();
    } catch (err) {
      this.log(`kiro credit guard: could not keep its reading in ${this.statePath}: ${err.message}`);
    }
  }
}

function minutes(ms) {
  const m = Math.round(Math.max(0, ms) / 60_000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** The state file's readings without a guard: for `keysmith status`, which runs nothing. */
export function readCreditState(statePath, { now = Date.now(), ttlMs = CREDIT_GUARD_TTL_MS } = {}) {
  const g = new CreditGuard({ statePath, now: () => now, ttlMs, run: async () => '' });
  return g.snapshot();
}

/**
 * The 429 a request that names a held-back adapter gets (the spend cap's status and type). Its
 * retry-after is the time to the plan's reset, at most CREDIT_GUARD_MAX_RETRY_AFTER_S: the message
 * still names the reset date.
 */
export function creditGuardError(adapter, verdict, now = Date.now()) {
  const reset = verdict.reading?.resetsOn ? Date.parse(`${verdict.reading.resetsOn}T00:00:00Z`) : NaN;
  const err = new LlmError(
    `${adapter.id}: held back by the kiro credit guard — ${verdict.detail}${verdict.reading?.resetsOn ? ` (the plan resets on ${verdict.reading.resetsOn})` : ''}. Another leg answers inside a route; raise creditGuardThreshold on "${adapter.id}" to use it anyway`,
    { status: 429, type: 'rate_limit_error', provider: adapter.id },
  );
  const untilReset = Number.isFinite(reset) && reset > now ? Math.ceil((reset - now) / 1000) : Math.ceil(CREDIT_GUARD_TTL_MS / 1000);
  err.retryAfter = Math.max(1, Math.min(CREDIT_GUARD_MAX_RETRY_AFTER_S, untilReset));
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
