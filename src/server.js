import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LlmError, truncate } from './util.js';
import {
  chatId,
  openaiMessages,
  openaiChunk,
  openaiResult,
  anthropicMessages,
  anthropicStreamEvents,
  anthropicResult,
  responsesMessages,
  responsesResult,
  errorBody,
} from './protocols.js';
import { statusPage } from './status-page.js';

const MAX_BODY = 32 * 1024 * 1024;

export function createServer(gateway, cfg, { usage, log = () => {} } = {}) {
  const keys = cfg.auth?.enabled ? (cfg.auth.keys || []) : [];
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return send(res, 204, {}, '');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-keysmith-session,x-api-key,anthropic-version');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

    if (route === '/healthz') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000), adapters: gateway.publicAdapters.length, failed_to_load: Object.keys(gateway.loadErrors).length, alias_warnings: Object.keys(gateway.aliasIssues).length }));
    // The status page lists every model and token count this gateway knows about, so it
    // is gated like the API. A browser can still open it: append ?api_key=<key>.
    if ((route === '/' || route === '/status') && req.method === 'GET' && authorize(req, keys)) {
      const { models } = await safeList(gateway);
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, statusPage({ cfg, models, usage, startedAt, loadErrors: gateway.loadErrors, aliasIssues: gateway.aliasIssues }));
    }

    if (!authorize(req, keys)) {
      return json(res, 401, errorBody('missing or invalid API key — send `Authorization: Bearer <key>`', 'authentication_error', 401));
    }

    try {
      if (route === '/v1/models' || route === '/models') {
        const { models, errors } = await gateway.listModels({ refresh: url.searchParams.has('refresh') });
        return json(res, 200, { object: 'list', data: models, ...(errors.length ? { keysmith: { errors } } : {}) });
      }
      if (route === '/v1/keysmith/routes' && req.method === 'GET') {
        return json(res, 200, { adapters: describeAdapters(gateway), failed_to_load: gateway.loadErrors, aliases: cfg.aliases || {}, alias_warnings: gateway.aliasIssues, limits: cfg.limits });
      }
      if (route === '/v1/keysmith/usage' && req.method === 'GET') {
        const n = Number(url.searchParams.get('tail') || 0);
        return json(res, 200, { summary: usage?.summarize(Number(url.searchParams.get('hours') || 24) * 3600_000), ...(n ? { entries: usage.tail(n) } : {}) });
      }
      if (route === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res, gateway, { usage, log });
      if (route === '/v1/messages' && req.method === 'POST') return await handleAnthropic(req, res, gateway, { usage, log });
      if (route === '/v1/responses' && req.method === 'POST') return await handleResponses(req, res, gateway, { usage, log });
      if (route === '/v1/embeddings' && req.method === 'POST') return await handleEmbeddings(req, res, gateway);
      return json(res, 404, errorBody(`no route ${req.method} ${route}`, 'invalid_request_error', 404));
    } catch (e) {
      const status = e instanceof LlmError ? e.status : 500;
      if (status >= 500) log(`${route} crashed: ${e.stack || e.message}`);
      const meta = res._keysmith;
      if (meta && !meta.done) {
        record(usage, { model: meta.model, status: 'error', ms: Date.now() - meta.t0, stream: meta.stream, error: e.message, client: req.headers['user-agent'] });
      }
      if (res.headersSent) {
        // A stream that already started must be closed politely: an SSE error frame
        // and [DONE], or clients hang waiting for a terminator that never comes.
        if ((res.getHeader('content-type') || '').includes('text/event-stream')) {
          res.write(`data: ${JSON.stringify({ error: { message: `keysmith: ${e.message}`, type: e.type || 'upstream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        return res.end();
      }
      return json(res, status, errorBody(e.message || String(e), e instanceof LlmError ? e.type : 'internal_error', status, e?.provider || null));
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    void err;
  });

  return server;
}

async function safeList(gateway) {
  try {
    return await gateway.listModels();
  } catch {
    return { models: [] };
  }
}

function describeAdapters(gateway) {
  return gateway.publicAdapters.map((a) => ({
    id: a.id,
    kind: a.kind,
    wire: a.wire || null,
    bin: a.bin || null,
    baseUrl: a.baseUrl || null,
    priority: a.priority,
    parser: a.parser || null,
    resumable: !!a.resumable,
    timeoutMs: a.timeoutMs,
  }));
}

/* ---------------------------------------------------------------------- handlers */

async function handleChat(req, res, gateway, { usage, log }) {
  const body = await readJson(req);
  const messages = openaiMessages(body);
  if (!messages.length) throw new LlmError('messages is empty', { status: 400 });
  const requested = body.model;
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const t0 = Date.now();
  const id = chatId();
  const created = Math.floor(t0 / 1000);
  const meta = track(res, requested, stream, t0);

  // Tool calls need verbatim upstream deltas. A CLI harness would run the tools
  // itself rather than hand them back, so pass through only to HTTP upstreams.
  if (Array.isArray(body.tools) && body.tools.length) {
    const passthrough = await tryPassthrough(gateway, requested, body, req, res, { usage, log, t0, label: 'chat' });
    if (passthrough) return;
    log(`tools requested but no HTTP upstream matched for "${requested}" — running as a plain completion`);
  }

  const chain = gateway.resolve(requested);
  const publicId = session || null;
  res.setHeader('x-keysmith-route', chain.map((c) => c.target).join(','));

  if (!stream) {
    const { text, reasoning, usage: u, session: sid } = await gateway.collect({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning });
    meta.done = true;
    record(usage, { model: requested, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, client: req.headers['user-agent'] });
    // The header carries the session for clients that read headers; the body carries it
    // for the ones that do not (curl, `keysmith chat`), and OpenAI SDKs ignore extras.
    const payload = openaiResult({ id, model: requested, created, text, usage: u, reasoning: body.include_reasoning ? reasoning || null : null });
    if (sid) payload.keysmith = { session: sid, resumed: !!publicId };
    return json(res, 200, payload, sid);
  }

  startSse(res, 'text/event-stream');
  res.write(`data: ${JSON.stringify(openaiChunk(id, requested, created, { role: 'assistant', content: '' }))}\n\n`);
  let text = '';
  let u = null;
  let sid = null;
  let errMessage = null;
  let reasoning = '';
  for await (const evt of gateway.complete({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning })) {
    if (evt.type === 'reasoning') {
      reasoning += evt.text;
      res.write(`data: ${JSON.stringify(openaiChunk(id, requested, created, { reasoning_content: evt.text }))}\n\n`);
    } else if (evt.type === 'delta') {
      text += evt.text;
      res.write(`data: ${JSON.stringify(openaiChunk(id, requested, created, { content: evt.text }))}\n\n`);
    } else if (evt.type === 'usage') {
      u = mergeUsage(u, evt.usage);
    } else if (evt.type === 'session') {
      sid = evt.id;
    } else if (evt.type === 'error') {
      errMessage = evt.message;
    } else if (evt.type === 'done') {
      break;
    }
  }
  // Headers are already on the wire at this point, so the session id rides in the
  // closing chunk as an extra field — unknown keys are ignored by every client,
  // and `x-keysmith-session` is still set on non-streaming responses.
  const closing = openaiChunk(id, requested, created, {}, 'stop');
  if (sid) closing.keysmith = { session: sid, resumed: !!publicId };
  res.write(`data: ${JSON.stringify(closing)}\n\n`);
  if (body.stream_options?.include_usage) {
    res.write(`data: ${JSON.stringify({ ...openaiChunk(id, requested, created, null), choices: [], usage: openaiResult({ id, model: requested, created, text: '', usage: u }).usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  meta.done = true;
  record(usage, { model: requested, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, client: req.headers['user-agent'] });
}

async function handleAnthropic(req, res, gateway, { usage, log }) {
  const body = await readJson(req);
  const messages = anthropicMessages(body);
  if (!messages.length) throw new LlmError('messages is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId();
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const meta = track(res, body.model, stream, t0);
  // The Messages API defaults to a single JSON reply; SSE only when asked.
  if (!stream) {
    const { text, usage: u, session: sid } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens });
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, client: 'anthropic', via: '/v1/messages' });
    // Session goes out as a header only: Anthropic clients schema-check the body.
    return json(res, 200, anthropicResult({ id, model: body.model, text, usage: u }), sid);
  }
  startSse(res, 'text/event-stream');
  writeAnthicHead(res, { id, model: body.model });
  // Headers are on the wire by now, so a streamed response cannot advertise the session
  // id — use stream=false (or /v1/chat/completions) when you need to continue a CLI thread.
  let u = null;
  let text = '';
  let errMessage = null;
  for await (const evt of gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens })) {
    if (evt.type === 'delta') {
      text += evt.text;
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: evt.text } });
    } else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = evt.message;
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: errMessage } });
  sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: errMessage ? 'error' : 'end_turn', stop_sequence: null }, usage: { output_tokens: u?.output || 0 } });
  sseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, client: 'anthropic', via: '/v1/messages' });
  void log;
  void text;
}

