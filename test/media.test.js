/**
 * Media a request carries, for a CLI that takes it (`media`, `vision: true`; Claude Code's
 * profile), and the reading of one item. HTTP upstreams and URL fetching: media-http.test.js.
 *
 * The stub CLI reads its stdin (the stream-json user message a media run writes there) and
 * answers, in claude-stream-json, with what it got: its argv and one line per content block.
 * No CLI, no model, no network: this gateway does not fetch URLs (`fetchMedia: false`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { CLI_PROFILES } from '../src/profiles.js';
import { CliAdapter, autoApproveFlag } from '../src/cli-adapter.js';
import { openaiMessages, anthropicMessages, responsesMessages } from '../src/protocols.js';
import { flattenMessages } from '../src/util.js';
import { readPart, mediaPrompt, sniffMedia, MEDIA_LIMITS } from '../src/media.js';

const KEY = 'ks_test_000000000000000000000000';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// A real 1×1 PNG, and bytes that open the way a JPEG does (keysmith reads the signature, not the picture).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG, 'base64').length;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n').toString('base64');
const PDF_BYTES = Buffer.from(PDF, 'base64').length;
const WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(32)]).toString('base64');

const STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const out = { argv };
  const lines = input.split('\\n').filter((l) => l.trim());
  if (lines.length) {
    const msg = JSON.parse(lines[0]);
    out.lines = lines.length;
    out.type = msg.type;
    out.role = msg.message.role;
    out.blocks = msg.message.content.map((b) => (b.source ? b.type + ' ' + b.source.type + ' ' + b.source.media_type + ' ' + Buffer.from(b.source.data, 'base64').length + (b.title ? ' ' + b.title : '') : 'text ' + b.text));
  }
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: JSON.stringify(out) }] } });
  line({ type: 'result', subtype: 'success', is_error: false, session_id: 'up_1', usage: { input_tokens: 5, output_tokens: 3 } });
});
`;

let dir, server, base;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-images-'));
  const bin = path.join(dir, 'seer');
  fs.writeFileSync(bin, STUB, { mode: 0o755 });
  const common = { kind: 'cli', bin, args: ['-p', ['--model', '{model}'], '{prompt}'], parser: 'claude-stream-json', models: ['m'], timeoutMs: 15_000 };
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: true, keys: [KEY] },
    log: { usage: true, body: false },
    limits: { maxConcurrent: 2, timeoutMs: 20_000 },
    tunnel: { provider: 'cloudflared' },
    adapters: {
      seer: { ...common, vision: true, visionArgs: ['-p', '--input-format', 'stream-json', ['--model', '{model}']] },
      reader: { ...common, media: ['image', 'pdf'], visionArgs: ['-p', '--input-format', 'stream-json'] },
      one: { ...common, vision: true, visionArgs: ['-p', '--input-format', 'stream-json'], maxImages: 1, maxImageBytes: 128 },
      blind: common,
    },
    aliases: {},
    fetchMedia: false,
  };
  server = createServer(new Gateway(cfg, { log: () => {} }), cfg, { usage: new UsageLog(path.join(dir, 'usage.jsonl')), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

/** What the stub saw, from an answer on any face. */
function seen(route, text) {
  const body = JSON.parse(text);
  const answer = route === '/v1/messages' ? body.content[0].text : route === '/v1/responses' ? body.output_text : body.choices[0].message.content;
  return JSON.parse(answer);
}

/* ------------------------------------------------------------------- end to end */

