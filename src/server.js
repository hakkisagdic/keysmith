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
  responsesUsage,
  errorBody,
} from './protocols.js';
import { AnthropicStream, KEEPALIVE_MS, OpenaiChatStream, ResponsesStream, anthropicMessage, faceCall, openaiCompletion, responsesBody } from './tools/faces.js';
import { MAX_TOOLS, anthropicToolMessages, anthropicToolSpec, openaiLegacy, openaiToolCount, openaiToolMessages, openaiToolSpec, responsesStateRefusal, responsesToolCount, responsesToolMessages, responsesToolSpec } from './tools/model.js';
import { addUsage } from './tools/emulate.js';
import { loginPage, statusPage } from './status-page.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { upstreamError, upstreamIdFromHeaders } from './http-adapter.js';
import { failureOf, legMetaOf, scopeError } from './gateway.js';
import { authEnabled, describeScope, parseKeys, scopeWarnings, targetDecision } from './keys.js';
import { DailyQuota, overCapMessage } from './quota.js';
import { requestEffort } from './effort.js';
import { TAIL_RING_MAX, computeCost, credentialAccount, parseTag, roundUsd } from './usage.js';

const MAX_BODY = 32 * 1024 * 1024;
const STREAM_HOLD_MS = 10_000;
const UHP_DEFAULT_VERSION = '2026-10-19';
const UHP_VERSIONS = ['2026-10-19', '2026-09-28', '2026-09-12', '2026-08-11'];
/**
 * The routes that ask a model something, plus `/v1/keysmith/usage`: a request to one of them is
 * what a key's daily cap counts (quota.js). Listing models or routes, and the status page, are not.
 */
const METERED = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/embeddings']);

