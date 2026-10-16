import { LlmError } from './util.js';
import { ThoughtSignatures } from './thought-signatures.js';
import { redactSecrets } from './redact.js';

/**
 * Talk to an HTTP upstream that already speaks a chat API and translate its stream
 * into canonical keysmith events.
 *
 * Wires:
 *   openai     POST {base}/chat/completions  — OpenAI, evren, Ollama, OpenRouter, vLLM, GitHub Copilot…
 *   anthropic  POST {base}/messages          — Claude Messages API and clones
 */
export class HttpAdapter {
  constructor(id, cfg) {
    this.id = id;
    this.kind = 'http';
    this.wire = cfg.wire || 'openai';
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error(`adapter "${id}": baseUrl is required`);
    this.headers = cfg.headers || {};
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.priority = cfg.priority ?? 100;
    this.disabled = !!cfg.disabled;
    this.modelMap = cfg.modelMap || {};
    this._apiKey = cfg._apiKey ?? null;
    this._declared = cfg.models;
    // Google lists `models/gemini-3.8-flash` and answers to `gemini-3.8-flash`: the listing
    // drops the prefix, so the catalogue, alias checks and requests all use the short id.
    this.stripModelPrefix = typeof cfg.stripModelPrefix === 'string' ? cfg.stripModelPrefix : null;
    this._modelCache = null; // same 10-minute shape as CliAdapter's, so /v1/models does not refetch every provider on every poll
    this.defaultModel = cfg.defaultModel || null;
    this.note = cfg.note || null;
    // Gemini 3 (the `google` profile): signatures its function calls carry, kept for the
    // clients that drop them — see thought-signatures.js. `true`, or the store's limits.
    const ts = cfg.thoughtSignatures;
    this.thoughtSignatures = ts ? new ThoughtSignatures(ts && typeof ts === 'object' ? pickLimits(ts) : {}) : null;
  }

  get resumeArgs() {
    return null; // HTTP upstreams are stateless; the client always sends full history.
  }

  get resumable() {
    return false;
  }

  route(suffix) {
    const tail = this.wire === 'anthropic' ? '/messages' : '/chat/completions';
    return this.baseUrl.replace(new RegExp(tail + '$'), '') + suffix;
  }

  authHeaders() {
    if (!this._apiKey) return {};
    return this.wire === 'anthropic' ? { 'x-api-key': this._apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${this._apiKey}` };
  }

  upstreamModel(model) {
    return this.modelMap[model] ?? model;
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
    let res;
    try {
      res = await fetch(this.route('/models'), { headers: { ...this.authHeaders(), ...this.headers }, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new LlmError(`${this.id}: ${e.message}`, { status: 502, provider: this.id, retriable: true });
    }
    if (!res.ok) throw new LlmError(`${this.id}: /models returned ${res.status}`, { status: 502, provider: this.id });
    const body = await res.json().catch(() => null);
    if (!body) throw new LlmError(`${this.id}: /models returned no JSON`, { status: 502, provider: this.id });
    const list = Array.isArray(body) ? body : body.data || body.models || [];
    const strip = (id) => (this.stripModelPrefix && typeof id === 'string' && id.startsWith(this.stripModelPrefix) ? id.slice(this.stripModelPrefix.length) : id);
    const fetched = list
      .map((m) => (typeof m === 'string' ? { id: strip(m) } : { id: strip(m.id || m.name), name: m.name, contextWindow: m.context_length || m.context_window || m.limit?.context }))
      .filter((m) => m.id);
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
   */
  async rawChat(body) {
    if (this.wire !== 'openai') {
      throw new LlmError(`adapter "${this.id}" cannot relay tool calls on the ${this.wire} wire`, { status: 400, provider: this.id });
    }
    const outgoing = this.thoughtSignatures ? this.thoughtSignatures.attach(body).body : body;
    const res = await fetch(this.route('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders(), ...this.headers },
      body: JSON.stringify({ ...outgoing, model: this.upstreamModel(body.model) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!this.thoughtSignatures || !res.ok || !res.body) return res;
    const seen = this.thoughtSignatures.observe(res.headers.get('content-type'));
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

  async *complete({ model, messages, maxTokens, temperature, signal, includeReasoning }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('client disconnected'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    const isAnthropic = this.wire === 'anthropic';
    const system = messages.find((m) => m.role === 'system');
    const payload = isAnthropic
      ? {
          model: this.upstreamModel(model),
          max_tokens: maxTokens || 4096,
          stream: true,
          messages: messages.filter((m) => m.role !== 'system'),
          ...(system?.content ? { system: system.content } : {}),
        }
      : {
          model: this.upstreamModel(model),
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(temperature != null ? { temperature } : {}),
        };

    let res;
    try {
      res = await fetch(this.route(isAnthropic ? '/messages' : '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...this.authHeaders(), ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const timeout = /abort|timeout/i.test(e.message ?? '');
      throw new LlmError(`${this.id}: ${e.message}`, { status: timeout ? 504 : 502, provider: this.id, retriable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      clearTimeout(timer);
      throw upstreamError(this.id, res, text);
    }
    try {
      const events = isAnthropic ? parseAnthropicStream(res.body) : parseOpenaiStream(res.body);
      for await (const evt of events) {
        if (evt.type === 'reasoning' && !includeReasoning) continue;
        yield evt;
      }
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('stream drained'));
    }
  }
}

async function* parseOpenaiStream(body) {
  for await (const data of sseEvents(body)) {
    if (data === '[DONE]') return void (yield { type: 'done', finishReason: 'stop' });
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
      yield {
        type: 'usage',
        usage: {
          input: d.usage.prompt_tokens || 0,
          output: d.usage.completion_tokens || 0,
          cacheRead: d.usage.prompt_tokens_details?.cached_tokens || d.usage.cached_tokens || 0,
          cacheWrite: 0,
        },
      };
    }
    if (choice?.finish_reason) yield { type: 'done', finishReason: choice.finish_reason };
    if (d.error) yield { type: 'error', message: typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error) };
  }
  yield { type: 'done', finishReason: 'stop' };
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
        if (u) yield { type: 'usage', usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 } };
        break;
      }
      case 'message_delta':
        if (d.usage?.output_tokens) yield { type: 'usage', usage: { input: 0, output: d.usage.output_tokens, cacheRead: 0, cacheWrite: 0 } };
        break;
      case 'error':
        yield { type: 'error', message: d.error?.message || 'anthropic stream error' };
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

/** Server-Sent Events -> the `data:` payload of each event. */
export async function* sseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = '';
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
      if (data.trim()) yield data;
    }
  }
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
    const kind = typeof j.error?.status === 'string' ? `${j.error.status}: ` : '';
    if (m) return `${kind}${m}`.slice(0, 600);
  } catch {}
  return t.slice(0, 600);
}

function pickLimits(o) {
  const out = {};
  for (const k of ['maxEntries', 'maxBytes', 'maxAgeMs']) if (Number.isFinite(o[k]) && o[k] > 0) out[k] = o[k];
  return out;
}
