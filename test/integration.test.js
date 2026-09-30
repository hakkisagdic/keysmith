/**
 * End-to-end HTTP tests against a stub CLI adapter.
 *
 * The stub is a ~30-line script that prints the same NDJSON shape Command Code prints,
 * which means these tests exercise the whole path — spawn, parse, SSE framing, session
 * mapping, failover — without touching a real provider or spending a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';

const KEY = 'ks_test_000000000000000000000000';

const STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : '');
const model = at('--model');
const resume = at('--resume');
const prompt = argv[argv.length - 1];
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

if (model === 'bad') { process.stderr.write('stub: upstream is down\\n'); process.exit(3); }

line({ type: 'event', event: { type: 'thinking_delta', delta: 'thinking hard' } });
line({ type: 'event', event: { type: 'text_delta', delta: resume ? '[resumed ' + resume + '] ' : '' } });
line({ type: 'event', event: { type: 'text_delta', delta: 'answer from ' + model } });
line({ type: 'event', event: { type: 'text_delta', delta: ' :: ' + prompt.slice(0, 90) } });
line({ type: 'event', event: { type: 'model_request_end', usage: { inputTokens: 11, outputTokens: 7 } } });
line({ type: 'result', sessionId: 'up_42', subtype: 'success', usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'end_turn' });
`;

let dir, server, base;
const log = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-itest-'));
  const bin = path.join(dir, 'stubagent');
  fs.writeFileSync(bin, STUB, { mode: 0o755 });

  const cfg = {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: true, keys: [KEY] },
    log: { usage: true, body: false },
    limits: { maxConcurrent: 2, timeoutMs: 20_000 },
    tunnel: { provider: 'cloudflared' },
    adapters: {
      stub: { kind: 'cli', bin, args: ['-p', '{noSession}', ['--model', '{model}'], '{prompt}'], resumeArgs: ['-p', '--resume', '{session}', '{prompt}'], persistSessions: true, parser: 'cmd-ndjson', models: ['good', 'bad'], timeoutMs: 15_000 },
      other: { kind: 'cli', bin, args: ['-p', ['--model', '{model}'], '{prompt}'], parser: 'cmd-ndjson', models: ['good'], timeoutMs: 15_000 },
      // Configured, but its credential is not in this environment: it must fail loudly.
      broken: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '{env:KEYSMITH_TEST_ABSENT_KEY}' },
    },
    aliases: { resilient: ['stub/bad', 'stub/good'], typo: ['ghost/m1', 'broken/gpt-4', 'stub/good'] },
  };
  const usage = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(new Gateway(cfg, { log: (m) => log.push(m) }), cfg, { usage, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function post(route, body, init = {}) {
  const res = await fetch(base + route, { method: 'POST', headers: { ...auth, ...(init.headers || {}) }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text(), res };
}

/* ----------------------------------------------------------------------- the gate */

test('no key, no answer', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'stub/good', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /API key/);
});

test('/healthz stays keyless so a supervisor can poll it', async () => {
  const r = await (await fetch(`${base}/healthz`)).json();
  assert.equal(r.ok, true);
  assert.equal(typeof r.adapters, 'number', 'healthz must not enumerate adapter ids to strangers');
});

