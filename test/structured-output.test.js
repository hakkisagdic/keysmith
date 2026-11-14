import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { healAndParseJson, validateJsonSchema, enforceStructuredOutput } from '../src/structured-output.js';

test('P2-4: healAndParseJson and validateJsonSchema heal markdown fences, trailing commas, and validate schema rules', () => {
  const fenced = 'Here is the JSON you requested:\n```json\n{\n  "invoice_id": "INV-101",\n  "amount": 1490.5,\n  "items": ["pro_plan",],\n}\n```\nHope this helps!';
  const healed = healAndParseJson(fenced);
  assert.equal(healed.ok, true);
  assert.equal(healed.healed, true);
  assert.deepEqual(healed.value, {
    invoice_id: 'INV-101',
    amount: 1490.5,
    items: ['pro_plan'],
  });

  const schema = {
    type: 'object',
    required: ['invoice_id', 'amount', 'items'],
    additionalProperties: false,
    properties: {
      invoice_id: { type: 'string', minLength: 3 },
      amount: { type: 'number', minimum: 0 },
      items: { type: 'array', items: { type: 'string' } },
    },
  };

  const vOk = validateJsonSchema(healed.value, schema);
  assert.equal(vOk.valid, true);

  const vBad = validateJsonSchema({ invoice_id: 'INV-101', amount: -5, extra: true }, schema);
  assert.equal(vBad.valid, false);
  assert.equal(vBad.errors.length, 3); // missing items, amount < 0, unexpected extra

  assert.throws(
    () =>
      enforceStructuredOutput(JSON.stringify({ invoice_id: 'INV-101' }), {
        type: 'json_schema',
        name: 'invoice',
        schema,
        strict: true,
      }),
    (err) => err.status === 422 && err.code === 'schema_validation_failed',
  );
});

test('P2-4: Server enforces response_format json_object and json_schema across /v1/chat/completions and /v1/responses', async () => {
  let nextReply = '';
  const mockAdapter = {
    id: 'mock',
    kind: 'cli',
    priority: 100,
    models: () => [{ id: 'mock/m1', owned_by: 'mock' }],
    async *complete() {
      yield { type: 'delta', text: nextReply };
      yield { type: 'usage', usage: { input: 20, output: 15 } };
      yield { type: 'done' };
    },
  };

  const cfg = {
    auth: { enabled: false },
    adapters: { mock: { kind: 'cli', bin: 'echo' } },
    aliases: {},
  };
  const gw = new Gateway(cfg);
  gw.adapters.set('mock', mockAdapter);
  const server = createServer(gw, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const orderSchema = {
    type: 'object',
    required: ['customer', 'total_try', 'status'],
    additionalProperties: false,
    properties: {
      customer: { type: 'string' },
      total_try: { type: 'number', minimum: 1 },
      status: { type: 'string', enum: ['paid', 'pending'] },
    },
  };

  try {
    // 1. Heals markdown-fenced JSON and validates against json_schema -> 200 OK with X-Keysmith-Schema-Validated: healed
    nextReply = 'Elbette, işte sonuç:\n```json\n{"customer": "Acme A.Ş.", "total_try": 1788, "status": "paid",}\n```';
    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/m1',
        messages: [{ role: 'user', content: 'Sipariş özetini çıkar' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'order_summary',
            strict: true,
            schema: orderSchema,
          },
        },
      }),
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-keysmith-schema-validated'), 'healed');
    const body1 = await res1.json();
    assert.deepEqual(JSON.parse(body1.choices[0].message.content), {
      customer: 'Acme A.Ş.',
      total_try: 1788,
      status: 'paid',
    });

    // 2. Schema violation returns 422 Unprocessable Entity (code: schema_validation_failed)
    nextReply = '{"customer": "Acme A.Ş.", "total_try": -10, "status": "cancelled"}';
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/m1',
        messages: [{ role: 'user', content: 'Sipariş özetini çıkar' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'order_summary',
            strict: true,
            schema: orderSchema,
          },
        },
      }),
    });
    assert.equal(res2.status, 422);
    const body2 = await res2.json();
    assert.equal(body2.error.code, 'schema_validation_failed');
    assert.match(body2.error.message, /total_try|status/);

    // 3. /v1/responses supports text.format json_object healing
    nextReply = 'Result: {"ok": true, "region": "TR"}';
    const res3 = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/m1',
        input: 'Check status',
        text: { format: { type: 'json_object' } },
      }),
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('x-keysmith-schema-validated'), 'healed');
    const body3 = await res3.json();
    assert.deepEqual(JSON.parse(body3.output[0].content[0].text), { ok: true, region: 'TR' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
