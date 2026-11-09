/**
 * The agent CLIs added after agy — Kiro and Warp's oz — and the guard rails around attaching
 * an agent: tool-less argv for every profile that can be made tool-less, a tool-capable one
 * kept disabled and out of every alias, explicit-only adapters, `modelParams` on an HTTP leg,
 * and the `keysmith alias` / `keysmith set` commands that change a live config without
 * opening the file that holds the gateway key.
 *
 * Every CLI here is a stub that prints the shape the real one printed (or, where a live run
 * could not show it, the shape its binary and protocol name), so nothing spends a token.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { joinArgs } from '../src/util.js';
import { cmdNdjson, kiroStreamJson, opencodeNdjson, warpNdjson } from '../src/parsers.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const KEY = 'ks_agents_00000000000000000000000';

const cleanups = [];
after(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `keysmith-${prefix}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function* from(lines) {
  for (const l of lines) yield typeof l === 'string' ? l : JSON.stringify(l);
}

async function events(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

const textOf = (evts) => evts.filter((e) => e.type === 'delta').map((e) => e.text).join('');

/** A node script as an executable stub CLI. */
function nodeStub(dir, name, body) {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return bin;
}

/* --- kiro-stream-json ------------------------------------------------------------------- */

test('kiro-stream-json: ACP chunks are the answer, the session is said once, a tool call once', async () => {
  const evts = await events(
    kiroStreamJson(
      from([
        { type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } },
        { type: 'metadata', data: { sessionId: 's-1', contextUsagePercentage: 0.76 } },
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } } },
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'O' } } } },
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'fs_read', status: 'pending' } } },
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'fs_read', status: 'in_progress' } } },
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' } } },
        'not json at all',
        { type: 'sessionUpdate', data: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'K' } } } },
        { type: 'metadata', data: { sessionId: 's-1', turnDurationMs: 639, tokenUsage: { inputTokens: 900, outputTokens: 2 } } },
        { type: 'runFinished', data: { finalText: 'OK', finalTextTruncated: false } },
        { type: 'metadata', data: { sessionId: 's-1' } },
      ]),
    ),
  );
  assert.equal(textOf(evts), 'OK', 'finalText repeats the chunks: it is a fallback, never a second copy');
  assert.deepEqual(evts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['hmm']);
  assert.deepEqual(evts.filter((e) => e.type === 'session').map((e) => e.id), ['s-1']);
  assert.deepEqual(evts.filter((e) => e.type === 'tool').map((e) => e.name), ['fs_read']);
  assert.deepEqual(evts.find((e) => e.type === 'usage').usage, { input: 900, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(evts.filter((e) => e.type === 'done').length, 1);
  assert.equal(evts.at(-1).type, 'done', 'runFinished ends the stream');
});

test('kiro-stream-json: finalText answers when no chunk carried text, and an unwrapped update reads the same', async () => {
  const onlyFinal = await events(kiroStreamJson(from([{ type: 'runStarted', data: {} }, { type: 'runFinished', data: { finalText: 'from the end' } }])));
  assert.equal(textOf(onlyFinal), 'from the end');
  const flat = await events(kiroStreamJson(from([{ type: 'sessionUpdate', data: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }])));
  assert.equal(textOf(flat), 'ab');
  assert.equal(flat.at(-1).type, 'done', 'no runFinished line (a stopped run) still ends with done');
});

test('kiro-stream-json: the refusal a live run printed is an error, with Kiro\'s own reason', async () => {
  // Verbatim shape of kiro-cli 2.27.1's answer when the account is over its overage limit.
  const evts = await events(
    kiroStreamJson(
      from([
        '{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}',
        '{"type":"metadata","data":{"sessionId":"73dfb708","contextUsagePercentage":0.7598,"reasoning":{"support":"toggleable","effort":"xhigh","effortLevels":["low","medium","high","xhigh","max"]}}}',
        '{"type":"metadata","data":{"sessionId":"73dfb708","contextUsagePercentage":0.2325,"reasoning":{"support":"unavailable","effortLevels":[]}}}',
        '{"type":"metadata","data":{"sessionId":"73dfb708","turnDurationMs":639,"reasoning":{"support":"unavailable","effortLevels":[]}}}',
        '{"type":"runError","data":{"sessionId":"73dfb708","stage":"prompt","message":"Internal error (code -32603): Encountered an error in the response stream: You have reached the limit for overages. (request_id: f39a)"}}',
      ]),
    ),
  );
  assert.equal(textOf(evts), '');
  const err = evts.find((e) => e.type === 'error');
  assert.match(err.message, /^kiro: .*limit for overages/);
  assert.ok(!evts.some((e) => e.type === 'usage'), 'metadata without token counts is not usage');
  assert.equal(evts.at(-1).type, 'done');
});

/* --- warp-ndjson -------------------------------------------------------------------------- */

test('warp-ndjson: the live run\'s three lines are a session and an answer', async () => {
  const evts = await events(
    warpNdjson(
      from([
        '{"type":"system","event_type":"run_started","run_id":"01a1","run_url":"https://oz.warp.dev/runs/01a1"}',
        '{"type":"system","event_type":"conversation_started","conversation_id":"f68c"}',
        '{"type":"agent","text":"OK\\n"}',
      ]),
    ),
  );
  assert.equal(textOf(evts), 'OK\n');
  assert.deepEqual(evts.filter((e) => e.type === 'session').map((e) => e.id), ['f68c']);
  assert.ok(!evts.some((e) => e.type === 'usage'), 'oz reports no usage, and none is invented');
  assert.equal(evts.at(-1).type, 'done');
});

test('warp-ndjson: a tool call is a tool event, reasoning is reasoning, the rest is noise', async () => {
  const evts = await events(
    warpNdjson(
      from([
        { type: 'agent_reasoning', text: 'let me look' },
        { type: 'tool_call', tool: 'run_command', command: 'ls' },
        { type: 'tool_call', run_command: { command: 'ls' } },
        { type: 'tool_result', ok: true },
        { type: 'update_todos', todos: [] },
        { type: 'agent', text: 'done' },
        { type: 'error', error: { message: 'boom' } },
      ]),
    ),
  );
  assert.deepEqual(evts.filter((e) => e.type === 'tool').map((e) => e.name), ['run_command', 'run_command']);
  assert.deepEqual(evts.filter((e) => e.type === 'reasoning').map((e) => e.text), ['let me look']);
  assert.equal(textOf(evts), 'done');
  assert.equal(evts.find((e) => e.type === 'error').message, 'warp: boom');
});

/* --- the profiles' argv: tool-less where it can be, marked where it cannot ---------------- */

/** Flags that hand an agent permission to act without asking. None may appear in a tool-less profile. */
const AUTO_APPROVE = ['--auto', '-a', '--trust-all-tools', '--yolo', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--approve-for-me', '--full-auto', 'bypassPermissions', 'bypass_permissions', 'danger-full-access', 'workspace-write', '--tools-all'];

const render = (tpl, vars = {}) => joinArgs(tpl, { model: 'm1', prompt: 'User: hi', system: '', session: 'sess-1', noSession: '--no-session-persistence', maxTokens: '', ...vars });

/** The CLI profiles keysmith makes tool-less. Every other CLI profile keeps its tools, so it is marked. */
const TOOL_LESS = ['agy', 'kiro', 'claude', 'qoder', 'codex', 'opencode'];

test('every CLI profile is tool-less or marked: no auto-approve flag, a keysmith-owned workspace, and the ones that keep their tools ship disabled', () => {
  for (const [name, p] of Object.entries(CLI_PROFILES)) {
    for (const tpl of [p.args, p.resumeArgs].filter(Boolean)) {
      const argv = render(tpl);
      for (const flag of AUTO_APPROVE) assert.ok(!argv.includes(flag), `${name}: ${flag}`);
      if (TOOL_LESS.includes(name)) assert.equal(argv.at(-1), 'User: hi', `${name}: the prompt is last`);
    }
    // Under launchd the gateway's own cwd is keysmith's source tree: an agent never runs there.
    assert.match(p.cwd || '', /^~\/\.local\/share\/keysmith\/workspaces\//, `${name}: an empty directory keysmith owns, not whatever cwd the gateway has`);
    if (TOOL_LESS.includes(name)) {
      assert.ok(!p.unsafeTools, `${name} is not marked tool-capable`);
    } else {
      assert.equal(p.unsafeTools, true, `${name} keeps its tools, so it is marked`);
      assert.equal(p.disabled, true, `${name} ships disabled`);
      if (p.parser !== 'raw') assert.equal(p.stopAtToolCall, 'always', `${name}: stopped at the first tool call it reports`);
      assert.match(p.note, /not (verified )?tool-less/i, `${name}: the note says what it can do`);
    }
    assert.doesNotThrow(() => new CliAdapter(name, p), `${name} loads as shipped`);
  }
  assert.deepEqual(
    Object.keys(CLI_PROFILES).filter((n) => !TOOL_LESS.includes(n)).sort(),
    ['aider', 'amp', 'cheetahclaws', 'cline', 'cmd', 'copilot-cli', 'cursor', 'dcode', 'devin', 'docker-agent', 'droid', 'dsh', 'fast-agent', 'gemini', 'goose', 'grok', 'hermes', 'jcode', 'kilo', 'kimi', 'mimo', 'minimax', 'nanobot', 'omp', 'openhands', 'opensquilla', 'pi', 'qwen', 'reasonix', 'traycer-cli', 'vibe', 'warp', 'zeroclaw'],
    'cmd approves its own tool calls in print mode, gemini was never run, warp cannot drop its tools',
  );
});

test('opencode: the tool-less agent and a deny-all opencode.json travel with the profile, and --auto is gone', () => {
  const p = CLI_PROFILES.opencode;
  for (const tpl of [p.args, p.resumeArgs]) {
    const argv = render(tpl);
    assert.ok(!argv.includes('--auto'), 'nothing left to approve, and --auto approves whatever is not denied');
    assert.equal(argv[argv.indexOf('--agent') + 1], 'keysmith-text');
    assert.ok(argv.includes('--pure'), 'no external plugin');
    assert.deepEqual(argv.slice(-2), ['--', 'User: hi']);
  }
  const agent = p.workspaceFiles['.opencode/agent/keysmith-text.md'];
  assert.match(
    agent,
    /^---\n[\s\S]*permission:\n {2}"\*": deny\n {2}external_directory:\n {4}"\*": deny\n {4}"~\/\.local\/share\/opencode\/tool-output\/\*": deny\n {2}read:\n {4}"\*": deny\n {4}"": deny\n[\s\S]*---\n/,
  );
  assert.doesNotMatch(agent, /^tools:/m, '1.19 deprecated tools in favor of permission');
  const config = JSON.parse(p.workspaceFiles['opencode.json']);
  assert.deepEqual(
    config.permission,
    {
      '*': 'deny',
      external_directory: { '*': 'deny', '~/.local/share/opencode/tool-output/*': 'deny' },
      read: { '*': 'deny', '': 'deny' },
    },
    'an agent name that does not resolve falls back to the default agent: it gets nothing either, while keeping read in the schema so opencode.ai does not 429-hang',
  );
  assert.deepEqual(
    config.agent?.['keysmith-text']?.permission,
    config.permission,
    'opencode.json also sets agent["keysmith-text"].permission so OPENCODE_CONFIG_CONTENT overrides global agent config',
  );
  assert.equal('tools' in config, false);
  assert.deepEqual(config.mcp, {});
  assert.deepEqual(config.plugin, []);
  assert.equal(p.stopAtToolCall, 'always');
  assert.equal(p.verifiedVersion, '1.19.3');
  assert.match(p.provenance, /^opencode 1\.19\.3\b/);
  assert.match(p.provenance, /owner decision/i);
  assert.match(p.provenance, /DeniedError/);
  assert.match(p.provenance, /external_directory/);
  assert.match(p.provenance, /OPENCODE_PERMISSION/);
  assert.match(p.provenance, /Console org config/i);
  assert.match(p.provenance, /managed config/i);
  assert.match(p.provenance, /preflight.*guard against config sources keysmith cannot override/i);
  assert.doesNotMatch(p.provenance, /highest priority/i);
  assert.match(p.provenance, /permission rule is the only thing that prevents a tool from executing/i);
  assert.match(p.provenance, /stopAtToolCall.*and the.*scratch dir.*only limit what follows/i);
  assert.match(p.provenance, /verifiedVersion.*allowUnverifiedVersion/i);
  assert.match(p.provenance, /runtime drift detector/i);
  assert.match(p.note, /permission rule is the only thing that prevents a tool from executing/i);
  assert.match(p.note, /stopAtToolCall.*and the.*scratch dir.*only limit what follows/i);
  assert.match(p.note, /OPENCODE_PERMISSION/);
  assert.match(p.note, /Console org config/i);
  assert.match(p.note, /managed config/i);
  assert.match(p.note, /preflight.*guard against config sources keysmith cannot override/i);
  assert.doesNotMatch(p.note, /highest priority/i);
  assert.match(p.note, /verifiedVersion.*allowUnverifiedVersion/i);
  assert.match(p.note, /runtime drift detector/i);
});

test('codex: no web search, no goals, and sub-agents capped at one — what a stub endpoint showed 0.163 still offered', () => {
  const argv = render(CLI_PROFILES.codex.args);
  const configs = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []));
  const disabled = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
  assert.ok(configs.includes('web_search="disabled"'), 'the server-side web_search tool');
  assert.ok(disabled.includes('goals'), 'get_goal / create_goal / update_goal');
  assert.ok(configs.includes('agents.max_threads=1'), 'gpt-6-* keep their sub-agent tools; one sub-agent is the lowest codex accepts');
  assert.match(CLI_PROFILES.codex.note, /sub-agent/, 'the note says what no switch removes');
});

test('kiro: headless, trusts no tool, runs the tool-less agent, and -- keeps the prompt from being read as a flag', () => {
  const p = CLI_PROFILES.kiro;
  const argv = render(p.args, { prompt: '--trust-all-tools' });
  assert.deepEqual(argv.slice(0, 2), ['chat', '--no-interactive']);
  assert.ok(argv.includes('--trust-tools='), 'trust no tool: the flag with an empty list, as one token');
  assert.ok(!argv.some((a) => /^--trust-tools=./.test(a)), 'no tool named in the trust list');
  assert.equal(argv[argv.indexOf('--agent') + 1], 'keysmith-text');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--model') + 1], 'm1');
  assert.deepEqual(argv.slice(-2), ['--', '--trust-all-tools'], 'a prompt that looks like a flag stays the prompt');
  assert.ok(!render(p.args, { model: '' }).includes('--model'), 'no model, no dangling --model');
  assert.equal(p.parser, 'kiro-stream-json');
  assert.deepEqual(p.modelsFrom.args, ['chat', '--list-models', '--format', 'json']);
  assert.equal(p.stopAtToolCall, true);
  assert.ok(!p.resumeArgs && !p.persistSessions, 'resume was not checked live, so it is not offered');
  const agent = JSON.parse(p.workspaceFiles['.kiro/agents/keysmith-text.json']);
  assert.equal(agent.name, 'keysmith-text', 'kiro sets --agent by this name; an unknown one silently means its default agent');
  assert.deepEqual(agent.tools, []);
  assert.deepEqual(agent.allowedTools, []);
  assert.deepEqual(agent.mcpServers, {});
  assert.equal(agent.includeMcpJson, false);
  assert.deepEqual(agent.resources, [], 'no steering files: yours would be the prompt');
  assert.deepEqual(agent.hooks, {});
  assert.match(agent.prompt, /no tools/);
});

test('warp: the oz binary inside Warp.app, never Cloudflare\'s warp-cli, marked tool-capable and shipped disabled', () => {
  const p = CLI_PROFILES.warp;
  assert.equal(p.bin, '/Applications/Warp.app/Contents/Resources/bin/oz');
  assert.ok(!/warp-cli/.test(p.bin));
  const argv = render(p.args);
  assert.deepEqual(argv.slice(0, 2), ['agent', 'run']);
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'ndjson');
  assert.ok(argv.includes('--no-snapshot'), 'no end-of-run workspace upload');
  assert.ok(!argv.some((a) => /^--share/.test(a)), 'never shares the session');
  assert.deepEqual(argv.slice(-2), ['--prompt', 'User: hi']);
  assert.equal(p.parser, 'warp-ndjson');
  assert.equal(p.unsafeTools, true, 'its tools cannot be taken away');
  assert.equal(p.disabled, true, 'so it is off until someone says otherwise');
  assert.equal(p.stopAtToolCall, 'always');
  assert.match(p.note, /run commands/);
});