test('/v1/chat/completions: a data: URL image reaches a vision CLI as a base64 block, in its place between the text, on stdin', async () => {
  const { status, text } = await post('/v1/chat/completions', {
    model: 'seer/m',
    messages: [
      { role: 'system', content: 'Be exact.' },
      { role: 'user', content: [{ type: 'text', text: 'Transcribe:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'high' } }, { type: 'text', text: 'the first line only' }] },
    ],
  });
  assert.equal(status, 200, text);
  const s = seen('/v1/chat/completions', text);
  assert.deepEqual(s.argv, ['-p', '--input-format', 'stream-json', '--model', 'm'], 'visionArgs, with no prompt in the argv');
  assert.equal(s.lines, 1, 'one user message, one turn');
  assert.equal(s.type, 'user');
  assert.equal(s.role, 'user');
  assert.deepEqual(s.blocks, ['text <system>\nBe exact.\n</system>\n\nUser: Transcribe:\n', `image base64 image/png ${PNG_BYTES}`, 'text \nthe first line only']);
});

test('/v1/messages: a base64 source reaches a vision CLI, its media type read off the bytes', async () => {
  const { status, text } = await post('/v1/messages', {
    model: 'seer/m',
    max_tokens: 100,
    system: 'Be exact.',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: JPEG } }, { type: 'text', text: 'read it' }] }],
  });
  assert.equal(status, 200, text);
  const s = seen('/v1/messages', text);
  assert.deepEqual(s.blocks, ['text <system>\nBe exact.\n</system>\n\nUser: ', 'image base64 image/jpeg 64', 'text \nread it'], 'declared png, sent as what it is');
});

test('/v1/responses: an input_image reaches a vision CLI too', async () => {
  const { status, text } = await post('/v1/responses', {
    model: 'seer/m',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] }],
  });
  assert.equal(status, 200, text);
  assert.deepEqual(seen('/v1/responses', text).blocks, ['text User: what is this\n', `image base64 image/png ${PNG_BYTES}`]);
});

test('/v1/messages: a PDF document reaches a CLI that takes PDFs as a document block, its title kept', async () => {
  const { status, text } = await post('/v1/messages', {
    model: 'reader/m',
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize' }, { type: 'document', title: 'scan.pdf', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }] }],
  });
  assert.equal(status, 200, text);
  assert.deepEqual(seen('/v1/messages', text).blocks, ['text User: Summarize\n', `document base64 application/pdf ${PDF_BYTES} scan.pdf`]);
});

test('/v1/chat/completions: a file part holding a PDF, beside an image, reaches the CLI in order', async () => {
  const { status, text } = await post('/v1/chat/completions', {
    model: 'reader/m',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }, { type: 'text', text: 'and' }, { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${PDF}` } }] }],
  });
  assert.equal(status, 200, text);
  assert.deepEqual(seen('/v1/chat/completions', text).blocks, ['text User: ', `image base64 image/png ${PNG_BYTES}`, 'text \nand\n', `document base64 application/pdf ${PDF_BYTES} a.pdf`]);
});

test('media a CLI does not take reads as its label, and a run with none it takes is a text run (args, prompt in the argv)', async () => {
  for (const [model, content, label] of [
    ['reader/m', [{ type: 'text', text: 'hear' }, { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }], '[audio omitted by keysmith]'],
    ['seer/m', [{ type: 'text', text: 'read' }, { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } }], '[PDF omitted by keysmith]'],
  ]) {
    const { status, text } = await post('/v1/chat/completions', { model, messages: [{ role: 'user', content }] });
    assert.equal(status, 200, text);
    const s = seen('/v1/chat/completions', text);
    assert.equal(s.lines, undefined, `${model}: nothing on stdin`);
    assert.equal(s.argv.at(-1), `User: ${content[0].text}\n${label}`, model);
  }
});

test('a CLI without vision reads the image as a label, its prompt in the argv as before', async () => {
  for (const [route, body] of [
    ['/v1/chat/completions', { model: 'blind/m', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }],
    ['/v1/messages', { model: 'blind/m', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] }],
    ['/v1/responses', { model: 'blind/m', input: [{ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] }] }],
  ]) {
    const { status, text } = await post(route, body);
    assert.equal(status, 200, `${route}: ${text}`);
    const s = seen(route, text);
    assert.deepEqual(s.argv, ['-p', '--model', 'm', 'User: look\n[image omitted by keysmith]'], route);
    assert.equal(s.lines, undefined, `${route}: nothing on stdin`);
  }
});

test('with fetchMedia false, a media URL is refused, not fetched — and the error shows its host, not its path or query', async () => {
  for (const [route, body] of [
    ['/v1/chat/completions', { model: 'seer/m', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://files.example.com/scan.jpg?sig=SECRET123' } }] }] }],
    ['/v1/messages', { model: 'seer/m', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://files.example.com/scan.jpg?sig=SECRET123' } }] }] }],
  ]) {
    const { status, text } = await post(route, body);
    assert.equal(status, 400, `${route}: ${text}`);
    assert.match(text, /image 1 is a URL \(https:\/\/files\.example\.com\/…\), and this gateway does not fetch media \(fetchMedia is false\)/, route);
    assert.doesNotMatch(text, /SECRET123|scan\.jpg/, route);
  }
});

test('more images than maxImages, or one over maxImageBytes, is a 400 before anything runs', async () => {
  const img = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } };
  let r = await post('/v1/chat/completions', { model: 'one/m', messages: [{ role: 'user', content: [img, img] }] });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /more than maxImages=1 images/);
  r = await post('/v1/chat/completions', { model: 'one/m', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.alloc(200, 0xff).toString('base64')}` } }] }] });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /image 1 is 200 bytes, over maxImageBytes=128 bytes/);
});

