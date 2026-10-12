/**
 * CLI stdout parsers.
 *
 * Every parser is an async generator: `line stream in -> canonical events out`.
 * Canonical events:
 *   {type:'delta', text}            append to the assistant message
 *   {type:'reasoning', text}        thinking text (only forwarded when the client asked)
 *   {type:'usage', usage:{input,output,cacheRead,cacheWrite}}
 *   {type:'session', id}            resumable conversation id
 *   {type:'error', message, code?}  code 'tool_denied': the run called a tool the
 *                                   harness refused, and answered nothing
 *   {type:'tool', name}             the agent started a tool call. For the adapter only
 *                                   (see `stopAtToolCall`); it never reaches a client
 *   {type:'done', finishReason}
 * Parsers must never throw on a line they do not understand — an unknown event is
 * just noise, and killing a half-finished completion over it would be worse.
 */

import { truncate } from './util.js';

const EV = {
  delta: (text) => ({ type: 'delta', text }),
  usage: (usage) => ({ type: 'usage', usage }),
  session: (id) => ({ type: 'session', id }),
  error: (message, code) => ({ type: 'error', message, ...(code ? { code } : {}) }),
  tool: (name) => ({ type: 'tool', name }),
  done: (finishReason = 'stop') => ({ type: 'done', finishReason }),
};

/**
 * Every harness spells token counts differently. Map to one shape and never invent a
 * split: an upstream that reports only `total` gets `total`, because the input/output
 * breakdown is exactly what people use to reason about quota.
 */
function normaliseUsage(u = {}) {
  if (!u || typeof u !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) if (typeof u[k] === 'number') return u[k];
    return 0;
  };
  const cache = u.cache && typeof u.cache === 'object' ? u.cache : {};
  const usage = {
    input: pick('inputTokens', 'input_tokens', 'prompt_tokens', 'input'),
    output: pick('outputTokens', 'output_tokens', 'completion_tokens', 'output'),
    cacheRead: pick('cacheReadTokens', 'cache_read_input_tokens', 'cache_read_tokens') || cache.read || 0,
    cacheWrite: pick('cacheWriteTokens', 'cache_creation_input_tokens') || cache.write || 0,
  };
  const total = pick('total', 'total_tokens');
  if (total && !usage.input && !usage.output) usage.total = total;
  return usage.input || usage.output || usage.total ? usage : null;
}

function json(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Command Code (`cmd -p --output-format json`) — verified against cmd 1.66.0. */
export async function* cmdNdjson(lines) {
  let done = false;
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === 'event') {
      const e = d.event || {};
      if (e.type === 'text_delta' && e.delta) yield EV.delta(e.delta);
      else if (e.type === 'thinking_delta' && e.delta) yield { type: 'reasoning', text: e.delta };
      else if (e.type === 'model_request_end' && e.usage) yield EV.usage(normaliseUsage(e.usage));
      continue;
    }
    if (d.type === 'result') {
      done = true;
      if (d.sessionId) yield EV.session(d.sessionId);
      if (d.usage) yield EV.usage(normaliseUsage(d.usage));
      if (d.subtype && d.subtype !== 'success') yield EV.error(`cmd: ${d.subtype}${d.error ? ' — ' + d.error : ''}`);
      yield EV.done(d.stopReason === 'aborted' ? 'stop' : 'stop');
    }
  }
  if (!done) yield EV.done('stop');
}

/** opencode (`opencode run --format json`) — verified against opencode 1.18.27. */
export async function* opencodeNdjson(lines) {
  let emitted = 0;
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const part = d.part || {};
    if (d.type === 'text' && typeof part.text === 'string') {
      // opencode flushes the whole text block, not deltas; only send the new tail.
      if (part.text.length > emitted) {
        yield EV.delta(part.text.slice(emitted));
        emitted = part.text.length;
      } else if (part.text.length < emitted) {
        yield EV.delta(part.text);
        emitted = part.text.length;
      }
    } else if (d.type === 'step_finish') {
      const u = normaliseUsage(part.tokens) || normaliseUsage(part.completion_tokens);
      if (u) yield EV.usage(u);
      if (d.sessionID) yield EV.session(d.sessionID);
    } else if (d.type === 'error') {
      yield EV.error(part.message || d.error?.message || 'opencode error');
    }
  }
  yield EV.done('stop');
}

/**
 * Claude-Code-shaped stream (`claude -p --output-format stream-json`), which
 * Qoder CLI and other Claude-derived harnesses imitate. Message objects arrive whole,
 * so deltas are computed against what has already been forwarded.
 */
export async function* claudeStreamJson(lines) {
  const sent = new Map(); // message id -> chars forwarded
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === 'assistant' && d.message?.content) {
      for (const block of d.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const key = d.message.id || 'current';
          const prev = sent.get(key) || 0;
          if (block.text.length > prev) yield EV.delta(block.text.slice(prev));
          sent.set(key, Math.max(prev, block.text.length));
        } else if (block.type === 'thinking' && block.thinking) {
          yield { type: 'reasoning', text: block.thinking };
        }
      }
    } else if (d.type === 'result') {
      if (d.usage) yield EV.usage(normaliseUsage(d.usage));
      if (d.session_id) yield EV.session(d.session_id);
      // On a failed run Claude Code leaves `result` null and puts the reason in
      // `errors[]`; the subtype alone ("error_during_execution") tells the user nothing.
      if (d.is_error) yield EV.error(truncate([d.result, ...(Array.isArray(d.errors) ? d.errors : [])].filter(Boolean).join(' — ') || d.subtype || 'cli error', 400));
      yield EV.done('stop');
      return;
    } else if (d.type === 'error') {
      yield EV.error(d.message || 'cli error');
    }
  }
  yield EV.done('stop');
}

