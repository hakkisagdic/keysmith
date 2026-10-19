/**
 * The JSON Schema subset (src/tools/jsonschema.js) that holds a model's tool call to the schema
 * the client sent: pydantic-shaped schemas, references that never end, and the 17 tools the
 * ucmdb platform offers a model in browser mode (test/fixtures/ucmdb-tools.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEREF_MAX_CHARS, deref, resolveRef, validate, validateCall } from '../src/tools/jsonschema.js';

const ok = (schema, value) => assert.deepEqual(validate(schema, value), { ok: true }, `${JSON.stringify(value)} should pass`);
const bad = (schema, value, re) => {
  const r = validate(schema, value, { path: 'arguments' });
  assert.equal(r.ok, false, `${JSON.stringify(value)} should fail`);
  if (re) assert.match(r.reason, re);
  return r.reason;
};

/** What pydantic v2 writes for a model with a nested model, an enum, `X | None` and lists of lists. */
const PYDANTIC = {
  $defs: {
    Severity: { enum: ['low', 'high'], title: 'Severity', type: 'string' },
    Target: {
      additionalProperties: false,
      properties: {
        kind: { $ref: '#/$defs/Severity', default: 'low' },
        ids: { items: { items: { type: 'integer' }, type: 'array' }, title: 'Ids', type: 'array' },
      },
      required: ['ids'],
      title: 'Target',
      type: 'object',
    },
  },
  additionalProperties: false,
  properties: {
    name: { maxLength: 5, minLength: 1, title: 'Name', type: 'string' },
    limit: { anyOf: [{ type: 'integer' }, { type: 'null' }], default: null, title: 'Limit' },
    ratio: { maximum: 1, minimum: 0, title: 'Ratio', type: 'number', default: 0.5 },
    target: { $ref: '#/$defs/Target', description: 'Where to look.' },
    targets: { anyOf: [{ items: { $ref: '#/$defs/Target' }, type: 'array' }, { type: 'null' }], default: null },
    code: { pattern: '^[A-Z]{3}-\\d+$', type: 'string' },
  },
  required: ['name', 'target'],
  title: 'Args',
  type: 'object',
};
const base = { name: 'abc', target: { ids: [] } };

test('pydantic-shaped schemas: $defs, anyOf with null, nested arrays, integer apart from number, enum', () => {
  ok(PYDANTIC, base);
  ok(PYDANTIC, { ...base, limit: null });
  ok(PYDANTIC, { ...base, limit: 3 });
  ok(PYDANTIC, { ...base, limit: 3.0 }, 'JSON 3.0 is the integer 3');
  bad(PYDANTIC, { ...base, limit: 2.5 }, /^arguments\.limit: expected integer or null, got number$/);
  bad(PYDANTIC, { ...base, limit: '3' }, /expected integer or null, got string/);
  ok(PYDANTIC, { ...base, ratio: 1 });
  ok(PYDANTIC, { ...base, ratio: 0.25 });
  bad(PYDANTIC, { ...base, ratio: 1.5 }, /arguments\.ratio: above the maximum 1/);
  bad(PYDANTIC, { ...base, ratio: -0.1 }, /below the minimum 0/);
  ok(PYDANTIC, { ...base, name: 'şşşşş' }, 'five characters, ten bytes');
  ok(PYDANTIC, { ...base, name: '😀😀😀😀😀' }, 'five characters, ten UTF-16 units');
  bad(PYDANTIC, { ...base, name: '😀😀😀😀😀😀' }, /longer than 5 characters/);
  bad(PYDANTIC, { ...base, name: '' }, /arguments\.name: shorter than 1 characters/);
  bad(PYDANTIC, { ...base, name: 'abcdef' }, /longer than 5 characters/);
  ok(PYDANTIC, { ...base, target: { kind: 'high', ids: [[1, 2], [3]] } });
  bad(PYDANTIC, { ...base, target: { kind: 'mid', ids: [] } }, /^arguments\.target\.kind: not one of the allowed values \("low", "high"\)$/);
  bad(PYDANTIC, { ...base, target: { ids: [[1, '2']] } }, /^arguments\.target\.ids\[0\]\[1\]: expected integer, got string$/);
  bad(PYDANTIC, { ...base, target: { ids: [[1.5]] } }, /expected integer, got number/);
  bad(PYDANTIC, { name: 'abc' }, /^arguments: missing required property "target"$/);
  bad(PYDANTIC, { ...base, foo: 1 }, /^arguments: unexpected property "foo"$/);
  bad(PYDANTIC, { ...base, target: { ids: [], extra: true } }, /arguments\.target: unexpected property "extra"/);
  ok(PYDANTIC, { ...base, code: 'ABC-12' });
  ok(PYDANTIC, { ...base, code: 'abc-12' }, 'a pattern is not run (the client checks it)');
  bad(PYDANTIC, { ...base, code: 12 }, /^arguments\.code: expected string, got integer$/);
  ok(PYDANTIC, { ...base, targets: [{ ids: [] }, { kind: 'low', ids: [[7]] }] });
  bad(PYDANTIC, { ...base, targets: [{ ids: 5 }] }, /^arguments\.targets\[0\]\.ids: expected array, got integer$/, 'the alternative of the right type says why');
  bad({ anyOf: [{ $ref: '#/$defs/X' }, { type: 'null' }], $defs: { X: { type: 'string', minLength: 3 } } }, 'ab', /^arguments: matches none of the alternatives \(shorter than 3 characters; expected null, got string\)$/);
  bad(PYDANTIC, [], /expected object, got array/);
});

