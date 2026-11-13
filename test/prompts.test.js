import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { PromptRegistry, extractTemplateVariables, interpolateTemplate } from '../src/prompts.js';

function fakeAdapter(id = 'echo') {
  return {
    id,
    kind: 'cli',
    priority: 100,
    models: () => [{ id: `${id}/m1`, owned_by: id }],
    async *complete({ messages }) {
      const combined = messages.map((m) => `${m.role}:${m.content}`).join(' | ');
      yield { type: 'delta', text: combined };
      yield { type: 'usage', usage: { input: 12, output: 8 } };
      yield { type: 'done' };
    },
  };
}

test('P2-1: PromptRegistry extracts variables, increments versions, and persists to promptsFile', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-prompts-'));
  const promptsFile = path.join(tmpDir, 'prompts.json');

  try {
    assert.deepEqual(
      extractTemplateVariables('System for {{company}}', 'Hello {{customer_name}}, order {{order.id}} ({{customer_name}})'),
      ['company', 'customer_name', 'order.id'],
    );
    assert.equal(
      interpolateTemplate('Merhaba {{name}}, sipariş #{{order_id}} hazır.', { name: 'Ayşe', order_id: 42 }),
      'Merhaba Ayşe, sipariş #42 hazır.',
    );

    const reg = new PromptRegistry(
      {
        prompts: {
          'welcome-tr': {
            system: 'Sen {{brand}} müşteri temsilcisisin.',
            template: 'Merhaba {{user}}, nasıl yardımcı olabilirim?',
            model: 'echo/m1',
          },
        },
      },
      { promptsFile, now: () => 1763035200000 },
    );

    const v1 = reg.get('welcome-tr');
    assert.equal(v1.version, 1);
    assert.equal(v1.latestVersion, 1);
    assert.deepEqual(v1.variables, ['brand', 'user']);

    const v2 = reg.upsert({
      id: 'welcome-tr',
      system: 'Sen {{brand}} kıdemli destek uzmanısın.',
      template: 'Selam {{user}}, bilet numaran: {{ticket_id}}.',
      model: 'echo/m1',
    });
    assert.equal(v2.version, 2);
    assert.equal(v2.latestVersion, 2);
    assert.deepEqual(v2.variables, ['brand', 'user', 'ticket_id']);

    // Pinning v1 still returns version 1
    const pinnedV1 = reg.get('welcome-tr', 1);
    assert.equal(pinnedV1.version, 1);
    assert.deepEqual(pinnedV1.variables, ['brand', 'user']);

    // Reload from persisted promptsFile
    const reg2 = new PromptRegistry({}, { promptsFile });
    assert.equal(reg2.get('welcome-tr').version, 2);
    assert.equal(reg2.get('welcome-tr', 1).version, 1);

    assert.equal(reg2.delete('welcome-tr'), true);
    assert.equal(reg2.get('welcome-tr'), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P2-1: Prompt management API and template interpolation across /v1/chat/completions, /v1/messages, and /v1/responses', async () => {
  const cfg = {
    auth: {
      enabled: true,
      keys: [
        'ks_admin_key_123456',
        { key: 'ks_scoped_key_123456', label: 'scoped-worker', allow: ['echo'] },
      ],
    },
    adapters: {
      echo: { kind: 'cli', bin: 'echo' },
    },
    aliases: {},
    prompts: {
      'support-tr': {
        system: 'Şirket: {{company}}.',
        template: 'Müşteri: {{customer}} — Konu: {{topic}}',
        model: 'echo/m1',
      },
    },
  };

  const gw = new Gateway(cfg);
  gw.adapters.set('echo', fakeAdapter('echo'));
  const server = createServer(gw, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminHeaders = {
    Authorization: 'Bearer ks_admin_key_123456',
    'Content-Type': 'application/json',
  };
  const scopedHeaders = {
    Authorization: 'Bearer ks_scoped_key_123456',
    'Content-Type': 'application/json',
  };

  try {
    // 1. GET /v1/keysmith/prompts lists initial prompt
    const listRes = await fetch(`${base}/v1/keysmith/prompts`, { headers: adminHeaders });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].id, 'support-tr');
    assert.equal(listBody.data[0].version, 1);

    // 2. Scoped key cannot POST new prompt version (403)
    const forbiddenPost = await fetch(`${base}/v1/keysmith/prompts`, {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({ id: 'support-tr', template: 'hack' }),
    });
    assert.equal(forbiddenPost.status, 403);

    // 3. Admin POSTs an updated version (v2) of support-tr
    const updateRes = await fetch(`${base}/v1/keysmith/prompts`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        id: 'support-tr',
        system: 'Kurum: {{company}} (v2).',
        template: 'Sayın {{customer}}, {{topic}} talebiniz alındı.',
        model: 'echo/m1',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.version, 2);
    assert.equal(updateBody.latestVersion, 2);

    // 4. GET /v1/keysmith/prompts/support-tr?version=1 returns v1
    const getV1 = await fetch(`${base}/v1/keysmith/prompts/support-tr?version=1`, { headers: adminHeaders });
    assert.equal(getV1.status, 200);
    const v1Data = await getV1.json();
    assert.equal(v1Data.version, 1);
    assert.match(v1Data.system, /Şirket:/);

    // 5. /v1/chat/completions uses latest v2 when prompt_version is omitted, and inherits model
    const chatRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        prompt_id: 'support-tr',
        prompt_variables: {
          company: 'Keysmith TR',
          customer: 'Deniz',
          topic: 'Fatura İadesi',
        },
      }),
    });
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.headers.get('x-keysmith-prompt'), 'support-tr@v2');
    const chatBody = await chatRes.json();
    assert.match(chatBody.choices[0].message.content, /system:Kurum: Keysmith TR \(v2\)\./);
    assert.match(chatBody.choices[0].message.content, /user:Sayın Deniz, Fatura İadesi talebiniz alındı\./);

    // 6. /v1/messages with pinned prompt_version: 1
    const anthRes = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        max_tokens: 128,
        prompt_id: 'support-tr',
        prompt_version: 1,
        prompt_variables: {
          company: 'Keysmith TR',
          customer: 'Deniz',
          topic: 'Fatura İadesi',
        },
      }),
    });
    assert.equal(anthRes.status, 200);
    assert.equal(anthRes.headers.get('x-keysmith-prompt'), 'support-tr@v1');
    const anthBody = await anthRes.json();
    assert.match(anthBody.content[0].text, /system:Şirket: Keysmith TR\./);
    assert.match(anthBody.content[0].text, /user:Müşteri: Deniz — Konu: Fatura İadesi/);

    // 7. /v1/responses with metadata.prompt_id and metadata.prompt_variables
    const respRes = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        metadata: {
          prompt_id: 'support-tr',
          prompt_variables: {
            company: 'Acme',
            customer: 'Bora',
            topic: 'API Anahtarı',
          },
        },
      }),
    });
    assert.equal(respRes.status, 200);
    assert.equal(respRes.headers.get('x-keysmith-prompt'), 'support-tr@v2');
    const respBody = await respRes.json();
    assert.match(respBody.output[0].content[0].text, /system:Kurum: Acme \(v2\)\./);
    assert.match(respBody.output[0].content[0].text, /user:Sayın Bora, API Anahtarı talebiniz alındı\./);

    // 8. Missing required variable returns 400 Bad Request with code: "missing_prompt_variable"
    const missingRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: scopedHeaders,
      body: JSON.stringify({
        prompt_id: 'support-tr',
        prompt_variables: {
          company: 'Keysmith TR',
          customer: 'Deniz',
        },
      }),
    });
    assert.equal(missingRes.status, 400);
    const missingBody = await missingRes.json();
    assert.equal(missingBody.error.code, 'missing_prompt_variable');
    assert.match(missingBody.error.message, /topic/);

    // 9. DELETE /v1/keysmith/prompts/:id removes template
    const delRes = await fetch(`${base}/v1/keysmith/prompts/support-tr`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert.equal(delRes.status, 200);

    const afterDelRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        prompt_id: 'support-tr',
        prompt_variables: { company: 'A', customer: 'B', topic: 'C' },
      }),
    });
    assert.equal(afterDelRes.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
