/**
 * The gateway key must never reach a log. Each test below drives one place keysmith writes
 * text — a banner, an error, a log line, a usage row — with a known key, then searches what
 * came out for it. They run the real CLI in a sandbox HOME (config, data dir and launchd's
 * log dir all inside it), with stdout/stderr redirected exactly as launchd and `keysmith
 * start` redirect them: to a file.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprint, redactKey, redactSecrets, registerSecrets, scrubBuffer } from '../src/redact.js';
import { openPrivateLog, precreatePrivateLogs, scrubLogFile, secureLogFiles } from '../src/logfiles.js';
import { gatewayPlist, launchdLogFiles, tunnelPlist } from '../src/service.js';
import { UsageLog } from '../src/usage.js';
import { createServer } from '../src/server.js';
import { Gateway } from '../src/gateway.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const KEY = mint();

const cleanups = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
});

function sandbox({ keys = [KEY], extra = {}, rawConfig = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-secrets-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  if (rawConfig != null) fs.writeFileSync(config, rawConfig, { mode: 0o600 });
  else if (keys) fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys }, adapters: {}, ...extra }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  return { home, config, data, env, run };
}

/**
 * Not the key, and no 6 characters in a row of its random part either: V8 quotes 7 of them
 * around a JSON syntax error, and a quoted fragment is a leak too. (A redacted form shows
 * the first 4 characters, then `…`, so it never matches a window starting at index 3.)
 */
function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 3; i + 6 <= key.length; i++) {
    assert.ok(!text.includes(key.slice(i, i + 6)), `${where}: 6 characters of the key were printed`);
  }
}

const modeOf = (p) => fs.statSync(p).mode & 0o777;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function waitFor(fn, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

/** `keysmith serve` the way launchd runs it: stdout and stderr appended to launchd-gateway.log. */
async function serveLikeLaunchd(sb, { verbose = false, logMode = 0o644 } = {}) {
  const port = await freePort();
  const logFile = launchdLogFiles(sb.data)[0];
  fs.mkdirSync(sb.data, { recursive: true });
  fs.chmodSync(sb.data, 0o755); // what an older keysmith left: mkdir with the default umask
  const fd = fs.openSync(logFile, 'a', logMode);
  fs.fchmodSync(fd, logMode); // launchd creates StandardOutPath with the default umask
  const env = { ...sb.env, ...(verbose ? { KEYSMITH_VERBOSE: '1' } : {}) };
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  cleanups.push(() => child.kill('SIGKILL'));
  const text = () => fs.readFileSync(logFile, 'utf8');
  await waitFor(() => /key\s+:/.test(text()));
  return {
    port,
    logFile,
    text,
    async stop() {
      if (child.exitCode != null) return;
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await gone;
    },
  };
}

/* ---------------------------------------------------------------- the redacted form */

test('a redacted key keeps 4 characters, the length and a fingerprint — nothing else', () => {
  const r = redactKey(KEY);
  assert.match(r, /^ks_.…35 fp:[0-9a-f]{8}$/);
  assert.equal(r, `${KEY.slice(0, 4)}…35 fp:${fingerprint(KEY)}`);
  assertNoKey(r, KEY, 'redactKey');
  // A short hand-written key gets no prefix at all: four characters of it would be a quarter.
  assert.equal(redactKey('hunter2-hunter2'), `…15 fp:${fingerprint('hunter2-hunter2')}`);
});

test('output redaction takes out configured keys of any shape, and anything shaped like a minted key', () => {
  const custom = 'my-own-gateway-secret-' + crypto.randomBytes(6).toString('hex');
  const stranger = mint(); // a revoked key, or one from another machine: never configured here
  registerSecrets([custom]);
  const s = redactSecrets(`custom=${custom} minted=${stranger} session=kss_abcdefabcdefabcdefab`);
  assertNoKey(s, custom, 'configured key');
  assertNoKey(s, stranger, 'key-shaped string');
  assert.ok(s.includes(redactKey(custom)) && s.includes(redactKey(stranger)), s);
  assert.ok(s.includes('kss_abcdefabcdefabcdefab'), 'session ids are not keys');
});

/* ---------------------------------------------------------------------- CLI outputs */

test('init, piped: the new key is written to the config, and printed only redacted', () => {
  const sb = sandbox({ keys: null });
  const r = sb.run('init');
  assert.equal(r.status, 0, r.stderr);
  const key = JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys[0];
  assert.match(key, /^ks_/);
  assertNoKey(r.stdout + r.stderr, key, 'init');
  assert.ok(r.stdout.includes(redactKey(key)), r.stdout);
  assert.match(r.stderr, /not an interactive terminal/);
});

test('serve banner, as launchd logs it: the key is named, never printed', async (t) => {
  const sb = sandbox();
  const gw = await serveLikeLaunchd(sb);
  t.after(() => gw.stop());
  const text = gw.text();
  assertNoKey(text, KEY, 'launchd-gateway.log');
  assert.ok(text.includes(redactKey(KEY)), text);
});

test('serve tightens launchd\'s 0644 log and the 0755 data dir on start', async (t) => {
  const sb = sandbox();
  const gw = await serveLikeLaunchd(sb, { logMode: 0o644 });
  t.after(() => gw.stop());
  assert.equal(modeOf(gw.logFile), 0o600);
  assert.equal(modeOf(sb.data), 0o700);
});

/**
 * A CLI pointed back at this gateway with its key on the argv, rejecting it loudly: the error
 * text is whatever the CLI printed, and that text is what the gateway log and usage.jsonl keep.
 * One failed request, run once, read by the two tests after it.
 */
let echoRun = null;
function failedRequestQuotingTheKey() {
  echoRun ??= (async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-echo-'));
    cleanups.push(() => fs.rmSync(stubDir, { recursive: true, force: true }));
    const bin = path.join(stubDir, 'echoer');
    fs.writeFileSync(bin, `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nprocess.stderr.write('auth rejected for key ' + a[a.indexOf('--api-key') + 1] + '\\n');\nprocess.exit(3);\n`, { mode: 0o755 });
    const sb = sandbox({ extra: { adapters: { echo: { kind: 'cli', bin, args: ['--api-key', KEY, '{prompt}'], parser: 'raw', models: ['m'], timeoutMs: 10_000 } } } });
    const gw = await serveLikeLaunchd(sb, { verbose: true });
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'echo/m', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      const usageFile = path.join(sb.data, 'usage.jsonl');
      await waitFor(() => fs.existsSync(usageFile) && /auth rejected/.test(gw.text()));
      return { status: res.status, log: gw.text(), usage: fs.readFileSync(usageFile, 'utf8') };
    } finally {
      await gw.stop();
    }
  })();
  return echoRun;
}

