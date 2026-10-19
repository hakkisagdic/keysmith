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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, redactKey, redactSecrets, registerSecrets, scrubBuffer } from '../src/redact.js';
// Namespaces, not named imports, for what these tests added: a missing export fails the one
// test that needs it instead of the whole file.
import * as redact from '../src/redact.js';
import * as util from '../src/util.js';
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
  const lines = list.stdout.trim().split('\n');
  assert.equal(lines.length, 1, list.stdout);
  // The redacted key, then its label (none: "-") and its scope (none: it reaches everything).
  assert.equal(lines[0].split(/\s+/).slice(0, 2).join(' '), redactKey(KEY), list.stdout);
  assert.match(lines[0], /\s-\s+unscoped/);
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

test('key revoke takes the fingerprint only: a key on the argv is refused, not echoed, and revokes nothing', () => {
  const sb = sandbox();
  const keys = () => JSON.parse(fs.readFileSync(sb.config, 'utf8')).auth.keys;
  for (const arg of [mint(), KEY, KEY.slice(-6)]) {
    const r = sb.run('key', 'revoke', arg);
    assert.equal(r.status, 1, `"revoke <${arg === KEY ? 'the key' : 'not a fingerprint'}>" must fail`);
    assert.match(r.stderr, /revoke fp:<8 hex>/);
    assertNoKey(r.stdout + r.stderr, arg.length > 8 ? arg : KEY, 'revoke refusal');
    assert.deepEqual(keys(), [KEY], 'nothing was revoked');
  }
  const miss = sb.run('key', 'revoke', 'fp:00000000');
  assert.match(miss.stdout, /no key matched fp:00000000/);

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

test('the status page never takes ?api_key=: the key is posted once, and a page-only cookie opens it', async (t) => {
  const cfg = { host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} };
  const server = createServer(new Gateway(cfg, { log: () => {} }), cfg, { usage: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A URL with the key in it is browser history, sync and a tunnel's edge log: refused.
  const byQuery = await fetch(`${base}/?api_key=${KEY}`);
  assert.equal(byQuery.status, 401);
  const door = await byQuery.text();
  assert.match(door, /<form method="post" action="\/">/);
  assertNoKey(door, KEY, 'login page');

  const form = (key) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: key }).toString() });
  assert.equal((await fetch(`${base}/`, form(mint()))).status, 401, 'a wrong key opens nothing');

  const login = await fetch(`${base}/status`, form(KEY));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/status');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /^keysmith_page=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  assertNoKey(setCookie, KEY, 'session cookie');
  const cookie = setCookie.split(';')[0];

  const page = await fetch(`${base}/status`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Adapters/);
  assertNoKey(html, KEY, 'status page');
  assert.equal((await fetch(`${base}/`, { headers: { cookie: 'keysmith_page=forged' } })).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { cookie } })).status, 401, 'the cookie opens the page, not the API');
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

const inTerminal = (sb, ...args) =>
  // stdin from /dev/null: BSD script(1) refuses a socket for stdin, and gives the child a pty either way.
  spawnSync('script', scriptArgv([process.execPath, CLI, ...args]), { env: sb.env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });

test('key list --reveal in an interactive terminal shows the full key — that is its job', { skip: !hasScript && 'no script(1) to give the child a terminal' }, () => {
  const sb = sandbox();
  assert.ok(inTerminal(sb, 'key', 'list', '--reveal').stdout.includes(KEY), 'a terminal, asked by name, is where the key is shown');
});

test('a terminal alone is not enough: key list without --reveal, in a pty an agent opened, prints the key redacted', { skip: !hasScript && 'no script(1) to give the child a terminal' }, () => {
  const sb = sandbox();
  const r = inTerminal(sb, 'key', 'list');
  assertNoKey(r.stdout + r.stderr, KEY, 'key list in a pty');
  assert.ok(r.stdout.includes(redactKey(KEY)), r.stdout);
  assert.match(r.stdout + r.stderr, /--reveal/);
});

