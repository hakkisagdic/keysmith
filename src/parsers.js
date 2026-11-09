/**
 * CLI stdout parsers.
 *
 * Every parser is an async generator: `line stream in -> canonical events out`.
 * Canonical events:
 *   {type:'delta', text}            append to the assistant message
 *   {type:'reasoning', text}        thinking text (only forwarded when the client asked)
 *   {type:'usage', usage:{input,output,cacheRead,cacheWrite,reasoning?}, scope?}
 *                                   `input` is every input token the upstream charged, the
 *                                   ones it read from or wrote to its cache included (OpenAI's
 *                                   reading of prompt_tokens); `cacheRead`/`cacheWrite` say how
 *                                   many of them, `reasoning` how many of `output` were thinking.
 *                                   A parser of a harness that counts the uncached input alone
 *                                   (Anthropic's input_tokens, opencode's tokens.input) adds the
 *                                   cache back. `scope: 'run'`: the run's whole spend so far (a
 *                                   result line), not one model step's — the MCP bridge, whose
 *                                   one run answers several HTTP turns, reads it that way
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
    input: pick('inputTokens', 'input_tokens', 'prompt_tokens', 'input', 'tokensIn'),
    output: pick('outputTokens', 'output_tokens', 'completion_tokens', 'output', 'tokensOut'),
    cacheRead: pick('cacheReadTokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens', 'cached', 'cacheReads', 'cacheRead') || cache.read || 0,
    cacheWrite: pick('cacheWriteTokens', 'cache_creation_input_tokens', 'cache_write_tokens', 'cacheWrites', 'cacheWrite') || cache.write || 0,
  };
  const reasoning = pick('reasoning_output_tokens', 'reasoningTokens', 'reasoning_tokens', 'thoughts');
  if (reasoning) usage.reasoning = reasoning;
  const total = pick('total', 'total_tokens');
  if (total && !usage.input && !usage.output) usage.total = total;
  return usage.input || usage.output || usage.total ? usage : null;
}

/**
 * Usage of a harness that counts the uncached input alone — the Anthropic API's `input_tokens`
 * (Claude Code's result and assistant lines), opencode's `tokens.input` — with the cache read and
 * written added back into `input`: what the upstream charged as input, the harness's own system
 * prompt (cached, as a rule) included.
 */
function cacheExclusive(u) {
  const usage = normaliseUsage(u);
  if (!usage || usage.total) return usage;
  usage.input += usage.cacheRead + usage.cacheWrite;
  return usage;
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
        const err = typeof part.state?.error === 'string' && part.state.error ? part.state.error : null;
        const errorType = err
          ? /^The user has specified a rule which prevents you from using this specific tool call\./.test(err)
            ? 'DeniedError'
            : /^The user rejected permission to use this specific tool call/.test(err)
              ? 'RejectedError'
              : /^Model tried to call unavailable tool\b/.test(err)
                ? 'UnavailableToolError'
                : 'ToolError'
          : part.state?.status === 'completed'
            ? 'executed'
            : null;
        yield { ...EV.tool(part.tool || 'a tool'), ...(err ? { error: err } : {}), ...(errorType ? { errorType } : {}) };
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
      // opencode's tokens.input leaves out what was read from the cache (it subtracts it from the
      // provider's count): added back, so `input` is what the provider charged.
      const u = cacheExclusive(part.tokens) || normaliseUsage(part.completion_tokens);
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
 * Qoder CLI and other Claude-derived harnesses imitate.
 */
export async function* claudeStreamJson(lines, { perMessageUsage = false } = {}) {
  const blocks = wholeBlocks(); // per message id
  const tools = new Set();
  const spentBy = new Map(); // message id -> the usage reported for it so far
  for await (const line of lines) {
    const d = json(line);
    if (!d) continue;
    if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      if (perMessageUsage && d.message.usage && typeof d.message.id === 'string') {
        // Each message's usage once, and after that only what it grew by: a run's messages add up.
        const now = cacheExclusive(d.message.usage);
        const was = spentBy.get(d.message.id) || null;
        const grew = now && usageGrowth(was, now);
        if (grew) {
          spentBy.set(d.message.id, now);
          yield { type: 'usage', usage: grew, scope: 'step' };
        }
      }
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
      const u = d.usage ? cacheExclusive(d.usage) : null;
      if (u) yield { type: 'usage', usage: u, scope: 'run' };
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
        yield EV.error(`agy: the model called ${names || 'a tool'}, which headless mode auto-denies, and answered nothing`, 'tool_denied');
      }
      yield EV.done('stop');
      return;
    } else if (d.event === 'error') {
      yield EV.error(truncate(`agy: ${typeof d.error === 'string' ? d.error : d.error?.message || d.message || 'error'}`, 400));
    }
  }
  if (stepUsage && !perStepUsage && (spent.input || spent.output)) yield EV.usage(spent);
  yield EV.done('stop');
}

