/**
 * Independent re-check of 11350b4 and cbd929f (the unknown-usage wire rule, src/protocols.js): the
 * cases test/wire-conformance.test.js leaves out, read by the same pinned parsers (`npm ci` first).
 *
 *   - a bridge session that mixes answers with counts and answers with none: Claude Code's second
 *     call of one step has no tokens of its own (its first answer's step reported them), and
 *     codex's two calls, one after the other, have none until the run ends — every turn parses,
 *     the known counts arrive exact, the totals are the run's;
 *   - Claude Code's counts on every face (known all through): exact per step and in all, no marker;
 *   - `codex exec --json` that retried a stream error (`Reconnecting... 1/5`), with turn.completed
 *     usage and without it, through the tool faces (tools offered with tool_choice none, a CLI with
 *     no toolMode: a text answer is what was asked — with tool_choice auto such a leg cannot carry
 *     the tools, and the request fails instead, test/tools-router.test.js);
 *   - an HTTP leg whose upstream reports no usage (nothing said at all), tools offered (none);
 *   - a route whose first leg reported counts and failed before answering, then a leg with none;
 *   - a request refused before its stream starts, and a CLI that dies before a word, streamed or
 *     not (the JSON error body; the stream's end);
 *   - the official SDKs' accumulators: @anthropic-ai/sdk over a mixed Claude Code session, and
 *     openai's responses.stream() over a Responses answer with no tools offered;
 *   - docs/clients.md's table of the rule against what src/protocols.js writes.
 *
 * Findings are `todo` cases with what they saw. Nothing spends a token; no live gateway is asked.
 */
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { anthropicDeltaUsage, anthropicUsage, openaiUsage, responsesUsage } from '../src/protocols.js';

const STUB = fileURLToPath(new URL('./stubs/cli-bridge.mjs', import.meta.url));
const DOCS = fileURLToPath(new URL('../docs/clients.md', import.meta.url));
const KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');

async function load(name) {
  try {
    return await import(name);
  } catch (e) {
    throw new Error(`${name} is not installed: run \`npm ci\` in the repository first (devDependencies, pinned) — ${e.message}`);
  }
}
const version = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), 'utf8')).version;

let dir, server, base, gateway, usageLog, upstream;
const mods = {};