test('key list --reveal still prints nothing in full when piped', () => {
  const r = sandbox().run('key', 'list', '--reveal');
  assertNoKey(r.stdout + r.stderr, KEY, 'key list --reveal, piped');
  assert.match(r.stderr, /not an interactive terminal/);
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

/* ------------------------------------------------- the key in pieces, glued, escaped */

test('a cut key is still a key: truncate redacts before it cuts, so ks_ + 31 of 32 never reaches a line', () => {
  registerSecrets([KEY]);
  // The cut lands one character before the end of the key: what used to be left was the key in 64 guesses.
  const line = util.truncate(`${'A'.repeat(264)} ${KEY}`, 300);
  assert.ok(line.length <= 300);
  assertNoKey(line, KEY, 'truncated line');
});

test('what a cut leaves of a key is redacted wherever it turns up', () => {
  registerSecrets([KEY]);
  const stranger = mint(); // nobody registered it: only its shape gives it away
  const s = redactSecrets(`old usage row: ${stranger.slice(0, 34)}… · tail of a configured key: …${KEY.slice(9)} · head: ${KEY.slice(0, 20)}...`);
  assertNoKey(s, stranger, 'cut minted key');
  assertNoKey(s, KEY, 'pieces of a configured key');
});

test('keepTail never starts inside a token: a front-cut key does not keep its 32 random characters', () => {
  assert.equal(typeof util.keepTail, 'function', 'util.keepTail');
  const s = `${'noise '.repeat(20)}${KEY} end`;
  const kept = util.keepTail(s, 24); // the last 20 characters of the key and " end"
  assertNoKey(kept, KEY, 'kept tail');
  assert.equal(kept, '… end');
  assert.equal(util.keepTail('short', 24), 'short');
});

test('a minted key glued to the character before it — JSON \\n, ANSI colour, Bearer_ — is still found', () => {
  const k = mint(); // not registered: the shape is all there is
  assertNoKey(redactSecrets(JSON.stringify({ error: `cli said:\n${k}` })), k, 'after a JSON \\n');
  const raw = Buffer.from(`a\\t${k}\n\x1b[32m${k}\x1b[0m\nAuthorization: Bearer_${k}\n`);
  const { buf, shaped } = scrubBuffer(raw, []);
  assert.equal(shaped, 3);
  assertNoKey(buf.toString('latin1'), k, 'scrubBuffer');
});

test('a configured key JSON has to escape is redacted in usage.jsonl too, and the line stays JSON', () => {
  const odd = `my"gateway\\secret-key-${crypto.randomBytes(4).toString('hex')}`;
  registerSecrets([odd]);
  const escaped = JSON.stringify(odd).slice(1, -1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-usage-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'usage.jsonl');
  new UsageLog(file).record({ model: 'm', status: 'error', ms: 1, error: `upstream refused ${odd}` });
  const text = fs.readFileSync(file, 'utf8');
  assertNoKey(text, odd, 'usage.jsonl, raw spelling');
  assertNoKey(text, escaped, 'usage.jsonl, JSON spelling');
  assert.equal(JSON.parse(text).error, `upstream refused ${redactKey(odd)}`);

  // ...and a row an older keysmith wrote that way is scrubbed, still one JSON object.
  const old = Buffer.from(`${JSON.stringify({ error: `upstream refused ${odd}` })}\n`);
  const { buf, configured } = scrubBuffer(old, [odd], { sameLength: true });
  assert.equal(configured, 1);
  assert.equal(buf.length, old.length);
  assertNoKey(buf.toString('utf8'), escaped, 'scrubbed old row');
  JSON.parse(buf.toString('utf8'));
});

/* ------------------------------------------------------------------ streamed output */

test('streamRedactor: a key split anywhere across pieces never comes out whole or in part', () => {
  assert.equal(typeof redact.streamRedactor, 'function', 'redact.streamRedactor');
  registerSecrets([KEY]);
  const stranger = mint();
  for (const secret of [KEY, stranger]) {
    const text = `your key is ${secret} — keep it safe; kids, keys and ks_ prefixes stay as they are.`;
    for (let cut = 1; cut < text.length; cut++) {
      const r = redact.streamRedactor();
      const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.end();
      assertNoKey(out, secret, `split at ${cut}`);
      assert.equal(out, redactSecrets(text), `split at ${cut}`);
    }
    const r = redact.streamRedactor();
    const byChar = [...text].map((c) => r.push(c)).join('') + r.end();
    assert.equal(byChar, redactSecrets(text), 'one character at a time');
  }
  const plain = redact.streamRedactor();
  assert.equal(plain.push('nothing to hide here.'), 'nothing to hide here.', 'text that cannot start a key is not held back');
});

function stubBin(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-stub-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { dir, bin };
}

test('chat --stream: a key the model streams in two deltas is printed redacted', () => {
  const stranger = mint();
  const events = ['your keys: ', KEY.slice(0, 17), KEY.slice(17), ' and ', stranger.slice(0, 20), stranger.slice(20), ' — done'];
  const lines = events.map((delta) => JSON.stringify({ type: 'event', event: { type: 'text_delta', delta } }));
  lines.push(JSON.stringify({ type: 'result', subtype: 'success' }));
  const { bin } = stubBin('splitter', `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});`);
  const sb = sandbox({ extra: { adapters: { split: { kind: 'cli', bin, args: ['{prompt}'], parser: 'cmd-ndjson', models: ['m'], timeoutMs: 10_000 } } } });
  const r = sb.run('chat', 'split/m', 'hi', '--stream');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /your keys: .* and .* — done/);
  assertNoKey(r.stdout, KEY, 'streamed chat, configured key');
  assertNoKey(r.stdout, stranger, 'streamed chat, minted key');
});

test('cloudflared output is logged a whole line at a time: a key split across two writes is redacted', () => {
  const { dir } = stubBin(
    'cloudflared',
    `process.stderr.write('INF token ' + ${JSON.stringify(KEY.slice(0, 17))});
setTimeout(() => { process.stderr.write(${JSON.stringify(KEY.slice(17))} + ' registered\\n'); setTimeout(() => process.exit(0), 100); }, 300);`,
  );
  const sb = sandbox();
  const r = spawnSync(process.execPath, [CLI, 'tunnel', 'run'], { env: { ...sb.env, KEYSMITH_VERBOSE: '1', PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000 });
  assert.match(r.stdout, /INF token .* registered/);
  assertNoKey(r.stdout + r.stderr, KEY, 'tunnel log');
});

/* -------------------------------------------------------- errors nothing else caught */

test('a failing async command goes through fail(): one redacted line, no stack, exit 1', () => {
  const { bin } = stubBin('echoargv', `process.stderr.write('usage error, got: ' + process.argv.slice(2).join(' ')); process.exit(1);`);
  const sb = sandbox({ extra: { adapters: { fail: { kind: 'cli', bin, args: ['{prompt}'], parser: 'raw', models: ['m'], timeoutMs: 10_000 } } } });
  // The adapter quotes its argv (the prompt); the second message never passes through truncate().
  for (const args of [['fail/m', `please use ${KEY}`], [`${KEY}/m`, 'hi']]) {
    const r = sb.run('chat', ...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^keysmith: /);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'a stack trace means the error skipped fail()');
    assertNoKey(r.stdout + r.stderr, KEY, `chat ${args[0].startsWith('fail') ? 'adapter error' : 'unknown adapter'}`);
  }
});

test('installCrashHandlers: an uncaught error or unhandled rejection is reported redacted, exit 1', () => {
  for (const [what, raise] of [
    ['unhandled rejection', `Promise.reject(new Error('boom: ' + process.env.K));`],
    ['uncaught exception', `setTimeout(() => { throw new Error('boom: ' + process.env.K); });`],
  ]) {
    const code = `import(${JSON.stringify(pathToFileURL(CLI).href)}).then((m) => { m.installCrashHandlers(); ${raise} });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, K: KEY }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`^keysmith: ${what}: Error: boom: ks_`));
    assertNoKey(r.stderr, KEY, what);
  }
});

/* --------------------------------------------------------- what a stranger can send */

function rawRequest(port, text) {
  return new Promise((resolve) => {
    let data = '';
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    sock.on('data', (c) => (data += c));
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(data));
    setTimeout(() => sock.destroy(), 3000).unref();
  });
}

test('a request target that does not parse is a 400, not a crash, and never lands in the log', async (t) => {
  const sb = sandbox();
  const gw = await serveLikeLaunchd(sb);
  t.after(() => gw.stop());
  for (const target of [`http://a:99999/?api_key=${KEY}`, '//a:99999/', `//a:99999/?api_key=${KEY}`]) {
    const res = await rawRequest(gw.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 400 /, `GET ${target.replace(KEY, '<key>')}`);
    assertNoKey(res, KEY, 'the 400');
  }
  const health = await fetch(`http://127.0.0.1:${gw.port}/healthz`);
  assert.equal(health.status, 200, 'still serving');
  assertNoKey(gw.text(), KEY, 'launchd-gateway.log');
});

let paddedRun = null;
/** A CLI whose error puts the key just before the 300-character cut of the error message. */
function failedRequestWithTheKeyAtTheCut() {
  paddedRun ??= (async () => {
    // 264 + 1 + 35 + the newline: over 300, so the cut at 299 falls one character before the key's end.
    const { bin } = stubBin('padder', `process.stderr.write(${JSON.stringify('A'.repeat(264) + ' ' + KEY + '\n')}); process.exit(3);`);
    const sb = sandbox({ extra: { adapters: { pad: { kind: 'cli', bin, args: ['{prompt}'], parser: 'raw', models: ['m'], timeoutMs: 10_000 } } } });
    const gw = await serveLikeLaunchd(sb, { verbose: true });
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pad/m', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = await res.text();
      const usageFile = path.join(sb.data, 'usage.jsonl');
      await waitFor(() => fs.existsSync(usageFile) && /pad exited 3/.test(gw.text()));
      return { status: res.status, body, log: gw.text(), usage: fs.readFileSync(usageFile, 'utf8') };
    } finally {
      await gw.stop();
    }
  })();
  return paddedRun;
}

