#!/usr/bin/env node
/**
 * An agy-shaped stub for the MCP bridge (test/bridge-agy.test.js). Run with a bridge agent
 * (`--agent ks-b-…`) it does what agy 1.4.2 was seen to do with an MCP server in its agent:
 *
 *  - reads the agent file from `.agents/agents/<agent>.md` under its cwd — an agent it cannot
 *    find is `unknown agent` on stderr and exit 1 — and takes its `mcpServers` only when they
 *    are a LIST, each tool marked `eager: true`
 *  - writes the server's schemas under $STUB_MCP_CACHE/<server>/ (agy: ~/.gemini/antigravity-cli/mcp)
 *  - starts the server's command (the real shim) with its env, and speaks MCP to it: server/discover
 *    (refused), initialize, notifications/initialized, tools/list
 *  - prints what `agy --output-format stream-json` prints: init, step_update (agent_response with
 *    per-step usage; a tool step `mcp_<server>_<tool>` ACTIVE then DONE), result
 *  - makes tools/call, waits for the result, and goes on; several calls of one step one after
 *    the other
 *
 * What it does is picked by `SCENARIO=<name>` in its prompt. A prompt that carries a tool result
 * (the cold path) is answered from it, the way a model reads its transcript. Every event worth
 * checking is appended to $AGY_BRIDGE_LOG as one JSON line with this process's pid.
 *
 * Run with any other agent (EMULATE's `keysmith-tools`, the text agent) it is the EMULATE stub,
 * test/stubs/agy-emu.mjs. Nothing here is a model.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const agent = val('--agent') || '';

if (!agent.startsWith('ks-b-')) {
  await import('./agy-emu.mjs');
} else {
  await bridge();
}

async function bridge() {
  const prompt = val('-p') ?? '';
  const scenario = (prompt.match(/SCENARIO=([a-z0-9-]+)/) || [])[1] || 'one-call';
  const LOG = process.env.AGY_BRIDGE_LOG;
  const note = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n');
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const conversation = `c-${process.pid}`;
  let stepIndex = 1;

  note({ event: 'start', argv, agent, prompt, scenario, printTimeout: val('--print-timeout'), model: val('--model') });
  if (scenario === 'unknown-agent') {
    process.stderr.write(`Error: unknown agent "${agent}"\n`);
    process.exit(1);
  }
  const file = path.join(process.cwd(), '.agents', 'agents', `${agent}.md`);
  if (!fs.existsSync(file)) {
    process.stderr.write(`Error: unknown agent "${agent}"\n`);
    process.exit(1);
  }
  const text = fs.readFileSync(file, 'utf8');
  const cfg = parseAgent(text);
  note({ event: 'agent', file, mode: (fs.statSync(file).mode & 0o777).toString(8), front: cfg.front, server: cfg.server && { ...cfg.server, env: Object.keys(cfg.server.env) } });

  const usage1 = { input_tokens: 1000, output_tokens: 20, thinking_tokens: 0, total_tokens: 1020 };
  const usage2 = { input_tokens: 1100, output_tokens: 30, thinking_tokens: 0, total_tokens: 1130 };
  const step = (o) => line({ event: 'step_update', step_update: { conversation_id: conversation, ...o } });
  const respond = (delta, usage) => {
    const at = stepIndex++;
    if (delta) step({ step_index: at, state: 'ACTIVE', step_type: 'agent_response', text_delta: delta });
    step({ step_index: at, state: 'DONE', step_type: 'agent_response', ...(usage ? { usage } : {}) });
  };
  const result = (response) => {
    line({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response, usage: { input_tokens: 99999, output_tokens: 99999 } } });
  };

  line({ event: 'init', conversation_id: conversation, init: { model: val('--model'), agent, tools: ['manage_task'] } });
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' });

  if (scenario === 'never-ready') {
    note({ event: 'hang' });
    await sleep(60_000);
    process.exit(0);
  }
  if (scenario === 'no-bridge' || !cfg.server) {
    // agy with an agent whose servers it did not read: it answers without the bridge's tools.
    respond('plain answer, no tools here', usage1);
    result('plain answer, no tools here');
    process.exit(0);
  }

  // agy runs helpers of its own (a language server, a browser): one that ignores its stdin and
  // only ends with the process group, as keysmith must end them.
  const helper = spawn(process.execPath, ['-e', 'process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  note({ event: 'helper', helperPid: helper.pid });

  const server = cfg.server;
  if (process.env.STUB_MCP_CACHE) {
    const dir = path.join(process.env.STUB_MCP_CACHE, server.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tools.json'), '[]');
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
      return note({ event: 'junk', line: l.slice(0, 200) });
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.method) {
      note({ event: 'notification', method: msg.method, params: msg.params });
    }
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
  const notify = (method, params = {}) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  const discover = await rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  const init = await rpc('initialize', { clientInfo: { name: 'antigravity-client', version: 'v1.0.0' }, protocolVersion: '2025-11-25', capabilities: {} });
  notify('notifications/initialized', {});
  const list = await rpc('tools/list', {});
  note({ event: 'mcp', discover: discover.error?.code ?? null, protocolVersion: init.result?.protocolVersion ?? null, tools: list.result?.tools ?? null, error: list.error ?? null });
  if (!list.result) {
    respond('the bridge refused me', usage1);
    result('the bridge refused me');
    process.exit(0);
  }
  const eager = new Set(Object.entries(server.tools).filter(([, t]) => t.eager).map(([n]) => n));

  /** One tool call as agy makes it: the step ACTIVE, tools/call, the step DONE with its output. */
  const call = async (name, args, { cancel = false } = {}) => {
    const at = stepIndex++;
    const shown = eager.has(name) ? `mcp_${server.name}_${name}` : 'call_mcp_tool';
    step({ step_index: at, state: 'ACTIVE', step_type: 'tool', tool_name: shown, tool_info: { name: shown, parameters: args } });
    const pending = rpc('tools/call', { _meta: { progressToken: `tok-${at}`, 'antigravity.google/conversation_id': conversation }, name, arguments: args });
    if (cancel) {
      await sleep(100);
      notify('notifications/cancelled', { requestId: nextId - 1, reason: 'the user stopped it' });
    }
    const r = await pending;
    const out = (r.result?.content || []).map((c) => c.text).join('');
    note({ event: 'result', name, isError: !!r.result?.isError, text: out, error: r.error ?? null });
    step({ step_index: at, state: 'DONE', step_type: 'tool', tool_name: shown, tool_info: { name: shown, parameters: args, output: out } });
    return { text: out, isError: !!r.result?.isError, error: r.error };
  };
  const finish = (answer) => {
    const half = Math.ceil(answer.length / 2);
    const at = stepIndex++;
    step({ step_index: at, state: 'ACTIVE', step_type: 'agent_response', text_delta: answer.slice(0, half) });
    step({ step_index: at, state: 'DONE', step_type: 'agent_response', text_delta: answer.slice(half), usage: usage2 });
    result(answer);
    note({ event: 'final', answer });
    mcp.stdin.end();
    setTimeout(() => process.exit(0), 50);
  };

  if (prompt.includes('<<<TOOL_RESULT')) {
    // The cold path: the conversation so far is in the prompt, results and all.
    const results = [...prompt.matchAll(/<<<TOOL_RESULT [^>]*>>>\n([\s\S]*?)\n<<<END [0-9a-f]+>>>/g)].map((m) => m[1]);
    note({ event: 'cold', results });
    if (scenario === 'cold-call') {
      respond('', usage1);
      const r = await call('get_weather', { city: 'Izmir' });
      return finish(`Weather again: ${r.text}`);
    }
    return finish(`From the history: ${results.join(' | ')}`);
  }

  switch (scenario) {
    case 'one-call': {
      respond('', usage1);
      const r = await call('get_weather', { city: 'Ankara' });
      return finish(`Weather: ${r.text}`);
    }
    case 'preamble': {
      respond('Let me check. ', usage1);
      const r = await call('get_weather', { city: 'Ankara' });
      return finish(`Weather: ${r.text}`);
    }
    case 'three-calls': {
      // One model step, three calls: agy runs them one after the other.
      respond('', usage1);
      const a = await call('get_weather', { city: 'Ankara' });
      const b = await call('get_weather', { city: 'Izmir' });
      const c = await call('get_weather', { city: 'Bursa' });
      return finish(`Ankara ${a.text}; Izmir ${b.text}; Bursa ${c.text}`);
    }
    case 'slow-final': {
      respond('', usage1);
      const r = await call('get_weather', { city: 'Ankara' });
      await sleep(1500);
      return finish(`Weather: ${r.text}`);
    }
    case 'injected': {
      respond('', usage1);
      const r = await call('get_weather', { city: 'Ankara', toolSummary: 'Looking up the weather', toolAction: 'Weather lookup' });
      return finish(`Weather: ${r.text}`);
    }
    case 'self-correct': {
      respond('', usage1);
      const bad = await call('get_weather', { city: 7 });
      note({ event: 'refused', text: bad.text });
      const r = await call('get_weather', { city: 'Ankara' });
      return finish(`Weather: ${r.text}`);
    }
    case 'invalid': {
      respond('', usage1);
      // A model that keeps getting the arguments wrong (agy only lets it call a tool it lists).
      for (let i = 0; i < 5; i++) await call('get_weather', i % 2 ? {} : { city: 7 });
      return finish('gave up');
    }
    case 'foreign': {
      respond('', usage1);
      step({ step_index: stepIndex++, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } });
      note({ event: 'hang' });
      return void (await sleep(60_000));
    }
    case 'foreign-while-waiting': {
      // The call goes out and waits; while it waits, the next call of the step — a tool of agy's
      // own — shows in the stream (FOREIGN_AFTER=<ms> in the prompt, 300 by default). Whatever
      // comes back for the first call is recorded (`result`), and so is "running" the second.
      respond('', usage1);
      const after = Number((prompt.match(/FOREIGN_AFTER=(\d+)/) || [])[1] || 300);
      const pending = call('get_weather', { city: 'Ankara' });
      await sleep(after);
      step({ step_index: stepIndex++, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'cat ~/.ssh/id_ed25519' } } });
      note({ event: 'foreign-shown' });
      await pending;
      note({ event: 'ran-foreign' });
      return void (await sleep(60_000));
    }
    case 'answer-then-manage-task': {
      respond('', usage1);
      const r = await call('get_weather', { city: 'Ankara' });
      const at = stepIndex++;
      step({ step_index: at, state: 'ACTIVE', step_type: 'agent_response', text_delta: `Weather: ${r.text}` });
      step({ step_index: at, state: 'DONE', step_type: 'agent_response', usage: usage2 });
      step({ step_index: stepIndex++, state: 'ACTIVE', step_type: 'tool', tool_name: 'manage_task', tool_info: { name: 'manage_task', parameters: { Action: 'list' } } });
      note({ event: 'hang' });
      return void (await sleep(60_000));
    }
    case 'exit-after-ready': {
      process.stderr.write('agy: something broke\n');
      process.exit(3);
      return;
    }
    case 'cancel': {
      respond('', usage1);
      await call('get_weather', { city: 'Ankara' }, { cancel: true });
      return void (await sleep(60_000));
    }
    case 'step-then-hang': {
      // A model step spent (its usage reported), then nothing: no text, no call.
      respond('', usage1);
      note({ event: 'hang' });
      return void (await sleep(60_000));
    }
    case 'text-then-hang': {
      const at = stepIndex++;
      step({ step_index: at, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Thinking out loud, ' });
      note({ event: 'hang' });
      return void (await sleep(60_000));
    }
    default:
      return finish(`no scenario ${scenario}`);
  }
}

