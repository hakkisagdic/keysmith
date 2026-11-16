import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const base = (() => {
  for (const b of ['origin/main', 'main']) {
    try { execSync(`git rev-parse --verify ${b}`, { cwd: root, stdio: 'pipe' }); return b; } catch {}
  }
  return null;
})();

test('K8: added diff lines carry no personal path or email', { skip: !base }, () => {
  const diff = execSync(`git diff ${base}... -- README.md CHANGELOG.md docs/adapters.md src test ':(exclude)test/slice4-k8-k1.test.js'`, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const bad = added.filter((l) => /\/Users\/|@[A-Za-z0-9.-]+\.(com|net|org|tr)\b/.test(l)
    && !/noreply@|@example\.|user@host|git@github/.test(l));
  assert.deepEqual(bad, []);
});

test('K8: README documents catalogue limits, usage record, profiles', () => {
  const r = readFileSync(root + 'README.md', 'utf8');
  assert.match(r, /Catalogue limits/);
  assert.match(r, /Recording external usage/);
  assert.match(r, /tokenrouter/);
  assert.match(r, /mistral/);
  assert.match(r, /discover/);
  assert.match(r, /freeOnly/);
});

test('K8: adapters doc and changelog updated', () => {
  const a = readFileSync(root + 'docs/adapters.md', 'utf8');
  assert.match(a, /tokenrouter/); assert.match(a, /mistral/);
  assert.match(readFileSync(root + 'CHANGELOG.md', 'utf8'), /Unreleased/);
});