test('a reason says where and what was wanted, never the value the call sent', () => {
  const secret = 'TOP-SECRET-VALUE-4711';
  for (const args of [
    { ...base, name: secret },
    { ...base, limit: secret },
    { ...base, target: { kind: secret, ids: [] } },
    { ...base, target: { ids: [[secret]] } },
    { ...base, code: 4711 },
    { ...base, ratio: 4711.5 },
  ]) {
    const reason = bad(PYDANTIC, args);
    assert.ok(!reason.includes('SECRET') && !reason.includes('4711'), reason);
  }
  // A property name that is not a name at all is not repeated either.
  const r = bad(PYDANTIC, { ...base, [`${secret} with spaces`]: 1 }, /unexpected property/);
  assert.ok(!r.includes('SECRET'), r);
});

test('the rest of the subset: type lists, const, oneOf, allOf, boolean schemas, items as a list, patternProperties', () => {
  ok({ type: ['string', 'null'] }, null);
  bad({ type: ['string', 'null'] }, 1, /expected string or null, got integer/);
  ok({ type: 'number' }, 2);
  bad({ type: 'integer' }, 1.5, /expected integer, got number/);
  bad({ type: 'number' }, '1', /expected number, got string/);
  ok({ type: 'boolean' }, false);
  bad({ type: 'object' }, null, /expected object, got null/);
  ok({ const: { a: [1, 2] } }, { a: [1, 2] });
  bad({ const: 'x' }, 'y', /must be "x"/);
  ok({ enum: [1, 'a', null, { k: 1 }] }, { k: 1 });
  ok({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 3);
  bad({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3, /more than one/);
  bad({ oneOf: [{ type: 'string' }, { type: 'boolean' }] }, 3, /expected string or boolean, got integer/);
  ok({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'ab');
  bad({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', /shorter than 2/);
  ok(true, 'anything');
  bad(false, 'anything', /no value is allowed/);
  ok({ type: 'object', properties: { a: false } }, {});
  bad({ type: 'object', properties: { a: false } }, { a: 1 }, /arguments\.a: no value is allowed/);
  ok({ type: 'array', items: [{ type: 'string' }, { type: 'integer' }] }, ['a', 1, 'anything after']);
  bad({ type: 'array', items: [{ type: 'string' }, { type: 'integer' }] }, [1], /arguments\[0\]: expected string/);
  ok({ prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ['a', 1, 2]);
  bad({ prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ['a', 1, 'b'], /arguments\[2\]: expected integer/);
  bad({ type: 'array', minItems: 1 }, [], /fewer than 1 items/);
  bad({ type: 'array', maxItems: 1 }, [1, 2], /more than 1 items/);
  bad({ exclusiveMinimum: 0 }, 0, /greater than 0/);
  bad({ exclusiveMaximum: 10 }, 10, /less than 10/);
  bad({ minimum: 0, exclusiveMinimum: true }, 0, /below the minimum/);
  // patternProperties: a named property is checked; an unnamed one is neither checked nor
  // additional, since whether it matches a pattern is not asked (no client regex is run).
  const pp = { type: 'object', properties: { id: { type: 'integer' } }, patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false };
  ok(pp, { id: 1, 'x-a': 'b', 'x-b': 1, y: 'b' });
  bad(pp, { id: 'one', 'x-a': 'b' }, /^arguments\.id: expected integer, got string$/);
  bad({ type: 'object', patternProperties: {}, additionalProperties: false }, { y: 1 }, /unexpected property "y"/);
  ok({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 1, b: 2 });
  bad({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 'x' }, /arguments\.a: expected integer/);
});

test('anyOf and oneOf on one schema: both are checked — an anyOf that fits does not answer for the oneOf next to it', () => {
  const s = { anyOf: [{ type: 'integer' }], oneOf: [{ minimum: 10 }, { maximum: 5 }] };
  bad(s, 7, /^arguments: matches none of the alternatives \(below the minimum 10; above the maximum 5\)$/);
  ok(s, 12);
  ok(s, 3);
  bad(s, 'x', /expected integer, got string/);
  bad({ anyOf: [{ type: 'string' }, { type: 'number' }], oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3, /more than one of the alternatives/);
  bad({ anyOf: [{ type: 'integer' }, { type: 'string' }], allOf: [{ minimum: 0 }] }, -1, /below the minimum 0/);
  // A call the client's own schema refuses is refused here too.
  const tools = [{ name: 'f', parameters: { type: 'object', properties: { n: s } } }];
  assert.match(validateCall(tools, { name: 'f', args: { n: 7 } }).reason, /^f\.arguments\.n: matches none of the alternatives/);
  assert.equal(validateCall(tools, { name: 'f', args: { n: 12 } }).ok, true);
});

test('a client\'s regular expression is never run in the gateway: pattern refuses nothing, and a backtracking one costs nothing', () => {
  ok({ type: 'string', pattern: '^a$' }, 'b');
  ok({ type: 'string', pattern: '([' }, 'an invalid one neither');
  const evil = 'a'.repeat(40) + '!'; // ^(a+)+$ against this backtracks for hours
  const tools = [{ name: 'f', parameters: { type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } }, required: ['q'] } }];
  let t0 = performance.now();
  assert.deepEqual(validateCall(tools, { name: 'f', args: { q: evil } }), { ok: true, args: { q: evil } });
  assert.ok(performance.now() - t0 < 200, `pattern: ${performance.now() - t0} ms`);
  // The key is written by the model: a pattern over keys is not run either.
  t0 = performance.now();
  ok({ type: 'object', patternProperties: { '^(a|aa)+$': { type: 'integer' } }, additionalProperties: false }, { [evil]: 'not an integer' });
  assert.ok(performance.now() - t0 < 200, `patternProperties: ${performance.now() - t0} ms`);
  // What the property is is still checked.
  assert.match(validateCall(tools, { name: 'f', args: { q: 40 } }).reason, /^f\.arguments\.q: expected string, got integer$/);
});

test('a keyword the subset does not know refuses nothing; OpenAPI nullable lets null through', () => {
  ok({ type: 'string', format: 'email', 'x-anything': true, contentEncoding: 'base64' }, 'not an email');
  ok({ type: 'string', pattern: '([' }, 'an invalid pattern is ignored, not thrown');
  ok({ type: 'thing' }, 42);
  ok({ $ref: 'https://example.com/schema.json' }, 42);
  ok({ $ref: '#/$defs/missing' }, 42);
  ok({ type: 'string', nullable: true }, null);
  bad({ type: 'string' }, null, /expected string, got null/);
});

/* ------------------------------------------------------------ references that never end */

test('a $ref that is its own definition ends, with a reason, instead of hanging', () => {
  bad({ $ref: '#' }, 1, /\$ref chain does not end/);
  bad({ $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } }, $ref: '#/$defs/A' }, {}, /does not end/);
  // An alternative that recurses without consuming data still lets the other one answer.
  const s = { $defs: { A: { anyOf: [{ $ref: '#/$defs/A' }, { type: 'string' }] } }, $ref: '#/$defs/A' };
  ok(s, 'leaf');
  bad(s, 1);
  // Alternatives that multiply: 2^32 paths, cut by the step budget.
  const t0 = Date.now();
  bad({ $defs: { A: { anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }] } }, $ref: '#/$defs/A' }, 1, /too complex|does not end/);
  assert.ok(Date.now() - t0 < 5_000, 'bounded');
});

test('a recursive schema still checks recursive data, and data nested past the limit is refused', () => {
  const tree = { $defs: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } }, required: ['name'], additionalProperties: false } }, $ref: '#/$defs/Node' };
  ok(tree, { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] });
  bad(tree, { name: 'a', children: [{ name: 'b', children: [{ name: 5 }] }] }, /children\[0\]\.children\[0\]\.name: expected string/);
  let deep = { name: 'leaf' };
  for (let i = 0; i < 80; i++) deep = { name: `n${i}`, children: [deep] };
  bad(tree, deep, /nested too deeply/);
  // Objects in objects, no arrays: the same limit.
  const nest = { type: 'object', additionalProperties: { $ref: '#' } };
  let objects = {};
  for (let i = 0; i < 20; i++) objects = { a: objects };
  ok(nest, objects);
  for (let i = 0; i < 80; i++) objects = { a: objects };
  bad(nest, objects, /nested too deeply/);
});

