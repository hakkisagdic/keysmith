/**
 * Gemini 3.8 Flash on Google's OpenAI-compatible endpoint thinks by default, and its thinking is
 * counted against `max_tokens`: asked for one word with `max_tokens: 8` (a virtual model's
 * classifier) it answered nothing. A request for at most 16 tokens that chose no effort of its own
 * goes out with `reasoning_effort: "none"` (src/http-adapter.js tinyOutputEffort). `fetch` is a
 * stub here: nothing leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { HTTP_PROFILES } from '../src/profiles.js';
import { TINY_OUTPUT_MAX_TOKENS, tinyOutputEffort } from '../src/http-adapter.js';

const GOOGLE = 'generativelanguage.googleapis.com';
const KEY = 'AIzaSy' + 'T'.repeat(33);

test('tinyOutputEffort: "none" for Gemini 3.8 Flash on Google\'s endpoint when at most 16 tokens are asked, otherwise nothing', () => {
  assert.equal(TINY_OUTPUT_MAX_TOKENS, 16);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash', 8), 'none');
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash', 16), 'none');
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash-preview-11-2026', 1), 'none');
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash', 17), null);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash', undefined), null);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash', 0), null);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.8-flash-lite', 8), null);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-3.7-flash', 8), null);
  assert.equal(tinyOutputEffort(GOOGLE, 'gemini-4-argon', 8), null);
  assert.equal(tinyOutputEffort('127.0.0.1:8092', 'gemini-3.8-flash', 8), null);
});

test('google/gemini-3.8-flash: a tiny request (and the classifier) goes out with reasoning_effort "none"; a longer one, another model, or an effort already chosen is left alone', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (!init.body) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.7-flash' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'simple' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const google = { ...structuredClone(HTTP_PROFILES.google), apiKey: KEY };
    const gw = new Gateway(
      {
        adapters: {
          google,
          gparams: { ...structuredClone(google), modelParams: { 'gemini-3.8-flash': { reasoning_effort: 'low' } } },
          copilot: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: false, models: ['gpt-4.1'] },
        },
        virtualModels: {
          'auto/text': {
            classifier: 'google/gemini-3.8-flash',
            tiers: { simple: ['copilot/gpt-4.1'], medium: ['copilot/gpt-4.1'], complex: ['copilot/gpt-4.1'] },
          },
        },
      },
      { loadProbe: () => ({ loadPerCore: 0.1, cores: 8, memoryPressure: 'normal' }) },
    );
    const messages = [{ role: 'user', content: 'Reply with one word.' }];
    const ask = async (model, extra = {}) => {
      await gw.collect({ model, messages, ...extra });
      return sent.at(-1);
    };

    let s = await ask('google/gemini-3.8-flash', { maxTokens: 8 });
    assert.match(s.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
    assert.equal(s.body.model, 'gemini-3.8-flash');
    assert.equal(s.body.max_tokens, 8);
    assert.equal(s.body.reasoning_effort, 'none');
    assert.equal((await ask('google/gemini-3.8-flash', { maxCompletionTokens: 12 })).body.reasoning_effort, 'none');

    assert.equal('reasoning_effort' in (await ask('google/gemini-3.8-flash', { maxTokens: 400 })).body, false, 'a longer answer keeps the model default');
    assert.equal('reasoning_effort' in (await ask('google/gemini-3.8-flash')).body, false, 'no limit, no change');
    assert.equal('reasoning_effort' in (await ask('google/gemini-3.7-flash', { maxTokens: 8 })).body, false, 'another model is left alone');
    assert.equal((await ask('gparams/gemini-3.8-flash', { maxTokens: 8 })).body.reasoning_effort, 'low', 'modelParams choose their own effort');
    // An effort the leg was given (an effort-suffixed model, a UHP client's) is the one sent.
    for await (const _ of gw.adapters.get('google').complete({ model: 'gemini-3.8-flash', messages, maxTokens: 8, effort: 'high' })) void _;
    assert.equal(sent.at(-1).body.reasoning_effort, 'high', 'the request chose its own effort');

    // The virtual model's classifier: max_tokens 8, so its call is sent with reasoning_effort "none".
    const before = sent.length;
    const r = await gw.explainRoute('auto/text', 'What does HTTP 404 mean?');
    assert.equal(r.label, 'simple');
    assert.equal(r.reason, 'classified');
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).body.max_tokens, 8);
    assert.equal(sent.at(-1).body.reasoning_effort, 'none');
    await gw.settleClassifierCalls();
  } finally {
    globalThis.fetch = realFetch;
  }
});
