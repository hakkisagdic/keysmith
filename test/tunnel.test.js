/**
 * Pure helpers in src/tunnel.js. Nothing here spawns a process.
 * The round-trip points HOME at a temp directory: tunnelConfigPath() uses os.homedir().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTunnelId, readTunnelConfig, splitLines, writeTunnelConfig } from '../src/tunnel.js';

function sampleTunnelId() {
  return ['0a1b2c3d', '1111', '2222', '3333', '444455556666'].join('-');
}

test('parseTunnelId returns the uuid from the quoted create line, not the tunnel name', () => {
  const id = sampleTunnelId();
  const parsed = parseTunnelId(`Created new tunnel "keysmith" with ID ${id}`);
  assert.equal(parsed, id);
  assert.notEqual(parsed, 'keysmith');
});

test('parseTunnelId returns the uuid from the unquoted create line, case-insensitively', () => {
  const id = sampleTunnelId();
  assert.equal(parseTunnelId(`Created tunnel keysmith with id ${id}`), id);
});

test('parseTunnelId returns null when the text has no tunnel id', () => {
  assert.equal(parseTunnelId('nothing here'), null);
});

test('writeTunnelConfig round-trips tunnel id, hostname, port, and credentials file', { skip: process.platform === 'win32' ? 'HOME does not select the profile directory on win32' : false }, (t) => {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tunnel-cfg-'));
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;

  const id = sampleTunnelId();
  const hostname = 'llm.example.com';
  const port = 8787;
  const credentialsFile = path.join(home, '.cloudflared', `${id}.json`);
  const written = writeTunnelConfig({ tunnelName: 'keysmith', tunnelId: id, hostname, port, credentialsFile });
  const read = readTunnelConfig();

  assert.equal(written, path.join(home, '.cloudflared', 'keysmith.yml'));
  assert.equal(read.tunnel, id);
  assert.equal(read.hostname, hostname);
  assert.equal(read.port, port);
  assert.equal(read.credentialsFile, credentialsFile);
  assert.equal(read.path, written);
});

test('writeTunnelConfig throws when tunnel id and credentials file are both missing', () => {
  assert.throws(
    () => writeTunnelConfig({ tunnelName: 'k', hostname: 'h', port: 1 }),
    { name: 'Error', message: 'tunnel id or credentialsFile is required' },
  );
});

test('splitLines joins chunks, flushes a trailing partial, and cuts a 20000-char line at max', () => {
  const joined = [];
  const lines = splitLines((line) => joined.push(line));
  lines.push('a\nb');
  lines.push('c\n');
  assert.deepEqual(joined, ['a', 'bc']);

  const partial = [];
  const trailing = splitLines((line) => partial.push(line));
  trailing.push('tail');
  assert.deepEqual(partial, []);
  trailing.end();
  assert.deepEqual(partial, ['tail']);

  const max = 16_384;
  const cut = [];
  const limiter = splitLines((line) => cut.push(line), { max });
  const big = 'm'.repeat(20_000);
  limiter.push(big);
  assert.equal(cut.length, 1);
  assert.equal(cut[0], big);

  const boundary = [];
  const atMax = splitLines((line) => boundary.push(line), { max });
  atMax.push('m'.repeat(max));
  assert.deepEqual(boundary, []);
  atMax.push('m');
  assert.deepEqual(boundary, ['m'.repeat(max + 1)]);
});