/* ------------------------------------------------------------------------------ deref */

test('deref writes every local $ref out, drops $defs, keeps the description at the use site, and leaves its input alone', () => {
  const before = JSON.stringify(PYDANTIC);
  const flat = deref(PYDANTIC);
  assert.equal(JSON.stringify(PYDANTIC), before, 'the input is not changed');
  assert.ok(!JSON.stringify(flat).includes('$ref'), 'no reference left');
  assert.equal(flat.$defs, undefined);
  assert.deepEqual(flat.properties.target, {
    additionalProperties: false,
    properties: { kind: { enum: ['low', 'high'], title: 'Severity', type: 'string', default: 'low' }, ids: PYDANTIC.$defs.Target.properties.ids },
    required: ['ids'],
    title: 'Target',
    type: 'object',
    description: 'Where to look.',
  });
  const { description: _useSite, ...targetDef } = flat.properties.target;
  assert.deepEqual(flat.properties.targets.anyOf[0].items, targetDef, 'the same definition, written out where it is used');
  // The flat schema accepts and refuses what the original does.
  for (const v of [base, { ...base, limit: 2.5 }, { ...base, target: { kind: 'mid', ids: [] } }, { ...base, targets: [{ ids: [['x']] }] }, { name: 'abc' }]) {
    assert.equal(validate(flat, v).ok, validate(PYDANTIC, v).ok, JSON.stringify(v));
  }
});

