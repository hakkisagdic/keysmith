import { randomUUID } from 'node:crypto';
import { contentToText, keepMediaParts } from './util.js';

/**
 * Wire-protocol translation. keysmith is one internal shape — a message list and a
 * stream of canonical events — with three client faces bolted on, because "usable as
 * an API key" means whatever your client happens to speak:
 *
 *   /v1/chat/completions  OpenAI Chat     (Warp, opencode, most SDKs, most UIs)
 *   /v1/messages          Anthropic       (Claude Code, agents, LiteLLM-style clients)
 *   /v1/responses         OpenAI Responses (Codex CLI and newer SDKs)
 */

export function chatId(prefix = 'chatcmpl') {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/* ------------------------------------------------------------------ OpenAI chat */

export function openaiMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m) => {
    const out = keepMediaParts(
      {
        role: m.role === 'developer' ? 'system' : m.role || 'user',
        content: typeof m.content === 'string' ? m.content : contentToText(m.content),
      },
      m.content,
    );
    if (Array.isArray(m.tool_calls)) Object.defineProperty(out, 'tool_calls', { value: m.tool_calls, enumerable: false });
    if (typeof m.tool_call_id === 'string') Object.defineProperty(out, 'tool_call_id', { value: m.tool_call_id, enumerable: false });
    return out;
  });
}

export function openaiChunk(id, model, created, delta, finish = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finish }],
  };
}

export function openaiResult({ id, model, created, text, usage, finishReason = 'stop', reasoning = null }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        // `reasoning_content` is the field DeepSeek-style clients read; it appears only
        // when the request asked for it (`include_reasoning`) and the model produced it.
        message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), refusal: null, annotations: [] },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: openaiUsage(usage),
  };
}

/**
 * The usage a face is handed: canonical counts (parsers.js: `input` every input token charged, the
 * cache's included), `{ unknown: reason }` when the CLI that answered reported none, or null, when
 * nothing was said at all (an upstream that sent no usage: the zeros every face wrote before).
 *
 * Unknown usage on the wire — the rule. A count the CLI did not report is null wherever the clients'
 * parsers take null, and 0 only where one of them requires a number: the AI SDK's providers
 * (@ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/openai-compatible) check every chunk and body
 * against a zod schema and abort the run on one that fails it (OpenBot, 2026-11-04: 21 of 21 runs
 * at their first tool turn, "expected number … usage.output_tokens"), and Codex CLI reads a
 * Responses usage into integers (0.163.0 against a stub server, 2026-11-04: "failed to parse
 * ResponseCompleted: invalid type: null, expected i64" for a null total and for a null count in
 * either details object). The official anthropic and openai SDKs read usage without checking it;
 * their types agree with the parsers on the Anthropic wire and on Responses. Such a 0 is no count,
 * and the object says so: `keysmith_usage: "unknown"`, and the reason in `reason`. Per face
 * (test/wire-conformance.test.js runs the SDKs' parsers):
 *
 *   /v1/chat/completions  every count null: nullish in the chunk and body schemas of
 *                         @ai-sdk/openai (chat) and @ai-sdk/openai-compatible
 *   /v1/messages          output_tokens 0 (a number in message_delta and in a Message); input_tokens
 *                         0 in a whole Message, null in message_delta (nullish there; message_start
 *                         said 0); the cache's two counts null
 *   /v1/responses         every count 0: input_tokens and output_tokens are numbers in the AI SDK's
 *                         schemas (total_tokens a number or nothing in @ai-sdk/openai 4.x), and
 *                         Codex takes no null in the totals or in the details' cached_tokens and
 *                         reasoning_tokens
 *
 * The usage row (usage.jsonl) is no wire: it keeps `usage: null` with `usageReason`, never a 0.
 */
export function usageUnknown(u) {
  return !!u && typeof u === 'object' && typeof u.unknown === 'string' ? u.unknown : null;
}

/** What marks a face's usage object as no count: the extension fields of the rule above. */
export const USAGE_UNKNOWN = 'unknown';
const unknownMarks = (reason) => ({ keysmith_usage: USAGE_UNKNOWN, reason });