/** What `now` adds to `was` (two reports of one message), per field; null when it adds nothing. */
function usageGrowth(was, now) {
  if (!was) return now;
  const out = {};
  let any = false;
  for (const [k, v] of Object.entries(now)) {
    const d = typeof v === 'number' ? v - (was[k] || 0) : 0;
    out[k] = d > 0 ? d : 0;
    if (d > 0) any = true;
  }
  return any ? out : null;
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
 * Warp's agent CLI (`oz agent run --output-format ndjson`) — Oz v0.2026.10.07.
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
 * Codex CLI (`codex exec --json`) — codex 0.163.0.
 */
export async function* codexJson(lines, { finalOnly = false } = {}) {
  const tools = new Set();
  let afterText = false;
  let last = null;
  let held = null;
  const flush = function* () {
    if (last !== null) yield EV.delta(last);
    last = null;
  };
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
          if (finalOnly) last = it.text;
          else yield EV.delta(afterText ? `\n\n${it.text}` : it.text);
          afterText = true;
        }
      } else if (kind === 'reasoning') {
        if (d.type === 'item.completed' && typeof it.text === 'string' && it.text) yield { type: 'reasoning', text: it.text };
      } else if (!CODEX_QUIET_ITEMS.has(kind)) {
        afterText = false;
        const key = typeof it.id === 'string' && it.id ? it.id : `${kind}#${tools.size}`;
        if (!tools.has(key)) {
          tools.add(key);
          yield EV.tool(kind === 'mcp_tool_call' ? `mcp__${String(it.server ?? '')}__${String(it.tool ?? '')}` : kind);
        }
      }
    } else if (d.type === 'turn.completed') {
      held = null;
      yield* flush();
      const u = d.usage && typeof d.usage === 'object' ? d.usage : null;
      if (u) {
        const usage = normaliseUsage({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens, reasoning_output_tokens: u.reasoning_output_tokens });
        if (usage) yield { type: 'usage', usage, scope: 'run' };
      }
    } else if (d.type === 'turn.failed') {
      const why = typeof d.error === 'string' && d.error ? d.error : d.error?.message || held || 'turn failed';
      held = null;
      yield EV.error(truncate(`codex: ${why}`, 400));
    } else if (d.type === 'error') {
      held = typeof d.message === 'string' && d.message ? d.message : 'error';
    }
  }
  if (held !== null) yield EV.error(truncate(`codex: ${held}`, 400));
  yield* flush();
  yield EV.done('stop');
}

export function codexJsonFinal(lines) {
  return codexJson(lines, { finalOnly: true });
}

/**
 * Universal JSON/NDJSON/text stream parser (`harness-json`) for the extended CLI harness ecosystem:
 * Gemini CLI, Kilo, Qwen Code, Cline, Goose, Kimi CLI, MiniMax, Grok, Pi, Oh-My-Pi, DSH, Aider,
 * Mimo, Jcode, Mistral Vibe, Hermes, OpenHands, CheetahClaws, OpenSquilla, Nanobot, ZeroClaw,
 * Docker Agent, Fast-Agent, Dcode, Traycer CLI, Factory Droid, Devin, Copilot CLI, Cursor, Amp, and Reasonix.
 */
