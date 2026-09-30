import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinArgs, flattenMessages, agentCleanEnv } from '../src/util.js';
import { resolveSecret } from '../src/config.js';
import { cmdNdjson, opencodeNdjson, claudeStreamJson, rawText, toLines } from '../src/parsers.js';
import { Gateway } from '../src/gateway.js';

/* ------------------------------------------------------------------- argv templates */

test('joinArgs keeps a bare placeholder as one argv entry', () => {
  const argv = joinArgs(['-p', '{prompt}'], { prompt: 'hello world\nsecond line' });
  assert.deepEqual(argv, ['-p', 'hello world\nsecond line']);
});

test('joinArgs drops an empty placeholder instead of passing ""', () => {
  assert.deepEqual(joinArgs(['-p', '{prompt}'], { prompt: '' }), ['-p']);
});

test('joinArgs drops a whole flag group when its value is missing', () => {
  // `-m` with no model would make the CLI consume the prompt as its argument.
  assert.deepEqual(joinArgs(['-p', ['-m', '{model}'], '{prompt}'], { model: '', prompt: 'hi' }), ['-p', 'hi']);
  assert.deepEqual(joinArgs(['-p', ['-m', '{model}'], '{prompt}'], { model: 'glm', prompt: 'hi' }), ['-p', '-m', 'glm', 'hi']);
});

test('{noSession} disappears once sessions are persisted', () => {
  const tpl = ['cmd', '-p', '{noSession}', '{prompt}'];
  assert.deepEqual(joinArgs(tpl, { noSession: '--no-session', prompt: 'x' }), ['cmd', '-p', '--no-session', 'x']);
  assert.deepEqual(joinArgs(tpl, { noSession: '', prompt: 'x' }), ['cmd', '-p', 'x']);
});

/* ---------------------------------------------------------------------- message shape */

test('flattenMessages hoists system turns and labels the rest', () => {
  const { system, prompt } = flattenMessages([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]);
  assert.equal(system, 'Be terse.');
  assert.equal(prompt, 'User: hi\n\nAssistant: hello\n\nUser: again');
});

test('images are labelled, not dropped silently', () => {
  const { prompt } = flattenMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }, { type: 'text', text: 'what is this' }] }]);
  assert.match(prompt, /image omitted by keysmith/);
  assert.match(prompt, /what is this/);
});

test('nested agent markers are scrubbed from child env', () => {
  const env = agentCleanEnv({ PATH: '/bin', QODER_AGENT_SDK_ENTRYPOINT: 'x', CLAUDE_CODE_ENTRYPOINT: 'y', KEEP: 'me' });
  assert.equal(env.QODER_AGENT_SDK_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.KEEP, 'me');
});

/* ------------------------------------------------------------------------- secrets */

test('secret references resolve without ever storing the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-'));
  fs.writeFileSync(path.join(dir, 'token'), 'sk-from-file\n');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ evren: { type: 'api', key: 'sk-nested' } }));
  assert.equal(resolveSecret(`{file:${path.join(dir, 'token')}}`), 'sk-from-file');
  assert.equal(resolveSecret(`{json:${path.join(dir, 'auth.json')}#evren.key}`), 'sk-nested');
  assert.equal(resolveSecret('{env:KEYSMITH_MISSING_FOR_TEST}'), null);
  assert.equal(resolveSecret('sk-literal'), 'sk-literal');
  assert.equal(resolveSecret(false), null);
  assert.throws(() => resolveSecret('{weird:x}'), /unknown secret reference kind/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------------------- parsers */

async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}
const asLines = (arr) =>
  (async function* () {
    for (const a of arr) yield a;
  })();

test('cmd-ndjson streams deltas, then reports session, usage and done once', async () => {
  const events = await collect(
    cmdNdjson(
      asLines([
        '{"type":"event","event":{"type":"text_delta","delta":"Hel"}}',
        '{"type":"event","event":{"type":"text_delta","delta":"lo"}}',
        '{"type":"event","event":{"type":"model_request_end","usage":{"inputTokens":16392,"outputTokens":10,"cacheReadTokens":13824}}}',
        '{"type":"result","subtype":"success","sessionId":"abc","usage":{"inputTokens":16392,"outputTokens":10,"cacheReadTokens":13824},"finalText":"Hello"}',
      ]),
    ),
  );
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.equal(events.filter((e) => e.type === 'done').length, 1, 'exactly one done terminator');
  assert.equal(events.find((e) => e.type === 'session').id, 'abc');
  const usage = events.find((e) => e.type === 'usage').usage;
  assert.equal(usage.input, 16392);
  assert.equal(usage.cacheRead, 13824, 'the harness prompt is reported, not the 5 tokens you sent');
});

test('cmd-ndjson surfaces a failed run without losing the terminator', async () => {
  const events = await collect(cmdNdjson(asLines(['{"type":"result","subtype":"error_max_turns"}'])));
  assert.ok(events.some((e) => e.type === 'error' && /error_max_turns/.test(e.message)));
  assert.ok(events.some((e) => e.type === 'done'));
});