test('an adapter error cut at 300 characters through the key: neither usage.jsonl nor the verbose log keep a piece of it', async () => {
  const { status, log, usage } = await failedRequestWithTheKeyAtTheCut();
  assert.ok(status >= 500, `expected the stub to fail, got ${status}`);
  assert.match(usage, /pad exited 3/);
  assertNoKey(usage, KEY, 'usage.jsonl');
  assertNoKey(log, KEY, 'verbose gateway log');
});

/* --------------------------------------------------------------- scrub, and its reach */

test('scrubbing a log in place keeps a line launchd appended while it ran', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-race-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launchd-gateway.log');
  fs.writeFileSync(file, `keysmith listening\n  key     : ${KEY}\n`);
  const appender = fs.openSync(file, 'a'); // launchd's O_APPEND fd
  const read = fs.readFileSync;
  fs.readFileSync = function (...args) {
    const got = read.apply(this, args);
    if (typeof args[0] === 'number') fs.writeSync(appender, 'appended while scrubbing\n');
    return got;
  };
  let r;
  try {
    r = scrubLogFile(file, [KEY]);
  } finally {
    fs.readFileSync = read;
    fs.closeSync(appender);
  }
  assert.equal(r.configured, 1);
  const text = fs.readFileSync(file, 'utf8');
  assertNoKey(text, KEY, 'scrubbed log');
  assert.match(text, /appended while scrubbing\n$/, 'the line written during the scrub survives it');
});