test('/v1/keysmith/routes says which adapters see images, and what media each takes', async () => {
  const res = await fetch(`${base}/v1/keysmith/routes`, { headers: { authorization: `Bearer ${KEY}` } });
  const { adapters } = await res.json();
  assert.deepEqual(Object.fromEntries(adapters.map((a) => [a.id, a.vision])), { seer: true, reader: true, one: true, blind: false });
  assert.deepEqual(Object.fromEntries(adapters.map((a) => [a.id, a.media])), { seer: ['image'], reader: ['image', 'pdf'], one: ['image'], blind: [] });
});

/* ------------------------------------------------------------------- reading one item */

test('readPart takes a data: URL, an Anthropic base64 source, a Responses image_url and a file, and reads the kind off the bytes', async () => {
  const o = { adapterId: 'x', n: 1 };
  const image = { kind: 'image', mediaType: 'image/png', data: PNG, name: null, detail: null };
  assert.deepEqual(await readPart({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }, o), image);
  assert.deepEqual(await readPart({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'high' } }, o), { ...image, detail: 'high' });
  assert.deepEqual(await readPart({ type: 'input_image', image_url: `data:;base64,${PNG}` }, o), image, 'a data: URL with no type');
  assert.equal((await readPart({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: JPEG } }, o)).mediaType, 'image/jpeg');
  // Base64 broken across lines, as some encoders write it, is the same image.
  assert.equal((await readPart({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.replace(/(.{20})/g, '$1\n') } }, o)).data, PNG);
  // What the bytes are decides, not the part: a PDF sent as an image is a PDF.
  assert.equal((await readPart({ type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }, o)).kind, 'pdf');
  assert.deepEqual(await readPart({ type: 'input_file', filename: 'x.pdf', file_data: PDF }, o), { kind: 'pdf', mediaType: 'application/pdf', data: PDF, name: 'x.pdf', detail: null }, 'bare base64 file_data');
  assert.deepEqual(await readPart({ type: 'input_audio', input_audio: { data: WAV, format: 'mp3' } }, o), { kind: 'audio', mediaType: 'audio/wav', data: WAV, name: null, detail: null });
});