export function openaiUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { prompt_tokens: null, completion_tokens: null, total_tokens: null, prompt_tokens_details: { cached_tokens: null }, completion_tokens_details: { reasoning_tokens: null }, ...unknownMarks(unknown) };
  const input = u?.input || 0;
  const output = u?.output || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: u?.total || input + output,
    prompt_tokens_details: { cached_tokens: u?.cacheRead || 0 },
    completion_tokens_details: { reasoning_tokens: u?.reasoning || 0 },
  };
}

/**
 * A Messages usage, a whole Message's: Anthropic counts the uncached input in `input_tokens` and
 * the cache's two counts beside it, so the three add up to what `input` holds. Unknown: the two
 * counts a Message requires are 0, the cache's null (the rule, usageUnknown above).
 */
export function anthropicUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0, ...unknownMarks(unknown) };
  const cacheRead = u?.cacheRead || 0;
  const cacheWrite = u?.cacheWrite || 0;
  const inputTokens = u?.cacheInclusive ? (u?.input || 0) : Math.max(0, (u?.input || 0) - cacheRead - cacheWrite);
  return { input_tokens: inputTokens, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: u?.output || 0 };
}

/**
 * message_delta's usage: a Message's, but an unknown `input_tokens` stays null — nullable in
 * message_delta (MessageDeltaUsage), and a client keeps message_start's count when it is.
 */
export function anthropicDeltaUsage(u) {
  const usage = anthropicUsage(u);
  return usageUnknown(u) ? { ...usage, input_tokens: null } : usage;
}

/** A Responses usage object, with every field the openai SDK's model asks for. Unknown: every count 0, and the marker (the rule, usageUnknown above). */
export function responsesUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0, ...unknownMarks(unknown) };
  const input = u?.input || 0;
  const output = u?.output || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u?.cacheRead || 0, cache_write_tokens: u?.cacheWrite || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u?.reasoning || 0 },
    total_tokens: u?.total || input + output,
  };
}

/* ------------------------------------------------------------------ Anthropic */

export function anthropicMessages(body) {
  const out = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : contentToText(body.system);
    if (text) out.push({ role: 'system', content: text });
  }
  for (const m of body.messages || []) {
    if (m.role === 'tool' || m.type === 'tool_result') continue;
    out.push(keepMediaParts({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentToText(m.content) }, m.content));
  }
  return out.filter((m) => m.content);
}

export function anthropicStreamEvents({ id, model, text, usage }) {
  const msgId = `msg_${id}`;
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: anthropicDeltaUsage(usage) } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

export function anthropicResult({ id, model, text, usage }) {
  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: anthropicUsage(usage),
  };
}

/* ------------------------------------------------------------------ Responses API */

export function responsesMessages(body) {
  const out = [];
  if (body.instructions) out.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') return [...out, { role: 'user', content: input }];
  for (const item of input || []) {
    if (typeof item === 'string') out.push({ role: 'user', content: item });
    else if (item?.type === 'function_call_output') out.push({ role: 'tool', content: String(item.output ?? '') });
    else if (item?.role) {
      const text = typeof item.content === 'string' ? item.content : contentToText(item.content);
      if (text) out.push(keepMediaParts({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text }, item.content));
    }
  }
  return out;
}

export function responsesResult({ id, model, text, usage, created }) {
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: created,
    status: 'completed',
    model,
    output: [
      {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    // Convenience mirror of what `output` contains. The OpenAI SDK exposes this as a
    // string property, so clients that reach for it get a string, not an array.
    output_text: text,
    usage: responsesUsage(usage),
  };
}

export function errorBody(message, type = 'invalid_request_error', status = 400, provider = null, face = null) {
  const err = { message: `keysmith: ${message}`, type, param: null, code: null, ...(provider ? { provider } : {}) };
  if (face === 'messages') return { type: 'error', error: err, status };
  return { error: err, status };
}
