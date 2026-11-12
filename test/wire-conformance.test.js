/**
 * Wire conformance: each face's answers read by the parsers the official clients run, over a local
 * keysmith whose CLIs are stubs — test/stubs/cli-bridge.mjs as codex on the MCP bridge, and two
 * plain ones. Nothing here spends a token, and no live gateway is asked.
 *
 * The clients, pinned exactly in package.json's devDependencies (`npm ci` first):
 *   - the Vercel AI SDK as OpenBot (CopilotKit's agent) runs it — ai 6.0.264 with @ai-sdk/anthropic
 *     3.0.111 and @ai-sdk/openai 3.0.99 (bun.lock of the CopilotKit trial), installed as aliases
 *     (openbot-ai, openbot-ai-sdk-anthropic, openbot-ai-sdk-openai) — and the latest one: ai
 *     7.0.162, @ai-sdk/anthropic 4.0.96, @ai-sdk/openai 4.0.108, @ai-sdk/openai-compatible 3.0.84.
 *     These check every chunk against a zod schema, and a chunk that fails it aborts the run;
 *   - the official SDKs: @anthropic-ai/sdk 1.4.0, openai 7.50.0 and 7.5.0 (OpenBot's).
 *
 * What each case covers, per face (/v1/messages, /v1/responses, /v1/chat/completions):
 *   - a tool turn whose CLI has no token counts yet (codex reports a run's tokens once, when the run
 *     ends) — the 21/21 failure OpenBot met on 2026-11-04: `usage.output_tokens` null in
 *     message_delta, "Type validation failed … expected number". The tool runs and the answer after
 *     it carries the run's usage;
 *   - a text answer from a CLI that reports no tokens at all (parser raw);
 *   - a stream that fails after it started: the client gets keysmith's error, not a parse error.
 * The usage row keeps null and the reason throughout — never a 0 (src/protocols.js, the wire rule).
 */
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';

const STUB = fileURLToPath(new URL('./stubs/cli-bridge.mjs', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

/** A pinned client package, or a failure that says how to get it (the suite needs `npm ci`). */
async function load(name) {
  try {
    return await import(name);
  } catch (e) {
    throw new Error(`${name} is not installed: run \`npm ci\` in the repository first (devDependencies, pinned) — ${e.message}`);
  }
}
/** The installed version of a client package (read from node_modules: not every package exports its package.json). */
const version = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), 'utf8')).version;

let dir, server, base, gateway, usageLog;
const mods = {};

function stubCli(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

before(async () => {
  for (const name of ['ai', 'openbot-ai', '@ai-sdk/anthropic', 'openbot-ai-sdk-anthropic', '@ai-sdk/openai', 'openbot-ai-sdk-openai', '@ai-sdk/openai-compatible', '@anthropic-ai/sdk', 'openai', 'openbot-openai']) mods[name] = await load(name);
  // os.tmpdir(): the bridge socket's path must stay under 103 bytes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kswc-'));
  const codex = structuredClone(CLI_PROFILES.codex);
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 300, streamKeepaliveMs: 60, bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 8, maxSessionsPerKey: 8 } },
    adapters: {
      // codex on the MCP bridge, as shipped: the answer that hands a call out has no tokens yet.
      cx: {
        ...codex,
        bin: STUB,
        cwd: path.join(dir, 'ws-codex'),
        toolMode: 'mcp',
        bridge: { ...codex.bridge, readyTimeoutMs: 10_000, toolResultTimeoutMs: 60_000 },
        env: { STUB_CLI: 'codex', CLI_BRIDGE_LOG: path.join(dir, 'bridge.jsonl') },
        timeoutMs: 20_000,
        maxConcurrent: 8,
      },
      // Plain stdout: nothing in it says what the run spent.
      plain: { kind: 'cli', bin: stubCli('plain', `process.stdout.write('plain answer');`), args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: path.join(dir, 'ws-plain') },
      // codex exec --json on a turn that fails after its first message went out (exit 1).
      cxfail: {
        kind: 'cli',
        bin: stubCli('cxfail', `for (const l of [{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Half an answer.' } }, { type: 'turn.failed', error: { message: 'stub upstream broke mid-answer' } }]) process.stdout.write(JSON.stringify(l) + '\\n');
process.exitCode = 1;`),
        args: ['exec', '--json', '--', '{prompt}'],
        parser: 'codex-json',
        models: ['m'],
        cwd: path.join(dir, 'ws-cxfail'),
      },
    },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

/** Close every bridge session a case left waiting (a client that never came back), so the next case has room. */
afterEach(async () => {
  const hub = gateway?.toolEngines?.mcp?.hub;
  if (hub) await Promise.all([...hub.sessions.values()].map((s) => s.close('test_done')));
});

after(async () => {
  await gateway?.close();
  if (server) await new Promise((r) => server.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------- helpers */

const CITY = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: CITY } }];
const R_TOOLS = [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: CITY, strict: false }];
const A_TOOLS = [{ name: 'get_weather', description: 'Weather', input_schema: CITY }];
const result = (city) => `RESULT for ${city}`;

