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

/**
 * Text a CLI prints whole, block by block, into deltas — opencode's text parts, the text blocks of
 * a Claude-Code-shaped message. The function it returns takes `(key, text)` and gives back
 * `{ text, fresh }`, what to forward: under one key (a part's
 * id, a message's), a block that extends the one forwarded last is that block grown or printed
 * again, and only its new tail goes out; an earlier print of it, or a block forwarded before it,
 * goes out never again; any other text is a new block, whole (`fresh`). No block is ever cut by
 * the length of another: a parser that counted one length across blocks dropped a shorter next
 * block and cut a longer one — and on the MCP bridge one parser reads every HTTP turn of a session.
 */
function wholeBlocks() {
  const seen = new Map(); // key -> { last: the block forwarded last, before: the blocks forwarded before it }
  return (key, text) => {
    let s = seen.get(key);
    if (!s) seen.set(key, (s = { last: null, before: new Set() }));
    if (s.last !== null) {
      if (text.startsWith(s.last)) {
        const tail = text.slice(s.last.length);
        s.last = text;
        return { text: tail, fresh: false };
      }
      if (s.last.startsWith(text)) return { text: '', fresh: false };
    }
    if (s.before.has(text)) return { text: '', fresh: false };
    if (s.last !== null) s.before.add(s.last);
    s.last = text;
    return { text, fresh: true };
  };
}

/**
 * Command Code (`cmd -p --output-format json`) — verified against cmd 1.66.0. A tool call is
 * reported once, at `tool_queued` — which Command Code 1.81.0 emits before its permission
 * check and `tool_running` (read from its bundle, not seen live) — so `stopAtToolCall` can
 * stop the run as early as the stream allows.
 */
export async function* cmdNdjson(lines) {
  let done = false;
  const tools = new Set();
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === 'event') {
      const e = d.event || {};
      if (e.type === 'text_delta' && e.delta) yield EV.delta(e.delta);
      else if (e.type === 'thinking_delta' && e.delta) yield { type: 'reasoning', text: e.delta };
      else if (e.type === 'model_request_end' && e.usage) yield EV.usage(normaliseUsage(e.usage));
      else if ((e.type === 'tool_queued' || e.type === 'tool_running') && (e.toolName || e.toolCallId)) {
        const key = e.toolCallId || `${e.toolName}#${tools.size}`;
        if (!tools.has(key)) {
          tools.add(key);
          yield EV.tool(e.toolName || 'a tool');
        }
      }
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

/**
 * opencode (`opencode run --format json`) — verified against opencode 1.18.27. A tool call
 * is a `tool_use` line (`part.tool`, `part.callID`), reported once per call. An error line
 * carries its reason under `error.data.message`, with the upstream's `statusCode` (opencode's
 * free tier refuses the tool-less run with a 403 that says why).
 *
 * Text is a `text` line per text part, the part whole — opencode 1.19.3 prints it once, when the
 * part ends (`part.time.end`) — so it is forwarded per part (`part.id`; its message's id when it
 * has none): a new part whole, a part printed again only for what it grew. Two parts with no call
 * between them are two paragraphs; the part after a call is a new answer (on the MCP bridge, the
 * next HTTP turn's, read by this same parser), not a second paragraph of this one.
 */
export async function* opencodeNdjson(lines) {
  const blocks = wholeBlocks();
  let afterText = false; // the last thing forwarded was text: a new part is a new paragraph
  const tools = new Set();
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    const part = d.part || {};
    if (d.type === 'tool_use') {
      afterText = false;
      const key = part.callID || part.id || `${part.tool}#${tools.size}`;
      if (!tools.has(key)) {
        tools.add(key);
        yield EV.tool(part.tool || 'a tool');
      }
      continue;
    }
    if (d.type === 'text' && typeof part.text === 'string') {
      const key = (typeof part.id === 'string' && part.id) || (typeof part.messageID === 'string' && part.messageID) || 'current';
      const b = blocks(key, part.text);
      if (b.text) {
        yield EV.delta(b.fresh && afterText ? `\n\n${b.text}` : b.text);
        afterText = true;
      }
    } else if (d.type === 'step_finish') {
      const u = normaliseUsage(part.tokens) || normaliseUsage(part.completion_tokens);
      if (u) yield EV.usage(u);
      if (d.sessionID) yield EV.session(d.sessionID);
    } else if (d.type === 'error') {
      const why = part.message || d.error?.message || d.error?.data?.message;
      const status = d.error?.data?.statusCode;
      yield EV.error(why ? `opencode${status ? ` ${status}` : ''}: ${truncate(String(why), 400)}` : 'opencode error');
    }
  }
  yield EV.done('stop');
}

