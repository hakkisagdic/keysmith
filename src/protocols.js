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
  return messages.map((m) =>
    keepMediaParts(
      {
        role: m.role === 'developer' ? 'system' : m.role || 'user',
        content: typeof m.content === 'string' ? m.content : contentToText(m.content),
      },
      m.content,
    ),
  );
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
 * cache's included), `{ unknown: reason }` when the CLI that answered reported none — written as
 * null counts with the reason beside them, never as 0 — or null, when nothing was said at all (an
 * upstream that sent no usage: the zeros every face wrote before).
 */
export function usageUnknown(u) {
  return !!u && typeof u === 'object' && typeof u.unknown === 'string' ? u.unknown : null;
}

export function openaiUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { prompt_tokens: null, completion_tokens: null, total_tokens: null, prompt_tokens_details: { cached_tokens: null }, completion_tokens_details: { reasoning_tokens: null }, reason: unknown };
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
 * A Messages usage: Anthropic counts the uncached input in `input_tokens` and the cache's two
 * counts beside it, so the three add up to what `input` holds.
 */
export function anthropicUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: null, reason: unknown };
  const cacheRead = u?.cacheRead || 0;
  const cacheWrite = u?.cacheWrite || 0;
  return { input_tokens: Math.max(0, (u?.input || 0) - cacheRead - cacheWrite), cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: u?.output || 0 };
}

/** A Responses usage object, with every field the openai SDK's model asks for. */
export function responsesUsage(u) {
  const unknown = usageUnknown(u);
  if (unknown) return { input_tokens: null, input_tokens_details: { cached_tokens: null }, output_tokens: null, output_tokens_details: { reasoning_tokens: null }, total_tokens: null, reason: unknown };
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
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: anthropicUsage(usage) } },
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

export function errorBody(message, type = 'invalid_request_error', status = 400, provider = null) {
  return { error: { message: `keysmith: ${message}`, type, param: null, code: null, ...(provider ? { provider } : {}) }, status };
}
