import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LlmError, routeError } from './util.js';
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
import { loginPage, statusPage } from './status-page.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { upstreamError } from './http-adapter.js';

const MAX_BODY = 32 * 1024 * 1024;
const STREAM_HOLD_MS = 10_000;

export function createServer(gateway, cfg, { usage, log: write = () => {} } = {}) {
  // Every line this server logs can quote an upstream error; it leaves here redacted.
  const log = (m) => write(redactSecrets(m));
  const keys = cfg.auth?.enabled ? (cfg.auth.keys || []) : [];
  // The usage log redacts these from every line it writes; register them even when the
  // config did not come through loadConfig (an embedded server, a test).
  registerSecrets(cfg.auth?.keys);
  const startedAt = Date.now();
  const pages = pageSessions();
  // How long a streamed answer's headers wait for its first event (see `held`).
  const holdMs = Number.isFinite(cfg.limits?.streamHoldMs) && cfg.limits.streamHoldMs >= 0 ? cfg.limits.streamHoldMs : STREAM_HOLD_MS;

  // Whatever one request does, it never takes the process down: launchd would restart it
  // every 10 s for as long as somebody keeps sending the request, and Node's own crash
  // report prints the error's fields — a bad URL's among them — unredacted.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`request crashed: ${e?.stack || e}`);
      try {
        if (!res.headersSent) json(res, 500, errorBody('internal error', 'internal_error', 500));
        else res.end();
      } catch {}
    });
  });

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch {
      // `GET //a:99999/` or `GET http://a:99999/?api_key=…`: a target that does not parse.
      // Nothing is checked yet, so nothing is said — and the target is never echoed.
      return json(res, 400, errorBody('malformed request target', 'invalid_request_error', 400));
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return send(res, 204, {}, '');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-keysmith-session,x-api-key,anthropic-version');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

    if (route === '/healthz') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000), adapters: gateway.publicAdapters.length, failed_to_load: Object.keys(gateway.loadErrors).length, alias_warnings: Object.keys(gateway.aliasIssues).length }));
    // The status page lists every model and token count this gateway knows about, so it is
    // gated like the API — but never by `?api_key=`: a URL is kept by browser history and
    // sync, and behind a tunnel by the edge's request logs. A browser posts the key once
    // through the page's form and gets a cookie that opens this page alone, for an hour.
    if (route === '/' || route === '/status') {
      if (req.method === 'POST') return pageLogin(req, res, route);
      if (req.method === 'GET') {
        if (keys.length && !headerAuthorized(req, keys) && !pages.valid(cookieFrom(req, PAGE_COOKIE))) {
          return send(res, 401, PAGE_HEADERS, loginPage({ action: route }));
        }
        const { models } = await safeList(gateway);
        return send(res, 200, PAGE_HEADERS, statusPage({ cfg, models, usage, startedAt, loadErrors: gateway.loadErrors, aliasIssues: gateway.aliasIssues }));
      }
    }

    const caller = callerOf(req, keys, url);
    if (caller === null) {
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
      if (route === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res, gateway, { usage, log, caller, holdMs });
      if (route === '/v1/messages' && req.method === 'POST') return await handleAnthropic(req, res, gateway, { usage, log, holdMs });
      if (route === '/v1/responses' && req.method === 'POST') return await handleResponses(req, res, gateway, { usage, log, holdMs });
      if (route === '/v1/embeddings' && req.method === 'POST') return await handleEmbeddings(req, res, gateway);
      return json(res, 404, errorBody(`no route ${req.method} ${route}`, 'invalid_request_error', 404));
    } catch (e) {
      const status = e instanceof LlmError ? e.status : 500;
      if (status >= 500) log(`${route} crashed: ${e.stack || e.message}`);
      // The client gets the error the way a log line does: an upstream message can quote
      // a provider key, and a client of this gateway was never given that key.
      const message = redactSecrets(e.message || String(e));
      const meta = res._keysmith;
      if (meta && !meta.done) {
        record(usage, { model: meta.model, status: 'error', ms: Date.now() - meta.t0, stream: meta.stream, error: message, client: req.headers['user-agent'] });
      }
      if (res.headersSent) {
        // A stream that already started must be closed politely: an SSE error frame
        // and [DONE], or clients hang waiting for a terminator that never comes.
        if ((res.getHeader('content-type') || '').includes('text/event-stream')) {
          res.write(`data: ${JSON.stringify({ error: { message: `keysmith: ${message}`, type: e.type || 'upstream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        return res.end();
      }
      // A provider's "retry after N s" is for the client's backoff: pass it on.
      if (e?.retryAfter) res.setHeader('retry-after', String(e.retryAfter));
      return json(res, status, errorBody(message, e instanceof LlmError ? e.type : 'internal_error', status, e?.provider || null));
    }
  }

  async function pageLogin(req, res, route) {
    let body = '';
    for await (const c of req) {
      body += c;
      if (body.length > 4096) return send(res, 413, PAGE_HEADERS, loginPage({ action: route }));
    }
    const candidate = new URLSearchParams(body).get('api_key') || '';
    if (keys.length && !keys.some((k) => safeEqual(String(k), candidate))) {
      return send(res, 401, PAGE_HEADERS, loginPage({ action: route, failed: true }));
    }
    const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
    res.writeHead(303, {
      location: route,
      'cache-control': 'no-store',
      'set-cookie': `${PAGE_COOKIE}=${pages.create()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PAGE_TTL_MS / 1000}${secure ? '; Secure' : ''}`,
    });
    return res.end();
  }

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    void err;
  });

  return server;
}

const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const PAGE_COOKIE = 'keysmith_page';
const PAGE_TTL_MS = 3600_000;
const PAGE_SESSIONS_MAX = 64;

/** Status-page logins: random tokens, unrelated to the key, that expire and open nothing else. */
function pageSessions() {
  const live = new Map(); // token -> expires at
  return {
    create() {
      const now = Date.now();
      for (const [t, exp] of live) if (exp <= now) live.delete(t);
      while (live.size >= PAGE_SESSIONS_MAX) live.delete(live.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      live.set(token, now + PAGE_TTL_MS);
      return token;
    },
    valid(token) {
      const exp = token ? live.get(token) : null;
      if (!exp) return false;
      if (exp > Date.now()) return true;
      live.delete(token);
      return false;
    },
  };
}

function cookieFrom(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
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
    explicit_only: !!a.explicitOnly,
    unsafe_tools: !!a.unsafeTools,
  }));
}

/* ---------------------------------------------------------------------- handlers */

async function handleChat(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS }) {
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
  let exclude = null;
  if (Array.isArray(body.tools) && body.tools.length) {
    const relay = await tryPassthrough(gateway, requested, body, req, res, { usage, log, t0, caller });
    if (relay.done) return;
    if (relay.refused.length) {
      // Those legs already said no to this very request: asking them again without the tools
      // spends their quota twice and can turn their refusal into a tool-less answer.
      exclude = new Set(relay.refused.map((r) => r.target));
      log(`tools requested; ${relay.refused.map((r) => `${r.target} refused (${r.status})`).join(', ')} — the rest of "${requested}" runs as a plain completion, without tools`);
    } else {
      log(`tools requested but no HTTP upstream matched for "${requested}" — running as a plain completion`);
    }
  }

  const chain = gateway.resolve(requested, { exclude });
  const publicId = session || null;
  res.setHeader('x-keysmith-route', chain.map((c) => c.target).join(','));

  if (!stream) {
    const { text, reasoning, usage: u, session: sid, retries, cutAt } = await gateway.collect({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning, exclude });
    meta.done = true;
    record(usage, { model: requested, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, client: req.headers['user-agent'], ...marks(retries, cutAt) });
    // The header carries the session for clients that read headers; the body carries it
    // for the ones that do not (curl, `keysmith chat`), and OpenAI SDKs ignore extras.
    const payload = openaiResult({ id, model: requested, created, text, usage: u, reasoning: body.include_reasoning ? reasoning || null : null });
    if (sid) payload.keysmith = { session: sid, resumed: !!publicId };
    return json(res, 200, payload, sid);
  }

  const events = await held(gateway.complete({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning, exclude }), holdMs);
  startSse(res, 'text/event-stream');
  res.write(`data: ${JSON.stringify(openaiChunk(id, requested, created, { role: 'assistant', content: '' }))}\n\n`);
  let text = '';
  let u = null;
  let sid = null;
  let errMessage = null;
  let reasoning = '';
  let retries = 0;
  let cutAt = null;
  for await (const evt of events) {
    if (evt.type === 'retry') {
      retries++;
    } else if (evt.type === 'cut') {
      cutAt = evt.tool;
    } else if (evt.type === 'reasoning') {
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
      errMessage = redactSecrets(evt.message);
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
  record(usage, { model: requested, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, client: req.headers['user-agent'], ...marks(retries, cutAt) });
}

async function handleAnthropic(req, res, gateway, { usage, log, holdMs = STREAM_HOLD_MS }) {
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
    const { text, usage: u, session: sid, retries, cutAt } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens });
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, client: 'anthropic', via: '/v1/messages', ...marks(retries, cutAt) });
    // Session goes out as a header only: Anthropic clients schema-check the body.
    return json(res, 200, anthropicResult({ id, model: body.model, text, usage: u }), sid);
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens }), holdMs);
  startSse(res, 'text/event-stream');
  writeAnthicHead(res, { id, model: body.model });
  // Headers are on the wire by now, so a streamed response cannot advertise the session
  // id — use stream=false (or /v1/chat/completions) when you need to continue a CLI thread.
  let u = null;
  let text = '';
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  for await (const evt of events) {
    if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'delta') {
      text += evt.text;
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: evt.text } });
    } else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: errMessage } });
  sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: errMessage ? 'error' : 'end_turn', stop_sequence: null }, usage: { output_tokens: u?.output || 0 } });
  sseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, client: 'anthropic', via: '/v1/messages', ...marks(retries, cutAt) });
  void log;
  void text;
}

async function handleResponses(req, res, gateway, { usage, log, holdMs = STREAM_HOLD_MS }) {
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
    const { text, usage: u, session: sid, retries, cutAt } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res) });
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, via: '/v1/responses', ...marks(retries, cutAt) });
    return json(res, 200, responsesResult({ id, model: body.model, text, usage: u, created }), sid);
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res) }), holdMs);
  startSse(res, 'text/event-stream');
  for (const e of responsesStreamEventsHead({ id, model: body.model })) sseEvent(res, e.event, e.data);
  let full = '';
  let u = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  for await (const evt of events) {
    if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'delta') {
      full += evt.text;
      sseEvent(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: evt.text });
    } else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'response.failed', { type: 'response.failed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: 'failed', error: { message: errMessage } } });
  else sseEvent(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${id}`, output_index: 0, content_index: 0, text: full });
  sseEvent(res, 'response.completed', { type: 'response.completed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: errMessage ? 'failed' : 'completed', usage: { input_tokens: u?.input || 0, output_tokens: u?.output || 0 } } });
  res.end();
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, via: '/v1/responses', ...marks(retries, cutAt) });
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
  // A refusal is the provider's error body, which can quote the key it refused; vectors are
  // passed on as they came.
  res.end(r.ok ? text : redactSecrets(text));
}

/**
 * Straight pipe to an HTTP upstream, byte for byte, used when the client asked for
 * tools. Only candidates that can honour that are tried, so a mixed route degrades
 * to the API-backed model instead of returning a tool-free answer.
 *
 * `{ done: true }` once an answer (or a broken one) went out; otherwise `{ done: false,
 * refused }`, the legs that refused this request, which the plain completion leaves out.
 */
async function tryPassthrough(gateway, requested, body, req, res, { usage, log, t0, caller = '' }) {
  let chain;
  try {
    chain = gateway.resolve(requested);
  } catch {
    return { done: false, refused: [] };
  }
  const candidates = chain.filter((c) => c.adapter.kind === 'http' && c.adapter.wire === 'openai');
  let lastError = null;
  const refused = [];
  for (const { adapter, model, target } of candidates) {
    try {
      const upstream = await adapter.rawChat({ ...body, model }, { caller });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        throw upstreamError(adapter.id, upstream, t, { keepStatus: true });
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'x-keysmith-mode': 'passthrough' });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      record(usage, { model: requested, status: 'ok', ms: Date.now() - t0, stream: !!body.stream, via: 'passthrough', client: req.headers['user-agent'] });
      return { done: true };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(`${adapter.id}: ${e.message}`, { status: /abort|timeout/i.test(e.message ?? '') ? 504 : 502, provider: adapter.id });
      lastError = routeError(lastError, err);
      refused.push({ target, status: err.status });
      log(`passthrough via ${adapter.id} failed: ${e.message}`);
      if (res.headersSent) {
        res.end();
        return { done: true };
      }
    }
  }
  // Every leg of this route could take the tools, and each one refused. Running the route
  // again as a plain completion would ask the same upstream a second time, drop the tools
  // without a word and turn a 429 into a 502: answer with what the provider said instead.
  // (A route with a CLI leg still falls back to that leg, tool-less, and only to it.)
  if (lastError && candidates.length === chain.length) throw lastError;
  return { done: false, refused };
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
 * A request the adapter had to run twice, or whose answer it ended at a tool call, says so
 * in the usage log; one that went straight through stays as it was.
 */