test('sniffMedia knows each kind by its signature, and noise by none', () => {
  const kind = (b) => sniffMedia(Buffer.concat([b, Buffer.alloc(16)]))?.mediaType ?? null;
  assert.equal(kind(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(kind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(kind(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(kind(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), 'audio/wav');
  assert.equal(kind(Buffer.from('ID3\x04')), 'audio/mpeg');
  assert.equal(kind(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'audio/mpeg', 'an MPEG-1 layer III frame');
  assert.equal(kind(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'audio/aac', 'an ADTS frame');
  assert.equal(kind(Buffer.from('fLaC')), 'audio/flac');
  assert.equal(kind(Buffer.from('OggS')), 'audio/ogg');
  assert.equal(kind(Buffer.from('\0\0\0\x20ftypM4A ')), 'audio/mp4');
  assert.equal(kind(Buffer.from('\0\0\0\x20ftypisom')), 'video/mp4');
  assert.equal(kind(Buffer.from('\0\0\0\x14ftypqt  ')), 'video/quicktime');
  assert.equal(kind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
  assert.equal(kind(Buffer.alloc(8, 0xff)), null, 'all ones is not an MPEG frame');
  assert.equal(kind(Buffer.from('hello world')), null);
  assert.equal(sniffMedia(Buffer.from('%PDF-')), null, 'too short to be anything');
});

test('readPart refuses what it cannot read, with a 400 that says what to send instead', async () => {
  const o = { adapterId: 'x', n: 2 };
  const refused = (part, re, opts = o) => assert.rejects(readPart(part, opts), (e) => e.status === 400 && e.type === 'invalid_request_error' && re.test(e.message));
  // An address on this machine is refused before any connection is made.
  await refused({ type: 'image_url', image_url: { url: 'http://127.0.0.1:8787/v1/keysmith/routes' } }, /image 2 is at http:\/\/127\.0\.0\.1:8787, which is not on the public internet/);
  await refused({ type: 'image_url', image_url: { url: 'https://files.example.com/a.png?sig=S' } }, /fetchMedia is false/, { ...o, fetchUrls: false });
  await refused({ type: 'image_url', image_url: { url: 'data:image/png,%89PNG' } }, /data: URL without ;base64/);
  await refused({ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }, /image 2 has no data: expected a data: URL, an http\(s\) URL or a base64 source/);
  await refused({ type: 'image_url', image_url: {} }, /image 2 is empty/);
  await refused({ type: 'input_image', file_id: 'file-abc' }, /names an uploaded file/);
  await refused({ type: 'input_file', file_id: 'file-abc' }, /file 2 names an uploaded file/);
  await refused({ type: 'image', source: { type: 'file', file_id: 'f' } }, /names an uploaded file/);
  await refused({ type: 'image', source: { type: 'raw' } }, /a "raw" source/);
  await refused({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not base64!' } }, /not valid base64/);
  await refused({ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: Buffer.from('plain words, no signature').toString('base64') } }, /PDF 2 \(declared text\/plain\) is none of what keysmith takes: a JPEG, PNG/);
  await refused({ type: 'image', source: { type: 'base64', data: PNG } }, new RegExp(`image 2 is ${PNG_BYTES} bytes, over maxImageBytes=10 bytes`), { ...o, limits: { ...MEDIA_LIMITS, maxImageBytes: 10 } });
  await refused({ type: 'file', file: { file_data: PDF } }, new RegExp(`file 2 is ${PDF_BYTES} bytes of PDF, over maxFileBytes=20 bytes`), { ...o, limits: { ...MEDIA_LIMITS, maxFileBytes: 20 } });
});

/* ------------------------------------------------------------------- the message shape */

test('the faces keep a media message\'s parts beside its text, out of its enumerable shape', () => {
  const parts = [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }];
  for (const m of [
    openaiMessages({ messages: [{ role: 'user', content: parts }] })[0],
    anthropicMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] })[0],
    responsesMessages({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] }] })[0],
  ]) {
    assert.deepEqual(m, { role: 'user', content: 'look\n[image omitted by keysmith]' });
    assert.ok(Array.isArray(m.parts) && m.parts.length === 2);
    assert.doesNotMatch(JSON.stringify(m), /iVBOR/, 'a serialized message carries no image data');
    assert.equal({ ...m }.parts, undefined, 'a copy is text alone');
  }
  assert.equal(openaiMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: 'no image' }] }] })[0].parts, undefined);
});

