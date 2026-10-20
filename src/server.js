import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LlmError } from './util.js';
import {
  chatId,
  openaiMessages,
  openaiResult,
  anthropicMessages,
  anthropicStreamEvents,
  responsesMessages,
  responsesResult,
  errorBody,
} from './protocols.js';
import { AnthropicStream, KEEPALIVE_MS, OpenaiChatStream, ResponsesStream, anthropicMessage, faceCall, openaiCompletion, responsesBody } from './tools/faces.js';
import { MAX_TOOLS, anthropicToolMessages, anthropicToolSpec, openaiLegacy, openaiToolCount, openaiToolMessages, openaiToolSpec, responsesStateRefusal, responsesToolCount, responsesToolMessages, responsesToolSpec } from './tools/model.js';
import { addUsage } from './tools/emulate.js';
import { loginPage, statusPage } from './status-page.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { upstreamError } from './http-adapter.js';
import { failureOf, scopeError } from './gateway.js';
import { authEnabled, describeScope, parseKeys, scopeWarnings, targetDecision } from './keys.js';
import { DailyQuota, overCapMessage } from './quota.js';

const MAX_BODY = 32 * 1024 * 1024;
const STREAM_HOLD_MS = 10_000;
/**
 * The routes that ask a model something: a request to one of them is what a key's daily cap
 * counts (quota.js). Listing models, routes or usage, and the status page, are not.
 */
const METERED = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/embeddings']);