async function handleResponses(req, res, gateway, { usage, log }) {
  const body = await readJson(req);
  const messages = responsesMessages(body);
  if (!messages.length) throw new LlmError('input is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId('resp');
  const created = Math.floor(t0 / 1000);
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const meta = track(res, body.model, stream, t0);
  if (!stream) {
    const { text, usage: u, session: sid } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res) });
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, via: '/v1/responses' });
    return json(res, 200, responsesResult({ id, model: body.model, text, usage: u, created }), sid);
  }
  startSse(res, 'text/event-stream');
  for (const e of responsesStreamEventsHead({ id, model: body.model })) sseEvent(res, e.event, e.data);
  let full = '';
  let u = null;
  let errMessage = null;
  for await (const evt of gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res) })) {
    if (evt.type === 'delta') {
      full += evt.text;
      sseEvent(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: evt.text });
    } else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = evt.message;
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'response.failed', { type: 'response.failed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: 'failed', error: { message: errMessage } } });
  else sseEvent(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${id}`, output_index: 0, content_index: 0, text: full });
  sseEvent(res, 'response.completed', { type: 'response.completed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: errMessage ? 'failed' : 'completed', usage: { input_tokens: u?.input || 0, output_tokens: u?.output || 0 } } });
  res.end();
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, via: '/v1/responses' });
  void log;
}

async function handleEmbeddings(req, res, gateway) {
  const body = await readJson(req);
  const slash = String(body.model || '').indexOf('/');
  const adapterId = slash < 0 ? body.model : body.model.slice(0, slash);
  const adapter = gateway.adapters.get(adapterId);
  if (!adapter || adapter.kind !== 'http') throw new LlmError('embeddings need an HTTP adapter', { status: 400 });
  const upstreamModel = slash < 0 ? '' : body.model.slice(slash + 1);
  const r = await fetch(`${adapter.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adapter.authHeaders(), ...adapter.headers },
    body: JSON.stringify({ ...body, model: upstreamModel }),
    signal: AbortSignal.timeout(adapter.timeoutMs),
  });
  const text = await r.text();
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Straight pipe to an HTTP upstream, byte for byte, used when the client asked for
 * tools. Only candidates that can honour that are tried, so a mixed route degrades
 * to the API-backed model instead of returning a tool-free answer.
 */
