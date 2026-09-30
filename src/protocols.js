import { randomUUID } from 'node:crypto';
import { contentToText } from './util.js';

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
  return messages.map((m) => ({
    role: m.role === 'developer' ? 'system' : m.role || 'user',
    content: typeof m.content === 'string' ? m.content : contentToText(m.content),
  }));
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

export function openaiUsage(u) {
  const input = u?.input || 0;
  const output = u?.output || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: u?.total || input + output,
    prompt_tokens_details: { cached_tokens: u?.cacheRead || 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
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
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentToText(m.content) });
  }
  return out.filter((m) => m.content);
}

export function anthropicStreamEvents({ id, model, text, usage }) {
  const msgId = `msg_${id}`;
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: usage?.input || 0, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.output || 0 } } },
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
    usage: { input_tokens: usage?.input || 0, output_tokens: usage?.output || 0 },
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
      if (text) out.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text });
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
    usage: { input_tokens: usage?.input || 0, output_tokens: usage?.output || 0, total_tokens: (usage?.input || 0) + (usage?.output || 0) },
  };
}

export function errorBody(message, type = 'invalid_request_error', status = 400, provider = null) {
  return { error: { message: `keysmith: ${message}`, type, param: null, code: null, ...(provider ? { provider } : {}) }, status };
}