export function createServer(gateway, cfg, { usage, log: write = () => {}, now = () => Date.now() } = {}) {
  // Every line this server logs can quote an upstream error; it leaves here redacted.
  const log = (m) => write(redactSecrets(m));
  // Each key, with what it may reach (keys.js): a bare key is unscoped, as it always was.
  // `authOn` is the list being there, not any entry in it parsing: a list of broken entries
  // opens nothing — it never turns into a keyless gateway.
  const authOn = authEnabled(cfg);
  const { entries: keys, issues: keyIssues } = authOn ? parseKeys(cfg.auth.keys) : { entries: [], issues: [] };
  for (const issue of keyIssues) log(`auth.keys: ${issue}`);
  // A hand-edited pattern that names nothing (`deny: ["Claude-API"]`) keeps nothing out: said at
  // start and on the status page, never refused — it may name an adapter that is added later.
  const keyWarnings = authOn ? scopeWarnings(cfg, keys) : [];
  for (const w of keyWarnings) log(`auth.keys: ${w.message}`);
  // The usage log redacts these from every line it writes; register them even when the
  // config did not come through loadConfig (an embedded server, a test).
  registerSecrets(cfg.auth?.keys);
  // Today's requests per key, rebuilt from today's usage rows: a restart does not hand a capped
  // key a fresh day (quota.js).
  const quota = new DailyQuota({ now });
  if (authOn) quota.seed(usage);
  const startedAt = Date.now();
  const pages = pageSessions();
  // How long a streamed answer's headers wait for its first event (see `held`).
  const holdMs = Number.isFinite(cfg.limits?.streamHoldMs) && cfg.limits.streamHoldMs >= 0 ? cfg.limits.streamHoldMs : STREAM_HOLD_MS;
  // How long an open stream may go without a byte before it gets a keepalive (faces.js); 0: never.
  const keepaliveMs = Number.isFinite(cfg.limits?.streamKeepaliveMs) && cfg.limits.streamKeepaliveMs >= 0 ? cfg.limits.streamKeepaliveMs : KEEPALIVE_MS;

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
    // A scoped key sees the page its scope allows: its adapters, models, aliases and usage.
    if (route === '/' || route === '/status') {
      if (req.method === 'POST') return pageLogin(req, res, route);
      if (req.method === 'GET') {
        const byHeader = authOn ? headerEntry(req, keys) : null;
        const viewer = !authOn ? { entry: null } : byHeader ? { entry: byHeader } : pages.session(cookieFrom(req, PAGE_COOKIE));
        if (!viewer) return send(res, 401, PAGE_HEADERS, loginPage({ action: route }));
        const scope = viewer.entry?.scope || null;
        const { models } = await safeList(gateway, scope);
        return send(res, 200, PAGE_HEADERS, statusPage({
          cfg: scope ? { ...cfg, adapters: visibleEntries(cfg.adapters, (id) => gateway.adapterVisible(id, scope)) } : cfg,
          models,
          usage,
          usageFilter: usageFilterFor(gateway, viewer.entry),
          startedAt,
          loadErrors: visibleEntries(gateway.loadErrors, (id) => gateway.adapterVisible(id, scope)),
          aliasIssues: gateway.aliasIssuesFor(scope),
          viewer: viewer.entry ? { fp: viewer.entry.fp, label: viewer.entry.label, scope: describeScope(scope), perDay: viewer.entry.perDay ?? null, today: quota.today(viewer.entry.fp) } : null,
          keys: authOn && !scope ? keys.map((k) => ({ fp: k.fp, label: k.label, scope: describeScope(k.scope), perDay: k.perDay ?? null, today: quota.today(k.fp), warnings: keyWarnings.filter((w) => w.fp === k.fp).map((w) => `${w.field} ${w.problem}`) })) : null,
          keyIssues: scope ? [] : keyIssues,
        }));
      }
    }

    const who = identify(req, keys, url, authOn);
    if (who === null) {
      return json(res, 401, errorBody('missing or invalid API key — send `Authorization: Bearer <key>`', 'authentication_error', 401));
    }
    const { caller, scope } = who;
    // Every usage row this request writes says which key it came with and what its scope did.
    const stamped = usage ? { record: (entry) => usage.record(stamp(entry, who, res)) } : null;

    try {
      // A request that asks a model counts against its key's daily cap before anything is read:
      // one per client request, whatever alias, failover or retry happens under it.
      if (req.method === 'POST' && METERED.has(route)) meter(who, route, stamped);
      if (route === '/v1/models' || route === '/models') {
        const { models, errors } = await gateway.listModels({ refresh: url.searchParams.has('refresh'), scope });
        return json(res, 200, { object: 'list', data: models, ...(errors.length ? { keysmith: { errors } } : {}) });
      }
      if (route === '/v1/keysmith/routes' && req.method === 'GET') {
        return json(res, 200, {
          adapters: describeAdapters(gateway).filter((a) => gateway.adapterVisible(a.id, scope)),
          failed_to_load: visibleEntries(gateway.loadErrors, (id) => gateway.adapterVisible(id, scope)),
          aliases: gateway.aliasesFor(scope),
          alias_warnings: gateway.aliasIssuesFor(scope),
          limits: cfg.limits,
        });
      }
      if (route === '/v1/keysmith/usage' && req.method === 'GET') {
        const n = Number(url.searchParams.get('tail') || 0);
        // A scoped key reads its own rows only (usageFilterFor): its summary counts its requests,
        // and its `keys` holds its own fingerprint and no other.
        const filter = usageFilterFor(gateway, who);
        return json(res, 200, { summary: usage?.summarize(Number(url.searchParams.get('hours') || 24) * 3600_000, filter), ...(n ? { entries: usage.tail(n, filter) } : {}) });
      }
      if (route === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope });
      if (route === '/v1/messages' && req.method === 'POST') return await handleAnthropic(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope });
      if (route === '/v1/responses' && req.method === 'POST') return await handleResponses(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope });
      if (route === '/v1/embeddings' && req.method === 'POST') return await handleEmbeddings(req, res, gateway, { usage: stamped, scope });
      return json(res, 404, errorBody(`no route ${req.method} ${route}`, 'invalid_request_error', 404));
    } catch (e) {
      const status = e instanceof LlmError ? e.status : 500;
      if (status >= 500) log(`${route} crashed: ${e.stack || e.message}`);
      // The client gets the error the way a log line does: an upstream message can quote
      // a provider key, and a client of this gateway was never given that key.
      const message = redactSecrets(e.message || String(e));
      const meta = res._keysmith;
      if (meta && !meta.done) {
        // A tool engine that failed still spent its runs: the error says what, and which engine.
        record(stamped, { model: meta.model, status: e?.scopeDenied ? 'denied' : 'error', ms: Date.now() - meta.t0, stream: meta.stream, error: message, client: req.headers['user-agent'], ...(meta.via ? { via: meta.via } : {}), ...errorMarks(e) });
      }
      if (res.headersSent) {
        // A stream that already started must be closed politely, in its face's own error frame
        // (an OpenAI error chunk and [DONE]; an Anthropic `error` event), or clients hang waiting
        // for a terminator that never comes — or take what came so far for the whole answer.
        if (meta?.face && !res.writableEnded) {
          meta.face.fail(message, e.type || 'upstream_error');
          return;
        }
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

  /**
   * Count one request of the key `who` came with, or refuse it: over the key's `perDay`, a 429
   * (`rate_limit_error`) with a `retry-after` up to local midnight, whose message names the cap
   * and never the key. The day's first refusal of a key writes a usage row (`status: "limited"`)
   * and a log line; the ones after it are counted (the status page shows them) but write
   * nothing, so a client that keeps asking cannot fill the disk.
   */
  function meter(who, route, stamped) {
    if (!who.fp) return; // auth off: there is no key to count against
    const d = quota.admit(who.fp, who.perDay ?? null);
    if (d.ok) return;
    const message = overCapMessage(d);
    if (d.first) {
      log(`key fp:${who.fp}${who.label ? ` (${who.label})` : ''} reached its daily cap of ${d.perDay} requests: refused until local midnight`);
      record(stamped, { model: null, status: 'limited', ms: 0, stream: false, via: route, error: message });
    }
    const e = new LlmError(message, { status: 429, type: 'rate_limit_error' });
    e.retryAfter = d.retryAfter;
    throw e;
  }

  async function pageLogin(req, res, route) {
    let body = '';
    for await (const c of req) {
      body += c;
      if (body.length > 4096) return send(res, 413, PAGE_HEADERS, loginPage({ action: route }));
    }
    const candidate = new URLSearchParams(body).get('api_key') || '';
    const entry = authOn ? matchKey(keys, candidate) : null;
    if (authOn && !entry) {
      return send(res, 401, PAGE_HEADERS, loginPage({ action: route, failed: true }));
    }
    const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
    res.writeHead(303, {
      location: route,
      'cache-control': 'no-store',
      // The cookie opens the page as the key that logged in: a scoped key's page is scoped.
      'set-cookie': `${PAGE_COOKIE}=${pages.create(entry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PAGE_TTL_MS / 1000}${secure ? '; Secure' : ''}`,
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

/**
 * Status-page logins: random tokens, unrelated to the key, that expire and open nothing else.
 * Each remembers which key logged in (its entry: fingerprint and scope, held in memory only),
 * so the page it opens is that key's page.
 */
function pageSessions() {
  const live = new Map(); // token -> { exp, entry }
  return {
    create(entry = null) {
      const now = Date.now();
      for (const [t, s] of live) if (s.exp <= now) live.delete(t);
      while (live.size >= PAGE_SESSIONS_MAX) live.delete(live.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      live.set(token, { exp: now + PAGE_TTL_MS, entry });
      return token;
    },
    /** `{ entry }` for a live token, null otherwise. */
    session(token) {
      const s = token ? live.get(token) : null;
      if (!s) return null;
      if (s.exp > Date.now()) return { entry: s.entry };
      live.delete(token);
      return null;
    },
  };
}

/**
 * The usage rows one key may read: every row for an unscoped key (or with auth off), as before.
 * A scoped key reads the rows it wrote itself — not another key's, not even for a model both may
 * name (an unscoped key's `smart` answered by claude-api is not this key's business) — and of
 * those, the ones for what it may still name, the way /v1/models lists it. `who` is the key's
 * entry, or identify()'s answer: `{ fp, scope }`.
 */
function usageFilterFor(gateway, who) {
  const scope = who?.scope;
  if (!scope) return null;
  const mine = `fp:${who.fp}`;
  // A refusal over the daily cap names no model: it is the key's own row all the same.
  return (e) => e?.key === mine && (e.status === 'limited' || gateway.mayName(e.model, scope));
}

/** `obj` with only the own entries whose key `keep` accepts. */
function visibleEntries(obj, keep) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([id]) => keep(id)));
}

function cookieFrom(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function safeList(gateway, scope = null) {
  try {
    return await gateway.listModels({ scope });
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
    // How it takes a request that offers tools: a CLI's toolMode, an HTTP upstream's relay.
    tool_mode: a.kind === 'cli' ? a.toolMode || 'off' : (a.wire || 'openai') === 'openai' ? 'passthrough' : 'off',
  }));
}

/* ---------------------------------------------------------------------- handlers */

async function handleChat(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null }) {
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
  // A scoped key's request is decided before anything runs — the tool relay included.
  if (scope) meta.skipped = gateway.resolve(requested, { scope }).skipped;
  // OpenAI's own limit, checked before the list is read: a body may be 32 MB, and a read of its
  // tools runs on the event loop every other client of this gateway shares.
  const offered = openaiToolCount(body);
  if (offered > MAX_TOOLS) throw new LlmError(`this request offers ${offered} tools; at most ${MAX_TOOLS} are taken (OpenAI's limit)`, { status: 400, type: 'invalid_request_error' });
  // A client that offered the older `functions` reads a call back as message.function_call.
  const legacy = openaiLegacy(body);

  // A request that offers tools walks its route for a leg that takes them, in declared order
  // (gateway._toolRoute, tools/router.js): an HTTP upstream gets the body verbatim (the relay
  // below writes its answer), a CLI with a toolMode answers through a tool engine. `out` is what
  // the relay and the stream share: which engine is running, and the stream's face once it opened.
  const out = { mode: null, face: null };
  const tools = offered
    ? { spec: openaiToolSpec(body), messages: openaiToolMessages(body), face: 'openai', state: out, caller, relay: (leg) => relayLeg(leg, { body, req, res, out, usage, log, t0, caller, requested }) }
    : null;

  const chain = gateway.resolve(requested, { scope });
  const publicId = session || null;
  res.setHeader('x-keysmith-route', chain.map((c) => c.target).join(','));

  if (!stream) {
    const { text, reasoning, usage: u, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge, relayed } = await gateway.collect({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning, scope, tools });
    if (relayed) {
      // An HTTP leg's answer went out verbatim, with its own usage row.
      meta.done = true;
      return;
    }
    const calls = toolCalls.map((c) => faceCall(c, 'openai'));
    // Written before the row: an answer the face cannot write is the error row, not an `ok` one.
    const payload = openaiCompletion({ id, model: requested, created, text, usage: u, reasoning: body.include_reasoning ? reasoning || null : null, toolCalls: calls, legacy });
    meta.done = true;
    record(usage, { model: requested, status: 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: false, client: req.headers['user-agent'], ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }) });
    // The header carries the session for clients that read headers; the body carries it
    // for the ones that do not (curl, `keysmith chat`), and OpenAI SDKs ignore extras.
    if (sid) payload.keysmith = { session: sid, resumed: !!publicId };
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    return json(res, 200, payload, sid);
  }

  const events = await held(gateway.complete({ model: requested, messages, session: publicId, signal: abortSignal(req, res), includeReasoning: !!body.include_reasoning, scope, tools }), holdMs);
  if (res.headersSent) {
    // An HTTP leg is answering verbatim — its status, its headers, its bytes — and writes its
    // own usage row: what is left here is waiting for it to finish.
    meta.done = true;
    for await (const evt of events) void evt;
    return;
  }
  // A stream's headers go out before its answer is known: the mode is the engine running now.
  startSse(res, 'text/event-stream', out.mode ? { 'x-keysmith-mode': out.mode } : {});
  const face = new OpenaiChatStream(res, { id, model: requested, created, includeUsage: !!body.stream_options?.include_usage, legacy, keepaliveMs, lazy: !!tools });
  meta.face = face;
  out.face = face;
  face.open();
  let u = null;
  let sid = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  for await (const evt of events) {
    if (evt.type === 'relayed') {
      // An HTTP leg took the open stream over (relayLeg) and finished it, row and all.
      meta.done = true;
      return;
    } else if (evt.type === 'retry') {
      retries++;
    } else if (evt.type === 'cut') {
      cutAt = evt.tool;
    } else if (evt.type === 'reasoning') {
      face.reasoning(evt.text);
    } else if (evt.type === 'delta') {
      face.text(evt.text);
    } else if (evt.type === 'tool_call') {
      face.toolCall(faceCall(evt, 'openai'));
    } else if (evt.type === 'tool_mode') {
      [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
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
  // and `x-keysmith-session` is still set on non-streaming responses. An error the
  // engine reported after the answer began replaces that chunk with the error frame.
  face.finish({ usage: u, keysmith: sid ? { session: sid, resumed: !!publicId } : null, error: errMessage });
  meta.done = true;
  record(usage, { model: requested, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: true, error: errMessage, client: req.headers['user-agent'], ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }) });
}