let tags = 0;
const tag = () => `#w${++tags}-${crypto.randomBytes(3).toString('hex')}`;
/** A model's rows, oldest first (tail() reads newest first). */
const rowsOf = (model) => usageLog.tail(500).filter((r) => r.model === model).reverse();
const lastRows = (model, n) => rowsOf(model).slice(-n);
/** The stub codex's turn.completed: 1100 in, none of them cached, 30 out — the session's whole spend. */
const RUN = { input: 1100, output: 30, cacheRead: 0, cacheWrite: 0 };
const CODEX_GAP = /^cx reports a run's tokens once, when the run ends/;
const RAW_GAP = /plain runs with parser raw: the CLI's plain output carries no token counts/;

/** Rows of a tool round trip: the call's answer null with the reason (never a 0), the last one the run's usage. */
function assertLoopRows(model, label) {
  const [first, second] = lastRows(model, 2);
  assert.equal(first.status, 'ok', label);
  assert.equal(first.usage, null, `${label}: the call's answer has no count, and its row says null — never 0`);
  assert.match(first.usageReason, CODEX_GAP, label);
  assert.equal(second.status, 'ok', label);
  assert.deepEqual(second.usage, RUN, label);
  assert.equal(second.usageReason, undefined, label);
}

/* ------------------------------------------------------------------- the AI SDK */

/**
 * The AI SDK generations and the language model each face is reached by. OpenBot's `ai` runs its
 * own providers (3.x, LanguageModelV3); the latest `ai` its own (4.x / 3.x).
 */
