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
  assert.match(r.stdout, /^ {2}\+ visionArgs +— +profile: \[18 items\]$/m);
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
  assert.match(r.stdout, /^ {2}\+ visionArgs +\[18 items\]$/m);
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

test('keysmith upgrade: a codex entry of parser raw takes `exec --json` only with its parser — a part refused, with the one command that brings the rest — and then answers with text', async (t) => {
  const { run, read, edit } = sandbox(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A codex that prints what the real one does: the JSONL event stream with --json, the last message without.
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const json = process.argv.includes('--json');
if (!json) process.stdout.write('PONG\\n');
else for (const l of [{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'PONG' } }, { type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 1 } }]) process.stdout.write(JSON.stringify(l) + '\\n');
`, { mode: 0o755 });
  assert.equal(run('add', 'codex', '--bin', bin).status, 0);
  // As main attached it: plain `exec` under parser raw, no {effort} anywhere.
  const noEffort = (a) => a.filter((x) => !(Array.isArray(x) && x.includes('model_reasoning_effort="{effort}"')));
  const plain = (a) => noEffort(a).filter((x) => x !== '--json');
  edit('codex', (e) => {
    e.parser = 'raw';
    e.args = plain(e.args);
    e.emulateArgs = plain(e.emulateArgs);
    e.bridge.args = noEffort(e.bridge.args);
    e.cwd = path.join(dir, 'ws');
  });
  const mainEntry = read();
  let r = run('upgrade', 'codex', '--take', 'emulateArgs,bridge', '--apply');
  assert.notEqual(r.status, 0, 'emulateArgs alone would be `exec --json` read as raw');
  assert.match(r.all, /not upgraded: codex: adapter "codex": its emulateArgs runs `--json`, whose output parser raw would hand back as the answer .* --take args,parser --apply/);
  assert.match(r.all, /^ {2}with the fields you named: keysmith upgrade codex --take emulateArgs,bridge,args,parser --apply$/m);
  assert.deepEqual(read(), mainEntry, 'nothing written');
  r = run('upgrade', 'codex', '--take', 'args', '--apply');
  assert.notEqual(r.status, 0, 'the advice before this fix');
  assert.match(r.all, /its args runs `--json`.*--take emulateArgs,parser --apply[\s\S]*with the fields you named: keysmith upgrade codex --take args,emulateArgs,parser --apply/);
  assert.deepEqual(read(), mainEntry);
  r = run('upgrade', 'codex', '--take', 'emulateArgs,bridge,args,parser', '--apply');
  assert.equal(r.status, 0, r.all);
  const now = read().adapters.codex;
  assert.equal(now.parser, 'codex-json-final');
  assert.deepEqual([now.args, now.emulateArgs, now.bridge], [CLI_PROFILES.codex.args, CLI_PROFILES.codex.emulateArgs, CLI_PROFILES.codex.bridge]);
  const { CliAdapter } = await import('../src/cli-adapter.js');
  const answer = async (cfg) => {
    let text = '';
    for await (const e of new CliAdapter('codex', cfg).complete({ model: 'gpt-x', messages: [{ role: 'user', content: 'say PONG' }] })) if (e.type === 'delta') text += e.text;
    return text;
  };
  assert.equal(await answer(now), 'PONG', 'the text, not the JSONL');
  assert.equal(await answer(mainEntry.adapters.codex), 'PONG', 'and as main ran it, plain');
});

// Independent re-check of 88f4cd1: a codex entry from before EMULATE (parser raw, plain `exec`, no
// emulateArgs, no bridge). `keysmith tools codex emulate` fills in the profile's emulateArgs, which
// are `exec --json`: under raw that would be the JSONL stream as every answer, so it is not saved,
// and the command it names brings the entry whole — after which the same `tools` call is saved.
test('keysmith tools: a codex entry from before EMULATE is not given `exec --json` under parser raw, and the --take it is told brings the entry whole', (t) => {
  const { run, read, edit } = sandbox(t);
  assert.equal(run('add', 'codex', '--bin', '/opt/homebrew/bin/codex').status, 0);
  const plain = (a) => a.filter((x) => x !== '--json' && !(Array.isArray(x) && x.includes('model_reasoning_effort="{effort}"')));
  edit('codex', (e) => {
    e.parser = 'raw';
    e.args = plain(e.args);
    delete e.emulateArgs;
    delete e.bridge;
    e.toolMode = 'off';
  });
  const old = read();
  let r = run('tools', 'codex', 'emulate');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /not saved: adapter "codex": its emulateArgs runs `--json`, whose output parser raw would hand back as the answer .* keysmith upgrade codex --take args,parser --apply/);
  assert.deepEqual(read(), old, 'nothing written');
  // A bare upgrade adds the profile's emulateArgs the same way: refused, nothing written.
  r = run('upgrade', '--apply');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /not upgraded: codex: .*--take args,parser --apply/);
  assert.deepEqual(read(), old);
  r = run('upgrade', 'codex', '--take', 'args,parser', '--apply');
  assert.equal(r.status, 0, r.all);
  const now = read().adapters.codex;
  assert.deepEqual([now.parser, now.args, now.emulateArgs, now.bridge, now.toolMode], ['codex-json-final', CLI_PROFILES.codex.args, CLI_PROFILES.codex.emulateArgs, CLI_PROFILES.codex.bridge, 'off']);
  r = run('tools', 'codex', 'emulate');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.codex.toolMode, 'emulate');
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

test('keysmith upgrade: an opencode entry left over from 1.18.27 keeps old provenance while stale workspaceFiles stay; doctor and startup warn with keysmith upgrade oc --take workspaceFiles', async (t) => {
  const { run, read, edit } = sandbox(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-oc-118-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('1.19.3\\n'); process.exit(0); }
process.stdout.write('opencode/deepseek-v4.1-flash-free\\n');
`,
    { mode: 0o755 },
  );
  assert.equal(run('add', 'opencode', '--as', 'oc', '--bin', bin).status, 0);
  const oldProvenance = 'opencode 1.18.27 — `opencode run --format json --pure --agent keysmith-text` emits step_start / text / step_finish.';
  const oldConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { '*': 'deny' }, tools: { '*': false }, mcp: {}, plugin: [] }, null, 2) + '\n';
  const oldAgent = '---\ndescription: Plain text completions for keysmith. No tools.\nmode: primary\ntools:\n  "*": false\npermission:\n  "*": deny\n---\n\nOld agent.\n';
  edit('oc', (e) => {
    delete e.verifiedVersion;
    e.provenance = oldProvenance;
    e.stopAtToolCall = true;
    e.workspaceFiles = {
      'opencode.json': oldConfig,
      '.opencode/agent/keysmith-text.md': oldAgent,
    };
  });

  // Plain `keysmith upgrade oc --apply` (without `--take workspaceFiles`) must NOT refresh provenance or verifiedVersion while stale workspaceFiles remain.
  let r = run('upgrade', 'oc', '--apply');
  assert.equal(r.status, 0, r.all);
  let oc = read().adapters.oc;
  assert.equal(oc.provenance, oldProvenance, 'provenance is not refreshed while stale 1.18.27 workspaceFiles are kept');
  assert.equal(oc.verifiedVersion, undefined, 'verifiedVersion is not added while stale workspaceFiles are kept');
  assert.equal(oc.workspaceFiles['opencode.json'], oldConfig);

  // Both startup (Gateway) and `keysmith doctor` detect the stale workspaceFiles and name `keysmith upgrade oc --take workspaceFiles`.
  // The startup warning is logged once across `new Gateway` + `gw.checkAdapters({ log })`.
  const { Gateway } = await import('../src/gateway.js');
  const startupLogs = [];
  const gw = new Gateway(read(), { log: (m) => startupLogs.push(m) });
  const checked = await gw.checkAdapters({ log: (m) => startupLogs.push(m) });
  assert.ok(checked.some((w) => /keysmith upgrade oc --take workspaceFiles/.test(w)));
  assert.equal(
    startupLogs.filter((m) => /oc.*workspaceFiles.*keysmith upgrade oc --take workspaceFiles/.test(m)).length,
    1,
    `expected stale-workspace startup warning to be logged once, got: ${startupLogs.join('\n')}`,
  );

  const doc = run('doctor');
  assert.equal(doc.status, 0, doc.all);
  assert.match(doc.stdout, /!\s+oc\s+.*keysmith upgrade oc --take workspaceFiles/);

  // Taking workspaceFiles updates the files AND refreshes provenance / verifiedVersion, clearing the warning.
  r = run('upgrade', 'oc', '--take', 'workspaceFiles', '--apply');
  assert.equal(r.status, 0, r.all);
  oc = read().adapters.oc;
  assert.deepEqual(oc.workspaceFiles, CLI_PROFILES.opencode.workspaceFiles);
  assert.equal(oc.provenance, CLI_PROFILES.opencode.provenance);
  assert.equal(oc.verifiedVersion, '1.19.3');

  const docAfter = run('doctor');
  assert.equal(docAfter.status, 0, docAfter.all);
  assert.doesNotMatch(docAfter.stdout, /keysmith upgrade oc --take workspaceFiles/);

  // An entry whose workspaceFiles is missing a profile file (e.g. .opencode/agent/keysmith-text.md) is also treated as stale by upgrade (provenance/verifiedVersion not refreshed until --take workspaceFiles).
  edit('oc', (e) => {
    delete e.verifiedVersion;
    e.provenance = oldProvenance;
    delete e.workspaceFiles['.opencode/agent/keysmith-text.md'];
  });
  r = run('upgrade', 'oc');
  assert.equal(r.status, 0, r.all);
  assert.doesNotMatch(r.stdout, /~ provenance/, 'missing file in workspaceFiles prevents provenance refresh without --take workspaceFiles');
  assert.doesNotMatch(r.stdout, /\+ verifiedVersion/, 'missing file in workspaceFiles prevents verifiedVersion addition without --take workspaceFiles');
});

