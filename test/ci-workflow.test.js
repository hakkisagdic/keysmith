/**
 * K1–K5 for `.github/workflows/ci.yml`, checked as text. No YAML parser.
 * `actions/setup-node` only selects the matrix Node. `npm ci` is the only package install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');

function readWorkflow() {
  assert.equal(fs.existsSync(workflowPath), true, workflowPath);
  return fs.readFileSync(workflowPath, 'utf8');
}

/** Drop unquoted `#` comments so a note cannot satisfy a check. */
function codeLines(src) {
  return src.split('\n').map((line) => {
    let out = '';
    let quote = null;
    for (const c of line) {
      if (quote) {
        out += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        out += c;
        continue;
      }
      if (c === '#') break;
      out += c;
    }
    return out.replace(/\s+$/, '');
  });
}

function steps(src) {
  const found = [];
  for (const line of codeLines(src)) {
    const uses = line.match(/^\s*-\s*uses:\s*(\S+)\s*$/);
    if (uses) {
      found.push({ kind: 'uses', value: uses[1] });
      continue;
    }
    const run = line.match(/^\s*-\s*run:\s*(.*?)\s*$/);
    if (run) found.push({ kind: 'run', value: run[1] });
  }
  return found;
}

function flowList(src, key) {
  const lines = codeLines(src).filter((line) => new RegExp(`^\\s*${key}:\\s*\\[`).test(line));
  assert.equal(lines.length, 1, `${key} matrix list`);
  const body = lines[0].slice(lines[0].indexOf('[') + 1, lines[0].lastIndexOf(']'));
  return body.split(',').map((part) => part.trim().replace(/^['"]/, '').replace(/['"]$/, '')).filter(Boolean);
}

test('K1: ci.yml runs npm ci and then npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
  const run = steps(readWorkflow()).filter((step) => step.kind === 'run').map((step) => step.value);
  const ci = run.indexOf('npm ci');
  const npmTest = run.indexOf('npm test');
  assert.notEqual(ci, -1, 'npm ci step');
  assert.notEqual(npmTest, -1, 'npm test step');
  assert.ok(ci < npmTest, 'npm ci before npm test');
});

test('K2: matrix is ubuntu-latest and macos-latest with Node 20 and 22', () => {
  const src = readWorkflow();
  assert.deepEqual([...flowList(src, 'os')].sort(), ['macos-latest', 'ubuntu-latest']);
  assert.deepEqual([...flowList(src, 'node')].sort(), ['20', '22']);
  const lines = codeLines(src).join('\n');
  assert.match(lines, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(lines, /node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/);
  assert.equal(lines.includes('exclude:'), false);
  assert.equal(lines.includes('include:'), false);
});

test('K3: no secrets and no download besides checkout, setup-node and npm ci', () => {
  const raw = readWorkflow();
  assert.equal(/secrets\./i.test(raw), false);
  assert.equal(/\bsecrets\b/i.test(raw), false);
  const lower = raw.toLowerCase();
  for (const word of ['curl', 'wget', 'apt-get', 'brew', 'pip ', 'pip\n', 'npx', 'docker', 'yarn', 'pnpm', 'npm install', 'http://', 'https://', 'container:', 'services:']) {
    assert.equal(lower.includes(word), false, word);
  }
  const used = steps(raw).filter((step) => step.kind === 'uses').map((step) => step.value);
  assert.deepEqual(used.map((use) => use.replace(/@v\d+$/, '')), ['actions/checkout', 'actions/setup-node']);
  assert.deepEqual(steps(raw).filter((step) => step.kind === 'run').map((step) => step.value), ['npm ci', 'npm test']);
});

test('K4: the workflow matrix is the four OS and Node jobs, and macOS-only tests skip without their tools', () => {
  const src = readWorkflow();
  const lines = codeLines(src).join('\n');
  assert.ok(codeLines(src).some((line) => line.trim() === 'on: [push]'));
  assert.equal(lines.includes('continue-on-error'), false);
  assert.equal(lines.includes('exclude:'), false);
  const jobs = flowList(src, 'os').flatMap((osName) => flowList(src, 'node').map((node) => `${osName} / ${node}`));
  assert.deepEqual([...jobs].sort(), [
    'macos-latest / 20',
    'macos-latest / 22',
    'ubuntu-latest / 20',
    'ubuntu-latest / 22',
  ]);

  const qa = fs.readFileSync(path.join(root, 'test', 'qa-saglayicilari.test.js'), 'utf8');
  assert.match(qa, /const SEC = '\/usr\/bin\/security'/);
  assert.match(qa, /const hasSec = fs\.existsSync\(SEC\)/);
  assert.match(qa, /skip:\s*!hasSec\b/);

  const secrets = fs.readFileSync(path.join(root, 'test', 'secrets.test.js'), 'utf8');
  const scriptSkips = secrets.split('\n').filter((line) => /skip:\s*!hasScript\b/.test(line));
  assert.equal(scriptSkips.length, 2);
});

test('K5: CI does not set KEYSMITH_PRIVATE_PATTERNS, and that test still skips without it', () => {
  const raw = readWorkflow();
  assert.equal(raw.includes('KEYSMITH_PRIVATE_PATTERNS'), false);
  assert.equal(codeLines(raw).some((line) => /^\s*env:/.test(line)), false);
  const batch = fs.readFileSync(path.join(root, 'test', 'batch-tester.test.js'), 'utf8');
  const skips = batch.split('\n').filter((line) => /skip:\s*!process\.env\.KEYSMITH_PRIVATE_PATTERNS\b/.test(line));
  assert.equal(skips.length, 1);
});