test('claude and qoder: {noSession} is their own spelling, --tools "" survives as an empty argument, never before the prompt', async () => {
  const dir = tmp('argv');
  const bin = nodeStub(dir, 'echoargv', `process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
  for (const name of ['claude', 'qoder']) {
    const p = CLI_PROFILES[name];
    assert.equal(p.noSessionFlag, '--no-session-persistence', `${name} refuses --no-session`);
    const a = new CliAdapter(name, { ...p, bin, parser: 'raw', cwd: path.join(dir, name) });
    const argv = JSON.parse(textOf(await events(a.complete({ model: '', messages: [{ role: 'user', content: 'hi' }] }))));
    assert.ok(argv.includes('--no-session-persistence') && !argv.includes('--no-session'), name);
    const t = argv.indexOf('--tools');
    assert.equal(argv[t + 1], '', `${name}: "" is the value that disables every built-in tool`);
    assert.notEqual(t + 2, argv.length - 1, `${name}: --tools takes several values, so it must not swallow the prompt`);
    assert.ok(argv.includes('--strict-mcp-config'), `${name}: no MCP server`);
    assert.equal(argv.at(-1), 'User: hi');
  }
  const claude = render(CLI_PROFILES.claude.args);
  assert.equal(claude[claude.indexOf('--permission-prompts') + 1], 'none');
  for (const f of ['--safe-mode', '--disable-slash-commands', '--max-turns']) assert.ok(claude.includes(f), f);
});

test('codex 0.163: read-only sandbox, shell tools disabled, no user config, -- before the prompt', () => {
  const p = CLI_PROFILES.codex;
  const argv = render(p.args);
  assert.equal(argv[0], 'exec');
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  const disabled = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
  for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'plugins', 'apps', 'computer_use', 'browser_use']) assert.ok(disabled.includes(f), f);
  for (const f of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(argv.includes(f), f);
  assert.ok(argv.includes('approval_policy="never"'));
  assert.deepEqual(argv.slice(-2), ['--', 'User: hi']);
  assert.deepEqual(p.modelsFrom.args, ['debug', 'models']);
});

/* --- the CLI adapters against stub CLIs ---------------------------------------------------- */

/** A kiro-shaped stub: writes its argv and whether the agent file was there, then answers. */
function kiroStub(dir) {
  const record = path.join(dir, 'kiro-argv.json');
  const bin = nodeStub(
    dir,
    'kiro-cli',
    `const fs = require('fs');
const argv = process.argv.slice(2);
let agent = null;
try { agent = JSON.parse(fs.readFileSync('.kiro/agents/keysmith-text.json', 'utf8')); } catch {}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, agentTools: agent && agent.tools, cwd: process.cwd() }));
const prompt = argv[argv.length - 1];
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } });
line({ type: 'metadata', data: { sessionId: 'kiro-s1' } });
if (prompt.includes('quota')) {
  line({ type: 'runError', data: { sessionId: 'kiro-s1', stage: 'prompt', message: 'You have reached the limit for overages.' } });
  process.exit(1);
}
if (prompt.includes('slow')) { setTimeout(() => line({ type: 'runFinished', data: { finalText: 'too late' } }), 20000); return; }
for (const t of ['he', 'llo']) line({ type: 'sessionUpdate', data: { sessionId: 'kiro-s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
line({ type: 'runFinished', data: { finalText: 'hello', finalTextTruncated: false } });`,
  );
  return { bin, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('kiro adapter: the agent file is in its workspace before the spawn, and the answer streams through', async () => {
  const dir = tmp('kiro');
  const { bin, record } = kiroStub(dir);
  const ws = path.join(dir, 'workspaces', 'kiro');
  const a = new CliAdapter('kiro', { ...CLI_PROFILES.kiro, bin, cwd: ws });
  const evts = await events(a.complete({ model: 'claude-haiku-4.5', messages: [{ role: 'user', content: 'say hello' }] }));
  assert.equal(textOf(evts), 'hello');
  assert.deepEqual(evts.filter((e) => e.type === 'session').map((e) => e.id), ['kiro-s1']);
  const r = record();
  assert.deepEqual(r.agentTools, [], 'the tool-less agent existed when kiro started');
  assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(ws));
  assert.ok(r.argv.includes('--trust-tools='));
  assert.deepEqual(r.argv.slice(-2), ['--', 'User: say hello']);
  assert.equal(r.argv[r.argv.indexOf('--model') + 1], 'claude-haiku-4.5');
});

test('kiro adapter: Kiro\'s refusal reaches the client as an error, and a run past timeoutMs is killed', async () => {
  const dir = tmp('kiro-err');
  const { bin } = kiroStub(dir);
  const gw = new Gateway({ adapters: {} });
  gw.adapters.set('kiro', new CliAdapter('kiro', { ...CLI_PROFILES.kiro, bin, cwd: path.join(dir, 'ws') }));
  await assert.rejects(gw.collect({ model: 'kiro/auto', messages: [{ role: 'user', content: 'quota please' }] }), /kiro: You have reached the limit for overages/);
  const slow = new CliAdapter('kiro', { ...CLI_PROFILES.kiro, bin, cwd: path.join(dir, 'ws'), timeoutMs: 1_200 });
  const t0 = Date.now();
  await assert.rejects(events(slow.complete({ model: '', messages: [{ role: 'user', content: 'slow' }] })), (e) => e.status === 504 && /timeout after/.test(e.message));
  assert.ok(Date.now() - t0 < 8_000, 'killed at its deadline, not when the stub was done');
});

/** A warp-shaped stub: records argv; `tool` in the prompt calls run_command before any text. */
function warpStub(dir) {
  const record = path.join(dir, 'warp-argv.json');
  const bin = nodeStub(
    dir,
    'oz',
    `const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(argv));
const prompt = argv[argv.indexOf('--prompt') + 1] || '';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'system', event_type: 'run_started', run_id: 'r1', run_url: 'https://oz.warp.dev/runs/r1' });
line({ type: 'system', event_type: 'conversation_started', conversation_id: 'c1' });
if (prompt.includes('tool-first')) {
  line({ type: 'tool_call', tool: 'run_command', command: 'rm -rf ~/' });
  setTimeout(() => line({ type: 'agent', text: 'the command ran' }), 4000);
  return;
}
if (prompt.includes('slow')) { setTimeout(() => line({ type: 'agent', text: 'late' }), 20000); return; }
line({ type: 'agent', text: 'OK\\n' });
if (prompt.includes('tool-after')) {
  line({ type: 'tool_call', tool: 'edit_files' });
  setTimeout(() => line({ type: 'agent', text: 'edited' }), 4000);
}`,
  );
  return { bin, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('warp adapter: answers through oz\'s ndjson, with no snapshot upload and the prompt as --prompt', async () => {
  const dir = tmp('warp');
  const { bin, record } = warpStub(dir);
  const a = new CliAdapter('warp', { ...CLI_PROFILES.warp, disabled: false, bin, cwd: path.join(dir, 'ws') });
  const evts = await events(a.complete({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(textOf(evts), 'OK\n');
  const argv = record();
  assert.ok(argv.includes('--no-snapshot'));
  assert.deepEqual(argv.slice(-2), ['--prompt', 'User: hi']);
  assert.equal(argv[argv.indexOf('--model') + 1], 'auto');
});

test('warp adapter: a tool call before any text stops the run and fails the request; after text it ends the answer', async () => {
  const dir = tmp('warp-tool');
  const { bin } = warpStub(dir);
  const a = new CliAdapter('warp', { ...CLI_PROFILES.warp, disabled: false, bin, cwd: path.join(dir, 'ws') });
  const t0 = Date.now();
  await assert.rejects(events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool-first' }] })), /tool call \(run_command\).*may not run tools/);
  assert.ok(Date.now() - t0 < 3_500, 'the process was stopped, not waited for');
  const after = await events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool-after' }] }));
  assert.equal(textOf(after), 'OK\n', 'what it says after the call is not part of the reply');
  assert.deepEqual(after.filter((e) => e.type === 'cut').map((e) => e.tool), ['edit_files']);
  const slow = new CliAdapter('warp', { ...CLI_PROFILES.warp, disabled: false, bin, cwd: path.join(dir, 'ws'), timeoutMs: 1_200 });
  await assert.rejects(events(slow.complete({ model: '', messages: [{ role: 'user', content: 'slow' }] })), (e) => e.status === 504);
});

test('the warp profile as shipped answers nothing: it is disabled', async () => {
  const gw = new Gateway({ adapters: { warp: { ...CLI_PROFILES.warp, bin: process.execPath } } });
  await assert.rejects(gw.collect({ model: 'warp/auto', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 503 && /disabled/.test(e.message));
});

/** An opencode-shaped stub: records argv, scratch cwd and workspace files, then answers as `opencode run --format json` does. */
function opencodeStub(dir) {
  const record = path.join(dir, 'opencode-argv.json');
  const bin = nodeStub(
    dir,
    'opencode',
    `const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('1.19.3\\n');
  process.exit(0);
}
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const cfgFile = process.env.OPENCODE_CONFIG || 'opencode.json';
const cfgDir = process.env.OPENCODE_CONFIG_DIR || '.opencode';
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv,
  agent: readOr(path.join(cfgDir, 'agent/keysmith-text.md')),
  config: JSON.parse(readOr(cfgFile) || 'null'),
  cwd: process.cwd(),
  pwd: process.env.PWD,
  cwdEntries: fs.readdirSync(process.cwd()),
  opencodeConfig: process.env.OPENCODE_CONFIG || null,
  opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR || null,
  opencodeDisableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG || null,
  opencodeConfigContent: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || 'null'),
  opencodePermission: process.env.OPENCODE_PERMISSION || null,
  opencodeEnvKeys: Object.keys(process.env).filter((k) => k.startsWith('OPENCODE_')).sort(),
}));
const prompt = argv[argv.length - 1] || '';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (prompt.includes('stderr-refusal')) {
  process.stderr.write("Error: OpenCode's free tier can only be used from within OpenCode.\\n");
  setTimeout(() => {}, 20000);
  return;
}
if (prompt.includes('silent-hang')) {
  setTimeout(() => {}, 20000);
  return;
}
if (prompt.includes('slow-first-event')) {
  setTimeout(() => {
    line({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } });
    line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'SLOW_OK' } });
    line({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', tokens: { input: 12, output: 1 } } });
  }, 250);
  return;
}
line({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } });
if (prompt.includes('free')) {
  line({ type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode.", statusCode: 403, isRetryable: false } } });
  process.exit(1);
}
if (prompt.includes('read-first')) {
  const cfgObj = JSON.parse(readOr(cfgFile) || 'null');
  const perm = cfgObj && cfgObj.permission;
  const envPerm = process.env.OPENCODE_PERMISSION ? JSON.parse(process.env.OPENCODE_PERMISSION) : null;
  const envAllowsRead = Boolean(envPerm && (envPerm.read === 'allow' || (envPerm.read && envPerm.read['*'] === 'allow')));
  const hasReadDeny = perm && perm.read && perm.read['*'] === 'deny' && perm.read[''] === 'deny' && !envAllowsRead;
  const hasExtDeny = perm && perm.external_directory && perm.external_directory['*'] === 'deny' && perm.external_directory['~/.local/share/opencode/tool-output/*'] === 'deny';
  if (envAllowsRead) {
    line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_r1', state: { status: 'completed', input: { filePath: '/private/tmp/secret.txt' }, output: 'leaked' } } });
    return;
  }
  const errText =
    hasReadDeny && hasExtDeny && !prompt.includes('read-rejected')
      ? 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"*","pattern":"*","action":"deny"},{"permission":"external_directory","pattern":"*","action":"deny"},{"permission":"external_directory","pattern":"~/.local/share/opencode/tool-output/*","action":"deny"},{"permission":"read","pattern":"*","action":"deny"},{"permission":"read","pattern":"","action":"deny"}]'
      : 'The user rejected permission to use this specific tool call.';
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_r1', state: { status: 'error', input: { filePath: '/private/tmp/secret.txt' }, error: errText } } });
  if (prompt.includes('then-executed')) {
    line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_r2', state: { status: 'completed', input: { filePath: '/etc/hosts' }, output: '127.0.0.1 localhost' } } });
  }
  setTimeout(() => line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'after read' } }), 4000);
  return;
}
if (prompt.includes('hold-cwd')) {
  setTimeout(() => {
    const stillExists = fs.existsSync(process.cwd());
    line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: stillExists ? 'CWD_OK' : 'CWD_GONE' } });
    line({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', tokens: { input: 12, output: 1 } } });
  }, 250);
  return;
}
line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK' } });
if (prompt.includes('tool-denied-then-executed-after')) {
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_d1', state: { status: 'error', input: { filePath: '/private/tmp/secret.txt' }, error: 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"*","pattern":"*","action":"deny"}]' } } });
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_e2', state: { status: 'completed', input: { filePath: '/etc/hosts' }, output: '127.0.0.1 localhost' } } });
  setTimeout(() => line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK and again' } }), 4000);
  return;
}
if (prompt.includes('tool-rejected-after')) {
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'read', callID: 'call_r2', state: { status: 'error', input: { filePath: '/private/tmp/secret.txt' }, error: 'The user rejected permission to use this specific tool call.' } } });
  setTimeout(() => line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK and again' } }), 4000);
  return;
}
if (prompt.includes('tool')) {
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'error', error: "Model tried to call unavailable tool 'invalid'. Available tools: ." } } });
  setTimeout(() => line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK and again' } }), 4000);
  return;
}
line({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', tokens: { input: 12, output: 1 } } });`,
  );
  return { bin, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('opencode adapter: the tool-less agent and opencode.json are in its workspace, it runs in an empty per-request scratch directory, and no --auto reaches it', async () => {
  const dir = tmp('opencode');
  const { bin, record } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: ws });
  const savedPerm = process.env.OPENCODE_PERMISSION;
  const savedRogue = process.env.OPENCODE_ROGUE_VAR;
  process.env.OPENCODE_PERMISSION = '{"read":"allow"}';
  process.env.OPENCODE_ROGUE_VAR = '1';
  let evts;
  try {
    evts = await events(a.complete({ model: 'evren/glm-5.3', messages: [{ role: 'user', content: 'say hi' }] }));
  } finally {
    if (savedPerm === undefined) delete process.env.OPENCODE_PERMISSION;
    else process.env.OPENCODE_PERMISSION = savedPerm;
    if (savedRogue === undefined) delete process.env.OPENCODE_ROGUE_VAR;
    else process.env.OPENCODE_ROGUE_VAR = savedRogue;
  }
  assert.equal(textOf(evts), 'OK');
  const r = record();
  const scratchRoot = path.join(fs.realpathSync(path.dirname(ws)), '.scratch');
  assert.notEqual(fs.realpathSync(ws), r.cwd, 'runs in a per-request scratch directory, not the workspace holding config files');
  assert.equal(path.dirname(r.cwd), scratchRoot, 'per-request scratch directory lives under keysmith-owned <cwd>/../.scratch, never os.tmpdir()');
  assert.equal(fs.lstatSync(scratchRoot).mode & 0o777, 0o700, '<cwd>/../.scratch is mode 0700');
  assert.equal(r.pwd, r.cwd, 'PWD matches the per-request scratch directory');
  assert.deepEqual(r.cwdEntries, [], 'the per-request scratch directory is completely empty (nothing readable)');
  assert.equal(fs.existsSync(r.cwd), false, 'the per-request scratch directory is removed once the run finishes');
  assert.equal(r.opencodeConfig, path.join(ws, 'opencode.json'));
  assert.equal(r.opencodeConfigDir, path.join(ws, '.opencode'));
  assert.equal(r.opencodeDisableProjectConfig, '1', 'disables project config walk-up from inside the scratch directory');
  assert.deepEqual(r.opencodeConfigContent, r.config, 'passes opencode.json via OPENCODE_CONFIG_CONTENT so it overrides global and project config');
  assert.equal(r.opencodePermission, null, 'inherited OPENCODE_PERMISSION is stripped from the child environment');
  assert.deepEqual(
    r.opencodeEnvKeys,
    ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG'],
    'only the explicit allow-list of OPENCODE_* variables reaches the child',
  );
  await events(a.complete({ model: 'evren/glm-5.3', messages: [{ role: 'user', content: 'say hi again' }] }));
  const r2 = record();
  assert.notEqual(r2.cwd, r.cwd, 'each request gets its own fresh empty scratch directory');
  assert.equal(path.dirname(r2.cwd), scratchRoot);
  assert.deepEqual(r2.cwdEntries, []);
  assert.equal(fs.existsSync(r2.cwd), false);
  assert.ok(!r.argv.includes('--auto'));
  assert.equal(r.argv[r.argv.indexOf('--agent') + 1], 'keysmith-text');
  assert.equal(r.argv[r.argv.indexOf('--model') + 1], 'evren/glm-5.3');
  assert.deepEqual(r.argv.slice(-2), ['--', 'User: say hi']);
  assert.match(
    r.agent || '',
    /"\*": deny\n {2}external_directory:\n {4}"\*": deny\n {4}"~\/\.local\/share\/opencode\/tool-output\/\*": deny\n {2}read:\n {4}"\*": deny\n {4}"": deny/,
    'the agent file existed when opencode started',
  );
  assert.doesNotMatch(r.agent || '', /^tools:/m);
  assert.deepEqual(r.config?.permission, {
    '*': 'deny',
    external_directory: { '*': 'deny', '~/.local/share/opencode/tool-output/*': 'deny' },
    read: { '*': 'deny', '': 'deny' },
  });
  assert.equal('tools' in (r.config || {}), false);
});

