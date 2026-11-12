/**
 * Virtual models (`virtualModels`, e.g. `auto/text`, `auto/vision`):
 *   1. Config validation at load (`validateVirtualModels`, `loadConfig`, `new Gateway`)
 *   2. Label routing (`simple` | `medium` | `complex`, classifier failure -> `medium`, prompt cache / `stickySeconds`)
 *   3. Congestion gate (`loadGate`: `maxLoadPerCore`, `maxMemoryPressure`) skipping classifier -> remote `medium` / `congested`
 *   4. Fallthrough on 429 / quota / timeout / 5xx within a tier and across tiers up (`simple` -> `medium` -> `complex`)
 *   5. Scope enforcement on concrete targets for keys that allow `auto/*` (`claude-api` never called)
 *   6. Observability (`usage.jsonl` records `{virtual, label, chosen, fallbacks, reason, latency}`, `/v1/models`, `keysmith route explain`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { LlmError } from '../src/util.js';
import { loadConfig, validateVirtualModels } from '../src/config.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { parseKeys } from '../src/keys.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');

/**
 * Build an in-memory stub adapter with per-model behavior and call tracking.
 */
function makeStubAdapter(id, { kind = 'http', local = undefined, costBasis = undefined, models = ['default'], handler = null } = {}) {
  const calls = [];
  return {
    id,
    kind,
    wire: kind === 'http' ? 'openai' : null,
    priority: 10,
    disabled: false,
    ...(local !== undefined ? { local } : {}),
    ...(costBasis ? { costBasis } : {}),
    _declared: models,
    calls,
    async models() {
      return models.map((m) => (typeof m === 'string' ? { id: m } : m));
    },
    async *complete(opts) {
      calls.push(opts);
      if (handler) {
        const res = await handler(opts, calls);
        if (typeof res === 'string') {
          yield { type: 'delta', text: res };
          yield { type: 'usage', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } };
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        if (Array.isArray(res)) {
          for (const ev of res) yield ev;
          return;
        }
      }
      yield { type: 'delta', text: `${id}/${opts.model}` };
      yield { type: 'usage', usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/* ---------------------------------------------------------------- 1. Config validation */

test('config validation: accepts valid virtualModels and rejects invalid classifier, tiers, loadGate, stickySeconds, or unknown adapters', () => {
  const baseAdapters = {
    'ollama-local': { kind: 'http', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: false, models: ['qwen3.8:8b', 'qwen3.8:14b', 'llama3.3:8b'] },
    'gemini-cli': { kind: 'cli', bin: 'gemini', args: ['-p', '{prompt}'], parser: 'raw', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
    'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-ant-test-dummy00000000', models: ['claude-sonnet-4-6', 'claude-opus-4-6'] },
  };

  const validCfg = {
    adapters: baseAdapters,
    aliases: { fast: ['ollama-local/qwen3.8:8b'] },
    virtualModels: {
      'auto/text': {
        classifier: 'ollama-local/qwen3.8:8b',
        tiers: {
          simple: ['ollama-local/qwen3.8:8b', 'ollama-local/llama3.3:8b'],
          medium: ['ollama-local/qwen3.8:14b', 'gemini-cli/gemini-2.5-flash'],
          complex: [' gemini-cli/gemini-2.5-pro '.trim(), 'claude-api/claude-opus-4-6'],
        },
        loadGate: {
          maxLoadPerCore: 0.85,
          maxMemoryPressure: 'warn',
        },
        stickySeconds: 120,
      },
    },
  };

  const map = validateVirtualModels(validCfg);
  assert.equal(map.size, 1);
  assert.equal(map.get('auto/text').classifier, 'ollama-local/qwen3.8:8b');
  assert.deepEqual(map.get('auto/text').tiers.simple, ['ollama-local/qwen3.8:8b', 'ollama-local/llama3.3:8b']);

  // Missing classifier
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    /classifier must be a non-empty "<adapter>\/<model>" string/,
  );

  // Unknown adapter in classifier
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'missing-adapter/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    /no adapter named "missing-adapter"/,
  );

  // Unknown adapter in tier candidate
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ghost/model-1'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    /tiers\.medium\[0\]: no adapter named "ghost"/,
  );

  // Undeclared model on adapter with declared models list
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/not-a-declared-model'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    /not among ollama-local's declared models/,
  );

  // Missing Complex tier
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'] },
          },
        },
      }),
    /tiers\.complex must be a non-empty array/,
  );

  // Invalid loadGate field / value
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
            loadGate: { maxLoadPerCore: -1 },
          },
        },
      }),
    /loadGate\.maxLoadPerCore must be a positive number/,
  );

  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
            loadGate: { maxMemoryPressure: 'extreme' },
          },
        },
      }),
    /loadGate\.maxMemoryPressure must be "normal", "warn", "critical"/,
  );

  // Invalid stickySeconds
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
            stickySeconds: -5,
          },
        },
      }),
    /stickySeconds must be a non-negative number/,
  );

  // Collision with alias or adapter prefix
  assert.throws(
    () =>
      validateVirtualModels({
        adapters: baseAdapters,
        aliases: { 'auto/text': ['ollama-local/qwen3.8:8b'] },
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: ['ollama-local/qwen3.8:8b'], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    /collides with alias/,
  );

  // loadConfig integration check from disk
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-vm-cfg-'));
  try {
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        adapters: baseAdapters,
        virtualModels: {
          'auto/text': {
            classifier: 'ollama-local/qwen3.8:8b',
            tiers: { simple: [], medium: ['ollama-local/qwen3.8:14b'], complex: ['claude-api/claude-opus-4-6'] },
          },
        },
      }),
    );
    assert.throws(() => loadConfig({ file: cfgFile }), /tiers\.simple must be a non-empty array/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 2. Label routing */

test('label routing: routes simple, medium, and complex labels to their tiers, caches prompts within stickySeconds, and defaults to medium on classifier failure', async () => {
  let nextClassifierReply = 'simple';
  let currentNow = 1_000_000;

  const ollamaLocal = makeStubAdapter('ollama-local', {
    local: true,
    models: ['qwen3.8:8b', 'qwen3.8:14b'],
    handler: async (opts) => {
      // Distinguish classifier call (has system prompt or maxTokens <= 16) from target completion
      if (opts.system && opts.system.includes('Classify the complexity')) {
        if (nextClassifierReply instanceof Error) throw nextClassifierReply;
        return nextClassifierReply;
      }
      return `local-answer:${opts.model}`;
    },
  });
  const geminiCli = makeStubAdapter('gemini-cli', {
    kind: 'cli',
    local: false,
    models: ['gemini-2.5-flash'],
    handler: async (opts) => `gemini-answer:${opts.model}`,
  });
  const claudeCli = makeStubAdapter('claude-cli', {
    kind: 'cli',
    local: false,
    models: ['claude-sonnet-4-6'],
    handler: async (opts) => `claude-answer:${opts.model}`,
  });

  const gw = new Gateway(
    {
      adapters: {
        'ollama-local': ollamaLocal,
        'gemini-cli': geminiCli,
        'claude-cli': claudeCli,
      },
      virtualModels: {
        'auto/text': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['ollama-local/qwen3.8:8b'],
            medium: ['ollama-local/qwen3.8:14b', 'gemini-cli/gemini-2.5-flash'],
            complex: ['claude-cli/claude-sonnet-4-6'],
          },
          loadGate: { maxLoadPerCore: 0.9, maxMemoryPressure: 'warn' },
          stickySeconds: 60,
        },
      },
    },
    {
      loadProbe: () => ({ loadPerCore: 0.25, cores: 8, memoryPressure: 'normal' }),
      now: () => currentNow,
    },
  );

  // 1) "simple" classification -> tiers.simple (ollama-local/qwen3.8:8b)
  nextClassifierReply = 'simple';
  const rSimple = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'What is 2 + 2?' }],
  });
  assert.equal(rSimple.text, 'local-answer:qwen3.8:8b');
  assert.equal(rSimple.virtual.virtual, 'auto/text');
  assert.equal(rSimple.virtual.label, 'simple');
  assert.equal(rSimple.virtual.chosen, 'ollama-local/qwen3.8:8b');
  assert.deepEqual(rSimple.virtual.fallbacks, []);
  assert.equal(rSimple.virtual.reason, 'classified');
  // Verify classifier was called with tiny max_tokens
  assert.equal(ollamaLocal.calls[0].maxTokens, 8);

  // 2) Repeat identical prompt within stickySeconds -> cached/sticky, classifier not called again
  const callsBeforeCacheHit = ollamaLocal.calls.length;
  nextClassifierReply = 'complex'; // would be complex if classifier ran, but cache should return 'simple'
  const rCached = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'What is 2 + 2?' }],
  });
  assert.equal(rCached.text, 'local-answer:qwen3.8:8b');
  assert.equal(rCached.virtual.label, 'simple');
  assert.equal(rCached.virtual.reason, 'sticky');
  assert.equal(ollamaLocal.calls.length, callsBeforeCacheHit + 1, 'only target completion ran; classifier was skipped via cache');

  // Advance clock past stickySeconds -> classifier runs again
  currentNow += 61_000;
  nextClassifierReply = 'complex';
  const rComplex = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Prove the soundness of Paxos under asynchronous message reordering.' }],
  });
  assert.equal(rComplex.text, 'claude-answer:claude-sonnet-4-6');
  assert.equal(rComplex.virtual.label, 'complex');
  assert.equal(rComplex.virtual.chosen, 'claude-cli/claude-sonnet-4-6');
  assert.equal(rComplex.virtual.reason, 'classified');

  // 3) "medium" classification -> tiers.medium[0] (ollama-local/qwen3.8:14b)
  nextClassifierReply = 'medium';
  const rMedium = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Write a debounce helper in JavaScript.' }],
  });
  assert.equal(rMedium.text, 'local-answer:qwen3.8:14b');
  assert.equal(rMedium.virtual.label, 'medium');
  assert.equal(rMedium.virtual.chosen, 'ollama-local/qwen3.8:14b');

  // 4) Classifier failure -> defaults to `medium`
  nextClassifierReply = new Error('connection refused to classifier');
  const rFailDefault = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Another distinct prompt when classifier fails' }],
  });
  assert.equal(rFailDefault.text, 'local-answer:qwen3.8:14b');
  assert.equal(rFailDefault.virtual.label, 'medium');
  assert.equal(rFailDefault.virtual.chosen, 'ollama-local/qwen3.8:14b');
  assert.match(rFailDefault.virtual.reason, /classifier_error.*defaulted to medium/);

  // 5) Classifier unparseable output -> defaults to `medium`
  nextClassifierReply = 'banana';
  const rInvalidDefault = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Prompt with invalid classifier reply' }],
  });
  assert.equal(rInvalidDefault.text, 'local-answer:qwen3.8:14b');
  assert.equal(rInvalidDefault.virtual.label, 'medium');
  assert.match(rInvalidDefault.virtual.reason, /classifier_invalid.*defaulted to medium/);
});

