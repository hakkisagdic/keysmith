import { randomBytes } from 'node:crypto';
import { contentToText } from '../util.js';

/**
 * The canonical tool model: what a tool-carrying request says, in one shape, whichever face it
 * came through. Two engines (EMULATE and the MCP bridge) and three faces are built on it, so
 * nothing past this file reads an OpenAI or Anthropic body for its tools again.
 *
 * ToolSpec — the tools a request offers and what it asks of the model:
 *
 *   { tools:   [{ name, description, parameters }],      parameters: the client's JSON Schema, as sent
 *     choice:  { mode: 'auto'|'none'|'required'|'named', name? },
 *     parallel: boolean,                                   may one answer hold several calls
 *     unsupported: [{ type, name?, reason? }],             what no CLI leg can honour
 *     legacy?: true }                                      OpenAI's older `functions` (no `tools`):
 *                                                          one call per answer (parallel false),
 *                                                          written back as `function_call`
 *
 * `unsupported` is anything that is not a plain function tool — OpenAI `custom` tools, Anthropic
 * server tools (`web_search_*`, `bash_*`, `text_editor_*`, `computer_*` …), a `tool_choice` this
 * model has no word for, a name offered twice. A CLI leg never takes such a request: the router
 * moves on to the next leg, and with none left the request is a 400. Parsing never throws.
 *
 * Message — one turn of the conversation, tool-aware:
 *
 *   { role: 'system'|'user'|'assistant'|'tool', text,
 *     toolCalls?: [{ id, name, arguments, args }],         an assistant turn's calls
 *     toolCallId?, name?, isError? }                       a tool result
 *
 * `arguments` is the JSON text as the client sent it, `args` the object it parses to (null when
 * it does not). Text is read the way protocols.js reads it, so a request with no tool exchange
 * in it reads, byte for byte, as keysmith has always read it (test/tools-model.test.js holds
 * that to a snapshot of 4dce929).
 *
 * A tool exchange in the history is read as one even when the request offers no tools — and so
 * differs from protocols.js on purpose (design U1 promises byte identity for any tool-less
 * request; this is the recorded exception, and the snapshot holds both readings): a legacy
 * `function` result is a `tool` turn (protocols.js keeps role "function", which
 * flattenMessages labels User — untrusted tool output speaking as the user), and an Anthropic
 * `tool_result` is a `tool` turn (protocols.js drops its content). The prompt of today's
 * tool-less path, which reads protocols.js, does not change. (A message that is not an object,
 * which protocols.js fails on with a TypeError, is skipped here.)
 *
 * Events — what an engine yields, next to the canonical events of parsers.js:
 *
 *   { type: 'tool_call', id, name, arguments, args }      a call for the CLIENT to run
 *   { type: 'done', finishReason: 'tool_calls' }          after the calls of one answer
 *   { type: 'tool_mode', mode, fallback? }                 which engine answered, and why it is
 *                                                          not the one auto picked first — for
 *                                                          the usage log; never sent to a client
 *
 * A `tool_call` is never the adapter's own `tool` event (parsers.js): that one reports a CLI
 * reaching for ITS tools, exists for `stopAtToolCall`, and never leaves the adapter.
 */

export const FINISH_TOOL_CALLS = 'tool_calls';

/* -------------------------------------------------------------------------- ids */

const ID_PREFIX = { openai: 'call_', anthropic: 'toolu_', responses: 'call_' };

/**
 * A tool call id for one face: `call_<24>` (OpenAI chat, Responses) or `toolu_<24>` (Anthropic),
 * 24 hex characters from crypto.randomBytes. keysmith always makes the id itself; an id a model
 * wrote is never passed on — it could repeat, collide with another conversation's, or be chosen
 * to look like one.
 */
export function newToolCallId(face = 'openai') {
  return (ID_PREFIX[face] || ID_PREFIX.openai) + randomBytes(12).toString('hex');
}

/** The Responses API's item id for a function_call output item: `fc_<24>`. */
export function newToolItemId() {
  return 'fc_' + randomBytes(12).toString('hex');
}

/* ----------------------------------------------------------------------- events */

/**
 * The canonical `tool_call` event for a call the model made: `args` is a JSON object, and
 * `arguments` is the JSON text a face writes (OpenAI sends a string, Anthropic an object; both
 * come from here, so the two can never disagree). `id` defaults to a fresh one for `face`.
 */
export function toolCallEvent({ id = null, name, args = {}, face = 'openai' }) {
  if (typeof name !== 'string' || !name) throw new TypeError('a tool call needs a name');
  if (!isPlainObject(args)) throw new TypeError(`tool call "${name}": arguments must be a JSON object`);
  return { type: 'tool_call', id: typeof id === 'string' && id ? id : newToolCallId(face), name, arguments: JSON.stringify(args), args };
}

/* ------------------------------------------------------------------- tool specs */