test('an adapter error that quotes the key: the verbose gateway log (launchd\'s file) has it redacted', async () => {
  const { status, log } = await failedRequestQuotingTheKey();
  assert.ok(status >= 500, `expected the stub to fail, got ${status}`);
  assert.match(log, /auth rejected for key/, 'the failure itself must still be logged');
  assertNoKey(log, KEY, 'verbose gateway log');
  assert.ok(log.includes(redactKey(KEY)), log);
});

test('an adapter error that quotes the key: usage.jsonl has it redacted, and stays one JSON object per line', async () => {
  const { usage } = await failedRequestQuotingTheKey();
  assert.match(usage, /auth rejected for key/);
  assertNoKey(usage, KEY, 'usage.jsonl');
  assert.ok(usage.includes(redactKey(KEY)), usage);
  for (const line of usage.trim().split('\n')) JSON.parse(line);
});

test('key list, piped: one redacted line per key, and a note on stderr saying why', () => {
  const sb = sandbox();
  const list = sb.run('key', 'list');
  assert.equal(list.status, 0, list.stderr);
  assertNoKey(list.stdout + list.stderr, KEY, 'key list');
  assert.equal(list.stdout.trim(), redactKey(KEY));
  assert.match(list.stderr, /not an interactive terminal/);
});

test('key add, piped: the new key goes to the config and is printed redacted', () => {
  const sb = sandbox();
  const add = sb.run('key', 'add');
  assert.equal(add.status, 0, add.stderr);
  const keys = JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys;
  assert.equal(keys.length, 2);
  assertNoKey(add.stdout + add.stderr, keys[1], 'key add');
  assert.equal(add.stdout.trim(), redactKey(keys[1]));
});

test('key revoke: a key that matched nothing is not echoed, and the fingerprint from a log revokes', () => {
  const sb = sandbox();
  const unknown = mint();
  const miss = sb.run('key', 'revoke', unknown);
  assertNoKey(miss.stdout + miss.stderr, unknown, 'revoke of an unknown key');
  assert.match(miss.stdout, /no key matched/);

  const hit = sb.run('key', 'revoke', `fp:${fingerprint(KEY)}`);
  assert.equal(hit.status, 0, hit.stderr);
  assertNoKey(hit.stdout + hit.stderr, KEY, 'revoke');
  assert.match(hit.stdout, /revoked 1 key/);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys, []);
});