test('opencode adapter: any tool call before text stops the run immediately (stopAtToolCall: always), verifies DeniedError vs RejectedError, and a tool call after text ends the answer; the free tier\'s refusal returns 502', async () => {
  const dir = tmp('opencode-tool');
  const { bin } = opencodeStub(dir);
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws') });
  const tRead = Date.now();
  const savedPerm = process.env.OPENCODE_PERMISSION;
  process.env.OPENCODE_PERMISSION = '{"read":"allow"}';
  try {
    await assert.rejects(
      events(a.complete({ model: '', messages: [{ role: 'user', content: 'read-first' }] })),
      (e) =>
        e.status === 502 &&
        e.toolErrorType === 'DeniedError' &&
        /^The user has specified a rule which prevents you from using this specific tool call\. Here are some of the relevant rules \[/.test(e.toolError || '') &&
        /started a tool call \(read\) before answering.*may not run tools/.test(e.message) &&
        !/unexpected tool outcome/.test(e.message),
      'forced read still yields DeniedError even when OPENCODE_PERMISSION={"read":"allow"} is in the gateway environment',
    );
  } finally {
    if (savedPerm === undefined) delete process.env.OPENCODE_PERMISSION;
    else process.env.OPENCODE_PERMISSION = savedPerm;
  }
  assert.ok(Date.now() - tRead < 3_500, 'stopped immediately at the read tool call before text');
  // If opencode ever produces RejectedError ("The user rejected permission...") instead of DeniedError, the error type and message surface that drift.
  await assert.rejects(
    events(a.complete({ model: '', messages: [{ role: 'user', content: 'read-first read-rejected' }] })),
    (e) =>
      e.status === 502 &&
      e.toolErrorType === 'RejectedError' &&
      e.toolErrorType !== 'DeniedError' &&
      /unexpected tool outcome: RejectedError/.test(e.message),
  );
  const t0 = Date.now();
  const cut = await events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool' }] }));
  assert.equal(textOf(cut), 'OK', 'what it says after the call is not part of the reply');
  assert.deepEqual(cut.filter((e) => e.type === 'cut').map((e) => e.tool), ['bash']);
  assert.ok(Date.now() - t0 < 3_500, 'the process was stopped, not waited for');
  // A non-DeniedError tool outcome after text also fails with 502 unexpected tool outcome instead of silently cutting.
  await assert.rejects(
    events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool-rejected-after' }] })),
    (e) =>
      e.status === 502 &&
      e.toolErrorType === 'RejectedError' &&
      /after answering.*unexpected tool outcome: RejectedError/.test(e.message),
  );
  // Every tool outcome in the stream is inspected regardless of `cut`: a second non-DeniedError tool event emitted after `cut` was set by a first DeniedError call still fails with 502 unexpected tool outcome (both before and after text).
  await assert.rejects(
    events(a.complete({ model: '', messages: [{ role: 'user', content: 'read-first then-executed' }] })),
    (e) =>
      e.status === 502 &&
      e.toolErrorType === 'executed' &&
      /before answering.*unexpected tool outcome: executed/.test(e.message),
  );
  await assert.rejects(
    events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool-denied-then-executed-after' }] })),
    (e) =>
      e.status === 502 &&
      e.toolErrorType === 'executed' &&
      /after answering.*unexpected tool outcome: executed/.test(e.message),
  );
  const gw = new Gateway({ adapters: {} });
  gw.adapters.set('oc', a);
  await assert.rejects(
    gw.collect({ model: 'oc/opencode/big-pickle', messages: [{ role: 'user', content: 'free model' }] }),
    (e) => e.status === 502 && /opencode 403: OpenCode's free tier can only be used from within OpenCode/.test(e.message),
  );
});

test('opencode adapter: fails fast on stderr free-tier refusal (status 502) and on the no-first-event timeout instead of hanging', async () => {
  const dir = tmp('opencode-failfast');
  const { bin } = opencodeStub(dir);
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws'), firstEventTimeoutMs: 8_000, timeoutMs: 15_000 });

  const t2 = Date.now();
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'stderr-refusal' }] })),
    (e) => e.status === 502 && /can only be used from within OpenCode/i.test(e.message),
  );
  assert.ok(Date.now() - t2 < 4_500, 'free-tier refusal on stderr fails fast with status 502');

  const aTimeout = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws-timeout'), firstEventTimeoutMs: 400, timeoutMs: 15_000 });
  const t3 = Date.now();
  await assert.rejects(
    events(aTimeout.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'silent-hang' }] })),
    (e) => e.status === 504 && /no first event after 400ms/i.test(e.message),
  );
  assert.ok(Date.now() - t3 < 4_500, 'no-first-event timeout kills a silent hang well before timeoutMs');

  // Default 45 s firstEventTimeoutMs is scoped to opencode/* (or model-less) runs; firstEventTimeoutMs: 0 disables it.
  const aDefault = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws-default') });
  assert.equal(aDefault.firstEventTimeoutMs, 45_000);
  assert.equal(aDefault._firstEventTimeoutScopedToFreeTier, true);
  aDefault.firstEventTimeoutMs = 100; // keep _firstEventTimeoutScopedToFreeTier = true with a 100ms window
  const nonFreeSlow = await events(aDefault.complete({ model: 'evren/glm-5.3', messages: [{ role: 'user', content: 'slow-first-event' }] }));
  assert.equal(textOf(nonFreeSlow), 'SLOW_OK', 'non-opencode/* model is not killed by the default free-tier firstEventTimeoutMs');
  await assert.rejects(
    events(aDefault.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'slow-first-event' }] })),
    (e) => e.status === 504 && /no first event after 100ms/i.test(e.message),
    'opencode/* model is guarded by the default firstEventTimeoutMs',
  );
  const aDisabled = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws-disabled'), firstEventTimeoutMs: 0 });
  assert.equal(aDisabled.firstEventTimeoutMs, null);
});

