import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { ensurePrivateDir, FILE_MODE } from './logfiles.js';
import { redactSecrets } from './redact.js';

/**
 * Append-only JSONL usage log: the thing you reach for at 1am when a CLI adapter is
 * quietly eating your quota. Kept as one line per request so `tail -f` is a dashboard.
 *
 * A line holds the time, model, status, duration, token counts, stream flag, user agent
 * and — for a failure — the error message; with auth on, the fingerprint of the gateway key
 * the request came with (`key: "fp:3f9a0c12"`) and what its scope decided (`scope`:
 * `unscoped`, `allowed` or `denied`, with `skipped` naming alias legs it left out). Never the
 * key, the prompt, the answer, a header or the request URL. An error message can still quote anything (a CLI that echoes its argv
 * quotes the prompt), so every string in a line goes through the same redaction as
 * stdout: a gateway key in it is written as `ks_Q…35 fp:…`. Each field is redacted before
 * the line is JSON-encoded, not after: JSON spells a key holding `"` or `\` differently
 * from the key, and a replacement spliced into encoded JSON could break the line. The file
 * is 0600 in a 0700 directory.
 */
export class UsageLog {
  /** `now`: the clock a row's `ts` is read from (ms), injectable for a test. */
  constructor(file = null, { now = () => Date.now() } = {}) {
    this.file = file || path.join(dataDir(), 'usage.jsonl');
    this.enabled = true;
    this.now = now;
  }

  record(entry) {
    if (!this.enabled) return;
    try {
      ensurePrivateDir(path.dirname(this.file));
      const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry }, (_, v) => (typeof v === 'string' ? redactSecrets(v) : v));
      fs.appendFileSync(this.file, line + '\n', { mode: FILE_MODE });
    } catch {
      /* logging must never break a response */
    }
  }

  /** The latest `n` entries, newest first; with `filter`, the latest `n` it keeps (of the last 5000). */
  tail(n = 50, filter = null) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    const rows = lines
      .slice(filter ? -5000 : -n)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
    return filter ? rows.filter(filter).slice(0, n) : rows;
  }

  /**
   * Every row written at or after `since` (ms), oldest first — what the daily caps rebuild their
   * counts from at start (quota.js). Rows are appended as requests end, so the file is in `ts`
   * order: the read walks back from the end and stops at the first older row. A line that does
   * not parse is skipped.
   */
  rowsSince(since) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n');
    const rows = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const t = Date.parse(e?.ts || '');
      if (!Number.isFinite(t)) continue;
      if (t < since) break;
      rows.push(e);
    }
    return rows.reverse();
  }

  /** Counts per model and per gateway key over `windowMs`; `filter` keeps only the entries it accepts. */
  summarize(windowMs = 24 * 3600 * 1000, filter = null) {
    const since = Date.now() - windowMs;
    const byModel = new Map();
    const byKey = new Map();
    let requests = 0;
    let failures = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const e of this.tail(5000, filter)) {
      const t = Date.parse(e.ts || '');
      if (!Number.isFinite(t) || t < since) continue;
      requests++;
      if (e.status !== 'ok') failures++;
      tokensIn += e.usage?.input || 0;
      tokensOut += e.usage?.output || 0;
      const k = e.model || 'unknown';
      const row = byModel.get(k) || { model: k, requests: 0, failures: 0, input: 0, output: 0, msTotal: 0 };
      row.requests++;
      if (e.status !== 'ok') row.failures++;
      row.input += e.usage?.input || 0;
      row.output += e.usage?.output || 0;
      row.msTotal += e.ms || 0;
      byModel.set(k, row);
      if (typeof e.key === 'string') {
        const kr = byKey.get(e.key) || { key: e.key, requests: 0, denied: 0 };
        kr.requests++;
        if (e.status === 'denied') kr.denied++;
        byKey.set(e.key, kr);
      }
    }
    return {
      window: `${Math.round(windowMs / 3600000)}h`,
      requests,
      failures,
      tokensIn,
      tokensOut,
      models: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      keys: [...byKey.values()].sort((a, b) => b.requests - a.requests),
    };
  }
}