async function handleAnthropic(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null }) {
  const body = await readJson(req);
  const messages = anthropicMessages(body);
  if (!messages.length) throw new LlmError('messages is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId();
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const meta = track(res, body.model, stream, t0, '/v1/messages');
  if (scope) meta.skipped = gateway.resolve(body.model, { scope }).skipped;
  // The same bound as the chat face's: what an engine is handed (a prompt, a tools/list) has one.
  const offered = Array.isArray(body.tools) ? body.tools.length : 0;
  if (offered > MAX_TOOLS) throw new LlmError(`this request offers ${offered} tools; at most ${MAX_TOOLS} are taken`, { status: 400, type: 'invalid_request_error' });
  // Tools on this face reach a CLI leg with a toolMode; an HTTP leg is not handed them (there is
  // no verbatim relay for the Messages wire), so a route of those answers in text — or, when
  // tool_choice asks for a call, with an error.
  const out = { mode: null };
  const tools = offered ? { spec: anthropicToolSpec(body), messages: anthropicToolMessages(body), face: 'anthropic', state: out, caller, relay: null } : null;
  // The Messages API defaults to a single JSON reply; SSE only when asked.
  if (!stream) {
    const { text, usage: u, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, scope, tools });
    const calls = toolCalls.map((c) => faceCall(c, 'anthropic'));
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: false, client: 'anthropic', via: '/v1/messages', ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }) });
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    // Session goes out as a header only: Anthropic clients schema-check the body.
    return json(res, 200, anthropicMessage({ id, model: body.model, text, usage: u, toolCalls: calls }), sid);
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, scope, tools }), holdMs);
  startSse(res, 'text/event-stream', out.mode ? { 'x-keysmith-mode': out.mode } : {});
  const face = new AnthropicStream(res, { id, model: body.model, keepaliveMs });
  meta.face = face;
  face.open();
  // Headers are on the wire by now, so a streamed response cannot advertise the session
  // id — use stream=false (or /v1/chat/completions) when you need to continue a CLI thread.
  let u = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  for await (const evt of events) {
    if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'delta') face.text(evt.text);
    else if (evt.type === 'tool_call') face.toolCall(faceCall(evt, 'anthropic'));
    else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  face.finish({ usage: u, error: errMessage });
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: true, error: errMessage, client: 'anthropic', via: '/v1/messages', ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }) });
  void log;
}

