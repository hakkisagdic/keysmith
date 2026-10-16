/**
 * The `google` profile against a stub of Gemini's OpenAI-compatible endpoint.
 *
 * The stub behaves the way the live endpoint was seen to on 2026-10-16 (gemini-3.6-flash):
 * a tool call comes back with `extra_content.google.thought_signature` (streamed: in the
 * first chunk, with no `index`), and a replayed call without it is refused with a 400 in a
 * one-element array. Quota and overload answer 429 / 503 the same way. Nothing here spends
 * a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { HTTP_PROFILES, getProfile } from '../src/profiles.js';
import { dotenvValue, resolveSecret } from '../src/config.js';
import { ThoughtSignatures, signatureOf } from '../src/thought-signatures.js';
import { redactKey, redactSecrets, streamRedactor } from '../src/redact.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const GATEWAY_KEY = 'ks_' + crypto.randomBytes(24).toString('base64url');
// Shaped like a real Google key (AIza + 35), so both redaction paths apply to it.
const GOOGLE_KEY = 'AIzaSy' + crypto.randomBytes(30).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 33);
// Not shaped like anything: only registration can take this one out.
const ODD_KEY = 'gk-' + crypto.randomBytes(18).toString('hex');

/** Not the key, and no 8 characters in a row of it past its public `AIza` prefix. */
function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 4; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of the key were printed`);
}

/* ------------------------------------------------------------------- stub upstream */

const SIG = (id) => `sig-for-${id}-` + 'Q'.repeat(400);
const seen = []; // every request the stub got: { url, auth, body }
let callNo = 0;

function geminiError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify([{ error: { code: status, message, status: code } }]));
}

function stubHandler(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-3.8-flash', object: 'model' }, { id: 'models/gemini-3.7-flash', object: 'model' }] }));
    }
    if (!req.url.endsWith('/chat/completions')) return geminiError(res, 404, 'NOT_FOUND', 'no such route');
    if (body.model === 'quota') return geminiError(res, 429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash. Please retry in 38s.', { 'retry-after': '38' });
    if (body.model === 'busy') return geminiError(res, 503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
    if (body.model === 'echo-key') return geminiError(res, 400, 'INVALID_ARGUMENT', `API key ${req.headers.authorization.slice(7)} is not valid for this project`);

    // Gemini 3's rule: a replayed function call in the current turn must carry its signature.
    for (const m of body.messages) {
      for (const tc of m.tool_calls || []) {
        if (signatureOf(tc) !== SIG(tc.id)) {
          return geminiError(res, 400, 'INVALID_ARGUMENT', `Function call is missing a thought_signature in functionCall parts. function call \`default_api:${tc.function?.name}\``);
        }
      }
    }
    const last = body.messages[body.messages.length - 1];
    const usage = { prompt_tokens: 56, completion_tokens: 17, total_tokens: 141 };
    if (last.role === 'tool' || !body.tools) {
      const text = last.role === 'tool' ? `It is ${JSON.parse(last.content).temp_c} C.` : 'plain answer';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
    }
    const id = `call_${++callNo}${crypto.randomBytes(3).toString('hex')}`;
    const call = { id, type: 'function', function: { name: body.tools[0].function.name, arguments: '{"city":"Ankara"}' }, extra_content: { google: { thought_signature: SIG(id) } } };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // As seen live: the whole call in the first chunk, no `index`, then a closing chunk.
      const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] } }] })}\n\n`;
      // Sent in small pieces, so the signature is split across network chunks.
      for (let i = 0; i < first.length; i += 97) res.write(first.slice(i, i + 97));
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'tool_calls' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage }));
  });
}

/* ----------------------------------------------------------------------- gateway */

let dir, upstream, upstreamBase, server, base, usageFile, gateway;
const log = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-google-'));
  // The key stays where a project already keeps it: a .env read by reference.
  fs.writeFileSync(path.join(dir, '.env'), `# measurement keys\nOTHER=1\nexport GOOGLE_API_KEY=${GOOGLE_KEY}  # free tier\nODD_KEY="${ODD_KEY}"\n`, { mode: 0o600 });
  upstream = http.createServer(stubHandler);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1beta/openai`;
  const cfg = {
    auth: { enabled: true, keys: [GATEWAY_KEY] },
    adapters: {
      google: { ...structuredClone(HTTP_PROFILES.google), baseUrl: upstreamBase, apiKey: `{dotenv:${path.join(dir, '.env')}#GOOGLE_API_KEY}` },
      // The same endpoint with the store off: what any OpenAI-wire adapter did before.
      gplain: { ...structuredClone(HTTP_PROFILES.google), baseUrl: upstreamBase, apiKey: `{dotenv:${path.join(dir, '.env')}#GOOGLE_API_KEY}`, thoughtSignatures: false },
      godd: { ...structuredClone(HTTP_PROFILES.google), baseUrl: upstreamBase, apiKey: `{dotenv:${path.join(dir, '.env')}#ODD_KEY}` },
    },
    aliases: { gem: ['google/gemini-3.8-flash'] },
  };
  usageFile = path.join(dir, 'usage.jsonl');
  gateway = new Gateway(cfg, { log: (m) => log.push(m) });
  server = createServer(gateway, cfg, { usage: new UsageLog(usageFile), log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json' };
async function post(body, route = '/v1/chat/completions') {
  const res = await fetch(base + route, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const chatRequests = () => seen.filter((s) => s.url.endsWith('/chat/completions'));

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const USER = { role: 'user', content: 'Weather in Ankara? Use the tool.' };
/** What LangChain's ChatOpenAI sends back: the call rebuilt from id, type and function only. */
const asLangChainSendsIt = (msg) => ({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { ...tc.function } })) });
const toolResults = (msg) => msg.tool_calls.map((tc) => ({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ temp_c: 14 }) }));

