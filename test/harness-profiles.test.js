/**
 * Ticket 3: HarnessRouter CLI Profiles, Stream Parsers (harness-json), and MCP Bridge Drivers
 * (geminiDriver, kimiDriver).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessJson, PARSERS } from '../src/parsers.js';
import { CLI_PROFILES, PROFILE_ALIASES, getProfile, profileNames } from '../src/profiles.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { geminiDriver, kimiDriver, GEMINI_BRIDGE_ARGS, KIMI_BRIDGE_ARGS } from '../src/bridge/clis.js';
import { DRIVERS } from '../src/bridge/drivers.js';
import { SESSION_DEFAULTS } from '../src/bridge/hub.js';
import { SHIM } from '../src/bridge/agy.js';
import { checkAdapter } from '../src/gateway.js';

async function* from(lines) {
  for (const l of lines) yield typeof l === 'string' ? l : JSON.stringify(l);
}

async function runParser(lines) {
  const out = [];
  for await (const e of harnessJson(from(lines))) out.push(e);
  return out;
}

const textOf = (evts) => evts.filter((e) => e.type === 'delta').map((e) => e.text).join('');

test('harness-json parser: registered in PARSERS and parses Gemini CLI stream-json & single-object stats.models', async () => {
  assert.equal(PARSERS['harness-json'], harnessJson);

  // Gemini CLI stream-json events
  const streamEvts = await runParser([
    { type: 'init', session_id: 'gem-sess-1', model: 'gemini-3-pro-preview' },
    { type: 'message', role: 'user', content: 'Hello' },
    { type: 'message', role: 'assistant', content: 'Hello ', delta: true },
    { type: 'tool_use', tool_name: 'mcp__ks012345__get_weather', tool_id: 'call_1', parameters: { city: 'Istanbul' } },
    { type: 'message', role: 'assistant', content: 'world!', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 120, output_tokens: 18, cached: 40, thoughts: 5 } },
  ]);
  assert.equal(textOf(streamEvts), 'Hello world!');
  assert.deepEqual(streamEvts.filter((e) => e.type === 'session').map((e) => e.id), ['gem-sess-1']);
  assert.deepEqual(streamEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['mcp__ks012345__get_weather']);
  assert.deepEqual(streamEvts.find((e) => e.type === 'usage').usage, {
    input: 120,
    output: 18,
    cacheRead: 40,
    cacheWrite: 0,
    reasoning: 5,
  });

  // Gemini CLI single-object JSON with stats.models
  const singleEvts = await runParser([
    {
      session_id: 'gem-single-1',
      response: 'Single JSON reply',
      stats: {
        models: {
          'gemini-2.5-pro': { tokens: { input: 100, candidates: 25, cached: 10, thoughts: 4 } },
          'gemini-2.5-flash': { tokens: { prompt: 50, output: 10, cached: 0, thoughts: 0 } },
        },
      },
    },
  ]);
  assert.equal(textOf(singleEvts), 'Single JSON reply');
  assert.deepEqual(singleEvts.find((e) => e.type === 'usage').usage, {
    input: 150,
    output: 35,
    cacheRead: 10,
    cacheWrite: 0,
    reasoning: 4,
  });
});

test('harness-json parser: parses Cline, Goose, Kimi, Pi/OMP, OpenHands, OpenSquilla, Hermes, and dcode streams', async () => {
  // Cline (`--json`)
  const clineEvts = await runParser([
    { type: 'say', say: 'reasoning', text: 'Thinking step...' },
    { type: 'say', say: 'text', text: 'Part 1', partial: true },
    { type: 'say', say: 'text', text: 'Part 1 and Part 2', partial: false },
    { type: 'say', say: 'tool', text: JSON.stringify({ tool: 'read_file' }) },
    { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 300, tokensOut: 45, cacheReads: 100, cacheWrites: 20 }) },
  ]);
  assert.equal(textOf(clineEvts), 'Part 1 and Part 2');
  assert.deepEqual(clineEvts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['Thinking step...']);
  assert.deepEqual(clineEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['read_file']);
  assert.deepEqual(clineEvts.find((e) => e.type === 'usage').usage, { input: 300, output: 45, cacheRead: 100, cacheWrite: 20 });

  // Goose (`--output-format stream-json`)
  const gooseEvts = await runParser([
    { type: 'message', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'goose thought' }, { type: 'text', text: 'Goose ' }, { type: 'toolRequest', id: 'tr1', toolCall: { name: 'shell' } }] } },
    { type: 'message', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    { type: 'complete', total_tokens: 512 },
  ]);
  assert.equal(textOf(gooseEvts), 'Goose answer');
  assert.deepEqual(gooseEvts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['goose thought']);
  assert.deepEqual(gooseEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['shell']);
  assert.deepEqual(gooseEvts.find((e) => e.type === 'usage').usage, { input: 0, output: 512, cacheRead: 0, cacheWrite: 0 });

  // Kimi (`--output-format stream-json`)
  const kimiEvts = await runParser([
    { role: 'assistant', content: [{ type: 'think', think: 'kimi reasoning' }, { type: 'text', text: 'Kimi response' }], tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'mcp__ks012345__lookup', arguments: '{}' } }] },
  ]);
  assert.equal(textOf(kimiEvts), 'Kimi response');
  assert.deepEqual(kimiEvts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['kimi reasoning']);
  assert.deepEqual(kimiEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['mcp__ks012345__lookup']);

  // Pi / OMP (`--mode json`)
  const piEvts = await runParser([
    { type: 'session', id: 'pi-sess-99' },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pi thought' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi delta ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'ptc1', name: 'bash' } } },
    { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi delta complete' }], usage: { input: 80, output: 15, cacheRead: 20, cacheWrite: 5 } } },
  ]);
  assert.equal(textOf(piEvts), 'Pi delta ');
  assert.deepEqual(piEvts.filter((e) => e.type === 'session').map((e) => e.id), ['pi-sess-99']);
  assert.deepEqual(piEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['bash']);
  assert.deepEqual(piEvts.find((e) => e.type === 'usage').usage, { input: 80, output: 15, cacheRead: 20, cacheWrite: 5 });

  // OpenHands (`--headless --json`)
  const ohEvts = await runParser([
    { id: 1, source: 'agent', action: 'run', args: { command: 'ls', thought: 'need to list' } },
    { id: 2, source: 'agent', action: 'message', args: { content: 'OpenHands final message' }, llm_metrics: { accumulated_token_usage: { prompt_tokens: 400, completion_tokens: 60, cache_read_tokens: 100, cache_write_tokens: 0, reasoning_tokens: 12 } } },
  ]);
  assert.equal(textOf(ohEvts), 'OpenHands final message');
  assert.deepEqual(ohEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['run']);
  assert.deepEqual(ohEvts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['need to list']);
  assert.deepEqual(ohEvts.find((e) => e.type === 'usage').usage, { input: 400, output: 60, cacheRead: 100, cacheWrite: 0, reasoning: 12 });

  // OpenSquilla (`agent --local --json`)
  const sqEvts = await runParser([
    { payloads: [{ text: 'Squilla payload 1' }, { text: 'Squilla payload 2' }], meta: { agentMeta: { sessionId: 'sq-sess-1', usage: { input: 55, output: 14, cacheRead: 5, cacheWrite: 0 } } } },
  ]);
  assert.equal(textOf(sqEvts), 'Squilla payload 1\nSquilla payload 2');
  assert.deepEqual(sqEvts.filter((e) => e.type === 'session').map((e) => e.id), ['sq-sess-1']);
  assert.deepEqual(sqEvts.find((e) => e.type === 'usage').usage, { input: 55, output: 14, cacheRead: 5, cacheWrite: 0 });

  // dcode (`run --format json`) & Hermes (`session_id: ...`)
  const dcodeEvts = await runParser([
    'session_id: hermes-123',
    { type: 'run.start', session_id: 'dcode-456' },
    { type: 'message.delta', text: 'dcode streaming' },
    { type: 'tool.start', name: 'grep' },
    { type: 'run.end', usage: { input_tokens: 90, output_tokens: 11 } },
  ]);
  assert.equal(textOf(dcodeEvts), 'dcode streaming');
  assert.deepEqual(dcodeEvts.filter((e) => e.type === 'session').map((e) => e.id), ['hermes-123', 'dcode-456']);
  assert.deepEqual(dcodeEvts.filter((e) => e.type === 'tool').map((e) => e.name), ['grep']);
  assert.deepEqual(dcodeEvts.find((e) => e.type === 'usage').usage, { input: 90, output: 11, cacheRead: 0, cacheWrite: 0 });
});

test('CLI_PROFILES & PROFILE_ALIASES: all 24 HarnessRouter CLI profiles load and aliases resolve to canonical profiles', () => {
  const expectedHarnesses = [
    'gemini', 'kilo', 'qwen', 'cline', 'goose', 'kimi', 'minimax', 'grok',
    'pi', 'omp', 'dsh', 'aider', 'mimo', 'jcode', 'vibe', 'hermes',
    'openhands', 'cheetahclaws', 'opensquilla', 'nanobot', 'zeroclaw',
    'docker-agent', 'fast-agent', 'dcode',
  ];
  for (const name of expectedHarnesses) {
    assert.ok(CLI_PROFILES[name], `missing profile ${name}`);
    assert.doesNotThrow(() => checkAdapter(name, CLI_PROFILES[name]), `${name} passes checkAdapter`);
    assert.ok(profileNames().includes(name), `profileNames includes ${name}`);
  }

  for (const [alias, target] of Object.entries(PROFILE_ALIASES)) {
    assert.equal(getProfile(alias), getProfile(target), `alias ${alias} -> ${target}`);
  }
});

test('geminiDriver and kimiDriver: build isolated MCP bridge plans with 0600 session files and no token in argv', () => {
  const session = {
    rid: 'abcdef012345',
    server: 'ksabcdef',
    token: 'SECRET-BRIDGE-TOKEN-999',
    env: { KEYSMITH_BRIDGE_SOCK: '/tmp/ks.sock', KEYSMITH_BRIDGE_TOKEN: 'SECRET-BRIDGE-TOKEN-999' },
    limits: { ...SESSION_DEFAULTS },
  };

  // 1. Gemini CLI bridge plan
  const gemAdapter = new CliAdapter('gemini', { ...CLI_PROFILES.gemini, cwd: '/ws/gemini', unsafeTools: false, disabled: false, toolMode: 'mcp' });
  assert.ok(DRIVERS.some((d) => d.id === 'gemini' && d.supports(gemAdapter)));
  assert.equal(geminiDriver.prefix(session.server), 'mcp__ksabcdef__');
  const gemPlan = geminiDriver.plan(gemAdapter, { session, model: 'gemini-3-pro-preview', prompt: 'Hello Gemini' });

  assert.equal(GEMINI_BRIDGE_ARGS, CLI_PROFILES.gemini.bridge.args);
  assert.ok(!gemPlan.argv.some((a) => a.includes(session.token)), 'gemini: token never in argv');
  assert.equal(gemPlan.files.length, 1);
  assert.match(gemPlan.files[0].file, /^\/ws\/gemini\/\.keysmith-bridge\/ks-b-abcdef012345\.gemini\.json$/);
  assert.equal(gemPlan.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, gemPlan.files[0].file);
  const gemCfg = JSON.parse(gemPlan.files[0].content);
  assert.deepEqual(gemCfg.tools.core, [], 'gemini: built-in core tools disabled');
  assert.equal(gemCfg.mcpServers.ksabcdef.trust, true, 'gemini: only Keysmith MCP server trusted');
  assert.equal(gemCfg.mcpServers.ksabcdef.env.KEYSMITH_BRIDGE_TOKEN, session.token);

  // 2. Kimi CLI bridge plan
  const kimiAdapter = new CliAdapter('kimi', { ...CLI_PROFILES.kimi, cwd: '/ws/kimi', unsafeTools: false, disabled: false, toolMode: 'mcp' });
  assert.ok(DRIVERS.some((d) => d.id === 'kimi' && d.supports(kimiAdapter)));
  assert.equal(kimiDriver.prefix(session.server), 'mcp__ksabcdef__');
  const kimiPlan = kimiDriver.plan(kimiAdapter, { session, model: 'kimi-k2.5', prompt: 'Hello Kimi' });

  assert.equal(KIMI_BRIDGE_ARGS, CLI_PROFILES.kimi.bridge.args);
  assert.ok(!kimiPlan.argv.some((a) => a.includes(session.token)), 'kimi: token never in argv');
  assert.equal(kimiPlan.files.length, 1);
  assert.match(kimiPlan.files[0].file, /^\/ws\/kimi\/\.keysmith-bridge\/ks-b-abcdef012345\.mcp\.json$/);
  assert.ok(kimiPlan.argv.includes('--mcp-config-file'));
  assert.equal(kimiPlan.argv[kimiPlan.argv.indexOf('--mcp-config-file') + 1], kimiPlan.files[0].file);
  const kimiCfg = JSON.parse(kimiPlan.files[0].content);
  assert.equal(kimiCfg.mcpServers.ksabcdef.command, process.execPath);
  assert.deepEqual(kimiCfg.mcpServers.ksabcdef.args, [SHIM]);
  assert.equal(kimiCfg.mcpServers.ksabcdef.env.KEYSMITH_BRIDGE_TOKEN, session.token);
});