export function createServer(gateway, cfg, { usage, log: write = () => {}, now: customNow = null } = {}) {
  const now = customNow || (usage?.now ? () => {
    const v = usage.now();
    return v instanceof Date ? v.getTime() : Number(v);
  } : () => Date.now());
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
  if (usage) {
    if (!gateway.usage) gateway.usage = usage;
    if (!usage.pricing && cfg?.pricing) usage.pricing = cfg.pricing;
    if (!usage.log) usage.log = log;
    if (customNow) usage.now = customNow;
  }
  // Today's requests per key, rebuilt from today's usage rows: a restart does not hand a capped
  // key a fresh day (quota.js).
  const quota = new DailyQuota({ now });
  if (authOn) quota.seed(usage);
  const startedAt = Date.now();
  const pages = pageSessions();
  const responseStore = createResponseStore({ now });
  const idempotencyStore = createIdempotencyStore({ now });
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
    wrapBytesOut(res);
    req._bytesIn = 0;
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch {
      // `GET //a:99999/` or `GET http://a:99999/?api_key=…`: a target that does not parse.
      // Nothing is checked yet, so nothing is said — and the target is never echoed.
      return json(res, 400, errorBody('malformed request target', 'invalid_request_error', 400));
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-keysmith-session,x-keysmith-tag,x-api-key,anthropic-version,uhp-version,idempotency-key,x-harness-id,traceparent,tracestate');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

    // UHP-Version header negotiation (UHP 2026-10-19).
    const requestedUhpVersion = typeof req.headers['uhp-version'] === 'string' ? req.headers['uhp-version'].trim() : '';
    if (requestedUhpVersion && !UHP_VERSIONS.includes(requestedUhpVersion)) {
      res.setHeader('UHP-Version', UHP_DEFAULT_VERSION);
      return json(res, 400, errorBody(`Unsupported UHP-Version "${requestedUhpVersion}". Supported versions: ${UHP_VERSIONS.join(', ')}`, 'unsupported_protocol_version', 400));
    }
    const negotiatedUhpVersion = requestedUhpVersion || UHP_DEFAULT_VERSION;
    res.setHeader('UHP-Version', negotiatedUhpVersion);

    if (req.method === 'OPTIONS') return send(res, 204, {}, '');

    if (route === '/healthz') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000), adapters: gateway.publicAdapters.length, failed_to_load: Object.keys(gateway.loadErrors).length, alias_warnings: Object.keys(gateway.aliasIssues).length }));
    // Unauthenticated UHP protocol discovery endpoint (UHP 2026-10-19).
    if ((route === '/v1/uhp' || route === '/uhp' || route === '/.well-known/uhp') && req.method === 'GET') {
      return json(res, 200, {
        object: 'uhp.info',
        uhp_version: negotiatedUhpVersion,
        supported_versions: UHP_VERSIONS,
        conformance_level: 'core+tools+state',
        server: {
          name: 'keysmith',
          implementation: 'keysmith-unified-core',
        },
        capabilities: {
          responses: true,
          streaming: true,
          stateful_continuation: true,
          response_retrieval: true,
          harnesses: true,
          client_tools: true,
          idempotency: true,
          w3c_trace_context: true,
        },
        endpoints: {
          uhp: '/v1/uhp',
          harnesses: '/v1/harnesses',
          models: '/v1/models',
          responses: '/v1/responses',
          chat_completions: '/v1/chat/completions',
          messages: '/v1/messages',
        },
      });
    }
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
        const uFilter = usageFilterFor(gateway, viewer.entry);
        return send(res, 200, PAGE_HEADERS, statusPage({
          cfg: scope ? { ...cfg, adapters: visibleEntries(cfg.adapters, (id) => gateway.adapterVisible(id, scope)) } : cfg,
          models,
          usage,
          usageFilter: uFilter,
          spend: visibleSpend(usage, cfg, gateway, scope, viewer.entry),
          usageErrors: usage?.readErrors?.() || [],
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
    const stamped = usage ? { record: (entry) => usage.record(stamp({ ts: new Date(now()).toISOString(), ...entry }, { who, req, res, route, gateway, cfg })) } : null;

    let meteredRequest = false;
    try {
      // A request that asks a model (or queries /v1/keysmith/usage) counts against its key's daily
      // cap before anything is read: one per client request, whatever alias, failover or retry happens under it.
      if ((req.method === 'POST' && METERED.has(route)) || (req.method === 'GET' && route === '/v1/keysmith/usage')) {
        meter(who, route, stamped, req);
        meteredRequest = true;
      }
      if (route === '/v1/models' || route === '/models') {
        const { models, errors } = await gateway.listModels({ refresh: url.searchParams.has('refresh'), scope });
        return json(res, 200, { object: 'list', data: models, ...(errors.length ? { keysmith: { errors } } : {}) });
      }
      if ((route === '/v1/harnesses' || route === '/harnesses') && req.method === 'GET') {
        const harnesses = gateway.publicAdapters
          .filter((a) => gateway.adapterVisible(a.id, scope))
          .map((a) => describeHarness(a));
        return json(res, 200, { object: 'list', data: harnesses });
      }
      const harnessModelsMatch = route.match(/^\/(?:v1\/)?harnesses\/([^/]+)\/models$/);
      if (harnessModelsMatch && req.method === 'GET') {
        const hid = decodeURIComponent(harnessModelsMatch[1]);
        const adapter = gateway.adapters.get(hid);
        if (!adapter || adapter.disabled || !gateway.adapterVisible(hid, scope)) {
          throw new LlmError(`unknown harness "${hid}"`, { status: 404, type: 'not_found_error' });
        }
        const { models } = await gateway.listModels({ refresh: url.searchParams.has('refresh'), scope });
        const owned = models.filter((m) => m.owned_by === hid || m.id === hid || m.id.startsWith(`${hid}/`));
        return json(res, 200, { object: 'list', data: owned });
      }
      const harnessMatch = route.match(/^\/(?:v1\/)?harnesses\/([^/]+)$/);
      if (harnessMatch && req.method === 'GET') {
        const hid = decodeURIComponent(harnessMatch[1]);
        const adapter = gateway.adapters.get(hid);
        if (!adapter || adapter.disabled || !gateway.adapterVisible(hid, scope)) {
          throw new LlmError(`unknown harness "${hid}"`, { status: 404, type: 'not_found_error' });
        }
        return json(res, 200, describeHarness(adapter));
      }
      const responseGetMatch = route.match(/^\/(?:v1\/)?responses\/([^/]+)$/);
      if (responseGetMatch && req.method === 'GET') {
        const respId = decodeURIComponent(responseGetMatch[1]);
        const stored = responseStore.get(respId, caller);
        if (!stored) {
          throw new LlmError(`Response "${respId}" not found`, { status: 404, type: 'not_found_error' });
        }
        return json(res, 200, stored.response);
      }
      if (route === '/v1/keysmith/routes' && req.method === 'GET') {
        return json(res, 200, {
          adapters: describeAdapters(gateway).filter((a) => gateway.adapterVisible(a.id, scope)),
          failed_to_load: visibleEntries(gateway.loadErrors, (id) => gateway.adapterVisible(id, scope)),
          aliases: gateway.aliasesFor(scope),
          alias_warnings: gateway.aliasIssuesFor(scope),
          limits: visibleLimits(cfg, gateway, scope),
        });
      }
      if (route === '/v1/keysmith/usage' && req.method === 'GET') {
        const rawTail = url.searchParams.get('tail');
        let n = 0;
        if (rawTail !== null && rawTail !== '') {
          const parsedTail = Number(rawTail);
          if (!Number.isInteger(parsedTail) || parsedTail < 0 || parsedTail > TAIL_RING_MAX) {
            throw new LlmError(`tail must be an integer between 0 and ${TAIL_RING_MAX}`, { status: 400, type: 'invalid_request_error' });
          }
          n = parsedTail;
        }
        // A scoped key reads its own rows only (usageFilterFor): its summary counts its requests,
        // and its `keys` holds its own fingerprint and no other.
        const filter = usageFilterFor(gateway, who);
        const byParam = url.searchParams.getAll('by');
        const sinceParam = url.searchParams.get('since');
        const untilParam = url.searchParams.get('until');
        const hoursParam = url.searchParams.has('hours') ? Number(url.searchParams.get('hours')) : null;
        let stats = null;
        try {
          stats = usage?.query({
            by: byParam.length ? byParam : ['model'],
            since: sinceParam,
            until: untilParam,
            hours: hoursParam,
            filter,
            now: now(),
            fromDays: true,
          });
        } catch (err) {
          throw new LlmError(err.message, { status: 400, type: 'invalid_request_error' });
        }
        const spend = visibleSpend(usage, cfg, gateway, scope, who);
        const daily = authOn ? (usage?.dailySummary?.(keys, { who, quota, now: now() }) || []) : [];
        return json(res, 200, {
          ...(stats || {}),
          summary: stats,
          ...(spend.length ? { spend } : {}),
          ...(daily.length ? { daily } : {}),
          ...(n ? { entries: usage.tail(n, filter) } : {}),
        });
      }
      if (route === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope });
      if (route === '/v1/messages' && req.method === 'POST') return await handleAnthropic(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope });
      if (route === '/v1/responses' && req.method === 'POST') return await handleResponses(req, res, gateway, { usage: stamped, log, caller, holdMs, keepaliveMs, scope, responseStore, idempotencyStore });
      if (route === '/v1/embeddings' && req.method === 'POST') return await handleEmbeddings(req, res, gateway, { usage: stamped, scope });
      return json(res, 404, errorBody(`no route ${req.method} ${route}`, 'invalid_request_error', 404));
    } catch (e) {
      const status = e instanceof LlmError ? e.status : 500;
      if (status >= 500) log(`${route} crashed: ${e.stack || e.message}`);
      // The client gets the error the way a log line does: an upstream message can quote
      // a provider key, and a client of this gateway was never given that key.
      const message = redactSecrets(e.message || String(e));
      const meta = res._keysmith;
      const faceName = faceFromRoute(route);
      let pendingErrBody = null;
      if (res.headersSent) {
        // A stream that already started must be closed politely, in its face's own error frame
        // (an OpenAI error chunk and [DONE]; an Anthropic `error` event), or clients hang waiting
        // for a terminator that never comes — or take what came so far for the whole answer.
        if (meta?.face && !res.writableEnded) {
          meta.face.fail(message, e.type || 'upstream_error');
        } else {
          if ((res.getHeader('content-type') || '').includes('text/event-stream')) {
            res.write(`data: ${JSON.stringify({ error: { message: `keysmith: ${message}`, type: e.type || 'upstream_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
          }
          res.end();
        }
      } else {
        // A provider's "retry after N s" is for the client's backoff: pass it on.
        if (e?.retryAfter) res.setHeader('retry-after', String(e.retryAfter));
        pendingErrBody = JSON.stringify(errorBody(message, e instanceof LlmError ? e.type : 'internal_error', status, e?.provider || null, faceName));
      }
      if (meta && !meta.done) {
        // A tool engine that failed still spent its runs: the error says what, and which engine.
        record(stamped, {
          model: meta.model,
          status: e?.scopeDenied ? 'denied' : 'error',
          ms: Date.now() - meta.t0,
          stream: meta.stream,
          error: message,
          client: req.headers['user-agent'],
          ...(pendingErrBody !== null ? { bytesOut: (res._bytesOut || 0) + Buffer.byteLength(pendingErrBody, 'utf8') } : {}),
          ...(meta.via ? { via: meta.via } : {}),
          ...(e?.leg ? { _leg: e.leg } : {}),
          ...(e?.upstreamId ? { upstreamId: e.upstreamId } : {}),
          ...errorMarks(e),
        });
      } else if (meteredRequest && !meta && who?.fp) {
        usage?.noteUnloggedFailure?.(who.fp, now(), {
          label: who.label,
          route,
          face: faceFromRoute(route),
          client: req.headers['user-agent'],
          tag: parseTag(req.headers['x-keysmith-tag']),
        });
      }
      if (pendingErrBody !== null) {
        send(res, status, { 'content-type': 'application/json; charset=utf-8' }, pendingErrBody);
      }
      return;
    }
  }

  /**
   * Count one request of the key `who` came with, or refuse it: over the key's `perDay`, a 429
   * (`rate_limit_error`) with a `retry-after` up to local midnight, whose message names the cap
   * and never the key. The day's first refusal of a key writes a usage row (`status: "limited"`)
   * and a log line; the ones after it are counted (the status page shows them) but write
   * nothing, so a client that keeps asking cannot fill the disk.
   */
  function meter(who, route, stamped, req = null) {
    if (!who.fp) return; // auth off: there is no key to count against
    const d = quota.admit(who.fp, who.perDay ?? null);
    if (d.ok) {
      usage?.noteDaily?.(who.fp, quota.today(who.fp), now(), { label: who.label, route });
      return;
    }
    const message = overCapMessage(d);
    if (d.first) {
      log(`key fp:${who.fp}${who.label ? ` (${who.label})` : ''} reached its daily cap of ${d.perDay} requests: refused until local midnight`);
      const errJson = JSON.stringify(errorBody(message, 'rate_limit_error', 429, null, faceFromRoute(route)));
      record(stamped, {
        model: null,
        status: 'limited',
        ms: 0,
        stream: false,
        via: route,
        error: message,
        client: req?.headers?.['user-agent'],
        bytesOut: Buffer.byteLength(errJson, 'utf8'),
      });
    }
    usage?.noteDaily?.(who.fp, quota.today(who.fp), now(), {
      label: who.label,
      route,
      face: faceFromRoute(route),
      client: req?.headers?.['user-agent'],
      tag: parseTag(req?.headers?.['x-keysmith-tag']),
      extraRefusal: !d.first,
    });
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
  // A refusal over the daily cap (or a model-less failure before routing) names no model: it is the key's own row all the same.
  const fn = (e) => e?.key === mine && (e.status === 'limited' || !e.model || gateway.mayName(e.model, scope));
  fn._cacheKey = mine;
  return fn;
}

/** `obj` with only the own entries whose key `keep` accepts. */
function visibleEntries(obj, keep) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([id]) => keep(id)));
}

function reachableAdapters(cfg, gateway, scope) {
  const out = new Set();
  for (const a of gateway.publicAdapters || []) {
    if (gateway.adapterVisible(a.id, scope)) out.add(a.id);
  }
  for (const [id, raw] of Object.entries(cfg?.adapters || {})) {
    if (!raw || typeof raw !== 'object' || raw.disabled) continue;
    if (gateway.adapterVisible(id, scope)) out.add(id);
  }
  return out;
}

function reachableAccounts(cfg, gateway, scope) {
  const out = new Set();
  for (const a of gateway.publicAdapters || []) {
    if (gateway.adapterVisible(a.id, scope) && a.account) out.add(a.account);
  }
  for (const [id, raw] of Object.entries(cfg?.adapters || {})) {
    if (!raw || typeof raw !== 'object' || raw.disabled) continue;
    if (!gateway.adapterVisible(id, scope)) continue;
    const acct = credentialAccount(raw);
    if (acct) out.add(acct);
  }
  return out;
}

/**
 * Limits visible to a caller on /v1/keysmith/routes: a scoped key sees only the spend caps on
 * adapters and accounts it can reach, normalised across every accepted spend-key form (`adapters`,
 * `accounts`, `adapter:<id>`, `account:<name>`, and flat adapter or account keys); non-spend
 * limits (`streamHoldMs`, `keepaliveMs`, etc.) stay.
 */
function visibleLimits(cfg, gateway, scope) {
  const raw = cfg?.limits || {};
  if (!scope || !raw.spend || typeof raw.spend !== 'object' || Array.isArray(raw.spend)) return raw;
  const adapters = reachableAdapters(cfg, gateway, scope);
  const accounts = reachableAccounts(cfg, gateway, scope);
  const knownAdapters = new Set([
    ...Object.keys(cfg?.adapters || {}),
    ...(gateway.adapters ? gateway.adapters.keys() : []),
  ]);
  const spend = {};
  for (const [k, v] of Object.entries(raw.spend)) {
    if ((k === 'adapters' || k === 'adapter' || k === 'byAdapter') && v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = {};
      for (const [id, cap] of Object.entries(v)) {
        if (adapters.has(id.trim())) sub[id] = cap;
      }
      if (Object.keys(sub).length) spend[k] = sub;
    } else if ((k === 'accounts' || k === 'account' || k === 'byAccount') && v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = {};
      for (const [acct, cap] of Object.entries(v)) {
        if (accounts.has(acct.trim())) sub[acct] = cap;
      }
      if (Object.keys(sub).length) spend[k] = sub;
    } else if (k.startsWith('adapter:')) {
      const id = k.slice('adapter:'.length).trim();
      if (adapters.has(id)) spend[k] = v;
    } else if (k.startsWith('account:')) {
      const acct = k.slice('account:'.length).trim();
      if (accounts.has(acct)) spend[k] = v;
    } else {
      const target = k.trim();
      if (knownAdapters.has(target) ? adapters.has(target) : accounts.has(target)) {
        spend[k] = v;
      }
    }
  }
  return { ...raw, spend };
}

/** Monthly spend caps visible to a caller (`scope` null: all; scoped: only adapters/accounts it can reach). */
function visibleSpend(usage, cfg, gateway, scope, who = null) {
  const callerKey = scope && who?.fp ? `fp:${who.fp}` : null;
  const raw = usage?.spendSummary?.(cfg?.limits?.spend, { adapters: cfg?.adapters, callerKey }) || [];
  if (!scope) return raw;
  const visibleAdapters = reachableAdapters(cfg, gateway, scope);
  const visibleAccounts = reachableAccounts(cfg, gateway, scope);
  return raw.filter((s) => (s.kind === 'adapter' ? visibleAdapters.has(s.target) : visibleAccounts.has(s.target)));
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
    tool_mode: a.kind === 'cli' ? a.toolMode || 'off' : a.wire === 'traycer' ? ((a.toolMode || 'auto') === 'off' ? 'off' : 'emulate') : (a.wire || 'openai') === 'openai' || a.wire === 'uhp' ? 'passthrough' : 'off',
    // The media it takes (image, pdf, audio, video); one it does not take reads as a text label.
    vision: !!a.vision,
    media: a.media || [],
  }));
}

/**
 * Describe an adapter in UHP `harness` format (`GET /v1/harnesses` & `GET /v1/harnesses/:id`).
 */
function describeHarness(a) {
  const toolMode = a.kind === 'cli' ? a.toolMode || 'off' : a.wire === 'traycer' ? ((a.toolMode || 'auto') === 'off' ? 'off' : 'emulate') : (a.wire || 'openai') === 'openai' || a.wire === 'uhp' ? 'passthrough' : 'off';
  return {
    id: a.id,
    object: 'harness',
    name: a.id,
    kind: a.kind,
    wire: a.wire || (a.kind === 'cli' ? 'cli' : 'openai'),
    status: 'available',
    priority: a.priority,
    default_model: a.defaultModel || null,
    capabilities: {
      streaming: true,
      sessions: !!(a.resumable || a.wire === 'uhp'),
      client_tools: toolMode !== 'off',
      tool_mode: toolMode,
      vision: !!a.vision,
      media: a.media || [],
      effort: a.kind === 'cli' ? a.effortLevels || null : null,
    },
  };
}

/* ---------------------------------------------------------------------- handlers */

async function handleChat(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null }) {
  const body = await readJson(req);
  const messages = openaiMessages(body);
  if (!messages.length) throw new LlmError('messages is empty', { status: 400 });
  const harnessId = extractHarnessId(req, body);
  const requested = resolveRequestedModel(gateway, body.model, { harnessId, backend: body.backend, scope });
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const trace = extractW3cTrace(req, res);
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
  // The reasoning effort the client chose (reasoning_effort, reasoning.effort): a CLI leg whose argv
  // takes one runs at it, checked against its catalogue (src/effort.js).
  const effort = requestEffort(body, 'openai');
  // A client that offered the older `functions` reads a call back as message.function_call.
  const legacy = openaiLegacy(body);

  // A request that offers tools — or whose history holds tool calls — walks its route for a leg
  // that takes them, in declared order (gateway._toolRoute, tools/router.js): an HTTP upstream on
  // the openai wire gets the body verbatim (the relay below writes its answer), a CLI with a
  // toolMode answers a request that offers tools through a tool engine. `out` is what the relay and
  // the stream share: which engine is running, and the stream's face once it opened.
  const out = { mode: null, face: null };
  const hasToolHistory = !offered && hasOpenaiToolHistory(body);
  const tools =
    offered || hasToolHistory
      ? {
          spec: offered ? openaiToolSpec(body) : { tools: [], choice: { mode: 'auto' }, parallel: true, unsupported: [], historyOnly: true },
          messages: offered ? openaiToolMessages(body) : [],
          face: 'openai',
          state: out,
          caller,
          relay: (leg) => relayLeg(leg, { body, req, res, out, usage, log, t0, caller, requested }),
        }
      : null;

  const chain = gateway.resolve(requested, { scope });
  const publicId = session || null;
  res.setHeader('x-keysmith-route', chain.map((c) => c.target).join(','));

  if (!stream) {
    const { text, reasoning, usage: u, usageReason, effort: ran, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge, relayed, leg, upstreamId } = await gateway.collect({ model: requested, messages, session: publicId, signal: abortSignal(req, res), maxTokens: body.max_tokens, maxCompletionTokens: body.max_completion_tokens, temperature: body.temperature, includeReasoning: !!body.include_reasoning, scope, tools, effort, harnessId, trace });
    if (relayed) {
      // An HTTP leg's answer went out verbatim, with its own usage row.
      meta.done = true;
      return;
    }
    const calls = toolCalls.map((c) => faceCall(c, 'openai'));
    // Written before the row: an answer the face cannot write is the error row, not an `ok` one.
    const payload = openaiCompletion({ id, model: requested, created, text, usage: faceUsage(u, usageReason), reasoning: body.include_reasoning ? reasoning || null : null, toolCalls: calls, legacy });
    // The header carries the session for clients that read headers; the body carries it
    // for the ones that do not (curl, `keysmith chat`), and OpenAI SDKs ignore extras.
    if (sid) payload.keysmith = { session: sid, resumed: !!publicId };
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    meta.done = true;
    json(res, 200, payload, sid);
    record(usage, {
      model: requested,
      status: 'ok',
      ms: Date.now() - t0,
      ...usageMarks(out.failed, u, usageReason),
      stream: false,
      client: req.headers['user-agent'],
      ...(leg ? { _leg: leg } : {}),
      ...(upstreamId ? { upstreamId } : {}),
      ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }),
      ...effortMarks(ran),
    });
    return;
  }

  const events = await held(gateway.complete({ model: requested, messages, session: publicId, signal: abortSignal(req, res), maxTokens: body.max_tokens, maxCompletionTokens: body.max_completion_tokens, temperature: body.temperature, includeReasoning: !!body.include_reasoning, scope, tools, effort, harnessId, trace }), holdMs);
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
  let uReason = null;
  let ran = null;
  let sid = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  let leg = null;
  let upstreamId = null;
  for await (const evt of events) {
    if (evt.type === 'relayed') {
      // An HTTP leg took the open stream over (relayLeg) and finished it, row and all.
      meta.done = true;
      return;
    } else if (evt.type === 'leg') {
      leg = evt.leg;
    } else if (evt.type === 'upstream' && evt.upstreamId) {
      upstreamId = evt.upstreamId;
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
    } else if (evt.type === 'usage_unknown') {
      uReason ||= evt.reason;
    } else if (evt.type === 'effort') {
      ran = evt;
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
  face.finish({ usage: faceUsage(u, uReason), keysmith: sid ? { session: sid, resumed: !!publicId } : null, error: errMessage });
  meta.done = true;
  record(usage, {
    model: requested,
    status: errMessage ? 'error' : 'ok',
    ms: Date.now() - t0,
    ...usageMarks(out.failed, u, uReason),
    stream: true,
    error: errMessage,
    client: req.headers['user-agent'],
    ...(leg ? { _leg: leg } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }),
    ...effortMarks(ran),
  });
}

async function handleAnthropic(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null }) {
  const body = await readJson(req);
  const messages = anthropicMessages(body);
  if (!messages.length) throw new LlmError('messages is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId();
  const stream = !!body.stream;
  const session = sessionFrom(req, body);
  const harnessId = extractHarnessId(req, body);
  const requested = resolveRequestedModel(gateway, body.model, { harnessId, backend: body.backend, scope });
  const trace = extractW3cTrace(req, res);
  const meta = track(res, requested, stream, t0, '/v1/messages');
  if (scope) meta.skipped = gateway.resolve(requested, { scope }).skipped;
  // The same bound as the chat face's: what an engine is handed (a prompt, a tools/list) has one.
  const offered = Array.isArray(body.tools) ? body.tools.length : 0;
  if (offered > MAX_TOOLS) throw new LlmError(`this request offers ${offered} tools; at most ${MAX_TOOLS} are taken`, { status: 400, type: 'invalid_request_error' });
  // The Messages API's effort: output_config.effort.
  const effort = requestEffort(body, 'anthropic');
  // Tools on this face reach a CLI leg with a toolMode; an HTTP leg is not handed them (there is
  // no verbatim relay for the Messages wire), so a route of those answers in text — or, when
  // tool_choice asks for a call, with an error.
  const out = { mode: null };
  const tools = offered ? { spec: anthropicToolSpec(body), messages: anthropicToolMessages(body), face: 'anthropic', state: out, caller, relay: null } : null;
  // The Messages API defaults to a single JSON reply; SSE only when asked.
  if (!stream) {
    const { text, usage: u, usageReason, effort: ran, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge, leg, upstreamId } = await gateway.collect({ model: requested, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, scope, tools, effort, harnessId, trace });
    const calls = toolCalls.map((c) => faceCall(c, 'anthropic'));
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    meta.done = true;
    // Session goes out as a header only: Anthropic clients schema-check the body.
    json(res, 200, anthropicMessage({ id, model: requested, text, usage: faceUsage(u, usageReason), toolCalls: calls }), sid);
    record(usage, {
      model: requested,
      status: 'ok',
      ms: Date.now() - t0,
      ...usageMarks(out.failed, u, usageReason),
      stream: false,
      client: req.headers['user-agent'] || 'anthropic',
      via: '/v1/messages',
      ...(leg ? { _leg: leg } : {}),
      ...(upstreamId ? { upstreamId } : {}),
      ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }),
      ...effortMarks(ran),
    });
    return;
  }
  const events = await held(gateway.complete({ model: requested, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, scope, tools, effort, harnessId, trace }), holdMs);
  startSse(res, 'text/event-stream', out.mode ? { 'x-keysmith-mode': out.mode } : {});
  const face = new AnthropicStream(res, { id, model: requested, keepaliveMs });
  meta.face = face;
  face.open();
  // Headers are on the wire by now, so a streamed response cannot advertise the session
  // id — use stream=false (or /v1/chat/completions) when you need to continue a CLI thread.
  let u = null;
  let uReason = null;
  let ran = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  let leg = null;
  let upstreamId = null;
  for await (const evt of events) {
    if (evt.type === 'leg') leg = evt.leg;
    else if (evt.type === 'upstream' && evt.upstreamId) upstreamId = evt.upstreamId;
    else if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'usage_unknown') uReason ||= evt.reason;
    else if (evt.type === 'effort') ran = evt;
    else if (evt.type === 'delta') face.text(evt.text);
    else if (evt.type === 'tool_call') face.toolCall(faceCall(evt, 'anthropic'));
    else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  face.finish({ usage: faceUsage(u, uReason), error: errMessage });
  meta.done = true;
  record(usage, {
    model: requested,
    status: errMessage ? 'error' : 'ok',
    ms: Date.now() - t0,
    ...usageMarks(out.failed, u, uReason),
    stream: true,
    error: errMessage,
    client: req.headers['user-agent'] || 'anthropic',
    via: '/v1/messages',
    ...(leg ? { _leg: leg } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }),
    ...effortMarks(ran),
  });
  void log;
}

async function handleResponses(req, res, gateway, { usage, log, caller = '', holdMs = STREAM_HOLD_MS, keepaliveMs = KEEPALIVE_MS, scope = null, responseStore = null, idempotencyStore = null }) {
  const body = await readJson(req);
  const trace = extractW3cTrace(req, res);

  // UHP Idempotency-Key deduplication & conflict detection (409 on payload mismatch).
  const idemKey = extractIdempotencyKey(req, body);
  const idemHash = idemKey ? hashResponsesPayload(body) : null;
  if (idemKey && idempotencyStore) {
    const existing = idempotencyStore.get(caller, idemKey);
    if (existing) {
      if (existing.hash !== idemHash) {
        throw new LlmError('Idempotency-Key was already used with a different request payload', { status: 409, type: 'idempotency_conflict' });
      }
      if (!body.stream && existing.response) {
        res.setHeader('Idempotency-Replayed', 'true');
        return json(res, existing.status || 200, existing.response, existing.session);
      }
    }
  }

  // Resolve stored response state when `previous_response_id` names a response that was stored
  // (`store !== false` on the turn that created it). If the previous turn passed `store: false`
  // (as in stateless Responses clients) or the ID is unknown, `prev` is null and `effectiveBody`
  // retains `previous_response_id` so `responsesStateRefusal` refuses it with a 400.
  let effectiveBody = body;
  let prev = null;
  if (typeof body.previous_response_id === 'string' && body.previous_response_id && responseStore) {
    prev = responseStore.get(body.previous_response_id, caller);
    if (prev) {
      const nextItems = [...(prev.inputItems || []), ...(prev.response?.output || []), ...normalizeResponsesInput(body.input)];
      effectiveBody = {
        ...body,
        model: body.model || prev.model,
        instructions: body.instructions ?? prev.instructions ?? undefined,
        previous_response_id: undefined,
        input: nextItems,
      };
    }
  }

  const stateless = responsesStateRefusal(effectiveBody);
  if (stateless) throw new LlmError(stateless, { status: 400, type: 'invalid_request_error' });
  const messages = responsesMessages(effectiveBody);
  if (!messages.length) throw new LlmError('input is empty', { status: 400 });
  const t0 = Date.now();
  const id = chatId('resp');
  const created = Math.floor(t0 / 1000);
  const stream = !!effectiveBody.stream;
  const session = sessionFrom(req, effectiveBody) || prev?.session || null;
  const harnessId = extractHarnessId(req, effectiveBody) || prev?.harnessId || null;
  const requestedModel = resolveRequestedModel(gateway, effectiveBody.model, { harnessId, backend: effectiveBody.backend, scope });
  effectiveBody = { ...effectiveBody, model: requestedModel };

  const meta = track(res, requestedModel, stream, t0, '/v1/responses');
  if (scope) meta.skipped = gateway.resolve(requestedModel, { scope }).skipped;
  // The same bound as the other faces': what an engine is handed (a prompt, a tools/list) has one.
  const offered = responsesToolCount(effectiveBody);
  if (offered > MAX_TOOLS) throw new LlmError(`this request offers ${offered} tools; at most ${MAX_TOOLS} are taken`, { status: 400, type: 'invalid_request_error' });
  // The Responses API's effort: reasoning.effort (reasoning_effort read too, as on the chat face).
  const effort = requestEffort(effectiveBody, 'openai');
  const shouldStore = body.store !== false;
  const onStore = (respObj, sid) => {
    if (prev && body.previous_response_id) {
      respObj.previous_response_id = body.previous_response_id;
    }
    if (shouldStore && responseStore && respObj?.id) {
      responseStore.set(respObj.id, {
        response: respObj,
        inputItems: normalizeResponsesInput(effectiveBody.input),
        instructions: effectiveBody.instructions || null,
        model: requestedModel,
        session: sid || session || null,
        harnessId,
        caller,
      });
    }
    if (idemKey && idempotencyStore) {
      idempotencyStore.set(caller, idemKey, { hash: idemHash, response: respObj, session: sid || null, status: 200 });
    }
  };

  if (offered) {
    return await responsesWithTools(req, res, gateway, effectiveBody, {
      usage,
      caller,
      holdMs,
      keepaliveMs,
      scope,
      id,
      created,
      stream,
      session,
      meta,
      t0,
      effort,
      harnessId,
      trace,
      onStore,
    });
  }
  if (!stream) {
    const { text, usage: u, usageReason, effort: ran, session: sid, retries, cutAt, toolCalls, leg, upstreamId } = await gateway.collect({ model: requestedModel, messages, session, signal: abortSignal(req, res), maxTokens: effectiveBody.max_tokens, maxOutputTokens: effectiveBody.max_output_tokens, scope, effort, harnessId, trace });
    if (toolCalls.length) throw noResponsesToolCalls();
    meta.done = true;
    const payload = responsesResult({ id, model: requestedModel, text, usage: faceUsage(u, usageReason), created });
    onStore(payload, sid);
    json(res, 200, payload, sid);
    record(usage, {
      model: requestedModel,
      status: 'ok',
      ms: Date.now() - t0,
      ...usageMarks(null, u, usageReason),
      stream: false,
      client: req.headers['user-agent'],
      via: '/v1/responses',
      ...(leg ? { _leg: leg } : {}),
      ...(upstreamId ? { upstreamId } : {}),
      ...marks({ retries, cutAt }),
      ...effortMarks(ran),
    });
    return;
  }
  const events = await held(gateway.complete({ model: requestedModel, messages, session, signal: abortSignal(req, res), maxTokens: effectiveBody.max_tokens, maxOutputTokens: effectiveBody.max_output_tokens, scope, effort, harnessId, trace }), holdMs);
  startSse(res, 'text/event-stream');
  for (const e of responsesStreamEventsHead({ id, model: requestedModel })) sseEvent(res, e.event, e.data);
  let full = '';
  let u = null;
  let uReason = null;
  let ran = null;
  let sid = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let leg = null;
  let upstreamId = null;
  for await (const evt of events) {
    if (evt.type === 'leg') leg = evt.leg;
    else if (evt.type === 'upstream' && evt.upstreamId) upstreamId = evt.upstreamId;
    else if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'usage_unknown') uReason ||= evt.reason;
    else if (evt.type === 'effort') ran = evt;
    else if (evt.type === 'session') sid = evt.id;
    else if (evt.type === 'delta') {
      full += evt.text;
      sseEvent(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: evt.text });
    } else if (evt.type === 'tool_call') throw noResponsesToolCalls();
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  if (errMessage) sseEvent(res, 'response.failed', { type: 'response.failed', response: { id: `resp_${id}`, object: 'response', model: requestedModel, status: 'failed', error: { message: errMessage } } });
  else sseEvent(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${id}`, output_index: 0, content_index: 0, text: full });
  const completedPayload = responsesResult({ id, model: requestedModel, text: full, usage: faceUsage(u, uReason), created });
  if (!errMessage) onStore(completedPayload, sid);
  sseEvent(res, 'response.completed', { type: 'response.completed', response: { id: `resp_${id}`, object: 'response', model: requestedModel, status: errMessage ? 'failed' : 'completed', output: completedPayload.output, usage: responsesUsage(faceUsage(u, uReason)) } });
  res.end();
  meta.done = true;
  record(usage, {
    model: requestedModel,
    status: errMessage ? 'error' : 'ok',
    ms: Date.now() - t0,
    ...usageMarks(null, u, uReason),
    stream: true,
    error: errMessage,
    client: req.headers['user-agent'],
    via: '/v1/responses',
    ...(leg ? { _leg: leg } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...marks({ retries, cutAt }),
    ...effortMarks(ran),
  });
  void log;
}

/**
 * A Responses request that offers tools (design U12): its route walked for a leg that takes them
 * (gateway._toolRoute), the answer written by the Responses tool face — function_call items, or
 * text — streamed or not, with the usage row of the other faces (toolMode, toolCalls, fallback,
 * the bridge's session).
 */
async function responsesWithTools(req, res, gateway, body, { usage, caller, holdMs, keepaliveMs, scope, id, created, stream, session, meta, t0, effort = null, harnessId = null, trace = null, onStore = null }) {
  const out = { mode: null };
  const tools = { spec: responsesToolSpec(body), messages: responsesToolMessages(body), face: 'responses', state: out, caller, relay: null };
  const messages = responsesMessages(body);
  const request = { tools: body.tools, tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls };
  if (!stream) {
    const { text, usage: u, usageReason, effort: ran, session: sid, retries, cutAt, toolCalls, toolMode, fallback, bridge, leg, upstreamId } = await gateway.collect({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, maxOutputTokens: body.max_output_tokens, scope, tools, effort, harnessId, trace });
    const calls = toolCalls.map((c) => faceCall(c, 'responses'));
    const payload = responsesBody({ id, model: body.model, created, text, usage: faceUsage(u, usageReason), toolCalls: calls, request });
    if (toolMode) res.setHeader('x-keysmith-mode', toolMode);
    onStore?.(payload, sid);
    meta.done = true;
    json(res, 200, payload, sid);
    record(usage, {
      model: body.model,
      status: 'ok',
      ms: Date.now() - t0,
      ...usageMarks(out.failed, u, usageReason),
      stream: false,
      client: req.headers['user-agent'],
      via: '/v1/responses',
      ...(leg ? { _leg: leg } : {}),
      ...(upstreamId ? { upstreamId } : {}),
      ...marks({ retries, cutAt, toolMode, toolCalls: calls.length, fallback, bridge }),
      ...effortMarks(ran),
    });
    return;
  }
  const events = await held(gateway.complete({ model: body.model, messages, session, signal: abortSignal(req, res), maxTokens: body.max_tokens, maxOutputTokens: body.max_output_tokens, scope, tools, effort, harnessId, trace }), holdMs);
  startSse(res, 'text/event-stream', out.mode ? { 'x-keysmith-mode': out.mode } : {});
  const face = new ResponsesStream(res, { id, model: body.model, created, request, keepaliveMs });
  meta.face = face;
  face.open();
  let u = null;
  let uReason = null;
  let ran = null;
  let sid = null;
  let errMessage = null;
  let retries = 0;
  let cutAt = null;
  let toolMode = null;
  let fallback = null;
  let bridge = null;
  let leg = null;
  let upstreamId = null;
  for await (const evt of events) {
    if (evt.type === 'leg') leg = evt.leg;
    else if (evt.type === 'upstream' && evt.upstreamId) upstreamId = evt.upstreamId;
    else if (evt.type === 'retry') retries++;
    else if (evt.type === 'cut') cutAt = evt.tool;
    else if (evt.type === 'usage_unknown') uReason ||= evt.reason;
    else if (evt.type === 'effort') ran = evt;
    else if (evt.type === 'session') sid = evt.id;
    else if (evt.type === 'delta') face.text(evt.text);
    else if (evt.type === 'tool_call') face.toolCall(faceCall(evt, 'responses'));
    else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
    else if (evt.type === 'usage') u = mergeUsage(u, evt.usage);
    else if (evt.type === 'error') errMessage = redactSecrets(evt.message); // written to the client below
    else if (evt.type === 'done') break;
  }
  face.finish({ usage: faceUsage(u, uReason), error: errMessage });
  if (!errMessage && onStore) {
    onStore(face._response('completed', { output: face.output, usage: faceUsage(u, uReason) }), sid);
  }
  meta.done = true;
  record(usage, {
    model: body.model,
    status: errMessage ? 'error' : 'ok',
    ms: Date.now() - t0,
    ...usageMarks(out.failed, u, uReason),
    stream: true,
    error: errMessage,
    client: req.headers['user-agent'],
    via: '/v1/responses',
    ...(leg ? { _leg: leg } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...marks({ retries, cutAt, toolMode, toolCalls: face.calls, fallback, bridge }),
    ...effortMarks(ran),
  });
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
  gateway.checkSpend(adapter, upstreamModel, scope);
  const r = await fetch(`${adapter.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adapter.authHeaders(), ...adapter.headers },
    body: JSON.stringify({ ...body, model: upstreamModel }),
    signal: AbortSignal.timeout(adapter.timeoutMs),
  });
  const text = await r.text();
  const upstreamId = upstreamIdFromHeaders(r.headers);
  const embUsage = r.ok ? extractEmbeddingsUsage(text) : undefined;
  meta.done = true;
  res.writeHead(r.status, { 'content-type': 'application/json' });
  // A refusal is the provider's error body, which can quote the key it refused; vectors are
  // passed on as they came.
  res.end(r.ok ? text : redactSecrets(text));
  record(usage, {
    model: body.model,
    status: r.ok ? 'ok' : 'error',
    ms: Date.now() - t0,
    ...(embUsage?.unknown ? { usage: null, usageReason: embUsage.unknown } : embUsage ? { usage: embUsage } : {}),
    stream: false,
    client: req.headers['user-agent'],
    via: '/v1/embeddings',
    _leg: legMetaOf(adapter, upstreamModel),
    ...(upstreamId ? { upstreamId } : {}),
    ...(r.ok ? {} : { error: `${adapterId} ${r.status}` }),
  });
}

function hasOpenaiToolHistory(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((m) => (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) || m?.role === 'tool');
}

function extractEmbeddingsUsage(rawText) {
  if (!rawText) return undefined;
  try {
    const parsed = JSON.parse(rawText);
    const raw = parsed?.usage;
    if (!raw || typeof raw !== 'object') return undefined;
    if (raw.keysmith_usage === 'unknown') {
      return { unknown: typeof raw.reason === 'string' && raw.reason ? raw.reason : 'upstream reported unknown token counts' };
    }
    const rawInput = raw.prompt_tokens ?? raw.input_tokens ?? raw.input ?? raw.total_tokens;
    const cacheRead = raw.prompt_tokens_details?.cached_tokens || raw.cached_tokens || raw.cache_read_input_tokens || raw.cacheRead || 0;
    const cacheWrite = raw.prompt_tokens_details?.cache_creation_tokens || raw.cache_creation_input_tokens || raw.cacheWrite || 0;
    const output = raw.completion_tokens ?? raw.output_tokens ?? raw.output ?? 0;
    if (![rawInput, cacheRead, cacheWrite, output].some((v) => typeof v === 'number' && Number.isFinite(v))) {
      return undefined;
    }
    const input =
      raw.prompt_tokens != null
        ? Math.max(0, Number(raw.prompt_tokens) || 0)
        : Math.max(
            0,
            (Number(rawInput) || 0) +
              (raw.cache_read_input_tokens != null || raw.cache_creation_input_tokens != null ? (Number(cacheRead) || 0) + (Number(cacheWrite) || 0) : 0),
          );
    return {
      input,
      output: Number(output) || 0,
      cacheRead: Number(cacheRead) || 0,
      cacheWrite: Number(cacheWrite) || 0,
    };
  } catch {
    return undefined;
  }
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
  const clientAskedUsage = !!body?.stream_options?.include_usage;
  const streamUsageAllowed = adapter.streamUsage !== false;
  const addedIncludeUsage = !!body?.stream && !clientAskedUsage && streamUsageAllowed;
  const upstreamBody = addedIncludeUsage
    ? {
        ...body,
        model,
        stream_options: {
          ...(body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {}),
          include_usage: true,
        },
      }
    : { ...body, model };
  const upstream = await adapter.rawChat(upstreamBody, { caller });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw upstreamError(adapter.id, upstream, t, { keepStatus: true });
  }
  const sse = /text\/event-stream/i.test(upstream.headers.get('content-type') || '');
  if (res.headersSent) {
    // The hold ended while the upstream was asked: its answer carries on in the open stream,
    // when it is SSE (and the face, lazy, still wrote nothing but comments).
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
  const upstreamId = upstreamIdFromHeaders(upstream.headers);
  const leg = legMetaOf(adapter, model);
  const decoder = new TextDecoder();
  let rawText = '';
  let sseBuf = '';
  const flushSseEvents = (final = false) => {
    while (true) {
      const m = sseBuf.match(/\r?\n\r?\n/);
      if (!m) break;
      const boundary = m.index + m[0].length;
      const eventBlock = sseBuf.slice(0, boundary);
      sseBuf = sseBuf.slice(boundary);
      const outBlock = stripInjectedUsageSseEvent(eventBlock);
      if (outBlock !== null) {
        res.write(outBlock);
      }
    }
    if (final && sseBuf) {
      const outBlock = stripInjectedUsageSseEvent(sseBuf);
      if (outBlock !== null) {
        res.write(outBlock);
      }
      sseBuf = '';
    }
  };
  const uReason = body?.stream && !streamUsageAllowed ? `${adapter.id} has streamUsage false: streamed relay requests no usage from the upstream` : null;
  try {
    for await (const chunk of upstream.body) {
      const str = decoder.decode(chunk, { stream: true });
      rawText += str;
      if (addedIncludeUsage && sse) {
        sseBuf += str;
        flushSseEvents(false);
      } else {
        res.write(chunk);
      }
    }
    const tailStr = decoder.decode();
    rawText += tailStr;
    if (addedIncludeUsage && sse) {
      sseBuf += tailStr;
      flushSseEvents(true);
    }
  } catch (e) {
    // Part of the answer is out: it is the answer, broken, and no other leg is asked.
    log(`passthrough via ${adapter.id} failed after it had started answering: ${e.message}`);
    if (addedIncludeUsage && sse && sseBuf) {
      try { flushSseEvents(true); } catch {}
    }
    res.end();
    const u = extractRelayedUsage(rawText);
    const relayedReason = u?.unknown || uReason;
    const effectiveU = u?.unknown ? null : u;
    const row = {
      model: requested,
      ms: Date.now() - t0,
      stream: !!body.stream,
      via: 'passthrough',
      client: req.headers['user-agent'],
      toolMode: 'passthrough',
      _leg: leg,
      ...(upstreamId ? { upstreamId } : {}),
      ...usageMarks(out.failed, effectiveU ?? (relayedReason ? null : undefined), relayedReason),
      ...marks({ retries }),
    };
    record(usage, { ...row, status: 'error', error: redactSecrets(e.message || String(e)) });
    return true;
  }
  res.end();
  const u = extractRelayedUsage(rawText);
  const relayedReason = u?.unknown || uReason;
  const effectiveU = u?.unknown ? null : u;
  const row = {
    model: requested,
    ms: Date.now() - t0,
    stream: !!body.stream,
    via: 'passthrough',
    client: req.headers['user-agent'],
    toolMode: 'passthrough',
    _leg: leg,
    ...(upstreamId ? { upstreamId } : {}),
    ...usageMarks(out.failed, effectiveU ?? (relayedReason ? null : undefined), relayedReason),
    ...marks({ retries }),
  };
  record(usage, { ...row, status: 'ok' });
  return true;
}

/**
 * Strip an injected `usage` field from an SSE event block when the client did not ask for
 * `stream_options.include_usage`: drops the chunk completely when nothing else is left in it
 * (empty `choices`), or removes the `usage` member and keeps the chunk when it carries content,
 * tool calls, or `finish_reason`.
 */
const CHUNK_ENVELOPE_KEYS = new Set(['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'choices']);
const CHUNK_PADDING_KEYS = new Set(['obfuscation']);

/**
 * Strip `usage` injected by keysmith's own `stream_options.include_usage` from an SSE event block
 * before forwarding to a client that did not ask for it: removes the `usage` member (`null`
 * included) from every chunk, and drops the chunk when, after removing `usage`, nothing is left
 * but envelope keys (`CHUNK_ENVELOPE_KEYS`, with empty `choices`) and allowed padding keys
 * (`CHUNK_PADDING_KEYS`: `obfuscation`). A `choices: []` chunk carrying any other payload field
 * (such as `prompt_filter_results`) is kept without `usage`.
 */
function stripInjectedUsageSseEvent(eventBlock) {
  const trailingMatch = eventBlock.match(/(\r?\n\r?\n|\r?\n)$/);
  const trailing = trailingMatch ? trailingMatch[1] : '';
  const bodyPart = trailing ? eventBlock.slice(0, -trailing.length) : eventBlock;
  const lineSep = eventBlock.includes('\r\n') ? '\r\n' : '\n';
  const lines = bodyPart.split(/\r?\n/);
  const dataIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      dataIndices.push(i);
    } else {
      return eventBlock;
    }
  }
  if (dataIndices.length !== 1) return eventBlock;
  const dataIdx = dataIndices[0];
  const data = lines[dataIdx].slice(5).trim();
  if (!data || data === '[DONE]') return eventBlock;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return eventBlock;
    if (parsed.error) return eventBlock;
    if (!Object.hasOwn(parsed, 'usage')) return eventBlock;
    delete parsed.usage;
    const hasChoices = Array.isArray(parsed.choices) && parsed.choices.length > 0;
    const hasExtraFields = Object.keys(parsed).some((k) => !CHUNK_ENVELOPE_KEYS.has(k) && !CHUNK_PADDING_KEYS.has(k));
    if (!hasChoices && !hasExtraFields) {
      return null;
    }
    lines[dataIdx] = `data: ${JSON.stringify(parsed)}`;
    return lines.join(lineSep) + trailing;
  } catch {
    return eventBlock;
  }
}

function extractRelayedUsage(rawText) {
  if (!rawText) return undefined;
  let u = null;
  let unknownReason = null;
  const pull = (obj) => {
    const raw = obj?.usage || obj?.message?.usage;
    if (!raw || typeof raw !== 'object') return;
    if (raw.keysmith_usage === 'unknown') {
      unknownReason ||= typeof raw.reason === 'string' && raw.reason ? raw.reason : 'upstream reported unknown token counts';
      return;
    }
    const hasTokenNumber = [
      raw.prompt_tokens,
      raw.input_tokens,
      raw.input,
      raw.completion_tokens,
      raw.output_tokens,
      raw.output,
      raw.prompt_tokens_details?.cached_tokens,
      raw.cached_tokens,
      raw.cache_read_input_tokens,
      raw.cacheRead,
      raw.prompt_tokens_details?.cache_creation_tokens,
      raw.cache_creation_input_tokens,
      raw.cacheWrite,
    ].some((v) => typeof v === 'number' && Number.isFinite(v));
    if (!hasTokenNumber) return;
    const cacheRead = raw.prompt_tokens_details?.cached_tokens || raw.cached_tokens || raw.cache_read_input_tokens || raw.cacheRead || 0;
    const cacheWrite = raw.prompt_tokens_details?.cache_creation_tokens || raw.cache_creation_input_tokens || raw.cacheWrite || 0;
    const rawInput =
      raw.prompt_tokens != null
        ? Math.max(0, Number(raw.prompt_tokens) || 0)
        : Math.max(
            0,
            (Number(raw.input_tokens ?? raw.input ?? 0) || 0) +
              (raw.cache_read_input_tokens != null || raw.cache_creation_input_tokens != null ? cacheRead + cacheWrite : 0),
          );
    u = mergeUsage(u, {
      input: rawInput,
      output: raw.completion_tokens ?? raw.output_tokens ?? raw.output ?? 0,
      cacheRead,
      cacheWrite,
    });
  };
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{')) {
    try { pull(JSON.parse(trimmed)); } catch {}
    return u || (unknownReason ? { unknown: unknownReason } : undefined);
  }
  for (const line of rawText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { pull(JSON.parse(data)); } catch {}
  }
  return u || (unknownReason ? { unknown: unknownReason } : undefined);
}

function cannotRelay(id, why) {
  return new LlmError(`${id}: the stream was already open ${why}, so its answer cannot be relayed`, { status: 502, provider: id });
}

/* ---------------------------------------------------------------------- UHP stores & routing */

const RESPONSE_STORE_MAX = 512;
const RESPONSE_STORE_TTL_MS = 3600_000;
const IDEM_STORE_MAX = 512;
const IDEM_STORE_TTL_MS = 86_400_000;

function createResponseStore({ now = () => Date.now() } = {}) {
  const map = new Map(); // id -> { exp, caller, ...entry }
  return {
    set(id, entry) {
      const t = now();
      for (const [k, v] of map) if (v.exp <= t) map.delete(k);
      while (map.size >= RESPONSE_STORE_MAX) map.delete(map.keys().next().value);
      map.set(id, { ...entry, exp: t + RESPONSE_STORE_TTL_MS });
    },
    get(id, caller = '') {
      const v = id ? map.get(id) : null;
      if (!v) return null;
      if (v.exp <= now()) {
        map.delete(id);
        return null;
      }
      if (v.caller && caller && v.caller !== caller) return null;
      return v;
    },
  };
}

function createIdempotencyStore({ now = () => Date.now() } = {}) {
  const map = new Map(); // `${caller}:${key}` -> { exp, hash, response, session, status }
  return {
    set(caller, key, entry) {
      const t = now();
      for (const [k, v] of map) if (v.exp <= t) map.delete(k);
      while (map.size >= IDEM_STORE_MAX) map.delete(map.keys().next().value);
      map.set(`${caller || ''}:${key}`, { ...entry, exp: t + IDEM_STORE_TTL_MS });
    },
    get(caller, key) {
      const k = `${caller || ''}:${key}`;
      const v = map.get(k);
      if (!v) return null;
      if (v.exp <= now()) {
        map.delete(k);
        return null;
      }
      return v;
    },
  };
}

function extractIdempotencyKey(req, body) {
  const h = req.headers['idempotency-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const m = body?.metadata?.idempotency_key;
  if (typeof m === 'string' && m.trim()) return m.trim();
  return null;
}

function hashResponsesPayload(body) {
  const canonical = JSON.stringify({
    model: body?.model ?? null,
    backend: body?.backend ?? null,
    input: body?.input ?? null,
    instructions: body?.instructions ?? null,
    tools: body?.tools ?? null,
    tool_choice: body?.tool_choice ?? null,
    previous_response_id: body?.previous_response_id ?? null,
    harness_id: body?.metadata?.harness_id ?? null,
    stream: !!body?.stream,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

function normalizeResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) return input;
  return [];
}

function extractHarnessId(req, body) {
  const fromMeta = body?.metadata?.harness_id;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  const fromHeader = req.headers['x-harness-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
  return null;
}

/**
 * Resolve a request's model string when UHP `metadata.harness_id`, `x-harness-id`, or `backend`
 * is specified alongside or instead of `model`.
 */
function resolveRequestedModel(gateway, rawModel, { harnessId = null, backend = null, scope = null } = {}) {
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (harnessId) {
    if (gateway.adapters.has(harnessId)) {
      if (!model) return harnessId;
      if (model === harnessId || model.startsWith(`${harnessId}/`)) return model;
      return `${harnessId}/${model}`;
    }
    if (harnessId.startsWith('chrn_')) {
      const uhpAdapter = gateway.publicAdapters.find((a) => a.wire === 'uhp' && gateway.adapterVisible(a.id, scope));
      if (uhpAdapter) {
        if (!model) return `${uhpAdapter.id}/${harnessId}`;
        if (model.startsWith(`${uhpAdapter.id}/`)) return model;
        return `${uhpAdapter.id}/${model}`;
      }
    }
    // An unknown local harness_id that is not a cloud chrn_ id should fail resolution cleanly.
    if (!model) return harnessId;
  }
  if (backend && !model.includes('/')) {
    if (gateway.adapters.has(backend)) {
      return model ? `${backend}/${model}` : backend;
    }
    const uhpAdapter = gateway.publicAdapters.find((a) => a.wire === 'uhp' && gateway.adapterVisible(a.id, scope));
    if (uhpAdapter) {
      return model ? `${uhpAdapter.id}/${backend}/${model}` : `${uhpAdapter.id}/${backend}`;
    }
  }
  return model || rawModel;
}

/**
 * Validate W3C Trace Context headers (`traceparent` and optional `tracestate`), echoing valid
 * headers on the response and returning `{ traceparent, tracestate }` for upstream propagation.
 * `baggage` is intentionally never read or forwarded.
 */
function extractW3cTrace(req, res) {
  const raw = req.headers.traceparent;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const tp = raw.trim().toLowerCase();
  const m = tp.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m) return null;
  const [, version, traceId, parentId] = m;
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  res.setHeader('traceparent', tp);
  const ts = typeof req.headers.tracestate === 'string' && req.headers.tracestate.trim() ? req.headers.tracestate.trim() : null;
  if (ts) res.setHeader('tracestate', ts);
  return { traceparent: tp, ...(ts ? { tracestate: ts } : {}) };
}

/* ---------------------------------------------------------------------- plumbing */

/**
 * A row's `usage` with what the tool legs that failed before the answer spent added to it
 * (gateway._toolRoute's `state.failed`), and those legs named (`failedLegs`). Added, not merged:
 * mergeUsage keeps the larger of two reports of one run, and these are other runs.
 */
function failedMarks(failed, usage) {
  if (!failed?.length) return usage === undefined ? {} : { usage, _ownUsage: usage };
  return {
    usage: failed.reduce((u, f) => addUsage(u, f.usage), usage ?? null) ?? usage,
    _ownUsage: usage ?? null,
    failedLegs: failed.map((f) => ({ ...f })),
  };
}

/**
 * What a face writes for usage: the counts; `{ unknown: reason }` when the CLI that answered reported
 * none and said why (a `usage_unknown` event) — null counts and that reason on the wire, never a 0;
 * null when nothing was said either way (an upstream that sent no usage: the zeros of before).
 */
function faceUsage(u, reason) {
  return u || (reason ? { unknown: reason } : null);
}

/** A row's `usage` (failedMarks), and `usageReason` when the answering leg reported none and said why. */
function usageMarks(failed, u, reason) {
  const m = failedMarks(failed, u);
  if (u == null && reason) {
    return { ...m, ...(m.usage == null ? { usage: null } : {}), usageReason: reason };
  }
  return m;
}

/** What an error that ends a request says it spent (emulate.js, gateway._toolRoute), for its row. */
function errorMarks(e) {
  if (!e || typeof e !== 'object') return {};
  const failure = failureOf(e);
  return {
    ...(e.usage ? { usage: e.usage } : {}),
    ...(e._ownUsage !== undefined ? { _ownUsage: e._ownUsage } : {}),
    ...marks({ retries: e.retries || 0, toolMode: e.toolMode || null, fallback: e.fallback || null }),
    // Why the engine failed, as a code (the bridge's: `foreign_tool` for the tripwire): the
    // security event is in the row, not in the gateway log only.
    ...(failure ? { failure } : {}),
    ...(e.failedLegs?.length ? { failedLegs: e.failedLegs } : {}),
  };
}

function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) {
    const out = { ...b };
    if (b.cacheInclusive) Object.defineProperty(out, 'cacheInclusive', { value: true, enumerable: false });
    if (b.total != null) Object.defineProperty(out, 'total', { value: b.total, enumerable: false });
    return out;
  }
  const out = {
    input: Math.max(a.input || 0, b.input || 0),
    output: Math.max(a.output || 0, b.output || 0),
    cacheRead: Math.max(a.cacheRead || 0, b.cacheRead || 0),
    cacheWrite: Math.max(a.cacheWrite || 0, b.cacheWrite || 0),
    ...(a.reasoning || b.reasoning ? { reasoning: Math.max(a.reasoning || 0, b.reasoning || 0) } : {}),
    ...(a.total || b.total ? { total: Math.max(a.total || 0, b.total || 0) } : {}),
  };
  if (a.cacheInclusive || b.cacheInclusive) {
    Object.defineProperty(out, 'cacheInclusive', { value: true, enumerable: false });
  }
  return out;
}

function record(usage, entry) {
  usage?.record(entry);
}

/**
 * What a usage row says about the request, the key it came with, the adapter and credential
 * that served it, the face and byte counts, the client's tag and the request's cost.
 * With auth off there is no key or label, and the row omits them as it always did.
 */
function stamp(entry, { who, req, res, route, gateway, cfg } = {}) {
  const { _leg, _ownUsage, ...rest } = entry;
  const leg = _leg || gateway?.resolveLegMeta?.(rest.model) || null;
  const adapter = rest.adapter !== undefined ? rest.adapter : (leg?.adapter ?? null);
  const kind = rest.kind !== undefined ? rest.kind : (leg?.kind ?? null);
  const host = rest.host !== undefined ? rest.host : (kind === 'http' ? (leg?.host ?? null) : undefined);
  const account = rest.account !== undefined ? rest.account : (leg ? (leg.account ?? null) : null);
  const upstreamModel = leg?.upstreamModel || leg?.model || null;
  const face = rest.face !== undefined ? rest.face : faceFromRoute(route, rest.via);
  const bytesIn = rest.bytesIn !== undefined ? rest.bytesIn : (req?._bytesIn ?? 0);
  const bytesOut = rest.bytesOut !== undefined ? rest.bytesOut : (res?._bytesOut ?? 0);
  const tag = rest.tag !== undefined ? rest.tag : parseTag(req?.headers?.['x-keysmith-tag']);
  const ownUsage = _ownUsage !== undefined ? _ownUsage : rest.usage;
  const costBasis = leg?.costBasis || null;
  const cost = rest.cost || stampCost(rest, ownUsage, {
    adapter,
    upstreamModel,
    kind,
    costBasis,
    pricing: cfg?.pricing,
    gateway,
  });

  const base = {
    ...rest,
    adapter,
    kind,
    ...(kind === 'http' && host ? { host } : {}),
    account,
    ...(face ? { face } : {}),
    bytesIn,
    bytesOut,
    ...(tag ? { tag } : {}),
    cost,
  };

  if (!who?.fp) return base;
  const skipped = res?._keysmith?.skipped;
  const scope = rest.status === 'denied' ? 'denied' : who.scope ? 'allowed' : 'unscoped';
  return {
    ...base,
    key: `fp:${who.fp}`,
    ...(who.label ? { label: who.label } : {}),
    scope,
    ...(skipped?.length && scope !== 'denied' ? { skipped } : {}),
  };
}

/**
 * Price a row's tokens by the leg that spent them: the answering (or failing) leg's own tokens
 * (`ownUsage`) at its own adapter and basis, and each failed tool leg in `failedLegs` at its own
 * adapter's basis (resolved via `gateway.resolveLegMeta`: `metered` for an HTTP leg that bills per
 * token such as `harnessrouter`, `subscription` with `listUsd` for a CLI or a subscription wire
 * such as `traycer`). When the answering leg's count is unknown (`ownCost.usd === null`), the
 * row's cost stays `{usd: null, basis: 'unpriced', reason}` while failed legs are priced on their
 * own.
 */
function stampCost(rest, ownUsage, { adapter, upstreamModel, kind, costBasis = null, pricing, gateway = null }) {
  const isUnknown =
    Boolean(rest.usageReason) ||
    Boolean(ownUsage?.reason) ||
    ('usage' in rest && rest.usage === null) ||
    (rest.status === 'ok' && 'usage' in rest && ownUsage === null) ||
    Boolean(ownUsage && typeof ownUsage === 'object' && (ownUsage.input === null || ownUsage.output === null));
  const ownCost = computeCost({
    usage: isUnknown ? null : (ownUsage ?? { input: 0, output: 0 }),
    usageReason: rest.usageReason || ownUsage?.reason || null,
    adapter,
    model: rest.model,
    upstreamModel,
    kind,
    costBasis,
    pricing,
  });
  if (!rest.failedLegs?.length) return ownCost;
  const round = (n) => Math.round(n * 1e8) / 1e8;
  let meteredUsd = ownCost.basis === 'metered' ? (ownCost.usd || 0) : 0;
  let hasMeteredFailed = false;
  let listUsd = ownCost.listUsd;
  for (const f of rest.failedLegs) {
    if (!f?.usage) continue;
    const fLeg = gateway?.resolveLegMeta?.(f.target) || null;
    const slash = String(f.target || '').indexOf('/');
    const fAdapter = fLeg?.adapter || (slash < 0 ? f.target : f.target.slice(0, slash)) || adapter;
    const fModel = fLeg?.model || (slash < 0 ? '' : f.target.slice(slash + 1)) || null;
    const fKind = fLeg?.kind || 'cli';
    const fCostBasis = fLeg?.costBasis || null;
    const fAccount = fLeg?.account ?? null;
    const fc = computeCost({
      usage: f.usage,
      adapter: fAdapter,
      model: f.target || rest.model,
      upstreamModel: fModel,
      kind: fKind,
      costBasis: fCostBasis,
      pricing,
    });
    if (fc.basis === 'metered' || fc.listUsd > 0) {
      f.cost = fc;
      if (fAccount) f.account = fAccount;
    }
    if (fc.basis === 'metered') {
      hasMeteredFailed = true;
      meteredUsd = round(meteredUsd + (fc.usd || 0));
    }
    if (fc.listUsd !== undefined) {
      listUsd = round((listUsd || 0) + fc.listUsd);
    }
  }
  if (ownCost.usd === null) return ownCost;
  if (ownCost.basis === 'metered' || (hasMeteredFailed && meteredUsd > 0)) {
    return {
      usd: meteredUsd,
      basis: 'metered',
      ...(listUsd > 0 ? { listUsd } : {}),
    };
  }
  if (ownCost.basis === 'subscription') {
    return listUsd !== undefined ? { usd: 0, basis: 'subscription', listUsd } : ownCost;
  }
  if (listUsd !== undefined) {
    return { ...ownCost, listUsd };
  }
  return ownCost;
}

function faceFromRoute(route, via = null) {
  const r = route || via || '';
  if (r === '/v1/chat/completions') return 'chat';
  if (r === '/v1/messages') return 'messages';
  if (r === '/v1/responses') return 'responses';
  if (r === '/v1/embeddings') return 'embeddings';
  return null;
}

function byteLengthOf(chunk, encoding) {
  if (!chunk || typeof chunk === 'function') return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function wrapBytesOut(res) {
  res._bytesOut = 0;
  const origWrite = res.write;
  const origEnd = res.end;
  let inWrite = false;
  res.write = function (chunk, encoding, cb) {
    if (!inWrite) res._bytesOut += byteLengthOf(chunk, encoding);
    return origWrite.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    res._bytesOut += byteLengthOf(chunk, encoding);
    inWrite = true;
    try {
      return origEnd.call(this, chunk, encoding, cb);
    } finally {
      inWrite = false;
    }
  };
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
 * The reasoning effort a CLI leg ran at (`effort`), or — for a CLI whose argv takes none — that the
 * client's was not applied (`effortIgnored`): a gateway event (`effort`), for the usage row.
 */
function effortMarks(evt) {
  if (!evt) return {};
  return evt.effort ? { effort: evt.effort } : evt.ignored ? { effortIgnored: evt.ignored } : {};
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
 * report or the reason there is none. None of them is an answer, so none of them opens a held stream.
 */
const QUIET_EVENTS = new Set(['retry', 'cut', 'tool_mode', 'session', 'usage', 'usage_unknown', 'effort', 'leg', 'upstream']);
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
    req._bytesIn = size;
    if (size > MAX_BODY) throw new LlmError('request body too large', { status: 413 });
    chunks.push(c);
    if (req.method === 'HEAD') break;
  }
  req._bytesIn = size;
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