async function handleResponses(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null }) {
  const body = await readJson(req);
  // keysmith stores no response: a body that names one (or a conversation, or an item of one), or
  // holds a result with no call before it, would be answered from the part it carries — with a 200.
  const stateless = responsesStateRefusal(body);
  if (stateless) throw new LlmError(stateless, { status: 400, type: 'invalid_request_error' });
  const messages = responsesMessages(body);
  if (!messages.length) throw new LlmError('input is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId('resp');
  const created = Math.floor(t0 / 1000);
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const meta = track(res, body.model, stream, t0, '/v1/responses');
  if (scope) meta.skipped = gateway.resolve(body.model, { scope }).skipped;
  // The same bound as the other faces': what an engine is handed (a prompt, a tools/list) has one.
  const offered = responsesToolCount(body);
  if (offered > MAX_TOOLS) throw new LlmError(`this request offers ${offered} tools; at most ${MAX_TOOLS} are taken`, { status: 400, type: 'invalid_request_error' });
  // Tools on this face reach a CLI leg with a toolMode (design U12), as on /v1/messages: no HTTP leg
  // is handed them (there is no verbatim relay for the Responses wire), so a route of those
  // answers in text — or, when tool_choice asks for a call, with an error.
  if (offered) return await responsesWithTools(req, res, gateway, body, { usage, caller, holdMs, keepaliveMs, scope, id, created, stream, session, meta, t0 });
  if (!stream) {
    const { text, usage: u, session: sid, retries, cutAt, toolCalls } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), scope });
    if (toolCalls.length) throw noResponsesToolCalls();
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, usage: u, stream: false, via: '/v1/responses', ...marks({ retries, cutAt }) });
    return json(res, 200, responsesResult({ id, model: body.model, text, usage: u, created }), sid);
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), scope }), holdMs);
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
    } else if (evt.type === 'tool_call') throw noResponsesToolCalls();
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'response.failed', { type: 'response.failed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: 'failed', error: { message: errMessage } } });
  else sseEvent(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${id}`, output_index: 0, content_index: 0, text: full });
  sseEvent(res, 'response.completed', { type: 'response.completed', response: { id: `resp_${id}`, object: 'response', model: body.model, status: errMessage ? 'failed' : 'completed', usage: { input_tokens: u?.input || 0, output_tokens: u?.output || 0 } } });
  res.end();
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, usage: u, stream: true, error: errMessage, via: '/v1/responses', ...marks({ retries, cutAt }) });
  void log;
}

/**
 * A Responses request that offers tools (design U12): its route walked for a leg that takes them
 * (gateway._toolRoute), the answer written by the Responses tool face — function_call items, or
 * text — streamed or not, with the usage row of the other faces (toolMode, toolCalls, fallback,
 * the bridge's session).
 */
async function responsesWithTools(req, res, gateway, body, { usage, caller, holdMs, keepaliveMs, scope, id, created, stream, session, meta, t0 }) {
  const out = { mode: null };
  const tools = { spec: responsesToolSpec(body), messages: responsesToolMessages(body), face: 'responses', state: out, caller, relay: null };
  const messages = responsesMessages(body);
  const request = { tools: body.tools, tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls };
  if (!stream) {
    const { text, usage: u, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), scope, tools });
    const calls = toolCalls.map((c) => faceCall(c, 'responses'));
    const payload = responsesBody({ id, model: body.model, created, text, usage: u, toolCalls: calls, request });
    meta.done = true;
    record(usage, { model: body.model, status: 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: false, via: '/v1/responses', ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }) });
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    return json(res, 200, payload, sid);
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), scope, tools }), holdMs);
  startSse(res, 'text/event-stream', out.mode ? { 'x-keysmith-mode': out.mode } : {});
  const face = new ResponsesStream(res, { id, model: body.model, created, request, keepaliveMs });
  meta.face = face;
  face.open();
  let u = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  for await (const evt of events) {
    if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'delta') face.text(evt.text);
    else if (evt.type === 'tool_call') face.toolCall(faceCall(evt, 'responses'));
    else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  face.finish({ usage: u, error: errMessage });
  meta.done = true;
  record(usage, { model: body.model, status: errMessage ? 'error' : 'ok', ms: Date.now() - t0, ...failedMarks(out.failed, u), stream: true, error: errMessage, via: '/v1/responses', ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }) });
}

/**
 * A Responses request that offers no tools never gets a call: no engine answers it with one. Should
 * one come all the same, it fails out loud — dropping it would hand the client an empty answer that
 * looks finished.
 */
function noResponsesToolCalls() {
  return new LlmError('this answer is a tool call, and the request offered no tools', { status: 502 });
}

async function handleEmbeddings(req, res, gateway, { usage, scope = null } = {}) {
  const body = await readJson(req);
  const t0 = Date.now();
  const meta = track(res, body.model, false, t0, '/v1/embeddings');
  const slash = String(body.model || '').indexOf('/');
  const adapterId = slash < 0 ? body.model : body.model.slice(0, slash);
  const upstreamModel = slash < 0 ? '' : body.model.slice(slash + 1);
  // Embeddings go straight to an adapter, past resolve(): the key's scope is checked here, the
  // same way, before the adapter is even looked up.
  if (scope && typeof body.model === 'string' && body.model) {
    // As named and as modelMap would map it — and an embedding with no model part goes up with
    // none (never the adapter's defaultModel), so that is what the scope decides.
    const d = upstreamModel ? gateway.checkTarget(adapterId, upstreamModel, scope) : targetDecision(scope, adapterId, ['']);
    if (!d.ok) throw scopeError(d.reason, adapterId);
  }
  const adapter = gateway.adapters.get(adapterId);
  if (!adapter || adapter.kind !== 'http') throw new LlmError('embeddings need an HTTP adapter', { status: 400 });
  const r = await fetch(`${adapter.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adapter.authHeaders(), ...adapter.headers },
    body: JSON.stringify({ ...body, model: upstreamModel }),
    signal: AbortSignal.timeout(adapter.timeoutMs),
  });
  const text = await r.text();
  meta.done = true;
  record(usage, { model: body.model, status: r.ok ? 'ok' : 'error', ms: Date.now() - t0, stream: false, via: '/v1/embeddings', ...(r.ok ? {} : { error: `${adapterId} ${r.status}` }) });
  res.writeHead(r.status, { 'content-type': 'application/json' });
  // A refusal is the provider's error body, which can quote the key it refused; vectors are
  // passed on as they came.
  res.end(r.ok ? text : redactSecrets(text));
}

