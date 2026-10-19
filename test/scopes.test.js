/**
 * Keys with a scope: what each gateway key may reach. One gateway in front of three stub
 * upstreams — `claude-api` (the Anthropic wire, standing in for a credit someone spends on
 * purpose), `google` (the OpenAI wire) and `agy` (a CLI) — and five keys: one unscoped, as
 * every key was before scopes; one denied claude-api; one allowed agy and the argon alias only;
 * one allowed a model glob; one whose scope cannot be read. Every request is counted at the
 * stub it reached, so "refused" means the upstream never heard of it. Nothing spends a token.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { fingerprint, redactKey } from '../src/redact.js';
import { adapterReach, aliasDecision, globCanStartWith, keyStrings, parseKeys, parsePattern, targetDecision } from '../src/keys.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mint = () => 'ks_' + crypto.randomBytes(24).toString('base64url');
const MAIN = mint(); // unscoped: a bare string, the form every key had before scopes
const ADA = mint(); // { deny: ['claude-api'] }
const NARROW = mint(); // { allow: ['agy', 'alias:argon'] }
const GLOB = mint(); // { allow: ['google/gemini-3.8-*'] }
const BROKEN = mint(); // { alow: [...] } — a typo, which must not read as "no allow-list"
const HAND = mint(); // { deny: ['Claude-API'] } — written by hand: names no adapter, keeps nothing out
const MDENY = mint(); // { allow: ['google/*'], deny: ['google/gemini-4-*'] } — model-level globs
const ALL_KEYS = [MAIN, ADA, NARROW, GLOB, BROKEN, HAND, MDENY];
const CLAUDE_KEY = 'sk-ant-test-' + crypto.randomBytes(12).toString('hex');

function assertNoKey(text, key, where) {
  assert.ok(!text.includes(key), `${where}: the full key was printed`);
  for (let i = 3; i + 8 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 8)), `${where}: 8 characters of a key were printed`);
}
const assertNoKeys = (text, where) => ALL_KEYS.forEach((k) => assertNoKey(text, k, where));

/* ------------------------------------------------------------------- stub upstreams */

const hits = { claude: [], google: [] };

function upstream(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/claude/')) {
      hits.claude.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `claude answer (${body.model})` } });
      ev('message_delta', { type: 'message_delta', usage: { output_tokens: 3 } });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }
    hits.google.push({ url: req.url, body });
    if (req.url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: body.model }));
    }
    const text = `google answer (${body.model})`;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

