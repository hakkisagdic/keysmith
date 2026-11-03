/**
 * Changing an attached adapter from the command line: `keysmith set <adapter>` (its fields beside
 * its profile's), `keysmith upgrade` (what a profile gained since the entry was copied) and the
 * short forms of `set` — enable, disable, vision, tools. Each test runs the CLI on a config of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_PROFILES, HTTP_PROFILES } from '../src/profiles.js';

const KEY = 'ks_test_000000000000000000000000';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const write = (c) => fs.writeFileSync(config, JSON.stringify(c, null, 2), { mode: 0o600 });
  /** The adapter entry, changed by `fn` the way an older keysmith (or its user) left it. */
  const edit = (id, fn) => {
    const c = read();
    fn(c.adapters[id]);
    write(c);
  };
  return { run, read, write, edit };
}

/* ------------------------------------------------------------------ keysmith set <adapter> */

test('keysmith set <adapter> shows each field beside the profile\'s — and never a key, or what env holds', (t) => {
  const { run, edit } = sandbox(t);
  assert.equal(run('add', 'claude', '--bin', '/usr/local/bin/claude').status, 0);
  edit('claude', (e) => {
    delete e.media;
    delete e.visionArgs;
    e.models = ['sonnet'];
    e.env = { ANTHROPIC_API_KEY: 'sk-ant-should-not-print-1234' };
  });
  let r = run('set', 'claude');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^claude {2}cli · built-in profile "claude"$/m);
  assert.match(r.stdout, /^ {2}≠ bin +"\/usr\/local\/bin\/claude" +profile: "claude"$/m);
  assert.match(r.stdout, /^ {2}= parser +"claude-stream-json"$/m);
  assert.match(r.stdout, /^ {2}· models +\["sonnet"\]$/m);
  assert.match(r.stdout, /^ {2}\+ media +— +profile: \["image","pdf"\]$/m);
  assert.match(r.stdout, /^ {2}\+ visionArgs +— +profile: \[17 items\]$/m);
  assert.match(r.stdout, /^ {2}· env +\{ANTHROPIC_API_KEY\}$/m);
  assert.doesNotMatch(r.all, /should-not-print/);
  assert.match(r.stdout, /also settable: .*maxImages, maxImageBytes/);
  assert.match(r.stdout, /keysmith upgrade claude/);

  assert.equal(run('add', 'openai', '--key', 'sk-literal-should-not-print-5678').status, 0);
  r = run('set', 'openai');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^ {2}≠ apiKey +\(literal, hidden\) +profile: \{env:OPENAI_API_KEY\}$/m);
  assert.doesNotMatch(r.all, /should-not-print/);

  r = run('set', 'ghost');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no adapter named "ghost"/);
});

/* --------------------------------------------------------------------------- keysmith upgrade */

test('keysmith upgrade: a dry run lists what the profile gained; --apply adds it, refreshes its text and keeps what you changed', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'claude', '--bin', '/usr/local/bin/claude').status, 0);
  edit('claude', (e) => {
    delete e.media;
    delete e.visionArgs;
    e.provenance = 'an older profile said this';
    e.timeoutMs = 120_000;
  });
  const before = read();
  let r = run('upgrade', 'claude');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^claude ← "claude"$/m);
  assert.match(r.stdout, /^ {2}\+ media +\["image","pdf"\]$/m);
  assert.match(r.stdout, /^ {2}\+ visionArgs +\[17 items\]$/m);
  assert.match(r.stdout, /^ {2}~ provenance +the profile's current text$/m);
  assert.match(r.stdout, /^ {2}= timeoutMs +yours: 120000 · profile: 300000$/m);
  assert.match(r.stdout, /^ {2}= bin +yours: "\/usr\/local\/bin\/claude" · profile: "claude"$/m);
  assert.match(r.stdout, /dry run, nothing written — to write it: keysmith upgrade claude --apply/);
  assert.deepEqual(read(), before, 'a dry run writes nothing');

  r = run('upgrade', 'claude', '--apply');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /upgraded claude →/);
  const now = read().adapters.claude;
  assert.deepEqual(now.media, ['image', 'pdf']);
  assert.deepEqual(now.visionArgs, CLI_PROFILES.claude.visionArgs);
  assert.equal(now.provenance, CLI_PROFILES.claude.provenance);
  assert.equal(now.timeoutMs, 120_000, 'a field you changed stays');
  assert.equal(now.bin, '/usr/local/bin/claude');
  assert.equal(now.explicitOnly, true);

  r = run('upgrade', 'claude');
  assert.match(r.stdout, /^claude ← "claude": up to date \(yours kept: bin, timeoutMs\)$/m);
  assert.doesNotMatch(r.stdout, /dry run/, 'nothing to write, nothing to offer');

  r = run('upgrade', 'claude', '--take', 'timeoutMs', '--apply');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^ {2}← timeoutMs +300000 +was: 120000$/m);
  assert.equal(read().adapters.claude.timeoutMs, 300_000);
});