/**
 * OpenAI chat: `tools` (and the older `functions`), `tool_choice` / `function_call`,
 * `parallel_tool_calls`. Null when the request offers no tool. A request that offers only
 * `functions` is a legacy one: its client reads one `message.function_call` with finish_reason
 * "function_call" and has no word for a second call, so the spec says `legacy` and parallel false
 * whatever parallel_tool_calls says, and the chat face answers in that shape.
 */
export function openaiToolSpec(body) {
  const listed = Array.isArray(body?.tools) ? body.tools : [];
  const legacy = Array.isArray(body?.functions) ? body.functions : [];
  if (!listed.length && !legacy.length) return null;
  const spec = emptySpec();
  for (const t of listed) {
    if (t && typeof t === 'object' && t.type === 'function' && t.function && typeof t.function === 'object') {
      addTool(spec, t.function.name, t.function.description, t.function.parameters, 'function');
    } else {
      spec.unsupported.push({ type: typeName(t), ...nameOf(t?.function?.name ?? t?.custom?.name ?? t?.name) });
    }
  }
  for (const f of legacy) {
    if (f && typeof f === 'object') addTool(spec, f.name, f.description, f.parameters, 'function');
    else spec.unsupported.push({ type: typeName(f) });
  }
  spec.choice = openaiChoice(body.tool_choice !== undefined ? body.tool_choice : body.function_call, spec);
  if (!listed.length) {
    spec.legacy = true;
    spec.parallel = false;
  } else {
    spec.parallel = body.parallel_tool_calls !== false;
  }
  return spec;
}

/** Anthropic Messages: `tools` (custom tools; server tools are unsupported), `tool_choice`, `disable_parallel_tool_use`. Null when no tool is offered. */
export function anthropicToolSpec(body) {
  const listed = Array.isArray(body?.tools) ? body.tools : [];
  if (!listed.length) return null;
  const spec = emptySpec();
  for (const t of listed) {
    // A custom tool has no `type` or `type: "custom"`; every typed one (`web_search_20250305`,
    // `bash_20250124`, `text_editor_…`, `computer_…`, `code_execution_…`) is run by Anthropic's
    // servers, which no CLI leg is.
    if (t && typeof t === 'object' && (t.type == null || t.type === 'custom')) {
      addTool(spec, t.name, t.description, t.input_schema, 'custom');
    } else {
      spec.unsupported.push({ type: typeName(t), ...nameOf(t?.name) });
    }
  }
  const tc = body.tool_choice;
  if (tc == null) spec.choice = { mode: 'auto' };
  else if (tc && typeof tc === 'object' && tc.type === 'auto') spec.choice = { mode: 'auto' };
  else if (tc && typeof tc === 'object' && tc.type === 'any') spec.choice = { mode: 'required' };
  else if (tc && typeof tc === 'object' && tc.type === 'none') spec.choice = { mode: 'none' };
  else if (tc && typeof tc === 'object' && tc.type === 'tool' && typeof tc.name === 'string' && tc.name) spec.choice = named(tc.name, spec);
  else {
    spec.choice = { mode: 'auto' };
    spec.unsupported.push({ type: 'tool_choice', reason: `tool_choice ${describeChoice(tc)} is not one keysmith knows` });
  }
  // The Messages API carries it inside tool_choice; a top-level one is read the same way.
  spec.parallel = !(tc?.disable_parallel_tool_use === true || body.disable_parallel_tool_use === true);
  return spec;
}

function emptySpec() {
  return { tools: [], choice: { mode: 'auto' }, parallel: true, unsupported: [] };
}

function addTool(spec, name, description, parameters, type) {
  if (typeof name !== 'string' || !name) {
    spec.unsupported.push({ type, reason: 'a tool without a name' });
    return;
  }
  if (spec.tools.some((t) => t.name === name)) {
    spec.unsupported.push({ type, name, reason: 'offered twice' });
    return;
  }
  spec.tools.push({
    name,
    description: typeof description === 'string' ? description : '',
    parameters: isPlainObject(parameters) || typeof parameters === 'boolean' ? parameters : { type: 'object', properties: {} },
  });
}

function openaiChoice(tc, spec) {
  if (tc === undefined || tc === null || tc === 'auto') return { mode: 'auto' };
  if (tc === 'none') return { mode: 'none' };
  if (tc === 'required') return { mode: 'required' };
  if (tc && typeof tc === 'object') {
    // Chat: `{type: "function", function: {name}}`. Responses: `{type: "function", name}`.
    // The older `function_call`: `{name}`.
    const name = tc.type === 'function' ? (tc.function?.name ?? tc.name) : tc.type == null ? tc.name : undefined;
    if (typeof name === 'string' && name) return named(name, spec);
  }
  spec.unsupported.push({ type: 'tool_choice', reason: `tool_choice ${describeChoice(tc)} is not one keysmith knows` });
  return { mode: 'auto' };
}