export async function* harnessJson(lines) {
  const blocks = wholeBlocks();
  const tools = new Set();
  const seenSessions = new Set();
  let emittedText = false;
  let sawJson = false;
  const plainLines = [];
  let lastUsage = null;

  const emitSession = function* (id) {
    if (typeof id === 'string' && id.trim()) {
      const s = id.trim();
      if (!seenSessions.has(s)) {
        seenSessions.add(s);
        yield EV.session(s);
      }
    }
  };

  const emitTool = function* (name, id) {
    const toolName = (typeof name === 'string' && name.trim()) || 'a tool';
    const key = (typeof id === 'string' && id) || `${toolName}#${tools.size}`;
    if (!tools.has(key)) {
      tools.add(key);
      yield EV.tool(toolName);
    }
  };

  for await (const line of lines) {
    const d = json(line);
    if (!d) {
      const hermesMatch = typeof line === 'string' ? line.match(/^session_id:\s*(\S+)/i) : null;
      if (hermesMatch) {
        yield* emitSession(hermesMatch[1]);
        continue;
      }
      plainLines.push(line);
      continue;
    }
    sawJson = true;

    // 1. Session ID extraction across CLI conventions
    const sid =
      d.session_id ||
      d.sessionId ||
      d.sessionID ||
      d.thread_id ||
      d.threadId ||
      d.taskId ||
      d.conversation_id ||
      d.chat_id ||
      d.session?.id ||
      d.metadata?.session_id ||
      d.meta?.agentMeta?.sessionId ||
      (d.type === 'session' && d.id);
    if (sid) yield* emitSession(sid);

    // 2. Usage extraction (including Gemini stats.models, OpenHands llm_metrics, OpenSquilla meta, Goose total_tokens, Pi turn_end)
    const u =
      normaliseUsage(d.usage) ||
      normaliseUsage(d.tokens) ||
      normaliseUsage(d.tokenUsage) ||
      normaliseUsage(d.metrics) ||
      normaliseUsage(d.result?.usage) ||
      normaliseUsage(d.message?.usage) ||
      normaliseUsage(d.llm_metrics?.accumulated_token_usage) ||
      normaliseUsage(d.meta?.agentMeta?.usage) ||
      (d.type === 'complete' && typeof d.total_tokens === 'number'
        ? { input: 0, output: d.total_tokens, cacheRead: 0, cacheWrite: 0 }
        : null) ||
      extractGeminiStatsUsage(d.stats);
    if (u) lastUsage = u;

    // 3. Cline (`type: "say"`)
    if (d.type === 'say') {
      if (d.say === 'reasoning' && typeof d.text === 'string' && d.text) {
        yield { type: 'reasoning', text: d.text };
      } else if (d.say === 'tool' && typeof d.text === 'string') {
        const tj = json(d.text);
        yield* emitTool(tj?.tool || tj?.name || 'tool', tj?.id);
      } else if (d.say === 'api_req_started' && typeof d.text === 'string') {
        const uj = json(d.text);
        const cu = normaliseUsage(uj);
        if (cu) lastUsage = cu;
      } else if ((d.say === 'text' || !d.say) && typeof d.text === 'string' && d.text) {
        const b = blocks('cline_say', d.text);
        if (b.text) {
          emittedText = true;
          yield EV.delta(b.text);
        }
      }
      continue;
    }

    // 4. OpenHands (`source: "agent"`, `action: "run" | "message"`)
    if (d.source === 'agent' && typeof d.action === 'string') {
      if (typeof d.args?.thought === 'string' && d.args.thought) {
        yield { type: 'reasoning', text: d.args.thought };
      }
      if (d.action === 'message') {
        const msg = d.args?.content || d.message;
        if (typeof msg === 'string' && msg) {
          emittedText = true;
          yield EV.delta(msg);
        }
      } else {
        yield* emitTool(d.action, d.id ? String(d.id) : undefined);
      }
      continue;
    }

    // 5. OpenSquilla (`payloads: [{ text }]`)
    if (Array.isArray(d.payloads)) {
      const joined = d.payloads
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
      if (joined) {
        emittedText = true;
        yield EV.delta(joined);
      }
      continue;
    }

    // 6. Pi / Oh-My-Pi `message_update` & `turn_end` events
    if (d.type === 'message_update' && d.assistantMessageEvent && typeof d.assistantMessageEvent === 'object') {
      const ev = d.assistantMessageEvent;
      if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
        emittedText = true;
        yield EV.delta(ev.delta);
      } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string' && ev.delta) {
        yield { type: 'reasoning', text: ev.delta };
      } else if (ev.type === 'toolcall_start' || ev.type === 'toolcall_end' || ev.type === 'tool_use') {
        const tc = ev.toolCall || ev;
        yield* emitTool(tc.toolName || tc.name, tc.id || tc.toolCallId);
      }
      continue;
    }
    if (d.type === 'turn_end') {
      continue;
    }

    // 7. dcode (`message.delta`, `tool.start`, `run.end`, `run.start`)
    if (d.type === 'message.delta') {
      if (typeof d.text === 'string' && d.text) {
        emittedText = true;
        yield EV.delta(d.text);
      }
      continue;
    }
    if (d.type === 'tool.start') {
      yield* emitTool(d.name || d.tool_name, d.id);
      continue;
    }
    if (d.type === 'run.start' || d.type === 'run.end' || d.type === 'complete') {
      continue;
    }

    // 8. Tool invocation events
    if (
      d.type === 'tool_use' ||
      d.type === 'tool_call' ||
      d.type === 'tool_execution_start' ||
      d.type === 'tool_queued' ||
      d.type === 'tool_running'
    ) {
      const part = d.part && typeof d.part === 'object' ? d.part : d;
      const tName = part.tool || part.tool_name || part.toolName || part.name || d.tool_call?.name;
      const tId = part.callID || part.call_id || part.toolCallId || part.id;
      yield* emitTool(tName, tId);
      continue;
    }

    // 9. Claude / Qwen / Kimi / Goose / Mimo `assistant` or `message` with content blocks or `tool_calls`
    const contentArr = Array.isArray(d.message?.content)
      ? d.message.content
      : Array.isArray(d.content)
        ? d.content
        : null;
    if ((d.type === 'assistant' || d.role === 'assistant' || (d.type === 'message' && d.message?.role === 'assistant')) && (contentArr || Array.isArray(d.tool_calls))) {
      const msgId = d.message?.id || d.id || 'assistant';
      if (contentArr) {
        for (const block of contentArr) {
          if (!block || typeof block !== 'object') continue;
          if ((block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') {
            if (d.type === 'message' && d.message?.role === 'assistant') {
              // Goose streams incremental text chunks inside message.content
              emittedText = true;
              yield EV.delta(block.text);
            } else {
              const b = blocks(msgId, block.text);
              if (b.text) {
                emittedText = true;
                yield EV.delta(b.text);
              }
            }
          } else if ((block.type === 'thinking' || block.type === 'reasoning' || block.type === 'think') && (block.thinking || block.text || block.think)) {
            yield { type: 'reasoning', text: block.thinking || block.text || block.think };
          } else if (block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'function_call' || block.type === 'toolRequest') {
            yield* emitTool(block.name || block.tool_name || block.toolCall?.name, block.id || block.call_id);
          }
        }
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          yield* emitTool(tc.function?.name || tc.name, tc.id);
        }
      }
      continue;
    }

    // 10. Gemini CLI / Qwen / Kilo streaming message (`{ type: "message", role: "assistant", content: "..." }`)
    if (d.type === 'message') {
      if (d.role && d.role !== 'assistant') continue;
      if (typeof d.content === 'string' && d.content) {
        if (d.delta) {
          emittedText = true;
          yield EV.delta(d.content);
        } else {
          const b = blocks(d.id || 'message', d.content);
          if (b.text) {
            emittedText = true;
            yield EV.delta(b.text);
          }
        }
      }
      continue;
    }

    // 11. Streaming text / reasoning deltas (`text_delta`, `content_block_delta`, `delta`, `text`)
    if (d.type === 'text_delta' || d.type === 'delta') {
      const txt = typeof d.delta === 'string' ? d.delta : typeof d.text === 'string' ? d.text : '';
      if (txt) {
        emittedText = true;
        yield EV.delta(txt);
      }
      continue;
    }
    if (d.type === 'content_block_delta' && d.delta) {
      if (typeof d.delta.text === 'string' && d.delta.text) {
        emittedText = true;
        yield EV.delta(d.delta.text);
      } else if (typeof d.delta.thinking === 'string' && d.delta.thinking) {
        yield { type: 'reasoning', text: d.delta.thinking };
      }
      continue;
    }
    if (d.type === 'thinking' || d.type === 'reasoning' || d.type === 'thinking_delta') {
      const rText = d.thinking || d.text || d.delta || d.content;
      if (typeof rText === 'string' && rText) yield { type: 'reasoning', text: rText };
      continue;
    }
    if (d.type === 'text' || d.type === 'agent' || d.type === 'agent_message') {
      const partText = typeof d.part?.text === 'string' ? d.part.text : typeof d.text === 'string' ? d.text : typeof d.content === 'string' ? d.content : '';
      if (partText) {
        const key = d.part?.id || d.id || 'text';
        const b = blocks(key, partText);
        if (b.text) {
          emittedText = true;
          yield EV.delta(b.text);
        }
      }
      continue;
    }

    // 12. Result / completion / single-object JSON envelopes (`result`, `response`, `output`, `reply`)
    if (d.type === 'result' || d.response != null || d.result != null || d.output != null || d.reply != null) {
      if (d.is_error || d.status === 'error' || d.subtype === 'error') {
        const why =
          (typeof d.error === 'string' && d.error) ||
          d.error?.message ||
          (typeof d.result === 'string' && d.result) ||
          (Array.isArray(d.errors) && d.errors.join(' — ')) ||
          d.message ||
          'harness error';
        yield EV.error(truncate(String(why), 400));
      } else if (!emittedText) {
        const finalTxt =
          (typeof d.response === 'string' && d.response) ||
          (typeof d.result === 'string' && d.result) ||
          (typeof d.result?.response === 'string' && d.result.response) ||
          (typeof d.output === 'string' && d.output) ||
          (typeof d.reply === 'string' && d.reply) ||
          (typeof d.reply?.text === 'string' && d.reply.text) ||
          (typeof d.reply?.message === 'string' && d.reply.message) ||
          (typeof d.content === 'string' && d.content) ||
          (typeof d.text === 'string' && d.text) ||
          '';
        if (finalTxt) {
          emittedText = true;
          yield EV.delta(finalTxt);
        }
      }
      continue;
    }

    // 13. Error events
    if (d.type === 'error' || d.error) {
      const why =
        (typeof d.error === 'string' && d.error) ||
        d.error?.message ||
        d.error?.data?.message ||
        d.part?.message ||
        d.message ||
        'harness error';
      yield EV.error(truncate(String(why), 400));
    }
  }

  if (!sawJson && plainLines.length) {
    const text = plainLines.join('\n').replace(/^\n+/, '');
    if (text.trim()) yield EV.delta(text);
  }
  if (lastUsage) yield EV.usage(lastUsage);
  yield EV.done('stop');
}

function extractGeminiStatsUsage(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (stats.input_tokens != null || stats.output_tokens != null) {
    return normaliseUsage(stats);
  }
  const models = stats.models;
  if (!models || typeof models !== 'object') return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let reasoning = 0;
  for (const m of Object.values(models)) {
    const t = m?.tokens;
    if (!t || typeof t !== 'object') continue;
    input += Number(t.prompt || t.input || 0);
    output += Number(t.candidates || t.output || 0);
    cacheRead += Number(t.cached || 0);
    reasoning += Number(t.thoughts || 0);
  }
  if (!input && !output) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    ...(reasoning ? { reasoning } : {}),
  };
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
  'codex-json-final': codexJsonFinal,
  'harness-json': harnessJson,
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