test('keysmith upgrade: a codex entry attached when its text runs were plain `exec` (parser raw) is still the codex profile\'s, and --take brings `--json` and its usage', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'codex', '--bin', '/opt/homebrew/bin/codex').status, 0);
  const plain = (args) => args.filter((a) => a !== '--json');
  edit('codex', (e) => {
    e.parser = 'raw';
    e.args = plain(e.args);
    e.emulateArgs = plain(e.emulateArgs);
  });
  let r = run('upgrade', 'codex');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^codex ← "codex": up to date \(yours kept: bin, args, emulateArgs, parser\)$/m, 'found by its binary and the parser its profile had');
  r = run('upgrade', 'codex', '--take', 'args,emulateArgs,parser', '--apply');
  assert.equal(r.status, 0, r.all);
  const now = read().adapters.codex;
  assert.equal(now.parser, 'codex-json-final');
  assert.deepEqual(now.args, CLI_PROFILES.codex.args);
  assert.equal(now.args[1], '--json');
});

test('keysmith upgrade: a profile file the entry lacks is added, one it changed is kept — --take replaces it', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'agy', '--bin', '/usr/local/bin/agy').status, 0);
  const tools = '.agents/agents/keysmith-tools.md';
  const text = '.agents/agents/keysmith-text.md';
  edit('agy', (e) => {
    delete e.toolMode;
    delete e.emulateArgs;
    e.workspaceFiles = { [text]: 'MY OWN TEXT AGENT\n' };
  });
  let r = run('upgrade', 'agy', '--apply');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^ {2}\+ toolMode +"auto"$/m);
  assert.match(r.stdout, new RegExp(`^  \\+ workspaceFiles\\[${tools.replace(/\./g, '\\.')}\\] a file of the profile$`, 'm'));
  assert.match(r.stdout, new RegExp(`^  = workspaceFiles\\[${text.replace(/\./g, '\\.')}\\] yours differs from the profile$`, 'm'));
  let files = read().adapters.agy.workspaceFiles;
  assert.equal(files[tools], CLI_PROFILES.agy.workspaceFiles[tools]);
  assert.equal(files[text], 'MY OWN TEXT AGENT\n');

  r = run('upgrade', 'agy', '--take', 'workspaceFiles', '--apply');
  assert.equal(r.status, 0, r.all);
  files = read().adapters.agy.workspaceFiles;
  assert.deepEqual(files, CLI_PROFILES.agy.workspaceFiles);
});

test('keysmith upgrade refuses what set would refuse — an unsafeTools change without the flag, an entry that would not load — and writes nothing', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'cmd', '--bin', '/usr/local/bin/cmd').status, 0);
  edit('cmd', (e) => delete e.stopAtToolCall);
  let before = read();
  let r = run('upgrade', 'cmd', '--apply');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /not upgraded: cmd: it can run commands and edit files, and changing stopAtToolCall, which shapes .* needs --allow-unsafe-tools/);
  assert.deepEqual(read(), before);
  r = run('upgrade', 'cmd', '--apply', '--allow-unsafe-tools');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.cmd.stopAtToolCall, 'always');
  assert.equal(read().adapters.cmd.disabled, true, 'a guard stays');

  // A cwd you set to null stays yours, and the profile's agent files have nowhere keysmith owns
  // to go: the gateway would refuse the entry, so it is not written.
  assert.equal(run('add', 'agy', '--bin', '/usr/local/bin/agy').status, 0);
  edit('agy', (e) => {
    e.cwd = null;
    delete e.workspaceFiles;
    delete e.toolMode;
  });
  before = read();
  r = run('upgrade', 'agy', 'cmd', '--apply', '--allow-unsafe-tools');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /= cwd +yours: null · profile:/);
  assert.match(r.all, /not upgraded: agy: adapter "agy": .*cwd/);
  assert.deepEqual(read(), before, 'one entry that fails stops them all');
});

