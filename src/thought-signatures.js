/**
 * Gemini thought signatures, carried across clients that drop them.
 *
 * Gemini 3 hands back an opaque signature of its reasoning with each step's function call
 * and requires it back on the next request. Its OpenAI-compatible endpoint puts it on the
 * tool call, streamed or not (streamed tool calls carry no `index`):
 *
 *   "tool_calls": [{ "id": "call_1158233", "type": "function",
 *                    "function": { "name": "get_weather", "arguments": "{…}" },
 *                    "extra_content": { "google": { "thought_signature": "<opaque, ~500 chars>" } } }]
 *
 * and a request whose current turn (everything since the last user message that is not a
 * tool result) replays a function call without its signature is refused with a 400
 * ("Function call is missing a thought_signature in functionCall parts"). Parallel calls
 * carry it on the first call of the step only; sequential steps each carry their own.
 *
 * Most OpenAI clients (LangChain's ChatOpenAI among them) rebuild the assistant message
 * from the fields they know and drop `extra_content`. So the adapter remembers each
 * signature on the way down, keyed by the tool call's id, and puts it back on the way up
 * when the client sent the call without one — and only to a call with the same function
 * name, so an id that two conversations happened to draw never gets the other one's
 * signature. A signature the client did send is left as it is. Calls the gateway never
 * saw (another process, before a restart, a different model's history) get nothing: the
 * provider's 400 is the honest answer there, and the documented bypass value degrades the
 * model, so keysmith does not send it.
 *
 * The store is per adapter, in this process's memory, bounded in entries, bytes and age,
 * and never logged: a signature is model state, not something a log reader needs.
 */
export class ThoughtSignatures {
  constructor({ maxEntries = 4096, maxBytes = 16 * 1024 * 1024, maxAgeMs = 6 * 3600_000, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.entries = new Map(); // tool call id -> { sig, name, at }; insertion order is age order
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  remember(id, sig, name = null) {
    if (typeof id !== 'string' || !id || typeof sig !== 'string' || !sig) return;
    this._drop(id);
    this.entries.set(id, { sig, name: typeof name === 'string' && name ? name : null, at: this.now() });
    this.bytes += cost(id, sig);
    this._trim();
  }

  /** The signature stored for this call id, if it is fresh and the function name agrees. */
  lookup(id, name = null) {
    const e = typeof id === 'string' ? this.entries.get(id) : null;
    if (!e) return null;
    if (this.now() - e.at > this.maxAgeMs) {
      this._drop(id);
      return null;
    }
    if (e.name && typeof name === 'string' && name && e.name !== name) return null;
    return e.sig;
  }

  /**
   * The way up: a copy of the request body in which every assistant tool call this store
   * holds a signature for, and that arrived without one, carries it again. The body is
   * returned as it came when there is nothing to add.
   */
  attach(body) {
    if (!body || !Array.isArray(body.messages)) return { body, attached: 0 };
    let attached = 0;
    const messages = body.messages.map((m) => {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
      let changed = false;
      const calls = m.tool_calls.map((tc) => {
        if (!tc || typeof tc !== 'object' || signatureOf(tc)) return tc;
        const sig = this.lookup(tc.id, tc.function?.name);
        if (!sig) return tc;
        changed = true;
        attached++;
        const extra = isObj(tc.extra_content) ? tc.extra_content : {};
        const google = isObj(extra.google) ? extra.google : {};
        return { ...tc, extra_content: { ...extra, google: { ...google, thought_signature: sig } } };
      });
      return changed ? { ...m, tool_calls: calls } : m;
    });
    return attached ? { body: { ...body, messages }, attached } : { body, attached: 0 };
  }

  /**
   * The way down: an observer for one upstream response body. `push` takes the bytes as
   * they pass to the client (unchanged — this only reads them), `end` closes it. An SSE
   * stream is read event by event, so a signature is stored before the client has the
   * chunk that carries it; a JSON body is read whole at the end, up to `maxBodyBytes`.
   */
  observe(contentType, { maxBodyBytes = 32 * 1024 * 1024 } = {}) {
    const decoder = new TextDecoder();
    const sse = /text\/event-stream/i.test(String(contentType || ''));
    let buf = '';
    let size = 0;
    let overflow = false;
    const ids = new Map(); // `${choice}:${position}` -> { id, name }, for chunks that send them once
    const pending = new Map(); // same key -> signature that arrived before its id

    const take = (payload) => {
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        return;
      }
      for (const [ci, choice] of (Array.isArray(d?.choices) ? d.choices : []).entries()) {
        const calls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const [pos, tc] of calls.entries()) {
          if (!tc || typeof tc !== 'object') continue;
          // Gemini's stream leaves `index` off its tool calls; their place in the list is
          // the only position there is then.
          const slot = `${choice.index ?? ci}:${Number.isInteger(tc.index) ? tc.index : pos}`;
          const known = ids.get(slot) || { id: null, name: null };
          if (typeof tc.id === 'string' && tc.id && tc.id !== known.id) {
            known.id = tc.id; // a new call in a slot an earlier one used: its name is its own
            known.name = null;
          }
          if (typeof tc.function?.name === 'string' && tc.function.name) known.name = tc.function.name;
          ids.set(slot, known);
          const sig = signatureOf(tc) || pending.get(slot);
          if (!sig) continue;
          if (known.id) {
            this.remember(known.id, sig, known.name);
            pending.delete(slot);
          } else {
            pending.set(slot, sig);
          }
        }
      }
    };

    const drainEvents = (final) => {
      buf = buf.replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        event(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
      if (final && buf.trim()) event(buf);
      if (final) buf = '';
    };
    const event = (block) => {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.trim() && data.trim() !== '[DONE]') take(data);
    };

    return {
      push: (chunk) => {
        if (overflow) return;
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (sse) {
          buf += text;
          drainEvents(false);
          if (buf.length > maxBodyBytes) overflow = true; // one event this big is not a chat chunk
          return;
        }
        size += text.length;
        if (size > maxBodyBytes) {
          overflow = true;
          buf = '';
          return;
        }
        buf += text;
      },
      end: () => {
        if (overflow) return;
        buf += decoder.decode();
        if (sse) drainEvents(true);
        else if (buf.trim()) take(buf);
        buf = '';
      },
    };
  }

  _drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.bytes -= cost(id, e.sig);
  }

  _trim() {
    const now = this.now();
    for (const [id, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes && now - e.at <= this.maxAgeMs) break;
      this._drop(id);
    }
  }
}

/** The signature a tool call carries, if any. */
export function signatureOf(tc) {
  const sig = tc?.extra_content?.google?.thought_signature;
  return typeof sig === 'string' && sig ? sig : null;
}

function cost(id, sig) {
  return id.length + sig.length;
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
