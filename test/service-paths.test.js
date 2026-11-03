/**
 * The paths `keysmith install-service` writes into its launchd agents: ones that still lead to
 * the same program after the installing shell is gone (an fnm multishell link), and that follow
 * an upgrade the user chose (`fnm default`, `brew upgrade`). Built on a fake fnm directory and a
 * fake Homebrew prefix in a temporary directory; nothing is installed or loaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stablePath, servicePath, gatewayPlist, tunnelPlist } from '../src/service.js';

const KEY = 'ks_test_000000000000000000000000';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** fnm with v1 (the default) and v2, one shell on each; Homebrew with node 26.1 linked and 25.9 left behind. */
function layout(t) {
  // Real path of the temp dir: on macOS /var/folders is /private/var/folders.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (p) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  };
  const link = (target, at) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
  };
  const fnm = path.join(root, 'fnm');
  const v = (n) => path.join(fnm, 'node-versions', n, 'installation');
  for (const n of ['v1', 'v2']) {
    file(path.join(v(n), 'bin', 'node'));
    file(path.join(v(n), 'lib', 'node_modules', 'cloudflared', 'lib', 'cloudflared.js'));
    link('../lib/node_modules/cloudflared/lib/cloudflared.js', path.join(v(n), 'bin', 'cloudflared'));
  }
  link(v('v1'), path.join(fnm, 'aliases', 'default'));
  const shell1 = path.join(root, 'state', 'fnm_multishells', '100_1');
  const shell2 = path.join(root, 'state', 'fnm_multishells', '200_2');
  link(v('v1'), shell1);
  link(v('v2'), shell2);
  const brew = path.join(root, 'brew');
  file(path.join(brew, 'Cellar', 'node', '26.1', 'bin', 'node'));
  file(path.join(brew, 'Cellar', 'node', '25.9', 'bin', 'node'));
  link('../Cellar/node/26.1', path.join(brew, 'opt', 'node'));
  link('../Cellar/node/26.1/bin/node', path.join(brew, 'bin', 'node'));
  const local = path.join(root, 'local', 'bin');
  file(path.join(root, 'elsewhere', 'tool'));
  link('../../elsewhere/tool', path.join(local, 'tool'));
  return { root, fnm, v, shell1, shell2, brew, local };
}

test('stablePath: fnm — the default version through its alias, another version as its own path, never a shell\'s multishell link', (t) => {
  const { fnm, v, shell1, shell2 } = layout(t);
  const o = { fnmDir: fnm };
  const alias = path.join(fnm, 'aliases', 'default');
  assert.equal(stablePath(path.join(v('v1'), 'bin', 'node'), o), path.join(alias, 'bin', 'node'));
  assert.equal(stablePath(path.join(shell1, 'bin', 'node'), o), path.join(alias, 'bin', 'node'), 'a shell on the default version');
  assert.equal(stablePath(path.join(shell1, 'bin'), o), path.join(alias, 'bin'), 'a PATH directory too');
  assert.equal(stablePath(path.join(shell1, 'bin', 'cloudflared'), o), path.join(alias, 'lib', 'node_modules', 'cloudflared', 'lib', 'cloudflared.js'), 'a bin link, to the file it runs');
  assert.equal(stablePath(path.join(shell2, 'bin', 'node'), o), path.join(v('v2'), 'bin', 'node'), 'a shell on another version keeps that version');
  assert.equal(stablePath(path.join(v('v2'), 'bin'), o), path.join(v('v2'), 'bin'));
});

test('stablePath: Homebrew — a keg through opt while opt points at it; anything else as written', (t) => {
  const { fnm, brew, local, root } = layout(t);
  const o = { fnmDir: fnm };
  assert.equal(stablePath(path.join(brew, 'Cellar', 'node', '26.1', 'bin', 'node'), o), path.join(brew, 'opt', 'node', 'bin', 'node'), 'what process.execPath reports');
  assert.equal(stablePath(path.join(brew, 'bin', 'node'), o), path.join(brew, 'opt', 'node', 'bin', 'node'));
  assert.equal(stablePath(path.join(brew, 'Cellar', 'node', '25.9', 'bin', 'node'), o), path.join(brew, 'Cellar', 'node', '25.9', 'bin', 'node'), 'a keg opt no longer points at stays itself');
  assert.equal(stablePath(path.join(brew, 'bin'), o), path.join(brew, 'bin'));
  assert.equal(stablePath(path.join(local, 'tool'), o), path.join(local, 'tool'), 'a stable link is not resolved');
  assert.equal(stablePath(path.join(root, 'missing', 'bin'), o), path.join(root, 'missing', 'bin'), 'a path that does not exist is left alone');
});

test('servicePath maps each PATH directory and drops what maps to one already there', (t) => {
  const { fnm, shell1, shell2, v, local } = layout(t);
  const alias = path.join(fnm, 'aliases', 'default');
  const got = servicePath([path.join(shell1, 'bin'), path.join(v('v1'), 'bin'), local, path.join(shell2, 'bin'), ''].join(':'), { fnmDir: fnm }).split(':');
  assert.deepEqual(got.slice(0, 3), [path.join(alias, 'bin'), local, path.join(v('v2'), 'bin')]);
  assert.deepEqual(got.slice(3), ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter((d) => !got.slice(0, 3).includes(d)));
  assert.ok(!got.some((d) => d.includes('fnm_multishells')), 'no multishell directory reaches launchd');
});

test('the agents are written with stable paths: no keg, no multishell link', (t) => {
  const { fnm, brew, shell1 } = layout(t);
  const before = { PATH: process.env.PATH, FNM_DIR: process.env.FNM_DIR };
  t.after(() => {
    process.env.PATH = before.PATH;
    if (before.FNM_DIR === undefined) delete process.env.FNM_DIR;
    else process.env.FNM_DIR = before.FNM_DIR;
  });
  process.env.FNM_DIR = fnm;
  process.env.PATH = path.join(shell1, 'bin');
  const gw = gatewayPlist({ nodeBin: path.join(brew, 'Cellar', 'node', '26.1', 'bin', 'node'), entry: '/x/src/cli.js', port: 8787 });
  const tn = tunnelPlist({ cloudflared: path.join(shell1, 'bin', 'cloudflared'), name: 'keysmith', configFile: '/x/keysmith.yml' });
  const alias = path.join(fnm, 'aliases', 'default');
  assert.ok(gw.includes(`<string>${path.join(brew, 'opt', 'node', 'bin', 'node')}</string>`), gw);
  assert.ok(tn.includes(`<string>${path.join(alias, 'lib', 'node_modules', 'cloudflared', 'lib', 'cloudflared.js')}</string>`), tn);
  for (const p of [gw, tn]) {
    assert.ok(p.includes(`<string>${path.join(alias, 'bin')}:`), 'PATH through the default alias');
    assert.doesNotMatch(p, /fnm_multishells|\/Cellar\//);
  }
});

test('keysmith install-service --dry-run prints the agents and writes nothing', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-dryrun-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 8799, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
  const r = spawnSync(process.execPath, [CLI, 'install-service', '--dry-run'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dev\.keysmith\.gateway\.plist:\n<\?xml/);
  assert.match(r.stdout, /<string>serve<\/string>\n\s*<string>--port<\/string>\n\s*<string>8799<\/string>/);
  assert.match(r.stdout, /dry run: nothing written, nothing loaded/);
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'LaunchAgents')), 'no agent file');
});
