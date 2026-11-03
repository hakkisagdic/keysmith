/**
 * Media a request carries, for an HTTP upstream that takes it (`media` on its entry), and the
 * URLs keysmith fetches for it.
 *
 * A stub upstream answers both wires (`/oai/chat/completions`, `/v1/messages`) and keeps every
 * request body it was sent; a stub file server stands in for the web. Both listen on 127.0.0.1,
 * which a fetch never reaches: the adapters that fetch from it are let through to 127.0.0.1 alone
 * for the test (`mediaOpts.allowed`), and `strict` is not, which is the rule every gateway runs under.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { UsageLog } from '../src/usage.js';
import { HttpAdapter } from '../src/http-adapter.js';
import { HTTP_PROFILES } from '../src/profiles.js';
import { isPublicAddress } from '../src/media.js';

const KEY = 'ks_test_000000000000000000000000';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n').toString('base64');
const WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(32)]).toString('base64');
const MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'latin1'), Buffer.alloc(32)]).toString('base64');
const MP4 = Buffer.concat([Buffer.from('\0\0\0\x20ftypisom', 'latin1'), Buffer.alloc(32)]).toString('base64');

let dir, server, base, upstream, files, gateway;
const sent = []; // every request the stub upstream received: { path, headers, body }
const hits = {}; // file server: path -> requests

function startUpstream() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.startsWith('/flaky/')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"overloaded"}}');
      }
      sent.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const data = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (req.url.endsWith('/messages')) {
        data({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } });
        data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
        data({ type: 'message_stop' });
      } else {
        data({ choices: [{ index: 0, delta: { content: 'ok' } }] });
        data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function startFiles() {
  const srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const where = req.url.replace(/\?.*$/, '');
    const send = (type, b64) => {
      const body = Buffer.from(b64, 'base64');
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      res.end(body);
    };
    const m = /^\/hop\/(\d+)$/.exec(where);
    if (m) {
      const left = Number(m[1]);
      res.writeHead(302, { location: left > 0 ? `/hop/${left - 1}` : '/scan.png' });
      return res.end();
    }
    switch (where) {
      case '/scan.png':
      case '/again.png':
        return send('application/octet-stream', PNG);
      case '/paper.pdf':
        return send('application/pdf', PDF);
      case '/sneaky':
        // Off the one address the test lets a fetch reach: the redirect is checked as the first hop was.
        res.writeHead(302, { location: `http://[::1]:${srv.address().port}/scan.png` });
        return res.end();
      case '/big.pdf':
        // No content-length: the cap is counted as the bytes arrive.
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.write(Buffer.from(PDF, 'base64'));
        return res.end(Buffer.alloc(200, 0x20));
      default:
        res.writeHead(404);
        return res.end('no');
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-media-http-'));
  upstream = await startUpstream();
  files = await startFiles();
  const up = `http://127.0.0.1:${upstream.address().port}`;
  const http = (extra) => ({ kind: 'http', models: ['m'], apiKey: false, ...extra });
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    auth: { enabled: true, keys: [KEY] },
    log: { usage: true, body: false },
    limits: { maxConcurrent: 4, timeoutMs: 20_000 },
    tunnel: { provider: 'cloudflared' },
    adapters: {
      oai: http({ wire: 'openai', baseUrl: `${up}/oai`, media: ['image', 'pdf', 'audio', 'video'] }),
      ant: http({ wire: 'anthropic', baseUrl: `${up}/v1`, media: ['image', 'pdf'] }),
      pics: http({ wire: 'openai', baseUrl: `${up}/pics`, vision: true, mediaHeaders: { 'x-vision-request': 'true' } }),
      plain: http({ wire: 'openai', baseUrl: `${up}/plain` }),
      capped: http({ wire: 'openai', baseUrl: `${up}/capped`, media: ['image', 'pdf'], maxFiles: 1, maxFileBytes: 64 }),
      strict: http({ wire: 'openai', baseUrl: `${up}/strict`, media: ['image', 'pdf'] }),
      flaky: http({ wire: 'openai', baseUrl: `${up}/flaky`, media: ['image', 'pdf'] }),
    },
    aliases: { both: ['flaky/m', 'oai/m'] },
  };
  gateway = new Gateway(cfg, { log: () => {} });
  for (const id of ['oai', 'ant', 'capped', 'flaky']) gateway.adapters.get(id).mediaOpts.allowed = (address) => address === '127.0.0.1';
  server = createServer(gateway, cfg, { usage: new UsageLog(path.join(dir, 'usage.jsonl')), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => files.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

/** Send one request and return what the upstream got for it: `{ path, headers, body }`. */
async function upstreamGot(route, body) {
  const before = sent.length;
  const { status, text } = await post(route, body);
  assert.equal(status, 200, text);
  assert.equal(sent.length, before + 1, 'one upstream request');
  return sent.at(-1);
}