test('PDFs, audio, video and files read as labels naming their kind — never dropped without a word', () => {
  const chat = openaiMessages({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } },
          { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAAA' } },
          { type: 'file', file: { file_data: 'data:video/mp4;base64,AAAA' } },
          { type: 'file', file: { file_id: 'file-1' } },
          { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } },
        ],
      },
    ],
  })[0];
  assert.equal(chat.content, '[audio omitted by keysmith]\n[PDF omitted by keysmith]\n[video omitted by keysmith]\n[file omitted by keysmith]\n[video omitted by keysmith]');
  // A document that is bytes is a PDF label; one that is text is no media, and reads as it always has.
  const doc = anthropicMessages({
    messages: [
      { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }] },
      { role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doc' } }, { type: 'text', text: 'summarise' }] },
    ],
  });
  assert.deepEqual(doc, [{ role: 'user', content: '[PDF omitted by keysmith]' }, { role: 'user', content: 'summarise' }]);
  assert.equal(doc[1].parts, undefined, 'a text document is no media');
  const resp = responsesMessages({ input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'https://example.com/r.pdf' }] }] })[0];
  assert.equal(resp.content, '[PDF omitted by keysmith]');
});

test('mediaPrompt flattens as flattenMessages does, and a mark a client writes is text, not media', async () => {
  const messages = openaiMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first \u0000ks-media-0000000000000000-0\u0000' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: 'and now?' },
    ],
  });
  const v = await mediaPrompt(messages, { adapterId: 'x', kinds: ['image'], limits: MEDIA_LIMITS, fetchUrls: false });
  assert.equal(v.media, 1);
  assert.equal(v.prompt.replace(/\u0000ks-media-(?!0{16})[0-9a-f]{16}-\d+\u0000/, '[image omitted by keysmith]'), flattenMessages(messages).prompt);
  const msg = JSON.parse(v.stdin(v.prompt));
  assert.equal(msg.message.content.filter((b) => b.type === 'image').length, 1);
  assert.match(msg.message.content[0].text, /first \u0000ks-media-0000000000000000-0\u0000/);
  assert.equal(msg.message.content[2].text, '\n\nAssistant: seen\n\nUser: and now?');
});

/* ------------------------------------------------------------------- configuration */