/* ------------------------------------------------------------------------ profile */

test('google is a built-in HTTP profile on the OpenAI wire, keyed by GOOGLE_API_KEY unless told otherwise', () => {
  const p = getProfile('google');
  assert.equal(p.kind, 'http');
  assert.equal(p.wire, 'openai');
  assert.equal(p.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(p.apiKey, '{env:GOOGLE_API_KEY}');
  assert.equal(p.thoughtSignatures, true);
  assert.equal(p.stripModelPrefix, 'models/');
});

test('the catalogue lists google/<model> without the models/ prefix, so alias legs check out', async () => {
  const res = await fetch(`${base}/v1/models?refresh`, { headers: auth });
  const ids = (await res.json()).data.map((m) => m.id);
  assert.ok(ids.includes('google/gemini-3.8-flash'), ids.join(', '));
  assert.ok(!ids.some((id) => id.includes('models/')), ids.join(', '));
  assert.deepEqual(gateway.aliasIssues, {});
});

/* -------------------------------------------------------------------- tool relay */

test('tools, tool_choice and the rest of the body reach Gemini verbatim, with the key as a Bearer token', async () => {
  const before = chatRequests().length;
  const body = { model: 'google/gemini-3.8-flash', messages: [USER], tools: TOOLS, tool_choice: { type: 'function', function: { name: 'get_weather' } }, temperature: 0.2, parallel_tool_calls: false, extra_body: { google: { thinking_config: { thinking_level: 'low' } } } };
  const r = await post(body);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-keysmith-mode'), 'passthrough');
  const sent = chatRequests().slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].auth, `Bearer ${GOOGLE_KEY}`);
  assert.deepEqual(sent[0].body, { ...body, model: 'gemini-3.8-flash' }, 'only the model id is rewritten');
  const msg = JSON.parse(r.text).choices[0].message;
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.ok(signatureOf(msg.tool_calls[0]), 'the answer reaches the client as Gemini wrote it, signature included');
});

test('a signature the client dropped is put back on the next turn, and Gemini answers', async () => {
  const t1 = JSON.parse((await post({ model: 'google/gemini-3.8-flash', messages: [USER], tools: TOOLS })).text).choices[0].message;
  const before = chatRequests().length;
  const r = await post({ model: 'google/gemini-3.8-flash', messages: [USER, asLangChainSendsIt(t1), ...toolResults(t1)], tools: TOOLS });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'It is 14 C.');
  const replayed = chatRequests().slice(before)[0].body.messages[1].tool_calls[0];
  assert.equal(signatureOf(replayed), SIG(t1.tool_calls[0].id));
  assert.deepEqual(replayed.function, t1.tool_calls[0].function, 'nothing else about the call is touched');
});

test('the same history without the store is refused, and the 400 reaches the client as Gemini said it', async () => {
  const t1 = JSON.parse((await post({ model: 'gplain/gemini-3.8-flash', messages: [USER], tools: TOOLS })).text).choices[0].message;
  const before = chatRequests().length;
  const r = await post({ model: 'gplain/gemini-3.8-flash', messages: [USER, asLangChainSendsIt(t1), ...toolResults(t1)], tools: TOOLS });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error.message, /INVALID_ARGUMENT: Function call is missing a thought_signature/);
  assert.equal(chatRequests().length - before, 1, 'the refused request is not run again as a tool-less completion');
});