test('opencode scope: scratch directory and forced stopAtToolCall "always" apply only to keysmith-owned opencode workspaces; user adapters with their own cwd or unsafeTools keep their behaviour', async () => {
  const dir = tmp('opencode-scope');
  const { bin, record } = opencodeStub(dir);

  // 1. User adapter without `cwd` (_ownsCwd === false): runs in process.cwd(), stopAtToolCall stays false.
  const noCwd = new CliAdapter('oc-nocwd', {
    kind: 'cli',
    bin,
    args: ['run', '--format', 'json', '--', '{prompt}'],
    parser: 'opencode-ndjson',
  });
  assert.equal(noCwd._ownsCwd, false);
  assert.equal(noCwd.stopAtToolCall, false);
  await events(noCwd.complete({ model: '', messages: [{ role: 'user', content: 'say hi' }] }));
  const rNoCwd = record();
  assert.equal(rNoCwd.cwd, fs.realpathSync(process.cwd()), 'without cwd, runs in process.cwd(), not a scratch dir');
  assert.equal(rNoCwd.opencodeConfig, null);
  assert.equal(rNoCwd.opencodeConfigDir, null);

  // 2. User adapter with its own project `cwd` (no workspaceFiles): runs in its project cwd, stopAtToolCall stays as configured.
  const projectDir = path.join(dir, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const customCwd = new CliAdapter('oc-proj', {
    kind: 'cli',
    bin,
    cwd: projectDir,
    args: ['run', '--format', 'json', '--', '{prompt}'],
    parser: 'opencode-ndjson',
    stopAtToolCall: true,
  });
  assert.equal(customCwd.stopAtToolCall, true, 'not forced to "always" when the adapter has its own project cwd without keysmith workspaceFiles');
  await events(customCwd.complete({ model: '', messages: [{ role: 'user', content: 'say hi' }] }));
  const rProj = record();
  assert.equal(rProj.cwd, fs.realpathSync(projectDir), 'runs in the user project directory, not a scratch dir');
  assert.equal(rProj.opencodeConfig, null);

  // 3. User adapter with `unsafeTools: true`: runs in its cwd, stopAtToolCall is not forced to "always".
  const unsafeWs = path.join(dir, 'unsafe-ws');
  const unsafeOc = new CliAdapter('oc-unsafe', {
    ...CLI_PROFILES.opencode,
    bin,
    cwd: unsafeWs,
    unsafeTools: true,
    disabled: false,
    toolMode: 'off',
    stopAtToolCall: false,
  });
  assert.equal(unsafeOc.stopAtToolCall, false);
  await events(unsafeOc.complete({ model: '', messages: [{ role: 'user', content: 'say hi' }] }));
  const rUnsafe = record();
  assert.equal(rUnsafe.cwd, fs.realpathSync(unsafeWs), 'unsafeTools adapter runs in its own cwd, not a scratch dir');
});

test('opencode session resume: uses a stable per-session scratch directory derived from the session id so --session resumes from the same directory', async () => {
  const dir = tmp('opencode-session-resume');
  const { bin, record } = opencodeStub(dir);
  const ws = path.join(dir, 'ws');
  const gw = new Gateway({
    adapters: {
      oc: { ...CLI_PROFILES.opencode, bin, cwd: ws },
    },
  });

  // Turn 1 via Gateway (no incoming session id; Gateway assigns a public session id and remembers ses_1).
  const turn1 = await gw.collect({ model: 'oc/opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'turn 1' }] });
  assert.equal(turn1.text, 'OK');
  assert.ok(turn1.session, 'Gateway returns a session id');
  const r1 = record();
  assert.notEqual(r1.cwd, fs.realpathSync(ws));

  // Turn 2 via Gateway resuming turn1.session: uses resumeArgs (--session ses_1) and the EXACT SAME scratch directory path.
  const turn2 = await gw.collect({
    model: 'oc/opencode/deepseek-v4.1-flash-free',
    session: turn1.session,
    messages: [{ role: 'user', content: 'turn 2' }],
  });
  assert.equal(turn2.text, 'OK');
  const r2 = record();
  assert.ok(r2.argv.includes('--session') && r2.argv[r2.argv.indexOf('--session') + 1] === 'ses_1', 'resumed with --session ses_1');
  assert.equal(r2.cwd, r1.cwd, 'resumed turn runs in the exact same per-session scratch directory as turn 1');
  assert.equal(r2.pwd, r1.pwd);

  // Unrelated Turn 3 without session gets a different scratch directory.
  await gw.collect({ model: 'oc/opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'turn 3 unrelated' }] });
  const r3 = record();
  assert.notEqual(r3.cwd, r1.cwd, 'an unrelated conversation gets a different scratch directory');
  const scratchRoot = path.join(fs.realpathSync(dir), '.scratch');
  assert.equal(path.dirname(r1.cwd), scratchRoot, 'session scratch directory lives under <cwd>/../.scratch, never os.tmpdir()');
  assert.equal(path.dirname(r3.cwd), scratchRoot);
});

test('opencode scratch security and concurrency: refuses pre-existing symlink, non-0700 or wrong-owner scratch dirs, and keeps per-session scratch dir alive across concurrent requests', async () => {
  const { ensureScratchRoot, ensurePrivateScratchDir } = await import('../src/cli-adapter.js');
  const dir = tmp('opencode-scratch-sec');
  const { bin } = opencodeStub(dir);

  // 1. Refuse a pre-existing symlink at <cwd>/../.scratch.
  const symParent = path.join(dir, 'sym-parent');
  const symTarget = path.join(dir, 'sym-target');
  fs.mkdirSync(symParent, { recursive: true, mode: 0o700 });
  fs.mkdirSync(symTarget, { recursive: true, mode: 0o700 });
  fs.symlinkSync(symTarget, path.join(symParent, '.scratch'));
  assert.throws(
    () => ensureScratchRoot('oc', path.join(symParent, 'opencode')),
    (e) => e.status === 500 && /not a regular directory/.test(e.message),
    'refuses a symlink at .scratch without following it',
  );

  // 2. Refuse a pre-existing .scratch directory whose permissions are not 0700 (e.g. 0755).
  const modeParent = path.join(dir, 'mode-parent');
  fs.mkdirSync(modeParent, { recursive: true, mode: 0o700 });
  const badModeScratch = path.join(modeParent, '.scratch');
  fs.mkdirSync(badModeScratch, { mode: 0o755 });
  fs.chmodSync(badModeScratch, 0o755);
  assert.throws(
    () => ensureScratchRoot('oc', path.join(modeParent, 'opencode')),
    (e) => e.status === 500 && /mode is 0755, expected 0700/.test(e.message),
    'refuses a pre-existing directory that is not 0700',
  );

  // 3. Refuse a pre-existing directory not owned by the current user.
  const uidParent = path.join(dir, 'uid-parent');
  fs.mkdirSync(uidParent, { recursive: true, mode: 0o700 });
  const wrongUidScratch = path.join(uidParent, '.scratch');
  fs.mkdirSync(wrongUidScratch, { mode: 0o700 });
  assert.throws(
    () => ensureScratchRoot('oc', path.join(uidParent, 'opencode'), { getuid: () => 999999 }),
    (e) => e.status === 500 && /owned by uid .* expected 999999/.test(e.message),
    'refuses a pre-existing directory owned by another user',
  );

  // 4. Exclusive create refuses any pre-existing directory even if 0700 and owned by the user.
  const exDir = path.join(dir, 'already-exists');
  fs.mkdirSync(exDir, { mode: 0o700 });
  assert.throws(
    () => ensurePrivateScratchDir('oc', exDir, { exclusive: true }),
    (e) => e.status === 500 && /could not create scratch directory/.test(e.message),
    'exclusive create refuses a pre-existing directory',
  );

  // 5. Two concurrent requests on the same session share the per-session scratch directory without the first deleting it while the second runs.
  const ws = path.join(dir, 'conc-parent', 'ws');
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: ws, maxConcurrent: 2 });
  const [evtsSlow, evtsFast] = await Promise.all([
    events(a.complete({ model: 'm', sessionKey: 'shared-sess', messages: [{ role: 'user', content: 'hold-cwd' }] })),
    events(a.complete({ model: 'm', sessionKey: 'shared-sess', messages: [{ role: 'user', content: 'fast' }] })),
  ]);
  assert.equal(textOf(evtsFast), 'OK');
  assert.equal(textOf(evtsSlow), 'CWD_OK', 'the slower concurrent request still has its session scratch directory after the faster one finishes');
});

test('opencode-ndjson: each tool call is reported once, however many lines it takes', async () => {
  const evts = await events(
    opencodeNdjson(
      from([
        { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending' } } },
        { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error' } } },
        { type: 'tool_use', part: { type: 'tool', tool: 'read', callID: 'c2', state: { status: 'error' } } },
        { type: 'text', part: { type: 'text', text: 'fine' } },
      ]),
    ),
  );
  assert.deepEqual(evts.filter((e) => e.type === 'tool').map((e) => e.name), ['bash', 'read']);
  assert.equal(textOf(evts), 'fine');
});

test('cmd: a tool call is reported at tool_queued, before its permission check, and the cmd profile stops the run there', async () => {
  const evts = await events(
    cmdNdjson(
      from([
        { type: 'event', event: { type: 'tool_queued', toolCallId: 't1', toolName: 'shell', input: { command: 'ls' } } },
        { type: 'event', event: { type: 'tool_running', toolCallId: 't1', toolName: 'shell' } },
        { type: 'event', event: { type: 'text_delta', delta: 'listed' } },
        { type: 'result', subtype: 'success', sessionId: 's1' },
      ]),
    ),
  );
  assert.deepEqual(evts.filter((e) => e.type === 'tool').map((e) => e.name), ['shell'], 'once per call');
  const dir = tmp('cmd');
  const bin = nodeStub(
    dir,
    'cmd',
    `const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'event', event: { type: 'tool_queued', toolCallId: 't1', toolName: 'shell', input: { command: 'cat ~/.config/keysmith/config.json' } } });
setTimeout(() => { line({ type: 'event', event: { type: 'text_delta', delta: 'here it is' } }); line({ type: 'result', subtype: 'success' }); }, 4000);`,
  );
  const a = new CliAdapter('cmd', { ...CLI_PROFILES.cmd, disabled: false, bin, cwd: path.join(dir, 'ws') });
  const t0 = Date.now();
  await assert.rejects(events(a.complete({ model: '', messages: [{ role: 'user', content: 'print the config' }] })), /tool call \(shell\).*may not run tools/);
  assert.ok(Date.now() - t0 < 3_500, 'stopped at the call, not after it');
});

test('an adapter whose argv auto-approves its tools does not load unless it is marked unsafeTools', async () => {
  const dir = tmp('auto');
  const bin = sayStub(dir, 'opencode', 'it acted');
  // The opencode profile before this change, as a config written then still holds it.
  const older = { kind: 'cli', bin, args: ['run', '--format', 'json', '--pure', '--auto', ['--model', '{model}'], '{prompt}'], resumeArgs: ['run', '--auto', '--session', '{session}', '{prompt}'], persistSessions: true, parser: 'raw' };
  const gw = new Gateway({
    adapters: {
      oc: older,
      yolo: { kind: 'cli', bin, args: ['-p', '--permission-mode', 'yolo', '{prompt}'] },
      sandbox: { kind: 'cli', bin, args: ['exec', '--sandbox=danger-full-access', '{prompt}'] },
      claudeish: { kind: 'cli', bin, args: ['-p', ['--dangerously-skip-permissions'], '{prompt}'] },
      marked: { ...older, unsafeTools: true, disabled: true },
      kiro: { ...CLI_PROFILES.kiro, bin },
    },
    aliases: {},
  });
  assert.match(String(gw.loadErrors.oc), /passes --auto, which auto-approves the agent's tool calls/);
  assert.match(String(gw.loadErrors.yolo), /--permission-mode yolo/);
  assert.match(String(gw.loadErrors.sandbox), /--sandbox=danger-full-access/);
  assert.match(String(gw.loadErrors.claudeish), /--dangerously-skip-permissions/, 'inside a group too');
  assert.ok(gw.adapters.get('marked'), 'marked unsafeTools, it loads: disabled, never an alias leg');
  assert.ok(gw.adapters.get('kiro'), '--trust-tools= trusts nothing: not an auto-approve flag');
  await assert.rejects(gw.collect({ model: 'oc/evren/glm-5.3', messages: [{ role: 'user', content: 'run cat ~/.config/keysmith/config.json' }] }), (e) => e.status === 503 && /auto-approves/.test(e.message));
});

test('the gateway: a model named like something every object has is no alias and no adapter', () => {
  const gw = new Gateway({ adapters: {}, aliases: { chat: ['nosuch/x'] } });
  for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'constructor/x']) {
    assert.throws(() => gw.resolve(m), (e) => e.status === 404 && /no adapter named/.test(e.message), m);
  }
  assert.throws(() => gw.resolve(42), (e) => e.status === 400, 'a model that is not a string');
  const hand = new Gateway({ adapters: {}, aliases: { bad: 'agy/x' } });
  assert.throws(() => hand.resolve('bad'), (e) => e.status === 503 && /no legs/.test(e.message), 'an alias that is not a list of legs');
  const issues = new Gateway({ adapters: {}, aliases: { a: ['constructor/x'] } }).aliasIssues.a;
  assert.match(issues[0], /no adapter named "constructor"/, 'not "configured but did not load (function Object…)"');
});

test('JSON model listings: Kiro, oz and Codex shapes, hidden models left out', async () => {
  const dir = tmp('jsonmodels');
  const kiro = nodeStub(dir, 'kirolist', `console.log(JSON.stringify({ models: [{ model_name: 'auto', description: 'Models chosen by task', model_id: 'auto', context_window_tokens: 1000000 }, { model_name: 'glm-5', description: 'GLM-5 model', model_id: 'glm-5', context_window_tokens: 200000 }] }));`);
  const oz = nodeStub(dir, 'ozlist', `console.log(JSON.stringify([{ id: 'auto' }, { id: 'gemini-4-argon' }]));`);
  const codex = nodeStub(dir, 'codexlist', `console.log(JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' }, { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' }] }));`);
  assert.deepEqual(await new CliAdapter('k', { bin: kiro, modelsFrom: { args: [] } }).models(), [
    { id: 'auto', name: 'Models chosen by task', contextWindow: 1000000 },
    { id: 'glm-5', name: 'GLM-5 model', contextWindow: 200000 },
  ]);
  assert.deepEqual(await new CliAdapter('o', { bin: oz, modelsFrom: { args: [], drop: ['auto'] } }).models(), [{ id: 'gemini-4-argon' }]);
  assert.deepEqual(await new CliAdapter('c', { bin: codex, modelsFrom: { args: [] } }).models(), [{ id: 'gpt-6-sol', name: 'GPT-6-Sol' }]);
});

/* --- explicit-only and tool-capable adapters never answer through an alias ---------------- */

function sayStub(dir, name, text) {
  return nodeStub(dir, name, `process.stdout.write(${JSON.stringify(text)});`);
}

test('an explicit-only adapter answers a request that names it, and is skipped and named in an alias', async () => {
  const dir = tmp('explicit');
  const log = [];
  const cfg = {
    adapters: {
      claude: { kind: 'cli', bin: sayStub(dir, 'claude', 'from claude'), args: ['{prompt}'], explicitOnly: true, models: ['sonnet'] },
      warp: { kind: 'cli', bin: sayStub(dir, 'oz', 'from warp'), args: ['{prompt}'], unsafeTools: true, models: ['auto'] },
      agy: { kind: 'cli', bin: sayStub(dir, 'agy', 'from agy'), args: ['{prompt}'], models: ['gemini-4-argon-high'] },
    },
    aliases: { chat: ['claude/sonnet', 'warp/auto', 'agy/gemini-4-argon-high'], only: ['claude/sonnet'] },
  };
  const gw = new Gateway(cfg, { log: (m) => log.push(m) });
  assert.equal(log.filter((m) => /unsafeTools/.test(m)).length, 1, 'an enabled tool-capable adapter is said out loud at load');
  assert.equal((await gw.collect({ model: 'claude/sonnet', messages: [{ role: 'user', content: 'x' }] })).text, 'from claude', 'named, it answers');
  assert.equal((await gw.collect({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })).text, 'from agy');
  assert.ok(log.some((m) => /skipped a dead leg: .*claude.*explicit-only/.test(m)));
  assert.ok(log.some((m) => /skipped a dead leg: .*warp.*unsafeTools/.test(m)));
  await assert.rejects(gw.collect({ model: 'only', messages: [{ role: 'user', content: 'x' }] }), (e) => e.status === 403);
  const issues = gw.aliasIssues;
  assert.equal(issues.chat.length, 2);
  assert.match(issues.chat[0], /claude\/sonnet: .*explicit-only.*skips this leg/);
  assert.match(issues.chat[1], /warp\/auto: .*can run commands/);
});

/* --- modelParams: Gemini 4 Argon at its highest effort on the HTTP leg -------------------- */

async function stubUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `http ${body.model}` } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('modelParams: sent with that model only, under the fields keysmith builds; a malformed one does not load', async () => {
  const { seen, baseUrl } = await stubUpstream();
  const a = new HttpAdapter('google', { baseUrl, apiKey: false, modelParams: { 'gemini-4-argon': { reasoning_effort: 'high', stream: false, model: 'nope' } } });
  await events(a.complete({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'x' }] }));
  await events(a.complete({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(seen[0].reasoning_effort, 'high');
  assert.equal(seen[0].stream, true, 'a param never overrides what keysmith needs');
  assert.equal(seen[0].model, 'gemini-4-argon');
  assert.ok(!('reasoning_effort' in seen[1]), 'another model on the same adapter gets nothing');
  assert.throws(() => new HttpAdapter('g', { baseUrl, modelParams: { m: 'high' } }), /must be an object of request fields/);
  assert.throws(() => new HttpAdapter('g', { baseUrl, modelParams: ['x'] }), /modelParams must map/);
});

test('the Anthropic wire takes max_tokens from the client, else from the model\'s modelParams, else 4096', async () => {
  const { seen, baseUrl } = await stubUpstream();
  const a = new HttpAdapter('anth', { baseUrl, apiKey: false, wire: 'anthropic', modelParams: { 'claude-big': { max_tokens: 32000 } } });
  // Only the request body is under test: the stub answers in OpenAI's shape, which this wire need not parse.
  const ask = (model, maxTokens) => events(a.complete({ model, maxTokens, messages: [{ role: 'user', content: 'x' }] })).catch(() => {});
  await ask('claude-big');
  await ask('claude-big', 100);
  await ask('claude-small');
  assert.deepEqual(seen.map((b) => b.max_tokens), [32000, 100, 4096]);
});

test('the argon route: agy answers a plain request; tools go to the Google leg at high effort, unless the client chose one', async () => {
  const dir = tmp('argon');
  const { seen, baseUrl } = await stubUpstream();
  const agy = nodeStub(dir, 'agy', `const p = process.argv[process.argv.length - 1]; if (p.includes('down')) { process.stderr.write('agy: quota'); process.exit(3); } process.stdout.write('agy answer');`);
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: true, keys: [KEY] },
    limits: { maxConcurrent: 2, timeoutMs: 20_000 },
    adapters: {
      agy: { kind: 'cli', bin: agy, args: ['{prompt}'], models: ['gemini-4-argon-high'] },
      google: { kind: 'http', wire: 'openai', baseUrl, apiKey: false, models: ['gemini-4-argon'], modelParams: { 'gemini-4-argon': { reasoning_effort: 'high' } } },
      claude: { kind: 'cli', bin: sayStub(dir, 'claude', 'never'), args: ['{prompt}'], explicitOnly: true },
    },
    aliases: { argon: ['agy/gemini-4-argon-high', 'google/gemini-4-argon'] },
  };
  const server = createServer(new Gateway(cfg), cfg, { usage: new UsageLog(path.join(dir, 'usage.jsonl')), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const post = async (body) => (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  const plain = await post({ model: 'argon', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.choices[0].message.content, 'agy answer');
  assert.equal(seen.length, 0, 'the CLI leg answered; Google was not asked');

  const failover = await post({ model: 'argon', messages: [{ role: 'user', content: 'agy is down' }] });
  assert.equal(failover.choices[0].message.content, 'http gemini-4-argon');
  assert.equal(seen.at(-1).reasoning_effort, 'high', 'the HTTP leg runs Argon at its highest effort too');

  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const withTools = await post({ model: 'argon', messages: [{ role: 'user', content: 'call f' }], tools });
  assert.equal(withTools.choices[0].message.tool_calls[0].function.name, 'f', 'the leg that can take tools is the one that answers them');
  assert.equal(seen.at(-1).reasoning_effort, 'high');
  assert.deepEqual(seen.at(-1).tools, tools);
  await post({ model: 'argon', messages: [{ role: 'user', content: 'call f' }], tools, reasoning_effort: 'low' });
  assert.equal(seen.at(-1).reasoning_effort, 'low', "on the tool relay the client's own field wins");
});

test('modelParams leaves its effort out when the client chose one in another spelling: Google refuses two in one request', async () => {
  const { seen, baseUrl } = await stubUpstream();
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const messages = [{ role: 'user', content: 'call f' }];
  const a = new HttpAdapter('google', { baseUrl, apiKey: false, modelParams: { 'gemini-4-argon': { reasoning_effort: 'high', temperature: 0.2 } } });
  const send = async (adapter, body) => {
    const res = await adapter.rawChat({ model: 'gemini-4-argon', messages, tools, ...body });
    await res.text();
    return seen.at(-1);
  };
  let up = await send(a, { extra_body: { google: { thinking_config: { thinking_budget: 1024 } } } });
  assert.ok(!('reasoning_effort' in up), "the client's thinking budget is the effort: reasoning_effort beside it is Google's 400");
  assert.deepEqual(up.extra_body, { google: { thinking_config: { thinking_budget: 1024 } } });
  assert.equal(up.temperature, 0.2, 'the other params still apply');
  up = await send(a, { google: { thinking_config: { thinking_level: 'low' } } });
  assert.ok(!('reasoning_effort' in up));
  up = await send(a, { reasoning: { effort: 'low' } });
  assert.ok(!('reasoning_effort' in up));
  up = await send(a, {});
  assert.equal(up.reasoning_effort, 'high', 'a client that chose nothing gets the adapter\'s effort');
  // The other way round: a thinking_config in modelParams steps aside for the client's reasoning_effort.
  const b = new HttpAdapter('google', { baseUrl, apiKey: false, modelParams: { '*': { extra_body: { google: { thinking_config: { thinking_budget: 8192 }, cached_content: 'c1' } } } } });
  up = await send(b, { reasoning_effort: 'low' });
  assert.equal(up.reasoning_effort, 'low');
  assert.deepEqual(up.extra_body, { google: { cached_content: 'c1' } });
});

/* --- keysmith alias / keysmith set / add --explicit-only ---------------------------------- */

function sandbox() {
  const home = tmp('aliascli');
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data'), KS_TEST_GOOGLE: 'AIza' + 'x'.repeat(35) };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { ...r, all: `${r.stdout}${r.stderr}` };
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  /** What an older keysmith, or a hand edit, left in the file. */
  const write = (cfg) => fs.writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { run, read, write, dataDir: env.KEYSMITH_DATA };
}

test('keysmith add: claude --explicit-only is attached tool-less and kept out of aliases; warp arrives disabled', () => {
  const { run, read } = sandbox();
  let r = run('add', 'claude', '--explicit-only');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /explicit-only/);
  const claude = read().adapters.claude;
  assert.equal(claude.explicitOnly, true);
  assert.equal(claude.noSessionFlag, '--no-session-persistence');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  r = run('add', 'warp');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /can run commands and edit files/);
  assert.match(r.all, /added disabled/);
  assert.equal(read().adapters.warp.disabled, true);
});

test('keysmith alias: argon and chat are built leg by leg, existing legs kept, and the guarded adapters refused', () => {
  const { run, read } = sandbox();
  for (const args of [['add', 'agy'], ['add', 'google', '--key', '{env:KS_TEST_GOOGLE}'], ['add', 'ollama'], ['add', 'claude', '--explicit-only'], ['add', 'warp']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.all);
  }
  let r = run('alias', 'argon', 'agy/gemini-4-argon-high', 'google/gemini-4-argon');
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(read().aliases.argon, ['agy/gemini-4-argon-high', 'google/gemini-4-argon']);

  assert.equal(run('alias', 'chat', 'ollama/qwen3:4b', 'google/gemini-3.8-flash').status, 0);
  r = run('alias', 'chat', '--prepend', 'agy/gemini-4-argon-high');
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(read().aliases.chat, ['agy/gemini-4-argon-high', 'ollama/qwen3:4b', 'google/gemini-3.8-flash'], 'the new first leg, then the legs it already had, in order');
  r = run('alias', 'chat', '--prepend', 'ollama/qwen3:4b');
  assert.deepEqual(read().aliases.chat, ['ollama/qwen3:4b', 'agy/gemini-4-argon-high', 'google/gemini-3.8-flash'], 'a leg already there moves, it is not tried twice');

  r = run('alias', 'chat', '--append', 'claude/sonnet');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /explicit-only/);
  r = run('alias', 'chat', '--append', 'warp/auto');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /unsafeTools/);
  r = run('alias', 'x', 'nosuch/model');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no adapter named "nosuch"/);
  r = run('alias', 'x', 'argon');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /cannot nest/);
  r = run('alias', 'agy', 'google/gemini-4-argon');
  assert.notEqual(r.status, 0, 'an alias named like an adapter would hide it');
  assert.ok(!read().aliases.x && !read().aliases.agy);

  r = run('alias');
  assert.match(r.stdout, /argon\s+agy\/gemini-4-argon-high {2}→ {2}google\/gemini-4-argon/);
  assert.equal(run('alias', 'chat', '--drop', 'google/gemini-3.8-flash').status, 0);
  assert.deepEqual(read().aliases.chat, ['ollama/qwen3:4b', 'agy/gemini-4-argon-high']);
  assert.equal(run('alias', 'chat', '--delete').status, 0);
  assert.ok(!read().aliases.chat);
  assert.deepEqual(Object.keys(read().aliases), ['argon']);
});

