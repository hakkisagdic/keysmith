import { LlmError } from './util.js';
import { ThoughtSignatures, limitsFrom } from './thought-signatures.js';
import { redactSecrets } from './redact.js';
import { checkMedia, hasMedia, upstreamMessages } from './media.js';
import { credentialAccount, hostOf } from './usage.js';

const UHP_TOOL_MODES = ['off', 'emulate', 'uhp', 'auto'];

/**
 * Talk to an HTTP upstream that already speaks a chat API and translate its stream
 * into canonical keysmith events.
 *
 * Wires:
 *   openai     POST {base}/chat/completions  — OpenAI, evren, Ollama, OpenRouter, vLLM, GitHub Copilot…
 *   anthropic  POST {base}/messages          — Claude Messages API and clones
 *   uhp        POST {base}/responses         — Unified Harness Protocol (HarnessRouter CE / Cloud, Keysmith UHP)
 *   traycer    GET  {base}/api/traycer/models & POST {base}/inference/{anthropic/messages,openai/responses,{xai,meta,openrouter}/chat/completions}
 */
export class HttpAdapter {
  constructor(id, cfg) {
    this.id = id;
    this.kind = 'http';
    this.wire = cfg.wire || 'openai';
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error(`adapter "${id}": baseUrl is required`);
    this.host = hostOf(this.baseUrl);
    this.account = credentialAccount(cfg);
    this.headers = cfg.headers || {};
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.priority = cfg.priority ?? 100;
    this.disabled = !!cfg.disabled;
    this.modelMap = cfg.modelMap && typeof cfg.modelMap === 'object' && !Array.isArray(cfg.modelMap) ? cfg.modelMap : {};
    this._apiKey = cfg._apiKey ?? null;
    this._declared = cfg.models;
    // Google lists `models/gemini-3.8-flash` and answers to `gemini-3.8-flash`: the listing
    // drops the prefix, so the catalogue, alias checks and requests all use the short id.
    this.stripModelPrefix = typeof cfg.stripModelPrefix === 'string' ? cfg.stripModelPrefix : null;
    this._modelCache = null; // same 10-minute shape as CliAdapter's, so /v1/models does not refetch every provider on every poll
    this._traycerModels = null; // Map<modelId, { provider, upstreamModelId, efforts, defaultEffort }>
    this.defaultModel = cfg.defaultModel || null;
    this.note = cfg.note || null;
    this.costBasis = cfg.costBasis || (this.wire === 'traycer' ? 'subscription' : 'metered');
    // Answers only a request that names it: never an alias leg, never probed (Gateway.resolve).
    this.explicitOnly = !!cfg.explicitOnly;
    this.unsafeTools = false;
    this.harnessId = typeof cfg.harnessId === 'string' && cfg.harnessId.trim() ? cfg.harnessId.trim() : null;
    this.backend = typeof cfg.backend === 'string' && cfg.backend.trim() ? cfg.backend.trim() : null;
    this.uhpVersion = typeof cfg.uhpVersion === 'string' && cfg.uhpVersion.trim() ? cfg.uhpVersion.trim() : '2026-10-19';
    if (this.wire === 'uhp' || this.wire === 'traycer') {
      const mode = cfg.toolMode ?? 'auto';
      if (!UHP_TOOL_MODES.includes(mode)) {
        throw new Error(`adapter "${id}": toolMode on the ${this.wire} wire must be one of ${UHP_TOOL_MODES.join(', ')} — got ${JSON.stringify(mode)}`);
      }
      this.toolMode = mode;
      this.maxPromptChars = cfg.maxPromptChars ?? 500_000;
      this._uhpToolsIgnored = false;
    } else {
      // An HTTP upstream takes tools one way: verbatim (the chat face's relay). toolMode is a CLI's.
      if (cfg.toolMode != null && cfg.toolMode !== 'off') {
        throw new Error(`adapter "${id}": toolMode is a CLI adapter's field — an HTTP upstream on the openai wire is handed tool requests verbatim`);
      }
      this.toolMode = 'off';
    }
    // Request fields sent with one upstream model unless the client set them itself:
    // `{ "gemini-4-argon": { "reasoning_effort": "high" } }`, `"*"` for every model.
    this.modelParams = checkModelParams(id, cfg.modelParams);
    // Gemini 3 (the `google` profile): signatures its function calls carry, kept for the
    // clients that drop them — see thought-signatures.js. `true`, or the store's limits. The
    // Gateway hands every adapter on one upstream URL the same store; alone, it has its own.
    const ts = cfg.thoughtSignatures;
    this.thoughtSignatures = ts ? cfg._signatureStore || new ThoughtSignatures(limitsFrom(ts)) : null;
    // The media this upstream takes (`media`, `vision: true` for images): a user turn that carries
    // some goes up as a content array in the wire's own shapes (src/media.js). Any other upstream
    // is handed the text, each item a label: `[image omitted by keysmith]`.
    const { kinds, limits } = checkMedia(id, cfg, { wire: this.wire, where: this.wire === 'uhp' ? 'on the uhp wire' : 'on the anthropic wire' });
    this.media = kinds;
    this.vision = kinds.includes('image');
    this.mediaOpts = { adapterId: id, wire: this.wire, kinds, limits, fetchUrls: cfg._fetchMedia !== false };
    // Headers sent only with a request that carries media up: Copilot's clients send
    // `copilot-vision-request: true` with an image.
    this.mediaHeaders = checkHeaders(id, 'mediaHeaders', cfg.mediaHeaders);
    if (cfg.streamUsage != null && typeof cfg.streamUsage !== 'boolean') {
      throw new Error(`adapter "${id}": streamUsage must be true or false`);
    }
    this.streamUsage = cfg.streamUsage !== false;
  }

  get resumeArgs() {
    return null; // HTTP upstreams are stateless; UHP sessions chain via previous_response_id.
  }

  get resumable() {
    return this.wire === 'uhp';
  }

  ready() {}

  async acquire() {
    return () => {};
  }