function stubCli(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A built-in profile around the bridge stub, toolMode mcp, as test/bridge-clis.test.js runs it. */
function around(name, cli) {
  const p = structuredClone(CLI_PROFILES[name]);
  return {
    ...p,
    bin: STUB,
    cwd: path.join(dir, `ws-${name}`),
    toolMode: 'mcp',
    bridge: { ...p.bridge, readyTimeoutMs: 10_000, toolResultTimeoutMs: 60_000 },
    env: { STUB_CLI: cli, CLI_BRIDGE_LOG: path.join(dir, 'bridge.jsonl') },
    timeoutMs: 20_000,
    maxConcurrent: 8,
    models: [{ id: 'm' }],
  };
}

/** `codex exec --json` that hit a stream error and retried it: the turn completes, with usage or without. */
const codexRetried = (usage) => `for (const l of [{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: stub)' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Retried answer.' } }, { type: 'turn.completed'${usage ? `, usage: ${JSON.stringify(usage)}` : ''} }]) process.stdout.write(JSON.stringify(l) + '\\n');`;
const RETRIED = { input_tokens: 700, cached_input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 5 };

before(async () => {
  for (const name of ['ai', 'openbot-ai', '@ai-sdk/anthropic', 'openbot-ai-sdk-anthropic', '@ai-sdk/openai', 'openbot-ai-sdk-openai', '@ai-sdk/openai-compatible', '@anthropic-ai/sdk', 'openai', 'openbot-openai']) mods[name] = await load(name);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kswr-'));
  // An OpenAI-wire upstream: `nousage` answers and says nothing of its tokens; `usagefail` reports
  // counts, then fails before any text.
  upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (body.model === 'nousage') {
      send({ id: 'u1', object: 'chat.completion.chunk', created: 1, model: 'nousage', choices: [{ index: 0, delta: { role: 'assistant', content: 'upstream answer' }, finish_reason: null }] });
      send({ id: 'u1', object: 'chat.completion.chunk', created: 1, model: 'nousage', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else {
      send({ id: 'u2', object: 'chat.completion.chunk', created: 1, model: 'usagefail', choices: [], usage: { prompt_tokens: 500, completion_tokens: 0, total_tokens: 500 } });
      send({ error: { message: 'stub upstream overloaded' } });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const cfg = {
    auth: { enabled: true, keys: [KEY] },
    limits: { streamHoldMs: 300, streamKeepaliveMs: 60, bridge: { socket: path.join(dir, 'b.sock'), maxSessions: 8, maxSessionsPerKey: 8 } },
    adapters: {
      cx: around('codex', 'codex'),
      cc: around('claude', 'claude'),
      plain: { kind: 'cli', bin: stubCli('plain', `process.stdout.write('plain answer');`), args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: path.join(dir, 'ws-plain') },
      cxr: { kind: 'cli', bin: stubCli('cxr', codexRetried(RETRIED)), args: ['exec', '--json', '--', '{prompt}'], parser: 'codex-json', models: ['m'], cwd: path.join(dir, 'ws-cxr') },
      cxru: { kind: 'cli', bin: stubCli('cxru', codexRetried(null)), args: ['exec', '--json', '--', '{prompt}'], parser: 'codex-json', models: ['m'], cwd: path.join(dir, 'ws-cxru') },
      // Exits 1 before a word: a failure the client hears of before its stream starts.
      dead: { kind: 'cli', bin: stubCli('dead', `process.stderr.write('stub CLI died before answering'); process.exitCode = 1;`), args: ['{prompt}'], parser: 'raw', models: ['m'], cwd: path.join(dir, 'ws-dead') },
      up: { kind: 'http', wire: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: false, models: ['nousage', 'usagefail'] },
    },
    aliases: { mixed: ['up/usagefail', 'plain/m'] },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  const hub = gateway?.toolEngines?.mcp?.hub;
  if (hub) await Promise.all([...hub.sessions.values()].map((s) => s.close('test_done')));
});

after(async () => {
  await gateway?.close();
  if (server) await new Promise((r) => server.close(r));
  if (upstream) await new Promise((r) => upstream.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------- helpers */

const CITY = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const result = (city) => `RESULT for ${city}`;
let tags = 0;
const tag = () => `#r${++tags}-${crypto.randomBytes(3).toString('hex')}`;
const rowsOf = (model) => usageLog.tail(500).filter((r) => r.model === model).reverse();
const lastRows = (model, n) => rowsOf(model).slice(-n);

const CODEX_GAP = /^cx reports a run's tokens once, when the run ends/;
const CLAUDE_GAP = /^no model step of cc reported tokens in this turn/;
const RAW_GAP = /plain runs with parser raw: the CLI's plain output carries no token counts/;
/** The stub codex's turn.completed: the session's whole spend. */
const CODEX_RUN = { input: 1100, output: 30, cacheRead: 0, cacheWrite: 0 };
/** The stub Claude Code's two messages: message 1's start (10 + 100 written + 1000 read in, 1 out), then the run's total less it. */
const CLAUDE_FIRST = { input: 1110, output: 1, cacheRead: 1000, cacheWrite: 100 };
const CLAUDE_LAST = { input: 1220, output: 29, cacheRead: 1000, cacheWrite: 200 };

const GENERATIONS = [
  {
    id: 'openbot',
    ai: 'openbot-ai',
    faces: {
      messages: (id) => mods['openbot-ai-sdk-anthropic'].createAnthropic({ baseURL: `${base}/v1`, apiKey: KEY })(id),
      responses: (id) => mods['openbot-ai-sdk-openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).responses(id),
      chat: (id) => mods['openbot-ai-sdk-openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).chat(id),
    },
    packages: { messages: 'openbot-ai-sdk-anthropic', responses: 'openbot-ai-sdk-openai', chat: 'openbot-ai-sdk-openai' },
  },
  {
    id: 'latest',
    ai: 'ai',
    faces: {
      messages: (id) => mods['@ai-sdk/anthropic'].createAnthropic({ baseURL: `${base}/v1`, apiKey: KEY })(id),
      responses: (id) => mods['@ai-sdk/openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).responses(id),
      chat: (id) => mods['@ai-sdk/openai'].createOpenAI({ baseURL: `${base}/v1`, apiKey: KEY }).chat(id),
      compatible: (id) => mods['@ai-sdk/openai-compatible'].createOpenAICompatible({ name: 'keysmith', baseURL: `${base}/v1`, apiKey: KEY, includeUsage: true }).chatModel(id),
    },
    packages: { messages: '@ai-sdk/anthropic', responses: '@ai-sdk/openai', chat: '@ai-sdk/openai', compatible: '@ai-sdk/openai-compatible' },
  },
];
const ROUTE = { messages: '/v1/messages', responses: '/v1/responses', chat: '/v1/chat/completions', compatible: '/v1/chat/completions' };
const providerOptions = (face) => (face === 'responses' ? { openai: { store: false } } : undefined);

function aiTools(ai) {
  return { get_weather: ai.tool({ description: 'Weather', inputSchema: ai.jsonSchema(CITY), execute: async ({ city }) => result(city) }) };
}

async function streamRun(ai, options) {
  const errors = [];
  const run = ai.streamText({ maxRetries: 0, ...options, onError: ({ error }) => errors.push(error) });
  const parts = [];
  for await (const p of run.fullStream) parts.push(p);
  const steps = await run.steps.catch(() => []);
  const usage = await run.totalUsage.catch(() => null);
  const finish = parts.find((p) => p.type === 'finish');
  return { parts, steps, usage, finish, text: parts.filter((p) => p.type === 'text-delta').map((p) => p.text ?? p.delta ?? '').join(''), errors: [...errors, ...parts.filter((p) => p.type === 'error').map((p) => p.error)] };
}

/** generateText, its failure kept as a value (a client that aborts is what these cases look for). */
async function generate(ai, options) {
  try {
    return { out: await ai.generateText({ maxRetries: 0, ...options }), error: null };
  } catch (error) {
    return { out: null, error };
  }
}

const message = (e) => String(e?.message ?? e?.error?.message ?? (typeof e === 'object' ? JSON.stringify(e) : e));
const noErrors = (errors, label) => assert.deepEqual(errors.map(message), [], `${label}: the client parsed every chunk`);
/** A step's usage as [input, output] (ai 6 and 7 both give numbers here). */
const counts = (u) => [u?.inputTokens, u?.outputTokens];

/* ------------------------------------------------------------- the AI SDK, per face */

/** The /v1/messages error body, read by @ai-sdk/anthropic (a finding of this re-check). */
const ERROR_BODY_TODO = 'server.js: the error body on /v1/messages is OpenAI-shaped ({ error: { message, type, param, code } }); @ai-sdk/anthropic\'s error schema wants { type: "error", error: { type, message } }, so the client\'s message is the HTTP status text and keysmith\'s reason is only in responseBody';

for (const gen of GENERATIONS) {
  for (const [face, make] of Object.entries(gen.faces)) {
    describe(`re-check · AI SDK ${gen.id} · ${face} (${ROUTE[face]})`, () => {
      const label = () => `${gen.ai}@${version(gen.ai)} + ${gen.packages[face]}@${version(gen.packages[face])}`;

      for (const stream of [true, false]) {
        const how = stream ? 'streamed' : 'not streamed';

        test(`${how}: codex's two calls, one after the other — two turns with no counts yet, then the answer with the run's`, async () => {
          const ai = mods[gen.ai];
          const options = { model: make('cx/m'), prompt: `Two ${tag()} SCENARIO=two-calls`, tools: aiTools(ai), stopWhen: ai.stepCountIs(4), providerOptions: providerOptions(face) };
          let steps, total, text;
          if (stream) {
            const run = await streamRun(ai, options);
            noErrors(run.errors, label());
            [steps, total, text] = [run.steps, run.usage, run.text];
          } else {
            const { out, error } = await generate(ai, options);
            assert.equal(error, null, `${label()}: ${message(error)}`);
            [steps, total, text] = [out.steps, out.totalUsage, out.text];
          }
          assert.deepEqual(steps.map((s) => s.finishReason), ['tool-calls', 'tool-calls', 'stop'], label());
          assert.deepEqual(steps.slice(0, 2).map((s) => s.toolCalls.map((c) => (c.input ?? c.args).city)), [['Ankara'], ['Izmir']], label());
          assert.match(text, /Ankara RESULT for Ankara; Izmir RESULT for Izmir$/, label());
          assert.deepEqual(counts(total), [CODEX_RUN.input, CODEX_RUN.output], `${label()}: the run's spend, once`);
          const rows = lastRows('cx/m', 3);
          for (const r of rows.slice(0, 2)) {
            assert.equal(r.usage, null, `${label()}: a turn with no count is null in its row, never 0`);
            assert.match(r.usageReason, CODEX_GAP, label());
          }
          assert.deepEqual(rows[2].usage, CODEX_RUN, label());
        });

        test(`${how}: Claude Code's counts (known on every answer): exact per step and in all, no marker`, async () => {
          const ai = mods[gen.ai];
          const options = { model: make('cc/m'), prompt: `Weather ${tag()}`, tools: aiTools(ai), stopWhen: ai.stepCountIs(3), providerOptions: providerOptions(face) };
          let steps, total;
          if (stream) {
            const run = await streamRun(ai, options);
            noErrors(run.errors, label());
            [steps, total] = [run.steps, run.usage];
          } else {
            const { out, error } = await generate(ai, options);
            assert.equal(error, null, `${label()}: ${message(error)}`);
            [steps, total] = [out.steps, out.totalUsage];
          }
          assert.deepEqual(steps.map((s) => s.finishReason), ['tool-calls', 'stop'], label());
          assert.deepEqual(steps.map((s) => counts(s.usage)), [[CLAUDE_FIRST.input, CLAUDE_FIRST.output], [CLAUDE_LAST.input, CLAUDE_LAST.output]], `${label()}: each answer's own share`);
          assert.deepEqual(counts(total), [CLAUDE_FIRST.input + CLAUDE_LAST.input, CLAUDE_FIRST.output + CLAUDE_LAST.output], `${label()}: Claude Code's run total`);
          if (face === 'messages') for (const s of steps) assert.equal(s.providerMetadata?.anthropic?.usage?.keysmith_usage, undefined, `${label()}: no marker on a count`);
          assert.deepEqual(lastRows('cc/m', 2).map((r) => r.usage), [CLAUDE_FIRST, CLAUDE_LAST], label());
        });

        test(`${how}: Claude Code's two calls — known, unknown (the step's second call), known: every turn parses and the totals are the known ones`, async () => {
          const ai = mods[gen.ai];
          const options = { model: make('cc/m'), prompt: `Two ${tag()} SCENARIO=two-calls`, tools: aiTools(ai), stopWhen: ai.stepCountIs(4), providerOptions: providerOptions(face) };
          let steps, total;
          if (stream) {
            const run = await streamRun(ai, options);
            noErrors(run.errors, label());
            [steps, total] = [run.steps, run.usage];
          } else {
            const { out, error } = await generate(ai, options);
            assert.equal(error, null, `${label()}: ${message(error)}`);
            [steps, total] = [out.steps, out.totalUsage];
          }
          assert.deepEqual(steps.map((s) => s.finishReason), ['tool-calls', 'tool-calls', 'stop'], label());
          assert.deepEqual(counts(steps[0].usage), [CLAUDE_FIRST.input, CLAUDE_FIRST.output], label());
          assert.deepEqual(counts(steps[2].usage), [CLAUDE_LAST.input, CLAUDE_LAST.output], label());
          // The unknown turn adds nothing: 0 where the face writes 0, nothing where it writes null.
          assert.ok([0, undefined].includes(steps[1].usage?.outputTokens), `${label()}: ${JSON.stringify(steps[1].usage)}`);
          assert.deepEqual(counts(total), [CLAUDE_FIRST.input + CLAUDE_LAST.input, CLAUDE_FIRST.output + CLAUDE_LAST.output], label());
          if (face === 'messages') {
            assert.equal(steps[1].providerMetadata?.anthropic?.usage?.keysmith_usage, 'unknown', label());
            assert.match(steps[1].providerMetadata?.anthropic?.usage?.reason, CLAUDE_GAP, label());
          }
          const rows = lastRows('cc/m', 3);
          assert.deepEqual(rows.map((r) => r.usage), [CLAUDE_FIRST, null, CLAUDE_LAST], label());
          assert.match(rows[1].usageReason, CLAUDE_GAP, label());
        });

        for (const [model, known] of [['cxr/m', true], ['cxru/m', false]]) {
          test(`${how}, tools offered (tool_choice none): codex exec that retried a stream error, ${known ? 'with' : 'without'} usage — the answer stands${known ? ', its counts exact' : ', the row null with why'}`, async () => {
            const ai = mods[gen.ai];
            const options = { model: make(model), prompt: `Hi ${tag()}`, tools: aiTools(ai), toolChoice: 'none', providerOptions: providerOptions(face) };
            let text, total;
            if (stream) {
              const run = await streamRun(ai, options);
              noErrors(run.errors, label());
              [text, total] = [run.text, run.usage];
            } else {
              const { out, error } = await generate(ai, options);
              assert.equal(error, null, `${label()}: ${message(error)}`);
              [text, total] = [out.text, out.totalUsage];
            }
            assert.equal(text, 'Retried answer.', label());
            const [row] = lastRows(model, 1);
            assert.equal(row.status, 'ok', label());
            if (known) {
              assert.deepEqual(counts(total), [RETRIED.input_tokens, RETRIED.output_tokens], label());
              assert.deepEqual(row.usage, { input: 700, output: 40, cacheRead: 100, cacheWrite: 0, reasoning: 5 }, label());
            } else {
              assert.equal(row.usage, null, label());
              assert.match(row.usageReason, /cxru reported no token counts for this run \(parser codex-json\)/, label());
            }
          });
        }

        // The chat faces hand an HTTP leg the request verbatim (the relay): its answer is the upstream's bytes, not keysmith's.
        if (face === 'messages' || face === 'responses') test(`${how}, tools offered (tool_choice none): an HTTP leg whose upstream says nothing of its tokens — the client reads the answer`, { todo: nullUsageTodo(gen, face, stream) }, async () => {
          const ai = mods[gen.ai];
          const options = { model: make('up/nousage'), prompt: `Hi ${tag()}`, tools: aiTools(ai), toolChoice: 'none', providerOptions: providerOptions(face) };
          if (stream) {
            const run = await streamRun(ai, options);
            noErrors(run.errors, label());
            assert.equal(run.text, 'upstream answer', label());
            assert.equal(run.finish?.finishReason, 'stop', `${label()}: the stream's last event read`);
          } else {
            const { out, error } = await generate(ai, options);
            assert.equal(error, null, `${label()}: ${message(error)}`);
            assert.equal(out.text, 'upstream answer', label());
          }
          const [row] = lastRows('up/nousage', 1);
          assert.equal(row.usage, null, label());
        });
      }

      // A Responses request with no tools is written by server.js (the plain stream), which
      // @ai-sdk/openai 4.x cannot read at all (test/wire-conformance.test.js, plainResponsesStream).
      const plainLatest = face === 'responses' && gen.id === 'latest' ? 'server.js: the plain /v1/responses stream\'s response.created has no created_at (test/wire-conformance.test.js)' : false;

      test('a route whose first leg reported counts and failed before a word, then a leg with none: the client reads the answer', { todo: plainLatest }, async () => {
        const ai = mods[gen.ai];
        const run = await streamRun(ai, { model: make('mixed'), prompt: `Hi ${tag()}`, providerOptions: providerOptions(face) });
        noErrors(run.errors, label());
        assert.equal(run.text, 'plain answer', label());
        assert.equal(lastRows('mixed', 1)[0].status, 'ok', label());
      });

      test('the same route: the row keeps the failed leg\'s counts and says the answering leg had none', { todo: 'gateway.js/server.js: a failed leg\'s usage events reach the face, so the wire writes its counts as the answer\'s (output 0, no marker) and the row is { input: 500, output: 0 } with no usageReason: the answering leg\'s gap is lost' }, async () => {
        const ai = mods[gen.ai];
        await streamRun(ai, { model: make('mixed'), prompt: `Hi ${tag()}`, providerOptions: providerOptions(face) });
        const [row] = lastRows('mixed', 1);
        assert.match(row.usageReason ?? '', RAW_GAP, `${label()}: ${JSON.stringify(row)}`);
      });

      test('a request refused before its stream starts (no such adapter): the client is told keysmith\'s reason', { todo: face === 'messages' ? ERROR_BODY_TODO : false }, async () => {
        const ai = mods[gen.ai];
        const run = await streamRun(ai, { model: make('nosuch/m'), prompt: `Hi ${tag()}`, providerOptions: providerOptions(face) });
        assert.ok(run.errors.length > 0, label());
        assert.match(message(run.errors[0]), /no adapter named "nosuch"/, `${label()}: ${message(run.errors[0])}`);
      });

      test('not streamed, a CLI that dies before a word: a 502 with keysmith\'s reason', { todo: face === 'messages' ? ERROR_BODY_TODO : false }, async () => {
        const ai = mods[gen.ai];
        const { error } = await generate(ai, { model: make('dead/m'), prompt: `Hi ${tag()}`, providerOptions: providerOptions(face) });
        assert.ok(error, label());
        assert.match(message(error), /dead exited 1: stub CLI died before answering/, `${label()}: ${message(error)}`);
        assert.equal(lastRows('dead/m', 1)[0].status, 'error', label());
      });

      test('streamed, a CLI that dies before a word: the client is told it failed', { todo: 'cli-adapter.js/server.js: a streamed face stops reading at the parser\'s `done`, so the exit-code check after the parse loop (CliAdapter.complete: "exited 1") never runs — the client gets an empty answer that ends normally (stop / end_turn / completed) with unknown usage, and the row is `ok`' }, async () => {
        const ai = mods[gen.ai];
        const run = await streamRun(ai, { model: make('dead/m'), prompt: `Hi ${tag()}`, providerOptions: providerOptions(face) });
        assert.ok(run.errors.length > 0, `${label()}: finish ${run.finish?.finishReason}, text ${JSON.stringify(run.text)}`);
        assert.equal(lastRows('dead/m', 1)[0].status, 'error', label());
      });
    });
  }
}

/**
 * The Responses tool face writes `usage: null` when an answer's leg said nothing of its tokens
 * (src/tools/faces.js, responseObject: `usage ? responsesUsage(usage) : null`), where every other
 * face writes the zeros of before. @ai-sdk/openai 3.0.99 (OpenBot's) types a Response's usage
 * `.optional()` — no null — and response.completed's as required.
 */
function nullUsageTodo(gen, face, stream) {
  if (face !== 'responses' || gen.id !== 'openbot') return false;
  return stream
    ? 'faces.js: response.completed with usage null fails @ai-sdk/openai 3.0.99\'s schema; it reads it as an unknown chunk and skips it, so the run ends with no finish reason ("other"), no usage and no response id'
    : 'faces.js: a Response with usage null fails @ai-sdk/openai 3.0.99\'s schema: generateText throws "Type validation failed … usage"';
}

/* --------------------------------------------------------------- the official SDKs */

describe('re-check · @anthropic-ai/sdk · Claude Code\'s known counts and the unknown second call, streamed', () => {
  test('message_delta carries each answer\'s counts (input and cache from there, as the SDK\'s accumulator reads them); the second call\'s has 0 output, null input, the marker', async () => {
    const c = new mods['@anthropic-ai/sdk'].default({ baseURL: base, apiKey: KEY, maxRetries: 0 });
    const history = [{ role: 'user', content: `Two ${tag()} SCENARIO=two-calls` }];
    const finals = [];
    const deltas = [];
    for (let turn = 0; turn < 3; turn++) {
      const s = c.messages.stream({ model: 'cc/m', max_tokens: 256, tools: [{ name: 'get_weather', description: 'Weather', input_schema: CITY }], messages: history });
      for await (const e of s) if (e.type === 'message_delta') deltas.push(e.usage);
      const msg = await s.finalMessage();
      finals.push(msg);
      if (msg.stop_reason !== 'tool_use') break;
      history.push({ role: 'assistant', content: msg.content });
      history.push({ role: 'user', content: msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: result(b.input.city) })) });
    }
    assert.deepEqual(finals.map((m) => m.stop_reason), ['tool_use', 'tool_use', 'end_turn']);
    assert.deepEqual([finals[0].usage.input_tokens, finals[0].usage.cache_creation_input_tokens, finals[0].usage.cache_read_input_tokens, finals[0].usage.output_tokens], [10, 100, 1000, 1]);
    // The accumulator keeps message_start's input (0) when message_delta's is null; the marker is on the event.
    assert.deepEqual([finals[1].usage.input_tokens, finals[1].usage.output_tokens], [0, 0]);
    assert.deepEqual([deltas[1].input_tokens, deltas[1].output_tokens, deltas[1].cache_creation_input_tokens, deltas[1].cache_read_input_tokens], [null, 0, null, null]);
    assert.equal(deltas[1].keysmith_usage, 'unknown');
    assert.match(deltas[1].reason, CLAUDE_GAP);
    assert.deepEqual([finals[2].usage.input_tokens, finals[2].usage.cache_creation_input_tokens, finals[2].usage.cache_read_input_tokens, finals[2].usage.output_tokens], [20, 200, 1000, 29]);
    for (const i of [0, 2]) assert.equal(deltas[i].keysmith_usage, undefined);
  });
});

for (const pkg of ['openai', 'openbot-openai']) {
  describe(`re-check · ${pkg} (official openai SDK) · Responses with no tools offered, streamed (server.js writes it, not the tool face)`, () => {
    test('responses.stream() reads the answer of a CLI with no counts', { todo: 'server.js: the plain /v1/responses stream opens its message item (output_item.added, content_part.added) and never closes it (no content_part.done, no output_item.done), so the openai SDK\'s ResponseStream refuses to finish: "Cannot complete response with unfinished output items". On main, 1dcbd05 puts the output in response.completed and this passes: lift the todo after the merge' }, async () => {
      const c = new mods[pkg].default({ baseURL: `${base}/v1`, apiKey: KEY, maxRetries: 0 });
      const s = c.responses.stream({ model: 'plain/m', input: 'hi', store: false });
      s.on('error', () => {});
      const r = await s.finalResponse();
      assert.equal(r.output_text, 'plain answer');
      assert.equal(r.usage.keysmith_usage, 'unknown');
    });
  });
}

/* ---------------------------------------------------------------- the rule, documented */

test('docs/clients.md\'s table of unknown usage says, field by field, what src/protocols.js writes', () => {
  const doc = fs.readFileSync(DOCS, 'utf8');
  const section = doc.slice(doc.indexOf('## Unknown usage on the wire'));
  assert.ok(section.startsWith('## Unknown usage on the wire'), 'the section is there');
  assert.match(section, /"keysmith_usage": "unknown"/, 'the extension field is named');
  const rows = section.split('\n').filter((l) => /^\| `\/v1\//.test(l));
  // A cell names a count in backticks, or the cache's two in words.
  const fieldsIn = (cell) => [...[...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]), ...(/the cache's two counts/.test(cell) ? ['cache_creation_input_tokens', 'cache_read_input_tokens'] : [])];
  const flat = (o, out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') flat(v, out);
      else out[k] = v;
    }
    return out;
  };
  const unknown = { unknown: 'why' };
  const written = {
    '/v1/chat/completions': flat(openaiUsage(unknown)),
    '/v1/messages`, a whole Message': flat(anthropicUsage(unknown)),
    '/v1/messages`, `message_delta`': flat(anthropicDeltaUsage(unknown)),
    '/v1/responses': flat(responsesUsage(unknown)),
  };
  assert.equal(rows.length, 4, 'a row per face');
  for (const row of rows) {
    const [, faceCell, zeroCell, nullCell] = row.split('|').map((c) => c.trim());
    const key = Object.keys(written).find((k) => faceCell.startsWith('`' + k));
    assert.ok(key, `a face of the rule: ${faceCell}`);
    const w = written[key];
    for (const f of fieldsIn(zeroCell)) assert.equal(w[f], 0, `${faceCell}: ${f} is 0`);
    for (const f of fieldsIn(nullCell)) assert.equal(w[f], null, `${faceCell}: ${f} is null`);
    const counted = Object.keys(w).filter((k) => k !== 'reason' && k !== 'keysmith_usage');
    assert.deepEqual([...fieldsIn(zeroCell), ...fieldsIn(nullCell)].sort(), counted.sort(), `${faceCell}: every count of the object is in the table`);
    assert.equal(w.keysmith_usage, 'unknown', faceCell);
    assert.equal(w.reason, 'why', faceCell);
  }
});
