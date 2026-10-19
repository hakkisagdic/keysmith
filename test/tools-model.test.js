/**
 * The canonical tool model (src/tools/model.js): what an OpenAI or Anthropic body says about
 * tools and tool turns, read into one shape — and a tool-less request read exactly the way
 * keysmith has always read it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { anthropicMessages, openaiMessages } from '../src/protocols.js';
import { flattenMessages } from '../src/util.js';
import {
  FINISH_TOOL_CALLS,
  anthropicToolMessages,
  anthropicToolSpec,
  newToolCallId,
  newToolItemId,
  openaiToolMessages,
  openaiToolSpec,
  plainMessages,
  toolCallEvent,
} from '../src/tools/model.js';

const fn = (name, parameters, description) => ({ type: 'function', function: { name, ...(description ? { description } : {}), ...(parameters ? { parameters } : {}) } });
const WEATHER = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

/* -------------------------------------------------------------- OpenAI: messages */

test('OpenAI messages: string and block content, null content with tool_calls, several tool results', () => {
  const body = {
    messages: [
      { role: 'developer', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Ankara and Izmir?' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ankara"}' } },
          { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Izmir"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"temp":21}' },
      { role: 'tool', tool_call_id: 'call_b', name: 'get_weather', content: [{ type: 'text', text: '{"temp":' }, { type: 'text', text: '25}' }] },
      { role: 'assistant', content: 'Ankara 21, Izmir 25.' },
    ],
  };
  assert.deepEqual(openaiToolMessages(body), [
    { role: 'system', text: 'Be terse.' },
    { role: 'user', text: 'Weather in Ankara and Izmir?' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'call_a', name: 'get_weather', arguments: '{"city":"Ankara"}', args: { city: 'Ankara' } },
        { id: 'call_b', name: 'get_weather', arguments: '{"city": "Izmir"}', args: { city: 'Izmir' } },
      ],
    },
    { role: 'tool', text: '{"temp":21}', toolCallId: 'call_a' },
    { role: 'tool', text: '{"temp":\n25}', toolCallId: 'call_b', name: 'get_weather' },
    { role: 'assistant', text: 'Ankara 21, Izmir 25.' },
  ]);
});

test('OpenAI messages: a preamble next to the calls, arguments that are not JSON, a call with no id', () => {
  const [m] = openaiToolMessages({
    messages: [
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          { id: 'call_x', type: 'function', function: { name: 'lookup', arguments: '{not json' } },
          { type: 'function', function: { name: 'lookup', arguments: '[1,2]' } },
          { id: 'call_z', type: 'function', function: { name: 'lookup', arguments: { already: 'an object' } } },
        ],
      },
    ],
  });
  assert.equal(m.text, 'Let me look.');
  assert.deepEqual(m.toolCalls, [
    { id: 'call_x', name: 'lookup', arguments: '{not json', args: null },
    { id: null, name: 'lookup', arguments: '[1,2]', args: null },
    { id: 'call_z', name: 'lookup', arguments: '{"already":"an object"}', args: { already: 'an object' } },
  ]);
});

test('OpenAI messages: the older function_call and function-role turns map onto the same shape', () => {
  assert.deepEqual(
    openaiToolMessages({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, function_call: { name: 'get_weather', arguments: '{"city":"Bursa"}' } },
        { role: 'function', name: 'get_weather', content: 'sunny' },
      ],
    }),
    [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '', toolCalls: [{ id: null, name: 'get_weather', arguments: '{"city":"Bursa"}', args: { city: 'Bursa' } }] },
      { role: 'tool', text: 'sunny', toolCallId: null, name: 'get_weather' },
    ],
  );
});

/* ----------------------------------------------------------- Anthropic: messages */

test('Anthropic messages: tool_use blocks are the turn\'s calls, every tool_result its own tool turn, in block order', () => {
  const body = {
    system: [{ type: 'text', text: 'Be terse.' }],
    messages: [
      { role: 'user', content: 'Weather in Ankara and Izmir?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking both.' },
          { type: 'tool_use', id: 'toolu_a', name: 'get_weather', input: { city: 'Ankara' } },
          { type: 'tool_use', id: 'toolu_b', name: 'get_weather', input: { city: 'Izmir' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: '{"temp":21}' },
          { type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: [{ type: 'text', text: 'station offline' }, { type: 'image', source: {} }] },
          { type: 'text', text: 'Also: is it raining?' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c', name: 'get_rain', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c' }] },
    ],
  };
  assert.deepEqual(anthropicToolMessages(body), [
    { role: 'system', text: 'Be terse.' },
    { role: 'user', text: 'Weather in Ankara and Izmir?' },
    {
      role: 'assistant',
      text: 'Checking both.',
      toolCalls: [
        { id: 'toolu_a', name: 'get_weather', arguments: '{"city":"Ankara"}', args: { city: 'Ankara' } },
        { id: 'toolu_b', name: 'get_weather', arguments: '{"city":"Izmir"}', args: { city: 'Izmir' } },
      ],
    },
    { role: 'tool', text: '{"temp":21}', toolCallId: 'toolu_a' },
    { role: 'tool', text: 'station offline\n[image omitted by keysmith]', toolCallId: 'toolu_b', isError: true },
    { role: 'user', text: 'Also: is it raining?' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_c', name: 'get_rain', arguments: '{}', args: {} }] },
    { role: 'tool', text: '', toolCallId: 'toolu_c' },
  ]);
});

