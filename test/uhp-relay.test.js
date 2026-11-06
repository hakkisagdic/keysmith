import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { HTTP_PROFILES } from '../src/profiles.js';

function startMockHarnessRouter(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/harness/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startKeysmith(cfg, opts = {}) {
  const full = { auth: { enabled: false }, ...cfg };
  const gateway = new Gateway(full);
  const server = createServer(gateway, full, { log: () => {}, ...opts });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        gateway,
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function writeSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'uhp-version': '2026-10-19',
  });
  for (const ev of events) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

test('UHP Relay: models() parses HarnessRouter backends catalogue and /harnesses list', async () => {
  const hr = await startMockHarnessRouter((req, res) => {
    assert.equal(req.headers['uhp-version'], '2026-10-19');
    if (req.url === '/api/harness/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          backends: {
            claude: {
              default: 'claude-sonnet-4-6',
              models: [
                { id: 'claude-sonnet-4-6', available: true, default: true, reasoning: ['low', 'medium', 'high'] },
                { id: 'claude-opus-4-6', available: false, default: false, reasoning: ['low', 'high'] },
              ],
            },
            codex: {
              default: 'gpt-5.4',
              models: [{ id: 'gpt-5.4', available: true, default: true, reasoning: ['low', 'medium', 'high', 'xhigh'] }],
            },
          },
        }),
      );
      return;
    }
    if (req.url === '/api/harness/v1/harnesses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          harnesses: [{ id: 'chrn_0123456789abcdef0123456789abcdef', name: 'SecOps Reviewer' }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const ks = await startKeysmith({
      adapters: {
        harnessrouter: { ...structuredClone(HTTP_PROFILES.harnessrouter), baseUrl: hr.baseUrl },
      },
    });
    try {
      const res = await fetch(`${ks.url}/v1/models`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const ids = body.data.map((m) => m.id);
      assert.ok(ids.includes('harnessrouter/claude'));
      assert.ok(ids.includes('harnessrouter/claude-sonnet-4-6'));
      assert.ok(ids.includes('harnessrouter/claude/claude-sonnet-4-6'));
      assert.ok(!ids.includes('harnessrouter/claude-opus-4-6'), 'unavailable models are skipped');
      assert.ok(ids.includes('harnessrouter/codex/gpt-5.4'));
      assert.ok(ids.includes('harnessrouter/chrn_0123456789abcdef0123456789abcdef'));
    } finally {
      await ks.close();
    }
  } finally {
    await hr.close();
  }
});