function marks(retries, cutAt) {
  return { ...(retries ? { retries } : {}), ...(cutAt ? { cutAt } : {}) };
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

/**
 * A streamed answer's status line waits for its first event, for up to `holdMs`. A refusal
 * that comes before then — a 429, a 503, a 401: the upstream's answer to the request itself,
 * after failover had its turn — is thrown from here while the status can still say so, with
 * its retry-after. An answer slower than that (a CLI starting up, a model thinking) gets its
 * 200 and `: stream open` at `holdMs`, and a failure after that is an SSE error frame.
 *
 * Returns the events, the first one included; closing it early closes `events` too, so the
 * adapter's own cleanup (a process killed, a fetch aborted) runs as it did before.
 */
async function held(events, holdMs) {
  const it = events[Symbol.asyncIterator]();
  const first = it.next();
  let timer;
  try {
    await Promise.race([first, new Promise((resolve) => (timer = setTimeout(resolve, holdMs)))]);
  } finally {
    clearTimeout(timer);
  }
  return (async function* () {
    try {
      for (let r = await first; !r.done; r = await it.next()) yield r.value;
    } finally {
      await it.return?.();
    }
  })();
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

/** The configured key a header presents (`Authorization: Bearer` or `x-api-key`), or null. */
function headerKey(req, keys) {
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'] || '';
  return keys.find((k) => safeEqual(String(k), String(candidate))) ?? null;
}

function headerAuthorized(req, keys) {
  return !keys.length || headerKey(req, keys) !== null;
}

/**
 * Who is asking: a hash of the gateway key the request presented — by header, or by
 * `?api_key=` for clients that cannot set one — `''` with auth off, null when no key fits.
 * What one caller's requests leave behind (Gemini's thought signatures) goes back up on that
 * caller's requests only; the hash keeps the key itself out of anything that remembers it.
 */
function callerOf(req, keys, url) {
  if (!keys.length) return '';
  let key = headerKey(req, keys);
  if (key === null) {
    const candidate = url.searchParams.get('api_key') || '';
    key = candidate ? (keys.find((k) => safeEqual(String(k), candidate)) ?? null) : null;
  }
  return key === null ? null : createHash('sha256').update(String(key)).digest('base64url').slice(0, 22);
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export { openaiResult, errorBody };
