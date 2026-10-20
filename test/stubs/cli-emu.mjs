#!/usr/bin/env node
/**
 * One stub for the EMULATE runs of the CLIs that are not agy (test/tools-emulate-clis.test.js):
 * it prints the stdout of the CLI its STUB_FORMAT names, the way the parser of that profile reads
 * it, and answers the JSON tool protocol from a script picked by `SCENARIO=<name>` in its prompt.
 *
 *   opencode   `opencode run --format json`: step_start, text (the whole block), step_finish with
 *              tokens; a tool call is a `tool_use` line (`part.tool`, `part.callID`)
 *   raw        `codex exec` and `qodercli -p`: the final message, and nothing else
 *   claude     `qodercli -p -o stream-json` (claude-stream-json): an assistant message, a result
 *              line with usage; a tool call is a `tool_use` content block
 *   kiro       `kiro-cli chat --output-format stream-json`: runStarted, metadata, ACP
 *              agent_message_chunk updates, runFinished; a tool call is an ACP `tool_call` update
 *
 * The prompt is the last argv entry, as every one of those profiles puts it. A prompt that carries
 * a tool result (`<<<TOOL_RESULT …>>>`) is the second turn of a round trip and is answered from
 * the results, the way a model reads its transcript. A prompt that starts with the engine's
 * correction line is the second try of one turn. Each run is appended to $CLI_EMU_LOG as one JSON
 * line: the format, the argv, the prompt, the pid. Nothing here is a model.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? '';
const format = process.env.STUB_FORMAT || 'raw';
const scenario = (prompt.match(/SCENARIO=([a-z0-9-]+)/) || [])[1] || 'round-trip';
const second = prompt.startsWith('Your previous reply could not be used');
const results = [...prompt.matchAll(/<<<TOOL_RESULT [^>]*>>>\n([\s\S]*?)\n<<<END [0-9a-f]+>>>/g)].map((m) => m[1]);
const record = { format, argv, prompt, pid: process.pid, scenario, second, results };
if (process.env.CLI_EMU_LOG) fs.appendFileSync(process.env.CLI_EMU_LOG, JSON.stringify(record) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const calls = (...list) => JSON.stringify({ tool_calls: list.map(([name, args]) => ({ name, arguments: args })) });
const ANKARA = calls(['get_weather', { city: 'Ankara' }]);

/** The reply this run gives, and what goes around it: a tool call of the CLI's own before or after. */
function plan() {
  if (results.length) return { reply: JSON.stringify({ final: `Weather: ${results.join(' | ')}` }) };
  switch (scenario) {
    case 'two-calls':
      return { reply: calls(['get_weather', { city: 'Ankara' }], ['get_weather', { city: 'Izmir' }]) };
    case 'fenced':
      return { reply: '```json\n' + ANKARA + '\n```' };
    case 'prose-then-ok':
      return { reply: second ? ANKARA : `Sure, here it is: ${ANKARA}` };
    case 'prose-always':
      return { reply: 'I would call get_weather now.' };
    case 'tool-before':
      // The model reached for a tool of the CLI's own first (refused: the agent has none), then wrote the reply.
      return { reply: ANKARA, before: 'bash' };
    case 'tool-after':
      // The reply, then a call of the CLI's own and — if nothing stops the run — a second answer.
      return { reply: ANKARA, after: 'bash' };
    case 'final':
      return { reply: JSON.stringify({ final: 'It is sunny in Ankara.' }) };
    default:
      return { reply: ANKARA };
  }
}

const { reply, before = null, after = null } = plan();
const usage = second ? { input: 1100, output: 30 } : { input: 1000, output: 20 };
const writers = { opencode, raw, claude, kiro };
await (writers[format] || raw)();

async function opencode() {
  const session = 'ses_stub';
  const part = (o) => ({ sessionID: session, part: { sessionID: session, ...o } });
  line({ type: 'step_start', ...part({ type: 'step-start' }) });
  if (before) line({ type: 'tool_use', ...part({ type: 'tool', tool: before, callID: 'call_before', state: { status: 'error', error: 'unavailable tool' } }) });
  line({ type: 'text', ...part({ type: 'text', text: reply }) });
  line({ type: 'step_finish', ...part({ type: 'step-finish', reason: 'stop', tokens: { input: usage.input, output: usage.output, reasoning: 0, cache: { read: 0, write: 0 } } }) });
  if (after) {
    line({ type: 'tool_use', ...part({ type: 'tool', tool: after, callID: 'call_after', state: { status: 'error', error: 'unavailable tool' } }) });
    await sleep(30_000);
    line({ type: 'text', ...part({ type: 'text', text: ' and again' }) });
  }
}

async function raw() {
  process.stdout.write(reply + '\n');
}

async function claude() {
  const id = 'msg_stub';
  const message = (content) => ({ type: 'assistant', message: { id, type: 'message', role: 'assistant', content, usage: { input_tokens: 0, output_tokens: 0 } } });
  if (before) line(message([{ type: 'tool_use', id: 'toolu_before', name: before, input: {} }]));
  line(message([{ type: 'text', text: reply }]));
  if (after) {
    line({ type: 'assistant', message: { id: 'msg_stub_2', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_after', name: after, input: {} }] } });
    await sleep(30_000);
  }
  line({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: 'qs-stub', usage: { input_tokens: usage.input, output_tokens: usage.output } });
}

async function kiro() {
  const sessionId = 'ks-stub';
  const update = (u) => line({ type: 'sessionUpdate', data: { sessionId, update: u } });
  line({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } });
  line({ type: 'metadata', data: { sessionId, contextUsagePercentage: 0.7 } });
  if (before) update({ sessionUpdate: 'tool_call', toolCallId: 'tc-before', title: before, kind: 'execute', status: 'failed' });
  const half = Math.ceil(reply.length / 2);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, half) } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(half) } });
  if (after) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-after', title: after, kind: 'execute', status: 'pending' });
    await sleep(30_000);
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' and again' } });
  }
  line({ type: 'runFinished', data: { finalText: reply, finalTextTruncated: false } });
}