const fileUrl = (p) => `http://127.0.0.1:${files.address().port}${p}`;
const user = (content) => [{ role: 'user', content }];
const lastContent = (got) => got.body.messages.at(-1).content;

/* ------------------------------------------------------------------- the openai wire */

test('/v1/chat/completions → openai wire: a user turn goes up as a content array, image in its place, its detail kept', async () => {
  const got = await upstreamGot('/v1/chat/completions', {
    model: 'oai/m',
    messages: [
      { role: 'system', content: 'Be exact.' },
      { role: 'user', content: [{ type: 'text', text: 'Transcribe:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'high' } }, { type: 'text', text: 'line one' }] },
    ],
  });
  assert.equal(got.path, '/oai/chat/completions');
  assert.deepEqual(got.body.messages, [
    { role: 'system', content: 'Be exact.' },
    { role: 'user', content: [{ type: 'text', text: 'Transcribe:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'high' } }, { type: 'text', text: 'line one' }] },
  ]);
});

test('/v1/messages → openai wire: a base64 source becomes a data: URL of what the bytes are; a PDF document a file part', async () => {
  const got = await upstreamGot('/v1/messages', {
    model: 'oai/m',
    max_tokens: 50,
    messages: user([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: JPEG } },
      { type: 'document', title: 'paper.pdf', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
      { type: 'text', text: 'compare' },
    ]),
  });
  assert.deepEqual(lastContent(got), [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
    { type: 'file', file: { filename: 'paper.pdf', file_data: `data:application/pdf;base64,${PDF}` } },
    { type: 'text', text: 'compare' },
  ]);
});

test('audio goes up as input_audio with the format its bytes have; video as video_url; Responses input_file as a file', async () => {
  let got = await upstreamGot('/v1/chat/completions', { model: 'oai/m', messages: user([{ type: 'input_audio', input_audio: { data: WAV, format: 'mp3' } }, { type: 'text', text: 'what is said' }]) });
  assert.deepEqual(lastContent(got), [{ type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }, { type: 'text', text: 'what is said' }]);
  got = await upstreamGot('/v1/responses', {
    model: 'oai/m',
    input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: MP3, format: 'mp3' } }, { type: 'input_file', filename: 'p.pdf', file_data: `data:application/pdf;base64,${PDF}` }] }],
  });
  assert.deepEqual(lastContent(got), [
    { type: 'input_audio', input_audio: { data: MP3, format: 'mp3' } },
    { type: 'file', file: { filename: 'p.pdf', file_data: `data:application/pdf;base64,${PDF}` } },
  ]);
  got = await upstreamGot('/v1/chat/completions', { model: 'oai/m', messages: user([{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${MP4}` } }]) });
  assert.deepEqual(lastContent(got), [{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${MP4}` } }]);
});

test('several images go up in their order, each between the text it was between', async () => {
  const img = (b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
  const got = await upstreamGot('/v1/chat/completions', {
    model: 'oai/m',
    messages: user([{ type: 'text', text: 'page 1' }, img(PNG), { type: 'text', text: 'page 2' }, img(JPEG), img(PNG), { type: 'text', text: ' ' }]),
  });
  assert.deepEqual(
    lastContent(got).map((b) => (b.type === 'text' ? b.text : b.image_url.url.slice(0, 15))),
    ['page 1', 'data:image/png;', 'page 2', 'data:image/jpeg', 'data:image/png;'],
    'a text block of whitespace alone is dropped',
  );
});

/* ------------------------------------------------------------------- the anthropic wire */

test('/v1/chat/completions → anthropic wire: a data: URL becomes a base64 image block, a file part a document', async () => {
  const got = await upstreamGot('/v1/chat/completions', {
    model: 'ant/m',
    messages: [
      { role: 'system', content: 'Be exact.' },
      { role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG}` } }, { type: 'file', file: { filename: 'scan.pdf', file_data: `data:application/pdf;base64,${PDF}` } }] },
    ],
  });
  assert.equal(got.path, '/v1/messages');
  assert.equal(got.body.system, 'Be exact.');
  assert.deepEqual(got.body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'read' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'scan.pdf' },
      ],
    },
  ]);
});

/* ------------------------------------------------------------------- what is not taken */

test('a kind an upstream does not take goes up as its label, in its place; an upstream that takes none gets text as before', async () => {
  let got = await upstreamGot('/v1/chat/completions', { model: 'ant/m', messages: user([{ type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]) });
  assert.deepEqual(lastContent(got), [{ type: 'text', text: '[audio omitted by keysmith]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
  got = await upstreamGot('/v1/chat/completions', { model: 'pics/m', messages: user([{ type: 'text', text: 'read' }, { type: 'file', file: { file_data: PDF } }]) });
  assert.equal(lastContent(got), 'read\n[PDF omitted by keysmith]', 'a file that says nothing of its kind is read, labelled for what it is, and the turn is text again');
  assert.equal(got.headers['x-vision-request'], undefined, 'no media went up');
  got = await upstreamGot('/v1/chat/completions', { model: 'plain/m', messages: user([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: fileUrl('/scan.png') } }]) });
  assert.equal(lastContent(got), 'look\n[image omitted by keysmith]');
  assert.equal(hits['/scan.png'], undefined, 'an upstream that takes no media fetches nothing');
});

test('media goes up in a user turn only: in a system or assistant turn it stays the label', async () => {
  const img = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } };
  const got = await upstreamGot('/v1/chat/completions', {
    model: 'oai/m',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'rules' }, img] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'drawn:' }, img] },
      { role: 'user', content: [{ type: 'text', text: 'again' }, img] },
    ],
  });
  assert.deepEqual(got.body.messages.slice(0, 3), [
    { role: 'system', content: 'rules\n[image omitted by keysmith]' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'drawn:\n[image omitted by keysmith]' },
  ]);
  assert.equal(lastContent(got)[1].type, 'image_url');
});

test('mediaHeaders go only with a request that carries media up', async () => {
  let got = await upstreamGot('/v1/chat/completions', { model: 'pics/m', messages: user([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]) });
  assert.equal(got.headers['x-vision-request'], 'true');
  got = await upstreamGot('/v1/chat/completions', { model: 'pics/m', messages: user('just text') });
  assert.equal(got.headers['x-vision-request'], undefined);
});

/* ------------------------------------------------------------------- limits */

test('over maxFiles, over maxFileBytes, or bytes of no known kind: a 400 before the upstream is called', async () => {
  const before = sent.length;
  const pdf = { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } };
  let r = await post('/v1/chat/completions', { model: 'capped/m', messages: user([pdf, pdf]) });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /more than maxFiles=1 files \(PDF, audio, video\)/);
  r = await post('/v1/chat/completions', { model: 'capped/m', messages: user([{ type: 'file', file: { file_data: `data:application/pdf;base64,${Buffer.alloc(100, 0x25).toString('base64')}` } }]) });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /PDF 1 is 100 bytes, over maxFileBytes=64 bytes/);
  r = await post('/v1/messages', { model: 'oai/m', max_tokens: 9, messages: user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') } }]) });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /image 1 \(declared image\/png\) is none of what keysmith takes/);
  assert.equal(sent.length, before, 'the upstream was never called');
});

/* ------------------------------------------------------------------- URLs */

test('a URL is fetched and sent inline: an image_url, an Anthropic url source, a Responses file_url — through redirects', async () => {
  let got = await upstreamGot('/v1/chat/completions', { model: 'oai/m', messages: user([{ type: 'image_url', image_url: { url: fileUrl('/hop/2') } }]) });
  assert.deepEqual(lastContent(got), [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }], 'declared octet-stream, read as the PNG it is');
  got = await upstreamGot('/v1/messages', { model: 'oai/m', max_tokens: 9, messages: user([{ type: 'document', source: { type: 'url', url: fileUrl('/paper.pdf') } }]) });
  assert.equal(lastContent(got)[0].file.file_data, `data:application/pdf;base64,${PDF}`);
  got = await upstreamGot('/v1/responses', { model: 'ant/m', input: [{ role: 'user', content: [{ type: 'input_file', file_url: fileUrl('/paper.pdf') }] }] });
  assert.deepEqual(lastContent(got), [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }]);
});

test('a fetch that fails is a 400 naming the host only: too many redirects, a status, over the cap', async () => {
  for (const [model, part, re] of [
    ['oai/m', { type: 'image_url', image_url: { url: fileUrl('/hop/5?sig=SECRET') } }, /image 1 at http:\/\/127\.0\.0\.1:\d+ redirects more than 3 times/],
    ['oai/m', { type: 'image_url', image_url: { url: fileUrl('/missing?sig=SECRET') } }, /image 1 could not be fetched: http:\/\/127\.0\.0\.1:\d+ answered 404/],
  ]) {
    const r = await post('/v1/chat/completions', { model, messages: user([part]) });
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, re);
    assert.doesNotMatch(r.text, /SECRET|missing|hop/);
  }
  const r = await post('/v1/responses', { model: 'capped/m', input: [{ role: 'user', content: [{ type: 'input_file', file_url: fileUrl('/big.pdf') }] }] });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /PDF 1 at http:\/\/127\.0\.0\.1:\d+ is over maxFileBytes=64 bytes/);
});

test('a URL on this machine or its network is refused, never connected to — by address, by name, or by a redirect', async () => {
  const port = files.address().port;
  const before = { ...hits };
  for (const url of [`http://127.0.0.1:${port}/scan.png`, `http://localhost:${port}/scan.png`, `http://[::1]:${port}/scan.png`, 'http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3/x.png', 'http://[::ffff:127.0.0.1]/x.png']) {
    const r = await post('/v1/chat/completions', { model: 'strict/m', messages: user([{ type: 'image_url', image_url: { url } }]) });
    assert.equal(r.status, 400, `${url}: ${r.text}`);
    assert.match(r.text, /which is not on the public internet — keysmith fetches media only from public addresses/, url);
  }
  assert.deepEqual(hits, before, 'the file server saw none of them');
  // A redirect is checked as the first hop was: off the address this adapter may reach, it is refused.
  const r = await post('/v1/chat/completions', { model: 'oai/m', messages: user([{ type: 'image_url', image_url: { url: fileUrl('/sneaky') } }]) });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /image 1 is at http:\/\/\[::1\]:\d+, which is not on the public internet/);
  assert.equal(hits['/scan.png'] ?? 0, before['/scan.png'] ?? 0);
});

test('isPublicAddress: loopback, private, shared, link-local, documentation, multicast and embedded-IPv4 forms are not public', () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '142.250.74.46', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) assert.equal(isPublicAddress(a), true, a);
});

test('a URL is fetched once for a request: a leg that fails over hands the next the same bytes', async () => {
  const before = hits['/again.png'] || 0;
  const got = await upstreamGot('/v1/chat/completions', { model: 'both', messages: user([{ type: 'image_url', image_url: { url: fileUrl('/again.png') } }]) });
  assert.equal(got.path, '/oai/chat/completions', 'flaky answered 503, oai answered');
  assert.equal(lastContent(got)[0].image_url.url, `data:image/png;base64,${PNG}`);
  assert.equal(hits['/again.png'] - before, 1, 'one fetch for two legs');
});

test('fetchMedia false: the gateway hands every adapter a refusal to fetch', () => {
  const g = new Gateway({ adapters: { a: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', media: ['image'] } }, fetchMedia: false }, { log: () => {} });
  assert.equal(g.adapters.get('a').mediaOpts.fetchUrls, false);
  const h = new Gateway({ adapters: { a: { kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', media: ['image'] } } }, { log: () => {} });
  assert.equal(h.adapters.get('a').mediaOpts.fetchUrls, true, 'on unless the config says otherwise');
});

/* ------------------------------------------------------------------- configuration */

test('media on an HTTP entry: a list of kinds its wire can carry; mediaHeaders a map of strings', () => {
  const at = (extra) => new HttpAdapter('x', { baseUrl: 'http://127.0.0.1:9/v1', ...extra });
  assert.deepEqual(at({ media: ['video', 'image'] }).media, ['image', 'video']);
  assert.deepEqual(at({ vision: true }).media, ['image']);
  assert.deepEqual(at({}).media, []);
  assert.throws(() => at({ wire: 'anthropic', media: ['image', 'audio'] }), /audio cannot go on the anthropic wire: an Anthropic message has blocks for images and PDFs only/);
  assert.throws(() => at({ media: ['image', 'text'] }), /media must be a list of image, pdf, audio, video/);
  assert.throws(() => at({ media: ['image'], maxImageBytes: -1 }), /maxImageBytes must be a whole number above 0/);
  assert.throws(() => at({ mediaHeaders: { 'x-a': true } }), /mediaHeaders must map header names to strings/);
});

test('the profiles: OpenAI, Anthropic, Google and Copilot take media; Copilot says so in a header', () => {
  assert.deepEqual(HTTP_PROFILES.openai.media, ['image', 'pdf', 'audio']);
  assert.deepEqual(HTTP_PROFILES.anthropic.media, ['image', 'pdf']);
  assert.ok(HTTP_PROFILES.google.media.includes('image') && HTTP_PROFILES.google.media.includes('audio'));
  assert.deepEqual(HTTP_PROFILES.copilot.media, ['image']);
  assert.deepEqual(HTTP_PROFILES.copilot.mediaHeaders, { 'copilot-vision-request': 'true' });
  for (const name of ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'groq', 'deepseek', 'together', 'openrouter']) assert.equal(HTTP_PROFILES[name].media, undefined, `${name}: depends on the model it runs`);
  for (const [name, p] of Object.entries(HTTP_PROFILES)) new HttpAdapter(name, { ...p, _apiKey: null });
});

test('keysmith vision <http adapter> on|off and set <id> media: the same fields as on a CLI, no visionArgs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keysmith-media-set-'));
  try {
    const config = path.join(home, '.config', 'keysmith', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, auth: { enabled: true, keys: [KEY] }, adapters: { up: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } }, aliases: {} }), { mode: 0o600 });
    const env = { ...process.env, HOME: home, KEYSMITH_CONFIG: config, KEYSMITH_DATA: path.join(home, 'data') };
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KEYSMITH_VERBOSE']) delete env[k];
    const run = (...args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
      return { ...r, all: `${r.stdout}${r.stderr}` };
    };
    const entry = () => JSON.parse(fs.readFileSync(config, 'utf8')).adapters.up;
    let r = run('vision', 'up', 'on');
    assert.equal(r.status, 0, r.all);
    assert.equal(entry().vision, true);
    assert.equal(entry().visionArgs, undefined);
    r = run('set', 'up', 'media', 'image,audio,video');
    assert.equal(r.status, 0, r.all);
    r = run('vision', 'up', 'off');
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(entry().media, ['audio', 'video']);
    r = run('set', 'up', 'wire', 'anthropic');
    assert.notEqual(r.status, 0, 'audio cannot go on the anthropic wire');
    assert.match(r.all, /not saved: adapter "up": audio and video cannot go on the anthropic wire/);
    r = run('set', 'up');
    assert.match(r.stdout, /media/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