async function tryPassthrough(gateway, requested, body, req, res, { usage, log, t0, label }) {
  let chain;
  try {
    chain = gateway.resolve(requested);
  } catch {
    return false;
  }
  const candidates = chain.filter((c) => c.adapter.kind === 'http' && c.adapter.wire === 'openai');
  void label;
  for (const { adapter, model } of candidates) {
    try {
      const upstream = await adapter.rawChat({ ...body, model }, req, res);
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        throw new LlmError(`${adapter.id} ${upstream.status}: ${truncate(t, 200)}`, { status: upstream.status, provider: adapter.id });
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'x-keysmith-mode': 'passthrough' });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      record(usage, { model: requested, status: 'ok', ms: Date.now() - t0, stream: !!body.stream, via: 'passthrough', client: req.headers['user-agent'] });
      return true;
    } catch (e) {
      log(`passthrough via ${adapter.id} failed: ${e.message}`);
      if (res.headersSent) {
        res.end();
        return true;
      }
    }
  }
  return false;
}

/* ---------------------------------------------------------------------- plumbing */

function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    input: Math.max(a.input || 0, b.input || 0),
    output: Math.max(a.output || 0, b.output || 0),
    cacheRead: Math.max(a.cacheRead || 0, b.cacheRead || 0),
    cacheWrite: Math.max(a.cacheWrite || 0, b.cacheWrite || 0),
    ...(a.total || b.total ? { total: Math.max(a.total || 0, b.total || 0) } : {}),
  };
}

function record(usage, entry) {
  usage?.record(entry);
}

/**
 * A session id arrives either as the `x-keysmith-session` header or as a `session`
 * field on the body. The header is what a proxy or SDK middleware can always send;
 * the body field is what `curl` and CLI users actually reach for, and every face
 * echoes the id back, so the round trip is documented rather than guessed.
 */
function sessionFrom(req, body) {
  const h = req.headers['x-keysmith-session'];
  const fromHeader = typeof h === 'string' && h.trim() ? h.trim() : null;
  const fromBody = typeof body?.session === 'string' && body.session.trim() ? body.session.trim() : null;
  return fromHeader || fromBody;
}

/**
 * Register a request with the response so the outer catch can write the failure into
 * the usage log too. A request that errors is exactly the kind of line you go looking
 * for at 1am, so it must not only exist in the client's terminal.
 */
function track(res, model, stream, t0) {
  res._keysmith = { model, stream, t0, done: false };
  return res._keysmith;
}

function writeAnthicHead(res, { id, model }) {
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  });
  sseEvent(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sseEvent(res, 'ping', { type: 'ping' });
}

function responsesStreamEventsHead({ id, model }) {
  return [
    { event: 'response.created', data: { type: 'response.created', response: { id: `resp_${id}`, object: 'response', model, status: 'in_progress', output: [] } } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] } } },
    { event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: `msg_${id}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } } },
  ];
}

function sseEvent(res, name, data) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSse(res, type) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': stream open\n\n');
}

function abortSignal(req, res) {
  const c = new AbortController();
  const done = () => c.abort(new Error('client disconnected'));
  req.on('aborted', done);
  res.on('close', () => {
    if (!res.writableEnded) done();
  });
  return c.signal;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new LlmError('request body too large', { status: 413 });
    chunks.push(c);
    if (req.method === 'HEAD') break;
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new LlmError(`request body is not valid JSON: ${e.message}`, { status: 400 });
  }
}

function json(res, status, payload, session = null) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (session) headers['x-keysmith-session'] = session;
  return send(res, status, headers, JSON.stringify(payload));
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function authorize(req, keys) {
  if (!keys.length) return true;
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'] || new URL(req.url, 'http://x').searchParams.get('api_key') || '';
  return keys.some((k) => safeEqual(String(k), String(candidate)));
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export { openaiResult, errorBody };