/**
 * One HTTP leg of a tool request's route: the client's body to the upstream, byte for byte both
 * ways (gateway._toolRoute calls it, in the route's order). `true` once the upstream's answer —
 * or a broken one — went out; a refusal before that is thrown, and the route moves on.
 *
 * A streamed request's headers may already be out when the walk gets here (held(): an earlier
 * leg, a CLI working on its answer, took longer than limits.streamHoldMs). As long as the client
 * has had SSE comments only, an upstream that answers in SSE carries on in that stream; once the
 * face wrote a frame of its own, this leg cannot answer, and the route moves on — without asking
 * the upstream, whose answer could not go out (a request spent for nothing, on a quota of ~20 a
 * day for some models).
 */
async function relayLeg({ adapter, model }, { body, req, res, out, usage, log, t0, caller = '', requested }) {
  if (res.headersSent && (!out.face || out.face.wroteData)) throw cannotRelay(adapter.id, 'with another leg\'s frames in it');
  // Running from here: a stream whose hold ends while the upstream is asked opens as passthrough,
  // and its answer carries on in it. After a refusal the next leg names its own engine, and a
  // plain completion none (gateway._toolRoute).
  out.mode = 'passthrough';
  const upstream = await adapter.rawChat({ ...body, model }, { caller });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw upstreamError(adapter.id, upstream, t, { keepStatus: true });
  }
  if (res.headersSent) {
    // The hold ended while the upstream was asked: its answer carries on in the open stream,
    // when it is SSE (and the face, lazy, still wrote nothing but comments).
    const sse = /text\/event-stream/i.test(upstream.headers.get('content-type') || '');
    if (!sse || !out.face || out.face.wroteData) {
      await upstream.body?.cancel?.().catch(() => {});
      throw cannotRelay(adapter.id, sse ? 'with another leg\'s frames in it' : 'and the upstream answered without SSE');
    }
    out.face.detach();
  } else {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'x-keysmith-mode': 'passthrough' });
  }
  // This row is the request's only one: the retries of a tool leg that failed before it are counted here.
  const retries = (out.failed || []).reduce((n, f) => n + (f.retries || 0), 0);
  const row = { model: requested, ms: 0, stream: !!body.stream, via: 'passthrough', client: req.headers['user-agent'], toolMode: 'passthrough', ...failedMarks(out.failed, undefined), ...marks({ retries }) };
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    // Part of the answer is out: it is the answer, broken, and no other leg is asked.
    log(`passthrough via ${adapter.id} failed after it had started answering: ${e.message}`);
    res.end();
    record(usage, { ...row, status: 'error', ms: Date.now() - t0, error: redactSecrets(e.message || String(e)) });
    return true;
  }
  res.end();
  record(usage, { ...row, status: 'ok', ms: Date.now() - t0 });
  return true;
}

