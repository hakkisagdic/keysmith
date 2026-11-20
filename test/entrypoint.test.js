/**
 * npm's bin is a symlink, and import.meta.url percent-encodes spaces, so the
 * entrypoint guard compares real paths. Importing this module must not run main().
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntrypoint } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-entrypoint-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, 'home');
const spaced = path.join(tmp, 'dir with space');
fs.mkdirSync(home);
fs.mkdirSync(spaced);
const link = path.join(tmp, 'keysmith-link');
const spacedLink = path.join(spaced, 'cli-link.js');
fs.symlinkSync(CLI, link);
fs.symlinkSync(CLI, spacedLink);
const other = path.join(tmp, 'other.js');
fs.writeFileSync(other, '');

const env = {
  ...process.env,
  HOME: home,
  KEYSMITH_CONFIG: path.join(home, 'config.json'),
  KEYSMITH_DATA: path.join(home, 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg'),
  XDG_DATA_HOME: path.join(home, 'xdgdata'),
};

const run = (args, cwd) => spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 20_000 });

function assertHelp(r) {
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.ok(r.stdout.length > 0, 'help text is empty');
  assert.match(r.stdout, /keysmith init[\s\S]*keysmith add[\s\S]*keysmith serve/);
}

test('--help runs through a bin symlink and through a directory whose name has a space', () => {
  assertHelp(run(['./keysmith-link', '--help'], tmp));
  assertHelp(run([spacedLink, '--help'], tmp));
});

test('isEntrypoint compares real paths; a missing or unresolvable argv is not the entrypoint', () => {
  const meta = pathToFileURL(CLI).href;
  const encodedSpaced = pathToFileURL(spacedLink).href;
  assert.match(encodedSpaced, /%20/);
  assert.equal(isEntrypoint(meta, link), true);
  assert.equal(isEntrypoint(meta, path.relative(process.cwd(), link)), true);
  assert.equal(isEntrypoint(encodedSpaced, spacedLink), true);
  assert.equal(isEntrypoint(meta, spacedLink), true);
  assert.equal(isEntrypoint(meta, CLI), true);
  assert.equal(isEntrypoint(meta, undefined), false);
  assert.equal(isEntrypoint(meta, ''), false);
  assert.equal(isEntrypoint(meta, '-e'), false);
  assert.equal(isEntrypoint(meta, other), false);
  assert.equal(isEntrypoint(meta, path.join(tmp, 'no-such.js')), false);
});
