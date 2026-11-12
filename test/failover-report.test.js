/**
 * What `keysmith doctor`, `keysmith status` and /v1/keysmith/routes say about failover
 * (src/failover-report.js): which legs of each alias carry a tool request, what the Kiro credit
 * guard last read and whom it holds back, and the legs requests were passed by lately, with why.
 * The kiro-cli here is a stub of that name that prints a fixture: the real one is never run.
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
import { CreditGuard } from '../src/credit-guard.js';
import { createServer } from '../src/server.js';
import { carriageLines, creditGuardLines, creditGuardRows, recentSkips, skipLines, toolCarriage } from '../src/failover-report.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

function config(dir, kiroBin) {
  return {
    host: '127.0.0.1',
    port: 1,
    auth: { enabled: true, keys: [KEY] },
    log: { usage: true },
    limits: {},
    adapters: {
      agy: { kind: 'cli', bin: '/bin/echo', args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: path.join(dir, 'ws-agy'), toolMode: 'emulate' },
      kiro: { kind: 'cli', bin: kiroBin, args: ['{prompt}'], parser: 'raw', models: ['m'] },
      copilot: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['gpt-4.1'] },
      claude: { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['sonnet'] },
    },
    aliases: { chat: ['agy/m', 'copilot/gpt-4.1', 'kiro/m'], cheap: ['copilot/gpt-4.1', 'claude/sonnet'] },
  };
}

test('toolCarriage and carriageLines: per alias and face, the legs that carry a tool request, and why the others do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fr-'));
  try {
    const gateway = new Gateway(config(dir, '/opt/kiro/bin/kiro-cli'), { log: () => {}, deferAdapterChecks: true });
    const c = toolCarriage(gateway);
    const chatMsgs = c.find((x) => x.alias === 'chat' && x.face === 'anthropic');
    assert.deepEqual([chatMsgs.route, chatMsgs.carried, chatMsgs.total], ['/v1/messages', 1, 3]);
    assert.deepEqual(chatMsgs.legs.map((l) => [l.target, l.carries, l.reason || null]), [['agy/m', true, null], ['copilot/gpt-4.1', false, 'wire_no_tools'], ['kiro/m', false, 'tool_mode_off']]);
    assert.equal(chatMsgs.legs[2].guarded, true, 'the kiro leg is under the credit guard');
    const chatOai = c.find((x) => x.alias === 'chat' && x.face === 'openai');
    assert.equal(chatOai.carried, 2, 'on /v1/chat/completions the openai-wire leg is relayed verbatim');
    const cheapMsgs = c.find((x) => x.alias === 'cheap' && x.face === 'anthropic');
    assert.equal(cheapMsgs.carried, 0);
    const lines = carriageLines(c).map((l) => `${l.mark} ${l.text}`);
    assert.ok(lines.includes('! chat: legs that carry tools — /v1/messages 1/3 (agy/m) · /v1/chat/completions 2/3 (agy/m, copilot/gpt-4.1)'), lines.join('\n'));
    assert.ok(lines.some((l) => /^✗ cheap: legs that carry tools — \/v1\/messages 0\/2 · \/v1\/chat\/completions 1\/2 \(copilot\/gpt-4\.1\) — a tool request on \/v1\/messages \(Claude Code\) to it is a 400$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^· kiro on \/v1\/messages: toolMode off: it answers in text only/.test(l)));
    assert.ok(lines.some((l) => /^· claude on \/v1\/messages: an HTTP upstream on the anthropic wire is never handed tools/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recentSkips and skipLines: the last 24 h of skippedLegs, counted per leg and reason, the latest first', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const row = (ts, skippedLegs) => ({ ts, model: 'chat', status: 'ok', skippedLegs });
  const rows = [
    row('2026-11-11T11:00:00Z', [{ target: 'kiro/m', reason: 'credit_guard', detail: 'old' }]), // 25 h ago
    row('2026-11-12T09:00:00Z', [{ target: 'copilot/gpt-4.1', reason: 'wire_no_tools', detail: 'no relay on /v1/messages' }]),
    row('2026-11-12T10:00:00Z', [{ target: 'copilot/gpt-4.1', reason: 'wire_no_tools', detail: 'no relay on /v1/messages' }, { target: 'kiro/m', reason: 'credit_guard', detail: 'Kiro plan at 96%' }]),
    { ts: '2026-11-12T11:00:00Z', model: 'chat', status: 'ok' },
  ];
  const skips = recentSkips(rows, { now });
  assert.deepEqual(skips.map((s) => [s.target, s.reason, s.count, s.last]), [
    ['copilot/gpt-4.1', 'wire_no_tools', 2, '2026-11-12T10:00:00.000Z'],
    ['kiro/m', 'credit_guard', 1, '2026-11-12T10:00:00.000Z'],
  ]);
  assert.equal(skips.find((s) => s.reason === 'credit_guard').detail, 'Kiro plan at 96%');
  const lines = skipLines(skips).map((l) => `${l.mark} ${l.text}`);
  assert.deepEqual(lines, ['· copilot/gpt-4.1 wire_no_tools ×2 (last 2026-11-12 10:00Z) — no relay on /v1/messages', '! kiro/m credit_guard ×1 (last 2026-11-12 10:00Z) — Kiro plan at 96%']);
  assert.deepEqual(skipLines([]), [{ mark: '✓', text: 'no leg was passed by in the last 24 h' }]);
});

test('creditGuardRows and creditGuardLines: each adapter with its threshold and state; a failed or missing reading says so and holds nothing back', async () => {
  let out = 'Estimated Usage | resets on 2026-12-01 | KIRO POWER\nCredits (9200 of 10000 covered in plan), 92.0%\n';
  let t = Date.parse('2026-11-12T10:00:00Z');
  const guard = new CreditGuard({ now: () => t, run: async () => (out instanceof Error ? Promise.reject(out) : out) });
  const a = (id, threshold) => ({ id, kind: 'cli', bin: '/opt/kiro/bin/kiro-cli', env: {}, creditGuard: { kind: 'kiro', threshold } });
  const adapters = new Map([['kiro', a('kiro', 0.9)], ['kiro-emu', a('kiro-emu', 0.95)]]);
  await guard.check(adapters.get('kiro'));
  await guard.check(adapters.get('kiro-emu'));
  t += 120_000;
  let rows = creditGuardRows(guard.snapshot(), { adapters });
  assert.deepEqual(rows[0].adapters, [{ id: 'kiro', threshold: 0.9, state: 'held back' }, { id: 'kiro-emu', threshold: 0.95, state: 'ok' }]);
  let [line] = creditGuardLines(rows);
  assert.equal(line.mark, '✗');
  assert.equal(line.text, 'kiro (held back at 90%), kiro-emu (held back at 95%): 9,200 of 10,000 credits (92%) · HELD BACK: kiro · read 2 min ago · plan resets 2026-12-01');
  // The thresholds of a process that holds no adapters (status) come from the config.
  rows = creditGuardRows(guard.snapshot(), { cfg: { adapters: { kiro: { kind: 'cli', bin: 'kiro-cli' }, 'kiro-emu': { kind: 'cli', bin: 'kiro-cli', creditGuardThreshold: 0.95 } } } });
  assert.deepEqual(rows[0].adapters.map((x) => [x.id, x.threshold, x.state]), [['kiro', 0.9, 'held back'], ['kiro-emu', 0.95, 'ok']]);
  // The next reading fails: nothing is held back, and the line says why.
  out = new Error('exited 1: not logged in');
  t += 10 * 60_000;
  await guard.refresh(adapters.get('kiro'));
  [line] = creditGuardLines(creditGuardRows(guard.snapshot(), { adapters }));
  assert.equal(line.mark, '!');
  assert.match(line.text, /not held back \(the newest reading failed\).*last error: exited 1: not logged in/);
  // No reading at all.
  const blind = new CreditGuard({ run: async () => 'no credits line' });
  await blind.check(a('kiro', 0.9));
  [line] = creditGuardLines(creditGuardRows(blind.snapshot(), { adapters }));
  assert.equal(line.mark, '!');
  assert.match(line.text, /^kiro \(held back at 90%\): no reading of the Kiro plan yet — the last one failed: no "Credits/);
});

test('/v1/keysmith/routes: credit_guards names each guarded adapter the key may reach, its threshold, state and the plan reading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fr-routes-'));
  const cfg = config(dir, '/opt/kiro/bin/kiro-cli');
  const guard = new CreditGuard({ run: async () => 'Credits (9500 of 10000 covered in plan), 95%' });
  const gateway = new Gateway(cfg, { log: () => {}, deferAdapterChecks: true, creditGuard: guard });
  await guard.check(gateway.adapters.get('kiro'));
  const server = createServer(gateway, cfg, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/keysmith/routes`, { headers: { authorization: `Bearer ${KEY}` } });
    const body = await r.json();
    assert.equal(body.credit_guards.length, 1);
    const [g] = body.credit_guards;
    assert.deepEqual(g.adapters, [{ id: 'kiro', threshold: 0.9, state: 'held back' }]);
    assert.deepEqual([g.reading.used, g.reading.limit], [9500, 10000]);
    assert.equal('bin' in g, false, 'no paths of this machine');
    // The status page has the same, for a key with no scope.
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { authorization: `Bearer ${KEY}` } })).text();
    assert.match(html, /<h2>Kiro credit guard<\/h2>.*kiro \(held back at 90%\): 9,500 of 10,000 credits \(95%\) · HELD BACK: kiro/s);
    assert.match(html, /<h2>Legs passed by \(24h\)<\/h2>.*no leg was passed by in the last 24 h/s);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keysmith doctor and status: the tool carriage, the credit guard and the legs passed by — doctor reads the plan at most once per ten minutes, status never', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fr-cli-'));
  try {
    const bins = path.join(dir, 'bin');
    fs.mkdirSync(bins);
    const calls = path.join(dir, 'kiro-calls.log');
    const kiroBin = path.join(bins, 'kiro-cli');
    // A stand-in named kiro-cli: `/usage` prints a fixture, and every run is counted.
    fs.writeFileSync(
      kiroBin,
      `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv.slice(2).join(' ') === 'chat --no-interactive /usage') process.stdout.write('\\u001b[1mEstimated Usage\\u001b[0m | resets on 2026-12-01 | KIRO POWER\\nCredits (9,500 of 10,000 covered in plan), 95.0%\\n');\n`,
      { mode: 0o755 },
    );
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config(dir, kiroBin)), { mode: 0o600 });
    const ts = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(data, 'usage.jsonl'),
      [
        { ts, model: 'chat', status: 'ok', ms: 5, skippedLegs: [{ target: 'copilot/gpt-4.1', reason: 'wire_no_tools', detail: 'an HTTP upstream on the openai wire is handed tools verbatim on /v1/chat/completions only, not on /v1/messages' }] },
        { ts, model: 'chat', status: 'ok', ms: 5, skippedLegs: [{ target: 'kiro/m', reason: 'credit_guard', detail: 'Kiro plan at 9,500 of 10,000 credits (95%)' }] },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KEYSMITH_DATA: data, KEYSMITH_CONFIG: cfgPath };
    delete env.KEYSMITH_VERBOSE;
    const run = (cmd) => spawnSync(process.execPath, [CLI, cmd], { env, encoding: 'utf8', timeout: 60_000 });
    const usageRuns = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === 'chat --no-interactive /usage').length : 0);

    const doc = run('doctor');
    assert.equal(doc.status, 0, doc.stderr);
    assert.match(doc.stdout, /failover {3}tool requests \(a leg that cannot carry them is passed by, never asked for text\):/);
    assert.match(doc.stdout, /! chat: legs that carry tools — \/v1\/messages 1\/3 \(agy\/m\)/);
    assert.match(doc.stdout, /✗ cheap: legs that carry tools — \/v1\/messages 0\/2 .* a tool request on \/v1\/messages \(Claude Code\) to it is a 400/);
    assert.match(doc.stdout, /credits {4}the Kiro credit guard/);
    assert.match(doc.stdout, /✗ kiro \(held back at 90%\): 9,500 of 10,000 credits \(95%\) · HELD BACK: kiro · read \d+ s ago · plan resets 2026-12-01/);
    assert.match(doc.stdout, /skipped {4}legs requests were passed by in the last 24 h, and why:/);
    assert.match(doc.stdout, /· copilot\/gpt-4\.1 wire_no_tools ×1/);
    assert.match(doc.stdout, /! kiro\/m credit_guard ×1 .*Kiro plan at 9,500 of 10,000 credits/);
    assert.equal(usageRuns(), 1, 'doctor read the plan once');
    assert.equal(fs.statSync(path.join(data, 'credit-guard.json')).mode & 0o777, 0o600);

    // A second doctor inside ten minutes reads the kept reading: no second /usage.
    const again = run('doctor');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /HELD BACK: kiro/);
    assert.equal(usageRuns(), 1);

    const st = run('status');
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /credits : ✗ kiro \(held back at 90%\): 9,500 of 10,000 credits \(95%\) · HELD BACK: kiro/);
    assert.match(st.stdout, /skipped : · copilot\/gpt-4\.1 wire_no_tools ×1/);
    assert.match(st.stdout, /skipped : ! kiro\/m credit_guard ×1/);
    assert.equal(usageRuns(), 1, 'status runs no kiro-cli');
    for (const o of [doc.stdout, again.stdout, st.stdout]) assert.ok(!o.includes(KEY), 'no key printed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