test('a streamed tool call (no index, signature split across network chunks) is relayed byte for byte and remembered', async () => {
  const before = chatRequests().length;
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'google/gemini-3.8-flash', messages: [USER], tools: TOOLS, stream: true }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const first = JSON.parse(text.split('\n\n')[0].slice(6));
  const call = first.choices[0].delta.tool_calls[0];
  assert.equal(call.index, undefined);
  assert.equal(signatureOf(call), SIG(call.id), 'the client gets the chunk exactly as Gemini sent it');
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
  assert.equal(chatRequests().length - before, 1);

  const msg = { role: 'assistant', content: null, tool_calls: [call] };
  const r = await post({ model: 'google/gemini-3.8-flash', messages: [USER, asLangChainSendsIt(msg), ...toolResults(msg)], tools: TOOLS, stream: true });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /It is 14 C\./);
});

test('a signature the client kept is sent as the client sent it', async () => {
  const t1 = JSON.parse((await post({ model: 'google/gemini-3.8-flash', messages: [USER], tools: TOOLS })).text).choices[0].message;
  const before = chatRequests().length;
  const r = await post({ model: 'google/gemini-3.8-flash', messages: [USER, { role: 'assistant', content: null, tool_calls: t1.tool_calls }, ...toolResults(t1)], tools: TOOLS });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(chatRequests().slice(before)[0].body.messages[1], { role: 'assistant', content: null, tool_calls: t1.tool_calls });
});

/* ------------------------------------------------------------- provider refusals */

test('a 429 from Gemini reaches the client as a 429 with its message and retry-after, asked once', async () => {
  for (const stream of [false, true]) {
    const before = chatRequests().length;
    const r = await post({ model: 'google/quota', messages: [USER], tools: TOOLS, stream });
    assert.equal(r.status, 429, r.text);
    assert.equal(r.headers.get('retry-after'), '38');
    const err = JSON.parse(r.text).error;
    assert.equal(err.type, 'rate_limit_error');
    assert.match(err.message, /RESOURCE_EXHAUSTED: You exceeded your current quota.*limit: 20, model: gemini-3\.8-flash/);
    assert.equal(chatRequests().length - before, 1, `stream=${stream}: one request upstream, not a second tool-less one`);
  }
});

test('without tools, a 429 or a 503 is still the provider\'s status, not a 502', async () => {
  const q = await post({ model: 'google/quota', messages: [USER] });
  assert.equal(q.status, 429, q.text);
  assert.equal(q.headers.get('retry-after'), '38');
  assert.match(JSON.parse(q.text).error.message, /RESOURCE_EXHAUSTED/);
  const b = await post({ model: 'google/busy', messages: [USER] });
  assert.equal(b.status, 503, b.text);
  assert.match(JSON.parse(b.text).error.message, /UNAVAILABLE: The model is overloaded/);
  const bt = await post({ model: 'google/busy', messages: [USER], tools: TOOLS });
  assert.equal(bt.status, 503, bt.text);
});

/* ------------------------------------------------------------------ the key */

test('a provider error that quotes the Google key: the client, usage.jsonl and the log all get it redacted', async () => {
  const r = await post({ model: 'google/echo-key', messages: [USER], tools: TOOLS });
  assert.equal(r.status, 400);
  const r2 = await post({ model: 'google/echo-key', messages: [USER] });
  const r3 = await post({ model: 'godd/echo-key', messages: [USER] }); // a key no shape would catch
  for (const [where, text] of [['tool relay error', r.text], ['completion error', r2.text], ['completion error, odd key', r3.text]]) {
    assert.match(text, /is not valid for this project/, `${where}: the failure is still reported`);
    assertNoKey(text, GOOGLE_KEY, where);
    assertNoKey(text, ODD_KEY, where);
  }
  assert.ok(r.text.includes(redactKey(GOOGLE_KEY)), r.text);
  assert.ok(r3.text.includes(redactKey(ODD_KEY)), r3.text);
  const usage = fs.readFileSync(usageFile, 'utf8');
  assert.match(usage, /is not valid for this project/);
  const logText = log.join('\n');
  assert.match(logText, /is not valid for this project/);
  for (const [where, text] of [['usage.jsonl', usage], ['gateway log', logText]]) {
    assertNoKey(text, GOOGLE_KEY, where);
    assertNoKey(text, ODD_KEY, where);
  }
});

