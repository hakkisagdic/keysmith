/**
 * Reasoning effort on a CLI leg (src/effort.js): the client's, in its face's spellings, or one an
 * effort-suffixed model id names; checked against the CLI's own catalogue, never guessed; into the
 * argv where the profile says (`{effort}`), and nowhere when the request names none. No CLI, no
 * model: a stub CLI prints `codex exec --json` and logs its argv, its catalogue is `codex debug
 * models`' shape.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { jsonModelList } from '../src/cli-adapter.js';
import { requestEffort, effortSuffix } from '../src/effort.js';
import { joinArgs } from '../src/util.js';

const KEY = 'ks_test_effort_0000000000000000000';
const SCOPED = 'ks_test_effort_scoped_000000000000';
const NARROW = 'ks_test_effort_narrow_000000000000';
let dir, server, base, gateway, usageLog;

/* ------------------------------------------------------------------------- reading */

test('the effort a request chose, in its face\'s spellings; two that disagree, or one that is no level\'s name, are a 400', () => {
  assert.equal(requestEffort({ reasoning_effort: 'high' }, 'openai'), 'high');
  assert.equal(requestEffort({ reasoning: { effort: 'xhigh' } }, 'openai'), 'xhigh');
  assert.equal(requestEffort({ reasoning_effort: 'low', reasoning: { effort: 'low' } }, 'openai'), 'low');
  assert.equal(requestEffort({ output_config: { effort: 'max' } }, 'anthropic'), 'max');
  assert.equal(requestEffort({ reasoning_effort: 'high' }, 'anthropic'), null, 'the Messages face reads its own spelling');
  assert.equal(requestEffort({ reasoning_effort: null, reasoning: { summary: 'auto' } }, 'openai'), null);
  assert.throws(() => requestEffort({ reasoning_effort: 'low', reasoning: { effort: 'high' } }, 'openai'), (e) => e.status === 400 && /disagree/.test(e.message));
  assert.throws(() => requestEffort({ reasoning_effort: 3 }, 'openai'), (e) => e.status === 400);
  assert.throws(() => requestEffort({ output_config: 'high' }, 'anthropic'), (e) => e.status === 400);
});

test('catalogues: codex debug models\' supported_reasoning_levels, and Claude Code\'s answer to initialize (supportedEffortLevels, resolvedModel)', () => {
  const codex = jsonModelList(JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'ultra' }], visibility: 'list' }] }));
  assert.deepEqual(codex, [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'xhigh', 'ultra'], defaultEffort: 'medium' }]);
  const claude = jsonModelList(
    [
      JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'keysmith-models', response: { commands: [], models: [
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
      ] } } }),
    ].join('\n'),
  );
  assert.deepEqual(claude, [
    { id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], resolved: 'claude-sonnet-5-5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
  ]);
  assert.deepEqual(effortSuffix(claude, 'sonnet-xhigh'), { base: 'sonnet', level: 'xhigh' });
  assert.deepEqual(effortSuffix(claude, 'claude-sonnet-5-5-low'), { base: 'claude-sonnet-5-5', level: 'low' });
  assert.equal(effortSuffix(claude, 'claude-haiku-4-5-20251001-high'), null, 'a model with no levels has no effort ids');
  assert.equal(effortSuffix(claude, 'sonnet'), null);
});

test('the profiles: an effort is one argv group, left out when the request names none — the argv of before, byte for byte', () => {
  const vars = (effort) => ({ model: 'm', prompt: 'P', system: '', session: '', noSession: '--no-session-persistence', maxTokens: '', effort });
  const codexWith = joinArgs(CLI_PROFILES.codex.args, vars('xhigh'));
  const at = codexWith.indexOf('model_reasoning_effort="xhigh"');
  assert.ok(at > 0 && codexWith[at - 1] === '-c' && at < codexWith.indexOf('--'), 'a -c setting, before the prompt');
  const codexWithout = joinArgs(CLI_PROFILES.codex.args, vars(''));
  assert.deepEqual(codexWithout, codexWith.filter((a, i) => i !== at && i !== at - 1));
  assert.ok(!codexWithout.some((a) => /reasoning_effort/.test(a)));
  for (const field of ['args', 'resumeArgs', 'visionArgs']) {
    const claude = joinArgs(CLI_PROFILES.claude[field], { ...vars('high'), session: 's' });
    assert.equal(claude[claude.indexOf('--effort') + 1], 'high', field);
    assert.ok(!joinArgs(CLI_PROFILES.claude[field], { ...vars(''), session: 's' }).includes('--effort'), field);
  }
  assert.ok(joinArgs(CLI_PROFILES.codex.bridge.args, { ...vars('low'), server: 'ks0', mcpCommand: 'n', mcpArgs: '[]', mcpEnv: '{}', readyTimeoutSec: '30', toolTimeoutSec: '330' }).includes('model_reasoning_effort="low"'));
});