function cannotRelay(id, why) {
  return new LlmError(`${id}: the stream was already open ${why}, so its answer cannot be relayed`, { status: 502, provider: id });
}

/* ---------------------------------------------------------------------- plumbing */

/**
 * A row's `usage` with what the tool legs that failed before the answer spent added to it
 * (gateway._toolRoute's `state.failed`), and those legs named (`failedLegs`). Added, not merged:
 * mergeUsage keeps the larger of two reports of one run, and these are other runs.
 */
function failedMarks(failed, usage) {
  if (!failed?.length) return { usage };
  return { usage: failed.reduce((u, f) => addUsage(u, f.usage), usage ?? null) ?? usage, failedLegs: failed.map((f) => ({ ...f })) };
}

/** What an error that ends a request says it spent (emulate.js, gateway._toolRoute), for its row. */
function errorMarks(e) {
  if (!e || typeof e !== 'object') return {};
  const failure = failureOf(e);
  return {
    ...(e.usage ? { usage: e.usage } : {}),
    ...marks({ retries: e.retries || 0, toolMode: e.toolMode || null, fallback: e.fallback || null }),
    // Why the engine failed, as a code (the bridge's: `foreign_tool` for the tripwire): the
    // security event is in the row, not in the gateway log only.
    ...(failure ? { failure } : {}),
    ...(e.failedLegs?.length ? { failedLegs: e.failedLegs } : {}),
  };
}

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
 * What a usage row says about the key a request came with: its fingerprint (never the key)
 * and its scope's decision — `unscoped`, `allowed` (with `skipped`: the alias legs it left
 * out) or `denied`. With auth off there is no key, and the row is as it always was.
 */
