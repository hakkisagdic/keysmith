import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinArgs, flattenMessages, agentCleanEnv } from '../src/util.js';
import { resolveSecret } from '../src/config.js';
import { cmdNdjson, opencodeNdjson, claudeStreamJson, agyStreamJson, rawText, toLines } from '../src/parsers.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { Gateway } from '../src/gateway.js';
import { tunnelArgs } from '../src/tunnel.js';
import * as service from '../src/service.js';

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

// Captured from `agy --output-format stream-json --model gemini-3.8-flash-low -p "Reply with exactly: pong"`
// on agy 1.3.1 (the init line's 60-entry tool list trimmed).
const AGY_PONG = [
  '{"event":"init","conversation_id":"76a2b832-2921-45af-9699-278563840736","init":{"model":"gemini-3.8-flash-low","tools":["run_command","view_file"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"76a2b832-2921-45af-9699-278563840736","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"76a2b832-2921-45af-9699-278563840736","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"pong"}}',
  '{"event":"step_update","step_update":{"conversation_id":"76a2b832-2921-45af-9699-278563840736","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":1.70496,"usage":{"input_tokens":20107,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":20108}}}',
  '{"event":"result","result":{"conversation_id":"76a2b832-2921-45af-9699-278563840736","status":"SUCCESS","response":"pong\\n","duration_seconds":8.618885,"num_turns":1,"usage":{"input_tokens":20107,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":20108}}}',
];

test('agy-stream-json streams agent_response deltas once, with the session and the harness prompt in usage', async () => {
  const events = await collect(agyStreamJson(asLines(AGY_PONG)));
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'pong\n', 'the final response is not appended a second time');
  assert.equal(events.filter((e) => e.type === 'session').length, 1);
  assert.equal(events.find((e) => e.type === 'session').id, '76a2b832-2921-45af-9699-278563840736');
  assert.equal(events.find((e) => e.type === 'usage').usage.input, 20107, 'the ~20k agy prompt is billed and reported');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(!events.some((e) => e.type === 'error'));
});

// Captured from a `--conversation <id>` resume: result.usage is the whole thread's total.
test('agy-stream-json reports what this run spent, not the resumed conversation total', async () => {
  const events = await collect(
    agyStreamJson(
      asLines([
        '{"event":"init","conversation_id":"4dad756f","init":{"model":"gemini-3.8-flash-low"}}',
        '{"event":"step_update","step_update":{"conversation_id":"4dad756f","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"391"}}',
        '{"event":"step_update","step_update":{"conversation_id":"4dad756f","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":20674,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":20677}}}',
        '{"event":"result","result":{"conversation_id":"4dad756f","status":"SUCCESS","response":"391\\n","num_turns":2,"usage":{"input_tokens":40791,"output_tokens":199,"thinking_tokens":193,"cache_read_tokens":0,"total_tokens":40990}}}',
      ]),
    ),
  );
  assert.equal(events.filter((e) => e.type === 'usage').length, 1, 'one usage event, since the gateway keeps the max of several');
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 20674, output: 3, cacheRead: 0, cacheWrite: 0 });
});

// Captured: the model called run_command, headless mode denied it, the run "succeeded" empty.
test('agy-stream-json turns an auto-denied tool call into an error instead of an empty answer', async () => {
  const events = await collect(
    agyStreamJson(
      asLines([
        '{"event":"step_update","step_update":{"conversation_id":"6d0a","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":20118,"output_tokens":229,"thinking_tokens":108,"cache_read_tokens":0,"total_tokens":20347}}}',
        '{"event":"step_update","step_update":{"conversation_id":"6d0a","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"touch x"}}}}',
        '{"event":"result","result":{"conversation_id":"6d0a","status":"SUCCESS","response":"","num_turns":1,"usage":{"input_tokens":20118,"output_tokens":229,"total_tokens":20347},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
      ]),
    ),
  );
  assert.match(events.find((e) => e.type === 'error').message, /RunCommand.*auto-denies/);
  assert.equal(events.at(-1).type, 'done');
});