test('vision is true or false, media a list of kinds a CLI can carry, both need visionArgs, and an auto-approving visionArgs does not load', () => {
  const base = { kind: 'cli', bin: 'claude', args: ['-p', '{prompt}'] };
  assert.throws(() => new CliAdapter('x', { ...base, vision: true }), /vision needs visionArgs/);
  assert.throws(() => new CliAdapter('x', { ...base, media: ['pdf'] }), /media needs visionArgs/);
  assert.throws(() => new CliAdapter('x', { ...base, media: ['image', 'audio'], visionArgs: ['-p'] }), /audio cannot go to a CLI \(its stream-json input is an Anthropic message\): an Anthropic message has blocks for images and PDFs only/);
  assert.throws(() => new CliAdapter('x', { ...base, media: 'image', visionArgs: ['-p'] }), /media must be a list of image, pdf, audio, video/);
  assert.throws(() => new CliAdapter('x', { ...base, media: ['image'], vision: false, visionArgs: ['-p'] }), /vision is false and media lists image/);
  assert.throws(() => new CliAdapter('x', { ...base, media: ['pdf'], visionArgs: ['-p'], maxFiles: 1.5 }), /maxFiles must be a whole number above 0/);
  assert.deepEqual(new CliAdapter('x', { ...base, media: ['pdf'], vision: true, visionArgs: ['-p'] }).media, ['image', 'pdf'], 'vision true is image among the kinds');
  assert.throws(() => new CliAdapter('x', { ...base, vision: 'yes', visionArgs: ['-p'] }), /vision must be true or false/);
  assert.throws(() => new CliAdapter('x', { ...base, vision: true, visionArgs: ['-p'], maxImages: 0 }), /maxImages must be a whole number above 0/);
  assert.throws(() => new CliAdapter('x', { ...base, vision: true, visionArgs: '-p' }), /visionArgs must be an argv template/);
  const yolo = { ...base, vision: true, visionArgs: ['-p', '--dangerously-skip-permissions'] };
  assert.equal(autoApproveFlag(yolo), '--dangerously-skip-permissions');
  assert.throws(() => new CliAdapter('x', yolo), /auto-approves the agent's tool calls/);
  assert.equal(new CliAdapter('x', base).vision, false);
});

test('the claude profile takes images and PDFs through the same tool-less switches as its text run, its prompt on stdin', () => {
  const p = CLI_PROFILES.claude;
  assert.deepEqual(p.media, ['image', 'pdf']);
  assert.equal(p.args.at(-1), '{prompt}');
  assert.deepEqual(p.visionArgs, [p.args[0], '--input-format', 'stream-json', ...p.args.slice(1, -1)], 'args with stream-json input and no prompt');
  for (const flag of ['--tools', '--strict-mcp-config', '--permission-prompts', '--disable-slash-commands', '--safe-mode', '--max-turns', '{noSession}']) {
    assert.ok(p.visionArgs.includes(flag), flag);
  }
  assert.equal(p.visionArgs[p.visionArgs.indexOf('--tools') + 1], '');
  assert.equal(p.visionArgs[p.visionArgs.indexOf('--permission-prompts') + 1], 'none');
  for (const [name, q] of Object.entries(CLI_PROFILES)) if (name !== 'claude') assert.ok(!q.vision && !q.media, `${name}: no other CLI is known to take media (agy 1.4.12 refuses an image block)`);
});

test('keysmith set <id> vision true: an entry made before vision gets the profile\'s visionArgs; one with no profile is not saved', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-vision-'));
  try {
    const config = path.join(home, '.config', 'keysmith', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: {}, aliases: {} }), { mode: 0o600 });
    const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
    const run = (...args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
      return { ...r, all: `${r.stdout}${r.stderr}` };
    };
    const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(run('add', 'claude', '--bin', '/usr/local/bin/claude').status, 0);
    assert.deepEqual(read().adapters.claude.visionArgs, CLI_PROFILES.claude.visionArgs, 'a fresh add brings it');
    const old = read();
    delete old.adapters.claude.media;
    delete old.adapters.claude.visionArgs;
    fs.writeFileSync(config, JSON.stringify(old, null, 2), { mode: 0o600 });
    let r = run('set', 'claude', 'vision', 'true');
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /filled from the built-in "claude" profile: visionArgs/);
    assert.equal(read().adapters.claude.vision, true);
    assert.deepEqual(read().adapters.claude.visionArgs, CLI_PROFILES.claude.visionArgs);
    // A list in the shell's own spelling, and `vision false` taking image out of it.
    r = run('set', 'claude', 'media', 'image,pdf');
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(read().adapters.claude.media, ['image', 'pdf']);
    r = run('vision', 'claude', 'off');
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /and image out of claude\.media → \["pdf"\]/);
    assert.equal(read().adapters.claude.vision, false);
    assert.deepEqual(read().adapters.claude.media, ['pdf']);
    r = run('set', 'claude', 'media', 'image,sound');
    assert.notEqual(r.status, 0);
    assert.match(r.all, /not saved: adapter "claude": media must be a list of image, pdf, audio, video/);

    const custom = read();
    custom.adapters.mine = { kind: 'cli', bin: '/usr/local/bin/mycli', args: ['{prompt}'] };
    fs.writeFileSync(config, JSON.stringify(custom, null, 2), { mode: 0o600 });
    r = run('set', 'mine', 'vision', 'true');
    assert.notEqual(r.status, 0);
    assert.match(r.all, /not saved: adapter "mine": vision needs visionArgs/);
    assert.equal(read().adapters.mine.vision, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