test('parsers ignore lines they do not understand', async () => {
  const events = await collect(cmdNdjson(asLines(['not json', '{"unrelated":true}', '{"type":"event","event":{"type":"text_delta","delta":"ok"}}'])));
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'ok');
});

test('a total-only usage report stays a total, never an invented split', async () => {
  const events = await collect(opencodeNdjson(asLines(['{"type":"step_finish","part":{"tokens":{"total":14329}}}'])));
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 14329 });
});

test('opencode flushes whole text blocks; only the tail is forwarded', async () => {
  const events = await collect(
    opencodeNdjson(
      asLines([
        '{"type":"text","part":{"text":"Count"},"sessionID":"ses_1"}',
        '{"type":"text","part":{"text":"Count 1, 2, 3"},"sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":2,"write":0}},"reason":"stop"},"sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"tokens":{"total":14329},"reason":"stop"},"sessionID":"ses_1"}',
      ]),
    ),
  );
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Count 1, 2, 3');
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 });
});

test('claude-stream-json does not repeat a message it re-sends', async () => {
  const events = await collect(
    claudeStreamJson(
      asLines([
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"One"}]}}',
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"One"}]}}',
        '{"type":"result","result":"One","session_id":"s9","usage":{"input_tokens":3,"output_tokens":1}}',
      ]),
    ),
  );
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'One');
  assert.equal(events.find((e) => e.type === 'session').id, 's9');
});

// Captured from `claude -p --output-format stream-json --resume <unknown id>` on 2.1.261:
// a failed run has `result: null` and puts the reason in `errors[]`.
test('a claude result error says what actually went wrong, and still terminates', async () => {
  const events = await collect(
    claudeStreamJson(
      asLines([
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":null,"session_id":"00000000-0000-0000-0000-000000000000","usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: 00000000-0000-0000-0000-000000000000"]}',
      ]),
    ),
  );
  const err = events.find((e) => e.type === 'error');
  assert.match(err.message, /No conversation found/);
  assert.equal(events.at(-1).type, 'done');
});

test('rawText treats a whole stdout as the answer', async () => {
  const events = await collect(rawText(asLines(['line one', 'line two'])));
  assert.equal(events.find((e) => e.type === 'delta').text, 'line one\nline two');
});

test('toLines reassembles split bytes and drops the trailing newline', async () => {
  const chunks = ['he', 'llo\nwor', 'ld\n'];
  const out = await collect(toLines((async function* () { for (const c of chunks) yield c; })()));
  assert.deepEqual(out, ['hello', 'world']);
});

/* -------------------------------------------------------------------------- routing */