/* ---------------------------------------------------------------- 3. Congestion skip */

test('congestion skip: when loadPerCore or memoryPressure exceeds loadGate, skips classifier and routes to first remote candidate of medium (or configured congested tier)', async () => {
  let probeState = { loadPerCore: 1.4, cores: 8, memoryPressure: 'normal' };

  const ollamaLocal = makeStubAdapter('ollama-local', {
    local: true,
    models: ['qwen3.8:8b', 'qwen3.8:14b'],
  });
  const geminiCli = makeStubAdapter('gemini-cli', {
    kind: 'cli',
    local: false,
    models: ['gemini-2.5-flash'],
  });
  const claudeCli = makeStubAdapter('claude-cli', {
    kind: 'cli',
    local: false,
    models: ['claude-sonnet-4-6'],
  });

  const gw = new Gateway(
    {
      adapters: {
        'ollama-local': ollamaLocal,
        'gemini-cli': geminiCli,
        'claude-cli': claudeCli,
      },
      virtualModels: {
        'auto/text': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['ollama-local/qwen3.8:8b'],
            // First candidate in medium is local (ollama-local/qwen3.8:14b); second is remote (gemini-cli/gemini-2.5-flash)
            medium: ['ollama-local/qwen3.8:14b', 'gemini-cli/gemini-2.5-flash'],
            complex: ['claude-cli/claude-sonnet-4-6'],
          },
          loadGate: {
            maxLoadPerCore: 0.8,
            maxMemoryPressure: 'warn',
          },
        },
        'auto/vision': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['ollama-local/qwen3.8:8b'],
            medium: ['ollama-local/qwen3.8:14b'],
            complex: ['claude-cli/claude-sonnet-4-6'],
            congested: ['gemini-cli/gemini-2.5-flash'],
          },
          loadGate: {
            maxLoadPerCore: 0.8,
            maxMemoryPressure: 'warn',
          },
        },
      },
    },
    {
      loadProbe: () => probeState,
    },
  );

  // 1) CPU load congestion: skips ollama-local classifier AND local medium candidate, routes to gemini-cli/gemini-2.5-flash
  const rLoad = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Hello under high CPU load' }],
  });
  assert.equal(rLoad.text, 'gemini-cli/gemini-2.5-flash');
  assert.equal(ollamaLocal.calls.length, 0, 'neither local classifier nor local candidate was called while congested');
  assert.equal(geminiCli.calls.length, 1);
  assert.equal(rLoad.virtual.chosen, 'gemini-cli/gemini-2.5-flash');
  assert.match(rLoad.virtual.reason, /congested/);

  // 2) Memory pressure congestion (`warn` >= `maxMemoryPressure: "warn"`): skips classifier and routes to remote candidate
  probeState = { loadPerCore: 0.2, cores: 8, memoryPressure: 'warn' };
  const rMem = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Hello under memory pressure' }],
  });
  assert.equal(rMem.text, 'gemini-cli/gemini-2.5-flash');
  assert.equal(ollamaLocal.calls.length, 0, 'classifier still not called under memory pressure');
  assert.match(rMem.virtual.reason, /congested.*memory pressure/);

  // 3) Configured `congested` tier on `auto/vision`
  const rCongestedTier = await gw.collect({
    model: 'auto/vision',
    messages: [{ role: 'user', content: 'Describe this diagram' }],
  });
  assert.equal(rCongestedTier.text, 'gemini-cli/gemini-2.5-flash');
  assert.equal(rCongestedTier.virtual.tier, 'congested');
  assert.equal(rCongestedTier.virtual.chosen, 'gemini-cli/gemini-2.5-flash');
  assert.equal(ollamaLocal.calls.length, 0);
});