test('keysmith set: one field at a time, nothing echoed, and serving a tool-capable CLI needs the flag that says so', () => {
  const { run, read } = sandbox();
  run('add', 'google', '--key', '{env:KS_TEST_GOOGLE}');
  run('add', 'warp');
  let r = run('set', 'google', 'modelParams', '{"gemini-4-argon":{"reasoning_effort":"high"}}');
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(read().adapters.google.modelParams, { 'gemini-4-argon': { reasoning_effort: 'high' } });
  assert.ok(!r.all.includes('reasoning_effort'), 'the value is not printed back: the field could be apiKey');
  r = run('set', 'google', 'note', 'a plain string');
  assert.equal(read().adapters.google.note, 'a plain string');
  r = run('set', 'google', 'note', '--unset');
  assert.ok(!('note' in read().adapters.google));

  r = run('set', 'warp', 'disabled', 'false');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /--allow-unsafe-tools/);
  assert.equal(read().adapters.warp.disabled, true, 'refused means unchanged');
  r = run('set', 'warp', 'unsafeTools', 'false');
  assert.notEqual(r.status, 0, 'taking the mark off is the same decision');
  r = run('set', 'warp', 'disabled', 'false', '--allow-unsafe-tools');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.warp.disabled, false);
  assert.equal(read().adapters.warp.unsafeTools, true, 'still marked, so still never an alias leg');

  assert.notEqual(run('set', 'google', '__proto__', '{}').status, 0);
  assert.notEqual(run('set', 'ghost', 'disabled', 'true').status, 0);
});

test('keysmith alias refuses cmd and gemini as shipped and an argv that auto-approves its tools, --force or not; opencode is tool-less and may join', () => {
  const { run, read, write } = sandbox();
  for (const args of [['add', 'agy'], ['add', 'cmd'], ['add', 'gemini'], ['add', 'opencode', '--as', 'oc']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.all);
  }
  let r = run('alias', 'chat', 'agy/gemini-4-argon-high', 'oc/evren/glm-5.3', 'cmd/x');
  assert.notEqual(r.status, 0, 'cmd approves its own tool calls in print mode');
  assert.match(r.all, /cmd\/x: adapter "cmd" can run commands and edit files \(unsafeTools\)/);
  assert.ok(!read().aliases.chat, 'refused means not saved');
  r = run('alias', 'chat', 'gemini/gemini-3.8-flash');
  assert.notEqual(r.status, 0);
  r = run('alias', 'chat', 'agy/gemini-4-argon-high', 'oc/evren/glm-5.3');
  assert.equal(r.status, 0, r.all);
  // An entry an older keysmith wrote: the opencode profile with --auto, no mark.
  const cfg = read();
  cfg.adapters.old = { kind: 'cli', bin: 'opencode', args: ['run', '--format', 'json', '--pure', '--auto', ['--model', '{model}'], '{prompt}'], parser: 'opencode-ndjson' };
  write(cfg);
  r = run('alias', 'chat', '--append', 'old/evren/glm-5.3', '--force');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /its argv passes --auto/);
  assert.deepEqual(read().aliases.chat, ['agy/gemini-4-argon-high', 'oc/evren/glm-5.3']);
});

test('keysmith add: claude is explicit-only without being told, and a re-add keeps every guard the entry had', () => {
  const { run, read } = sandbox();
  let r = run('add', 'claude');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.claude.explicitOnly, true, 'the profile ships it: forgetting a flag must not spend the subscription');
  assert.match(r.all, /explicit-only/);
  r = run('add', 'claude', '--bin', '/usr/bin/true');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.claude.bin, '/usr/bin/true');
  assert.equal(read().adapters.claude.explicitOnly, true, 'pinning the binary is no reason to lose the guard');
  assert.notEqual(run('alias', 'chat3', 'claude/sonnet').status, 0);

  run('add', 'agy');
  assert.equal(run('set', 'agy', 'explicitOnly', 'true').status, 0);
  assert.equal(run('set', 'agy', 'disabled', 'true').status, 0);
  r = run('add', 'agy', '--bin', process.execPath);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /kept explicitOnly, disabled from the "agy" entry/);
  assert.equal(read().adapters.agy.explicitOnly, true);
  assert.equal(read().adapters.agy.disabled, true);
  assert.equal(read().adapters.agy.bin, process.execPath, 'the rest is the profile plus the flags, as before');

  run('add', 'warp');
  assert.equal(run('set', 'warp', 'disabled', 'false', '--allow-unsafe-tools').status, 0);
  run('add', 'warp');
  assert.equal(read().adapters.warp.disabled, true, 'a re-add brings back the profile\'s off switch');
  assert.equal(read().adapters.warp.unsafeTools, true);
});

test('keysmith set refuses what would keep an adapter from loading; prototype names are no adapter and no alias', () => {
  const { run, read } = sandbox();
  run('add', 'google', '--key', '{env:KS_TEST_GOOGLE}');
  run('add', 'opencode');
  let r = run('set', 'google', 'modelParams', '{"gemini-4-argon":"high"}');
  assert.notEqual(r.status, 0, 'the gateway would drop google at its next start, and every route through it');
  assert.match(r.all, /must be an object of request fields/);
  assert.ok(!('modelParams' in read().adapters.google), 'refused means unchanged');
  r = run('set', 'opencode', 'args', '["run","--auto","{prompt}"]');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /auto-approves/);
  assert.ok(!read().adapters.opencode.args.includes('--auto'));
  r = run('set', 'google', 'baseUrl', '--unset');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /baseUrl is required/);
  for (const ref of ['{dotenv:~/project/.env}', '{vault:google}']) {
    r = run('set', 'google', 'apiKey', ref);
    assert.notEqual(r.status, 0, `${ref} can never resolve: the gateway would not load google`);
    assert.match(r.all, /apiKey reference/);
  }
  assert.equal(read().adapters.google.apiKey, '{env:KS_TEST_GOOGLE}');
  r = run('set', 'google', 'modelParams', '{"gemini-4-argon":"high"}', '--force');
  assert.equal(r.status, 0, '--force saves it, and says so');
  assert.match(r.all, /will not load/);

  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.notEqual(run('set', name, 'kind', 'cli').status, 0, `set ${name}`);
    assert.notEqual(run('remove', name).status, 0, `remove ${name}`);
    assert.notEqual(run('alias', name).status, 0, `alias ${name}: there is no such alias`);
  }
  assert.deepEqual(Object.keys(read().adapters).sort(), ['google', 'opencode'], 'no bogus adapter was written');
  r = run('alias', 'x', 'constructor/m');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no adapter named "constructor"/);
  assert.notEqual(run('alias', 'constructor', 'opencode/evren/glm-5.3').status, 0);
  assert.notEqual(run('add', 'agy', '--as', '__proto__').status, 0);
  assert.notEqual(run('add', 'constructor').status, 0);
  assert.deepEqual(read().aliases, {});
});

test('keysmith set: on a tool-capable adapter, what it runs and how it is stopped change only with --allow-unsafe-tools', () => {
  const { run, read, write } = sandbox();
  run('add', 'warp');
  assert.equal(run('set', 'warp', 'disabled', 'false', '--allow-unsafe-tools').status, 0);
  for (const [field, value] of [
    ['stopAtToolCall', 'false'],
    ['args', '["agent","run","--prompt","{prompt}"]'],
    ['bin', '/bin/sh'],
    ['env', '{"X":"1"}'],
    ['parser', 'raw'],
    ['modelsFrom', '{"args":["agent","run","--prompt","rm"]}'],
  ]) {
    const r = run('set', 'warp', field, value);
    assert.notEqual(r.status, 0, `${field} changed without the flag`);
    assert.match(r.all, /--allow-unsafe-tools/);
  }
  assert.equal(read().adapters.warp.stopAtToolCall, 'always', 'the one limit on the damage stays');
  assert.equal(run('set', 'warp', 'note', 'mine').status, 0, 'a note is not a decision');
  assert.equal(run('set', 'warp', 'disabled', 'true').status, 0, 'turning it off needs nothing');
  let r = run('set', 'warp', 'stopAtToolCall', 'false', '--allow-unsafe-tools');
  assert.equal(r.status, 0, r.all);
  assert.equal(read().adapters.warp.stopAtToolCall, false);
  // The mark is what lets an auto-approving argv load: adding it to an enabled entry serves it.
  const cfg = read();
  cfg.adapters.old = { kind: 'cli', bin: process.execPath, args: ['--yolo', '{prompt}'] };
  write(cfg);
  r = run('set', 'old', 'unsafeTools', 'true');
  assert.notEqual(r.status, 0);
  assert.match(r.all, /--allow-unsafe-tools/);
  assert.ok(!read().adapters.old.unsafeTools);
});

test('a change saved while a gateway runs says it needs a restart, and keysmith status says the config is newer', () => {
  const { run, dataDir } = sandbox();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pid = path.join(dataDir, 'keysmith.pid');
  // This test process stands in for the running gateway: alive, started a minute ago.
  fs.writeFileSync(pid, JSON.stringify({ pid: process.pid, port: 9, at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
  const restart = /still serves the config it started with — .* takes effect when it restarts: (?:pid \d+ \(port 9\): keysmith stop && keysmith start|launchd.*kickstart)/;
  for (const args of [['add', 'agy'], ['alias', 'argon', 'agy/gemini-4-argon-high'], ['set', 'agy', 'disabled', 'true'], ['alias', 'argon', '--delete'], ['key', 'add'], ['remove', 'agy']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, restart, args.join(' '));
  }
  const st = run('status');
  assert.match(st.all, /changes : .*config\.json changed .*after this gateway started.*still serves the old config/);
  fs.rmSync(pid);
  const quiet = run('add', 'agy');
  assert.equal(quiet.status, 0);
  assert.doesNotMatch(quiet.all, /still serves the config/, 'no gateway running, nothing to restart');
});

test('opencode adapter and keysmith doctor warn when the installed opencode version differs from verifiedVersion (1.19.3), including in probe and startup', async () => {
  const dir = tmp('opencode-version');
  const makeOc = (name, ver, countFile = null) =>
    nodeStub(
      dir,
      name,
      `const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  ${countFile ? `fs.appendFileSync(${JSON.stringify(countFile)}, '1\\n');` : ''}
  process.stdout.write(${JSON.stringify(ver + '\n')});
  process.exit(0);
}
process.stdout.write('opencode/deepseek-v4.1-flash-free\\n');`,
    );
  const countMatchFile = path.join(dir, 'version-calls-match.txt');
  const countMismatchFile = path.join(dir, 'version-calls-mismatch.txt');
  const binMatch = makeOc('opencode-match', '1.19.3', countMatchFile);
  const binMismatch = makeOc('opencode-mismatch', '1.18.27', countMismatchFile);

  // verifiedVersion takes precedence over any version numbers in free-text provenance.
  const customProv = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: binMatch,
    cwd: path.join(dir, 'ws-custom-prov'),
    provenance: 'tested after foo 0.1.0 and bar 2.0.0 on opencode',
  });
  assert.equal(customProv.verifiedVersion, '1.19.3');
  assert.deepEqual(await customProv.checkVersion(), { installed: '1.19.3', expected: '1.19.3', warning: null });

  const oldAdapter = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin: binMismatch, cwd: path.join(dir, 'ws-old') });
  const ver = await oldAdapter.checkVersion();
  assert.equal(ver.installed, '1.18.27');
  assert.equal(ver.expected, '1.19.3');
  assert.match(ver.warning || '', /1\.18\.27 !== verified 1\.19\.3.*keysmith upgrade oc --take workspaceFiles/);

  // Adapter probe (`probe()`) and Gateway startup (`checkAdapters()`) / `listModels()` also surface the version warning.
  const probed = await oldAdapter.probe();
  assert.ok(probed.warnings.some((w) => /1\.18\.27 !== verified 1\.19\.3/.test(w)));

  const logs = [];
  const gw = new Gateway(
    {
      adapters: {
        oc: { ...CLI_PROFILES.opencode, bin: binMismatch, cwd: path.join(dir, 'ws-gw-old') },
        oc2: { ...CLI_PROFILES.opencode, bin: binMatch, cwd: path.join(dir, 'ws-gw-ok') },
      },
    },
    { log: (m) => logs.push(m) },
  );
  await gw.listModels({ refresh: true });
  await gw.listModels({ refresh: true });
  await gw.checkAdapters();
  assert.ok(logs.some((m) => /adapter "oc":.*1\.18\.27 !== verified 1\.19\.3/.test(m)), `expected listModels probe warning in logs, got: ${logs.join('\n')}`);
  assert.ok(!logs.some((m) => /adapter "oc2":.*!==/.test(m)));

  // `--version` is cached per binary path for the process lifetime: spawned only once per binary across all checks/refreshes.
  const matchCalls = fs.readFileSync(countMatchFile, 'utf8').trim().split('\n').filter(Boolean).length;
  const mismatchCalls = fs.readFileSync(countMismatchFile, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(matchCalls, 1, 'opencode --version spawned only once for binMatch across adapters and refreshes');
  assert.equal(mismatchCalls, 1, 'opencode --version spawned only once for binMismatch across checkVersion, probe, listModels, and checkAdapters');

  const sb = sandbox();
  const cfg = sb.read();
  cfg.adapters.oc = { ...CLI_PROFILES.opencode, bin: binMismatch, cwd: path.join(dir, 'ws-doc-old'), models: ['opencode/deepseek-v4.1-flash-free'] };
  cfg.adapters.oc2 = { ...CLI_PROFILES.opencode, bin: binMatch, cwd: path.join(dir, 'ws-doc-ok'), models: ['opencode/deepseek-v4.1-flash-free'] };
  sb.write(cfg);
  const doc = sb.run('doctor');
  assert.equal(doc.status, 0, doc.all);
  assert.match(doc.stdout, /!\s+oc\s+version warning\s+.*1\.18\.27 !== verified 1\.19\.3/);
  assert.doesNotMatch(doc.stdout, /oc2\s+version warning/);
});

test('opencode preflight: refuses inherited pattern-map allow and managed-config scalar allow before spawning, passes clean config, and caches by (version, config source hashes, env)', async () => {
  const { clearOpencodePreflightCache, getOpencodePreflightStats } = await import('../src/cli-adapter.js');
  const dir = tmp('opencode-preflight');
  const testHome = path.join(dir, 'test-home');
  const managedDir = path.join(dir, 'managed-config');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(managedDir, { recursive: true, mode: 0o700 });
  const recordFile = path.join(dir, 'opencode-argv.json');
  const { bin } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');
  const a = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin,
    cwd: ws,
    managedConfigDir: managedDir,
    managedPlistPaths: [],
    env: {
      HOME: testHome,
      XDG_CONFIG_HOME: path.join(testHome, '.config'),
      XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
    },
  });

  clearOpencodePreflightCache();

  // 1. Clean config passes preflight, spawns the child, and caches the result.
  const evts1 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean 1' }] }));
  assert.equal(textOf(evts1), 'OK');
  assert.equal(fs.existsSync(recordFile), true, 'clean config allowed opencode to spawn');
  const stats1 = getOpencodePreflightStats();
  assert.equal(stats1.runs, 1);
  assert.equal(stats1.hits, 0);

  // Second request with identical version, config source hashes, and env hits the cache without re-running preflight.
  const evts2 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean 2' }] }));
  assert.equal(textOf(evts2), 'OK');
  const stats2 = getOpencodePreflightStats();
  assert.equal(stats2.runs, 1, 'preflight was not re-run when version, config source hashes, and env were unchanged');
  assert.equal(stats2.hits, 1, 'second request hit the preflight cache');

  // 2. Inherited pattern-map allow in ~/.config/opencode/opencode.json:
  // remeda.mergeDeep merges OPENCODE_CONFIG_CONTENT's {"*":"deny","":"deny"} into the user's pattern map,
  // preserving {"*hosts":"allow"} and {"*etc/*":"allow"}. Preflight detects the changed file hash, re-runs,
  // and refuses the run BEFORE spawning opencode, naming the offending source file and key.
  fs.rmSync(recordFile, { force: true });
  const globalOpencodeJson = path.join(testHome, '.config', 'opencode', 'opencode.json');
  fs.writeFileSync(
    globalOpencodeJson,
    JSON.stringify({
      permission: {
        read: { '*': 'deny', '*hosts': 'allow' },
        external_directory: { '*': 'deny', '*etc/*': 'allow' },
      },
      agent: {
        'keysmith-text': {
          permission: {
            read: { '*': 'deny', '*hosts': 'allow' },
            external_directory: { '*': 'deny', '*etc/*': 'allow' },
          },
        },
      },
    }),
  );
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'should not spawn' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      e.message.includes(globalOpencodeJson) &&
      e.message.includes('permission.read["*hosts"] = "allow"') &&
      e.message.includes('permission.external_directory["*etc/*"] = "allow"'),
  );
  assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when preflight refused the inherited pattern-map allow');
  const stats3 = getOpencodePreflightStats();
  assert.equal(stats3.runs, 2, 'changing global opencode.json hash invalidated the cache and re-ran preflight');

  // 3. Managed-config scalar allow in managedConfigDir/opencode.json:
  // loaded after OPENCODE_CONFIG_CONTENT, so a scalar "allow" replaces keysmith's object map.
  // Preflight refuses the run before spawning opencode, naming the managed config file and key.
  fs.rmSync(globalOpencodeJson, { force: true });
  const managedJson = path.join(managedDir, 'opencode.json');
  fs.writeFileSync(
    managedJson,
    JSON.stringify({
      permission: {
        read: 'allow',
        bash: 'ask',
      },
    }),
  );
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'managed allow' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      e.message.includes(managedJson) &&
      e.message.includes('permission.read = "allow"'),
  );
  assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when preflight refused the managed-config scalar allow');
  const stats4 = getOpencodePreflightStats();
  assert.equal(stats4.runs, 3, 'writing managed opencode.json invalidated the cache and re-ran preflight');

  // 4. Removing the managed config restores the clean state; changing verifiedVersion or env invalidates the cache and re-runs preflight.
  fs.rmSync(managedJson, { force: true });
  const evts3 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean 3' }] }));
  assert.equal(textOf(evts3), 'OK');
  assert.equal(getOpencodePreflightStats().hits, 2, 'clean state matched the earlier clean cache entry');

  a.verifiedVersion = '1.19.4';
  fs.rmSync(recordFile, { force: true });
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'version change' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      /sets version = "1\.19\.3 !== verifiedVersion 1\.19\.4/.test(e.message),
  );
  assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when verifiedVersion mismatched');
  assert.equal(getOpencodePreflightStats().runs, 4, 'changing opencode version key invalidated the cache and re-ran preflight');
  a.verifiedVersion = '1.19.3';

  a.env.XDG_CONFIG_HOME = path.join(dir, 'alt-xdg-config');
  await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'env change' }] }));
  assert.equal(getOpencodePreflightStats().runs, 5, 'changing relevant env invalidated the cache and re-ran preflight');
});