test('/healthz, the status page, /v1/models and /v1/keysmith/routes never carry the Google key', async () => {
  const pages = {
    healthz: await (await fetch(`${base}/healthz`)).text(),
    status: await (await fetch(`${base}/`, { headers: auth })).text(),
    models: await (await fetch(`${base}/v1/models`, { headers: auth })).text(),
    routes: await (await fetch(`${base}/v1/keysmith/routes`, { headers: auth })).text(),
    usage: await (await fetch(`${base}/v1/keysmith/usage?tail=50`, { headers: auth })).text(),
  };
  assert.match(pages.status, /google/);
  for (const [where, text] of Object.entries(pages)) {
    assertNoKey(text, GOOGLE_KEY, where);
    assertNoKey(text, ODD_KEY, where);
  }
});

test('redaction takes out a Google-shaped key nobody registered, whole and streamed in pieces', () => {
  const stranger = 'AIza' + 'B'.repeat(20) + crypto.randomBytes(12).toString('hex').slice(0, 15);
  assert.equal(stranger.length, 39);
  const s = redactSecrets(`upstream said: key=${stranger}.`);
  assertNoKey(s, stranger, 'redactSecrets');
  assert.ok(s.includes(redactKey(stranger)), s);
  const r = streamRedactor();
  let out = '';
  for (const piece of ['bad key ', stranger.slice(0, 3), stranger.slice(3, 17), stranger.slice(17), ' end']) out += r.push(piece);
  out += r.end();
  assertNoKey(out, stranger, 'streamRedactor');
  assert.match(out, /^bad key AIza…39 fp:[0-9a-f]{8} end$/);
});