/* ---------------------------------------------------------------- 4. Fallthrough on 429 / quota / timeout / 5xx */

test('fallthrough: falls through on 429, quota, timeout, and 5xx to the next candidate in the tier and then to the next tier up', async () => {
  const ollamaLocal = makeStubAdapter('ollama-local', {
    local: true,
    models: ['qwen3.8:8b', 'llama3.3:8b', 'qwen3.8:14b'],
    handler: async (opts) => {
      if (opts.system && opts.system.includes('Classify the complexity')) {
        return 'simple';
      }
      if (opts.model === 'qwen3.8:8b') {
        throw new LlmError('429 Too Many Requests: local queue full', { status: 429, provider: 'ollama-local' });
      }
      if (opts.model === 'llama3.3:8b') {
        const err = new Error('request timed out after 2000ms');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      if (opts.model === 'qwen3.8:14b') {
        throw new LlmError('503 upstream overloaded', { status: 503, provider: 'ollama-local' });
      }
      return `local:${opts.model}`;
    },
  });

  const geminiCli = makeStubAdapter('gemini-cli', {
    kind: 'cli',
    local: false,
    models: ['gemini-2.5-flash'],
    handler: async () => {
      throw new LlmError('quota exhausted for gemini-2.5-flash today', { status: 429, provider: 'gemini-cli' });
    },
  });

  const claudeCli = makeStubAdapter('claude-cli', {
    kind: 'cli',
    local: false,
    models: ['claude-sonnet-4-6'],
    handler: async (opts) => `claude-rescued:${opts.model}`,
  });

  const gw = new Gateway(
    {
      adapters: {
        'ollama-local': ollamaLocal,
        'gemini-cli': geminiCli,
        'claude-cli': claudeCli,
      },
      virtualModels: {
        'auto/text': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['ollama-local/qwen3.8:8b', 'ollama-local/llama3.3:8b'],
            medium: ['ollama-local/qwen3.8:14b', 'gemini-cli/gemini-2.5-flash'],
            complex: ['claude-cli/claude-sonnet-4-6'],
          },
        },
      },
    },
    {
      loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }),
    },
  );

  const res = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Say hello' }],
  });

  assert.equal(res.text, 'claude-rescued:claude-sonnet-4-6');
  assert.equal(res.virtual.label, 'simple');
  assert.equal(res.virtual.tier, 'complex');
  assert.equal(res.virtual.chosen, 'claude-cli/claude-sonnet-4-6');
  assert.deepEqual(res.virtual.fallbacks, [
    'ollama-local/qwen3.8:8b',
    'ollama-local/llama3.3:8b',
    'ollama-local/qwen3.8:14b',
    'gemini-cli/gemini-2.5-flash',
  ]);
  assert.deepEqual(res.virtual.fallbacksTried, [
    'ollama-local/qwen3.8:8b',
    'ollama-local/llama3.3:8b',
    'ollama-local/qwen3.8:14b',
    'gemini-cli/gemini-2.5-flash',
  ]);
  assert.match(res.virtual.reason, /fallthrough/);
});

/* ---------------------------------------------------------------- 5. Scope enforcement on concrete targets */

