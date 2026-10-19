import { openaiChunk, openaiResult, anthropicResult } from '../protocols.js';
import { LlmError } from '../util.js';
import { FINISH_TOOL_CALLS, isPlainObject, newToolCallId } from './model.js';

/**
 * Face writers: canonical events out to a client, in the shape its SDK reads — text, and the
 * `tool_call` events an engine yields (model.js), streamed or not.
 *
 *   /v1/chat/completions  message.tool_calls, finish_reason "tool_calls"; streamed, two chunks
 *                         per call (index + id + name, then the arguments), as OpenAI sends them
 *   /v1/messages          tool_use content blocks, stop_reason "tool_use"; streamed, blocks open
 *                         when they have something in them, a call is content_block_start +
 *                         one input_json_delta + content_block_stop
 *
 * Text that comes before a call (a preamble) stays in the same answer. While nothing is written
 * — an engine buffering a whole answer to check it — a stream gets a keepalive every
 * KEEPALIVE_MS (an SSE comment; Anthropic's `ping` event), so no proxy or client gives up on
 * a quiet connection. A stream that fails after it started ends in its face's own error frame.
 */

export const KEEPALIVE_MS = 15_000;

/**
 * A `tool_call` event as a face writes it: keysmith's id (a fresh one for `face` if the engine
 * gave none), the name, the arguments as JSON text and as an object — the two always agree.
 */
export function faceCall(evt, face = 'openai') {
  let args = isPlainObject(evt?.args) ? evt.args : null;
  let text = args ? JSON.stringify(args) : null;
  if (!args && typeof evt?.arguments === 'string') {
    try {
      const v = JSON.parse(evt.arguments);
      if (isPlainObject(v)) [args, text] = [v, evt.arguments];
    } catch {}
  }
  if (!args || typeof evt?.name !== 'string' || !evt.name) {
    // An engine checks a call before it yields one; this is the last place it could go wrong.
    throw new LlmError('an engine produced a tool call without a name or a JSON object of arguments', { status: 502 });
  }
  return { id: typeof evt.id === 'string' && evt.id ? evt.id : newToolCallId(face), name: evt.name, arguments: text, args };
}

/**
 * A keepalive on `res` every `intervalMs` while nothing else was written (`touch()` marks a
 * write). Stops itself when the response ends or closes; `timers` is the clock (a test's own).
 */
export function keepalive(res, frame, { intervalMs = KEEPALIVE_MS, timers = globalThis } = {}) {
  if (!(intervalMs > 0)) return { touch() {}, stop() {} };
  let wrote = false;
  let handle = null;
  const stop = () => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  };
  handle = timers.setInterval(() => {
    if (res.writableEnded || res.destroyed) return stop();
    if (!wrote) res.write(frame);
    wrote = false;
  }, intervalMs);
  handle?.unref?.();
  res.once?.('close', stop);
  return {
    touch() {
      wrote = true;
    },
    stop,
  };
}

/* ------------------------------------------------------------------ OpenAI chat */

/** A non-streamed chat completion: with calls, `content` is the preamble or null, `finish_reason` "tool_calls". */
export function openaiCompletion({ id, model, created, text, usage, reasoning = null, toolCalls = [] }) {
  const payload = openaiResult({ id, model, created, text, usage, reasoning, finishReason: toolCalls.length ? FINISH_TOOL_CALLS : 'stop' });
  if (toolCalls.length) {
    const message = payload.choices[0].message;
    message.content = text ? text : null;
    message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  }
  return payload;
}

/** A streamed chat completion, one event at a time. */
export class OpenaiChatStream {
  constructor(res, { id, model, created, includeUsage = false, keepaliveMs = KEEPALIVE_MS, timers } = {}) {
    Object.assign(this, { res, id, model, created, includeUsage, keepaliveMs, timers });
    this.calls = 0;
    this.ka = null;
  }