test('keysmith upgrade: HTTP adapters by where they go; no profile, an unknown --take and a --take with no adapter are said so', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'google', '--key', 'AIza-literal-should-not-print').status, 0);
  edit('google', (e) => delete e.thoughtSignatures);
  let r = run('upgrade', 'google', '--apply');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^google ← "google"$/m);
  assert.match(r.stdout, /^ {2}\+ thoughtSignatures true$/m);
  assert.match(r.stdout, /^ {2}= apiKey +yours: \(literal, hidden\) · profile: \{env:GOOGLE_API_KEY\}$/m);
  assert.doesNotMatch(r.all, /should-not-print/);
  assert.equal(read().adapters.google.thoughtSignatures, HTTP_PROFILES.google.thoughtSignatures);

  assert.equal(run('add', 'custom', '--as', 'mine', '--bin', '/usr/local/bin/mycli').status, 0);
  r = run('upgrade', 'mine');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /mine: no built-in profile runs it/);
  r = run('upgrade');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /^google ← "google": up to date \(yours kept: apiKey\)$/m);
  assert.doesNotMatch(r.stdout, /mine/, 'with no adapter named, one without a profile is left out');

  r = run('upgrade', 'google', '--take', 'nosuch');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /--take nosuch: the "google" profile has no such field/);
  r = run('upgrade', '--take', 'apiKey');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /name the adapter it is for/);
});

/* ------------------------------------------------------------------------------ short forms */

test('enable, disable, vision and tools are set by another name, with its checks and its filling-in', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'claude', '--bin', '/usr/local/bin/claude').status, 0);
  let r = run('disable', 'claude');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /set claude\.disabled/);
  assert.equal(read().adapters.claude.disabled, true);
  assert.equal(run('enable', 'claude').status, 0);
  assert.equal(read().adapters.claude.disabled, false);

  edit('claude', (e) => {
    delete e.vision;
    delete e.visionArgs;
  });
  r = run('vision', 'claude', 'on');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /filled from the built-in "claude" profile: visionArgs/);
  assert.equal(read().adapters.claude.vision, true);
  assert.equal(run('vision', 'claude', 'off').status, 0);
  assert.equal(read().adapters.claude.vision, false);

  assert.equal(run('add', 'opencode', '--as', 'oc', '--bin', '/usr/local/bin/opencode').status, 0);
  edit('oc', (e) => {
    delete e.toolMode;
    delete e.emulateArgs;
    delete e.bridge;
  });
  r = run('tools', 'oc', 'emulate');
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /filled from the built-in "opencode" profile: emulateArgs, bridge/);
  assert.equal(read().adapters.oc.toolMode, 'emulate');

  // A CLI that kept its tools is served only with the flag that says so.
  assert.equal(run('add', 'cmd', '--bin', '/usr/local/bin/cmd').status, 0);
  r = run('enable', 'cmd');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /needs --allow-unsafe-tools/);
  assert.equal(read().adapters.cmd.disabled, true);
  assert.equal(run('enable', 'cmd', '--allow-unsafe-tools').status, 0);
  assert.equal(read().adapters.cmd.disabled, false);

  for (const [args, usage] of [
    [['vision', 'claude'], /usage: keysmith vision <adapter> on\|off/],
    [['vision', 'claude', 'maybe'], /usage: keysmith vision <adapter> on\|off/],
    [['tools', 'oc', 'yolo'], /usage: keysmith tools <adapter> off\|emulate\|mcp\|auto/],
    [['enable'], /usage: keysmith enable <adapter>/],
    [['disable', 'a', 'b'], /usage: keysmith disable <adapter>/],
  ]) {
    r = run(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.all, usage, args.join(' '));
  }
});
