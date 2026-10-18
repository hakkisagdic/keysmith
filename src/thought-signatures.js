import crypto from 'node:crypto';

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
 * from the fields they know and drop `extra_content`. So the store remembers each signature
 * on the way down and puts it back on the way up when the client sent the call without one.
 * A signature goes back only to the call it came with, which is more than its id: Gemini's
 * ids are short (`call_10078`), and two conversations — or two steps of one — draw the same
 * one. An entry is keyed by
 *
 *   - the caller: the gateway key the request was authenticated with, so one key holder's
 *     signatures never ride on another's requests;
 *   - the call id, the function name and the arguments (parsed and written back with sorted
 *     keys, since clients re-serialize them): a call that names no function gets nothing;
 *   - and, to tell apart two calls that agree on all of that, the conversation before the
 *     call (its messages in the same canonical form). That last one is only a tie-break: a
 *     client that rewrites its history still gets a signature that nothing else could claim.
 *
 * A signature the client did send is left as it is. Calls the gateway never saw (another
 * process, before a restart, a different model's history), and calls it cannot tell apart,
 * get nothing: the provider's 400 is the honest answer there, and the documented bypass
 * value degrades the model, so keysmith does not send it.
 *
 * One store serves every adapter on the same upstream URL (the Gateway hands it out), so a
 * failover leg to a second key on the same endpoint can put back what the first leg saw. It
 * lives in this process's memory, is bounded in entries, bytes and age, and is never logged:
 * a signature is model state, not something a log reader needs.
 */
export const DEFAULT_LIMITS = Object.freeze({ maxEntries: 4096, maxBytes: 16 * 1024 * 1024, maxAgeMs: 6 * 3600_000 });

/** Different conversations that drew the same call, kept side by side under one key. */
const MAX_PER_KEY = 8;

export class ThoughtSignatures {
  constructor({ maxEntries = DEFAULT_LIMITS.maxEntries, maxBytes = DEFAULT_LIMITS.maxBytes, maxAgeMs = DEFAULT_LIMITS.maxAgeMs, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    // key -> [{ sig, convo, at }]; insertion order is age order (a key is moved to the end
    // when it is written again).
    this.entries = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  /** A second adapter on the same upstream asked for larger limits: the shared store takes them. */
  widen(limits = {}) {
    const l = { ...DEFAULT_LIMITS, ...limitsFrom(limits) };
    this.maxEntries = Math.max(this.maxEntries, l.maxEntries);
    this.maxBytes = Math.max(this.maxBytes, l.maxBytes);
    this.maxAgeMs = Math.max(this.maxAgeMs, l.maxAgeMs);
  }

  remember({ caller = '', id, name, args, convo = '', sig }) {
    const key = entryKey(caller, id, name, args);
    if (!key || typeof sig !== 'string' || !sig) return;
    const conv = String(convo ?? '');
    const list = this._take(key) || [];
    const same = list.findIndex((c) => c.convo === conv);
    if (same >= 0) list.splice(same, 1); // the same call in the same conversation: the newest is it
    list.push({ sig, convo: conv, at: this.now() });
    while (list.length > MAX_PER_KEY) list.shift();
    this._put(key, list);
    this._trim();
  }

  /**
   * The signature for this call, if one is fresh and nothing else could claim it: the only
   * candidate under this caller, id, name and arguments, or the one from this conversation.
   */
  lookup({ caller = '', id, name, args, convo = '' }) {
    const key = entryKey(caller, id, name, args);
    if (!key) return null;
    const list = this.entries.get(key);
    if (!list) return null;
    const now = this.now();
    const fresh = list.filter((c) => now - c.at <= this.maxAgeMs);
    if (fresh.length !== list.length) {
      this._take(key);
      if (fresh.length) this._put(key, fresh);
    }
    if (fresh.length === 1) return fresh[0].sig;
    const mine = fresh.filter((c) => c.convo === String(convo ?? ''));
    return mine.length ? mine[mine.length - 1].sig : null;
  }

  /**
   * The way up: a copy of the request body in which every assistant tool call this store
   * holds a signature for, and that arrived without one, carries it again. The body is
   * returned as it came when there is nothing to add.
   */
  attach(body, { caller = '' } = {}) {
    if (!body || !Array.isArray(body.messages)) return { body, attached: 0 };
    let attached = 0;
    const history = conversationHash();
    const messages = body.messages.map((m) => {
      const asks = m && m.role === 'assistant' && Array.isArray(m.tool_calls);
      const convo = asks ? history.digest() : null; // the conversation before this message
      history.add(m);
      if (!asks) return m;
      let changed = false;
      const calls = m.tool_calls.map((tc) => {
        if (!tc || typeof tc !== 'object' || signatureOf(tc)) return tc;
        const sig = this.lookup({ caller, id: tc.id, name: tc.function?.name, args: tc.function?.arguments, convo });
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
   * they pass to the client (unchanged — this only reads them), `end` closes it. `messages`
   * is the request the response answers: the conversation before the calls it holds. An SSE
   * stream is read event by event, so a call is stored as soon as its arguments are whole —
   * before the client has the chunk that completes it; a JSON body is read whole at the end,
   * up to `maxBodyBytes`.
   */
  observe(contentType, { caller = '', messages = [], maxBodyBytes = 32 * 1024 * 1024 } = {}) {
    const decoder = new TextDecoder();
    const sse = /text\/event-stream/i.test(String(contentType || ''));
    let convo = null; // the request's conversation, hashed once a call is stored
    let buf = '';
    let size = 0;
    let overflow = false;
    const slots = new Map(); // `${choice}:${position}` -> { id, name, args, sig, stored }

    const store = (slot, final) => {
      if (!slot.id || !slot.name || !slot.sig) return;
      // Streamed arguments arrive in pieces; a prefix of a JSON object never parses, so a call
      // whose arguments parse is whole. At the end, whatever arrived is what the call was.
      if (!final && !parses(slot.args)) return;
      const mark = `${slot.id}\0${slot.name}\0${canonicalArguments(slot.args)}\0${slot.sig}`;
      if (slot.stored === mark) return;
      slot.stored = mark;
      convo ??= conversationOf(messages);
      this.remember({ caller, id: slot.id, name: slot.name, args: slot.args, convo, sig: slot.sig });
    };

    const take = (payload, final) => {
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
          const key = `${choice.index ?? ci}:${Number.isInteger(tc.index) ? tc.index : pos}`;
          let slot = slots.get(key);
          if (!slot) slots.set(key, (slot = { id: null, name: null, args: '', sig: null, stored: null }));
          if (typeof tc.id === 'string' && tc.id && tc.id !== slot.id) {
            // A new call in a slot an earlier one used: the earlier one is whole, and the new
            // one's name, arguments and signature are its own. A signature that came before
            // any id is kept for the id that follows.
            if (slot.id) {
              store(slot, true);
              Object.assign(slot, { name: null, args: '', sig: null, stored: null });
            }
            slot.id = tc.id;
          }
          if (typeof tc.function?.name === 'string' && tc.function.name) slot.name = tc.function.name;
          // Pieces of the arguments are appended; a whole object where one already stood (a
          // stream that sends the call again, a JSON body) replaces it.
          const a = tc.function?.arguments;
          if (typeof a === 'string') slot.args = choice.delta && !(parses(slot.args) && parses(a)) ? slot.args + a : a;
          else if (a && typeof a === 'object') slot.args = JSON.stringify(a);
          const sig = signatureOf(tc);
          if (sig) slot.sig = sig;
          store(slot, final);
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
      if (data.trim() && data.trim() !== '[DONE]') take(data, false);
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
        else if (buf.trim()) take(buf, true);
        buf = '';
        for (const slot of slots.values()) store(slot, true);
      },
    };
  }

  _take(key) {
    const list = this.entries.get(key);
    if (!list) return null;
    this.entries.delete(key);
    this.bytes -= listCost(key, list);
    return list;
  }

  _put(key, list) {
    this.entries.set(key, list);
    this.bytes += listCost(key, list);
  }

  _trim() {
    const now = this.now();
    for (const [key, list] of this.entries) {
      const newest = list[list.length - 1]?.at ?? 0;
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes && now - newest <= this.maxAgeMs) break;
      this._take(key);
    }
  }
}

/** The signature a tool call carries, if any. */
export function signatureOf(tc) {
  const sig = tc?.extra_content?.google?.thought_signature;
  return typeof sig === 'string' && sig ? sig : null;
}

/** `thoughtSignatures: { maxEntries, maxBytes, maxAgeMs }` from a config, the valid ones only. */
export function limitsFrom(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of ['maxEntries', 'maxBytes', 'maxAgeMs']) if (Number.isFinite(o[k]) && o[k] > 0) out[k] = o[k];
  return out;
}

/**
 * Tool call arguments as one string whatever the client did to them: parsed and written back
 * with sorted keys and no spaces (LangChain sends `{"city": "Ankara"}` for Gemini's
 * `{"city":"Ankara"}`). Missing or empty is `{}`; text that is not JSON is kept as it is.
 */
export function canonicalArguments(a) {
  if (a == null) return '{}';
  if (typeof a !== 'string') return stable(a);
  const t = a.trim();
  if (!t) return '{}';
  try {
    return stable(JSON.parse(t));
  } catch {
    return t;
  }
}

/** A hash of the conversation in `messages`, in the canonical form `attach` reads it in. */
export function conversationOf(messages) {
  const h = conversationHash();
  for (const m of Array.isArray(messages) ? messages : []) h.add(m);
  return h.digest();
}

/* ------------------------------------------------------------------------ internals */

function entryKey(caller, id, name, args) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  return JSON.stringify([String(caller ?? ''), id, name, canonicalArguments(args)]);
}

function listCost(key, list) {
  return key.length + list.reduce((n, c) => n + c.sig.length + c.convo.length, 0);
}

/**
 * A running hash over messages, each reduced to what a client keeps when it sends history
 * back: role, text, tool calls (id, name, canonical arguments) and the tool result's call id.
 * `extra_content`, spacing in arguments and null-versus-empty content do not count.
 */
function conversationHash() {
  const h = crypto.createHash('sha256');
  return {
    add(m) {
      h.update(canonicalMessage(m) + '\n');
    },
    digest() {
      return h.copy().digest('base64url').slice(0, 22);
    },
  };
}

function canonicalMessage(m) {
  if (!m || typeof m !== 'object') return stable(m ?? null);
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map((tc) => [tc?.id ?? null, tc?.function?.name ?? null, canonicalArguments(tc?.function?.arguments)]) : [];
  return stable([m.role ?? null, textOf(m.content), calls, m.tool_call_id ?? null]);
}

function textOf(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : stable(p))).join('');
  return stable(c);
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function parses(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