function stamp(entry, who, res) {
  if (!who?.fp) return entry;
  const skipped = res._keysmith?.skipped;
  const scope = entry.status === 'denied' ? 'denied' : who.scope ? 'allowed' : 'unscoped';
  return { ...entry, key: `fp:${who.fp}`, scope, ...(skipped?.length && scope !== 'denied' ? { skipped } : {}) };
}

/**
 * A request the adapter had to run twice, or whose answer it ended at a tool call, says so
 * in the usage log; one that went straight through stays as it was. A tool request says which
 * engine answered (`toolMode`), how many calls it handed the client (`toolCalls`) and, when it
 * is not the engine picked first, why (`fallback`); an answer of the MCP bridge, which session
 * (`bridge.session`, its short id), reached how (`new`, `attached`, `cold`) and on its how-many-th
 * turn — names and counts only: never a tool's arguments or result, which are the client's data.
 */
function marks({ retries = 0, cutAt = null, toolMode = null, toolCalls = 0, fallback = null, bridge = null } = {}) {
  return {
    ...(retries ? { retries } : {}),
    ...(cutAt ? { cutAt } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(fallback ? { fallback } : {}),
    ...(bridge ? { bridge } : {}),
  };
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
function track(res, model, stream, t0, via = null) {
  res._keysmith = { model, stream, t0, done: false, via };
  return res._keysmith;
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
 * Events that put nothing in front of the client: an engine asking its CLI again (`retry`), a
 * run ended at a tool call (`cut`), which engine runs (`tool_mode`), a session id, a usage
 * report. None of them is an answer, so none of them opens a held stream.
 */
const QUIET_EVENTS = new Set(['retry', 'cut', 'tool_mode', 'session', 'usage']);
const HOLD_EXPIRED = Symbol('hold expired');

/**
 * A streamed answer's status line waits for the first event that is part of its answer — text,
 * a call, reasoning, an error frame — for up to `holdMs`. A refusal that comes before then — a
 * 429, a 503, a 401: the upstream's answer to the request itself, after failover had its turn; an
 * EMULATE leg that could not use its CLI's reply twice — is thrown from here while the status can
 * still say so, with its retry-after. An answer slower than that (a CLI starting up, a model
 * thinking) gets its 200 and `: stream open` at `holdMs`, and a failure after that is an SSE
 * error frame. Quiet events on the way (QUIET_EVENTS) are kept, and come first.
 *
 * Returns the events, the ones it waited through included; closing it early closes `events`
 * too, so the adapter's own cleanup (a process killed, a fetch aborted) runs as it did before.
 */
async function held(events, holdMs) {
  const it = events[Symbol.asyncIterator]();
  const kept = [];
  let next = it.next();
  let timer;
  const expired = new Promise((resolve) => (timer = setTimeout(resolve, holdMs, HOLD_EXPIRED)));
  try {
    for (;;) {
      const r = await Promise.race([next, expired]);
      if (r === HOLD_EXPIRED || r.done || !QUIET_EVENTS.has(r.value?.type)) break;
      kept.push(r.value);
      next = it.next();
    }
  } finally {
    clearTimeout(timer);
  }
  return (async function* () {
    try {
      for (const evt of kept) yield evt;
      for (let r = await next; !r.done; r = await it.next()) yield r.value;
    } finally {
      await it.return?.();
    }
  })();
}

function startSse(res, type, extra = {}) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...extra });
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

/** The configured key entry `candidate` is, or null. */
function matchKey(entries, candidate) {
  if (!candidate) return null;
  return entries.find((e) => safeEqual(e.key, String(candidate))) ?? null;
}

/** The configured key entry a header presents (`Authorization: Bearer` or `x-api-key`), or null. */
function headerEntry(req, entries) {
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'] || '';
  return matchKey(entries, candidate);
}

/**
 * Who is asking — by header, or by `?api_key=` for clients that cannot set one: null when no
 * key fits; with auth off, `{ caller: '' }` and no scope. Otherwise `{ caller, fp, label,
 * scope }`: `caller` is a hash of the key (what one caller's requests leave behind, Gemini's
 * thought signatures, goes back up on that caller's requests only), `fp` its fingerprint for
 * the usage log, `scope` what it may reach (null: everything), `perDay` its daily cap (null: none).
 */
function identify(req, entries, url, authOn) {
  if (!authOn) return { caller: '', fp: null, label: null, scope: null, perDay: null };
  const entry = headerEntry(req, entries) ?? matchKey(entries, url.searchParams.get('api_key') || '');
  if (!entry) return null;
  return { caller: createHash('sha256').update(entry.key).digest('base64url').slice(0, 22), fp: entry.fp, label: entry.label, scope: entry.scope, perDay: entry.perDay ?? null };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export { openaiResult, errorBody };