const GENERATIONS = [
  {
    id: 'openbot',
    ai: 'openbot-ai',
    faces: {
      messages: (id = 'cx/m') => mods['openbot-ai-sdk-anthropic'].createAnthropic({ baseURL: `${base}/v1`, apiKey: KEY })(id),
      responses: (id = 'cx/m') => mods['openbot-ai-sdk-openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).responses(id),
      chat: (id = 'cx/m') => mods['openbot-ai-sdk-openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).chat(id),
    },
    packages: { messages: 'openbot-ai-sdk-anthropic', responses: 'openbot-ai-sdk-openai', chat: 'openbot-ai-sdk-openai' },
  },
  {
    id: 'latest',
    ai: 'ai',
    faces: {
      messages: (id = 'cx/m') => mods['@ai-sdk/anthropic'].createAnthropic({ baseURL: `${base}/v1`, apiKey: KEY })(id),
      responses: (id = 'cx/m') => mods['@ai-sdk/openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).responses(id),
      chat: (id = 'cx/m') => mods['@ai-sdk/openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).chat(id),
      compatible: (id = 'cx/m') => mods['@ai-sdk/openai-compatible'].createOpenAICompatible({ name: 'keysmith', baseURL: `${base}/v1`, apiKey: KEY, includeUsage: true }).chatModel(id),
    },
    packages: { messages: '@ai-sdk/anthropic', responses: '@ai-sdk/openai', chat: '@ai-sdk/openai', compatible: '@ai-sdk/openai-compatible' },
  },
];
const ROUTE = { messages: '/v1/messages', responses: '/v1/responses', chat: '/v1/chat/completions', compatible: '/v1/chat/completions' };

/**
 * keysmith keeps no response: the Responses provider is told not to store one (store: true makes
 * the AI SDK send item references a later request would have to resolve), as docs/clients.md says.
 */
const providerOptions = (face) => (face === 'responses' ? { openai: { store: false } } : undefined);

function aiTools(ai) {
  return {
    get_weather: ai.tool({
      description: 'Weather',
      inputSchema: ai.jsonSchema(CITY),
      execute: async ({ city }) => result(city),
    }),
  };
}

/** Every part of a streamText run, the steps, and the errors it carried — none hidden by a default onError. */
async function streamRun(ai, options) {
  const errors = [];
  const run = ai.streamText({ maxRetries: 0, ...options, onError: ({ error }) => errors.push(error) });
  const parts = [];
  for await (const p of run.fullStream) parts.push(p);
  const steps = await run.steps.catch(() => []);
  const usage = await run.totalUsage.catch(() => null);
  return { parts, steps, usage, text: parts.filter((p) => p.type === 'text-delta').map((p) => p.text ?? p.delta ?? p.textDelta ?? '').join(''), errors: [...errors, ...parts.filter((p) => p.type === 'error').map((p) => p.error)] };
}

const message = (e) => String(e?.message ?? e?.error?.message ?? (typeof e === 'object' ? JSON.stringify(e) : e));
const noErrors = (errors, label) => assert.deepEqual(errors.map(message), [], `${label}: the client parsed every chunk`);

for (const gen of GENERATIONS) {
  for (const [face, make] of Object.entries(gen.faces)) {
    describe(`AI SDK ${gen.id} · ${face} (${ROUTE[face]})`, () => {
      const label = () => `${gen.ai}@${version(gen.ai)} + ${gen.packages[face]}@${version(gen.packages[face])}`;

      test('streamed: the tool turn codex has no tokens for yet parses; the tool runs; the answer after it carries the run\'s usage', async () => {
        const ai = mods[gen.ai];
        const run = await streamRun(ai, { model: make(), prompt: `Weather ${tag()}`, tools: aiTools(ai), stopWhen: ai.stepCountIs(3), providerOptions: providerOptions(face) });
        noErrors(run.errors, label());
        assert.equal(run.steps.length, 2, `${label()}: the call, then the answer`);
        assert.equal(run.steps[0].finishReason, 'tool-calls', label());
        assert.deepEqual(run.steps[0].toolCalls.map((c) => [c.toolName, c.input ?? c.args]), [['get_weather', { city: 'Ankara' }]], label());
        assert.equal(run.steps[1].text, 'Weather: RESULT for Ankara', label());
        assert.deepEqual([run.usage.inputTokens, run.usage.outputTokens], [RUN.input, RUN.output], `${label()}: the run's whole spend, on the answer that ends it`);
        if (face === 'messages') {
          // The Anthropic provider keeps the wire's usage object whole: an app sees the marker and the reason.
          const raw = run.steps[0].providerMetadata?.anthropic?.usage;
          assert.equal(raw?.keysmith_usage, 'unknown', label());
          assert.match(raw?.reason, CODEX_GAP, label());
        }
        assertLoopRows('cx/m', label());
      });

      test('not streamed: the same round trip through generateText', async () => {
        const ai = mods[gen.ai];
        const out = await ai.generateText({ maxRetries: 0, model: make(), prompt: `Weather ${tag()}`, tools: aiTools(ai), stopWhen: ai.stepCountIs(3), providerOptions: providerOptions(face) });
        assert.equal(out.steps.length, 2, label());
        assert.equal(out.steps[0].finishReason, 'tool-calls', label());
        assert.equal(out.text, 'Weather: RESULT for Ankara', label());
        assert.deepEqual([out.totalUsage.inputTokens, out.totalUsage.outputTokens], [RUN.input, RUN.output], label());
        assertLoopRows('cx/m', label());
      });

      test('a text answer from a CLI that reports no tokens at all, not streamed: parsed, and the row null with the reason', async () => {
        const ai = mods[gen.ai];
        const out = await ai.generateText({ maxRetries: 0, model: make('plain/m'), prompt: 'hi', providerOptions: providerOptions(face) });
        assert.equal(out.text, 'plain answer', label());
        const [row] = lastRows('plain/m', 1);
        assert.equal(row.usage, null, label());
        assert.match(row.usageReason, RAW_GAP, label());
      });

      test('the same text answer, streamed', { todo: plainResponsesStream(gen, face, 'text') }, async () => {
        const ai = mods[gen.ai];
        const run = await streamRun(ai, { model: make('plain/m'), prompt: 'hi', providerOptions: providerOptions(face) });
        noErrors(run.errors, label());
        assert.equal(run.text, 'plain answer', label());
        const [row] = lastRows('plain/m', 1);
        assert.equal(row.usage, null, label());
        assert.match(row.usageReason, RAW_GAP, label());
      });

      for (const tools of [true, false]) {
        const todo = tools ? false : plainResponsesStream(gen, face, 'error');
        // Tools offered with tool_choice none: the CLI (no toolMode) answers in text, through the
        // tool faces. With auto it could not carry them, and the request would fail before a word.
        test(`a stream that fails after it started${tools ? ', tools offered (the tool faces, src/tools/faces.js)' : ''}: the client gets keysmith's error, and nothing it cannot parse`, { todo }, async () => {
          const ai = mods[gen.ai];
          const run = await streamRun(ai, { model: make('cxfail/m'), prompt: 'hi', ...(tools ? { tools: aiTools(ai), toolChoice: 'none' } : {}), providerOptions: providerOptions(face) });
          assert.ok(run.errors.length > 0, `${label()}: the failure reached the client`);
          for (const e of run.errors) {
            assert.doesNotMatch(message(e), /Type validation failed|Invalid JSON response/, label());
            assert.match(message(e), /stub upstream broke mid-answer/, label());
          }
          assert.equal(lastRows('cxfail/m', 1)[0].status, 'error', label());
        });
      }
    });
  }
}

/**
 * Findings of this test, not of the usage rule — for after the UHP branch (Traycer's) is merged,
 * since both live in src/server.js, which that branch rewrites. A /v1/responses stream that
 * offers no tools is written by server.js itself (responsesStreamEventsHead and the lines after
 * it), not by the Responses tool face: its response.created has no `created_at` and no event has
 * a `sequence_number`. @ai-sdk/openai 3.x reads a chunk that fails its schema as an unknown one
 * and skips it — so response.failed is skipped and the response.completed after it ends the run
 * as a success: the error never reaches the client. 4.x refuses a known chunk that fails its
 * schema, response.created first, so no such stream reads at all. The tool face writes both
 * right (the cases with tools offered above).
 */
function plainResponsesStream(gen, face, kind) {
  if (face !== 'responses') return false;
  if (gen.id === 'latest') return 'server.js: the plain /v1/responses stream\'s response.created has no created_at, which @ai-sdk/openai 4.x requires';
  if (kind === 'error') return 'server.js: the plain /v1/responses stream\'s response.failed has no sequence_number: @ai-sdk/openai 3.x skips it and reads the response.completed after it as a success';
  return false;
}

/* ---------------------------------------------------------------- the official SDKs */

describe(`@anthropic-ai/sdk · messages (/v1/messages)`, () => {
  const client = () => new mods['@anthropic-ai/sdk'].default({ baseURL: base, apiKey: KEY, maxRetries: 0 });
  const label = () => `@anthropic-ai/sdk@${version('@anthropic-ai/sdk')}`;

  for (const stream of [true, false]) {
    test(`${stream ? 'streamed' : 'not streamed'}: the tool turn with no tokens yet, the result back, the answer with the run's usage`, async () => {
      const c = client();
      const ask = async (messages) => {
        const body = { model: 'cx/m', max_tokens: 256, tools: A_TOOLS, messages };
        if (!stream) return { msg: await c.messages.create(body) };
        const s = c.messages.stream(body);
        const events = [];
        for await (const e of s) events.push(e);
        return { msg: await s.finalMessage(), delta: events.find((e) => e.type === 'message_delta') };
      };
      const history = [{ role: 'user', content: `Weather ${tag()}` }];
      const first = await ask(history);
      assert.equal(first.msg.stop_reason, 'tool_use', label());
      const use = first.msg.content.find((b) => b.type === 'tool_use');
      assert.deepEqual([use.name, use.input], ['get_weather', { city: 'Ankara' }], label());
      // No count yet: a number where the API types one (output_tokens; input_tokens on a whole
      // Message), null where it allows null, and the marker with the reason beside them.
      const wire = stream ? first.delta.usage : first.msg.usage;
      assert.equal(wire.output_tokens, 0, label());
      assert.equal(wire.input_tokens, stream ? null : 0, label());
      assert.deepEqual([wire.cache_creation_input_tokens, wire.cache_read_input_tokens], [null, null], label());
      assert.equal(wire.keysmith_usage, 'unknown', label());
      assert.match(wire.reason, CODEX_GAP, label());
      history.push({ role: 'assistant', content: first.msg.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: result('Ankara') }] });
      const second = await ask(history);
      assert.equal(second.msg.stop_reason, 'end_turn', label());
      assert.equal(second.msg.content.map((b) => b.text).join(''), 'Weather: RESULT for Ankara', label());
      assert.deepEqual([second.msg.usage.input_tokens, second.msg.usage.output_tokens], [RUN.input, RUN.output], label());
      assert.equal(second.msg.usage.keysmith_usage, undefined, label());
      assertLoopRows('cx/m', label());
    });
  }

  test('a stream that fails after it started raises keysmith\'s error', async () => {
    const s = client().messages.stream({ model: 'cxfail/m', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    s.on('error', () => {}); // the rejection below is the one this case reads
    await assert.rejects(s.finalMessage(), /stub upstream broke mid-answer/, label());
  });
});

for (const pkg of ['openai', 'openbot-openai']) {
  describe(`${pkg} (official openai SDK) · chat completions and responses`, () => {
    const client = () => new mods[pkg].default({ baseURL: `${base}/v1`, apiKey: KEY, maxRetries: 0 });
    const label = () => `openai@${version(pkg)}`;

    for (const stream of [true, false]) {
      test(`chat, ${stream ? 'streamed' : 'not streamed'}: the tool turn with no tokens yet (null counts, the marker, the reason), then the answer with the run's usage`, async () => {
        const c = client();
        const ask = async (messages) => {
          const body = { model: 'cx/m', tools: TOOLS, messages };
          if (!stream) return c.chat.completions.create(body);
          const s = c.chat.completions.stream({ ...body, stream_options: { include_usage: true } });
          return s.finalChatCompletion();
        };
        const history = [{ role: 'user', content: `Weather ${tag()}` }];
        const first = await ask(history);
        const msg = first.choices[0].message;
        assert.equal(first.choices[0].finish_reason, 'tool_calls', label());
        assert.deepEqual(msg.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)]), [['get_weather', { city: 'Ankara' }]], label());
        // Every count of the chat face is nullish in the AI SDK's parsers: null stays null.
        assert.deepEqual([first.usage.prompt_tokens, first.usage.completion_tokens, first.usage.total_tokens], [null, null, null], label());
        assert.equal(first.usage.keysmith_usage, 'unknown', label());
        assert.match(first.usage.reason, CODEX_GAP, label());
        history.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls.map((t) => ({ id: t.id, type: 'function', function: t.function })) });
        for (const t of msg.tool_calls) history.push({ role: 'tool', tool_call_id: t.id, content: result(JSON.parse(t.function.arguments).city) });
        const second = await ask(history);
        assert.equal(second.choices[0].message.content, 'Weather: RESULT for Ankara', label());
        assert.deepEqual([second.usage.prompt_tokens, second.usage.completion_tokens, second.usage.total_tokens], [1100, 30, 1130], label());
        assert.equal(second.usage.keysmith_usage, undefined, label());
        assertLoopRows('cx/m', label());
      });

      test(`responses, ${stream ? 'streamed' : 'not streamed'}: the tool turn with no tokens yet (0 where a number is required, the marker, the reason), then the answer with the run's usage`, async () => {
        const c = client();
        const ask = async (input) => {
          const body = { model: 'cx/m', tools: R_TOOLS, input, store: false };
          if (!stream) return c.responses.create(body);
          return c.responses.stream(body).finalResponse();
        };
        const history = [{ role: 'user', content: `Weather ${tag()}` }];
        const first = await ask(history);
        const calls = first.output.filter((o) => o.type === 'function_call');
        assert.deepEqual(calls.map((o) => [o.name, JSON.parse(o.arguments)]), [['get_weather', { city: 'Ankara' }]], label());
        const u = first.usage;
        assert.deepEqual([u.input_tokens, u.output_tokens, u.total_tokens], [0, 0, 0], label());
        // 0 in the details too: Codex CLI (0.163.0) takes no null there (src/protocols.js, the rule).
        assert.deepEqual([u.input_tokens_details.cached_tokens, u.output_tokens_details.reasoning_tokens], [0, 0], label());
        assert.equal(u.keysmith_usage, 'unknown', label());
        assert.match(u.reason, CODEX_GAP, label());
        for (const o of first.output) history.push(o);
        for (const o of calls) history.push({ type: 'function_call_output', call_id: o.call_id, output: result(JSON.parse(o.arguments).city) });
        const second = await ask(history);
        assert.equal(second.output_text, 'Weather: RESULT for Ankara', label());
        assert.deepEqual([second.usage.input_tokens, second.usage.output_tokens, second.usage.total_tokens], [1100, 30, 1130], label());
        assert.equal(second.usage.keysmith_usage, undefined, label());
        assertLoopRows('cx/m', label());
      });
    }

    test('a stream that fails after it started raises keysmith\'s error, on chat and on responses', async () => {
      const c = client();
      // A stream helper also emits its failure as an `error` event: the rejection below is the one read here.
      const quiet = (s) => (s.on('error', () => {}), s);
      await assert.rejects(quiet(c.chat.completions.stream({ model: 'cxfail/m', messages: [{ role: 'user', content: 'hi' }] })).finalChatCompletion(), /stub upstream broke mid-answer/, `${label()} chat`);
      // The Responses face with tools (src/tools/faces.js): an `error` event, then response.failed.
      // tool_choice none: the CLI (no toolMode) answers in text; with auto it cannot carry the tools.
      await assert.rejects(quiet(c.responses.stream({ model: 'cxfail/m', tools: R_TOOLS, tool_choice: 'none', input: 'hi', store: false })).finalResponse(), /stub upstream broke mid-answer/, `${label()} responses`);
    });
  });
}