const AGY = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'event', event: { type: 'text_delta', delta: 'agy answer (' + model + ')' } });
line({ type: 'result', sessionId: 's1', subtype: 'success', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
`;

/* ----------------------------------------------------------------------- gateway */

let dir, up, server, base, usageFile;
const log = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-scopes-'));
  const agyBin = path.join(dir, 'agy-stub');
  fs.writeFileSync(agyBin, AGY, { mode: 0o755 });
  up = http.createServer(upstream);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${up.address().port}`;
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        MAIN,
        { key: ADA, label: 'ada', deny: ['claude-api'] },
        { key: NARROW, label: 'narrow', allow: ['agy', 'alias:argon'] },
        { key: GLOB, label: 'glob', allow: ['google/gemini-3.8-*'] },
        { key: BROKEN, label: 'broken', alow: ['agy'] },
        { key: HAND, label: 'hand', deny: ['Claude-API'] },
        { key: MDENY, label: 'mdeny', allow: ['google/*'], deny: ['google/gemini-4-*'] },
      ],
    },
    limits: { streamHoldMs: 250 },
    adapters: {
      agy: { kind: 'cli', bin: agyBin, args: ['-p', ['--model', '{model}'], '{prompt}'], parser: 'cmd-ndjson', models: ['gemini-4-argon-high', 'gemini-3.8-flash-low'], timeoutMs: 15_000 },
      // `stripModelPrefix` as the google profile has it: Google answers `models/<id>` as `<id>`.
      google: { kind: 'http', wire: 'openai', baseUrl: `${root}/google/v1`, apiKey: false, models: ['gemini-3.8-flash', 'gemini-4-argon', 'text-embedding-4', 'cheap'], modelMap: { cheap: 'gemini-4-argon' }, stripModelPrefix: 'models/' },
      'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: `${root}/claude/v1`, apiKey: CLAUDE_KEY, models: ['claude-x'], defaultModel: 'claude-x' },
    },
    aliases: {
      // The google leg first: for a key that may not use it, the answer comes from agy only
      // because that leg was skipped, not because agy happened to be tried first.
      argon: ['google/gemini-4-argon', 'agy/gemini-4-argon-high'],
      smart: ['claude-api/claude-x', 'google/gemini-3.8-flash'],
      'claude-only': ['claude-api/claude-x'],
    },
  };
  usageFile = path.join(dir, 'usage.jsonl');
  const usage = new UsageLog(usageFile);
  server = createServer(new Gateway(cfg, { log: (m) => log.push(m) }), cfg, { usage, log: (m) => log.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => up.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const bodies = []; // every response body, searched for keys at the end

async function call(key, route, body = null, { method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const res = await fetch(base + route, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
}
const chat = (key, model, extra = {}) => call(key, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const content = (r) => r.json().choices[0].message.content;
const streamed = (r) => r.text.split('\n\n').filter((f) => f.startsWith('data: {')).map((f) => JSON.parse(f.slice(6))).flatMap((c) => c.choices?.map((ch) => ch.delta?.content || '') ?? []).join('');
const ids = async (key) => (await call(key, '/v1/models')).json().data.map((m) => m.id);
const usageRows = () => fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** The request was refused with a 403 that names the adapter, and nothing about the key. */
function assertRefused(r, adapter, where) {
  assert.equal(r.status, 403, `${where}: ${r.text}`);
  const message = r.json().error.message;
  assert.match(message, new RegExp(`"?${adapter}"?`), `${where}: the reason names the adapter`);
  assertNoKeys(r.text, where);
  for (const k of ALL_KEYS) assert.ok(!r.text.includes(fingerprint(k)), `${where}: the refusal does not name the key, not even by fingerprint`);
}

/* ---------------------------------------------------------- an unscoped key: unchanged */

test('a key with no scope reaches everything it reached before: claude-api directly, through an alias, on every face', async () => {
  const before = hits.claude.length;
  assert.equal(content(await chat(MAIN, 'claude-api/claude-x')), 'claude answer (claude-x)');
  assert.equal(content(await chat(MAIN, 'claude-api')), 'claude answer (claude-x)', 'a bare adapter id runs its default model');
  assert.equal(content(await chat(MAIN, 'smart')), 'claude answer (claude-x)', 'the claude-api leg comes first and answers');
  assert.equal((await call(MAIN, '/v1/messages', { model: 'claude-api/claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })).json().content[0].text, 'claude answer (claude-x)');
  assert.equal((await call(MAIN, '/v1/responses', { model: 'claude-api/claude-x', input: 'hi' })).json().output_text, 'claude answer (claude-x)');
  assert.equal(hits.claude.length, before + 5);
  assert.equal(hits.claude.at(-1).body.model, 'claude-x');

  const all = await ids(MAIN);
  for (const id of ['claude-api/claude-x', 'google/gemini-3.8-flash', 'agy/gemini-4-argon-high', 'argon', 'smart', 'claude-only']) assert.ok(all.includes(id), `${id} in ${all}`);
  const routes = (await call(MAIN, '/v1/keysmith/routes')).json();
  assert.deepEqual(routes.adapters.map((a) => a.id).sort(), ['agy', 'claude-api', 'google']);
  assert.deepEqual(routes.aliases.smart, ['claude-api/claude-x', 'google/gemini-3.8-flash'], 'aliases verbatim, as before');
});

test('no key, or a key nobody configured, is still a 401', async () => {
  assert.equal((await chat(mint(), 'agy/gemini-3.8-flash-low')).status, 401);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
});

/* -------------------------------------------------------------- deny: claude-api */

test('a key denied claude-api is refused it directly — 403 naming the adapter, on every face, and the upstream never hears of it', async () => {
  const before = hits.claude.length;
  assertRefused(await chat(ADA, 'claude-api/claude-x'), 'claude-api', 'chat');
  assertRefused(await chat(ADA, 'claude-api/claude-x', { stream: true }), 'claude-api', 'chat, streamed');
  assertRefused(await chat(ADA, 'claude-api'), 'claude-api', 'bare adapter id');
  assertRefused(await chat(ADA, 'claude-api/some-other-model'), 'claude-api', 'a model the adapter does not list');
  assertRefused(await call(ADA, '/v1/messages', { model: 'claude-api/claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), 'claude-api', '/v1/messages');
  assertRefused(await call(ADA, '/v1/messages', { model: 'claude-api/claude-x', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), 'claude-api', '/v1/messages, streamed');
  assertRefused(await call(ADA, '/v1/responses', { model: 'claude-api/claude-x', input: 'hi' }), 'claude-api', '/v1/responses');
  assertRefused(await call(ADA, '/v1/responses', { model: 'claude-api/claude-x', stream: true, input: 'hi' }), 'claude-api', '/v1/responses, streamed');
  assertRefused(await call(ADA, '/v1/embeddings', { model: 'claude-api/claude-x', input: 'hi' }), 'claude-api', '/v1/embeddings');
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  assertRefused(await chat(ADA, 'claude-api/claude-x', { tools }), 'claude-api', 'chat with tools');
  assert.equal(hits.claude.length, before, 'claude-api was never called');
  // The rest still answers.
  assert.equal(content(await chat(ADA, 'google/gemini-3.8-flash')), 'google answer (gemini-3.8-flash)');
  assert.equal(content(await chat(ADA, 'agy/gemini-3.8-flash-low')), 'agy answer (gemini-3.8-flash-low)');
});

test('a key denied claude-api goes through an alias without its claude-api leg, and an alias with no other leg is a 403', async () => {
  const before = hits.claude.length;
  const smart = await chat(ADA, 'smart');
  assert.equal(smart.status, 200, smart.text);
  assert.equal(content(smart), 'google answer (gemini-3.8-flash)', 'the claude-api leg was skipped, not tried and failed over');
  assert.equal(smart.headers.get('x-keysmith-route'), 'google/gemini-3.8-flash');
  assert.equal(streamed(await chat(ADA, 'smart', { stream: true })), 'google answer (gemini-3.8-flash)');
  assert.equal((await call(ADA, '/v1/messages', { model: 'smart', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })).json().content[0].text, 'google answer (gemini-3.8-flash)');
  // With tools the relay takes the first leg that can carry them — never the denied one.
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const relayed = await chat(ADA, 'smart', { tools });
  assert.equal(relayed.status, 200, relayed.text);
  assert.equal(relayed.headers.get('x-keysmith-mode'), 'passthrough');
  assert.equal(content(relayed), 'google answer (gemini-3.8-flash)');
  assertRefused(await chat(ADA, 'claude-only'), 'claude-api', 'an alias whose only leg is denied');
  assert.equal(hits.claude.length, before, 'claude-api was never called');
  assert.ok(log.some((l) => /alias "smart" skipped claude-api\/claude-x: outside the requesting key's scope/.test(l)), log.join('\n'));
});

/* ------------------------------------------------------- allow: agy and alias:argon */

test('an allow-list lets agy and the argon alias through, with argon\'s google leg skipped, and nothing else', async () => {
  const before = { claude: hits.claude.length, google: hits.google.length };
  assert.equal(content(await chat(NARROW, 'agy/gemini-3.8-flash-low')), 'agy answer (gemini-3.8-flash-low)');
  assert.equal(content(await chat(NARROW, 'agy')), 'agy answer ()', 'every model of the adapter, its default included');
  const argon = await chat(NARROW, 'argon');
  assert.equal(argon.status, 200, argon.text);
  assert.equal(content(argon), 'agy answer (gemini-4-argon-high)');
  assert.equal(argon.headers.get('x-keysmith-route'), 'agy/gemini-4-argon-high', 'the google leg is not part of this key\'s route');
  assert.equal(hits.google.length, before.google, 'argon\'s first leg, google, was skipped — never called');

  assertRefused(await chat(NARROW, 'google/gemini-4-argon'), 'google', 'a leg of an allowed alias is not allowed by itself');
  assertRefused(await chat(NARROW, 'claude-api/claude-x'), 'claude-api', 'claude-api');
  assertRefused(await call(NARROW, '/v1/embeddings', { model: 'google/text-embedding-4', input: 'hi' }), 'google', 'embeddings');
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  assertRefused(await chat(NARROW, 'google/gemini-3.8-flash', { tools }), 'google', 'the tool relay');
  const smart = await chat(NARROW, 'smart');
  assert.equal(smart.status, 403, smart.text);
  assert.match(smart.json().error.message, /alias "smart"/);
  assert.equal(hits.claude.length, before.claude);
  assert.equal(hits.google.length, before.google);

  // The unscoped key on the same alias: google answers first, as configured.
  assert.equal(content(await chat(MAIN, 'argon')), 'google answer (gemini-4-argon)');
});

test('a model glob allows those models only, and a modelMap name never carries a request past it', async () => {
  assert.equal(content(await chat(GLOB, 'google/gemini-3.8-flash')), 'google answer (gemini-3.8-flash)');
  assertRefused(await chat(GLOB, 'google/gemini-4-argon'), 'google', 'a google model outside the glob');
  // `cheap` is mapped to gemini-4-argon upstream: the glob has to hold for what is sent.
  assertRefused(await chat(GLOB, 'google/cheap'), 'google', 'a mapped name');
  assertRefused(await chat(GLOB, 'agy/gemini-3.8-flash-low'), 'agy', 'another adapter');
  assert.deepEqual(await ids(GLOB), ['google/gemini-3.8-flash']);
});

test('a scope the config spells wrong reaches nothing: the key authenticates, and every request is a 403 that says why', async () => {
  const r = await chat(BROKEN, 'agy/gemini-3.8-flash-low');
  assert.equal(r.status, 403, r.text);
  assert.match(r.json().error.message, /scope of this key is invalid in the config \(unknown field "alow"/);
  assert.deepEqual(await ids(BROKEN), []);
  assert.ok(log.some((l) => l.includes(`key fp:${fingerprint(BROKEN)} (broken): unknown field "alow"`)), log.join('\n'));
});

/* -------------------------------------------------------------- listings, every route */

test('/v1/models lists only what the key may reach, and an alias with only the legs it may run', async () => {
  const ada = (await call(ADA, '/v1/models')).json();
  const adaIds = ada.data.map((m) => m.id);
  assert.ok(!adaIds.some((id) => id.startsWith('claude-api/')), adaIds.join(','));
  assert.ok(!adaIds.includes('claude-only'), 'an alias with no leg left is not listed');
  assert.deepEqual(ada.data.find((m) => m.id === 'smart').keysmith.routes, ['google/gemini-3.8-flash']);
  assert.ok(adaIds.includes('google/gemini-4-argon') && adaIds.includes('agy/gemini-4-argon-high') && adaIds.includes('argon'));

  // A key sent as ?api_key= (for clients that cannot set a header) carries its scope too.
  const byQuery = await (await fetch(`${base}/v1/models?api_key=${encodeURIComponent(ADA)}`)).json();
  assert.ok(byQuery.data.length && !byQuery.data.some((m) => m.id.startsWith('claude-api/')));
  const embedded = await call(MAIN, '/v1/embeddings', { model: 'google/text-embedding-4', input: 'hi' });
  assert.equal(embedded.status, 200, 'an unscoped key still gets its embeddings');

  const narrow = await ids(NARROW);
  assert.deepEqual(narrow, ['agy/gemini-3.8-flash-low', 'agy/gemini-4-argon-high', 'argon']);
  const argon = (await call(NARROW, '/v1/models')).json().data.find((m) => m.id === 'argon');
  assert.deepEqual(argon.keysmith.routes, ['agy/gemini-4-argon-high']);
});

test('the routes and usage endpoints show a scoped key only its share: no claude-api adapter, alias leg or usage row', async () => {
  const routes = (await call(ADA, '/v1/keysmith/routes')).json();
  assert.deepEqual(routes.adapters.map((a) => a.id).sort(), ['agy', 'google']);
  assert.deepEqual(routes.aliases, { argon: ['google/gemini-4-argon', 'agy/gemini-4-argon-high'], smart: ['google/gemini-3.8-flash'] });
  assert.ok(!JSON.stringify(routes).includes('claude-api'), JSON.stringify(routes));

  const usage = (await call(ADA, '/v1/keysmith/usage?hours=1&tail=200')).json();
  assert.ok(usage.entries.length > 0);
  assert.ok(!usage.entries.some((e) => String(e.model).startsWith('claude-api') || e.model === 'claude-only'), JSON.stringify(usage.entries.map((e) => e.model)));
  assert.ok(!usage.summary.models.some((m) => m.model.startsWith('claude-api')));
  const mine = (await call(MAIN, '/v1/keysmith/usage?hours=1&tail=200')).json();
  assert.ok(mine.entries.some((e) => e.model === 'claude-api/claude-x'), 'the unscoped key still sees every row');
});

test('the status page: a scoped key sees its share, by header or by its login cookie; an unscoped one sees every key by fingerprint and scope', async () => {
  const adaPage = (await call(ADA, '/')).text;
  assert.equal((await call(ADA, '/')).status, 200);
  // The one line that names claude-api is the key's own scope, said to it at the top.
  const viewing = adaPage.match(/<div class="sub">viewing as key[^<]*<\/div>/)?.[0] || '';
  assert.match(viewing, new RegExp(`viewing as key fp:${fingerprint(ADA)} \\(ada\\) — its scope: deny: claude-api`));
  const rest = (html) => html.replace(/<div class="sub">viewing as key[^<]*<\/div>/, '');
  assert.ok(!rest(adaPage).includes('claude-api'), 'no claude-api adapter card, model, alias or usage row');
  assert.ok(!adaPage.includes('<h2>Keys</h2>'), 'a scoped key does not see the other keys');

  const login = await fetch(`${base}/status`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: ADA }).toString() });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const byCookie = await (await fetch(`${base}/status`, { headers: { cookie } })).text();
  bodies.push(byCookie);
  assert.ok(byCookie.includes(viewing) && !rest(byCookie).includes('claude-api'), 'the cookie opens the page as the key that logged in');

  const page = (await call(MAIN, '/')).text;
  assert.match(page, /<h2>Keys<\/h2>/);
  assert.ok(page.includes(`fp:${fingerprint(ADA)}`) && page.includes('deny: claude-api'), 'ada by fingerprint, with its scope');
  assert.ok(page.includes(`fp:${fingerprint(NARROW)}`) && page.includes('allow: agy, alias:argon'));
  assert.match(page, /unknown field &quot;alow&quot;/, 'the unreadable scope is named on the page');
  assertNoKeys(page, 'status page');
});

/* ------------------------------------------------- a scoped key's usage is its own */

test('a scoped key reads its own usage only: no other key\'s fingerprint or count, and not the unscoped key\'s claude-api spend through an alias it may name', async () => {
  // The unscoped key asks for `smart`, which claude-api answers; `smart` is an alias ada may name.
  assert.equal(content(await chat(MAIN, 'smart')), 'claude answer (claude-x)');
  assert.equal(content(await chat(ADA, 'smart')), 'google answer (gemini-3.8-flash)');
  const mine = `fp:${fingerprint(ADA)}`;
  const others = ALL_KEYS.filter((k) => k !== ADA);

  const r = await call(ADA, '/v1/keysmith/usage?tail=500');
  assert.equal(r.status, 200, r.text);
  const u = r.json();
  assert.ok(u.entries.length > 0, 'its own rows are there');
  assert.deepEqual([...new Set(u.entries.map((e) => e.key))], [mine], 'every row is its own');
  assert.ok(!u.entries.some((e) => e.model === 'smart' && e.scope === 'unscoped'), 'not the unscoped key\'s smart row');
  assert.ok(!u.entries.some((e) => /^claude-api/.test(e.model) || e.model === 'claude-only'), 'nor its own refusals for what it may not name');
  assert.deepEqual(u.summary.keys.map((k) => k.key), [mine], 'the summary counts its own key and no other');
  const own = usageRows().filter((e) => e.key === mine && e.model === 'smart').length;
  assert.equal(u.summary.models.find((m) => m.model === 'smart').requests, own, 'smart counts its own requests only');
  for (const k of others) assert.ok(!r.text.includes(fingerprint(k)), `no other fingerprint (${fingerprint(k)})`);

  // The status page, scoped, has the same view: its 24h numbers are its own.
  const page = (await call(ADA, '/')).text;
  const smartRow = page.match(/<tr><td>smart<\/td><td class="n">(\d+)<\/td>/);
  assert.equal(Number(smartRow?.[1]), own, smartRow?.[0]);
  for (const k of others) assert.ok(!page.includes(fingerprint(k)), `no other fingerprint on its page (${fingerprint(k)})`);

  // The unscoped key reads every row, as it always did.
  const all = (await call(MAIN, '/v1/keysmith/usage?tail=500')).json();
  assert.ok(all.entries.some((e) => e.key === `fp:${fingerprint(MAIN)}` && e.model === 'smart'));
  assert.ok(all.summary.keys.length > 2);
});

/* ------------------------------------------- a pattern that names nothing, by hand */

test('a hand-written pattern that names nothing (deny Claude-API) still keeps nothing out — and the gateway log and the status page say so, with a hint', async () => {
  const before = hits.claude.length;
  const r = await chat(HAND, 'claude-api/claude-x');
  assert.equal(r.status, 200, 'not failed closed: the pattern may name an adapter added later');
  assert.equal(hits.claude.length, before + 1);
  const said = log.find((l) => l.includes(`key fp:${fingerprint(HAND)} (hand): deny "Claude-API" names no configured adapter`));
  assert.ok(said, log.join('\n'));
  assert.match(said, /did you mean claude-api\? \(a pattern is matched as written: Claude-API ≠ claude-api\)/);
  assert.match(said, /keeps nothing out/);
  const page = (await call(MAIN, '/')).text;
  assert.match(page, /<span class="bad">! deny &quot;Claude-API&quot; names no configured adapter — did you mean claude-api\?/);
  assert.ok(!(await call(ADA, '/')).text.includes('Claude-API'), 'a scoped viewer sees no other key, flagged or not');
  assert.ok(!log.some((l) => l.includes(`fp:${fingerprint(ADA)}`) && /names no configured/.test(l)), 'a pattern that names an adapter is not flagged');
});

/* ---------------------------------------- model-level globs: what goes upstream */

test('a model-level glob cannot be passed with an inherited name: google/constructor goes upstream as "constructor", never with no model', async () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const before = hits.google.length;
    const r = await chat(MDENY, `google/${name}`);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.equal(hits.google.length, before + 1);
    const sent = hits.google.at(-1).body;
    assert.ok(Object.hasOwn(sent, 'model'), `${name}: the upstream got a body with no model in it, and picked one itself`);
    assert.equal(sent.model, name);
  }
  // The tool relay sends the model the same way.
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const relayed = await chat(MDENY, 'google/constructor', { tools });
  assert.equal(relayed.headers.get('x-keysmith-mode'), 'passthrough');
  assert.equal(hits.google.at(-1).body.model, 'constructor');
  // What the globs name is refused, as it was.
  assertRefused(await chat(MDENY, 'google/gemini-4-argon'), 'google', 'a denied model');
  assertRefused(await chat(MDENY, 'google/cheap'), 'google', 'a name mapped to a denied model');
});

test('a key whose scope covers only part of an adapter names the model: with none, the upstream would pick — refused, on every face', async () => {
  const before = hits.google.length;
  assertRefused(await chat(MDENY, 'google'), 'google', 'a bare adapter id with no defaultModel');
  assertRefused(await chat(MDENY, 'google/'), 'google', 'an empty model part');
  assertRefused(await call(MDENY, '/v1/embeddings', { model: 'google', input: 'hi' }), 'google', 'embeddings with no model part');
  assert.equal(hits.google.length, before, 'the upstream never heard of them');
  assert.match((await chat(MDENY, 'google')).json().error.message, /names one \(google\/<model>\)/);
  // A key that reaches all of the adapter, or none of its scope touches it, is as before.
  assert.equal((await chat(MAIN, 'google')).status, 200, 'unscoped');
  assert.equal((await chat(ADA, 'google')).status, 200, 'a scope that does not touch google');
  assert.equal(content(await chat(NARROW, 'agy')), 'agy answer ()', 'an allow-list that covers all of agy');
});

test('a model deny holds for the other spelling the upstream answers to: google/models/gemini-4-argon is gemini-4-argon', async () => {
  const before = hits.google.length;
  assertRefused(await chat(MDENY, 'google/models/gemini-4-argon'), 'google', 'models/ prefix');
  assertRefused(await chat(MDENY, 'google/models/models/gemini-4-argon'), 'google', 'models/ twice');
  assertRefused(await chat(MDENY, 'google/models/gemini-4-argon', { stream: true }), 'google', 'streamed');
  assertRefused(await call(MDENY, '/v1/embeddings', { model: 'google/models/gemini-4-argon', input: 'hi' }), 'google', 'embeddings');
  assert.equal(hits.google.length, before, 'the upstream never heard of them');
  // The allowed model is still allowed under either spelling; the unscoped key is untouched.
  assert.equal(content(await chat(MDENY, 'google/models/gemini-3.8-flash')), 'google answer (models/gemini-3.8-flash)');
  assert.equal(content(await chat(MAIN, 'google/models/gemini-4-argon')), 'google answer (models/gemini-4-argon)');

  // As units: a deny written with the prefix holds for the bare id, and the bare one for the prefixed.
  const { requestDecision } = await import('../src/keys.js');
  const google = { stripModelPrefix: 'models/' };
  const scope = (deny) => parseKeys([{ key: 'k'.repeat(20), deny }]).entries[0].scope;
  assert.equal(requestDecision(scope(['google/models/gemini-4-*']), 'google', google, 'gemini-4-argon').ok, false);
  assert.equal(requestDecision(scope(['google/gemini-4-*']), 'google', google, 'models/gemini-4-argon').ok, false);
  assert.equal(requestDecision(scope(['google/gemini-4-*']), 'google', google, 'gemini-3.8-flash').ok, true);
  assert.equal(requestDecision(scope(['google/gemini-4-*']), 'google', {}, 'models/gemini-4-argon').ok, true, 'no stripModelPrefix: no other spelling known');
});

test('HttpAdapter looks up modelMap and modelParams by own entries only', async () => {
  const { HttpAdapter } = await import('../src/http-adapter.js');
  const a = new HttpAdapter('g', { baseUrl: 'http://127.0.0.1:9/v1', modelMap: { cheap: 'gemini-4-argon' }, modelParams: { '*': { seed: 1 }, 'gemini-4-argon': { reasoning_effort: 'high' } } });
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(a.upstreamModel(name), name);
    assert.deepEqual(a.paramsFor(name), { seed: 1 });
  }
  assert.equal(a.upstreamModel('cheap'), 'gemini-4-argon');
  assert.deepEqual(a.paramsFor('gemini-4-argon'), { seed: 1, reasoning_effort: 'high' });
});

/* ----------------------------------------------------------------------- usage lines */

test('usage lines carry the key\'s fingerprint and its scope\'s decision — allowed, denied, unscoped, skipped legs — and never a key', async () => {
  const rows = usageRows();
  const of = (k) => rows.filter((r) => r.key === `fp:${fingerprint(k)}`);
  assert.ok(of(MAIN).length && of(MAIN).every((r) => r.scope === 'unscoped'), JSON.stringify(of(MAIN)));
  const ada = of(ADA);
  assert.ok(ada.some((r) => r.status === 'denied' && r.scope === 'denied' && r.model === 'claude-api/claude-x' && /claude-api/.test(r.error)), JSON.stringify(ada));
  assert.ok(ada.some((r) => r.status === 'denied' && r.via === '/v1/messages'), 'the Anthropic face records its refusals too');
  assert.ok(ada.some((r) => r.model === 'smart' && r.status === 'ok' && r.scope === 'allowed' && r.skipped?.[0] === 'claude-api/claude-x'), JSON.stringify(ada.filter((r) => r.model === 'smart')));
  assert.ok(of(NARROW).some((r) => r.model === 'argon' && r.scope === 'allowed' && r.skipped?.[0] === 'google/gemini-4-argon'));
  assert.ok(of(NARROW).some((r) => r.via === '/v1/embeddings' && r.status === 'denied'), 'embeddings refusals are recorded');
  const text = fs.readFileSync(usageFile, 'utf8');
  assertNoKeys(text, 'usage.jsonl');
  assertNoKey(text, CLAUDE_KEY, 'usage.jsonl');
  // What the gateway logged and answered, all of it.
  assertNoKeys(log.join('\n'), 'gateway log');
  assertNoKeys(bodies.join('\n'), 'response bodies');
});

/* ---------------------------------------------------------------- the rules, as units */

test('patterns: an adapter id, an adapter/model glob, alias:<name>; anything else is refused', () => {
  assert.deepEqual(parsePattern('claude-api'), { text: 'claude-api', kind: 'adapter', id: 'claude-api' });
  assert.equal(parsePattern('agy/*').kind, 'glob');
  assert.equal(parsePattern('alias:argon').kind, 'alias');
  for (const bad of ['', ' agy', 'alias:', 3, null]) assert.throws(() => parsePattern(bad));
  assert.ok(globCanStartWith('agy/*', 'agy/') && globCanStartWith('*', 'x/') && globCanStartWith('google/gemini-3.8-*', 'google/'));
  assert.ok(!globCanStartWith('agy/*', 'agyx/') && !globCanStartWith('google/x', 'goo/'));
});

test('deny wins over allow, a glob holds for the mapped name too, and reach is all, some or none', () => {
  const { entries } = parseKeys([{ key: 'k'.repeat(20), allow: ['agy', 'google/*'], deny: ['google/gemini-4-*', 'alias:secret'] }]);
  const s = entries[0].scope;
  assert.equal(targetDecision(s, 'google', ['gemini-3.8-flash']).ok, true);
  assert.equal(targetDecision(s, 'google', ['gemini-4-argon']).ok, false);
  assert.equal(targetDecision(s, 'google', ['cheap', 'gemini-4-argon']).ok, false, 'denied by the name sent upstream');
  assert.equal(targetDecision(s, 'claude-api', ['claude-x']).ok, false);
  assert.equal(aliasDecision(s, 'secret').ok, false);
  assert.equal(aliasDecision(s, 'argon').ok, false, 'an allow-list names the aliases it allows');
  assert.equal(adapterReach(s, 'agy'), 'all');
  assert.equal(adapterReach(s, 'google'), 'some');
  assert.equal(adapterReach(s, 'claude-api'), 'none');
  assert.equal(adapterReach(null, 'claude-api'), 'all', 'unscoped');
  assert.equal(adapterReach(parseKeys([{ key: 'k'.repeat(20), deny: ['claude-api/*'] }]).entries[0].scope, 'claude-api'), 'none', 'a glob that covers the adapter');
});

test('the config fails closed: an unknown field, a list that is not one, the same key twice with two scopes', () => {
  const k = 'ks_' + 'a'.repeat(32);
  const cases = [{ key: k, alow: ['agy'] }, { key: k, deny: 'claude-api' }, { key: k, allow: [42] }, { key: k, label: 7 }];
  for (const entry of cases) {
    const { entries, issues } = parseKeys([entry]);
    assert.equal(entries.length, 1, 'the key still authenticates — its client hears why');
    assert.ok(entries[0].scope?.invalid, JSON.stringify(entry));
    assert.equal(targetDecision(entries[0].scope, 'agy', ['m']).ok, false);
    assert.equal(issues.length, 1);
    assert.ok(!issues[0].includes(k), 'an issue names the key by fingerprint');
  }
  const dup = parseKeys([k, { key: k, deny: ['claude-api'] }]);
  assert.ok(dup.entries.every((e) => e.scope?.invalid), 'two scopes for one key: neither wins');
  assert.equal(parseKeys([k, k]).issues.length, 0, 'the same bare key twice is just a duplicate');
  assert.equal(parseKeys([{ key: k, label: 'x' }]).entries[0].scope, null, 'a label alone is no scope');
  assert.deepEqual(keyStrings([k, { key: 'b'.repeat(20) }, { nokey: 1 }, 5]), [k, 'b'.repeat(20)]);
  assert.match(parseKeys([{ nokey: 1 }]).issues[0], /holds no key/);
});

test('a gateway whose key list holds only broken entries opens nothing — it does not turn keyless', async (t) => {
  const cfg = { auth: { enabled: true, keys: [{ label: 'no key here' }] }, adapters: {}, aliases: {} };
  const s = createServer(new Gateway(cfg), cfg, {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => s.close(r)));
  const at = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await fetch(`${at}/v1/models`)).status, 401);
  assert.equal((await fetch(`${at}/`)).status, 401);
});

/* ------------------------------------------------------------------------------ CLI */

function sandbox(keys) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-scopes-cli-'));
  const config = path.join(home, '.config', 'keysmith', 'config.json');
  const data = path.join(home, '.local', 'share', 'keysmith');
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      port: 0,
      auth: { enabled: true, keys },
      adapters: { agy: { kind: 'cli', bin: 'agy', args: ['{prompt}'] }, google: { kind: 'http', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false }, 'claude-api': { kind: 'http', wire: 'anthropic', baseUrl: 'http://127.0.0.1:1/v1', apiKey: false } },
      aliases: { argon: ['agy/gemini-4-argon-high', 'google/gemini-4-argon'] },
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: data };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
  const outputs = [];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    outputs.push(r.stdout + r.stderr);
    return r;
  };
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const edit = (change) => {
    const cfg = read();
    change(cfg);
    fs.writeFileSync(config, JSON.stringify(cfg), { mode: 0o600 });
  };
  return { home, config, env, run, read, edit, outputs, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('keysmith key add <label> --deny claude-api --out <file>: the key goes to a new 0600 file and the config, and is printed nowhere', (t) => {
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);
  const file = path.join(sb.home, 'agents', 'ada.key');
  const r = sb.run('key', 'add', 'ada', '--deny', 'claude-api', '--out', file);
  assert.equal(r.status, 0, r.stderr);
  const keys = sb.read().auth.keys;
  assert.equal(keys.length, 2);
  assert.equal(keys[0], MAIN, 'the existing key is untouched');
  assert.deepEqual(Object.keys(keys[1]).sort(), ['deny', 'key', 'label']);
  assert.equal(keys[1].label, 'ada');
  assert.deepEqual(keys[1].deny, ['claude-api']);
  assert.equal(fs.readFileSync(file, 'utf8'), `${keys[1].key}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(r.stdout.includes(redactKey(keys[1].key)) && /deny: claude-api/.test(r.stdout) && /written to/.test(r.stdout), r.stdout);
  assertNoKey(r.stdout + r.stderr, keys[1].key, 'key add --out');

  // A file that is there is not overwritten, and then no key is added either.
  const again = sb.run('key', 'add', 'ada2', '--out', file);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /exists: not overwritten, and no key was added/);
  assert.equal(sb.read().auth.keys.length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), `${keys[1].key}\n`);

  // Repeated flags and comma lists add up; a plain `key add` still writes a bare key.
  assert.equal(sb.run('key', 'add', 'narrow', '--allow', 'agy', '--allow', 'alias:argon,agy').status, 0);
  assert.deepEqual(sb.read().auth.keys[2].allow, ['agy', 'alias:argon']);
  assert.equal(sb.run('key', 'add').status, 0);
  assert.equal(typeof sb.read().auth.keys[3], 'string');
  for (const k of keyStrings(sb.read().auth.keys)) assertNoKey(sb.outputs.join('\n'), k, 'every key command');
});

test('a pattern that names nothing is refused — a deny typo would keep nothing out — and no key is added', (t) => {
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);
  for (const args of [['--deny', 'claude_api'], ['--allow', 'argon'], ['--deny', 'nope/*'], ['--allow', 'alias:nope']]) {
    const r = sb.run('key', 'add', 'x', ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /not saved/);
  }
  assert.match(sb.run('key', 'add', 'x', '--allow', 'argon').stderr, /"argon" is an alias, not an adapter — alias:argon names it/);
  assert.deepEqual(sb.read().auth.keys, [MAIN]);
  assert.equal(sb.run('key', 'add', 'later', '--deny', 'not-yet', '--allow-unknown').status, 0, '--allow-unknown saves one anyway');
  assert.equal(sb.run('key', 'add', 'ks_lookalike').status, 1, 'a label that looks like a key is refused');
  assert.equal(sb.run('key', 'add', 'later').status, 1, 'a label names one key');
});

test('keysmith key scope fp:<hex> narrows an existing key, --clear makes it a bare key again, and list shows label, fingerprint and scope', (t) => {
  const sb = sandbox([MAIN, ADA]);
  t.after(sb.cleanup);
  const fp = fingerprint(ADA);
  const r = sb.run('key', 'scope', `fp:${fp}`, '--deny', 'claude-api', '--label', 'ada');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.read().auth.keys[1], { key: ADA, label: 'ada', deny: ['claude-api'] });
  assert.match(r.stdout, new RegExp(`fp:${fp} \\(ada\\): deny: claude-api`));

  const list = sb.run('key', 'list');
  const lines = list.stdout.trim().split('\n');
  assert.ok(lines[0].startsWith(redactKey(MAIN)) && /unscoped/.test(lines[0]), lines[0]);
  assert.ok(lines[1].startsWith(redactKey(ADA)) && /\bada\b/.test(lines[1]) && /deny: claude-api/.test(lines[1]), lines[1]);

  assert.equal(sb.run('key', 'scope', `fp:${fp}`, '--allow', 'agy,alias:argon').status, 0);
  assert.deepEqual(sb.read().auth.keys[1], { key: ADA, label: 'ada', deny: ['claude-api'], allow: ['agy', 'alias:argon'] });
  assert.equal(sb.run('key', 'scope', `fp:${fp}`, '--clear', '--no-label').status, 0);
  assert.equal(sb.read().auth.keys[1], ADA, 'nothing but the key left: a bare string again');
  assert.equal(sb.run('key', 'scope', ADA, '--deny', 'claude-api').status, 1, 'the key itself is never taken on the command line');
  assert.equal(sb.run('key', 'scope', 'fp:00000000', '--deny', 'claude-api').status, 1);
  assertNoKey(sb.outputs.join('\n'), MAIN, 'key scope/list');
  assertNoKey(sb.outputs.join('\n'), ADA, 'key scope/list');
});

test('keysmith key who-can claude-api lists the fingerprints that reach it, and the ones kept out', (t) => {
  const sb = sandbox([MAIN, { key: ADA, label: 'ada', deny: ['claude-api'] }, { key: NARROW, label: 'narrow', allow: ['agy', 'alias:argon'] }, { key: GLOB, label: 'part', allow: ['claude-api/claude-haiku-*'] }]);
  t.after(sb.cleanup);
  const r = sb.run('key', 'who-can', 'claude-api');
  assert.equal(r.status, 0, r.stderr);
  const [reach, out] = r.stdout.split('not reachable by:');
  assert.match(reach, /claude-api: reachable by 2 of 4 key\(s\)/);
  assert.ok(reach.includes(`fp:${fingerprint(MAIN)}`) && reach.includes(`fp:${fingerprint(GLOB)}`), reach);
  assert.match(reach, /part of it/);
  assert.ok(out.includes(`fp:${fingerprint(ADA)}`) && out.includes(`fp:${fingerprint(NARROW)}`), out);

  const alias = sb.run('key', 'who-can', 'alias:argon').stdout;
  assert.match(alias, /alias:argon: reachable by 3 of 4 key\(s\)/, alias);
  assert.match(alias, /legs agy\/gemini-4-argon-high only/, 'narrow runs the agy leg alone');
  assert.match(sb.run('key', 'who-can', 'claude-api/claude-haiku-5').stdout, /reachable by 2 of 4/, 'the unscoped key and the one allowed claude-haiku-*');
  assert.match(sb.run('key', 'who-can', 'claude-api/claude-opus-5').stdout, /reachable by 1 of 4/);
  for (const k of [MAIN, ADA, NARROW, GLOB]) assertNoKey(sb.outputs.join('\n'), k, 'who-can');
});

test('key list and who-can only read: with no key configured they mint none', (t) => {
  const sb = sandbox([]);
  t.after(sb.cleanup);
  assert.equal(sb.run('key', 'list').stdout.trim(), '(none)');
  assert.match(sb.run('key', 'who-can', 'claude-api').stdout, /no key is configured/);
  assert.deepEqual(sb.read().auth.keys, []);
});

/* ------------------------------------------- CLI: hand-written patterns, flags, auth off */

test('a hand-written pattern that names nothing is warned about by key list, doctor and serve, with a near-match hint — and still not refused', async (t) => {
  const sb = sandbox([MAIN, { key: HAND, label: 'hand', deny: ['Claude-API'] }, { key: ADA, label: 'ada', deny: ['claude-api'] }, { key: GLOB, label: 'glob', allow: ['Google/gemini-*', 'alias:Argon'] }]);
  t.after(sb.cleanup);
  // No CLI on PATH is run by doctor here, and the HTTP adapters point at a closed port.
  sb.edit((cfg) => (cfg.adapters.agy.bin = path.join(sb.home, 'no-such-agy')));
  const hand = new RegExp(`key fp:${fingerprint(HAND)} \\(hand\\): deny "Claude-API" names no configured adapter — did you mean claude-api\\? \\(a pattern is matched as written: Claude-API ≠ claude-api\\) — a deny pattern that names nothing keeps nothing out`);

  const list = sb.run('key', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stderr, hand);
  assert.match(list.stderr, /allow "Google\/gemini-\*" matches no configured adapter — did you mean google\?/);
  assert.match(list.stderr, /allow "alias:Argon" matches no configured alias — did you mean alias:argon\?/);
  assert.ok(!new RegExp(`fp:${fingerprint(ADA)}`).test(list.stderr), 'a pattern that names an adapter is not flagged');

  const doctor = sb.run('doctor');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, hand);

  // serve says it at start, where the owner looks; it is a warning, the gateway still starts.
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let said = '';
  child.stdout.on('data', (c) => (said += c));
  child.stderr.on('data', (c) => (said += c));
  const deadline = Date.now() + 15_000;
  while (!(/listening on/.test(said) && hand.test(said)) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
  child.kill('SIGTERM');
  assert.match(said, /listening on/);
  assert.match(said, hand);
  sb.outputs.push(said);

  // who-can tells the truth about it, as it did.
  const who = sb.run('key', 'who-can', 'claude-api').stdout.split('not reachable by:')[0];
  assert.ok(who.includes(`fp:${fingerprint(HAND)}`), who);
  for (const k of [MAIN, HAND, ADA, GLOB]) assertNoKey(sb.outputs.join('\n'), k, 'warnings');
});

test('--force replaces an --out file and nothing else: a deny typo is still refused, --allow-unknown is what saves one', (t) => {
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);
  const file = path.join(sb.home, 'ada.key');
  fs.writeFileSync(file, 'old\n', { mode: 0o600 });

  const typo = sb.run('key', 'add', 'ada2', '--deny', 'claude_api', '--out', file, '--force');
  assert.equal(typo.status, 1, typo.stdout);
  assert.match(typo.stderr, /not saved: --deny "claude_api" names no configured adapter — did you mean claude-api\?/);
  assert.match(typo.stderr, /--allow-unknown saves it anyway \(--force only replaces the --out file\)/);
  assert.deepEqual(sb.read().auth.keys, [MAIN], 'no key added');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'the file is left alone');
  assert.match(sb.run('key', 'who-can', 'claude-api').stdout, /reachable by 1 of 1/);

  const rotated = sb.run('key', 'add', 'ada2', '--deny', 'claude-api', '--out', file, '--force');
  assert.equal(rotated.status, 0, rotated.stderr);
  const added = sb.read().auth.keys[1];
  assert.deepEqual(added.deny, ['claude-api']);
  assert.equal(fs.readFileSync(file, 'utf8'), `${added.key}\n`, '--force replaced the file');

  const scoped = sb.run('key', 'scope', `fp:${fingerprint(added.key)}`, '--deny', 'Claude-API', '--force');
  assert.equal(scoped.status, 1, 'key scope: --force does not save a pattern that names nothing');
  assert.deepEqual(sb.read().auth.keys[1].deny, ['claude-api']);

  const later = sb.run('key', 'add', 'later', '--deny', 'not-yet', '--allow-unknown');
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stderr, /! --deny "not-yet" names no configured adapter — saved anyway \(--allow-unknown\)/);
  for (const k of keyStrings(sb.read().auth.keys)) assertNoKey(sb.outputs.join('\n'), k, 'key add');
});

test('with auth disabled, key add and key scope save the scope and say it does not apply', (t) => {
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);
  sb.edit((cfg) => (cfg.auth.enabled = false));
  const file = path.join(sb.home, 'ada.key');
  const add = sb.run('key', 'add', 'ada', '--deny', 'claude-api', '--out', file);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stderr, /auth is disabled \(auth\.enabled is false\): no key is asked for, so no scope applies/);
  const fp = fingerprint(sb.read().auth.keys[1].key);
  const scope = sb.run('key', 'scope', `fp:${fp}`, '--allow', 'agy');
  assert.equal(scope.status, 0, scope.stderr);
  assert.match(scope.stderr, /auth is disabled/);
  sb.edit((cfg) => (cfg.auth.enabled = true));
  const on = sb.run('key', 'add', 'scout', '--allow', 'agy');
  assert.ok(!/auth is disabled/.test(on.stderr), 'nothing said with auth on');
  for (const k of keyStrings(sb.read().auth.keys)) assertNoKey(sb.outputs.join('\n'), k, 'auth off');
});

const scriptArgv = (argv) =>
  process.platform === 'darwin' ? ['-q', '/dev/null', ...argv] : ['-qec', argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'];
const hasScript = spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', 'true'] : ['-qec', 'true', '/dev/null'], { stdio: 'ignore' }).status === 0;

test('key list --reveal, in a terminal, keeps the fingerprint next to each full key', { skip: !hasScript && 'no script(1) to give the child a terminal' }, (t) => {
  const sb = sandbox([MAIN, { key: ADA, label: 'ada', deny: ['claude-api'] }]);
  t.after(sb.cleanup);
  const r = spawnSync('script', scriptArgv([process.execPath, CLI, 'key', 'list', '--reveal']), { env: sb.env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  // script(1) can put a ^D (its stdin's end) in front of the first line.
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.includes('ks_')).map((l) => l.slice(l.indexOf('ks_')));
  assert.equal(lines.length, 2, r.stdout);
  assert.ok(lines[0].startsWith(`${MAIN} fp:${fingerprint(MAIN)} `), 'the unscoped key, then its fingerprint');
  assert.ok(lines[1].startsWith(`${ADA} fp:${fingerprint(ADA)} `) && /\bada\b/.test(lines[1]) && /deny: claude-api/.test(lines[1]), 'ada: key, fingerprint, label, scope');
});

test('the docs and --help say a scope binds only an agent that cannot read the config', (t) => {
  const sb = sandbox([MAIN]);
  t.after(sb.cleanup);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const recipe = readme.slice(readme.indexOf('### Recipe: an agent key that cannot reach claude-api'), readme.indexOf('## Publishing it safely'));
  assert.match(recipe, /A scope binds only an agent that cannot read keysmith's config/);
  assert.match(recipe, /same OS user/);
  assert.match(fs.readFileSync(path.join(root, 'docs', 'clients.md'), 'utf8'), /binds only an agent that cannot read keysmith's config/);
  const help = sb.run('--help').stdout;
  assert.match(help, /A scope binds only an agent that cannot read this config/);
});
