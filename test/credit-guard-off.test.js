/**
 * creditGuardThreshold with no upper bound, and "off" (src/credit-guard.js): the guard's verdicts,
 * how an off adapter shows in doctor/status/routes (never "Infinity" or "0%"), the CLI's refusal
 * of a bad value, and a live reload of the threshold. Every reading is a fixture; nothing runs
 * kiro-cli.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { CreditGuard, checkCreditGuard, evaluateCredits, parseKiroUsage, pct } from '../src/credit-guard.js';
import { createServer } from '../src/server.js';
import { creditGuardLines, creditGuardRows } from '../src/failover-report.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const usageOf = (used, limit = 10000) => `Estimated Usage | resets on 2026-12-01 | KIRO POWER\nCredits (${used} of ${limit} covered in plan), x%\n`;
const kiro = (id, guard) => ({ id, kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', env: {}, creditGuard: guard });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cg-off-'));

test('evaluateCredits: 3 lets 1.3 pass, a null threshold never blocks', () => {
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(13000)), 3).blocked, false);
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(30000)), 3).blocked, true);
  assert.equal(evaluateCredits(parseKiroUsage(usageOf(50000)), null).blocked, false);
  assert.equal(pct(null), 'off');
});

test('checkCreditGuard: accepts above 0 with no cap and "off"; refuses the rest, naming the field', () => {
  for (const ok of [1.3, 3, 100, 0.01]) assert.equal(checkCreditGuard('kiro', { creditGuardThreshold: ok }, 'kiro-cli').threshold, ok);
  assert.deepEqual(checkCreditGuard('kiro', { creditGuardThreshold: 'off' }, 'kiro-cli'), { kind: 'kiro', threshold: null, off: true });
  assert.equal(checkCreditGuard('kiro', {}, 'kiro-cli').threshold, 0.9, 'the default is unchanged');
  assert.equal(checkCreditGuard('kiro', { creditGuardThreshold: null }, 'kiro-cli').threshold, 0.9, 'null is unset');
  for (const bad of [-1, 0, NaN, 'abc', 'OFF ', true]) {
    assert.throws(() => checkCreditGuard('kiro', { creditGuardThreshold: bad }, 'kiro-cli'), /creditGuardThreshold must be .*"off"/, String(bad));
  }
  assert.throws(() => checkCreditGuard('agy', { creditGuardThreshold: 'off' }, 'agy'), /does not run kiro-cli/);
});

test('CreditGuard.check: the default holds at 95%, 3 lets 130% pass, "off" lets 500% pass and still reads the meter', async () => {
  const run = (used) => async () => usageOf(used);
  const held = new CreditGuard({ run: run(9500) });
  assert.equal((await held.check(kiro('kiro', { kind: 'kiro', threshold: 0.9 }))).ok, false);
  const three = new CreditGuard({ run: run(13000) });
  assert.equal((await three.check(kiro('kiro', { kind: 'kiro', threshold: 3 }))).ok, true);
  const off = new CreditGuard({ run: run(50000) });
  const v = await off.check(kiro('kiro', { kind: 'kiro', threshold: null, off: true }));
  assert.equal(v.ok, true);
  assert.equal(v.off, true);
  assert.equal(v.reading.used, 50000);
  assert.equal(v.ratio, 5);
});

test('creditGuardRows and creditGuardLines: an off adapter says "guard off", is never held back, and carries no Infinity', async () => {
  const guard = new CreditGuard({ run: async () => usageOf(50000) });
  const a = kiro('kiro', { kind: 'kiro', threshold: null, off: true });
  await guard.check(a);
  const adapters = new Map([['kiro', a]]);
  const rows = creditGuardRows(guard.snapshot(), { adapters });
  assert.deepEqual(rows[0].adapters, [{ id: 'kiro', threshold: null, off: true, state: 'ok' }]);
  const [line] = creditGuardLines(rows);
  assert.equal(line.mark, '✓');
  assert.match(line.text, /^kiro \(guard off\): 50,000 of 10,000 credits \(500%\) · ok/);
  const fromCfg = creditGuardRows(guard.snapshot(), { cfg: { adapters: { kiro: { kind: 'cli', bin: 'kiro-cli', creditGuardThreshold: 'off' } } } });
  assert.equal(fromCfg[0].adapters[0].off, true);
  assert.doesNotMatch(JSON.stringify(rows) + line.text, /Infinity/);
});

const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
function cfgOf(dir, threshold) {
  return {
    host: '127.0.0.1', port: 1, auth: { enabled: true, keys: [KEY] }, log: { usage: false }, limits: {},
    adapters: { kiro: { kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', args: ['{prompt}'], parser: 'raw', models: ['m'], ...(threshold === undefined ? {} : { creditGuardThreshold: threshold }) } },
    aliases: {},
    _path: path.join(dir, 'config.json'),
  };
}

test('/v1/keysmith/routes: an off adapter has threshold null and off true, and the body has no Infinity', async () => {
  const dir = tmpdir();
  const cfg = cfgOf(dir, 'off');
  const guard = new CreditGuard({ run: async () => usageOf(50000) });
  const gateway = new Gateway(cfg, { log: () => {}, deferAdapterChecks: true, creditGuard: guard });
  await guard.check(gateway.adapters.get('kiro'));
  const server = createServer(gateway, cfg, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/keysmith/routes`, { headers: { authorization: `Bearer ${KEY}` } });
    const text = await res.text();
    assert.doesNotMatch(text, /Infinity/);
    assert.deepEqual(JSON.parse(text).credit_guards[0].adapters, [{ id: 'kiro', threshold: null, off: true, state: 'ok' }]);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reload: a changed creditGuardThreshold reaches the running adapter; a bad value keeps the old guard and logs one line', async () => {
  const dir = tmpdir();
  const cfg = cfgOf(dir);
  fs.writeFileSync(cfg._path, JSON.stringify(cfg), { mode: 0o600 });
  const guard = new CreditGuard({ run: async () => usageOf(9500) });
  const logs = [];
  const gateway = new Gateway(cfg, { log: () => {}, deferAdapterChecks: true, creditGuard: guard });
  const server = createServer(gateway, cfg, { log: (m) => logs.push(m) });
  const write = (threshold) => {
    fs.writeFileSync(cfg._path, JSON.stringify({ ...cfg, adapters: { kiro: { ...cfg.adapters.kiro, creditGuardThreshold: threshold } } }));
    server.reloadKeys(true);
  };
  try {
    const adapter = gateway.adapters.get('kiro');
    assert.equal((await guard.check(adapter)).ok, false, 'held back at the default 0.9');
    write('off');
    assert.equal(adapter.creditGuard.off, true);
    assert.equal((await guard.check(adapter)).ok, true);
    write(0.5);
    assert.equal(adapter.creditGuard.threshold, 0.5);
    const before = logs.length;
    write('abc');
    assert.equal(adapter.creditGuard.threshold, 0.5, 'the old guard is kept');
    assert.equal(logs.slice(before).filter((l) => /creditGuardThreshold reload refused/.test(l)).length, 1);
    write(3);
    assert.equal((await guard.check(adapter)).ok, true);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keysmith set and status: off and 3 are saved, abc and -1 are refused; status shows "guard off" and "held back at 300%"', () => {
  const dir = tmpdir();
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    const cfgPath = path.join(dir, 'config.json');
    const cfg = cfgOf(dir);
    delete cfg._path;
    cfg.adapters.kiro2 = { ...cfg.adapters.kiro };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
    const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KEYSMITH_DATA: data, KEYSMITH_CONFIG: cfgPath };
    delete env.KEYSMITH_VERBOSE;
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    const out = (r) => r.stdout + r.stderr;
    assert.match(out(run('set', 'kiro', 'creditGuardThreshold', 'off')), /set kiro\.creditGuardThreshold/);
    assert.match(out(run('set', 'kiro2', 'creditGuardThreshold', '3')), /set kiro2\.creditGuardThreshold/);
    const bad = run('set', 'kiro', 'creditGuardThreshold', 'abc');
    assert.match(out(bad), /not saved:/);
    assert.match(out(run('set', 'kiro', 'creditGuardThreshold', '-1')), /not saved:/);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(saved.adapters.kiro.creditGuardThreshold, 'off');
    assert.equal(saved.adapters.kiro2.creditGuardThreshold, 3);
    const reset = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(data, 'credit-guard.json'), JSON.stringify({
      version: 1,
      logins: { l1: { bin: '/opt/kiro/bin/kiro-cli', adapters: ['kiro', 'kiro2'], reading: { used: 12000, limit: 10000, ratio: 1.2, resetsOn: reset }, at: Date.now(), error: null, lastAttemptAt: Date.now() } },
    }), { mode: 0o600 });
    const st = run('status');
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /credits : .*kiro \(guard off\)/);
    assert.match(st.stdout, /kiro2 \(held back at 300%\)/);
    assert.doesNotMatch(st.stdout, /Infinity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