  _data(obj) {
    this.ka?.touch();
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  _chunk(delta, finish = null) {
    return openaiChunk(this.id, this.model, this.created, delta, finish);
  }

  open() {
    this._data(this._chunk({ role: 'assistant', content: '' }));
    this.ka = keepalive(this.res, ': keepalive\n\n', { intervalMs: this.keepaliveMs, timers: this.timers });
  }

  text(text) {
    this._data(this._chunk({ content: text }));
  }

  reasoning(text) {
    this._data(this._chunk({ reasoning_content: text }));
  }

  /** Two chunks, as OpenAI streams a call: who (index, id, type, name, empty arguments), then the arguments. */
  toolCall(call) {
    const index = this.calls++;
    this._data(this._chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    this._data(this._chunk({ tool_calls: [{ index, function: { arguments: call.arguments } }] }));
  }

  /** The closing chunk (finish_reason, and keysmith's session as an extra field), the usage chunk when asked for, [DONE]. */
  finish({ usage = null, keysmith = null } = {}) {
    const closing = this._chunk({}, this.calls ? FINISH_TOOL_CALLS : 'stop');
    if (keysmith) closing.keysmith = keysmith;
    this._data(closing);
    if (this.includeUsage) {
      this._data({ ...this._chunk(null), choices: [], usage: openaiResult({ id: this.id, model: this.model, created: this.created, text: '', usage }).usage });
    }
    this._end('data: [DONE]\n\n');
  }

  /** A stream that failed after it started: an error frame and [DONE], which is how an OpenAI SDK learns of it. */
  fail(message, type = 'upstream_error') {
    this._data({ error: { message: `keysmith: ${message}`, type } });
    this._end('data: [DONE]\n\n');
  }

  _end(last) {
    this.ka?.stop();
    this.res.write(last);
    this.res.end();
  }
}

/* --------------------------------------------------------------------- Anthropic */

/** A non-streamed Messages answer: the preamble as a text block (when there is one), a tool_use block per call, stop_reason "tool_use". */
export function anthropicMessage({ id, model, text, usage, toolCalls = [] }) {
  const payload = anthropicResult({ id, model, text, usage });
  if (toolCalls.length) {
    payload.content = [...(text ? [{ type: 'text', text }] : []), ...toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))];
    payload.stop_reason = 'tool_use';
  }
  return payload;
}

/**
 * A streamed Messages answer. Content blocks open when they get content: text at the first text
 * delta, a tool_use block per call (closing the text block before it). The first block is
 * followed by a `ping`, as the API sends it; an answer that had no content at all still gets its
 * empty text block, as it always did.
 */
export class AnthropicStream {
  constructor(res, { id, model, keepaliveMs = KEEPALIVE_MS, timers } = {}) {
    Object.assign(this, { res, id, model, keepaliveMs, timers });
    this.blocks = 0; // blocks opened so far: the next one's index
    this.textOpen = false;
    this.calls = 0;
    this.ka = null;
  }

  _event(name, data) {
    this.ka?.touch();
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  open() {
    this._event('message_start', {
      type: 'message_start',
      message: { id: `msg_${this.id}`, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    this.ka = keepalive(this.res, `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`, { intervalMs: this.keepaliveMs, timers: this.timers });
  }

  _start(block) {
    const index = this.blocks++;
    this._event('content_block_start', { type: 'content_block_start', index, content_block: block });
    if (index === 0) this._event('ping', { type: 'ping' });
    return index;
  }

  _closeText() {
    if (!this.textOpen) return;
    this.textOpen = false;
    this._event('content_block_stop', { type: 'content_block_stop', index: this.blocks - 1 });
  }

  text(text) {
    if (!this.textOpen) {
      this._start({ type: 'text', text: '' });
      this.textOpen = true;
    }
    this._event('content_block_delta', { type: 'content_block_delta', index: this.blocks - 1, delta: { type: 'text_delta', text } });
  }

  toolCall(call) {
    this._closeText();
    this.calls++;
    const index = this._start({ type: 'tool_use', id: call.id, name: call.name, input: {} });
    this._event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments } });
    this._event('content_block_stop', { type: 'content_block_stop', index });
  }

  /** Close what is open; an error event (when the answer broke after it started); message_delta with the stop reason; message_stop. */
  finish({ usage = null, error = null } = {}) {
    if (!this.blocks) {
      this._start({ type: 'text', text: '' });
      this.textOpen = true;
    }
    if (error) this._event('error', { type: 'error', error: { type: 'overloaded_error', message: error } });
    this._closeText();
    const stop = error ? 'error' : this.calls ? 'tool_use' : 'end_turn';
    this._event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage?.output || 0 } });
    this._event('message_stop', { type: 'message_stop' });
    this.ka?.stop();
    this.res.end();
  }

  /** A stream that failed after it started: an `error` event, the one an Anthropic SDK raises on. */
  fail(message, type = 'api_error') {
    this._event('error', { type: 'error', error: { type, message: `keysmith: ${message}` } });
    this.ka?.stop();
    this.res.end();
  }
}