test('agy-stream-json surfaces a failed status, and still terminates without a result line', async () => {
  const failed = await collect(agyStreamJson(asLines(['{"event":"result","result":{"status":"ERROR","error":"You have exhausted your quota on this model."}}'])));
  assert.match(failed.find((e) => e.type === 'error').message, /ERROR — You have exhausted your quota/);
  const cut = await collect(agyStreamJson(asLines(['{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"half"}}'])));
  assert.equal(cut.at(-1).type, 'done', 'a killed process still yields the terminator');
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

/* --- tunnel argv ---------------------------------------------------------------- */

test('a quick tunnel gets --url and no tunnel name', () => {
  assert.deepEqual(tunnelArgs({ port: 8787 }), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787']);
});

test('a named tunnel must carry --config, or cloudflared reads nothing and the edge 503s', () => {
  const args = tunnelArgs({ port: 8787, name: 'keysmith', configFile: '/home/me/.cloudflared/keysmith.yml' });
  assert.ok(args.includes('--config'), 'the ingress file has to be named explicitly');
  assert.ok(args.includes('/home/me/.cloudflared/keysmith.yml'));
  assert.deepEqual(args.slice(-2), ['run', 'keysmith']);
  assert.ok(!args.includes('--url'), 'a named tunnel never points at a URL, only the ingress file does');
});

test('~ in a configured ingress path is expanded before it reaches cloudflared', () => {
  const args = tunnelArgs({ port: 1, name: 'k', configFile: '~/.cloudflared/keysmith.yml' });
  const given = args[args.indexOf('--config') + 1];
  assert.ok(!given.startsWith('~'), `got ${given}`);
  assert.ok(path.isAbsolute(given));
  assert.equal(given, path.join(os.homedir(), '.cloudflared/keysmith.yml'));
});

test('a named tunnel with no ingress file still runs, which is the shape that fails silently', () => {
  const args = tunnelArgs({ port: 8787, name: 'keysmith' });
  assert.ok(!args.includes('--config'), 'documented: callers must pass configFile; startTunnel falls back to the on-disk file');
});

/* --- launchd service plists ------------------------------------------------------- */

test('gateway plist runs serve under launchd with KeepAlive and a log path', () => {
  const p = service.gatewayPlist({ nodeBin: '/opt/homebrew/bin/node', entry: '/Users/me/projects/keysmith/src/cli.js', port: 8787 });
  assert.ok(p.includes('<string>dev.keysmith.gateway</string>'));
  assert.ok(p.includes('<string>serve</string>'));
  assert.ok(p.includes('<string>--port</string>') && p.includes('<string>8787</string>'));
  assert.ok(p.includes('<key>KeepAlive</key>') && p.includes('<true/>'));
  assert.ok(p.includes('launchd-gateway.log'));
  assert.ok(p.includes('<key>PATH</key>'), 'launchd PATH must find the user CLIs the adapters spawn');
});

test('tunnel plist names the ingress file and the tunnel, and escapes XML in paths', () => {
  const p = service.tunnelPlist({ cloudflared: '/opt/homebrew/bin/cloudflared', name: 'keysmith', configFile: '/Users/me/.cloudflared/keysmith.yml' });
  const args = p.split('\n').filter((l) => l.includes('<string>')).map((l) => l.trim().replace(/<\/?string>/g, ''));
  const runAt = args.indexOf('run');
  assert.ok(args.includes('--config'));
  assert.equal(args[runAt + 1], 'keysmith', 'tunnel name must be the last argument');
  assert.ok(args.includes('/Users/me/.cloudflared/keysmith.yml'));
  assert.ok(!p.includes('&amp;amp;'), 'no double-escaping');
});

/* --- the agy profile and CLI adapter plumbing ---------------------------------------- */

test('the agy profile keeps -p and its prompt last, and drops --model when none was asked for', () => {
  const p = CLI_PROFILES.agy;
  const argv = joinArgs(p.args, { model: 'gemini-3.8-flash-medium', prompt: '--looks like a flag', session: '', noSession: '' });
  assert.deepEqual(argv.slice(-2), ['-p', '--looks like a flag'], 'agy reads whatever follows -p as the prompt');
  assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  assert.ok(argv.includes('--disable-slash-commands'), 'a completion must never expand /commands or skills');
  assert.ok(!joinArgs(p.args, { model: '', prompt: 'hi' }).includes('--model'));
  const resume = joinArgs(p.resumeArgs, { model: 'm', prompt: 'hi', session: 'conv-1' });
  assert.equal(resume[resume.indexOf('--conversation') + 1], 'conv-1');
  assert.deepEqual(resume.slice(-2), ['-p', 'hi']);
  assert.equal(p.parser, 'agy-stream-json');
  assert.ok(p.persistSessions && p.maxConcurrent >= 1 && p.timeoutMs > 280_000, 'agy --print-timeout must expire before keysmith kills it');
});

function stubBin(dir, name, body) {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('a tab-separated model listing (agy models) is read, its stderr banner is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-models-'));
  const bin = stubBin(dir, 'agy', `echo 'Fetching available models...' >&2\nprintf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\nclaude-sonnet-5-5-low\\tClaude Sonnet 5.5 (Low)\\n'`);
  const a = new CliAdapter('agy', { bin, modelsFrom: { args: ['models'] } });
  const list = await a.models();
  assert.deepEqual(list, [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a configured cwd is created on first spawn, so a fresh machine does not ENOENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-cwd-'));
  const ws = path.join(dir, 'workspaces', 'agy');
  const bin = stubBin(dir, 'echocwd', 'pwd -P');
  const a = new CliAdapter('echocwd', { bin, cwd: ws, args: ['{prompt}'] });
  let text = '';
  for await (const e of a.complete({ model: '', messages: [{ role: 'user', content: 'x' }] })) if (e.type === 'delta') text += e.text;
  assert.equal(text.trim(), fs.realpathSync(ws));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a request whose client left while queued never spawns the CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-queue-'));
  const runs = path.join(dir, 'runs');
  const bin = stubBin(dir, 'slow', `echo run >> '${runs}'\nsleep 0.4\necho done`);
  const a = new CliAdapter('slow', { bin, args: ['{prompt}'], maxConcurrent: 1 });
  const drain = async (signal) => {
    let t = '';
    for await (const e of a.complete({ model: '', messages: [{ role: 'user', content: 'x' }], signal })) if (e.type === 'delta') t += e.text;
    return t;
  };
  const first = drain();
  const gone = new AbortController();
  const second = drain(gone.signal);
  await new Promise((r) => setTimeout(r, 100));
  gone.abort(new Error('client disconnected'));
  assert.equal((await first).trim(), 'done');
  await assert.rejects(second, /client disconnected while queued/);
  assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, 1, 'the abandoned request did not run an agent for nobody');
  fs.rmSync(dir, { recursive: true, force: true });
});