  /**
   * Run one EMULATE tool turn over UHP or Traycer when the upstream does not execute client tools natively
   * (e.g. HarnessRouter CE, which reports `ignored_fields: ["tools"]`).
   */
  emulateRun({ text, model, effort = null, timeoutMs = this.timeoutMs, signal }) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(new Error('client disconnected'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let killed = false;
    let stopReason = '';
    const stop = (why = 'stopped') => {
      killed = true;
      stopReason = why;
      ctrl.abort(new Error(why));
    };
    let resolveDone;
    const done = new Promise((r) => {
      resolveDone = r;
    });
    const self = this;
    const events = (async function* () {
      try {
        const stream = self.complete({
          model,
          messages: [{ role: 'user', content: text }],
          signal: ctrl.signal,
          includeReasoning: true,
          effort,
          timeoutMs,
        });
        for await (const evt of stream) {
          yield evt;
        }
        resolveDone({ code: 0, killed, stderr: stopReason });
      } catch (e) {
        const isTimeout = e instanceof LlmError && e.status === 504;
        if (killed || isTimeout) {
          resolveDone({ code: 1, killed: true, stderr: stopReason || e?.message || 'timeout' });
        } else {
          yield { type: 'error', message: e?.message || String(e) };
          resolveDone({ code: 1, killed: false, stderr: e?.message || String(e) });
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    })();
    return { events, done, stop };
  }

  route(suffix) {
    if (this.wire === 'traycer') {
      return this.baseUrl.replace(/\/(?:api\/traycer\/models|inference\/.*)$/, '') + suffix;
    }
    const tail = this.wire === 'anthropic' ? '/messages' : this.wire === 'uhp' ? '/responses' : '/chat/completions';
    return this.baseUrl.replace(new RegExp(tail + '$'), '') + suffix;
  }

  authHeaders(extra = {}) {
    const h = {};
    if (this.wire === 'uhp') h['uhp-version'] = this.uhpVersion;
    if (extra?.traceparent) h.traceparent = extra.traceparent;
    if (extra?.tracestate) h.tracestate = extra.tracestate;
    if (extra?.idempotencyKey) h['idempotency-key'] = extra.idempotencyKey;
    if (!this._apiKey) return h;
    if (this.wire === 'anthropic') return { ...h, 'x-api-key': this._apiKey, 'anthropic-version': '2023-06-01' };
    return { ...h, authorization: `Bearer ${this._apiKey}` };
  }

  /**
   * The id sent upstream for `model`: its `modelMap` entry, or the model itself. Own entries
   * only — `constructor` or `toString` is a model name like any other, not something every
   * object inherits (that sent a function, which JSON drops, and the upstream picked the model).
   */
  upstreamModel(model) {
    return typeof model === 'string' && Object.hasOwn(this.modelMap, model) ? this.modelMap[model] : model;
  }

  /**
   * Decompose a UHP model target into `{ model, backend, harnessId }`:
   *   - `chrn_<id>` or `chrn_<id>/<model>` -> custom harness id (+ optional model)
   *   - `<backend>/<model>` (e.g. `claude/claude-sonnet-4-6`) -> backend + model
   *   - `default` -> adapter defaults
   *   - `<model>` or `<backend>` -> passed as `model`
   */
  parseUhpTarget(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s === 'default') {
      return { model: undefined, backend: this.backend || undefined, harnessId: this.harnessId || undefined };
    }
    if (s.startsWith('chrn_')) {
      const slash = s.indexOf('/');
      if (slash > 0) {
        return {
          harnessId: s.slice(0, slash),
          model: s.slice(slash + 1) || undefined,
          backend: this.backend || undefined,
        };
      }
      return { harnessId: s, model: undefined, backend: this.backend || undefined };
    }
    const slash = s.indexOf('/');
    if (slash > 0) {
      return {
        backend: s.slice(0, slash),
        model: s.slice(slash + 1) || undefined,
        harnessId: this.harnessId || undefined,
      };
    }
    return { model: s, backend: this.backend || undefined, harnessId: this.harnessId || undefined };
  }

  /**
   * Resolve a Traycer model ID to `{ provider, upstreamModelId }` using the cached
   * `/api/traycer/models` catalog (fetching it once if not yet cached) or prefix heuristics.
   */
  async _resolveTraycerModel(model) {
    const upstream = this.upstreamModel(model) || this.defaultModel || '';
    if (!this._traycerModels && !this._declared) {
      await this.models().catch(() => null);
    }
    if (this._traycerModels?.has(upstream)) {
      return this._traycerModels.get(upstream);
    }
    return inferTraycerRoute(upstream);
  }

  /** `modelParams` for one upstream model id: the `"*"` entry, then the model's own on top (own entries only). */
  paramsFor(upstream) {
    if (!this.modelParams) return {};
    const entry = (id) => (typeof id === 'string' && Object.hasOwn(this.modelParams, id) ? this.modelParams[id] : null);
    return { ...(entry('*') || {}), ...(entry(upstream) || {}) };
  }

  async models() {
    if (this._modelCache && Date.now() - this._modelCache.at < 600_000) return this._modelCache.list;
    // Declared in the config means authoritative *and* free: cache it like anything else,
    // since `gateway.aliasIssues` reads that cache to check alias legs.
    if (Array.isArray(this._declared) || (this._declared && typeof this._declared === 'object')) {
      const list = this._declaredModelList();
      this._modelCache = { at: Date.now(), list };
      return list;
    }
    const modelsPath = this.wire === 'traycer' ? '/api/traycer/models' : '/models';
    let res;
    try {
      res = await fetch(this.route(modelsPath), { headers: { ...this.authHeaders(), ...this.headers }, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new LlmError(`${this.id}: ${e.message}`, { status: 502, provider: this.id, retriable: true });
    }
    if (!res.ok) throw new LlmError(`${this.id}: ${modelsPath} returned ${res.status}`, { status: 502, provider: this.id });
    const body = await res.json().catch(() => null);
    if (!body) throw new LlmError(`${this.id}: ${modelsPath} returned no JSON`, { status: 502, provider: this.id });
    const strip = (id) => (this.stripModelPrefix && typeof id === 'string' && id.startsWith(this.stripModelPrefix) ? id.slice(this.stripModelPrefix.length) : id);
    const fetched = [];
    const seen = new Set();
    const push = (item) => {
      if (!item?.id || seen.has(item.id)) return;
      seen.add(item.id);
      fetched.push(item);
    };
    if (this.wire === 'traycer') {
      const map = new Map();
      const list = Array.isArray(body) ? body : body.data || body.models || [];
      for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        const id = strip(m.id || m.name);
        if (!id) continue;
        const provider = typeof m.provider === 'string' && m.provider ? m.provider : inferTraycerRoute(id).provider;
        const upstreamModelId = typeof m.upstreamModelId === 'string' && m.upstreamModelId ? m.upstreamModelId : id;
        const efforts = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
          : Array.isArray(m.efforts || m.reasoning)
            ? m.efforts || m.reasoning
            : undefined;
        const defaultEffort = m.defaultReasoningEffort || m.defaultEffort || undefined;
        const meta = {
          id,
          provider,
          upstreamModelId,
          ...(efforts?.length ? { efforts } : {}),
          ...(defaultEffort ? { defaultEffort } : {}),
        };
        map.set(id, meta);
        if (upstreamModelId !== id) map.set(upstreamModelId, meta);
        push({
          id,
          name: m.name || id,
          contextWindow: m.contextWindow || m.context_window || m.context_length,
          maxOutput: m.maxOutputTokens || m.max_output_tokens,
          ...(efforts?.length ? { efforts } : {}),
          ...(defaultEffort ? { defaultEffort } : {}),
        });
      }
      this._traycerModels = map;
      this._modelCache = { at: Date.now(), list: fetched };
      return fetched;
    }
    if (body.backends && typeof body.backends === 'object' && !Array.isArray(body.backends)) {
      for (const m of body.data || body.models || []) {
        const entry = typeof m === 'string' ? { id: strip(m) } : { id: strip(m.id || m.name), name: m.name };
        push(entry);
      }
      for (const [backend, info] of Object.entries(body.backends)) {
        if (!info || typeof info !== 'object' || info.installed === false) continue;
        const rawModels = Array.isArray(info.models) ? info.models : Array.isArray(info.available_models) ? info.available_models : [];
        const availableModels = rawModels.filter((m) => m && (typeof m === 'string' || m.available !== false));
        const defModel = info.default || info.default_model;
        if (availableModels.length || defModel) {
          push({ id: backend, name: defModel ? `${backend} (${defModel})` : backend });
        }
        for (const m of availableModels) {
          const rawId = typeof m === 'string' ? m : m.id || m.name;
          const mid = strip(rawId);
          if (!mid) continue;
          const mName = typeof m === 'string' ? mid : m.name || mid;
          const efforts = typeof m === 'object' && Array.isArray(m.reasoning) && m.reasoning.length ? m.reasoning : undefined;
          push({ id: mid, name: mName, ...(efforts ? { efforts } : {}) });
          push({ id: `${backend}/${mid}`, name: typeof m === 'object' && m.name ? m.name : `${backend}/${mid}`, ...(efforts ? { efforts } : {}) });
        }
      }
    } else {
      const list = Array.isArray(body) ? body : body.data || body.models || [];
      for (const m of list) {
        const entry =
          typeof m === 'string'
            ? { id: strip(m) }
            : {
                id: strip(m.id || m.name),
                name: m.name,
                contextWindow: m.context_length || m.context_window || m.limit?.context,
                ...(Array.isArray(m.efforts || m.reasoning) && (m.efforts || m.reasoning).length ? { efforts: m.efforts || m.reasoning } : {}),
              };
        push(entry);
      }
    }
    if (this.wire === 'uhp') {
      try {
        const hRes = await fetch(this.route('/harnesses'), { headers: { ...this.authHeaders(), ...this.headers }, signal: AbortSignal.timeout(10_000) });
        if (hRes.ok) {
          const hBody = await hRes.json().catch(() => null);
          const hList = hBody?.harnesses || hBody?.data || [];
          for (const h of hList) {
            if (h && typeof h.id === 'string' && h.id) {
              push({ id: h.id, name: h.name || h.id });
            }
          }
        }
      } catch {}
      if (!fetched.length && this.defaultModel) push({ id: this.defaultModel, name: this.defaultModel });
    }
    this._modelCache = { at: Date.now(), list: fetched };
    return fetched;
  }

  /** `models` accepts a string array, an object array, or an id->details map. */
  _declaredModelList() {
    if (Array.isArray(this._declared)) {
      return this._declared.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && m.id);
    }
    return Object.entries(this._declared).map(([id, v]) => ({ id, ...(typeof v === 'object' && v ? v : {}) }));
  }

  /**
   * Verbatim relay — used when the client asked for `tools` (see server.tryPassthrough).
   *
   * With `thoughtSignatures` on, "verbatim" has one exception each way: on the way up, a
   * tool call the client replayed without the signature it came with gets it back; on the
   * way down, the answer is read as it passes (not changed) for the signatures to keep.
   * `caller` names the gateway key the request came with (a hash of it, never the key): a
   * signature only ever goes back up on a request from the caller it came down to.
   */
  async rawChat(body, { caller = '' } = {}) {
    if (this.wire !== 'openai') {
      throw new LlmError(`adapter "${this.id}" cannot relay tool calls on the ${this.wire} wire`, { status: 400, provider: this.id });
    }
    const outgoing = this.thoughtSignatures ? this.thoughtSignatures.attach(body, { caller }).body : body;
    const upstream = this.upstreamModel(body.model);
    const res = await fetch(this.route('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders(), ...this.headers },
      // The client's own fields win over `modelParams`: a request that set its reasoning effort
      // meant it — in whichever spelling it chose (see withoutEffortIfSet).
      body: JSON.stringify({ ...withoutEffortIfSet(this.paramsFor(upstream), outgoing), ...outgoing, model: upstream }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!this.thoughtSignatures || !res.ok || !res.body) return res;
    const seen = this.thoughtSignatures.observe(res.headers.get('content-type'), { caller, messages: outgoing.messages });
    const tapped = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          // Read first, pass on second: the signature is stored before the client holds the
          // chunk, so its next request cannot outrun it.
          try {
            seen.push(chunk);
          } catch {}
          controller.enqueue(chunk);
        },
        flush() {
          try {
            seen.end();
          } catch {}
        },
      }),
    );
    return new Response(tapped, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  async *complete({
    model,
    messages,
    session = null,
    maxTokens,
    maxCompletionTokens,
    maxOutputTokens,
    temperature,
    signal,
    includeReasoning,
    effort = null,
    rendered = null,
    timeoutMs = this.timeoutMs,
    tools = null,
    toolChoice = null,
    harnessId = null,
    trace = null,
    idempotencyKey = null,
  }) {
    const isTraycer = this.wire === 'traycer';
    const traycerTarget = isTraycer ? await this._resolveTraycerModel(model) : null;
    const effectiveWire = isTraycer
      ? traycerTarget.provider === 'anthropic'
        ? 'anthropic'
        : traycerTarget.provider === 'openai'
          ? 'uhp'
          : 'openai'
      : this.wire;
    const effectiveModel = isTraycer ? traycerTarget.upstreamModelId : this.upstreamModel(model);

    if (rendered && typeof rendered.prompt === 'string' && effectiveWire !== 'uhp') {
      messages = [
        ...(rendered.system ? [{ role: 'system', content: rendered.system }] : []),
        { role: 'user', content: rendered.prompt },
      ];
    }

    // Read before anything is sent: a bad image or malformed tool_calls history is a 400 and the upstream never sees the request.
    if (this.media.length && hasMedia(messages)) {
      messages = await upstreamMessages(messages, { ...this.mediaOpts, wire: effectiveWire }, { signal });
    }
    const withMedia = messages.some((m) => Array.isArray(m.content));
    const isAnthropic = effectiveWire === 'anthropic';
    const isUhp = effectiveWire === 'uhp';
    const system = messages.find((m) => m.role === 'system');
    const anthropicMessages = isAnthropic ? anthropicWireMessages(messages.filter((m) => m.role !== 'system'), this.id) : null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('client disconnected'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const budgetMs = timeoutMs || this.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${budgetMs}ms`)), budgetMs);
    // `modelParams` go first, so the fields keysmith builds (model, messages, stream…) win;
    // on the Anthropic wire `max_tokens` is the client's (`max_tokens`, `max_completion_tokens`
    // or `max_output_tokens`), else `modelParams`, else 4096; on the OpenAI wire the client's
    // own token-limit field is sent under its own name (`max_completion_tokens` stays
    // `max_completion_tokens`, `max_tokens` stays `max_tokens`) and `temperature` only when
    // the client sent one, never translating one into another.
    const payload = { ...this.paramsFor(effectiveModel) };
    const anthropicMaxTokens = maxTokens || maxCompletionTokens || maxOutputTokens || payload.max_tokens || 4096;
    if (isUhp) {
      Object.assign(
        payload,
        buildUhpPayload(this, payload, {
          model: effectiveModel,
          messages,
          session: isTraycer ? null : session,
          maxTokens: maxTokens || maxCompletionTokens || maxOutputTokens,
          effort,
          rendered,
          tools,
          toolChoice,
          harnessId: isTraycer ? null : harnessId,
          rawModel: isTraycer,
        }),
      );
    } else if (isAnthropic) {
      Object.assign(payload, {
        model: effectiveModel,
        // The Messages API requires max_tokens: the client's, else the model's own in `modelParams`, else 4096.
        // Built after `modelParams`, a bare 4096 here overwrote the model's value every time, and a thinking
        // model ran out of answer on any long reply.
        max_tokens: anthropicMaxTokens,
        stream: true,
        messages: anthropicMessages,
        ...(system?.content ? { system: system.content } : {}),
        ...(effort ? { output_config: { effort } } : {}),
      });
    } else {
      if (maxCompletionTokens && !maxTokens) delete payload.max_tokens;
      if (maxTokens && !maxCompletionTokens) delete payload.max_completion_tokens;
      Object.assign(payload, {
        model: effectiveModel,
        messages,
        stream: true,
        ...(this.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(effort && !payload.reasoning_effort && !payload.reasoning ? { reasoning_effort: effort } : {}),
      });
    }

    const endpoint = isTraycer
      ? traycerTarget.provider === 'anthropic'
        ? '/inference/anthropic/messages'
        : traycerTarget.provider === 'openai'
          ? '/inference/openai/responses'
          : `/inference/${traycerTarget.provider}/chat/completions`
      : isUhp
        ? '/responses'
        : isAnthropic
          ? '/messages'
          : '/chat/completions';
    const extraHeaders = isTraycer && isAnthropic ? { 'anthropic-version': '2023-06-01' } : {};
    let res;
    try {
      res = await fetch(this.route(endpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...this.authHeaders({ traceparent: trace?.traceparent, tracestate: trace?.tracestate, idempotencyKey }),
          ...extraHeaders,
          ...this.headers,
          ...(withMedia ? this.mediaHeaders : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const timeout = /abort|timeout/i.test(e.message ?? '');
      throw new LlmError(`${this.id}: ${e.message}`, { status: timeout ? 504 : 502, provider: this.id, retriable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      throw upstreamError(this.id, res, text);
    }
    let upstreamId = upstreamIdFromHeaders(res.headers);
    if (upstreamId) yield { type: 'upstream', upstreamId };
    try {
      const events = isUhp
        ? parseUhpStream(res, { expectTools: !!(tools && tools.length), adapter: this })
        : isAnthropic
          ? parseAnthropicStream(res.body)
          : parseOpenaiStream(res.body);
      let sawUsage = false;
      for await (const evt of events) {
        if (!upstreamId && isUhp && evt.type === 'session' && evt.id) {
          upstreamId = evt.id;
          yield { type: 'upstream', upstreamId };
        }
        if (evt.type === 'usage' || evt.type === 'usage_unknown') sawUsage = true;
        if (evt.type === 'reasoning' && !includeReasoning) continue;
        if (evt.type === 'done' && !this.streamUsage && !isUhp && !isAnthropic && !sawUsage) {
          sawUsage = true;
          yield { type: 'usage_unknown', reason: `${this.id} has streamUsage false: the streamed answer carries no token counts` };
        }
        yield evt;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort(new Error('stream drained'));
    }
  }
}

/**
 * Infer a Traycer inference provider and upstream model ID when the model was not found in
 * `/api/traycer/models` (or before `/api/traycer/models` has been fetched).
 */
export function inferTraycerRoute(model) {
  const s = String(model || '').trim();
  const explicit = s.match(/^(openai|anthropic|xai|meta|openrouter)\/(.+)$/i);
  if (explicit) {
    return { provider: explicit[1].toLowerCase(), upstreamModelId: explicit[2] };
  }
  if (/^claude-/i.test(s)) return { provider: 'anthropic', upstreamModelId: s };
  if (/^(gpt-|o\d)/i.test(s)) return { provider: 'openai', upstreamModelId: s };
  if (/^grok-/i.test(s)) return { provider: 'xai', upstreamModelId: s };
  if (/^(muse-|llama-)/i.test(s)) return { provider: 'meta', upstreamModelId: s };
  return { provider: 'openrouter', upstreamModelId: s };
}

/**
 * Build a UHP `POST /v1/responses` request body from Keysmith's canonical turn inputs.
 */
function buildUhpPayload(adapter, baseParams, { model, messages, session, maxTokens, effort, rendered, tools, toolChoice, harnessId, rawModel = false }) {
  const upstream = rawModel ? model : adapter.upstreamModel(model);
  const target = rawModel ? { model: upstream } : adapter.parseUhpTarget(upstream);
  const out = { stream: true };
  if (target.model) out.model = target.model;
  else delete out.model;
  if (target.backend) out.backend = target.backend;
  const hid = harnessId || target.harnessId;
  if (hid) {
    out.metadata = { ...(baseParams?.metadata || {}), harness_id: hid };
  }
  const eff = effort || baseParams?.reasoning?.effort || baseParams?.reasoning_effort;
  if (eff) {
    out.reasoning = { ...(baseParams?.reasoning || {}), effort: eff };
  }
  if (maxTokens) out.max_output_tokens = maxTokens;

  if (rendered && typeof rendered.prompt === 'string') {
    if (rendered.system) out.instructions = rendered.system;
    out.input = [{ role: 'user', content: [{ type: 'input_text', text: rendered.prompt }] }];
  } else {
    const sys = messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n');
    const conv = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
    if (session) {
      out.previous_response_id = session;
      const lastAsst = findLastIndex(conv, (m) => m.role === 'assistant');
      const tail = lastAsst >= 0 ? conv.slice(lastAsst + 1) : conv.slice(-1);
      out.input = toUhpInputItems(tail.length ? tail : conv.slice(-1));
    } else {
      if (sys) out.instructions = sys;
      out.input = toUhpInputItems(conv);
    }
  }

  if (tools?.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
    if (toolChoice) {
      if (toolChoice.mode === 'required') out.tool_choice = 'required';
      else if (toolChoice.mode === 'named' && toolChoice.name) out.tool_choice = { type: 'function', name: toolChoice.name };
      else if (toolChoice.mode === 'none') out.tool_choice = 'none';
    }
  }
  return out;
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i], i)) return i;
  }
  return -1;
}

function toUhpInputItems(messages) {
  const items = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const parts = m.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text || '' } : p));
        items.push({ role: 'user', content: parts });
      } else {
        items.push({ role: 'user', content: [{ type: 'input_text', text: String(m.content ?? '') }] });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          items.push({
            type: 'function_call',
            call_id: tc.id || 'call_1',
            name: tc.name,
            arguments: typeof tc.rawArgs === 'string' ? tc.rawArgs : JSON.stringify(tc.arguments ?? {}),
          });
        }
      }
    } else if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId || m.id || 'call_1',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
    }
  }
  return items;
}

/**
 * Parse a UHP `/v1/responses` stream (or JSON response on an idempotent replay) into canonical
 * keysmith events: `session`, `reasoning`, `delta`, `tool_call`, `usage`, `usage_unknown`, `error`, `done`.
 */
async function* parseUhpStream(res, { expectTools = false, adapter = null } = {}) {
  const adapterId = adapter?.id || 'uhp';
  const ct = res.headers?.get?.('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    const body = await res.json().catch(() => null);
    if (!body) {
      yield { type: 'error', message: `${adapterId}: empty response` };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    yield* eventsFromUhpResponse(body, { expectTools, adapter });
    return;
  }

  let sessionSent = false;
  let anyDelta = false;
  let anyReasoning = false;
  let usageSent = false;
  const functionCalls = new Map();
  const resultedCalls = new Set();

  for await (const data of sseEvents(res.body)) {
    if (data === '[DONE]') break;
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    const type = d.type;
    if (type === 'response.created' || type === 'response.in_progress') {
      const resp = d.response;
      const ignored = resp?.metadata?.ignored_fields;
      if (Array.isArray(ignored) && ignored.includes('tools')) {
        if (adapter) adapter._uhpToolsIgnored = true;
        if (expectTools) {
          const uEvt = extractUhpUsage(resp?.usage || d.usage, adapterId);
          const err = new LlmError(`${adapterId}: upstream ignored tools field`, { status: 502, provider: adapter?.id });
          err.fallbackReason = 'uhp_tools_ignored';
          if (uEvt?.usage) err.usage = uEvt.usage;
          throw err;
        }
      }
      if (resp?.id && !sessionSent) {
        sessionSent = true;
        yield { type: 'session', id: resp.id };
      }
    } else if (type === 'response.output_text.delta') {
      if (typeof d.delta === 'string' && d.delta) {
        anyDelta = true;
        yield { type: 'delta', text: d.delta };
      }
    } else if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      if (typeof d.delta === 'string' && d.delta) {
        anyReasoning = true;
        yield { type: 'reasoning', text: d.delta };
      }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = d.item;
      if (item?.type === 'function_call') {
        const cid = item.call_id || item.id;
        if (cid) functionCalls.set(cid, item);
      } else if (item?.type === 'function_call_output') {
        if (item.call_id) resultedCalls.add(item.call_id);
      }
    } else if (type === 'response.function_call_arguments.done') {
      if (d.item_id) {
        for (const [cid, item] of functionCalls.entries()) {
          if (item.id === d.item_id || cid === d.item_id) {
            functionCalls.set(cid, { ...item, arguments: d.arguments ?? item.arguments });
          }
        }
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = d.response || {};
      if (resp.id && !sessionSent) {
        sessionSent = true;
        yield { type: 'session', id: resp.id };
      }
      for (const item of resp.output || []) {
        if (item?.type === 'function_call') {
          const cid = item.call_id || item.id;
          if (cid) functionCalls.set(cid, item);
        } else if (item?.type === 'function_call_output' && item.call_id) {
          resultedCalls.add(item.call_id);
        } else if (item?.type === 'reasoning' && !anyReasoning) {
          for (const s of item.summary || []) {
            if (s?.text) {
              anyReasoning = true;
              yield { type: 'reasoning', text: s.text };
            }
          }
        } else if (item?.type === 'message' && !anyDelta) {
          for (const c of item.content || []) {
            if ((c?.type === 'output_text' || c?.type === 'text') && c.text) {
              anyDelta = true;
              yield { type: 'delta', text: c.text };
            }
          }
        }
      }
      const clientCalls = [...functionCalls.entries()].filter(([cid]) => !resultedCalls.has(cid));
      for (const [cid, fc] of clientCalls) {
        const rawArgs = typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {});
        let args = {};
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {}
        yield { type: 'tool_call', id: cid, name: fc.name, arguments: rawArgs, args };
      }
      const uEvt = extractUhpUsage(resp.usage || d.usage, adapterId);
      if (uEvt) {
        usageSent = true;
        yield uEvt;
      }
      yield { type: 'done', finishReason: clientCalls.length ? 'tool_calls' : resp.status === 'incomplete' ? 'length' : 'stop' };
      return;
    } else if (type === 'response.failed' || type === 'error') {
      const errObj = d.response?.error || d.error;
      const msg = typeof errObj === 'string' ? errObj : errObj?.message || 'uhp stream error';
      const uEvt = extractUhpUsage(d.response?.usage || d.usage, adapterId);
      if (uEvt && !usageSent) {
        usageSent = true;
        yield uEvt;
      }
      yield { type: 'error', message: redactSecrets(msg) };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
  }

  const clientCalls = [...functionCalls.entries()].filter(([cid]) => !resultedCalls.has(cid));
  for (const [cid, fc] of clientCalls) {
    const rawArgs = typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {});
    let args = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {}
    yield { type: 'tool_call', id: cid, name: fc.name, arguments: rawArgs, args };
  }
  yield { type: 'done', finishReason: clientCalls.length ? 'tool_calls' : 'stop' };
}

function* eventsFromUhpResponse(resp, { expectTools = false, adapter = null } = {}) {
  const adapterId = adapter?.id || 'uhp';
  const ignored = resp?.metadata?.ignored_fields;
  if (Array.isArray(ignored) && ignored.includes('tools')) {
    if (adapter) adapter._uhpToolsIgnored = true;
    if (expectTools) {
      const uEvt = extractUhpUsage(resp?.usage, adapterId);
      const err = new LlmError(`${adapterId}: upstream ignored tools field`, { status: 502, provider: adapter?.id });
      err.fallbackReason = 'uhp_tools_ignored';
      if (uEvt?.usage) err.usage = uEvt.usage;
      throw err;
    }
  }
  if (resp.id) yield { type: 'session', id: resp.id };
  if (resp.status === 'failed' || resp.error) {
    const errObj = resp.error;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message || 'uhp response failed';
    const uEvt = extractUhpUsage(resp.usage, adapterId);
    if (uEvt) yield uEvt;
    yield { type: 'error', message: redactSecrets(msg) };
    yield { type: 'done', finishReason: 'stop' };
    return;
  }
  const functionCalls = new Map();
  const resultedCalls = new Set();
  for (const item of resp.output || []) {
    if (item?.type === 'reasoning') {
      for (const s of item.summary || []) {
        if (s?.text) yield { type: 'reasoning', text: s.text };
      }
    } else if (item?.type === 'message') {
      for (const c of item.content || []) {
        if ((c?.type === 'output_text' || c?.type === 'text') && c.text) {
          yield { type: 'delta', text: c.text };
        }
      }
    } else if (item?.type === 'function_call') {
      const cid = item.call_id || item.id;
      if (cid) functionCalls.set(cid, item);
    } else if (item?.type === 'function_call_output' && item.call_id) {
      resultedCalls.add(item.call_id);
    }
  }
  const clientCalls = [...functionCalls.entries()].filter(([cid]) => !resultedCalls.has(cid));
  for (const [cid, fc] of clientCalls) {
    const rawArgs = typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {});
    let args = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {}
    yield { type: 'tool_call', id: cid, name: fc.name, arguments: rawArgs, args };
  }
  const uEvt = extractUhpUsage(resp.usage, adapterId);
  if (uEvt) yield uEvt;
  yield { type: 'done', finishReason: clientCalls.length ? 'tool_calls' : resp.status === 'incomplete' ? 'length' : 'stop' };
}

/**
 * Extract canonical usage or unknown-usage marker from a UHP `/v1/responses` usage object.
 * Preserves unknown usage (`keysmith_usage === 'unknown'`, or explicit null token counts)
 * as `{ type: 'usage_unknown', reason }` so `usage.jsonl` never writes 0 for unknown counts and
 * downstream faces format unknown counts according to `protocols.js` wire conformance rules.
 */
function extractUhpUsage(u, adapterId = 'uhp') {
  if (!u || typeof u !== 'object') return null;
  if (u.keysmith_usage === 'unknown') {
    return {
      type: 'usage_unknown',
      reason: typeof u.reason === 'string' && u.reason ? u.reason : `${adapterId} reported unknown token counts`,
    };
  }
  const hasInput = typeof u.input_tokens === 'number' || typeof u.prompt_tokens === 'number';
  const hasOutput = typeof u.output_tokens === 'number' || typeof u.completion_tokens === 'number';
  const hasTotal = typeof u.total_tokens === 'number';
  if (!hasInput && !hasOutput && !hasTotal) {
    if (u.input_tokens === null || u.output_tokens === null || u.total_tokens === null || typeof u.reason === 'string') {
      return {
        type: 'usage_unknown',
        reason: typeof u.reason === 'string' && u.reason ? u.reason : `${adapterId} reported null token counts`,
      };
    }
    return null;
  }
  const cacheRead =
    u.input_tokens_details?.cached_tokens ||
    u.prompt_tokens_details?.cached_tokens ||
    u.cached_tokens ||
    u.cache_read_tokens ||
    u.cache_read_input_tokens ||
    u.cacheRead ||
    0;
  const cacheWrite =
    u.input_tokens_details?.cache_write_tokens ||
    u.prompt_tokens_details?.cache_creation_tokens ||
    u.cache_write_tokens ||
    u.cache_creation_input_tokens ||
    u.cacheWrite ||
    0;
  const reasoning = u.output_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
  const rawInput = u.input_tokens ?? u.prompt_tokens ?? 0;
  const hasDetailsCache =
    u.input_tokens_details?.cached_tokens != null ||
    u.prompt_tokens_details?.cached_tokens != null ||
    u.cached_tokens != null ||
    u.cache_read_tokens != null ||
    u.cacheRead != null;
  const addAnthropicCache = !hasDetailsCache && (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null);
  const usage = {
    input: rawInput + (addAnthropicCache ? cacheRead + cacheWrite : 0),
    output: u.output_tokens ?? u.completion_tokens ?? 0,
    cacheRead,
    cacheWrite,
    ...(reasoning ? { reasoning } : {}),
    ...(hasTotal && !hasInput && !hasOutput ? { total: u.total_tokens } : {}),
  };
  if (hasInput) Object.defineProperty(usage, 'cacheInclusive', { value: true, enumerable: false });
  return {
    type: 'usage',
    usage,
  };
}

/**
 * The spellings a request chooses its reasoning effort in: OpenAI's `reasoning_effort`, the
 * `reasoning: {effort}` object some OpenAI-compatible APIs take, and Google's
 * `thinking_config` (`thinking_budget` / `thinking_level`), which its OpenAI-compatible
 * endpoint reads from `extra_body.google` (Google's own examples) or `google`. Google refuses
 * `reasoning_effort` and a thinking budget in one request; here that refusal would be counted
 * as the leg refusing the tools, and the route would answer tool-less from a CLI leg.
 */
function effortIn(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.reasoning_effort != null || body.reasoning != null) return true;
  return [body.extra_body?.google, body.google].some((g) => g && typeof g === 'object' && g.thinking_config != null);
}

/**
 * `modelParams` under a client body: when the client set its effort itself, in any spelling,
 * every effort field `modelParams` would add is left out, so the request carries one — the
 * client's. Other params are untouched.
 */
function withoutEffortIfSet(params, body) {
  if (!effortIn(body) || !effortIn(params)) return params;
  const out = { ...params };
  delete out.reasoning_effort;
  delete out.reasoning;
  for (const key of ['extra_body', 'google']) {
    const holder = key === 'extra_body' ? out.extra_body?.google : out.google;
    if (!holder || typeof holder !== 'object' || holder.thinking_config == null) continue;
    const { thinking_config: _dropped, ...rest } = holder;
    if (key === 'extra_body') out.extra_body = { ...out.extra_body, google: rest };
    else out.google = rest;
  }
  return out;
}

/** A header map: names to strings. Absent is none. */
function checkHeaders(id, field, headers) {
  if (headers == null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
    throw new Error(`adapter "${id}": ${field} must map header names to strings, e.g. {"copilot-vision-request": "true"}`);
  }
  return headers;
}

/** `modelParams` must map a model id (or `"*"`) to an object of request fields; a load error otherwise. */
function checkModelParams(id, params) {
  if (params == null) return null;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(params)) throw new Error(`adapter "${id}": modelParams must map a model id to request fields, e.g. {"gemini-4-argon": {"reasoning_effort": "high"}}`);
  for (const [model, fields] of Object.entries(params)) {
    if (!isObj(fields)) throw new Error(`adapter "${id}": modelParams["${model}"] must be an object of request fields`);
  }
  return params;
}

function anthropicWireMessages(messages, adapterId) {
  const out = [];
  for (let i = 0; i < messages.length; ) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content) blocks.push(b);
      } else if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        const fn = tc?.function || {};
        const name = typeof fn.name === 'string' ? fn.name : (typeof tc?.name === 'string' ? tc.name : '');
        const id = typeof tc?.id === 'string' && tc.id ? tc.id : '';
        const rawArgs = fn.arguments !== undefined ? fn.arguments : tc?.arguments;
        let input = null;
        if (typeof rawArgs === 'string') {
          try {
            input = JSON.parse(rawArgs);
          } catch {
            input = null;
          }
        } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          input = rawArgs;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          const err = new LlmError(`tool_calls arguments for "${name || id || 'tool'}" must be a JSON object`, {
            status: 400,
            type: 'invalid_request_error',
            provider: adapterId,
          });
          err.clientError = true;
          throw err;
        }
        blocks.push({ type: 'tool_use', id, name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      i++;
      continue;
    }
    if (m.role === 'tool') {
      const blocks = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const tm = messages[i++];
        blocks.push({
          type: 'tool_result',
          tool_use_id: typeof tm.tool_call_id === 'string' ? tm.tool_call_id : '',
          content: typeof tm.content === 'string' ? tm.content : Array.isArray(tm.content) ? tm.content : String(tm.content ?? ''),
        });
      }
      if (i < messages.length && messages[i].role === 'user') {
        const um = messages[i++];
        if (Array.isArray(um.content)) {
          blocks.push(...um.content);
        } else if (typeof um.content === 'string' && um.content.length > 0) {
          blocks.push({ type: 'text', text: um.content });
        }
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
}

async function* parseOpenaiStream(body) {
  let finishReason = 'stop';
  for await (const data of sseEvents(body)) {
    if (data === '[DONE]') return void (yield { type: 'done', finishReason });
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = d.choices?.[0];
    const text = choice?.delta?.content ?? choice?.message?.content;
    if (typeof text === 'string' && text) yield { type: 'delta', text };
    if (choice?.delta?.reasoning_content) yield { type: 'reasoning', text: choice.delta.reasoning_content };
    if (d.usage) {
      if (d.usage.keysmith_usage === 'unknown') {
        yield {
          type: 'usage_unknown',
          reason: typeof d.usage.reason === 'string' && d.usage.reason ? d.usage.reason : 'upstream reported unknown token counts',
        };
      } else {
        const cacheRead =
          d.usage.prompt_tokens_details?.cached_tokens ||
          d.usage.cached_tokens ||
          d.usage.cache_read_input_tokens ||
          d.usage.cacheRead ||
          0;
        const cacheWrite =
          d.usage.prompt_tokens_details?.cache_creation_tokens ||
          d.usage.cache_creation_input_tokens ||
          d.usage.cacheWrite ||
          0;
        const hasPromptTokens = d.usage.prompt_tokens != null;
        const promptTokens = hasPromptTokens ? Number(d.usage.prompt_tokens) || 0 : null;
        const input = hasPromptTokens
          ? promptTokens
          : (Number(d.usage.input_tokens ?? d.usage.input ?? 0) || 0) +
            (d.usage.cache_read_input_tokens != null || d.usage.cache_creation_input_tokens != null ? cacheRead + cacheWrite : 0);
        const u = {
          input,
          output: d.usage.completion_tokens ?? d.usage.output_tokens ?? d.usage.output ?? 0,
          cacheRead,
          cacheWrite,
        };
        if (hasPromptTokens) Object.defineProperty(u, 'cacheInclusive', { value: true, enumerable: false });
        if (d.usage.total_tokens != null) {
          Object.defineProperty(u, 'total', { value: Number(d.usage.total_tokens) || 0, enumerable: false });
        }
        yield { type: 'usage', usage: u };
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    // Redacted here, at the source: a provider that rejects its key mid-stream quotes it, and
    // this message is written to clients, logs and the usage log further on.
    if (d.error) yield { type: 'error', message: redactSecrets(typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error)) };
  }
  yield { type: 'done', finishReason };
}

async function* parseAnthropicStream(body) {
  for await (const data of sseEvents(body)) {
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    switch (d.type) {
      case 'content_block_delta':
        if (d.delta?.type === 'text_delta' && d.delta.text) yield { type: 'delta', text: d.delta.text };
        else if (d.delta?.type === 'thinking_delta' && d.delta.thinking) yield { type: 'reasoning', text: d.delta.thinking };
        break;
      case 'message_start': {
        const u = d.message?.usage;
        // Anthropic's input_tokens is the uncached input alone: `input` is everything charged as
        // input, the cache read and written included (parsers.js, the usage convention).
        if (u?.keysmith_usage === 'unknown') {
          yield {
            type: 'usage_unknown',
            reason: typeof u.reason === 'string' && u.reason ? u.reason : 'upstream reported unknown token counts',
          };
        } else if (u) {
          const cacheRead = u.cache_read_input_tokens || 0;
          const cacheWrite = u.cache_creation_input_tokens || 0;
          yield { type: 'usage', usage: { input: (u.input_tokens || 0) + cacheRead + cacheWrite, output: u.output_tokens || 0, cacheRead, cacheWrite } };
        }
        break;
      }
      case 'message_delta':
        if (d.usage?.keysmith_usage === 'unknown') {
          yield {
            type: 'usage_unknown',
            reason: typeof d.usage.reason === 'string' && d.usage.reason ? d.usage.reason : 'upstream reported unknown token counts',
          };
        } else if (d.usage) {
          const cacheRead = d.usage.cache_read_input_tokens || 0;
          const cacheWrite = d.usage.cache_creation_input_tokens || 0;
          yield { type: 'usage', usage: { input: (d.usage.input_tokens || 0) + cacheRead + cacheWrite, output: d.usage.output_tokens || 0, cacheRead, cacheWrite } };
        }
        break;
      case 'message': {
        for (const b of d.content || []) {
          if (b?.type === 'text' && b.text) yield { type: 'delta', text: b.text };
        }
        const u = d.usage;
        if (u?.keysmith_usage === 'unknown') {
          yield {
            type: 'usage_unknown',
            reason: typeof u.reason === 'string' && u.reason ? u.reason : 'upstream reported unknown token counts',
          };
        } else if (u) {
          const cacheRead = u.cache_read_input_tokens || 0;
          const cacheWrite = u.cache_creation_input_tokens || 0;
          yield { type: 'usage', usage: { input: (u.input_tokens || 0) + cacheRead + cacheWrite, output: u.output_tokens || 0, cacheRead, cacheWrite } };
        }
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      case 'error':
        yield { type: 'error', message: redactSecrets(d.error?.message || 'anthropic stream error') };
        break;
      case 'message_stop':
        yield { type: 'done', finishReason: 'stop' };
        return;
      default:
        break;
    }
  }
  yield { type: 'done', finishReason: 'stop' };
}

/** Server-Sent Events -> the `data:` payload of each event (or a single JSON body when a stub answers without SSE). */
export async function* sseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = '';
  let yielded = false;
  for await (const chunk of iterate(body)) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.trim()) {
        yielded = true;
        yield data;
      }
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (!yielded && tail.startsWith('{')) yield tail;
}

export function upstreamIdFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  for (const h of ['request-id', 'x-request-id', 'anthropic-request-id', 'openai-request-id']) {
    const v = headers.get(h);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function* iterate(body) {
  if (typeof body[Symbol.asyncIterator] === 'function') return void (yield* body);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * An upstream's refusal, as the provider said it. Auth failures, rate limits (429) and
 * "unavailable / overloaded" (503) keep their status, and a `retry-after` the provider sent
 * travels with them, so a client's own backoff sees what it would have seen talking to the
 * provider directly. Anything else is a 502 from the gateway's point of view — except on
 * the tool-call relay (`keepStatus`), which answers with whatever status the provider did.
 */
export function upstreamError(id, res, text, { keepStatus = false } = {}) {
  const status = res.status;
  const kept = keepStatus || status === 401 || status === 403 || status === 429 || status === 503;
  const err = new LlmError(`${id} ${status}: ${describeErrorBody(text)}`, {
    status: kept ? status : 502,
    type: status === 401 || status === 403 ? 'auth_error' : status === 429 ? 'rate_limit_error' : 'upstream_error',
    provider: id,
  });
  const retryAfter = res.headers?.get?.('retry-after');
  if (retryAfter) err.retryAfter = retryAfter;
  const upstreamId = upstreamIdFromHeaders(res.headers);
  if (upstreamId) err.upstreamId = upstreamId;
  return err;
}

/**
 * The message out of an error body. Google's OpenAI-compatible endpoint wraps its error in
 * a one-element array (`[{"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", …}}]`); its
 * quota message names the limit and the model near the end, so the cut is generous. Redacted
 * before it is cut, like truncate(): a cut through a key leaves a piece no pattern knows.
 */
export function describeErrorBody(text) {
  const t = redactSecrets(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!t) return '(empty body)';
  try {
    let j = JSON.parse(t);
    if (Array.isArray(j)) j = j[0] || {};
    const m = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : null);
    const kind =
      typeof j.error?.status === 'string'
        ? `${j.error.status}: `
        : typeof j.error === 'string' && typeof j.message === 'string' && j.error !== j.message
          ? `${j.error}: `
          : '';
    if (m) return `${kind}${m}`.slice(0, 600);
  } catch {}
  return t.slice(0, 600);
}
