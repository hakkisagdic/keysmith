#!/usr/bin/env node
/**
 * A stub of opencode, codex and qoder with an MCP server (test/bridge-clis.test.js), picked by
 * STUB_CLI. Each takes the session's MCP server the way its CLI was seen to take it in the
 * tool-bridge probes and live runs (2026-10-19/20), starts it (the real shim, so the hub is the
 * real one), speaks MCP to it and prints the CLI's own stream:
 *
 *   opencode  OPENCODE_CONFIG names a JSON config: `mcp.<server>` ({type: local, command[],
 *             environment, timeout}) and the agent `--agent` names, inline. It lists the tools,
 *             calls them at once (two calls of one step: two concurrent tools/call), and prints
 *             `opencode run --format json` lines — a `tool_use` line only when a call finished.
 *   codex     `-c mcp_servers.<server>.<key>=<TOML>` on its command line. A call to a server that
 *             is not `default_tools_approval_mode="approve"` is refused before it reaches the
 *             server ("requires approval, but approval policy is never"), as 0.163 did. Calls of
 *             one step go one after the other. Prints `codex exec --json` lines; `item.started`
 *             for a call comes before its tools/call.
 *   qoder     `--mcp-config <file>` (mcpServers). Calls one after the other. Prints
 *             `-o stream-json` lines: system init, assistant (tool_use blocks before the calls
 *             run), user (tool_result), result with usage.
 *
 * Without an MCP server it answers in plain text, as the CLI would with nothing to call. What it
 * does is picked by `SCENARIO=<name>` in its prompt (the last argv entry); a prompt that carries a
 * tool result (the cold path) is answered from it. Every event worth checking goes to
 * $CLI_BRIDGE_LOG as one JSON line with this process's pid: its argv, the env names it saw that
 * start with QODER_, the server it was given, each MCP result. Nothing here is a model.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const cli = process.env.STUB_CLI || 'opencode';
const prompt = argv.at(-1) ?? '';
const scenario = (prompt.match(/SCENARIO=([a-z0-9-]+)/) || [])[1] || 'one-call';
const LOG = process.env.CLI_BRIDGE_LOG;
const note = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, cli, ...o }) + '\n');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

note({ event: 'start', argv, scenario, qoderEnv: Object.keys(process.env).filter((k) => k.startsWith('QODER_')), opencodeConfig: process.env.OPENCODE_CONFIG || null });

/* --------------------------------------------------------- the session's MCP server */

/** The server the CLI was given, as `{ name, command, args, env, approve?, timeout? }`, or null. */
function serverOf() {
  if (cli === 'opencode') {
    const file = process.env.OPENCODE_CONFIG;
    if (!file || !fs.existsSync(file)) return null;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agent = cfg.agent?.[val('--agent')];
    note({ event: 'config', mode: (fs.statSync(file).mode & 0o777).toString(8), permission: cfg.permission, tools: cfg.tools, agent: agent ? { permission: agent.permission, tools: agent.tools, mode: agent.mode } : null, plugin: cfg.plugin });
    if (!agent) return null; // opencode answers an agent it cannot find with its default one: no bridge
    const [name, s] = Object.entries(cfg.mcp || {})[0] || [];
    if (!name || s.type !== 'local' || !Array.isArray(s.command)) return null;
    return { name, command: s.command[0], args: s.command.slice(1), env: s.environment || {}, timeout: s.timeout };
  }
  if (cli === 'codex') {
    const sets = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== '-c') continue;
      const m = argv[i + 1].match(/^mcp_servers\.([^.]+)\.(\w+)=(.*)$/s);
      if (m) (sets[m[1]] ??= {})[m[2]] = m[3];
    }
    const [name, s] = Object.entries(sets)[0] || [];
    if (!name) return null;
    note({ event: 'config', keys: Object.keys(s) });
    // TOML, as keysmith writes it: a basic string, an array of them, an inline table of them.
    const str = (v) => JSON.parse(v);
    const table = (v) => Object.fromEntries([...v.matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)].map(([, k, x]) => [k, JSON.parse(x)]));
    return { name, command: str(s.command), args: JSON.parse(s.args), env: table(s.env || '{}'), approve: s.default_tools_approval_mode === '"approve"', timeout: Number(s.tool_timeout_sec) };
  }
  if (cli === 'qoder') {
    const file = val('--mcp-config');
    if (!file) return null;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    note({ event: 'config', mode: (fs.statSync(file).mode & 0o777).toString(8), strict: argv.includes('--strict-mcp-config'), allowed: val('--allowed-tools'), settings: val('--settings'), sources: val('--setting-sources') });
    const [name, s] = Object.entries(cfg.mcpServers || {})[0] || [];
    return name ? { name, command: s.command, args: s.args || [], env: s.env || {} } : null;
  }
  return null;
}