function named(name, spec) {
  // Naming a tool the request does not offer is the client's mistake; the provider would refuse
  // it, and so does every CLI leg.
  if (!spec.tools.some((t) => t.name === name) && !spec.unsupported.some((u) => u.name === name)) {
    spec.unsupported.push({ type: 'tool_choice', name, reason: 'names a tool the request does not offer' });
  }
  return { mode: 'named', name };
}

function describeChoice(tc) {
  if (typeof tc === 'string') return JSON.stringify(tc.slice(0, 40));
  if (tc && typeof tc === 'object') return `of type ${JSON.stringify(String(tc.type ?? '?').slice(0, 40))}`;
  return typeof tc;
}

function typeName(t) {
  if (t && typeof t === 'object') return typeof t.type === 'string' && t.type ? t.type.slice(0, 64) : 'untyped';
  return t === null ? 'null' : typeof t;
}

function nameOf(name) {
  return typeof name === 'string' && name ? { name: name.slice(0, 128) } : {};
}

/* --------------------------------------------------------------------- messages */

/**
 * OpenAI chat messages, tool-aware: an assistant's `tool_calls` (and the older `function_call`)
 * become `toolCalls`, a `tool` message (and the older `function` one) a tool result. Text is read
 * exactly as protocols.openaiMessages reads it; a `function` message's role is not (see the
 * header: it is a tool result, never a user turn).
 */
export function openaiToolMessages(body) {
  const list = Array.isArray(body?.messages) ? body.messages.filter((m) => m && typeof m === 'object') : [];
  return list.map((m) => {
    const legacyResult = m.role === 'function';
    const role = m.role === 'developer' ? 'system' : legacyResult ? 'tool' : m.role || 'user';
    const out = { role, text: typeof m.content === 'string' ? m.content : contentToText(m.content) };
    if (role === 'assistant') {
      const calls = [];
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc.custom && typeof tc.custom === 'object' ? { name: tc.custom.name, arguments: tc.custom.input } : {};
        calls.push(callFrom(tc.id, fn.name, fn.arguments));
      }
      if (m.function_call && typeof m.function_call === 'object') calls.push(callFrom(null, m.function_call.name, m.function_call.arguments));
      if (calls.length) out.toolCalls = calls;
    }
    if (role === 'tool') {
      out.toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
      if (typeof m.name === 'string' && m.name) out.name = m.name;
    }
    return out;
  });
}

/**
 * Anthropic messages, tool-aware: `tool_use` blocks become the assistant turn's `toolCalls`, and
 * each `tool_result` block a tool message of its own (`tool_use_id`, its content as text,
 * `is_error`), in the order the blocks came. Everything else is read exactly as
 * protocols.anthropicMessages reads it, and an empty turn is dropped the same way.
 */
export function anthropicToolMessages(body) {
  const out = [];
  if (body?.system) {
    const text = typeof body.system === 'string' ? body.system : contentToText(body.system);
    if (text) out.push({ role: 'system', text });
  }
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object' || m.role === 'tool' || m.type === 'tool_result') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!Array.isArray(m.content)) {
      const text = contentToText(m.content);
      if (text) out.push({ role, text });
      continue;
    }
    if (role === 'assistant') {
      const calls = [];
      const parts = [];
      for (const b of m.content) {
        if (b && typeof b === 'object' && b.type === 'tool_use') calls.push(callFrom(b.id, b.name, b.input));
        else parts.push(b);
      }
      const text = contentToText(parts);
      if (text || calls.length) out.push({ role, text, ...(calls.length ? { toolCalls: calls } : {}) });
      continue;
    }
    let parts = [];
    const flush = () => {
      const text = contentToText(parts);
      if (text) out.push({ role: 'user', text });
      parts = [];
    };
    for (const b of m.content) {
      if (b && typeof b === 'object' && b.type === 'tool_result') {
        flush();
        out.push({
          role: 'tool',
          text: contentToText(b.content),
          toolCallId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
          ...(b.is_error === true ? { isError: true } : {}),
        });
      } else {
        parts.push(b);
      }
    }
    flush();
  }
  return out;
}

/**
 * Canonical messages as the `{role, content}` list adapters take today: tool calls left out, tool
 * results kept as `tool` turns. For a request with no tool exchange in it this is, byte for
 * byte, what protocols.js has always built; with one, it differs as the header says (a tool
 * result is a `tool` turn; an assistant turn that held only calls stays, with empty content).
 */
export function plainMessages(messages) {
  return (messages || []).map((m) => ({ role: m.role, content: m.text }));
}

function callFrom(id, name, args) {
  let text;
  let parsed = null;
  if (typeof args === 'string') {
    text = args;
    try {
      const v = JSON.parse(args);
      if (isPlainObject(v)) parsed = v;
    } catch {}
  } else if (isPlainObject(args)) {
    text = JSON.stringify(args);
    parsed = args;
  } else {
    text = args === undefined ? '' : JSON.stringify(args) ?? '';
  }
  return { id: typeof id === 'string' && id ? id : null, name: typeof name === 'string' ? name : '', arguments: text, args: parsed };
}

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
