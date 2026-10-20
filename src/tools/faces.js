import { openaiChunk, openaiResult, anthropicResult } from '../protocols.js';
import { LlmError } from '../util.js';
import { FINISH_TOOL_CALLS, isPlainObject, newToolCallId, newToolItemId } from './model.js';

/**
 * Face writers: canonical events out to a client, in the shape its SDK reads — text, and the
 * `tool_call` events an engine yields (model.js), streamed or not.
 *
 *   /v1/chat/completions  message.tool_calls, finish_reason "tool_calls"; streamed, two chunks
 *                         per call (index + id + name, then the arguments), as OpenAI sends them.
 *                         A request in the older `functions` shape (`legacy`) is answered in it:
 *                         one message.function_call, finish_reason "function_call"
 *   /v1/messages          tool_use content blocks, stop_reason "tool_use"; streamed, blocks open
 *                         when they have something in them, a call is content_block_start +
 *                         one input_json_delta + content_block_stop
 *   /v1/responses         a `function_call` output item per call (`fc_` item id, `call_` call
 *                         id), after the message item that holds the preamble; streamed,
 *                         output_item.added + one function_call_arguments.delta + .done +
 *                         output_item.done per call, and response.completed with the whole
 *                         output (what an SDK's final response is read from)
 *
 * Text that comes before a call (a preamble) stays in the same answer. While nothing is written
 * — an engine buffering a whole answer to check it — a stream gets a keepalive every
 * KEEPALIVE_MS (an SSE comment; Anthropic's `ping` event), so no proxy or client gives up on
 * a quiet connection. A stream that fails after it started — a thrown error, or an engine's
 * `error` event after text or a call went out — ends in its face's own error frame (an OpenAI
 * error chunk and [DONE]; an Anthropic `error` event), so an SDK raises instead of taking what
 * came so far for the whole answer.
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

const FINISH_FUNCTION_CALL = 'function_call';

/**
 * A legacy (`functions`) answer carries one call: a second is an engine that ignored the spec's
 * parallel false, and writing it would merge two calls into one in the client's accumulator.
 */
function oneLegacyCall(n) {
  if (n > 1) throw new LlmError(`a request in the older functions shape takes one function_call per answer; the engine produced ${n}`, { status: 502 });
}

/**
 * A non-streamed chat completion: with calls, `content` is the preamble or null, `finish_reason`
 * "tool_calls". `legacy`: the one call as `message.function_call`, finish_reason "function_call".
 */
export function openaiCompletion({ id, model, created, text, usage, reasoning = null, toolCalls = [], legacy = false }) {
  if (legacy) oneLegacyCall(toolCalls.length);
  const finishReason = !toolCalls.length ? 'stop' : legacy ? FINISH_FUNCTION_CALL : FINISH_TOOL_CALLS;
  const payload = openaiResult({ id, model, created, text, usage, reasoning, finishReason });
  if (toolCalls.length) {
    const message = payload.choices[0].message;
    message.content = text ? text : null;
    if (legacy) message.function_call = { name: toolCalls[0].name, arguments: toolCalls[0].arguments };
    else message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  }
  return payload;
}

/**
 * A streamed chat completion, one event at a time.
 *
 * `lazy`: the opening chunk (role) waits for the first thing the answer has, so until then the
 * client has had SSE comments only (`: stream open`, keepalives). A tool request's route can still
 * hand such a stream to an HTTP leg further on, whose own SSE carries on from there (server.js,
 * the relay): `wroteData` says whether that is still possible, `detach()` hands it over.
 */
export class OpenaiChatStream {
  constructor(res, { id, model, created, includeUsage = false, legacy = false, keepaliveMs = KEEPALIVE_MS, timers, lazy = false } = {}) {
    Object.assign(this, { res, id, model, created, includeUsage, legacy, keepaliveMs, timers, lazy });
    this.calls = 0;
    this.ka = null;
    this.opened = false; // the role chunk went out
    this.wroteData = false;
    this.detached = false;
  }

  _data(obj) {
    if (this.detached) return;
    if (!this.opened) {
      this.opened = true;
      this._write(this._chunk({ role: 'assistant', content: '' }));
    }
    this._write(obj);
  }

