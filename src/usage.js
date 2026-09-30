import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

/**
 * Append-only JSONL usage log: the thing you reach for at 1am when a CLI adapter is
 * quietly eating your quota. Kept as one line per request so `tail -f` is a dashboard.
 */
export class UsageLog {
  constructor(file = null) {
    this.file = file || path.join(dataDir(), 'usage.jsonl');
    this.enabled = true;
  }

  record(entry) {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      /* logging must never break a response */
    }
  }

  tail(n = 50) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  }

  summarize(windowMs = 24 * 3600 * 1000) {
    const since = Date.now() - windowMs;
    const byModel = new Map();
    let requests = 0;
    let failures = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const e of this.tail(5000)) {
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
    }
    return {
      window: `${Math.round(windowMs / 3600000)}h`,
      requests,
      failures,
      tokensIn,
      tokensOut,
      models: [...byModel.values()].sort((a, b) => b.requests - a.requests),
    };
  }
}