/**
 * Claude-Code-shaped stream (`claude -p --output-format stream-json`), which
 * Qoder CLI and other Claude-derived harnesses imitate. Message objects arrive whole,
 * so deltas are computed against what has already been forwarded — per text block of a message
 * (Claude Code prints each content block of a message on a line of its own, under the message's
 * id): a second text block of one message is forwarded whole, never cut by the first one's length,
 * and joined to it with nothing between, as the text of two messages always was. A `tool_use` content block is
 * a `tool` event, once per block id — printed with the assistant message that made the call,
 * before the harness runs it (qodercli 1.1.59: `mcp__<server>__<tool>` for an MCP server's tool;
 * with its lazy MCP, `mcp_call` with the tool's name in `input.toolName`, read as that tool).
 */
export async function* claudeStreamJson(lines) {
  const blocks = wholeBlocks(); // per message id
  const tools = new Set();
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          const b = blocks(d.message.id || 'current', block.text);
          if (b.text) yield EV.delta(b.text);
        } else if (block.type === 'thinking' && block.thinking) {
          yield { type: 'reasoning', text: block.thinking };
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const key = block.id || `${block.name}#${tools.size}`;
          if (!tools.has(key)) {
            tools.add(key);
            // qoder's lazy MCP proxy (`mcp_call {toolName, arguments}`) calls the MCP tool it names:
            // that tool is the call, as far as a reader of this stream is concerned.
            const via = block.name === 'mcp_call' && typeof block.input?.toolName === 'string' && block.input.toolName ? block.input.toolName : null;
            yield EV.tool(via || (typeof block.name === 'string' && block.name ? block.name : 'a tool'));
          }
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
 *
 * `perStepUsage` (the MCP bridge, src/bridge/index.js): each agent_response step's usage is its
 * own `usage` event as the step ends, and nothing is summed — one run of the bridge answers
 * several HTTP turns, and each turn reports the steps it ran. The `result` line's total is
 * reported only when no step carried usage. Text runs read the stream as they always did.
 */
export async function* agyStreamJson(lines, { perStepUsage = false } = {}) {
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
        if (perStepUsage) yield EV.usage(u);
        else for (const k of Object.keys(spent)) spent[k] += u[k] || 0;
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
      const usage = stepUsage ? (perStepUsage ? null : spent) : normaliseUsage(r.usage);
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
  // No `result` line: the process was stopped or killed. What it spent is still spent (and,
  // per step, was reported as each step ended).
  if (stepUsage && !perStepUsage && (spent.input || spent.output)) yield EV.usage(spent);
  yield EV.done('stop');
}

/** Text out of an ACP content block: `{type:'text', text}`, an array of them, or a string. */
function acpText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(acpText).join('');
  if (content && typeof content === 'object' && (content.type === 'text' || content.type == null) && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * Kiro CLI (`kiro-cli chat --no-interactive --output-format stream-json`) — kiro-cli 2.27.1.
 * One `{type, data}` object per line, the run's ACP events wrapped:
 *
 *   {"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}
 *   {"type":"metadata","data":{"sessionId":"…","contextUsagePercentage":0.76,…}}
 *   {"type":"sessionUpdate","data":{"sessionId":"…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"O"}}}}
 *   {"type":"runFinished","data":{"finalText":"OK","finalTextTruncated":false}}
 *   {"type":"runError","data":{"sessionId":"…","stage":"prompt","message":"Internal error (code -32603): …"}}
 *
 * runStarted, metadata and runError were read off a live run, which the account's overage
 * limit refused before it wrote any text. The text events are the ACP `session/update`
 * notification (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`) and runFinished's
 * `finalText`, both named in the binary — so the answer is taken from the chunks, and from
 * `finalText` when no chunk carried any. A `sessionUpdate` whose payload is the update
 * itself (no `update` wrapper) is read the same way.
 */
export async function* kiroStreamJson(lines) {
  let emitted = false;
  let sessionSent = false;
  let usage = null;
  const toolCalls = new Set();
  for await (const line of lines) {
    const d = json(line);
    if (!d || typeof d.type !== 'string') continue;
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    if (typeof data.sessionId === 'string' && data.sessionId && !sessionSent) {
      sessionSent = true;
      yield EV.session(data.sessionId);
    }
    if (d.type === 'metadata') {
      // Token counts, when a metadata event carries them (the turn summary does in Kiro's
      // telemetry); the last one wins, since each is the turn so far.
      const u = normaliseUsage(data.tokenUsage) || normaliseUsage(data.usage) || normaliseUsage(data);
      if (u) usage = u;
    } else if (d.type === 'sessionUpdate') {
      const up = data.update && typeof data.update === 'object' ? data.update : data;
      const text = acpText(up.content);
      if (up.sessionUpdate === 'agent_message_chunk' && text) {
        emitted = true;
        yield EV.delta(text);
      } else if (up.sessionUpdate === 'agent_thought_chunk' && text) {
        yield { type: 'reasoning', text };
      } else if (up.sessionUpdate === 'tool_call') {
        // ACP sends `tool_call` once and `tool_call_update` after it: one call, one event.
        const id = up.toolCallId ?? `${up.title ?? ''}#${toolCalls.size}`;
        if (!toolCalls.has(id)) {
          toolCalls.add(id);
          yield EV.tool(up.title || up.kind || 'a tool');
        }
      }
    } else if (d.type === 'runFinished') {
      if (!emitted && typeof data.finalText === 'string' && data.finalText.trim()) {
        emitted = true;
        yield EV.delta(data.finalText);
      }
      if (usage) yield EV.usage(usage);
      yield EV.done('stop');
      return;
    } else if (d.type === 'runError') {
      const why = typeof data.message === 'string' ? data.message : data.error?.message || data.stage || 'error';
      yield EV.error(truncate(`kiro: ${why}`, 400));
    }
  }
  if (usage) yield EV.usage(usage);
  yield EV.done('stop');
}

/** The tools Warp's agent can call, as the binary names them; a `tool_call` line names one of them. */
const WARP_TOOLS = ['run_command', 'read_files', 'edit_files', 'search_codebase', 'call_mcp_tool', 'read_mcp_resource', 'upload_artifact'];

/**
 * Warp's agent CLI (`oz agent run --output-format ndjson`) — Oz v0.2026.10.07, read off a
 * live run:
 *
 *   {"type":"system","event_type":"run_started","run_id":"…","run_url":"https://oz.warp.dev/runs/…"}
 *   {"type":"system","event_type":"conversation_started","conversation_id":"…"}
 *   {"type":"agent","text":"OK\n"}
 *
 * No usage and no closing line: the process exiting is the end of the answer. The binary
 * names the other message types — agent_reasoning, tool_call, tool_result, tool_error,
 * tool_canceled, update_todos — and a `tool_call` is reported as a `tool` event, which is
 * what lets the adapter stop a run that reached for one (`stopAtToolCall`).
 */
export async function* warpNdjson(lines) {
  for await (const line of lines) {
    const d = json(line);
    if (!d || typeof d.type !== 'string') continue;
    if (d.type === 'agent' && typeof d.text === 'string' && d.text) {
      yield EV.delta(d.text);
    } else if (d.type === 'agent_reasoning' && typeof d.text === 'string' && d.text) {
      yield { type: 'reasoning', text: d.text };
    } else if (d.type === 'tool_call') {
      const named = [d.tool, d.name, d.tool_name, d.tool_call?.name].find((v) => typeof v === 'string' && v);
      yield EV.tool(named || WARP_TOOLS.find((t) => t in d || (d.tool_call && t in d.tool_call)) || 'a tool');
    } else if (d.type === 'system' && d.event_type === 'conversation_started' && typeof d.conversation_id === 'string') {
      yield EV.session(d.conversation_id);
    } else if (d.type === 'error') {
      const why = typeof d.error === 'string' ? d.error : d.error?.message || d.message || 'error';
      yield EV.error(truncate(`warp: ${why}`, 400));
    }
  }
  yield EV.done('stop');
}

/** The item types of `codex exec --json` that are not a tool: text, thinking, its own plan, a compaction, a warning. */
const CODEX_QUIET_ITEMS = new Set(['agent_message', 'reasoning', 'todo_list', 'context_compaction', 'error']);

/**
 * Codex CLI (`codex exec --json`) — codex 0.163.0, read off the tool-bridge probe's live runs:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'm checking …"}}
 *   {"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"ks3f9a0c","tool":"get_weather","arguments":{…},"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call",…,"result":{…},"status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":20221,"cached_input_tokens":14976,"output_tokens":144,"reasoning_output_tokens":20}}
 *
 * An agent message is a delta when it completes (codex sends it whole); two with no call between
 * them are two paragraphs. Every item that is not text, thinking, its plan (`todo_list`), a compaction or a
 * warning (`error` items: an MCP server that failed to start, say) is a tool: an MCP call is a
 * `tool` event named `mcp__<server>__<tool>` as it starts — before codex sends its tools/call —
 * and anything else (`command_execution`, `file_change`, `web_search`, a sub-agent's call, a type
 * this parser has never seen) a `tool` event named by its type, once per item. That is what the
 * bridge's tripwire reads (src/bridge/clis.js). `turn.completed` carries the run's usage,
 * `turn.failed` and a top-level `error` line its failure.
 */
export async function* codexJson(lines) {
  const tools = new Set();
  let afterText = false; // the last item that said anything was an agent message: a next one is a new paragraph
  for await (const line of lines) {
    const d = json(line);
    if (!d || typeof d.type !== 'string') continue;
    if (d.type === 'thread.started') {
      if (typeof d.thread_id === 'string' && d.thread_id) yield EV.session(d.thread_id);
    } else if (d.type === 'item.started' || d.type === 'item.updated' || d.type === 'item.completed') {
      const it = d.item && typeof d.item === 'object' ? d.item : {};
      const kind = typeof it.type === 'string' ? it.type : 'unknown';
      if (kind === 'agent_message') {
        if (d.type === 'item.completed' && typeof it.text === 'string' && it.text) {
          yield EV.delta(afterText ? `\n\n${it.text}` : it.text);
          afterText = true;
        }
      } else if (kind === 'reasoning') {
        if (d.type === 'item.completed' && typeof it.text === 'string' && it.text) yield { type: 'reasoning', text: it.text };
      } else if (!CODEX_QUIET_ITEMS.has(kind)) {
        // A call ends the paragraph: what the model says after its result is a new answer (on the
        // bridge, the next HTTP turn's), not a second paragraph of this one.
        afterText = false;
        const key = typeof it.id === 'string' && it.id ? it.id : `${kind}#${tools.size}`;
        if (!tools.has(key)) {
          tools.add(key);
          yield EV.tool(kind === 'mcp_tool_call' ? `mcp__${String(it.server ?? '')}__${String(it.tool ?? '')}` : kind);
        }
      }
    } else if (d.type === 'turn.completed') {
      const u = d.usage && typeof d.usage === 'object' ? d.usage : null;
      if (u) {
        // OpenAI's counts: output_tokens holds the reasoning tokens, input_tokens the cached ones.
        const usage = normaliseUsage({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens });
        if (usage) yield EV.usage(usage);
      }
    } else if (d.type === 'turn.failed') {
      const why = typeof d.error === 'string' ? d.error : d.error?.message || 'turn failed';
      yield EV.error(truncate(`codex: ${why}`, 400));
    } else if (d.type === 'error') {
      yield EV.error(truncate(`codex: ${typeof d.message === 'string' ? d.message : 'error'}`, 400));
    }
  }
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
  'kiro-stream-json': kiroStreamJson,
  'warp-ndjson': warpNdjson,
  'codex-json': codexJson,
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