test('deref of a schema that refers back into itself ends: the point of return is written as any value', () => {
  const tree = { $defs: { Node: { type: 'object', description: 'A node', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node', description: 'a child' } } } } }, $ref: '#/$defs/Node' };
  const flat = deref(tree);
  assert.equal(flat.description, 'A node');
  assert.deepEqual(flat.properties.children.items, { description: 'a child' }, 'one level written out, then any value');
  assert.deepEqual(deref({ $ref: '#' }), {});
  assert.deepEqual(deref({ $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } }, $ref: '#/$defs/A' }), {});
  // Alternatives that multiply stop at the node budget.
  const blowup = { $defs: {}, $ref: '#/$defs/L0' };
  for (let i = 0; i < 30; i++) blowup.$defs[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/$defs/L${i + 1}` }, b: { $ref: `#/$defs/L${i + 1}` } } };
  blowup.$defs.L30 = { type: 'string' };
  const t0 = Date.now();
  const out = deref(blowup, { maxNodes: 5_000 });
  assert.ok(Date.now() - t0 < 5_000);
  assert.ok(JSON.stringify(out).length < 2_000_000);
  assert.ok(!JSON.stringify(out).includes('$ref'));
});

/** Every `$ref` string under a `$ref` key in `v` (data keywords included: a test wants to see them all). */
function refsIn(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === 'object') {
    if (typeof v.$ref === 'string') out.push(v.$ref);
    Object.values(v).forEach((x) => refsIn(x, out));
  }
  return out;
}

test('deref walks every keyword that holds a schema — dependencies, contentSchema — so no reference is left pointing at the $defs it dropped', () => {
  const owner = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  const deps = { type: 'object', properties: { pet: { type: 'string' } }, dependencies: { pet: { properties: { owner: { $ref: '#/$defs/Owner' } } }, name: ['pet'] }, $defs: { Owner: owner } };
  const flat = deref(deps);
  const text = JSON.stringify(flat);
  assert.ok(!text.includes('#/$defs/') && !text.includes('#/definitions/'), text);
  assert.equal(flat.$defs, undefined);
  assert.deepEqual(flat.dependencies, { pet: { properties: { owner } }, name: ['pet'] }, 'a schema is written out, a list of names stays a list');
  const content = { type: 'string', contentMediaType: 'application/json', contentSchema: { $ref: '#/definitions/Doc' }, definitions: { Doc: owner } };
  const flatContent = deref(content);
  assert.deepEqual(flatContent, { type: 'string', contentMediaType: 'application/json', contentSchema: owner });
  assert.ok(!JSON.stringify(flatContent).includes('#/definitions/'));
  // Every keyword that holds a schema, at once.
  const every = { $defs: { S: { type: 'string' } } };
  const r = { $ref: '#/$defs/S' };
  Object.assign(every, { properties: { a: r }, patternProperties: { '^x': r }, dependentSchemas: { a: r }, dependencies: { a: r }, anyOf: [r], oneOf: [r], allOf: [r], prefixItems: [r], items: r, additionalProperties: r, additionalItems: r, contains: r, not: r, if: r, then: r, else: r, propertyNames: r, unevaluatedProperties: r, unevaluatedItems: r, contentSchema: r });
  assert.deepEqual(refsIn(deref(every)), []);
  assert.deepEqual(refsIn(deref({ items: [r, r], $defs: every.$defs })), []);
});

test('a $ref deref cannot write out (inside an extension keyword) keeps the $defs it points into, so it still resolves; a $ref in data is data', () => {
  const s = { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, 'x-shape': { kind: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'integer' } } };
  const flat = deref(s);
  assert.deepEqual(flat.properties.a, { type: 'integer' }, 'what deref knows is still written out');
  assert.deepEqual(flat['x-shape'], s['x-shape']);
  for (const ref of refsIn(flat)) assert.notEqual(resolveRef(flat, ref), undefined, `${ref} resolves in the result`);
  assert.deepEqual(flat.$defs, s.$defs);
  // A $ref key inside const/enum/default/examples is a value: nothing is kept for it.
  const data = { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, default: { $ref: '#/$defs/A' }, examples: [{ $ref: '#/$defs/A' }], $defs: { A: { type: 'integer' } } };
  assert.equal(deref(data).$defs, undefined);
});