test('scrub-logs reaches rotated copies and files it is given, lists what it cannot rewrite, and says to rotate', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.data, { recursive: true });
  const rotated = [`${launchdLogFiles(sb.data)[0]}.0`, path.join(sb.data, 'usage.jsonl.1')];
  for (const f of rotated) fs.writeFileSync(f, `{"error":"echoed ${KEY}"}\n`);
  const archive = `${launchdLogFiles(sb.data)[0]}.1.gz`;
  fs.writeFileSync(archive, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
  const transcript = path.join(sb.home, 'elsewhere', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript));
  fs.writeFileSync(transcript, `${JSON.stringify({ role: 'tool', content: `auth.keys: ["${KEY}"]` })}\n`);

  const r = sb.run('scrub-logs', transcript);
  assert.equal(r.status, 0, r.stderr);
  assertNoKey(r.stdout + r.stderr, KEY, 'scrub-logs output');
  for (const f of [...rotated, transcript]) {
    const text = fs.readFileSync(f, 'utf8');
    assertNoKey(text, KEY, path.basename(f));
    JSON.parse(text); // rewritten one for one: still the JSON it was
  }
  assert.match(r.stdout, /session\.jsonl\s+1 configured key/);
  assert.match(r.stdout, /launchd-gateway\.log\.1\.gz\s+compressed/);
  assert.match(r.stdout, /Rotate it:[\s\S]*keysmith key add[\s\S]*keysmith key revoke fp:/);

  const again = sb.run('scrub-logs', transcript);
  assert.match(again.stdout, /^0 replacement/m);
  assert.doesNotMatch(again.stdout, /Rotate it/, 'nothing found, nothing to rotate');
});