/**
 * Antigravity CLI (`agy --output-format stream-json -p …`) — verified against agy 1.3.3.
 *
 *   {"event":"init","conversation_id":"…","init":{"model":…,"tools":[…]}}
 *   {"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"po"}}
 *   {"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"ng","usage":{…}}}
 *   {"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"manage_task",…}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"pong","usage":{…},"denied_actions":[…]}}
 *
 * Three things the shape gets wrong for a completion API, all handled here:
 *  - `result.usage` is the whole conversation's total, so a resumed thread reports every
 *    earlier turn again. The per-step usage on `agent_response` steps is what this run
 *    actually spent; it is summed and reported once.
 *  - Headless mode cannot ask for tool permission, so a model that reaches for a tool is
 *    auto-denied and the run "succeeds" with an empty response. That is an error, named.
 *  - A run is an agent loop, not one answer: after its text the model may call a tool and
 *    answer again, as often as it likes. Each tool step is reported once as a `tool` event,
 *    so an adapter that wants one answer can end the run there. A run stopped that way has
 *    no `result` line, so the usage counted so far is reported when the stream ends.
 */
export async function* agyStreamJson(lines) {
  let emitted = false;
  let sessionSent = false;
  let lastToolStep = null;
  const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stepUsage = false;
  const session = function* (id) {
    if (id && !sessionSent) {
      sessionSent = true;
      yield EV.session(id);
    }
  };
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.event === 'init') {
      yield* session(d.conversation_id || d.init?.conversation_id);
    } else if (d.event === 'step_update') {
      const s = d.step_update || {};
      yield* session(s.conversation_id);
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
        emitted = true;
        yield EV.delta(s.text_delta);
      }
      const u = s.step_type === 'agent_response' ? normaliseUsage(s.usage) : null;
      if (u) {
        stepUsage = true;
        for (const k of Object.keys(spent)) spent[k] += u[k] || 0;
      }
      if (s.step_type === 'tool') {
        // ACTIVE then DONE/ERROR arrive for the same step: one call, one event.
        const step = s.step_index ?? `${s.tool_name}`;
        if (step !== lastToolStep) {
          lastToolStep = step;
          yield EV.tool(s.tool_name || s.tool_info?.name || 'a tool');
        }
      }
    } else if (d.event === 'result') {
      const r = d.result || {};
      yield* session(r.conversation_id);
      // A resumed run's stream can carry no text deltas at all on some paths; the final
      // response is still the answer, so it is the fallback rather than a dropped reply.
      if (!emitted && typeof r.response === 'string' && r.response.trim()) {
        emitted = true;
        yield EV.delta(r.response);
      }
      const usage = stepUsage ? spent : normaliseUsage(r.usage);
      if (usage && (usage.input || usage.output || usage.total)) yield EV.usage(usage);
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
      if (r.status && r.status !== 'SUCCESS') {
        const why = typeof r.error === 'string' ? r.error : r.error?.message || r.message || '';
        yield EV.error(truncate(`agy: ${r.status}${why ? ' — ' + why : ''}`, 400));
      } else if (!emitted && denied.length) {
        const names = denied.map((a) => a.display_name || a.action).filter(Boolean).join(', ');
        // `code` is what lets the adapter retry this one failure (see `toolDenialRetry`)
        // without pattern-matching an English sentence.
        yield EV.error(`agy: the model called ${names || 'a tool'}, which headless mode auto-denies, and answered nothing`, 'tool_denied');
      }
      yield EV.done('stop');
      return;
    } else if (d.event === 'error') {
      yield EV.error(truncate(`agy: ${typeof d.error === 'string' ? d.error : d.error?.message || d.message || 'error'}`, 400));
    }
  }
  // No `result` line: the process was stopped or killed. What it spent is still spent.
  if (stepUsage && (spent.input || spent.output)) yield EV.usage(spent);
  yield EV.done('stop');
}

/** Anything that just prints the answer. */
export async function* rawText(lines) {
  const out = [];
  for await (const line of lines) out.push(line);
  const text = out.join('\n');
  if (text.trim()) yield EV.delta(text.replace(/^\n+/, ''));
  yield EV.done('stop');
}

export const PARSERS = {
  'cmd-ndjson': cmdNdjson,
  'opencode-ndjson': opencodeNdjson,
  'claude-stream-json': claudeStreamJson,
  'agy-stream-json': agyStreamJson,
  raw: rawText,
};

export function getParser(name) {
  const p = PARSERS[name || 'raw'];
  if (!p) throw new Error(`unknown parser "${name}" — one of ${Object.keys(PARSERS).join(', ')}`);
  return p;
}

/** Byte stream -> line iterator (no trailing empty line for the final newline). */
export async function* toLines(byteChunks) {
  let buf = '';
  for await (const chunk of byteChunks) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}