test('deref is bounded in size: refs that fan out throw ERR_SCHEMA_TOO_LARGE at the cap instead of building the whole expansion', () => {
  // 11 KB of schema: ten properties, each a $ref to ten properties, … four levels down to a
  // 10,000-character description — 90 MB written out in full.
  const level = (next) => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { $ref: `#/$defs/${next}` }])) });
  const fan = { ...level('a'), $defs: { a: level('b'), b: level('c'), c: level('leaf'), leaf: { type: 'string', description: 'x'.repeat(10_000) } } };
  assert.ok(JSON.stringify(fan).length < 12_000);
  const heap = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  assert.throws(() => deref(fan), (e) => e instanceof RangeError && e.code === 'ERR_SCHEMA_TOO_LARGE' && /larger than 262144 characters/.test(e.message));
  assert.ok(performance.now() - t0 < 1_000, `${performance.now() - t0} ms`);
  assert.ok(process.memoryUsage().heapUsed - heap < 20e6, 'nothing near the full expansion was built');
  assert.equal(DEREF_MAX_CHARS, 256 * 1024);
  // The same shape with a short leaf fits: written out, and under the cap.
  const small = { ...level('a'), $defs: { a: level('b'), b: level('leaf'), leaf: { type: 'string', description: 'x' } } };
  const out = deref(small);
  assert.ok(JSON.stringify(out).length <= DEREF_MAX_CHARS);
  assert.deepEqual(out.properties.p9.properties.p0.properties.p3, { type: 'string', description: 'x' });
  // The cap is on the result, whatever made it large; a caller may set its own.
  assert.throws(() => deref({ type: 'string', description: 'x'.repeat(DEREF_MAX_CHARS) }), { code: 'ERR_SCHEMA_TOO_LARGE' });
  assert.throws(() => deref(PYDANTIC, { maxChars: 200 }), { code: 'ERR_SCHEMA_TOO_LARGE' });
  const exact = JSON.stringify(deref(PYDANTIC)).length;
  assert.equal(JSON.stringify(deref(PYDANTIC, { maxChars: exact })).length, exact, 'a result exactly at the cap is returned');
  assert.throws(() => deref(PYDANTIC, { maxChars: exact - 1 }), { code: 'ERR_SCHEMA_TOO_LARGE' });
});