test('Anthropic messages: text before a tool_result stays before it', () => {
  assert.deepEqual(
    anthropicToolMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'r' }, { type: 'text', text: 'last' }] }] }),
    [
      { role: 'user', text: 'first' },
      { role: 'tool', text: 'r', toolCallId: 'toolu_1' },
      { role: 'user', text: 'last' },
    ],
  );
});

test('today\'s anthropicMessages drops every tool block; the canonical reading is the one that keeps them', () => {
  const body = {
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r' }] },
    ],
  };
  assert.deepEqual(anthropicMessages(body), [{ role: 'user', content: 'q' }], 'protocols.js is unchanged');
  assert.equal(anthropicToolMessages(body).length, 3);
});

/* ---------------------------------------------------------------- tool specs */

test('OpenAI tool spec: tools, every tool_choice spelling, parallel_tool_calls', () => {
  const tools = [fn('get_weather', WEATHER, 'Weather for a city'), fn('now')];
  const spec = (extra) => openaiToolSpec({ tools, ...extra });
  assert.deepEqual(spec({}), {
    tools: [
      { name: 'get_weather', description: 'Weather for a city', parameters: WEATHER },
      { name: 'now', description: '', parameters: { type: 'object', properties: {} } },
    ],
    choice: { mode: 'auto' },
    parallel: true,
    unsupported: [],
  });
  assert.deepEqual(spec({ tool_choice: 'auto' }).choice, { mode: 'auto' });
  assert.deepEqual(spec({ tool_choice: 'none' }).choice, { mode: 'none' });
  assert.deepEqual(spec({ tool_choice: 'required' }).choice, { mode: 'required' });
  assert.deepEqual(spec({ tool_choice: { type: 'function', function: { name: 'now' } } }).choice, { mode: 'named', name: 'now' });
  assert.deepEqual(spec({ tool_choice: { type: 'function', name: 'now' } }).choice, { mode: 'named', name: 'now' }, 'the Responses spelling');
  assert.equal(spec({ parallel_tool_calls: false }).parallel, false);
  assert.equal(spec({ parallel_tool_calls: true }).parallel, true);
  assert.equal(openaiToolSpec({ messages: [] }), null, 'no tools, no spec');
  assert.equal(openaiToolSpec({ tools: [] }), null);
});

test('OpenAI tool spec: the older functions/function_call map onto the same spec', () => {
  const functions = [{ name: 'get_weather', description: 'Weather', parameters: WEATHER }];
  assert.deepEqual(openaiToolSpec({ functions }), { tools: [{ name: 'get_weather', description: 'Weather', parameters: WEATHER }], choice: { mode: 'auto' }, parallel: true, unsupported: [] });
  assert.deepEqual(openaiToolSpec({ functions, function_call: 'none' }).choice, { mode: 'none' });
  assert.deepEqual(openaiToolSpec({ functions, function_call: 'auto' }).choice, { mode: 'auto' });
  assert.deepEqual(openaiToolSpec({ functions, function_call: { name: 'get_weather' } }).choice, { mode: 'named', name: 'get_weather' });
});

test('what no CLI leg can honour lands in unsupported: custom and server tools, an unknown tool_choice, a name twice', () => {
  const o = openaiToolSpec({
    tools: [fn('ok', WEATHER), { type: 'custom', custom: { name: 'apply_patch', format: { type: 'grammar' } } }, { type: 'web_search_preview' }, fn('ok'), { type: 'function', function: {} }],
    tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } },
  });
  assert.deepEqual(o.tools.map((t) => t.name), ['ok']);
  assert.deepEqual(o.unsupported, [
    { type: 'custom', name: 'apply_patch' },
    { type: 'web_search_preview' },
    { type: 'function', name: 'ok', reason: 'offered twice' },
    { type: 'function', reason: 'a tool without a name' },
    { type: 'tool_choice', reason: 'tool_choice of type "allowed_tools" is not one keysmith knows' },
  ]);
  assert.deepEqual(openaiToolSpec({ tools: [fn('ok')], tool_choice: { type: 'function', function: { name: 'missing' } } }).unsupported, [
    { type: 'tool_choice', name: 'missing', reason: 'names a tool the request does not offer' },
  ]);

  const a = anthropicToolSpec({
    tools: [
      { name: 'get_weather', input_schema: WEATHER },
      { type: 'custom', name: 'lookup', description: 'Look up', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250124', name: 'str_replace_editor' },
      { type: 'computer_20241022', name: 'computer', display_width_px: 1024 },
    ],
  });
  assert.deepEqual(a.tools.map((t) => t.name), ['get_weather', 'lookup']);
  assert.deepEqual(a.unsupported.map((u) => u.type), ['web_search_20250305', 'bash_20250124', 'text_editor_20250124', 'computer_20241022']);
});

