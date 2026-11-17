/** K1: `--help` / `-h` after any command prints help and touches nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const COMMANDS = ['init', 'add', 'remove', 'rm', 'set', 'upgrade', 'enable', 'disable', 'vision', 'tools', 'alias', 'aliases', 'route', 'adapters', 'models', 'serve', 'start', 'stop', 'install-service', 'uninstall-service', 'status', 'chat', 'doctor', 'tunnel', 'discover', 'config', 'source', 'usage', 'key', 'scrub-logs'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const run = (env, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('K1: every command answers --help and -h with help, exit 0, config and data untouched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-help-'));
  const config = path.join(home, 'config.json');
  const data = path.join(home, 'data');
  fs.writeFileSync(config, JSON.stringify({ auth: { enabled: false, keys: [] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const before = sha(config);
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data, XDG_CONFIG_HOME: path.join(home, 'xdg'), XDG_DATA_HOME: path.join(home, 'xdgdata') };
  try {
    for (let i = 0; i < COMMANDS.length; i += 6) {
      await Promise.all(COMMANDS.slice(i, i + 6).map(async (cmd) => {
        const outs = new Set();
        for (const flag of ['--help', '-h']) {
          const r = await run(env, [cmd, ...(cmd === 'add' ? ['tokenrouter'] : []), flag]);
          assert.equal(r.status, 0, `${cmd} ${flag}: ${r.stderr}`);
          assert.match(r.stdout, /keysmith/, `${cmd} ${flag} prints help`);
          outs.add(r.stdout);
        }
        assert.equal(outs.size, 1, `${cmd}: --help and -h print the same bytes`);
      }));
      assert.equal(sha(config), before, 'the config is untouched');
    }
    assert.deepEqual(fs.readdirSync(home).sort(), ['config.json'], 'nothing was created (no backup, no data dir, no service file)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('K1: a command help names only that command; the old forms still work', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  const set = run('set', '--help').stdout;
  assert.match(set, /keysmith set <adapter>/);
  assert.doesNotMatch(set, /keysmith serve/);
  assert.equal(run('--help').stdout, run('help').stdout);
  assert.equal(run('--version').status, 0);
});