test('deref reads keywords as keywords: a property called "$ref" or "$defs" is a property', () => {
  const s = { type: 'object', properties: { $ref: { type: 'string' }, $defs: { type: 'integer' } }, default: { $ref: '#/not/a/reference' }, enum: [{ $ref: 'data' }] };
  const flat = deref(s);
  assert.deepEqual(flat, s);
  ok({ type: 'object', properties: s.properties }, { $ref: 'x', $defs: 1 });
  bad({ type: 'object', properties: s.properties }, { $ref: 1 }, /arguments\[\"\$ref\"\]|arguments\.\$ref: expected string/);
  assert.equal(resolveRef({ a: 1 }, '#/__proto__'), undefined);
  assert.equal(resolveRef({ 'a/b': { '~c': 2 } }, '#/a~1b/~0c'), 2);
});

/* ------------------------------------------------------------------------- validateCall */

test('validateCall: an unknown tool, arguments that are not JSON or not an object, and reasons of at most 200 characters', () => {
  const tools = [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }, { name: 'now', parameters: { type: 'object', properties: {} } }];
  assert.deepEqual(validateCall(tools, { name: 'get_weather', args: { city: 'Ankara' } }), { ok: true, args: { city: 'Ankara' } });
  assert.deepEqual(validateCall(tools, { name: 'get_weather', arguments: '{"city":"Ankara"}' }), { ok: true, args: { city: 'Ankara' } });
  assert.deepEqual(validateCall(tools, { name: 'now' }), { ok: true, args: {} });
  assert.deepEqual(validateCall(tools, { name: 'now', arguments: '' }), { ok: true, args: {} });
  assert.match(validateCall(tools, { name: 'get_wether', args: {} }).reason, /^unknown tool "get_wether"; the tools are: get_weather, now$/);
  assert.match(validateCall(tools, { args: {} }).reason, /names no tool/);
  assert.match(validateCall(tools, { name: 'get_weather', arguments: '{city:' }).reason, /arguments are not valid JSON/);
  assert.match(validateCall(tools, { name: 'get_weather', args: ['Ankara'] }).reason, /must be a JSON object, got array/);
  assert.match(validateCall(tools, { name: 'get_weather', args: null }).reason, /got null/);
  assert.match(validateCall(tools, { name: 'get_weather', args: {} }).reason, /^get_weather\.arguments: missing required property "city"$/);
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `tool_number_${i}`, parameters: {} }));
  for (const r of [validateCall(many, { name: 'nope', args: {} }), validateCall([{ name: 't', parameters: { enum: Array.from({ length: 300 }, (_, i) => `value-${i}`) } }], { name: 't', args: {} })]) {
    assert.equal(r.ok, false);
    assert.ok(r.reason.length <= 200, `${r.reason.length}: ${r.reason}`);
  }
});

/* ---------------------------------------------------------------- the 17 ucmdb tools */

const UCMDB = JSON.parse(fs.readFileSync(new URL('./fixtures/ucmdb-tools.json', import.meta.url), 'utf8')).tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));

/** A value the property schema accepts: the first enum value, the first non-null alternative, a sample of its type. */
function sample(s) {
  if (Array.isArray(s.enum)) return s.enum[0];
  if (Array.isArray(s.anyOf)) return sample(s.anyOf.find((b) => b.type !== 'null') ?? s.anyOf[0]);
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  return { string: 'vm-prd-0042', integer: 3, number: 1.5, boolean: true, array: [], object: {}, null: null }[t] ?? 'x';
}

