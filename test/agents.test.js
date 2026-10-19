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
    ['cmd', 'gemini', 'warp'],
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
  assert.match(agent, /^---\n[\s\S]*permission:\n {2}"\*": deny\n[\s\S]*tools:\n {2}"\*": false\n[\s\S]*---\n/);
  const config = JSON.parse(p.workspaceFiles['opencode.json']);
  assert.deepEqual(config.permission, { '*': 'deny' }, 'an agent name that does not resolve falls back to the default agent: it gets nothing either');
  assert.deepEqual(config.tools, { '*': false });
  assert.deepEqual(config.mcp, {});
  assert.equal(p.stopAtToolCall, true);
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

/** An opencode-shaped stub: records argv and the workspace files it found, then answers as `opencode run --format json` does. */
function opencodeStub(dir) {
  const record = path.join(dir, 'opencode-argv.json');
  const bin = nodeStub(
    dir,
    'opencode',
    `const fs = require('fs');
const argv = process.argv.slice(2);
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, agent: readOr('.opencode/agent/keysmith-text.md'), config: JSON.parse(readOr('opencode.json') || 'null'), cwd: process.cwd(), pwd: process.env.PWD }));
const prompt = argv[argv.length - 1];
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } });
if (prompt.includes('free')) {
  line({ type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode.", statusCode: 403, isRetryable: false } } });
  process.exit(1);
}
line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK' } });
if (prompt.includes('tool')) {
  line({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'error', error: "Model tried to call unavailable tool 'invalid'. Available tools: ." } } });
  setTimeout(() => line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'OK and again' } }), 4000);
  return;
}
line({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', tokens: { input: 12, output: 1 } } });`,
  );
  return { bin, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('opencode adapter: the tool-less agent and opencode.json are in its workspace before the spawn, and no --auto reaches it', async () => {
  const dir = tmp('opencode');
  const { bin, record } = opencodeStub(dir);
  const ws = path.join(dir, 'workspaces', 'opencode');
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: ws });
  const evts = await events(a.complete({ model: 'evren/glm-5.3', messages: [{ role: 'user', content: 'say hi' }] }));
  assert.equal(textOf(evts), 'OK');
  const r = record();
  assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(ws), 'its own empty workspace, not the gateway\'s cwd');
  assert.equal(r.pwd, ws, 'PWD says so too: opencode takes PWD as its project directory, and spawn() leaves the parent\'s');
  assert.ok(!r.argv.includes('--auto'));
  assert.equal(r.argv[r.argv.indexOf('--agent') + 1], 'keysmith-text');
  assert.equal(r.argv[r.argv.indexOf('--model') + 1], 'evren/glm-5.3');
  assert.deepEqual(r.argv.slice(-2), ['--', 'User: say hi']);
  assert.match(r.agent || '', /"\*": deny/, 'the agent file existed when opencode started');
  assert.deepEqual(r.config?.permission, { '*': 'deny' });
});

test('opencode adapter: a tool call after the answer ends the run; the free tier\'s 403 reaches the client with its reason', async () => {
  const dir = tmp('opencode-tool');
  const { bin } = opencodeStub(dir);
  const a = new CliAdapter('oc', { ...CLI_PROFILES.opencode, bin, cwd: path.join(dir, 'ws') });
  const t0 = Date.now();
  const cut = await events(a.complete({ model: '', messages: [{ role: 'user', content: 'tool' }] }));
  assert.equal(textOf(cut), 'OK', 'what it says after the call is not part of the reply');
  assert.deepEqual(cut.filter((e) => e.type === 'cut').map((e) => e.tool), ['bash']);
  assert.ok(Date.now() - t0 < 3_500, 'the process was stopped, not waited for');
  const gw = new Gateway({ adapters: {} });
  gw.adapters.set('oc', a);
  await assert.rejects(gw.collect({ model: 'oc/opencode/big-pickle', messages: [{ role: 'user', content: 'free model' }] }), /opencode 403: OpenCode's free tier can only be used from within OpenCode/);
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
  const restart = /still serves the config it started with — .* takes effect when it restarts: launchd: launchctl kickstart -k gui\/\d+\/dev\.keysmith\.gateway/;
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
  assert.doesNotMatch(quiet.all, /kickstart/, 'no gateway running, nothing to restart');
});