test('scope enforcement: a key scope that allows auto/* is checked against concrete targets at routing time and never routes to a disallowed adapter like claude-api', async () => {
  const ollamaLocal = makeStubAdapter('ollama-local', {
    local: true,
    models: ['qwen3.8:8b'],
    handler: async (opts) => {
      if (opts.system && opts.system.includes('Classify the complexity')) return 'complex';
      return `local:${opts.model}`;
    },
  });
  const claudeApi = makeStubAdapter('claude-api', {
    local: false,
    costBasis: 'api_key',
    models: ['claude-opus-4-6'],
    handler: async (opts) => `claude-api:${opts.model}`,
  });
  const geminiCli = makeStubAdapter('gemini-cli', {
    kind: 'cli',
    local: false,
    costBasis: 'subscription',
    models: ['gemini-2.5-pro'],
    handler: async (opts) => `gemini-cli:${opts.model}`,
  });

  const KEY_FULL = mint();
  const KEY_DENY_CLAUDE = mint();
  const KEY_ALLOW_SUBSET = mint();
  const KEY_AUTO_ONLY = mint();
  const KEY_NO_AUTO = mint();

  const cfg = {
    auth: {
      enabled: true,
      keys: [
        KEY_FULL,
        { key: KEY_DENY_CLAUDE, label: 'no-claude', allow: ['auto/*'], deny: ['claude-api'] },
        { key: KEY_ALLOW_SUBSET, label: 'subset', allow: ['auto/*', 'ollama-local/*', 'gemini-cli/*'] },
        { key: KEY_AUTO_ONLY, label: 'auto-only', allow: ['auto/*'] },
        { key: KEY_NO_AUTO, label: 'no-auto', allow: ['ollama-local/*'] },
      ],
    },
    adapters: {
      'ollama-local': ollamaLocal,
      'claude-api': claudeApi,
      'gemini-cli': geminiCli,
    },
    virtualModels: {
      'auto/text': {
        classifier: 'ollama-local/qwen3.8:8b',
        tiers: {
          simple: ['ollama-local/qwen3.8:8b'],
          medium: ['gemini-cli/gemini-2.5-pro'],
          // claude-api is first in complex, gemini-cli is second
          complex: ['claude-api/claude-opus-4-6', 'gemini-cli/gemini-2.5-pro'],
        },
      },
      'auto/claude-only': {
        classifier: 'ollama-local/qwen3.8:8b',
        tiers: {
          simple: ['claude-api/claude-opus-4-6'],
          medium: ['claude-api/claude-opus-4-6'],
          complex: ['claude-api/claude-opus-4-6'],
        },
      },
    },
  };

  const parsedKeys = parseKeys(cfg.auth.keys).entries;
  const scopeOf = (rawKey) => parsedKeys.find((e) => e.key === rawKey)?.scope || null;

  const gw = new Gateway(cfg, {
    loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }),
  });

  // 1) Key with `{ allow: ['auto/*'], deny: ['claude-api'] }` skips claude-api/claude-opus-4-6 and routes to gemini-cli/gemini-2.5-pro
  const resDenyClaude = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Complex architectural question' }],
    scope: scopeOf(KEY_DENY_CLAUDE),
  });
  assert.equal(resDenyClaude.text, 'gemini-cli:gemini-2.5-pro');
  assert.equal(claudeApi.calls.length, 0, 'claude-api was NEVER called');
  assert.equal(resDenyClaude.virtual.chosen, 'gemini-cli/gemini-2.5-pro');
  assert.deepEqual(resDenyClaude.virtual.skipped, ['claude-api/claude-opus-4-6']);

  // 2) Key with `{ allow: ['auto/*', 'ollama-local/*', 'gemini-cli/*'] }` also skips claude-api and routes to gemini-cli
  const resSubset = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Another complex question' }],
    scope: scopeOf(KEY_ALLOW_SUBSET),
  });
  assert.equal(resSubset.text, 'gemini-cli:gemini-2.5-pro');
  assert.equal(claudeApi.calls.length, 0, 'claude-api was NEVER called');

  // 3) When all candidates in the virtual model are outside the key's scope (`auto/claude-only`), throws 403 and never calls claude-api
  await assert.rejects(
    () =>
      gw.collect({
        model: 'auto/claude-only',
        messages: [{ role: 'user', content: 'Try reaching claude-only virtual model' }],
        scope: scopeOf(KEY_DENY_CLAUDE),
      }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.scopeDenied, true);
      assert.match(err.message, /claude-api/);
      return true;
    },
  );
  assert.equal(claudeApi.calls.length, 0, 'claude-api was still NEVER called');

  // 4) Key with `{ allow: ['auto/*'] }` (no concrete target allowed) is refused with 403 on concrete targets
  await assert.rejects(
    () =>
      gw.collect({
        model: 'auto/claude-only',
        messages: [{ role: 'user', content: 'Try with bare auto/* allowlist' }],
        scope: scopeOf(KEY_AUTO_ONLY),
      }),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /claude-api/);
      return true;
    },
  );
  assert.equal(claudeApi.calls.length, 0);

  // 5) Key whose allow-list does not include `auto/*` (`{ allow: ['ollama-local/*'] }`) is refused at the front door
  await assert.rejects(
    () =>
      gw.collect({
        model: 'auto/text',
        messages: [{ role: 'user', content: 'Hello' }],
        scope: scopeOf(KEY_NO_AUTO),
      }),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /virtual model "auto\/text"/);
      return true;
    },
  );

  // 6) Unscoped key CAN reach claude-api/claude-opus-4-6 when classified as complex
  const resFull = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'Unscoped complex request' }],
    scope: scopeOf(KEY_FULL),
  });
  assert.equal(resFull.text, 'claude-api:claude-opus-4-6');
  assert.equal(claudeApi.calls.length, 1);
});

test('scope enforcement: a scoped key cannot send the virtual request to its denied classifier adapter', async () => {
  const classifier = makeStubAdapter('local-classifier', {
    local: true,
    models: ['qwen'],
    handler: async (opts) => {
      if (opts.system) return 'complex';
      return 'local answer';
    },
  });
  const remote = makeStubAdapter('remote', {
    local: false,
    models: ['model'],
    handler: async () => 'remote answer',
  });
  const key = mint();
  const cfg = {
    auth: { enabled: true, keys: [{ key, allow: ['auto/*', 'remote/*'], deny: ['local-classifier'] }] },
    adapters: { 'local-classifier': classifier, remote },
    virtualModels: {
      'auto/text': {
        classifier: 'local-classifier/qwen',
        tiers: {
          simple: ['remote/model'],
          medium: ['remote/model'],
          complex: ['remote/model'],
        },
      },
    },
  };
  const scope = parseKeys(cfg.auth.keys).entries[0].scope;
  const gw = new Gateway(cfg, { loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }) });

  const result = await gw.collect({
    model: 'auto/text',
    messages: [{ role: 'user', content: 'hard request' }],
    scope,
  });

  assert.equal(result.text, 'remote answer');
  assert.equal(classifier.calls.length, 0);
  assert.equal(result.virtual.reason, 'classifier_scope_denied (defaulted to medium)');
});