test('Anthropic tool spec: input_schema, tool_choice auto/any/tool/none, disable_parallel_tool_use', () => {
  const tools = [{ name: 'get_weather', description: 'Weather', input_schema: WEATHER }];
  const spec = (tool_choice) => anthropicToolSpec({ tools, ...(tool_choice !== undefined ? { tool_choice } : {}) });
  assert.deepEqual(spec(), { tools: [{ name: 'get_weather', description: 'Weather', parameters: WEATHER }], choice: { mode: 'auto' }, parallel: true, unsupported: [] });
  assert.deepEqual(spec({ type: 'auto' }).choice, { mode: 'auto' });
  assert.deepEqual(spec({ type: 'any' }).choice, { mode: 'required' });
  assert.deepEqual(spec({ type: 'tool', name: 'get_weather' }).choice, { mode: 'named', name: 'get_weather' });
  assert.deepEqual(spec({ type: 'none' }).choice, { mode: 'none' });
  assert.equal(spec({ type: 'auto', disable_parallel_tool_use: true }).parallel, false);
  assert.equal(spec({ type: 'any', disable_parallel_tool_use: false }).parallel, true);
  assert.deepEqual(spec({ type: 'sometimes' }).unsupported, [{ type: 'tool_choice', reason: 'tool_choice of type "sometimes" is not one keysmith knows' }]);
  assert.equal(anthropicToolSpec({ messages: [] }), null);
});

/* -------------------------------------------------------------- events and ids */

test('the canonical tool_call event: keysmith\'s own id per face, arguments as JSON text and as an object', () => {
  const e = toolCallEvent({ name: 'get_weather', args: { city: 'Ankara' }, face: 'anthropic' });
  assert.equal(e.type, 'tool_call');
  assert.match(e.id, /^toolu_[0-9a-f]{24}$/);
  assert.equal(e.arguments, '{"city":"Ankara"}');
  assert.deepEqual(JSON.parse(e.arguments), e.args);
  assert.match(toolCallEvent({ name: 'f' }).id, /^call_[0-9a-f]{24}$/);
  assert.equal(toolCallEvent({ name: 'f' }).arguments, '{}');
  assert.equal(toolCallEvent({ id: 'call_given', name: 'f' }).id, 'call_given');
  assert.throws(() => toolCallEvent({ name: 'f', args: [1] }), /must be a JSON object/);
  assert.throws(() => toolCallEvent({ args: {} }), /needs a name/);
  assert.match(newToolCallId('openai'), /^call_[0-9a-f]{24}$/);
  assert.match(newToolCallId('responses'), /^call_[0-9a-f]{24}$/);
  assert.match(newToolItemId(), /^fc_[0-9a-f]{24}$/);
  const ids = new Set(Array.from({ length: 200 }, () => newToolCallId()));
  assert.equal(ids.size, 200);
  assert.equal(FINISH_TOOL_CALLS, 'tool_calls');
});

/* ---------------------------------------------------- tool-less: nothing moves */

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('./fixtures/flatten-snapshot.json', import.meta.url), 'utf8'));

test('a tool-less request reads, and flattens, byte for byte as it did before the tool bridge (snapshot)', () => {
  assert.ok(SNAPSHOT.cases.length >= 25);
  for (const c of SNAPSHOT.cases) {
    const where = `${c.wire}: ${c.name}`;
    const today = c.wire === 'openai' ? openaiMessages(c.body) : anthropicMessages(c.body);
    assert.deepEqual(today, c.messages, `${where}: protocols.js`);
    assert.deepEqual(flattenMessages(today), c.flat, `${where}: flattenMessages`);
    const canonical = c.wire === 'openai' ? openaiToolMessages(c.body) : anthropicToolMessages(c.body);
    assert.ok(canonical.every((m) => !m.toolCalls && m.toolCallId === undefined), `${where}: no tool turn appears from nowhere`);
    assert.deepEqual(plainMessages(canonical), c.messages, `${where}: the canonical reading`);
    assert.deepEqual(flattenMessages(plainMessages(canonical)), c.flat, `${where}: the canonical reading, flattened`);
  }
});