test('opencode preflight org-config (opencode.db): passes with no db or clean 1.19.3 db without hashing session writes, and refuses active org allowing read, unreadable, locked, or unknown-schema db', async () => {
  const { clearOpencodePreflightCache, getOpencodePreflightStats } = await import('../src/cli-adapter.js');
  const http = await import('node:http');
  const { createRequire } = await import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

  const dir = tmp('opencode-org-db');
  const testHome = path.join(dir, 'test-home');
  const dataDir = path.join(testHome, '.local', 'share', 'opencode');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'opencode.db');
  const recordFile = path.join(dir, 'opencode-argv.json');
  const { bin } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');

  const makeAdapter = () =>
    new CliAdapter('oc', {
      ...CLI_PROFILES.opencode,
      bin,
      cwd: ws,
      env: {
        HOME: testHome,
        XDG_CONFIG_HOME: path.join(testHome, '.config'),
        XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
      },
    });

  // Exact opencode 1.19.3 DDL extracted from AccountRepo + sqlite_master of a fresh 1.19.3 opencode.db.
  const init1193Schema = (file) => {
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE \`account\` (
        \`id\` text PRIMARY KEY,
        \`email\` text NOT NULL,
        \`url\` text NOT NULL,
        \`access_token\` text NOT NULL,
        \`refresh_token\` text NOT NULL,
        \`token_expiry\` integer,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL
      );
      CREATE TABLE \`account_state\` (
        \`id\` integer PRIMARY KEY,
        \`active_account_id\` text,
        \`active_org_id\` text,
        CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\`
          FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
      );
      CREATE TABLE \`project\` (
        \`id\` text PRIMARY KEY,
        \`worktree\` text NOT NULL,
        \`sandboxes\` text NOT NULL,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL
      );
      CREATE TABLE \`session\` (
        \`id\` text PRIMARY KEY,
        \`project_id\` text NOT NULL,
        \`slug\` text NOT NULL,
        \`directory\` text NOT NULL,
        \`title\` text NOT NULL,
        \`version\` text NOT NULL,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL
      );
    `);
    db.close();
  };

  // Start an in-process mock Console /api/config HTTP server on the main event loop (proving async fetch never deadlocks).
  let currentPayload = { config: { permission: { read: 'allow' } } };
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({
      method: req.method,
      url: req.url,
      orgId: req.headers['x-org-id'] || null,
      hasAuth: /^Bearer\s+\S+$/.test(req.headers.authorization || ''),
    });
    if (req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(currentPayload));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = srv.address();
    const a = makeAdapter();
    clearOpencodePreflightCache();

    // 1. No opencode.db -> passes.
    assert.equal(fs.existsSync(dbPath), false);
    const evNoDb = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'no db' }] }));
    assert.equal(textOf(evNoDb), 'OK');
    assert.equal(fs.existsSync(recordFile), true);

    // 2. Clean 1.19.3 opencode.db with no active org -> passes, and session/WAL mutations do NOT invalidate the preflight cache.
    clearOpencodePreflightCache();
    init1193Schema(dbPath);
    const evCleanDb1 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean db 1' }] }));
    assert.equal(textOf(evCleanDb1), 'OK');
    assert.equal(getOpencodePreflightStats().runs, 1);
    assert.equal(getOpencodePreflightStats().hits, 0);

    // Write session history rows (mutating opencode.db / opencode.db-wal bytes without changing active org).
    {
      const db = new DatabaseSync(dbPath);
      const now = Date.now();
      db.prepare('INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run('proj_1', dir, '[]', now, now);
      db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses_1',
        'proj_1',
        's1',
        dir,
        'big session payload '.repeat(200),
        '1.19.3',
        now,
        now,
      );
      db.close();
    }
    const evCleanDb2 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean db 2' }] }));
    assert.equal(textOf(evCleanDb2), 'OK');
    assert.equal(getOpencodePreflightStats().runs, 1, 'session writes in opencode.db (+wal) did not re-run preflight');
    assert.equal(getOpencodePreflightStats().hits, 1, 'narrow active-org query hit the preflight cache');

    // 3. Real 1.19.3 SQLite fixture with an active org whose Console /api/config allows `read` -> refused before spawning.
    fs.rmSync(recordFile, { force: true });
    {
      const db = new DatabaseSync(dbPath);
      const now = Date.now();
      db.prepare(
        'INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('acc_1', 'org@example.com', `http://127.0.0.1:${port}`, 'tok_secret_never_print', 'ref_secret', now + 3_600_000, now, now);
      db.prepare('INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (1, ?, ?)').run('acc_1', 'org_alpha');
      db.close();
    }
    await assert.rejects(
      events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'active org allow read' }] })),
      (e) =>
        e.status === 502 &&
        /opencode effective permission preflight failed/.test(e.message) &&
        e.message.includes(`http://127.0.0.1:${port}/api/config (org org_alpha)`) &&
        e.message.includes('permission.read = "allow"') &&
        !e.message.includes('tok_secret_never_print'),
    );
    assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when active org config allowed read');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].orgId, 'org_alpha');
    assert.equal(hits[0].hasAuth, true);

    // Active org with a clean config ({ autoupdate: false }) passes and caches keyed on (active_org_id, org config content), ignoring session writes.
    currentPayload = { config: { autoupdate: false } };
    clearOpencodePreflightCache();
    const evCleanOrg1 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean org 1' }] }));
    assert.equal(textOf(evCleanOrg1), 'OK');
    assert.equal(getOpencodePreflightStats().runs, 1);
    {
      const db = new DatabaseSync(dbPath);
      const now = Date.now();
      db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses_2',
        'proj_1',
        's2',
        dir,
        'more session rows '.repeat(100),
        '1.19.3',
        now,
        now,
      );
      db.close();
    }
    const evCleanOrg2 = await events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'clean org 2' }] }));
    assert.equal(textOf(evCleanOrg2), 'OK');
    assert.equal(getOpencodePreflightStats().runs, 1, 'preflight cache keyed on active-org id + config content was not busted by session writes');
    assert.equal(getOpencodePreflightStats().hits, 1);

    // 4. Locked opencode.db (exclusive reader-blocking lock held by another connection) -> refused naming opencode.db and lock error.
    fs.rmSync(recordFile, { force: true });
    const locker = new DatabaseSync(dbPath);
    locker.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
    try {
      await assert.rejects(
        events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'locked db' }] })),
        (e) =>
          e.status === 502 &&
          /opencode effective permission preflight failed/.test(e.message) &&
          e.message.includes(dbPath) &&
          /locked|SQLITE_BUSY/i.test(e.message),
      );
      assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when opencode.db was locked');
    } finally {
      try {
        locker.exec('ROLLBACK;');
      } catch {}
      locker.close();
    }

    // 5. Unknown-schema opencode.db (lacks 1.19.3 account / account_state tables or columns) -> refused.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    {
      const badSchemaDb = new DatabaseSync(dbPath);
      badSchemaDb.exec('CREATE TABLE org_config (org_id TEXT PRIMARY KEY, config TEXT);');
      badSchemaDb.close();
    }
    await assert.rejects(
      events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'unknown schema' }] })),
      (e) =>
        e.status === 502 &&
        /opencode effective permission preflight failed/.test(e.message) &&
        e.message.includes(dbPath) &&
        e.message.includes('opencode.db.schema') &&
        /lacks expected 1\.19\.3 table \\?"account_state\\?"/.test(e.message),
    );
    assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when opencode.db had an unknown schema');

    // Missing expected column on account table -> refused.
    fs.rmSync(dbPath, { force: true });
    {
      const partialSchemaDb = new DatabaseSync(dbPath);
      partialSchemaDb.exec(`
        CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT);
        CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      `);
      partialSchemaDb.close();
    }
    await assert.rejects(
      events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'partial schema' }] })),
      (e) =>
        e.status === 502 &&
        e.message.includes(dbPath) &&
        e.message.includes('opencode.db.schema') &&
        /table \\?"account\\?" lacks expected 1\.19\.3 columns/.test(e.message),
    );

    // 6. Corrupt / unreadable opencode.db -> refused.
    fs.writeFileSync(dbPath, 'not a valid sqlite3 header at all');
    await assert.rejects(
      events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'corrupt db' }] })),
      (e) =>
        e.status === 502 &&
        e.message.includes(dbPath) &&
        /not a database|cannot read opencode\.db/i.test(e.message),
    );

    fs.chmodSync(dbPath, 0o000);
    try {
      await assert.rejects(
        events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'unreadable db' }] })),
        (e) =>
          e.status === 502 &&
          e.message.includes(dbPath) &&
          /not readable|EACCES/i.test(e.message),
      );
      assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when opencode.db was unreadable');
    } finally {
      fs.chmodSync(dbPath, 0o600);
    }
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('opencode preflight managed-config redirect guard: adapter.managedConfigDir, managedPlistPaths, and KEYSMITH_TEST_OPENCODE_MANAGED_DIR only add paths and never replace or mask real system managed paths', async () => {
  const {
    clearOpencodePreflightCache,
    resolveOpencodeEffectiveConfig,
    TEST_ONLY_SYSTEM_MANAGED_PATHS,
  } = await import('../src/cli-adapter.js');

  const dir = tmp('opencode-managed-redirect');
  const testHome = path.join(dir, 'test-home');
  const fakeRealSystemDir = path.join(dir, 'simulated-etc-opencode');
  const fakeRealSystemPlist = path.join(dir, 'simulated-managed-prefs', 'ai.opencode.managed.plist');
  const cleanOverrideDir = path.join(dir, 'override-managed-dir');
  const extraCleanPlist = path.join(dir, 'override-managed-plist', 'extra.plist');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(fakeRealSystemDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(fakeRealSystemPlist), { recursive: true, mode: 0o700 });
  fs.mkdirSync(cleanOverrideDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(extraCleanPlist), { recursive: true, mode: 0o700 });

  // Put a deny-all file in cleanOverrideDir to prove an override cannot mask a hostile file at the real system path either.
  fs.writeFileSync(
    path.join(cleanOverrideDir, 'opencode.json'),
    JSON.stringify({
      permission: {
        '*': 'deny',
        external_directory: { '*': 'deny', '~/.local/share/opencode/tool-output/*': 'deny' },
        read: { '*': 'deny', '': 'deny' },
      },
    }),
  );
  fs.writeFileSync(
    extraCleanPlist,
    JSON.stringify({
      permission: { '*': 'deny' },
    }),
  );

  // Hostile file at the (test-injected) real system managed directory.
  const hostileSystemJson = path.join(fakeRealSystemDir, 'opencode.json');
  fs.writeFileSync(hostileSystemJson, JSON.stringify({ permission: { read: 'allow' } }));

  const recordFile = path.join(dir, 'opencode-argv.json');
  const { bin } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');
  const a = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin,
    cwd: ws,
    managedConfigDir: cleanOverrideDir,
    managedPlistPaths: [extraCleanPlist],
    env: {
      HOME: testHome,
      XDG_CONFIG_HOME: path.join(testHome, '.config'),
      XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
      KEYSMITH_TEST_OPENCODE_MANAGED_DIR: cleanOverrideDir,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: cleanOverrideDir,
    },
  });
  a[TEST_ONLY_SYSTEM_MANAGED_PATHS] = {
    dirs: [fakeRealSystemDir],
    plists: [fakeRealSystemPlist],
  };

  clearOpencodePreflightCache();

  // Verify real OS managed paths (/etc/opencode, and on macOS /Library/Application Support/opencode + Managed Preferences) remain in the resolved list alongside overrides.
  const resolvedCtx = resolveOpencodeEffectiveConfig(a, { runCwd: ws, childEnv: a.env });
  assert.ok(resolvedCtx.managedFiles.includes(path.resolve('/etc/opencode/opencode.json')), '/etc/opencode/opencode.json is always checked');
  if (process.platform === 'darwin') {
    assert.ok(
      resolvedCtx.managedFiles.includes(path.resolve('/Library/Application Support/opencode/opencode.json')),
      '/Library/Application Support/opencode/opencode.json is always checked on macOS',
    );
    assert.ok(
      resolvedCtx.managedPlistCandidates.includes(path.resolve('/Library/Managed Preferences/ai.opencode.managed.plist')),
      '/Library/Managed Preferences/ai.opencode.managed.plist is always checked on macOS',
    );
  }
  assert.ok(resolvedCtx.managedFiles.includes(path.resolve(cleanOverrideDir, 'opencode.json')), 'override managed dir is added, not ignored');
  assert.ok(resolvedCtx.managedFiles.includes(path.resolve(hostileSystemJson)), 'system managed dir is retained alongside overrides');

  // 1. Override set + hostile opencode.json at the real system path -> still refused.
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'redirect attempt' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      e.message.includes(hostileSystemJson) &&
      e.message.includes('permission.read = "allow"'),
  );
  assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when real system managed dir allowed read');

  // 2. Override managedPlistPaths = [] + hostile plist at the real system plist path -> still refused.
  fs.rmSync(hostileSystemJson, { force: true });
  a.managedPlistPaths = [];
  fs.writeFileSync(fakeRealSystemPlist, JSON.stringify({ permission: { bash: 'allow' } }));
  await assert.rejects(
    events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'plist redirect attempt' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      e.message.includes(`mobileconfig:${fakeRealSystemPlist}`) &&
      e.message.includes('permission.bash = "allow"'),
  );
  assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when real system managed plist allowed bash');
});

test('opencode lazy node:sqlite import: src/cli-adapter.js loads and non-opencode adapters (plus opencode without opencode.db) work when node:sqlite is unavailable, while opencode with opencode.db is refused', () => {
  const dir = tmp('no-node-sqlite');
  const { bin: ocBin } = opencodeStub(dir);
  const echoStub = path.join(dir, 'echo-stub.mjs');
  fs.writeFileSync(
    echoStub,
    `#!/usr/bin/env node\nprocess.stdout.write('PLAIN_OK\\n');\n`,
    { mode: 0o755 },
  );
  const cliAdapterUrl = new URL('../src/cli-adapter.js', import.meta.url).href;
  const profilesUrl = new URL('../src/profiles.js', import.meta.url).href;

  const probeScript = `
    import Module from 'node:module';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';

    // Simulate Node 20 / 22.0-22.4 where node:sqlite does not exist BEFORE importing src/cli-adapter.js.
    const origLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'node:sqlite' || request === 'sqlite') {
        const err = new Error('No such built-in module: ' + request);
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }
      return origLoad.call(this, request, parent, isMain);
    };

    const { CliAdapter, clearOpencodePreflightCache } = await import(${JSON.stringify(cliAdapterUrl)});
    const { CLI_PROFILES } = await import(${JSON.stringify(profilesUrl)});

    const baseDir = ${JSON.stringify(dir)};
    const testHome = path.join(baseDir, 'home');
    const dataDir = path.join(testHome, '.local', 'share', 'opencode');
    fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const collect = async (gen) => {
      const out = [];
      for await (const e of gen) out.push(e);
      return out;
    };

    // 1. opencode WITHOUT opencode.db works cleanly without node:sqlite.
    const oc = new CliAdapter('oc', {
      ...CLI_PROFILES.opencode,
      bin: ${JSON.stringify(ocBin)},
      cwd: path.join(baseDir, 'ws-oc'),
      env: {
        HOME: testHome,
        XDG_CONFIG_HOME: path.join(testHome, '.config'),
        XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
      },
    });
    clearOpencodePreflightCache();
    const ocEvents = await collect(oc.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(ocEvents.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'OK');

    // 2. When opencode.db EXISTS while node:sqlite is unavailable, opencode runs are refused (fail-closed),
    //    while non-opencode adapters remain completely unaffected.
    const dbFile = path.join(dataDir, 'opencode.db');
    fs.writeFileSync(dbFile, 'sqlite placeholder');
    const recordFile = path.join(baseDir, 'opencode-argv.json');
    fs.rmSync(recordFile, { force: true });

    const other = new CliAdapter('plain', {
      bin: ${JSON.stringify(echoStub)},
      args: ['{prompt}'],
      parser: 'raw',
      env: {
        HOME: testHome,
        XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
      },
    });
    const otherEvents = await collect(other.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(otherEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('').trim(), 'PLAIN_OK');

    clearOpencodePreflightCache();
    await assert.rejects(
      collect(oc.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'blocked' }] })),
      (e) =>
        e.status === 502 &&
        /opencode effective permission preflight failed/.test(e.message) &&
        e.message.includes(dbFile) &&
        e.message.includes('node:sqlite') &&
        /unavailable|No such built-in module/.test(e.message),
    );
    assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when opencode.db existed without node:sqlite');
    process.stdout.write('SIMULATION_PASSED\\n');
  `;

  const res = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout, /SIMULATION_PASSED/);
});