test('the claude profile reads its catalogue off Claude Code\'s answer to initialize, written to its stdin', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-effort-cc-'));
  try {
    // A stub of Claude Code's stream-json control channel: reads one control_request, answers it.
    const bin = path.join(d, 'claude');
    fs.writeFileSync(bin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = JSON.parse(input.trim());
  if (req.request?.subtype !== 'initialize') process.exit(3);
  const models = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'high'] }];
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { models } } }) + '\\n');
});
`, { mode: 0o755 });
    const { CliAdapter } = await import('../src/cli-adapter.js');
    const a = new CliAdapter('claude', { ...structuredClone(CLI_PROFILES.claude), bin, cwd: path.join(d, 'ws') });
    assert.deepEqual(await a.models(), [{ id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'high'], resolved: 'claude-sonnet-5-5' }]);
    assert.equal(a.takesEffort, true);
    // Declared models that say nothing of efforts leave the levels to the CLI's own listing.
    const declared = new CliAdapter('claude', { ...structuredClone(CLI_PROFILES.claude), bin, cwd: path.join(d, 'ws'), models: ['sonnet'] });
    assert.deepEqual((await declared.effortCatalogue())[0].efforts, ['low', 'high']);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ through the gateway */

function stub(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-effort-'));
  const catalogue = { models: [
    { slug: 'gpt-x', display_name: 'GPT-X', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-y', display_name: 'GPT-Y', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'gpt-plain', display_name: 'no levels' },
  ] };
  // `debug models` prints the catalogue; anything else is an `exec --json` run that logs its argv.
  const codex = stub('codex', `
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === 'debug') { process.stdout.write(${JSON.stringify(JSON.stringify(catalogue))}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(dir, 'argv.jsonl'))}, JSON.stringify(argv) + '\\n');
const prompt = argv.at(-1);
const reply = prompt.includes('Answer format') ? '{"final":"emulated"}' : 'answer';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: reply } });
line({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 } });
`);
  const plain = stub('plain', `require('node:fs').appendFileSync(${JSON.stringify(path.join(dir, 'argv-plain.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdout.write('plain');`);
  const cfg = {
    auth: { enabled: true, keys: [KEY, { key: SCOPED, allow: ['cx/gpt-x*'] }, { key: NARROW, allow: ['cx/gpt-x'] }] },
    limits: { streamHoldMs: 200, streamKeepaliveMs: 0 },
    adapters: {
      cx: { ...structuredClone(CLI_PROFILES.codex), bin: codex, cwd: path.join(dir, 'ws-cx'), toolMode: 'emulate', timeoutMs: 20_000 },
      // A CLI whose argv takes no effort: handed none, as before.
      pl: { kind: 'cli', bin: plain, args: ['{prompt}'], models: ['m'] },
    },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  usageLog = new UsageLog(path.join(dir, 'usage.jsonl'));
  server = createServer(gateway, cfg, { usage: usageLog, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await gateway.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body, key = KEY) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function models(key = KEY) {
  const res = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${key}` } });
  return JSON.parse(await res.text()).data;
}
const lastArgv = (file = 'argv.jsonl') => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
const effortOf = (argv) => argv.find((a) => a.startsWith('model_reasoning_effort=')) ?? null;
const modelOf = (argv) => argv[argv.indexOf('--model') + 1];
const lastRow = () => usageLog.tail(1)[0];
const chat = (model, extra = {}) => post('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], ...extra });

test('no effort named: the argv of before, and nothing in the row', async () => {
  const r = await chat('cx/gpt-x');
  assert.equal(r.status, 200, r.text);
  assert.equal(effortOf(lastArgv()), null);
  assert.equal(lastRow().effort, undefined);
});

test('each face\'s spelling reaches the CLI, streamed or not, and the row says which effort ran', async () => {
  const cases = [
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' }, 'high'],
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'low' }, stream: true }, 'low'],
    ['/v1/responses', { input: 'hi', reasoning: { effort: 'xhigh' } }, 'xhigh'],
    ['/v1/responses', { input: 'hi', reasoning_effort: 'medium', stream: true }, 'medium'],
    ['/v1/messages', { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } }, 'high'],
    ['/v1/messages', { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'low' }, stream: true }, 'low'],
  ];
  for (const [route, body, level] of cases) {
    const r = await post(route, { model: 'cx/gpt-x', ...body });
    assert.equal(r.status, 200, `${route}: ${r.text}`);
    assert.equal(effortOf(lastArgv()), `model_reasoning_effort="${level}"`, route);
    assert.equal(lastRow().effort, level, route);
  }
});

test('an effort-suffixed id runs the base model at that effort; with a field that says the same it runs, with one that disagrees it is a 400', async () => {
  let r = await chat('cx/gpt-x-xhigh');
  assert.equal(r.status, 200, r.text);
  assert.equal(modelOf(lastArgv()), 'gpt-x');
  assert.equal(effortOf(lastArgv()), 'model_reasoning_effort="xhigh"');
  assert.equal(JSON.parse(r.text).model, 'cx/gpt-x-xhigh', 'the client is answered under the id it asked for');
  r = await chat('cx/gpt-x-xhigh', { reasoning_effort: 'xhigh' });
  assert.equal(r.status, 200, r.text);
  r = await chat('cx/gpt-x-xhigh', { reasoning_effort: 'low' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error.message, /gpt-x at effort xhigh.*also asks for effort "low"/);
});

test('a level the model does not take is a 400 naming the ones it does — from the catalogue — on every face; a model with no levels takes none', async () => {
  let r = await chat('cx/gpt-y', { reasoning_effort: 'xhigh' });
  assert.equal(r.status, 400);
  const e = JSON.parse(r.text).error;
  assert.equal(e.type, 'invalid_request_error');
  assert.match(e.message, /effort "xhigh" is not one gpt-y takes on cx: low, high \(its catalogue\)/);
  r = await post('/v1/messages', { model: 'cx/gpt-y', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'max' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /low, high/);
  r = await post('/v1/responses', { model: 'cx/gpt-y', input: 'hi', reasoning: { effort: 'max' }, stream: true });
  assert.equal(r.status, 400, 'refused before the stream opens');
  r = await chat('cx/gpt-plain', { reasoning_effort: 'low' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error.message, /lists no effort levels for gpt-plain/);
  r = await chat('cx/not-listed', { reasoning_effort: 'low' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error.message, /not in cx's catalogue/);
  assert.equal(lastRow().status, 'error');
});

test('a CLI whose argv takes no effort is handed none, as before; the row says the client\'s was not applied', async () => {
  const r = await chat('pl/m', { reasoning_effort: 'high' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(lastArgv('argv-plain.jsonl').filter((a) => /effort/.test(a)), []);
  assert.equal(lastRow().effortIgnored, "pl's argv takes no effort");
  assert.equal(lastRow().effort, undefined);
});

test('an entry upgraded in part (`{effort}` in some templates, not all) takes no effort on any path, and its row says which templates lack it', async () => {
  const { CliAdapter } = await import('../src/cli-adapter.js');
  const p = structuredClone(CLI_PROFILES.claude);
  const plain = (a) => a.filter((t) => !(Array.isArray(t) && t[0] === '--effort'));
  const half = new CliAdapter('claude', { ...p, args: plain(p.args), resumeArgs: plain(p.resumeArgs), visionArgs: plain(p.visionArgs) });
  assert.equal(half.takesEffort, false);
  assert.match(half.effortGap, /claude's args, resumeArgs, visionArgs take no \{effort\} — keysmith upgrade claude --take args,resumeArgs,visionArgs --apply/);
  const { resolveEffort } = await import('../src/effort.js');
  assert.deepEqual(await resolveEffort(half, 'sonnet', 'high'), { model: 'sonnet', effort: null, ignored: half.effortGap });
  assert.equal(new CliAdapter('claude', p).effortGap, null);
});

test('a request waits on the CLI\'s listing only when there has never been one: a stale catalogue answers and is read again behind it; an id with no `-` and no effort reads none', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-effort-swr-'));
  try {
    const count = path.join(d, 'count');
    const bin = path.join(d, 'codex');
    fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(count)}, 'x');\nprocess.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-x', supported_reasoning_levels: [{ effort: 'low' }] }] }));\n`, { mode: 0o755 });
    const reads = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').length : 0);
    const { CliAdapter } = await import('../src/cli-adapter.js');
    const { resolveEffort } = await import('../src/effort.js');
    const a = new CliAdapter('cx', { ...structuredClone(CLI_PROFILES.codex), bin, cwd: path.join(d, 'ws') });
    assert.deepEqual(await resolveEffort(a, 'gptx', null), { model: 'gptx', effort: null });
    assert.equal(reads(), 0, 'nothing to read the catalogue for');
    assert.deepEqual(await resolveEffort(a, 'gpt-x-low', null), { model: 'gpt-x', effort: 'low' });
    assert.equal(reads(), 1);
    a._modelCache.at -= 3_600_000;
    assert.deepEqual(await resolveEffort(a, 'gpt-x', 'low'), { model: 'gpt-x', effort: 'low' }, 'the stale list answers at once');
    await a._modelCacheRefresh;
    assert.equal(reads(), 2, 'and was read again behind it');
    assert.ok(Date.now() - a._modelCache.at < 60_000);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('EMULATE takes the effort too: its argv is the profile\'s, with the level in it', async () => {
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
  const r = await chat('cx/gpt-x-high', { tools });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'emulated');
  assert.equal(effortOf(lastArgv()), 'model_reasoning_effort="high"');
  assert.equal(lastRow().toolMode, 'emulate');
  assert.equal(lastRow().effort, 'high');
});

test('/v1/models lists an id per level the catalogue gives; a scope decides them as written', async () => {
  const ids = (list) => list.map((m) => m.id).filter((id) => id.startsWith('cx/')).sort();
  const all = await models();
  assert.deepEqual(ids(all), ['cx/gpt-plain', 'cx/gpt-x', 'cx/gpt-x-high', 'cx/gpt-x-low', 'cx/gpt-x-medium', 'cx/gpt-x-xhigh', 'cx/gpt-y', 'cx/gpt-y-high', 'cx/gpt-y-low']);
  const xhigh = all.find((m) => m.id === 'cx/gpt-x-xhigh');
  assert.deepEqual([xhigh.keysmith.upstream, xhigh.keysmith.effort], ['gpt-x', 'xhigh']);
  assert.deepEqual(all.find((m) => m.id === 'cx/gpt-y').keysmith.efforts, ['low', 'high']);
  assert.deepEqual(all.filter((m) => m.id.startsWith('pl/')).map((m) => m.id), ['pl/m'], 'no effort ids for a CLI that takes none');
  // `cx/gpt-x*` reaches the effort ids; `cx/gpt-x` alone does not.
  assert.deepEqual(ids(await models(SCOPED)), ['cx/gpt-x', 'cx/gpt-x-high', 'cx/gpt-x-low', 'cx/gpt-x-medium', 'cx/gpt-x-xhigh']);
  assert.equal((await chat('cx/gpt-x-low', {}, SCOPED).then((r) => r)).status, 200);
  assert.deepEqual(ids(await models(NARROW)), ['cx/gpt-x']);
  const narrow = await post('/v1/chat/completions', { model: 'cx/gpt-x-low', messages: [{ role: 'user', content: 'hi' }] }, NARROW);
  assert.equal(narrow.status, 403);
});