test('the 17 ucmdb tools: every schema derefs, and valid and invalid arguments are told apart', () => {
  assert.equal(UCMDB.length, 17);
  for (const tool of UCMDB) {
    const flat = deref(tool.parameters);
    assert.ok(!JSON.stringify(flat).includes('"$ref"'), `${tool.name}: no reference left`);
    assert.deepEqual(flat, tool.parameters, `${tool.name}: a schema without references derefs to itself`);
    const props = tool.parameters.properties || {};
    const required = tool.parameters.required || [];
    const minimal = Object.fromEntries(required.map((p) => [p, sample(props[p])]));
    const full = Object.fromEntries(Object.entries(props).map(([p, s]) => [p, sample(s)]));
    assert.deepEqual(validateCall(UCMDB, { name: tool.name, args: minimal }), { ok: true, args: minimal }, `${tool.name} minimal`);
    assert.equal(validateCall(UCMDB, { name: tool.name, arguments: JSON.stringify(full) }).ok, true, `${tool.name} every property`);
    for (const p of required) {
      const { [p]: _dropped, ...rest } = minimal;
      assert.match(validateCall(UCMDB, { name: tool.name, args: rest }).reason, new RegExp(`missing required property "${p}"`), `${tool.name} without ${p}`);
    }
    assert.match(validateCall(UCMDB, { name: tool.name, args: { ...minimal, not_a_parameter: 1 } }).reason, /unexpected property "not_a_parameter"/, tool.name);
    for (const [p, s] of Object.entries(props)) {
      const wrong = [{}, [], 'text', 7, true].find((v) => !validate(s, v).ok);
      assert.notEqual(wrong, undefined, `${tool.name}.${p} refuses something`);
      const r = validateCall(UCMDB, { name: tool.name, args: { ...minimal, [p]: wrong } });
      assert.equal(r.ok, false, `${tool.name}.${p} = ${JSON.stringify(wrong)}`);
      assert.ok(r.reason.startsWith(`${tool.name}.arguments.${p}: `), r.reason);
    }
  }
});

test('the ucmdb tools, by hand: the calls a model actually gets wrong', () => {
  const v = (name, args) => validateCall(UCMDB, { name, args });
  assert.equal(v('ucmdb_search_cis', { query: 'payment-api' }).ok, true);
  assert.equal(v('ucmdb_search_cis', { query: 'payment-api', ci_type: null, limit: 10, fuzzy: false }).ok, true);
  assert.match(v('ucmdb_search_cis', { query: 'payment-api', limit: 2.5 }).reason, /limit: expected integer, got number/);
  assert.match(v('ucmdb_search_cis', { query: 'payment-api', ci_type: 5 }).reason, /ci_type: expected string or null, got integer/);
  assert.match(v('ucmdb_search_cis', { ci_type: 'node' }).reason, /missing required property "query"/);
  assert.match(v('ucmdb_search', { query: 'x' }).reason, /^unknown tool "ucmdb_search"; the tools are: ucmdb_search_cis, /);
  assert.equal(v('ucmdb_get_related_cis', { ci_id: 'vm-prd-0042', direction: 'in', relation_types: ['dependency'] }).ok, true);
  assert.equal(v('ucmdb_get_related_cis', { ci_id: 'vm-prd-0042', relation_types: null }).ok, true);
  assert.match(v('ucmdb_get_related_cis', { ci_id: 'vm-prd-0042', direction: 'sideways' }).reason, /direction: not one of the allowed values \("both", "out", "in"\)/);
  assert.match(v('ucmdb_get_related_cis', { ci_id: 'vm-prd-0042', relation_types: 'dependency' }).reason, /relation_types: expected array or null, got string/);
  assert.equal(v('ucmdb_impact_analysis', { trigger_ci_ids: ['vm-prd-0042'], severity: 9, max_depth: null }).ok, true);
  assert.match(v('ucmdb_impact_analysis', { trigger_ci_ids: 'vm-prd-0042' }).reason, /trigger_ci_ids: expected array, got string/);
  assert.match(v('ucmdb_impact_analysis', { trigger_ci_ids: ['vm-prd-0042'], max_depth: '3' }).reason, /max_depth: expected integer or null, got string/);
  assert.equal(v('ucmdb_list_agents', {}).ok, true);
  assert.match(v('ucmdb_list_agents', { verbose: true }).reason, /unexpected property "verbose"/);
  assert.equal(v('ucmdb_request_approval', { action_summary: 'Retire vm-prd-0042.', about_ci: 'vm-prd-0042' }).ok, true);
  assert.match(v('ucmdb_request_approval', {}).reason, /missing required property "action_summary"/);
});
