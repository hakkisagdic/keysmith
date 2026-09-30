import { LlmError } from './util.js';

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
    this.defaultModel = cfg.defaultModel || null;
    this.note = cfg.note || null;
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
    if (Array.isArray(this._declared)) return this._declared.map((m) => (typeof m === 'string' ? { id: m } : m));
    if (this._declared && typeof this._declared === 'object') {
      return Object.entries(this._declared).map(([id, v]) => ({ id, ...(typeof v === 'object' && v ? v : {}) }));
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
    return list
      .map((m) => (typeof m === 'string' ? { id: m } : { id: m.id || m.name, name: m.name, contextWindow: m.context_length || m.context_window || m.limit?.context }))
      .filter((m) => m.id);
  }

  /** Verbatim relay — used when the client asked for `tools` (see server.tryPassthrough). */
  async rawChat(body) {
    if (this.wire !== 'openai') {
      throw new LlmError(`adapter "${this.id}" cannot relay tool calls on the ${this.wire} wire`, { status: 400, provider: this.id });
    }
    return fetch(this.route('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders(), ...this.headers },
      body: JSON.stringify({ ...body, model: this.upstreamModel(body.model) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
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
      throw new LlmError(`${this.id} ${res.status}: ${describeErrorBody(text)}`, {
        status: res.status === 401 || res.status === 403 ? res.status : 502,
        type: res.status === 401 || res.status === 403 ? 'auth_error' : 'upstream_error',
        provider: this.id,
      });
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

function describeErrorBody(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(empty body)';
  try {
    const j = JSON.parse(t);
    const m = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : null);
    if (m) return String(m).slice(0, 300);
  } catch {}
  return t.slice(0, 300);
}