test('keysmith add google --key {dotenv:…}: saved as a reference, never resolved onto the screen', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-google-cli-'));
  try {
    const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: path.join(home, 'config.json'), KEYSMITH_DATA: path.join(home, 'data') };
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'GOOGLE_API_KEY']) delete env[k];
    fs.writeFileSync(path.join(home, '.env'), `GOOGLE_API_KEY='${GOOGLE_KEY}'\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    const plain = run('add', 'google', '--as', 'g0');
    assert.match(plain.stdout, /GOOGLE_API_KEY is not set in this shell[\s\S]*\{dotenv:~\/project\/\.env#GOOGLE_API_KEY\}/);
    const add = run('add', 'google', '--key', '{dotenv:~/.env#GOOGLE_API_KEY}');
    assert.equal(add.status, 0, add.stderr);
    const missing = run('add', 'google', '--as', 'g2', '--key', '{dotenv:~/.env#NOPE}');
    assert.match(missing.stdout, /does not resolve to a key right now/);
    const bad = run('add', 'google', '--as', 'g3', '--key', '{dotenv:~/.env}');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /names one variable after a #/);
    const listed = run('adapters');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(saved.adapters.google.apiKey, '{dotenv:~/.env#GOOGLE_API_KEY}');
    assert.equal(saved.adapters.google.thoughtSignatures, true);
    for (const [where, text] of [['add', add.stdout + add.stderr], ['add, unresolved', missing.stdout + missing.stderr], ['add, malformed', bad.stdout + bad.stderr], ['adapters', listed.stdout + listed.stderr], ['config', JSON.stringify(saved)]]) {
      assertNoKey(text, GOOGLE_KEY, where);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ {dotenv:…} */

test('{dotenv:path#NAME} reads one variable the way a shell or python-dotenv would', () => {
  const text = [
    '# comment GOOGLE_API_KEY=commented-out',
    'A=plain',
    'export B=exported  # trailing comment',
    "C='single # not a comment'",
    'D="double \\"quoted\\" \\n line"',
    'E = spaced ',
    'F=first',
    'F=last wins',
    'G=',
    'H=a#b',
  ].join('\r\n');
  assert.equal(dotenvValue(text, 'A'), 'plain');
  assert.equal(dotenvValue(text, 'B'), 'exported');
  assert.equal(dotenvValue(text, 'C'), 'single # not a comment');
  assert.equal(dotenvValue(text, 'D'), 'double "quoted" \n line');
  assert.equal(dotenvValue(text, 'E'), 'spaced');
  assert.equal(dotenvValue(text, 'F'), 'last wins');
  assert.equal(dotenvValue(text, 'G'), null, 'empty is no key');
  assert.equal(dotenvValue(text, 'H'), 'a#b', 'a # inside a word is part of the value');
  assert.equal(dotenvValue(text, 'GOOGLE_API_KEY'), null, 'a commented line is not an assignment');
  assert.equal(dotenvValue(text, 'MISSING'), null);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-dotenv-'));
  try {
    const f = path.join(d, '.env');
    fs.writeFileSync(f, `X=1\nTOKEN=secret-from-dotenv\n`);
    assert.equal(resolveSecret(`{dotenv:${f}#TOKEN}`), 'secret-from-dotenv');
    assert.equal(resolveSecret(`{dotenv:${f}#NOPE}`), null);
    assert.equal(resolveSecret(`{dotenv:${path.join(d, 'absent')}#TOKEN}`), null);
    for (const bad of [`{dotenv:${f}}`, `{dotenv:${f}#}`, `{dotenv:${f}#1BAD}`]) {
      assert.throws(() => resolveSecret(bad), (e) => /names one variable/.test(e.message) && !e.message.includes('secret-from-dotenv'));
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- the signature store */

test('the store re-attaches only to a call that lacks a signature, and only for the same function', () => {
  const s = new ThoughtSignatures();
  s.remember('call_1', 'S1', 'get_weather');
  const body = {
    model: 'm',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }, { id: 'call_2', type: 'function', function: { name: 'other', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' }, extra_content: { google: { thought_signature: 'MINE' }, other: 1 } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'not_the_same', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{}' },
    ],
  };
  const frozen = JSON.stringify(body);
  const { body: out, attached } = s.attach(body);
  assert.equal(attached, 1);
  assert.equal(JSON.stringify(body), frozen, 'the client body is not mutated');
  assert.equal(signatureOf(out.messages[1].tool_calls[0]), 'S1');
  assert.equal(signatureOf(out.messages[1].tool_calls[1]), null, 'a call it never saw gets nothing');
  assert.deepEqual(out.messages[2], body.messages[2], 'a signature the client sent is kept, with its siblings');
  assert.equal(signatureOf(out.messages[3].tool_calls[0]), null, 'same id, different function: an id collision, not this call');
  assert.equal(s.attach({ messages: [{ role: 'user', content: 'x' }] }).attached, 0);
});

test('the store is bounded by entries, bytes and age', () => {
  let t = 0;
  const s = new ThoughtSignatures({ maxEntries: 3, maxBytes: 1000, maxAgeMs: 100, now: () => t });
  for (const id of ['a', 'b', 'c', 'd']) s.remember(id, 'x'.repeat(10));
  assert.equal(s.size, 3);
  assert.equal(s.lookup('a'), null, 'the oldest goes first');
  s.remember('big', 'y'.repeat(990));
  assert.ok(s.bytes <= 1000 && s.lookup('big'), `bytes ${s.bytes}`);
  assert.equal(s.lookup('b'), null);
  t = 101;
  s.remember('e', 'z');
  assert.equal(s.size, 1, 'expired entries are dropped on the next write');
  assert.equal(s.lookup('big'), null);
  t = 202;
  assert.equal(s.lookup('e'), null, 'stale after maxAgeMs');
});

test('the observer reads signatures from a JSON answer and from SSE split anywhere, id before or after', () => {
  const s = new ThoughtSignatures();
  const j = s.observe('application/json');
  const json = JSON.stringify({ choices: [{ index: 0, message: { tool_calls: [{ id: 'j1', function: { name: 'f' }, extra_content: { google: { thought_signature: 'SJ' } } }, { id: 'j2', function: { name: 'g' } }] } }] });
  for (let i = 0; i < json.length; i += 7) j.push(new TextEncoder().encode(json.slice(i, i + 7)));
  j.end();
  assert.equal(s.lookup('j1', 'f'), 'SJ');
  assert.equal(s.lookup('j2'), null);

  const sse = s.observe('text/event-stream; charset=utf-8');
  const events = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'EARLY' } } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 's1', function: { name: 'f', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ id: 's2', function: { name: 'g', arguments: '{}' }, extra_content: { google: { thought_signature: 'NOINDEX' } } }] } }] },
  ];
  const wire = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  for (let i = 0; i < bytes.length; i += 5) sse.push(bytes.slice(i, i + 5));
  sse.end();
  assert.equal(s.lookup('s1', 'f'), 'EARLY', 'a signature that came before its id is kept for it');
  assert.equal(s.lookup('s2', 'g'), 'NOINDEX');
});