test('the status page is behind the same key as the API', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  const ok = await fetch(`${base}/?api_key=${KEY}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /key<\/span>smith|keysmith/);
});

/* ------------------------------------------------------------------------- models */

test('the catalogue namespaces CLI models under the adapter id', async () => {
  const body = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes('stub/good'), ids.join(','));
  assert.equal(body.data.find((m) => m.id === 'stub/good').keysmith.kind, 'cli');
  assert.ok(ids.includes('resilient'), 'aliases must be listable too');
});

/* -------------------------------------------------------------------- chat.completions */

test('a bare adapter id routes to that adapter\'s own model', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'other', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200, text);
  assert.match(JSON.parse(text).choices[0].message.content, /answer from /);
});

test('an adapter that is configured but cannot load says why, in every place you would look', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'broken/gpt-4', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 503, text);
  assert.match(JSON.parse(text).error.message, /did not load/);
  assert.match(JSON.parse(text).error.message, /KEYSMITH_TEST_ABSENT_KEY/, 'the hint must name the missing credential');
  const listed = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  assert.ok((listed.keysmith?.errors || []).some((e) => e.startsWith('broken:')), JSON.stringify(listed));
  const page = await (await fetch(`${base}/?api_key=${KEY}`)).text();
  assert.match(page, /did not load/);
});

test('a dead leg inside an alias keeps answering, and is named where you would look', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'typo', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200, 'the healthy leg serves the request; the route is not poisoned by its typos');
  assert.match(JSON.parse(text).choices[0].message.content, /answer from good/);

  const listed = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  const aliasErrors = (listed.keysmith?.errors || []).filter((e) => e.startsWith('alias "typo"'));
  assert.equal(aliasErrors.length, 2, JSON.stringify(listed.keysmith?.errors));
  assert.ok(aliasErrors.some((e) => e.includes('ghost/m1') && e.includes('no adapter named "ghost"')), aliasErrors.join(' | '));
  assert.ok(aliasErrors.some((e) => e.includes('broken/gpt-4') && e.includes('did not load')), aliasErrors.join(' | '));

  const routes = await (await fetch(`${base}/v1/keysmith/routes`, { headers: auth })).json();
  assert.equal(routes.alias_warnings.typo.length, 2, JSON.stringify(routes.alias_warnings));
  assert.deepEqual(routes.aliases.typo, ['ghost/m1', 'broken/gpt-4', 'stub/good'], 'the config is still reported verbatim, warnings sit beside it');

  const page = await (await fetch(`${base}/?api_key=${KEY}`)).text();
  assert.match(page, /Alias legs that can never work/);
  assert.match(page, /ghost\/m1/);
  assert.ok(page.indexOf('<td class="bad">typo</td>') > -1 || page.includes('class="bad">typo<'), 'the alias is flagged red in the model table too');

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.alias_warnings, 1, 'a supervisor can see the count without a key — names stay private');
});

test('a non-streaming CLI call comes back as an OpenAI completion with real usage', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'stub/good', stream: false, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'what is the capital of France' }] });
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.object, 'chat.completion');
  assert.match(body.choices[0].message.content, /answer from stub\/good|answer from good/);
  assert.ok(/capital of France/.test(body.choices[0].message.content), 'the prompt must reach the CLI');
  assert.equal(body.usage.prompt_tokens, 11);
  assert.equal(body.usage.completion_tokens, 7);
});

test('stream=true yields chunks and a [DONE] terminator', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'stub/good', stream: true, messages: [{ role: 'user', content: 'go' }] }) });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const frames = raw.split('\n\n').filter((f) => f.startsWith('data: '));
  assert.ok(frames.length >= 2, raw);
  assert.equal(frames.at(-1), 'data: [DONE]');
  const deltas = frames.slice(0, -1).map((f) => JSON.parse(f.slice(6))).flatMap((c) => c.choices?.map((ch) => ch.delta?.content || '') ?? []);
  assert.match(deltas.join(''), /answer from/);
});

test('a CLI that exits non-zero is an error, never an empty 200', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'stub/bad', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 502);
  assert.match(JSON.parse(text).error.message, /upstream is down/);
});

test('an alias fails over to the next declared candidate', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'resilient', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200, text);
  assert.match(JSON.parse(text).choices[0].message.content, /answer from good/);
});

test('an unknown adapter is a 404 that names the live ones', async () => {
  const { status, text } = await post('/v1/chat/completions', { model: 'nosuch/model', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 404);
  assert.match(JSON.parse(text).error.message, /stub/);
});

/* ------------------------------------------------------------------------ sessions */

test('chain-of-thought stays hidden until the client asks for it', async () => {
  const quiet = JSON.parse((await post('/v1/chat/completions', { model: 'stub/good', messages: [{ role: 'user', content: 'go' }] })).text);
  assert.equal(quiet.choices[0].message.reasoning_content, undefined);
  assert.doesNotMatch(quiet.choices[0].message.content, /thinking hard/);

  const asked = JSON.parse((await post('/v1/chat/completions', { model: 'stub/good', include_reasoning: true, messages: [{ role: 'user', content: 'go' }] })).text);
  assert.equal(asked.choices[0].message.reasoning_content, 'thinking hard');

  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'stub/good', stream: true, include_reasoning: true, messages: [{ role: 'user', content: 'go' }] }) });
  const raw = await res.text();
  assert.match(raw, /"reasoning_content":"thinking hard"/);
  assert.match(raw, /data: \[DONE\]/);
});

test('a keysmith session maps onto the CLI session and resumes it', async () => {
  const first = JSON.parse((await post('/v1/chat/completions', { model: 'stub/good', messages: [{ role: 'user', content: 'first' }] })).text);
  const sid = first.keysmith.session;
  assert.match(sid, /^kss_/);
  const second = JSON.parse((await post('/v1/chat/completions', { model: 'stub/good', messages: [{ role: 'user', content: 'second' }] }, { headers: { 'x-keysmith-session': sid } })).text);
  assert.match(second.choices[0].message.content, /\[resumed up_42\]/, 'the CLI must get --resume with its own id, not ours');
  assert.equal(second.keysmith.resumed, true);
  // The same continuity through the body field, for clients that cannot set headers.
  const third = JSON.parse((await post('/v1/chat/completions', { model: 'stub/good', session: sid, messages: [{ role: 'user', content: 'third' }] })).text);
  assert.match(third.choices[0].message.content, /\[resumed up_42\]/);
});

/* ----------------------------------------------------------------- the other faces */

test('/v1/messages speaks the Anthropic shape', async () => {
  const { status, text } = await post('/v1/messages', { model: 'stub/good', max_tokens: 64, messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].type, 'text');
  assert.match(body.content[0].text, /answer from/);
  assert.equal(body.usage.input_tokens, 11);
});

test('/v1/messages can stream the Anthropic event sequence', async () => {
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...auth, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'stub/good', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'go' }] }) });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const events = raw.split('\n\n').filter((f) => f.startsWith('event: ')).map((f) => f.slice(7).split('\n')[0]);
  assert.deepEqual(events.filter((e) => e !== 'content_block_delta'), ['message_start', 'content_block_start', 'ping', 'content_block_stop', 'message_delta', 'message_stop']);
  // The stub prints three text_delta events, one of them empty; an empty delta is noise
  // and never reaches the client.
  assert.equal(events.filter((e) => e === 'content_block_delta').length, 2);
  assert.match(raw, /"text":"answer from/);
});

test('/v1/responses speaks the OpenAI Responses shape', async () => {
  const { status, text } = await post('/v1/responses', { model: 'stub/good', input: [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }] });
  assert.equal(status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.match(body.output[0].content[0].text, /answer from/);
  assert.equal(typeof body.output_text, 'string');
  assert.match(body.output_text, /answer from/);
});

/* ------------------------------------------------------------------------- bookkeeping */

test('every served request lands in the usage log', async () => {
  const body = await (await fetch(`${base}/v1/keysmith/usage?hours=1&tail=20`, { headers: auth })).json();
  assert.ok(body.summary.requests >= 5, JSON.stringify(body.summary));
  assert.ok(body.entries.some((e) => e.model === 'stub/good' && e.status === 'ok'));
  assert.ok(body.entries.some((e) => e.status === 'error'), 'the stub/bad call must be recorded as a failure');
});
