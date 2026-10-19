#!/usr/bin/env node
/**
 * An agy-shaped stub for the EMULATE engine: it prints what `agy --output-format stream-json -p`
 * prints (init, agent_response step updates with per-step usage, result) and answers from a
 * script picked by `SCENARIO=<name>` anywhere in its prompt. A prompt that starts with the
 * engine's correction line is the second try. Each run is appended to $AGY_EMU_LOG as one JSON
 * line: argv, the --agent it was given, the prompt, its pid, and when each of its text deltas
 * went out.
 *
 * Nothing here is a model: a scenario is the reply a model gave, or might give.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const at = argv.indexOf('-p');
const prompt = at >= 0 ? argv[at + 1] ?? '' : '';
const agent = argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null;
const second = prompt.startsWith('Your previous reply could not be used');
const scenario = (prompt.match(/SCENARIO=([a-z0-9-]+)/) || [])[1] || 'one-call';
const record = { argv, agent, prompt, pid: process.pid, scenario, second, deltas: [] };
const log = () => process.env.AGY_EMU_LOG && fs.appendFileSync(process.env.AGY_EMU_LOG, JSON.stringify(record) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const call = (name, args) => ({ name, arguments: args });
const calls = (...list) => JSON.stringify({ tool_calls: list });
const ANKARA = calls(call('get_weather', { city: 'Ankara' }));

/** Scenario -> [first reply, second reply]; a reply is text, or an object for the odd ones. */
const SCRIPTS = {
  'one-call': [ANKARA],
  'two-calls': [calls(call('get_weather', { city: 'Ankara' }), call('get_weather', { city: 'Izmir' }))],
  final: [JSON.stringify({ final: 'It is sunny in Ankara.' })],
  content: [JSON.stringify({ content: 'content is final' })],
  fenced: ['```json\n' + ANKARA + '\n```'],
  'with-id': [JSON.stringify({ tool_calls: [{ id: 'call_model_wrote_this', type: 'function', name: 'get_weather', arguments: { city: 'Ankara' } }] })],
  'prose-then-ok': ['Sure, let me check the weather for you: ' + ANKARA, ANKARA],
  'prose-always': ['I would call get_weather now.', 'Still prose, sorry.'],
  'required-final': [JSON.stringify({ final: 'no call' }), ANKARA],
  'named-wrong': [calls(call('get_time', {})), ANKARA],
  'parallel-two': [calls(call('get_weather', { city: 'Ankara' }), call('get_weather', { city: 'Izmir' })), ANKARA],
  'unknown-tool': [calls(call('launch_rocket', {})), ANKARA],
  'bad-args': [calls(call('get_weather', { city: 7 })), ANKARA],
  'tool-denied': [{ denied: true }, ANKARA],
  'manage-task': [{ text: ANKARA, thenTool: 'manage_task' }],
  'slow-deltas': [{ chunks: [ANKARA.slice(0, 10), ANKARA.slice(10, 30), ANKARA.slice(30)], gapMs: 300 }],
  'slow-prose': [{ text: 'prose', delayMs: 1500 }, ANKARA],
  'slow-prose-always': [{ text: 'prose', delayMs: 400 }, { text: 'prose again', delayMs: 400 }],
  'prose-then-hang': ['prose', { hang: true }],
  'slow-prose-then-hang': [{ text: 'prose', delayMs: 1500 }, { hang: true }],
  'exit-1': [{ exit: 1, stderr: 'agy: unknown agent "keysmith-tools"' }],
  'status-error': [{ status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota' }],
  plain: [{ text: 'plain answer' }],
};

const script = SCRIPTS[scenario] || SCRIPTS['one-call'];
const reply = second && script.length > 1 ? script[1] : script[0];
const usage = second ? { input_tokens: 1100, output_tokens: 30 } : { input_tokens: 1000, output_tokens: 20 };

const step = (text, withUsage) => {
  record.deltas.push(Date.now());
  line({ event: 'step_update', step_update: { conversation_id: 'c-emu', step_index: 1, step_type: 'agent_response', state: withUsage ? 'DONE' : 'ACTIVE', text_delta: text, ...(withUsage ? { usage } : {}) } });
};

line({ event: 'init', conversation_id: 'c-emu', init: { model: 'stub', tools: [] } });
if (typeof reply === 'string') {
  step(reply, true);
  line({ event: 'result', result: { conversation_id: 'c-emu', status: 'SUCCESS', response: reply } });
} else if (reply.denied) {
  line({ event: 'step_update', step_update: { conversation_id: 'c-emu', step_type: 'agent_response', state: 'DONE', usage } });
  line({ event: 'result', result: { conversation_id: 'c-emu', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
} else if (reply.chunks) {
  for (let i = 0; i < reply.chunks.length; i++) {
    step(reply.chunks[i], i === reply.chunks.length - 1);
    if (i < reply.chunks.length - 1) await sleep(reply.gapMs);
  }
  line({ event: 'result', result: { conversation_id: 'c-emu', status: 'SUCCESS', response: reply.chunks.join('') } });
} else if (reply.thenTool) {
  step(reply.text, true);
  line({ event: 'step_update', step_update: { conversation_id: 'c-emu', step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: reply.thenTool } });
  log();
  // A model that started over: it would answer again after the tool, for as long as it is let.
  await sleep(30_000);
  step(' and again', true);
} else if (reply.hang) {
  log();
  await sleep(120_000);
} else if (reply.exit) {
  log();
  process.stderr.write(reply.stderr + '\n');
  process.exit(reply.exit);
} else if (reply.status) {
  line({ event: 'result', result: { conversation_id: 'c-emu', status: reply.status, error: reply.error } });
} else {
  if (reply.delayMs) await sleep(reply.delayMs);
  step(reply.text, true);
  line({ event: 'result', result: { conversation_id: 'c-emu', status: 'SUCCESS', response: reply.text } });
}
log();