test('opencode preflight agent markdown frontmatter: refuses agent .md files with unclassifiable YAML constructs', async () => {
  const { clearOpencodePreflightCache } = await import('../src/cli-adapter.js');
  const dir = tmp('opencode-frontmatter-strict');
  const testHome = path.join(dir, 'test-home');
  const globalAgentDir = path.join(testHome, '.config', 'opencode', 'agent');
  fs.mkdirSync(globalAgentDir, { recursive: true, mode: 0o700 });
  const recordFile = path.join(dir, 'opencode-argv.json');
  const { bin } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');
  const a = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin,
    cwd: ws,
    env: {
      HOME: testHome,
      XDG_CONFIG_HOME: path.join(testHome, '.config'),
      XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
    },
  });

  const hostileMd = path.join(globalAgentDir, 'keysmith-text.md');
  const invalidFrontmatters = [
    // Block scalar
    '---\ndescription: |\n  multi-line block\n---\nPrompt\n',
    // Tab indentation
    '---\npermission:\n\tread: deny\n---\nPrompt\n',
    // YAML sequence item
    '---\ntools:\n  - read\n---\nPrompt\n',
    // Unclosed frontmatter fence
    '---\npermission:\n  read: allow\nPrompt without closing fence\n',
  ];

  for (const content of invalidFrontmatters) {
    fs.writeFileSync(hostileMd, content);
    clearOpencodePreflightCache();
    await assert.rejects(
      events(a.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'bad md' }] })),
      (e) =>
        e.status === 502 &&
        /opencode effective permission preflight failed/.test(e.message) &&
        e.message.includes(hostileMd) &&
        e.message.includes('frontmatter'),
    );
    assert.equal(fs.existsSync(recordFile), false);
  }
});

test('opencode preflight version drift: refuses unprobed/unknown and mismatched (1.19.4) versions before spawning, allows 1.19.3, and allows explicit allowUnverifiedVersion override', async () => {
  const {
    clearOpencodePreflightCache,
    clearOpencodeVersionCache,
    preflightOpencodePermissions,
  } = await import('../src/cli-adapter.js');

  const dir = tmp('opencode-version-drift');
  const testHome = path.join(dir, 'test-home');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(testHome, '.local', 'share', 'opencode'), { recursive: true, mode: 0o700 });

  const makeVersionedStub = (name, versionOut, exitCode = 0) => {
    const subDir = path.join(dir, name);
    fs.mkdirSync(subDir, { recursive: true });
    const recordFile = path.join(subDir, 'run-record.json');
    const binPath = nodeStub(
      subDir,
      'opencode',
      `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(${JSON.stringify(versionOut)});
  process.exit(${exitCode});
}
fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv }));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'step_start', sessionID: 'ses_v', part: { type: 'step-start' } });
line({ type: 'text', sessionID: 'ses_v', part: { id: 'prt_1', type: 'text', text: 'VER_OK' } });
line({ type: 'step_finish', sessionID: 'ses_v', part: { type: 'step-finish', reason: 'stop', tokens: { total: 4, input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
`,
    );
    return { binPath, recordFile };
  };

  const baseEnv = {
    HOME: testHome,
    XDG_CONFIG_HOME: path.join(testHome, '.config'),
    XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
  };

  // 1a. Unprobed cache state (`probeVersion: false` before any `--version` check) -> refused.
  clearOpencodeVersionCache();
  clearOpencodePreflightCache();
  const stub1193 = makeVersionedStub('oc-1193', '1.19.3\n');
  const ws1193 = path.join(dir, 'ws-1193');
  const a1193 = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin: stub1193.binPath, cwd: ws1193, env: { ...baseEnv } });
  a1193._ensureCwd();
  await assert.rejects(
    preflightOpencodePermissions(a1193, {
      runCwd: ws1193,
      childEnv: a1193._childEnv(ws1193),
      mode: 'text',
      probeVersion: false,
    }),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      /sets version = "unprobed\/unknown !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(stub1193.recordFile), false, 'unprobed version refused without running opencode');

  // 1b. Unknown/unparseable `--version` output on the real request path -> refused before spawning `opencode run`.
  const stubUnknown = makeVersionedStub('oc-unknown', 'opencode custom-dev-build\n');
  const aUnknown = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: stubUnknown.binPath,
    cwd: path.join(dir, 'ws-unknown'),
    env: { ...baseEnv },
  });
  await assert.rejects(
    events(aUnknown.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      /sets version = "unprobed\/unknown !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(stubUnknown.recordFile), false, 'opencode run was never spawned when --version was unknown');

  // 2. Mismatched version 1.19.4 -> refused before spawning `opencode run` (both text and EMULATE).
  const stub1194 = makeVersionedStub('oc-1194', '1.19.4\n');
  const a1194 = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: stub1194.binPath,
    cwd: path.join(dir, 'ws-1194'),
    env: { ...baseEnv },
    toolMode: 'emulate',
    models: ['opencode/deepseek-v4.1-flash-free'],
  });
  const verCheck = await a1194.checkVersion();
  assert.equal(verCheck.installed, '1.19.4');
  assert.match(verCheck.warning || '', /runs are refused unless `keysmith set oc allowUnverifiedVersion true` is set/);
  await assert.rejects(
    events(a1194.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      /sets version = "1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(stub1194.recordFile), false, 'opencode 1.19.4 run was never spawned on text path');

  const gwRefuse = new Gateway({
    adapters: {
      oc: {
        ...CLI_PROFILES.opencode,
        bin: stub1194.binPath,
        cwd: path.join(dir, 'ws-1194-gw'),
        env: { ...baseEnv },
        toolMode: 'emulate',
        models: ['opencode/deepseek-v4.1-flash-free'],
      },
    },
  });
  await assert.rejects(
    events(
      gwRefuse.complete({
        model: 'oc/opencode/deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'use tool' }],
        tools: {
          face: 'openai',
          spec: {
            tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }],
            choice: { mode: 'auto' },
            unsupported: [],
          },
        },
      }),
    ),
    (e) => e.status === 502 && /1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(stub1194.recordFile), false, 'opencode 1.19.4 run was never spawned on EMULATE path');

  // 3. Verified version 1.19.3 -> allowed (auto-probed on first request).
  clearOpencodeVersionCache();
  clearOpencodePreflightCache();
  const evOk = await events(a1193.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(textOf(evOk), 'VER_OK');
  assert.equal(fs.existsSync(stub1193.recordFile), true, 'verified 1.19.3 opencode was allowed to run');

  // 4. Explicit owner override (`allowUnverifiedVersion: true`, settable via `keysmith set oc allowUnverifiedVersion true`) -> allowed.
  const sb = sandbox();
  const sbCfg = sb.read();
  sbCfg.adapters.oc = {
    ...CLI_PROFILES.opencode,
    bin: stub1194.binPath,
    cwd: path.join(dir, 'ws-override'),
    env: { ...baseEnv },
    models: ['opencode/deepseek-v4.1-flash-free'],
  };
  sb.write(sbCfg);
  const setRes = sb.run('set', 'oc', 'allowUnverifiedVersion', 'true');
  assert.equal(setRes.status, 0, setRes.all);
  assert.equal(sb.read().adapters.oc.allowUnverifiedVersion, true);

  const aOverride = new CliAdapter('oc', sb.read().adapters.oc);
  const evOverride = await events(
    aOverride.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'override run' }] }),
  );
  assert.equal(textOf(evOverride), 'VER_OK');
  assert.equal(fs.existsSync(stub1194.recordFile), true, 'opencode 1.19.4 ran when allowUnverifiedVersion: true was set');
});