  _write(obj) {
    this.ka?.touch();
    this.wroteData = true;
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  _chunk(delta, finish = null) {
    return openaiChunk(this.id, this.model, this.created, delta, finish);
  }

  open() {
    if (!this.lazy) {
      this.opened = true;
      this._write(this._chunk({ role: 'assistant', content: '' }));
    }
    this.ka = keepalive(this.res, ': keepalive\n\n', { intervalMs: this.keepaliveMs, timers: this.timers });
  }

  /** The stream is someone else's from here (an HTTP leg's verbatim SSE): no keepalive, no frame of this face's. */
  detach() {
    this.detached = true;
    this.ka?.stop();
  }

  text(text) {
    this._data(this._chunk({ content: text }));
  }

  reasoning(text) {
    this._data(this._chunk({ reasoning_content: text }));
  }

  /**
   * Two chunks, as OpenAI streams a call: who (index, id, type, name, empty arguments), then the
   * arguments. `legacy`: the same two as `function_call` (name, then arguments), one call only.
   */
  toolCall(call) {
    if (this.legacy) {
      oneLegacyCall(this.calls + 1);
      this.calls++;
      this._data(this._chunk({ function_call: { name: call.name, arguments: '' } }));
      this._data(this._chunk({ function_call: { arguments: call.arguments } }));
      return;
    }
    const index = this.calls++;
    this._data(this._chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    this._data(this._chunk({ tool_calls: [{ index, function: { arguments: call.arguments } }] }));
  }

  /**
   * The closing chunk (finish_reason, and keysmith's session as an extra field), the usage chunk
   * when asked for, [DONE]. With `error` — the engine reported a failure after the answer began —
   * the answer is not finished: the error chunk and [DONE] go out in place of the closing chunk,
   * as fail() writes them, the way the Anthropic face writes its `error` event.
   */
  finish({ usage = null, keysmith = null, error = null } = {}) {
    if (this.detached) return;
    if (error) return this.fail(error);
    const closing = this._chunk({}, !this.calls ? 'stop' : this.legacy ? FINISH_FUNCTION_CALL : FINISH_TOOL_CALLS);
    if (keysmith) closing.keysmith = keysmith;
    this._data(closing);
    if (this.includeUsage) {
      this._data({ ...this._chunk(null), choices: [], usage: openaiResult({ id: this.id, model: this.model, created: this.created, text: '', usage }).usage });
    }
    this._end('data: [DONE]\n\n');
  }

  /** A stream that failed after it started: an error frame and [DONE], which is how an OpenAI SDK learns of it. */
  fail(message, type = 'upstream_error') {
    if (this.detached) return;
    // An error frame is no part of an answer: it goes out without an opening chunk in front.
    this._write({ error: { message: `keysmith: ${message}`, type } });
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

/* -------------------------------------------------------------- OpenAI Responses */

/** A Responses usage object, with every field the openai SDK's model asks for. */
function responsesUsage(u) {
  const input = u?.input || 0;
  const output = u?.output || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u?.cacheRead || 0, cache_write_tokens: u?.cacheWrite || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u?.total || input + output,
  };
}

function messageItem(id, text, status) {
  return { id, type: 'message', status, role: 'assistant', content: status === 'in_progress' ? [] : [{ type: 'output_text', text, annotations: [] }] };
}

function callItem(call, itemId, status) {
  return { id: itemId, type: 'function_call', status, call_id: call.id, name: call.name, arguments: status === 'in_progress' ? '' : call.arguments };
}

/**
 * The response object of a Responses answer that offered tools: `output` its items, `status` how
 * it ended, and what the request asked for (`tools`, `tool_choice`, `parallel_tool_calls`), which
 * the API echoes and the openai SDK's model requires. `request` is the client's body.
 */
function responseObject({ id, model, created, status, output, usage = null, error = null, request = {} }) {
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: created,
    status,
    error,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model,
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    temperature: null,
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: null,
    usage: usage ? responsesUsage(usage) : null,
  };
}

/**
 * A non-streamed Responses answer to a request that offered tools: the text as a message item
 * (the preamble, when calls follow it), then a `function_call` item per call — its `call_id`
 * keysmith's call id (what the client's function_call_output names), its `id` an item id of its
 * own (`fc_<24>`). `output_text` mirrors the text, as on the text path.
 */
export function responsesBody({ id, model, created, text = '', usage = null, toolCalls = [], request = {} }) {
  const output = [];
  if (text || !toolCalls.length) output.push(messageItem(`msg_${id}`, text, 'completed'));
  for (const c of toolCalls) output.push(callItem(c, newToolItemId(), 'completed'));
  return { ...responseObject({ id, model, created, status: 'completed', output, usage, request }), output_text: text };
}

/**
 * A streamed Responses answer to a request that offered tools. Items open when they have content:
 * the message item at the first text (output_item.added, content_part.added, then
 * output_text.delta), closed before a call's item; a call is output_item.added (empty arguments),
 * one function_call_arguments.delta, function_call_arguments.done, output_item.done. Every event
 * carries its `sequence_number`; response.completed carries the whole output and the usage, which
 * is what an SDK's final response is read from. While nothing is written (an engine buffering a
 * whole answer), an SSE comment goes out every KEEPALIVE_MS. A failure after it started is an
 * `error` event and response.failed.
 */
export class ResponsesStream {
  constructor(res, { id, model, created, request = {}, keepaliveMs = KEEPALIVE_MS, timers } = {}) {
    Object.assign(this, { res, id, model, created, request, keepaliveMs, timers });
    this.seq = 0;
    this.output = []; // the items so far, as response.completed lists them
    this.msg = null; // the open message item: { index, id, text }
    this.calls = 0;
    this.ka = null;
    this.ended = false;
  }

  _event(name, data) {
    this.ka?.touch();
    this.res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: this.seq++, ...data })}\n\n`);
  }

  _response(status, extra = {}) {
    return responseObject({ id: this.id, model: this.model, created: this.created, status, output: [], request: this.request, ...extra });
  }

  open() {
    this._event('response.created', { response: this._response('in_progress') });
    this._event('response.in_progress', { response: this._response('in_progress') });
    this.ka = keepalive(this.res, ': keepalive\n\n', { intervalMs: this.keepaliveMs, timers: this.timers });
  }

  text(text) {
    if (!this.msg) {
      this.msg = { index: this.output.length, id: `msg_${this.id}`, text: '' };
      this.output.push(messageItem(this.msg.id, '', 'in_progress'));
      this._event('response.output_item.added', { output_index: this.msg.index, item: messageItem(this.msg.id, '', 'in_progress') });
      this._event('response.content_part.added', { item_id: this.msg.id, output_index: this.msg.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    }
    this.msg.text += text;
    this._event('response.output_text.delta', { item_id: this.msg.id, output_index: this.msg.index, content_index: 0, delta: text, logprobs: [] });
  }

  _closeText() {
    const m = this.msg;
    if (!m) return;
    this.msg = null;
    this._event('response.output_text.done', { item_id: m.id, output_index: m.index, content_index: 0, text: m.text, logprobs: [] });
    this._event('response.content_part.done', { item_id: m.id, output_index: m.index, content_index: 0, part: { type: 'output_text', text: m.text, annotations: [] } });
    this.output[m.index] = messageItem(m.id, m.text, 'completed');
    this._event('response.output_item.done', { output_index: m.index, item: this.output[m.index] });
  }

  toolCall(call) {
    this._closeText();
    const index = this.output.length;
    const itemId = newToolItemId();
    this.output.push(callItem(call, itemId, 'completed'));
    this.calls++;
    this._event('response.output_item.added', { output_index: index, item: callItem(call, itemId, 'in_progress') });
    this._event('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: call.arguments });
    this._event('response.function_call_arguments.done', { item_id: itemId, output_index: index, name: call.name, arguments: call.arguments });
    this._event('response.output_item.done', { output_index: index, item: this.output[index] });
  }

  /** Close what is open; response.completed with the output and usage — or, with `error`, the failure. */
  finish({ usage = null, error = null } = {}) {
    if (error) return this.fail(error);
    this._closeText();
    this._event('response.completed', { response: this._response('completed', { output: this.output, usage }) });
    this._end();
  }

  /** A stream that failed after it started: an `error` event, then response.failed. */
  fail(message, type = 'upstream_error') {
    if (this.ended) return;
    const text = `keysmith: ${message}`;
    this._event('error', { code: type, message: text, param: null });
    this._event('response.failed', { response: this._response('failed', { output: this.output, error: { code: 'server_error', message: text } }) });
    this._end();
  }

  _end() {
    this.ended = true;
    this.ka?.stop();
    this.res.end();
  }
}