const server = serverOf();
note({ event: 'server', server: server && { ...server, env: Object.keys(server.env) } });

/* --------------------------------------------------------------- output, per CLI */

const out = {
  opencode: {
    begin() {
      line({ type: 'step_start', sessionID: 'ses_stub', part: { type: 'step-start' } });
    },
    text(t) {
      line({ type: 'text', sessionID: 'ses_stub', part: { type: 'text', text: t } });
    },
    announce() {},
    finished(name, args, output, id) {
      line({ type: 'tool_use', sessionID: 'ses_stub', part: { type: 'tool', tool: name, callID: id, state: { status: 'completed', input: args, output } } });
    },
    step(reason, tokens) {
      line({ type: 'step_finish', sessionID: 'ses_stub', part: { type: 'step-finish', reason, tokens: { input: tokens[0], output: tokens[1], reasoning: 0, cache: { read: 0, write: 0 } } } });
    },
    end() {},
  },
  codex: {
    n: 0,
    begin() {
      line({ type: 'thread.started', thread_id: 'th-stub' });
      line({ type: 'turn.started' });
    },
    text(t) {
      line({ type: 'item.completed', item: { id: `item_${this.n++}`, type: 'agent_message', text: t } });
    },
    announce(name, args, id) {
      line({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: server?.name, tool: name, arguments: args, result: null, error: null, status: 'in_progress' } });
    },
    finished(name, args, output, id, error = null) {
      line({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: server?.name, tool: name, arguments: args, result: error ? null : { content: [{ type: 'text', text: output }] }, error: error ? { message: error } : null, status: error ? 'failed' : 'completed' } });
    },
    step() {},
    end(tokens) {
      line({ type: 'turn.completed', usage: { input_tokens: tokens[0], cached_input_tokens: 0, output_tokens: tokens[1], reasoning_output_tokens: 0 } });
    },
  },
  qoder: {
    begin() {
      line({ type: 'system', subtype: 'init', tools: server ? [`mcp__${server.name}__get_weather`] : [], mcp_servers: server ? [{ name: server.name, status: 'connected' }] : [] });
    },
    text(t) {
      line({ type: 'assistant', message: { id: `msg_${Math.random().toString(16).slice(2)}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
    },
    announce(name, args, id, via = null) {
      const block = via ? { type: 'tool_use', id, name: 'mcp_call', input: { toolName: `mcp__${server.name}__${name}`, arguments: args } } : { type: 'tool_use', id, name: `mcp__${server.name}__${name}`, input: args };
      line({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [block], stop_reason: 'tool_use' } });
    },
    finished(name, args, output, id) {
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    },
    step() {},
    end(tokens, result) {
      line({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: tokens[0], output_tokens: tokens[1] } });
    },
  },
}[cli];

/* ------------------------------------------------------------------------ the run */

out.begin();
if (!server) {
  out.text('plain answer, no tools here');
  out.end([10, 2], 'plain answer, no tools here');
  process.exit(0);
}

const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
note({ event: 'shim', shimPid: mcp.pid });
let nextId = 1;
const waiting = new Map();
readline.createInterface({ input: mcp.stdout }).on('line', (l) => {
  let msg;
  try {
    msg = JSON.parse(l);
  } catch {
    return;
  }
  if (msg.id !== undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  } else if (msg.method) note({ event: 'notification', method: msg.method });
});
mcp.on('exit', (code) => {
  note({ event: 'shim-exit', code });
  for (const resolve of waiting.values()) resolve({ error: { code: -1, message: 'the MCP server exited' } });
  waiting.clear();
});
const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `${cli}-stub`, version: '0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
note({ event: 'mcp', protocolVersion: init.result?.protocolVersion ?? null, tools: list.result?.tools?.map((t) => t.name) ?? null });

let seq = 0;
/** One call: shown (where the CLI shows it first), sent, its result read, shown finished. */
async function call(name, args, { via = null } = {}) {
  const id = `call_${++seq}`;
  out.announce(name, args, id, via);
  if (cli === 'codex' && !server.approve) {
    // codex 0.163: with approval_policy "never", an MCP tool that is not approved is refused here.
    out.finished(name, args, null, id, 'MCP tool call requires approval, but approval policy is never');
    note({ event: 'refused', name });
    return { text: null, refused: true };
  }
  const r = await rpc('tools/call', { name, arguments: args, _meta: { progressToken: `tok-${id}` } });
  const text = (r.result?.content || []).map((c) => c.text).join('');
  note({ event: 'result', name, isError: !!r.result?.isError, text });
  out.finished(cli === 'opencode' ? `${server.name}_${name}` : name, args, text, id);
  return { text, isError: !!r.result?.isError };
}
function finish(answer) {
  out.step('tool-calls', [1000, 20]);
  out.text(answer);
  out.step('stop', [100, 10]);
  out.end([1100, 30], answer);
  note({ event: 'final', answer });
  mcp.stdin.end();
  setTimeout(() => process.exit(0), 50);
}

if (prompt.includes('<<<TOOL_RESULT')) {
  const results = [...prompt.matchAll(/<<<TOOL_RESULT [^>]*>>>\n([\s\S]*?)\n<<<END [0-9a-f]+>>>/g)].map((m) => m[1]);
  note({ event: 'cold', results });
  finish(`From the history: ${results.join(' | ')}`);
} else {
  switch (scenario) {
    case 'one-call': {
      if (cli !== 'opencode') out.text('Let me check. ');
      const r = await call('get_weather', { city: 'Ankara' });
      finish(r.refused ? 'I could not reach the weather tool: it needs an approval nobody can give.' : `Weather: ${r.text}`);
      break;
    }
    case 'two-calls': {
      // opencode runs the calls of one step at once; codex and qoder one after the other.
      const [a, b] = cli === 'opencode'
        ? await Promise.all([call('get_weather', { city: 'Ankara' }), call('get_weather', { city: 'Izmir' })])
        : [await call('get_weather', { city: 'Ankara' }), await call('get_weather', { city: 'Izmir' })];
      finish(`Ankara ${a.text}; Izmir ${b.text}`);
      break;
    }
    case 'lazy': {
      // qoder with QODER_MCP_LAZY: the schema through mcp_get, the call through mcp_call.
      line({ type: 'assistant', message: { id: 'msg_get', role: 'assistant', content: [{ type: 'tool_use', id: 'call_get', name: 'mcp_get', input: { toolName: `mcp__${server.name}__get_weather` } }] } });
      const r = await call('get_weather', { city: 'Ankara' }, { via: 'mcp_call' });
      finish(`Weather: ${r.text}`);
      break;
    }
    case 'invalid-tool': {
      // opencode's own `invalid` tool: a call to a tool it does not have, answered with an error; the model goes on.
      out.finished('invalid', { tool: 'bash' }, 'Invalid tool', 'call_invalid');
      const r = await call('get_weather', { city: 'Ankara' });
      finish(`Weather: ${r.text}`);
      break;
    }
    case 'foreign': {
      // A tool of the CLI's own, shown in its stream.
      if (cli === 'opencode') out.finished('bash', { command: 'ls' }, 'a.txt', 'call_bash');
      else if (cli === 'codex') line({ type: 'item.started', item: { id: 'item_x', type: 'command_execution', command: 'ls', status: 'in_progress' } });
      else line({ type: 'assistant', message: { id: 'msg_x', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] } });
      note({ event: 'hang' });
      await sleep(60_000);
      break;
    }
    case 'hang-after-call': {
      const r = await call('get_weather', { city: 'Ankara' });
      note({ event: 'after-result', text: r.text });
      await sleep(60_000);
      break;
    }
    default:
      finish(`no scenario ${scenario}`);
  }
}