/**
 * The bridge agent's frontmatter, read the way this stub expects keysmith to write it: plain
 * `key: value` lines, and `mcpServers:` as a list whose entry has JSON-quoted scalars. Not a YAML
 * parser — a check that the file is what agy was seen to read.
 */
function parseAgent(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { front: null, server: null };
  const lines = m[1].split('\n');
  const front = {};
  let i = 0;
  for (; i < lines.length && lines[i] !== 'mcpServers:'; i++) {
    const kv = lines[i].match(/^(\w+): (.*)$/);
    if (kv) front[kv[1]] = kv[2];
  }
  if (i >= lines.length) return { front, server: null };
  const rest = lines.slice(i + 1);
  // A map of servers (`  ks…:`) is not read: agy 1.4.2 takes a list.
  if (!rest[0]?.startsWith('  - name: ')) return { front, server: null };
  const server = { name: JSON.parse(rest[0].slice('  - name: '.length)), command: null, args: [], env: {}, tools: {} };
  let section = null;
  let tool = null;
  for (const l of rest.slice(1)) {
    if (/^ {4}command: /.test(l)) server.command = JSON.parse(l.slice(13));
    else if (/^ {4}args: /.test(l)) server.args = JSON.parse(l.slice(10));
    else if (l === '    env:') section = 'env';
    else if (l === '    tools:') section = 'tools';
    else if (section === 'env' && /^ {6}\w+: /.test(l)) {
      const [, k, v] = l.match(/^ {6}(\w+): (.*)$/);
      server.env[k] = JSON.parse(v);
    } else if (section === 'tools' && /^ {6}".*":$/.test(l)) {
      tool = JSON.parse(l.trim().slice(0, -1));
      server.tools[tool] = { eager: false };
    } else if (section === 'tools' && l === '        eager: true' && tool) {
      server.tools[tool].eager = true;
    }
  }
  return { front, server };
}