function stubAdapter(id, opts = {}) {
  return {
    id,
    kind: 'http',
    wire: 'openai',
    disabled: false,
    priority: opts.priority ?? 100,
    resumeArgs: null,
    resumable: false,
    // HttpAdapter keeps the config's `models` on `_declared`; the gateway reads it (never `models()`)
    // so alias legs can be checked without a network round trip.
    _declared: opts.declared,
    _modelCache: null,
    // Both real adapters fill this on read, and the gateway uses it to check legs against a
    // catalogue it could only learn by asking.
    async models() {
      const list = opts.models || [{ id: 'm1' }];
      this._modelCache = { at: Date.now(), list };
      return list;
    },
    async *complete({ model }) {
      if (opts.fail) throw new Error(`${id} is down`);
      yield { type: 'delta', text: `${id}:${model}` };
      yield { type: 'usage', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

test('a bare model id routes to the adapter named before the first slash', async () => {
  const gw = new Gateway({ adapters: {}, aliases: {} });
  gw.adapters.set('a', stubAdapter('a'));
  const { text } = await gw.collect({ model: 'a/m1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(text, 'a:m1');
});

test('upstream ids may contain slashes — only the first one splits', async () => {
  const gw = new Gateway({ adapters: {}, aliases: {} });
  gw.adapters.set('or', stubAdapter('or'));
  const { text } = await gw.collect({ model: 'or/deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(text, 'or:deepseek/deepseek-v4-flash');
});

test('an alias tries candidates in the declared order and fails over', async () => {
  const gw = new Gateway({ adapters: {}, aliases: { route: ['down/m1', 'up/m1'] } });
  gw.adapters.set('down', stubAdapter('down', { fail: true }));
  gw.adapters.set('up', stubAdapter('up'));
  const { text } = await gw.collect({ model: 'route', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(text, 'up:m1');
});

test('an unknown adapter is a 404, not a silent empty answer', async () => {
  const gw = new Gateway({ adapters: {}, aliases: {} });
  await assert.rejects(() => gw.collect({ model: 'nope/m1', messages: [{ role: 'user', content: 'x' }] }), /no adapter named "nope"/);
});

test('a leg pointing at an adapter that does not exist is named in aliasIssues', () => {
  const gw = new Gateway({ adapters: {}, aliases: { route: ['ghost/m1', 'real/m1'] } });
  gw.adapters.set('real', stubAdapter('real'));
  const issues = gw.aliasIssues;
  assert.deepEqual(Object.keys(issues), ['route']);
  assert.match(issues.route[0], /no adapter named "ghost"/);
  assert.equal(issues.route.length, 1, 'the healthy leg is not reported');
});

test('a leg naming a model the adapter never declared is reported, a dynamic catalogue is not', () => {
  const gw = new Gateway({ adapters: {}, aliases: { typed: ['http/gpt-5.1'], cli: ['cli/whatever'] } });
  gw.adapters.set('http', stubAdapter('http', { declared: ['gpt-4.1', 'gpt-4o'] }));
  gw.adapters.set('cli', stubAdapter('cli', { models: [{ id: 'anything' }] }));
  assert.match(gw.aliasIssues.typed[0], /"gpt-5.1" is not among http's declared models/);
  assert.equal(gw.aliasIssues.cli, undefined, 'a CLI with no declared models is a catalogue we cannot check without spawning it');
});

test('a leg whose adapter failed to load says why, and nesting and empty chains are caught too', () => {
  const gw = new Gateway({ adapters: { broken: { kind: 'http', baseUrl: 'http://127.0.0.1:1', apiKey: '{env:KEYSMITH_TEST_NO_SUCH_VAR}' } }, aliases: { empty: [], nested: ['other'], other: ['x/m1'], off: ['dis/m1'] } });
  gw.adapters.set('dis', Object.assign(stubAdapter('dis'), { disabled: true }));
  const issues = gw.aliasIssues;
  assert.match(issues.empty[0], /has no targets/);
  assert.match(issues.nested[0], /aliases cannot nest/);
  assert.match(issues.off[0], /adapter "dis" is disabled/);
  assert.match(issues.other[0], /no adapter named "x"/);
});

test('a dynamic catalogue is checked once the gateway has read it, and only while that read is fresh', async () => {
  const gw = new Gateway({ adapters: {}, aliases: { r: ['dyn/not-listed'] } });
  const dyn = stubAdapter('dyn', { models: [{ id: 'listed' }] });
  gw.adapters.set('dyn', dyn);
  assert.equal(gw.aliasIssues.r, undefined, 'nothing has been read yet, so there is nothing to check against');
  await gw.listModels();
  assert.match(gw.aliasIssues.r[0], /"not-listed" is not among dyn's last-read model list/);
  dyn._modelCache = { at: Date.now() - 601_000, list: [{ id: 'listed' }] };
  assert.equal(gw.aliasIssues.r, undefined, 'a list more than ten minutes old is not evidence about right now');
});


test('aliasIssues is recomputed, so an adapter added after construction clears its leg', () => {
  const gw = new Gateway({ adapters: {}, aliases: { route: ['late/m1'] } });
  assert.equal(gw.aliasIssues.route[0].includes('no adapter named "late"'), true);
  gw.adapters.set('late', stubAdapter('late'));
  assert.deepEqual(gw.aliasIssues, {});
});

test('an unusable alias leg reaches listModels errors and never the client as a surprise', async () => {
  const gw = new Gateway({ adapters: {}, aliases: { route: ['ghost/m1', 'real/m1'] } });
  gw.adapters.set('real', stubAdapter('real'));
  const { errors } = await gw.listModels();
  assert.ok(errors.some((e) => e.includes('alias "route"') && e.includes('ghost/m1')), errors.join(' | '));
  const { text } = await gw.collect({ model: 'route', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(text, 'real:m1', 'the route still answers from the next leg');
});

test('a dead leg in an alias is skipped, but an alias with only dead legs still reports the first reason', async () => {
  const gw = new Gateway({ adapters: {}, aliases: { half: ['ghost/m1', 'real/m1'], all: ['ghost/m1', 'also/m1'], off: ['dis/m1', 'real/m1'] } });
  gw.adapters.set('real', stubAdapter('real'));
  gw.adapters.set('dis', Object.assign(stubAdapter('dis'), { disabled: true }));
  assert.equal((await gw.collect({ model: 'half', messages: [{ role: 'user', content: 'x' }] })).text, 'real:m1');
  assert.equal((await gw.collect({ model: 'off', messages: [{ role: 'user', content: 'x' }] })).text, 'real:m1', 'a disabled adapter is a dead leg too, not a hard failure');
  await assert.rejects(() => gw.collect({ model: 'all', messages: [{ role: 'user', content: 'x' }] }), /no adapter named "ghost"/);
});


test('the catalogue prefixes ids and keeps upstream metadata', async () => {
  const gw = new Gateway({ adapters: {}, aliases: { duo: ['a/m1'] } });
  gw.adapters.set('a', stubAdapter('a', { models: [{ id: 'm1', contextWindow: 4096 }] }));
  const { models } = await gw.listModels();
  const m = models.find((x) => x.id === 'a/m1');
  assert.equal(m.owned_by, 'keysmith:a');
  assert.equal(m.keysmith.contextWindow, 4096);
  assert.ok(models.some((x) => x.id === 'duo' && x.keysmith.kind === 'alias'), 'aliases are selectable in a picker');
});