test('status says when the running gateway started before the code on disk changed', async () => {
  const sb = sandbox();
  fs.mkdirSync(sb.data, { recursive: true });
  // This test's own pid stands in for a gateway that has been up since 2001.
  fs.writeFileSync(path.join(sb.data, 'keysmith.pid'), JSON.stringify({ pid: process.pid, port: await freePort(), at: '2001-01-01T00:00:00.000Z' }));
  const r = sb.run('status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /code\s+: .*after this gateway started .*still runs the old code — restart it/);
  assertNoKey(r.stdout + r.stderr, KEY, 'status');
});

/* ------------------------------------------------------------- launchd, configs, docs */

test('both launchd plists set Umask 077, so a log launchd re-creates is 0600', () => {
  const gw = gatewayPlist({ nodeBin: '/opt/homebrew/bin/node', entry: '/x/src/cli.js', port: 8787 });
  const tn = tunnelPlist({ cloudflared: '/opt/homebrew/bin/cloudflared', name: 'keysmith', configFile: '/x/keysmith.yml' });
  for (const p of [gw, tn]) assert.match(p, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
});

test('a {json:} secret file that is not valid JSON: the load error never quotes the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-store-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'auth.json');
  const secret = `sk-${crypto.randomBytes(16).toString('hex')}`;
  fs.writeFileSync(store, `{"evren": {"key": ${secret}}}`); // the value lost its quotes
  const gw = new Gateway({ adapters: { evren: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKey: `{json:${store}#evren.key}` } }, aliases: {} }, { log: () => {} });
  const why = gw.loadErrors.evren;
  assert.match(why, /invalid JSON/);
  for (let i = 0; i + 6 <= secret.length; i++) assert.ok(!why.includes(secret.slice(i, i + 6)), `6 characters of the upstream secret are in: ${why.replace(secret.slice(0, 8), '<…>')}`);
});

test('the docs never print the key: a command that reads it from the config assigns it to a variable', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const docs = ['README.md', ...fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join('docs', f))];
  for (const doc of docs) {
    fs.readFileSync(path.join(root, doc), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/jq\b.*auth\.keys/.test(line)) return;
        assert.match(line, /\$\(\s*jq\b[^)]*auth\.keys/, `${doc}:${i + 1} prints the key to stdout: ${line.trim()}`);
      });
  }
});