test("opencode preflight async org-config fetch: slow /api/config fetch does not block another adapter's request, caches briefly by (account, org, tokenExpiry), and fails closed on timeout or error", async () => {
  const {
    clearOpencodePreflightCache,
    getOpencodeOrgConfigStats,
  } = await import('../src/cli-adapter.js');
  const http = await import('node:http');
  const { createRequire } = await import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

  const dir = tmp('opencode-async-org');
  const testHome = path.join(dir, 'test-home');
  const dataDir = path.join(testHome, '.local', 'share', 'opencode');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'opencode.db');
  const recordFile = path.join(dir, 'opencode-argv.json');
  const { bin: ocBin } = opencodeStub(dir);
  const fastBin = nodeStub(
    dir,
    'fast-cli',
    `process.stdout.write('FAST_ADAPTER_OK');\n`,
  );

  const initDb = ({ accountId = 'acc_1', orgId = 'org_1', tokenExpiry, baseUrl }) => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    db.exec(`
      CREATE TABLE account (
        id text PRIMARY KEY,
        email text NOT NULL,
        url text NOT NULL,
        access_token text NOT NULL,
        refresh_token text NOT NULL,
        token_expiry integer,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
      CREATE TABLE account_state (
        id integer PRIMARY KEY,
        active_account_id text,
        active_org_id text
      );
    `);
    db.prepare(
      'INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, 'u@example.com', baseUrl, 'tok_async_secret', 'ref_async', tokenExpiry, now, now);
    db.prepare('INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (1, ?, ?)').run(accountId, orgId);
    db.close();
  };

  let delayMs = 1_500;
  let statusCode = 200;
  let bodyPayload = { config: { autoupdate: false } };
  let serverFetches = 0;
  let serverResponded = false;
  let notifyFetchStarted = null;

  const srv = http.createServer((req, res) => {
    if (req.url !== '/api/config') {
      res.writeHead(404).end();
      return;
    }
    serverFetches++;
    notifyFetchStarted?.();
    const wait = delayMs;
    const code = statusCode;
    const payload = bodyPayload;
    setTimeout(() => {
      serverResponded = true;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }, wait);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = srv.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const baseExpiry = Date.now() + 3_600_000;
    initDb({ accountId: 'acc_1', orgId: 'org_1', tokenExpiry: baseExpiry, baseUrl });
    clearOpencodePreflightCache();

    const gw = new Gateway({
      adapters: {
        oc: {
          ...CLI_PROFILES.opencode,
          bin: ocBin,
          cwd: path.join(dir, 'ws-oc'),
          models: ['opencode/deepseek-v4.1-flash-free'],
          orgConfigCacheTtlMs: 10_000,
          orgConfigFetchTimeoutMs: 3_000,
          env: {
            HOME: testHome,
            XDG_CONFIG_HOME: path.join(testHome, '.config'),
            XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
          },
        },
        fast: {
          kind: 'cli',
          bin: fastBin,
          args: ['{prompt}'],
          parser: 'raw',
          cwd: path.join(dir, 'ws-fast'),
          models: ['echo-fast'],
        },
      },
    });

    // 1. Slow /api/config fetch (700 ms) on `oc` does NOT block `fast` adapter's request on the same gateway.
    const fetchArrived = new Promise((resolve) => {
      notifyFetchStarted = resolve;
    });
    serverResponded = false;
    const ocPromise = events(
      gw.complete({
        model: 'oc/opencode/deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'slow org preflight' }],
      }),
    );
    await Promise.race([
      fetchArrived,
      ocPromise.then(() => {
        throw new Error('oc finished before /api/config fetch arrived');
      }),
    ]);

    const fastStart = performance.now();
    const fastEvts = await events(
      gw.complete({
        model: 'fast/echo-fast',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );
    const fastElapsedMs = performance.now() - fastStart;
    assert.equal(textOf(fastEvts), 'FAST_ADAPTER_OK');
    assert.equal(
      serverResponded,
      false,
      `fast adapter completed (${fastElapsedMs.toFixed(1)} ms) while oc /api/config fetch was still in flight`,
    );
    assert.ok(fastElapsedMs < 1_200, `expected fast adapter not to wait for 1500ms org fetch, took ${fastElapsedMs.toFixed(1)}ms`);

    const ocEvts = await ocPromise;
    assert.equal(textOf(ocEvts), 'OK');
    assert.equal(serverFetches, 1);

    // 2. Brief cache keyed on (account, org, tokenExpiry): immediate repeat hits cache with zero extra HTTP fetches.
    delayMs = 5;
    const ocEvts2 = await events(
      gw.complete({
        model: 'oc/opencode/deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'cached org preflight' }],
      }),
    );
    assert.equal(textOf(ocEvts2), 'OK');
    assert.equal(serverFetches, 1, 'second request within TTL hit the brief org-config cache');
    assert.equal(getOpencodeOrgConfigStats().hits, 1);

    // Changing org, account, or token_expiry invalidates the cache key and triggers a fresh async fetch.
    {
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE account_state SET active_org_id = ? WHERE id = 1').run('org_2');
      db.close();
    }
    await events(gw.complete({ model: 'oc/opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'new org' }] }));
    assert.equal(serverFetches, 2, 'changing active_org_id missed org-config cache and re-fetched');

    {
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE account SET token_expiry = ? WHERE id = ?').run(baseExpiry + 60_000, 'acc_1');
      db.close();
    }
    await events(gw.complete({ model: 'oc/opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'new expiry' }] }));
    assert.equal(serverFetches, 3, 'changing token_expiry missed org-config cache and re-fetched');

    {
      const db = new DatabaseSync(dbPath);
      const now = Date.now();
      db.prepare(
        'INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('acc_2', 'u2@example.com', baseUrl, 'tok_async_secret_2', 'ref_2', baseExpiry + 60_000, now, now);
      db.prepare('UPDATE account_state SET active_account_id = ? WHERE id = 1').run('acc_2');
      db.close();
    }
    await events(gw.complete({ model: 'oc/opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'new account' }] }));
    assert.equal(serverFetches, 4, 'changing active_account_id missed org-config cache and re-fetched');

    // Brief TTL expiry re-fetches /api/config and catches a newly hostile org config.
    const shortTtlAdapter = new CliAdapter('oc', {
      ...CLI_PROFILES.opencode,
      bin: ocBin,
      cwd: path.join(dir, 'ws-short-ttl'),
      orgConfigCacheTtlMs: 40,
      orgConfigFetchTimeoutMs: 200,
      env: {
        HOME: testHome,
        XDG_CONFIG_HOME: path.join(testHome, '.config'),
        XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
      },
    });
    clearOpencodePreflightCache();
    await events(shortTtlAdapter.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'ttl 1' }] }));
    assert.equal(serverFetches, 5);
    bodyPayload = { config: { permission: { read: 'allow' } } };
    await new Promise((r) => setTimeout(r, 65));
    fs.rmSync(recordFile, { force: true });
    await assert.rejects(
      events(shortTtlAdapter.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'ttl expired hostile' }] })),
      (e) => e.status === 502 && e.message.includes('permission.read = "allow"'),
    );
    assert.equal(serverFetches, 6, 'expired TTL re-fetched /api/config');
    assert.equal(fs.existsSync(recordFile), false, 'opencode was not spawned after TTL refresh detected allow rule');

    // 3. Timeout and HTTP 500 fail closed (refuse the run without spawning opencode) and recover once server is healthy.
    clearOpencodePreflightCache();
    bodyPayload = { config: { autoupdate: false } };
    delayMs = 450; // exceeds shortTtlAdapter.orgConfigFetchTimeoutMs (200 ms)
    fs.rmSync(recordFile, { force: true });
    await assert.rejects(
      events(shortTtlAdapter.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'timeout check' }] })),
      (e) =>
        e.status === 502 &&
        /timed out fetching active Console org config/.test(e.message) &&
        !e.message.includes('tok_async_secret'),
    );
    assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when /api/config timed out');

    delayMs = 5;
    statusCode = 503;
    await assert.rejects(
      events(shortTtlAdapter.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'http 503 check' }] })),
      (e) => e.status === 502 && /returned HTTP 503/.test(e.message),
    );
    assert.equal(fs.existsSync(recordFile), false, 'opencode was never spawned when /api/config returned HTTP 503');

    // Transient fetch failure was not permanently cached: restoring 200 OK succeeds immediately.
    statusCode = 200;
    const evRecovered = await events(
      shortTtlAdapter.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'recovered' }] }),
    );
    assert.equal(textOf(evRecovered), 'OK');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('opencode version cache invalidation: detects in-place upgrade with identical size and fixed npm mtime, symlink retargeting, and launcher upgrades via TTL or preflight miss', async () => {
  const { clearOpencodePreflightCache, clearOpencodeVersionCache } = await import('../src/cli-adapter.js');

  const dir = tmp('opencode-version-stat-invalidation');
  const testHome = path.join(dir, 'test-home');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(testHome, '.local', 'share', 'opencode'), { recursive: true, mode: 0o700 });
  const baseEnv = {
    HOME: testHome,
    XDG_CONFIG_HOME: path.join(testHome, '.config'),
    XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
  };

  // npm packs tarball files with the fixed mtime 1985-10-26T08:15:00.000Z.
  const NPM_FIXED_MTIME = new Date('1985-10-26T08:15:00.000Z');
  const buildScript = (ver, probeCounterFile, runRecordFile) => `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(probeCounterFile)}, '1\\n');
  process.stdout.write(${JSON.stringify(`${ver}\n`)});
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(runRecordFile)}, JSON.stringify({ argv }));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'step_start', sessionID: 'ses_up', part: { type: 'step-start' } });
line({ type: 'text', sessionID: 'ses_up', part: { id: 'prt_1', type: 'text', text: 'UP_OK' } });
line({ type: 'step_finish', sessionID: 'ses_up', part: { type: 'step-finish', reason: 'stop', tokens: { total: 4, input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
`;

  const countLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

  // 1. In-place upgrade with identical byte size and identical npm fixed mtime (only ctime changes) -> detected and refused.
  clearOpencodeVersionCache();
  clearOpencodePreflightCache();
  const inplaceDir = path.join(dir, 'inplace');
  fs.mkdirSync(inplaceDir, { recursive: true });
  const inplaceBin = path.join(inplaceDir, 'opencode');
  const inplaceProbes = path.join(inplaceDir, 'probes.log');
  const inplaceRunRecord = path.join(inplaceDir, 'run.json');
  const script1193 = buildScript('1.19.3', inplaceProbes, inplaceRunRecord);
  const script1194 = buildScript('1.19.4', inplaceProbes, inplaceRunRecord);
  assert.equal(Buffer.byteLength(script1193), Buffer.byteLength(script1194), '1.19.3 and 1.19.4 scripts have identical byte size');

  fs.writeFileSync(inplaceBin, script1193, { mode: 0o755 });
  fs.utimesSync(inplaceBin, NPM_FIXED_MTIME, NPM_FIXED_MTIME);
  const stBefore = fs.statSync(fs.realpathSync(inplaceBin), { bigint: true });

  const aInplace = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: inplaceBin,
    cwd: path.join(dir, 'ws-inplace'),
    env: { ...baseEnv },
  });
  const ev1 = await events(aInplace.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'before upgrade' }] }));
  assert.equal(textOf(ev1), 'UP_OK');
  assert.equal(countLines(inplaceProbes), 1);

  // Cached hit before upgrade does not respawn `--version`.
  const ev2 = await events(aInplace.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'cached before upgrade' }] }));
  assert.equal(textOf(ev2), 'UP_OK');
  assert.equal(countLines(inplaceProbes), 1, 'cached version avoided re-spawning --version while binary was unchanged');

  // Overwrite in-place (preserving inode) with identical size and restore npm's fixed 1985-10-26 mtime.
  fs.rmSync(inplaceRunRecord, { force: true });
  fs.writeFileSync(inplaceBin, script1194, { mode: 0o755 });
  fs.utimesSync(inplaceBin, NPM_FIXED_MTIME, NPM_FIXED_MTIME);
  const stAfter = fs.statSync(fs.realpathSync(inplaceBin), { bigint: true });
  assert.equal(stAfter.ino, stBefore.ino, 'in-place overwrite kept the same inode');
  assert.equal(stAfter.size, stBefore.size, 'in-place overwrite kept the exact same byte size');
  assert.equal(stAfter.mtimeNs, stBefore.mtimeNs, 'in-place overwrite kept npm fixed 1985-10-26 mtime');

  await assert.rejects(
    events(aInplace.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'after in-place upgrade' }] })),
    (e) =>
      e.status === 502 &&
      /opencode effective permission preflight failed/.test(e.message) &&
      /1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(countLines(inplaceProbes), 2, 'ctime change invalidated version cache and re-probed --version');
  assert.equal(fs.existsSync(inplaceRunRecord), false, 'opencode 1.19.4 run was never spawned after in-place upgrade');

  // 2. Symlink retargeting to a pre-existing binary with identical size and fixed 1985-10-26 mtime -> detected via realpathSync + ino and refused.
  const symDir = path.join(dir, 'sym');
  fs.mkdirSync(symDir, { recursive: true });
  const symProbes = path.join(symDir, 'probes.log');
  const symRunRecord = path.join(symDir, 'run.json');
  const target1193 = path.join(symDir, 'opencode-1193');
  const target1194 = path.join(symDir, 'opencode-1194');
  fs.writeFileSync(target1193, buildScript('1.19.3', symProbes, symRunRecord), { mode: 0o755 });
  fs.writeFileSync(target1194, buildScript('1.19.4', symProbes, symRunRecord), { mode: 0o755 });
  fs.utimesSync(target1193, NPM_FIXED_MTIME, NPM_FIXED_MTIME);
  fs.utimesSync(target1194, NPM_FIXED_MTIME, NPM_FIXED_MTIME);
  const symLink = path.join(symDir, 'opencode');
  fs.symlinkSync(target1193, symLink);

  const aSym = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: symLink,
    cwd: path.join(dir, 'ws-sym'),
    env: { ...baseEnv },
  });
  const evSym1 = await events(aSym.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'sym v1' }] }));
  assert.equal(textOf(evSym1), 'UP_OK');

  fs.rmSync(symRunRecord, { force: true });
  const tmpLink = path.join(symDir, 'opencode.next');
  fs.symlinkSync(target1194, tmpLink);
  fs.renameSync(tmpLink, symLink);

  await assert.rejects(
    events(aSym.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'sym v2' }] })),
    (e) => e.status === 502 && /1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(symRunRecord), false, 'opencode 1.19.4 run was never spawned after symlink retarget');

  // 3. Untouched JS launcher script (realpath, ino, ctime, size, mtime all unchanged) delegating to a sibling platform binary:
  //    detected both when preflight cache misses AND when short versionCacheTtlMs expires.
  const launcherDir = path.join(dir, 'launcher');
  fs.mkdirSync(launcherDir, { recursive: true });
  const versionSidecar = path.join(launcherDir, 'platform-version.txt');
  const launcherProbes = path.join(launcherDir, 'probes.log');
  const launcherRunRecord = path.join(launcherDir, 'run.json');
  fs.writeFileSync(versionSidecar, '1.19.3\n');
  const launcherBin = nodeStub(
    launcherDir,
    'opencode',
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(launcherProbes)}, '1\\n');
  process.stdout.write(fs.readFileSync(${JSON.stringify(versionSidecar)}, 'utf8'));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(launcherRunRecord)}, JSON.stringify({ argv }));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'step_start', sessionID: 'ses_l', part: { type: 'step-start' } });
line({ type: 'text', sessionID: 'ses_l', part: { id: 'prt_1', type: 'text', text: 'LAUNCH_OK' } });
line({ type: 'step_finish', sessionID: 'ses_l', part: { type: 'step-finish', reason: 'stop', tokens: { total: 4, input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
`,
  );
  fs.utimesSync(launcherBin, NPM_FIXED_MTIME, NPM_FIXED_MTIME);
  const launcherStat0 = fs.statSync(fs.realpathSync(launcherBin), { bigint: true });

  // 3a. Preflight cache miss triggers re-probe even before TTL expires.
  const aLauncherMiss = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: launcherBin,
    cwd: path.join(dir, 'ws-launcher-miss'),
    versionCacheTtlMs: 60_000,
    env: { ...baseEnv },
  });
  const evL1 = await events(aLauncherMiss.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'launcher 1' }] }));
  assert.equal(textOf(evL1), 'LAUNCH_OK');

  fs.writeFileSync(versionSidecar, '1.19.4\n');
  fs.rmSync(launcherRunRecord, { force: true });
  const launcherStat1 = fs.statSync(fs.realpathSync(launcherBin), { bigint: true });
  assert.equal(launcherStat1.ctimeNs, launcherStat0.ctimeNs, 'launcher binary itself was completely untouched on disk');

  // Trigger a preflight cache miss via env change -> re-probes `--version` and refuses 1.19.4!
  aLauncherMiss.env.XDG_CONFIG_HOME = path.join(dir, 'alt-launcher-xdg');
  await assert.rejects(
    events(aLauncherMiss.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'launcher after miss' }] })),
    (e) => e.status === 502 && /1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(launcherRunRecord), false);

  // 3b. Short TTL expiry triggers re-probe even with zero config/env changes.
  clearOpencodeVersionCache();
  clearOpencodePreflightCache();
  fs.writeFileSync(versionSidecar, '1.19.3\n');
  const aLauncherTtl = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: launcherBin,
    cwd: path.join(dir, 'ws-launcher-ttl'),
    versionCacheTtlMs: 45,
    env: { ...baseEnv },
  });
  const evL2 = await events(aLauncherTtl.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'ttl before' }] }));
  assert.equal(textOf(evL2), 'LAUNCH_OK');

  fs.writeFileSync(versionSidecar, '1.19.4\n');
  fs.rmSync(launcherRunRecord, { force: true });
  await new Promise((r) => setTimeout(r, 70));

  await assert.rejects(
    events(aLauncherTtl.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'ttl after' }] })),
    (e) => e.status === 502 && /1\.19\.4 !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(fs.existsSync(launcherRunRecord), false, 'TTL expiry re-probed untouched launcher and refused 1.19.4');

  // 4. Missing stat means "not cached": if stat fails when `--version` finishes (or later), nothing is served from cache.
  const vanishDir = path.join(dir, 'vanish');
  fs.mkdirSync(vanishDir, { recursive: true });
  const vanishProbes = path.join(vanishDir, 'probes.log');
  const vanishLink = path.join(vanishDir, 'opencode');
  const vanishTarget = nodeStub(
    vanishDir,
    'opencode-vanish-target',
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(vanishProbes)}, '1\\n');
  try { fs.unlinkSync(${JSON.stringify(vanishLink)}); } catch {}
  process.stdout.write('1.19.3\\n');
  process.exit(0);
}
`,
  );
  fs.symlinkSync(vanishTarget, vanishLink);
  const aVanish = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: vanishLink,
    cwd: path.join(dir, 'ws-vanish'),
    env: { ...baseEnv },
  });
  assert.equal(await aVanish.checkVersion().then((r) => r.installed), '1.19.3');
  assert.equal(countLines(vanishProbes), 1);
  // Restore symlink at identical target/stat: because post-probe stat was missing (unlinked), it was NOT cached and re-probes.
  fs.symlinkSync(vanishTarget, vanishLink);
  await aVanish.checkVersion();
  assert.equal(countLines(vanishProbes), 2, 'missing stat during probe was not cached');
});

test('opencode negative --version cache: caches failed or unrecognised --version probes briefly so repeated requests do not respawn --version, while still refusing every run', async () => {
  const { clearOpencodePreflightCache, clearOpencodeVersionCache } = await import('../src/cli-adapter.js');

  const dir = tmp('opencode-negative-version-cache');
  const testHome = path.join(dir, 'test-home');
  fs.mkdirSync(path.join(testHome, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(testHome, '.local', 'share', 'opencode'), { recursive: true, mode: 0o700 });
  const baseEnv = {
    HOME: testHome,
    XDG_CONFIG_HOME: path.join(testHome, '.config'),
    XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
  };
  const countLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

  // 1. Unrecognised `--version` output (exit 0, no semver): cached briefly, refuses every run without respawning per request.
  clearOpencodeVersionCache();
  clearOpencodePreflightCache();
  const unrecDir = path.join(dir, 'unrec');
  fs.mkdirSync(unrecDir, { recursive: true });
  const unrecProbes = path.join(unrecDir, 'probes.log');
  const unrecRunRecord = path.join(unrecDir, 'run.json');
  const unrecBin = nodeStub(
    unrecDir,
    'opencode',
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(unrecProbes)}, '1\\n');
  process.stdout.write('opencode custom-nightly-build\\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(unrecRunRecord)}, JSON.stringify({ argv }));
`,
  );

  const aUnrec = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: unrecBin,
    cwd: path.join(dir, 'ws-unrec'),
    negativeVersionCacheTtlMs: 80,
    env: { ...baseEnv },
  });

  for (let i = 0; i < 3; i++) {
    if (i === 2) {
      // Force a preflight cache miss on the 3rd request too: negative version cache must still hold!
      aUnrec.env.XDG_CONFIG_HOME = path.join(dir, 'alt-unrec-xdg');
    }
    await assert.rejects(
      events(aUnrec.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: `req ${i}` }] })),
      (e) =>
        e.status === 502 &&
        /opencode effective permission preflight failed/.test(e.message) &&
        /unprobed\/unknown !== verifiedVersion 1\.19\.3/.test(e.message),
    );
  }
  assert.equal(countLines(unrecProbes), 1, 'unrecognised --version probe was spawned only once within brief negative TTL');
  assert.equal(fs.existsSync(unrecRunRecord), false, 'opencode run was never spawned');

  // After the brief negative TTL expires, the next request probes `--version` once again and still refuses.
  await new Promise((r) => setTimeout(r, 110));
  await assert.rejects(
    events(aUnrec.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'after neg ttl' }] })),
    (e) => e.status === 502 && /unprobed\/unknown !== verifiedVersion 1\.19\.3/.test(e.message),
  );
  assert.equal(countLines(unrecProbes), 2, 'expired negative TTL allowed a fresh --version probe');

  // 2. Failed `--version` probe (exit 1): cached briefly, refuses every run, and immediately recovers if binary is fixed on disk.
  const failDir = path.join(dir, 'fail');
  fs.mkdirSync(failDir, { recursive: true });
  const failProbes = path.join(failDir, 'probes.log');
  const failRunRecord = path.join(failDir, 'run.json');
  const failBin = nodeStub(
    failDir,
    'opencode',
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(failProbes)}, '1\\n');
  process.stderr.write('fatal: broken install\\n');
  process.exit(1);
}
fs.writeFileSync(${JSON.stringify(failRunRecord)}, JSON.stringify({ argv }));
`,
  );

  const aFail = new CliAdapter('oc', {
    ...CLI_PROFILES.opencode,
    bin: failBin,
    cwd: path.join(dir, 'ws-fail'),
    negativeVersionCacheTtlMs: 5_000,
    env: { ...baseEnv },
  });

  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      events(aFail.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: `fail ${i}` }] })),
      (e) => e.status === 502 && /unprobed\/unknown !== verifiedVersion 1\.19\.3/.test(e.message),
    );
  }
  assert.equal(countLines(failProbes), 1, 'failed --version probe was spawned only once across repeated requests');
  assert.equal(fs.existsSync(failRunRecord), false);

  // Fixing the binary in-place changes its stat key immediately (no need to wait out the 5 s negative TTL).
  nodeStub(
    failDir,
    'opencode',
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  fs.appendFileSync(${JSON.stringify(failProbes)}, '1\\n');
  process.stdout.write('1.19.3\\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(failRunRecord)}, JSON.stringify({ argv }));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'step_start', sessionID: 'ses_fx', part: { type: 'step-start' } });
line({ type: 'text', sessionID: 'ses_fx', part: { id: 'prt_1', type: 'text', text: 'FIXED_OK' } });
line({ type: 'step_finish', sessionID: 'ses_fx', part: { type: 'step-finish', reason: 'stop', tokens: { total: 4, input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } });
`,
  );

  const evFixed = await events(aFail.complete({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'after fix' }] }));
  assert.equal(textOf(evFixed), 'FIXED_OK');
  assert.equal(countLines(failProbes), 2, 'in-place binary fix invalidated negative cache immediately');
});