/* ---------------------------------------------------------------- 6. Observability, /v1/models & route explain */

test('observability & explain: records {virtual, label, chosen, fallbacks, reason, latency} in usage.jsonl, lists virtual models in /v1/models, and dry-runs keysmith route explain without calling target', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-vm-obs-'));
  try {
    const usageFile = path.join(tmpDir, 'usage.jsonl');
    const usage = new UsageLog(usageFile);
    const API_KEY = mint();

    let classifierLabel = 'simple';
    const ollamaLocal = makeStubAdapter('ollama-local', {
      local: true,
      models: ['qwen3.8:8b', 'llama3.3:8b', 'qwen3.8:14b'],
      handler: async (opts) => {
        if (opts.system && opts.system.includes('Classify the complexity')) {
          return classifierLabel;
        }
        if (opts.model === 'qwen3.8:8b') {
          throw new LlmError('429 rate limit on qwen3.8:8b', { status: 429, provider: 'ollama-local' });
        }
        return `ollama-answered:${opts.model}`;
      },
    });
    const geminiCli = makeStubAdapter('gemini-cli', {
      kind: 'cli',
      local: false,
      models: ['gemini-2.5-flash'],
    });

    const cfg = {
      auth: { enabled: true, keys: [API_KEY] },
      adapters: {
        'ollama-local': ollamaLocal,
        'gemini-cli': geminiCli,
      },
      virtualModels: {
        'auto/text': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['ollama-local/qwen3.8:8b', 'ollama-local/llama3.3:8b'],
            medium: ['ollama-local/qwen3.8:14b', 'gemini-cli/gemini-2.5-flash'],
            complex: ['gemini-cli/gemini-2.5-flash'],
          },
          loadGate: { maxLoadPerCore: 0.85, maxMemoryPressure: 'warn' },
          stickySeconds: 30,
        },
        'auto/vision': {
          classifier: 'ollama-local/qwen3.8:8b',
          tiers: {
            simple: ['gemini-cli/gemini-2.5-flash'],
            medium: ['gemini-cli/gemini-2.5-flash'],
            complex: ['gemini-cli/gemini-2.5-flash'],
          },
        },
      },
    };

    const gw = new Gateway(cfg, {
      usage,
      loadProbe: () => ({ loadPerCore: 0.2, cores: 8, memoryPressure: 'normal' }),
    });
    const server = createServer(gw, cfg, { usage });

    async function invokeServer({ method = 'GET', url = '/', headers = {}, body = null }) {
      const payload = body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')] : [];
      const req = Readable.from(payload);
      req.method = method;
      req.url = url;
      req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      req.socket = { remoteAddress: '127.0.0.1' };

      return await new Promise((resolve, reject) => {
        const res = new EventEmitter();
        const resHeaders = new Map();
        const chunks = [];
        res.statusCode = 200;
        res.headersSent = false;
        res.writableEnded = false;
        res.setHeader = (k, v) => resHeaders.set(String(k).toLowerCase(), String(v));
        res.getHeader = (k) => resHeaders.get(String(k).toLowerCase());
        res.writeHead = (status, hdrs = {}) => {
          res.statusCode = status;
          res.headersSent = true;
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders.set(String(k).toLowerCase(), String(v));
          }
        };
        res.write = (chunk) => {
          res.headersSent = true;
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          return true;
        };
        res.end = (chunk) => {
          if (chunk) res.write(chunk);
          res.headersSent = true;
          res.writableEnded = true;
          res.emit('close');
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: { get: (k) => resHeaders.get(String(k).toLowerCase()) || null },
            text,
            json: () => JSON.parse(text),
          });
        };
        try {
          server.emit('request', req, res);
        } catch (err) {
          reject(err);
        }
      });
    }

    // 1) GET /v1/models lists `auto/text` and `auto/vision`
    const modelsRes = await invokeServer({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsBody = modelsRes.json();
    const autoText = modelsBody.data.find((m) => m.id === 'auto/text');
    const autoVision = modelsBody.data.find((m) => m.id === 'auto/vision');
    assert.ok(autoText, 'auto/text is listed in /v1/models');
    assert.ok(autoVision, 'auto/vision is listed in /v1/models');
    assert.equal(autoText.owned_by, 'keysmith:virtual');
    assert.equal(autoText.keysmith.kind, 'virtual');
    assert.equal(autoText.keysmith.classifier, 'ollama-local/qwen3.8:8b');

    // 2) POST /v1/chat/completions with `model: "auto/text"` routes and logs observability fields in usage.jsonl
    const chatRes = await invokeServer({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: {
        model: 'auto/text',
        messages: [{ role: 'user', content: 'Summarize this one-liner' }],
      },
    });
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.headers.get('x-keysmith-route'), 'ollama-local/llama3.3:8b');
    const chatBody = chatRes.json();
    assert.equal(chatBody.choices[0].message.content, 'ollama-answered:llama3.3:8b');

    await gw.settleClassifierCalls();
    const rows = fs
      .readFileSync(usageFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // The request's row, and the classifier call's own (metered like a leg).
    assert.equal(rows.length, 2);
    const clfRow = rows.find((r) => r.purpose === 'classifier');
    assert.ok(clfRow, 'the classifier call has a usage row');
    assert.equal(clfRow.adapter, 'ollama-local');
    assert.equal(clfRow.model, 'ollama-local/qwen3.8:8b');
    assert.equal(clfRow.virtual, 'auto/text');
    assert.equal(clfRow.label, 'simple');
    assert.equal(clfRow.status, 'ok');
    assert.deepEqual(clfRow.usage, { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 });
    const row = rows.find((r) => r.purpose !== 'classifier');
    assert.equal(row.virtual, 'auto/text');
    assert.equal(row.label, 'simple');
    assert.equal(row.chosen, 'ollama-local/llama3.3:8b');
    assert.deepEqual(row.fallbacks, ['ollama-local/qwen3.8:8b']);
    assert.deepEqual(row.fallbacksTried, ['ollama-local/qwen3.8:8b']);
    assert.match(row.reason, /classified.*fallthrough/);
    assert.equal(typeof row.latency, 'number');
    assert.ok(row.latency >= 0);

    // 3) `gateway.explainRoute` dry-runs without calling the target
    const geminiCallsBefore = geminiCli.calls.length;
    classifierLabel = 'complex';
    const explained = await gw.explainRoute('auto/text', 'Design a distributed consensus protocol');
    assert.equal(explained.virtual, 'auto/text');
    assert.equal(explained.label, 'complex');
    assert.equal(explained.chosen, 'gemini-cli/gemini-2.5-flash');
    assert.equal(explained.dryRun, true);
    assert.equal(geminiCli.calls.length, geminiCallsBefore, 'explainRoute must not call the target adapter');

    // 4) CLI `keysmith route explain auto/text "<prompt>"` dry-runs and formats the decision
    const stubClassifierScript = path.join(tmpDir, 'clf-stub.js');
    fs.writeFileSync(
      stubClassifierScript,
      `#!/usr/bin/env node\nprocess.stdout.write("complex\\n");\n`,
      { mode: 0o755 },
    );
    const targetMarkerFile = path.join(tmpDir, 'target-called.txt');
    const stubTargetScript = path.join(tmpDir, 'target-stub.js');
    fs.writeFileSync(
      stubTargetScript,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(targetMarkerFile)}, 'called');\nprocess.stdout.write("target output\\n");\n`,
      { mode: 0o755 },
    );

    const cliCfgDir = path.join(tmpDir, 'config', 'keysmith');
    fs.mkdirSync(cliCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliCfgDir, 'config.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port: 8787,
        auth: { enabled: true, keys: [API_KEY] },
        adapters: {
          'clf-local': {
            kind: 'cli',
            bin: stubClassifierScript,
            args: ['{prompt}'],
            parser: 'raw',
            models: ['qwen3.8:8b'],
          },
          'target-cli': {
            kind: 'cli',
            bin: stubTargetScript,
            args: ['{prompt}'],
            parser: 'raw',
            models: ['sonnet-4-6', 'haiku-4-5'],
          },
        },
        virtualModels: {
          'auto/text': {
            classifier: 'clf-local/qwen3.8:8b',
            tiers: {
              simple: ['target-cli/haiku-4-5'],
              medium: ['target-cli/haiku-4-5'],
              complex: ['target-cli/sonnet-4-6', 'target-cli/haiku-4-5'],
            },
            loadGate: { maxLoadPerCore: 100, maxMemoryPressure: 'critical' },
          },
        },
      }),
    );

    const cliRun = spawnSync(
      process.execPath,
      [CLI_PATH, 'route', 'explain', 'auto/text', 'Architect a multi-region database'],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(tmpDir, 'config'),
          KEYSMITH_DATA: tmpDir,
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
    assert.match(cliRun.stdout, /virtual model:\s+auto\/text/);
    assert.match(cliRun.stdout, /label:\s+complex/);
    assert.match(cliRun.stdout, /chosen:\s+target-cli\/sonnet-4-6/);
    assert.match(cliRun.stdout, /fallbacks:\s+target-cli\/haiku-4-5/);
    assert.match(cliRun.stdout, /dry-run; target not called/);
    assert.equal(fs.existsSync(targetMarkerFile), false, 'CLI route explain must never execute the target adapter');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('classifier instruction reaches adapters that read the system prompt from messages (as the HTTP and CLI adapters do)', async () => {
  const { flattenMessages } = await import('../src/util.js');
  // Like the real adapters: the system prompt comes from `messages`; a bare `system` field is ignored.
  const realistic = makeStubAdapter('agy', {
    kind: 'cli',
    local: false,
    models: ['gemini-flash'],
    handler: async (opts) => {
      const { system } = flattenMessages(opts.messages);
      if (system.includes('Classify the complexity')) return 'complex';
      return 'Here is a long answer to your question instead of a label.';
    },
  });
  const target = makeStubAdapter('copilot', { models: ['gpt-4.1'] });
  const gw = new Gateway(
    {
      adapters: { agy: realistic, copilot: target },
      virtualModels: {
        'auto/text': {
          classifier: 'agy/gemini-flash',
          tiers: { simple: ['copilot/gpt-4.1'], medium: ['copilot/gpt-4.1'], complex: ['copilot/gpt-4.1'] },
        },
      },
    },
    { loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }) },
  );
  const r = await gw.explainRoute('auto/text', 'Design a lock-free ring buffer');
  assert.equal(r.reason, 'classified');
  assert.equal(r.label, 'complex');
  const clfCall = realistic.calls[0];
  assert.equal(clfCall.messages[0].role, 'system');
  assert.match(clfCall.messages[0].content, /Classify the complexity/);
  assert.equal(clfCall.messages.at(-1).role, 'user');
});

/* ------------------------------------------------ classifierPrompt, rules, classifier metering */

const RUBRIC = 'Classify the complexity of the user request for routing. Reply with one word only: simple, medium, or complex.\nsimple = a self-contained question.';

function clfGateway({ vm = {}, reply = 'complex', usage = null, pricing = null, spend = null, tierAdapter = null } = {}) {
  const clf = makeStubAdapter('clf', {
    models: ['tiny'],
    handler: async (opts) => (opts.messages?.[0]?.role === 'system' ? (typeof reply === 'function' ? reply(opts) : reply) : 'answer'),
  });
  const target = tierAdapter || makeStubAdapter('copilot', { kind: 'cli', models: ['s', 'm', 'c'] });
  const gw = new Gateway(
    {
      adapters: { clf, copilot: target },
      ...(pricing ? { pricing } : {}),
      ...(spend ? { limits: { spend } } : {}),
      virtualModels: {
        'auto/text': {
          classifier: 'clf/tiny',
          tiers: { simple: ['copilot/s'], medium: ['copilot/m'], complex: ['copilot/c'] },
          ...vm,
        },
      },
    },
    { usage, loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }) },
  );
  return { gw, clf, target };
}

test('classifierPrompt: validated at load, sent as the classifier system message, and part of the prompt cache key', async () => {
  const adapters = { clf: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['tiny'] }, copilot: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m'] } };
  const tiers = { simple: ['copilot/m'], medium: ['copilot/m'], complex: ['copilot/m'] };
  const check = (vm) => validateVirtualModels({ adapters, virtualModels: { 'auto/text': { classifier: 'clf/tiny', tiers, ...vm } } }).get('auto/text');
  assert.equal(check({}).classifierPrompt, null);
  assert.equal(check({ classifierPrompt: `  ${RUBRIC}  ` }).classifierPrompt, RUBRIC);
  assert.equal(check({ classifier: { model: 'clf/tiny', prompt: RUBRIC } }).classifierPrompt, RUBRIC);
  assert.throws(() => check({ classifierPrompt: '   ' }), /classifierPrompt must be a non-empty string/);
  assert.throws(() => check({ classifierPrompt: 42 }), /classifierPrompt must be a non-empty string/);
  assert.throws(() => check({ classifierPrompt: 'x'.repeat(4001) }), /over 4000/);

  const { gw, clf } = clfGateway({ vm: { classifierPrompt: RUBRIC } });
  const r = await gw.explainRoute('auto/text', 'Design a lock-free ring buffer');
  assert.equal(r.label, 'complex');
  assert.equal(r.reason, 'classified');
  assert.equal(clf.calls[0].messages[0].role, 'system');
  assert.equal(clf.calls[0].messages[0].content, RUBRIC);
  assert.equal(clf.calls[0].system, RUBRIC);

  // The default instruction stays when none is set.
  const plain = clfGateway({});
  await plain.gw.explainRoute('auto/text', 'Design a lock-free ring buffer');
  assert.match(plain.clf.calls[0].messages[0].content, /^Classify the complexity of the user request\. Reply with one word only/);

  // A different instruction is a different cache entry: the same prompt is asked again under it.
  const { hashClassifierPrompt } = await import('../src/virtual-models.js');
  assert.notEqual(hashClassifierPrompt('same prompt'), hashClassifierPrompt('same prompt', RUBRIC));
});

test('rules: validated at load (label, known fields, at least one condition, valid patterns, maxChars range)', () => {
  const adapters = { clf: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['tiny'] }, copilot: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['m'] } };
  const tiers = { simple: ['copilot/m'], medium: ['copilot/m'], complex: ['copilot/m'] };
  const check = (rules) => validateVirtualModels({ adapters, virtualModels: { 'auto/text': { classifier: 'clf/tiny', tiers, rules } } }).get('auto/text');
  const ok = check([{ name: 'utility', label: 'simple', match: ['\\btranslate\\b'], unless: 'repo', maxChars: 160, noTools: true, noMedia: true, noCode: true }]);
  assert.equal(ok.rules.length, 1);
  assert.equal(ok.rules[0].name, 'utility');
  assert.equal(ok.rules[0].match.length, 1);
  assert.equal(check([{ label: 'complex', match: 'threat model' }]).rules[0].name, 'rules[0]');
  assert.deepEqual(check(undefined).rules, []);
  assert.throws(() => check({ label: 'simple' }), /rules must be an array/);
  assert.throws(() => check([{ label: 'trivial', match: 'x' }]), /label must be simple, medium, or complex/);
  assert.throws(() => check([{ label: 'simple' }]), /at least one condition/);
  assert.throws(() => check([{ label: 'simple', match: 'x', when: 'y' }]), /unknown field "when"/);
  assert.throws(() => check([{ label: 'simple', match: '(' }]), /match\[0\] is not a valid regular expression/);
  assert.throws(() => check([{ label: 'simple', match: [] }]), /match must be a pattern or a non-empty list/);
  assert.throws(() => check([{ label: 'simple', maxChars: 0 }]), /maxChars must be a whole number from 1 to 1200/);
  assert.throws(() => check([{ label: 'simple', maxChars: 5000 }]), /maxChars must be a whole number from 1 to 1200/);
  assert.throws(() => check([{ label: 'simple', noTools: 'yes' }]), /noTools must be true or false/);
  assert.throws(() => check([{ label: 'simple', match: 'x'.repeat(301) }]), /over 300 characters/);
});

test('rules: the first matching rule labels the request without asking the classifier; tools, media, code, unless and length keep it off', async () => {
  const rules = [
    // `\\b` is an ASCII word boundary in JavaScript, even with the `u` flag: before a letter like `ç` it never
    // holds. Case folding is Unicode's (Ç matches ç) but not Turkish (İ does not match i, nor I ı).
    { name: 'utility', label: 'simple', match: ['\\btranslate\\b', 'ÇEVIR\\b'], unless: ['\\brepo\\b'], maxChars: 120, noTools: true, noMedia: true, noCode: true },
    { name: 'threat-model', label: 'complex', match: 'threat model' },
  ];
  const { gw, clf, target } = clfGateway({ vm: { rules }, reply: 'medium' });

  const hit = await gw.explainRoute('auto/text', 'Translate to English: "Toplantı ertelendi."');
  assert.equal(hit.label, 'simple');
  assert.equal(hit.reason, 'rule:utility');
  assert.equal(hit.chosen, 'copilot/s');
  assert.equal(clf.calls.length, 0, 'a rule hit never asks the classifier');
  assert.equal((await gw.explainRoute('auto/text', 'Şu cümleyi İngilizceye çevir: merhaba')).reason, 'rule:utility', 'case-insensitive, Unicode');
  assert.equal((await gw.explainRoute('auto/text', 'Write a threat model for the gateway')).reason, 'rule:threat-model');
  assert.equal(clf.calls.length, 0);

  // Each condition that fails sends the request to the classifier instead.
  const asked = async (prompt, opts = {}) => {
    const before = clf.calls.length;
    const r = await gw.explainRoute('auto/text', prompt, opts);
    assert.equal(clf.calls.length, before + 1, `classifier asked for: ${prompt.slice(0, 40)}`);
    assert.equal(r.reason, 'classified');
    return r;
  };
  await asked('Translate the README of this repo into Turkish'); // unless
  await asked('Translate this:\n```\nconst a = 1;\n```'); // noCode
  await asked(`Translate ${'very '.repeat(30)}long text`); // maxChars
  await asked('Translate to English: "ok" please', { hasTools: true }); // noTools
  await asked('Translate the text in this image', {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Translate the text in this image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  }); // noMedia
  await asked('What is the capital of France?'); // no rule matches

  // Through a completion: the rule picks the tier and the route answers from it.
  const r = await gw.collect({ model: 'auto/text', messages: [{ role: 'user', content: 'Translate to English: "Sunucu yarın kapanacak."' }] });
  assert.equal(r.virtual.label, 'simple');
  assert.equal(r.virtual.reason, 'rule:utility');
  assert.equal(target.calls.at(-1).model, 's');
});

test('rules: a session already sticky to a label keeps it, and a rule hit is never cached or made sticky', async () => {
  let reply = 'complex';
  const rules = [{ name: 'utility', label: 'simple', match: '\\btranslate\\b' }];
  const { gw, clf } = clfGateway({ vm: { rules, stickySeconds: 600 }, reply: () => reply });
  const first = await gw.explainRoute('auto/text', 'Design the sync protocol for an offline-first app', { session: 's1' });
  assert.equal(first.label, 'complex');
  const sticky = await gw.explainRoute('auto/text', 'Translate to English: "tamam"', { session: 's1' });
  assert.equal(sticky.label, 'complex');
  assert.equal(sticky.reason, 'sticky');
  // A fresh session starting on a rule hit is not stuck at simple.
  const r1 = await gw.explainRoute('auto/text', 'Translate to English: "tamam"', { session: 's2' });
  assert.equal(r1.reason, 'rule:utility');
  reply = 'medium';
  const r2 = await gw.explainRoute('auto/text', 'Fix the off-by-one in my loop', { session: 's2' });
  assert.equal(r2.label, 'medium');
  assert.equal(r2.reason, 'classified');
  assert.equal(clf.calls.length, 2);
});

test('classifier metering: each classifier call writes a usage row with its token counts and cost, and the adapter spend cap holds it back', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-vm-meter-'));
  try {
    const pricing = { 'clf/*': { input: 1000, output: 1000 } };
    const usage = new UsageLog(path.join(tmpDir, 'usage.jsonl'), { pricing });
    const { gw, clf } = clfGateway({ usage, pricing, spend: { clf: 0.001 } });

    const r = await gw.explainRoute('auto/text', 'Design a lock-free ring buffer');
    assert.equal(r.label, 'complex');
    await gw.settleClassifierCalls();
    const rows = () => fs.readFileSync(path.join(tmpDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const [row] = rows();
    assert.equal(row.purpose, 'classifier');
    assert.equal(row.virtual, 'auto/text');
    assert.equal(row.adapter, 'clf');
    assert.equal(row.model, 'clf/tiny');
    assert.equal(row.resolvedModel, 'tiny');
    assert.equal(row.status, 'ok');
    assert.equal(row.reason, 'classified');
    assert.equal(row.label, 'complex');
    assert.deepEqual(row.usage, { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(row.cost, { usd: 0.014, basis: 'metered' });
    assert.equal(typeof row.classifyMs, 'number');
    assert.equal(usage.spendSummary({ clf: 0.001 }, { adapters: { clf: {} } })[0].spent, 0.014);

    // Over its cap now: the next prompt is labelled medium without asking, and the refusal has a row.
    const capped = await gw.explainRoute('auto/text', 'Another prompt entirely');
    assert.equal(capped.label, 'medium');
    assert.match(capped.reason, /^classifier_unavailable \(defaulted to medium\)$/);
    assert.match(capped.classifyError, /spend cap/i);
    assert.equal(clf.calls.length, 1, 'the capped classifier was not asked');
    await gw.settleClassifierCalls();
    const limited = rows()[1];
    assert.equal(limited.purpose, 'classifier');
    assert.equal(limited.status, 'limited');
    assert.match(limited.error, /spend cap/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('classifier metering: the label returns at once, the reply is read on for its token counts, and a timeout or error still writes one row', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-vm-meter2-'));
  try {
    const usage = new UsageLog(path.join(tmpDir, 'usage.jsonl'));
    let mode = 'slow-tail';
    // A classifier whose reply the test shapes: the label at once and its token counts 150 ms
    // later (as a stream ends), a reply that never comes, or a refusal.
    const clf = {
      ...makeStubAdapter('clf', { models: ['tiny'] }),
      async *complete(opts) {
        clf.calls.push(opts);
        if (mode === 'error') throw new Error('connection refused');
        if (mode === 'slow-tail') {
          yield { type: 'delta', text: 'simple' };
          await new Promise((r) => setTimeout(r, 150));
          yield { type: 'usage', usage: { input: 30, output: 1, cacheRead: 0, cacheWrite: 0 } };
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        await new Promise((r) => {
          const t = setTimeout(r, 5000);
          opts.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };
    const copilot = makeStubAdapter('copilot', { kind: 'cli', models: ['s', 'm', 'c'] });
    const gw = new Gateway(
      {
        adapters: { clf, copilot },
        virtualModels: {
          'auto/text': { classifier: 'clf/tiny', classifierTimeoutMs: 300, tiers: { simple: ['copilot/s'], medium: ['copilot/m'], complex: ['copilot/c'] } },
        },
      },
      { usage, loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }) },
    );
    const rows = () => fs.readFileSync(path.join(tmpDir, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const t0 = Date.now();
    const fast = await gw.explainRoute('auto/text', 'What is a mebibyte?');
    assert.equal(fast.label, 'simple');
    assert.ok(Date.now() - t0 < 140, 'the label did not wait for the rest of the reply');
    assert.equal(fs.existsSync(path.join(tmpDir, 'usage.jsonl')) ? rows().length : 0, 0, 'the row waits for the token counts');
    await gw.settleClassifierCalls();
    assert.equal(rows().length, 1);
    assert.deepEqual(rows()[0].usage, { input: 30, output: 1, cacheRead: 0, cacheWrite: 0 });

    mode = 'hang';
    const slow = await gw.explainRoute('auto/text', 'A prompt the classifier never answers');
    assert.match(slow.reason, /^classifier_timeout/);
    await gw.settleClassifierCalls();
    assert.equal(rows().length, 2);
    assert.equal(rows()[1].status, 'error');
    assert.equal(rows()[1].reason, 'classifier_timeout');
    assert.equal(rows()[1].usage, null);

    mode = 'error';
    const failed = await gw.explainRoute('auto/text', 'A prompt the classifier refuses');
    assert.match(failed.reason, /^classifier_error/);
    await gw.settleClassifierCalls();
    assert.equal(rows().length, 3);
    assert.equal(rows()[2].status, 'error');
    assert.match(rows()[2].error, /connection refused/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