test('a key generated by loadConfig (auth on, no keys) is reported redacted on stderr', () => {
  const sb = sandbox({ keys: [] });
  const r = sb.run('doctor');
  assert.equal(r.status, 0, r.stderr);
  const key = JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys[0];
  assert.match(r.stderr, /no API keys configured — generated/);
  assertNoKey(r.stdout + r.stderr, key, 'generated-key notice');
});

test('a config that is not valid JSON: the error says where, never the text around it', () => {
  const sb = sandbox({ rawConfig: `{"auth":{"enabled":true,"keys":[${KEY}]}}` });
  const r = sb.run('serve', '--port', '0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid JSON/);
  assertNoKey(r.stdout + r.stderr, KEY, 'JSON error');
});

test('doctor, status, adapters, models, usage and tunnel status never print the key', () => {
  const sb = sandbox();
  for (const args of [['doctor'], ['status'], ['adapters'], ['models'], ['usage'], ['tunnel', 'status'], ['--help']]) {
    const r = sb.run(...args);
    assertNoKey(r.stdout + r.stderr, KEY, args.join(' '));
  }
});

test('the status page, opened with ?api_key=, does not echo the key into the page', async (t) => {
  const cfg = { host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} };
  const server = createServer(new Gateway(cfg, { log: () => {} }), cfg, { usage: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/?api_key=${KEY}`);
  assert.equal(res.status, 200);
  assertNoKey(await res.text(), KEY, 'status page');
});

test('start: keysmith.log is created 0600 in a 0700 dir and its banner holds no key', async (t) => {
  const port = await freePort();
  const sb = sandbox({ extra: { port } });
  const r = sb.run('start');
  assert.equal(r.status, 0, r.stderr);
  t.after(() => sb.run('stop'));
  const logFile = path.join(sb.data, 'keysmith.log');
  await waitFor(() => /key\s+:/.test(fs.readFileSync(logFile, 'utf8')));
  assert.equal(modeOf(logFile), 0o600);
  assert.equal(modeOf(sb.data), 0o700);
  assertNoKey(fs.readFileSync(logFile, 'utf8') + r.stdout + r.stderr, KEY, 'keysmith.log');
});

/* -------------------------------------------------------------- interactive terminal */

const scriptArgv = (argv) =>
  process.platform === 'darwin' ? ['-q', '/dev/null', ...argv] : ['-qec', argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'];
const hasScript = spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', 'true'] : ['-qec', 'true', '/dev/null'], { stdio: 'ignore' }).status === 0;

test('key list in an interactive terminal still shows the full key — that is its job', { skip: !hasScript && 'no script(1) to give the child a terminal' }, () => {
  const sb = sandbox();
  // stdin from /dev/null: BSD script(1) refuses a socket for stdin, and gives the child a pty either way.
  const r = spawnSync('script', scriptArgv([process.execPath, CLI, 'key', 'list']), { env: sb.env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(r.stdout.includes(KEY), 'a terminal is where the key is shown');
});

/* ------------------------------------------------------------------------ file modes */

test('the usage log is created 0600 in a 0700 directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-modes-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'usage.jsonl');
  new UsageLog(file).record({ model: 'm', status: 'ok', ms: 1 });
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
});

test('install-service pre-creates launchd\'s logs 0600, so launchd never makes them 0644', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-modes-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'logs');
  const files = launchdLogFiles(dir);
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(files[1], 'old\n', { mode: 0o644 });
  fs.chmodSync(files[1], 0o644);
  precreatePrivateLogs(files);
  for (const f of files) assert.equal(modeOf(f), 0o600, f);
  // ...and these are the files the plists point launchd at.
  const gw = gatewayPlist({ nodeBin: '/opt/homebrew/bin/node', entry: '/x/src/cli.js', port: 8787 });
  const tn = tunnelPlist({ cloudflared: '/opt/homebrew/bin/cloudflared', name: 'keysmith', configFile: '/x/keysmith.yml' });
  assert.ok(gw.includes(`<string>${launchdLogFiles()[0]}</string>`) && tn.includes(`<string>${launchdLogFiles()[1]}</string>`));
  assert.equal(modeOf(dir), 0o700);
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'old\n', 'existing content is kept');
});

test('secureLogFiles drops group/other bits, never widens, and skips what is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-modes-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const wide = path.join(root, 'wide.log');
  const narrow = path.join(root, 'narrow.log');
  fs.writeFileSync(wide, '', { mode: 0o664 });
  fs.chmodSync(wide, 0o664);
  fs.writeFileSync(narrow, '', { mode: 0o400 });
  fs.chmodSync(narrow, 0o400);
  fs.chmodSync(root, 0o755);
  const { changed, failed } = secureLogFiles({ dirs: [root], files: [wide, narrow, path.join(root, 'absent.log')] });
  assert.deepEqual(failed, []);
  assert.deepEqual(changed.sort(), [root, wide].sort());
  assert.equal(modeOf(wide), 0o600);
  assert.equal(modeOf(narrow), 0o400);
  assert.equal(modeOf(root), 0o700);
});

test('openPrivateLog creates a log 0600, and narrows one that was 0644', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-modes-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const fresh = path.join(root, 'sub', 'fresh.log');
  const old = path.join(root, 'old.log');
  fs.writeFileSync(old, 'kept\n', { mode: 0o644 });
  fs.chmodSync(old, 0o644);
  for (const f of [fresh, old]) fs.closeSync(openPrivateLog(f));
  assert.equal(modeOf(fresh), 0o600);
  assert.equal(modeOf(path.dirname(fresh)), 0o700);
  assert.equal(modeOf(old), 0o600);
  assert.equal(fs.readFileSync(old, 'utf8'), 'kept\n');
});

/* ------------------------------------------------------------------------- scrubbing */

test('scrubBuffer replaces keys byte-exactly and leaves bytes that are not UTF-8 alone', () => {
  const other = mint();
  const before = Buffer.concat([Buffer.from(`a ${KEY} b\n`), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(` ${other} ${KEY}\n`)]);
  const { buf, configured, shaped } = scrubBuffer(before, [KEY]);
  assert.equal(configured, 2);
  assert.equal(shaped, 1);
  const latin = buf.toString('latin1');
  assert.ok(!latin.includes(KEY) && !latin.includes(other));
  assert.ok(buf.includes(Buffer.from([0xff, 0xfe, 0x00])), 'invalid UTF-8 survives untouched');
  assert.ok(buf.includes(Buffer.from(redactKey(KEY), 'utf8')));
});

test('scrub-logs rewrites the logs in place, tightens them, and prints counts only', () => {
  const sb = sandbox();
  const other = mint();
  fs.mkdirSync(sb.data, { recursive: true });
  fs.chmodSync(sb.data, 0o755);
  const gwLog = launchdLogFiles(sb.data)[0];
  fs.writeFileSync(gwLog, `keysmith listening\n  key     : ${KEY}\n  key     : ${KEY}\n`, { mode: 0o644 });
  fs.chmodSync(gwLog, 0o644);
  fs.writeFileSync(path.join(sb.data, 'keysmith.log'), `  key     : ${other}\n`);
  const inode = fs.statSync(gwLog).ino;
  const appender = fs.openSync(gwLog, 'a'); // launchd's fd, held across the scrub

  const r = sb.run('scrub-logs');
  assert.equal(r.status, 0, r.stderr);
  assertNoKey(r.stdout + r.stderr, KEY, 'scrub-logs output');
  assertNoKey(r.stdout + r.stderr, other, 'scrub-logs output');
  assert.match(r.stdout, /launchd-gateway\.log\s+2 configured key\(s\), 0 other/);
  assert.match(r.stdout, /keysmith\.log\s+0 configured key\(s\), 1 other/);

  fs.writeSync(appender, 'after scrub\n');
  fs.closeSync(appender);
  const text = fs.readFileSync(gwLog, 'utf8');
  assertNoKey(text, KEY, 'scrubbed launchd-gateway.log');
  assert.equal(fs.statSync(gwLog).ino, inode, 'same file: launchd keeps appending to it');
  assert.match(text, /after scrub\n$/, 'an fd opened before the scrub appends to the new end');
  assert.equal(modeOf(gwLog), 0o600);
  assert.equal(modeOf(sb.data), 0o700);
  assertNoKey(fs.readFileSync(path.join(sb.data, 'keysmith.log'), 'utf8'), other, 'scrubbed keysmith.log');

  const again = sb.run('scrub-logs');
  assert.match(again.stdout, /^0 replacement/m, 'a second run finds nothing');
});

test('scrubLogFile on a missing file is a no-op', () => {
  assert.equal(scrubLogFile(path.join(os.tmpdir(), `keysmith-absent-${process.pid}.log`), [KEY]), null);
});