test('opencode: workspaceFilesCustom acknowledges customised workspaceFiles, silences the stale-workspace warning in startup and doctor, and lets upgrade refresh provenance', async (t) => {
  const { run, read, edit } = sandbox(t);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-oc-custom-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const bin = path.join(binDir, 'opencode');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('1.19.3\\n'); process.exit(0); }
process.stdout.write('opencode/deepseek-v4.1-flash-free\\n');
`,
    { mode: 0o755 },
  );
  assert.equal(run('add', 'opencode', '--as', 'oc', '--bin', bin).status, 0);
  const customConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { '*': 'deny', read: { '*': 'deny', '': 'deny' } }, mcp: {}, plugin: [] }) + '\n';
  edit('oc', (e) => {
    delete e.verifiedVersion;
    e.provenance = 'opencode 1.18.27 — custom.';
    e.workspaceFiles = {
      ...CLI_PROFILES.opencode.workspaceFiles,
      'opencode.json': customConfig,
    };
  });

  // Acknowledge customised workspaceFiles via `keysmith set oc workspaceFilesCustom true`.
  let r = run('set', 'oc', 'workspaceFilesCustom', 'true');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.oc.workspaceFilesCustom, true);

  // Neither startup nor `keysmith doctor` warns about stale workspaceFiles.
  const { Gateway } = await import('../src/gateway.js');
  const startupLogs = [];
  const gw = new Gateway(read(), { log: (m) => startupLogs.push(m) });
  const checked = await gw.checkAdapters({ log: (m) => startupLogs.push(m) });
  assert.equal(startupLogs.filter((m) => /workspaceFiles out of date/.test(m)).length, 0, `unexpected stale-workspace startup warning: ${startupLogs.join('\n')}`);
  assert.equal(checked.filter((w) => /workspaceFiles out of date/.test(w)).length, 0, `unexpected stale-workspace checkAdapters warning: ${checked.join('\n')}`);

  const doc = run('doctor');
  assert.equal(doc.status, 0, doc.all);
  assert.doesNotMatch(doc.stdout, /workspaceFiles out of date/);

  // And `keysmith upgrade oc --apply` refreshes provenance and verifiedVersion while keeping the customised workspaceFiles.
  r = run('upgrade', 'oc', '--apply');
  assert.equal(r.status, 0, r.all);
  const oc = read().adapters.oc;
  assert.equal(oc.workspaceFiles['opencode.json'], customConfig);
  assert.equal(oc.provenance, CLI_PROFILES.opencode.provenance);
  assert.equal(oc.verifiedVersion, '1.19.3');

  const docAfter = run('doctor');
  assert.equal(docAfter.status, 0, docAfter.all);
  assert.doesNotMatch(docAfter.stdout, /workspaceFiles/);
});
