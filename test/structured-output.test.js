/**
 * Unit tests for src/structured-output.js: config resolution, spec extraction,
 * prompt instruction prepending, linear JSON healing (including safe truncation),
 * ReDoS-safe schema validation, size bounds, and non-leakage of model/schema text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STRUCTURED_CHARS,
  STRUCTURED_DEFAULTS,
  enforceStructuredOutput,
  extractResponseFormatSpec,
  healAndParseJson,
  prependStructuredInstruction,
  resolveStructuredConfig,
  structuredInstruction,
} from '../src/structured-output.js';

test('resolveStructuredConfig: absent or off defaults to off; heal enables; bad values report an error and stay off', () => {
  assert.deepEqual(STRUCTURED_DEFAULTS, { mode: 'off' });
  assert.deepEqual(resolveStructuredConfig(undefined), { mode: 'off', enabled: false, error: null });
  assert.deepEqual(resolveStructuredConfig(null), { mode: 'off', enabled: false, error: null });
  assert.deepEqual(resolveStructuredConfig({}), { mode: 'off', enabled: false, error: null });
  assert.deepEqual(resolveStructuredConfig({ mode: 'off' }), { mode: 'off', enabled: false, error: null });
  assert.deepEqual(resolveStructuredConfig({ mode: 'heal' }), { mode: 'heal', enabled: true, error: null });

  for (const bad of ['heal', [], 42, true, { mode: 'yes' }, { mode: true }, { mode: 'heal', extra: 1 }]) {
    const res = resolveStructuredConfig(bad);
    assert.equal(res.mode, 'off');
    assert.equal(res.enabled, false);
    assert.match(res.error || '', /structuredOutput.*stays off/i);
  }
});

test('extractResponseFormatSpec: handles chat and responses faces and returns null for text or absent', () => {
  assert.equal(extractResponseFormatSpec(null, 'chat'), null);
  assert.equal(extractResponseFormatSpec({}, 'chat'), null);
  assert.equal(extractResponseFormatSpec({ response_format: { type: 'text' } }, 'chat'), null);
  assert.deepEqual(
    extractResponseFormatSpec({ response_format: { type: 'json_object' } }, 'chat'),
    { type: 'json_object' },
  );
  const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] };
  assert.deepEqual(
    extractResponseFormatSpec(
      { response_format: { type: 'json_schema', json_schema: { name: 'item', strict: true, schema } } },
      'chat',
    ),
    { type: 'json_schema', name: 'item', strict: true, schema },
  );
  assert.equal(
    extractResponseFormatSpec({ response_format: { type: 'json_schema', json_schema: { name: 'bad' } } }, 'chat'),
    null,
  );

  // Responses face uses text.format
  assert.equal(extractResponseFormatSpec({}, 'responses'), null);
  assert.equal(extractResponseFormatSpec({ text: { format: { type: 'text' } } }, 'responses'), null);
  assert.deepEqual(
    extractResponseFormatSpec({ text: { format: { type: 'json_object' } } }, 'responses'),
    { type: 'json_object' },
  );
  assert.deepEqual(
    extractResponseFormatSpec(
      { text: { format: { type: 'json_schema', name: 'resp_item', strict: false, schema } } },
      'responses',
    ),
    { type: 'json_schema', name: 'resp_item', strict: false, schema },
  );
  assert.equal(extractResponseFormatSpec({ text: { format: { type: 'json_schema' } } }, 'responses'), null);

  // Other faces ignore structured specs
  assert.equal(extractResponseFormatSpec({ response_format: { type: 'json_object' } }, 'messages'), null);
  assert.equal(extractResponseFormatSpec({ response_format: { type: 'json_object' } }, 'embeddings'), null);
});

test('structuredInstruction & prependStructuredInstruction never mutate input messages and preserve system turns', () => {
  const objSpec = { type: 'json_object' };
  const schemaSpec = {
    type: 'json_schema',
    name: 'out',
    strict: true,
    schema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
  };
  const objLine = structuredInstruction(objSpec);
  assert.ok(objLine.length > 0 && !objLine.includes('\n'));
  const schemaLine = structuredInstruction(schemaSpec);
  assert.ok(schemaLine.includes('"required":["a"]') && !schemaLine.includes('\n'));

  const noSys = [{ role: 'user', content: 'hi' }];
  const frozen = Object.freeze([Object.freeze({ role: 'user', content: 'hi' })]);
  const withSys = prependStructuredInstruction(frozen, objSpec);
  assert.equal(withSys.length, 2);
  assert.equal(withSys[0].role, 'system');
  assert.equal(withSys[0].content, objLine);
  assert.deepEqual(withSys[1], noSys[0]);
  assert.equal(frozen.length, 1);

  const existingSys = [
    Object.freeze({ role: 'system', content: 'Be terse.' }),
    Object.freeze({ role: 'user', content: 'hi' }),
  ];
  const merged = prependStructuredInstruction(existingSys, schemaSpec);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].role, 'system');
  assert.equal(merged[0].content, `${schemaLine}\n\nBe terse.`);
  assert.equal(existingSys[0].content, 'Be terse.');
});

test('healAndParseJson: parses valid JSON untouched and heals fences, trailing commas, and surrounding prose', () => {
  const clean = healAndParseJson('{"a": 1}');
  assert.deepEqual(clean, { ok: true, value: { a: 1 }, healed: false });

  const fenced = healAndParseJson('```json\n{"a": 1}\n```');
  assert.deepEqual(fenced, { ok: true, value: { a: 1 }, healed: true });

  const inlineFenced = healAndParseJson('Here you go: ```json {"a":1,}```');
  assert.deepEqual(inlineFenced, { ok: true, value: { a: 1 }, healed: true });

  const trailing = healAndParseJson('{"a":[1,2,], "b":{"c":3,},}');
  assert.deepEqual(trailing, { ok: true, value: { a: [1, 2], b: { c: 3 } }, healed: true });

  const prose = healAndParseJson('Sure! {"a": "hi } \\"quoted\\"", "b": 2} Hope this helps!');
  assert.deepEqual(prose, { ok: true, value: { a: 'hi } "quoted"', b: 2 }, healed: true });

  const trailingFence = healAndParseJson('{"a": 1}\n\nExample:\n```bash\necho hi\n```');
  assert.deepEqual(trailingFence, { ok: true, value: { a: 1 }, healed: true });
});

test('healAndParseJson: closes truncated structures ONLY after complete values and refuses incomplete cuts', () => {
  assert.deepEqual(healAndParseJson('{"a": "ok"'), { ok: true, value: { a: 'ok' }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": 1, "b": {"c": 2}'), { ok: true, value: { a: 1, b: { c: 2 } }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": 1, "b": [1, 2]'), { ok: true, value: { a: 1, b: [1, 2] }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": true'), { ok: true, value: { a: true }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": false'), { ok: true, value: { a: false }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": null'), { ok: true, value: { a: null }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": 1,'), { ok: true, value: { a: 1 }, healed: true });
  assert.deepEqual(healAndParseJson('{"a": 1 '), { ok: true, value: { a: 1 }, healed: true });
  assert.deepEqual(healAndParseJson('[1, "two",'), { ok: true, value: [1, 'two'], healed: true });

  const refusedInputs = [
    '',
    '   ',
    'not json at all',
    '{"a": 12',
    '{"a": 12.',
    '{"a": 1e',
    '{"a": 1e+',
    '{"a": -',
    '[1, 2',
    '{"a": tru',
    '{"a": fals',
    '{"a": nu',
    '{"a": "hello',
    '{"a"',
    '{"a":',
    '{',
    '[',
    '{"a": {',
    '{"a": [',
    '[1, , 2]',
    '{"a": 1,,}',
    '{"a": 01}',
  ];
  for (const raw of refusedInputs) {
    const res = healAndParseJson(raw);
    assert.equal(res.ok, false, `expected refusal for ${JSON.stringify(raw)}`);
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
  }
});

test('healAndParseJson: enforces maxChars size bound without scanning and never leaks model text in reason', () => {
  const huge = 'x'.repeat(MAX_STRUCTURED_CHARS + 10);
  const t0 = performance.now();
  const overDefault = healAndParseJson(huge);
  const elapsed = performance.now() - t0;
  assert.equal(overDefault.ok, false);
  assert.match(overDefault.reason, /exceeds maximum size/);
  assert.ok(elapsed < 50, `size check took ${elapsed}ms`);

  const overCustom = healAndParseJson('{"a": 12345}', { maxChars: 5 });
  assert.equal(overCustom.ok, false);
  assert.doesNotMatch(overCustom.reason, /12345/);

  const sentinel = 'SENTINEL_SECRET_MODEL_TEXT_999';
  for (const bad of [
    `prose with ${sentinel}`,
    `{"a": "${sentinel}`,
    `{"${sentinel}": }`,
    `{"a": ${sentinel}}`,
  ]) {
    const res = healAndParseJson(bad);
    assert.equal(res.ok, false);
    assert.ok(!res.reason.includes(sentinel), `reason leaked sentinel: ${res.reason}`);
  }
});

test('enforceStructuredOutput: validates json_object and json_schema via jsonschema.js without running ReDoS patterns or leaking values', () => {
  assert.deepEqual(
    enforceStructuredOutput('Here: ```json {"b": 2, "a": 1,}```', { type: 'json_object' }),
    { ok: true, text: '{"b":2,"a":1}', value: { b: 2, a: 1 }, healed: true },
  );
  const arr = enforceStructuredOutput('[1, 2]', { type: 'json_object' });
  assert.equal(arr.ok, false);
  assert.match(arr.reason, /object/i);

  const schemaSpec = {
    type: 'json_schema',
    name: 'record',
    strict: true,
    schema: {
      $defs: {
        role: { type: 'string', enum: ['SECRET_ROLE_ALPHA', 'SECRET_ROLE_BETA'] },
      },
      type: 'object',
      properties: {
        a: { type: 'integer', minimum: 1 },
        role: { $ref: '#/$defs/role' },
        tag: { const: 'SECRET_CONST_VALUE' },
        re: { type: 'string', pattern: '^(a+)+$' },
      },
      required: ['a'],
      additionalProperties: false,
    },
  };

  // Valid + ReDoS-safe pattern check finishes quickly
  const t0 = performance.now();
  const ok = enforceStructuredOutput(
    JSON.stringify({ a: 2, role: 'SECRET_ROLE_ALPHA', tag: 'SECRET_CONST_VALUE', re: 'a'.repeat(40) + '!' }),
    schemaSpec,
  );
  assert.ok(performance.now() - t0 < 50);
  assert.equal(ok.ok, true);
  assert.equal(ok.healed, false);

  // Missing required field
  const missing = enforceStructuredOutput('{"role": "SECRET_ROLE_ALPHA"}', schemaSpec);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /missing required property "a"/);

  // Enum / const / unexpected property must NOT leak schema enum/const values or model property names
  const badEnum = enforceStructuredOutput('{"a": 1, "role": "MODEL_WRITTEN_TEXT"}', schemaSpec);
  assert.equal(badEnum.ok, false);
  assert.ok(!badEnum.reason.includes('SECRET_ROLE_ALPHA'));
  assert.ok(!badEnum.reason.includes('MODEL_WRITTEN_TEXT'));

  const badConst = enforceStructuredOutput('{"a": 1, "tag": "MODEL_TAG_TEXT"}', schemaSpec);
  assert.equal(badConst.ok, false);
  assert.ok(!badConst.reason.includes('SECRET_CONST_VALUE'));
  assert.ok(!badConst.reason.includes('MODEL_TAG_TEXT'));

  const extraProp = enforceStructuredOutput('{"a": 1, "SECRET_MODEL_KEY": 9}', schemaSpec);
  assert.equal(extraProp.ok, false);
  assert.ok(!extraProp.reason.includes('SECRET_MODEL_KEY'));
});