test('UHP Relay: relays chat completions, messages, and responses with backend/model, harness_id, and session chaining via previous_response_id', async () => {
  const received = [];
  const hr = await startMockHarnessRouter(async (req, res) => {
    if (req.url === '/api/harness/v1/responses' && req.method === 'POST') {
      const body = await readJsonBody(req);
      received.push({ headers: req.headers, body });
      const respId = `resp_${received.length}`;
      writeSse(res, [
        {
          type: 'response.created',
          sequence_number: 1,
          response: { id: respId, object: 'response', status: 'in_progress', output: [], model: body.model || 'claude-sonnet-4-6' },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: 2,
          delta: 'Checking repository structure...',
        },
        // Internal CLI tool call (followed by function_call_output in the same turn) — should NOT leak as a client tool call
        {
          type: 'response.output_item.done',
          sequence_number: 3,
          item: { id: 'fc_internal', type: 'function_call', call_id: 'call_bash_1', name: 'Bash', arguments: '{"cmd":"ls"}' },
        },
        {
          type: 'response.output_item.done',
          sequence_number: 4,
          item: { id: 'fco_internal', type: 'function_call_output', call_id: 'call_bash_1', output: 'README.md' },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 5,
          delta: 'Merhaba ',
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 6,
          delta: 'UHP!',
        },
        {
          type: 'response.completed',
          sequence_number: 7,
          response: {
            id: respId,
            object: 'response',
            status: 'completed',
            model: body.model || 'claude-sonnet-4-6',
            output: [
              { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Merhaba UHP!' }] },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 15,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        },
      ]);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const ks = await startKeysmith({
      adapters: {
        harnessrouter: {
          ...structuredClone(HTTP_PROFILES.harnessrouter),
          baseUrl: hr.baseUrl,
          models: ['claude/claude-sonnet-4-6', 'chrn_custom123'],
        },
      },
    });
    try {
      // 1. OpenAI /v1/chat/completions with backend/model + reasoning_effort + include_reasoning
      const chatRes = await fetch(`${ks.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'harnessrouter/claude/claude-sonnet-4-6',
          reasoning_effort: 'high',
          include_reasoning: true,
          messages: [
            { role: 'system', content: 'Sen yardımsever bir asistansın.' },
            { role: 'user', content: 'Selam' },
          ],
        }),
      });
      assert.equal(chatRes.status, 200);
      const sessionId = chatRes.headers.get('x-keysmith-session');
      assert.ok(sessionId, 'returns a keysmith session mapped to upstream response id');
      const chatBody = await chatRes.json();
      assert.equal(chatBody.choices[0].message.content, 'Merhaba UHP!');
      assert.equal(chatBody.choices[0].message.reasoning_content, 'Checking repository structure...');
      assert.equal(chatBody.usage.prompt_tokens, 120);
      assert.equal(chatBody.usage.completion_tokens, 15);
      assert.equal(received[0].body.backend, 'claude');
      assert.equal(received[0].body.model, 'claude-sonnet-4-6');
      assert.equal(received[0].body.instructions, 'Sen yardımsever bir asistansın.');
      assert.deepEqual(received[0].body.reasoning, { effort: 'high' });

      // 2. Follow-up turn using x-keysmith-session chains via previous_response_id
      const followRes = await fetch(`${ks.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-keysmith-session': sessionId },
        body: JSON.stringify({
          model: 'harnessrouter/claude/claude-sonnet-4-6',
          messages: [
            { role: 'system', content: 'Sen yardımsever bir asistansın.' },
            { role: 'user', content: 'Selam' },
            { role: 'assistant', content: 'Merhaba UHP!' },
            { role: 'user', content: 'İkinci soru' },
          ],
        }),
      });
      assert.equal(followRes.status, 200);
      assert.equal(received[1].body.previous_response_id, 'resp_1');
      assert.equal(received[1].body.input.length, 1);
      assert.equal(received[1].body.input[0].content[0].text, 'İkinci soru');

      // 3. Anthropic /v1/messages targeting custom harness chrn_custom123
      const msgRes = await fetch(`${ks.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'harnessrouter/chrn_custom123',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Test harness' }],
        }),
      });
      assert.equal(msgRes.status, 200);
      const msgBody = await msgRes.json();
      const textBlock = msgBody.content.find((b) => b.type === 'text');
      assert.equal(textBlock.text, 'Merhaba UHP!');
      assert.equal(received[2].body.metadata?.harness_id, 'chrn_custom123');
    } finally {
      await ks.close();
    }
  } finally {
    await hr.close();
  }
});

test('UHP Relay: client tools work natively or automatically fall back to EMULATE when HarnessRouter ignores tools', async () => {
  let requests = 0;
  let ignoreTools = true;
  const hr = await startMockHarnessRouter(async (req, res) => {
    if (req.url === '/api/harness/v1/responses' && req.method === 'POST') {
      requests++;
      const body = await readJsonBody(req);
      // Simulate HarnessRouter CE ignoring `tools` field by reporting `ignored_fields: ["tools"]`
      if (ignoreTools && Array.isArray(body.tools) && body.tools.length > 0) {
        writeSse(res, [
          {
            type: 'response.created',
            sequence_number: 1,
            response: {
              id: `resp_ignored_${requests}`,
              object: 'response',
              status: 'in_progress',
              output: [],
              model: 'claude-sonnet-4-6',
              metadata: { ignored_fields: ['tools'] },
            },
          },
        ]);
        return;
      }
      if (!ignoreTools && Array.isArray(body.tools) && body.tools.length > 0) {
        // Native UHP tool call (e.g. from another Keysmith UHP server): function_call item WITHOUT function_call_output
        writeSse(res, [
          {
            type: 'response.created',
            sequence_number: 1,
            response: { id: `resp_native_${requests}`, object: 'response', status: 'in_progress', output: [], model: 'claude-sonnet-4-6' },
          },
          {
            type: 'response.output_item.done',
            sequence_number: 2,
            item: { id: 'fc_1', type: 'function_call', call_id: 'call_w1', name: 'get_weather', arguments: '{"city":"Ankara"}' },
          },
          {
            type: 'response.completed',
            sequence_number: 3,
            response: {
              id: `resp_native_${requests}`,
              object: 'response',
              status: 'completed',
              model: 'claude-sonnet-4-6',
              output: [{ id: 'fc_1', type: 'function_call', call_id: 'call_w1', name: 'get_weather', arguments: '{"city":"Ankara"}' }],
              usage: { input_tokens: 90, output_tokens: 18 },
            },
          },
        ]);
        return;
      }
      // EMULATE fallback sends a plain user prompt asking for the JSON tool call format
      writeSse(res, [
        {
          type: 'response.created',
          sequence_number: 1,
          response: { id: `resp_emulate_${requests}`, object: 'response', status: 'in_progress', output: [], model: 'claude-sonnet-4-6' },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 2,
          delta: JSON.stringify({ tool_calls: [{ name: 'get_weather', arguments: { city: 'Istanbul' } }] }),
        },
        {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: `resp_emulate_${requests}`,
            object: 'response',
            status: 'completed',
            model: 'claude-sonnet-4-6',
            output: [],
            usage: { input_tokens: 200, output_tokens: 25 },
          },
        },
      ]);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const ks = await startKeysmith({
      adapters: {
        harnessrouter: {
          ...structuredClone(HTTP_PROFILES.harnessrouter),
          baseUrl: hr.baseUrl,
          models: ['claude/claude-sonnet-4-6'],
        },
        uhpnative: {
          ...structuredClone(HTTP_PROFILES.harnessrouter),
          baseUrl: hr.baseUrl,
          models: ['claude/claude-sonnet-4-6'],
        },
      },
    });
    try {
      const toolDef = [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ];
      // Case 1: HarnessRouter CE reports ignored_fields: ['tools'] -> falls back to EMULATE
      const res = await fetch(`${ks.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'harnessrouter/claude/claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'What is the weather in Istanbul?' }],
          tools: toolDef,
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-keysmith-mode'), 'emulate');
      const body = await res.json();
      assert.equal(body.choices[0].finish_reason, 'tool_calls');
      assert.equal(body.choices[0].message.tool_calls.length, 1);
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
      assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { city: 'Istanbul' });
      assert.equal(requests, 2, 'first request detected ignored_fields: ["tools"], second ran EMULATE');

      // Case 2: UHP server supports native client tools -> answered directly via UHP
      ignoreTools = false;
      const resNative = await fetch(`${ks.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'uhpnative/claude/claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'What is the weather in Ankara?' }],
          tools: toolDef,
        }),
      });
      assert.equal(resNative.status, 200);
      assert.equal(resNative.headers.get('x-keysmith-mode'), 'uhp');
      const bodyNative = await resNative.json();
      assert.equal(bodyNative.choices[0].finish_reason, 'tool_calls');
      assert.equal(bodyNative.choices[0].message.tool_calls[0].function.name, 'get_weather');
      assert.deepEqual(JSON.parse(bodyNative.choices[0].message.tool_calls[0].function.arguments), { city: 'Ankara' });
    } finally {
      await ks.close();
    }
  } finally {
    await hr.close();
  }
});

test('UHP Relay: preserves unknown usage (reason / keysmith_usage: "unknown") as usage: null in usage.jsonl and never mistakes 0-placeholder wire counts for real 0 usage', async () => {
  const hr = await startMockHarnessRouter(async (req, res) => {
    if (req.url === '/api/harness/v1/responses' && req.method === 'POST') {
      writeSse(res, [
        {
          type: 'response.created',
          sequence_number: 1,
          response: { id: 'resp_unknown_u', object: 'response', status: 'in_progress', output: [], model: 'codex' },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 2,
          delta: 'Done',
        },
        {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_unknown_u',
            object: 'response',
            status: 'completed',
            model: 'codex',
            output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done' }] }],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: null,
              keysmith_usage: 'unknown',
              reason: 'codex reports token counts when a turn ends, not at an MCP tool call',
            },
          },
        },
      ]);
      return;
    }
    res.writeHead(404).end();
  });

  const rows = [];
  try {
    const ks = await startKeysmith(
      {
        adapters: {
          harnessrouter: {
            ...structuredClone(HTTP_PROFILES.harnessrouter),
            baseUrl: hr.baseUrl,
            models: ['codex'],
          },
        },
      },
      {
        usage: {
          record: (entry) => rows.push(entry),
          summarize: () => ({}),
          tail: () => [],
        },
      },
    );
    try {
      const res = await fetch(`${ks.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'harnessrouter/codex',
          input: 'Ping',
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.usage.reason, 'codex reports token counts when a turn ends, not at an MCP tool call');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usage, null, 'usage.jsonl row keeps usage: null, never 0');
      assert.equal(rows[0].usageReason, 'codex reports token counts when a turn ends, not at an MCP tool call');
    } finally {
      await ks.close();
    }
  } finally {
    await hr.close();
  }
});
